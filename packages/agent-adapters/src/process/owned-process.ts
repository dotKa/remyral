import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { CancelTimeoutError, RuntimeCrashedError, SecretInArgvError, type ExitInfo } from '../errors.js';
import { redactSecrets, type SecretEnv } from '../secrets.js';
import type { ProcessConfiner } from './confinement.js';
import { TailBuffer } from './tail-buffer.js';
import { defaultTreeKiller, type ProcessTreeKiller } from './tree-killer.js';

/**
 * Non-secret variables copied from the worker's environment by default. Every
 * other variable must be passed explicitly — the worker's own credentials are
 * never inherited by a runtime.
 */
export const DEFAULT_INHERITED_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TZ',
  // Windows essentials
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'WINDIR',
];

export type SpawnImpl = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface SpawnOwnedOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Explicit, non-secret environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Names copied from `process.env`; defaults to DEFAULT_INHERITED_ENV. */
  readonly inheritEnv?: readonly string[];
  /** Secrets, injected into the child's env only. */
  readonly secretEnv?: SecretEnv;
  /** Per-stream tail capture limit. Default 64 KiB. */
  readonly maxBufferBytes?: number;
  readonly stdin?: 'pipe' | 'ignore';
  readonly treeKiller?: ProcessTreeKiller;
  /**
   * Execution sandbox (ADR-0007): rewrites the spawn plan so the runtime starts
   * confined. Its tree killer (if any) takes precedence over `treeKiller`.
   */
  readonly confiner?: ProcessConfiner;
  /** Injection point for tests / platform fakes. */
  readonly spawnImpl?: SpawnImpl;
  readonly sourceEnv?: NodeJS.ProcessEnv;
  /**
   * p6-capacity-advice: told the pid once the process exists (the worker measures the memory of the tree under
   * it). Must not throw; a throwing observer is ignored.
   */
  readonly onSpawned?: (pid: number) => void;
}

export interface ProcessExit extends ExitInfo {
  readonly durationMs: number;
}

export interface TerminateOptions {
  /** Time between the graceful signal and the tree kill. */
  readonly graceMs: number;
  /** Time to wait for the leader to exit after the tree kill. Default 5000. */
  readonly killWaitMs?: number;
  readonly signal?: NodeJS.Signals;
}

export interface TerminateOutcome {
  readonly mode: 'graceful' | 'forced' | 'already-exited';
  readonly exit: ProcessExit;
}

/** Build the child environment. Exported for tests: secrets come only from `secretEnv`. */
export function buildChildEnv(opts: SpawnOwnedOptions): Record<string, string> {
  const source = opts.sourceEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const name of opts.inheritEnv ?? DEFAULT_INHERITED_ENV) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, opts.env ?? {});
  for (const [name, secret] of Object.entries(opts.secretEnv ?? {})) env[name] = secret.reveal();
  return env;
}

/** Secrets in argv are visible to every local user via `ps`; refuse. */
export function assertNoSecretsInArgv(command: string, args: readonly string[], secrets: SecretEnv): void {
  for (const [name, secret] of Object.entries(secrets)) {
    const value = secret.reveal();
    if (command.includes(value) || args.some((a) => a.includes(value))) throw new SecretInArgvError(name);
  }
}

/**
 * A child process the worker owns together with all its descendants.
 * Construct via `spawnOwnedProcess`.
 */
export class OwnedProcess {
  readonly exited: Promise<ProcessExit>;
  private exitInfo: ProcessExit | undefined;
  private readonly startedAt = Date.now();
  private readonly stdoutTailBuf: TailBuffer;
  private readonly stderrTailBuf: TailBuffer;
  private terminating: Promise<TerminateOutcome> | undefined;
  private disposing: Promise<void> | undefined;

  constructor(
    readonly child: ChildProcess,
    readonly pid: number,
    private readonly killer: ProcessTreeKiller,
    private readonly secrets: SecretEnv,
    maxBufferBytes: number,
    /** Label of the confinement this process runs in (`ProcessConfiner.kind`), if any. */
    readonly confinement?: string,
    private readonly disposeConfinement?: () => Promise<void>,
  ) {
    this.stdoutTailBuf = new TailBuffer(maxBufferBytes);
    this.stderrTailBuf = new TailBuffer(maxBufferBytes);
    child.stdout?.on('data', (c: Buffer) => {
      this.stdoutTailBuf.push(c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      this.stderrTailBuf.push(c);
    });
    // `exit`, not `close`: a grandchild holding the pipes open must not hide the leader's exit.
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.exitInfo = { code, signal, durationMs: Date.now() - this.startedAt };
        resolve(this.exitInfo);
      });
    });
  }

  get stdout(): Readable {
    if (!this.child.stdout) throw new Error('stdout not piped');
    return this.child.stdout;
  }

  get stdin(): Writable {
    if (!this.child.stdin) throw new Error('stdin not piped');
    return this.child.stdin;
  }

  get stderr(): Readable {
    if (!this.child.stderr) throw new Error('stderr not piped');
    return this.child.stderr;
  }

  get exit(): ProcessExit | undefined {
    return this.exitInfo;
  }

  get treeKillerKind(): ProcessTreeKiller['kind'] {
    return this.killer.kind;
  }

  /** Last bytes of stdout, secrets redacted. */
  stdoutTail(): string {
    return redactSecrets(this.stdoutTailBuf.toString(), this.secrets);
  }

  /** Last bytes of stderr, secrets redacted. */
  stderrTail(): string {
    return redactSecrets(this.stderrTailBuf.toString(), this.secrets);
  }

  /**
   * Kills whatever is left of the tree (also after a normal leader exit: detached
   * grandchildren) and removes what the confinement created (container, network,
   * proxy, temp files). Idempotent; call when the process is no longer needed,
   * including after `terminate()`.
   */
  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      await this.killer.kill(this.pid).catch(() => undefined);
      await this.disposeConfinement?.();
    })();
    return this.disposing;
  }

  /** Immediately kill the whole tree. */
  async killTree(): Promise<void> {
    await this.killer.kill(this.pid);
  }

  /**
   * Graceful signal to the tree -> wait `graceMs` -> kill the tree. The tree is
   * always force-killed at the end, even after a graceful leader exit, so that
   * grandchildren which ignored the signal do not survive as orphans.
   * Concurrent calls share one termination.
   */
  terminate(opts: TerminateOptions): Promise<TerminateOutcome> {
    this.terminating ??= this.doTerminate(opts);
    return this.terminating;
  }

  private async doTerminate(opts: TerminateOptions): Promise<TerminateOutcome> {
    if (this.exitInfo) {
      await this.killer.kill(this.pid);
      return { mode: 'already-exited', exit: this.exitInfo };
    }
    // On Windows no tree signal exists (returns false): the grace period then only
    // covers the runtime-native interrupt the adapter sent before calling terminate().
    this.killer.signal(this.pid, opts.signal ?? 'SIGTERM');
    const graceful = await raceTimeout(this.exited, opts.graceMs);
    if (graceful) {
      await this.killer.kill(this.pid);
      return { mode: 'graceful', exit: graceful };
    }
    await this.killer.kill(this.pid);
    const killWaitMs = opts.killWaitMs ?? 5000;
    const exit = await raceTimeout(this.exited, killWaitMs);
    if (!exit)
      throw new CancelTimeoutError(opts.graceMs + killWaitMs, `pid ${String(this.pid)} survived tree kill`);
    return { mode: 'forced', exit };
  }
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
    void promise.then((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

/**
 * Start a child that the worker owns as a tree (own process group on POSIX).
 * Resolves once the OS reports the process as spawned; rejects with
 * `RuntimeCrashedError` if it cannot be started.
 */
export async function spawnOwnedProcess(opts: SpawnOwnedOptions): Promise<OwnedProcess> {
  const secrets = opts.secretEnv ?? {};
  assertNoSecretsInArgv(opts.command, opts.args, secrets);
  let plan = { command: opts.command, args: opts.args, cwd: opts.cwd, env: buildChildEnv(opts) };
  let confinedKiller: ProcessTreeKiller | undefined;
  let dispose: (() => Promise<void>) | undefined;
  if (opts.confiner) {
    const confined = await opts.confiner.confine({ ...plan, secretNames: Object.keys(secrets) });
    dispose = confined.dispose;
    try {
      assertNoSecretsInArgv(confined.command, confined.args, secrets);
    } catch (error) {
      await dispose?.();
      throw error;
    }
    plan = { command: confined.command, args: confined.args, cwd: confined.cwd, env: { ...confined.env } };
    confinedKiller = confined.treeKiller;
  }
  const killer = confinedKiller ?? opts.treeKiller ?? defaultTreeKiller();
  const spawnImpl = opts.spawnImpl ?? ((c, a, o) => nodeSpawn(c, [...a], o));
  const child = spawnImpl(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    detached: killer.detached,
    shell: false,
    windowsHide: true,
    stdio: [opts.stdin ?? 'pipe', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        reject(
          new RuntimeCrashedError('process', undefined, `failed to start ${opts.command}: ${err.message}`),
        );
      };
      child.once('error', onError);
      child.once('spawn', () => {
        child.off('error', onError);
        resolve();
      });
    });
  } catch (error) {
    await dispose?.();
    throw error;
  }
  // Later 'error' events (e.g. EPIPE on kill) must not crash the worker; exit is observed via 'exit'.
  child.on('error', () => undefined);
  const pid = child.pid;
  if (pid === undefined) {
    await dispose?.();
    throw new RuntimeCrashedError('process', undefined, `no pid for ${opts.command}`);
  }
  try {
    opts.onSpawned?.(pid);
  } catch {
    // observation only
  }
  return new OwnedProcess(
    child,
    pid,
    killer,
    secrets,
    opts.maxBufferBytes ?? 64 * 1024,
    opts.confiner?.kind,
    dispose,
  );
}
