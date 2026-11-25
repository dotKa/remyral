import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { Redactor, SecretSet } from '@remyral/observability';
import type { AssignedBlobUpload } from '@remyral/protocol';
import { OUTPUT_LIMITS, OutputReport } from '@remyral/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectArtifacts,
  outputReport,
  summaryMarkdown,
  workspacePreamble,
} from '../src/jobs/workspace-job.js';
import { OverflowZip, ZipFullError } from '../src/workspace/out-zip.js';

/** p17-output-limits: count over inline + blob, bytes decide the path, the overflow zip, the report. */

const MiB = 1024 * 1024;
const BLOB: AssignedBlobUpload = {
  thresholdBytes: 8 * MiB,
  maxFileBytes: 64 * MiB,
  maxJobBytes: 100 * MiB,
  maxFiles: 500,
  partBytes: 8 * MiB,
};

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'output-limits-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function dirs(): Promise<{ out: string; zipDir: string }> {
  const base = await mkdtemp(join(root, 'case-'));
  const out = join(base, 'out');
  const zipDir = join(base, 'zip');
  await mkdir(out);
  await mkdir(zipDir);
  return { out, zipDir };
}

/** A minimal zip reader (central directory → entries), enough to check what the writer produced. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(-1);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const lname = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + lname, local + 30 + lname + csize);
    const plain = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    expect(crc32(plain) >>> 0).toBe(crc);
    out.set(name, plain);
    at += 46 + nameLen;
  }
  return out;
}

describe('collection under execution.outputLimits', () => {
  it('counts inline and blob files together; without zip the rest is named with code count', async () => {
    const { out } = await dirs();
    for (let i = 0; i < 8; i++) await writeFile(join(out, `f${String(i)}.txt`), `file ${String(i)}\n`);
    const c = await collectArtifacts(out, new Redactor(), BLOB, {
      limits: { maxFiles: 5, zipOverflow: false },
    });
    expect(c.files.length + (c.big ?? []).length).toBe(5);
    expect(c.zip).toBeUndefined();
    expect(c.skipped.filter((s) => s.code === 'count').map((s) => s.name)).toEqual([
      'f5.txt',
      'f6.txt',
      'f7.txt',
    ]);
  });

  it('packs the files beyond the limit into out-rest.zip (paths kept, text redacted); the zip takes one slot', async () => {
    const { out, zipDir } = await dirs();
    const secrets = new SecretSet();
    secrets.add('canary-VALUE-0123456789', 'MY_TOKEN');
    await mkdir(join(out, 'charts'));
    for (let i = 0; i < 6; i++) await writeFile(join(out, `a${String(i)}.md`), `# ${String(i)}\n`);
    await writeFile(join(out, 'charts', 'z1.csv'), 'a,b\n1,2\n');
    await writeFile(join(out, 'charts', 'z2.txt'), 'token canary-VALUE-0123456789 here\n');
    const c = await collectArtifacts(out, new Redactor({ secrets }), BLOB, {
      limits: { maxFiles: 5, zipOverflow: true },
      zipDir,
    });
    // 4 in place + the zip = 5.
    expect(c.files.map((f) => f.name)).toEqual(['a0.md', 'a1.md', 'a2.md', 'a3.md']);
    expect(c.zip?.name).toBe('out-rest.zip');
    expect(c.zip?.files).toEqual(['a4.md', 'a5.md', 'charts/z1.csv', 'charts/z2.txt']);
    expect((c.big ?? []).map((b) => b.name)).toEqual(['out-rest.zip']);
    const entries = readZip(await readFile(c.zip?.path ?? ''));
    expect([...entries.keys()]).toEqual(['a4.md', 'a5.md', 'charts/z1.csv', 'charts/z2.txt']);
    expect(entries.get('charts/z1.csv')?.toString()).toBe('a,b\n1,2\n');
    const redacted = entries.get('charts/z2.txt')?.toString() ?? '';
    expect(redacted).not.toContain('canary-VALUE-0123456789');
    expect(redacted).toContain('[REDACTED:MY_TOKEN]');
    expect(c.skipped).toEqual([]);
  });

  it('a numbered zip name when the agent wrote out-rest.zip itself', async () => {
    const { out, zipDir } = await dirs();
    const own = randomBytes(64);
    own.set([0x50, 0x4b, 0x03, 0x04], 0);
    await writeFile(join(out, 'out-rest.zip'), own);
    for (let i = 0; i < 4; i++) await writeFile(join(out, `b${String(i)}.txt`), 'x');
    const c = await collectArtifacts(out, new Redactor(), BLOB, {
      limits: { maxFiles: 3, zipOverflow: true },
      zipDir,
    });
    expect(c.zip?.name).toBe('out-rest-2.zip');
  });

  it('never follows a symbolic link into the zip; a secret binary is dropped from it', async () => {
    const { out, zipDir } = await dirs();
    const outside = join(root, 'outside-secret.txt');
    await writeFile(outside, 'not for the zip\n');
    await mkdir(join(root, 'outside-dir'), { recursive: true });
    await writeFile(join(root, 'outside-dir', 'inner.txt'), 'nope\n');
    await writeFile(join(out, 'a.txt'), 'a');
    await writeFile(join(out, 'b.txt'), 'b');
    await symlink(outside, join(out, 'c-link.txt'));
    await symlink(join(root, 'outside-dir'), join(out, 'd-dir'));
    const leak = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(`sk-ant-api03-${'A'.repeat(90)}\n`)]);
    await writeFile(join(out, 'e.pdf'), leak);
    await writeFile(join(out, 'f.txt'), 'f');
    const c = await collectArtifacts(out, new Redactor(), BLOB, {
      limits: { maxFiles: 2, zipOverflow: true },
      zipDir,
    });
    const codes = Object.fromEntries(c.skipped.map((s) => [s.name, s.code]));
    expect(codes['c-link.txt']).toBe('symlink');
    expect(codes['d-dir']).toBe('symlink');
    expect(codes['e.pdf']).toBe('secret');
    const entries = readZip(await readFile(c.zip?.path ?? ''));
    expect([...entries.keys()]).toEqual(['b.txt', 'f.txt']);
    for (const v of entries.values()) expect(v.toString()).not.toContain('not for the zip');
  });

  it('the zip is bounded by the per-job bytes: what does not fit is named zip_full', async () => {
    const { out, zipDir } = await dirs();
    // Incompressible files: 3 × 400 KiB, but only ~1 MiB left for the zip.
    await writeFile(join(out, 'big0.zip'), Buffer.concat([Buffer.from('PK\x03\x04'), randomBytes(1000)]));
    for (let i = 0; i < 3; i++) {
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        randomBytes(400 * 1024),
      ]);
      await writeFile(join(out, `p${String(i)}.png`), png);
    }
    const blob = { ...BLOB, maxJobBytes: 1004 + 900 * 1024 };
    const c = await collectArtifacts(out, new Redactor(), blob, {
      limits: { maxFiles: 2, zipOverflow: true },
      zipDir,
    });
    expect((c.big ?? []).map((b) => b.name)).toEqual(['big0.zip', 'out-rest.zip']);
    expect(c.zip?.files).toEqual(['p0.png', 'p1.png']);
    expect(c.zip?.size).toBeLessThanOrEqual(900 * 1024);
    expect(c.skipped.map((s) => [s.name, s.code])).toEqual([['p2.png', 'zip_full']]);
  });

  it('entries above the zip entry bound are named too_large', async () => {
    const { out, zipDir } = await dirs();
    await writeFile(join(out, 'a.txt'), 'a');
    await writeFile(join(out, 'b.csv'), Buffer.alloc(OUTPUT_LIMITS.zipEntryMaxBytes + 1, 0x61));
    await writeFile(join(out, 'c.txt'), 'c');
    const c = await collectArtifacts(
      out,
      new Redactor(),
      { ...BLOB, maxFileBytes: 200 * MiB, maxJobBytes: 300 * MiB, thresholdBytes: 512 * MiB },
      { limits: { maxFiles: 2, zipOverflow: true }, zipDir },
    );
    expect(c.zip?.files).toEqual(['c.txt']);
    expect(c.skipped.find((s) => s.name === 'b.csv')?.code).toBe('too_large');
  });

  it('bytes decide the path: beyond 5 MiB per file or 15 MiB in total a file goes to the blob store', async () => {
    const { out } = await dirs();
    await writeFile(join(out, 'big.txt'), Buffer.alloc(6 * MiB, 0x61));
    for (let i = 0; i < 4; i++) await writeFile(join(out, `m${String(i)}.csv`), Buffer.alloc(4 * MiB, 0x62));
    const c = await collectArtifacts(out, new Redactor(), BLOB, {
      limits: { maxFiles: 500, zipOverflow: true },
    });
    expect(c.files.map((f) => f.name)).toEqual(['m0.csv', 'm1.csv', 'm2.csv']);
    expect((c.big ?? []).map((b) => b.name)).toEqual(['big.txt', 'm3.csv']);
    expect(c.skipped).toEqual([]);
  });

  it('without a blob store: inline only, the inline budget decides, nothing is zipped', async () => {
    const { out, zipDir } = await dirs();
    await writeFile(join(out, 'big.txt'), Buffer.alloc(6 * MiB, 0x61));
    for (let i = 0; i < 4; i++) await writeFile(join(out, `m${String(i)}.csv`), Buffer.alloc(4 * MiB, 0x62));
    const own = randomBytes(64);
    own.set([0x50, 0x4b, 0x03, 0x04], 0);
    await writeFile(join(out, 'pack.zip'), own);
    for (let i = 0; i < 30; i++) await writeFile(join(out, `s${String(i).padStart(2, '0')}.md`), 'x');
    const c = await collectArtifacts(out, new Redactor(), null, {
      limits: { maxFiles: 500, zipOverflow: true },
      zipDir,
    });
    expect(c.big).toBeUndefined();
    expect(c.zip).toBeUndefined();
    // 30 small files + 3 of the 4 MiB files: well above the legacy 20.
    expect(c.files).toHaveLength(33);
    const codes = Object.fromEntries(c.skipped.map((s) => [s.name, s.code]));
    expect(codes['big.txt']).toBe('too_large');
    expect(codes['m3.csv']).toBe('inline_budget');
    expect(codes['pack.zip']).toBe('inline_budget');
  });

  it('500 small files are returned under the default limit', async () => {
    const { out } = await dirs();
    await mkdir(join(out, 'data'));
    for (let i = 0; i < 520; i++)
      await writeFile(join(out, 'data', `r${String(i).padStart(4, '0')}.json`), '{}');
    const c = await collectArtifacts(out, new Redactor(), BLOB, {
      limits: { maxFiles: 500, zipOverflow: false },
    });
    expect(c.files).toHaveLength(500);
    expect(c.skipped).toHaveLength(20);
  });

  it('flag off (no outputLimits): the legacy 20 files, no zip', async () => {
    const { out, zipDir } = await dirs();
    for (let i = 0; i < 25; i++) await writeFile(join(out, `n${String(i).padStart(2, '0')}.txt`), 'x');
    const c = await collectArtifacts(out, new Redactor(), BLOB, { zipDir });
    expect(c.files).toHaveLength(20);
    expect(c.zip).toBeUndefined();
    expect(c.skipped.every((s) => s.code === 'count' && s.reason === 'more than 20 files')).toBe(true);
  });
});

describe('overflow zip writer', () => {
  it('refuses an entry over the byte bound and beyond the entry count without writing it', async () => {
    const dir = await mkdtemp(join(root, 'zip-'));
    const z = await OverflowZip.create(join(dir, 'a.zip'), { maxBytes: 300, maxEntries: 2 });
    await z.add('one.txt', Buffer.from('1'), 'text/plain');
    await expect(z.add('big.bin', randomBytes(400), 'image/png')).rejects.toBeInstanceOf(ZipFullError);
    await z.add('two/three.txt', Buffer.from('3'), 'text/plain');
    await expect(z.add('four.txt', Buffer.from('4'), 'text/plain')).rejects.toBeInstanceOf(ZipFullError);
    await expect(z.add('../x.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow(/invalid/);
    const size = await z.close();
    const buf = await readFile(join(dir, 'a.zip'));
    expect(buf.length).toBe(size);
    expect(size).toBeLessThanOrEqual(300);
    expect([...readZip(buf).keys()]).toEqual(['one.txt', 'two/three.txt']);
  });
});

describe('report, summary and preamble', () => {
  it('the report lists at most 100 skipped files with an exact count', () => {
    const skipped = Array.from({ length: 130 }, (_, i) => ({
      name: `f${String(i)}.txt`,
      code: 'count' as const,
      reason: 'more than 5 files',
    }));
    const r = outputReport(5, true, {
      returned: 5,
      zip: { name: 'out-rest.zip', files: 3, bytes: 99 },
      skipped,
    });
    expect(OutputReport.parse(r)).toEqual(r);
    expect(r.skipped).toHaveLength(100);
    expect(r.skippedCount).toBe(130);
    expect(r.zip).toEqual({ name: 'out-rest.zip', files: 3, bytes: 99 });
  });

  it('the summary names the zipped files', () => {
    const md = summaryMarkdown({
      outcome: 'succeeded',
      summary: 'ok',
      files: [],
      zip: { name: 'out-rest.zip', files: ['a.md', 'b/c.md'] },
      skipped: [{ name: 'x.html', code: 'type', reason: 'file type or name not allowed' }],
    }).toString();
    expect(md).toContain('## Packed into out-rest.zip');
    expect(md).toContain('- b/c.md');
    expect(md).toContain('- x.html: file type or name not allowed');
  });

  it('the preamble tells the agent the limit and the automatic zip; without storage it says so', () => {
    const withZip = workspacePreamble([], 'none', {
      blob: BLOB,
      outputLimits: { maxFiles: 500, zipOverflow: true },
    });
    expect(withZip).toContain('at most 500 files');
    expect(withZip).toContain('packed automatically into one out-rest.zip');
    expect(withZip).toContain('you may also deliver one .zip of your own');
    const noStore = workspacePreamble([], 'none', { outputLimits: { maxFiles: 300, zipOverflow: true } });
    expect(noStore).toContain('at most 300 files');
    expect(noStore).toContain('there is no file storage for this job');
    expect(noStore).not.toContain('out-rest.zip');
    // Flag off: the legacy sentence.
    expect(workspacePreamble([], 'none', {})).toContain('at most 20 files');
  });
});
