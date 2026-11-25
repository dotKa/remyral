import { apiRequest, int, nullableStr, obj, ShapeError, str, strArray } from './client';
import { invalidating } from '../lib/invalidate';

/**
 * Typed wrappers for the workflow routes (apps/master/src/workflows/routes.ts, docs/design/p4-dag.md).
 * Node outputs are other agents' text: render as text only.
 */

export interface WorkflowRunSummary {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly version: number;
  readonly state: string;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export interface WorkflowNode {
  readonly id: string;
  /** The AI step's role ('' for a typed node of engine 2). */
  readonly role: string;
  /** p14: the node type (`ai.step` for AI steps and engine-1 runs). */
  readonly type: string;
  /** p14 engine 2: the latest node run (its id, state machine state and wait). */
  readonly nodeRunId?: string;
  readonly nodeRunState?: string;
  readonly waitKind?: string | null;
  readonly dueAt?: string | null;
  readonly outputPort?: string | null;
  readonly error?: { readonly code: string; readonly message: string } | null;
  /** p14: node runs of this node across group iterations. */
  readonly iterations?: number;
  /** p14 14.4: the source node run this one was copied from by a re-run (null / absent: it ran here). */
  readonly copiedFrom?: string | null;
  /** p14: the node run's scope ('' at top level, `each[3]` inside a group iteration). */
  readonly scope?: string;
  readonly state: string;
  readonly parent: string | null;
  readonly jobId: string | null;
  readonly jobState: string | null;
  readonly workerId: string | null;
  readonly attempts: number;
  readonly reason: string | null;
  /** p6-result-reuse: the step reused this identical earlier job instead of running (older masters: null). */
  readonly reusedJobId: string | null;
  /** p8-orchestration: the step's runtime and why it runs there (older masters: null). */
  readonly runtime: string | null;
  readonly placement: StepPlacement | null;
  /** Display name of the machine the step's job runs / ran on. */
  readonly workerName: string | null;
  readonly outputs: { readonly summary: string; readonly branch: string } | null;
  readonly gate: {
    readonly approverRole: string;
    readonly decision: string | null;
    readonly decidedBy: string | null;
  } | null;
}

/** p8-orchestration: how a step's runtime / machine was chosen. */
export interface StepPlacement {
  readonly runtime: string;
  readonly source: string;
  readonly model: string | null;
  readonly tools: readonly string[];
  readonly machine: { readonly id: string; readonly name: string } | null;
  readonly notes: readonly string[];
}

function parsePlacement(v: unknown): StepPlacement | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.runtime !== 'string' || typeof o.source !== 'string') return null;
  const m = o.machine;
  const machine =
    typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string'
      ? {
          id: (m as { id: string }).id,
          name:
            typeof (m as { name?: unknown }).name === 'string'
              ? (m as { name: string }).name
              : (m as { id: string }).id,
        }
      : null;
  const strs = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : [];
  return {
    runtime: o.runtime,
    source: o.source,
    model: typeof o.model === 'string' ? o.model : null,
    tools: strs(o.tools),
    machine,
    notes: strs(o.notes),
  };
}

export interface WorkflowRun {
  readonly run: {
    readonly id: string;
    /** p13-workflows-ui: the definition version the run started from (older masters: null). */
    readonly definitionId: string | null;
    readonly project: string;
    readonly name: string;
    readonly version: number;
    readonly state: string;
    readonly createdAt: string;
    readonly endedAt: string | null;
    readonly reason: string | null;
    /** p5-research-workspace-next: files handed to every step of a workspace run. */
    readonly files: readonly {
      readonly name: string;
      readonly sizeBytes: number;
      readonly pruned: boolean;
    }[];
    /** p14 14.2: what started the run (engine 2; null: older masters / engine 1). */
    readonly triggerKind: string | null;
    readonly sourceTrust: 'trusted' | 'untrusted' | null;
    /** p14 14.4 (engine 2; null otherwise): the engine's own run state and the operations facts. */
    readonly ops: RunOps | null;
  };
  readonly nodes: readonly WorkflowNode[];
  /** p14 14.2: the outbox records of the run's master integrations (engine 2; [] otherwise). */
  readonly sideEffects: readonly SideEffect[];
  readonly edges: readonly RunEdge[];
  readonly mergeRequests: readonly {
    readonly id: string;
    readonly node: string;
    readonly status: string;
    readonly branches: readonly string[];
  }[];
}

/** p14 14.4: engine-2 run operations — pause, queue, re-run / error-run lineage, retention (design §20.6). */
export interface RunOps {
  readonly engineState: string;
  readonly pausedAt: string | null;
  readonly pausedBy: string | null;
  readonly rerunOf: string | null;
  readonly rerunFromNode: string | null;
  readonly errorOf: string | null;
  readonly concurrencyKey: string | null;
  readonly activatedAt: string | null;
  readonly dataPrunedAt: string | null;
  readonly queuePosition: number | null;
}

function parseOps(run: Record<string, unknown>): RunOps | null {
  if (typeof run.engineState !== 'string') return null;
  const s = (k: string): string | null => (typeof run[k] === 'string' ? run[k] : null);
  return {
    engineState: run.engineState,
    pausedAt: s('pausedAt'),
    pausedBy: s('pausedBy'),
    rerunOf: s('rerunOf'),
    rerunFromNode: s('rerunFromNode'),
    errorOf: s('errorOf'),
    concurrencyKey: s('concurrencyKey'),
    activatedAt: s('activatedAt'),
    dataPrunedAt: s('dataPrunedAt'),
    queuePosition: typeof run.queuePosition === 'number' ? run.queuePosition : null,
  };
}

/** p14 14.2: one side effect of a master integration node (notification, chat, job, deploy, GitHub …). */
export interface SideEffect {
  readonly nodeId: string;
  readonly scope: string;
  readonly nodeRunId: string;
  readonly kind: string;
  readonly state: string;
  readonly externalRef: string | null;
  /** Non-secret metadata (`{jobId}`, `{actionId, state, url}`, `{url, number}`, `{threadId}` …): data, text only. */
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function parseSideEffects(v: unknown): SideEffect[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = obj(x);
    const d = o.detail;
    return {
      nodeId: str(o, 'nodeId'),
      scope: typeof o.scope === 'string' ? o.scope : '',
      nodeRunId: typeof o.nodeRunId === 'string' ? o.nodeRunId : '',
      kind: str(o, 'kind'),
      state: str(o, 'state'),
      externalRef: typeof o.externalRef === 'string' ? o.externalRef : null,
      detail:
        typeof d === 'object' && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : null,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
    };
  });
}

/** A run's edge; engine 2 adds the ports and what travelled on it (`skip`: a branch not taken, drawn dashed). */
export interface RunEdge {
  readonly from: string;
  readonly to: string;
  readonly fromPort?: string;
  readonly toPort?: string;
  readonly state?: 'value' | 'skip' | 'pending';
}

function arr(o: Record<string, unknown>, key: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`expected array at ${key}`);
  return v;
}

export function parseRuns(body: unknown): WorkflowRunSummary[] {
  return arr(obj(body), 'runs').map((x) => {
    const o = obj(x);
    return {
      id: str(o, 'id'),
      project: str(o, 'project'),
      name: str(o, 'name'),
      version: int(o, 'version'),
      state: str(o, 'state'),
      createdAt: str(o, 'createdAt'),
      endedAt: nullableStr(o, 'endedAt'),
    };
  });
}

export function parseRun(body: unknown): WorkflowRun {
  const b = obj(body);
  const run = obj(b.run);
  return {
    run: {
      id: str(run, 'id'),
      definitionId: typeof run.definitionId === 'string' ? run.definitionId : null,
      project: str(run, 'project'),
      name: str(run, 'name'),
      version: int(run, 'version'),
      state: str(run, 'state'),
      createdAt: str(run, 'createdAt'),
      endedAt: nullableStr(run, 'endedAt'),
      reason: nullableStr(run, 'reason'),
      files: Array.isArray(run.files)
        ? run.files.map((x) => {
            const f = obj(x);
            return { name: str(f, 'name'), sizeBytes: int(f, 'sizeBytes'), pruned: f.pruned === true };
          })
        : [],
      triggerKind: typeof run.triggerKind === 'string' ? run.triggerKind : null,
      sourceTrust: run.sourceTrust === 'trusted' || run.sourceTrust === 'untrusted' ? run.sourceTrust : null,
      ops: parseOps(run),
    },
    sideEffects: parseSideEffects(b.sideEffects),
    nodes: arr(b, 'nodes').map((x) => {
      const o = obj(x);
      const outputs = o.outputs === null ? null : obj(o.outputs);
      const gate = o.gate === null ? null : obj(o.gate);
      const err =
        typeof o.error === 'object' && o.error !== null ? (o.error as Record<string, unknown>) : null;
      return {
        id: str(o, 'id'),
        role: typeof o.role === 'string' ? o.role : '',
        type: typeof o.type === 'string' ? o.type : 'ai.step',
        ...(typeof o.nodeRunId === 'string' ? { nodeRunId: o.nodeRunId } : {}),
        ...(typeof o.nodeRunState === 'string' ? { nodeRunState: o.nodeRunState } : {}),
        ...(o.waitKind === undefined ? {} : { waitKind: typeof o.waitKind === 'string' ? o.waitKind : null }),
        ...(o.dueAt === undefined ? {} : { dueAt: typeof o.dueAt === 'string' ? o.dueAt : null }),
        ...(o.outputPort === undefined
          ? {}
          : { outputPort: typeof o.outputPort === 'string' ? o.outputPort : null }),
        ...(err === null
          ? {}
          : {
              error: {
                code: typeof err.code === 'string' ? err.code : '',
                message: typeof err.message === 'string' ? err.message : '',
              },
            }),
        ...(typeof o.iterations === 'number' ? { iterations: o.iterations } : {}),
        ...(o.copiedFrom === undefined
          ? {}
          : { copiedFrom: typeof o.copiedFrom === 'string' ? o.copiedFrom : null }),
        ...(typeof o.scope === 'string' ? { scope: o.scope } : {}),
        state: str(o, 'state'),
        parent: nullableStr(o, 'parent'),
        jobId: nullableStr(o, 'jobId'),
        jobState: nullableStr(o, 'jobState'),
        workerId: nullableStr(o, 'workerId'),
        attempts: int(o, 'attempts'),
        reason: nullableStr(o, 'reason'),
        reusedJobId: typeof o.reusedJobId === 'string' ? o.reusedJobId : null,
        runtime: typeof o.runtime === 'string' ? o.runtime : null,
        placement: parsePlacement(o.placement),
        workerName: typeof o.workerName === 'string' ? o.workerName : null,
        outputs:
          outputs === null ? null : { summary: str(outputs, 'summary'), branch: str(outputs, 'branch') },
        gate:
          gate === null
            ? null
            : {
                approverRole: str(gate, 'approverRole'),
                decision: nullableStr(gate, 'decision'),
                decidedBy: nullableStr(gate, 'decidedBy'),
              },
      };
    }),
    edges: arr(b, 'edges').map((x): RunEdge => {
      const o = obj(x);
      return {
        from: str(o, 'from'),
        to: str(o, 'to'),
        ...(typeof o.fromPort === 'string' ? { fromPort: o.fromPort } : {}),
        ...(typeof o.toPort === 'string' ? { toPort: o.toPort } : {}),
        ...(o.state === 'value' || o.state === 'skip' || o.state === 'pending' ? { state: o.state } : {}),
      };
    }),
    mergeRequests: arr(b, 'mergeRequests').map((x) => {
      const o = obj(x);
      return {
        id: str(o, 'id'),
        node: str(o, 'node'),
        status: str(o, 'status'),
        branches: strArray(o, 'branches'),
      };
    }),
  };
}

export function listWorkflowRuns(): Promise<WorkflowRunSummary[]> {
  return apiRequest('GET', '/workflows', parseRuns);
}

export function getWorkflowRun(id: string): Promise<WorkflowRun> {
  return apiRequest('GET', `/workflows/runs/${encodeURIComponent(id)}`, parseRun);
}

export function cancelWorkflowRun(id: string, reason: string): Promise<void> {
  return apiRequest('POST', `/workflows/runs/${encodeURIComponent(id)}/cancel`, () => undefined, {
    body: { reason },
  });
}

export function decideGate(
  runId: string,
  node: string,
  decision: 'approve' | 'deny',
  reason: string,
): Promise<void> {
  return invalidating(
    'approvals',
    apiRequest(
      'POST',
      `/workflows/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(node)}/${decision}`,
      () => undefined,
      { body: { reason } },
    ),
  );
}
