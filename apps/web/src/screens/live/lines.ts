import type { LogItem, LogStream } from '../../api/live';
import { type AnsiState, PLAIN, parseAnsi, type Segment, splitSegments } from '../../lib/ansi';

/** One display line of log output (segments are text + class; never markup). */
export interface Line {
  readonly id: number;
  readonly stream: LogStream;
  readonly attemptNo: number;
  /** Server timestamp (ISO) of the chunk that started this line. */
  readonly ts: string;
  segments: Segment[];
}

export function lineText(l: Line): string {
  return l.segments.map((s) => s.text).join('');
}

/**
 * Incremental line builder: chunks are fed in canonical order; a chunk that does not end with a newline
 * leaves its stream's line open, and the next chunk of the same stream (and attempt) continues it, even if
 * other streams were interleaved in between. ANSI state carries over per stream.
 */
export class LineBuilder {
  readonly lines: Line[] = [];
  readonly #open = new Map<string, Line>();
  readonly #state = new Map<string, AnsiState>();
  #nextId = 0;
  /** Chunks consumed so far and the last one (to detect "only appended" updates). */
  consumed = 0;
  last: LogItem | null = null;

  add(chunk: LogItem): void {
    const key = `${String(chunk.attemptNo)}:${chunk.stream}`;
    const parsed = parseAnsi(chunk.text, this.#state.get(key) ?? PLAIN);
    this.#state.set(key, parsed.state);
    const parts = splitSegments(parsed.segments);
    const endsOpen = !chunk.text.endsWith('\n') && !chunk.text.endsWith('\r');
    parts.forEach((segments, i) => {
      const isLast = i === parts.length - 1;
      // The last part of a newline-terminated chunk is the empty remainder: no line.
      if (isLast && !endsOpen) {
        this.#open.delete(key);
        return;
      }
      const open = i === 0 ? this.#open.get(key) : undefined;
      if (open !== undefined) {
        open.segments = [...open.segments, ...segments];
        if (!isLast) this.#open.delete(key);
        else this.#open.set(key, open);
        return;
      }
      const line: Line = {
        id: this.#nextId++,
        stream: chunk.stream,
        attemptNo: chunk.attemptNo,
        ts: chunk.ts,
        segments,
      };
      this.lines.push(line);
      if (isLast) this.#open.set(key, line);
    });
    this.consumed += 1;
    this.last = chunk;
  }
}

/** Builds lines for `chunks`, reusing `prev` when the new list only appended to the one it consumed. */
export function buildLines(chunks: readonly LogItem[], prev: LineBuilder | null): LineBuilder {
  const reuse =
    prev !== null &&
    prev.consumed <= chunks.length &&
    (prev.consumed === 0 || chunks[prev.consumed - 1] === prev.last);
  const b = reuse ? prev : new LineBuilder();
  for (let i = b.consumed; i < chunks.length; i++) {
    const c = chunks[i];
    if (c !== undefined) b.add(c);
  }
  return b;
}
