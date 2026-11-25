import { spawn } from 'node:child_process';

export interface ExecResult {
  /** `null` when killed (timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Written to stdin, then stdin is closed. Secret values go here — never into argv. */
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** Injectable process runner for the OS secret stores (tests substitute fakes). */
export type ExecFn = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** Runs without a shell; output capped at 1 MiB per stream. */
export const nodeExec: ExecFn = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 30_000);
    child.stdout.on('data', (b: Buffer) => {
      if ((outBytes += b.length) <= 1024 * 1024) out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      if ((errBytes += b.length) <= 1024 * 1024) err.push(b);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: killed ? null : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
