import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { timedBody } from '../src/folder-route.ts';
import { type PurgeContext, purgeRoots, startPurge, trashDirs } from '../src/purge.ts';
import { slotName, TRASH_DAYS, TRASH_DIR } from '../src/trash.ts';

const fixtures = join(import.meta.dirname, '.fixtures');
mkdirSync(fixtures, { recursive: true });
const base = realpathSync(mkdtempSync(join(fixtures, 'purge-')));
after(() => rmSync(base, { recursive: true, force: true }));

/** A root holding a trash with one slot `days` old; returns the slot's path. */
function oldSlot(root: string, days: number): string {
  const slot = join(root, TRASH_DIR, slotName(new Date(Date.now() - days * 86_400_000)));
  mkdirSync(join(slot, 'x'), { recursive: true });
  return slot;
}

function hostWith(sessions: (string | undefined)[], list = true): PurgeContext {
  const workspace = join(base, 'default');
  mkdirSync(workspace, { recursive: true });
  return {
    sandboxPolicy: { workspaceRoot: workspace, additionalWritableRoots: [join(base, 'extra')] },
    get: (name) =>
      name === 'sessionPersistence'
        ? {
            stat: async () => undefined,
            ...(list ? { list: async () => sessions.map((cwd) => ({ header: { cwd } })) } : {}),
          }
        : undefined,
  };
}

test('the purge visits the default workspace, extra roots and every stored session', async () => {
  const a = join(base, 'ws-a');
  const b = join(base, 'ws-b');
  const ctx = hostWith([a, b, undefined, a]);
  assert.deepEqual(await purgeRoots(ctx), [join(base, 'default'), join(base, 'extra'), a, b]);
  // Without list() (an older Harness), the deployment roots only.
  assert.deepEqual(await purgeRoots(hostWith([a], false)), [
    join(base, 'default'),
    join(base, 'extra'),
  ]);
});

test('only trash folders that exist are visited, plus the ones deletes used', async () => {
  const a = join(base, 'ws-c');
  const b = join(base, 'ws-d');
  mkdirSync(join(a, TRASH_DIR), { recursive: true });
  mkdirSync(b, { recursive: true });
  const used = join(base, 'volume', TRASH_DIR);
  const dirs = await trashDirs(hostWith([a, b]), [used]);
  assert.deepEqual(dirs.sort(), [join(a, TRASH_DIR), used].sort());
  assert.ok(!existsSync(join(b, '.tmp')), 'no trash is created');
});

test('startPurge empties old slots of every session workspace at start', async () => {
  const a = join(base, 'ws-e');
  const old = oldSlot(a, TRASH_DAYS + 1);
  const young = oldSlot(a, TRASH_DAYS - 1);
  const purge = startPurge(hostWith([a]));
  try {
    for (let i = 0; i < 50 && existsSync(old); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(!existsSync(old), 'a slot older than 30 days goes');
    assert.ok(existsSync(young), 'a younger one stays');
    // A trash a delete used is purged right away.
    const v = join(base, 'vol-f');
    const vold = oldSlot(v, TRASH_DAYS + 2);
    purge.trashUsed(join(v, TRASH_DIR));
    for (let i = 0; i < 50 && existsSync(vold); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(!existsSync(vold));
  } finally {
    purge.stop();
  }
});

async function* slowChunks(gapsMs: number[], closed: { value: boolean }) {
  try {
    for (const gap of gapsMs) {
      await new Promise((r) => setTimeout(r, gap));
      yield new Uint8Array([1]);
    }
  } finally {
    closed.value = true;
  }
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<number> {
  let n = 0;
  for await (const chunk of body) n += chunk.length;
  return n;
}

test('a folder download ends when it stalls, when it runs too long, or on abort', async () => {
  const quick = { stallMs: 200, totalMs: 1000 };
  const closed = { value: false };
  // Steady chunks within both limits: all of them.
  assert.equal(
    await readAll(timedBody(slowChunks([50, 50, 50], closed), new AbortController().signal, quick)),
    3,
  );
  // A gap longer than stallMs: ended, and the generator closed (files closed).
  closed.value = false;
  await assert.rejects(
    readAll(timedBody(slowChunks([50, 400], closed), new AbortController().signal, quick)),
    /stalled/,
  );
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(closed.value, 'the archive generator is returned');
  // Always busy, but past totalMs.
  await assert.rejects(
    readAll(
      timedBody(slowChunks(Array(30).fill(100), { value: false }), new AbortController().signal, {
        stallMs: 200,
        totalMs: 500,
      }),
    ),
    /too long/,
  );
  // The request aborted mid-way.
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 120);
  await assert.rejects(
    readAll(timedBody(slowChunks([50, 50, 50, 50], { value: false }), abort.signal, quick)),
    /cancelled/,
  );
});
