// p5-live-fixes-2 (live verification on the Windows worker, 2026-10-14): approvals card click, job page live
// stream reconnect, nav badges invalidation, relative-time clock, composer defaults for repository projects.
import { act, configure, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidate, invalidating, onInvalidate } from '../src/lib/invalidate';
import { sameRepository } from '../src/screens/composer/draft';
import { reconnectDelay, useLive } from '../src/screens/live/useLive';
import { fakeFetch, type Handler } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('nav badges refresh on invalidation (item 8)', () => {
  it('invalidating() announces only after success; onInvalidate filters topics', async () => {
    const approvals = vi.fn();
    const off = onInvalidate(['approvals'], approvals);
    invalidate('workers');
    expect(approvals).not.toHaveBeenCalled();
    await invalidating('approvals', Promise.resolve(1));
    expect(approvals).toHaveBeenCalledTimes(1);
    await expect(invalidating('approvals', Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(approvals).toHaveBeenCalledTimes(1);
    off();
    invalidate('approvals');
    expect(approvals).toHaveBeenCalledTimes(1);
  });
});

/** Minimal EventSource stand-in (see live.test.tsx), recording every instance. */
class FakeEventSource {
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((m: MessageEvent<string>) => void)[]>();
  readyState = 1;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (m: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  fail(): void {
    this.readyState = 2;
    this.onerror?.();
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

describe('job page live stream reconnects (item 5)', { timeout: 20_000 }, () => {
  beforeEach(() => {
    FakeEventSource.all = [];
  });

  it('reconnectDelay backs off exponentially up to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  // p15-classic-removal: the classic job page's stream test, on the shared `useLive` the Diyalog job page uses.
  it('a stream the browser gave up on is reopened after the last sequence; bye reopens; a visible tab resyncs', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const JOB = '22222222-2222-4222-8222-222222222222';
    const log = (seq: number, text: string) => ({
      type: 'log',
      seq,
      attemptId: 'a1',
      attemptNo: 1,
      workerSeq: seq,
      stream: 'stdout',
      chunkSeq: seq,
      ts: new Date().toISOString(),
      text,
    });
    const routes: Record<string, Handler> = {
      [`GET /api/jobs/${JOB}/logs?limit=500&tail=1`]: () => ({
        status: 200,
        body: { items: [log(1, 'one\n')], nextCursor: null, head: 1 },
      }),
      [`GET /api/jobs/${JOB}/events?limit=500&tail=1`]: () => ({
        status: 200,
        body: { items: [], nextCursor: null, head: 1 },
      }),
      [`GET /api/jobs/${JOB}/logs?limit=200&tail=1`]: () => ({
        status: 200,
        body: { items: [], nextCursor: null, head: 3 },
      }),
      [`GET /api/jobs/${JOB}/events?limit=200&tail=1`]: () => ({
        status: 200,
        body: { items: [], nextCursor: null, head: 3 },
      }),
      [`GET /api/jobs/${JOB}/live`]: () => ({
        status: 200,
        body: {
          head: 1,
          logChunks: 1,
          logBytes: 0,
          events: 0,
          logLimited: false,
          artifacts: [],
          terminal: { supported: false, status: null },
          stream: { maxAgeMs: 600000, maxPerUser: 6 },
        },
      }),
    };
    vi.stubGlobal('fetch', fakeFetch(routes).fetch);
    const { result } = renderHook(() => useLive(JOB, 'RUNNING'));
    await waitFor(() => {
      expect(FakeEventSource.all).toHaveLength(1);
    });
    const last = (): FakeEventSource => FakeEventSource.all.at(-1) as FakeEventSource;
    const first = last();
    expect(first.url).toBe(`/api/jobs/${JOB}/stream?after=1`);
    act(() => {
      first.emit('ready', { head: 1 });
      first.emit('log', log(3, 'three\n'));
    });
    await waitFor(() => {
      expect(result.current.status).toBe('live');
    });
    // The proxy dropped the stream and the browser gave up (CLOSED): reopened after seq 3 with backoff.
    act(() => {
      first.fail();
    });
    await waitFor(
      () => {
        expect(FakeEventSource.all).toHaveLength(2);
      },
      { timeout: 3_000 },
    );
    const second = last();
    expect(first.closed).toBe(true);
    expect(second.url).toBe(`/api/jobs/${JOB}/stream?after=3`);
    const resyncs = result.current.resyncs;
    act(() => {
      second.emit('ready', { head: 3 });
    });
    // After a reconnect the caller is told to re-read the job.
    await waitFor(() => {
      expect(result.current.resyncs).toBeGreaterThan(resyncs);
    });
    // The server's max-age `bye`: reopened at once.
    act(() => {
      second.emit('bye', { reason: 'max_age' });
    });
    expect(FakeEventSource.all).toHaveLength(3);
    expect(second.closed).toBe(true);
    expect(last().url).toBe(`/api/jobs/${JOB}/stream?after=3`);
    // Tab visible again with a dead stream: resync and reopen at once.
    act(() => {
      last().readyState = 2;
    });
    const resyncs2 = result.current.resyncs;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => {
      expect(result.current.resyncs).toBeGreaterThan(resyncs2);
    });
    expect(FakeEventSource.all).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Composer defaults for repository projects (item 9).

describe('composer defaults for repository projects (item 9)', { timeout: 20_000 }, () => {
  it('sameRepository ignores case of scheme/host, a trailing slash and .git', () => {
    expect(sameRepository('https://GitHub.com/acme/app', 'https://github.com/acme/app.git')).toBe(true);
    expect(sameRepository('https://github.com/acme/app.git/', 'https://github.com/acme/app')).toBe(true);
    expect(sameRepository('https://github.com/acme/other.git', 'https://github.com/acme/app.git')).toBe(
      false,
    );
    expect(sameRepository('', 'https://github.com/acme/app.git')).toBe(false);
  });
});
