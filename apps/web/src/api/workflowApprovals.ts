import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p17-chat-flow (docs/design/p17-chat-flow.md §1): one approval step of a workflow run as the chat card and "Senden
 * bekleyen" show it (`GET /workflows/runs/:id/node-runs/:nodeRunId/approval`). The decision is the run page's own
 * route (`decideNodeRun`, step-up). Title and details are run data: rendered as text only.
 */

export type WorkflowApprovalState = 'waiting' | 'approved' | 'denied' | 'closed';

export interface WorkflowApproval {
  /**
   * p18-last-gaps: 2 = an engine-2 node run (decided through `decideNodeRun`); 1 = an engine-1 gate (`nodeRunId` is its
   * stable id; decided through engine 1's gate route `decideGate` by `node`).
   */
  readonly engine: 1 | 2;
  readonly runId: string;
  readonly nodeRunId: string;
  readonly node: string;
  readonly nodeType: string;
  readonly workflow: string;
  readonly project: string;
  readonly version: number;
  readonly title: string | null;
  readonly details: string | null;
  readonly approverRole: string;
  readonly state: WorkflowApprovalState;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly dueAt: string | null;
  readonly runState: string;
  readonly untrusted: boolean;
  readonly canDecide: boolean;
}

const STATES = new Set<string>(['waiting', 'approved', 'denied', 'closed']);

export function parseWorkflowApproval(v: unknown): WorkflowApproval {
  const o = obj(v);
  const state = str(o, 'state');
  if (!STATES.has(state)) throw new ShapeError('state');
  return {
    engine: o.engine === 1 ? 1 : 2,
    runId: str(o, 'runId'),
    nodeRunId: str(o, 'nodeRunId'),
    node: str(o, 'node'),
    nodeType: str(o, 'nodeType'),
    workflow: str(o, 'workflow'),
    project: str(o, 'project'),
    version: typeof o.version === 'number' ? o.version : 0,
    title: nullableStr(o, 'title'),
    details: nullableStr(o, 'details'),
    approverRole: str(o, 'approverRole'),
    state: state as WorkflowApprovalState,
    decidedBy: nullableStr(o, 'decidedBy'),
    decidedAt: nullableStr(o, 'decidedAt'),
    createdAt: str(o, 'createdAt'),
    dueAt: nullableStr(o, 'dueAt'),
    runState: str(o, 'runState'),
    untrusted: o.untrusted === true,
    canDecide: o.canDecide === true,
  };
}

export function getWorkflowApproval(
  runId: string,
  nodeRunId: string,
  opts: Omit<RequestOptions, 'body'> = {},
): Promise<WorkflowApproval> {
  return apiRequest(
    'GET',
    `/workflows/runs/${encodeURIComponent(runId)}/node-runs/${encodeURIComponent(nodeRunId)}/approval`,
    parseWorkflowApproval,
    opts,
  );
}

/** A finished run's result card facts (`meta.workflowResult` of a chat note), or null when absent / malformed. */
export interface WorkflowResult {
  readonly runId: string;
  readonly workflow: string;
  readonly project: string;
  readonly version: number;
  readonly state: 'succeeded' | 'failed' | 'cancelled';
  readonly stepsDone: number;
  readonly stepsTotal: number;
  readonly durationMs: number | null;
  readonly summary: string | null;
  readonly reason: string | null;
  /** p22-run-attention: a succeeded run whose steps could not (fully) do their work (empty: nothing to look at). */
  readonly attention: readonly WorkflowAttention[];
}

export interface WorkflowAttention {
  readonly node: string;
  readonly kind: 'partial' | 'none' | 'input_cut';
  readonly note: string;
}

function attentionOf(v: unknown): WorkflowAttention[] {
  if (!Array.isArray(v)) return [];
  const out: WorkflowAttention[] = [];
  for (const a of v.slice(0, 10)) {
    if (typeof a !== 'object' || a === null) continue;
    const o = a as Record<string, unknown>;
    if (o.kind !== 'partial' && o.kind !== 'none' && o.kind !== 'input_cut') continue;
    if (typeof o.node !== 'string') continue;
    out.push({ node: o.node, kind: o.kind, note: typeof o.note === 'string' ? o.note : '' });
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function workflowResultOf(meta: Record<string, unknown> | null | undefined): WorkflowResult | null {
  const r = meta?.workflowResult;
  if (typeof r !== 'object' || r === null) return null;
  const o = r as Record<string, unknown>;
  const state = o.state;
  if (state !== 'succeeded' && state !== 'failed' && state !== 'cancelled') return null;
  if (typeof o.runId !== 'string' || !UUID.test(o.runId)) return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return {
    runId: o.runId,
    workflow: typeof o.workflow === 'string' ? o.workflow : '',
    project: typeof o.project === 'string' ? o.project : '',
    version: num(o.version),
    state,
    stepsDone: num(o.stepsDone),
    stepsTotal: num(o.stepsTotal),
    durationMs: typeof o.durationMs === 'number' ? o.durationMs : null,
    summary: text(o.summary),
    reason: text(o.reason),
    attention: state === 'succeeded' ? attentionOf(o.attention) : [],
  };
}

/** The approval step a chat note announces (`meta.notice = 'workflow-approval'`), or null. */
export function approvalNoteOf(
  meta: Record<string, unknown> | null | undefined,
): { readonly runId: string; readonly nodeRunId: string } | null {
  if (meta?.notice !== 'workflow-approval') return null;
  const { runId, nodeRunId } = meta;
  return typeof runId === 'string' &&
    UUID.test(runId) &&
    typeof nodeRunId === 'string' &&
    UUID.test(nodeRunId)
    ? { runId, nodeRunId }
    : null;
}
