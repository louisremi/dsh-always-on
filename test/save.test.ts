import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  FetchRoute,
  FsTarget,
  LiveSession,
  SandboxPolicy,
  SaveContext,
  SaveRegisterContext,
  WriteIntent,
} from '../src/context.ts';
import { handleSave, MAX_SAVE_BYTES, registerSaveRoute } from '../src/save-route.ts';

const dir = mkdtempSync(join(tmpdir(), 'dlf-save-'));
mkdirSync(join(dir, 'sub'));

const versionOf = (path: string) => {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
};
const denied = () => Object.assign(new Error('denied'), { code: 'FS_SANDBOX_DENIED' });
const coded = (code: string) => Object.assign(new Error(code), { code });

/** What the fake fs.writeText records per call. */
interface Write {
  target: FsTarget;
  content: string;
  intent: WriteIntent | undefined;
  policy: SandboxPolicy;
}

type FakeSaveCtx = SaveContext & { writes: Write[] };

/** A fake Host context backed by the real filesystem, mirroring fs.writeText's version guard. */
function fakeCtx({
  mode = 'workspace-write',
  live = true,
}: {
  mode?: string;
  live?: boolean;
} = {}): FakeSaveCtx {
  const writes: Write[] = [];
  const session: LiveSession = { id: 'sess' };
  return {
    writes,
    fs: {
      processPathFromHostPath: (p) => (p.startsWith('/etc/') ? undefined : p),
      async resolve(p) {
        return { displayPath: p };
      },
      async stat(t) {
        try {
          const s = statSync(t.displayPath!);
          return {
            type: s.isFile() ? 'file' : 'directory',
            size: s.size,
            version: versionOf(t.displayPath!),
          };
        } catch {
          return undefined;
        }
      },
      async writeText(target, content, intent, _signal, policy) {
        writes.push({ target, content, intent, policy });
        if (policy.mode === 'read-only') throw denied();
        if (!target.displayPath!.startsWith(policy.workspaceRoot)) throw denied();
        if (
          intent?.kind === 'replaceIfVersion' &&
          intent.version !== versionOf(target.displayPath!)
        ) {
          throw coded('FS_STALE_VERSION');
        }
        writeFileSync(target.displayPath!, content);
        return { operation: 'update', version: versionOf(target.displayPath!) };
      },
    },
    sessions: { get: (id) => (live && id === 'sess' ? session : undefined) },
    get: (name) =>
      name === 'sessionPersistence'
        ? { stat: async (id: string) => (id === 'cold' ? { header: { cwd: dir } } : undefined) }
        : undefined,
    sandboxPolicy: {
      defaultMode: 'workspace-write',
      workspaceRoot: dir,
      resolve: ({ session: s }: { session: LiveSession }) => ({
        mode,
        workspaceRoot: dir,
        sessionId: s.id,
      }),
    },
    workspaceFiles: {
      async stat(scope, path) {
        if (path.includes('outside')) return { absolutePath: join(tmpdir(), 'dlf-outside.txt') };
        return { absolutePath: path.startsWith('/') ? path : join(scope.workspaceRoot, path) };
      },
    },
  };
}

const post = (ctx: SaveContext, body: unknown, init: RequestInit = {}) =>
  handleSave(
    ctx,
    new Request('http://x/api/save.file', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
    }),
  );
const fresh = (name: string, text = 'one\n') => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

test('saves with the version it read and returns the new version', async () => {
  const file = fresh('a.txt');
  const ctx = fakeCtx();
  const before = versionOf(file);
  const res = await post(ctx, {
    sessionId: 'sess',
    path: 'a.txt',
    content: 'two\n',
    expectedVersion: before,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.operation, 'update');
  assert.equal(body.version, versionOf(file));
  assert.notEqual(body.version, before);
  assert.equal(readFileSync(file, 'utf8'), 'two\n');
  assert.deepEqual(ctx.writes[0].intent, { kind: 'replaceIfVersion', version: before });
  assert.equal(ctx.writes[0].policy.mode, 'workspace-write');
});

test('stale version is a 409 and leaves the file untouched; force overwrites', async () => {
  const file = fresh('b.txt');
  const stale = versionOf(file);
  writeFileSync(file, 'changed elsewhere\n');
  const ctx = fakeCtx();
  const conflict = await post(ctx, {
    sessionId: 'sess',
    path: 'b.txt',
    content: 'mine',
    expectedVersion: stale,
  });
  assert.equal(conflict.status, 409);
  assert.equal(readFileSync(file, 'utf8'), 'changed elsewhere\n');
  const forced = await post(ctx, {
    sessionId: 'sess',
    path: 'b.txt',
    content: 'mine',
    force: true,
  });
  assert.equal(forced.status, 200);
  assert.equal(readFileSync(file, 'utf8'), 'mine');
  assert.equal(ctx.writes.at(-1)!.intent, undefined);
});

test('the Session sandbox policy is enforced and never widened', async () => {
  const file = fresh('c.txt');
  const ro = await post(fakeCtx({ mode: 'read-only' }), {
    sessionId: 'sess',
    path: 'c.txt',
    content: 'x',
    expectedVersion: versionOf(file),
  });
  assert.equal(ro.status, 403);
  assert.equal(readFileSync(file, 'utf8'), 'one\n');
  const outside = join(tmpdir(), 'dlf-outside.txt');
  writeFileSync(outside, 'keep');
  const out = await post(fakeCtx(), {
    sessionId: 'sess',
    path: 'outside.txt',
    content: 'x',
    force: true,
  });
  assert.equal(out.status, 403);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
});

test('a cold session uses its persisted workspace root with the deployment default mode', async () => {
  const file = fresh('d.txt');
  const ctx = fakeCtx({ live: false });
  const res = await post(ctx, {
    sessionId: 'cold',
    path: 'd.txt',
    content: 'cold',
    expectedVersion: versionOf(file),
  });
  assert.equal(res.status, 200);
  assert.equal(ctx.writes[0].policy.mode, 'workspace-write');
  assert.equal(ctx.writes[0].policy.workspaceRoot, dir);
  assert.equal(
    (await post(ctx, { sessionId: 'nope', path: 'd.txt', content: 'x', force: true })).status,
    404,
  );
});

test('request validation', async () => {
  const ctx = fakeCtx();
  const ok = { sessionId: 'sess', path: 'a.txt', content: 'x', force: true };
  assert.equal((await post(ctx, '{not json')).status, 400);
  assert.equal((await post(ctx, [])).status, 400);
  assert.equal((await post(ctx, { ...ok, sessionId: '' })).status, 400);
  assert.equal((await post(ctx, { ...ok, path: '' })).status, 400);
  assert.equal((await post(ctx, { ...ok, path: 'a\0b' })).status, 400);
  assert.equal((await post(ctx, { ...ok, content: 5 })).status, 400);
  assert.equal((await post(ctx, { ...ok, force: 'yes' })).status, 400);
  assert.equal((await post(ctx, { sessionId: 'sess', path: 'a.txt', content: 'x' })).status, 400);
  assert.equal((await post(ctx, { ...ok, content: 'x'.repeat(MAX_SAVE_BYTES + 1) })).status, 413);
  assert.equal(ctx.writes.length, 0);
  const get = await handleSave(ctx, new Request('http://x/api/save.file'));
  assert.equal(get.status, 405);
});

test('missing files, directories and unmapped paths are refused', async () => {
  const ctx = fakeCtx();
  const base = { sessionId: 'sess', content: 'x', force: true };
  assert.equal((await post(ctx, { ...base, path: 'missing.txt' })).status, 404);
  assert.equal((await post(ctx, { ...base, path: join(dir, 'sub') })).status, 403);
  assert.equal((await post(ctx, { ...base, path: '/etc/passwd' })).status, 422);
  assert.equal((await post(ctx, { ...base, path: 'relative-only-when-stat-says-so' })).status, 404);
  assert.equal(ctx.writes.length, 0);
});

test('registerSaveRoute registers POST, serves, and disposes', async () => {
  let route: FetchRoute | undefined;
  let removed = false;
  const file = fresh('e.txt');
  const ctx: SaveRegisterContext & { writes: Write[] } = {
    ...fakeCtx(),
    connection: {
      fetch: {
        register(r) {
          route = r;
          return () => {
            removed = true;
          };
        },
      },
    },
  };
  const dispose = registerSaveRoute(ctx);
  assert.ok(route);
  assert.equal(route.path, '/api/save.file');
  assert.deepEqual(route.methods, ['POST']);
  assert.equal(route.requestBody, 'buffered');
  const res = await route.fetch(
    new Request('http://x/api/save.file', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'sess',
        path: 'e.txt',
        content: 'via route',
        expectedVersion: versionOf(file),
      }),
    }),
  );
  assert.equal(res.status, 200);
  await dispose();
  assert.ok(removed);
});
