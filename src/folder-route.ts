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
import { type WalkLimits, walkFolder } from './walk.ts';
import { type ZipMember, zipStream } from './zip.ts';

export const SUMMARY_PATH = '/api/folder.summary';
export const DOWNLOAD_FOLDER_PATH = '/api/download.folder';

/** What a folder download may hold; keep in step with FOLDER_LIMITS in src/client.ts. */
export const FOLDER_LIMITS = {
  maxEntries: 20_000,
  maxBytes: 2 * 1024 * 1024 * 1024,
};
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
  limits: Pick<WalkLimits, 'maxEntries' | 'maxBytes'> = FOLDER_LIMITS,
): Promise<Response> {
  const method = request.method;
  try {
    const folder = await folderOf(ctx, request);
    if (folder instanceof Response) return folder;
    const walk = await walkFolder(folder, { ...limits, signal: request.signal });
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
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (request.signal.aborted) throw request.signal.reason;
          const next = await chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await chunks.return(undefined);
      },
    });
    return new Response(body, { headers });
  } catch (error) {
    if (request.signal.aborted) return text(499, 'cancelled', method);
    return text(failureStatus(error), 'folder unavailable', method);
  }
}
