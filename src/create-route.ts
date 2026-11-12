import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { SaveContext } from './context.ts';
import { assertWritable, FenceError, landedInside } from './fence.ts';
import { failureStatus, failWith, handlePost, json, jsonObject, mutationStatus } from './http.ts';
import { nameSegments, undoMkdir } from './paths.ts';
import { policyFor } from './session-policy.ts';

export const CREATE_FILE_PATH = '/api/create.file';
export const CREATE_FOLDER_PATH = '/api/create.folder';

const fail = failWith(
  { 400: 'invalid request', 403: 'not permitted', 404: 'not found', 409: 'already exists' },
  'failed',
);

/** The request body every create shares; returns the fields or a Response. */
async function parseCreate(
  request: Request,
): Promise<{ sessionId: string; directory: string; segments: string[] } | Response> {
  const body = await jsonObject(request, fail);
  if (body instanceof Response) return body;
  const { sessionId, directory, name } = body;
  if (typeof sessionId !== 'string' || sessionId.length === 0)
    return fail(400, 'sessionId required');
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0'))
    return fail(400, 'absolute directory required');
  const segments = nameSegments(name);
  if (segments === undefined) return fail(400, 'invalid name');
  return { sessionId, directory, segments };
}

/**
 * Handle POST /api/create.file: create an EMPTY text file in a directory the
 * session may write to. Never overwrites: an existing entry of any kind is a
 * 409. The write goes through `ctx.fs.writeText` with a `createIfAbsent`
 * guard and the session's sandbox policy, after the plugin's own fence
 * (src/fence.ts), so it is refused in read-only mode and outside the
 * workspace even on a backend that does not enforce the policy.
 */
export function handleCreateFile(ctx: SaveContext, request: Request): Promise<Response> {
  return handlePost(request, fail, failureStatus, async () => {
    const input = await parseCreate(request);
    if (input instanceof Response) return input;
    const { signal } = request;
    const policy = await policyFor(ctx, input.sessionId, signal);
    if (policy === undefined) return fail(404, 'session not found');

    const hostPath = join(input.directory, ...input.segments);
    const { fs } = ctx;
    const processPath = fs.processPathFromHostPath(hostPath);
    if (processPath === undefined) return fail(422, 'path has no verified Host path');
    await assertWritable(policy, hostPath);
    const target = await fs.resolve(processPath, { signal });
    if ((await fs.stat(target, signal)) !== undefined) return fail(409);

    const outcome = await fs.writeText(target, '', { kind: 'createIfAbsent' }, signal, policy);
    return json(201, {
      absolutePath: target.displayPath ?? processPath,
      version: outcome.version,
    });
  });
}

/**
 * Handle POST /api/create.folder: create a directory (and missing parents) in
 * a directory the session may write to. `ctx.fs` has no mkdir, so this is a
 * plain `mkdir` on the Host path, guarded by the plugin's write fence
 * (src/fence.ts) before the call and checked again after it. An existing
 * entry of any kind at the final name is a 409, and leaves no new parents.
 * Only possible when the Harness filesystem is the Host's own (a verified
 * Host mapping), which is also what downloads require.
 */
export function handleCreateFolder(ctx: SaveContext, request: Request): Promise<Response> {
  return handlePost(request, fail, mutationStatus, async () => {
    const input = await parseCreate(request);
    if (input instanceof Response) return input;
    const { signal } = request;
    const policy = await policyFor(ctx, input.sessionId, signal);
    if (policy === undefined) return fail(404, 'session not found');

    const hostPath = join(input.directory, ...input.segments);
    const processPath = ctx.fs.processPathFromHostPath(hostPath);
    if (processPath === undefined) return fail(422, 'path has no verified Host path');
    // The fence checks the canonical path (symlinked ancestors resolved). An
    // ancestor swapped for a symlink right after the check would redirect
    // mkdir, so where the folder landed is checked again and undone if outside.
    await assertWritable(policy, hostPath);
    signal.throwIfAborted();
    const parent = dirname(hostPath);
    const first = await mkdir(parent, { recursive: true });
    try {
      // Non-recursive for the final name: EEXIST for anything already there.
      await mkdir(hostPath);
    } catch (error) {
      await undoMkdir(parent, first);
      throw error;
    }
    if (!(await landedInside(policy, hostPath))) {
      await undoMkdir(hostPath, first ?? hostPath);
      throw new FenceError(`"${hostPath}" landed outside the writable roots`);
    }
    return json(201, { absolutePath: hostPath });
  });
}
