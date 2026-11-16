/**
 * Which trash folders the 30-day purge visits, and when.
 *
 * Every root a session may write in can hold a trash (`<root>/.tmp/deleted`,
 * src/trash.ts), and so can the top of a volume mounted inside one. The purge
 * visits, at start and once a day:
 *  - the default workspace and the deployment's extra writable roots;
 *  - the workspace of every stored session (`sessionPersistence.list()`),
 *    running or not, so a workspace nobody used since the last restart is
 *    still emptied;
 *  - every trash a delete used since the plugin started (a mounted volume's
 *    trash is only found that way).
 * Only trash folders that already exist are visited; none is created.
 */
import type { SessionPersistence } from './context.ts';
import { existingTrashDir, purgeTrash } from './trash.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What finding the trash folders needs from the Host context. */
export interface PurgeContext {
  sandboxPolicy: { workspaceRoot: string; additionalWritableRoots?: readonly string[] | undefined };
  get(name: string): SessionPersistence | undefined;
}

/** The roots whose trash the purge visits: deployment roots, then each stored session's workspace. */
export async function purgeRoots(ctx: PurgeContext): Promise<string[]> {
  const roots = new Set([
    ctx.sandboxPolicy.workspaceRoot,
    ...(ctx.sandboxPolicy.additionalWritableRoots ?? []),
  ]);
  const persistence = ctx.get('sessionPersistence');
  if (typeof persistence?.list === 'function') {
    try {
      for (const session of await persistence.list()) {
        const cwd = session.header?.cwd;
        if (typeof cwd === 'string' && cwd.length > 0) roots.add(cwd);
      }
    } catch (error) {
      console.warn('[dsh-always-on] trash purge: cannot list the sessions:', error);
    }
  }
  return [...roots];
}

/** The trash folders to purge now: the roots' existing ones, plus `used`. */
export async function trashDirs(ctx: PurgeContext, used: Iterable<string>): Promise<string[]> {
  const dirs = new Set(used);
  for (const root of await purgeRoots(ctx)) {
    const dir = await existingTrashDir(root);
    if (dir !== undefined) dirs.add(dir);
  }
  return [...dirs];
}

function purgeLogged(dir: string): Promise<void> {
  return purgeTrash(dir).then(
    () => undefined,
    (error) => {
      console.warn(`[dsh-always-on] trash purge of "${dir}" failed:`, error);
    },
  );
}

/**
 * Start the purge: every trash folder now and once a day.
 * @returns `trashUsed`, to call with the trash folder each delete used (it is
 *   purged then, and remembered), and `stop`.
 */
export function startPurge(ctx: PurgeContext): {
  trashUsed: (trashDir: string) => void;
  stop: () => void;
} {
  const used = new Set<string>();
  let running: Promise<void> | undefined;
  const purgeAll = () => {
    // One sweep at a time: a slow disk must not pile sweeps up.
    running ??= trashDirs(ctx, used)
      .then((dirs) => Promise.all(dirs.map(purgeLogged)))
      .then(() => undefined)
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  void purgeAll();
  const timer = setInterval(purgeAll, DAY_MS);
  timer.unref?.();
  return {
    trashUsed: (trashDir) => {
      used.add(trashDir);
      void purgeLogged(trashDir);
    },
    stop: () => clearInterval(timer),
  };
}
