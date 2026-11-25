import { FakeAssistantEngine } from '@remyral/agent-adapters';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMasterApp } from '../../src/compose.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { DEFAULT_REQUEST_LIMITS, scaleRequestLimits } from '../../src/http/rate-policy.js';
import { describeIntegration, uniquePrefix } from '../helpers/env.js';
import { type Client, enroll, FAST_SCRYPT, fullLogin, Harness } from '../helpers/harness.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';

interface Message {
  role: string;
  content: string;
  meta: Record<string, unknown> | null;
}

/**
 * p15-chat-failover with two master replicas (design §9): the primary assistant worker is connected to replica A, the
 * backup to replica B, the user talks to A. A turn lost with the primary is re-run on the backup through B (A
 * dispatches it over the replica bus; B runs it and records the answer), and the next turns go to the backup through B
 * while the primary is away.
 */
describeIntegration('chat failover across master replicas (integration)', { timeout: 120_000 }, () => {
  let h: Harness;
  let urlA: string;
  let urlB: string;
  let appB: FastifyInstance;
  let poolB: Pool;
  let owner: Client;
  let secret: string;
  const dirs: string[] = [];
  const claudeP = new FakeAssistantEngine('claude-code');
  const claudeB = new FakeAssistantEngine('claude-code');
  let workerP: RunningWorker | undefined;
  let workerB: RunningWorker | undefined;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function messages(threadId: string): Promise<Message[]> {
    return (await owner.req('GET', `/chat/threads/${threadId}`)).json<{ messages: Message[] }>().messages;
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    urlA = await h.listen();
    poolB = createPool({ connectionString: h.db.url, max: 8, applicationName: 'remyral-test-b' });
    appB = await createMasterApp({
      pool: poolB,
      redis: h.redis,
      box: h.box,
      logLevel: 'warn',
      trustProxyHops: 0,
      requestLimits: scaleRequestLimits(DEFAULT_REQUEST_LIMITS, 1000),
      bodyLimitBytes: 64 * 1024,
      clock: h.clock.now,
      passwordParams: FAST_SCRYPT,
      rateLimitPrefix: uniquePrefix(),
      rateLimits: { perIp: 10_000, perAccount: 10_000, windowMs: 60_000 },
      workers: { sweepIntervalMs: 0 },
      orchestration: { tickIntervalMs: 0 },
      metricsTailIntervalMs: 0,
      chat: { replicas: { presenceMs: 500 } },
    });
    await appB.ready();
    await appB.listen({ host: '127.0.0.1', port: 0 });
    const addr = appB.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no TCP address');
    urlB = `ws://127.0.0.1:${String(addr.port)}`;
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, secret);
  });

  afterAll(async () => {
    await workerP?.stop().catch(() => undefined);
    await workerB?.stop().catch(() => undefined);
    await appB.close();
    await poolB.end();
    await h.stop();
    await removeDirs(dirs);
  });

  it('re-runs a turn lost with the primary on the backup held by the other replica', async () => {
    await stepUp();
    const dirP = await tempDataDir(dirs);
    const primary = await pairRealWorker(h, urlA, owner, secret, dirP);
    await stepUp();
    const dirB = await tempDataDir(dirs);
    const backup = await pairRealWorker(h, urlA, owner, secret, dirB);
    expect((await owner.req('PUT', `/workers/${primary}/name`, { name: 'build-01' })).statusCode).toBe(200);
    expect((await owner.req('PUT', `/workers/${backup}/name`, { name: 'mac-studio' })).statusCode).toBe(200);
    workerP = await runRealWorker(urlA, dirP, {
      capabilities: CAPS,
      assistant: { engine: claudeP, clock: h.clock.now },
    });
    // The backup machine is connected to replica B.
    workerB = await runRealWorker(urlB, dirB, {
      capabilities: CAPS,
      assistant: { engine: claudeB, clock: h.clock.now },
    });
    await stepUp();
    const put = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId: primary,
      runtime: 'claude-code',
      modelProfile: null,
      backupWorkerIds: [backup],
      expectedVersion: 1,
    });
    expect(put.statusCode, put.body).toBe(200);
    // Replica A sees both machines (the backup through B's presence).
    await expect
      .poll(
        async () =>
          (await owner.req('GET', '/chat/failover'))
            .json<{ chain: { eligible: boolean }[] }>()
            .chain.map((c) => c.eligible),
        { timeout: 15_000 },
      )
      .toEqual([true, true]);

    const t = (await owner.req('POST', '/chat/threads', {})).json<{ id: string }>().id;
    const sent = await owner.req('POST', `/chat/threads/${t}/messages`, {
      text: 'long answer [[slow 3000]]',
    });
    expect(sent.statusCode, sent.body).toBe(202);
    await expect
      .poll(
        async () =>
          (await owner.req('GET', `/chat/threads/${t}`)).json<{ turn: { state: string } | null }>().turn
            ?.state,
        { timeout: 15_000 },
      )
      .toBe('running');
    await workerP.stop();
    workerP = undefined;
    await expect
      .poll(async () => (await messages(t)).some((m) => m.role === 'assistant'), { timeout: 30_000 })
      .toBe(true);
    expect(claudeB.sessions.at(-1)?.turns.at(-1)?.message).toBe('long answer [[slow 3000]]');
    const all = await messages(t);
    expect(all.find((m) => m.meta?.notice === 'chat-failover')?.meta).toMatchObject({
      cause: 'rerun',
      to: 'mac-studio',
    });
    const { rows } = await h.db.pool.query<{ worker_id: string; state: string; rerun: boolean }>(
      `SELECT worker_id, state, rerun_of IS NOT NULL AS rerun FROM chat_turns WHERE thread_id = $1
        ORDER BY created_at`,
      [t],
    );
    expect(rows.map((r) => [r.worker_id, r.state, r.rerun])).toEqual([
      [primary, 'failed', false],
      [backup, 'done', true],
    ]);

    // The next turn goes to the backup through replica B directly.
    await expect
      .poll(async () => (await owner.req('GET', `/chat/threads/${t}`)).json<{ turn: unknown }>().turn, {
        timeout: 15_000,
      })
      .toBeNull();
    const again = await owner.req('POST', `/chat/threads/${t}/messages`, { text: 'and the next one?' });
    expect(again.statusCode, again.body).toBe(202);
    await expect
      .poll(async () => (await messages(t)).filter((m) => m.role === 'assistant').length, { timeout: 30_000 })
      .toBe(2);
    expect(claudeB.sessions.at(-1)?.turns.at(-1)?.message).toBe('and the next one?');
  });
});
