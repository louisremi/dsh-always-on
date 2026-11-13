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
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
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
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import type { DownloadContext, LiveSession, SaveContext } from '../src/context.ts';
import { handleCreateFile, handleCreateFolder } from '../src/create-route.ts';
import { handleDownload } from '../src/download-route.ts';
import { setMoveCommand } from '../src/entry.ts';
import {
  handleDeleteFile,
  handleDeleteFolder,
  handleRenameFile,
  handleRenameFolder,
  handleRestore,
} from '../src/entry-route.ts';
import { canonicalPath, landedInside, mayWrite } from '../src/fence.ts';
import { handleDownloadFolder, handleFolderSummary } from '../src/folder-route.ts';
import { undoMkdir } from '../src/paths.ts';
import { handleSave } from '../src/save-route.ts';
import { purgeTrash, slotName, slotTime, trashRelation, trashRootFor } from '../src/trash.ts';
import { walkFolder } from '../src/walk.ts';

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
  /** The session's workspace root; defaults to the fixture workspace. */
  workspaceRoot?: string;
}

/** The Harness services the routes consume, built from the real packages. */
function realHost(mode: Mode = 'workspace-write', options: HostOptions = {}) {
  const workspaceRoot = options.workspaceRoot ?? workspace;
  const policy = {
    defaultMode: mode,
    workspaceRoot,
    resolve: ({ session }: { session: LiveSession }) => ({
      mode,
      workspaceRoot,
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
    search: {
      maxResults: 512,
      maxEntries: 100000,
      graceMs: 3000,
      timeoutMs: 30000,
      stderrMaxBytes: 65536,
    },
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
  // Into the trash, not gone: same bytes, a restore token.
  const body = await res.json();
  assert.equal(readFileSync(body.trashedPath, 'utf8'), 'bye');
  assert.ok(body.trashedPath.startsWith(`${join(workspace, '.tmp', 'deleted')}/`));
  assert.equal(typeof body.restoreToken, 'string');
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

// ───────────────────── folders, trash and restore ─────────────────────

const renameFolder = (ctx: SaveContext, path: string, destination: string) =>
  entry(handleRenameFolder, ctx, { path, destination });
const removeFolder = (ctx: SaveContext, path: string) => entry(handleDeleteFolder, ctx, { path });
const restore = (ctx: SaveContext, restoreToken: unknown, sessionId = 'sess') =>
  entry(handleRestore, ctx, { sessionId, restoreToken });
const tree = (root: string) => {
  mkdirSync(join(root, 'inner', 'deep'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'A');
  writeFileSync(join(root, 'inner', 'deep', 'b.txt'), 'B');
};

test('rename.folder renames in place and moves into new parents, contents intact', async () => {
  const host = realHost();
  const from = join(workspace, 'f1');
  tree(from);
  const res = await renameFolder(host.save, from, 'f2');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).absolutePath, join(workspace, 'f2'));
  assert.ok(!existsSync(from));
  assert.equal(readFileSync(join(workspace, 'f2/inner/deep/b.txt'), 'utf8'), 'B');
  assert.equal((await renameFolder(host.save, join(workspace, 'f2'), 'p/q/f3')).status, 200);
  assert.equal(readFileSync(join(workspace, 'p/q/f3/a.txt'), 'utf8'), 'A');
  assert.equal((await renameFolder(host.save, join(workspace, 'p/q/f3'), 'f3')).status, 200);
});

test('rename.folder never replaces anything, not even an empty folder', async () => {
  const host = realHost();
  const from = join(workspace, 'g1');
  tree(from);
  mkdirSync(join(workspace, 'g-empty'));
  writeFileSync(join(workspace, 'g-file'), 'f');
  for (const taken of ['g-empty', 'g-file', 'sub', 'escape-dir']) {
    assert.equal((await renameFolder(host.save, from, taken)).status, 409, taken);
  }
  assert.ok(
    isDir(join(workspace, 'g-empty')) && readdirSync(join(workspace, 'g-empty')).length === 0,
  );
  assert.equal(readFileSync(join(from, 'a.txt'), 'utf8'), 'A');
  // Into itself is refused before moving anything.
  assert.equal((await renameFolder(host.save, from, 'g1/inner/x')).status, 400);
  assert.equal((await renameFolder(host.save, from, join(from, 'x'))).status, 400);
  assert.ok(isDir(join(from, 'inner')) && !existsSync(join(from, 'x')));
});

test('rename.folder follows the sandbox, refuses files, symlinks and the root', async () => {
  const host = realHost();
  const dir = join(workspace, 'h1');
  tree(dir);
  assert.equal((await renameFolder(realHost('read-only').save, dir, 'h2')).status, 403);
  assert.equal((await renameFolder(host.save, dir, join(outside, 'h'))).status, 403);
  assert.equal((await renameFolder(host.save, dir, 'escape-dir/h')).status, 403);
  assert.ok(!existsSync(join(outside, 'h')) && isDir(dir));
  assert.equal((await renameFolder(host.save, outside, join(workspace, 'o'))).status, 403);
  assert.equal((await renameFolder(host.save, join(workspace, 'escape-dir'), 'e')).status, 403);
  assert.equal((await renameFolder(host.save, join(dir, 'a.txt'), 'x')).status, 403);
  assert.equal((await renameFolder(host.save, workspace, join(base, 'ws2'))).status, 403);
  assert.equal((await renameFolder(host.save, join(workspace, 'nope'), 'x')).status, 404);
});

test('rename.folder without a GNU mv is a 501 and moves nothing', async () => {
  const dir = join(workspace, 'nomv');
  tree(dir);
  const previous = setMoveCommand(join(base, 'no-such-mv'));
  try {
    assert.equal((await renameFolder(realHost().save, dir, 'nomv2')).status, 501);
  } finally {
    setMoveCommand(previous);
  }
  assert.ok(isDir(dir) && !existsSync(join(workspace, 'nomv2')));
});

test('delete.folder moves empty and full folders to the trash; restore brings them back', async () => {
  const host = realHost();
  const empty = join(workspace, 'k-empty');
  mkdirSync(empty);
  const gone = await removeFolder(host.save, empty);
  assert.equal(gone.status, 200);
  assert.ok(!existsSync(empty));
  const full = join(workspace, 'k-full');
  tree(full);
  // A symlink inside pointing outside: moved as a link, its target untouched.
  symlinkSync(join(outside, 'secret.txt'), join(full, 'link'));
  const res = await removeFolder(host.save, full);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(!existsSync(full));
  assert.equal(readFileSync(join(body.trashedPath, 'inner/deep/b.txt'), 'utf8'), 'B');
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret\n');
  const back = await restore(host.save, body.restoreToken);
  assert.equal(back.status, 200);
  assert.deepEqual(await back.json(), { absolutePath: full, kind: 'folder' });
  assert.equal(readFileSync(join(full, 'a.txt'), 'utf8'), 'A');
  assert.ok(!existsSync(dirname(body.trashedPath)), 'the empty slot goes too');
  // A token is single-use.
  assert.equal((await restore(host.save, body.restoreToken)).status, 404);
});

test('restore: tokens are per session, never replace, recreate parents', async () => {
  const host = realHost();
  mkdirSync(join(workspace, 'r-parent'));
  const file = join(workspace, 'r-parent', 'r.txt');
  writeFileSync(file, 'one');
  const { restoreToken } = await (await remove(host.save, file)).json();
  assert.equal((await restore(host.save, restoreToken, 'cold')).status, 404);
  assert.equal((await restore(host.save, 'made-up')).status, 404);
  assert.equal((await restore(host.save, 42)).status, 404);
  // The name is taken again: refused, the deleted file stays in the trash.
  writeFileSync(file, 'two');
  assert.equal((await restore(host.save, restoreToken)).status, 409);
  assert.equal(readFileSync(file, 'utf8'), 'two');
  rmSync(join(workspace, 'r-parent'), { recursive: true });
  // The parent folder is gone: recreated.
  assert.equal((await restore(host.save, restoreToken)).status, 200);
  assert.equal(readFileSync(file, 'utf8'), 'one');
  // A session that became read-only cannot restore.
  const again = await (await remove(host.save, file)).json();
  assert.equal((await restore(realHost('read-only').save, again.restoreToken)).status, 403);
  assert.ok(!existsSync(file));
});

test('delete.folder follows the sandbox and protects the root and the trash', async () => {
  const host = realHost();
  const dir = join(workspace, 'l1');
  tree(dir);
  assert.equal((await removeFolder(realHost('read-only').save, dir)).status, 403);
  assert.equal((await removeFolder(host.save, outside)).status, 403);
  assert.equal((await removeFolder(host.save, join(workspace, 'escape-dir'))).status, 403);
  assert.ok(existsSync(join(workspace, 'escape-dir')) && existsSync(join(outside, 'secret.txt')));
  assert.equal((await removeFolder(host.save, join(dir, 'a.txt'))).status, 403);
  assert.equal((await remove(host.save, dir)).status, 403);
  assert.equal((await removeFolder(host.save, workspace)).status, 403);
  // The trash, or a folder holding it, cannot be deleted through the routes.
  const trashed = (await (await removeFolder(host.save, dir)).json()).trashedPath;
  assert.equal((await removeFolder(host.save, trashed)).status, 403);
  assert.equal((await removeFolder(host.save, join(workspace, '.tmp'))).status, 403);
  assert.equal((await removeFolder(host.save, join(workspace, '.tmp/deleted'))).status, 403);
  assert.ok(isDir(trashed));
});

test('a trash that is a symlink is refused: nothing is deleted', async () => {
  const root = join(base, 'symtrash');
  mkdirSync(root);
  mkdirSync(join(outside, 'fake-tmp'));
  symlinkSync(join(outside, 'fake-tmp'), join(root, '.tmp'));
  writeFileSync(join(root, 'v.txt'), 'v');
  const host = realHost('workspace-write', { extraRoots: [root] }).save;
  assert.equal((await remove(host, join(root, 'v.txt'))).status, 403);
  assert.equal(readFileSync(join(root, 'v.txt'), 'utf8'), 'v');
  assert.deepEqual(readdirSync(join(outside, 'fake-tmp')), []);
});

/**
 * A real mount point this process may write in: another filesystem than the
 * fixtures', and the top of that filesystem — which is exactly what makes a
 * path's `st_dev` differ from its parent's, like a volume mounted inside a
 * workspace. Nothing can be mounted in CI, but every Linux box has one.
 */
const volume = ((): string | undefined => {
  for (const candidate of ['/dev/shm', '/tmp', '/run', '/var/tmp']) {
    try {
      const real = realpathSync(candidate);
      accessSync(real, constants.W_OK);
      if (statSync(real).dev === statSync(fixtures).dev) continue;
      if (statSync(dirname(real)).dev === statSync(real).dev) continue;
      return real;
    } catch {
      /* not there, or not writable */
    }
  }
  return undefined;
})();

test('a delete on a volume mounted inside the workspace trashes it on that volume, as a rename', {
  skip: volume === undefined && 'no second filesystem to stand in for a mount',
}, async () => {
  const mount = join(volume as string, `.dlf-mount-${process.pid}`);
  const madeTemp = !existsSync(join(volume as string, '.tmp'));
  mkdirSync(join(mount, 'dir'), { recursive: true });
  writeFileSync(join(mount, 'x.txt'), 'x');
  writeFileSync(join(mount, 'dir', 'y.txt'), 'y');
  // With `/` as the workspace root, `mount` is a mount inside the workspace.
  const host = realHost('workspace-write', { workspaceRoot: '/' }).save;
  const trash = join(volume as string, '.tmp', 'deleted');
  try {
    const file = await remove(host, join(mount, 'x.txt'));
    assert.equal(file.status, 200);
    const body = await file.json();
    assert.ok(
      body.trashedPath.startsWith(`${trash}/`),
      `trashed onto the volume itself, not copied into the workspace: ${body.trashedPath}`,
    );
    assert.equal(readFileSync(body.trashedPath, 'utf8'), 'x');
    assert.ok(!existsSync(join(mount, 'x.txt')));
    // Restore is a rename back, onto the same volume.
    assert.equal((await restore(host, body.restoreToken)).status, 200);
    assert.equal(readFileSync(join(mount, 'x.txt'), 'utf8'), 'x');
    // A whole folder of the volume too.
    const folder = await removeFolder(host, join(mount, 'dir'));
    assert.equal(folder.status, 200);
    const trashedFolder = (await folder.json()).trashedPath;
    assert.ok(trashedFolder.startsWith(`${trash}/`), trashedFolder);
    assert.equal(readFileSync(join(trashedFolder, 'y.txt'), 'utf8'), 'y');
    assert.ok(!existsSync(join(mount, 'dir')));
    // The trash of the volume is protected like the workspace's.
    assert.equal((await removeFolder(host, trashedFolder)).status, 403);
    assert.equal((await removeFolder(host, join(volume as string, '.tmp'))).status, 403);
    // The mount point itself cannot be trashed: it can move nowhere on its
    // own filesystem, and copying a whole volume is not a delete.
    const policy = { mode: 'workspace-write', workspaceRoot: '/' };
    await assert.rejects(trashRootFor(policy, volume as string), { code: 'EBUSY' });
    assert.equal(await trashRelation(policy, join(volume as string, '.tmp')), 'holds');
    assert.equal(await trashRelation(policy, trashedFolder), 'inside');
    assert.equal(await trashRelation(policy, join(mount, 'x.txt')), 'none');
    assert.ok(existsSync(volume as string), 'the mount point is still there');
  } finally {
    rmSync(mount, { recursive: true, force: true });
    if (madeTemp) rmSync(join(volume as string, '.tmp'), { recursive: true, force: true });
  }
});

test('a delete outside every root in danger mode still lands in the workspace trash', {
  skip: volume === undefined && 'no second filesystem',
}, async () => {
  // No mount here: the entry is on another filesystem AND outside the root,
  // where the plugin has no directory of its own to put a trash in.
  const mount = join(volume as string, `.dlf-outside-${process.pid}`);
  mkdirSync(mount);
  writeFileSync(join(mount, 'z.txt'), 'z');
  const host = realHost('danger-full-access').save;
  try {
    const res = await remove(host, join(mount, 'z.txt'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.trashedPath.startsWith(`${join(workspace, '.tmp', 'deleted')}/`));
    assert.equal(readFileSync(body.trashedPath, 'utf8'), 'z');
  } finally {
    rmSync(mount, { recursive: true, force: true });
  }
});

test('purgeTrash removes old slots only, never following symlinks', async () => {
  const trash = join(base, 'purge', '.tmp', 'deleted');
  const now = Date.UTC(2026, 10, 13, 12, 0, 0);
  const old = slotName(new Date(now - 31 * 86400_000));
  const young = slotName(new Date(now - 29 * 86400_000));
  assert.equal(slotTime(old), Math.floor((now - 31 * 86400_000) / 1000) * 1000);
  assert.equal(slotTime('not-a-slot'), undefined);
  mkdirSync(join(trash, old, 'dir', 'deep'), { recursive: true });
  writeFileSync(join(trash, old, 'dir', 'deep', 'f'), 'f');
  symlinkSync(outside, join(trash, old, 'dir', 'out'));
  mkdirSync(join(trash, young));
  mkdirSync(join(trash, '19990101T000000Z-foreign'));
  const removed = await purgeTrash(trash, now);
  assert.deepEqual(removed, [old]);
  assert.deepEqual(readdirSync(trash).sort(), ['19990101T000000Z-foreign', young].sort());
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret\n');
  assert.deepEqual(await purgeTrash(join(base, 'no-trash'), now), []);
});

// ─────────────────────── folder summary / download ───────────────────────

const getFolder = (handle: typeof handleFolderSummary, path: string, method = 'GET') =>
  handle(
    realHost().download,
    new Request(`http://x/api/folder?path=${encodeURIComponent(path)}`, { method }),
  );

/** Members of a ZIP read through its central directory: name → bytes (folders: null). */
function unzip(zip: Buffer): Map<string, Buffer | null> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer | null>();
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    assert.ok(flags & 0x0800, 'UTF-8 names');
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    if (name.endsWith('/')) {
      out.set(name, null);
    } else {
      const raw = zip.subarray(start, start + compressed);
      const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
      assert.equal(data.length, size, `${name} size`);
      assert.equal(crc32Of(data), crc, `${name} crc`);
      out.set(name, data);
    }
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

function crc32Of(data: Buffer): number {
  let c = ~0 >>> 0;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

test('folder.summary counts files, folders and bytes without following symlinks', async () => {
  const dir = join(workspace, 'sum');
  tree(dir);
  symlinkSync(outside, join(dir, 'out'));
  const res = await getFolder(handleFolderSummary, dir);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    files: 2,
    folders: 2,
    bytes: 2,
    truncated: false,
    mounts: [],
    downloadable: true,
  });
  assert.equal((await getFolder(handleFolderSummary, join(dir, 'a.txt'))).status, 403);
  assert.equal((await getFolder(handleFolderSummary, join(workspace, 'nope'))).status, 404);
  assert.equal((await getFolder(handleFolderSummary, 'rel')).status, 400);
});

/** A folder with a volume mounted right inside it: `/dev` and its `pts`, on most Linux boxes. */
const holder = ((): { root: string; mounts: string[] } | undefined => {
  for (const root of ['/dev', '/run']) {
    try {
      const dev = statSync(root).dev;
      const mounts = readdirSync(root)
        .filter((n) => {
          const info = lstatSync(join(root, n));
          return info.isDirectory() && info.dev !== dev;
        })
        .sort();
      if (mounts.length > 0) return { root, mounts };
    } catch {
      /* not there, or not readable */
    }
  }
  return undefined;
})();

test('a folder walk names the volumes mounted inside it', {
  skip: holder === undefined && 'no folder with a mount inside it',
}, async () => {
  const { root, mounts } = holder as { root: string; mounts: string[] };
  const walk = await walkFolder(root, { maxEntries: 2000, maxBytes: Number.MAX_SAFE_INTEGER });
  for (const mount of mounts) assert.ok(walk.mounts.includes(mount), `${mount} is a mount`);
  // Folders on the same filesystem as their parent are not mounts.
  const plain = await walkFolder(workspace, { maxEntries: 2000, maxBytes: 1e12 });
  assert.deepEqual(plain.mounts, []);
});

test('download.folder streams a valid zip: names, bytes, empty folders, no symlinks', async () => {
  const dir = join(workspace, 'zipme');
  tree(dir);
  mkdirSync(join(dir, 'empty'));
  writeFileSync(join(dir, 'héllo wörld.txt'), 'ünïcode');
  const big = Buffer.alloc(3 << 20);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7919) % 251;
  writeFileSync(join(dir, 'big.bin'), big);
  symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak'));
  const res = await getFolder(handleDownloadFolder as typeof handleFolderSummary, dir);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition') ?? '', /filename="zipme\.zip"/);
  const zip = Buffer.from(await res.arrayBuffer());
  const members = unzip(zip);
  assert.equal(members.get('zipme/a.txt')?.toString(), 'A');
  assert.equal(members.get('zipme/inner/deep/b.txt')?.toString(), 'B');
  assert.equal(members.get('zipme/héllo wörld.txt')?.toString(), 'ünïcode');
  assert.ok(members.get('zipme/big.bin')?.equals(big));
  assert.ok(members.has('zipme/empty/') && members.has('zipme/inner/'));
  assert.ok(!members.has('zipme/leak'), 'symlinks are left out');
  assert.match(members.get('zipme/DOWNLOAD-SKIPPED.txt')?.toString() ?? '', /^leak$/m);
  assert.ok(![...members.values()].some((data) => data?.toString().includes('secret')));
  const head = await getFolder(handleDownloadFolder as typeof handleFolderSummary, dir, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('download.folder refuses folders over the limits with 413, files with 403', async () => {
  const dir = join(workspace, 'zipbig');
  tree(dir);
  const request = () => new Request(`http://x/api/download.folder?path=${encodeURIComponent(dir)}`);
  const host = realHost().download;
  assert.equal(
    (await handleDownloadFolder(host, request(), { maxEntries: 3, maxBytes: 1e9 })).status,
    413,
  );
  assert.equal(
    (await handleDownloadFolder(host, request(), { maxEntries: 99, maxBytes: 1 })).status,
    413,
  );
  assert.equal(
    (await handleDownloadFolder(host, request(), { maxEntries: 4, maxBytes: 2 })).status,
    200,
  );
  assert.equal(
    (await getFolder(handleDownloadFolder as typeof handleFolderSummary, join(dir, 'a.txt')))
      .status,
    403,
  );
});
