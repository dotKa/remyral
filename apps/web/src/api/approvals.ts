import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';
import { invalidating } from '../lib/invalidate';
import {
  type ApprovalDetails,
  type ApprovalHeadline,
  type ApprovalHints,
  parseApprovalDetails,
  parseApprovalHeadline,
  parseApprovalHints,
} from './approvalDetails';

/**
 * Typed wrappers for the master's approval routes (apps/master/src/approvals/routes.ts,
 * docs/design/p4-approvals.md). Every string here may originate from a runtime or worker (summary,
 * requested action) and is untrusted: render it as text only.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
export type Risk = 'low' | 'medium' | 'high' | 'critical';

export interface ApprovalRequest {
  readonly id: string;
  readonly jobId: string;
  readonly project: string;
  readonly jobState: string;
  readonly kind: 'gate' | 'in_run';
  readonly action: string;
  readonly requestedAction: string;
  readonly risk: Risk;
  readonly summary: string;
  readonly requestedBy: { readonly type: string; readonly id: string | null };
  readonly workerId: string | null;
  readonly approverRole: string;
  readonly requiredApprovals: number;
  readonly approvals: number;
  readonly stepUp: boolean;
  readonly status: ApprovalStatus;
  readonly epoch: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: { readonly id: string; readonly username: string } | null;
  readonly decisionReason: string | null;
  /** p10-approval-pause: marked stale (still waiting long after it was asked); null otherwise / older master. */
  readonly staleAt: string | null;
  /** p10-approval-pause: when the job was paused for this request. */
  readonly pauseRequestedAt: string | null;
  /** p10-approval-pause: the job is paused and resumes when this request is decided. */
  readonly jobPaused: boolean;
  /** p10-approval-readable: the call's structured fields (null: older worker / master, gate request). */
  readonly details: ApprovalDetails | null;
  /** p10-approval-readable: static reading of the command (null when there is nothing to read). */
  readonly hints: ApprovalHints | null;
  /** p10-approval-readable: one readable line (`agent`: the agent's own, unverified description). */
  readonly headline: ApprovalHeadline;
}

export interface ApprovalDecision {
  readonly decision: 'approve' | 'deny';
  readonly username: string;
  readonly role: string;
  readonly reason: string | null;
  readonly decidedAt: string;
}

export interface DecideOutcome {
  readonly request: ApprovalRequest;
  readonly final: boolean;
  readonly jobState: string | null;
}

type Opts = Omit<RequestOptions, 'body'>;

const STATUSES = ['pending', 'approved', 'denied', 'expired', 'cancelled'] as const;
const RISKS = ['low', 'medium', 'high', 'critical'] as const;

function oneOf<const A extends readonly string[]>(
  o: Record<string, unknown>,
  key: string,
  allowed: A,
): A[number] {
  const v = str(o, key);
  const found = allowed.find((a) => a === v);
  if (found === undefined) throw new ShapeError(`unexpected ${key}`);
  return found;
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

export function parseRequest(v: unknown): ApprovalRequest {
  const o = obj(v);
  const by = obj(o.requestedBy);
  const decidedBy = o.decidedBy === null ? null : obj(o.decidedBy);
  const details = parseApprovalDetails(o.details);
  return {
    id: str(o, 'id'),
    jobId: str(o, 'jobId'),
    project: str(o, 'project'),
    jobState: str(o, 'jobState'),
    kind: oneOf(o, 'kind', ['gate', 'in_run']),
    action: str(o, 'action'),
    requestedAction: str(o, 'requestedAction'),
    risk: oneOf(o, 'risk', RISKS),
    summary: str(o, 'summary'),
    requestedBy: { type: str(by, 'type'), id: nullableStr(by, 'id') },
    workerId: nullableStr(o, 'workerId'),
    approverRole: str(o, 'approverRole'),
    requiredApprovals: int(o, 'requiredApprovals'),
    approvals: int(o, 'approvals'),
    stepUp: bool(o, 'stepUp'),
    status: oneOf(o, 'status', STATUSES),
    epoch: int(o, 'epoch'),
    createdAt: str(o, 'createdAt'),
    expiresAt: str(o, 'expiresAt'),
    decidedAt: nullableStr(o, 'decidedAt'),
    decidedBy: decidedBy ? { id: str(decidedBy, 'id'), username: str(decidedBy, 'username') } : null,
    decisionReason: nullableStr(o, 'decisionReason'),
    staleAt: typeof o.staleAt === 'string' ? o.staleAt : null,
    pauseRequestedAt: typeof o.pauseRequestedAt === 'string' ? o.pauseRequestedAt : null,
    jobPaused: o.jobPaused === true || str(o, 'jobState') === 'PAUSED',
    details,
    hints: parseApprovalHints(o.hints),
    headline: parseApprovalHeadline(o.headline, details, str(o, 'summary')),
  };
}

function parseDecision(v: unknown): ApprovalDecision {
  const o = obj(v);
  return {
    decision: oneOf(o, 'decision', ['approve', 'deny']),
    username: str(obj(o.user), 'username'),
    role: str(o, 'role'),
    reason: nullableStr(o, 'reason'),
    decidedAt: str(o, 'decidedAt'),
  };
}

function array<T>(v: unknown, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v.map(item);
}

export function listApprovals(status: ApprovalStatus | null, opts: Opts = {}): Promise<ApprovalRequest[]> {
  const query = status === null ? '' : `?status=${encodeURIComponent(status)}`;
  return apiRequest('GET', `/approvals${query}`, (v) => array(obj(v).items, parseRequest), opts);
}

/**
 * p9-pagination: one keyset page. Pending requests come soonest deadline first, other lists newest first; a
 * cursor only continues the list it came from.
 */
export function listApprovalsPage(
  status: ApprovalStatus | null,
  page: { readonly cursor: string | null; readonly limit: number },
  opts: Opts = {},
): Promise<{ items: ApprovalRequest[]; nextCursor: string | null }> {
  const q = new URLSearchParams();
  if (status !== null) q.set('status', status);
  q.set('limit', String(page.limit));
  if (page.cursor !== null) q.set('cursor', page.cursor);
  return apiRequest(
    'GET',
    `/approvals?${q.toString()}`,
    (v) => {
      const o = obj(v);
      return {
        items: array(o.items, parseRequest),
        nextCursor: typeof o.nextCursor === 'string' ? o.nextCursor : null,
      };
    },
    opts,
  );
}

export function getApproval(
  id: string,
  opts: Opts = {},
): Promise<{ request: ApprovalRequest; decisions: ApprovalDecision[] }> {
  return apiRequest(
    'GET',
    `/approvals/${encodeURIComponent(id)}`,
    (v) => {
      const o = obj(v);
      return { request: parseRequest(o.request), decisions: array(o.decisions, parseDecision) };
    },
    opts,
  );
}

function parseOutcome(v: unknown): DecideOutcome {
  const o = obj(v);
  if (typeof o.final !== 'boolean') throw new ShapeError('expected final');
  return { request: parseRequest(o.request), final: o.final, jobState: nullableStr(o, 'jobState') };
}

export function approveRequest(id: string, reason: string, opts: Opts = {}): Promise<DecideOutcome> {
  const trimmed = reason.trim();
  return invalidating(
    'approvals',
    apiRequest('POST', `/approvals/${encodeURIComponent(id)}/approve`, parseOutcome, {
      ...opts,
      body: trimmed === '' ? {} : { reason: trimmed },
    }),
  );
}

export function denyRequest(id: string, reason: string, opts: Opts = {}): Promise<DecideOutcome> {
  return invalidating(
    'approvals',
    apiRequest('POST', `/approvals/${encodeURIComponent(id)}/deny`, parseOutcome, {
      ...opts,
      body: { reason: reason.trim() },
    }),
  );
}

/**
 * p15-autonomy: extend a pending request's "expires if nobody decides" deadline (`addSec`), at most 7 days after it
 * was created; who may decide it may extend it.
 */
export function extendApproval(id: string, addSec: number, opts: Opts = {}): Promise<ApprovalRequest> {
  return invalidating(
    'approvals',
    apiRequest('POST', `/approvals/${encodeURIComponent(id)}/extend`, (v) => parseRequest(obj(v).request), {
      ...opts,
      body: { addSec },
    }),
  );
}

/** p22-output-delivery §2: one pending merge decision of a project, with its job's live merge check. */
export interface MergeBatchItem {
  readonly id: string;
  readonly jobId: string;
  readonly title: string | null;
  readonly stepUp: boolean;
  readonly expiresAt: string;
  readonly targetBranch: string | null;
  /** `clean` · `conflicts` · `base_moved` · `unknown`; null before the first check. */
  readonly mergeState: string | null;
  readonly conflictFiles: number;
  readonly ciState: string | null;
  readonly files: number | null;
}

export interface MergeBatchResult {
  readonly id: string;
  readonly outcome: 'approved' | 'pending' | 'refused';
  readonly code: string | null;
  readonly message: string | null;
}

function parseBatchItem(v: unknown): MergeBatchItem {
  const o = obj(v);
  const n = (k: string): number | null => (typeof o[k] === 'number' ? o[k] : null);
  return {
    id: str(o, 'id'),
    jobId: str(o, 'jobId'),
    title: nullableStr(o, 'title'),
    stepUp: o.stepUp === true,
    expiresAt: str(o, 'expiresAt'),
    targetBranch: nullableStr(o, 'targetBranch'),
    mergeState: nullableStr(o, 'mergeState'),
    conflictFiles: n('conflictFiles') ?? 0,
    ciState: nullableStr(o, 'ciState'),
    files: n('files'),
  };
}

/** The pending merge decisions of a project (git.merge gate requests in mode merge) with their merge check. */
export function listMergeBatch(project: string, opts: Opts = {}): Promise<MergeBatchItem[]> {
  return apiRequest(
    'GET',
    `/approvals/merge-batch?project=${encodeURIComponent(project)}`,
    (v) => array(obj(v).items, parseBatchItem),
    opts,
  );
}

/**
 * Approves several merge decisions of one project together (each decided like a single approval; one step-up covers
 * them). Answers per item.
 */
export function approveMergeBatch(
  project: string,
  ids: readonly string[],
  opts: Opts = {},
): Promise<MergeBatchResult[]> {
  return invalidating(
    'approvals',
    apiRequest(
      'POST',
      '/approvals/merge-batch',
      (v) =>
        array(obj(v).results, (x) => {
          const o = obj(x);
          const outcome = o.outcome;
          if (outcome !== 'approved' && outcome !== 'pending' && outcome !== 'refused') {
            throw new ShapeError('expected outcome');
          }
          return {
            id: str(o, 'id'),
            outcome,
            code: typeof o.code === 'string' ? o.code : null,
            message: typeof o.message === 'string' ? o.message : null,
          };
        }),
      { ...opts, body: { project, ids: [...ids] } },
    ),
  );
}
