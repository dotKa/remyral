import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { STEP_UP_ALWAYS_FRESH_MS } from '../auth/step-up.js';
import { stepUpFresh } from '../approvals/policy-store.js';
import { loadSubject } from '../authz/authorizer.js';
import { authorize, type Role, type Subject } from '../authz/model.js';
import type { Pool, Queryable } from '../db/pool.js';
import { rowContent } from '../blobs/registry.js';
import { clampLimit, decodeKeyset, keysetPage } from '../http/pagination.js';

/** Keyset scope of the ops-action list cursor (p9-pagination). */
const OPS_SCOPE = 'deploy.actions';
import type { CloudflareClient, DnsRecord, PagesDomain, PagesFile, PagesProject } from './cloudflare.js';
import { type CoolifyApplication, coolifyOutcome, ProviderCallError } from './coolify.js';
import { type CoolifyHandle, connectionIdOf } from './coolify-connections.js';
import type { OpsIntegrations } from './integrations.js';
import { OUTBOX_TOPIC_OPS_ACTION, type OpsActionOutboxPayload } from './outbox.js';
import { SiteBundle } from '@remyral/protocol';
import { recordAutoEvent } from '../self-heal/events.js';

/** p15-auto-mode: the decision reason of an action "Otomatik mod" approved (the security policy, no person). */
export const AUTO_MODE_REASON = 'Approved by auto mode (security policy).';
import {
  CoolifyDeployParams,
  CoolifyRestartParams,
  type DeployEnv,
  DeployTargets,
  DnsDeleteParams,
  DnsUpsertParams,
  type OpsActionRequest,
  type OpsActionView,
  OpsError,
  type OpsKind,
  PagesAddDomainParams,
  PagesCreateProjectParams,
  PagesNewProjectName,
  type OpsState,
  type OpsVia,
  PagesDeployParams,
  PagesPublishParams,
  type PolicyOutcome,
} from './model.js';
import {
  BUNDLE_APPROVAL_REASON,
  coolifyDenyReason,
  decide,
  nameInZone,
  type PreApproval,
  PRE_APPROVAL_REASON,
  preApprovalCovers,
  type ProtectionContext,
  protectedRecordReason,
  publishDecision,
  type PublishStep,
  type PublishStepFacts,
} from './policy.js';

/**
 * p6-deploy-integrations (ADR-0028): typed ops actions executed by the master with the master-held Coolify /
 * Cloudflare tokens. The caller (a person through the console or REST, the orchestrator chat through a confirmed
 * draft, phase 2: an automation or workflow step) only *requests*; the master
 *
 *   1. validates the parameters against the project's deploy targets,
 *   2. resolves the real target and computes the diff against the current state (provider reads),
 *   3. refuses control-plane resources and protected DNS records whatever the configuration says,
 *   4. decides by policy: run now (preview auto), wait for approval, approval with step-up, refused,
 *   5. executes (re-checking the plan after an approval: a changed target is not executed — "stale"),
 *   6. audits each step and stores the result with external ids and links, and what a rollback needs.
 */

export interface OpsActor {
  readonly type: 'user' | 'system';
  readonly id: string;
  /** Users: the session's TOTP time and accepted age (approval with step-up re-checks it). */
  readonly mfaAt?: Date | null;
  readonly stepUpMaxAgeMs?: number;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface OpsLimits {
  /** Actions per project in a sliding 10-minute window (refused ones included). */
  readonly perProjectPer10Min: number;
  /** How long an action waits for approval. */
  readonly approvalTtlMs: number;
  /** Largest Pages bundle accepted (bytes). */
  readonly maxPagesBytes: number;
}

export const DEFAULT_OPS_LIMITS: OpsLimits = {
  perProjectPer10Min: 20,
  approvalTtlMs: 24 * 60 * 60_000,
  // p10-site-upload: an uploaded site may be up to 50 MiB (each file ≤ 25 MiB, Cloudflare Pages' asset limit).
  maxPagesBytes: 50 * 1024 * 1024,
};

/**
 * p10-site-upload: where `pages.deploy` with `uploadId` reads an uploaded site (the site-uploads service). Only the
 * ops service reads the bytes; nothing serves them to the console.
 */
export interface SiteUploadSource {
  deployFiles(
    project: string,
    id: string,
  ): Promise<{
    files: PagesFile[];
    upload: {
      readonly id: string;
      readonly label: string | null;
      readonly fileCount: number;
      readonly totalBytes: number;
      readonly siteSha256: string;
      readonly uploadedBy: { readonly id: string; readonly username: string | null };
    };
  } | null>;
  markDeployed(id: string, actionId: string): Promise<void>;
}

export interface OpsServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly integrations: OpsIntegrations;
  readonly log: FastifyBaseLogger;
  /** Host of PUBLIC_ORIGIN (always protected). */
  readonly consoleHost: string | null;
  /** OPS_PROTECTED_HOSTS: further host names protected like the console host (default none). */
  readonly protectedHosts?: readonly string[];
  /** p17-domain-wizard: the console's live host names (a saved address is protected at once). */
  readonly liveConsoleHosts?: () => readonly string[];
  /** OPS_CONTROL_PLANE_COOLIFY_UUIDS. */
  readonly controlPlaneResources: readonly string[];
  /** OPS_CONTROL_PLANE_ADDRESSES (IPs / host names DNS records must not be pointed at or away from). */
  readonly controlPlaneAddresses: readonly string[];
  readonly limits?: Partial<OpsLimits>;
  /**
   * p15-auto-mode: the owner's "Otomatik mod" is on — a deploy (production too) or other action that needs an
   * approval runs at once, approved via the security policy (absent: always ask). DNS deletes keep asking (floor).
   */
  readonly autoMode?: () => Promise<boolean>;
  /**
   * p8-preview-tunnels (ADR-0032): kinds planned and executed by another module (`tunnel.*` by the previews
   * service). The request, policy, approval, idempotency, audit and listing stay here.
   */
  readonly handlers?: () => readonly OpsKindHandler[];
  /** p10-site-upload: uploaded sites (`pages.deploy` with `uploadId`). */
  readonly siteUploads?: () => SiteUploadSource | null;
  /**
   * p15-chat-zip: posts the outcome of a publish requested from a chat conversation (`source.chatThreadId`) into that
   * conversation — the live link, or why it failed (absent: nothing is posted).
   */
  readonly chatNote?: (threadId: string, text: string, meta: Record<string, unknown>) => Promise<void>;
}

/** A plan computed by a kind handler; `decision` (when set) replaces the deploy-policy matrix of `decide()`. */
export interface OpsPlan extends Plan {
  readonly decision?: { readonly decision: PolicyOutcome; readonly reason: string };
}

/** What an ops action looks like to a kind handler when it runs. */
export interface OpsHandlerAction {
  readonly id: string;
  readonly project: string;
  readonly kind: OpsKind;
  readonly params: Record<string, unknown>;
  readonly target: Record<string, unknown>;
  readonly diff: Record<string, unknown>;
  readonly via: OpsVia;
  readonly source: Record<string, unknown> | null;
  readonly requestedBy: { readonly type: 'user' | 'system'; readonly id: string };
}

/** p8-preview-tunnels: plans and runs ops action kinds that live outside the deploy module. */
export interface OpsKindHandler {
  readonly kinds: readonly OpsKind[];
  /** Validates the parameters (OpsError 400 on invalid ones); returns the clean parameters. */
  parse(kind: OpsKind, params: Record<string, unknown>): Record<string, unknown>;
  /** The kind may run although the project has no deploy targets (e.g. closing a tunnel). */
  allowWithoutTargets?(kind: OpsKind): boolean;
  plan(
    project: string,
    kind: OpsKind,
    params: Record<string, unknown>,
    targets: DeployTargets,
  ): Promise<OpsPlan>;
  run(
    action: OpsHandlerAction,
    plan: OpsPlan,
    actor: OpsActor,
  ): Promise<{ state: 'succeeded' | 'failed'; result: Record<string, unknown>; error?: string }>;
}

export interface Plan {
  readonly env: DeployEnv | null;
  readonly target: Record<string, unknown>;
  readonly diff: Record<string, unknown>;
  readonly previous: Record<string, unknown> | null;
  /** Policy refusal (protected record / control-plane resource), or null. */
  readonly refusal: string | null;
  /** Hash of the safety-relevant facts; re-computed before an approved action runs. */
  readonly key: string;
  /** Non-persisted execution inputs (Pages files). */
  readonly files?: readonly PagesFile[];
  /** p6-pages-create: `pages.add_domain` also writes DNS (the policy then needs the DNS level too). */
  readonly withDns?: boolean;
  /**
   * p10-publish-bundle: a `dns.upsert` creating/updating a CNAME to one of the project's own Pages projects'
   * `pages.dev` names (the only DNS change "Run at once" covers).
   */
  readonly ownPagesCname?: boolean;
}

/** p10-publish-bundle: the progress of one step of a publish bundle (`result.steps[i]`). */
interface PublishStepState {
  step: PublishStep;
  state: 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';
  actionId?: string;
  error?: string;
  note?: string;
}

interface Row {
  id: string;
  project: string;
  kind: OpsKind;
  env: DeployEnv | null;
  params: Record<string, unknown>;
  params_hash: string;
  target: Record<string, unknown>;
  diff: Record<string, unknown>;
  previous: Record<string, unknown> | null;
  policy_decision: PolicyOutcome;
  policy_reason: string;
  state: OpsState;
  requested_by_type: 'user' | 'system';
  requested_by_id: string;
  requester: string | null;
  via: OpsVia;
  source: Record<string, unknown> | null;
  note: string | null;
  rollback_of: string | null;
  decided_by: string | null;
  decider: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  step_up_at: Date | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  finished_at: Date | null;
}

const COLS = `a.id::text AS id, a.project, a.kind, a.env, a.params, a.params_hash, a.target, a.diff, a.previous,
  a.policy_decision, a.policy_reason, a.state, a.requested_by_type, a.requested_by_id,
  (SELECT username FROM users u WHERE a.requested_by_type = 'user' AND u.id::text = a.requested_by_id) AS requester,
  a.via, a.note, a.rollback_of::text AS rollback_of, a.decided_by::text AS decided_by,
  (SELECT username FROM users u WHERE u.id = a.decided_by) AS decider, a.decided_at, a.decision_reason, a.step_up_at,
  a.result,
  a.error, a.created_at, a.updated_at, a.expires_at, a.finished_at, a.source`;

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/** A string field of a stored JSON object, else ''. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const MEDIA_BY_EXT: Readonly<Record<string, string>> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  xml: 'application/xml',
  pdf: 'application/pdf',
};

/**
 * p10-site-upload: the stored form of deploy targets — `pagesProjects` only when it lists something, so a master
 * rolled back to before p10-site-upload (strict schema) still reads every project that does not use the feature.
 */
function storable(t: DeployTargets): Record<string, unknown> {
  if (t.pagesProjects.length > 0) return t;
  const { pagesProjects: _omit, ...rest } = t;
  return rest;
}

/**
 * p10-publish-bundle: the console's text for a provider failure — the provider's name, its message and, when a zone's
 * DNS records were refused, the token permission that is missing. Never a token: provider messages are truncated
 * (300 chars) at the client and contain no request headers.
 */
export function providerText(err: ProviderCallError, dnsZone?: string): string {
  const who = err.provider === 'cloudflare' ? 'Cloudflare' : 'Coolify';
  const base = err.message.startsWith(who) ? err.message : `${who}: ${err.message}`;
  const auth = err.code === 'unauthorized' || err.code === 'forbidden';
  return dnsZone !== undefined && dnsZone !== '' && auth && err.provider === 'cloudflare'
    ? `${base} — the token needs Zone → DNS → Edit for ${dnsZone}`
    : base;
}

/** p6-pages-create: how long a domain may stay pending (validation / DNS) before the action is marked failed. */
export const PAGES_DOMAIN_PENDING_MS = 24 * 60 * 60_000;

/**
 * p22-ops-hygiene: a deploying action (any kind but `pages.add_domain`, which has its own 24 h limit) that has not
 * reached an outcome this long after it started (approval / creation) fails as timed out. A Coolify build or a Pages
 * deployment takes minutes; one action polled for days (its deployment gone) was 13 000 warnings a week.
 */
export const DEPLOYING_MAX_MS = 2 * 60 * 60_000;
/** p22-ops-hygiene: consecutive "not found" answers for the action's deployment before it fails (the provider forgot it). */
export const POLL_NOT_FOUND_LIMIT = 3;
/** p22-ops-hygiene: poll backoff after transient provider errors: 15 s · 2^(errors−1), at most 5 min. */
export const POLL_BACKOFF_MAX_MS = 5 * 60_000;

/** p22-ops-hygiene: when the poller asks again after `errors` consecutive transient failures (≥ 1). */
export function pollBackoffMs(errors: number, baseMs = 15_000): number {
  const n = Math.max(1, Math.min(errors, 16));
  return Math.min(POLL_BACKOFF_MAX_MS, baseMs * 2 ** (n - 1));
}

/** p22-ops-hygiene: a provider (or connection) "not found" — the thing polled does not exist (any more). */
export function isNotFound(err: unknown): err is OpsError {
  return err instanceof OpsError && /_not_found$/.test(err.code);
}

/** p6-pages-create: a Pages domain's state as stored on the action (status read-back). */
function domainView(d: PagesDomain): Record<string, unknown> {
  return {
    status: d.status,
    validation: d.validation,
    verification: d.verification,
    links: [`https://${d.name}`],
  };
}

/** Cloudflare domain status → action outcome. */
function domainOutcome(status: string): 'active' | 'failed' | 'pending' {
  if (status === 'active') return 'active';
  if (status === 'error' || status === 'blocked' || status === 'deactivated') return 'failed';
  return 'pending';
}

/** p12-deploy-feedback: one block of log text (a deployment, an application, a check). */
export interface DeployLogSource {
  readonly id: string;
  readonly label: string;
  readonly status: string | null;
  readonly text: string;
  /** The beginning was cut (only the tail is kept). */
  readonly truncated: boolean;
}

/** Characters kept per log source (the tail). */
export const LOG_CAP_CHARS = 64_000;

/** Coolify's deployment `logs` is a JSON array of `{output, hidden}` (older builds: plain text). */
export function coolifyLogText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((l) => typeof l === 'object' && l !== null && (l as { hidden?: unknown }).hidden !== true)
        .map((l) => {
          const o = (l as { output?: unknown }).output;
          return typeof o === 'string' ? o : '';
        })
        .join('\n');
    }
  } catch {
    // plain text
  }
  return raw;
}

/** Lines whose leading RFC 3339 timestamp is at or after `since` (continuation lines follow their line). */
export function sinceFilter(raw: string, since: Date | null): string {
  if (since === null) return raw;
  const out: string[] = [];
  let keep = false;
  for (const line of raw.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s/.exec(line);
    if (m !== null) {
      const t = Date.parse(m[1] ?? '');
      keep = Number.isFinite(t) ? t >= since.getTime() : keep;
    }
    if (keep) out.push(line);
  }
  return out.join('\n');
}

export class OpsService {
  readonly #limits: OpsLimits;
  readonly #baseConsoleHosts: readonly string[];
  readonly #redactor = new Redactor({ rules: DEFAULT_RULES });

  constructor(private readonly deps: OpsServiceDeps) {
    this.#limits = { ...DEFAULT_OPS_LIMITS, ...deps.limits };
    this.#baseConsoleHosts = [
      ...(deps.protectedHosts ?? []),
      ...(deps.consoleHost === null ? [] : [deps.consoleHost]),
    ];
  }

  get #consoleHosts(): ReadonlySet<string> {
    return new Set(
      [...this.#baseConsoleHosts, ...(this.deps.liveConsoleHosts?.() ?? [])].map((h) => h.toLowerCase()),
    );
  }

  get protectedHosts(): readonly string[] {
    return [...this.#consoleHosts];
  }

  // ------------------------------------------------------------------------------------------ targets

  async targets(
    project: string,
  ): Promise<{ targets: DeployTargets; version: number; updatedAt: string } | null> {
    const { rows } = await this.deps.pool.query<{ config: unknown; version: number; updated_at: Date }>(
      'SELECT config, version, updated_at FROM project_deploy_targets WHERE project = $1',
      [project],
    );
    const r = rows[0];
    if (r === undefined) return null;
    const parsed = DeployTargets.safeParse(r.config);
    if (!parsed.success) return null;
    return { targets: parsed.data, version: r.version, updatedAt: r.updated_at.toISOString() };
  }

  async putTargets(
    actor: OpsActor,
    project: string,
    input: unknown,
    expectedVersion: number | null,
  ): Promise<{ targets: DeployTargets; version: number; updatedAt: string }> {
    const parsed = DeployTargets.safeParse(input);
    if (!parsed.success) {
      throw new OpsError(
        400,
        'invalid_targets',
        `Invalid deploy targets: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`.slice(0, 500),
      );
    }
    let t = parsed.data;
    const { rowCount } = await this.deps.pool.query('SELECT 1 FROM projects WHERE id = $1', [project]);
    if ((rowCount ?? 0) === 0) throw new OpsError(404, 'project_not_found', 'Project not found.');
    // p13-multi-coolify: each Coolify environment names a connection the project may use (none named: the default,
    // stored resolved). Configured resources must not be on that connection's control-plane deny-list (the deploy
    // re-checks with fqdn).
    const conns = this.deps.integrations.coolifyConnections;
    for (const env of ['preview', 'production'] as const) {
      const et = t.coolify?.[env] ?? null;
      if (et === null) continue;
      const id = et.connection ?? (await conns.defaultId());
      if (id === null) {
        if (et.uuids.length > 0 || et.tags.length > 0) {
          throw new OpsError(
            409,
            'coolify_not_configured',
            'Connect Coolify first (Settings → Integrations).',
          );
        }
        continue;
      }
      const h = await conns.forAction(project, id).catch((err: unknown) => {
        // A connection whose token no longer decrypts can still be chosen; the deny-list needs only its settings.
        if (err instanceof OpsError && err.code === 'coolify_not_configured' && et.connection !== null)
          return null;
        throw err;
      });
      const deny = conns.denyUuids(h?.settings ?? null);
      const bad = et.uuids.find((u) => deny.has(u));
      if (bad !== undefined) {
        throw new OpsError(
          400,
          'control_plane_resource',
          `Coolify resource ${bad} is part of the control plane.`,
        );
      }
      if (et.connection !== id && t.coolify !== null) {
        t = { ...t, coolify: { ...t.coolify, [env]: { ...et, connection: id } } };
      }
    }
    // Zones must be zones the stored Cloudflare token can see (id ↔ name checked against Cloudflare) — the DNS zones
    // and (p8-preview-tunnels) the preview zone.
    const zonesToCheck = [...t.dns.zones, ...(t.previews?.zone == null ? [] : [t.previews.zone])];
    if (zonesToCheck.length > 0) {
      const cf = await this.deps.integrations.cloudflare();
      if (cf === null) throw new OpsError(409, 'cloudflare_not_configured', 'Connect Cloudflare first.');
      const visible = await this.#provider(() => cf.client.zones());
      for (const z of zonesToCheck) {
        if (!visible.some((v) => v.id === z.id && v.name === z.name)) {
          throw new OpsError(400, 'zone_not_permitted', `The Cloudflare token cannot see zone ${z.name}.`);
        }
      }
    }
    const now = this.deps.clock();
    const res = await this.deps.pool.query<{ version: number }>(
      `INSERT INTO project_deploy_targets (project, config, version, updated_by, updated_at)
       VALUES ($1, $2, 1, $3, $4)
       ON CONFLICT (project) DO UPDATE SET config = EXCLUDED.config, version = project_deploy_targets.version + 1,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
       WHERE $5::int IS NULL OR project_deploy_targets.version = $5
       RETURNING version`,
      [project, storable(t), actor.type === 'user' ? actor.id : null, now, expectedVersion],
    );
    if (res.rows[0] === undefined) {
      throw new OpsError(409, 'stale_targets', 'The deploy targets changed meanwhile; reload and try again.');
    }
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'ops.targets.write',
      target: `project:${project}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { version: res.rows[0].version, targets: t },
    });
    return { targets: t, version: res.rows[0].version, updatedAt: now.toISOString() };
  }

  /** p13-multi-coolify: the environment's control-plane uuids (every connection) + the connection's own deny-list. */
  /** p13-multi-coolify: Coolify connection labels by id and the default id (status texts; no URLs, no tokens). */
  async coolifyLabels(): Promise<{ byId: Map<string, string>; defaultId: string | null }> {
    const c = this.deps.integrations.coolifyConnections;
    return { byId: await c.labels(), defaultId: await c.defaultId() };
  }

  #denyUuids(c: CoolifyHandle): Set<string> {
    return new Set([...this.deps.controlPlaneResources, ...c.settings.denyResources]);
  }

  /** p13-multi-coolify: the connection an action of `project` uses (null: the default), authorized for it. */
  async #coolifyFor(project: string, connection: string | null): Promise<CoolifyHandle> {
    return this.deps.integrations.coolifyConnections.forAction(project, connection);
  }

  /** The connection a recorded Coolify action ran on (rows from before p13 without one: the default). */
  async #coolifyOfRow(row: { readonly target: Record<string, unknown> }): Promise<CoolifyHandle> {
    const id = connectionIdOf(row.target);
    const h = await this.deps.integrations.coolifyConnections.handle(id);
    if (h === null) {
      throw new OpsError(
        409,
        id === null ? 'coolify_not_configured' : 'coolify_connection_removed',
        id === null
          ? 'Coolify is not connected (Settings → Integrations).'
          : 'The Coolify connection this action ran on was removed or cannot be used.',
      );
    }
    return h;
  }

  // --------------------------------------------------------------------------------------- requesting

  /**
   * What a request would do — target, diff, policy outcome — without storing anything (chat drafts, the console's
   * "Review" step). Throws OpsError for invalid requests and unreachable providers.
   */
  async preview(
    project: string,
    kind: OpsActionRequest['kind'],
    params: Record<string, unknown>,
  ): Promise<{
    kind: OpsKind;
    env: DeployEnv | null;
    params: Record<string, unknown>;
    target: Record<string, unknown>;
    diff: Record<string, unknown>;
    policy: { decision: PolicyOutcome; reason: string };
  }> {
    const { targets, clean } = await this.#prepare(project, kind, params);
    const plan = await this.#plan(project, kind, clean, targets);
    const policy =
      plan.refusal !== null
        ? { decision: 'refused' as const, reason: plan.refusal }
        : (plan.decision ??
          decide(
            kind,
            plan.env,
            targets.policy,
            { refusal: plan.refusal },
            { withDns: plan.withDns === true, ownPagesCname: plan.ownPagesCname === true },
          ));
    return { kind, env: plan.env, params: clean, target: plan.target, diff: plan.diff, policy };
  }

  /**
   * p6-deploy-pipeline: whether `project` can take this action at all (parameters valid, deploy target configured)
   * — no provider call. null = fine, else the reason. Used when an automation or workflow step is saved.
   */
  async check(project: string, kind: OpsKind, params: Record<string, unknown>): Promise<string | null> {
    try {
      const { targets, clean } = await this.#prepare(project, kind, params);
      if (kind === 'coolify.deploy' || kind === 'coolify.restart') {
        const env = clean.env as DeployEnv;
        const t = targets.coolify?.[env] ?? null;
        if (t === null || (t.uuids.length === 0 && t.tags.length === 0)) {
          return `No Coolify ${env} target is configured for this project (Project → Deploy).`;
        }
        // p13-multi-coolify: the connection must exist and be allowed for the project (no provider call).
        const conns = this.deps.integrations.coolifyConnections;
        const id = t.connection ?? (await conns.defaultId());
        if (id === null) return 'Coolify is not connected (Settings → Integrations).';
        if (!(await conns.mayUse(id, project))) {
          return 'This project may not use the Coolify connection of its target (Settings → Integrations → Coolify).';
        }
      }
      if (kind === 'pages.deploy' || kind === 'pages.add_domain') {
        this.#pagesName(targets, clean.pagesProject);
      }
      return null;
    } catch (err) {
      if (err instanceof OpsError) return err.message;
      throw err;
    }
  }

  /** p6-deploy-on-success: the production branch of the project's Cloudflare Pages project (one provider read). */
  async pagesProductionBranch(project: string): Promise<string> {
    const t = await this.targets(project);
    if (t?.targets.pages == null)
      throw new OpsError(409, 'no_pages_target', 'No Cloudflare Pages project is configured.');
    const name = t.targets.pages.projectName;
    const cf = await this.#cloudflare();
    return (await this.#provider(() => cf.pagesProject(name))).productionBranch;
  }

  #handler(kind: OpsKind): OpsKindHandler | null {
    return this.deps.handlers?.().find((h) => h.kinds.includes(kind)) ?? null;
  }

  async #prepare(
    project: string,
    kind: OpsKind,
    params: Record<string, unknown>,
  ): Promise<{ targets: DeployTargets; clean: Record<string, unknown> }> {
    const handler = this.#handler(kind);
    if (handler !== null) {
      const clean = handler.parse(kind, params);
      const t = await this.targets(project);
      if (t === null && handler.allowWithoutTargets?.(kind) === true) {
        return { targets: DeployTargets.parse({}), clean };
      }
      if (t === null)
        throw new OpsError(
          409,
          'no_deploy_targets',
          'This project has no deploy targets yet (Project → Deploy).',
        );
      return { targets: t.targets, clean };
    }
    const schema = (
      {
        'coolify.deploy': CoolifyDeployParams,
        'coolify.restart': CoolifyRestartParams,
        'pages.deploy': PagesDeployParams,
        'dns.upsert': DnsUpsertParams,
        'dns.delete': DnsDeleteParams,
        'pages.create_project': PagesCreateProjectParams,
        'pages.add_domain': PagesAddDomainParams,
        'pages.publish': PagesPublishParams,
      } as const
    )[kind as 'coolify.deploy'] as typeof CoolifyDeployParams | undefined;
    let clean: Record<string, unknown> = params;
    if (schema !== undefined) {
      const p = schema.safeParse(params);
      if (!p.success) {
        throw new OpsError(
          400,
          'invalid_params',
          `Invalid parameters for ${kind}: ${p.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
            .join('; ')}`.slice(0, 500),
        );
      }
      clean = p.data;
    }
    const t = await this.targets(project);
    // p6-pages-create: a project without deploy targets yet may create its first Pages project.
    if (t === null && kind === 'pages.create_project') return { targets: DeployTargets.parse({}), clean };
    if (t === null)
      throw new OpsError(
        409,
        'no_deploy_targets',
        'This project has no deploy targets yet (Project → Deploy).',
      );
    return { targets: t.targets, clean };
  }

  async request(
    actor: OpsActor,
    input: Omit<OpsActionRequest, 'kind'> & { readonly kind: OpsKind },
    via: OpsVia,
    opts: {
      /** p6-deploy-pipeline: the automation run / workflow node that asked. */
      readonly source?: Record<string, unknown>;
      readonly rollbackOf?: string;
      readonly kindOverride?: OpsKind;
      readonly rollbackOfDelete?: boolean;
      /**
       * p6-deploy-on-success (ADR-0030): the requester approved this action in advance (at job creation). A policy
       * decision at or below `covers` is stored as decided by `by` and executed at once; a stricter decision waits
       * for an approval as usual; a refusal stays a refusal.
       */
      readonly preApproved?: PreApproval;
      /** p6-deploy-on-success: refuse (nothing stored) when the plan's environment is not this one. */
      readonly expectEnv?: DeployEnv;
      /**
       * p6-pages-create: the requester may change this project's deploy targets right now (`deploy.targets.write`
       * and a current step-up, checked by the caller). Required for `pages.create_project` with `useAsTarget` or
       * `ifExists: adopt` (p10-site-upload).
       */
      readonly mayWriteTargets?: boolean;
      /** p8-preview-tunnels: system clean-ups (closing an expired tunnel) are never rate limited. */
      readonly skipRateLimit?: boolean;
      /**
       * p10-publish-bundle: a bundle step — refuse (409 `stale`, nothing stored) when the fresh plan no longer
       * matches what the bundle's approval saw. Returns the reason, or null when it matches.
       */
      readonly precondition?: (plan: OpsPlan) => string | null;
      /** p10-publish-bundle: the decision reason stored with a pre-approval (default: deploy on success). */
      readonly preApprovedReason?: string;
    } = {},
  ): Promise<{ action: OpsActionView; created: boolean }> {
    const kind = opts.kindOverride ?? input.kind;
    const { targets, clean } = await this.#prepare(input.project, kind, input.params);
    if (
      kind === 'pages.create_project' &&
      (clean.useAsTarget === true || clean.ifExists === 'adopt') &&
      opts.mayWriteTargets !== true
    ) {
      await this.deps.audit.record({
        actor: { type: actor.type, id: actor.id },
        action: 'ops.action.request',
        target: `project:${input.project}`,
        outcome: 'denied',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: { kind, via, reason: 'targets_write_forbidden' },
      });
      throw new OpsError(
        403,
        'targets_write_forbidden',
        'Using an existing Pages project, or making one this project’s deploy target, needs the right to change deploy targets (project admin) and a current authenticator code.',
      );
    }
    const paramsHash = sha(
      stableJson({ project: input.project, kind, params: clean, rollbackOf: opts.rollbackOf ?? null }),
    );
    // Idempotency: the same key with the same request returns the first record.
    const existing = await this.deps.pool.query<{ id: string; params_hash: string }>(
      `SELECT id::text AS id, params_hash FROM ops_actions
        WHERE requested_by_type = $1 AND requested_by_id = $2 AND idempotency_key = $3`,
      [actor.type, actor.id, input.idempotencyKey],
    );
    const prior = existing.rows[0];
    if (prior !== undefined) {
      if (prior.params_hash !== paramsHash) {
        throw new OpsError(
          409,
          'idempotency_conflict',
          'This idempotency key was used for a different request.',
        );
      }
      return { action: await this.get(prior.id), created: false };
    }
    if (opts.skipRateLimit !== true) await this.#rateLimit(input.project);
    let plan: OpsPlan;
    try {
      plan = await this.#plan(input.project, kind, clean, targets);
      if (opts.expectEnv !== undefined && plan.env !== opts.expectEnv) {
        throw new OpsError(
          409,
          'env_mismatch',
          `This deploy would go to ${String(plan.env)}, not ${opts.expectEnv} as approved; nothing was deployed.`,
        );
      }
      const changed = opts.precondition?.(plan) ?? null;
      if (changed !== null) {
        throw new OpsError(
          409,
          'stale',
          `The target changed since the approval (${changed}); nothing was executed for this step.`,
        );
      }
    } catch (err) {
      await this.deps.audit.record({
        actor: { type: actor.type, id: actor.id },
        action: 'ops.action.request',
        target: `project:${input.project}`,
        outcome: 'failure',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: { kind, via, error: err instanceof Error ? err.message.slice(0, 300) : 'error' },
      });
      throw err;
    }
    const policy =
      plan.refusal !== null
        ? { decision: 'refused' as const, reason: plan.refusal }
        : (plan.decision ??
          decide(
            kind,
            plan.env,
            targets.policy,
            { refusal: plan.refusal },
            {
              ...(opts.rollbackOfDelete === undefined ? {} : { rollbackOfDelete: opts.rollbackOfDelete }),
              withDns: plan.withDns === true,
              ownPagesCname: plan.ownPagesCname === true,
            },
          ));
    const now = this.deps.clock();
    const pre = opts.preApproved;
    // p6-deploy-on-success: an approval given in advance covers this decision (never a refusal).
    const approvedAhead: PreApproval | null =
      pre !== undefined && preApprovalCovers(policy.decision, pre) ? pre : null;
    const preCovers = approvedAhead !== null;
    // p15-auto-mode: an approval the policy would ask a person for is granted by "Otomatik mod" (never a refusal, a
    // DNS delete or the restore of a deleted record).
    const autoGranted =
      !preCovers &&
      (policy.decision === 'approval' || policy.decision === 'approval_step_up') &&
      kind !== 'dns.delete' &&
      opts.rollbackOfDelete === undefined &&
      (await this.deps.autoMode?.().catch(() => false)) === true;
    const state: OpsState =
      policy.decision === 'refused'
        ? 'refused'
        : policy.decision === 'auto' || preCovers || autoGranted
          ? 'executing'
          : 'awaiting_approval';
    let id: string;
    try {
      const ins = await this.deps.pool.query<{ id: string }>(
        `INSERT INTO ops_actions (project, kind, env, params, params_hash, target, diff, previous, policy_decision,
           policy_reason, state, requested_by_type, requested_by_id, via, note, idempotency_key, rollback_of,
           created_at, updated_at, expires_at, finished_at, source, decided_by, decided_at, decision_reason,
           step_up_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18, $19, $20, $21,
                 $22, $23, $24, $25)
         RETURNING id::text AS id`,
        [
          input.project,
          kind,
          plan.env,
          clean,
          paramsHash,
          { ...plan.target, planKey: plan.key },
          plan.diff,
          plan.previous,
          policy.decision,
          policy.reason.slice(0, 500),
          state,
          actor.type,
          actor.id,
          via,
          input.note ?? null,
          input.idempotencyKey,
          opts.rollbackOf ?? null,
          now,
          state === 'awaiting_approval' ? new Date(now.getTime() + this.#limits.approvalTtlMs) : null,
          state === 'refused' ? now : null,
          opts.source ?? null,
          approvedAhead?.by ?? null,
          approvedAhead?.at ?? null,
          approvedAhead === null
            ? autoGranted
              ? AUTO_MODE_REASON
              : null
            : (opts.preApprovedReason ?? PRE_APPROVAL_REASON),
          approvedAhead !== null && policy.decision === 'approval_step_up' ? approvedAhead.stepUpAt : null,
        ],
      );
      id = ins.rows[0]?.id ?? '';
    } catch (err) {
      // A concurrent request with the same key won the insert.
      if ((err as { code?: string }).code === '23505') {
        return this.request(actor, input, via, opts);
      }
      throw err;
    }
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'ops.action.request',
      target: `ops-action:${id}`,
      outcome: state === 'refused' ? 'denied' : 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        project: input.project,
        kind,
        env: plan.env,
        via,
        decision: policy.decision,
        reason: policy.reason,
        rollbackOf: opts.rollbackOf ?? null,
        source: opts.source ?? null,
        diff: plan.diff,
        ...(pre === undefined ? {} : { preApproved: preCovers }),
      },
    });
    if (approvedAhead !== null) {
      // The approval itself happened at job creation (audited there as ops.preapproval.create); recorded here too.
      await this.deps.audit.record({
        actor: { type: 'user', id: approvedAhead.by },
        action: 'ops.action.approve',
        target: `ops-action:${id}`,
        outcome: 'success',
        metadata: {
          project: input.project,
          kind,
          env: plan.env,
          stepUp: policy.decision === 'approval_step_up',
          preApproved: true,
          approvedAt: approvedAhead.at.toISOString(),
          reason: opts.preApprovedReason ?? PRE_APPROVAL_REASON,
          ...(opts.source?.publishBundle === undefined ? {} : { publishBundle: opts.source.publishBundle }),
        },
      });
    }
    if (autoGranted) {
      await this.deps.audit.record({
        actor: { type: 'system', id: 'security-policy' },
        action: 'ops.action.approve',
        target: `ops-action:${id}`,
        outcome: 'success',
        metadata: {
          project: input.project,
          kind,
          env: plan.env,
          approvedVia: 'security_policy',
          autoMode: true,
          decision: policy.decision,
        },
      });
      const sourceJob = typeof opts.source?.jobId === 'string' ? opts.source.jobId : null;
      if (sourceJob !== null && /^[0-9a-f-]{36}$/.test(sourceJob)) {
        await recordAutoEvent(this.deps.pool, {
          jobId: sourceJob,
          kind: 'auto_approved',
          detail: {
            action: 'deploy',
            requestedAction: kind,
            env: plan.env,
            autoMode: true,
            approvedVia: 'security_policy',
          },
          at: now,
        }).catch(() => undefined);
      }
    }
    // p6-deploy-pipeline: who can decide is told (Needs you / notification); unattended refusals are reported.
    if (state === 'awaiting_approval') await this.#outbox(id, 'waiting');
    if (state === 'refused' && via !== 'api' && via !== 'chat') await this.#outbox(id, 'failed');
    if (state === 'executing') await this.#execute(id, plan, actor);
    return { action: await this.get(id), created: true };
  }

  async #rateLimit(project: string): Promise<void> {
    const since = new Date(this.deps.clock().getTime() - 10 * 60_000);
    const { rows } = await this.deps.pool.query<{ n: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(created_at) AS oldest FROM ops_actions WHERE project = $1 AND created_at > $2`,
      [project, since],
    );
    const n = rows[0]?.n ?? 0;
    if (n >= this.#limits.perProjectPer10Min) {
      const oldest = rows[0]?.oldest?.getTime() ?? this.deps.clock().getTime();
      const retry = Math.max(1, Math.ceil((oldest + 10 * 60_000 - this.deps.clock().getTime()) / 1000));
      throw new OpsError(429, 'ops_rate_limited', 'Too many ops actions for this project; try again later.', {
        'retry-after': String(retry),
      });
    }
  }

  /**
   * Runs a provider call; a provider failure becomes an OpsError the console can show. p10-publish-bundle: 424
   * Failed Dependency (not 502 — Cloudflare's proxy in front of the console replaces 5xx bodies with its own page),
   * the message names the provider and, for a zone's DNS records, the token permission that is missing.
   */
  async #provider<T>(fn: () => Promise<T>, ctx: { readonly dnsZone?: string } = {}): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderCallError) {
        // Kept in the log too (identifiers and the provider's message only).
        this.deps.log.warn(
          { provider: err.provider, status: err.status, code: err.code, message: err.message },
          'ops provider call failed',
        );
        throw new OpsError(
          err.code === 'rate_limited' ? 429 : 424,
          `${err.provider}_${err.code}`,
          providerText(err, ctx.dnsZone),
          err.retryAfterSec === null ? {} : { 'retry-after': String(err.retryAfterSec) },
        );
      }
      throw err;
    }
  }

  async #cloudflare(): Promise<CloudflareClient> {
    const c = await this.deps.integrations.cloudflare();
    if (c === null) {
      throw new OpsError(
        409,
        'cloudflare_not_configured',
        'Cloudflare is not connected (Settings → Integrations).',
      );
    }
    return c.client;
  }

  // ------------------------------------------------------------------------------------------ planning

  async #plan(
    project: string,
    kind: OpsKind,
    p: Record<string, unknown>,
    t: DeployTargets,
  ): Promise<OpsPlan> {
    const handler = this.#handler(kind);
    if (handler !== null) return handler.plan(project, kind, p, t);
    switch (kind) {
      case 'coolify.deploy':
      case 'coolify.restart':
        return this.#planCoolify(project, kind, p, t);
      case 'coolify.rollback':
        return this.#planCoolifyRollback(project, p);
      case 'pages.deploy':
        return this.#planPages(project, p, t);
      case 'pages.rollback':
        return this.#planPagesRollback(p, t);
      case 'dns.upsert':
      case 'dns.delete':
        return this.#planDns(kind, p, t);
      case 'pages.create_project':
        return this.#planPagesCreate(p, t);
      case 'pages.add_domain':
        return this.#planPagesDomain(p, t);
      case 'pages.publish':
        return this.#planPublish(project, p, t);
      default:
        throw new OpsError(400, 'unknown_kind', `No planner for ${kind}.`);
    }
  }

  /** Resolves uuids and tags to applications (deploying by uuid only) and applies the control-plane deny-list. */
  async #resolveApps(
    conn: CoolifyHandle,
    uuids: readonly string[],
    tags: readonly string[],
  ): Promise<{ apps: CoolifyApplication[]; refusal: string | null }> {
    const client = conn.client;
    const apps = new Map<string, CoolifyApplication>();
    for (const u of uuids) {
      const a = await this.#provider(() => client.application(u)).catch((err: unknown) => {
        if (
          err instanceof OpsError &&
          (err.code === 'coolify_not_found' || err.code === 'coolify_forbidden')
        ) {
          throw new OpsError(
            409,
            'target_unverifiable',
            `Coolify resource ${u} cannot be read with the token of the Coolify connection “${conn.label}” (it must be a readable application, so the control-plane check can run).`,
          );
        }
        throw err;
      });
      apps.set(a.uuid, a);
    }
    for (const tag of tags) {
      const list = await this.#provider(() => client.applications(tag));
      if (list.length === 0)
        throw new OpsError(409, 'tag_empty', `Coolify tag ${tag} matches no application on “${conn.label}”.`);
      for (const a of list) apps.set(a.uuid, a);
    }
    const deny = this.#denyUuids(conn);
    for (const a of apps.values()) {
      const r = coolifyDenyReason(a, { denyUuids: deny, consoleHosts: this.#consoleHosts });
      if (r !== null) return { apps: [...apps.values()], refusal: r };
    }
    return { apps: [...apps.values()].sort((x, y) => x.uuid.localeCompare(y.uuid)), refusal: null };
  }

  async #planCoolify(
    project: string,
    kind: 'coolify.deploy' | 'coolify.restart',
    p: Record<string, unknown>,
    t: DeployTargets,
  ): Promise<Plan> {
    const env = p.env as DeployEnv;
    const target = t.coolify?.[env] ?? null;
    if (target === null || (target.uuids.length === 0 && target.tags.length === 0)) {
      throw new OpsError(
        409,
        'no_coolify_target',
        `No Coolify ${env} target is configured for this project.`,
      );
    }
    const conn = await this.#coolifyFor(project, target.connection);
    const resolved = await this.#resolveApps(conn, target.uuids, target.tags);
    const refusal = resolved.refusal;
    let apps = resolved.apps;
    // p15-coolify-create: `only` narrows the deploy to resources of the target (never adds one).
    const only = Array.isArray(p.only) ? (p.only as string[]) : null;
    if (only !== null && kind === 'coolify.deploy') {
      const missing = only.find((u) => !apps.some((a) => a.uuid === u));
      if (missing !== undefined) {
        throw new OpsError(
          409,
          'not_in_target',
          `Coolify resource ${missing} is not part of this project's ${env} target.`,
        );
      }
      apps = apps.filter((a) => only.includes(a.uuid));
    }
    const resources = apps.map((a) => ({ uuid: a.uuid, name: a.name, fqdn: a.fqdn }));
    return {
      env,
      refusal,
      target: {
        provider: 'coolify',
        env,
        connection: { id: conn.id, label: conn.label },
        resources,
        configured: { uuids: target.uuids, tags: target.tags },
      },
      diff: {
        action: kind === 'coolify.deploy' ? 'deploy' : 'restart',
        env,
        connection: conn.label,
        ...(kind === 'coolify.deploy' ? { force: p.force === true, ref: p.ref ?? null } : {}),
        resources: apps.map((a) => ({
          uuid: a.uuid,
          name: a.name,
          fqdn: a.fqdn,
          status: a.status,
          branch: a.gitBranch,
          currentCommit: a.gitCommitSha,
        })),
      },
      previous: null,
      key: sha(stableJson(resources)),
    };
  }

  async #planCoolifyRollback(project: string, p: Record<string, unknown>): Promise<Plan> {
    const env = p.env === 'production' ? 'production' : 'preview';
    const wanted = (Array.isArray(p.resources) ? p.resources : []) as { uuid: string; image: string }[];
    // p13-multi-coolify: the connection the rolled-back deploy ran on (recorded in the rollback's params).
    const conn = await this.#coolifyFor(project, typeof p.connection === 'string' ? p.connection : null);
    const { apps, refusal } = await this.#resolveApps(
      conn,
      wanted.map((w) => w.uuid),
      [],
    );
    const resources = apps.map((a) => ({ uuid: a.uuid, name: a.name, fqdn: a.fqdn }));
    return {
      env,
      refusal,
      target: { provider: 'coolify', env, connection: { id: conn.id, label: conn.label }, resources },
      diff: {
        action: 'rollback',
        env,
        connection: conn.label,
        resources: wanted.map((w) => ({
          uuid: w.uuid,
          name: apps.find((a) => a.uuid === w.uuid)?.name ?? null,
          to: w.image,
        })),
      },
      previous: null,
      key: sha(stableJson({ resources, wanted })),
    };
  }

  /**
   * p10-site-upload: the Cloudflare Pages project an action may use — the project's target, or (named) one of its
   * further `pagesProjects`. Any other name is refused: a request never reaches a Pages project the project's
   * admins did not give it.
   */
  #pagesName(t: DeployTargets, wanted: unknown): string {
    if (typeof wanted === 'string') {
      if (t.pages?.projectName === wanted || t.pagesProjects.includes(wanted)) return wanted;
      throw new OpsError(
        403,
        'pages_project_not_allowed',
        `${wanted} is not one of this project’s Cloudflare Pages projects (Project → Deploy).`,
      );
    }
    if (t.pages === null) {
      throw new OpsError(
        409,
        'no_pages_target',
        'No Cloudflare Pages project is configured for this project (Project → Deploy).',
      );
    }
    return t.pages.projectName;
  }

  async #planPages(project: string, p: Record<string, unknown>, t: DeployTargets): Promise<Plan> {
    const name = this.#pagesName(t, p.pagesProject);
    const site = await this.#siteFiles(project, p);
    return this.#pagesPlan(site.origin, p, name, site.files, site.source);
  }

  /**
   * The files a Pages deploy publishes (pure reads, no Cloudflare call): an uploaded site (`uploadId`), else the
   * succeeded job's site bundle (exactly `bundleSha256` when set), else its committed output files under `directory`.
   */
  async #siteFiles(
    project: string,
    p: Record<string, unknown>,
  ): Promise<{
    origin: Record<string, unknown>;
    files: PagesFile[];
    source: 'site-bundle' | 'output-files' | 'upload';
  }> {
    if (typeof p.uploadId === 'string') {
      // p10-site-upload: a site a person uploaded through Project → Deploy.
      const uploads = this.deps.siteUploads?.() ?? null;
      const site = uploads === null ? null : await uploads.deployFiles(project, p.uploadId);
      if (site === null) {
        throw new OpsError(
          404,
          'upload_not_found',
          'The uploaded site is not there (deleted, or not complete).',
        );
      }
      const u = site.upload;
      return {
        origin: {
          uploadId: u.id,
          upload: {
            label: u.label,
            uploadedBy: u.uploadedBy.username ?? u.uploadedBy.id,
            fileCount: u.fileCount,
            siteSha256: u.siteSha256,
          },
        },
        files: site.files,
        source: 'upload',
      };
    }
    const jobId = String(p.jobId);
    const job = await this.deps.pool.query<{ project: string; state: string }>(
      'SELECT project, state FROM jobs WHERE id = $1',
      [jobId],
    );
    const j = job.rows[0];
    if (j === undefined || j.project !== project)
      throw new OpsError(404, 'job_not_found', 'Job not found in this project.');
    if (j.state !== 'SUCCEEDED')
      throw new OpsError(409, 'job_not_finished', 'Only a succeeded job can be deployed.');
    const wanted = typeof p.bundleSha256 === 'string' ? p.bundleSha256 : null;
    const site = await this.#siteBundleFiles(jobId, wanted);
    if (site !== null) return { origin: { jobId }, files: site, source: 'site-bundle' };
    if (wanted !== null) {
      // p6-deploy-on-success: bound to one exact bundle — never another one, never the output files.
      throw new OpsError(409, 'site_bundle_mismatch', 'The approved site bundle of this job is not there.');
    }
    const { rows: stored } = await this.deps.pool.query<{
      name: string;
      content: Buffer | null;
      blob_key: string | null;
      redacted: boolean;
      media_type: string;
    }>(
      `SELECT name, content, blob_key, redacted, media_type FROM job_artifacts
        WHERE job_id = $1 AND kind = 'output' AND pruned_at IS NULL
          AND attempt_id = (SELECT attempt_id FROM job_artifacts WHERE job_id = $1 AND kind = 'output'
                             ORDER BY created_at DESC LIMIT 1)
        ORDER BY name`,
      [jobId],
    );
    const dir = typeof p.directory === 'string' ? `${p.directory}/` : '';
    // p17-object-storage: the files' bytes come from the blob store (Pages takes at most 25 MiB per file).
    const rows: { name: string; content: Buffer; redacted: boolean; media_type: string }[] = [];
    for (const r of stored) {
      if (dir !== '' && !r.name.startsWith(dir)) continue;
      const content = await rowContent(r, 25 * 1024 * 1024).catch(() => null);
      if (content === null) {
        throw new OpsError(
          409,
          'artifact_unreadable',
          `The output file ${r.name} cannot be read from storage.`,
        );
      }
      rows.push({ name: r.name, content, redacted: r.redacted, media_type: r.media_type });
    }
    const chosen = rows;
    if (chosen.length === 0)
      throw new OpsError(409, 'no_artifacts', 'The job has no output files to deploy.');
    if (chosen.some((r) => r.redacted)) {
      // The master's redaction changed a file: deploying it would publish something the agent did not produce.
      throw new OpsError(
        409,
        'artifacts_redacted',
        'Some output files were redacted (secret patterns); they cannot be deployed.',
      );
    }
    const files: PagesFile[] = chosen.map((r) => {
      const path = r.name.slice(dir.length);
      const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
      return { path, content: r.content, contentType: MEDIA_BY_EXT[ext] ?? r.media_type };
    });
    return { origin: { jobId }, files, source: 'output-files' };
  }

  /**
   * p6-deploy-pipeline: the files of the job's newest site bundle (kind `site`), or null when it has none. A bundle
   * the master flagged (its own secret scan) is refused, never published.
   */
  async #siteBundleFiles(jobId: string, sha256: string | null = null): Promise<PagesFile[] | null> {
    const { rows } = await this.deps.pool.query<{
      content: Buffer | null;
      blob_key: string | null;
      redacted: boolean;
    }>(
      `SELECT content, blob_key, redacted FROM job_artifacts WHERE job_id = $1 AND kind = 'site'
          AND ($2::text IS NULL OR sha256 = $2::text)
        ORDER BY created_at DESC LIMIT 1`,
      [jobId, sha256],
    );
    const row = rows[0];
    if (row === undefined) return null;
    // p17-object-storage: the bundle's bytes may be in the blob store.
    const r = { redacted: row.redacted, content: await rowContent(row, 16 * 1024 * 1024) };
    if (r.content === null) {
      // Workspace storage retention / quota removed the bundle's content.
      throw new OpsError(
        409,
        'site_bundle_pruned',
        'The site bundle was removed by the storage retention; run the job again.',
      );
    }
    if (r.redacted) {
      throw new OpsError(
        409,
        'artifacts_redacted',
        'The site bundle looks like it contains a secret; it cannot be deployed.',
      );
    }
    const parsed = SiteBundle.safeParse(JSON.parse(r.content.toString('utf8')));
    if (!parsed.success) throw new OpsError(409, 'site_bundle_invalid', 'The site bundle is invalid.');
    return parsed.data.files.map((f) => ({
      path: f.path,
      content: Buffer.from(f.base64, 'base64'),
      contentType: f.contentType,
    }));
  }

  async #pagesPlan(
    origin: Record<string, unknown>,
    p: Record<string, unknown>,
    projectName: string,
    files: readonly PagesFile[],
    source: 'site-bundle' | 'output-files' | 'upload',
  ): Promise<Plan> {
    const bytes = files.reduce((s, f) => s + f.content.length, 0);
    if (bytes > this.#limits.maxPagesBytes)
      throw new OpsError(413, 'bundle_too_large', 'The site bundle is too large.');
    const cf = await this.#cloudflare();
    const pagesProject = await this.#provider(() => cf.pagesProject(projectName));
    const branch =
      typeof p.branch === 'string'
        ? p.branch
        : p.env === 'production'
          ? pagesProject.productionBranch
          : 'remyral-preview';
    const env: DeployEnv = branch === pagesProject.productionBranch ? 'production' : 'preview';
    const filesHash = sha(stableJson(files.map((f) => [f.path, sha(f.content.toString('base64'))])));
    return {
      env,
      refusal: null,
      target: { provider: 'cloudflare-pages', project: pagesProject.name, branch, env },
      diff: {
        action: 'pages deploy',
        project: pagesProject.name,
        branch,
        env,
        productionBranch: pagesProject.productionBranch,
        ...origin,
        source,
        fileCount: files.length,
        files: files.map((f) => ({ path: f.path, bytes: f.content.length })),
        bytes,
        ...(env === 'production' ? { domains: [...pagesProject.domains, pagesProject.subdomain] } : {}),
      },
      previous: null,
      key: sha(stableJson({ project: pagesProject.name, env, filesHash })),
      files,
    };
  }

  #planPagesRollback(p: Record<string, unknown>, t: DeployTargets): Plan {
    const name = String(p.projectName);
    if (t.pages?.projectName !== name && !t.pagesProjects.includes(name))
      throw new OpsError(409, 'no_pages_target', 'The Pages project is no longer configured.');
    return {
      env: 'production',
      refusal: null,
      target: { provider: 'cloudflare-pages', project: name, env: 'production' },
      diff: { action: 'pages rollback', project: name, toDeployment: String(p.deploymentId) },
      previous: null,
      key: sha(stableJson(p)),
    };
  }

  async #protection(
    client: CloudflareClient,
    zoneId: string,
    zoneName: string,
    t: DeployTargets,
  ): Promise<ProtectionContext> {
    const targets = new Set(this.deps.controlPlaneAddresses.map((a) => a.toLowerCase()));
    // The console host's own records (in this zone) are control-plane addresses too.
    for (const host of this.#consoleHosts) {
      if (!nameInZone(host, zoneName)) continue;
      for (const r of await this.#provider(() => client.records(zoneId, host), { dnsZone: zoneName })) {
        targets.add(r.content.toLowerCase().replace(/\.$/, ''));
      }
    }
    return {
      consoleHosts: this.#consoleHosts,
      protectedNames: new Set(t.dns.protectedNames),
      controlPlaneTargets: targets,
    };
  }

  async #planDns(
    kind: 'dns.upsert' | 'dns.delete',
    p: Record<string, unknown>,
    t: DeployTargets,
  ): Promise<Plan> {
    const zoneName = String(p.zone);
    const zone = t.dns.zones.find((z) => z.name === zoneName);
    if (zone === undefined)
      throw new OpsError(403, 'zone_not_allowed', `Zone ${zoneName} is not allowed for this project.`);
    const name = String(p.name);
    const type = String(p.type);
    if (!nameInZone(name, zone.name))
      throw new OpsError(400, 'name_outside_zone', `${name} is not in zone ${zone.name}.`);
    const client = await this.#cloudflare();
    const ctx = await this.#protection(client, zone.id, zone.name, t);
    const current = await this.#provider(() => client.records(zone.id, name, type), { dnsZone: zone.name });
    if (current.length > 1) {
      throw new OpsError(
        409,
        'multiple_records',
        `${name} has ${String(current.length)} ${type} records; change them in Cloudflare.`,
      );
    }
    const before = current[0] ?? null;
    const view = (r: DnsRecord | null) =>
      r === null ? null : { id: r.id, content: r.content, ttl: r.ttl, proxied: r.proxied };
    let refusal = before === null ? null : protectedRecordReason(before, ctx);
    if (kind === 'dns.delete') {
      if (before === null) throw new OpsError(404, 'record_not_found', `No ${type} record named ${name}.`);
      refusal ??= protectedRecordReason({ name, type }, ctx);
      return {
        env: null,
        refusal,
        target: { provider: 'cloudflare-dns', zone: zone.name, zoneId: zone.id, name, type },
        diff: { action: 'delete', zone: zone.name, name, type, before: view(before), after: null },
        previous: { zoneId: zone.id, before: { type, name, ...view(before) } },
        key: sha(stableJson(view(before))),
      };
    }
    const after = { content: String(p.content), ttl: Number(p.ttl), proxied: p.proxied === true };
    if (type === 'CNAME' || type === 'A' || type === 'AAAA') {
      // Only these can be proxied; TXT is never proxied.
    } else if (after.proxied) {
      throw new OpsError(400, 'invalid_params', 'TXT records cannot be proxied.');
    }
    refusal ??= protectedRecordReason({ name, type, content: after.content }, ctx);
    if (
      before !== null &&
      before.content === after.content &&
      before.ttl === after.ttl &&
      before.proxied === after.proxied
    ) {
      throw new OpsError(409, 'no_change', 'The record already has these values.');
    }
    // p10-publish-bundle: DNS "Run at once" covers only a CNAME to one of this project's own Pages projects.
    const ownPagesCname =
      t.policy.dnsChange === 'auto' && type === 'CNAME'
        ? await this.#ownPagesDev(client, t, after.content)
        : false;
    return {
      env: null,
      ownPagesCname,
      refusal,
      target: { provider: 'cloudflare-dns', zone: zone.name, zoneId: zone.id, name, type },
      diff: {
        action: before === null ? 'create' : 'update',
        zone: zone.name,
        name,
        type,
        before: view(before),
        after,
      },
      previous: { zoneId: zone.id, before: before === null ? null : { type, name, ...view(before) } },
      key: sha(stableJson(view(before))),
    };
  }

  // ------------------------------------------------------------------- p6-pages-create (Pages projects)

  /** The Pages project of that name in the connected account, or null when Cloudflare answers 404. */
  async #pagesProjectOrNull(cf: CloudflareClient, name: string): Promise<PagesProject | null> {
    return this.#provider(async () => {
      try {
        return await cf.pagesProject(name);
      } catch (err) {
        if (err instanceof ProviderCallError && err.code === 'not_found') return null;
        throw err;
      }
    });
  }

  /**
   * `pages.create_project`: create a Direct Upload project (no source repository), or — `ifExists: adopt` — use the
   * existing one; optionally make it this project's Pages target. An existing name without "adopt" is refused
   * before anything is stored (the account already has it; nothing to create).
   */
  async #planPagesCreate(p: Record<string, unknown>, t: DeployTargets): Promise<Plan> {
    const name = String(p.name);
    const branch = String(p.productionBranch);
    const useAsTarget = p.useAsTarget === true;
    const cf = await this.#cloudflare();
    const existing = await this.#pagesProjectOrNull(cf, name);
    const current = t.pages?.projectName ?? null;
    if (existing !== null && p.ifExists !== 'adopt') {
      throw new OpsError(
        409,
        'pages_project_exists',
        `A Pages project named ${name} already exists in the Cloudflare account. Pick another name, or choose “adopt existing” to use it for this project.`,
      );
    }
    if (existing !== null && current === name) {
      throw new OpsError(409, 'no_change', `${name} is already this project’s Pages target.`);
    }
    // p10-site-upload: without "use as target" the project is kept as one of this project's further Pages projects
    // (deployable by name, the target stays as it is).
    const listed = t.pagesProjects.includes(name);
    if (!useAsTarget && existing !== null && listed) {
      throw new OpsError(409, 'no_change', `${name} is already one of this project’s Pages projects.`);
    }
    if (!useAsTarget && !listed && t.pagesProjects.length >= 20) {
      throw new OpsError(
        409,
        'pages_projects_full',
        'This project already has 20 further Pages projects; remove one in Project → Deploy first.',
      );
    }
    return {
      env: null,
      refusal: null,
      target: { provider: 'cloudflare-pages', project: name },
      diff: {
        action: existing === null ? 'create project' : 'adopt project',
        project: name,
        productionBranch: existing?.productionBranch ?? branch,
        directUpload: true,
        subdomain: existing?.subdomain ?? `${name}.pages.dev`,
        ...(existing === null
          ? { note: 'Cloudflare may add a suffix to the pages.dev name; the result shows the real one.' }
          : {
              existing: { productionBranch: existing.productionBranch, domains: [...existing.domains] },
              note: 'The existing project is used as it is (its production branch and domains are kept).',
            }),
        deployTarget: useAsTarget ? { from: current, to: name } : null,
        pagesProjects: useAsTarget || listed ? null : { add: name, targetUnchanged: current },
      },
      previous: null,
      key: sha(
        stableJson({ name, exists: existing !== null, current: useAsTarget ? current : null, listed }),
      ),
    };
  }

  /**
   * `pages.add_domain`: attach `domain` to the project's Pages target. The domain must not be a protected name and,
   * when it lies in a zone of the connected account, that zone must be allowed for this project (otherwise another
   * project's names could be taken over). With `dns: auto` the CNAME `domain → <subdomain>` is planned exactly like
   * a `dns.upsert` (same protection checks); a domain outside the account gets the record to add by hand.
   */
  async #planPagesDomain(p: Record<string, unknown>, t: DeployTargets): Promise<Plan> {
    const name = this.#pagesName(t, p.pagesProject);
    const cf = await this.#cloudflare();
    const project = await this.#provider(() => cf.pagesProject(name));
    if (project.subdomain === '') {
      throw new OpsError(
        424,
        'cloudflare_bad_response',
        `Cloudflare: returned no pages.dev name for ${name}.`,
      );
    }
    const f = await this.#domainFacts(
      cf,
      t,
      name,
      project,
      String(p.domain),
      p.dns === 'skip' ? 'skip' : 'auto',
    );
    if (f.attached !== null && !f.withDns) {
      throw new OpsError(
        409,
        'no_change',
        `${f.domain} is already attached to ${name} (status ${f.attached.status || 'unknown'}).`,
      );
    }
    return {
      env: null,
      refusal: f.refusal,
      target: {
        provider: 'cloudflare-pages',
        project: name,
        domain: f.domain,
        ...(f.zone === null ? {} : { zone: f.zone.name, zoneId: f.zone.id }),
      },
      diff: {
        action: 'add domain',
        project: name,
        domain: f.domain,
        subdomain: f.subdomain,
        attach: f.attached === null ? 'attach' : 'already attached',
        ...(f.attached === null ? {} : { status: f.attached.status }),
        dns: f.dns,
      },
      previous: f.previous,
      key: f.key,
      withDns: f.withDns,
    };
  }

  /**
   * The facts of attaching `domain` to the Pages project `name` (shared by `pages.add_domain` and the domain step of
   * `pages.publish`; `project` null = the bundle creates it first, its `pages.dev` name is predicted). The domain
   * must not be a protected name and, when it lies in a zone of the connected account, that zone must be allowed for
   * this project (otherwise another project's names could be taken over). With `dns: auto` the CNAME
   * `domain → <subdomain>` is planned exactly like a `dns.upsert` (same protection checks); a domain outside the
   * account gets the record to add by hand.
   */
  async #domainFacts(
    cf: CloudflareClient,
    t: DeployTargets,
    name: string,
    project: PagesProject | null,
    domain: string,
    dnsMode: 'auto' | 'skip',
  ): Promise<{
    domain: string;
    subdomain: string;
    refusal: string | null;
    attached: PagesDomain | null;
    zone: { id: string; name: string } | null;
    dns: Record<string, unknown>;
    withDns: boolean;
    previous: Record<string, unknown> | null;
    key: string;
  }> {
    let refusal: string | null = null;
    if (this.#consoleHosts.has(domain)) refusal = `${domain} is the console host (protected).`;
    else if (t.dns.protectedNames.includes(domain))
      refusal = `${domain} is a protected record of this project.`;
    const subdomain = project?.subdomain || `${name}.pages.dev`;
    const attached =
      project === null
        ? null
        : ((await this.#provider(() => cf.pagesDomains(name))).find((d) => d.name === domain) ?? null);
    const zone =
      (await this.#provider(() => cf.zones()))
        .filter((z) => nameInZone(domain, z.name))
        .sort((a, b) => b.name.length - a.name.length)[0] ?? null;
    if (zone !== null && !t.dns.zones.some((z) => z.id === zone.id)) {
      throw new OpsError(
        403,
        'zone_not_allowed',
        `${domain} is in the Cloudflare zone ${zone.name}, which is not allowed for this project (Project → Deploy → Allowed DNS zones).`,
      );
    }
    const record = { type: 'CNAME', name: domain, content: subdomain, proxied: true };
    let dns: Record<string, unknown>;
    let dnsKey: string | null = null;
    let withDns = false;
    let previous: Record<string, unknown> | null = null;
    if (zone === null) {
      dns = {
        action: 'manual',
        record,
        reason:
          'The domain is not in a zone of the connected Cloudflare account: add this record at its DNS provider.',
      };
    } else if (dnsMode === 'skip') {
      dns = { action: 'skipped', zone: zone.name, record };
    } else {
      const others = (await this.#provider(() => cf.records(zone.id, domain), { dnsZone: zone.name })).filter(
        (r) => r.type === 'A' || r.type === 'AAAA',
      );
      if (others.length > 0) {
        throw new OpsError(
          409,
          'dns_conflict',
          `${domain} has ${others[0]?.type ?? 'A'} records; a CNAME cannot sit next to them. Change them first (a DNS change), or attach with DNS “skip”.`,
        );
      }
      try {
        const dp = await this.#planDns(
          'dns.upsert',
          { zone: zone.name, type: 'CNAME', name: domain, content: subdomain, ttl: 1, proxied: true },
          t,
        );
        refusal ??= dp.refusal;
        dns = { ...dp.diff, zoneId: zone.id };
        dnsKey = dp.key;
        withDns = true;
        previous = dp.previous;
      } catch (err) {
        if (!(err instanceof OpsError) || err.code !== 'no_change') throw err;
        dns = { action: 'unchanged', zone: zone.name, record };
      }
    }
    return {
      domain,
      subdomain,
      refusal,
      attached,
      zone: zone === null ? null : { id: zone.id, name: zone.name },
      dns,
      withDns,
      previous,
      key: sha(
        stableJson({
          name,
          domain,
          attached: attached !== null,
          subdomain,
          zone: zone?.id ?? null,
          dnsKey,
        }),
      ),
    };
  }

  /** p10-publish-bundle: `content` is the `pages.dev` name of one of the project's own Pages projects. */
  async #ownPagesDev(cf: CloudflareClient, t: DeployTargets, content: string): Promise<boolean> {
    const c = content.trim().toLowerCase().replace(/\.$/, '');
    if (!c.endsWith('.pages.dev')) return false;
    const own = new Set([...(t.pages === null ? [] : [t.pages.projectName]), ...t.pagesProjects]);
    if (own.size === 0) return false;
    const projects = await this.#provider(() => cf.pagesProjects());
    return projects.some((p) => own.has(p.name) && p.subdomain.toLowerCase() === c);
  }

  // ------------------------------------------------------------------ p10-publish-bundle (ADR-0038)

  /**
   * `pages.publish`: the plan of the whole chain — create the Pages project if it is missing (a name new in the
   * account, kept as a further Pages project), deploy the files, attach the domain and write its CNAME. Each step is
   * planned with the same rules as its own kind; the decision is the strictest step (`publishDecision`).
   */
  async #planPublish(project: string, p: Record<string, unknown>, t: DeployTargets): Promise<OpsPlan> {
    const env = p.env === 'production' ? 'production' : 'preview';
    const name = typeof p.pagesProject === 'string' ? p.pagesProject : (t.pages?.projectName ?? null);
    if (name === null) {
      throw new OpsError(
        409,
        'no_pages_target',
        'No Cloudflare Pages project is configured for this project: name one (or a new one to create).',
      );
    }
    const listed = t.pages?.projectName === name || t.pagesProjects.includes(name);
    const createAllowed = p.createIfMissing === true;
    if (!listed && !createAllowed) {
      throw new OpsError(
        403,
        'pages_project_not_allowed',
        `${name} is not one of this project’s Cloudflare Pages projects (Project → Deploy); allow creating it if it is new.`,
      );
    }
    // Files first (no provider call): an unusable source refuses before Cloudflare is asked.
    const site = await this.#siteFiles(project, p);
    const bytes = site.files.reduce((n, f) => n + f.content.length, 0);
    if (bytes > this.#limits.maxPagesBytes)
      throw new OpsError(413, 'bundle_too_large', 'The site bundle is too large.');
    const cf = await this.#cloudflare();
    const existing = await this.#pagesProjectOrNull(cf, name);
    if (existing === null) {
      if (!createAllowed) {
        throw new OpsError(
          409,
          'pages_project_missing',
          `The Pages project ${name} does not exist in the Cloudflare account; allow creating it.`,
        );
      }
      if (!PagesNewProjectName.safeParse(name).success) {
        throw new OpsError(
          400,
          'invalid_params',
          'Pages project name: 1–58 lowercase letters, digits and hyphens; starts and ends with a letter or digit.',
        );
      }
      if (!listed && t.pagesProjects.length >= 20) {
        throw new OpsError(
          409,
          'pages_projects_full',
          'This project already has 20 further Pages projects; remove one in Project → Deploy first.',
        );
      }
    } else if (!listed) {
      throw new OpsError(
        409,
        'pages_project_exists',
        `A Pages project named ${name} already exists in the Cloudflare account but is not one of this project’s Pages projects. A project admin can adopt it (Project → Deploy); a publish never takes over an existing project.`,
      );
    }
    const productionBranch = existing?.productionBranch ?? (str(p.productionBranch) || 'main');
    const branch = env === 'production' ? productionBranch : 'remyral-preview';
    const filesHash = sha(stableJson(site.files.map((f) => [f.path, sha(f.content.toString('base64'))])));
    const deployKey = sha(stableJson({ project: name, env, filesHash }));
    const facts: PublishStepFacts[] = [];
    const steps: Record<string, unknown>[] = [];
    const keys: Record<string, unknown> = {};
    if (existing === null) {
      facts.push({ step: 'create' });
      steps.push({
        step: 'create',
        project: name,
        productionBranch,
        subdomain: `${name}.pages.dev`,
        note: 'Cloudflare may add a suffix to the pages.dev name; the domain step uses the real one.',
      });
      keys.create = { name, exists: false, listed };
    }
    facts.push({ step: 'deploy', env });
    steps.push({
      step: 'deploy',
      project: name,
      env,
      branch,
      source: site.source,
      fileCount: site.files.length,
      bytes,
      files: site.files.slice(0, 200).map((f) => ({ path: f.path, bytes: f.content.length })),
      key: deployKey,
    });
    keys.deploy = deployKey;
    let refusal: string | null = null;
    let domainLink: string | null = null;
    let withDns = false;
    let previous: Record<string, unknown> | null = null;
    if (typeof p.domain === 'string') {
      const f = await this.#domainFacts(cf, t, name, existing, p.domain, p.dns === 'skip' ? 'skip' : 'auto');
      refusal = f.refusal;
      withDns = f.withDns;
      previous = f.previous;
      const done = f.attached !== null && !f.withDns;
      facts.push({ step: 'domain', withDns: f.withDns, refusal: f.refusal });
      const before: unknown = f.dns.before;
      const dnsBefore =
        typeof before === 'object' && before !== null
          ? (before as { id?: unknown; content?: unknown })
          : null;
      steps.push({
        step: 'domain',
        project: name,
        domain: f.domain,
        subdomain: f.subdomain,
        attach: f.attached === null ? 'attach' : 'already attached',
        ...(f.attached === null ? {} : { status: f.attached.status }),
        dns: f.dns,
        zoneId: f.zone?.id ?? null,
        dnsAction: str(f.dns.action),
        dnsBefore:
          dnsBefore === null
            ? null
            : { id: str(dnsBefore.id) || null, content: str(dnsBefore.content) || null },
        ...(done ? { done: true } : {}),
      });
      keys.domain = f.key;
      domainLink = `https://${f.domain}`;
    }
    const decision = publishDecision(facts, t.policy);
    steps.forEach((st, i) => {
      st.decision = decision.steps[i];
    });
    return {
      env,
      refusal,
      decision: { decision: decision.decision, reason: decision.reason },
      target: {
        provider: 'cloudflare-pages',
        project: name,
        env,
        branch,
        ...(typeof p.domain === 'string' ? { domain: p.domain } : {}),
      },
      diff: {
        action: 'publish',
        project: name,
        env,
        branch,
        productionBranch,
        ...site.origin,
        source: site.source,
        fileCount: site.files.length,
        bytes,
        steps,
        links: {
          pagesDev: `https://${existing?.subdomain || `${name}.pages.dev`}`,
          ...(domainLink === null ? {} : { domain: domainLink }),
        },
      },
      previous,
      key: sha(stableJson(keys)),
      withDns,
    };
  }

  /**
   * p10-publish-bundle: the bundle's approver and requester may still do what the approval stood for — checked before
   * every step. Null = fine, else why not.
   */
  async #publishPeopleCheck(row: Row): Promise<string | null> {
    const active = async (id: string): Promise<Subject | null> => {
      const { rows } = await this.deps.pool.query<{ id: string; role: Role; disabled_at: Date | null }>(
        'SELECT id::text AS id, role, disabled_at FROM users WHERE id::text = $1',
        [id],
      );
      const u = rows[0];
      if (u === undefined || u.disabled_at !== null) return null;
      return loadSubject(this.deps.pool, { id: u.id, role: u.role });
    };
    const approved = row.policy_decision === 'approval' || row.policy_decision === 'approval_step_up';
    if (approved && row.decided_by !== null) {
      const s = await active(row.decided_by);
      if (s === null || !authorize(s, 'deploy.approve', { project: row.project }).allow) {
        return 'the person who approved the publish may no longer approve deploys in this project';
      }
    }
    if (row.requested_by_type === 'user') {
      const s = await active(row.requested_by_id);
      if (s === null || !authorize(s, 'deploy.request', { project: row.project }).allow) {
        return 'the person who requested the publish may no longer request deploys in this project';
      }
    }
    return null;
  }

  /** The child request of one bundle step and the precondition its fresh plan must meet. */
  #publishChild(
    row: Row,
    planned: Record<string, unknown>,
  ): {
    kind: 'pages.create_project' | 'pages.deploy' | 'pages.add_domain';
    params: Record<string, unknown>;
    precondition: (plan: OpsPlan) => string | null;
  } {
    const p = row.params;
    const name = String(planned.project);
    switch (planned.step) {
      case 'create':
        return {
          kind: 'pages.create_project',
          params: { name, productionBranch: str(planned.productionBranch) || 'main' },
          precondition: (plan) =>
            plan.diff.action === 'create project' ? null : `${name} exists in the Cloudflare account now`,
        };
      case 'deploy':
        return {
          kind: 'pages.deploy',
          params: {
            ...(typeof p.uploadId === 'string' ? { uploadId: p.uploadId } : { jobId: p.jobId }),
            env: p.env === 'production' ? 'production' : 'preview',
            pagesProject: name,
            ...(typeof p.bundleSha256 === 'string' ? { bundleSha256: p.bundleSha256 } : {}),
            ...(typeof p.directory === 'string' ? { directory: p.directory } : {}),
          },
          precondition: (plan) =>
            plan.key === planned.key ? null : 'the Pages project, the environment or the files differ',
        };
      default: {
        const before = (planned.dnsBefore ?? null) as { id: string | null; content: string | null } | null;
        return {
          kind: 'pages.add_domain',
          params: {
            domain: String(planned.domain),
            dns: p.dns === 'skip' ? 'skip' : 'auto',
            pagesProject: name,
          },
          precondition: (plan) => {
            if (plan.target.project !== name || plan.target.domain !== planned.domain) {
              return 'the Pages project or the domain differs';
            }
            if ((plan.target.zoneId ?? null) !== (planned.zoneId ?? null)) return 'the DNS zone differs';
            const dns = (plan.diff.dns ?? {}) as {
              action?: unknown;
              before?: { id?: unknown; content?: unknown } | null;
            };
            const action = str(dns.action);
            // A record written meanwhile is a changed precondition — unless the plan saw none and it now points at
            // this very project (nothing left to write).
            if (action !== str(planned.dnsAction) && !(action === 'unchanged' && before === null)) {
              return `the DNS record of ${String(planned.domain)} changed`;
            }
            const now = dns.before ?? null;
            if ((before === null) !== (now === null))
              return `the DNS record of ${String(planned.domain)} changed`;
            if (before !== null && now !== null && (before.id !== now.id || before.content !== now.content)) {
              return `the DNS record of ${String(planned.domain)} changed`;
            }
            return null;
          },
        };
      }
    }
  }

  /**
   * Moves a publish bundle on: requests the next step (pre-approved by the bundle, re-checked), follows a running
   * one, stops at the first failure. Returns the bundle's state and progress; never executes a step twice (child
   * idempotency key `pb:<bundle>:<step>`).
   */
  async #advancePublish(
    row: Row,
    actor: OpsActor,
  ): Promise<{
    state: 'deploying' | 'succeeded' | 'failed';
    result: Record<string, unknown>;
    error?: string;
  }> {
    const planned = (Array.isArray(row.diff.steps) ? row.diff.steps : []) as Record<string, unknown>[];
    const prior = (row.result?.steps ?? null) as PublishStepState[] | null;
    const states: PublishStepState[] =
      prior ??
      planned.map((st) => ({
        step: st.step as PublishStep,
        state: st.done === true ? ('skipped' as const) : ('pending' as const),
        ...(st.done === true ? { note: `${String(st.domain)} is already attached with its record.` } : {}),
      }));
    const links = new Set<string>(Array.isArray(row.result?.links) ? (row.result.links as string[]) : []);
    const result: Record<string, unknown> = { ...(row.result ?? {}), steps: states };
    const out = (state: 'deploying' | 'succeeded' | 'failed', error?: string) => ({
      state,
      result: { ...result, links: [...links] },
      ...(error === undefined ? {} : { error }),
    });
    const fail = async (st: PublishStepState, error: string) => {
      st.state = 'failed';
      st.error = error.slice(0, 500);
      await this.#publishAudit(row, st, 'failure');
      return out('failed', `Step ${st.step} failed: ${error}`.slice(0, 1000));
    };
    const pre: PreApproval | undefined =
      (row.policy_decision === 'approval' || row.policy_decision === 'approval_step_up') &&
      row.decided_by !== null &&
      row.decided_at !== null
        ? {
            by: row.decided_by,
            at: row.decided_at,
            stepUpAt: row.step_up_at,
            covers: row.policy_decision,
          }
        : undefined;
    for (let i = 0; i < states.length; i++) {
      const st = states[i] as PublishStepState;
      const plan = planned[i] ?? {};
      if (st.state === 'done' || st.state === 'skipped') continue;
      if (st.state === 'failed') return out('failed', st.error ?? `Step ${st.step} failed.`);
      let child: OpsActionView;
      if (st.actionId === undefined) {
        const who = await this.#publishPeopleCheck(row);
        if (who !== null) return fail(st, `${who}; nothing more was executed.`);
        const c = this.#publishChild(row, plan);
        try {
          child = (
            await this.request(
              { type: row.requested_by_type, id: row.requested_by_id },
              {
                project: row.project,
                kind: c.kind,
                params: c.params,
                idempotencyKey: `pb:${row.id}:${st.step}`,
                note: `Step ${String(i + 1)} (${st.step}) of publish ${row.id}`,
              },
              row.via,
              {
                source: {
                  ...(row.source ?? {}),
                  publishBundle: row.id,
                  step: st.step,
                },
                ...(pre === undefined ? {} : { preApproved: pre }),
                preApprovedReason: BUNDLE_APPROVAL_REASON,
                precondition: c.precondition,
                skipRateLimit: true,
                ...(c.kind === 'pages.deploy' ? { expectEnv: row.env ?? 'preview' } : {}),
              },
            )
          ).action;
        } catch (err) {
          if (!(err instanceof OpsError)) throw err;
          if (st.step === 'domain' && err.code === 'no_change') {
            st.state = 'done';
            st.note = err.message;
            continue;
          }
          return fail(st, err.message);
        }
        st.actionId = child.id;
        st.state = 'running';
        await this.#publishAudit(row, st, 'success');
      } else {
        child = await this.get(st.actionId);
      }
      if (child.state === 'deploying' && st.step === 'deploy') {
        // Ask Cloudflare now instead of waiting for the next poll (a provider error just waits).
        child = await this.refresh(actor, child.id).catch(() => child);
      }
      switch (child.state) {
        case 'succeeded':
        case 'deploying':
          if (child.state === 'deploying' && st.step !== 'domain') {
            st.state = 'running';
            delete st.note;
            return out('deploying');
          }
          st.state = 'done';
          if (st.step === 'deploy') {
            const url = child.result?.url;
            if (typeof url === 'string' && url !== '') {
              result.url = url;
              links.add(url);
            }
          }
          if (st.step === 'domain') {
            links.add(`https://${String(plan.domain)}`);
            const status = child.result?.status;
            if (typeof status === 'string') result.domainStatus = status;
            if (child.state === 'deploying') {
              st.note = `Cloudflare is validating ${String(plan.domain)}; the domain action follows it.`;
            }
          }
          continue;
        case 'executing':
          st.state = 'running';
          return out('deploying');
        case 'awaiting_approval':
          st.state = 'waiting';
          st.note =
            'This step waits for an approval: the project’s policy is stricter now than when the publish was approved.';
          return out('deploying');
        default:
          return fail(
            st,
            `${child.kind} ${child.state}${child.error === null ? (child.state === 'refused' ? `: ${child.policy.reason}` : '') : `: ${child.error}`}`,
          );
      }
    }
    return out('succeeded');
  }

  async #publishAudit(row: Row, st: PublishStepState, outcome: 'success' | 'failure'): Promise<void> {
    await this.deps.audit.record({
      actor: { type: 'system', id: 'publish-bundle' },
      action: 'ops.publish.step',
      target: `ops-action:${row.id}`,
      outcome,
      metadata: {
        project: row.project,
        step: st.step,
        state: st.state,
        childActionId: st.actionId ?? null,
        error: st.error?.slice(0, 300) ?? null,
      },
    });
  }

  /**
   * p10-site-upload: adds a Pages project to the project's further `pagesProjects` (after `pages.create_project`
   * without `useAsTarget`), audited like a target write. The default target is left as it is.
   */
  async #addPagesProject(row: Row, name: string, actor: OpsActor): Promise<number> {
    const cur = await this.targets(row.project);
    const base = cur?.targets ?? DeployTargets.parse({});
    if (base.pagesProjects.includes(name) || base.pages?.projectName === name) return cur?.version ?? 0;
    const next = DeployTargets.parse({ ...base, pagesProjects: [...base.pagesProjects, name] });
    const now = this.deps.clock();
    const res = await this.deps.pool.query<{ version: number }>(
      `INSERT INTO project_deploy_targets (project, config, version, updated_by, updated_at)
       VALUES ($1, $2, 1, $3, $4)
       ON CONFLICT (project) DO UPDATE SET config = EXCLUDED.config, version = project_deploy_targets.version + 1,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
       WHERE $5::int IS NULL OR project_deploy_targets.version = $5
       RETURNING version`,
      [row.project, storable(next), actor.type === 'user' ? actor.id : null, now, cur?.version ?? null],
    );
    const version = res.rows[0]?.version;
    if (version === undefined) {
      throw new OpsError(409, 'stale_targets', 'The deploy targets changed meanwhile.');
    }
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'ops.targets.write',
      target: `project:${row.project}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        version,
        change: { pagesProjects: { added: name } },
        opsAction: row.id,
        requestedBy: { type: row.requested_by_type, id: row.requested_by_id },
      },
    });
    return version;
  }

  /** Sets the project's Pages target (after `pages.create_project` with `useAsTarget`), audited like a target write. */
  async #setPagesTarget(row: Row, name: string, actor: OpsActor): Promise<number> {
    const cur = await this.targets(row.project);
    const base = cur?.targets ?? DeployTargets.parse({});
    const from = base.pages?.projectName ?? null;
    const next = DeployTargets.parse({ ...base, pages: { projectName: name } });
    const now = this.deps.clock();
    const res = await this.deps.pool.query<{ version: number }>(
      `INSERT INTO project_deploy_targets (project, config, version, updated_by, updated_at)
       VALUES ($1, $2, 1, $3, $4)
       ON CONFLICT (project) DO UPDATE SET config = EXCLUDED.config, version = project_deploy_targets.version + 1,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
       WHERE $5::int IS NULL OR project_deploy_targets.version = $5
       RETURNING version`,
      [row.project, storable(next), actor.type === 'user' ? actor.id : null, now, cur?.version ?? null],
    );
    const version = res.rows[0]?.version;
    if (version === undefined) {
      throw new OpsError(409, 'stale_targets', 'The deploy targets changed meanwhile.');
    }
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'ops.targets.write',
      target: `project:${row.project}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        version,
        change: { pages: { from, to: name } },
        opsAction: row.id,
        requestedBy: { type: row.requested_by_type, id: row.requested_by_id },
      },
    });
    return version;
  }

  // ----------------------------------------------------------------------------------------- deciding

  async #expireStale(db: Queryable = this.deps.pool): Promise<void> {
    await db.query(
      `UPDATE ops_actions SET state = 'expired', updated_at = $1, finished_at = $1
        WHERE state = 'awaiting_approval' AND expires_at IS NOT NULL AND expires_at <= $1`,
      [this.deps.clock()],
    );
  }

  async approve(actor: OpsActor, id: string, reason: string | null): Promise<OpsActionView> {
    await this.#expireStale();
    const cur = await this.get(id);
    if (cur.state !== 'awaiting_approval') {
      throw new OpsError(409, 'not_awaiting_approval', `The action is ${cur.state}.`);
    }
    const now = this.deps.clock();
    if (cur.policy.decision === 'approval_step_up') {
      const maxAge = Math.min(actor.stepUpMaxAgeMs ?? STEP_UP_ALWAYS_FRESH_MS, STEP_UP_ALWAYS_FRESH_MS);
      if (actor.type !== 'user' || !stepUpFresh(actor.mfaAt ?? null, now, maxAge)) {
        throw new OpsError(
          403,
          'step_up_required',
          'Confirm with a current authenticator code (always-fresh).',
        );
      }
    }
    // Claim: exactly one approver moves it on.
    const claimed = await this.deps.pool.query(
      `UPDATE ops_actions SET state = 'executing', decided_by = $2, decided_at = $3, decision_reason = $4,
         step_up_at = $5, updated_at = $3
       WHERE id = $1 AND state = 'awaiting_approval' RETURNING id`,
      [id, actor.id, now, reason, cur.policy.decision === 'approval_step_up' ? (actor.mfaAt ?? null) : null],
    );
    if ((claimed.rowCount ?? 0) === 0)
      throw new OpsError(409, 'not_awaiting_approval', 'The action was decided meanwhile.');
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'ops.action.approve',
      target: `ops-action:${id}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        project: cur.project,
        kind: cur.kind,
        env: cur.env,
        stepUp: cur.policy.decision === 'approval_step_up',
        reason,
      },
    });
    // Re-plan: the approver saw a diff; if the target changed since, do not execute something else.
    let plan: OpsPlan;
    try {
      const t = await this.targets(cur.project);
      const targets =
        t?.targets ??
        (cur.kind === 'pages.create_project' ||
        this.#handler(cur.kind)?.allowWithoutTargets?.(cur.kind) === true
          ? DeployTargets.parse({})
          : null);
      if (targets === null) throw new OpsError(409, 'no_deploy_targets', 'The deploy targets were removed.');
      plan = await this.#plan(cur.project, cur.kind, cur.params, targets);
      if (plan.refusal !== null) throw new OpsError(409, 'refused', plan.refusal);
      const stored = await this.#row(id);
      // p13-multi-coolify: the plan key keeps its p6 formula; a target moved to another connection is stale too.
      if (
        plan.key !== stored?.target.planKey ||
        connectionIdOf(plan.target) !== connectionIdOf(stored.target)
      ) {
        throw new OpsError(
          409,
          'stale',
          'The target changed since the request; nothing was executed. Request it again.',
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'error';
      await this.#finish(id, 'failed', null, msg, actor);
      return this.get(id);
    }
    await this.#execute(id, plan, actor);
    return this.get(id);
  }

  async deny(actor: OpsActor, id: string, reason: string | null): Promise<OpsActionView> {
    await this.#expireStale();
    const now = this.deps.clock();
    const res = await this.deps.pool.query<{ project: string; kind: string }>(
      `UPDATE ops_actions SET state = 'denied', decided_by = $2, decided_at = $3, decision_reason = $4, updated_at = $3,
         finished_at = $3
       WHERE id = $1 AND state = 'awaiting_approval' RETURNING project, kind`,
      [id, actor.id, now, reason],
    );
    if (res.rows[0] === undefined) {
      const cur = await this.get(id);
      throw new OpsError(409, 'not_awaiting_approval', `The action is ${cur.state}.`);
    }
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'ops.action.deny',
      target: `ops-action:${id}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { project: res.rows[0].project, kind: res.rows[0].kind, reason },
    });
    return this.get(id);
  }

  // ---------------------------------------------------------------------------------------- executing

  async #finish(
    id: string,
    state: 'deploying' | 'succeeded' | 'failed',
    result: Record<string, unknown> | null,
    error: string | null,
    actor: OpsActor,
  ): Promise<void> {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{
      prev_state: string | null;
      kind: OpsKind;
      project: string;
      env: DeployEnv | null;
      source: Record<string, unknown> | null;
      result: Record<string, unknown> | null;
    }>(
      `WITH prev AS (SELECT state AS prev_state FROM ops_actions WHERE id = $1 FOR UPDATE)
       UPDATE ops_actions SET state = $2::text, result = COALESCE($3::jsonb, result), error = $4::text,
         updated_at = $5::timestamptz,
         finished_at = CASE WHEN $2::text = 'deploying' THEN NULL ELSE $5::timestamptz END
       WHERE id = $1
       RETURNING (SELECT prev_state FROM prev) AS prev_state, kind, project, env, source, result`,
      [id, state, result, error === null ? null : error.slice(0, 1000), now],
    );
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'ops.action.execute',
      target: `ops-action:${id}`,
      outcome: state === 'failed' ? 'failure' : 'success',
      metadata: { state, error: error?.slice(0, 300) ?? null, result },
    });
    if (state === 'failed') await this.#outbox(id, 'failed');
    const row = rows[0];
    if (row !== undefined && state !== 'deploying' && row.prev_state !== state) {
      await this.#chatOutcome(id, state, row, error);
    }
  }

  /**
   * p15-chat-zip: a publish requested in a chat conversation (`source.chatThreadId`, not a bundle step) reports its
   * end there — the live link(s) or the failure with the way on. Never fails the action (the conversation may be gone).
   */
  async #chatOutcome(
    id: string,
    state: 'succeeded' | 'failed',
    row: {
      kind: OpsKind;
      project: string;
      env: DeployEnv | null;
      source: Record<string, unknown> | null;
      result: Record<string, unknown> | null;
    },
    error: string | null,
  ): Promise<void> {
    const thread = row.source?.chatThreadId;
    if (
      this.deps.chatNote === undefined ||
      row.kind !== 'pages.publish' ||
      row.source?.publishBundle !== undefined ||
      typeof thread !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(thread)
    ) {
      return;
    }
    const links = (Array.isArray(row.result?.links) ? row.result.links : []).filter(
      (l): l is string => typeof l === 'string' && /^https:\/\/[^\s]{1,2000}$/.test(l),
    );
    const url = typeof row.result?.url === 'string' ? row.result.url : (links[0] ?? null);
    const domains = links.filter((l) => l !== url);
    const env = row.env === 'production' ? 'production' : 'preview';
    const text =
      state === 'succeeded'
        ? `Published (${env}, ${row.project})${url === null ? '.' : `: ${url}`}${
            domains.length === 0
              ? ''
              : ` — custom domain ${domains.join(', ')} (live once Cloudflare has validated it)`
          } · [Yayını aç](/deploys/${id})`
        : `The publish (${env}, ${row.project}) failed: ${(error ?? 'unknown error').slice(0, 300)} — [Logları gör](/deploys/${id}?logs=build), or ask me “düzeltme işi taslakla”.`;
    try {
      await this.deps.chatNote(thread, text, {
        notice: 'site-publish',
        opsActionId: id,
        state,
        ...(url === null ? {} : { url }),
        ...(domains.length === 0 ? {} : { domains }),
        ...(state === 'failed' ? { fixActionId: id } : {}),
      });
    } catch (err) {
      this.deps.log.debug({ err, id }, 'publish: chat note not posted');
    }
  }

  /** p6-deploy-pipeline: a deploy notification (identifiers only; the producer builds the text). */
  async #outbox(actionId: string, event: 'waiting' | 'failed'): Promise<void> {
    const payload: OpsActionOutboxPayload = { actionId, event };
    await this.deps.pool.query(
      'INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)',
      [OUTBOX_TOPIC_OPS_ACTION, JSON.stringify(payload), this.deps.clock()],
    );
  }

  /**
   * p6-deploy-pipeline: polls the provider for `deploying` actions (oldest poll first, at most `limit` per pass,
   * each at most every `intervalMs`) and records the outcome — run as a step of the orchestrator tick.
   */
  async pollDeploying(limit = 10, intervalMs = 15_000): Promise<number> {
    const now = this.deps.clock();
    // p22-ops-hygiene: an action in backoff (next_poll_at) waits, unless it is past its maximum age — then it is
    // claimed at once so the timeout ends it.
    const { rows } = await this.deps.pool.query<{
      id: string;
      overdue: boolean;
      poll_errors: number;
      poll_not_found: number;
    }>(
      `UPDATE ops_actions SET polled_at = $1
        WHERE id IN (SELECT id FROM ops_actions WHERE state = 'deploying'
                       AND (polled_at IS NULL OR polled_at <= $2)
                       AND (next_poll_at IS NULL OR next_poll_at <= $1
                            OR (kind <> 'pages.add_domain' AND COALESCE(decided_at, created_at) <= $4))
                     ORDER BY polled_at NULLS FIRST LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING id::text AS id, poll_errors, poll_not_found,
                  (kind <> 'pages.add_domain' AND COALESCE(decided_at, created_at) <= $4) AS overdue`,
      [now, new Date(now.getTime() - intervalMs), limit, new Date(now.getTime() - DEPLOYING_MAX_MS)],
    );
    const actor: OpsActor = { type: 'system', id: 'ops-poller' };
    let n = 0;
    for (const r of rows) {
      let failure: unknown = null;
      let state: string | null = null;
      try {
        state = (await this.refresh(actor, r.id)).state;
      } catch (err) {
        failure = err;
      }
      if (failure === null) {
        n++;
        if (r.poll_errors > 0 || r.poll_not_found > 0) {
          await this.deps.pool.query(
            'UPDATE ops_actions SET poll_errors = 0, poll_not_found = 0, next_poll_at = NULL WHERE id = $1',
            [r.id],
          );
        }
        if (state !== 'deploying' || !r.overdue) continue;
      }
      if (r.overdue) {
        // A last look at the provider did not end it: the action has been deploying for too long.
        const why =
          failure === null
            ? ''
            : ` (last status poll: ${(failure instanceof Error ? failure.message : 'error').slice(0, 200)})`;
        this.deps.log.info({ actionId: r.id }, 'deploying action timed out');
        await this.#finish(
          r.id,
          'failed',
          null,
          `Timed out: no outcome ${String(DEPLOYING_MAX_MS / 3_600_000)} hours after the deploy started${why}. Check the deployment in the provider's console, then deploy again.`,
          actor,
        );
        continue;
      }
      if (isNotFound(failure)) {
        const count = r.poll_not_found + 1;
        if (count >= POLL_NOT_FOUND_LIMIT) {
          this.deps.log.info({ actionId: r.id, code: failure.code }, 'deployment not found; action failed');
          await this.#finish(
            r.id,
            'failed',
            null,
            `The provider no longer knows this deployment (${failure.message.slice(0, 200)}; ${String(count)} times in a row). It was removed or never started; deploy again.`,
            actor,
          );
          continue;
        }
        await this.deps.pool.query(
          'UPDATE ops_actions SET poll_not_found = $2, next_poll_at = $3 WHERE id = $1',
          [r.id, count, new Date(now.getTime() + pollBackoffMs(count, intervalMs))],
        );
        continue;
      }
      // Provider down / rate limited: tried again later, backing off (15 s, 30 s, … at most 5 min).
      const errors = r.poll_errors + 1;
      const retryAfter =
        failure instanceof OpsError ? Number.parseInt(failure.headers['retry-after'] ?? '', 10) * 1000 : NaN;
      const wait = Math.max(pollBackoffMs(errors, intervalMs), Number.isFinite(retryAfter) ? retryAfter : 0);
      await this.deps.pool.query(
        'UPDATE ops_actions SET poll_errors = $2, poll_not_found = 0, next_poll_at = $3 WHERE id = $1',
        [r.id, errors, new Date(now.getTime() + Math.min(wait, POLL_BACKOFF_MAX_MS))],
      );
      const fields = {
        actionId: r.id,
        errors,
        err: failure instanceof Error ? failure.message : 'error',
      };
      // One warning when the trouble starts (and every 10th try), debug in between.
      if (errors === 1 || errors % 10 === 0) this.deps.log.warn(fields, 'deploy status poll failed');
      else this.deps.log.debug(fields, 'deploy status poll failed');
    }
    return n;
  }

  async #execute(id: string, plan: Plan, actor: OpsActor): Promise<void> {
    const row = await this.#row(id);
    if (row === null) return;
    // p16-webhooks-out: the start of an execution is its own audited step (the `deploy.started` webhook event).
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'ops.action.start',
      target: `ops-action:${id}`,
      outcome: 'success',
      metadata: { project: row.project, kind: row.kind, env: row.env ?? null, via: row.via },
    });
    try {
      const handler = this.#handler(row.kind);
      const out =
        handler === null
          ? await this.#run(row, plan, actor)
          : await handler.run(
              {
                id: row.id,
                project: row.project,
                kind: row.kind,
                params: row.params,
                target: row.target,
                diff: row.diff,
                via: row.via,
                source: row.source,
                requestedBy: { type: row.requested_by_type, id: row.requested_by_id },
              },
              plan,
              actor,
            );
      await this.#finish(id, out.state, out.result, out.error ?? null, actor);
    } catch (err) {
      const pe = err instanceof ProviderCallError ? err : null;
      const msg =
        pe !== null
          ? providerText(pe, row.kind.startsWith('dns.') ? str(plan.target.zone) : undefined)
          : err instanceof Error
            ? err.message
            : 'execution failed';
      await this.#finish(
        id,
        'failed',
        pe === null
          ? null
          : { provider: pe.provider, status: pe.status, code: pe.code, retryAfterSec: pe.retryAfterSec },
        msg,
        actor,
      );
      if (pe === null && !(err instanceof OpsError))
        this.deps.log.error({ err, actionId: id }, 'ops action failed');
    }
  }

  async #run(
    row: Row,
    plan: Plan,
    actor: OpsActor,
  ): Promise<{
    state: 'deploying' | 'succeeded' | 'failed';
    result: Record<string, unknown>;
    /** Set with `failed`: a partial outcome (e.g. the project was created, the target write was not). */
    error?: string;
  }> {
    const p = row.params;
    switch (row.kind) {
      case 'pages.publish':
        return this.#advancePublish(row, actor);
      case 'pages.create_project': {
        const cf = await this.#cloudflare();
        const name = String(p.name);
        const adopt = plan.diff.action === 'adopt project';
        const proj = adopt
          ? await cf.pagesProject(name)
          : await cf.createPagesProject(name, String(p.productionBranch));
        const projectName = proj.name || name;
        const result: Record<string, unknown> = {
          projectName,
          subdomain: proj.subdomain,
          productionBranch: proj.productionBranch,
          created: !adopt,
          adopted: adopt,
          deployTarget: false,
          links: proj.subdomain === '' ? [] : [`https://${proj.subdomain}`],
        };
        if (p.useAsTarget === true) {
          try {
            result.targetsVersion = await this.#setPagesTarget(row, projectName, actor);
            result.deployTarget = true;
          } catch (err) {
            return {
              state: 'failed',
              result,
              error: `The Pages project ${projectName} was ${adopt ? 'found' : 'created'}, but it could not be set as this project’s target: ${err instanceof Error ? err.message : 'error'}`,
            };
          }
        } else {
          // p10-site-upload: keep it as a further Pages project of this project; the target is not touched.
          try {
            result.targetsVersion = await this.#addPagesProject(row, projectName, actor);
            result.pagesProjectAdded = true;
          } catch (err) {
            return {
              state: 'failed',
              result,
              error: `The Pages project ${projectName} was ${adopt ? 'found' : 'created'}, but it could not be added to this project’s Pages projects: ${err instanceof Error ? err.message : 'error'}`,
            };
          }
        }
        return { state: 'succeeded', result };
      }
      case 'pages.add_domain': {
        const cf = await this.#cloudflare();
        const name = String(plan.target.project);
        const domain = String(plan.target.domain);
        const d =
          plan.diff.attach === 'attach'
            ? await cf.addPagesDomain(name, domain)
            : await cf.pagesDomain(name, domain);
        const result: Record<string, unknown> = { project: name, domain, ...domainView(d) };
        if (plan.withDns === true) {
          const dns = (plan.diff.dns ?? {}) as {
            before?: { id: string } | null;
            after?: { content?: string };
          };
          const rec = {
            type: 'CNAME' as const,
            name: domain,
            content: dns.after?.content ?? '',
            ttl: 1,
            proxied: true,
          };
          const zoneId = String(plan.target.zoneId);
          try {
            const out =
              dns.before === null || dns.before === undefined
                ? await cf.createRecord(zoneId, rec)
                : await cf.updateRecord(zoneId, dns.before.id, rec);
            result.dns = { recordId: out.id, created: dns.before == null, record: rec };
          } catch (err) {
            return {
              state: 'failed',
              result,
              error: `${domain} was attached to ${name}, but the DNS record could not be written: ${err instanceof ProviderCallError ? providerText(err, str(plan.target.zone)) : err instanceof Error ? err.message : 'error'}`,
            };
          }
        }
        const outcome = domainOutcome(d.status);
        return outcome === 'failed'
          ? { state: 'failed', result, error: `Cloudflare reports the domain as ${d.status}.` }
          : { state: outcome === 'active' ? 'succeeded' : 'deploying', result };
      }
      case 'coolify.deploy': {
        const client = (await this.#coolifyOfRow(plan)).client;
        const resources = (plan.target.resources ?? []) as { uuid: string }[];
        // What runs now (for "Roll back"): best effort — older Coolify versions lack the endpoint.
        const previousImages: { uuid: string; image: string | null }[] = [];
        for (const r of resources) {
          const image = await client.currentImage(r.uuid).catch(() => null);
          previousImages.push({ uuid: r.uuid, image });
        }
        const deployments = await client.deploy(
          resources.map((r) => r.uuid),
          p.force === true,
        );
        return {
          state: 'deploying',
          result: { deployments, previousImages },
        };
      }
      case 'coolify.restart': {
        const client = (await this.#coolifyOfRow(plan)).client;
        const out: { uuid: string; deploymentUuid: string | null; message: string }[] = [];
        for (const r of (plan.target.resources ?? []) as { uuid: string }[]) {
          out.push({ uuid: r.uuid, ...(await client.restart(r.uuid)) });
        }
        const ids = out.map((o) => o.deploymentUuid).filter((x): x is string => x !== null);
        return {
          state: ids.length > 0 ? 'deploying' : 'succeeded',
          result: { restarts: out, deployments: ids.map((d) => ({ deploymentUuid: d })) },
        };
      }
      case 'coolify.rollback': {
        const client = (await this.#coolifyOfRow(plan)).client;
        const out: { uuid: string; image: string; deploymentUuid: string | null }[] = [];
        for (const r of (Array.isArray(p.resources) ? p.resources : []) as {
          uuid: string;
          image: string;
        }[]) {
          out.push({ uuid: r.uuid, image: r.image, ...(await client.rollback(r.uuid, r.image)) });
        }
        const ids = out.map((o) => o.deploymentUuid).filter((x): x is string => x !== null);
        return {
          state: ids.length > 0 ? 'deploying' : 'succeeded',
          result: { rollbacks: out, deployments: ids.map((d) => ({ deploymentUuid: d })) },
        };
      }
      case 'pages.deploy': {
        const cf = await this.#cloudflare();
        const name = String(plan.target.project);
        let previousDeploymentId: string | null = null;
        if (plan.env === 'production') {
          const list = await cf.pagesDeployments(name, 'production').catch(() => []);
          previousDeploymentId = list[0]?.id ?? null;
        }
        const d = await cf.pagesDirectUpload(name, plan.files ?? [], {
          branch: String(plan.target.branch),
          commitMessage: `Remyral ops action ${row.id}`,
        });
        if (typeof p.uploadId === 'string') {
          // p10-site-upload: retention keeps deployed uploads (newest per project).
          await this.deps.siteUploads?.()?.markDeployed(p.uploadId, row.id);
        }
        return {
          state: 'deploying',
          result: {
            deploymentId: d.id,
            url: d.url,
            environment: d.environment,
            previousDeploymentId,
            links: d.url === '' ? [] : [d.url],
          },
        };
      }
      case 'pages.rollback': {
        const cf = await this.#cloudflare();
        const d = await cf.pagesRollback(String(p.projectName), String(p.deploymentId));
        return { state: 'succeeded', result: { deploymentId: d.id || String(p.deploymentId), url: d.url } };
      }
      case 'dns.upsert': {
        const cf = await this.#cloudflare();
        const zoneId = String(plan.target.zoneId);
        const before = (plan.diff.before ?? null) as { id: string } | null;
        const rec = {
          type: p.type as 'A',
          name: String(p.name),
          content: String(p.content),
          ttl: Number(p.ttl),
          proxied: p.proxied === true,
        };
        const out =
          before === null
            ? await cf.createRecord(zoneId, rec)
            : await cf.updateRecord(zoneId, before.id, rec);
        return {
          state: 'succeeded',
          result: { recordId: out.id, record: { ...rec }, created: before === null },
        };
      }
      case 'dns.delete': {
        const cf = await this.#cloudflare();
        const before = plan.diff.before as { id: string };
        await cf.deleteRecord(String(plan.target.zoneId), before.id);
        return { state: 'succeeded', result: { recordId: before.id, deleted: true } };
      }
      default:
        throw new OpsError(400, 'unknown_kind', `No executor for ${row.kind}.`);
    }
  }

  // ------------------------------------------------------------------------------------ status, logs

  /** Polls the provider for an action in `deploying` and records the outcome. */
  async refresh(actor: OpsActor, id: string): Promise<OpsActionView> {
    const row = await this.#row(id);
    if (row === null) throw new OpsError(404, 'action_not_found', 'Ops action not found.');
    if (row.state !== 'deploying') return this.#view(row);
    const result = row.result ?? {};
    if (row.kind.startsWith('coolify.')) {
      // p13-multi-coolify: polling finishes on the connection the action ran on.
      const client = (await this.#coolifyOfRow(row)).client;
      const ids = ((result.deployments ?? []) as { deploymentUuid?: string }[])
        .map((d) => d.deploymentUuid)
        .filter((x): x is string => typeof x === 'string' && x !== '');
      const statuses: { deploymentUuid: string; status: string; commit: string | null }[] = [];
      for (const d of ids) {
        const dep = await this.#provider(() => client.deployment(d));
        statuses.push({ deploymentUuid: d, status: dep.status, commit: dep.commit });
      }
      const outcomes = statuses.map((s) => coolifyOutcome(s.status));
      const next = outcomes.includes('failed')
        ? 'failed'
        : outcomes.every((o) => o === 'succeeded')
          ? 'succeeded'
          : 'deploying';
      if (next === 'deploying') {
        await this.deps.pool.query('UPDATE ops_actions SET result = $2, updated_at = $3 WHERE id = $1', [
          id,
          { ...result, statuses },
          this.deps.clock(),
        ]);
      } else {
        await this.#finish(
          id,
          next,
          { ...result, statuses },
          next === 'failed' ? 'A Coolify deployment failed.' : null,
          actor,
        );
      }
    } else if (row.kind === 'pages.add_domain') {
      // p6-pages-create: domain validation status read-back until active / failed / 24 h pending.
      const cf = await this.#cloudflare();
      const d = await this.#provider(() =>
        cf.pagesDomain(String(row.target.project), String(row.target.domain)),
      );
      const merged = { ...result, ...domainView(d) };
      const outcome = domainOutcome(d.status);
      const tooLong = this.deps.clock().getTime() - row.created_at.getTime() > PAGES_DOMAIN_PENDING_MS;
      if (outcome === 'active') await this.#finish(id, 'succeeded', merged, null, actor);
      else if (outcome === 'failed')
        await this.#finish(id, 'failed', merged, `Cloudflare reports the domain as ${d.status}.`, actor);
      else if (tooLong)
        await this.#finish(
          id,
          'failed',
          merged,
          `The domain is still ${d.status || 'pending'} after 24 hours; check its DNS record and validation in Cloudflare.`,
          actor,
        );
      else
        await this.deps.pool.query('UPDATE ops_actions SET result = $2, updated_at = $3 WHERE id = $1', [
          id,
          merged,
          this.deps.clock(),
        ]);
    } else if (row.kind === 'pages.publish') {
      // p10-publish-bundle: move the chain on (the next step, or the outcome).
      const out = await this.#advancePublish(row, actor);
      if (out.state === 'deploying') {
        await this.deps.pool.query('UPDATE ops_actions SET result = $2, updated_at = $3 WHERE id = $1', [
          id,
          out.result,
          this.deps.clock(),
        ]);
      } else {
        await this.#finish(id, out.state, out.result, out.error ?? null, actor);
      }
    } else if (row.kind === 'pages.deploy') {
      const cf = await this.#cloudflare();
      const d = await this.#provider(() =>
        cf.pagesDeployment(String(row.target.project), String(result.deploymentId)),
      );
      const done = d.stage === 'deploy' && d.stageStatus === 'success';
      const failed = d.stageStatus === 'failure' || d.stageStatus === 'canceled';
      const merged = { ...result, stage: d.stage, stageStatus: d.stageStatus, url: d.url || result.url };
      if (done || failed)
        await this.#finish(
          id,
          done ? 'succeeded' : 'failed',
          merged,
          failed ? 'The Pages deployment failed.' : null,
          actor,
        );
      else
        await this.deps.pool.query('UPDATE ops_actions SET result = $2, updated_at = $3 WHERE id = $1', [
          id,
          merged,
          this.deps.clock(),
        ]);
    }
    return this.get(id);
  }

  /** Coolify deployment logs (redacted, capped). Kept for the old response shape; see {@link buildLogs}. */
  async logs(id: string): Promise<{ deploymentUuid: string; logs: string }[]> {
    return (await this.buildLogs(id)).items;
  }

  /**
   * p12-deploy-feedback: the build side of an action — Coolify deployment logs (hidden lines dropped), or the Pages
   * deployment's stages and build log. Redacted with the shared redactor and capped (tail kept).
   */
  async buildLogs(id: string): Promise<{
    readonly provider: 'coolify' | 'cloudflare' | null;
    readonly items: { deploymentUuid: string; logs: string }[];
    readonly sources: DeployLogSource[];
  }> {
    const row = await this.#row(id);
    if (row === null) throw new OpsError(404, 'action_not_found', 'Ops action not found.');
    if (row.kind.startsWith('coolify.')) {
      // p13-multi-coolify: the action's connection, still allowed for the project.
      const conn = await this.#coolifyOfRow(row);
      if (!(await this.deps.integrations.coolifyConnections.mayUse(conn.id, row.project))) {
        throw new OpsError(
          403,
          'coolify_connection_not_allowed',
          `Project ${row.project} may not use the Coolify connection “${conn.label}” any more; its logs are not read.`,
        );
      }
      const client = conn.client;
      const ids = ((row.result?.deployments ?? []) as { deploymentUuid?: string }[])
        .map((d) => d.deploymentUuid)
        .filter((x): x is string => typeof x === 'string' && x !== '');
      const items: { deploymentUuid: string; logs: string }[] = [];
      const sources: DeployLogSource[] = [];
      for (const d of ids.slice(0, 10)) {
        const dep = await this.#provider(() => client.deployment(d));
        const capped = this.#clean(coolifyLogText(dep.logs ?? ''));
        items.push({ deploymentUuid: d, logs: capped.text });
        sources.push({
          id: d,
          label: `Coolify «${conn.label}» deployment ${d}${dep.applicationName === null ? '' : ` (${dep.applicationName})`} — ${dep.status || 'unknown'}`,
          status: dep.status || null,
          text: capped.text,
          truncated: capped.truncated,
        });
      }
      return { provider: 'coolify', items, sources };
    }
    if (row.kind === 'pages.deploy' || row.kind === 'pages.rollback') {
      const depId =
        typeof row.result?.deploymentId === 'string'
          ? row.result.deploymentId
          : typeof row.result?.id === 'string'
            ? row.result.id
            : null;
      const project = typeof row.target.project === 'string' ? row.target.project : null;
      if (depId === null || project === null) return { provider: 'cloudflare', items: [], sources: [] };
      const cf = await this.#cloudflare();
      const detail = await this.#provider(() => cf.pagesDeploymentStages(project, depId));
      let logText: string;
      try {
        const l = await this.#provider(() => cf.pagesDeploymentLogs(project, depId));
        logText = l.lines.map((x) => `${x.ts} ${x.line}`.trim()).join('\n');
      } catch (err) {
        // Direct Upload deployments may have no build log; the stages still tell.
        if (!(err instanceof OpsError)) throw err;
        logText = `(no build log: ${err.message.slice(0, 200)})`;
      }
      const stages = detail.stages
        .map((s) => `${s.name}: ${s.status}${s.endedOn === null ? '' : ` (${s.endedOn})`}`)
        .join('\n');
      const capped = this.#clean(
        `Stages\n${stages || '(none reported)'}\n\nBuild log\n${logText || '(empty)'}`,
      );
      const failed = detail.stages.find((s) => s.status === 'failure' || s.status === 'canceled');
      return {
        provider: 'cloudflare',
        items: [],
        sources: [
          {
            id: depId,
            label: `Pages deployment ${depId} (${project})`,
            status:
              failed === undefined
                ? (detail.stages.at(-1)?.status ?? null)
                : `${failed.name}: ${failed.status}`,
            text: capped.text,
            truncated: capped.truncated,
          },
        ],
      };
    }
    return { provider: null, items: [], sources: [] };
  }

  /**
   * p12-deploy-feedback: runtime logs of the project's Coolify applications (`GET /applications/{uuid}/logs`). Only
   * resources the project's deploy targets resolve to NOW for `env` (the control-plane deny-list re-checked), optionally
   * narrowed to `uuids` (an action's resources — a uuid outside the current target is refused). `since` keeps lines
   * whose leading timestamp is at or after it.
   */
  async runtimeLogs(
    project: string,
    q: {
      readonly env: DeployEnv;
      readonly uuids?: readonly string[] | undefined;
      readonly lines?: number | undefined;
      readonly since?: Date | null | undefined;
      readonly maxChars?: number | undefined;
    },
  ): Promise<DeployLogSource[]> {
    const t = await this.targets(project);
    const target = t?.targets.coolify?.[q.env] ?? null;
    if (target === null || (target.uuids.length === 0 && target.tags.length === 0)) {
      throw new OpsError(
        409,
        'no_coolify_target',
        `No Coolify ${q.env} target is configured for this project.`,
      );
    }
    const conn = await this.#coolifyFor(project, target.connection);
    const client = conn.client;
    const { apps, refusal } = await this.#resolveApps(conn, target.uuids, target.tags);
    if (refusal !== null) throw new OpsError(409, 'refused', refusal);
    let wanted = apps;
    if (q.uuids !== undefined) {
      const outside = q.uuids.filter((u) => !apps.some((a) => a.uuid === u));
      if (outside.length > 0) {
        throw new OpsError(
          409,
          'not_project_resource',
          `Coolify resource ${outside[0] ?? ''} is not part of this project's ${q.env} target any more; its logs are not read.`,
        );
      }
      wanted = apps.filter((a) => q.uuids?.includes(a.uuid) === true);
    }
    const lines = Math.max(10, Math.min(q.lines ?? 300, 2000));
    const out: DeployLogSource[] = [];
    for (const a of wanted.slice(0, 10)) {
      let raw: string;
      try {
        raw = await this.#provider(() => client.applicationLogs(a.uuid, lines));
      } catch (err) {
        if (err instanceof OpsError && err.code === 'coolify_not_found') {
          out.push({
            id: a.uuid,
            label: `${a.name} (${a.uuid})`,
            status: a.status || null,
            text: '(no running container — Coolify has no runtime logs for it)',
            truncated: false,
          });
          continue;
        }
        throw err;
      }
      const capped = this.#clean(sinceFilter(raw, q.since ?? null), q.maxChars);
      out.push({
        id: a.uuid,
        label: `${a.name} (${a.uuid})`,
        status: a.status || null,
        text: capped.text,
        truncated: capped.truncated,
      });
    }
    return out;
  }

  /** Redacted, tail-capped text. */
  #clean(text: string, maxChars = LOG_CAP_CHARS): { text: string; truncated: boolean } {
    const clean = this.#redactor.redact(text);
    return clean.length > maxChars
      ? { text: clean.slice(clean.length - maxChars), truncated: true }
      : { text: clean, truncated: false };
  }

  // -------------------------------------------------------------------------------------- rollback

  /** The request that undoes a succeeded action, or null when it has none. */
  #rollbackRequest(
    row: Row,
  ): { kind: OpsKind; params: Record<string, unknown>; rollbackOfDelete?: boolean } | null {
    if (row.state !== 'succeeded') return null;
    const r = row.result ?? {};
    switch (row.kind) {
      case 'coolify.deploy': {
        const imgs = ((r.previousImages ?? []) as { uuid: string; image: string | null }[]).filter(
          (i): i is { uuid: string; image: string } => typeof i.image === 'string' && i.image !== '',
        );
        if (imgs.length === 0) return null;
        const connection = connectionIdOf(row.target);
        return {
          kind: 'coolify.rollback',
          params: {
            env: row.env ?? 'preview',
            resources: imgs,
            ...(connection === null ? {} : { connection }),
          },
        };
      }
      case 'pages.deploy':
        if (typeof r.previousDeploymentId !== 'string' || r.previousDeploymentId === '') return null;
        return {
          kind: 'pages.rollback',
          params: { projectName: row.target.project, deploymentId: r.previousDeploymentId },
        };
      case 'dns.upsert': {
        const before = (row.previous?.before ?? null) as {
          type: string;
          name: string;
          content: string;
          ttl: number;
          proxied: boolean;
        } | null;
        const p = row.params;
        if (before === null)
          return { kind: 'dns.delete', params: { zone: p.zone, type: p.type, name: p.name } };
        return {
          kind: 'dns.upsert',
          params: {
            zone: p.zone,
            type: before.type,
            name: before.name,
            content: before.content,
            ttl: before.ttl,
            proxied: before.proxied,
          },
        };
      }
      case 'dns.delete': {
        const before = (row.previous?.before ?? null) as {
          type: string;
          name: string;
          content: string;
          ttl: number;
          proxied: boolean;
        } | null;
        if (before === null) return null;
        return {
          kind: 'dns.upsert',
          params: {
            zone: row.params.zone,
            type: before.type,
            name: before.name,
            content: before.content,
            ttl: before.ttl,
            proxied: before.proxied,
          },
          rollbackOfDelete: true,
        };
      }
      default:
        return null;
    }
  }

  async rollback(
    actor: OpsActor,
    id: string,
    idempotencyKey: string,
    via: OpsVia,
    /** p10-verify-health: the post-deploy health check that asked (auto-rollback). */
    source?: Record<string, unknown>,
  ): Promise<{ action: OpsActionView; created: boolean }> {
    const row = await this.#row(id);
    if (row === null) throw new OpsError(404, 'action_not_found', 'Ops action not found.');
    const rb = this.#rollbackRequest(row);
    if (rb === null) throw new OpsError(409, 'rollback_unavailable', 'This action has no rollback.');
    return this.request(
      actor,
      {
        project: row.project,
        kind: rb.kind,
        params: rb.params,
        idempotencyKey,
        note: `Rollback of ${row.id}`,
      },
      via,
      {
        rollbackOf: row.id,
        kindOverride: rb.kind,
        ...(rb.rollbackOfDelete === undefined ? {} : { rollbackOfDelete: rb.rollbackOfDelete }),
        ...(source === undefined ? {} : { source }),
      },
    );
  }

  // ------------------------------------------------------------------------------------------- reads

  async #row(id: string): Promise<Row | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.deps.pool.query<Row>(`SELECT ${COLS} FROM ops_actions a WHERE a.id = $1`, [
      id,
    ]);
    return rows[0] ?? null;
  }

  #view(r: Row): OpsActionView {
    return {
      id: r.id,
      project: r.project,
      kind: r.kind,
      env: r.env,
      params: r.params,
      target: Object.fromEntries(Object.entries(r.target).filter(([k]) => k !== 'planKey')),
      diff: r.diff,
      policy: { decision: r.policy_decision, reason: r.policy_reason },
      state: r.state,
      requestedBy: { type: r.requested_by_type, id: r.requested_by_id, username: r.requester },
      via: r.via,
      source: r.source,
      note: r.note,
      rollbackOf: r.rollback_of,
      rollbackAvailable: this.#rollbackRequest(r) !== null,
      decidedBy: r.decided_by === null ? null : { id: r.decided_by, username: r.decider },
      decidedAt: r.decided_at?.toISOString() ?? null,
      decisionReason: r.decision_reason,
      result: r.result,
      error: r.error,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      expiresAt: r.expires_at?.toISOString() ?? null,
      finishedAt: r.finished_at?.toISOString() ?? null,
    };
  }

  async get(id: string): Promise<OpsActionView> {
    const r = await this.#row(id);
    if (r === null) throw new OpsError(404, 'action_not_found', 'Ops action not found.');
    return this.#view(r);
  }

  async projectOf(id: string): Promise<string | null> {
    return (await this.#row(id))?.project ?? null;
  }

  async list(
    visible: readonly string[] | null,
    q: { project?: string | undefined; state?: OpsState | undefined; limit?: number | undefined },
  ): Promise<OpsActionView[]> {
    return (await this.listPage(visible, q)).items;
  }

  /** p9-pagination: ops actions newest first by `(created_at, id)`, keyset-paged. */
  async listPage(
    visible: readonly string[] | null,
    q: {
      project?: string | undefined;
      state?: OpsState | undefined;
      limit?: number | undefined;
      cursor?: string | undefined;
    },
  ): Promise<{ items: OpsActionView[]; nextCursor: string | null }> {
    const after = q.cursor === undefined ? null : decodeKeyset(OPS_SCOPE, q.cursor, 'uuid');
    await this.#expireStale();
    const where: string[] = [];
    const args: unknown[] = [];
    if (visible !== null) {
      args.push(visible);
      where.push(`a.project = ANY($${String(args.length)})`);
    }
    if (q.project !== undefined) {
      args.push(q.project);
      where.push(`a.project = $${String(args.length)}`);
    }
    if (q.state !== undefined) {
      args.push(q.state);
      where.push(`a.state = $${String(args.length)}`);
    }
    if (after !== null) {
      args.push(after.k, after.id);
      where.push(
        `(a.created_at, a.id) < ($${String(args.length - 1)}::timestamptz, $${String(args.length)}::uuid)`,
      );
    }
    const limit = clampLimit(q.limit, 50, 200);
    args.push(limit + 1);
    const { rows } = await this.deps.pool.query<Row & { page_key: string }>(
      `SELECT ${COLS}, to_json(a.created_at) #>> '{}' AS page_key
         FROM ops_actions a ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
        ORDER BY a.created_at DESC, a.id DESC LIMIT $${String(args.length)}`,
      args,
    );
    return keysetPage(
      rows,
      limit,
      OPS_SCOPE,
      (r) => ({ k: r.page_key, id: r.id }),
      (r) => this.#view(r),
    );
  }
}
