import { invalidating } from '../lib/invalidate';
import { type ApiIssue, apiRequest, int, nullableStr, obj, ShapeError, str } from './client';

/**
 * p14-workflow-engine 14.1 (docs/design/p14-workflow-engine.md §7, §10.3): the editor's engine-2 routes — the node
 * catalog, the expression preview, the single-node test, a run's node runs and payloads, and the node-run actions
 * (approve / deny / cancel). Values in samples, results and node runs are workflow data (possibly untrusted): render
 * them as text only.
 */

export type JsonSchema = Record<string, unknown>;

export interface PortSpec {
  readonly name: string;
  readonly direction: 'in' | 'out';
  readonly side?: 'inner' | 'outer';
  readonly required?: boolean;
  readonly many?: boolean;
  readonly schema?: DataSchema;
}

export interface DataSchema {
  readonly type: string;
  readonly properties?: Readonly<Record<string, DataSchema>>;
  readonly items?: DataSchema;
  readonly required?: readonly string[];
  readonly enum?: readonly (string | number | boolean)[];
}

export type Category = 'trigger' | 'ai' | 'control' | 'data' | 'integration' | 'code';

export interface NodeTypeInfo {
  readonly type: string;
  readonly category: Category;
  readonly placement: string;
  readonly phase: string;
  readonly icon: string;
  readonly group: boolean;
  readonly sideEffect: boolean;
  readonly requires: string;
  readonly untrustedOutput: boolean;
  readonly testable: boolean;
  readonly fields: Readonly<Record<string, 'static' | 'expr'>>;
  readonly config: JsonSchema;
  readonly ports: readonly PortSpec[];
  readonly dynamicPorts?: 'cases';
}

export interface FunctionInfo {
  readonly name: string;
  readonly signature: string;
  readonly description?: string;
}

export interface WorkflowCatalog {
  readonly engineV2: boolean;
  readonly executable: readonly string[];
  readonly types: readonly NodeTypeInfo[];
  readonly functions: readonly FunctionInfo[];
  readonly refusedFunctions: readonly string[];
  /**
   * p14-workflow-engine 14.3: workers that run function jobs — `http` (function-v1: HTTP request, e-mail) and `code`
   * (function-code-v1: JavaScript / Python); `online` = connected now. Absent on masters before 14.3.
   */
  readonly functionWorkers?: FunctionWorkers;
}

export interface FunctionWorkerCount {
  readonly online: number;
  readonly total: number;
}

export interface FunctionWorkers {
  readonly http: FunctionWorkerCount;
  readonly code: FunctionWorkerCount;
}

function parseWorkerCount(v: unknown): FunctionWorkerCount {
  const r = isRec(v) ? v : {};
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
  return { online: n(r.online), total: n(r.total) };
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function parsePort(v: unknown): PortSpec | null {
  if (!isRec(v) || typeof v.name !== 'string' || (v.direction !== 'in' && v.direction !== 'out')) return null;
  return {
    name: v.name,
    direction: v.direction,
    ...(v.side === 'inner' || v.side === 'outer' ? { side: v.side } : {}),
    ...(v.required === true ? { required: true } : {}),
    ...(v.many === true ? { many: true } : {}),
    ...(isRec(v.schema) && typeof v.schema.type === 'string'
      ? { schema: v.schema as unknown as DataSchema }
      : {}),
  };
}

const CATEGORIES: readonly Category[] = ['trigger', 'ai', 'control', 'data', 'integration', 'code'];

export function parseCatalog(body: unknown): WorkflowCatalog {
  const b = obj(body);
  if (!Array.isArray(b.types)) throw new ShapeError('expected array at types');
  const types: NodeTypeInfo[] = b.types.flatMap((x) => {
    if (!isRec(x) || typeof x.type !== 'string') return [];
    const category = CATEGORIES.find((c) => c === x.category);
    if (category === undefined) return [];
    const fields: Record<string, 'static' | 'expr'> = {};
    if (isRec(x.fields))
      for (const [k, m] of Object.entries(x.fields)) if (m === 'static' || m === 'expr') fields[k] = m;
    return [
      {
        type: x.type,
        category,
        placement: typeof x.placement === 'string' ? x.placement : 'master',
        phase: typeof x.phase === 'string' ? x.phase : '',
        icon: typeof x.icon === 'string' ? x.icon : '',
        group: x.group === true,
        sideEffect: x.sideEffect === true,
        requires: typeof x.requires === 'string' ? x.requires : 'workflows.define',
        untrustedOutput: x.untrustedOutput === true,
        testable: x.testable === true,
        fields,
        config: isRec(x.config) ? x.config : {},
        ports: Array.isArray(x.ports) ? x.ports.flatMap((p) => parsePort(p) ?? []) : [],
        ...(x.dynamicPorts === 'cases' ? { dynamicPorts: 'cases' as const } : {}),
      },
    ];
  });
  const functions: FunctionInfo[] = Array.isArray(b.functions)
    ? b.functions.flatMap((f) =>
        isRec(f) && typeof f.name === 'string'
          ? [
              {
                name: f.name,
                signature: typeof f.signature === 'string' ? f.signature : '',
                ...(typeof f.description === 'string' ? { description: f.description } : {}),
              },
            ]
          : [],
      )
    : [];
  return {
    engineV2: b.engineV2 === true,
    executable: strs(b.executable),
    types,
    functions,
    refusedFunctions: strs(b.refusedFunctions),
    ...(isRec(b.functionWorkers)
      ? {
          functionWorkers: {
            http: parseWorkerCount(b.functionWorkers.http),
            code: parseWorkerCount(b.functionWorkers.code),
          },
        }
      : {}),
  };
}

export function getWorkflowCatalog(): Promise<WorkflowCatalog> {
  return apiRequest('GET', '/workflows/catalog', parseCatalog);
}

/** Sample data an expression is evaluated against (`$input`, `$node.<id>.<port>`, `$inputs`, `$item`, …). */
export interface Sample {
  readonly input?: unknown;
  readonly node?: Readonly<Record<string, unknown>>;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly trigger?: unknown;
  readonly item?: unknown;
  readonly index?: number;
  readonly items?: readonly unknown[];
  readonly loop?: unknown;
  readonly run?: Readonly<Record<string, unknown>>;
}

export type EvalResult =
  | { readonly ok: true; readonly value: unknown; readonly type: string; readonly bytes: number }
  | { readonly ok: false; readonly error: { readonly code: string; readonly position: number | null } };

function errorOf(v: unknown): { code: string; position: number | null } {
  const e = obj(v);
  return { code: str(e, 'code'), position: typeof e.position === 'number' ? e.position : null };
}

export function parseEval(body: unknown): EvalResult {
  const b = obj(body);
  if (b.ok === true)
    return {
      ok: true,
      value: b.value,
      type: typeof b.type === 'string' ? b.type : typeof b.value,
      bytes: typeof b.bytes === 'number' ? b.bytes : 0,
    };
  return { ok: false, error: errorOf(b.error) };
}

export function evaluateExpression(
  project: string,
  expression: string,
  mode: 'expr' | 'template',
  sample: Sample,
  opts: { signal?: AbortSignal } = {},
): Promise<EvalResult> {
  return apiRequest('POST', '/workflows/expressions/evaluate', parseEval, {
    body: { project, expression, mode, sample },
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
}

export type NodeTestResult =
  | {
      readonly ok: true;
      readonly outcome: 'value';
      readonly ports: Readonly<Record<string, unknown>>;
      readonly port: string;
      readonly durationMs: number;
    }
  | {
      readonly ok: true;
      readonly outcome: 'wait';
      readonly wait: { readonly kind: string; readonly dueAt: string | null; readonly detail: unknown };
      readonly durationMs: number;
    }
  | {
      readonly ok: true;
      readonly outcome: 'stop' | 'fail' | 'group' | 'return';
      readonly detail: unknown;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string; readonly position: number | null };
      readonly durationMs: number;
    };

export function parseNodeTest(body: unknown): NodeTestResult {
  const b = obj(body);
  const durationMs = typeof b.durationMs === 'number' ? b.durationMs : 0;
  if (b.ok !== true) {
    const e = obj(b.error);
    return {
      ok: false,
      error: {
        code: str(e, 'code'),
        message: typeof e.message === 'string' ? e.message : '',
        position: typeof e.position === 'number' ? e.position : null,
      },
      durationMs,
    };
  }
  if (b.outcome === 'value')
    return {
      ok: true,
      outcome: 'value',
      ports: isRec(b.ports) ? b.ports : {},
      port: typeof b.port === 'string' ? b.port : 'out',
      durationMs,
    };
  if (b.outcome === 'wait') {
    const w = obj(b.wait);
    return {
      ok: true,
      outcome: 'wait',
      wait: { kind: str(w, 'kind'), dueAt: typeof w.dueAt === 'string' ? w.dueAt : null, detail: w.detail },
      durationMs,
    };
  }
  const outcome = b.outcome;
  if (outcome !== 'stop' && outcome !== 'fail' && outcome !== 'group' && outcome !== 'return')
    throw new ShapeError('unknown outcome');
  return { ok: true, outcome, detail: b.detail, durationMs };
}

export function testWorkflowNode(
  workflowId: string,
  nodeId: string,
  body: { node?: Record<string, unknown>; input?: unknown; sample?: Sample; confirm?: boolean },
): Promise<NodeTestResult> {
  return apiRequest(
    'POST',
    `/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}/test`,
    parseNodeTest,
    { body },
  );
}

export interface NodeRun {
  readonly id: string;
  readonly node: string;
  readonly type: string;
  readonly scope: string;
  readonly attempt: number;
  readonly state: string;
  readonly waitKind: string | null;
  readonly dueAt: string | null;
  readonly placement: string;
  readonly outputPort: string | null;
  readonly input: unknown;
  readonly output: unknown;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly reason: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string;
  readonly gate: {
    readonly approverRole: string;
    readonly decision: string | null;
    readonly decidedBy: string | null;
  } | null;
  readonly jobId: string | null;
  /** p14 14.4: copied from this node run of the re-run's source (null: it ran here). */
  readonly copiedFrom: string | null;
}

export function parseNodeRuns(body: unknown): { nodeRuns: NodeRun[]; nextCursor: string | null } {
  const b = obj(body);
  if (!Array.isArray(b.nodeRuns)) throw new ShapeError('expected array at nodeRuns');
  return {
    nodeRuns: b.nodeRuns.map((x) => {
      const o = obj(x);
      const err = isRec(o.error) ? o.error : null;
      const gate = isRec(o.gate) ? o.gate : null;
      return {
        id: str(o, 'id'),
        node: str(o, 'node'),
        type: typeof o.type === 'string' ? o.type : '',
        scope: typeof o.scope === 'string' ? o.scope : '',
        attempt: int(o, 'attempt'),
        state: str(o, 'state'),
        waitKind: typeof o.waitKind === 'string' ? o.waitKind : null,
        dueAt: typeof o.dueAt === 'string' ? o.dueAt : null,
        placement: typeof o.placement === 'string' ? o.placement : '',
        outputPort: typeof o.outputPort === 'string' ? o.outputPort : null,
        input: o.input ?? null,
        output: o.output ?? null,
        error:
          err === null
            ? null
            : {
                code: typeof err.code === 'string' ? err.code : '',
                message: typeof err.message === 'string' ? err.message : '',
              },
        reason: typeof o.reason === 'string' ? o.reason : null,
        startedAt: typeof o.startedAt === 'string' ? o.startedAt : null,
        endedAt: typeof o.endedAt === 'string' ? o.endedAt : null,
        createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
        gate:
          gate === null
            ? null
            : {
                approverRole: typeof gate.approverRole === 'string' ? gate.approverRole : '',
                decision: typeof gate.decision === 'string' ? gate.decision : null,
                decidedBy: typeof gate.decidedBy === 'string' ? gate.decidedBy : null,
              },
        jobId: typeof o.jobId === 'string' ? o.jobId : null,
        copiedFrom: typeof o.copiedFrom === 'string' ? o.copiedFrom : null,
      };
    }),
    nextCursor: nullableStr(b, 'nextCursor'),
  };
}

export function listNodeRuns(
  runId: string,
  q: { node?: string; scope?: string; cursor?: string; limit?: number } = {},
): Promise<{ nodeRuns: NodeRun[]; nextCursor: string | null }> {
  const p = new URLSearchParams();
  if (q.node !== undefined) p.set('node', q.node);
  if (q.scope !== undefined) p.set('scope', q.scope);
  if (q.cursor !== undefined) p.set('cursor', q.cursor);
  if (q.limit !== undefined) p.set('limit', String(q.limit));
  const qs = p.toString();
  return apiRequest(
    'GET',
    `/workflows/runs/${encodeURIComponent(runId)}/node-runs${qs === '' ? '' : `?${qs}`}`,
    parseNodeRuns,
  );
}

export function getPayload(
  runId: string,
  sha: string,
): Promise<{ sha: string; size: number; value: unknown }> {
  return apiRequest(
    'GET',
    `/workflows/runs/${encodeURIComponent(runId)}/payloads/${encodeURIComponent(sha)}`,
    (v) => {
      const o = obj(v);
      return { sha: str(o, 'sha'), size: int(o, 'size'), value: o.value };
    },
  );
}

/** p14 14.4: a value retention removed (`{"$pruned": true}`). */
export function isPruned(v: unknown): boolean {
  return isRec(v) && v.$pruned === true;
}

/** A payload reference in node-run data (`{ $payload: sha, size }`), else null. */
export function payloadRef(v: unknown): { sha: string; size: number } | null {
  if (!isRec(v) || typeof v.$payload !== 'string') return null;
  return { sha: v.$payload, size: typeof v.size === 'number' ? v.size : 0 };
}

export function decideNodeRun(
  runId: string,
  nodeRunId: string,
  decision: 'approve' | 'deny',
  reason: string,
): Promise<string> {
  return invalidating(
    'approvals',
    apiRequest(
      'POST',
      `/workflows/runs/${encodeURIComponent(runId)}/node-runs/${encodeURIComponent(nodeRunId)}/${decision}`,
      (v) => str(obj(v), 'state'),
      { body: reason === '' ? {} : { reason } },
    ),
  );
}

export function cancelNodeRun(runId: string, nodeRunId: string, reason: string): Promise<string> {
  return apiRequest(
    'POST',
    `/workflows/runs/${encodeURIComponent(runId)}/node-runs/${encodeURIComponent(nodeRunId)}/cancel`,
    (v) => str(obj(v), 'state'),
    { body: { reason } },
  );
}

/** p14-workflow-engine 14.2: manual resume of a node run waiting for a webhook (testing / fallback). */
export function resumeNodeRun(runId: string, nodeRunId: string, data?: unknown): Promise<string> {
  return apiRequest(
    'POST',
    `/workflows/runs/${encodeURIComponent(runId)}/node-runs/${encodeURIComponent(nodeRunId)}/resume`,
    (v) => str(obj(v), 'state'),
    { body: data === undefined ? {} : { data } },
  );
}

// ------------------------------------------------------------------------- 14.4: operations (design §20)

/** Pause an active engine-2 run (no new node starts; in-flight jobs finish). */
export function pauseRun(runId: string, reason?: string): Promise<string> {
  return apiRequest(
    'POST',
    `/workflows/runs/${encodeURIComponent(runId)}/pause`,
    (v) => str(obj(v), 'state'),
    { body: reason === undefined || reason === '' ? {} : { reason } },
  );
}

/** Resume a paused engine-2 run. */
export function resumeRun(runId: string): Promise<string> {
  return apiRequest(
    'POST',
    `/workflows/runs/${encodeURIComponent(runId)}/resume`,
    (v) => str(obj(v), 'state'),
    { body: {} },
  );
}

/** What a re-run copies from the source run and what runs again. */
export interface RerunPlan {
  readonly fromNode: string | null;
  readonly version: number;
  readonly copied: readonly string[];
  readonly fresh: readonly string[];
  readonly sideEffects: readonly string[];
  readonly aiSteps: readonly string[];
}

export function parseRerun(body: unknown): { plan: RerunPlan; runId: string | null } {
  const b = obj(body);
  const p = obj(b.plan);
  const list = (k: string): string[] =>
    Array.isArray(p[k]) ? (p[k] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return {
    plan: {
      fromNode: typeof p.fromNode === 'string' ? p.fromNode : null,
      version: typeof p.version === 'number' ? p.version : 0,
      copied: list('copied'),
      fresh: list('fresh'),
      sideEffects: list('sideEffects'),
      aiSteps: list('aiSteps'),
    },
    runId: typeof b.runId === 'string' ? b.runId : null,
  };
}

/** Re-run a finished run (from a node; `dryRun` returns the plan only). */
export function rerunRun(
  runId: string,
  opts: { fromNode?: string; latestVersion?: boolean; dryRun?: boolean } = {},
): Promise<{ plan: RerunPlan; runId: string | null }> {
  return apiRequest('POST', `/workflows/runs/${encodeURIComponent(runId)}/rerun`, parseRerun, {
    body: {
      ...(opts.fromNode === undefined ? {} : { fromNode: opts.fromNode }),
      ...(opts.latestVersion === true ? { latestVersion: true } : {}),
      ...(opts.dryRun === true ? { dryRun: true } : {}),
    },
  });
}

export interface WorkflowMetrics {
  readonly days: number;
  readonly runs: Readonly<
    Record<'queued' | 'active' | 'paused' | 'succeeded' | 'failed' | 'cancelled', number>
  >;
  readonly failureStreak: number;
  readonly alertAfter: number;
  readonly nodes: readonly {
    readonly node: string;
    readonly type: string;
    readonly runs: number;
    readonly failed: number;
    readonly p50Ms: number | null;
    readonly p95Ms: number | null;
    readonly maxMs: number | null;
  }[];
  readonly recentFailures: readonly {
    readonly runId: string;
    readonly endedAt: string | null;
    readonly reason: string | null;
  }[];
}

const RUN_STATES = ['queued', 'active', 'paused', 'succeeded', 'failed', 'cancelled'] as const;

export function parseMetrics(body: unknown): WorkflowMetrics {
  const b = obj(body);
  const runs = isRec(b.runs) ? b.runs : {};
  const num = (o: Record<string, unknown>, k: string): number => (typeof o[k] === 'number' ? o[k] : 0);
  const ms = (o: Record<string, unknown>, k: string): number | null =>
    typeof o[k] === 'number' ? o[k] : null;
  return {
    days: num(b, 'days'),
    runs: Object.fromEntries(RUN_STATES.map((s) => [s, num(runs, s)])) as WorkflowMetrics['runs'],
    failureStreak: num(b, 'failureStreak'),
    alertAfter: num(b, 'alertAfter'),
    nodes: (Array.isArray(b.nodes) ? b.nodes : []).filter(isRec).map((o) => ({
      node: typeof o.node === 'string' ? o.node : '',
      type: typeof o.type === 'string' ? o.type : '',
      runs: num(o, 'runs'),
      failed: num(o, 'failed'),
      p50Ms: ms(o, 'p50Ms'),
      p95Ms: ms(o, 'p95Ms'),
      maxMs: ms(o, 'maxMs'),
    })),
    recentFailures: (Array.isArray(b.recentFailures) ? b.recentFailures : []).filter(isRec).map((o) => ({
      runId: typeof o.runId === 'string' ? o.runId : '',
      endedAt: typeof o.endedAt === 'string' ? o.endedAt : null,
      reason: typeof o.reason === 'string' ? o.reason : null,
    })),
  };
}

/** Runs by state, node durations and failures of a workflow (every version) over the last `days`. */
export function workflowMetrics(definitionId: string, days = 30, project?: string): Promise<WorkflowMetrics> {
  return apiRequest(
    'GET',
    `/workflows/${encodeURIComponent(definitionId)}/metrics?days=${String(days)}${
      project === undefined ? '' : `&project=${encodeURIComponent(project)}`
    }`,
    parseMetrics,
  );
}

// ------------------------------------------------------------------------- 14.2: trigger activation (K2)

export type TriggerStatus = 'active' | 'paused' | 'inactive' | 'failed';

export interface TriggerBinding {
  readonly nodeId: string;
  readonly type: string;
  /** `none`: manual and chat triggers need no automation (always available). */
  readonly binding: 'automation' | 'none';
  readonly status: TriggerStatus;
  readonly automationId: string | null;
  readonly automationState: string | null;
  /** false: the node changed since the last activation (activate again to apply it). */
  readonly upToDate: boolean;
  readonly webhookUrl: string | null;
  readonly lastRun: { readonly id: string; readonly state: string; readonly at: string } | null;
}

export interface Activation {
  readonly workflowId: string;
  readonly project: string;
  readonly name: string;
  readonly latestVersion: number;
  readonly enabled: boolean;
  readonly pinnedVersion: number | null;
  readonly needsExternal: boolean;
  readonly triggers: readonly TriggerBinding[];
  readonly orphans: readonly {
    readonly nodeId: string;
    readonly automationId: string;
    readonly automationState: string;
  }[];
  /** PUT only: the secrets of newly created webhook automations, shown once. */
  readonly webhookSecrets: readonly { readonly nodeId: string; readonly secret: string }[];
}

const STATUSES: readonly TriggerStatus[] = ['active', 'paused', 'inactive', 'failed'];

const nstr = (o: Record<string, unknown>, k: string): string | null =>
  typeof o[k] === 'string' ? o[k] : null;

export function parseActivation(body: unknown): Activation {
  const b = obj(body);
  if (!Array.isArray(b.triggers)) throw new ShapeError('expected array at triggers');
  return {
    workflowId: str(b, 'workflowId'),
    project: str(b, 'project'),
    name: str(b, 'name'),
    latestVersion: int(b, 'latestVersion'),
    enabled: b.enabled === true,
    pinnedVersion: typeof b.pinnedVersion === 'number' ? b.pinnedVersion : null,
    needsExternal: b.needsExternal === true,
    triggers: b.triggers.map((x) => {
      const o = obj(x);
      const last = isRec(o.lastRun) ? o.lastRun : null;
      return {
        nodeId: str(o, 'nodeId'),
        type: str(o, 'type'),
        binding: o.binding === 'none' ? ('none' as const) : ('automation' as const),
        status: STATUSES.find((s) => s === o.status) ?? 'inactive',
        automationId: nstr(o, 'automationId'),
        automationState: nstr(o, 'automationState'),
        upToDate: o.upToDate !== false,
        webhookUrl: nstr(o, 'webhookUrl'),
        lastRun:
          last === null ? null : { id: str(last, 'id'), state: str(last, 'state'), at: str(last, 'at') },
      };
    }),
    orphans: Array.isArray(b.orphans)
      ? b.orphans.map((x) => {
          const o = obj(x);
          return {
            nodeId: str(o, 'nodeId'),
            automationId: str(o, 'automationId'),
            automationState: str(o, 'automationState'),
          };
        })
      : [],
    webhookSecrets: Array.isArray(b.webhookSecrets)
      ? b.webhookSecrets.map((x) => {
          const o = obj(x);
          return { nodeId: str(o, 'nodeId'), secret: str(o, 'secret') };
        })
      : [],
  };
}

/** p18-multi-project: `project` = a project that attached the workflow (its own automations). */
export function getActivation(workflowId: string, project?: string): Promise<Activation> {
  const q = project === undefined ? '' : `?project=${encodeURIComponent(project)}`;
  return apiRequest('GET', `/workflows/${encodeURIComponent(workflowId)}/activation${q}`, parseActivation);
}

export function putActivation(
  workflowId: string,
  body: { enabled: boolean; pinnedVersion?: number | null; project?: string },
): Promise<Activation> {
  return apiRequest('PUT', `/workflows/${encodeURIComponent(workflowId)}/activation`, parseActivation, {
    body,
  });
}

/** Trigger types bound to an automation on activation (manual and chat need none). */
export const BOUND_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'trigger.schedule',
  'trigger.webhook',
  'trigger.github',
  'trigger.workflow',
]);

export type { ApiIssue };
