import { randomUUID } from 'node:crypto';
import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { loadGitConfig } from '../gitflow/config-store.js';
import {
  type CoolifyApplication,
  type CoolifyCreateKind,
  type CoolifyEnvVar,
  type CoolifyEnvWrite,
  ProviderCallError,
} from './coolify.js';
import {
  CoolifyAppLogsQuery,
  CoolifyCreateAppInput,
  CoolifyUuid,
  CoolifyDeleteAppInput,
  type CoolifyEnvSet,
  CoolifySetDomainsInput,
  CoolifySetEnvsInput,
  CoolifyUpdateAppInput,
  issuesText,
} from './coolify-apps-model.js';
import type { CoolifyConnections, CoolifyHandle } from './coolify-connections.js';
import {
  type BuildSuggestion,
  DEFAULT_SUGGESTION,
  githubOwnerRepo,
  type RepoLayoutSource,
  suggestBuild,
} from './coolify-detect.js';
import { type DeployEnv, type DeployTargets, OpsError, type OpsVia } from './model.js';
import { coolifyDenyReason } from './policy.js';
import { CoolifyResourceService, type ResourceCtx, type StoragesView } from './coolify-resources.js';
import { coolifyLogText, providerText, type OpsActor, type OpsService } from './service.js';

/**
 * p15-coolify-create (ADR-0057, docs/design/p15-coolify-create.md): create Coolify applications for a project, and
 * change the environment variables and domains of the applications linked to its deploy targets — so the owner never
 * has to open Coolify.
 *
 * Rules (all enforced here; the routes add RBAC `deploy.coolify.*`, CSRF and the security policy's code rule):
 * - the connection must be one the project may use (ADR-0050 allowlist) and have "manage applications" on (ADR-0057);
 * - nothing on the control plane: a new application is never created in a Coolify environment that holds a
 *   deny-listed resource, an existing one is changed only when it is linked to this project's target and passes the
 *   deny-list (uuid + console fqdn), domains never name a protected host (the console);
 * - values of environment variables go master → Coolify in the same request and are never stored, logged, audited or
 *   returned (keys and flags only; a shared-variable reference is shown as such);
 * - creation is idempotent per project + key (`coolify_app_creations`), so a retried request never creates twice;
 * - the new application is linked to the project's deploy target and, when asked, deployed through the normal ops
 *   action (`coolify.deploy` with `only`), so the deploy policy, approvals, status polling and logs apply as for every
 *   deploy;
 * - every write is audited (`ops.coolify.app.create|envs|domains`).
 */

export interface CoolifyAppServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly connections: CoolifyConnections;
  readonly ops: () => OpsService | null;
  /** The console host and other always-protected hosts (lower-case). */
  readonly protectedHosts: readonly string[];
  /** p17-domain-wizard: the console's live host names (a saved address is protected at once). */
  readonly liveProtectedHosts?: () => readonly string[];
  /** Root listing of the project's repository for the build suggestion (absent: plain defaults). */
  readonly layout?: RepoLayoutSource | null;
  /** p17-coolify-full: storages, start / stop / restart (absent: built from these deps). */
  readonly resources?: CoolifyResourceService;
}

export interface LinkedApp {
  readonly env: DeployEnv;
  readonly uuid: string;
  readonly connection: { readonly id: string; readonly label: string };
  readonly manageApps: boolean;
  readonly name: string | null;
  readonly fqdn: string | null;
  readonly status: string | null;
  /** Why it cannot be read or changed (unreadable, control plane …), else null. */
  readonly problem: string | null;
}

export interface CreationView {
  readonly id: string;
  readonly project: string;
  readonly env: DeployEnv;
  readonly connection: { readonly id: string | null; readonly label: string | null };
  readonly state: 'creating' | 'created' | 'failed';
  readonly appUuid: string | null;
  readonly name: string;
  readonly request: Record<string, unknown>;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** This answer repeats an earlier request with the same idempotency key. */
  readonly replayed: boolean;
  /** p15-coolify-dedupe: when the application was deleted through Remyral (null: not deleted). */
  readonly deletedAt: string | null;
}

export interface EnvChangeResult {
  readonly created: string[];
  readonly updated: string[];
  readonly removed: string[];
  readonly unchanged: string[];
  readonly failed: { key: string; message: string }[];
  readonly deployActionId: string | null;
  readonly deployState: string | null;
  readonly warnings: string[];
}

interface CreationRow {
  id: string;
  project: string;
  connection_id: string | null;
  env: DeployEnv;
  request: Record<string, unknown>;
  state: 'creating' | 'created' | 'failed';
  app_uuid: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  /** p15-coolify-dedupe: the application was deleted through Remyral (selected by {@link creations} only). */
  deleted_at?: Date | null;
}

/** A "creating" row older than this is reported as failed with an unknown outcome (never re-created). */
const STALE_CREATING_MS = 10 * 60_000;

/** Which documented body fields each create endpoint takes (docs/compat/coolify.md §Create). */
const CREATE_FIELDS: Readonly<Record<CoolifyCreateKind, ReadonlySet<string>>> = (() => {
  const common = [
    'project_uuid',
    'server_uuid',
    'environment_name',
    'destination_uuid',
    'name',
    'description',
    'domains',
    'ports_exposes',
    'health_check_enabled',
    'health_check_path',
    'health_check_port',
    'health_check_method',
    'health_check_scheme',
    'health_check_return_code',
    'health_check_interval',
    'health_check_timeout',
    'health_check_retries',
    'health_check_start_period',
    'instant_deploy',
  ];
  const git = [
    ...common,
    'git_repository',
    'git_branch',
    'build_pack',
    'is_static',
    'base_directory',
    'publish_directory',
    'install_command',
    'build_command',
    'start_command',
    'dockerfile_location',
    'docker_compose_location',
  ];
  return {
    public: new Set(git),
    'private-github-app': new Set([...git, 'github_app_uuid']),
    'private-deploy-key': new Set([...git, 'private_key_uuid']),
    dockerfile: new Set([...common, 'dockerfile', 'build_pack', 'base_directory']),
    dockerimage: new Set([...common, 'docker_registry_image_name', 'docker_registry_image_tag']),
  };
})();

/** The body for one create endpoint: only its documented fields, undefined dropped (exported for tests). */
export function createBody(
  kind: CoolifyCreateKind,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const allowed = CREATE_FIELDS[kind];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (!allowed.has(k)) throw new Error(`field ${k} is not documented for POST /applications/${kind}`);
    out[k] = v;
  }
  return out;
}

/** The Coolify body of one variable (flags only when they differ from Coolify's defaults). */
export function envWrite(e: CoolifyEnvSet): CoolifyEnvWrite {
  const value = e.shared === undefined ? (e.value ?? '') : `{{${e.shared}}}`;
  const scope = e.scope ?? 'both';
  return {
    key: e.key,
    value,
    ...(e.preview === true ? { is_preview: true } : {}),
    ...(e.literal === true ? { is_literal: true } : {}),
    ...(e.multiline === true ? { is_multiline: true } : {}),
    ...(scope === 'runtime' ? { is_buildtime: false, is_runtime: true } : {}),
    ...(scope === 'buildtime' ? { is_buildtime: true, is_runtime: false } : {}),
  };
}

/** What is kept of a variable (history, audit, chat cards): never the value. */
export function envMeta(
  e: CoolifyEnvSet | { key: string; remove: true; preview?: boolean },
): Record<string, unknown> {
  if ('remove' in e) return { key: e.key, remove: true, ...(e.preview === true ? { preview: true } : {}) };
  return {
    key: e.key,
    source: e.shared === undefined ? 'value' : 'shared',
    ...(e.shared === undefined ? {} : { shared: e.shared }),
    ...(e.preview === true ? { preview: true } : {}),
    ...(e.scope === undefined || e.scope === 'both' ? {} : { scope: e.scope }),
  };
}

function hostsOf(fqdn: string): string[] {
  return fqdn
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d !== '')
    .map((d) => {
      try {
        return new URL(/^[a-z]+:\/\//i.test(d) ? d : `https://${d}`).hostname.toLowerCase();
      } catch {
        return d.toLowerCase();
      }
    });
}

/** The https URL of a repository for Coolify (public / GitHub App), or its SSH form (deploy key). */
export function coolifyRepository(
  url: string,
  access: 'public' | 'github_app' | 'deploy_key',
): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    const ssh = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+?)(?:\.git)?$/.exec(url.trim());
    if (ssh === null) return null;
    return access === 'deploy_key'
      ? `git@${ssh[1] ?? ''}:${ssh[2] ?? ''}.git`
      : `https://${ssh[1] ?? ''}/${ssh[2] ?? ''}`;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null;
  const path = u.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  if (!/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(path)) return null;
  return access === 'deploy_key' ? `git@${u.host}:${path.slice(1)}.git` : `https://${u.host}${path}`;
}

/**
 * p15-coolify-dedupe: a repository as `owner/repo` (lower-case) whatever form Coolify stores — `https://host/o/r(.git)`,
 * `git@host:o/r.git` or the bare `o/r` of GitHub App sources. null: not a repository reference.
 */
export function repoKey(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  let v = url.trim().toLowerCase();
  if (v === '') return null;
  const ssh = /^[a-z0-9._-]+@[a-z0-9.-]+:(.+)$/.exec(v);
  if (ssh !== null) v = ssh[1] ?? '';
  else v = v.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/, '');
  const parts = v
    .replace(/\.git$/, '')
    .split('/')
    .filter((x) => x !== '');
  if (parts.length < 2) return null;
  return `${parts.at(-2) ?? ''}/${parts.at(-1) ?? ''}`;
}

/** A directory / file path inside the repository for comparison (`''` and `/` are the root; no trailing slash). */
function pathKey(p: string | null | undefined, dflt: string): string {
  const v = (p ?? '').trim();
  if (v === '' || v === '/') return dflt;
  return `/${v.replace(/^\/+|\/+$/g, '')}`;
}

/** What a new application would serve (the duplicate guard's key). */
export interface DuplicateWant {
  /** The Coolify environment (numeric id); null: unknown (then every application of the connection is compared). */
  readonly environmentId: number | null;
  readonly name: string;
  readonly repository: string | null;
  readonly branch: string | null;
  /** Compared only when the request gives them. */
  readonly baseDirectory?: string | undefined;
  readonly dockerfileLocation?: string | undefined;
  readonly image?: string | undefined;
}

export type DuplicateMatch = 'repository' | 'image' | 'name';

/**
 * p15-coolify-dedupe (docs/design/p15-coolify-dedupe.md §2): the applications of the target environment that already
 * serve the same repository + branch (+ base directory / Dockerfile location when given), the same image, or carry the
 * same name (case-insensitive). Applications whose environment Coolify does not report are compared too (fail closed).
 */
export function matchDuplicates(
  apps: readonly CoolifyApplication[],
  want: DuplicateWant,
): { app: CoolifyApplication; match: DuplicateMatch[] }[] {
  const repo = repoKey(want.repository);
  const name = want.name.trim().toLowerCase();
  const out: { app: CoolifyApplication; match: DuplicateMatch[] }[] = [];
  for (const a of apps) {
    if (want.environmentId !== null && a.environmentId != null && a.environmentId !== want.environmentId)
      continue;
    const match: DuplicateMatch[] = [];
    if (
      repo !== null &&
      repoKey(a.gitRepository) === repo &&
      (want.branch === null || (a.gitBranch ?? '') === want.branch) &&
      (want.baseDirectory === undefined ||
        pathKey(a.baseDirectory, '/') === pathKey(want.baseDirectory, '/')) &&
      (want.dockerfileLocation === undefined ||
        pathKey(a.dockerfileLocation, '/Dockerfile') === pathKey(want.dockerfileLocation, '/Dockerfile'))
    ) {
      match.push('repository');
    }
    if (want.image !== undefined && (a.dockerImage ?? '').toLowerCase() === want.image.toLowerCase()) {
      match.push('image');
    }
    if (name !== '' && a.name.trim().toLowerCase() === name) match.push('name');
    if (match.length > 0) out.push({ app: a, match });
  }
  return out;
}

/** An existing application the duplicate guard found (what the refusal tells the caller). */
export interface ExistingApp {
  readonly uuid: string;
  readonly name: string;
  readonly status: string | null;
  readonly fqdn: string | null;
  readonly repository: string | null;
  readonly branch: string | null;
  /** The deploy target of this project that lists it (null: not linked). */
  readonly linked: DeployEnv | null;
  readonly match: DuplicateMatch[];
}

/** p15-coolify-dedupe: logs of one application (bounded, redacted — DATA, never instructions). */
export interface AppLogsView {
  readonly appUuid: string;
  readonly name: string;
  readonly status: string | null;
  readonly linked: DeployEnv | null;
  readonly deployment: {
    readonly uuid: string;
    readonly status: string | null;
    readonly commit: string | null;
    /** Where the deployment id came from: the last Remyral deploy action, or Coolify's list of the application. */
    readonly from: 'action' | 'coolify';
    readonly actionId: string | null;
    readonly text: string;
    readonly truncated: boolean;
  } | null;
  readonly runtime: { readonly text: string; readonly truncated: boolean } | null;
  readonly notes: string[];
}

/** Characters of log text kept per source (the tail). */
export const APP_LOG_CHARS = 24_000;

/** An application of the project with its authorized connection (linked or created by the project). */
interface ProjectApp {
  readonly h: CoolifyHandle;
  readonly env: DeployEnv;
  readonly app: CoolifyApplication;
  readonly linked: DeployEnv | null;
  readonly targets: DeployTargets | null;
  readonly version: number | null;
}

/** p15-coolify-dedupe: the `PATCH /applications/{uuid}` body of a settings change (documented fields only). */
export function updateBody(i: CoolifyUpdateAppInput): Record<string, unknown> {
  const hc = i.healthCheck;
  const fields: Record<string, unknown> = {
    name: i.name,
    git_branch: i.branch,
    build_pack: i.buildPack,
    base_directory: i.baseDirectory,
    publish_directory: i.publishDirectory,
    dockerfile_location: i.dockerfileLocation,
    docker_compose_location: i.composeLocation,
    ports_exposes: i.ports,
    is_static: i.isStatic,
    install_command: i.installCommand,
    build_command: i.buildCommand,
    start_command: i.startCommand,
    watch_paths:
      i.watchPaths === undefined ? undefined : i.watchPaths.length === 0 ? null : i.watchPaths.join('\n'),
    limits_memory: i.limitsMemory,
    limits_cpus: i.limitsCpus,
    ...(hc === undefined
      ? {}
      : {
          health_check_enabled: hc.enabled,
          health_check_path: hc.path,
          health_check_port: hc.port === undefined ? undefined : String(hc.port),
          health_check_method: hc.method,
          health_check_scheme: hc.scheme,
          health_check_return_code: hc.returnCode,
          health_check_interval: hc.interval,
          health_check_timeout: hc.timeout,
          health_check_retries: hc.retries,
          health_check_start_period: hc.startPeriod,
        }),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/** What the audit and cards keep of a settings change: the values, commands only as set / cleared. */
export function updateMeta(i: CoolifyUpdateAppInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(i)) {
    if (k === 'deploy' || v === undefined) continue;
    out[k] =
      k === 'installCommand' || k === 'buildCommand' || k === 'startCommand'
        ? v === ''
          ? '(cleared)'
          : '(set)'
        : v;
  }
  return out;
}

/** The refusal of a duplicate creation (409 `coolify_app_exists`), in words the assistant and the panel act on. */
export function duplicateMessage(env: string, existing: readonly ExistingApp[]): string {
  const list = existing
    .slice(0, 5)
    .map(
      (e) =>
        `${e.name} (${e.uuid}, ${e.status ?? 'status unknown'}, ${e.linked === null ? 'not linked' : `linked to the ${e.linked} target`}; same ${e.match.join(' + ')})`,
    )
    .join('; ');
  return `The Coolify environment “${env}” already has this application: ${list}. Do not create another one — fix and redeploy the existing application (read its deployment / application logs, change its settings or variables, then deploy it). Create a second application only when the user explicitly asks for one (allowDuplicate).`.slice(
    0,
    1500,
  );
}

export class CoolifyAppService {
  readonly #redactor = new Redactor({ rules: DEFAULT_RULES });
  readonly #resources: CoolifyResourceService;

  constructor(private readonly deps: CoolifyAppServiceDeps) {
    this.#resources =
      deps.resources ??
      new CoolifyResourceService({
        pool: deps.pool,
        audit: deps.audit,
        clock: deps.clock,
        log: deps.log,
        connections: deps.connections,
        protectedHosts: deps.protectedHosts,
        ...(deps.liveProtectedHosts === undefined ? {} : { liveProtectedHosts: deps.liveProtectedHosts }),
      });
  }

  get #protected(): ReadonlySet<string> {
    return new Set(
      [...this.deps.protectedHosts, ...(this.deps.liveProtectedHosts?.() ?? [])].map((h) => h.toLowerCase()),
    );
  }

  #ops(): OpsService {
    const o = this.deps.ops();
    if (o === null)
      throw new HttpError(
        503,
        'unavailable',
        'Coolify application management is not available.',
        {},
        {},
        { reason: 'coolify' },
      );
    return o;
  }

  /** A provider failure as an OpsError (Coolify's message, details of 422 / 409, never a value we sent). */
  async #provider<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderCallError) {
        this.deps.log.warn(
          { provider: err.provider, status: err.status, code: err.code, message: err.message },
          'coolify call failed',
        );
        throw new OpsError(
          err.code === 'rate_limited' ? 429 : err.code === 'conflict' ? 409 : 424,
          `${err.provider}_${err.code}`,
          providerText(err),
          err.retryAfterSec === null ? {} : { 'retry-after': String(err.retryAfterSec) },
        );
      }
      throw err;
    }
  }

  async #targets(project: string): Promise<{ targets: DeployTargets | null; version: number | null }> {
    const { rowCount } = await this.deps.pool.query('SELECT 1 FROM projects WHERE id = $1', [project]);
    if ((rowCount ?? 0) === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
    const t = await this.#ops().targets(project);
    return { targets: t?.targets ?? null, version: t?.version ?? null };
  }

  /** The connection of a request: explicit, else the env target's, else the default (always authorized). */
  async #connection(project: string, explicit: string | null, env: DeployEnv | null): Promise<CoolifyHandle> {
    let id = explicit;
    if (id === null && env !== null) {
      const { targets } = await this.#targets(project);
      id = targets?.coolify?.[env]?.connection ?? null;
    }
    return this.deps.connections.forAction(project, id);
  }

  #requireManage(h: CoolifyHandle): void {
    if (!h.manageApps) {
      throw new HttpError(
        409,
        'coolify_manage_disabled',
        `Creating and changing applications is off for the Coolify connection “${h.label}” (Settings → Integrations → Coolify → Manage applications; its token then needs the "write" permission).`,
      );
    }
  }

  #deny(h: CoolifyHandle, app: CoolifyApplication): string | null {
    return coolifyDenyReason(app, {
      denyUuids: this.deps.connections.denyUuids(h.settings),
      consoleHosts: this.#protected,
    });
  }

  /** Refuses domains that name a protected host (the console) or that a deny-listed application serves. */
  async #checkDomains(h: CoolifyHandle, domains: readonly string[]): Promise<void> {
    if (domains.length === 0) return;
    const hosts = domains.flatMap((d) => hostsOf(d));
    const bad = hosts.find((x) => this.#protected.has(x));
    if (bad !== undefined) {
      throw new HttpError(400, 'protected_domain', `The domain ${bad} is protected (the Remyral console).`);
    }
    const deny = this.deps.connections.denyUuids(h.settings);
    if (deny.size === 0) return;
    const apps = await this.#provider(() => h.client.applications());
    for (const a of apps) {
      if (!deny.has(a.uuid)) continue;
      const hit = hostsOf(a.fqdn).find((x) => hosts.includes(x));
      if (hit !== undefined) {
        throw new HttpError(
          400,
          'protected_domain',
          `The domain ${hit} belongs to the Remyral control plane.`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- reads

  /**
   * What the wizard offers on a connection: the connections the project may use, the servers, projects (and the
   * environments / destinations of the chosen ones), GitHub App sources and deploy keys, the project's repository and
   * its deploy targets. Optional lists that the token cannot read are empty with a note.
   */
  async options(
    project: string,
    q: {
      connection?: string | null;
      coolifyProject?: string | null;
      server?: string | null;
      env?: DeployEnv | null;
    },
  ): Promise<Record<string, unknown>> {
    const { targets } = await this.#targets(project);
    const choices = await this.deps.connections.forProject(project);
    const h = await this.#connection(project, q.connection ?? null, q.env ?? null);
    const notes: string[] = [];
    const optional = async <T>(what: string, fn: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await fn();
      } catch (err) {
        if (
          err instanceof ProviderCallError &&
          ['not_found', 'forbidden', 'invalid', 'unsupported'].includes(err.code)
        ) {
          notes.push(`${what}: ${err.message}`);
          return [];
        }
        throw err;
      }
    };
    const servers = await this.#provider(() => h.client.servers());
    const projects = await this.#provider(() => h.client.projects());
    const environments =
      q.coolifyProject == null
        ? null
        : await this.#provider(() => h.client.environments(q.coolifyProject ?? ''));
    const destinations =
      q.server == null ? null : await optional('destinations', () => h.client.destinations(q.server ?? ''));
    const githubApps = await optional('GitHub apps', () => h.client.githubApps());
    const keys = await optional('private keys', () => h.client.privateKeys());
    const git = await loadGitConfig(this.deps.pool, project);
    return {
      connection: { id: h.id, label: h.label, manageApps: h.manageApps },
      connections: choices,
      servers,
      projects,
      environments,
      destinations,
      githubApps,
      privateKeys: keys,
      repository:
        git === null ? null : { url: git.repositoryUrl, branch: git.baseBranch, provider: git.provider },
      targets: {
        preview: targets?.coolify?.preview ?? null,
        production: targets?.coolify?.production ?? null,
      },
      notes,
    };
  }

  /** The build suggestion from the project's repository (defaults when it has none or it cannot be read). */
  async suggestion(
    project: string,
    branch?: string | null,
  ): Promise<BuildSuggestion & { repository: string | null }> {
    await this.#targets(project);
    const git = await loadGitConfig(this.deps.pool, project);
    if (git === null) return { ...DEFAULT_SUGGESTION, repository: null };
    const gh = githubOwnerRepo(git.repositoryUrl);
    const layout = this.deps.layout ?? null;
    if (gh === null || layout === null) return { ...DEFAULT_SUGGESTION, repository: git.repositoryUrl };
    const root = await layout.root(gh.owner, gh.repo, branch ?? git.baseBranch).catch(() => null);
    if (root === null) return { ...DEFAULT_SUGGESTION, repository: git.repositoryUrl };
    return { ...suggestBuild(root.files, root.packageJson), repository: git.repositoryUrl };
  }

  /** The applications linked to the project's Coolify targets, with what each editor needs to know. */
  async linked(project: string): Promise<LinkedApp[]> {
    const { targets } = await this.#targets(project);
    const out: LinkedApp[] = [];
    for (const env of ['preview', 'production'] as const) {
      const t = targets?.coolify?.[env] ?? null;
      if (t === null) continue;
      let h: CoolifyHandle | null = null;
      let problem: string | null = null;
      try {
        h = await this.deps.connections.forAction(project, t.connection);
      } catch (err) {
        if (!(err instanceof OpsError)) throw err;
        problem = err.message;
      }
      for (const uuid of t.uuids.slice(0, 20)) {
        if (h === null) {
          out.push({
            env,
            uuid,
            connection: { id: t.connection ?? '', label: '' },
            manageApps: false,
            name: null,
            fqdn: null,
            status: null,
            problem,
          });
          continue;
        }
        const handle = h;
        const app = await handle.client.application(uuid).catch((err: unknown) => {
          if (err instanceof ProviderCallError) return err;
          throw err;
        });
        if (app instanceof ProviderCallError) {
          out.push({
            env,
            uuid,
            connection: { id: handle.id, label: handle.label },
            manageApps: handle.manageApps,
            name: null,
            fqdn: null,
            status: null,
            problem: providerText(app),
          });
          continue;
        }
        out.push({
          env,
          uuid,
          connection: { id: handle.id, label: handle.label },
          manageApps: handle.manageApps,
          name: app.name,
          fqdn: app.fqdn,
          status: app.status,
          problem: this.#deny(handle, app),
        });
      }
    }
    return out;
  }

  /** A linked application of the project: its connection (authorized) and the deny-checked application. */
  async #linkedApp(
    project: string,
    uuid: string,
  ): Promise<{ h: CoolifyHandle; env: DeployEnv; app: CoolifyApplication }> {
    const { targets } = await this.#targets(project);
    for (const env of ['preview', 'production'] as const) {
      const t = targets?.coolify?.[env] ?? null;
      if (t === null || !t.uuids.includes(uuid)) continue;
      const h = await this.deps.connections.forAction(project, t.connection);
      const app = await this.#provider(() => h.client.application(uuid));
      const r = this.#deny(h, app);
      if (r !== null) throw new HttpError(403, 'control_plane_resource', r);
      return { h, env, app };
    }
    throw new HttpError(
      404,
      'app_not_linked',
      `Coolify application ${uuid} is not linked to a deploy target of project ${project} (Project → Deploy → targets).`,
    );
  }

  /** One linked application: settings the editors show and its variables (keys and flags — never values). */
  async app(project: string, uuid: string): Promise<Record<string, unknown>> {
    const { h, env } = await this.#linkedApp(project, uuid);
    const details = await this.#provider(() => h.client.applicationDetails(uuid));
    const envs = await this.#provider(() => h.client.envs(uuid));
    return {
      env,
      connection: { id: h.id, label: h.label, manageApps: h.manageApps },
      application: details,
      domains: details.fqdn
        .split(',')
        .map((d) => d.trim())
        .filter((d) => d !== ''),
      envs: envs.map((e) => this.#envView(e)),
    };
  }

  #envView(e: CoolifyEnvVar): Record<string, unknown> {
    return {
      key: e.key,
      preview: e.isPreview,
      buildtime: e.isBuildtime,
      runtime: e.isRuntime,
      literal: e.isLiteral,
      multiline: e.isMultiline,
      shared: e.sharedRef,
      sharedVariable: e.isShared,
    };
  }

  // -------------------------------------------------------------------------------------------- create

  #creationView(r: CreationRow, label: string | null, replayed: boolean): CreationView {
    return {
      id: r.id,
      project: r.project,
      env: r.env,
      connection: { id: r.connection_id, label },
      state: r.state,
      appUuid: r.app_uuid,
      name: typeof r.request.name === 'string' ? r.request.name : '',
      request: r.request,
      result: r.result,
      error: r.error,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      replayed,
      deletedAt: r.deleted_at == null ? null : r.deleted_at.toISOString(),
    };
  }

  async #creation(id: string): Promise<CreationRow> {
    const { rows } = await this.deps.pool.query<CreationRow>(
      `SELECT id::text AS id, project, connection_id::text AS connection_id, env, request, state, app_uuid, result,
              error, created_at, updated_at FROM coolify_app_creations WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) throw new Error('creation vanished');
    return r;
  }

  /** Recent creations of a project (newest first). */
  async creations(project: string, limit = 20): Promise<CreationView[]> {
    const { rows } = await this.deps.pool.query<CreationRow & { label: string | null }>(
      `SELECT a.id::text AS id, a.project, a.connection_id::text AS connection_id, a.env, a.request, a.state, a.app_uuid,
              a.result, a.error, a.created_at, a.updated_at, a.deleted_at, c.label
         FROM coolify_app_creations a LEFT JOIN coolify_connections c ON c.id = a.connection_id
        WHERE a.project = $1 ORDER BY a.created_at DESC LIMIT $2`,
      [project, Math.max(1, Math.min(limit, 100))],
    );
    return rows.map((r) => this.#creationView(r, r.label, false));
  }

  async #audit(
    actor: OpsActor,
    action: string,
    project: string,
    outcome: 'success' | 'failure' | 'denied',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action,
      target: `project:${project}`,
      outcome,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata,
    });
  }

  /** The create endpoint and its source fields (repository + branch, Dockerfile, image) of a request. */
  async #source(
    project: string,
    i: CoolifyCreateAppInput,
  ): Promise<{
    kind: CoolifyCreateKind;
    fields: Record<string, unknown>;
    sourceMeta: Record<string, unknown>;
  }> {
    let kind: CoolifyCreateKind;
    const fields: Record<string, unknown> = {};
    let sourceMeta: Record<string, unknown>;
    if (i.source.type === 'repository') {
      const git = await loadGitConfig(this.deps.pool, project);
      if (git === null) {
        throw new HttpError(
          409,
          'no_repository',
          'This project has no repository (Project → Repository); use a Dockerfile or an image instead.',
        );
      }
      const access = i.source.access;
      const repo = coolifyRepository(git.repositoryUrl, access);
      if (repo === null) {
        throw new HttpError(
          409,
          'no_repository',
          'The project’s repository URL cannot be given to Coolify (an https:// URL is needed).',
          {},
          {},
          { reason: 'url' },
        );
      }
      kind =
        access === 'github_app'
          ? 'private-github-app'
          : access === 'deploy_key'
            ? 'private-deploy-key'
            : 'public';
      if (access === 'github_app' && i.source.githubApp === undefined) {
        throw new HttpError(
          400,
          'invalid_request',
          'Choose the Coolify GitHub App source (githubApp).',
          {},
          {},
          { reason: 'coolify_github_app' },
        );
      }
      if (access === 'deploy_key' && i.source.privateKey === undefined) {
        throw new HttpError(
          400,
          'invalid_request',
          'Choose the Coolify deploy key (privateKey).',
          {},
          {},
          { reason: 'coolify_deploy_key' },
        );
      }
      const buildPack = i.buildPack ?? 'nixpacks';
      Object.assign(fields, {
        git_repository: repo,
        git_branch: i.source.branch ?? git.baseBranch,
        build_pack: buildPack,
        ...(access === 'github_app' ? { github_app_uuid: i.source.githubApp } : {}),
        ...(access === 'deploy_key' ? { private_key_uuid: i.source.privateKey } : {}),
        is_static: i.isStatic,
        base_directory: i.baseDirectory,
        publish_directory: i.publishDirectory,
        install_command: i.installCommand,
        build_command: i.buildCommand,
        start_command: i.startCommand,
        dockerfile_location: buildPack === 'dockerfile' ? i.dockerfileLocation : undefined,
        docker_compose_location: buildPack === 'dockercompose' ? i.composeLocation : undefined,
      });
      sourceMeta = {
        type: 'repository',
        access,
        repository: repo,
        branch: fields.git_branch,
        buildPack,
      };
    } else if (i.source.type === 'dockerfile') {
      kind = 'dockerfile';
      Object.assign(fields, {
        dockerfile: i.source.dockerfile,
        build_pack: 'dockerfile',
        base_directory: i.baseDirectory,
      });
      sourceMeta = { type: 'dockerfile', bytes: Buffer.byteLength(i.source.dockerfile, 'utf8') };
    } else {
      kind = 'dockerimage';
      Object.assign(fields, {
        docker_registry_image_name: i.source.image,
        docker_registry_image_tag: i.source.tag ?? 'latest',
      });
      sourceMeta = { type: 'image', image: i.source.image, tag: i.source.tag ?? 'latest' };
    }
    return { kind, fields, sourceMeta };
  }

  /** Which deploy target of the project lists `uuid` (null: none). */
  #linkedEnv(targets: DeployTargets | null, uuid: string): DeployEnv | null {
    for (const env of ['preview', 'production'] as const) {
      if (targets?.coolify?.[env]?.uuids.includes(uuid) === true) return env;
    }
    return null;
  }

  /** p15-coolify-dedupe: the applications a new one would duplicate (see {@link matchDuplicates}). */
  #duplicates(
    targets: DeployTargets | null,
    apps: readonly CoolifyApplication[],
    environmentId: number | null,
    name: string,
    i: CoolifyCreateAppInput,
    fields: Readonly<Record<string, unknown>>,
  ): ExistingApp[] {
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
    return matchDuplicates(apps, {
      environmentId,
      name,
      repository: str(fields.git_repository) ?? null,
      branch: str(fields.git_branch) ?? null,
      baseDirectory: i.source.type === 'repository' ? i.baseDirectory : undefined,
      dockerfileLocation: fields.build_pack === 'dockerfile' ? i.dockerfileLocation : undefined,
      image: str(fields.docker_registry_image_name),
    })
      .slice(0, 10)
      .map(({ app, match }) => ({
        uuid: app.uuid,
        name: app.name,
        status: app.status === '' ? null : app.status,
        fqdn: app.fqdn === '' ? null : app.fqdn,
        repository: app.gitRepository ?? null,
        branch: app.gitBranch,
        linked: this.#linkedEnv(targets, app.uuid),
        match,
      }));
  }

  /**
   * p15-coolify-dedupe: the applications a create request would duplicate (empty: none, or `allowDuplicate`). Used by
   * the assistant's card planning so that no card is offered for a duplicate; {@link create} checks again.
   */
  async existing(project: string, raw: unknown): Promise<{ environment: string; existing: ExistingApp[] }> {
    const parsed = CoolifyCreateAppInput.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_request', `Invalid application: ${issuesText(parsed.error)}`);
    }
    const i = parsed.data;
    if (i.allowDuplicate) return { environment: i.environment, existing: [] };
    const { targets } = await this.#targets(project);
    const h = await this.#connection(project, i.connection ?? null, i.env);
    const name = i.name ?? `${project}-${i.env}`.replace(/[^A-Za-z0-9 ._-]/g, '-').slice(0, 100);
    const { fields } = await this.#source(project, i);
    const envs = await this.#provider(() => h.client.environments(i.coolifyProject));
    const environment = envs.find((e) => e.name === i.environment || e.uuid === i.environment) ?? null;
    if (environment === null) return { environment: i.environment, existing: [] };
    const apps = await this.#provider(() => h.client.applications());
    return {
      environment: environment.name,
      existing: this.#duplicates(targets, apps, environment.id, name, i, fields),
    };
  }

  /**
   * Creates a Coolify application for the project (see the module comment). Validation and every check happen before
   * anything is created; a failure after creation (a variable, the link, the deploy) is reported in the result's
   * warnings and never undoes the creation.
   */
  async create(actor: OpsActor, project: string, raw: unknown, via: OpsVia): Promise<CreationView> {
    const parsed = CoolifyCreateAppInput.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_request', `Invalid application: ${issuesText(parsed.error)}`);
    }
    const i = parsed.data;
    const { targets, version } = await this.#targets(project);

    // Idempotency first: a retried request answers with the earlier creation (nothing is checked or created again).
    const prior = await this.#prior(project, i.idempotencyKey);
    if (prior !== null) return prior;

    const h = await this.#connection(project, i.connection ?? null, i.env);
    this.#requireManage(h);
    const current = targets?.coolify?.[i.env] ?? null;
    if (
      i.link === 'add' &&
      current !== null &&
      current.uuids.length + current.tags.length > 0 &&
      current.connection !== null &&
      current.connection !== h.id
    ) {
      throw new HttpError(
        409,
        'target_connection_differs',
        `The ${i.env} target of this project uses another Coolify connection; choose link "replace" or create the application on that connection.`,
      );
    }
    if (i.link === 'add' && current !== null && current.uuids.length >= 20) {
      throw new HttpError(409, 'target_full', `The ${i.env} target already lists 20 applications.`);
    }
    const seen = new Set<string>();
    for (const e of i.envs) {
      const k = `${e.key}|${e.preview === true ? 'p' : ''}`;
      if (seen.has(k)) throw new HttpError(400, 'duplicate_env', `Variable ${e.key} is listed twice.`);
      seen.add(k);
    }

    // Source → endpoint + fields.
    const name = i.name ?? `${project}-${i.env}`.replace(/[^A-Za-z0-9 ._-]/g, '-').slice(0, 100);
    const { kind, fields, sourceMeta } = await this.#source(project, i);
    const compose = fields.build_pack === 'dockercompose';
    const ports = i.ports ?? (compose ? undefined : fields.build_pack === 'static' ? '80' : '3000');
    const hc = i.healthCheck;
    Object.assign(fields, {
      project_uuid: i.coolifyProject,
      server_uuid: i.server,
      environment_name: i.environment,
      destination_uuid: i.destination,
      name,
      description: i.description,
      domains: i.domains.length === 0 ? undefined : i.domains.join(','),
      ports_exposes: ports,
      instant_deploy: false,
      ...(hc === undefined
        ? {}
        : {
            health_check_enabled: hc.enabled,
            health_check_path: hc.path,
            health_check_port: hc.port === undefined ? undefined : String(hc.port),
            health_check_method: hc.method,
            health_check_scheme: hc.scheme,
            health_check_return_code: hc.returnCode,
            health_check_interval: hc.interval,
            health_check_timeout: hc.timeout,
            health_check_retries: hc.retries,
            health_check_start_period: hc.startPeriod,
          }),
    });
    const body = createBody(kind, fields);

    // Where it goes: the server, the Coolify project and environment exist, and the environment is not the control
    // plane's.
    const servers = await this.#provider(() => h.client.servers());
    if (!servers.some((s) => s.uuid === i.server)) {
      throw new HttpError(
        400,
        'unknown_server',
        `Coolify server ${i.server} is not visible on “${h.label}”.`,
      );
    }
    const projects = await this.#provider(() => h.client.projects());
    if (!projects.some((p) => p.uuid === i.coolifyProject)) {
      throw new HttpError(
        400,
        'unknown_coolify_project',
        `Coolify project ${i.coolifyProject} is not visible on “${h.label}”.`,
      );
    }
    const envs = await this.#provider(() => h.client.environments(i.coolifyProject));
    const environment = envs.find((e) => e.name === i.environment || e.uuid === i.environment) ?? null;
    if (environment === null) {
      throw new HttpError(
        400,
        'unknown_environment',
        `The Coolify project has no environment “${i.environment}” (create it in the wizard's list first).`,
      );
    }
    body.environment_name = environment.name;
    const apps = await this.#provider(() => h.client.applications());
    const deny = this.deps.connections.denyUuids(h.settings);
    // A server, project, environment or destination uuid on the deny list is the control plane as a whole.
    const deniedPlace = [i.server, i.coolifyProject, environment.uuid, i.destination].find(
      (u): u is string => typeof u === 'string' && deny.has(u),
    );
    if (deniedPlace !== undefined) {
      await this.#audit(actor, 'ops.coolify.app.create', project, 'denied', {
        connection: { id: h.id, label: h.label },
        reason: 'control_plane_place',
        resource: deniedPlace,
      });
      throw new HttpError(
        403,
        'control_plane_environment',
        `Coolify resource ${deniedPlace} is on the control-plane deny list; choose another server, project or environment.`,
      );
    }
    const cp = apps.find(
      (a) =>
        environment.id !== null &&
        a.environmentId === environment.id &&
        (deny.has(a.uuid) || this.#deny(h, a) !== null),
    );
    if (cp !== undefined) {
      await this.#audit(actor, 'ops.coolify.app.create', project, 'denied', {
        connection: { id: h.id, label: h.label },
        reason: 'control_plane_environment',
        environment: environment.name,
      });
      throw new HttpError(
        403,
        'control_plane_environment',
        `The Coolify environment “${environment.name}” holds the Remyral control plane (${cp.uuid}); choose another one.`,
      );
    }
    await this.#checkDomains(h, i.domains);
    // p15-coolify-dedupe: one application per repository + branch (or name) in an environment — a failed deploy is
    // fixed on the existing application, never by creating another one (unless the user asked for a second one).
    if (!i.allowDuplicate) {
      const existing = this.#duplicates(targets, apps, environment.id, name, i, fields);
      if (existing.length > 0) {
        await this.#audit(actor, 'ops.coolify.app.create', project, 'denied', {
          connection: { id: h.id, label: h.label },
          reason: 'duplicate',
          environment: environment.name,
          name,
          via,
          existing: existing.map((e) => ({ uuid: e.uuid, name: e.name, linked: e.linked, match: e.match })),
        });
        const first = existing[0];
        throw new HttpError(
          409,
          'coolify_app_exists',
          duplicateMessage(environment.name, existing),
          {},
          { existing },
          { uuid: first?.uuid ?? '', name: first?.name ?? '', environment: environment.name },
        );
      }
    }

    const request: Record<string, unknown> = {
      env: i.env,
      name,
      server: i.server,
      coolifyProject: i.coolifyProject,
      environment: environment.name,
      ...(i.destination === undefined ? {} : { destination: i.destination }),
      source: sourceMeta,
      ports: ports ?? null,
      domains: i.domains,
      ...(hc === undefined ? {} : { healthCheck: hc }),
      envs: i.envs.map((e) => envMeta(e)),
      link: i.link,
      deploy: i.deploy,
      ...(i.allowDuplicate ? { allowDuplicate: true } : {}),
    };
    const id = randomUUID();
    const now = this.deps.clock();
    const ins = await this.deps.pool.query(
      `INSERT INTO coolify_app_creations (id, project, connection_id, idempotency_key, env, request, state, created_by,
         via, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'creating', $7, $8, $9, $9)
       ON CONFLICT (project, idempotency_key) DO NOTHING`,
      [
        id,
        project,
        h.id,
        i.idempotencyKey,
        i.env,
        request,
        actor.type === 'user' ? actor.id : null,
        via === 'chat' ? 'chat' : 'api',
        now,
      ],
    );
    if ((ins.rowCount ?? 0) === 0) {
      const again = await this.#prior(project, i.idempotencyKey);
      if (again !== null) return again;
      throw new HttpError(409, 'creation_in_progress', 'This application is being created.');
    }

    let uuid: string;
    try {
      uuid = await this.#provider(() => h.client.createApplication(kind, body));
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 1000) : 'failed';
      await this.deps.pool.query(
        "UPDATE coolify_app_creations SET state = 'failed', error = $2, updated_at = $3 WHERE id = $1",
        [id, message, this.deps.clock()],
      );
      await this.#audit(actor, 'ops.coolify.app.create', project, 'failure', {
        creationId: id,
        connection: { id: h.id, label: h.label },
        request,
        via,
        error: message,
      });
      throw err;
    }
    await this.deps.pool.query(
      "UPDATE coolify_app_creations SET state = 'created', app_uuid = $2, updated_at = $3 WHERE id = $1",
      [id, uuid, this.deps.clock()],
    );

    const warnings: string[] = [];
    const envResult = { created: [] as string[], failed: [] as { key: string; message: string }[] };
    for (const e of i.envs) {
      try {
        await this.#provider(() => h.client.createEnv(uuid, envWrite(e)));
        envResult.created.push(e.key);
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 300) : 'failed';
        envResult.failed.push({ key: e.key, message });
      }
    }
    if (envResult.failed.length > 0) {
      warnings.push(
        `${String(envResult.failed.length)} variable(s) could not be set; set them again in the editor.`,
      );
    }

    let linked = false;
    if (i.link !== 'none') {
      try {
        const base = targets ?? null;
        const cur = base?.coolify?.[i.env] ?? null;
        const nextEnv =
          i.link === 'replace' || cur === null
            ? { connection: h.id, uuids: [uuid], tags: [] as string[] }
            : { connection: h.id, uuids: [...new Set([...cur.uuids, uuid])], tags: cur.tags };
        const nextTargets = {
          ...(base ?? {}),
          coolify: {
            preview: base?.coolify?.preview ?? null,
            production: base?.coolify?.production ?? null,
            [i.env]: nextEnv,
          },
        };
        await this.#ops().putTargets(actor, project, nextTargets, version);
        linked = true;
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 300) : 'failed';
        warnings.push(`Not linked to the ${i.env} target: ${message}`);
      }
    }

    let deployActionId: string | null = null;
    let deployState: string | null = null;
    if (i.deploy) {
      if (!linked) {
        warnings.push('Not deployed: the application is not linked to the deploy target.');
      } else {
        try {
          const out = await this.#ops().request(
            actor,
            {
              project,
              kind: 'coolify.deploy',
              params: { env: i.env, only: [uuid] },
              idempotencyKey: `coolify-create:${id}`,
            },
            via,
          );
          deployActionId = out.action.id;
          deployState = out.action.state;
        } catch (err) {
          const message = err instanceof Error ? err.message.slice(0, 300) : 'failed';
          warnings.push(`The first deploy was not requested: ${message}`);
        }
      }
    }
    const result = {
      appUuid: uuid,
      linked,
      envs: envResult,
      deployActionId,
      deployState,
      warnings,
    };
    await this.deps.pool.query(
      'UPDATE coolify_app_creations SET result = $2, updated_at = $3 WHERE id = $1',
      [id, result, this.deps.clock()],
    );
    await this.#audit(actor, 'ops.coolify.app.create', project, 'success', {
      creationId: id,
      connection: { id: h.id, label: h.label },
      endpoint: kind,
      request,
      via,
      result,
    });
    return this.#creationView(await this.#creation(id), h.label, false);
  }

  /** The earlier creation with this key (a stale "creating" row is closed as failed, never re-created). */
  async #prior(project: string, key: string): Promise<CreationView | null> {
    const { rows } = await this.deps.pool.query<CreationRow & { label: string | null }>(
      `SELECT a.id::text AS id, a.project, a.connection_id::text AS connection_id, a.env, a.request, a.state, a.app_uuid,
              a.result, a.error, a.created_at, a.updated_at, c.label
         FROM coolify_app_creations a LEFT JOIN coolify_connections c ON c.id = a.connection_id
        WHERE a.project = $1 AND a.idempotency_key = $2`,
      [project, key],
    );
    const r = rows[0];
    if (r === undefined) return null;
    if (r.state === 'creating') {
      if (this.deps.clock().getTime() - r.updated_at.getTime() < STALE_CREATING_MS) {
        throw new HttpError(409, 'creation_in_progress', 'This application is being created.');
      }
      const error =
        'The outcome is unknown (the master stopped while Coolify was creating it): check the Coolify project for an application with this name before creating it again with a new request.';
      await this.deps.pool.query(
        "UPDATE coolify_app_creations SET state = 'failed', error = $2, updated_at = $3 WHERE id = $1 AND state = 'creating'",
        [r.id, error, this.deps.clock()],
      );
      return this.#creationView({ ...r, state: 'failed', error }, r.label, true);
    }
    return this.#creationView(r, r.label, true);
  }

  // ------------------------------------------------------------------------------- variables / domains

  /** Sets / removes variables of a linked application (values never stored; see the module comment). */
  async setEnvs(
    actor: OpsActor,
    project: string,
    uuid: string,
    raw: unknown,
    via: OpsVia,
  ): Promise<EnvChangeResult> {
    const parsed = CoolifySetEnvsInput.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_request', `Invalid variables: ${issuesText(parsed.error)}`);
    }
    const i = parsed.data;
    const seen = new Set<string>();
    for (const c of i.changes) {
      const k = `${c.key}|${c.preview === true ? 'p' : ''}`;
      if (seen.has(k)) throw new HttpError(400, 'duplicate_env', `Variable ${c.key} is listed twice.`);
      seen.add(k);
    }
    const { h, env } = await this.#linkedApp(project, uuid);
    this.#requireManage(h);
    const existing = await this.#provider(() => h.client.envs(uuid));
    const find = (key: string, preview: boolean): CoolifyEnvVar | undefined =>
      existing.find((e) => e.key === key && e.isPreview === preview);
    const out: EnvChangeResult = {
      created: [],
      updated: [],
      removed: [],
      unchanged: [],
      failed: [],
      deployActionId: null,
      deployState: null,
      warnings: [],
    };
    const updates: { key: string; write: CoolifyEnvWrite }[] = [];
    for (const c of i.changes) {
      const cur = find(c.key, c.preview === true);
      try {
        if ('remove' in c) {
          if (cur === undefined) {
            out.unchanged.push(c.key);
            continue;
          }
          await this.#provider(() => h.client.deleteEnv(uuid, cur.uuid));
          out.removed.push(c.key);
        } else if (cur === undefined) {
          await this.#provider(() => h.client.createEnv(uuid, envWrite(c)));
          out.created.push(c.key);
        } else {
          updates.push({ key: c.key, write: envWrite(c) });
        }
      } catch (err) {
        out.failed.push({ key: c.key, message: err instanceof Error ? err.message.slice(0, 300) : 'failed' });
      }
    }
    if (updates.length === 1 && updates[0] !== undefined) {
      const u = updates[0];
      try {
        await this.#provider(() => h.client.updateEnv(uuid, u.write));
        out.updated.push(u.key);
      } catch (err) {
        out.failed.push({ key: u.key, message: err instanceof Error ? err.message.slice(0, 300) : 'failed' });
      }
    } else if (updates.length > 1) {
      try {
        await this.#provider(() =>
          h.client.bulkEnvs(
            uuid,
            updates.map((u) => u.write),
          ),
        );
        out.updated.push(...updates.map((u) => u.key));
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 300) : 'failed';
        out.failed.push(...updates.map((u) => ({ key: u.key, message })));
      }
    }
    const changed = out.created.length + out.updated.length + out.removed.length > 0;
    if (changed && !i.deploy)
      out.warnings.push('Variables take effect with the next deploy of the application.');
    const result =
      changed && i.deploy ? await this.#redeploy(actor, project, env, uuid, via, out.warnings) : null;
    const final: EnvChangeResult = {
      ...out,
      deployActionId: result?.id ?? null,
      deployState: result?.state ?? null,
    };
    await this.#audit(
      actor,
      'ops.coolify.app.envs',
      project,
      out.failed.length === 0 ? 'success' : 'failure',
      {
        connection: { id: h.id, label: h.label },
        appUuid: uuid,
        env,
        via,
        changes: i.changes.map((c) => envMeta(c)),
        created: final.created,
        updated: final.updated,
        removed: final.removed,
        failed: final.failed.map((f) => f.key),
        deployActionId: final.deployActionId,
      },
    );
    return final;
  }

  /** Replaces the domains of a linked application (empty list: none). */
  async setDomains(
    actor: OpsActor,
    project: string,
    uuid: string,
    raw: unknown,
    via: OpsVia,
  ): Promise<{
    domains: string[];
    previous: string[];
    deployActionId: string | null;
    deployState: string | null;
    warnings: string[];
  }> {
    const parsed = CoolifySetDomainsInput.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_request', `Invalid domains: ${issuesText(parsed.error)}`);
    }
    const i = parsed.data;
    const { h, env, app } = await this.#linkedApp(project, uuid);
    this.#requireManage(h);
    await this.#checkDomains(h, i.domains);
    // Docker Compose applications take domains per service (`docker_compose_domains`), not `domains` (Coolify 422).
    const details = await this.#provider(() => h.client.applicationDetails(uuid));
    const compose = details.buildPack === 'dockercompose';
    let service: string | null = null;
    if (compose) {
      const known = details.composeServices;
      service = i.service ?? (known.length === 1 ? (known[0] ?? null) : null);
      if (service === null || (known.length > 0 && !known.includes(service))) {
        throw new HttpError(
          400,
          'invalid_request',
          `This Docker Compose application sets domains per service; name the service (${known.join(', ') || 'none found'}).`,
          {},
          {},
          { reason: 'compose_service', services: known.join(', ') || '—' },
        );
      }
    }
    const previous = (compose && service !== null ? (details.composeDomains[service] ?? '') : app.fqdn)
      .split(',')
      .map((d) => d.trim())
      .filter((d) => d !== '');
    try {
      await this.#provider(() =>
        h.client.updateApplication(
          uuid,
          compose && service !== null
            ? { docker_compose_domains: [{ name: service, domain: i.domains.join(',') }] }
            : { domains: i.domains.join(',') },
        ),
      );
    } catch (err) {
      await this.#audit(actor, 'ops.coolify.app.domains', project, 'failure', {
        connection: { id: h.id, label: h.label },
        appUuid: uuid,
        env,
        via,
        domains: i.domains,
        previous,
        error: err instanceof Error ? err.message.slice(0, 500) : 'failed',
      });
      throw err;
    }
    const warnings: string[] = [];
    if (!i.deploy) warnings.push('New domains take effect with the next deploy of the application.');
    const dep = i.deploy ? await this.#redeploy(actor, project, env, uuid, via, warnings) : null;
    await this.#audit(actor, 'ops.coolify.app.domains', project, 'success', {
      connection: { id: h.id, label: h.label },
      appUuid: uuid,
      env,
      via,
      domains: i.domains,
      previous,
      deployActionId: dep?.id ?? null,
    });
    return {
      domains: i.domains,
      previous,
      deployActionId: dep?.id ?? null,
      deployState: dep?.state ?? null,
      warnings,
    };
  }

  // ----------------------------------------------------------- p15-coolify-dedupe: update, logs, delete

  /**
   * An application of the project: linked to one of its deploy targets, or created by it through Remyral and not
   * deleted since. Its connection is authorized for the project and the application passes the deny list.
   */
  async #projectApp(project: string, uuid: string): Promise<ProjectApp> {
    // The uuid reaches a LIKE pattern and Coolify paths: only the documented uuid alphabet.
    if (!CoolifyUuid.safeParse(uuid).success) {
      throw new HttpError(
        400,
        'invalid_request',
        'Invalid Coolify application uuid.',
        {},
        {},
        {
          reason: 'coolify_uuid',
        },
      );
    }
    const { targets, version } = await this.#targets(project);
    const linked = this.#linkedEnv(targets, uuid);
    let h: CoolifyHandle;
    let env: DeployEnv;
    if (linked !== null) {
      h = await this.deps.connections.forAction(project, targets?.coolify?.[linked]?.connection ?? null);
      env = linked;
    } else {
      const { rows } = await this.deps.pool.query<{ connection_id: string | null; env: DeployEnv }>(
        `SELECT connection_id::text AS connection_id, env FROM coolify_app_creations
          WHERE project = $1 AND app_uuid = $2 AND state = 'created' AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [project, uuid],
      );
      const r = rows[0];
      if (r === undefined) {
        throw new HttpError(
          404,
          'app_not_linked',
          `Coolify application ${uuid} is neither linked to a deploy target of project ${project} nor created by it.`,
        );
      }
      h = await this.deps.connections.forAction(project, r.connection_id);
      env = r.env;
    }
    const app = await this.#provider(() => h.client.application(uuid));
    const reason = this.#deny(h, app);
    if (reason !== null) throw new HttpError(403, 'control_plane_resource', reason);
    return { h, env, app, linked, targets, version };
  }

  /** Redacted, tail-capped log text. */
  #clean(text: string, max = APP_LOG_CHARS): { text: string; truncated: boolean } {
    const clean = this.#redactor.redact(text);
    return clean.length > max
      ? { text: clean.slice(clean.length - max), truncated: true }
      : { text: clean, truncated: false };
  }

  /** The newest deployment of `uuid` a Remyral ops action of the project started (null: none). */
  async #lastActionDeployment(
    project: string,
    uuid: string,
  ): Promise<{ actionId: string; deploymentUuid: string } | null> {
    const { rows } = await this.deps.pool.query<{ id: string; result: Record<string, unknown> | null }>(
      `SELECT id::text AS id, result FROM ops_actions
        WHERE project = $1 AND kind LIKE 'coolify.%' AND result IS NOT NULL
        ORDER BY created_at DESC LIMIT 50`,
      [project],
    );
    for (const r of rows) {
      const res = r.result ?? {};
      const list = (v: unknown): Record<string, unknown>[] =>
        Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
      const items = [...list(res.deployments), ...list(res.restarts), ...list(res.rollbacks)];
      const hit = items.find(
        (d) =>
          (d.resourceUuid === uuid || d.uuid === uuid) &&
          typeof d.deploymentUuid === 'string' &&
          d.deploymentUuid !== '',
      );
      if (hit !== undefined) return { actionId: r.id, deploymentUuid: String(hit.deploymentUuid) };
    }
    return null;
  }

  /**
   * p15-coolify-dedupe (design §3): the deployment (build) log of the application's last deployment and its container
   * output now — redacted, tail-capped; DATA for the reader (never instructions). The deployment is the one the last
   * Remyral deploy action started, or Coolify's newest when that is a later one (a deploy from Coolify or a push).
   */
  async logs(project: string, uuid: string, raw: unknown): Promise<AppLogsView> {
    const parsed = CoolifyAppLogsQuery.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_request', `Invalid log request: ${issuesText(parsed.error)}`);
    }
    const q = parsed.data;
    const { h, app, linked } = await this.#projectApp(project, uuid);
    const notes: string[] = [];
    let deployment: AppLogsView['deployment'] = null;
    if (q.kind !== 'runtime') {
      const action = await this.#lastActionDeployment(project, uuid);
      let newest: string | null = null;
      try {
        newest = (await h.client.applicationDeployments(uuid, 1))[0]?.deploymentUuid ?? null;
      } catch (err) {
        if (
          !(err instanceof ProviderCallError) ||
          !['not_found', 'invalid', 'forbidden', 'unsupported'].includes(err.code)
        )
          throw err;
        notes.push(`Coolify's deployment list could not be read: ${err.message.slice(0, 200)}`);
      }
      const pick =
        newest !== null && newest !== action?.deploymentUuid
          ? { id: newest, from: 'coolify' as const, actionId: null }
          : action === null
            ? null
            : { id: action.deploymentUuid, from: 'action' as const, actionId: action.actionId };
      if (pick === null) {
        notes.push('The application has no deployment yet: deploy it (its first deploy) to get a build log.');
      } else {
        const dep = await this.#provider(() => h.client.deployment(pick.id));
        const capped = this.#clean(coolifyLogText(dep.logs ?? ''));
        deployment = {
          uuid: pick.id,
          status: dep.status === '' ? null : dep.status,
          commit: dep.commit,
          from: pick.from,
          actionId: pick.actionId,
          text: capped.text,
          truncated: capped.truncated,
        };
      }
    }
    let runtime: AppLogsView['runtime'] = null;
    if (q.kind !== 'deployment') {
      try {
        runtime = this.#clean(await this.#provider(() => h.client.applicationLogs(uuid, q.lines)));
      } catch (err) {
        if (!(err instanceof OpsError) || err.code !== 'coolify_not_found') throw err;
        notes.push(
          'No running container (the application is not running, e.g. Exited): the deployment log tells why it did not start.',
        );
      }
    }
    return {
      appUuid: uuid,
      name: app.name,
      status: app.status === '' ? null : app.status,
      linked,
      deployment,
      runtime,
      notes,
    };
  }

  /**
   * p15-coolify-dedupe (design §4): changes the build / run settings of a linked application (`PATCH
   * /applications/{uuid}`, documented fields only) and optionally redeploys only it.
   */
  async update(
    actor: OpsActor,
    project: string,
    uuid: string,
    raw: unknown,
    via: OpsVia,
  ): Promise<{
    appUuid: string;
    changed: string[];
    deployActionId: string | null;
    deployState: string | null;
    warnings: string[];
  }> {
    const parsed = CoolifyUpdateAppInput.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_request', `Invalid settings: ${issuesText(parsed.error)}`);
    }
    const i = parsed.data;
    const { h, env } = await this.#linkedApp(project, uuid);
    this.#requireManage(h);
    const body = updateBody(i);
    const changes = updateMeta(i);
    try {
      await this.#provider(() => h.client.updateApplication(uuid, body));
    } catch (err) {
      await this.#audit(actor, 'ops.coolify.app.update', project, 'failure', {
        connection: { id: h.id, label: h.label },
        appUuid: uuid,
        env,
        via,
        changes,
        error: err instanceof Error ? err.message.slice(0, 500) : 'failed',
      });
      throw err;
    }
    const warnings: string[] = [];
    if (!i.deploy) warnings.push('The new settings take effect with the next deploy of the application.');
    const dep = i.deploy ? await this.#redeploy(actor, project, env, uuid, via, warnings) : null;
    await this.#audit(actor, 'ops.coolify.app.update', project, 'success', {
      connection: { id: h.id, label: h.label },
      appUuid: uuid,
      env,
      via,
      changes,
      deployActionId: dep?.id ?? null,
    });
    return {
      appUuid: uuid,
      changed: Object.keys(body),
      deployActionId: dep?.id ?? null,
      deployState: dep?.state ?? null,
      warnings,
    };
  }

  /**
   * p15-coolify-dedupe (design §5): deletes an application of the project in Coolify (`DELETE /applications/{uuid}`).
   * Never a control-plane resource (deny list, console host, or an application next to one in its environment), never
   * one another project's deploy target lists. The creation rows are marked deleted and the project's deploy targets
   * stop listing it. Audited `ops.coolify.app.delete`. Callers decide who may ask (project admin; the assistant only
   * on the user's explicit instruction).
   */
  async delete(
    actor: OpsActor,
    project: string,
    uuid: string,
    raw: unknown,
    via: OpsVia,
  ): Promise<{
    appUuid: string;
    name: string;
    unlinked: DeployEnv[];
    creations: number;
    options: CoolifyDeleteAppInput;
    /** p17-coolify-full: what is gone (the application; its volumes when asked — else that they are kept). */
    lost: string[];
    warnings: string[];
  }> {
    const parsed = CoolifyDeleteAppInput.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_request', `Invalid delete request: ${issuesText(parsed.error)}`);
    }
    const o = parsed.data;
    let resolved: ProjectApp;
    try {
      resolved = await this.#projectApp(project, uuid);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'control_plane_resource') {
        await this.#audit(actor, 'ops.coolify.app.delete', project, 'denied', {
          appUuid: uuid,
          via,
          reason: 'control_plane_resource',
        });
      }
      throw err;
    }
    const { h, app, targets, version } = resolved;
    this.#requireManage(h);
    const base = { connection: { id: h.id, label: h.label }, appUuid: uuid, name: app.name, via };
    // p17-coolify-full: a typed confirmation must name the application.
    if (o.confirm !== undefined && o.confirm !== app.name) {
      throw new HttpError(
        400,
        'confirmation_mismatch',
        `Type ${app.name} to confirm.`,
        {},
        {},
        { expected: app.name },
      );
    }
    // An application in the environment of a control-plane resource is part of the control plane as well.
    const deny = this.deps.connections.denyUuids(h.settings);
    if (app.environmentId != null) {
      const apps = await this.#provider(() => h.client.applications());
      const cp = apps.find(
        (a) =>
          a.uuid !== uuid &&
          a.environmentId === app.environmentId &&
          (deny.has(a.uuid) || this.#deny(h, a) !== null),
      );
      if (cp !== undefined) {
        await this.#audit(actor, 'ops.coolify.app.delete', project, 'denied', {
          ...base,
          reason: 'control_plane_environment',
        });
        throw new HttpError(
          403,
          'control_plane_environment',
          `Coolify application ${uuid} lives next to the Remyral control plane (${cp.uuid}); it is not deleted from Remyral.`,
        );
      }
    }
    const { rows: others } = await this.deps.pool.query<{ project: string }>(
      'SELECT project FROM project_deploy_targets WHERE project <> $1 AND config::text LIKE $2 LIMIT 1',
      [project, `%"${uuid}"%`],
    );
    if (others[0] !== undefined) {
      await this.#audit(actor, 'ops.coolify.app.delete', project, 'denied', {
        ...base,
        reason: 'used_elsewhere',
      });
      throw new HttpError(
        409,
        'app_used_elsewhere',
        `Coolify application ${uuid} is a deploy target of another project; it is not deleted.`,
      );
    }
    // p17-coolify-full: what is lost — the volumes (read before the deletion, best effort).
    let volumes: string[] = [];
    try {
      volumes = (await h.client.storages('application', uuid))
        .filter((s) => s.type === 'persistent' || s.mount === 'directory')
        .map((s) => s.name ?? s.mountPath);
    } catch (err) {
      if (!(err instanceof ProviderCallError)) throw err;
    }
    const lost = [
      `The application ${app.name} in Coolify${o.deleteConfigurations ? ' with its configuration' : ''}.`,
      o.deleteVolumes
        ? `Its volumes and all data in them: ${volumes.join(', ') || 'none found'}.`
        : `Its volumes are kept on the server (${volumes.join(', ') || 'none found'}).`,
    ];
    try {
      await this.#provider(() => h.client.deleteApplication(uuid, o));
    } catch (err) {
      await this.#audit(actor, 'ops.coolify.app.delete', project, 'failure', {
        ...base,
        options: o,
        error: err instanceof Error ? err.message.slice(0, 500) : 'failed',
      });
      throw err;
    }
    const now = this.deps.clock();
    const marked = await this.deps.pool.query(
      `UPDATE coolify_app_creations SET deleted_at = $3, deleted_by = $4, updated_at = $3
        WHERE project = $1 AND app_uuid = $2 AND deleted_at IS NULL`,
      [project, uuid, now, actor.type === 'user' ? actor.id : null],
    );
    const warnings: string[] = [];
    const unlinked: DeployEnv[] = [];
    const cur = targets?.coolify ?? null;
    if (targets !== null && cur !== null) {
      const next: Record<DeployEnv, unknown> = { preview: cur.preview, production: cur.production };
      for (const env of ['preview', 'production'] as const) {
        const t = cur[env];
        if (t === null || !t.uuids.includes(uuid)) continue;
        const uuids = t.uuids.filter((u) => u !== uuid);
        next[env] = uuids.length + t.tags.length === 0 ? null : { ...t, uuids };
        unlinked.push(env);
      }
      if (unlinked.length > 0) {
        try {
          await this.#ops().putTargets(actor, project, { ...targets, coolify: next }, version);
        } catch (err) {
          warnings.push(
            `Deleted in Coolify, but the deploy target still lists it: ${err instanceof Error ? err.message.slice(0, 300) : 'failed'}`,
          );
          unlinked.length = 0;
        }
      }
    }
    const out = {
      appUuid: uuid,
      name: app.name,
      unlinked,
      creations: marked.rowCount ?? 0,
      options: o,
      lost,
      warnings,
    };
    await this.#audit(actor, 'ops.coolify.app.delete', project, 'success', {
      ...base,
      options: o,
      unlinked,
      creations: out.creations,
      lost,
      warnings,
    });
    return out;
  }

  /**
   * An application of the project (linked or created by it), deny-checked: name, status and link state — what the
   * assistant's delete card shows.
   */
  async projectApp(
    project: string,
    uuid: string,
  ): Promise<{
    uuid: string;
    name: string;
    status: string | null;
    fqdn: string | null;
    linked: DeployEnv | null;
  }> {
    const { app, linked } = await this.#projectApp(project, uuid);
    return {
      uuid,
      name: app.name,
      status: app.status === '' ? null : app.status,
      fqdn: app.fqdn === '' ? null : app.fqdn,
      linked,
    };
  }

  // ------------------------------------------------- p17-coolify-full: storages and start / stop / restart

  /**
   * The write context of an application of the project (linked or created by it, deny-checked): audited on the
   * project, redeployed through the project's deploy policy (an ops action of that application only).
   */
  async #appCtx(
    actor: OpsActor,
    project: string,
    uuid: string,
    via: OpsVia,
    action: string,
  ): Promise<{ ctx: ResourceCtx; env: DeployEnv; linked: DeployEnv | null }> {
    let resolved: ProjectApp;
    try {
      resolved = await this.#projectApp(project, uuid);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'control_plane_resource') {
        await this.#audit(actor, action, project, 'denied', { appUuid: uuid, via, reason: err.code });
      }
      throw err;
    }
    const { h, env, linked } = resolved;
    return {
      env,
      linked,
      ctx: {
        h,
        actor,
        via,
        target: `project:${project}`,
        redeploy: async (u, warnings) => {
          const dep = await this.#redeploy(actor, project, env, u, via, warnings);
          return dep === null ? null : { actionId: dep.id, state: dep.state, deploymentUuid: null };
        },
      },
    };
  }

  /** The storages of an application of the project (volumes, file / directory mounts) with data-path warnings. */
  async storages(
    project: string,
    uuid: string,
  ): Promise<
    StoragesView & { env: DeployEnv; linked: DeployEnv | null; connection: Record<string, unknown> }
  > {
    const { h, env, linked } = await this.#projectApp(project, uuid);
    const view = await this.#resources.storagesOf(h, 'application', uuid);
    return { ...view, env, linked, connection: { id: h.id, label: h.label, manageApps: h.manageApps } };
  }

  async addStorage(
    actor: OpsActor,
    project: string,
    uuid: string,
    raw: unknown,
    via: OpsVia,
  ): Promise<Record<string, unknown>> {
    const { ctx } = await this.#appCtx(actor, project, uuid, via, 'ops.coolify.storage.add');
    return this.#resources.addStorage(ctx, 'application', uuid, raw);
  }

  async updateStorage(
    actor: OpsActor,
    project: string,
    uuid: string,
    storage: string,
    raw: unknown,
    via: OpsVia,
  ): Promise<Record<string, unknown>> {
    const { ctx } = await this.#appCtx(actor, project, uuid, via, 'ops.coolify.storage.update');
    return this.#resources.updateStorage(ctx, 'application', uuid, storage, raw);
  }

  async removeStorage(
    actor: OpsActor,
    project: string,
    uuid: string,
    storage: string,
    raw: unknown,
    via: OpsVia,
  ): Promise<Record<string, unknown>> {
    const { ctx } = await this.#appCtx(actor, project, uuid, via, 'ops.coolify.storage.remove');
    return this.#resources.removeStorage(ctx, 'application', uuid, storage, raw);
  }

  /** Start / stop / restart an application of the project (project admin; the `deploy` ability of the token). */
  async lifecycle(
    actor: OpsActor,
    project: string,
    uuid: string,
    raw: unknown,
    via: OpsVia,
  ): Promise<Record<string, unknown>> {
    const a = (raw as { action?: unknown } | null)?.action;
    const { ctx } = await this.#appCtx(actor, project, uuid, via, `ops.coolify.lifecycle.${String(a)}`);
    return this.#resources.lifecycle(ctx, 'application', uuid, raw);
  }

  async #redeploy(
    actor: OpsActor,
    project: string,
    env: DeployEnv,
    uuid: string,
    via: OpsVia,
    warnings: string[],
  ): Promise<{ id: string; state: string } | null> {
    try {
      const out = await this.#ops().request(
        actor,
        {
          project,
          kind: 'coolify.deploy',
          params: { env, only: [uuid] },
          idempotencyKey: `coolify-change:${randomUUID()}`,
        },
        via,
      );
      return { id: out.action.id, state: out.action.state };
    } catch (err) {
      warnings.push(
        `The deploy was not requested: ${err instanceof Error ? err.message.slice(0, 300) : 'failed'}`,
      );
      return null;
    }
  }
}
