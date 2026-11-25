import { apiRequest, int, obj, type RequestOptions } from './client';

/**
 * p15-autonomy (the time limit is editable from the job's cards): a job's time limit — read
 * (`GET /jobs/:id/time-limit`) and set / extend (`POST`, operator+, up to the security policy maximum). A running job
 * keeps running with the new limit when its machine supports it (`live.supportsLive`).
 */

export interface TimeLimitChange {
  readonly seq: number;
  readonly fromSec: number;
  readonly toSec: number;
  readonly delivery: 'not_running' | 'sent' | 'unsupported';
  readonly application: 'applied' | 'refused' | null;
  readonly remainingSec: number | null;
}

export interface TimeLimitState {
  readonly maxDurationSec: number;
  readonly originalSec: number;
  readonly maxAllowedSec: number;
  readonly minSec: number;
  readonly canChange: boolean;
  readonly reason: string | null;
  readonly live: { readonly startedAt: string | null; readonly supportsLive: boolean } | null;
  readonly changes: readonly TimeLimitChange[];
  /** p20-job-clock: run time, human waits apart, the time warning, "continue after a timeout" (null: older master). */
  readonly clock: JobClockState | null;
}

/** p20-job-clock (docs/design/p20-job-clock.md): the run clock part of a job's time limit. */
export interface JobClockState {
  /** The worker's last report while it runs, or the final one; null: none (older machine / never ran). */
  readonly clock: {
    readonly budgetSec: number;
    readonly activeSec: number;
    readonly remainingSec: number;
    readonly approvalWaitSec: number;
    readonly questionWaitSec: number;
    readonly waiting: 'approval' | 'question' | null;
    readonly idleSec: number | null;
    readonly at: string | null;
    readonly final: boolean;
  } | null;
  /** The machine stops the clock while a question waits (null: not running). */
  readonly questionsPauseClock: boolean | null;
  readonly warning: { readonly at: string; readonly limitSec: number } | null;
  readonly thresholdSec: number;
  /** It ended on its time limit. */
  readonly timedOut: boolean;
  /** The caller may continue it from where it stopped. */
  readonly canContinue: boolean;
  /** The limit a continuation gets by default (s). */
  readonly continueSec: number | null;
  /**
   * p22-timeout-continuity: the unfinished work the timed-out attempt kept — pushed to its attempt branch, or kept on one
   * machine only (null: none, or an older master).
   */
  readonly keptWork: KeptWork | null;
}

/** p22-timeout-continuity: what a job stopped by its time limit kept ("Aynı yerden devam et" starts from it). */
export interface KeptWork {
  readonly branch: string;
  readonly commit: string;
  readonly files: number;
  readonly pushed: boolean;
  readonly workerId: string;
}

export function parseKeptWork(v: unknown): KeptWork | null {
  if (v === null || v === undefined || typeof v !== 'object') return null;
  const o = obj(v);
  if (typeof o.branch !== 'string' || typeof o.commit !== 'string') return null;
  return {
    branch: o.branch,
    commit: o.commit,
    files: typeof o.files === 'number' ? Math.max(0, Math.round(o.files)) : 0,
    pushed: o.pushed === true,
    workerId: typeof o.workerId === 'string' ? o.workerId : '',
  };
}

const nint = (o: Record<string, unknown>, k: string): number | null =>
  typeof o[k] === 'number' ? Math.round(o[k]) : null;
const waitOf = (v: unknown): 'approval' | 'question' | null =>
  v === 'approval' || v === 'question' ? v : null;

export function parseJobClock(v: unknown): JobClockState | null {
  if (v === null || v === undefined || typeof v !== 'object') return null;
  const o = obj(v);
  const c = o.clock === null || o.clock === undefined ? null : obj(o.clock);
  const w = o.warning === null || o.warning === undefined ? null : obj(o.warning);
  return {
    clock:
      c === null
        ? null
        : {
            budgetSec: int(c, 'budgetSec'),
            activeSec: int(c, 'activeSec'),
            remainingSec: int(c, 'remainingSec'),
            approvalWaitSec: int(c, 'approvalWaitSec'),
            questionWaitSec: int(c, 'questionWaitSec'),
            waiting: waitOf(c.waiting),
            idleSec: nint(c, 'idleSec'),
            at: typeof c.at === 'string' ? c.at : null,
            final: c.final === true,
          },
    questionsPauseClock: typeof o.questionsPauseClock === 'boolean' ? o.questionsPauseClock : null,
    warning: w === null || typeof w.at !== 'string' ? null : { at: w.at, limitSec: int(w, 'limitSec') },
    thresholdSec: int(o, 'thresholdSec'),
    timedOut: o.timedOut === true,
    canContinue: o.canContinue === true,
    continueSec: nint(o, 'continueSec'),
    keptWork: parseKeptWork(o.keptWork),
  };
}

export function parseTimeLimit(v: unknown): TimeLimitState {
  const o = obj(v);
  const live = o.live === null || o.live === undefined ? null : obj(o.live);
  const changes = Array.isArray(o.changes) ? o.changes : [];
  return {
    maxDurationSec: int(o, 'maxDurationSec'),
    originalSec: int(o, 'originalSec'),
    maxAllowedSec: int(o, 'maxAllowedSec'),
    minSec: int(o, 'minSec'),
    canChange: o.canChange === true,
    reason: typeof o.reason === 'string' ? o.reason : null,
    live:
      live === null
        ? null
        : {
            startedAt: typeof live.startedAt === 'string' ? live.startedAt : null,
            supportsLive: live.supportsLive === true,
          },
    changes: changes.map((x) => {
      const c = obj(x);
      return {
        seq: int(c, 'seq'),
        fromSec: int(c, 'fromSec'),
        toSec: int(c, 'toSec'),
        delivery:
          c.delivery === 'sent' ? 'sent' : c.delivery === 'unsupported' ? 'unsupported' : 'not_running',
        application: c.application === 'applied' ? 'applied' : c.application === 'refused' ? 'refused' : null,
        remainingSec: typeof c.remainingSec === 'number' ? c.remainingSec : null,
      };
    }),
    clock: parseJobClock(o.clock),
  };
}

export function getTimeLimit(jobId: string, opts: RequestOptions = {}): Promise<TimeLimitState> {
  return apiRequest('GET', `/jobs/${encodeURIComponent(jobId)}/time-limit`, parseTimeLimit, opts);
}

export function changeTimeLimit(
  jobId: string,
  change: { readonly maxDurationSec: number } | { readonly addSec: number },
): Promise<TimeLimitState> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/time-limit`,
    (v) => parseTimeLimit(obj(v).timeLimit),
    { body: change },
  );
}

/**
 * p20-job-clock: "Aynı yerden devam et" — a job that stopped on its time limit continues as a new job with a longer
 * limit (default: the master's `continueSec`), the earlier summary and, for a workspace job, its kept files.
 */
export function continueAfterTimeout(
  jobId: string,
  maxDurationSec?: number,
): Promise<{ readonly jobId: string; readonly maxDurationSec: number }> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/continue-after-timeout`,
    (v) => {
      const o = obj(v);
      return { jobId: typeof o.jobId === 'string' ? o.jobId : '', maxDurationSec: int(o, 'maxDurationSec') };
    },
    { body: maxDurationSec === undefined ? {} : { maxDurationSec } },
  );
}
