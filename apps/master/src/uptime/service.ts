import { connectionIdOf } from '../ops/coolify-connections.js';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { clampLimit, decodeKeyset, keysetPage } from '../http/pagination.js';
import type { OutputsService } from '../outputs/service.js';
import {
  type CheckResult,
  HttpConfig,
  LIMITS,
  type MonitorInput,
  type MonitorPatch,
  type MonitorStatus,
  type MonitorType,
  parseConfig,
  scheduleOf,
  UptimeError,
  urlProblem,
  urlShapeProblem,
} from './model.js';
import { MonitorOutboxPayload, OUTBOX_TOPIC_MONITOR } from './outbox.js';
import type { Probe } from './probe.js';
import type { ProviderChecks } from './providers.js';
import { applyCheck, type MonitorState, uptimePercent } from './state.js';

/** Keyset scopes of the check and incident cursors (p9-pagination). */
const CHECKS_SCOPE = 'uptime.checks';
const INCIDENTS_SCOPE = 'uptime.incidents';

/**
 * p8-uptime (docs/design/p8-uptime.md): monitors, the check scheduler (an orchestrator tick step), results, incidents,
 * uptime figures, the Outputs link and the per-project auto-monitor setting.
 *
 * Scheduling is database-driven and replica-safe: a tick claims due monitors with `FOR UPDATE SKIP LOCKED` and moves
 * their `next_check_at` forward in the same statement, then runs the checks without blocking the tick (bounded
 * concurrency per replica). Recording a result locks the monitor row, applies the pure status machine
 * (src/uptime/state.ts), stores the check and its hourly rollup, opens / closes the incident and queues the
 * notification (outbox, topic `uptime.monitor`) in one transaction. A result for settings that changed while the check
 * ran is dropped.
 */

export interface UptimeActor {
  readonly type: 'user' | 'system';
  readonly id: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface MonitorBadge {
  readonly id: string;
  readonly name: string;
  readonly type: MonitorType;
  readonly status: MonitorStatus;
  readonly paused: boolean;
  readonly uptime24h: number | null;
  /** Provider status word of the last check ("healthy", "running:healthy"), or the cause of a failure. */
  readonly detail: string | null;
  readonly lastCheckAt: string | null;
}

export interface MonitorView {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly type: MonitorType;
  readonly config: Record<string, unknown>;
  readonly outputKey: string | null;
  /** p13-multi-coolify: the label of a `coolify` monitor's connection (null: other types / removed). */
  readonly coolifyConnection: string | null;
  readonly intervalSec: number;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly paused: boolean;
  readonly status: MonitorStatus;
  readonly flapping: boolean;
  readonly consecutiveFailures: number;
  readonly statusChangedAt: string | null;
  readonly lastCheck: {
    readonly at: string;
    readonly ok: boolean | null;
    readonly latencyMs: number | null;
    readonly statusCode: number | null;
    readonly error: string | null;
    readonly detail: string | null;
  } | null;
  readonly tls: { readonly expiresAt: string; readonly daysLeft: number; readonly warning: boolean } | null;
  readonly uptime: { readonly h24: number | null; readonly d7: number | null; readonly d30: number | null };
  readonly latencyAvg24h: number | null;
  /** 24 hourly points, oldest first: average latency (null: no check that hour). */
  readonly sparkline: (number | null)[];
  readonly openIncident: { readonly id: string; readonly startedAt: string; readonly cause: string } | null;
  readonly nextCheckAt: string;
  readonly createdBy: { readonly type: 'user' | 'system'; readonly id: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IncidentView {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly cause: string;
  readonly detail: string | null;
  readonly suppressed: boolean;
}

export interface CheckView {
  readonly id: string;
  readonly at: string;
  readonly ok: boolean | null;
  readonly latencyMs: number | null;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly detail: string | null;
}

export type SeriesRange = '24h' | '7d' | '30d' | '90d';
export interface SeriesPoint {
  readonly t: string;
  readonly uptime: number | null;
  readonly latencyAvg: number | null;
  readonly latencyMax: number | null;
  readonly checks: number;
}

export interface ListFilter {
  readonly project?: string | undefined;
  readonly status?: MonitorStatus | 'paused' | undefined;
  readonly q?: string | undefined;
  readonly outputKey?: string | undefined;
  readonly limit?: number | undefined;
  /** p9-pagination: rows to skip (with `limit`). */
  readonly offset?: number | undefined;
}

export interface UptimeDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly probe: Probe;
  readonly providers: ProviderChecks;
  /** The Outputs read model ("Monitor this" and auto-monitoring take the site from it). */
  readonly outputs: () => OutputsService | null;
  readonly limits?: Partial<{ perProject: number; total: number; concurrency: number }>;
  /** Exact origins exempt from the http port allowlist at validation (tests; the probe has its own list). */
  readonly allowOrigins?: Iterable<string>;
  /**
   * p13-multi-coolify: fills / checks the Coolify connection of a `coolify` monitor for its project (throws an
   * UptimeError-compatible message as `Error` when the project may not use it). Absent: configs are kept as given.
   */
  readonly coolifyConnection?: (project: string, uuid: string, connection: string | null) => Promise<string>;
}

interface Row {
  id: string;
  project: string;
  name: string;
  type: MonitorType;
  config: Record<string, unknown>;
  output_key: string | null;
  interval_sec: number;
  timeout_ms: number;
  retries: number;
  paused: boolean;
  status: MonitorStatus;
  consecutive_failures: number;
  transitions: Date[];
  flapping: boolean;
  notified_status: 'up' | 'down' | null;
  last_check_at: Date | null;
  last_ok: boolean | null;
  last_latency_ms: number | null;
  last_status_code: number | null;
  last_error: string | null;
  last_detail: string | null;
  tls_expires_at: Date | null;
  tls_warned_expiry: Date | null;
  status_changed_at: Date | null;
  next_check_at: Date;
  created_by_type: 'user' | 'system';
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = `m.id::text AS id, m.project, m.name, m.type, m.config, m.output_key, m.interval_sec, m.timeout_ms,
  m.retries, m.paused, m.status, m.consecutive_failures, m.transitions, m.flapping, m.notified_status, m.last_check_at,
  m.last_ok, m.last_latency_ms, m.last_status_code, m.last_error, m.last_detail, m.tls_expires_at, m.tls_warned_expiry,
  m.status_changed_at, m.next_check_at, m.created_by_type, m.created_by, m.created_at, m.updated_at`;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRUNE_EVERY_MS = HOUR;
const AUTO_EVERY_MS = 60_000;

const notFound = (): UptimeError => new UptimeError(404, 'monitor_not_found', 'Monitor not found.');
const invalid = (message: string): UptimeError => new UptimeError(400, 'invalid_monitor', message);

/** `%…%` ILIKE pattern with the wildcards of the search text escaped. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function stateOf(r: Row): MonitorState {
  return {
    status: r.status,
    consecutiveFailures: r.consecutive_failures,
    transitions: r.transitions,
    flapping: r.flapping,
    notifiedStatus: r.notified_status,
  };
}

/**
 * Checks the config of a type (keyword only with GET; http ports allowlist unless the exact origin is a test
 * exception). Returns the normalised config.
 */
function configOf(type: MonitorType, raw: unknown, allow: ReadonlySet<string>): Record<string, unknown> {
  const parsed = parseConfig(type, raw);
  if (parsed === null) {
    if (type === 'http') {
      const p = HttpConfig.safeParse(raw);
      if (!p.success) throw invalid(`Invalid http settings: ${p.error.issues[0]?.message ?? 'invalid'}`);
    }
    throw invalid(`Invalid ${type} settings.`);
  }
  if (parsed.type === 'http') {
    if (parsed.config.method === 'HEAD' && parsed.config.keyword !== null) {
      throw invalid('A keyword check needs the GET method (HEAD has no body).');
    }
    const problem = allow.has(new URL(parsed.config.url).origin) ? null : urlProblem(parsed.config.url);
    if (problem !== null) throw invalid(`Invalid URL: ${problem}.`);
  }
  return parsed.config;
}

export class UptimeService {
  readonly #inflight = new Map<string, Promise<void>>();
  #lastPrune = 0;
  #lastAuto = 0;
  readonly #limits: { perProject: number; total: number; concurrency: number };
  readonly #allow: ReadonlySet<string>;

  constructor(private readonly deps: UptimeDeps) {
    this.#limits = {
      perProject: deps.limits?.perProject ?? LIMITS.perProject,
      total: deps.limits?.total ?? LIMITS.total,
      concurrency: deps.limits?.concurrency ?? LIMITS.concurrency,
    };
    this.#allow = new Set(deps.allowOrigins ?? []);
  }

  #now(): Date {
    return this.deps.clock();
  }

  // ------------------------------------------------------------------------------------------- reads

  async projectOf(id: string): Promise<string | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.deps.pool.query<{ project: string }>(
      'SELECT project FROM uptime_monitors WHERE id = $1',
      [id],
    );
    return rows[0]?.project ?? null;
  }

  async list(visible: readonly string[] | null, f: ListFilter = {}): Promise<MonitorView[]> {
    return (await this.listPage(visible, f)).items;
  }

  /** p9-pagination: one page of monitors (limit/offset; at most LIMITS.total exist) with the total count. */
  async listPage(
    visible: readonly string[] | null,
    f: ListFilter = {},
  ): Promise<{ items: MonitorView[]; total: number }> {
    const params: unknown[] = [visible === null ? null : [...visible], f.project ?? null];
    const where = ['($1::text[] IS NULL OR m.project = ANY($1))', '($2::text IS NULL OR m.project = $2)'];
    const p = (v: unknown): string => {
      params.push(v);
      return `$${String(params.length)}`;
    };
    if (f.status === 'paused') where.push('m.paused');
    else if (f.status !== undefined) where.push(`NOT m.paused AND m.status = ${p(f.status)}`);
    if (f.outputKey !== undefined) where.push(`m.output_key = ${p(f.outputKey)}`);
    if (f.q !== undefined && f.q.trim() !== '') {
      const q = p(likePattern(f.q.trim()));
      where.push(`(m.name ILIKE ${q} OR m.config::text ILIKE ${q})`);
    }
    const limit = Math.min(Math.max(f.limit ?? LIMITS.listMax, 1), LIMITS.listMax);
    const offset = Math.max(Math.trunc(f.offset ?? 0), 0);
    const { rows } = await this.deps.pool.query<Row & { total_count: number }>(
      `SELECT ${COLS}, count(*) OVER ()::int AS total_count FROM uptime_monitors m WHERE ${where.join(' AND ')}
        ORDER BY (m.status = 'down' AND NOT m.paused) DESC, m.project, lower(m.name), m.id
        LIMIT ${String(limit)} OFFSET ${String(offset)}`,
      params,
    );
    let total = rows[0]?.total_count;
    if (total === undefined) {
      // An offset past the end: count separately so the client can step back.
      const { rows: c } = await this.deps.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM uptime_monitors m WHERE ${where.join(' AND ')}`,
        params,
      );
      total = c[0]?.n ?? 0;
    }
    return { items: await this.#views(rows), total };
  }

  async get(id: string): Promise<MonitorView> {
    if (!UUID.test(id)) throw notFound();
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM uptime_monitors m WHERE m.id = $1`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) throw notFound();
    const [v] = await this.#views([r]);
    if (v === undefined) throw notFound();
    return v;
  }

  async #views(rows: Row[]): Promise<MonitorView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const now = this.#now();
    const hourNow = Math.floor(now.getTime() / HOUR) * HOUR;
    const { rows: agg } = await this.deps.pool.query<{
      monitor_id: string;
      ok24: string | null;
      n24: string | null;
      ok7: string | null;
      n7: string | null;
      ok30: string | null;
      n30: string | null;
      lsum24: string | null;
      ln24: string | null;
    }>(
      `SELECT monitor_id::text AS monitor_id,
              sum(ok_checks) FILTER (WHERE hour >= $2) AS ok24, sum(checks) FILTER (WHERE hour >= $2) AS n24,
              sum(ok_checks) FILTER (WHERE hour >= $3) AS ok7, sum(checks) FILTER (WHERE hour >= $3) AS n7,
              sum(ok_checks) AS ok30, sum(checks) AS n30,
              sum(latency_sum) FILTER (WHERE hour >= $2) AS lsum24, sum(latency_n) FILTER (WHERE hour >= $2) AS ln24
         FROM uptime_rollups WHERE monitor_id = ANY($1::uuid[]) AND hour >= $4 GROUP BY monitor_id`,
      [
        ids,
        new Date(hourNow - 23 * HOUR),
        new Date(hourNow - 7 * DAY + HOUR),
        new Date(hourNow - 30 * DAY + HOUR),
      ],
    );
    const byId = new Map(agg.map((a) => [a.monitor_id, a]));
    const { rows: spark } = await this.deps.pool.query<{
      monitor_id: string;
      hour: Date;
      ls: string;
      ln: number;
    }>(
      `SELECT monitor_id::text AS monitor_id, hour, latency_sum::text AS ls, latency_n AS ln FROM uptime_rollups
        WHERE monitor_id = ANY($1::uuid[]) AND hour >= $2`,
      [ids, new Date(hourNow - 23 * HOUR)],
    );
    const sparkOf = new Map<string, (number | null)[]>();
    for (const s of spark) {
      const arr = sparkOf.get(s.monitor_id) ?? Array<number | null>(24).fill(null);
      const idx = 23 - Math.round((hourNow - s.hour.getTime()) / HOUR);
      if (idx >= 0 && idx < 24 && s.ln > 0) arr[idx] = Math.round(Number(s.ls) / s.ln);
      sparkOf.set(s.monitor_id, arr);
    }
    const { rows: open } = await this.deps.pool.query<{
      monitor_id: string;
      id: string;
      started_at: Date;
      cause: string;
    }>(
      `SELECT monitor_id::text AS monitor_id, id::text AS id, started_at, cause FROM uptime_incidents
        WHERE monitor_id = ANY($1::uuid[]) AND ended_at IS NULL`,
      [ids],
    );
    const openOf = new Map(open.map((o) => [o.monitor_id, o]));
    const connIds = [
      ...new Set(
        rows.flatMap((r) =>
          r.type === 'coolify' && typeof r.config.connection === 'string' ? [r.config.connection] : [],
        ),
      ),
    ];
    const { rows: conns } =
      connIds.length === 0
        ? { rows: [] as { id: string; label: string }[] }
        : await this.deps.pool.query<{ id: string; label: string }>(
            'SELECT id::text AS id, label FROM coolify_connections WHERE id = ANY($1::uuid[])',
            [connIds],
          );
    const connLabel = new Map(conns.map((c) => [c.id, c.label]));
    const num = (s: string | null | undefined): number => (s === null || s === undefined ? 0 : Number(s));
    return rows.map((r) => {
      const a = byId.get(r.id);
      const o = openOf.get(r.id);
      const tlsWarnDays =
        r.type === 'http' && typeof r.config.tlsWarnDays === 'number' ? r.config.tlsWarnDays : 0;
      const daysLeft =
        r.tls_expires_at === null ? null : Math.floor((r.tls_expires_at.getTime() - now.getTime()) / DAY);
      return {
        id: r.id,
        project: r.project,
        name: r.name,
        type: r.type,
        config: r.config,
        outputKey: r.output_key,
        coolifyConnection:
          r.type === 'coolify' && typeof r.config.connection === 'string'
            ? (connLabel.get(r.config.connection) ?? null)
            : null,
        intervalSec: r.interval_sec,
        timeoutMs: r.timeout_ms,
        retries: r.retries,
        paused: r.paused,
        status: r.status,
        flapping: r.flapping,
        consecutiveFailures: r.consecutive_failures,
        statusChangedAt: r.status_changed_at?.toISOString() ?? null,
        lastCheck:
          r.last_check_at === null
            ? null
            : {
                at: r.last_check_at.toISOString(),
                ok: r.last_ok,
                latencyMs: r.last_latency_ms,
                statusCode: r.last_status_code,
                error: r.last_error,
                detail: r.last_detail,
              },
        tls:
          r.tls_expires_at === null || daysLeft === null
            ? null
            : {
                expiresAt: r.tls_expires_at.toISOString(),
                daysLeft,
                warning: tlsWarnDays > 0 && daysLeft <= tlsWarnDays,
              },
        uptime: {
          h24: uptimePercent(num(a?.ok24), num(a?.n24)),
          d7: uptimePercent(num(a?.ok7), num(a?.n7)),
          d30: uptimePercent(num(a?.ok30), num(a?.n30)),
        },
        latencyAvg24h: num(a?.ln24) > 0 ? Math.round(num(a?.lsum24) / num(a?.ln24)) : null,
        sparkline: sparkOf.get(r.id) ?? Array<number | null>(24).fill(null),
        openIncident:
          o === undefined ? null : { id: o.id, startedAt: o.started_at.toISOString(), cause: o.cause },
        nextCheckAt: r.next_check_at.toISOString(),
        createdBy: { type: r.created_by_type, id: r.created_by },
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      };
    });
  }

  /** Monitors linked to Outputs site items of a project (Outputs cards), by item key. */
  async badges(project: string, keys: readonly string[]): Promise<Map<string, MonitorBadge[]>> {
    const out = new Map<string, MonitorBadge[]>();
    if (keys.length === 0) return out;
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM uptime_monitors m WHERE m.project = $1 AND m.output_key = ANY($2::text[])
        ORDER BY m.output_key, CASE m.type WHEN 'http' THEN 0 WHEN 'tcp' THEN 1 ELSE 2 END, m.created_at`,
      [project, [...keys]],
    );
    for (const v of await this.#views(rows)) {
      if (v.outputKey === null) continue;
      const list = out.get(v.outputKey) ?? [];
      list.push({
        id: v.id,
        name: v.name,
        type: v.type,
        status: v.status,
        paused: v.paused,
        uptime24h: v.uptime.h24,
        detail: v.lastCheck?.detail ?? v.lastCheck?.error ?? null,
        lastCheckAt: v.lastCheck?.at ?? null,
      });
      out.set(v.outputKey, list);
    }
    return out;
  }

  async incidents(id: string, limit = 50): Promise<IncidentView[]> {
    return (await this.incidentsPage(id, { limit })).items;
  }

  /** p9-pagination: incidents newest first by `(started_at, id)`, keyset-paged. */
  async incidentsPage(
    id: string,
    opts: { limit?: number | undefined; cursor?: string | undefined } = {},
  ): Promise<{ items: IncidentView[]; nextCursor: string | null }> {
    const lim = clampLimit(opts.limit, 50, LIMITS.incidentsPageMax);
    const after = opts.cursor === undefined ? null : decodeKeyset(INCIDENTS_SCOPE, opts.cursor, 'uuid');
    const { rows } = await this.deps.pool.query<{
      id: string;
      started_at: Date;
      page_key: string;
      ended_at: Date | null;
      cause: string;
      detail: string | null;
      suppressed: boolean;
    }>(
      `SELECT id::text AS id, started_at, to_json(started_at) #>> '{}' AS page_key, ended_at, cause, detail,
              suppressed
         FROM uptime_incidents
        WHERE monitor_id = $1
          AND ($2::timestamptz IS NULL OR (started_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY started_at DESC, id DESC LIMIT $4`,
      [id, after?.k ?? null, after?.id ?? null, lim + 1],
    );
    const now = this.#now().getTime();
    return keysetPage(
      rows,
      lim,
      INCIDENTS_SCOPE,
      (r) => ({ k: r.page_key, id: r.id }),
      (r) => ({
        id: r.id,
        startedAt: r.started_at.toISOString(),
        endedAt: r.ended_at?.toISOString() ?? null,
        durationMs: (r.ended_at?.getTime() ?? now) - r.started_at.getTime(),
        cause: r.cause,
        detail: r.detail,
        suppressed: r.suppressed,
      }),
    );
  }

  async checks(id: string, limit = 100): Promise<CheckView[]> {
    return (await this.checksPage(id, { limit })).items;
  }

  /** p9-pagination: raw checks newest first by `(at, id)`, keyset-paged. */
  async checksPage(
    id: string,
    opts: { limit?: number | undefined; cursor?: string | undefined } = {},
  ): Promise<{ items: CheckView[]; nextCursor: string | null }> {
    const lim = clampLimit(opts.limit, 100, LIMITS.checksPageMax);
    const after = opts.cursor === undefined ? null : decodeKeyset(CHECKS_SCOPE, opts.cursor, 'bigint');
    const { rows } = await this.deps.pool.query<{
      id: string;
      at: Date;
      page_key: string;
      ok: boolean | null;
      latency_ms: number | null;
      status_code: number | null;
      error: string | null;
      detail: string | null;
    }>(
      `SELECT id::text AS id, at, to_json(at) #>> '{}' AS page_key, ok, latency_ms, status_code, error, detail
         FROM uptime_checks
        WHERE monitor_id = $1
          AND ($2::timestamptz IS NULL OR (at, id) < ($2::timestamptz, $3::bigint))
        ORDER BY at DESC, id DESC LIMIT $4`,
      [id, after?.k ?? null, after?.id ?? null, lim + 1],
    );
    return keysetPage(
      rows,
      lim,
      CHECKS_SCOPE,
      (r) => ({ k: r.page_key, id: r.id }),
      (r) => ({
        id: r.id,
        at: r.at.toISOString(),
        ok: r.ok,
        latencyMs: r.latency_ms,
        statusCode: r.status_code,
        error: r.error,
        detail: r.detail,
      }),
    );
  }

  /** Chart data: 24 h from the raw checks (5-minute buckets), longer ranges from the hourly rollups. */
  async series(id: string, range: SeriesRange): Promise<SeriesPoint[]> {
    const now = this.#now();
    if (range === '24h') {
      const { rows } = await this.deps.pool.query<{
        t: Date;
        n: number;
        ok: number;
        lavg: string | null;
        lmax: number | null;
      }>(
        `SELECT date_bin('5 minutes', at, TIMESTAMPTZ '2000-01-01') AS t,
                count(*) FILTER (WHERE ok IS NOT NULL)::int AS n, count(*) FILTER (WHERE ok)::int AS ok,
                avg(latency_ms)::text AS lavg, max(latency_ms) AS lmax
           FROM uptime_checks WHERE monitor_id = $1 AND at >= $2 GROUP BY 1 ORDER BY 1`,
        [id, new Date(now.getTime() - DAY)],
      );
      return rows.map((r) => ({
        t: r.t.toISOString(),
        uptime: uptimePercent(r.ok, r.n),
        latencyAvg: r.lavg === null ? null : Math.round(Number(r.lavg)),
        latencyMax: r.lmax,
        checks: r.n,
      }));
    }
    const spec = { '7d': ['1 hour', 7], '30d': ['6 hours', 30], '90d': ['1 day', 90] } as const;
    const [bucket, days] = spec[range];
    const { rows } = await this.deps.pool.query<{
      t: Date;
      n: string;
      ok: string;
      ls: string;
      ln: string;
      lmax: number | null;
    }>(
      `SELECT date_bin($3::interval, hour, TIMESTAMPTZ '2000-01-01') AS t, sum(checks)::text AS n,
              sum(ok_checks)::text AS ok, sum(latency_sum)::text AS ls, sum(latency_n)::text AS ln,
              max(latency_max) AS lmax
         FROM uptime_rollups WHERE monitor_id = $1 AND hour >= $2 GROUP BY 1 ORDER BY 1`,
      [id, new Date(now.getTime() - days * DAY), bucket],
    );
    return rows.map((r) => ({
      t: r.t.toISOString(),
      uptime: uptimePercent(Number(r.ok), Number(r.n)),
      latencyAvg: Number(r.ln) > 0 ? Math.round(Number(r.ls) / Number(r.ln)) : null,
      latencyMax: r.lmax,
      checks: Number(r.n),
    }));
  }

  // ------------------------------------------------------------------------------------------- writes

  async #audit(
    tx: Queryable,
    actor: UptimeActor,
    action: string,
    id: string,
    metadata: Record<string, unknown>,
    outcome: 'success' | 'denied' | 'failure' = 'success',
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor: { type: actor.type, id: actor.id },
        action,
        target: `uptime-monitor:${id}`,
        outcome,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata,
      },
      tx,
    );
  }

  /** Checks an input as `create` would (settings, schedule), without storing anything. */
  validate(input: MonitorInput): void {
    configOf(input.type, input.config, this.#allow);
    const sched = scheduleOf(input.type, input);
    if (typeof sched === 'string') throw invalid(sched);
  }

  /** Creates a monitor (limits: per project and in total, checked under the project's row lock). */
  /** p13-multi-coolify: a `coolify` config with its connection resolved and authorized for the project. */
  async #withConnection(
    project: string,
    type: MonitorType,
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const resolve = this.deps.coolifyConnection;
    if (type !== 'coolify' || resolve === undefined) return config;
    try {
      const id = await resolve(
        project,
        String(config.uuid),
        typeof config.connection === 'string' ? config.connection : null,
      );
      return { ...config, connection: id };
    } catch (err) {
      throw invalid(err instanceof Error ? err.message : 'No usable Coolify connection.');
    }
  }

  async create(actor: UptimeActor, input: MonitorInput, tx?: Queryable): Promise<MonitorView> {
    const config = await this.#withConnection(
      input.project,
      input.type,
      configOf(input.type, input.config, this.#allow),
    );
    const sched = scheduleOf(input.type, input);
    if (typeof sched === 'string') throw invalid(sched);
    const run = async (db: Queryable): Promise<string> => {
      const { rows: proj } = await db.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [
        input.project,
      ]);
      if (proj.length === 0) throw new UptimeError(404, 'project_not_found', 'Project not found.');
      const { rows: n } = await db.query<{ p: number; t: number }>(
        `SELECT count(*) FILTER (WHERE project = $1)::int AS p, count(*)::int AS t FROM uptime_monitors`,
        [input.project],
      );
      if ((n[0]?.p ?? 0) >= this.#limits.perProject) {
        throw new UptimeError(
          409,
          'monitor_limit',
          `At most ${String(this.#limits.perProject)} monitors per project.`,
        );
      }
      if ((n[0]?.t ?? 0) >= this.#limits.total) {
        throw new UptimeError(
          409,
          'monitor_limit',
          `At most ${String(this.#limits.total)} monitors in total.`,
        );
      }
      const id = randomUUID();
      const now = this.#now();
      await db.query(
        `INSERT INTO uptime_monitors (id, project, name, type, config, output_key, interval_sec, timeout_ms, retries,
                                      paused, status, next_check_at, created_by_type, created_by, created_at,
                                      updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, $13, $11, $11)`,
        [
          id,
          input.project,
          input.name,
          input.type,
          JSON.stringify(config),
          input.outputKey ?? null,
          sched.intervalSec,
          sched.timeoutMs,
          sched.retries,
          input.paused ?? false,
          now,
          actor.type,
          actor.id,
        ],
      );
      await this.#audit(db, actor, 'uptime.monitor.create', id, {
        project: input.project,
        type: input.type,
        name: input.name,
        outputKey: input.outputKey ?? null,
        intervalSec: sched.intervalSec,
        target: targetSummary(input.type, config),
        ...(input.type === 'coolify' ? { coolifyConnection: config.connection ?? null } : {}),
      });
      return id;
    };
    const id = tx === undefined ? await withTransaction(this.deps.pool, run) : await run(tx);
    return tx === undefined ? this.get(id) : this.#getIn(tx, id);
  }

  async #getIn(db: Queryable, id: string): Promise<MonitorView> {
    const { rows } = await db.query<Row>(`SELECT ${COLS} FROM uptime_monitors m WHERE m.id = $1`, [id]);
    const r = rows[0];
    if (r === undefined) throw notFound();
    const [v] = await this.#views([r]);
    if (v === undefined) throw notFound();
    return v;
  }

  async update(actor: UptimeActor, id: string, patch: MonitorPatch): Promise<MonitorView> {
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<Row>(
        `SELECT ${COLS} FROM uptime_monitors m WHERE m.id = $1 FOR UPDATE`,
        [id],
      );
      const r = rows[0];
      if (r === undefined) throw notFound();
      const config =
        patch.config === undefined
          ? r.config
          : await this.#withConnection(r.project, r.type, configOf(r.type, patch.config, this.#allow));
      const sched = scheduleOf(r.type, {
        intervalSec: patch.intervalSec ?? r.interval_sec,
        timeoutMs: patch.timeoutMs ?? r.timeout_ms,
        retries: patch.retries ?? r.retries,
      });
      if (typeof sched === 'string') throw invalid(sched);
      const now = this.#now();
      const configChanged = JSON.stringify(config) !== JSON.stringify(r.config);
      const resumed = patch.paused === false && r.paused;
      if (configChanged) {
        // New settings, new history from here: the open incident ends with the edit and the status starts over.
        await tx.query(
          'UPDATE uptime_incidents SET ended_at = $2 WHERE monitor_id = $1 AND ended_at IS NULL',
          [id, now],
        );
      }
      await tx.query(
        `UPDATE uptime_monitors SET name = $2, config = $3, output_key = $4, interval_sec = $5, timeout_ms = $6,
                retries = $7, paused = $8, updated_at = $9,
                status = CASE WHEN $10 THEN 'pending' ELSE status END,
                consecutive_failures = CASE WHEN $10 THEN 0 ELSE consecutive_failures END,
                notified_status = CASE WHEN $10 THEN NULL ELSE notified_status END,
                tls_expires_at = CASE WHEN $10 THEN NULL ELSE tls_expires_at END,
                next_check_at = CASE WHEN $10 OR $11 THEN $9 ELSE next_check_at END
          WHERE id = $1`,
        [
          id,
          patch.name ?? r.name,
          JSON.stringify(config),
          patch.outputKey === undefined ? r.output_key : patch.outputKey,
          sched.intervalSec,
          sched.timeoutMs,
          sched.retries,
          patch.paused ?? r.paused,
          now,
          configChanged,
          resumed,
        ],
      );
      await this.#audit(tx, actor, 'uptime.monitor.update', id, {
        project: r.project,
        fields: Object.keys(patch),
        ...(configChanged ? { target: targetSummary(r.type, config) } : {}),
        ...(patch.paused === undefined ? {} : { paused: patch.paused }),
      });
    });
    return this.get(id);
  }

  async remove(actor: UptimeActor, id: string): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ project: string; name: string }>(
        'DELETE FROM uptime_monitors WHERE id = $1 RETURNING project, name',
        [id],
      );
      const r = rows[0];
      if (r === undefined) throw notFound();
      await this.#audit(tx, actor, 'uptime.monitor.delete', id, { project: r.project, name: r.name });
    });
  }

  /**
   * "Monitor this" on an Outputs site: an http monitor for its live URL and a provider monitor for its Pages project
   * or each Coolify application. Monitors that already exist for the item (same type and target) are kept.
   */
  async planFromOutput(project: string, key: string): Promise<MonitorInput[]> {
    const outputs = this.deps.outputs();
    if (outputs === null) throw new UptimeError(503, 'unavailable', 'Outputs are not available.');
    const item = await outputs.item(project, key).catch(() => null);
    if (item?.site === null || item === null) {
      throw new UptimeError(404, 'output_not_found', 'No live site with that key in the project.');
    }
    const site = item.site;
    const wanted: MonitorInput[] = [];
    const label = item.title ?? item.name;
    if (
      site.url !== null &&
      (urlProblem(site.url) === null ||
        (urlShapeProblem(site.url) === null && this.#allow.has(new URL(site.url).origin)))
    ) {
      wanted.push({
        project,
        name: `${label} (${site.env})`.slice(0, LIMITS.nameMax),
        type: 'http',
        config: HttpConfig.parse({ url: site.url }),
        outputKey: key,
      });
    }
    const { rows } = await this.deps.pool.query<{ target: Record<string, unknown> }>(
      'SELECT target FROM ops_actions WHERE id = $1 AND project = $2',
      [UUID.test(site.opsActionId) ? site.opsActionId : '00000000-0000-0000-0000-000000000000', project],
    );
    const target = rows[0]?.target ?? {};
    if (site.provider === 'pages') {
      const name = typeof target.project === 'string' ? target.project : null;
      if (name !== null && /^[a-z0-9][a-z0-9-]{0,57}$/.test(name)) {
        wanted.push({
          project,
          name: `Cloudflare Pages: ${name} (${site.env})`.slice(0, LIMITS.nameMax),
          type: 'pages',
          config: { project: name, env: site.env },
          outputKey: key,
        });
      }
    } else {
      const resources = Array.isArray(target.resources)
        ? (target.resources as Record<string, unknown>[])
        : [];
      for (const r of resources.slice(0, 5)) {
        if (typeof r.uuid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.uuid)) continue;
        const rn = typeof r.name === 'string' ? r.name : r.uuid;
        wanted.push({
          project,
          name: `Coolify app: ${rn}`.slice(0, LIMITS.nameMax),
          type: 'coolify',
          // p13-multi-coolify: the connection the deploy ran on.
          config: {
            uuid: r.uuid,
            ...(connectionIdOf(target) === null ? {} : { connection: connectionIdOf(target) }),
          },
          outputKey: key,
        });
      }
    }
    if (wanted.length === 0) {
      throw new UptimeError(409, 'nothing_to_monitor', 'The site has no URL or provider target to monitor.');
    }
    return wanted;
  }

  async createFromOutput(
    actor: UptimeActor,
    project: string,
    key: string,
  ): Promise<{ created: MonitorView[]; existing: MonitorView[] }> {
    const wanted = await this.planFromOutput(project, key);
    const existing = await this.list(null, { project, outputKey: key });
    const same = (a: MonitorView, b: MonitorInput): boolean =>
      a.type === b.type &&
      JSON.stringify(targetSummary(a.type, a.config)) === JSON.stringify(targetSummary(b.type, b.config));
    const created: MonitorView[] = [];
    const kept: MonitorView[] = [];
    for (const w of wanted) {
      const have = existing.find((e) => same(e, w));
      if (have !== undefined) kept.push(have);
      else created.push(await this.create(actor, w));
    }
    return { created, existing: kept };
  }

  // ------------------------------------------------------------------------------------------- settings

  async settings(
    project: string,
  ): Promise<{ project: string; autoMonitor: boolean; updatedAt: string | null }> {
    const { rows } = await this.deps.pool.query<{ auto_monitor: boolean; updated_at: Date }>(
      'SELECT auto_monitor, updated_at FROM uptime_settings WHERE project = $1',
      [project],
    );
    const r = rows[0];
    return { project, autoMonitor: r?.auto_monitor ?? false, updatedAt: r?.updated_at.toISOString() ?? null };
  }

  async setSettings(
    actor: UptimeActor,
    project: string,
    autoMonitor: boolean,
  ): Promise<{ project: string; autoMonitor: boolean; updatedAt: string | null }> {
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query('SELECT 1 FROM projects WHERE id = $1', [project]);
      if (rows.length === 0) throw new UptimeError(404, 'project_not_found', 'Project not found.');
      const now = this.#now();
      await tx.query(
        `INSERT INTO uptime_settings (project, auto_monitor, auto_since, updated_by, updated_at)
         VALUES ($1, $2, CASE WHEN $2 THEN $4::timestamptz END, $3, $4)
         ON CONFLICT (project) DO UPDATE SET auto_monitor = EXCLUDED.auto_monitor,
           auto_since = CASE WHEN EXCLUDED.auto_monitor AND NOT uptime_settings.auto_monitor THEN EXCLUDED.updated_at
                             WHEN EXCLUDED.auto_monitor THEN uptime_settings.auto_since END,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [project, autoMonitor, actor.type === 'user' ? actor.id : null, now],
      );
      await this.deps.audit.record(
        {
          actor: { type: actor.type, id: actor.id },
          action: 'uptime.settings.update',
          target: `project:${project}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { autoMonitor },
        },
        tx,
      );
    });
    return this.settings(project);
  }

  // ------------------------------------------------------------------------------------------- checks

  /** Runs one check of a stored config (never throws: an invalid stored config is a failed check). */
  async #check(type: MonitorType, raw: unknown, timeoutMs: number, project: string): Promise<CheckResult> {
    const parsed = parseConfig(type, raw);
    if (parsed === null) {
      return {
        ok: false,
        latencyMs: null,
        statusCode: null,
        error: 'invalid_config',
        detail: 'the stored settings are not valid',
        tlsExpiresAt: null,
      };
    }
    try {
      switch (parsed.type) {
        case 'http':
          return await this.deps.probe.http(parsed.config, timeoutMs);
        case 'tcp':
          return await this.deps.probe.tcp(parsed.config, timeoutMs);
        case 'pages':
          return await this.deps.providers.pages(parsed.config);
        case 'coolify':
          return await this.deps.providers.coolify(parsed.config, project);
      }
    } catch (err) {
      this.deps.log.warn({ errName: err instanceof Error ? err.name : 'error', type }, 'uptime check threw');
      return {
        ok: null,
        latencyMs: null,
        statusCode: null,
        error: 'check_error',
        detail: 'the check could not run',
        tlsExpiresAt: null,
      };
    }
  }

  /** Stores a result for the monitor as it was when the check started (`version` = its updated_at). */
  async #record(id: string, version: Date, result: CheckResult): Promise<boolean> {
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<Row>(
        `SELECT ${COLS} FROM uptime_monitors m WHERE m.id = $1 FOR UPDATE`,
        [id],
      );
      const r = rows[0];
      if (r === undefined || r.updated_at.getTime() !== version.getTime()) return false;
      const now = this.#now();
      const step = applyCheck(stateOf(r), result, { retries: r.retries, intervalSec: r.interval_sec }, now);
      const detail = result.detail === null ? null : result.detail.slice(0, 300);
      const { rows: ins } = await tx.query<{ id: string }>(
        `INSERT INTO uptime_checks (monitor_id, at, ok, latency_ms, status_code, error, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
        [id, now, result.ok, result.latencyMs, result.statusCode, result.error, detail],
      );
      const checkId = ins[0]?.id ?? '0';
      const decided = result.ok === null ? 0 : 1;
      const hasLatency = result.latencyMs === null ? 0 : 1;
      await tx.query(
        `INSERT INTO uptime_rollups (monitor_id, hour, checks, ok_checks, latency_sum, latency_n, latency_max)
         VALUES ($1, date_trunc('hour', $2::timestamptz), $3, $4, $5, $6, $7)
         ON CONFLICT (monitor_id, hour) DO UPDATE SET checks = uptime_rollups.checks + EXCLUDED.checks,
           ok_checks = uptime_rollups.ok_checks + EXCLUDED.ok_checks,
           latency_sum = uptime_rollups.latency_sum + EXCLUDED.latency_sum,
           latency_n = uptime_rollups.latency_n + EXCLUDED.latency_n,
           latency_max = GREATEST(uptime_rollups.latency_max, EXCLUDED.latency_max)`,
        [id, now, decided, result.ok === true ? 1 : 0, result.latencyMs ?? 0, hasLatency, result.latencyMs],
      );
      let incidentId: string | null = null;
      if (step.changed === 'down') {
        incidentId = randomUUID();
        await tx.query(
          `INSERT INTO uptime_incidents (id, monitor_id, project, started_at, cause, detail, suppressed)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
          [incidentId, id, r.project, now, result.error ?? 'failed', detail, step.state.flapping],
        );
      } else if (step.changed === 'up') {
        const { rows: closed } = await tx.query<{ id: string }>(
          `UPDATE uptime_incidents SET ended_at = $2 WHERE monitor_id = $1 AND ended_at IS NULL
           RETURNING id::text AS id`,
          [id, now],
        );
        incidentId = closed[0]?.id ?? null;
      } else if (step.notice === 'down') {
        const { rows: o } = await tx.query<{ id: string }>(
          'SELECT id::text AS id FROM uptime_incidents WHERE monitor_id = $1 AND ended_at IS NULL',
          [id],
        );
        incidentId = o[0]?.id ?? null;
      }
      // TLS: warn once per certificate when it is within the monitor's warning window.
      const tlsExpires = result.tlsExpiresAt ?? r.tls_expires_at;
      const warnDays =
        r.type === 'http' && typeof r.config.tlsWarnDays === 'number' ? r.config.tlsWarnDays : 0;
      const tlsWarn =
        result.tlsExpiresAt !== null &&
        warnDays > 0 &&
        result.tlsExpiresAt.getTime() - now.getTime() <= warnDays * DAY &&
        r.tls_warned_expiry?.getTime() !== result.tlsExpiresAt.getTime();
      await tx.query(
        `UPDATE uptime_monitors SET status = $2, consecutive_failures = $3, transitions = $4, flapping = $5,
                notified_status = $6, last_check_at = $7, last_ok = $8, last_latency_ms = $9, last_status_code = $10,
                last_error = $11, last_detail = $12, tls_expires_at = $13,
                tls_warned_expiry = CASE WHEN $14 THEN $13 ELSE tls_warned_expiry END,
                status_changed_at = CASE WHEN $15 THEN $7 ELSE status_changed_at END,
                next_check_at = $16
          WHERE id = $1`,
        [
          id,
          step.state.status,
          step.state.consecutiveFailures,
          step.state.transitions,
          step.state.flapping,
          step.state.notifiedStatus,
          now,
          result.ok,
          result.latencyMs,
          result.statusCode,
          result.error,
          detail === null ? null : detail.slice(0, 200),
          tlsExpires,
          tlsWarn,
          step.changed !== null || r.status === 'pending',
          new Date(now.getTime() + step.nextInSec * 1000),
        ],
      );
      const events: ('down' | 'up' | 'flapping' | 'tls')[] = [];
      if (step.notice !== null) events.push(step.notice);
      if (tlsWarn) events.push('tls');
      for (const event of events) {
        await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)', [
          OUTBOX_TOPIC_MONITOR,
          JSON.stringify(
            MonitorOutboxPayload.parse({
              monitorId: id,
              event,
              incidentId: event === 'flapping' || event === 'tls' ? null : incidentId,
              checkId,
            }),
          ),
          now,
        ]);
      }
      return true;
    });
  }

  /** "Check now": runs the check at once and records it (at most one per monitor every 10 s). */
  async checkNow(actor: UptimeActor, id: string): Promise<MonitorView> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM uptime_monitors m WHERE m.id = $1`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) throw notFound();
    const now = this.#now();
    if (r.last_check_at !== null && now.getTime() - r.last_check_at.getTime() < 10_000) {
      throw new UptimeError(429, 'rate_limited', 'Checked a moment ago; try again in a few seconds.', {
        'retry-after': '10',
      });
    }
    const result = await this.#check(r.type, r.config, r.timeout_ms, r.project);
    await this.#record(id, r.updated_at, result);
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'uptime.monitor.check',
      target: `uptime-monitor:${id}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { project: r.project, ok: result.ok, error: result.error },
    });
    return this.get(id);
  }

  // ------------------------------------------------------------------------------------------- scheduler

  /** The orchestrator tick step: claim due monitors and start their checks (not awaited), prune, auto-monitor. */
  async tick(): Promise<number> {
    const now = this.#now();
    const free = this.#limits.concurrency - this.#inflight.size;
    let started = 0;
    if (free > 0) {
      const { rows } = await this.deps.pool.query<{
        id: string;
        project: string;
        type: MonitorType;
        config: Record<string, unknown>;
        timeout_ms: number;
        updated_at: Date;
      }>(
        `WITH due AS (
           SELECT id FROM uptime_monitors WHERE NOT paused AND next_check_at <= $1
            ORDER BY next_check_at LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE uptime_monitors m SET next_check_at = $1::timestamptz + make_interval(secs => m.interval_sec)
           FROM due WHERE m.id = due.id
         RETURNING m.id::text AS id, m.project, m.type, m.config, m.timeout_ms, m.updated_at`,
        [now, free],
      );
      for (const r of rows) {
        if (this.#inflight.has(r.id)) continue;
        const p = this.#check(r.type, r.config, r.timeout_ms, r.project)
          .then((result) => this.#record(r.id, r.updated_at, result))
          .then(() => undefined)
          .catch((err: unknown) => {
            this.deps.log.error({ err, monitorId: r.id }, 'uptime check could not be recorded');
          })
          .finally(() => {
            this.#inflight.delete(r.id);
          });
        this.#inflight.set(r.id, p);
        started++;
      }
    }
    if (now.getTime() - this.#lastAuto >= AUTO_EVERY_MS) {
      this.#lastAuto = now.getTime();
      await this.autoMonitor().catch((err: unknown) => {
        this.deps.log.warn({ err }, 'uptime auto-monitor pass failed');
      });
    }
    if (now.getTime() - this.#lastPrune >= PRUNE_EVERY_MS) {
      this.#lastPrune = now.getTime();
      await this.prune().catch((err: unknown) => {
        this.deps.log.warn({ err }, 'uptime prune failed');
      });
    }
    return started;
  }

  /** Waits for the checks started by earlier ticks (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.all([...this.#inflight.values()]);
  }

  /**
   * Checks older than 7 days (p22-ops-hygiene; in batches of 5 000, at most 40 per pass — the rest on the next hourly
   * pass), rollups older than 90 days, closed incidents older than 90 days.
   */
  async prune(): Promise<{ checks: number; rollups: number; incidents: number }> {
    const now = this.#now().getTime();
    const before = new Date(now - LIMITS.checkRetentionDays * DAY);
    let checks = 0;
    for (let i = 0; i < LIMITS.pruneMaxBatches; i++) {
      const r = await this.deps.pool.query(
        `DELETE FROM uptime_checks WHERE id IN (SELECT id FROM uptime_checks WHERE at < $1 ORDER BY at LIMIT $2)`,
        [before, LIMITS.pruneBatch],
      );
      checks += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < LIMITS.pruneBatch) break;
    }
    const rollups = await this.deps.pool.query('DELETE FROM uptime_rollups WHERE hour < $1', [
      new Date(now - LIMITS.rollupRetentionDays * DAY),
    ]);
    const incidents = await this.deps.pool.query(
      'DELETE FROM uptime_incidents WHERE ended_at IS NOT NULL AND ended_at < $1',
      [new Date(now - LIMITS.rollupRetentionDays * DAY)],
    );
    return {
      checks,
      rollups: rollups.rowCount ?? 0,
      incidents: incidents.rowCount ?? 0,
    };
  }

  /**
   * Opt-in "auto-monitor deployed sites": every site of the project deployed after the setting's cursor gets the
   * "Monitor this" set (system actor, audited). The cursor moves past what was considered, so a monitor people
   * deleted is not re-created until that site is deployed again.
   */
  async autoMonitor(): Promise<number> {
    const outputs = this.deps.outputs();
    if (outputs === null) return 0;
    const { rows } = await this.deps.pool.query<{ project: string; auto_since: Date | null }>(
      'SELECT project, auto_since FROM uptime_settings WHERE auto_monitor',
    );
    let created = 0;
    for (const s of rows) {
      const since = s.auto_since ?? this.#now();
      const { items } = await outputs.list(null, {
        project: s.project,
        type: 'site',
        from: since,
        limit: 50,
      });
      let cursor = since;
      for (const item of items) {
        const deployed = new Date(item.site?.deployedAt ?? item.createdAt);
        if (deployed.getTime() <= since.getTime()) continue;
        if (deployed.getTime() > cursor.getTime()) cursor = deployed;
        try {
          const out = await this.createFromOutput({ type: 'system', id: 'uptime-auto' }, s.project, item.key);
          created += out.created.length;
        } catch (err) {
          if (!(err instanceof UptimeError)) throw err;
          this.deps.log.info({ project: s.project, code: err.code }, 'uptime auto-monitor skipped a site');
        }
      }
      if (cursor.getTime() > since.getTime()) {
        await this.deps.pool.query(
          'UPDATE uptime_settings SET auto_since = $2 WHERE project = $1 AND auto_monitor',
          [s.project, cursor],
        );
      }
    }
    return created;
  }

  /** Status of a monitor for chat watches (null: gone). */
  async watchState(
    id: string,
  ): Promise<{ project: string; name: string; down: boolean; flapping: boolean } | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.deps.pool.query<{
      project: string;
      name: string;
      status: string;
      paused: boolean;
      flapping: boolean;
    }>('SELECT project, name, status, paused, flapping FROM uptime_monitors WHERE id = $1', [id]);
    const r = rows[0];
    return r === undefined
      ? null
      : { project: r.project, name: r.name, down: r.status === 'down' && !r.paused, flapping: r.flapping };
  }
}

/** What a monitor points at, for audit and duplicate detection (no secrets exist in a config). */
export function targetSummary(type: MonitorType, config: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case 'http':
      return { url: config.url, method: config.method };
    case 'tcp':
      return { host: config.host, port: config.port };
    case 'pages':
      return { project: config.project, env: config.env };
    case 'coolify':
      return { uuid: config.uuid };
  }
}
