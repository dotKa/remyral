import { type FileHandle, open, unlink } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * p17-output-limits (docs/design/p17-output-limits.md §4): the overflow zip of a workspace job — the files of `out/`
 * beyond the job's output limits, packed into one `out-rest.zip` (paths kept) that goes through the blob path.
 *
 * A small PKWARE APPNOTE 6.3 writer that streams to a file: one local header + body per entry (deflate when it is
 * smaller, else stored), then the central directory and its end record. No ZIP64 (the caller bounds the archive below
 * 4 GiB and 65 535 entries), no encryption, no extra fields, UTF-8 names, one DOS timestamp per archive. The caller
 * checks, redacts and scans every entry before it is added (this writer never reads `out/` itself, so it can never
 * follow a symbolic link).
 */

/** Fixed bytes of a local header / central entry / end record (without the name). */
const LOCAL = 30;
const CENTRAL = 46;
const END = 22;

/** Types already compressed: stored (deflating them costs time and gains nothing). */
const STORED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'video/mp4',
  'video/webm',
  'application/vnd.android.package-archive',
  'application/x-android-app-bundle',
  'application/x-ios-app',
]);

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export class ZipFullError extends Error {
  override name = 'ZipFullError';
}

/** Writes one zip archive to `path` (created exclusively, 0600), bounded by `maxBytes` and `maxEntries`. */
export class OverflowZip {
  readonly #fh: FileHandle;
  readonly #path: string;
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #time: { time: number; date: number };
  readonly #central: Buffer[] = [];
  readonly #names = new Set<string>();
  #centralBytes = 0;
  #offset = 0;
  #closed = false;

  private constructor(fh: FileHandle, path: string, maxBytes: number, maxEntries: number, at: Date) {
    this.#fh = fh;
    this.#path = path;
    this.#maxBytes = maxBytes;
    this.#maxEntries = maxEntries;
    this.#time = dosTime(at);
  }

  static async create(
    path: string,
    limits: { readonly maxBytes: number; readonly maxEntries: number },
    at: Date = new Date(),
  ): Promise<OverflowZip> {
    const maxBytes = Math.min(limits.maxBytes, 0xffffffff);
    const maxEntries = Math.min(limits.maxEntries, 0xfffe);
    const fh = await open(path, 'wx', 0o600);
    return new OverflowZip(fh, path, maxBytes, maxEntries, at);
  }

  get entries(): number {
    return this.#names.size;
  }

  /** Bytes the archive has once closed. */
  get size(): number {
    return this.#closed ? this.#offset : this.#offset + this.#centralBytes + END;
  }

  /**
   * Adds one entry. Throws ZipFullError (nothing written) when it would make the archive larger than its bound or
   * exceed the entry count.
   */
  async add(name: string, data: Buffer, mediaType: string): Promise<void> {
    if (this.#closed) throw new Error('zip already closed');
    if (name.length === 0 || name.startsWith('/') || name.split('/').some((s) => s === '..' || s === '')) {
      throw new Error(`invalid zip entry name: ${name}`);
    }
    if (this.#names.has(name)) throw new Error(`duplicate zip entry: ${name}`);
    if (this.#names.size >= this.#maxEntries) throw new ZipFullError('too many entries');
    const nameBuf = Buffer.from(name, 'utf8');
    let body = data;
    let method = 0;
    if (!STORED_TYPES.has(mediaType) && data.length > 0) {
      const deflated = deflateRawSync(data, { level: 6 });
      if (deflated.length < data.length) {
        body = deflated;
        method = 8;
      }
    }
    const grow = LOCAL + nameBuf.length + body.length + CENTRAL + nameBuf.length;
    if (this.size + grow > this.#maxBytes) throw new ZipFullError('archive size limit');
    const crc = crc32(data) >>> 0;
    const { time, date } = this.#time;
    const local = Buffer.alloc(LOCAL);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    await this.#write(Buffer.concat([local, nameBuf]));
    await this.#write(body);
    const central = Buffer.alloc(CENTRAL);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // Regular file, rw-r--r-- (upper 16 bits of the external attributes; "made by" stays MS-DOS compatible).
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(this.#offset - LOCAL - nameBuf.length - body.length, 42);
    this.#central.push(central, nameBuf);
    this.#centralBytes += CENTRAL + nameBuf.length;
    this.#names.add(name);
  }

  async #write(b: Buffer): Promise<void> {
    let at = 0;
    while (at < b.length) {
      const { bytesWritten } = await this.#fh.write(b, at, b.length - at, this.#offset + at);
      at += bytesWritten;
    }
    this.#offset += b.length;
  }

  /** Writes the central directory and closes the file; returns its size. */
  async close(): Promise<number> {
    if (this.#closed) return this.size;
    const cdStart = this.#offset;
    const cd = Buffer.concat(this.#central);
    await this.#write(cd);
    const end = Buffer.alloc(END);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.#names.size, 8);
    end.writeUInt16LE(this.#names.size, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(cdStart, 16);
    await this.#write(end);
    this.#closed = true;
    await this.#fh.close();
    return this.#offset;
  }

  /** Closes and removes the file (nothing to return). */
  async discard(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      await this.#fh.close().catch(() => undefined);
    }
    await unlink(this.#path).catch(() => undefined);
  }
}
