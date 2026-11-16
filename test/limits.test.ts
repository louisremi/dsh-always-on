/** Limits the client and the README repeat, since the classic-script client cannot import them. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FOLDER_LIMITS } from '../src/folder-route.ts';

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
