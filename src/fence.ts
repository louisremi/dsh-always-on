/**
 * The plugin's own write fence for every mutation it performs: creating,
 * renaming, moving and deleting entries.
 *
 * Writes also go through `ctx.fs.writeText` with the session policy where
 * they can, which a sandboxing backend (`dsh-fs-sandbox`) enforces itself.
 * But a deployment may run the bare local backend, which ignores the policy,
 * and some operations (mkdir, rename, unlink) have no `ctx.fs` primitive at
 * all. So the fence is applied here, independently of the backend, to saves
 * too. For creating, renaming and deleting it is deliberately NARROWER than
 * the agent's `workspace-write`: only the workspace root and its explicit
 * extra writable roots, never the temp areas. Saves (`temp: true`) get
 * exactly the agent's grant, temp areas included.
 *
 * A check is a snapshot: an ancestor directory swapped for a symlink right
 * after it can still redirect the operation. So the routes that create an
 * entry check again where it landed and undo it when it is outside
 * ({@link landedInside}).
 *
 *  - `read-only`          → nothing is writable.
 *  - `workspace-write`    → only paths that canonicalize under a workspace root.
 *  - `danger-full-access` → everything (the session already allows it).
 *  - any other mode       → nothing (unknown means no).
 */
import { lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SandboxPolicy } from './context.ts';

/** Thrown when a path is outside what the session may change. */
export class FenceError extends Error {
  readonly code = 'FS_SANDBOX_DENIED';
}

/**
 * The canonical form of a Host path that may not exist yet: the deepest
 * existing ancestor is resolved through symlinks and the missing tail is
 * appended. The final component is NOT followed when it exists and is a
 * symlink, so a link is judged by where it lives, not where it points.
 * @param path - absolute Host path.
 * @returns canonical absolute path.
 */
export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let at = absolute;
  // The entry itself: an existing symlink stays a name in its (canonical) parent.
  try {
    if ((await lstat(at)).isSymbolicLink()) {
      return join(await canonicalPath(dirname(at)), basename(at));
    }
  } catch {
    /* absent: walk up */
  }
  while (true) {
    try {
      return join(await realpath(at), ...missing.reverse());
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      const parent = dirname(at);
      if (parent === at) throw error;
      missing.push(basename(at));
      at = parent;
    }
  }
}

function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Canonical workspace roots of a policy; roots that do not exist match nothing. */
async function workspaceRoots(policy: SandboxPolicy): Promise<string[]> {
  const roots: string[] = [];
  for (const root of [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])]) {
    try {
      roots.push(await realpath(root));
    } catch {
      /* a missing root grants nothing */
    }
  }
  return roots;
}

/** The temp areas the Harness grants in `workspace-write` (`/tmp` and the OS temp dir). */
async function tempRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const root of ['/tmp', tmpdir()]) {
    try {
      roots.push(await realpath(root));
    } catch {
      /* absent on this platform */
    }
  }
  return roots;
}

/** How a fence check differs from the default (workspace roots, roots included). */
export interface FenceOptions {
  /** `false`: also refuse the workspace roots themselves (they may only be
   *  written inside, never renamed or deleted). */
  root?: boolean;
  /** Also grant the temp areas, exactly like the agent's own `workspace-write`.
   *  Saves use it: they only replace files that already exist. */
  temp?: boolean;
}

/**
 * Whether the session may change the entry at `path`.
 * @param policy - the session's sandbox policy (never widened by the caller).
 * @param path - absolute Host path of the entry to create, change or remove.
 * @param options - see {@link FenceOptions}.
 */
export async function mayWrite(
  policy: SandboxPolicy,
  path: string,
  options: FenceOptions = {},
): Promise<boolean> {
  if (policy.mode === 'danger-full-access') return true;
  if (policy.mode !== 'workspace-write') return false;
  const target = await canonicalPath(path);
  const roots = await workspaceRoots(policy);
  if (options.root === false && roots.includes(target)) return false;
  if (options.temp === true) roots.push(...(await tempRoots()));
  return roots.some((root) => isUnder(target, root));
}

/**
 * Whether an entry that was just created at `path` really is where the fence
 * allowed it: its parent directory, resolved through symlinks NOW, is still a
 * writable place for the session. Catches an ancestor swapped for a symlink
 * between the check and the call.
 */
export async function landedInside(policy: SandboxPolicy, path: string): Promise<boolean> {
  if (policy.mode === 'danger-full-access') return true;
  try {
    const parent = await realpath(dirname(path));
    return await mayWrite(policy, join(parent, basename(path)), { root: false });
  } catch {
    return false;
  }
}

/** {@link mayWrite}, throwing {@link FenceError} on refusal. */
export async function assertWritable(
  policy: SandboxPolicy,
  path: string,
  options: FenceOptions = {},
): Promise<void> {
  if (!(await mayWrite(policy, path, options))) {
    throw new FenceError(`"${path}" is not writable in ${policy.mode} mode`);
  }
}
