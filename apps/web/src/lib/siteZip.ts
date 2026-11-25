import { INPUT_BUNDLE_LIMITS, INPUT_BUNDLE_SKIPPED_DIRS } from '@remyral/protocol/input-bundle-files';
import { SITE_UPLOAD_LIMITS } from '@remyral/protocol/site-files';
import { readBlob } from './releaseUpload';

/**
 * p10-site-upload: a small, defensive .zip reader for "Upload a site" — it runs in the browser only, so the master
 * never unpacks an archive (the master receives plain files and checks each one again).
 *
 * Read from the central directory; only `stored` (0) and `deflate` (8) entries; encrypted, multi-disk and ZIP64
 * archives are refused. Defences:
 *  - zip-slip: entry names are returned as given and the caller's path rules refuse `..`, absolute paths, drive
 *    letters and backslashes (nothing is ever written to a file system here);
 *  - symlinks (Unix mode `S_IFLNK` in the external attributes) are refused;
 *  - zip bombs: at most {@link ZIP_LIMITS.maxEntries} entries; an entry's declared size above the per-file limit or
 *    a compression ratio above {@link ZIP_LIMITS.maxRatio} is refused without inflating it; inflation stops as soon
 *    as the output passes the declared size; the total of inflated bytes is capped; the CRC-32 must match.
 */

export const ZIP_LIMITS: ZipLimits = Object.freeze({
  /** The .zip itself (compressed). */
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 2000,
  maxRatio: 200,
  maxEntryBytes: SITE_UPLOAD_LIMITS.maxFileBytes,
  maxTotalBytes: SITE_UPLOAD_LIMITS.maxTotalBytes,
});

/** The reader's caps (p16-zip-job-input: a job input bundle reads with larger ones — INPUT_ZIP_LIMITS). */
export interface ZipLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxRatio: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
  /** Folders whose entries are left out unread (counted in `skipped`), e.g. `.git`, `node_modules`. */
  readonly skipDirs?: ReadonlySet<string>;
}

/** p16-zip-job-input: the caps of a .zip read as a job's input files (ADR-0060). */
export const INPUT_ZIP_LIMITS: ZipLimits = Object.freeze({
  maxArchiveBytes: INPUT_BUNDLE_LIMITS.maxArchiveBytes,
  // A source tree's .git / node_modules entries are skipped unread, so the directory may list many more.
  maxEntries: 50_000,
  maxRatio: 200,
  maxEntryBytes: INPUT_BUNDLE_LIMITS.maxFileBytes,
  maxTotalBytes: INPUT_BUNDLE_LIMITS.maxTotalBytes,
  skipDirs: INPUT_BUNDLE_SKIPPED_DIRS,
});

export interface ZipEntry {
  readonly path: string;
  readonly blob: Blob;
}

export interface ZipRefusal {
  readonly path: string;
  readonly reason: string;
}

export class ZipError extends Error {
  override readonly name = 'ZipError';
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

let crcTable: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of data) crc = (crcTable[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Inflates raw deflate data, stopping (and failing) as soon as more than `max` bytes come out. */
async function inflateRaw(data: Uint8Array, max: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('This browser cannot unpack .zip files; pick the folder instead.');
  }
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  });
  const stream = source.pipeThrough(
    new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new ZipError('an entry inflates to more than its declared size');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Reads the entries of a .zip. Directories and macOS metadata (`__MACOSX/`, `.DS_Store`) are skipped; entries that
 * are refused (symlink, unsupported method, too large, suspicious ratio) are returned in `refused` with the reason.
 * Throws ZipError for an archive that cannot be read safely at all.
 */
export async function readZip(
  file: Blob,
  limits: ZipLimits = ZIP_LIMITS,
): Promise<{ entries: ZipEntry[]; refused: ZipRefusal[]; skipped: string[] }> {
  if (file.size > limits.maxArchiveBytes) {
    throw new ZipError(`The .zip is larger than ${String(limits.maxArchiveBytes / 1024 / 1024)} MB.`);
  }
  const buf = new Uint8Array(await readBlob(file));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  // End of central directory: the last 22 bytes + an optional comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (u32(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a .zip file (no central directory).');
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0)
    throw new ZipError('Multi-part .zip files are not supported.');
  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported.');
  }
  if (count > limits.maxEntries)
    throw new ZipError(`The .zip has more than ${String(limits.maxEntries)} entries.`);
  if (cdOffset + cdSize > eocd) throw new ZipError('The .zip is damaged (central directory out of range).');

  const entries: ZipEntry[] = [];
  const refused: ZipRefusal[] = [];
  const skipped: string[] = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || u32(p) !== CEN)
      throw new ZipError('The .zip is damaged (bad central directory entry).');
    const madeBy = u16(p + 4) >> 8;
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const csize = u32(p + 20);
    const usize = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const external = u32(p + 38);
    const local = u32(p + 42);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // a directory
    const base = name.slice(name.lastIndexOf('/') + 1);
    const skipDirs = limits.skipDirs;
    if (
      skipDirs !== undefined &&
      name
        .split('/')
        .slice(0, -1)
        .some((seg) => skipDirs.has(seg))
    ) {
      skipped.push(name);
      continue;
    }
    if (name.startsWith('__MACOSX/') || base === '.DS_Store' || base === 'Thumbs.db') {
      skipped.push(name);
      continue;
    }
    if (madeBy === 3 && ((external >>> 16) & 0xf000) === 0xa000) {
      refused.push({ path: name, reason: 'symbolic link' });
      continue;
    }
    if ((flags & 1) !== 0) {
      refused.push({ path: name, reason: 'encrypted' });
      continue;
    }
    if (method !== 0 && method !== 8) {
      refused.push({ path: name, reason: 'unsupported compression' });
      continue;
    }
    if (csize === 0xffffffff || usize === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
    if (usize > limits.maxEntryBytes) {
      refused.push({
        path: name,
        reason: `larger than ${String(limits.maxEntryBytes / 1024 / 1024)} MiB`,
      });
      continue;
    }
    if (method === 8 && usize > 1024 && usize / Math.max(csize, 1) > limits.maxRatio) {
      refused.push({ path: name, reason: 'suspicious compression ratio' });
      continue;
    }
    if (method === 0 && csize !== usize) throw new ZipError(`The .zip is damaged (${name}).`);
    total += usize;
    if (total > limits.maxTotalBytes) {
      throw new ZipError(`The files would be larger than ${String(limits.maxTotalBytes / 1024 / 1024)} MiB.`);
    }
    if (local + 30 > buf.length || u32(local) !== LOC) throw new ZipError(`The .zip is damaged (${name}).`);
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (start + csize > buf.length) throw new ZipError(`The .zip is damaged (${name}).`);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : await inflateRaw(raw, usize);
    if (data.byteLength !== usize || crc32(data) !== crc) {
      throw new ZipError(`The .zip is damaged (${name}: size or checksum does not match).`);
    }
    entries.push({ path: name, blob: new Blob([data as BlobPart]) });
  }
  return { entries, refused, skipped };
}
