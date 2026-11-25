import type { ExecOptions, ExecResult, HttpResponse, ServerProcess, System } from '../src/system/types.js';

export interface ExecCall {
  file: string;
  args: readonly string[];
  options: ExecOptions;
}

export interface ServerCall {
  file: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
}

export type ExecHandler = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => ExecResult | undefined;
export type HttpHandler = (url: string, headers: Readonly<Record<string, string>>) => HttpResponse;

export const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
export const fail = (code = 1, stderr = ''): ExecResult => ({
  exitCode: code,
  stdout: '',
  stderr,
  timedOut: false,
});
const ENOENT: ExecResult = { exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' };

export interface FakeOptions {
  platform?: string;
  arch?: string;
  machine?: string;
  release?: string;
  kernelVersion?: string;
  hostname?: string;
  nodeVersion?: string;
  totalMemoryBytes?: number;
  diskFreeBytes?: number | null;
  homedir?: string;
  env?: Record<string, string>;
  /** Existing files; value is the text content (for readText). */
  files?: Record<string, string>;
  realpaths?: Record<string, string>;
  exec?: ExecHandler;
  http?: HttpHandler;
  /** Exit code reported by a spawned server immediately (simulates a crash on start). */
  serverExitsWith?: number | null;
}

/** In-memory {@link System} for unit tests; records every call. */
export class FakeSystem implements System {
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly execCalls: ExecCall[] = [];
  readonly serverCalls: ServerCall[] = [];
  readonly httpCalls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  readonly removedDirs: string[] = [];
  stoppedServers = 0;
  private clock = 0;
  private readonly env: Record<string, string>;

  constructor(private readonly o: FakeOptions = {}) {
    this.platform = o.platform ?? 'darwin';
    this.arch = o.arch ?? 'arm64';
    this.nodeVersion = o.nodeVersion ?? '24.19.0';
    this.env = o.env ?? { PATH: '/usr/bin:/bin' };
  }

  machine = () => this.o.machine ?? (this.arch === 'x64' ? 'x86_64' : 'arm64');
  release = () => this.o.release ?? '25.6.0';
  kernelVersion = () => this.o.kernelVersion ?? 'Darwin Kernel Version 25.6.0';
  hostname = () => this.o.hostname ?? 'test-host';
  cpuCount = () => 8;
  totalMemoryBytes = () => this.o.totalMemoryBytes ?? 16 * 1024 ** 3;
  homedir = () => this.o.homedir ?? (this.platform === 'win32' ? 'C:\\Users\\op' : '/home/op');
  tmpdir = () => (this.platform === 'win32' ? 'C:\\Temp' : '/tmp');

  getEnv(name: string): string | undefined {
    if (this.platform !== 'win32') return this.env[name];
    const key = Object.keys(this.env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : this.env[key];
  }

  exec(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ file, args, options });
    return Promise.resolve(this.o.exec?.(file, args, options) ?? ENOENT);
  }

  spawnServer(
    file: string,
    args: readonly string[],
    options: { env: Readonly<Record<string, string>>; cwd: string },
  ): ServerProcess {
    this.serverCalls.push({ file, args, env: options.env, cwd: options.cwd });
    let exit: number | null | undefined = this.o.serverExitsWith;
    return {
      pid: 4242,
      output: () => '',
      exitCode: () => exit,
      stop: () => {
        this.stoppedServers++;
        exit ??= 0;
        return Promise.resolve();
      },
    };
  }

  private fileKey(p: string): string {
    return this.platform === 'win32' ? p.toLowerCase() : p;
  }

  private hasFile(p: string): boolean {
    const files = this.o.files ?? {};
    return Object.keys(files).some((f) => this.fileKey(f) === this.fileKey(p));
  }

  isFile(p: string): Promise<boolean> {
    return Promise.resolve(this.hasFile(p));
  }

  readText(p: string, maxBytes: number): Promise<string | null> {
    const files = this.o.files ?? {};
    const key = Object.keys(files).find((f) => this.fileKey(f) === this.fileKey(p));
    return Promise.resolve(key === undefined ? null : (files[key] ?? '').slice(0, maxBytes));
  }

  realpath(p: string): Promise<string | null> {
    return Promise.resolve(this.o.realpaths?.[p] ?? (this.hasFile(p) ? p : null));
  }

  diskFreeBytes(): Promise<number | null> {
    return Promise.resolve(this.o.diskFreeBytes === undefined ? 100 * 1024 ** 3 : this.o.diskFreeBytes);
  }

  makeTempDir(prefix: string): Promise<string> {
    return Promise.resolve(this.platform === 'win32' ? `C:\\Temp\\${prefix}x1` : `/tmp/${prefix}x1`);
  }

  removeDir(p: string): Promise<void> {
    this.removedDirs.push(p);
    return Promise.resolve();
  }

  httpGetLoopback(url: string, headers: Readonly<Record<string, string>>): Promise<HttpResponse> {
    this.httpCalls.push({ url, headers });
    if (!this.o.http) return Promise.reject(new Error('ECONNREFUSED'));
    try {
      return Promise.resolve(this.o.http(url, headers));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  freeLoopbackPort = () => Promise.resolve(45678);
  randomSecret = () => 'S3cr3t-per-run-0123456789abcdefghijklmnopqrstuv';
  now = () => new Date('2026-10-12T12:00:00.000Z');
  monotonicMs = () => (this.clock += 10);
  sleep = () => Promise.resolve();
}
