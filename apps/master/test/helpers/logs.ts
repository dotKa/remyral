import { Writable } from 'node:stream';

/** Collects everything the app logs (raw pino JSON lines) for assertions. */
export class LogCapture extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    cb();
  }

  get text(): string {
    return this.chunks.join('');
  }

  get entries(): Record<string, unknown>[] {
    return this.text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}
