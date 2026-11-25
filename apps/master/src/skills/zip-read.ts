import { crc32, inflateRawSync } from 'node:zlib';

/**
 * p14-skill-import (docs/design/p14-mcp-skills.md §3.3): a small, defensive in-memory ZIP reader for skill archives
 * uploaded from the panel. Same rules as the worker's tool-archive extractor (apps/worker/src/tools/zip.ts), sized for
 * a skill (the archive is ≤ 2 MiB and lives in memory anyway):
 *
 * - no ZIP64, no encryption, only store / deflate; entry count, per-file, total and ratio caps (zip bombs);
 * - absolute paths, drive letters, backslashes, NUL and `..` segments refused; symlinks and other special entries are
 *   reported as skipped, never followed; directories are implicit;
 * - each entry's inflated size must equal the declared size and its CRC-32 must match.
 *
 * Never writes to disk. Throws {@link ZipReadError} with a short reason (no file content).
 */
export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipReadError';
  }
}

export interface ZipReadLimits {
  readonly maxEntries: number;
  /** Largest inflated entry that is read at all (bigger entries are returned as `tooLarge`). */
  readonly maxFileBytes: number;
  /** All inflated entries together. */
  readonly maxTotalBytes: number;
  /** Inflated / compressed ratio above which an entry larger than 64 KiB is refused (zip bomb). */
  readonly maxRatio: number;
}

export const SKILL_ZIP_LIMITS: ZipReadLimits = {
  maxEntries: 256,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxRatio: 200,
};

export interface ZipReadEntry {
  /** Normalised relative POSIX path. */
  readonly path: string;
  readonly size: number;
  /** null when the entry was not read: a symlink / special file (`skipped`) or larger than maxFileBytes. */
  readonly data: Buffer | null;
  readonly skipped?: 'symlink' | 'special' | 'too_large';
  /** Unix execute bit set (informational: only `scripts/` files are ever executable in a skill). */
  readonly executable: boolean;
}

const EOCD = 0x06054b50;
const CDH = 0x02014b50;
const LFH = 0x04034b50;

/** A safe relative path of an entry name, or null for a pure directory entry; throws on an unsafe one. */
export function safeZipPath(name: string): string | null {
  if (name.includes('\u0000') || name.includes('\\')) throw new ZipReadError(`unsafe entry name`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ZipReadError('absolute entry name');
  const parts = name.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.some((s) => s === '..')) throw new ZipReadError('entry leaves the archive root');
  if (parts.length === 0 || name.endsWith('/')) return null;
  return parts.join('/');
}

export function readZip(buf: Buffer, limits: ZipReadLimits = SKILL_ZIP_LIMITS): ZipReadEntry[] {
  if (buf.length < 22) throw new ZipReadError('not a zip archive (too small)');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipReadError('not a zip archive (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipReadError('ZIP64 archives are not supported for skills');
  }
  if (count > limits.maxEntries) throw new ZipReadError(`too many entries (${String(count)})`);
  if (cdOffset + cdSize > buf.length) throw new ZipReadError('central directory outside the archive');
  const out: ZipReadEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== CDH) {
      throw new ZipReadError('corrupt central directory');
    }
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const name = (flags & 0x800) !== 0 ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
    const path = safeZipPath(name);
    const unixMode = madeBy >> 8 === 3 ? (external >>> 16) & 0xffff : 0;
    const type = unixMode & 0o170000;
    if (path === null || type === 0o040000) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) throw new ZipReadError('duplicate entry');
    seen.add(key);
    const executable = (unixMode & 0o111) !== 0;
    if (type === 0o120000) {
      out.push({ path, size, data: null, skipped: 'symlink', executable: false });
      continue;
    }
    if (type !== 0 && type !== 0o100000) {
      out.push({ path, size, data: null, skipped: 'special', executable: false });
      continue;
    }
    if ((flags & 0x1) !== 0) throw new ZipReadError('encrypted entries are not supported');
    if (method !== 0 && method !== 8)
      throw new ZipReadError(`compression method ${String(method)} not supported`);
    if (size > limits.maxFileBytes) {
      out.push({ path, size, data: null, skipped: 'too_large', executable });
      continue;
    }
    if (size > 64 * 1024 && compressedSize > 0 && size / compressedSize > limits.maxRatio) {
      throw new ZipReadError('suspicious compression ratio');
    }
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipReadError('archive expands beyond the size limit');
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LFH) {
      throw new ZipReadError('bad local header');
    }
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compressedSize > buf.length) throw new ZipReadError('entry outside the archive');
    const raw = buf.subarray(start, start + compressedSize);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
      } catch {
        throw new ZipReadError('entry does not inflate to its declared size');
      }
    }
    if (data.length !== size) throw new ZipReadError('entry size mismatch');
    if (crc32(data) >>> 0 !== crc >>> 0) throw new ZipReadError('CRC mismatch');
    out.push({ path, size, data, executable });
  }
  return out;
}
