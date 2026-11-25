import { crc32 } from 'node:zlib';

/**
 * p6-outputs: a minimal streaming ZIP writer (PKZIP APPNOTE 6.3.x, "stored" entries, UTF-8 names, no ZIP64).
 * Entries are produced one at a time, so the master holds at most one file's content in memory while the archive
 * streams out. The caller bounds the total size far below the 4 GiB ZIP32 limit (LIMITS.zipBytesMax).
 */

export interface ZipEntry {
  /** Path inside the archive ("/"-separated, already sanitised by {@link zipPath}). */
  readonly name: string;
  readonly data: Buffer;
  readonly modified: Date;
}

const ZIP32_MAX = 0xffff_ffff;
/** Control characters and the characters Windows refuses in file names. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f:*?"<>|]/g;

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * A safe archive path from an (untrusted) file name: no absolute paths, no `..` / `.` segments, no backslashes or
 * control characters (zip-slip on extraction), at most 8 segments of ≤ 100 characters.
 */
export function zipPath(prefix: string, name: string): string {
  const segments = `${prefix}/${name}`
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.replace(UNSAFE, '_').trim())
    .filter((s) => s !== '' && s !== '.' && s !== '..')
    .map((s) => (s.length > 100 ? s.slice(0, 100) : s));
  const kept = segments.length > 8 ? [...segments.slice(0, 7), segments.slice(7).join('_')] : segments;
  return kept.length === 0 ? 'file' : kept.join('/');
}

/** Makes every path unique ("a.md", "a (2).md", …). */
export function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.map((p) => {
    let candidate = p;
    for (let i = 2; seen.has(candidate.toLowerCase()); i += 1) {
      const dot = p.lastIndexOf('.');
      const slash = p.lastIndexOf('/');
      candidate =
        dot > slash + 1 ? `${p.slice(0, dot)} (${String(i)})${p.slice(dot)}` : `${p} (${String(i)})`;
    }
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}

/** Streams a ZIP archive of the entries the iterator yields (each entry is written as soon as it arrives). */
export async function* zipStream(entries: AsyncIterable<ZipEntry>): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  for await (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data) >>> 0;
    const size = e.data.length;
    if (size > ZIP32_MAX || offset > ZIP32_MAX) throw new Error('zip archive too large for ZIP32');
    const { time, date } = dosTime(e.modified);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // made by: MS-DOS, 2.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    // extra, comment, disk number, internal / external attributes: 0
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    yield Buffer.concat([local, name]);
    yield e.data;
    offset += 30 + name.length + size;
    count += 1;
    if (count > 0xffff) throw new Error('too many zip entries');
  }
  const cdBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cdBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  yield cdBytes;
  yield end;
}
