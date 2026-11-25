import {
  API_PREFIX,
  apiRequest,
  int,
  nullableStr,
  obj,
  type RequestOptions,
  ShapeError,
  str,
} from './client';
import { type ApprovalHints, parseApprovalHints } from './approvalDetails';

/**
 * Live job view API (apps/master/src/live/routes.ts, docs/design/p5-live.md §5). Every text field comes
 * from runtimes, workers or repositories: untrusted, rendered as text only (log text through the strict
 * ANSI parser).
 */

type Opts = Omit<RequestOptions, 'body'>;

export type LogStream = 'stdout' | 'stderr' | 'runtime';

export interface LogItem {
  readonly type: 'log';
  readonly seq: number;
  readonly attemptId: string;
  readonly attemptNo: number;
  readonly workerSeq: number;
  readonly stream: LogStream;
  readonly chunkSeq: number;
  readonly ts: string;
  readonly text: string;
}

export interface ApprovalLink {
  readonly requestId: string;
  readonly status: string;
  readonly stepUp: boolean;
  readonly approverRole: string;
}

export interface EventItem {
  readonly type: 'event';
  readonly seq: number;
  readonly attemptId: string;
  readonly attemptNo: number;
  readonly workerSeq: number;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly ts: string;
  readonly approval: ApprovalLink | null;
  /** p10-approval-readable (`approval_request` only): the master's static reading of `payload.details`. */
  readonly hints: ApprovalHints | null;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly head: number;
}

export interface LiveSummary {
  readonly head: number;
  readonly logChunks: number;
  readonly events: number;
  readonly logLimited: boolean;
  readonly artifacts: EventItem[];
  readonly terminal: { readonly supported: boolean; readonly status: string | null };
}

export interface Diff {
  readonly text: string;
  readonly truncated: boolean;
  readonly baseSha: string;
  readonly headSha: string;
}

const STREAMS: readonly LogStream[] = ['stdout', 'stderr', 'runtime'];

function array(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v;
}

export function parseLog(v: unknown): LogItem {
  const o = obj(v);
  const stream = str(o, 'stream');
  if (!STREAMS.includes(stream as LogStream)) throw new ShapeError('stream');
  return {
    type: 'log',
    seq: int(o, 'seq'),
    attemptId: str(o, 'attemptId'),
    attemptNo: int(o, 'attemptNo'),
    workerSeq: int(o, 'workerSeq'),
    stream: stream as LogStream,
    chunkSeq: int(o, 'chunkSeq'),
    ts: str(o, 'ts'),
    text: str(o, 'text'),
  };
}

export function parseEvent(v: unknown): EventItem {
  const o = obj(v);
  const a = o.approval;
  let approval: ApprovalLink | null = null;
  if (a !== null && a !== undefined) {
    const ao = obj(a);
    if (typeof ao.stepUp !== 'boolean') throw new ShapeError('stepUp');
    approval = {
      requestId: str(ao, 'requestId'),
      status: str(ao, 'status'),
      stepUp: ao.stepUp,
      approverRole: str(ao, 'approverRole'),
    };
  }
  return {
    type: 'event',
    seq: int(o, 'seq'),
    attemptId: str(o, 'attemptId'),
    attemptNo: int(o, 'attemptNo'),
    workerSeq: int(o, 'workerSeq'),
    kind: str(o, 'kind'),
    payload: obj(o.payload),
    ts: str(o, 'ts'),
    approval,
    hints: parseApprovalHints(o.hints),
  };
}

function page<T>(item: (v: unknown) => T) {
  return (v: unknown): Page<T> => {
    const o = obj(v);
    return {
      items: array(o.items).map(item),
      nextCursor: nullableStr(o, 'nextCursor'),
      head: int(o, 'head'),
    };
  };
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s === '' ? '' : `?${s}`;
}

const base = (id: string): string => `/jobs/${encodeURIComponent(id)}`;

export function getLogs(
  id: string,
  q: { q?: string; stream?: LogStream; cursor?: string; limit?: number; tail?: boolean },
  opts: Opts = {},
): Promise<Page<LogItem>> {
  return apiRequest(
    'GET',
    `${base(id)}/logs${qs({ q: q.q, stream: q.stream, cursor: q.cursor, limit: q.limit, tail: q.tail ? 1 : undefined })}`,
    page(parseLog),
    opts,
  );
}

export function getEvents(
  id: string,
  q: { cursor?: string; limit?: number; tail?: boolean },
  opts: Opts = {},
): Promise<Page<EventItem>> {
  return apiRequest(
    'GET',
    `${base(id)}/events${qs({ cursor: q.cursor, limit: q.limit, tail: q.tail ? 1 : undefined })}`,
    page(parseEvent),
    opts,
  );
}

export function getLiveSummary(id: string, opts: Opts = {}): Promise<LiveSummary> {
  return apiRequest(
    'GET',
    `${base(id)}/live`,
    (v) => {
      const o = obj(v);
      const t = obj(o.terminal);
      if (typeof o.logLimited !== 'boolean' || typeof t.supported !== 'boolean')
        throw new ShapeError('flags');
      return {
        head: int(o, 'head'),
        logChunks: int(o, 'logChunks'),
        events: int(o, 'events'),
        logLimited: o.logLimited,
        artifacts: array(o.artifacts).map(parseEvent),
        terminal: { supported: t.supported, status: nullableStr(t, 'status') },
      };
    },
    opts,
  );
}

export function getDiff(id: string, opts: Opts = {}): Promise<Diff> {
  return apiRequest(
    'GET',
    `${base(id)}/diff`,
    (v) => {
      const o = obj(v);
      if (typeof o.truncated !== 'boolean') throw new ShapeError('truncated');
      return {
        text: str(o, 'text'),
        truncated: o.truncated,
        baseSha: str(o, 'baseSha'),
        headSha: str(o, 'headSha'),
      };
    },
    opts,
  );
}

export function cancelJob(id: string, reason: string, opts: Opts = {}): Promise<{ state: string }> {
  return apiRequest('POST', `${base(id)}/cancel`, (v) => ({ state: str(obj(obj(v).job), 'state') }), {
    ...opts,
    body: { reason: reason.trim() },
  });
}

/** Same-origin SSE URL (the session cookie goes along; CSP connect-src 'self'). */
export function streamUrl(id: string, after: number): string {
  return `${API_PREFIX}${base(id)}/stream?after=${String(after)}`;
}
