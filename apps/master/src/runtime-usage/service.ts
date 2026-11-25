import {
  DEFAULT_NEAR_THRESHOLD,
  dropExpiredWindows,
  MAX_REFRESH_SNAPSHOTS,
  RuntimeAccountReport,
  RuntimeUsageReport,
  RuntimeUsageSnapshot,
  type RuntimeUsageWindow,
  type UsageLevel,
  usageLevel,
  worseLevel,
} from '@remyral/protocol';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import type { UsageLimitEpisodeView } from '../usage-limits/service.js';
import { effectiveSnapshot, identityGroupKey, newestByIdentity, windowsOf } from './identity.js';

/**
 * p11-limit-visibility (docs/design/p11-limit-visibility.md §4): the master's view of the runtimes' usage-limit windows.
 *
 *  - **Store:** the latest snapshot per worker × runtime × auth (HEARTBEAT `runtimeUsage`), a 24-hour history per window
 *    (a point when the value changed or 10 minutes passed; ≤ 400 points per window), pruned by `tick`.
 *  - **Near-limit notice:** when a window crosses the workspace threshold (default 80 %) an outbox event is written; the
 *    notification is deduplicated per window and reset, so one notice per window and period.
 *  - **Overview:** per visible worker its subscription-login runtimes (CAPABILITIES.localLogin, also before any reading)
 *    and every reported snapshot, each window with its level (ok / near / limited) and reset, merged with the open
 *    usage-limit episodes of p11-usage-limit-fallback (a known hit makes the entry `limited` until its reset).
 *
 * p15-usage-refresh (docs/design/p15-usage-refresh.md §3): snapshots carry the login's provider account (`identity`);
 * logins of one account on several machines form one **group** — the newest reading wins, a limit hit on one machine
 * holds the account everywhere — and logins that no longer exist are flagged (`orphan`) and can be cleaned up.
 *
 * A compromised worker can only report its own runtimes' numbers (bounded, schema-checked); nothing here pauses or
 * places work — the scheduler keeps acting on real limit hits only.
 */

export const OUTBOX_TOPIC_RUNTIME_USAGE = 'runtime_usage';

export const RuntimeUsageOutboxPayload = z.object({
  workerId: z.string(),
  runtime: z.string(),
  auth: z.enum(['subscription', 'api_key']),
  windowId: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
  threshold: z.number(),
  /** p13-runtime-accounts: the runtime account (absent = `default`). */
  account: z.string().optional(),
  /** p15-usage-refresh: the provider account (one notice per account and window, whichever machine read it). */
  identity: z.string().optional(),
});
export type RuntimeUsageOutboxPayload = z.infer<typeof RuntimeUsageOutboxPayload>;

const HISTORY_MIN_GAP_MS = 10 * 60_000;
const HISTORY_KEEP_MS = 24 * 3600_000;
const HISTORY_MAX_POINTS = 400;
/** A reading older than this is shown as stale ("last seen … ago"). */
export const STALE_AFTER_MS = 30 * 60_000;
/** p15-usage-refresh: a configured login the worker no longer runs is an orphan once its reading is this old. */
const ORPHAN_DEFAULT_AFTER_MS = 24 * 3600_000;
/** p15-usage-refresh: orphan rows older than this are dropped by the tick. */
const ORPHAN_DROP_AFTER_MS = 7 * 24 * 3600_000;
/** p15-usage-refresh: machines that can take a remote op now. */
const CONNECTED: ReadonlySet<string> = new Set(['online', 'busy', 'draining', 'updating']);

export interface RuntimeUsageSettings {
  readonly nearThreshold: number;
  readonly notifyNear: boolean;
  readonly updatedAt: string | null;
}

export interface OverviewWindow extends RuntimeUsageWindow {
  readonly level: UsageLevel;
  readonly history?: { at: string; usedPercent: number }[];
}

export interface OverviewLimit {
  readonly episodeId: string;
  readonly kind: string | null;
  readonly model: string | null;
  readonly resetAt: string | null;
  readonly resumeAt: string;
}

export interface OverviewEntry {
  readonly workerId: string;
  readonly workerName: string;
  readonly workerState: string;
  readonly runtime: string;
  readonly auth: 'subscription' | 'api_key';
  /** p13-runtime-accounts: the runtime account (`default` = the machine's configured login / key). */
  readonly account: string;
  /** p13-runtime-accounts: the account's label (null for an unnamed `default`). */
  readonly accountLabel: string | null;
  readonly store: string | null;
  /** null: no reading yet. */
  readonly source: 'probe' | 'job' | 'assistant' | null;
  readonly plan: string | null;
  readonly available: boolean;
  readonly observedAt: string | null;
  readonly stale: boolean;
  /** The worker sends readings (feature `runtime-usage-v1`). */
  readonly reports: boolean;
  readonly level: UsageLevel;
  readonly windows: OverviewWindow[];
  /** An open usage-limit episode of this store (p11-usage-limit-fallback) — or of the same account elsewhere. */
  readonly limit: OverviewLimit | null;
  /** p15-usage-refresh: the provider account of this login (null: not known yet / older worker / API key). */
  readonly identity: { readonly key: string; readonly hint: string | null } | null;
  /** p15-usage-refresh: the windows come from this other machine's newer reading of the same account. */
  readonly readOn: { readonly workerId: string; readonly workerName: string } | null;
  /** p15-usage-refresh: the login no longer exists on the machine (a removed account); cleanable. */
  readonly orphan: boolean;
  /** p15-usage-refresh: the machine is connected and can read its usage windows on request (`usage-refresh-v1`). */
  readonly canRefresh: boolean;
}

/** p15-usage-refresh: one subscription account (its logins on every machine) or one login of unknown identity. */
export interface UsageGroup {
  /** `id:<runtime>:<identity>` or `login:<worker>|<runtime>|<auth>|<account>`. */
  readonly key: string;
  readonly runtime: string;
  readonly auth: 'subscription' | 'api_key';
  readonly identity: { readonly key: string; readonly hint: string | null } | null;
  /** The account labels of its logins (distinct, as the people named them). */
  readonly labels: string[];
  readonly source: 'probe' | 'job' | 'assistant' | null;
  readonly plan: string | null;
  readonly available: boolean;
  readonly observedAt: string | null;
  /** The machine of the newest reading. */
  readonly readOn: { readonly workerId: string; readonly workerName: string } | null;
  readonly stale: boolean;
  readonly reports: boolean;
  readonly level: UsageLevel;
  readonly windows: OverviewWindow[];
  readonly limit: OverviewLimit | null;
  /** Every login of the group is gone (cleanable). */
  readonly orphan: boolean;
  readonly canRefresh: boolean;
  /** The machines the account is used on ("kullanıldığı makineler"). */
  readonly machines: {
    readonly workerId: string;
    readonly workerName: string;
    readonly workerState: string;
    readonly account: string;
    readonly accountLabel: string | null;
    readonly observedAt: string | null;
    readonly orphan: boolean;
    readonly canRefresh: boolean;
  }[];
}

export interface RuntimeUsageOverview {
  readonly generatedAt: string;
  readonly settings: RuntimeUsageSettings;
  readonly entries: OverviewEntry[];
  /** p15-usage-refresh: the same logins, one row per provider account. */
  readonly groups: UsageGroup[];
  /** Open limits that belong to no listed store (API credentials, provider accounts, model-scoped). */
  readonly otherLimits: Omit<UsageLimitEpisodeView, 'message'>[];
}

interface SnapshotRow {
  worker_id: string;
  runtime: string;
  auth: 'subscription' | 'api_key';
  account: string;
  store: string | null;
  source: 'probe' | 'job' | 'assistant';
  plan: string | null;
  available: boolean;
  windows: unknown;
  observed_at: Date;
  identity_key: string | null;
  identity_hint: string | null;
}

interface WorkerRow {
  id: string;
  display_name: string;
  state: string;
  local_projects: unknown;
  local_login: unknown;
  features: unknown;
  runtime_accounts: unknown;
}

export interface RuntimeUsageServiceDeps {
  readonly pool: Pool;
  readonly clock: () => Date;
  readonly audit?: AuditRecorder;
  /** Open usage-limit episodes (p11-usage-limit-fallback); absent in narrow test wiring. */
  readonly episodes?: () => Promise<readonly UsageLimitEpisodeView[]>;
  /**
   * p19-limit-clear: a reading of a subscription login that is under all its limits ends that login's open
   * usage-limit episodes started before it (UsageLimitService.clearWithin). Absent in narrow test wiring.
   */
  readonly clearLimits?: (
    tx: Queryable,
    reading: {
      readonly workerId: string;
      readonly runtime: string;
      readonly account: string;
      readonly observedAt: Date;
    },
  ) => Promise<readonly string[]>;
  /** Called after a reading cleared limits (the waiting jobs are moved on). */
  readonly limitsCleared?: () => void;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

const ReportedAccounts = z.array(RuntimeAccountReport);

/** A login no longer on the machine (p15-usage-refresh §3): see {@link RuntimeUsageService.orphans}. */
function isOrphan(
  s: Pick<SnapshotRow, 'runtime' | 'auth' | 'account' | 'observed_at'>,
  w: Pick<WorkerRow, 'local_login' | 'runtime_accounts'>,
  named: ReadonlySet<string>,
  now: Date,
): boolean {
  const reported = ReportedAccounts.safeParse(w.runtime_accounts);
  const reportedIds = new Set(reported.success ? reported.data.map((a) => `${a.runtime}|${a.id}`) : []);
  if (reportedIds.has(`${s.runtime}|${s.account}`)) return false;
  if (s.account !== 'default') return !named.has(`${s.runtime}|${s.account}`);
  if (s.auth !== 'subscription') return false;
  const login = (w.local_login ?? {}) as { runtimes?: unknown };
  if (strings(login.runtimes).includes(s.runtime)) return false;
  return now.getTime() - s.observed_at.getTime() > ORPHAN_DEFAULT_AFTER_MS;
}

export class RuntimeUsageService {
  constructor(private readonly deps: RuntimeUsageServiceDeps) {}

  async settings(db: Queryable = this.deps.pool): Promise<RuntimeUsageSettings> {
    const { rows } = await db.query<{ near_threshold: number; notify_near: boolean; updated_at: Date }>(
      'SELECT near_threshold, notify_near, updated_at FROM runtime_usage_settings WHERE id = 1',
    );
    const r = rows[0];
    return r === undefined
      ? { nearThreshold: DEFAULT_NEAR_THRESHOLD, notifyNear: true, updatedAt: null }
      : { nearThreshold: r.near_threshold, notifyNear: r.notify_near, updatedAt: r.updated_at.toISOString() };
  }

  async saveSettings(
    input: { readonly nearThreshold: number; readonly notifyNear: boolean },
    actor: { readonly userId: string; readonly ip: string | null; readonly userAgent: string | null },
  ): Promise<RuntimeUsageSettings> {
    const now = this.deps.clock();
    return withTransaction(this.deps.pool, async (tx) => {
      const before = await this.settings(tx);
      await tx.query(
        `INSERT INTO runtime_usage_settings (id, near_threshold, notify_near, updated_by, updated_at)
         VALUES (1, $1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET near_threshold = EXCLUDED.near_threshold, notify_near = EXCLUDED.notify_near,
                                        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [input.nearThreshold, input.notifyNear, actor.userId, now],
      );
      await this.deps.audit?.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'runtime_usage.settings.update',
          target: 'runtime-usage:settings',
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: {
            before: { nearThreshold: before.nearThreshold, notifyNear: before.notifyNear },
            after: input,
          },
        },
        tx,
      );
      return { ...input, updatedAt: now.toISOString() };
    });
  }

  /** HEARTBEAT `runtimeUsage` of `workerId` (already schema-checked by the transport; checked again here). */
  async onReport(workerId: string, report: unknown): Promise<void> {
    const parsed = RuntimeUsageReport.safeParse(report);
    if (!parsed.success) return;
    await this.#storeAll(workerId, parsed.data);
  }

  /**
   * p15-usage-refresh: the snapshots of an OPS_UPDATE `usageRefresh` (every login of the machine at once, so more than
   * a heartbeat carries). Invalid ones are dropped one by one.
   */
  async onRefreshSnapshots(workerId: string, snapshots: readonly unknown[]): Promise<void> {
    const valid = snapshots.slice(0, MAX_REFRESH_SNAPSHOTS).flatMap((s) => {
      const p = RuntimeUsageSnapshot.safeParse(s);
      return p.success ? [p.data] : [];
    });
    await this.#storeAll(workerId, valid);
  }

  async #storeAll(workerId: string, snapshots: readonly RuntimeUsageSnapshot[]): Promise<void> {
    const now = this.deps.clock();
    const settings = await this.settings();
    for (const s of snapshots) await this.#store(workerId, s, now, settings);
  }

  async #store(
    workerId: string,
    s: RuntimeUsageSnapshot,
    now: Date,
    settings: RuntimeUsageSettings,
  ): Promise<void> {
    // A worker clock far ahead must not make its reading look fresh forever.
    const observed = new Date(Math.min(Date.parse(s.observedAt), now.getTime()));
    // p13-runtime-accounts: one snapshot per runtime × auth × account.
    const account = s.account ?? 'default';
    const identity = s.auth === 'subscription' ? s.identity : undefined;
    // p19-limit-clear: set inside the transaction when a reading ended a limit.
    const cleared = { any: false };
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows: prevRows } = await tx.query<{
        windows: unknown;
        observed_at: Date;
        identity_key: string | null;
      }>(
        `SELECT windows, observed_at, identity_key FROM runtime_usage_snapshots
          WHERE worker_id = $1 AND runtime = $2 AND auth = $3 AND account = $4 FOR UPDATE`,
        [workerId, s.runtime, s.auth, account],
      );
      const prev = prevRows[0];
      // Out-of-order heartbeat: an older reading never replaces a newer one.
      if (prev !== undefined && prev.observed_at.getTime() > observed.getTime()) return;
      // p15-usage-refresh: a reading without an identity (passive, older worker) keeps the stored one.
      await tx.query(
        `INSERT INTO runtime_usage_snapshots
           (worker_id, runtime, auth, store, source, plan, available, windows, observed_at, received_at, account,
            identity_key, identity_hint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (worker_id, runtime, auth, account) DO UPDATE SET store = EXCLUDED.store, source = EXCLUDED.source,
           plan = EXCLUDED.plan, available = EXCLUDED.available, windows = EXCLUDED.windows,
           observed_at = EXCLUDED.observed_at, received_at = EXCLUDED.received_at,
           identity_key = COALESCE(EXCLUDED.identity_key, runtime_usage_snapshots.identity_key),
           identity_hint = CASE WHEN EXCLUDED.identity_key IS NULL THEN runtime_usage_snapshots.identity_hint
                                ELSE EXCLUDED.identity_hint END`,
        [
          workerId,
          s.runtime,
          s.auth,
          s.store ?? null,
          s.source,
          s.plan ?? null,
          s.available ?? true,
          JSON.stringify(s.windows),
          observed,
          now,
          account,
          identity?.key ?? null,
          identity === undefined ? null : (identity.hint ?? null),
        ],
      );
      // p19-limit-clear: the provider says the login is under its limits again (reset early, plan raised).
      const read = s.windows.filter((w) => w.usedPercent !== null);
      if (
        this.deps.clearLimits !== undefined &&
        s.auth === 'subscription' &&
        s.available !== false &&
        read.length > 0 &&
        read.every((w) => (w.usedPercent ?? 100) < 100)
      ) {
        const ended = await this.deps.clearLimits(tx, {
          workerId,
          runtime: s.runtime,
          account,
          observedAt: observed,
        });
        if (ended.length > 0) cleared.any = true;
      }
      const identityKey = identity?.key ?? prev?.identity_key ?? null;
      const before = new Map(windowsOf(prev?.windows).map((w) => [w.id, w]));
      for (const w of s.windows) {
        if (w.usedPercent === null) continue;
        const { rows: last } = await tx.query<{ at: Date; used_percent: number }>(
          `SELECT at, used_percent FROM runtime_usage_history
            WHERE worker_id = $1 AND runtime = $2 AND auth = $3 AND window_id = $4 AND account = $5
            ORDER BY at DESC LIMIT 1`,
          [workerId, s.runtime, s.auth, w.id, account],
        );
        const l = last[0];
        if (
          l === undefined ||
          Math.abs(l.used_percent - w.usedPercent) >= 0.05 ||
          observed.getTime() - l.at.getTime() >= HISTORY_MIN_GAP_MS
        ) {
          await tx.query(
            `INSERT INTO runtime_usage_history (worker_id, runtime, auth, window_id, at, used_percent, account)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
            [workerId, s.runtime, s.auth, w.id, observed, w.usedPercent, account],
          );
          await tx.query(
            `DELETE FROM runtime_usage_history WHERE worker_id = $1 AND runtime = $2 AND auth = $3 AND window_id = $4
                AND account = $6
                AND at < (SELECT at FROM runtime_usage_history
                           WHERE worker_id = $1 AND runtime = $2 AND auth = $3 AND window_id = $4 AND account = $6
                           ORDER BY at DESC OFFSET $5 LIMIT 1)`,
            [workerId, s.runtime, s.auth, w.id, HISTORY_MAX_POINTS - 1, account],
          );
        }
        // Near-limit notice: when the window crosses the threshold (from below, or a new period).
        const old = before.get(w.id);
        const crossed =
          w.usedPercent >= settings.nearThreshold &&
          (old === undefined ||
            old.usedPercent === null ||
            old.usedPercent < settings.nearThreshold ||
            (old.resetsAt ?? '') !== (w.resetsAt ?? ''));
        if (settings.notifyNear && crossed) {
          const payload: RuntimeUsageOutboxPayload = {
            workerId,
            runtime: s.runtime,
            auth: s.auth,
            windowId: w.id,
            usedPercent: w.usedPercent,
            resetsAt: w.resetsAt ?? null,
            threshold: settings.nearThreshold,
            ...(account === 'default' ? {} : { account }),
            ...(identityKey === null ? {} : { identity: identityKey }),
          };
          await tx.query(
            'INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)',
            [OUTBOX_TOPIC_RUNTIME_USAGE, JSON.stringify(payload), now],
          );
        }
      }
    });
    if (cleared.any) this.deps.limitsCleared?.();
  }

  /** Housekeeping: history older than 24 h; p15-usage-refresh: orphan logins not seen for 7 days. */
  async tick(): Promise<void> {
    const now = this.deps.clock();
    const cutoff = new Date(now.getTime() - HISTORY_KEEP_MS);
    await this.deps.pool.query('DELETE FROM runtime_usage_history WHERE at < $1', [cutoff]);
    const old = (await this.orphans()).filter(
      (o) => now.getTime() - Date.parse(o.observedAt) > ORPHAN_DROP_AFTER_MS,
    );
    if (old.length > 0) await this.#delete(old);
  }

  /**
   * p15-usage-refresh: readings of logins that no longer exist — an added account that is neither a panel account nor
   * reported by the machine (removed), or a configured subscription login the machine no longer runs whose reading is
   * older than a day.
   */
  async orphans(): Promise<
    {
      workerId: string;
      runtime: string;
      auth: 'subscription' | 'api_key';
      account: string;
      observedAt: string;
    }[]
  > {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<
      Pick<SnapshotRow, 'worker_id' | 'runtime' | 'auth' | 'account' | 'observed_at'> &
        Pick<WorkerRow, 'local_login' | 'runtime_accounts'>
    >(
      `SELECT s.worker_id, s.runtime, s.auth, s.account, s.observed_at, w.local_login, w.runtime_accounts
         FROM runtime_usage_snapshots s JOIN workers w ON w.id = s.worker_id`,
    );
    const named = await this.#named(rows.map((r) => r.worker_id));
    return rows
      .filter((r) => isOrphan(r, r, named.get(r.worker_id) ?? new Set(), now))
      .map((r) => ({
        workerId: r.worker_id,
        runtime: r.runtime,
        auth: r.auth,
        account: r.account,
        observedAt: r.observed_at.toISOString(),
      }));
  }

  /** p15-usage-refresh: delete the orphan readings (and their history) now; audited. */
  async cleanup(actor: {
    readonly userId: string;
    readonly ip: string | null;
    readonly userAgent: string | null;
  }): Promise<{ removed: number }> {
    const orphans = await this.orphans();
    await this.#delete(orphans);
    await this.deps.audit?.record({
      actor: { type: 'user', id: actor.userId },
      action: 'runtime_usage.cleanup',
      target: 'runtime-usage:snapshots',
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {
        removed: orphans.length,
        logins: orphans.slice(0, 50).map((o) => `${o.workerId}/${o.runtime}/${o.auth}/${o.account}`),
      },
    });
    return { removed: orphans.length };
  }

  async #delete(
    rows: readonly { workerId: string; runtime: string; auth: string; account: string }[],
  ): Promise<void> {
    for (const o of rows) {
      // runtime_usage_history follows through its ON DELETE CASCADE foreign key.
      await this.deps.pool.query(
        'DELETE FROM runtime_usage_snapshots WHERE worker_id = $1 AND runtime = $2 AND auth = $3 AND account = $4',
        [o.workerId, o.runtime, o.auth, o.account],
      );
    }
  }

  /** `runtime|account` of the panel's accounts per machine. */
  async #named(workerIds: readonly string[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (workerIds.length === 0) return out;
    const { rows } = await this.deps.pool.query<{ worker_id: string; runtime: string; account_id: string }>(
      'SELECT worker_id, runtime, account_id FROM runtime_accounts WHERE worker_id = ANY($1::text[])',
      [[...new Set(workerIds)]],
    );
    for (const r of rows) {
      const set = out.get(r.worker_id) ?? new Set<string>();
      set.add(`${r.runtime}|${r.account_id}`);
      out.set(r.worker_id, set);
    }
    return out;
  }

  /**
   * The limits view. `projects`: the subject's visible projects (null = all, owner / admin): a worker is listed when its
   * project allowlist is not reported (it takes every project) or names one of them; limits of other scopes only for
   * owner / admin or when they came from a visible project.
   */
  async overview(opts: {
    readonly projects: readonly string[] | null;
    readonly history?: boolean;
    readonly workerId?: string;
    readonly runtime?: string;
  }): Promise<RuntimeUsageOverview> {
    const now = this.deps.clock();
    const settings = await this.settings();
    // p15-usage-refresh: every visible machine is read (an account's newest reading may come from another machine
    // than the filtered one); the `workerId` filter applies to the listed logins only.
    const { rows: workers } = await this.deps.pool.query<WorkerRow>(
      `SELECT id, display_name, state, local_projects, local_login, features, runtime_accounts FROM workers
        WHERE archived_at IS NULL AND state NOT IN ('pending', 'quarantined')
        ORDER BY display_name, id`,
    );
    const visible = workers.filter((w) => {
      if (opts.projects === null || w.local_projects === null) return true;
      const allow = strings(w.local_projects);
      return opts.projects.some((p) => allow.includes(p));
    });
    const ids = visible.map((w) => w.id);
    const byId = new Map(visible.map((w) => [w.id, w]));
    const { rows: snaps } = await this.deps.pool.query<SnapshotRow>(
      `SELECT worker_id, runtime, auth, account, store, source, plan, available, windows, observed_at, identity_key,
              identity_hint
         FROM runtime_usage_snapshots WHERE worker_id = ANY($1::text[]) AND ($2::text IS NULL OR runtime = $2)`,
      [ids, opts.runtime ?? null],
    );
    const newest = newestByIdentity(snaps);
    // p13-runtime-accounts: account labels (added accounts, or a renamed default).
    const { rows: labelRows } = await this.deps.pool.query<{
      worker_id: string;
      runtime: string;
      account_id: string;
      label: string;
    }>(
      'SELECT worker_id, runtime, account_id, label FROM runtime_accounts WHERE worker_id = ANY($1::text[])',
      [ids],
    );
    const labels = new Map(labelRows.map((r) => [`${r.worker_id}|${r.runtime}|${r.account_id}`, r.label]));
    const named = new Map<string, Set<string>>();
    for (const r of labelRows) {
      const set = named.get(r.worker_id) ?? new Set<string>();
      set.add(`${r.runtime}|${r.account_id}`);
      named.set(r.worker_id, set);
    }
    const history = new Map<string, { at: string; usedPercent: number }[]>();
    if (opts.history === true && ids.length > 0) {
      const { rows } = await this.deps.pool.query<{
        worker_id: string;
        runtime: string;
        auth: string;
        account: string;
        window_id: string;
        at: Date;
        used_percent: number;
      }>(
        `SELECT worker_id, runtime, auth, account, window_id, at, used_percent FROM runtime_usage_history
          WHERE worker_id = ANY($1::text[]) AND at >= $2 AND ($3::text IS NULL OR runtime = $3)
          ORDER BY at`,
        [ids, new Date(now.getTime() - HISTORY_KEEP_MS), opts.runtime ?? null],
      );
      for (const r of rows) {
        const k = `${r.worker_id}|${r.runtime}|${r.auth}|${r.account}|${r.window_id}`;
        const list = history.get(k) ?? [];
        list.push({ at: r.at.toISOString(), usedPercent: Math.round(r.used_percent * 10) / 10 });
        history.set(k, list);
      }
    }
    const episodes = [...((await this.deps.episodes?.()) ?? [])];
    const used = new Set<string>();

    // Pass 1: the logins (per machine) with their own snapshot and episode.
    interface Login {
      readonly w: WorkerRow;
      readonly runtime: string;
      readonly auth: 'subscription' | 'api_key';
      readonly account: string;
      readonly snap: SnapshotRow | undefined;
      readonly ep: UsageLimitEpisodeView | undefined;
      readonly group: string;
    }
    const logins: Login[] = [];
    for (const w of visible) {
      if (opts.workerId !== undefined && w.id !== opts.workerId) continue;
      const login = (w.local_login ?? {}) as { runtimes?: unknown };
      const keys = new Map<
        string,
        { runtime: string; auth: 'subscription' | 'api_key'; account: string; snap?: SnapshotRow }
      >();
      for (const r of strings(login.runtimes)) {
        if (opts.runtime !== undefined && r !== opts.runtime) continue;
        keys.set(`${r}|subscription|default`, { runtime: r, auth: 'subscription', account: 'default' });
      }
      for (const s of snaps) {
        if (s.worker_id !== w.id) continue;
        keys.set(`${s.runtime}|${s.auth}|${s.account}`, {
          runtime: s.runtime,
          auth: s.auth,
          account: s.account,
          snap: s,
        });
      }
      for (const { runtime, auth, account, snap } of keys.values()) {
        const ep =
          auth === 'subscription'
            ? episodes.find(
                (e) =>
                  e.workerId === w.id &&
                  e.runtime === runtime &&
                  e.pauseScope === 'worker_runtime' &&
                  e.scope !== 'model' &&
                  (e.runtimeAccount ?? 'default') === account,
              )
            : undefined;
        if (ep !== undefined) used.add(ep.id);
        const idKey = snap === undefined ? null : identityGroupKey(snap);
        logins.push({
          w,
          runtime,
          auth,
          account,
          snap,
          ep,
          group:
            idKey !== null
              ? `id:${idKey.replace('\u0000', ':')}`
              : `login:${w.id}|${runtime}|${auth}|${account}`,
        });
      }
    }
    // An episode of one login holds every login of the same account (p15-usage-refresh §5).
    const groupEpisode = new Map<string, UsageLimitEpisodeView>();
    for (const l of logins)
      if (l.ep !== undefined && !groupEpisode.has(l.group)) groupEpisode.set(l.group, l.ep);
    // Episodes of logins of the same account on machines not listed (another filter) still count.
    for (const e of episodes) {
      if (e.pauseScope !== 'worker_runtime' || e.scope === 'model' || e.workerId === null) continue;
      const s = snaps.find(
        (x) =>
          x.worker_id === e.workerId &&
          x.runtime === e.runtime &&
          x.auth === 'subscription' &&
          x.account === (e.runtimeAccount ?? 'default'),
      );
      const k = s === undefined ? null : identityGroupKey(s);
      if (k === null) continue;
      const g = `id:${k.replace('\u0000', ':')}`;
      if (!groupEpisode.has(g)) groupEpisode.set(g, e);
      if (logins.some((l) => l.group === g)) used.add(e.id);
    }

    const limitOf = (ep: UsageLimitEpisodeView | undefined): OverviewLimit | null =>
      ep === undefined
        ? null
        : { episodeId: ep.id, kind: ep.kind, model: ep.model, resetAt: ep.resetAt, resumeAt: ep.resumeAt };
    const windowsFor = (s: SnapshotRow | undefined): OverviewWindow[] =>
      dropExpiredWindows(windowsOf(s?.windows), now).map((win) => {
        const h =
          s === undefined
            ? undefined
            : history.get(`${s.worker_id}|${s.runtime}|${s.auth}|${s.account}|${win.id}`);
        return {
          ...win,
          level: usageLevel(win, settings.nearThreshold),
          ...(h === undefined ? {} : { history: h }),
        };
      });
    const canRefresh = (w: WorkerRow): boolean =>
      CONNECTED.has(w.state) && strings(w.features).includes('usage-refresh-v1');

    // Pass 2: entries (per login, with the account's newest reading).
    const entries: OverviewEntry[] = [];
    for (const l of logins) {
      const eff = l.snap === undefined ? undefined : effectiveSnapshot(l.snap, newest);
      const windows = windowsFor(eff);
      const ep = groupEpisode.get(l.group);
      let level: UsageLevel = windows.reduce<UsageLevel>((acc, x) => worseLevel(acc, x.level), 'unknown');
      if (ep !== undefined) level = 'limited';
      const stores = ((l.w.local_login ?? {}) as { stores?: unknown }).stores;
      const storeMap = (typeof stores === 'object' && stores !== null ? stores : {}) as Record<
        string,
        unknown
      >;
      const store =
        l.snap?.store ??
        (l.account === 'default' && typeof storeMap[l.runtime] === 'string' ? storeMap[l.runtime] : null);
      const readOnWorker =
        eff !== undefined && eff.worker_id !== l.w.id ? byId.get(eff.worker_id) : undefined;
      entries.push({
        workerId: l.w.id,
        workerName: l.w.display_name,
        workerState: l.w.state,
        runtime: l.runtime,
        auth: l.auth,
        account: l.account,
        accountLabel: labels.get(`${l.w.id}|${l.runtime}|${l.account}`) ?? null,
        store: l.auth === 'subscription' ? (store as string | null) : null,
        source: eff?.source ?? null,
        plan: eff?.plan ?? null,
        available: eff?.available ?? true,
        observedAt: eff?.observed_at.toISOString() ?? null,
        stale: eff === undefined || now.getTime() - eff.observed_at.getTime() > STALE_AFTER_MS,
        reports: strings(l.w.features).includes('runtime-usage-v1'),
        level,
        windows,
        limit: limitOf(ep),
        identity:
          l.snap?.identity_key === null || l.snap === undefined || l.auth !== 'subscription'
            ? null
            : { key: l.snap.identity_key, hint: l.snap.identity_hint },
        readOn:
          readOnWorker === undefined
            ? null
            : { workerId: readOnWorker.id, workerName: readOnWorker.display_name },
        orphan: l.snap !== undefined && isOrphan(l.snap, l.w, named.get(l.w.id) ?? new Set(), now),
        canRefresh: l.auth === 'subscription' && canRefresh(l.w),
      });
    }

    // Pass 3: groups (one row per account; logins of unknown identity alone).
    const groups: UsageGroup[] = [];
    const order: string[] = [];
    const members = new Map<string, number[]>();
    logins.forEach((l, i) => {
      const list = members.get(l.group);
      if (list === undefined) {
        members.set(l.group, [i]);
        order.push(l.group);
      } else list.push(i);
    });
    for (const g of order) {
      const idx = members.get(g) ?? [];
      const es = idx.map((i) => entries[i]).filter((e): e is OverviewEntry => e !== undefined);
      const ls = idx.map((i) => logins[i]).filter((l): l is Login => l !== undefined);
      const head = es.find((e) => e.observedAt !== null) ?? es[0];
      if (head === undefined) continue;
      // The newest reading of the group: the head entry's effective snapshot.
      const firstSnap = ls.find((l) => l.snap !== undefined)?.snap;
      const eff = firstSnap === undefined ? undefined : effectiveSnapshot(firstSnap, newest);
      const readOnWorker = eff === undefined ? undefined : byId.get(eff.worker_id);
      const labelsOf = [...new Set(es.map((e) => e.accountLabel).filter((x): x is string => x !== null))];
      groups.push({
        key: g,
        runtime: head.runtime,
        auth: head.auth,
        identity: es.find((e) => e.identity !== null)?.identity ?? null,
        labels: labelsOf,
        source: head.source,
        plan: head.plan,
        available: head.available,
        observedAt: head.observedAt,
        readOn:
          readOnWorker === undefined
            ? null
            : { workerId: readOnWorker.id, workerName: readOnWorker.display_name },
        stale: head.stale,
        reports: es.some((e) => e.reports),
        level: es.reduce<UsageLevel>((acc, e) => worseLevel(acc, e.level), 'unknown'),
        windows: head.windows,
        limit: es.find((e) => e.limit !== null)?.limit ?? null,
        orphan: es.every((e) => e.orphan),
        canRefresh: es.some((e) => e.canRefresh && !e.orphan),
        machines: es.map((e, i) => ({
          workerId: e.workerId,
          workerName: e.workerName,
          workerState: e.workerState,
          account: e.account,
          accountLabel: e.accountLabel,
          observedAt: ls[i]?.snap?.observed_at.toISOString() ?? null,
          orphan: e.orphan,
          canRefresh: e.canRefresh,
        })),
      });
    }

    const visibleIds = new Set(ids);
    const otherLimits = episodes
      .filter((e) => !used.has(e.id))
      .filter((e) => opts.runtime === undefined || e.runtime === opts.runtime)
      .filter((e) =>
        e.workerId !== null
          ? visibleIds.has(e.workerId)
          : opts.projects === null || (e.project !== null && opts.projects.includes(e.project)),
      )
      .filter((e) => opts.workerId === undefined || e.workerId === opts.workerId)
      .map(({ message: _m, ...e }) => ({
        ...e,
        project:
          opts.projects === null || (e.project !== null && opts.projects.includes(e.project))
            ? e.project
            : null,
      }));
    return { generatedAt: now.toISOString(), settings, entries, groups, otherLimits };
  }
}
