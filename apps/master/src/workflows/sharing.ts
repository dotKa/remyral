import { aiProjection, deltaActions, privilegedDelta, type StoredDefinition } from '@remyral/workflow-nodes';
import type { FunctionEgress } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Action, authorize, type Subject } from '../authz/model.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import type { NotificationService } from '../notifications/service.js';
import { projectRecipients } from '../notifications/recipients.js';
import { projectKind } from '../workspaces/service.js';
import { WorkflowError } from './engine.js';
import { stepNeedsRepository } from './steps.js';
import {
  AttachmentOverrides,
  asV2,
  credentialSlots,
  newRequiredInputs,
  overrideIssues,
  overridesHash,
  slotNames,
} from './sharing-model.js';
import { PUBLIC_RUN_STATE_SQL } from './v2/engine.js';
import { functionNodeIssues, loadFunctionCredential } from './v2/functions.js';
import { CREDENTIAL_NOT_ALLOWED_FOR_PROJECT, credentialAllowsProject } from '../vault/projects.js';

/**
 * p18-multi-project W1 + W2 (docs/design/p18-multi-project.md §2.1, §3, §5): shared workflows. A workflow lives in its
 * owner project; the owner project's admin offers it (`workflows.share`), a target project's admin attaches it
 * (`workflows.attach`) and binds its credential slots (`workflows.attach.credentials`, always-fresh step-up). Each run
 * belongs to the project it ran in; the attachment decides the version it runs (follow: non-privileged owner versions
 * are followed automatically, a version that adds or changes a privileged node — or needs a new input without a default
 * here — waits for the target admin; pin: never moves) and the target's overrides.
 *
 * The owner project itself needs no row: {@link resolveName} returns its own workflows as an implicit
 * self-attachment, so every existing workflow, trigger binding, run and route behaves unchanged.
 */

export type AttachmentState = 'enabled' | 'disabled' | 'detached';

export interface AttachmentRow {
  id: string;
  project: string;
  owner_project: string;
  name: string;
  state: AttachmentState;
  follow: 'auto' | 'pin';
  version: number;
  pending_version: number | null;
  pending_reason: string | null;
  overrides: AttachmentOverrides;
  created_by: string;
  created_at: Date;
  updated_by: string;
  updated_at: Date;
  detached_at: Date | null;
}

export interface SharingActor {
  readonly id: string;
  readonly subject: Subject;
  readonly stepUpFresh: boolean;
}

// ------------------------------------------------------------------------------------------------ reads (engine)

export async function attachmentById(db: Queryable, id: string): Promise<AttachmentRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query<AttachmentRow>('SELECT * FROM workflow_attachments WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** The live (not detached) attachment of `name` in `project` (any owner). */
export async function liveAttachment(
  db: Queryable,
  project: string,
  name: string,
): Promise<AttachmentRow | null> {
  const { rows } = await db.query<AttachmentRow>(
    "SELECT * FROM workflow_attachments WHERE project = $1 AND name = $2 AND state <> 'detached'",
    [project, name],
  );
  return rows[0] ?? null;
}

/** The live attachment of the owner's workflow `(ownerProject, name)` in `project`. */
export async function attachmentOf(
  db: Queryable,
  project: string,
  ownerProject: string,
  name: string,
): Promise<AttachmentRow | null> {
  const a = await liveAttachment(db, project, name);
  return a !== null && a.owner_project === ownerProject ? a : null;
}

/** Credential slot → the target's credential (an attachment's bindings). */
export async function slotBindings(db: Queryable, attachmentId: string): Promise<Map<string, string>> {
  const { rows } = await db.query<{ slot: string; credential_id: string }>(
    'SELECT slot, credential_id FROM workflow_attachment_credentials WHERE attachment_id = $1',
    [attachmentId],
  );
  return new Map(rows.map((r) => [r.slot, r.credential_id]));
}

/** One version row of a workflow (null: unknown). */
export async function versionRow(
  db: Queryable,
  project: string,
  name: string,
  version: number | 'latest',
): Promise<{ id: string; version: number; definition: StoredDefinition } | null> {
  const { rows } = await db.query<{ id: string; version: number; definition: StoredDefinition }>(
    version === 'latest'
      ? 'SELECT id, version, definition FROM workflow_definitions WHERE project = $1 AND name = $2 ORDER BY version DESC LIMIT 1'
      : 'SELECT id, version, definition FROM workflow_definitions WHERE project = $1 AND name = $2 AND version = $3',
    version === 'latest' ? [project, name] : [project, name, version],
  );
  return rows[0] ?? null;
}

/**
 * A workflow name as `project` runs it: its own workflow (the implicit self-attachment, latest version) or a live
 * attachment (the owner's version line, the attachment's version). Null: no such workflow in the project's namespace.
 */
export async function resolveName(
  db: Queryable,
  project: string,
  name: string,
): Promise<{
  ownerProject: string;
  attachment: AttachmentRow | null;
  definitionId: string;
  version: number;
} | null> {
  const own = await versionRow(db, project, name, 'latest');
  if (own !== null)
    return { ownerProject: project, attachment: null, definitionId: own.id, version: own.version };
  const a = await liveAttachment(db, project, name);
  if (a === null) return null;
  const v = await versionRow(db, a.owner_project, a.name, a.version);
  return v === null
    ? null
    : { ownerProject: a.owner_project, attachment: a, definitionId: v.id, version: v.version };
}

/** Whether the owner offers `(ownerProject, name)` to `project` (listed or every project). */
export async function isOffered(
  db: Queryable,
  ownerProject: string,
  name: string,
  project: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM workflow_shares WHERE owner_project = $1 AND name = $2 AND (project = $3 OR project = '*')`,
    [ownerProject, name, project],
  );
  return (rowCount ?? 0) > 0;
}

async function ownerArchived(db: Queryable, ownerProject: string, name: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM workflow_archives WHERE project = $1 AND name = $2', [
    ownerProject,
    name,
  ]);
  return (rowCount ?? 0) > 0;
}

/** Slots of `def` this attachment has no binding for. */
export async function unboundSlots(
  db: Queryable,
  attachmentId: string,
  def: StoredDefinition,
): Promise<string[]> {
  const bound = await slotBindings(db, attachmentId);
  return slotNames(def).filter((s) => !bound.has(s));
}

// ------------------------------------------------------------------------------------------------ views

export interface AttachReport {
  /** The target project's kind. */
  readonly kind: 'repository' | 'workspace';
  /** Where runs take their code from in the target (the owner's repository is never used). */
  readonly repository: 'override' | 'registered' | 'missing' | 'not_needed';
  /** HTTP / e-mail nodes against the target's egress policy. */
  readonly egress: readonly { path: string; code: string }[];
  /** Credential slots without a binding in the target. */
  readonly credentialUnbound: readonly string[];
  /** Privileged nodes of the version (accepted by attaching: the target's define.* actions and a step-up). */
  readonly privileged: readonly { node: string; type: string; action: string }[];
  /** Problems that block (an integrator in a workspace project, overrides that do not fit the version). */
  readonly issues: readonly { path: string; code: string }[];
}

export interface AttachmentView {
  readonly id: string;
  readonly project: string;
  readonly ownerProject: string;
  readonly name: string;
  readonly state: AttachmentState;
  readonly follow: 'auto' | 'pin';
  readonly version: number;
  /** The owner's definition id of the version this project runs (open it with `?project=`). */
  readonly definitionId: string | null;
  readonly latestVersion: number;
  readonly pendingVersion: number | null;
  readonly pendingReason: string | null;
  readonly ownerArchived: boolean;
  /** Whether the owner still offers it to this project (a withdrawn offer stops following). */
  readonly offered: boolean;
  readonly overrides: AttachmentOverrides;
  readonly slots: readonly {
    readonly slot: string;
    readonly kind: 'http-auth' | 'smtp';
    readonly hosts: readonly string[];
    readonly nodes: readonly string[];
    readonly credentialId: string | null;
  }[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly detachedAt: string | null;
  readonly lastRun: { readonly id: string; readonly state: string; readonly createdAt: string } | null;
}

export interface SharedWorkflowDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly notifications?: () => Pick<NotificationService, 'notify'> | null;
  readonly egress?: { effective(project: string): Promise<FunctionEgress> };
  /** Detach pauses the attachment's bound automations (absent: nothing to pause). */
  readonly pauseTriggers?: (
    actor: SharingActor & { readonly mfaAt?: Date | null },
    project: string,
    name: string,
  ) => Promise<void>;
}

const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const notFound = (): WorkflowError =>
  new WorkflowError(404, 'workflow_attachment_not_found', 'Attachment not found.');

export class SharedWorkflowService {
  constructor(private readonly deps: SharedWorkflowDeps) {}

  // -------------------------------------------------------------------------------- owner: offers

  /** The projects an owner workflow is offered to (`*` = every project). */
  async sharing(definitionId: string): Promise<{ ownerProject: string; name: string; projects: string[] }> {
    const d = await this.#definition(definitionId);
    const { rows } = await this.deps.pool.query<{ project: string }>(
      'SELECT project FROM workflow_shares WHERE owner_project = $1 AND name = $2 ORDER BY project',
      [d.project, d.name],
    );
    return { ownerProject: d.project, name: d.name, projects: rows.map((r) => r.project) };
  }

  /**
   * `PUT /workflows/:id/sharing`: the offer set (replaced). Withdrawing does not cut existing attachments — they stop
   * following new versions. Audited `workflow.share`.
   */
  async setSharing(
    actor: SharingActor,
    definitionId: string,
    projects: readonly string[],
  ): Promise<{ ownerProject: string; name: string; projects: string[] }> {
    const d = await this.#definition(definitionId);
    const set = [...new Set(projects)].sort();
    if (set.includes('*') && set.length > 1)
      throw new WorkflowError(
        400,
        'invalid_sharing',
        'Offer to every project ("*") or to listed projects, not both.',
      );
    if (set.includes(d.project))
      throw new WorkflowError(400, 'invalid_sharing', 'The owner project runs its workflow already.');
    for (const p of set) {
      if (p === '*') continue;
      if (!PROJECT.test(p) || (await projectKind(this.deps.pool, p)) === null)
        throw new WorkflowError(404, 'project_not_found', `Project ${p.slice(0, 128)} not found.`);
    }
    if (await ownerArchived(this.deps.pool, d.project, d.name))
      throw new WorkflowError(409, 'workflow_archived', 'This workflow is archived; restore it first.');
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ project: string }>(
        'SELECT project FROM workflow_shares WHERE owner_project = $1 AND name = $2 FOR UPDATE',
        [d.project, d.name],
      );
      await tx.query(
        'DELETE FROM workflow_shares WHERE owner_project = $1 AND name = $2 AND NOT (project = ANY($3::text[]))',
        [d.project, d.name, set],
      );
      for (const p of set)
        await tx.query(
          `INSERT INTO workflow_shares (owner_project, name, project, offered_by, offered_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [d.project, d.name, p, actor.id, now],
        );
      const prev = rows.map((r) => r.project).sort();
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'workflow.share',
          target: `workflow:${definitionId}`,
          outcome: 'success',
          metadata: {
            ownerProject: d.project,
            project: d.project,
            name: d.name,
            version: d.version,
            projects: set.slice(0, 50),
            withdrawn: prev.filter((p) => !set.includes(p)).slice(0, 50),
          },
        },
        tx,
      );
    });
    return { ownerProject: d.project, name: d.name, projects: set };
  }

  /** `GET /workflows/offers?project=`: workflows offered to a project (not archived, not its own). */
  async offers(project: string): Promise<
    {
      workflowId: string;
      ownerProject: string;
      name: string;
      description: string | null;
      latestVersion: number;
      nodes: number;
      attached: boolean;
      nameTaken: boolean;
    }[]
  > {
    const { rows } = await this.deps.pool.query<{
      id: string;
      owner_project: string;
      name: string;
      description: string | null;
      version: number;
      nodes: number;
      attached: boolean;
      name_taken: boolean;
    }>(
      `SELECT DISTINCT ON (s.owner_project, s.name) d.id, s.owner_project, s.name, d.definition->>'description' AS description,
              d.version, jsonb_array_length(d.definition->'nodes') AS nodes,
              EXISTS (SELECT 1 FROM workflow_attachments a WHERE a.project = $1 AND a.owner_project = s.owner_project
                         AND a.name = s.name AND a.state <> 'detached') AS attached,
              (EXISTS (SELECT 1 FROM workflow_definitions o WHERE o.project = $1 AND o.name = s.name)
               OR EXISTS (SELECT 1 FROM workflow_attachments a WHERE a.project = $1 AND a.name = s.name
                             AND a.state <> 'detached' AND a.owner_project <> s.owner_project)) AS name_taken
         FROM workflow_shares s
         JOIN LATERAL (SELECT x.id, x.version, x.definition FROM workflow_definitions x
                        WHERE x.project = s.owner_project AND x.name = s.name ORDER BY x.version DESC LIMIT 1) d ON true
        WHERE (s.project = $1 OR s.project = '*') AND s.owner_project <> $1
          AND NOT EXISTS (SELECT 1 FROM workflow_archives w WHERE w.project = s.owner_project AND w.name = s.name)
        ORDER BY s.owner_project, s.name`,
      [project],
    );
    return rows.map((r) => ({
      workflowId: r.id,
      ownerProject: r.owner_project,
      name: r.name,
      description: r.description,
      latestVersion: r.version,
      nodes: r.nodes,
      attached: r.attached,
      nameTaken: r.name_taken,
    }));
  }

  /** Whether a project may read an owner's workflow: a live attachment, or an offer the reader may attach from. */
  async readableIn(project: string, ownerProject: string, name: string, subject: Subject): Promise<boolean> {
    if ((await attachmentOf(this.deps.pool, project, ownerProject, name)) !== null) return true;
    return (
      authorize(subject, 'workflows.attach', { project }).allow &&
      (await isOffered(this.deps.pool, ownerProject, name, project))
    );
  }

  /** `GET /workflows/:id/attachments` ("Nerede kullanılıyor"): projects the caller can read; the rest as a count. */
  async whereUsed(
    subject: Subject,
    definitionId: string,
  ): Promise<{ attachments: AttachmentView[]; hidden: number; offeredTo: string[] }> {
    const d = await this.#definition(definitionId);
    const { rows } = await this.deps.pool.query<AttachmentRow>(
      `SELECT * FROM workflow_attachments WHERE owner_project = $1 AND name = $2 AND state <> 'detached'
        ORDER BY project`,
      [d.project, d.name],
    );
    const visible = rows.filter((r) => authorize(subject, 'workflows.read', { project: r.project }).allow);
    const views: AttachmentView[] = [];
    for (const r of visible) views.push(await this.#view(r));
    const offered = await this.sharing(definitionId);
    return { attachments: views, hidden: rows.length - visible.length, offeredTo: offered.projects };
  }

  // -------------------------------------------------------------------------------- target: attachments

  /**
   * `POST /projects/:project/workflow-attachments`: attach an offered workflow. The version's privileged nodes are
   * accepted here (the target's `workflows.define.*` actions and a fresh step-up); a version with credential slots is
   * attached `disabled` until every slot is bound. Name collisions in the project's namespace are refused.
   */
  async attach(
    actor: SharingActor,
    project: string,
    body: {
      readonly ownerProject: string;
      readonly name: string;
      readonly follow?: 'auto' | 'pin' | undefined;
      readonly version?: number | undefined;
      readonly overrides?: AttachmentOverrides | undefined;
    },
  ): Promise<{ attachment: AttachmentView; report: AttachReport }> {
    if (body.ownerProject === project)
      throw new WorkflowError(400, 'invalid_attachment', 'A project runs its own workflows already.');
    const kind = await projectKind(this.deps.pool, project);
    if (kind === null) throw new WorkflowError(404, 'project_not_found', 'Project not found.');
    // Without an offer the owner's workflow is not even visible here.
    if (!(await isOffered(this.deps.pool, body.ownerProject, body.name, project)))
      throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
    if (await ownerArchived(this.deps.pool, body.ownerProject, body.name))
      throw new WorkflowError(409, 'workflow_archived', 'This workflow is archived by its owner project.');
    const v = await versionRow(this.deps.pool, body.ownerProject, body.name, body.version ?? 'latest');
    if (v === null) throw new WorkflowError(404, 'workflow_not_found', 'Workflow version not found.');
    const overrides = AttachmentOverrides.parse(body.overrides ?? {});
    const report = await this.report(project, v.definition, overrides, null);
    if (report.issues.length > 0)
      throw new WorkflowError(
        400,
        'invalid_attachment',
        `invalid attachment: ${report.issues.map((i) => `${i.path}:${i.code}`).join(', ')}`.slice(0, 1000),
        report.issues,
      );
    await this.#acceptPrivileged(
      actor,
      project,
      body.ownerProject,
      body.name,
      report.privileged,
      'workflow.attach',
    );
    const now = this.deps.clock();
    const row = await withTransaction(this.deps.pool, async (tx) => {
      // The same lock as a new own version of the name (WorkflowService.define): own vs attached collisions.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `wfdef:${project}:${body.name}`,
      ]);
      const own = await tx.query(
        'SELECT 1 FROM workflow_definitions WHERE project = $1 AND name = $2 LIMIT 1',
        [project, body.name],
      );
      if ((own.rowCount ?? 0) > 0 || (await liveAttachment(tx, project, body.name)) !== null)
        throw new WorkflowError(
          409,
          'name_taken',
          `Project ${project} already has a workflow named ${body.name}; copy it under another name instead.`,
        );
      const state: AttachmentState = report.credentialUnbound.length > 0 ? 'disabled' : 'enabled';
      const { rows } = await tx.query<AttachmentRow>(
        `INSERT INTO workflow_attachments (project, owner_project, name, state, follow, version, overrides, created_by,
                                           created_at, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $9) RETURNING *`,
        [
          project,
          body.ownerProject,
          body.name,
          state,
          body.follow ?? 'auto',
          v.version,
          JSON.stringify(overrides),
          actor.id,
          now,
        ],
      );
      const r = rows[0] as AttachmentRow;
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'workflow.attach',
          target: `workflow-attachment:${r.id}`,
          outcome: 'success',
          metadata: {
            ownerProject: body.ownerProject,
            project,
            name: body.name,
            version: v.version,
            follow: r.follow,
            state,
            overrides: overridesHash(overrides),
            privileged: report.privileged.slice(0, 20).map((p) => `${p.node}:${p.type}`),
            unboundSlots: report.credentialUnbound.slice(0, 20),
          },
        },
        tx,
      );
      return r;
    });
    return { attachment: await this.#view(row), report };
  }

  /** `GET /projects/:project/workflow-attachments` (every state; detached ones keep their run history). */
  async list(project: string): Promise<AttachmentView[]> {
    const { rows } = await this.deps.pool.query<AttachmentRow>(
      'SELECT * FROM workflow_attachments WHERE project = $1 ORDER BY name, created_at DESC',
      [project],
    );
    const out: AttachmentView[] = [];
    for (const r of rows) out.push(await this.#view(r));
    return out;
  }

  /** `GET /workflow-attachments/:id`: the attachment with its fresh validation report. */
  async get(id: string): Promise<{ attachment: AttachmentView; report: AttachReport }> {
    const a = await attachmentById(this.deps.pool, id);
    if (a === null) throw notFound();
    const v = await versionRow(this.deps.pool, a.owner_project, a.name, a.version);
    const report = v === null ? null : await this.report(a.project, v.definition, a.overrides, a.id);
    return {
      attachment: await this.#view(a),
      report: report ?? {
        kind: 'repository',
        repository: 'not_needed',
        egress: [],
        credentialUnbound: [],
        privileged: [],
        issues: [],
      },
    };
  }

  /**
   * `PATCH /workflow-attachments/:id`: enable / disable, follow / pin, overrides (validated against the version run;
   * approver roles only raise, concurrency only lowers). Enabling needs every credential slot bound. Switching to
   * `auto` follows the owner's latest version at once when it may. Audited (the overrides as a hash).
   */
  async update(
    actor: SharingActor,
    id: string,
    patch: {
      readonly state?: 'enabled' | 'disabled' | undefined;
      readonly follow?: 'auto' | 'pin' | undefined;
      readonly overrides?: AttachmentOverrides | undefined;
    },
  ): Promise<{ attachment: AttachmentView; report: AttachReport }> {
    const a = await this.#live(id);
    const v = await versionRow(this.deps.pool, a.owner_project, a.name, a.version);
    if (v === null) throw new WorkflowError(404, 'workflow_not_found', 'Workflow version not found.');
    const overrides =
      patch.overrides === undefined ? a.overrides : AttachmentOverrides.parse(patch.overrides);
    if (patch.overrides !== undefined) {
      const issues = overrideIssues(v.definition, overrides);
      if (issues.length > 0)
        throw new WorkflowError(
          400,
          'invalid_overrides',
          `invalid overrides: ${issues.map((i) => `${i.path}:${i.code}`).join(', ')}`.slice(0, 1000),
          issues,
        );
    }
    if (patch.state === 'enabled') {
      const unbound = await unboundSlots(this.deps.pool, a.id, v.definition);
      if (unbound.length > 0)
        throw new WorkflowError(
          409,
          'credential_unbound',
          `Bind every credential slot first: ${unbound.join(', ')}.`,
        );
    }
    const now = this.deps.clock();
    const changed = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<AttachmentRow>(
        `UPDATE workflow_attachments SET state = COALESCE($2, state), follow = COALESCE($3, follow), overrides = $4,
                updated_by = $5, updated_at = $6
          WHERE id = $1 AND state <> 'detached' RETURNING *`,
        [a.id, patch.state ?? null, patch.follow ?? null, JSON.stringify(overrides), actor.id, now],
      );
      const r = rows[0];
      if (r === undefined) throw notFound();
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'workflow.attachment.update',
          target: `workflow-attachment:${a.id}`,
          outcome: 'success',
          metadata: {
            ownerProject: a.owner_project,
            project: a.project,
            name: a.name,
            version: a.version,
            ...(patch.state === undefined ? {} : { state: patch.state }),
            ...(patch.follow === undefined ? {} : { follow: patch.follow }),
            ...(patch.overrides === undefined ? {} : { overrides: overridesHash(overrides) }),
          },
        },
        tx,
      );
      return r;
    });
    if (patch.follow === 'auto') await this.#follow(changed);
    return this.get(a.id);
  }

  /**
   * `DELETE /workflow-attachments/:id`: detach — the row stays (run history), its bound automations are paused, the name
   * is free again in the project. Audited `workflow.detach`.
   */
  async detach(actor: SharingActor & { readonly mfaAt?: Date | null }, id: string): Promise<void> {
    const a = await this.#live(id);
    const now = this.deps.clock();
    await this.deps.pauseTriggers?.(actor, a.project, a.name);
    await withTransaction(this.deps.pool, async (tx) => {
      const res = await tx.query(
        `UPDATE workflow_attachments SET state = 'detached', detached_at = $2, updated_by = $3, updated_at = $2
          WHERE id = $1 AND state <> 'detached'`,
        [a.id, now, actor.id],
      );
      if ((res.rowCount ?? 0) === 0) throw notFound();
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'workflow.detach',
          target: `workflow-attachment:${a.id}`,
          outcome: 'success',
          metadata: { ownerProject: a.owner_project, project: a.project, name: a.name, version: a.version },
        },
        tx,
      );
    });
  }

  /**
   * `POST /workflow-attachments/:id/accept`: move the attachment to a version of the owner's line (a pending update, or
   * any version for a pinned one). Privileged nodes the version adds or changes need the target's `workflows.define.*`
   * actions and a fresh step-up — the same rule as saving such a version. An enabled attachment needs every slot of the
   * version bound. Audited `workflow.attachment.accept`.
   */
  async accept(
    actor: SharingActor,
    id: string,
    version: number,
  ): Promise<{ attachment: AttachmentView; report: AttachReport }> {
    const a = await this.#live(id);
    const cur = await versionRow(this.deps.pool, a.owner_project, a.name, a.version);
    const next = await versionRow(this.deps.pool, a.owner_project, a.name, version);
    if (cur === null || next === null)
      throw new WorkflowError(404, 'workflow_not_found', 'Workflow version not found.');
    const delta = privilegedDelta(asV2(cur.definition), asV2(next.definition));
    await this.#acceptPrivileged(
      actor,
      a.project,
      a.owner_project,
      a.name,
      delta.map((d) => ({ node: d.node, type: d.type, action: d.action })),
      'workflow.attachment.accept',
    );
    if (a.state === 'enabled') {
      const unbound = await unboundSlots(this.deps.pool, a.id, next.definition);
      if (unbound.length > 0)
        throw new WorkflowError(
          409,
          'credential_unbound',
          `This version needs credentials bound in ${a.project} first: ${unbound.join(', ')}.`,
        );
    }
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `UPDATE workflow_attachments SET version = $2,
                pending_version = CASE WHEN pending_version IS NOT NULL AND pending_version <= $2 THEN NULL
                                       ELSE pending_version END,
                pending_reason = CASE WHEN pending_version IS NOT NULL AND pending_version <= $2 THEN NULL
                                      ELSE pending_reason END,
                updated_by = $3, updated_at = $4
          WHERE id = $1`,
        [a.id, version, actor.id, now],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'workflow.attachment.accept',
          target: `workflow-attachment:${a.id}`,
          outcome: 'success',
          metadata: {
            ownerProject: a.owner_project,
            project: a.project,
            name: a.name,
            fromVersion: a.version,
            version,
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
    });
    return this.get(a.id);
  }

  /**
   * `PUT /workflow-attachments/:id/credentials/:slot`: bind a credential slot to one of the vault's credentials — the
   * right kind and bound to every host the slot's nodes call. Always-fresh step-up (route). Audited with the slot and
   * the credential id.
   */
  async bindCredential(
    actor: SharingActor,
    id: string,
    slot: string,
    credentialId: string,
  ): Promise<{ attachment: AttachmentView; report: AttachReport }> {
    const a = await this.#live(id);
    const uses = await this.#slotUses(a, slot);
    const c = await loadFunctionCredential(this.deps.pool, credentialId);
    if (c?.state !== 'active')
      throw new WorkflowError(404, 'credential_not_found', 'Credential not found or revoked.');
    // p22-vault-projects: the credential must be allowed for the project binding it (fail closed, audited).
    if (!credentialAllowsProject(c.projects, a.project)) {
      await this.deps.audit.record({
        actor: { type: 'user', id: actor.id },
        action: 'workflow.attachment.credential',
        target: `workflow-attachment:${a.id}`,
        outcome: 'denied',
        metadata: {
          ownerProject: a.owner_project,
          project: a.project,
          name: a.name,
          slot,
          boundVaultId: credentialId,
          denial: CREDENTIAL_NOT_ALLOWED_FOR_PROJECT,
        },
      });
      throw new WorkflowError(
        403,
        CREDENTIAL_NOT_ALLOWED_FOR_PROJECT,
        `Credential ${credentialId} is not allowed for project ${a.project}.`,
      );
    }
    for (const u of uses) {
      if (c.kind !== u.kind)
        throw new WorkflowError(400, 'credential_kind', `Slot ${slot} needs a ${u.kind} credential.`);
      const hosts = c.allowedHosts ?? [];
      const h = u.host.toLowerCase();
      if (!hosts.includes(h) && !hosts.includes(`${h}:${String(u.port)}`))
        throw new WorkflowError(
          400,
          'credential_host_not_bound',
          `Credential ${credentialId} is not bound to ${u.host}:${String(u.port)} (node ${u.nodeId}).`,
        );
    }
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `INSERT INTO workflow_attachment_credentials (attachment_id, slot, credential_id, bound_by, bound_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (attachment_id, slot) DO UPDATE SET credential_id = EXCLUDED.credential_id,
           bound_by = EXCLUDED.bound_by, bound_at = EXCLUDED.bound_at`,
        [a.id, slot, credentialId, actor.id, now],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'workflow.attachment.credential',
          target: `workflow-attachment:${a.id}`,
          outcome: 'success',
          metadata: {
            ownerProject: a.owner_project,
            project: a.project,
            name: a.name,
            version: a.version,
            slot,
            // (`credential…` keys are redacted by the audit log: the vault id is not a secret.)
            boundVaultId: credentialId,
          },
        },
        tx,
      );
    });
    return this.get(a.id);
  }

  /** `DELETE /workflow-attachments/:id/credentials/:slot`: unbind; an enabled attachment that needs it is disabled. */
  async unbindCredential(
    actor: SharingActor,
    id: string,
    slot: string,
  ): Promise<{ attachment: AttachmentView; report: AttachReport }> {
    const a = await this.#live(id);
    const v = await versionRow(this.deps.pool, a.owner_project, a.name, a.version);
    const needed = v !== null && slotNames(v.definition).includes(slot);
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const res = await tx.query(
        'DELETE FROM workflow_attachment_credentials WHERE attachment_id = $1 AND slot = $2',
        [a.id, slot],
      );
      if ((res.rowCount ?? 0) === 0)
        throw new WorkflowError(404, 'slot_not_bound', 'This slot has no credential bound.');
      if (needed && a.state === 'enabled')
        await tx.query(
          `UPDATE workflow_attachments SET state = 'disabled', updated_by = $2, updated_at = $3 WHERE id = $1`,
          [a.id, actor.id, now],
        );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'workflow.attachment.credential',
          target: `workflow-attachment:${a.id}`,
          outcome: 'success',
          metadata: {
            ownerProject: a.owner_project,
            project: a.project,
            name: a.name,
            slot,
            boundVaultId: null,
            ...(needed && a.state === 'enabled' ? { disabled: true } : {}),
          },
        },
        tx,
      );
    });
    return this.get(a.id);
  }

  // -------------------------------------------------------------------------------- owner versions → attachments

  /**
   * After the owner saved `version` of `(ownerProject, name)`: every following attachment (offer still in force) moves
   * to it when the privileged delta against the version it runs is empty and no new required input lacks a default
   * there; otherwise the version waits (`pending_version`) and the target's admins are told. Pinned attachments never
   * move. Returns the blast radius for the save answer.
   */
  async onOwnerVersion(
    ownerProject: string,
    name: string,
  ): Promise<{ advanced: string[]; pending: string[]; pinned: string[] }> {
    const { rows } = await this.deps.pool.query<AttachmentRow>(
      `SELECT * FROM workflow_attachments WHERE owner_project = $1 AND name = $2 AND state <> 'detached'
        ORDER BY project`,
      [ownerProject, name],
    );
    const out = { advanced: [] as string[], pending: [] as string[], pinned: [] as string[] };
    for (const a of rows) {
      if (a.follow === 'pin') {
        out.pinned.push(a.project);
        continue;
      }
      const r = await this.#follow(a);
      if (r === 'advanced') out.advanced.push(a.project);
      else if (r === 'pending') out.pending.push(a.project);
    }
    return out;
  }

  /** One attachment against the owner's latest version: advanced, pending (admins told) or nothing to do. */
  async #follow(a: AttachmentRow): Promise<'advanced' | 'pending' | 'none'> {
    if (a.follow !== 'auto' || a.state === 'detached') return 'none';
    if (!(await isOffered(this.deps.pool, a.owner_project, a.name, a.project))) return 'none';
    const latest = await versionRow(this.deps.pool, a.owner_project, a.name, 'latest');
    if (latest === null || latest.version <= a.version) return 'none';
    const cur = await versionRow(this.deps.pool, a.owner_project, a.name, a.version);
    if (cur === null) return 'none';
    const delta = privilegedDelta(asV2(cur.definition), asV2(latest.definition));
    const inputs = newRequiredInputs(cur.definition, latest.definition, a.overrides);
    const now = this.deps.clock();
    if (delta.length === 0 && inputs.length === 0) {
      await withTransaction(this.deps.pool, async (tx) => {
        await tx.query(
          `UPDATE workflow_attachments SET version = $2, pending_version = NULL, pending_reason = NULL, updated_at = $3
            WHERE id = $1 AND follow = 'auto' AND version < $2`,
          [a.id, latest.version, now],
        );
        await this.deps.audit.record(
          {
            actor: { type: 'system', id: 'workflow-sharing' },
            action: 'workflow.attachment.follow',
            target: `workflow-attachment:${a.id}`,
            outcome: 'success',
            metadata: {
              ownerProject: a.owner_project,
              project: a.project,
              name: a.name,
              fromVersion: a.version,
              version: latest.version,
            },
          },
          tx,
        );
      });
      return 'advanced';
    }
    if (a.pending_version === latest.version) return 'pending';
    const reason =
      delta.length > 0 && inputs.length > 0
        ? 'privileged_inputs'
        : delta.length > 0
          ? 'privileged'
          : 'inputs';
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `UPDATE workflow_attachments SET pending_version = $2, pending_reason = $3, updated_at = $4 WHERE id = $1`,
        [a.id, latest.version, reason, now],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'workflow-sharing' },
          action: 'workflow.attachment.pending',
          target: `workflow-attachment:${a.id}`,
          outcome: 'success',
          metadata: {
            ownerProject: a.owner_project,
            project: a.project,
            name: a.name,
            version: a.version,
            pendingVersion: latest.version,
            reason,
            ...(delta.length === 0
              ? {}
              : { actions: deltaActions(delta), nodes: delta.slice(0, 20).map((d) => d.node) }),
            ...(inputs.length === 0 ? {} : { inputs: inputs.slice(0, 20) }),
          },
        },
        tx,
      );
    });
    const svc = this.deps.notifications?.() ?? null;
    if (svc !== null) {
      const admins = await projectRecipients(this.deps.pool, a.project, 'admin');
      await svc.notify(this.deps.pool, admins, {
        kind: 'workflow.update_pending',
        severity: 'info',
        title: `Workflow ${a.name} v${String(latest.version)} waits for your acceptance`.slice(0, 200),
        body: `Project ${a.project} runs v${String(a.version)} of ${a.owner_project}/${a.name}. The new version ${
          delta.length > 0 ? `adds or changes privileged nodes (${deltaActions(delta).join(', ')})` : ''
        }${delta.length > 0 && inputs.length > 0 ? ' and ' : ''}${
          inputs.length > 0 ? `needs new inputs without a default here (${inputs.join(', ')})` : ''
        }.`.slice(0, 2000),
        link: `/workflows/${latest.id}?project=${encodeURIComponent(a.project)}`,
        dedupeKey: `workflow.update_pending:${a.id}:${String(latest.version)}`,
      });
    }
    return 'pending';
  }

  // -------------------------------------------------------------------------------- validation

  /** What attaching (or running) a version means in a target project; `issues` block attaching. */
  async report(
    project: string,
    def: StoredDefinition,
    overrides: AttachmentOverrides,
    attachmentId: string | null,
  ): Promise<AttachReport> {
    const kind = (await projectKind(this.deps.pool, project)) ?? 'repository';
    const ai = aiProjection(def);
    const issues: { path: string; code: string }[] = [...overrideIssues(def, overrides)];
    if (kind === 'workspace') {
      ai.nodes.forEach((n, i) => {
        if (n.role === 'integrator')
          issues.push({ path: `nodes.${String(i)}.role`, code: 'integrator_needs_repository' });
      });
      if (overrides.repository !== undefined) issues.push({ path: 'repository', code: 'not_allowed' });
    }
    const needsCode = ai.nodes.some(stepNeedsRepository);
    const registered =
      kind === 'workspace'
        ? null
        : (
            await this.deps.pool.query<{ project: string }>(
              'SELECT project FROM project_git_configs WHERE project = $1',
              [project],
            )
          ).rows[0];
    const repository =
      kind === 'workspace'
        ? 'not_needed'
        : overrides.repository !== undefined
          ? 'override'
          : registered !== undefined && registered !== null
            ? 'registered'
            : needsCode
              ? 'missing'
              : 'not_needed';
    const egressPolicy = (await this.deps.egress?.effective(project)) ?? { mode: 'open' as const, hosts: [] };
    const egress = (await functionNodeIssues(this.deps.pool, asV2(def).nodes, egressPolicy, project)).filter(
      // The owner's credentials are slots here: their host bindings are checked when the target binds one.
      (i) => !i.path.endsWith('.credential'),
    );
    const unbound =
      attachmentId === null ? slotNames(def) : await unboundSlots(this.deps.pool, attachmentId, def);
    const privileged = privilegedDelta(null, asV2(def)).map((d) => ({
      node: d.node,
      type: d.type,
      action: d.action,
    }));
    return { kind, repository, egress, credentialUnbound: unbound, privileged, issues: issues.slice(0, 20) };
  }

  // -------------------------------------------------------------------------------- helpers

  /** Privileged nodes accepted into `project` need its `workflows.define.*` actions and a fresh step-up (§8.5). */
  async #acceptPrivileged(
    actor: SharingActor,
    project: string,
    ownerProject: string,
    name: string,
    privileged: readonly { node: string; type: string; action: string }[],
    auditAction: string,
  ): Promise<void> {
    if (privileged.length === 0) return;
    const actions = [...new Set(privileged.map((p) => p.action))].sort();
    const missing = actions.filter((x) => !authorize(actor.subject, x as Action, { project }).allow);
    const deny = async (reason: string): Promise<void> => {
      await this.deps.audit.record({
        actor: { type: 'user', id: actor.id },
        action: auditAction,
        target: `workflow-definition:${ownerProject}/${name}`,
        outcome: 'denied',
        metadata: {
          ownerProject,
          project,
          name,
          reason,
          actions,
          nodes: privileged.slice(0, 20).map((p) => p.node),
        },
      });
    };
    if (missing.length > 0) {
      await deny('privileged_delta_forbidden');
      throw new WorkflowError(
        403,
        'forbidden',
        `This version has nodes that need ${missing.join(', ')} in ${project} (${privileged
          .slice(0, 5)
          .map((p) => p.node)
          .join(', ')}).`,
      );
    }
    if (!actor.stepUpFresh) {
      await deny('step_up_required');
      throw new WorkflowError(403, 'step_up_required', 'Confirm with a current authenticator code.');
    }
  }

  async #slotUses(a: AttachmentRow, slot: string) {
    const versions = [a.version, ...(a.pending_version === null ? [] : [a.pending_version])];
    const uses = [];
    for (const v of versions) {
      const row = await versionRow(this.deps.pool, a.owner_project, a.name, v);
      if (row !== null) uses.push(...credentialSlots(row.definition).filter((s) => s.slot === slot));
    }
    if (uses.length === 0)
      throw new WorkflowError(404, 'slot_not_found', 'The workflow has no such credential slot.');
    return uses;
  }

  async #live(id: string): Promise<AttachmentRow> {
    const a = await attachmentById(this.deps.pool, id);
    if (a === null || a.state === 'detached') throw notFound();
    return a;
  }

  async #definition(id: string): Promise<{ id: string; project: string; name: string; version: number }> {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
    const { rows } = await this.deps.pool.query<{
      id: string;
      project: string;
      name: string;
      version: number;
    }>('SELECT id, project, name, version FROM workflow_definitions WHERE id = $1', [id]);
    const d = rows[0];
    if (d === undefined) throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
    return d;
  }

  async #view(a: AttachmentRow): Promise<AttachmentView> {
    const db = this.deps.pool;
    const latest = await versionRow(db, a.owner_project, a.name, 'latest');
    const cur = await versionRow(db, a.owner_project, a.name, a.version);
    const bound = await slotBindings(db, a.id);
    const slots = new Map<
      string,
      {
        slot: string;
        kind: 'http-auth' | 'smtp';
        hosts: string[];
        nodes: string[];
        credentialId: string | null;
      }
    >();
    for (const s of cur === null ? [] : credentialSlots(cur.definition)) {
      const e = slots.get(s.slot) ?? {
        slot: s.slot,
        kind: s.kind,
        hosts: [],
        nodes: [],
        credentialId: bound.get(s.slot) ?? null,
      };
      const host = `${s.host}:${String(s.port)}`;
      if (!e.hosts.includes(host)) e.hosts.push(host);
      if (!e.nodes.includes(s.nodeId)) e.nodes.push(s.nodeId);
      slots.set(s.slot, e);
    }
    const { rows: last } = await db.query<{ id: string; state: string; created_at: Date }>(
      `SELECT r.id, ${PUBLIC_RUN_STATE_SQL('r')} AS state, r.created_at FROM workflow_runs r
        WHERE r.attachment_id = $1 ORDER BY r.created_at DESC, r.id LIMIT 1`,
      [a.id],
    );
    const l = last[0];
    return {
      id: a.id,
      project: a.project,
      ownerProject: a.owner_project,
      name: a.name,
      state: a.state,
      follow: a.follow,
      version: a.version,
      definitionId: cur?.id ?? null,
      latestVersion: latest?.version ?? a.version,
      pendingVersion: a.pending_version,
      pendingReason: a.pending_reason,
      ownerArchived: await ownerArchived(db, a.owner_project, a.name),
      offered: await isOffered(db, a.owner_project, a.name, a.project),
      overrides: a.overrides,
      slots: [...slots.values()].sort((x, y) => x.slot.localeCompare(y.slot)),
      createdBy: a.created_by,
      createdAt: a.created_at.toISOString(),
      updatedBy: a.updated_by,
      updatedAt: a.updated_at.toISOString(),
      detachedAt: a.detached_at?.toISOString() ?? null,
      lastRun: l === undefined ? null : { id: l.id, state: l.state, createdAt: l.created_at.toISOString() },
    };
  }
}
