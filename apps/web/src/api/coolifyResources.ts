import { apiRequest, type RequestOptions } from './client';

/**
 * p17-coolify-full (apps/master/src/ops/coolify-resource-routes.ts, coolify-app-routes.ts): storages, start / stop /
 * restart and logs of a project's Coolify application, and the whole Coolify of a connection — applications,
 * databases (+ backups), services (+ variables), servers, projects / environments, running deployments. No answer
 * carries a password, connection URL, variable value or file content.
 */

type Opts = Omit<RequestOptions, 'body'>;
type Json = Record<string, unknown>;
export type ResourceKind = 'application' | 'database' | 'service';
export type LifecycleAction = 'start' | 'stop' | 'restart';

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const ns = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const nn = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');
const enc = encodeURIComponent;
/** A record, or {} for anything else (Coolify answers carry nulls where a resource has no such part). */
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};

export interface Storage {
  readonly uuid: string;
  readonly type: 'persistent' | 'file';
  readonly mount: 'volume' | 'file' | 'directory' | 'hostFile';
  readonly name: string | null;
  readonly mountPath: string;
  readonly hostPath: string | null;
  readonly readOnly: boolean;
  readonly contentBytes: number | null;
  readonly resourceUuid: string | null;
}

export interface StoragesView {
  readonly name: string;
  readonly storages: readonly Storage[];
  readonly dataWarnings: readonly { readonly path: string; readonly source: string }[];
  readonly storageApi: 'full' | 'read' | 'none' | 'unknown';
  /** The manual step when this Coolify has no storage API (null: it has one). */
  readonly unsupported: string | null;
  readonly controlPlane: boolean;
  readonly notes: readonly string[];
}

const MOUNTS = ['volume', 'file', 'directory', 'hostFile'] as const;

export function parseStorages(v: unknown): StoragesView {
  const o = obj(v);
  const f = obj(o.features);
  const api = f.storages;
  return {
    name: s(o.name),
    storages: arr(o.storages).map((x) => {
      const y = obj(x);
      return {
        uuid: s(y.uuid),
        type: y.type === 'file' ? 'file' : 'persistent',
        mount: MOUNTS.find((m) => m === y.mount) ?? 'volume',
        name: ns(y.name),
        mountPath: s(y.mountPath),
        hostPath: ns(y.hostPath),
        readOnly: y.readOnly === true,
        contentBytes: nn(y.contentBytes),
        resourceUuid: ns(y.resourceUuid),
      };
    }),
    dataWarnings: arr(o.dataWarnings).map((x) => ({ path: s(obj(x).path), source: s(obj(x).source) })),
    storageApi: api === 'full' || api === 'read' || api === 'none' ? api : 'unknown',
    unsupported: ns(o.unsupported),
    controlPlane: o.controlPlane === true,
    notes: strs(o.notes),
  };
}

/** The answer of a write: Coolify's facts plus warnings / what is lost (shown as they come). */
export interface WriteResult {
  readonly warnings: readonly string[];
  readonly lost: readonly string[];
  readonly deployActionId: string | null;
  readonly raw: Json;
}

export function parseWrite(v: unknown): WriteResult {
  const o = obj(v);
  const dep = obj(o.deploy);
  return {
    warnings: strs(o.warnings),
    lost: typeof o.lost === 'string' ? [o.lost] : strs(o.lost),
    deployActionId: ns(dep.actionId),
    raw: o,
  };
}

export interface LogsView {
  readonly text: string | null;
  readonly truncated: boolean;
  readonly notes: readonly string[];
  readonly sub: string | null;
}

export function parseLogs(v: unknown): LogsView {
  const o = obj(v);
  // A project application answers `runtime` (+ `deployment`); a Coolify-wide resource `logs`.
  const l = o.logs ?? o.runtime;
  const lo = l === null || l === undefined ? null : obj(l);
  const dep = o.deployment === null || o.deployment === undefined ? null : obj(o.deployment);
  const text = [dep === null ? null : s(dep.text), lo === null ? null : s(lo.text)]
    .filter((x): x is string => x !== null && x !== '')
    .join('\n\n');
  return {
    text: lo === null && dep === null ? null : text,
    truncated: lo?.truncated === true || dep?.truncated === true,
    notes: strs(o.notes),
    sub: ns(o.sub),
  };
}

/** Where a storage / lifecycle / logs request goes: a project's application or a resource of a connection. */
export type Scope =
  | { readonly kind: 'project'; readonly project: string; readonly uuid: string }
  | {
      readonly kind: 'connection';
      readonly connection: string;
      readonly resource: ResourceKind;
      readonly uuid: string;
    };

function prefix(sc: Scope): string {
  return sc.kind === 'project'
    ? `/projects/${enc(sc.project)}/coolify/apps/${enc(sc.uuid)}`
    : `/integrations/coolify/connections/${enc(sc.connection)}/resources/${sc.resource}/${enc(sc.uuid)}`;
}

export function getStorages(sc: Scope, opts: Opts = {}): Promise<StoragesView> {
  return apiRequest('GET', `${prefix(sc)}/storages`, parseStorages, opts);
}

export function addStorage(sc: Scope, body: Json, opts: Opts = {}): Promise<WriteResult> {
  return apiRequest('POST', `${prefix(sc)}/storages`, parseWrite, { ...opts, body });
}

export function updateStorage(sc: Scope, storage: string, body: Json, opts: Opts = {}): Promise<WriteResult> {
  return apiRequest('PATCH', `${prefix(sc)}/storages/${enc(storage)}`, parseWrite, { ...opts, body });
}

export function removeStorage(
  sc: Scope,
  storage: string,
  confirm: string,
  deploy: boolean,
  opts: Opts = {},
): Promise<WriteResult> {
  return apiRequest(
    'DELETE',
    `${prefix(sc)}/storages/${enc(storage)}?confirm=${enc(confirm)}&deploy=${deploy ? 'true' : 'false'}`,
    parseWrite,
    opts,
  );
}

export function lifecycle(sc: Scope, action: LifecycleAction, opts: Opts = {}): Promise<WriteResult> {
  return apiRequest('POST', `${prefix(sc)}/${action}`, parseWrite, opts);
}

export function getLogs(
  sc: Scope,
  q: { readonly lines?: number; readonly sub?: string },
  opts: Opts = {},
): Promise<LogsView> {
  const p = new URLSearchParams();
  if (q.lines !== undefined) p.set('lines', String(q.lines));
  if (q.sub !== undefined && q.sub !== '') p.set('sub', q.sub);
  if (sc.kind === 'project') p.set('kind', 'both');
  const qs = p.toString();
  return apiRequest('GET', `${prefix(sc)}/logs${qs === '' ? '' : `?${qs}`}`, parseLogs, opts);
}

// ----------------------------------------------------------------------------------- the whole Coolify

export interface Overview {
  readonly connection: {
    readonly version: string | null;
    readonly manageApps: boolean;
    readonly storageApi: string;
    readonly permissions: Json | null;
  };
  readonly applications: readonly Res[];
  readonly databases: readonly Res[];
  readonly services: readonly (Res & {
    readonly parts: readonly { readonly uuid: string; readonly name: string }[];
  })[];
  readonly servers: readonly Res[];
  readonly projects: readonly Res[];
  readonly deployments: readonly {
    readonly uuid: string;
    readonly status: string;
    readonly application: string | null;
  }[];
  readonly notes: readonly string[];
}

export interface Res {
  readonly uuid: string;
  readonly name: string;
  readonly status: string;
  readonly detail: string | null;
  readonly controlPlane: boolean;
}

function res(v: unknown, detail: (y: Json) => string | null = () => null): Res {
  const y = obj(v);
  return {
    uuid: s(y.uuid),
    name: s(y.name),
    status: s(y.status),
    detail: detail(y),
    controlPlane: y.controlPlane === true,
  };
}

export function parseOverview(v: unknown): Overview {
  const o = obj(v);
  const c = obj(o.connection);
  return {
    connection: {
      version: ns(c.version),
      manageApps: c.manageApps === true,
      storageApi: s(obj(c.features).storages),
      permissions: c.permissions === null || c.permissions === undefined ? null : obj(c.permissions),
    },
    applications: arr(o.applications).map((x) => res(x, (y) => ns(y.fqdn))),
    databases: arr(o.databases).map((x) => res(x, (y) => ns(y.engine))),
    services: arr(o.services).map((x) => {
      const y = obj(x);
      return {
        ...res(x, (z) => ns(z.type)),
        parts: [...arr(y.applications), ...arr(y.databases)].map((p) => ({
          uuid: s(obj(p).uuid),
          name: s(obj(p).name),
        })),
      };
    }),
    servers: arr(o.servers).map((x) => res(x, (y) => ns(y.ip))),
    projects: arr(o.projects).map((x) => res(x, (y) => ns(y.description))),
    deployments: arr(o.deployments).map((x) => {
      const y = obj(x);
      return { uuid: s(y.deploymentUuid), status: s(y.status), application: ns(y.applicationName) };
    }),
    notes: strs(o.notes),
  };
}

const conn = (id: string): string => `/integrations/coolify/connections/${enc(id)}`;

export function getOverview(connection: string, opts: Opts = {}): Promise<Overview> {
  return apiRequest('GET', `${conn(connection)}/resources`, parseOverview, opts);
}

export interface Backup {
  readonly uuid: string;
  readonly frequency: string;
  readonly enabled: boolean;
  readonly last: string | null;
}

export function getDatabaseBackups(connection: string, uuid: string, opts: Opts = {}): Promise<Backup[]> {
  return apiRequest(
    'GET',
    `${conn(connection)}/resources/database/${enc(uuid)}`,
    (v) =>
      arr(obj(v).backups).map((x) => {
        const y = obj(x);
        const last = obj(y.lastExecution);
        return {
          uuid: s(y.uuid),
          frequency: s(y.frequency),
          enabled: y.enabled !== false,
          last: ns(last.status) === null ? null : `${s(last.status)} ${s(last.at)}`.trim(),
        };
      }),
    opts,
  );
}

export function createDatabase(connection: string, body: Json, opts: Opts = {}): Promise<WriteResult> {
  return apiRequest('POST', `${conn(connection)}/databases`, parseWrite, { ...opts, body });
}

export function createBackup(
  connection: string,
  db: string,
  body: Json,
  opts: Opts = {},
): Promise<WriteResult> {
  return apiRequest('POST', `${conn(connection)}/databases/${enc(db)}/backups`, parseWrite, {
    ...opts,
    body,
  });
}

export function runBackup(
  connection: string,
  db: string,
  backup: string,
  opts: Opts = {},
): Promise<WriteResult> {
  return apiRequest('PATCH', `${conn(connection)}/databases/${enc(db)}/backups/${enc(backup)}`, parseWrite, {
    ...opts,
    body: { backupNow: true },
  });
}

export function deleteBackup(
  connection: string,
  db: string,
  backup: string,
  opts: Opts = {},
): Promise<WriteResult> {
  return apiRequest(
    'DELETE',
    `${conn(connection)}/databases/${enc(db)}/backups/${enc(backup)}`,
    parseWrite,
    opts,
  );
}

export function deleteResource(
  connection: string,
  kind: 'database' | 'service',
  uuid: string,
  confirm: string,
  deleteVolumes: boolean,
  opts: Opts = {},
): Promise<WriteResult> {
  return apiRequest(
    'DELETE',
    `${conn(connection)}/${kind}s/${enc(uuid)}?confirm=${enc(confirm)}&deleteVolumes=${deleteVolumes ? 'true' : 'false'}`,
    parseWrite,
    opts,
  );
}

export function createService(connection: string, body: Json, opts: Opts = {}): Promise<WriteResult> {
  return apiRequest('POST', `${conn(connection)}/services`, parseWrite, { ...opts, body });
}

export function setServiceEnvs(
  connection: string,
  uuid: string,
  body: Json,
  opts: Opts = {},
): Promise<WriteResult> {
  return apiRequest('PUT', `${conn(connection)}/services/${enc(uuid)}/envs`, parseWrite, { ...opts, body });
}

export function validateServer(connection: string, uuid: string, opts: Opts = {}): Promise<WriteResult> {
  return apiRequest('POST', `${conn(connection)}/servers/${enc(uuid)}/validate`, parseWrite, opts);
}

export interface ServerView {
  readonly resources: readonly { readonly name: string; readonly type: string; readonly status: string }[];
  readonly domains: readonly string[];
}

export function getServer(connection: string, uuid: string, opts: Opts = {}): Promise<ServerView> {
  return apiRequest(
    'GET',
    `${conn(connection)}/servers/${enc(uuid)}`,
    (v) => {
      const o = obj(v);
      return {
        resources: arr(o.resources).map((x) => {
          const y = obj(x);
          return { name: s(y.name), type: s(y.type), status: s(y.status) };
        }),
        domains: arr(o.domains).flatMap((x) => strs(obj(x).domains)),
      };
    },
    opts,
  );
}

export function getEnvironments(
  connection: string,
  project: string,
  opts: Opts = {},
): Promise<{ name: string; uuid: string | null }[]> {
  return apiRequest(
    'GET',
    `${conn(connection)}/projects/${enc(project)}/environments`,
    (v) => arr(obj(v).items).map((x) => ({ name: s(obj(x).name), uuid: ns(obj(x).uuid) })),
    opts,
  );
}

export function createProject(connection: string, name: string, opts: Opts = {}): Promise<WriteResult> {
  return apiRequest('POST', `${conn(connection)}/projects`, parseWrite, { ...opts, body: { name } });
}

export function deleteProject(
  connection: string,
  uuid: string,
  confirm: string,
  opts: Opts = {},
): Promise<WriteResult> {
  return apiRequest(
    'DELETE',
    `${conn(connection)}/projects/${enc(uuid)}?confirm=${enc(confirm)}`,
    parseWrite,
    opts,
  );
}

export function createEnvironment(
  connection: string,
  project: string,
  name: string,
  opts: Opts = {},
): Promise<WriteResult> {
  return apiRequest('POST', `${conn(connection)}/projects/${enc(project)}/environments`, parseWrite, {
    ...opts,
    body: { name },
  });
}

export function deleteEnvironment(
  connection: string,
  project: string,
  name: string,
  opts: Opts = {},
): Promise<WriteResult> {
  return apiRequest(
    'DELETE',
    `${conn(connection)}/projects/${enc(project)}/environments/${enc(name)}?confirm=${enc(name)}`,
    parseWrite,
    opts,
  );
}

export function cancelDeployment(connection: string, uuid: string, opts: Opts = {}): Promise<WriteResult> {
  return apiRequest('POST', `${conn(connection)}/deployments/${enc(uuid)}/cancel`, parseWrite, opts);
}
