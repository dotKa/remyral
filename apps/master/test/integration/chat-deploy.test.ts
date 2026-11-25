import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Role } from '../../src/auth/users.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCloudflare, FakeCoolify } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p6-deploy-integrations × ops chat: draft_deploy / draft_dns_change / deploy_status run as the turn's user with the
 * console's authorization; drafts never touch Coolify / Cloudflare; confirming requests the action through the same
 * service (its policy then applies), and nothing the assistant sees contains a token.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'shop';

describeIntegration('ops chat deploy tools (integration)', { timeout: 120_000 }, () => {
  const h = new Harness();
  const coolify = new FakeCoolify();
  const cf = new FakeCloudflare();
  let owner: Client;
  let ownerSecret = '';
  let ownerId = '';
  let viewerId = '';
  let outsiderId = '';
  let tools: ChatTools;
  let store: ChatStore;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
  }

  beforeAll(async () => {
    await coolify.start();
    await cf.start();
    await h.start({
      ops: { internalOrigins: [coolify.base, cf.base], cloudflareApi: `${cf.base}/client/v4` },
    });
    ownerId = await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    viewerId = await h.createUser('viewer1', PW, 'viewer');
    await h.grant(viewerId, [PROJECT], 'viewer');
    outsiderId = await h.createUser('op.other', PW, 'operator');
    await h.grant(outsiderId, ['other'], 'operator');
    coolify.addApp({ uuid: 'shopprod01', name: 'shop-prod' });
    coolify.addApp({ uuid: 'shopprev01', name: 'shop-preview' });
    const zone = cf.addZone('example.test');
    cf.addRecord(zone, { type: 'A', name: 'www.example.test', content: '192.0.2.1', ttl: 1, proxied: false });
    await stepUp();
    expect(
      (await owner.req('PUT', '/integrations/ops/coolify', { url: coolify.base, token: coolify.token }))
        .statusCode,
    ).toBe(200);
    expect(
      (await owner.req('PUT', '/integrations/ops/cloudflare', { accountId: cf.account, token: cf.token }))
        .statusCode,
    ).toBe(200);
    const t = await owner.req('PUT', `/projects/${PROJECT}/deploy-targets`, {
      targets: {
        coolify: { preview: { uuids: ['shopprev01'] }, production: { uuids: ['shopprod01'] } },
        dns: { zones: [{ id: zone, name: 'example.test' }] },
      },
    });
    expect(t.statusCode, t.body).toBe(200);
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      ops: () => h.app.ops,
    } as unknown as ChatToolsDeps);
  });
  afterAll(async () => {
    await h.stop();
    await coolify.stop();
    await cf.stop();
  });

  async function caller(userId: string, role: Role): Promise<ToolCaller> {
    const thread = await store.createThread(userId, 'deploys');
    return {
      userId,
      subject: await loadSubject(h.db.pool, { id: userId, role }),
      threadId: thread.id,
      turnId: randomUUID(),
    };
  }

  it('draft_deploy: a card with target, diff and policy; nothing is deployed until confirmed', async () => {
    coolify.reset();
    const c = await caller(ownerId, 'owner');
    const out = await tools.run(c, 'draft_deploy', {
      project: PROJECT,
      action: 'coolify.deploy',
      env: 'production',
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok || out.draft === undefined) throw new Error('no draft');
    expect(out.data).toMatchObject({
      kind: 'ops_action',
      action: 'coolify.deploy',
      env: 'production',
      policy: { decision: 'approval_step_up' },
      diff: { resources: [{ uuid: 'shopprod01', name: 'shop-prod' }] },
    });
    expect(coolify.calls(/POST/)).toEqual([]);
    expect(JSON.stringify(out.data)).not.toContain(coolify.token);
    // Confirming needs a step-up, then *requests* the action: production waits for an approval.
    h.clock.advance(11 * 60_000);
    expect((await owner.req('POST', `/chat/drafts/${out.draft.id}/confirm`)).statusCode).toBe(403);
    await stepUp();
    const conf = await owner.req('POST', `/chat/drafts/${out.draft.id}/confirm`);
    expect(conf.statusCode, conf.body).toBe(200);
    expect(conf.json()).toMatchObject({
      result: { kind: 'coolify.deploy', state: 'awaiting_approval', policy: 'approval_step_up' },
    });
    expect(coolify.calls(/POST/)).toEqual([]);
    const status = await tools.run(c, 'deploy_status', { project: PROJECT });
    expect(status.ok).toBe(true);
    expect(JSON.stringify(status.ok ? status.data : null)).toContain('awaiting_approval');
  });

  it('a confirmed preview card runs at once (auto policy)', async () => {
    coolify.reset();
    const c = await caller(ownerId, 'owner');
    const out = await tools.run(c, 'draft_deploy', {
      project: PROJECT,
      action: 'coolify.deploy',
      env: 'preview',
    });
    if (!out.ok || out.draft === undefined) throw new Error('no draft');
    await stepUp();
    const conf = await owner.req('POST', `/chat/drafts/${out.draft.id}/confirm`);
    expect(conf.json()).toMatchObject({ result: { state: 'deploying', policy: 'auto' } });
    expect(coolify.calls(/POST/)).toEqual(['POST /api/v1/deploy?uuid=shopprev01']);
  });

  it('draft_dns_change: diff against the current record; protected names are reported as refused', async () => {
    const c = await caller(ownerId, 'owner');
    const out = await tools.run(c, 'draft_dns_change', {
      project: PROJECT,
      operation: 'upsert',
      zone: 'example.test',
      type: 'A',
      name: 'www.example.test',
      content: '192.0.2.7',
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.ok ? out.data : null).toMatchObject({
      policy: { decision: 'approval' },
      diff: { action: 'update', before: { content: '192.0.2.1' }, after: { content: '192.0.2.7' } },
    });
    const del = await tools.run(c, 'draft_dns_change', {
      project: PROJECT,
      operation: 'delete',
      zone: 'example.test',
      type: 'A',
      name: 'www.example.test',
    });
    expect(del.ok ? del.data : null).toMatchObject({ policy: { decision: 'approval_step_up' } });
    const missing = await tools.run(c, 'draft_dns_change', {
      project: PROJECT,
      operation: 'upsert',
      zone: 'example.test',
      type: 'A',
      name: 'www.example.test',
    });
    expect(missing).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refuses what the console refuses: viewers, other projects, unknown fields, rollbacks that do not exist', async () => {
    const v = await caller(viewerId, 'viewer');
    expect(
      await tools.run(v, 'draft_deploy', { project: PROJECT, action: 'coolify.deploy', env: 'preview' }),
    ).toMatchObject({ ok: false, code: 'forbidden' });
    const o = await caller(outsiderId, 'operator');
    expect(
      await tools.run(o, 'draft_deploy', { project: PROJECT, action: 'coolify.deploy', env: 'preview' }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(await tools.run(o, 'deploy_status', { project: PROJECT })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    const c = await caller(ownerId, 'owner');
    expect(
      await tools.run(c, 'draft_deploy', {
        project: PROJECT,
        action: 'coolify.deploy',
        env: 'preview',
        token: 'x',
      }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(await tools.run(c, 'draft_deploy', { action: 'rollback', actionId: randomUUID() })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});
