import { Readable } from 'node:stream';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { streamArchive } from '../../src/workspaces/archive.js';
import {
  type ArchiveRow,
  type ArchiveStore,
  clearArchiveIndexCache,
  planFullArchive,
} from '../../src/workspaces/full-archive.js';
import { readZipIndex, safeEntryName, ZipIndexError } from '../../src/workspaces/zip-unpack.js';

/**
 * p18-outputs-delivery: "Tüm dosyaları indir (zip)" — one archive with every file: the stored ones, the overflow
 * zip's files unpacked in place (not a zip in the zip), `_summary.md`, a note for removed files; streamed while the
 * overflow zip is read once.
 */

/** A zip like the worker's `OverflowZip`: local headers with sizes, deflate when smaller, central directory. */
function makeZip(files: readonly { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const deflated = deflateRawSync(f.data);
    const method = f.store === true || deflated.length >= f.data.length ? 0 : 8;
    const body = method === 8 ? deflated : f.data;
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** Entries of an archive (name → bytes), local headers checked against the central directory. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    expect(out.has(name), name).toBe(false);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(crc32(data) >>> 0, name).toBe(crc);
    out.set(name, data);
    at += 46 + nameLen;
  }
  return out;
}

async function collect(r: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of r as AsyncIterable<Buffer>) parts.push(c);
  return Buffer.concat(parts);
}

/** A blob store over buffers; `chunk`: the stream's chunk size; records how far each stream was read. */
function store(blobs: Record<string, Buffer>, chunk = 64 * 1024) {
  const read: number[] = [];
  const opened: string[] = [];
  let destroyed = 0;
  const s: ArchiveStore = {
    range: (key, offset, length) => {
      const b = blobs[key];
      if (b === undefined) return Promise.reject(new Error(`no blob ${key}`));
      return Promise.resolve(Buffer.from(b.subarray(offset, offset + length)));
    },
    stream: (key) => {
      const b = blobs[key];
      if (b === undefined) return Promise.reject(new Error(`no blob ${key}`));
      opened.push(key);
      const slot = read.push(0) - 1;
      async function* gen(): AsyncGenerator<Buffer> {
        for (let i = 0; i < (b?.length ?? 0); i += chunk) {
          const part = (b ?? Buffer.alloc(0)).subarray(i, i + chunk);
          read[slot] = (read[slot] ?? 0) + part.length;
          // A store answers asynchronously: the reader must not run ahead of the archive writer.
          await Promise.resolve();
          yield part;
        }
      }
      const stream = Readable.from(gen());
      stream.on('close', () => {
        destroyed++;
      });
      return Promise.resolve({ stream });
    },
  };
  return { s, read, opened, destroyed: () => destroyed };
}

const row = (name: string, data: Buffer, over: Partial<ArchiveRow> = {}): ArchiveRow => ({
  name,
  summary: false,
  mediaType: 'text/csv',
  sizeBytes: data.length,
  content: data,
  blobKey: null,
  prunedReason: null,
  ...over,
});

const csv = (i: number): Buffer =>
  Buffer.from(`${String(i).padStart(4, '0')},${'x'.repeat(40 + (i % 13))}\n`);

beforeEach(() => {
  clearArchiveIndexCache();
});

describe('the overflow zip index', () => {
  it('reads the worker format: names, methods, sizes, offsets in order', async () => {
    const zip = makeZip([
      { name: 'data/a.csv', data: Buffer.from('a'.repeat(500)) },
      { name: 'img/p.png', data: Buffer.from([1, 2, 3]), store: true },
    ]);
    const index = await readZipIndex(zip.length, (o, l) => Promise.resolve(zip.subarray(o, o + l)));
    expect(index.map((e) => [e.name, e.method, e.size])).toEqual([
      ['data/a.csv', 8, 500],
      ['img/p.png', 0, 3],
    ]);
  });

  it('refuses unsafe names, encryption, other methods and entries beyond the bounds', async () => {
    for (const bad of [
      '../etc/passwd',
      '/abs.txt',
      'a/../b',
      'a\\b.txt',
      'c:/x',
      'a//b',
      './a',
      'x\u0001y',
    ]) {
      expect(safeEntryName(bad), bad).toBe(false);
    }
    expect(safeEntryName('data/r0001.csv')).toBe(true);
    const evil = makeZip([{ name: '../evil.txt', data: Buffer.from('x') }]);
    await expect(
      readZipIndex(evil.length, (o, l) => Promise.resolve(evil.subarray(o, o + l))),
    ).rejects.toBeInstanceOf(ZipIndexError);
    const big = makeZip([{ name: 'big.bin', data: Buffer.alloc(2000, 1), store: true }]);
    await expect(
      readZipIndex(big.length, (o, l) => Promise.resolve(big.subarray(o, o + l)), {
        maxEntries: 10,
        maxEntryBytes: 1000,
      }),
    ).rejects.toThrow(/larger than the overflow bound/);
    const enc = makeZip([{ name: 'e.txt', data: Buffer.from('secret') }]);
    const cdAt = enc.readUInt32LE(enc.length - 22 + 16);
    enc.writeUInt16LE(0x0801, cdAt + 8);
    await expect(readZipIndex(enc.length, (o, l) => Promise.resolve(enc.subarray(o, o + l)))).rejects.toThrow(
      /encrypted/,
    );
    await expect(readZipIndex(30, () => Promise.resolve(Buffer.alloc(30)))).rejects.toThrow(
      /no end of central directory/,
    );
  });
});

describe('Tüm dosyaları indir (zip)', () => {
  it('holds all 600 files once: 499 stored + the 101 of out-rest.zip unpacked in place, and _summary.md', async () => {
    const stored = Array.from({ length: 499 }, (_, i) =>
      row(`data/r${String(i).padStart(4, '0')}.csv`, csv(i)),
    );
    const packed = Array.from({ length: 101 }, (_, i) => ({
      name: `data/r${String(i + 499).padStart(4, '0')}.csv`,
      data: csv(i + 499),
    }));
    const zip = makeZip(packed);
    const fake = store({ 'artifacts/zip': zip });
    const rows: ArchiveRow[] = [
      row('summary.md', Buffer.from('# Summary\n'), { summary: true, mediaType: 'text/markdown' }),
      ...stored,
      row('out-rest.zip', zip, { mediaType: 'application/zip', content: null, blobKey: 'artifacts/zip' }),
    ];
    const plan = await planFullArchive(rows, 'out-rest.zip', fake.s);
    expect(plan.files).toBe(600);
    expect(plan.unpacked).toEqual({ name: 'out-rest.zip', files: 101 });
    // Nothing was streamed while planning (the directory came from range reads).
    expect(fake.opened).toEqual([]);
    const buf = await collect(streamArchive(plan.sources, new Date(), plan.close));
    expect(buf.length).toBe(plan.archiveBytes);
    const entries = unzip(buf);
    expect(entries.size).toBe(601);
    expect(entries.has('out-rest.zip')).toBe(false);
    expect(entries.get('_summary.md')?.toString()).toBe('# Summary\n');
    for (let i = 0; i < 600; i++) {
      const name = `data/r${String(i).padStart(4, '0')}.csv`;
      expect(entries.get(name)?.equals(csv(i)), name).toBe(true);
    }
    // The overflow zip was read once, front to back, and released.
    expect(fake.opened).toEqual(['artifacts/zip']);
    expect(fake.read[0]).toBeLessThanOrEqual(zip.length);
  });

  it('streams: the first bytes go out before the overflow zip is read to its end', async () => {
    const packed = Array.from({ length: 40 }, (_, i) => ({
      name: `big/f${String(i).padStart(2, '0')}.bin`,
      data: Buffer.alloc(256 * 1024, i),
      store: true,
    }));
    const zip = makeZip(packed);
    const fake = store({ 'artifacts/big': zip }, 32 * 1024);
    const plan = await planFullArchive(
      [row('out-rest.zip', zip, { mediaType: 'application/zip', content: null, blobKey: 'artifacts/big' })],
      'out-rest.zip',
      fake.s,
    );
    const out = streamArchive(plan.sources, new Date(), plan.close);
    let seen = 0;
    let readAtFirstMiB = -1;
    for await (const c of out as AsyncIterable<Buffer>) {
      seen += c.length;
      if (readAtFirstMiB < 0 && seen >= 1024 * 1024) readAtFirstMiB = fake.read[0] ?? 0;
    }
    expect(seen).toBe(plan.archiveBytes);
    // After the first MiB went out, only about that much of the 10 MiB zip had been read.
    expect(readAtFirstMiB).toBeGreaterThan(0);
    expect(readAtFirstMiB).toBeLessThan(2 * 1024 * 1024);
    expect(zip.length).toBeGreaterThan(10 * 1024 * 1024);
  });

  it('collisions get numbered names; removed files are left out and named in a note', async () => {
    const zip = makeZip([
      { name: 'report.md', data: Buffer.from('from the zip') },
      { name: '_summary.md', data: Buffer.from('agent wrote this') },
    ]);
    const fake = store({ 'artifacts/z': zip });
    const plan = await planFullArchive(
      [
        row('summary.md', Buffer.from('# S\n'), { summary: true }),
        row('old.csv', Buffer.from('gone'), { content: null, prunedReason: 'retention' }),
        row('report.md', Buffer.from('stored')),
        row('out-rest.zip', zip, { mediaType: 'application/zip', content: null, blobKey: 'artifacts/z' }),
      ],
      'out-rest.zip',
      fake.s,
    );
    expect(plan.removed).toBe(1);
    const entries = unzip(await collect(streamArchive(plan.sources, new Date(), plan.close)));
    expect([...entries.keys()]).toEqual([
      '_summary.md',
      'report.md',
      'report (2).md',
      '_summary (2).md',
      '_removed-files.txt',
    ]);
    expect(entries.get('report.md')?.toString()).toBe('stored');
    expect(entries.get('report (2).md')?.toString()).toBe('from the zip');
    expect(entries.get('_removed-files.txt')?.toString()).toContain('old.csv\tretention');
    expect(entries.has('old.csv')).toBe(false);
  });

  it('an overflow zip it cannot read goes in as it is; no zip name: nothing unpacked', async () => {
    const broken = Buffer.from('PK not really a zip');
    const fake = store({ 'artifacts/b': broken });
    const errors: unknown[] = [];
    const plan = await planFullArchive(
      [row('out-rest.zip', broken, { mediaType: 'application/zip', content: null, blobKey: 'artifacts/b' })],
      'out-rest.zip',
      fake.s,
      (err) => errors.push(err),
    );
    expect(errors).toHaveLength(1);
    expect(plan.unpacked).toBeNull();
    expect(plan.sources.map((s) => s.name)).toEqual(['out-rest.zip']);
    // An agent's own zip (not the overflow) is never unpacked.
    const zip = makeZip([{ name: 'a.txt', data: Buffer.from('a') }]);
    const own = await planFullArchive(
      [row('mine.zip', zip, { mediaType: 'application/zip', content: null, blobKey: 'artifacts/z' })],
      null,
      store({ 'artifacts/z': zip }).s,
    );
    expect(own.sources.map((s) => s.name)).toEqual(['mine.zip']);
  });

  it('a damaged entry ends the archive with an error instead of a corrupt file', async () => {
    const zip = makeZip([{ name: 'a.txt', data: Buffer.from('hello hello hello hello'), store: true }]);
    const bad = Buffer.from(zip);
    bad[30 + 'a.txt'.length] = 0x58; // one byte of the body changed: the CRC no longer matches
    const fake = store({ 'artifacts/x': bad });
    const plan = await planFullArchive(
      [row('out-rest.zip', bad, { mediaType: 'application/zip', content: null, blobKey: 'artifacts/x' })],
      'out-rest.zip',
      fake.s,
    );
    await expect(collect(streamArchive(plan.sources, new Date(), plan.close))).rejects.toThrow(/CRC-32/);
  });
});
