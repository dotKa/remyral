import { DEFAULT_RULES, marker, Redactor, redactDeep } from '@remyral/observability';

/**
 * Master-side second redaction stage (ADR-0006 §4, docs/design/p5-live.md §4). The master never knows
 * the exact secret values (they stay on the worker), so this is the **pattern** pass only. It runs before
 * anything from a worker is stored for the live view, and again on every read (defence in depth).
 */

export interface ChunkRedaction {
  /** The redacted new chunk. */
  readonly text: string;
  /**
   * The previous chunk's full text with the part of a secret that started in it replaced, or null when
   * the previous chunk does not change.
   */
  readonly previous: string | null;
}

export class LiveRedactor {
  readonly #redactor: Redactor;

  constructor(redactor: Redactor = new Redactor({ rules: DEFAULT_RULES })) {
    this.#redactor = redactor;
  }

  /** Characters of the previous chunk that are scanned together with a new one. */
  get carry(): number {
    return this.#redactor.lookbehind();
  }

  text(text: string): string {
    return this.#redactor.redact(text);
  }

  /**
   * Redacts `text` (a new chunk) with the tail of `previous` (the stored previous chunk of the same
   * attempt and stream, already redacted) in front of it, so a secret split across the two chunks is
   * still recognised. A match that starts in the previous chunk replaces that part there with the marker
   * and removes the rest from the new chunk; a match that starts in the new chunk is replaced there.
   */
  chunk(text: string, previous: string | null): ChunkRedaction {
    if (previous === null || previous.length === 0) return { text: this.text(text), previous: null };
    const keep = Math.min(previous.length, this.carry);
    const head = previous.slice(0, previous.length - keep);
    const tail = previous.slice(previous.length - keep);
    const joined = tail + text;
    const spans = this.#redactor.spans(joined);
    if (spans.length === 0) return { text, previous: null };
    let tailOut = '';
    let tailPos = 0;
    let newOut = '';
    let newPos = 0;
    let tailChanged = false;
    for (const s of spans) {
      if (s.start < keep) {
        // Starts in the previous chunk: marker there, the remainder in the new chunk is dropped.
        const end = Math.min(s.end, keep);
        if (s.end <= keep && tail.slice(s.start, end) === marker(s.label)) continue;
        tailOut += tail.slice(tailPos, s.start) + marker(s.label);
        tailPos = end;
        tailChanged = true;
        if (s.end > keep) {
          newPos = Math.max(newPos, s.end - keep);
        }
      } else {
        const start = s.start - keep;
        newOut += text.slice(newPos, start) + marker(s.label);
        newPos = s.end - keep;
      }
    }
    newOut += text.slice(newPos);
    tailOut += tail.slice(tailPos);
    return { text: newOut, previous: tailChanged ? head + tailOut : null };
  }

  /** Every string of an event payload (keys included); sensitive keys are replaced whatever they hold. */
  deep<T>(value: T, maxStringLength = 64 * 1024): T {
    return redactDeep(value, this.#redactor, { maxStringLength, maxEntries: 200 }) as T;
  }
}
