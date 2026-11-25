import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type GitFixId,
  type GitFixReport,
  type GitHelperKind,
  type GitReadinessProblem,
  type GitReadinessReport,
  GITHUB_HOST,
  gitVersionSupported,
} from '@remyral/protocol';
import { GIT_PASSTHROUGH_ENV } from './git.js';

/**
 * p15-git-central §3 (docs/design/p15-git-central.md): "Git hazırlığı" of a machine — what the worker account's own
 * git setup looks like, and the safe fixes the panel can apply to it.
 *
 * Jobs never use this setup (the worker's git and the agent's git ignore system / global config, see git.ts and
 * job-git-config.ts), so most findings are informational; they explain what someone working by hand on the machine
 * sees, and stale GitHub logins / URL rewrites are cleaned up on request. Detection never reads a secret value:
 * credential helpers are classified by kind, rewrites and OS-store entries counted, identities reported as set.
 */

export interface ProbeResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** ENOENT: the executable does not exist. */
  readonly missing?: boolean;
}

export type ProbeRun = (
  file: string,
  args: readonly string[],
  opts: {
    readonly env: Readonly<Record<string, string>>;
    readonly input?: string;
    readonly timeoutMs?: number;
  },
) => Promise<ProbeResult>;

export interface GitReadinessDeps {
  /** The git jobs use (config → worker-installed → PATH) and where it comes from. */
  readonly gitBinary: () => Promise<{ binary: string; source: 'config' | 'managed' | 'path' }>;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: ProbeRun;
  readonly clock?: () => Date;
  /** Home directory of the worker account (default: HOME / USERPROFILE). */
  readonly home?: string;
  /** Tests: extra variables for every probe (e.g. GIT_CONFIG_NOSYSTEM, so a developer's system helpers stay out). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

const GITHUB_CRED_INPUT = `protocol=https\nhost=${GITHUB_HOST}\n\n`;

export class GitReadiness {
  readonly #d: GitReadinessDeps;
  readonly #platform: NodeJS.Platform;
  readonly #run: ProbeRun;
  #cached: GitReadinessReport | null = null;
  #pending: Promise<GitReadinessReport> | null = null;

  constructor(deps: GitReadinessDeps) {
    this.#d = deps;
    this.#platform = deps.platform ?? process.platform;
    this.#run = deps.run ?? runProbe;
  }

  /** The last report without waiting; a missing one is detected in the background, then `onReady` is called. */
  snapshot(onReady?: () => void): GitReadinessReport | null {
    if (this.#cached === null && this.#pending === null) {
      void this.detect()
        .then(() => onReady?.())
        .catch(() => undefined);
    }
    return this.#cached;
  }

  /** Detects again now (one detection at a time). */
  detect(): Promise<GitReadinessReport> {
    this.#pending ??= this.#detect().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #detect(): Promise<GitReadinessReport> {
    const report = await this.#inspect();
    this.#cached = report;
    return report;
  }

  #env(): Record<string, string> {
    const src = this.#d.env ?? process.env;
    const env: Record<string, string> = {};
    for (const name of GIT_PASSTHROUGH_ENV) {
      const v = src[name];
      if (v !== undefined) env[name] = v;
    }
    // The account's real configuration is what is inspected: no GIT_CONFIG_GLOBAL / NOSYSTEM override here.
    return {
      ...env,
      LC_ALL: 'C',
      LANG: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      ...(this.#d.extraEnv ?? {}),
    };
  }

  #home(): string | null {
    const src = this.#d.env ?? process.env;
    return this.#d.home ?? (this.#platform === 'win32' ? src.USERPROFILE : src.HOME) ?? null;
  }

  async #git(args: readonly string[], input?: string): Promise<ProbeResult> {
    const { binary } = await this.#d.gitBinary();
    return this.#run(binary, args, {
      env: this.#env(),
      ...(input === undefined ? {} : { input }),
      timeoutMs: 15_000,
    });
  }

  async #inspect(): Promise<GitReadinessReport> {
    const checkedAt = (this.#d.clock?.() ?? new Date()).toISOString();
    const { source } = await this.#d.gitBinary();
    const ver = await this.#git(['--version']).catch((): ProbeResult => ({
      code: null,
      stdout: '',
      stderr: '',
      missing: true,
    }));
    const version = /git version (\S+)/.exec(ver.stdout)?.[1]?.slice(0, 64);
    if (ver.missing === true || ver.code !== 0 || version === undefined) {
      return {
        checkedAt,
        git: { present: false },
        problems: [{ code: 'git_missing', severity: 'blocking' }],
        jobsIsolated: false,
      };
    }
    const problems: GitReadinessProblem[] = [];
    const supported = gitVersionSupported(version);
    if (!supported) problems.push({ code: 'git_too_old', severity: 'blocking' });

    // Credential helpers of every scope (Git for Windows configures Git Credential Manager in the system config).
    const helpers = await this.#helpers();
    if (helpers.length > 0) {
      problems.push({
        code: 'global_credential_helper',
        severity: 'info',
        count: helpers.length,
        helpers: [...new Set(helpers)].slice(0, 8),
      });
    }
    const rewrites = await this.#rewrites();
    const github = rewrites.filter((r) => r.github);
    if (github.length > 0) {
      problems.push({
        code: 'global_insteadof',
        severity: 'warning',
        fix: 'remove_github_insteadof',
        count: github.length,
      });
    }
    const withCreds = rewrites.filter((r) => r.credentials);
    if (withCreds.length > 0) {
      problems.push({
        code: 'insteadof_with_credentials',
        severity: 'warning',
        ...(withCreds.every((r) => r.github) ? { fix: 'remove_github_insteadof' as const } : {}),
        count: withCreds.length,
      });
    }
    const safe = await this.#git(['config', '--global', '--get-all', 'safe.directory']).catch(() => null);
    if (
      safe?.code === 0 &&
      safe.stdout
        .split('\n')
        .map((l) => l.trim())
        .includes('*')
    ) {
      problems.push({ code: 'safe_directory_wildcard', severity: 'warning' });
    }
    if (this.#platform === 'win32') {
      const crlf = await this.#git(['config', '--get', 'core.autocrlf']).catch(() => null);
      if (crlf?.code === 0 && crlf.stdout.trim().toLowerCase() === 'true') {
        problems.push({ code: 'autocrlf_true', severity: 'info' });
      }
    }
    const home = this.#home();
    if (home !== null && (await lstat(join(home, '.git-credentials')).catch(() => null)) !== null) {
      problems.push({ code: 'credential_store_file', severity: 'warning', fix: 'erase_github_credentials' });
    }
    const store = await this.#osStoreGithub();
    if (store.count > 0) {
      problems.push({
        code: 'os_store_github',
        severity: 'warning',
        fix: 'erase_github_credentials',
        count: store.count,
      });
    }
    const name = await this.#git(['config', '--global', '--get', 'user.name']).catch(() => null);
    const email = await this.#git(['config', '--global', '--get', 'user.email']).catch(() => null);
    if (name?.code === 0 || email?.code === 0) problems.push({ code: 'global_identity', severity: 'info' });

    return {
      checkedAt,
      git: { present: true, version, source: source === 'path' ? 'system' : source },
      problems: problems.slice(0, 16),
      jobsIsolated: supported,
      ...(store.unchecked ? { osStoreUnchecked: true } : {}),
    };
  }

  async #helpers(): Promise<GitHelperKind[]> {
    const r = await this.#git(['config', '--get-all', 'credential.helper']).catch(() => null);
    if (r?.code !== 0) return [];
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .map(helperKind);
  }

  /** Global `url.<base>.insteadOf` / `pushInsteadOf` entries: whether they touch github.com or embed credentials. */
  async #rewrites(): Promise<{ key: string; github: boolean; credentials: boolean }[]> {
    const r = await this.#git([
      'config',
      '--global',
      '--null',
      '--get-regexp',
      '^url\\..*\\.(insteadof|pushinsteadof)$',
    ]).catch(() => null);
    if (r?.code !== 0) return [];
    const out: { key: string; github: boolean; credentials: boolean }[] = [];
    for (const entry of r.stdout.split('\0')) {
      if (entry === '') continue;
      const nl = entry.indexOf('\n');
      const key = nl < 0 ? entry : entry.slice(0, nl);
      const value = nl < 0 ? '' : entry.slice(nl + 1);
      const base = key.replace(/^url\./i, '').replace(/\.(insteadof|pushinsteadof)$/i, '');
      out.push({
        key,
        github: touchesGithub(base) || touchesGithub(value),
        // `scheme://user:secret@host/…` — the secret itself is never kept or reported.
        credentials: /^[a-z][a-z0-9+.-]*:\/\/[^/@:\s]+:[^/@\s]+@/i.test(base),
      });
    }
    return out;
  }

  /** GitHub git logins in the OS credential store, counted by target / server name only. */
  async #osStoreGithub(): Promise<{ count: number; unchecked: boolean; targets: string[] }> {
    if (this.#platform === 'win32') {
      const root = (this.#d.env ?? process.env).SystemRoot ?? 'C:\\Windows';
      const r = await this.#run(join(root, 'System32', 'cmdkey.exe'), ['/list'], {
        env: this.#env(),
        timeoutMs: 15_000,
      }).catch(() => null);
      if (r?.code !== 0) return { count: 0, unchecked: true, targets: [] };
      const targets = [...r.stdout.matchAll(/target=(git:https:\/\/(?:[^@\s/]+@)?github\.com)\s*$/gim)].map(
        (m) => m[1] ?? '',
      );
      return { count: targets.length, unchecked: false, targets };
    }
    if (this.#platform === 'darwin') {
      const r = await this.#run('/usr/bin/security', ['find-internet-password', '-s', GITHUB_HOST], {
        env: this.#env(),
        timeoutMs: 15_000,
      }).catch(() => null);
      if (r === null || r.missing === true) return { count: 0, unchecked: true, targets: [] };
      // 0: found (attributes only — no -g / -w, so no secret is printed); 44: not found.
      if (r.code === 0) return { count: 1, unchecked: false, targets: [] };
      return { count: 0, unchecked: r.code !== 44, targets: [] };
    }
    // Linux: the secret service needs the account's session bus; not inspected (the store file is checked above).
    return { count: 0, unchecked: true, targets: [] };
  }

  /** Applies the requested fixes, then detects again. Never reads a credential value. */
  async fix(fixes: readonly GitFixId[]): Promise<GitFixReport> {
    const before = await this.detect();
    const results: GitFixReport['results'] = [];
    for (const fix of fixes) {
      if (!before.git.present) {
        results.push({ fix, outcome: 'unsupported', reason: 'git_missing' });
        continue;
      }
      try {
        results.push(
          fix === 'erase_github_credentials' ? await this.#eraseGithub(before) : await this.#removeRewrites(),
        );
      } catch {
        results.push({ fix, outcome: 'failed', reason: 'command_failed' });
      }
    }
    const readiness = await this.detect();
    return { results, readiness };
  }

  async #eraseGithub(before: GitReadinessReport): Promise<GitFixReport['results'][number]> {
    const fix = 'erase_github_credentials' as const;
    const had = before.problems.some(
      (p) => p.code === 'os_store_github' || p.code === 'credential_store_file',
    );
    if (!had) return { fix, outcome: 'nothing_to_do' };
    // Through the account's own helpers (GCM, osxkeychain, libsecret, store): git erases matching entries itself.
    await this.#git(['credential', 'reject'], GITHUB_CRED_INPUT);
    // A plain-text store file that no helper is configured for.
    await this.#git(
      ['-c', 'credential.helper=', '-c', 'credential.helper=store', 'credential', 'reject'],
      GITHUB_CRED_INPUT,
    );
    // Leftovers the helpers did not remove (another GCM store mode, a login made without a helper).
    let store = await this.#osStoreGithub();
    if (store.count > 0 && this.#platform === 'win32') {
      const root = (this.#d.env ?? process.env).SystemRoot ?? 'C:\\Windows';
      for (const target of store.targets) {
        await this.#run(join(root, 'System32', 'cmdkey.exe'), [`/delete:${target}`], {
          env: this.#env(),
          timeoutMs: 15_000,
        });
      }
    } else if (store.count > 0 && this.#platform === 'darwin') {
      for (let i = 0; i < 5; i++) {
        const r = await this.#run('/usr/bin/security', ['delete-internet-password', '-s', GITHUB_HOST], {
          env: this.#env(),
          timeoutMs: 15_000,
        });
        if (r.code !== 0) break;
      }
    }
    store = await this.#osStoreGithub();
    return store.count === 0
      ? { fix, outcome: 'applied' }
      : { fix, outcome: 'failed', reason: 'still_present' };
  }

  async #removeRewrites(): Promise<GitFixReport['results'][number]> {
    const fix = 'remove_github_insteadof' as const;
    const rewrites = (await this.#rewrites()).filter((r) => r.github);
    if (rewrites.length === 0) return { fix, outcome: 'nothing_to_do' };
    for (const r of rewrites) {
      await this.#git(['config', '--global', '--unset-all', '--', r.key]);
    }
    const left = (await this.#rewrites()).filter((r) => r.github);
    return left.length === 0
      ? { fix, outcome: 'applied' }
      : { fix, outcome: 'failed', reason: 'still_present' };
  }
}

/** Classifies a configured `credential.helper` value without keeping it (it may embed a command or a secret). */
export function helperKind(value: string): GitHelperKind {
  const v = value.toLowerCase();
  if (v.includes('manager')) return 'manager';
  if (v.includes('osxkeychain')) return 'osxkeychain';
  if (v.includes('libsecret')) return 'libsecret';
  if (v.includes('wincred')) return 'wincred';
  if (/^(?:\S*[/\\])?(?:git-credential-)?store\b/.test(v)) return 'store';
  if (/^(?:\S*[/\\])?(?:git-credential-)?cache\b/.test(v)) return 'cache';
  return 'other';
}

function touchesGithub(url: string): boolean {
  return /(?:^|[@/.:])github\.com(?:[:/]|$)/i.test(url);
}

/** Default probe runner: no shell, bounded output, stdin from `input`, a hard timeout. */
export const runProbe: ProbeRun = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      env: { ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const cap = 256 * 1024;
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 15_000);
    child.stdout.on('data', (b: Buffer) => {
      if (stdout.length < cap) stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      if (stderr.length < cap) stderr += b.toString('utf8');
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') resolve({ code: null, stdout: '', stderr: '', missing: true });
      else reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? '');
  });
