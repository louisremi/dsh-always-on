/**
 * The boot-time sweep of upload temporary files.
 *
 * An upload streams into `<folder>/.dlf-upload-<uuid>.part` and gives it the
 * real name at the end (src/upload-route.ts). An error or a cancel removes it,
 * but a crash cannot: the file then stays in the folder it was uploading to.
 * At start, every folder a session may write in is walked once and those
 * leftovers are removed.
 *
 * Only files older than {@link STALE_PART_MS} go, so an upload another Harness
 * process is making into the same folder is never pulled from under it. The
 * walk is bounded: a huge tree stops the sweep for that root, not the boot.
 */

import { lstat, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import type { PurgeContext } from './purge.ts';
import { purgeRoots } from './purge.ts';
import { isUploadPartName } from './upload-route.ts';
import { walkFolder } from './walk.ts';

/** How old a temporary file must be before the sweep removes it. */
export const STALE_PART_MS = 60 * 60 * 1000;

export const SWEEP_LIMITS = { maxEntries: 20_000, deadlineMs: 30_000 };

/**
 * Remove the upload temporary files older than {@link STALE_PART_MS} under
 * every root a session may write in.
 * @param ctx - the Host context the trash purge already reads.
 * @param options - `now` and `limits`, for tests.
 * @returns the removed paths.
 */
export async function sweepUploadParts(
  ctx: PurgeContext,
  options: { now?: number; limits?: { maxEntries: number; deadlineMs: number } } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const limits = options.limits ?? SWEEP_LIMITS;
  const removed: string[] = [];
  for (const root of await purgeRoots(ctx)) {
    const signal = AbortSignal.timeout(limits.deadlineMs);
    let walk: Awaited<ReturnType<typeof walkFolder>>;
    try {
      walk = await walkFolder(root, {
        maxEntries: limits.maxEntries,
        maxBytes: Number.MAX_SAFE_INTEGER,
        signal,
      });
    } catch (error) {
      // A missing root, one that is not a folder, or a slow disk: not fatal.
      console.warn(`[dsh-always-on] upload sweep of "${root}" failed:`, error);
      continue;
    }
    for (const entry of walk.entries) {
      if (entry.type !== 'file' || !isUploadPartName(basename(entry.path))) continue;
      if (now - entry.mtime.getTime() < STALE_PART_MS) continue;
      try {
        // lstat again: the walk's `mtime` is a moment old, and unlink never follows a symlink.
        const info = await lstat(entry.hostPath);
        if (!info.isFile() || now - info.mtimeMs < STALE_PART_MS) continue;
        await unlink(entry.hostPath);
        removed.push(entry.hostPath);
      } catch (error) {
        console.warn(`[dsh-always-on] could not remove "${entry.hostPath}":`, error);
      }
    }
  }
  return removed;
}
