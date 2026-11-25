import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p6-deploy-integrations (ADR-0028; apps/master/src/ops/routes.ts): Coolify / Cloudflare connections held by the
 * master, project deploy targets and ops actions (deploys, restarts, Pages deploys, DNS changes, rollbacks).
 * Tokens are write-only: no response carries one, and the browser only ever sends a token the admin types in.
 */

type Opts = Omit<RequestOptions, 'body'>;
type Json = Record<string, unknown>;

export type OpsProvider = 'coolify' | 'cloudflare';

export interface OpsIntegration {
  readonly provider: OpsProvider;
  readonly settings: Json;
  readonly keyFingerprint: string;
  readonly usable: boolean;
  readonly lastTest: Json | null;
  readonly lastTestAt: string | null;
  readonly updatedAt: string;
}

export interface OpsIntegrationsStatus {
  readonly coolify: OpsIntegration | null;
  readonly cloudflare: OpsIntegration | null;
  readonly controlPlaneResources: readonly string[];
  readonly protectedHosts: readonly string[];
}

export type DecisionRule = 'auto' | 'approval' | 'approval_step_up';

export interface CoolifyEnvTarget {
  /** p13-multi-coolify: the Coolify connection of this environment (null: the default connection). */
  readonly connection: string | null;
  readonly uuids: readonly string[];
  readonly tags: readonly string[];
}

export interface DeployTargets {
  readonly coolify: {
    readonly preview: CoolifyEnvTarget | null;
    readonly production: CoolifyEnvTarget | null;
  } | null;
  readonly pages: { readonly projectName: string } | null;
  /** p10-site-upload: further Pages projects of this project (deployable by name; the target stays). */
  readonly pagesProjects: readonly string[];
  readonly dns: {
    readonly zones: readonly { readonly id: string; readonly name: string }[];
    readonly protectedNames: readonly string[];
  };
  readonly policy: {
    readonly previewDeploy: DecisionRule;
    readonly productionDeploy: 'approval' | 'approval_step_up';
    /**
     * p10-publish-bundle: `auto` ("Run at once") covers only creating / updating CNAME records that point at one of
     * this project's own Pages projects (pages.dev) inside the allowed zones; everything else keeps its level.
     */
    readonly dnsChange: DecisionRule;
    /** p6-deploy-on-success (ADR-0030): jobs may deploy to production automatically when they succeed. */
    readonly autoDeployProductionOnSuccess: boolean;
    /** p6-pages-create: creating a Pages project / attaching a domain. Default approval. */
    readonly pagesProject: DecisionRule;
    /** p8-preview-tunnels: job-bound preview links. Default auto. */
    readonly previewTunnel: DecisionRule;
    /** p8-preview-tunnels: stable preview links (fixed hostname, e.g. an APK backend). Default approval. */
    readonly stableTunnel: DecisionRule;
  };
  /** p8-preview-tunnels: where preview links live and who may open them (null: previews off). */
  readonly previews: PreviewTargets | null;
}

export interface PreviewTargets {
  readonly zone: { readonly id: string; readonly name: string } | null;
  readonly prefix: string | null;
  readonly agentsMayOpen: boolean;
  readonly accessEmails: readonly string[];
  readonly maxActive: number;
  readonly maxPerJob: number;
}

export interface ProjectDeployTargets {
  readonly project: string;
  readonly targets: DeployTargets | null;
  readonly version: number | null;
  readonly updatedAt: string | null;
}

export const OPS_STATES = [
  'awaiting_approval',
  'refused',
  'denied',
  'expired',
  'executing',
  'deploying',
  'succeeded',
  'failed',
] as const;
export type OpsState = (typeof OPS_STATES)[number];

export type RequestableKind =
  | 'coolify.deploy'
  | 'coolify.restart'
  | 'pages.deploy'
  | 'dns.upsert'
  | 'dns.delete'
  | 'pages.create_project'
  | 'pages.add_domain'
  // p10-publish-bundle: create the Pages project if missing → deploy → attach a domain → its CNAME, one approval.
  | 'pages.publish';

/** p10-publish-bundle: the extra fields of a publish bundle (pages.publish / deployOnSuccess). */
export interface PublishOptions {
  readonly pagesProject?: string;
  readonly createIfMissing?: boolean;
  readonly domain?: string;
  readonly dns?: 'auto' | 'skip';
}

/** p10-publish-bundle: a host name the master accepts as a custom domain (lower-case labels, at least one dot). */
export const DOMAIN_NAME =
  /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** p6-pages-create: Cloudflare's project name rule plus Remyral's (1–58, letter/digit at both ends). */
export const PAGES_PROJECT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;

export interface OpsAction {
  readonly id: string;
  readonly project: string;
  readonly kind: string;
  readonly env: 'preview' | 'production' | null;
  readonly params: Json;
  readonly target: Json;
  readonly diff: Json;
  readonly policy: { readonly decision: string; readonly reason: string };
  readonly state: string;
  readonly requestedBy: { readonly type: string; readonly id: string; readonly username: string | null };
  readonly via: string;
  /** p6-deploy-pipeline: the automation run or workflow step that asked (null: a person or the chat). */
  readonly source: Json | null;
  readonly note: string | null;
  readonly rollbackOf: string | null;
  readonly rollbackAvailable: boolean;
  readonly decidedBy: { readonly id: string; readonly username: string | null } | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly result: Json | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly finishedAt: string | null;
}

function bool(o: Json, key: string): boolean {
  if (typeof o[key] !== 'boolean') throw new ShapeError(`expected boolean ${key}`);
  return o[key];
}

function json(v: unknown): Json {
  return obj(v);
}

function nullableJson(v: unknown): Json | null {
  return v === null || v === undefined ? null : obj(v);
}

function parseIntegration(v: unknown): OpsIntegration | null {
  if (v === null) return null;
  const o = obj(v);
  const provider = str(o, 'provider');
  if (provider !== 'coolify' && provider !== 'cloudflare') throw new ShapeError('provider');
  return {
    provider,
    settings: json(o.settings),
    keyFingerprint: str(o, 'keyFingerprint'),
    usable: bool(o, 'usable'),
    lastTest: nullableJson(o.lastTest),
    lastTestAt: nullableStr(o, 'lastTestAt'),
    updatedAt: str(o, 'updatedAt'),
  };
}

export function parseIntegrationsStatus(v: unknown): OpsIntegrationsStatus {
  const o = obj(v);
  return {
    coolify: parseIntegration(o.coolify),
    cloudflare: parseIntegration(o.cloudflare),
    controlPlaneResources: strArray(o, 'controlPlaneResources'),
    protectedHosts: strArray(o, 'protectedHosts'),
  };
}

function rule(v: unknown, fallback: DecisionRule): DecisionRule {
  return v === 'auto' || v === 'approval' || v === 'approval_step_up' ? v : fallback;
}

function previewTargets(v: unknown): PreviewTargets | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const zone = o.zone === null || o.zone === undefined ? null : obj(o.zone);
  return {
    zone: zone === null ? null : { id: str(zone, 'id'), name: str(zone, 'name') },
    prefix: typeof o.prefix === 'string' && o.prefix !== '' ? o.prefix : null,
    agentsMayOpen: o.agentsMayOpen !== false,
    accessEmails: Array.isArray(o.accessEmails)
      ? o.accessEmails.filter((e): e is string => typeof e === 'string')
      : [],
    maxActive: typeof o.maxActive === 'number' ? o.maxActive : 5,
    maxPerJob: typeof o.maxPerJob === 'number' ? o.maxPerJob : 3,
  };
}

function envTarget(v: unknown): CoolifyEnvTarget | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return {
    connection: typeof o.connection === 'string' ? o.connection : null,
    uuids: strArray(o, 'uuids'),
    tags: strArray(o, 'tags'),
  };
}

export function parseTargets(v: unknown): DeployTargets {
  const o = obj(v);
  const c = o.coolify === null || o.coolify === undefined ? null : obj(o.coolify);
  const pages = o.pages === null || o.pages === undefined ? null : obj(o.pages);
  const dns = obj(o.dns);
  const policy = obj(o.policy);
  const zones = dns.zones;
  if (!Array.isArray(zones)) throw new ShapeError('zones');
  return {
    coolify: c === null ? null : { preview: envTarget(c.preview), production: envTarget(c.production) },
    pages: pages === null ? null : { projectName: str(pages, 'projectName') },
    pagesProjects: Array.isArray(o.pagesProjects) ? strArray(o, 'pagesProjects') : [],
    dns: {
      zones: zones.map((z) => ({ id: str(obj(z), 'id'), name: str(obj(z), 'name') })),
      protectedNames: strArray(dns, 'protectedNames'),
    },
    policy: {
      previewDeploy: str(policy, 'previewDeploy') as DecisionRule,
      productionDeploy: str(policy, 'productionDeploy') as 'approval' | 'approval_step_up',
      dnsChange: rule(policy.dnsChange, 'approval'),
      autoDeployProductionOnSuccess: policy.autoDeployProductionOnSuccess === true,
      pagesProject:
        policy.pagesProject === 'auto' || policy.pagesProject === 'approval_step_up'
          ? policy.pagesProject
          : 'approval',
      previewTunnel: rule(policy.previewTunnel, 'auto'),
      stableTunnel: rule(policy.stableTunnel, 'approval'),
    },
    previews: previewTargets(o.previews),
  };
}

function parseProjectTargets(v: unknown): ProjectDeployTargets {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    targets: o.targets === null ? null : parseTargets(o.targets),
    version: typeof o.version === 'number' ? o.version : null,
    updatedAt: nullableStr(o, 'updatedAt'),
  };
}

export function parseAction(v: unknown): OpsAction {
  const o = obj(v);
  const env = o.env;
  const policy = obj(o.policy);
  const rb = obj(o.requestedBy);
  const decided = o.decidedBy === null ? null : obj(o.decidedBy);
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    kind: str(o, 'kind'),
    env: env === 'preview' || env === 'production' ? env : null,
    params: json(o.params),
    target: json(o.target),
    diff: json(o.diff),
    policy: { decision: str(policy, 'decision'), reason: str(policy, 'reason') },
    state: str(o, 'state'),
    requestedBy: { type: str(rb, 'type'), id: str(rb, 'id'), username: nullableStr(rb, 'username') },
    via: str(o, 'via'),
    source: o.source === null || o.source === undefined ? null : json(o.source),
    note: nullableStr(o, 'note'),
    rollbackOf: nullableStr(o, 'rollbackOf'),
    rollbackAvailable: bool(o, 'rollbackAvailable'),
    decidedBy:
      decided === null ? null : { id: str(decided, 'id'), username: nullableStr(decided, 'username') },
    decidedAt: nullableStr(o, 'decidedAt'),
    decisionReason: nullableStr(o, 'decisionReason'),
    result: nullableJson(o.result),
    error: nullableStr(o, 'error'),
    createdAt: str(o, 'createdAt'),
    updatedAt: str(o, 'updatedAt'),
    expiresAt: nullableStr(o, 'expiresAt'),
    finishedAt: nullableStr(o, 'finishedAt'),
  };
}

/** A fresh client-side idempotency key (the master accepts `[A-Za-z0-9_.:-]{8,128}`). */
export function idempotencyKey(prefix = 'web'): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rand}`;
}

// ------------------------------------------------------------------------------ integrations

export function getOpsIntegrations(opts: Opts = {}): Promise<OpsIntegrationsStatus> {
  return apiRequest('GET', '/integrations/ops', parseIntegrationsStatus, opts);
}

export function saveCoolify(
  body: {
    readonly url: string;
    readonly team: string | null;
    readonly denyResources: readonly string[];
    readonly token?: string;
  },
  opts: Opts = {},
): Promise<OpsIntegration | null> {
  return apiRequest('PUT', '/integrations/ops/coolify', parseIntegration, { ...opts, body });
}

export function saveCloudflare(
  body: { readonly accountId: string; readonly token?: string },
  opts: Opts = {},
): Promise<OpsIntegration | null> {
  return apiRequest('PUT', '/integrations/ops/cloudflare', parseIntegration, { ...opts, body });
}

export function removeOpsIntegration(provider: OpsProvider, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/integrations/ops/${provider}`, () => undefined, opts);
}

export function testOpsIntegration(provider: OpsProvider, opts: Opts = {}): Promise<Json> {
  return apiRequest('POST', `/integrations/ops/${provider}/test`, json, opts);
}

// ------------------------------------------------------------------------------ targets

export function getDeployTargets(project: string, opts: Opts = {}): Promise<ProjectDeployTargets> {
  return apiRequest(
    'GET',
    `/projects/${encodeURIComponent(project)}/deploy-targets`,
    parseProjectTargets,
    opts,
  );
}

export function putDeployTargets(
  project: string,
  targets: DeployTargets,
  expectedVersion: number | null,
  opts: Opts = {},
): Promise<ProjectDeployTargets> {
  return apiRequest('PUT', `/projects/${encodeURIComponent(project)}/deploy-targets`, parseProjectTargets, {
    ...opts,
    body: { targets, ...(expectedVersion === null ? {} : { expectedVersion }) },
  });
}

// ------------------------------------------------------------------------------ actions

export function listOpsActions(
  q: { readonly project?: string; readonly state?: OpsState; readonly limit?: number } = {},
  opts: Opts = {},
): Promise<OpsAction[]> {
  return listOpsActionsPage({ ...q, cursor: null }, opts).then((p) => p.items);
}

/** p9-pagination: one keyset page of ops actions, newest first. */
export function listOpsActionsPage(
  q: {
    readonly project?: string;
    readonly state?: OpsState;
    readonly limit?: number;
    readonly cursor: string | null;
  },
  opts: Opts = {},
): Promise<{ items: OpsAction[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (q.project !== undefined) params.set('project', q.project);
  if (q.state !== undefined) params.set('state', q.state);
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  if (q.cursor !== null) params.set('cursor', q.cursor);
  const qs = params.toString();
  return apiRequest(
    'GET',
    `/deploy/actions${qs === '' ? '' : `?${qs}`}`,
    (v) => {
      const o = obj(v);
      const items = o.items;
      if (!Array.isArray(items)) throw new ShapeError('items');
      return {
        items: items.map(parseAction),
        nextCursor: typeof o.nextCursor === 'string' ? o.nextCursor : null,
      };
    },
    opts,
  );
}

export function getOpsAction(id: string, opts: Opts = {}): Promise<OpsAction> {
  return apiRequest('GET', `/deploy/actions/${encodeURIComponent(id)}`, parseAction, opts);
}

export function requestOpsAction(
  body: {
    readonly project: string;
    readonly kind: RequestableKind;
    readonly params: Json;
    readonly idempotencyKey: string;
    readonly note?: string;
  },
  opts: Opts = {},
): Promise<OpsAction> {
  return apiRequest('POST', '/deploy/actions', parseAction, { ...opts, body });
}

export function previewOpsAction(
  body: { readonly project: string; readonly kind: RequestableKind; readonly params: Json },
  opts: Opts = {},
): Promise<Json> {
  return apiRequest('POST', '/deploy/actions/preview', json, { ...opts, body });
}

export function approveOpsAction(id: string, reason?: string, opts: Opts = {}): Promise<OpsAction> {
  return apiRequest('POST', `/deploy/actions/${encodeURIComponent(id)}/approve`, parseAction, {
    ...opts,
    body: reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() },
  });
}

export function denyOpsAction(id: string, reason?: string, opts: Opts = {}): Promise<OpsAction> {
  return apiRequest('POST', `/deploy/actions/${encodeURIComponent(id)}/deny`, parseAction, {
    ...opts,
    body: reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() },
  });
}

export function rollbackOpsAction(id: string, key: string, opts: Opts = {}): Promise<OpsAction> {
  return apiRequest('POST', `/deploy/actions/${encodeURIComponent(id)}/rollback`, parseAction, {
    ...opts,
    body: { idempotencyKey: key },
  });
}

export function refreshOpsAction(id: string, opts: Opts = {}): Promise<OpsAction> {
  return apiRequest('POST', `/deploy/actions/${encodeURIComponent(id)}/refresh`, parseAction, opts);
}

export function getOpsActionLogs(
  id: string,
  opts: Opts = {},
): Promise<{ readonly deploymentUuid: string; readonly logs: string }[]> {
  return apiRequest(
    'GET',
    `/deploy/actions/${encodeURIComponent(id)}/logs`,
    (v) => {
      const items = obj(v).items;
      if (!Array.isArray(items)) throw new ShapeError('items');
      return items.map((x) => ({ deploymentUuid: str(obj(x), 'deploymentUuid'), logs: str(obj(x), 'logs') }));
    },
    opts,
  );
}

// ------------------------------------------------------------------------------ wording

export const KIND_TEXT: Readonly<Record<string, string>> = {
  'coolify.deploy': 'Coolify deploy',
  'coolify.restart': 'Coolify restart',
  'coolify.rollback': 'Coolify rollback',
  'pages.deploy': 'Pages deploy',
  'pages.rollback': 'Pages rollback',
  'dns.upsert': 'DNS change',
  'dns.delete': 'DNS delete',
  'pages.create_project': 'Pages project',
  'pages.add_domain': 'Pages domain',
  'pages.publish': 'Publish site',
  // p8-preview-tunnels
  'tunnel.open': 'Preview open',
  'tunnel.close': 'Preview close',
  'tunnel.extend': 'Preview extend',
};

export function kindText(kind: string): string {
  return KIND_TEXT[kind] ?? kind;
}

/**
 * p10-publish-bundle (fix): the status line of an ops action — the policy decision only while it waits, afterwards
 * what really happened (the header used to keep saying "Waits for approval" next to Succeeded / Failed).
 */
export function opsStatusText(state: string, decision: string, reason?: string): string {
  switch (state) {
    case 'awaiting_approval':
      return decisionText(decision, reason);
    case 'executing':
      return 'Running';
    case 'deploying':
      return 'Deploying';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'denied':
      return 'Denied';
    case 'expired':
      return 'Expired';
    case 'refused':
      return `Refused${reason === undefined || reason === '' ? '' : `: ${reason}`}`;
    default:
      return state;
  }
}

/** How the policy decision reads to a person. */
export function decisionText(decision: string, reason?: string): string {
  switch (decision) {
    case 'auto':
      return 'Runs at once (preview)';
    case 'approval':
      return 'Waits for approval';
    case 'approval_step_up':
      return 'Waits for approval + authenticator code';
    case 'refused':
      return `Refused${reason === undefined || reason === '' ? '' : `: ${reason}`}`;
    default:
      return decision;
  }
}
