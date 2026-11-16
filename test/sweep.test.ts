/** The boot-time sweep of upload temporary files left by a crash (src/sweep.ts). */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { PurgeContext } from '../src/purge.ts';
import { STALE_PART_MS, sweepUploadParts } from '../src/sweep.ts';
import { isUploadPartName, UPLOAD_PART_PREFIX } from '../src/upload-route.ts';

const fixtures = join(import.meta.dirname, '.fixtures');
mkdirSync(fixtures, { recursive: true });
const base = realpathSync(mkdtempSync(join(fixtures, 'sweep-')));
after(() => rmSync(base, { recursive: true, force: true }));

/** An upload temporary file `ageMs` old. */
const part = (dir: string, ageMs: number): string => {
  const path = join(dir, `${UPLOAD_PART_PREFIX}${randomUUID()}.part`);
  writeFileSync(path, 'half');
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
  return path;
};

function hostWith(roots: string[]): PurgeContext {
  const [workspace, ...extras] = roots;
  return {
    sandboxPolicy: { workspaceRoot: workspace as string, additionalWritableRoots: extras },
    get: (name) =>
      name === 'sessionPersistence'
        ? { stat: async () => undefined, list: async () => [] }
        : undefined,
  };
}

test('the sweep removes old upload temporary files, and only those', async () => {
  const workspace = join(base, 'ws');
  const nested = join(workspace, 'deep', 'folder');
  const extra = join(base, 'extra');
  mkdirSync(nested, { recursive: true });
  mkdirSync(extra);
  const old = part(workspace, 2 * STALE_PART_MS);
  const oldNested = part(nested, 2 * STALE_PART_MS);
  const oldExtra = part(extra, 2 * STALE_PART_MS);
  const fresh = part(workspace, 0);
  // Anything that is not the plugin's own temporary file stays, however old.
  const kept = [
    join(workspace, 'report.md'),
    join(workspace, `${UPLOAD_PART_PREFIX}not-a-uuid.part`),
    join(workspace, 'notes.part'),
  ];
  for (const path of kept) {
    writeFileSync(path, 'keep');
    utimesSync(path, new Date(0), new Date(0));
  }
  const removed = await sweepUploadParts(hostWith([workspace, extra]));
  assert.deepEqual(removed.sort(), [old, oldExtra, oldNested].sort());
  for (const path of [...kept, fresh]) assert.ok(existsSync(path), `kept ${path}`);
});

test('the sweep bounds its walk and survives a root it cannot read', async () => {
  const workspace = join(base, 'bounded');
  mkdirSync(workspace, { recursive: true });
  const old = part(workspace, 2 * STALE_PART_MS);
  // A walk that stops before looking at anything finds nothing (a bounded sweep).
  assert.deepEqual(
    await sweepUploadParts(hostWith([workspace]), { limits: { maxEntries: 0, deadlineMs: 5_000 } }),
    [],
  );
  assert.ok(existsSync(old));
  // A root that does not exist is a warning, not a boot failure.
  assert.deepEqual(await sweepUploadParts(hostWith([join(base, 'gone')])), []);
  // The real limits find it.
  assert.deepEqual(await sweepUploadParts(hostWith([workspace])), [old]);
  assert.ok(!existsSync(old));
});

test('the temporary-file name the route writes is the one the sweep recognises', () => {
  assert.ok(isUploadPartName(`${UPLOAD_PART_PREFIX}${randomUUID()}.part`));
  for (const name of [
    'notes.part',
    `${UPLOAD_PART_PREFIX}x.part`,
    `${UPLOAD_PART_PREFIX}${randomUUID()}`,
  ])
    assert.equal(isUploadPartName(name), false, name);
});
