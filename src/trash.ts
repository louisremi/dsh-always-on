/**
 * The trash: every delete moves its file or folder to
 * `<root>/.tmp/deleted/<stamp>/<name>`, where `<root>` is the workspace root
 * (or extra writable root) the entry lives in. A restore token lets the
 * client undo the last deletion for a few minutes; the trash itself is purged
 * after {@link TRASH_DAYS} days.
 *
 * The trash stays inside the root on purpose: a move within one filesystem
 * is a rename (instant, atomic for folders), and it stays inside what the
 * session may write, so the fence needs no exception for it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { SandboxPolicy } from './context.ts';
import { type Entry, moveNoReplace } from './entry.ts';
import { FenceError } from './fence.ts';
import { undoMkdir } from './paths.ts';

/** How long trashed entries are kept before the purge removes them. */
export const TRASH_DAYS = 30;
/** How long the Host keeps a restore token (the UI offers it for 10 s only). */
export const RESTORE_TTL_MS = 10 * 60 * 1000;
/** The trash folder, relative to a root. */
export const TRASH_DIR = join('.tmp', 'deleted');

const DAY_MS = 24 * 60 * 60 * 1000;
/** `<YYYYMMDD>T<HHMMSS>Z-<8 hex>`: the only names the purge ever removes. */
const SLOT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{8}$/;

function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A slot name for `now`, unique enough for two deletes in one second. */
export function slotName(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${randomBytes(4).toString('hex')}`;
}

/** When a slot was created, from its name; undefined for any other name. */
export function slotTime(name: string): number | undefined {
  const m = SLOT.exec(name);
  if (m === null) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return Date.UTC(y as number, (mo as number) - 1, d, h, mi, s);
}

/**
 * The canonical root an entry belongs to: the workspace root or extra
 * writable root containing it. In danger-full-access an entry outside every
 * root goes to the workspace root's trash.
 */
async function rootOf(policy: SandboxPolicy, hostPath: string): Promise<string> {
  const path = join(await realpath(dirname(hostPath)), basename(hostPath));
  const roots: string[] = [];
  for (const root of [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])]) {
    try {
      roots.push(await realpath(root));
    } catch {
      /* a missing root holds nothing */
    }
  }
  // The deepest root wins when roots nest.
  const holder = roots
    .filter((root) => path !== root && isUnder(path, root))
    .sort((a, b) => b.length - a.length)[0];
  if (holder !== undefined) return holder;
  if (policy.mode === 'danger-full-access' && roots[0] !== undefined) return roots[0];
  throw new FenceError(`"${hostPath}" is in no writable root`);
}

/**
 * `<root>/.tmp/deleted`, created when missing. Refused when `.tmp` or
 * `deleted` is anything but a real directory: a symlink there could send
 * deleted files anywhere.
 */
export async function trashDirOf(root: string): Promise<string> {
  const dir = join(root, TRASH_DIR);
  // One level at a time, each checked before going into it.
  for (const part of [join(root, '.tmp'), dir]) {
    try {
      await mkdir(part);
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
    const info = await lstat(part);
    if (!info.isDirectory())
      throw new FenceError(`"${part}" is not a real directory, so it cannot hold the trash`);
  }
  return dir;
}

/** What a restore token remembers; never sent to the client. */
interface Restorable {
  sessionId: string;
  kind: Entry['kind'];
  originalPath: string;
  trashedPath: string;
  dev: number;
  ino: number;
  expires: number;
}

const restorable = new Map<string, Restorable>();

function sweep(now: number): void {
  for (const [token, item] of restorable) if (item.expires <= now) restorable.delete(token);
}

/** Where a deleted entry went, and the token that brings it back. */
export interface Trashed {
  trashedPath: string;
  restoreToken: string;
  /** The trash folder it went to (for the purge). */
  trashDir: string;
}

/**
 * Whether `hostPath` is the trash or inside it (deleting there is final), or
 * holds the trash (refused: it would move the trash into itself).
 */
export async function trashRelation(
  policy: SandboxPolicy,
  hostPath: string,
): Promise<'inside' | 'holds' | 'none'> {
  const root = await rootOf(policy, hostPath);
  const path = join(await realpath(dirname(hostPath)), basename(hostPath));
  const trash = join(root, TRASH_DIR);
  if (path !== trash && isUnder(path, trash)) return 'inside';
  if (isUnder(trash, path)) return 'holds';
  return 'none';
}

/**
 * Move a checked entry to a fresh slot of its root's trash. All or nothing:
 * on failure the empty slot goes again and the entry stays where it was.
 */
export async function moveToTrash(
  entry: Entry,
  sessionId: string,
  now = new Date(),
): Promise<Trashed> {
  const root = await rootOf(entry.policy, entry.hostPath);
  const trashDir = await trashDirOf(root);
  const slot = join(trashDir, slotName(now));
  const first = await mkdir(slot, { recursive: true });
  const trashedPath = join(slot, basename(entry.hostPath));
  try {
    await moveNoReplace(entry, trashedPath);
  } catch (error) {
    await undoMkdir(slot, first);
    throw error;
  }
  // A file copied across filesystems is a new inode: remember the one in the trash.
  const moved = await lstat(trashedPath);
  sweep(now.getTime());
  const restoreToken = randomUUID();
  restorable.set(restoreToken, {
    sessionId,
    kind: entry.kind,
    originalPath: entry.hostPath,
    trashedPath,
    dev: moved.dev,
    ino: moved.ino,
    expires: now.getTime() + RESTORE_TTL_MS,
  });
  return { trashedPath, restoreToken, trashDir };
}

/** A restore token's entry, still in the trash and unchanged. */
export interface RestoreItem {
  token: string;
  kind: Entry['kind'];
  originalPath: string;
  trashedPath: string;
  dev: number;
  ino: number;
}

/** The entry a token restores, or undefined (unknown, expired, other session). */
export function restoreItem(
  token: unknown,
  sessionId: string,
  now = Date.now(),
): RestoreItem | undefined {
  sweep(now);
  if (typeof token !== 'string') return undefined;
  const item = restorable.get(token);
  if (item === undefined || item.sessionId !== sessionId) return undefined;
  const { kind, originalPath, trashedPath, dev, ino } = item;
  return { token, kind, originalPath, trashedPath, dev, ino };
}

/** Forget a token once its entry is restored. */
export function forgetRestore(token: string): void {
  restorable.delete(token);
}

/**
 * Remove `path` and everything under it, never following symlinks (a link is
 * removed, not what it points to) and never crossing into another filesystem
 * (a mounted directory is left in place, with its parents).
 * @returns whether everything was removed.
 */
async function removeTree(path: string, dev: number): Promise<boolean> {
  const info = await lstat(path);
  if (!info.isDirectory()) {
    await unlink(path);
    return true;
  }
  if (info.dev !== dev) {
    console.warn(`[dsh-always-on] trash purge: "${path}" is another filesystem, left in place`);
    return false;
  }
  let all = true;
  for (const name of await readdir(path)) {
    try {
      if (!(await removeTree(join(path, name), dev))) all = false;
    } catch (error) {
      all = false;
      console.warn(`[dsh-always-on] trash purge: cannot remove "${join(path, name)}":`, error);
    }
  }
  if (all) await rmdir(path);
  return all;
}

/**
 * Remove the slots of a trash folder older than {@link TRASH_DAYS} days.
 * Only names that are slots go; anything else in the folder is left alone.
 * @returns the slots removed.
 */
export async function purgeTrash(trashDir: string, now = Date.now()): Promise<string[]> {
  let names: string[];
  let dev: number;
  try {
    const info = await lstat(trashDir);
    if (!info.isDirectory()) return [];
    dev = info.dev;
    names = await readdir(trashDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const time = slotTime(name);
    if (time === undefined || now - time < TRASH_DAYS * DAY_MS) continue;
    try {
      if (await removeTree(join(trashDir, name), dev)) removed.push(name);
    } catch (error) {
      console.warn(`[dsh-always-on] trash purge: cannot remove "${name}":`, error);
    }
  }
  return removed;
}

/** The trash folder of a root, if it already exists as a real directory. */
export async function existingTrashDir(root: string): Promise<string | undefined> {
  try {
    const real = await realpath(root);
    const dir = join(real, TRASH_DIR);
    for (const part of [join(real, '.tmp'), dir]) {
      const info = await lstat(part);
      if (!info.isDirectory()) return undefined;
    }
    return dir;
  } catch {
    return undefined;
  }
}
