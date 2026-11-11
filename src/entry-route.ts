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
import type { SaveContext } from './context.ts';
import { fail, json, nameSegments } from './create-route.ts';
import { failureStatus } from './download-route.ts';
import { assertWritable } from './fence.ts';
import { policyFor } from './session-policy.ts';

export const RENAME_FILE_PATH = '/api/rename.file';
export const DELETE_FILE_PATH = '/api/delete.file';

interface EntryInput {
  sessionId: string;
  path: string;
  body: Record<string, unknown>;
}

async function parseEntry(request: Request): Promise<EntryInput | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400);
  const record = body as Record<string, unknown>;
  const { sessionId, path } = record;
  if (typeof sessionId !== 'string' || sessionId.length === 0)
    return fail(400, 'sessionId required');
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
    return fail(400, 'absolute path required');
  return { sessionId, path, body: record };
}

/** Status for a Node fs error, or the shared Harness mapping. */
function errorStatus(error: unknown): number {
  const code = (error as { code?: string }).code;
  if (code === 'EEXIST') return 409;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 404;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 403;
  return failureStatus(error);
}

/**
 * The regular file at a request's `path`, checked writable for the session.
 * @returns its Host path, or a Response to answer with.
 */
async function writableFile(
  ctx: SaveContext,
  input: EntryInput,
  signal: AbortSignal,
): Promise<
  { hostPath: string; policy: NonNullable<Awaited<ReturnType<typeof policyFor>>> } | Response
> {
  const policy = await policyFor(ctx, input.sessionId, signal);
  if (policy === undefined) return fail(404, 'session not found');
  if (ctx.fs.processPathFromHostPath(input.path) === undefined)
    return fail(422, 'path has no verified Host path');
  const info = await lstat(input.path);
  if (!info.isFile()) return fail(403, 'not a regular file');
  await assertWritable(policy, input.path, { root: false });
  return { hostPath: input.path, policy };
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

/** Give `from` the new name `to` without ever replacing an existing `to`. */
async function moveNoReplace(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Different filesystem, or one without hard links: exclusive copy instead.
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP') throw error;
    await copyFile(from, to, constants.COPYFILE_EXCL);
  }
  await unlink(from);
}

/**
 * Handle POST /api/rename.file `{ sessionId, path, destination }`: rename or
 * move one regular file. Missing destination folders are created. Answers
 * `200 { absolutePath }` with the new path; 409 when the destination exists.
 */
export async function handleRenameFile(ctx: SaveContext, request: Request): Promise<Response> {
  if (request.method !== 'POST') return fail(405, 'POST only');
  try {
    const input = await parseEntry(request);
    if (input instanceof Response) return input;
    const destination = destinationOf(input.path, input.body.destination);
    if (destination === undefined) return fail(400, 'invalid destination');
    const { signal } = request;
    const source = await writableFile(ctx, input, signal);
    if (source instanceof Response) return source;
    if (destination === source.hostPath) return json(200, { absolutePath: destination });
    if (ctx.fs.processPathFromHostPath(destination) === undefined)
      return fail(422, 'path has no verified Host path');
    await assertWritable(source.policy, destination, { root: false });
    signal.throwIfAborted();
    await mkdir(dirname(destination), { recursive: true });
    await moveNoReplace(source.hostPath, destination);
    return json(200, { absolutePath: destination });
  } catch (error) {
    if (request.signal.aborted) return fail(499, 'cancelled');
    return fail(errorStatus(error));
  }
}

/**
 * Handle POST /api/delete.file `{ sessionId, path }`: delete one regular
 * file. Answers `200 { absolutePath }`. Folders are not deleted here.
 */
export async function handleDeleteFile(ctx: SaveContext, request: Request): Promise<Response> {
  if (request.method !== 'POST') return fail(405, 'POST only');
  try {
    const input = await parseEntry(request);
    if (input instanceof Response) return input;
    const { signal } = request;
    const target = await writableFile(ctx, input, signal);
    if (target instanceof Response) return target;
    signal.throwIfAborted();
    await unlink(target.hostPath);
    return json(200, { absolutePath: target.hostPath });
  } catch (error) {
    if (request.signal.aborted) return fail(499, 'cancelled');
    return fail(errorStatus(error));
  }
}
