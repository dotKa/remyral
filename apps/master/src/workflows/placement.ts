import {
  isRetiredRuntime,
  type JobRole,
  type JobSpec,
  resolveCapabilities,
  RuntimeKind,
  SUBTASK_LIMITS,
} from '@remyral/protocol';
import type { GraphIssue } from '@remyral/scheduler';
import type { Queryable } from '../db/pool.js';
import { loadCatalog } from '../models/service.js';
import { catalogProblem } from '../orchestration/credential-facts.js';
import { readDelegation } from '../subtasks/service.js';
import type { WorkflowDefinition } from './definition.js';

/**
 * p8-orchestration (docs/design/p8-orchestration.md §2): where a workflow step runs and why.
 *
 * Planner hints (`runtime`, `model`, `requires`, `machine`) are untrusted data written by an agent. They are resolved
 * against an allowlist — the planner's runtime, every runtime the definition names and the project's delegation
 * runtimes — never against the plan itself; models only as enabled catalog profiles for that runtime; capability tags
 * only from the protocol's list; machine hints only as approved, non-revoked workers (else ignored with a note).
 */

export type PlacementSource = 'node' | 'plan' | 'requires' | 'routing' | 'planner' | 'default';

/** `workflow_nodes.placement`: shown on the run view next to the machine the job ran on. */
export interface StepPlacement {
  readonly runtime: RuntimeKind;
  readonly source: PlacementSource;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly machine?: { readonly id: string; readonly name: string };
  readonly notes: readonly string[];
}

/** Planner hints of one task (already schema-checked by `parsePlan`). */
export interface PlanHints {
  readonly id: string;
  readonly role?: 'executor' | 'verifier' | undefined;
  readonly runtime?: string | undefined;
  readonly model?: string | undefined;
  readonly requires?: readonly string[] | undefined;
  readonly machine?: string | undefined;
}

/** Runtimes a definition names itself (defaults, nodes, fallbacks): the author's own choices. */
export function definitionRuntimes(def: WorkflowDefinition): RuntimeKind[] {
  const out = new Set<RuntimeKind>([def.defaults.runtime]);
  for (const f of def.defaults.fallbacks ?? []) out.add(f.runtime);
  for (const n of def.nodes) {
    if (n.runtime !== undefined) out.add(n.runtime);
    for (const f of n.fallbacks ?? []) out.add(f.runtime);
  }
  return [...out];
}

const ROLE_KIND: Readonly<Record<string, JobRole>> = { executor: 'execute', verifier: 'verify' };

export interface ResolvedTask {
  /** Overrides on top of the planner step's spec. */
  readonly patch: Pick<JobSpec, 'runtime'> & {
    readonly model?: string | undefined;
    readonly requirements?: JobSpec['requirements'];
  };
  readonly placement: StepPlacement;
}

/**
 * Resolves every task of a plan; any hint outside the allowlist rejects the whole plan with paths and codes (the run
 * view then names the allowed runtimes). Machine hints never reject a plan: unknown ones are ignored with a note.
 */
export async function resolvePlanTasks(
  db: Queryable,
  input: {
    readonly project: string;
    readonly def: WorkflowDefinition;
    readonly planner: JobSpec;
    readonly tasks: readonly PlanHints[];
    readonly routeRuntime?: ((project: string, role: JobRole) => Promise<RuntimeKind | null>) | undefined;
  },
): Promise<
  { ok: true; tasks: Map<string, ResolvedTask> } | { ok: false; issues: GraphIssue[]; allowed: RuntimeKind[] }
> {
  const delegation = await readDelegation(db, input.project);
  const allowed = [
    ...new Set<RuntimeKind>([
      input.planner.runtime,
      ...definitionRuntimes(input.def),
      ...delegation.delegationRuntimes,
    ]),
  ];
  const issues: GraphIssue[] = [];
  const out = new Map<string, ResolvedTask>();
  const needsCatalog = input.tasks.some((t) => t.model !== undefined);
  const catalog = needsCatalog ? await loadCatalog(db) : null;
  const routed = new Map<JobRole, RuntimeKind | null>();
  for (const [i, t] of input.tasks.entries()) {
    const path = `tasks.${String(i)}`;
    const notes: string[] = [];
    const caps = resolveCapabilities(t.requires ?? []);
    if ((t.requires ?? []).length > SUBTASK_LIMITS.maxRequires)
      issues.push({ path: `${path}.requires`, code: 'too_many' });
    if (caps.unknown.length > 0) {
      issues.push({
        path: `${path}.requires`,
        code: `unknown_capability:${caps.unknown[0] ?? ''}`.slice(0, 64),
      });
      continue;
    }
    let runtime: RuntimeKind;
    let source: PlacementSource;
    if (t.runtime !== undefined) {
      const parsed = RuntimeKind.safeParse(t.runtime);
      if (!parsed.success || isRetiredRuntime(t.runtime) || !allowed.includes(parsed.data)) {
        issues.push({ path: `${path}.runtime`, code: 'not_allowed' });
        continue;
      }
      if (caps.runtimes !== null && !caps.runtimes.includes(parsed.data)) {
        issues.push({ path: `${path}.requires`, code: 'runtime_conflict' });
        continue;
      }
      runtime = parsed.data;
      source = 'plan';
      notes.push('chosen by the planner');
    } else if (caps.runtimes !== null) {
      const pick = caps.runtimes.find((r) => allowed.includes(r));
      if (pick === undefined) {
        issues.push({ path: `${path}.requires`, code: 'runtime_not_allowed' });
        continue;
      }
      runtime = pick;
      source = 'requires';
      notes.push(`${(t.requires ?? []).join(', ')} needs ${pick}`);
    } else {
      const kind = ROLE_KIND[t.role ?? 'executor'] ?? 'execute';
      if (!routed.has(kind)) {
        routed.set(
          kind,
          input.routeRuntime === undefined
            ? null
            : await input.routeRuntime(input.project, kind).catch(() => null),
        );
      }
      const r = routed.get(kind) ?? null;
      if (r !== null && allowed.includes(r)) {
        runtime = r;
        source = 'routing';
        notes.push(`the project’s routing rule for ${kind} work`);
      } else {
        runtime = input.planner.runtime;
        source = 'planner';
        notes.push('the planner step’s runtime');
      }
    }
    let model: string | undefined;
    if (t.model !== undefined) {
      if (catalog === null || !catalog.has(t.model) || catalogProblem(catalog, t.model, runtime) !== null) {
        issues.push({ path: `${path}.model`, code: 'not_allowed' });
        continue;
      }
      model = t.model;
      notes.push(`model profile ${t.model} named by the planner`);
    } else if (runtime === input.planner.runtime && input.planner.model !== undefined) {
      model = input.planner.model;
    }
    let machine: { id: string; name: string } | undefined;
    if (t.machine !== undefined) {
      const { rows } = await db.query<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM workers
          WHERE (id = $1 OR lower(display_name) = lower($1))
            AND approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL
          ORDER BY (id = $1) DESC LIMIT 1`,
        [t.machine],
      );
      const w = rows[0];
      if (w === undefined) {
        notes.push(
          `machine hint “${t.machine.slice(0, 64)}” is not an enrolled machine — placed by the scheduler`,
        );
      } else {
        machine = { id: w.id, name: w.display_name };
        notes.push(`pinned to ${w.display_name} (planner’s machine hint)`);
      }
    }
    const tools = [...new Set([...(input.planner.requirements?.tools ?? []), ...caps.tools])].sort();
    const requirements: JobSpec['requirements'] =
      tools.length === 0 && machine === undefined && input.planner.requirements === undefined
        ? undefined
        : {
            ...(input.planner.requirements ?? {}),
            ...(tools.length === 0 ? {} : { tools }),
            ...(machine === undefined ? {} : { workers: [machine.id] }),
          };
    out.set(t.id, {
      patch: { runtime, model, requirements },
      placement: {
        runtime,
        source,
        ...(model === undefined ? {} : { model }),
        ...(caps.tools.length === 0 ? {} : { tools: caps.tools }),
        ...(machine === undefined ? {} : { machine }),
        notes,
      },
    });
  }
  return issues.length > 0 ? { ok: false, issues, allowed } : { ok: true, tasks: out };
}

/** Placement of a static node, recorded when the run starts. */
export function staticPlacement(input: {
  readonly nodeRuntime: RuntimeKind | undefined;
  readonly routed: RuntimeKind | undefined;
  readonly spec: JobSpec;
}): StepPlacement {
  const source: PlacementSource =
    input.nodeRuntime !== undefined ? 'node' : input.routed !== undefined ? 'routing' : 'default';
  const notes =
    source === 'node'
      ? ['set on the step']
      : source === 'routing'
        ? ['the project’s routing rule for this kind of step']
        : ['the workflow’s default runtime'];
  const tools = input.spec.requirements?.tools ?? [];
  const pinned = input.spec.requirements?.workers ?? [];
  if (pinned.length > 0) notes.push(`pinned to ${pinned.join(', ')}`);
  return {
    runtime: input.spec.runtime,
    source,
    ...(input.spec.model === undefined ? {} : { model: input.spec.model }),
    ...(tools.length === 0 ? {} : { tools }),
    notes,
  };
}
