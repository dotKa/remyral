/**
 * p20-outcome (docs/design/p20-outcome-contract.md): the pure part of the goal ledger — what the records of a goal say
 * about it (who owns the next step, what it waits for, when to look again), and when "nobody owns it" becomes an
 * intervention. No I/O: the service gathers the facts, this decides.
 */

export type GoalState = 'open' | 'done' | 'intervention' | 'cancelled';
export type GoalOwner = 'assistant' | 'user' | 'job' | 'workflow' | 'system';
export type GoalOrigin = 'plan' | 'job' | 'workflow_run' | 'watch';
export type GoalResolution = 'outcome' | 'assistant' | 'user' | 'cancel';

/** After a follow-up / continuation turn: how long the assistant has to move the goal before it is an intervention. */
export const GOAL_PROGRESS_MS = 30 * 60_000;
/**
 * p22-run-attention: a run that succeeded with attention is the assistant's; after this its own check turn comes
 * (p21-goal-check), unless a watch follow-up already moved it.
 */
export const GOAL_ATTENTION_GRACE_MS = 2 * 60_000;
/** A job that failed for good: how long an auto-fix job may take to appear. */
export const GOAL_AUTOFIX_GRACE_MS = 10 * 60_000;
/** An active watch: how long past its own deadline the ledger waits for the watch engine to end it. */
export const GOAL_WATCH_GRACE_MS = 10 * 60_000;
/** The watch follow-up window (chat/watch-follow-up.ts FOLLOW_UP_WINDOW_MS). */
export const GOAL_FOLLOW_UP_WINDOW_MS = 30 * 60_000;

/** A record of the goal, normalised. */
export interface GoalRecordFact {
  readonly kind: 'job' | 'workflow_run' | 'watch';
  readonly id: string;
  readonly createdAt: Date;
  /**
   * `live`: under way (queued, running, retrying, an active watch); `waiting_user`: stopped for the person (an approval,
   * a paused run); then the ends.
   */
  readonly phase: 'live' | 'waiting_user' | 'succeeded' | 'failed' | 'cancelled' | 'ended_unmet';
  readonly endedAt: Date | null;
  /** The concrete reason / summary (a watch's last check or end reason, a job's error, a run's reason). */
  readonly detail: string | null;
  /** Watch: the hand-off column (`sent`, `skipped:<why>`, null). */
  readonly followUp?: string | null;
  /** Watch: when its follow-up turn was created (chat_deliveries.sent_at). */
  readonly followUpAt?: Date | null;
  /** Watch / plan: a continuation claim is live (being sent). */
  readonly deliveryLive?: boolean;
  /** Active watch: its own deadline. */
  readonly expiresAt?: Date | null;
  /** p22-run-attention: a run that succeeded while a step could not do its work (`workflow_runs.attention`). */
  readonly attention?: boolean;
}

export interface GoalPlanFact {
  readonly state: string;
  readonly stalled: string | null;
  readonly contDue: boolean;
  readonly deliveryLive: boolean;
  /** An item failed its retries (chat_plan_items.failures at the cap) and stays blocked. */
  readonly itemCapped: boolean;
  /** A decision, a card or the person's own item waits for them. */
  readonly waitsForUser: boolean;
  /** The plan's last change (progress). */
  readonly updatedAt: Date;
  /** The last continuation turn was created (chat_deliveries.sent_at). */
  readonly lastTurnAt: Date | null;
}

export interface GoalFacts {
  readonly origin: GoalOrigin;
  readonly plan: GoalPlanFact | null;
  readonly records: readonly GoalRecordFact[];
  /** The assistant answers now (chat status). */
  readonly chatAvailable: boolean;
  readonly openedAt: Date;
}

export interface GoalAssessment {
  readonly state: GoalState;
  readonly owner: GoalOwner;
  readonly nextAction: string;
  readonly blockedReason: string | null;
  readonly reevaluateAt: Date | null;
  readonly detail: string | null;
  readonly resolvedBy: GoalResolution | null;
  /** When the goal last moved (the newest record change). */
  readonly progressAt: Date;
}

const latest = (a: Date | null, b: Date | null): Date | null =>
  a === null ? b : b === null ? a : a.getTime() >= b.getTime() ? a : b;

function open(
  owner: GoalOwner,
  nextAction: string,
  progressAt: Date,
  x: { reevaluateAt?: Date | null; detail?: string | null } = {},
): GoalAssessment {
  return {
    state: 'open',
    owner,
    nextAction,
    blockedReason: null,
    reevaluateAt: x.reevaluateAt ?? null,
    detail: x.detail ?? null,
    resolvedBy: null,
    progressAt,
  };
}

function intervention(
  blockedReason: string,
  nextAction: string,
  progressAt: Date,
  detail: string | null,
): GoalAssessment {
  return {
    state: 'intervention',
    owner: 'user',
    nextAction,
    blockedReason,
    reevaluateAt: null,
    detail,
    resolvedBy: null,
    progressAt,
  };
}

function closed(
  state: 'done' | 'cancelled',
  resolvedBy: GoalResolution,
  progressAt: Date,
  detail: string | null,
): GoalAssessment {
  return {
    state,
    owner: 'system',
    nextAction: state === 'done' ? 'none' : 'none',
    blockedReason: null,
    reevaluateAt: null,
    detail,
    resolvedBy,
    progressAt,
  };
}

/** The assistant owns it and its time ran out: nobody moves it — say why. */
function overdue(a: GoalAssessment, f: GoalFacts, now: Date): GoalAssessment {
  if (a.state !== 'open' || a.owner !== 'assistant' || a.reevaluateAt === null) return a;
  if (a.reevaluateAt.getTime() > now.getTime()) return a;
  return intervention(
    f.chatAvailable ? 'no_progress' : 'assistant_unavailable',
    'user_action',
    a.progressAt,
    a.detail,
  );
}

function recordProgress(r: GoalRecordFact): Date {
  return latest(latest(r.createdAt, r.endedAt), r.followUpAt ?? null) ?? r.createdAt;
}

/** What the records of a goal say about it now. */
export function assessGoal(f: GoalFacts, now: Date): GoalAssessment {
  const records = [...f.records].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  let progress: Date = f.openedAt;
  for (const r of records) progress = latest(progress, recordProgress(r)) ?? progress;
  if (f.plan !== null) progress = latest(progress, latest(f.plan.updatedAt, f.plan.lastTurnAt)) ?? progress;

  const live = records.filter((r) => r.phase === 'live' || r.phase === 'waiting_user');
  const liveOwner = (): GoalAssessment | null => {
    const r = live.at(-1);
    if (r === undefined) return null;
    if (r.phase === 'waiting_user') return open('user', 'user_approval', progress, { detail: r.detail });
    if (r.kind === 'job') return open('job', 'job_running', progress);
    if (r.kind === 'workflow_run') return open('workflow', 'run_running', progress);
    return open('system', 'watch_waiting', progress, {
      reevaluateAt:
        r.expiresAt === null || r.expiresAt === undefined
          ? null
          : new Date(r.expiresAt.getTime() + GOAL_WATCH_GRACE_MS),
    });
  };

  if (f.origin === 'plan' && f.plan !== null) {
    const p = f.plan;
    if (p.state === 'done') return closed('done', 'outcome', progress, null);
    if (p.state === 'cancelled' || p.state === 'superseded')
      return closed('cancelled', 'cancel', progress, null);
    if (p.state === 'drafting' || p.state === 'in_review') return open('user', 'plan_review', progress);
    if (p.state === 'paused') return open('user', 'plan_paused', progress);
    if (p.stalled !== null) return intervention(`plan_stalled:${p.stalled}`, 'plan_continue', progress, null);
    if (p.itemCapped) return intervention('plan_item_failed', 'plan_continue', progress, null);
    const running = live.filter((r) => r.kind !== 'watch' || r.phase === 'waiting_user');
    if (running.length > 0) {
      const head = liveOwner();
      if (head !== null) return head;
    }
    if (p.waitsForUser) return open('user', 'user_decision', progress);
    const watching = liveOwner();
    if (watching !== null) return watching;
    return overdue(
      open('assistant', p.contDue || p.deliveryLive ? 'plan_continue' : 'assistant_turn', progress, {
        reevaluateAt: new Date(progress.getTime() + GOAL_PROGRESS_MS),
      }),
      f,
      now,
    );
  }

  const head = liveOwner();
  if (head !== null) return overdue(head, f, now);
  // A cancelled watch never decides the outcome (the run / job it watched still does); only cancelled watches left:
  // the person stopped what the goal waited for.
  const deciding = records.filter((r) => !(r.kind === 'watch' && r.phase === 'cancelled'));
  const last = deciding.at(-1);
  if (last === undefined && records.length > 0) return closed('cancelled', 'cancel', progress, null);
  if (last === undefined) {
    // Nothing linked any more (a record was deleted): the assistant has the usual time, then it is an intervention.
    return overdue(
      open('assistant', 'assistant_turn', progress, {
        reevaluateAt: new Date(progress.getTime() + GOAL_PROGRESS_MS),
      }),
      f,
      now,
    );
  }
  const ended = last.endedAt ?? last.createdAt;
  switch (last.phase) {
    case 'succeeded':
      if (last.attention === true)
        return overdue(
          open('assistant', 'assistant_turn', progress, {
            reevaluateAt: new Date(ended.getTime() + GOAL_ATTENTION_GRACE_MS),
            detail: last.detail,
          }),
          f,
          now,
        );
      return closed('done', 'outcome', progress, last.detail);
    case 'cancelled':
      return closed('cancelled', 'cancel', progress, last.detail);
    case 'failed':
      if (last.kind === 'job') {
        if (now.getTime() < ended.getTime() + GOAL_AUTOFIX_GRACE_MS)
          return open('system', 'auto_fix', progress, {
            reevaluateAt: new Date(ended.getTime() + GOAL_AUTOFIX_GRACE_MS),
            detail: last.detail,
          });
        return intervention('job_failed', 'user_action', progress, last.detail);
      }
      if (last.kind === 'workflow_run')
        return intervention('run_failed', 'user_action', progress, last.detail);
      return intervention('no_progress', 'user_action', progress, last.detail);
    case 'ended_unmet': {
      const fu = last.followUp ?? null;
      if (last.deliveryLive === true)
        return open('assistant', 'follow_up', progress, { detail: last.detail });
      if (fu === null) {
        const until = new Date(ended.getTime() + GOAL_FOLLOW_UP_WINDOW_MS);
        if (now.getTime() < until.getTime())
          return open('assistant', 'follow_up', progress, { reevaluateAt: until, detail: last.detail });
        return intervention(
          f.chatAvailable ? 'follow_up_window' : 'assistant_unavailable',
          'user_action',
          progress,
          last.detail,
        );
      }
      if (fu === 'sent') {
        const sentAt = last.followUpAt ?? ended;
        return overdue(
          open('assistant', 'assistant_turn', progress, {
            reevaluateAt: new Date(sentAt.getTime() + GOAL_PROGRESS_MS),
            detail: last.detail,
          }),
          f,
          now,
        );
      }
      if (fu === 'skipped:cap') return intervention('follow_up_cap', 'user_action', progress, last.detail);
      if (fu === 'skipped:budget') return intervention('budget', 'user_action', progress, last.detail);
      if (fu === 'skipped:user_active') return open('user', 'user_reply', progress, { detail: last.detail });
      if (fu === 'skipped:archived') return closed('cancelled', 'cancel', progress, last.detail);
      return intervention('assistant_error', 'user_action', progress, last.detail);
    }
    default:
      return open('system', 'watch_waiting', progress);
  }
}

/** What the derived assessment saw (a change lifts a state the assistant declared). */
export function goalFingerprint(f: GoalFacts): string {
  const parts = [...f.records]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => `${r.kind}:${r.id.slice(0, 8)}:${r.phase}:${r.followUp ?? ''}`);
  if (f.plan !== null)
    parts.unshift(`plan:${f.plan.state}:${f.plan.stalled ?? ''}:${String(f.plan.itemCapped)}`);
  return parts.join('|').slice(0, 2000);
}

/** The default "what counts as done" text of a new goal (the assistant refines it with goal_update). */
export function defaultOutcome(origin: GoalOrigin, lang: 'tr' | 'en', title: string): string {
  const t = title.replace(/\s+/g, ' ').trim().slice(0, 200);
  const tr = lang === 'tr';
  switch (origin) {
    case 'plan':
      return (tr ? `Plan tamamlanır: ${t}` : `The plan is done: ${t}`).slice(0, 300);
    case 'job':
      return (tr ? `İş başarıyla biter: ${t}` : `The job succeeds: ${t}`).slice(0, 300);
    case 'workflow_run':
      return (tr ? `Workflow başarıyla biter: ${t}` : `The workflow run succeeds: ${t}`).slice(0, 300);
    case 'watch':
      return (tr ? `Takip koşulu sağlanır: ${t}` : `The watch condition is met: ${t}`).slice(0, 300);
  }
}

/** Plain, bounded model / person text for a goal column. */
export function goalText(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const one = s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (one === '') return null;
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
