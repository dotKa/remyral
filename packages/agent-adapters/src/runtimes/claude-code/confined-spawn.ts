import { EventEmitter } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { ProcessConfiner } from '../../process/confinement.js';
import { spawnOwnedProcess, type OwnedProcess, type SpawnImpl } from '../../process/owned-process.js';
import type { ProcessTreeKiller } from '../../process/tree-killer.js';
import type { SecretEnv } from '../../secrets.js';

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

export interface ConfinedSpawnerOptions {
  /** Fallback cwd if the SDK passes none (the session's workspace root). */
  readonly cwd: string;
  /** Secrets injected into the CLI's env only (never through SDK options, never argv). */
  readonly secretEnv: SecretEnv;
  /** ADR-0007 execution sandbox hook; the CLI and its whole tree start confined. */
  readonly confiner?: ProcessConfiner;
  readonly treeKiller?: ProcessTreeKiller;
  /** Grace between SIGTERM to the tree and the tree kill when the SDK kills the process. */
  readonly killGraceMs: number;
  /** Test injection. */
  readonly spawnImpl?: SpawnImpl;
  /** Called once the owned process exists (the adapter keeps it to reap the tree on cleanup). */
  readonly onSpawned?: (proc: OwnedProcess) => void;
  readonly onSpawnError?: (error: Error) => void;
  /** p6-capacity-advice: the CLI's pid, for the worker's memory measurement. */
  readonly onPid?: (pid: number) => void;
}

/**
 * `SpawnedProcess` handed to the SDK while the real child is started
 * asynchronously through `spawnOwnedProcess` (+ confiner). The SDK's
 * `spawnClaudeCodeProcess` hook is synchronous (sdk.d.ts 0.3.296), our
 * confiner is async, so stdin/stdout are pass-through streams that are wired
 * to the child once it exists; writes before that are buffered.
 */
export class DeferredOwnedProcess implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly ready: Promise<OwnedProcess | undefined>;
  private readonly events = new EventEmitter();
  private readonly stdinPipe = new PassThrough();
  private readonly stdoutPipe = new PassThrough();
  private owned: OwnedProcess | undefined;
  private exitCodeValue: number | null = null;
  private signalCodeValue: NodeJS.Signals | null = null;
  private killRequested: NodeJS.Signals | undefined;
  private wasKilled = false;
  private exitedFlag = false;

  constructor(
    start: () => Promise<OwnedProcess>,
    private readonly killGraceMs: number,
    hooks: Pick<ConfinedSpawnerOptions, 'onSpawned' | 'onSpawnError'> = {},
  ) {
    this.stdin = this.stdinPipe;
    this.stdout = this.stdoutPipe;
    // The SDK may register listeners late; never let an 'error' go unhandled.
    this.events.on('error', () => undefined);
    this.ready = start().then(
      (proc) => {
        this.owned = proc;
        hooks.onSpawned?.(proc);
        proc.stdin.on('error', () => undefined);
        this.stdinPipe.pipe(proc.stdin);
        proc.stdout.pipe(this.stdoutPipe);
        void proc.exited.then((exit) => {
          this.markExited(exit.code, exit.signal);
        });
        if (this.killRequested) this.applyKill(this.killRequested);
        return proc;
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        hooks.onSpawnError?.(error);
        this.events.emit('error', error);
        this.stdoutPipe.end();
        this.markExited(1, null);
        return undefined;
      },
    );
  }

  get killed(): boolean {
    return this.wasKilled;
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.signalCodeValue;
  }

  /** The owned process once started (undefined before / after a failed start). */
  get process(): OwnedProcess | undefined {
    return this.owned;
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.exitedFlag) return false;
    this.wasKilled = true;
    if (!this.owned) {
      this.killRequested = signal;
      return true;
    }
    this.applyKill(signal);
    return true;
  }

  on(event: 'exit', listener: ExitListener): void;
  on(event: 'error', listener: ErrorListener): void;
  on(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    this.events.on(event, listener);
  }

  once(event: 'exit', listener: ExitListener): void;
  once(event: 'error', listener: ErrorListener): void;
  once(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    this.events.once(event, listener);
  }

  off(event: 'exit', listener: ExitListener): void;
  off(event: 'error', listener: ErrorListener): void;
  off(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    this.events.off(event, listener);
  }

  private applyKill(signal: NodeJS.Signals): void {
    const proc = this.owned;
    if (!proc) return;
    // Any kill from the SDK ends with the whole tree gone (ADR-0012 rule 4).
    if (signal === 'SIGKILL') void proc.killTree().catch(() => undefined);
    else void proc.terminate({ graceMs: this.killGraceMs, signal }).catch(() => proc.killTree());
  }

  private markExited(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitedFlag) return;
    this.exitedFlag = true;
    this.exitCodeValue = code;
    this.signalCodeValue = signal;
    this.events.emit('exit', code, signal);
  }
}

/**
 * Builds the SDK `spawnClaudeCodeProcess` hook: the CLI (and everything it
 * starts) runs as a worker-owned process tree, optionally confined.
 */
export function createConfinedSpawner(
  opts: ConfinedSpawnerOptions,
): (options: SpawnOptions) => DeferredOwnedProcess {
  return (spawnOpts) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(spawnOpts.env)) if (v !== undefined) env[k] = v;
    const deferred = new DeferredOwnedProcess(
      () =>
        spawnOwnedProcess({
          command: spawnOpts.command,
          args: spawnOpts.args,
          cwd: spawnOpts.cwd ?? opts.cwd,
          env,
          inheritEnv: [],
          secretEnv: opts.secretEnv,
          stdin: 'pipe',
          ...(opts.confiner ? { confiner: opts.confiner } : {}),
          ...(opts.treeKiller ? { treeKiller: opts.treeKiller } : {}),
          ...(opts.spawnImpl ? { spawnImpl: opts.spawnImpl } : {}),
          ...(opts.onPid ? { onSpawned: opts.onPid } : {}),
        }),
      opts.killGraceMs,
      {
        ...(opts.onSpawned ? { onSpawned: opts.onSpawned } : {}),
        ...(opts.onSpawnError ? { onSpawnError: opts.onSpawnError } : {}),
      },
    );
    // The SDK's forwarded signal fires only after its stdin-EOF + grace path.
    spawnOpts.signal.addEventListener(
      'abort',
      () => {
        deferred.kill('SIGTERM');
      },
      { once: true },
    );
    return deferred;
  };
}
