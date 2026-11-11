import { isAbsolute, join } from 'node:path';
import type { SaveContext, SaveRegisterContext } from './context.ts';
import { failureStatus } from './download-route.ts';
import { assertWritable } from './fence.ts';
import { policyFor } from './session-policy.ts';

export const CREATE_FILE_PATH = '/api/create.file';
/** Longest name (with any sub-directories) a create accepts. */
export const MAX_NAME_LENGTH = 1024;

const FAIL_MESSAGE: Record<number, string> = {
  400: 'invalid request',
  403: 'not permitted',
  404: 'not found',
  409: 'already exists',
};

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function fail(status: number, message?: string): Response {
  return json(status, { error: message ?? FAIL_MESSAGE[status] ?? 'failed' });
}

/**
 * Validate a user-typed name, relative to a directory. `a/b.txt` is allowed
 * (missing directories are created); absolute paths, `.`/`..` segments, empty
 * segments, backslashes and control characters are not.
 * @returns the `/`-separated segments, or undefined when invalid.
 */
export function nameSegments(name: unknown): string[] | undefined {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH)
    return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return undefined;
  const segments = name.split('/');
  if (segments.some((s) => s.length === 0 || s === '.' || s === '..' || s.trim() !== s))
    return undefined;
  return segments;
}

/** The request body every create shares; returns the fields or a Response. */
export async function parseCreate(
  request: Request,
): Promise<{ sessionId: string; directory: string; segments: string[] } | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400);
  const { sessionId, directory, name } = body as Record<string, unknown>;
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
export async function handleCreateFile(ctx: SaveContext, request: Request): Promise<Response> {
  if (request.method !== 'POST') return fail(405, 'POST only');
  try {
    const input = await parseCreate(request);
    if (input instanceof Response) return input;
    const { signal } = request;
    const policy = await policyFor(ctx, input.sessionId, signal);
    if (policy === undefined) return fail(404, 'session not found');

    const hostPath = join(input.directory, ...input.segments);
    const { fs } = ctx;
    const processPath = fs.processPathFromHostPath(hostPath);
    if (processPath === undefined) return fail(422, 'path has no verified Host path');
    await assertWritable(policy, hostPath, { root: false });
    const target = await fs.resolve(processPath, { signal });
    if ((await fs.stat(target, signal)) !== undefined) return fail(409);

    const outcome = await fs.writeText(target, '', { kind: 'createIfAbsent' }, signal, policy);
    return json(201, {
      absolutePath: target.displayPath ?? processPath,
      version: outcome.version,
    });
  } catch (error) {
    if (request.signal.aborted) return fail(499, 'cancelled');
    return fail(failureStatus(error));
  }
}

/**
 * Register a POST route on the authenticated connection with the plugin's
 * lifetime handling (in-flight requests are aborted and awaited on dispose).
 */
export function registerPostRoute<C>(
  ctx: C & Pick<SaveRegisterContext, 'connection'>,
  path: string,
  handle: (ctx: C, request: Request) => Promise<Response>,
): () => Promise<void> {
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const unregister = ctx.connection.fetch.register({
    path,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => {
      const task = handle(
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
