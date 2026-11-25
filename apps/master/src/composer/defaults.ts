import { effectivePolicy } from '../security-policy/model.js';
import { loadSecurityDocument } from '../security-policy/service.js';
import {
  type ApprovalPolicy,
  effectiveRoutingRule,
  type JobRole,
  jobRoleOf,
  routedRuntime,
  type RuntimeKind,
  type SandboxProfile,
  type ScopedRoutingRule,
} from '@remyral/protocol';
import type { JobLimits } from '@remyral/scheduler';
import {
  type PlacementPreview,
  type PreviewDeps,
  previewPlacement,
  type RequirementsDraft,
} from './preview.js';
import type { Queryable } from '../db/pool.js';
import { sameRepository } from '../gitflow/refs.js';
import { loadRoutingRules } from '../routing/rules.js';

/**
 * p6-automation-defaults (docs/design/p6-automations.md §2a): an automation's job template takes the project's
 * defaults exactly like the job composer (apps/web/src/screens/composer — `bestHostProfile`, `defaultsFor`,
 * `withLimitDefaults`), so a chat draft, a REST create without a sandbox and the console form agree. Shared since
 * p6-chat-job-defaults by the assistant's one-off drafts (`draft_job`, `draft_workflow_run`, §2b):
 *
 * - **source trust** — `trusted` for a workspace project (the prompt is the user's own) and for the project's
 *   registered repository; any other repository stays untrusted (absent = untrusted, fail closed);
 * - **sandbox** — trusted: the best host profile some enrolled machine has ready when the project opted in to host
 *   execution (`host-restricted`, then `runtime-sandbox`), else `container`; untrusted: `container`. `unconfined` is
 *   never a default;
 * - **approval policy** — `ask-sensitive` (as in the composer; automations show it prominently because a run is
 *   unattended, design §11a);
 * - **runtime** (p6-smart-routing) — only when the template names none: the routing rule of the job's kind (explicit
 *   `role`, else the prompt heuristic; project override, else global) gives a runtime order and the first runtime
 *   some machine can take now (else could run) is used; no rule / nothing available = left out (the caller's own
 *   validation then asks for a runtime, as before);
 * - **model** — left out: the kind's routing rule, else the project's (or the global) default profile, is resolved
 *   at every submission by the job store;
 * - **limits** — 60 minutes, capped by the project's job limits, plus the project's cost/token/turn limits.
 *
 * Only fields the template leaves out are filled; an explicit choice is kept (the job store still refuses what is
 * not allowed, e.g. a host profile for an untrusted source).
 */

/** Host profiles in order of preference (the composer's `bestHostProfile`). */
const HOST_PREFERENCE: readonly SandboxProfile[] = ['host-restricted', 'runtime-sandbox'];
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = 'ask-sensitive';
const DEFAULT_DURATION_SEC = 3600;

export function bestHostProfile(
  hostExecution: boolean,
  sandbox: readonly { readonly profile: string; readonly workers: readonly string[] }[],
): SandboxProfile {
  if (!hostExecution) return 'container';
  for (const profile of HOST_PREFERENCE) {
    if ((sandbox.find((s) => s.profile === profile)?.workers.length ?? 0) > 0) return profile;
  }
  return 'container';
}

/** What decides the defaults of one project (from the placement preview's facts). */
export interface ProjectFacts {
  readonly workspace: boolean;
  readonly registeredRepositoryUrl: string | null;
  readonly hostExecution: boolean;
  readonly autoApproveExecution: boolean;
  /** p15-autonomy: the security policy's default for jobs that name no approval policy (absent: ask-sensitive). */
  readonly jobApproval?: 'allow-all' | 'ask-sensitive' | undefined;
  readonly sandbox: readonly { readonly profile: string; readonly workers: readonly string[] }[];
  readonly limits: JobLimits;
  /** p6-smart-routing: the project (for its routing overrides), global + project routing rules. */
  readonly project?: string | undefined;
  readonly routing?: readonly ScopedRoutingRule[] | undefined;
  /** p6-smart-routing: runtime availability from the placement preview (absent: no fleet facts). */
  readonly runtimes?:
    | readonly {
        readonly runtime: string;
        readonly eligible: readonly string[];
        readonly feasible: readonly string[];
      }[]
    | undefined;
}

export interface AppliedDefaults {
  readonly spec: Record<string, unknown>;
  /** Fields filled from the project's defaults (for the draft card and the audit). */
  readonly filled: readonly string[];
  /** p6-smart-routing: set when the runtime came from a routing rule. */
  readonly routing?: {
    readonly role: JobRole;
    readonly scope: 'project' | 'global';
    readonly runtime: RuntimeKind;
  };
}

/** p6-smart-routing: the runtime a kind's routing rule picks for the project (null: no rule / none available). */
export function routedRuntimeOf(
  facts: ProjectFacts,
  role: JobRole | null,
): { runtime: RuntimeKind; scope: 'project' | 'global' } | null {
  if (facts.project === undefined || facts.routing === undefined) return null;
  const rule = effectiveRoutingRule(facts.routing, facts.project, role);
  if (rule === null) return null;
  const runtime = routedRuntime(rule.runtimes, facts.runtimes);
  return runtime === null ? null : { runtime, scope: rule.scope };
}

/** Fills the fields a job template leaves out (pure; see the module comment). */
export function applyJobDefaults(spec: Record<string, unknown>, facts: ProjectFacts): AppliedDefaults {
  const out: Record<string, unknown> = { ...spec };
  const filled: string[] = [];
  let routing: AppliedDefaults['routing'];
  if (out.runtime === undefined) {
    const role = jobRoleOf({
      role: typeof out.role === 'string' ? out.role : undefined,
      prompt: typeof out.prompt === 'string' ? out.prompt : undefined,
    }).role;
    const routed = routedRuntimeOf(facts, role);
    if (routed !== null && role !== null) {
      out.runtime = routed.runtime;
      filled.push('runtime');
      routing = { role, scope: routed.scope, runtime: routed.runtime };
    }
  }
  if (out.sourceTrust === undefined) {
    const repo = out.repository as { url?: unknown } | undefined;
    const own =
      facts.workspace ||
      (facts.registeredRepositoryUrl !== null &&
        typeof repo?.url === 'string' &&
        sameRepository(repo.url, facts.registeredRepositoryUrl));
    if (own) {
      out.sourceTrust = 'trusted';
      filled.push('sourceTrust');
    }
  }
  if (out.sandboxProfile === undefined) {
    out.sandboxProfile =
      out.sourceTrust === 'trusted' ? bestHostProfile(facts.hostExecution, facts.sandbox) : 'container';
    filled.push('sandboxProfile');
  }
  if (out.approvalPolicy === undefined) {
    // p15-autonomy (ADR-0056): "never ask" by default where the security policy says so, the project allows it and
    // the source is trusted (the job store refuses allow-all otherwise); machine administration keeps its own gate.
    out.approvalPolicy =
      facts.jobApproval === 'allow-all' &&
      facts.autoApproveExecution &&
      out.sourceTrust === 'trusted' &&
      out.kind !== 'machine-admin'
        ? 'allow-all'
        : DEFAULT_APPROVAL_POLICY;
    filled.push('approvalPolicy');
  }
  const limits =
    typeof out.limits === 'object' && out.limits !== null
      ? { ...(out.limits as Record<string, unknown>) }
      : {};
  const l = facts.limits;
  let limitsFilled = false;
  if (limits.maxDurationSec === undefined) {
    limits.maxDurationSec =
      l.maxWallTimeSec === undefined
        ? DEFAULT_DURATION_SEC
        : Math.max(60, Math.min(DEFAULT_DURATION_SEC, l.maxWallTimeSec));
    limitsFilled = true;
  }
  for (const [key, value] of [
    ['maxCostUsd', l.maxCostUsd],
    ['maxTokens', l.maxTokens],
    ['maxTurns', l.maxTurns],
  ] as const) {
    if (limits[key] === undefined && value !== undefined) {
      limits[key] = value;
      limitsFilled = true;
    }
  }
  if (limitsFilled) filled.push('limits');
  out.limits = limits;
  return routing === undefined ? { spec: out, filled } : { spec: out, filled, routing };
}

/** The project's facts without the fleet (no preview deps, e.g. a test service): container, no limits. */
export async function projectFactsFromDb(db: Queryable, project: string): Promise<ProjectFacts> {
  const p = await db.query<{ kind: string; host_execution: boolean; auto_approve_execution: boolean }>(
    'SELECT kind, host_execution, auto_approve_execution FROM projects WHERE id = $1',
    [project],
  );
  const git = await db.query<{ repository_url: string }>(
    'SELECT repository_url FROM project_git_configs WHERE project = $1',
    [project],
  );
  return {
    workspace: p.rows[0]?.kind === 'workspace',
    registeredRepositoryUrl: git.rows[0]?.repository_url ?? null,
    hostExecution: p.rows[0]?.host_execution === true,
    autoApproveExecution: p.rows[0]?.auto_approve_execution === true,
    jobApproval: (
      await loadSecurityDocument(db)
        .then(effectivePolicy)
        .catch(() => null)
    )?.autonomy.jobApproval,
    sandbox: [],
    limits: {},
    project,
    routing: await loadRoutingRules(db, project),
  };
}

export function factsFromPreview(base: ProjectFacts, preview: PlacementPreview): ProjectFacts {
  return {
    ...base,
    hostExecution: preview.hostExecution,
    autoApproveExecution: preview.autoApproveExecution,
    sandbox: preview.sandbox,
    limits: preview.limits,
    runtimes: preview.runtimes,
  };
}

/** Where a job template could run now (the composer's placement preview), as a short verdict for drafts and forms. */
export interface PlacementAdvice {
  readonly verdict: 'placed' | 'waiting' | 'infeasible' | 'held';
  /** Machines that could take it now (names). */
  readonly machines: readonly string[];
  /** Set when no machine can run it at all (or a project rule refuses it): the draft must say so. */
  readonly warning: string | null;
  /** Set when it could run but not right now (machines offline / busy, quota hold). */
  readonly note: string | null;
}

function reasonText(summary: readonly { readonly message: string; readonly permanent: boolean }[]): string {
  const permanent = summary.filter((s) => s.permanent);
  const shown = (permanent.length > 0 ? permanent : summary).slice(0, 3).map((s) => s.message);
  return shown.length === 0 ? 'no enrolled machine' : shown.join('; ');
}

/** Runs the placement preview for a template (no side effects) and reduces it to advice. */
export async function placementAdvice(
  deps: PreviewDeps,
  project: string,
  spec: Record<string, unknown>,
): Promise<PlacementAdvice | null> {
  const runtime = spec.runtime as RuntimeKind | undefined;
  if (typeof runtime !== 'string') return null;
  const requirements = spec.requirements as RequirementsDraft | undefined;
  const preview = await previewPlacement(deps, {
    project,
    runtime,
    ...(typeof spec.model === 'string' ? { model: spec.model } : {}),
    ...(typeof spec.sandboxProfile === 'string'
      ? { sandboxProfile: spec.sandboxProfile as SandboxProfile }
      : {}),
    ...(spec.sourceTrust === 'trusted' || spec.sourceTrust === 'untrusted'
      ? { sourceTrust: spec.sourceTrust }
      : {}),
    ...(typeof spec.approvalPolicy === 'string'
      ? { approvalPolicy: spec.approvalPolicy as ApprovalPolicy }
      : {}),
    ...(requirements === undefined ? {} : { requirements }),
  });
  return adviceOf(preview);
}

export function adviceOf(preview: PlacementPreview): PlacementAdvice | null {
  const p = preview.placement;
  if (p === null) return null;
  const names = new Map(preview.workers.map((w) => [w.id, w.name]));
  const machines = p.candidates.map((c) => names.get(c.workerId) ?? c.workerId);
  const profile = preview.sandboxProfile;
  if (preview.issues.length > 0) {
    return {
      verdict: 'infeasible',
      machines: [],
      warning: `No machine can run this target as drafted: ${preview.issues.map((i) => i.message).join('; ')}.`,
      note: null,
    };
  }
  if (p.verdict === 'infeasible') {
    return {
      verdict: 'infeasible',
      machines: [],
      warning: `No machine can run this target (${p.runtime}, ${profile} sandbox): ${reasonText(p.summary)}. Its runs would fail or wait forever — change the sandbox or runtime, or prepare a machine first.`,
      note: null,
    };
  }
  if (p.verdict === 'waiting' || p.verdict === 'held') {
    return {
      verdict: p.verdict,
      machines: [],
      warning: null,
      note:
        p.verdict === 'held'
          ? `A project quota holds new jobs right now (${p.holds.map((h) => h.message).join('; ')}); runs wait until it clears.`
          : `No machine can take it right now (${reasonText(p.summary)}); runs wait until one can.`,
    };
  }
  return { verdict: 'placed', machines, warning: null, note: null };
}

const VERDICT_RANK: Readonly<Record<PlacementAdvice['verdict'], number>> = {
  placed: 0,
  waiting: 1,
  held: 2,
  infeasible: 3,
};

/**
 * p6-chat-job-defaults: one advice for a workflow run whose steps differ in runtime / sandbox — the worst verdict, the
 * machines that can take some step, and each step group's warning (or note) prefixed with its step ids.
 */
export function combineAdvice(
  groups: readonly { readonly steps: readonly string[]; readonly advice: PlacementAdvice | null }[],
): PlacementAdvice | null {
  const known = groups.filter(
    (g): g is { steps: readonly string[]; advice: PlacementAdvice } => g.advice !== null,
  );
  if (known.length === 0) return null;
  if (groups.length === 1) return known[0]?.advice ?? null;
  const label = (steps: readonly string[]): string =>
    `${steps.length === 1 ? 'Step' : 'Steps'} ${steps.join(', ')}`;
  const verdict = known.reduce<PlacementAdvice['verdict']>(
    (worst, g) => (VERDICT_RANK[g.advice.verdict] > VERDICT_RANK[worst] ? g.advice.verdict : worst),
    'placed',
  );
  const warnings = known.filter((g) => g.advice.warning !== null);
  const notes = known.filter((g) => g.advice.note !== null);
  return {
    verdict,
    machines: [...new Set(known.flatMap((g) => g.advice.machines))],
    warning:
      warnings.length === 0
        ? null
        : warnings.map((g) => `${label(g.steps)}: ${g.advice.warning ?? ''}`).join(' '),
    note:
      warnings.length > 0 || notes.length === 0
        ? null
        : notes.map((g) => `${label(g.steps)}: ${g.advice.note ?? ''}`).join(' '),
  };
}

export interface ProjectDefaultsDeps {
  readonly db: Queryable;
  /** The composer's placement preview; absent or throwing (services not initialised): project row only. */
  readonly preview?: (() => PreviewDeps) | undefined;
  /** Where a failed preview is reported (the defaults then fall back to `container`, the advice to none). */
  readonly onError?: (err: unknown, what: 'defaults' | 'placement', project: string) => void;
}

/**
 * The project defaults and placement advice as one injectable service, shared by automations (§2a) and the
 * assistant's one-off job / workflow-run drafts (§2b) so every drafting path fills and checks a job the same way.
 */
export class ProjectDefaults {
  constructor(private readonly deps: ProjectDefaultsDeps) {}

  #previewDeps(): PreviewDeps | undefined {
    try {
      return this.deps.preview?.();
    } catch {
      return undefined; // services not initialised yet
    }
  }

  /** The project's facts: the composer's placement preview when available, else the project row (container). */
  async facts(project: string): Promise<ProjectFacts> {
    const base = await projectFactsFromDb(this.deps.db, project);
    const deps = this.#previewDeps();
    if (deps === undefined) return base;
    try {
      return factsFromPreview(base, await previewPlacement(deps, { project, sourceTrust: 'trusted' }));
    } catch (err) {
      this.deps.onError?.(err, 'defaults', project);
      return base;
    }
  }

  /** Fills what a job spec leaves out with the project's defaults (explicit values are kept). */
  async apply(project: string, spec: Record<string, unknown>): Promise<AppliedDefaults> {
    return applyJobDefaults(spec, await this.facts(project));
  }

  /** p6-smart-routing: the runtime the routing rule of `role` picks for the project now (null: none). */
  async runtimeFor(project: string, role: JobRole): Promise<RuntimeKind | null> {
    return routedRuntimeOf(await this.facts(project), role)?.runtime ?? null;
  }

  /** Where a job spec could run now (no side effects); null without preview facts or on a preview failure. */
  async placement(project: string, spec: Record<string, unknown>): Promise<PlacementAdvice | null> {
    const deps = this.#previewDeps();
    if (deps === undefined) return null;
    try {
      return await placementAdvice(deps, project, spec);
    } catch (err) {
      this.deps.onError?.(err, 'placement', project);
      return null;
    }
  }
}

/**
 * p16-workflow-quality (design §2): a drafted workflow's run-wide `defaults` take the project's defaults exactly like a
 * job (`applyJobDefaults`): only what the document leaves out is filled. The source is trusted when the run works on
 * the project's own repository (no `defaults.repository`, or the registered one) or on none at all (scratch steps of a
 * repository project, a workspace project) — then the best ready host profile applies where the project allows host
 * execution. The runtime comes from the routing rule of `execute`, else the first runtime a machine can take, else
 * `claude-code` (the schema needs one; a workflow without AI steps never starts it).
 */
export function applyWorkflowDefaults(
  doc: Record<string, unknown>,
  facts: ProjectFacts,
): { doc: Record<string, unknown>; filled: string[] } {
  const given =
    typeof doc.defaults === 'object' && doc.defaults !== null && !Array.isArray(doc.defaults)
      ? (doc.defaults as Record<string, unknown>)
      : {};
  const repo = given.repository as { url?: unknown } | undefined;
  const own =
    facts.workspace ||
    repo === undefined ||
    (facts.registeredRepositoryUrl !== null &&
      typeof repo.url === 'string' &&
      sameRepository(repo.url, facts.registeredRepositoryUrl));
  const trust = given.sourceTrust === undefined && own;
  const applied = applyJobDefaults(
    { ...given, role: 'execute', ...(trust ? { sourceTrust: 'trusted' } : {}) },
    facts,
  );
  const filled = applied.filled.filter((f) => f !== 'sourceTrust');
  const out: Record<string, unknown> = { ...given };
  for (const k of ['runtime', 'sandboxProfile', 'approvalPolicy', 'limits'] as const) {
    if (applied.spec[k] !== undefined) out[k] = applied.spec[k];
  }
  if (trust) {
    out.sourceTrust = 'trusted';
    filled.push('sourceTrust');
  }
  if (out.runtime === undefined) {
    const ready =
      facts.runtimes?.find((r) => r.feasible.length > 0) ??
      facts.runtimes?.find((r) => r.eligible.length > 0);
    out.runtime = ready?.runtime ?? 'claude-code';
    filled.push('runtime');
  }
  return { doc: { ...doc, defaults: out }, filled };
}
