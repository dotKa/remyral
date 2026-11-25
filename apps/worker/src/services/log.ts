import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SERVICE_LIMITS, type ServiceLogLine } from '@remyral/protocol';

/**
 * p15-services: the bounded log of one service on the worker — `<dir>/service.log` (JSON lines) and one rotated
 * `service.log.1`, each at most {@link SERVICE_LIMITS.logFileBytes} (so ≤ 2 MiB per service). The directory lies in the
 * worker's data dir, which every job sandbox denies. Every line is redacted before it is written: the values of the
 * service's own secrets (and `extraSecrets`, e.g. a git token) never reach the file.
 */
export class ServiceLog {
  readonly #file: string;
  readonly #max: number;
  #secrets: readonly string[] = [];
  #queue: Promise<void> = Promise.resolve();
  #pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  readonly #now: () => Date;

  constructor(dir: string, opts: { maxBytes?: number; now?: () => Date } = {}) {
    this.#file = join(dir, 'service.log');
    this.#max = opts.maxBytes ?? SERVICE_LIMITS.logFileBytes;
    this.#now = opts.now ?? (() => new Date());
  }

  /** Values never written (the service's resolved secrets). */
  setSecrets(values: readonly string[]): void {
    this.#secrets = values.filter((v) => v.length >= 4);
  }

  #redact(text: string): string {
    let out = text;
    for (const v of this.#secrets) out = out.split(v).join('[REDACTED]');
    return out;
  }

  /** A chunk of the process's output (split into lines; a partial last line waits for the next chunk). */
  chunk(stream: 'stdout' | 'stderr', data: Buffer | string): void {
    const text = this.#pending[stream] + (typeof data === 'string' ? data : data.toString('utf8'));
    const lines = text.split(/\r?\n/);
    this.#pending[stream] = (lines.pop() ?? '').slice(-SERVICE_LIMITS.logLineChars * 4);
    for (const l of lines) this.line(stream, l);
  }

  /** Flushes partial lines (process exit). */
  flush(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (this.#pending[stream] !== '') this.line(stream, this.#pending[stream]);
      this.#pending[stream] = '';
    }
  }

  line(stream: ServiceLogLine['stream'], text: string): void {
    // eslint-disable-next-line no-control-regex
    const clean = this.#redact(text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')).slice(
      0,
      SERVICE_LIMITS.logLineChars,
    );
    if (clean.trim() === '' && stream !== 'system') return;
    const entry: ServiceLogLine = { at: this.#now().toISOString(), stream, text: clean };
    const json = `${JSON.stringify(entry)}\n`;
    this.#queue = this.#queue
      .then(async () => {
        await mkdir(join(this.#file, '..'), { recursive: true, mode: 0o700 });
        const size = (await stat(this.#file).catch(() => null))?.size ?? 0;
        if (size + json.length > this.#max)
          await rename(this.#file, `${this.#file}.1`).catch(() => undefined);
        await appendFile(this.#file, json, { mode: 0o600 });
      })
      .catch(() => undefined);
  }

  /** Resolves once everything queued is on disk (tests, tail). */
  async settled(): Promise<void> {
    await this.#queue;
  }

  /** The last `n` lines (oldest first) and whether older ones exist. */
  async tail(n: number): Promise<{ lines: ServiceLogLine[]; truncated: boolean }> {
    await this.settled();
    const read = async (f: string): Promise<ServiceLogLine[]> => {
      const text = await readFile(f, 'utf8').catch(() => '');
      const out: ServiceLogLine[] = [];
      for (const l of text.split('\n')) {
        if (l === '') continue;
        try {
          out.push(JSON.parse(l) as ServiceLogLine);
        } catch {
          // a torn line after a crash
        }
      }
      return out;
    };
    const all = [...(await read(`${this.#file}.1`)), ...(await read(this.#file))];
    const lines = all.slice(-Math.max(1, Math.min(n, SERVICE_LIMITS.logLinesMax)));
    return { lines, truncated: all.length > lines.length };
  }

  async remove(): Promise<void> {
    await this.settled();
    await rm(this.#file, { force: true }).catch(() => undefined);
    await rm(`${this.#file}.1`, { force: true }).catch(() => undefined);
  }
}
