import { statfs } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { MetricHistory, RecentTraces } from '@remyral/observability/telemetry';
import type { Pool } from '../db/pool.js';
import type { RedisClient } from '../redis.js';
import type { LogStore } from './logs.js';

/**
 * p16-observability (docs/design/p16-observability.md §2): Ayarlar → Sistem durumu. One read-only snapshot of what the
 * control plane is doing, assembled from the sources the master already has — no new agent on the host:
 *
 * | part | source |
 * |---|---|
 * | master | this process (uptime, memory, event-loop delay), release tag (REMYRAL_RELEASE_TAG) |
 * | web | HTTP probe of STATUS_WEB_URL (the web container over the proxy network) |
 * | postgres / redis | `SELECT 1` / `PING` (2 s), database size and connections, Redis memory |
 * | backup | the backup service's status files (BackupStatusService health) |
 * | queue | jobs by state, the oldest QUEUED job, active leases, pending approvals |
 * | workers | the fleet: online / offline, last heartbeat, version |
 * | version feed | `tool_version_feed` rows (last check, failures) |
 * | integrations | Coolify / Cloudflare last connection test, GitHub App key and permissions |
 * | errors (1 h) | the process's own metrics via {@link MetricHistory} (HTTP 5xx, DB errors, job failures, lease
 *   expiries, failed steps, worker message errors, failed chat turns) and error log lines (log store) |
 * | disk | statfs of the host data volume (the backup status mount) and of the container root (Docker's disk) |
 *
 * Every part is computed independently with a timeout: a failing source shows as `unknown` / failing with a code,
 * never fails the whole page. Cached 10 s, single-flight. Nothing secret: identifiers, numbers, states and closed codes.
 */

export type ComponentState = 'ok' | 'warning' | 'failing' | 'unknown' | 'not_configured';

export interface ComponentStatus {
  readonly id: 'master' | 'web' | 'postgres' | 'redis' | 'backup';
  readonly state: ComponentState;
  /** A closed code saying why (e.g. `timeout`, `http_503`, `unreachable`). */
  readonly code: string | null;
  readonly latencyMs: number | null;
}

export interface WorkerLine {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly connected: boolean;
  readonly lastSeenAt: string | null;
  readonly workerVersion: string;
  readonly runningJobs: number;
}

export interface DiskLine {
  readonly id: 'data' | 'root';
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly usedPercent: number;
  readonly state: ComponentState;
}

export interface ErrorRates {
  /** Minutes the numbers cover (≤ 60; less right after a restart). */
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
}

export interface SystemStatus {
  readonly checkedAt: string;
  readonly overall: 'ok' | 'warning' | 'failing';
  /** Short closed codes of what is not ok (e.g. `postgres`, `disk_data`, `queue_backlog`). */
  readonly problems: readonly string[];
  readonly components: readonly ComponentStatus[];
  readonly master: {
    readonly releaseTag: string | null;
    readonly startedAt: string;
    readonly uptimeSec: number;
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly eventLoopDelayMs: number | null;
    readonly node: string;
  };
  readonly workerRelease: readonly { channel: string; version: string; rolloutPercent: number }[];
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
    readonly list: readonly WorkerLine[];
  } | null;
  readonly versionFeed: {
    readonly enabled: boolean;
    readonly items: number;
    readonly failing: number;
    readonly lastCheckedAt: string | null;
    readonly errors: readonly { item: string; error: string }[];
  } | null;
  readonly integrations: {
    readonly coolify: readonly {
      id: string;
      label: string;
      usable: boolean;
      lastTestAt: string | null;
      lastTestOk: boolean | null;
    }[];
    readonly cloudflare: { usable: boolean; lastTestAt: string | null; lastTestOk: boolean | null } | null;
    readonly github: { connected: boolean; keyUsable: boolean | null; missingPermissions: number } | null;
  } | null;
  readonly errors: (ErrorRates & { readonly errorLogLines: number | null }) | null;
  readonly disk: readonly DiskLine[];
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

/** Structural views of the services the status reads (kept narrow for tests). */
export interface StatusSources {
  readonly backups?: () => { overview(): Promise<{ health: { state: string } }> } | null;
  readonly fleet?: () => {
    list(): Promise<
      readonly {
        id: string;
        name: string;
        state: string;
        connected: boolean;
        lastSeenAt: string | null;
        workerVersion: string;
        runningJobs: number;
      }[]
    >;
  } | null;
  readonly integrations?: () => {
    status(): Promise<{
      coolifyConnections: readonly {
        id: string;
        label: string;
        usable: boolean;
        lastTestAt: string | null;
        lastTest: Record<string, unknown> | null;
      }[];
      cloudflare: {
        usable: boolean;
        lastTestAt: string | null;
        lastTest: Record<string, unknown> | null;
      } | null;
    }>;
  } | null;
  readonly github?: () => {
    status(): Promise<{ app: { keyUsable: boolean; missingPermissions: readonly string[] } | null }>;
  } | null;
  readonly feedEnabled?: () => boolean;
}

export interface SystemStatusDeps extends StatusSources {
  readonly pool: Pool;
  readonly redis: Pick<RedisClient, 'ping' | 'info'>;
  readonly clock?: () => Date;
  readonly releaseTag?: string | null;
  /** The web container's URL to probe (null: unknown). */
  readonly webUrl?: string | null;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Paths whose file system is the host data volume / the container root (statfs). */
  readonly diskPaths?: { readonly data: string | null; readonly root: string | null };
  readonly history?: MetricHistory | null;
  readonly traces?: RecentTraces | null;
  readonly tracing?: { readonly enabled: boolean; readonly exporting: boolean };
  readonly logs?: LogStore | null;
  readonly cacheMs?: number;
  readonly probeTimeoutMs?: number;
  /** Thresholds: queue backlog warning (default 300 s), disk warning / failing (default 85 / 95 %). */
  readonly thresholds?: {
    readonly queueSec?: number;
    readonly diskWarn?: number;
    readonly diskFail?: number;
  };
}

const STARTED_AT = new Date();

class Timeout extends Error {}

async function timed<T>(p: () => Promise<T>, ms: number): Promise<{ v: T; ms: number }> {
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const v = await Promise.race([
      p(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Timeout());
        }, ms);
      }),
    ]);
    return { v, ms: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timer);
  }
}

const settle = async <T>(p: () => Promise<T>): Promise<T | null> => {
  try {
    return await p();
  } catch {
    return null;
  }
};

const codeOf = (err: unknown): string => (err instanceof Timeout ? 'timeout' : 'unreachable');
const okOf = (t: Record<string, unknown> | null): boolean | null =>
  t === null ? null : typeof t.ok === 'boolean' ? t.ok : null;

export class SystemStatusService {
  readonly #d: SystemStatusDeps;
  readonly #now: () => Date;
  readonly #loop = monitorEventLoopDelay({ resolution: 20 });
  #cached: SystemStatus | null = null;
  #cachedAt = 0;
  #inflight: Promise<SystemStatus> | null = null;

  constructor(d: SystemStatusDeps) {
    this.#d = d;
    this.#now = d.clock ?? (() => new Date());
    this.#loop.enable();
  }

  stop(): void {
    this.#loop.disable();
  }

  async snapshot(): Promise<SystemStatus> {
    const cacheMs = this.#d.cacheMs ?? 10_000;
    if (this.#cached !== null && Date.now() - this.#cachedAt < cacheMs) return this.#cached;
    this.#inflight ??= this.#read().finally(() => {
      this.#inflight = null;
    });
    const s = await this.#inflight;
    this.#cached = s;
    this.#cachedAt = Date.now();
    return s;
  }

  async #read(): Promise<SystemStatus> {
    const ms = this.#d.probeTimeoutMs ?? 2_000;
    const [pg, rd, web, backup, queue, workers, feed, integrations, errors, disk, db, redisInfo, release] =
      await Promise.all([
        this.#probe('postgres', () => this.#d.pool.query('SELECT 1').then(() => undefined), ms),
        this.#probe('redis', () => this.#d.redis.ping().then(() => undefined), ms),
        this.#web(ms),
        this.#backup(ms),
        settle(() => this.#queue()),
        settle(() => this.#workers()),
        settle(() => this.#feed()),
        settle(() => this.#integrations()),
        settle(() => this.#errors()),
        this.#disk(),
        settle(() => this.#database()),
        settle(() => this.#redisInfo()),
        settle(() => this.#release()),
      ]);
    const mem = process.memoryUsage();
    const p99 = this.#loop.percentile(99);
    const master: ComponentStatus = {
      id: 'master',
      state: p99 > 1e9 ? 'warning' : 'ok',
      code: p99 > 1e9 ? 'event_loop_delay' : null,
      latencyMs: null,
    };
    const components = [master, web, pg, rd, backup];
    const problems: string[] = [];
    for (const c of components) if (c.state === 'failing' || c.state === 'warning') problems.push(c.id);
    for (const d of disk) if (d.state === 'failing' || d.state === 'warning') problems.push(`disk_${d.id}`);
    const queueSec = this.#d.thresholds?.queueSec ?? 300;
    if (queue !== null && queue.oldestQueuedSec >= queueSec) problems.push('queue_backlog');
    if (workers !== null && workers.offline > 0) problems.push('workers_offline');
    if (feed !== null && feed.enabled && feed.failing > 0) problems.push('version_feed');
    if (integrations !== null) {
      if (integrations.coolify.some((c) => !c.usable || c.lastTestOk === false)) problems.push('coolify');
      if (
        integrations.cloudflare !== null &&
        (!integrations.cloudflare.usable || integrations.cloudflare.lastTestOk === false)
      )
        problems.push('cloudflare');
      if (integrations.github?.keyUsable === false || (integrations.github?.missingPermissions ?? 0) > 0)
        problems.push('github');
    }
    if (errors !== null && errors.http5xx > 0) problems.push('http_errors');
    const failing =
      components.some((c) => c.state === 'failing' && c.id !== 'backup') ||
      disk.some((d) => d.state === 'failing');
    const overall: SystemStatus['overall'] = failing ? 'failing' : problems.length > 0 ? 'warning' : 'ok';
    const traceStats = this.#d.traces?.stats();
    const logStats = this.#d.logs?.stats();
    return {
      checkedAt: this.#now().toISOString(),
      overall,
      problems,
      components,
      master: {
        releaseTag: this.#d.releaseTag ?? null,
        startedAt: STARTED_AT.toISOString(),
        uptimeSec: Math.round(process.uptime()),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        eventLoopDelayMs: Number.isFinite(p99) && p99 > 0 ? Math.round(p99 / 1e4) / 100 : null,
        node: process.version,
      },
      workerRelease: release ?? [],
      queue,
      workers,
      versionFeed: feed,
      integrations,
      errors,
      disk,
      database: db,
      redis: redisInfo,
      tracing: {
        enabled: this.#d.tracing?.enabled ?? false,
        exporting: this.#d.tracing?.exporting ?? false,
        slow: traceStats?.slow ?? 0,
        errors: traceStats?.errors ?? 0,
      },
      logs: {
        enabled: this.#d.logs?.enabled ?? false,
        retentionDays: this.#d.logs?.config.retentionDays ?? 0,
        dropped: logStats?.dropped ?? 0,
        lastError: logStats?.lastError?.at ?? null,
      },
    };
  }

  async #probe(id: 'postgres' | 'redis', check: () => Promise<void>, ms: number): Promise<ComponentStatus> {
    try {
      const r = await timed(check, ms);
      return {
        id,
        state: r.ms > ms / 2 ? 'warning' : 'ok',
        code: r.ms > ms / 2 ? 'slow' : null,
        latencyMs: r.ms,
      };
    } catch (err) {
      return { id, state: 'failing', code: codeOf(err), latencyMs: null };
    }
  }

  async #web(ms: number): Promise<ComponentStatus> {
    const url = this.#d.webUrl ?? null;
    if (url === null) return { id: 'web', state: 'unknown', code: 'not_probed', latencyMs: null };
    const f = this.#d.fetch ?? ((u: string, init: RequestInit) => fetch(u, init));
    try {
      const r = await timed(
        () => f(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(ms) }),
        ms + 100,
      );
      await r.v.body?.cancel().catch(() => undefined);
      if (r.v.status >= 200 && r.v.status < 400)
        return { id: 'web', state: 'ok', code: null, latencyMs: r.ms };
      return { id: 'web', state: 'failing', code: `http_${String(r.v.status)}`, latencyMs: r.ms };
    } catch (err) {
      return {
        id: 'web',
        state: 'failing',
        code: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : codeOf(err),
        latencyMs: null,
      };
    }
  }

  async #backup(ms: number): Promise<ComponentStatus> {
    const svc = this.#d.backups?.() ?? null;
    if (svc === null) return { id: 'backup', state: 'not_configured', code: null, latencyMs: null };
    try {
      const r = await timed(() => svc.overview(), ms);
      const s = r.v.health.state;
      const state: ComponentState =
        s === 'ok' ? 'ok' : s === 'warning' ? 'warning' : s === 'failing' ? 'failing' : 'not_configured';
      return {
        id: 'backup',
        state,
        code: state === 'ok' || state === 'not_configured' ? null : s,
        latencyMs: r.ms,
      };
    } catch (err) {
      return { id: 'backup', state: 'unknown', code: codeOf(err), latencyMs: null };
    }
  }

  async #queue(): Promise<NonNullable<SystemStatus['queue']>> {
    const db = this.#d.pool;
    const at = this.#now();
    const [jobs, oldest, leases, approvals] = await Promise.all([
      db.query<{ state: string; n: number }>(
        "SELECT state::text AS state, count(*)::int AS n FROM jobs WHERE state IN ('QUEUED', 'RESERVED', 'RUNNING', 'VERIFYING') GROUP BY state",
      ),
      db.query<{ id: string; since: Date }>(
        "SELECT id, state_changed_at AS since FROM jobs WHERE state = 'QUEUED' ORDER BY state_changed_at, id LIMIT 1",
      ),
      db.query<{ n: number }>('SELECT count(*)::int AS n FROM leases WHERE released_at IS NULL'),
      db.query<{ n: number }>("SELECT count(*)::int AS n FROM approval_requests WHERE status = 'pending'"),
    ]);
    const n = (s: string): number => jobs.rows.find((r) => r.state === s)?.n ?? 0;
    const o = oldest.rows[0];
    return {
      queued: n('QUEUED'),
      running: n('RESERVED') + n('RUNNING') + n('VERIFYING'),
      oldestQueuedSec:
        o === undefined ? 0 : Math.max(0, Math.round((at.getTime() - o.since.getTime()) / 1000)),
      oldestQueuedJobId: o?.id ?? null,
      activeLeases: leases.rows[0]?.n ?? 0,
      approvalsPending: approvals.rows[0]?.n ?? 0,
    };
  }

  async #workers(): Promise<SystemStatus['workers']> {
    const fleet = this.#d.fleet?.() ?? null;
    if (fleet === null) return null;
    const all = await fleet.list();
    // Quarantined machines (refused, revoked) are out of the fleet; archived ones are not listed by FleetService.
    const active = all.filter((w) => w.state !== 'quarantined');
    const pending = active.filter((w) => w.state === 'pending').length;
    const paired = active.filter((w) => w.state !== 'pending');
    return {
      online: paired.filter((w) => w.connected).length,
      offline: paired.filter((w) => !w.connected).length,
      pending,
      list: paired.slice(0, 50).map((w) => ({
        id: w.id,
        name: w.name,
        state: w.state,
        connected: w.connected,
        lastSeenAt: w.lastSeenAt,
        workerVersion: w.workerVersion,
        runningJobs: w.runningJobs,
      })),
    };
  }

  async #feed(): Promise<NonNullable<SystemStatus['versionFeed']>> {
    const { rows } = await this.#d.pool.query<{
      item: string;
      ok: boolean;
      error: string | null;
      checked_at: Date;
    }>('SELECT item, ok, error, checked_at FROM tool_version_feed ORDER BY item');
    const failed = rows.filter((r) => !r.ok);
    const last = rows.reduce<Date | null>(
      (a, r) => (a === null || r.checked_at > a ? r.checked_at : a),
      null,
    );
    return {
      enabled: this.#d.feedEnabled?.() ?? true,
      items: rows.length,
      failing: failed.length,
      lastCheckedAt: last?.toISOString() ?? null,
      errors: failed.slice(0, 10).map((r) => ({ item: r.item, error: (r.error ?? 'failed').slice(0, 200) })),
    };
  }

  async #integrations(): Promise<SystemStatus['integrations']> {
    const ops = this.#d.integrations?.() ?? null;
    const gh = this.#d.github?.() ?? null;
    if (ops === null && gh === null) return null;
    const [o, g] = await Promise.all([
      ops === null ? null : settle(() => ops.status()),
      gh === null ? null : settle(() => gh.status()),
    ]);
    return {
      coolify: (o?.coolifyConnections ?? []).map((c) => ({
        id: c.id,
        label: c.label,
        usable: c.usable,
        lastTestAt: c.lastTestAt,
        lastTestOk: okOf(c.lastTest),
      })),
      cloudflare:
        o?.cloudflare == null
          ? null
          : {
              usable: o.cloudflare.usable,
              lastTestAt: o.cloudflare.lastTestAt,
              lastTestOk: okOf(o.cloudflare.lastTest),
            },
      github:
        g === null
          ? null
          : {
              connected: g.app !== null,
              keyUsable: g.app?.keyUsable ?? null,
              missingPermissions: g.app?.missingPermissions.length ?? 0,
            },
    };
  }

  async #errors(): Promise<SystemStatus['errors']> {
    const h = this.#d.history ?? null;
    const errorLogLines = await settle(() => this.#d.logs?.errorCount() ?? Promise.resolve(null));
    if (h === null) return null;
    const d = (name: string, f?: (a: Record<string, unknown>) => boolean): number => h.delta(name, f) ?? 0;
    // Fewer than two samples (the first minute after a start): nothing to compare yet.
    if (h.delta('remyral_http_server_duration_seconds') === null) return null;
    return {
      windowMinutes: Math.min(60, Math.max(1, h.coverageMinutes())),
      httpRequests: d('remyral_http_server_duration_seconds'),
      http5xx: d('remyral_http_server_duration_seconds', (a) => a.status_class === '5xx'),
      dbErrors: d('remyral_db_query_errors'),
      jobFailures: d('remyral_job_failures'),
      leaseExpiries: d('remyral_lease_expiries'),
      stepFailures: d('remyral_orchestrator_step_failures'),
      workerMessageErrors: d('remyral_worker_messages', (a) => a.result === 'error'),
      chatTurns: d('remyral_chat_turns'),
      chatTurnsFailed: d('remyral_chat_turns', (a) => a.outcome === 'failed'),
      errorLogLines,
    };
  }

  async #disk(): Promise<DiskLine[]> {
    const paths = this.#d.diskPaths ?? { data: null, root: null };
    const warn = this.#d.thresholds?.diskWarn ?? 85;
    const fail = this.#d.thresholds?.diskFail ?? 95;
    const out: DiskLine[] = [];
    for (const [id, path] of [
      ['data', paths.data],
      ['root', paths.root],
    ] as const) {
      if (path === null) continue;
      const s = await settle(() => statfs(path));
      if (s === null) continue;
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      if (total <= 0) continue;
      const used = Math.round(((total - free) / total) * 1000) / 10;
      out.push({
        id,
        totalBytes: total,
        freeBytes: free,
        usedPercent: used,
        state: used >= fail ? 'failing' : used >= warn ? 'warning' : 'ok',
      });
    }
    return out;
  }

  async #database(): Promise<SystemStatus['database']> {
    const { rows } = await this.#d.pool.query<{ size: string; conns: number }>(
      `SELECT pg_database_size(current_database())::text AS size,
              (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS conns`,
    );
    const r = rows[0];
    return r === undefined ? null : { sizeBytes: Number(r.size), connections: r.conns };
  }

  async #redisInfo(): Promise<SystemStatus['redis']> {
    const text = await timed(() => this.#d.redis.info('memory'), this.#d.probeTimeoutMs ?? 2_000);
    const num = (k: string): number | null => {
      const m = new RegExp(`^${k}:(\\d+)`, 'm').exec(text.v);
      return m?.[1] === undefined ? null : Number(m[1]);
    };
    const used = num('used_memory');
    if (used === null) return null;
    const max = num('maxmemory');
    return { usedMemoryBytes: used, maxMemoryBytes: max === null || max === 0 ? null : max };
  }

  async #release(): Promise<SystemStatus['workerRelease']> {
    const { rows } = await this.#d.pool.query<{ channel: string; version: string; rollout_percent: number }>(
      'SELECT channel, version, rollout_percent FROM worker_release_channels ORDER BY channel',
    );
    return rows.map((r) => ({ channel: r.channel, version: r.version, rolloutPercent: r.rollout_percent }));
  }
}
