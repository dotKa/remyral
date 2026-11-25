import { SAFE_COMMANDS_MODES, type SafeCommandsMode } from '@remyral/protocol/safe-commands';
import type { ProjectPolicyStore } from '../approvals/policy-store.js';
import { ProjectPolicyRules } from '../approvals/policy.js';
import { authorize, type Subject } from '../authz/model.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { RuntimePolicyService } from '../runtime-policy/service.js';
import type { SandboxOpsService } from '../sandbox-ops/service.js';
import { settingsTargetEvent, STEP_UP_EVENTS, type StepUpEvent } from '../security-policy/events.js';
import { changedPaths, effectivePolicy, SecurityPolicyPatch, applyPatch } from '../security-policy/model.js';
import type { SecurityPolicyService } from '../security-policy/service.js';
import type { ConfirmContext, SettingsChangeRunner } from './drafts.js';
import type { DraftRecord } from './store.js';

/**
 * p15-autonomy (ADR-0056, docs/design/p15-autonomy.md §5): settings, permissions and policies through the chat —
 * `get_settings` (read) and `change_settings` (a `settings_change` card, executed at once on an explicit instruction).
 *
 * Every target calls the same service as its console screen, with the same authorization action for the user:
 *
 * | target                  | action                     | service                                         |
 * |-------------------------|----------------------------|-------------------------------------------------|
 * | security_policy         | security.write             | SecurityPolicyService.update (via: chat)        |
 * | apply_autonomy          | security.write             | SecurityPolicyService.applyAutonomyToProjects   |
 * | project_execution       | projects.execution.write   | SandboxOpsService.setProjectExecution           |
 * | project_approval_rules  | policy.write               | ProjectPolicyStore.put (merged with the current) |
 * | worker_runtime_policy   | runtimes.write             | RuntimePolicyService.assign                      |
 *
 * The card's step-up event is the target's (`settingsTargetEvent`), so a change asks for a code exactly when the same
 * change on its own screen would.
 */

export type SettingsTarget =
  | 'security_policy'
  | 'apply_autonomy'
  | 'project_execution'
  | 'project_approval_rules'
  | 'worker_runtime_policy';

const ACTION_OF: Readonly<Record<SettingsTarget, string>> = {
  security_policy: 'security.write',
  apply_autonomy: 'security.write',
  project_execution: 'projects.execution.write',
  project_approval_rules: 'policy.write',
  worker_runtime_policy: 'runtimes.write',
};

export interface ChatSettingsDeps {
  readonly db: Queryable;
  readonly securityPolicy: SecurityPolicyService;
  readonly sandboxOps: () => SandboxOpsService | null;
  readonly projectPolicies: ProjectPolicyStore;
  readonly runtimePolicies: () => RuntimePolicyService | null;
}

export type DraftPlan =
  | {
      readonly ok: true;
      readonly title: string;
      readonly payload: Record<string, unknown>;
      readonly project: string | null;
      readonly describe: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly code: 'invalid' | 'forbidden' | 'not_found' | 'unavailable';
      readonly message: string;
    };

function fail(code: 'invalid' | 'forbidden' | 'not_found' | 'unavailable', message: string): DraftPlan {
  return {
    ok: false,
    code,
    message: code === 'forbidden' ? `The signed-in user is not allowed to ${message}.` : message,
  };
}

function can(subject: Subject, action: string, project?: string): 'allow' | 'role' | 'hidden' {
  const d = authorize(subject, action, project === undefined ? undefined : { project });
  if (d.allow) return 'allow';
  return d.reason === 'not_visible' ? 'hidden' : 'role';
}

export class ChatSettings implements SettingsChangeRunner {
  constructor(private readonly deps: ChatSettingsDeps) {}

  /** `get_settings`: what the user may read of the security policy, a project's execution / approval rules, a machine. */
  async read(
    subject: Subject,
    input: { project?: string; workerId?: string },
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (can(subject, 'security.read') === 'allow') {
      const v = await this.deps.securityPolicy.view();
      out.securityPolicy = {
        version: v.version,
        preset: v.effective.preset,
        customized: v.effective.customized,
        stepUp: v.effective.stepUp,
        eventsAskingForCode: Object.entries(v.effective.events)
          .filter(([, on]) => on)
          .map(([e]) => e),
        eventsWithoutCode: Object.entries(v.effective.events)
          .filter(([, on]) => !on)
          .map(([e]) => e),
        eventCategories: Object.fromEntries(
          Object.entries(STEP_UP_EVENTS).map(([e, spec]) => [e, spec.category]),
        ),
        autonomy: v.effective.autonomy,
        // p16-runtime-updates: unverified runtime updates (on by default).
        fleet: v.effective.fleet,
        // p16-zip-job-input: native executables as job inputs (off by default).
        inputs: v.effective.inputs,
        // p16-ops-safety: request / chat rate limits, the cost brake and the rollout circuit breaker.
        limits: v.effective.limits,
        costBrake: v.effective.costBrake,
        rollout: v.effective.rollout,
        updatedAt: v.updatedAt,
        updatedBy: v.updatedBy?.username ?? null,
      };
    } else {
      out.securityPolicy = 'not visible (administrators only)';
    }
    if (input.project !== undefined) {
      const p = input.project;
      if (can(subject, 'projects.execution.read', p) === 'hidden') {
        out.project = 'not found';
      } else {
        const sandbox = this.deps.sandboxOps();
        out.project = {
          id: p,
          ...(sandbox === null ? {} : { execution: await sandbox.projectExecution(p).catch(() => null) }),
          ...(can(subject, 'policy.read', p) === 'allow'
            ? {
                approvalRules: await this.deps.projectPolicies
                  .get(p, { id: subject.userId, role: subject.role, mfaAt: null })
                  .then((r) => ({ version: r.version, rules: r.rules }))
                  .catch(() => null),
              }
            : {}),
        };
      }
    }
    if (input.workerId !== undefined) {
      const id = await this.#worker(input.workerId);
      const rp = this.deps.runtimePolicies();
      out.machine =
        id === null
          ? 'not found'
          : can(subject, 'runtimes.read') === 'allow' && rp !== null
            ? { workerId: id, runtimePolicy: await rp.forWorker(id).catch(() => null) }
            : { workerId: id };
    }
    return out;
  }

  async #worker(ref: string): Promise<string | null> {
    const { rows } = await this.deps.db.query<{ id: string }>(
      `SELECT id FROM workers WHERE (id = $1 OR display_name = $1) AND approved_at IS NOT NULL AND archived_at IS NULL
        LIMIT 1`,
      [ref],
    );
    return rows[0]?.id ?? null;
  }

  /** `change_settings`: validates the change for the user and builds the card (nothing changes here). */
  async plan(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    const target = i.target as SettingsTarget;
    const action = ACTION_OF[target];
    const project = typeof i.project === 'string' ? i.project : undefined;
    const reason = typeof i.reason === 'string' ? i.reason : undefined;
    const event: StepUpEvent = settingsTargetEvent(target);
    const common = { target, event, ...(reason === undefined ? {} : { reason }) };
    switch (target) {
      case 'security_policy':
      case 'apply_autonomy': {
        if (can(subject, action) !== 'allow')
          return fail('forbidden', 'change the security policy (administrators only)');
        if (target === 'apply_autonomy') {
          const p = await this.deps.securityPolicy.current();
          return {
            ok: true,
            title: 'Apply the autonomy defaults to every project',
            payload: { ...common },
            project: null,
            describe: {
              hostExecution: p.autonomy.newProjectsHostExecution,
              autoApprove: p.autonomy.newProjectsAutoApprove,
              note: 'Every project except Machines takes these switches; unconfined is never switched on.',
            },
          };
        }
        const parsed = SecurityPolicyPatch.safeParse(i.securityPolicy ?? {});
        if (!parsed.success)
          return fail(
            'invalid',
            `Invalid securityPolicy: ${parsed.error.issues
              .slice(0, 5)
              .map((x) => `${x.path.join('.') || '(root)'} ${x.code}`)
              .join('; ')}`,
          );
        const view = await this.deps.securityPolicy.view();
        const next = effectivePolicy(applyPatch(view.document, parsed.data));
        const changed = changedPaths(view.effective, next);
        if (changed.length === 0) return fail('invalid', 'Nothing to change: the policy already says so.');
        return {
          ok: true,
          title: `Security policy: ${changed.slice(0, 4).join(', ')}${changed.length > 4 ? ' …' : ''}`.slice(
            0,
            200,
          ),
          payload: { ...common, patch: parsed.data, baseVersion: view.version },
          project: null,
          describe: { changed, preset: next.preset, stepUp: next.stepUp },
        };
      }
      case 'project_execution': {
        if (project === undefined) return fail('invalid', 'Name the project.');
        const c = can(subject, action, project);
        if (c === 'hidden') return fail('not_found', 'Project not found.');
        if (c === 'role') return fail('forbidden', 'change this project’s execution policy (administrators)');
        const sandbox = this.deps.sandboxOps();
        if (sandbox === null) return fail('unavailable', 'Execution policies are not available.');
        const current = await sandbox.projectExecution(project).catch(() => null);
        if (current === null) return fail('not_found', 'Project not found.');
        const e = (i.execution ?? {}) as Record<string, unknown>;
        if (
          e.safeCommands !== undefined &&
          (typeof e.safeCommands !== 'string' ||
            !(SAFE_COMMANDS_MODES as readonly string[]).includes(e.safeCommands))
        )
          return fail('invalid', `safeCommands must be one of ${SAFE_COMMANDS_MODES.join(', ')}.`);
        const next = {
          hostExecution: typeof e.hostExecution === 'boolean' ? e.hostExecution : current.hostExecution,
          unconfined: typeof e.unconfined === 'boolean' ? e.unconfined : current.unconfined,
          allowAutoApprove:
            typeof e.allowAutoApprove === 'boolean' ? e.allowAutoApprove : current.allowAutoApprove,
          safeCommands: (e.safeCommands as SafeCommandsMode | undefined) ?? current.safeCommands,
          subtasks: typeof e.subtasks === 'boolean' ? e.subtasks : current.subtasks,
        };
        if (next.unconfined && !next.hostExecution) next.hostExecution = true;
        const changes = Object.fromEntries(
          (Object.keys(next) as (keyof typeof next)[])
            .filter((k) => next[k] !== current[k])
            .map((k) => [k, { from: current[k], to: next[k] }]),
        );
        if (Object.keys(changes).length === 0) return fail('invalid', 'Nothing to change.');
        return {
          ok: true,
          title: `Execution policy of ${project}: ${Object.keys(changes).join(', ')}`.slice(0, 200),
          payload: { ...common, project, execution: next },
          project,
          describe: { project, changes },
        };
      }
      case 'project_approval_rules': {
        if (project === undefined) return fail('invalid', 'Name the project.');
        const c = can(subject, action, project);
        if (c === 'hidden') return fail('not_found', 'Project not found.');
        if (c === 'role') return fail('forbidden', 'change this project’s approval rules (administrators)');
        const parsed = ProjectPolicyRules.safeParse(i.rules ?? {});
        if (!parsed.success || Object.keys(parsed.data).length === 0)
          return fail('invalid', 'rules: name at least one known approval action with an outcome.');
        const current = await this.deps.projectPolicies.get(project, {
          id: subject.userId,
          role: subject.role,
          mfaAt: null,
        });
        return {
          ok: true,
          title: `Approval rules of ${project}: ${Object.keys(parsed.data).join(', ')}`.slice(0, 200),
          payload: {
            ...common,
            project,
            rules: { ...current.rules, ...parsed.data },
            baseVersion: current.version,
          },
          project,
          describe: { project, changes: parsed.data },
        };
      }
      case 'worker_runtime_policy': {
        if (can(subject, action) !== 'allow')
          return fail('forbidden', 'assign runtime policies (administrators only)');
        const ref = typeof i.workerId === 'string' ? i.workerId : undefined;
        if (ref === undefined) return fail('invalid', 'Name the machine (workerId).');
        const workerId = await this.#worker(ref);
        if (workerId === null) return fail('not_found', 'Worker not found.');
        const rp = i.runtimePolicy as { policy?: string | null; canary?: boolean } | undefined;
        if (rp === undefined || rp.policy === undefined)
          return fail('invalid', 'runtimePolicy.policy is required.');
        return {
          ok: true,
          title: `Runtime policy of ${ref}: ${rp.policy ?? 'default'}`.slice(0, 200),
          payload: { ...common, workerId, policy: rp.policy, canary: rp.canary === true },
          project: null,
          describe: { workerId, policy: rp.policy, canary: rp.canary === true },
        };
      }
      default:
        return fail('invalid', 'Unknown settings target.');
    }
  }

  /** Runs a confirmed `settings_change` card for the confirming user (the authorization is checked again). */
  async run(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>> {
    const p = d.payload;
    const target = p.target as SettingsTarget;
    const action = ACTION_OF[target] as string | undefined;
    if (action === undefined)
      throw new HttpError(400, 'invalid_draft', 'Unknown settings target.', {}, {}, { reason: 'settings' });
    const project = typeof p.project === 'string' ? p.project : undefined;
    const decision = authorize(ctx.subject, action, project === undefined ? undefined : { project });
    if (!decision.allow)
      throw new HttpError(
        403,
        'forbidden',
        'You are not allowed to change this setting.',
        {},
        {},
        { reason: 'settings' },
      );
    const via = ctx.direct === true ? ('chat' as const) : ('console' as const);
    const reason = typeof p.reason === 'string' ? p.reason : undefined;
    switch (target) {
      case 'security_policy': {
        const parsed = SecurityPolicyPatch.safeParse(p.patch);
        if (!parsed.success)
          throw new HttpError(
            400,
            'invalid_draft',
            'The card’s change is invalid.',
            {},
            {},
            { reason: 'settings' },
          );
        const out = await this.deps.securityPolicy.update(
          { userId: ctx.subject.userId, ip: ctx.actor.ip, userAgent: ctx.actor.userAgent, via: 'chat' },
          parsed.data,
          {
            ...(typeof p.baseVersion === 'number' ? { expectedVersion: p.baseVersion } : {}),
            ...(reason === undefined ? {} : { reason }),
          },
        );
        return { version: out.version, preset: out.effective.preset, changed: out.changed, via };
      }
      case 'apply_autonomy': {
        const out = await this.deps.securityPolicy.applyAutonomyToProjects({
          userId: ctx.subject.userId,
          ip: ctx.actor.ip,
          userAgent: ctx.actor.userAgent,
          via: 'chat',
        });
        return { updated: out.updated, count: out.updated.length, via };
      }
      case 'project_execution': {
        const sandbox = this.deps.sandboxOps();
        if (sandbox === null || project === undefined)
          throw new HttpError(
            503,
            'unavailable',
            'Execution policies are not available.',
            {},
            {},
            { reason: 'settings' },
          );
        const e = p.execution as {
          hostExecution: boolean;
          unconfined: boolean;
          allowAutoApprove: boolean;
          safeCommands: SafeCommandsMode;
          subtasks: boolean;
        };
        const view = await sandbox.setProjectExecution(project, e, ctx.actor);
        return { project, execution: view, via };
      }
      case 'project_approval_rules': {
        if (project === undefined)
          throw new HttpError(
            400,
            'invalid_draft',
            'The card names no project.',
            {},
            {},
            { reason: 'settings' },
          );
        const stored = await this.deps.projectPolicies.put(
          project,
          {
            rules: p.rules,
            expectedVersion: typeof p.baseVersion === 'number' ? p.baseVersion : 0,
            ...(reason === undefined ? {} : { reason }),
          },
          ctx.human,
          { ip: ctx.actor.ip, userAgent: ctx.actor.userAgent },
        );
        return { project, version: stored.version, via };
      }
      case 'worker_runtime_policy': {
        const rp = this.deps.runtimePolicies();
        if (rp === null)
          throw new HttpError(
            503,
            'unavailable',
            'Runtime policies are not available.',
            {},
            {},
            { reason: 'settings' },
          );
        const view = await rp.assign(
          String(p.workerId),
          { policy: (p.policy as string | null) ?? null, canary: p.canary === true },
          ctx.actor,
        );
        return { workerId: view.workerId, policy: view.assignedPolicy, canary: view.canary, via };
      }
    }
  }
}
