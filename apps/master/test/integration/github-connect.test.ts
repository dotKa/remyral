import { createHmac, generateKeyPairSync } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { SecretBox } from '../../src/auth/secret-box.js';
import { type GitHubAppAuth, GitHubConnectService, PANEL_KEY_REF } from '../../src/gitflow/index.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeGitHub } from '../helpers/fake-github.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p5-github-connect (ADR-0022) against a real master (Postgres) and a local fake GitHub over HTTP:
 * manifest flow (always-fresh step-up, state token CSRF: single use, user-bound, the master-served form page and its
 * CSP), code conversion, encrypted storage (no plaintext key or secret in DB rows, logs, responses or audit),
 * installation discovery (the setup callback's id is only a hint), the repository picker, the project config
 * written from the picker (keyRef `panel`, precedence over the key file), the branch-protection check, key
 * rotation, a restart (load) with the right and a wrong master key, and disconnect.
 */
const PW = 'quartz-meadow-lantern-7';
const CONSOLE = 'https://console.example.test';
const PROJECT = 'alpha';

const gh = new FakeGitHub();
let h: Harness;
let owner: Client;
let ownerSecret: string;
let admin2: Client;
let admin2Secret: string;
let operator: Client;
const bodies: string[] = [];
let rotatedPem = '';

async function call(c: Client, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
  const res = await c.req(method, url, body);
  bodies.push(res.body);
  return res;
}

async function stepUp(c: Client, secret: string): Promise<void> {
  h.clock.advance(30_000);
  const res = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
  expect(res.statusCode, res.body).toBe(200);
}

async function audits(action: string): Promise<{ outcome: string; metadata: Record<string, unknown> }[]> {
  const { rows } = await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
    'SELECT outcome, metadata FROM audit_events WHERE action = $1 ORDER BY id',
    [action],
  );
  return rows;
}

/** Starts the flow as `c` and returns the state from the form path. */
async function begin(c: Client, secret: string, body: unknown = { target: 'user' }): Promise<string> {
  await stepUp(c, secret);
  const res = await call(c, 'POST', '/integrations/github/manifest', body);
  expect(res.statusCode, res.body).toBe(200);
  const formPath = res.json<{ formPath: string }>().formPath;
  const state = new URL(formPath, CONSOLE).searchParams.get('state');
  if (state === null) throw new Error('no state');
  return state;
}

/** Lines of a PEM body long enough to be unmistakable (the base64 lines between the armour). */
function pemMarkers(pem: string): string[] {
  return pem
    .split('\n')
    .filter((l) => l.length >= 60 && !l.startsWith('-----'))
    .slice(1, 4);
}

describeIntegration('GitHub connect from the panel (integration, p5-github-connect)', () => {
  beforeAll(async () => {
    const base = await gh.start();
    h = new Harness();
    await h.start({ gitflow: { githubApiUrl: base, githubWebUrl: base, consoleOrigin: CONSOLE } });
    await h.createUser('owner1', PW, 'owner');
    ownerSecret = (await enroll(h, 'owner1', PW)).secret;
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    await h.createUser('admin2', PW, 'admin');
    admin2Secret = (await enroll(h, 'admin2', PW)).secret;
    admin2 = await fullLogin(h, 'admin2', PW, admin2Secret);
    const op = await h.createUser('oper1', PW, 'operator');
    await h.grant(op, [PROJECT], 'operator');
    const o = await enroll(h, 'oper1', PW);
    operator = await fullLogin(h, 'oper1', PW, o.secret);
  });
  afterAll(async () => {
    await h.stop();
    await gh.stop();
  });

  it('status before connecting; admin/owner only', async () => {
    const res = await call(owner, 'GET', '/integrations/github');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      available: true,
      consoleOrigin: CONSOLE,
      defaultKeyRef: 'default',
      fileApps: [],
      app: null,
      installations: [],
    });
    expect((await operator.req('GET', '/integrations/github')).statusCode).toBe(403);
    expect((await operator.req('POST', '/integrations/github/manifest', { target: 'user' })).statusCode).toBe(
      403,
    );
  });

  it('start needs an always-fresh step-up and CSRF; the form page posts the manifest to GitHub under its own CSP', async () => {
    h.clock.advance(11 * 60_000);
    const stale = await owner.req('POST', '/integrations/github/manifest', { target: 'user' });
    expect(stale.statusCode).toBe(403);
    expect(stale.body).toContain('step_up_required');
    await stepUp(owner, ownerSecret);
    const noCsrf = owner.clone();
    noCsrf.sendCsrf = false;
    expect((await noCsrf.req('POST', '/integrations/github/manifest', { target: 'user' })).statusCode).toBe(
      403,
    );

    const res = await call(owner, 'POST', '/integrations/github/manifest', { target: 'user' });
    expect(res.statusCode, res.body).toBe(200);
    const { formPath } = res.json<{ formPath: string }>();
    expect(formPath).toMatch(/^\/integrations\/github\/manifest\/form\?state=[A-Za-z0-9_-]{43}$/);
    const page = await owner.req('GET', formPath);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-store');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain(`form-action ${gh.base}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
    const state = new URL(formPath, CONSOLE).searchParams.get('state') ?? '';
    expect(page.body).toContain(`action="${gh.base}/settings/apps/new?state=${state}"`);
    const value = /name="manifest" value="([^"]*)"/.exec(page.body)?.[1] ?? '';
    const manifest = JSON.parse(
      value
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: 'Remyral console.example.test',
      url: CONSOLE,
      public: false,
      redirect_url: `${CONSOLE}/settings/integrations/github/callback`,
      callback_urls: [`${CONSOLE}/settings/integrations/github/callback`],
      setup_url: `${CONSOLE}/settings/integrations/github/installed`,
      // p6-automations (ADR-0024): deliveries for automation triggers.
      default_events: [
        'pull_request',
        'push',
        'issues',
        'issue_comment',
        'pull_request_review',
        'release',
        'workflow_run',
        'check_suite',
      ],
      default_permissions: {
        contents: 'write',
        pull_requests: 'write',
        checks: 'read',
        statuses: 'read',
        metadata: 'read',
        issues: 'read',
        actions: 'read',
      },
      hook_attributes: { url: `${CONSOLE}/v1/hooks/github`, active: true },
    });
    // Another administrator cannot use this state (bound to the user who started).
    const other = await admin2.req('GET', formPath);
    expect(other.statusCode).toBe(400);
    expect(other.body).toContain('invalid_state');

    // An organization target.
    const orgState = await begin(owner, ownerSecret, { target: 'organization', organization: 'acme-labs' });
    const orgPage = await owner.req('GET', `/integrations/github/manifest/form?state=${orgState}`);
    expect(orgPage.body).toContain(
      `action="${gh.base}/organizations/acme-labs/settings/apps/new?state=${orgState}"`,
    );
    const badOrg = await call(owner, 'POST', '/integrations/github/manifest', {
      target: 'organization',
      organization: '-bad/org',
    });
    expect(badOrg.statusCode).toBe(400);
  });

  it('complete: state CSRF (unknown, other user, replay), always-fresh step-up, conversion, encrypted storage', async () => {
    const state = await begin(owner, ownerSecret);
    gh.codes.add('code-ok-1');

    // Unknown state.
    const forged = await call(owner, 'POST', '/integrations/github/manifest/complete', {
      code: 'code-ok-1',
      state: 'A'.repeat(43),
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.body).toContain('invalid_state');
    // Another administrator with the owner's state: refused, and the state stays usable for the owner.
    await stepUp(admin2, admin2Secret);
    const stolen = await call(admin2, 'POST', '/integrations/github/manifest/complete', {
      code: 'code-ok-1',
      state,
    });
    expect(stolen.statusCode).toBe(400);
    // Stale step-up: refused before the state is touched.
    h.clock.advance(11 * 60_000);
    expect(
      (await owner.req('POST', '/integrations/github/manifest/complete', { code: 'code-ok-1', state }))
        .statusCode,
    ).toBe(403);
    await stepUp(owner, ownerSecret);
    const done = await call(owner, 'POST', '/integrations/github/manifest/complete', {
      code: 'code-ok-1',
      state,
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({
      defaultKeyRef: PANEL_KEY_REF,
      app: {
        appId: String(gh.appId),
        slug: gh.slug,
        owner: { login: 'octo-org', type: 'User' },
        installUrl: `${gh.base}/apps/${gh.slug}/installations/new`,
        settingsUrl: `${gh.base}/settings/apps/${gh.slug}`,
        missingPermissions: [],
        keyAgeDays: 0,
        keyUsable: true,
      },
      installations: [],
    });
    expect(done.json<{ app: { keyFingerprint: string } }>().app.keyFingerprint).toMatch(/^SHA256:/);

    // Replay of the same state (and a second connect) is refused.
    gh.codes.add('code-ok-2');
    const replay = await call(owner, 'POST', '/integrations/github/manifest/complete', {
      code: 'code-ok-2',
      state,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toContain('invalid_state');
    // p17-chat-github: another connection may be added, but not a second one for the same account.
    const again = await call(owner, 'POST', '/integrations/github/manifest', {
      target: 'organization',
      organization: 'octo-org',
    });
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain('github_already_connected');

    // At rest: one encrypted blob; no column carries the key or a secret.
    const row = await h.db.pool.query<Record<string, unknown>>('SELECT * FROM github_app_connection');
    const dump = JSON.stringify(row.rows) + (row.rows[0]?.secrets as Buffer).toString('latin1');
    for (const m of [
      ...pemMarkers(gh.pem),
      gh.clientSecret,
      gh.webhookSecret,
      'BEGIN PRIVATE KEY',
      'BEGIN RSA',
    ]) {
      expect(dump).not.toContain(m);
    }
    const complete = await audits('github.connect.complete');
    expect(complete.map((a) => [a.outcome, a.metadata.reason ?? 'ok'])).toEqual([
      ['failure', 'invalid_state'],
      ['failure', 'invalid_state'],
      ['success', 'ok'],
      ['failure', 'invalid_state'],
    ]);
    expect(complete[2]?.metadata).toMatchObject({
      appId: String(gh.appId),
      slug: gh.slug,
      owner: 'octo-org',
    });
  });

  it('installations: discovery via the App JWT; the setup callback id is only a hint', async () => {
    gh.installations.push(
      {
        id: 777,
        account: 'octo-org',
        repos: [
          { owner: 'octo-org', name: 'app' },
          { owner: 'octo-org', name: 'site', defaultBranch: 'trunk' },
        ],
      },
      {
        id: 888,
        account: 'acme-labs',
        accountType: 'Organization',
        selection: 'all',
        repos: [
          { owner: 'acme-labs', name: 'api' },
          { owner: 'acme-labs', name: 'old', archived: true },
          { owner: 'acme-labs', name: 'web', private: false },
        ],
      },
    );
    const forged = await call(owner, 'POST', '/integrations/github/installations/sync', {
      installationId: 999,
    });
    expect(forged.statusCode).toBe(404);
    expect(forged.body).toContain('installation_not_found');
    const res = await call(owner, 'POST', '/integrations/github/installations/sync', { installationId: 777 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ installations: unknown[] }>().installations).toEqual([
      expect.objectContaining({ installationId: 888, account: 'acme-labs', repositorySelection: 'all' }),
      expect.objectContaining({ installationId: 777, account: 'octo-org', repositorySelection: 'selected' }),
    ]);
    expect(gh.requests.some((r) => r.path === '/app/installations' && r.auth === 'jwt')).toBe(true);
    const sync = await audits('github.installations.sync');
    expect(sync.map((a) => a.outcome)).toEqual(['failure', 'success']);
    // p17-chat-github: new installations are pending; nothing uses them before they are accepted.
    expect(
      res.json<{ installations: { accepted: boolean }[] }>().installations.map((i) => i.accepted),
    ).toEqual([false, false]);
    const none = await call(owner, 'GET', '/integrations/github/repositories');
    expect(none.json<{ total: number }>().total).toBe(0);
    await stepUp(owner, ownerSecret);
    for (const id of [777, 888]) {
      const a = await call(owner, 'PUT', `/integrations/github/installations/${String(id)}`, {
        accepted: true,
      });
      expect(a.statusCode, a.body).toBe(200);
    }
    expect((await audits('github.installation.accept')).map((a) => a.metadata.installationId)).toEqual([
      777, 888,
    ]);
    expect((await operator.req('POST', '/integrations/github/installations/sync', {})).statusCode).toBe(403);
  });

  it('repository picker: every installation, searchable and paginated, with a names-only token', async () => {
    const all = await call(owner, 'GET', '/integrations/github/repositories');
    expect(all.statusCode, all.body).toBe(200);
    const body = all.json<{ items: { fullName: string }[]; total: number; errors: string[] }>();
    expect(body.total).toBe(5);
    expect(body.errors).toEqual([]);
    expect(body.items.map((r) => r.fullName)).toEqual([
      'acme-labs/api',
      'acme-labs/old',
      'acme-labs/web',
      'octo-org/app',
      'octo-org/site',
    ]);
    const search = await call(owner, 'GET', '/integrations/github/repositories?q=SIT');
    expect(search.json()).toMatchObject({
      total: 1,
      items: [
        {
          installationId: 777,
          fullName: 'octo-org/site',
          cloneUrl: 'https://github.com/octo-org/site.git',
          defaultBranch: 'trunk',
          private: true,
        },
      ],
    });
    const paged = await call(owner, 'GET', '/integrations/github/repositories?pageSize=2&page=2');
    expect(paged.json<{ items: { fullName: string }[] }>().items.map((r) => r.fullName)).toEqual([
      'acme-labs/web',
      'octo-org/app',
    ]);
    const one = await call(owner, 'GET', '/integrations/github/repositories?installationId=888');
    expect(one.json<{ total: number }>().total).toBe(3);
    // The listing token covers the installation's repositories with metadata:read only.
    expect(gh.tokenRequests).toContainEqual({ permissions: { metadata: 'read' } });
    expect((await operator.req('GET', '/integrations/github/repositories')).statusCode).toBe(403);
  });

  it('the picker writes the project config (keyRef panel, precedence); unknown installations are refused', async () => {
    await stepUp(owner, ownerSecret);
    const bad = await call(owner, 'PUT', `/projects/${PROJECT}/git`, {
      expectedVersion: 0,
      provider: 'github',
      repositoryUrl: 'https://github.com/octo-org/site.git',
      baseBranch: 'trunk',
      github: { installationId: 999, keyRef: PANEL_KEY_REF, appId: String(gh.appId) },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('github.installationId:not_an_installation_of_this_app');
    // What the web picker sends.
    const ok = await call(owner, 'PUT', `/projects/${PROJECT}/git`, {
      expectedVersion: 0,
      provider: 'github',
      repositoryUrl: 'https://github.com/octo-org/site.git',
      baseBranch: 'trunk',
      mergeMethod: 'squash',
      requireCi: true,
      github: { installationId: 777, keyRef: PANEL_KEY_REF, appId: String(gh.appId) },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      config: {
        repositoryUrl: 'https://github.com/octo-org/site.git',
        baseBranch: 'trunk',
        mergeMethod: 'squash',
        requireCi: true,
        github: { appId: String(gh.appId), installationId: 777, keyRef: PANEL_KEY_REF },
      },
    });
    // Without a keyRef the panel App wins (it takes precedence over the key file).
    const implicit = await call(owner, 'PUT', `/projects/${PROJECT}/git`, {
      expectedVersion: 1,
      provider: 'github',
      repositoryUrl: 'https://github.com/octo-org/site.git',
      baseBranch: 'trunk',
      github: { installationId: 777 },
    });
    expect(implicit.statusCode, implicit.body).toBe(200);
    expect(implicit.json<{ config: { github: { keyRef: string } } }>().config.github.keyRef).toBe(
      PANEL_KEY_REF,
    );
    const status = await call(owner, 'GET', '/integrations/github');
    expect(status.json<{ projects: unknown[] }>().projects).toEqual([
      {
        project: PROJECT,
        repositoryUrl: 'https://github.com/octo-org/site.git',
        baseBranch: 'trunk',
        installationId: 777,
      },
    ]);
  });

  it('branch protection check per project repository', async () => {
    const before = await call(operator, 'GET', `/projects/${PROJECT}/git/protection`);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({
      provider: 'github',
      branch: 'trunk',
      state: 'unprotected',
      classic: false,
    });
    gh.protection.set('octo-org/site/trunk', { classic: false, rules: ['pull_request', 'non_fast_forward'] });
    const ruleset = await call(operator, 'GET', `/projects/${PROJECT}/git/protection`);
    expect(ruleset.json()).toMatchObject({ state: 'protected', rules: ['pull_request', 'non_fast_forward'] });
    gh.protection.set('octo-org/site/trunk', { classic: true, rules: [] });
    expect((await call(owner, 'GET', `/projects/${PROJECT}/git/protection`)).json()).toMatchObject({
      state: 'protected',
      classic: true,
    });
    const none = await call(owner, 'GET', '/projects/no-such-project/git/protection');
    expect(none.json()).toMatchObject({ state: 'not_applicable' });
  });

  it('p6-automations: "Set up webhook" points the App hook at /v1/hooks/github with a new secret (always-fresh)', async () => {
    const delivery = (secret: string) => {
      const body = JSON.stringify({ zen: 'Keep it logically awesome.' });
      return h.app.inject({
        method: 'POST',
        url: '/v1/hooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
          'x-github-delivery': '00000000-0000-4000-8000-00000000beef',
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        },
        payload: body,
      });
    };
    // The secret from the manifest conversion verifies deliveries until it is replaced.
    expect((await delivery(gh.webhookSecret)).statusCode).toBe(200);
    expect((await operator.req('POST', '/integrations/github/webhook')).statusCode).toBe(403);
    h.clock.advance(11 * 60_000);
    expect((await owner.req('POST', '/integrations/github/webhook')).statusCode).toBe(403);
    await stepUp(owner, ownerSecret);
    const res = await call(owner, 'POST', '/integrations/github/webhook');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      url: `${CONSOLE}/v1/hooks/github`,
      events: [
        'pull_request',
        'push',
        'issues',
        'issue_comment',
        'pull_request_review',
        'release',
        'workflow_run',
        'check_suite',
      ],
    });
    expect(gh.hookConfig).toMatchObject({
      url: `${CONSOLE}/v1/hooks/github`,
      content_type: 'json',
      insecure_ssl: '0',
    });
    const secret = typeof gh.hookConfig?.secret === 'string' ? gh.hookConfig.secret : '';
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(res.body).not.toContain(secret);
    expect((await delivery(secret)).statusCode).toBe(200);
    expect((await delivery(gh.webhookSecret)).statusCode).toBe(401);
    const rows = await audits('github.webhook.configure');
    expect(rows.map((r) => r.outcome)).toEqual(['success']);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it('rotate key: always-fresh, must be a key of this App; the old key stops being used', async () => {
    const statusBefore = (await call(owner, 'GET', '/integrations/github')).json<{
      app: { keyFingerprint: string };
    }>();
    h.clock.advance(11 * 60_000);
    rotatedPem = gh.newKey();
    expect((await owner.req('POST', '/integrations/github/key', { pem: rotatedPem })).statusCode).toBe(403);
    await stepUp(owner, ownerSecret);
    const notPem = await call(owner, 'POST', '/integrations/github/key', { pem: 'x'.repeat(200) });
    expect(notPem.statusCode).toBe(400);
    expect(notPem.body).toContain('invalid_key');
    const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const foreign = await call(owner, 'POST', '/integrations/github/key', { pem: stranger });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.body).toContain('invalid_key');

    // Two days later (sessions expired meanwhile: sign in again).
    h.clock.advance(2 * 86_400_000);
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    expect(
      (await call(owner, 'GET', '/integrations/github')).json<{ app: { keyAgeDays: number } }>().app
        .keyAgeDays,
    ).toBe(2);
    const ok = await call(owner, 'POST', '/integrations/github/key', { pem: rotatedPem });
    expect(ok.statusCode, ok.body).toBe(200);
    const after = ok.json<{ app: { keyFingerprint: string; keyAgeDays: number } }>();
    expect(after.app.keyFingerprint).not.toBe(statusBefore.app.keyFingerprint);
    expect(after.app.keyAgeDays).toBe(0);
    // The owner deletes the old key on GitHub: everything keeps working with the new one (the provider cache
    // follows the key).
    gh.revokeOriginalKey();
    expect((await call(owner, 'GET', `/projects/${PROJECT}/git/protection`)).json()).toMatchObject({
      state: 'protected',
    });
    expect((await audits('github.key.rotate')).map((a) => [a.outcome, a.metadata.reason ?? 'ok'])).toEqual([
      ['failure', 'not_a_key'],
      ['failure', 'not_this_app'],
      ['success', 'ok'],
    ]);
  });

  it('restart: the stored App loads with the master key; a different master key cannot decrypt it', async () => {
    const audit = new AuditLog(h.db.pool, h.clock.now);
    const opts = {
      pool: h.db.pool,
      audit,
      clock: h.clock.now,
      log: h.app.log,
      apiBaseUrl: gh.base,
      webBaseUrl: gh.base,
      consoleOrigin: CONSOLE,
    };
    const apps = new Map<string, GitHubAppAuth>();
    await new GitHubConnectService({ ...opts, box: h.box, apps }).load();
    expect(apps.get(PANEL_KEY_REF)?.appId).toBe(String(gh.appId));
    const wrongApps = new Map<string, GitHubAppAuth>();
    const wrong = new GitHubConnectService({ ...opts, box: new SecretBox(randomBytes(32)), apps: wrongApps });
    await wrong.load();
    expect(wrongApps.has(PANEL_KEY_REF)).toBe(false);
    expect((await wrong.status()).app).toMatchObject({ keyUsable: false });
  });

  it('disconnect: always-fresh, forgets key and installations, lists affected projects', async () => {
    h.clock.advance(11 * 60_000);
    expect((await owner.req('DELETE', '/integrations/github')).statusCode).toBe(403);
    await stepUp(owner, ownerSecret);
    const res = await call(owner, 'DELETE', '/integrations/github');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      affectedProjects: [PROJECT],
      settingsUrl: `${gh.base}/settings/apps/${gh.slug}`,
    });
    const status = (await call(owner, 'GET', '/integrations/github')).json<Record<string, unknown>>();
    expect(status).toMatchObject({ app: null, installations: [], defaultKeyRef: 'default' });
    expect((await h.db.pool.query('SELECT 1 FROM github_app_installations')).rowCount).toBe(0);
    expect((await h.db.pool.query('SELECT 1 FROM github_app_connection')).rowCount).toBe(0);
    const prot = await call(owner, 'GET', `/projects/${PROJECT}/git/protection`);
    expect(prot.json()).toMatchObject({ state: 'unknown' });
    expect((await audits('github.disconnect'))[0]?.metadata).toMatchObject({ affectedProjects: [PROJECT] });
    expect((await call(owner, 'GET', '/integrations/github/repositories')).statusCode).toBe(409);
  });

  it('no key, client secret, webhook secret or manifest code in logs, responses or audit', async () => {
    const { rows } = await h.db.pool.query<{ metadata: unknown; action: string; target: string | null }>(
      'SELECT action, target, metadata FROM audit_events',
    );
    const haystacks = {
      logs: h.logs.text,
      responses: bodies.join('\n'),
      audit: JSON.stringify(rows),
    };
    const needles = [
      ...pemMarkers(gh.pem),
      ...pemMarkers(rotatedPem),
      gh.clientSecret,
      gh.webhookSecret,
      'code-ok-1',
      'PRIVATE KEY-----',
    ];
    for (const [where, text] of Object.entries(haystacks)) {
      for (const n of needles) expect(text.includes(n), `${n.slice(0, 12)}… in ${where}`).toBe(false);
    }
  });
});
