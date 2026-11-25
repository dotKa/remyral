import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';

/**
 * p17-output-limits (docs/design/p17-output-limits.md §6): "Hepsini indir (zip)" — a job's outputs streamed as one zip
 * while it is read from the blob store, never assembled in memory or on disk. Entries are stored (no compression: most
 * outputs are already compressed, and the master stays cheap) with a data descriptor (bit 3: the CRC-32 is known only
 * after the bytes went out); sizes come from the rows and are checked while streaming — a blob of another size ends
 * the archive with an error instead of a corrupt entry. No ZIP64: the caller bounds the archive below 4 GiB and the
 * entry count below 65 535.
 */

export interface ArchiveSource {
  /** Path inside the archive (unique; the caller resolves duplicates). */
  readonly name: string;
  readonly sizeBytes: number;
  readonly open: () => Promise<Buffer | Readable>;
  /**
   * p18-outputs-delivery: the CRC-32 the bytes must have (an entry unpacked from the overflow zip carries its own);
   * another CRC ends the archive with an error instead of a corrupt entry.
   */
  readonly crc32?: number;
}

/** Bytes of the archive around the files' own bytes (headers, descriptors, central directory, end record). */
export function archiveOverhead(names: readonly string[]): number {
  return names.reduce((n, name) => n + 30 + 16 + 46 + 2 * Buffer.byteLength(name, 'utf8'), 22);
}

/** Largest archive this writer produces (classic zip offsets and sizes are 32-bit). */
export const ARCHIVE_MAX_BYTES = 0xffffffff;

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** `name`, or `name (2).ext`, … when an earlier entry took it. */
export function uniqueName(name: string, taken: Set<string>): string {
  let n = name;
  for (let i = 2; taken.has(n); i++) {
    const slash = name.lastIndexOf('/');
    const dot = name.lastIndexOf('.');
    n = dot > slash + 1 ? `${name.slice(0, dot)} (${String(i)})${name.slice(dot)}` : `${name} (${String(i)})`;
  }
  taken.add(n);
  return n;
}

/**
 * `close` (p18-outputs-delivery) runs once when the archive ends, fails or is abandoned by the reader (it releases the
 * overflow zip's store stream that the unpacked entries read from).
 */
export function streamArchive(
  entries: readonly ArchiveSource[],
  at: Date = new Date(),
  close?: () => void,
): Readable {
  const { time, date } = dosTime(at);
  async function* generate(): AsyncGenerator<Buffer> {
    try {
      yield* body();
    } finally {
      close?.();
    }
  }
  async function* body(): AsyncGenerator<Buffer> {
    const central: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt16LE(name.length, 26);
      const start = offset;
      yield Buffer.concat([local, name]);
      offset += 30 + name.length;
      let crc = 0;
      let size = 0;
      const body = await e.open();
      if (Buffer.isBuffer(body)) {
        crc = crc32(body);
        size = body.length;
        yield body;
      } else {
        for await (const chunk of body as AsyncIterable<Buffer | string>) {
          const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          size += b.length;
          if (size > e.sizeBytes) {
            body.destroy();
            throw new Error(`archive: ${e.name} is larger than recorded`);
          }
          crc = crc32(b, crc);
          yield b;
        }
      }
      if (size !== e.sizeBytes) throw new Error(`archive: ${e.name} is not the recorded size`);
      if (e.crc32 !== undefined && e.crc32 >>> 0 !== crc >>> 0) {
        throw new Error(`archive: ${e.name} does not match its CRC-32`);
      }
      offset += size;
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      desc.writeUInt32LE(size, 8);
      desc.writeUInt32LE(size, 12);
      yield desc;
      offset += 16;
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc >>> 0, 16);
      c.writeUInt32LE(size, 20);
      c.writeUInt32LE(size, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      c.writeUInt32LE(start, 42);
      central.push(c, name);
    }
    const cd = Buffer.concat(central);
    yield cd;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    yield end;
  }
  return Readable.from(generate(), { objectMode: false });
}
