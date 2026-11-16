/**
 * Read-only folder routes: a summary for the delete dialog, and a folder
 * downloaded as one `.zip`. Like /api/download.file they need a verified
 * Host path and the Harness filesystem's word that the path is a folder;
 * the walk then never follows symlinks (src/walk.ts).
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import type { DownloadContext } from './context.ts';
import { contentDisposition, text } from './download-route.ts';
import { failureStatus, json } from './http.ts';
import { walkFolder } from './walk.ts';
import { type ZipMember, zipStream } from './zip.ts';

export const SUMMARY_PATH = '/api/folder.summary';
export const DOWNLOAD_FOLDER_PATH = '/api/download.folder';

/** What a folder download may hold; src/client.ts and the README repeat it (test/limits.test.ts checks). */
export const FOLDER_LIMITS = {
  maxEntries: 20_000,
  maxBytes: 2 * 1024 * 1024 * 1024,
};
/**
 * How long a folder download may take. A download that sends nothing for
 * `stallMs` (the browser stopped reading, or a file read hangs) is ended, so
 * a dead connection does not keep files open; `totalMs` is a safety net only:
 * the 2 GiB limit fits in a day at 25 KB/s.
 */
export const DOWNLOAD_TIMEOUTS = { stallMs: 5 * 60 * 1000, totalMs: 24 * 60 * 60 * 1000 };

/** How far a summary counts before it says "more than". */
export const SUMMARY_LIMITS = { maxEntries: 100_000, maxBytes: Number.MAX_SAFE_INTEGER };
const SUMMARY_DEADLINE_MS = 2000;

/** The folder a request's `?path=` names, checked by the Harness filesystem; or a Response. */
async function folderOf(ctx: DownloadContext, request: Request): Promise<string | Response> {
  const method = request.method;
  const path = new URL(request.url).searchParams.get('path');
  if (path === null || path.length === 0) return text(400, 'missing path', method);
  if (path.includes('\0') || !isAbsolute(path)) return text(400, 'absolute path required', method);
  const processPath = ctx.fs.processPathFromHostPath(path);
  if (processPath === undefined) return text(422, 'path has no verified Host path', method);
  const target = await ctx.fs.resolve(processPath, { signal: request.signal });
  const info = await ctx.fs.stat(target, request.signal);
  if (info === undefined) return text(404, 'not found', method);
  if (info.type !== 'directory') return text(403, 'not a folder', method);
  // The folder the Harness resolved (through a symlinked path), when it is on the Host.
  const resolved = target.targetKey;
  return resolved !== undefined && ctx.fs.processPathFromHostPath(resolved) !== undefined
    ? resolved
    : path;
}

/**
 * Handle GET /api/folder.summary?path=: `{ files, folders, bytes, truncated,
 * mounts, downloadable }` for everything under a folder (symlinks not followed
 * nor counted; `mounts` lists the volumes mounted inside it). Stops
 * counting after {@link SUMMARY_LIMITS} or 2 s, with `truncated: true`.
 */
export async function handleFolderSummary(
  ctx: DownloadContext,
  request: Request,
): Promise<Response> {
  try {
    const folder = await folderOf(ctx, request);
    if (folder instanceof Response) return folder;
    const walk = await walkFolder(folder, {
      ...SUMMARY_LIMITS,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(SUMMARY_DEADLINE_MS)]),
    });
    request.signal.throwIfAborted();
    return json(200, {
      files: walk.files,
      folders: walk.folders,
      bytes: walk.bytes,
      truncated: walk.truncated,
      mounts: walk.mounts,
      downloadable:
        !walk.truncated &&
        walk.entries.length <= FOLDER_LIMITS.maxEntries &&
        walk.bytes <= FOLDER_LIMITS.maxBytes,
    });
  } catch (error) {
    if (request.signal.aborted) return text(499, 'cancelled', request.method);
    return text(failureStatus(error), 'folder unavailable', request.method);
  }
}

/**
 * `chunks` as a response body that ends with an error when the request is
 * aborted, when no chunk went out for `stallMs`, or after `totalMs` in all.
 * Ending it returns the generator, which closes the file being read.
 */
export function timedBody(
  chunks: AsyncGenerator<Uint8Array>,
  signal: AbortSignal,
  timeouts: { stallMs: number; totalMs: number },
): ReadableStream<Uint8Array> {
  let ended = false;
  let stall: ReturnType<typeof setTimeout> | undefined;
  let total: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  /** End the body: closed when `error` is undefined, else errored. */
  const finish = (error?: unknown) => {
    if (ended) return;
    ended = true;
    clearTimeout(stall);
    clearTimeout(total);
    signal.removeEventListener('abort', onAbort);
    if (error === undefined) controller?.close();
    else {
      controller?.error(error);
      void chunks.return(undefined).catch(() => undefined);
    }
  };
  const fail = (message: string) => finish(new Error(message));
  const onAbort = () => fail('download cancelled');
  const armStall = () => {
    clearTimeout(stall);
    stall = setTimeout(() => fail('download stalled'), timeouts.stallMs);
    stall.unref?.();
  };
  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      total = setTimeout(() => fail('download took too long'), timeouts.totalMs);
      total.unref?.();
      armStall();
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    },
    async pull(c) {
      try {
        const next = await chunks.next();
        if (ended) return;
        if (next.done) {
          finish();
          return;
        }
        // Every chunk that goes out re-arms the stall timer.
        armStall();
        c.enqueue(next.value);
      } catch (error) {
        finish(error);
      }
    },
    async cancel() {
      ended = true;
      clearTimeout(stall);
      clearTimeout(total);
      signal.removeEventListener('abort', onAbort);
      await chunks.return(undefined);
    },
  });
}

/** Open a file for the archive without following a symlink swapped in since the walk. */
async function openNoFollow(hostPath: string) {
  const handle = await open(hostPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    throw new Error('no longer a regular file');
  }
  return handle.createReadStream();
}

/**
 * Handle GET/HEAD /api/download.folder?path=: the folder as `<name>.zip`, its
 * entries under `<name>/`. Symlinks and special files are left out; files
 * that cannot be read are listed in `<name>/DOWNLOAD-SKIPPED.txt`. 413 when
 * the folder holds more than {@link FOLDER_LIMITS}.
 */
export async function handleDownloadFolder(
  ctx: DownloadContext,
  request: Request,
): Promise<Response> {
  const method = request.method;
  try {
    const folder = await folderOf(ctx, request);
    if (folder instanceof Response) return folder;
    const walk = await walkFolder(folder, { ...FOLDER_LIMITS, signal: request.signal });
    request.signal.throwIfAborted();
    if (walk.truncated) return text(413, 'folder too large to download', method);
    const name = basename(folder) || 'folder';
    const headers = {
      'cache-control': 'private, no-store',
      'content-type': 'application/zip',
      'x-content-type-options': 'nosniff',
      'content-disposition': contentDisposition(`${name}.zip`),
    };
    if (method === 'HEAD') return new Response(null, { headers });

    const skipped = [...walk.skipped];
    async function* members(): AsyncGenerator<ZipMember> {
      yield { name, type: 'folder', mtime: new Date() };
      for (const entry of walk.entries) {
        yield {
          name: `${name}/${entry.path}`,
          type: entry.type,
          mtime: entry.mtime,
          open: () => openNoFollow(entry.hostPath),
        };
      }
      if (skipped.length > 0) {
        const note = `Left out of this download (symbolic links, special files, or unreadable):\n${skipped.join('\n')}\n`;
        yield {
          name: `${name}/DOWNLOAD-SKIPPED.txt`,
          type: 'file',
          mtime: new Date(),
          open: async () => Readable.from([Buffer.from(note, 'utf8')]),
        };
      }
    }
    const chunks = zipStream(members(), (member) => {
      skipped.push(member.slice(name.length + 1));
    });
    return new Response(timedBody(chunks, request.signal, DOWNLOAD_TIMEOUTS), { headers });
  } catch (error) {
    if (request.signal.aborted) return text(499, 'cancelled', method);
    return text(failureStatus(error), 'folder unavailable', method);
  }
}
