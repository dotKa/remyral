import { apiRequest, int, nullableStr, obj, type RequestOptions, str } from './client';

/**
 * p9-queue-priority (docs/design/p9-queue-priority.md): priority classes, the queue screen, reorder / run now, a
 * project's queue settings and a machine's urgent reserve.
 *
 * The class bands mirror @remyral/protocol `PRIORITY_CLASS_*` (the console has no runtime protocol dependency):
 * Acil = +50 (50…100), Normal = 0 (-49…49), Arka plan = -50 (-100…-50).
 */
export type PriorityClass = 'urgent' | 'normal' | 'background';
export const PRIORITY_CLASSES: readonly PriorityClass[] = ['urgent', 'normal', 'background'];
export const PRIORITY_CLASS_VALUE: Readonly<Record<PriorityClass, number>> = {
  urgent: 50,
  normal: 0,
  background: -50,
};
export const PRIORITY_CLASS_LABEL: Readonly<Record<PriorityClass, string>> = {
  urgent: 'Acil',
  normal: 'Normal',
  background: 'Arka plan',
};
export const PRIORITY_CLASS_HINT: Readonly<Record<PriorityClass, string>> = {
  urgent: 'Goes first and may use the slot each machine keeps for urgent work.',
  normal: 'Waits its turn; older jobs gain priority over time.',
  background: 'Runs only on spare capacity, after everything else.',
};

export function priorityClassOf(priority: number): PriorityClass {
  if (priority >= 50) return 'urgent';
  if (priority <= -50) return 'background';
  return 'normal';
}

export function isPriorityClass(v: unknown): v is PriorityClass {
  return v === 'urgent' || v === 'normal' || v === 'background';
}

export type WaitCategory =
  | 'subscription_login'
  | 'slot'
  | 'profile_slot'
  | 'budget'
  | 'off_peak'
  | 'dependency'
  | 'quota'
  | 'approval'
  | 'machine'
  | 'other';

export const WAIT_LABEL: Readonly<Record<WaitCategory, string>> = {
  // p9-queue-local-login-accounting: subscription logins run one at a time on the machine.
  subscription_login: 'Subscription login',
  slot: 'Slot',
  profile_slot: 'Profile slot',
  budget: 'Budget',
  off_peak: 'Off-peak',
  dependency: 'Dependency',
  quota: 'Quota / limit',
  approval: 'Approval',
  machine: 'Machine',
  other: 'Other',
};

export interface QueueEntry {
  readonly jobId: string;
  readonly project: string;
  readonly title: string;
  readonly runtime: string;
  readonly sandboxProfile: string;
  readonly state: string;
  readonly priority: number;
  readonly storedPriority: number;
  readonly priorityClass: PriorityClass;
  readonly adjusted: {
    readonly reason: 'reorder' | 'run_now';
    readonly by: string;
    readonly at: string;
  } | null;
  readonly position: number;
  readonly waitingSince: string;
  readonly waitingSec: number;
  readonly category: WaitCategory | null;
  readonly reasons: readonly { code: string; category: WaitCategory; message: string; until?: string }[];
  readonly estimatedStart: string | null;
  readonly createdBy: string | null;
  readonly canReorder: boolean;
}

export interface QueuePool {
  readonly key: string;
  readonly profile: string;
  readonly machines: readonly {
    readonly id: string;
    readonly name: string;
    readonly slots: number | null;
    readonly profileSlots: number | null;
    readonly running: number;
    readonly urgentReserve: number;
    /** p11-fixes-a: the machine has no admin setting (the default applies only from 3 slots on). */
    readonly urgentReserveAuto: boolean;
    /** Slots kept for Acil in this pool (only where ≥ 2 parallel slots can be used); null = not reported. */
    readonly urgentReserveEffective: number | null;
    /**
     * Subscription-login runtimes that run one at a time in this pool on the machine (null: none); `perLogin`: one at
     * a time per login (Claude Code and Codex may run side by side for one job family).
     */
    readonly subscriptionLogins: { readonly runtimes: readonly string[]; readonly perLogin: boolean } | null;
  }[];
  readonly jobs: readonly QueueEntry[];
}

/** p10-approval-pause: a job paused while it waits for an approval (it holds no machine slot). */
export interface PausedQueueEntry {
  readonly jobId: string;
  readonly project: string;
  readonly title: string;
  readonly runtime: string;
  readonly workerId: string;
  readonly workerName: string | null;
  readonly status: 'pausing' | 'paused' | 'resuming';
  readonly since: string;
  readonly retainUntil: string;
  readonly requestId: string;
  readonly action: string;
  readonly decision: 'approve' | 'deny' | null;
  readonly blockedReason: string | null;
  /** While resuming: why it still waits for its machine (placement reason). */
  readonly waiting: string | null;
}

export interface QueueView {
  readonly generatedAt: string;
  readonly total: number;
  readonly estimateNote: string;
  readonly pools: readonly QueuePool[];
  /** p10-approval-pause (empty from older masters). */
  readonly paused: readonly PausedQueueEntry[];
}

function parsePaused(v: unknown): PausedQueueEntry[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x: unknown) => {
    if (typeof x !== 'object' || x === null) return [];
    const o = x as Record<string, unknown>;
    const s = (k: string): string | null => (typeof o[k] === 'string' ? o[k] : null);
    const jobId = s('jobId');
    const status =
      o.status === 'pausing' || o.status === 'paused' || o.status === 'resuming' ? o.status : null;
    if (jobId === null || status === null) return [];
    return [
      {
        jobId,
        project: s('project') ?? '',
        title: s('title') ?? '',
        runtime: s('runtime') ?? '',
        workerId: s('workerId') ?? '',
        workerName: s('workerName'),
        status,
        since: s('since') ?? '',
        retainUntil: s('retainUntil') ?? '',
        requestId: s('requestId') ?? '',
        action: s('action') ?? '',
        decision: o.decision === 'approve' || o.decision === 'deny' ? o.decision : null,
        blockedReason: s('blockedReason'),
        waiting: s('waiting'),
      },
    ];
  });
}

type Opts = Pick<RequestOptions, 'signal' | 'fetchImpl' | 'cookieString'>;

const CATEGORIES = new Set<string>(Object.keys(WAIT_LABEL));
function category(v: unknown): WaitCategory {
  return typeof v === 'string' && CATEGORIES.has(v) ? (v as WaitCategory) : 'other';
}

function nullableInt(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function parseEntry(v: unknown): QueueEntry {
  const o = obj(v);
  const adj = o.adjusted === null || o.adjusted === undefined ? null : obj(o.adjusted);
  const cls = o.priorityClass;
  return {
    jobId: str(o, 'jobId'),
    project: str(o, 'project'),
    title: str(o, 'title'),
    runtime: str(o, 'runtime'),
    sandboxProfile: str(o, 'sandboxProfile'),
    state: str(o, 'state'),
    priority: int(o, 'priority'),
    storedPriority: int(o, 'storedPriority'),
    priorityClass: isPriorityClass(cls) ? cls : priorityClassOf(int(o, 'priority')),
    adjusted:
      adj === null
        ? null
        : {
            reason: adj.reason === 'run_now' ? 'run_now' : 'reorder',
            by: str(adj, 'by'),
            at: str(adj, 'at'),
          },
    position: int(o, 'position'),
    waitingSince: str(o, 'waitingSince'),
    waitingSec: int(o, 'waitingSec'),
    category: o.category === null ? null : category(o.category),
    reasons: (Array.isArray(o.reasons) ? o.reasons : []).map((r) => {
      const x = obj(r);
      return {
        code: str(x, 'code'),
        category: category(x.category),
        message: str(x, 'message'),
        ...(typeof x.until === 'string' ? { until: x.until } : {}),
      };
    }),
    estimatedStart: nullableStr(o, 'estimatedStart'),
    createdBy: nullableStr(o, 'createdBy'),
    canReorder: o.canReorder === true,
  };
}

export function parseQueue(v: unknown): QueueView {
  const o = obj(v);
  return {
    generatedAt: str(o, 'generatedAt'),
    total: int(o, 'total'),
    estimateNote: str(o, 'estimateNote'),
    pools: (Array.isArray(o.pools) ? o.pools : []).map((p) => {
      const x = obj(p);
      return {
        key: str(x, 'key'),
        profile: str(x, 'profile'),
        machines: (Array.isArray(x.machines) ? x.machines : []).map((m) => {
          const y = obj(m);
          return {
            id: str(y, 'id'),
            name: str(y, 'name'),
            slots: nullableInt(y, 'slots'),
            profileSlots: nullableInt(y, 'profileSlots'),
            running: int(y, 'running'),
            urgentReserve: int(y, 'urgentReserve'),
            urgentReserveAuto: y.urgentReserveAuto === true,
            urgentReserveEffective: nullableInt(y, 'urgentReserveEffective'),
            subscriptionLogins:
              y.subscriptionLogins === null || typeof y.subscriptionLogins !== 'object'
                ? null
                : {
                    runtimes: (() => {
                      const r = obj(y.subscriptionLogins).runtimes;
                      return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
                    })(),
                    perLogin: obj(y.subscriptionLogins).perLogin === true,
                  },
          };
        }),
        jobs: (Array.isArray(x.jobs) ? x.jobs : []).map(parseEntry),
      };
    }),
    paused: parsePaused(o.paused),
  };
}

export function getQueue(project: string | null, opts: Opts = {}): Promise<QueueView> {
  const q = project === null ? '' : `?project=${encodeURIComponent(project)}`;
  return apiRequest('GET', `/queue${q}`, parseQueue, opts);
}

export interface MoveResult {
  readonly priority: number;
  readonly priorityClass: PriorityClass;
  readonly exact: boolean;
  readonly note: string | null;
}

/** Drag and drop: place `jobId` before or after another queued job (within its class). */
export function moveQueuedJob(
  jobId: string,
  to: { readonly before: string } | { readonly after: string },
  opts: Opts = {},
): Promise<MoveResult> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/queue/move`,
    (v) => {
      const o = obj(v);
      const cls = o.priorityClass;
      return {
        priority: int(o, 'priority'),
        priorityClass: isPriorityClass(cls) ? cls : 'normal',
        exact: o.exact === true,
        note: nullableStr(o, 'note'),
      };
    },
    { ...opts, body: to },
  );
}

/** Admin "run now" (step-up): the job becomes urgent and goes first. */
export function runQueuedJobNow(jobId: string, opts: Opts = {}): Promise<{ priority: number }> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/queue/run-now`,
    (v) => ({ priority: int(obj(v), 'priority') }),
    { ...opts, body: {} },
  );
}

export interface QueueSettings {
  readonly project: string;
  readonly maxPerUser: number | null;
  readonly maxPerAutomation: number | null;
  readonly waitNotifyMinutes: number;
}

function parseSettings(v: unknown): QueueSettings {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    maxPerUser: nullableInt(o, 'maxPerUser'),
    maxPerAutomation: nullableInt(o, 'maxPerAutomation'),
    waitNotifyMinutes: int(o, 'waitNotifyMinutes'),
  };
}

export function getQueueSettings(project: string, opts: Opts = {}): Promise<QueueSettings> {
  return apiRequest('GET', `/projects/${encodeURIComponent(project)}/queue-settings`, parseSettings, opts);
}

export function putQueueSettings(
  project: string,
  body: Omit<QueueSettings, 'project'>,
  opts: Opts = {},
): Promise<QueueSettings> {
  return apiRequest('PUT', `/projects/${encodeURIComponent(project)}/queue-settings`, parseSettings, {
    ...opts,
    body,
  });
}

/** Admin (step-up): slots kept for urgent jobs on a machine (0, 1 or 2; null = the default). */
export function putUrgentReserve(
  workerId: string,
  reserve: number | null,
  opts: Opts = {},
): Promise<{ urgentReserve: number; urgentReserveAuto: boolean }> {
  return apiRequest(
    'PUT',
    `/workers/${encodeURIComponent(workerId)}/urgent-reserve`,
    (v) => ({
      urgentReserve: int(obj(v), 'urgentReserve'),
      urgentReserveAuto: obj(v).urgentReserveAuto === true,
    }),
    { ...opts, body: { reserve } },
  );
}

/** "3 slots (host: 1)": a machine's slots with the per-profile limits that are lower. */
export function slotsLabel(
  slots: number | null,
  profileSlots: Readonly<Record<string, number>> | null,
): string {
  if (slots === null) return '—';
  const base = `${String(slots)} ${slots === 1 ? 'slot' : 'slots'}`;
  if (profileSlots === null) return base;
  const short: Record<string, string> = {
    'host-restricted': 'host',
    'runtime-sandbox': 'runtime sandbox',
    container: 'container',
    unconfined: 'unconfined',
  };
  const lower = Object.entries(profileSlots)
    .filter(([, n]) => n < slots)
    .map(([p, n]) => `${short[p] ?? p}: ${String(n)}`);
  return lower.length === 0 ? base : `${base} (${lower.join(', ')})`;
}
