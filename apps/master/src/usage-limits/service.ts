import {
  ACCOUNT_SWITCH_CAUSE,
  type AccountSwitchResume,
  credentialKey,
  DEFAULT_ACCOUNT_ID,
  decideUsageLimitAction,
  RUNTIME_ACCOUNTS_FEATURE,
  type JobPausedReport,
  type JobSpec,
  jobRoleOf,
  type RuntimeKind,
  USAGE_LIMIT_PARK_FEATURE,
  type UsageLimitAction,
  type UsageLimitInfo,
  type UsageLimitPolicy,
  type UsageLimitResume,
  type UsageLimitScope,
  usageLimitJitterMs,
} from '@remyral/protocol';
import {
  accountOf,
  type JobState,
  type PlacementReason,
  type PlacementWorker,
  pauseUntil,
  type QuotaPolicy,
  type ReasonSummary,
} from '@remyral/scheduler';
import type pg from 'pg';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { IllegalTransitionError, VersionConflictError } from '../jobs/errors.js';
import type { JobRecord, JobStore } from '../jobs/store.js';
import { resolveJobModel } from '../models/job-model.js';
import {
  fallbackSpec,
  type RuntimeChoice,
  runtimeChoice,
  type SpecOption,
} from '../quota-scheduling/runtime-options.js';
import type { QuotaStore } from '../quotas/store.js';
import type { WorkerReplay } from '../workers/replay.js';
import { effectivePolicy } from './policy.js';
import type { RuntimeAccountService } from '../runtime-accounts/service.js';

/**
 * p11-usage-limit-fallback (docs/design/p11-usage-limit-fallback.md, ADR-0040): what happens when a runtime hits its
 * provider's usage limit.
 *
 * - **inbox** ({@link UsageLimitService.onLimitedResultWithin}, inside the JOB_RESULT transaction): records the hit,
 *   opens or extends the store's episode (first hit → one notification), pauses the store / account for the scheduler,
 *   decides wait / fallback / fail from the project's policy and moves the job: parked on its machine (PAUSED, resumes
 *   by itself), requeued as a new attempt (RETRY_WAIT until the reset, or at once for a fallback), or failed.
 * - **dispatch** ({@link UsageLimitService.options} / {@link UsageLimitService.gate} / `mayFallThrough`): the job's
 *   runtime options including the policy's fallbacks, the paid-fallback guard, credential / model-scoped holds.
 * - **tick**: episodes that reset end (one "reset" notification), parked waits whose time came are resumed, parked
 *   attempts that cannot resume on their machine are restarted elsewhere (never cancelled by the wait).
 * - **resume** (orchestrator "resume-paused"): the parked attempt continues on its machine with the same runtime or a
 *   fallback one in the same workspace.
 */

export const OUTBOX_TOPIC_USAGE_LIMIT = 'usage_limit';
export const UsageLimitOutboxPayload = z.strictObject({
  event: z.enum(['reached', 'reset']),
  episodeId: z.uuid(),
});
export type UsageLimitOutboxPayload = z.infer<typeof UsageLimitOutboxPayload>;

const SYSTEM = { type: 'system', id: 'usage-limit' } as const;

/** p19-limit-clear: the person who cleared a limit (audit). */
export interface ClearActor {
  readonly userId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}
const DAY_MS = 24 * 3600 * 1000;
const MAX_RETAIN_MS = 7 * DAY_MS;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/;

type Tx = pg.PoolClient;

const RUNTIME_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};
export function runtimeName(runtime: string): string {
  return RUNTIME_NAMES[runtime] ?? runtime;
}

/** One runtime option of a job, with where it came from and whether it bills per token. */
export interface UsageLimitOption extends SpecOption {
  readonly origin: 'job' | 'spec' | 'policy';
  /** The option brings an API-key credential (a model profile with `credentialRef`): billed per token. */
  readonly paid: boolean;
}

/** The JOB_RESULT of a limited run, as the inbox hands it over (fence already checked: live lease). */
export interface LimitedResult {
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: number;
  readonly workerId: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly resetAt?: string | undefined;
    readonly usageLimit?: UsageLimitInfo | undefined;
  };
  readonly paused: JobPausedReport | null;
}

/** A resume of a parked usage-limit attempt, prepared for the orchestrator. */
export interface PreparedUsageResume {
  readonly pauseId: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly resume: UsageLimitResume | AccountSwitchResume;
  /** Options to try on that machine, in order (the fallbacks first in fallback mode; the limited runtime last). */
  readonly options: readonly {
    readonly spec: JobSpec;
    readonly choice: RuntimeChoice | null;
    readonly label: string;
  }[];
  /** Fallback mode: when no option can start on that machine (and none is merely busy), restart elsewhere. */
  readonly restartIfNotPlaced: boolean;
}

/** An open episode (a limit known for a store / credential / model). */
export interface UsageLimitEpisodeView {
  readonly id: string;
  readonly scope: UsageLimitScope;
  readonly pauseScope: 'worker_runtime' | 'account' | 'credential';
  readonly workerId: string | null;
  readonly workerName: string | null;
  readonly runtime: string;
  readonly accountId: string | null;
  /** p13-runtime-accounts: the runtime account of a machine whose limit this is (null: the machine runtime). */
  readonly runtimeAccount: string | null;
  readonly credential: string | null;
  readonly store: string | null;
  readonly model: string | null;
  readonly kind: string | null;
  readonly resetAt: string | null;
  readonly resumeAt: string;
  readonly since: string;
  readonly lastHitAt: string;
  readonly hits: number;
  readonly project: string | null;
  readonly message: string | null;
}

interface EpisodeRow {
  id: string;
  scope_key: string;
  runtime_account: string | null;
  scope: UsageLimitScope;
  pause_scope: 'worker_runtime' | 'account' | 'credential';
  worker_id: string | null;
  runtime: string;
  account_id: string | null;
  credential_key: string | null;
  store: string | null;
  model: string | null;
  kind: string | null;
  reset_at: Date | null;
  resume_at: Date;
  started_at: Date;
  last_hit_at: Date;
  hits: number;
  project: string | null;
  message: string | null;
}

interface UsagePauseRow {
  id: string;
  job_id: string;
  attempt_id: string;
  worker_id: string;
  paused_epoch: number;
  status: string;
  resume_at: Date;
  retain_until: Date;
  active_ms: number;
  blocked_reason: string | null;
  usage_limit: { runtime?: string; resetAt?: string | null } | null;
  resume_options: StoredOption[] | null;
  ended_at: Date | null;
  /** p13-runtime-accounts: `usage_limit` or `account_switch` (a person moved the job to another account). */
  cause: 'usage_limit' | 'account_switch';
}

/** A resume option as stored on the pause episode. */
const StoredOption = z.object({
  runtime: z.string(),
  index: z.number().int().min(0),
  origin: z.enum(['job', 'spec', 'policy']),
  model: z.string().optional(),
  profile: z.string().optional(),
  limited: z.boolean().optional(),
  /** p13-runtime-accounts: continue with this runtime account (same runtime, another account; or a manual switch). */
  account: z
    .string()
    .regex(/^[a-z0-9]{1,12}$/)
    .optional(),
});
type StoredOption = z.infer<typeof StoredOption>;

export interface UsageLimitServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly jobs: JobStore;
  readonly quotas: QuotaStore;
  readonly replay: () => WorkerReplay;
  readonly clock?: () => Date;
  /** Ask the dispatcher to look at a job now (after a restart elsewhere). */
  readonly dispatch?: (jobId: string) => void;
  /** p13-runtime-accounts: the machines' runtime accounts (account-scoped limits, "another account" fallback). */
  readonly accounts?: () => RuntimeAccountService | null;
}

export class UsageLimitService {
  private readonly clock: () => Date;

  constructor(private readonly deps: UsageLimitServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  // ------------------------------------------------------------------------------------------- options

  /**
   * The runtime options of a job in order: its own spec, then `spec.fallbacks` (explicit, p6) or — when it names none
   * and the policy may fall back (`auto` / `fallback`) — the policy's fallbacks resolved like a submission. Without
   * `allowPaidFallback`, fallbacks that bring an API-key credential are left out.
   */
  async options(
    job: Pick<JobRecord, 'id' | 'project' | 'spec'>,
    db: Queryable = this.deps.pool,
  ): Promise<UsageLimitOption[]> {
    const { policy } = await effectivePolicy(db, job.project);
    return this.#options(db, job, policy);
  }

  async #options(
    db: Queryable,
    job: Pick<JobRecord, 'id' | 'project' | 'spec'>,
    policy: UsageLimitPolicy,
  ): Promise<UsageLimitOption[]> {
    const spec = job.spec;
    const out: UsageLimitOption[] = [
      {
        index: 0,
        runtime: spec.runtime,
        spec,
        origin: 'job',
        paid: spec.modelProfile?.credentialRef !== undefined,
      },
    ];
    const allowPaid = policy.allowPaidFallback;
    if (spec.fallbacks !== undefined) {
      spec.fallbacks.forEach((f, i) => {
        const paid = f.modelProfile?.credentialRef !== undefined;
        if (paid && !allowPaid) return;
        out.push({ index: i + 1, runtime: f.runtime, spec: fallbackSpec(spec, f), origin: 'spec', paid });
      });
      return out;
    }
    if (policy.mode !== 'auto' && policy.mode !== 'fallback') return out;
    const role = jobRoleOf(spec).role;
    const seen = new Set([optionKey(spec)]);
    let index = 1;
    for (const f of policy.fallbacks) {
      const r = await resolveJobModel(db, job.project, f.runtime, f.model, role);
      const optSpec = fallbackSpec(spec, {
        runtime: f.runtime,
        ...(r.model === undefined ? {} : { model: r.model }),
        ...(r.modelProfile === undefined ? {} : { modelProfile: r.modelProfile }),
        ...(r.defaultModel === undefined ? {} : { defaultModel: r.defaultModel }),
      });
      const key = optionKey(optSpec);
      if (seen.has(key)) continue;
      seen.add(key);
      const paid = optSpec.modelProfile?.credentialRef !== undefined;
      if (paid && !allowPaid) continue;
      out.push({ index, runtime: f.runtime, spec: optSpec, origin: 'policy', paid });
      index += 1;
    }
    return out;
  }

  /** The spec the job's current attempt runs with. */
  async attemptSpec(job: Pick<JobRecord, 'project' | 'spec' | 'currentAttemptId'>): Promise<JobSpec> {
    if (job.currentAttemptId === null) return job.spec;
    const { rows } = await this.deps.pool.query<{ runtime_choice: RuntimeChoice | null }>(
      'SELECT runtime_choice FROM job_runs WHERE attempt_id = $1',
      [job.currentAttemptId],
    );
    return this.specForChoice(this.deps.pool, job, rows[0]?.runtime_choice ?? null);
  }

  /** The spec an attempt ran with (its recorded runtime choice), re-resolved for a policy option. */
  async specForChoice(
    db: Queryable,
    job: Pick<JobRecord, 'project' | 'spec'>,
    choice: RuntimeChoice | null,
  ): Promise<JobSpec> {
    if (choice === null || choice.index === 0) return job.spec;
    if (choice.origin !== 'policy') {
      const f = job.spec.fallbacks?.[choice.index - 1];
      if (f !== undefined && f.runtime === choice.runtime) return fallbackSpec(job.spec, f);
    }
    const runtime = choice.runtime as RuntimeKind;
    const r = await resolveJobModel(
      db,
      job.project,
      runtime,
      choice.modelProfile ?? choice.model,
      jobRoleOf(job.spec).role,
    );
    return fallbackSpec(job.spec, {
      runtime,
      ...(r.model === undefined ? {} : { model: r.model }),
      ...(r.modelProfile === undefined ? {} : { modelProfile: r.modelProfile }),
      ...(r.defaultModel === undefined ? {} : { defaultModel: r.defaultModel }),
    });
  }

  // ------------------------------------------------------------------------------------------- dispatch gate

  /**
   * Holds and machine blocks of one option of a job (dispatch): a credential at its limit holds the option (`usage_limited`,
   * a runtime-level hold — the next option is tried); a model-scoped limit of a machine's store and a machine-store
   * credential at its limit block that machine; a fallback that would bill per token on a machine whose runtime uses an
   * API key there is blocked (`paid_fallback_not_allowed`) unless the policy allows paid fallbacks.
   */
  async gate(
    job: Pick<JobRecord, 'project'>,
    option: Pick<UsageLimitOption, 'index' | 'runtime' | 'spec'>,
  ): Promise<{
    readonly hold: readonly ReasonSummary[] | null;
    readonly adjust: ((workers: PlacementWorker[]) => PlacementWorker[]) | null;
  }> {
    const now = this.clock();
    const episodes = await this.#openEpisodes(option.runtime, now);
    const { policy } = await effectivePolicy(this.deps.pool, job.project);
    const model = modelOf(option.spec);
    const cred = option.spec.modelProfile?.credentialRef;
    const matchesModel = (e: EpisodeRow): boolean => e.model === null || e.model === model;
    if (cred !== undefined && cred.source === 'vault') {
      const key = credentialKey(cred, '');
      const e = episodes.find(
        (x) => x.pause_scope === 'credential' && x.credential_key === key && matchesModel(x),
      );
      if (e !== undefined) {
        return {
          hold: [
            {
              code: 'usage_limited',
              permanent: false,
              message: `the ${runtimeName(option.runtime)} API credential is at its usage limit until ${e.resume_at.toISOString()}`,
              workers: [],
              until: e.resume_at.toISOString(),
            },
          ],
          adjust: null,
        };
      }
    }
    const blocks = new Map<string, PlacementReason[]>();
    const add = (workerId: string, r: PlacementReason): void => {
      const list = blocks.get(workerId) ?? [];
      list.push(r);
      blocks.set(workerId, list);
    };
    for (const e of episodes) {
      if (e.worker_id === null) continue;
      const storeCred =
        cred !== undefined &&
        cred.source === 'worker-store' &&
        e.credential_key === credentialKey(cred, e.worker_id);
      // p13-runtime-accounts: an account's limit holds only that account (placement facts), not the machine.
      const modelScoped =
        e.pause_scope === 'worker_runtime' &&
        e.runtime_account === null &&
        e.model !== null &&
        e.model === model &&
        cred === undefined;
      if (storeCred || modelScoped) {
        add(e.worker_id, {
          code: 'usage_limited',
          permanent: false,
          message: `${runtimeName(option.runtime)}${e.model === null ? '' : ` (${e.model})`} is at its usage limit on this machine until ${e.resume_at.toISOString()}`,
          until: e.resume_at.toISOString(),
        });
      }
    }
    const guardPaid = option.index > 0 && !policy.allowPaidFallback && cred === undefined;
    if (blocks.size === 0 && !guardPaid) return { hold: null, adjust: null };
    return {
      hold: null,
      adjust: (workers) =>
        workers.map((w) => {
          const extra: PlacementReason[] = [...(blocks.get(w.id) ?? [])];
          if (guardPaid && w.localLogin !== undefined && !w.localLogin.runtimes.includes(option.runtime)) {
            extra.push({
              code: 'paid_fallback_not_allowed',
              permanent: true,
              message: `${runtimeName(option.runtime)} runs with an API key on this machine (billed per token); the project does not allow paid fallbacks`,
            });
          }
          return extra.length === 0 ? w : { ...w, quotaBlocks: [...(w.quotaBlocks ?? []), ...extra] };
        }),
    };
  }

  /**
   * `auto` mode: a job whose option is only held by a usage limit that resets within `maxWaitHours` (a reset the runtime
   * reported) waits for it instead of moving on to the policy's fallbacks. Explicit `spec.fallbacks` keep the p6 rule.
   */
  async mayFallThrough(
    job: Pick<JobRecord, 'project'>,
    current: Pick<UsageLimitOption, 'runtime'>,
    next: Pick<UsageLimitOption, 'origin'>,
    reasons: readonly ReasonSummary[],
  ): Promise<boolean> {
    if (next.origin !== 'policy') return true;
    const { policy } = await effectivePolicy(this.deps.pool, job.project);
    if (policy.mode !== 'auto') return true;
    const now = this.clock();
    const horizon = now.getTime() + policy.maxWaitHours * 3_600_000;
    const soon = reasons.some(
      (r) =>
        (r.code === 'provider_paused' || r.code === 'usage_limited') &&
        r.until !== undefined &&
        Date.parse(r.until) <= horizon,
    );
    if (!soon) return true;
    const known = (await this.#openEpisodes(current.runtime, now)).some(
      (e) => e.reset_at !== null && e.reset_at.getTime() <= horizon,
    );
    return !known;
  }

  /**
   * ASSIGN_JOB `execution.usageLimitPark`: park instead of release when the run ends on a usage limit — for workers that
   * can, unless the project's policy fails such jobs. Null: no parking (the worker releases as before).
   */
  async parkFor(
    job: Pick<JobRecord, 'project' | 'spec'>,
    workerId: string,
  ): Promise<{ retainUntil: string } | null> {
    if (job.spec.kind === 'machine-admin') return null;
    const { policy } = await effectivePolicy(this.deps.pool, job.project);
    if (policy.mode === 'fail') return null;
    const { rows } = await this.deps.pool.query<{ ok: boolean }>(
      'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
      [workerId, USAGE_LIMIT_PARK_FEATURE],
    );
    if (rows[0]?.ok !== true) return null;
    return { retainUntil: new Date(this.clock().getTime() + MAX_RETAIN_MS).toISOString() };
  }

  // ------------------------------------------------------------------------------------------- inbox

  /**
   * A JOB_RESULT that failed with `provider_usage_limit` under the live lease of a RUNNING / STARTING job (inside the
   * inbox transaction). Returns false when it is not ours to handle (the caller then applies the old behaviour).
   */
  async onLimitedResultWithin(tx: Tx, r: LimitedResult): Promise<boolean> {
    const now = this.clock();
    const { rows: jobRows } = await tx.query<{
      project: string;
      spec: JobSpec;
      state: JobState;
      runtime_choice: RuntimeChoice | null;
      account_pin: { workerId?: string; account?: string } | null;
    }>(
      `SELECT j.project, j.spec, j.state, x.runtime_choice, j.account_pin
         FROM jobs j LEFT JOIN job_runs x ON x.attempt_id = $2
        WHERE j.id = $1 FOR UPDATE OF j`,
      [r.jobId, r.attemptId],
    );
    const job = jobRows[0];
    if (job === undefined || (job.state !== 'RUNNING' && job.state !== 'STARTING')) return false;
    const record = { id: r.jobId, project: job.project, spec: job.spec };
    const attemptSpec = await this.specForChoice(tx, record, job.runtime_choice);
    const runtime = attemptSpec.runtime;
    const info = r.error.usageLimit;
    const resetAt = validDate(r.error.resetAt);
    const quota = (await this.deps.quotas.currentPolicy(tx)).policy;
    const resumeAt = pauseUntil(now, resetAt, quota);

    // What the limit applies to.
    const cred = attemptSpec.modelProfile?.credentialRef;
    const modelScoped = info?.scope === 'model';
    const reported = info?.model;
    const ownModel = modelOf(attemptSpec);
    const model = modelScoped ? (reported ?? ownModel ?? null) : null;
    const scope: UsageLimitScope = info?.scope ?? (cred !== undefined ? 'api_credential' : 'subscription');
    let pauseScope: 'worker_runtime' | 'account' | 'credential';
    let scopeKey: string;
    let accountId: string | null = null;
    let credKey: string | null = null;
    // p13-runtime-accounts: the attempt ran with one runtime account of its machine (no model-profile key): the limit
    // belongs to that account (a subscription: its own episode; an API key: its vault credential) and the machine's
    // other accounts keep working — no runtime-wide provider pause.
    const runtimeAccount = cred === undefined ? (job.runtime_choice?.account ?? null) : null;
    const accountsSvc = this.deps.accounts?.() ?? null;
    const limitedAccount =
      runtimeAccount === null || accountsSvc === null
        ? null
        : await accountsSvc.get(r.workerId, runtime, runtimeAccount);
    if (cred !== undefined && scope !== 'subscription') {
      pauseScope = 'credential';
      credKey = credentialKey(cred, r.workerId);
      scopeKey = `credential:${credKey}${model === null ? '' : `:${model}`}`;
    } else if (
      runtimeAccount !== null &&
      limitedAccount?.kind === 'api_key' &&
      limitedAccount.credentialId !== null
    ) {
      pauseScope = 'credential';
      credKey = `vault:${limitedAccount.credentialId}`;
      scopeKey = `credential:${credKey}${model === null ? '' : `:${model}`}`;
    } else if (runtimeAccount !== null) {
      pauseScope = 'worker_runtime';
      scopeKey = `worker:${r.workerId}:${runtime}@${runtimeAccount}${model === null ? '' : `:${model}`}`;
    } else {
      const account = model === null ? accountOf(quota.accounts, r.workerId, runtime) : null;
      if (account !== null) {
        pauseScope = 'account';
        accountId = account.id;
        scopeKey = `account:${account.id}:${runtime}`;
      } else {
        pauseScope = 'worker_runtime';
        scopeKey = `worker:${r.workerId}:${runtime}${model === null ? '' : `:${model}`}`;
      }
    }

    // The episode of that store (first hit notifies; later hits extend it).
    const episode = await this.#hitEpisode(tx, {
      scopeKey,
      scope,
      pauseScope,
      workerId: pauseScope === 'credential' && cred?.source === 'vault' ? null : r.workerId,
      runtime,
      accountId,
      credKey,
      store: info?.store ?? null,
      model,
      kind: info?.kind ?? null,
      resetAt,
      resumeAt,
      jobId: r.jobId,
      project: job.project,
      message: info?.message ?? null,
      now,
      runtimeAccount: pauseScope === 'credential' ? null : runtimeAccount,
    });

    // Scheduler: a runtime-wide limit of the store / account pauses it (the p4 provider pause); credential and
    // model-scoped limits are held by `gate` from the episode instead. p13-runtime-accounts: an account's limit holds
    // only that account (its episode marks it limited in the placement facts).
    if (pauseScope !== 'credential' && model === null && runtimeAccount === null) {
      await this.deps.quotas.insertPauseWithin(
        tx,
        {
          scope: pauseScope === 'account' ? 'account' : 'worker_runtime',
          workerId: pauseScope === 'account' ? null : r.workerId,
          runtime,
          accountId,
          reason: `provider_usage_limit reported by ${r.workerId} for job ${r.jobId}`,
          sourceAttemptId: r.attemptId,
          sourceJobId: r.jobId,
          resumeAt,
          project: job.project,
          reportingWorker: r.workerId,
        },
        false,
      );
    }

    // The decision.
    const { policy } = await effectivePolicy(tx, job.project);
    const options = await this.#options(tx, record, policy);
    const limitedKey = optionKey(attemptSpec);
    const alternatives = options.filter((o) => optionKey(o.spec) !== limitedKey);
    const parked = r.paused?.cause === 'usage_limit' ? r.paused : null;
    // p13-runtime-accounts (design §4): the first fallback is the same runtime with another account — on this machine
    // (the parked workspace continues with it), else on another machine (a new attempt there); then ADR-0040.
    const switchTo =
      runtimeAccount === null || accountsSvc === null || policy.mode === 'fail' || model !== null
        ? null
        : await this.#otherAccount(tx, accountsSvc, {
            jobId: r.jobId,
            project: job.project,
            runtime,
            workerId: r.workerId,
            limited: runtimeAccount,
            pin: job.account_pin,
          });
    const action: UsageLimitAction =
      switchTo !== null
        ? 'fallback'
        : decideUsageLimitAction(policy, { resetAt, now, fallbackAvailable: alternatives.length > 0 });
    const accountWhat =
      runtimeAccount === null ? null : `account ${limitedAccount?.label ?? runtimeAccount} on ${r.workerId}`;
    const what = `usage limit on ${runtimeName(runtime)} (${accountWhat ?? scopeText(scope, info?.store ?? null, model, r.workerId)})${
      resetAt === null ? ', reset time not reported' : `, resets at ${resetAt.toISOString()}`
    }`;
    const requeueAt =
      action === 'wait'
        ? new Date(resumeAt.getTime() + usageLimitJitterMs(r.jobId))
        : action === 'fallback'
          ? now
          : null;
    let path: 'parked' | 'requeued' | null = null;

    if (switchTo !== null && !switchTo.here) {
      // p13-runtime-accounts: no other account here, one on another machine: a new attempt there (the dispatcher's
      // strategy picks it; this account is limited). ADR-0042 checkpoints are local, so it starts from the prompt.
      path = 'requeued';
      if (parked !== null) {
        await this.#discardParked(
          tx,
          r.workerId,
          r.jobId,
          r.attemptId,
          r.epoch,
          'continuing with another account on another machine',
        );
      }
      await this.deps.jobs.transitionWithin(tx, r.jobId, 'attempt_retry', {
        actor: SYSTEM,
        retrySafe: true,
        reason:
          `${what}; continuing with account ${switchTo.accounts[0]?.label ?? 'another account'} on ${switchTo.accounts[0]?.workerId ?? 'another machine'} as a new attempt`.slice(
            0,
            1000,
          ),
      });
    } else if (action === 'fail') {
      await this.deps.jobs.transitionWithin(tx, r.jobId, 'attempt_failed', {
        actor: { type: 'worker', id: r.workerId },
        epoch: r.epoch,
        reason: `${what}; the project's usage-limit policy fails the job`.slice(0, 1000),
      });
      if (parked !== null)
        await this.#discardParked(
          tx,
          r.workerId,
          r.jobId,
          r.attemptId,
          r.epoch,
          'the job failed on a usage limit',
        );
    } else if (parked !== null) {
      path = 'parked';
      const resumeTime = action === 'wait' ? (requeueAt ?? now) : now;
      const retainUntil = new Date(
        Math.min(now.getTime() + MAX_RETAIN_MS, Math.max(resumeTime.getTime(), now.getTime()) + DAY_MS),
      );
      const limitedOption = options
        .filter((o) => optionKey(o.spec) === limitedKey)
        .map((o) => storedOption(o, true));
      const stored: StoredOption[] =
        switchTo?.here === true
          ? [
              // The limited runtime with each other account of this machine, best first; then the ADR-0040 options.
              ...switchTo.accounts.map((a) => ({
                ...limitedOption[0],
                ...storedBase(attemptSpec),
                account: a.id,
              })),
              ...alternatives.map((o) => storedOption(o, false)),
            ]
          : action === 'fallback'
            ? [...alternatives.map((o) => storedOption(o, false)), ...limitedOption]
            : [];
      await this.deps.jobs.transitionWithin(tx, r.jobId, 'pause_confirmed', {
        actor: { type: 'worker', id: r.workerId },
        epoch: r.epoch,
        reason: (action === 'wait'
          ? `${what}; waiting until ${resumeTime.toISOString()} — the job resumes by itself in the same workspace`
          : switchTo?.here === true
            ? `${what}; continuing with account ${switchTo.accounts[0]?.label ?? 'another account'} in the same workspace`
            : `${what}; continuing on a fallback runtime in the same workspace`
        ).slice(0, 1000),
      });
      await tx.query(
        `INSERT INTO job_pauses (job_id, attempt_id, worker_id, paused_epoch, request_id, status, requested_at, paused_at,
                                 retain_until, resume_mode, active_ms, runtime_session_id, resume_requested_at, cause,
                                 resume_at, usage_limit, resume_options)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $6, $7, $8, $9, $10, $11, 'usage_limit', $12, $13, $14)`,
        [
          r.jobId,
          r.attemptId,
          r.workerId,
          r.epoch,
          action === 'wait' ? 'paused' : 'resuming',
          now,
          retainUntil,
          parked.resume,
          parked.activeMs,
          parked.runtimeSessionId ?? null,
          action === 'wait' ? null : now,
          resumeTime,
          JSON.stringify({
            runtime,
            scope,
            kind: info?.kind ?? null,
            resetAt: resetAt?.toISOString() ?? null,
            store: info?.store ?? null,
            model,
            episodeId: episode.id,
            action,
          }),
          JSON.stringify(stored),
        ],
      );
    } else {
      path = 'requeued';
      await this.deps.jobs.transitionWithin(tx, r.jobId, 'attempt_retry', {
        actor: SYSTEM,
        retrySafe: true,
        reason: (action === 'wait'
          ? `${what}; requeued — starts again after ${(requeueAt ?? now).toISOString()}`
          : `${what}; requeued to continue on a fallback runtime`
        ).slice(0, 1000),
      });
    }
    await tx.query(
      `INSERT INTO usage_limit_hits (attempt_id, job_id, episode_id, worker_id, runtime, action, path, reset_at,
                                     requeue_at, policy, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (attempt_id) DO NOTHING`,
      [
        r.attemptId,
        r.jobId,
        episode.id,
        r.workerId,
        runtime,
        action,
        path,
        resetAt,
        path === 'requeued' ? (switchTo !== null && !switchTo.here ? now : requeueAt) : null,
        JSON.stringify(policy),
        now,
      ],
    );
    if (switchTo !== null) {
      await this.deps.audit.record(
        {
          actor: SYSTEM,
          action: 'job.usage_limit.account_switch',
          target: `job:${r.jobId}`,
          outcome: 'success',
          metadata: {
            attemptId: r.attemptId,
            runtime,
            from: { workerId: r.workerId, account: runtimeAccount, label: limitedAccount?.label ?? null },
            to: switchTo.accounts
              .slice(0, 3)
              .map((a) => ({ workerId: a.workerId, account: a.id, label: a.label })),
            path,
          },
        },
        tx,
      );
    }
    await this.deps.audit.record(
      {
        actor: SYSTEM,
        action: `job.usage_limit.${action}`,
        target: `job:${r.jobId}`,
        outcome: 'success',
        metadata: {
          attemptId: r.attemptId,
          workerId: r.workerId,
          runtime,
          scope,
          ...(model === null ? {} : { model }),
          resetAt: resetAt?.toISOString() ?? null,
          resumeAt: resumeAt.toISOString(),
          path,
          episodeId: episode.id,
          alternatives: alternatives.map((o) => o.runtime),
        },
      },
      tx,
    );
    return true;
  }

  async #hitEpisode(
    tx: Tx,
    e: {
      readonly scopeKey: string;
      readonly scope: UsageLimitScope;
      readonly pauseScope: 'worker_runtime' | 'account' | 'credential';
      readonly workerId: string | null;
      readonly runtime: string;
      readonly accountId: string | null;
      readonly credKey: string | null;
      readonly store: string | null;
      readonly model: string | null;
      readonly kind: string | null;
      readonly resetAt: Date | null;
      readonly resumeAt: Date;
      readonly jobId: string;
      readonly project: string;
      readonly message: string | null;
      readonly now: Date;
      readonly runtimeAccount?: string | null;
    },
  ): Promise<{ readonly id: string; readonly created: boolean }> {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE usage_limit_episodes
          SET hits = hits + 1, last_hit_at = $2, resume_at = GREATEST(resume_at, $3),
              reset_at = CASE WHEN $4::timestamptz IS NULL THEN reset_at ELSE GREATEST(COALESCE(reset_at, $4), $4) END,
              kind = COALESCE(kind, $5), message = COALESCE($6, message)
        WHERE scope_key = $1 AND ended_at IS NULL RETURNING id`,
      [e.scopeKey, e.now, e.resumeAt, e.resetAt, e.kind, e.message === null ? null : e.message.slice(0, 300)],
    );
    const existing = rows[0]?.id;
    if (existing !== undefined) return { id: existing, created: false };
    const ins = await tx.query<{ id: string; inserted: boolean }>(
      `INSERT INTO usage_limit_episodes (scope_key, scope, pause_scope, worker_id, runtime, account_id, credential_key,
                                         store, model, kind, reset_at, resume_at, started_at, last_hit_at, first_job_id,
                                         project, message, notified_at, runtime_account)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14, $15, $16, $13, $17)
       ON CONFLICT (scope_key) WHERE ended_at IS NULL
       DO UPDATE SET hits = usage_limit_episodes.hits + 1, last_hit_at = EXCLUDED.last_hit_at
       RETURNING id, (xmax = 0) AS inserted`,
      [
        e.scopeKey,
        e.scope,
        e.pauseScope,
        e.workerId,
        e.runtime,
        e.accountId,
        e.credKey,
        e.store !== null && /^[a-z][a-z0-9-]{0,31}$/.test(e.store) ? e.store : null,
        e.model !== null && MODEL_RE.test(e.model) ? e.model : null,
        e.kind,
        e.resetAt,
        e.resumeAt,
        e.now,
        e.jobId,
        e.project,
        e.message === null ? null : e.message.slice(0, 300),
        e.runtimeAccount ?? null,
      ],
    );
    const id = ins.rows[0]?.id;
    if (id === undefined) throw new Error('usage_limit_episodes insert returned no row');
    // A concurrent hit of the same store opened it a moment earlier: it already notified.
    if (ins.rows[0]?.inserted !== true) return { id, created: false };
    await this.#notify(tx, { event: 'reached', episodeId: id }, e.now);
    await this.deps.audit.record(
      {
        actor: SYSTEM,
        action: 'usage_limit.hit',
        target: e.workerId === null ? `usage-limit:${e.scopeKey}` : `worker:${e.workerId}`,
        outcome: 'success',
        metadata: {
          episodeId: id,
          scope: e.scope,
          pauseScope: e.pauseScope,
          runtime: e.runtime,
          ...(e.model === null ? {} : { model: e.model }),
          resetAt: e.resetAt?.toISOString() ?? null,
          resumeAt: e.resumeAt.toISOString(),
          jobId: e.jobId,
        },
      },
      tx,
    );
    return { id, created: true };
  }

  // ------------------------------------------------------------------------------------------- clear

  /**
   * p19-limit-clear: a person can have the limit re-checked and lift the block. Ends open episodes
   * before their resume time — a person cleared the limit (`cleared`), or a newer reading of the same login is under its
   * limits (`reading`). The parked waits of those episodes become due now and requeued attempts may start at once; the
   * reset is announced as for a reset that came by itself. Returns the ended episode ids.
   */
  async clearWithin(
    tx: Queryable,
    filter:
      | { readonly kind: 'episode'; readonly id: string }
      | {
          readonly kind: 'reading';
          readonly workerId: string;
          readonly runtime: string;
          readonly account: string;
          readonly observedAt: Date;
        },
    by: ClearActor | null,
  ): Promise<string[]> {
    const now = this.clock();
    const reason = filter.kind === 'episode' ? 'cleared' : 'reading';
    // A reading clears what it can see: the subscription limit of that login on that machine, never a credential's
    // or one model's limit, and only one that started before the reading was taken.
    const { rows } = await tx.query<{ id: string; notified: boolean }>(
      filter.kind === 'episode'
        ? `UPDATE usage_limit_episodes SET ended_at = $2, end_reason = 'cleared',
                  reset_notified_at = CASE WHEN notified_at IS NULL THEN NULL ELSE $2::timestamptz END
            WHERE id = $1 AND ended_at IS NULL RETURNING id, notified_at IS NOT NULL AS notified`
        : `UPDATE usage_limit_episodes SET ended_at = $2, end_reason = 'reading',
                  reset_notified_at = CASE WHEN notified_at IS NULL THEN NULL ELSE $2::timestamptz END
            WHERE ended_at IS NULL AND scope = 'subscription' AND worker_id = $1 AND runtime = $3
              AND COALESCE(runtime_account, 'default') = $4 AND started_at < $5
              AND (kind IS NULL OR kind IN ('session', 'weekly'))
            RETURNING id, notified_at IS NOT NULL AS notified`,
      filter.kind === 'episode'
        ? [filter.id, now]
        : [filter.workerId, now, filter.runtime, filter.account, filter.observedAt],
    );
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return ids;
    await tx.query(
      `UPDATE job_pauses SET resume_at = $2
        WHERE ended_at IS NULL AND cause = 'usage_limit' AND status = 'paused' AND resume_at > $2
          AND usage_limit->>'episodeId' = ANY($1::text[])`,
      [ids, now],
    );
    await tx.query(
      `UPDATE usage_limit_hits SET requeue_at = $2 WHERE episode_id = ANY($1::uuid[]) AND requeue_at > $2`,
      [ids, now],
    );
    for (const r of rows) {
      if (r.notified) await this.#notify(tx, { event: 'reset', episodeId: r.id }, now);
      await this.deps.audit.record(
        {
          actor: by === null ? SYSTEM : { type: 'user', id: by.userId },
          action: 'usage_limit.cleared',
          target: `usage-limit:${r.id}`,
          outcome: 'success',
          ...(by === null ? {} : { ip: by.ip, userAgent: by.userAgent }),
          metadata: { episodeId: r.id, reason },
        },
        tx,
      );
    }
    return ids;
  }

  /** {@link clearWithin} for one episode, by a person. False: no such open episode. */
  async clear(episodeId: string, by: ClearActor): Promise<boolean> {
    const ids = await withTransaction(this.deps.pool, (tx) =>
      this.clearWithin(tx, { kind: 'episode', id: episodeId }, by),
    );
    if (ids.length > 0) await this.tick();
    return ids.length > 0;
  }

  // ------------------------------------------------------------------------------------------- tick

  /** One pass: reset episodes, due parked waits, parked attempts that must restart elsewhere. */
  async tick(
    limit = 50,
  ): Promise<{ readonly reset: number; readonly due: number; readonly restarted: number }> {
    const reset = await this.#endEpisodes(limit);
    const due = await this.#dueWaits(limit);
    const restarted = await this.#restartStuck(limit);
    return { reset, due, restarted };
  }

  async #endEpisodes(limit: number): Promise<number> {
    const now = this.clock();
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM usage_limit_episodes WHERE ended_at IS NULL AND resume_at <= $1 ORDER BY resume_at LIMIT $2`,
      [now, limit],
    );
    let n = 0;
    for (const r of rows) {
      const done = await withTransaction(this.deps.pool, async (tx) => {
        const { rows: upd } = await tx.query<{ notified: boolean }>(
          `UPDATE usage_limit_episodes SET ended_at = $2, end_reason = 'reset',
                  reset_notified_at = CASE WHEN notified_at IS NULL THEN NULL ELSE $2::timestamptz END
            WHERE id = $1 AND ended_at IS NULL AND resume_at <= $2 RETURNING notified_at IS NOT NULL AS notified`,
          [r.id, now],
        );
        const u = upd[0];
        if (u === undefined) return false;
        if (u.notified) await this.#notify(tx, { event: 'reset', episodeId: r.id }, now);
        return true;
      });
      if (done) n += 1;
    }
    return n;
  }

  /** Parked waits whose time came: `paused` → `resuming` (the dispatcher then places them on their machine). */
  async #dueWaits(limit: number): Promise<number> {
    const now = this.clock();
    const { rowCount } = await this.deps.pool.query(
      `UPDATE job_pauses p SET status = 'resuming', resume_requested_at = $1
        WHERE p.id IN (SELECT x.id FROM job_pauses x JOIN jobs j ON j.id = x.job_id
                        WHERE x.ended_at IS NULL AND x.cause = 'usage_limit' AND x.status = 'paused'
                          AND x.blocked_reason IS NULL AND x.resume_at <= $1 AND j.state = 'PAUSED'
                        ORDER BY x.resume_at LIMIT $2)`,
      [now, limit],
    );
    return rowCount ?? 0;
  }

  /**
   * A parked usage-limit attempt that cannot resume on its machine (blocked: machine gone, workspace missing, worker too
   * old) or whose retention passed is restarted elsewhere as a new attempt — a usage-limit wait never cancels a job.
   */
  async #restartStuck(limit: number): Promise<number> {
    const now = this.clock();
    const { rows } = await this.deps.pool.query<{ id: string; blocked_reason: string | null }>(
      `SELECT p.id, p.blocked_reason FROM job_pauses p JOIN jobs j ON j.id = p.job_id
        WHERE p.ended_at IS NULL AND p.cause IN ('usage_limit', 'account_switch') AND p.status IN ('paused', 'resuming')
          AND j.state = 'PAUSED' AND (p.blocked_reason IS NOT NULL OR p.retain_until <= $1)
        LIMIT $2`,
      [now, limit],
    );
    let n = 0;
    for (const r of rows) {
      const ok = await this.restartElsewhere(
        r.id,
        r.blocked_reason === null
          ? 'the kept workspace was not resumed in time'
          : `it cannot resume on its machine (${r.blocked_reason.slice(0, 200)})`,
      );
      if (ok) n += 1;
    }
    return n;
  }

  /** PAUSED → QUEUED as a new attempt anywhere (`restart_paused`); the kept workspace is discarded. */
  async restartElsewhere(pauseId: string, why: string): Promise<boolean> {
    const out: { jobId: string | null } = { jobId: null };
    try {
      await withTransaction(this.deps.pool, async (tx) => {
        const p = await this.#pause(tx, pauseId);
        if (p === null || p.ended_at !== null) return;
        const { rows } = await tx.query<{ state: JobState; current_attempt_id: string | null }>(
          'SELECT state, current_attempt_id FROM jobs WHERE id = $1 FOR UPDATE',
          [p.job_id],
        );
        const job = rows[0];
        if (job?.state !== 'PAUSED' || job.current_attempt_id !== p.attempt_id) return;
        const reason = `usage limit: restarted on another machine as a new attempt — ${why}`.slice(0, 1000);
        await this.deps.jobs.transitionWithin(tx, p.job_id, 'restart_paused', { actor: SYSTEM, reason });
        await this.#discardParked(tx, p.worker_id, p.job_id, p.attempt_id, p.paused_epoch, why);
        await tx.query(
          `UPDATE job_pauses SET status = 'restarted', ended_at = $2, end_reason = $3 WHERE id = $1 AND ended_at IS NULL`,
          [p.id, this.clock(), reason.slice(0, 500)],
        );
        await this.deps.audit.record(
          {
            actor: SYSTEM,
            action: 'job.usage_limit.restart',
            target: `job:${p.job_id}`,
            outcome: 'success',
            metadata: { pauseId: p.id, attemptId: p.attempt_id, why: why.slice(0, 300) },
          },
          tx,
        );
        out.jobId = p.job_id;
      });
    } catch (err) {
      if (err instanceof IllegalTransitionError || err instanceof VersionConflictError) return false;
      throw err;
    }
    if (out.jobId !== null) this.deps.dispatch?.(out.jobId);
    return out.jobId !== null;
  }

  // ------------------------------------------------------------------------------------------- resume dispatch

  async owns(pauseId: string): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ cause: string }>(
      'SELECT cause FROM job_pauses WHERE id = $1',
      [pauseId],
    );
    // p13-runtime-accounts: a manual account switch resumes through the same path (options with an account).
    return rows[0]?.cause === 'usage_limit' || rows[0]?.cause === ACCOUNT_SWITCH_CAUSE;
  }

  /** `resuming` usage-limit episodes of PAUSED jobs, oldest first. */
  async resumable(limit = 20): Promise<{ readonly pauseId: string; readonly jobId: string }[]> {
    const { rows } = await this.deps.pool.query<{ id: string; job_id: string }>(
      `SELECT p.id, p.job_id FROM job_pauses p JOIN jobs j ON j.id = p.job_id
        WHERE p.ended_at IS NULL AND p.cause IN ('usage_limit', 'account_switch') AND p.status = 'resuming'
          AND p.blocked_reason IS NULL AND j.state = 'PAUSED'
        ORDER BY p.resume_requested_at NULLS LAST, p.requested_at LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ pauseId: r.id, jobId: r.job_id }));
  }

  /** Re-validates and prepares a usage-limit resume (the machine still exists and can resume). Null: nothing to place. */
  async prepareResume(pauseId: string): Promise<PreparedUsageResume | null> {
    return withTransaction(this.deps.pool, async (tx) => {
      const p = await this.#pause(tx, pauseId);
      if (p === null || p.ended_at !== null || p.status !== 'resuming' || p.blocked_reason !== null)
        return null;
      const { rows: jr } = await tx.query<{
        project: string;
        spec: JobSpec;
        state: JobState;
        current_attempt_id: string | null;
        runtime_choice: RuntimeChoice | null;
      }>(
        `SELECT j.project, j.spec, j.state, j.current_attempt_id, x.runtime_choice
           FROM jobs j LEFT JOIN job_runs x ON x.attempt_id = j.current_attempt_id
          WHERE j.id = $1 FOR UPDATE OF j`,
        [p.job_id],
      );
      const job = jr[0];
      if (job?.state !== 'PAUSED' || job.current_attempt_id !== p.attempt_id) return null;
      const { rows: w } = await tx.query<{
        state: string;
        archived: boolean;
        can: boolean;
        name: string | null;
      }>(
        `SELECT state, archived_at IS NOT NULL AS archived, (features ? $2) AS can, display_name AS name
           FROM workers WHERE id = $1`,
        [p.worker_id, p.cause === 'account_switch' ? RUNTIME_ACCOUNTS_FEATURE : USAGE_LIMIT_PARK_FEATURE],
      );
      const worker = w[0];
      if (worker === undefined || worker.archived || worker.state === 'quarantined' || !worker.can) {
        await this.#block(tx, p, `the machine ${worker?.name ?? p.worker_id} cannot resume it`);
        return null;
      }
      const record = { id: p.job_id, project: job.project, spec: job.spec };
      const limitedSpec = await this.specForChoice(tx, record, job.runtime_choice);
      const limitedRuntime = (p.usage_limit?.runtime ?? limitedSpec.runtime) as RuntimeKind;
      const stored = (p.resume_options ?? []).flatMap((o) => {
        const parsed = StoredOption.safeParse(o);
        return parsed.success ? [parsed.data] : [];
      });
      const options: { spec: JobSpec; choice: RuntimeChoice | null; label: string }[] = [];
      // p13-runtime-accounts: an option with an account continues the limited runtime with that account (the same
      // spec as the attempt), whatever the policy's runtime options are now.
      const accountOptions = stored.filter(
        (s) => s.account !== undefined && s.runtime === limitedSpec.runtime,
      );
      for (const s of accountOptions) {
        options.push({
          spec: limitedSpec,
          choice: {
            ...(job.runtime_choice ?? { index: 0, runtime: limitedSpec.runtime }),
            account: s.account ?? DEFAULT_ACCOUNT_ID,
            reason: (p.cause === 'account_switch'
              ? `account switch by a person: continuing with account ${s.account ?? ''}`
              : `${limitedRuntime}: usage limit of account ${job.runtime_choice?.account ?? 'default'} (another account in the same workspace)`
            ).slice(0, 1000),
          },
          label: `${runtimeName(limitedSpec.runtime)} (${s.account ?? ''})`,
        });
      }
      const others = stored.filter((s) => !accountOptions.includes(s));
      if (others.length === 0 && options.length > 0) {
        // Only account options: nothing else to resolve.
      } else if (others.length === 0) {
        options.push({
          spec: limitedSpec,
          choice: job.runtime_choice,
          label: runtimeName(limitedSpec.runtime),
        });
      } else {
        const current = await this.#options(tx, record, (await effectivePolicy(tx, job.project)).policy);
        for (const s of others) {
          // The option as the job's options resolve it now (a changed policy / catalog applies; one that was removed
          // since is skipped; the limited one is the job's own attempt spec).
          const spec = s.limited
            ? limitedSpec
            : current.find(
                (o) => o.runtime === s.runtime && (o.spec.modelProfile?.id ?? undefined) === s.profile,
              )?.spec;
          if (spec === undefined) continue;
          const opt = current.find((o) => optionKey(o.spec) === optionKey(spec));
          options.push({
            spec,
            choice:
              opt === undefined
                ? job.runtime_choice
                : runtimeChoice(opt, [`${limitedRuntime}: usage limit (resumed in the same workspace)`]),
            label: runtimeName(spec.runtime),
          });
        }
        if (options.length === 0) {
          options.push({
            spec: limitedSpec,
            choice: job.runtime_choice,
            label: runtimeName(limitedSpec.runtime),
          });
        }
      }
      const resetAt = validDate(p.usage_limit?.resetAt ?? undefined);
      const activeMs = Math.max(0, Math.min(p.active_ms, 7 * DAY_MS));
      return {
        pauseId: p.id,
        jobId: p.job_id,
        workerId: p.worker_id,
        resume:
          p.cause === 'account_switch'
            ? { cause: 'account_switch', pausedEpoch: p.paused_epoch, activeMs }
            : {
                cause: 'usage_limit',
                pausedEpoch: p.paused_epoch,
                limitedRuntime,
                ...(resetAt === null ? {} : { resetAt: resetAt.toISOString() }),
                activeMs,
              },
        options,
        restartIfNotPlaced: stored.length > 0,
      };
    });
  }

  /** Placement says the machine can never take it: blocked (the tick then restarts it elsewhere). */
  async blockResume(pauseId: string, reason: string): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      const p = await this.#pause(tx, pauseId);
      if (p === null || p.ended_at !== null) return;
      await this.#block(tx, p, reason);
    });
  }

  /** "Resume now" of a usage-limit pause: try at once (before the reset; the placement shows why it waits). */
  async resumeNowWithin(tx: Tx, pauseId: string, userId: string, now: Date): Promise<void> {
    await tx.query(
      `UPDATE job_pauses SET status = 'resuming', blocked_reason = NULL, resume_requested_at = $2, resume_requested_by = $3
        WHERE id = $1 AND ended_at IS NULL AND cause IN ('usage_limit', 'account_switch')`,
      [pauseId, now, userId],
    );
  }

  // ------------------------------------------------------------------------------------------- views

  /** Open episodes (store / credential / model limits) for the console. */
  async status(): Promise<UsageLimitEpisodeView[]> {
    const { rows } = await this.deps.pool.query<EpisodeRow & { worker_name: string | null }>(
      `SELECT e.*, w.display_name AS worker_name FROM usage_limit_episodes e
         LEFT JOIN workers w ON w.id = e.worker_id
        WHERE e.ended_at IS NULL AND e.resume_at > $1 ORDER BY e.resume_at LIMIT 200`,
      [this.clock()],
    );
    return rows.map((e) => ({
      id: e.id,
      scope: e.scope,
      pauseScope: e.pause_scope,
      workerId: e.worker_id,
      workerName: e.worker_name,
      runtime: e.runtime,
      accountId: e.account_id,
      runtimeAccount: e.runtime_account,
      // Only the kind and id of a credential reference (never a value).
      credential: e.credential_key,
      store: e.store,
      model: e.model,
      kind: e.kind,
      resetAt: e.reset_at?.toISOString() ?? null,
      resumeAt: e.resume_at.toISOString(),
      since: e.started_at.toISOString(),
      lastHitAt: e.last_hit_at.toISOString(),
      hits: e.hits,
      project: e.project,
      message: e.message,
    }));
  }

  // ------------------------------------------------------------------------------------------- internals

  async #openEpisodes(runtime: string, now: Date): Promise<EpisodeRow[]> {
    const { rows } = await this.deps.pool.query<EpisodeRow>(
      `SELECT * FROM usage_limit_episodes WHERE ended_at IS NULL AND runtime = $1 AND resume_at > $2`,
      [runtime, now],
    );
    return rows;
  }

  /**
   * p13-runtime-accounts (design §4): another account of the same runtime that can take the job now — on the limited
   * account's machine (`here`), else on other machines; not paused, signed in, not limited, and an API key only with the
   * project's paid switch (a fallback). Ordered by the project's strategy. Null: none (ADR-0040 decides).
   */
  async #otherAccount(
    tx: Tx,
    accounts: RuntimeAccountService,
    input: {
      readonly jobId: string;
      readonly project: string;
      readonly runtime: string;
      readonly workerId: string;
      readonly limited: string;
      readonly pin: { workerId?: string; account?: string } | null;
    },
  ): Promise<{
    readonly here: boolean;
    readonly accounts: readonly { readonly workerId: string; readonly id: string; readonly label: string }[];
  } | null> {
    // A person's pin to the limited account means "this account": wait for it (ADR-0040).
    if (input.pin?.workerId === input.workerId && input.pin.account === input.limited) return null;
    const facts = await accounts.jobFacts(
      { id: input.jobId, project: input.project },
      { fallback: true, exclude: [{ workerId: input.workerId, account: input.limited }], pin: null },
      tx,
    );
    const { accounts: all } = await accounts.list({ runtime: input.runtime });
    const usable = all.filter(
      (a) =>
        a.supported &&
        a.reported &&
        !(a.workerId === input.workerId && a.id === input.limited) &&
        !a.paused &&
        a.limit === null &&
        a.state !== 'needs_login' &&
        (a.kind === 'subscription' || facts.allowPaid),
    );
    const rank = (a: (typeof usable)[number]): number[] => [
      a.usage?.usedPercent !== null &&
      a.usage?.usedPercent !== undefined &&
      a.usage.usedPercent >= facts.skipPercent
        ? 1
        : 0,
      a.kind === 'api_key' ? 1 : 0,
      facts.strategy === 'fill_first'
        ? (() => {
            const i = facts.order.indexOf(`${a.workerId}/${a.runtime}/${a.id}`);
            return i >= 0 ? i : facts.order.length + a.position;
          })()
        : facts.strategy === 'least_used'
          ? Math.round(a.usage?.usedPercent ?? 0)
          : a.running,
      // A worker-account login (not lent to a per-job account) holds the machine alone on Windows: others first.
      a.kind === 'subscription' && !a.lendable ? 1 : 0,
      a.position,
    ];
    const cmp = (x: number[], y: number[]): number => {
      for (let i = 0; i < x.length; i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    };
    const ordered = [...usable].sort((x, y) => cmp(rank(x), rank(y)));
    const here = ordered.filter((a) => a.workerId === input.workerId);
    const pick = here.length > 0 ? here : ordered;
    if (pick.length === 0) return null;
    return {
      here: here.length > 0,
      accounts: pick.map((a) => ({ workerId: a.workerId, id: a.id, label: a.label })),
    };
  }

  async #pause(tx: Tx, pauseId: string): Promise<UsagePauseRow | null> {
    const { rows } = await tx.query<UsagePauseRow>(
      `SELECT id, job_id, attempt_id, worker_id, paused_epoch, status, resume_at, retain_until,
              active_ms::int AS active_ms, blocked_reason, usage_limit, resume_options, ended_at, cause
         FROM job_pauses WHERE id = $1 AND cause IN ('usage_limit', 'account_switch') FOR UPDATE`,
      [pauseId],
    );
    return rows[0] ?? null;
  }

  async #block(tx: Tx, p: UsagePauseRow, reason: string): Promise<void> {
    await tx.query(`UPDATE job_pauses SET status = 'paused', blocked_reason = $2 WHERE id = $1`, [
      p.id,
      reason.slice(0, 500),
    ]);
    await this.deps.audit.record(
      {
        actor: SYSTEM,
        action: 'job.usage_limit.blocked',
        target: `job:${p.job_id}`,
        outcome: 'denied',
        metadata: { pauseId: p.id, reason: reason.slice(0, 300) },
      },
      tx,
    );
  }

  async #discardParked(
    tx: Tx,
    workerId: string,
    jobId: string,
    attemptId: string,
    epoch: number,
    reason: string,
  ): Promise<void> {
    const exists = await tx.query('SELECT 1 FROM workers WHERE id = $1', [workerId]);
    if ((exists.rowCount ?? 0) === 0) return;
    await this.deps
      .replay()
      .enqueueWithin(
        tx,
        workerId,
        'CANCEL_JOB',
        { attemptId, epoch, reason: `parked attempt ended: ${reason}`.slice(0, 1000) },
        { jobId },
      );
    for (const ms of [50, 1_000]) {
      setTimeout(() => {
        try {
          this.deps.replay().kick(workerId);
        } catch {
          // no session: delivered on reconnect
        }
      }, ms).unref();
    }
  }

  async #notify(tx: Queryable, payload: UsageLimitOutboxPayload, now: Date): Promise<void> {
    await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)', [
      OUTBOX_TOPIC_USAGE_LIMIT,
      JSON.stringify(UsageLimitOutboxPayload.parse(payload)),
      now,
    ]);
  }
}

// --------------------------------------------------------------------------------------------- helpers

function optionKey(spec: JobSpec): string {
  return `${spec.runtime}\u0000${spec.modelProfile?.id ?? spec.model ?? ''}`;
}

function modelOf(spec: JobSpec): string | undefined {
  const m = spec.modelProfile?.model ?? spec.model;
  return m !== undefined && MODEL_RE.test(m) ? m : undefined;
}

function storedOption(o: UsageLimitOption, limited: boolean): StoredOption {
  return {
    runtime: o.runtime,
    index: o.index,
    origin: o.origin,
    ...(o.spec.model === undefined ? {} : { model: o.spec.model }),
    ...(o.spec.modelProfile === undefined ? {} : { profile: o.spec.modelProfile.id }),
    ...(limited ? { limited: true } : {}),
  };
}

/** p13-runtime-accounts: the stored option of the attempt's own spec (an account option continues it). */
function storedBase(spec: JobSpec): StoredOption {
  return {
    runtime: spec.runtime,
    index: 0,
    origin: 'job',
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(spec.modelProfile === undefined ? {} : { profile: spec.modelProfile.id }),
  };
}

function validDate(s: string | undefined | null): Date | null {
  if (s === undefined || s === null) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function scopeText(
  scope: UsageLimitScope,
  store: string | null,
  model: string | null,
  workerId: string,
): string {
  switch (scope) {
    case 'subscription':
      return `subscription${store === null ? '' : `, login store ${store}`} on ${workerId}`;
    case 'api_credential':
      return 'API credential';
    case 'model':
      return `model ${model ?? 'unknown'} on ${workerId}`;
  }
}

/** For tests and the console: the action a policy takes (re-exported for one import site). */
export type { UsageLimitAction };
export type { QuotaPolicy };
