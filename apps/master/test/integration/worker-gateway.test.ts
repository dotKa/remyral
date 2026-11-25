import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MAX_FRAME_BYTES } from '@remyral/protocol';
import type { WorkerGatewayConfig } from '../../src/compose.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';
import { MemoryDirectory, RecordingHandler } from '../helpers/memory-directory.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p2-transport: the master's worker WebSocket endpoint, driven by a raw protocol
 * client. Focus: nothing but HELLO/AUTH works before authentication, limits are
 * enforced, and sessions are bound to proof of key possession.
 */
describeIntegration('worker gateway /v1/worker (integration)', () => {
  const directory = new MemoryDirectory();
  const handler = new RecordingHandler();
  let h: Harness;
  let url: string;

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: {
        directory,
        handler,
        connectRateLimit: { perIp: 10_000, windowMs: 60_000 },
        limits: { messagesPerSec: 50, messageBurst: 60 },
      },
    });
    directory.clock = h.clock.now;
    url = await h.listen();
  });
  afterAll(async () => {
    await h.stop();
  });

  async function auditActions(): Promise<string[]> {
    const { rows } = await h.db.pool.query<{ action: string; outcome: string }>(
      'SELECT action, outcome FROM audit_events ORDER BY id',
    );
    return rows.map((r) => `${r.action}:${r.outcome}`);
  }

  it('answers plain HTTP with 426 and needs no human session', async () => {
    const res = await h.client().req('GET', '/v1/worker');
    expect(res.statusCode).toBe(426);
    expect(res.json()).toEqual({
      error: 'upgrade_required',
      message: 'This endpoint only accepts WebSocket connections.',
    });
  });

  it('refuses anything but HELLO from an unauthenticated socket', async () => {
    const w = await RawWorker.connect(url);
    w.sendJson(
      w.envelope(
        'HEARTBEAT',
        { state: 'online', runningJobs: [], load: { cpuPercent: 1, memoryFreeBytes: 1, diskFreeBytes: 1 } },
        { workerId: 'wrk_x' },
      ),
    );
    const error = await w.next('ERROR');
    expect(error.payload.code).toBe('unauthenticated');
    expect((await w.closed).code).toBe(4401);
    expect(handler.messages).toHaveLength(0);
  });

  it('refuses anything but AUTH after HELLO', async () => {
    const w = await RawWorker.connect(url);
    w.hello();
    await w.next('CHALLENGE');
    w.sendJson(w.envelope('ACK', { throughSeq: 1 }, { workerId: 'wrk_x' }));
    expect((await w.next('ERROR')).payload.code).toBe('unauthenticated');
    expect((await w.closed).code).toBe(4401);
  });

  it('closes on invalid JSON before authentication', async () => {
    const w = await RawWorker.connect(url);
    w.ws.send('{nope');
    expect((await w.closed).code).toBe(4400);
  });

  it('refuses binary frames before a session (the STREAM_* plane is session-only, ADR-0066)', async () => {
    const w = await RawWorker.connect(url);
    w.ws.send(Buffer.from([1, 2, 3]));
    expect((await w.closed).code).toBe(1003);
  });

  it('refuses frames above MAX_FRAME_BYTES at the WebSocket layer', async () => {
    const w = await RawWorker.connect(url);
    w.ws.send('x'.repeat(MAX_FRAME_BYTES + 1));
    // 1009 (message too big); 1006 when the server drops the socket before the client reads the close frame.
    expect([1006, 1009]).toContain((await w.closed).code);
  });

  it('answers an unsupported protocol version with upgrade_required (ADR-0011)', async () => {
    const w = await RawWorker.connect(url);
    w.hello({ versions: ['2.0', '3.1'] });
    const error = await w.next('ERROR');
    expect(error.payload.code).toBe('upgrade_required');
    expect((await w.closed).code).toBe(4426);
  });

  it('refuses a bad signature and audits it', async () => {
    const w = await RawWorker.connect(url);
    w.hello();
    const challenge = await w.next('CHALLENGE');
    w.auth(challenge.payload.nonce, new TestKey().signChallenge(challenge.payload.nonce));
    expect((await w.next('ERROR')).payload.code).toBe('unauthenticated');
    expect((await w.closed).code).toBe(4401);
    expect(await auditActions()).toContain('worker.auth:denied');
  });

  it('refuses AUTH for a different (replayed) nonce', async () => {
    const w = await RawWorker.connect(url);
    w.hello();
    await w.next('CHALLENGE');
    const replayed = 'r'.repeat(43);
    w.auth(replayed);
    expect((await w.next('ERROR')).payload.code).toBe('unauthenticated');
    expect((await w.closed).code).toBe(4401);
  });

  it('refuses an unknown key without pairing code', async () => {
    const w = await RawWorker.connect(url);
    const answer = await w.handshake();
    expect(answer.type).toBe('ERROR');
    expect((await w.closed).code).toBe(4401);
  });

  it('establishes a session for a known key and binds messages to its workerId', async () => {
    const key = new TestKey();
    directory.active.set(key.publicKey, 'wrk_known');
    directory.resumeFromSeq = 17;
    const w = await RawWorker.connect(url, key);
    const answer = await w.handshake({ resumeFromSeq: 3 });
    expect(answer.type).toBe('SESSION_ESTABLISHED');
    if (answer.type !== 'SESSION_ESTABLISHED') return;
    expect(answer.workerId).toBe('wrk_known');
    expect(answer.payload.resumeFromSeq).toBe(17);
    expect(answer.payload.negotiatedVersion).toBe('1.0');
    expect(h.app.workerHub.isConnected('wrk_known')).toBe(true);
    await expect
      .poll(() => handler.started.find((s) => s.workerId === 'wrk_known')?.workerResumeFromSeq)
      .toBe(3);

    w.sendJson(w.envelope('ACK', { throughSeq: 0 }, { workerId: 'wrk_known' }));
    await expect.poll(() => handler.messages.some((m) => m.type === 'ACK')).toBe(true);

    // A message claiming another worker's identity is a protocol violation.
    w.sendJson(w.envelope('ACK', { throughSeq: 0 }, { workerId: 'wrk_other' }));
    expect((await w.closed).code).toBe(4400);
    await expect.poll(() => handler.ended.some((e) => e.workerId === 'wrk_known')).toBe(true);
    expect(h.app.workerHub.isConnected('wrk_known')).toBe(false);
    await expect
      .poll(() => auditActions())
      .toEqual(expect.arrayContaining(['worker.session.start:success', 'worker.session.end:success']));
  });

  it('a newer connection of the same worker replaces the older one (4409)', async () => {
    const key = new TestKey();
    directory.active.set(key.publicKey, 'wrk_twice');
    const first = await RawWorker.connect(url, key);
    expect((await first.handshake()).type).toBe('SESSION_ESTABLISHED');
    const second = await RawWorker.connect(url, key);
    expect((await second.handshake()).type).toBe('SESSION_ESTABLISHED');
    expect((await first.closed).code).toBe(4409);
    expect(h.app.workerHub.isConnected('wrk_twice')).toBe(true);
    second.close();
  });

  it('names why a connection was replaced: own reconnect vs another process (p5-live-fixes-2)', async () => {
    const key = new TestKey();
    directory.active.set(key.publicKey, 'wrk_churn');
    const instance = randomUUID();
    const first = await RawWorker.connect(url, key);
    expect((await first.handshake({ instanceId: instance })).type).toBe('SESSION_ESTABLISHED');
    // The same process reconnects (its previous socket went stale).
    const second = await RawWorker.connect(url, key);
    expect((await second.handshake({ instanceId: instance })).type).toBe('SESSION_ESTABLISHED');
    const c1 = await first.closed;
    expect(c1.code).toBe(4409);
    expect(c1.reason).toContain('reconnected');
    // A different process presents the same key.
    const third = await RawWorker.connect(url, key);
    expect((await third.handshake({ instanceId: randomUUID() })).type).toBe('SESSION_ESTABLISHED');
    const c2 = await second.closed;
    expect(c2.code).toBe(4409);
    expect(c2.reason).toContain('another process');
    third.close();
  });

  it('a pair-only HELLO of an enrolled key is confirmed without opening a session', async () => {
    const key = new TestKey();
    directory.active.set(key.publicKey, 'wrk_service');
    const service = await RawWorker.connect(url, key);
    expect((await service.handshake({ instanceId: randomUUID() })).type).toBe('SESSION_ESTABLISHED');
    const cli = await RawWorker.connect(url, key);
    const answer = await cli.handshake({
      pairingCode: 'ABCD-EFGH',
      pairOnly: true,
      instanceId: randomUUID(),
    });
    expect(answer.type).toBe('ENROLL_APPROVED');
    expect((await cli.closed).code).toBe(1000);
    // The running service keeps its session.
    expect(service.isClosed).toBe(false);
    expect(h.app.workerHub.isConnected('wrk_service')).toBe(true);
    expect(cli.received.some((m) => m.type === 'SESSION_ESTABLISHED')).toBe(false);
    service.close();
  });

  it('a daemon still holding a pairing code gets ENROLL_APPROVED and then its session', async () => {
    const key = new TestKey();
    directory.active.set(key.publicKey, 'wrk_late');
    const w = await RawWorker.connect(url, key);
    expect((await w.handshake({ pairingCode: 'ABCD-EFGH' })).type).toBe('ENROLL_APPROVED');
    expect((await w.next('SESSION_ESTABLISHED')).workerId).toBe('wrk_late');
    w.close();
  });

  it('a pending pair-only socket is closed after the approval instead of opening a session', async () => {
    const w = await RawWorker.connect(url);
    const answer = await w.handshake({ pairingCode: 'ABCD-EFGH', pairOnly: true });
    expect(answer.type).toBe('ENROLL_PENDING');
    const workerId = answer.workerId ?? '';
    await h.app.workerHub.get(workerId)?.approve(workerId, new Date(), 0);
    expect((await w.next('ENROLL_APPROVED')).payload.workerId).toBe(workerId);
    expect((await w.closed).code).toBe(1000);
    expect(w.received.some((m) => m.type === 'SESSION_ESTABLISHED')).toBe(false);
  });

  it('keeps a pairing socket pending and accepts nothing else', async () => {
    const w = await RawWorker.connect(url);
    const answer = await w.handshake({ pairingCode: 'ABCD-EFGH' });
    expect(answer.type).toBe('ENROLL_PENDING');
    if (answer.type === 'ENROLL_PENDING') expect(answer.payload.fingerprint).toBe(w.key.fingerprint);
    w.sendJson(w.envelope('ACK', { throughSeq: 0 }, { workerId: answer.workerId }));
    expect((await w.closed).code).toBe(4400);
  });

  it('closes with 4429 when the per-connection message rate is exceeded', async () => {
    const key = new TestKey();
    directory.active.set(key.publicKey, 'wrk_flood');
    const w = await RawWorker.connect(url, key);
    expect((await w.handshake()).type).toBe('SESSION_ESTABLISHED');
    const ack = JSON.stringify(w.envelope('ACK', { throughSeq: 0 }, { workerId: 'wrk_flood' }));
    // Bursts of 200 (> burst 60) until the master closes: a descheduled server that reads the frames slowly
    // (and so refills the bucket in between) still sees the limit exceeded, just after more bursts.
    const open = () => !w.isClosed;
    for (let burst = 0; burst < 50 && open(); burst++) {
      for (let i = 0; i < 200 && open(); i++) w.ws.send(ack);
      await new Promise((r) => setImmediate(r));
    }
    expect((await w.closed).code).toBe(4429);
  });

  it('closes every worker socket with 1001 on master shutdown', async () => {
    const key = new TestKey();
    directory.active.set(key.publicKey, 'wrk_shutdown');
    const other = new Harness();
    await other.start({ workers: { directory, handler } });
    const otherUrl = await other.listen();
    const w = await RawWorker.connect(otherUrl, key);
    expect((await w.handshake()).type).toBe('SESSION_ESTABLISHED');
    await other.stop();
    expect((await w.closed).code).toBe(1001);
  });
});

/**
 * Timer-driven behaviour. Every step the test itself must answer gets a budget of seconds, not a few hundred
 * milliseconds, and no two server timers that decide the outcome are due at the same instant: under a load
 * average of 30+ the test process is regularly descheduled for longer than the old 300 ms windows, and the
 * old settings had the challenge expiry (300 + 300 ms) and the session expiry (600 ms) racing each other.
 */
describeIntegration('worker gateway timing (integration)', () => {
  /** A fresh master per test: each one needs its own timing and a fresh per-IP upgrade budget. */
  async function startHarness(workers: WorkerGatewayConfig): Promise<{ h: Harness; url: string }> {
    const h = new Harness();
    await h.start({ workers });
    return { h, url: await h.listen() };
  }

  it('closes a silent socket after the HELLO timeout (4408), then rate-limits upgrades per IP', async () => {
    const { h, url } = await startHarness({
      directory: new MemoryDirectory(),
      timing: { helloTimeoutMs: 300 },
      connectRateLimit: { perIp: 3, windowMs: 60_000 },
    });
    try {
      // Nothing is sent, so the only timer in play is the HELLO timeout.
      const silent = await RawWorker.connect(url);
      expect((await silent.closed).code).toBe(4408);
      // Upgrades two and three from this IP are allowed, the fourth is refused before any protocol work.
      (await RawWorker.connect(url)).close();
      (await RawWorker.connect(url)).close();
      await expect(RawWorker.connect(url)).rejects.toThrow('HTTP 429');
    } finally {
      await h.stop();
    }
  });

  it('re-authenticates in band before the session expires; an unanswered challenge ends the session', async () => {
    const directory = new MemoryDirectory();
    // Re-auth challenge 1 s into the session, expiry at 3 s: the test has 2 s to answer each step. The
    // challenge itself outlives the session (10 s), so an unanswered round always ends as session_expired.
    const { h, url } = await startHarness({
      directory,
      timing: { challengeTtlMs: 10_000, sessionTtlMs: 3_000, reauthBeforeMs: 2_000 },
    });
    try {
      const key = new TestKey();
      directory.active.set(key.publicKey, 'wrk_reauth');
      const w = await RawWorker.connect(url, key);
      expect((await w.handshake()).type).toBe('SESSION_ESTABLISHED');
      const challenge = await w.next('CHALLENGE', 15_000);
      w.auth(challenge.payload.nonce);
      const renewed = await w.next('SESSION_ESTABLISHED', 15_000);
      expect(renewed.payload.resumeFromSeq).toBeUndefined();
      // Second round: no answer → session_expired and close.
      await w.next('CHALLENGE', 15_000);
      const error = await w.next('ERROR', 15_000);
      expect(error.payload.code).toBe('session_expired');
      expect((await w.closed).code).toBe(4401);
    } finally {
      await h.stop();
    }
  });

  it('refuses re-authentication once the key is no longer active', async () => {
    const directory = new MemoryDirectory();
    const { h, url } = await startHarness({
      directory,
      timing: { challengeTtlMs: 10_000, sessionTtlMs: 3_000, reauthBeforeMs: 2_500 },
    });
    try {
      const key = new TestKey();
      directory.active.set(key.publicKey, 'wrk_revoked_later');
      const w = await RawWorker.connect(url, key);
      expect((await w.handshake()).type).toBe('SESSION_ESTABLISHED');
      directory.refused.set(key.publicKey, 'revoked');
      const challenge = await w.next('CHALLENGE', 15_000);
      w.auth(challenge.payload.nonce);
      expect((await w.next('ERROR', 15_000)).payload.code).toBe('unauthenticated');
      expect((await w.closed).code).toBe(4401);
    } finally {
      await h.stop();
    }
  });
});
