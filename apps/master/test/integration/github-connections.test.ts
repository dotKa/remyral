import { afterAll, beforeAll, expect, it } from 'vitest';
import { signGitHubWebhook } from '../../src/automations/webhook-signature.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeGitHub } from '../helpers/fake-github.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p17-chat-github Part 3 (docs/design/p17-chat-github.md §3, ADR-0022 amendment 2026-10-27) against a real master
 * (Postgres) and the local fake GitHub with two Apps — the owner's account App (4242) and a private organization App
 * (5151, acme-labs):
 *
 * - a second connection through the manifest flow (organization, label), a second one for the same account refused;
 * - the installation allowlist: new installations are pending; nothing lists or uses them until accepted
 *   (always-fresh step-up, audited); taking an acceptance back stops tokens for it;
 * - repositories across the accepted installations of both Apps, each naming its connection; a project stores the
 *   connection (keyRef) and installation, an installation of another App is refused;
 * - webhook deliveries verified with the secret of the App they name; an unknown App is refused;
 * - rename and disconnect of one connection (the other stays).
 */
const PW = 'quartz-meadow-lantern-7';
const CONSOLE = 'https://console.example.test';
const PROJECT = 'omega';
const ORG_APP = 5151;

interface Connection {
  id: number | null;
  keyRef: string;
  label: string | null;
  source: string;
  appId: string;
  installations: { installationId: number; accepted: boolean; keyRef: string }[];
  projects: { project: string }[];
}

describeIntegration('several GitHub App connections (integration, p17-chat-github)', () => {
  const gh = new FakeGitHub();
  let h: Harness;
  let owner: Client;
  let ownerSecret = '';
  let orgApp: { pem: string; webhookSecret: string };
  let orgRef = '';
  let orgId = 0;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    const res = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function connect(body: Record<string, unknown>, code: string) {
    await stepUp();
    const start = await owner.req('POST', '/integrations/github/manifest', body);
    expect(start.statusCode, start.body).toBe(200);
    const state =
      new URL(start.json<{ formPath: string }>().formPath, CONSOLE).searchParams.get('state') ?? '';
    gh.codes.add(code);
    return owner.req('POST', '/integrations/github/manifest/complete', { code, state });
  }

  async function connections(): Promise<Connection[]> {
    const res = await owner.req('GET', '/integrations/github');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ connections: Connection[] }>().connections;
  }

  async function audits(action: string): Promise<Record<string, unknown>[]> {
    const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM audit_events WHERE action = $1 ORDER BY id',
      [action],
    );
    return rows.map((r) => r.metadata);
  }

  function hook(secret: string, headers: Record<string, string>, payload: unknown = { zen: 'x' }) {
    const body = JSON.stringify(payload);
    return h.app.inject({
      method: 'POST',
      url: '/v1/hooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': `d-${String(Math.random()).slice(2, 10)}`,
        'x-hub-signature-256': signGitHubWebhook(secret, body),
        ...headers,
      },
      payload: body,
    });
  }

  beforeAll(async () => {
    const base = await gh.start();
    h = new Harness();
    await h.start({ gitflow: { githubApiUrl: base, githubWebUrl: base, consoleOrigin: CONSOLE } });
    await h.createUser('owner.gh', PW, 'owner');
    ownerSecret = (await enroll(h, 'owner.gh', PW)).secret;
    owner = await fullLogin(h, 'owner.gh', PW, ownerSecret);
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [PROJECT]);
    gh.installations.push({ id: 701, account: 'octo-org', repos: [{ owner: 'octo-org', name: 'app' }] });
    orgApp = gh.addApp(ORG_APP, 'remyral-acme-labs', { login: 'acme-labs', type: 'Organization' }, 'orgx-');
    gh.installations.push({
      id: 801,
      appId: ORG_APP,
      account: 'acme-labs',
      accountType: 'Organization',
      selection: 'all',
      repos: [{ owner: 'acme-labs', name: 'api' }],
    });
  });
  afterAll(async () => {
    await h.stop();
    await gh.stop();
  });

  it('adds a second connection for an organization; a second one for the same account is refused', async () => {
    const first = await connect({ target: 'user' }, 'main-1');
    expect(first.statusCode, first.body).toBe(200);
    const second = await connect(
      { target: 'organization', organization: 'acme-labs', label: 'Acme' },
      'orgx-1',
    );
    expect(second.statusCode, second.body).toBe(200);
    const list = await connections();
    expect(list.map((c) => [c.source, c.appId, c.label])).toEqual([
      ['panel', String(gh.appId), null],
      ['panel', String(ORG_APP), 'Acme'],
    ]);
    expect(list[0]?.keyRef).toBe('panel');
    orgRef = list[1]?.keyRef ?? '';
    orgId = list[1]?.id ?? 0;
    expect(orgRef).toBe(`panel-${String(orgId)}`);
    // The organization App's installations were discovered with its own JWT — pending, like the first App's.
    expect(list[1]?.installations).toEqual([
      expect.objectContaining({ installationId: 801, accepted: false, keyRef: orgRef }),
    ]);
    expect(list[0]?.installations).toEqual([
      expect.objectContaining({ installationId: 701, accepted: false, keyRef: 'panel' }),
    ]);
    await stepUp();
    const dup = await owner.req('POST', '/integrations/github/manifest', {
      target: 'organization',
      organization: 'ACME-labs',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.body).toContain('github_already_connected');
    expect((await audits('github.connect.complete')).map((m) => m.keyRef)).toEqual(['panel', orgRef]);
  });

  it('uses only accepted installations: listing, project configuration and tokens', async () => {
    const none = await owner.req('GET', '/integrations/github/repositories');
    expect(none.json<{ total: number }>().total).toBe(0);
    // Accepting needs an always-fresh step-up.
    h.clock.advance(11 * 60_000);
    const stale = await owner.req('PUT', '/integrations/github/installations/801', { accepted: true });
    expect(stale.statusCode).toBe(403);
    await stepUp();
    for (const id of [801, 701]) {
      const r = await owner.req('PUT', `/integrations/github/installations/${String(id)}`, {
        accepted: true,
      });
      expect(r.statusCode, r.body).toBe(200);
    }
    expect(
      (await owner.req('PUT', '/integrations/github/installations/999', { accepted: true })).statusCode,
    ).toBe(404);
    const repos = await owner.req('GET', '/integrations/github/repositories');
    expect(
      repos
        .json<{ items: { fullName: string; keyRef: string; appId: string }[] }>()
        .items.map((r) => [r.fullName, r.keyRef, r.appId]),
    ).toEqual([
      ['acme-labs/api', orgRef, String(ORG_APP)],
      ['octo-org/app', 'panel', String(gh.appId)],
    ]);
    // A project stores the connection and installation its repository goes through.
    await stepUp();
    const wrong = await owner.req('PUT', `/projects/${PROJECT}/git`, {
      expectedVersion: 0,
      provider: 'github',
      repositoryUrl: 'https://github.com/acme-labs/api.git',
      baseBranch: 'main',
      github: { installationId: 801, keyRef: 'panel' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain('not_an_installation_of_this_app');
    const ok = await owner.req('PUT', `/projects/${PROJECT}/git`, {
      expectedVersion: 0,
      provider: 'github',
      repositoryUrl: 'https://github.com/acme-labs/api.git',
      baseBranch: 'main',
      github: { installationId: 801, keyRef: orgRef },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      config: { github: { keyRef: orgRef, installationId: 801, appId: String(ORG_APP) } },
    });
    // The project's token comes from the organization App.
    const before = gh.tokenRequests.length;
    await owner.req('GET', `/projects/${PROJECT}/git/protection`);
    expect(gh.tokenRequests.length).toBeGreaterThan(before);
    // Taking the acceptance back: no more tokens for it.
    await stepUp();
    const revoke = await owner.req('PUT', '/integrations/github/installations/801', { accepted: false });
    expect(revoke.statusCode, revoke.body).toBe(200);
    const blocked = await owner.req('GET', `/projects/${PROJECT}/git/protection`);
    expect(blocked.json()).toMatchObject({ state: 'unknown' });
    expect(blocked.json<{ reason: string }>().reason).toContain('not accepted');
    expect((await audits('github.installation.revoke'))[0]).toMatchObject({
      installationId: 801,
      projects: [PROJECT],
    });
    await stepUp();
    expect(
      (await owner.req('PUT', '/integrations/github/installations/801', { accepted: true })).statusCode,
    ).toBe(200);
  });

  it('verifies each webhook delivery with the secret of the App it names; an unknown App is refused', async () => {
    const target = (id: number) => ({
      'x-github-hook-installation-target-type': 'integration',
      'x-github-hook-installation-target-id': String(id),
    });
    expect((await hook(orgApp.webhookSecret, target(ORG_APP))).statusCode).toBe(200);
    expect((await hook(gh.webhookSecret, target(gh.appId))).statusCode).toBe(200);
    // The other App's secret, an unknown App: refused like a wrong signature.
    expect((await hook(gh.webhookSecret, target(ORG_APP))).statusCode).toBe(401);
    expect((await hook(orgApp.webhookSecret, target(9999))).statusCode).toBe(401);
    // Without the header any connection's secret is accepted (older deliveries).
    expect((await hook(orgApp.webhookSecret, {})).statusCode).toBe(200);
    expect((await hook('wrong', {})).statusCode).toBe(401);
  });

  it('renames and disconnects one connection; the other stays', async () => {
    await stepUp();
    const bad = await owner.req('PATCH', `/integrations/github/connections/${String(orgId)}`, {
      label: 'two\nlines',
    });
    expect(bad.statusCode).toBe(400);
    const renamed = await owner.req('PATCH', `/integrations/github/connections/${String(orgId)}`, {
      label: 'Acme Labs',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await connections())[1]?.label).toBe('Acme Labs');
    expect((await audits('github.connection.rename'))[0]).toMatchObject({ from: 'Acme', to: 'Acme Labs' });
    expect(
      (await owner.req('PATCH', '/integrations/github/connections/999', { label: 'x' })).statusCode,
    ).toBe(404);

    const gone = await owner.req('DELETE', `/integrations/github?connectionId=${String(orgId)}`);
    expect(gone.statusCode, gone.body).toBe(200);
    expect(gone.json()).toMatchObject({ affectedProjects: [PROJECT] });
    const left = await connections();
    expect(left.map((c) => c.keyRef)).toEqual(['panel']);
    expect(
      (await h.db.pool.query('SELECT 1 FROM github_app_installations WHERE installation_id = 801')).rowCount,
    ).toBe(0);
    // Its deliveries are no longer accepted; the first App's still are.
    expect(
      (
        await hook(orgApp.webhookSecret, {
          'x-github-hook-installation-target-id': String(ORG_APP),
        })
      ).statusCode,
    ).toBe(401);
    expect((await hook(gh.webhookSecret, {})).statusCode).toBe(200);
  });
});
