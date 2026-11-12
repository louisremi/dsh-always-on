/**
 * What every Host route shares: JSON answers, body parsing, the POST/cancel
 * envelope, error-to-status mapping, and registration on the authenticated
 * connection with the plugin's lifetime handling.
 */
import type { ConnectionService } from './context.ts';

/** A JSON answer that is never cached nor sniffed. */
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

/** Answers `{ error }` with an explicit message, or the route's default for the status. */
export type Fail = (status: number, message?: string) => Response;

/**
 * A route's `fail`: `{ error }` with the given message, else the route's
 * message for that status, else `fallback`.
 */
export function failWith(messages: Record<number, string>, fallback: string): Fail {
  return (status, message) => json(status, { error: message ?? messages[status] ?? fallback });
}

/** The request body as a JSON object, or the 400 to answer with. */
export async function jsonObject(
  request: Request,
  fail: Fail,
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400);
  return body as Record<string, unknown>;
}

/**
 * The envelope of every POST route: 405 for other methods, 499 when the
 * request was cancelled, else `statusOf` the error `run` threw.
 */
export async function handlePost(
  request: Request,
  fail: Fail,
  statusOf: (error: unknown) => number,
  run: () => Promise<Response>,
): Promise<Response> {
  if (request.method !== 'POST') return fail(405, 'POST only');
  try {
    return await run();
  } catch (error) {
    if (request.signal.aborted) return fail(499, 'cancelled');
    return fail(statusOf(error));
  }
}

interface RemoteErrorShape {
  remote?: { code?: unknown } | undefined;
  code?: unknown;
  data?: { code?: unknown } | undefined;
}

function remoteCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? ((error as RemoteErrorShape).remote?.code ??
        (error as RemoteErrorShape).code ??
        (error as RemoteErrorShape).data?.code)
    : undefined;
}

/** Status for a Harness (remote, fs or Node) error. */
export function failureStatus(error: unknown): number {
  const code = String(remoteCode(error) ?? '');
  if (
    code === 'session/not-found' ||
    code === 'workspace-file/not-found' ||
    code === 'SESSION_QUERY_SESSION_NOT_FOUND' ||
    code === 'SESSION_QUERY_EVENT_NOT_FOUND' ||
    code === 'FS_NOT_FOUND' ||
    code === 'ENOENT' ||
    code === 'ENOTDIR'
  )
    return 404;
  if (code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED') return 409;
  if (code === 'FS_TOO_LARGE' || code === 'workspace-file/too-large') return 413;
  if (code === 'FS_NOT_TEXT') return 415;
  if (
    code === 'workspace-file/not-regular-file' ||
    code === 'workspace-file/outside-workspace' ||
    code === 'FS_NOT_REGULAR_FILE' ||
    code === 'FS_PERMISSION_DENIED' ||
    code === 'FS_SANDBOX_DENIED'
  )
    return 403;
  return 500;
}

/**
 * Status for an error from a mutation on the Host path (mkdir, link, unlink):
 * Node's own codes first, then {@link failureStatus}.
 */
export function mutationStatus(error: unknown): number {
  const code = (error as { code?: string }).code;
  if (code === 'EEXIST') return 409;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 403;
  return failureStatus(error);
}

/** What a route registration needs from the Host context. */
export interface RouteSpec<C> {
  path: string;
  methods: string[];
  handle: (ctx: C, request: Request) => Promise<Response>;
}

/**
 * Register a route on the authenticated connection with the plugin's
 * lifetime handling: on dispose, in-flight requests are aborted and awaited.
 * @returns the disposer.
 */
export function registerRoute<C>(
  ctx: C & { connection: ConnectionService },
  { path, methods, handle }: RouteSpec<C>,
): () => Promise<void> {
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const unregister = ctx.connection.fetch.register({
    path,
    methods,
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
