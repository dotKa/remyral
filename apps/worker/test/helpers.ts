import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { PathHost } from '../src/config/paths.js';
import { createNodeFileOps, type FileOps, type FileStat } from '../src/fs/ops.js';

const dirs: string[] = [];

/** A fresh private temp dir, removed after each test. */
export async function tempDir(prefix = 'rw-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export const isWindows = process.platform === 'win32';

export function nodeOps(): FileOps {
  return createNodeFileOps();
}

/** Real ops with selected methods replaced. */
export function patchOps(overrides: Partial<FileOps>, base: FileOps = createNodeFileOps()): FileOps {
  return {
    ...base,
    ...overrides,
    platform: overrides.platform ?? base.platform,
    uid: overrides.uid ?? base.uid,
  };
}

/** Real ops that report fake permission bits / owner for specific paths. */
export function opsWithStats(
  fakes: Record<string, Partial<FileStat>>,
  base: FileOps = createNodeFileOps(),
): FileOps {
  const tweak = async (path: string, real: (p: string) => Promise<FileStat | null>) => {
    const st = await real(path);
    const fake = fakes[path];
    return st === null || fake === undefined ? st : { ...st, ...fake };
  };
  return patchOps(
    {
      stat: (p) => tweak(p, base.stat.bind(base)),
      lstat: (p) => tweak(p, base.lstat.bind(base)),
    },
    base,
  );
}

export function pathHost(overrides: Partial<PathHost> = {}): PathHost {
  const env: Record<string, string> = {};
  return {
    platform: process.platform,
    env: (name) => env[name],
    homedir: () => '/home/w',
    isPrivileged: false,
    ...overrides,
  };
}

export function captureLines() {
  const lines: string[] = [];
  return {
    lines,
    sink: (line: string) => {
      lines.push(line);
    },
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
