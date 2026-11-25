import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeLoginFailureCause, DEFAULT_INHERITED_ENV } from '@remyral/agent-adapters';
import type { Logger } from '@remyral/observability';
import {
  isAllowedLoginUrl,
  type LoginReport,
  type LoginRuntime,
  type LoginStatus,
  type OpsUpdatePayload,
} from '@remyral/protocol';
import type { LoginGatePort } from '../runtimes/login-gate.js';
import { loginStoreOf } from '../sandbox/login-stores.js';
import type { RunFn } from './process.js';

/**
 * Subscription login relay (p5-remote-ops §3, ADR-0017 amending ADR-0014).
 *
 * The worker starts the runtime's **own** login command as the worker's service user, with that user's real
 * HOME / config dir (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` only when the worker itself has them), so the credential
 * lands exactly where the runtime looks for it:
 *  - Claude Code 2.1.296: `claude auth login --claudeai` — without a TTY it prints a sign-in URL whose callback
 *    page shows a code, and reads that code from stdin (verified against the pinned CLI, 2026-10-14);
 *  - Codex 0.162.1: `codex login --device-auth` — prints https://auth.openai.com/codex/device and a one-time
 *    code, and completes by itself once the owner approves in the browser.
 *
 * Only an allow-listed https URL and a device code are extracted from the output and relayed. The output
 * itself is never relayed, logged or stored (it is scanned in memory, bounded, and dropped). The resulting
 * credential is never read, copied or transmitted: login state comes from the runtime's status command, and
 * only its boolean / auth-method label is reported. `CLAUDE_CODE_OAUTH_TOKEN` / `setup-token` are never used.
 */

export type LoginUpdate = Omit<OpsUpdatePayload, 'commandId' | 'seq' | 'kind'>;

export interface LoginDeps {
  /** The runtime executable (managed install, local config, PATH); null when not installed. */
  readonly binary: (runtime: LoginRuntime) => Promise<string | null>;
  /** The worker's environment (only allow-listed names are passed on). */
  readonly env: NodeJS.ProcessEnv;
  readonly run: RunFn;
  readonly logger: Logger;
  readonly clock?: () => Date;
  /** Login process lifetime. Default 15 min (Codex device codes expire after 15 min). */
  readonly timeoutMs?: number;
  /** Tests: spawn implementation. */
  readonly spawnImpl?: typeof spawn;
  /**
   * p10-claude-login-health: the per-store gate a usability probe takes like every other runtime start (a probe
   * refreshes the token when it is due). Absent: no gate (tests).
   */
  readonly gate?: LoginGatePort;
  /** Usability probe lifetime. Default 90 s. */
  readonly probeTimeoutMs?: number;
  /**
   * p13-runtime-accounts: an added account of this worker — its config dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and
   * login store; null = no such subscription account here (refused). Absent: only the configured login (`default`).
   */
  readonly account?: (runtime: LoginRuntime, id: string) => { loginDir: string; store: string } | null;
}

/** p13-runtime-accounts: the configured login of a runtime (the worker profile's own). */
const DEFAULT = 'default';

/** p10-claude-login-health: what a usability probe found (never the output itself). */
export type LoginProbeResult = 'usable' | 'expired' | 'inconclusive';

/**
 * The smallest real Claude Code request (pinned CLI 2.1.296 flags): one non-interactive turn, no tools, no MCP
 * servers, nothing persisted. `--tools` is variadic, so it comes last. The answer is never read beyond `is_error`.
 */
export const CLAUDE_PROBE_ARGS: readonly string[] = [
  '-p',
  'Reply with the single word OK.',
  '--output-format',
  'json',
  '--max-turns',
  '1',
  '--no-session-persistence',
  '--strict-mcp-config',
  '--tools',
  '',
];

const LOGIN_ARGS: Readonly<Record<LoginRuntime, readonly string[]>> = {
  'claude-code': ['auth', 'login', '--claudeai'],
  codex: ['login', '--device-auth'],
};

/** Env names the login process may additionally inherit: where the runtime keeps its own login. */
const LOGIN_DIR_ENV: Readonly<Record<LoginRuntime, readonly string[]>> = {
  'claude-code': ['CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_HOME'],
};

// Terminal escape sequences (CSI / OSC) the CLIs colour their output with.
// eslint-disable-next-line no-control-regex -- matching ESC / BEL is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
// eslint-disable-next-line no-control-regex -- an ESC ends a URL in coloured output
const URL_RE = /https:\/\/[^\s"'<>`\u001b]+/g;
/** Output must be quiet this long before a URL at the very end of it counts as complete. */
const QUIET_MS = 300;
const DEVICE_CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/;
const MAX_SCAN = 64 * 1024;

/**
 * The non-secret environment of a login / status process. p13-runtime-accounts: `loginDir` = an added account's config
 * dir — the runtime's own login then lands there (and is read from there).
 */
export function loginEnv(
  runtime: LoginRuntime,
  env: NodeJS.ProcessEnv,
  loginDir?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...DEFAULT_INHERITED_ENV, ...LOGIN_DIR_ENV[runtime]]) {
    const v = env[name];
    if (v !== undefined) out[name] = v;
  }
  if (loginDir !== undefined) for (const name of LOGIN_DIR_ENV[runtime]) out[name] = loginDir;
  out.NO_COLOR = '1';
  out.TERM = 'dumb';
  // Never open a browser on the worker's machine: the owner opens the relayed URL on their own device.
  if (process.platform !== 'win32' && existsSync('/usr/bin/true')) out.BROWSER = '/usr/bin/true';
  return out;
}

/** Extracts what may be relayed from (ANSI-stripped) login output. */
export function extractLogin(
  runtime: LoginRuntime,
  text: string,
  /** The output paused: a URL that ends the text is complete (otherwise it may still be arriving). */
  complete = true,
): { url: string | undefined; userCode: string | undefined } {
  const clean = text.replace(ANSI, '');
  const urls = [...clean.matchAll(URL_RE)]
    .filter((m) => complete || m.index + m[0].length < clean.length)
    .map((m) => m[0].replace(/[.,;)]+$/, ''));
  // Claude prints the manual (code-paste) URL after "visit:"; prefer the last allowed one.
  const url = urls.filter(isAllowedLoginUrl).pop();
  let userCode: string | undefined;
  if (runtime === 'codex') {
    const after = url === undefined ? clean : clean.slice(clean.indexOf(url) + url.length);
    userCode = DEVICE_CODE.exec(after)?.[1];
  }
  return { url, userCode };
}

/** p5-claude-auth-health: the reason a login is reported unusable after a failed run. */
export const LOGIN_EXPIRED = 'login_expired';
/** p10-claude-login-health: the login is flagged and a usability probe could not tell (network, timeout). */
export const LOGIN_UNVERIFIED = 'login_unverified';

/**
 * `claude auth status --json` output: the JSON object, also when warnings (Node deprecation notices, an update
 * hint) surround it — the cause of "Subscription login: Unknown" after a successful Check.
 */
export function parseStatusJson(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object in the status output');
    return JSON.parse(text.slice(start, end + 1));
  }
}

interface Session {
  readonly commandId: string;
  readonly runtime: LoginRuntime;
  readonly account: string;
  readonly child: ChildProcess;
  waiting: boolean;
  codeSent: boolean;
  cancelled: boolean;
}

/** p13-runtime-accounts: the key of one login (runtime × account). */
function keyOf(runtime: LoginRuntime, account: string | undefined): string {
  return `${runtime}#${account ?? DEFAULT}`;
}

function splitKey(key: string): { runtime: LoginRuntime; account: string } {
  const i = key.indexOf('#');
  return { runtime: key.slice(0, i) as LoginRuntime, account: key.slice(i + 1) };
}

export class LoginManager {
  readonly #d: LoginDeps;
  readonly #log: Logger;
  readonly #sessions = new Map<string, Session>();
  /** runtime#account → the last report (p13-runtime-accounts: one per account; `#default` = the configured login). */
  readonly #status = new Map<string, LoginReport>();
  /** p5-claude-auth-health: logins whose last run failed on an unusable login (until a login or a good run). */
  readonly #expired = new Set<string>();

  constructor(deps: LoginDeps) {
    this.#d = deps;
    this.#log = deps.logger.child({ component: 'login-relay' });
  }

  /** Command id of the login in progress (one at a time per worker). */
  active(): string | undefined {
    return [...this.#sessions.keys()][0];
  }

  /** CAPABILITIES.remoteOps.login: the configured logins (`default`) only, as before (older masters: ≤ 4 entries). */
  report(): LoginReport[] {
    return this.#reports().filter((r) => r.account === undefined);
  }

  /** p13-runtime-accounts: the login of one account (undefined: not checked yet). */
  accountReport(runtime: LoginRuntime, account: string): LoginReport | undefined {
    return this.#reports().find((r) => r.runtime === runtime && (r.account ?? DEFAULT) === account);
  }

  #reports(): LoginReport[] {
    const out = new Map(this.#status);
    for (const key of this.#expired) {
      if (!out.has(key)) {
        const { runtime, account } = splitKey(key);
        out.set(key, {
          runtime,
          ...(account === DEFAULT ? {} : { account }),
          status: 'expired',
          reason: LOGIN_EXPIRED,
        });
      }
    }
    return [...out.values()];
  }

  /** Whether a run of the runtime failed on an unusable login since the last login / successful run. */
  isExpired(runtime: LoginRuntime, account?: string): boolean {
    return this.#expired.has(keyOf(runtime, account));
  }

  /** p10-claude-login-health: runtimes whose configured login is flagged unusable (the background re-check). */
  expiredRuntimes(): LoginRuntime[] {
    return [...this.#expired]
      .map(splitKey)
      .filter((k) => k.account === DEFAULT)
      .map((k) => k.runtime);
  }

  /** p13-runtime-accounts: every flagged login (runtime × account). */
  expiredLogins(): { runtime: LoginRuntime; account: string }[] {
    return [...this.#expired].map(splitKey);
  }

  /**
   * p10-claude-login-health: a run lost the race for the OAuth refresh lock to another process of the same login
   * store. That says nothing about the login itself (the other process refreshed it), so it is **not** flagged —
   * only logged. A login that really is unusable shows in the next run (or the next Check) as an expiry.
   */
  noteContention(runtime: LoginRuntime, account?: string): void {
    this.#log.warn('a run lost the subscription login refresh race; the login is not marked expired', {
      runtime,
      account: account ?? DEFAULT,
    });
  }

  /**
   * p5-claude-auth-health: a run failed with `login_expired` ("Failed to refresh OAuth token", 401). The status
   * command may still say "logged in" (it only reads the stored credential), so the login is reported expired
   * until a login succeeds or a run of the runtime succeeds again.
   */
  markExpired(runtime: LoginRuntime, reason: string = LOGIN_EXPIRED, account?: string): void {
    const key = keyOf(runtime, account);
    if (!this.#expired.has(key))
      this.#log.warn('subscription login marked expired after a failed run', {
        runtime,
        account: account ?? DEFAULT,
        reason,
      });
    this.#expired.add(key);
    const prev = this.#status.get(key);
    this.#status.set(key, {
      runtime,
      ...(account === undefined || account === DEFAULT ? {} : { account }),
      status: 'expired',
      // p9-windows-slots-local-login: `login_refresh_contention` when parallel refreshes caused it.
      reason: /^[a-z0-9_]{1,64}$/.test(reason) ? reason : LOGIN_EXPIRED,
      checkedAt: (this.#d.clock?.() ?? new Date()).toISOString(),
      ...(prev?.method === undefined ? {} : { method: prev.method }),
    });
  }

  /** A login or a run succeeded: the login works (again). */
  clearExpired(runtime: LoginRuntime, account?: string): void {
    const key = keyOf(runtime, account);
    if (!this.#expired.delete(key)) return;
    const prev = this.#status.get(key);
    if (prev?.reason === LOGIN_EXPIRED || prev?.reason === 'login_refresh_contention') {
      const { reason: _reason, ...rest } = prev;
      this.#status.set(key, { ...rest, status: 'logged_in' });
    }
  }

  /**
   * p13-runtime-accounts: the config dir and store of an account; `default` = the worker's own (no override). Null:
   * an added account this worker does not have.
   */
  #accountOf(
    runtime: LoginRuntime,
    account: string | undefined,
  ): { loginDir?: string; store: string } | null {
    if (account === undefined || account === DEFAULT) return { store: loginStoreOf(runtime) };
    return this.#d.account?.(runtime, account) ?? null;
  }

  /** Forgets everything about a removed account (its folder is deleted by the caller). */
  forget(runtime: LoginRuntime, account: string): void {
    if (account === DEFAULT) return;
    this.#status.delete(keyOf(runtime, account));
    this.#expired.delete(keyOf(runtime, account));
  }

  /**
   * Runs one login to its end, emitting updates: `waiting_for_user` with the URL / code, `running` after a
   * pasted code, then `succeeded` (status from the runtime's own status command) / `failed` / `cancelled`.
   */
  async start(
    commandId: string,
    runtime: LoginRuntime,
    emit: (u: LoginUpdate) => void,
    account?: string,
  ): Promise<void> {
    if (this.#sessions.size > 0) {
      emit({ state: 'refused', reason: 'busy', detail: 'another login is in progress on this worker' });
      return;
    }
    const acc = this.#accountOf(runtime, account);
    if (acc === null) {
      emit({
        state: 'refused',
        reason: 'account_unknown',
        detail: `this worker has no ${runtime} subscription account ${account ?? ''} (configuration not applied yet?)`,
      });
      return;
    }
    const binary = await this.#d.binary(runtime);
    if (binary === null) {
      emit({ state: 'refused', reason: 'runtime_not_installed', detail: `${runtime} is not installed` });
      return;
    }
    const env = loginEnv(runtime, this.#d.env, acc.loginDir);
    const accountField = account === undefined || account === DEFAULT ? {} : { account };
    const child = (this.#d.spawnImpl ?? spawn)(binary, [...LOGIN_ARGS[runtime]], {
      cwd: env.HOME ?? tmpdir(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: false,
    });
    const session: Session = {
      commandId,
      runtime,
      account: account ?? DEFAULT,
      child,
      waiting: false,
      codeSent: false,
      cancelled: false,
    };
    this.#sessions.set(commandId, session);
    this.#log.info('login started', { runtime, account: session.account, commandId });
    emit({ state: 'running', login: { runtime, ...accountField, expectsCode: runtime === 'claude-code' } });

    let scanned = '';
    const timers: { quiet: NodeJS.Timeout | null } = { quiet: null };
    const evaluate = (complete: boolean) => {
      if (session.waiting) return;
      const found = extractLogin(runtime, scanned, complete);
      const ready = found.url !== undefined && (runtime !== 'codex' || found.userCode !== undefined);
      if (!ready) return;
      session.waiting = true;
      scanned = '';
      emit({
        state: 'waiting_for_user',
        login: {
          runtime,
          ...accountField,
          expectsCode: runtime === 'claude-code',
          ...(found.url === undefined ? {} : { url: found.url }),
          ...(found.userCode === undefined ? {} : { userCode: found.userCode }),
        },
      });
    };
    const onOutput = (chunk: Buffer) => {
      if (session.waiting) return;
      scanned = (scanned + chunk.toString('utf8')).slice(-MAX_SCAN);
      evaluate(false);
      if (timers.quiet !== null) clearTimeout(timers.quiet);
      timers.quiet = setTimeout(() => {
        evaluate(true);
      }, QUIET_MS);
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.stdin.on('error', () => undefined);

    const timeout = setTimeout(
      () => {
        this.#kill(session);
      },
      this.#d.timeoutMs ?? 15 * 60_000,
    );
    const exit = await new Promise<{ code: number | null; error?: string }>((resolve) => {
      child.on('error', (err: NodeJS.ErrnoException) => {
        resolve({ code: null, error: err.code ?? 'spawn_failed' });
      });
      child.on('close', (code) => {
        resolve({ code });
      });
    });
    clearTimeout(timeout);
    if (timers.quiet !== null) clearTimeout(timers.quiet);
    this.#sessions.delete(commandId);
    scanned = '';
    if (session.cancelled) {
      emit({ state: 'cancelled', login: { runtime, ...accountField, expectsCode: false } });
      return;
    }
    if (exit.code === 0) {
      this.#expired.delete(keyOf(runtime, account));
      const status = await this.status(runtime, account);
      this.#log.info('login finished', {
        runtime,
        account: session.account,
        commandId,
        status: status.status,
      });
      emit({
        state: status.status === 'logged_in' ? 'succeeded' : 'failed',
        ...(status.status === 'logged_in' ? {} : { reason: 'login_not_confirmed' }),
        login: { runtime, ...accountField, expectsCode: false, status: status.status },
      });
      return;
    }
    this.#log.warn('login failed', { runtime, commandId, exitCode: exit.code, spawnError: exit.error });
    emit({
      state: 'failed',
      reason:
        exit.error === undefined ? (exit.code === null ? 'login_timeout' : 'login_failed') : 'spawn_failed',
      detail:
        exit.error === undefined
          ? `the runtime's login exited ${exit.code === null ? 'after the time limit' : `with code ${String(exit.code)}`}`
          : `the runtime could not be started (${exit.error})`,
      login: {
        runtime,
        ...accountField,
        expectsCode: false,
        status: (await this.status(runtime, account)).status,
      },
    });
  }

  /** Paste-back: writes the code to the login process's stdin (never logged). */
  input(target: string, code: string): 'ok' | 'not_found' | 'not_waiting' {
    const s = this.#sessions.get(target);
    if (s === undefined) return 'not_found';
    if (!s.waiting || s.runtime !== 'claude-code' || s.codeSent) return 'not_waiting';
    s.codeSent = true;
    s.child.stdin?.write(`${code}\n`);
    this.#log.info('login code relayed to the runtime', { runtime: s.runtime, commandId: target });
    return 'ok';
  }

  cancel(target: string): boolean {
    const s = this.#sessions.get(target);
    if (s === undefined) return false;
    s.cancelled = true;
    this.#kill(s);
    return true;
  }

  async stopAll(): Promise<void> {
    for (const s of this.#sessions.values()) {
      s.cancelled = true;
      this.#kill(s);
    }
    await Promise.resolve();
  }

  #kill(s: Session): void {
    const pid = s.child.pid;
    if (pid === undefined) return;
    try {
      if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
      else s.child.kill();
    } catch {
      // already gone
    }
  }

  /**
   * p10-claude-login-health: one minimal real request through the runtime (Claude Code only), under the login
   * store's gate, in an empty temporary directory. Its output is scanned in memory for the result flag and the
   * login-failure texts, then dropped (never logged or relayed). Never reads a credential.
   */
  async probe(runtime: LoginRuntime, account?: string): Promise<LoginProbeResult> {
    if (runtime !== 'claude-code') return 'inconclusive';
    const acc = this.#accountOf(runtime, account);
    if (acc === null) return 'inconclusive';
    const binary = await this.#d.binary(runtime);
    if (binary === null) return 'inconclusive';
    const hold = await this.#d.gate?.acquire(acc.store, 'login-probe');
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'remyral-login-probe-'));
      const r = await this.#d.run(binary, CLAUDE_PROBE_ARGS, {
        env: loginEnv(runtime, this.#d.env, acc.loginDir),
        cwd: dir,
        timeoutMs: this.#d.probeTimeoutMs ?? 90_000,
      });
      return probeOutcome(r.exitCode, r.timedOut, r.stdout, r.stderr);
    } catch {
      return 'inconclusive';
    } finally {
      hold?.release();
      if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * p10-claude-login-health: the panel's Check and the background re-check. The status command first; when this
   * worker has the login flagged (a run failed on it) and the status command says logged in — which it always does,
   * it only reads the stored credential — a usability probe decides: usable clears the flag at once, a login
   * failure keeps it (`login_expired`), anything else keeps it as `login_unverified`.
   */
  async check(runtime: LoginRuntime, account?: string): Promise<LoginReport> {
    const key = keyOf(runtime, account);
    const flagged = this.#expired.has(key);
    const report = await this.status(runtime, account);
    if (!flagged || report.status !== 'expired' || runtime !== 'claude-code') return report;
    const found = await this.probe(runtime, account);
    if (found === 'usable') {
      this.#log.info('subscription login usable again (probe); flag cleared', {
        runtime,
        account: account ?? DEFAULT,
      });
      this.#expired.delete(key);
      const { reason: _reason, ...rest } = report;
      const ok: LoginReport = { ...rest, status: 'logged_in' };
      this.#status.set(key, ok);
      return ok;
    }
    const kept: LoginReport = { ...report, reason: found === 'expired' ? LOGIN_EXPIRED : LOGIN_UNVERIFIED };
    this.#status.set(key, kept);
    return kept;
  }

  /** Login state from the runtime's own status command (ADR-0014 rule 4). Never reads credential files. */
  async status(runtime: LoginRuntime, account?: string): Promise<LoginReport> {
    const checkedAt = (this.#d.clock?.() ?? new Date()).toISOString();
    const key = keyOf(runtime, account);
    const accountField = account === undefined || account === DEFAULT ? {} : { account };
    const acc = this.#accountOf(runtime, account);
    if (acc === null)
      return { runtime, ...accountField, status: 'unknown', checkedAt, reason: 'account_unknown' };
    const binary = await this.#d.binary(runtime);
    let report: LoginReport;
    if (binary === null) {
      report = { runtime, status: 'unknown', checkedAt };
    } else if (runtime === 'claude-code') {
      const r = await this.#d.run(binary, ['auth', 'status', '--json'], {
        env: loginEnv(runtime, this.#d.env, acc.loginDir),
        cwd: tmpdir(),
        timeoutMs: 20_000,
      });
      report = { runtime, status: 'unknown', checkedAt };
      try {
        const parsed = parseStatusJson(r.stdout) as { loggedIn?: unknown; authMethod?: unknown };
        const method = typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined;
        const status: LoginStatus =
          parsed.loggedIn === true
            ? 'logged_in'
            : parsed.loggedIn === false
              ? method !== undefined && method !== 'none'
                ? 'expired'
                : 'logged_out'
              : 'unknown';
        report = {
          runtime,
          status,
          checkedAt,
          ...(method !== undefined && /^[A-Za-z0-9_. -]{1,32}$/.test(method) && method !== 'none'
            ? { method }
            : {}),
        };
      } catch {
        // unreadable → unknown
      }
    } else {
      const r = await this.#d.run(binary, ['login', 'status'], {
        env: loginEnv(runtime, this.#d.env, acc.loginDir),
        cwd: tmpdir(),
        timeoutMs: 20_000,
      });
      const out = `${r.stdout}\n${r.stderr}`;
      const status: LoginStatus =
        r.exitCode === 0 ? 'logged_in' : /not logged in/i.test(out) ? 'logged_out' : 'unknown';
      const method = /using chatgpt/i.test(out) ? 'chatgpt' : /api key/i.test(out) ? 'api-key' : undefined;
      report = { runtime, status, checkedAt, ...(status === 'logged_in' && method ? { method } : {}) };
    }
    // The status command only reads the stored credential: a refresh that failed in a run still counts.
    if (this.#expired.has(key) && report.status === 'logged_in') {
      report = { ...report, status: 'expired', reason: LOGIN_EXPIRED };
    }
    report = { ...report, ...accountField };
    this.#status.set(key, report);
    return report;
  }

  async logout(runtime: LoginRuntime, account?: string): Promise<LoginReport> {
    const acc = this.#accountOf(runtime, account);
    const binary = await this.#d.binary(runtime);
    if (binary !== null && acc !== null) {
      await this.#d.run(binary, runtime === 'claude-code' ? ['auth', 'logout'] : ['logout'], {
        env: loginEnv(runtime, this.#d.env, acc.loginDir),
        cwd: tmpdir(),
        timeoutMs: 20_000,
      });
    }
    return this.status(runtime, account);
  }

  /**
   * p13-runtime-accounts: logs a removed account out with the runtime's own command (its config dir, before the caller
   * deletes the folder) — best effort, never throws.
   */
  async logoutDir(runtime: LoginRuntime, loginDir: string): Promise<void> {
    const binary = await this.#d.binary(runtime).catch(() => null);
    if (binary === null) return;
    await this.#d
      .run(binary, runtime === 'claude-code' ? ['auth', 'logout'] : ['logout'], {
        env: loginEnv(runtime, this.#d.env, loginDir),
        cwd: tmpdir(),
        timeoutMs: 20_000,
      })
      .catch(() => undefined);
  }
}

/** p10-claude-login-health: classifies a probe run (`claude -p … --output-format json`). */
export function probeOutcome(
  exitCode: number | null,
  timedOut: boolean,
  stdout: string,
  stderr: string,
): LoginProbeResult {
  if (!timedOut && exitCode === 0) {
    try {
      const parsed = parseStatusJson(stdout) as { is_error?: unknown; type?: unknown };
      if (parsed.is_error === false) return 'usable';
    } catch {
      // not JSON: fall through to the failure texts
    }
  }
  const cause = claudeLoginFailureCause(`${stdout}\n${stderr}`);
  // Contention means another process of the store refreshed it right now: no verdict on the login.
  return cause === 'expired' ? 'expired' : 'inconclusive';
}

/**
 * The outcome of a run for the login flag (job runner / assistant → daemon). Only a subscription login
 * (`localLogin`) can expire this way (an API-key credential is reported by the vault). p10-claude-login-health: a
 * lost refresh race (`refresh_contention`: another process of the same store refreshed it) is **not** an expiry — the
 * runtime stays signed in; only a real login failure flags it, and a successful run clears the flag. Returns whether
 * the flag changed (CAPABILITIES are then re-sent).
 */
export function applyRunLogin(
  login: Pick<LoginManager, 'isExpired' | 'markExpired' | 'clearExpired' | 'noteContention'>,
  runtime: string,
  state: 'expired' | 'ok',
  cause: 'refresh_contention' | 'expired' | undefined,
  localLogin: boolean,
  account?: string,
): boolean {
  if (runtime !== 'claude-code' && runtime !== 'codex') return false;
  const rt: LoginRuntime = runtime;
  if (state === 'expired' && !localLogin) return false;
  const before = login.isExpired(rt, account);
  if (state === 'expired' && cause === 'refresh_contention') login.noteContention(rt, account);
  else if (state === 'expired') login.markExpired(rt, LOGIN_EXPIRED, account);
  else login.clearExpired(rt, account);
  return before !== login.isExpired(rt, account);
}
