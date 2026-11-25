import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkContent, checkManifest, describeRefusals } from '../../src/site-uploads/checks.js';
import { siteSha256 } from '../../src/site-uploads/service.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const MiB = 1024 * 1024;

describe('checkManifest (p10-site-upload)', () => {
  it('accepts a site with index.html at the root and returns content types', () => {
    const out = checkManifest([
      { path: 'index.html', size: 10, sha256: 'a'.repeat(64) },
      { path: 'v/clip.mp4', size: 20 * MiB, sha256: 'b'.repeat(64) },
    ]);
    expect(out).toEqual({
      ok: true,
      totalBytes: 20 * MiB + 10,
      manifest: [
        { path: 'index.html', size: 10, sha256: 'a'.repeat(64), contentType: 'text/html' },
        { path: 'v/clip.mp4', size: 20 * MiB, sha256: 'b'.repeat(64), contentType: 'video/mp4' },
      ],
    });
  });
  it('names every refused file with its reason', () => {
    const out = checkManifest([
      { path: 'index.html', size: 1, sha256: 'a'.repeat(64) },
      { path: 'index.html', size: 1, sha256: 'a'.repeat(64) },
      { path: 'big.webm', size: 25 * MiB + 1, sha256: 'a'.repeat(64) },
      { path: 'x.js', size: -1, sha256: 'a'.repeat(64) },
      { path: 'y.js', size: 1, sha256: 'nothex' },
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refused.map((r) => [r.path, r.reason.split(' (')[0]])).toEqual([
      ['index.html', 'listed twice'],
      ['big.webm', 'larger than 25 MiB'],
      ['x.js', 'invalid size'],
      ['y.js', 'invalid SHA-256'],
    ]);
  });
  it('refuses empty lists, too many files, too many bytes, empty sites and a missing index.html', () => {
    const f = (path: string, size = 1) => ({ path, size, sha256: 'a'.repeat(64) });
    expect(checkManifest([])).toMatchObject({ ok: false });
    const why = (files: Parameters<typeof checkManifest>[0]): string => {
      const out = checkManifest(files);
      return out.ok ? '' : describeRefusals(out.refused);
    };
    expect(why(Array.from({ length: 501 }, (_, i) => f(`${String(i)}.txt`)))).toContain('more than 500');
    expect(why([f('index.html'), f('a.mp4', 25 * MiB), f('b.mp4', 25 * MiB)])).toContain('at most 50 MiB');
    expect(why([f('index.html', 0)])).toContain('empty');
    expect(why([f('a/index.html')])).toContain('no index.html');
  });
});

describe('checkContent', () => {
  const entry = (path: string, content: Buffer, contentType: string) => ({
    path,
    size: content.length,
    sha256: sha(content),
    contentType,
  });
  it('refuses a size or hash mismatch', () => {
    const c = Buffer.from('<p>x</p>');
    expect(
      checkContent(entry('a.html', c, 'text/html'), Buffer.from('<p>y</p>'), sha(Buffer.from('<p>y</p>')))[0]
        ?.reason,
    ).toContain('SHA-256');
    expect(
      checkContent(entry('a.html', c, 'text/html'), Buffer.from('<p>'), sha(Buffer.from('<p>')))[0]?.reason,
    ).toContain('size');
  });
  it('secret-scans text types and names rule + line, never the value', () => {
    const token = `sk-ant-api03-${'x'.repeat(40)}`;
    const c = Buffer.from(`line1\nline2 ${token}\n`);
    const out = checkContent(entry('app.js', c, 'application/javascript'), c, sha(c));
    expect(out).toEqual([
      { path: 'app.js', reason: 'looks like it contains a secret', rule: 'anthropic-key', line: 2 },
    ]);
    expect(JSON.stringify(out)).not.toContain(token);
    expect(describeRefusals(out)).toBe('app.js line 2: looks like it contains a secret (anthropic-key)');
  });
  it('does not secret-scan binaries (checked by magic bytes instead)', () => {
    const c = Buffer.concat([
      Buffer.from('\0\0\0\x18ftypisom', 'latin1'),
      Buffer.from(`ghp_${'a'.repeat(36)}`),
    ]);
    expect(checkContent(entry('c.mp4', c, 'video/mp4'), c, sha(c))).toEqual([]);
  });
});

describe('siteSha256', () => {
  it('depends on paths and hashes', () => {
    const a = siteSha256([{ path: 'a', sha256: '1' }]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(siteSha256([{ path: 'b', sha256: '1' }])).not.toBe(a);
  });
});
