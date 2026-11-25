import { apiRequest, int, obj, type RequestOptions, str } from './client';

/**
 * p10-approval-pause (docs/design/p10-approval-pause.md): a job that waits too long for an approval is paused
 * (its machine slot freed, its workspace and runtime session kept) instead of failing; it resumes on the same machine
 * once someone decides. Typed wrappers for the pause episode on the job page, Resume now / Restart from scratch,
 * Continue (after an approval expired before this feature), and the project's "Long approval waits" settings.
 * Summaries and reasons are untrusted runtime / human text: render as text only.
 */

export const PAUSE_STATUSES = [
  'pausing',
  'paused',
  'resuming',
  'resumed',
  'restarted',
  'cancelled',
  'expired',
] as const;
export type PauseStatus = (typeof PAUSE_STATUSES)[number];
/** Episodes that still hold the job (open). */
export const OPEN_PAUSE: ReadonlySet<PauseStatus> = new Set<PauseStatus>(['pausing', 'paused', 'resuming']);

/** p11-usage-limit-fallback: what a usage-limit pause waits for. */
export interface UsageLimitPause {
  readonly runtime: string | null;
  readonly scope: string | null;
  readonly kind: string | null;
  readonly resetAt: string | null;
  readonly store: string | null;
  readonly model: string | null;
  readonly action: 'wait' | 'fallback' | null;
}

export interface JobPauseView {
  readonly id: string;
  readonly status: PauseStatus;
  /** p11-usage-limit-fallback: `approval` (a decision) or `usage_limit` (a reset / a fallback). */
  /** p13-runtime-accounts: `account_switch` — a person moved the running job to another runtime account. */
  readonly cause: 'approval' | 'usage_limit' | 'worker_restart' | 'account_switch';
  /** p11-usage-limit-fallback: when a usage-limit pause resumes by itself. */
  readonly resumeAt: string | null;
  readonly usageLimit: UsageLimitPause | null;
  /** Empty for a usage-limit pause. */
  readonly requestId: string;
  readonly action: string;
  readonly summary: string;
  readonly workerId: string;
  readonly workerName: string | null;
  readonly requestedAt: string;
  readonly pausedAt: string | null;
  readonly retainUntil: string;
  readonly resumeMode: 'session' | 'continuation' | null;
  readonly activeMs: number;
  readonly decision: 'approve' | 'deny' | null;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly resumeRequestedAt: string | null;
  readonly blockedReason: string | null;
  readonly endedAt: string | null;
  readonly endReason: string | null;
}

type Opts = Omit<RequestOptions, 'body'>;

function text(o: Record<string, unknown>, k: string): string | null {
  return typeof o[k] === 'string' ? o[k] : null;
}

/** Lenient: an odd or missing value reads as null (an older master has no pauses; the job page never breaks). */
export function parsePause(v: unknown): JobPauseView | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = text(o, 'id');
  const status = PAUSE_STATUSES.find((s) => s === o.status);
  const requestId = text(o, 'requestId');
  const workerId = text(o, 'workerId');
  const requestedAt = text(o, 'requestedAt');
  const retainUntil = text(o, 'retainUntil');
  if (
    id === null ||
    status === undefined ||
    requestId === null ||
    workerId === null ||
    requestedAt === null ||
    retainUntil === null
  )
    return null;
  const ul =
    typeof o.usageLimit === 'object' && o.usageLimit !== null
      ? (o.usageLimit as Record<string, unknown>)
      : null;
  return {
    id,
    status,
    cause:
      o.cause === 'usage_limit' || o.cause === 'worker_restart' || o.cause === 'account_switch'
        ? o.cause
        : 'approval',
    resumeAt: text(o, 'resumeAt'),
    usageLimit:
      ul === null
        ? null
        : {
            runtime: text(ul, 'runtime'),
            scope: text(ul, 'scope'),
            kind: text(ul, 'kind'),
            resetAt: text(ul, 'resetAt'),
            store: text(ul, 'store'),
            model: text(ul, 'model'),
            action: ul.action === 'wait' || ul.action === 'fallback' ? ul.action : null,
          },
    requestId,
    action: text(o, 'action') ?? '',
    summary: text(o, 'summary') ?? '',
    workerId,
    workerName: text(o, 'workerName'),
    requestedAt,
    pausedAt: text(o, 'pausedAt'),
    retainUntil,
    resumeMode: o.resumeMode === 'session' || o.resumeMode === 'continuation' ? o.resumeMode : null,
    activeMs: typeof o.activeMs === 'number' && o.activeMs >= 0 ? o.activeMs : 0,
    decision: o.decision === 'approve' || o.decision === 'deny' ? o.decision : null,
    decidedBy: text(o, 'decidedBy'),
    decisionReason: text(o, 'decisionReason'),
    resumeRequestedAt: text(o, 'resumeRequestedAt'),
    blockedReason: text(o, 'blockedReason'),
    endedAt: text(o, 'endedAt'),
    endReason: text(o, 'endReason'),
  };
}

export interface ResumeOutcome {
  readonly job: { readonly id: string; readonly state: string };
  readonly pause: JobPauseView | null;
}

/** "Resume now" (after a decision) or "Restart from scratch" of a paused job (operator, CSRF). */
export function resumeJob(
  jobId: string,
  mode: 'resume' | 'restart',
  opts: Opts & { readonly reason?: string } = {},
): Promise<ResumeOutcome> {
  const { reason, ...rest } = opts;
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/resume`,
    (v) => {
      const o = obj(v);
      const j = obj(o.job);
      return { job: { id: str(j, 'id'), state: str(j, 'state') }, pause: parsePause(o.pause) };
    },
    { ...rest, body: { mode, ...(reason === undefined || reason === '' ? {} : { reason }) } },
  );
}

/** "Continue": a new job that picks up a job that ended because an approval expired (best effort). */
export function continueJob(jobId: string, opts: Opts = {}): Promise<{ readonly jobId: string }> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/continue`,
    (v) => ({ jobId: str(obj(v), 'jobId') }),
    { ...opts, body: {} },
  );
}

export interface ApprovalPauseTimes {
  readonly staleAfterSec: number;
  readonly pauseAfterSec: number;
  readonly retentionSec: number;
}

export interface ApprovalPauseSettings extends ApprovalPauseTimes {
  readonly project: string;
  readonly defaults: ApprovalPauseTimes;
  readonly limits: {
    readonly minStaleAfterSec: number;
    readonly maxStaleAfterSec: number;
    readonly minPauseAfterSec: number;
    readonly maxPauseAfterSec: number;
    readonly minRetentionSec: number;
    readonly maxRetentionSec: number;
  };
}

/** Platform bounds (protocol APPROVAL_PAUSE_LIMITS), used when an older master omits them. */
export const DEFAULT_LIMITS: ApprovalPauseSettings['limits'] = {
  minStaleAfterSec: 60,
  maxStaleAfterSec: 24 * 3600,
  minPauseAfterSec: 120,
  maxPauseAfterSec: 24 * 3600,
  minRetentionSec: 3600,
  maxRetentionSec: 7 * 24 * 3600,
};

function times(o: Record<string, unknown>): ApprovalPauseTimes {
  return {
    staleAfterSec: int(o, 'staleAfterSec'),
    pauseAfterSec: int(o, 'pauseAfterSec'),
    retentionSec: int(o, 'retentionSec'),
  };
}

export function parseSettings(v: unknown): ApprovalPauseSettings {
  const o = obj(v);
  const l = typeof o.limits === 'object' && o.limits !== null ? (o.limits as Record<string, unknown>) : {};
  const limit = (k: keyof ApprovalPauseSettings['limits']): number =>
    typeof l[k] === 'number' ? l[k] : DEFAULT_LIMITS[k];
  const own = times(o);
  return {
    project: str(o, 'project'),
    ...own,
    defaults: typeof o.defaults === 'object' && o.defaults !== null ? times(obj(o.defaults)) : own,
    limits: {
      minStaleAfterSec: limit('minStaleAfterSec'),
      maxStaleAfterSec: limit('maxStaleAfterSec'),
      minPauseAfterSec: limit('minPauseAfterSec'),
      maxPauseAfterSec: limit('maxPauseAfterSec'),
      minRetentionSec: limit('minRetentionSec'),
      maxRetentionSec: limit('maxRetentionSec'),
    },
  };
}

export function getApprovalPauseSettings(project: string, opts: Opts = {}): Promise<ApprovalPauseSettings> {
  return apiRequest('GET', `/projects/${encodeURIComponent(project)}/approval-pause`, parseSettings, opts);
}

export function putApprovalPauseSettings(
  project: string,
  body: ApprovalPauseTimes,
  opts: Opts = {},
): Promise<ApprovalPauseSettings> {
  return apiRequest('PUT', `/projects/${encodeURIComponent(project)}/approval-pause`, parseSettings, {
    ...opts,
    body,
  });
}
