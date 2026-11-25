import { randomUUID } from 'node:crypto';
import type { SequencedDraft } from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker } from '../helpers/raw-worker.js';
import { pairRealWorker, removeDirs, runRealWorker, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';

function event(i: number): SequencedDraft {
  return {
    type: 'EVENT',
    correlationId: `evt-${String(i)}`,
    jobId: 'job_replay',
    payload: {
      attemptId: 'att_1',
      epoch: 1,
      event: { kind: 'message', role: 'assistant', text: `message ${String(i)}` },
    },
  } as SequencedDraft;
}

/** p2-replay: resume cursors both ways, durable outboxes, dedupe and ordering. */
describeIntegration('worker replay and deduplication (integration)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
  });
  afterAll(async () => {
    await h.stop();
    await removeDirs(dirs);
  });

  async function inbox(workerId: string): Promise<{ seq: number; text: string }[]> {
    const { rows } = await h.db.pool.query<{ s: string; text: string }>(
      `SELECT seq::text AS s, payload->'event'->>'text' AS text FROM worker_inbox WHERE worker_id = $1 ORDER BY worker_inbox.seq`,
      [workerId],
    );
    return rows.map((r) => ({ seq: Number(r.s), text: r.text }));
  }

  async function cursors(workerId: string) {
    const { rows } = await h.db.pool.query<{ last: string; next: string; acked: string; outbox: string }>(
      `SELECT last_worker_seq::text AS last, next_master_seq::text AS next, acked_master_seq::text AS acked,
              (SELECT count(*) FROM worker_outbox o WHERE o.worker_id = w.id)::text AS outbox
         FROM workers w WHERE id = $1`,
      [workerId],
    );
    const r = rows[0];
    return {
      last: Number(r?.last),
      next: Number(r?.next),
      acked: Number(r?.acked),
      outbox: Number(r?.outbox),
    };
  }

  /** Pairs a raw client through the waiting-socket approval; returns its session socket. */
  async function rawPaired(code: string): Promise<{ w: RawWorker; id: string }> {
    const w = await RawWorker.connect(url);
    const pending = await w.handshake({ pairingCode: code });
    const id = pending.workerId ?? '';
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    expect((await admin.req('POST', `/workers/${id}/approve`, { pairingCode: code })).statusCode).toBe(200);
    await w.next('SESSION_ESTABLISHED');
    return { w, id };
  }

  function rawEvent(w: RawWorker, id: string, seq: number, messageId = randomUUID()) {
    return {
      ...w.envelope(
        'EVENT',
        {
          attemptId: 'att_1',
          epoch: 1,
          event: { kind: 'message', role: 'assistant', text: `raw ${String(seq)}` },
        },
        { workerId: id, jobId: 'job_raw', seq },
      ),
      messageId,
    };
  }

  it('delivers a burst exactly once across a dropped connection and drains the worker outbox', async () => {
    const dataDir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dataDir);
    const worker = await runRealWorker(url, dataDir);
    try {
      await expect.poll(() => worker.transport.established).toBe(true);
      const sent: Promise<number>[] = [];
      for (let i = 1; i <= 60; i++) {
        sent.push(worker.daemon.sendSequenced(event(i)));
        // Kill the socket mid-stream: 1–25 may be in flight, 26–60 are produced while it is down (or the
        // worker is reconnecting). Awaited, so the drop really happens mid-burst on a slow machine too —
        // fire-and-forget let a descheduled master deliver the whole burst before dropping anything.
        if (i === 25) await h.app.workerHub.disconnect(id, 1012, 'mid-stream drop');
      }
      expect(await Promise.all(sent)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
      // State, not time: the worker reconnected (second session) and everything arrived exactly once.
      await expect.poll(() => worker.transport.stats.sessions, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
      await expect.poll(async () => (await inbox(id)).length, { timeout: 30_000 }).toBe(60);
      const rows = await inbox(id);
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
      expect(rows.map((r) => r.text)).toEqual(
        Array.from({ length: 60 }, (_, i) => `message ${String(i + 1)}`),
      );
      await expect.poll(() => worker.store.outbox.size, { timeout: 30_000 }).toBe(0);
      expect(worker.store.state.cursors.ackedOutboundSeq).toBe(60);
      expect((await cursors(id)).last).toBe(60);
      expect(worker.transport.stats.sessions).toBeGreaterThanOrEqual(2);
    } finally {
      await worker.stop();
    }

    // Messages produced while offline (or before a restart) are on disk and replayed on the next session.
    const restarted = await runRealWorker(url, dataDir);
    try {
      await expect.poll(() => restarted.transport.established).toBe(true);
      await restarted.stop();
      const offline = await runRealWorker(url, dataDir);
      await offline.transport.stop(); // no network
      await offline.daemon.sendSequenced(event(61));
      await offline.daemon.sendSequenced(event(62));
      expect(offline.store.outbox.size).toBe(2);
      await offline.stop();
      const back = await runRealWorker(url, dataDir);
      try {
        await expect.poll(async () => (await inbox(id)).length, { timeout: 30_000 }).toBe(62);
        await expect.poll(() => back.store.outbox.size).toBe(0);
      } finally {
        await back.stop();
      }
    } finally {
      await restarted.stop();
    }
  });

  it('dedupes duplicate frames and reorders out-of-order delivery', async () => {
    const { w, id } = await rawPaired('DUPE-2345');
    const first = rawEvent(w, id, 1);
    w.sendJson(first);
    w.sendJson(first); // duplicate (same messageId and seq)
    expect((await w.next('ACK')).payload.throughSeq).toBe(1);
    // Out of order: 3 before 2.
    w.sendJson(rawEvent(w, id, 3));
    w.sendJson(rawEvent(w, id, 2));
    await expect.poll(async () => (await inbox(id)).map((r) => r.seq)).toEqual([1, 2, 3]);
    await expect
      .poll(() => w.received.flatMap((m) => (m.type === 'ACK' ? [m.payload.throughSeq] : [])))
      .toContain(3);
    // A replayed old seq with a new messageId (outside the window) is acknowledged without effect.
    // Wait for the master's answer to it (one more ACK), not for a fixed time.
    const acks = () => w.received.filter((m) => m.type === 'ACK').length;
    const before = acks();
    w.sendJson(rawEvent(w, id, 2));
    await expect.poll(acks, { timeout: 30_000 }).toBeGreaterThan(before);
    expect((await inbox(id)).length).toBe(3);
    // The same messageId with another seq is a protocol violation.
    w.sendJson(rawEvent(w, id, 4, first.messageId));
    expect((await w.closed).code).toBe(4400);
    expect((await cursors(id)).last).toBe(3);
  });

  it('a NUL byte or lone surrogate in worker output is stored, not a connection-closing loop', async () => {
    const { w, id } = await rawPaired('NULB-2345');
    const msg = {
      ...w.envelope(
        'EVENT',
        {
          attemptId: 'att_1',
          epoch: 1,
          event: { kind: 'message', role: 'assistant', text: 'C:\\out\u0000put \uD800 son' },
        },
        { workerId: id, jobId: 'job_raw', seq: 1 },
      ),
      messageId: randomUUID(),
    };
    w.sendJson(msg);
    expect((await w.next('ACK')).payload.throughSeq).toBe(1);
    expect((await inbox(id)).map((r) => r.text)).toEqual(['C:\\out\uFFFDput \uFFFD son']);
    expect((await cursors(id)).last).toBe(1);
  });

  it('a sequenced message with seq 0 is refused', async () => {
    const { w, id } = await rawPaired('SEQZ-2345');
    w.sendJson(rawEvent(w, id, 0));
    expect((await w.closed).code).toBe(4400);
  });

  it('replays master → worker messages after the worker cursor and trims on ACK', async () => {
    const { w, id } = await rawPaired('MOUT-2345');
    const replay = h.app.fleetSessions.replay;
    const cancel = (n: number) =>
      replay.enqueue(
        id,
        'CANCEL_JOB',
        { attemptId: 'att_1', epoch: 1, reason: `cancel ${String(n)}` },
        { jobId: 'job_m' },
      );
    expect(await cancel(1)).toBe(1);
    const live = await w.next('CANCEL_JOB');
    expect(live.seq).toBe(1);
    expect(live.jobId).toBe('job_m');
    w.close();
    await w.closed;
    expect(await cancel(2)).toBe(2);
    expect(await cancel(3)).toBe(3);
    expect((await cursors(id)).outbox).toBe(3);

    // Reconnect having processed seq 1: only 2 and 3 are replayed, in order; seq 1 is trimmed (implicit ack).
    const again = await RawWorker.connect(url, w.key);
    expect((await again.handshake({ resumeFromSeq: 1 })).type).toBe('SESSION_ESTABLISHED');
    const a = await again.next('CANCEL_JOB');
    const b = await again.next('CANCEL_JOB');
    expect([a.seq, b.seq]).toEqual([2, 3]);
    expect((await cursors(id)).outbox).toBe(2);
    again.sendJson(again.envelope('ACK', { throughSeq: 3 }, { workerId: id }));
    await expect.poll(async () => (await cursors(id)).outbox).toBe(0);
    expect((await cursors(id)).acked).toBe(3);
    // ACK for a seq the master never sent is a violation.
    again.sendJson(again.envelope('ACK', { throughSeq: 99 }, { workerId: id }));
    expect((await again.closed).code).toBe(4400);
  });

  it('p11: a worker ahead of the master outbox (database restored from a backup) gets renumbered, deliverable messages', async () => {
    const { w, id } = await rawPaired('MBAK-2345');
    const replay = h.app.fleetSessions.replay;
    const cancel = (n: number) =>
      replay.enqueue(
        id,
        'CANCEL_JOB',
        { attemptId: 'att_1', epoch: 1, reason: `cancel ${String(n)}` },
        { jobId: 'job_r' },
      );
    expect(await cancel(1)).toBe(1);
    expect((await w.next('CANCEL_JOB')).seq).toBe(1);
    w.sendJson(w.envelope('ACK', { throughSeq: 1 }, { workerId: id }));
    await expect.poll(async () => (await cursors(id)).outbox).toBe(0);
    w.close();
    await w.closed;
    // The restored database issued seq 1 only; the worker (on the lost timeline) processed up to 7.
    expect(await cancel(2)).toBe(2);
    const again = await RawWorker.connect(url, w.key);
    expect((await again.handshake({ resumeFromSeq: 7 })).type).toBe('SESSION_ESTABLISHED');
    const replayed = await again.next('CANCEL_JOB');
    expect(replayed.seq).toBe(8);
    expect(replayed.payload).toMatchObject({ reason: 'cancel 2' });
    expect(await cursors(id)).toMatchObject({ next: 9, acked: 7, outbox: 1 });
    expect(await cancel(3)).toBe(9);
    expect((await again.next('CANCEL_JOB')).seq).toBe(9);
    // Its ACK is valid again (before the catch-up it would have been a protocol violation).
    again.sendJson(again.envelope('ACK', { throughSeq: 9 }, { workerId: id }));
    await expect.poll(async () => (await cursors(id)).outbox).toBe(0);
    expect(h.logs.text).toContain('numbering caught up');
    again.close();
  });

  it('the real worker processes master messages once and acknowledges them', async () => {
    const dataDir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dataDir);
    const replay = h.app.fleetSessions.replay;
    for (let i = 1; i <= 12; i++) {
      await replay.enqueue(
        id,
        'CANCEL_JOB',
        { attemptId: 'att_1', epoch: 1, reason: `offline ${String(i)}` },
        {
          jobId: 'job_w',
        },
      );
    }
    const worker = await runRealWorker(url, dataDir);
    try {
      await expect.poll(() => worker.store.state.cursors.lastMasterSeq, { timeout: 30_000 }).toBe(12);
      expect(worker.lines.some((l) => l.msg === 'gap in master sequence; processing anyway')).toBe(false);
      await expect.poll(async () => (await cursors(id)).outbox).toBe(0);
      await h.app.workerHub.disconnect(id, 1012, 'restart');
      await expect.poll(() => worker.transport.stats.sessions, { timeout: 30_000 }).toBe(2);
      const handled = worker.lines.filter(
        (l) => l.msg === 'master message not handled by the daemon core yet',
      );
      expect(handled).toHaveLength(12); // in order, and nothing re-processed after the reconnect
    } finally {
      await worker.stop();
    }
  });
});
