import { isAbsolute } from 'node:path';
import { failureStatus } from './download-route.js';

export const SAVE_PATH = '/api/save.file';
/** Largest file the editor opens or saves; also bounds the request body. */
export const MAX_SAVE_BYTES = 1024 * 1024;

const FAIL_MESSAGE = {
  400: 'invalid request',
  403: 'write not permitted',
  404: 'file not found',
  409: 'file changed on disk',
  413: 'file too large',
  415: 'not a text file',
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function fail(status, message) {
  return json(status, { error: message ?? FAIL_MESSAGE[status] ?? 'save failed' });
}

/** Parse and validate the JSON body; returns the fields or a Response to answer with. */
async function parse(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400);
  const { sessionId, path, content, expectedVersion, force } = body;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return fail(400, 'sessionId required');
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) return fail(400, 'path required');
  if (typeof content !== 'string') return fail(400, 'content must be a string');
  if (Buffer.byteLength(content, 'utf8') > MAX_SAVE_BYTES) return fail(413);
  if (expectedVersion !== undefined && typeof expectedVersion !== 'string') return fail(400);
  if (force !== undefined && typeof force !== 'boolean') return fail(400);
  if (force !== true && (expectedVersion === undefined || expectedVersion.length === 0)) {
    return fail(400, 'expectedVersion required unless force');
  }
  return { sessionId, path, content, expectedVersion, force: force === true };
}

/**
 * Sandbox policy for the Session the save belongs to: the Session's own
 * workspace boundary and mode when it is live, else its persisted workspace
 * root under the deployment default mode. Never widened beyond that.
 */
async function policyFor(ctx, sessionId, signal) {
  const live = ctx.sessions?.get(sessionId);
  if (live !== undefined) return ctx.sandboxPolicy.resolve({ session: live });
  const stored = await ctx.get('sessionPersistence')?.stat(sessionId);
  signal.throwIfAborted();
  if (stored === undefined) return undefined;
  return {
    mode: ctx.sandboxPolicy.defaultMode,
    workspaceRoot: stored.header?.cwd ?? ctx.sandboxPolicy.workspaceRoot,
    sessionId,
  };
}

/**
 * Handle POST /api/save.file: replace a UTF-8 text file the Session can reach,
 * only if it is unchanged since the version the editor read (or `force`).
 * The write runs through `ctx.fs.writeText` with the Session's sandbox policy,
 * so read-only mode and workspace boundaries are enforced by the Harness.
 */
export async function handleSave(ctx, request) {
  if (request.method !== 'POST') return fail(405, 'POST only');
  try {
    const input = await parse(request);
    if (input instanceof Response) return input;
    const { signal } = request;
    const policy = await policyFor(ctx, input.sessionId, signal);
    if (policy === undefined) return fail(404, 'session not found');

    const scope = { sessionId: input.sessionId, workspaceRoot: policy.workspaceRoot };
    const { absolutePath } = await ctx.workspaceFiles.stat(scope, input.path, signal);
    if (!isAbsolute(absolutePath)) return fail(400, 'absolute path required');
    const { fs } = ctx;
    const processPath = fs.processPathFromHostPath(absolutePath);
    if (processPath === undefined) return fail(422, 'path has no verified Host path');
    const target = await fs.resolve(processPath, { signal });
    const info = await fs.stat(target, signal);
    if (info === undefined) return fail(404);
    if (info.type !== 'file') return fail(403, 'not a regular file');

    const intent = input.force ? undefined
      : { kind: 'replaceIfVersion', version: input.expectedVersion };
    const outcome = await fs.writeText(target, input.content, intent, signal, policy);
    return json(200, { version: outcome.version, operation: outcome.operation });
  } catch (error) {
    if (request.signal.aborted) return fail(499, 'cancelled');
    return fail(failureStatus(error));
  }
}

/** Register the route on the authenticated connection; returns its disposer. */
export function registerSaveRoute(ctx) {
  const lifetime = new AbortController();
  const pending = new Set();
  const unregister = ctx.connection.fetch.register({
    path: SAVE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => {
      const task = handleSave(
        ctx, new Request(request, { signal: AbortSignal.any([request.signal, lifetime.signal]) }));
      pending.add(task);
      const done = () => { pending.delete(task); };
      task.then(done, done);
      return task;
    },
  });
  return async () => {
    lifetime.abort();
    if (typeof unregister === 'function') unregister();
    await Promise.allSettled(pending);
  };
}
