import { MAX_LOG_CHUNK } from '@remyral/protocol';
import { StreamRedactor, redactDeep, type Redactor } from '@remyral/observability';

export type JobStreamName = 'stdout' | 'stderr' | 'runtime';

/** Payload of a LOG_CHUNK (without envelope/lease fields), always redacted. */
export interface RedactedLogChunk {
  stream: JobStreamName;
  chunkSeq: number;
  data: string;
  redacted: true;
}

/**
 * Redaction for everything a job emits towards the master (ADR-0006 §4, T-SEC-1):
 * one `StreamRedactor` per output stream (secrets split across chunks are still
 * caught), cut into LOG_CHUNK-sized pieces, and `redactDeep` for structured events
 * and results. Uses the daemon's shared redactor, in which the job's injected values
 * are registered (`JobSecretLease`), so exact values and secret patterns are both
 * removed before anything reaches the outbox.
 */
export class JobOutputRedaction {
  readonly #streams = new Map<JobStreamName, { redactor: StreamRedactor; seq: number }>();

  constructor(readonly redactor: Redactor) {}

  #stream(name: JobStreamName) {
    let s = this.#streams.get(name);
    if (s === undefined) {
      s = { redactor: new StreamRedactor(this.redactor), seq: 0 };
      this.#streams.set(name, s);
    }
    return s;
  }

  /** Feed raw output; returns the chunks that are now safe to send (possibly none). */
  push(stream: JobStreamName, raw: string): RedactedLogChunk[] {
    const s = this.#stream(stream);
    return this.#chunks(stream, s, s.redactor.push(raw));
  }

  /** Flush a stream at EOF. */
  end(stream: JobStreamName): RedactedLogChunk[] {
    const s = this.#stream(stream);
    return this.#chunks(stream, s, s.redactor.end());
  }

  /** Redacted, JSON-safe copy of a structured event/result payload. */
  event(payload: unknown): unknown {
    return redactDeep(payload, this.redactor, { maxStringLength: MAX_LOG_CHUNK });
  }

  #chunks(stream: JobStreamName, s: { seq: number }, text: string): RedactedLogChunk[] {
    const out: RedactedLogChunk[] = [];
    // MAX_LOG_CHUNK is in characters here; keep a margin for multi-byte text.
    const size = Math.floor(MAX_LOG_CHUNK / 4);
    for (let i = 0; i < text.length; i += size) {
      out.push({ stream, chunkSeq: s.seq++, data: text.slice(i, i + size), redacted: true });
    }
    return out;
  }
}
