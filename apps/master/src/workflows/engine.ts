import { createHash } from 'node:crypto';
import type { OriginInput } from '../console-domain/origin.js';
import { functionNodeIssues } from './v2/functions.js';
import { CREDENTIAL_NOT_ALLOWED_FOR_PROJECT } from '../vault/projects.js';
import {
  type FunctionEgress,
  type JobRole,
  JobSpec,
  type RuntimeKind,
  WORKFLOW_STEP_KIND,
} from '@remyral/protocol';
import {
  descendants,
  expandPlan,
  fenceUpstream,
  renderPrompt,
  topoOrder,
  type GraphIssue,
  type UpstreamValue,
  WORKFLOW_LIMITS,
  type WorkflowEdge,
  type WorkflowNodeDef,
} from '@remyral/scheduler';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { IllegalTransitionError, JobStoreError, VersionConflictError } from '../jobs/errors.js';
import type { JobRecord, JobStore } from '../jobs/store.js';
import type {
  AdmissionVerdict,
  ContextProvider,
  DispatchAdmission,
  TickStep,
} from '../orchestration/orchestrator.js';
import {
  definitionIssues,
  graphOf,
  parsePlan,
  type WorkflowDefinition,
  type WorkflowNodeBody,
} from './definition.js';
import { type MergeGateway, PendingMergeGateway } from './merge.js';
import {
  aiProjection,
  configExpressions,
  containsExpression,
  isAiStep,
  NODE_TYPES,
  nodeType,
  type NodeTypeSpec,
  normaliseV1,
  privilegedDelta,
  deltaActions,
  type PortSpec,
  schemaVersionOf,
  type StoredDefinition,
  SETTINGS_DEFAULTS,
  typesDeliveredBy,
  V2_LIMITS,
  V2Node,
  validateV2,
  type WorkflowDefinitionV2,
} from '@remyral/workflow-nodes';
import { checkSource, EXPR_LIMITS, JSONATA_FUNCTIONS, REFUSED_FUNCTIONS } from '@remyral/workflow-expr';
import { authorize, type Subject } from '../authz/model.js';
import { Redactor } from '@remyral/observability';
import { z } from 'zod';
import {
  EngineV2Error,
  type PureInput,
  PUBLIC_RUN_STATE_SQL,
  type RerunPlan,
  type RerunStart,
  type StartChild,
  type StartTrigger,
  type ViewSideEffect,
  WorkflowEngineV2,
} from './v2/engine.js';
import { PureExecutor, type PureOutcome } from './v2/pure.js';
import { loadValue as loadStored, redactValue } from './v2/values.js';
import type { WorkflowIntegrations } from './v2/integrations.js';
import { queuePosition, workflowMetrics, type WorkflowMetricsView } from './v2/ops.js';
import { awaitAnswer, type HeldAnswer, holdOf, respondAnswer } from './v2/respond.js';
import type { NotificationService } from '../notifications/service.js';
import { runAsDenied } from './integrations.js';
import {
  definitionRuntimes,
  type ResolvedTask,
  resolvePlanTasks,
  staticPlacement,
  type StepPlacement,
} from './placement.js';
import { readDelegation } from '../subtasks/service.js';
import {
  type AttachmentRow,
  attachmentOf,
  liveAttachment,
  resolveName,
  type SharedWorkflowService,
  unboundSlots,
  versionRow,
} from './sharing.js';
import { effectiveDefinition, withInputDefaults } from './sharing-model.js';
import {
  clip,
  type NodeOutputs,
  plannedTaskSpec,
  rawSummary,
  readJobOutputs,
  type RunRepository,
  stepNeedsRepository,
  stepSpec,
} from './steps.js';
import { workflowStepPromptDigest } from '../reuse/digest.js';
import type { ReuseMatch, ResultReuseService } from '../reuse/service.js';
import { StorageQuotaError } from '../workspaces/storage.js';
import {
  combineInputs,
  type PreparedInput,
  projectKind,
  type WorkspaceService,
} from '../workspaces/service.js';

/** Validation stand-in for a workspace step (the job store fills `workspace` from the project). */
const WORKSPACE_PROBE = { egress: 'none' } as const;

export class WorkflowError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
    /** p13-workflows-ui: the validation issues of an `invalid_workflow` refusal (paths and codes only). */
    readonly issues: readonly GraphIssue[] = [],
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export interface WorkflowActor {
  readonly type: 'user' | 'system';
  readonly id: string;
}

/** Sends CANCEL_JOB to the holder of a job's lease (Orchestrator.sendCancel). */
export interface WorkflowCanceller {
  sendCancel(job: { readonly id: string }, reason: string): Promise<boolean>;
}

export type NodeState =
  | 'pending'
  | 'awaiting_approval'
  | 'queued'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'awaiting_merge';
export type RunState = 'starting' | 'running' | 'awaiting_merge' | 'succeeded' | 'failed' | 'cancelled';

const NODE_OPEN = new Set<NodeState>(['pending', 'awaiting_approval', 'queued']);
const JOB_TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const RUN_OPEN: RunState[] = ['starting', 'running', 'awaiting_merge'];
const ENGINE = { type: 'system', id: 'workflow' } as const;
const ROLE_RANK: Readonly<Record<string, number>> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export type { NodeOutputs } from './steps.js';

interface NodeRow {
  run_id: string;
  node_id: string;
  role: string;
  def: WorkflowNodeDef;
  job_spec: JobSpec;
  state: NodeState;
  job_id: string | null;
  attempts: number;
  outputs: NodeOutputs | null;
  upstream_snapshot: UpstreamValue[] | null;
  gate_role: string | null;
  gate_decision: 'approved' | 'denied' | null;
  gate_decided_by: string | null;
  gate_decided_at: Date | null;
  parent_node: string | null;
  reason: string | null;
  reused_job_id: string | null;
  /** p8-orchestration: why the step runs with its runtime / machine (null: runs before the feature). */
  placement: StepPlacement | null;
  job_state: string | null;
  job_project: string | null;
  /** Engine 2 only: the node run behind the row and its own state. */
  node_run_id?: string;
  node_run_state?: string;
}

/** A node of the run view: engine 1's row, or an engine-2 node run of any type (AI fields null for other types). */
export type ViewNode = Omit<NodeRow, 'role' | 'def' | 'job_spec'> & {
  role: string | null;
  def: WorkflowNodeDef | null;
  job_spec: JobSpec | null;
  worker_id: string | null;
  worker_name: string | null;
  /** Engine 2 (p14 14.1): node type, iteration scope, wait, port and error of the node run. */
  node_type?: string;
  scope?: string;
  wait_kind?: string | null;
  due_at?: Date | null;
  output_port?: string | null;
  error?: { code: string; message: string } | null;
  /** Node runs of a group-body node across iterations (0 at top level). */
  iterations?: number;
  /** 14.4: a re-run's node run taken over from the source run (its node run id), else null. */
  copied_from?: string | null;
};

export interface RunView {
  run: RunRow;
  nodes: ViewNode[];
  edges: (WorkflowEdge & { fromPort?: string; toPort?: string; state?: 'value' | 'skip' | 'pending' })[];
  mergeRequests: {
    id: string;
    node_id: string;
    status: string;
    branches: string[];
    external_ref: string | null;
    created_at: Date;
  }[];
  /** Engine 2: the run's outputs (stored value). */
  outputs?: unknown;
  /** Engine 2 (14.2): the outbox rows of integration nodes. */
  sideEffects?: ViewSideEffect[];
}

interface RunRow {
  id: string;
  definition_id: string;
  project: string;
  name: string;
  version: number;
  state: RunState;
  inputs: Record<string, string>;
  repository: RunRepository;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  ended_at: Date | null;
  reason: string | null;
  /** p14-workflow-engine: 1 (this engine) or 2 (`v2/engine.ts`). */
  engine?: number;
  /** p14-workflow-engine 14.2: what started the run and whether its data is trusted (engine 2). */
  trigger_kind?: string | null;
  source_trust?: string | null;
  trigger_node?: string | null;
  /** p9-queue-priority: the queue priority of the run's jobs. */
  priority: number;
  /** p14-workflow-engine 14.4 (engine 2): concurrency group, activation, pause, lineage, retention. */
  concurrency_key?: string | null;
  activated_at?: Date | null;
  paused_at?: Date | null;
  paused_by?: string | null;
  rerun_of?: string | null;
  rerun_from_node?: string | null;
  error_of?: string | null;
  data_pruned_at?: Date | null;
  /** The raw engine-2 state (`queued` / `active` / `paused` / terminal) and the place in the queue. */
  engine_state?: string;
  queue_position?: number | null;
}

export interface WorkflowServiceDeps {
  readonly pool: Pool;
  readonly jobs: JobStore;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly cancel: () => WorkflowCanceller;
  readonly merge?: MergeGateway;
  /** p5-research-workspace-next: run files and upstream artifacts of workspace runs (absent: refused). */
  readonly workspaces?: WorkspaceService;
  /**
   * p6-smart-routing: the runtime the routing rule of a step's kind picks for the project (first runtime of the
   * order some machine can run), for steps that name no runtime of their own; null = no rule / none available (the
   * definition's default runtime applies). Absent = no runtime routing.
   */
  readonly routeRuntime?: (project: string, role: JobRole) => Promise<RuntimeKind | null>;
  /** p6-deploy-pipeline (ADR-0028): requests a node's deploy step (absent: deploy steps are recorded as skipped). */
  readonly deploy?: () => WorkflowDeployPort | null;
  /** p6-result-reuse: the lookup behind the steps' opt-in reuse policy (absent: steps always run). */
  readonly reuse?: ResultReuseService;
  /**
   * p14-workflow-engine (ADR-0055): engine 2. `v2` (WORKFLOW_ENGINE_V2): v2 documents may be saved and run (on
   * engine 2); `v2ForV1` (WORKFLOW_ENGINE_V2_FOR_V1): version-1 documents also start on engine 2 (the parity suite,
   * later the 14.5 migration). Both default off: every workflow keeps running on engine 1 unchanged.
   */
  readonly engine?: { readonly v2?: boolean; readonly v2ForV1?: boolean };
  /** p14-workflow-engine 14.1: the master-pure executor / expression sandbox (default: a 2-thread pool). */
  readonly pure?: PureExecutor;
  /**
   * p14-workflow-engine 14.2: the existing master integrations integration nodes use (notifications, ops chat, ops
   * actions, GitHub App, uptime probe). Absent / null: integration nodes fail `integration_unavailable`.
   */
  readonly integrations?: () => WorkflowIntegrations | null;
  /**
   * p14-workflow-engine 14.3 (K1): the project's HTTP egress policy for HTTP / e-mail nodes, re-read for every node
   * run and sent with the function job. Absent: the K1 default (open to any public address).
   */
  readonly egress?: { effective(project: string): Promise<FunctionEgress> };
  /**
   * p14-workflow-engine 14.2: webhook waits — the key resume tokens are derived from (HKDF sub-key of the master box),
   * the public origin of their URLs, and the current / previous secrets of a workflow's bound webhook trigger (signed
   * waits verify the caller with them). Absent: webhook waits fail `integration_unavailable`.
   */
  readonly hooks?: {
    readonly key: Buffer;
    // p17-domain-wizard: live (the saved console address wins).
    readonly origin: OriginInput;
    readonly webhookSecrets: (project: string, name: string) => Promise<readonly string[]>;
  };
  /**
   * p14-workflow-engine 14.4: the notification service for failure-streak alerts (`workflow.failed` to the project's
   * owners / admins and the workflow's author). Absent / null: no alert (the follow-up records it).
   */
  readonly notifications?: () => Pick<NotificationService, 'notify'> | null;
  /**
   * p18-multi-project: shared workflows — a saved owner version moves the attachments that follow it (or leaves it
   * pending for their admins). Absent / null: no attachment is told (they follow at their next acceptance).
   */
  readonly sharing?: () => SharedWorkflowService | null;
}

/**
 * p14-workflow-engine: the node types engine 2 executes now — 14.1 added control flow, data, timers, approvals,
 * sub-workflows and the manual trigger; 14.2 adds the master integrations, the webhook wait and every trigger (the
 * catalog knows more; they are refused with `node_type_unavailable`).
 */
export const ENGINE_V2_TYPES = typesDeliveredBy('14.4');
const secretScan = new Redactor();

/** p6-deploy-pipeline: what the engine needs to request a deploy step (wired to the ops service in compose.ts). */
export interface WorkflowDeployPort {
  request(input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly project: string;
    readonly createdBy: string;
    readonly jobId: string | null;
    readonly step: {
      kind: string;
      env?: string | undefined;
      force?: boolean | undefined;
      branch?: string | undefined;
    };
  }): Promise<{ actionId: string; state: string } | { refused: string }>;
}

/**
 * DAG workflows (p4-dag, docs/design/p4-dag.md): definitions, runs instantiated as jobs with
 * `job_dependencies`, dependency-aware dispatch (admission), progress (tick step), failure policies,
 * approval gates, dynamic planner sub-DAGs, outputs passed downstream as fenced data, integrator merge
 * requests behind {@link MergeGateway}.
 */
export class WorkflowService implements DispatchAdmission {
  readonly merge: MergeGateway;
  /** p14-workflow-engine: engine 2 (node runs, lazy jobs); runs whose `engine` is 2 belong to it. */
  readonly v2: WorkflowEngineV2;

  /** p14-workflow-engine 14.1: master-pure nodes and expressions (sandbox thread pool, started lazily). */
  readonly pure: PureExecutor;

  constructor(private readonly deps: WorkflowServiceDeps) {
    this.merge = deps.merge ?? new PendingMergeGateway();
    this.pure = deps.pure ?? new PureExecutor();
    this.v2 = new WorkflowEngineV2(deps, this.merge, this.pure);
    this.v2.startChild = (actor, input) => this.#startChild(actor, input);
    this.v2.startErrorRun = (input) => this.#startErrorRun(input);
  }

  /** Stops the expression sandbox threads (master shutdown). */
  async close(): Promise<void> {
    await this.pure.close();
  }

  /** Engine 2 accepts v2 documents (flag), and may run v1 documents too (second flag). */
  get engineFlags(): { v2: boolean; v2ForV1: boolean } {
    return { v2: this.deps.engine?.v2 === true, v2ForV1: this.deps.engine?.v2ForV1 === true };
  }

  // ===================================================================================== definitions

  /**
   * Every check a definition of `project` must pass (schema, graph, deploy steps, layout, workspace rules, per-step
   * JobSpec) as issues — paths and codes only (p13-workflows-ui `POST /workflows/validate`).
   */
  async validate(project: string, body: unknown): Promise<{ ok: boolean; issues: GraphIssue[] }> {
    const r = await this.#check(project, body);
    return { ok: r.issues.length === 0, issues: r.issues };
  }

  async #check(
    project: string,
    body: unknown,
  ): Promise<{ def: StoredDefinition | null; issues: GraphIssue[] }> {
    const kind = await projectKind(this.deps.pool, project);
    if (kind === null) throw new WorkflowError(404, 'project_not_found', 'Project not found.');
    // p14-workflow-engine: a v2 document (schemaVersion 2) is validated by the catalog (only the node types engine 2
    // runs now), then — as its AI steps — by every v1 rule below.
    const version = schemaVersionOf(body);
    if (version === null) return { def: null, issues: [{ path: 'schemaVersion', code: 'invalid' }] };
    let stored: StoredDefinition;
    if (version === 2) {
      if (!this.engineFlags.v2)
        return { def: null, issues: [{ path: 'schemaVersion', code: 'engine_v2_disabled' }] };
      const v2 = validateV2(body, {
        available: ENGINE_V2_TYPES,
        looksSecret: (s) => secretScan.redact(s) !== s,
        // 14.1: every expression is compiled and scanned at save (syntax, refused functions, bounded regexes).
        checkExpression: (s, mode) => checkSource(s, mode),
      });
      if (!v2.ok) return { def: null, issues: v2.issues };
      // 14.3 (§8.4): HTTP / e-mail nodes against the project's egress policy and their vault credentials' hosts
      // (checked again at run time — the policy may change — and by the worker).
      const egress = (await this.deps.egress?.effective(project)) ?? { mode: 'open' as const, hosts: [] };
      const fnIssues = await functionNodeIssues(this.deps.pool, v2.def.nodes, egress, project);
      if (fnIssues.length > 0) return { def: null, issues: fnIssues };
      stored = v2.def;
    } else {
      const parsed = definitionIssues(body);
      if (!parsed.ok) return { def: null, issues: parsed.issues };
      stored = parsed.def;
    }
    const def = aiProjection(stored);
    const issues: GraphIssue[] = [];
    if (kind === 'workspace') {
      // p5-research-workspace-next: no repository, so nothing to integrate or merge.
      if (def.defaults.repository !== undefined)
        issues.push({ path: 'defaults.repository', code: 'not_allowed' });
      def.nodes.forEach((n, i) => {
        if (n.role === 'integrator')
          issues.push({ path: `nodes.${String(i)}.role`, code: 'integrator_needs_repository' });
      });
    }
    // Every node must describe a job a user could submit (protocol JobSpec), with a placeholder repository
    // when the definition leaves it to the run (none for a workspace project).
    issues.push(
      ...this.#specIssues(
        def,
        project,
        kind === 'workspace'
          ? null
          : (def.defaults.repository ?? { url: 'https://example.invalid/repo.git', baseRef: 'main' }),
      ),
    );
    return { def: stored, issues: issues.slice(0, 20) };
  }

  /** The definition, or a 400 `invalid_workflow` carrying the issues. */
  async #prepare(project: string, body: unknown): Promise<StoredDefinition> {
    const { def, issues } = await this.#check(project, body);
    if (def === null || issues.length > 0) {
      throw new WorkflowError(
        400,
        'invalid_workflow',
        `invalid workflow: ${issues.map((i) => `${i.path}:${i.code}`).join(', ')}`.slice(0, 1000),
        issues,
      );
    }
    return def;
  }

  async #archived(db: Queryable, project: string, name: string): Promise<boolean> {
    const { rowCount } = await db.query('SELECT 1 FROM workflow_archives WHERE project = $1 AND name = $2', [
      project,
      name,
    ]);
    return (rowCount ?? 0) > 0;
  }

  async define(
    actor: WorkflowActor,
    project: string,
    body: unknown,
    opts: {
      readonly baseVersion?: number | undefined;
      readonly via?: 'update' | 'duplicate';
      /**
       * p14-workflow-engine 14.2 (§8.5): the caller's authorization subject and step-up state. A version whose diff
       * against the latest one adds or changes privileged nodes needs the matching `workflows.define.*` action and a
       * fresh step-up; without `access` such a version is refused.
       */
      readonly access?: { readonly subject: Subject; readonly stepUpFresh: boolean } | undefined;
    } = {},
  ): Promise<{
    id: string;
    name: string;
    version: number;
    /** p18-multi-project: the projects that attached it — moved to this version, waiting for their admin, pinned. */
    attachments?: { advanced: string[]; pending: string[]; pinned: string[] };
  }> {
    const def = await this.#prepare(project, body).catch(async (err: unknown) => {
      // p22-vault-projects: a save referencing a vault credential the project may not use is audited as denied.
      const refused =
        err instanceof WorkflowError
          ? err.issues.filter((i) => i.code === CREDENTIAL_NOT_ALLOWED_FOR_PROJECT)
          : [];
      if (refused.length > 0)
        await this.deps.audit.record({
          actor: { type: actor.type, id: actor.id },
          action: 'workflow.define',
          target: `workflow-project:${project}`,
          outcome: 'denied',
          metadata: {
            project,
            denial: CREDENTIAL_NOT_ALLOWED_FOR_PROJECT,
            paths: refused.slice(0, 20).map((i) => i.path),
          },
        });
      throw err;
    });
    const saved = await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `wfdef:${project}:${def.name}`,
      ]);
      const { rows } = await tx.query<{ v: number | null }>(
        'SELECT max(version) AS v FROM workflow_definitions WHERE project = $1 AND name = $2',
        [project, def.name],
      );
      const latest = rows[0]?.v ?? 0;
      if (await this.#archived(tx, project, def.name)) {
        throw new WorkflowError(409, 'workflow_archived', 'This workflow is archived; restore it first.');
      }
      if (opts.via === 'duplicate' && latest > 0) {
        throw new WorkflowError(409, 'workflow_exists', 'A workflow with this name already exists.');
      }
      // p18-multi-project: a project's namespace is its own workflows and the ones it attached (no aliases).
      if (latest === 0 && (await liveAttachment(tx, project, def.name)) !== null) {
        throw new WorkflowError(
          409,
          'name_taken',
          `Project ${project} runs a shared workflow named ${def.name}; choose another name.`,
        );
      }
      if (opts.baseVersion !== undefined && opts.baseVersion !== latest) {
        throw new WorkflowError(
          409,
          'version_conflict',
          `The workflow changed meanwhile: the latest version is ${String(latest)}, not ${String(opts.baseVersion)}.`,
        );
      }
      const delta = await this.#privilegedDelta(tx, project, def.name, latest, def, actor, opts.access);
      const version = latest + 1;
      const hash = createHash('sha256').update(JSON.stringify(def)).digest('hex');
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO workflow_definitions (project, name, version, definition, definition_hash, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [project, def.name, version, JSON.stringify(def), hash, actor.id, this.deps.clock()],
      );
      const id = ins.rows[0]?.id ?? '';
      await this.deps.audit.record(
        {
          actor: { type: actor.type, id: actor.id },
          action: 'workflow.define',
          target: `workflow:${id}`,
          outcome: 'success',
          metadata: {
            project,
            name: def.name,
            version,
            nodes: def.nodes.length,
            edges: def.edges.length,
            hash,
            ...(opts.via === undefined ? {} : { via: opts.via }),
            ...(opts.via === 'update' ? { previousVersion: latest } : {}),
            ...(delta.length === 0
              ? {}
              : {
                  privilegedDelta: delta.slice(0, 50).map((d) => `${d.node}:${d.type}:${d.change}`),
                  actions: deltaActions(delta),
                }),
          },
        },
        tx,
      );
      return { id, name: def.name, version };
    });
    // p18-multi-project: projects that attached this workflow follow non-privileged versions; others wait.
    const sharing = this.deps.sharing?.() ?? null;
    if (sharing === null) return saved;
    const attachments = await sharing.onOwnerVersion(project, def.name);
    return attachments.advanced.length + attachments.pending.length + attachments.pinned.length === 0
      ? saved
      : { ...saved, attachments };
  }

  /**
   * p14-workflow-engine 14.2 (§8.5): privileged nodes added or changed against the latest version (none for v1
   * documents). Refuses (403) when the caller lacks a needed `workflows.define.*` action or a fresh step-up.
   */
  async #privilegedDelta(
    tx: Queryable,
    project: string,
    name: string,
    latest: number,
    def: StoredDefinition,
    actor: WorkflowActor,
    access: { readonly subject: Subject; readonly stepUpFresh: boolean } | undefined,
  ): Promise<ReturnType<typeof privilegedDelta>> {
    if (schemaVersionOf(def) !== 2) return [];
    let prev: WorkflowDefinitionV2 | null = null;
    if (latest > 0) {
      const { rows } = await tx.query<{ definition: StoredDefinition }>(
        'SELECT definition FROM workflow_definitions WHERE project = $1 AND name = $2 AND version = $3',
        [project, name, latest],
      );
      const d = rows[0]?.definition;
      if (d !== undefined)
        prev = schemaVersionOf(d) === 2 ? (d as WorkflowDefinitionV2) : normaliseV1(d as WorkflowDefinition);
    }
    const delta = privilegedDelta(prev, def as WorkflowDefinitionV2);
    if (delta.length === 0) return delta;
    const actions = deltaActions(delta);
    const missing =
      access === undefined
        ? actions
        : actions.filter((a) => !authorize(access.subject, a, { project }).allow);
    const deny = async (reason: string): Promise<void> => {
      await this.deps.audit.record({
        actor: { type: actor.type, id: actor.id },
        action: 'workflow.define',
        target: `workflow-definition:${project}/${name}`,
        outcome: 'denied',
        metadata: { project, name, reason, actions, nodes: delta.slice(0, 20).map((d) => d.node) },
      });
    };
    if (missing.length > 0) {
      await deny('privileged_delta_forbidden');
      throw new WorkflowError(
        403,
        'forbidden',
        `This version adds or changes nodes that need ${missing.join(', ')} (${delta
          .slice(0, 5)
          .map((d) => d.node)
          .join(', ')}).`,
      );
    }
    if (access?.stepUpFresh !== true) {
      await deny('step_up_required');
      throw new WorkflowError(403, 'step_up_required', 'Confirm with a current authenticator code.');
    }
    return delta;
  }

  /**
   * p13-workflows-ui: a new version of the workflow `id` belongs to (same project and name; the name is immutable —
   * a new name is a duplicate). `baseVersion`: the version the editor started from (409 when another was saved).
   */
  async update(
    actor: WorkflowActor,
    id: string,
    body: unknown,
    baseVersion?: number,
    access?: { readonly subject: Subject; readonly stepUpFresh: boolean },
  ): Promise<{ id: string; name: string; version: number }> {
    const cur = await this.definition(id);
    if (cur === null) throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
    const name = typeof body === 'object' && body !== null ? (body as { name?: unknown }).name : undefined;
    if (name !== cur.name) {
      throw new WorkflowError(400, 'invalid_workflow', 'invalid workflow: name:immutable', [
        { path: 'name', code: 'immutable' },
      ]);
    }
    return this.define(actor, cur.project, body, { baseVersion, via: 'update', access });
  }

  /** p13-workflows-ui: every version of the workflow `id` belongs to, newest first (null: unknown id). */
  async versions(id: string): Promise<
    | {
        id: string;
        version: number;
        createdBy: string;
        createdAt: Date;
        hash: string;
        nodes: number;
        edges: number;
      }[]
    | null
  > {
    const cur = await this.definition(id);
    if (cur === null) return null;
    const { rows } = await this.deps.pool.query<{
      id: string;
      version: number;
      created_by: string;
      created_at: Date;
      definition_hash: string;
      nodes: number;
      edges: number;
    }>(
      `SELECT id, version, created_by, created_at, definition_hash,
              jsonb_array_length(definition->'nodes') AS nodes, jsonb_array_length(definition->'edges') AS edges
         FROM workflow_definitions WHERE project = $1 AND name = $2 ORDER BY version DESC`,
      [cur.project, cur.name],
    );
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      createdBy: r.created_by,
      createdAt: r.created_at,
      hash: r.definition_hash,
      nodes: r.nodes,
      edges: r.edges,
    }));
  }

  /** p13-workflows-ui: the full document of one version with its catalog facts (latest version, archived). */
  async document(id: string): Promise<{
    id: string;
    project: string;
    name: string;
    version: number;
    latestVersion: number;
    latestId: string;
    archived: boolean;
    createdBy: string;
    createdAt: Date;
    hash: string;
    definition: StoredDefinition;
  } | null> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      project: string;
      name: string;
      version: number;
      created_by: string;
      created_at: Date;
      definition_hash: string;
      definition: StoredDefinition;
      latest_id: string;
      latest_version: number;
      archived: boolean;
    }>(
      `SELECT d.id, d.project, d.name, d.version, d.created_by, d.created_at, d.definition_hash, d.definition,
              l.id AS latest_id, l.version AS latest_version,
              EXISTS (SELECT 1 FROM workflow_archives a WHERE a.project = d.project AND a.name = d.name) AS archived
         FROM workflow_definitions d
         JOIN LATERAL (SELECT x.id, x.version FROM workflow_definitions x
                        WHERE x.project = d.project AND x.name = d.name ORDER BY x.version DESC LIMIT 1) l ON true
        WHERE d.id = $1`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      id: r.id,
      project: r.project,
      name: r.name,
      version: r.version,
      latestVersion: r.latest_version,
      latestId: r.latest_id,
      archived: r.archived,
      createdBy: r.created_by,
      createdAt: r.created_at,
      hash: r.definition_hash,
      definition: r.definition,
    };
  }

  /** p13-workflows-ui: archive (new runs and versions refused, hidden from pickers) or restore a workflow. */
  async setArchived(actor: WorkflowActor, id: string, archived: boolean, reason?: string): Promise<boolean> {
    const cur = await this.definition(id);
    if (cur === null) throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
    return withTransaction(this.deps.pool, async (tx) => {
      const res = archived
        ? await tx.query(
            `INSERT INTO workflow_archives (project, name, archived_by, archived_at, reason)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project, name) DO NOTHING`,
            [cur.project, cur.name, actor.id, this.deps.clock(), reason ?? null],
          )
        : await tx.query('DELETE FROM workflow_archives WHERE project = $1 AND name = $2', [
            cur.project,
            cur.name,
          ]);
      if ((res.rowCount ?? 0) > 0) {
        await this.deps.audit.record(
          {
            actor: { type: actor.type, id: actor.id },
            action: archived ? 'workflow.archive' : 'workflow.unarchive',
            target: `workflow:${id}`,
            outcome: 'success',
            metadata: { project: cur.project, name: cur.name, ...(reason ? { reason } : {}) },
          },
          tx,
        );
      }
      return archived;
    });
  }

  /**
   * p13-workflows-ui: version 1 of a new name in the same project, from the document of `id`. p18-multi-project
   * ("Projeye kopyala"): `targetProject` copies it into another project as that project's own workflow — the owner's
   * repository stays behind (a target runs on its own repository) and the copy's privileged nodes need the target's
   * `workflows.define.*` actions and a step-up like any new version there.
   */
  async duplicate(
    actor: WorkflowActor,
    id: string,
    name: string,
    access?: { readonly subject: Subject; readonly stepUpFresh: boolean },
    targetProject?: string,
  ): Promise<{ id: string; name: string; version: number }> {
    const cur = await this.definition(id);
    if (cur === null) throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
    const into = targetProject ?? cur.project;
    const source = into === cur.project ? cur.definition : effectiveDefinition(cur.definition, {}, true);
    const created = await this.define(actor, into, { ...source, name }, { via: 'duplicate', access });
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'workflow.duplicate',
      target: `workflow:${created.id}`,
      outcome: 'success',
      metadata: {
        project: into,
        from: id,
        fromName: cur.name,
        fromVersion: cur.version,
        name,
        ...(into === cur.project ? {} : { ownerProject: cur.project }),
      },
    });
    return { id: created.id, name: created.name, version: created.version };
  }

  async definition(id: string): Promise<{
    id: string;
    project: string;
    name: string;
    version: number;
    definition: StoredDefinition;
  } | null> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      project: string;
      name: string;
      version: number;
      definition: StoredDefinition;
    }>('SELECT id, project, name, version, definition FROM workflow_definitions WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async list(projects: readonly string[] | null): Promise<{
    definitions: {
      id: string;
      project: string;
      name: string;
      version: number;
      nodes: number;
      edges: number;
      createdAt: Date;
      /** p13-workflows-ui: catalog facts (stats across every version of project + name). */
      createdBy: string;
      description: string | null;
      archived: boolean;
      archivedAt: Date | null;
      runs: number;
      succeeded: number;
      failed: number;
      lastRun: { id: string; state: RunState; createdAt: Date } | null;
      /**
       * p18-multi-project: set on a workflow a project attached (the item's `id` is the owner's version it runs,
       * `project` the attaching project; open it with `?project=`); absent on own workflows.
       */
      attachment?: {
        id: string;
        ownerProject: string;
        state: string;
        follow: string;
        latestVersion: number;
        pendingVersion: number | null;
      };
    }[];
    runs: {
      id: string;
      project: string;
      name: string;
      version: number;
      state: RunState;
      createdAt: Date;
      endedAt: Date | null;
    }[];
  }> {
    const params: unknown[] = [];
    let where = '';
    if (projects !== null) {
      params.push([...projects]);
      where = 'WHERE project = ANY($1::text[])';
    }
    const defs = await this.deps.pool.query<{
      id: string;
      project: string;
      name: string;
      version: number;
      nodes: number;
      edges: number;
      created_at: Date;
      created_by: string;
      description: string | null;
      archived_at: Date | null;
      runs: number;
      succeeded: number;
      failed: number;
      last_id: string | null;
      last_state: RunState | null;
      last_at: Date | null;
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (project, name) id, project, name, version, created_at, created_by,
                jsonb_array_length(definition->'nodes') AS nodes,
                jsonb_array_length(definition->'edges') AS edges,
                definition->>'description' AS description
           FROM workflow_definitions ${where} ORDER BY project, name, version DESC
       )
       SELECT l.*, a.archived_at,
              coalesce(s.runs, 0)::int AS runs, coalesce(s.succeeded, 0)::int AS succeeded,
              coalesce(s.failed, 0)::int AS failed,
              lr.id AS last_id, lr.public_state AS last_state, lr.created_at AS last_at
         FROM latest l
         LEFT JOIN workflow_archives a ON a.project = l.project AND a.name = l.name
         LEFT JOIN LATERAL (
           SELECT count(*) AS runs, count(*) FILTER (WHERE r.state = 'succeeded') AS succeeded,
                  count(*) FILTER (WHERE r.state = 'failed') AS failed
             FROM workflow_runs r WHERE r.project = l.project AND r.name = l.name) s ON true
         LEFT JOIN LATERAL (
           SELECT r.id, ${PUBLIC_RUN_STATE_SQL('r')} AS public_state, r.created_at FROM workflow_runs r
            WHERE r.project = l.project AND r.name = l.name ORDER BY r.created_at DESC, r.id LIMIT 1) lr ON true
        ORDER BY l.project, l.name`,
      params,
    );
    const runs = await this.deps.pool.query<RunRow>(
      `SELECT r.*, ${PUBLIC_RUN_STATE_SQL('r')} AS state FROM workflow_runs r ${where.replace('project', 'r.project')}
        ORDER BY r.created_at DESC, r.id LIMIT 100`,
      params,
    );
    // p18-multi-project: workflows the visible projects attached (the version each runs; its runs in that project).
    const attached = await this.deps.pool.query<{
      id: string;
      project: string;
      name: string;
      version: number;
      nodes: number;
      edges: number;
      created_at: Date;
      created_by: string;
      description: string | null;
      archived_at: Date | null;
      runs: number;
      succeeded: number;
      failed: number;
      last_id: string | null;
      last_state: RunState | null;
      last_at: Date | null;
      attachment_id: string;
      owner_project: string;
      a_state: string;
      follow: string;
      latest_version: number;
      pending_version: number | null;
    }>(
      `SELECT d.id, a.project, a.name, a.version, d.created_at, d.created_by,
              jsonb_array_length(d.definition->'nodes') AS nodes, jsonb_array_length(d.definition->'edges') AS edges,
              d.definition->>'description' AS description, w.archived_at,
              a.id AS attachment_id, a.owner_project, a.state AS a_state, a.follow, a.pending_version,
              (SELECT max(x.version) FROM workflow_definitions x WHERE x.project = a.owner_project AND x.name = a.name)
                AS latest_version,
              coalesce(s.runs, 0)::int AS runs, coalesce(s.succeeded, 0)::int AS succeeded,
              coalesce(s.failed, 0)::int AS failed,
              lr.id AS last_id, lr.public_state AS last_state, lr.created_at AS last_at
         FROM workflow_attachments a
         JOIN workflow_definitions d ON d.project = a.owner_project AND d.name = a.name AND d.version = a.version
         LEFT JOIN workflow_archives w ON w.project = a.owner_project AND w.name = a.name
         LEFT JOIN LATERAL (
           SELECT count(*) AS runs, count(*) FILTER (WHERE r.state = 'succeeded') AS succeeded,
                  count(*) FILTER (WHERE r.state = 'failed') AS failed
             FROM workflow_runs r WHERE r.project = a.project AND r.name = a.name) s ON true
         LEFT JOIN LATERAL (
           SELECT r.id, ${PUBLIC_RUN_STATE_SQL('r')} AS public_state, r.created_at FROM workflow_runs r
            WHERE r.project = a.project AND r.name = a.name ORDER BY r.created_at DESC, r.id LIMIT 1) lr ON true
        WHERE a.state <> 'detached' ${projects === null ? '' : 'AND a.project = ANY($1::text[])'}
        ORDER BY a.project, a.name`,
      params,
    );
    return {
      definitions: defs.rows
        .map((d) => ({
          id: d.id,
          project: d.project,
          name: d.name,
          version: d.version,
          nodes: d.nodes,
          edges: d.edges,
          createdAt: d.created_at,
          createdBy: d.created_by,
          description: d.description,
          archived: d.archived_at !== null,
          archivedAt: d.archived_at,
          runs: d.runs,
          succeeded: d.succeeded,
          failed: d.failed,
          lastRun:
            d.last_id === null || d.last_state === null || d.last_at === null
              ? null
              : { id: d.last_id, state: d.last_state, createdAt: d.last_at },
        }))
        .concat(
          attached.rows.map((d) => ({
            id: d.id,
            project: d.project,
            name: d.name,
            version: d.version,
            nodes: d.nodes,
            edges: d.edges,
            createdAt: d.created_at,
            createdBy: d.created_by,
            description: d.description,
            archived: d.archived_at !== null,
            archivedAt: d.archived_at,
            runs: d.runs,
            succeeded: d.succeeded,
            failed: d.failed,
            lastRun:
              d.last_id === null || d.last_state === null || d.last_at === null
                ? null
                : { id: d.last_id, state: d.last_state, createdAt: d.last_at },
            attachment: {
              id: d.attachment_id,
              ownerProject: d.owner_project,
              state: d.a_state,
              follow: d.follow,
              latestVersion: d.latest_version,
              pendingVersion: d.pending_version,
            },
          })),
        ),
      runs: runs.rows.map((r) => ({
        id: r.id,
        project: r.project,
        name: r.name,
        version: r.version,
        state: r.state,
        createdAt: r.created_at,
        endedAt: r.ended_at,
      })),
    };
  }

  // ===================================================================================== runs

  /**
   * Starts a run: validates inputs, creates one job per node (DRAFT), records `job_dependencies` for every
   * edge (the store's cycle check is the backstop), submits every job and blocks the non-ready ones.
   */
  async startRun(
    actor: WorkflowActor,
    definitionId: string,
    input: {
      readonly inputs: Readonly<Record<string, string>>;
      readonly repository?: { url: string; baseRef: string } | undefined;
      /** p5-research-workspace-next: files handed to every step (workspace projects only; prepared and scanned). */
      readonly files?: readonly PreparedInput[] | undefined;
      /** p9-queue-priority: the queue priority of every step job (class value or advanced number; default 0). */
      readonly priority?: number | undefined;
      /** p14-workflow-engine 14.1: a sub-workflow call (always engine 2). */
      readonly parent?: { readonly runId: string; readonly nodeRunId: string } | undefined;
      /** p14-workflow-engine 14.2: the event the run starts from (engine 2; engine 1 runs ignore it). */
      readonly trigger?: StartTrigger | undefined;
      /** p14-workflow-engine 14.4: a re-run (engine 2): what it takes over from its source run. */
      readonly rerun?: RerunStart | undefined;
      /** p14-workflow-engine 14.4: the failed run this run is the error workflow of (engine 2). */
      readonly errorOf?: string | undefined;
      /**
       * p18-multi-project: the project the run belongs to (default: the workflow's owner project). Another project runs
       * the owner's workflow only through its live, enabled attachment — at the attachment's version (a re-run keeps
       * its source's), with the attachment's overrides and credential bindings, and the run project's repository,
       * policies, egress, integrations, quotas and approvers.
       */
      readonly project?: string | undefined;
    },
  ): Promise<string> {
    let d = await this.definition(definitionId);
    if (d === null) throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
    const runProject = input.project ?? d.project;
    let attachment: AttachmentRow | null = null;
    if (runProject !== d.project) {
      attachment = await attachmentOf(this.deps.pool, runProject, d.project, d.name);
      if (attachment === null) throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
      if (attachment.state !== 'enabled') {
        throw new WorkflowError(
          409,
          'attachment_disabled',
          `Workflow ${d.name} is not enabled in project ${runProject}.`,
        );
      }
      if (input.rerun === undefined && d.version !== attachment.version) {
        const v = await versionRow(this.deps.pool, d.project, d.name, attachment.version);
        if (v === null) throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
        d = { id: v.id, project: d.project, name: d.name, version: v.version, definition: v.definition };
      }
      const unbound = await unboundSlots(this.deps.pool, attachment.id, d.definition);
      if (unbound.length > 0) {
        throw new WorkflowError(
          409,
          'credential_unbound',
          `Workflow ${d.name} needs credentials bound in project ${runProject}: ${unbound.join(', ')}.`,
        );
      }
    }
    // The owner's archive stops new runs everywhere (owner project and every attachment).
    if (await this.#archived(this.deps.pool, d.project, d.name)) {
      throw new WorkflowError(409, 'workflow_archived', 'This workflow is archived; restore it to run it.');
    }
    const overrides = attachment?.overrides ?? {};
    const stored = attachment === null ? d.definition : effectiveDefinition(d.definition, overrides, true);
    const given = attachment === null ? input.inputs : withInputDefaults(stored, input.inputs, overrides);
    // p14-workflow-engine: v2 documents run on engine 2 (flag); v1 documents on engine 1 unless WORKFLOW_ENGINE_V2_FOR_V1.
    const version = schemaVersionOf(stored);
    const engine =
      version === 2 ||
      input.parent !== undefined ||
      input.rerun !== undefined ||
      input.errorOf !== undefined ||
      (this.engineFlags.v2ForV1 && version === 1)
        ? 2
        : 1;
    if (version === 2 && !this.engineFlags.v2) {
      throw new WorkflowError(
        409,
        'engine_v2_disabled',
        'This workflow needs the new workflow engine, which is off.',
      );
    }
    const def = aiProjection(stored);
    const issues: string[] = [];
    for (const [name, spec] of Object.entries(def.inputs)) {
      const v = given[name];
      if (spec.required && (v === undefined || v.trim() === '')) issues.push(`inputs.${name}:required`);
    }
    for (const [name, v] of Object.entries(given)) {
      if (!(name in def.inputs)) issues.push(`inputs.${name}:unknown`);
      else if (v.length > WORKFLOW_LIMITS.maxInputChars) issues.push(`inputs.${name}:too_long`);
    }
    // v2 typed inputs: a number / boolean / JSON input must parse as one (values travel as strings).
    if (version === 2) {
      const typed = (stored as WorkflowDefinitionV2).inputs;
      for (const [name, v] of Object.entries(given)) {
        const t = typed[name]?.type;
        if (v.trim() === '' || t === undefined || t === 'string') continue;
        const ok =
          t === 'number'
            ? Number.isFinite(Number(v))
            : t === 'boolean'
              ? v === 'true' || v === 'false'
              : (() => {
                  try {
                    JSON.parse(v);
                    return true;
                  } catch {
                    return false;
                  }
                })();
        if (!ok) issues.push(`inputs.${name}:invalid_type`);
      }
    }
    // p16-workflow-quality: only steps that work on code need a repository (a v2 workflow without AI steps never does).
    const needingCode = def.nodes.filter(stepNeedsRepository).map((n) => n.id);
    const workspace = (await projectKind(this.deps.pool, runProject)) === 'workspace';
    const files = input.files ?? [];
    let repository: RunRepository = null;
    if (workspace) {
      if (input.repository !== undefined) issues.push('repository:not_allowed');
      if (def.nodes.some((n) => n.role === 'integrator')) issues.push('nodes:integrator_needs_repository');
      if (files.length > 0 && this.deps.workspaces === undefined) issues.push('files:not_allowed');
      if (combineInputs(files).dropped.length > 0) issues.push('files:too_many');
    } else {
      // p16-workflow-quality: the run's input, else the workflow's default, else the project's registered repository;
      // none at all: the steps run in scratch directories unless one works on code. p18-multi-project: outside the
      // owner project the owner's default is never used (the attachment's repository, else the run project's).
      repository =
        input.repository ??
        (attachment === null ? def.defaults.repository : overrides.repository) ??
        (await registeredRepository(this.deps.pool, runProject));
      if (repository === null && needingCode.length > 0) {
        throw new WorkflowError(
          400,
          'repository_required',
          `Step${needingCode.length === 1 ? '' : 's'} ${needingCode.slice(0, 5).join(', ')} work${needingCode.length === 1 ? 's' : ''} on code (integrator, Coolify deploy or needsRepository) and need a repository: register the project's repository (Projects → ${runProject} → Repository) or give one when starting the run.`,
        );
      }
      // p19-repo-inputs-composer-workflows: run files of a repository project's run reach every step job as input
      // files (a scratch in/ next to the checkout; a repository-less run's steps get them in their scratch dir). The
      // callers checked that a machine can take them (repo-inputs-v1; placement keeps the steps off older ones).
      if (files.length > 0 && this.deps.workspaces === undefined) issues.push('files:not_allowed');
      if (combineInputs(files).dropped.length > 0) issues.push('files:too_many');
    }
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority) || priority < -100 || priority > 100)
      issues.push('priority:out_of_range');
    if (issues.length > 0) {
      throw new WorkflowError(400, 'invalid_run', `Invalid run: ${issues.join(', ')}`.slice(0, 1000));
    }
    const inputs = Object.fromEntries(Object.entries(given).map(([k, v]) => [k, v.replaceAll('\u0000', '')]));
    this.#checkSpecs(def, runProject, repository);
    const routed = await this.#routedRuntimes(def, runProject);
    // p8-orchestration: runtimes a planner may pick for its tasks (named in its instructions; enforced on expansion).
    const planRuntimes = def.nodes.some((n) => n.dynamic !== undefined)
      ? [
          ...new Set([
            ...definitionRuntimes(def),
            ...(await readDelegation(this.deps.pool, runProject)).delegationRuntimes,
          ]),
        ]
      : [];
    if (engine === 2) {
      try {
        return await this.v2.startRun(actor, {
          definition: { id: d.id, project: d.project, name: d.name, version: d.version },
          project: runProject,
          attachmentId: attachment?.id ?? null,
          def: version === 2 ? (stored as WorkflowDefinitionV2) : normaliseV1(stored as WorkflowDefinition),
          inputs,
          repository,
          files,
          priority,
          routed,
          planRuntimes,
          workspace,
          parent: input.parent,
          trigger: input.trigger,
          rerun: input.rerun,
          errorOf: input.errorOf,
        });
      } catch (err) {
        throw err instanceof EngineV2Error ? new WorkflowError(err.status, err.code, err.message) : err;
      }
    }
    const now = this.deps.clock();
    const graph = graphOf(def);
    const order = topoOrder(graph) ?? [];
    const runId = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO workflow_runs (definition_id, project, name, version, state, inputs, repository, created_by,
                                    created_at, updated_at, priority, attachment_id)
         VALUES ($1, $2, $3, $4, 'starting', $5, $6, $7, $8, $8, $9, $10) RETURNING id`,
        [
          d.id,
          runProject,
          d.name,
          d.version,
          JSON.stringify(inputs),
          repository === null ? null : JSON.stringify(repository),
          actor.id,
          now,
          priority,
          attachment?.id ?? null,
        ],
      );
      const id = rows[0]?.id ?? '';
      if (files.length > 0) await this.deps.workspaces?.insertRunFiles(tx, id, files, now);
      for (const nodeId of order) {
        const node = def.nodes.find((n) => n.id === nodeId);
        if (node === undefined) continue;
        const spec = this.#nodeSpec(def, node, {
          runId: id,
          inputs,
          repository,
          project: runProject,
          routed,
          planRuntimes,
        });
        const placement = staticPlacement({ nodeRuntime: node.runtime, routed: routed.get(node.id), spec });
        await tx.query(
          `INSERT INTO workflow_nodes (run_id, node_id, role, def, job_spec, state, gate_role, placement, created_at,
                                       updated_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $8)`,
          [
            id,
            node.id,
            node.role,
            JSON.stringify(graph.nodes.find((n) => n.id === node.id)),
            JSON.stringify(spec),
            node.approval?.approverRole ?? null,
            JSON.stringify(placement),
            now,
          ],
        );
      }
      for (const e of def.edges) {
        await tx.query('INSERT INTO workflow_edges (run_id, from_node, to_node) VALUES ($1, $2, $3)', [
          id,
          e.from,
          e.to,
        ]);
      }
      await this.deps.audit.record(
        {
          actor: { type: actor.type, id: actor.id },
          action: 'workflow.run.start',
          target: `workflow-run:${id}`,
          outcome: 'success',
          metadata: {
            project: runProject,
            workflow: d.id,
            name: d.name,
            version: d.version,
            nodes: def.nodes.length,
            ...(attachment === null ? {} : { ownerProject: d.project, attachment: attachment.id }),
            ...(workspace
              ? {
                  workspace: true,
                  files: files.length,
                  fileBytes: files.reduce((n, f) => n + f.ref.sizeBytes, 0),
                  continueFrom: files.find((f) => f.sourceJobId !== null)?.sourceJobId ?? null,
                }
              : files.length > 0
                ? {
                    // p19-repo-inputs-composer-workflows: run files of a repository run (counts, never names).
                    files: files.length,
                    fileBytes: files.reduce((n, f) => n + f.ref.sizeBytes, 0),
                    continueFrom: files.find((f) => f.sourceJobId !== null)?.sourceJobId ?? null,
                  }
                : {}),
          },
        },
        tx,
      );
      return id;
    });
    // Jobs: created as drafts, dependencies recorded, then submitted (and blocked unless ready).
    const jobOf = new Map<string, string>();
    for (const nodeId of order) {
      const job = await this.#createNodeJob(runId, nodeId, actor, 1);
      jobOf.set(nodeId, job);
    }
    for (const e of def.edges) {
      const a = jobOf.get(e.to);
      const b = jobOf.get(e.from);
      if (a !== undefined && b !== undefined) await this.deps.jobs.addDependency(a, b, ENGINE);
    }
    for (const nodeId of order) {
      const jobId = jobOf.get(nodeId);
      if (jobId === undefined) continue;
      await this.deps.jobs.transition(jobId, 'submit', { actor: { type: actor.type, id: actor.id } });
      await this.#block(jobId, 'waiting for upstream nodes');
    }
    await this.deps.pool.query(
      `UPDATE workflow_runs SET state = 'running', updated_at = $2 WHERE id = $1 AND state = 'starting'`,
      [runId, this.deps.clock()],
    );
    await this.#withRunLock(runId, () => this.#progressRun(runId));
    return runId;
  }

  #specIssues(def: WorkflowDefinition, project: string, repository: RunRepository): GraphIssue[] {
    const inputs = Object.fromEntries(Object.keys(def.inputs).map((k) => [k, 'x']));
    const runId = '00000000-0000-4000-8000-000000000000';
    const issues: GraphIssue[] = [];
    def.nodes.forEach((node, idx) => {
      const spec = this.#nodeSpec(def, node, { runId, inputs, repository, project });
      const parsed = JobSpec.safeParse(repository === null ? { ...spec, workspace: WORKSPACE_PROBE } : spec);
      if (!parsed.success) {
        for (const i of parsed.error.issues.slice(0, 5))
          issues.push({ path: `nodes.${String(idx)}.${i.path.map(String).join('.')}`, code: i.code });
      }
    });
    return issues;
  }

  #checkSpecs(def: WorkflowDefinition, project: string, repository: RunRepository): void {
    const issues = this.#specIssues(def, project, repository);
    if (issues.length > 0) {
      throw new WorkflowError(
        400,
        'invalid_workflow',
        `invalid workflow: ${issues.map((i) => `${i.path}:${i.code}`).join(', ')}`.slice(0, 1000),
        issues,
      );
    }
  }

  /** p6-smart-routing: routed runtimes of the steps that name none (failures fall back to the definition default). */
  async #routedRuntimes(def: WorkflowDefinition, project: string): Promise<ReadonlyMap<string, RuntimeKind>> {
    const out = new Map<string, RuntimeKind>();
    const route = this.deps.routeRuntime;
    if (route === undefined) return out;
    const byRole = new Map<JobRole, RuntimeKind | null>();
    for (const node of def.nodes) {
      const role = WORKFLOW_STEP_KIND[node.role];
      if (node.runtime !== undefined || role === undefined) continue;
      if (!byRole.has(role)) {
        try {
          byRole.set(role, await route(project, role));
        } catch (err) {
          this.deps.log.warn({ err, project, role }, 'runtime routing failed; using the definition default');
          byRole.set(role, null);
        }
      }
      const r = byRole.get(role);
      if (r !== null && r !== undefined) out.set(node.id, r);
    }
    return out;
  }

  #nodeSpec(
    def: WorkflowDefinition,
    node: WorkflowNodeBody,
    ctx: {
      runId: string;
      inputs: Record<string, string>;
      repository: RunRepository;
      project: string;
      routed?: ReadonlyMap<string, RuntimeKind>;
      /** p8-orchestration: runtimes a planner step may assign to its tasks (named in its instructions). */
      planRuntimes?: readonly RuntimeKind[];
    },
  ): JobSpec {
    return stepSpec(def, node, ctx);
  }

  /** Creates the node's job (DRAFT) and records it; returns the job id. */
  async #createNodeJob(
    runId: string,
    nodeId: string,
    actor: WorkflowActor,
    attempt: number,
  ): Promise<string> {
    const { rows } = await this.deps.pool.query<{
      job_spec: JobSpec;
      project: string;
      repository: RunRepository;
      priority: number;
    }>(
      `SELECT n.job_spec, r.project, r.repository, r.priority FROM workflow_nodes n JOIN workflow_runs r ON r.id = n.run_id
        WHERE n.run_id = $1 AND n.node_id = $2`,
      [runId, nodeId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`node ${nodeId} of run ${runId} not found`);
    // p5-research-workspace-next: a workspace step starts with the run's files (upstream files come when it is
    // released). Specs stored before a run file existed carry no `workspace`; the store fills it.
    // p19-repo-inputs-composer-workflows: a repository run's step gets them too (`spec.repository.inputs`, filled by
    // the store; a scratch in/ next to the checkout).
    const files =
      this.deps.workspaces !== undefined
        ? combineInputs(await this.deps.workspaces.runFileInputs(runId)).inputs
        : [];
    const { workspace: _w, ...spec } = row.job_spec;
    const { job } = await this.deps.jobs.create({
      project: row.project,
      spec: row.repository === null ? spec : row.job_spec,
      // p9-queue-priority: every step runs in the run's class.
      priority: row.priority,
      actor: { type: actor.type, id: actor.id },
      ...(files.length > 0 ? { inputs: files } : {}),
      // p6-result-reuse: steps of different runs match (the run id in the prompt is masked).
      promptDigest: workflowStepPromptDigest(row.job_spec.prompt, runId),
      // p16-workflow-quality: a run without a repository in a repository project runs its steps in scratch dirs.
      ...(row.repository === null ? { scratch: true } : {}),
    });
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `INSERT INTO workflow_node_jobs (job_id, run_id, node_id, attempt, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [job.id, runId, nodeId, attempt, this.deps.clock()],
      );
      await tx.query(
        `UPDATE workflow_nodes SET job_id = $3, attempts = $4, updated_at = $5 WHERE run_id = $1 AND node_id = $2`,
        [runId, nodeId, job.id, attempt, this.deps.clock()],
      );
    });
    return job.id;
  }

  /** QUEUED → BLOCKED (benign when it already moved on). */
  async #block(jobId: string, reason: string): Promise<void> {
    try {
      await this.deps.jobs.transition(jobId, 'dependency_blocked', { actor: ENGINE, reason });
    } catch (err) {
      if (!(err instanceof JobStoreError)) throw err;
    }
  }

  async #transition(
    jobId: string,
    trigger: 'dependency_unblocked' | 'dependency_failed' | 'cancel_requested',
    reason: string,
  ): Promise<JobRecord | null> {
    for (let i = 0; i < 3; i++) {
      try {
        const { job } = await this.deps.jobs.transition(jobId, trigger, {
          actor: ENGINE,
          reason: reason.slice(0, 1000),
        });
        return job;
      } catch (err) {
        if (err instanceof VersionConflictError) continue;
        if (err instanceof IllegalTransitionError) return null;
        throw err;
      }
    }
    return null;
  }

  // ===================================================================================== view

  async runView(runId: string): Promise<RunView | null> {
    const run = await this.#run(this.deps.pool, runId);
    if (run === null) return null;
    if (run.engine === 2) return this.#runViewV2(runId);
    const { rows } = await this.deps.pool.query<
      NodeRow & { worker_id: string | null; worker_name: string | null }
    >(
      `SELECT n.*, j.state::text AS job_state, j.project AS job_project, a.worker_id, w.display_name AS worker_name
         FROM workflow_nodes n LEFT JOIN jobs j ON j.id = n.job_id
         LEFT JOIN job_attempts a ON a.id = j.current_attempt_id
         LEFT JOIN workers w ON w.id = a.worker_id
        WHERE n.run_id = $1 ORDER BY n.created_at, n.node_id`,
      [runId],
    );
    const edges = await this.#edges(this.deps.pool, runId);
    const mr = await this.deps.pool.query<{
      id: string;
      node_id: string;
      status: string;
      branches: string[];
      external_ref: string | null;
      created_at: Date;
    }>(
      'SELECT id, node_id, status, branches, external_ref, created_at FROM workflow_merge_requests WHERE run_id = $1 ORDER BY created_at',
      [runId],
    );
    return { run, nodes: rows, edges, mergeRequests: mr.rows };
  }

  /** An engine-2 run in the engine-1 view shape (same API for existing screens; `engine` tells them apart). */
  async #runViewV2(runId: string): Promise<RunView | null> {
    const v = await this.v2.view(runId);
    if (v === null) return null;
    return {
      run: {
        ...v.run,
        state: v.run.public_state as RunState,
        // 14.4: the raw engine-2 state and, while queued, the place in the concurrency queue.
        engine_state: v.run.state,
        queue_position: v.run.state === 'queued' ? await queuePosition(this.deps.pool, runId) : null,
      },
      nodes: v.nodes.map((n) => {
        const ai = 'role' in n.input && 'spec' in n.input ? n.input : null;
        const out = n.output;
        return {
          run_id: n.run_id,
          node_id: n.node_id,
          role: ai?.role ?? null,
          def: ai?.def ?? null,
          job_spec: ai?.spec ?? null,
          state: n.public_state as NodeState,
          job_id: n.job_id,
          attempts: n.attempts,
          outputs: ai !== null && out !== null && !('ports' in out) ? out : null,
          upstream_snapshot: ai?.snapshot ?? null,
          gate_role: n.gate_role,
          gate_decision: n.gate_decision,
          gate_decided_by: n.gate_decided_by,
          gate_decided_at: n.gate_decided_at,
          parent_node: ai?.parent ?? null,
          reason: n.reason,
          reused_job_id: ai?.reusedJobId ?? null,
          placement: ai?.placement ?? null,
          job_state: n.job_state,
          job_project: null,
          worker_id: n.worker_id,
          worker_name: n.worker_name,
          node_run_id: n.id,
          node_run_state: n.state,
          node_type: n.node_type,
          scope: n.scope,
          wait_kind: n.wait_kind,
          due_at: n.due_at,
          output_port: n.output_port,
          error: n.error,
          iterations: n.iterations,
          copied_from: n.copied_from,
        };
      }),
      edges: v.edges,
      mergeRequests: v.mergeRequests,
      outputs: v.run.outputs ?? null,
      sideEffects: v.sideEffects,
    };
  }

  async #run(db: Queryable, runId: string): Promise<RunRow | null> {
    const { rows } = await db.query<RunRow>('SELECT * FROM workflow_runs WHERE id = $1', [runId]);
    return rows[0] ?? null;
  }

  async #edges(db: Queryable, runId: string): Promise<WorkflowEdge[]> {
    const { rows } = await db.query<{ from_node: string; to_node: string }>(
      'SELECT from_node, to_node FROM workflow_edges WHERE run_id = $1 ORDER BY from_node, to_node',
      [runId],
    );
    return rows.map((r) => ({ from: r.from_node, to: r.to_node }));
  }

  async #nodes(runId: string): Promise<NodeRow[]> {
    const { rows } = await this.deps.pool.query<NodeRow>(
      `SELECT n.*, j.state::text AS job_state, j.project AS job_project
         FROM workflow_nodes n LEFT JOIN jobs j ON j.id = n.job_id WHERE n.run_id = $1`,
      [runId],
    );
    return rows;
  }

  // ===================================================================================== admission

  /**
   * Dependency-aware dispatch (under the dispatch lock): a workflow job is dispatched only while its node
   * is `queued` (all upstreams succeeded, gate passed); a plain job only when every `job_dependencies`
   * upstream SUCCEEDED (a failed/cancelled upstream fails it with `dependency_failed`). Anything else is
   * moved to BLOCKED and skipped.
   */
  async admit(job: JobRecord): Promise<AdmissionVerdict> {
    const node = await this.deps.pool.query<{ state: NodeState }>(
      `SELECT n.state FROM workflow_node_jobs wj JOIN workflow_nodes n ON n.run_id = wj.run_id AND n.node_id = wj.node_id
        WHERE wj.job_id = $1 AND n.job_id = $1`,
      [job.id],
    );
    const ns = node.rows[0]?.state;
    if (ns !== undefined) {
      if (ns === 'queued') return { kind: 'admit' };
      await this.#block(job.id, 'workflow node is not ready');
      return { kind: 'skip' };
    }
    // p14-workflow-engine: an engine-2 job runs only while its node run is running.
    const v2 = await this.v2.admit(job);
    if (v2 !== null) return v2;
    const deps = await this.#upstreamStates(job.id);
    if (deps.length === 0) return { kind: 'admit' };
    const failed = deps.find((d) => d.state === 'FAILED' || d.state === 'CANCELLED');
    if (failed !== undefined) {
      await this.#block(job.id, 'upstream dependency did not succeed');
      await this.#transition(job.id, 'dependency_failed', `upstream job ${failed.id} is ${failed.state}`);
      return { kind: 'skip' };
    }
    if (deps.every((d) => d.state === 'SUCCEEDED')) return { kind: 'admit' };
    await this.#block(
      job.id,
      `waiting for ${String(deps.filter((d) => d.state !== 'SUCCEEDED').length)} upstream job(s)`,
    );
    return { kind: 'skip' };
  }

  async #upstreamStates(jobId: string): Promise<{ id: string; state: string }[]> {
    const { rows } = await this.deps.pool.query<{ id: string; state: string }>(
      `SELECT j.id, j.state::text AS state FROM job_dependencies d JOIN jobs j ON j.id = d.depends_on_job_id
        WHERE d.job_id = $1`,
      [jobId],
    );
    return rows;
  }

  /** Plain (non-workflow) BLOCKED jobs: unblock when every upstream succeeded, fail when one did not. */
  async #plainDependencies(): Promise<void> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT j.id FROM jobs j
        WHERE j.state = 'BLOCKED' AND NOT EXISTS (SELECT 1 FROM workflow_job_links wj WHERE wj.job_id = j.id)
        ORDER BY j.state_changed_at LIMIT 200`,
    );
    for (const r of rows) {
      const deps = await this.#upstreamStates(r.id);
      const failed = deps.find((d) => d.state === 'FAILED' || d.state === 'CANCELLED');
      if (failed !== undefined) {
        await this.#transition(r.id, 'dependency_failed', `upstream job ${failed.id} is ${failed.state}`);
      } else if (deps.every((d) => d.state === 'SUCCEEDED')) {
        await this.#transition(r.id, 'dependency_unblocked', 'all upstream jobs succeeded');
      }
    }
  }

  // ===================================================================================== progress

  steps(): readonly TickStep[] {
    return [
      { name: 'workflows', run: () => this.progress() },
      { name: 'job-dependencies', run: () => this.#plainDependencies() },
      // p14-workflow-engine 14.4: retention of finished engine-2 runs' data (throttled to every 10 minutes).
      { name: 'workflow-retention', run: () => this.v2.pruneData().then(() => undefined) },
    ];
  }

  /** One pass over every open run of both engines (serialised per run with an advisory lock). */
  async progress(): Promise<void> {
    await this.#progressV1();
    await this.v2.progress();
  }

  async #progressV1(): Promise<void> {
    const { rows } = await this.deps.pool.query<{ id: string; state: RunState; updated_at: Date }>(
      `SELECT id, state, updated_at FROM workflow_runs WHERE state = ANY($1::text[]) ORDER BY created_at LIMIT 100`,
      [RUN_OPEN],
    );
    const now = this.deps.clock();
    for (const r of rows) {
      try {
        if (r.state === 'starting') {
          // Instantiation interrupted (crash between job creation steps): abandon after a minute.
          if (now.getTime() - r.updated_at.getTime() > 60_000) {
            await this.#withRunLock(r.id, () => this.#abort(r.id, 'failed', 'instantiation was interrupted'));
          }
          continue;
        }
        await this.#withRunLock(r.id, () => this.#progressRun(r.id));
      } catch (err) {
        this.deps.log.error({ err, runId: r.id }, 'workflow progress failed');
      }
    }
  }

  async #withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`wf:${runId}`]);
      try {
        return await fn();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`wf:${runId}`]);
      }
    } finally {
      client.release();
    }
  }

  async #setNode(
    runId: string,
    nodeId: string,
    patch: { state?: NodeState; outputs?: NodeOutputs; snapshot?: UpstreamValue[]; reason?: string | null },
  ): Promise<void> {
    await this.deps.pool.query(
      `UPDATE workflow_nodes
          SET state = COALESCE($3, state),
              outputs = COALESCE($4, outputs),
              upstream_snapshot = COALESCE($5, upstream_snapshot),
              reason = CASE WHEN $6::boolean THEN $7 ELSE reason END,
              updated_at = $8
        WHERE run_id = $1 AND node_id = $2`,
      [
        runId,
        nodeId,
        patch.state ?? null,
        patch.outputs === undefined ? null : JSON.stringify(patch.outputs),
        patch.snapshot === undefined ? null : JSON.stringify(patch.snapshot),
        patch.reason !== undefined,
        patch.reason === undefined || patch.reason === null ? null : clip(patch.reason, 1000),
        this.deps.clock(),
      ],
    );
  }

  async #progressRun(runId: string): Promise<void> {
    const run = await this.#run(this.deps.pool, runId);
    if (run === null || !RUN_OPEN.includes(run.state) || run.state === 'starting') return;
    if (run.state === 'awaiting_merge') {
      await this.#checkMerges(run);
      return;
    }
    // Repeat until nothing changes (a success may unblock the next node in the same pass).
    for (let pass = 0; pass < 10; pass++) {
      const changed = await this.#step(run);
      if (!changed) break;
    }
    await this.#maybeFinish(run);
  }

  /** One evaluation of every node; true when something changed. */
  async #step(run: RunRow): Promise<boolean> {
    const nodes = await this.#nodes(run.id);
    const edges = await this.#edges(this.deps.pool, run.id);
    const byId = new Map(nodes.map((n) => [n.node_id, n]));
    const graph = { nodes: nodes.map((n) => n.def), edges };
    const upstream = (id: string): string[] => edges.filter((e) => e.to === id).map((e) => e.from);
    let changed = false;
    for (const id of topoOrder(graph) ?? nodes.map((n) => n.node_id)) {
      const n = byId.get(id);
      if (n === undefined) continue;
      if (n.state === 'pending' || n.state === 'awaiting_approval') {
        const ups = upstream(id).map((u) => byId.get(u));
        if (!ups.every((u) => u?.state === 'succeeded')) continue;
        if (n.gate_role !== null && n.gate_decision !== 'approved') {
          if (n.state === 'pending') {
            await this.#setNode(run.id, id, {
              state: 'awaiting_approval',
              reason: `waiting for ${n.gate_role} approval`,
            });
            await this.deps.audit.record({
              actor: ENGINE,
              action: 'workflow.gate.request',
              target: `workflow-run:${run.id}`,
              outcome: 'success',
              metadata: { node: id, approverRole: n.gate_role, project: run.project },
            });
            changed = true;
          }
          continue;
        }
        // p11-merge-pipeline (ADR-0041): the master integrates the upstream branches itself (no integrator agent).
        if (
          n.role === 'integrator' &&
          run.repository !== null &&
          this.merge.masterIntegration !== undefined
        ) {
          if (await this.#masterIntegrate(run, n, graph, byId)) {
            changed = true;
            continue;
          }
        }
        // Ready: freeze the upstream outputs this node receives, then release its job.
        const snapshot = this.#snapshot(n, graph, byId);
        // p5-research-workspace-next: a workspace step also gets its upstream steps' files as inputs.
        const handed = await this.#handUpstreamFiles(run, n, upstream(id), byId);
        if (handed.failed !== null) {
          await this.#setNode(run.id, id, { snapshot });
          await this.#stopNodeJob(n, 'dependency_failed', handed.failed);
          await this.#failed(run, n, graph, handed.failed, { noRetry: true });
          changed = true;
          continue;
        }
        // p6-result-reuse: a root step with the opt-in policy takes an identical earlier result instead of running.
        const reused = upstream(id).length === 0 ? await this.#reuseStep(run, n) : null;
        if (reused !== null) {
          await this.#setNode(run.id, id, {
            state: 'queued',
            snapshot,
            reason: `Reused the result of identical job ${reused.match.jobId} (succeeded ${reused.match.age}; step policy: within ${String(reused.hours)} h).`,
          });
          await this.deps.pool.query(
            'UPDATE workflow_nodes SET job_id = $3, reused_job_id = $3 WHERE run_id = $1 AND node_id = $2',
            [run.id, id, reused.match.jobId],
          );
          await this.deps.audit.record({
            actor: ENGINE,
            action: 'workflow.step.reuse',
            target: `workflow-run:${run.id}`,
            outcome: 'success',
            metadata: {
              node: id,
              project: run.project,
              reusedJobId: reused.match.jobId,
              cancelledJobId: n.job_id,
              withinHours: reused.hours,
            },
          });
          n.state = 'queued';
          changed = true;
          continue;
        }
        await this.#setNode(run.id, id, { state: 'queued', snapshot, reason: handed.note });
        if (n.job_id !== null && n.job_state === 'BLOCKED') {
          await this.#transition(n.job_id, 'dependency_unblocked', 'workflow upstream nodes succeeded');
        }
        n.state = 'queued';
        changed = true;
        continue;
      }
      if (n.state !== 'queued' || n.job_id === null || n.job_state === null) continue;
      if (n.job_state === 'SUCCEEDED') {
        await this.#succeeded(run, n, graph);
        changed = true;
      } else if (n.job_state === 'AWAITING_APPROVAL' && this.merge.verifiedChange !== undefined) {
        // p4-git-flow: verified changes wait for a merge decision; the node's work is done (integrators
        // then open the protected merge request, everything else feeds its branch downstream).
        const verified = await this.merge.verifiedChange(n.job_id);
        if (verified !== null) {
          await this.#succeeded(run, n, graph, verified.branch);
          changed = true;
        }
      } else if (n.job_state === 'FAILED' || n.job_state === 'CANCELLED') {
        await this.#failed(run, n, graph, `job ${n.job_id} ${n.job_state.toLowerCase()}`);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * p6-result-reuse: when the step opted in (node or definition default) and an identical job of the project
   * succeeded within the window, cancels the step's own (still blocked) job and returns the match. Integrators,
   * dynamic planners, deploy and site-bundle steps always run; so does any step whose own job cannot be cancelled.
   */
  async #reuseStep(run: RunRow, n: NodeRow): Promise<{ match: ReuseMatch; hours: number } | null> {
    const reuse = this.deps.reuse;
    if (reuse === undefined || n.job_id === null || n.job_state !== 'BLOCKED') return null;
    const { rows } = await this.deps.pool.query<{ definition: WorkflowDefinition }>(
      'SELECT definition FROM workflow_definitions WHERE id = $1',
      [run.definition_id],
    );
    const def = rows[0]?.definition;
    const node = def?.nodes.find((x) => x.id === n.node_id);
    if (def === undefined || node === undefined) return null;
    const hours = node.reuseWithinHours ?? def.defaults.reuseWithinHours;
    if (hours === undefined) return null;
    if (
      node.role === 'integrator' ||
      node.dynamic !== undefined ||
      node.deploy !== undefined ||
      node.siteBundle !== undefined
    ) {
      return null;
    }
    const own = await this.deps.jobs.get(n.job_id);
    if (own === null) return null;
    const verdict = await reuse.find({
      project: run.project,
      spec: own.spec,
      // p19-repo-inputs-composer-workflows: a repository step with run files is never reused (not_eligible).
      inputs: (own.spec.workspace?.inputs ?? own.spec.repository?.inputs ?? []).map((i) => ({
        name: i.name,
        sha256: i.sha256,
      })),
      withinHours: hours,
      promptDigest: workflowStepPromptDigest(own.spec.prompt, run.id),
      excludeJobIds: [own.id],
    });
    if (verdict.kind !== 'match') return null;
    const cancelled = await this.#transition(
      own.id,
      'cancel_requested',
      `workflow step reused the result of identical job ${verdict.jobId}`,
    );
    if (cancelled === null) return null;
    return { match: verdict, hours };
  }

  /**
   * Workspace runs (p5-research-workspace-next): copies the artifacts of the direct upstream steps into the step's
   * job as inputs (`<node>-<file>`). Returns a note naming what did not fit the per-job limits, or the reason the
   * step cannot start (storage quota).
   */
  async #handUpstreamFiles(
    run: RunRow,
    n: NodeRow,
    upstreamIds: readonly string[],
    byId: ReadonlyMap<string, NodeRow>,
  ): Promise<{ note: string | null; failed: string | null }> {
    const ws = this.deps.workspaces;
    if (run.repository !== null || ws === undefined || n.job_id === null) return { note: null, failed: null };
    const sources = upstreamIds
      .map((u) => ({ node: u, jobId: byId.get(u)?.outputs?.jobId ?? byId.get(u)?.job_id ?? '' }))
      .filter((s) => s.jobId !== '');
    if (sources.length === 0) return { note: null, failed: null };
    try {
      const r = await ws.attachUpstream(n.job_id, run.project, sources);
      return {
        note:
          r.dropped.length === 0
            ? null
            : clip(
                `${String(r.dropped.length)} upstream file(s) not handed over (input limits): ${r.dropped.join(', ')}`,
                1000,
              ),
        failed: null,
      };
    } catch (err) {
      if (err instanceof StorageQuotaError) return { note: null, failed: err.publicMessage };
      throw err;
    }
  }

  /**
   * p11-merge-pipeline (ADR-0041): hands an integrator step to master-managed integration when the project uses it —
   * every ancestor step's verified branch, in dependency order — and cancels the step's own (still blocked) agent job.
   * The step waits in `awaiting_merge` until the integration's one PR / protected merge landed. False: not used (the
   * integrator agent runs as before).
   */
  async #masterIntegrate(
    run: RunRow,
    n: NodeRow,
    graph: { nodes: WorkflowNodeDef[]; edges: WorkflowEdge[] },
    byId: Map<string, NodeRow>,
  ): Promise<boolean> {
    if (this.merge.masterIntegration === undefined || run.repository === null) return false;
    const ancestors = new Set<string>();
    const walk = (id: string): void => {
      for (const e of graph.edges) {
        if (e.to === id && !ancestors.has(e.from)) {
          ancestors.add(e.from);
          walk(e.from);
        }
      }
    };
    walk(n.node_id);
    const members = [...ancestors].flatMap((id) => {
      const u = byId.get(id);
      if (u?.job_id === null || u?.job_id === undefined) return [];
      const title = u.def.prompt.split('\n', 1)[0] ?? '';
      return [
        {
          nodeId: id,
          jobId: u.job_id,
          title: `${id}: ${title}`.slice(0, 200),
          after: graph.edges.filter((e) => e.to === id && ancestors.has(e.from)).map((e) => e.from),
        },
      ];
    });
    const res = await this.merge.masterIntegration({
      runId: run.id,
      nodeId: n.node_id,
      project: run.project,
      repository: run.repository,
      createdBy: run.created_by,
      members,
    });
    if (res === null) return false;
    await this.#stopNodeJob(
      n,
      'cancel_requested',
      'integrated by the master (p11-merge-pipeline): no integrator agent',
    );
    const outputs: NodeOutputs = {
      summary: res.note,
      branch: res.branch,
      commits: [],
      jobId: n.job_id ?? '',
      attemptId: null,
    };
    await this.deps.pool.query(
      `INSERT INTO workflow_merge_requests (run_id, node_id, job_id, project, repository_url, base_ref, branches,
                                            status, external_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        run.id,
        n.node_id,
        n.job_id,
        run.project,
        run.repository.url,
        run.repository.baseRef,
        JSON.stringify(members.map((m) => byId.get(m.nodeId)?.outputs?.branch ?? m.nodeId)),
        res.status,
        res.externalRef,
        this.deps.clock(),
      ],
    );
    await this.deps.audit.record({
      actor: ENGINE,
      action: 'workflow.merge.request',
      target: `workflow-run:${run.id}`,
      outcome: res.status === 'refused' ? 'failure' : 'success',
      metadata: {
        node: n.node_id,
        branches: members.length,
        status: res.status,
        project: run.project,
        mode: 'master-integration',
      },
    });
    if (res.status === 'refused') {
      await this.#setNode(run.id, n.node_id, { outputs });
      await this.#failed(run, n, graph, res.note, { noRetry: true });
      return true;
    }
    await this.#setNode(run.id, n.node_id, {
      state: res.status === 'merged' ? 'succeeded' : 'awaiting_merge',
      outputs,
      reason: res.status === 'merged' ? null : res.note,
    });
    return true;
  }

  /** Direct upstream outputs (summary + branch) plus template-referenced ancestors, frozen for this node. */
  #snapshot(
    n: NodeRow,
    graph: { nodes: WorkflowNodeDef[]; edges: WorkflowEdge[] },
    byId: Map<string, NodeRow>,
  ): UpstreamValue[] {
    const direct = graph.edges.filter((e) => e.to === n.node_id).map((e) => e.from);
    const { refs } = renderPrompt(n.def.prompt, { inputs: {}, runId: '', nodeId: n.node_id });
    const wanted: { node: string; field: 'summary' | 'branch' }[] = [];
    for (const u of direct.sort()) {
      wanted.push({ node: u, field: 'summary' });
      // Workspace steps have no branch (p5-research-workspace-next).
      if (byId.get(u)?.outputs?.branch !== '') wanted.push({ node: u, field: 'branch' });
    }
    for (const r of refs) if (!wanted.some((w) => w.node === r.node && w.field === r.field)) wanted.push(r);
    // Bound the block: at most 64 KiB of upstream text however many upstreams there are.
    const per = Math.max(
      256,
      Math.min(WORKFLOW_LIMITS.maxOutputChars, Math.floor((64 * 1024) / Math.max(wanted.length, 1))),
    );
    const out: UpstreamValue[] = [];
    for (const w of wanted) {
      const o = byId.get(w.node)?.outputs;
      if (o === null || o === undefined) continue;
      out.push({
        node: w.node,
        field: w.field,
        value: clip(w.field === 'summary' ? o.summary : o.branch, per),
      });
    }
    return out;
  }

  async #outputs(n: NodeRow): Promise<NodeOutputs> {
    return readJobOutputs(this.deps.pool, n.job_id, n.job_spec);
  }

  async #succeeded(
    run: RunRow,
    n: NodeRow,
    graph: { nodes: WorkflowNodeDef[]; edges: WorkflowEdge[] },
    verifiedBranch?: string,
  ): Promise<void> {
    const raw = await this.#outputs(n);
    const outputs = verifiedBranch === undefined ? raw : { ...raw, branch: verifiedBranch };
    if (n.def.dynamic !== undefined) {
      const plan = parsePlan((await this.#rawSummary(n.job_id ?? '')) ?? '');
      if (!plan.ok) {
        await this.#setNode(run.id, n.node_id, { outputs });
        await this.#failed(run, n, graph, `planner produced no valid plan (${plan.code})`);
        return;
      }
      const exp = expandPlan(n.def, plan.tasks);
      // p8-orchestration: the planner's runtime / model / capability / machine hints, against the allowlist.
      const resolved = exp.ok
        ? await resolvePlanTasks(this.deps.pool, {
            project: run.project,
            def: await this.#definitionOf(run),
            planner: n.job_spec,
            tasks: plan.tasks,
            routeRuntime: this.deps.routeRuntime,
          })
        : null;
      if (resolved !== null && !resolved.ok) {
        await this.#setNode(run.id, n.node_id, { outputs });
        await this.#failed(
          run,
          n,
          graph,
          `planner plan rejected: ${resolved.issues
            .slice(0, 5)
            .map((i) => `${i.path}:${i.code}`)
            .join(', ')} (runtimes allowed for planned tasks: ${resolved.allowed.join(', ')})`,
        );
        return;
      }
      if (!exp.ok) {
        await this.#setNode(run.id, n.node_id, { outputs });
        await this.#failed(
          run,
          n,
          graph,
          `planner plan rejected: ${exp.issues
            .slice(0, 5)
            .map((i) => `${i.path}:${i.code}`)
            .join(', ')}`,
        );
        return;
      }
      await this.#expand(
        run,
        n,
        graph,
        exp.expansion,
        plan.tasks,
        resolved?.ok === true ? resolved.tasks : new Map(),
      );
    }
    if (n.role === 'integrator' && run.repository !== null) {
      const branches = graph.edges
        .filter((e) => e.to === n.node_id)
        .map((e) => e.from)
        .sort();
      const ups = await this.#nodes(run.id);
      const refs = [
        ...ups
          .filter((u) => branches.includes(u.node_id) && u.outputs !== null)
          .map((u) => (u.outputs as NodeOutputs).branch),
        outputs.branch,
      ];
      const res = await this.merge.requestMerge({
        runId: run.id,
        nodeId: n.node_id,
        jobId: n.job_id ?? '',
        project: run.project,
        repository: run.repository,
        branches: refs,
        integrationBranch: outputs.branch,
      });
      await this.deps.pool.query(
        `INSERT INTO workflow_merge_requests (run_id, node_id, job_id, project, repository_url, base_ref, branches,
                                              status, external_ref, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [
          run.id,
          n.node_id,
          n.job_id,
          run.project,
          run.repository.url,
          run.repository.baseRef,
          JSON.stringify(refs),
          res.status,
          res.externalRef,
          this.deps.clock(),
        ],
      );
      await this.deps.audit.record({
        actor: ENGINE,
        action: 'workflow.merge.request',
        target: `workflow-run:${run.id}`,
        outcome: 'success',
        metadata: { node: n.node_id, branches: refs.length, status: res.status, project: run.project },
      });
      if (res.status === 'refused') {
        await this.#setNode(run.id, n.node_id, { outputs });
        await this.#failed(run, n, graph, 'the merge request was refused');
        return;
      }
      await this.#setNode(run.id, n.node_id, {
        state: res.status === 'merged' ? 'succeeded' : 'awaiting_merge',
        outputs,
        reason: res.status === 'merged' ? null : 'waiting for the git flow merge approval',
      });
      if (res.status === 'merged') await this.#deployStep(run, n.node_id, n.job_id);
      return;
    }
    await this.#setNode(run.id, n.node_id, { state: 'succeeded', outputs, reason: null });
    await this.#deployStep(run, n.node_id, n.job_id);
  }

  /**
   * p6-deploy-pipeline (ADR-0028): the node's deploy step, if its definition has one — requested once (idempotent per
   * run and node) after the node succeeded (verifier) or its merge landed (integrator). The run does not wait for the
   * deployment; the ops action carries its own policy, approval, status and notifications.
   */
  async #deployStep(run: RunRow, nodeId: string, jobId: string | null): Promise<void> {
    const { rows } = await this.deps.pool.query<{
      definition: { nodes?: { id: string; deploy?: unknown }[] };
    }>('SELECT definition FROM workflow_definitions WHERE id = $1', [run.definition_id]);
    const step = rows[0]?.definition.nodes?.find((x) => x.id === nodeId)?.deploy as
      { kind: string; env?: string; force?: boolean; branch?: string } | undefined;
    if (step === undefined) return;
    const port = this.deps.deploy?.() ?? null;
    let outcome: Record<string, unknown>;
    try {
      const res =
        port === null
          ? { refused: 'deploy integrations are not available' }
          : await port.request({
              runId: run.id,
              nodeId,
              project: run.project,
              createdBy: run.created_by,
              jobId,
              step,
            });
      outcome = 'refused' in res ? { refused: res.refused } : { actionId: res.actionId, state: res.state };
    } catch (err) {
      outcome = { error: err instanceof Error ? err.message.slice(0, 300) : 'request failed' };
    }
    await this.deps.audit.record({
      actor: ENGINE,
      action: 'workflow.deploy.request',
      target: `workflow-run:${run.id}`,
      outcome: 'actionId' in outcome ? 'success' : 'failure',
      metadata: { node: nodeId, project: run.project, kind: step.kind, env: step.env ?? null, ...outcome },
    });
  }

  async #definitionOf(run: RunRow): Promise<WorkflowDefinition> {
    const { rows } = await this.deps.pool.query<{ definition: WorkflowDefinition }>(
      'SELECT definition FROM workflow_definitions WHERE id = $1',
      [run.definition_id],
    );
    const def = rows[0]?.definition;
    if (def === undefined) throw new Error(`definition of run ${run.id} not found`);
    return def;
  }

  async #rawSummary(jobId: string): Promise<string | null> {
    return rawSummary(this.deps.pool, jobId);
  }

  /**
   * Inserts a planner's sub-DAG: nodes `<planner>.<task>` (executor/verifier, the planner's job settings,
   * the task prompt labelled as planner-written), edges planner → roots and task-local edges, and makes the
   * planner's static downstream nodes depend on the sub-DAG's sinks (`job_dependencies` too).
   */
  async #expand(
    run: RunRow,
    planner: NodeRow,
    graph: { nodes: WorkflowNodeDef[]; edges: WorkflowEdge[] },
    exp: { nodes: readonly WorkflowNodeDef[]; edges: readonly WorkflowEdge[]; sinks: readonly string[] },
    tasks: readonly { id: string; title: string }[],
    resolved: ReadonlyMap<string, ResolvedTask>,
  ): Promise<void> {
    const downstream = graph.edges.filter((e) => e.from === planner.node_id).map((e) => e.to);
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      for (const node of exp.nodes) {
        const task = tasks.find((t) => `${planner.node_id}.${t.id}` === node.id);
        const hint = task === undefined ? undefined : resolved.get(task.id);
        const spec = plannedTaskSpec(
          { nodeId: planner.node_id, spec: planner.job_spec },
          { id: run.id, name: run.name },
          node,
          task,
          hint,
        );
        const placement: StepPlacement = hint?.placement ?? {
          runtime: spec.runtime,
          source: 'planner',
          notes: ['the planner step’s runtime'],
        };
        await tx.query(
          `INSERT INTO workflow_nodes (run_id, node_id, role, def, job_spec, state, parent_node, placement, created_at,
                                       updated_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $8)`,
          [
            run.id,
            node.id,
            node.role,
            JSON.stringify(node),
            JSON.stringify(spec),
            planner.node_id,
            JSON.stringify(placement),
            now,
          ],
        );
      }
      for (const e of exp.edges) {
        await tx.query('INSERT INTO workflow_edges (run_id, from_node, to_node) VALUES ($1, $2, $3)', [
          run.id,
          e.from,
          e.to,
        ]);
      }
      for (const d of downstream) {
        for (const s of exp.sinks) {
          await tx.query('INSERT INTO workflow_edges (run_id, from_node, to_node) VALUES ($1, $2, $3)', [
            run.id,
            s,
            d,
          ]);
        }
      }
      await this.deps.audit.record(
        {
          actor: ENGINE,
          action: 'workflow.plan.expand',
          target: `workflow-run:${run.id}`,
          outcome: 'success',
          metadata: {
            planner: planner.node_id,
            nodes: exp.nodes.length,
            sinks: exp.sinks.length,
            project: run.project,
            // p8-orchestration: what the plan's hints resolved to (runtime + source per task).
            placements: [...resolved.entries()]
              .slice(0, 20)
              .map(([id, r]) => `${id}:${r.placement.runtime}:${r.placement.source}`),
          },
        },
        tx,
      );
    });
    const creator = { type: 'user' as const, id: run.created_by };
    const jobOf = new Map<string, string>([[planner.node_id, planner.job_id ?? '']]);
    const nodes = await this.#nodes(run.id);
    for (const d of downstream) {
      const j = nodes.find((x) => x.node_id === d)?.job_id;
      if (j) jobOf.set(d, j);
    }
    for (const node of exp.nodes) jobOf.set(node.id, await this.#createNodeJob(run.id, node.id, creator, 1));
    const allEdges = [...exp.edges, ...downstream.flatMap((d) => exp.sinks.map((s) => ({ from: s, to: d })))];
    for (const e of allEdges) {
      const a = jobOf.get(e.to);
      const b = jobOf.get(e.from);
      if (a && b)
        await this.deps.jobs.addDependency(a, b, ENGINE).catch((err: unknown) => {
          this.deps.log.warn({ err, runId: run.id }, 'dependency not recorded');
        });
    }
    for (const node of exp.nodes) {
      const j = jobOf.get(node.id);
      if (j === undefined) continue;
      await this.deps.jobs.transition(j, 'submit', { actor: creator });
      await this.#block(j, 'waiting for upstream nodes');
    }
  }

  /** Applies the node's failure policy. */
  async #failed(
    run: RunRow,
    n: NodeRow,
    graph: { nodes: WorkflowNodeDef[]; edges: WorkflowEdge[] },
    reason: string,
    opts: { readonly noRetry?: boolean } = {},
  ): Promise<void> {
    const policy = n.def.failurePolicy ?? 'fail-fast';
    const maxRetries = n.def.maxRetries ?? (policy === 'retry-safe' ? 2 : 0);
    if (policy === 'retry-safe' && n.attempts <= maxRetries && opts.noRetry !== true) {
      // Declared retry-safe by the workflow author (idempotent step): a new job for the same node, with
      // the same frozen inputs; downstream jobs get a dependency on it too.
      const jobId = await this.#createNodeJob(
        run.id,
        n.node_id,
        { type: 'user', id: run.created_by },
        n.attempts + 1,
      );
      const ups = graph.edges.filter((e) => e.to === n.node_id).map((e) => e.from);
      const downs = graph.edges.filter((e) => e.from === n.node_id).map((e) => e.to);
      const nodes = await this.#nodes(run.id);
      for (const u of ups) {
        const j = nodes.find((x) => x.node_id === u)?.job_id;
        if (j) await this.deps.jobs.addDependency(jobId, j, ENGINE).catch(() => undefined);
      }
      for (const d of downs) {
        const j = nodes.find((x) => x.node_id === d)?.job_id;
        if (j) await this.deps.jobs.addDependency(j, jobId, ENGINE).catch(() => undefined);
      }
      // A workspace step's retry gets the same upstream files as the first attempt.
      if (run.repository === null) {
        const fresh = nodes.find((x) => x.node_id === n.node_id);
        if (fresh !== undefined) {
          const handed = await this.#handUpstreamFiles(
            run,
            fresh,
            ups,
            new Map(nodes.map((x) => [x.node_id, x])),
          );
          if (handed.failed !== null) {
            await this.#stopNodeJob(fresh, 'cancel_requested', handed.failed);
            await this.#failed(run, fresh, graph, handed.failed, { noRetry: true });
            return;
          }
        }
      }
      await this.deps.jobs.transition(jobId, 'submit', { actor: ENGINE });
      await this.#setNode(run.id, n.node_id, {
        reason: `retry ${String(n.attempts)}/${String(maxRetries)} after: ${reason}`,
      });
      return;
    }
    await this.#setNode(run.id, n.node_id, { state: 'failed', reason });
    const below = descendants(graph, n.node_id);
    const nodes = await this.#nodes(run.id);
    for (const d of nodes) {
      if (!below.has(d.node_id) || !NODE_OPEN.has(d.state)) continue;
      await this.#stopNodeJob(d, 'dependency_failed', `upstream node ${n.node_id} failed`);
      await this.#setNode(run.id, d.node_id, {
        state: 'skipped',
        reason: `upstream node ${n.node_id} failed`,
      });
    }
    if (policy === 'continue') return;
    // fail-fast: the run fails; every other open node is cancelled.
    for (const d of nodes) {
      if (d.node_id === n.node_id || below.has(d.node_id) || !NODE_OPEN.has(d.state)) continue;
      await this.#stopNodeJob(d, 'cancel_requested', `workflow failed fast: node ${n.node_id} failed`);
      await this.#setNode(run.id, d.node_id, {
        state: 'cancelled',
        reason: `node ${n.node_id} failed (fail-fast)`,
      });
    }
    await this.#finishRun(run, 'failed', `node ${n.node_id} failed: ${reason}`);
  }

  /** Stops a node's job: BLOCKED → dependency_failed/cancel; queued/running → cancel (+ CANCEL_JOB). */
  async #stopNodeJob(
    n: NodeRow,
    trigger: 'dependency_failed' | 'cancel_requested',
    reason: string,
  ): Promise<void> {
    if (n.job_id === null) return;
    const job = await this.deps.jobs.get(n.job_id);
    if (job === null || JOB_TERMINAL.has(job.state)) return;
    const t =
      job.state === 'BLOCKED' && trigger === 'dependency_failed' ? 'dependency_failed' : 'cancel_requested';
    const next = await this.#transition(job.id, t, reason);
    if (next?.state === 'CANCELLING') await this.deps.cancel().sendCancel(next, reason);
  }

  async #maybeFinish(run: RunRow): Promise<void> {
    const fresh = await this.#run(this.deps.pool, run.id);
    if (fresh?.state !== 'running') return;
    const nodes = await this.#nodes(run.id);
    if (nodes.some((n) => NODE_OPEN.has(n.state))) return;
    if (nodes.some((n) => n.state === 'failed' || n.state === 'skipped' || n.state === 'cancelled')) {
      const first = nodes.find((n) => n.state === 'failed');
      await this.#finishRun(
        fresh,
        'failed',
        first ? `node ${first.node_id} failed: ${first.reason ?? ''}` : 'nodes did not succeed',
      );
    } else if (nodes.some((n) => n.state === 'awaiting_merge')) {
      await this.deps.pool.query(
        `UPDATE workflow_runs SET state = 'awaiting_merge', updated_at = $2 WHERE id = $1`,
        [run.id, this.deps.clock()],
      );
    } else {
      await this.#finishRun(fresh, 'succeeded', null);
    }
  }

  async #checkMerges(run: RunRow): Promise<void> {
    const { rows } = await this.deps.pool.query<{ id: string; node_id: string; external_ref: string | null }>(
      `SELECT id, node_id, external_ref FROM workflow_merge_requests WHERE run_id = $1 AND status = 'pending'`,
      [run.id],
    );
    for (const r of rows) {
      const status = await this.merge.status({ id: r.id, runId: run.id, externalRef: r.external_ref });
      if (status === 'pending') continue;
      await this.deps.pool.query(
        `UPDATE workflow_merge_requests SET status = $2, updated_at = $3 WHERE id = $1`,
        [r.id, status, this.deps.clock()],
      );
      await this.#setNode(run.id, r.node_id, {
        state: status === 'merged' ? 'succeeded' : 'failed',
        reason: status === 'merged' ? null : 'the merge was refused',
      });
      if (status === 'merged') {
        const jobRow = await this.deps.pool.query<{ job_id: string | null }>(
          'SELECT job_id FROM workflow_nodes WHERE run_id = $1 AND node_id = $2',
          [run.id, r.node_id],
        );
        await this.#deployStep(run, r.node_id, jobRow.rows[0]?.job_id ?? null);
      }
    }
    const nodes = await this.#nodes(run.id);
    if (nodes.some((n) => n.state === 'awaiting_merge')) return;
    await this.#finishRun(
      run,
      nodes.some((n) => n.state === 'failed') ? 'failed' : 'succeeded',
      nodes.some((n) => n.state === 'failed') ? 'the merge was refused' : null,
    );
  }

  async #finishRun(
    run: RunRow,
    state: 'succeeded' | 'failed' | 'cancelled',
    reason: string | null,
  ): Promise<void> {
    const res = await this.deps.pool.query(
      `UPDATE workflow_runs SET state = $2, reason = $3, ended_at = $4, updated_at = $4
        WHERE id = $1 AND state = ANY($5::text[])`,
      [run.id, state, reason === null ? null : clip(reason, 1000), this.deps.clock(), RUN_OPEN],
    );
    if (res.rowCount !== 1) return;
    await this.deps.audit.record({
      actor: ENGINE,
      action: 'workflow.run.finish',
      target: `workflow-run:${run.id}`,
      outcome: 'success',
      metadata: { state, project: run.project },
    });
  }

  async #abort(runId: string, state: 'failed' | 'cancelled', reason: string): Promise<void> {
    const run = await this.#run(this.deps.pool, runId);
    if (run === null || !RUN_OPEN.includes(run.state)) return;
    const nodes = await this.#nodes(runId);
    for (const n of nodes) {
      if (!NODE_OPEN.has(n.state) && n.state !== 'awaiting_merge') continue;
      await this.#stopNodeJob(n, 'cancel_requested', reason);
      await this.#setNode(runId, n.node_id, { state: 'cancelled', reason });
    }
    await this.#finishRun(run, state, reason);
  }

  // ===================================================================================== human actions

  async cancelRun(runId: string, actor: WorkflowActor, reason: string): Promise<RunState> {
    try {
      const v2 = await this.v2.cancelRun(runId, actor, reason);
      if (v2 !== null) return v2 as RunState;
    } catch (err) {
      throw err instanceof EngineV2Error ? new WorkflowError(err.status, err.code, err.message) : err;
    }
    return this.#withRunLock(runId, async (): Promise<RunState> => {
      const run = await this.#run(this.deps.pool, runId);
      if (run === null) throw new WorkflowError(404, 'run_not_found', 'Workflow run not found.');
      if (!RUN_OPEN.includes(run.state)) {
        throw new WorkflowError(409, 'run_finished', `The run is already ${run.state}.`);
      }
      await this.#abort(runId, 'cancelled', `cancelled by ${actor.id}: ${reason}`);
      await this.deps.audit.record({
        actor: { type: actor.type, id: actor.id },
        action: 'workflow.run.cancel',
        target: `workflow-run:${runId}`,
        outcome: 'success',
        metadata: { project: run.project },
      });
      return 'cancelled';
    });
  }

  /** Human decision on a node's approval gate (role checked here; step-up by the route). */
  async decideGate(
    runId: string,
    nodeId: string,
    actor: { readonly id: string; readonly role: string },
    decision: 'approve' | 'deny',
    reason: string,
  ): Promise<NodeState> {
    try {
      const v2 = await this.v2.decideGate(runId, nodeId, actor, decision, reason);
      if (v2 !== null) return v2 as NodeState;
    } catch (err) {
      throw err instanceof EngineV2Error ? new WorkflowError(err.status, err.code, err.message) : err;
    }
    return this.#withRunLock(runId, async () => {
      const run = await this.#run(this.deps.pool, runId);
      if (run === null) throw new WorkflowError(404, 'run_not_found', 'Workflow run not found.');
      const n = (await this.#nodes(runId)).find((x) => x.node_id === nodeId);
      if (n === undefined) throw new WorkflowError(404, 'node_not_found', 'Node not found.');
      if (n.state !== 'awaiting_approval' || n.gate_role === null) {
        throw new WorkflowError(409, 'not_awaiting_approval', `The node is ${n.state}.`);
      }
      if ((ROLE_RANK[actor.role] ?? -1) < (ROLE_RANK[n.gate_role] ?? 99)) {
        await this.deps.audit.record({
          actor: { type: 'user', id: actor.id },
          action: `workflow.gate.${decision}`,
          target: `workflow-run:${runId}`,
          outcome: 'denied',
          metadata: { node: nodeId, required: n.gate_role, role: actor.role },
        });
        throw new WorkflowError(403, 'forbidden', `This gate needs the ${n.gate_role} role.`);
      }
      const now = this.deps.clock();
      await this.deps.pool.query(
        `UPDATE workflow_nodes SET gate_decision = $3, gate_decided_by = $4, gate_decided_at = $5, updated_at = $5
          WHERE run_id = $1 AND node_id = $2`,
        [runId, nodeId, decision === 'approve' ? 'approved' : 'denied', actor.id, now],
      );
      await this.deps.audit.record({
        actor: { type: 'user', id: actor.id },
        action: `workflow.gate.${decision}`,
        target: `workflow-run:${runId}`,
        outcome: 'success',
        metadata: { node: nodeId, project: run.project, reason: clip(reason, 200) },
      });
      if (decision === 'approve') {
        await this.#setNode(runId, nodeId, { state: 'pending', reason: null });
        await this.#progressRun(runId);
      } else {
        const edges = await this.#edges(this.deps.pool, runId);
        const nodes = await this.#nodes(runId);
        const fresh = nodes.find((x) => x.node_id === nodeId) ?? n;
        await this.#stopNodeJob(fresh, 'dependency_failed', `approval denied by ${actor.id}`);
        await this.#failed(
          run,
          fresh,
          { nodes: nodes.map((x) => x.def), edges },
          `approval denied by ${actor.id}${reason === '' ? '' : `: ${reason}`}`,
          { noRetry: true },
        );
        await this.#maybeFinish(run);
      }
      const after = (await this.#nodes(runId)).find((x) => x.node_id === nodeId);
      return after?.state ?? n.state;
    });
  }

  /** Kill switch hook (p4-quotas): every open run of the project is cancelled. */
  async cancelProjectRuns(project: string, actor: WorkflowActor, reason: string): Promise<void> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM workflow_runs WHERE project = $1 AND state = ANY($2::text[])`,
      [project, RUN_OPEN],
    );
    for (const r of rows) {
      await this.#withRunLock(r.id, () => this.#abort(r.id, 'cancelled', `${reason} (by ${actor.id})`));
    }
    await this.v2.cancelProjectRuns(project, actor, reason);
  }

  // ===================================================================================== 14.1: engine-2 tools

  #requireV2(): void {
    if (!this.engineFlags.v2)
      throw new WorkflowError(409, 'engine_v2_disabled', 'The new workflow engine is off on this server.');
  }

  /**
   * control.subWorkflow: starts the callee (latest or a pinned version) as a child run on engine 2. p18-multi-project:
   * the name is resolved in the calling run's project — its own workflow or one it attached (at the attachment's
   * version; a pinned version must be that one) — so a shared workflow's steps never leave the run's project.
   */
  async #startChild(actor: WorkflowActor, input: Parameters<StartChild>[1]): Promise<string> {
    const r = await resolveName(this.deps.pool, input.project, input.name);
    if (r === null) throw new WorkflowError(404, 'workflow_not_found', 'Sub-workflow not found.');
    let id = r.definitionId;
    if (input.version !== 'latest' && input.version !== r.version) {
      const v =
        r.attachment === null
          ? await versionRow(this.deps.pool, input.project, input.name, input.version)
          : null;
      if (v === null)
        throw new WorkflowError(
          404,
          'workflow_not_found',
          r.attachment === null
            ? 'Sub-workflow version not found.'
            : `Project ${input.project} runs version ${String(r.version)} of the shared sub-workflow ${input.name}.`,
        );
      id = v.id;
    }
    return this.startRun(actor, id, {
      inputs: input.inputs,
      ...(input.repository === null ? {} : { repository: input.repository }),
      priority: input.priority,
      parent: input.parent,
      project: input.project,
    });
  }

  /**
   * p14-workflow-engine 14.4: the error workflow of a failed run — the named workflow of the same project (latest
   * version), as the failed run's creator (re-checked: active, `workflows.run`), with the failure as untrusted
   * `$trigger` data. Unique per failed run (`error_of`).
   */
  async #startErrorRun(input: {
    readonly project: string;
    readonly name: string;
    readonly runAs: string;
    readonly failedRunId: string;
    readonly data: unknown;
  }): Promise<string> {
    const denied = await runAsDenied(
      this.deps.pool,
      {
        runId: input.failedRunId,
        nodeId: '',
        nodeRunId: '',
        scope: '',
        project: input.project,
        workflow: input.name,
        runAs: input.runAs,
        key: '',
      },
      [],
    );
    if (denied !== null) throw new WorkflowError(403, 'run_as_not_allowed', denied);
    // p18-multi-project: the name is resolved in the failed run's project (own, or attached there).
    const r = await resolveName(this.deps.pool, input.project, input.name);
    if (r === null) throw new WorkflowError(404, 'workflow_not_found', 'Error workflow not found.');
    return this.startRun({ type: 'user', id: input.runAs }, r.definitionId, {
      inputs: {},
      trigger: { kind: 'error', sourceTrust: 'untrusted', node: null, data: input.data },
      errorOf: input.failedRunId,
      project: input.project,
    });
  }

  /** p14-workflow-engine 14.4: pauses an active engine-2 run (§20.1). */
  async pauseRun(runId: string, actor: WorkflowActor, reason: string): Promise<string> {
    const run = await this.#run(this.deps.pool, runId);
    if (run === null) throw new WorkflowError(404, 'run_not_found', 'Workflow run not found.');
    if (run.engine !== 2)
      throw new WorkflowError(409, 'rerun_not_supported', 'Only runs of the new engine can be paused.');
    try {
      return await this.v2.pauseRun(runId, actor, reason);
    } catch (err) {
      throw err instanceof EngineV2Error ? new WorkflowError(err.status, err.code, err.message) : err;
    }
  }

  /** p14-workflow-engine 14.4: resumes a paused engine-2 run (§20.1). */
  async resumeRun(runId: string, actor: WorkflowActor): Promise<string> {
    const run = await this.#run(this.deps.pool, runId);
    if (run === null) throw new WorkflowError(404, 'run_not_found', 'Workflow run not found.');
    if (run.engine !== 2) throw new WorkflowError(409, 'run_not_paused', 'Only a paused run can be resumed.');
    try {
      return await this.v2.resumeRun(runId, actor);
    } catch (err) {
      throw err instanceof EngineV2Error ? new WorkflowError(err.status, err.code, err.message) : err;
    }
  }

  /**
   * p14-workflow-engine 14.4: re-runs a finished engine-2 run (§20.2), from a node or entirely, with the run's version
   * or the latest; `dryRun` returns the plan only. The new run runs as `actor` with the source's inputs, repository,
   * priority, workspace files and trigger data; copied node runs are never executed (no upstream side effect repeats).
   */
  async rerun(
    actor: WorkflowActor,
    runId: string,
    opts: {
      readonly fromNode?: string | undefined;
      readonly latestVersion?: boolean;
      readonly dryRun?: boolean;
    },
  ): Promise<{ plan: RerunPlan; runId: string | null }> {
    const run = await this.#run(this.deps.pool, runId);
    if (run === null) throw new WorkflowError(404, 'run_not_found', 'Workflow run not found.');
    if (run.engine !== 2)
      throw new WorkflowError(409, 'rerun_not_supported', 'Only runs of the new engine can be re-run here.');
    let target: { id: string; def: WorkflowDefinitionV2; version: number } | null = null;
    if (opts.latestVersion === true) {
      // p18-multi-project: "the latest" of a shared workflow is the version its project runs now.
      const resolved = await resolveName(this.deps.pool, run.project, run.name);
      const { rows } = await this.deps.pool.query<{
        id: string;
        version: number;
        definition: StoredDefinition;
      }>('SELECT id, version, definition FROM workflow_definitions WHERE id = $1', [
        resolved?.definitionId ?? '00000000-0000-4000-8000-000000000000',
      ]);
      const latest = rows[0];
      if (latest !== undefined)
        target = {
          id: latest.id,
          version: latest.version,
          def:
            schemaVersionOf(latest.definition) === 2
              ? (latest.definition as WorkflowDefinitionV2)
              : normaliseV1(latest.definition as WorkflowDefinition),
        };
    }
    let planned: Awaited<ReturnType<WorkflowEngineV2['planRerun']>>;
    try {
      planned = await this.v2.planRerun(runId, opts.fromNode ?? null, target);
    } catch (err) {
      throw err instanceof EngineV2Error ? new WorkflowError(err.status, err.code, err.message) : err;
    }
    if (opts.dryRun === true) return { plan: planned.plan, runId: null };
    const src = planned.source;
    const trigger: StartTrigger = {
      kind: 'rerun',
      sourceTrust: src.source_trust ?? 'trusted',
      node: src.trigger_node,
      data:
        src.trigger_data === null || src.trigger_data === undefined
          ? null
          : await loadStored(this.deps.pool, src.id, src.trigger_data),
    };
    // p19-repo-inputs-composer-workflows: a repository run's files are copied too (workspace and repository runs).
    const files = this.deps.workspaces === undefined ? [] : await this.deps.workspaces.runFileInputs(run.id);
    const newRun = await this.startRun(actor, target?.id ?? run.definition_id, {
      inputs: run.inputs,
      ...(run.repository === null ? {} : { repository: run.repository }),
      ...(files.length > 0 ? { files } : {}),
      priority: run.priority,
      trigger,
      rerun: planned.start,
      project: run.project,
    });
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'workflow.run.rerun',
      target: `workflow-run:${newRun}`,
      outcome: 'success',
      metadata: {
        project: run.project,
        name: run.name,
        rerunOf: run.id,
        fromNode: opts.fromNode ?? null,
        version: planned.plan.version,
        copied: planned.plan.copied.length,
        fresh: planned.plan.fresh.length,
        sideEffects: planned.plan.sideEffects.slice(0, 20),
      },
    });
    return { plan: planned.plan, runId: newRun };
  }

  /**
   * p14-workflow-engine 14.4 (§20.5): the answer of a webhook call held by its workflow trigger (`responseMode: wait`)
   * — null when the call is not held (answer at once) or nothing answered in time.
   */
  async awaitWebhookAnswer(
    automationId: string,
    automationRunId: string,
    signal: AbortSignal,
  ): Promise<HeldAnswer | null> {
    if (!this.engineFlags.v2) return null;
    const hold = await holdOf(this.deps.pool, automationId);
    if (hold === null) return null;
    return awaitAnswer(this.deps.pool, automationRunId, hold.timeoutSec * 1000, signal);
  }

  /**
   * p14-workflow-engine 14.4: the editor's metrics of a workflow (every version, last `days` days; §20.4).
   * p18-multi-project: `project` = the runs of one project that attached it (default: the owner project's runs).
   */
  async metrics(definitionId: string, days: number, project?: string): Promise<WorkflowMetricsView | null> {
    const d = await this.definition(definitionId);
    if (d === null) return null;
    const runProject = project ?? d.project;
    const resolved = await resolveName(this.deps.pool, runProject, d.name);
    if (resolved === null || resolved.ownerProject !== d.project) return null;
    const { rows } = await this.deps.pool.query<{ definition: StoredDefinition }>(
      'SELECT definition FROM workflow_definitions WHERE id = $1',
      [resolved.definitionId],
    );
    const latest = rows[0]?.definition;
    const alertAfter =
      latest !== undefined && schemaVersionOf(latest) === 2
        ? ((latest as WorkflowDefinitionV2).settings?.alerts?.failuresInARow ??
          SETTINGS_DEFAULTS.failuresInARow)
        : SETTINGS_DEFAULTS.failuresInARow;
    return workflowMetrics(
      this.deps.pool,
      { project: runProject, name: d.name, alertAfter },
      days,
      this.deps.clock(),
    );
  }

  /** The node catalog for the editor (`GET /workflows/catalog`): types, config schemas, ports, functions, limits. */
  catalog(): WorkflowCatalog {
    catalogCache ??= buildCatalog();
    const v2 = this.engineFlags.v2;
    return { ...catalogCache, engineV2: v2, executable: v2 ? [...ENGINE_V2_TYPES].sort() : [] };
  }

  /**
   * The catalog with the machines that can run worker function nodes (14.3): workers advertising `function-v1`
   * (HTTP / e-mail) and `function-code-v1` (code), and how many are connected now — the editor's "uygun çevrimiçi
   * makine: N". A function job waits for one while none is online (until the node's queue timeout).
   */
  async catalogView(): Promise<WorkflowCatalog & { functionWorkers: FunctionWorkerCounts }> {
    const { rows } = await this.deps.pool.query<{
      http_total: number;
      http_online: number;
      code_total: number;
      code_online: number;
    }>(
      `SELECT count(*) FILTER (WHERE features ? 'function-v1')::int AS http_total,
              count(*) FILTER (WHERE features ? 'function-v1' AND ${ONLINE_WORKER})::int AS http_online,
              count(*) FILTER (WHERE features ? 'function-code-v1')::int AS code_total,
              count(*) FILTER (WHERE features ? 'function-code-v1' AND ${ONLINE_WORKER})::int AS code_online
         FROM workers WHERE state NOT IN ('pending', 'quarantined')`,
    );
    const r = rows[0];
    return {
      ...this.catalog(),
      functionWorkers: {
        http: { online: r?.http_online ?? 0, total: r?.http_total ?? 0 },
        code: { online: r?.code_online ?? 0, total: r?.code_total ?? 0 },
      },
    };
  }

  /** Live preview of one expression against sample data, in the sandbox (`POST /workflows/expressions/evaluate`). */
  async evaluateExpression(
    source: string,
    mode: 'expr' | 'template',
    sample: ExprSample,
  ): Promise<
    | { ok: true; value: unknown; type: string; bytes: number; truncated: boolean }
    | { ok: false; error: { code: string; position: number | null } }
  > {
    this.#requireV2();
    const pre = checkSource(source, mode);
    if (pre !== null) return { ok: false, error: { code: pre.code, position: pre.position } };
    const r = await this.pure.evaluate(source, mode, { ...sample, now: this.deps.clock().toISOString() });
    if (!r.ok) return { ok: false, error: { code: r.code, position: r.position } };
    const value = redactValue(r.value);
    const json = JSON.stringify(value) as string | undefined;
    const bytes = json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
    const type =
      value === undefined
        ? 'undefined'
        : value === null
          ? 'null'
          : Array.isArray(value)
            ? 'array'
            : typeof value;
    if (bytes > PREVIEW_MAX_BYTES)
      return { ok: true, value: (json ?? '').slice(0, PREVIEW_MAX_BYTES), type, bytes, truncated: true };
    return { ok: true, value: value ?? null, type, bytes, truncated: false };
  }

  /**
   * "Bu düğümü dene": runs one master-pure node (the stored one, or the editor's unsaved copy) on sample input in the
   * sandbox. Nothing is stored except the audit line; timers, approvals and sub-workflow calls report what they would
   * do instead of doing it.
   */
  async testNode(
    actor: WorkflowActor,
    workflowId: string,
    nodeId: string,
    body: { readonly node?: unknown; readonly input?: unknown; readonly sample?: ExprSample },
  ): Promise<NodeTestResult> {
    this.#requireV2();
    const d = await this.definition(workflowId);
    if (d === null) throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
    const doc =
      schemaVersionOf(d.definition) === 2
        ? (d.definition as WorkflowDefinitionV2)
        : normaliseV1(d.definition as WorkflowDefinition);
    let node: V2Node | undefined;
    if (body.node !== undefined) {
      const parsed = V2Node.safeParse(body.node);
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 20).map((i) => ({
          path: ['node', ...i.path.map(String)].join('.'),
          code: i.message.startsWith('Invalid') ? i.code : i.message,
        }));
        throw new WorkflowError(400, 'invalid_node', 'invalid node', issues);
      }
      node = parsed.data;
      if (node.id !== nodeId)
        throw new WorkflowError(400, 'invalid_node', 'invalid node', [{ path: 'node.id', code: 'mismatch' }]);
    } else node = doc.nodes.find((n) => n.id === nodeId);
    if (node === undefined) throw new WorkflowError(404, 'node_not_found', 'Node not found.');
    const t = nodeType(node.type);
    if (t === undefined || !nodeTestable(t) || isAiStep(node)) {
      throw new WorkflowError(409, 'node_test_unavailable', 'This node type cannot be tested here.');
    }
    const issues: GraphIssue[] = [];
    for (const [field, value] of Object.entries(node.config)) {
      if (t.fields[field] === 'static' && containsExpression(value))
        issues.push({ path: `node.config.${field}`, code: 'static_field' });
      if (t.fields[field] !== 'expr') continue;
      for (const x of configExpressions(value, [field])) {
        const e = checkSource(x.source, x.mode);
        if (e !== null) issues.push({ path: `node.config.${x.path.map(String).join('.')}`, code: e.code });
      }
    }
    if (issues.length > 0) throw new WorkflowError(400, 'invalid_node', 'invalid node', issues.slice(0, 20));
    const now = this.deps.clock();
    const started = Date.now();
    const input = body.input ?? null;
    const context = {
      ...(body.sample ?? {}),
      now: now.toISOString(),
      input,
      inputs: body.sample?.inputs ?? {},
      run: {
        id: 'test',
        startedAt: now.toISOString(),
        workflow: d.name,
        version: d.version,
        project: d.project,
      },
    };
    // A merge test takes `{values, from}` as its sample input (else the input is one value).
    const sampleMerge: { values?: unknown; from?: unknown } | null =
      typeof input === 'object' && !Array.isArray(input) ? input : null;
    const merged =
      node.type === 'control.merge'
        ? {
            values: Array.isArray(sampleMerge?.values) ? (sampleMerge.values as unknown[]) : [input],
            from: Array.isArray(sampleMerge?.from) ? (sampleMerge.from as string[]) : ['sample'],
          }
        : undefined;
    const out = await this.pure.execute({
      type: node.type,
      config: node.config,
      context,
      ...(merged === undefined ? {} : { merged }),
    });
    const durationMs = Date.now() - started;
    const result = testResult(out, durationMs);
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'workflow.test',
      target: `workflow:${workflowId}`,
      outcome: result.ok ? 'success' : 'failure',
      metadata: {
        project: d.project,
        node: nodeId,
        type: node.type,
        outcome: result.ok ? result.outcome : 'error',
        ...(result.ok ? {} : { code: result.error.code }),
        unsaved: body.node !== undefined,
      },
    });
    return result;
  }

  /** Engine-2 node runs of a run (paginated; null: not an engine-2 run). */
  async nodeRuns(
    runId: string,
    q: { node?: string | undefined; scope?: string | undefined; after?: number; limit: number },
  ): Promise<{ nodeRuns: Record<string, unknown>[]; next: number | null } | null> {
    const r = await this.v2.nodeRuns(runId, q);
    if (r === null) return null;
    const iso = (x: Date | null): string | null => (x === null ? null : x.toISOString());
    return {
      next: r.next,
      nodeRuns: r.rows.map((n) => {
        const ai = 'role' in n.input && 'spec' in n.input ? n.input : null;
        const out = n.output;
        return {
          id: n.id,
          node: n.node_id,
          type: n.node_type,
          scope: n.scope,
          attempt: n.attempt,
          state: n.state,
          waitKind: n.wait_kind,
          dueAt: iso(n.due_at),
          placement: n.placement,
          outputPort: n.output_port,
          // AI steps: the role, runtime and frozen upstream snapshot (prompts are on the job); others: stored values.
          input:
            ai !== null
              ? { role: ai.role, runtime: ai.spec.runtime, snapshot: ai.snapshot ?? [] }
              : (() => {
                  const { value, config, group, child } = n.input as PureInput;
                  return {
                    value: value ?? null,
                    ...(config === undefined ? {} : { config }),
                    ...(group === undefined
                      ? {}
                      : {
                          group: {
                            count: group.count,
                            started: group.started,
                            stopped: group.stopped ?? false,
                          },
                        }),
                    ...(child === undefined ? {} : { child }),
                  };
                })(),
          output:
            out === null
              ? null
              : 'ports' in out || '$pruned' in out
                ? out
                : {
                    summary: out.summary,
                    branch: out.branch,
                    commits: out.commits,
                    ...(out.data === undefined ? {} : { data: out.data }),
                  },
          error: n.error,
          reason: n.reason,
          startedAt: iso(n.started_at),
          endedAt: iso(n.ended_at),
          createdAt: n.created_at.toISOString(),
          gate:
            n.gate_role === null
              ? null
              : {
                  approverRole: n.gate_role,
                  decision: n.gate_decision,
                  decidedBy: n.gate_decided_by,
                  decidedAt: iso(n.gate_decided_at),
                },
          jobId: n.job_id,
          // 14.4: taken over from the source run of a re-run (that node run's id).
          copiedFrom: n.copied_from,
        };
      }),
    };
  }

  /** A stored payload of an engine-2 run (null: unknown). */
  payload(runId: string, sha: string): Promise<{ size: number; value: unknown } | null> {
    return this.v2.payload(runId, sha);
  }

  /** Approve / deny a waiting approval of an engine-2 node run (AI gate or `control.approval`). */
  async decideNodeRun(
    runId: string,
    nodeRunId: string,
    actor: { readonly id: string; readonly role: string },
    decision: 'approve' | 'deny',
    reason: string,
  ): Promise<string> {
    const run = await this.#run(this.deps.pool, runId);
    if (run?.engine !== 2) throw new WorkflowError(404, 'node_not_found', 'Node not found.');
    try {
      return await this.v2.decideNodeRun(runId, nodeRunId, actor, decision, reason);
    } catch (err) {
      throw err instanceof EngineV2Error ? new WorkflowError(err.status, err.code, err.message) : err;
    }
  }

  /** Cancel one open engine-2 node run (its error policy applies). */
  async cancelNodeRun(
    runId: string,
    nodeRunId: string,
    actor: WorkflowActor,
    reason: string,
  ): Promise<string> {
    const run = await this.#run(this.deps.pool, runId);
    if (run?.engine !== 2) throw new WorkflowError(404, 'node_not_found', 'Node not found.');
    try {
      return await this.v2.cancelNodeRun(runId, nodeRunId, actor, reason);
    } catch (err) {
      throw err instanceof EngineV2Error ? new WorkflowError(err.status, err.code, err.message) : err;
    }
  }

  /** p14-workflow-engine 14.2: manual resume of an engine-2 node run waiting for a webhook (data untrusted). */
  async resumeNodeRun(
    runId: string,
    nodeRunId: string,
    actor: WorkflowActor,
    data: unknown,
  ): Promise<string> {
    const run = await this.#run(this.deps.pool, runId);
    if (run?.engine !== 2) throw new WorkflowError(404, 'node_not_found', 'Node not found.');
    try {
      return await this.v2.resumeNodeRun(runId, nodeRunId, actor, data);
    } catch (err) {
      throw err instanceof EngineV2Error ? new WorkflowError(err.status, err.code, err.message) : err;
    }
  }

  /** p14-workflow-engine 14.2: `POST /v1/hooks/wait/:token` (public; token + signature checked by engine 2). */
  receiveWait(
    token: string,
    headers: { timestamp?: string | undefined; nonce?: string | undefined; signature?: string | undefined },
    raw: Buffer,
    meta: { readonly ip: string | null },
  ): Promise<{ status: 202 | 400 | 404; body: Record<string, unknown> }> {
    return this.v2.receiveWait(token, headers, raw, meta);
  }
}

/** The sample data of an expression preview / node test (every field optional). */
export interface ExprSample {
  readonly input?: unknown;
  readonly node?: Readonly<Record<string, unknown>>;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly trigger?: unknown;
  readonly item?: unknown;
  readonly index?: number;
  readonly items?: unknown;
  readonly loop?: unknown;
  readonly run?: Readonly<Record<string, unknown>>;
}

const PREVIEW_MAX_BYTES = 32 * 1024;

export type NodeTestResult =
  | {
      ok: true;
      outcome: 'value' | 'wait' | 'stop' | 'fail' | 'group' | 'return';
      ports?: Record<string, unknown>;
      port?: string;
      wait?: {
        kind: 'timer' | 'approval' | 'child_run' | 'webhook';
        dueAt: string | null;
        detail: Record<string, unknown>;
      };
      detail?: Record<string, unknown>;
      durationMs: number;
    }
  | { ok: false; error: { code: string; message: string; position: number | null }; durationMs: number };

function testResult(out: PureOutcome, durationMs: number): NodeTestResult {
  const clean = (v: unknown): Record<string, unknown> => redactValue(v) as Record<string, unknown>;
  switch (out.kind) {
    case 'value':
      return {
        ok: true,
        outcome: 'value',
        ports: clean(out.ports),
        port: Object.keys(out.ports)[0] ?? 'out',
        durationMs,
      };
    case 'error':
      return { ok: false, error: { code: out.code, message: out.code, position: out.position }, durationMs };
    case 'timer':
      return {
        ok: true,
        outcome: 'wait',
        wait: { kind: 'timer', dueAt: out.dueAt.toISOString(), detail: clean(out.config) },
        durationMs,
      };
    case 'approval':
      return {
        ok: true,
        outcome: 'wait',
        wait: { kind: 'approval', dueAt: null, detail: clean(out.config) },
        durationMs,
      };
    case 'subWorkflow':
      return {
        ok: true,
        outcome: 'wait',
        wait: { kind: 'child_run', dueAt: null, detail: clean(out.config) },
        durationMs,
      };
    case 'stop':
      return { ok: true, outcome: 'stop', detail: clean({ outputs: out.outputs }), durationMs };
    case 'fail':
      return { ok: true, outcome: 'fail', detail: clean({ reason: out.reason }), durationMs };
    case 'return':
      return { ok: true, outcome: 'return', detail: clean({ value: out.value }), durationMs };
    case 'group':
      return {
        ok: true,
        outcome: 'group',
        detail: clean({ items: out.items.length, preview: out.items.slice(0, 20) }),
        durationMs,
      };
    case 'loop':
      return { ok: true, outcome: 'group', detail: { continue: out.continue }, durationMs };
    case 'webhookWait':
      return {
        ok: true,
        outcome: 'wait',
        wait: { kind: 'webhook', dueAt: null, detail: clean(out.config) },
        durationMs,
      };
    case 'respond': {
      // 14.4: what the held webhook request would be answered with (or why it would fail).
      const answer = respondAnswer(out.config);
      return 'code' in answer
        ? { ok: false, error: { code: answer.code, message: answer.message, position: null }, durationMs }
        : { ok: true, outcome: 'value', ports: clean({ out: answer }), port: 'out', durationMs };
    }
  }
}

/** Whether the editor's single-node test runs a type (master-pure types delivered by 14.1). */
export function nodeTestable(t: NodeTypeSpec): boolean {
  return t.placement === 'master' && ENGINE_V2_TYPES.has(t.type);
}

/** 14.3: workers able to run worker function nodes (`online`: connected now). */
export interface FunctionWorkerCounts {
  readonly http: { readonly online: number; readonly total: number };
  readonly code: { readonly online: number; readonly total: number };
}

const ONLINE_WORKER = "state IN ('online', 'busy') AND connected_at IS NOT NULL";

export interface WorkflowCatalog {
  engineV2: boolean;
  executable: string[];
  types: {
    type: string;
    category: string;
    placement: string;
    phase: string;
    icon: string;
    group: boolean;
    sideEffect: boolean;
    requires: string;
    untrustedOutput: boolean;
    testable: boolean;
    fields: Record<string, 'static' | 'expr'>;
    config: unknown;
    ports: PortSpec[];
    dynamicPorts?: 'cases';
  }[];
  functions: { name: string; signature: string; description?: string }[];
  refusedFunctions: string[];
  limits: {
    maxNodes: number;
    maxAiNodes: number;
    maxEdges: number;
    maxNesting: number;
    maxDefinitionBytes: number;
    forEachMaxItems: number;
    loopMaxIterations: number;
  };
}

let catalogCache: Omit<WorkflowCatalog, 'engineV2' | 'executable'> | undefined;

function buildCatalog(): Omit<WorkflowCatalog, 'engineV2' | 'executable'> {
  return {
    types: NODE_TYPES.map((t) => {
      let config: unknown;
      try {
        config = z.toJSONSchema(t.config, { io: 'input', unrepresentable: 'any' });
      } catch {
        config = { type: 'object' };
      }
      const ports = t.ports(t.type === 'control.switch' ? { cases: [] } : {});
      return {
        type: t.type,
        category: t.category,
        placement: t.placement,
        phase: t.phase,
        icon: t.icon,
        group: t.group === true,
        sideEffect: t.sideEffect,
        requires: t.requires,
        untrustedOutput: t.untrustedOutput === true,
        testable: nodeTestable(t),
        fields: { ...t.fields },
        config,
        ports: ports.map((p) => ({ ...p })),
        ...(t.type === 'control.switch' ? { dynamicPorts: 'cases' as const } : {}),
      };
    }),
    functions: JSONATA_FUNCTIONS.map((f) => ({ ...f })),
    refusedFunctions: REFUSED_FUNCTIONS.map((f) => `$${f}`),
    limits: {
      maxNodes: V2_LIMITS.maxNodes,
      maxAiNodes: V2_LIMITS.maxAiNodes,
      maxEdges: V2_LIMITS.maxEdges,
      maxNesting: V2_LIMITS.maxNesting,
      maxDefinitionBytes: V2_LIMITS.maxDefinitionBytes,
      forEachMaxItems: EXPR_LIMITS.forEachMaxItems,
      loopMaxIterations: 100,
    },
  };
}

/**
 * ASSIGN_JOB context for workflow jobs: the base context bundle (p6-context-model) followed by the fenced
 * upstream outputs frozen when the node was released. The bundle hash covers exactly what is sent.
 */
export class WorkflowContextProvider implements ContextProvider {
  constructor(
    private readonly inner: ContextProvider | null,
    private readonly db: Queryable,
  ) {}

  async issue(jobId: string, workerId: string): Promise<{ bundleHash: string; rendered: string } | null> {
    const base = this.inner === null ? null : await this.inner.issue(jobId, workerId);
    // p14-workflow-engine: engine-2 jobs carry their snapshot on the node run.
    const { rows } = await this.db.query<{ snapshot: UpstreamValue[] | null }>(
      `SELECT n.upstream_snapshot AS snapshot FROM workflow_node_jobs wj
         JOIN workflow_nodes n ON n.run_id = wj.run_id AND n.node_id = wj.node_id WHERE wj.job_id = $1
       UNION ALL
       SELECT nr.input->'snapshot' AS snapshot FROM workflow_node_run_jobs l
         JOIN workflow_node_runs nr ON nr.id = l.node_run_id WHERE l.job_id = $1`,
      [jobId],
    );
    const snapshot = rows[0]?.snapshot ?? null;
    if (snapshot === null || snapshot.length === 0) return base;
    const rendered = [base?.rendered, fenceUpstream(snapshot)].filter((x): x is string => !!x).join('\n\n');
    if (rendered.length > 192 * 1024)
      throw new Error('context bundle with upstream outputs too large for ASSIGN_JOB');
    return { bundleHash: `sha256:${createHash('sha256').update(rendered).digest('hex')}`, rendered };
  }
}

/** p16-workflow-quality: the project's registered repository (`PUT /projects/:id/git`), or null. */
export async function registeredRepository(
  db: Queryable,
  project: string,
): Promise<{ url: string; baseRef: string } | null> {
  const { rows } = await db.query<{ repository_url: string; base_branch: string }>(
    'SELECT repository_url, base_branch FROM project_git_configs WHERE project = $1',
    [project],
  );
  const r = rows[0];
  return r === undefined ? null : { url: r.repository_url, baseRef: r.base_branch };
}
