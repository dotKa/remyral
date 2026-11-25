import { randomUUID } from 'node:crypto';
import { FakeAssistantEngine } from '@remyral/agent-adapters';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMasterApp } from '../../src/compose.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { ChatStore } from '../../src/chat/store.js';
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
 * p16-chat-complete §2: turns a stopped master left open are answered again once — by exactly one of the replicas that
 * recover at the same time — unless they acted, were already re-run or belong to a live replica.
 */
describeIntegration('chat restart re-run across replicas (p16-chat-complete)', { timeout: 120_000 }, () => {
  let h: Harness;
  let urlA: string;
  let appB: FastifyInstance;
  let poolB: Pool;
  let owner: Client;
  let ownerId = '';
  let secret: string;
  const dirs: string[] = [];
  const claude = new FakeAssistantEngine('claude-code');
  let worker: RunningWorker | undefined;
  const chat = { restartRecovery: { graceMs: 0 }, replicas: { presenceMs: 500 }, sweepIntervalMs: 0 };

  async function messages(threadId: string): Promise<Message[]> {
    return (await owner.req('GET', `/chat/threads/${threadId}`)).json<{ messages: Message[] }>().messages;
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      chat,
    });
    urlA = await h.listen();
    ownerId = await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, secret);
  });

  afterAll(async () => {
    await worker?.stop().catch(() => undefined);
    await appB.close();
    await poolB.end();
    await h.stop();
    await removeDirs(dirs);
  });

  it('re-runs an orphan that did not act once, ends the others with a line, leaves a live replica’s turn', async () => {
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    const dir = await tempDataDir(dirs);
    const workerId = await pairRealWorker(h, urlA, owner, secret, dir);
    worker = await runRealWorker(urlA, dir, {
      capabilities: CAPS,
      assistant: { engine: claude, clock: h.clock.now },
    });
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    const put = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId,
      runtime: 'claude-code',
      modelProfile: null,
      expectedVersion: 1,
    });
    expect(put.statusCode, put.body).toBe(200);

    // Turns a stopped process left open (created before both replicas below started).
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const before = new Date(h.clock.now().getTime() - 60_000);
    const orphan = async (
      text: string,
      opts: { actions?: number; runner?: string; rerunOf?: string },
    ): Promise<{ thread: string; turn: string }> => {
      const thread = (await store.createThread(ownerId, text)).id;
      const m = await store.addMessage(thread, { role: 'user', content: text, meta: { origin: 'user' } });
      const turn = randomUUID();
      await h.db.pool.query(
        `INSERT INTO chat_turns (id, thread_id, user_id, worker_id, runtime, state, created_at, message_id, actions,
                                 runner, rerun_of)
         VALUES ($1, $2, $3, $4, 'claude-code', 'running', $5, $6, $7, $8, $9)`,
        [
          turn,
          thread,
          ownerId,
          workerId,
          before,
          m.id,
          opts.actions ?? 0,
          opts.runner ?? 'gone-replica',
          opts.rerunOf ?? null,
        ],
      );
      return { thread, turn };
    };
    const quiet = await orphan('question one', {});
    const acted = await orphan('question two', { actions: 1 });
    const rerun = await orphan('question three', { rerunOf: randomUUID() });

    // A second replica on the same database (started now: the orphans are older than both processes).
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
      chat,
    });
    await appB.ready();
    // A turn of the live replica B is never touched by A.
    const live = await orphan('question four', { runner: appB.chat.runner });
    await expect
      .poll(async () => (await owner.req('GET', '/chat/status')).json<{ available: boolean }>().available, {
        timeout: 15_000,
      })
      .toBe(true);
    // Both replicas know each other (presence every 500 ms).
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const turns = claude.sessions.reduce((n, s) => n + s.turns.length, 0);
    const [a, b] = await Promise.all([h.app.chat.recover(), appB.chat.recover()]);
    expect(a.rerun + b.rerun).toBe(1);
    expect(a.lost + b.lost).toBe(3);

    await expect
      .poll(async () => (await messages(quiet.thread)).filter((m) => m.role === 'assistant').length, {
        timeout: 30_000,
      })
      .toBe(1);
    expect(claude.sessions.reduce((n, s) => n + s.turns.length, 0)).toBe(turns + 1);
    expect(claude.sessions.at(-1)?.turns.at(-1)?.message).toBe('question one');
    const q = await messages(quiet.thread);
    expect(q.find((m) => m.meta?.notice === 'chat-failover')?.meta).toMatchObject({ cause: 'restart' });
    const { rows } = await h.db.pool.query<{
      state: string;
      reason: string | null;
      origin: string | null;
      rerun_of: string | null;
    }>(
      `SELECT state, reason, origin, rerun_of::text AS rerun_of FROM chat_turns WHERE thread_id = $1
        ORDER BY origin NULLS FIRST`,
      [quiet.thread],
    );
    expect(rows.map((r) => [r.state, r.reason, r.origin, r.rerun_of])).toEqual([
      ['failed', 'lost', null, null],
      ['done', null, 'restart', quiet.turn],
    ]);

    const actedLine = (await messages(acted.thread)).find((m) => m.role === 'error');
    expect(actedLine?.content).toContain('interrupted when the master restarted');
    expect(actedLine?.content).toContain('It had already acted (1 tool call)');
    expect((await messages(acted.thread)).some((m) => m.role === 'assistant')).toBe(false);
    expect((await messages(rerun.thread)).find((m) => m.role === 'error')?.content).toContain('Use Retry');
    const liveRow = await h.db.pool.query<{ state: string }>('SELECT state FROM chat_turns WHERE id = $1', [
      live.turn,
    ]);
    expect(liveRow.rows[0]?.state).toBe('running');

    // Idempotent: nothing more happens on the next pass.
    const again = await Promise.all([h.app.chat.recover(), appB.chat.recover()]);
    expect(again.map((x) => x.lost + x.rerun)).toEqual([0, 0]);
    const audit = await h.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'chat.turn.restart_rerun'",
    );
    expect(audit.rows[0]?.n).toBe(1);
    await h.db.pool.query("UPDATE chat_turns SET state = 'failed' WHERE id = $1", [live.turn]);
  });
});
