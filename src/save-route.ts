import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { SaveContext, SaveRegisterContext, WriteIntent } from './context.ts';
import { failureStatus } from './download-route.ts';
import { assertWritable } from './fence.ts';
import { policyFor } from './session-policy.ts';

export const SAVE_PATH = '/api/save.file';
/** Largest file the editor opens or saves; also bounds the request body. */
export const MAX_SAVE_BYTES = 1024 * 1024;

const FAIL_MESSAGE: Record<number, string> = {
  400: 'invalid request',
  403: 'write not permitted',
  404: 'file not found',
  409: 'file changed on disk',
  413: 'file too large',
  415: 'not a text file',
};

interface SaveInput {
  sessionId: string;
  path: string;
  content: string;
  expectedVersion: string | undefined;
  force: boolean;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function fail(status: number, message?: string): Response {
  return json(status, { error: message ?? FAIL_MESSAGE[status] ?? 'save failed' });
}

/** Parse and validate the JSON body; returns the fields or a Response to answer with. */
async function parse(request: Request): Promise<SaveInput | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400);
  const { sessionId, path, content, expectedVersion, force } = body as Record<string, unknown>;
  if (typeof sessionId !== 'string' || sessionId.length === 0)
    return fail(400, 'sessionId required');
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0'))
    return fail(400, 'path required');
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
 * Handle POST /api/save.file: replace a UTF-8 text file the Session can reach,
 * only if it is unchanged since the version the editor read (or `force`).
 * The write runs through `ctx.fs.writeText` with the Session's sandbox policy,
 * after the plugin's own fence (src/fence.ts) with the agent's grant (temp
 * areas included), so read-only mode and workspace boundaries hold even on a
 * backend that does not enforce the policy. A save replaces the file a
 * symlink points to, so the fence judges that file, not the link.
 */
export async function handleSave(ctx: SaveContext, request: Request): Promise<Response> {
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
    await assertWritable(policy, await realpath(absolutePath), { temp: true });

    // parse() guarantees a non-empty expectedVersion whenever force is false.
    const intent: WriteIntent | undefined =
      input.force || input.expectedVersion === undefined
        ? undefined
        : { kind: 'replaceIfVersion', version: input.expectedVersion };
    const outcome = await fs.writeText(target, input.content, intent, signal, policy);
    return json(200, { version: outcome.version, operation: outcome.operation });
  } catch (error) {
    if (request.signal.aborted) return fail(499, 'cancelled');
    return fail(failureStatus(error));
  }
}

/** Register the route on the authenticated connection; returns its disposer. */
export function registerSaveRoute(ctx: SaveRegisterContext): () => Promise<void> {
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const unregister = ctx.connection.fetch.register({
    path: SAVE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => {
      const task = handleSave(
        ctx,
        new Request(request, { signal: AbortSignal.any([request.signal, lifetime.signal]) }),
      );
      pending.add(task);
      const done = () => {
        pending.delete(task);
      };
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
