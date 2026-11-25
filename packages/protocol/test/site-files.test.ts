import { describe, expect, it } from 'vitest';
import { SITE_FILE_TYPES, siteFileType, siteMagicProblem, sitePathProblem } from '../src/site-files.js';
import { SitePath, SITE_FILE_TYPES as FROM_WORKSPACE } from '../src/workspace.js';

describe('site file types (p10-site-upload)', () => {
  it('include mp4 and webm, shared with the job site bundle', () => {
    expect(siteFileType('clips/a.MP4')).toBe('video/mp4');
    expect(siteFileType('b.webm')).toBe('video/webm');
    expect(siteFileType('x.exe')).toBeNull();
    expect(siteFileType('noext')).toBeNull();
    expect(siteFileType('dir.mp4/file')).toBeNull();
    expect(FROM_WORKSPACE).toBe(SITE_FILE_TYPES);
    expect(SitePath.safeParse('clips/a.mp4').success).toBe(true);
  });
});

describe('sitePathProblem', () => {
  it('accepts safe relative paths up to 8 segments', () => {
    for (const ok of [
      'index.html',
      'a/b/c.css',
      'img/logo (1).png',
      'a/b/c/d/e/f/g/h.html',
      '_next/app@2.js',
    ]) {
      expect(sitePathProblem(ok), ok).toBeNull();
    }
  });
  it('refuses traversal, absolute, backslash, hidden, deep, odd characters and other types', () => {
    const cases: [string, string][] = [
      ['../a.html', 'unsafe path segment'],
      ['a/../../b.html', 'unsafe path segment'],
      ['a//b.html', 'unsafe path segment'],
      ['./a.html', 'unsafe path segment'],
      ['/etc/a.html', 'not a relative path'],
      ['C:/a.html', 'not a relative path'],
      ['a\\b.html', 'not a relative path'],
      ['.env', 'hidden file or folder'],
      ['.well-known/x.txt', 'hidden file or folder'],
      ['a/.git/b.txt', 'hidden file or folder'],
      ['a/b/c/d/e/f/g/h/i.html', 'nested too deep'],
      ['a$b.html', 'name has characters that are not allowed'],
      ['a\nb.html', 'name has characters that are not allowed'],
      ['run.sh', 'file type not allowed in a site'],
      ['', 'empty path'],
      [`${'a'.repeat(301)}.html`, 'path too long'],
    ];
    for (const [path, reason] of cases) expect(sitePathProblem(path), path).toBe(reason);
  });
});

describe('siteMagicProblem', () => {
  const b = (...x: number[]) => Uint8Array.from(x);
  const s = (t: string) => Uint8Array.from(Buffer.from(t, 'latin1'));
  it('checks binary types by their first bytes', () => {
    expect(siteMagicProblem('video/mp4', s('\0\0\0\x18ftypisom'))).toBeNull();
    expect(siteMagicProblem('video/mp4', s('MZ\x90\0'))).toBe('content is not a video/mp4 file');
    expect(siteMagicProblem('video/webm', b(0x1a, 0x45, 0xdf, 0xa3, 0))).toBeNull();
    expect(siteMagicProblem('image/png', b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBeNull();
    expect(siteMagicProblem('image/png', s('GIF89a'))).not.toBeNull();
    expect(siteMagicProblem('image/jpeg', b(0xff, 0xd8, 0xff, 0xe0))).toBeNull();
    expect(siteMagicProblem('image/gif', s('GIF87a'))).toBeNull();
    expect(siteMagicProblem('image/webp', s('RIFF\0\0\0\0WEBPVP8 '))).toBeNull();
    expect(siteMagicProblem('image/avif', s('\0\0\0\x1cftypavif'))).toBeNull();
    expect(siteMagicProblem('font/woff2', s('wOF2'))).toBeNull();
    expect(siteMagicProblem('font/woff', s('wOF2'))).not.toBeNull();
    expect(siteMagicProblem('image/x-icon', b(0, 0, 1, 0))).toBeNull();
    expect(siteMagicProblem('video/mp4', b())).not.toBeNull();
  });
  it('leaves text types to the secret scan', () => {
    expect(siteMagicProblem('text/html', s('MZ'))).toBeNull();
    expect(siteMagicProblem('image/svg+xml', s('anything'))).toBeNull();
  });
});
