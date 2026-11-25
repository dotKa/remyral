import { type OpsOperation, USAGE_REFRESH_FEATURE } from '@remyral/protocol';
import type { RateLimiter } from '../auth/rate-limit.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from '../workers/fleet.js';

/**
 * p15-usage-refresh (docs/design/p15-usage-refresh.md §4): "Şimdi kontrol et" / "Tümünü yenile" / the chat's
 * "limitleri kontrol et" — one signed `usage.refresh` remote operation per affected connected machine; the worker
 * probes its subscription logins now (read-only, no model request) and answers with the fresh snapshots, which the
 * remote-ops service stores before the operation is shown as finished. Nothing else changes on the machine.
 */

export interface UsageRefreshTarget {
  /** One machine (all its logins, or one runtime / account of it). */
  readonly workerId?: string;
  readonly runtime?: 'claude-code' | 'codex';
  readonly account?: string;
  /** One provider account: every machine it is logged in on (needs `runtime`). */
  readonly identity?: string;
}

export interface UsageRefreshOp {
  readonly workerId: string;
  readonly workerName: string;
  readonly opId: string;
}

export interface UsageRefreshSkip {
  readonly workerId: string;
  readonly workerName: string;
  /** `worker_offline`, `worker_update_required`, `rate_limited`, or the remote-ops refusal code. */
  readonly reason: string;
}

export interface UsageRefreshStart {
  readonly ops: UsageRefreshOp[];
  readonly skipped: UsageRefreshSkip[];
}

export interface UsageRefreshOpState {
  readonly opId: string;
  readonly workerId: string;
  /** `sent` / `accepted` / `running` until done; `succeeded` / `failed` / `refused` / `cancelled` / `lost` at the end. */
  readonly state: string;
  readonly done: boolean;
  readonly reason: string | null;
  /** Per-login outcomes (when done). */
  readonly results: { runtime: string; account: string; outcome: string }[];
}

export interface UsageRefreshPorts {
  readonly pool: Pool;
  readonly clock: () => Date;
  readonly limiter?: RateLimiter;
  /** The remote-ops service (sends the signed command; its own per-machine / per-user limits apply). */
  readonly ops: () => {
    request(workerId: string, op: OpsOperation, actor: ActorContext): Promise<{ id: string }>;
  } | null;
}

/** Per user: refresh requests per minute (each may start one op per machine). */
const PER_USER_PER_MINUTE = 6;
const CONNECTED: ReadonlySet<string> = new Set(['online', 'busy', 'draining', 'updating']);
const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'refused', 'cancelled', 'lost']);
/** An op without news for this long is shown as lost (the worker probes ≤ 60 s per login). */
const LOST_AFTER_MS = 5 * 60_000;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

interface WorkerRow {
  id: string;
  display_name: string;
  state: string;
  features: unknown;
  local_projects: unknown;
  local_login: unknown;
  runtime_accounts: unknown;
}

export class UsageRefreshService {
  constructor(private readonly deps: UsageRefreshPorts) {}

  /**
   * Starts the refresh. `projects`: the caller's visible projects (null = all): only machines that can run one of them
   * (or take every project) are refreshed.
   */
  async start(
    target: UsageRefreshTarget,
    actor: ActorContext,
    projects: readonly string[] | null,
  ): Promise<UsageRefreshStart> {
    const ops = this.deps.ops();
    if (ops === null)
      throw new HttpError(
        503,
        'unavailable',
        'Remote operations are not available.',
        {},
        {},
        { reason: 'remote_ops' },
      );
    if (this.deps.limiter !== undefined) {
      const r = await this.deps.limiter.hit('usage-refresh-user', actor.userId, PER_USER_PER_MINUTE, 60_000);
      if (!r.allowed) {
        throw new HttpError(
          429,
          'rate_limited',
          'Too many limit refreshes; try again in a minute.',
          {},
          {},
          {
            reason: 'usage_refresh',
          },
        );
      }
    }
    if (target.identity !== undefined && target.runtime === undefined) {
      throw new HttpError(
        400,
        'invalid_request',
        'An account refresh needs its runtime.',
        {},
        {},
        {
          reason: 'usage_refresh_runtime',
        },
      );
    }
    const { rows } = await this.deps.pool.query<WorkerRow>(
      `SELECT id, COALESCE(display_name, id) AS display_name, state, features, local_projects, local_login,
              runtime_accounts
         FROM workers WHERE archived_at IS NULL AND state NOT IN ('pending', 'quarantined')
        ORDER BY display_name, id`,
    );
    const visible = rows.filter((w) => {
      if (projects === null || w.local_projects === null) return true;
      const allow = strings(w.local_projects);
      return projects.some((p) => allow.includes(p));
    });
    // Which machines (and which of their logins) to read.
    const plan = new Map<string, { runtime?: 'claude-code' | 'codex'; account?: string }>();
    if (target.identity !== undefined) {
      const { rows: logins } = await this.deps.pool.query<{ worker_id: string; account: string }>(
        `SELECT worker_id, account FROM runtime_usage_snapshots
          WHERE runtime = $1 AND auth = 'subscription' AND identity_key = $2`,
        [target.runtime, target.identity],
      );
      const per = new Map<string, string[]>();
      for (const l of logins) per.set(l.worker_id, [...(per.get(l.worker_id) ?? []), l.account]);
      for (const [workerId, accounts] of per) {
        plan.set(workerId, {
          ...(target.runtime === undefined ? {} : { runtime: target.runtime }),
          ...(accounts.length === 1 && accounts[0] !== undefined ? { account: accounts[0] } : {}),
        });
      }
      if (plan.size === 0)
        throw new HttpError(
          404,
          'not_found',
          'No machine is known to use this account.',
          {},
          {},
          {
            reason: 'usage_account',
          },
        );
    } else if (target.workerId !== undefined) {
      plan.set(target.workerId, {
        ...(target.runtime === undefined ? {} : { runtime: target.runtime }),
        ...(target.account === undefined ? {} : { account: target.account }),
      });
    } else {
      // Every machine with a subscription login (configured or an added account).
      for (const w of visible) {
        const hasLogin =
          strings(((w.local_login ?? {}) as { runtimes?: unknown }).runtimes).length > 0 ||
          (Array.isArray(w.runtime_accounts) && w.runtime_accounts.length > 0);
        if (hasLogin) plan.set(w.id, target.runtime === undefined ? {} : { runtime: target.runtime });
      }
    }
    const byId = new Map(visible.map((w) => [w.id, w]));
    const out: UsageRefreshStart = { ops: [], skipped: [] };
    for (const [workerId, filter] of plan) {
      const w = byId.get(workerId);
      if (w === undefined) {
        // Not visible to the caller (or archived): never named.
        if (target.workerId !== undefined)
          throw new HttpError(404, 'not_found', 'Worker not found.', {}, {}, { reason: 'worker' });
        continue;
      }
      const skip = (reason: string): void => {
        out.skipped.push({ workerId: w.id, workerName: w.display_name, reason });
      };
      if (!CONNECTED.has(w.state)) {
        skip('worker_offline');
        continue;
      }
      if (!strings(w.features).includes(USAGE_REFRESH_FEATURE)) {
        skip('worker_update_required');
        continue;
      }
      try {
        const op = await ops.request(w.id, { kind: 'usage.refresh', ...filter }, actor);
        out.ops.push({ workerId: w.id, workerName: w.display_name, opId: op.id });
      } catch (err) {
        if (err instanceof HttpError) skip(err.code);
        else throw err;
      }
    }
    return out;
  }

  /** The state of refresh operations (only `usage.refresh` ones; unknown ids are left out). */
  async status(opIds: readonly string[]): Promise<UsageRefreshOpState[]> {
    const ids = opIds.filter((id) => /^[0-9a-f-]{36}$/.test(id)).slice(0, 64);
    if (ids.length === 0) return [];
    const { rows } = await this.deps.pool.query<{
      id: string;
      worker_id: string;
      state: string;
      reason: string | null;
      result: { usageRefresh?: { results?: unknown } } | null;
      updated_at: Date;
    }>(
      `SELECT id::text AS id, worker_id, state, reason, result, updated_at FROM worker_ops
        WHERE id = ANY($1::uuid[]) AND kind = 'usage.refresh'`,
      [ids],
    );
    const now = this.deps.clock().getTime();
    return rows.map((r) => {
      const lost = !TERMINAL.has(r.state) && now - r.updated_at.getTime() > LOST_AFTER_MS;
      const state = lost ? 'lost' : r.state;
      const results = Array.isArray(r.result?.usageRefresh?.results)
        ? (r.result.usageRefresh.results as unknown[]).flatMap((x) => {
            const o = x as { runtime?: unknown; account?: unknown; outcome?: unknown };
            return typeof o.runtime === 'string' &&
              typeof o.account === 'string' &&
              typeof o.outcome === 'string'
              ? [{ runtime: o.runtime, account: o.account, outcome: o.outcome }]
              : [];
          })
        : [];
      return {
        opId: r.id,
        workerId: r.worker_id,
        state,
        done: TERMINAL.has(state),
        reason: lost ? 'no_answer' : r.reason,
        results,
      };
    });
  }

  /** Starts a refresh and waits (bounded) until every op is done — for the chat. */
  async startAndWait(
    target: UsageRefreshTarget,
    actor: ActorContext,
    projects: readonly string[] | null,
    timeoutMs: number,
    pollMs = 500,
  ): Promise<UsageRefreshStart & { states: UsageRefreshOpState[]; timedOut: boolean }> {
    const started = await this.start(target, actor, projects);
    const until = Date.now() + timeoutMs;
    for (;;) {
      const states = await this.status(started.ops.map((o) => o.opId));
      const done = states.length === started.ops.length && states.every((s) => s.done);
      if (done || Date.now() >= until) return { ...started, states, timedOut: !done };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
