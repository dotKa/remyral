import { createServer, connect, type Server, type Socket } from 'node:net';
import { FakeAssistantEngine } from '@remyral/agent-adapters';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
/** Short for the test; production waits 45 s. */
const GRACE_MS = 5_000;

interface Message {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
  meta: Record<string, unknown> | null;
}

const turnsOf = (e: FakeAssistantEngine): number => e.sessions.reduce((n, s) => n + s.turns.length, 0);

/** A promise the test opens when it wants the scripted model to go on. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * A TCP relay in front of the master. `blackhole()` makes the current connections stale: nothing passes any more and
 * neither side sees a close (what a dropped NAT mapping or a dead path looks like) — the worker finds out by its ping,
 * the master only when the newer connection replaces the old one.
 */
async function relay(
  target: URL,
): Promise<{ url: string; blackhole: () => void; close: () => Promise<void> }> {
  const pairs: { a: Socket; b: Socket; dead: boolean }[] = [];
  const server: Server = createServer((a) => {
    const b = connect(Number(target.port), target.hostname);
    const pair = { a, b, dead: false };
    pairs.push(pair);
    a.on('data', (d) => {
      if (!pair.dead) b.write(d);
    });
    b.on('data', (d) => {
      if (!pair.dead) a.write(d);
    });
    a.on('close', () => {
      if (!pair.dead) b.destroy();
    });
    b.on('close', () => {
      if (!pair.dead) a.destroy();
    });
    a.on('error', () => undefined);
    b.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `${target.protocol}//127.0.0.1:${String(port)}`,
    blackhole: () => {
      for (const p of pairs) p.dead = true;
    },
    close: async () => {
      for (const p of pairs) {
        p.a.destroy();
        p.b.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/**
 * p17-chat-reconnect (docs/design/p17-chat-reconnect.md) with real workers on fake engines — "build-01" (primary) and
 * "mac-studio" (backup): a turn survives a reconnect of the same worker process within the grace and finishes with
 * every event exactly once; a worker that does not come back fails the turn after the grace; another process (a
 * restart) fails it at once; an older worker (no `assistant-resume-v1`) fails it at once; the p15-chat-failover rules
 * (re-run once on the next machine only when the turn did not act) are unchanged.
 */
describeIntegration('chat turns across a worker reconnect (integration)', { timeout: 180_000 }, () => {
  let h: Harness;
  let url: string;
  let owner: Client;
  let ownerSecret: string;
  const dirs: string[] = [];
  const claudeP = new FakeAssistantEngine('claude-code');
  const claudeB = new FakeAssistantEngine('claude-code');
  let workerP: RunningWorker | undefined;
  let workerB: RunningWorker | undefined;
  /** Workers whose transport was cut without a stop (cleaned up at the end). */
  const cut: RunningWorker[] = [];
  let dirP = '';
  let primary = '';
  let backup = '';
  let version = 1;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
  }

  async function messages(threadId: string): Promise<Message[]> {
    const res = await owner.req('GET', `/chat/threads/${threadId}`);
    expect(res.statusCode).toBe(200);
    return res.json<{ messages: Message[] }>().messages;
  }

  async function turnState(threadId: string): Promise<string | null> {
    const res = await owner.req('GET', `/chat/threads/${threadId}`);
    return res.json<{ turn: { state: string } | null }>().turn?.state ?? null;
  }

  async function idle(threadId: string): Promise<void> {
    await expect.poll(() => turnState(threadId), { timeout: 30_000 }).toBeNull();
  }

  async function newThread(): Promise<string> {
    const res = await owner.req('POST', '/chat/threads', {});
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function send(threadId: string, text: string): Promise<void> {
    const res = await owner.req('POST', `/chat/threads/${threadId}/messages`, { text });
    expect(res.statusCode, res.body).toBe(202);
  }

  async function answering(): Promise<string | null> {
    const res = await owner.req('GET', '/chat/status');
    return res.json<{ worker: { id: string } | null }>().worker?.id ?? null;
  }

  async function startP(opts: { resumeAware?: boolean } = {}): Promise<RunningWorker> {
    const before = h.clock.now();
    const w = await runRealWorker(url, dirP, {
      capabilities: CAPS,
      assistant: {
        engine: claudeP,
        clock: h.clock.now,
        ...(opts.resumeAware === undefined ? {} : { resumeAware: opts.resumeAware }),
      },
    });
    workerP = w;
    // The master has this connection (not the previous process's, whose end it may still be processing): else
    // primaryAnswers can see the old connection as answering and the new one starts its stability period later.
    await expect
      .poll(
        async () => {
          const { rows } = await h.db.pool.query<{ connected_at: Date | null }>(
            'SELECT connected_at FROM workers WHERE id = $1',
            [primary],
          );
          const at = rows[0]?.connected_at ?? null;
          return at !== null && at.getTime() >= before.getTime();
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    return w;
  }

  /** The primary answers again (connected, its capabilities in, past the 60 s stability period). */
  async function primaryAnswers(): Promise<void> {
    await expect
      .poll(
        async () => {
          h.clock.advance(61_000);
          await h.app.chat.sweep();
          return answering();
        },
        { timeout: 20_000 },
      )
      .toBe(primary);
  }

  /** A network drop the worker never recovers from: the socket closes, the process does not stop on purpose. */
  async function cutP(): Promise<void> {
    const w = workerP;
    if (w === undefined) throw new Error('no primary');
    workerP = undefined;
    cut.push(w);
    await w.transport.stop();
  }

  const errorsOf = (all: Message[]) => all.filter((m) => m.role === 'error' && m.meta?.notice === undefined);

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      chat: { reconnectGraceMs: GRACE_MS },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
  });

  afterAll(async () => {
    for (const w of cut) {
      await w.daemon.stop('test').catch(() => undefined);
      await w.assistant?.stop().catch(() => undefined);
    }
    await workerP?.stop().catch(() => undefined);
    await workerB?.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  it('build-01 answers the chat, mac-studio is its backup', async () => {
    await stepUp();
    dirP = await tempDataDir(dirs);
    primary = await pairRealWorker(h, url, owner, ownerSecret, dirP);
    await stepUp();
    const dirB = await tempDataDir(dirs);
    backup = await pairRealWorker(h, url, owner, ownerSecret, dirB);
    for (const [id, name] of [
      [primary, 'build-01'],
      [backup, 'mac-studio'],
    ] as const) {
      expect((await owner.req('PUT', `/workers/${id}/name`, { name })).statusCode).toBe(200);
    }
    await startP();
    workerB = await runRealWorker(url, dirB, {
      capabilities: CAPS,
      assistant: { engine: claudeB, clock: h.clock.now },
    });
    await stepUp();
    const res = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId: primary,
      runtime: 'claude-code',
      modelProfile: null,
      backupWorkerIds: [backup],
      expectedVersion: version,
    });
    expect(res.statusCode, res.body).toBe(200);
    version = res.json<{ version: number }>().version;
    await expect.poll(answering, { timeout: 15_000 }).toBe(primary);
  });

  it('a turn survives a reconnect of the same worker process and finishes with every event exactly once', async () => {
    const g = gate();
    claudeP.script(/^across the drop/, async ({ call }) => {
      await call('list_workers', {});
      await g.wait;
      await call('notify_me', { title: 'Queue', message: 'Three jobs wait.' });
      return 'Finished after the drop.';
    });
    const t = await newThread();
    const bTurns = turnsOf(claudeB);
    await send(t, 'across the drop');
    await expect
      .poll(async () => (await messages(t)).filter((m) => m.role === 'tool').length, { timeout: 15_000 })
      .toBe(1);
    const w = workerP;
    if (w === undefined) throw new Error('no primary');
    const sessions = w.transport.stats.sessions;
    w.transport.reconnect('test: connection drop');
    // The same process is back and the master continued the turn (ASSISTANT_RESUME).
    await expect.poll(() => w.transport.stats.sessions, { timeout: 15_000 }).toBe(sessions + 1);
    await expect
      .poll(() => w.lines.some((l) => l.msg === 'assistant turn resumed after a reconnect'), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(await turnState(t)).not.toBeNull();
    g.open();
    await expect
      .poll(async () => (await messages(t)).filter((m) => m.role === 'assistant').length, { timeout: 15_000 })
      .toBe(1);
    await idle(t);
    const all = await messages(t);
    expect(all.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([
      'Finished after the drop.',
    ]);
    expect(all.filter((m) => m.role === 'tool').map((m) => m.meta?.name)).toEqual([
      'list_workers',
      'notify_me',
    ]);
    expect(errorsOf(all)).toHaveLength(0);
    // Never re-run elsewhere; one turn, done, on the primary; the note sent once.
    expect(turnsOf(claudeB)).toBe(bTurns);
    const { rows } = await h.db.pool.query<{ worker_id: string; state: string; tool_calls: number }>(
      'SELECT worker_id, state, tool_calls FROM chat_turns WHERE thread_id = $1',
      [t],
    );
    expect(rows).toEqual([{ worker_id: primary, state: 'done', tool_calls: 2 }]);
    const notes = await h.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE kind = 'chat.note'",
    );
    expect(notes.rows[0]?.n).toBe(1);
  });

  it('a stale connection: the same process comes back first, the master replaces the old one — the turn continues', async () => {
    // The production case: the worker's ping times out on a dead path, it reconnects at once, and the master learns
    // of the old connection only when the new one replaces it ("newer connection replaces the existing one").
    await workerP?.stop();
    const r = await relay(new URL(url));
    try {
      const w = await runRealWorker(r.url, dirP, {
        capabilities: CAPS,
        assistant: { engine: claudeP, clock: h.clock.now },
        timing: { pingIntervalMs: 200, pongTimeoutMs: 300 },
      });
      workerP = w;
      await primaryAnswers();
      const g = gate();
      claudeP.script(/^stale path/, async ({ call }) => {
        await call('list_projects', {});
        await g.wait;
        return 'Answered over the new connection.';
      });
      const t = await newThread();
      const bTurns = turnsOf(claudeB);
      await send(t, 'stale path');
      await expect
        .poll(async () => (await messages(t)).filter((m) => m.role === 'tool').length, { timeout: 15_000 })
        .toBe(1);
      const sessions = w.transport.stats.sessions;
      r.blackhole();
      // Written into the dead path: lost on the wire, sent again after the resume.
      g.open();
      await expect.poll(() => w.transport.stats.sessions, { timeout: 15_000 }).toBe(sessions + 1);
      await expect
        .poll(async () => (await messages(t)).filter((m) => m.role === 'assistant').length, {
          timeout: 15_000,
        })
        .toBe(1);
      await idle(t);
      const all = await messages(t);
      expect(all.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([
        'Answered over the new connection.',
      ]);
      expect(all.filter((m) => m.role === 'tool')).toHaveLength(1);
      expect(errorsOf(all)).toHaveLength(0);
      expect(turnsOf(claudeB)).toBe(bTurns);
      // The worker said why: its ping went unanswered.
      const res = await owner.req('GET', `/workers/${primary}`);
      const d = res.json<{ disconnects: { cause: string; pongWaitMs?: number }[] }>().disconnects;
      expect(d[0]?.cause).toBe('pong_timeout');
      // At least the 300 ms pong timeout, measured with Date.now: its whole milliseconds against the timer's
      // monotonic clock can read one less (299 seen on a CI runner).
      expect(d[0]?.pongWaitMs).toBeGreaterThanOrEqual(299);
    } finally {
      await workerP?.stop().catch(() => undefined);
      workerP = undefined;
      await r.close();
    }
    await startP();
    await primaryAnswers();
  });

  it('a worker that does not come back fails the turn after the grace — it acted, so it is not re-run', async () => {
    const g = gate();
    claudeP.script(/^acted then lost/, async ({ call }) => {
      await call('notify_me', { title: 'Lost', message: 'about to drop' });
      await g.wait;
      return 'never';
    });
    const t = await newThread();
    const bTurns = turnsOf(claudeB);
    await send(t, 'acted then lost');
    await expect
      .poll(async () => (await messages(t)).some((m) => m.role === 'tool'), { timeout: 15_000 })
      .toBe(true);
    const dropped = Date.now();
    await cutP();
    // The quiet waiting state, no error yet.
    await expect.poll(() => turnState(t), { timeout: 5_000 }).toBe('reconnecting');
    expect(errorsOf(await messages(t))).toHaveLength(0);
    await expect.poll(async () => errorsOf(await messages(t)).length, { timeout: GRACE_MS + 10_000 }).toBe(1);
    expect(Date.now() - dropped).toBeGreaterThanOrEqual(GRACE_MS - 500);
    await idle(t);
    const error = errorsOf(await messages(t))[0];
    expect(error?.content).toContain('The assistant worker disconnected while answering.');
    expect(error?.content).toContain('It had already acted (1 tool call)');
    expect(turnsOf(claudeB)).toBe(bTurns);
    g.open();
  });

  it('another process of the worker (a restart) fails the held turn at once; not acted → re-run on the backup', async () => {
    await startP();
    await primaryAnswers();
    // Only build-01 holds the answer back (mac-studio answers a re-run at once).
    const g = gate();
    claudeP.script(/^restart me/, async () => {
      await g.wait;
      return 'too late';
    });
    const t = await newThread();
    const bTurns = turnsOf(claudeB);
    await send(t, 'restart me');
    await expect.poll(() => turnState(t), { timeout: 15_000 }).toBe('running');
    await cutP();
    await expect.poll(() => turnState(t), { timeout: 5_000 }).toBe('reconnecting');
    const restarted = Date.now();
    await startP(); // a new process: another instance id
    await expect.poll(async () => errorsOf(await messages(t)).length, { timeout: GRACE_MS - 1_000 }).toBe(1);
    expect(Date.now() - restarted).toBeLessThan(GRACE_MS);
    await expect
      .poll(async () => (await messages(t)).filter((m) => m.role === 'assistant').length, { timeout: 15_000 })
      .toBe(1);
    await idle(t);
    const all = await messages(t);
    expect(errorsOf(all)[0]?.content).toContain('Continuing on mac-studio');
    expect(turnsOf(claudeB)).toBe(bTurns + 1);
    const { rows } = await h.db.pool.query<{ worker_id: string; state: string }>(
      'SELECT worker_id, state FROM chat_turns WHERE thread_id = $1 ORDER BY created_at',
      [t],
    );
    expect(rows.map((r) => [r.worker_id, r.state])).toEqual([
      [primary, 'failed'],
      [backup, 'done'],
    ]);
    g.open();
  });

  it('an older worker (no assistant-resume-v1) fails the turn at once on a reconnect, as before', async () => {
    await workerP?.stop();
    await startP({ resumeAware: false });
    await primaryAnswers();
    const g = gate();
    claudeP.script(/^old worker/, async () => {
      await g.wait;
      return 'too late';
    });
    const t = await newThread();
    const bTurns = turnsOf(claudeB);
    await send(t, 'old worker');
    await expect.poll(() => turnState(t), { timeout: 15_000 }).toBe('running');
    const dropped = Date.now();
    workerP?.transport.reconnect('test: connection drop');
    await expect.poll(async () => errorsOf(await messages(t)).length, { timeout: GRACE_MS - 1_000 }).toBe(1);
    expect(Date.now() - dropped).toBeLessThan(GRACE_MS);
    await expect
      .poll(async () => (await messages(t)).filter((m) => m.role === 'assistant').length, { timeout: 15_000 })
      .toBe(1);
    expect(errorsOf(await messages(t))[0]?.content).toContain('Continuing on mac-studio');
    expect(turnsOf(claudeB)).toBe(bTurns + 1);
    g.open();
  });

  it('records the reason of each reconnect for the machine page', async () => {
    const res = await owner.req('GET', `/workers/${primary}`);
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json<{
      disconnects: { cause: string; code?: number; detail?: string; receivedAt: string }[];
    }>().disconnects;
    // The reconnect of the first test (the worker closed it itself), newest first, at most 10.
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d.length).toBeLessThanOrEqual(10);
    expect(d.some((x) => x.cause === 'worker_closed' && x.detail === 'test: connection drop')).toBe(true);
    expect(d.every((x) => !Number.isNaN(Date.parse(x.receivedAt)))).toBe(true);
  });
});
