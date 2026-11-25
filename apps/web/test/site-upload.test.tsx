import { configure } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { SiteUpload } from '../src/api/siteUploads';
import { planSite, uploadSite } from '../src/lib/siteUpload';
import { crc32, readZip, ZipError } from '../src/lib/siteZip';

/**
 * p10-site-upload: Project → Deploy → "Upload a site" — the plan shown before sending (root folder removed, refused
 * files with reasons, OS litter left out, index.html required), the browser-side .zip reader (zip-slip names refused
 * by the path rules, symlinks, bombs, damaged archives), the chunked upload (parts, retries, resume) and the card
 * (pick → list → upload → refused files from the master → Deploy to preview / production with the Pages project).
 */

configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const blob = (s: string | Uint8Array) => new Blob([s as BlobPart]);
const MP4 = Uint8Array.from(Buffer.from('\0\0\0\x18ftypisom0000', 'latin1'));

describe('planSite', () => {
  it('removes the shared top folder, leaves OS litter out and refuses what the master would refuse', () => {
    const plan = planSite([
      { path: 'deck/index.html', blob: blob('<p>x</p>') },
      { path: 'deck/clips/a.mp4', blob: blob(MP4) },
      { path: 'deck/.DS_Store', blob: blob('x') },
      { path: 'deck/.env', blob: blob('A=1') },
      { path: 'deck/run.sh', blob: blob('x') },
      { path: 'deck/a/b/c/d/e/f/g/h/i.html', blob: blob('x') },
    ]);
    expect(plan.strippedRoot).toBe('deck');
    expect(plan.files.map((f) => f.path)).toEqual(['clips/a.mp4', 'index.html']);
    expect(plan.skipped).toBe(1);
    expect(plan.refused).toEqual([
      { path: '.env', reason: 'hidden file or folder' },
      { path: 'run.sh', reason: 'file type not allowed in a site' },
      { path: 'a/b/c/d/e/f/g/h/i.html', reason: 'nested too deep' },
    ]);
    expect(plan.problems).toEqual([]);
    expect(plan.totalBytes).toBe(8 + MP4.length);
  });
  it('needs index.html at the root; keeps a flat site as it is', () => {
    expect(planSite([{ path: 'a/page.html', blob: blob('x') }]).problems).toEqual([
      'The site has no index.html at its root.',
    ]);
    const flat = planSite([
      { path: 'index.html', blob: blob('x') },
      { path: 'css/a.css', blob: blob('x') },
    ]);
    expect(flat.strippedRoot).toBeNull();
    expect(flat.problems).toEqual([]);
    expect(planSite([]).problems).toEqual(['No site files were found.']);
  });
});

/** A minimal .zip writer for the tests (stored / deflated entries, optional Unix mode, overrides). */
function zip(
  entries: {
    name: string;
    data: Uint8Array;
    deflate?: boolean;
    mode?: number;
    declared?: number;
    crc?: number;
  }[],
): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = e.deflate === true ? deflateRawSync(e.data) : Buffer.from(e.data);
    const crc = e.crc ?? crc32(e.data);
    const usize = e.declared ?? e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.deflate === true ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.deflate === true ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...locals, cd, end]));
}

const text = (s: string) => Uint8Array.from(Buffer.from(s, 'utf8'));

describe('readZip (in the browser; the master never unpacks archives)', () => {
  it('reads stored and deflated entries; zip-slip names reach the path rules and are refused there', async () => {
    const z = zip([
      { name: 'site/', data: new Uint8Array() },
      { name: 'site/index.html', data: text('<h1>hi</h1>'.repeat(50)), deflate: true },
      { name: 'site/clip.mp4', data: MP4 },
      { name: 'site/../../evil.html', data: text('x') },
      { name: '__MACOSX/site/._index.html', data: text('x') },
    ]);
    const out = await readZip(blob(z));
    expect(out.skipped).toEqual(['__MACOSX/site/._index.html']);
    expect(out.entries.map((e) => e.path)).toEqual([
      'site/index.html',
      'site/clip.mp4',
      'site/../../evil.html',
    ]);
    const plan = planSite(out.entries);
    expect(plan.files.map((f) => f.path)).toEqual(['clip.mp4', 'index.html']);
    expect(plan.refused).toEqual([{ path: '../../evil.html', reason: 'unsafe path segment' }]);
    const html = plan.files.find((f) => f.path === 'index.html');
    expect(html?.size).toBe(11 * 50);
  });
  it('refuses symlinks, oversized and suspiciously compressible entries without inflating them', async () => {
    const out = await readZip(
      blob(
        zip([
          { name: 'index.html', data: text('ok') },
          { name: 'link.html', data: text('/etc/passwd'), mode: 0o120777 },
          { name: 'big.mp4', data: MP4, declared: 26 * 1024 * 1024 },
          { name: 'bomb.txt', data: new Uint8Array(1024 * 1024), deflate: true },
        ]),
      ),
    );
    expect(out.entries.map((e) => e.path)).toEqual(['index.html']);
    expect(out.refused).toEqual([
      { path: 'link.html', reason: 'symbolic link' },
      { path: 'big.mp4', reason: 'larger than 25 MiB' },
      { path: 'bomb.txt', reason: 'suspicious compression ratio' },
    ]);
  });
  it('stops an entry that inflates beyond its declared size, and refuses a bad checksum or a non-zip', async () => {
    const big = text('a'.repeat(100));
    await expect(
      readZip(blob(zip([{ name: 'a.txt', data: big, deflate: true, declared: 50 }]))),
    ).rejects.toThrow(ZipError);
    await expect(readZip(blob(zip([{ name: 'a.txt', data: text('abc'), crc: 1 }])))).rejects.toThrow(
      /checksum/,
    );
    await expect(readZip(blob('not a zip at all, just text'))).rejects.toThrow(/Not a .zip/);
  });
});

const NOW = '2026-10-18T08:00:00.000Z';
const UP = '33333333-3333-4333-8333-333333333333';
function upload(over: Partial<SiteUpload> = {}): Record<string, unknown> {
  return {
    id: UP,
    project: 'genel',
    state: 'ready',
    label: 'deck',
    fileCount: 2,
    totalBytes: 100,
    partSize: 4 * 1024 * 1024,
    partCount: 1,
    received: null,
    siteSha256: 'a'.repeat(64),
    uploadedBy: { id: 'u1', username: 'alex' },
    createdAt: NOW,
    expiresAt: null,
    completedAt: NOW,
    lastDeployedAt: null,
    lastActionId: null,
    files: null,
    ...over,
  };
}

describe('uploadSite', () => {
  const sha = (d: ArrayBuffer) => Promise.resolve(createHash('sha256').update(Buffer.from(d)).digest('hex'));
  it('hashes, starts with the file list, sends parts with their SHA-256 (retrying transient failures), completes', async () => {
    const files = planSite([
      { path: 'index.html', blob: blob('<p>hello</p>') },
      { path: 'b.css', blob: blob('body{}') },
    ]).files;
    const parts: { n: number; hash: string; size: number }[] = [];
    let fails = 1;
    const api = {
      start: vi.fn(
        (_p: string, input: { files: readonly { path: string; size: number; sha256: string }[] }) => {
          expect(input.files.map((f) => f.path)).toEqual(['b.css', 'index.html']);
          return Promise.resolve(
            upload({ state: 'receiving', partSize: 8, partCount: 3, received: [] }) as unknown as SiteUpload,
          );
        },
      ),
      status: vi.fn(),
      putPart: vi.fn((_p: string, _id: string, n: number, bytes: Blob | ArrayBuffer, hash: string) => {
        if (n === 1 && fails-- > 0) return Promise.reject(new ApiError(503, 'unavailable', 'try later'));
        parts.push({ n, hash, size: (bytes as ArrayBuffer).byteLength });
        return Promise.resolve({ n, received: parts.length });
      }),
      complete: vi.fn(() => Promise.resolve(upload() as unknown as SiteUpload)),
    };
    const out = await uploadSite('genel', files, {
      api,
      partSize: 8,
      digest: sha,
      sleep: () => Promise.resolve(),
    });
    expect(out.state).toBe('ready');
    expect(parts.map((p) => [p.n, p.size])).toEqual([
      [0, 8],
      [1, 8],
      [2, 2],
    ]);
    const all = Buffer.from('body{}<p>hello</p>');
    expect(parts[1]?.hash).toBe(createHash('sha256').update(all.subarray(8, 16)).digest('hex'));
    expect(api.complete).toHaveBeenCalledTimes(1);
  });
  it('resumes: only the parts the master lacks are sent', async () => {
    const files = planSite([{ path: 'index.html', blob: blob('0123456789abcdef') }]).files;
    const sent: number[] = [];
    const api = {
      start: vi.fn(),
      status: vi.fn(() =>
        Promise.resolve(
          upload({ state: 'receiving', partSize: 8, partCount: 2, received: [0] }) as unknown as SiteUpload,
        ),
      ),
      putPart: vi.fn((_p: string, _id: string, n: number) => {
        sent.push(n);
        return Promise.resolve({ n, received: 2 });
      }),
      complete: vi.fn(() => Promise.resolve(upload() as unknown as SiteUpload)),
    };
    await uploadSite('genel', files, { api, resumeId: UP, digest: sha });
    expect(api.start).not.toHaveBeenCalled();
    expect(sent).toEqual([1]);
  });
});
