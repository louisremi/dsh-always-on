/**
 * Rename/move, delete and restore for files and folders.
 *
 * `ctx.fs` has no rename, unlink or rmdir, so these operate on the verified
 * Host path (the same requirement as downloads), each guarded by the plugin's
 * write fence (src/fence.ts) against the session's sandbox policy:
 *
 *  - only regular files and real folders: never symlinks (a symlink is
 *    refused rather than followed or moved), never the workspace roots;
 *  - both the source and the destination must be writable for the session;
 *  - a move NEVER replaces anything at the destination (src/entry.ts);
 *  - a delete is a move to the root's trash (src/trash.ts), undone by
 *    /api/restore.entry with the token the delete answered.
 */
import { lstat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { SandboxPolicy, SaveContext } from './context.ts';
import { assertUnchanged, type Entry, identityOf, moveNoReplace } from './entry.ts';
import { codedError, errorCode } from './errors.ts';
import { assertWritable, canonicalPath, holdsWritableRoot } from './fence.ts';
import { failWith, handlePost, json, jsonObject, mutationStatus } from './http.ts';
import { type EntryKind, isUnder, nameSegments, undoMkdir } from './paths.ts';
import { policyFor } from './session-policy.ts';
import { forgetRestore, moveToTrash, purgeTrash, restoreItem, trashRelation } from './trash.ts';

export const RENAME_FILE_PATH = '/api/rename.file';
export const DELETE_FILE_PATH = '/api/delete.file';
export const RENAME_FOLDER_PATH = '/api/rename.folder';
export const DELETE_FOLDER_PATH = '/api/delete.folder';
export const RESTORE_PATH = '/api/restore.entry';

const fail = failWith(
  {
    400: 'invalid request',
    403: 'not permitted',
    404: 'not found',
    409: 'already exists',
    422: 'not possible here',
    501: 'unavailable on this Host',
  },
  'failed',
);

/**
 * The codes only moves raise: their status, and the message the client
 * matches on (src/client.ts, entryErrorKey) when the status alone is
 * ambiguous. Every other error goes through {@link mutationStatus}.
 */
const MOVE_ERRORS: Record<string, { status: number; message?: string }> = {
  EXDEV: {
    status: 422,
    message: 'on another filesystem: it cannot be moved there or to the trash',
  },
  EBUSY: { status: 422, message: 'a mount point cannot be moved to the trash' },
  ENOSYS: { status: 501, message: 'moving folders needs GNU coreutils mv on the Host' },
  EINVAL: { status: 400 },
  ENOTEMPTY: { status: 409 },
};

/** Answer like handlePost, with {@link MOVE_ERRORS} for the move-specific codes. */
function handleEntry(request: Request, run: () => Promise<Response>): Promise<Response> {
  return handlePost(request, fail, mutationStatus, async () => {
    try {
      return await run();
    } catch (error) {
      const known = MOVE_ERRORS[errorCode(error) ?? ''];
      if (known === undefined || request.signal.aborted) throw error;
      return fail(known.status, known.message);
    }
  });
}

interface EntryInput {
  sessionId: string;
  path: string;
  /** rename only: where the entry goes, still unvalidated (see destinationOf). */
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

/**
 * The file or folder at a request's `path`, checked writable for the session.
 * The fence runs first, so a path the session may not touch is a 403 whether
 * or not it exists.
 * @returns the checked entry, or a Response to answer with.
 */
async function writableEntry(
  ctx: SaveContext,
  input: EntryInput,
  kind: EntryKind,
  signal: AbortSignal,
): Promise<Entry | Response> {
  const policy = await policyFor(ctx, input.sessionId, signal);
  if (policy === undefined) return fail(404, 'session not found');
  if (ctx.fs.processPathFromHostPath(input.path) === undefined)
    return fail(422, 'path has no verified Host path');
  await assertWritable(policy, input.path);
  const info = await lstat(input.path);
  if (kind === 'file' ? !info.isFile() : !info.isDirectory())
    return fail(403, kind === 'file' ? 'not a regular file' : 'not a folder');
  if (kind === 'folder' && (await holdsWritableRoot(policy, input.path)))
    return fail(403, 'this folder holds a writable root of the session');
  return { kind, hostPath: input.path, policy, identity: identityOf(info) };
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
 * Rename one file or folder (see the two routes). Missing destination folders
 * are created, and removed again when the move fails.
 */
function handleRename(ctx: SaveContext, request: Request, kind: EntryKind) {
  return handleEntry(request, async () => {
    const input = await parseEntry(request);
    if (input instanceof Response) return input;
    const destination = destinationOf(input.path, input.destination);
    if (destination === undefined) return fail(400, 'invalid destination');
    const { signal } = request;
    const source = await writableEntry(ctx, input, kind, signal);
    if (source instanceof Response) return source;
    if (destination === source.hostPath) return json(200, { absolutePath: destination });
    if (ctx.fs.processPathFromHostPath(destination) === undefined)
      return fail(422, 'path has no verified Host path');
    await assertWritable(source.policy, destination);
    if (kind === 'folder') {
      if (isUnder(await canonicalPath(destination), await canonicalPath(source.hostPath)))
        return fail(400, 'a folder cannot be moved into itself');
    }
    signal.throwIfAborted();
    const parent = dirname(destination);
    const firstCreated = await mkdir(parent, { recursive: true });
    try {
      await moveNoReplace(source, destination);
    } catch (error) {
      // Nothing left behind: the folders this rename created go again.
      await undoMkdir(parent, firstCreated);
      throw error;
    }
    return json(200, { absolutePath: destination });
  });
}

/**
 * Handle POST /api/rename.file `{ sessionId, path, destination }`: rename or
 * move one regular file. Answers `200 { absolutePath }` with the new path;
 * 409 when the destination exists.
 */
export function handleRenameFile(ctx: SaveContext, request: Request): Promise<Response> {
  return handleRename(ctx, request, 'file');
}

/**
 * Handle POST /api/rename.folder `{ sessionId, path, destination }`: rename
 * or move one folder with everything in it. 409 when the destination exists
 * (even an empty folder), 400 into itself, 422 across filesystems, 501 when
 * the Host has no GNU coreutils `mv`.
 */
export function handleRenameFolder(ctx: SaveContext, request: Request): Promise<Response> {
  return handleRename(ctx, request, 'folder');
}

/** Called with each trash folder a delete used, so it can be purged and remembered. */
export type TrashObserver = (trashDir: string) => void;

/** Without a purge service (src/purge.ts), a delete still purges the trash it used. */
const purgeOnly: TrashObserver = (trashDir) => {
  purgeTrash(trashDir).catch((error) => {
    console.warn('[dsh-always-on] trash purge failed:', error);
  });
};

/** Delete one file or folder: move it to its root's trash. */
function handleDelete(
  ctx: SaveContext,
  request: Request,
  kind: EntryKind,
  trashUsed: TrashObserver,
) {
  return handleEntry(request, async () => {
    const input = await parseEntry(request);
    if (input instanceof Response) return input;
    const { signal } = request;
    const target = await writableEntry(ctx, input, kind, signal);
    if (target instanceof Response) return target;
    const relation = await trashRelation(target.policy, target.hostPath);
    if (relation !== 'none')
      return fail(
        403,
        relation === 'inside'
          ? 'already in the trash; it is removed automatically'
          : 'this folder holds the trash',
      );
    signal.throwIfAborted();
    const trashed = await moveToTrash(target, input.sessionId);
    trashUsed(trashed.trashDir);
    return json(200, {
      absolutePath: target.hostPath,
      trashedPath: trashed.trashedPath,
      restoreToken: trashed.restoreToken,
    });
  });
}

/**
 * Handle POST /api/delete.file `{ sessionId, path }`: move one regular file
 * to the trash. Answers `200 { absolutePath, trashedPath, restoreToken }`.
 */
export function handleDeleteFile(
  ctx: SaveContext,
  request: Request,
  trashUsed: TrashObserver = purgeOnly,
): Promise<Response> {
  return handleDelete(ctx, request, 'file', trashUsed);
}

/**
 * Handle POST /api/delete.folder `{ sessionId, path }`: move one folder, empty
 * or not, to the trash. Same answer as delete.file; 422 when the folder is on
 * another filesystem than its trash (a mount), where nothing is deleted.
 */
export function handleDeleteFolder(
  ctx: SaveContext,
  request: Request,
  trashUsed: TrashObserver = purgeOnly,
): Promise<Response> {
  return handleDelete(ctx, request, 'folder', trashUsed);
}

/**
 * Handle POST /api/restore.entry `{ sessionId, restoreToken }`: move a deleted
 * entry back where it was. The token names it; paths never come from the
 * client. 404 when the token is unknown, expired or another session's; 409
 * when its old name is taken again (it stays in the trash). Answers
 * `200 { absolutePath, kind }`.
 */
export function handleRestore(ctx: SaveContext, request: Request): Promise<Response> {
  return handleEntry(request, async () => {
    const body = await jsonObject(request, fail);
    if (body instanceof Response) return body;
    const { sessionId, restoreToken } = body;
    if (typeof sessionId !== 'string' || sessionId.length === 0)
      return fail(400, 'sessionId required');
    const item = restoreItem(restoreToken, sessionId);
    if (item === undefined) return fail(404, 'nothing to restore');
    const { signal } = request;
    const policy: SandboxPolicy | undefined = await policyFor(ctx, sessionId, signal);
    if (policy === undefined) return fail(404, 'session not found');
    await assertWritable(policy, item.originalPath);
    const trashed: Entry = {
      kind: item.kind,
      hostPath: item.trashedPath,
      policy,
      identity: item.identity,
    };
    try {
      await assertUnchanged(trashed);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        forgetRestore(item.token);
        return fail(404, 'no longer in the trash');
      }
      throw error;
    }
    signal.throwIfAborted();
    const parent = dirname(item.originalPath);
    const firstCreated = await mkdir(parent, { recursive: true });
    try {
      await moveNoReplace(trashed, item.originalPath);
    } catch (error) {
      await undoMkdir(parent, firstCreated);
      if (errorCode(error) === 'EEXIST')
        throw codedError(`"${item.originalPath}" exists again`, 'EEXIST');
      throw error;
    }
    forgetRestore(item.token);
    // The empty slot the entry was trashed into goes too.
    await undoMkdir(dirname(item.trashedPath), dirname(item.trashedPath));
    return json(200, { absolutePath: item.originalPath, kind: item.kind });
  });
}
