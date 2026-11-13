/**
 * A bounded walk of a folder on the Host: what the delete dialog counts and
 * what a folder download archives. Symlinks are never followed (nor listed),
 * and neither are special files: only real folders and regular files.
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** One entry under the walked folder; `path` is relative, `/`-separated. */
export interface WalkEntry {
  type: 'file' | 'folder';
  path: string;
  hostPath: string;
  size: number;
  mtime: Date;
}

export interface WalkLimits {
  /** Stop after this many entries (files + folders). */
  maxEntries: number;
  /** Stop after this many bytes of files. */
  maxBytes: number;
  /** Stop when this is aborted (a deadline, the request). */
  signal?: AbortSignal | undefined;
}

export interface Walk {
  entries: WalkEntry[];
  files: number;
  folders: number;
  bytes: number;
  /** Symlinks, special files and unreadable folders left out, relative paths. */
  skipped: string[];
  /** Whether a limit stopped the walk before the end. */
  truncated: boolean;
  /** Folders on another filesystem than their parent (mount points), relative paths. */
  mounts: string[];
}

/**
 * Walk `root` depth-first in name order, without following symlinks.
 * @param root - absolute Host path of a real folder.
 */
export async function walkFolder(root: string, limits: WalkLimits): Promise<Walk> {
  const walk: Walk = {
    entries: [],
    files: 0,
    folders: 0,
    bytes: 0,
    skipped: [],
    truncated: false,
    mounts: [],
  };
  const stack: { rel: string; dev: number | undefined }[] = [{ rel: '', dev: undefined }];
  while (stack.length > 0) {
    const { rel, dev } = stack.pop() as { rel: string; dev: number | undefined };
    let names: string[];
    try {
      names = (await readdir(join(root, rel))).sort();
    } catch {
      walk.skipped.push(rel);
      continue;
    }
    let parentDev = dev;
    if (parentDev === undefined) {
      try {
        parentDev = Number((await lstat(root)).dev);
      } catch {
        parentDev = undefined;
      }
    }
    const folders: { rel: string; dev: number }[] = [];
    for (const name of names) {
      if (limits.signal?.aborted) {
        walk.truncated = true;
        return walk;
      }
      const path = rel === '' ? name : `${rel}/${name}`;
      const hostPath = join(root, path);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(hostPath);
      } catch {
        walk.skipped.push(path);
        continue;
      }
      const isFile = info.isFile();
      if (!isFile && !info.isDirectory()) {
        walk.skipped.push(path);
        continue;
      }
      const size = isFile ? Number(info.size) : 0;
      if (walk.entries.length + 1 > limits.maxEntries || walk.bytes + size > limits.maxBytes) {
        walk.truncated = true;
        return walk;
      }
      walk.entries.push({
        type: isFile ? 'file' : 'folder',
        path,
        hostPath,
        size,
        mtime: info.mtime,
      });
      if (isFile) {
        walk.files++;
        walk.bytes += size;
      } else {
        walk.folders++;
        const folderDev = Number(info.dev);
        if (parentDev !== undefined && folderDev !== parentDev) walk.mounts.push(path);
        folders.push({ rel: path, dev: folderDev });
      }
    }
    // Reversed so the stack pops them in name order.
    for (const folder of folders.reverse()) stack.push(folder);
  }
  return walk;
}
