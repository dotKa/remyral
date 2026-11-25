import type { ReasonSummary } from '@remyral/scheduler';
import type { FastifyBaseLogger } from 'fastify';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import type { JobRecord } from '../jobs/store.js';
import type { BaseRefHealer } from './base-ref.js';
import { listAutoEvents, recordAutoEvent, type AutoEvent } from './events.js';
import type { RepoAccessCode, RepoAccessPreflight, RepoAccessVerdict } from './repo-access.js';
import type { AutoRetryService, RetryDecision } from './retry.js';
import { PLATFORM_JOB_SQL } from '../verify/report-only.js';

/**
 * What dispatch does with a queued job before placing it: `hold` — it waits (its base is another job's result still
 * being made); `fail` (p22-git-preflight) — it can never read its repository: FAILED now, no runtime started.
 */
export type BeforeDispatch =
  | { readonly hold: readonly ReasonSummary[] }
  | { readonly fail: { readonly code: RepoAccessCode; readonly reason: string } };

/**
 * p15-auto-mode: the orchestrator's self-healing port (base ref before dispatch, automatic retries of lost attempts)
 * and the reads of the console (a job's automatic actions, the 24-hour failure digest).
 */
export class SelfHealService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly healer: BaseRefHealer;
      /** p22-git-preflight: the repository access check before dispatch (absent: none). */
      readonly repoAccess?: RepoAccessPreflight;
      readonly retry: AutoRetryService;
      readonly log: () => FastifyBaseLogger | null;
      readonly clock?: () => Date;
    },
  ) {}

  /**
   * Checked base refs (per process): a ref that exists is not asked again for 10 minutes, a job waiting for another
   * job's result is re-checked every 30 s — dispatch runs every tick for every queued job and must not turn into one
   * provider request per job and tick.
   */
  readonly #checked = new Map<
    string,
    { readonly until: number; readonly hold: readonly ReasonSummary[] | null }
  >();

  async beforeDispatch(job: JobRecord): Promise<BeforeDispatch | null> {
    const ref = job.spec.repository?.baseRef;
    if (ref === undefined) return null;
    // p22-git-preflight: a repository the job can never read fails here, before any machine starts a runtime.
    const access = this.deps.repoAccess === undefined ? null : await this.#repoAccess(job);
    if (access !== null) return access;
    const now = (this.deps.clock ?? (() => new Date()))().getTime();
    // p22-git-preflight: keyed by the current attempt too — a job back from a failed attempt (e.g. its base ref was not
    // found on the machine) is checked again instead of trusting the "exists" answer of its first dispatch.
    const key = `${job.id}\u0000${job.currentAttemptId ?? ''}\u0000${ref}`;
    const cached = this.#checked.get(key);
    if (cached !== undefined && cached.until > now)
      return cached.hold === null ? null : { hold: cached.hold };
    const out = await this.deps.healer.heal(job);
    if (this.#checked.size > 5_000) this.#checked.clear();
    if (out.kind === 'wait') {
      this.#checked.set(key, { until: now + 30_000, hold: out.reasons });
      return { hold: out.reasons };
    }
    if (out.kind === 'healed')
      this.deps
        .log()
        ?.info({ jobId: job.id, from: out.from, to: out.to, reason: out.reason }, 'base ref healed');
    else this.#checked.set(key, { until: now + 10 * 60_000, hold: null });
    return null;
  }

  /** The repository access preflight; a refusal is recorded on the job's timeline (`repo_access`) while it is queued. */
  async #repoAccess(job: JobRecord): Promise<BeforeDispatch | null> {
    const preflight = this.deps.repoAccess;
    if (preflight === undefined) return null;
    let verdict: RepoAccessVerdict;
    try {
      verdict = await preflight.check(job);
    } catch (err) {
      this.deps.log()?.warn({ err, jobId: job.id }, 'repository access preflight failed; dispatching anyway');
      return null;
    }
    if (verdict.ok) return null;
    const now = (this.deps.clock ?? (() => new Date()))();
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1 FOR UPDATE', [
        job.id,
      ]);
      if (rows[0]?.state !== 'QUEUED') return;
      await recordAutoEvent(tx, {
        jobId: job.id,
        kind: 'repo_access',
        detail: { code: verdict.code, why: verdict.why, via: verdict.via, host: verdict.host.slice(0, 255) },
        at: now,
        cap: 5,
      });
    });
    this.deps
      .log()
      ?.info(
        { jobId: job.id, code: verdict.code, why: verdict.why },
        'repository access preflight refused the job',
      );
    return { fail: { code: verdict.code, reason: verdict.reason } };
  }

  async retryLost(input: {
    readonly jobId: string;
    readonly attemptId: string;
    readonly workerId: string;
    readonly reason: string;
  }): Promise<RetryDecision | null> {
    return withTransaction(this.deps.pool, (tx) =>
      this.deps.retry.decideWithin(tx, {
        jobId: input.jobId,
        attemptId: input.attemptId,
        workerId: input.workerId,
        phase: 'lost',
        code: null,
        message: input.reason,
      }),
    );
  }

  /** A job's automatic actions and its retry state (job page). */
  async jobView(jobId: string): Promise<JobAutonomyView> {
    return jobAutonomy(this.deps.pool, jobId, (this.deps.clock ?? (() => new Date()))());
  }

  /** The 24-hour failure digest of the projects `projects` (null: all). */
  async digest(projects: readonly string[] | null): Promise<FailureDigest> {
    return failureDigest(this.deps.pool, projects, (this.deps.clock ?? (() => new Date()))());
  }
}

export interface JobAutonomyView {
  readonly retry: {
    readonly used: number;
    readonly max: number;
    readonly cause: string;
    readonly retryAt: string | null;
    readonly waiting: boolean;
  } | null;
  readonly fix: {
    readonly fixJobId: string | null;
    readonly state: string;
    readonly reason: string | null;
  } | null;
  readonly fixOf: string | null;
  /** p22-conflict-resolve: the conflict-resolution job of this job (null: none), and the job this one resolves. */
  readonly conflictResolve: {
    readonly resolveJobId: string | null;
    readonly state: 'created' | 'skipped' | 'merged' | 'failed';
    readonly reason: string | null;
    readonly prClosed: boolean;
  } | null;
  readonly conflictResolveOf: string | null;
  /** The verified result conflicts with its target and "Çakışmayı çöz" applies now (no resolution open or merged). */
  readonly conflictResolvable: boolean;
  readonly events: readonly AutoEvent[];
}

export async function jobAutonomy(db: Queryable, jobId: string, now: Date): Promise<JobAutonomyView> {
  const r = await db.query<{
    number: number;
    max_attempts: number;
    cause: string;
    retry_at: Date;
    state: string;
  }>(
    `SELECT r.number, r.max_attempts, r.cause, r.retry_at, j.state
       FROM job_auto_retries r JOIN jobs j ON j.id = r.job_id
      WHERE r.job_id = $1 ORDER BY r.number DESC LIMIT 1`,
    [jobId],
  );
  const last = r.rows[0];
  const f = await db.query<{ fix_job_id: string | null; state: string; reason: string | null }>(
    'SELECT fix_job_id::text AS fix_job_id, state, reason FROM job_auto_fixes WHERE source_job_id = $1',
    [jobId],
  );
  const of = await db.query<{ source_job_id: string }>(
    'SELECT source_job_id::text AS source_job_id FROM job_auto_fixes WHERE fix_job_id = $1',
    [jobId],
  );
  const fix = f.rows[0];
  const c = await db.query<{
    resolve_job_id: string | null;
    state: 'created' | 'skipped' | 'merged' | 'failed';
    reason: string | null;
    pr_closed: boolean;
  }>(
    `SELECT resolve_job_id::text AS resolve_job_id, state, reason, pr_closed
       FROM job_conflict_resolutions WHERE source_job_id = $1`,
    [jobId],
  );
  const cOf = await db.query<{ source_job_id: string }>(
    'SELECT source_job_id::text AS source_job_id FROM job_conflict_resolutions WHERE resolve_job_id = $1',
    [jobId],
  );
  const cr = c.rows[0];
  const can = await db.query<{ yes: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM jobs j JOIN job_git g ON g.job_id = j.id
                     WHERE j.id = $1 AND g.verification = 'passed' AND g.merge_state = 'conflicts'
                       AND g.merged_sha IS NULL AND g.head_sha IS NOT NULL
                       AND (j.state = 'AWAITING_APPROVAL' OR (j.state = 'SUCCEEDED' AND g.pr_number IS NOT NULL))
                       AND NOT EXISTS (SELECT 1 FROM job_conflict_resolutions x
                                        WHERE x.source_job_id = j.id AND x.state IN ('created', 'merged'))) AS yes`,
    [jobId],
  );
  return {
    retry:
      last === undefined
        ? null
        : {
            used: last.number,
            max: last.max_attempts,
            cause: last.cause,
            retryAt: last.retry_at.toISOString(),
            waiting: last.state === 'RETRY_WAIT' && last.retry_at.getTime() > now.getTime(),
          },
    fix:
      fix === undefined || fix.state === 'skipped'
        ? null
        : { fixJobId: fix.fix_job_id, state: fix.state, reason: fix.reason },
    fixOf: of.rows[0]?.source_job_id ?? null,
    conflictResolve:
      cr === undefined
        ? null
        : { resolveJobId: cr.resolve_job_id, state: cr.state, reason: cr.reason, prClosed: cr.pr_closed },
    conflictResolveOf: cOf.rows[0]?.source_job_id ?? null,
    conflictResolvable: can.rows[0]?.yes === true,
    events: await listAutoEvents(db, jobId),
  };
}

export interface FailureDigest {
  readonly since: string;
  /** Jobs that ended FAILED in the window. */
  readonly failed: number;
  /** Jobs the platform helped by itself (retry, base ref, rebase, auto-fix) that then succeeded. */
  readonly healed: number;
  /** Decisions waiting for a person: pending approvals, deploys awaiting approval, merge decisions. */
  readonly waiting: number;
}

/**
 * "Son 24 saat: X başarısız · Y kendiliğinden düzeldi · Z senden bekliyor". `healed` counts a job once: it succeeded in
 * the window after an automatic action of its own, or it is the source of an auto-fix job that succeeded.
 */
export async function failureDigest(
  db: Queryable,
  projects: readonly string[] | null,
  now: Date,
): Promise<FailureDigest> {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const scope = projects === null ? 'true' : 'j.project = ANY($2::text[])';
  const params: unknown[] = projects === null ? [since] : [since, projects];
  const failed = await db.query<{ n: number }>(
    // p19-verifier-jobs: platform verifier jobs are not failed work (the checked job's verification says it).
    `SELECT count(*)::int AS n FROM jobs j WHERE j.state = 'FAILED' AND j.state_changed_at >= $1 AND ${scope}
        AND NOT ${PLATFORM_JOB_SQL('j')}`,
    params,
  );
  const healed = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs j
      WHERE ${scope} AND (
        (j.state = 'SUCCEEDED' AND j.state_changed_at >= $1
          AND EXISTS (SELECT 1 FROM job_auto_events e WHERE e.job_id = j.id
                       AND e.kind IN ('auto_retry', 'base_ref', 'auto_rebase')))
        OR EXISTS (SELECT 1 FROM job_auto_fixes f WHERE f.source_job_id = j.id AND f.state = 'succeeded'
                    AND f.finished_at >= $1))`,
    params,
  );
  const own = projects === null ? 'true' : 'j.project = ANY($1::text[])';
  const waiting = await db.query<{ n: number }>(
    `SELECT ((SELECT count(*) FROM approval_requests r JOIN jobs j ON j.id = r.job_id
               WHERE r.status = 'pending' AND ${own})
           + (SELECT count(*) FROM ops_actions j WHERE j.state = 'awaiting_approval' AND ${own}))::int AS n`,
    projects === null ? [] : [projects],
  );
  return {
    since: since.toISOString(),
    failed: failed.rows[0]?.n ?? 0,
    healed: healed.rows[0]?.n ?? 0,
    waiting: waiting.rows[0]?.n ?? 0,
  };
}
