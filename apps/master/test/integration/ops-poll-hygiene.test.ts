import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { OUTBOX_TOPIC_OPS_ACTION } from '../../src/ops/outbox.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCloudflare, FakeCoolify } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p22-ops-hygiene against a real master and a fake Coolify: the deploy status poller ends an action whose deployment
 * the provider no longer knows (3 "not found" answers in a row), backs off on transient errors instead of asking every
 * 15 s, and fails a deploying action past its maximum age (2 h) — the stuck row seen on the test server heals itself.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'shop';

const coolify = new FakeCoolify();
const cf = new FakeCloudflare();
const h = new Harness();
let owner: Client;
let ownerSecret = '';

async function stepUp(): Promise<void> {
  h.clock.advance(30_000);
  expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
}

/** A preview Coolify deploy requested by an automation run: the action is `deploying`. */
async function deploying(): Promise<string> {
  await stepUp();
  const created = await owner.req('POST', '/automations', {
    project: PROJECT,
    name: `deploy ${randomUUID().slice(0, 6)}`,
    trigger: { kind: 'cron', cron: '0 3 * * *' },
    target: { kind: 'deploy', action: 'coolify.deploy', params: { env: 'preview' } },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ automation: { id: string } }>().automation.id;
  await stepUp();
  expect((await owner.req('POST', `/automations/${id}/run`)).statusCode).toBeLessThan(300);
  const { rows } = await h.db.pool.query<{ ops_action_id: string }>(
    'SELECT ops_action_id::text AS ops_action_id FROM automation_runs WHERE automation_id = $1',
    [id],
  );
  const actionId = rows[0]?.ops_action_id ?? '';
  expect((await row(actionId))?.state).toBe('deploying');
  return actionId;
}

const row = async (id: string) =>
  (
    await h.db.pool.query<{
      state: string;
      error: string | null;
      poll_errors: number;
      poll_not_found: number;
      next_poll_at: Date | null;
    }>('SELECT state, error, poll_errors, poll_not_found, next_poll_at FROM ops_actions WHERE id = $1', [id])
  ).rows[0];

const failedOutbox = async (id: string): Promise<number> =>
  (
    await h.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE topic = $1 AND payload->>'actionId' = $2 AND payload->>'event' = 'failed'",
      [OUTBOX_TOPIC_OPS_ACTION, id],
    )
  ).rows[0]?.n ?? 0;

/** Deployments of the fake Coolify that are still running (one per deploy). */
function forgetDeployments(): void {
  for (const [k, d] of coolify.deployments) if (d.status === 'queued') coolify.deployments.delete(k);
}

describeIntegration('p22-ops-hygiene: deploy status polling (integration)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await coolify.start();
    await cf.start();
    await h.start({
      ops: {
        internalOrigins: [coolify.base, cf.base],
        cloudflareApi: `${cf.base}/client/v4`,
        limits: { perProjectPer10Min: 500 },
      },
    });
    await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [PROJECT]);
    coolify.addApp({ uuid: 'shopprev01', name: 'shop-preview' });
    await stepUp();
    expect(
      (await owner.req('PUT', '/integrations/ops/coolify', { url: coolify.base, token: coolify.token }))
        .statusCode,
    ).toBe(200);
    const t = await owner.req('PUT', `/projects/${PROJECT}/deploy-targets`, {
      targets: { coolify: { preview: { uuids: ['shopprev01'] } } },
    });
    expect(t.statusCode, t.body).toBe(200);
  });
  afterAll(async () => {
    await h.stop();
    await coolify.stop();
    await cf.stop();
  });

  it('a deployment the provider no longer knows fails the action after 3 "not found" answers', async () => {
    const id = await deploying();
    forgetDeployments();
    h.clock.advance(20_000);
    await h.app.ops.pollDeploying();
    expect(await row(id)).toMatchObject({ state: 'deploying', poll_not_found: 1 });
    h.clock.advance(20_000);
    await h.app.ops.pollDeploying();
    expect(await row(id)).toMatchObject({ state: 'deploying', poll_not_found: 2 });
    // Backoff: 30 s after the second answer — not asked again before.
    h.clock.advance(16_000);
    await h.app.ops.pollDeploying();
    expect((await row(id))?.poll_not_found).toBe(2);
    h.clock.advance(20_000);
    await h.app.ops.pollDeploying();
    const r = await row(id);
    expect(r?.state).toBe('failed');
    expect(r?.error).toContain('no longer knows this deployment');
    expect(await failedOutbox(id)).toBe(1);
    // Ended: never polled again.
    const before = coolify.requests.length;
    h.clock.advance(60_000);
    await h.app.ops.pollDeploying();
    expect(coolify.requests.length).toBe(before);
  });

  it('transient provider errors back off exponentially; a successful poll resets the counters', async () => {
    const id = await deploying();
    coolify.failNext = { status: 503, match: /^GET \/api\/v1\/deployments\//, times: 1_000 };
    h.clock.advance(20_000);
    await h.app.ops.pollDeploying();
    expect(await row(id)).toMatchObject({ state: 'deploying', poll_errors: 1 });
    h.clock.advance(20_000);
    await h.app.ops.pollDeploying();
    expect(await row(id)).toMatchObject({ poll_errors: 2 });
    // The third try waits 30 s, the fourth 60 s.
    h.clock.advance(20_000);
    await h.app.ops.pollDeploying();
    expect((await row(id))?.poll_errors).toBe(2);
    h.clock.advance(15_000);
    await h.app.ops.pollDeploying();
    expect((await row(id))?.poll_errors).toBe(3);
    h.clock.advance(40_000);
    await h.app.ops.pollDeploying();
    expect((await row(id))?.poll_errors).toBe(3);
    coolify.failNext = null;
    for (const d of coolify.deployments.values()) if (d.status === 'queued') d.status = 'in_progress';
    h.clock.advance(25_000);
    await h.app.ops.pollDeploying();
    expect(await row(id)).toMatchObject({
      state: 'deploying',
      poll_errors: 0,
      poll_not_found: 0,
      next_poll_at: null,
    });
    for (const d of coolify.deployments.values()) if (d.status === 'in_progress') d.status = 'finished';
    h.clock.advance(20_000);
    await h.app.ops.pollDeploying();
    expect((await row(id))?.state).toBe('succeeded');
  });

  it('a deploying action past its maximum age fails as timed out on the next pass (even in backoff)', async () => {
    const id = await deploying();
    forgetDeployments();
    // The stuck row of the test server: deploying for days, its deployment gone, last poll in backoff.
    await h.db.pool.query(
      `UPDATE ops_actions SET created_at = created_at - interval '3 days',
              decided_at = COALESCE(decided_at, created_at) - interval '3 days',
              poll_errors = 7, next_poll_at = $2
        WHERE id = $1`,
      [id, new Date(h.clock.now().getTime() + 3_600_000)],
    );
    h.clock.advance(20_000);
    await h.app.ops.pollDeploying();
    const r = await row(id);
    expect(r?.state).toBe('failed');
    expect(r?.error).toMatch(/^Timed out: no outcome 2 hours after the deploy started/);
    expect(await failedOutbox(id)).toBe(1);
  });
});
