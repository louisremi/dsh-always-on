/**
 * Rename/move and delete for single regular files.
 *
 * `ctx.fs` has no rename or unlink, so these operate on the verified Host
 * path (the same requirement as downloads), each guarded by the plugin's
 * write fence (src/fence.ts) against the session's sandbox policy:
 *
 *  - only regular files: never directories, never symlinks (a symlink is
 *    refused rather than followed or removed);
 *  - both the source and the destination must be writable for the session;
 *  - a move NEVER replaces anything at the destination: it hard-links the
 *    file to its new name (which fails if the name is taken) and then removes
 *    the old name, so there is no window where an existing file could be
 *    overwritten. Across filesystems it copies exclusively, then removes.
 */
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { SandboxPolicy, SaveContext } from './context.ts';
import { assertWritable, FenceError, landedInside } from './fence.ts';
import { failWith, handlePost, json, jsonObject, mutationStatus } from './http.ts';
import { nameSegments, undoMkdir } from './paths.ts';
import { policyFor } from './session-policy.ts';

export const RENAME_FILE_PATH = '/api/rename.file';
export const DELETE_FILE_PATH = '/api/delete.file';

const fail = failWith(
  { 400: 'invalid request', 403: 'not permitted', 404: 'not found', 409: 'already exists' },
  'failed',
);

interface EntryInput {
  sessionId: string;
  path: string;
  /** rename only: where the file goes, still unvalidated (see destinationOf). */
  destination: unknown;
}

async function parseEntry(request: Request): Promise<EntryInput | Response> {
  const body = await jsonObject(request, fail);
  if (body instanceof Response) return body;
  const { sessionId, path, destination } = body;
  if (typeof sessionId !== 'string' || sessionId.length === 0)
    return fail(400, 'sessionId required');
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
    return fail(400, 'absolute path required');
  return { sessionId, path, destination };
}

/** The file a rename or delete acts on, as checked: path, policy and identity. */
interface WritableFile {
  hostPath: string;
  policy: SandboxPolicy;
  dev: number;
  ino: number;
}

/**
 * The regular file at a request's `path`, checked writable for the session.
 * The fence runs first, so a path the session may not touch is a 403 whether
 * or not it exists.
 * @returns the checked file, or a Response to answer with.
 */
async function writableFile(
  ctx: SaveContext,
  input: EntryInput,
  signal: AbortSignal,
): Promise<WritableFile | Response> {
  const policy = await policyFor(ctx, input.sessionId, signal);
  if (policy === undefined) return fail(404, 'session not found');
  if (ctx.fs.processPathFromHostPath(input.path) === undefined)
    return fail(422, 'path has no verified Host path');
  await assertWritable(policy, input.path);
  const info = await lstat(input.path);
  if (!info.isFile()) return fail(403, 'not a regular file');
  return { hostPath: input.path, policy, dev: info.dev, ino: info.ino };
}

/**
 * Throw unless `file.hostPath` still names the very file that was checked,
 * inside the fence: an ancestor swapped for a symlink since then would make
 * the same path reach another file.
 */
async function assertUnchanged(file: WritableFile): Promise<void> {
  const now = await lstat(file.hostPath);
  if (
    now.dev !== file.dev ||
    now.ino !== file.ino ||
    !(await landedInside(file.policy, file.hostPath))
  )
    throw new FenceError(`"${file.hostPath}" is no longer the file that was checked`);
}

/**
 * Where a rename goes: an absolute path, or one relative to the source's
 * directory written with `/` (no `.`/`..` segments, see nameSegments).
 */
function destinationOf(source: string, destination: unknown): string | undefined {
  if (typeof destination !== 'string' || destination.includes('\0')) return undefined;
  if (isAbsolute(destination)) {
    const segments = nameSegments(destination.replace(/^\/+/, ''));
    return segments === undefined ? undefined : join('/', ...segments);
  }
  const segments = nameSegments(destination);
  return segments === undefined ? undefined : join(dirname(source), ...segments);
}

/**
 * Give `from` the new name `to` without ever replacing an existing `to`. All
 * or nothing: when the new name lands outside the fence, the source is no
 * longer the checked file, or the old name cannot be removed, the new name is
 * removed again and the error is thrown.
 */
async function moveNoReplace(from: WritableFile, to: string): Promise<void> {
  try {
    await link(from.hostPath, to);
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Different filesystem, or one without hard links: exclusive copy instead.
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP') throw error;
    await copyFile(from.hostPath, to, constants.COPYFILE_EXCL);
  }
  try {
    if (!(await landedInside(from.policy, to)))
      throw new FenceError(`"${to}" landed outside the writable roots`);
    await assertUnchanged(from);
    await unlink(from.hostPath);
  } catch (error) {
    await unlink(to).catch(() => undefined);
    throw error;
  }
}

/**
 * Handle POST /api/rename.file `{ sessionId, path, destination }`: rename or
 * move one regular file. Missing destination folders are created. Answers
 * `200 { absolutePath }` with the new path; 409 when the destination exists.
 */
export function handleRenameFile(ctx: SaveContext, request: Request): Promise<Response> {
  return handlePost(request, fail, mutationStatus, async () => {
    const input = await parseEntry(request);
    if (input instanceof Response) return input;
    const destination = destinationOf(input.path, input.destination);
    if (destination === undefined) return fail(400, 'invalid destination');
    const { signal } = request;
    const source = await writableFile(ctx, input, signal);
    if (source instanceof Response) return source;
    if (destination === source.hostPath) return json(200, { absolutePath: destination });
    if (ctx.fs.processPathFromHostPath(destination) === undefined)
      return fail(422, 'path has no verified Host path');
    await assertWritable(source.policy, destination);
    signal.throwIfAborted();
    const parent = dirname(destination);
    const first = await mkdir(parent, { recursive: true });
    try {
      await moveNoReplace(source, destination);
    } catch (error) {
      // Nothing left behind: the folders this rename created go again.
      await undoMkdir(parent, first);
      throw error;
    }
    return json(200, { absolutePath: destination });
  });
}

/**
 * Handle POST /api/delete.file `{ sessionId, path }`: delete one regular
 * file. Answers `200 { absolutePath }`. Folders are not deleted here.
 */
export function handleDeleteFile(ctx: SaveContext, request: Request): Promise<Response> {
  return handlePost(request, fail, mutationStatus, async () => {
    const input = await parseEntry(request);
    if (input instanceof Response) return input;
    const { signal } = request;
    const target = await writableFile(ctx, input, signal);
    if (target instanceof Response) return target;
    signal.throwIfAborted();
    // A delete cannot be undone, so the file is re-identified right before it.
    await assertUnchanged(target);
    await unlink(target.hostPath);
    return json(200, { absolutePath: target.hostPath });
  });
}
