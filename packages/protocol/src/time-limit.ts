import { type KeyObject, sign } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import { AttemptId, Ed25519Signature, Epoch, Identifier, Text, Timestamp } from './common.js';
import { LeaseKey } from './lease.js';

/**
 * p15-autonomy (docs/design/p15-autonomy.md §10): the time limit is editable from the job's card — changing a
 * running job's time limit (`limits.maxDurationSec`) without restarting it.
 *
 * - `SET_TIME_LIMIT` (master → worker, sequenced, job message, only to workers advertising `time-limit-v1`): the new
 *   run-time budget of the attempt, fenced by attempt + epoch, ordered by a per-job `seq` and signed with a master
 *   lease key over worker, job, attempt, epoch, change id, seq, limit and issue time.
 * - `TIME_LIMIT_STATUS` (worker → master, control, job message): applied (with the budget left) or refused.
 *
 * The worker's run clock (approval waits do not count) gets the new budget; a budget already used up ends the run
 * as a timeout at once, like reaching the old limit.
 */

export const TIME_LIMIT_FEATURE = 'time-limit-v1';

/** The protocol's bound of a run-time budget (ASSIGN_JOB `limits.maxDurationSec`). */
export const MAX_TIME_LIMIT_SEC = 7 * 24 * 3600;
export const MIN_TIME_LIMIT_SEC = 60;

/**
 * p20-job-clock (docs/design/p20-job-clock.md; a job is sized to its expected duration and extended when it will not
 * finish in time): the run clock of an attempt as the worker sees it — reported in HEARTBEAT
 * `runningJobs[].clock` while it runs and in JOB_RESULT `clock` at the end (additive in 1.0; older masters drop it).
 * Seconds, whole. Human waits (approvals, questions) are not run time and are reported apart.
 */
export const RunClockReport = z.object({
  /** The attempt's run-time budget (the current `maxDurationSec`). */
  budgetSec: z.number().int().min(0).max(MAX_TIME_LIMIT_SEC),
  /** Run time used, human waits not counted (includes the run time of earlier runs of a resumed attempt). */
  activeSec: z
    .number()
    .int()
    .min(0)
    .max(MAX_TIME_LIMIT_SEC * 2),
  remainingSec: z.number().int().min(0).max(MAX_TIME_LIMIT_SEC),
  /** Time the clock stood still for in-run approvals (this run). */
  approvalWaitSec: z
    .number()
    .int()
    .min(0)
    .max(MAX_TIME_LIMIT_SEC * 4),
  /** Time the clock stood still for questions to a person (`ask_user` / `wait_for_answer`, this run). */
  questionWaitSec: z
    .number()
    .int()
    .min(0)
    .max(MAX_TIME_LIMIT_SEC * 4),
  /** What the clock waits for now (null: running). */
  waiting: z.enum(['approval', 'question']).nullable(),
  /** Seconds since the runtime last did something (tool call, tool result, message); null: nothing yet. */
  idleSec: z
    .number()
    .int()
    .min(0)
    .max(MAX_TIME_LIMIT_SEC * 4)
    .nullable(),
});
export type RunClockReport = z.infer<typeof RunClockReport>;

/**
 * p20-job-clock: the remaining run time under which the master warns once per limit (s): 15 % of the limit, at least
 * 2 minutes and at most 10 minutes (a 1-hour job is warned at 9 minutes left, a 4-hour job at 10, a 10-minute job at 2).
 */
export function timeWarningThresholdSec(limitSec: number): number {
  return Math.round(Math.min(600, Math.max(120, limitSec * 0.15)));
}

export const TimeLimitSignature = z.object({ kid: LeaseKey.shape.kid, signature: Ed25519Signature });
export type TimeLimitSignature = z.infer<typeof TimeLimitSignature>;

export const SetTimeLimitPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  /** The master's change row (`job_time_limit_changes.id`). */
  changeId: z.uuid(),
  /** Per-job change number: the worker applies only a higher seq than the last one it applied. */
  seq: z.number().int().min(1).max(1_000_000),
  maxDurationSec: z.number().int().min(MIN_TIME_LIMIT_SEC).max(MAX_TIME_LIMIT_SEC),
  changedBy: Identifier,
  issuedAt: Timestamp,
  /** Absent only when the master has no lease-signing key; a worker with trusted keys then refuses it. */
  signature: TimeLimitSignature.optional(),
});
export type SetTimeLimitPayload = z.infer<typeof SetTimeLimitPayload>;

export const TimeLimitStatusPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  changeId: z.uuid(),
  seq: z.number().int().min(1).max(1_000_000),
  outcome: z.enum(['applied', 'refused']),
  /** With `applied`: run time left under the new limit (s; 0 = the run ends now). */
  remainingSec: z.number().int().min(0).max(MAX_TIME_LIMIT_SEC).optional(),
  /** Plain-language explanation; never runtime output. */
  detail: Text,
});
export type TimeLimitStatusPayload = z.infer<typeof TimeLimitStatusPayload>;

export const TIME_LIMIT_CONTEXT = 'remana-time-limit/v1\n';

export interface TimeLimitBinding {
  readonly workerId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: number;
  readonly changeId: string;
  readonly seq: number;
  readonly maxDurationSec: number;
  readonly changedBy: string;
  readonly issuedAt: string;
}

/** Exact bytes a master signs for a SET_TIME_LIMIT (every field on its own line, fixed order). */
export function timeLimitStatement(b: TimeLimitBinding): Buffer {
  return Buffer.from(
    [
      TIME_LIMIT_CONTEXT.trimEnd(),
      b.workerId,
      b.jobId,
      b.attemptId,
      String(b.epoch),
      b.changeId,
      String(b.seq),
      String(b.maxDurationSec),
      b.changedBy,
      b.issuedAt,
    ].join('\n'),
    'utf8',
  );
}

export function signTimeLimit(b: TimeLimitBinding, kid: string, privateKey: KeyObject): TimeLimitSignature {
  return { kid, signature: sign(null, timeLimitStatement(b), privateKey).toString('base64url') };
}

/** Verifies a SET_TIME_LIMIT signature against trusted master keys. Never throws. */
export function verifyTimeLimit(
  b: TimeLimitBinding,
  signature: TimeLimitSignature | undefined,
  keys: readonly LeaseKey[],
): 'ok' | 'missing' | 'unknown_key' | 'bad_signature' {
  if (signature === undefined) return 'missing';
  const key = keys.find((k) => k.kid === signature.kid);
  if (key === undefined) return 'unknown_key';
  return verifyEd25519(key.publicKey, timeLimitStatement(b), signature.signature) ? 'ok' : 'bad_signature';
}

/**
 * p22-timeout-continuity (docs/design/p22-timeout-continuity.md; production 2026-11-01: a repository job finished its
 * work, was stopped by its limit before it published and every change was lost): what a worker keeps when a repository
 * job reaches its time limit.
 *
 * A worker advertising `timeout-delivery-v1` that stops a git-flow attempt on its limit (its run clock, or the master's
 * wall-time backstop's CANCEL_JOB) stops the runtime and, within {@link TIMEOUT_DELIVERY_GRACE_SEC}, commits the
 * worktree as a work-in-progress commit on the attempt branch (`rac/<job>/<attempt>`) with the job's git identity and
 * the attempt trailer, and pushes it with the normal publish's safety steps (trusted-git check, size caps, pre-push
 * secret scan, force-with-lease on an absent ref). Nothing is merged: the commit only waits on its branch for a
 * continuation. JOB_RESULT `partial` says what was kept.
 */
export const TIMEOUT_DELIVERY_FEATURE = 'timeout-delivery-v1';

/** The delivery grace of a repository job that reached its time limit (s): commit + push of the unfinished work. */
export const TIMEOUT_DELIVERY_GRACE_SEC = 120;

/**
 * The master's wall-time backstop waits this long past limit + grace for a `run-clock-v1` worker (s): the worker's own
 * clock starts when the runtime starts (after the checkout), so its limit falls later than the attempt's wall time
 * says; the backstop must not race it. It stays the hard stop afterwards.
 */
export const BACKSTOP_SLACK_SEC = 300;

/**
 * p22-timeout-continuity: the automatic time extensions one job gets at most (security policy
 * `autonomy.autoExtendTime`), each by the continuation step (the limit plus half, at least 30 minutes, within the
 * policy's maximum).
 */
export const AUTO_EXTEND_MAX_PER_JOB = 3;

/** The hidden ref a worker keeps an unpushed timeout commit under, in its repository mirror. */
export const KEPT_REF = /^refs\/remana\/kept\/[A-Za-z0-9_-]{1,128}$/;

/** JOB_RESULT `partial` (additive in 1.0, `timeout-delivery-v1`): the unfinished work a timed-out attempt kept. */
export const TimeoutPartial = z.object({
  /** The attempt branch (`rac/<job>/<attempt>`). */
  branch: z.string().min(1).max(255),
  /** The work-in-progress commit (pushed), or the commit kept on the worker only (`pushed: false`). */
  commit: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/),
  /** Files changed against the attempt's base. */
  files: z.number().int().min(0).max(1_000_000),
  /** The commit is on the remote attempt branch. */
  pushed: z.boolean(),
  /** `pushed: false`: the hidden ref in this worker's repository mirror that keeps the commit. */
  ref: z.string().regex(KEPT_REF).optional(),
  /** `pushed: false`: why it was not pushed. */
  reason: z.enum(['push_failed', 'secret_scan', 'too_large', 'grace_exceeded', 'commit_failed']).optional(),
});
export type TimeoutPartial = z.infer<typeof TimeoutPartial>;
