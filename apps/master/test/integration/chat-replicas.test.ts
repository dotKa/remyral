import { FakeAssistantEngine } from '@remyral/agent-adapters';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMasterApp } from '../../src/compose.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { DEFAULT_REQUEST_LIMITS, scaleRequestLimits } from '../../src/http/rate-policy.js';
import { describeIntegration, uniquePrefix } from '../helpers/env.js';
import { Client, enroll, FAST_SCRYPT, fullLogin, Harness } from '../helpers/harness.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';

interface Frame {
  event: string;
  data: unknown;
}

/**
 * p5-ops-chat-next: two master replicas on one database. The assistant worker is connected to replica A; the
 * user talks to replica B. B stores the message and the turn, A (which holds the worker's connection) sends it,
 * runs its tool calls and records the answer; B's open view streams it live; Stop and the kill switch sent to B
 * reach A; with nobody holding the worker, B reports it offline.
 */
describeIntegration('ops chat across master replicas (integration, p5-ops-chat-next)', () => {
  let h: Harness;
  let urlA: string;
  let appB: FastifyInstance;
  let poolB: Pool;
  let urlB: string;
  let ownerA: Client;
  let ownerB: Client;
  let secret: string;
  let worker: RunningWorker | undefined;
  let workerId = '';
  let version = 1;
  const engine = new FakeAssistantEngine();
  const dirs: string[] = [];

  async function stepUp(c: Client): Promise<void> {
    h.clock.advance(30_000);
    const res = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function putSettings(c: Client, body: Record<string, unknown>): Promise<void> {
    await stepUp(c);
    const res = await c.req('PUT', '/chat/settings', {
      enabled: true,
      workerId,
      runtime: 'claude-code',
      modelProfile: null,
      expectedVersion: version,
      ...body,
    });
    expect(res.statusCode, res.body).toBe(200);
    version = res.json<{ version: number }>().version;
  }

  async function thread(c: Client): Promise<string> {
    const res = await c.req('POST', '/chat/threads', {});
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  /** Opens the SSE view of a thread on a replica; frames are collected until `stop()`. */
  async function stream(base: string, c: Client, threadId: string) {
    const cookie = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const ac = new AbortController();
    const res = await fetch(`${base.replace(/^ws/, 'http')}/chat/threads/${threadId}/stream`, {
      headers: { cookie, 'user-agent': 'vitest-client' },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const frames: Frame[] = [];
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const raw = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = /^event: (.+)$/m.exec(raw)?.[1];
            const data = raw
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n');
            if (event !== undefined) frames.push({ event, data: data === '' ? null : JSON.parse(data) });
          }
        }
      } catch {
        // aborted
      }
    })();
    await expect.poll(() => frames.some((f) => f.event === 'ready')).toBe(true);
    return {
      frames,
      stop: () => {
        ac.abort();
      },
    };
  }

  async function lastMessage(c: Client, threadId: string) {
    const res = await c.req('GET', `/chat/threads/${threadId}`);
    expect(res.statusCode).toBe(200);
    const d = res.json<{
      messages: { role: string; content: string; meta: Record<string, unknown> | null }[];
      turn: unknown;
    }>();
    return { turn: d.turn, last: d.messages.at(-1) };
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    urlA = await h.listen();
    // Replica B: the same database, Redis and secret box, its own pool, worker hub and lease key.
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
    ownerA = await fullLogin(h, 'owner1', PW, secret);
    // One browser session used against both replicas (a load balancer in front): step-up rotates the
    // session cookie, so both clients share one cookie jar.
    ownerB = new Client(appB, '198.51.100.10');
    (ownerB as unknown as { cookies: Map<string, string> }).cookies = ownerA.cookies;
  });

  afterAll(async () => {
    await worker?.stop().catch(() => undefined);
    await appB.close();
    await poolB.end();
    await h.stop();
    await removeDirs(dirs);
  });

  it('runs a turn sent to replica B on the worker connected to replica A and streams it on B', async () => {
    await stepUp(ownerA);
    const dataDir = await tempDataDir(dirs);
    workerId = await pairRealWorker(h, urlA, ownerA, secret, dataDir);
    worker = await runRealWorker(urlA, dataDir, {
      capabilities: CAPS,
      assistant: { engine, clock: h.clock.now },
    });
    await putSettings(ownerB, {});
    // B holds no connection, but knows A does.
    await expect
      .poll(async () => (await ownerB.req('GET', '/chat/status')).json<{ available: boolean }>().available, {
        timeout: 15_000,
      })
      .toBe(true);
    const status = (await ownerB.req('GET', '/chat/status')).json<{ worker: { online: boolean } }>();
    expect(status.worker.online).toBe(true);

    const t = await thread(ownerB);
    const viewB = await stream(urlB, ownerB, t);
    const viewA = await stream(urlA, ownerA, t);
    const sent = await ownerB.req('POST', `/chat/threads/${t}/messages`, {
      text: 'hello from B [[tool list_workers]]',
    });
    expect(sent.statusCode, sent.body).toBe(202);
    await expect.poll(() => viewB.frames.some((f) => f.event === 'done'), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => viewA.frames.some((f) => f.event === 'done'), { timeout: 15_000 }).toBe(true);
    viewA.stop();
    viewB.stop();
    for (const view of [viewB, viewA]) {
      const names = view.frames.map((f) => f.event);
      for (const e of ['message', 'turn', 'tool', 'delta', 'done']) expect(names).toContain(e);
      const text = view.frames
        .filter((f) => f.event === 'delta')
        .map((f) => (f.data as { text: string }).text)
        .join('');
      expect(text).toContain('Tool list_workers answered');
    }
    // The tool ran on A as the user and the answer is persisted (seen through B's REST).
    const { turn, last } = await lastMessage(ownerB, t);
    expect(turn).toBeNull();
    expect(last?.role).toBe('assistant');
    expect(last?.content).toContain('Tool list_workers answered');
    expect(engine.sessions.at(-1)?.turns.at(-1)?.message).toContain('hello from B');
    // The thread's history reaches the worker on a second turn (loaded by A from the database).
    const again = await ownerB.req('POST', `/chat/threads/${t}/messages`, { text: 'second' });
    expect(again.statusCode, again.body).toBe(202);
    await expect
      .poll(async () => (await lastMessage(ownerB, t)).last?.content, { timeout: 15_000 })
      .toContain('Echo: second');
  });

  it('shows a running turn of replica A in a view opened on B, and Stop on B stops it on A', async () => {
    const t = await thread(ownerB);
    const sent = await ownerB.req('POST', `/chat/threads/${t}/messages`, { text: '[[slow 30000]] long one' });
    expect(sent.statusCode, sent.body).toBe(202);
    const turnId = sent.json<{ turnId: string }>().turnId;
    await expect
      .poll(async () => ((await lastMessage(ownerA, t)).turn as { state?: string } | null)?.state, {
        timeout: 10_000,
      })
      .toBe('running');
    // A view opened on B now starts with the running turn (B mirrors it).
    const view = await stream(urlB, ownerB, t);
    expect(view.frames[0]).toMatchObject({ event: 'ready', data: { turn: { id: turnId } } });
    // A second message is refused while it runs, on either replica.
    expect((await ownerB.req('POST', `/chat/threads/${t}/messages`, { text: 'x' })).statusCode).toBe(409);
    const stop = await ownerB.req('POST', `/chat/threads/${t}/cancel`);
    expect(stop.statusCode, stop.body).toBeLessThan(300);
    await expect.poll(() => view.frames.some((f) => f.event === 'error'), { timeout: 8_000 }).toBe(true);
    view.stop();
    const { turn, last } = await lastMessage(ownerB, t);
    expect(turn).toBeNull();
    expect(last).toMatchObject({ role: 'error', content: 'Stopped.' });
    const row = await h.db.pool.query<{ state: string }>('SELECT state FROM chat_turns WHERE id = $1', [
      turnId,
    ]);
    expect(row.rows[0]?.state).toBe('cancelled');
  });

  it('the kill switch sent to B stops an answer running on A', async () => {
    const t = await thread(ownerB);
    const sent = await ownerB.req('POST', `/chat/threads/${t}/messages`, { text: '[[slow 30000]] again' });
    expect(sent.statusCode, sent.body).toBe(202);
    const turnId = sent.json<{ turnId: string }>().turnId;
    await expect
      .poll(async () => ((await lastMessage(ownerA, t)).turn as { state?: string } | null)?.state, {
        timeout: 10_000,
      })
      .toBe('running');
    await putSettings(ownerB, { enabled: false });
    await expect
      .poll(
        async () =>
          (await h.db.pool.query<{ state: string }>('SELECT state FROM chat_turns WHERE id = $1', [turnId]))
            .rows[0]?.state,
        { timeout: 8_000 },
      )
      .toBe('cancelled');
    await putSettings(ownerB, { enabled: true });
  });

  it('reports the assistant offline when no replica holds the worker', async () => {
    await worker?.stop();
    worker = undefined;
    await expect
      .poll(async () => (await ownerB.req('GET', '/chat/status')).json<{ code: string | null }>().code, {
        timeout: 10_000,
      })
      .toBe('worker_offline');
    const t = await thread(ownerB);
    const res = await ownerB.req('POST', `/chat/threads/${t}/messages`, { text: 'anyone?' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('assistant_unavailable');
  });
});
