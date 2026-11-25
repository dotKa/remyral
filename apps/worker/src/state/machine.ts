import type { WorkerState } from '@remyral/protocol';

/**
 * Worker lifecycle (ROADMAP P2): a pure transition function plus a small stateful
 * wrapper that logs and notifies. Every event is explicit; anything not listed in
 * the table is an illegal transition and leaves the status unchanged.
 *
 *   offline ──connected_unenrolled──► pending ──enrollment_approved──► online
 *   offline ──session_established──► online | busy (jobs survived the disconnect)
 *   online ◄─job_finished(last)── busy ◄──job_started── online
 *   online | busy ──drain_requested──► draining ──drain_cancelled──► online | busy
 *   pending | online | busy | draining ──disconnected──► offline (jobs keep running)
 *   * ──revoked──► quarantined ──quarantine_cleared (no jobs)──► offline
 *   online | draining | offline | pending ──update_started (no jobs)──► updating
 *   updating ──update_finished | update_failed──► offline
 *
 * Duplicate deliveries (a second DRAIN, a second disconnect notice, revoked while
 * quarantined) are legal no-ops, because the transport is at-least-once.
 */

export const WORKER_EVENT_TYPES = [
  'connected_unenrolled',
  'enrollment_approved',
  'session_established',
  'job_started',
  'job_finished',
  'drain_requested',
  'drain_cancelled',
  'disconnected',
  'revoked',
  'quarantine_cleared',
  'update_started',
  'update_finished',
  'update_failed',
] as const;
export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number];

export type WorkerEvent =
  | { type: Exclude<WorkerEventType, 'job_started' | 'job_finished' | 'disconnected' | 'revoked'> }
  | { type: 'job_started' | 'job_finished'; jobId: string }
  | { type: 'disconnected'; reason?: string }
  | { type: 'revoked'; reason?: string };

export interface WorkerStatus {
  readonly state: WorkerState;
  /** Jobs whose processes are alive on this worker (independent of connectivity). */
  readonly runningJobs: number;
}

export interface MachineLimits {
  readonly maxParallelJobs: number;
}

export type TransitionResult =
  | { ok: true; from: WorkerStatus; to: WorkerStatus; event: WorkerEvent }
  | { ok: false; from: WorkerStatus; event: WorkerEvent; reason: string };

const idleOrBusy = (jobs: number): WorkerState => (jobs > 0 ? 'busy' : 'online');

type Rule = (s: WorkerStatus, limits: MachineLimits) => WorkerStatus | string;

/** state → event → rule; a string result is the rejection reason. */
const TABLE: Readonly<Partial<Record<WorkerState, Partial<Record<WorkerEventType, Rule>>>>> = {
  offline: {
    connected_unenrolled: (s) =>
      s.runningJobs > 0 ? 'cannot enroll while jobs are running' : { ...s, state: 'pending' },
    session_established: (s) => ({ ...s, state: idleOrBusy(s.runningJobs) }),
    job_finished: finishJob,
    disconnected: same,
    revoked: quarantine,
    update_started: startUpdate,
  },
  pending: {
    enrollment_approved: (s) => ({ ...s, state: 'online' }),
    disconnected: (s) => ({ ...s, state: 'offline' }),
    revoked: quarantine,
    update_started: startUpdate,
  },
  online: {
    job_started: startJob,
    drain_requested: (s) => ({ ...s, state: 'draining' }),
    disconnected: (s) => ({ ...s, state: 'offline' }),
    revoked: quarantine,
    update_started: startUpdate,
  },
  busy: {
    job_started: startJob,
    job_finished: (s) => {
      const next = finishJob(s);
      return typeof next === 'string' ? next : { ...next, state: idleOrBusy(next.runningJobs) };
    },
    drain_requested: (s) => ({ ...s, state: 'draining' }),
    disconnected: (s) => ({ ...s, state: 'offline' }),
    revoked: quarantine,
  },
  draining: {
    job_finished: finishJob,
    drain_requested: same,
    drain_cancelled: (s) => ({ ...s, state: idleOrBusy(s.runningJobs) }),
    disconnected: (s) => ({ ...s, state: 'offline' }),
    revoked: quarantine,
    update_started: startUpdate,
  },
  quarantined: {
    job_finished: finishJob,
    disconnected: same,
    revoked: same,
    quarantine_cleared: (s) =>
      s.runningJobs > 0 ? 'jobs must be stopped before leaving quarantine' : { ...s, state: 'offline' },
  },
  updating: {
    disconnected: same,
    revoked: quarantine,
    update_finished: (s) => ({ ...s, state: 'offline' }),
    update_failed: (s) => ({ ...s, state: 'offline' }),
  },
};

function same(s: WorkerStatus): WorkerStatus {
  return s;
}

function quarantine(s: WorkerStatus): WorkerStatus {
  return { ...s, state: 'quarantined' };
}

function startJob(s: WorkerStatus, limits: MachineLimits): WorkerStatus | string {
  if (s.runningJobs >= limits.maxParallelJobs) {
    return `capacity reached (${String(s.runningJobs)}/${String(limits.maxParallelJobs)})`;
  }
  return { state: 'busy', runningJobs: s.runningJobs + 1 };
}

function finishJob(s: WorkerStatus): WorkerStatus | string {
  if (s.runningJobs === 0) return 'no running job to finish';
  return { ...s, runningJobs: s.runningJobs - 1 };
}

function startUpdate(s: WorkerStatus): WorkerStatus | string {
  return s.runningJobs > 0 ? 'cannot update while jobs are running' : { ...s, state: 'updating' };
}

/** Pure transition function. */
export function transition(from: WorkerStatus, event: WorkerEvent, limits: MachineLimits): TransitionResult {
  const rule = TABLE[from.state]?.[event.type];
  if (rule === undefined) {
    return { ok: false, from, event, reason: `event ${event.type} is not allowed in state ${from.state}` };
  }
  const next = rule(from, limits);
  if (typeof next === 'string') return { ok: false, from, event, reason: next };
  return { ok: true, from, to: next, event };
}

/** Events legal in a state (ignoring guards); for diagnostics and tests. */
export function allowedEvents(state: WorkerState): WorkerEventType[] {
  return Object.keys(TABLE[state] ?? {}) as WorkerEventType[];
}

export interface StateLogger {
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Stateful wrapper: holds the current status, logs every outcome, notifies listeners. */
export class WorkerStateMachine {
  #status: WorkerStatus;
  readonly #listeners = new Set<(r: Extract<TransitionResult, { ok: true }>) => void>();

  constructor(
    private limits: MachineLimits,
    private readonly logger: StateLogger,
    initial: WorkerStatus = { state: 'offline', runningJobs: 0 },
  ) {
    this.#status = initial;
  }

  get status(): WorkerStatus {
    return this.#status;
  }

  /**
   * ADR-0015: new limits from a panel configuration take effect for the next job start; running jobs are never
   * stopped by a lower limit (the worker just takes no new job until it is below it).
   */
  setLimits(limits: MachineLimits): void {
    this.limits = limits;
  }

  get maxParallelJobs(): number {
    return this.limits.maxParallelJobs;
  }

  get state(): WorkerState {
    return this.#status.state;
  }

  dispatch(event: WorkerEvent): TransitionResult {
    const result = transition(this.#status, event, this.limits);
    if (!result.ok) {
      this.logger.warn('illegal worker state transition rejected', {
        state: result.from.state,
        runningJobs: result.from.runningJobs,
        event: event.type,
        reason: result.reason,
      });
      return result;
    }
    this.#status = result.to;
    if (result.from.state !== result.to.state || result.from.runningJobs !== result.to.runningJobs) {
      this.logger.info('worker state changed', {
        from: result.from.state,
        to: result.to.state,
        runningJobs: result.to.runningJobs,
        event: event.type,
      });
    }
    for (const listener of this.#listeners) listener(result);
    return result;
  }

  onTransition(listener: (r: Extract<TransitionResult, { ok: true }>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
