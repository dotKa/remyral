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
  meta: Record<string, unknown> | null;
}

interface Status {
  available: boolean;
  code: string | null;
  message: string | null;
  worker: { id: string; name: string; online: boolean } | null;
  primary: { id: string; name: string; online: boolean } | null;
  runtime: string;
  routing: {
    machine: 'primary' | 'backup' | null;
    reason: string | null;
    pinned: boolean;
    auto: boolean;
    primaryIssue: { code: string; message: string } | null;
    returnsAt: string | null;
    backups: number;
  } | null;
}

interface FailoverView {
  auto: boolean;
  pin: { workerId: string; until: string } | null;
  active: { workerId: string; reason: string | null } | null;
  chain: {
    workerId: string;
    role: string;
    eligible: boolean;
    issue: string | null;
    answering: boolean;
    connectedAt: string | null;
  }[];
  events: {
    kind: string;
    from: { name: string } | null;
    to: { name: string } | null;
    actor: string | null;
  }[];
}

const turnsOf = (e: FakeAssistantEngine): number => e.sessions.reduce((n, s) => n + s.turns.length, 0);

/**
 * p15-chat-failover (docs/design/p15-chat-failover.md): backup machines for the chat assistant with two real workers on
 * fake engines — "build-01" (primary) and "mac-studio" (backup). Primary offline → the backup answers with a thread
 * notice and one notification; the primary back → the backup until it has been connected for 60 s, then the primary
 * (one "back" notification); a machine lost while answering → the turn re-runs once on the next machine, never after
 * the turn acted; pin / force back / automatic failover off (audited); a usage limit on the primary with no fallback
 * engine → the backup answers.
 */
describeIntegration('chat assistant failover to backup machines (integration)', { timeout: 180_000 }, () => {
  let h: Harness;
  let url: string;
  let owner: Client;
  let ownerSecret: string;
  const dirs: string[] = [];
  const claudeP = new FakeAssistantEngine('claude-code');
  const claudeB = new FakeAssistantEngine('claude-code');
  let workerP: RunningWorker | undefined;
  let workerB: RunningWorker | undefined;
  let dirP = '';
  let dirB = '';
  let primary = '';
  let backup = '';
  let version = 1;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
  }

  async function putSettings(body: Record<string, unknown>, expected = 200) {
    await stepUp();
    const res = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId: primary,
      runtime: 'claude-code',
      modelProfile: null,
      expectedVersion: version,
      ...body,
    });
    expect(res.statusCode, res.body).toBe(expected);
    if (expected === 200) version = res.json<{ version: number }>().version;
    return res;
  }

  async function status(): Promise<Status> {
    const res = await owner.req('GET', '/chat/status');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Status>();
  }

  async function failover(): Promise<FailoverView> {
    const res = await owner.req('GET', '/chat/failover');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<FailoverView>();
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
        { timeout: 30_000 },
      )
      .toBeNull();
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

  async function answers(threadId: string, n: number): Promise<Message[]> {
    await expect
      .poll(async () => (await messages(threadId)).filter((m) => m.role === 'assistant').length, {
        timeout: 30_000,
      })
      .toBe(n);
    await idle(threadId);
    return messages(threadId);
  }

  const notices = (all: Message[]) => all.filter((m) => m.meta?.notice === 'chat-failover');

  async function failoverNotes(): Promise<{ title: string; severity: string }[]> {
    await h.app.notifications.consumeOutbox();
    const { rows } = await h.db.pool.query<{ title: string; severity: string }>(
      "SELECT DISTINCT title, severity, created_at FROM notifications WHERE kind = 'chat.failover' ORDER BY created_at",
    );
    return rows;
  }

  async function startP(): Promise<void> {
    workerP = await runRealWorker(url, dirP, {
      capabilities: CAPS,
      assistant: { engine: claudeP, clock: h.clock.now },
    });
  }

  /** The primary is back and its connection time recorded (the session is listed a moment before). */
  async function primaryBack(): Promise<void> {
    await expect
      .poll(async () => (await failover()).chain[0]?.connectedAt ?? null, { timeout: 15_000 })
      .not.toBeNull();
  }

  async function startB(): Promise<void> {
    workerB = await runRealWorker(url, dirB, {
      capabilities: CAPS,
      assistant: { engine: claudeB, clock: h.clock.now },
    });
  }

  async function rename(id: string, name: string): Promise<void> {
    const res = await owner.req('PUT', `/workers/${id}/name`, { name });
    expect(res.statusCode, res.body).toBe(200);
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
    await workerP?.stop().catch(() => undefined);
    await workerB?.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  it('keeps an ordered backup list with the same save rules and shows each machine’s readiness', async () => {
    await stepUp();
    dirP = await tempDataDir(dirs);
    primary = await pairRealWorker(h, url, owner, ownerSecret, dirP);
    await stepUp();
    dirB = await tempDataDir(dirs);
    backup = await pairRealWorker(h, url, owner, ownerSecret, dirB);
    await rename(primary, 'build-01');
    await rename(backup, 'mac-studio');
    await startP();
    await startB();

    // The primary is never also a backup; no duplicates; only approved workers.
    expect((await putSettings({ backupWorkerIds: [primary] }, 400)).json()).toMatchObject({
      error: 'backup_is_primary',
    });
    expect((await putSettings({ backupWorkerIds: [backup, backup] }, 400)).json()).toMatchObject({
      error: 'backup_duplicate',
    });
    expect((await putSettings({ backupWorkerIds: ['w_nope'] }, 400)).json()).toMatchObject({
      error: 'worker_not_found',
    });
    // Step-up as for every chat settings change.
    h.clock.advance(11 * 60_000);
    const noCode = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId: primary,
      runtime: 'claude-code',
      modelProfile: null,
      backupWorkerIds: [backup],
      expectedVersion: version,
    });
    expect(noCode.statusCode).toBe(403);
    await putSettings({ backupWorkerIds: [backup] });
    const settings = (await owner.req('GET', '/chat/settings')).json<{
      backupWorkerIds: string[];
      engines: {
        workerId: string;
        online: boolean;
        assistantFeature: boolean;
        workerVersion: string | null;
      }[];
    }>();
    expect(settings.backupWorkerIds).toEqual([backup]);
    expect(settings.engines.find((e) => e.workerId === backup)).toMatchObject({
      online: true,
      assistantFeature: true,
      workerVersion: '0.1.0-test',
    });
    // A save without the list keeps it (the classic page).
    await putSettings({});
    expect(
      (await owner.req('GET', '/chat/settings')).json<{ backupWorkerIds: string[] }>().backupWorkerIds,
    ).toEqual([backup]);
    await expect.poll(async () => (await status()).available, { timeout: 15_000 }).toBe(true);
    const s = await status();
    expect(s).toMatchObject({
      worker: { id: primary, name: 'build-01' },
      primary: { id: primary },
      routing: { machine: 'primary', reason: 'primary', auto: true, backups: 1 },
    });
    const view = await failover();
    expect(view.chain.map((c) => [c.workerId, c.role, c.eligible, c.answering])).toEqual([
      [primary, 'primary', true, true],
      [backup, 'backup', true, false],
    ]);
    // The first choice of the primary is recorded silently.
    await h.app.chat.sweep();
    expect((await failover()).active?.workerId).toBe(primary);
    expect((await failover()).events).toHaveLength(0);
  });

  it('primary offline → the backup answers, the thread says so once, one notification', async () => {
    await workerP?.stop();
    workerP = undefined;
    await expect.poll(async () => (await status()).worker?.id, { timeout: 15_000 }).toBe(backup);
    const s = await status();
    expect(s).toMatchObject({
      available: true,
      worker: { name: 'mac-studio' },
      primary: { id: primary, online: false },
      routing: { machine: 'backup', reason: 'primary_offline', primaryIssue: { code: 'offline' } },
    });
    const t = await newThread();
    await send(t, 'which jobs failed?');
    const all = await answers(t, 1);
    expect(claudeB.sessions.at(-1)?.turns.at(-1)?.message).toBe('which jobs failed?');
    const n = notices(all);
    expect(n).toHaveLength(1);
    expect(n[0]?.meta).toMatchObject({ cause: 'primary_offline', from: 'build-01', to: 'mac-studio' });
    expect(n[0]?.content).toBe('build-01 is not connected; the answer comes from mac-studio.');
    // The notice is not model history: the second turn answers without another notice.
    await send(t, 'and yesterday?');
    expect(notices(await answers(t, 2))).toHaveLength(1);
    const view = await failover();
    expect(view.active?.workerId).toBe(backup);
    expect(view.events.map((e) => [e.kind, e.to?.name])).toEqual([['failover', 'mac-studio']]);
    const notes = await failoverNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.title).toBe('Chat assistant moved to mac-studio');
    // Another sweep changes nothing (no notification per turn or per sweep).
    await h.app.chat.sweep();
    expect(await failoverNotes()).toHaveLength(1);
  });

  it('primary back → the backup keeps answering until it has been connected for 60 s, then the primary', async () => {
    await startP();
    await primaryBack();
    const s = await status();
    expect(s).toMatchObject({
      worker: { id: backup },
      routing: { machine: 'backup', reason: 'primary_unstable' },
    });
    expect(Date.parse(s.routing?.returnsAt ?? '')).toBeGreaterThan(h.clock.now().getTime());
    const t = await newThread();
    const pTurns = turnsOf(claudeP);
    await send(t, 'still there?');
    await answers(t, 1);
    expect(turnsOf(claudeP)).toBe(pTurns);
    await h.app.chat.sweep();
    expect((await failover()).active?.workerId).toBe(backup);

    h.clock.advance(61_000);
    expect(await status()).toMatchObject({ worker: { id: primary }, routing: { reason: 'primary' } });
    // The sweep records the return (and notifies) while nobody chats.
    await h.app.chat.sweep();
    const view = await failover();
    expect(view.active?.workerId).toBe(primary);
    expect(view.events[0]).toMatchObject({
      kind: 'return',
      from: { name: 'mac-studio' },
      to: { name: 'build-01' },
    });
    const notes = await failoverNotes();
    expect(notes.map((x) => x.title)).toEqual([
      'Chat assistant moved to mac-studio',
      'Chat assistant is back on build-01',
    ]);
    // The thread that was answered from the backup hears that the primary answers again.
    await send(t, 'and now?');
    const all = await answers(t, 2);
    expect(turnsOf(claudeP)).toBe(pTurns + 1);
    expect(notices(all).at(-1)?.meta).toMatchObject({ cause: 'returned', to: 'build-01' });
  });

  it('a machine lost while answering → the turn re-runs once on the next machine', async () => {
    const t = await newThread();
    await send(t, 'summarise the queue [[slow 3000]]');
    await expect
      .poll(
        async () =>
          (await owner.req('GET', `/chat/threads/${t}`)).json<{ turn: { state: string } | null }>().turn
            ?.state,
        { timeout: 15_000 },
      )
      .toBe('running');
    const bTurns = turnsOf(claudeB);
    await workerP?.stop();
    workerP = undefined;
    const all = await answers(t, 1);
    expect(turnsOf(claudeB)).toBe(bTurns + 1);
    expect(claudeB.sessions.at(-1)?.turns.at(-1)?.message).toBe('summarise the queue [[slow 3000]]');
    const error = all.find((m) => m.role === 'error' && m.meta?.notice === undefined);
    expect(error?.content).toContain('The assistant worker disconnected while answering.');
    expect(error?.content).toContain('Continuing on mac-studio');
    expect(notices(all).at(-1)?.meta).toMatchObject({ cause: 'rerun', from: 'build-01', to: 'mac-studio' });
    expect(notices(all).at(-1)?.content).toBe(
      'build-01 was lost while answering; the answer comes from mac-studio.',
    );
    expect(all.filter((m) => m.role === 'user')).toHaveLength(1);
    const { rows } = await h.db.pool.query<{
      id: string;
      worker_id: string;
      state: string;
      rerun_of: string | null;
    }>(
      'SELECT id::text AS id, worker_id, state, rerun_of::text AS rerun_of FROM chat_turns WHERE thread_id = $1 ORDER BY created_at',
      [t],
    );
    expect(rows.map((r) => [r.worker_id, r.state])).toEqual([
      [primary, 'failed'],
      [backup, 'done'],
    ]);
    expect(rows[1]?.rerun_of).toBe(rows[0]?.id);
    const view = await failover();
    // The re-run, then the switch it caused.
    expect(view.events.slice(0, 2).map((e) => e.kind)).toEqual(['failover', 'rerun']);
    expect(view.events[1]).toMatchObject({
      kind: 'rerun',
      from: { name: 'build-01' },
      to: { name: 'mac-studio' },
    });
    const audit = await h.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'chat.failover.rerun'",
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('a turn that already acted is not replayed on another machine', async () => {
    await startP();
    await primaryBack();
    // mac-studio answers (the chat failed over to it); its model sends a note, then the machine disappears.
    expect((await status()).worker?.id).toBe(backup);
    claudeB.script(/^note and wait/, async ({ call }) => {
      await call('notify_me', { title: 'Queue', message: 'Three jobs wait.' });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return 'Sent you a note.';
    });
    const t = await newThread();
    const pTurns = turnsOf(claudeP);
    await send(t, 'note and wait');
    await expect
      .poll(async () => (await messages(t)).some((m) => m.role === 'tool'), { timeout: 15_000 })
      .toBe(true);
    await workerB?.stop();
    workerB = undefined;
    await expect
      .poll(async () => (await messages(t)).some((m) => m.role === 'error'), { timeout: 15_000 })
      .toBe(true);
    await idle(t);
    const all = await messages(t);
    expect(turnsOf(claudeP)).toBe(pTurns);
    expect(all.filter((m) => m.role === 'assistant')).toHaveLength(0);
    const error = all.find((m) => m.role === 'error' && m.meta?.notice === undefined);
    expect(error?.content).toContain('It had already acted (1 tool call)');
    expect(error?.content).toContain('not repeated automatically');
    // One note only.
    const notes = await h.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE kind = 'chat.note'",
    );
    expect(notes.rows[0]?.n).toBe(1);
    await startB();
    await expect
      .poll(async () => (await failover()).chain.every((c) => c.eligible), { timeout: 15_000 })
      .toBe(true);
  });

  it('pin, force back to primary and automatic failover off are audited controls', async () => {
    // Step-up is required for every control.
    h.clock.advance(11 * 60_000);
    expect((await owner.req('PUT', '/chat/failover/pin', { workerId: backup, minutes: 30 })).statusCode).toBe(
      403,
    );
    await stepUp();
    expect(
      (await owner.req('PUT', '/chat/failover/pin', { workerId: 'w_other', minutes: 30 })).json(),
    ).toMatchObject({ error: 'failover_pin_machine' });
    const pinned = await owner.req('PUT', '/chat/failover/pin', { workerId: backup, minutes: 30 });
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json<FailoverView>().pin?.workerId).toBe(backup);
    expect(await status()).toMatchObject({
      worker: { id: backup },
      routing: { reason: 'pinned', pinned: true },
    });
    const t = await newThread();
    await send(t, 'who answers?');
    const all = await answers(t, 1);
    expect(notices(all)[0]?.meta).toMatchObject({ cause: 'pinned', to: 'mac-studio' });

    // Force back to the primary: the pin goes, the primary answers at once.
    await stepUp();
    const forced = await owner.req('POST', '/chat/failover/primary', {});
    expect(forced.statusCode, forced.body).toBe(200);
    const fv = forced.json<FailoverView>();
    expect(fv.pin).toBeNull();
    expect(fv.active?.workerId).toBe(primary);
    expect(await status()).toMatchObject({ worker: { id: primary }, routing: { reason: 'primary' } });

    // Automatic failover off: with the primary gone nobody answers, and the status says why.
    await stepUp();
    expect((await owner.req('PUT', '/chat/failover/auto', { enabled: false })).statusCode).toBe(200);
    await workerP?.stop();
    workerP = undefined;
    await expect.poll(async () => (await status()).available, { timeout: 15_000 }).toBe(false);
    const off = await status();
    expect(off).toMatchObject({ code: 'worker_offline', routing: { auto: false } });
    expect(off.message).toContain('Automatic failover to the backup machines is off');
    // Force back refuses while the primary cannot answer.
    await stepUp();
    const refused = await owner.req('POST', '/chat/failover/primary', {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'primary_unavailable' });
    await stepUp();
    expect((await owner.req('PUT', '/chat/failover/auto', { enabled: true })).statusCode).toBe(200);
    expect(await status()).toMatchObject({ available: true, worker: { id: backup } });
    const actions = await h.db.pool.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action LIKE 'chat.failover.%' AND actor_type = 'user' ORDER BY id",
    );
    expect(actions.rows.map((r) => r.action)).toEqual([
      'chat.failover.pin',
      'chat.failover.force_primary',
      'chat.failover.auto',
      'chat.failover.auto',
    ]);
    expect((await failover()).events.slice(0, 4).map((e) => [e.kind, e.actor])).toEqual([
      ['auto_on', 'owner1'],
      ['auto_off', 'owner1'],
      ['force_primary', 'owner1'],
      ['pin', 'owner1'],
    ]);
  });

  it('a usage limit on the primary without a fallback engine → the backup answers the same message', async () => {
    await startP();
    await primaryBack();
    h.clock.advance(61_000);
    await expect.poll(async () => (await status()).worker?.id, { timeout: 15_000 }).toBe(primary);
    await h.app.chat.sweep();
    claudeP.usageLimit = LIMIT;
    const t = await newThread();
    await send(t, 'how busy is the fleet?');
    const all = await answers(t, 1);
    expect(claudeB.sessions.at(-1)?.turns.at(-1)?.message).toBe('how busy is the fleet?');
    const error = all.find((m) => m.role === 'error' && m.meta?.notice === undefined);
    expect(error?.content).toContain('Claude Code reached its usage limit');
    expect(error?.content).toContain('Continuing on mac-studio');
    expect(notices(all).at(-1)?.meta).toMatchObject({ cause: 'primary_unavailable', to: 'mac-studio' });
    expect(await status()).toMatchObject({
      worker: { id: backup },
      routing: { reason: 'primary_unavailable', primaryIssue: { code: 'engine_limited' } },
    });
    claudeP.usageLimit = null;
  });

  it('the assistant can say which machine answers the chat', async () => {
    const t = await newThread();
    await send(t, 'sohbet hangi makinede? [[tool list_workers]]');
    const all = await answers(t, 1);
    const answer = all.find((m) => m.role === 'assistant')?.content ?? '';
    expect(answer).toContain('chatAssistant');
    expect(answer).toMatch(/"answeringMachine":\s*"mac-studio"/);
    expect(answer).toMatch(/"primaryMachine":\s*"build-01"/);
  });
});
