import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p8-uptime (docs/design/p8-uptime.md): typed wrappers for the master's uptime routes (apps/master/src/uptime/routes.ts).
 * The master probes every monitor itself; names, details and URLs are untrusted text (rendered as text only).
 */

type Opts = Omit<RequestOptions, 'body'>;
const enc = encodeURIComponent;

export const MONITOR_TYPES = ['http', 'tcp', 'pages', 'coolify'] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];
export type MonitorStatus = 'pending' | 'up' | 'down';
export type StatusFilter = MonitorStatus | 'paused';
export type SeriesRange = '24h' | '7d' | '30d' | '90d';
export const SERIES_RANGES: readonly SeriesRange[] = ['24h', '7d', '30d', '90d'];

/** Ports the master allows for http(s) monitors (default ports included). */
export const HTTP_PORTS: readonly number[] = [80, 443, 8080, 8443];
export const INTERVAL_MIN = 30;
export const PROVIDER_INTERVAL_MIN = 60;

export interface LastCheck {
  readonly at: string;
  readonly ok: boolean | null;
  readonly latencyMs: number | null;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly detail: string | null;
}

export interface Monitor {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly type: MonitorType;
  readonly config: Record<string, unknown>;
  readonly outputKey: string | null;
  readonly intervalSec: number;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly paused: boolean;
  readonly status: MonitorStatus;
  readonly flapping: boolean;
  readonly consecutiveFailures: number;
  readonly statusChangedAt: string | null;
  readonly lastCheck: LastCheck | null;
  readonly tls: { readonly expiresAt: string; readonly daysLeft: number; readonly warning: boolean } | null;
  readonly uptime: { readonly h24: number | null; readonly d7: number | null; readonly d30: number | null };
  readonly latencyAvg24h: number | null;
  readonly sparkline: readonly (number | null)[];
  readonly openIncident: { readonly id: string; readonly startedAt: string; readonly cause: string } | null;
  readonly nextCheckAt: string;
  readonly createdBy: { readonly type: 'user' | 'system'; readonly id: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Incident {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly cause: string;
  readonly detail: string | null;
  readonly suppressed: boolean;
}

export interface Check {
  readonly id: string;
  readonly at: string;
  readonly ok: boolean | null;
  readonly latencyMs: number | null;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly detail: string | null;
}

export interface SeriesPoint {
  readonly t: string;
  readonly uptime: number | null;
  readonly latencyAvg: number | null;
  readonly latencyMax: number | null;
  readonly checks: number;
}

export interface UptimeSettings {
  readonly project: string;
  readonly autoMonitor: boolean;
  readonly updatedAt: string | null;
}

export interface MonitorInput {
  readonly project: string;
  readonly name: string;
  readonly type: MonitorType;
  readonly config: Record<string, unknown>;
  readonly outputKey?: string | null;
  readonly intervalSec?: number;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly paused?: boolean;
}

export type MonitorPatch = Partial<Omit<MonitorInput, 'project' | 'type'>>;

function nnum(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError(k);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], k: string): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new ShapeError(k);
}

function arr(v: unknown, k: string): unknown[] {
  if (!Array.isArray(v)) throw new ShapeError(k);
  return v;
}

const STATUSES: readonly MonitorStatus[] = ['pending', 'up', 'down'];

export function parseMonitor(v: unknown): Monitor {
  const o = obj(v);
  const lc = o.lastCheck === null || o.lastCheck === undefined ? null : obj(o.lastCheck);
  const tls = o.tls === null || o.tls === undefined ? null : obj(o.tls);
  const up = obj(o.uptime);
  const inc = o.openIncident === null || o.openIncident === undefined ? null : obj(o.openIncident);
  const by = obj(o.createdBy);
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    name: str(o, 'name'),
    type: oneOf(o.type, MONITOR_TYPES, 'type'),
    config: obj(o.config),
    outputKey: nullableStr(o, 'outputKey'),
    intervalSec: int(o, 'intervalSec'),
    timeoutMs: int(o, 'timeoutMs'),
    retries: int(o, 'retries'),
    paused: o.paused === true,
    status: oneOf(o.status, STATUSES, 'status'),
    flapping: o.flapping === true,
    consecutiveFailures: int(o, 'consecutiveFailures'),
    statusChangedAt: nullableStr(o, 'statusChangedAt'),
    lastCheck:
      lc === null
        ? null
        : {
            at: str(lc, 'at'),
            ok: typeof lc.ok === 'boolean' ? lc.ok : null,
            latencyMs: nnum(lc, 'latencyMs'),
            statusCode: nnum(lc, 'statusCode'),
            error: nullableStr(lc, 'error'),
            detail: nullableStr(lc, 'detail'),
          },
    tls:
      tls === null
        ? null
        : { expiresAt: str(tls, 'expiresAt'), daysLeft: int(tls, 'daysLeft'), warning: tls.warning === true },
    uptime: { h24: nnum(up, 'h24'), d7: nnum(up, 'd7'), d30: nnum(up, 'd30') },
    latencyAvg24h: nnum(o, 'latencyAvg24h'),
    sparkline: arr(o.sparkline, 'sparkline').map((x) => (typeof x === 'number' ? x : null)),
    openIncident:
      inc === null
        ? null
        : { id: str(inc, 'id'), startedAt: str(inc, 'startedAt'), cause: str(inc, 'cause') },
    nextCheckAt: str(o, 'nextCheckAt'),
    createdBy: { type: by.type === 'system' ? 'system' : 'user', id: nullableStr(by, 'id') },
    createdAt: str(o, 'createdAt'),
    updatedAt: str(o, 'updatedAt'),
  };
}

function parseIncident(v: unknown): Incident {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    startedAt: str(o, 'startedAt'),
    endedAt: nullableStr(o, 'endedAt'),
    durationMs: nnum(o, 'durationMs'),
    cause: str(o, 'cause'),
    detail: nullableStr(o, 'detail'),
    suppressed: o.suppressed === true,
  };
}

function parseCheck(v: unknown): Check {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    at: str(o, 'at'),
    ok: typeof o.ok === 'boolean' ? o.ok : null,
    latencyMs: nnum(o, 'latencyMs'),
    statusCode: nnum(o, 'statusCode'),
    error: nullableStr(o, 'error'),
    detail: nullableStr(o, 'detail'),
  };
}

function parseSettings(v: unknown): UptimeSettings {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    autoMonitor: o.autoMonitor === true,
    updatedAt: nullableStr(o, 'updatedAt'),
  };
}

export interface MonitorFilter {
  readonly project?: string;
  readonly status?: StatusFilter;
  readonly q?: string;
  readonly outputKey?: string;
  readonly limit?: number;
}

export function monitorQuery(f: MonitorFilter): string {
  const q = new URLSearchParams();
  if (f.project) q.set('project', f.project);
  if (f.status) q.set('status', f.status);
  if (f.q) q.set('q', f.q);
  if (f.outputKey) q.set('outputKey', f.outputKey);
  if (f.limit !== undefined) q.set('limit', String(f.limit));
  const s = q.toString();
  return s === '' ? '' : `?${s}`;
}

const items =
  <T>(parse: (v: unknown) => T) =>
  (v: unknown): T[] =>
    arr(obj(v).items, 'items').map(parse);

export function listMonitors(f: MonitorFilter = {}, opts: Opts = {}): Promise<Monitor[]> {
  return apiRequest('GET', `/uptime/monitors${monitorQuery(f)}`, items(parseMonitor), opts);
}

/** p9-pagination: one offset page of monitors with the total of the filtered list. */
export function listMonitorsPage(
  f: Omit<MonitorFilter, 'limit'>,
  page: { readonly offset: number; readonly limit: number },
  opts: Opts = {},
): Promise<{ items: Monitor[]; total: number }> {
  const q = new URLSearchParams(monitorQuery({ ...f, limit: page.limit }).slice(1));
  if (page.offset > 0) q.set('offset', String(page.offset));
  return apiRequest(
    'GET',
    `/uptime/monitors?${q.toString()}`,
    (v) => {
      const o = obj(v);
      const list = arr(o.items, 'items').map(parseMonitor);
      return { items: list, total: typeof o.total === 'number' ? o.total : page.offset + list.length };
    },
    opts,
  );
}

export function getMonitor(id: string, opts: Opts = {}): Promise<Monitor> {
  return apiRequest('GET', `/uptime/monitors/${enc(id)}`, parseMonitor, opts);
}

export function createMonitor(input: MonitorInput, opts: Opts = {}): Promise<Monitor> {
  return apiRequest('POST', '/uptime/monitors', parseMonitor, { ...opts, body: input });
}

export function monitorFromOutput(
  project: string,
  key: string,
  opts: Opts = {},
): Promise<{ created: Monitor[]; existing: Monitor[] }> {
  return apiRequest(
    'POST',
    '/uptime/monitors/from-output',
    (v) => {
      const o = obj(v);
      return {
        created: arr(o.created, 'created').map(parseMonitor),
        existing: arr(o.existing, 'existing').map(parseMonitor),
      };
    },
    { ...opts, body: { project, key } },
  );
}

export function updateMonitor(id: string, patch: MonitorPatch, opts: Opts = {}): Promise<Monitor> {
  return apiRequest('PATCH', `/uptime/monitors/${enc(id)}`, parseMonitor, { ...opts, body: patch });
}

export function deleteMonitor(id: string, opts: Opts = {}): Promise<null> {
  return apiRequest('DELETE', `/uptime/monitors/${enc(id)}`, () => null, opts);
}

export function checkNow(id: string, opts: Opts = {}): Promise<Monitor> {
  return apiRequest('POST', `/uptime/monitors/${enc(id)}/check`, parseMonitor, opts);
}

export function monitorSeries(id: string, range: SeriesRange, opts: Opts = {}): Promise<SeriesPoint[]> {
  return apiRequest(
    'GET',
    `/uptime/monitors/${enc(id)}/series?range=${range}`,
    (v) =>
      arr(obj(v).points, 'points').map((x) => {
        const p = obj(x);
        return {
          t: str(p, 't'),
          uptime: nnum(p, 'uptime'),
          latencyAvg: nnum(p, 'latencyAvg'),
          latencyMax: nnum(p, 'latencyMax'),
          checks: nnum(p, 'checks') ?? 0,
        };
      }),
    opts,
  );
}

/** A keyset page of a monitor's incidents or raw checks (p9-pagination), newest first. */
function keysetPage<T>(
  path: string,
  parse: (v: unknown) => T,
  page: { readonly cursor: string | null; readonly limit: number },
  opts: Opts,
): Promise<{ items: T[]; nextCursor: string | null }> {
  const q = new URLSearchParams({ limit: String(page.limit) });
  if (page.cursor !== null) q.set('cursor', page.cursor);
  return apiRequest(
    'GET',
    `${path}?${q.toString()}`,
    (v) => {
      const o = obj(v);
      return {
        items: arr(o.items, 'items').map(parse),
        nextCursor: typeof o.nextCursor === 'string' ? o.nextCursor : null,
      };
    },
    opts,
  );
}

export function monitorIncidentsPage(
  id: string,
  page: { readonly cursor: string | null; readonly limit: number },
  opts: Opts = {},
): Promise<{ items: Incident[]; nextCursor: string | null }> {
  return keysetPage(`/uptime/monitors/${enc(id)}/incidents`, parseIncident, page, opts);
}

export function monitorChecksPage(
  id: string,
  page: { readonly cursor: string | null; readonly limit: number },
  opts: Opts = {},
): Promise<{ items: Check[]; nextCursor: string | null }> {
  return keysetPage(`/uptime/monitors/${enc(id)}/checks`, parseCheck, page, opts);
}

export function monitorIncidents(id: string, limit = 50, opts: Opts = {}): Promise<Incident[]> {
  return apiRequest(
    'GET',
    `/uptime/monitors/${enc(id)}/incidents?limit=${String(limit)}`,
    items(parseIncident),
    opts,
  );
}

export function monitorChecks(id: string, limit = 50, opts: Opts = {}): Promise<Check[]> {
  return apiRequest(
    'GET',
    `/uptime/monitors/${enc(id)}/checks?limit=${String(limit)}`,
    items(parseCheck),
    opts,
  );
}

export function getUptimeSettings(project: string, opts: Opts = {}): Promise<UptimeSettings> {
  return apiRequest('GET', `/uptime/settings?project=${enc(project)}`, parseSettings, opts);
}

export function putUptimeSettings(
  project: string,
  autoMonitor: boolean,
  opts: Opts = {},
): Promise<UptimeSettings> {
  return apiRequest('PUT', '/uptime/settings', parseSettings, { ...opts, body: { project, autoMonitor } });
}

// ------------------------------------------------------------------------------------------- display helpers

export const TYPE_LABEL: Readonly<Record<MonitorType, string>> = {
  http: 'HTTP(S)',
  tcp: 'TCP',
  pages: 'Cloudflare Pages',
  coolify: 'Coolify app',
};

/** What a monitor checks, as one line of text. */
export function targetText(type: string, config: Record<string, unknown>): string {
  const s = (k: string): string => {
    const v = config[k];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  };
  switch (type) {
    case 'http':
      return `${s('method') || 'GET'} ${s('url')}`;
    case 'tcp':
      return `${s('host')}:${s('port')}`;
    case 'pages':
      return `${s('project')} (${s('env') || 'production'})`;
    case 'coolify':
      return s('uuid');
    default:
      return '';
  }
}

/** `99.95 %`, or `—` when nothing was decided. */
export function pct(v: number | null): string {
  if (v === null) return '—';
  return `${v >= 99.995 ? '100' : v.toFixed(v >= 99 ? 2 : 1)} %`;
}

const CAUSE_TEXT: Readonly<Record<string, string>> = {
  timeout: 'timed out',
  dns: 'host name does not resolve',
  address_refused: 'non-public address (refused)',
  url_refused: 'URL not allowed',
  connect: 'connection refused or reset',
  network: 'network error',
  tls: 'TLS certificate refused',
  status: 'unexpected HTTP status',
  keyword: 'keyword check failed',
  slow: 'too slow',
  redirect: 'too many or invalid redirects',
  provider_down: 'provider reports it down',
  provider_pending: 'provider: in progress',
  provider_not_found: 'not found at the provider',
  provider_auth: 'provider token refused',
  provider_rate_limited: 'provider rate limit',
  provider_unavailable: 'provider did not answer',
  provider_not_configured: 'provider not connected',
  invalid_config: 'settings no longer valid',
  check_error: 'check could not run',
};

export function causeText(code: string | null): string {
  if (code === null) return '';
  return CAUSE_TEXT[code] ?? code.replace(/_/g, ' ');
}

export function durationText(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${String(h)} h` : `${String(h)} h ${String(m % 60)} min`;
  return `${String(Math.round(h / 24))} days`;
}

/** A provider status row ("Cloudflare Pages: healthy"), or null for http / tcp monitors. */
export function providerRow(type: string, detail: string | null, status: string): string | null {
  if (type !== 'pages' && type !== 'coolify') return null;
  const label = type === 'pages' ? 'Cloudflare Pages' : 'Coolify app';
  return `${label}: ${detail ?? (status === 'pending' ? 'not checked yet' : status)}`;
}

/**
 * Client-side checks of the New monitor form (the master checks everything again). Returns field → message.
 */
export function validateMonitorForm(f: {
  readonly name: string;
  readonly type: MonitorType;
  readonly url: string;
  readonly method: 'GET' | 'HEAD';
  readonly keyword: string;
  readonly host: string;
  readonly port: string;
  readonly pagesProject: string;
  readonly coolifyUuid: string;
  readonly intervalSec: string;
}): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.name.trim() === '') e.name = 'Give the monitor a name.';
  const interval = Number(f.intervalSec);
  const provider = f.type === 'pages' || f.type === 'coolify';
  const min = provider ? PROVIDER_INTERVAL_MIN : INTERVAL_MIN;
  if (!Number.isInteger(interval) || interval < min || interval > 86_400) {
    e.intervalSec = provider
      ? `Provider checks run at most once a minute (${String(PROVIDER_INTERVAL_MIN)}–86400 s).`
      : `At least ${String(INTERVAL_MIN)} s, at most 86400 s.`;
  }
  if (f.type === 'http') {
    let u: URL | null = null;
    try {
      u = new URL(f.url.trim());
    } catch {
      e.url = 'Enter a full http:// or https:// URL.';
    }
    if (u !== null) {
      const port = u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') e.url = 'Only http:// and https:// URLs.';
      else if (u.username !== '' || u.password !== '') e.url = 'No user name or password in the URL.';
      else if (!HTTP_PORTS.includes(port))
        e.url = `Port ${String(port)} is not allowed: use 80, 443, 8080 or 8443.`;
    }
    if (f.keyword.trim() !== '' && f.method === 'HEAD')
      e.keyword = 'A keyword check needs GET (HEAD has no body).';
  } else if (f.type === 'tcp') {
    if (f.host.trim() === '') e.host = 'Enter a host name or address.';
    const p = Number(f.port);
    if (!Number.isInteger(p) || p < 1 || p > 65_535) e.port = 'A port between 1 and 65535.';
  } else if (f.type === 'pages') {
    if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(f.pagesProject))
      e.pagesProject = 'The Pages project name (lowercase).';
  } else if (!/^[A-Za-z0-9_-]{1,64}$/.test(f.coolifyUuid)) {
    e.coolifyUuid = 'The Coolify application uuid.';
  }
  return e;
}
