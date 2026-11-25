import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatCreationKey, isDestructiveDraft } from '../../src/chat/coolify-actions.js';
import { directDecision } from '../../src/chat/direct.js';
import { CoolifyClient, type CoolifyApplication } from '../../src/ops/coolify.js';
import {
  CoolifyCreateAppInput,
  CoolifyDeleteAppInput,
  CoolifyUpdateAppInput,
} from '../../src/ops/coolify-apps-model.js';
import {
  duplicateMessage,
  matchDuplicates,
  repoKey,
  updateBody,
  updateMeta,
} from '../../src/ops/coolify-apps.js';
import { createGuardedFetch } from '../../src/ops/http.js';
import { FakeCoolify } from '../helpers/fake-ops.js';

/**
 * p15-coolify-dedupe (docs/design/p15-coolify-dedupe.md): the duplicate guard's matching, the settings body, the chat's
 * same-turn creation key, the destructive-card floor, and the client's delete / deployment-list calls against the
 * fake Coolify (which refuses undocumented PATCH fields like the real API). No real Coolify is called.
 */
const app = (a: Partial<CoolifyApplication> & { uuid: string }): CoolifyApplication => ({
  name: a.uuid,
  fqdn: '',
  status: 'exited',
  gitBranch: 'main',
  gitCommitSha: null,
  environmentId: 8,
  gitRepository: null,
  ...a,
});

describe('repoKey', () => {
  it('reads every form Coolify stores as owner/repo', () => {
    expect(repoKey('https://github.com/Acme/Shop')).toBe('acme/shop');
    expect(repoKey('https://github.com/acme/shop.git')).toBe('acme/shop');
    expect(repoKey('git@github.com:acme/shop.git')).toBe('acme/shop');
    expect(repoKey('acme/shop')).toBe('acme/shop');
    expect(repoKey('https://gitlab.example.com/group/sub/shop/')).toBe('sub/shop');
    expect(repoKey('')).toBeNull();
    expect(repoKey(null)).toBeNull();
    expect(repoKey('shop')).toBeNull();
  });
});

describe('matchDuplicates', () => {
  const apps = [
    app({ uuid: 'sahne0001', name: 'probe-main', gitRepository: 'https://github.com/acme/sahne' }),
    app({ uuid: 'sahne0002', name: 'sahne-metin', gitRepository: 'acme/sahne', gitBranch: 'dev' }),
    app({ uuid: 'other0001', name: 'other', gitRepository: 'https://github.com/acme/other' }),
    app({ uuid: 'elsewhere1', name: 'probe', environmentId: 7, gitRepository: 'acme/sahne' }),
    app({
      uuid: 'unknownenv',
      name: 'x',
      environmentId: null,
      gitRepository: 'git@github.com:acme/sahne.git',
    }),
    app({ uuid: 'image00001', name: 'img', gitRepository: null, dockerImage: 'nginx' }),
  ];
  const want = {
    environmentId: 8,
    name: 'sahne-metin-deploy',
    repository: 'https://github.com/acme/sahne',
    branch: 'main',
  };

  it('finds the same repository + branch in the environment (and apps whose environment is unknown)', () => {
    const m = matchDuplicates(apps, want);
    expect(m.map((x) => [x.app.uuid, x.match])).toEqual([
      ['sahne0001', ['repository']],
      ['unknownenv', ['repository']],
    ]);
  });

  it('a different branch or environment is not a duplicate; the same name is', () => {
    expect(matchDuplicates(apps, { ...want, branch: 'feature' }).map((x) => x.app.uuid)).toEqual([]);
    expect(
      matchDuplicates(apps, { ...want, branch: 'dev', name: 'SAHNE-METIN' }).map((x) => [
        x.app.uuid,
        x.match,
      ]),
    ).toEqual([['sahne0002', ['repository', 'name']]]);
    expect(matchDuplicates(apps, { ...want, environmentId: 7 }).map((x) => x.app.uuid)).toEqual([
      'elsewhere1',
      'unknownenv',
    ]);
  });

  it('compares the base directory / Dockerfile location only when given', () => {
    const mono = [
      app({ uuid: 'web0000001', gitRepository: 'acme/sahne', baseDirectory: '/apps/web' }),
      app({ uuid: 'api0000001', gitRepository: 'acme/sahne', baseDirectory: '/apps/api/' }),
    ];
    const w = { ...want, environmentId: 8, name: 'n' };
    expect(matchDuplicates(mono, w)).toHaveLength(2);
    expect(matchDuplicates(mono, { ...w, baseDirectory: 'apps/api' }).map((x) => x.app.uuid)).toEqual([
      'api0000001',
    ]);
    const df = [app({ uuid: 'df00000001', gitRepository: 'acme/sahne', dockerfileLocation: null })];
    expect(matchDuplicates(df, { ...w, dockerfileLocation: '/Dockerfile' })).toHaveLength(1);
    expect(matchDuplicates(df, { ...w, dockerfileLocation: '/docker/Dockerfile.prod' })).toHaveLength(0);
  });

  it('an image application matches the same image', () => {
    const m = matchDuplicates(apps, {
      environmentId: 8,
      name: 'n2',
      repository: null,
      branch: null,
      image: 'NGINX',
    });
    expect(m.map((x) => [x.app.uuid, x.match])).toEqual([['image00001', ['image']]]);
  });

  it('the refusal names the application, its state and link, and the way forward', () => {
    const msg = duplicateMessage('production', [
      {
        uuid: 'sahne0001',
        name: 'sahne-metin-main',
        status: 'exited',
        fqdn: null,
        repository: 'acme/sahne',
        branch: 'main',
        linked: 'production',
        match: ['repository'],
      },
    ]);
    expect(msg).toContain('sahne-metin-main (sahne0001, exited, linked to the production target');
    expect(msg).toContain('Do not create another one');
    expect(msg).toContain('allowDuplicate');
  });
});

describe('inputs', () => {
  it('allowDuplicate defaults to false', () => {
    const v = CoolifyCreateAppInput.parse({
      env: 'preview',
      server: 'srv0000001',
      coolifyProject: 'proj000001',
      environment: 'preview',
      source: { type: 'repository' },
      idempotencyKey: 'key-00000001',
    });
    expect(v.allowDuplicate).toBe(false);
  });

  it('a settings change needs at least one field; undocumented ones are refused', () => {
    expect(CoolifyUpdateAppInput.safeParse({ deploy: true }).success).toBe(false);
    expect(CoolifyUpdateAppInput.safeParse({ custom_docker_run_options: '--privileged' }).success).toBe(
      false,
    );
    expect(CoolifyUpdateAppInput.safeParse({ dockerfileLocation: '../etc' }).success).toBe(false);
    const u = CoolifyUpdateAppInput.parse({
      buildPack: 'dockerfile',
      dockerfileLocation: '/docker/Dockerfile',
      baseDirectory: '/apps/web',
      ports: '8080',
      startCommand: 'node server.js',
      healthCheck: { enabled: true, path: '/health', port: 8080 },
    });
    expect(updateBody(u)).toEqual({
      build_pack: 'dockerfile',
      dockerfile_location: '/docker/Dockerfile',
      base_directory: '/apps/web',
      ports_exposes: '8080',
      start_command: 'node server.js',
      health_check_enabled: true,
      health_check_path: '/health',
      health_check_port: '8080',
    });
    expect(updateMeta(u)).toMatchObject({ startCommand: '(set)', ports: '8080' });
    expect(updateMeta(CoolifyUpdateAppInput.parse({ buildCommand: '' }))).toEqual({
      buildCommand: '(cleared)',
    });
  });

  it('a delete keeps volumes unless asked', () => {
    expect(CoolifyDeleteAppInput.parse({})).toEqual({
      deleteVolumes: false,
      deleteConfigurations: true,
      dockerCleanup: true,
      deleteConnectedNetworks: true,
    });
    expect(CoolifyDeleteAppInput.safeParse({ force: true }).success).toBe(false);
  });
});

describe('chat', () => {
  it('the same request in the same turn gets the same creation key; another turn or request a new one', () => {
    const r = { env: 'production', name: 'sahne-metin', idempotencyKey: 'ignored-1' };
    const a = chatCreationKey({ threadId: 't1', turnId: 'u1' }, r);
    expect(a).toMatch(/^chat-[0-9a-f]{48}$/);
    expect(chatCreationKey({ threadId: 't1', turnId: 'u1' }, { ...r, idempotencyKey: 'other-key' })).toBe(a);
    expect(chatCreationKey({ threadId: 't1', turnId: 'u2' }, r)).not.toBe(a);
    expect(chatCreationKey({ threadId: 't1', turnId: 'u1' }, { ...r, name: 'sahne-metin-deploy' })).not.toBe(
      a,
    );
    expect(CoolifyCreateAppInput.shape.idempotencyKey.safeParse(a).success).toBe(true);
  });

  it('a delete card is destructive; other Coolify cards are not', () => {
    expect(isDestructiveDraft('coolify_change', { op: 'delete_app' })).toBe(true);
    expect(isDestructiveDraft('coolify_change', { op: 'update_app' })).toBe(false);
    expect(isDestructiveDraft('ops_action', { op: 'delete_app' })).toBe(false);
  });

  it('destructive floor: coolify_delete_app never runs by default, only on an explicit execute in a user turn', () => {
    const base = { tool: 'coolify_delete_app' as const, propose: false, byUser: true, proposeAware: true };
    expect(directDecision({ ...base, execute: false }).run).toBeNull();
    expect(directDecision({ ...base, execute: true }).run).toBe('execute');
    expect(directDecision({ ...base, execute: true, byUser: false }).run).toBeNull();
    // Other Coolify changes run by default on the user's request (p15-chat-execute-default).
    expect(directDecision({ ...base, tool: 'coolify_update_app', execute: false }).run).toBe('default');
  });
});

describe('client (fake Coolify)', () => {
  const fake = new FakeCoolify();
  let client: CoolifyClient;
  beforeAll(async () => {
    await fake.start();
    fake.abilities = { read: true, deploy: true, write: true };
    client = new CoolifyClient({
      baseUrl: fake.base,
      token: fake.token,
      fetch: createGuardedFetch({ internalOrigins: [fake.base] }),
    });
  });
  afterAll(async () => {
    await fake.stop();
  });

  it('lists the fields the duplicate guard compares', async () => {
    fake.addApp({
      uuid: 'dupe000001',
      git_repository: 'acme/sahne',
      base_directory: '/apps/web',
      dockerfile_location: '/Dockerfile',
      environment_id: 8,
    });
    const a = (await client.applications()).find((x) => x.uuid === 'dupe000001');
    expect(a).toMatchObject({
      gitRepository: 'acme/sahne',
      baseDirectory: '/apps/web',
      dockerfileLocation: '/Dockerfile',
      environmentId: 8,
    });
  });

  it('PATCH sends documented fields; the fake refuses others like Coolify (422)', async () => {
    await client.updateApplication('dupe000001', { ports_exposes: '8080', start_command: 'npm start' });
    expect(fake.apps.get('dupe000001')).toMatchObject({ ports_exposes: '8080', start_command: 'npm start' });
    await expect(
      client.updateApplication('dupe000001', { custom_docker_run_options: '--privileged' }),
    ).rejects.toMatchObject({ code: 'invalid', status: 422 });
  });

  it('reads the deployments of an application (newest first, either answer shape)', async () => {
    const [d1] = await client.deploy(['dupe000001'], false);
    const [d2] = await client.deploy(['dupe000001'], false);
    const list = await client.applicationDeployments('dupe000001', 5);
    expect(list.map((d) => d.deploymentUuid)).toEqual([d2?.deploymentUuid, d1?.deploymentUuid]);
    expect((await client.applicationDeployments('dupe000001', 1)).length).toBe(1);
  });

  it('DELETE sends all four documented flags explicitly', async () => {
    await client.deleteApplication('dupe000001', {
      deleteConfigurations: true,
      deleteVolumes: false,
      dockerCleanup: true,
      deleteConnectedNetworks: true,
    });
    expect(fake.deleted.at(-1)).toEqual({
      uuid: 'dupe000001',
      query: {
        delete_configurations: 'true',
        delete_volumes: 'false',
        docker_cleanup: 'true',
        delete_connected_networks: 'true',
      },
    });
    expect(fake.apps.has('dupe000001')).toBe(false);
    await expect(
      client.deleteApplication('dupe000001', {
        deleteConfigurations: true,
        deleteVolumes: false,
        dockerCleanup: true,
        deleteConnectedNetworks: true,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
