import { lstat, readdir, rm } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@remyral/observability';
import { runProcess, type RunFn } from '../remote-ops/process.js';

/**
 * p5-claude-auth-health: stale Claude Code lock files of the worker user.
 *
 * Claude Code serialises OAuth token refreshes and config writes with lock directories/files next to its state
 * (`.oauth_refresh.lock`, `.claude.lock`, `<file>.lock`). When a CLI process dies mid-refresh (service stop,
 * tree kill on cancel, a crash) the lock stays, and every later run fails with "Failed to refresh OAuth token:
 * another Claude Code process is refreshing it or exited mid-refresh" until someone logs in again. Seen live on
 * the Windows worker (2026-10-14) under `C:\Windows\ServiceProfiles\RemyralWorker\`.
 *
 * Before a Claude Code start the worker removes such locks when
 *  - the entry's name is one of the known lock names (nothing else is ever touched),
 *  - it is older than `maxAgeMs` (default 10 min; a refresh takes seconds), and
 *  - no Claude process of the worker user is running (a live process may legitimately hold it).
 * Any doubt (the process list cannot be read) → nothing is removed. Credentials are never read.
 *
 * p10-claude-login-health: the OAuth refresh locks (`.oauth_refresh.lock`, the legacy `.claude.lock`) are
 * `proper-lockfile` directories with `stale: 60000, update: 5000` (pinned CLI 2.1.296): a live holder touches the
 * mtime every 5 s, and the CLI itself treats one untouched for 60 s as stale. One older than `refreshStaleMs`
 * (default 2 min, twice that threshold) therefore has no live holder, so it is removed even while some Claude process
 * of the worker user runs (the assistant's long-lived session kept every such lock in place before — the wake-up
 * case of 2026-10-18). On POSIX it must also be owned by the worker user. The `.oauth_refresh.lock.owner` record next
 * to it is the CLI's own and is never touched.
 */

/** Lock entries Claude Code leaves next to its state (directories from proper-lockfile or plain files). */
export const CLAUDE_LOCK_NAME =
  /^\.(?:oauth_refresh|claude|claude\.json|credentials\.json|config\.json)\.lock$/;

export const DEFAULT_CLAUDE_LOCK_MAX_AGE_MS = 10 * 60_000;

/** The OAuth refresh locks (current and legacy) the CLI keeps fresh while held (`update: 5000`, `stale: 60000`). */
export const CLAUDE_REFRESH_LOCK_NAME = /^\.(?:oauth_refresh|claude)\.lock$/;

/** p10-claude-login-health: a refresh lock untouched this long has no live holder (twice the CLI's 60 s). */
export const DEFAULT_CLAUDE_REFRESH_STALE_MS = 2 * 60_000;

export interface ClaudeLockJanitorDeps {
  /** Directories to scan (not recursive): the user's home and the Claude config dir. */
  readonly dirs: readonly string[];
  /** Whether any Claude Code process of the worker user runs now (rejects / throws → treated as yes). */
  readonly claudeRunning: () => Promise<boolean>;
  readonly logger: Logger;
  readonly maxAgeMs?: number;
  /** p10-claude-login-health: age after which a refresh lock is removed even while a Claude process runs. */
  readonly refreshStaleMs?: number;
  /** The worker user's uid (POSIX; a lock owned by someone else is never removed). Default: `process.getuid()`. */
  readonly uid?: number | null;
  readonly now?: () => number;
}

export interface ClaudeLockSweep {
  readonly removed: readonly string[];
  /** Why nothing was removed although stale locks were found (`claude_running` / `process_list_unavailable`). */
  readonly skipped?: string;
}

/** Removes stale Claude lock entries (see the module comment). Never throws. */
export async function sweepClaudeLocks(d: ClaudeLockJanitorDeps): Promise<ClaudeLockSweep> {
  const maxAge = d.maxAgeMs ?? DEFAULT_CLAUDE_LOCK_MAX_AGE_MS;
  const refreshStale = Math.min(maxAge, d.refreshStaleMs ?? DEFAULT_CLAUDE_REFRESH_STALE_MS);
  const now = d.now?.() ?? Date.now();
  const uid = d.uid === undefined ? (process.getuid?.() ?? null) : d.uid;
  const stale: string[] = [];
  /** Refresh locks without a live holder by the CLI's own rule (removed regardless of running processes). */
  const dead: string[] = [];
  for (const dir of new Set(d.dirs)) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!CLAUDE_LOCK_NAME.test(name)) continue;
      const path = join(dir, name);
      const st = await lstat(path).catch(() => null);
      if (st === null || st.isSymbolicLink()) continue;
      if (uid !== null && st.uid !== uid) continue;
      const age = now - st.mtimeMs;
      if (CLAUDE_REFRESH_LOCK_NAME.test(name) && age >= refreshStale) dead.push(path);
      else if (age >= maxAge) stale.push(path);
    }
  }
  if (stale.length === 0 && dead.length === 0) return { removed: [] };
  let skipped: string | undefined;
  if (stale.length > 0) {
    let running: boolean;
    try {
      running = await d.claudeRunning();
    } catch {
      running = true;
      skipped = 'process_list_unavailable';
      d.logger.warn('stale Claude lock found but the process list is unavailable; left in place', {
        locks: stale.length,
      });
    }
    if (running && skipped === undefined) {
      skipped = 'claude_running';
      d.logger.info('stale-looking Claude lock left in place: a Claude process of this user is running', {
        locks: stale.length,
      });
    }
    if (!running) dead.push(...stale);
  }
  const removed: string[] = [];
  for (const path of dead) {
    try {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch (err) {
      d.logger.warn('could not remove a stale Claude lock', { path, err });
    }
  }
  if (removed.length > 0) {
    d.logger.warn('removed stale Claude Code lock(s) left by an earlier process', {
      removed,
      maxAgeMinutes: Math.round(maxAge / 60_000),
    });
  }
  return skipped === undefined ? { removed } : { removed, skipped };
}

/**
 * Parses `tasklist /V /FO CSV /NH` output: whether a `claude.exe` row belongs to one of `users` (the 7th column,
 * `DOMAIN\user`; compared by the name after the backslash, case-insensitively). Rows of other users show
 * `N/A` to a non-admin service account and do not count. Locale-independent (no headers are read).
 */
export function tasklistHasClaude(stdout: string, users: readonly string[]): boolean {
  const names = new Set(users.filter((u) => u !== '').map((u) => u.toLowerCase()));
  return stdout.split(/\r?\n/).some((line) => {
    const cols = [...line.trim().matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1] ?? '');
    if (cols.length < 7 || cols[0]?.toLowerCase() !== 'claude.exe') return false;
    const owner = (cols[6] ?? '').toLowerCase();
    const name = owner.includes('\\') ? owner.slice(owner.lastIndexOf('\\') + 1) : owner;
    return names.has(name);
  });
}

/** Parses `ps -o args=` output: whether a Claude Code CLI process is among the lines. */
export function psHasClaude(stdout: string): boolean {
  return stdout.split('\n').some((line) => {
    const l = line.trim();
    if (l === '') return false;
    const exe = l.split(/\s+/)[0] ?? '';
    return (
      /(?:^|\/)claude$/.test(exe) ||
      /@anthropic-ai\/claude-(?:code|agent-sdk)\b/.test(l) ||
      /\/claude-code\/cli\.js\b/.test(l)
    );
  });
}

/**
 * Default process check: Windows `tasklist` filtered to this user's `claude.exe`; POSIX `ps -U <uid>`. A failed
 * listing rejects (the janitor then removes nothing).
 */
export function osClaudeRunning(
  run: RunFn = runProcess,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<boolean> {
  return async () => {
    if (platform === 'win32') {
      const sysRoot = env.SystemRoot ?? 'C:\\Windows';
      const r = await run(
        join(sysRoot, 'System32', 'tasklist.exe'),
        ['/FI', 'IMAGENAME eq claude.exe', '/V', '/FO', 'CSV', '/NH'],
        { env: { SystemRoot: sysRoot }, cwd: sysRoot, timeoutMs: 15_000 },
      );
      if (r.exitCode !== 0 || r.timedOut) throw new Error('tasklist failed');
      // A virtual service account (NT SERVICE, RemyralWorker) reports its own name; USERNAME may differ.
      return tasklistHasClaude(r.stdout, [userInfo().username, env.USERNAME ?? '']);
    }
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('no uid');
    const r = await run('/bin/ps', ['-U', String(uid), '-o', 'args='], {
      env: { PATH: '/usr/bin:/bin' },
      cwd: '/',
      timeoutMs: 15_000,
    });
    // ps exits 1 when the user has no processes (cannot be: this one runs) — any other result is a failure.
    if (r.exitCode !== 0 || r.timedOut) throw new Error('ps failed');
    return psHasClaude(r.stdout);
  };
}

/** The directories Claude Code keeps its user-level state and locks in. */
export function claudeLockDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const dirs = [home, join(home, '.claude')];
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (configDir !== undefined && configDir !== '') dirs.push(configDir);
  return dirs;
}
