/**
 * A small streaming ZIP writer, so a folder downloads as one `.zip` without
 * a runtime dependency. Files are deflated (`zlib`) as they stream and their
 * sizes and CRC follow in a data descriptor, so nothing is buffered whole.
 * Plain ZIP32: the caller keeps archives under 4 GiB and 65,535 entries
 * (see FOLDER_LIMITS); {@link zipStream} errors rather than write a broken
 * archive past that. Names are UTF-8 (general-purpose flag bit 11).
 */
import { pipeline, type Readable, Transform } from 'node:stream';
import * as zlib from 'node:zlib';
import type { EntryKind } from './paths.ts';

/** One archive member: a folder (no content) or a file whose bytes `open()` streams. */
export interface ZipMember {
  /** `/`-separated path inside the archive; folders without the trailing `/`. */
  name: string;
  type: EntryKind;
  mtime: Date;
  /** Unix permission bits (e.g. 0o644); kept in the external attributes. */
  mode?: number | undefined;
  /** File content; may throw before yielding to leave the file out. */
  open?: () => Promise<Readable>;
}

/** CRC-32 (IEEE), continuing from `crc`: Node's `zlib.crc32`. */
export function crc32(data: Uint8Array, crc = 0): number {
  return zlib.crc32(data, crc);
}

/** MS-DOS date and time fields (local time, 2-second precision, from 1980). */
function dosTime(date: Date): { time: number; date: number } {
  const d = Number.isNaN(date.getTime()) || date.getFullYear() < 1980 ? new Date(1980, 0, 1) : date;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.min(d.getFullYear(), 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const UTF8 = 0x0800;
const DESCRIPTOR = 0x0008;
const MAX32 = 0xffffffff;

/** What the central directory repeats about one member once it is written. */
interface ZipRecord {
  name: Uint8Array;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  size: number;
  external: number;
  offset: number;
}

function localHeader(record: ZipRecord): Uint8Array {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(record.flags, 6);
  b.writeUInt16LE(record.method, 8);
  b.writeUInt16LE(record.time, 10);
  b.writeUInt16LE(record.date, 12);
  // CRC and sizes: 0 here, in the data descriptor for streamed files.
  b.writeUInt16LE(record.name.length, 26);
  return Buffer.concat([b, record.name]);
}

function dataDescriptor(record: ZipRecord): Uint8Array {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(record.crc, 4);
  b.writeUInt32LE(record.compressed, 8);
  b.writeUInt32LE(record.size, 12);
  return b;
}

function centralHeader(record: ZipRecord): Uint8Array {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, ZIP 2.0
  b.writeUInt16LE(20, 6);
  b.writeUInt16LE(record.flags, 8);
  b.writeUInt16LE(record.method, 10);
  b.writeUInt16LE(record.time, 12);
  b.writeUInt16LE(record.date, 14);
  b.writeUInt32LE(record.crc, 16);
  b.writeUInt32LE(record.compressed, 20);
  b.writeUInt32LE(record.size, 24);
  b.writeUInt16LE(record.name.length, 28);
  b.writeUInt32LE(record.external >>> 0, 38);
  b.writeUInt32LE(record.offset, 42);
  return Buffer.concat([b, record.name]);
}

function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(size, 12);
  b.writeUInt32LE(offset, 16);
  return b;
}

/** `source` deflated, with the raw CRC and size counted on the way. */
function deflated(source: Readable, counts: { crc: number; size: number }): Readable {
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      counts.crc = crc32(chunk, counts.crc);
      counts.size += chunk.length;
      done(null, chunk);
    },
  });
  return pipeline(source, count, zlib.createDeflateRaw(), () => undefined) as unknown as Readable;
}

/**
 * The archive of `members`, chunk by chunk. A member whose `open()` throws is
 * left out and reported to `skip`; a read error after a file started fails
 * the archive.
 */
export async function* zipStream(
  members: AsyncIterable<ZipMember> | Iterable<ZipMember>,
  skip: (name: string, error: unknown) => void = () => undefined,
): AsyncGenerator<Uint8Array> {
  const written: ZipRecord[] = [];
  let offset = 0;
  const emit = (chunk: Uint8Array) => {
    offset += chunk.length;
    if (offset > MAX32) throw new Error('archive too large for ZIP32');
    return chunk;
  };
  for await (const member of members) {
    if (written.length >= 0xffff) throw new Error('too many entries for ZIP32');
    const folder = member.type === 'folder';
    let source: Readable | undefined;
    if (!folder) {
      try {
        if (member.open === undefined) throw new Error('no content');
        source = await member.open();
      } catch (error) {
        skip(member.name, error);
        continue;
      }
    }
    const mode = member.mode ?? (folder ? 0o755 : 0o644);
    const record: ZipRecord = {
      name: Buffer.from(folder ? `${member.name}/` : member.name, 'utf8'),
      flags: folder ? UTF8 : UTF8 | DESCRIPTOR,
      method: folder ? 0 : 8,
      ...dosTime(member.mtime),
      crc: 0,
      compressed: 0,
      size: 0,
      external: (((folder ? 0o040000 : 0o100000) | (mode & 0o7777)) << 16) | (folder ? 0x10 : 0),
      offset,
    };
    yield emit(localHeader(record));
    if (source !== undefined) {
      const counts = { crc: 0, size: 0 };
      for await (const chunk of deflated(source, counts)) {
        record.compressed += chunk.length;
        yield emit(chunk);
      }
      if (counts.size > MAX32) throw new Error('file too large for ZIP32');
      record.crc = counts.crc;
      record.size = counts.size;
      yield emit(dataDescriptor(record));
    }
    written.push(record);
  }
  const start = offset;
  for (const record of written) yield emit(centralHeader(record));
  yield emit(endOfCentralDirectory(written.length, offset - start, start));
}
