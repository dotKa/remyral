import {
  clampToClass,
  type JobSpec,
  PRIORITY_CLASS_BAND,
  PRIORITY_CLASS_LABEL,
  PRIORITY_CLASS_VALUE,
  type PriorityClass,
  priorityClassOf,
} from '@remyral/protocol';
import {
  DEFAULT_QUOTA_POLICY,
  DEFAULT_URGENT_RESERVE,
  effectivePriority,
  effectiveUrgentReserve,
  formatDuration,
  holdSummary,
  ownerHolds,
  type PlacementRuntime,
  type PlacementWorker,
  type QuotaPolicy,
  type ReasonSummary,
} from '@remyral/scheduler';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { JobRecord } from '../jobs/store.js';
import type { NotificationDraft } from '../notifications/model.js';
import type {
  AdmissionVerdict,
  DispatchAdmission,
  QueuedJobRow,
  TickStep,
} from '../orchestration/orchestrator.js';
import { outcomesFor, statsKey } from '../routing/stats.js';
import { localLoginFacts, slotLease } from './facts.js';
import { titleColumns, titleOrDerived } from '../jobs/titles.js';
import { pausedQueueEntries, type PausedQueueEntry } from '../approvals/pause.js';

/**
 * p9-queue-priority (docs/design/p9-queue-priority.md): the queue screen (dispatch order per pool, wait reasons,
 * estimated starts), its reorder / run-now actions, the per-user / per-automation limits (a dispatch admission), the
 * per-machine urgent reserve and the long-wait notification (a tick step).
 */

export const WAIT_CATEGORIES = [
  'subscription_login',
  'slot',
  'profile_slot',
  'budget',
  'off_peak',
  'dependency',
  'quota',
  'approval',
  'machine',
  'other',
] as const;
export type WaitCategory = (typeof WAIT_CATEGORIES)[number];

/** Which wait category a scheduler reason belongs to (the queue screen's "wait reason"). */
export function waitCategory(code: string): WaitCategory {
  // p9-queue-local-login-accounting: subscription logins run one at a time on the machine.
  if (code === 'subscription_login_exclusive' || code === 'subscription_login_busy')
    return 'subscription_login';
  if (code === 'no_free_profile_slot' || code === 'declined_busy') return 'profile_slot';
  if (code === 'no_free_slot' || code === 'urgent_slot_reserved') return 'slot';
  if (code.startsWith('budget_')) return 'budget';
  if (code === 'deferred_off_peak') return 'off_peak';
  if (code === 'dependency_pending') return 'dependency';
  if (code.includes('approval')) return 'approval';
  if (
    [
      'project_concurrency',
      'runtime_concurrency',
      'account_concurrency',
      'provider_paused',
      'project_hold',
      'user_concurrency',
      'automation_concurrency',
    ].includes(code)
  ) {
    return 'quota';
  }
  if (
    ['offline', 'draining', 'updating', 'capabilities_unknown', 'config_not_applied', 'no_workers'].includes(
      code,
    )
  )
    return 'machine';
  return 'other';
}

/** The main wait category of a job: the first category that explains the wait, in the order users act on. */
function primaryCategory(state: string, reasons: readonly ReasonSummary[]): WaitCategory | null {
  if (state === 'BLOCKED') return 'dependency';
  if (state === 'RETRY_WAIT') return 'other';
  if (reasons.length === 0) return null;
  const cats = reasons.map((r) => waitCategory(r.code));
  for (const c of [
    'approval',
    'dependency',
    'off_peak',
    'budget',
    'quota',
    'subscription_login',
    'profile_slot',
    'slot',
    'machine',
  ] as const) {
    if (cats.includes(c)) return c;
  }
  return 'other';
}

export interface QueueSettings {
  readonly project: string;
  /** Most concurrent jobs one person runs in the project (null = off). */
  readonly maxPerUser: number | null;
  /** Most concurrent jobs one automation runs in the project (null = off). */
  readonly maxPerAutomation: number | null;
  /** Minutes a queued job may wait before its creator is told (0 = off). */
  readonly waitNotifyMinutes: number;
}

export interface QueueEntry {
  readonly jobId: string;
  readonly project: string;
  readonly title: string;
  readonly runtime: string;
  readonly sandboxProfile: string;
  readonly state: string;
  /** The queue priority (an adjustment from this screen, else the stored priority). */
  readonly priority: number;
  readonly storedPriority: number;
  readonly priorityClass: PriorityClass;
  readonly adjusted: {
    readonly reason: 'reorder' | 'run_now';
    readonly by: string;
    readonly at: string;
  } | null;
  /** 1-based place in its pool's dispatch order. */
  readonly position: number;
  readonly waitingSince: string;
  readonly waitingSec: number;
  readonly category: WaitCategory | null;
  readonly reasons: readonly { code: string; category: WaitCategory; message: string; until?: string }[];
  /** An estimate from the running jobs' expected remaining time (job_stats medians); null = unknown. */
  readonly estimatedStart: string | null;
  readonly createdBy: string | null;
  /** The viewer may reorder this job (operator or admin in its project). */
  readonly canReorder: boolean;
}

export interface QueuePool {
  /** `<profile>` or `<profile>@<worker>` for jobs pinned to one machine. */
  readonly key: string;
  readonly profile: string;
  readonly machines: readonly {
    readonly id: string;
    readonly name: string;
    readonly slots: number | null;
    readonly profileSlots: number | null;
    readonly running: number;
    /** The reserve setting (an admin's value, or the default {@link DEFAULT_URGENT_RESERVE} when `urgentReserveAuto`). */
    readonly urgentReserve: number;
    /** p11-fixes-a: no admin setting — the default applies only from 3 usable parallel slots on. */
    readonly urgentReserveAuto: boolean;
    /**
     * p9-queue-local-login-accounting (D): slots kept for Acil in this pool's profile — the reserve only where ≥ 2
     * parallel slots can be used (scheduler `effectiveUrgentReserve`).
     */
    readonly urgentReserveEffective: number;
    /**
     * Subscription-login runtimes that run one at a time in this pool's profile on the machine (null: none);
     * `perLogin` (p9-subjob-local-login-deadlock): one at a time per login store, not per machine.
     */
    readonly subscriptionLogins: {
      readonly runtimes: readonly string[];
      readonly atATime: 1;
      readonly perLogin: boolean;
    } | null;
  }[];
  readonly jobs: readonly QueueEntry[];
}

export interface QueueView {
  readonly generatedAt: string;
  readonly pools: readonly QueuePool[];
  readonly total: number;
  /** How estimates are made (shown under the table). */
  readonly estimateNote: string;
  /**
   * p10-approval-pause: jobs paused while waiting for an approval (and those pausing / resuming). Shown separately:
   * they hold no machine slot and are not in any pool's dispatch order.
   */
  readonly paused: readonly PausedQueueEntry[];
}

export interface QueueViewer {
  readonly userId: string;
  /** Visible projects (null = every project). */
  readonly projects: readonly string[] | null;
  /** Projects where the viewer may reorder (null = every visible project). */
  readonly reorderProjects: readonly string[] | null;
}

export interface QueueActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface QueueServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  /** The dispatch order (QuotaService.order: classes, aging, fair share). */
  readonly order: (queued: readonly QueuedJobRow[]) => Promise<readonly string[]>;
  readonly policy: () => Promise<QuotaPolicy>;
  /** Re-evaluates a job now (Orchestrator.dispatch). */
  readonly dispatch: (jobId: string) => Promise<unknown>;
  readonly notify?: () => {
    notify(db: Queryable, recipients: readonly string[], draft: NotificationDraft): Promise<number>;
  } | null;
  /** p6-chat-notify: a note into the chat thread a job came from. */
  readonly chatNote?: (
    tx: Queryable,
    threadId: string,
    text: string,
    meta: Record<string, unknown>,
  ) => Promise<void>;
}

const MAX_QUEUE = 500;
const QUEUE_STATES = ['QUEUED', 'BLOCKED', 'RETRY_WAIT'];

interface Row {
  id: string;
  project: string;
  state: string;
  title_stored: string | null;
  title_prompt: string | null;
  spec: JobSpec;
  priority: number;
  stored_priority: number;
  adj_reason: 'reorder' | 'run_now' | null;
  adj_by: string | null;
  adj_at: Date | null;
  created_at: Date;
  queued_since: Date | null;
  created_by_id: string | null;
  created_by_type: string;
  reasons: ReasonSummary[] | null;
}

export class QueueService implements DispatchAdmission {
  /** p10-claude-login-health: login-wait notices already stored by this process (saves the idempotent insert). */
  readonly #loginNoticed = new Set<string>();

  constructor(private readonly deps: QueueServiceDeps) {}

  // ------------------------------------------------------------------------------------------ admission (§3.7)

  /** Per-user / per-automation concurrency limits of the job's project (off by default). */
  async admit(job: JobRecord): Promise<AdmissionVerdict> {
    // p14-workflow-engine 14.3: function jobs hold no AI slot; per-user / per-automation caps are about agent work.
    if (job.spec.kind === 'function') return { kind: 'admit' };
    const s = await this.settings(job.project);
    if (s.maxPerUser === null && s.maxPerAutomation === null) return { kind: 'admit' };
    const { rows } = await this.deps.pool.query<{
      id: string;
      user_id: string | null;
      automation_id: string | null;
    }>(
      `SELECT j.id, CASE WHEN j.created_by_type = 'user' THEN j.created_by_id END AS user_id,
              (SELECT ar.automation_id::text FROM automation_runs ar WHERE ar.job_id = j.id
                UNION ALL
               SELECT ar.automation_id::text FROM workflow_job_links n JOIN automation_runs ar ON ar.workflow_run_id = n.run_id
                WHERE n.job_id = j.id
               LIMIT 1) AS automation_id
         FROM jobs j
        WHERE j.project = $1 AND (j.id = $2 OR (j.state IN ('RESERVED', 'STARTING', 'RUNNING', 'VERIFYING', 'LOST')
              AND COALESCE(j.spec->>'kind', '') <> 'function'))`,
      [job.project, job.id],
    );
    const self = rows.find((r) => r.id === job.id);
    const holds = ownerHolds(
      { project: job.project, userId: self?.user_id ?? null, automationId: self?.automation_id ?? null },
      rows
        .filter((r) => r.id !== job.id)
        .map((r) => ({ project: job.project, userId: r.user_id, automationId: r.automation_id })),
      { maxPerUser: s.maxPerUser, maxPerAutomation: s.maxPerAutomation },
    );
    return holds.length === 0 ? { kind: 'admit' } : { kind: 'hold', reasons: holdSummary(holds) };
  }

  // ------------------------------------------------------------------------------------------ settings

  async settings(project: string, db: Queryable = this.deps.pool): Promise<QueueSettings> {
    const { rows } = await db.query<{
      queue_max_per_user: number | null;
      queue_max_per_automation: number | null;
      queue_wait_notify_minutes: number;
    }>(
      'SELECT queue_max_per_user, queue_max_per_automation, queue_wait_notify_minutes FROM projects WHERE id = $1',
      [project],
    );
    const r = rows[0];
    return {
      project,
      maxPerUser: r?.queue_max_per_user ?? null,
      maxPerAutomation: r?.queue_max_per_automation ?? null,
      waitNotifyMinutes: r?.queue_wait_notify_minutes ?? 15,
    };
  }

  async setSettings(
    project: string,
    body: { maxPerUser: number | null; maxPerAutomation: number | null; waitNotifyMinutes: number },
    actor: QueueActor,
  ): Promise<QueueSettings> {
    return withTransaction(this.deps.pool, async (tx) => {
      const before = await this.settings(project, tx);
      const { rowCount } = await tx.query(
        `UPDATE projects SET queue_max_per_user = $2, queue_max_per_automation = $3, queue_wait_notify_minutes = $4
          WHERE id = $1`,
        [project, body.maxPerUser, body.maxPerAutomation, body.waitNotifyMinutes],
      );
      if (rowCount === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'project.queue.update',
          target: `project:${project}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { before: { ...before }, after: { project, ...body } },
        },
        tx,
      );
      return { project, ...body };
    });
  }

  /**
   * p9-queue-priority: slots kept for urgent jobs on one machine (0, 1 or 2). p11-fixes-a: null = back to
   * the default
   * (1 slot only on machines with at least 3 usable parallel slots).
   */
  async setUrgentReserve(
    workerId: string,
    reserve: number | null,
    actor: QueueActor,
  ): Promise<{ urgentReserve: number; urgentReserveAuto: boolean }> {
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ urgent_reserve: number | null }>(
        'SELECT urgent_reserve FROM workers WHERE id = $1 AND archived_at IS NULL FOR UPDATE',
        [workerId],
      );
      const row = rows[0];
      if (row === undefined)
        throw new HttpError(404, 'worker_not_found', 'Worker not found.', {}, {}, { reason: 'not_found' });
      const before = row.urgent_reserve;
      await tx.query('UPDATE workers SET urgent_reserve = $2, updated_at = $3 WHERE id = $1', [
        workerId,
        reserve,
        this.deps.clock(),
      ]);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'worker.urgent_reserve.update',
          target: `worker:${workerId}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { from: before ?? 'default', to: reserve ?? 'default' },
        },
        tx,
      );
      return { urgentReserve: reserve ?? DEFAULT_URGENT_RESERVE, urgentReserveAuto: reserve === null };
    });
  }

  // ------------------------------------------------------------------------------------------ view

  async view(viewer: QueueViewer, filter: { project?: string | undefined } = {}): Promise<QueueView> {
    const now = this.deps.clock();
    const projects =
      filter.project === undefined
        ? viewer.projects
        : viewer.projects === null || viewer.projects.includes(filter.project)
          ? [filter.project]
          : [];
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT j.id, j.project, j.state::text AS state, ${titleColumns()}, j.spec,
              COALESCE(q.priority, j.priority) AS priority, j.priority AS stored_priority,
              q.reason AS adj_reason, q.set_by AS adj_by, q.set_at AS adj_at,
              j.created_at, j.created_by_id, j.created_by_type,
              (SELECT max(t.occurred_at) FROM job_transitions t
                WHERE t.job_id = j.id AND t.to_state = j.state AND t.trigger <> 'lease_declined') AS queued_since,
              s.reasons
         FROM jobs j
         LEFT JOIN job_titles jt ON jt.job_id = j.id
         LEFT JOIN job_queue_priority q ON q.job_id = j.id
         LEFT JOIN job_schedule_status s ON s.job_id = j.id
        WHERE j.state = ANY($1::job_state[]) AND ($2::text[] IS NULL OR j.project = ANY($2))
        ORDER BY COALESCE(q.priority, j.priority) DESC, j.created_at
        LIMIT $3`,
      [QUEUE_STATES, projects === null ? null : [...projects], MAX_QUEUE],
    );
    const queued = rows.filter((r) => r.state === 'QUEUED');
    const order = await this.deps.order(
      queued.map((r) => ({ id: r.id, project: r.project, priority: r.priority, createdAt: r.created_at })),
    );
    const rank = new Map(order.map((id, i) => [id, i]));
    // Queued in dispatch order, then blocked / retrying (they are not tried until they are queued again).
    const sorted = [...rows].sort((a, b) => {
      const ra = rank.get(a.id) ?? MAX_QUEUE + (a.state === 'QUEUED' ? 0 : 1);
      const rb = rank.get(b.id) ?? MAX_QUEUE + (b.state === 'QUEUED' ? 0 : 1);
      return ra - rb || a.created_at.getTime() - b.created_at.getTime();
    });
    const machines = await this.#machines();
    const pools = new Map<string, Row[]>();
    for (const r of sorted) {
      const key = poolKey(r.spec);
      pools.set(key, [...(pools.get(key) ?? []), r]);
    }
    const running = await this.#running(now);
    const out: QueuePool[] = [];
    for (const [key, list] of [...pools.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const [profile = 'container', pinned] = key.split('@');
      const poolMachines = machines.filter(
        (m) => m.profiles.includes(profile) && (pinned === undefined || m.id === pinned),
      );
      const estimates = await this.#estimates(list, poolMachines, profile, running, now);
      out.push({
        key,
        profile,
        machines: poolMachines.map((m) => ({
          id: m.id,
          name: m.name,
          slots: m.slots,
          profileSlots: m.profileConcurrency?.[profile] ?? null,
          running: running.filter((x) => x.workerId === m.id).length,
          urgentReserve: m.urgentReserve ?? DEFAULT_URGENT_RESERVE,
          urgentReserveAuto: m.urgentReserve === null,
          urgentReserveEffective: effectiveUrgentReserve(
            {
              maxParallelJobs: m.slots,
              profileConcurrency: m.profileConcurrency ?? undefined,
              exclusiveProfiles: m.exclusiveProfiles ?? undefined,
              localLogin: m.localLogin,
              runtimes: m.runtimes,
              urgentReserve: m.urgentReserve,
            },
            profile,
          ),
          subscriptionLogins:
            m.localLogin?.exclusiveProfiles.includes(profile) === true
              ? {
                  runtimes: [...m.localLogin.runtimes],
                  atATime: 1 as const,
                  perLogin: m.localLogin.stores !== undefined,
                }
              : null,
        })),
        jobs: list.map((r, i) => {
          const reasons = r.reasons ?? [];
          const waitingSince = r.queued_since ?? r.created_at;
          return {
            jobId: r.id,
            project: r.project,
            title: titleOrDerived(r),
            runtime: r.spec.runtime,
            sandboxProfile: r.spec.sandboxProfile,
            state: r.state,
            priority: r.priority,
            storedPriority: r.stored_priority,
            priorityClass: priorityClassOf(r.priority),
            adjusted:
              r.adj_reason === null || r.adj_at === null
                ? null
                : { reason: r.adj_reason, by: r.adj_by ?? '', at: r.adj_at.toISOString() },
            position: i + 1,
            waitingSince: waitingSince.toISOString(),
            waitingSec: Math.max(0, Math.round((now.getTime() - waitingSince.getTime()) / 1000)),
            category: r.state === 'QUEUED' && reasons.length === 0 ? null : primaryCategory(r.state, reasons),
            reasons: reasons.slice(0, 8).map((x) => ({
              code: x.code,
              category: waitCategory(x.code),
              message: x.message.slice(0, 500),
              ...(x.until === undefined ? {} : { until: x.until }),
            })),
            estimatedStart: estimates.get(r.id) ?? null,
            createdBy: r.created_by_type === 'user' ? r.created_by_id : null,
            canReorder:
              r.state === 'QUEUED' &&
              (viewer.reorderProjects === null || viewer.reorderProjects.includes(r.project)),
          };
        }),
      });
    }
    return {
      generatedAt: now.toISOString(),
      pools: out,
      paused: await pausedQueueEntries(this.deps.pool, projects),
      total: rows.length,
      estimateNote:
        'Estimated start: from the median duration (job_stats) of the jobs running on the pool’s machines and of the jobs ahead; an estimate, not a promise.',
    };
  }

  async #machines(): Promise<
    {
      id: string;
      name: string;
      profiles: string[];
      slots: number | null;
      profileConcurrency: Record<string, number> | null;
      exclusiveProfiles: string[] | null;
      urgentReserve: number | null;
      localLogin: PlacementWorker['localLogin'];
      runtimes: PlacementRuntime[];
    }[]
  > {
    const { rows } = await this.deps.pool.query<{
      id: string;
      display_name: string;
      sandbox_profiles: string[];
      max_parallel_jobs: number | null;
      profile_concurrency: Record<string, number> | null;
      exclusive_profiles: unknown;
      features: unknown;
      urgent_reserve: number | null;
      cap_slots: number | null;
      local_login: unknown;
      runtimes: {
        runtime: string;
        version: string;
        installed: boolean;
        authenticated: 'yes' | 'no' | 'unknown';
      }[];
    }>(
      `SELECT w.id, w.display_name, w.sandbox_profiles, w.max_parallel_jobs, w.profile_concurrency, w.features,
              w.exclusive_profiles, w.urgent_reserve, w.local_login,
              CASE WHEN cap.mode = 'auto' THEN cap.slots END AS cap_slots,
              COALESCE((SELECT json_agg(json_build_object('runtime', r.runtime, 'version', r.version,
                          'installed', r.installed, 'authenticated', r.authenticated))
                          FROM worker_runtimes r WHERE r.worker_id = w.id AND r.present), '[]'::json) AS runtimes
         FROM workers w LEFT JOIN worker_capacity cap ON cap.worker_id = w.id
        WHERE w.state <> 'pending' AND w.archived_at IS NULL
        ORDER BY w.display_name`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.display_name,
      profiles: Array.isArray(r.sandbox_profiles) ? r.sandbox_profiles : [],
      slots:
        r.max_parallel_jobs === null
          ? null
          : r.cap_slots === null
            ? r.max_parallel_jobs
            : Math.min(r.max_parallel_jobs, r.cap_slots),
      profileConcurrency:
        Array.isArray(r.features) && r.features.includes('profile-slots-v1') ? r.profile_concurrency : null,
      exclusiveProfiles:
        Array.isArray(r.features) &&
        r.features.includes('profile-slots-v1') &&
        Array.isArray(r.exclusive_profiles)
          ? r.exclusive_profiles.filter((p): p is string => typeof p === 'string')
          : null,
      urgentReserve: r.urgent_reserve,
      localLogin: localLoginFacts(r.features, r.local_login),
      runtimes: r.runtimes.map((x) => ({ ...x, pinStatus: 'unknown' as const })),
    }));
  }

  /** Running attempts with their expected remaining seconds (null = unknown). */
  async #running(now: Date): Promise<{ workerId: string; profile: string; remainingSec: number | null }[]> {
    const { rows } = await this.deps.pool.query<{
      worker_id: string;
      project: string;
      spec: JobSpec;
      started_at: Date;
    }>(
      // p9-queue-local-login-accounting: slot-holding leases only (a busy-declined job's pending re-ask is not "running").
      `SELECT l.worker_id, j.project, j.spec, a.started_at
         FROM leases l JOIN jobs j ON j.id = l.job_id JOIN job_attempts a ON a.id = l.attempt_id
        WHERE ${slotLease('l', 'j')} LIMIT 500`,
    );
    const out: { workerId: string; profile: string; remainingSec: number | null }[] = [];
    const cache = new Map<string, Promise<Map<string, { p50DurationSec: number | null }>>>();
    for (const r of rows) {
      const p50 = await this.#p50(cache, r.project, r.spec, r.worker_id);
      const elapsed = (now.getTime() - r.started_at.getTime()) / 1000;
      out.push({
        workerId: r.worker_id,
        profile: r.spec.sandboxProfile,
        // Past its median: assume it ends within a minute (never a negative wait).
        remainingSec: p50 === null ? null : Math.max(60, p50 - elapsed),
      });
    }
    return out;
  }

  async #p50(
    cache: Map<string, Promise<Map<string, { p50DurationSec: number | null }>>>,
    project: string,
    spec: JobSpec,
    workerId: string | null,
  ): Promise<number | null> {
    const key = statsKey(spec);
    const k = `${project}\u0000${key.runtime}\u0000${key.model}\u0000${key.kind}`;
    let m = cache.get(k);
    if (m === undefined) {
      m = outcomesFor(this.deps.pool, { project, ...key }).catch(() => new Map());
      cache.set(k, m);
    }
    const stats = await m;
    if (workerId !== null) {
      const own = stats.get(workerId)?.p50DurationSec;
      if (own !== undefined && own !== null) return own;
    }
    const all = [...stats.values()]
      .map((s) => s.p50DurationSec)
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
    return all.length === 0 ? null : (all[Math.floor(all.length / 2)] ?? null);
  }

  /**
   * Estimated start of the pool's queued jobs: the pool's slots become free when their running jobs reach their
   * median duration; each queued job (in dispatch order) takes the earliest free slot and holds it for its own
   * median. Jobs held by something other than a slot (budget, off-peak, dependency, quota, approval) get none.
   */
  async #estimates(
    list: readonly Row[],
    machines: readonly {
      id: string;
      slots: number | null;
      profileConcurrency: Record<string, number> | null;
    }[],
    profile: string,
    running: readonly { workerId: string; profile: string; remainingSec: number | null }[],
    now: Date,
  ): Promise<Map<string, string>> {
    const free: (number | null)[] = [];
    for (const m of machines) {
      const mine = running.filter((r) => r.workerId === m.id);
      const forProfile = mine.filter((r) => r.profile === profile);
      const cap = Math.min(m.slots ?? 0, m.profileConcurrency?.[profile] ?? Number.MAX_SAFE_INTEGER);
      // Busy slots end when their jobs do; free ones are free now.
      const busy = (cap < (m.slots ?? 0) ? forProfile : mine).map((r) => r.remainingSec);
      for (let i = 0; i < cap; i++) free.push(i < busy.length ? (busy[i] ?? null) : 0);
    }
    const out = new Map<string, string>();
    const cache = new Map<string, Promise<Map<string, { p50DurationSec: number | null }>>>();
    for (const r of list) {
      if (r.state !== 'QUEUED') continue;
      const cat = primaryCategory(r.state, r.reasons ?? []);
      if (cat !== null && cat !== 'slot' && cat !== 'profile_slot' && cat !== 'machine') continue;
      const known = free.filter((x): x is number => x !== null);
      if (known.length === 0) break;
      const t = Math.min(...known);
      free.splice(free.indexOf(t), 1);
      out.set(r.id, new Date(now.getTime() + t * 1000).toISOString());
      const own = await this.#p50(cache, r.project, r.spec, null);
      free.push(own === null ? null : t + own);
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ reorder / run now

  /**
   * Drag and drop: place `jobId` before (or after) `targetId` in the dispatch order by adjusting its queue priority
   * within its own class (never across classes: a normal job cannot become urgent by dragging). Fair share between
   * projects still applies, so a move across projects may not hold exactly; the answer says so.
   */
  async move(
    jobId: string,
    to: { before?: string | undefined; after?: string | undefined },
    actor: QueueActor,
  ): Promise<{
    jobId: string;
    priority: number;
    priorityClass: PriorityClass;
    exact: boolean;
    note: string | null;
  }> {
    const targetId = to.before ?? to.after;
    if (targetId === undefined || (to.before !== undefined && to.after !== undefined)) {
      throw new HttpError(400, 'invalid_move', 'Give exactly one of before / after.');
    }
    if (targetId === jobId)
      throw new HttpError(
        400,
        'invalid_move',
        'A job cannot move relative to itself.',
        {},
        {},
        { reason: 'self' },
      );
    const policy = await this.deps.policy().catch(() => DEFAULT_QUOTA_POLICY);
    const now = this.deps.clock();
    const result = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        project: string;
        state: string;
        priority: number;
        stored: number;
        created_at: Date;
      }>(
        `SELECT j.id, j.project, j.state::text AS state, COALESCE(q.priority, j.priority) AS priority,
                j.priority AS stored, j.created_at
           FROM jobs j LEFT JOIN job_queue_priority q ON q.job_id = j.id
          WHERE j.id = ANY($1::uuid[]) FOR UPDATE OF j`,
        [[jobId, targetId]],
      );
      const job = rows.find((r) => r.id === jobId);
      const target = rows.find((r) => r.id === targetId);
      if (job === undefined) throw new HttpError(404, 'job_not_found', 'Job not found.');
      if (target === undefined)
        throw new HttpError(404, 'target_not_found', 'The job to move next to was not found.');
      if (job.state !== 'QUEUED')
        throw new HttpError(409, 'not_queued', 'Only queued jobs can be reordered.');
      const cls = priorityClassOf(job.priority);
      const age = (r: { priority: number; created_at: Date }) =>
        effectivePriority(
          { id: '', project: '', priority: r.priority, createdAt: r.created_at },
          policy,
          now,
        ) - r.priority;
      const targetEff = target.priority + age(target);
      const wanted = (to.before !== undefined ? targetEff + 1 : targetEff - 1) - age(job);
      const priority = clampToClass(wanted, cls);
      const exact = priority === Math.round(wanted) && priorityClassOf(target.priority) === cls;
      await tx.query(
        `INSERT INTO job_queue_priority (job_id, priority, reason, set_by, set_at) VALUES ($1, $2, 'reorder', $3, $4)
         ON CONFLICT (job_id) DO UPDATE SET priority = EXCLUDED.priority, reason = EXCLUDED.reason,
           set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
        [jobId, priority, actor.userId, now],
      );
      const note = exact
        ? job.project === target.project
          ? null
          : 'The jobs are in different projects: fair share between projects still decides which one starts first.'
        : `The job stays ${PRIORITY_CLASS_LABEL[cls]} (priority ${String(PRIORITY_CLASS_BAND[cls][0])}…${String(PRIORITY_CLASS_BAND[cls][1])}); it could not be moved further.`;
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'job.queue.reorder',
          target: `job:${jobId}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: {
            project: job.project,
            from: job.priority,
            to: priority,
            stored: job.stored,
            relativeTo: targetId,
            placement: to.before !== undefined ? 'before' : 'after',
            exact,
          },
        },
        tx,
      );
      return { jobId, priority, priorityClass: cls, exact, note };
    });
    return result;
  }

  /**
   * p10-chat-job-actions: move a queued job to the Normal or Arka plan class (its class's base value, as an adjustment in
   * `job_queue_priority` like a reorder: the `jobs` row is never updated). Never into Acil — that is `runNow` (admin,
   * step-up). Audited `job.queue.reclass`.
   */
  async setClass(
    jobId: string,
    cls: Exclude<PriorityClass, 'urgent'>,
    actor: QueueActor,
  ): Promise<{ jobId: string; priority: number; priorityClass: PriorityClass; from: PriorityClass }> {
    if ((cls as PriorityClass) === 'urgent') {
      throw new HttpError(400, 'invalid_class', 'Use “Run now” to make a job urgent (Acil).');
    }
    const now = this.deps.clock();
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ project: string; state: string; priority: number }>(
        `SELECT j.project, j.state::text AS state, COALESCE(q.priority, j.priority) AS priority
           FROM jobs j LEFT JOIN job_queue_priority q ON q.job_id = j.id WHERE j.id = $1 FOR UPDATE OF j`,
        [jobId],
      );
      const job = rows[0];
      if (job === undefined) throw new HttpError(404, 'job_not_found', 'Job not found.');
      if (job.state !== 'QUEUED')
        throw new HttpError(
          409,
          'not_queued',
          'Only queued jobs can change their class.',
          {},
          {},
          { reason: 'class' },
        );
      const from = priorityClassOf(job.priority);
      const priority = PRIORITY_CLASS_VALUE[cls];
      await tx.query(
        `INSERT INTO job_queue_priority (job_id, priority, reason, set_by, set_at) VALUES ($1, $2, 'reorder', $3, $4)
         ON CONFLICT (job_id) DO UPDATE SET priority = EXCLUDED.priority, reason = EXCLUDED.reason,
           set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
        [jobId, priority, actor.userId, now],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'job.queue.reclass',
          target: `job:${jobId}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { project: job.project, from: job.priority, to: priority, fromClass: from, toClass: cls },
        },
        tx,
      );
      return { jobId, priority, priorityClass: cls, from };
    });
  }

  /** Admin "run now": the job becomes urgent (Acil) and goes ahead of every other urgent job; dispatched at once. */
  async runNow(
    jobId: string,
    actor: QueueActor,
  ): Promise<{ jobId: string; priority: number; priorityClass: PriorityClass }> {
    const now = this.deps.clock();
    const priority = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ project: string; state: string; priority: number }>(
        `SELECT j.project, j.state::text AS state, COALESCE(q.priority, j.priority) AS priority
           FROM jobs j LEFT JOIN job_queue_priority q ON q.job_id = j.id WHERE j.id = $1 FOR UPDATE OF j`,
        [jobId],
      );
      const job = rows[0];
      if (job === undefined) throw new HttpError(404, 'job_not_found', 'Job not found.');
      if (job.state !== 'QUEUED')
        throw new HttpError(
          409,
          'not_queued',
          'Only queued jobs can be run now.',
          {},
          {},
          { reason: 'run_now' },
        );
      const { rows: top } = await tx.query<{ p: number | null }>(
        `SELECT max(COALESCE(q.priority, j.priority)) AS p FROM jobs j LEFT JOIN job_queue_priority q ON q.job_id = j.id
          WHERE j.state = 'QUEUED' AND j.id <> $1`,
        [jobId],
      );
      const p = clampToClass(Math.max(PRIORITY_CLASS_VALUE.urgent, (top[0]?.p ?? 0) + 1), 'urgent');
      await tx.query(
        `INSERT INTO job_queue_priority (job_id, priority, reason, set_by, set_at) VALUES ($1, $2, 'run_now', $3, $4)
         ON CONFLICT (job_id) DO UPDATE SET priority = EXCLUDED.priority, reason = EXCLUDED.reason,
           set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
        [jobId, p, actor.userId, now],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'job.queue.run_now',
          target: `job:${jobId}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { project: job.project, from: job.priority, to: p },
        },
        tx,
      );
      return p;
    });
    await this.deps.dispatch(jobId).catch((err: unknown) => {
      this.deps.log.warn({ err, jobId }, 'run-now dispatch failed; the loop retries');
    });
    return { jobId, priority, priorityClass: 'urgent' };
  }

  // ------------------------------------------------------------------------------------------ long wait (§3.8)

  step(): TickStep {
    return {
      name: 'queue-wait-notices',
      run: async () => {
        await this.notifyLongWaits();
        await this.notifyLoginWaits();
      },
    };
  }

  /**
   * Tells a job's creator (once per job) when it waits longer than its project's threshold — except jobs that wait on
   * purpose (off-peak deferral, a dependency). A job started from the ops chat also gets a note in its thread.
   */
  async notifyLongWaits(limit = 50): Promise<number> {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{
      id: string;
      project: string;
      title_stored: string | null;
      title_prompt: string | null;
      created_by_id: string | null;
      created_by_type: string;
      since: Date;
      minutes: number;
      reasons: ReasonSummary[] | null;
      thread_id: string | null;
    }>(
      `SELECT j.id, j.project, ${titleColumns()}, j.created_by_id, j.created_by_type,
              w.since, p.queue_wait_notify_minutes AS minutes, s.reasons,
              (SELECT d.thread_id::text FROM chat_drafts d
                WHERE d.kind = 'job' AND d.state = 'confirmed' AND d.result->>'jobId' = j.id::text LIMIT 1) AS thread_id
         FROM jobs j
         LEFT JOIN job_titles jt ON jt.job_id = j.id
         JOIN projects p ON p.id = j.project
         CROSS JOIN LATERAL (SELECT max(t.occurred_at) AS since FROM job_transitions t
                              WHERE t.job_id = j.id AND t.to_state = 'QUEUED' AND t.trigger <> 'lease_declined') w
         LEFT JOIN job_schedule_status s ON s.job_id = j.id
        WHERE j.state = 'QUEUED' AND p.queue_wait_notify_minutes > 0
          AND w.since < $1::timestamptz - make_interval(mins => p.queue_wait_notify_minutes)
          AND NOT EXISTS (SELECT 1 FROM job_wait_notices n WHERE n.job_id = j.id)
        ORDER BY w.since LIMIT $2`,
      [now, limit],
    );
    let sent = 0;
    for (const r of rows) {
      const reasons = r.reasons ?? [];
      if (reasons.some((x) => x.code === 'deferred_off_peak' || x.code === 'dependency_pending')) continue;
      const waitedSec = Math.round((now.getTime() - r.since.getTime()) / 1000);
      const why = reasons[0]?.message ?? 'no machine has started it yet';
      const done = await withTransaction(this.deps.pool, async (tx) => {
        const ins = await tx.query(
          `INSERT INTO job_wait_notices (job_id, waited_sec, notified_at) VALUES ($1, $2, $3)
           ON CONFLICT (job_id) DO NOTHING`,
          [r.id, waitedSec, now],
        );
        if (ins.rowCount === 0) return false;
        // p15-job-titles: the job by its title.
        const jobTitle = titleOrDerived(r);
        const title = `Job waiting ${formatDuration(waitedSec)} in the queue: ${jobTitle}`;
        const body = `${jobTitle} (${r.id.slice(0, 8)}, ${r.project}) is still queued: ${why}`.slice(0, 1900);
        const svc = this.deps.notify?.() ?? null;
        if (svc !== null && r.created_by_type === 'user' && r.created_by_id !== null) {
          await svc.notify(tx, [r.created_by_id], {
            kind: 'job.waiting',
            severity: 'info',
            title,
            body,
            link: `/jobs/${r.id}`,
            dedupeKey: `job.waiting:${r.id}`,
          });
        }
        if (r.thread_id !== null && this.deps.chatNote !== undefined) {
          await this.deps.chatNote(tx, r.thread_id, `${title}: ${why}. Queue: /jobs?tab=queue`, {
            notice: 'job-waiting',
            jobId: r.id,
            link: `/jobs/${r.id}`,
          });
        }
        await this.deps.audit.record(
          {
            actor: { type: 'system', id: 'queue' },
            action: 'job.waiting.notify',
            target: `job:${r.id}`,
            outcome: 'success',
            metadata: {
              project: r.project,
              waitedSec,
              threadId: r.thread_id,
              reason: reasons[0]?.code ?? null,
            },
          },
          tx,
        );
        return true;
      });
      if (done) sent++;
    }
    return sent;
  }

  /**
   * p10-claude-login-health: a queued job waits because its runtime is signed out on a machine (transient
   * `runtime_not_authenticated`). The job's creator is told once per machine, runtime and day, with the machine's
   * "Log in again" link - not once per job: several jobs waiting for the same login make one notice.
   */
  async notifyLoginWaits(limit = 50): Promise<number> {
    const svc = this.deps.notify?.() ?? null;
    if (svc === null) return 0;
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{
      id: string;
      project: string;
      runtime: string;
      created_by_id: string;
      reasons: ReasonSummary[];
    }>(
      `SELECT j.id, j.project, j.spec->>'runtime' AS runtime, j.created_by_id, s.reasons
         FROM jobs j JOIN job_schedule_status s ON s.job_id = j.id
        WHERE j.state = 'QUEUED' AND s.status = 'waiting' AND j.created_by_type = 'user'
          AND j.created_by_id IS NOT NULL
          AND s.reasons @> '[{"code": "runtime_not_authenticated", "permanent": false}]'::jsonb
        ORDER BY j.created_at LIMIT $1`,
      [limit],
    );
    let sent = 0;
    const day = now.toISOString().slice(0, 10);
    for (const r of rows) {
      const wait = r.reasons.find((x) => x.code === 'runtime_not_authenticated' && !x.permanent);
      if (wait === undefined) continue;
      const runtime = /^[a-z][a-z0-9-]{0,31}$/.test(r.runtime) ? r.runtime : 'runtime';
      for (const workerId of wait.workers.slice(0, 8)) {
        const dedupeKey = `runtime.login:${workerId}:${runtime}:${day}`.slice(0, 200);
        const memo = `${r.created_by_id}:${dedupeKey}`;
        if (this.#loginNoticed.has(memo)) continue;
        const named = await this.deps.pool.query<{ display_name: string }>(
          `SELECT display_name FROM workers WHERE id = $1`,
          [workerId],
        );
        const machine = named.rows[0]?.display_name ?? workerId;
        const label = LOGIN_RUNTIME_NAMES[runtime] ?? runtime;
        const inserted = await withTransaction(this.deps.pool, async (tx) => {
          const before = await tx.query(
            `SELECT 1 FROM notifications WHERE recipient_id = $1 AND dedupe_key = $2`,
            [r.created_by_id, dedupeKey],
          );
          if ((before.rowCount ?? 0) > 0) return false;
          await svc.notify(tx, [r.created_by_id], {
            kind: 'job.waiting',
            severity: 'warning',
            title: `${label} needs a login on ${machine}`.slice(0, 200),
            body: `Jobs that need ${label} are waiting (${r.project}). Log in again on ${machine}: Machines > ${machine} > Runtimes > Log in again. They start by themselves once the login works; after the wait time they fail.`.slice(
              0,
              1900,
            ),
            link: `/machines?${new URLSearchParams({ worker: workerId, section: 'remote-ops' }).toString()}`,
            dedupeKey,
          });
          await this.deps.audit.record(
            {
              actor: { type: 'system', id: 'queue' },
              action: 'job.login_wait.notify',
              target: `job:${r.id}`,
              outcome: 'success',
              metadata: { project: r.project, workerId, runtime },
            },
            tx,
          );
          return true;
        });
        this.#loginNoticed.add(memo);
        if (inserted) sent++;
      }
    }
    return sent;
  }
}

/** p10-claude-login-health: the runtime names of the login-wait notice. */
const LOGIN_RUNTIME_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

/** A job's pool: its sandbox profile, narrowed to one machine when it is pinned to exactly one. */
export function poolKey(spec: JobSpec): string {
  const workers = spec.requirements?.workers;
  return workers !== undefined && workers.length === 1
    ? `${spec.sandboxProfile}@${workers[0] ?? ''}`
    : spec.sandboxProfile;
}
