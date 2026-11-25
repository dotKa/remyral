import { marker, type Redactor } from './redactor.js';
import type { Continuation } from './rules.js';

export interface StreamRedactorOptions {
  /**
   * Upper bound on characters held back for one unfinished secret (e.g. a PEM block
   * whose END line has not arrived yet). Beyond it the secret is force-closed: a
   * marker is emitted and the rest of the secret is swallowed. Default 64 KiB.
   */
  maxHold?: number;
}

/**
 * Redacts a text stream chunk by chunk (stdout/stderr of a runtime, LOG_CHUNK data).
 *
 * Guarantee: a secret registered in the redactor, or a token matched by a rule, is
 * redacted even when it is split across any number of chunk boundaries. To achieve
 * that the redactor holds back a bounded tail of the stream:
 *  - the last `redactor.lookbehind()` characters (≥ the longest registered secret
 *    and ≥ the longest bounded pattern), because a secret may start there;
 *  - from the start of a match that touches the end of the data seen so far, because
 *    the token may continue (bounded by `maxHold`).
 *
 * Output is therefore delayed by up to the lookbehind; call `end()` to flush.
 * Not thread-safe; one instance per stream.
 */
export class StreamRedactor {
  #held = '';
  #swallow: Continuation | null = null;
  #ended = false;
  readonly #maxHold: number;

  constructor(
    private readonly redactor: Redactor,
    options: StreamRedactorOptions = {},
  ) {
    this.#maxHold = options.maxHold ?? 64 * 1024;
    if (this.#maxHold < redactor.lookbehind()) {
      throw new RangeError('maxHold must be at least the redactor lookbehind');
    }
  }

  /** Feed a chunk; returns the text that is now safe to emit (possibly empty). */
  push(chunk: string): string {
    if (this.#ended) throw new Error('stream redactor already ended');
    return this.#process(chunk, false);
  }

  /** Flush everything still held back. The redactor cannot be used afterwards. */
  end(): string {
    if (this.#ended) return '';
    const out = this.#process('', true);
    this.#ended = true;
    return out;
  }

  /** Characters currently held back (for backpressure accounting). */
  get pendingLength(): number {
    return this.#held.length;
  }

  #process(chunk: string, final: boolean): string {
    let input = chunk;
    if (this.#swallow !== null) {
      const { consumed, done } = this.#swallow(input);
      input = input.slice(consumed);
      if (!done) {
        if (final) this.#swallow = null;
        return '';
      }
      this.#swallow = null;
    }

    const buf = this.#held + input;
    if (buf.length === 0) return '';
    const spans = this.redactor.spans(buf);
    const safeEnd = final ? buf.length : Math.max(0, buf.length - this.redactor.lookbehind());

    let out = '';
    let pos = 0;
    let open: (typeof spans)[number] | null = null;
    for (const span of spans) {
      if (span.start >= safeEnd) break;
      if (!final && span.openEnded) {
        open = span;
        break;
      }
      out += buf.slice(pos, span.start) + marker(span.label);
      pos = span.end;
    }

    const cut = open !== null ? open.start : Math.max(pos, safeEnd);
    if (cut > pos) out += buf.slice(pos, cut);
    this.#held = buf.slice(Math.max(cut, pos));

    if (open !== null && this.#held.length > this.#maxHold) {
      // Force-close: the held tail is entirely the open secret (it runs to the end).
      out += marker(open.label);
      this.#held = '';
      this.#swallow = open.continuation;
    }
    if (final) this.#held = '';
    return out;
  }
}
