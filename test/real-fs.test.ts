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
  chmodSync,
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
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import type { DownloadContext, LiveSession, SaveContext } from '../src/context.ts';
import { handleCreateFile, handleCreateFolder } from '../src/create-route.ts';
import { handleDownload } from '../src/download-route.ts';
import { handleDeleteFile, handleRenameFile } from '../src/entry-route.ts';
import { canonicalPath, landedInside, mayWrite } from '../src/fence.ts';
import { undoMkdir } from '../src/paths.ts';
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

interface HostOptions {
  /** `local`: the bare dsh-fs-local backend, which ignores the policy. */
  backend?: 'sandbox' | 'local';
  /** Extra directories workspace-write may write under. */
  extraRoots?: string[];
}

/** The Harness services the routes consume, built from the real packages. */
function realHost(mode: Mode = 'workspace-write', options: HostOptions = {}) {
  const policy = {
    defaultMode: mode,
    workspaceRoot: workspace,
    resolve: ({ session }: { session: LiveSession }) => ({
      mode,
      workspaceRoot: workspace,
      additionalWritableRoots: options.extraRoots,
      sessionId: session.id,
    }),
  };
  const ctx = new Context();
  ctx.provide('sandboxPolicy', policy);
  const Backend = options.backend === 'local' ? LocalFileSystem : SandboxedFileSystem;
  const fs = new Backend(ctx, { cwd: workspace, diffBasisMaxBytes: 1 << 20 });
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
    // A session that is not running: its persisted workspace, the default mode.
    get: (name) =>
      name === 'sessionPersistence'
        ? {
            stat: async (id: string) =>
              id === 'cold' ? { header: { cwd: workspace } } : undefined,
          }
        : undefined,
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

// ──────────────────────── rename / delete file ────────────────────────

const entry = (handle: typeof handleRenameFile, ctx: SaveContext, body: Record<string, unknown>) =>
  handle(
    ctx,
    new Request('http://x/api/entry', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'sess', ...body }),
    }),
  );
const rename = (ctx: SaveContext, path: string, destination: string) =>
  entry(handleRenameFile, ctx, { path, destination });
const remove = (ctx: SaveContext, path: string) => entry(handleDeleteFile, ctx, { path });

test('rename.file renames in place and moves into new folders', async () => {
  const host = realHost();
  const from = join(workspace, 'r1.txt');
  writeFileSync(from, 'content');
  const res = await rename(host.save, from, 'r2.txt');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).absolutePath, join(workspace, 'r2.txt'));
  assert.ok(!existsSync(from));
  assert.equal(readFileSync(join(workspace, 'r2.txt'), 'utf8'), 'content');
  const moved = await rename(host.save, join(workspace, 'r2.txt'), join(workspace, 'm/n/r3.txt'));
  assert.equal(moved.status, 200);
  assert.equal(readFileSync(join(workspace, 'm/n/r3.txt'), 'utf8'), 'content');
  // Same name: a no-op success.
  assert.equal((await rename(host.save, join(workspace, 'm/n/r3.txt'), 'r3.txt')).status, 200);
});

test('rename.file never replaces anything at the destination', async () => {
  const host = realHost();
  writeFileSync(join(workspace, 's1.txt'), 'mine');
  writeFileSync(join(workspace, 's2.txt'), 'theirs');
  assert.equal((await rename(host.save, join(workspace, 's1.txt'), 's2.txt')).status, 409);
  assert.equal(readFileSync(join(workspace, 's2.txt'), 'utf8'), 'theirs');
  assert.equal(readFileSync(join(workspace, 's1.txt'), 'utf8'), 'mine');
  assert.equal((await rename(host.save, join(workspace, 's1.txt'), 'sub')).status, 409);
  assert.equal((await rename(host.save, join(workspace, 's1.txt'), 'escape.txt')).status, 409);
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret\n');
});

test('rename.file follows the sandbox, refuses folders, symlinks and bad names', async () => {
  const file = join(workspace, 't1.txt');
  writeFileSync(file, 'x');
  assert.equal((await rename(realHost('read-only').save, file, 't2.txt')).status, 403);
  const host = realHost();
  assert.equal((await rename(host.save, file, join(outside, 'stolen.txt'))).status, 403);
  assert.equal((await rename(host.save, file, 'escape-dir/stolen.txt')).status, 403);
  assert.ok(!existsSync(join(outside, 'stolen.txt')));
  assert.ok(existsSync(file));
  assert.equal(
    (await rename(host.save, join(outside, 'secret.txt'), join(workspace, 'in.txt'))).status,
    403,
  );
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret\n');
  assert.equal((await rename(host.save, join(workspace, 'sub'), 'sub2')).status, 403);
  assert.equal((await rename(host.save, join(workspace, 'escape.txt'), 'e2.txt')).status, 403);
  assert.ok(existsSync(join(workspace, 'escape.txt')));
  for (const destination of ['', '..', '../x.txt', 'a/../b', 'a\\b']) {
    assert.equal((await rename(host.save, file, destination)).status, 400, destination);
  }
  assert.equal((await rename(host.save, join(workspace, 'gone.txt'), 'x.txt')).status, 404);
  assert.equal((await rename(host.save, 'relative.txt', 'x.txt')).status, 400);
});

test('delete.file deletes one regular file inside the sandbox only', async () => {
  const host = realHost();
  const file = join(workspace, 'd1.txt');
  writeFileSync(file, 'bye');
  assert.equal((await remove(realHost('read-only').save, file)).status, 403);
  assert.ok(existsSync(file));
  const res = await remove(host.save, file);
  assert.equal(res.status, 200);
  assert.ok(!existsSync(file));
  assert.equal((await remove(host.save, file)).status, 404);
  assert.equal((await remove(host.save, join(outside, 'secret.txt'))).status, 403);
  assert.equal((await remove(host.save, join(workspace, 'sub'))).status, 403);
  assert.ok(isDir(join(workspace, 'sub')));
  // A symlink is refused, never followed: neither the link nor its target goes.
  assert.equal((await remove(host.save, join(workspace, 'escape.txt'))).status, 403);
  assert.ok(existsSync(join(workspace, 'escape.txt')));
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret\n');
  assert.equal((await remove(host.save, join(workspace, 'escape-dir/secret.txt'))).status, 403);
  assert.ok(existsSync(join(outside, 'secret.txt')));
  const full = join(outside, 'deletable.txt');
  writeFileSync(full, 'x');
  assert.equal((await remove(realHost('danger-full-access').save, full)).status, 200);
});

test('fence: canonical paths and the narrow workspace-only grant', async () => {
  const policy = { mode: 'workspace-write', workspaceRoot: workspace };
  assert.equal(await canonicalPath(join(workspace, 'a/b/../c')), join(workspace, 'a/c'));
  // A symlink is judged where it lives, not where it points.
  assert.equal(await canonicalPath(join(workspace, 'escape.txt')), join(workspace, 'escape.txt'));
  assert.equal(await mayWrite(policy, join(workspace, 'x')), true);
  assert.equal(await mayWrite(policy, join(workspace, 'escape-dir', 'x')), false);
  assert.equal(await mayWrite(policy, join(tmpdir(), 'x')), false, 'temp areas are not granted');
  assert.equal(await mayWrite(policy, workspace), false, 'a root itself is never a target');
  assert.equal(await mayWrite({ ...policy, mode: 'read-only' }, join(workspace, 'x')), false);
  assert.equal(await mayWrite({ ...policy, mode: 'bogus' }, join(workspace, 'x')), false);
  assert.equal(
    await mayWrite({ ...policy, additionalWritableRoots: [outside] }, join(outside, 'x')),
    true,
  );
});

// ─────────────── review fixes: fence order, bare backend, races ───────────────

test('rename/delete: a path outside the sandbox is a 403 whether or not it exists', async () => {
  const host = realHost();
  for (const path of [join(outside, 'missing.txt'), outside, join(outside, 'secret.txt')]) {
    assert.equal((await remove(host.save, path)).status, 403, path);
    assert.equal((await rename(host.save, path, join(workspace, 'x.txt'))).status, 403, path);
  }
  // read-only: refused before looking, so a missing file is a 403 too.
  const ro = realHost('read-only').save;
  assert.equal((await remove(ro, join(workspace, 'never-existed.txt'))).status, 403);
});

test('on the bare local backend (no policy enforcement) the plugin still fences saves', async () => {
  const target = join(outside, 'bare.txt');
  writeFileSync(target, 'keep');
  const bare = realHost('workspace-write', { backend: 'local' }).save;
  assert.equal((await save(bare, { path: target, content: 'pwned', force: true })).status, 403);
  assert.equal(
    (await save(bare, { path: 'escape.txt', content: 'pwned', force: true })).status,
    403,
  );
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret\n');
  const ro = realHost('read-only', { backend: 'local' }).save;
  writeFileSync(join(workspace, 'bare-in.txt'), 'old');
  assert.equal((await save(ro, { path: 'bare-in.txt', content: 'x', force: true })).status, 403);
  assert.equal(
    (await save(bare, { path: 'bare-in.txt', content: 'new', force: true })).status,
    200,
  );
  assert.equal(readFileSync(join(workspace, 'bare-in.txt'), 'utf8'), 'new');
  // The other mutations hold on the bare backend as well.
  assert.equal((await create(bare, { directory: outside, name: 'b.txt' })).status, 403);
  assert.equal((await createFolder(bare, { name: 'escape-dir/b' })).status, 403);
  assert.ok(!existsSync(join(outside, 'b.txt')) && !existsSync(join(outside, 'b')));
});

test('saves keep the agent grant: temp areas stay writable, like for the agent', async () => {
  const policy = { mode: 'workspace-write', workspaceRoot: workspace };
  assert.equal(await mayWrite(policy, join(tmpdir(), 'x'), { temp: true }), true);
  assert.equal(await mayWrite(policy, join(outside, 'x'), { temp: true }), false);
});

test('extra writable roots and cold sessions work at route level', async () => {
  const extra = join(base, 'extra');
  mkdirSync(extra, { recursive: true });
  const host = realHost('workspace-write', { extraRoots: [extra] }).save;
  assert.equal((await create(host, { directory: extra, name: 'e.txt' })).status, 201);
  assert.equal((await createFolder(host, { directory: extra, name: 'e-dir' })).status, 201);
  assert.equal((await rename(host, join(extra, 'e.txt'), 'e2.txt')).status, 200);
  assert.equal((await remove(host, join(extra, 'e2.txt'))).status, 200);
  // Without the extra root, the same directory is outside.
  assert.equal((await create(realHost().save, { directory: extra, name: 'n.txt' })).status, 403);
  // A session that is not running uses its persisted workspace.
  writeFileSync(join(workspace, 'cold.txt'), 'c');
  const cold = await entry(handleDeleteFile, realHost().save, {
    sessionId: 'cold',
    path: join(workspace, 'cold.txt'),
  });
  assert.equal(cold.status, 200);
  assert.equal(
    (await create(realHost().save, { sessionId: 'cold', name: 'cold2.txt' })).status,
    201,
  );
});

test('a created entry is checked where it landed (ancestor swapped for a symlink)', async () => {
  const policy = { mode: 'workspace-write', workspaceRoot: workspace };
  // What a mkdir through a swapped-in symlink produces: an entry that is
  // physically outside although its path reads as inside.
  mkdirSync(join(outside, 'landed'));
  assert.equal(await landedInside(policy, join(workspace, 'escape-dir', 'landed')), false);
  mkdirSync(join(workspace, 'fine'));
  assert.equal(await landedInside(policy, join(workspace, 'fine')), true);
  assert.equal(await landedInside({ ...policy, mode: 'danger-full-access' }, outside), true);
  // The undo removes exactly what the recursive mkdir created.
  mkdirSync(join(workspace, 'keep'));
  const first = join(workspace, 'keep', 'n1');
  mkdirSync(join(first, 'n2', 'n3'), { recursive: true });
  await undoMkdir(join(first, 'n2', 'n3'), first);
  assert.ok(!existsSync(first));
  assert.ok(isDir(join(workspace, 'keep')));
});

test('a rename that cannot remove the old name is undone: one name, no new folders', async () => {
  const host = realHost();
  const locked = join(workspace, 'locked');
  mkdirSync(locked);
  const file = join(locked, 'u.txt');
  writeFileSync(file, 'u');
  chmodSync(locked, 0o555); // the link succeeds, removing the old name does not
  try {
    const res = await rename(host.save, file, join(workspace, 'nf1/nf2/u.txt'));
    assert.equal(res.status, 403);
    assert.equal(readFileSync(file, 'utf8'), 'u');
    assert.ok(!existsSync(join(workspace, 'nf1')), 'created folders removed again');
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('Last-Modified is the served file, the one the Harness filesystem resolved', async () => {
  const res = await download(realHost().download, join(workspace, 'escape.txt'));
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get('last-modified'),
    statSync(join(outside, 'secret.txt')).mtime.toUTCString(),
  );
  assert.equal(
    res.headers.get('content-length'),
    String(statSync(join(outside, 'secret.txt')).size),
  );
});
