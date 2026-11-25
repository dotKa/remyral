import { spawn } from 'node:child_process';

/**
 * Hardened git invocation for the master (same rules as the worker's GitRunner, docs/design/p3-workspace
 * §5; ADR-0010): repository content is untrusted, so no command may run hooks, filters, fsmonitor or any
 * helper from a system/global config. Only https/ssh transports (file only for an explicitly allowed
 * test/dev origin), no prompts, minimal environment, bounded time and output.
 */
export interface GitExecOptions {
  readonly binary?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Allow `file://` transport (tests / local development only; never a config key). */
  readonly allowFile?: boolean;
  /** Environment the passthrough variables are read from. */
  readonly sourceEnv?: NodeJS.ProcessEnv;
}

export interface GitExecCall {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly input?: string;
  readonly okCodes?: readonly number[];
  readonly timeoutMs?: number;
  /** Extra non-secret environment (commit identity). */
  readonly env?: Readonly<Record<string, string>>;
  /** No repository discovery above this directory. */
  readonly ceiling?: string;
}

export interface GitExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class GitExecError extends Error {
  override name = 'GitExecError';
  constructor(
    readonly subcommand: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${subcommand} failed${code === null ? ' (timeout/output limit)' : ` (exit ${String(code)})`}`);
  }
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const PASSTHROUGH = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TZ',
  'SSH_AUTH_SOCK',
  'SystemRoot',
  'TEMP',
  'TMP',
];

export class GitExec {
  readonly #binary: string;
  readonly #timeoutMs: number;
  readonly #maxOutput: number;
  readonly #allowFile: boolean;
  readonly #sourceEnv: NodeJS.ProcessEnv;

  constructor(opts: GitExecOptions = {}) {
    this.#binary = opts.binary ?? 'git';
    this.#timeoutMs = opts.timeoutMs ?? 60_000;
    this.#maxOutput = opts.maxOutputBytes ?? 32 * 1024 * 1024;
    this.#allowFile = opts.allowFile === true;
    this.#sourceEnv = opts.sourceEnv ?? process.env;
  }

  /** Hardening `-c` pairs applied to every call. */
  config(): [string, string][] {
    return [
      ['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'],
      ['core.fsmonitor', 'false'],
      ['core.askPass', ''],
      ['credential.helper', ''],
      ['protocol.allow', 'never'],
      ['protocol.https.allow', 'always'],
      ['protocol.ssh.allow', 'always'],
      ['protocol.file.allow', this.#allowFile ? 'always' : 'never'],
      ['protocol.ext.allow', 'never'],
      ['submodule.recurse', 'false'],
      ['fetch.recurseSubmodules', 'false'],
      ['transfer.fsckObjects', 'true'],
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
      ['commit.gpgSign', 'false'],
      ['core.attributesFile', process.platform === 'win32' ? 'NUL' : '/dev/null'],
      // No `.gitattributes` from any tree (a change could otherwise mark files `merge=union` and turn a
      // conflict into a silent clean merge): attributes are read from the empty tree.
      ['attr.tree', EMPTY_TREE],
      ['merge.renames', 'true'],
    ];
  }

  env(call: Pick<GitExecCall, 'env' | 'ceiling'>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of PASSTHROUGH) {
      const v = this.#sourceEnv[name];
      if (v !== undefined) env[name] = v;
    }
    Object.assign(env, {
      LC_ALL: 'C',
      LANG: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
    });
    if (call.ceiling !== undefined) env.GIT_CEILING_DIRECTORIES = call.ceiling;
    return { ...env, ...call.env };
  }

  async run(call: GitExecCall): Promise<GitExecResult> {
    const args = ['--no-pager'];
    for (const [k, v] of this.config()) args.push('-c', `${k}=${v}`);
    args.push(...call.args);
    const subcommand = call.args.find((a) => !a.startsWith('-')) ?? '?';
    const result = await new Promise<GitExecResult & { killed: boolean }>((resolve, reject) => {
      const child = spawn(this.#binary, args, {
        cwd: call.cwd,
        env: this.env(call),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let bytes = 0;
      let errBytes = 0;
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, call.timeoutMs ?? this.#timeoutMs);
      child.stdout.on('data', (b: Buffer) => {
        bytes += b.length;
        if (bytes > this.#maxOutput) {
          killed = true;
          child.kill('SIGKILL');
          return;
        }
        out.push(b);
      });
      child.stderr.on('data', (b: Buffer) => {
        if (errBytes < 16 * 1024) err.push(b);
        errBytes += b.length;
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
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
      throw new GitExecError(subcommand, result.killed ? null : result.code, result.stderr.slice(0, 2000));
    }
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}
