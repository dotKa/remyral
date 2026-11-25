import { type GraphIssue, type PlanTask, WORKFLOW_LIMITS } from '@remyral/scheduler';
import { definitionIssuesV1, type WorkflowDefinition } from '@remyral/workflow-nodes';
import { z } from 'zod';

/**
 * Workflow definition documents (docs/design/p4-dag.md §2). The schemas moved to `@remyral/workflow-nodes`
 * (p14-workflow-engine 14.0: v1 and v2, lossless conversion, v2 validation); this module re-exports the v1 names the
 * master has always used and keeps the planner's plan parsing.
 */
export {
  graphOf,
  Repository,
  type WorkflowDefinition,
  WorkflowDefinitionBody,
  type WorkflowNodeBody,
} from '@remyral/workflow-nodes';

export class InvalidWorkflowError extends Error {
  constructor(readonly issues: readonly GraphIssue[]) {
    super(`invalid workflow: ${issues.map((i) => `${i.path}:${i.code}`).join(', ')}`.slice(0, 1000));
    this.name = 'InvalidWorkflowError';
  }
}

/**
 * Schema + structure of a version-1 document as a list of issues (empty = valid) — what `POST /workflows/validate`
 * reports (p13-workflows-ui). Paths and codes only (prompts may be sensitive).
 */
export function definitionIssues(
  value: unknown,
): { ok: true; def: WorkflowDefinition } | { ok: false; issues: GraphIssue[] } {
  return definitionIssuesV1(value);
}

/** Schema + structure; paths and codes only in errors (prompts may be sensitive). */
export function parseDefinition(value: unknown): WorkflowDefinition {
  const r = definitionIssues(value);
  if (!r.ok) throw new InvalidWorkflowError(r.issues);
  return r.def;
}

const PlanBody = z.strictObject({
  tasks: z
    .array(
      z.strictObject({
        id: z.string().max(32),
        title: z.string().max(200),
        prompt: z.string().max(WORKFLOW_LIMITS.maxPromptChars / 2),
        role: z.enum(['executor', 'verifier']).optional(),
        dependsOn: z.array(z.string().max(32)).max(WORKFLOW_LIMITS.maxDynamicNodes).optional(),
        /**
         * p8-orchestration hints (untrusted; resolved against the allowlist by `resolvePlanTasks`): the runtime, a
         * model-catalog profile, capability tags and a machine (id or display name) for this task.
         */
        runtime: z.string().max(32).optional(),
        model: z.string().max(128).optional(),
        requires: z.array(z.string().max(32)).max(8).optional(),
        machine: z.string().max(128).optional(),
      }),
    )
    .max(WORKFLOW_LIMITS.maxDynamicNodes),
});

const PLAN_BLOCK = /```remyral-plan\s*\n([\s\S]{1,32768}?)\n```/;

/** A planned task with its p8-orchestration hints. */
export type PlannedTask = PlanTask & {
  readonly runtime?: string | undefined;
  readonly model?: string | undefined;
  readonly requires?: readonly string[] | undefined;
  readonly machine?: string | undefined;
};

/**
 * Extracts a planner's plan from its result summary: one fenced block tagged `remyral-plan` holding JSON
 * `{tasks: [{id, title, prompt, role?, dependsOn?, runtime?, model?, requires?, machine?}]}`. Untrusted input: parsed
 * strictly, never evaluated; the hints are resolved against the allowlist later (`resolvePlanTasks`).
 */
export function parsePlan(summary: string): { ok: true; tasks: PlannedTask[] } | { ok: false; code: string } {
  const m = PLAN_BLOCK.exec(summary);
  if (m?.[1] === undefined) return { ok: false, code: 'plan_missing' };
  let json: unknown;
  try {
    json = JSON.parse(m[1]);
  } catch {
    return { ok: false, code: 'plan_not_json' };
  }
  const parsed = PlanBody.safeParse(json);
  if (!parsed.success) return { ok: false, code: 'plan_invalid' };
  return { ok: true, tasks: parsed.data.tasks };
}
