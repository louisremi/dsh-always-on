/** Limits the client and the README repeat, since the classic-script client cannot import them. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FOLDER_LIMITS } from '../src/folder-route.ts';
import { MAX_UPLOAD_BYTES } from '../src/upload-route.ts';

test('the folder limits the client shows and the README states are the server ones', () => {
  const client = readFileSync(join(import.meta.dirname, '../src/client.ts'), 'utf8');
  const readme = readFileSync(join(import.meta.dirname, '../README.md'), 'utf8');
  const files = FOLDER_LIMITS.maxEntries.toLocaleString('en-US');
  const size = `${FOLDER_LIMITS.maxBytes / 1024 ** 3} GiB`;
  assert.match(
    client,
    new RegExp(`const FOLDER_LIMITS = \\{ files: '${files}', size: '${size}' \\}`),
    'src/client.ts FOLDER_LIMITS',
  );
  assert.ok(readme.includes(`${files} entries and ${size}`), 'README');
});

test('the upload limit the client shows and the README states is the server one', () => {
  const client = readFileSync(join(import.meta.dirname, '../src/client.ts'), 'utf8');
  const readme = readFileSync(join(import.meta.dirname, '../README.md'), 'utf8');
  const gib = MAX_UPLOAD_BYTES / 1024 ** 3;
  const size = `${gib} GiB`;
  assert.ok(
    client.includes(`const UPLOAD_MAX_BYTES = ${gib} * 1024 ** 3;`),
    'src/client.ts UPLOAD_MAX_BYTES',
  );
  assert.ok(readme.includes(`up to ${size} each`), 'README');
  // Both locale strings name the same size: a stale one would misinform half the users.
  assert.ok(client.includes(`'upload.tooLarge': '{n} too large (${size} at most).'`), 'en');
  assert.ok(client.includes(`'upload.tooLarge': '{n} 个太大（最大 ${size}）。'`), 'zh');
});
