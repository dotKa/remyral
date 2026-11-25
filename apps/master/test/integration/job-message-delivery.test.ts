import { randomUUID } from 'node:crypto';
import {
  approvalScript,
  FakeRuntimeAdapter,
  type FakeScript,
  type SessionResult,
} from '@remyral/agent-adapters';
import type { WorkerFeature } from '@remyral/protocol';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Cluster, PW } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin } from '../helpers/harness.js';
import { JOB_CAPS, jobSpec, PROJECT } from '../helpers/job-worker.js';

/**
 * p15-message-delivery (docs/design/p15-message-delivery.md): messages to a job's agent against a real master and real
 * worker daemons with the fake runtime, one case per agent situation — mid-turn (steer), Claude-like turn boundary,
 * paused for an approval, the run ended while the job is still RUNNING, the job already ended, the job not started
 * yet (held by the master), a runtime that refuses, an older worker without receipts, duplicates (retried POST,
 * replayed outbox) and a reconnect.
 */

interface Msg {
  id: string;
  text: string;
  status: string;
  code: string | null;
  detail: string | null;
  receipts: boolean;
  source: string;
  sentByName: string | null;
}

const RECEIPTS: readonly WorkerFeature[] = ['job-message-v1', 'job-message-receipts-v1'];
const CAPS = (features: readonly WorkerFeature[] = RECEIPTS) => ({ ...JOB_CAPS, features: [...features] });

/** Runs ~60 s (until cancelled), with agent output every 200 ms. */
const busy: FakeScript = () =>
  Array.from({ length: 300 }, (_, i) => [
    { kind: 'emit', event: { kind: 'message', role: 'assistant', text: `working ${String(i)}` } } as const,
    { kind: 'sleep', ms: 200 } as const,
  ]).flat();

describeIntegration('job message delivery (integration, p15-message-delivery)', { timeout: 150_000 }, () => {
  const c = new Cluster();
  let operator: Client;
  let viewer: Client;

  const send = (id: string, text: string, extra: Record<string, unknown> = {}, who: Client = operator) =>
    who.req('POST', `/jobs/${id}/messages`, { text, ...extra });
  const list = async (id: string, who: Client = operator) => {
    const res = await who.req('GET', `/jobs/${id}/messages`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ messages: Msg[] }>().messages;
  };
  const statusOf = async (id: string, messageId: string) =>
    (await list(id)).find((m) => m.id === messageId)?.status;
  const userTexts = async (id: string) => {
    const { rows } = await c.h.db.pool.query<{ text: string }>(
      `SELECT payload->>'text' AS text FROM job_events
        WHERE job_id = $1 AND kind = 'message' AND payload->>'role' = 'user' ORDER BY stream_seq`,
      [id],
    );
    return rows.map((r) => r.text);
  };
  const running = (id: string) => expect.poll(() => c.state(id), { timeout: 45_000 }).toBe('RUNNING');
  const sendOk = async (id: string, text: string, extra: Record<string, unknown> = {}) => {
    const res = await send(id, text, extra);
    expect(res.statusCode, res.body).toBe(202);
    return res.json<{ messageId: string; status: string }>();
  };

  beforeAll(async () => {
    await c.start(12);
    const op = await c.h.createUser('msgop', PW, 'operator');
    await c.h.grant(op, [PROJECT], 'operator');
    operator = await fullLogin(c.h, 'msgop', PW, (await enroll(c.h, 'msgop', PW)).secret);
    const vw = await c.h.createUser('msgview', PW, 'viewer');
    await c.h.grant(vw, [PROJECT], 'viewer');
    viewer = await fullLogin(c.h, 'msgview', PW, (await enroll(c.h, 'msgview', PW)).secret);
  });
  afterEach(async () => {
    await c.cancelAll();
    await c.stopWorkers();
  });
  afterAll(async () => {
    await c.stop();
  });

  it('mid-turn (steering runtime): sent → received → delivered → read, once, visible to viewers', async () => {
    await c.newWorker({ capabilities: CAPS(), fake: { script: busy } });
    const id = await c.submit(jobSpec());
    await running(id);
    await expect.poll(async () => (await userTexts(id)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const status = await operator.req('GET', `/jobs/${id}/messages/status`);
    expect(status.json()).toMatchObject({ supported: true, mode: 'live' });
    const out = await sendOk(id, 'also run the linter');
    expect(out.status).toBe('sent');
    await expect.poll(() => statusOf(id, out.messageId), { timeout: 15_000 }).toBe('read');
    expect((await userTexts(id)).filter((t) => t === 'also run the linter')).toHaveLength(1);
    // Viewers read the list (no sending).
    expect((await list(id, viewer)).map((m) => m.status)).toEqual(['read']);
    expect((await send(id, 'x', {}, viewer)).statusCode).toBe(403);
    expect((await list(id))[0]).toMatchObject({ source: 'panel', sentByName: 'msgop', receipts: true });
  });

  it('Claude-like turn boundary: delivered while the agent is busy, read when the next turn takes it', async () => {
    const script: FakeScript = (_p, turn) =>
      turn === 1
        ? [
            { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'long tool call' } },
            { kind: 'sleep', ms: 2_500 },
          ]
        : [{ kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'took the follow-up' } }];
    await c.newWorker({ capabilities: CAPS(), fake: { script, followUps: 'next-turn' } });
    const id = await c.submit(jobSpec());
    await running(id);
    const out = await sendOk(id, 'after this, write tests');
    await expect.poll(() => statusOf(id, out.messageId), { timeout: 10_000 }).toBe('delivered');
    await expect.poll(() => statusOf(id, out.messageId), { timeout: 15_000 }).toBe('read');
    await expect.poll(() => c.state(id), { timeout: 30_000 }).toBe('SUCCEEDED');
  });

  it('paused for an approval: the message is delivered while it waits, read once the agent continues', async () => {
    await c.newWorker({ capabilities: CAPS(), fake: { script: approvalScript } });
    const id = await c.submit(jobSpec());
    const pending = async () =>
      (
        await c.h.db.pool.query<{ id: string }>(
          "SELECT id FROM approval_requests WHERE job_id = $1 AND status = 'pending'",
          [id],
        )
      ).rows[0]?.id ?? null;
    await expect.poll(pending, { timeout: 45_000 }).not.toBeNull();
    const out = await sendOk(id, 'push to the staging remote');
    // Accepted by the runtime while the agent waits for the decision; read once it continues.
    await expect.poll(() => statusOf(id, out.messageId), { timeout: 15_000 }).toBe('delivered');
    const requestId = await pending();
    await c.stepUp();
    const decided = await c.admin.req('POST', `/approvals/${requestId ?? ''}/approve`, {});
    expect(decided.statusCode, decided.body).toBe(200);
    await expect
      .poll(async () => JSON.stringify((await list(id))[0]), { timeout: 20_000 })
      .toContain(`"status":"read"`);
    await expect.poll(() => c.state(id), { timeout: 30_000 }).toBe('SUCCEEDED');
  });

  it('the run ended while the job is still RUNNING: failed run_ended with the reason, never "sent" forever', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let collecting = false;
    class SlowResult extends FakeRuntimeAdapter {
      override async collectResult(
        ref: Parameters<FakeRuntimeAdapter['collectResult']>[0],
      ): Promise<SessionResult> {
        collecting = true; // the session has stopped; the worker still reports the job RUNNING
        await gate;
        return super.collectResult(ref);
      }
    }
    const adapter = new SlowResult({
      runtime: 'codex',
      script: () => [{ kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'all done' } }],
    });
    try {
      await c.newWorker({ capabilities: CAPS(), adapter });
      const id = await c.submit(jobSpec());
      await expect.poll(() => collecting, { timeout: 45_000 }).toBe(true);
      expect(['STARTING', 'RUNNING']).toContain(await c.state(id));
      const out = await sendOk(id, 'one more thing');
      await expect.poll(() => statusOf(id, out.messageId), { timeout: 15_000 }).toBe('failed');
      expect((await list(id))[0]).toMatchObject({ code: 'run_ended' });
      expect(await userTexts(id)).not.toContain('one more thing');
      release();
      await expect.poll(() => c.state(id), { timeout: 30_000 }).toBe('SUCCEEDED');
    } finally {
      release();
    }
  });

  it('the job already ended: 409 with a clear reason', async () => {
    await c.newWorker({ capabilities: CAPS() });
    const id = await c.submit(jobSpec());
    await expect.poll(() => c.state(id), { timeout: 45_000 }).toBe('SUCCEEDED');
    const res = await send(id, 'too late');
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('finished this run');
    expect((await operator.req('GET', `/jobs/${id}/messages/status`)).json()).toMatchObject({
      supported: false,
      mode: null,
    });
  });

  it('not started yet: held by the master (waiting), sent once the agent runs, after the job prompt', async () => {
    const id = await c.submit(jobSpec());
    expect((await operator.req('GET', `/jobs/${id}/messages/status`)).json()).toMatchObject({
      supported: true,
      mode: 'queue',
    });
    const out = await sendOk(id, 'start with the README');
    expect(out.status).toBe('waiting');
    await c.newWorker({ capabilities: CAPS(), fake: { script: busy } });
    await expect.poll(() => statusOf(id, out.messageId), { timeout: 45_000 }).toBe('read');
    await expect.poll(() => userTexts(id), { timeout: 15_000 }).toContain('start with the README');
    // The job prompt went first.
    expect((await userTexts(id)).indexOf('start with the README')).toBeGreaterThan(0);
  });

  it('a runtime that refuses: failed runtime_refused with its reason; the run goes on', async () => {
    await c.newWorker({
      capabilities: CAPS(),
      fake: { script: busy, refuseFollowUps: 'steering is disabled' },
    });
    const id = await c.submit(jobSpec());
    await running(id);
    const out = await sendOk(id, 'hello?');
    await expect.poll(() => statusOf(id, out.messageId), { timeout: 15_000 }).toBe('failed');
    expect((await list(id))[0]).toMatchObject({ code: 'runtime_refused', detail: 'steering is disabled' });
    expect(await c.state(id)).toBe('RUNNING');
  });

  it('an older worker (no receipts): received after the ACK, never claims more', async () => {
    await c.newWorker({ capabilities: CAPS(['job-message-v1']), fake: { script: busy } });
    const id = await c.submit(jobSpec());
    await running(id);
    const out = await sendOk(id, 'old worker message');
    await expect.poll(() => statusOf(id, out.messageId), { timeout: 15_000 }).toBe('received');
    await expect.poll(async () => userTexts(id), { timeout: 15_000 }).toContain('old worker message');
    expect((await list(id))[0]).toMatchObject({ receipts: false, status: 'received' });
  });

  it('no duplicates: a retried POST (same clientId), a replayed outbox copy and a reconnect reach the agent once', async () => {
    const { w } = await c.newWorker({ capabilities: CAPS(), fake: { script: busy } });
    const id = await c.submit(jobSpec());
    await running(id);
    const clientId = randomUUID();
    const a = await sendOk(id, 'exactly once', { clientId });
    const b = await sendOk(id, 'exactly once', { clientId });
    expect(b.messageId).toBe(a.messageId);
    w.transport.reconnect('test: connection drop');
    await expect.poll(() => statusOf(id, a.messageId), { timeout: 20_000 }).toBe('read');
    // At-least-once: the same JOB_MESSAGE again (as after a standby restore) is dropped by the worker.
    const { rows } = await c.h.db.pool.query<{ attempt_id: string; epoch: number; worker_id: string }>(
      'SELECT attempt_id::text, epoch, worker_id FROM job_messages WHERE id = $1',
      [a.messageId],
    );
    const r = rows[0];
    if (r === undefined) throw new Error('no row');
    await c.h.app.fleetSessions.replay.enqueue(
      r.worker_id,
      'JOB_MESSAGE',
      {
        attemptId: r.attempt_id,
        epoch: r.epoch,
        messageId: a.messageId,
        text: 'exactly once',
        sentBy: 'u',
        receipts: true,
      },
      { jobId: id },
    );
    await new Promise((res) => setTimeout(res, 1_000));
    expect((await userTexts(id)).filter((t) => t === 'exactly once')).toHaveLength(1);
    expect(await list(id)).toHaveLength(1);
    expect(await statusOf(id, a.messageId)).toBe('read');
  });
});
