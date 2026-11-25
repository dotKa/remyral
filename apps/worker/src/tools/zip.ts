import { Readable } from 'node:stream';
import { lstat, mkdir, open, readlink, realpath, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { crc32, createInflateRaw } from 'node:zlib';

/**
 * Defensive, streaming ZIP extraction for tool recipes (p5-machine-admin §2) — the worker's own extractor, so no
 * `unzip`, `tar.exe` or PowerShell `Expand-Archive` (whose behaviour differs per OS) is involved. The archive's
 * SHA-256 was verified against the release's pinned checksum before this runs; the checks below still apply:
 *
 * - Central directory parsed with ZIP64 support; encrypted entries and methods other than store / deflate refused.
 * - Absolute paths, drive letters, backslashes, NUL and `..` segments refused; every target stays inside `dest`.
 * - An optional leading directory is stripped (`strip`).
 * - Regular files and directories only — except symbolic links when `allowSymlinks` (macOS app bundles need
 *   `Versions/Current`): a link is created only on POSIX, only with a relative target whose `..` segments all
 *   lead (so links cannot be chained into an escape) and that resolves, from the link's real parent directory,
 *   inside `dest`.
 * - Nothing is created through a parent directory whose real path (symbolic links resolved) is outside `dest`.
 * - Modes normalised (0755 when any execute bit is set in the Unix attributes, else 0644); CRC-32 and sizes
 *   checked for every file; entry count, per-file and total size bounded.
 */

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 100_000,
  maxFileBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024 * 1024,
};

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
  /** Unix mode from the external attributes (0 when the archive was not made on Unix). */
  readonly unixMode: number;
}

export interface ZipExtractResult {
  readonly files: number;
  readonly directories: number;
  readonly symlinks: number;
  readonly skipped: number;
  readonly bytes: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CDH = 0x02014b50;
const LFH = 0x04034b50;

async function readAt(
  fh: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new ZipError('unexpected end of archive');
  return buf;
}

function u64(buf: Buffer, off: number): number {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('size beyond the safe integer range');
  return Number(v);
}

/** Lists the central directory (ZIP64 aware). */
export async function listZip(file: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipEntry[]> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new ZipError('not a zip archive (too small)');
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('not a zip archive (no end of central directory)');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== ZIP64_LOCATOR) throw new ZipError('zip64 locator missing');
      const recOffset = u64(tail, loc + 8);
      const rec = await readAt(fh, recOffset, 56);
      if (rec.readUInt32LE(0) !== ZIP64_EOCD) throw new ZipError('zip64 end record missing');
      count = u64(rec, 32);
      cdSize = u64(rec, 40);
      cdOffset = u64(rec, 48);
    }
    if (count > limits.maxEntries) throw new ZipError(`too many entries (${String(count)})`);
    if (cdOffset + cdSize > size) throw new ZipError('central directory outside the archive');
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CDH) throw new ZipError('corrupt central directory');
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressed = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      // ZIP64 extended information: only the fields that were saturated, in this order.
      let e = 0;
      while (e + 4 <= extra.length) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressed === 0xffffffff) {
            uncompressed = u64(extra, q);
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = u64(extra, q);
            q += 8;
          }
          if (localOffset === 0xffffffff) localOffset = u64(extra, q);
        }
        e += 4 + len;
      }
      const name = (flags & 0x800) !== 0 ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
      const unixMode = madeBy >> 8 === 3 ? (external >>> 16) & 0xffff : 0;
      entries.push({ name, method, flags, crc, compressedSize, size: uncompressed, localOffset, unixMode });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** The relative target path of an entry after `strip`, or null to skip it; throws on an unsafe path. */
export function safeEntryPath(name: string, strip: string | undefined): string | null {
  if (name.includes('\u0000') || name.includes('\\')) throw new ZipError(`unsafe entry name ${name}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ZipError(`absolute entry name ${name}`);
  let n = name;
  if (strip !== undefined && strip !== '') {
    const prefix = strip.endsWith('/') ? strip : `${strip}/`;
    // Entries outside the kept directory (package metadata of a .nupkg, …) are not extracted at all.
    if (!n.startsWith(prefix)) return null;
    n = n.slice(prefix.length);
  }
  const parts = n.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.some((s) => s === '..')) throw new ZipError(`entry ${name} leaves the destination`);
  if (parts.length === 0) return null;
  return parts.join('/');
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Checks that the real path of `path` — resolved through its nearest existing ancestor — is inside `realRoot`.
 * Returns the real path of that ancestor joined with the not-yet-existing remainder.
 */
async function realInside(realRoot: string, path: string, entry: string): Promise<string> {
  let existing = path;
  const rest: string[] = [];
  for (;;) {
    const st = await lstat(existing).catch(() => null);
    if (st !== null) break;
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  const base = await realpath(existing).catch(() => {
    throw new ZipError(`entry ${entry}: parent directory cannot be resolved`);
  });
  const real = join(base, ...rest);
  if (!inside(realRoot, real)) throw new ZipError(`entry ${entry} leaves the destination`);
  return real;
}

/**
 * Validates a symbolic link's target: relative, no NUL, every `..` before any named segment (so the target means
 * the same lexically and on disk — a link through another link can never be walked back up), resolving inside
 * `realRoot` from the link's real parent directory.
 */
function safeLinkTarget(realRoot: string, realParent: string, linkTarget: string): boolean {
  if (
    linkTarget === '' ||
    linkTarget.includes('\u0000') ||
    linkTarget.includes('\\') ||
    isAbsolute(linkTarget)
  ) {
    return false;
  }
  const parts = linkTarget.split('/').filter((s) => s !== '' && s !== '.');
  let named = false;
  for (const part of parts) {
    if (part === '..') {
      if (named) return false;
    } else {
      named = true;
    }
  }
  return inside(realRoot, resolve(realParent, ...parts));
}

/** Extracts `file` into `dest` (which must exist and be empty or new). */
export async function extractZip(
  file: string,
  dest: string,
  opts: {
    readonly strip?: string;
    readonly allowSymlinks?: boolean;
    readonly limits?: ZipLimits;
    readonly signal?: AbortSignal;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<ZipExtractResult> {
  const limits = opts.limits ?? DEFAULT_ZIP_LIMITS;
  const platform = opts.platform ?? process.platform;
  const root = resolve(dest);
  await mkdir(root, { recursive: true, mode: 0o755 });
  const realRoot = await realpath(root);
  const entries = await listZip(file, limits);
  const result = { files: 0, directories: 0, symlinks: 0, skipped: 0, bytes: 0 };
  const fh = await open(file, 'r');
  try {
    for (const entry of entries) {
      if (opts.signal?.aborted === true) throw new ZipError('cancelled');
      const rel = safeEntryPath(entry.name, opts.strip);
      if (rel === null) continue;
      const target = normalize(join(root, ...rel.split('/')));
      if (!inside(root, target)) throw new ZipError(`entry ${entry.name} leaves the destination`);
      if ((entry.flags & 0x1) !== 0) throw new ZipError(`encrypted entry ${entry.name}`);
      const type = entry.unixMode & 0o170000;
      if (entry.name.endsWith('/') || type === 0o040000) {
        await realInside(realRoot, target, entry.name);
        await mkdir(target, { recursive: true, mode: 0o755 });
        result.directories += 1;
        continue;
      }
      if (entry.method !== 0 && entry.method !== 8) {
        throw new ZipError(`entry ${entry.name}: compression method ${String(entry.method)} not supported`);
      }
      if (entry.size > limits.maxFileBytes) throw new ZipError(`entry ${entry.name} is too large`);
      result.bytes += entry.size;
      if (result.bytes > limits.maxTotalBytes) throw new ZipError('archive expands beyond the size limit');
      const local = await readAt(fh, entry.localOffset, 30);
      if (local.readUInt32LE(0) !== LFH) throw new ZipError(`entry ${entry.name}: bad local header`);
      const dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      await realInside(realRoot, dirname(target), entry.name);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      const realParent = await realInside(realRoot, dirname(target), entry.name);
      if (type === 0o120000) {
        // Symbolic link: the (small) content is the target.
        if (opts.allowSymlinks !== true || platform === 'win32') {
          result.skipped += 1;
          continue;
        }
        const raw = await readAt(fh, dataStart, entry.compressedSize);
        const linkTarget = (entry.method === 8 ? await inflateBuffer(raw) : raw).toString('utf8');
        if (!safeLinkTarget(realRoot, realParent, linkTarget)) {
          throw new ZipError(`entry ${entry.name}: symlink target leaves the destination`);
        }
        await symlink(linkTarget, target);
        // Re-read what was created (a pre-existing path would have made symlink() fail).
        if ((await readlink(target)) !== linkTarget)
          throw new ZipError(`entry ${entry.name}: symlink mismatch`);
        result.symlinks += 1;
        continue;
      }
      if (type !== 0 && type !== 0o100000) {
        result.skipped += 1; // devices, FIFOs, sockets
        continue;
      }
      // Never write through something that already exists (a planted link would redirect the write).
      const existing = await lstat(target).catch(() => null);
      if (existing !== null) throw new ZipError(`entry ${entry.name}: target already exists`);
      const executable = (entry.unixMode & 0o111) !== 0;
      const out = await open(target, 'wx', executable ? 0o755 : 0o644);
      let written = 0;
      let crc = 0;
      try {
        if (entry.compressedSize > 0) {
          // Positional reads from the archive's own handle (destroying the stream never closes it).
          const source = Readable.from(readRange(fh, dataStart, entry.compressedSize));
          const stream = entry.method === 8 ? source.pipe(createInflateRaw()) : source;
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            if (isAborted(opts.signal)) {
              source.destroy();
              throw new ZipError('cancelled');
            }
            written += chunk.length;
            if (written > entry.size) {
              source.destroy();
              throw new ZipError(`entry ${entry.name} is larger than declared`);
            }
            crc = crc32(chunk, crc);
            await out.write(chunk);
          }
        }
      } finally {
        await out.close();
      }
      if (written !== entry.size) throw new ZipError(`entry ${entry.name}: size mismatch`);
      if (crc >>> 0 !== entry.crc >>> 0) throw new ZipError(`entry ${entry.name}: CRC mismatch`);
      result.files += 1;
    }
  } finally {
    await fh.close();
  }
  return result;
}

async function inflateBuffer(raw: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const inflater = createInflateRaw();
  inflater.end(raw);
  for await (const c of inflater as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function* readRange(
  fh: Awaited<ReturnType<typeof open>>,
  start: number,
  length: number,
): AsyncGenerator<Buffer> {
  let pos = start;
  let left = length;
  while (left > 0) {
    const n = Math.min(left, 1024 * 1024);
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, pos);
    if (bytesRead === 0) throw new ZipError('unexpected end of archive');
    yield buf.subarray(0, bytesRead);
    pos += bytesRead;
    left -= bytesRead;
  }
}
