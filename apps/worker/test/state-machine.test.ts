import { WorkerState } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  WORKER_EVENT_TYPES,
  WorkerStateMachine,
  allowedEvents,
  transition,
  type WorkerEvent,
  type WorkerEventType,
  type WorkerStatus,
} from '../src/state/machine.js';

const MAX = 3;
const limits = { maxParallelJobs: MAX };
const STATES = WorkerState.options;

function event(type: WorkerEventType): WorkerEvent {
  if (type === 'job_started' || type === 'job_finished') return { type, jobId: 'j1' };
  return { type };
}

/** Statuses reachable in principle: jobs only where the invariants allow them. */
function statuses(): WorkerStatus[] {
  const out: WorkerStatus[] = [];
  for (const state of STATES) {
    for (let jobs = 0; jobs <= MAX; jobs++) {
      if ((state === 'online' || state === 'pending' || state === 'updating') && jobs > 0) continue;
      if (state === 'busy' && jobs === 0) continue;
      out.push({ state, runningJobs: jobs });
    }
  }
  return out;
}

function invariantsHold(s: WorkerStatus): boolean {
  if (s.runningJobs < 0 || s.runningJobs > MAX) return false;
  if (s.state === 'busy') return s.runningJobs > 0;
  if (s.state === 'online' || s.state === 'pending' || s.state === 'updating') return s.runningJobs === 0;
  return true;
}

/** Expected target per (state, event) ignoring guards; undefined = illegal. */
const EXPECTED: Record<
  WorkerState,
  Partial<Record<WorkerEventType, WorkerState | 'online|busy' | 'same'>>
> = {
  offline: {
    connected_unenrolled: 'pending',
    session_established: 'online|busy',
    job_finished: 'same',
    disconnected: 'same',
    revoked: 'quarantined',
    update_started: 'updating',
  },
  pending: {
    enrollment_approved: 'online',
    disconnected: 'offline',
    revoked: 'quarantined',
    update_started: 'updating',
  },
  online: {
    job_started: 'busy',
    drain_requested: 'draining',
    disconnected: 'offline',
    revoked: 'quarantined',
    update_started: 'updating',
  },
  busy: {
    job_started: 'busy',
    job_finished: 'online|busy',
    drain_requested: 'draining',
    disconnected: 'offline',
    revoked: 'quarantined',
  },
  draining: {
    job_finished: 'same',
    drain_requested: 'same',
    drain_cancelled: 'online|busy',
    disconnected: 'offline',
    revoked: 'quarantined',
    update_started: 'updating',
  },
  quarantined: { job_finished: 'same', disconnected: 'same', revoked: 'same', quarantine_cleared: 'offline' },
  updating: {
    disconnected: 'same',
    revoked: 'quarantined',
    update_finished: 'offline',
    update_failed: 'offline',
  },
};

describe('worker state transition table', () => {
  it('declares exactly the expected events per state', () => {
    for (const state of STATES) {
      expect(allowedEvents(state).sort(), state).toEqual(Object.keys(EXPECTED[state]).sort());
    }
  });

  // Property-style: every state × every event × every job count.
  it('every (status, event) pair is either rejected unchanged or lands in a valid status', () => {
    let accepted = 0;
    let rejected = 0;
    for (const from of statuses()) {
      for (const type of WORKER_EVENT_TYPES) {
        const r = transition(from, event(type), limits);
        const expected = EXPECTED[from.state][type];
        if (!r.ok) {
          rejected++;
          expect(r.from).toBe(from);
          expect(r.reason.length).toBeGreaterThan(0);
          continue;
        }
        accepted++;
        expect(expected, `${from.state} --${type}--> accepted but not in table`).toBeDefined();
        expect(invariantsHold(r.to), `${JSON.stringify(from)} --${type}--> ${JSON.stringify(r.to)}`).toBe(
          true,
        );
        if (expected === 'same') expect(r.to.state).toBe(from.state);
        else if (expected === 'online|busy') expect(['online', 'busy']).toContain(r.to.state);
        else expect(r.to.state).toBe(expected);
        // Job counter moves by at most one, and only on job events.
        const delta = r.to.runningJobs - from.runningJobs;
        if (type === 'job_started') expect(delta).toBe(1);
        else if (type === 'job_finished') expect(delta).toBe(-1);
        else expect(delta).toBe(0);
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });

  it('revoked always ends in quarantined; quarantine is left only via quarantine_cleared without jobs', () => {
    for (const from of statuses()) {
      const r = transition(from, { type: 'revoked' }, limits);
      expect(r.ok && r.to.state).toBe('quarantined');
      if (from.state !== 'quarantined') continue;
      for (const type of WORKER_EVENT_TYPES) {
        const t = transition(from, event(type), limits);
        if (t.ok && t.to.state !== 'quarantined') {
          expect(type).toBe('quarantine_cleared');
          expect(from.runningJobs).toBe(0);
        }
      }
    }
  });

  it('guards: capacity, no job to finish, no update/enrollment/unquarantine with running jobs', () => {
    expect(transition({ state: 'busy', runningJobs: MAX }, event('job_started'), limits)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('capacity') as unknown,
    });
    expect(transition({ state: 'offline', runningJobs: 0 }, event('job_finished'), limits).ok).toBe(false);
    expect(transition({ state: 'draining', runningJobs: 1 }, event('update_started'), limits).ok).toBe(false);
    expect(transition({ state: 'offline', runningJobs: 1 }, event('connected_unenrolled'), limits).ok).toBe(
      false,
    );
    expect(transition({ state: 'quarantined', runningJobs: 1 }, event('quarantine_cleared'), limits).ok).toBe(
      false,
    );
    expect(transition({ state: 'busy', runningJobs: 1 }, event('update_started'), limits).ok).toBe(false);
  });

  it('jobs survive a disconnect: busy → offline → session → busy', () => {
    let s: WorkerStatus = { state: 'online', runningJobs: 0 };
    for (const type of ['job_started', 'disconnected', 'session_established'] as const) {
      const r = transition(s, event(type), limits);
      if (!r.ok) throw new Error(r.reason);
      s = r.to;
    }
    expect(s).toEqual({ state: 'busy', runningJobs: 1 });
  });

  it('random walks never break invariants (seeded)', () => {
    let x = 12345;
    const next = (n: number) => {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      return x % n;
    };
    for (let walk = 0; walk < 200; walk++) {
      let s: WorkerStatus = { state: 'offline', runningJobs: 0 };
      for (let step = 0; step < 100; step++) {
        const type = WORKER_EVENT_TYPES[next(WORKER_EVENT_TYPES.length)] ?? 'disconnected';
        const r = transition(s, event(type), limits);
        if (r.ok) s = r.to;
        expect(invariantsHold(s)).toBe(true);
      }
    }
  });
});

describe('WorkerStateMachine', () => {
  it('logs transitions and rejections, notifies listeners only on success', () => {
    const logs: { level: string; msg: string; fields?: Readonly<Record<string, unknown>> }[] = [];
    const logger = {
      info: (msg: string, fields?: Readonly<Record<string, unknown>>) =>
        logs.push({ level: 'info', msg, ...(fields ? { fields } : {}) }),
      warn: (msg: string, fields?: Readonly<Record<string, unknown>>) =>
        logs.push({ level: 'warn', msg, ...(fields ? { fields } : {}) }),
    };
    const m = new WorkerStateMachine(limits, logger);
    const seen: string[] = [];
    m.onTransition((r) => seen.push(`${r.from.state}->${r.to.state}`));
    expect(m.dispatch({ type: 'enrollment_approved' }).ok).toBe(false);
    expect(m.state).toBe('offline');
    expect(m.dispatch({ type: 'connected_unenrolled' }).ok).toBe(true);
    expect(m.dispatch({ type: 'enrollment_approved' }).ok).toBe(true);
    expect(m.state).toBe('online');
    expect(seen).toEqual(['offline->pending', 'pending->online']);
    expect(logs[0]).toMatchObject({
      level: 'warn',
      fields: { state: 'offline', event: 'enrollment_approved' },
    });
    expect(logs.filter((l) => l.level === 'info')).toHaveLength(2);
  });
});
