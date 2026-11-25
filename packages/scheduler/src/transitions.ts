import { type ActorType, type JobState, type JobTrigger, TERMINAL_STATES } from './states.js';

export interface TransitionRule {
  readonly from: JobState;
  readonly trigger: JobTrigger;
  readonly to: JobState;
  /** Actor types allowed to cause this transition. */
  readonly actors: readonly ActorType[];
  /** A non-empty human-readable reason must accompany the transition (stored in history and audit). */
  readonly requiresReason: boolean;
  /**
   * The caller must assert that re-running is safe (ADR-0004 §5: only idempotent steps are auto-retried;
   * after a lost lease only once reconciliation verified there are no unsafe side effects).
   */
  readonly requiresRetrySafe: boolean;
  readonly description: string;
}

type RuleSpec = [
  from: JobState,
  trigger: JobTrigger,
  to: JobState,
  actors: readonly ActorType[],
  description: string,
  flags?: { reason?: true; retrySafe?: true },
];

const USER_OR_SYSTEM: readonly ActorType[] = ['user', 'system'];
const SYSTEM: readonly ActorType[] = ['system'];
const WORKER: readonly ActorType[] = ['worker'];
const WORKER_OR_SYSTEM: readonly ActorType[] = ['worker', 'system'];
const USER: readonly ActorType[] = ['user'];

const REASON = { reason: true } as const;
const RETRY = { reason: true, retrySafe: true } as const;

/**
 * The transition table. Anything not listed here is illegal. Notes:
 * - Cancelling a job with no worker involvement (DRAFT, QUEUED, BLOCKED, RETRY_WAIT, AWAITING_APPROVAL)
 *   is immediate; once a worker may be acting it goes through CANCELLING and needs a confirmation.
 * - A lease that expires always leads to LOST, never straight to a rerun (ADR-0003 §3, ADR-0004 §2).
 * - LOST is left only by an explicit reconciliation decision: resume the same attempt, accept a result the
 *   worker produced while disconnected, retry (only when verified safe) or fail; or by cancellation.
 * - PAUSED (p10-approval-pause) is entered only by the worker holding the lease (it stopped the runtime and kept the
 *   workspace) and left by a resume on that worker, a restart from scratch or a cancel.
 */
const SPECS: readonly RuleSpec[] = [
  ['DRAFT', 'submit', 'QUEUED', USER_OR_SYSTEM, 'draft submitted for scheduling'],
  ['DRAFT', 'cancel_requested', 'CANCELLED', USER_OR_SYSTEM, 'draft discarded', REASON],

  ['QUEUED', 'reserve', 'RESERVED', SYSTEM, 'scheduler picked a worker; attempt + lease created'],
  ['QUEUED', 'dependency_blocked', 'BLOCKED', SYSTEM, 'an upstream dependency is not complete'],
  ['QUEUED', 'infeasible', 'FAILED', SYSTEM, 'no eligible worker can ever run the job', REASON],
  ['QUEUED', 'cancel_requested', 'CANCELLED', USER_OR_SYSTEM, 'cancelled before assignment', REASON],

  ['BLOCKED', 'dependency_unblocked', 'QUEUED', SYSTEM, 'all dependencies succeeded'],
  ['BLOCKED', 'dependency_failed', 'FAILED', SYSTEM, 'an upstream dependency failed', REASON],
  ['BLOCKED', 'cancel_requested', 'CANCELLED', USER_OR_SYSTEM, 'cancelled while blocked', REASON],

  ['RESERVED', 'lease_acked', 'STARTING', WORKER, 'worker acknowledged the lease'],
  ['RESERVED', 'lease_declined', 'QUEUED', WORKER, 'worker declined before starting anything'],
  ['RESERVED', 'lease_expired', 'LOST', SYSTEM, 'no acknowledgement before lease expiry'],
  [
    'RESERVED',
    'resume_declined',
    'PAUSED',
    WORKER,
    'worker could not resume the paused attempt (workspace gone or busy)',
    REASON,
  ],
  ['RESERVED', 'cancel_requested', 'CANCELLING', USER_OR_SYSTEM, 'cancel sent to the worker', REASON],

  ['STARTING', 'runtime_started', 'RUNNING', WORKER, 'runtime session spawned'],
  ['STARTING', 'attempt_failed', 'FAILED', WORKER_OR_SYSTEM, 'setup failed', REASON],
  ['STARTING', 'attempt_retry', 'RETRY_WAIT', USER_OR_SYSTEM, 'setup failed; retry is safe', RETRY],
  ['STARTING', 'lease_expired', 'LOST', SYSTEM, 'lease expired during setup'],
  ['STARTING', 'cancel_requested', 'CANCELLING', USER_OR_SYSTEM, 'cancel sent to the worker', REASON],
  ['STARTING', 'pause_confirmed', 'PAUSED', WORKER, 'paused while waiting for an approval', REASON],

  ['RUNNING', 'run_finished', 'VERIFYING', WORKER, 'runtime finished; result collected'],
  ['RUNNING', 'attempt_failed', 'FAILED', WORKER_OR_SYSTEM, 'run failed or exceeded its limits', REASON],
  ['RUNNING', 'attempt_retry', 'RETRY_WAIT', USER_OR_SYSTEM, 'run failed; retry is safe', RETRY],
  ['RUNNING', 'lease_expired', 'LOST', SYSTEM, 'lease expired while running'],
  ['RUNNING', 'cancel_requested', 'CANCELLING', USER_OR_SYSTEM, 'cancel sent to the worker', REASON],
  ['RUNNING', 'pause_confirmed', 'PAUSED', WORKER, 'paused while waiting for an approval', REASON],

  ['VERIFYING', 'verification_passed', 'AWAITING_APPROVAL', WORKER_OR_SYSTEM, 'verified; needs approval'],
  [
    'VERIFYING',
    'verification_passed_no_approval',
    'SUCCEEDED',
    WORKER_OR_SYSTEM,
    'verified; policy requires no approval',
  ],
  ['VERIFYING', 'verification_failed', 'FAILED', WORKER_OR_SYSTEM, 'verification failed', REASON],
  ['VERIFYING', 'attempt_retry', 'RETRY_WAIT', USER_OR_SYSTEM, 'verification failed; retry is safe', RETRY],
  ['VERIFYING', 'lease_expired', 'LOST', SYSTEM, 'lease expired while verifying'],
  ['VERIFYING', 'cancel_requested', 'CANCELLING', USER_OR_SYSTEM, 'cancel sent to the worker', REASON],

  ['AWAITING_APPROVAL', 'approval_granted', 'SUCCEEDED', USER, 'a human approved the result'],
  ['AWAITING_APPROVAL', 'approval_denied', 'FAILED', USER, 'a human rejected the result', REASON],
  // p15-merge-approvals: the merge of an `allow-all` job passed by the owner's security policy (ADR-0056); the
  // policy is the human approval policy of AGENTS.md rule 10 for it, so this is never a default.
  [
    'AWAITING_APPROVAL',
    'approval_auto_granted',
    'SUCCEEDED',
    SYSTEM,
    "the owner's security policy approved the result",
    REASON,
  ],
  ['AWAITING_APPROVAL', 'cancel_requested', 'CANCELLED', USER_OR_SYSTEM, 'cancelled before approval', REASON],

  ['RETRY_WAIT', 'retry_due', 'QUEUED', SYSTEM, 'backoff elapsed; requeued as a new attempt'],
  ['RETRY_WAIT', 'cancel_requested', 'CANCELLED', USER_OR_SYSTEM, 'cancelled during backoff', REASON],

  ['CANCELLING', 'cancel_confirmed', 'CANCELLED', WORKER_OR_SYSTEM, 'worker or reconciler confirmed stop'],
  ['CANCELLING', 'lease_expired', 'LOST', SYSTEM, 'no cancel confirmation before lease expiry'],

  ['LOST', 'reconcile_resume', 'RUNNING', USER_OR_SYSTEM, 'same attempt still alive; new lease', REASON],
  ['LOST', 'reconcile_finished', 'VERIFYING', USER_OR_SYSTEM, 'attempt finished while lost', REASON],
  ['LOST', 'reconcile_retry', 'RETRY_WAIT', USER_OR_SYSTEM, 'verified no unsafe side effects', RETRY],
  ['LOST', 'reconcile_fail', 'FAILED', USER_OR_SYSTEM, 'reconciliation could not recover', REASON],
  ['LOST', 'cancel_requested', 'CANCELLING', USER_OR_SYSTEM, 'cancel pending reconciliation', REASON],
  [
    'LOST',
    'reconcile_pause',
    'PAUSED',
    USER_OR_SYSTEM,
    'a resume of a paused attempt never started; paused again',
    REASON,
  ],

  // p10-approval-pause: a paused attempt resumes on its machine (same attempt, new lease), restarts from scratch
  // (new attempt anywhere) or is cancelled. Nothing runs while paused, so cancelling needs no confirmation.
  ['PAUSED', 'resume_paused', 'RESERVED', USER_OR_SYSTEM, 'resume on the same machine; new lease', REASON],
  ['PAUSED', 'restart_paused', 'QUEUED', USER_OR_SYSTEM, 'restart from scratch as a new attempt', REASON],
  ['PAUSED', 'cancel_requested', 'CANCELLED', USER_OR_SYSTEM, 'cancelled while paused', REASON],
];

export const TRANSITIONS: readonly TransitionRule[] = SPECS.map(
  ([from, trigger, to, actors, description, f]) => ({
    from,
    trigger,
    to,
    actors,
    description,
    requiresReason: f?.reason === true,
    requiresRetrySafe: f?.retrySafe === true,
  }),
);

const INDEX = new Map<string, TransitionRule>();
for (const rule of TRANSITIONS) {
  const key = `${rule.from}:${rule.trigger}`;
  if (INDEX.has(key)) throw new Error(`duplicate transition ${key}`);
  if (TERMINAL_STATES.has(rule.from)) throw new Error(`transition out of terminal state ${key}`);
  INDEX.set(key, rule);
}

export function findRule(from: JobState, trigger: JobTrigger): TransitionRule | undefined {
  return INDEX.get(`${from}:${trigger}`);
}

/** Triggers that are legal (ignoring guards) from `from`, in table order. */
export function allowedTriggers(from: JobState): JobTrigger[] {
  return TRANSITIONS.filter((r) => r.from === from).map((r) => r.trigger);
}

export interface TransitionContext {
  readonly actorType: ActorType;
  readonly reason?: string | null | undefined;
  /** Caller's assertion that a retry is safe (see TransitionRule.requiresRetrySafe). */
  readonly retrySafe?: boolean | undefined;
}

export type RejectionCode =
  'terminal_state' | 'no_transition' | 'actor_not_allowed' | 'reason_required' | 'retry_not_safe';

export type Decision =
  | { readonly ok: true; readonly from: JobState; readonly to: JobState; readonly rule: TransitionRule }
  | {
      readonly ok: false;
      readonly from: JobState;
      readonly trigger: JobTrigger;
      readonly code: RejectionCode;
      readonly message: string;
    };

/** Validates one transition. Pure: never throws for a well-typed input. */
export function decide(from: JobState, trigger: JobTrigger, ctx: TransitionContext): Decision {
  const reject = (code: RejectionCode, message: string): Decision => ({
    ok: false,
    from,
    trigger,
    code,
    message,
  });
  if (TERMINAL_STATES.has(from)) return reject('terminal_state', `${from} is terminal`);
  const rule = findRule(from, trigger);
  if (!rule) return reject('no_transition', `no transition ${from} --${trigger}-->`);
  if (!rule.actors.includes(ctx.actorType)) {
    return reject('actor_not_allowed', `${ctx.actorType} may not cause ${from} --${trigger}-->`);
  }
  if (rule.requiresReason && (ctx.reason === undefined || ctx.reason === null || ctx.reason.trim() === '')) {
    return reject('reason_required', `${from} --${trigger}--> requires a reason`);
  }
  if (rule.requiresRetrySafe && ctx.retrySafe !== true) {
    return reject('retry_not_safe', `${from} --${trigger}--> requires a verified-safe retry`);
  }
  return { ok: true, from, to: rule.to, rule };
}
