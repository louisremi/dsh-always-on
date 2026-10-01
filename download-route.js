import { isAbsolute, basename } from 'node:path';

export const DOWNLOAD_PATH = '/api/download.file';
/** Bytes read from the filesystem per stream pull. */
export const CHUNK_BYTES = 1024 * 1024;

const NUMERIC = /^\d+$/;

function text(status, body, method) {
  return new Response(method === 'HEAD' ? null : body, {
    status,
    headers: { 'cache-control': 'private, no-store' },
  });
}

function coordinate(value) {
  return value !== null && NUMERIC.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined;
}

/** Content-Disposition value with an ASCII fallback and an RFC 5987 UTF-8 name. */
export function contentDisposition(name) {
  const clean = [...name].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join('').replace(/[\\/]/g, '_') || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["%;]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function isPresentedFile(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof value.path === 'string' && value.path.trim().length > 0;
}

function remoteCode(error) {
  return typeof error === 'object' && error !== null
    ? (error.remote?.code ?? error.code ?? error.data?.code)
    : undefined;
}

function failureStatus(error) {
  const code = String(remoteCode(error) ?? '');
  if (code === 'session/not-found' || code === 'workspace-file/not-found'
    || code === 'SESSION_QUERY_SESSION_NOT_FOUND' || code === 'SESSION_QUERY_EVENT_NOT_FOUND'
    || code === 'FS_NOT_FOUND' || code === 'ENOENT' || code === 'ENOTDIR') return 404;
  if (code === 'workspace-file/not-regular-file' || code === 'workspace-file/outside-workspace'
    || code === 'FS_NOT_REGULAR_FILE' || code === 'FS_PERMISSION_DENIED'
    || code === 'FS_SANDBOX_DENIED') return 403;
  return 500;
}

/** Resolve the Host path named by the request's query, or a Response to answer with. */
async function locate(ctx, request, query) {
  const source = query.get('source');
  if (source === null) {
    const path = query.get('path');
    if (path === null || path.length === 0) return text(400, 'missing path', request.method);
    if (path.includes('\0') || !isAbsolute(path)) return text(400, 'absolute path required', request.method);
    return path;
  }
  const id = query.get('sessionId');
  const seq = coordinate(query.get('seq'));
  const index = coordinate(query.get('index'));
  if (!id || seq === undefined || index === undefined) {
    return text(400, 'invalid file coordinates', request.method);
  }
  if (source === 'present') {
    const read = await ctx.sessionQuery.readEvent(
      { sessionId: id, seq, before: 0, after: 0 }, request.signal);
    const { target, session } = read;
    const file = target.type === 'deliverables/presented' && Array.isArray(target.data?.files)
      ? target.data.files[index] : undefined;
    if (!isPresentedFile(file)) return text(404, 'presented file not found', request.method);
    const { absolutePath } = await ctx.workspaceFiles.stat(
      { sessionId: id, workspaceRoot: session.cwd ?? ctx.sandboxPolicy.workspaceRoot },
      file.path, request.signal);
    return absolutePath;
  }
  if (source === 'changes') {
    const summary = ctx.workspaceChanges.summary(id, seq);
    if (summary === undefined) return text(404, 'change summary unavailable', request.method);
    const file = summary.files[index];
    if (file === undefined) return text(404, 'changed file not found', request.method);
    const { absolutePath } = await ctx.workspaceFiles.stat(
      { sessionId: id, workspaceRoot: summary.cwd }, file.path, request.signal);
    return absolutePath;
  }
  return text(400, 'invalid source', request.method);
}

/**
 * Handle GET/HEAD /api/download.file. `path=<absolute>` serves a Host file;
 * `source=present|changes&sessionId&seq&index` serves a file by the same
 * Session event coordinates the stock file cards use.
 */
export async function handleDownload(ctx, request) {
  const method = request.method;
  const query = new URL(request.url).searchParams;
  try {
    const located = await locate(ctx, request, query);
    if (located instanceof Response) return located;
    const { fs } = ctx;
    const processPath = fs.processPathFromHostPath(located);
    if (processPath === undefined) return text(422, 'path has no verified Host path', method);
    request.signal.throwIfAborted();
    const target = await fs.resolve(processPath, { signal: request.signal });
    const info = await fs.stat(target, request.signal);
    if (info === undefined) return text(404, 'not found', method);
    if (info.type !== 'file') return text(403, 'not a regular file', method);
    const size = typeof info.size === 'number' ? info.size : undefined;
    const headers = {
      'cache-control': 'private, no-store',
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-disposition': contentDisposition(basename(target.displayPath ?? processPath)),
    };
    if (size !== undefined) headers['content-length'] = String(size);
    if (method === 'HEAD') return new Response(null, { headers });

    let offset = 0;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          if (size !== undefined && offset >= size) { controller.close(); return; }
          const chunk = await fs.readByteRange(
            target, { offset, length: CHUNK_BYTES }, request.signal);
          if (chunk.byteLength === 0) {
            if (size !== undefined) throw new Error('file shrank while downloading');
            controller.close();
            return;
          }
          offset += chunk.byteLength;
          controller.enqueue(chunk);
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(body, { headers });
  } catch (error) {
    if (request.signal.aborted) return text(499, 'cancelled', method);
    return text(failureStatus(error), 'file unavailable', method);
  }
}

/** Register the route on the authenticated connection; returns its disposer. */
export function registerDownloadRoute(ctx) {
  const lifetime = new AbortController();
  const pending = new Set();
  const unregister = ctx.connection.fetch.register({
    path: DOWNLOAD_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: (request) => {
      const task = handleDownload(
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
