import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p6-approval-mode-switch (docs/design/p6-approval-mode-switch.md §4): a job's approval mode — read
 * (`GET /jobs/:id/approval-mode`, viewer+) and change (`POST`, operator+). Details are untrusted text.
 */

export const APPROVAL_MODES = ['ask-sensitive', 'ask-all', 'deny-sensitive', 'allow-all'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export type ModeApplication = 'live' | 'gate' | 'partial' | 'next_turn' | 'refused';

export interface ApprovalModeChange {
  readonly id: string;
  readonly seq: number;
  readonly from: ApprovalMode;
  readonly to: ApprovalMode;
  readonly actor: { readonly id: string; readonly username: string };
  readonly jobState: string;
  readonly workerId: string | null;
  readonly delivery: 'not_running' | 'sent';
  readonly application: ModeApplication | null;
  readonly detail: string | null;
  readonly appliedAt: string | null;
  readonly pendingResolved: number;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface ApprovalModeState {
  readonly current: ApprovalMode;
  readonly original: ApprovalMode;
  readonly seq: number;
  readonly machineAdmin: boolean;
  readonly canChange: boolean;
  readonly reason: string | null;
  readonly options: readonly {
    readonly mode: ApprovalMode;
    readonly allowed: boolean;
    readonly reason: string | null;
  }[];
  readonly live: { readonly workerId: string; readonly supportsSwitch: boolean } | null;
  readonly changes: readonly ApprovalModeChange[];
}

function mode(o: Record<string, unknown>, key: string): ApprovalMode {
  const v = str(o, key);
  if (!(APPROVAL_MODES as readonly string[]).includes(v)) throw new ShapeError(`unknown mode at ${key}`);
  return v as ApprovalMode;
}

const APPLICATIONS: readonly string[] = ['live', 'gate', 'partial', 'next_turn', 'refused'];

function parseChange(v: unknown): ApprovalModeChange {
  const o = obj(v);
  const actor = obj(o.actor);
  const application = nullableStr(o, 'application');
  if (application !== null && !APPLICATIONS.includes(application)) throw new ShapeError('application');
  return {
    id: str(o, 'id'),
    seq: int(o, 'seq'),
    from: mode(o, 'from'),
    to: mode(o, 'to'),
    actor: { id: str(actor, 'id'), username: str(actor, 'username') },
    jobState: str(o, 'jobState'),
    workerId: nullableStr(o, 'workerId'),
    delivery: str(o, 'delivery') === 'sent' ? 'sent' : 'not_running',
    application: application as ModeApplication | null,
    detail: nullableStr(o, 'detail'),
    appliedAt: nullableStr(o, 'appliedAt'),
    pendingResolved: int(o, 'pendingResolved'),
    reason: nullableStr(o, 'reason'),
    createdAt: str(o, 'createdAt'),
  };
}

export function parseApprovalMode(v: unknown): ApprovalModeState {
  const o = obj(v);
  const live = o.live === null || o.live === undefined ? null : obj(o.live);
  return {
    current: mode(o, 'current'),
    original: mode(o, 'original'),
    seq: int(o, 'seq'),
    machineAdmin: o.machineAdmin === true,
    canChange: o.canChange === true,
    reason: nullableStr(o, 'reason'),
    options: (Array.isArray(o.options) ? o.options : []).map((x) => {
      const p = obj(x);
      return { mode: mode(p, 'mode'), allowed: p.allowed === true, reason: nullableStr(p, 'reason') };
    }),
    live:
      live === null
        ? null
        : { workerId: str(live, 'workerId'), supportsSwitch: live.supportsSwitch === true },
    changes: (Array.isArray(o.changes) ? o.changes : []).map(parseChange),
  };
}

export function getApprovalMode(jobId: string, opts: RequestOptions = {}): Promise<ApprovalModeState> {
  return apiRequest('GET', `/jobs/${encodeURIComponent(jobId)}/approval-mode`, parseApprovalMode, opts);
}

export function setApprovalMode(
  jobId: string,
  body: { readonly mode: ApprovalMode; readonly expectedSeq: number; readonly reason?: string },
  opts: RequestOptions = {},
): Promise<{ changed: boolean; approvalMode: ApprovalModeState }> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/approval-mode`,
    (v) => {
      const o = obj(v);
      return { changed: o.changed === true, approvalMode: parseApprovalMode(o.approvalMode) };
    },
    { ...opts, body },
  );
}

/** One sentence for how a change took effect (the master's / worker's answer). */
export function applicationText(c: Pick<ApprovalModeChange, 'delivery' | 'application'>): string {
  if (c.delivery === 'not_running') return 'Applies when the job starts.';
  switch (c.application) {
    case null:
      return 'Waiting for the machine to confirm.';
    case 'live':
      return 'Applied live by the runtime.';
    case 'gate':
      return 'Enforced by the worker’s approval gate.';
    case 'partial':
      return 'Only partly applied.';
    case 'next_turn':
      return 'Applies from the runtime’s next turn.';
    case 'refused':
      return 'Refused by the machine — the runtime keeps its previous mode.';
  }
}
