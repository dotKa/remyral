import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { createGunzip } from 'node:zlib';

/**
 * Streaming, defensive extraction of an npm package tarball (gzip'ed ustar/pax) — the worker's own extractor,
 * so no `npm`, no `.npmrc` and no install script is ever involved (p5-remote-ops §2).
 *
 * - The first path component (`package/`) is stripped, as npm does.
 * - Absolute paths, `..` segments, drive letters, backslashes and NUL are refused; every target is checked to
 *   stay inside the destination.
 * - Only regular files and directories are created. Symbolic and hard links, devices and FIFOs are skipped
 *   (counted), so an archive cannot point outside the install dir.
 * - Modes are normalised: 0755 for files with any execute bit, 0644 otherwise; ownership is the worker's.
 * - Bounded: entry count, per-file and total bytes.
 */

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

export interface ExtractLimits {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxEntries: 100_000,
  maxFileBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

export interface ExtractResult {
  readonly files: number;
  readonly directories: number;
  readonly skippedLinks: number;
  readonly bytes: number;
}

const BLOCK = 512;

function field(buf: Buffer, start: number, length: number): string {
  const raw = buf.subarray(start, start + length);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString('utf8');
}

function octal(buf: Buffer, start: number, length: number): number {
  const first = buf[start] ?? 0;
  if ((first & 0x80) !== 0) {
    // base-256 (GNU) for large sizes
    let v = first & 0x7f;
    for (let i = 1; i < length; i++) v = v * 256 + (buf[start + i] ?? 0);
    return v;
  }
  const s = field(buf, start, length).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError('corrupt tar header (number)');
  return Number.parseInt(s, 8);
}

function checksumOk(header: Buffer): boolean {
  const stored = octal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum === stored;
}

/** pax extended header records (`<len> key=value\n`). */
function parsePax(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const len = Number(data.subarray(i, space).toString('ascii'));
    if (!Number.isInteger(len) || len <= 0 || i + len > data.length) throw new TarError('corrupt pax header');
    const record = data.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    i += len;
  }
  return out;
}

/** The safe destination of an archive path, or null for the stripped root itself. Throws when unsafe. */
export function safeTarget(dest: string, archivePath: string, strip = true): string | null {
  if (archivePath.includes('\0') || archivePath.includes('\\')) throw new TarError('unsafe path in archive');
  const parts = archivePath.split('/').filter((p) => p !== '' && p !== '.');
  if (archivePath.startsWith('/') || /^[A-Za-z]:/.test(archivePath))
    throw new TarError('absolute path in archive');
  if (parts.some((p) => p === '..')) throw new TarError('path traversal in archive');
  // npm tarballs: strip `package/`; p8-preview-tunnels: other archives (cloudflared) keep their own layout.
  const rest = strip ? parts.slice(1) : parts;
  if (rest.length === 0) return null;
  if (rest.some((p) => p.includes(':'))) throw new TarError('unsafe path in archive');
  const target = normalize(join(dest, ...rest));
  const rel = relative(dest, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new TarError('path escapes the destination');
  }
  return target;
}

/** Extracts `tgzPath` into `dest` (created if missing). */
export async function extractTgz(
  tgzPath: string,
  dest: string,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
  opts: { readonly stripFirst?: boolean } = {},
): Promise<ExtractResult> {
  const strip = opts.stripFirst ?? true;
  await mkdir(dest, { recursive: true, mode: 0o755 });
  const gunzip = createReadStream(tgzPath).pipe(createGunzip());
  let pending: Buffer = Buffer.alloc(0);
  let entries = 0;
  let files = 0;
  let directories = 0;
  let skippedLinks = 0;
  let total = 0;
  let pax: Map<string, string> | null = null;
  let longName: string | null = null;
  let ended = false;

  // Current entry state (an object: the helpers below change it).
  const st: {
    remaining: number; // data bytes still to consume for the current entry
    padding: number;
    sink: { write: (b: Buffer) => Promise<void>; close: () => Promise<void> } | null;
    collect: Buffer[] | null; // pax / longname data
    collectKind: 'pax' | 'long' | 'skip' | null;
  } = { remaining: 0, padding: 0, sink: null, collect: null, collectKind: null };

  const startEntry = async (header: Buffer): Promise<void> => {
    if (!checksumOk(header)) throw new TarError('corrupt tar header (checksum)');
    const type = String.fromCharCode(header[156] ?? 0);
    const size = octal(header, 124, 12);
    const mode = octal(header, 100, 8);
    st.remaining = size;
    st.padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (type === 'x' || type === 'g' || type === 'L') {
      if (size > 1024 * 1024) throw new TarError('oversized extended header');
      st.collect = [];
      st.collectKind = type === 'L' ? 'long' : type === 'x' ? 'pax' : 'skip';
      return;
    }
    if (++entries > limits.maxEntries) throw new TarError('too many entries in archive');
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    const path = pax?.get('path') ?? longName ?? (prefix === '' ? name : `${prefix}/${name}`);
    const paxSize = pax?.get('size');
    if (paxSize !== undefined) {
      st.remaining = Number(paxSize);
      if (!Number.isSafeInteger(st.remaining) || st.remaining < 0) throw new TarError('corrupt pax size');
      st.padding = (BLOCK - (st.remaining % BLOCK)) % BLOCK;
    }
    pax = null;
    longName = null;
    if (type === '0' || type === '\0' || type === '7') {
      const target = safeTarget(dest, path, strip);
      if (target === null) throw new TarError('file entry without a name');
      if (st.remaining > limits.maxFileBytes) throw new TarError('file in archive exceeds the size limit');
      total += st.remaining;
      if (total > limits.maxTotalBytes) throw new TarError('archive exceeds the total size limit');
      await mkdir(join(target, '..'), { recursive: true, mode: 0o755 });
      const handle = await open(target, 'w', (mode & 0o111) !== 0 ? 0o755 : 0o644);
      await handle.chmod((mode & 0o111) !== 0 ? 0o755 : 0o644);
      files++;
      st.sink = {
        write: async (b) => {
          await handle.write(b);
        },
        close: () => handle.close(),
      };
      if (st.remaining === 0) {
        await st.sink.close();
        st.sink = null;
      }
      return;
    }
    if (type === '5') {
      const target = safeTarget(dest, path, strip);
      if (target !== null) await mkdir(target, { recursive: true, mode: 0o755 });
      directories++;
      st.collectKind = 'skip';
      st.collect = null;
      return;
    }
    // Links, devices, FIFOs: never created.
    safeTarget(dest, path, strip);
    skippedLinks++;
    st.collectKind = 'skip';
    st.collect = null;
  };

  const finishCollect = (): void => {
    const data = Buffer.concat(st.collect ?? []);
    if (st.collectKind === 'pax') pax = parsePax(data);
    else if (st.collectKind === 'long') longName = data.toString('utf8').replace(/\0+$/, '');
    st.collect = null;
    st.collectKind = null;
  };

  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      for (;;) {
        if (ended) {
          pending = Buffer.alloc(0);
          break;
        }
        if (st.remaining > 0) {
          if (pending.length === 0) break;
          const take = Math.min(st.remaining, pending.length);
          const part = pending.subarray(0, take);
          if (st.sink !== null) await st.sink.write(Buffer.from(part));
          else if (st.collect !== null) st.collect.push(Buffer.from(part));
          pending = pending.subarray(take);
          st.remaining -= take;
          if (st.remaining === 0) {
            if (st.sink !== null) {
              await st.sink.close();
              st.sink = null;
            }
            if (st.collect !== null) finishCollect();
            else st.collectKind = null;
          }
          continue;
        }
        if (st.padding > 0) {
          if (pending.length === 0) break;
          const take = Math.min(st.padding, pending.length);
          pending = pending.subarray(take);
          st.padding -= take;
          continue;
        }
        if (pending.length < BLOCK) break;
        const header = pending.subarray(0, BLOCK);
        pending = pending.subarray(BLOCK);
        if (header.every((b) => b === 0)) {
          ended = true;
          continue;
        }
        await startEntry(Buffer.from(header));
        if (st.remaining === 0 && st.collect !== null) finishCollect();
      }
    }
  } finally {
    if (st.sink !== null) await st.sink.close().catch(() => undefined);
  }
  if (st.remaining > 0) throw new TarError('truncated archive');
  return { files, directories, skippedLinks, bytes: total };
}
