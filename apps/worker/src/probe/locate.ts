import path from 'node:path';
import type { System } from '../system/types.js';

/** `path.win32` on Windows, `path.posix` elsewhere — chosen from the (possibly fake) system. */
export function pathFor(sys: Pick<System, 'platform'>): path.PlatformPath {
  return sys.platform === 'win32' ? path.win32 : path.posix;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Per-user install locations searched after PATH. A probe started from a service, a
 * fresh SSH session or a scheduled task often has a minimal PATH that misses them.
 */
export function wellKnownDirs(sys: System): string[] {
  const p = pathFor(sys);
  const home = sys.homedir();
  if (sys.platform === 'win32') {
    const dirs = [
      p.join(home, '.local', 'bin'),
      p.join(home, '.opencode', 'bin'),
      p.join(home, '.cargo', 'bin'),
    ];
    const appData = sys.getEnv('APPDATA');
    if (appData) dirs.unshift(p.join(appData, 'npm'));
    return dirs;
  }
  return [
    p.join(home, '.local', 'bin'),
    p.join(home, '.opencode', 'bin'),
    p.join(home, '.npm-global', 'bin'),
    p.join(home, '.bun', 'bin'),
    p.join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
  ];
}

/** Candidate file names for `name` in one directory (PATHEXT expansion on Windows). */
export function candidateNames(sys: System, name: string): string[] {
  if (sys.platform !== 'win32') return [name];
  if (/\.[A-Za-z0-9]+$/.test(name)) return [name];
  const exts = (sys.getEnv('PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.'));
  return exts.map((ext) => name + ext);
}

/**
 * Finds an executable by walking PATH (then {@link wellKnownDirs}). Pure PATH walk, not
 * `which`/`where`, so it behaves the same on every OS and does not depend on those tools
 * existing. PATH values are never reported.
 */
export async function locateBinary(sys: System, name: string): Promise<string | null> {
  const p = pathFor(sys);
  const delimiter = sys.platform === 'win32' ? ';' : ':';
  const fromPath = (sys.getEnv('PATH') ?? '')
    .split(delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && p.isAbsolute(d));
  const seen = new Set<string>();
  for (const dir of [...fromPath, ...wellKnownDirs(sys)]) {
    const key = sys.platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const candidate of candidateNames(sys, name)) {
      const full = p.join(dir, candidate);
      if (await sys.isFile(full)) return full;
    }
  }
  return null;
}
