import { z } from 'zod';
import type { Role } from '../auth/users.js';

/**
 * Declarative approval policy (docs/design/p4-approvals.md, ADR-0010).
 *
 * Pure and DB-free. Authority order (highest first): platform → project → job → repository content.
 * - The **platform** layer is this file: a default rule per action plus a *floor* nobody below it can
 *   weaken (merge, force push, protected push, deploy and destructive actions always need a human).
 * - The **project** layer is set by an owner/admin in the console (versioned in `project_policies`). It
 *   may tighten anything and relax only down to the floor; rules below the floor are rejected on write
 *   and clamped again on evaluation (defence in depth).
 * - The **job** layer (`JobSpec.approvalPolicy`, from an authenticated user's prompt) can only tighten.
 * - **Repository content** (AGENTS.md, config files, PR text…) is never an input. `resolveRule` accepts it
 *   only to report that it was ignored, so callers can audit the attempt.
 */

export const APPROVAL_ACTIONS = [
  'git.push_protected',
  'git.merge',
  'git.force_push',
  'deploy',
  'fs.delete_outside_workspace',
  'network.egress_non_allowlisted',
  'secret.read',
  'runtime.dangerous_tool',
  'job.budget_increase',
  /**
   * p5-machine-admin (ADR-0021): one elevated command (root / Administrator / SYSTEM) of a machine-admin job. The
   * master signs it only after this approval (or, for an `allow-all` job, when the Machines project and the worker
   * both allow auto-approve — then no request is opened at all).
   */
  'machine.admin',
  /**
   * p14-mcp-core (ADR-0054): a call of an external MCP server's tool whose tool policy says `ask`. The tool policy
   * (allow / ask / deny per tool) decides whether a request is opened at all; the project can tighten this rule but
   * never let it pass without an admin (floor).
   */
  'tool.mcp',
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const POLICY_OUTCOMES = ['allow', 'require_approval', 'deny'] as const;
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

export const RISKS = ['low', 'medium', 'high', 'critical'] as const;
export type Risk = (typeof RISKS)[number];

/** Roles that may approve, weakest first. `viewer` can never approve. */
export const APPROVER_ROLES = ['operator', 'admin', 'owner'] as const;
export type ApproverRole = (typeof APPROVER_ROLES)[number];

/** Upper bound for the number of distinct approvers a rule may require (modelled now; 1 is typical). */
export const MAX_REQUIRED_APPROVALS = 5;
export const MIN_EXPIRY_SEC = 60;
export const MAX_EXPIRY_SEC = 7 * 24 * 3600;

/**
 * `JobSpec.approvalPolicy` — the job (prompt) layer. `allow-all` (ADR-0020) only tells the *runtime* not to ask
 * before its own tool calls; at this layer it changes nothing (a job can never loosen a platform or project rule), so
 * protected merge, force push, deploy, deletes outside the workspace and secrets keep their master approvals.
 */
export type JobApprovalMode = 'ask-all' | 'ask-sensitive' | 'deny-sensitive' | 'allow-all';

export interface PolicyRule {
  readonly outcome: PolicyOutcome;
  /** Weakest role allowed to approve. */
  readonly approverRole: ApproverRole;
  /** Distinct users that must approve; one deny decides. */
  readonly requiredApprovals: number;
  /** A pending request expires after this many seconds. */
  readonly expiresInSec: number;
  /** Deciding requires a TOTP verification within the step-up window (ADR-0009 §10). */
  readonly stepUp: boolean;
  readonly risk: Risk;
}

/** The weakest rule a project may configure. */
export interface PolicyFloor {
  readonly outcome: PolicyOutcome;
  readonly approverRole: ApproverRole;
  readonly requiredApprovals: number;
  readonly stepUp: boolean;
  readonly maxExpiresInSec: number;
}

export interface PlatformRule {
  readonly default: PolicyRule;
  readonly floor: PolicyFloor;
  readonly description: string;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

function rule(
  outcome: PolicyOutcome,
  approverRole: ApproverRole,
  risk: Risk,
  expiresInSec: number,
  stepUp = true,
): PolicyRule {
  return { outcome, approverRole, requiredApprovals: 1, expiresInSec, stepUp, risk };
}

function floor(
  outcome: PolicyOutcome,
  approverRole: ApproverRole,
  stepUp: boolean,
  maxExpiresInSec: number,
): PolicyFloor {
  return { outcome, approverRole, requiredApprovals: 1, stepUp, maxExpiresInSec };
}

/** Platform policy: the top of the authority order. Changing it is a code change with review. */
export const PLATFORM_POLICY: Readonly<Record<ApprovalAction, PlatformRule>> = {
  'git.push_protected': {
    default: rule('require_approval', 'admin', 'high', DAY),
    floor: floor('require_approval', 'admin', true, 7 * DAY),
    description: 'Push to a protected branch',
  },
  'git.merge': {
    default: rule('require_approval', 'admin', 'high', 7 * DAY),
    floor: floor('require_approval', 'admin', true, 7 * DAY),
    description: 'Merge into a protected branch (integrator step)',
  },
  'git.force_push': {
    default: rule('deny', 'owner', 'critical', HOUR),
    floor: floor('require_approval', 'admin', true, DAY),
    description: 'Force push / history rewrite',
  },
  deploy: {
    default: rule('require_approval', 'admin', 'critical', DAY),
    floor: floor('require_approval', 'admin', true, 7 * DAY),
    description: 'Deployment to any environment',
  },
  'fs.delete_outside_workspace': {
    default: rule('deny', 'owner', 'critical', HOUR),
    floor: floor('require_approval', 'admin', true, DAY),
    description: 'Delete files outside the job workspace',
  },
  'network.egress_non_allowlisted': {
    default: rule('require_approval', 'operator', 'medium', HOUR),
    floor: floor('require_approval', 'operator', false, DAY),
    description: 'Network access to a host outside the project allowlist',
  },
  'secret.read': {
    default: rule('require_approval', 'admin', 'high', HOUR),
    floor: floor('require_approval', 'admin', true, DAY),
    description: 'Read a secret beyond the job’s granted references',
  },
  'runtime.dangerous_tool': {
    default: rule('require_approval', 'operator', 'medium', HOUR),
    floor: floor('allow', 'operator', false, DAY),
    description: 'A tool call the runtime itself reports as needing approval',
  },
  'job.budget_increase': {
    default: rule('require_approval', 'admin', 'medium', DAY),
    floor: floor('require_approval', 'operator', false, 7 * DAY),
    description: 'Raise a job’s cost or duration budget',
  },
  'machine.admin': {
    default: rule('require_approval', 'admin', 'critical', HOUR),
    floor: floor('require_approval', 'admin', true, DAY),
    description: 'Run one elevated command (root / Administrator) of a machine administration job',
  },
  'tool.mcp': {
    default: rule('require_approval', 'admin', 'high', HOUR, false),
    floor: floor('require_approval', 'admin', false, DAY),
    description: 'Call a tool of an external MCP server that its tool policy marks "ask"',
  },
};

const OUTCOME_RANK: Readonly<Record<PolicyOutcome, number>> = { allow: 0, require_approval: 1, deny: 2 };
const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2, owner: 3 };
const RISK_RANK: Readonly<Record<Risk, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

export function isApprovalAction(v: unknown): v is ApprovalAction {
  return typeof v === 'string' && (APPROVAL_ACTIONS as readonly string[]).includes(v);
}

/**
 * Maps an action string reported by a runtime/worker to the catalog. Anything unknown is treated as a
 * runtime-reported dangerous tool call — never as something weaker.
 */
export function classifyAction(raw: string): ApprovalAction {
  return isApprovalAction(raw) ? raw : 'runtime.dangerous_tool';
}

export function roleMayApprove(role: Role, required: ApproverRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

// ------------------------------------------------------------------------------------------ project layer

export const PolicyRuleInput = z.strictObject({
  outcome: z.enum(POLICY_OUTCOMES),
  approverRole: z.enum(APPROVER_ROLES).optional(),
  requiredApprovals: z.number().int().min(1).max(MAX_REQUIRED_APPROVALS).optional(),
  expiresInSec: z.number().int().min(MIN_EXPIRY_SEC).max(MAX_EXPIRY_SEC).optional(),
  stepUp: z.boolean().optional(),
  risk: z.enum(RISKS).optional(),
});
export type PolicyRuleInput = z.infer<typeof PolicyRuleInput>;

/** A project's rules: any subset of the catalog; unknown actions are rejected. */
export const ProjectPolicyRules = z.partialRecord(z.enum(APPROVAL_ACTIONS), PolicyRuleInput);
export type ProjectPolicyRules = z.infer<typeof ProjectPolicyRules>;

export interface ProjectPolicy {
  readonly version: number;
  readonly rules: ProjectPolicyRules;
}

export type FloorField = 'outcome' | 'approverRole' | 'requiredApprovals' | 'stepUp' | 'expiresInSec';

export interface FloorViolation {
  readonly action: ApprovalAction;
  readonly field: FloorField;
}

function mergeProject(action: ApprovalAction, input: PolicyRuleInput | undefined): PolicyRule {
  const base = PLATFORM_POLICY[action].default;
  if (!input) return base;
  return {
    outcome: input.outcome,
    approverRole: input.approverRole ?? base.approverRole,
    requiredApprovals: input.requiredApprovals ?? base.requiredApprovals,
    expiresInSec: input.expiresInSec ?? base.expiresInSec,
    stepUp: input.stepUp ?? base.stepUp,
    risk: input.risk ?? base.risk,
  };
}

function violations(action: ApprovalAction, r: PolicyRule): FloorField[] {
  const f = PLATFORM_POLICY[action].floor;
  const out: FloorField[] = [];
  if (OUTCOME_RANK[r.outcome] < OUTCOME_RANK[f.outcome]) out.push('outcome');
  if (r.outcome === 'require_approval') {
    if (ROLE_RANK[r.approverRole] < ROLE_RANK[f.approverRole]) out.push('approverRole');
    if (r.requiredApprovals < f.requiredApprovals) out.push('requiredApprovals');
    if (f.stepUp && !r.stepUp) out.push('stepUp');
    if (r.expiresInSec > f.maxExpiresInSec) out.push('expiresInSec');
  }
  return out;
}

/** Every place where a project's rules would be weaker than the platform floor (write-time check). */
export function checkProjectRules(rules: ProjectPolicyRules): FloorViolation[] {
  const out: FloorViolation[] = [];
  for (const action of APPROVAL_ACTIONS) {
    const input = rules[action];
    if (!input) continue;
    for (const field of violations(action, mergeProject(action, input))) out.push({ action, field });
  }
  return out;
}

/** Raises `r` to the platform floor field by field (evaluation-time clamp). */
function clampToFloor(action: ApprovalAction, r: PolicyRule): PolicyRule {
  const f = PLATFORM_POLICY[action].floor;
  const d = PLATFORM_POLICY[action].default;
  if (OUTCOME_RANK[r.outcome] < OUTCOME_RANK[f.outcome]) {
    // Re-enter at the floor outcome with the platform default's approval parameters.
    return clampToFloor(action, { ...d, outcome: f.outcome, risk: maxRisk(r.risk, d.risk) });
  }
  if (r.outcome !== 'require_approval') return r;
  return {
    ...r,
    approverRole: ROLE_RANK[r.approverRole] < ROLE_RANK[f.approverRole] ? f.approverRole : r.approverRole,
    requiredApprovals: Math.max(r.requiredApprovals, f.requiredApprovals),
    stepUp: r.stepUp || f.stepUp,
    expiresInSec: Math.min(r.expiresInSec, f.maxExpiresInSec),
  };
}

// ------------------------------------------------------------------------------------------ resolution

export type PolicySource = 'platform' | 'project' | 'job' | 'security_policy';

export interface ResolvedRule extends PolicyRule {
  readonly action: ApprovalAction;
  /**
   * p15-auto-mode: `allow` came from the owner's "Otomatik mod" (approved via security_policy without a person);
   * `floor`: auto mode kept a human for an action of its hard floor that the autonomy set would have let pass.
   */
  readonly autoMode?: 'granted' | 'floor';
  /** Project policy version in force when the rule was resolved (0 = no project policy stored). */
  readonly policyVersion: number;
  /** Layers that changed the outcome or parameters, in authority order. */
  readonly sources: readonly PolicySource[];
  /** Inputs that were offered but have no authority (always `repository` when present). */
  readonly ignored: readonly 'repository'[];
}

export interface PolicyLayers {
  readonly project?: ProjectPolicy | null;
  readonly job?: JobApprovalMode | null;
  /**
   * Policy-like content found in the repository (config files, AGENTS.md directives, PR text). Has no
   * authority (ADR-0010 §1); accepted only so the attempt is reported in `ignored` and can be audited.
   */
  readonly repository?: unknown;
  /**
   * p15-autonomy (ADR-0056): actions the owner's security policy lets pass for "never ask" (`allow-all`) jobs. The
   * owner's policy is the human approval policy of AGENTS.md rule 10 for them: such an action resolves to `allow`
   * (source `security_policy`). It never applies to other job modes, and `machine.admin` is never in the set.
   */
  readonly autonomy?: ReadonlySet<ApprovalAction> | null;
  /**
   * p15-auto-mode ("Otomatik mod", docs/design/p15-auto-mode.md): the owner's auto mode applies to this job — the
   * caller checked that the policy has it on, the job's source is trusted and the job is not machine administration.
   * Every `require_approval` outside {@link AUTO_MODE_FLOOR} resolves to `allow` (source `security_policy`) unless the
   * job asked for more prompts (`ask-all`, `deny-sensitive`); a `deny` is never turned into an allow. Actions of the
   * floor always ask a human, even where the autonomy set would let them pass.
   */
  readonly autoMode?: boolean | null;
}

/**
 * p15-auto-mode: the hard floor auto mode never grants — elevated machine commands (ADR-0021), force push / history
 * rewrite and deletes outside the workspace (destructive). A person decides them (in chat: the assistant approves the
 * pending request when the user explicitly says so).
 */
export const AUTO_MODE_FLOOR: ReadonlySet<ApprovalAction> = new Set<ApprovalAction>([
  'machine.admin',
  'git.force_push',
  'fs.delete_outside_workspace',
]);

/** Effective rule for one action under the authority order platform → project → job (repository ignored). */
export function resolveRule(action: ApprovalAction, layers: PolicyLayers = {}): ResolvedRule {
  const sources: PolicySource[] = ['platform'];
  const projectInput = layers.project?.rules[action];
  let r = mergeProject(action, projectInput);
  if (projectInput) sources.push('project');
  r = clampToFloor(action, r);

  const beforeAutonomy = r;
  let autoMode: 'granted' | 'floor' | undefined;
  // p15-autonomy: the owner's security policy may let an action of a "never ask" job pass without a human.
  if (
    layers.job === 'allow-all' &&
    action !== 'machine.admin' &&
    layers.autonomy?.has(action) === true &&
    r.outcome !== 'allow'
  ) {
    if (layers.autoMode === true && AUTO_MODE_FLOOR.has(action)) {
      // p15-auto-mode: the floor asks a human (a platform `deny` default becomes a request a person can decide).
      const d = PLATFORM_POLICY[action].default;
      r =
        beforeAutonomy.outcome === 'require_approval'
          ? beforeAutonomy
          : clampToFloor(action, { ...d, outcome: 'require_approval' });
      autoMode = 'floor';
    } else {
      r = { ...r, outcome: 'allow' };
      sources.push('security_policy');
    }
  }

  // p15-auto-mode: "Otomatik mod" grants every request outside the floor for jobs that did not ask for more prompts.
  if (
    layers.autoMode === true &&
    !AUTO_MODE_FLOOR.has(action) &&
    r.outcome === 'require_approval' &&
    layers.job !== 'ask-all' &&
    layers.job !== 'deny-sensitive'
  ) {
    r = { ...r, outcome: 'allow' };
    sources.push('security_policy');
  }
  if (layers.autoMode === true && r.outcome === 'allow' && sources.includes('security_policy'))
    autoMode = 'granted';

  // Job layer: may only tighten (`allow-all` and `ask-sensitive` leave the rule as it is).
  if (layers.job === 'deny-sensitive' && r.outcome === 'require_approval') {
    r = { ...r, outcome: 'deny' };
    sources.push('job');
  } else if (layers.job === 'ask-all' && r.outcome === 'allow') {
    const d = PLATFORM_POLICY[action].default;
    r = { ...d, outcome: 'require_approval', risk: maxRisk(r.risk, d.risk) };
    sources.push('job');
  }

  return {
    ...r,
    action,
    ...(autoMode === undefined ? {} : { autoMode }),
    policyVersion: layers.project?.version ?? 0,
    sources,
    ignored: layers.repository === undefined || layers.repository === null ? [] : ['repository'],
  };
}

/** Effective rules for every action (console view, `GET /projects/:id/policy`). */
export function resolveAll(layers: PolicyLayers = {}): Record<ApprovalAction, ResolvedRule> {
  const out = {} as Record<ApprovalAction, ResolvedRule>;
  for (const action of APPROVAL_ACTIONS) out[action] = resolveRule(action, layers);
  return out;
}
