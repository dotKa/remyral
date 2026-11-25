import { apiRequest, obj, type RequestOptions } from './client';

/**
 * p9-queue-priority: a machine's queue facts from the fleet overview's `queue` object — per-profile slots as the
 * worker reports them (`profile-slots-v1`; null = not reported), profiles that run alone, running jobs per profile and
 * the slots kept for urgent (Acil) jobs. Older masters send no `queue`: null.
 */
export interface WorkerQueueFacts {
  readonly profileSlots: Readonly<Record<string, number>> | null;
  readonly exclusiveProfiles: readonly string[];
  readonly profileRunning: Readonly<Record<string, number>>;
  readonly urgentReserve: number;
  /** p11-fixes-a: no admin setting — the default (1 slot) applies only on machines with at least 3 slots. */
  readonly urgentReserveAuto: boolean;
}

/** p11-fixes-a: the default reserve applies only from this many slots on (an explicit setting from 2). */
export const DEFAULT_RESERVE_MIN_SLOTS = 3;

/**
 * Slots kept for Acil on a machine with `slots` slots: an explicit reserve from 2 slots on, the default (1) only from
 * {@link DEFAULT_RESERVE_MIN_SLOTS} on; never all of them.
 */
export function reserveKept(reserve: number, auto: boolean, slots: number | null): number {
  if (slots === null || slots < 2) return 0;
  const r = auto ? (slots >= DEFAULT_RESERVE_MIN_SLOTS ? 1 : 0) : reserve;
  return Math.max(0, Math.min(r, slots - 1));
}

type Opts = Pick<RequestOptions, 'signal' | 'fetchImpl' | 'cookieString'>;

function numbers(v: unknown): Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(
      (e): e is [string, number] => typeof e[1] === 'number' && Number.isInteger(e[1]),
    ),
  );
}

export function parseQueueFacts(v: unknown): WorkerQueueFacts | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const q = v as Record<string, unknown>;
  return {
    profileSlots: q.profileSlots === null || q.profileSlots === undefined ? null : numbers(q.profileSlots),
    exclusiveProfiles: Array.isArray(q.exclusiveProfiles)
      ? q.exclusiveProfiles.filter((x): x is string => typeof x === 'string')
      : [],
    profileRunning: numbers(q.profileRunning),
    urgentReserve: typeof q.urgentReserve === 'number' ? q.urgentReserve : 1,
    // An older master sends no flag: its stored value applied from 2 slots on.
    urgentReserveAuto: q.urgentReserveAuto === true,
  };
}

/** The queue facts of one machine (null: unknown machine or an older master). */
export function getWorkerQueueFacts(workerId: string, opts: Opts = {}): Promise<WorkerQueueFacts | null> {
  return apiRequest(
    'GET',
    '/fleet/overview',
    (body) => {
      const workers: unknown = obj(body).workers;
      if (!Array.isArray(workers)) return null;
      const w: unknown = (workers as unknown[]).find(
        (x) => typeof x === 'object' && x !== null && (x as { id?: unknown }).id === workerId,
      );
      return w === undefined ? null : parseQueueFacts((w as { queue?: unknown }).queue);
    },
    opts,
  );
}
