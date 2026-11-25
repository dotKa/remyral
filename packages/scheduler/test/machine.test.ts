import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPES,
  allowedTriggers,
  ATTEMPT_OPEN_STATES,
  attemptOutcomeFor,
  decide,
  isJobState,
  isJobTrigger,
  isTerminal,
  JOB_STATES,
  JOB_TRIGGERS,
  type JobState,
  type JobTrigger,
  TERMINAL_STATES,
  TRANSITIONS,
} from '../src/index.js';

/**
 * Independent specification of the legal transitions, written out by hand so that any change to the
 * table must be mirrored here deliberately. Every (state, trigger) pair not listed must be rejected.
 */
const EXPECTED: Record<JobState, Partial<Record<JobTrigger, JobState>>> = {
  DRAFT: { submit: 'QUEUED', cancel_requested: 'CANCELLED' },
  QUEUED: {
    reserve: 'RESERVED',
    dependency_blocked: 'BLOCKED',
    infeasible: 'FAILED',
    cancel_requested: 'CANCELLED',
  },
  BLOCKED: { dependency_unblocked: 'QUEUED', dependency_failed: 'FAILED', cancel_requested: 'CANCELLED' },
  RESERVED: {
    lease_acked: 'STARTING',
    lease_declined: 'QUEUED',
    lease_expired: 'LOST',
    cancel_requested: 'CANCELLING',
    resume_declined: 'PAUSED',
  },
  STARTING: {
    runtime_started: 'RUNNING',
    attempt_failed: 'FAILED',
    attempt_retry: 'RETRY_WAIT',
    lease_expired: 'LOST',
    cancel_requested: 'CANCELLING',
    pause_confirmed: 'PAUSED',
  },
  RUNNING: {
    run_finished: 'VERIFYING',
    attempt_failed: 'FAILED',
    attempt_retry: 'RETRY_WAIT',
    lease_expired: 'LOST',
    cancel_requested: 'CANCELLING',
    pause_confirmed: 'PAUSED',
  },
  VERIFYING: {
    verification_passed: 'AWAITING_APPROVAL',
    verification_passed_no_approval: 'SUCCEEDED',
    verification_failed: 'FAILED',
    attempt_retry: 'RETRY_WAIT',
    lease_expired: 'LOST',
    cancel_requested: 'CANCELLING',
  },
  AWAITING_APPROVAL: {
    approval_granted: 'SUCCEEDED',
    approval_denied: 'FAILED',
    approval_auto_granted: 'SUCCEEDED',
    cancel_requested: 'CANCELLED',
  },
  SUCCEEDED: {},
  RETRY_WAIT: { retry_due: 'QUEUED', cancel_requested: 'CANCELLED' },
  FAILED: {},
  CANCELLING: { cancel_confirmed: 'CANCELLED', lease_expired: 'LOST' },
  CANCELLED: {},
  LOST: {
    reconcile_resume: 'RUNNING',
    reconcile_finished: 'VERIFYING',
    reconcile_retry: 'RETRY_WAIT',
    reconcile_fail: 'FAILED',
    cancel_requested: 'CANCELLING',
    reconcile_pause: 'PAUSED',
  },
  PAUSED: {
    resume_paused: 'RESERVED',
    restart_paused: 'QUEUED',
    cancel_requested: 'CANCELLED',
  },
};

/** A context that satisfies every guard for `rule` (first allowed actor, reason, retry-safe). */
function permissive(from: JobState, trigger: JobTrigger) {
  const rule = TRANSITIONS.find((r) => r.from === from && r.trigger === trigger);
  return { actorType: rule?.actors[0] ?? 'system', reason: 'because', retrySafe: true } as const;
}

const pairs = JOB_STATES.flatMap((s) => JOB_TRIGGERS.map((t) => [s, t] as const));

describe('transition table', () => {
  it('has the documented size', () => {
    expect(JOB_STATES).toHaveLength(15);
    expect(JOB_TRIGGERS).toHaveLength(31);
    expect(TRANSITIONS).toHaveLength(49);
    expect(pairs).toHaveLength(15 * 31);
  });

  it.each(pairs)('%s × %s matches the specification', (from, trigger) => {
    const expected = EXPECTED[from][trigger];
    const decision = decide(from, trigger, permissive(from, trigger));
    if (expected === undefined) {
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.code).toBe(TERMINAL_STATES.has(from) ? 'terminal_state' : 'no_transition');
      }
    } else {
      expect(decision).toMatchObject({ ok: true, from, to: expected });
    }
  });

  it('lists exactly the specified transitions', () => {
    const specified = JOB_STATES.flatMap((s) =>
      Object.entries(EXPECTED[s]).map(([t, to]) => `${s}:${t}:${to}`),
    ).sort();
    expect(TRANSITIONS.map((r) => `${r.from}:${r.trigger}:${r.to}`).sort()).toEqual(specified);
  });

  it('uses every trigger at least once', () => {
    const used = new Set(TRANSITIONS.map((r) => r.trigger));
    expect(JOB_TRIGGERS.filter((t) => !used.has(t))).toEqual([]);
  });

  it('makes terminal states immutable', () => {
    for (const s of TERMINAL_STATES) {
      expect(allowedTriggers(s)).toEqual([]);
      for (const t of JOB_TRIGGERS) {
        for (const actorType of ACTOR_TYPES) {
          expect(decide(s, t, { actorType, reason: 'x', retrySafe: true })).toMatchObject({
            ok: false,
            code: 'terminal_state',
          });
        }
      }
    }
  });

  it('reaches every state from DRAFT and a terminal state from every state', () => {
    const reach = (start: JobState): Set<JobState> => {
      const seen = new Set<JobState>([start]);
      const queue = [start];
      while (queue.length) {
        const s = queue.shift() as JobState;
        for (const r of TRANSITIONS) {
          if (r.from === s && !seen.has(r.to)) {
            seen.add(r.to);
            queue.push(r.to);
          }
        }
      }
      return seen;
    };
    expect([...reach('DRAFT')].sort()).toEqual([...JOB_STATES].sort());
    for (const s of JOB_STATES) {
      expect(
        [...reach(s)].some((x) => TERMINAL_STATES.has(x)),
        s,
      ).toBe(true);
    }
  });

  it('can cancel every non-terminal state', () => {
    for (const s of JOB_STATES) {
      if (TERMINAL_STATES.has(s)) continue;
      const to = s === 'CANCELLING' ? 'CANCELLED' : EXPECTED[s].cancel_requested;
      expect(to, s).toBeDefined();
    }
  });
});

describe('reconciliation, not blind rerun (ADR-0003 §3, ADR-0004 §2/§5)', () => {
  it('sends every lease expiry to LOST', () => {
    for (const r of TRANSITIONS.filter((x) => x.trigger === 'lease_expired')) expect(r.to).toBe('LOST');
  });

  it('never leaves LOST towards scheduling or execution except resume of the same attempt', () => {
    const targets = TRANSITIONS.filter((r) => r.from === 'LOST').map((r) => r.to);
    expect(targets).not.toContain('QUEUED');
    expect(targets).not.toContain('RESERVED');
    expect(targets).not.toContain('STARTING');
  });

  it('allows only reconciliation decisions or cancellation from LOST, never by a worker', () => {
    for (const r of TRANSITIONS.filter((x) => x.from === 'LOST')) {
      expect(r.trigger.startsWith('reconcile_') || r.trigger === 'cancel_requested').toBe(true);
      expect(r.actors).not.toContain('worker');
      expect(r.requiresReason).toBe(true);
    }
  });

  it('requires a retry-safe assertion for every transition into RETRY_WAIT', () => {
    const intoRetry = TRANSITIONS.filter((r) => r.to === 'RETRY_WAIT');
    expect(intoRetry.length).toBeGreaterThan(0);
    for (const r of intoRetry) {
      expect(r.requiresRetrySafe).toBe(true);
      expect(r.actors).not.toContain('worker');
      expect(decide(r.from, r.trigger, { actorType: 'system', reason: 'x' })).toMatchObject({
        ok: false,
        code: 'retry_not_safe',
      });
      expect(decide(r.from, r.trigger, { actorType: 'system', reason: 'x', retrySafe: false })).toMatchObject(
        {
          ok: false,
          code: 'retry_not_safe',
        },
      );
    }
  });

  it('only requeues from RETRY_WAIT, a declined reservation, an unblocked dependency or a restarted pause', () => {
    const intoQueued = TRANSITIONS.filter((r) => r.to === 'QUEUED').map((r) => `${r.from}:${r.trigger}`);
    expect(intoQueued.sort()).toEqual([
      'BLOCKED:dependency_unblocked',
      'DRAFT:submit',
      'PAUSED:restart_paused',
      'RESERVED:lease_declined',
      'RETRY_WAIT:retry_due',
    ]);
  });
});

describe('guards', () => {
  it('lets only the master apply a security-policy approval, always with a reason (p15-merge-approvals)', () => {
    for (const actorType of ['worker', 'user'] as const) {
      expect(decide('AWAITING_APPROVAL', 'approval_auto_granted', { actorType, reason: 'x' })).toMatchObject({
        ok: false,
        code: 'actor_not_allowed',
      });
    }
    expect(decide('AWAITING_APPROVAL', 'approval_auto_granted', { actorType: 'system' })).toMatchObject({
      ok: false,
    });
    expect(
      decide('AWAITING_APPROVAL', 'approval_auto_granted', { actorType: 'system', reason: 'policy' }),
    ).toMatchObject({ ok: true, to: 'SUCCEEDED' });
  });

  it('lets only humans approve or deny (ADR-0010)', () => {
    for (const actorType of ['worker', 'system'] as const) {
      expect(decide('AWAITING_APPROVAL', 'approval_granted', { actorType })).toMatchObject({
        ok: false,
        code: 'actor_not_allowed',
      });
      expect(decide('AWAITING_APPROVAL', 'approval_denied', { actorType, reason: 'no' })).toMatchObject({
        ok: false,
        code: 'actor_not_allowed',
      });
    }
    expect(decide('AWAITING_APPROVAL', 'approval_granted', { actorType: 'user' })).toMatchObject({
      ok: true,
      to: 'SUCCEEDED',
    });
  });

  it('checks the actor type against every rule', () => {
    for (const r of TRANSITIONS) {
      for (const actorType of ACTOR_TYPES) {
        const d = decide(r.from, r.trigger, { actorType, reason: 'x', retrySafe: true });
        expect(d.ok, `${r.from}:${r.trigger}:${actorType}`).toBe(r.actors.includes(actorType));
        if (!d.ok) expect(d.code).toBe('actor_not_allowed');
      }
    }
  });

  it.each(['', '   ', null, undefined])('requires a reason where declared (%j)', (reason) => {
    for (const r of TRANSITIONS.filter((x) => x.requiresReason)) {
      const actorType = r.actors[0] ?? 'system';
      expect(decide(r.from, r.trigger, { actorType, reason, retrySafe: true })).toMatchObject({
        ok: false,
        code: 'reason_required',
      });
    }
  });

  it('does not require a reason elsewhere', () => {
    for (const r of TRANSITIONS.filter((x) => !x.requiresReason)) {
      expect(decide(r.from, r.trigger, { actorType: r.actors[0] ?? 'system' }).ok).toBe(true);
    }
  });

  it('lets workers drive only their own execution progress', () => {
    const workerTriggers = new Set(
      TRANSITIONS.filter((r) => r.actors.includes('worker')).map((r) => r.trigger),
    );
    expect([...workerTriggers].sort()).toEqual(
      [
        'attempt_failed',
        'cancel_confirmed',
        'lease_acked',
        'lease_declined',
        'pause_confirmed',
        'resume_declined',
        'run_finished',
        'runtime_started',
        'verification_failed',
        'verification_passed',
        'verification_passed_no_approval',
      ].sort(),
    );
  });
});

describe('state helpers', () => {
  it('classifies states and triggers', () => {
    expect(isJobState('RUNNING')).toBe(true);
    expect(isJobState('running')).toBe(false);
    expect(isJobState(1)).toBe(false);
    expect(isJobTrigger('submit')).toBe(true);
    expect(isJobTrigger('create')).toBe(false);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('LOST')).toBe(false);
  });

  it('ends the attempt with an outcome whenever a transition leaves the attempt-open states', () => {
    for (const r of TRANSITIONS) {
      if (!ATTEMPT_OPEN_STATES.has(r.from) || ATTEMPT_OPEN_STATES.has(r.to)) continue;
      expect(attemptOutcomeFor(r.to), `${r.from}:${r.trigger}`).toBeDefined();
    }
    expect(attemptOutcomeFor('RUNNING')).toBeUndefined();
    expect(attemptOutcomeFor('QUEUED')).toBe('declined');
    expect(attemptOutcomeFor('AWAITING_APPROVAL')).toBe('succeeded');
  });

  it('enters the attempt-open states only by reservation', () => {
    const entering = TRANSITIONS.filter(
      (r) => !ATTEMPT_OPEN_STATES.has(r.from) && ATTEMPT_OPEN_STATES.has(r.to),
    );
    expect(entering.map((r) => r.trigger)).toEqual(['reserve']);
  });

  it('records a restarted pause as cancelled, not declined (p10-approval-pause)', () => {
    expect(attemptOutcomeFor('QUEUED', 'PAUSED')).toBe('cancelled');
    expect(attemptOutcomeFor('QUEUED', 'RESERVED')).toBe('declined');
    expect(attemptOutcomeFor('CANCELLED', 'PAUSED')).toBe('cancelled');
    expect(attemptOutcomeFor('RESERVED', 'PAUSED')).toBeUndefined();
  });
});

describe('approval pause (p10-approval-pause)', () => {
  it('keeps the attempt open while paused', () => {
    expect(ATTEMPT_OPEN_STATES.has('PAUSED')).toBe(true);
    expect(isTerminal('PAUSED')).toBe(false);
    expect(attemptOutcomeFor('PAUSED')).toBeUndefined();
  });

  it('is entered only by the worker holding the lease, with a reason, or by reconciliation of a lapsed resume', () => {
    const into = TRANSITIONS.filter((r) => r.to === 'PAUSED');
    expect(into.map((r) => `${r.from}:${r.trigger}`).sort()).toEqual([
      'LOST:reconcile_pause',
      'RESERVED:resume_declined',
      'RUNNING:pause_confirmed',
      'STARTING:pause_confirmed',
    ]);
    for (const r of into) expect(r.requiresReason).toBe(true);
    for (const r of into.filter((x) => x.from !== 'LOST')) expect(r.actors).toEqual(['worker']);
    expect(decide('RUNNING', 'pause_confirmed', { actorType: 'system', reason: 'x' })).toMatchObject({
      ok: false,
      code: 'actor_not_allowed',
    });
    expect(decide('RUNNING', 'pause_confirmed', { actorType: 'user', reason: 'x' })).toMatchObject({
      ok: false,
      code: 'actor_not_allowed',
    });
  });

  it('is left only by a resume, a restart from scratch or a cancel — never by a worker', () => {
    const out = TRANSITIONS.filter((r) => r.from === 'PAUSED');
    expect(out.map((r) => `${r.trigger}:${r.to}`).sort()).toEqual([
      'cancel_requested:CANCELLED',
      'restart_paused:QUEUED',
      'resume_paused:RESERVED',
    ]);
    for (const r of out) {
      expect(r.actors).not.toContain('worker');
      expect(r.requiresReason).toBe(true);
    }
  });

  it('cannot pause a job that is not running an attempt', () => {
    for (const s of JOB_STATES) {
      if (s === 'RUNNING' || s === 'STARTING') continue;
      expect(decide(s, 'pause_confirmed', { actorType: 'worker', reason: 'x' }).ok, s).toBe(false);
    }
  });

  it('a resume declined by the worker returns to PAUSED instead of requeueing elsewhere', () => {
    expect(decide('RESERVED', 'resume_declined', { actorType: 'worker', reason: 'gone' })).toMatchObject({
      ok: true,
      to: 'PAUSED',
    });
    expect(decide('RESERVED', 'resume_declined', { actorType: 'system', reason: 'gone' }).ok).toBe(false);
  });
});
