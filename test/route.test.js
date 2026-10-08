import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleDownload, contentDisposition, registerDownloadRoute, CHUNK_BYTES } from '../src/download-route.js';

const dir = mkdtempSync(join(tmpdir(), 'dlf-'));
const big = join(dir, 'big file é.bin');
const bigBytes = Buffer.alloc(CHUNK_BYTES * 2 + 123, 7);
bigBytes[0] = 1; bigBytes[bigBytes.length - 1] = 9;
writeFileSync(big, bigBytes);
mkdirSync(join(dir, 'sub'));

function denied() { return Object.assign(new Error('denied'), { code: 'FS_SANDBOX_DENIED' }); }

/** A fake Host context backed by the real filesystem. */
function fakeCtx(extra = {}) {
  const fs = {
    processPathFromHostPath: (p) => (p.startsWith('/etc/') ? undefined : p),
    async resolve(p) {
      if (p.startsWith('/forbidden')) throw denied();
      return { displayPath: p };
    },
    async stat(t) {
      try {
        const s = statSync(t.displayPath);
        return { type: s.isFile() ? 'file' : 'directory', size: s.size };
      } catch { return undefined; }
    },
    async readByteRange(t, { offset, length }) {
      const fd = openSync(t.displayPath, 'r');
      try {
        const buf = Buffer.alloc(length);
        const n = readSync(fd, buf, 0, length, offset);
        return buf.subarray(0, n);
      } finally { closeSync(fd); }
    },
  };
  return {
    fs,
    sandboxPolicy: { workspaceRoot: dir },
    sessionQuery: {
      async readEvent() {
        return {
          target: { type: 'deliverables/presented', data: { files: [{ path: 'big file é.bin' }] } },
          session: { cwd: dir },
        };
      },
    },
    workspaceFiles: { async stat(_scope, path) { return { absolutePath: join(dir, path) }; } },
    workspaceChanges: {
      summary: (id, seq) => (seq === 1 ? { cwd: dir, files: [{ path: 'big file é.bin' }] } : undefined),
    },
    ...extra,
  };
}

const get = (ctx, query, method = 'GET') =>
  handleDownload(ctx, new Request(`http://x/api/download.file?${query}`, { method }));
const q = (o) => new URLSearchParams(o).toString();

test('streams a multi-chunk file by path with attachment headers', async () => {
  const res = await get(fakeCtx(), q({ path: big }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(bigBytes.length));
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="big file _\.bin"; filename\*=UTF-8''big%20file%20%C3%A9\.bin$/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bigBytes);
});

test('HEAD returns headers and no body', async () => {
  const res = await get(fakeCtx(), q({ path: big }), 'HEAD');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(bigBytes.length));
  assert.equal(await res.text(), '');
});

test('present and changes coordinates resolve the file server-side', async () => {
  for (const source of ['present', 'changes']) {
    const res = await get(fakeCtx(), q({ source, sessionId: 's', seq: '1', index: '0' }));
    assert.equal(res.status, 200, source);
    assert.equal((await res.arrayBuffer()).byteLength, bigBytes.length);
  }
});

test('error statuses', async () => {
  const ctx = fakeCtx();
  assert.equal((await get(ctx, q({ path: join(dir, 'nope') }))).status, 404);
  assert.equal((await get(ctx, q({ path: join(dir, 'sub') }))).status, 403);
  assert.equal((await get(ctx, q({ path: '/forbidden/x' }))).status, 403);
  assert.equal((await get(ctx, q({ path: 'relative' }))).status, 400);
  assert.equal((await get(ctx, '')).status, 400);
  assert.equal((await get(ctx, q({ path: '/etc/passwd' }))).status, 422);
  assert.equal((await get(ctx, q({ source: 'present', sessionId: 's', seq: 'x', index: '0' }))).status, 400);
  assert.equal((await get(ctx, q({ source: 'changes', sessionId: 's', seq: '2', index: '0' }))).status, 404);
  assert.equal((await get(ctx, q({ source: 'nope', sessionId: 's', seq: '1', index: '0' }))).status, 400);
});

test('contentDisposition strips separators, quotes and control characters', () => {
  const v = contentDisposition('a/b"c\n;d.txt');
  assert.ok(!/[\n/]/.test(v.split(';')[1]));
  assert.match(v, /^attachment; filename="a_b_c_;?/);
  assert.equal(contentDisposition(''), 'attachment; filename="download"; filename*=UTF-8\'\'download');
});

test('registerDownloadRoute registers GET/HEAD and disposes', async () => {
  let route; let removed = false;
  const ctx = fakeCtx({
    connection: { fetch: { register(r) { route = r; return () => { removed = true; }; } } },
  });
  const dispose = registerDownloadRoute(ctx);
  assert.equal(route.path, '/api/download.file');
  assert.deepEqual(route.methods, ['GET', 'HEAD']);
  const res = await route.fetch(new Request(`http://x/api/download.file?${q({ path: big })}`));
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  await dispose();
  assert.ok(removed);
});
