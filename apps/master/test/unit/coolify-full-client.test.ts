import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultVolumeName } from '../../src/chat/coolify-resource-actions.js';
import { CoolifyClient, coolifyFeatures, ProviderCallError } from '../../src/ops/coolify.js';
import { lastTestOf } from '../../src/ops/coolify-connections.js';
import {
  AbsPath,
  DatabaseCreateInput,
  ServiceCreateInput,
  StorageAddInput,
} from '../../src/ops/coolify-resources-model.js';
import { storageManualStep, volumeNotice } from '../../src/ops/coolify-resources.js';
import { createGuardedFetch } from '../../src/ops/http.js';
import { FakeCoolify } from '../helpers/fake-ops.js';

/**
 * p17-coolify-full: every new Coolify client call against the fake Coolify HTTP server (which refuses undocumented
 * fields like the real API) — the request shape, the parser (secrets dropped), the error mapping (including the
 * catch-all 404 → `unsupported`) and the read:sensitive probe — plus the version features and the pure helpers.
 * No real Coolify is called.
 */
const fake = new FakeCoolify();
let client: CoolifyClient;
const last = (re: RegExp) => fake.requests.filter((r) => re.test(`${r.method} ${r.path}`)).at(-1);
const bodyOf = (re: RegExp) => JSON.parse(last(re)?.body ?? '{}') as Record<string, unknown>;

beforeAll(async () => {
  await fake.start();
  client = new CoolifyClient({
    baseUrl: fake.base,
    token: fake.token,
    fetch: createGuardedFetch({ internalOrigins: [fake.base] }),
  });
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(() => {
  fake.reset();
  fake.abilities = { read: true, deploy: true, write: true };
  fake.storageApi = 'full';
  fake.apps.clear();
  fake.storages.clear();
  fake.databases.clear();
  fake.backups.clear();
  fake.services.clear();
  fake.serviceEnvs.clear();
  fake.lifecycleCalls.length = 0;
  fake.projects = [
    { uuid: 'proj000001', name: 'site', environments: [{ id: 7, uuid: 'envuuid001', name: 'production' }] },
  ];
  fake.addApp({ uuid: 'app0000001', name: 'remyral-site-preview', environment_id: 7 });
});

describe('coolifyFeatures (version → storage API)', () => {
  it.each([
    ['v4.0.0-beta.420', 'none', true],
    ['v4.0.0-beta.469', 'read', true],
    ['4.0.0-beta.470', 'full', true],
    ['v4.0.0', 'full', true],
    ['v4.2.1', 'full', true],
    ['v4.3.0', 'full', false],
    ['v4.4-rc.1', 'full', false],
    ['v4.5.0', 'full', false],
    ['v3.12.36', 'none', false],
  ] as const)('%s → storages %s, volume host path %s', (v, storages, hostPath) => {
    expect(coolifyFeatures(v)).toEqual({ storages, volumeHostPath: hostPath });
  });
  it('an unreadable version is unknown (the call is tried)', () => {
    expect(coolifyFeatures('v4.0.0-beta.fake')).toEqual({ storages: 'unknown', volumeHostPath: null });
    expect(coolifyFeatures(null)).toEqual({ storages: 'unknown', volumeHostPath: null });
    expect(coolifyFeatures('nightly')).toEqual({ storages: 'unknown', volumeHostPath: null });
  });
});

describe('storages', () => {
  it('lists volumes and file mounts; file contents are never kept (size only)', async () => {
    fake.storages.set('app0000001', [
      {
        id: 1,
        uuid: 'st1',
        type: 'persistent',
        name: 'app0000001-data',
        mount_path: '/data',
        host_path: null,
      },
      {
        id: 2,
        uuid: 'st2',
        type: 'file',
        mount_path: '/etc/app.conf',
        fs_path: '/data/coolify/x/app.conf',
        content: 'PASSWORD=canary-file-secret',
      },
      { id: 3, uuid: 'st3', type: 'file', mount_path: '/srv', fs_path: '/mnt/srv', is_directory: true },
    ]);
    const list = await client.storages('application', 'app0000001');
    expect(list).toEqual([
      expect.objectContaining({
        uuid: 'st1',
        type: 'persistent',
        mount: 'volume',
        name: 'app0000001-data',
        mountPath: '/data',
        hostPath: null,
      }),
      expect.objectContaining({
        uuid: 'st2',
        mount: 'file',
        hostPath: '/data/coolify/x/app.conf',
        contentBytes: 27,
      }),
      expect.objectContaining({ uuid: 'st3', mount: 'directory', hostPath: '/mnt/srv' }),
    ]);
    expect(JSON.stringify(list)).not.toContain('canary-file-secret');
    expect(last(/storages/)?.path).toBe('/api/v1/applications/app0000001/storages');
  });

  it('creates a volume with the documented fields; Coolify prefixes the name with the app uuid', async () => {
    const s = await client.createStorage('application', 'app0000001', {
      type: 'persistent',
      name: 'remyral-data',
      mount_path: '/data',
    });
    expect(bodyOf(/POST .*storages/)).toEqual({
      type: 'persistent',
      name: 'remyral-data',
      mount_path: '/data',
    });
    expect(s).toMatchObject({ mount: 'volume', name: 'app0000001-remyral-data', mountPath: '/data' });
  });

  it('a host path on a volume: 422 on 4.3+ (no such field), accepted on the older API', async () => {
    const err = await client
      .createStorage('application', 'app0000001', {
        type: 'persistent',
        name: 'd',
        mount_path: '/data',
        host_path: '/srv/d',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({
      code: 'invalid',
      status: 422,
      details: { host_path: 'This field is not allowed.' },
    });
    fake.storageApi = 'old';
    const ok = await client.createStorage('application', 'app0000001', {
      type: 'persistent',
      name: 'd',
      mount_path: '/data',
      host_path: '/srv/d',
    });
    expect(ok.hostPath).toBe('/srv/d');
  });

  it('a directory mount and a file mount (content needs the deploy ability)', async () => {
    await client.createStorage('application', 'app0000001', {
      type: 'file',
      mount_path: '/srv',
      is_directory: true,
      fs_path: '/mnt/srv',
    });
    expect(bodyOf(/POST .*storages/)).toEqual({
      type: 'file',
      mount_path: '/srv',
      is_directory: true,
      fs_path: '/mnt/srv',
    });
    fake.abilities = { read: true, deploy: false, write: true };
    await expect(
      client.createStorage('application', 'app0000001', {
        type: 'file',
        mount_path: '/a.conf',
        content: 'x=1',
      }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('updates by uuid and deletes by uuid', async () => {
    const s = await client.createStorage('application', 'app0000001', {
      type: 'persistent',
      name: 'd',
      mount_path: '/data',
    });
    await client.updateStorage('application', 'app0000001', {
      uuid: s.uuid,
      type: 'persistent',
      mount_path: '/var/data',
    });
    expect(bodyOf(/PATCH .*storages/)).toEqual({ uuid: s.uuid, type: 'persistent', mount_path: '/var/data' });
    await client.deleteStorage('application', 'app0000001', s.uuid);
    expect(last(/DELETE/)?.path).toBe(`/api/v1/applications/app0000001/storages/${s.uuid}`);
    expect(await client.storages('application', 'app0000001')).toEqual([]);
  });

  it('a Coolify without the storage API answers the catch-all 404 → unsupported (not "not found")', async () => {
    fake.storageApi = 'none';
    await expect(client.storages('application', 'app0000001')).rejects.toMatchObject({
      code: 'unsupported',
      status: 404,
    });
    // A missing resource on a new Coolify stays not_found.
    fake.storageApi = 'full';
    await expect(client.storages('application', 'missing0001')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('service storages carry the sub-resource', async () => {
    fake.services.set('svc0000001', {
      uuid: 'svc0000001',
      name: 'n8n',
      service_type: 'n8n',
      status: 'running',
      environment_id: 7,
      applications: [{ uuid: 'sub0000001', name: 'n8n', status: 'running', fqdn: null }],
      databases: [],
    });
    await expect(
      client.createStorage('service', 'svc0000001', { type: 'persistent', name: 'd', mount_path: '/data' }),
    ).rejects.toMatchObject({
      code: 'invalid',
      details: { resource_uuid: 'The resource_uuid field is required.' },
    });
    const s = await client.createStorage('service', 'svc0000001', {
      type: 'persistent',
      name: 'd',
      mount_path: '/data',
      resource_uuid: 'sub0000001',
    });
    expect(s.resourceUuid).toBe('sub0000001');
  });
});

describe('start / stop / restart, logs, deployments', () => {
  it('builds the documented paths; stop never runs the docker cleanup; a service restart may pull', async () => {
    const start = await client.lifecycle('application', 'app0000001', 'start');
    expect(start.deploymentUuid).toMatch(/^dep/);
    await client.lifecycle('application', 'app0000001', 'stop');
    expect(last(/stop/)?.path).toBe('/api/v1/applications/app0000001/stop?docker_cleanup=false');
    fake.services.set('svc0000001', {
      uuid: 'svc0000001',
      name: 'n8n',
      service_type: 'n8n',
      status: 'exited',
      environment_id: 7,
      applications: [],
      databases: [],
    });
    await client.lifecycle('service', 'svc0000001', 'restart', { latest: true });
    expect(fake.lifecycleCalls).toEqual([
      'applications app0000001 start',
      'applications app0000001 stop?docker_cleanup=false',
      'services svc0000001 restart?latest=true',
    ]);
    fake.abilities = { read: true, deploy: false, write: true };
    await expect(client.lifecycle('application', 'app0000001', 'start')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('reads database / service logs with the sub-service and the line count', async () => {
    fake.databases.set('db00000001', {
      uuid: 'db00000001',
      name: 'pg',
      database_type: 'standalone-postgresql',
      status: 'running',
      environment_id: 7,
    });
    expect(await client.resourceLogs('database', 'db00000001', 50)).toContain('log of db00000001');
    expect(last(/logs/)?.path).toBe('/api/v1/databases/db00000001/logs?lines=50&show_timestamps=true');
    fake.abilities = { read: true, deploy: true, write: true, readSensitive: false };
    await expect(client.resourceLogs('database', 'db00000001', 50)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('lists running deployments and cancels one', async () => {
    fake.running = [
      { deployment_uuid: 'dep9', status: 'in_progress', application_name: 'site', server_name: 'main' },
    ];
    expect(await client.runningDeployments()).toEqual([
      {
        deploymentUuid: 'dep9',
        status: 'in_progress',
        applicationName: 'site',
        serverName: 'main',
        commit: null,
        createdAt: null,
      },
    ]);
    fake.deployments.set('dep9', { status: 'in_progress', app: 'app0000001', logs: '[]', commit: '' });
    await client.cancelDeployment('dep9');
    expect(last(/cancel/)?.path).toBe('/api/v1/deployments/dep9/cancel');
  });
});

describe('databases and backups', () => {
  it('creates with the engine fields; lists without passwords or connection URLs', async () => {
    const uuid = await client.createDatabase('postgresql', {
      server_uuid: 'srv0000001',
      project_uuid: 'proj000001',
      environment_name: 'production',
      name: 'site-db',
      postgres_user: 'site',
      postgres_db: 'site',
      instant_deploy: false,
    });
    expect(fake.createdDatabases.at(-1)?.body).toMatchObject({ postgres_user: 'site', postgres_db: 'site' });
    const list = await client.databases();
    expect(list).toEqual([
      expect.objectContaining({ uuid, name: 'site-db', engine: 'postgresql', type: 'standalone-postgresql' }),
    ]);
    expect(JSON.stringify(list)).not.toContain('generated-canary-password');
    expect(JSON.stringify(await client.database(uuid))).not.toContain('generated-canary-password');
    await expect(
      client.createDatabase('redis', {
        server_uuid: 'srv0000001',
        project_uuid: 'proj000001',
        postgres_user: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid', details: { postgres_user: 'This field is not allowed.' } });
  });

  it('updates, deletes with every flag sent explicitly', async () => {
    const uuid = await client.createDatabase('postgresql', {
      server_uuid: 'srv0000001',
      project_uuid: 'proj000001',
      environment_name: 'production',
    });
    await client.updateDatabase(uuid, { limits_memory: '512m', is_public: false });
    expect(fake.databases.get(uuid)?.limits_memory).toBe('512m');
    await client.deleteResource('database', uuid, {
      deleteConfigurations: true,
      deleteVolumes: false,
      dockerCleanup: true,
      deleteConnectedNetworks: true,
    });
    expect(fake.deletedResources.at(-1)).toEqual({
      kind: 'database',
      uuid,
      query: {
        delete_configurations: 'true',
        delete_volumes: 'false',
        docker_cleanup: 'true',
        delete_connected_networks: 'true',
      },
    });
  });

  it('backups: create, run now, executions (messages dropped), delete', async () => {
    const uuid = await client.createDatabase('postgresql', {
      server_uuid: 'srv0000001',
      project_uuid: 'proj000001',
      environment_name: 'production',
    });
    const b = await client.createDatabaseBackup(uuid, { frequency: 'daily', enabled: true });
    expect(b).toMatch(/^bk-/);
    await client.updateDatabaseBackup(uuid, b, { backup_now: true });
    const ex = await client.backupExecutions(uuid, b);
    expect(ex).toEqual([
      {
        uuid: expect.any(String) as unknown,
        status: 'success',
        filename: 'a.dmp',
        size: 10,
        createdAt: '2026-10-27T10:00:00Z',
      },
    ]);
    expect(JSON.stringify(ex)).not.toContain('pg_dump output secret');
    const list = await client.databaseBackups(uuid);
    expect(list[0]).toMatchObject({ uuid: b, frequency: 'daily', enabled: true });
    await client.deleteDatabaseBackup(uuid, b);
    expect(await client.databaseBackups(uuid)).toEqual([]);
  });
});

describe('services, servers, projects, resources', () => {
  it('creates a one-click service and sets its variables (values only sent)', async () => {
    const out = await client.createService({
      type: 'n8n',
      server_uuid: 'srv0000001',
      project_uuid: 'proj000001',
      environment_name: 'production',
      instant_deploy: false,
    });
    expect(out.uuid).toMatch(/^svc/);
    expect((await client.service(out.uuid)).applications[0]?.name).toBe('n8n');
    await client.createEnvOf('service', out.uuid, { key: 'N8N_HOST', value: 'n8n.example.com' });
    const envs = await client.envsOf('service', out.uuid);
    expect(envs.map((e) => e.key)).toEqual(['N8N_HOST']);
    expect(JSON.stringify(envs)).not.toContain('n8n.example.com');
  });

  it('server details drop the validation logs and SSH user; resources, domains, validate', async () => {
    fake.servers = [{ uuid: 'srv0000001', name: 'main', ip: '203.0.113.10' }];
    const s = await client.server('srv0000001');
    expect(s).toMatchObject({ uuid: 'srv0000001', proxy: 'traefik', port: 22 });
    expect(JSON.stringify(s)).not.toContain('secret log');
    expect(JSON.stringify(s)).not.toContain('root');
    expect((await client.serverResources('srv0000001'))[0]).toMatchObject({
      uuid: 'app0000001',
      type: 'application',
    });
    expect((await client.serverDomains('srv0000001'))[0]?.domains).toContain(
      'https://app0000001.example.test',
    );
    await client.validateServer('srv0000001');
    expect(bodyOf(/validate/)).toEqual({});
    expect(fake.validated).toEqual(['srv0000001']);
  });

  it('projects and environments: create, refuse a duplicate environment, delete', async () => {
    const p = await client.createProject('new-proj');
    const env = await client.createEnvironment(p, 'staging');
    expect(env).toMatch(/^envn/);
    await expect(client.createEnvironment(p, 'staging')).rejects.toMatchObject({ code: 'conflict' });
    await client.deleteEnvironment(p, 'staging');
    await client.deleteProject(p);
    expect(fake.projects.some((x) => x.uuid === p)).toBe(false);
  });

  it('GET /resources maps the kinds (standalone-<engine> → database)', async () => {
    fake.databases.set('db00000001', {
      uuid: 'db00000001',
      name: 'pg',
      database_type: 'standalone-postgresql',
      status: 'running',
      environment_id: 7,
    });
    const r = await client.resources();
    expect(r.map((x) => [x.uuid, x.kind])).toEqual([
      ['app0000001', 'application'],
      ['db00000001', 'database'],
    ]);
  });

  it('envDataPaths keeps only bare paths of data-looking variables (never another value)', async () => {
    fake.envs.set('app0000001', [
      {
        uuid: 'e1',
        key: 'DATABASE_PATH',
        value: '/data/site.db',
        is_preview: false,
        is_buildtime: true,
        is_runtime: true,
        is_literal: false,
        is_multiline: false,
      },
      {
        uuid: 'e2',
        key: 'SQLITE_URL',
        value: 'file:/data/x.sqlite',
        is_preview: false,
        is_buildtime: true,
        is_runtime: true,
        is_literal: false,
        is_multiline: false,
      },
      {
        uuid: 'e3',
        key: 'DATABASE_URL',
        value: 'postgres://u:secretpw@db/x',
        is_preview: false,
        is_buildtime: true,
        is_runtime: true,
        is_literal: false,
        is_multiline: false,
      },
      {
        uuid: 'e4',
        key: 'NODE_ENV',
        value: '/production',
        is_preview: false,
        is_buildtime: true,
        is_runtime: true,
        is_literal: false,
        is_multiline: false,
      },
      {
        uuid: 'e5',
        key: 'UPLOAD_DIR',
        value: '/data/../etc',
        is_preview: false,
        is_buildtime: true,
        is_runtime: true,
        is_literal: false,
        is_multiline: false,
      },
    ]);
    expect(await client.envDataPaths('application', 'app0000001')).toEqual([
      { key: 'DATABASE_PATH', path: '/data/site.db' },
      { key: 'SQLITE_URL', path: '/data/x.sqlite' },
    ]);
  });
});

describe('probe and connection test parsing', () => {
  it('probes read:sensitive on the logs route (404 present, 403 missing)', async () => {
    expect((await client.probe()).readSensitive).toBe(true);
    fake.abilities = { read: true, deploy: true, write: true, readSensitive: false };
    expect(await client.probe()).toEqual({ read: true, deploy: true, write: true, readSensitive: false });
  });
  it('lastTestOf reads the version and abilities of a stored test (null for none / a failed one)', () => {
    expect(lastTestOf(null)).toBeNull();
    expect(lastTestOf({ error: 'x' })).toBeNull();
    expect(
      lastTestOf({ ok: true, version: 'v4.5.0', permissions: { read: true, deploy: false, write: true } }),
    ).toEqual({
      version: 'v4.5.0',
      permissions: { read: true, deploy: false, write: true, readSensitive: null },
    });
  });
});

describe('inputs and texts', () => {
  it('validates storage inputs (absolute paths, no .., volume names)', () => {
    expect(
      StorageAddInput.safeParse({ mount: 'volume', name: 'remyral-data', mountPath: '/data/' }).data,
    ).toMatchObject({
      mountPath: '/data',
      deploy: false,
    });
    expect(StorageAddInput.safeParse({ mount: 'volume', name: 'x y', mountPath: '/data' }).success).toBe(
      false,
    );
    expect(StorageAddInput.safeParse({ mount: 'directory', mountPath: '/data' }).success).toBe(false);
    expect(AbsPath.safeParse('/data/../etc').success).toBe(false);
    expect(AbsPath.safeParse('data').success).toBe(false);
  });
  it('a database takes no unknown engine; a service is a template or a compose file', () => {
    const place = { server: 'srv0000001', coolifyProject: 'proj000001', environment: 'production' };
    expect(DatabaseCreateInput.safeParse({ engine: 'sqlite', ...place }).success).toBe(false);
    expect(ServiceCreateInput.safeParse({ ...place }).success).toBe(false);
    expect(ServiceCreateInput.safeParse({ type: 'n8n', compose: 'x', ...place }).success).toBe(false);
    expect(ServiceCreateInput.safeParse({ type: 'n8n', ...place }).success).toBe(true);
  });
  it('the volume notice says the data is not copied; the manual step names the Coolify screen', () => {
    expect(volumeNotice('/data', false)).toMatch(/next deploy/);
    expect(volumeNotice('/data', false)).toMatch(
      /starts empty.*lost at that redeploy unless it is copied out first/,
    );
    expect(storageManualStep('v4.0.0-beta.420', 'the application “x”')).toContain(
      'Persistent Storage → + Add → Volume Mount',
    );
    expect(defaultVolumeName('remyral-site-preview', '/data')).toBe('remyral-data');
    expect(defaultVolumeName('Shop', '/var/lib/uploads')).toBe('shop-uploads');
  });
});
