/**
 * The checked entry every rename, delete and restore acts on, and the two
 * no-replace moves (a file, a folder) they share.
 *
 * `ctx.fs` has no rename, unlink or rmdir, so these operate on the verified
 * Host path, guarded by the plugin's write fence (src/fence.ts). Both moves
 * promise the same three things: they NEVER replace anything at the
 * destination, they move only the entry that was checked, and they are all
 * or nothing.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, link, lstat, unlink } from 'node:fs/promises';
import type { SandboxPolicy } from './context.ts';
import { FenceError, landedInside } from './fence.ts';

/** A file or folder as checked: path, policy and identity. */
export interface Entry {
  kind: 'file' | 'folder';
  hostPath: string;
  policy: SandboxPolicy;
  dev: number;
  ino: number;
}

/** An error carrying a Node-style code, which mutationStatus maps to a status. */
export function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Throw unless `entry.hostPath` still names the very entry that was checked,
 * inside the fence: an ancestor swapped for a symlink since then would make
 * the same path reach another file or folder.
 */
export async function assertUnchanged(entry: Entry): Promise<void> {
  const now = await lstat(entry.hostPath);
  if (
    now.dev !== entry.dev ||
    now.ino !== entry.ino ||
    !(await landedInside(entry.policy, entry.hostPath))
  )
    throw new FenceError(`"${entry.hostPath}" is no longer the entry that was checked`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Give the file `from` the new name `to` without ever replacing an existing
 * `to`: hard-link it to the new name (which fails if the name is taken), then
 * remove the old name. Across filesystems it copies exclusively instead. All
 * or nothing: when the new name lands outside the fence, the source is no
 * longer the checked file, or the old name cannot be removed, the new name is
 * removed again and the error is thrown.
 */
export async function moveFileNoReplace(from: Entry, to: string): Promise<void> {
  try {
    await link(from.hostPath, to);
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Different filesystem, or one without hard links: exclusive copy instead.
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP') throw error;
    await copyFile(from.hostPath, to, constants.COPYFILE_EXCL);
  }
  try {
    if (!(await landedInside(from.policy, to)))
      throw new FenceError(`"${to}" landed outside the writable roots`);
    await assertUnchanged(from);
    await unlink(from.hostPath);
  } catch (error) {
    await unlink(to).catch(() => undefined);
    throw error;
  }
}

/** The command folder moves spawn; tests point it elsewhere (setMoveCommand). */
let moveCommand = 'mv';

/** Override the `mv` binary (tests: a missing one). @returns the previous one. */
export function setMoveCommand(command: string): string {
  const previous = moveCommand;
  moveCommand = command;
  return previous;
}

interface ExecFailure {
  code?: unknown;
  stderr?: unknown;
  killed?: boolean;
}

/**
 * `mv --no-copy --no-clobber -T from to`, with errors translated to codes.
 * Node has no no-replace rename (`fs.rename` silently replaces an empty
 * folder), but GNU coreutils' `mv` uses `renameat2(RENAME_NOREPLACE)`:
 *  - `--no-clobber` refuses an existing `to` (`-T` alone falls back to a plain
 *    rename that replaces an empty folder);
 *  - `--no-copy` never falls back to copy + delete across filesystems;
 *  - `-T` never moves INTO an existing folder named `to`.
 * `-n` exits 0 when it refuses (coreutils ≥ 9.5; 9.2–9.4 exit 1 with "not
 * replacing"), so callers check the outcome on disk.
 */
function runMove(from: string, to: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      moveCommand,
      ['--no-copy', '--no-clobber', '-T', '--', from, to],
      { timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve(String(stderr));
          return;
        }
        const failure = error as ExecFailure;
        const message = String(failure.stderr ?? stderr ?? '').trim() || error.message;
        if (failure.code === 'ENOENT')
          reject(codedError(`"${moveCommand}" is not available on this Host`, 'ENOSYS'));
        else if (/unrecognized option|invalid option|unknown option/i.test(message))
          reject(codedError(`"${moveCommand}" lacks --no-copy/--no-clobber: ${message}`, 'ENOSYS'));
        // coreutils 9.2–9.4 exit 1 when -n skips (9.5+ exit 0, see moveDirNoReplace).
        else if (/not replacing|file exists/i.test(message)) reject(codedError(message, 'EEXIST'));
        else if (/cross-device/i.test(message)) reject(codedError(message, 'EXDEV'));
        else if (/subdirectory of itself/i.test(message)) reject(codedError(message, 'EINVAL'));
        else if (/no such file/i.test(message)) reject(codedError(message, 'ENOENT'));
        else if (/permission denied|operation not permitted|read-only/i.test(message))
          reject(codedError(message, 'EACCES'));
        else reject(new Error(message));
      },
    );
  });
}

/**
 * Give the folder `from` the new name `to` without ever replacing anything
 * at `to` (see runMove). Same promises as {@link moveFileNoReplace}: when the
 * folder landed outside the fence, or what moved is not the checked folder,
 * it is moved back and the error is thrown. Refused (code EXDEV) across
 * filesystems rather than copied, which could leave half a tree.
 */
export async function moveDirNoReplace(from: Entry, to: string): Promise<void> {
  await assertUnchanged(from);
  const stderr = await runMove(from.hostPath, to);
  if (/not replacing/i.test(stderr) || (await exists(from.hostPath)))
    throw codedError(`"${to}" already exists`, 'EEXIST');
  const moved = await lstat(to);
  const same = moved.dev === from.dev && moved.ino === from.ino;
  if (!same || !(await landedInside(from.policy, to))) {
    await runMove(to, from.hostPath).catch((error) => {
      console.error(`[dsh-always-on] could not move "${to}" back to "${from.hostPath}":`, error);
    });
    throw new FenceError(
      same ? `"${to}" landed outside the writable roots` : `"${from.hostPath}" changed`,
    );
  }
}

/** Move a checked file or folder to `to`, never replacing anything there. */
export function moveNoReplace(from: Entry, to: string): Promise<void> {
  return from.kind === 'file' ? moveFileNoReplace(from, to) : moveDirNoReplace(from, to);
}
