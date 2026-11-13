import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import * as zlib from 'node:zlib';
import { crc32, crc32Fallback, type ZipMember, zipStream } from '../src/zip.ts';

test('the CRC-32 fallback matches the native one', () => {
  const data = Buffer.from('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32Fallback(data), 0x414fa339);
  assert.equal(crc32Fallback(data.subarray(10), crc32Fallback(data.subarray(0, 10))), 0x414fa339);
  assert.equal(crc32(data), 0x414fa339);
  const native = (zlib as { crc32?: (d: Uint8Array) => number }).crc32;
  if (native) assert.equal(crc32Fallback(Buffer.alloc(1000, 7)), native(Buffer.alloc(1000, 7)));
});

test('a member that cannot be opened is skipped, the archive stays valid', async () => {
  const members: ZipMember[] = [
    { name: 'd', type: 'folder', mtime: new Date(2020, 1, 2, 3, 4, 6) },
    {
      name: 'd/ok.txt',
      type: 'file',
      mtime: new Date(),
      open: async () => Readable.from([Buffer.from('ok')]),
    },
    {
      name: 'd/bad.txt',
      type: 'file',
      mtime: new Date(),
      open: async () => {
        throw new Error('nope');
      },
    },
    {
      name: 'd/old.txt',
      type: 'file',
      mtime: new Date(1970, 0, 1),
      open: async () => Readable.from([]),
    },
  ];
  const skipped: string[] = [];
  const chunks: Uint8Array[] = [];
  for await (const chunk of zipStream(members, (name) => skipped.push(name))) chunks.push(chunk);
  assert.deepEqual(skipped, ['d/bad.txt']);
  mkdirSync(join(import.meta.dirname, '.fixtures'), { recursive: true });
  const dir = mkdtempSync(join(import.meta.dirname, '.fixtures', 'zip-'));
  try {
    const file = join(dir, 'a.zip');
    writeFileSync(file, Buffer.concat(chunks));
    let listing: string;
    try {
      listing = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' });
      execFileSync('unzip', ['-tq', file]);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return; // no unzip here
      throw error;
    }
    assert.deepEqual(listing.trim().split('\n'), ['d/', 'd/ok.txt', 'd/old.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
