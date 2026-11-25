import { z } from 'zod';
import { AttemptId, Epoch, Identifier, Text, Timestamp } from './common.js';
import { UsageLimitResume } from './usage-limit.js';
import { WorkerRestartResume } from './continuity.js';

/**
 * p10-approval-pause (docs/design/p10-approval-pause.md, ADR-0036): a job that waits too long for an in-run approval
 * is not failed. After the project's `staleAfter` the request and job are marked stale (notification, chat note);
 * after `pauseAfter` the master asks the worker to pause: the worker stops the runtime gracefully, frees its slot and
 * keeps the attempt's workspace and the runtime session. The request stays open until the retention ends. When a
 * human decides, the same attempt resumes on the same machine under a new fencing epoch and the decision is handed to
 * the agent.
 *
 * - `PAUSE_JOB` (master → worker, sequenced, job message, only to workers advertising `approval-pause-v1`), fenced by
 *   attempt + epoch.
 * - `JOB_RESULT.paused` (worker → master): the run stopped because of PAUSE_JOB and what was kept.
 * - ASSIGN_JOB `execution.approvalWait` (how long the runtime's own approval wait may last before the worker gives
 *   up on its own — the fail-closed backstop when the master never pauses) and `execution.resume` (continue a
 *   paused attempt).
 *
 * Pure schemas, shared by master and worker. All additive in protocol 1.0: older workers never advertise the feature,
 * so the master never pauses their jobs (their runtimes keep the old local approval timeout).
 */

export const APPROVAL_PAUSE_FEATURE = 'approval-pause-v1';

/** Bounds of the project settings (seconds). */
export const APPROVAL_PAUSE_LIMITS = {
  minStaleAfterSec: 60,
  maxStaleAfterSec: 24 * 3600,
  minPauseAfterSec: 120,
  maxPauseAfterSec: 24 * 3600,
  minRetentionSec: 3600,
  maxRetentionSec: 7 * 24 * 3600,
} as const;

/** Platform defaults: stale after 15 min, paused after 60 min, kept for 7 days. */
export const APPROVAL_PAUSE_DEFAULTS = {
  staleAfterSec: 15 * 60,
  pauseAfterSec: 60 * 60,
  retentionSec: 7 * 24 * 3600,
} as const;

/**
 * After this much longer than `pauseAfterSec` the worker denies a still-pending approval itself (fail closed) — only
 * reached when the master could not pause the job (master unreachable).
 */
export const APPROVAL_WAIT_BACKSTOP_SEC = 15 * 60;

/** ASSIGN_JOB `execution.approvalWait`: the master manages long approval waits of this job (stale → pause). */
export const ApprovalWait = z.object({
  staleAfterSec: z
    .number()
    .int()
    .min(APPROVAL_PAUSE_LIMITS.minStaleAfterSec)
    .max(APPROVAL_PAUSE_LIMITS.maxStaleAfterSec),
  pauseAfterSec: z
    .number()
    .int()
    .min(APPROVAL_PAUSE_LIMITS.minPauseAfterSec)
    .max(APPROVAL_PAUSE_LIMITS.maxPauseAfterSec),
});
export type ApprovalWait = z.infer<typeof ApprovalWait>;

/** The runtime's local approval timeout under `approvalWait` (ms): pause time plus the backstop margin. */
export function approvalWaitMs(wait: ApprovalWait): number {
  return (wait.pauseAfterSec + APPROVAL_WAIT_BACKSTOP_SEC) * 1000;
}

/** `PAUSE_JOB` payload: stop the attempt's runtime, keep the workspace and the session, report `JOB_RESULT.paused`. */
export const PauseJobPayload = z
  .object({
    attemptId: AttemptId,
    epoch: Epoch,
    /**
     * Why the master pauses the run: `approval` (absent; p10 — the run waits for an approval) or `account_switch`
     * (p13-runtime-accounts, only to `runtime-accounts-v1` workers — a person moves the job to another runtime account;
     * the run stops now, its workspace and session are kept, and it resumes with the other account).
     */
    cause: z.enum(['approval', 'account_switch']).optional(),
    /** The runtime's approval id the run waits for (the request's `approval_key`); required for an approval pause. */
    approvalId: Identifier.optional(),
    /** Plain-language reason for the job's timeline. */
    reason: Text,
    /** The worker may discard the kept workspace after this time (the master cancels the job then as well). */
    retainUntil: Timestamp,
  })
  .refine((p) => p.cause === 'account_switch' || p.approvalId !== undefined, {
    message: 'an approval pause names its approval',
    path: ['approvalId'],
  });
export type PauseJobPayload = z.infer<typeof PauseJobPayload>;

/** How a paused run continues: the runtime's own session (resume by id) or a fresh session with a continuation prompt. */
export const ResumeMode = z.enum(['session', 'continuation']);
export type ResumeMode = z.infer<typeof ResumeMode>;

/**
 * `JOB_RESULT.paused`: what the worker kept — with `outcome: "cancelled"` after a PAUSE_JOB (approval wait), or, with
 * `cause: "usage_limit"` (p11-usage-limit-fallback, only from `usage-limit-park-v1` workers whose assignment carried
 * `execution.usageLimitPark`), with `outcome: "failed"` and `error.code = "provider_usage_limit"`: the run ended on a
 * usage limit and its workspace and session are kept for a resume (same or another runtime).
 */
export const JobPausedReport = z
  .object({
    /**
     * Why the run was parked; absent = `approval` (the p10 PAUSE_JOB). p13-runtime-accounts: `account_switch` — the
     * PAUSE_JOB of a manual account switch.
     */
    cause: z.enum(['approval', 'usage_limit', 'account_switch']).optional(),
    /** The approval the paused run waits for (required for an approval pause). */
    approvalId: Identifier.optional(),
    /** `session`: the runtime's session can be resumed; `continuation`: only a fresh session with a summary. */
    resume: ResumeMode,
    /** Run time the attempt used before the pause (not counting approval waits); the resume gets the rest. */
    activeMs: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 3600 * 1000),
    /** The runtime's own session / thread id (display and audit only; the worker keeps its own record). */
    runtimeSessionId: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
      .optional(),
  })
  .refine((r) => r.cause === 'usage_limit' || r.cause === 'account_switch' || r.approvalId !== undefined, {
    message: 'an approval pause names its approval',
    path: ['approvalId'],
  });
export type JobPausedReport = z.infer<typeof JobPausedReport>;

/** The human's decision handed to the resumed agent. */
export const ResumeDecision = z.object({
  decision: z.enum(['approve', 'deny']),
  /** Display name of the human who decided (never the agent, ADR-0010). */
  decidedBy: z.string().min(1).max(200),
  /** The deny reason (or an optional approve note), shown to the agent as data. */
  reason: z.string().max(1000).optional(),
});
export type ResumeDecision = z.infer<typeof ResumeDecision>;

/** The approval variant of `execution.resume` (p10-approval-pause): continue with the human's decision. */
export const ApprovalResume = z.object({
  cause: z.literal('approval').optional(),
  /** The epoch the attempt was paused under (the worker's parked record must match). */
  pausedEpoch: Epoch,
  approvalId: Identifier,
  /** The catalog action and the request summary the human decided on (untrusted runtime text, bounded). */
  action: z.string().min(1).max(128),
  summary: z.string().max(2000),
  decision: ResumeDecision,
  /** Run time already used (from JOB_RESULT.paused.activeMs); the run gets `maxDurationSec` minus this. */
  activeMs: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 3600 * 1000),
});
export type ApprovalResume = z.infer<typeof ApprovalResume>;

/**
 * ASSIGN_JOB `execution.resume`: continue the paused attempt `attemptId` (same id, new epoch) from its kept workspace —
 * after an approval decision (p10), after a usage limit (p11-usage-limit-fallback, `cause: "usage_limit"`, only to
 * `usage-limit-park-v1` workers) or after a worker restart (p11-session-continuity, `cause: "worker_restart"`, only to
 * `session-continuity-v1` workers).
 */
/**
 * p13-runtime-accounts: `execution.resume` after a manual account switch (only to `runtime-accounts-v1` workers): the
 * parked attempt continues in its kept workspace with the account in `execution.account` — always in a fresh runtime
 * session with the continuation note (another account's config dir cannot resume the old session).
 */
export const AccountSwitchResume = z.object({
  cause: z.literal('account_switch'),
  /** The epoch the attempt was parked under (the worker's parked record must match). */
  pausedEpoch: Epoch,
  /** Run time already used; the run gets `maxDurationSec` minus this. */
  activeMs: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 3600 * 1000),
});
export type AccountSwitchResume = z.infer<typeof AccountSwitchResume>;

export const AssignedResume = z.union([
  UsageLimitResume,
  WorkerRestartResume,
  AccountSwitchResume,
  ApprovalResume,
]);
export type AssignedResume = z.infer<typeof AssignedResume>;

/** Narrowing helper: the resume continues after a usage limit. */
export function isUsageLimitResume(r: AssignedResume): r is UsageLimitResume {
  return r.cause === 'usage_limit';
}

/** Narrowing helper: the resume continues after a worker restart (p11-session-continuity). */
export function isWorkerRestartResume(r: AssignedResume): r is WorkerRestartResume {
  return r.cause === 'worker_restart';
}

/** Narrowing helper: the resume continues after a manual account switch (p13-runtime-accounts). */
export function isAccountSwitchResume(r: AssignedResume): r is AccountSwitchResume {
  return r.cause === 'account_switch';
}

/** Narrowing helper: the resume continues after an approval decision (p10). */
export function isApprovalResume(r: AssignedResume): r is ApprovalResume {
  return r.cause === undefined || r.cause === 'approval';
}

/** LEASE_ACK decline reason prefix when the kept workspace of a paused attempt is gone (permanent). */
export const PAUSED_WORKSPACE_MISSING = 'paused_workspace_missing';

/** `SUBTASK_STATUS.reason` of a child that is paused waiting for an approval (state `running`). */
export const SUBTASK_PAUSED_FOR_APPROVAL = 'paused_awaiting_approval';

/** `SUBTASK_STATUS.reason` of a child that is paused until a usage limit resets (p11-usage-limit-fallback). */
export const SUBTASK_PAUSED_FOR_USAGE_LIMIT = 'paused_usage_limit';
