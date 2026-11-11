/**
 * The routes against the REAL Harness filesystem stack instead of fakes:
 * `@deepseek-ai/dsh-fs-sandbox` (atomic writes, version guards, the sandbox
 * fence) and `@deepseek-ai/dsh-api-workspace-files` (workspace path
 * resolution, symlink and regular-file gates), wired the way the Harness wires
 * them, over a temporary directory. These pin what the fakes in
 * route.test.ts / save.test.ts can only assume: that the plugin really cannot
 * write outside a session's sandbox, through a symlink, or in read-only mode.
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files';
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import type { DownloadContext, LiveSession, SaveContext } from '../src/context.ts';
import { handleDownload } from '../src/download-route.ts';
import { handleSave } from '../src/save-route.ts';

// Everything lives under one fixture root: `workspace` is the session's
// sandbox, `outside` a sibling it must not reach. NOT under the OS temp dir:
// workspace-write deliberately grants /tmp and os.tmpdir() too, so a fixture
// there would make every "outside" write legitimately allowed.
const fixtures = join(import.meta.dirname, '.fixtures');
mkdirSync(fixtures, { recursive: true });
const base = realpathSync(mkdtempSync(join(fixtures, 'realfs-')));
for (const temp of [tmpdir(), '/tmp']) {
  assert.ok(!base.startsWith(realpathSync(temp)), `fixture root ${base} must not be in ${temp}`);
}
const workspace = join(base, 'workspace');
const outside = join(base, 'outside');
mkdirSync(join(workspace, 'sub'), { recursive: true });
mkdirSync(outside);
writeFileSync(join(outside, 'secret.txt'), 'secret\n');
symlinkSync(join(outside, 'secret.txt'), join(workspace, 'escape.txt'));
symlinkSync(outside, join(workspace, 'escape-dir'));
after(() => rmSync(base, { recursive: true, force: true }));

type Mode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** The Harness services the routes consume, built from the real packages. */
function realHost(mode: Mode = 'workspace-write') {
  const policy = {
    defaultMode: mode,
    workspaceRoot: workspace,
    resolve: ({ session }: { session: LiveSession }) => ({
      mode,
      workspaceRoot: workspace,
      sessionId: session.id,
    }),
  };
  const ctx = new Context();
  ctx.provide('sandboxPolicy', policy);
  const fs = new SandboxedFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 1 << 20 });
  const workspaceFiles = new WorkspaceFiles(ctx, {
    maxBytes: 2 << 20,
    maxFileBytes: 32 << 20,
    maxLines: 5000,
    maxEntries: 2000,
  });
  // The real classes are structurally wider than the plugin's own interfaces
  // (branded ids, extra members); the casts only bridge those spellings.
  const save: SaveContext = {
    fs: fs as unknown as SaveContext['fs'],
    sandboxPolicy: policy,
    workspaceFiles: workspaceFiles as unknown as SaveContext['workspaceFiles'],
    sessions: { get: (id) => (id === 'sess' ? { id } : undefined) },
    get: () => undefined,
  };
  const download: DownloadContext = {
    fs: fs as unknown as DownloadContext['fs'],
    sandboxPolicy: policy,
    workspaceFiles: workspaceFiles as unknown as DownloadContext['workspaceFiles'],
    sessionQuery: {
      async readEvent() {
        throw new Error('unused');
      },
    },
    workspaceChanges: { summary: () => undefined },
  };
  return { save, download, workspaceFiles: save.workspaceFiles };
}

const scope = { sessionId: 'sess', workspaceRoot: workspace };
const versionOf = async (path: string) =>
  (await realHost().workspaceFiles.stat(scope, path, AbortSignal.timeout(5000))).version;

const save = (ctx: SaveContext, body: Record<string, unknown>) =>
  handleSave(
    ctx,
    new Request('http://x/api/save.file', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'sess', ...body }),
    }),
  );
const download = (ctx: DownloadContext, path: string) =>
  handleDownload(ctx, new Request(`http://x/api/download.file?path=${encodeURIComponent(path)}`));

/** Files in a directory other than the expected ones: leftovers of a non-atomic write. */
const stray = (dir: string, expected: string[]) =>
  readdirSync(dir).filter((name) => !expected.includes(name));

test('a version-checked save writes atomically and returns the real new version', async () => {
  const file = join(workspace, 'a.txt');
  writeFileSync(file, 'one\r\n');
  const host = realHost();
  const before = await versionOf('a.txt');
  const res = await save(host.save, { path: 'a.txt', content: 'two\r\n', expectedVersion: before });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.operation, 'update');
  assert.equal(body.version, await versionOf('a.txt'));
  assert.notEqual(body.version, before);
  assert.equal(readFileSync(file, 'utf8'), 'two\r\n');
  // No temp file or staging directory is left beside the target.
  assert.deepEqual(stray(workspace, ['a.txt', 'sub', 'escape.txt', 'escape-dir']), []);
});

test('a stale version is refused by the real guard and the file is untouched', async () => {
  const file = join(workspace, 'b.txt');
  writeFileSync(file, 'one\n');
  const stale = await versionOf('b.txt');
  writeFileSync(file, 'changed elsewhere, longer\n');
  const host = realHost();
  const res = await save(host.save, { path: 'b.txt', content: 'mine', expectedVersion: stale });
  assert.equal(res.status, 409);
  assert.equal(readFileSync(file, 'utf8'), 'changed elsewhere, longer\n');
  const forced = await save(host.save, { path: 'b.txt', content: 'mine', force: true });
  assert.equal(forced.status, 200);
  assert.equal(readFileSync(file, 'utf8'), 'mine');
});

test('read-only mode refuses every save', async () => {
  const file = join(workspace, 'c.txt');
  writeFileSync(file, 'keep\n');
  const res = await save(realHost('read-only').save, { path: 'c.txt', content: 'x', force: true });
  assert.equal(res.status, 403);
  assert.equal(readFileSync(file, 'utf8'), 'keep\n');
});

test('workspace-write refuses absolute paths outside the workspace', async () => {
  const target = join(outside, 'secret.txt');
  const res = await save(realHost().save, { path: target, content: 'pwned', force: true });
  assert.equal(res.status, 403);
  assert.equal(readFileSync(target, 'utf8'), 'secret\n');
});

test('a symlink escaping the workspace cannot be written through', async () => {
  for (const path of ['escape.txt', 'escape-dir/secret.txt', '../outside/secret.txt']) {
    const res = await save(realHost().save, { path, content: 'pwned', force: true });
    assert.ok(res.status === 403 || res.status === 404, `${path}: ${res.status}`);
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret\n', path);
  }
});

test('danger-full-access is the only mode that writes outside the workspace', async () => {
  const target = join(outside, 'allowed.txt');
  writeFileSync(target, 'old');
  const res = await save(realHost('danger-full-access').save, {
    path: target,
    content: 'new',
    force: true,
  });
  assert.equal(res.status, 200);
  assert.equal(readFileSync(target, 'utf8'), 'new');
});

test('directories and missing files are refused, nothing is created', async () => {
  const host = realHost();
  assert.equal((await save(host.save, { path: 'sub', content: 'x', force: true })).status, 403);
  assert.equal(
    (await save(host.save, { path: 'nope.txt', content: 'x', force: true })).status,
    404,
  );
  assert.deepEqual(readdirSync(join(workspace, 'sub')), []);
  assert.throws(() => readFileSync(join(workspace, 'nope.txt')));
});

test('download streams the exact bytes of a real file and refuses directories', async () => {
  const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
  const file = join(workspace, 'blob.bin');
  writeFileSync(file, bytes);
  const host = realHost();
  const res = await download(host.download, file);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  assert.equal((await download(host.download, join(workspace, 'sub'))).status, 403);
  assert.equal((await download(host.download, join(workspace, 'missing'))).status, 404);
});
