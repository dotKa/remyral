import {
  BACKSTOP_SLACK_SEC,
  type JobSpec,
  priorityClassOf,
  RUN_CLOCK_FEATURE,
  TIMEOUT_DELIVERY_GRACE_SEC,
} from '@remyral/protocol';
import {
  accountOf,
  checkJobLimits,
  concurrencyHolds,
  effectiveJobLimits,
  fairOrder,
  holdSummary,
  type JobLimits,
  type PlacementReason,
  type PlacementWorker,
  type ProviderPause,
  type QuotaHold,
  type QuotaPolicy,
  type ReasonSummary,
  pauseUntil,
  workerQuotaBlocks,
} from '@remyral/scheduler';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { IllegalTransitionError, VersionConflictError } from '../jobs/errors.js';
import type { JobRecord, JobStore } from '../jobs/store.js';
import type {
  AdmissionVerdict,
  DispatchAdmission,
  QueuedJobRow,
  TickStep,
} from '../orchestration/orchestrator.js';
import { overrideApplies, type BudgetRecord, type UsageStore } from '../usage/store.js';
import type { BudgetEvaluation } from '@remyral/usage';
import { localTime } from '../efficiency/text.js';
import type { Queryable } from '../db/pool.js';
import { type QuotaActor, QuotaError, type QuotaStore } from './store.js';

/** Sends CANCEL_JOB to the holder of a job's lease (Orchestrator.sendCancel). */
export interface CancelSender {
  sendCancel(job: { readonly id: string }, reason: string): Promise<boolean>;
}

export interface QuotaStatus {
  readonly policy: {
    readonly version: number;
    readonly policy: QuotaPolicy;
    readonly note: string | null;
    readonly createdBy: string | null;
    readonly createdAt: Date | null;
  };
  readonly projects: readonly {
    project: string;
    active: number;
    maxConcurrent: number | null;
    weight: number;
  }[];
  readonly runtimes: readonly { runtime: string; active: number; maxConcurrent: number | null }[];
  readonly accounts: readonly {
    id: string;
    runtime: string;
    provider: string | null;
    workers: string[];
    active: number;
    maxConcurrent: number | null;
  }[];
  readonly pauses: readonly {
    id: string;
    scope: 'worker_runtime' | 'account';
    workerId: string | null;
    runtime: string;
    accountId: string | null;
    workers: string[];
    pausedAt: Date;
    resumeAt: Date;
  }[];
  readonly holds: readonly { project: string; reason: string; heldBy: string; heldAt: Date }[];
  readonly budgets: readonly {
    id: string;
    name: string;
    scope: { type: string; value: string | null };
    metric: string;
    status: string;
    ratio: number;
    complete: boolean;
    enforcement: string;
  }[];
  readonly events: readonly {
    id: string;
    kind: string;
    project: string | null;
    jobId: string | null;
    workerId: string | null;
    code: string;
    message: string;
    createdAt: Date;
  }[];
}

/** Called after the kill switch cancelled a project's jobs (p4-dag cancels the project's workflow runs). */
export type KillHook = (project: string, actor: QuotaActor, reason: string) => Promise<void>;

export interface QuotaServiceDeps {
  readonly pool: Pool;
  readonly store: QuotaStore;
  readonly usage: UsageStore;
  readonly jobs: JobStore;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly cancel: () => CancelSender;
  /**
   * p16-ops-safety: the model cost brake — why a new non-urgent job of a project must wait (block mode, a spend ceiling
   * reached), or null. Absent: no brake.
   */
  readonly costBrake?: () => {
    jobBlocked(project: string): Promise<{ scope: string; window: string; windowEnd: string } | null>;
  } | null;
}

const QUOTA_ACTOR = { type: 'system', id: 'quota' } as const;
const RUNNING_STATES = new Set(['RESERVED', 'STARTING', 'RUNNING', 'VERIFYING', 'LOST']);
const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
const SCOPE_BUDGETS = new Set(['global', 'project', 'runtime']);

function pct(e: BudgetEvaluation): string {
  return `${String(Math.round(e.ratio * 100))} %`;
}

function budgetLabel(b: BudgetRecord): string {
  const scope = b.scope.value === null ? b.scope.type : `${b.scope.type} ${b.scope.value}`;
  return `budget "${b.name}" (${scope}, ${b.metric}/${b.window})`;
}

/** p8-cost-efficiency: "budget exhausted until <window end on the budget's clock>". */
function exhaustedUntil(b: BudgetRecord, e: BudgetEvaluation): string {
  return `budget exhausted until ${localTime(e.window.end, b.timeZone)}`;
}

/**
 * p8-cost-efficiency: whether a job was started by an automation — directly (automation_runs.job_id) or as a step of
 * a workflow run an automation started.
 */
export async function isAutomationJob(db: Queryable, jobId: string): Promise<boolean> {
  const { rows } = await db.query<{ automated: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM automation_runs WHERE job_id = $1)
         OR EXISTS (SELECT 1 FROM workflow_job_links n JOIN automation_runs ar ON ar.workflow_run_id = n.run_id
                     WHERE n.job_id = $1) AS automated`,
    [jobId],
  );
  return rows[0]?.automated === true;
}

type BudgetEntry = { readonly budget: BudgetRecord; readonly evaluation: BudgetEvaluation };

/** The job a budget decision is about (null id: a preview of a job a person would start). */
interface GateSubject {
  readonly jobId: string | null;
  readonly automated: () => Promise<boolean>;
}

/** Run limits of a job from its spec (`maxDurationSec` is the per-attempt wall-time limit). */
export function specLimits(spec: JobSpec): JobLimits {
  return {
    maxCostUsd: spec.limits.maxCostUsd,
    maxTokens: spec.limits.maxTokens,
    maxTurns: spec.limits.maxTurns,
    maxWallTimeSec: spec.limits.maxDurationSec,
  };
}

/**
 * p4-quotas enforcement (docs/design/p4-quotas.md): admission before dispatch (holds, concurrency, budgets,
 * provider pauses, fair order), runaway stops on usage events and wall time, provider-limit pauses, and
 * the project kill switch.
 */
export class QuotaService implements DispatchAdmission {
  readonly #killHooks: KillHook[] = [];

  constructor(private readonly deps: QuotaServiceDeps) {}

  onKill(hook: KillHook): void {
    this.#killHooks.push(hook);
  }

  // ------------------------------------------------------------------------------------- admission

  async order(queued: readonly QueuedJobRow[]): Promise<readonly string[]> {
    const { policy } = await this.deps.store.currentPolicy();
    const now = this.deps.clock();
    const load = await this.deps.store.recentStarts(
      new Date(now.getTime() - policy.fairness.windowSec * 1000),
    );
    for (const a of await this.deps.store.activeJobs()) load.set(a.project, (load.get(a.project) ?? 0) + 1);
    return fairOrder(queued, load, policy, now);
  }

  async admit(job: JobRecord): Promise<AdmissionVerdict> {
    const now = this.deps.clock();
    const { policy } = await this.deps.store.currentPolicy();
    const runtime = job.spec.runtime;
    const holds: QuotaHold[] = [];

    const hold = await this.deps.store.hold(job.project);
    if (hold !== null) {
      holds.push({
        code: 'project_hold',
        message: `project ${job.project} is on hold (kill switch by ${hold.heldBy}); an admin releases it`,
      });
    }
    // p14-workflow-engine 14.3: a function job starts no runtime and uses no provider — only the kill switch holds it.
    if (job.spec.kind === 'function') {
      return holds.length === 0 ? { kind: 'admit' } : { kind: 'hold', reasons: holdSummary(holds) };
    }
    const active = await this.deps.store.activeJobs();
    holds.push(...concurrencyHolds({ project: job.project, runtime }, active, policy));

    // Scope budgets (global / project / runtime): at or over 100 % → hold; incomplete → policy. p8: the budget's
    // hard-limit policy (warn / pause new / automations only) and owner/admin overrides decide which ones apply.
    const subject = this.#subject(job.id);
    const evaluations = await this.#binding(
      (await this.deps.usage.evaluateBudgetsFor({ project: job.project, runtime }, now)).filter((e) =>
        SCOPE_BUDGETS.has(e.budget.scope.type),
      ),
      subject,
      now,
    );
    for (const { budget, evaluation } of evaluations) {
      if (evaluation.status === 'over') {
        holds.push({
          code: 'budget_exceeded',
          message: `${budgetLabel(budget)} is at ${pct(evaluation)}: ${exhaustedUntil(budget, evaluation)}; ${
            budget.onExceeded === 'block_automations' ? 'automation jobs wait' : 'new jobs wait'
          } (or the budget is raised, or an owner/admin overrides it)`,
        });
      } else if (evaluation.status === 'unknown') {
        await this.#incomplete(budget, evaluation, policy, holds, job);
      }
    }

    // p16-ops-safety: the cost brake in block mode holds new non-urgent jobs over a spend ceiling (urgent ones pass).
    const brake = this.deps.costBrake?.() ?? null;
    if (brake !== null && priorityClassOf(job.priority) !== 'urgent') {
      const c = await brake.jobBlocked(job.project);
      if (c !== null) {
        holds.push({
          code: 'cost_brake',
          message: `the model cost brake is on: ${c.scope === 'global' ? 'all model usage' : `project ${c.scope}`} reached its ${c.window === 'day' ? 'daily' : 'monthly'} spend ceiling; non-urgent jobs wait until ${c.windowEnd} (or an owner lifts the brake)`,
          until: c.windowEnd,
        });
      }
    }

    if (holds.length > 0) {
      for (const h of holds) {
        await this.deps.store.recordEvent({
          kind: 'dispatch_held',
          code: h.code,
          message: h.message,
          project: job.project,
          jobId: job.id,
          runtime,
          dedupeKey: `held:${job.id}:${h.code}`,
        });
      }
      return { kind: 'hold', reasons: holdSummary(holds) };
    }

    // Worker-level exclusions: provider pauses, full provider accounts, worker/provider budgets. Reports
    // not yet turned into pauses by the loop are picked up first (no dispatch slips in between).
    await this.scanProviderLimits();
    return { kind: 'admit', adjust: await this.#workerAdjust(runtime, policy, active, now, subject) };
  }

  /** The gate subject of a queued job: automation origin looked up once, only when a budget needs it. */
  #subject(jobId: string | null): GateSubject {
    let cached: Promise<boolean> | null = null;
    return {
      jobId,
      automated: () => {
        if (jobId === null) return Promise.resolve(false);
        cached ??= isAutomationJob(this.deps.pool, jobId);
        return cached;
      },
    };
  }

  /**
   * p8-cost-efficiency: the over / incomplete budgets that bind this job: not `warn`, not overridden (for the whole
   * window or for this job), and for `block_automations` only when the job was started by an automation.
   */
  async #binding(entries: readonly BudgetEntry[], subject: GateSubject, now: Date): Promise<BudgetEntry[]> {
    const candidates = entries.filter(
      (e) =>
        (e.evaluation.status === 'over' || e.evaluation.status === 'unknown') &&
        e.budget.onExceeded !== 'warn',
    );
    if (candidates.length === 0) return [];
    const overrides = await this.deps.usage.activeOverrides(
      candidates.map((e) => e.budget.id),
      now,
    );
    const out: BudgetEntry[] = [];
    for (const e of candidates) {
      if (overrides.some((o) => overrideApplies(o, e.budget, now, subject.jobId))) continue;
      if (e.budget.onExceeded === 'block_automations' && !(await subject.automated())) continue;
      out.push(e);
    }
    return out;
  }

  /**
   * p8-cost-efficiency: why an automation run of `project` must not start now (a scope budget of the project — or a
   * global one — is exhausted and its policy pauses new jobs or blocks automations, with no override), or null.
   * Used by the automation service before it creates the run's job.
   */
  async automationBlocked(project: string, runtime: string | null): Promise<string | null> {
    const now = this.deps.clock();
    const entries = (
      await this.deps.usage.evaluateBudgetsFor(runtime === null ? { project } : { project, runtime }, now)
    ).filter((e) => SCOPE_BUDGETS.has(e.budget.scope.type) && e.evaluation.status === 'over');
    const binding = await this.#binding(
      entries,
      { jobId: null, automated: () => Promise.resolve(true) },
      now,
    );
    const first = binding[0];
    if (first === undefined) return null;
    return `${budgetLabel(first.budget)} is at ${pct(first.evaluation)}: ${exhaustedUntil(first.budget, first.evaluation)}`;
  }

  /**
   * p5-composer: what admission would decide for a job of `project` on `runtime` right now — job-level holds,
   * worker-level exclusions and the effective run limits — **without side effects** (no quota events, no
   * provider-limit scan, nothing recorded). Used by `POST /jobs/placement-preview`.
   */
  async preview(
    project: string,
    runtime: string,
  ): Promise<{
    readonly holds: readonly ReasonSummary[];
    readonly adjust: (workers: PlacementWorker[]) => PlacementWorker[];
    readonly limits: JobLimits;
  }> {
    const now = this.deps.clock();
    const { policy } = await this.deps.store.currentPolicy();
    const holds: QuotaHold[] = [];
    const hold = await this.deps.store.hold(project);
    if (hold !== null) {
      holds.push({
        code: 'project_hold',
        message: `project ${project} is on hold (kill switch by ${hold.heldBy})`,
      });
    }
    const active = await this.deps.store.activeJobs();
    holds.push(...concurrencyHolds({ project, runtime }, active, policy));
    // A preview is for a job a person starts (composer, chat): `block_automations` budgets do not hold it.
    const subject = this.#subject(null);
    for (const { budget, evaluation } of await this.#binding(
      (await this.deps.usage.evaluateBudgetsFor({ project, runtime }, now)).filter((e) =>
        SCOPE_BUDGETS.has(e.budget.scope.type),
      ),
      subject,
      now,
    )) {
      if (evaluation.status === 'over') {
        holds.push({
          code: 'budget_exceeded',
          message: `${budgetLabel(budget)} is at ${pct(evaluation)}: ${exhaustedUntil(budget, evaluation)}`,
        });
      } else if (evaluation.status === 'unknown' && policy.budgets.incomplete === 'block') {
        holds.push({
          code: 'budget_incomplete',
          message: `${budgetLabel(budget)} has usage records without the metric; policy blocks new jobs`,
        });
      }
    }
    return {
      holds: holdSummary(holds),
      adjust: await this.#workerAdjust(runtime, policy, active, now, subject),
      limits: effectiveJobLimits({}, policy.projects[project]?.jobLimits, policy.jobLimits),
    };
  }

  async #workerAdjust(
    runtime: string,
    policy: QuotaPolicy,
    active: Awaited<ReturnType<QuotaStore['activeJobs']>>,
    now: Date,
    subject: GateSubject,
  ): Promise<(workers: PlacementWorker[]) => PlacementWorker[]> {
    const pauses: ProviderPause[] = await this.deps.store.pauses({ activeAt: now });
    const workerBudgets = await this.#binding(
      await this.deps.usage.evaluateBudgetsOfScopes(['worker', 'provider'], now),
      subject,
      now,
    );
    const overWorkers = new Map<string, string>();
    const overProviders = new Map<string, string>();
    for (const { budget, evaluation } of workerBudgets) {
      const blocked =
        evaluation.status === 'over' ||
        (evaluation.status === 'unknown' && policy.budgets.incomplete === 'block');
      if (!blocked || budget.scope.value === null) continue;
      const msg = `${budgetLabel(budget)} is at ${pct(evaluation)}${evaluation.complete ? '' : ' (incomplete)'}`;
      (budget.scope.type === 'worker' ? overWorkers : overProviders).set(budget.scope.value, msg);
    }
    return (workers: PlacementWorker[]) =>
      workers.map((w) => {
        const blocks: PlacementReason[] = workerQuotaBlocks(w.id, runtime, policy, active, pauses, now);
        const workerBudget = overWorkers.get(w.id);
        if (workerBudget !== undefined) {
          blocks.push({ code: 'budget_exceeded', permanent: false, message: workerBudget });
        }
        const provider = accountOf(policy.accounts, w.id, runtime)?.provider;
        const providerBudget = provider === undefined ? undefined : overProviders.get(provider);
        if (providerBudget !== undefined) {
          blocks.push({ code: 'budget_exceeded', permanent: false, message: providerBudget });
        }
        return blocks.length === 0 ? w : { ...w, quotaBlocks: [...(w.quotaBlocks ?? []), ...blocks] };
      });
  }

  async #incomplete(
    budget: BudgetRecord,
    evaluation: BudgetEvaluation,
    policy: QuotaPolicy,
    holds: QuotaHold[],
    job: JobRecord,
  ): Promise<void> {
    const message = `${budgetLabel(budget)} is at least ${pct(evaluation)} but ${String(
      evaluation.unknownRecords,
    )} usage records lack the metric (p6-cost: unknown is not under)`;
    if (policy.budgets.incomplete === 'block') {
      holds.push({ code: 'budget_incomplete', message: `${message}; policy blocks new jobs` });
      return;
    }
    await this.deps.store.recordEvent({
      kind: 'incomplete_cost',
      code: 'budget_incomplete',
      message: `${message}; policy warns only`,
      project: budget.scope.type === 'project' ? budget.scope.value : job.project,
      jobId: job.id,
      runtime: job.spec.runtime,
      dedupeKey: `incomplete:${budget.id}:${String(budget.version)}:${evaluation.window.start.toISOString()}`,
      notify: true,
    });
  }

  // ------------------------------------------------------------------------------------- runaway stop

  /**
   * Checks a job's run limits after one of its usage events was recorded (every usage event). Exceeded →
   * cancel with reason `budget_exceeded` (durable CANCEL_JOB to the worker). Idempotent.
   */
  async onUsage(jobId: string): Promise<void> {
    const job = await this.deps.jobs.get(jobId);
    if (job === null || !RUNNING_STATES.has(job.state)) return;
    const { policy } = await this.deps.store.currentPolicy();
    const now = this.deps.clock();
    const limits = effectiveJobLimits(
      specLimits(job.spec),
      policy.projects[job.project]?.jobLimits,
      policy.jobLimits,
    );
    const hasLimit = Object.keys(limits).length > 0;
    if (hasLimit) {
      const s = await this.deps.usage.consumption({ jobId }, job.createdAt, new Date(now.getTime() + 1));
      const verdict = checkJobLimits(limits, {
        records: s.records,
        tokens: s.inputTokens + s.outputTokens,
        tokensUnknownRecords: s.tokensUnknownRecords,
        turns: s.turns,
        turnsUnknownRecords: s.turnsUnknownRecords,
        costUsd: s.costUsd.total,
        costComplete: s.flags.costComplete,
        wallTimeMs: await this.#attemptWallTime(job, now),
      });
      if (verdict.kind === 'exceeded') {
        await this.stopJob(job, 'budget_exceeded', verdict.message);
        return;
      }
      if (verdict.kind === 'incomplete') {
        const message = `${verdict.limit} ${String(verdict.used)} of ${String(verdict.max)} known, but some usage records lack the metric`;
        if (policy.budgets.incomplete === 'block') {
          await this.stopJob(job, 'budget_incomplete', `${message}; policy stops the job`);
          return;
        }
        await this.deps.store.recordEvent({
          kind: 'incomplete_cost',
          code: 'budget_incomplete',
          message: `${message}; policy warns only`,
          project: job.project,
          jobId: job.id,
          runtime: job.spec.runtime,
          dedupeKey: `incomplete-job:${job.id}:${verdict.limit}`,
          notify: true,
        });
      }
    }
    if (policy.budgets.onExceeded === 'stop_running') {
      const worker = await this.#currentWorker(job);
      const evaluations = await this.deps.usage.evaluateBudgetsFor(
        { project: job.project, runtime: job.spec.runtime, ...(worker === null ? {} : { worker }) },
        now,
      );
      // p8: only budgets whose policy pauses new jobs stop running ones (not warn / automations-only), and an
      // override for the window or this job spares it.
      const over = (
        await this.#binding(
          evaluations.filter((e) => e.evaluation.status === 'over' && e.budget.onExceeded === 'pause_new'),
          this.#subject(job.id),
          now,
        )
      )[0];
      if (over !== undefined) {
        await this.stopJob(
          job,
          'budget_exceeded',
          `${budgetLabel(over.budget)} is at ${pct(over.evaluation)} (policy stops running jobs)`,
        );
      }
    }
  }

  async #attemptWallTime(job: JobRecord, now: Date): Promise<number> {
    if (job.currentAttemptId === null) return 0;
    const { rows } = await this.deps.pool.query<{ started_at: Date }>(
      'SELECT started_at FROM job_attempts WHERE id = $1',
      [job.currentAttemptId],
    );
    const started = rows[0]?.started_at;
    return started === undefined ? 0 : Math.max(0, now.getTime() - started.getTime());
  }

  async #currentWorker(job: JobRecord): Promise<string | null> {
    if (job.currentAttemptId === null) return null;
    const { rows } = await this.deps.pool.query<{ worker_id: string }>(
      'SELECT worker_id FROM job_attempts WHERE id = $1',
      [job.currentAttemptId],
    );
    return rows[0]?.worker_id ?? null;
  }

  /** Cancels a running job for a quota reason (system actor) and tells its worker. */
  async stopJob(
    job: JobRecord,
    code: 'budget_exceeded' | 'budget_incomplete',
    message: string,
  ): Promise<boolean> {
    const reason = `${code}: ${message}`.slice(0, 1000);
    let state: string;
    try {
      const { job: next } = await this.deps.jobs.transition(job.id, 'cancel_requested', {
        actor: QUOTA_ACTOR,
        reason,
      });
      state = next.state;
    } catch (err) {
      // Another usage event (or a user) already stopped it.
      if (err instanceof IllegalTransitionError || err instanceof VersionConflictError) return false;
      throw err;
    }
    if (state === 'CANCELLING') await this.deps.cancel().sendCancel(job, reason);
    await this.deps.store.recordEvent({
      kind: 'job_stopped',
      code,
      message,
      project: job.project,
      jobId: job.id,
      runtime: job.spec.runtime,
      dedupeKey: `stopped:${job.id}`,
      notify: true,
    });
    this.deps.log.warn({ jobId: job.id, limitCode: code }, 'job stopped by a run limit');
    return true;
  }

  // ------------------------------------------------------------------------------------- loop steps

  steps(): readonly TickStep[] {
    return [
      { name: 'quota-provider-limits', run: () => this.scanProviderLimits() },
      { name: 'quota-wall-time', run: () => this.checkWallTime() },
    ];
  }

  /**
   * JOB_RESULTs failed with `provider_usage_limit` (ADR-0014 §5) pause scheduling of that runtime on that
   * worker — or of the whole provider account the pair belongs to — until the reported reset time (clamped)
   * or the default backoff. One pause per report (idempotent by attempt).
   */
  async scanProviderLimits(): Promise<number> {
    const { rows } = await this.deps.pool.query<{
      attempt_id: string;
      job_id: string;
      worker_id: string;
      project: string;
      runtime: string;
      reset_at: string | null;
    }>(
      `SELECT r.attempt_id, r.job_id, r.worker_id, j.project,
              COALESCE(r.runtime_choice->>'runtime', j.spec->>'runtime') AS runtime,
              r.result->'error'->>'resetAt' AS reset_at
         FROM job_runs r JOIN jobs j ON j.id = r.job_id
        WHERE r.result_outcome = 'failed' AND r.result->'error'->>'code' = 'provider_usage_limit'
          AND NOT EXISTS (SELECT 1 FROM quota_pauses p WHERE p.source_attempt_id = r.attempt_id)
          -- p11-usage-limit-fallback: limits the inbox already handled (episode, scoped pause) are not paused again.
          AND NOT EXISTS (SELECT 1 FROM usage_limit_hits h WHERE h.attempt_id = r.attempt_id)
        ORDER BY r.result_received_at LIMIT 50`,
    );
    if (rows.length === 0) return 0;
    const { policy } = await this.deps.store.currentPolicy();
    const now = this.deps.clock();
    let n = 0;
    for (const r of rows) {
      if (!/^[a-z0-9_-]{1,32}$/.test(r.runtime)) continue;
      const resetAt = r.reset_at === null ? null : new Date(r.reset_at);
      const until = pauseUntil(
        now,
        resetAt !== null && Number.isNaN(resetAt.getTime()) ? null : resetAt,
        policy,
      );
      const account = accountOf(policy.accounts, r.worker_id, r.runtime);
      const id = await this.deps.store.insertPause({
        scope: account === null ? 'worker_runtime' : 'account',
        workerId: account === null ? r.worker_id : null,
        runtime: r.runtime,
        accountId: account?.id ?? null,
        reason: `provider_usage_limit reported by ${r.worker_id} for job ${r.job_id}`,
        sourceAttemptId: r.attempt_id,
        sourceJobId: r.job_id,
        resumeAt: until,
        project: r.project,
        reportingWorker: r.worker_id,
      });
      if (id !== null) n++;
    }
    return n;
  }

  /**
   * Master-side wall-time backstop for running attempts (worker enforces `maxDurationSec` too). p22-timeout-continuity:
   * for a `run-clock-v1` worker it fires only {@link wallTimeGraceSec} after the limit.
   */
  async checkWallTime(): Promise<void> {
    const { policy } = await this.deps.store.currentPolicy();
    const now = this.deps.clock();
    // p10/p11: time an attempt spent paused (approval wait, usage-limit wait) does not count against its wall time.
    // p20-job-clock: nor the human waits the worker's run clock reported (in-run approvals, questions to a person) —
    // the last HEARTBEAT `runningJobs[].clock` of the attempt (absent from older workers: nothing subtracted).
    // p22-timeout-continuity: a worker with its own run clock (`run-clock-v1`) ends the run on its limit itself and then
    // gets the delivery grace to commit and push the unfinished work; its clock starts when the runtime starts (after
    // the checkout), so the backstop waits limit + grace + slack for it and stays the hard stop after that.
    const { rows } = await this.deps.pool.query<{
      id: string;
      started_at: Date;
      paused_sec: number;
      features: unknown;
    }>(
      `SELECT j.id, a.started_at, w.features,
              (COALESCE((SELECT sum(EXTRACT(EPOCH FROM (COALESCE(p.ended_at, $1) - p.paused_at)))
                          FROM job_pauses p WHERE p.attempt_id = a.id AND p.paused_at IS NOT NULL), 0)
               + COALESCE((a.run_clock->>'approvalWaitSec')::float8, 0)
               + COALESCE((a.run_clock->>'questionWaitSec')::float8, 0))::float8 AS paused_sec
         FROM jobs j JOIN job_attempts a ON a.id = j.current_attempt_id
         LEFT JOIN workers w ON w.id = a.worker_id
        WHERE j.state IN ('STARTING', 'RUNNING') ORDER BY a.started_at LIMIT 500`,
      [now],
    );
    for (const r of rows) {
      const job = await this.deps.jobs.get(r.id);
      if (job === null) continue;
      const limits = effectiveJobLimits(
        specLimits(job.spec),
        policy.projects[job.project]?.jobLimits,
        policy.jobLimits,
      );
      const max = limits.maxWallTimeSec;
      if (max === undefined) continue;
      const used = (now.getTime() - r.started_at.getTime()) / 1000 - Math.max(0, r.paused_sec);
      if (used >= max + wallTimeGraceSec(r.features)) {
        await this.stopJob(
          job,
          'budget_exceeded',
          `wall time ${String(Math.round(used))} s reached the job limit ${String(max)} s`,
        );
      }
    }
  }

  // ------------------------------------------------------------------------------------- status

  /** Enforcement status for the console (Usage → Enforcement, Fleet pauses). `projects` = visibility. */
  async status(projects: readonly string[] | null): Promise<QuotaStatus> {
    const now = this.deps.clock();
    const current = await this.deps.store.currentPolicy();
    const policy = current.policy;
    const visible = (p: string | null): boolean => projects === null || (p !== null && projects.includes(p));
    const active = await this.deps.store.activeJobs();
    const count = (pred: (a: (typeof active)[number]) => boolean): number => active.filter(pred).length;
    const projectNames = new Set([...Object.keys(policy.projects), ...active.map((a) => a.project)]);
    const budgets = await this.deps.usage.evaluateBudgetsOfScopes(
      ['global', 'project', 'runtime', 'worker', 'provider'],
      now,
    );
    return {
      policy: {
        version: current.version,
        policy,
        note: current.note,
        createdBy: current.createdBy,
        createdAt: current.createdAt,
      },
      projects: [...projectNames]
        .filter((p) => visible(p))
        .sort()
        .map((p) => ({
          project: p,
          active: count((a) => a.project === p),
          maxConcurrent: policy.projects[p]?.maxConcurrent ?? null,
          weight: policy.projects[p]?.weight ?? 1,
        })),
      runtimes: Object.entries(policy.runtimes).map(([runtime, r]) => ({
        runtime,
        active: count((a) => a.runtime === runtime),
        maxConcurrent: r.maxConcurrent ?? null,
      })),
      accounts: policy.accounts.map((a) => ({
        id: a.id,
        runtime: a.runtime,
        provider: a.provider ?? null,
        workers: [...a.workers],
        active: count(
          (x) => x.runtime === a.runtime && x.workerId !== null && a.workers.includes(x.workerId),
        ),
        maxConcurrent: a.maxConcurrent ?? null,
      })),
      pauses: (await this.deps.store.pauses({ activeAt: now })).map((p) => ({
        id: p.id,
        scope: p.scope,
        workerId: p.workerId,
        runtime: p.runtime,
        accountId: p.accountId,
        workers:
          p.scope === 'account'
            ? [...(policy.accounts.find((a) => a.id === p.accountId)?.workers ?? [])]
            : p.workerId === null
              ? []
              : [p.workerId],
        pausedAt: p.pausedAt,
        resumeAt: p.resumeAt,
      })),
      holds: (await this.deps.store.holds()).filter((h) => visible(h.project)),
      budgets: budgets
        .filter(({ budget }) => budget.scope.type !== 'project' || visible(budget.scope.value))
        .map(({ budget, evaluation }) => ({
          id: budget.id,
          name: budget.name,
          scope: budget.scope,
          metric: budget.metric,
          status: evaluation.status,
          ratio: evaluation.ratio,
          complete: evaluation.complete,
          enforcement:
            budget.onExceeded === 'warn' && (evaluation.status === 'over' || evaluation.status === 'unknown')
              ? 'warning only (policy)'
              : evaluation.status === 'over'
                ? budget.onExceeded === 'block_automations'
                  ? 'holding automation jobs'
                  : policy.budgets.onExceeded === 'stop_running'
                    ? 'holding new jobs and stopping running ones'
                    : 'holding new jobs'
                : evaluation.status === 'unknown'
                  ? policy.budgets.incomplete === 'block'
                    ? 'holding new jobs (incomplete figure)'
                    : 'warning (incomplete figure)'
                  : 'none',
        })),
      events: await this.deps.store.events({ limit: 100, projects }),
    };
  }

  // ------------------------------------------------------------------------------------- kill switch

  /**
   * Project kill switch: cancels every non-terminal job of the project (running ones through CANCELLING +
   * CANCEL_JOB), optionally holds dispatch for the project until released. Audited.
   */
  async killProject(
    project: string,
    actor: QuotaActor,
    input: { readonly reason: string; readonly hold: boolean },
  ): Promise<{ cancelled: number; cancelling: number; skipped: number; hold: boolean }> {
    if (!(await this.deps.store.projectExists(project))) {
      throw new QuotaError(404, 'project_not_found', 'Project not found.');
    }
    const reason = `kill_switch: ${input.reason}`.slice(0, 1000);
    if (input.hold)
      await this.deps.store.setHold(this.deps.pool, project, input.reason.slice(0, 1000), actor);
    // Hooks first (p4-dag cancels the project's workflow runs and their jobs), so no run reacts to its jobs
    // being cancelled one by one; jobs they already stopped count as `skipped` below.
    for (const hook of this.#killHooks) {
      await hook(project, actor, reason).catch((err: unknown) => {
        this.deps.log.error({ err, project }, 'kill switch hook failed');
      });
    }
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE project = $1 AND NOT (state = ANY($2::job_state[])) ORDER BY created_at`,
      [project, TERMINAL],
    );
    let cancelled = 0;
    let cancelling = 0;
    let skipped = 0;
    for (const r of rows) {
      let done = false;
      for (let i = 0; i < 3 && !done; i++) {
        try {
          const { job } = await this.deps.jobs.transition(r.id, 'cancel_requested', {
            actor: { type: actor.type, id: actor.id },
            reason,
          });
          if (job.state === 'CANCELLING') {
            cancelling++;
            await this.deps.cancel().sendCancel(job, reason);
          } else cancelled++;
          done = true;
        } catch (err) {
          if (err instanceof VersionConflictError) continue;
          if (err instanceof IllegalTransitionError) break; // already CANCELLING or terminal
          throw err;
        }
      }
      if (!done) skipped++;
    }
    await this.deps.store.recordEvent({
      kind: 'kill_switch',
      code: 'kill_switch',
      message: `kill switch by ${actor.id}: ${String(cancelled)} cancelled, ${String(cancelling)} stopping${
        input.hold ? ', dispatch held' : ''
      }`,
      project,
      notify: true,
    });
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'project.kill',
      target: `project:${project}`,
      outcome: 'success',
      metadata: { cancelled, cancelling, skipped, hold: input.hold },
    });
    return { cancelled, cancelling, skipped, hold: input.hold };
  }
}

/**
 * p22-timeout-continuity (docs/design/p22-timeout-continuity.md): how long past its limit the wall-time backstop lets an
 * attempt run (s). A worker with its own run clock (`run-clock-v1`) stops the run on its limit itself and then commits
 * and pushes the unfinished work within TIMEOUT_DELIVERY_GRACE_SEC; its clock starts after the checkout, so it gets the
 * grace plus BACKSTOP_SLACK_SEC. Older workers: none (the backstop stops them at the limit, as before).
 */
export function wallTimeGraceSec(features: unknown): number {
  const f = Array.isArray(features) ? (features as unknown[]) : [];
  return f.includes(RUN_CLOCK_FEATURE) ? TIMEOUT_DELIVERY_GRACE_SEC + BACKSTOP_SLACK_SEC : 0;
}
