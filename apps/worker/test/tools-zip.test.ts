import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractZip, listZip, safeEntryPath, ZipError } from '../src/tools/zip.js';
import { buildZip } from './zip-fixtures.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rw-zip-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function zip(entries: Parameters<typeof buildZip>[0]): Promise<string> {
  const file = join(dir, 'a.zip');
  await writeFile(file, buildZip(entries));
  return file;
}

describe('ZIP extraction (p5-machine-admin recipes)', () => {
  it('extracts stored and deflated files, directories and execute bits', async () => {
    const file = await zip([
      { name: 'chrome-linux64/' },
      { name: 'chrome-linux64/chrome', data: 'ELF', mode: 0o755, deflate: true },
      { name: 'chrome-linux64/resources.pak', data: 'x'.repeat(10_000), deflate: true },
      { name: 'chrome-linux64/README', data: 'hello' },
    ]);
    const out = join(dir, 'out');
    const r = await extractZip(file, out);
    expect(r).toMatchObject({ files: 3, directories: 1, symlinks: 0 });
    expect(await readFile(join(out, 'chrome-linux64', 'chrome'), 'utf8')).toBe('ELF');
    expect(await readFile(join(out, 'chrome-linux64', 'resources.pak'), 'utf8')).toHaveLength(10_000);
    if (process.platform !== 'win32') {
      expect((await stat(join(out, 'chrome-linux64', 'chrome'))).mode & 0o777).toBe(0o755);
      expect((await stat(join(out, 'chrome-linux64', 'README'))).mode & 0o777).toBe(0o644);
    }
    expect((await listZip(file)).map((e) => e.name)).toContain('chrome-linux64/chrome');
  });

  it('strips a leading directory and skips package metadata outside it (.nupkg)', async () => {
    const file = await zip([
      { name: '_rels/.rels', data: '<x/>' },
      { name: 'python.nuspec', data: '<x/>' },
      { name: 'tools/python.exe', data: 'MZ' },
      { name: 'tools/Lib/os.py', data: 'import sys' },
    ]);
    const out = join(dir, 'py');
    const r = await extractZip(file, out, { strip: 'tools' });
    expect(r.files).toBe(2);
    expect(await readFile(join(out, 'python.exe'), 'utf8')).toBe('MZ');
    expect(await readFile(join(out, 'Lib', 'os.py'), 'utf8')).toBe('import sys');
    await expect(stat(join(out, 'python.nuspec'))).rejects.toThrow();
  });

  it('refuses traversal, absolute and backslash names even in a checksummed archive', async () => {
    for (const name of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/Windows/x', 'a\\..\\b']) {
      const file = await zip([{ name, data: 'x' }]);
      await expect(extractZip(file, join(dir, `o-${String(Math.random())}`))).rejects.toBeInstanceOf(
        ZipError,
      );
    }
    expect(safeEntryPath('a/./b', undefined)).toBe('a/b');
    expect(() => safeEntryPath('a\u0000b', undefined)).toThrow(ZipError);
  });

  it('detects a CRC or size mismatch', async () => {
    await expect(
      extractZip(await zip([{ name: 'f', data: 'abc', badCrc: true }]), join(dir, 'o1')),
    ).rejects.toThrow(/CRC/);
    await expect(
      extractZip(await zip([{ name: 'g', data: 'abcdef', lieSize: 3 }]), join(dir, 'o2')),
    ).rejects.toThrow(/larger than declared|size mismatch/);
  });

  it('symlinks: skipped unless allowed, and never pointing outside the destination', async () => {
    const inside = await zip([
      { name: 'App.app/Versions/A/bin', data: 'x' },
      { name: 'App.app/Versions/Current', symlink: 'A' },
    ]);
    const skipped = await extractZip(inside, join(dir, 's1'));
    expect(skipped.skipped).toBe(1);
    if (process.platform !== 'win32') {
      const allowed = await extractZip(inside, join(dir, 's2'), { allowSymlinks: true });
      expect(allowed.symlinks).toBe(1);
      expect(await readlink(join(dir, 's2', 'App.app', 'Versions', 'Current'))).toBe('A');
      const out = await zip([{ name: 'x/link', symlink: '../../outside' }]);
      await expect(extractZip(out, join(dir, 's3'), { allowSymlinks: true })).rejects.toThrow(/leaves/);
      const abs = await zip([{ name: 'x/link', symlink: '/etc' }]);
      await expect(extractZip(abs, join(dir, 's4'), { allowSymlinks: true })).rejects.toThrow(/leaves/);
    }
  });

  it('symlinks: a chain of individually harmless links cannot carry a later write outside', async () => {
    if (process.platform === 'win32') return;
    const dest = join(dir, 'chain', 'root');
    // `a -> .` and `b -> a/..` each look inside as strings, but on disk `b` would be the parent of the root.
    const chained = await zip([
      { name: 'a', symlink: '.' },
      { name: 'b', symlink: 'a/..' },
      { name: 'b/escaped', data: 'x' },
    ]);
    await expect(extractZip(chained, dest, { allowSymlinks: true })).rejects.toThrow(/leaves/);
    await expect(stat(join(dir, 'chain', 'escaped'))).rejects.toThrow();
    // A forward link through a link that points at a directory inside stays allowed.
    const ok = await zip([
      { name: 'App.app/Versions/A/Resources/r', data: 'r' },
      { name: 'App.app/Versions/Current', symlink: 'A' },
      { name: 'App.app/Resources', symlink: 'Versions/Current/Resources' },
      { name: 'App.app/Frameworks/X', symlink: '../Versions/A' },
    ]);
    const r = await extractZip(ok, join(dir, 'chain-ok'), { allowSymlinks: true });
    expect(r.symlinks).toBe(3);
    expect(await readFile(join(dir, 'chain-ok', 'App.app', 'Resources', 'r'), 'utf8')).toBe('r');
  });

  it('never writes a file or directory through a symlinked parent that leaves the destination', async () => {
    if (process.platform === 'win32') return;
    const dest = join(dir, 'pl', 'root');
    await mkdir(join(dir, 'pl', 'outside'), { recursive: true });
    await mkdir(dest, { recursive: true });
    await symlink(join(dir, 'pl', 'outside'), join(dest, 'planted'));
    const file = await zip([{ name: 'planted/f', data: 'x' }]);
    await expect(extractZip(file, dest)).rejects.toThrow(/leaves/);
    const sub = await zip([{ name: 'planted/sub/' }]);
    await expect(extractZip(sub, dest)).rejects.toThrow(/leaves/);
    await expect(stat(join(dir, 'pl', 'outside', 'f'))).rejects.toThrow();
    await expect(stat(join(dir, 'pl', 'outside', 'sub'))).rejects.toThrow();
  });

  it('never writes through a pre-existing path and rejects a non-zip', async () => {
    const file = await zip([{ name: 'f', data: 'new' }]);
    const out = join(dir, 'pre');
    await extractZip(file, out);
    await expect(extractZip(file, out)).rejects.toThrow(/already exists/);
    await writeFile(join(dir, 'not.zip'), 'definitely not a zip archive');
    await expect(listZip(join(dir, 'not.zip'))).rejects.toBeInstanceOf(ZipError);
  });
});
