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
const LIMIT = "You've hit your usage limit. Try again in 2 hours.";

interface Message {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
}

/**
 * p11-usage-limit-fallback, chat assistant: when the engine hits its usage limit the chat says so with the reset time,
 * the same user message is answered by the fallback engine (Settings → Chat), later turns go there directly until the
 * reset; without a fallback the chat says when it works again and refuses new turns with that text (the user's earlier
 * message is kept in the thread).
 */
describeIntegration('chat engine usage-limit fallback (integration)', { timeout: 120_000 }, () => {
  let h: Harness;
  let url: string;
  let owner: Client;
  let ownerSecret: string;
  const dirs: string[] = [];
  let worker: RunningWorker | undefined;
  let workerId = '';
  const claude = new FakeAssistantEngine('claude-code');
  const codex = new FakeAssistantEngine('codex');
  let version = 1;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
  }

  async function putSettings(body: Record<string, unknown>): Promise<void> {
    await stepUp();
    const res = await owner.req('PUT', '/chat/settings', {
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

  async function messages(threadId: string): Promise<Message[]> {
    const res = await owner.req('GET', `/chat/threads/${threadId}`);
    expect(res.statusCode).toBe(200);
    return res.json<{ messages: Message[] }>().messages;
  }

  async function idle(threadId: string): Promise<void> {
    await expect
      .poll(
        async () => (await owner.req('GET', `/chat/threads/${threadId}`)).json<{ turn: unknown }>().turn,
        {
          timeout: 20_000,
        },
      )
      .toBeNull();
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
  });

  afterAll(async () => {
    await worker?.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  it('a limited engine hands the same message to the fallback engine, which keeps answering until the reset', async () => {
    await stepUp();
    const dataDir = await tempDataDir(dirs);
    workerId = await pairRealWorker(h, url, owner, ownerSecret, dataDir);
    worker = await runRealWorker(url, dataDir, {
      capabilities: CAPS,
      assistant: { engine: claude, clock: h.clock.now, extraEngines: { codex } },
    });
    // The fallback must differ from the main engine.
    await stepUp();
    const same = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId,
      runtime: 'claude-code',
      modelProfile: null,
      fallbackRuntime: 'claude-code',
      expectedVersion: version,
    });
    expect(same.statusCode).toBe(400);
    await putSettings({ fallbackRuntime: 'codex' });
    const settings = (await owner.req('GET', '/chat/settings')).json<{ fallbackRuntime: string | null }>();
    expect(settings.fallbackRuntime).toBe('codex');
    await expect
      .poll(async () => (await owner.req('GET', '/chat/status')).json<{ available: boolean }>().available, {
        timeout: 15_000,
      })
      .toBe(true);

    claude.usageLimit = LIMIT;
    const thread = (await owner.req('POST', '/chat/threads', {})).json<{ id: string }>().id;
    const sent = await owner.req('POST', `/chat/threads/${thread}/messages`, {
      text: 'how many jobs failed today?',
    });
    expect(sent.statusCode, sent.body).toBe(202);
    // The error line, then the fallback engine's answer to the same message.
    await expect
      .poll(async () => (await messages(thread)).some((m) => m.role === 'assistant'), { timeout: 20_000 })
      .toBe(true);
    await idle(thread);
    const all = await messages(thread);
    expect(all.filter((m) => m.role === 'user')).toHaveLength(1);
    const error = all.find((m) => m.role === 'error');
    expect(error?.content).toContain('Claude Code reached its usage limit; it works again at');
    expect(error?.content).toContain('Continuing with Codex');
    const answer = all.find((m) => m.role === 'assistant');
    expect(answer?.content).toContain('Echo: how many jobs failed today?');
    expect(codex.sessions.at(-1)?.turns.at(-1)?.message).toBe('how many jobs failed today?');

    // The status says so; the next turn goes to Codex directly (Claude Code is not asked again).
    const status = (await owner.req('GET', '/chat/status')).json<{
      available: boolean;
      runtime: string;
      fallback: boolean;
      limit: { runtime: string; until: string } | null;
    }>();
    expect(status).toMatchObject({ available: true, runtime: 'codex', fallback: true });
    expect(status.limit?.runtime).toBe('claude-code');
    expect(Date.parse(status.limit?.until ?? '')).toBeGreaterThan(h.clock.now().getTime() + 3600_000);
    const claudeTurns = claude.sessions.reduce((n, s) => n + s.turns.length, 0);
    const again = await owner.req('POST', `/chat/threads/${thread}/messages`, { text: 'and yesterday?' });
    expect(again.statusCode).toBe(202);
    await expect
      .poll(async () => (await messages(thread)).filter((m) => m.role === 'assistant').length, {
        timeout: 20_000,
      })
      .toBe(2);
    expect(claude.sessions.reduce((n, s) => n + s.turns.length, 0)).toBe(claudeTurns);
    const audit = await h.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'chat.engine.fallback'",
    );
    expect(audit.rows[0]?.n).toBe(1);

    // After the reset the main engine answers again.
    claude.usageLimit = null;
    h.clock.advance(3 * 3600_000);
    // (The console session timed out over the three hours.)
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    const back = (await owner.req('GET', '/chat/status')).json<{ runtime: string; fallback: boolean }>();
    expect(back).toMatchObject({ runtime: 'claude-code', fallback: false });
  });

  it('without a fallback engine the chat says when it works again and keeps the message', async () => {
    await putSettings({ fallbackRuntime: null });
    claude.usageLimit = LIMIT;
    const thread = (await owner.req('POST', '/chat/threads', {})).json<{ id: string }>().id;
    const sent = await owner.req('POST', `/chat/threads/${thread}/messages`, { text: 'summarise the queue' });
    expect(sent.statusCode).toBe(202);
    await expect
      .poll(async () => (await messages(thread)).some((m) => m.role === 'error'), { timeout: 20_000 })
      .toBe(true);
    await idle(thread);
    const all = await messages(thread);
    expect(all.find((m) => m.role === 'user')?.content).toBe('summarise the queue');
    expect(all.find((m) => m.role === 'error')?.content).toContain('Your message is kept');
    const status = (await owner.req('GET', '/chat/status')).json<{
      available: boolean;
      code: string | null;
      message: string | null;
    }>();
    expect(status).toMatchObject({ available: false, code: 'engine_limited' });
    expect(status.message).toContain('works again at');
    const refused = await owner.req('POST', `/chat/threads/${thread}/messages`, { text: 'hello?' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string; message: string }>()).toMatchObject({
      error: 'assistant_usage_limited',
    });
    claude.usageLimit = null;
  });

  it('p15 item 2: "Otomatik" is the default fallback account; explicit choices and "Yok" are kept', async () => {
    const get = async () =>
      (await owner.req('GET', '/chat/settings')).json<{
        account: string | null;
        fallbackAccount: string | null;
      }>();
    // Migration 0121 moved the existing setting to "auto" (a fresh database too).
    expect((await get()).fallbackAccount).toBe('auto');
    await putSettings({ fallbackAccount: null });
    expect((await get()).fallbackAccount).toBeNull(); // "Yok" stays "Yok"
    await putSettings({ fallbackAccount: 'auto' });
    expect((await get()).fallbackAccount).toBe('auto');
    // "auto" is never a main account.
    await stepUp();
    const bad = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId,
      runtime: 'claude-code',
      modelProfile: null,
      account: 'auto',
      expectedVersion: version,
    });
    expect(bad.statusCode).toBe(400);
    // Another engine without a fallback-account choice starts at "Otomatik" again.
    await putSettings({ fallbackAccount: null });
    await putSettings({ runtime: 'codex', fallbackRuntime: null });
    expect((await get()).fallbackAccount).toBe('auto');
    // A machine without runtime accounts: "Otomatik" finds none and the chat is still available.
    await expect
      .poll(async () => (await owner.req('GET', '/chat/status')).json<{ available: boolean }>().available, {
        timeout: 15_000,
      })
      .toBe(true);
    await putSettings({ runtime: 'claude-code' });
  });
});
