import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configure } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLines } from '../src/screens/live/lines';
import { mergeSorted, logKey } from '../src/screens/live/useLive';
import type { LogItem } from '../src/api/live';

configure({ asyncUtilTimeout: 5_000 });

function log(seq: number, text: string, over: Partial<LogItem> = {}): LogItem {
  return {
    type: 'log',
    seq,
    attemptId: 'a1',
    attemptNo: 1,
    workerSeq: seq,
    stream: 'stdout',
    chunkSeq: seq,
    ts: new Date().toISOString(),
    text,
    ...over,
  };
}

/** A log row as "<stream badge> <text>" (the gutter's line number and timestamp left out). */
/** Minimal EventSource stand-in: tests push frames with `emit`. */
class FakeEventSource {
  static readonly CLOSED = 2;
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, ((m: MessageEvent<string>) => void)[]>();
  readyState = 1;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (m: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

beforeEach(() => {
  FakeEventSource.last = null;
});
afterEach(() => {
  delete (window as unknown as { __pwned?: unknown }).__pwned;
});

describe('live helpers', () => {
  it('mergeSorted dedupes by stream sequence and keeps canonical order', () => {
    const a = [log(1, 'a'), log(3, 'c', { workerSeq: 3 })];
    const m = mergeSorted(a, [log(2, 'b', { workerSeq: 2 }), log(3, 'c')], logKey, 10);
    expect(m.items.map((x) => x.text)).toEqual(['a', 'b', 'c']);
    const capped = mergeSorted(m.items, [log(4, 'd', { workerSeq: 4 })], logKey, 3);
    expect(capped).toMatchObject({ dropped: true });
    expect(capped.items.map((x) => x.text)).toEqual(['b', 'c', 'd']);
  });

  it('line builder continues an open line per stream and reuses work on append', () => {
    const chunks = [log(1, 'a'), log(2, 'x\n', { stream: 'stderr' }), log(3, 'b\nc')];
    const b1 = buildLines(chunks.slice(0, 2), null);
    const b2 = buildLines(chunks, b1);
    expect(b2).toBe(b1);
    expect(b2.lines.map((l) => l.segments.map((s) => s.text).join(''))).toEqual(['ab', 'x', 'c']);
    // Not an append (out-of-order insert): rebuilt.
    expect(buildLines([log(0, 'z\n'), ...chunks], b2)).not.toBe(b2);
  });

  it('the live panel sources never inject markup', () => {
    const root = existsSync(join(process.cwd(), 'apps/web/src'))
      ? join(process.cwd(), 'apps/web/src')
      : join(process.cwd(), 'src');
    const files = [
      ...readdirSync(join(root, 'screens/live')).map((f) => join(root, 'screens/live', f)),
      join(root, 'lib/ansi.ts'),
      join(root, 'api/live.ts'),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect([f, /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/.test(src)]).toEqual([
        f,
        false,
      ]);
    }
  });
});
