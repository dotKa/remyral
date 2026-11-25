import { spawn } from 'node:child_process';

export interface RunResult {
  readonly exitCode: number | null;
  /** Bounded tails (never relayed or logged verbatim by remote ops). */
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError?: string;
}

export interface RunOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /** Bytes kept per stream. Default 64 KiB. */
  readonly maxBytes?: number;
}

export type RunFn = (file: string, args: readonly string[], opts: RunOptions) => Promise<RunResult>;

/**
 * Runs a helper process (python -m venv, pip, a runtime's status command) without a shell, with a hard
 * timeout, cancellation and bounded output. On POSIX the child gets its own process group and the group is
 * killed on timeout / abort.
 */
export const runProcess: RunFn = (file, args, opts) =>
  new Promise((resolve) => {
    const max = opts.maxBytes ?? 64 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(file, [...args], {
      cwd: opts.cwd,
      env: { ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: false,
    });
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const keep = (prev: string, chunk: Buffer) => {
      const next = prev + chunk.toString('utf8');
      return next.length > max ? next.slice(next.length - max) : next;
    };
    child.stdout.on('data', (c: Buffer) => {
      stdout = keep(stdout, c);
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = keep(stderr, c);
    });
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      done({ exitCode: null, stdout, stderr, timedOut, spawnError: err.code ?? 'spawn_failed' });
    });
    child.on('close', (code) => {
      done({ exitCode: code, stdout, stderr, timedOut });
    });
  });
