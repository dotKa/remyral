import { apiRequest, obj, type RequestOptions, ShapeError } from './client';

/**
 * p16-observability: Ayarlar → Sistem durumu (owners and admins). `GET /system/status`, `GET /system/logs`,
 * `GET /system/traces[/:id]` — all read-only.
 */

export type ComponentState = 'ok' | 'warning' | 'failing' | 'unknown' | 'not_configured';
export type ComponentId = 'master' | 'web' | 'postgres' | 'redis' | 'backup';

export interface SystemStatus {
  readonly checkedAt: string;
  readonly overall: 'ok' | 'warning' | 'failing';
  readonly problems: readonly string[];
  readonly components: readonly {
    readonly id: ComponentId;
    readonly state: ComponentState;
    readonly code: string | null;
    readonly latencyMs: number | null;
  }[];
  readonly master: {
    readonly releaseTag: string | null;
    readonly startedAt: string;
    readonly uptimeSec: number;
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly eventLoopDelayMs: number | null;
    readonly node: string;
  };
  readonly workerRelease: readonly {
    readonly channel: string;
    readonly version: string;
    readonly rolloutPercent: number;
  }[];
  readonly queue: {
    readonly queued: number;
    readonly running: number;
    readonly oldestQueuedSec: number;
    readonly oldestQueuedJobId: string | null;
    readonly activeLeases: number;
    readonly approvalsPending: number;
  } | null;
  readonly workers: {
    readonly online: number;
    readonly offline: number;
    readonly pending: number;
    readonly list: readonly {
      readonly id: string;
      readonly name: string;
      readonly state: string;
      readonly connected: boolean;
      readonly lastSeenAt: string | null;
      readonly workerVersion: string;
      readonly runningJobs: number;
    }[];
  } | null;
  readonly versionFeed: {
    readonly enabled: boolean;
    readonly items: number;
    readonly failing: number;
    readonly lastCheckedAt: string | null;
    readonly errors: readonly { readonly item: string; readonly error: string }[];
  } | null;
  readonly integrations: {
    readonly coolify: readonly {
      readonly id: string;
      readonly label: string;
      readonly usable: boolean;
      readonly lastTestAt: string | null;
      readonly lastTestOk: boolean | null;
    }[];
    readonly cloudflare: {
      readonly usable: boolean;
      readonly lastTestAt: string | null;
      readonly lastTestOk: boolean | null;
    } | null;
    readonly github: {
      readonly connected: boolean;
      readonly keyUsable: boolean | null;
      readonly missingPermissions: number;
    } | null;
  } | null;
  readonly errors: {
    readonly windowMinutes: number;
    readonly httpRequests: number;
    readonly http5xx: number;
    readonly dbErrors: number;
    readonly jobFailures: number;
    readonly leaseExpiries: number;
    readonly stepFailures: number;
    readonly workerMessageErrors: number;
    readonly chatTurns: number;
    readonly chatTurnsFailed: number;
    readonly errorLogLines: number | null;
  } | null;
  readonly disk: readonly {
    readonly id: 'data' | 'root';
    readonly totalBytes: number;
    readonly freeBytes: number;
    readonly usedPercent: number;
    readonly state: ComponentState;
  }[];
  readonly database: { readonly sizeBytes: number; readonly connections: number } | null;
  readonly redis: { readonly usedMemoryBytes: number; readonly maxMemoryBytes: number | null } | null;
  readonly tracing: {
    readonly enabled: boolean;
    readonly exporting: boolean;
    readonly slow: number;
    readonly errors: number;
  };
  readonly logs: {
    readonly enabled: boolean;
    readonly retentionDays: number;
    readonly dropped: number;
    readonly lastError: string | null;
  };
}

const OVERALL = ['ok', 'warning', 'failing'];

/** The master validates the response schema; the client checks what the page branches on. */
export function parseSystemStatus(v: unknown): SystemStatus {
  const o = obj(v);
  if (!OVERALL.includes(o.overall as string) || !Array.isArray(o.components) || !Array.isArray(o.problems))
    throw new ShapeError('unexpected system status');
  if (!Array.isArray(o.disk) || typeof o.master !== 'object' || o.master === null)
    throw new ShapeError('unexpected system status');
  return o as unknown as SystemStatus;
}

export function getSystemStatus(opts: Omit<RequestOptions, 'body'> = {}): Promise<SystemStatus> {
  return apiRequest('GET', '/system/status', parseSystemStatus, opts);
}

export type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export const LOG_LEVELS: readonly LogLevelName[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

export interface LogLine {
  readonly id: string;
  readonly at: string;
  readonly level: number;
  readonly levelName: string;
  readonly component: string | null;
  readonly reqId: string | null;
  readonly jobId: string | null;
  readonly workerId: string | null;
  readonly traceId: string | null;
  readonly msg: string;
  readonly fields: Readonly<Record<string, unknown>> | null;
}

export interface LogPage {
  readonly enabled: boolean;
  readonly retentionDays: number;
  readonly lines: readonly LogLine[];
  readonly nextBefore: string | null;
  readonly since: string | null;
  readonly until: string | null;
}

export interface LogFilters {
  readonly level?: LogLevelName | undefined;
  readonly component?: string | undefined;
  readonly reqId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly q?: string | undefined;
  readonly before?: string | undefined;
  readonly limit?: number | undefined;
}

export function parseLogPage(v: unknown): LogPage {
  const o = obj(v);
  if (typeof o.enabled !== 'boolean' || !Array.isArray(o.lines)) throw new ShapeError('unexpected log page');
  return o as unknown as LogPage;
}

/** The query string of a log search (empty values left out). */
export function logQuery(f: LogFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s === '' ? '' : `?${s}`;
}

export function searchLogs(f: LogFilters, opts: Omit<RequestOptions, 'body'> = {}): Promise<LogPage> {
  return apiRequest('GET', `/system/logs${logQuery(f)}`, parseLogPage, opts);
}

export interface TraceSummary {
  readonly traceId: string;
  readonly root: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly error: boolean;
  readonly slow: boolean;
  readonly spanCount: number;
  readonly droppedSpans: number;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface TraceSpan {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: number;
  readonly startMs: number;
  readonly durationMs: number;
  readonly error: boolean;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export type TraceDetail = Omit<TraceSummary, 'attributes'> & { readonly spans: readonly TraceSpan[] };

export function parseTraceList(v: unknown): { enabled: boolean; traces: readonly TraceSummary[] } {
  const o = obj(v);
  if (typeof o.enabled !== 'boolean' || !Array.isArray(o.traces))
    throw new ShapeError('unexpected trace list');
  return o as unknown as { enabled: boolean; traces: readonly TraceSummary[] };
}

export function listTraces(
  kind: 'all' | 'slow' | 'error' = 'all',
  opts: Omit<RequestOptions, 'body'> = {},
): Promise<{ enabled: boolean; traces: readonly TraceSummary[] }> {
  return apiRequest('GET', `/system/traces?kind=${kind}`, parseTraceList, opts);
}

export function parseTrace(v: unknown): TraceDetail {
  const o = obj(v);
  if (typeof o.traceId !== 'string' || !Array.isArray(o.spans)) throw new ShapeError('unexpected trace');
  return o as unknown as TraceDetail;
}

export function getTrace(traceId: string, opts: Omit<RequestOptions, 'body'> = {}): Promise<TraceDetail> {
  if (!/^[0-9a-f]{32}$/.test(traceId)) return Promise.reject(new ShapeError('invalid trace id'));
  return apiRequest('GET', `/system/traces/${traceId}`, parseTrace, opts);
}
