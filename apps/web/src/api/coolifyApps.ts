import { apiRequest, obj, type RequestOptions, ShapeError } from './client';

/**
 * p15-coolify-create (ADR-0057; apps/master/src/ops/coolify-app-routes.ts): Coolify applications created and changed
 * by the master — the wizard's options and build suggestion, the linked applications, creating one, and replacing
 * its variables and domains. Variable values are sent once (write-only): no answer carries one.
 */

type Opts = Omit<RequestOptions, 'body'>;
type Json = Record<string, unknown>;
export type DeployEnvName = 'preview' | 'production';
export type BuildPack = 'nixpacks' | 'railpack' | 'static' | 'dockerfile' | 'dockercompose';
export const BUILD_PACKS: readonly BuildPack[] = [
  'nixpacks',
  'railpack',
  'static',
  'dockerfile',
  'dockercompose',
];

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const ns = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');

export interface Named {
  readonly uuid: string;
  readonly name: string;
}

export interface CoolifyOptions {
  readonly connection: { readonly id: string; readonly label: string; readonly manageApps: boolean };
  readonly connections: readonly {
    readonly id: string;
    readonly label: string;
    readonly isDefault: boolean;
  }[];
  readonly servers: readonly (Named & { readonly ip: string | null })[];
  readonly projects: readonly Named[];
  /** null: no Coolify project chosen yet. */
  readonly environments: readonly { readonly name: string; readonly uuid: string | null }[] | null;
  readonly destinations: readonly Named[] | null;
  readonly githubApps: readonly Named[];
  readonly privateKeys: readonly (Named & { readonly fingerprint: string | null })[];
  readonly repository: { readonly url: string; readonly branch: string } | null;
  readonly notes: readonly string[];
}

function named(v: unknown): Named[] {
  return arr(v)
    .map((x) => obj(x))
    .filter((x) => typeof x.uuid === 'string')
    .map((x) => ({ uuid: s(x.uuid), name: s(x.name) }));
}

export function parseOptions(v: unknown): CoolifyOptions {
  const o = obj(v);
  const c = obj(o.connection);
  if (typeof c.id !== 'string') throw new ShapeError('coolify options connection');
  const repo = o.repository === null ? null : obj(o.repository);
  return {
    connection: { id: c.id, label: s(c.label), manageApps: c.manageApps === true },
    connections: arr(o.connections).map((x) => {
      const y = obj(x);
      return { id: s(y.id), label: s(y.label), isDefault: y.isDefault === true };
    }),
    servers: arr(o.servers)
      .map((x) => obj(x))
      .filter((x) => typeof x.uuid === 'string')
      .map((x) => ({ uuid: s(x.uuid), name: s(x.name), ip: ns(x.ip) })),
    projects: named(o.projects),
    environments:
      o.environments === null || o.environments === undefined
        ? null
        : arr(o.environments).map((x) => {
            const y = obj(x);
            return { name: s(y.name), uuid: ns(y.uuid) };
          }),
    destinations: o.destinations === null || o.destinations === undefined ? null : named(o.destinations),
    githubApps: named(o.githubApps),
    privateKeys: arr(o.privateKeys)
      .map((x) => obj(x))
      .filter((x) => typeof x.uuid === 'string')
      .map((x) => ({ uuid: s(x.uuid), name: s(x.name), fingerprint: ns(x.fingerprint) })),
    repository:
      repo === null || typeof repo.url !== 'string' ? null : { url: repo.url, branch: s(repo.branch) },
    notes: strs(o.notes),
  };
}

export interface BuildSuggestion {
  readonly buildPack: BuildPack;
  readonly ports: string | null;
  readonly isStatic: boolean;
  readonly publishDirectory: string | null;
  readonly dockerfileLocation: string | null;
  readonly composeLocation: string | null;
  readonly basis: readonly string[];
  readonly source: 'repository' | 'none';
}

export function parseSuggestion(v: unknown): BuildSuggestion {
  const o = obj(v);
  const bp = BUILD_PACKS.find((b) => b === o.buildPack) ?? 'nixpacks';
  return {
    buildPack: bp,
    ports: ns(o.ports),
    isStatic: o.isStatic === true,
    publishDirectory: ns(o.publishDirectory),
    dockerfileLocation: ns(o.dockerfileLocation),
    composeLocation: ns(o.composeLocation),
    basis: strs(o.basis),
    source: o.source === 'repository' ? 'repository' : 'none',
  };
}

export interface LinkedApp {
  readonly env: DeployEnvName;
  readonly uuid: string;
  readonly connection: { readonly id: string; readonly label: string };
  readonly manageApps: boolean;
  readonly name: string | null;
  readonly fqdn: string | null;
  readonly status: string | null;
  readonly problem: string | null;
}

export interface Creation {
  readonly id: string;
  readonly env: DeployEnvName;
  readonly state: 'creating' | 'created' | 'failed';
  readonly appUuid: string | null;
  readonly name: string;
  readonly connectionLabel: string | null;
  readonly result: {
    readonly linked: boolean;
    readonly deployActionId: string | null;
    readonly deployState: string | null;
    readonly warnings: readonly string[];
    readonly envFailed: readonly string[];
  } | null;
  readonly error: string | null;
  readonly replayed: boolean;
  readonly createdAt: string;
  /** p15-coolify-dedupe: deleted through Remyral (null: not deleted). */
  readonly deletedAt: string | null;
}

const envName = (v: unknown): DeployEnvName => (v === 'preview' ? 'preview' : 'production');

export function parseCreation(v: unknown): Creation {
  const o = obj(v);
  if (typeof o.id !== 'string') throw new ShapeError('coolify creation id');
  const r = o.result === null || o.result === undefined ? null : obj(o.result);
  const envs = r === null ? {} : obj(r.envs);
  return {
    id: o.id,
    env: envName(o.env),
    state: o.state === 'created' ? 'created' : o.state === 'failed' ? 'failed' : 'creating',
    appUuid: ns(o.appUuid),
    name: s(o.name),
    connectionLabel: ns(obj(o.connection).label),
    result:
      r === null
        ? null
        : {
            linked: r.linked === true,
            deployActionId: ns(r.deployActionId),
            deployState: ns(r.deployState),
            warnings: strs(r.warnings),
            envFailed: arr(envs.failed).map((x) => s(obj(x).key)),
          },
    error: ns(o.error),
    replayed: o.replayed === true,
    createdAt: s(o.createdAt),
    deletedAt: ns(o.deletedAt),
  };
}

export function parseLinked(v: unknown): { items: LinkedApp[]; creations: Creation[] } {
  const o = obj(v);
  return {
    items: arr(o.items).map((x) => {
      const y = obj(x);
      const c = obj(y.connection);
      return {
        env: envName(y.env),
        uuid: s(y.uuid),
        connection: { id: s(c.id), label: s(c.label) },
        manageApps: y.manageApps === true,
        name: ns(y.name),
        fqdn: ns(y.fqdn),
        status: ns(y.status),
        problem: ns(y.problem),
      };
    }),
    creations: arr(o.creations).map(parseCreation),
  };
}

export interface EnvVarView {
  readonly key: string;
  readonly preview: boolean;
  readonly buildtime: boolean | null;
  readonly runtime: boolean | null;
  readonly shared: string | null;
}

/** p15-coolify-dedupe: the build / run settings the settings editor shows and changes. */
export interface AppSettings {
  readonly buildPack: BuildPack | null;
  readonly branch: string | null;
  readonly baseDirectory: string | null;
  readonly publishDirectory: string | null;
  readonly dockerfileLocation: string | null;
  readonly composeLocation: string | null;
  readonly ports: string | null;
  readonly isStatic: boolean;
  readonly installCommand: string | null;
  readonly buildCommand: string | null;
  readonly startCommand: string | null;
  readonly watchPaths: readonly string[];
  readonly healthEnabled: boolean;
  readonly healthPath: string | null;
}

export interface AppDetails {
  readonly env: DeployEnvName;
  readonly name: string;
  readonly domains: readonly string[];
  readonly envs: readonly EnvVarView[];
  readonly manageApps: boolean;
  readonly settings: AppSettings;
}

export function parseApp(v: unknown): AppDetails {
  const o = obj(v);
  const a = obj(o.application);
  // p15-coolify-dedupe: older masters do not report the health check.
  const hc: Record<string, unknown> =
    typeof a.healthCheck === 'object' && a.healthCheck !== null
      ? (a.healthCheck as Record<string, unknown>)
      : {};
  return {
    env: envName(o.env),
    name: s(a.name) || s(a.uuid),
    domains: strs(o.domains),
    envs: arr(o.envs).map((x) => {
      const y = obj(x);
      return {
        key: s(y.key),
        preview: y.preview === true,
        buildtime: typeof y.buildtime === 'boolean' ? y.buildtime : null,
        runtime: typeof y.runtime === 'boolean' ? y.runtime : null,
        shared: ns(y.shared),
      };
    }),
    manageApps: obj(o.connection).manageApps === true,
    settings: {
      buildPack: BUILD_PACKS.find((b) => b === a.buildPack) ?? null,
      branch: ns(a.gitBranch),
      baseDirectory: ns(a.baseDirectory),
      publishDirectory: ns(a.publishDirectory),
      dockerfileLocation: ns(a.dockerfileLocation),
      composeLocation: ns(a.composeLocation),
      ports: ns(a.portsExposes),
      isStatic: a.isStatic === true,
      installCommand: ns(a.installCommand),
      buildCommand: ns(a.buildCommand),
      startCommand: ns(a.startCommand),
      watchPaths: arr(a.watchPaths).filter((x): x is string => typeof x === 'string'),
      healthEnabled: hc.enabled === true,
      healthPath: ns(hc.path),
    },
  };
}

export type EnvScope = 'both' | 'runtime' | 'buildtime';

/** One variable to set (value or shared reference) or remove. */
export type EnvChange =
  | {
      readonly key: string;
      readonly value?: string;
      readonly shared?: string;
      readonly preview?: boolean;
      readonly scope?: EnvScope;
    }
  | { readonly key: string; readonly remove: true; readonly preview?: boolean };

export interface EnvResult {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  readonly failed: readonly { readonly key: string; readonly message: string }[];
  readonly deployActionId: string | null;
  readonly deployState: string | null;
  readonly warnings: readonly string[];
}

function parseEnvResult(v: unknown): EnvResult {
  const o = obj(v);
  return {
    created: strs(o.created),
    updated: strs(o.updated),
    removed: strs(o.removed),
    failed: arr(o.failed).map((x) => ({ key: s(obj(x).key), message: s(obj(x).message) })),
    deployActionId: ns(o.deployActionId),
    deployState: ns(o.deployState),
    warnings: strs(o.warnings),
  };
}

export interface DomainsResult {
  readonly domains: readonly string[];
  readonly deployActionId: string | null;
  readonly deployState: string | null;
}

const base = (project: string): string => `/projects/${encodeURIComponent(project)}/coolify`;

export function getCoolifyOptions(
  project: string,
  q: {
    readonly connection?: string | undefined;
    readonly env?: DeployEnvName | undefined;
    readonly coolifyProject?: string | undefined;
    readonly server?: string | undefined;
  },
  opts: Opts = {},
): Promise<CoolifyOptions> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (typeof v === 'string' && v !== '') p.set(k, v);
  const qs = p.toString();
  return apiRequest('GET', `${base(project)}/options${qs === '' ? '' : `?${qs}`}`, parseOptions, opts);
}

export function getCoolifySuggestion(
  project: string,
  branch?: string,
  opts: Opts = {},
): Promise<BuildSuggestion> {
  const qs = branch === undefined || branch === '' ? '' : `?branch=${encodeURIComponent(branch)}`;
  return apiRequest('GET', `${base(project)}/suggestion${qs}`, parseSuggestion, opts);
}

export function listCoolifyApps(
  project: string,
  opts: Opts = {},
): Promise<{ items: LinkedApp[]; creations: Creation[] }> {
  return apiRequest('GET', `${base(project)}/apps`, parseLinked, opts);
}

export function createCoolifyApp(project: string, body: Json, opts: Opts = {}): Promise<Creation> {
  return apiRequest('POST', `${base(project)}/apps`, parseCreation, { ...opts, body });
}

export function getCoolifyApp(project: string, uuid: string, opts: Opts = {}): Promise<AppDetails> {
  return apiRequest('GET', `${base(project)}/apps/${encodeURIComponent(uuid)}`, parseApp, opts);
}

export function setCoolifyEnvs(
  project: string,
  uuid: string,
  changes: readonly EnvChange[],
  deploy: boolean,
  opts: Opts = {},
): Promise<EnvResult> {
  return apiRequest('PUT', `${base(project)}/apps/${encodeURIComponent(uuid)}/envs`, parseEnvResult, {
    ...opts,
    body: { changes, deploy },
  });
}

export function setCoolifyDomains(
  project: string,
  uuid: string,
  domains: readonly string[],
  deploy: boolean,
  opts: Opts = {},
): Promise<DomainsResult> {
  return apiRequest(
    'PUT',
    `${base(project)}/apps/${encodeURIComponent(uuid)}/domains`,
    (v) => {
      const o = obj(v);
      return {
        domains: strs(o.domains),
        deployActionId: ns(o.deployActionId),
        deployState: ns(o.deployState),
      };
    },
    { ...opts, body: { domains, deploy } },
  );
}

/** p15-coolify-dedupe: the answer of a settings change. */
export interface UpdateResult {
  readonly changed: readonly string[];
  readonly deployActionId: string | null;
  readonly deployState: string | null;
  readonly warnings: readonly string[];
}

/** p15-coolify-dedupe: change build / run settings of a linked application (PATCH, documented fields only). */
export function updateCoolifyApp(
  project: string,
  uuid: string,
  body: Json,
  opts: Opts = {},
): Promise<UpdateResult> {
  return apiRequest(
    'PATCH',
    `${base(project)}/apps/${encodeURIComponent(uuid)}`,
    (v) => {
      const o = obj(v);
      return {
        changed: strs(o.changed),
        deployActionId: ns(o.deployActionId),
        deployState: ns(o.deployState),
        warnings: strs(o.warnings),
      };
    },
    { ...opts, body },
  );
}

/** p15-coolify-dedupe: delete an application of the project in Coolify (volumes kept unless asked). */
export function deleteCoolifyApp(
  project: string,
  uuid: string,
  o: { readonly deleteVolumes: boolean; readonly confirm?: string | undefined },
  opts: Opts = {},
): Promise<{
  name: string;
  unlinked: readonly DeployEnvName[];
  warnings: readonly string[];
  lost: readonly string[];
}> {
  // p17-coolify-full: the typed name goes along (the master checks it) and the answer says what is lost.
  const confirm = o.confirm === undefined ? '' : `&confirm=${encodeURIComponent(o.confirm)}`;
  return apiRequest(
    'DELETE',
    `${base(project)}/apps/${encodeURIComponent(uuid)}?deleteVolumes=${o.deleteVolumes ? 'true' : 'false'}${confirm}`,
    (v) => {
      const x = obj(v);
      return {
        name: s(x.name),
        unlinked: arr(x.unlinked).map(envName),
        warnings: strs(x.warnings),
        lost: strs(x.lost),
      };
    },
    opts,
  );
}
