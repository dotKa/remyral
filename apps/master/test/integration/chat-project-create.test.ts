import { FakeAssistantEngine, fakeToolData } from '@remyral/agent-adapters';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { FakeGitHub } from '../helpers/fake-github.js';
import { FakeCloudflare } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { CAPS, pairRealWorker, removeDirs, runRealWorker, tempDataDir } from '../helpers/real-worker.js';

/**
 * p17-chat-github Part 2 (docs/design/p17-chat-github.md §2) end to end: a real master (Postgres), the local fake
 * GitHub (one App, one accepted and one pending installation) and fake Cloudflare (one zone), and a real assistant
 * worker whose fake engine calls the tools as rule 50 tells the model to.
 *
 * - list_git_repositories / list_dns_zones: only accepted installations, only zones the integration sees;
 * - draft_project_create: a card — never executed by itself, not even with `execute: true`; refused for an unknown
 *   repository (incl. one of a pending installation), an unknown zone, an existing id, an operator;
 * - confirming (owner, step-up per the security policy) creates the project (audited `project.create` with
 *   `via: 'chat'`), links the repository through its connection and sets the allowed DNS zone;
 * - a confirm by someone who lost the admin role is refused; with the strict preset the card asks for a code.
 */
const PW = 'quartz-meadow-lantern-7';
const CONSOLE = 'https://console.example.test';

interface Draft {
  id: string;
  kind: string;
  state: string;
  result: Record<string, unknown> | null;
}

describeIntegration('a project from the chat (integration, p17-chat-github)', { timeout: 240_000 }, () => {
  const gh = new FakeGitHub();
  const cf = new FakeCloudflare();
  const engine = new FakeAssistantEngine();
  const h = new Harness();
  const dirs: string[] = [];
  const workers: { stop(): Promise<void> }[] = [];
  let owner: Client;
  let ownerSecret = '';
  let operator: Client;
  let operatorId = '';
  let url = '';
  let zoneId = '';
  const tool = (name: string, input: Record<string, unknown>) => `[[tool ${name} ${JSON.stringify(input)}]]`;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    const r = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
    expect(r.statusCode, r.body).toBe(200);
  }

  async function detail(
    c: Client,
    id: string,
  ): Promise<{ drafts: Draft[]; turn: unknown; messages: { seq: number; role: string; content: string }[] }> {
    const r = await c.req('GET', `/chat/threads/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  }

  async function ask(c: Client, text: string): Promise<{ thread: string; reply: string }> {
    const t = await c.req('POST', '/chat/threads', {});
    expect(t.statusCode, t.body).toBe(201);
    const thread = t.json<{ id: string }>().id;
    const r = await c.req('POST', `/chat/threads/${thread}/messages`, { text });
    expect(r.statusCode, r.body).toBe(202);
    const seq = r.json<{ message: { seq: number } }>().message.seq;
    let last = '';
    await expect
      .poll(
        async () => {
          const d = await detail(c, thread);
          last =
            d.messages.filter((m) => m.seq > seq && (m.role === 'assistant' || m.role === 'error')).at(-1)
              ?.content ?? '';
          return d.turn === null && last !== '';
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    return { thread, reply: last };
  }

  async function audits(action: string): Promise<Record<string, unknown>[]> {
    const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM audit_events WHERE action = $1 ORDER BY id',
      [action],
    );
    return rows.map((r) => r.metadata);
  }

  const card = (extra: Record<string, unknown> = {}) =>
    tool('draft_project_create', {
      id: 'shop-web',
      name: 'Shop web',
      description: 'The shop storefront.',
      repository: 'octo-org/app',
      dnsZone: 'example.test',
      ...extra,
    });

  beforeAll(async () => {
    const base = await gh.start();
    await cf.start();
    await h.start({
      securityPolicy: { preset: 'serbest' },
      gitflow: { githubApiUrl: base, githubWebUrl: base, consoleOrigin: CONSOLE },
      ops: { internalOrigins: [cf.base], cloudflareApi: `${cf.base}/client/v4` },
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    await h.createUser('owner.pc', PW, 'owner');
    ownerSecret = (await enroll(h, 'owner.pc', PW)).secret;
    owner = await fullLogin(h, 'owner.pc', PW, ownerSecret);
    operatorId = await h.createUser('op.pc', PW, 'operator');
    operator = await fullLogin(h, 'op.pc', PW, (await enroll(h, 'op.pc', PW)).secret);
    gh.installations.push(
      { id: 701, account: 'octo-org', repos: [{ owner: 'octo-org', name: 'app', defaultBranch: 'trunk' }] },
      {
        id: 702,
        account: 'other-org',
        accountType: 'Organization',
        repos: [{ owner: 'other-org', name: 'secret' }],
      },
    );
    zoneId = cf.addZone('example.test');
    await stepUp();
    const start = await owner.req('POST', '/integrations/github/manifest', { target: 'user' });
    const state =
      new URL(start.json<{ formPath: string }>().formPath, CONSOLE).searchParams.get('state') ?? '';
    gh.codes.add('pc-1');
    expect(
      (await owner.req('POST', '/integrations/github/manifest/complete', { code: 'pc-1', state })).statusCode,
    ).toBe(200);
    // Only the owner's own installation is accepted; other-org stays pending.
    expect(
      (await owner.req('PUT', '/integrations/github/installations/701', { accepted: true })).statusCode,
    ).toBe(200);
    expect(
      (await owner.req('PUT', '/integrations/ops/cloudflare', { accountId: cf.account, token: cf.token }))
        .statusCode,
    ).toBe(200);
  });

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.stop().catch(() => undefined)));
    await h.stop();
    await gh.stop();
    await cf.stop();
    await removeDirs(dirs);
  });

  it('sets up the assistant machine', async () => {
    await stepUp();
    const dir = await tempDataDir(dirs);
    const workerId = await pairRealWorker(h, url, owner, ownerSecret, dir);
    workers.push(
      await runRealWorker(url, dir, { capabilities: CAPS, assistant: { engine, clock: h.clock.now } }),
    );
    await stepUp();
    const s = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId,
      runtime: 'claude-code',
      modelProfile: null,
      expectedVersion: 1,
    });
    expect(s.statusCode, s.body).toBe(200);
    await expect
      .poll(async () => (await owner.req('GET', '/chat/status')).json<{ available: boolean }>().available, {
        timeout: 20_000,
      })
      .toBe(true);
  });

  it('lists only reachable repositories and existing zones', async () => {
    let repos: unknown = null;
    let zones: unknown = null;
    engine.script(/^hangi repolar/i, async ({ call }) => {
      repos = fakeToolData((await call('list_git_repositories', {})).content);
      zones = fakeToolData((await call('list_dns_zones', {})).content);
      return 'listed';
    });
    await ask(owner, 'hangi repolar ve alan adları var?');
    expect(repos).toMatchObject({
      total: 1,
      repositories: [
        { fullName: 'octo-org/app', defaultBranch: 'trunk', connection: 'panel', installationId: 701 },
      ],
    });
    expect(zones).toEqual({ zones: [{ name: 'example.test', status: 'active' }] });
  });

  it('refuses an unknown or pending repository, an unknown zone and an operator — without a card', async () => {
    const pending = await ask(owner, card({ repository: 'other-org/secret' }));
    expect(pending.reply).toContain('not reachable');
    expect((await detail(owner, pending.thread)).drafts).toEqual([]);
    const zone = await ask(owner, card({ dnsZone: 'nope.test' }));
    expect(zone.reply).toContain('Available: example.test');
    const op = await ask(operator, card());
    expect(op.reply).toContain('not allowed to create projects');
    expect((await detail(operator, op.thread)).drafts).toEqual([]);
    expect((await h.db.pool.query("SELECT 1 FROM projects WHERE id = 'shop-web'")).rowCount).toBe(0);
  });

  it('a card shows what will be created; nothing happens until it is confirmed (not even with execute)', async () => {
    const { thread } = await ask(owner, card({ execute: true }));
    const d = (await detail(owner, thread)).drafts[0];
    expect(d).toMatchObject({ kind: 'project_create', state: 'proposed' });
    expect((await h.db.pool.query("SELECT 1 FROM projects WHERE id = 'shop-web'")).rowCount).toBe(0);
    const payload = (
      await h.db.pool.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM chat_drafts WHERE id = $1',
        [d?.id],
      )
    ).rows[0]?.payload;
    expect(payload).toMatchObject({
      op: 'project_create',
      project: { id: 'shop-web', name: 'Shop web', kind: 'repository' },
      description: 'The shop storefront.',
      repository: { fullName: 'octo-org/app', baseBranch: 'trunk', keyRef: 'panel', installationId: 701 },
      dnsZone: { id: zoneId, name: 'example.test' },
    });
    // Someone who is no longer an administrator cannot confirm it.
    await h.db.pool.query("UPDATE users SET role = 'operator' WHERE username = 'owner.pc'");
    const denied = await owner.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
    expect(denied.statusCode).toBe(403);
    await h.db.pool.query("UPDATE users SET role = 'owner' WHERE username = 'owner.pc'");
    await stepUp();
    const ok = await owner.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      result: {
        op: 'project_create',
        project: 'shop-web',
        repository: { fullName: 'octo-org/app', linked: true, connection: 'panel' },
        dnsZone: { name: 'example.test', set: true },
        warnings: [],
      },
    });
    const p = (
      await h.db.pool.query<{ name: string; description: string }>(
        'SELECT name, description FROM projects WHERE id = $1',
        ['shop-web'],
      )
    ).rows[0];
    expect(p).toEqual({ name: 'Shop web', description: 'The shop storefront.' });
    const git = await owner.req('GET', '/projects/shop-web/git');
    expect(git.json()).toMatchObject({
      config: {
        repositoryUrl: 'https://github.com/octo-org/app.git',
        baseBranch: 'trunk',
        github: { keyRef: 'panel', installationId: 701 },
      },
    });
    const targets = await owner.req('GET', '/projects/shop-web/deploy-targets');
    expect(targets.json()).toMatchObject({
      targets: { dns: { zones: [{ id: zoneId, name: 'example.test' }] } },
    });
    expect((await audits('project.create')).at(-1)).toMatchObject({ name: 'Shop web', via: 'chat' });
    // An existing id is refused without a card.
    const again = await ask(owner, card());
    expect(again.reply).toContain('already exists');
  });

  it('with the strict preset the card asks for an authenticator code', async () => {
    await stepUp();
    await h.setSecurityPolicy({ preset: 'siki' });
    const { thread } = await ask(owner, card({ id: 'shop-two', repository: undefined, dnsZone: undefined }));
    const d = (await detail(owner, thread)).drafts[0];
    expect(d).toMatchObject({ kind: 'project_create', state: 'proposed' });
    h.clock.advance(11 * 60_000);
    const stale = await owner.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
    expect(stale.statusCode).toBe(403);
    expect(stale.body).toContain('step_up');
    await stepUp();
    const ok = await owner.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ result: { project: 'shop-two', warnings: [] } });
    await h.setSecurityPolicy({ preset: 'serbest' });
    expect(operatorId).not.toBe('');
  });
});
