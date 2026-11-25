import { createHash } from 'node:crypto';
import { WORKFLOW_LIMITS } from '@remyral/scheduler';
import {
  INPUT_NAME_PATTERN,
  normaliseV1,
  originPort,
  Repository,
  schemaVersionOf,
  smtpServer,
  type EmailSendConfig,
  type StoredDefinition,
  type V2Node,
  type WorkflowDefinition,
  type WorkflowDefinitionV2,
  WORKFLOW_NAME_PATTERN,
} from '@remyral/workflow-nodes';
import { z } from 'zod';

/**
 * p18-multi-project W1 + W2 (docs/design/p18-multi-project.md §2.1): the pure part of shared workflows — the
 * per-attachment overrides (validated jsonb), how they change the definition a target project runs (approver roles only
 * raise, concurrency only lowers, the owner's repository is never used outside the owner project), the credential
 * slots of a definition, and the compatibility of a new owner version with an attachment. No I/O.
 */

const NODE_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const ROLES = ['operator', 'admin', 'owner'] as const;
export type ApproverRole = (typeof ROLES)[number];
const RANK: Readonly<Record<string, number>> = { viewer: 0, operator: 1, admin: 2, owner: 3 };
/** An IANA zone name (the automation service checks it against the runtime at activation). */
const ZONE = /^(UTC|[A-Za-z_]{1,32}(\/[A-Za-z0-9_+-]{1,32}){1,2})$/;

export const TriggerOverride = z.strictObject({
  /** trigger.schedule: another cron (5 fields) and / or zone. */
  cron: z.string().min(9).max(120).optional(),
  timeZone: z.string().regex(ZONE).optional(),
  /** trigger.github: the target's repository (owner/name) and event filter. */
  repository: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)
    .optional(),
  events: z
    .array(z.enum(['pull_request', 'push', 'issues', 'issue_comment']))
    .min(1)
    .max(4)
    .optional(),
  branches: z
    .array(z.string().regex(/^[A-Za-z0-9_.\-/*]{1,255}$/))
    .min(1)
    .max(20)
    .optional(),
});
export type TriggerOverride = z.infer<typeof TriggerOverride>;

/** The settings a target project gives its attachment (all optional; validated against the version it runs). */
export const AttachmentOverrides = z.strictObject({
  /** Default values of the workflow's inputs in this project (a run's own value wins). */
  inputs: z
    .record(z.string().regex(INPUT_NAME_PATTERN), z.string().max(WORKFLOW_LIMITS.maxInputChars))
    .optional(),
  /** The repository runs use (default: the project's registered repository; never the owner's). */
  repository: Repository.optional(),
  /** Approver role per gate node (AI step approval or control.approval) — may only raise. */
  approvers: z.record(z.string().regex(NODE_ID), z.enum(ROLES)).optional(),
  /** The error workflow (a workflow name of this project, own or attached). */
  onFailure: z.strictObject({ workflow: z.string().regex(WORKFLOW_NAME_PATTERN) }).optional(),
  /** Days the data of finished runs is kept in this project. */
  retentionDays: z.number().int().min(1).max(365).optional(),
  /** Per trigger node: schedule / GitHub settings of this project's automations. */
  triggers: z.record(z.string().regex(NODE_ID), TriggerOverride).optional(),
  /** At most this many open runs in this project (only ≤ the definition's). */
  concurrency: z.strictObject({ max: z.number().int().min(1).max(50) }).optional(),
});
export type AttachmentOverrides = z.infer<typeof AttachmentOverrides>;

/** A stored document as v2 (v1 documents normalised exactly). */
export function asV2(def: StoredDefinition): WorkflowDefinitionV2 {
  return schemaVersionOf(def) === 2
    ? (def as WorkflowDefinitionV2)
    : normaliseV1(def as unknown as WorkflowDefinition);
}

const higher = (a: string, b: string | undefined): string =>
  b !== undefined && (RANK[b] ?? -1) > (RANK[a] ?? -1) ? b : a;

/** The approver role a gate node has in the definition (null: not a gate). */
export function gateRoleOf(n: V2Node | WorkflowDefinition['nodes'][number]): string | null {
  const type = (n as { type?: string }).type;
  if (type === 'control.approval') {
    const role = (n as { config?: { approverRole?: unknown } }).config?.approverRole;
    return typeof role === 'string' ? role : 'admin';
  }
  const approval = (n as { approval?: { approverRole?: string } }).approval;
  return approval === undefined ? null : (approval.approverRole ?? 'admin');
}

/**
 * The definition a target project runs: overrides applied (gate roles raised, settings replaced, concurrency lowered,
 * trigger settings), and — outside the owner project — the owner's `defaults.repository` dropped. Works on stored v1
 * and v2 documents alike (the shape is kept). `attached: false` with empty overrides returns the document unchanged.
 */
export function effectiveDefinition<T extends StoredDefinition>(
  def: T,
  overrides: AttachmentOverrides,
  attached: boolean,
): T {
  const v2 = schemaVersionOf(def) === 2;
  const doc = def as unknown as {
    defaults: Record<string, unknown>;
    nodes: Record<string, unknown>[];
    settings?: Record<string, unknown>;
  };
  const approvers = overrides.approvers ?? {};
  const triggers = overrides.triggers ?? {};
  const nodes = doc.nodes.map((n) => {
    const id = String(n.id);
    const type = typeof n.type === 'string' ? n.type : 'ai.step';
    const raise = approvers[id];
    if (type === 'control.approval' && raise !== undefined) {
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      const role = typeof cfg.approverRole === 'string' ? cfg.approverRole : 'admin';
      return { ...n, config: { ...cfg, approverRole: higher(role, raise) } };
    }
    const approval = n.approval as { approverRole?: string } | undefined;
    if (approval !== undefined && raise !== undefined)
      return {
        ...n,
        approval: { ...approval, approverRole: higher(approval.approverRole ?? 'admin', raise) },
      };
    const t = triggers[id];
    if (t !== undefined && (type === 'trigger.schedule' || type === 'trigger.github')) {
      const cfg = { ...((n.config ?? {}) as Record<string, unknown>) };
      if (type === 'trigger.schedule') {
        if (t.cron !== undefined) {
          cfg.cron = t.cron;
          delete cfg.at;
        }
        if (t.timeZone !== undefined) {
          cfg.timeZone = t.timeZone;
          delete cfg.timezone;
        }
      } else {
        if (t.repository !== undefined) cfg.repository = t.repository;
        if (t.events !== undefined) cfg.events = t.events;
        if (t.branches !== undefined) cfg.branches = t.branches;
      }
      return { ...n, config: cfg };
    }
    return n;
  });
  const { repository: _owners, ...defaults } = doc.defaults;
  const settings = { ...(doc.settings ?? {}) };
  if (v2) {
    if (overrides.onFailure !== undefined) settings.onFailure = overrides.onFailure;
    if (overrides.retentionDays !== undefined) settings.retentionDays = overrides.retentionDays;
    const conc = settings.concurrency as { max: number } | undefined;
    if (conc !== undefined && overrides.concurrency !== undefined)
      settings.concurrency = { ...conc, max: Math.min(conc.max, overrides.concurrency.max) };
  }
  return {
    ...def,
    defaults: attached ? defaults : doc.defaults,
    nodes,
    ...(v2 && Object.keys(settings).length > 0 ? { settings } : {}),
  } as unknown as T;
}

/** Override problems against the version an attachment runs (paths and codes, like definition issues). */
export function overrideIssues(
  def: StoredDefinition,
  overrides: AttachmentOverrides,
): { path: string; code: string }[] {
  const v2 = asV2(def);
  const issues: { path: string; code: string }[] = [];
  const byId = new Map(v2.nodes.map((n) => [n.id, n]));
  for (const [id, role] of Object.entries(overrides.approvers ?? {})) {
    const n = byId.get(id);
    const current = n === undefined ? null : gateRoleOf(n);
    if (current === null) issues.push({ path: `approvers.${id}`, code: 'not_a_gate' });
    else if ((RANK[role] ?? -1) < (RANK[current] ?? -1))
      issues.push({ path: `approvers.${id}`, code: 'lower_than_definition' });
  }
  for (const name of Object.keys(overrides.inputs ?? {}))
    if (!(name in v2.inputs)) issues.push({ path: `inputs.${name}`, code: 'unknown' });
  for (const [id, t] of Object.entries(overrides.triggers ?? {})) {
    const n = byId.get(id);
    if (n?.type === 'trigger.schedule') {
      if (t.repository !== undefined || t.events !== undefined || t.branches !== undefined)
        issues.push({ path: `triggers.${id}`, code: 'not_allowed' });
    } else if (n?.type === 'trigger.github') {
      if (t.cron !== undefined || t.timeZone !== undefined)
        issues.push({ path: `triggers.${id}`, code: 'not_allowed' });
    } else issues.push({ path: `triggers.${id}`, code: 'not_a_trigger' });
  }
  const conc = v2.settings?.concurrency;
  if (overrides.concurrency !== undefined) {
    if (conc === undefined) issues.push({ path: 'concurrency.max', code: 'not_allowed' });
    else if (overrides.concurrency.max > conc.max)
      issues.push({ path: 'concurrency.max', code: 'higher_than_definition' });
  }
  if (
    schemaVersionOf(def) !== 2 &&
    (overrides.onFailure !== undefined || overrides.retentionDays !== undefined)
  )
    issues.push({ path: 'settings', code: 'engine_v2_only' });
  return issues;
}

/** A vault credential id written in the definition (an HTTP auth or SMTP credential) and where. */
export interface CredentialSlot {
  readonly slot: string;
  readonly nodeId: string;
  readonly kind: 'http-auth' | 'smtp';
  readonly host: string;
  readonly port: number;
}

/** Every credential slot of a definition (one entry per node using it). */
export function credentialSlots(def: StoredDefinition): CredentialSlot[] {
  if (schemaVersionOf(def) !== 2) return [];
  const out: CredentialSlot[] = [];
  for (const n of (def as WorkflowDefinitionV2).nodes) {
    const c = (n as { config?: Record<string, unknown> }).config ?? {};
    try {
      if (n.type === 'http.request') {
        const id = (c.auth as { credential?: unknown } | undefined)?.credential;
        if (typeof id !== 'string') continue;
        const origin = new URL(String(c.origin));
        out.push({
          slot: id,
          nodeId: n.id,
          kind: 'http-auth',
          host: origin.hostname.replace(/^\[|\]$/g, ''),
          port: originPort(origin.origin),
        });
      } else if (n.type === 'email.send') {
        const id = (c.smtp as { credential?: unknown } | undefined)?.credential;
        if (typeof id !== 'string') continue;
        const server = smtpServer(c as unknown as EmailSendConfig);
        out.push({ slot: id, nodeId: n.id, kind: 'smtp', host: server.host, port: server.port });
      }
    } catch {
      // A node the catalog would refuse anyway (saved versions are valid).
    }
  }
  return out;
}

/** The distinct slot names of a definition, sorted. */
export function slotNames(def: StoredDefinition): string[] {
  return [...new Set(credentialSlots(def).map((s) => s.slot))].sort();
}

/**
 * Inputs `next` requires that `prev` did not and the attachment gives no default for — a new version with such an
 * input would break this project's runs and triggers, so it waits for the target admin.
 */
export function newRequiredInputs(
  prev: StoredDefinition,
  next: StoredDefinition,
  overrides: AttachmentOverrides,
): string[] {
  const before = asV2(prev).inputs;
  const defaults = overrides.inputs ?? {};
  return Object.entries(asV2(next).inputs)
    .filter(([name, spec]) => spec.required && before[name]?.required !== true)
    .filter(([name]) => (defaults[name] ?? '').trim() === '')
    .map(([name]) => name)
    .sort();
}

/** Input defaults filled in where a run gives none (only inputs the definition declares). */
export function withInputDefaults(
  def: StoredDefinition,
  inputs: Readonly<Record<string, string>>,
  overrides: AttachmentOverrides,
): Record<string, string> {
  const declared = asV2(def).inputs;
  const out: Record<string, string> = { ...inputs };
  for (const [name, value] of Object.entries(overrides.inputs ?? {})) {
    if (!(name in declared)) continue;
    if (out[name] === undefined || out[name].trim() === '') out[name] = value;
  }
  return out;
}

/** Hash of an overrides object for the audit (values never leave the attachment row). */
export function overridesHash(o: AttachmentOverrides): string {
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    const r = v as Record<string, unknown>;
    return `{${Object.keys(r)
      .sort()
      .filter((k) => r[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(r[k])}`)
      .join(',')}}`;
  };
  return createHash('sha256').update(stable(o)).digest('hex');
}
