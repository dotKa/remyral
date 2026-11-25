import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogSink, Redactor } from '@remyral/observability';
import { MAX_LOG_LINE } from '@remyral/protocol';

/**
 * The worker's own log file for remote viewing (p5-remote-ops §4): every JSON line the logger emits (already
 * redacted by the logger) is also appended to `<dataDir>/logs/worker.log` (0600, dir 0700), rotated at
 * `maxBytes` into `worker.log.1` (one generation kept), so the panel can read the last lines even after a
 * restart and on every OS — independent of journald / launchd / shawl log locations.
 *
 * Tailing re-redacts every line (exact registered secrets + patterns) before it leaves the process and bounds
 * the result by line count and bytes; the master redacts again.
 */

export const LOG_FILE = 'worker.log';
export const DEFAULT_LOG_FILE_BYTES = 4 * 1024 * 1024;

export interface FileLogOptions {
  /** Directory of the file (default `<dataDir>/logs`). */
  readonly dir?: string;
  /** File name (default `worker.log`). */
  readonly name?: string;
  /** File mode on creation (default 0600). The updater's log is 0644: the service account reads it. */
  readonly mode?: number;
}

export class FileLog {
  readonly dir: string;
  readonly #name: string;
  readonly #mode: number;
  readonly #maxBytes: number;
  #fd: number | null = null;
  #size = 0;
  #failed = false;

  constructor(dataDir: string, maxBytes = DEFAULT_LOG_FILE_BYTES, options: FileLogOptions = {}) {
    this.dir = options.dir ?? join(dataDir, 'logs');
    this.#name = options.name ?? LOG_FILE;
    this.#mode = options.mode ?? 0o600;
    this.#maxBytes = maxBytes;
  }

  get path(): string {
    return join(this.dir, this.#name);
  }

  #openFile(): number | null {
    if (this.#fd !== null || this.#failed) return this.#fd;
    try {
      mkdirSync(this.dir, { recursive: true, mode: this.#mode === 0o600 ? 0o700 : 0o755 });
      this.#fd = openSync(this.path, 'a', this.#mode);
      this.#size = statSync(this.path).size;
    } catch {
      // A log file that cannot be opened must never stop the worker; stderr still has everything.
      this.#failed = true;
      this.#fd = null;
    }
    return this.#fd;
  }

  /** Appends one line (synchronously: the logger's sink contract). */
  append(line: string): void {
    const fd = this.#openFile();
    if (fd === null) return;
    const data = `${line}\n`;
    try {
      if (this.#size + Buffer.byteLength(data) > this.#maxBytes) this.#rotate();
      const target = this.#fd ?? fd;
      writeSync(target, data);
      this.#size += Buffer.byteLength(data);
    } catch {
      this.#failed = true;
    }
  }

  #rotate(): void {
    if (this.#fd !== null) closeSync(this.#fd);
    this.#fd = null;
    renameSync(this.path, `${this.path}.1`);
    this.#fd = openSync(this.path, 'a', this.#mode);
    this.#size = 0;
  }

  close(): void {
    if (this.#fd !== null) closeSync(this.#fd);
    this.#fd = null;
  }

  /** Bytes currently kept (both generations). */
  bytes(): number {
    let n = 0;
    for (const p of [this.path, `${this.path}.1`]) {
      try {
        n += statSync(p).size;
      } catch {
        // missing
      }
    }
    return n;
  }

  available(): boolean {
    return existsSync(this.path);
  }

  /** A logger sink that writes to the file and to `next` (stderr by default). */
  tee(next: LogSink): LogSink {
    return (line) => {
      next(line);
      this.append(line);
    };
  }
}

async function readTail(path: string, maxBytes: number): Promise<{ text: string; cut: boolean }> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return { text: '', cut: false };
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    return { text, cut: start > 0 };
  } finally {
    await handle.close();
  }
}

/**
 * The last `lines` lines within `maxBytes` (older generation first), each re-redacted and cut to the
 * protocol's line limit.
 */
export async function tailLog(
  log: Pick<FileLog, 'path'>,
  redactor: Pick<Redactor, 'redact'>,
  opts: { lines: number; maxBytes: number },
): Promise<{ lines: string[]; truncated: boolean }> {
  const current = await readTail(log.path, opts.maxBytes);
  let text = current.text;
  let truncated = current.cut;
  if (!current.cut && Buffer.byteLength(text) < opts.maxBytes) {
    const older = await readTail(`${log.path}.1`, opts.maxBytes - Buffer.byteLength(text));
    text = older.text + text;
    truncated = older.cut;
  }
  let all = text.split('\n').filter((l) => l.length > 0);
  if (all.length > opts.lines) {
    all = all.slice(all.length - opts.lines);
    truncated = true;
  }
  const out: string[] = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const raw = all[i] ?? '';
    let line = redactor.redact(raw);
    if (line.length > MAX_LOG_LINE) line = `${line.slice(0, MAX_LOG_LINE - 1)}…`;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > opts.maxBytes) {
      truncated = true;
      break;
    }
    out.push(line);
  }
  return { lines: out.reverse(), truncated };
}
