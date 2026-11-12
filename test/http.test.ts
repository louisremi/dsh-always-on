import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FetchRoute } from '../src/context.ts';
import {
  failureStatus,
  failWith,
  handlePost,
  jsonObject,
  mutationStatus,
  registerRoute,
} from '../src/http.ts';

const fail = failWith({ 409: 'taken' }, 'nope');
const coded = (code: string) => Object.assign(new Error(code), { code });

test('failWith: explicit message, then the route default, then the fallback', async () => {
  assert.deepEqual(await fail(400, 'why').json(), { error: 'why' });
  assert.deepEqual(await fail(409).json(), { error: 'taken' });
  const res = fail(500);
  assert.deepEqual(await res.json(), { error: 'nope' });
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('jsonObject accepts only a JSON object', async () => {
  const body = (text: string) => new Request('http://x/', { method: 'POST', body: text });
  assert.deepEqual(await jsonObject(body('{"a":1}'), fail), { a: 1 });
  for (const bad of ['{nope', '[]', 'null', '3']) {
    const res = await jsonObject(body(bad), fail);
    assert.ok(res instanceof Response && res.status === 400, bad);
  }
});

test('handlePost: 405 for other methods, 499 when cancelled, statusOf otherwise', async () => {
  const ok = async () => new Response('ok');
  assert.equal((await handlePost(new Request('http://x/'), fail, failureStatus, ok)).status, 405);
  const post = (signal?: AbortSignal) => new Request('http://x/', { method: 'POST', signal });
  assert.equal((await handlePost(post(), fail, failureStatus, ok)).status, 200);
  const boom = async () => {
    throw coded('EEXIST');
  };
  assert.equal((await handlePost(post(), fail, mutationStatus, boom)).status, 409);
  assert.equal((await handlePost(post(), fail, failureStatus, boom)).status, 500);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await handlePost(post(aborted.signal), fail, mutationStatus, boom)).status, 499);
});

test('status mappings: Harness codes, then Node codes for mutations', () => {
  assert.equal(failureStatus(coded('FS_SANDBOX_DENIED')), 403);
  assert.equal(failureStatus({ remote: { code: 'workspace-file/not-found' } }), 404);
  assert.equal(failureStatus(coded('FS_STALE_VERSION')), 409);
  for (const code of ['EACCES', 'EPERM', 'EROFS']) assert.equal(mutationStatus(coded(code)), 403);
  assert.equal(mutationStatus(coded('ENOENT')), 404);
  assert.equal(mutationStatus(coded('FS_SANDBOX_DENIED')), 403);
  assert.equal(mutationStatus(new Error('?')), 500);
});

test('registerRoute registers, aborts in-flight requests and awaits them on dispose', async () => {
  let route: FetchRoute | undefined;
  let removed = false;
  let sawAbort = false;
  const ctx = {
    connection: {
      fetch: {
        register(r: FetchRoute) {
          route = r;
          return () => {
            removed = true;
          };
        },
      },
    },
  };
  const dispose = registerRoute(ctx, {
    path: '/api/x',
    methods: ['POST'],
    handle: (_ctx, request) =>
      new Promise<Response>((resolve) => {
        request.signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve(new Response(null, { status: 499 }));
        });
      }),
  });
  assert.ok(route);
  assert.equal(route.path, '/api/x');
  assert.deepEqual(route.methods, ['POST']);
  assert.equal(route.requestBody, 'buffered');
  const inFlight = route.fetch(new Request('http://x/api/x', { method: 'POST' }));
  await dispose();
  assert.ok(removed && sawAbort);
  assert.equal((await inFlight).status, 499);
});
