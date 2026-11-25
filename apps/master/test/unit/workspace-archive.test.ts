import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { archiveOverhead, streamArchive, uniqueName } from '../../src/workspaces/archive.js';

/** p17-output-limits: "Hepsini indir (zip)" — the streamed archive writer. */

async function collect(r: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of r as AsyncIterable<Buffer>) parts.push(c);
  return Buffer.concat(parts);
}

function entries(buf: Buffer): Map<string, { data: Buffer; crc: number }> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, { data: Buffer; crc: number }>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt16LE(at + 8) & 0x0008).toBe(0x0008);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const lname = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + lname, local + 30 + lname + size);
    // The data descriptor follows the bytes.
    expect(buf.readUInt32LE(local + 30 + lname + size)).toBe(0x08074b50);
    out.set(name, { data: Buffer.from(data), crc });
    at += 46 + nameLen;
  }
  return out;
}

describe('streamed archive', () => {
  it('writes stored entries with data descriptors from buffers and streams; the size matches the overhead', async () => {
    const a = Buffer.from('# Summary\n');
    const b = Buffer.alloc(300_000, 7);
    const buf = await collect(
      streamArchive([
        { name: '_summary.md', sizeBytes: a.length, open: () => Promise.resolve(a) },
        {
          name: 'data/b.bin',
          sizeBytes: b.length,
          open: () => Promise.resolve(Readable.from([b.subarray(0, 1000), b.subarray(1000)])),
        },
      ]),
    );
    const e = entries(buf);
    expect([...e.keys()]).toEqual(['_summary.md', 'data/b.bin']);
    expect(e.get('data/b.bin')?.data.equals(b)).toBe(true);
    expect(e.get('data/b.bin')?.crc).toBe(crc32(b) >>> 0);
    expect(buf.length).toBe(a.length + b.length + archiveOverhead(['_summary.md', 'data/b.bin']));
  });

  it('fails instead of writing a corrupt entry when a blob is not the recorded size', async () => {
    const r = streamArchive([
      { name: 'x.txt', sizeBytes: 5, open: () => Promise.resolve(Readable.from([Buffer.from('too long')])) },
    ]);
    await expect(collect(r)).rejects.toThrow(/larger than recorded/);
    const short = streamArchive([
      { name: 'y.txt', sizeBytes: 5, open: () => Promise.resolve(Buffer.from('abc')) },
    ]);
    await expect(collect(short)).rejects.toThrow(/not the recorded size/);
  });

  it('names stay unique', () => {
    const taken = new Set<string>();
    expect(uniqueName('summary.md', taken)).toBe('summary.md');
    expect(uniqueName('summary.md', taken)).toBe('summary (2).md');
    expect(uniqueName('a/README', taken)).toBe('a/README');
    expect(uniqueName('a/README', taken)).toBe('a/README (2)');
  });
});
