import { createNodeFileOps, FileKeystore, loadOrCreateDeviceKey, type SequencedDraft } from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker } from '../helpers/raw-worker.js';
import { CAPS, pairRealWorker, removeDirs, runRealWorker, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';

/**
 * The P2 path end to end, real master (in-process) + real worker daemon and transport over loopback
 * WebSocket against the dev Postgres: pair → approve → reconnect with challenge → heartbeat →
 * kill connection → replay without duplicates → revoke → refused.
 */
describeIntegration('worker lifecycle end to end (integration)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, sweepIntervalMs: 3_600_000 },
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

  it('pair → approve → challenge → heartbeat → drop → replay once → revoke → refused', async () => {
    const dataDir = await tempDataDir(dirs);
    // 1-2. Pair and approve (code + fingerprint + step-up).
    const id = await pairRealWorker(h, url, admin, secret, dataDir);

    // 3. Reconnect: challenge-response with the stored key only.
    const worker = await runRealWorker(url, dataDir, { capabilities: CAPS, heartbeatIntervalMs: 100 });
    try {
      await expect.poll(() => worker.transport.established).toBe(true);
      expect(worker.transport.stats.sessions).toBe(1);

      // 4. Heartbeat and capabilities reach the master.
      const seenAt = async () =>
        (await admin.req('GET', `/workers/${id}`)).json<{ lastSeenAt: string | null; state: string }>();
      await expect.poll(async () => (await seenAt()).state).toBe('online');
      const before = (await seenAt()).lastSeenAt;
      h.clock.advance(5_000);
      await expect.poll(async () => (await seenAt()).lastSeenAt).not.toBe(before);

      // 5-6. Stream events, kill the connection mid-stream, replay without duplicates.
      const sends: Promise<number>[] = [];
      for (let i = 1; i <= 40; i++) {
        sends.push(
          worker.daemon.sendSequenced({
            type: 'LOG_CHUNK',
            correlationId: `log-${String(i)}`,
            jobId: 'job_e2e',
            payload: {
              attemptId: 'att_1',
              epoch: 1,
              stream: 'stdout',
              chunkSeq: i,
              data: `line ${String(i)}\n`,
              redacted: true,
            },
          } as SequencedDraft),
        );
        if (i === 15) void h.app.workerHub.disconnect(id, 1012, 'network drop');
      }
      await Promise.all(sends);
      await expect
        .poll(async () => {
          const { rows } = await h.db.pool.query<{ n: string; distinct_seq: string }>(
            `SELECT count(*)::text AS n, count(DISTINCT seq)::text AS distinct_seq FROM worker_inbox WHERE worker_id = $1`,
            [id],
          );
          return [Number(rows[0]?.n), Number(rows[0]?.distinct_seq)];
        })
        .toEqual([40, 40]);
      await expect.poll(() => worker.store.outbox.size).toBe(0);
      expect(worker.transport.stats.sessions).toBeGreaterThanOrEqual(2);

      // 7. Revoke: the socket closes within 1 s and the worker quarantines itself.
      h.clock.advance(30_000);
      expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
      const t0 = performance.now();
      expect((await admin.req('POST', `/workers/${id}/revoke`, {})).statusCode).toBe(200);
      await expect.poll(() => worker.daemon.machine.state, { interval: 10 }).toBe('quarantined');
      expect(performance.now() - t0).toBeLessThan(1_000);
    } finally {
      await worker.stop();
    }

    // 8. Refused: the same key cannot open a session again.
    const { key } = await loadOrCreateDeviceKey(new FileKeystore(createNodeFileOps(), dataDir));
    const raw = await RawWorker.connect(url, key);
    const answer = await raw.handshake();
    expect(answer.type === 'ERROR' && answer.payload.code).toBe('revoked');
    expect((await raw.closed).code).toBe(4403);
  });
});
