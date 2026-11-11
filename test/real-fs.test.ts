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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
import { handleCreateFile, handleCreateFolder } from '../src/create-route.ts';
import { handleDownload } from '../src/download-route.ts';
import { canonicalPath, mayWrite } from '../src/fence.ts';
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

// ─────────────────────────── create file ───────────────────────────

const create = (ctx: SaveContext, body: Record<string, unknown>) =>
  handleCreateFile(
    ctx,
    new Request('http://x/api/create.file', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'sess', directory: workspace, ...body }),
    }),
  );

test('create.file makes an empty file, and missing sub-directories', async () => {
  const host = realHost();
  const res = await create(host.save, { name: 'new.txt' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.absolutePath, join(workspace, 'new.txt'));
  assert.equal(readFileSync(join(workspace, 'new.txt'), 'utf8'), '');
  const nested = await create(host.save, { name: 'deep/er/file.md' });
  assert.equal(nested.status, 201);
  assert.equal(readFileSync(join(workspace, 'deep/er/file.md'), 'utf8'), '');
  const inSub = await create(host.save, { directory: join(workspace, 'sub'), name: 'x.txt' });
  assert.equal(inSub.status, 201);
});

test('create.file never overwrites a file, a directory or a symlink', async () => {
  const host = realHost();
  writeFileSync(join(workspace, 'taken.txt'), 'keep');
  assert.equal((await create(host.save, { name: 'taken.txt' })).status, 409);
  assert.equal(readFileSync(join(workspace, 'taken.txt'), 'utf8'), 'keep');
  assert.equal((await create(host.save, { name: 'sub' })).status, 409);
  assert.equal((await create(host.save, { name: 'escape.txt' })).status, 409);
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret\n');
});

test('create.file follows the sandbox: read-only, outside, symlinked dirs, root', async () => {
  assert.equal((await create(realHost('read-only').save, { name: 'ro.txt' })).status, 403);
  const host = realHost();
  assert.equal((await create(host.save, { directory: outside, name: 'out.txt' })).status, 403);
  assert.equal((await create(host.save, { name: 'escape-dir/out.txt' })).status, 403);
  assert.equal(
    (await create(host.save, { directory: join(workspace, 'escape-dir'), name: 'o.txt' })).status,
    403,
  );
  assert.ok(!readdirSync(outside).includes('out.txt'));
  assert.ok(!readdirSync(outside).includes('o.txt'));
  assert.throws(() => readFileSync(join(workspace, 'ro.txt')));
  // danger-full-access may create outside.
  const full = await create(realHost('danger-full-access').save, {
    directory: outside,
    name: 'full.txt',
  });
  assert.equal(full.status, 201);
});

test('create.file rejects invalid names and bodies', async () => {
  const host = realHost();
  for (const name of [
    '',
    '.',
    '..',
    '../x',
    'a/../b',
    '/abs',
    'a//b',
    'a\\b',
    'tab\there',
    ' lead',
  ]) {
    assert.equal((await create(host.save, { name })).status, 400, JSON.stringify(name));
  }
  assert.equal((await create(host.save, { name: 'x', directory: 'relative' })).status, 400);
  assert.equal((await create(host.save, { name: 'x', sessionId: '' })).status, 400);
  assert.equal((await create(host.save, { name: 'x', sessionId: 'nope' })).status, 404);
});

// ─────────────────────────── create folder ───────────────────────────

const createFolder = (ctx: SaveContext, body: Record<string, unknown>) =>
  handleCreateFolder(
    ctx,
    new Request('http://x/api/create.folder', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'sess', directory: workspace, ...body }),
    }),
  );
const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

test('create.folder makes a folder, and missing parents', async () => {
  const host = realHost();
  const res = await createFolder(host.save, { name: 'folder' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).absolutePath, join(workspace, 'folder'));
  assert.ok(isDir(join(workspace, 'folder')));
  assert.equal((await createFolder(host.save, { name: 'a/b/c' })).status, 201);
  assert.ok(isDir(join(workspace, 'a/b/c')));
});

test('create.folder never replaces an existing file, folder or symlink', async () => {
  const host = realHost();
  writeFileSync(join(workspace, 'plain.txt'), 'keep');
  assert.equal((await createFolder(host.save, { name: 'plain.txt' })).status, 409);
  assert.equal(readFileSync(join(workspace, 'plain.txt'), 'utf8'), 'keep');
  assert.equal((await createFolder(host.save, { name: 'sub' })).status, 409);
  assert.equal((await createFolder(host.save, { name: 'escape-dir' })).status, 409);
});

test('create.folder follows the sandbox and rejects bad names', async () => {
  assert.equal((await createFolder(realHost('read-only').save, { name: 'ro' })).status, 403);
  assert.ok(!existsSync(join(workspace, 'ro')));
  const host = realHost();
  assert.equal((await createFolder(host.save, { directory: outside, name: 'o' })).status, 403);
  assert.equal((await createFolder(host.save, { name: 'escape-dir/o' })).status, 403);
  assert.equal((await createFolder(host.save, { name: 'escape-dir/x/y' })).status, 403);
  assert.ok(!existsSync(join(outside, 'o')) && !existsSync(join(outside, 'x')));
  for (const name of ['', '..', 'a/../b', '/abs', 'a\\b']) {
    assert.equal((await createFolder(host.save, { name })).status, 400, JSON.stringify(name));
  }
  const full = await createFolder(realHost('danger-full-access').save, {
    directory: outside,
    name: 'full-dir',
  });
  assert.equal(full.status, 201);
});

test('fence: canonical paths and the narrow workspace-only grant', async () => {
  const policy = { mode: 'workspace-write', workspaceRoot: workspace };
  assert.equal(await canonicalPath(join(workspace, 'a/b/../c')), join(workspace, 'a/c'));
  // A symlink is judged where it lives, not where it points.
  assert.equal(await canonicalPath(join(workspace, 'escape.txt')), join(workspace, 'escape.txt'));
  assert.equal(await mayWrite(policy, join(workspace, 'x')), true);
  assert.equal(await mayWrite(policy, join(workspace, 'escape-dir', 'x')), false);
  assert.equal(await mayWrite(policy, join(tmpdir(), 'x')), false, 'temp areas are not granted');
  assert.equal(await mayWrite(policy, workspace), true);
  assert.equal(await mayWrite(policy, workspace, { root: false }), false);
  assert.equal(await mayWrite({ ...policy, mode: 'read-only' }, join(workspace, 'x')), false);
  assert.equal(await mayWrite({ ...policy, mode: 'bogus' }, join(workspace, 'x')), false);
  assert.equal(
    await mayWrite({ ...policy, additionalWritableRoots: [outside] }, join(outside, 'x')),
    true,
  );
});
