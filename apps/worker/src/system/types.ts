/**
 * Injectable boundary between the probe and the operating system. Everything the
 * probe needs from the host goes through this interface so unit tests can run with
 * fakes on any OS (see test/fake-system.ts). The only real implementation lives in
 * ./node.ts.
 */

export interface ExecOptions {
  /** Hard timeout; the child (tree) is killed when it elapses. */
  timeoutMs: number;
  /** Full child environment. Defaults to the parent's environment when omitted. */
  env?: Readonly<Record<string, string>>;
  cwd?: string;
}

export interface ExecResult {
  /** `null` when the process could not be started or was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn error code (e.g. `ENOENT`, `EACCES`) when the process did not start. */
  spawnError?: string;
}

export interface ServerProcess {
  readonly pid: number | undefined;
  /** Combined stdout/stderr seen so far (bounded). Never logged verbatim by the probe. */
  output(): string;
  /** Exit code once the process has exited, otherwise `undefined`. */
  exitCode(): number | null | undefined;
  /** Kills the whole process tree and resolves once it is gone (or the grace period is over). */
  stop(): Promise<void>;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface System {
  readonly platform: string;
  /** `os.arch()` — the architecture Node itself was built for. */
  readonly arch: string;
  /** `os.machine()` — the kernel's machine type (e.g. `aarch64` under a 32-bit userland). */
  machine(): string;
  /** `os.release()` — kernel release. */
  release(): string;
  /** `os.version()` — kernel version string. */
  kernelVersion(): string;
  hostname(): string;
  cpuCount(): number;
  totalMemoryBytes(): number;
  homedir(): string;
  tmpdir(): string;
  readonly nodeVersion: string;
  /**
   * Environment lookup. Used only for PATH-like lookups and well-known directories;
   * values are never printed or stored in the report.
   */
  getEnv(name: string): string | undefined;

  exec(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult>;
  /** Starts a long-running child in its own process group (POSIX) for a self-test. */
  spawnServer(
    file: string,
    args: readonly string[],
    options: { env: Readonly<Record<string, string>>; cwd: string },
  ): ServerProcess;

  isFile(path: string): Promise<boolean>;
  /** Reads at most `maxBytes` of a small text file; `null` if it does not exist or is unreadable. */
  readText(path: string, maxBytes: number): Promise<string | null>;
  realpath(path: string): Promise<string | null>;
  /** Free bytes available to an unprivileged user on the filesystem of `path`. */
  diskFreeBytes(path: string): Promise<number | null>;
  makeTempDir(prefix: string): Promise<string>;
  removeDir(path: string): Promise<void>;

  /** HTTP GET to a loopback URL only. Implementations must refuse any other host. */
  httpGetLoopback(
    url: string,
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<HttpResponse>;
  /** A currently free TCP port on 127.0.0.1. */
  freeLoopbackPort(): Promise<number>;
  /** A fresh random secret (base64url, ≥ 32 bytes of entropy). */
  randomSecret(): string;
  now(): Date;
  monotonicMs(): number;
  sleep(ms: number): Promise<void>;
}
