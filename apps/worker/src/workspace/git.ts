import { spawn } from 'node:child_process';
import { Redactor, SecretSet, type Revealable } from '@remyral/observability';
import { GitCommandError, GitNotFoundError } from './errors.js';
import type { RepoUrl } from './repo-url.js';

/**
 * Hardened git invocation (threat model T-SBX, ADR-0010): repository content is
 * attacker-controlled, so no git command we run may execute anything the
 * repository (or a user/system git config) supplies.
 *
 *  - `core.hooksPath` points at `/dev/null` (POSIX: `<hook>` can never exist under
 *    it) or an empty directory (Windows), so no hook runs — not even ones planted
 *    in the shared mirror.
 *  - System and global config are ignored (`GIT_CONFIG_NOSYSTEM`,
 *    `GIT_CONFIG_GLOBAL=/dev/null`), so a user's credential helpers, `url.*.insteadOf`,
 *    `core.fsmonitor`, aliases or templates cannot interfere.
 *  - Transport allowlist: only https/ssh (and file when explicitly allowed for
 *    the origin of a dev/test job); `ext::`, `git://`, plain `http://` are refused.
 *    Submodules are never recursed into implicitly.
 *  - Object fsck on fetch, no auto-gc, no fsmonitor, NTFS/HFS path protections.
 *  - No terminal prompts (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode=yes`).
 *  - A minimal environment: nothing of the daemon's environment is inherited
 *    except an explicit allowlist (PATH/HOME/... ), so daemon secrets never reach git.
 *  - Credentials: a per-command credential helper scoped to exactly the origin
 *    URL, reading the token from the git process environment. The token is never
 *    in argv (visible in `ps`), in a URL, in `.git/config`, or in logs.
 */

/** Variables copied from the daemon environment into git's (no secrets). */
export const GIT_PASSTHROUGH_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TZ',
  // Windows essentials
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'WINDIR',
  'TEMP',
  'TMP',
];

export const GIT_TOKEN_ENV = 'REMYRAL_GIT_TOKEN';
export const GIT_USERNAME_ENV = 'REMYRAL_GIT_USERNAME';

/**
 * Credential helper body. `!` makes git run it through `sh`; it answers only
 * `get`, never stores or erases, and prints the token from the environment.
 */
const CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; echo "username=\${${GIT_USERNAME_ENV}}"; echo "password=\${${GIT_TOKEN_ENV}}"; }; f`;

export interface GitRunnerOptions {
  /**
   * git executable, or a resolver called before every command (p5-live-fixes-2: config → worker-managed tool →
   * PATH, so a git installed while the worker runs is used without a restart). Default `git`.
   */
  binary?: string | (() => string | Promise<string>);
  /** Environment the passthrough variables are read from. Default `process.env`. */
  sourceEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Hooks directory used on Windows (an empty, worker-owned directory). */
  emptyHooksDir: string;
  /** Default timeout for local commands. Default 120 s. */
  timeoutMs?: number;
  /** Cap on captured stdout. Default 64 MiB. */
  maxOutputBytes?: number;
  /**
   * p22-git-preflight: the worker's workspace root. A repository under it that git refuses with "detected dubious
   * ownership" (another account owns the directory: Windows per-job accounts, a re-installed service account, a shared
   * cache) is trusted for exactly its own path (`-c safe.directory=<path>`, never `*`) and the command retried once.
   * Absent: never (the error propagates).
   */
  trustRoot?: string;
  /** Called once per directory trusted that way (logging). */
  onTrusted?: (path: string) => void;
}

export interface GitCall {
  /** Working directory (a worktree or the mirror). */
  cwd: string;
  args: readonly string[];
  /** Extra `-c key=value` pairs (after the hardening defaults, so they can only narrow file transport). */
  config?: readonly (readonly [string, string])[];
  /** Origin this call talks to; enables file transport for it when it is a file URL. */
  remote?: RepoUrl;
  /** Short-lived token for `remote` (credential helper, env only). */
  token?: Revealable;
  /** Username for the token. Default `x-access-token` (GitHub App installation tokens). */
  tokenUsername?: string;
  /**
   * p15-git-central: a project deploy key for an `ssh://` remote — a temporary key file (0600, deleted by the caller
   * after the command) and a pinned known_hosts file. git runs `ssh` with exactly these (no agent, no user config).
   */
  ssh?: { readonly keyFile: string; readonly knownHostsFile: string };
  input?: string;
  timeoutMs?: number;
  /** Redacts stderr/stdout attached to errors (job secret set + patterns). */
  redactor?: Redactor;
  /** Do not throw on these exit codes. */
  okCodes?: readonly number[];
  /** Directory above which git must not search for a repository. */
  ceiling?: string;
  /**
   * p11-session-continuity: a worker-owned index file (`GIT_INDEX_FILE`) — checkpoints stage the worktree into their
   * own index, never the worktree's.
   */
  indexFile?: string;
  /**
   * p22-git-preflight: stdout is streamed to this callback instead of being collected (no output cap; `stdout` of the
   * result is empty). For large outputs consumed line by line (the pre-push secret scan). A throwing callback kills git.
   */
  onStdout?: (chunk: Buffer) => void;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitRunner {
  readonly #binary: string | (() => string | Promise<string>);
  #lastBinary: string;
  readonly #sourceEnv: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #hooksPath: string;
  readonly #timeoutMs: number;
  readonly #maxOutput: number;
  readonly #trustRoot: string | null;
  readonly #onTrusted: ((path: string) => void) | undefined;
  /** p22-git-preflight: exact repository paths trusted after a dubious-ownership refusal (`safe.directory`). */
  readonly #safeDirectories = new Set<string>();

  constructor(options: GitRunnerOptions) {
    this.#binary = options.binary ?? 'git';
    this.#lastBinary = typeof this.#binary === 'string' ? this.#binary : 'git';
    this.#sourceEnv = options.sourceEnv ?? process.env;
    this.#platform = options.platform ?? process.platform;
    this.#hooksPath = this.#platform === 'win32' ? options.emptyHooksDir : '/dev/null';
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#maxOutput = options.maxOutputBytes ?? 64 * 1024 * 1024;
    this.#trustRoot = options.trustRoot ?? null;
    this.#onTrusted = options.onTrusted;
  }

  /** p22-git-preflight: the directories trusted so far (tests, diagnostics). */
  get safeDirectories(): readonly string[] {
    return [...this.#safeDirectories];
  }

  /** The executable of the last command (or the configured one before the first). */
  get binary(): string {
    return this.#lastBinary;
  }

  /** Resolves the git executable now (a failing resolver falls back to `git` on PATH). */
  async resolveBinary(): Promise<string> {
    const b = this.#binary;
    if (typeof b === 'string') return b;
    try {
      const resolved = await b();
      this.#lastBinary = resolved === '' ? 'git' : resolved;
    } catch {
      this.#lastBinary = 'git';
    }
    return this.#lastBinary;
  }

  get hooksPath(): string {
    return this.#hooksPath;
  }

  /** The hardening `-c` pairs applied to every call (exported for tests and docs). */
  hardeningConfig(remote?: RepoUrl): [string, string][] {
    const fileAllowed = remote?.protocol === 'file';
    return [
      ['core.hooksPath', this.#hooksPath],
      ['core.fsmonitor', 'false'],
      ['core.protectNTFS', 'true'],
      ['core.protectHFS', 'true'],
      ['core.askPass', ''],
      ['credential.helper', ''],
      ['protocol.allow', 'never'],
      ['protocol.https.allow', 'always'],
      ['protocol.ssh.allow', 'always'],
      ['protocol.file.allow', fileAllowed ? 'always' : 'never'],
      ['protocol.ext.allow', 'never'],
      ['submodule.recurse', 'false'],
      ['fetch.recurseSubmodules', 'false'],
      ['transfer.fsckObjects', 'true'],
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
      ['commit.gpgSign', 'false'],
      ['tag.gpgSign', 'false'],
      ['advice.detachedHead', 'false'],
      ['init.defaultBranch', 'main'],
      ...[...this.#safeDirectories].map((d): [string, string] => ['safe.directory', d]),
    ];
  }

  /** Minimal environment for git; never contains daemon secrets. */
  env(
    call: Pick<GitCall, 'token' | 'tokenUsername' | 'ceiling' | 'indexFile' | 'ssh'> = {},
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of GIT_PASSTHROUGH_ENV) {
      const value = this.#sourceEnv[name];
      if (value !== undefined) env[name] = value;
    }
    Object.assign(env, {
      LC_ALL: 'C',
      LANG: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GIT_OPTIONAL_LOCKS: '0',
    });
    if (call.ceiling !== undefined) env.GIT_CEILING_DIRECTORIES = call.ceiling;
    if (call.indexFile !== undefined) env.GIT_INDEX_FILE = call.indexFile;
    if (call.ssh !== undefined) env.GIT_SSH_COMMAND = sshCommand(call.ssh, this.#platform);
    if (call.token !== undefined) {
      env[GIT_TOKEN_ENV] = call.token.reveal();
      env[GIT_USERNAME_ENV] = call.tokenUsername ?? 'x-access-token';
    }
    return env;
  }

  /** Full argv (without the binary). Exported for tests: must never contain a token. */
  argv(call: GitCall): string[] {
    const pairs = [...this.hardeningConfig(call.remote), ...(call.config ?? [])];
    if (call.token !== undefined && call.remote !== undefined) {
      // Scoped to exactly this URL; the empty `credential.helper` above reset any other helper.
      pairs.push([`credential.${call.remote.url}.helper`, CREDENTIAL_HELPER]);
    }
    const args: string[] = ['--no-pager'];
    for (const [k, v] of pairs) args.push('-c', `${k}=${v}`);
    args.push(...call.args);
    return args;
  }

  async run(call: GitCall): Promise<GitResult> {
    try {
      return await this.#runOnce(call);
    } catch (err) {
      // p22-git-preflight: a repository of the worker's own root owned by another account — trusted for its exact path.
      const path = err instanceof GitCommandError ? dubiousOwnershipPath(err.stderr) : null;
      if (path === null || this.#safeDirectories.has(path) || !this.#trustable(path)) throw err;
      this.#safeDirectories.add(path);
      this.#onTrusted?.(path);
      return this.#runOnce(call);
    }
  }

  /** Strictly inside the trust root (never the root itself or above, never a wildcard or `..`). */
  #trustable(path: string): boolean {
    if (this.#trustRoot === null || path.includes('*') || path.split(/[\\/]/).includes('..')) return false;
    const win = this.#platform === 'win32';
    const norm = (p: string): string => {
      const slashed = (win ? p.split('\\').join('/') : p).replace(/\/+$/, '');
      return win ? slashed.toLowerCase() : slashed;
    };
    const root = norm(this.#trustRoot);
    return root !== '' && norm(path).startsWith(`${root}/`);
  }

  async #runOnce(call: GitCall): Promise<GitResult> {
    const args = this.argv(call);
    const env = this.env(call);
    const timeoutMs = call.timeoutMs ?? this.#timeoutMs;
    const subcommand = call.args.find((a) => !a.startsWith('-')) ?? '?';
    const binary = await this.resolveBinary();
    const result = await new Promise<GitResult & { killed: boolean }>((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: call.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (b: Buffer) => {
        if (call.onStdout !== undefined) {
          try {
            call.onStdout(b);
          } catch {
            killed = true;
            child.kill('SIGKILL');
          }
          return;
        }
        outBytes += b.length;
        if (outBytes > this.#maxOutput) {
          killed = true;
          child.kill('SIGKILL');
          return;
        }
        out.push(b);
      });
      child.stderr.on('data', (b: Buffer) => {
        if (errBytes < 64 * 1024) err.push(b);
        errBytes += b.length;
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(e.code === 'ENOENT' ? new GitNotFoundError(binary) : e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          killed,
        });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(call.input ?? '');
    });
    if (result.killed || (result.code !== 0 && !(call.okCodes ?? []).includes(result.code))) {
      const stderr = redactOutput(result.stderr, call);
      throw new GitCommandError(
        subcommand,
        result.killed ? null : result.code,
        result.killed ? `timed out or output limit exceeded. ${stderr}` : stderr,
      );
    }
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

/**
 * p15-git-central: `ssh` for a project deploy key — only this key (`IdentitiesOnly`, no agent), no user or system ssh
 * config (`-F none`), only the pinned known_hosts (`StrictHostKeyChecking=yes`, global file ignored), never a prompt.
 * git runs GIT_SSH_COMMAND through its shell (also on Windows), so paths are single-quoted with forward slashes.
 */
export function sshCommand(
  ssh: { readonly keyFile: string; readonly knownHostsFile: string },
  platform: NodeJS.Platform = process.platform,
): string {
  const q = (p: string): string => {
    const path = platform === 'win32' ? p.split('\\').join('/') : p;
    return `'${path.split("'").join("'\\''")}'`;
  };
  return [
    'ssh',
    '-F',
    'none',
    '-i',
    q(ssh.keyFile),
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'IdentityAgent=none',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${q(ssh.knownHostsFile)}`,
    '-o',
    'GlobalKnownHostsFile=none',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
  ].join(' ');
}

/**
 * p15-git-central: does this git failure mean the remote refused our credential (expired / revoked token, no
 * credential at all, a refused deploy key)? Such a failure is retried once with a freshly minted credential.
 */
export function isGitAuthFailure(err: unknown): boolean {
  if (!(err instanceof GitCommandError)) return false;
  return GIT_AUTH_FAILURE.test(err.stderr);
}

const GIT_AUTH_FAILURE =
  /Invalid username or (?:password|token)|Authentication failed|HTTP Basic: Access denied|could not read (?:Username|Password)|terminal prompts disabled|returned error: 40[13]|Permission denied \(publickey|Bad credentials/i;

/**
 * p22-git-preflight: the repository path of git's "detected dubious ownership in repository at '<path>'" refusal, or
 * null for any other failure.
 */
export function dubiousOwnershipPath(stderr: string): string | null {
  const m = /detected dubious ownership in repository at '([^'\n]{1,1024})'/.exec(stderr);
  return m?.[1] ?? null;
}

/**
 * p22-git-preflight: a local ref of the worker's cached clone points at an object that is not there (a worker killed
 * while writing, a disk error): `fatal: bad object refs/heads/rac/…` on fetch, `missing object <sha> for refs/…`.
 */
export function isBrokenRefFailure(err: unknown): boolean {
  if (!(err instanceof GitCommandError)) return false;
  return /\bbad object refs\/|\bmissing object [0-9a-f]{7,64} for refs\//.test(err.stderr);
}

/** Job redactor (if any), then the token itself and the default patterns. */
function redactOutput(text: string, call: GitCall): string {
  const secrets = new SecretSet();
  if (call.token !== undefined) {
    const value = call.token.reveal();
    if (value.length >= 6) secrets.add(value, GIT_TOKEN_ENV);
  }
  const once = call.redactor === undefined ? text : call.redactor.redact(text);
  return new Redactor({ secrets }).redact(once);
}
