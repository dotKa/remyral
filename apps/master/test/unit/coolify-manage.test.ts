import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chatSecretRefusal } from '../../src/chat/coolify-actions.js';
import { CoolifyClient, ProviderCallError } from '../../src/ops/coolify.js';
import { CoolifyCreateAppInput, CoolifyEnvChange, DomainUrl } from '../../src/ops/coolify-apps-model.js';
import { coolifyRepository, createBody, envMeta, envWrite } from '../../src/ops/coolify-apps.js';
import { githubOwnerRepo, suggestBuild } from '../../src/ops/coolify-detect.js';
import { createGuardedFetch } from '../../src/ops/http.js';
import { FakeCoolify } from '../helpers/fake-ops.js';

/**
 * p15-coolify-create (ADR-0057): the Coolify client's create / update / variables / listing calls against the fake
 * Coolify HTTP server (which refuses undocumented fields like the real API), their error mapping, and the pure parts
 * (create bodies, variable bodies, repository URLs, build suggestion, domain URLs, the chat's secret refusal).
 * No real Coolify is called.
 */
const fake = new FakeCoolify();
let client: CoolifyClient;

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
  fake.projects = [
    {
      uuid: 'proj000001',
      name: 'shop',
      environments: [
        { id: 7, uuid: 'envuuid001', name: 'production' },
        { id: 8, uuid: 'envuuid002', name: 'preview' },
      ],
    },
  ];
  fake.githubApps = [{ uuid: 'gha0000001', name: 'acme-app' }];
  fake.keys = [
    {
      uuid: 'key0000001',
      name: 'deploy',
      fingerprint: 'SHA256:abc',
      private_key:
        '-----BEGIN OPENSSH PRIVATE KEY-----\ncanary-private-key\n-----END OPENSSH PRIVATE KEY-----',
    },
  ];
  fake.destinations = null;
});

describe('Coolify client: what creation needs', () => {
  it('lists servers, projects, environments, GitHub apps and keys (never the key material)', async () => {
    expect(await client.servers()).toEqual([
      {
        uuid: 'srv0000001',
        name: 'main',
        description: null,
        ip: '203.0.113.10',
        reachable: true,
        usable: true,
      },
    ]);
    expect(await client.projects()).toEqual([{ uuid: 'proj000001', name: 'shop', description: null }]);
    expect(await client.environments('proj000001')).toEqual([
      { id: 7, uuid: 'envuuid001', name: 'production' },
      { id: 8, uuid: 'envuuid002', name: 'preview' },
    ]);
    expect(await client.githubApps()).toEqual([
      { uuid: 'gha0000001', name: 'acme-app', organization: null, isPublic: false },
    ]);
    const keys = await client.privateKeys();
    expect(keys).toEqual([
      { uuid: 'key0000001', name: 'deploy', fingerprint: 'SHA256:abc', gitRelated: false },
    ]);
    expect(JSON.stringify(keys)).not.toContain('canary-private-key');
    expect(fake.calls()).toEqual([
      'GET /api/v1/servers',
      'GET /api/v1/projects',
      'GET /api/v1/projects/proj000001/environments',
      'GET /api/v1/github-apps',
      'GET /api/v1/security/keys',
    ]);
  });

  it('destinations: 404 on older versions maps to not_found; a missing project to not_found', async () => {
    await expect(client.destinations('srv0000001')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    fake.destinations = [{ uuid: 'dst0000001', name: 'coolify', network: 'coolify' }];
    expect(await client.destinations('srv0000001')).toEqual([
      { uuid: 'dst0000001', name: 'coolify', network: 'coolify' },
    ]);
    await expect(client.environments('nosuchproj')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('Coolify client: create and update', () => {
  const base = {
    project_uuid: 'proj000001',
    server_uuid: 'srv0000001',
    environment_name: 'production',
    name: 'shop-production',
    ports_exposes: '3000',
    instant_deploy: false,
  };

  it('creates from each documented endpoint and returns the uuid', async () => {
    const pub = await client.createApplication(
      'public',
      createBody('public', {
        ...base,
        git_repository: 'https://github.com/acme/shop',
        git_branch: 'main',
        build_pack: 'nixpacks',
      }),
    );
    expect(pub).toMatch(/^new\d{6}$/);
    await client.createApplication(
      'private-github-app',
      createBody('private-github-app', {
        ...base,
        name: 'gh',
        git_repository: 'https://github.com/acme/shop',
        git_branch: 'main',
        build_pack: 'dockerfile',
        github_app_uuid: 'gha0000001',
        dockerfile_location: '/Dockerfile',
      }),
    );
    await client.createApplication(
      'private-deploy-key',
      createBody('private-deploy-key', {
        ...base,
        name: 'dk',
        git_repository: 'git@github.com:acme/shop.git',
        git_branch: 'main',
        build_pack: 'dockercompose',
        private_key_uuid: 'key0000001',
        docker_compose_location: '/compose.yaml',
      }),
    );
    await client.createApplication(
      'dockerfile',
      createBody('dockerfile', {
        ...base,
        name: 'df',
        dockerfile: 'FROM nginx:alpine',
        build_pack: 'dockerfile',
      }),
    );
    await client.createApplication(
      'dockerimage',
      createBody('dockerimage', {
        ...base,
        name: 'img',
        docker_registry_image_name: 'ghcr.io/acme/shop',
        docker_registry_image_tag: '1.2.3',
      }),
    );
    expect(fake.created.map((c) => c.kind)).toEqual([
      'public',
      'private-github-app',
      'private-deploy-key',
      'dockerfile',
      'dockerimage',
    ]);
    expect(fake.calls(/POST/).every((c) => c.startsWith('POST /api/v1/applications/'))).toBe(true);
  });

  it('createBody refuses a field the endpoint does not document', () => {
    expect(() => createBody('dockerimage', { ...base, git_repository: 'x' })).toThrow(/not documented/);
    expect(createBody('public', { ...base, description: undefined })).not.toHaveProperty('description');
  });

  it('maps 422 (with field details), 409 domain conflicts, 401, 403, 429, 5xx', async () => {
    const err422 = await client
      .createApplication('public', { ...base, git_repository: 'https://github.com/acme/shop', force: true })
      .catch((e: unknown) => e);
    expect(err422).toBeInstanceOf(ProviderCallError);
    expect(err422).toMatchObject({ code: 'invalid', status: 422 });
    expect((err422 as ProviderCallError).details).toMatchObject({
      force: 'This field is not allowed.',
      git_branch: 'The git_branch field is required.',
    });
    expect((err422 as Error).message).toContain('force: This field is not allowed.');

    fake.addApp({ uuid: 'taken00001', name: 'other-site', fqdn: 'https://taken.example.com' });
    const err409 = await client
      .createApplication(
        'public',
        createBody('public', {
          ...base,
          git_repository: 'https://github.com/acme/shop',
          git_branch: 'main',
          build_pack: 'nixpacks',
          domains: 'https://taken.example.com',
        }),
      )
      .catch((e: unknown) => e);
    expect(err409).toMatchObject({ code: 'conflict', status: 409 });
    expect((err409 as ProviderCallError).details).toEqual({ 'taken.example.com': 'other-site' });

    fake.abilities.write = false;
    await expect(
      client.updateApplication('taken00001', { domains: 'https://x.example.com' }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    fake.abilities.write = true;

    fake.failNext = { status: 429, retryAfter: 17 };
    await expect(client.servers()).rejects.toMatchObject({ code: 'rate_limited', retryAfterSec: 17 });
    fake.failNext = { status: 503 };
    await expect(client.projects()).rejects.toMatchObject({ code: 'unavailable', status: 503 });
    const wrong = new CoolifyClient({
      baseUrl: fake.base,
      token: 'wrong-token-0123456789abcdef',
      fetch: createGuardedFetch({ internalOrigins: [fake.base] }),
    });
    await expect(wrong.servers()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    // The Remyral sign-in gate in front of the public Coolify host answers API calls itself: say so, not "wrong token".
    fake.failNext = {
      status: 401,
      body: { error: 'unauthorized', message: 'Sign in through the console.' },
    };
    await expect(client.servers()).rejects.toThrow(/Remyral sign-in gate.*internal address/);
  });

  it('updates domains (PATCH /applications/{uuid}) and reads the editors’ details', async () => {
    fake.addApp({ uuid: 'app0000001', name: 'shop', fqdn: '', environment_id: 7, build_pack: 'nixpacks' });
    await client.updateApplication('app0000001', {
      domains: 'https://shop.example.com,https://www.example.com',
    });
    const d = await client.applicationDetails('app0000001');
    expect(d.fqdn).toBe('https://shop.example.com,https://www.example.com');
    expect(d.environmentId).toBe(7);
    expect(d.buildPack).toBe('nixpacks');
    expect(fake.requests.find((r) => r.method === 'PATCH')?.body).toBe(
      JSON.stringify({ domains: 'https://shop.example.com,https://www.example.com' }),
    );
  });
});

describe('Coolify client: environment variables', () => {
  it('create / list (values dropped) / update / bulk / delete', async () => {
    fake.addApp({ uuid: 'app0000002', name: 'api' });
    fake.envs.set('app0000002', []);
    const id = await client.createEnv('app0000002', {
      key: 'DATABASE_URL',
      value: 'postgres://u:canary-pw@db/x',
    });
    expect(id).toMatch(/^env/);
    await client.createEnv('app0000002', {
      key: 'API_BASE',
      value: '{{project.API_BASE}}',
      is_preview: true,
    });
    await client.createEnv('app0000002', {
      key: 'NODE_ENV',
      value: 'production',
      is_buildtime: false,
      is_runtime: true,
    });
    const list = await client.envs('app0000002');
    expect(JSON.stringify(list)).not.toContain('canary-pw');
    expect(JSON.stringify(list)).not.toContain('production');
    expect(list.map((e) => [e.key, e.isPreview, e.sharedRef, e.isBuildtime, e.isRuntime])).toEqual([
      ['DATABASE_URL', false, null, true, true],
      ['API_BASE', true, 'project.API_BASE', true, true],
      ['NODE_ENV', false, null, false, true],
    ]);
    await client.updateEnv('app0000002', { key: 'NODE_ENV', value: 'staging' });
    await client.bulkEnvs('app0000002', [
      { key: 'NODE_ENV', value: 'production' },
      { key: 'DATABASE_URL', value: 'postgres://u:canary-pw2@db/x' },
    ]);
    expect(fake.envs.get('app0000002')?.find((e) => e.key === 'NODE_ENV')?.value).toBe('production');
    const target = fake.envs.get('app0000002')?.find((e) => e.key === 'API_BASE');
    await client.deleteEnv('app0000002', target?.uuid ?? '');
    expect((await client.envs('app0000002')).map((e) => e.key)).toEqual(['DATABASE_URL', 'NODE_ENV']);
    expect(fake.calls(/envs/)).toEqual([
      'POST /api/v1/applications/app0000002/envs',
      'POST /api/v1/applications/app0000002/envs',
      'POST /api/v1/applications/app0000002/envs',
      'GET /api/v1/applications/app0000002/envs',
      'PATCH /api/v1/applications/app0000002/envs',
      'PATCH /api/v1/applications/app0000002/envs/bulk',
      `DELETE /api/v1/applications/app0000002/envs/${target?.uuid ?? ''}`,
      'GET /api/v1/applications/app0000002/envs',
    ]);
  });

  it('a missing variable on PATCH and an unknown field map to not_found / invalid', async () => {
    fake.addApp({ uuid: 'app0000003', name: 'web' });
    fake.envs.set('app0000003', []);
    await expect(client.updateEnv('app0000003', { key: 'NOPE', value: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      client.createEnv('app0000003', { key: 'A', value: 'x', is_build_time: true } as never),
    ).rejects.toMatchObject({ code: 'invalid', details: { is_build_time: 'This field is not allowed.' } });
  });
});

describe('pure parts', () => {
  it('envWrite sends flags only when they differ from Coolify’s defaults; envMeta never carries a value', () => {
    expect(envWrite({ key: 'A', value: 'v' })).toEqual({ key: 'A', value: 'v' });
    expect(envWrite({ key: 'A', shared: 'project.DB', preview: true, scope: 'runtime' })).toEqual({
      key: 'A',
      value: '{{project.DB}}',
      is_preview: true,
      is_buildtime: false,
      is_runtime: true,
    });
    expect(envWrite({ key: 'A', value: 'v', scope: 'buildtime', literal: true })).toEqual({
      key: 'A',
      value: 'v',
      is_literal: true,
      is_buildtime: true,
      is_runtime: false,
    });
    expect(JSON.stringify(envMeta({ key: 'SECRET', value: 'canary-value' }))).not.toContain('canary-value');
    expect(envMeta({ key: 'X', remove: true })).toEqual({ key: 'X', remove: true });
  });

  it('variable changes: exactly one of value / shared, or remove', () => {
    expect(CoolifyEnvChange.safeParse({ key: 'A', value: 'v' }).success).toBe(true);
    expect(CoolifyEnvChange.safeParse({ key: 'A', shared: 'team.X' }).success).toBe(true);
    expect(CoolifyEnvChange.safeParse({ key: 'A', remove: true }).success).toBe(true);
    expect(CoolifyEnvChange.safeParse({ key: 'A' }).success).toBe(false);
    expect(CoolifyEnvChange.safeParse({ key: 'A', value: 'v', shared: 'team.X' }).success).toBe(false);
    expect(CoolifyEnvChange.safeParse({ key: '1A', value: 'v' }).success).toBe(false);
    expect(CoolifyEnvChange.safeParse({ key: 'A', shared: 'vault.X' }).success).toBe(false);
  });

  it('repository URLs for Coolify', () => {
    expect(coolifyRepository('https://github.com/acme/shop.git', 'public')).toBe(
      'https://github.com/acme/shop',
    );
    expect(coolifyRepository('https://github.com/acme/shop', 'github_app')).toBe(
      'https://github.com/acme/shop',
    );
    expect(coolifyRepository('https://github.com/acme/shop', 'deploy_key')).toBe(
      'git@github.com:acme/shop.git',
    );
    expect(coolifyRepository('git@github.com:acme/shop.git', 'public')).toBe('https://github.com/acme/shop');
    expect(coolifyRepository('https://user:pw@github.com/acme/shop', 'public')).toBeNull();
    expect(coolifyRepository('http://github.com/acme/shop', 'public')).toBeNull();
    expect(githubOwnerRepo('https://github.com/acme/shop.git')).toEqual({ owner: 'acme', repo: 'shop' });
    expect(githubOwnerRepo('https://gitlab.com/acme/shop')).toBeNull();
  });

  it('build suggestion from the repository root', () => {
    expect(suggestBuild(['Dockerfile', 'package.json'], {})).toMatchObject({
      buildPack: 'dockerfile',
      dockerfileLocation: '/Dockerfile',
    });
    expect(suggestBuild(['compose.yaml'], null)).toMatchObject({ buildPack: 'dockercompose', ports: null });
    expect(
      suggestBuild(['package.json'], { scripts: { build: 'vite build' }, devDependencies: { vite: '7' } }),
    ).toMatchObject({ buildPack: 'nixpacks', isStatic: true, publishDirectory: '/dist', ports: '80' });
    expect(
      suggestBuild(['package.json'], {
        scripts: { build: 'next build', start: 'next start' },
        dependencies: { next: '15' },
      }),
    ).toMatchObject({ buildPack: 'nixpacks', isStatic: false, ports: '3000' });
    expect(suggestBuild(['index.html', 'style.css'], null)).toMatchObject({
      buildPack: 'static',
      ports: '80',
    });
    expect(suggestBuild([], null)).toMatchObject({ buildPack: 'nixpacks', source: 'none' });
  });

  it('domain URLs: normalised, no IPs, credentials, queries or wildcards', () => {
    expect(DomainUrl.parse('app.example.com')).toBe('https://app.example.com');
    expect(DomainUrl.parse('https://App.Example.com/')).toBe('https://app.example.com');
    expect(DomainUrl.parse('http://app.example.com:8080/api/')).toBe('http://app.example.com:8080/api');
    for (const bad of [
      'https://203.0.113.5',
      'https://u:p@app.example.com',
      'https://app.example.com/?x=1',
      '*.example.com',
      'ftp://app.example.com',
      'localhost',
    ]) {
      expect(DomainUrl.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('create input: defaults and strictness', () => {
    const ok = CoolifyCreateAppInput.parse({
      env: 'preview',
      server: 'srv0000001',
      coolifyProject: 'proj000001',
      environment: 'preview',
      source: { type: 'repository' },
      idempotencyKey: 'web-12345678',
    });
    expect(ok).toMatchObject({
      link: 'add',
      deploy: false,
      domains: [],
      envs: [],
      source: { access: 'public' },
    });
    expect(
      CoolifyCreateAppInput.safeParse({ ...ok, custom_docker_run_options: '--privileged' }).success,
    ).toBe(false);
    expect(CoolifyCreateAppInput.safeParse({ ...ok, baseDirectory: '/../etc' }).success).toBe(false);
  });

  it('the chat refuses secret-looking values', () => {
    expect(chatSecretRefusal('NODE_ENV', 'production')).toBeNull();
    expect(chatSecretRefusal('PORT', '3000')).toBeNull();
    expect(chatSecretRefusal('STRIPE_SECRET', 'x')).not.toBeNull();
    expect(chatSecretRefusal('DATABASE_URL', 'postgres://u:p@h/db')).not.toBeNull();
    expect(chatSecretRefusal('GREETING', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789')).not.toBeNull();
    expect(chatSecretRefusal('API_KEY', undefined)).toBeNull();
  });
});
