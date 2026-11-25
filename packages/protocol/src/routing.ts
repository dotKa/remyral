import { z } from 'zod';
import { RuntimeKind } from './common.js';

/**
 * p6-smart-routing (docs/design/p6-smart-routing.md): job kinds ("roles") and the routing rules that map a kind to a
 * preferred model profile and a runtime order. Pure; shared by the master (job store, defaults, statistics) and the
 * console.
 */

export const JOB_ROLES = ['plan', 'execute', 'verify', 'summarise', 'research', 'chore'] as const;
export const JobRole = z.enum(JOB_ROLES);
export type JobRole = z.infer<typeof JobRole>;

/** Workflow step roles (p4-dag) → job kind. A reviewer verifies; an integrator merges (a chore). */
export const WORKFLOW_STEP_KIND: Readonly<Record<string, JobRole>> = {
  planner: 'plan',
  executor: 'execute',
  verifier: 'verify',
  reviewer: 'verify',
  integrator: 'chore',
};

/** How much of the prompt the heuristic reads (the composer sends only this much to the preview). */
export const ROLE_HINT_CHARS = 400;

/**
 * Leading-verb patterns, checked in this order on the first non-empty line (lower-cased, a leading "please" and
 * markdown markers removed). Only the start of the task counts: "fix the bug, then review" is execute.
 */
const PATTERNS: readonly (readonly [JobRole, RegExp])[] = [
  ['summarise', /^(summari[sz]e|summary of|tl;?dr|recap|özetle)\b/u],
  ['plan', /^(plan|design|propose|outline|break down|planla)\b/u],
  [
    'verify',
    /^(review|verify|validate|audit|check whether|check that|check if|test whether|doğrula|gözden geçir|kontrol et)\b/u,
  ],
  ['research', /^(research|investigate|compare|find out|look into|explore|araştır)\b/u],
  ['chore', /^(bump|upgrade|update (the )?dependenc|format|lint|rename|tidy|clean up|regenerate|sync)\b/u],
  ['execute', /^(implement|fix|add|build|refactor|create|write code|port|migrate|düzelt|ekle|uygula)\b/u],
];

/**
 * The conservative kind heuristic: a kind only when the task *starts* with one of the verbs above, else null (no
 * guess). Deterministic; reads at most {@link ROLE_HINT_CHARS} characters.
 */
export function inferJobRole(prompt: string): JobRole | null {
  const head = prompt.slice(0, ROLE_HINT_CHARS);
  const line = head
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (line === undefined) return null;
  const text = line
    .toLowerCase()
    .replace(/^[#>*\-\s`]+/u, '')
    .replace(/^(please|pls|lütfen)[,:]?\s+/u, '');
  for (const [role, re] of PATTERNS) if (re.test(text)) return role;
  return null;
}

export interface ResolvedJobRole {
  readonly role: JobRole | null;
  /** `explicit`: JobSpec.role; `inferred`: the heuristic; null: no kind. */
  readonly source: 'explicit' | 'inferred' | null;
}

/** The job's kind: its explicit role, else the heuristic; machine-administration jobs have none. */
export function jobRoleOf(spec: {
  readonly role?: string | undefined;
  readonly prompt?: string | undefined;
  readonly kind?: string | undefined;
}): ResolvedJobRole {
  if (spec.kind === 'machine-admin') return { role: null, source: null };
  const explicit = JobRole.safeParse(spec.role);
  if (explicit.success) return { role: explicit.data, source: 'explicit' };
  const inferred = typeof spec.prompt === 'string' ? inferJobRole(spec.prompt) : null;
  return inferred === null ? { role: null, source: null } : { role: inferred, source: 'inferred' };
}

/** One routing rule: a kind's preferred catalog model profile and runtime order (both optional). */
export const RoutingRule = z.strictObject({
  role: JobRole,
  /** Model catalog id preferred for this kind (used only when the job names no model and the job's runtime has it). */
  modelProfile: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .nullable(),
  /** Runtimes in order of preference (a drafting path takes the first one some machine can run). */
  runtimes: z.array(RuntimeKind).max(RuntimeKind.options.length),
});
export type RoutingRule = z.infer<typeof RoutingRule>;

export interface ScopedRoutingRule extends RoutingRule {
  /** null = global (Settings → Models → Routing); else the project of the override (Projects → Policy). */
  readonly project: string | null;
}

export interface EffectiveRoutingRule extends RoutingRule {
  readonly scope: 'project' | 'global';
}

/** A project's own rule for the kind replaces the global one as a whole; else the global rule; else null. */
export function effectiveRoutingRule(
  rules: readonly ScopedRoutingRule[],
  project: string,
  role: JobRole | null,
): EffectiveRoutingRule | null {
  if (role === null) return null;
  const own = rules.find((r) => r.project === project && r.role === role);
  if (own !== undefined) return { ...strip(own), scope: 'project' };
  const global = rules.find((r) => r.project === null && r.role === role);
  return global === undefined ? null : { ...strip(global), scope: 'global' };
}

function strip(r: ScopedRoutingRule): RoutingRule {
  return { role: r.role, modelProfile: r.modelProfile, runtimes: [...r.runtimes] };
}

/**
 * The runtime a drafting path takes from a rule's order: the first one some machine can take now, else the first
 * one some machine could run at all, else null (no guess: the draft then has to name a runtime).
 * `availability` absent (no fleet facts): the first runtime of the order.
 */
export function routedRuntime(
  order: readonly RuntimeKind[],
  availability?: readonly {
    readonly runtime: string;
    readonly eligible: readonly string[];
    readonly feasible: readonly string[];
  }[],
): RuntimeKind | null {
  if (order.length === 0) return null;
  if (availability === undefined) return order[0] ?? null;
  const of = (r: RuntimeKind) => availability.find((a) => a.runtime === r);
  return (
    order.find((r) => (of(r)?.eligible.length ?? 0) > 0) ??
    order.find((r) => (of(r)?.feasible.length ?? 0) > 0) ??
    null
  );
}
