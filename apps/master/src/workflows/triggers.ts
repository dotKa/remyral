import { createHash } from 'node:crypto';
import {
  schemaVersionOf,
  type StoredDefinition,
  type V2Node,
  type WorkflowDefinitionV2,
} from '@remyral/workflow-nodes';
import type { AuditRecorder } from '../audit/audit.js';
import { AutomationError, type AutomationInput, type AutomationPatch } from '../automations/model.js';
import type { AutomationActor, AutomationService } from '../automations/service.js';
import { authorize, type Subject } from '../authz/model.js';
import type { Pool } from '../db/pool.js';
import { WorkflowError } from './engine.js';
import { attachmentOf } from './sharing.js';
import { effectiveDefinition } from './sharing-model.js';

/**
 * p14-workflow-engine 14.2 (K2, design §3.1, §6): trigger nodes on the canvas are **declarations**; "Etkinleştir"
 * reconciles each of them into one automation bound to the workflow (`automations.workflow_trigger_node`,
 * `workflow_trigger_bindings`) — automations stay the single trigger runtime (signatures, nonces, catch-up, dedup,
 * `maxRunsPerHour`, run-as re-checks, audit, ADR-0024). Manual and chat triggers need no automation. Deactivating, or
 * removing a trigger node and activating again, pauses the bound automation (its history is kept).
 *
 * The run-as user of every bound automation is the activating user. Webhook and GitHub triggers need
 * `automations.external` and a fresh step-up (unchanged automation policy); the route needs `workflows.activate`.
 */

export const BOUND_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'trigger.schedule',
  'trigger.webhook',
  'trigger.github',
  'trigger.workflow',
]);
const EXTERNAL_TRIGGER_TYPES: ReadonlySet<string> = new Set(['trigger.webhook', 'trigger.github']);

export type TriggerStatus = 'active' | 'paused' | 'inactive' | 'failed';

export interface TriggerBindingView {
  readonly nodeId: string;
  readonly type: string;
  readonly binding: 'automation' | 'none';
  readonly status: TriggerStatus;
  readonly automationId: string | null;
  readonly automationState: string | null;
  /** The node's configuration changed since the last activation (activate again to apply it). */
  readonly upToDate: boolean;
  readonly webhookUrl: string | null;
  readonly lastRun: { readonly id: string; readonly state: string; readonly at: string } | null;
}

export interface ActivationView {
  readonly workflowId: string;
  readonly project: string;
  readonly name: string;
  readonly latestVersion: number;
  readonly enabled: boolean;
  readonly pinnedVersion: number | null;
  readonly needsExternal: boolean;
  readonly triggers: readonly TriggerBindingView[];
  readonly orphans: readonly {
    readonly nodeId: string;
    readonly automationId: string;
    readonly automationState: string;
  }[];
  /** PUT only: the secrets of newly created webhook automations (shown once, never stored in clear). */
  readonly webhookSecrets: readonly { readonly nodeId: string; readonly secret: string }[];
}

/** p16-workflow-quality: the trigger outcome of saving a version (`afterSave`). */
export interface SaveTriggers {
  /**
   * none: no bound trigger nodes; active: they start runs (bound automations follow this version); inactive: they do
   * not start runs (never activated); not_synced: activation was wanted but refused (permission, step-up, invalid
   * trigger); pinned: the triggers stay on a pinned version.
   */
  readonly state: 'none' | 'active' | 'inactive' | 'not_synced' | 'pinned';
  readonly triggers: { nodeId: string; type: string }[];
  readonly warning: string | null;
  /** Secrets of webhook triggers created now (shown once, never stored in clear). */
  readonly webhookSecrets: { nodeId: string; secret: string; url: string }[];
}

export interface ActivationActor {
  readonly id: string;
  readonly subject: Subject;
  readonly stepUpFresh: boolean;
  readonly mfaAt?: Date | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

interface Loaded {
  /** The project whose automations run the triggers (the owner project, or a project that attached the workflow). */
  readonly project: string;
  /** p18-multi-project: the owner project when `project` attached the workflow (else the same). */
  readonly ownerProject: string;
  readonly name: string;
  readonly latest: number;
  readonly chosen: { readonly id: string; readonly version: number; readonly definition: StoredDefinition };
  readonly triggers: readonly V2Node[];
}

interface BindingRow {
  trigger_node_id: string;
  automation_id: string;
  pinned_version: number | null;
  enabled: boolean;
  config_hash: string | null;
  state: string;
  last_run_id: string | null;
  last_run_state: string | null;
  last_run_at: Date | null;
  trigger_kind: string;
}

/** Key-order independent hash of a trigger node's configuration. */
export function triggerConfigHash(n: V2Node): string {
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return jsonText(v);
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  };
  return createHash('sha256')
    .update(`${n.type}\n${stable((n as { config?: unknown }).config ?? {})}`)
    .digest('hex');
}

/** The automation trigger (+ policies) of a trigger node (its config is validated by the catalog at save). */
export function automationTriggerOf(
  n: V2Node,
): Pick<AutomationInput, 'trigger'> & Pick<AutomationPatch, 'catchUp' | 'webhookAllowIps'> {
  const c = ((n as { config?: unknown }).config ?? {}) as Record<string, unknown>;
  switch (n.type) {
    case 'trigger.schedule': {
      // p16-workflow-quality: the node's zone (`timezone` or `timeZone`) travels to the automation.
      const tz =
        typeof c.timeZone === 'string' ? c.timeZone : typeof c.timezone === 'string' ? c.timezone : 'UTC';
      const zone = tz === 'UTC' ? {} : { timeZone: tz };
      return {
        trigger:
          typeof c.cron === 'string'
            ? { kind: 'cron', cron: c.cron, ...zone }
            : { kind: 'at', at: String(c.at), ...zone },
        catchUp: (c.catchUp as 'skip' | 'once' | 'all' | undefined) ?? 'skip',
      };
    }
    case 'trigger.webhook': {
      const ips = c.ipAllowlist as string[] | undefined;
      return {
        trigger: { kind: 'webhook' },
        webhookAllowIps: ips === undefined || ips.length === 0 ? null : ips,
      };
    }
    case 'trigger.github': {
      const events = (c.events as string[] | undefined) ?? [];
      const rest = events.slice(1);
      return {
        trigger: {
          kind: 'github',
          repository: String(c.repository),
          event: events[0] as 'push',
          ...(rest.length === 0 ? {} : { additionalEvents: rest as ['push'] }),
          ...(c.actions === undefined ? {} : { actions: c.actions as string[] }),
          ...(c.branches === undefined ? {} : { branches: c.branches as string[] }),
          ...(c.labels === undefined ? {} : { labels: c.labels as string[] }),
          ...(c.command === undefined ? {} : { command: c.command as string }),
          ...(c.allowUntrusted === true ? { allowUntrusted: true } : {}),
        },
      };
    }
    case 'trigger.workflow': {
      const w = c.workflow as { project?: string; name: string };
      return {
        trigger: {
          kind: 'chain',
          workflow: { ...(w.project === undefined ? {} : { project: w.project }), name: w.name },
          on: (c.outcomes as ('succeeded' | 'failed' | 'cancelled')[] | undefined) ?? ['succeeded'],
        },
      };
    }
    default:
      throw new WorkflowError(400, 'invalid_workflow', `${n.type} is not bound to an automation`);
  }
}

export class WorkflowTriggerService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly automations: () => AutomationService | null;
    },
  ) {}

  /**
   * The definition a workflow id names, the latest version and the version the triggers come from. p18-multi-project:
   * with `project` other than the owner, the triggers of that project's attachment — its version (no pin of its own:
   * the attachment's version line decides) with its trigger overrides (schedule, zone, GitHub repository / events).
   */
  async #load(workflowId: string, pinned: number | null, project?: string): Promise<Loaded> {
    const { rows } = await this.deps.pool.query<{ project: string; name: string }>(
      'SELECT project, name FROM workflow_definitions WHERE id = $1',
      [workflowId],
    );
    const w = rows[0];
    if (w === undefined) throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
    if (project !== undefined && project !== w.project) {
      const a = await attachmentOf(this.deps.pool, project, w.project, w.name);
      if (a === null) throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
      if (pinned !== null)
        throw new WorkflowError(
          400,
          'invalid_activation',
          'A shared workflow runs the version its attachment follows; pin the attachment instead.',
        );
      const { rows: vs } = await this.deps.pool.query<{
        id: string;
        version: number;
        definition: StoredDefinition;
      }>(
        `SELECT id, version, definition FROM workflow_definitions WHERE project = $1 AND name = $2
          AND version = $3`,
        [w.project, w.name, a.version],
      );
      const v = vs[0];
      if (v === undefined) throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
      const def = effectiveDefinition(v.definition, a.overrides, true);
      return {
        project,
        ownerProject: w.project,
        name: w.name,
        latest: a.version,
        chosen: { id: v.id, version: v.version, definition: def },
        triggers:
          schemaVersionOf(def) === 2
            ? (def as WorkflowDefinitionV2).nodes.filter(
                (n) => n.parent === undefined && n.type.startsWith('trigger.'),
              )
            : [],
      };
    }
    const { rows: versions } = await this.deps.pool.query<{
      id: string;
      version: number;
      definition: StoredDefinition;
    }>(
      `SELECT id, version, definition FROM workflow_definitions WHERE project = $1 AND name = $2
        AND ($3::int IS NULL OR version = $3 OR version = (SELECT max(version) FROM workflow_definitions
                                                              WHERE project = $1 AND name = $2))
        ORDER BY version DESC`,
      [w.project, w.name, pinned],
    );
    const latest = versions[0];
    if (latest === undefined) throw new WorkflowError(404, 'workflow_not_found', 'Workflow not found.');
    const chosen = pinned === null ? latest : versions.find((v) => v.version === pinned);
    if (chosen === undefined)
      throw new WorkflowError(
        400,
        'invalid_activation',
        `Version ${String(pinned)} of the workflow does not exist.`,
      );
    const def = chosen.definition;
    const triggers =
      schemaVersionOf(def) === 2
        ? (def as WorkflowDefinitionV2).nodes.filter(
            (n) => n.parent === undefined && n.type.startsWith('trigger.'),
          )
        : [];
    return {
      project: w.project,
      ownerProject: w.project,
      name: w.name,
      latest: latest.version,
      chosen,
      triggers,
    };
  }

  async #bindings(project: string, name: string): Promise<BindingRow[]> {
    const { rows } = await this.deps.pool.query<BindingRow>(
      `SELECT b.trigger_node_id, b.automation_id, b.pinned_version, b.enabled, b.config_hash, a.state,
              a.last_run_id, a.last_run_state, a.last_run_at, a.trigger_kind
         FROM workflow_trigger_bindings b JOIN automations a ON a.id = b.automation_id
        WHERE b.project = $1 AND b.name = $2 ORDER BY b.trigger_node_id`,
      [project, name],
    );
    return rows;
  }

  /** `GET /workflows/:id/activation`: every trigger node and its bound automation (of `project`, default the owner). */
  async status(workflowId: string, project?: string): Promise<ActivationView> {
    const first = await this.#load(workflowId, null, project);
    const bindings = await this.#bindings(first.project, first.name);
    const pinned = bindings.find((b) => b.pinned_version !== null)?.pinned_version ?? null;
    const w =
      pinned === null || first.project !== first.ownerProject ? first : await this.#load(workflowId, pinned);
    return this.#view(workflowId, w, bindings, []);
  }

  #view(
    workflowId: string,
    w: Loaded,
    bindings: readonly BindingRow[],
    secrets: { nodeId: string; secret: string }[],
  ): ActivationView {
    const automations = this.deps.automations();
    const ids = new Set(w.triggers.map((t) => t.id));
    const triggers = w.triggers.map((t): TriggerBindingView => {
      if (!BOUND_TRIGGER_TYPES.has(t.type))
        return {
          nodeId: t.id,
          type: t.type,
          binding: 'none',
          status: 'active',
          automationId: null,
          automationState: null,
          upToDate: true,
          webhookUrl: null,
          lastRun: null,
        };
      const b = bindings.find((x) => x.trigger_node_id === t.id);
      const status: TriggerStatus =
        b === undefined || b.state === 'deleted' || !b.enabled
          ? 'inactive'
          : b.state === 'active'
            ? 'active'
            : b.state === 'failed'
              ? 'failed'
              : 'paused';
      return {
        nodeId: t.id,
        type: t.type,
        binding: 'automation',
        status,
        automationId: b?.automation_id ?? null,
        automationState: b?.state ?? null,
        upToDate: b === undefined || b.config_hash === triggerConfigHash(t),
        webhookUrl:
          b !== undefined && b.trigger_kind === 'webhook' && automations !== null
            ? automations.webhookUrl(b.automation_id)
            : null,
        lastRun:
          b?.last_run_id == null || b.last_run_state === null || b.last_run_at === null
            ? null
            : { id: b.last_run_id, state: b.last_run_state, at: b.last_run_at.toISOString() },
      };
    });
    return {
      workflowId,
      project: w.project,
      name: w.name,
      latestVersion: w.latest,
      enabled: bindings.some((b) => b.enabled && ids.has(b.trigger_node_id)),
      pinnedVersion: bindings.find((b) => b.pinned_version !== null)?.pinned_version ?? null,
      needsExternal: w.triggers.some((t) => EXTERNAL_TRIGGER_TYPES.has(t.type)),
      triggers,
      orphans: bindings
        .filter((b) => !ids.has(b.trigger_node_id))
        .map((b) => ({ nodeId: b.trigger_node_id, automationId: b.automation_id, automationState: b.state })),
      webhookSecrets: secrets,
    };
  }

  /**
   * `PUT /workflows/:id/activation`: enabled → every bound trigger node gets (or updates) its automation and is
   * resumed; removed nodes' automations are paused. disabled → every bound automation is paused. Audited.
   */
  async activate(
    actor: ActivationActor,
    workflowId: string,
    body: {
      readonly enabled: boolean;
      readonly pinnedVersion?: number | null | undefined;
      /** p18-multi-project: the project whose triggers these are (a project that attached it; default the owner). */
      readonly project?: string | undefined;
    },
  ): Promise<ActivationView> {
    const automations = this.deps.automations();
    if (automations === null)
      throw new WorkflowError(
        409,
        'automations_unavailable',
        'Automations are not available on this master.',
      );
    const pinned = body.pinnedVersion ?? null;
    const w = await this.#load(workflowId, pinned, body.project);
    const bound = w.triggers.filter((t) => BOUND_TRIGGER_TYPES.has(t.type));
    const external = bound.some((t) => EXTERNAL_TRIGGER_TYPES.has(t.type));
    if (body.enabled && external) {
      if (!authorize(actor.subject, 'automations.external', { project: w.project }).allow) {
        await this.#audit(actor, w, 'denied', { reason: 'external_forbidden' });
        throw new WorkflowError(
          403,
          'forbidden',
          'Webhook and GitHub triggers need a project admin (automations.external).',
        );
      }
      if (!actor.stepUpFresh) {
        await this.#audit(actor, w, 'denied', { reason: 'step_up_required' });
        throw new WorkflowError(403, 'step_up_required', 'Confirm with a current authenticator code.');
      }
    }
    const a: AutomationActor = {
      id: actor.id,
      subject: actor.subject,
      stepUpFresh: actor.stepUpFresh,
      ...(actor.mfaAt === undefined ? {} : { mfaAt: actor.mfaAt }),
      ...(actor.ip === undefined ? {} : { ip: actor.ip }),
      ...(actor.userAgent === undefined ? {} : { userAgent: actor.userAgent }),
    };
    const secrets: { nodeId: string; secret: string }[] = [];
    const before = await this.#bindings(w.project, w.name);
    const now = this.deps.clock();
    try {
      if (body.enabled) {
        for (const t of bound) {
          const mapped = automationTriggerOf(t);
          const name = `${w.name} · ${t.id}`.slice(0, 200);
          const b = before.find((x) => x.trigger_node_id === t.id && x.state !== 'deleted');
          let automationId: string;
          if (b === undefined) {
            const created = await automations.create(
              a,
              {
                project: w.project,
                name,
                description: `Trigger node “${t.id}” of workflow ${w.name} (bound on the canvas).`,
                trigger: mapped.trigger,
                target: { kind: 'workflow', workflowId: w.chosen.id, inputs: {} },
                enabled: true,
                ...(mapped.catchUp === undefined ? {} : { catchUp: mapped.catchUp }),
                ...(mapped.webhookAllowIps == null ? {} : { webhookAllowIps: mapped.webhookAllowIps }),
              },
              { bindingNode: t.id },
            );
            automationId = created.automation.id;
            if (created.webhookSecret !== null) secrets.push({ nodeId: t.id, secret: created.webhookSecret });
          } else {
            automationId = b.automation_id;
            const updated = await automations.update(
              a,
              automationId,
              {
                name,
                trigger: mapped.trigger,
                target: { kind: 'workflow', workflowId: w.chosen.id, inputs: {} },
                ...(mapped.catchUp === undefined ? {} : { catchUp: mapped.catchUp }),
                ...(mapped.trigger.kind === 'webhook'
                  ? { webhookAllowIps: mapped.webhookAllowIps ?? null }
                  : {}),
              },
              { binding: true },
            );
            if (updated.webhookSecret !== null) secrets.push({ nodeId: t.id, secret: updated.webhookSecret });
            if (updated.automation.state === 'paused' || updated.automation.state === 'failed')
              await automations.resume(a, automationId);
          }
          await this.deps.pool.query(
            `INSERT INTO workflow_trigger_bindings (project, name, trigger_node_id, automation_id, pinned_version, enabled,
                                                    updated_by, updated_at, activated_version, config_hash)
             VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9)
             ON CONFLICT (project, name, trigger_node_id) DO UPDATE SET automation_id = EXCLUDED.automation_id,
               pinned_version = EXCLUDED.pinned_version, enabled = true, updated_by = EXCLUDED.updated_by,
               updated_at = EXCLUDED.updated_at, activated_version = EXCLUDED.activated_version,
               config_hash = EXCLUDED.config_hash`,
            [
              w.project,
              w.name,
              t.id,
              automationId,
              pinned,
              actor.id,
              now,
              w.chosen.version,
              triggerConfigHash(t),
            ],
          );
        }
      }
      // Deactivation, and trigger nodes no longer on the canvas: their automations pause (history kept).
      const keep = new Set(body.enabled ? bound.map((t) => t.id) : []);
      for (const b of before) {
        if (keep.has(b.trigger_node_id)) continue;
        if (b.state === 'active') await automations.pause(a, b.automation_id);
        await this.deps.pool.query(
          `UPDATE workflow_trigger_bindings SET enabled = false, updated_by = $4, updated_at = $5
            WHERE project = $1 AND name = $2 AND trigger_node_id = $3`,
          [w.project, w.name, b.trigger_node_id, actor.id, now],
        );
      }
    } catch (err) {
      if (err instanceof AutomationError)
        throw new WorkflowError(
          err.status === 403 || err.status === 404 || err.status === 409 ? err.status : 400,
          err.code,
          err.message,
        );
      throw err;
    }
    await this.#audit(actor, w, 'success', {
      enabled: body.enabled,
      triggers: bound.map((t) => `${t.id}:${t.type}`),
      ...(pinned === null ? {} : { pinnedVersion: pinned }),
    });
    return this.#view(workflowId, w, await this.#bindings(w.project, w.name), secrets);
  }

  /**
   * p16-workflow-quality (design §4): what saving a version means for its trigger nodes — never a silently dead
   * trigger. A workflow whose triggers already follow the latest version (activated, not pinned) is re-synced at once
   * (new schedules / webhooks bound, removed ones paused); `activate` (a chat card that asked for it) turns them on for
   * the first time. Otherwise — or when the saving user may not activate (`workflows.activate`, webhook / GitHub:
   * `automations.external` + a fresh step-up) — the answer says plainly that the trigger nodes do not start runs yet.
   * The version is saved either way; a failed activation is reported, not thrown.
   */
  async afterSave(
    actor: ActivationActor,
    workflowId: string,
    opts: { readonly activate?: boolean } = {},
  ): Promise<SaveTriggers> {
    const w = await this.#load(workflowId, null);
    const bound = w.triggers.filter((t) => BOUND_TRIGGER_TYPES.has(t.type));
    const before = await this.#bindings(w.project, w.name);
    const pinned = before.find((b) => b.enabled && b.pinned_version !== null)?.pinned_version ?? null;
    const following = before.some((b) => b.enabled && b.pinned_version === null && b.state !== 'deleted');
    const triggers = bound.map((t) => ({ nodeId: t.id, type: t.type }));
    const none: SaveTriggers = { state: 'none', triggers, warning: null, webhookSecrets: [] };
    if (pinned !== null) {
      return {
        state: 'pinned',
        triggers,
        warning: `The triggers stay on version ${String(pinned)} (pinned); activate again to move them to this version.`,
        webhookSecrets: [],
      };
    }
    if (bound.length === 0 && !following) return none;
    const wants = opts.activate === true || following;
    const inactive = (warning: string): SaveTriggers => ({
      state: wants ? 'not_synced' : 'inactive',
      triggers,
      warning,
      webhookSecrets: [],
    });
    const how = `Workflows → ${w.name} → Etkinleştir`;
    if (!wants) {
      return inactive(
        `Saved, but its trigger nodes (${bound.map((t) => t.type).join(', ')}) do not start runs until the workflow is activated (${how}).`,
      );
    }
    if (!authorize(actor.subject, 'workflows.activate', { project: w.project }).allow) {
      return inactive(
        `You may not activate workflows in ${w.project}; a project operator must activate it (${how}).`,
      );
    }
    const external = bound.some((t) => EXTERNAL_TRIGGER_TYPES.has(t.type));
    if (
      external &&
      (!authorize(actor.subject, 'automations.external', { project: w.project }).allow || !actor.stepUpFresh)
    ) {
      return inactive(
        `Webhook and GitHub triggers need a project admin with a current authenticator code to activate (${how}).`,
      );
    }
    try {
      const view = await this.activate(actor, workflowId, { enabled: true, pinnedVersion: null });
      const automations = this.deps.automations();
      return {
        state: bound.length === 0 ? 'none' : 'active',
        triggers,
        warning: null,
        webhookSecrets: view.webhookSecrets.map((x) => {
          const b = view.triggers.find((t) => t.nodeId === x.nodeId);
          return {
            ...x,
            url:
              b?.webhookUrl ??
              (b?.automationId == null ? '' : (automations?.webhookUrl(b.automationId) ?? '')),
          };
        }),
      };
    } catch (err) {
      if (!(err instanceof WorkflowError)) throw err;
      return inactive(`Saved, but the triggers could not be activated: ${err.message}`);
    }
  }

  /**
   * p16-workflow-quality: archiving a workflow pauses its bound automations (an archived workflow refuses new runs, so
   * a live schedule would only fail); restoring it does not resume them — activate again.
   */
  async onArchive(actor: ActivationActor, workflowId: string): Promise<void> {
    const w = await this.#load(workflowId, null);
    const before = await this.#bindings(w.project, w.name);
    if (!before.some((b) => b.enabled)) return;
    await this.activate(actor, workflowId, { enabled: false });
  }

  /**
   * p18-multi-project: detaching a shared workflow pauses the automations its triggers are bound to in that project
   * (history kept), exactly like deactivating; nothing to do without bindings.
   */
  async pauseProject(actor: ActivationActor, project: string, name: string): Promise<void> {
    const before = await this.#bindings(project, name);
    if (!before.some((b) => b.enabled)) return;
    const automations = this.deps.automations();
    if (automations === null) return;
    const a: AutomationActor = {
      id: actor.id,
      subject: actor.subject,
      stepUpFresh: actor.stepUpFresh,
      ...(actor.mfaAt === undefined ? {} : { mfaAt: actor.mfaAt }),
    };
    const now = this.deps.clock();
    for (const b of before) {
      if (b.state === 'active') await automations.pause(a, b.automation_id);
      await this.deps.pool.query(
        `UPDATE workflow_trigger_bindings SET enabled = false, updated_by = $4, updated_at = $5
          WHERE project = $1 AND name = $2 AND trigger_node_id = $3`,
        [project, name, b.trigger_node_id, actor.id, now],
      );
    }
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.id },
      action: 'workflow.deactivate',
      target: `workflow-definition:${project}/${name}`,
      outcome: 'success',
      metadata: { project, name, enabled: false, reason: 'detached' },
    });
  }

  async #audit(
    actor: ActivationActor,
    w: { project: string; ownerProject: string; name: string; chosen: { id: string; version: number } },
    outcome: 'success' | 'denied',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.id },
      action: metadata.enabled === false ? 'workflow.deactivate' : 'workflow.activate',
      target: `workflow-definition:${w.project}/${w.name}`,
      outcome,
      metadata: {
        project: w.project,
        name: w.name,
        version: w.chosen.version,
        ...(w.ownerProject === w.project ? {} : { ownerProject: w.ownerProject }),
        ...metadata,
      },
    });
  }
}

/** JSON text of a scalar (`undefined` has none: `null`). */
function jsonText(v: unknown): string {
  return v === undefined ? 'null' : JSON.stringify(v);
}
