import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError } from '../../api/client';
import {
  type EventItem,
  getEvents,
  getLiveSummary,
  getLogs,
  type LiveSummary,
  type LogItem,
  parseEvent,
  parseLog,
  streamUrl,
} from '../../api/live';
import { toApiError } from '../../components/ui';

/**
 * Live data of one job (docs/design/p5-live.md §5–6): history through REST (the last chunks/events),
 * then the SSE stream after the head it had. Frames are buffered and flushed every 100 ms (one render
 * per batch). On `behind` the stream is closed and the view asks for a reload; without EventSource it
 * polls the REST tails. p5-live-fixes-2: a stream the browser gave up on (proxy 5xx, deploy, sleep) is
 * reopened from the last seen sequence with exponential backoff (polling meanwhile after a few
 * failures); `bye` reopens at once; a tab that becomes visible again re-reads the tails and the job.
 * p6-ui-jobs: `reconnecting` while the stream is down (browser retry or our backoff), and a stall watchdog —
 * heartbeats are SSE comments the page cannot see, so after a quiet spell the REST tails are read; output the
 * stream never delivered means the connection silently died (sleep, Wi-Fi change, proxy) and it is reopened.
 */

export type LiveStatus = 'loading' | 'live' | 'reconnecting' | 'polling' | 'behind' | 'error';

/** Chunks kept in memory; older ones are dropped (the full history stays searchable on the server). */
export const MAX_LOGS = 20_000;
export const MAX_EVENTS = 5_000;
const HISTORY = 500;
const POLL_MS = 4_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Consecutive failed reconnects after which the REST tails are polled until the stream is back. */
const POLL_AFTER_FAILURES = 3;
/** p6-ui-jobs: how often the stall watchdog looks, and how long a stream may stay silent before it checks. */
export const WATCHDOG_MS = 15_000;
export const QUIET_MS = 30_000;

/** p5-live-fixes-2: exponential reconnect backoff (1 s, 2 s, 4 s, … capped at 30 s). */
export function reconnectDelay(failures: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, failures));
}

export function logKey(a: LogItem, b: LogItem): number {
  return a.attemptNo - b.attemptNo || a.workerSeq - b.workerSeq || a.chunkSeq - b.chunkSeq || a.seq - b.seq;
}

export function eventKey(a: EventItem, b: EventItem): number {
  return a.attemptNo - b.attemptNo || a.workerSeq - b.workerSeq || a.seq - b.seq;
}

/** Merges new items into a sorted list (dedupe by stream sequence; appends in O(k) when in order). */
export function mergeSorted<T extends { readonly seq: number }>(
  list: readonly T[],
  incoming: readonly T[],
  cmp: (a: T, b: T) => number,
  max: number,
): { items: T[]; dropped: boolean } {
  if (incoming.length === 0) return { items: list as T[], dropped: false };
  const seen = new Set(list.map((x) => x.seq));
  const fresh = incoming.filter((x) => {
    if (seen.has(x.seq)) return false;
    seen.add(x.seq);
    return true;
  });
  if (fresh.length === 0) return { items: list as T[], dropped: false };
  fresh.sort(cmp);
  const last = list.at(-1);
  const first = fresh[0];
  let items: T[];
  if (last === undefined || (first !== undefined && cmp(last, first) <= 0)) items = [...list, ...fresh];
  else items = [...list, ...fresh].sort(cmp);
  const dropped = items.length > max;
  return { items: dropped ? items.slice(items.length - max) : items, dropped };
}

export interface LiveData {
  readonly logs: readonly LogItem[];
  readonly events: readonly EventItem[];
  readonly summary: LiveSummary | null;
  readonly jobState: string | null;
  readonly status: LiveStatus;
  readonly error: ApiError | null;
  /** Older output exists than what is loaded. */
  readonly partial: boolean;
  /** Bumped after a reconnect or when the tab becomes visible again: the caller re-reads the job. */
  readonly resyncs: number;
}

export function useLive(
  jobId: string,
  initialState: string,
): LiveData & { reload: () => void; refreshEvents: () => void; setJobState: (s: string) => void } {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [summary, setSummary] = useState<LiveSummary | null>(null);
  const [jobState, setJobState] = useState<string | null>(initialState);
  const [status, setStatus] = useState<LiveStatus>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const [partial, setPartial] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [resyncs, setResyncs] = useState(0);
  const pending = useRef<{ logs: LogItem[]; events: EventItem[] }>({ logs: [], events: [] });

  useEffect(() => {
    setJobState(initialState);
  }, [initialState]);

  const absorb = useCallback((newLogs: LogItem[], newEvents: EventItem[]) => {
    if (newLogs.length > 0) {
      setLogs((cur) => {
        const m = mergeSorted(cur, newLogs, logKey, MAX_LOGS);
        if (m.dropped) setPartial(true);
        return m.items;
      });
    }
    if (newEvents.length > 0) {
      setEvents((cur) => {
        const m = mergeSorted(cur, newEvents, eventKey, MAX_EVENTS);
        if (m.dropped) setPartial(true);
        return m.items;
      });
    }
  }, []);

  useEffect(() => {
    let live = true;
    // A function, not the variable: cleanup flips it while the loader awaits.
    const isLive = (): boolean => live;
    let source: EventSource | null = null;
    const currentSource = (): EventSource | null => source;
    let poll: ReturnType<typeof setInterval> | null = null;
    let flush: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // p5-live-fixes-2: highest stream sequence seen; a reconnect resumes after it (?after=, the same
    // cursor the browser would send as Last-Event-ID).
    let cursor = 0;
    let failures = 0;
    let opened = false;
    let behind = false;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    // Last time the open stream delivered a frame (any event type).
    let lastFrame = Date.now();
    let checking = false;
    setStatus('loading');
    setError(null);
    setLogs([]);
    setEvents([]);
    setPartial(false);
    pending.current = { logs: [], events: [] };

    const seen = (seq: number): void => {
      if (seq > cursor) cursor = seq;
    };

    /** Reads the REST tails; returns the highest sequence the server has (0 when nothing). */
    const pollOnce = async (): Promise<number> => {
      const [l, e] = await Promise.all([
        getLogs(jobId, { tail: true, limit: 200 }),
        getEvents(jobId, { tail: true, limit: 200 }),
      ]);
      if (!live) return 0;
      const top = Math.max(l.head, e.head, ...l.items.map((x) => x.seq), ...e.items.map((x) => x.seq));
      for (const x of l.items) seen(x.seq);
      for (const x of e.items) seen(x.seq);
      absorb(l.items, e.items);
      return top;
    };

    const startPolling = (): void => {
      if (!live || poll !== null) return;
      setStatus('polling');
      poll = setInterval(() => {
        pollOnce().catch(() => undefined);
      }, POLL_MS);
    };

    const stopPolling = (): void => {
      if (poll !== null) clearInterval(poll);
      poll = null;
    };

    /** Catch up after a gap (reconnect, hidden tab): REST tails plus the job state through the caller. */
    const resync = (): void => {
      pollOnce().catch(() => undefined);
      setResyncs((n) => n + 1);
    };

    const scheduleReconnect = (): void => {
      if (!live || behind || retry !== null) return;
      const delay = reconnectDelay(failures);
      failures++;
      if (poll === null) setStatus('reconnecting');
      // Keep data flowing while the stream is down.
      if (failures >= POLL_AFTER_FAILURES) startPolling();
      retry = setTimeout(() => {
        retry = null;
        open();
      }, delay);
    };

    const open = (): void => {
      if (!live || behind) return;
      source?.close();
      const es = new EventSource(streamUrl(jobId, cursor));
      source = es;
      lastFrame = Date.now();
      const frame = (): void => {
        if (source === es) lastFrame = Date.now();
      };
      for (const type of ['ready', 'log', 'event', 'job', 'bye']) es.addEventListener(type, frame);
      es.addEventListener('ready', () => {
        if (!live || source !== es) return;
        failures = 0;
        stopPolling();
        setStatus('live');
        if (opened) resync();
        opened = true;
      });
      es.addEventListener('log', (m: MessageEvent<string>) => {
        try {
          const item = parseLog(JSON.parse(m.data));
          seen(item.seq);
          pending.current.logs.push(item);
        } catch {
          // malformed frame: ignored (never rendered)
        }
      });
      es.addEventListener('event', (m: MessageEvent<string>) => {
        try {
          const item = parseEvent(JSON.parse(m.data));
          seen(item.seq);
          pending.current.events.push(item);
        } catch {
          // ignored
        }
      });
      es.addEventListener('job', (m: MessageEvent<string>) => {
        try {
          const d = JSON.parse(m.data) as { state?: unknown };
          if (typeof d.state === 'string' && live) setJobState(d.state);
        } catch {
          // ignored
        }
      });
      es.addEventListener('bye', () => {
        // The server ends every stream after maxAgeMs: reopen at once from the cursor.
        if (source !== es) return;
        es.close();
        open();
      });
      es.addEventListener('behind', () => {
        behind = true;
        es.close();
        if (live) setStatus('behind');
      });
      es.onerror = () => {
        if (source !== es) return;
        // CLOSED: the browser gave up (HTTP error, proxy 5xx, auth) — reconnect ourselves with backoff.
        // Otherwise EventSource reconnects by itself with Last-Event-ID.
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          scheduleReconnect();
        } else if (live && poll === null) {
          // CONNECTING: the browser retries by itself; say so instead of a stale "Live".
          setStatus('reconnecting');
        }
      };
    };

    /**
     * p6-ui-jobs stall watchdog: a stream that has been silent for QUIET_MS is checked against the REST
     * tails. Output the stream never delivered → the connection is dead without an error: reopen it. The job
     * is re-read either way (its state may have changed without new output).
     */
    const checkStall = async (): Promise<void> => {
      if (!live || behind || checking || source === null || poll !== null) return;
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastFrame < QUIET_MS) return;
      checking = true;
      const before = cursor;
      try {
        const top = await pollOnce();
        // Functions, not the variables: both may change while the poll awaits.
        if (!isLive()) return;
        setResyncs((n) => n + 1);
        lastFrame = Date.now();
        if (top > before && currentSource() !== null) {
          if (retry !== null) clearTimeout(retry);
          retry = null;
          failures = 0;
          setStatus('reconnecting');
          open();
        }
      } catch {
        // The master is unreachable: the stream's own error handling reports it.
      } finally {
        checking = false;
      }
    };

    const onVisibility = (): void => {
      if (!live || behind || document.visibilityState !== 'visible') return;
      if (source === null && poll === null) return; // still loading the history
      resync();
      if (source !== null && source.readyState === EventSource.CLOSED) {
        if (retry !== null) clearTimeout(retry);
        retry = null;
        failures = 0;
        open();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    void (async () => {
      try {
        const [l, e, s] = await Promise.all([
          getLogs(jobId, { tail: true, limit: HISTORY }),
          getEvents(jobId, { tail: true, limit: HISTORY }),
          getLiveSummary(jobId),
        ]);
        if (!isLive()) return;
        absorb(l.items, e.items);
        setSummary(s);
        setPartial(s.logChunks > l.items.length || s.events > e.items.length);
        cursor = Math.max(l.head, e.head, s.head);
        if (typeof EventSource === 'undefined') {
          startPolling();
          return;
        }
        flush = setInterval(() => {
          const p = pending.current;
          if (p.logs.length === 0 && p.events.length === 0) return;
          pending.current = { logs: [], events: [] };
          absorb(p.logs, p.events);
        }, 100);
        open();
        watchdog = setInterval(() => {
          void checkStall();
        }, WATCHDOG_MS);
      } catch (err) {
        if (isLive()) {
          setError(toApiError(err));
          setStatus('error');
        }
      }
    })();

    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisibility);
      source?.close();
      if (poll !== null) clearInterval(poll);
      if (flush !== null) clearInterval(flush);
      if (retry !== null) clearTimeout(retry);
      if (watchdog !== null) clearInterval(watchdog);
    };
  }, [jobId, generation, absorb]);

  const reload = useCallback(() => {
    setGeneration((g) => g + 1);
  }, []);

  const refreshEvents = useCallback(() => {
    getEvents(jobId, { tail: true, limit: HISTORY }).then(
      (e) => {
        // Approval status changed: replace the rows that came back (same seq).
        setEvents((cur) => {
          const byId = new Map(e.items.map((x) => [x.seq, x]));
          const replaced = cur.map((x) => byId.get(x.seq) ?? x);
          return mergeSorted(replaced, e.items, eventKey, MAX_EVENTS).items;
        });
      },
      () => undefined,
    );
  }, [jobId]);

  return {
    logs,
    events,
    summary,
    jobState,
    status,
    error,
    partial,
    resyncs,
    reload,
    refreshEvents,
    setJobState,
  };
}
