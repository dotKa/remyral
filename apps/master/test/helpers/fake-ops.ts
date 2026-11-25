import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * p6-deploy-integrations: local fake Coolify (v4 API subset) and Cloudflare (API v4 subset) servers that record
 * every request (method, path + query, authorization header, body) so tests can assert the exact calls, and can be
 * told to fail the next request (401 / 403 / 429 with Retry-After).
 */

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly auth: string | null;
  readonly body: string;
}

abstract class FakeServer {
  readonly requests: Recorded[] = [];
  base = '';
  #server: Server | null = null;
  /** Fail the next matching request(s) with this status. */
  failNext: {
    status: number;
    retryAfter?: number;
    match?: RegExp;
    times?: number;
    body?: unknown;
  } | null = null;

  async start(): Promise<string> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const rec = {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          auth: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
          body,
        };
        this.requests.push(rec);
        const f = this.failNext;
        if (f !== null && (f.match === undefined || f.match.test(`${rec.method} ${rec.path}`))) {
          if ((f.times ?? 1) <= 1) this.failNext = null;
          else this.failNext = { ...f, times: (f.times ?? 1) - 1 };
          if (f.retryAfter !== undefined) res.setHeader('retry-after', String(f.retryAfter));
          this.send(res, f.status, f.body ?? this.errorBody(f.status));
          return;
        }
        try {
          this.handle(req, rec, res);
        } catch (err) {
          this.send(res, 500, { message: (err as Error).message });
        }
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.base = `http://127.0.0.1:${String(port)}`;
    return this.base;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.#server?.close(() => {
        resolve();
      }),
    );
  }

  calls(re?: RegExp): string[] {
    return this.requests.map((r) => `${r.method} ${r.path}`).filter((s) => re === undefined || re.test(s));
  }

  reset(): void {
    this.requests.length = 0;
  }

  protected send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  protected abstract errorBody(status: number): unknown;
  protected abstract handle(req: IncomingMessage, rec: Recorded, res: ServerResponse): void;
}

export interface FakeApp {
  uuid: string;
  name: string;
  fqdn: string;
  status: string;
  tags: string[];
  git_branch: string;
  git_commit_sha: string;
  currentImage: string | null;
  /** p12-deploy-feedback: the container output (`GET /applications/{uuid}/logs`); null = no running container (404). */
  runtimeLogs?: string | null;
  /** p15-coolify-create: the Coolify environment (numeric id) and the fields the editors read. */
  environment_id?: number;
  build_pack?: string;
  ports_exposes?: string;
  git_repository?: string;
  /** p15-coolify-dedupe: more of what `GET /applications` reports (the duplicate guard compares them). */
  base_directory?: string;
  dockerfile_location?: string;
  docker_registry_image_name?: string;
  start_command?: string;
  [field: string]: unknown;
}

/** p15-coolify-create: an environment variable as the fake keeps it (the value is returned like `read:sensitive`). */
export interface FakeEnv {
  uuid: string;
  key: string;
  value: string;
  is_preview: boolean;
  is_buildtime: boolean;
  is_runtime: boolean;
  is_literal: boolean;
  is_multiline: boolean;
}

/**
 * p15-coolify-create: the documented body fields of each create endpoint and of the env endpoints (the real API
 * refuses any other field with 422 "This field is not allowed." — the fake does the same, so a test fails when the
 * master sends an undocumented field).
 */
const COMMON_CREATE = [
  'project_uuid',
  'server_uuid',
  'environment_name',
  'environment_uuid',
  'destination_uuid',
  'name',
  'description',
  'domains',
  'ports_exposes',
  'instant_deploy',
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
];
const GIT_CREATE = [
  ...COMMON_CREATE,
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
export const FAKE_CREATE_FIELDS: Readonly<Record<string, { allowed: string[]; required: string[] }>> = {
  public: {
    allowed: GIT_CREATE,
    required: ['project_uuid', 'server_uuid', 'git_repository', 'git_branch', 'build_pack'],
  },
  'private-github-app': {
    allowed: [...GIT_CREATE, 'github_app_uuid'],
    required: [
      'project_uuid',
      'server_uuid',
      'github_app_uuid',
      'git_repository',
      'git_branch',
      'build_pack',
    ],
  },
  'private-deploy-key': {
    allowed: [...GIT_CREATE, 'private_key_uuid'],
    required: [
      'project_uuid',
      'server_uuid',
      'private_key_uuid',
      'git_repository',
      'git_branch',
      'build_pack',
    ],
  },
  dockerfile: {
    allowed: [...COMMON_CREATE, 'dockerfile', 'build_pack', 'base_directory'],
    required: ['project_uuid', 'server_uuid', 'dockerfile'],
  },
  dockerimage: {
    allowed: [...COMMON_CREATE, 'docker_registry_image_name', 'docker_registry_image_tag'],
    required: ['project_uuid', 'server_uuid', 'docker_registry_image_name'],
  },
};
/** p15-coolify-dedupe: the documented `PATCH /applications/{uuid}` fields the master may send (others → 422). */
export const FAKE_UPDATE_FIELDS = [
  'name',
  'description',
  'domains',
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
];
const ENV_FIELDS = [
  'key',
  'value',
  'is_preview',
  'is_literal',
  'is_multiline',
  'is_shown_once',
  'is_runtime',
  'is_buildtime',
  'comment',
];

/** p17-coolify-full: a storage as the fake keeps it (the real API's LocalPersistentVolume / LocalFileVolume). */
export interface FakeStorage {
  id: number;
  uuid: string;
  type: 'persistent' | 'file';
  name?: string;
  mount_path: string;
  host_path?: string | null;
  fs_path?: string;
  content?: string | null;
  is_directory?: boolean;
  is_readonly?: boolean;
  resource_uuid?: string;
}

/** p17-coolify-full: a standalone database (secret fields included like a read:sensitive token sees them). */
export interface FakeDb {
  uuid: string;
  name: string;
  database_type: string;
  status: string;
  environment_id: number;
  image?: string;
  is_public?: boolean;
  public_port?: number | null;
  postgres_user?: string;
  postgres_password?: string;
  postgres_db?: string;
  internal_db_url?: string;
  [field: string]: unknown;
}

export interface FakeService {
  uuid: string;
  name: string;
  service_type: string | null;
  status: string;
  environment_id: number;
  docker_compose_raw?: string;
  applications: { uuid: string; name: string; status: string; fqdn: string | null }[];
  databases: { uuid: string; name: string; status: string }[];
  [field: string]: unknown;
}

const STORAGE_CREATE = ['type', 'name', 'mount_path', 'content', 'is_directory', 'is_host_file', 'fs_path'];
const STORAGE_CREATE_OLD = [...STORAGE_CREATE, 'host_path'];
const STORAGE_UPDATE = ['uuid', 'id', 'type', 'is_preview_suffix_enabled', 'name', 'mount_path', 'content'];
const DB_COMMON = [
  'server_uuid',
  'project_uuid',
  'environment_name',
  'environment_uuid',
  'destination_uuid',
  'name',
  'description',
  'image',
  'is_public',
  'public_port',
  'public_port_timeout',
  'limits_memory',
  'limits_memory_swap',
  'limits_memory_swappiness',
  'limits_memory_reservation',
  'limits_cpus',
  'limits_cpuset',
  'limits_cpu_shares',
  'instant_deploy',
  'tags',
];
export const FAKE_DB_FIELDS: Readonly<Record<string, string[]>> = {
  postgresql: [
    ...DB_COMMON,
    'postgres_user',
    'postgres_password',
    'postgres_db',
    'postgres_initdb_args',
    'postgres_host_auth_method',
    'postgres_conf',
  ],
  mysql: [
    ...DB_COMMON,
    'mysql_user',
    'mysql_password',
    'mysql_database',
    'mysql_root_password',
    'mysql_conf',
  ],
  mariadb: [
    ...DB_COMMON,
    'mariadb_user',
    'mariadb_password',
    'mariadb_database',
    'mariadb_root_password',
    'mariadb_conf',
  ],
  mongodb: [...DB_COMMON, 'mongo_initdb_root_username', 'mongo_conf'],
  redis: [...DB_COMMON, 'redis_password', 'redis_conf'],
  keydb: [...DB_COMMON, 'keydb_password', 'keydb_conf'],
  dragonfly: [...DB_COMMON, 'dragonfly_password'],
  clickhouse: [...DB_COMMON, 'clickhouse_admin_user', 'clickhouse_admin_password'],
};
const SERVICE_CREATE = [
  'type',
  'name',
  'description',
  'project_uuid',
  'environment_name',
  'environment_uuid',
  'server_uuid',
  'destination_uuid',
  'instant_deploy',
  'docker_compose_raw',
  'connect_to_docker_network',
  'urls',
  'force_domain_override',
  'is_container_label_escape_enabled',
  'redact_all_env_values_in_logs',
  'tags',
];
const BACKUP_FIELDS = [
  'frequency',
  'enabled',
  'save_s3',
  'disable_local_backup',
  's3_storage_uuid',
  's3_storage_uuids',
  'databases_to_backup',
  'dump_all',
  'backup_now',
  'database_backup_retention_amount_locally',
  'database_backup_retention_days_locally',
  'database_backup_retention_max_storage_locally',
  'database_backup_retention_amount_s3',
  'database_backup_retention_days_s3',
  'database_backup_retention_max_storage_s3',
  'timeout',
  'missing_backup_notification_days',
];

export class FakeCoolify extends FakeServer {
  token = 'coolify-canary-token-1|AbCdEf0123456789XyZ';
  abilities: { read: boolean; deploy: boolean; write: boolean; readSensitive?: boolean } = {
    read: true,
    deploy: true,
    write: false,
  };
  /** p17-coolify-full: `GET /version` (features such as storages depend on it). */
  version = 'v4.0.0-beta.fake';
  /** p17-coolify-full: the storage API: `full` (v4.3+ fields), `old` (≤ 4.2: `host_path`), `none` (route missing). */
  storageApi: 'full' | 'old' | 'none' = 'full';
  readonly storages = new Map<string, FakeStorage[]>();
  readonly databases = new Map<string, FakeDb>();
  readonly backups = new Map<
    string,
    { uuid: string; frequency: string; enabled: boolean; [k: string]: unknown; executions: unknown[] }[]
  >();
  readonly services = new Map<string, FakeService>();
  readonly serviceEnvs = new Map<string, FakeEnv[]>();
  /** Start / stop / restart calls: `<kind> <uuid> <action>?<query>`. */
  readonly lifecycleCalls: string[] = [];
  readonly createdDatabases: { engine: string; body: Record<string, unknown>; uuid: string }[] = [];
  readonly createdServices: { body: Record<string, unknown>; uuid: string }[] = [];
  readonly deletedResources: { kind: string; uuid: string; query: Record<string, string> }[] = [];
  readonly validated: string[] = [];
  /** Running deployments (`GET /deployments`). */
  running: { deployment_uuid: string; status: string; application_name: string; server_name: string }[] = [];
  readonly apps = new Map<string, FakeApp>();
  readonly deployments = new Map<string, { status: string; app: string; logs: string; commit: string }>();
  // p15-coolify-create: what creating an application needs, and the variables per application.
  servers: { uuid: string; name: string; ip: string }[] = [
    { uuid: 'srv0000001', name: 'main', ip: '203.0.113.10' },
  ];
  projects: { uuid: string; name: string; environments: { id: number; uuid: string; name: string }[] }[] = [];
  githubApps: { uuid: string; name: string }[] = [];
  keys: { uuid: string; name: string; fingerprint: string; private_key: string }[] = [];
  /** null: `GET /servers/{uuid}/destinations` answers 404 (older Coolify). */
  destinations: { uuid: string; name: string; network: string }[] | null = null;
  readonly envs = new Map<string, FakeEnv[]>();
  /** The bodies of `POST /applications/<kind>` (kind → bodies). */
  readonly created: { kind: string; body: Record<string, unknown>; uuid: string }[] = [];
  /** p15-coolify-dedupe: `DELETE /applications/{uuid}` calls (uuid + the query flags). */
  readonly deleted: { uuid: string; query: Record<string, string> }[] = [];
  #seq = 0;

  addApp(a: Partial<FakeApp> & { uuid: string }): void {
    this.apps.set(a.uuid, {
      name: a.uuid,
      fqdn: `https://${a.uuid}.example.test`,
      status: 'running:healthy',
      tags: [],
      git_branch: 'main',
      git_commit_sha: 'abc1234',
      currentImage: 'img-old',
      ...a,
    });
  }

  protected errorBody(status: number): unknown {
    return {
      message: status === 429 ? 'Rate limit exceeded.' : status === 401 ? 'Unauthenticated.' : 'Forbidden.',
    };
  }

  /** The 422 of the real API for unknown / missing fields (null: fine). */
  #invalid(body: Record<string, unknown>, allowed: string[], required: string[]): unknown {
    const errors: Record<string, string[]> = {};
    for (const k of Object.keys(body)) if (!allowed.includes(k)) errors[k] = ['This field is not allowed.'];
    for (const k of required)
      if (body[k] === undefined || body[k] === '') errors[k] = [`The ${k} field is required.`];
    return Object.keys(errors).length === 0 ? null : { message: 'Validation failed.', errors };
  }

  #hosts(fqdn: string): string[] {
    return fqdn
      .split(',')
      .map((d) => d.trim())
      .filter((d) => d !== '')
      .map((d) => new URL(d.includes('://') ? d : `https://${d}`).hostname);
  }

  /** A domain another application already serves → the documented 409 body. */
  #conflict(domains: string, self: string | null): unknown {
    const conflicts: {
      domain: string;
      resource_name: string;
      resource_uuid: string;
      resource_type: string;
    }[] = [];
    for (const h of this.#hosts(domains)) {
      for (const a of this.apps.values()) {
        if (a.uuid !== self && this.#hosts(a.fqdn).includes(h)) {
          conflicts.push({
            domain: h,
            resource_name: a.name,
            resource_uuid: a.uuid,
            resource_type: 'application',
          });
        }
      }
    }
    return conflicts.length === 0
      ? null
      : {
          message: 'Domain conflicts detected. Use force_domain_override=true to proceed.',
          warning: 'Using the same domain for multiple resources can cause routing conflicts.',
          conflicts,
        };
  }

  /** p15-coolify-create endpoints; true when the request was answered. */
  #manage(m: string, p: string, rec: Recorded, res: ServerResponse, deny: (ok: boolean) => boolean): boolean {
    const body = (): Record<string, unknown> => {
      try {
        return rec.body === '' ? {} : (JSON.parse(rec.body) as Record<string, unknown>);
      } catch {
        return {};
      }
    };
    if (m === 'GET' && p === '/servers') {
      if (!deny(this.abilities.read)) {
        this.send(
          res,
          200,
          this.servers.map((s) => ({ ...s, settings: { is_reachable: true, is_usable: true } })),
        );
      }
      return true;
    }
    if (m === 'GET' && p === '/projects') {
      if (!deny(this.abilities.read)) {
        this.send(
          res,
          200,
          this.projects.map((x) => ({ id: 1, uuid: x.uuid, name: x.name, description: null })),
        );
      }
      return true;
    }
    let mm = /^\/projects\/([^/]+)\/environments$/.exec(p);
    if (mm !== null && m === 'GET') {
      if (deny(this.abilities.read)) return true;
      const proj = this.projects.find((x) => x.uuid === decodeURIComponent(mm?.[1] ?? ''));
      if (proj === undefined) this.send(res, 404, { message: 'Project not found.' });
      else this.send(res, 200, proj.environments);
      return true;
    }
    mm = /^\/servers\/([^/]+)\/destinations$/.exec(p);
    if (mm !== null && m === 'GET') {
      if (deny(this.abilities.read)) return true;
      if (this.destinations === null) this.send(res, 404, { message: 'Not found.' });
      else this.send(res, 200, this.destinations);
      return true;
    }
    if (m === 'GET' && p === '/github-apps') {
      if (!deny(this.abilities.read)) this.send(res, 200, this.githubApps);
      return true;
    }
    if (m === 'GET' && p === '/security/keys') {
      if (!deny(this.abilities.read)) this.send(res, 200, this.keys);
      return true;
    }
    mm = /^\/applications\/(public|private-github-app|private-deploy-key|dockerfile|dockerimage)$/.exec(p);
    if (mm !== null && m === 'POST') {
      if (deny(this.abilities.write)) return true;
      const kind = mm[1] ?? '';
      const spec = FAKE_CREATE_FIELDS[kind];
      const b = body();
      if (spec === undefined) return false;
      const bad = this.#invalid(b, spec.allowed, spec.required);
      if (bad !== null) {
        this.send(res, 422, bad);
        return true;
      }
      if (b.environment_name === undefined && b.environment_uuid === undefined) {
        this.send(res, 422, { message: 'Validation failed.', errors: { environment_name: ['required'] } });
        return true;
      }
      const proj = this.projects.find((x) => x.uuid === b.project_uuid);
      const env = proj?.environments.find(
        (e) => e.name === b.environment_name || e.uuid === b.environment_uuid,
      );
      if (proj === undefined || env === undefined) {
        this.send(res, 404, { message: 'Environment not found.' });
        return true;
      }
      if (typeof b.domains === 'string') {
        const c = this.#conflict(b.domains, null);
        if (c !== null) {
          this.send(res, 409, c);
          return true;
        }
      }
      const uuid = `new${String(++this.#seq).padStart(6, '0')}`;
      this.created.push({ kind, body: b, uuid });
      this.addApp({
        uuid,
        name: typeof b.name === 'string' ? b.name : uuid,
        fqdn: typeof b.domains === 'string' ? b.domains : '',
        status: 'exited',
        environment_id: env.id,
        build_pack: typeof b.build_pack === 'string' ? b.build_pack : 'dockerimage',
        ports_exposes: typeof b.ports_exposes === 'string' ? b.ports_exposes : '',
        git_repository: typeof b.git_repository === 'string' ? b.git_repository : '',
        git_branch: typeof b.git_branch === 'string' ? b.git_branch : '',
        ...(typeof b.base_directory === 'string' ? { base_directory: b.base_directory } : {}),
        ...(typeof b.dockerfile_location === 'string' ? { dockerfile_location: b.dockerfile_location } : {}),
        ...(typeof b.docker_registry_image_name === 'string'
          ? { docker_registry_image_name: b.docker_registry_image_name }
          : {}),
      });
      this.envs.set(uuid, []);
      this.send(res, 201, { uuid });
      return true;
    }
    mm = /^\/applications\/([^/]+)$/.exec(p);
    if (mm !== null && m === 'PATCH') {
      const app = this.apps.get(decodeURIComponent(mm[1] ?? ''));
      const b = body();
      if (app === undefined || Object.keys(b).length === 0) return false; // the ability probe path
      if (deny(this.abilities.write)) return true;
      const bad = this.#invalid(b, FAKE_UPDATE_FIELDS, []);
      if (bad !== null) {
        this.send(res, 422, bad);
        return true;
      }
      if (typeof b.domains === 'string') {
        const c = this.#conflict(b.domains, app.uuid);
        if (c !== null) {
          this.send(res, 409, c);
          return true;
        }
        app.fqdn = b.domains;
      }
      for (const [k, v] of Object.entries(b)) if (k !== 'domains') app[k] = v;
      this.send(res, 200, { uuid: app.uuid });
      return true;
    }
    if (mm !== null && m === 'DELETE') {
      if (deny(this.abilities.write)) return true;
      const uuid = decodeURIComponent(mm[1] ?? '');
      if (!this.apps.has(uuid)) {
        this.send(res, 404, { message: 'Application not found.' });
        return true;
      }
      const q = Object.fromEntries(new URL(rec.path, 'http://x').searchParams.entries());
      this.deleted.push({ uuid, query: q });
      this.apps.delete(uuid);
      this.envs.delete(uuid);
      this.send(res, 200, { message: 'Application deletion request queued.' });
      return true;
    }
    mm = /^\/deployments\/applications\/([^/]+)$/.exec(p);
    if (mm !== null && m === 'GET') {
      if (deny(this.abilities.read)) return true;
      const uuid = decodeURIComponent(mm[1] ?? '');
      if (!this.apps.has(uuid)) {
        this.send(res, 404, { message: 'Application not found.' });
        return true;
      }
      const url = new URL(rec.path, 'http://x');
      const take = Number.parseInt(url.searchParams.get('take') ?? '10', 10);
      const list = [...this.deployments.entries()]
        .filter(([, d]) => d.app === uuid)
        .reverse()
        .slice(0, take)
        .map(([id, d]) => ({ deployment_uuid: id, status: d.status, commit: d.commit, created_at: null }));
      this.send(res, 200, { count: list.length, deployments: list });
      return true;
    }
    mm = /^\/applications\/([^/]+)\/envs(\/bulk|\/[^/]+)?$/.exec(p);
    if (mm !== null) {
      const uuid = decodeURIComponent(mm[1] ?? '');
      const list = this.envs.get(uuid);
      if (!this.apps.has(uuid) || list === undefined) {
        this.send(res, 404, { message: 'Application not found' });
        return true;
      }
      const tail = mm[2] ?? '';
      const write = (
        b: Record<string, unknown>,
        mustExist: boolean,
      ): FakeEnv | { status: number; body: unknown } => {
        const bad = this.#invalid(b, ENV_FIELDS, ['key']);
        if (bad !== null) return { status: 422, body: bad };
        const preview = b.is_preview === true;
        const cur = list.find((e) => e.key === b.key && e.is_preview === preview);
        if (mustExist && cur === undefined)
          return { status: 404, body: { message: 'Environment variable not found.' } };
        const next: FakeEnv = {
          uuid: cur?.uuid ?? `env${String(++this.#seq)}`,
          key: String(b.key),
          value: typeof b.value === 'string' ? b.value : '',
          is_preview: preview,
          is_buildtime: b.is_buildtime === undefined ? (cur?.is_buildtime ?? true) : b.is_buildtime === true,
          is_runtime: b.is_runtime === undefined ? (cur?.is_runtime ?? true) : b.is_runtime === true,
          is_literal: b.is_literal === true,
          is_multiline: b.is_multiline === true,
        };
        if (cur === undefined) list.push(next);
        else Object.assign(cur, next);
        return next;
      };
      if (tail === '' && m === 'GET') {
        if (!deny(this.abilities.read)) this.send(res, 200, list);
        return true;
      }
      if (deny(this.abilities.write)) return true;
      if (tail === '' && m === 'POST') {
        const b = body();
        if (list.some((e) => e.key === b.key && e.is_preview === (b.is_preview === true))) {
          this.send(res, 409, {
            message: 'Environment variable already exists. Use PATCH request to update it.',
          });
          return true;
        }
        const out = write(b, false);
        if ('status' in out) this.send(res, out.status, out.body);
        else this.send(res, 201, { uuid: out.uuid });
        return true;
      }
      if (tail === '' && m === 'PATCH') {
        const out = write(body(), true);
        if ('status' in out) this.send(res, out.status, out.body);
        else this.send(res, 201, out);
        return true;
      }
      if (tail === '/bulk' && m === 'PATCH') {
        const data = body().data;
        if (!Array.isArray(data)) {
          this.send(res, 422, { message: 'Validation failed.', errors: { data: ['required'] } });
          return true;
        }
        const out: FakeEnv[] = [];
        for (const d of data as Record<string, unknown>[]) {
          const r = write(d, false);
          if ('status' in r) {
            this.send(res, r.status, r.body);
            return true;
          }
          out.push(r);
        }
        this.send(res, 201, out);
        return true;
      }
      if (tail !== '' && tail !== '/bulk' && m === 'DELETE') {
        const id = decodeURIComponent(tail.slice(1));
        const i = list.findIndex((e) => e.uuid === id);
        if (i < 0) this.send(res, 404, { message: 'Environment variable not found.' });
        else {
          list.splice(i, 1);
          this.send(res, 200, { message: 'Environment variable deleted.' });
        }
        return true;
      }
    }
    return false;
  }

  protected handle(_req: IncomingMessage, rec: Recorded, res: ServerResponse): void {
    if (rec.auth !== `Bearer ${this.token}`) {
      this.send(res, 401, { message: 'Unauthenticated.' });
      return;
    }
    const url = new URL(rec.path, 'http://x');
    const p = url.pathname.replace(/^\/api\/v1/, '');
    const m = rec.method;
    const deny = (ok: boolean): boolean => {
      if (!ok) this.send(res, 403, { message: 'You are not allowed to access this endpoint.' });
      return !ok;
    };
    if (m === 'GET' && p === '/version') {
      this.send(res, 200, this.version, 'text/html');
      return;
    }
    if (this.#full(m, p, url, rec, res, deny)) return;
    if (m === 'GET' && p === '/team') {
      this.send(res, 200, { id: 0, name: 'Root Team' });
      return;
    }
    if (this.#manage(m, p, rec, res, deny)) return;
    if (m === 'GET' && p === '/applications') {
      if (deny(this.abilities.read)) return;
      const tag = url.searchParams.get('tag');
      this.send(
        res,
        200,
        [...this.apps.values()].filter((a) => tag === null || a.tags.includes(tag)),
      );
      return;
    }
    let mm = /^\/applications\/([^/]+)$/.exec(p);
    if (mm !== null) {
      const app = this.apps.get(decodeURIComponent(mm[1] ?? ''));
      if (m === 'GET') {
        if (deny(this.abilities.read)) return;
        if (app === undefined) this.send(res, 404, { message: 'Resource not found.' });
        else this.send(res, 200, app);
        return;
      }
      if (m === 'PATCH') {
        if (deny(this.abilities.write)) return;
        if (app === undefined) this.send(res, 404, { message: 'Resource not found.' });
        else this.send(res, 200, app);
        return;
      }
    }
    if (m === 'POST' && p === '/deploy') {
      if (deny(this.abilities.deploy)) return;
      const uuids = (url.searchParams.get('uuid') ?? '').split(',').filter((x) => x !== '');
      const deployments = uuids.map((u) => {
        const id = `dep${String(++this.#seq)}`;
        this.deployments.set(id, {
          status: 'queued',
          app: u,
          commit: 'def5678',
          logs: JSON.stringify([
            { output: 'Building image', hidden: false },
            { output: 'secret env GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', hidden: false },
            { output: 'internal', hidden: true },
          ]),
        });
        return { message: 'Deployment queued.', resource_uuid: u, deployment_uuid: id };
      });
      this.send(res, 200, { deployments });
      return;
    }
    // p12-deploy-feedback: application runtime logs (the last `lines` lines); route ability read:sensitive.
    mm = /^\/applications\/([^/]+)\/logs$/.exec(p);
    if (mm !== null && m === 'GET') {
      if (deny(this.abilities.readSensitive ?? this.abilities.read)) return;
      const app = this.apps.get(decodeURIComponent(mm[1] ?? ''));
      if (app === undefined || app.runtimeLogs == null) {
        this.send(res, 404, { message: 'No running container found.' });
        return;
      }
      const lines = Number.parseInt(url.searchParams.get('lines') ?? '100', 10);
      this.send(res, 200, { logs: app.runtimeLogs.split('\n').slice(-lines).join('\n') });
      return;
    }
    mm = /^\/applications\/([^/]+)\/(restart|rollback-images|rollback)$/.exec(p);
    if (mm !== null) {
      const app = this.apps.get(decodeURIComponent(mm[1] ?? ''));
      if (app === undefined) {
        this.send(res, 404, { message: 'Resource not found.' });
        return;
      }
      if (mm[2] === 'rollback-images' && m === 'GET') {
        if (deny(this.abilities.read)) return;
        this.send(res, 200, { current: app.currentImage, images: [] });
        return;
      }
      if (deny(this.abilities.deploy)) return;
      const id = `dep${String(++this.#seq)}`;
      this.deployments.set(id, { status: 'queued', app: app.uuid, commit: '', logs: '[]' });
      if (mm[2] === 'rollback') app.currentImage = (JSON.parse(rec.body) as { commit: string }).commit;
      this.send(res, 200, { message: 'queued', deployment_uuid: id });
      return;
    }
    mm = /^\/deployments\/([^/]+)(\/cancel)?$/.exec(p);
    if (mm !== null) {
      const d = this.deployments.get(decodeURIComponent(mm[1] ?? ''));
      if (mm[2] === '/cancel') {
        if (deny(this.abilities.deploy)) return;
        if (d === undefined) this.send(res, 404, { message: 'Deployment not found.' });
        else this.send(res, 200, {});
        return;
      }
      if (deny(this.abilities.read)) return;
      if (d === undefined) {
        this.send(res, 404, { message: 'Deployment not found.' });
        return;
      }
      this.send(res, 200, {
        deployment_uuid: mm[1],
        status: d.status,
        commit: d.commit,
        application_name: d.app,
        logs: d.logs,
      });
      return;
    }
    // The real API's catch-all route (an unknown path): 404 with `docs`.
    this.send(res, 404, { message: 'Not found.', docs: 'https://coolify.io/docs' });
  }

  #body(rec: Recorded): Record<string, unknown> {
    try {
      return rec.body === '' ? {} : (JSON.parse(rec.body) as Record<string, unknown>);
    } catch {
      return {};
    }
  }

  /** The kind and record of `/<applications|databases|services>/{uuid}` (null: unknown uuid). */
  #resourceOf(kind: string, uuid: string): { name: string; env: number } | null {
    if (kind === 'applications') {
      const a = this.apps.get(uuid);
      return a === undefined ? null : { name: a.name, env: a.environment_id ?? 0 };
    }
    if (kind === 'databases') {
      const d = this.databases.get(uuid);
      return d === undefined ? null : { name: d.name, env: d.environment_id };
    }
    const sv = this.services.get(uuid);
    return sv === undefined ? null : { name: sv.name, env: sv.environment_id };
  }

  /** p17-coolify-full endpoints; true when the request was answered. */
  #full(
    m: string,
    p: string,
    url: URL,
    rec: Recorded,
    res: ServerResponse,
    deny: (ok: boolean) => boolean,
  ): boolean {
    const notFound = (what: string): true => {
      this.send(res, 404, { message: `${what} not found.` });
      return true;
    };
    const invalid = (b: Record<string, unknown>, allowed: string[], required: string[]): boolean => {
      const bad = this.#invalid(b, allowed, required);
      if (bad !== null) this.send(res, 422, bad);
      return bad !== null;
    };
    if (m === 'GET' && p === '/resources') {
      if (deny(this.abilities.read)) return true;
      this.send(res, 200, [
        ...[...this.apps.values()].map((a) => ({
          uuid: a.uuid,
          name: a.name,
          type: 'application',
          status: a.status,
          environment_id: a.environment_id ?? 0,
          fqdn: a.fqdn,
        })),
        ...[...this.databases.values()].map((d) => ({
          uuid: d.uuid,
          name: d.name,
          type: d.database_type,
          status: d.status,
          environment_id: d.environment_id,
        })),
        ...[...this.services.values()].map((sv) => ({
          uuid: sv.uuid,
          name: sv.name,
          type: 'service',
          status: sv.status,
          environment_id: sv.environment_id,
        })),
      ]);
      return true;
    }
    if (m === 'GET' && p === '/deployments') {
      if (deny(this.abilities.read)) return true;
      this.send(res, 200, this.running);
      return true;
    }
    // Storages of applications, databases, services.
    let mm = /^\/(applications|databases|services)\/([^/]+)\/storages(?:\/([^/]+))?$/.exec(p);
    if (mm !== null) {
      if (this.storageApi === 'none') return false; // → the catch-all 404 with docs
      const kind = mm[1] ?? '';
      const uuid = decodeURIComponent(mm[2] ?? '');
      const sid = mm[3] === undefined ? null : decodeURIComponent(mm[3]);
      const r = this.#resourceOf(kind, uuid);
      if (m === 'GET' && sid === null) {
        if (deny(this.abilities.read)) return true;
        if (r === null) return notFound('Resource');
        const list = this.storages.get(uuid) ?? [];
        this.send(res, 200, {
          persistent_storages: list.filter((x) => x.type === 'persistent'),
          file_storages: list.filter((x) => x.type === 'file'),
        });
        return true;
      }
      if (deny(this.abilities.write)) return true;
      if (r === null) return notFound('Resource');
      const list = this.storages.get(uuid) ?? [];
      this.storages.set(uuid, list);
      const b = this.#body(rec);
      if (m === 'POST' && sid === null) {
        const allowed = [
          ...(this.storageApi === 'old' ? STORAGE_CREATE_OLD : STORAGE_CREATE),
          ...(kind === 'services' ? ['resource_uuid'] : []),
        ];
        if (invalid(b, allowed, ['type', 'mount_path', ...(kind === 'services' ? ['resource_uuid'] : [])]))
          return true;
        if (b.type === 'persistent' && typeof b.name !== 'string') {
          this.send(res, 422, {
            message: 'Validation failed.',
            errors: { name: 'The name field is required for persistent storages.' },
          });
          return true;
        }
        if (b.type === 'file' && b.is_directory === true && typeof b.fs_path !== 'string') {
          this.send(res, 422, {
            message: 'Validation failed.',
            errors: { fs_path: 'The fs_path field is required for directory mounts.' },
          });
          return true;
        }
        if (typeof b.content === 'string' && b.content !== '' && !this.abilities.deploy) {
          this.send(res, 403, { message: 'needs the deploy permission' });
          return true;
        }
        const st: FakeStorage = {
          id: ++this.#seq,
          uuid: `st${String(this.#seq).padStart(6, '0')}`,
          type: b.type === 'persistent' ? 'persistent' : 'file',
          mount_path: String(b.mount_path),
          ...(b.type === 'persistent'
            ? {
                name: `${uuid}-${String(b.name)}`,
                host_path: typeof b.host_path === 'string' ? b.host_path : null,
              }
            : {
                fs_path:
                  typeof b.fs_path === 'string'
                    ? b.fs_path
                    : `/data/coolify/applications/${uuid}${String(b.mount_path)}`,
                content: typeof b.content === 'string' ? b.content : null,
                is_directory: b.is_directory === true,
              }),
          ...(typeof b.resource_uuid === 'string' ? { resource_uuid: b.resource_uuid } : {}),
        };
        list.push(st);
        this.send(res, 201, st);
        return true;
      }
      if (m === 'PATCH' && sid === null) {
        if (invalid(b, [...STORAGE_UPDATE, ...(this.storageApi === 'old' ? ['host_path'] : [])], ['type']))
          return true;
        const st = list.find((x) => x.uuid === b.uuid);
        if (st === undefined) return notFound('Storage');
        if (st.is_readonly === true) {
          this.send(res, 422, { message: 'This storage is read-only.' });
          return true;
        }
        if (typeof b.name === 'string') st.name = b.name;
        if (typeof b.mount_path === 'string') st.mount_path = b.mount_path;
        if (b.content !== undefined) st.content = b.content as string | null;
        this.send(res, 200, st);
        return true;
      }
      if (m === 'DELETE' && sid !== null) {
        const i = list.findIndex((x) => x.uuid === sid);
        if (i < 0) return notFound('Storage');
        list.splice(i, 1);
        this.send(res, 200, { message: 'Storage deleted.' });
        return true;
      }
      return false;
    }
    // start / stop / restart of databases and services, start / stop of applications (restart is older).
    mm = /^\/(applications|databases|services)\/([^/]+)\/(start|stop|restart)$/.exec(p);
    if (mm !== null && m === 'POST' && !(mm[1] === 'applications' && mm[3] === 'restart')) {
      if (deny(this.abilities.deploy)) return true;
      const uuid = decodeURIComponent(mm[2] ?? '');
      if (this.#resourceOf(mm[1] ?? '', uuid) === null) return notFound('Resource');
      this.lifecycleCalls.push(`${mm[1] ?? ''} ${uuid} ${mm[3] ?? ''}${url.search}`);
      const status = mm[3] === 'stop' ? 'exited' : 'running:healthy';
      if (mm[1] === 'applications') {
        const a = this.apps.get(uuid);
        if (a !== undefined) a.status = status;
        const id = `dep${String(++this.#seq)}`;
        if (mm[3] === 'start')
          this.deployments.set(id, { status: 'queued', app: uuid, commit: '', logs: '[]' });
        this.send(res, 200, {
          message: mm[3] === 'start' ? 'Deployment request queued.' : 'Application stopping request queued.',
          ...(mm[3] === 'start' ? { deployment_uuid: id } : {}),
        });
        return true;
      }
      const target = mm[1] === 'databases' ? this.databases.get(uuid) : this.services.get(uuid);
      if (target !== undefined) target.status = status;
      this.send(res, 200, { message: `${mm[3] ?? ''} request queued.` });
      return true;
    }
    // Logs of databases / services (read:sensitive).
    mm = /^\/(databases|services)\/([^/]+)\/logs$/.exec(p);
    if (mm !== null && m === 'GET') {
      if (deny(this.abilities.readSensitive ?? this.abilities.read)) return true;
      const uuid = decodeURIComponent(mm[2] ?? '');
      if (this.#resourceOf(mm[1] ?? '', uuid) === null) return notFound('Resource');
      if (mm[1] === 'services') {
        const sv = this.services.get(uuid);
        const sub = url.searchParams.get('sub_service_name');
        const names = [...(sv?.applications ?? []), ...(sv?.databases ?? [])].map((x) => x.name);
        if (sub === null || !names.includes(sub)) {
          this.send(res, 422, { message: 'Validation failed.', errors: { sub_service_name: ['invalid'] } });
          return true;
        }
      }
      this.send(res, 200, { logs: `log of ${uuid}\npassword=hunter2-secret-value-abcdef123456` });
      return true;
    }
    // Databases.
    if (m === 'GET' && p === '/databases') {
      if (deny(this.abilities.read)) return true;
      this.send(res, 200, [...this.databases.values()]);
      return true;
    }
    mm = /^\/databases\/(postgresql|mysql|mariadb|mongodb|redis|keydb|dragonfly|clickhouse)$/.exec(p);
    if (mm !== null && m === 'POST') {
      if (deny(this.abilities.write)) return true;
      const engine = mm[1] ?? '';
      const b = this.#body(rec);
      if (invalid(b, FAKE_DB_FIELDS[engine] ?? [], ['server_uuid', 'project_uuid'])) return true;
      const proj = this.projects.find((x) => x.uuid === b.project_uuid);
      const env = proj?.environments.find(
        (e) => e.name === b.environment_name || e.uuid === b.environment_uuid,
      );
      if (env === undefined) return notFound('Environment');
      const uuid = `db${String(++this.#seq).padStart(6, '0')}`;
      this.createdDatabases.push({ engine, body: b, uuid });
      this.databases.set(uuid, {
        uuid,
        name: typeof b.name === 'string' ? b.name : `${engine}-${uuid}`,
        database_type: `standalone-${engine}`,
        status: b.instant_deploy === true ? 'running:healthy' : 'exited',
        environment_id: env.id,
        postgres_password: 'generated-canary-password-1234567890',
        internal_db_url: 'postgres://u:generated-canary-password-1234567890@db:5432/x',
      });
      this.storages.set(uuid, [
        {
          id: ++this.#seq,
          uuid: `st${String(this.#seq)}`,
          type: 'persistent',
          name: `postgres-data-${uuid}`,
          mount_path: '/var/lib/postgresql/data',
        },
      ]);
      this.send(res, 201, { uuid });
      return true;
    }
    mm = /^\/databases\/([^/]+)$/.exec(p);
    if (mm !== null) {
      const uuid = decodeURIComponent(mm[1] ?? '');
      const d = this.databases.get(uuid);
      if (m === 'GET') {
        if (deny(this.abilities.read)) return true;
        if (d === undefined) return notFound('Database');
        this.send(res, 200, d);
        return true;
      }
      if (m === 'PATCH') {
        if (deny(this.abilities.write)) return true;
        if (d === undefined) return notFound('Database');
        const b = this.#body(rec);
        const allowed = [
          'name',
          'description',
          'image',
          'is_public',
          'public_port',
          'public_port_timeout',
          'limits_memory',
          'limits_memory_swap',
          'limits_memory_swappiness',
          'limits_memory_reservation',
          'limits_cpus',
          'limits_cpuset',
          'limits_cpu_shares',
          'instant_deploy',
          'health_check_enabled',
          'health_check_interval',
          'health_check_timeout',
          'health_check_retries',
          'health_check_start_period',
        ];
        if (invalid(b, allowed, [])) return true;
        Object.assign(d, b);
        this.send(res, 200, { message: 'Database updated.' });
        return true;
      }
      if (m === 'DELETE') {
        if (deny(this.abilities.write && this.abilities.deploy)) return true;
        if (d === undefined) return notFound('Database');
        this.deletedResources.push({
          kind: 'database',
          uuid,
          query: Object.fromEntries(url.searchParams.entries()),
        });
        this.databases.delete(uuid);
        this.send(res, 200, { message: 'Database deleted.' });
        return true;
      }
    }
    mm = /^\/databases\/([^/]+)\/backups(?:\/([^/]+))?(\/executions)?$/.exec(p);
    if (mm !== null) {
      const uuid = decodeURIComponent(mm[1] ?? '');
      if (!this.databases.has(uuid)) return notFound('Database');
      const list = this.backups.get(uuid) ?? [];
      this.backups.set(uuid, list);
      const bid = mm[2] === undefined ? null : decodeURIComponent(mm[2]);
      if (m === 'GET') {
        if (deny(this.abilities.read)) return true;
        if (bid === null) {
          this.send(res, 200, list);
          return true;
        }
        const bk = list.find((x) => x.uuid === bid);
        if (bk === undefined) return notFound('Backup configuration');
        this.send(res, 200, { executions: bk.executions });
        return true;
      }
      if (deny(this.abilities.write)) return true;
      const b = this.#body(rec);
      if (m === 'POST' && bid === null) {
        if (invalid(b, BACKUP_FIELDS, ['frequency'])) return true;
        if (b.backup_now === true && !this.abilities.deploy) {
          this.send(res, 403, { message: 'needs deploy' });
          return true;
        }
        const id = `bk-${String(++this.#seq).padStart(6, '0')}`;
        list.push({ uuid: id, frequency: String(b.frequency), enabled: b.enabled !== false, executions: [] });
        this.send(res, 201, { uuid: id, message: 'Backup configuration created successfully.' });
        return true;
      }
      const bk = list.find((x) => x.uuid === bid);
      if (bk === undefined) return notFound('Backup configuration');
      if (m === 'PATCH') {
        if (invalid(b, BACKUP_FIELDS, [])) return true;
        Object.assign(bk, b);
        if (b.backup_now === true)
          bk.executions.push({
            uuid: `ex${String(++this.#seq)}`,
            status: 'success',
            filename: 'a.dmp',
            size: 10,
            created_at: '2026-10-27T10:00:00Z',
            message: 'pg_dump output secret',
          });
        this.send(res, 200, { message: 'Database backup configuration updated' });
        return true;
      }
      if (m === 'DELETE') {
        list.splice(list.indexOf(bk), 1);
        this.send(res, 200, { message: 'Backup configuration deleted.' });
        return true;
      }
    }
    // Services.
    if (m === 'GET' && p === '/services') {
      if (deny(this.abilities.read)) return true;
      this.send(res, 200, [...this.services.values()]);
      return true;
    }
    if (m === 'POST' && p === '/services') {
      if (deny(this.abilities.write)) return true;
      const b = this.#body(rec);
      if (invalid(b, SERVICE_CREATE, ['server_uuid', 'project_uuid'])) return true;
      const proj = this.projects.find((x) => x.uuid === b.project_uuid);
      const env = proj?.environments.find(
        (e) => e.name === b.environment_name || e.uuid === b.environment_uuid,
      );
      if (env === undefined) return notFound('Environment');
      const uuid = `svc${String(++this.#seq).padStart(6, '0')}`;
      this.createdServices.push({ body: b, uuid });
      const t = typeof b.type === 'string' ? b.type : null;
      this.services.set(uuid, {
        uuid,
        name: typeof b.name === 'string' ? b.name : `${t ?? 'compose'}-${uuid}`,
        service_type: t,
        status: 'exited',
        environment_id: env.id,
        applications: [{ uuid: `${uuid}app`, name: t ?? 'app', status: 'exited', fqdn: null }],
        databases: [],
      });
      this.serviceEnvs.set(uuid, []);
      this.send(res, 201, { uuid, domains: [] });
      return true;
    }
    mm = /^\/services\/([^/]+)$/.exec(p);
    if (mm !== null) {
      const uuid = decodeURIComponent(mm[1] ?? '');
      const sv = this.services.get(uuid);
      if (m === 'GET') {
        if (deny(this.abilities.read)) return true;
        if (sv === undefined) return notFound('Service');
        this.send(res, 200, sv);
        return true;
      }
      if (m === 'PATCH') {
        if (deny(this.abilities.write)) return true;
        if (sv === undefined) return notFound('Service');
        const b = this.#body(rec);
        if (
          invalid(
            b,
            [
              'name',
              'description',
              'instant_deploy',
              'connect_to_docker_network',
              'docker_compose_raw',
              'urls',
              'force_domain_override',
              'is_container_label_escape_enabled',
              'redact_all_env_values_in_logs',
              'include_coolify_default_variables',
            ],
            [],
          )
        )
          return true;
        Object.assign(sv, b);
        this.send(res, 200, { uuid, domains: [] });
        return true;
      }
      if (m === 'DELETE') {
        if (deny(this.abilities.write && this.abilities.deploy)) return true;
        if (sv === undefined) return notFound('Service');
        this.deletedResources.push({
          kind: 'service',
          uuid,
          query: Object.fromEntries(url.searchParams.entries()),
        });
        this.services.delete(uuid);
        this.send(res, 200, { message: 'Service deletion request queued.' });
        return true;
      }
    }
    mm = /^\/services\/([^/]+)\/envs(?:\/([^/]+))?$/.exec(p);
    if (mm !== null) {
      const uuid = decodeURIComponent(mm[1] ?? '');
      const list = this.serviceEnvs.get(uuid);
      if (list === undefined) return notFound('Service');
      if (m === 'GET') {
        if (deny(this.abilities.read)) return true;
        this.send(res, 200, list);
        return true;
      }
      if (deny(this.abilities.write)) return true;
      const b = this.#body(rec);
      if (m === 'DELETE') {
        const i = list.findIndex((e) => e.uuid === decodeURIComponent(mm?.[2] ?? ''));
        if (i < 0) return notFound('Environment variable');
        list.splice(i, 1);
        this.send(res, 200, { message: 'Environment variable deleted.' });
        return true;
      }
      if (invalid(b, ENV_FIELDS, ['key'])) return true;
      const cur = list.find((e) => e.key === b.key);
      if (m === 'POST') {
        if (cur !== undefined) {
          this.send(res, 409, { message: 'exists' });
          return true;
        }
        const e: FakeEnv = {
          uuid: `senv${String(++this.#seq)}`,
          key: String(b.key),
          value: typeof b.value === 'string' ? b.value : '',
          is_preview: false,
          is_buildtime: true,
          is_runtime: true,
          is_literal: false,
          is_multiline: false,
        };
        list.push(e);
        this.send(res, 201, { uuid: e.uuid });
        return true;
      }
      if (m === 'PATCH') {
        if (cur === undefined) return notFound('Environment variable');
        cur.value = typeof b.value === 'string' ? b.value : '';
        this.send(res, 201, cur);
        return true;
      }
    }
    // Servers.
    mm = /^\/servers\/([^/]+)(?:\/(resources|domains|validate))?$/.exec(p);
    if (mm !== null && mm[1] !== undefined && !(mm[2] === undefined && m !== 'GET')) {
      const uuid = decodeURIComponent(mm[1]);
      const srv = this.servers.find((x) => x.uuid === uuid);
      if (mm[2] === 'validate') {
        if (m !== 'POST') return false;
        if (deny(this.abilities.write)) return true;
        if (srv === undefined) return notFound('Server');
        this.validated.push(uuid);
        this.send(res, 201, { message: 'Validation started.' });
        return true;
      }
      if (m !== 'GET') return false;
      if (deny(this.abilities.read)) return true;
      if (srv === undefined) return notFound('Server');
      if (mm[2] === 'resources') {
        this.send(
          res,
          200,
          [...this.apps.values()].map((a) => ({
            id: 1,
            uuid: a.uuid,
            name: a.name,
            type: 'application',
            status: a.status,
          })),
        );
      } else if (mm[2] === 'domains') {
        this.send(res, 200, [
          { ip: srv.ip, domains: [...this.apps.values()].map((a) => a.fqdn).filter((x) => x !== '') },
        ]);
      } else {
        this.send(res, 200, {
          ...srv,
          port: 22,
          user: 'root',
          proxy_type: 'traefik',
          validation_logs: 'secret log',
          settings: { is_reachable: true, is_usable: true },
        });
      }
      return true;
    }
    // Projects / environments.
    if (m === 'POST' && p === '/projects') {
      if (deny(this.abilities.write)) return true;
      const b = this.#body(rec);
      if (invalid(b, ['name', 'description'], ['name'])) return true;
      const uuid = `proj${String(++this.#seq).padStart(6, '0')}`;
      this.projects.push({
        uuid,
        name: String(b.name),
        environments: [{ id: 1000 + this.#seq, uuid: `env${String(this.#seq)}x`, name: 'production' }],
      });
      this.send(res, 201, { uuid });
      return true;
    }
    mm = /^\/projects\/([^/]+)(?:\/environments(?:\/([^/]+))?)?$/.exec(p);
    if (mm !== null && (m === 'DELETE' || (m === 'POST' && p.endsWith('/environments')))) {
      if (deny(this.abilities.write)) return true;
      const pid = decodeURIComponent(mm[1] ?? '');
      const proj = this.projects.find((x) => x.uuid === pid);
      if (proj === undefined) return notFound('Project');
      const envName = mm[2] === undefined ? null : decodeURIComponent(mm[2]);
      if (m === 'POST') {
        const b = this.#body(rec);
        if (invalid(b, ['name'], ['name'])) return true;
        if (proj.environments.some((e) => e.name === b.name)) {
          this.send(res, 409, { message: 'Environment with this name already exists.' });
          return true;
        }
        const env = {
          id: 2000 + ++this.#seq,
          uuid: `envn${String(this.#seq).padStart(4, '0')}`,
          name: String(b.name),
        };
        proj.environments.push(env);
        this.send(res, 201, { uuid: env.uuid });
        return true;
      }
      if (envName === null) {
        const busy = [...this.apps.values()].some((a) =>
          proj.environments.some((e) => e.id === a.environment_id),
        );
        if (busy) {
          this.send(res, 400, { message: 'Project has resources, so it cannot be deleted.' });
          return true;
        }
        this.projects.splice(this.projects.indexOf(proj), 1);
        this.send(res, 200, { message: 'Project deleted.' });
        return true;
      }
      const env = proj.environments.find((e) => e.name === envName || e.uuid === envName);
      if (env === undefined) return notFound('Environment');
      proj.environments.splice(proj.environments.indexOf(env), 1);
      this.send(res, 200, { message: 'Environment deleted.' });
      return true;
    }
    return false;
  }
}

export interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

export class FakeCloudflare extends FakeServer {
  token = 'cf-canary-token-0123456789abcdefghijklmnopq';
  account = '0123456789abcdef0123456789abcdef';
  readonly zones = new Map<string, { id: string; name: string; records: FakeRecord[] }>();
  pagesAccess = true;
  /** p12-deploy-feedback: `…/deployments/{id}/history/logs` lines per deployment id. */
  readonly pagesLogs = new Map<string, { ts: string; line: string }[]>();
  readonly pagesProjects = new Map<
    string,
    {
      name: string;
      production_branch: string;
      domains: string[];
      /** p8-uptime: `latest_stage` of a listed deployment (default deploy/success). */
      deployments: {
        id: string;
        environment: string;
        url: string;
        latest_stage?: { name: string; status: string };
      }[];
    }
  >();
  readonly assets = new Set<string>();
  /** p10-site-upload: uploaded asset content per key, and the size (files) of each upload batch. */
  readonly assetContent = new Map<string, { contentType: string; bytes: Buffer }>();
  readonly assetBatches: number[] = [];
  /** p10-site-upload: the manifest (path → key) of each created deployment, newest last. */
  readonly deploymentManifests: Record<string, string>[] = [];
  /** p6-pages-create: custom domains per Pages project, and the status a newly attached domain gets. */
  readonly pagesDomains = new Map<string, { id: string; name: string; status: string }[]>();
  newDomainStatus = 'pending';
  /** p6-pages-create: suffix Cloudflare appends to the pages.dev name of a new project (name taken elsewhere). */
  subdomainSuffix = '';
  #seq = 0;

  #subdomain(name: string): string {
    return `${name}${this.subdomainSuffixOf.get(name) ?? ''}.pages.dev`;
  }
  readonly subdomainSuffixOf = new Map<string, string>();

  // p8-preview-tunnels: Cloudflare Tunnel (remotely managed) and Access — what the token may do and the state.
  tunnelAccess = true;
  accessAppsAccess = true;
  serviceTokenAccess = true;
  readonly tunnels = new Map<
    string,
    { id: string; name: string; secret: string; config: unknown; deleted: boolean; status: string }
  >();
  readonly accessApps = new Map<string, { id: string; body: Record<string, unknown> }>();
  readonly serviceTokens = new Map<
    string,
    { id: string; name: string; duration: string; clientSecret: string }
  >();
  /** The connector token Cloudflare would issue for a tunnel now (changes when the secret is rotated). */
  tunnelTokenOf(id: string): string {
    const t = this.tunnels.get(id);
    return Buffer.from(JSON.stringify({ a: this.account, t: id, s: t?.secret ?? '' }), 'utf8').toString(
      'base64',
    );
  }

  #domainBody(d: { id: string; name: string; status: string }): unknown {
    return {
      id: d.id,
      domain_id: d.id,
      name: d.name,
      status: d.status,
      certificate_authority: 'google',
      created_on: '2026-10-16T00:00:00Z',
      validation_data: {
        method: 'http',
        status: d.status,
        error_message: null,
        txt_name: null,
        txt_value: null,
      },
      verification_data: {
        status: d.status === 'active' ? 'active' : 'pending',
        error_message: null,
        zone_tag: 'z',
      },
    };
  }

  addZone(name: string): string {
    const id = (name.replace(/[^a-f0-9]/g, '') + 'a'.repeat(32)).slice(0, 32);
    this.zones.set(id, { id, name, records: [] });
    return id;
  }

  addRecord(zoneId: string, r: Omit<FakeRecord, 'id'>): FakeRecord {
    const rec = { id: `rec${String(++this.#seq).padStart(29, '0')}`, ...r };
    this.zones.get(zoneId)?.records.push(rec);
    return rec;
  }

  protected errorBody(status: number): unknown {
    return {
      success: false,
      errors: [{ code: status, message: `fake error ${String(status)}` }],
      messages: [],
      result: null,
    };
  }

  #ok(res: ServerResponse, result: unknown, info?: unknown): void {
    this.send(res, 200, {
      success: true,
      errors: [],
      messages: [],
      result,
      ...(info === undefined ? {} : { result_info: info }),
    });
  }

  protected handle(_req: IncomingMessage, rec: Recorded, res: ServerResponse): void {
    const url = new URL(rec.path, 'http://x');
    const p = url.pathname.replace(/^\/client\/v4/, '');
    const m = rec.method;
    const jwt = 'Bearer fake-upload-jwt';
    if (p.startsWith('/pages/assets/')) {
      if (rec.auth !== jwt) {
        this.send(res, 401, this.errorBody(401));
        return;
      }
      if (p === '/pages/assets/check-missing') {
        const hashes = (JSON.parse(rec.body) as { hashes: string[] }).hashes;
        this.#ok(
          res,
          hashes.filter((h) => !this.assets.has(h)),
        );
        return;
      }
      if (p === '/pages/assets/upload') {
        const batch = JSON.parse(rec.body) as {
          key: string;
          value: string;
          metadata?: { contentType?: string };
        }[];
        this.assetBatches.push(batch.length);
        for (const f of batch) {
          this.assets.add(f.key);
          // p10-site-upload: what was uploaded per key (content type, decoded bytes).
          this.assetContent.set(f.key, {
            contentType: f.metadata?.contentType ?? '',
            bytes: Buffer.from(f.value, 'base64'),
          });
        }
        this.#ok(res, null);
        return;
      }
      if (p === '/pages/assets/upsert-hashes') {
        this.#ok(res, true);
        return;
      }
    }
    if (rec.auth !== `Bearer ${this.token}`) {
      this.send(res, 401, this.errorBody(401));
      return;
    }
    if (m === 'GET' && p === `/accounts/${this.account}/tokens/verify`) {
      this.#ok(res, { id: 'tok1', status: 'active' });
      return;
    }
    if (m === 'GET' && p === '/zones') {
      this.#ok(
        res,
        [...this.zones.values()].map((z) => ({ id: z.id, name: z.name, status: 'active' })),
        { page: 1, total_pages: 1 },
      );
      return;
    }
    let mm = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(p);
    if (mm !== null) {
      const zone = this.zones.get(mm[1] ?? '');
      if (zone === undefined) {
        this.send(res, 404, this.errorBody(404));
        return;
      }
      const id = mm[2];
      if (m === 'GET' && id === undefined) {
        const name = url.searchParams.get('name.exact');
        const type = url.searchParams.get('type');
        this.#ok(
          res,
          zone.records.filter(
            (r) => (name === null || r.name === name) && (type === null || r.type === type),
          ),
        );
        return;
      }
      if (m === 'POST') {
        const b = JSON.parse(rec.body) as Omit<FakeRecord, 'id'>;
        this.#ok(res, this.addRecord(zone.id, b));
        return;
      }
      const r = zone.records.find((x) => x.id === id);
      if (r === undefined) {
        this.send(res, 404, this.errorBody(404));
        return;
      }
      if (m === 'PATCH') {
        Object.assign(r, JSON.parse(rec.body) as Partial<FakeRecord>);
        this.#ok(res, r);
        return;
      }
      if (m === 'DELETE') {
        zone.records.splice(zone.records.indexOf(r), 1);
        this.#ok(res, { id: r.id });
        return;
      }
    }
    if (this.#previewApi(m, p, url, rec, res)) return;
    const pre = `/accounts/${this.account}/pages/projects`;
    if (p.startsWith(pre)) {
      if (!this.pagesAccess) {
        this.send(res, 403, this.errorBody(403));
        return;
      }
      if (m === 'GET' && p === pre) {
        this.#ok(
          res,
          [...this.pagesProjects.values()].map((x) => ({ ...x, subdomain: this.#subdomain(x.name) })),
        );
        return;
      }
      if (m === 'POST' && p === pre) {
        // p6-pages-create: create a project (Direct Upload when no `source`).
        const b = JSON.parse(rec.body) as { name?: string; production_branch?: string; source?: unknown };
        const name = b.name ?? '';
        if (this.pagesProjects.has(name)) {
          this.send(res, 409, {
            success: false,
            errors: [{ code: 8000002, message: 'A project with this name already exists.' }],
            messages: [],
            result: null,
          });
          return;
        }
        if (this.subdomainSuffix !== '') this.subdomainSuffixOf.set(name, this.subdomainSuffix);
        const proj = { name, production_branch: b.production_branch ?? 'main', domains: [], deployments: [] };
        this.pagesProjects.set(name, proj);
        this.#ok(res, { ...proj, subdomain: this.#subdomain(name), source: b.source ?? null });
        return;
      }
      const dm = /^\/([^/]+)\/domains(?:\/([^/]+))?$/.exec(p.slice(pre.length));
      if (dm !== null) {
        const pname = dm[1] ?? '';
        const project = this.pagesProjects.get(pname);
        if (project === undefined) {
          this.send(res, 404, this.errorBody(404));
          return;
        }
        const list = this.pagesDomains.get(pname) ?? [];
        this.pagesDomains.set(pname, list);
        if (m === 'GET' && dm[2] === undefined) {
          this.#ok(
            res,
            list.map((d) => this.#domainBody(d)),
          );
          return;
        }
        if (m === 'POST' && dm[2] === undefined) {
          const name = (JSON.parse(rec.body) as { name: string }).name;
          const d = { id: `dom${String(++this.#seq)}`, name, status: this.newDomainStatus };
          list.push(d);
          project.domains.push(name);
          this.#ok(res, this.#domainBody(d));
          return;
        }
        const d = list.find((x) => x.name === decodeURIComponent(dm[2] ?? ''));
        if (m === 'GET' && d !== undefined) {
          this.#ok(res, this.#domainBody(d));
          return;
        }
        this.send(res, 404, this.errorBody(404));
        return;
      }
      mm = /^\/([^/]+)(\/upload-token|\/deployments(?:\/([^/]+)(\/rollback|\/history\/logs)?)?)?$/.exec(
        p.slice(pre.length),
      );
      const proj = this.pagesProjects.get(mm?.[1] ?? '');
      if (mm === null || proj === undefined) {
        this.send(res, 404, this.errorBody(404));
        return;
      }
      if (mm[2] === undefined) {
        this.#ok(res, { ...proj, subdomain: this.#subdomain(proj.name) });
        return;
      }
      if (mm[2] === '/upload-token') {
        this.#ok(res, { jwt: 'fake-upload-jwt' });
        return;
      }
      if (mm[3] === undefined && m === 'GET') {
        const env = url.searchParams.get('env');
        this.#ok(
          res,
          [...proj.deployments]
            .reverse()
            .filter((d) => env === null || d.environment === env)
            .map((d) => ({ latest_stage: { name: 'deploy', status: 'success' }, ...d })),
        );
        return;
      }
      if (mm[3] === undefined && m === 'POST') {
        const branch = /name="branch"\r\n\r\n([^\r]*)\r\n/.exec(rec.body)?.[1] ?? 'main';
        const manifest = /name="manifest"\r\n\r\n([^\r]*)\r\n/.exec(rec.body)?.[1];
        if (manifest !== undefined)
          this.deploymentManifests.push(JSON.parse(manifest) as Record<string, string>);
        const id = `pd${String(++this.#seq)}`;
        const d = {
          id,
          environment: branch === proj.production_branch ? 'production' : 'preview',
          url: `https://${id}.${proj.name}.pages.dev`,
        };
        proj.deployments.push(d);
        this.#ok(res, { ...d, latest_stage: { name: 'queued', status: 'active' } });
        return;
      }
      const d = proj.deployments.find((x) => x.id === mm?.[3]);
      if (d === undefined) {
        this.send(res, 404, this.errorBody(404));
        return;
      }
      if (mm[4] === '/rollback') {
        this.#ok(res, { ...d, latest_stage: { name: 'deploy', status: 'success' } });
        return;
      }
      // p12-deploy-feedback: the build log of a deployment.
      if (mm[4] === '/history/logs') {
        const lines = this.pagesLogs.get(d.id) ?? [];
        this.#ok(res, { data: lines, includes_container_logs: false, total: lines.length });
        return;
      }
      const stage = d.latest_stage ?? { name: 'deploy', status: 'success' };
      this.#ok(res, {
        ...d,
        latest_stage: stage,
        stages: [
          { name: 'queued', status: 'success', started_on: null, ended_on: null },
          { ...stage, started_on: null, ended_on: null },
        ],
      });
      return;
    }
    this.send(res, 404, this.errorBody(404));
  }

  /** p8-preview-tunnels: `/accounts/{id}/cfd_tunnel…`, `/accounts/{id}/access/apps…`, `…/access/service_tokens…`. */
  #previewApi(m: string, p: string, url: URL, rec: Recorded, res: ServerResponse): boolean {
    const acct = `/accounts/${this.account}`;
    const tm = new RegExp(`^${acct}/cfd_tunnel(?:/([^/]+)(/configurations|/token|/connections)?)?$`).exec(p);
    if (tm !== null) {
      if (!this.tunnelAccess) {
        this.send(res, 403, this.errorBody(403));
        return true;
      }
      const id = tm[1];
      if (id === undefined) {
        if (m === 'GET') {
          this.#ok(
            res,
            [...this.tunnels.values()]
              .filter((t) => !t.deleted)
              .slice(0, Number(url.searchParams.get('per_page') ?? 50)),
          );
          return true;
        }
        if (m === 'POST') {
          const b = JSON.parse(rec.body) as { name: string; config_src?: string };
          const tid = `${String(++this.#seq).padStart(8, '0')}-0000-4000-8000-${'0'.repeat(12)}`;
          const t = {
            id: tid,
            name: b.name,
            secret: `s${String(this.#seq)}`,
            config: null,
            deleted: false,
            status: 'inactive',
          };
          this.tunnels.set(tid, t);
          this.#ok(res, {
            id: tid,
            name: b.name,
            status: 'inactive',
            connections: [],
            remote_config: b.config_src === 'cloudflare',
            token: this.tunnelTokenOf(tid),
          });
          return true;
        }
      }
      const t = this.tunnels.get(id ?? '');
      if (t === undefined || t.deleted) {
        this.send(res, 404, this.errorBody(404));
        return true;
      }
      const sub = tm[2];
      if (sub === '/configurations' && m === 'PUT') {
        t.config = (JSON.parse(rec.body) as { config: unknown }).config;
        this.#ok(res, { tunnel_id: t.id, config: t.config });
        return true;
      }
      if (sub === '/token' && m === 'GET') {
        this.#ok(res, this.tunnelTokenOf(t.id));
        return true;
      }
      if (sub === '/connections' && m === 'DELETE') {
        this.#ok(res, {});
        return true;
      }
      if (sub === undefined && m === 'PATCH') {
        const b = JSON.parse(rec.body) as { tunnel_secret?: string };
        if (typeof b.tunnel_secret === 'string') t.secret = b.tunnel_secret;
        this.#ok(res, { id: t.id, name: t.name, status: t.status });
        return true;
      }
      if (sub === undefined && m === 'GET') {
        this.#ok(res, { id: t.id, name: t.name, status: t.status, connections: [] });
        return true;
      }
      if (sub === undefined && m === 'DELETE') {
        t.deleted = true;
        this.#ok(res, { id: t.id, deleted_at: '2026-10-16T00:00:00Z' });
        return true;
      }
    }
    const am = new RegExp(`^${acct}/access/apps(?:/([^/]+))?$`).exec(p);
    if (am !== null) {
      if (!this.accessAppsAccess) {
        this.send(res, 403, this.errorBody(403));
        return true;
      }
      if (am[1] === undefined && m === 'GET') {
        this.#ok(
          res,
          [...this.accessApps.values()].map((a) => ({ id: a.id, ...a.body })),
        );
        return true;
      }
      if (am[1] === undefined && m === 'POST') {
        const body = JSON.parse(rec.body) as Record<string, unknown>;
        const id = `aaaaaaaa-0000-4000-8000-${String(++this.#seq).padStart(12, '0')}`;
        this.accessApps.set(id, { id, body });
        this.#ok(res, { id, ...body, aud: 'aud' });
        return true;
      }
      if (am[1] !== undefined && m === 'DELETE') {
        if (!this.accessApps.delete(am[1])) {
          this.send(res, 404, this.errorBody(404));
          return true;
        }
        this.#ok(res, { id: am[1] });
        return true;
      }
    }
    const sm = new RegExp(`^${acct}/access/service_tokens(?:/([^/]+))?$`).exec(p);
    if (sm !== null) {
      if (!this.serviceTokenAccess) {
        this.send(res, 403, this.errorBody(403));
        return true;
      }
      if (sm[1] === undefined && m === 'GET') {
        this.#ok(
          res,
          [...this.serviceTokens.values()].map((x) => ({ id: x.id, name: x.name, duration: x.duration })),
        );
        return true;
      }
      if (sm[1] === undefined && m === 'POST') {
        const b = JSON.parse(rec.body) as { name: string; duration?: string };
        const id = `bbbbbbbb-0000-4000-8000-${String(++this.#seq).padStart(12, '0')}`;
        const st = {
          id,
          name: b.name,
          duration: b.duration ?? '8760h',
          clientSecret: `st-secret-canary-${String(this.#seq)}-0123456789abcdef`,
        };
        this.serviceTokens.set(id, st);
        this.#ok(res, {
          id,
          name: b.name,
          duration: st.duration,
          client_id: `${id.slice(0, 8)}.access`,
          client_secret: st.clientSecret,
        });
        return true;
      }
      if (sm[1] !== undefined && m === 'DELETE') {
        if (!this.serviceTokens.delete(sm[1])) {
          this.send(res, 404, this.errorBody(404));
          return true;
        }
        this.#ok(res, { id: sm[1] });
        return true;
      }
    }
    return false;
  }
}
