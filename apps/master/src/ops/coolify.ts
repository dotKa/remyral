import { randomBytes } from 'node:crypto';
import { jsonOf, OpsHttpError, type OpsFetch, type OpsHttpResponse } from './http.js';

/**
 * p6-deploy-integrations: the Coolify v4 API calls the master makes, and nothing else (docs/compat/coolify.md pins
 * every endpoint with its source). Base: `<instance>/api/v1`, `Authorization: Bearer <token>`. Tokens are
 * team-scoped; permissions read / read:sensitive / write / deploy / root (a deploy-only token cannot read).
 */

export class ProviderCallError extends Error {
  override name = 'ProviderCallError';
  constructor(
    readonly provider: 'coolify' | 'cloudflare',
    /** HTTP status of the provider (0: no answer). */
    readonly status: number,
    readonly code:
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'rate_limited'
      | 'invalid'
      | 'redirect'
      | 'unavailable'
      | 'network'
      | 'bad_response'
      | 'conflict'
      /** p17-coolify-full: the instance has no such API endpoint (its catch-all 404 with `docs`): an older version. */
      | 'unsupported',
    message: string,
    /** Seconds from Retry-After on 429. */
    readonly retryAfterSec: number | null = null,
    /**
     * p15-coolify-create: Coolify's details of a 422 (field → message) or a 409 domain conflict (domain → resource
     * name). Field names, resource names and Coolify's own messages only — never a value we sent.
     */
    readonly details: Readonly<Record<string, string>> | null = null,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

export interface CoolifyApplication {
  readonly uuid: string;
  readonly name: string;
  /** Comma-separated domains as Coolify reports them (may be empty). */
  readonly fqdn: string;
  readonly status: string;
  readonly gitBranch: string | null;
  readonly gitCommitSha: string | null;
  /** p15-coolify-create: the Coolify environment (numeric id) the application lives in, when reported. */
  readonly environmentId?: number | null;
  /**
   * p15-coolify-dedupe: what the duplicate guard compares (as Coolify reports them in `GET /applications`; null when
   * not reported).
   */
  readonly gitRepository?: string | null;
  readonly baseDirectory?: string | null;
  readonly dockerfileLocation?: string | null;
  readonly dockerImage?: string | null;
}

/** p15-coolify-create: what the wizard and the editors show of an application (no secrets). */
export interface CoolifyApplicationDetails extends CoolifyApplication {
  readonly buildPack: string | null;
  readonly portsExposes: string | null;
  readonly gitRepository: string | null;
  readonly dockerImage: string | null;
  readonly baseDirectory: string | null;
  /** p15-coolify-dedupe: the build settings a fix may change (no secrets: commands are admin-set build steps). */
  readonly publishDirectory: string | null;
  readonly dockerfileLocation: string | null;
  readonly composeLocation: string | null;
  /** Docker Compose service names (from `docker_compose_domains`, else the raw compose file); [] otherwise. */
  readonly composeServices: readonly string[];
  /** Docker Compose per-service domains (service → comma-separated URLs). */
  readonly composeDomains: Readonly<Record<string, string>>;
  readonly installCommand: string | null;
  readonly buildCommand: string | null;
  readonly startCommand: string | null;
  /** Watch paths (one pattern per line; `*`, `**`, `?`, `!`; last match wins). */
  readonly watchPaths: readonly string[];
  readonly isStatic: boolean | null;
  readonly healthCheck: {
    readonly enabled: boolean;
    readonly path: string | null;
    readonly port: string | null;
    readonly method: string | null;
    readonly returnCode: number | null;
    readonly scheme: string | null;
    readonly interval: number | null;
    readonly timeout: number | null;
    readonly retries: number | null;
    readonly startPeriod: number | null;
  };
}

export interface CoolifyServer {
  readonly uuid: string;
  readonly name: string;
  readonly description: string | null;
  /** The server's address as Coolify reports it (shown so the admin can tell servers apart). */
  readonly ip: string | null;
  /** `settings.is_reachable` / `is_usable` when reported (null: unknown). */
  readonly reachable: boolean | null;
  readonly usable: boolean | null;
}

export interface CoolifyProject {
  readonly uuid: string;
  readonly name: string;
  readonly description: string | null;
}

export interface CoolifyEnvironment {
  readonly id: number | null;
  /** Newer Coolify versions report it; older ones only the name (the create endpoints accept either). */
  readonly uuid: string | null;
  readonly name: string;
}

export interface CoolifyDestination {
  readonly uuid: string;
  readonly name: string;
  readonly network: string | null;
}

/** A Coolify GitHub App source (private repositories). */
export interface CoolifyGithubApp {
  readonly uuid: string;
  readonly name: string;
  readonly organization: string | null;
  readonly isPublic: boolean;
}

/** A Coolify private key: uuid, name and fingerprint only — the key material is dropped by the client. */
export interface CoolifyPrivateKey {
  readonly uuid: string;
  readonly name: string;
  readonly fingerprint: string | null;
  readonly gitRelated: boolean;
}

/**
 * An environment variable as Remyral shows it: key and flags. The value is never kept or returned (Coolify includes it
 * for tokens with `read:sensitive`; the client drops it) — except a shared-variable reference, which is no secret.
 */
export interface CoolifyEnvVar {
  readonly uuid: string;
  readonly key: string;
  readonly isPreview: boolean;
  readonly isBuildtime: boolean | null;
  readonly isRuntime: boolean | null;
  readonly isLiteral: boolean;
  readonly isMultiline: boolean;
  readonly isShared: boolean;
  readonly isShownOnce: boolean;
  /** The value is a shared-variable reference (`{{team|project|environment|server.NAME}}`): `scope.NAME`. */
  readonly sharedRef: string | null;
}

/** The body of `POST /applications/{uuid}/envs`, `PATCH …/envs` and one item of `PATCH …/envs/bulk`. */
export interface CoolifyEnvWrite {
  readonly key: string;
  readonly value: string;
  readonly is_preview?: boolean;
  readonly is_literal?: boolean;
  readonly is_multiline?: boolean;
  /** Sent only when not the default (both true): older Coolify versions refuse unknown fields with 422. */
  readonly is_buildtime?: boolean;
  readonly is_runtime?: boolean;
}

/** The documented create endpoints (`POST /applications/<kind>`, docs/compat/coolify.md). */
export type CoolifyCreateKind =
  'public' | 'private-github-app' | 'private-deploy-key' | 'dockerfile' | 'dockerimage';

export interface CoolifyDeployment {
  readonly deploymentUuid: string;
  readonly status: string;
  readonly commit: string | null;
  readonly applicationName: string | null;
  readonly deploymentUrl: string | null;
  readonly logs: string | null;
}

/** p15-coolify-dedupe: one item of `GET /deployments/applications/{uuid}` (no logs). */
export interface CoolifyDeploymentItem {
  readonly deploymentUuid: string;
  readonly status: string;
  readonly commit: string | null;
  readonly createdAt: string | null;
}

export interface CoolifyPermissionProbe {
  /** `GET /applications` answered 200. */
  readonly read: boolean;
  /** `POST /deployments/<random>/cancel`: 404 = the deploy ability passed, 403 = missing; null = inconclusive. */
  readonly deploy: boolean | null;
  /** `PATCH /applications/<random>`: 404 = the write ability passed (or root), 403 = missing; null = inconclusive. */
  readonly write: boolean | null;
  /**
   * p17-coolify-full: `GET /applications/<random>/logs` (route ability `read:sensitive`): 404 = present, 403 = missing;
   * null = inconclusive. Absent in tests stored before p17-coolify-full.
   */
  readonly readSensitive?: boolean | null;
}

/** p17-coolify-full: the three resource families that share start / stop / restart, storages and logs. */
export type CoolifyResourceKind = 'application' | 'database' | 'service';
const KIND_PATH: Readonly<Record<CoolifyResourceKind, string>> = {
  application: 'applications',
  database: 'databases',
  service: 'services',
};

/**
 * p17-coolify-full: a storage of an application, database or service (`GET /<kind>/{uuid}/storages`). `volume` is a
 * Docker volume (`persistent`), `file` a file Coolify writes, `directory` / `hostFile` a host path bind-mounted
 * (`file` storages with `is_directory` / `is_host_file`). File contents are never kept (config files may hold
 * secrets): only their size.
 */
export interface CoolifyStorage {
  readonly uuid: string;
  readonly id: number | null;
  readonly type: 'persistent' | 'file';
  readonly mount: 'volume' | 'file' | 'directory' | 'hostFile';
  /** The Docker volume name (persistent); null for file storages. */
  readonly name: string | null;
  readonly mountPath: string;
  /** `host_path` of a volume (older Coolify) or `fs_path` of a file / directory storage. */
  readonly hostPath: string | null;
  /** Managed by a compose file or service definition: Coolify refuses to change or delete it. */
  readonly readOnly: boolean;
  readonly basedOnGit: boolean;
  readonly contentBytes: number | null;
  /** Services: the sub-application / sub-database the storage belongs to. */
  readonly resourceUuid: string | null;
}

/** p17-coolify-full: the body of `POST /<kind>/{uuid}/storages` (documented fields only; see coolifyFeatures). */
export interface CoolifyStorageCreate {
  readonly type: 'persistent' | 'file';
  readonly name?: string;
  readonly mount_path: string;
  /** Up to Coolify 4.2 only (a volume on a host path). */
  readonly host_path?: string;
  readonly content?: string;
  readonly is_directory?: boolean;
  readonly fs_path?: string;
  /** Services: the sub-resource. */
  readonly resource_uuid?: string;
}

/** p17-coolify-full: the body of `PATCH /<kind>/{uuid}/storages`. */
export interface CoolifyStorageUpdate {
  readonly uuid: string;
  readonly type: 'persistent' | 'file';
  readonly name?: string;
  readonly mount_path?: string;
  readonly host_path?: string | null;
  readonly content?: string | null;
  readonly is_preview_suffix_enabled?: boolean;
}

/** p17-coolify-full: one entry of `GET /resources` (applications, services and standalone databases). */
export interface CoolifyResource {
  readonly uuid: string;
  readonly name: string;
  readonly kind: CoolifyResourceKind;
  /** `application`, `service` or `standalone-<engine>` as Coolify reports it. */
  readonly type: string;
  readonly status: string;
  readonly environmentId: number | null;
  /** Applications: comma-separated domains (may be empty). */
  readonly fqdn: string | null;
}

/** p17-coolify-full: a standalone database without passwords, connection URLs or init scripts. */
export interface CoolifyDatabase {
  readonly uuid: string;
  readonly name: string;
  readonly description: string | null;
  /** `standalone-postgresql` … */
  readonly type: string;
  readonly engine: string;
  readonly image: string | null;
  readonly status: string;
  readonly environmentId: number | null;
  readonly isPublic: boolean;
  readonly publicPort: number | null;
  readonly limits: { readonly memory: string | null; readonly cpus: string | null };
  /** Non-secret engine settings (user and database names). */
  readonly user: string | null;
  readonly database: string | null;
}

/** p17-coolify-full: a scheduled backup of a database (`GET /databases/{uuid}/backups`). */
export interface CoolifyBackup {
  readonly uuid: string;
  readonly enabled: boolean;
  readonly frequency: string;
  readonly saveS3: boolean;
  readonly s3StorageUuid: string | null;
  readonly databases: string | null;
  readonly dumpAll: boolean;
  readonly retentionLocal: { readonly amount: number | null; readonly days: number | null };
  readonly lastExecution: { readonly status: string; readonly at: string | null } | null;
}

export interface CoolifyBackupExecution {
  readonly uuid: string;
  readonly status: string;
  readonly filename: string | null;
  readonly size: number | null;
  readonly createdAt: string | null;
}

/** p17-coolify-full: a service (one-click / compose) without its compose text. */
export interface CoolifyService {
  readonly uuid: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: string | null;
  readonly status: string;
  readonly environmentId: number | null;
  /** Sub-resources (logs and storages are per sub-resource). */
  readonly applications: readonly { uuid: string; name: string; status: string; fqdn: string | null }[];
  readonly databases: readonly { uuid: string; name: string; status: string }[];
}

/** p17-coolify-full: one running deployment (`GET /deployments`). */
export interface CoolifyRunningDeployment {
  readonly deploymentUuid: string;
  readonly status: string;
  readonly applicationName: string | null;
  readonly serverName: string | null;
  readonly commit: string | null;
  readonly createdAt: string | null;
}

/** p17-coolify-full: resources of one server (`GET /servers/{uuid}/resources`). */
export interface CoolifyServerResource {
  readonly uuid: string;
  readonly name: string;
  readonly type: string;
  readonly status: string;
}

/**
 * p17-coolify-full: what an instance's API offers, from its version (docs/design/p17-coolify-full.md §2). `unknown`
 * when the version cannot be read: the call is tried and an `unsupported` answer decides.
 */
export interface CoolifyFeatures {
  /** `full`: list + create + update + delete (≥ 4.0.0-beta.470); `read`: list + update (beta.469). */
  readonly storages: 'full' | 'read' | 'none' | 'unknown';
  /** A persistent volume may name a host path (`host_path`, up to 4.2.x); null: unknown. */
  readonly volumeHostPath: boolean | null;
}

export function coolifyFeatures(version: string | null | undefined): CoolifyFeatures {
  const v = (version ?? '').trim();
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-(beta|rc|alpha)\.?(\d+))?/i.exec(v);
  // A pre-release without a number (`-beta.fake`, `-nightly`) cannot be placed.
  if (m === null || (m[4] === undefined && v.slice(m[0].length).startsWith('-')))
    return { storages: 'unknown', volumeHostPath: null };
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3] ?? '0')];
  const pre = m[4]?.toLowerCase() ?? null;
  const preN = Number(m[5] ?? '0');
  if (maj < 4) return { storages: 'none', volumeHostPath: false };
  if (maj === 4 && min === 0 && pat === 0 && pre === 'beta') {
    if (preN >= 470) return { storages: 'full', volumeHostPath: true };
    return { storages: preN === 469 ? 'read' : 'none', volumeHostPath: true };
  }
  if (maj === 4 && min === 0 && pat === 0 && pre !== null) return { storages: 'none', volumeHostPath: true };
  return { storages: 'full', volumeHostPath: maj === 4 && min < 3 };
}

/** The first engine name of a `standalone-<engine>` type (`postgresql` …). */
function engineOf(type: string): string {
  return type.replace(/^standalone-/, '');
}

export interface CoolifyClientOptions {
  /** Instance URL without `/api/v1` (validated by checkBaseUrl). */
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: OpsFetch;
}

/** 422 `errors: {field: [messages]}` → field → first message (bounded; Coolify's text, never our values). */
function validationDetails(body: unknown): Record<string, string> | null {
  const e = obj(obj(body).errors);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(e).slice(0, 20)) {
    const first: unknown = Array.isArray(v) ? (v as unknown[]).find((x) => typeof x === 'string') : v;
    if (typeof first === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(k)) out[k] = first.slice(0, 200);
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** 409 `conflicts: [{domain, resource_name}]` → domain → resource name. */
function conflictDetails(body: unknown): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const c of arr(obj(body).conflicts).slice(0, 20)) {
    const x = obj(c);
    const d = str(x.domain).slice(0, 253);
    if (d !== '') out[d] = str(x.resource_name).slice(0, 200);
  }
  return Object.keys(out).length === 0 ? null : out;
}

const nstr = (v: unknown, n = 500): string | null =>
  typeof v === 'string' && v !== '' ? v.slice(0, n) : null;
const nnum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nbool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
/** A Coolify shared-variable reference as a whole value (docs: Shared variables → reference syntax). */
export const SHARED_REF =
  /^\{\{\s*((?:team|project|environment|server)\.[A-Za-z_][A-Za-z0-9_]{0,127})\s*\}\}$/;

function messageOf(res: OpsHttpResponse): string {
  const m = str(obj(jsonOf(res)).message);
  return m === '' ? `HTTP ${String(res.status)}` : m.slice(0, 300);
}

export class CoolifyClient {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: OpsFetch;

  constructor(o: CoolifyClientOptions) {
    this.#base = `${o.baseUrl.replace(/\/+$/, '')}/api/v1`;
    this.#token = o.token;
    this.#fetch = o.fetch;
  }

  async #call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<OpsHttpResponse> {
    let res: OpsHttpResponse;
    try {
      res = await this.#fetch({
        method,
        url: `${this.#base}${path}`,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      if (err instanceof OpsHttpError) {
        throw new ProviderCallError('coolify', 0, 'network', `Coolify unreachable: ${err.message}`);
      }
      throw new ProviderCallError('coolify', 0, 'network', 'Coolify unreachable');
    }
    if (res.status >= 300 && res.status < 400) {
      throw new ProviderCallError(
        'coolify',
        res.status,
        'redirect',
        'Coolify answered with a redirect (not followed)',
      );
    }
    return res;
  }

  #fail(res: OpsHttpResponse, what: string): never {
    const m = messageOf(res);
    switch (res.status) {
      case 401:
        // The Remyral Coolify SSO gate (forwardAuth on the public Coolify host) answers API calls itself: the request
        // never reached Coolify, so the token is not the problem — the connection must use the internal address.
        if (/Sign in through the console/i.test(m)) {
          throw new ProviderCallError(
            'coolify',
            401,
            'unauthorized',
            `${what}: the request was stopped by the Remyral sign-in gate in front of this Coolify host, not by Coolify — ` +
              'use the internal address (e.g. http://coolify:8080, allowed by OPS_INTERNAL_ORIGINS) as the Coolify URL ' +
              'and keep the public host as the browser address',
          );
        }
        throw new ProviderCallError(
          'coolify',
          401,
          'unauthorized',
          `${what}: token rejected (wrong token or team): ${m}`,
        );
      case 403:
        throw new ProviderCallError(
          'coolify',
          403,
          'forbidden',
          `${what}: token lacks the permission (or API access is disabled): ${m}`,
        );
      case 404:
        // p17-coolify-full: Coolify's catch-all route answers an unknown path with `{message, docs}`; a missing
        // resource answers without `docs`. The first means "this Coolify version has no such endpoint".
        if (typeof obj(jsonOf(res)).docs === 'string') {
          throw new ProviderCallError(
            'coolify',
            404,
            'unsupported',
            `${what}: this Coolify version has no such API endpoint (update Coolify)`,
          );
        }
        throw new ProviderCallError('coolify', 404, 'not_found', `${what}: not found`);
      case 429: {
        const ra = Number.parseInt(res.headers['retry-after'] ?? '', 10);
        throw new ProviderCallError(
          'coolify',
          429,
          'rate_limited',
          `${what}: Coolify rate limit`,
          Number.isFinite(ra) && ra >= 0 ? ra : null,
        );
      }
      case 400:
      case 422: {
        const details = validationDetails(jsonOf(res));
        const extra =
          details === null
            ? ''
            : ` (${Object.entries(details)
                .slice(0, 5)
                .map(([k, v]) => `${k}: ${v}`)
                .join('; ')})`;
        throw new ProviderCallError(
          'coolify',
          res.status,
          'invalid',
          `${what}: ${m}${extra}`.slice(0, 600),
          null,
          details,
        );
      }
      case 409: {
        const details = conflictDetails(jsonOf(res));
        const names = details === null ? '' : ` (${Object.keys(details).slice(0, 5).join(', ')})`;
        throw new ProviderCallError(
          'coolify',
          409,
          'conflict',
          `${what}: ${m}${names}`.slice(0, 600),
          null,
          details,
        );
      }
      default:
        throw new ProviderCallError(
          'coolify',
          res.status,
          res.status >= 500 ? 'unavailable' : 'bad_response',
          `${what}: HTTP ${String(res.status)}`,
        );
    }
  }

  /** `GET /version` (text). */
  async version(): Promise<string> {
    const res = await this.#call('GET', '/version');
    if (res.status !== 200) this.#fail(res, 'version');
    return res.body.toString('utf8').trim().replace(/^"|"$/g, '').slice(0, 64);
  }

  /** `GET /team`: the team bound to the token. */
  async team(): Promise<{ id: number | null; name: string }> {
    const res = await this.#call('GET', '/team');
    if (res.status !== 200) this.#fail(res, 'team');
    const t = obj(jsonOf(res));
    return { id: typeof t.id === 'number' ? t.id : null, name: str(t.name).slice(0, 200) };
  }

  static #app(v: unknown): CoolifyApplication {
    const a = obj(v);
    return {
      uuid: str(a.uuid),
      name: str(a.name).slice(0, 200),
      fqdn: str(a.fqdn).slice(0, 2000),
      status: str(a.status).slice(0, 100),
      gitBranch: typeof a.git_branch === 'string' ? a.git_branch.slice(0, 200) : null,
      gitCommitSha: typeof a.git_commit_sha === 'string' ? a.git_commit_sha.slice(0, 64) : null,
      environmentId: nnum(a.environment_id),
      gitRepository: nstr(a.git_repository, 500),
      baseDirectory: nstr(a.base_directory, 300),
      dockerfileLocation: nstr(a.dockerfile_location, 300),
      dockerImage: nstr(a.docker_registry_image_name, 300),
    };
  }

  /** `GET /applications[?tag=]`. */
  async applications(tag?: string): Promise<CoolifyApplication[]> {
    const q = tag === undefined ? '' : `?tag=${encodeURIComponent(tag)}`;
    const res = await this.#call('GET', `/applications${q}`);
    if (res.status !== 200) this.#fail(res, 'list applications');
    return arr(jsonOf(res))
      .map((a) => CoolifyClient.#app(a))
      .filter((a) => a.uuid !== '');
  }

  /** `GET /applications/{uuid}`. */
  async application(uuid: string): Promise<CoolifyApplication> {
    const res = await this.#call('GET', `/applications/${encodeURIComponent(uuid)}`);
    if (res.status !== 200) this.#fail(res, `application ${uuid}`);
    const a = CoolifyClient.#app(jsonOf(res));
    if (a.uuid === '')
      throw new ProviderCallError('coolify', 200, 'bad_response', 'application without uuid');
    return a;
  }

  /** `POST /deploy?uuid=a,b&force=`: queued deployments. */
  async deploy(
    uuids: readonly string[],
    force: boolean,
  ): Promise<{ resourceUuid: string; deploymentUuid: string; message: string }[]> {
    const q = `?uuid=${uuids.map(encodeURIComponent).join(',')}${force ? '&force=true' : ''}`;
    const res = await this.#call('POST', `/deploy${q}`);
    if (res.status !== 200) this.#fail(res, 'deploy');
    return arr(obj(jsonOf(res)).deployments).map((d) => {
      const x = obj(d);
      return {
        resourceUuid: str(x.resource_uuid),
        deploymentUuid: str(x.deployment_uuid),
        message: str(x.message).slice(0, 300),
      };
    });
  }

  /** `POST /applications/{uuid}/restart`. */
  async restart(uuid: string): Promise<{ deploymentUuid: string | null; message: string }> {
    const res = await this.#call('POST', `/applications/${encodeURIComponent(uuid)}/restart`);
    if (res.status !== 200) this.#fail(res, `restart ${uuid}`);
    const x = obj(jsonOf(res));
    return {
      deploymentUuid: str(x.deployment_uuid) === '' ? null : str(x.deployment_uuid),
      message: str(x.message).slice(0, 300),
    };
  }

  /** `GET /applications/{uuid}/rollback-images`: the image tag currently running (null when unknown). */
  async currentImage(uuid: string): Promise<string | null> {
    const res = await this.#call('GET', `/applications/${encodeURIComponent(uuid)}/rollback-images`);
    if (res.status !== 200) this.#fail(res, `rollback images ${uuid}`);
    const cur = obj(jsonOf(res)).current;
    return typeof cur === 'string' && cur !== '' ? cur.slice(0, 200) : null;
  }

  /** `POST /applications/{uuid}/rollback` {commit}. */
  async rollback(uuid: string, commit: string): Promise<{ deploymentUuid: string | null }> {
    const res = await this.#call('POST', `/applications/${encodeURIComponent(uuid)}/rollback`, { commit });
    if (res.status !== 200) this.#fail(res, `rollback ${uuid}`);
    const d = str(obj(jsonOf(res)).deployment_uuid);
    return { deploymentUuid: d === '' ? null : d };
  }

  /** `GET /deployments/{uuid}`. */
  async deployment(uuid: string): Promise<CoolifyDeployment> {
    const res = await this.#call('GET', `/deployments/${encodeURIComponent(uuid)}`);
    if (res.status !== 200) this.#fail(res, `deployment ${uuid}`);
    const d = obj(jsonOf(res));
    return {
      deploymentUuid: str(d.deployment_uuid) || uuid,
      status: str(d.status).slice(0, 64),
      commit: typeof d.commit === 'string' ? d.commit.slice(0, 64) : null,
      applicationName: typeof d.application_name === 'string' ? d.application_name.slice(0, 200) : null,
      deploymentUrl: typeof d.deployment_url === 'string' ? d.deployment_url.slice(0, 500) : null,
      logs: typeof d.logs === 'string' ? d.logs : null,
    };
  }

  /**
   * p12-deploy-feedback: `GET /applications/{uuid}/logs?lines=&show_timestamps=true` — the last `lines` lines of the
   * running container's output (`{logs: string}`; 404 when no container runs). Read-only; the token may need
   * `read:sensitive` on instances that redact logs for plain `read`.
   */
  async applicationLogs(uuid: string, lines: number): Promise<string> {
    const n = Math.max(1, Math.min(Math.floor(lines), 2000));
    const res = await this.#call(
      'GET',
      `/applications/${encodeURIComponent(uuid)}/logs?lines=${String(n)}&show_timestamps=true`,
    );
    if (res.status !== 200) this.#fail(res, `application logs ${uuid}`);
    const logs = obj(jsonOf(res)).logs;
    return typeof logs === 'string' ? logs : '';
  }

  // ------------------------------------------------------------- p15-coolify-create: what creation needs (read)

  /** `GET /servers`. */
  async servers(): Promise<CoolifyServer[]> {
    const res = await this.#call('GET', '/servers');
    if (res.status !== 200) this.#fail(res, 'list servers');
    return arr(jsonOf(res))
      .map((v) => {
        const s = obj(v);
        const st = obj(s.settings);
        return {
          uuid: str(s.uuid),
          name: str(s.name).slice(0, 200),
          description: nstr(s.description),
          ip: nstr(s.ip, 253),
          reachable: nbool(st.is_reachable),
          usable: nbool(st.is_usable),
        };
      })
      .filter((s) => s.uuid !== '');
  }

  /** `GET /projects`. */
  async projects(): Promise<CoolifyProject[]> {
    const res = await this.#call('GET', '/projects');
    if (res.status !== 200) this.#fail(res, 'list projects');
    return arr(jsonOf(res))
      .map((v) => {
        const p = obj(v);
        return { uuid: str(p.uuid), name: str(p.name).slice(0, 200), description: nstr(p.description) };
      })
      .filter((p) => p.uuid !== '');
  }

  /** `GET /projects/{uuid}/environments`. */
  async environments(projectUuid: string): Promise<CoolifyEnvironment[]> {
    const res = await this.#call('GET', `/projects/${encodeURIComponent(projectUuid)}/environments`);
    if (res.status !== 200) this.#fail(res, `environments of project ${projectUuid}`);
    return arr(jsonOf(res))
      .map((v) => {
        const e = obj(v);
        return { id: nnum(e.id), uuid: nstr(e.uuid, 64), name: str(e.name).slice(0, 200) };
      })
      .filter((e) => e.name !== '');
  }

  /** `GET /servers/{uuid}/destinations` (recent Coolify; older versions answer 404 — the caller shows "default"). */
  async destinations(serverUuid: string): Promise<CoolifyDestination[]> {
    const res = await this.#call('GET', `/servers/${encodeURIComponent(serverUuid)}/destinations`);
    if (res.status !== 200) this.#fail(res, `destinations of server ${serverUuid}`);
    return arr(jsonOf(res))
      .map((v) => {
        const d = obj(v);
        return { uuid: str(d.uuid), name: str(d.name).slice(0, 200), network: nstr(d.network, 200) };
      })
      .filter((d) => d.uuid !== '');
  }

  /** `GET /github-apps`: the team's GitHub App sources (private repositories). */
  async githubApps(): Promise<CoolifyGithubApp[]> {
    const res = await this.#call('GET', '/github-apps');
    if (res.status !== 200) this.#fail(res, 'list GitHub apps');
    return arr(jsonOf(res))
      .map((v) => {
        const g = obj(v);
        return {
          uuid: str(g.uuid),
          name: str(g.name).slice(0, 200),
          organization: nstr(g.organization, 200),
          isPublic: g.is_public === true,
        };
      })
      .filter((g) => g.uuid !== '');
  }

  /**
   * `GET /security/keys`: uuid, name and fingerprint of each key. Coolify includes the private key for tokens with
   * `read:sensitive`; it is dropped here and never stored, logged or returned.
   */
  async privateKeys(): Promise<CoolifyPrivateKey[]> {
    const res = await this.#call('GET', '/security/keys');
    if (res.status !== 200) this.#fail(res, 'list private keys');
    return arr(jsonOf(res))
      .map((v) => {
        const k = obj(v);
        return {
          uuid: str(k.uuid),
          name: str(k.name).slice(0, 200),
          fingerprint: nstr(k.fingerprint, 200),
          gitRelated: k.is_git_related === true,
        };
      })
      .filter((k) => k.uuid !== '');
  }

  /** `GET /applications/{uuid}` with the fields the editors show. */
  async applicationDetails(uuid: string): Promise<CoolifyApplicationDetails> {
    const res = await this.#call('GET', `/applications/${encodeURIComponent(uuid)}`);
    if (res.status !== 200) this.#fail(res, `application ${uuid}`);
    const raw = obj(jsonOf(res));
    const a = CoolifyClient.#app(raw);
    if (a.uuid === '')
      throw new ProviderCallError('coolify', 200, 'bad_response', 'application without uuid');
    const port = raw.health_check_port;
    return {
      ...a,
      buildPack: nstr(raw.build_pack, 64),
      portsExposes: nstr(raw.ports_exposes, 200),
      gitRepository: nstr(raw.git_repository, 500),
      dockerImage: nstr(raw.docker_registry_image_name, 300),
      baseDirectory: nstr(raw.base_directory, 300),
      publishDirectory: nstr(raw.publish_directory, 300),
      dockerfileLocation: nstr(raw.dockerfile_location, 300),
      composeLocation: nstr(raw.docker_compose_location, 300),
      ...composeServicesOf(raw),
      installCommand: nstr(raw.install_command, 1000),
      buildCommand: nstr(raw.build_command, 1000),
      startCommand: nstr(raw.start_command, 1000),
      watchPaths: (nstr(raw.watch_paths, 20_000) ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
        .slice(0, 100),
      isStatic: nbool(raw.is_static),
      healthCheck: {
        enabled: raw.health_check_enabled === true,
        path: nstr(raw.health_check_path, 300),
        port: typeof port === 'number' ? String(port) : nstr(port, 10),
        method: nstr(raw.health_check_method, 10),
        returnCode: nnum(raw.health_check_return_code),
        scheme: nstr(raw.health_check_scheme, 10),
        interval: nnum(raw.health_check_interval),
        timeout: nnum(raw.health_check_timeout),
        retries: nnum(raw.health_check_retries),
        startPeriod: nnum(raw.health_check_start_period),
      },
    };
  }

  // ------------------------------------------------------------- p15-coolify-create: writes (`write` ability)

  /**
   * `POST /applications/{public|private-github-app|private-deploy-key|dockerfile|dockerimage}` → the new uuid. The
   * body carries documented fields only (Coolify refuses unknown ones with 422); 409 is a domain conflict, never
   * overridden (`force_domain_override` is not sent).
   */
  async createApplication(kind: CoolifyCreateKind, body: Readonly<Record<string, unknown>>): Promise<string> {
    const res = await this.#call('POST', `/applications/${kind}`, body);
    if (res.status !== 201 && res.status !== 200) this.#fail(res, 'create application');
    const uuid = str(obj(jsonOf(res)).uuid);
    if (!/^[A-Za-z0-9]{6,64}$/.test(uuid)) {
      throw new ProviderCallError(
        'coolify',
        res.status,
        'bad_response',
        'create application: no uuid in the answer',
      );
    }
    return uuid;
  }

  /** `PATCH /applications/{uuid}` (domains, build pack, ports, health check …). */
  async updateApplication(uuid: string, body: Readonly<Record<string, unknown>>): Promise<void> {
    const res = await this.#call('PATCH', `/applications/${encodeURIComponent(uuid)}`, body);
    if (res.status !== 200 && res.status !== 201) this.#fail(res, `update application ${uuid}`);
  }

  /**
   * p15-coolify-dedupe: `DELETE /applications/{uuid}?delete_configurations=&delete_volumes=&docker_cleanup=&
   * delete_connected_networks=` (all four documented query flags, default true upstream — always sent explicitly so
   * the caller's choice, not the upstream default, decides). 200 `{message}`.
   */
  async deleteApplication(
    uuid: string,
    o: {
      readonly deleteConfigurations: boolean;
      readonly deleteVolumes: boolean;
      readonly dockerCleanup: boolean;
      readonly deleteConnectedNetworks: boolean;
    },
  ): Promise<void> {
    const q = new URLSearchParams({
      delete_configurations: String(o.deleteConfigurations),
      delete_volumes: String(o.deleteVolumes),
      docker_cleanup: String(o.dockerCleanup),
      delete_connected_networks: String(o.deleteConnectedNetworks),
    });
    const res = await this.#call('DELETE', `/applications/${encodeURIComponent(uuid)}?${q.toString()}`);
    if (res.status !== 200 && res.status !== 204) this.#fail(res, `delete application ${uuid}`);
  }

  /**
   * p15-coolify-dedupe: `GET /deployments/applications/{uuid}?skip=0&take=` — the application's deployments, newest
   * first. The documented answer is an array; some versions wrap it as `{count, deployments}` — both are read. Logs
   * are not kept here (read one deployment with {@link deployment}).
   */
  async applicationDeployments(uuid: string, take = 5): Promise<CoolifyDeploymentItem[]> {
    const n = Math.max(1, Math.min(Math.floor(take), 20));
    const res = await this.#call(
      'GET',
      `/deployments/applications/${encodeURIComponent(uuid)}?skip=0&take=${String(n)}`,
    );
    if (res.status !== 200) this.#fail(res, `deployments of application ${uuid}`);
    const body = jsonOf(res);
    const list = Array.isArray(body) ? body : arr(obj(body).deployments);
    return list
      .map((v) => {
        const d = obj(v);
        return {
          deploymentUuid: str(d.deployment_uuid).slice(0, 64),
          status: str(d.status).slice(0, 64),
          commit: nstr(d.commit, 64),
          createdAt: nstr(d.created_at, 64),
        };
      })
      .filter((d) => /^[A-Za-z0-9_-]{1,64}$/.test(d.deploymentUuid))
      .slice(0, n);
  }

  /** `GET /applications/{uuid}/envs`: keys and flags only (values are dropped here). */
  async envs(uuid: string): Promise<CoolifyEnvVar[]> {
    return this.envsOf('application', uuid);
  }

  /** `POST /applications/{uuid}/envs` → the new variable's uuid. */
  async createEnv(uuid: string, env: CoolifyEnvWrite): Promise<string> {
    const res = await this.#call('POST', `/applications/${encodeURIComponent(uuid)}/envs`, env);
    if (res.status !== 201 && res.status !== 200) this.#fail(res, `create variable ${env.key}`);
    return str(obj(jsonOf(res)).uuid);
  }

  /** `PATCH /applications/{uuid}/envs` (Coolify matches the variable by key and is_preview). */
  async updateEnv(uuid: string, env: CoolifyEnvWrite): Promise<void> {
    const res = await this.#call('PATCH', `/applications/${encodeURIComponent(uuid)}/envs`, env);
    if (res.status !== 201 && res.status !== 200) this.#fail(res, `update variable ${env.key}`);
  }

  /** `PATCH /applications/{uuid}/envs/bulk` `{data: [...]}` (existing variables). */
  async bulkEnvs(uuid: string, envs: readonly CoolifyEnvWrite[]): Promise<void> {
    const res = await this.#call('PATCH', `/applications/${encodeURIComponent(uuid)}/envs/bulk`, {
      data: envs,
    });
    if (res.status !== 201 && res.status !== 200) this.#fail(res, 'update variables');
  }

  /** `DELETE /applications/{uuid}/envs/{env_uuid}`. */
  async deleteEnv(uuid: string, envUuid: string): Promise<void> {
    const res = await this.#call(
      'DELETE',
      `/applications/${encodeURIComponent(uuid)}/envs/${encodeURIComponent(envUuid)}`,
    );
    if (res.status !== 200 && res.status !== 204) this.#fail(res, 'delete variable');
  }

  // ------------------------------------------------------------- p17-coolify-full: the rest of the API

  /** `/<kind>/{uuid}` path prefix. */
  static #path(kind: CoolifyResourceKind, uuid: string): string {
    return `/${KIND_PATH[kind]}/${encodeURIComponent(uuid)}`;
  }

  /** `GET /resources`: applications, services and standalone databases of the team (no secrets kept). */
  async resources(): Promise<CoolifyResource[]> {
    const res = await this.#call('GET', '/resources');
    if (res.status !== 200) this.#fail(res, 'list resources');
    return arr(jsonOf(res))
      .map((v) => {
        const r = obj(v);
        const type = str(r.type).slice(0, 64);
        const kind: CoolifyResourceKind | null =
          type === 'application'
            ? 'application'
            : type === 'service'
              ? 'service'
              : type.startsWith('standalone-')
                ? 'database'
                : null;
        return kind === null
          ? null
          : {
              uuid: str(r.uuid),
              name: str(r.name).slice(0, 200),
              kind,
              type,
              status: str(r.status).slice(0, 100),
              environmentId: nnum(r.environment_id),
              fqdn: kind === 'application' ? nstr(r.fqdn, 2000) : null,
            };
      })
      .filter((r): r is CoolifyResource => r !== null && r.uuid !== '');
  }

  static #storage(v: unknown, type: 'persistent' | 'file'): CoolifyStorage {
    const s = obj(v);
    const content = s.content;
    return {
      uuid: str(s.uuid).slice(0, 64),
      id: nnum(s.id),
      type,
      mount:
        type === 'persistent'
          ? 'volume'
          : s.is_directory === true
            ? 'directory'
            : s.is_host_file === true
              ? 'hostFile'
              : 'file',
      name: type === 'persistent' ? nstr(s.name, 300) : null,
      mountPath: str(s.mount_path).slice(0, 500),
      hostPath: nstr(type === 'persistent' ? s.host_path : s.fs_path, 500),
      readOnly: s.is_readonly === true || s.is_based_on_git === true,
      basedOnGit: s.is_based_on_git === true,
      contentBytes: typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : null,
      resourceUuid: nstr(s.resource_uuid, 64),
    };
  }

  /** `GET /<kind>/{uuid}/storages` → volumes first, then file / directory mounts (contents dropped). */
  async storages(kind: CoolifyResourceKind, uuid: string): Promise<CoolifyStorage[]> {
    const res = await this.#call('GET', `${CoolifyClient.#path(kind, uuid)}/storages`);
    if (res.status !== 200) this.#fail(res, `storages of ${kind} ${uuid}`);
    const b = obj(jsonOf(res));
    return [
      ...arr(b.persistent_storages).map((s) => CoolifyClient.#storage(s, 'persistent')),
      ...arr(b.file_storages).map((s) => CoolifyClient.#storage(s, 'file')),
    ].filter((s) => s.uuid !== '' || s.id !== null);
  }

  /** `POST /<kind>/{uuid}/storages` → the new storage (201). */
  async createStorage(
    kind: CoolifyResourceKind,
    uuid: string,
    body: CoolifyStorageCreate,
  ): Promise<CoolifyStorage> {
    const res = await this.#call('POST', `${CoolifyClient.#path(kind, uuid)}/storages`, body);
    if (res.status !== 201 && res.status !== 200) this.#fail(res, `add storage ${body.mount_path}`);
    return CoolifyClient.#storage(jsonOf(res), body.type);
  }

  /** `PATCH /<kind>/{uuid}/storages` (the storage by uuid). */
  async updateStorage(kind: CoolifyResourceKind, uuid: string, body: CoolifyStorageUpdate): Promise<void> {
    const res = await this.#call('PATCH', `${CoolifyClient.#path(kind, uuid)}/storages`, body);
    if (res.status !== 200 && res.status !== 201) this.#fail(res, `update storage ${body.uuid}`);
  }

  /** `DELETE /<kind>/{uuid}/storages/{storage_uuid}`. */
  async deleteStorage(kind: CoolifyResourceKind, uuid: string, storageUuid: string): Promise<void> {
    const res = await this.#call(
      'DELETE',
      `${CoolifyClient.#path(kind, uuid)}/storages/${encodeURIComponent(storageUuid)}`,
    );
    if (res.status !== 200 && res.status !== 204) this.#fail(res, `remove storage ${storageUuid}`);
  }

  /**
   * `POST /<kind>/{uuid}/start|stop|restart` (`deploy` ability). Applications: start is a deployment (its uuid is
   * returned); stop never runs Coolify's docker cleanup (`docker_cleanup=false`); a service restart may pull the
   * latest images (`latest`).
   */
  async lifecycle(
    kind: CoolifyResourceKind,
    uuid: string,
    action: 'start' | 'stop' | 'restart',
    o: { readonly latest?: boolean } = {},
  ): Promise<{ deploymentUuid: string | null; message: string }> {
    const q =
      action === 'stop'
        ? '?docker_cleanup=false'
        : action === 'restart' && kind === 'service' && o.latest === true
          ? '?latest=true'
          : '';
    const res = await this.#call('POST', `${CoolifyClient.#path(kind, uuid)}/${action}${q}`);
    if (res.status !== 200 && res.status !== 201) this.#fail(res, `${action} ${kind} ${uuid}`);
    const x = obj(jsonOf(res));
    return {
      deploymentUuid: nstr(x.deployment_uuid, 64),
      message: str(x.message).slice(0, 300),
    };
  }

  /** `GET /<kind>/{uuid}/logs?lines=` (`read:sensitive`); services need the sub-resource name. */
  async resourceLogs(
    kind: 'database' | 'service',
    uuid: string,
    lines: number,
    subService?: string,
  ): Promise<string> {
    const n = Math.max(1, Math.min(Math.floor(lines), 2000));
    const q = new URLSearchParams({ lines: String(n), show_timestamps: 'true' });
    if (kind === 'service') q.set('sub_service_name', subService ?? '');
    const res = await this.#call('GET', `${CoolifyClient.#path(kind, uuid)}/logs?${q.toString()}`);
    if (res.status !== 200) this.#fail(res, `logs of ${kind} ${uuid}`);
    const logs = obj(jsonOf(res)).logs;
    return typeof logs === 'string' ? logs : '';
  }

  /** `GET /deployments`: the deployments running now (queued / in progress). */
  async runningDeployments(): Promise<CoolifyRunningDeployment[]> {
    const res = await this.#call('GET', '/deployments');
    if (res.status !== 200) this.#fail(res, 'list deployments');
    return arr(jsonOf(res))
      .map((v) => {
        const d = obj(v);
        return {
          deploymentUuid: str(d.deployment_uuid).slice(0, 64),
          status: str(d.status).slice(0, 64),
          applicationName: nstr(d.application_name, 200),
          serverName: nstr(d.server_name, 200),
          commit: nstr(d.commit, 64),
          createdAt: nstr(d.created_at, 64),
        };
      })
      .filter((d) => d.deploymentUuid !== '')
      .slice(0, 100);
  }

  /** `POST /deployments/{uuid}/cancel` (400: it already ended — Coolify's message says the state). */
  async cancelDeployment(uuid: string): Promise<{ status: string | null; message: string }> {
    const res = await this.#call('POST', `/deployments/${encodeURIComponent(uuid)}/cancel`);
    if (res.status !== 200) this.#fail(res, `cancel deployment ${uuid}`);
    const x = obj(jsonOf(res));
    return { status: nstr(x.status, 64), message: str(x.message).slice(0, 300) };
  }

  // ---------------------------------------------------------------------------------------- databases

  static #database(v: unknown): CoolifyDatabase {
    const d = obj(v);
    const type = str(d.database_type).slice(0, 64);
    const engine = engineOf(type);
    const user =
      nstr(d.postgres_user, 200) ??
      nstr(d.mysql_user, 200) ??
      nstr(d.mariadb_user, 200) ??
      nstr(d.mongo_initdb_root_username, 200) ??
      nstr(d.clickhouse_admin_user, 200);
    const database =
      nstr(d.postgres_db, 200) ??
      nstr(d.mysql_database, 200) ??
      nstr(d.mariadb_database, 200) ??
      nstr(d.mongo_initdb_database, 200) ??
      nstr(d.clickhouse_db, 200);
    return {
      uuid: str(d.uuid).slice(0, 64),
      name: str(d.name).slice(0, 200),
      description: nstr(d.description),
      type,
      engine,
      image: nstr(d.image, 300),
      status: str(d.status).slice(0, 100),
      environmentId: nnum(d.environment_id),
      isPublic: d.is_public === true,
      publicPort: nnum(d.public_port),
      limits: { memory: nstr(d.limits_memory, 32), cpus: nstr(d.limits_cpus, 32) },
      user,
      database,
    };
  }

  /** `GET /databases` (passwords and connection URLs are dropped here). */
  async databases(): Promise<CoolifyDatabase[]> {
    const res = await this.#call('GET', '/databases');
    if (res.status !== 200) this.#fail(res, 'list databases');
    return arr(jsonOf(res))
      .map((d) => CoolifyClient.#database(d))
      .filter((d) => d.uuid !== '');
  }

  /** `GET /databases/{uuid}`. */
  async database(uuid: string): Promise<CoolifyDatabase> {
    const res = await this.#call('GET', `/databases/${encodeURIComponent(uuid)}`);
    if (res.status !== 200) this.#fail(res, `database ${uuid}`);
    const d = CoolifyClient.#database(jsonOf(res));
    if (d.uuid === '') throw new ProviderCallError('coolify', 200, 'bad_response', 'database without uuid');
    return d;
  }

  /** `POST /databases/<engine>` → the new uuid (the body is built from documented fields by the caller). */
  async createDatabase(engine: string, body: Readonly<Record<string, unknown>>): Promise<string> {
    const res = await this.#call('POST', `/databases/${encodeURIComponent(engine)}`, body);
    if (res.status !== 201 && res.status !== 200) this.#fail(res, `create ${engine} database`);
    const uuid = str(obj(jsonOf(res)).uuid);
    if (!/^[A-Za-z0-9]{6,64}$/.test(uuid)) {
      throw new ProviderCallError(
        'coolify',
        res.status,
        'bad_response',
        'create database: no uuid in the answer',
      );
    }
    return uuid;
  }

  /** `PATCH /databases/{uuid}`. */
  async updateDatabase(uuid: string, body: Readonly<Record<string, unknown>>): Promise<void> {
    const res = await this.#call('PATCH', `/databases/${encodeURIComponent(uuid)}`, body);
    if (res.status !== 200 && res.status !== 201) this.#fail(res, `update database ${uuid}`);
  }

  /** `DELETE /databases|services/{uuid}?…` (all four flags always sent; `write` + `deploy`). */
  async deleteResource(
    kind: 'database' | 'service',
    uuid: string,
    o: {
      readonly deleteConfigurations: boolean;
      readonly deleteVolumes: boolean;
      readonly dockerCleanup: boolean;
      readonly deleteConnectedNetworks: boolean;
    },
  ): Promise<void> {
    const q = new URLSearchParams({
      delete_configurations: String(o.deleteConfigurations),
      delete_volumes: String(o.deleteVolumes),
      docker_cleanup: String(o.dockerCleanup),
      delete_connected_networks: String(o.deleteConnectedNetworks),
    });
    const res = await this.#call('DELETE', `${CoolifyClient.#path(kind, uuid)}?${q.toString()}`);
    if (res.status !== 200 && res.status !== 204) this.#fail(res, `delete ${kind} ${uuid}`);
  }

  static #backup(v: unknown): CoolifyBackup {
    const b = obj(v);
    const execs = arr(b.executions).map((e) => obj(e));
    const last = execs.slice().sort((a, c) => str(c.created_at).localeCompare(str(a.created_at)))[0];
    return {
      uuid: str(b.uuid).slice(0, 64),
      enabled: b.enabled !== false,
      frequency: str(b.frequency).slice(0, 100),
      saveS3: b.save_s3 === true,
      s3StorageUuid: nstr(b.s3_storage_uuid, 64),
      databases: nstr(b.databases_to_backup, 500),
      dumpAll: b.dump_all === true,
      retentionLocal: {
        amount: nnum(b.database_backup_retention_amount_locally),
        days: nnum(b.database_backup_retention_days_locally),
      },
      lastExecution:
        last === undefined ? null : { status: str(last.status).slice(0, 64), at: nstr(last.created_at, 64) },
    };
  }

  /** `GET /databases/{uuid}/backups`: the scheduled backups (execution messages dropped). */
  async databaseBackups(uuid: string): Promise<CoolifyBackup[]> {
    const res = await this.#call('GET', `/databases/${encodeURIComponent(uuid)}/backups`);
    if (res.status !== 200) this.#fail(res, `backups of database ${uuid}`);
    return arr(jsonOf(res))
      .map((b) => CoolifyClient.#backup(b))
      .filter((b) => b.uuid !== '');
  }

  /** `POST /databases/{uuid}/backups` → the new backup uuid. */
  async createDatabaseBackup(uuid: string, body: Readonly<Record<string, unknown>>): Promise<string> {
    const res = await this.#call('POST', `/databases/${encodeURIComponent(uuid)}/backups`, body);
    if (res.status !== 201 && res.status !== 200) this.#fail(res, `create backup of database ${uuid}`);
    return str(obj(jsonOf(res)).uuid).slice(0, 64);
  }

  /** `PATCH /databases/{uuid}/backups/{backup}` (also `backup_now`). */
  async updateDatabaseBackup(
    uuid: string,
    backup: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const res = await this.#call(
      'PATCH',
      `/databases/${encodeURIComponent(uuid)}/backups/${encodeURIComponent(backup)}`,
      body,
    );
    if (res.status !== 200 && res.status !== 201) this.#fail(res, `update backup ${backup}`);
  }

  /** `DELETE /databases/{uuid}/backups/{backup}` (the schedule; files on S3 stay unless Coolify removes them). */
  async deleteDatabaseBackup(uuid: string, backup: string): Promise<void> {
    const res = await this.#call(
      'DELETE',
      `/databases/${encodeURIComponent(uuid)}/backups/${encodeURIComponent(backup)}`,
    );
    if (res.status !== 200 && res.status !== 204) this.#fail(res, `delete backup ${backup}`);
  }

  /** `GET /databases/{uuid}/backups/{backup}/executions` (messages dropped). */
  async backupExecutions(uuid: string, backup: string): Promise<CoolifyBackupExecution[]> {
    const res = await this.#call(
      'GET',
      `/databases/${encodeURIComponent(uuid)}/backups/${encodeURIComponent(backup)}/executions`,
    );
    if (res.status !== 200) this.#fail(res, `backup executions of ${backup}`);
    const b = jsonOf(res);
    const list = Array.isArray(b) ? b : arr(obj(b).executions);
    return list
      .map((v) => {
        const e = obj(v);
        return {
          uuid: str(e.uuid).slice(0, 64),
          status: str(e.status).slice(0, 64),
          filename: nstr(e.filename, 500),
          size: nnum(e.size),
          createdAt: nstr(e.created_at, 64),
        };
      })
      .slice(0, 50);
  }

  // ----------------------------------------------------------------------------------------- services

  static #service(v: unknown): CoolifyService {
    const s = obj(v);
    const subs = (k: string) => arr(s[k]).map((x) => obj(x));
    return {
      uuid: str(s.uuid).slice(0, 64),
      name: str(s.name).slice(0, 200),
      description: nstr(s.description),
      type: nstr(s.service_type, 100),
      status: str(s.status).slice(0, 100),
      environmentId: nnum(s.environment_id),
      applications: subs('applications')
        .map((a) => ({
          uuid: str(a.uuid).slice(0, 64),
          name: str(a.name).slice(0, 200),
          status: str(a.status).slice(0, 100),
          fqdn: nstr(a.fqdn, 2000),
        }))
        .slice(0, 30),
      databases: subs('databases')
        .map((d) => ({
          uuid: str(d.uuid).slice(0, 64),
          name: str(d.name).slice(0, 200),
          status: str(d.status).slice(0, 100),
        }))
        .slice(0, 30),
    };
  }

  /** `GET /services` (compose text dropped). */
  async services(): Promise<CoolifyService[]> {
    const res = await this.#call('GET', '/services');
    if (res.status !== 200) this.#fail(res, 'list services');
    return arr(jsonOf(res))
      .map((s) => CoolifyClient.#service(s))
      .filter((s) => s.uuid !== '');
  }

  /** `GET /services/{uuid}`. */
  async service(uuid: string): Promise<CoolifyService> {
    const res = await this.#call('GET', `/services/${encodeURIComponent(uuid)}`);
    if (res.status !== 200) this.#fail(res, `service ${uuid}`);
    const s = CoolifyClient.#service(jsonOf(res));
    if (s.uuid === '') throw new ProviderCallError('coolify', 200, 'bad_response', 'service without uuid');
    return s;
  }

  /** `POST /services` → the new uuid and its domains (409: a domain conflict, never overridden). */
  async createService(body: Readonly<Record<string, unknown>>): Promise<{ uuid: string; domains: string[] }> {
    const res = await this.#call('POST', '/services', body);
    if (res.status !== 201 && res.status !== 200) this.#fail(res, 'create service');
    const b = obj(jsonOf(res));
    const uuid = str(b.uuid);
    if (!/^[A-Za-z0-9]{6,64}$/.test(uuid)) {
      throw new ProviderCallError(
        'coolify',
        res.status,
        'bad_response',
        'create service: no uuid in the answer',
      );
    }
    return {
      uuid,
      domains: arr(b.domains)
        .filter((d): d is string => typeof d === 'string')
        .slice(0, 20),
    };
  }

  /** `PATCH /services/{uuid}`. */
  async updateService(uuid: string, body: Readonly<Record<string, unknown>>): Promise<void> {
    const res = await this.#call('PATCH', `/services/${encodeURIComponent(uuid)}`, body);
    if (res.status !== 200 && res.status !== 201) this.#fail(res, `update service ${uuid}`);
  }

  /** `GET /<kind>/{uuid}/envs`: keys and flags only (values are dropped here). */
  async envsOf(kind: 'application' | 'service', uuid: string): Promise<CoolifyEnvVar[]> {
    const res = await this.#call('GET', `${CoolifyClient.#path(kind, uuid)}/envs`);
    if (res.status !== 200) this.#fail(res, `environment variables of ${uuid}`);
    return arr(jsonOf(res))
      .map((v) => CoolifyClient.#env(v))
      .filter((e) => e.key !== '');
  }

  static #env(v: unknown): CoolifyEnvVar {
    const e = obj(v);
    const ref = SHARED_REF.exec(typeof e.value === 'string' ? e.value.trim() : '');
    return {
      uuid: str(e.uuid),
      key: str(e.key).slice(0, 256),
      isPreview: e.is_preview === true,
      isBuildtime: nbool(e.is_buildtime ?? e.is_build_time),
      isRuntime: nbool(e.is_runtime),
      isLiteral: e.is_literal === true,
      isMultiline: e.is_multiline === true,
      isShared: e.is_shared === true,
      isShownOnce: e.is_shown_once === true,
      sharedRef: ref?.[1] ?? null,
    };
  }

  /**
   * p17-coolify-full: the absolute paths named by variable values that look like data paths (`DATABASE_PATH=/data/x.db`,
   * `file:/data/app.sqlite`) — what the storage warnings compare with the mounts. Only a bare path is kept (never
   * another value; a connection string or a secret never matches the pattern).
   */
  async envDataPaths(
    kind: 'application' | 'service',
    uuid: string,
  ): Promise<{ key: string; path: string }[]> {
    const res = await this.#call('GET', `${CoolifyClient.#path(kind, uuid)}/envs`);
    if (res.status !== 200) this.#fail(res, `environment variables of ${uuid}`);
    const out: { key: string; path: string }[] = [];
    for (const v of arr(jsonOf(res))) {
      const e = obj(v);
      const key = str(e.key);
      const value = typeof e.value === 'string' ? e.value.trim() : '';
      if (!/(PATH|DIR|FILE|DB|DATABASE|STORAGE|UPLOAD|DATA|SQLITE)/i.test(key)) continue;
      const m = /^(?:file:|sqlite:\/\/)?(\/[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]{0,299})$/.exec(value);
      if (m?.[1] !== undefined && !m[1].includes('..')) out.push({ key: key.slice(0, 128), path: m[1] });
    }
    return out.slice(0, 20);
  }

  /** `POST /<kind>/{uuid}/envs` → the new variable's uuid. */
  async createEnvOf(kind: 'application' | 'service', uuid: string, env: CoolifyEnvWrite): Promise<string> {
    const res = await this.#call('POST', `${CoolifyClient.#path(kind, uuid)}/envs`, env);
    if (res.status !== 201 && res.status !== 200) this.#fail(res, `create variable ${env.key}`);
    return str(obj(jsonOf(res)).uuid);
  }

  /** `PATCH /<kind>/{uuid}/envs`. */
  async updateEnvOf(kind: 'application' | 'service', uuid: string, env: CoolifyEnvWrite): Promise<void> {
    const res = await this.#call('PATCH', `${CoolifyClient.#path(kind, uuid)}/envs`, env);
    if (res.status !== 201 && res.status !== 200) this.#fail(res, `update variable ${env.key}`);
  }

  /** `DELETE /<kind>/{uuid}/envs/{env_uuid}`. */
  async deleteEnvOf(kind: 'application' | 'service', uuid: string, envUuid: string): Promise<void> {
    const res = await this.#call(
      'DELETE',
      `${CoolifyClient.#path(kind, uuid)}/envs/${encodeURIComponent(envUuid)}`,
    );
    if (res.status !== 200 && res.status !== 204) this.#fail(res, 'delete variable');
  }

  // ------------------------------------------------------------------------------------------ servers

  /** `GET /servers/{uuid}` (validation logs and SSH user dropped). */
  async server(uuid: string): Promise<CoolifyServer & { proxy: string | null; port: number | null }> {
    const res = await this.#call('GET', `/servers/${encodeURIComponent(uuid)}`);
    if (res.status !== 200) this.#fail(res, `server ${uuid}`);
    const s = obj(jsonOf(res));
    const st = obj(s.settings);
    if (str(s.uuid) === '')
      throw new ProviderCallError('coolify', 200, 'bad_response', 'server without uuid');
    return {
      uuid: str(s.uuid),
      name: str(s.name).slice(0, 200),
      description: nstr(s.description),
      ip: nstr(s.ip, 253),
      reachable: nbool(st.is_reachable),
      usable: nbool(st.is_usable),
      proxy: nstr(s.proxy_type, 64),
      port: nnum(s.port),
    };
  }

  /** `GET /servers/{uuid}/resources`. */
  async serverResources(uuid: string): Promise<CoolifyServerResource[]> {
    const res = await this.#call('GET', `/servers/${encodeURIComponent(uuid)}/resources`);
    if (res.status !== 200) this.#fail(res, `resources of server ${uuid}`);
    return arr(jsonOf(res))
      .map((v) => {
        const r = obj(v);
        return {
          uuid: str(r.uuid).slice(0, 64),
          name: str(r.name).slice(0, 200),
          type: str(r.type).slice(0, 64),
          status: str(r.status).slice(0, 100),
        };
      })
      .filter((r) => r.uuid !== '')
      .slice(0, 500);
  }

  /** `GET /servers/{uuid}/domains`: `[{ip, domains}]` flattened to the domain names. */
  async serverDomains(uuid: string): Promise<{ ip: string | null; domains: string[] }[]> {
    const res = await this.#call('GET', `/servers/${encodeURIComponent(uuid)}/domains`);
    if (res.status !== 200) this.#fail(res, `domains of server ${uuid}`);
    return arr(jsonOf(res))
      .map((v) => {
        const d = obj(v);
        return {
          ip: nstr(d.ip, 253),
          domains: arr(d.domains)
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.slice(0, 300))
            .slice(0, 500),
        };
      })
      .slice(0, 20);
  }

  /** `POST /servers/{uuid}/validate` without `install` (checks the connection; installs nothing). */
  async validateServer(uuid: string): Promise<{ message: string }> {
    const res = await this.#call('POST', `/servers/${encodeURIComponent(uuid)}/validate`, {});
    if (res.status !== 200 && res.status !== 201) this.#fail(res, `validate server ${uuid}`);
    return { message: str(obj(jsonOf(res)).message).slice(0, 300) };
  }

  // ------------------------------------------------------------------------ projects / environments

  /** `POST /projects` → the new uuid. */
  async createProject(name: string, description?: string): Promise<string> {
    const res = await this.#call('POST', '/projects', {
      name,
      ...(description === undefined ? {} : { description }),
    });
    if (res.status !== 201 && res.status !== 200) this.#fail(res, `create project ${name}`);
    return str(obj(jsonOf(res)).uuid).slice(0, 64);
  }

  /** `DELETE /projects/{uuid}` (Coolify refuses a project that still has resources). */
  async deleteProject(uuid: string): Promise<void> {
    const res = await this.#call('DELETE', `/projects/${encodeURIComponent(uuid)}`);
    if (res.status !== 200 && res.status !== 204) this.#fail(res, `delete project ${uuid}`);
  }

  /** `POST /projects/{uuid}/environments` → the new environment's uuid (409: the name exists). */
  async createEnvironment(project: string, name: string): Promise<string | null> {
    const res = await this.#call('POST', `/projects/${encodeURIComponent(project)}/environments`, { name });
    if (res.status !== 201 && res.status !== 200) this.#fail(res, `create environment ${name}`);
    return nstr(obj(jsonOf(res)).uuid, 64);
  }

  /** `DELETE /projects/{uuid}/environments/{name or uuid}` (only an empty environment; 400 otherwise). */
  async deleteEnvironment(project: string, environment: string): Promise<void> {
    const res = await this.#call(
      'DELETE',
      `/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(environment)}`,
    );
    if (res.status !== 200 && res.status !== 204) this.#fail(res, `delete environment ${environment}`);
  }

  /**
   * Which abilities the token has, without side effects: read via `GET /applications`; deploy and write via
   * requests on a random, non-existent id (Coolify checks the ability before looking the resource up, so 403 means
   * "missing ability" and 404 means "ability present"). Inconclusive answers stay null. p17-coolify-full adds
   * `read:sensitive` (the logs route) the same way.
   */
  async probe(): Promise<CoolifyPermissionProbe> {
    const ghost = `remyral-probe-${randomBytes(8).toString('hex')}`;
    const readRes = await this.#call('GET', '/applications');
    if (readRes.status === 401) this.#fail(readRes, 'probe');
    if (readRes.status === 429) this.#fail(readRes, 'probe');
    const decide = (s: number): boolean | null => (s === 404 ? true : s === 403 ? false : null);
    const dep = await this.#call('POST', `/deployments/${ghost}/cancel`);
    const wr = await this.#call('PATCH', `/applications/${ghost}`, {});
    const rs = await this.#call('GET', `/applications/${ghost}/logs?lines=1`);
    return {
      read: readRes.status === 200,
      deploy: decide(dep.status),
      write: decide(wr.status),
      readSensitive: decide(rs.status),
    };
  }
}

/** Terminal Coolify deployment states (ApplicationDeploymentStatus as of the pinned docs). */
export function coolifyOutcome(status: string): 'running' | 'succeeded' | 'failed' {
  if (status === 'finished') return 'succeeded';
  if (status === 'failed' || status.startsWith('cancelled')) return 'failed';
  return 'running';
}

/** Compose service names and their domains from a Coolify application (`docker_compose_domains` is a JSON string). */
export function composeServicesOf(raw: Record<string, unknown>): {
  composeServices: string[];
  composeDomains: Record<string, string>;
} {
  const domains: Record<string, string> = {};
  let parsed: unknown = raw.docker_compose_domains;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
      const d = v !== null && typeof v === 'object' ? (v as Record<string, unknown>).domain : undefined;
      if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)) domains[name] = typeof d === 'string' ? d : '';
    }
  }
  const services = new Set(Object.keys(domains));
  const compose = typeof raw.docker_compose_raw === 'string' ? raw.docker_compose_raw : raw.docker_compose;
  if (services.size === 0 && typeof compose === 'string') {
    // Top-level `services:` keys at two-space indent (no YAML parser: names only, bounded).
    const block = /^services:\s*\n((?:[ \t].*\n?|\s*\n)*)/m.exec(compose.slice(0, 200_000))?.[1] ?? '';
    for (const m of block.matchAll(/^ {2}([A-Za-z0-9][A-Za-z0-9_.-]{0,62}):\s*$/gm)) services.add(m[1] ?? '');
  }
  return { composeServices: [...services].filter((x) => x !== '').slice(0, 50), composeDomains: domains };
}
