import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, link, lstat, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { SaveContext } from './context.ts';
import { codedError, errorCode } from './errors.ts';
import { assertWritable, FenceError, landedInside } from './fence.ts';
import { failWith, handlePost, json, mutationStatus } from './http.ts';
import { policyFor } from './session-policy.ts';
import { parseTarget } from './target.ts';

export const UPLOAD_FILE_PATH = '/api/upload.file';

/** The temporary files an upload writes before it has its name: `.dlf-upload-<uuid>.part`. */
export const UPLOAD_PART_PREFIX = '.dlf-upload-';
const UPLOAD_PART_NAME =
  /^\.dlf-upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;

/** Whether `name` is one of the plugin's upload temporary files (src/sweep.ts removes stale ones). */
export function isUploadPartName(name: string): boolean {
  return UPLOAD_PART_NAME.test(name);
}

/** Largest file one upload accepts; the browser checks it too, before sending (test/limits.test.ts keeps them in step). */
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

const fail = failWith(
  {
    400: 'invalid request',
    403: 'not permitted',
    404: 'not found',
    409: 'already exists',
    411: 'length required',
    413: 'too large',
    415: 'content type must be application/octet-stream',
  },
  'failed',
);

/** Status for an upload error: the size guard first, then the mutation mapping. */
function uploadStatus(error: unknown): number {
  return errorCode(error) === 'EFBIG' ? 413 : mutationStatus(error);
}

/** Passes bytes through, failing with `EFBIG` past `limit` (a lying Content-Length). */
export function limitBytes(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) callback(codedError('upload exceeds the size limit', 'EFBIG'));
      else callback(null, chunk);
    },
  });
}

/** Copy `from` to a name that must not exist yet, leaving nothing behind when the copy fails. */
export async function copyNoReplace(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to, constants.COPYFILE_EXCL);
  } catch (error) {
    // A copy that fails midway can leave a truncated file under the final name.
    // A name that was already taken (EEXIST) is not ours to remove.
    if (errorCode(error) !== 'EEXIST') await unlink(to).catch(() => undefined);
    throw error;
  }
}

/**
 * Give the finished temporary file its name without ever replacing anything:
 * a hard link (atomic, and it fails when the name is taken), or — on a
 * filesystem without hard links — an exclusive copy.
 */
export async function placeNoReplace(temp: string, hostPath: string): Promise<void> {
  try {
    await link(temp, hostPath);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') throw error;
    await copyNoReplace(temp, hostPath);
  }
}

/**
 * Handle POST /api/upload.file?sessionId=…&directory=…&name=…: store the raw
 * request body (`application/octet-stream`) as a NEW file in a directory the
 * session may write to. Streamed to disk, never buffered whole.
 *
 * Never overwrites: the bytes go to a hidden temporary file in the target
 * directory, which is given the final name only if that name is free (a hard
 * link where the filesystem has them, else an exclusive copy) and then
 * removed. An error or a cancelled request leaves nothing behind, with three
 * exceptions: a crash (the process dies) can leave the temporary file, or a
 * truncated file under the final name on the copy fallback; and when the
 * folder is swapped for a symlink mid-upload, the hidden temporary file stays
 * in the folder it was made in, since removing it by path would follow the
 * link. `name` is a single file name, not a path. Like folder creation, this
 * acts on the Host path, guarded by the plugin's write fence (src/fence.ts)
 * before and after.
 */
export function handleUpload(ctx: SaveContext, request: Request): Promise<Response> {
  return handlePost(request, fail, uploadStatus, async () => {
    const { searchParams } = new URL(request.url);
    const input = parseTarget(
      {
        sessionId: searchParams.get('sessionId') ?? undefined,
        directory: searchParams.get('directory') ?? undefined,
        name: searchParams.get('name') ?? undefined,
      },
      fail,
      { singleName: true },
    );
    if (input instanceof Response) return input;
    if (
      request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/octet-stream'
    )
      return fail(415);
    const declared = request.headers.get('content-length');
    if (declared === null) return fail(411);
    if (!(Number(declared) <= MAX_UPLOAD_BYTES)) return fail(413);
    if (request.body === null) return fail(400, 'body required');

    const { signal } = request;
    const policy = await policyFor(ctx, input.sessionId, signal);
    if (policy === undefined) return fail(404, 'session not found');

    const hostPath = join(input.directory, input.segments[0] as string);
    if (ctx.fs.processPathFromHostPath(hostPath) === undefined)
      return fail(422, 'path has no verified Host path');
    await assertWritable(policy, hostPath);
    if (!(await stat(input.directory)).isDirectory()) return fail(404, 'folder not found');
    try {
      await lstat(hostPath);
      return fail(409);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }

    const temp = join(input.directory, `${UPLOAD_PART_PREFIX}${randomUUID()}.part`);
    try {
      await pipeline(
        // The web stream's type differs between lib.dom and node:stream/web only nominally.
        Readable.fromWeb(request.body as WebReadableStream),
        limitBytes(MAX_UPLOAD_BYTES),
        createWriteStream(temp, { flags: 'wx', mode: 0o666 }),
        { signal },
      );
      // The directory may have been swapped for a symlink while the bytes arrived.
      if (!(await landedInside(policy, temp)))
        throw new FenceError(`"${temp}" landed outside the writable roots`);
      // A request the browser already gave up on must not leave a file behind.
      signal.throwIfAborted();
      await placeNoReplace(temp, hostPath);
      try {
        if (!(await landedInside(policy, hostPath)))
          throw new FenceError(`"${hostPath}" landed outside the writable roots`);
        // The abort can arrive between the last byte and this moment: undo the name too.
        signal.throwIfAborted();
      } catch (error) {
        await unlink(hostPath).catch(() => undefined);
        throw error;
      }
      return json(201, { absolutePath: hostPath, bytes: (await lstat(hostPath)).size });
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  });
}
