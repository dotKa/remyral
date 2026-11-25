import { JobSpec, JobTitle, MAX_RUNTIME_FALLBACKS, SiteBundleRequest } from '@remyral/protocol';
import {
  FAILURE_POLICIES,
  type GraphIssue,
  validateWorkflowGraph,
  WORKFLOW_LIMITS,
  WORKFLOW_ROLES,
  type WorkflowGraph,
} from '@remyral/scheduler';
import { z } from 'zod';

/**
 * Workflow definition documents, version 1 (docs/design/p4-dag.md §2): versioned JSON, validated strictly (unknown
 * keys rejected) and structurally (`validateWorkflowGraph`). Job-level fields reuse the protocol JobSpec so a
 * definition can only describe jobs a user could also submit directly. Moved here unchanged from
 * `apps/master/src/workflows/definition.ts` (p14-workflow-engine 14.0) so the v2 `ai.step` node shares exactly these
 * fields; the master re-exports them.
 */

export const Limits = z.strictObject({
  maxDurationSec: z
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 3600),
  maxCostUsd: z.number().min(0).optional(),
  maxTokens: z.number().int().min(1).optional(),
  maxTurns: z.number().int().min(1).optional(),
});

/** p13-workflows-ui: an editor coordinate (finite, bounded). */
export const Coordinate = z.number().min(-100_000).max(100_000);

const Requirements = JobSpec.shape.requirements.unwrap();

/** p6-quota-scheduling: ordered fallback runtimes of a step (or of every step, in `defaults`). */
export const Fallbacks = z
  .array(z.strictObject({ runtime: JobSpec.shape.runtime, model: JobSpec.shape.model }))
  .min(1)
  .max(MAX_RUNTIME_FALLBACKS);

/**
 * p6-result-reuse (opt-in, default off): a step with no upstream steps reuses an identical job of the project that
 * succeeded within this many hours (same runtime, model profile, step prompt, base commit / input files) instead of
 * running; its own job is cancelled before it starts and the run shows which job was reused. A node's value wins
 * over `defaults`. Ignored for integrators, planners with `dynamic`, and steps with `deploy` or `siteBundle`.
 */
export const ReuseWithinHours = z.number().int().min(1).max(168);

export const JobFields = {
  runtime: JobSpec.shape.runtime,
  runtimeVersion: JobSpec.shape.runtimeVersion,
  model: JobSpec.shape.model,
  sandboxProfile: JobSpec.shape.sandboxProfile,
  approvalPolicy: JobSpec.shape.approvalPolicy,
  sourceTrust: JobSpec.shape.sourceTrust,
  requirements: Requirements.optional(),
};

export const Repository = z.strictObject({
  url: JobSpec.shape.repository.unwrap().shape.url,
  baseRef: JobSpec.shape.repository.unwrap().shape.baseRef,
});

/** p6-deploy-pipeline: the deploy step after a verifier / integrator node (ADR-0028). */
export const DeployStep = z.strictObject({
  kind: z.enum(['coolify.deploy', 'coolify.restart', 'pages.deploy']),
  env: z.enum(['preview', 'production']).optional(),
  force: z.boolean().optional(),
  branch: z
    .string()
    .regex(/^[A-Za-z0-9._/-]{1,100}$/)
    .optional(),
});

/** The AI-step fields shared by a v1 node and a v2 `ai.step` node (everything but the failure policy). */
export const AiStepFields = {
  id: z.string().max(48),
  role: z.enum(WORKFLOW_ROLES),
  prompt: z.string().min(1).max(WORKFLOW_LIMITS.maxPromptChars),
  approval: z
    .strictObject({ approverRole: z.enum(['operator', 'admin', 'owner']).default('admin') })
    .optional(),
  dynamic: z
    .strictObject({ maxNodes: z.number().int().min(1).max(WORKFLOW_LIMITS.maxDynamicNodes) })
    .optional(),
  runtime: JobFields.runtime.optional(),
  runtimeVersion: JobFields.runtimeVersion,
  model: JobFields.model,
  sandboxProfile: JobFields.sandboxProfile.optional(),
  limits: Limits.optional(),
  requirements: JobFields.requirements,
  fallbacks: Fallbacks.optional(),
  deferrable: z.boolean().optional(),
  reuseWithinHours: ReuseWithinHours.optional(),
  /**
   * p6-deploy-pipeline (ADR-0028): the node's job builds a static site under this directory (JobSpec.siteBundle) —
   * what a `pages.deploy` step publishes.
   */
  siteBundle: SiteBundleRequest.optional(),
  /**
   * p6-deploy-pipeline: a deploy step after this node — after its verification (verifier) or after its merge
   * (integrator). The master requests the ops action as the workflow; the project's deploy policy decides (production
   * waits for an approval). Not allowed on other roles, and never created by a planner.
   */
  deploy: DeployStep.optional(),
  /**
   * p15-job-titles: the step job's short title (one line, ≤ 60 characters). Absent: "<workflow name> · <step label or
   * id>". Last key: definitions without it keep their output (and `definition_hash`).
   */
  title: JobTitle.optional(),
  /**
   * p16-workflow-quality: the step works on code and needs the run's repository. A run without one (no run input, no
   * workflow default, no repository registered for the project) runs its other steps in scratch directories and is
   * refused only when a step needs code: `needsRepository`, an integrator, or a Coolify deploy step. Last key (hash).
   */
  needsRepository: z.boolean().optional(),
};

/** Key order = the original schema's (zod outputs keys in shape order; `definition_hash` covers the output). */
const { id, role, prompt, ...aiRest } = AiStepFields;
export const V1Node = z.strictObject({
  id,
  role,
  prompt,
  failurePolicy: z.enum(FAILURE_POLICIES).optional(),
  maxRetries: z.number().int().min(0).max(WORKFLOW_LIMITS.maxRetries).optional(),
  ...aiRest,
});
export type WorkflowNodeBody = z.infer<typeof V1Node>;

/** Run-wide job defaults of a definition (v1 and v2 share them). */
export const Defaults = z.strictObject({
  runtime: JobFields.runtime,
  runtimeVersion: JobFields.runtimeVersion,
  model: JobFields.model,
  sandboxProfile: JobFields.sandboxProfile,
  approvalPolicy: JobFields.approvalPolicy.default('ask-sensitive'),
  sourceTrust: JobFields.sourceTrust,
  limits: Limits,
  requirements: JobFields.requirements,
  repository: Repository.optional(),
  fallbacks: Fallbacks.optional(),
  deferrable: z.boolean().optional(),
  reuseWithinHours: ReuseWithinHours.optional(),
});
export type WorkflowDefaults = z.infer<typeof Defaults>;

export const INPUT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const WORKFLOW_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const WorkflowDefinitionBody = z.strictObject({
  name: z.string().regex(WORKFLOW_NAME_PATTERN),
  description: z.string().max(1000).optional(),
  inputs: z
    .record(
      z.string().regex(INPUT_NAME_PATTERN),
      z.strictObject({ required: z.boolean().default(false), description: z.string().max(500).optional() }),
    )
    .default({}),
  defaults: Defaults,
  nodes: z.array(V1Node).min(1).max(WORKFLOW_LIMITS.maxNodes),
  edges: z
    .array(z.strictObject({ from: z.string().max(48), to: z.string().max(48) }))
    .max(WORKFLOW_LIMITS.maxEdges),
  /**
   * p13-workflows-ui: where the editor draws each step (presentation only; the engine ignores it). Keys must be node
   * ids (`layout.positions.<id>:unknown_node`).
   */
  layout: z
    .strictObject({
      positions: z
        .record(z.string().max(48), z.strictObject({ x: Coordinate, y: Coordinate }))
        .refine((r) => Object.keys(r).length <= WORKFLOW_LIMITS.maxNodes, { message: 'too_many' }),
    })
    .optional(),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionBody>;

export function graphOf(def: WorkflowDefinition): WorkflowGraph {
  return {
    nodes: def.nodes.map((n) => ({
      id: n.id,
      role: n.role,
      prompt: n.prompt,
      failurePolicy: n.failurePolicy,
      maxRetries: n.maxRetries,
      approval: n.approval,
      dynamic: n.dynamic,
    })),
    edges: def.edges,
    inputs: def.inputs,
  };
}

/** The deploy-step fields of a node (v1 node or v2 `ai.step`). */
interface DeployCarrier {
  readonly role: string;
  readonly deploy?: z.infer<typeof DeployStep> | undefined;
  readonly siteBundle?: unknown;
}

/** p6-deploy-pipeline: deploy steps only after a verifier or an integrator, with the parameters their kind needs. */
export function deployIssues(nodes: readonly DeployCarrier[], indexOf?: (i: number) => number): GraphIssue[] {
  const out: GraphIssue[] = [];
  nodes.forEach((n, i) => {
    if (n.deploy === undefined) return;
    const path = `nodes.${String(indexOf?.(i) ?? i)}.deploy`;
    if (n.role !== 'verifier' && n.role !== 'integrator')
      out.push({ path, code: 'deploy_needs_verifier_or_integrator' });
    if (n.deploy.kind !== 'pages.deploy' && n.deploy.env === undefined)
      out.push({ path, code: 'deploy_needs_env' });
    if (n.deploy.kind === 'pages.deploy' && n.siteBundle === undefined) {
      out.push({ path, code: 'pages_deploy_needs_site_bundle' });
    }
  });
  return out;
}

/** p13-workflows-ui: layout positions only for declared nodes. */
export function layoutIssues(
  nodes: readonly { readonly id: string }[],
  layout: { readonly positions: Readonly<Record<string, unknown>> } | undefined,
): GraphIssue[] {
  const ids = new Set(nodes.map((n) => n.id));
  return Object.keys(layout?.positions ?? {})
    .filter((k) => !ids.has(k))
    .map((k) => ({ path: `layout.positions.${k}`, code: 'unknown_node' }));
}

/** Zod issues as paths and codes (never values: prompts may be sensitive). */
export function zodIssues(error: z.ZodError, prefix = ''): GraphIssue[] {
  return error.issues.slice(0, 20).map((i) => ({
    path: [prefix, ...i.path.map(String)].filter((p) => p !== '').join('.'),
    code: i.code,
  }));
}

/**
 * A version-1 document: schema + structure as a list of issues (empty = valid) — what `POST /workflows/validate`
 * reports (p13-workflows-ui). Paths and codes only (prompts may be sensitive).
 */
export function definitionIssuesV1(
  value: unknown,
): { ok: true; def: WorkflowDefinition } | { ok: false; issues: GraphIssue[] } {
  const parsed = WorkflowDefinitionBody.safeParse(value);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const issues = [
    ...validateWorkflowGraph(graphOf(parsed.data)),
    ...deployIssues(parsed.data.nodes),
    ...layoutIssues(parsed.data.nodes, parsed.data.layout),
  ];
  return issues.length > 0 ? { ok: false, issues: issues.slice(0, 20) } : { ok: true, def: parsed.data };
}
