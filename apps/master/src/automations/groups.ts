import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { authorize, type Subject } from '../authz/model.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { githubRepo } from '../gitflow/refs.js';
import { resolveName } from '../workflows/sharing.js';
import { projectKind } from '../workspaces/service.js';
import {
  type AutomationDetail,
  AutomationError,
  AutomationInput,
  AutomationPatch,
  type AutomationTarget,
  type AutomationTrigger,
  type AutomationView,
  PROJECT,
  UUID,
} from './model.js';
import type { AutomationActor, AutomationService } from './service.js';

/**
 * p18-multi-project W4 (docs/design/p18-multi-project.md §2.2, "Built: W4"): automation groups.
 *
 * Automations stay per-project rows — run-as, webhook secret, GitHub routing, catch-up, next run, run history and the
 * run-as re-check are inherently per project, and external triggers need each project's admin + step-up. "Projeler"
 * in the form creates one ordinary automation per selected project through {@link AutomationService.create}, each
 * authorized and validated on its own (the refused ones are listed, never silently dropped), linked by `group_id`.
 *
 * "Tümüne uygula" ({@link AutomationGroupService.apply}) changes every live sibling the editor may change through
 * {@link AutomationService.update} — the same rules and step-up as one by one; a sibling it cannot change (no right in
 * that project, a webhook / GitHub trigger without the project's admin, a validation error there) is left as it was
 * and marked `diverged`. A sibling changed on its own is marked diverged too. A group is never an authority: nothing
 * is aggregated into a broader grant.
 *
 * Per-project adaptation of the shared configuration (the only thing the group adds):
 * - a job target's repository becomes the project's registered repository (a workspace project has none);
 *   `spec.projectId` is the project;
 * - a workflow target names the workflow by its name: each project runs its own workflow of that name or the one it
 *   attached (W1), never another project's;
 * - a GitHub trigger listens to the project's registered GitHub repository.
 * Everything else (deploy targets, output folders, chain sources, input files) is validated in each project as is.
 */

export const MAX_GROUP_PROJECTS = 20;

export const AutomationGroupInput = AutomationInput.omit({ project: true }).extend({
  projects: z.array(z.string().regex(PROJECT)).min(2).max(MAX_GROUP_PROJECTS),
});
export type AutomationGroupInput = z.infer<typeof AutomationGroupInput>;

export const AutomationGroupApply = z.strictObject({
  /** The change, as for one automation (`PATCH /automations/:id`); stored input files stay per automation. */
  patch: AutomationPatch,
});
export type AutomationGroupApply = z.infer<typeof AutomationGroupApply>;

/**
 * Leftovers wave (p18-leftovers): "Projeye ekle" — the group's automation in more projects. The configuration is taken
 * from `from` (a live sibling the caller reads) or else the first live sibling that did not diverge.
 */
export const AutomationGroupAddProjects = z.strictObject({
  projects: z.array(z.string().regex(PROJECT)).min(1).max(MAX_GROUP_PROJECTS),
  from: z.string().regex(UUID).optional(),
});
export type AutomationGroupAddProjects = z.infer<typeof AutomationGroupAddProjects>;

/** Leftovers wave: the whole group in one action (each sibling with the rules of the single action). */
export type GroupLifecycleAction = 'pause' | 'resume' | 'delete';

export interface GroupLifecycleResult {
  /** The group after the action (null: no live sibling the caller reads is left, e.g. after delete). */
  readonly group: GroupView | null;
  readonly done: { readonly id: string; readonly project: string; readonly state: string }[];
  /** Already in the asked state (paused / active): nothing to do. */
  readonly unchanged: { readonly id: string; readonly project: string; readonly state: string }[];
  readonly skipped: {
    readonly id: string;
    readonly project: string;
    readonly code: string;
    readonly message: string;
  }[];
  /** Siblings in projects the caller cannot read: left alone, counted only. */
  readonly hiddenSkipped: number;
}

export interface GroupRefusal {
  readonly project: string;
  readonly code: string;
  readonly message: string;
}

export interface GroupMemberView {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly state: string;
  readonly enabled: boolean;
  readonly diverged: boolean;
  readonly triggerSummary: string;
  readonly nextRunAt: string | null;
  /** The caller may change it ("Tümüne uygula" will change it). */
  readonly canEdit: boolean;
}

export interface GroupView {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  /** Live siblings in projects the caller can read. */
  readonly members: readonly GroupMemberView[];
  /** Live siblings in projects the caller cannot read (a count only). */
  readonly hidden: number;
}

export interface AutomationGroupDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly automations: () => AutomationService | null;
}

interface MemberRow {
  id: string;
  project: string;
  state: string;
  trigger_kind?: string;
}

const err = (status: number, code: string, message: string): AutomationError =>
  new AutomationError(status, code, message);

/** The 404 of a project the caller cannot see (no oracle) or the 403 of one it sees without the right. */
function refusalFor(s: Subject, project: string, action: 'automations.write'): GroupRefusal | null {
  if (!authorize(s, 'automations.read', { project }).allow)
    return { project, code: 'project_not_found', message: 'Project not found.' };
  if (!authorize(s, action, { project }).allow)
    return {
      project,
      code: 'forbidden',
      message: `You need the operator role in project ${project} to create or change its automations.`,
    };
  return null;
}

/**
 * The group's trigger and target as they apply in `project` (see the header). Throws AutomationError when the
 * project cannot take them (the caller lists it as refused / skipped). Also the chat's draft_automation `projects`.
 */
export async function adaptForProject(
  db: Queryable,
  project: string,
  trigger: AutomationTrigger | undefined,
  target: AutomationTarget | undefined,
  opts: { readonly dropFiles?: boolean } = {},
): Promise<{ trigger: AutomationTrigger | undefined; target: AutomationTarget | undefined }> {
  const kind = await projectKind(db, project);
  if (kind === null) throw err(404, 'project_not_found', 'Project not found.');
  const git =
    kind === 'workspace'
      ? null
      : ((
          await db.query<{ repository_url: string; base_branch: string }>(
            'SELECT repository_url, base_branch FROM project_git_configs WHERE project = $1',
            [project],
          )
        ).rows[0] ?? null);
  let t = trigger;
  if (t?.kind === 'github') {
    const reg = git === null ? null : githubRepo(git.repository_url);
    if (reg === null)
      throw err(
        400,
        'invalid_trigger',
        `Project ${project} has no registered GitHub repository for a GitHub trigger.`,
      );
    t = { ...t, repository: `${reg.owner}/${reg.repo}` };
  }
  let g = target;
  if (g?.kind === 'job') {
    const spec: Record<string, unknown> = { ...g.spec, projectId: project };
    delete spec.workspace;
    if (kind === 'workspace') {
      delete spec.repository;
    } else {
      if (git === null)
        throw err(
          400,
          'repository_missing',
          `Project ${project} has no registered repository (Projects → Git).`,
        );
      const cur = spec.repository as { url?: unknown; baseRef?: unknown; workBranch?: unknown } | undefined;
      if (cur === undefined || cur.url !== git.repository_url) {
        spec.repository = {
          url: git.repository_url,
          baseRef: git.base_branch,
          workBranch: `agent/auto-${randomUUID().slice(0, 8)}`,
        };
      }
    }
    g = { ...g, spec };
    if (opts.dropFiles === true) {
      const { files: _f, ...rest } = g;
      g = rest;
    }
  } else if (g?.kind === 'workflow') {
    const { rows } = await db.query<{ project: string; name: string }>(
      'SELECT project, name FROM workflow_definitions WHERE id = $1',
      [g.workflowId],
    );
    const d = rows[0];
    if (d === undefined) throw err(404, 'workflow_not_found', 'Workflow not found.');
    let workflowId = g.workflowId;
    if (d.project !== project) {
      // The same name in this project: its own workflow, else the one it attached (never another project's).
      const named = await resolveName(db, project, d.name);
      if (named === null)
        throw err(
          404,
          'workflow_not_found',
          `Project ${project} has no workflow named ${d.name} (own or attached).`,
        );
      workflowId = named.definitionId;
    }
    g = { ...g, workflowId };
    if (opts.dropFiles === true) {
      const { files: _f, ...rest } = g;
      g = rest;
    }
  }
  return { trigger: t, target: g };
}

/**
 * The input that creates `d` again in another project (the configuration of a sibling, without its stored input files,
 * its output folder, a fixed continue-from job or a deploy-on-success approval — those belong to one project and one
 * approval; the new automation's own page sets them).
 */
export function inputOfDetail(d: AutomationDetail, project: string): AutomationInput {
  const ts = d.targetSpec;
  let target: AutomationTarget;
  if (d.target.kind === 'job') {
    const cf = ts.continueFrom;
    target = {
      kind: 'job',
      spec: { ...(ts.spec ?? {}) },
      priority: ts.priority,
      ...(cf === null || cf.kind === 'job' ? {} : { continueFrom: cf }),
      ...(ts.verifyOnSuccess === null ? {} : { verifyOnSuccess: ts.verifyOnSuccess }),
    };
  } else if (d.target.kind === 'workflow') {
    target = {
      kind: 'workflow',
      workflowId: d.target.workflowId ?? '',
      inputs: { ...(ts.workflowInputs ?? {}) },
      ...(ts.workflowRepository === null ? {} : { repository: { ...ts.workflowRepository } }),
      priority: ts.priority,
      ...(ts.continueFrom === null || ts.continueFrom.kind === 'job'
        ? {}
        : { continueFrom: ts.continueFrom }),
    };
  } else {
    const a = d.target.deployAction;
    target = {
      kind: 'deploy',
      action: (a?.kind ?? 'coolify.deploy') as 'coolify.deploy' | 'coolify.restart',
      params: { ...(a?.params ?? {}) },
    };
  }
  return {
    project,
    name: d.name,
    ...(d.description === null ? {} : { description: d.description }),
    trigger: d.trigger,
    target,
    enabled: d.state === 'active',
    concurrency: d.concurrency as AutomationInput['concurrency'],
    catchUp: d.catchUp as AutomationInput['catchUp'],
    maxRunsPerHour: d.maxRunsPerHour,
    notifyOnFailure: d.notifyOnFailure,
    approvalTimeoutMinutes: d.approvalTimeoutMinutes,
    ...(d.webhook?.allowIps == null ? {} : { webhookAllowIps: [...d.webhook.allowIps] }),
    ...(d.reuseWithinHours === null ? {} : { reuseWithinHours: d.reuseWithinHours }),
  };
}

export class AutomationGroupService {
  constructor(private readonly deps: AutomationGroupDeps) {}

  #svc(): AutomationService {
    const s = this.deps.automations();
    if (s === null) throw err(503, 'unavailable', 'Automations are not available.');
    return s;
  }

  #subject(actor: AutomationActor): Subject {
    if (actor.subject === undefined) throw err(403, 'forbidden', 'Not allowed.');
    return actor.subject;
  }

  // ------------------------------------------------------------------------------------------ adaptation

  /** {@link adaptForProject} (kept on the service for its callers and tests). */
  adapt(
    db: Queryable,
    project: string,
    trigger: AutomationTrigger | undefined,
    target: AutomationTarget | undefined,
    opts: { readonly dropFiles?: boolean } = {},
  ): Promise<{ trigger: AutomationTrigger | undefined; target: AutomationTarget | undefined }> {
    return adaptForProject(db, project, trigger, target, opts);
  }

  // ------------------------------------------------------------------------------------------ create

  /**
   * "Projeler": one automation per selected project, linked by a new group. Each project is authorized and validated
   * on its own; a project that cannot take it is listed with its reason. Nothing created → 409 `group_refused`.
   */
  async create(
    actor: AutomationActor,
    input: AutomationGroupInput,
  ): Promise<{
    groupId: string;
    created: { project: string; automation: AutomationView; webhookSecret: string | null }[];
    refused: GroupRefusal[];
  }> {
    const s = this.#subject(actor);
    const svc = this.#svc();
    const projects = [...new Set(input.projects)];
    if (projects.length < 2)
      throw err(400, 'bad_request', 'An automation group needs at least two different projects.');
    const { projects: _p, ...base } = input;
    const groupId = randomUUID();
    const now = this.deps.clock();
    await this.deps.pool.query(
      'INSERT INTO automation_groups (id, name, created_by, created_at) VALUES ($1, $2, $3, $4)',
      [groupId, input.name, actor.id, now],
    );
    const created: { project: string; automation: AutomationView; webhookSecret: string | null }[] = [];
    const refused: GroupRefusal[] = [];
    for (const project of projects) {
      const denied = refusalFor(s, project, 'automations.write');
      if (denied !== null) {
        refused.push(denied);
        continue;
      }
      try {
        const adapted = await this.adapt(this.deps.pool, project, base.trigger, base.target);
        const one: AutomationInput = {
          ...base,
          project,
          trigger: adapted.trigger ?? base.trigger,
          target: adapted.target ?? base.target,
        };
        const out = await svc.create(actor, one, { groupId });
        created.push({ project, automation: out.automation, webhookSecret: out.webhookSecret });
      } catch (e) {
        if (!(e instanceof AutomationError)) throw e;
        refused.push({ project, code: e.code, message: e.message.slice(0, 500) });
      }
    }
    if (created.length === 0) {
      await this.deps.pool.query('DELETE FROM automation_groups WHERE id = $1', [groupId]);
      throw err(
        409,
        'group_refused',
        `No project could take the automation: ${refused.map((r) => `${r.project}: ${r.code}`).join(', ')}.`.slice(
          0,
          1000,
        ),
      );
    }
    await this.#audit(actor, 'automation.group.create', groupId, {
      name: input.name,
      projects,
      created: created.map((c) => c.automation.id),
      refused: refused.map((r) => `${r.project}:${r.code}`),
      trigger: input.trigger.kind,
      target: input.target.kind,
    });
    return { groupId, created, refused };
  }

  // ------------------------------------------------------------------------------------------ read

  async #members(db: Queryable, groupId: string): Promise<MemberRow[]> {
    const { rows } = await db.query<MemberRow>(
      `SELECT id, project, state, trigger_kind FROM automations WHERE group_id = $1 AND state <> 'deleted'
        ORDER BY created_at, project`,
      [groupId],
    );
    return rows;
  }

  /** One group: its live siblings the caller can read (the rest as a count). 404 when it reads none. */
  async get(s: Subject, groupId: string): Promise<GroupView> {
    if (!UUID.test(groupId)) throw err(404, 'automation_group_not_found', 'Automation group not found.');
    const { rows } = await this.deps.pool.query<{
      id: string;
      name: string;
      created_by: string;
      created_at: Date;
      updated_at: Date | null;
    }>('SELECT id, name, created_by, created_at, updated_at FROM automation_groups WHERE id = $1', [groupId]);
    const g = rows[0];
    if (g === undefined) throw err(404, 'automation_group_not_found', 'Automation group not found.');
    const all = await this.#members(this.deps.pool, groupId);
    const readable = all.filter((m) => authorize(s, 'automations.read', { project: m.project }).allow);
    if (readable.length === 0) throw err(404, 'automation_group_not_found', 'Automation group not found.');
    const svc = this.#svc();
    const views = await svc.list(
      readable.map((m) => m.project),
      { group: groupId },
    );
    const byId = new Map(views.map((v) => [v.id, v]));
    const members: GroupMemberView[] = [];
    for (const m of readable) {
      const v = byId.get(m.id) ?? (await svc.get(m.id));
      members.push({
        id: v.id,
        project: v.project,
        name: v.name,
        state: v.state,
        enabled: v.enabled,
        diverged: v.group?.diverged ?? false,
        triggerSummary: v.triggerSummary,
        nextRunAt: v.nextRunAt,
        canEdit: authorize(s, 'automations.write', { project: v.project }).allow,
      });
    }
    return {
      id: g.id,
      name: g.name,
      createdBy: g.created_by,
      createdAt: g.created_at.toISOString(),
      updatedAt: g.updated_at === null ? null : g.updated_at.toISOString(),
      members,
      hidden: all.length - readable.length,
    };
  }

  // ------------------------------------------------------------------------------------------ apply

  /**
   * "Tümüne uygula": the same change on every live sibling the editor may change (each through
   * AutomationService.update — same rules, same step-up); the others are left unchanged and marked diverged.
   * Siblings in projects the caller cannot read are skipped without naming them (a count).
   */
  async apply(
    actor: AutomationActor,
    groupId: string,
    body: AutomationGroupApply,
  ): Promise<{
    group: GroupView;
    applied: { id: string; project: string; webhookSecret: string | null }[];
    skipped: { id: string; project: string; code: string; message: string }[];
    hiddenSkipped: number;
  }> {
    const s = this.#subject(actor);
    const svc = this.#svc();
    await this.get(s, groupId); // 404 for a group the caller reads nothing of
    const patch = body.patch;
    if (Object.keys(patch).length === 0) throw err(400, 'bad_request', 'Nothing to apply.');
    const members = await this.#members(this.deps.pool, groupId);
    const applied: { id: string; project: string; webhookSecret: string | null }[] = [];
    const skipped: { id: string; project: string; code: string; message: string }[] = [];
    let hiddenSkipped = 0;
    const markDiverged = async (id: string): Promise<void> => {
      await this.deps.pool.query('UPDATE automations SET diverged = true WHERE id = $1 AND group_id = $2', [
        id,
        groupId,
      ]);
    };
    for (const m of members) {
      if (!authorize(s, 'automations.read', { project: m.project }).allow) {
        hiddenSkipped += 1;
        await markDiverged(m.id);
        continue;
      }
      const denied = refusalFor(s, m.project, 'automations.write');
      if (denied !== null) {
        skipped.push({ id: m.id, project: m.project, code: denied.code, message: denied.message });
        await markDiverged(m.id);
        continue;
      }
      try {
        const adapted = await this.adapt(this.deps.pool, m.project, patch.trigger, patch.target, {
          dropFiles: true,
        });
        const one = {
          ...patch,
          ...(adapted.trigger === undefined ? {} : { trigger: adapted.trigger }),
          ...(adapted.target === undefined ? {} : { target: adapted.target }),
        };
        const out = await svc.update(actor, m.id, one, { group: true });
        applied.push({ id: m.id, project: m.project, webhookSecret: out.webhookSecret });
      } catch (e) {
        if (!(e instanceof AutomationError)) throw e;
        skipped.push({ id: m.id, project: m.project, code: e.code, message: e.message.slice(0, 500) });
        await markDiverged(m.id);
      }
    }
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('UPDATE automation_groups SET updated_by = $2, updated_at = $3 WHERE id = $1', [
        groupId,
        actor.id,
        this.deps.clock(),
      ]);
      await this.#audit(
        actor,
        'automation.group.apply',
        groupId,
        {
          fields: Object.keys(patch).sort(),
          applied: applied.map((a) => a.id),
          skipped: skipped.map((k) => `${k.project}:${k.code}`),
          ...(hiddenSkipped === 0 ? {} : { hiddenSkipped }),
        },
        tx,
      );
    });
    return { group: await this.get(s, groupId), applied, skipped, hiddenSkipped };
  }

  // ------------------------------------------------------------------------------------------ add projects

  /**
   * "Projeye ekle": the group's automation in more projects — the reference sibling's configuration (`from`, else the
   * first live sibling that did not diverge, else the first live one), adapted and created in each new project exactly
   * as {@link create} does (authorized and validated there, refused ones listed). A project that already has a live
   * sibling is refused `already_in_group`; the group never grows past {@link MAX_GROUP_PROJECTS} (`group_full`).
   */
  async addProjects(
    actor: AutomationActor,
    groupId: string,
    body: AutomationGroupAddProjects,
  ): Promise<{
    group: GroupView;
    created: { project: string; automation: AutomationView; webhookSecret: string | null }[];
    refused: GroupRefusal[];
  }> {
    const s = this.#subject(actor);
    const svc = this.#svc();
    await this.get(s, groupId); // 404 for a group the caller reads nothing of
    const members = await this.#members(this.deps.pool, groupId);
    const readable = members.filter((m) => authorize(s, 'automations.read', { project: m.project }).allow);
    let ref: MemberRow | undefined;
    if (body.from !== undefined) {
      ref = readable.find((m) => m.id === body.from);
      if (ref === undefined)
        throw err(404, 'automation_not_found', 'The reference automation is not a sibling of this group.');
    } else {
      const { rows } = await this.deps.pool.query<{ id: string }>(
        `SELECT id FROM automations WHERE group_id = $1 AND state <> 'deleted' AND NOT diverged
          ORDER BY created_at, project`,
        [groupId],
      );
      const undiverged = new Set(rows.map((r) => r.id));
      ref = readable.find((m) => undiverged.has(m.id)) ?? readable[0];
    }
    if (ref === undefined) throw err(404, 'automation_group_not_found', 'Automation group not found.');
    const detail = await svc.get(ref.id);
    const taken = new Set(members.map((m) => m.project));
    const created: { project: string; automation: AutomationView; webhookSecret: string | null }[] = [];
    const refused: GroupRefusal[] = [];
    let size = members.length;
    for (const project of [...new Set(body.projects)]) {
      const denied = refusalFor(s, project, 'automations.write');
      if (denied !== null) {
        refused.push(denied);
        continue;
      }
      if (taken.has(project)) {
        refused.push({
          project,
          code: 'already_in_group',
          message: `Project ${project} already has an automation of this group.`,
        });
        continue;
      }
      if (size >= MAX_GROUP_PROJECTS) {
        refused.push({
          project,
          code: 'group_full',
          message: `An automation group has at most ${String(MAX_GROUP_PROJECTS)} projects.`,
        });
        continue;
      }
      try {
        const base = inputOfDetail(detail, project);
        const adapted = await this.adapt(this.deps.pool, project, base.trigger, base.target, {
          dropFiles: true,
        });
        const one: AutomationInput = {
          ...base,
          trigger: adapted.trigger ?? base.trigger,
          target: adapted.target ?? base.target,
        };
        const out = await svc.create(actor, one, { groupId });
        created.push({ project, automation: out.automation, webhookSecret: out.webhookSecret });
        taken.add(project);
        size += 1;
      } catch (e) {
        if (!(e instanceof AutomationError)) throw e;
        refused.push({ project, code: e.code, message: e.message.slice(0, 500) });
      }
    }
    await withTransaction(this.deps.pool, async (tx) => {
      if (created.length > 0)
        await tx.query('UPDATE automation_groups SET updated_by = $2, updated_at = $3 WHERE id = $1', [
          groupId,
          actor.id,
          this.deps.clock(),
        ]);
      await this.#audit(
        actor,
        'automation.group.add_projects',
        groupId,
        {
          from: ref.id,
          projects: [...new Set(body.projects)],
          created: created.map((c) => c.automation.id),
          refused: refused.map((r) => `${r.project}:${r.code}`),
        },
        tx,
      );
    });
    return { group: await this.get(s, groupId), created, refused };
  }

  // ------------------------------------------------------------------------------------------ pause / resume / delete

  /**
   * The whole group in one action: every live sibling the caller may change goes through the single action of
   * {@link AutomationService} (`pause` / `resume` / `remove` — the same state rules; resuming a GitHub / webhook sibling
   * needs that project's admin and a fresh step-up there, as alone). A sibling the caller may not change, or one the
   * service refuses, is listed with its reason; siblings in projects the caller cannot read are left alone and counted.
   * Audited `automation.group.<action>` next to each sibling's own entry.
   */
  async lifecycle(
    actor: AutomationActor,
    groupId: string,
    action: GroupLifecycleAction,
  ): Promise<GroupLifecycleResult> {
    const s = this.#subject(actor);
    const svc = this.#svc();
    await this.get(s, groupId);
    const members = await this.#members(this.deps.pool, groupId);
    // Resuming a GitHub / webhook sibling needs a fresh step-up (as alone): ask once for the whole action instead of
    // listing each such sibling as refused.
    if (
      action === 'resume' &&
      actor.stepUpFresh !== true &&
      members.some(
        (m) =>
          m.state !== 'active' &&
          (m.trigger_kind === 'github' || m.trigger_kind === 'webhook') &&
          authorize(s, 'automations.external', { project: m.project }).allow,
      )
    )
      throw err(403, 'step_up_required', 'Confirm with a current authenticator code.');
    const done: { id: string; project: string; state: string }[] = [];
    const unchanged: { id: string; project: string; state: string }[] = [];
    const skipped: { id: string; project: string; code: string; message: string }[] = [];
    let hiddenSkipped = 0;
    for (const m of members) {
      if (!authorize(s, 'automations.read', { project: m.project }).allow) {
        hiddenSkipped += 1;
        continue;
      }
      const denied = refusalFor(s, m.project, 'automations.write');
      if (denied !== null) {
        skipped.push({ id: m.id, project: m.project, code: denied.code, message: denied.message });
        continue;
      }
      if ((action === 'pause' && m.state !== 'active') || (action === 'resume' && m.state === 'active')) {
        unchanged.push({ id: m.id, project: m.project, state: m.state });
        continue;
      }
      try {
        const v =
          action === 'pause'
            ? await svc.pause(actor, m.id)
            : action === 'resume'
              ? await svc.resume(actor, m.id)
              : await svc.remove(actor, m.id);
        done.push({ id: m.id, project: m.project, state: v.state });
      } catch (e) {
        if (!(e instanceof AutomationError)) throw e;
        skipped.push({ id: m.id, project: m.project, code: e.code, message: e.message.slice(0, 500) });
      }
    }
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('UPDATE automation_groups SET updated_by = $2, updated_at = $3 WHERE id = $1', [
        groupId,
        actor.id,
        this.deps.clock(),
      ]);
      await this.#audit(
        actor,
        `automation.group.${action}`,
        groupId,
        {
          done: done.map((d) => d.id),
          unchanged: unchanged.length,
          skipped: skipped.map((k) => `${k.project}:${k.code}`),
          ...(hiddenSkipped === 0 ? {} : { hiddenSkipped }),
        },
        tx,
      );
    });
    let group: GroupView | null = null;
    try {
      group = await this.get(s, groupId);
    } catch (e) {
      if (!(e instanceof AutomationError) || e.code !== 'automation_group_not_found') throw e;
    }
    return { group, done, unchanged, skipped, hiddenSkipped };
  }

  async #audit(
    actor: AutomationActor,
    action: string,
    groupId: string,
    metadata: Record<string, unknown>,
    tx?: Queryable,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor: { type: 'user', id: actor.id },
        action,
        target: `automation-group:${groupId}`,
        outcome: 'success',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata,
      },
      tx,
    );
  }
}
