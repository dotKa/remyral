import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  HttpsLink,
  ItemMetaUpdate,
  NoteCardInput,
  parseItemKey,
  previewKindOf,
  Tags,
} from '../../src/outputs/model.js';
import { likePattern } from '../../src/outputs/service.js';
import { uniquePaths, zipPath, zipStream } from '../../src/outputs/zip.js';

const JOB = '0b3c8f5e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';

async function collect(gen: AsyncGenerator<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of gen) parts.push(b);
  return Buffer.concat(parts);
}

async function* from<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const i of items) yield await Promise.resolve(i);
}

describe('outputs item keys (p6-outputs)', () => {
  it('parses site, file and run keys and refuses everything else', () => {
    expect(parseItemKey('site:pages:acme-site:preview')).toEqual({
      kind: 'site',
      target: 'pages:acme-site',
      env: 'preview',
    });
    expect(parseItemKey('site:coolify:0123456789abcdef:production')).toMatchObject({ kind: 'site' });
    expect(parseItemKey(`file:${JOB}:ws-report-md`)).toEqual({
      kind: 'file',
      jobId: JOB,
      artifactId: 'ws-report-md',
    });
    expect(parseItemKey(`run:${JOB}:diff-abc:1`)).toEqual({
      kind: 'run',
      jobId: JOB,
      artifactId: 'diff-abc:1',
    });
    for (const bad of [
      '',
      'site:pages:Acme:preview',
      'site:pages:acme:staging',
      `file:${JOB}:report.md`,
      `file:not-a-uuid:ws-a`,
      `run:${JOB}:`,
      'note:abc',
      `file:${JOB}:ws-a/../b`,
    ]) {
      expect(parseItemKey(bad), bad).toBeNull();
    }
  });

  it('escapes LIKE wildcards in search text', () => {
    expect(likePattern('100%_done\\')).toBe('%100\\%\\_done\\\\%');
  });

  it('decides the preview kind from the media type; run artifacts only preview the attempt diff', () => {
    expect(previewKindOf('text/markdown', 'a.md', 'workspace')).toBe('markdown');
    expect(previewKindOf('text/csv', 'a.csv', 'workspace')).toBe('csv');
    expect(previewKindOf('text/tab-separated-values', 'a.tsv', 'workspace')).toBe('tsv');
    expect(previewKindOf('application/json', 'a.json', 'workspace')).toBe('json');
    expect(previewKindOf('text/yaml', 'a.yaml', 'workspace')).toBe('text');
    expect(previewKindOf('application/pdf', 'a.pdf', 'workspace')).toBe('pdf');
    expect(previewKindOf('image/webp', 'a.webp', 'workspace')).toBe('image');
    expect(previewKindOf('image/svg+xml', 'a.svg', 'workspace')).toBe('none');
    expect(previewKindOf('text/html', 'a.html', 'workspace')).toBe('none');
    expect(previewKindOf('text/x-diff', 'attempt.diff', 'run')).toBe('diff');
    expect(previewKindOf('text/plain', 'notes.txt', 'run')).toBe('none');
  });

  it('accepts only https links without credentials; tags are trimmed, deduplicated and bounded', () => {
    expect(HttpsLink.safeParse('https://example.com/a?b=1').success).toBe(true);
    for (const bad of [
      'http://example.com',
      'javascript:alert(1)',
      'https://u:p@example.com',
      'data:text/html,x',
      '//x',
    ]) {
      expect(HttpsLink.safeParse(bad).success, bad).toBe(false);
    }
    expect(Tags.parse([' Q4 ', 'Q4', 'araştırma'])).toEqual(['Q4', 'araştırma']);
    expect(Tags.safeParse(['<b>']).success).toBe(false);
    expect(Tags.safeParse(Array.from({ length: 21 }, (_, i) => `t${String(i)}`)).success).toBe(false);
    expect(ItemMetaUpdate.safeParse({ project: 'p', key: 'x' }).success).toBe(false);
    expect(NoteCardInput.parse({ project: 'p', title: '  Plan ' })).toMatchObject({
      title: 'Plan',
      body: '',
      tags: [],
      links: [],
      pinned: false,
    });
    expect(NoteCardInput.safeParse({ project: 'p', title: '   ' }).success).toBe(false);
    expect(NoteCardInput.safeParse({ project: 'p', title: 'x', body: 'a\u0000b' }).success).toBe(false);
  });
});

describe('outputs zip (p6-outputs)', () => {
  it('sanitises archive paths against zip-slip and makes them unique', () => {
    expect(zipPath('0b3c8f5e', 'report.md')).toBe('0b3c8f5e/report.md');
    expect(zipPath('0b3c8f5e', '../../etc/passwd')).toBe('0b3c8f5e/etc/passwd');
    expect(zipPath('0b3c8f5e', '/abs\\win\\x.txt')).toBe('0b3c8f5e/abs/win/x.txt');
    expect(zipPath('j', 'a\u0000b:c?.md')).toBe('j/a_b_c_.md');
    expect(zipPath('j', 'a/b/c/d/e/f/g/h/i/j.md').split('/')).toHaveLength(8);
    expect(uniquePaths(['j/a.md', 'j/A.md', 'j/a.md', 'j/noext'])).toEqual([
      'j/a.md',
      'j/A (2).md',
      'j/a (3).md',
      'j/noext',
    ]);
  });

  it('writes a valid stored ZIP (CRC, sizes, central directory) that unzip accepts', async () => {
    const entries = [
      { name: 'a/hello.txt', data: Buffer.from('hello\n'), modified: new Date('2026-10-16T12:34:56Z') },
      { name: 'a/çıktı.md', data: Buffer.from('# Türkçe\n'), modified: new Date('2026-10-16T00:00:00Z') },
      { name: 'empty.txt', data: Buffer.alloc(0), modified: new Date('2026-01-01T00:00:00Z') },
    ];
    const zip = await collect(zipStream(from(entries)));
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(3);
    let cd = zip.readUInt32LE(end + 16);
    for (const e of entries) {
      expect(zip.readUInt32LE(cd)).toBe(0x02014b50);
      expect(zip.readUInt32LE(cd + 16)).toBe(crc32(e.data) >>> 0);
      expect(zip.readUInt32LE(cd + 20)).toBe(e.data.length);
      const nameLen = zip.readUInt16LE(cd + 28);
      expect(zip.subarray(cd + 46, cd + 46 + nameLen).toString('utf8')).toBe(e.name);
      cd += 46 + nameLen;
    }
    // The system unzip (macOS / Linux CI) verifies CRCs and the structure when available.
    const dir = mkdtempSync(join(tmpdir(), 'outputs-zip-'));
    try {
      const file = join(dir, 'x.zip');
      writeFileSync(file, zip);
      let out: string | null = null;
      try {
        out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (out !== null) expect(out).toMatch(/No errors detected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an empty archive is still valid', async () => {
    const zip = await collect(zipStream(from([])));
    expect(zip).toHaveLength(22);
    expect(zip.readUInt32LE(0)).toBe(0x06054b50);
  });
});
