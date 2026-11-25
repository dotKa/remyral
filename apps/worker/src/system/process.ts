/**
 * Pure helpers for cross-platform process handling. Kept free of side effects so the
 * Windows branches are unit-tested on every OS.
 */

export interface SpawnPlan {
  file: string;
  args: string[];
  /** Needed for `cmd.exe /s /c "<line>"` so Node does not re-quote the command line. */
  windowsVerbatimArguments: boolean;
  /** POSIX: put the child in its own process group so the whole tree can be killed. */
  detached: boolean;
}

const CMD_UNSAFE = /["%^&|<>!\r\n]/;

/**
 * Windows cannot `spawn()` a `.cmd`/`.bat` shim (npm installs every CLI as one) without
 * a shell since the CVE-2024-27980 fix. We route those through `cmd.exe /d /s /c` with a
 * command line built from constant arguments only; anything that could be interpreted
 * by cmd.exe is rejected rather than escaped.
 */
export function planSpawn(platform: string, file: string, args: readonly string[]): SpawnPlan {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    for (const part of [file, ...args]) {
      if (CMD_UNSAFE.test(part)) {
        throw new Error('refusing to pass a cmd.exe metacharacter to a .cmd shim');
      }
    }
    const line = [file, ...args].map((p) => (/\s/.test(p) || p === '' ? `"${p}"` : p)).join(' ');
    return {
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
      detached: false,
    };
  }
  return { file, args: [...args], windowsVerbatimArguments: false, detached: platform !== 'win32' };
}

export type KillStep =
  | { kind: 'signal-group'; pid: number; signal: 'SIGTERM' | 'SIGKILL' }
  | { kind: 'exec'; file: string; args: string[] };

/**
 * How to kill a process tree. POSIX: signal the process group (the child was spawned
 * detached, so its pid is the group id). Windows: `taskkill /T /F` walks the tree.
 * Windows Job Objects are the long-term answer (ADR-0012 rule 4, p3-sandbox).
 */
export function planKillTree(platform: string, pid: number, force: boolean): KillStep {
  if (platform === 'win32') {
    return { kind: 'exec', file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  }
  return { kind: 'signal-group', pid, signal: force ? 'SIGKILL' : 'SIGTERM' };
}

/** Environment variables a self-test child may inherit. Everything else (API keys!) is dropped. */
export const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
] as const;

/**
 * Builds a minimal child environment: an allow-list of non-secret variables from the
 * parent plus an isolated HOME/config tree under `isolatedHome`, plus `extra`.
 */
export function buildChildEnv(
  getEnv: (name: string) => string | undefined,
  isolatedHome: string,
  separator: '/' | '\\',
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of CHILD_ENV_ALLOWLIST) {
    // Windows env names are case-insensitive: never emit both PATH and Path.
    if (seen.has(name.toLowerCase())) continue;
    const value = getEnv(name);
    if (value !== undefined && value !== '') {
      env[name] = value;
      seen.add(name.toLowerCase());
    }
  }
  const join = (...parts: string[]) => parts.join(separator);
  Object.assign(env, {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: join(isolatedHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(isolatedHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
    XDG_CACHE_HOME: join(isolatedHome, '.cache'),
    XDG_STATE_HOME: join(isolatedHome, '.local', 'state'),
    NO_COLOR: '1',
  });
  return { ...env, ...extra };
}
