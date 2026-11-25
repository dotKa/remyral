import { crc32, deflateRawSync } from 'node:zlib';

/** A minimal ZIP writer for extractor tests (store / deflate, Unix modes, symlinks, optional bad CRC). */
export interface ZipFixtureEntry {
  readonly name: string;
  readonly data?: Buffer | string;
  readonly mode?: number;
  readonly symlink?: string;
  readonly deflate?: boolean;
  /** Corrupt the recorded CRC. */
  readonly badCrc?: boolean;
  /** Declared size differs from the real one. */
  readonly lieSize?: number;
}

export function buildZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const isDir = e.name.endsWith('/');
    const raw =
      e.symlink !== undefined
        ? Buffer.from(e.symlink)
        : Buffer.isBuffer(e.data)
          ? e.data
          : Buffer.from(e.data ?? '', 'utf8');
    const compressed = e.deflate === true ? deflateRawSync(raw) : raw;
    const method = e.deflate === true ? 8 : 0;
    const crc = (crc32(raw) ^ (e.badCrc === true ? 1 : 0)) >>> 0;
    const name = Buffer.from(e.name, 'utf8');
    const size = e.lieSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    const type = e.symlink !== undefined ? 0o120000 : isDir ? 0o040000 : 0o100000;
    const mode = (type | (e.mode ?? (isDir ? 0o755 : 0o644))) >>> 0;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
