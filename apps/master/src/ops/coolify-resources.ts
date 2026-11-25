import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import type { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import {
  type CoolifyApplication,
  type CoolifyFeatures,
  type CoolifyResource,
  type CoolifyResourceKind,
  type CoolifyStorage,
  type CoolifyStorageCreate,
  coolifyFeatures,
  ProviderCallError,
} from './coolify.js';
import { envWrite } from './coolify-apps.js';
import { issuesText } from './coolify-apps-model.js';
import type { CoolifyConnections, CoolifyHandle } from './coolify-connections.js';
import {
  BackupCreateInput,
  BackupUpdateInput,
  DatabaseCreateInput,
  type DbEngine,
  DatabaseUpdateInput,
  EnvironmentCreateInput,
  LifecycleInput,
  NameConfirmInput,
  ProjectCreateInput,
  ResourceDeleteInput,
  ResourceLogsQuery,
  ServiceCreateInput,
  ServiceEnvsInput,
  ServiceUpdateInput,
  StorageAddInput,
  StorageRemoveInput,
  StorageUpdateInput,
} from './coolify-resources-model.js';
import { OpsError, type OpsVia } from './model.js';
import { coolifyDenyReason } from './policy.js';
import { providerText, type OpsActor } from './service.js';

/**
 * p17-coolify-full (docs/design/p17-coolify-full.md §5): everything Remyral does with a Coolify connection beyond
 * creating and changing a project's applications — storages (volumes, file and directory mounts), start / stop /
 * restart, logs, running deployments, databases (+ backups), services, servers, projects and environments.
 *
 * Two callers: the Coolify-wide panel and tools (Ayarlar → Entegrasyonlar → Coolify → Kaynaklar; global admin,
 * `coolify.read` / `coolify.manage`) address a connection directly; the project panel (Projeler → Deploy) resolves a
 * project application to its connection first ({@link CoolifyAppService}) and calls the same operations.
 *
 * Rules (all enforced here):
 * - every write needs the connection's "Uygulama yönetimi" switch (ADR-0057) and is audited `ops.coolify.<area>.<op>`;
 * - probe-aware: a write the token's last connection test showed it cannot do (write / deploy) is refused before
 *   Coolify is called, with the permission it needs; logs say when `read:sensitive` is missing;
 * - version-aware: storages need Coolify ≥ v4.0.0-beta.470 — an older instance gets the exact manual step;
 * - control plane: a deny-listed resource (and an application serving the console host) is read-only; deleting a
 *   resource that lives next to the control plane, or a server / project / environment holding it, is refused;
 * - deletions name the resource (typed confirmation) and say what is lost; volumes are kept unless asked;
 * - secrets never pass: database passwords only from the panel (never stored, logged or audited), variable values and
 *   file contents never audited, connection URLs / passwords / compose text never returned.
 */

export interface CoolifyResourceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly connections: CoolifyConnections;
  /** The console host and other always-protected hosts (lower-case). */
  readonly protectedHosts: readonly string[];
  readonly liveProtectedHosts?: () => readonly string[];
}

/** Where a write comes from and how it is audited / redeployed. */
export interface ResourceCtx {
  readonly h: CoolifyHandle;
  readonly actor: OpsActor;
  readonly via: OpsVia;
  /** Audit target: `coolify-connection:<id>` or `project:<id>`. */
  readonly target: string;
  /** Project-scope callers redeploy through the project's deploy policy (an ops action); null: a direct Coolify deploy. */
  readonly redeploy?: ((uuid: string, warnings: string[]) => Promise<DeployOutcome | null>) | null;
}

export interface DeployOutcome {
  readonly actionId: string | null;
  readonly state: string | null;
  readonly deploymentUuid: string | null;
}

/** A data path without a storage (the storage view's warning). */
export interface DataPathWarning {
  readonly path: string;
  /** `env:<KEY>` (a variable names it) or `remembered` (Remyral put it on a storage before). */
  readonly source: string;
  readonly message: string;
}

export interface StoragesView {
  readonly kind: CoolifyResourceKind;
  readonly uuid: string;
  readonly name: string;
  readonly storages: CoolifyStorage[];
  readonly dataWarnings: DataPathWarning[];
  readonly features: CoolifyFeatures;
  /** Set when this Coolify cannot list storages (the manual step instead). */
  readonly unsupported: string | null;
  readonly controlPlane: boolean;
  readonly notes: string[];
}

const ABILITY_TEXT = {
  write: 'write',
  deploy: 'deploy',
  readSensitive: 'read:sensitive',
} as const;

/** The volume-takes-effect notice (by design, it always says that the container's data is not copied). */
export function volumeNotice(mountPath: string, deployed: boolean): string {
  return (
    `${deployed ? 'The redeploy mounts the storage' : 'The storage takes effect with the next deploy (redeploy)'} at ${mountPath}. ` +
    `It starts empty: whatever the running container has at ${mountPath} now is lost at that redeploy unless it is ` +
    'copied out first (for example `docker cp` on the server) — Coolify has no API to copy data into a volume.'
  );
}

/** The manual step when this Coolify has no storage API. */
export function storageManualStep(
  version: string | null,
  resource: string,
  mountPath = '/data',
  name = 'data',
): string {
  return (
    `This Coolify (${version ?? 'unknown version'}) has no API for persistent storage (it came with v4.0.0-beta.470). ` +
    `In Coolify: open ${resource} → Configuration → Persistent Storage → + Add → Volume Mount → name “${name}”, ` +
    `destination path ${mountPath} → Save, then Redeploy. Or update Coolify and try again.`
  );
}

/** The manual step as an error (the console says it in the user's language from `params`). */
function unsupportedError(
  version: string | null,
  resource: string,
  mountPath = '/data',
  name = 'data',
): HttpError {
  return new HttpError(
    409,
    'coolify_storage_unsupported',
    storageManualStep(version, resource, mountPath, name),
    {},
    {},
    { version: version ?? '?', resource, path: mountPath },
  );
}

/** A deletion whose typed confirmation does not name the resource. */
function mismatchError(expected: string): HttpError {
  return new HttpError(400, 'confirmation_mismatch', `Type ${expected} to confirm.`, {}, {}, { expected });
}

function under(path: string, mount: string): boolean {
  const m = mount.replace(/\/+$/, '');
  return m === '' || path === m || path.startsWith(`${m}/`);
}

const DB_FIELDS: Readonly<Record<DbEngine, { user?: string; database?: string; password?: string }>> = {
  postgresql: { user: 'postgres_user', database: 'postgres_db', password: 'postgres_password' },
  mysql: { user: 'mysql_user', database: 'mysql_database', password: 'mysql_password' },
  mariadb: { user: 'mariadb_user', database: 'mariadb_database', password: 'mariadb_password' },
  mongodb: { user: 'mongo_initdb_root_username' },
  redis: { password: 'redis_password' },
  keydb: { password: 'keydb_password' },
  dragonfly: { password: 'dragonfly_password' },
  clickhouse: { user: 'clickhouse_admin_user', password: 'clickhouse_admin_password' },
};

export class CoolifyResourceService {
  readonly #redactor = new Redactor({ rules: DEFAULT_RULES });

  constructor(private readonly deps: CoolifyResourceDeps) {}

  get #protected(): ReadonlySet<string> {
    return new Set(
      [...this.deps.protectedHosts, ...(this.deps.liveProtectedHosts?.() ?? [])].map((h) => h.toLowerCase()),
    );
  }

  // ------------------------------------------------------------------------------------------- helpers

  /** A Coolify-wide connection (global admins; no project allowlist). */
  async handle(connection: string): Promise<CoolifyHandle> {
    const h = await this.deps.connections.handle(connection);
    if (h === null) {
      const exists = await this.deps.connections.get(connection);
      throw new HttpError(
        exists === null ? 404 : 409,
        exists === null ? 'connection_not_found' : 'coolify_not_configured',
        exists === null
          ? 'Coolify connection not found.'
          : `The Coolify connection “${exists.label}” cannot be used (its token does not decrypt, or its URL is refused) — enter the token again.`,
      );
    }
    return h;
  }

  /** The connection a Coolify-wide request means: the given one, else the default (409 when there is none). */
  async connectionId(explicit: string | null | undefined): Promise<string> {
    if (typeof explicit === 'string' && explicit !== '') return explicit;
    const def = await this.deps.connections.defaultId();
    if (def === null) {
      throw new HttpError(
        409,
        'coolify_not_configured',
        'Coolify is not connected (Settings → Integrations → Coolify).',
      );
    }
    return def;
  }

  /** The connections (id, label, default) — for the assistant's choices. */
  async connectionChoices(): Promise<
    { id: string; label: string; isDefault: boolean; manageApps: boolean }[]
  > {
    return (await this.deps.connections.list()).map((c) => ({
      id: c.id,
      label: c.label,
      isDefault: c.isDefault,
      manageApps: c.manageApps,
    }));
  }

  /** The connection-scope context of a write. */
  ctxFor(h: CoolifyHandle, actor: OpsActor, via: OpsVia): ResourceCtx {
    return { h, actor, via, target: `coolify-connection:${h.id}`, redeploy: null };
  }

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

  #requireManage(h: CoolifyHandle): void {
    if (!h.manageApps) {
      throw new HttpError(
        409,
        'coolify_manage_disabled',
        `Changing resources is off for the Coolify connection “${h.label}” (Ayarlar → Entegrasyonlar → Coolify → Uygulama yönetimi; its token then needs the "write" and "deploy" permissions).`,
      );
    }
  }

  /** Probe-aware: refuse what the last connection test showed the token cannot do (null / no test: try). */
  #need(h: CoolifyHandle, ability: 'write' | 'deploy' | 'readSensitive', what: string): void {
    if (h.lastTest?.permissions?.[ability] !== false) return;
    const code =
      ability === 'write'
        ? 'coolify_token_lacks_write'
        : ability === 'deploy'
          ? 'coolify_token_lacks_deploy'
          : 'coolify_token_lacks_read_sensitive';
    throw new HttpError(
      409,
      code,
      `The token of the Coolify connection “${h.label}” lacks the "${ABILITY_TEXT[ability]}" permission (last connection test), which ${what} needs. Create a token with it in Coolify → Keys & Tokens and enter it in Ayarlar → Entegrasyonlar → Coolify, then Test.`,
      {},
      {},
      { label: h.label },
    );
  }

  async #audit(
    ctx: { actor: OpsActor; target: string },
    action: string,
    outcome: 'success' | 'failure' | 'denied',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: ctx.actor.type, id: ctx.actor.id },
      action,
      target: ctx.target,
      outcome,
      ip: ctx.actor.ip ?? null,
      userAgent: ctx.actor.userAgent ?? null,
      metadata,
    });
  }

  /** Runs a write: audits success (with `meta` + the result's `audit`) or failure, then rethrows. */
  async #write(
    ctx: ResourceCtx,
    action: string,
    meta: Record<string, unknown>,
    fn: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const base = { connection: { id: ctx.h.id, label: ctx.h.label }, via: ctx.via, ...meta };
    let out: Record<string, unknown>;
    try {
      out = await fn();
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 403) {
        await this.#audit(ctx, action, 'denied', { ...base, reason: err.code });
      } else {
        await this.#audit(ctx, action, 'failure', {
          ...base,
          error: err instanceof Error ? err.message.slice(0, 500) : 'failed',
        });
      }
      throw err;
    }
    const { audit, ...rest } = out;
    await this.#audit(ctx, action, 'success', {
      ...base,
      ...(typeof audit === 'object' && audit !== null ? (audit as Record<string, unknown>) : {}),
    });
    return rest;
  }

  #parse<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.infer<S> {
    const p = schema.safeParse(raw ?? {});
    if (!p.success) throw new HttpError(400, 'invalid_request', `Invalid ${what}: ${issuesText(p.error)}`);
    return p.data;
  }

  #denySet(h: CoolifyHandle): Set<string> {
    return this.deps.connections.denyUuids(h.settings);
  }

  /** Whether one entry of `GET /resources` (or an application) is the control plane. */
  #isControlPlane(h: CoolifyHandle, r: { uuid: string; fqdn?: string | null }): boolean {
    return (
      coolifyDenyReason(
        { uuid: r.uuid, fqdn: r.fqdn ?? '' },
        { denyUuids: this.#denySet(h), consoleHosts: this.#protected },
      ) !== null
    );
  }

  /** A resource of the connection with its name, status and environment (deny-checked for writes). */
  async #resource(
    h: CoolifyHandle,
    kind: CoolifyResourceKind,
    uuid: string,
  ): Promise<{
    uuid: string;
    name: string;
    status: string;
    environmentId: number | null;
    fqdn: string | null;
    controlPlane: boolean;
  }> {
    if (!/^[A-Za-z0-9]{6,64}$/.test(uuid)) {
      throw new HttpError(
        400,
        'invalid_request',
        'Invalid Coolify uuid.',
        {},
        {},
        { reason: 'coolify_uuid' },
      );
    }
    if (kind === 'application') {
      const a: CoolifyApplication = await this.#provider(() => h.client.application(uuid));
      return {
        uuid,
        name: a.name,
        status: a.status,
        environmentId: a.environmentId ?? null,
        fqdn: a.fqdn,
        controlPlane: this.#isControlPlane(h, a),
      };
    }
    if (kind === 'database') {
      const d = await this.#provider(() => h.client.database(uuid));
      return {
        uuid,
        name: d.name,
        status: d.status,
        environmentId: d.environmentId,
        fqdn: null,
        controlPlane: this.#denySet(h).has(uuid),
      };
    }
    const s = await this.#provider(() => h.client.service(uuid));
    const fqdn = s.applications
      .map((a) => a.fqdn ?? '')
      .filter((x) => x !== '')
      .join(',');
    return {
      uuid,
      name: s.name,
      status: s.status,
      environmentId: s.environmentId,
      fqdn,
      controlPlane: this.#isControlPlane(h, { uuid, fqdn }),
    };
  }

  /** The resource for a write: refused (403) when it is the control plane — or, for destructive writes, next to it. */
  async #writable(
    h: CoolifyHandle,
    kind: CoolifyResourceKind,
    uuid: string,
    destructive: boolean,
  ): Promise<{ uuid: string; name: string; status: string; environmentId: number | null }> {
    const r = await this.#resource(h, kind, uuid);
    if (r.controlPlane) {
      throw new HttpError(
        403,
        'control_plane_resource',
        `Coolify ${kind} ${r.name} (${uuid}) is part of the Remyral control plane; it is not changed from Remyral.`,
      );
    }
    if (destructive && r.environmentId !== null) {
      const all = await this.#provider(() => h.client.resources());
      const cp = all.find(
        (x) => x.uuid !== uuid && x.environmentId === r.environmentId && this.#isControlPlane(h, x),
      );
      if (cp !== undefined) {
        throw new HttpError(
          403,
          'control_plane_environment',
          `Coolify ${kind} ${r.name} lives next to the Remyral control plane (${cp.uuid}); it is not deleted from Remyral.`,
        );
      }
    }
    return r;
  }

  // -------------------------------------------------------------------------------------------- reads

  /**
   * The Coolify-wide view of a connection: version and token abilities (last test), applications, databases, services,
   * servers, projects and the deployments running now. A list the token cannot read is empty with a note.
   */
  async overview(connection: string): Promise<Record<string, unknown>> {
    const h = await this.handle(connection);
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
    const apps = await this.#provider(() => h.client.applications());
    const databases = await optional('databases', () => h.client.databases());
    const services = await optional('services', () => h.client.services());
    const servers = await optional('servers', () => h.client.servers());
    const projects = await optional('projects', () => h.client.projects());
    const deployments = await optional('running deployments', () => h.client.runningDeployments());
    const deny = this.#denySet(h);
    return {
      connection: this.#connectionView(h),
      applications: apps.map((a) => ({
        uuid: a.uuid,
        name: a.name,
        status: a.status,
        fqdn: a.fqdn === '' ? null : a.fqdn,
        environmentId: a.environmentId ?? null,
        gitRepository: a.gitRepository ?? null,
        gitBranch: a.gitBranch,
        controlPlane: this.#isControlPlane(h, a),
      })),
      databases: databases.map((d) => ({ ...d, controlPlane: deny.has(d.uuid) })),
      services: services.map((s) => ({
        ...s,
        controlPlane: this.#isControlPlane(h, {
          uuid: s.uuid,
          fqdn: s.applications.map((a) => a.fqdn ?? '').join(','),
        }),
      })),
      servers: servers.map((s) => ({ ...s, controlPlane: deny.has(s.uuid) })),
      projects: projects.map((p) => ({ ...p, controlPlane: deny.has(p.uuid) })),
      deployments,
      notes,
    };
  }

  #connectionView(h: CoolifyHandle): Record<string, unknown> {
    const version = h.lastTest?.version ?? null;
    return {
      id: h.id,
      label: h.label,
      manageApps: h.manageApps,
      version,
      permissions: h.lastTest?.permissions ?? null,
      features: coolifyFeatures(version),
    };
  }

  /** `GET /resources` filtered by name (case-insensitive, contains) — the assistant's way to find a resource. */
  async find(
    connection: string,
    q: { query?: string | null; kind?: CoolifyResourceKind | null },
  ): Promise<(CoolifyResource & { controlPlane: boolean })[]> {
    const h = await this.handle(connection);
    const all = await this.#provider(() => h.client.resources());
    const needle = (q.query ?? '').trim().toLowerCase();
    return all
      .filter(
        (r) =>
          (q.kind == null || r.kind === q.kind) && (needle === '' || r.name.toLowerCase().includes(needle)),
      )
      .slice(0, 50)
      .map((r) => ({ ...r, controlPlane: this.#isControlPlane(h, r) }));
  }

  /** One resource: status and what its panel shows (storages separately). Never a password, URL or compose text. */
  async details(
    connection: string,
    kind: CoolifyResourceKind,
    uuid: string,
  ): Promise<Record<string, unknown>> {
    const h = await this.handle(connection);
    const r = await this.#resource(h, kind, uuid);
    const notes: string[] = [];
    const base = { kind, uuid, name: r.name, status: r.status, controlPlane: r.controlPlane };
    if (kind === 'application') {
      const details = await this.#provider(() => h.client.applicationDetails(uuid));
      const envs = await this.#provider(() => h.client.envs(uuid));
      return {
        ...base,
        application: details,
        envKeys: envs.map((e) => ({ key: e.key, preview: e.isPreview, shared: e.sharedRef })),
        notes,
      };
    }
    if (kind === 'database') {
      const db = await this.#provider(() => h.client.database(uuid));
      const backups = await h.client.databaseBackups(uuid).catch((err: unknown) => {
        if (err instanceof ProviderCallError) {
          notes.push(`backups: ${err.message}`);
          return [];
        }
        throw err;
      });
      return { ...base, database: db, backups, notes };
    }
    const svc = await this.#provider(() => h.client.service(uuid));
    const envs = await h.client.envsOf('service', uuid).catch((err: unknown) => {
      if (err instanceof ProviderCallError) {
        notes.push(`variables: ${err.message}`);
        return [];
      }
      throw err;
    });
    return {
      ...base,
      service: svc,
      envKeys: envs.map((e) => ({ key: e.key, preview: e.isPreview, shared: e.sharedRef })),
      notes,
    };
  }

  /** The data paths that must be persistent: remembered ones and those a variable names. */
  async #dataPaths(
    h: CoolifyHandle,
    kind: CoolifyResourceKind,
    uuid: string,
    notes: string[],
  ): Promise<{ path: string; source: string }[]> {
    const out: { path: string; source: string }[] = [];
    const { rows } = await this.deps.pool.query<{ path: string }>(
      'SELECT path FROM coolify_data_paths WHERE connection_id = $1 AND resource_uuid = $2 ORDER BY path',
      [h.id, uuid],
    );
    for (const r of rows) out.push({ path: r.path, source: 'remembered' });
    if (kind !== 'database') {
      try {
        for (const e of await h.client.envDataPaths(kind, uuid)) {
          if (!out.some((o) => o.path === e.path)) out.push({ path: e.path, source: `env:${e.key}` });
        }
      } catch (err) {
        if (!(err instanceof ProviderCallError)) throw err;
        notes.push(`variables could not be read for the data-path check: ${err.message.slice(0, 200)}`);
      }
    }
    return out;
  }

  /**
   * The storages of a resource (volumes, file / directory mounts; file contents never returned) with warnings for
   * data paths that have none ("volume yok, kalıcı değil"). On a Coolify without the storage API: `unsupported` holds
   * the manual step.
   */
  async storagesOf(h: CoolifyHandle, kind: CoolifyResourceKind, uuid: string): Promise<StoragesView> {
    const r = await this.#resource(h, kind, uuid);
    const features = coolifyFeatures(h.lastTest?.version ?? null);
    const notes: string[] = [];
    const manual = storageManualStep(h.lastTest?.version ?? null, `the ${kind} “${r.name}”`);
    if (features.storages === 'none') {
      return {
        kind,
        uuid,
        name: r.name,
        storages: [],
        dataWarnings: [],
        features,
        unsupported: manual,
        controlPlane: r.controlPlane,
        notes,
      };
    }
    let storages: CoolifyStorage[];
    try {
      storages = await h.client.storages(kind, uuid);
    } catch (err) {
      if (err instanceof ProviderCallError && err.code === 'unsupported') {
        return {
          kind,
          uuid,
          name: r.name,
          storages: [],
          dataWarnings: [],
          features: { ...features, storages: 'none' },
          unsupported: manual,
          controlPlane: r.controlPlane,
          notes,
        };
      }
      return this.#provider(() => Promise.reject(err as Error));
    }
    const paths = await this.#dataPaths(h, kind, uuid, notes);
    const dataWarnings = paths
      .filter(
        (p) =>
          !storages.some(
            (s) => (s.type === 'persistent' || s.mount === 'directory') && under(p.path, s.mountPath),
          ),
      )
      .map((p) => ({
        ...p,
        message: `${p.path} is on no persistent storage: what the application writes there is lost at every deploy (no volume — not persistent).`,
      }));
    if (features.storages === 'read')
      notes.push(storageManualStep(h.lastTest?.version ?? null, `the ${kind} “${r.name}”`));
    return {
      kind,
      uuid,
      name: r.name,
      storages,
      dataWarnings,
      features,
      unsupported: null,
      controlPlane: r.controlPlane,
      notes,
    };
  }

  /** Connection-scope storages view. */
  async storages(connection: string, kind: CoolifyResourceKind, uuid: string): Promise<StoragesView> {
    return this.storagesOf(await this.handle(connection), kind, uuid);
  }

  #clean(text: string, max = 24_000): { text: string; truncated: boolean } {
    const clean = this.#redactor.redact(text);
    return clean.length > max
      ? { text: clean.slice(clean.length - max), truncated: true }
      : { text: clean, truncated: false };
  }

  /** Container output of an application, database or service sub-resource (redacted, tail-capped; DATA). */
  async logsOf(
    h: CoolifyHandle,
    kind: CoolifyResourceKind,
    uuid: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const q = this.#parse(ResourceLogsQuery, raw, 'log request');
    const r = await this.#resource(h, kind, uuid);
    this.#need(h, 'readSensitive', 'reading logs');
    const notes: string[] = [];
    let sub = q.sub ?? null;
    if (kind === 'service' && sub === null) {
      const svc = await this.#provider(() => h.client.service(uuid));
      const names = [...svc.applications.map((a) => a.name), ...svc.databases.map((d) => d.name)];
      if (names.length !== 1) {
        throw new HttpError(
          400,
          'invalid_request',
          `Name the part of the service whose logs to read (sub): ${names.join(', ') || 'none found'}.`,
          {},
          {},
          { reason: 'service_sub', services: names.join(', ') || '—' },
        );
      }
      sub = names[0] ?? null;
    }
    let text: { text: string; truncated: boolean } | null = null;
    try {
      const raw =
        kind === 'application'
          ? await h.client.applicationLogs(uuid, q.lines)
          : await h.client.resourceLogs(kind, uuid, q.lines, sub ?? undefined);
      text = this.#clean(raw);
    } catch (err) {
      if (err instanceof ProviderCallError && err.code === 'not_found') {
        notes.push('No running container: start it, or read the last deployment log.');
      } else if (err instanceof ProviderCallError && err.code === 'forbidden') {
        notes.push('The token cannot read logs: it needs the "read:sensitive" permission.');
      } else {
        await this.#provider(() => Promise.reject(err as Error));
      }
    }
    return { kind, uuid, name: r.name, status: r.status, sub, logs: text, notes };
  }

  async logs(
    connection: string,
    kind: CoolifyResourceKind,
    uuid: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    return this.logsOf(await this.handle(connection), kind, uuid, raw);
  }

  /** A server with its resources and domains. */
  async server(connection: string, uuid: string): Promise<Record<string, unknown>> {
    const h = await this.handle(connection);
    const notes: string[] = [];
    const server = await this.#provider(() => h.client.server(uuid));
    const soft = async <T>(what: string, fn: () => Promise<T[]>): Promise<T[]> =>
      fn().catch((err: unknown) => {
        if (err instanceof ProviderCallError) {
          notes.push(`${what}: ${err.message}`);
          return [];
        }
        throw err;
      });
    const resources = await soft('resources', () => h.client.serverResources(uuid));
    const domains = await soft('domains', () => h.client.serverDomains(uuid));
    return { server: { ...server, controlPlane: this.#denySet(h).has(uuid) }, resources, domains, notes };
  }

  /** Environments of a Coolify project. */
  async environments(connection: string, project: string): Promise<Record<string, unknown>> {
    const h = await this.handle(connection);
    return { items: await this.#provider(() => h.client.environments(project)) };
  }

  /** Executions of one backup schedule (no messages). */
  async backupExecutions(connection: string, db: string, backup: string): Promise<Record<string, unknown>> {
    const h = await this.handle(connection);
    await this.#resource(h, 'database', db);
    return { items: await this.#provider(() => h.client.backupExecutions(db, backup)) };
  }

  // ------------------------------------------------------------------------------------------ storages

  /** Coolify ≥ beta.470, or unknown (then tried); else the manual step. */
  #storageWritable(h: CoolifyHandle, resource: string, mountPath: string, name?: string): void {
    const f = coolifyFeatures(h.lastTest?.version ?? null);
    if (f.storages === 'none' || f.storages === 'read') {
      throw unsupportedError(h.lastTest?.version ?? null, resource, mountPath, name);
    }
  }

  /**
   * Adds a volume, a file mount or a host directory to an application, database or service (sub-resource). The
   * volume's path is remembered as a data path (the view warns when it loses its storage). A redeploy is requested
   * when asked (the volume takes effect then); the answer always says that the container's current data at that path
   * is not copied.
   */
  async addStorage(
    ctx: ResourceCtx,
    kind: CoolifyResourceKind,
    uuid: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const i = this.#parse(StorageAddInput, raw, 'storage');
    const { h } = ctx;
    const meta = {
      kind,
      resourceUuid: uuid,
      mount: i.mount,
      mountPath: i.mountPath,
      ...(i.mount === 'volume' ? { name: i.name } : {}),
      ...(i.hostPath === undefined ? {} : { hostPath: i.hostPath }),
      ...(i.mount === 'file' && i.content !== undefined
        ? { contentBytes: Buffer.byteLength(i.content, 'utf8') }
        : {}),
    };
    return this.#write(ctx, 'ops.coolify.storage.add', meta, async () => {
      this.#requireManage(h);
      this.#need(h, 'write', 'adding a storage');
      if (
        i.mount !== 'volume' &&
        (i.hostPath !== undefined || (i.mount === 'file' && i.content !== undefined))
      ) {
        this.#need(h, 'deploy', 'a file or directory mount on a host path or with content');
      }
      const r = await this.#writable(h, kind, uuid, false);
      this.#storageWritable(
        h,
        `the ${kind} “${r.name}”`,
        i.mountPath,
        i.mount === 'volume' ? i.name : undefined,
      );
      if (kind === 'service' && i.resourceUuid === undefined) {
        const svc = await this.#provider(() => h.client.service(uuid));
        const subs = [...svc.applications, ...svc.databases];
        throw new HttpError(
          400,
          'invalid_request',
          `Name the part of the service the storage belongs to (resourceUuid): ${subs.map((s) => `${s.name} (${s.uuid})`).join(', ') || 'none found'}.`,
          {},
          {},
          { reason: 'service_sub', services: subs.map((s) => s.name).join(', ') || '—' },
        );
      }
      let existing: CoolifyStorage[] = [];
      try {
        existing = await h.client.storages(kind, uuid);
      } catch (err) {
        if (err instanceof ProviderCallError && err.code === 'unsupported') {
          throw unsupportedError(h.lastTest?.version ?? null, `the ${kind} “${r.name}”`, i.mountPath);
        }
        await this.#provider(() => Promise.reject(err as Error));
      }
      const clash = existing.find(
        (s) =>
          s.mountPath === i.mountPath && (i.resourceUuid === undefined || s.resourceUuid === i.resourceUuid),
      );
      if (clash !== undefined) {
        throw new HttpError(
          409,
          'storage_exists',
          `${r.name} already has a storage at ${i.mountPath} (${clash.name ?? clash.mount}); change or remove it instead.`,
          {},
          {},
          { path: i.mountPath },
        );
      }
      const sub = i.resourceUuid === undefined ? {} : { resource_uuid: i.resourceUuid };
      const features = coolifyFeatures(h.lastTest?.version ?? null);
      const warnings: string[] = [];
      let created: CoolifyStorage;
      const create = (body: CoolifyStorageCreate) =>
        h.client.createStorage(kind, uuid, body).catch((err: unknown) => {
          if (err instanceof ProviderCallError && err.code === 'unsupported') {
            throw unsupportedError(h.lastTest?.version ?? null, `the ${kind} “${r.name}”`, i.mountPath);
          }
          throw err;
        });
      if (i.mount === 'volume') {
        const asDirectory: CoolifyStorageCreate = {
          type: 'file',
          mount_path: i.mountPath,
          is_directory: true,
          fs_path: i.hostPath ?? '',
          ...sub,
        };
        if (i.hostPath !== undefined && features.volumeHostPath === false) {
          warnings.push(
            `This Coolify has no host path on a volume (since v4.3): ${i.hostPath} is mounted as a directory mount instead.`,
          );
          created = await this.#provider(() => create(asDirectory));
        } else {
          const body: CoolifyStorageCreate = {
            type: 'persistent',
            name: i.name,
            mount_path: i.mountPath,
            ...(i.hostPath === undefined ? {} : { host_path: i.hostPath }),
            ...sub,
          };
          try {
            created = await create(body);
          } catch (err) {
            // Unknown version: a 4.3+ instance refuses host_path → a directory mount on that path.
            if (
              i.hostPath !== undefined &&
              err instanceof ProviderCallError &&
              err.code === 'invalid' &&
              err.details?.host_path !== undefined
            ) {
              warnings.push(
                `This Coolify has no host path on a volume: ${i.hostPath} is mounted as a directory mount instead.`,
              );
              created = await this.#provider(() => create(asDirectory));
            } else {
              return this.#provider(() => Promise.reject(err as Error));
            }
          }
        }
      } else if (i.mount === 'directory') {
        created = await this.#provider(() =>
          create({ type: 'file', mount_path: i.mountPath, is_directory: true, fs_path: i.hostPath, ...sub }),
        );
      } else {
        created = await this.#provider(() =>
          create({
            type: 'file',
            mount_path: i.mountPath,
            ...(i.content === undefined ? {} : { content: i.content }),
            ...(i.hostPath === undefined ? {} : { fs_path: i.hostPath }),
            ...sub,
          }),
        );
      }
      if (i.mount !== 'file') {
        await this.deps.pool.query(
          `INSERT INTO coolify_data_paths (connection_id, resource_uuid, path, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [h.id, uuid, i.mountPath, ctx.actor.type === 'user' ? ctx.actor.id : null, this.deps.clock()],
        );
      }
      const dep = i.deploy ? await this.#redeploy(ctx, kind, uuid, warnings) : null;
      warnings.push(volumeNotice(i.mountPath, dep !== null));
      return {
        resource: { kind, uuid, name: r.name },
        storage: created,
        deploy: dep,
        warnings,
        audit: { storageUuid: created.uuid, deploy: dep },
      };
    });
  }

  /** The storage of a resource by uuid (404 when it has none such). */
  async #storage(
    h: CoolifyHandle,
    kind: CoolifyResourceKind,
    uuid: string,
    storage: string,
  ): Promise<CoolifyStorage> {
    const all = await this.#provider(() => h.client.storages(kind, uuid));
    const s = all.find((x) => x.uuid === storage);
    if (s === undefined) throw new HttpError(404, 'storage_not_found', `Storage ${storage} not found.`);
    return s;
  }

  async updateStorage(
    ctx: ResourceCtx,
    kind: CoolifyResourceKind,
    uuid: string,
    storage: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const i = this.#parse(StorageUpdateInput, raw, 'storage change');
    const { h } = ctx;
    const meta = {
      kind,
      resourceUuid: uuid,
      storageUuid: storage,
      changes: {
        ...(i.name === undefined ? {} : { name: i.name }),
        ...(i.mountPath === undefined ? {} : { mountPath: i.mountPath }),
        ...(i.hostPath === undefined ? {} : { hostPath: i.hostPath }),
        ...(i.content === undefined ? {} : { content: '(set)' }),
      },
    };
    return this.#write(ctx, 'ops.coolify.storage.update', meta, async () => {
      this.#requireManage(h);
      this.#need(h, 'write', 'changing a storage');
      if (i.content !== undefined) this.#need(h, 'deploy', 'changing a file mount’s content');
      const r = await this.#writable(h, kind, uuid, false);
      this.#storageWritable(h, `the ${kind} “${r.name}”`, i.mountPath ?? '/data');
      const cur = await this.#storage(h, kind, uuid, storage);
      if (cur.readOnly) {
        throw new HttpError(
          409,
          'storage_read_only',
          `The storage at ${cur.mountPath} is managed by a compose file or service definition; change it there.`,
        );
      }
      await this.#provider(() =>
        h.client.updateStorage(kind, uuid, {
          uuid: storage,
          type: cur.type,
          ...(i.name === undefined || cur.type !== 'persistent' ? {} : { name: i.name }),
          ...(i.mountPath === undefined ? {} : { mount_path: i.mountPath }),
          ...(i.hostPath === undefined || cur.type !== 'persistent' ? {} : { host_path: i.hostPath }),
          ...(i.content === undefined || cur.type !== 'file' ? {} : { content: i.content }),
        }),
      );
      if (i.mountPath !== undefined && cur.type === 'persistent') {
        await this.deps.pool.query(
          `INSERT INTO coolify_data_paths (connection_id, resource_uuid, path, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [h.id, uuid, i.mountPath, ctx.actor.type === 'user' ? ctx.actor.id : null, this.deps.clock()],
        );
      }
      const warnings: string[] = [];
      const dep = i.deploy ? await this.#redeploy(ctx, kind, uuid, warnings) : null;
      if (!i.deploy) warnings.push('The change takes effect with the next deploy (redeploy).');
      return {
        resource: { kind, uuid, name: r.name },
        storageUuid: storage,
        deploy: dep,
        warnings,
        audit: { deploy: dep },
      };
    });
  }

  /**
   * Removes a storage after the user typed its volume name or mount path. Says what is lost: the container no longer
   * sees that data after the next deploy (a file / directory mount Coolify created is deleted on the server).
   */
  async removeStorage(
    ctx: ResourceCtx,
    kind: CoolifyResourceKind,
    uuid: string,
    storage: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const i = this.#parse(StorageRemoveInput, raw, 'storage removal');
    const { h } = ctx;
    return this.#write(
      ctx,
      'ops.coolify.storage.remove',
      { kind, resourceUuid: uuid, storageUuid: storage },
      async () => {
        this.#requireManage(h);
        this.#need(h, 'write', 'removing a storage');
        const r = await this.#writable(h, kind, uuid, true);
        this.#storageWritable(h, `the ${kind} “${r.name}”`, '/data');
        const cur = await this.#storage(h, kind, uuid, storage);
        const names = [cur.name, cur.mountPath, cur.name?.replace(new RegExp(`^${uuid}-`), '')].filter(
          (x): x is string => typeof x === 'string' && x !== '',
        );
        if (!names.includes(i.confirm)) {
          throw mismatchError(names.join(' / '));
        }
        if (cur.readOnly) {
          throw new HttpError(
            409,
            'storage_read_only',
            `The storage at ${cur.mountPath} is managed by a compose file or service definition; remove it there.`,
          );
        }
        await this.#provider(() => h.client.deleteStorage(kind, uuid, storage));
        await this.deps.pool.query(
          'DELETE FROM coolify_data_paths WHERE connection_id = $1 AND resource_uuid = $2 AND path = $3',
          [h.id, uuid, cur.mountPath],
        );
        const lost =
          cur.type === 'persistent'
            ? `The volume ${cur.name ?? ''} is no longer mounted at ${cur.mountPath}: after the next deploy the application writes there into the container only (lost at every deploy); the volume's data stays on the server until Coolify's cleanup removes unused volumes.`
            : `The ${cur.mount === 'file' ? 'file' : 'directory'} mount at ${cur.mountPath} is removed${cur.mount === 'file' ? ' with its file on the server' : ''}.`;
        const warnings = [lost];
        const dep = i.deploy ? await this.#redeploy(ctx, kind, uuid, warnings) : null;
        return {
          resource: { kind, uuid, name: r.name },
          removed: { uuid: storage, name: cur.name, mountPath: cur.mountPath, type: cur.type },
          lost,
          deploy: dep,
          warnings,
          audit: { name: cur.name, mountPath: cur.mountPath, type: cur.type, deploy: dep },
        };
      },
    );
  }

  /** Redeploy after a storage change: the project's ops action, else a direct Coolify deploy / restart. */
  async #redeploy(
    ctx: ResourceCtx,
    kind: CoolifyResourceKind,
    uuid: string,
    warnings: string[],
  ): Promise<DeployOutcome | null> {
    if (ctx.redeploy != null) return ctx.redeploy(uuid, warnings);
    try {
      this.#need(ctx.h, 'deploy', 'a redeploy');
      if (kind === 'application') {
        const out = await this.#provider(() => ctx.h.client.deploy([uuid], false));
        return { actionId: null, state: 'queued', deploymentUuid: out[0]?.deploymentUuid ?? null };
      }
      await this.#provider(() => ctx.h.client.lifecycle(kind, uuid, 'restart'));
      return { actionId: null, state: 'restarting', deploymentUuid: null };
    } catch (err) {
      warnings.push(
        `The redeploy was not requested: ${err instanceof Error ? err.message.slice(0, 300) : 'failed'}`,
      );
      return null;
    }
  }

  // ----------------------------------------------------------------------------------------- lifecycle

  /** Start / stop / restart an application, database or service (`deploy` ability). */
  async lifecycle(
    ctx: ResourceCtx,
    kind: CoolifyResourceKind,
    uuid: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const i = this.#parse(LifecycleInput, raw, 'action');
    const { h } = ctx;
    return this.#write(ctx, `ops.coolify.lifecycle.${i.action}`, { kind, resourceUuid: uuid }, async () => {
      this.#requireManage(h);
      this.#need(h, 'deploy', `${i.action} of a ${kind}`);
      const r = await this.#writable(h, kind, uuid, false);
      const out = await this.#provider(() =>
        h.client.lifecycle(kind, uuid, i.action, i.latest === undefined ? {} : { latest: i.latest }),
      );
      const warnings: string[] = [];
      if (i.action === 'stop') warnings.push(`${r.name} stops serving until it is started again.`);
      return {
        resource: { kind, uuid, name: r.name, previousStatus: r.status },
        action: i.action,
        deploymentUuid: out.deploymentUuid,
        message: out.message,
        warnings,
        audit: { name: r.name, deploymentUuid: out.deploymentUuid },
      };
    });
  }

  /** Cancel a running deployment (`deploy` ability; Coolify says when it already ended). */
  async cancelDeployment(ctx: ResourceCtx, deployment: string): Promise<Record<string, unknown>> {
    const { h } = ctx;
    return this.#write(ctx, 'ops.coolify.deployment.cancel', { deploymentUuid: deployment }, async () => {
      this.#requireManage(h);
      this.#need(h, 'deploy', 'cancelling a deployment');
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(deployment)) {
        throw new HttpError(400, 'invalid_request', 'Invalid Coolify id.', {}, {}, { reason: 'coolify_ref' });
      }
      const d = await this.#provider(() => h.client.deployment(deployment));
      const out = await this.#provider(() => h.client.cancelDeployment(deployment));
      return {
        deploymentUuid: deployment,
        application: d.applicationName,
        status: out.status,
        message: out.message,
      };
    });
  }

  // ----------------------------------------------------------------------------------------- databases

  /** Where a new database / service goes: the server, project and environment exist and are not the control plane. */
  async #place(
    h: CoolifyHandle,
    p: { server: string; coolifyProject: string; environment: string; destination?: string | undefined },
  ): Promise<{ environment: string }> {
    const servers = await this.#provider(() => h.client.servers());
    if (!servers.some((s) => s.uuid === p.server)) {
      throw new HttpError(
        400,
        'unknown_server',
        `Coolify server ${p.server} is not visible on “${h.label}”.`,
      );
    }
    const projects = await this.#provider(() => h.client.projects());
    if (!projects.some((x) => x.uuid === p.coolifyProject)) {
      throw new HttpError(
        400,
        'unknown_coolify_project',
        `Coolify project ${p.coolifyProject} is not visible on “${h.label}”.`,
      );
    }
    const envs = await this.#provider(() => h.client.environments(p.coolifyProject));
    const env = envs.find((e) => e.name === p.environment || e.uuid === p.environment) ?? null;
    if (env === null) {
      throw new HttpError(
        400,
        'unknown_environment',
        `The Coolify project has no environment “${p.environment}”.`,
      );
    }
    const deny = this.#denySet(h);
    const denied = [p.server, p.coolifyProject, env.uuid, p.destination].find(
      (u): u is string => typeof u === 'string' && deny.has(u),
    );
    if (denied !== undefined) {
      throw new HttpError(
        403,
        'control_plane_environment',
        `Coolify resource ${denied} is on the control-plane deny list; choose another place.`,
      );
    }
    if (env.id !== null) {
      const all = await this.#provider(() => h.client.resources());
      const cp = all.find((r) => r.environmentId === env.id && this.#isControlPlane(h, r));
      if (cp !== undefined) {
        throw new HttpError(
          403,
          'control_plane_environment',
          `The Coolify environment “${env.name}” holds the Remyral control plane (${cp.uuid}); choose another one.`,
        );
      }
    }
    return { environment: env.name };
  }

  async createDatabase(ctx: ResourceCtx, raw: unknown): Promise<Record<string, unknown>> {
    const i = this.#parse(DatabaseCreateInput, raw, 'database');
    const { h } = ctx;
    const meta = {
      engine: i.engine,
      server: i.server,
      coolifyProject: i.coolifyProject,
      environment: i.environment,
      name: i.name ?? null,
      image: i.image ?? null,
      isPublic: i.isPublic ?? false,
      password: i.password === undefined ? 'generated' : '(set)',
      instantDeploy: i.instantDeploy,
    };
    return this.#write(ctx, 'ops.coolify.database.create', meta, async () => {
      this.#requireManage(h);
      this.#need(h, 'write', 'creating a database');
      if (i.instantDeploy || i.isPublic === true)
        this.#need(h, 'deploy', 'starting a database (instant deploy / public port)');
      const f = DB_FIELDS[i.engine];
      for (const [k, field] of [
        ['user', f.user],
        ['database', f.database],
        ['password', f.password],
      ] as const) {
        if (i[k] !== undefined && field === undefined) {
          throw new HttpError(
            400,
            'invalid_request',
            `A ${i.engine} database takes no ${k} here (Coolify sets it).`,
          );
        }
      }
      const { environment } = await this.#place(h, i);
      const body: Record<string, unknown> = {
        server_uuid: i.server,
        project_uuid: i.coolifyProject,
        environment_name: environment,
        ...(i.destination === undefined ? {} : { destination_uuid: i.destination }),
        ...(i.name === undefined ? {} : { name: i.name }),
        ...(i.description === undefined ? {} : { description: i.description }),
        ...(i.image === undefined ? {} : { image: i.image }),
        ...(i.isPublic === undefined ? {} : { is_public: i.isPublic }),
        ...(i.publicPort === undefined ? {} : { public_port: i.publicPort }),
        ...(i.limitsMemory === undefined ? {} : { limits_memory: i.limitsMemory }),
        ...(i.limitsCpus === undefined ? {} : { limits_cpus: i.limitsCpus }),
        ...(i.user === undefined || f.user === undefined ? {} : { [f.user]: i.user }),
        ...(i.database === undefined || f.database === undefined ? {} : { [f.database]: i.database }),
        ...(i.password === undefined || f.password === undefined ? {} : { [f.password]: i.password }),
        instant_deploy: i.instantDeploy,
      };
      const uuid = await this.#provider(() => h.client.createDatabase(i.engine, body));
      return {
        uuid,
        engine: i.engine,
        name: i.name ?? null,
        warnings: [
          ...(i.password === undefined
            ? [
                'Coolify generated the password; it is shown in Coolify (and in the connection URL there), never in Remyral.',
              ]
            : []),
          ...(i.instantDeploy ? [] : ['The database is created stopped: start it when you need it.']),
        ],
        audit: { uuid },
      };
    });
  }

  async updateDatabase(ctx: ResourceCtx, uuid: string, raw: unknown): Promise<Record<string, unknown>> {
    const i = this.#parse(DatabaseUpdateInput, raw, 'database change');
    const { h } = ctx;
    return this.#write(ctx, 'ops.coolify.database.update', { resourceUuid: uuid, changes: i }, async () => {
      this.#requireManage(h);
      this.#need(h, 'write', 'changing a database');
      if (i.isPublic !== undefined) this.#need(h, 'deploy', 'making a database public or private');
      const r = await this.#writable(h, 'database', uuid, false);
      const hc = i.healthCheck;
      const body = Object.fromEntries(
        Object.entries({
          name: i.name,
          description: i.description,
          image: i.image,
          is_public: i.isPublic,
          public_port: i.publicPort,
          limits_memory: i.limitsMemory,
          limits_cpus: i.limitsCpus,
          health_check_enabled: hc?.enabled,
          health_check_interval: hc?.interval,
          health_check_timeout: hc?.timeout,
          health_check_retries: hc?.retries,
          health_check_start_period: hc?.startPeriod,
        }).filter(([, v]) => v !== undefined),
      );
      await this.#provider(() => h.client.updateDatabase(uuid, body));
      return {
        uuid,
        name: r.name,
        changed: Object.keys(body),
        warnings: ['Restart the database for image, limit and health-check changes to take effect.'],
      };
    });
  }

  /** Deletes a database or a service after its name was typed; volumes kept unless asked. */
  async deleteResource(
    ctx: ResourceCtx,
    kind: 'database' | 'service',
    uuid: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const i = this.#parse(ResourceDeleteInput, raw, 'delete request');
    const { h } = ctx;
    const { confirm, ...options } = i;
    return this.#write(ctx, `ops.coolify.${kind}.delete`, { resourceUuid: uuid, options }, async () => {
      this.#requireManage(h);
      this.#need(h, 'write', `deleting a ${kind}`);
      this.#need(h, 'deploy', `deleting a ${kind}`);
      const r = await this.#writable(h, kind, uuid, true);
      if (confirm !== r.name) {
        throw mismatchError(r.name);
      }
      let volumes: string[] = [];
      try {
        volumes = (await h.client.storages(kind, uuid))
          .filter((s) => s.type === 'persistent')
          .map((s) => s.name ?? s.mountPath);
      } catch (err) {
        if (!(err instanceof ProviderCallError)) throw err;
      }
      await this.#provider(() => h.client.deleteResource(kind, uuid, options));
      await this.deps.pool.query(
        'DELETE FROM coolify_data_paths WHERE connection_id = $1 AND resource_uuid = $2',
        [h.id, uuid],
      );
      const lost = [
        `The ${kind} ${r.name} and its containers${options.deleteConfigurations ? ' and configuration' : ''}.`,
        options.deleteVolumes
          ? `Its volumes and all data in them: ${volumes.join(', ') || 'none found'}.`
          : `Its volumes are kept on the server (${volumes.join(', ') || 'none found'}).`,
      ];
      return { uuid, name: r.name, options, lost, audit: { name: r.name, volumes, lost } };
    });
  }

  // ------------------------------------------------------------------------------------------ backups

  async createBackup(ctx: ResourceCtx, db: string, raw: unknown): Promise<Record<string, unknown>> {
    const i = this.#parse(BackupCreateInput, raw, 'backup');
    const { h } = ctx;
    return this.#write(ctx, 'ops.coolify.backup.create', { resourceUuid: db, backup: i }, async () => {
      this.#requireManage(h);
      this.#need(h, 'write', 'scheduling a backup');
      if (i.backupNow === true) this.#need(h, 'deploy', 'a backup now');
      const r = await this.#writable(h, 'database', db, false);
      const uuid = await this.#provider(() => h.client.createDatabaseBackup(db, this.#backupBody(i)));
      return { database: { uuid: db, name: r.name }, backupUuid: uuid, audit: { backupUuid: uuid } };
    });
  }

  async updateBackup(
    ctx: ResourceCtx,
    db: string,
    backup: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const i = this.#parse(BackupUpdateInput, raw, 'backup change');
    const { h } = ctx;
    const action =
      Object.keys(i).length === 1 && i.backupNow === true
        ? 'ops.coolify.backup.run'
        : 'ops.coolify.backup.update';
    return this.#write(ctx, action, { resourceUuid: db, backupUuid: backup, changes: i }, async () => {
      this.#requireManage(h);
      this.#need(h, 'write', 'changing a backup');
      if (i.backupNow === true) this.#need(h, 'deploy', 'a backup now');
      const r = await this.#writable(h, 'database', db, false);
      if (!/^[A-Za-z0-9-]{6,64}$/.test(backup))
        throw new HttpError(400, 'invalid_request', 'Invalid Coolify id.', {}, {}, { reason: 'coolify_ref' });
      await this.#provider(() => h.client.updateDatabaseBackup(db, backup, this.#backupBody(i)));
      return { database: { uuid: db, name: r.name }, backupUuid: backup };
    });
  }

  async deleteBackup(ctx: ResourceCtx, db: string, backup: string): Promise<Record<string, unknown>> {
    const { h } = ctx;
    return this.#write(
      ctx,
      'ops.coolify.backup.delete',
      { resourceUuid: db, backupUuid: backup },
      async () => {
        this.#requireManage(h);
        this.#need(h, 'write', 'deleting a backup schedule');
        const r = await this.#writable(h, 'database', db, false);
        if (!/^[A-Za-z0-9-]{6,64}$/.test(backup))
          throw new HttpError(
            400,
            'invalid_request',
            'Invalid Coolify id.',
            {},
            {},
            { reason: 'coolify_ref' },
          );
        await this.#provider(() => h.client.deleteDatabaseBackup(db, backup));
        return {
          database: { uuid: db, name: r.name },
          backupUuid: backup,
          lost: [
            'The schedule stops: no new backups. Backup files already made stay where they are (local / S3).',
          ],
        };
      },
    );
  }

  #backupBody(i: BackupCreateInput | BackupUpdateInput): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries({
        frequency: i.frequency,
        enabled: i.enabled,
        save_s3: i.saveS3,
        s3_storage_uuid: i.s3StorageUuid,
        databases_to_backup: i.databases,
        dump_all: i.dumpAll,
        database_backup_retention_amount_locally: i.retentionAmount,
        database_backup_retention_days_locally: i.retentionDays,
        backup_now: i.backupNow,
      }).filter(([, v]) => v !== undefined),
    );
  }

  // ------------------------------------------------------------------------------------------ services

  async createService(ctx: ResourceCtx, raw: unknown): Promise<Record<string, unknown>> {
    const i = this.#parse(ServiceCreateInput, raw, 'service');
    const { h } = ctx;
    const meta = {
      type: i.type ?? null,
      compose: i.compose === undefined ? null : { bytes: Buffer.byteLength(i.compose, 'utf8') },
      server: i.server,
      coolifyProject: i.coolifyProject,
      environment: i.environment,
      name: i.name ?? null,
      urls: i.urls ?? [],
      instantDeploy: i.instantDeploy,
    };
    return this.#write(ctx, 'ops.coolify.service.create', meta, async () => {
      this.#requireManage(h);
      this.#need(h, 'write', 'creating a service');
      if (i.instantDeploy) this.#need(h, 'deploy', 'starting a service');
      const { environment } = await this.#place(h, i);
      const body: Record<string, unknown> = {
        ...(i.type === undefined ? {} : { type: i.type }),
        ...(i.compose === undefined
          ? {}
          : { docker_compose_raw: Buffer.from(i.compose, 'utf8').toString('base64') }),
        server_uuid: i.server,
        project_uuid: i.coolifyProject,
        environment_name: environment,
        ...(i.destination === undefined ? {} : { destination_uuid: i.destination }),
        ...(i.name === undefined ? {} : { name: i.name }),
        ...(i.description === undefined ? {} : { description: i.description }),
        ...(i.urls === undefined ? {} : { urls: i.urls }),
        instant_deploy: i.instantDeploy,
      };
      const out = await this.#provider(() => h.client.createService(body));
      return { uuid: out.uuid, domains: out.domains, audit: { uuid: out.uuid } };
    });
  }

  async updateService(ctx: ResourceCtx, uuid: string, raw: unknown): Promise<Record<string, unknown>> {
    const i = this.#parse(ServiceUpdateInput, raw, 'service change');
    const { h } = ctx;
    return this.#write(ctx, 'ops.coolify.service.update', { resourceUuid: uuid, changes: i }, async () => {
      this.#requireManage(h);
      this.#need(h, 'write', 'changing a service');
      const r = await this.#writable(h, 'service', uuid, false);
      const body = Object.fromEntries(
        Object.entries({ name: i.name, description: i.description, urls: i.urls }).filter(
          ([, v]) => v !== undefined,
        ),
      );
      await this.#provider(() => h.client.updateService(uuid, body));
      return {
        uuid,
        name: r.name,
        changed: Object.keys(body),
        warnings: ['URL changes take effect when the service restarts.'],
      };
    });
  }

  /** Set / remove variables of a service (values never stored or audited); optional restart. */
  async serviceEnvs(ctx: ResourceCtx, uuid: string, raw: unknown): Promise<Record<string, unknown>> {
    const i = this.#parse(ServiceEnvsInput, raw, 'variables');
    const { h } = ctx;
    const changes = i.changes.map((c) =>
      'remove' in c
        ? { key: c.key, remove: true }
        : { key: c.key, source: c.shared === undefined ? 'value' : 'shared' },
    );
    return this.#write(
      ctx,
      'ops.coolify.service.envs',
      { resourceUuid: uuid, changes, restart: i.restart },
      async () => {
        this.#requireManage(h);
        this.#need(h, 'write', 'changing service variables');
        const r = await this.#writable(h, 'service', uuid, false);
        const existing = await this.#provider(() => h.client.envsOf('service', uuid));
        const out = {
          created: [] as string[],
          updated: [] as string[],
          removed: [] as string[],
          unchanged: [] as string[],
          failed: [] as { key: string; message: string }[],
        };
        for (const c of i.changes) {
          const cur = existing.find((e) => e.key === c.key && e.isPreview === (c.preview === true));
          try {
            if ('remove' in c) {
              if (cur === undefined) out.unchanged.push(c.key);
              else {
                await this.#provider(() => h.client.deleteEnvOf('service', uuid, cur.uuid));
                out.removed.push(c.key);
              }
            } else if (cur === undefined) {
              await this.#provider(() => h.client.createEnvOf('service', uuid, envWrite(c)));
              out.created.push(c.key);
            } else {
              await this.#provider(() => h.client.updateEnvOf('service', uuid, envWrite(c)));
              out.updated.push(c.key);
            }
          } catch (err) {
            out.failed.push({
              key: c.key,
              message: err instanceof Error ? err.message.slice(0, 300) : 'failed',
            });
          }
        }
        const warnings: string[] = [];
        const changed = out.created.length + out.updated.length + out.removed.length > 0;
        if (changed && i.restart) {
          try {
            this.#need(h, 'deploy', 'restarting the service');
            await this.#provider(() => h.client.lifecycle('service', uuid, 'restart'));
          } catch (err) {
            warnings.push(
              `The restart was not requested: ${err instanceof Error ? err.message.slice(0, 300) : 'failed'}`,
            );
          }
        } else if (changed) warnings.push('Variables take effect when the service restarts.');
        return {
          uuid,
          name: r.name,
          ...out,
          warnings,
          audit: {
            created: out.created,
            updated: out.updated,
            removed: out.removed,
            failed: out.failed.map((f) => f.key),
          },
        };
      },
    );
  }

  // ---------------------------------------------------------------- servers, projects, environments

  async validateServer(ctx: ResourceCtx, uuid: string): Promise<Record<string, unknown>> {
    const { h } = ctx;
    return this.#write(ctx, 'ops.coolify.server.validate', { serverUuid: uuid }, async () => {
      this.#requireManage(h);
      this.#need(h, 'write', 'validating a server');
      if (this.#denySet(h).has(uuid)) {
        throw new HttpError(
          403,
          'control_plane_resource',
          `Coolify server ${uuid} is on the control-plane deny list.`,
        );
      }
      const s = await this.#provider(() => h.client.server(uuid));
      const out = await this.#provider(() => h.client.validateServer(uuid));
      return {
        uuid,
        name: s.name,
        message: out.message,
        notes: [
          'Coolify checks the SSH connection and Docker in the background; the server’s state shows the result shortly.',
        ],
      };
    });
  }

  async createProject(ctx: ResourceCtx, raw: unknown): Promise<Record<string, unknown>> {
    const i = this.#parse(ProjectCreateInput, raw, 'project');
    const { h } = ctx;
    return this.#write(ctx, 'ops.coolify.project.create', { name: i.name }, async () => {
      this.#requireManage(h);
      this.#need(h, 'write', 'creating a project');
      const uuid = await this.#provider(() => h.client.createProject(i.name, i.description));
      return { uuid, name: i.name, audit: { uuid } };
    });
  }

  /** Deletes an empty Coolify project after its name was typed (a project with resources is refused). */
  async deleteProject(ctx: ResourceCtx, uuid: string, raw: unknown): Promise<Record<string, unknown>> {
    const i = this.#parse(NameConfirmInput, raw, 'delete request');
    const { h } = ctx;
    return this.#write(ctx, 'ops.coolify.project.delete', { projectUuid: uuid }, async () => {
      this.#requireManage(h);
      this.#need(h, 'write', 'deleting a project');
      if (this.#denySet(h).has(uuid)) {
        throw new HttpError(
          403,
          'control_plane_resource',
          `Coolify project ${uuid} is on the control-plane deny list.`,
        );
      }
      const p = (await this.#provider(() => h.client.projects())).find((x) => x.uuid === uuid);
      if (p === undefined)
        throw new HttpError(404, 'coolify_project_not_found', `Coolify project ${uuid} not found.`);
      if (i.confirm !== p.name) {
        throw mismatchError(p.name);
      }
      const envs = await this.#provider(() => h.client.environments(uuid));
      const ids = new Set(envs.map((e) => e.id).filter((x): x is number => x !== null));
      const inside = (await this.#provider(() => h.client.resources())).filter(
        (r) => r.environmentId !== null && ids.has(r.environmentId),
      );
      if (inside.length > 0) {
        throw new HttpError(
          409,
          'coolify_project_not_empty',
          `Coolify project ${p.name} still has ${String(inside.length)} resource(s) (${inside
            .slice(0, 5)
            .map((r) => r.name)
            .join(', ')}); delete or move them first.`,
          {},
          {},
          { count: String(inside.length) },
        );
      }
      await this.#provider(() => h.client.deleteProject(uuid));
      return {
        uuid,
        name: p.name,
        lost: [
          `The empty project ${p.name} and its environments (${envs.map((e) => e.name).join(', ') || 'none'}).`,
        ],
      };
    });
  }

  async createEnvironment(ctx: ResourceCtx, project: string, raw: unknown): Promise<Record<string, unknown>> {
    const i = this.#parse(EnvironmentCreateInput, raw, 'environment');
    const { h } = ctx;
    return this.#write(
      ctx,
      'ops.coolify.environment.create',
      { projectUuid: project, name: i.name },
      async () => {
        this.#requireManage(h);
        this.#need(h, 'write', 'creating an environment');
        if (this.#denySet(h).has(project)) {
          throw new HttpError(
            403,
            'control_plane_resource',
            `Coolify project ${project} is on the control-plane deny list.`,
          );
        }
        // p22-coolify-env-exists: creating an environment that is already there is done, not an error (a card drafted
        // before someone else created it, or approved twice) — the existing one is answered with `existed: true`.
        const existing = async () =>
          (await this.#provider(() => h.client.environments(project))).find((e) => e.name === i.name);
        const before = await existing();
        if (before !== undefined)
          return { projectUuid: project, uuid: before.uuid, name: i.name, existed: true };
        try {
          const uuid = await this.#provider(() => h.client.createEnvironment(project, i.name));
          return { projectUuid: project, uuid, name: i.name };
        } catch (err) {
          // Created between the read and the write: the same outcome.
          const raced = await existing().catch(() => undefined);
          if (raced !== undefined)
            return { projectUuid: project, uuid: raced.uuid, name: i.name, existed: true };
          throw err;
        }
      },
    );
  }

  async deleteEnvironment(
    ctx: ResourceCtx,
    project: string,
    environment: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const i = this.#parse(NameConfirmInput, raw, 'delete request');
    const { h } = ctx;
    return this.#write(
      ctx,
      'ops.coolify.environment.delete',
      { projectUuid: project, environment },
      async () => {
        this.#requireManage(h);
        this.#need(h, 'write', 'deleting an environment');
        const envs = await this.#provider(() => h.client.environments(project));
        const env = envs.find((e) => e.name === environment || e.uuid === environment);
        if (env === undefined)
          throw new HttpError(404, 'environment_not_found', `Environment ${environment} not found.`);
        if (i.confirm !== env.name) {
          throw mismatchError(env.name);
        }
        const deny = this.#denySet(h);
        if (deny.has(project) || (env.uuid !== null && deny.has(env.uuid))) {
          throw new HttpError(
            403,
            'control_plane_resource',
            `Environment ${env.name} is on the control-plane deny list.`,
          );
        }
        const inside =
          env.id === null
            ? []
            : (await this.#provider(() => h.client.resources())).filter((r) => r.environmentId === env.id);
        if (inside.length > 0) {
          throw new HttpError(
            409,
            'coolify_environment_not_empty',
            `Environment ${env.name} still has ${String(inside.length)} resource(s) (${inside
              .slice(0, 5)
              .map((r) => r.name)
              .join(', ')}); delete or move them first.`,
            {},
            {},
            { count: String(inside.length) },
          );
        }
        await this.#provider(() => h.client.deleteEnvironment(project, env.uuid ?? env.name));
        return { projectUuid: project, name: env.name, lost: [`The empty environment ${env.name}.`] };
      },
    );
  }
}
