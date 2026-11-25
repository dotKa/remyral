import { pipeline, Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import { OUTPUT_LIMITS } from '@remyral/protocol';

/**
 * p18-outputs-delivery (docs/design/p18-outputs-delivery.md §1): the overflow zip (`out-rest.zip`) of a job, unpacked
 * into "Tüm dosyaları indir (zip)" while the archive streams — never assembled in memory or on disk.
 *
 * {@link readZipIndex} reads the zip's central directory with two range reads (the end record, then the directory)
 * and checks it strictly: classic zip only (no ZIP64, no encryption, no multi-disk), methods stored / deflate, safe
 * relative names (no absolute paths, `..`, `.`, empty segments, backslashes or control characters — no zip-slip for
 * whoever extracts the result), each entry within the overflow zip's own bounds, entries not overlapping and inside
 * the archive. {@link ZipStreamReader} then reads the zip ONCE from the start and hands each entry's bytes (inflated)
 * to the archive writer in offset order; the writer checks the size and CRC-32 the directory recorded.
 *
 * The zip comes from the worker (built from files it checked, redacted and scanned; uploaded through the verified
 * blob path), so its content is what the user may already download as `out-rest.zip`; the checks here only make sure
 * that a damaged or hostile archive cannot make the master write an archive with other paths or unbounded bytes.
 */

export class ZipIndexError extends Error {
  override name = 'ZipIndexError';
}

export interface ZipIndexEntry {
  /** The entry's path (validated, `/`-separated, relative). */
  readonly name: string;
  readonly method: 0 | 8;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly size: number;
  /** Offset of the entry's local header. */
  readonly offset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_BYTES = 22;
/** The largest central directory looked at (10 000 entries of the worker's names fit easily). */
const MAX_CENTRAL_BYTES = 16 * 1024 * 1024;
const MAX_NAME_BYTES = 1024;

// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const UNSAFE_NAME = /[\u0000-\u001f\u007f\\]/;

/** A relative path of `/`-separated segments without `.`, `..` or empty segments (a trailing `/` is a directory). */
export function safeEntryName(name: string): boolean {
  if (name === '' || name.startsWith('/') || UNSAFE_NAME.test(name) || /^[A-Za-z]:/.test(name)) return false;
  const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

export interface ZipIndexLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
}

export const OVERFLOW_ZIP_LIMITS: ZipIndexLimits = {
  maxEntries: OUTPUT_LIMITS.zipMaxEntries,
  maxEntryBytes: OUTPUT_LIMITS.zipEntryMaxBytes,
};

/**
 * The files of a zip of `size` bytes, read through `range` (offset, length) — in offset order, directories left out.
 * Throws {@link ZipIndexError} for anything this reader does not take.
 */
export async function readZipIndex(
  size: number,
  range: (offset: number, length: number) => Promise<Buffer>,
  limits: ZipIndexLimits = OVERFLOW_ZIP_LIMITS,
): Promise<ZipIndexEntry[]> {
  if (!Number.isSafeInteger(size) || size < EOCD_BYTES) throw new ZipIndexError('not a zip (too small)');
  if (size > 0xffffffff) throw new ZipIndexError('ZIP64 archives are not unpacked');
  const tailLength = Math.min(size, EOCD_BYTES + 0xffff);
  const tailStart = size - tailLength;
  const tail = await range(tailStart, tailLength);
  if (tail.length !== tailLength) throw new ZipIndexError('short read of the end record');
  let end = -1;
  for (let i = tail.length - EOCD_BYTES; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD && i + EOCD_BYTES + tail.readUInt16LE(i + 20) === tail.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipIndexError('no end of central directory record');
  const disk = tail.readUInt16LE(end + 4);
  const cdDisk = tail.readUInt16LE(end + 6);
  const onDisk = tail.readUInt16LE(end + 8);
  const count = tail.readUInt16LE(end + 10);
  const cdSize = tail.readUInt32LE(end + 12);
  const cdOffset = tail.readUInt32LE(end + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count)
    throw new ZipIndexError('multi-disk archives are not unpacked');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipIndexError('ZIP64 archives are not unpacked');
  }
  if (count > limits.maxEntries) throw new ZipIndexError(`more than ${String(limits.maxEntries)} entries`);
  const eocdAt = tailStart + end;
  if (cdSize > MAX_CENTRAL_BYTES || cdOffset + cdSize > eocdAt) {
    throw new ZipIndexError('central directory out of bounds');
  }
  const cd = cdSize === 0 ? Buffer.alloc(0) : await range(cdOffset, cdSize);
  if (cd.length !== cdSize) throw new ZipIndexError('short read of the central directory');
  const out: ZipIndexEntry[] = [];
  const names = new Set<string>();
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > cd.length || cd.readUInt32LE(at) !== CENTRAL) throw new ZipIndexError('bad central entry');
    const flags = cd.readUInt16LE(at + 8);
    const method = cd.readUInt16LE(at + 10);
    const crc = cd.readUInt32LE(at + 16);
    const compressedSize = cd.readUInt32LE(at + 20);
    const entrySize = cd.readUInt32LE(at + 24);
    const nameLength = cd.readUInt16LE(at + 28);
    const extraLength = cd.readUInt16LE(at + 30);
    const commentLength = cd.readUInt16LE(at + 32);
    const startDisk = cd.readUInt16LE(at + 34);
    const offset = cd.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > cd.length) throw new ZipIndexError('bad central entry');
    if (nameLength === 0 || nameLength > MAX_NAME_BYTES) throw new ZipIndexError('bad entry name');
    const name = cd.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at = next;
    if ((flags & 0x0001) !== 0) throw new ZipIndexError('encrypted entries are not unpacked');
    if (startDisk !== 0) throw new ZipIndexError('multi-disk archives are not unpacked');
    if (compressedSize === 0xffffffff || entrySize === 0xffffffff || offset === 0xffffffff) {
      throw new ZipIndexError('ZIP64 entries are not unpacked');
    }
    if (!safeEntryName(name) || name.includes('�')) throw new ZipIndexError('unsafe entry name');
    if (name.endsWith('/')) continue; // a directory: its files carry the path
    if (method !== 0 && method !== 8) throw new ZipIndexError(`compression method ${String(method)}`);
    if (method === 0 && compressedSize !== entrySize) throw new ZipIndexError('stored entry of two sizes');
    if (entrySize > limits.maxEntryBytes) throw new ZipIndexError('entry larger than the overflow bound');
    if (names.has(name)) throw new ZipIndexError('duplicate entry name');
    names.add(name);
    if (offset + 30 + compressedSize > cdOffset) throw new ZipIndexError('entry out of bounds');
    out.push({ name, method, crc32: crc >>> 0, compressedSize, size: entrySize, offset });
  }
  out.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    if (prev !== undefined && cur !== undefined && cur.offset < prev.offset + 30 + prev.compressedSize) {
      throw new ZipIndexError('overlapping entries');
    }
  }
  return out;
}

/**
 * Reads one zip stream front to back: {@link entry} returns an entry's (inflated) bytes as a stream; entries must be
 * asked for in offset order and each read to its end before the next (the archive writer does exactly that).
 */
export class ZipStreamReader {
  readonly #open: () => Promise<Readable>;
  #source: Readable | null = null;
  #it: AsyncIterator<Buffer | string> | null = null;
  #buf: Buffer = Buffer.alloc(0);
  /** Offset of `#buf`'s first byte in the zip. */
  #pos = 0;
  #closed = false;

  constructor(open: () => Promise<Readable>) {
    this.#open = open;
  }

  async #more(): Promise<boolean> {
    if (this.#closed) throw new ZipIndexError('the overflow zip was closed');
    if (this.#it === null) {
      this.#source = await this.#open();
      this.#it = (this.#source as AsyncIterable<Buffer | string>)[Symbol.asyncIterator]();
    }
    const r = await this.#it.next();
    if (r.done === true) return false;
    const chunk = typeof r.value === 'string' ? Buffer.from(r.value) : r.value;
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    return true;
  }

  async #skipTo(offset: number): Promise<void> {
    if (offset < this.#pos) throw new ZipIndexError('entries out of order');
    while (this.#pos + this.#buf.length < offset) {
      this.#pos += this.#buf.length;
      this.#buf = Buffer.alloc(0);
      if (!(await this.#more())) throw new ZipIndexError('the overflow zip ended early');
    }
    this.#buf = this.#buf.subarray(offset - this.#pos);
    this.#pos = offset;
  }

  async #read(n: number): Promise<Buffer> {
    while (this.#buf.length < n) {
      if (!(await this.#more())) throw new ZipIndexError('the overflow zip ended early');
    }
    const out = Buffer.from(this.#buf.subarray(0, n));
    this.#buf = this.#buf.subarray(n);
    this.#pos += n;
    return out;
  }

  async *#take(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.#buf.length === 0 && !(await this.#more())) {
        throw new ZipIndexError('the overflow zip ended early');
      }
      const part = this.#buf.subarray(0, Math.min(left, this.#buf.length));
      this.#buf = this.#buf.subarray(part.length);
      this.#pos += part.length;
      left -= part.length;
      yield part;
    }
  }

  /** The bytes of `e` (inflated for deflate entries). */
  async entry(e: ZipIndexEntry): Promise<Readable> {
    await this.#skipTo(e.offset);
    const header = await this.#read(30);
    if (header.readUInt32LE(0) !== LOCAL) throw new ZipIndexError(`bad local header for ${e.name}`);
    if (header.readUInt16LE(8) !== e.method) throw new ZipIndexError(`local header of ${e.name} differs`);
    await this.#read(header.readUInt16LE(26) + header.readUInt16LE(28));
    const raw = Readable.from(this.#take(e.compressedSize), { objectMode: false });
    if (e.method === 0) return raw;
    const inflate = createInflateRaw();
    pipeline(raw, inflate, () => undefined);
    return inflate;
  }

  /** Releases the zip's stream (idempotent). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#source?.destroy();
    this.#buf = Buffer.alloc(0);
  }
}
