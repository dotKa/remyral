import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Redactor } from '@remyral/observability';
import { CONFIG_ENV, configLocations, pathApi, type PathHost } from '../config/paths.js';
import { WORKER_VERSION } from '../version.js';

/**
 * p6-worker-boot-diagnostics: the worker's boot log, `<dataDir>/logs/boot.log`.
 *
 * Incident 2026-10-16: worker 1.0.22 was rolled back on a Windows service with `health_check_failed` and left no
 * line at all in `worker.log` — that file only exists once the config is loaded and the logger is up, so a
 * failure (or hang) before that point was invisible without a shell on the machine. The boot guard closes that
 * gap. It is the first module the entry (`bin.ts`) evaluates and imports nothing of the worker but the
 * dependency-free path helpers, the version constant and the redactor, so it is armed before any other module of
 * the bundle runs. It appends one JSON line per event:
 *
 * - `start`  — process started (version, platform, arch, Node, pid, argv command);
 * - `ready`  — config loaded and the logger is up (from here on `worker.log` has everything);
 * - `fatal`  — an uncaught exception / unhandled rejection (via `uncaughtExceptionMonitor`, which observes
 *              without changing Node's own crash behaviour) or an error the entry caught, with the stage
 *              (`module-load` before the entry ran, `startup` before `ready`, `running` after);
 * - `exit`   — a non-zero exit (except the remote-restart code 75), with the stderr written before `ready`
 *              (bounded) — e.g. a configuration error that never reaches `worker.log`;
 * - `forced_exit` — handles still kept the process alive after the daemon had stopped (see `bin.ts`).
 *
 * Where: the data dir of the config the process will load (peeked: `--config`, `REMYRAL_WORKER_CONFIG`, else the
 * OS default config location; only its `dataDir` field is read), else that location's default data dir —
 * `%ProgramData%\RemyralWorker\data` on Windows, `/var/lib/remyral-worker`, `/Library/Application
 * Support/RemyralWorker/data`. Once the config is loaded the daemon confirms the real data dir
 * ({@link BootGuard.ready}).
 *
 * Bounds and safety: 0600 file in a 0700 directory (like `worker.log`), rotated at {@link BOOT_LOG_MAX_BYTES}
 * into `boot.log.1` (one generation), each record's text is cut and redacted with the default token patterns.
 * Writing never throws: a boot log that cannot be written must not stop the worker.
 */

export const BOOT_LOG = 'boot.log';
export const BOOT_LOG_MAX_BYTES = 256 * 1024;
/** Stack / message / stderr bounds per record. */
const MAX_TEXT = 4096;
const MAX_STDERR = 4096;
/** Exit code of a remote restart (remote-ops/service-control.ts) — a planned exit, not a failure. */
const EXIT_RESTART = 75;

export type BootEvent = 'start' | 'ready' | 'fatal' | 'exit' | 'forced_exit';
export type BootStage = 'module-load' | 'startup' | 'running';

export interface BootRecord {
  readonly ts: string;
  readonly event: BootEvent;
  readonly version: string;
  readonly pid: number;
  readonly platform: string;
  readonly arch: string;
  readonly node: string;
  readonly stage: BootStage;
  readonly command?: string;
  readonly origin?: string;
  readonly code?: number;
  readonly error?: { readonly name: string; readonly message: string; readonly stack?: string };
  readonly stderr?: string;
  readonly detail?: string;
}

/** Where the boot log goes before the config is loaded (pure; every OS is testable everywhere). */
export function bootLogDir(
  host: PathHost,
  argv: readonly string[],
  readText: (path: string) => string | null,
): string {
  const p = pathApi(host.platform);
  const locations = configLocations(host);
  const explicit = configArg(argv) ?? host.env(CONFIG_ENV);
  const candidates =
    explicit !== undefined && explicit !== ''
      ? [{ configPath: p.resolve(explicit), defaultDataDir: locations[0]?.defaultDataDir ?? '' }]
      : locations;
  for (const loc of candidates) {
    const raw = readText(loc.configPath);
    if (raw === null && explicit === undefined) continue;
    const dataDir = peekDataDir(raw, host.platform) ?? loc.defaultDataDir;
    if (dataDir !== '') return p.join(dataDir, 'logs');
  }
  const fallback = locations[0]?.defaultDataDir ?? '';
  return fallback === '' ? '' : p.join(fallback, 'logs');
}

function configArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--config') return argv[i + 1];
    if (a.startsWith('--config=')) return a.slice('--config='.length);
  }
  return undefined;
}

function peekDataDir(raw: string | null, platform: NodeJS.Platform): string | null {
  if (raw === null) return null;
  try {
    const doc = JSON.parse(raw) as unknown;
    if (typeof doc !== 'object' || doc === null) return null;
    const v = (doc as { dataDir?: unknown }).dataDir;
    return typeof v === 'string' && v.length < 1024 && pathApi(platform).isAbsolute(v) ? v : null;
  } catch {
    return null;
  }
}

/** Synchronous, bounded, never-throwing appender for boot records. */
export class BootLog {
  #dir: string;
  readonly #maxBytes: number;

  constructor(dir: string, maxBytes = BOOT_LOG_MAX_BYTES) {
    this.#dir = dir;
    this.#maxBytes = maxBytes;
  }

  get dir(): string {
    return this.#dir;
  }

  get path(): string {
    return join(this.#dir, BOOT_LOG);
  }

  /** Moves the log to another directory (the data dir the loaded config names). */
  moveTo(dir: string): void {
    this.#dir = dir;
  }

  append(record: BootRecord): boolean {
    if (this.#dir === '') return false;
    const line = `${JSON.stringify(record)}\n`;
    let fd: number | null = null;
    try {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = statSync(this.path).size;
      } catch {
        size = 0;
      }
      if (size > 0 && size + Buffer.byteLength(line) > this.#maxBytes) {
        renameSync(this.path, `${this.path}.1`);
      }
      fd = openSync(this.path, 'a', 0o600);
      writeSync(fd, line);
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }
}

const redactor = new Redactor();

function cut(text: string, max: number): string {
  const r = redactor.redact(text);
  return r.length > max ? `${r.slice(0, max)}…` : r;
}

/** Error → bounded, redacted record fields. */
export function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: cut(error.name, 128),
      message: cut(error.message, MAX_TEXT),
      ...(typeof error.stack === 'string' ? { stack: cut(error.stack, MAX_TEXT) } : {}),
    };
  }
  return { name: 'NonError', message: cut(String(error), MAX_TEXT) };
}

export interface BootGuardOptions {
  readonly log: BootLog;
  readonly version?: string;
  readonly argv?: readonly string[];
  readonly now?: () => Date;
  readonly platform?: string;
}

/**
 * The armed guard. {@link installBootGuard} wires it to the process; tests drive it directly.
 */
export class BootGuard {
  readonly log: BootLog;
  readonly #version: string;
  readonly #command: string | undefined;
  readonly #now: () => Date;
  readonly #platform: string;
  #stage: BootStage = 'module-load';
  #stderr = '';
  #fatalRecorded = false;

  constructor(options: BootGuardOptions) {
    this.log = options.log;
    this.#version = options.version ?? WORKER_VERSION;
    this.#command = options.argv?.find((a) => !a.startsWith('-'));
    this.#now = options.now ?? (() => new Date());
    this.#platform = options.platform ?? process.platform;
  }

  get stage(): BootStage {
    return this.#stage;
  }

  #record(event: BootEvent, extra: Partial<BootRecord> = {}): BootRecord {
    return {
      ts: this.#now().toISOString(),
      event,
      version: this.#version,
      pid: process.pid,
      platform: this.#platform,
      arch: process.arch,
      node: process.versions.node,
      stage: this.#stage,
      ...(this.#command === undefined ? {} : { command: cut(this.#command, 32) }),
      ...extra,
    };
  }

  start(): void {
    this.log.append(this.#record('start'));
  }

  /** The entry module is running (everything it imports has been evaluated). */
  entered(): void {
    if (this.#stage === 'module-load') this.#stage = 'startup';
  }

  /** Config loaded and logger up: `dataDir` is the real data dir; stop buffering stderr. */
  ready(dataDir: string | null): void {
    if (dataDir !== null && dataDir !== '') {
      const dir = pathApi(this.#platform as NodeJS.Platform).join(dataDir, 'logs');
      if (dir !== this.log.dir) this.log.moveTo(dir);
    }
    this.#stage = 'running';
    this.#stderr = '';
    this.log.append(this.#record('ready'));
  }

  /** Keeps the last stderr text written before `ready` (configuration errors print only there). */
  observeStderr(text: string): void {
    if (this.#stage === 'running') return;
    this.#stderr = (this.#stderr + text).slice(-MAX_STDERR);
  }

  fatal(error: unknown, origin: string): void {
    this.#fatalRecorded = true;
    this.log.append(this.#record('fatal', { origin: cut(origin, 64), error: describeError(error) }));
  }

  exit(code: number): void {
    if (code === 0 || code === EXIT_RESTART) return;
    const stderr = this.#stderr.trim();
    this.log.append(
      this.#record('exit', {
        code,
        ...(stderr === '' ? {} : { stderr: cut(stderr, MAX_STDERR) }),
        ...(this.#fatalRecorded ? { detail: 'after a fatal error (see the previous record)' } : {}),
      }),
    );
  }

  forcedExit(detail: string): void {
    this.log.append(this.#record('forced_exit', { detail: cut(detail, 500) }));
  }
}

function nodeReadText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    if (statSync(path).size > 1024 * 1024) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

let installed: BootGuard | null = null;

/** The guard of this process, if the entry installed one. */
export function currentBootGuard(): BootGuard | null {
  return installed;
}

/**
 * Arms the guard for this process: records `start`, observes uncaught errors and non-zero exits, and keeps the
 * stderr written before `ready`. Idempotent. Never throws.
 */
export function installBootGuard(argv: readonly string[] = process.argv.slice(2)): BootGuard | null {
  if (installed !== null) return installed;
  // Only the daemon (`run`, what every service definition starts): an interactive command (`probe`, `pair`, …)
  // prints its own failure to the terminal and must not create files in the operator's home.
  if (argv.find((a) => !a.startsWith('-')) !== 'run') return null;
  try {
    const host: PathHost = {
      platform: process.platform,
      env: (name) => process.env[name],
      homedir: () => {
        try {
          return homedir();
        } catch {
          return '';
        }
      },
      isPrivileged:
        process.platform === 'win32' || (typeof process.geteuid === 'function' && process.geteuid() === 0),
    };
    const guard = new BootGuard({ log: new BootLog(bootLogDir(host, argv, nodeReadText)), argv });
    installed = guard;
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      guard.fatal(error, origin);
    });
    process.on('exit', (code) => {
      guard.exit(code);
    });
    const write = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
    process.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
      try {
        guard.observeStderr(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
      } catch {
        // never interfere with stderr
      }
      return write(chunk, ...rest);
    };
    guard.start();
    return guard;
  } catch {
    return null;
  }
}
