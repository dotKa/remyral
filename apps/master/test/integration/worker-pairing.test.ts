import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNodeFileOps,
  DeviceKey,
  ManualSignals,
  pairWorker,
  type PairOutcome,
  WorkerStore,
} from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { FACTS, RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';

interface Summary {
  id: string;
  state: string;
  fingerprint: string | null;
  connected: boolean;
  pairingExpired: boolean;
  quarantineReason: string | null;
}

/** p2-pairing: HELLO with pairing code → pending → admin approval (step-up + code) → session. */
describeIntegration('worker pairing (integration)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
  });
  afterAll(async () => {
    await h.stop();
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  async function workers(): Promise<Summary[]> {
    const res = await admin.req('GET', '/workers');
    expect(res.statusCode).toBe(200);
    return res.json<{ workers: Summary[] }>().workers;
  }

  async function pendingFor(fingerprint: string): Promise<Summary> {
    let found: Summary | undefined;
    await expect
      .poll(async () => {
        found = (await workers()).find((w) => w.fingerprint === fingerprint && w.state === 'pending');
        return found !== undefined;
      })
      .toBe(true);
    if (found === undefined) throw new Error('unreachable');
    return found;
  }

  async function freshStepUp(): Promise<void> {
    h.clock.advance(30_000);
    const up = await admin.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(up.statusCode).toBe(200);
  }

  async function auditFor(target: string): Promise<string[]> {
    const { rows } = await h.db.pool.query<{ action: string; outcome: string }>(
      'SELECT action, outcome FROM audit_events WHERE target = $1 ORDER BY id',
      [target],
    );
    return rows.map((r) => `${r.action}:${r.outcome}`);
  }

  it('pairs a real worker: pending with fingerprint → approve with code → identity stored', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rw-pair-'));
    dirs.push(dataDir);
    const out: string[] = [];
    const signals = new ManualSignals();
    const done: Promise<PairOutcome> = pairWorker({
      ops: createNodeFileOps(),
      host: { platform: process.platform, env: () => undefined, homedir: () => dataDir, isPrivileged: false },
      signals,
      facts: () => Promise.resolve({ ...FACTS, hostname: 'pair-e2e' }),
      out: (t) => out.push(t),
      masterUrl: url,
      dataDir,
      logSink: () => undefined,
    });
    await expect.poll(() => out.join('').includes('Pairing code:')).toBe(true);
    const text = out.join('');
    const code = /Pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(text)?.[1] ?? '';
    const fingerprint = /Fingerprint: +(SHA256:[0-9A-F-]+)/.exec(text)?.[1] ?? '';
    const pending = await pendingFor(fingerprint);
    expect(pending.connected).toBe(false);

    await freshStepUp();
    const wrong = await admin.req('POST', `/workers/${pending.id}/approve`, { pairingCode: 'ZZZZ-ZZZZ' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ error: string }>().error).toBe('pairing_code_mismatch');

    const ok = await admin.req('POST', `/workers/${pending.id}/approve`, { pairingCode: code.toLowerCase() });
    expect(ok.statusCode).toBe(200);
    expect(await done).toBe('approved');
    expect(out.join('')).toContain(`worker ${pending.id}`);

    const { store } = await WorkerStore.open(createNodeFileOps(), dataDir);
    expect(store.identity?.workerId).toBe(pending.id);
    const detail = await admin.req('GET', `/workers/${pending.id}`);
    expect(detail.json<{ credentials: { status: string }[] }>().credentials.map((c) => c.status)).toEqual([
      'active',
    ]);
    const audit = await auditFor(pending.id);
    expect(audit).toEqual(
      expect.arrayContaining([
        'worker.pairing.request:success',
        'worker.approve:denied',
        'worker.approve:success',
      ]),
    );
    // p5-live-fixes-2: `pair` is pair-only — the service opens the worker session, never the CLI.
    expect(audit).not.toContain('worker.session.start:success');
  });

  it('requires a full session and a fresh step-up', async () => {
    const key = new TestKey();
    const w = await RawWorker.connect(url, key);
    const answer = await w.handshake({ pairingCode: 'QRST-UVWX' });
    expect(answer.type).toBe('ENROLL_PENDING');
    const id = answer.workerId ?? '';
    expect(
      (await h.client().req('POST', `/workers/${id}/approve`, { pairingCode: 'QRST-UVWX' })).statusCode,
    ).toBe(401);
    h.clock.advance(10 * 60_000 + 1_000); // step-up expired (pairing request too, at 10 min)
    const stale = await admin.req('POST', `/workers/${id}/approve`, { pairingCode: 'QRST-UVWX' });
    expect(stale.statusCode).toBe(403);
    expect(stale.json<{ error: string }>().error).toBe('step_up_required');
    await freshStepUp();
    const expired = await admin.req('POST', `/workers/${id}/approve`, { pairingCode: 'QRST-UVWX' });
    expect(expired.statusCode).toBe(409);
    expect(expired.json<{ error: string }>().error).toBe('pairing_expired');
    expect((await workers()).find((x) => x.id === id)?.pairingExpired).toBe(true);
    w.close();
  });

  it('approves a socket that is waiting: ENROLL_APPROVED then SESSION_ESTABLISHED on the same connection', async () => {
    const w = await RawWorker.connect(url);
    const answer = await w.handshake({ pairingCode: 'HJKL-MNPQ' });
    expect(answer.type).toBe('ENROLL_PENDING');
    await freshStepUp();
    const res = await admin.req('POST', `/workers/${answer.workerId ?? ''}/approve`, {
      pairingCode: 'HJKL MNPQ',
    });
    expect(res.statusCode).toBe(200);
    const approved = await w.next('ENROLL_APPROVED');
    expect(approved.payload.workerId).toBe(answer.workerId);
    await w.next('SESSION_ESTABLISHED');
    await expect
      .poll(async () => (await workers()).find((x) => x.id === answer.workerId)?.state)
      .toBe('online');

    // Reconnect with the same key: plain challenge → session, no pairing involved.
    w.close();
    await w.closed;
    await expect
      .poll(async () => (await workers()).find((x) => x.id === answer.workerId)?.state)
      .toBe('offline');
    const again = await RawWorker.connect(url, w.key);
    expect((await again.handshake()).type).toBe('SESSION_ESTABLISHED');
    again.close();
  });

  it('denial closes the socket, quarantines the worker and refuses the key forever', async () => {
    const key = new TestKey();
    const w = await RawWorker.connect(url, key);
    const answer = await w.handshake({ pairingCode: 'DENY-ABCD' });
    const id = answer.workerId ?? '';
    await freshStepUp();
    const res = await admin.req('POST', `/workers/${id}/deny`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json<Summary>()).toMatchObject({
      state: 'quarantined',
      quarantineReason: 'enrollment_denied',
    });
    expect((await w.next('ERROR')).payload.code).toBe('enrollment_denied');
    expect((await w.closed).code).toBe(4403);
    const retry = await RawWorker.connect(url, key);
    const refused = await retry.handshake({ pairingCode: 'DENY-EFGH' });
    expect(refused.type === 'ERROR' && refused.payload.code).toBe('enrollment_denied');
    expect(await auditFor(id)).toContain('worker.deny:success');
    expect((await admin.req('POST', `/workers/${id}/deny`, {})).statusCode).toBe(409);
  });

  it('auto-denies after too many wrong pairing codes', async () => {
    const w = await RawWorker.connect(url);
    const answer = await w.handshake({ pairingCode: 'WXYZ-2345' });
    const id = answer.workerId ?? '';
    await freshStepUp();
    for (let i = 0; i < 4; i++) {
      expect(
        (await admin.req('POST', `/workers/${id}/approve`, { pairingCode: 'AAAA-AAAA' })).statusCode,
      ).toBe(400);
    }
    const last = await admin.req('POST', `/workers/${id}/approve`, { pairingCode: 'AAAA-AAAA' });
    expect(last.statusCode).toBe(409);
    expect((await w.closed).code).toBe(4403);
    expect((await workers()).find((x) => x.id === id)?.quarantineReason).toBe('pairing_failed');
  });

  it('pairing codes are single-use', async () => {
    const first = await RawWorker.connect(url);
    expect((await first.handshake({ pairingCode: 'ONCE-2222' })).type).toBe('ENROLL_PENDING');
    const second = await RawWorker.connect(url);
    const answer = await second.handshake({ pairingCode: 'ONCE-2222' });
    expect(answer.type === 'ERROR' && answer.payload.code).toBe('pairing_invalid');
    first.close();
  });

  it('refuses an unknown key without a pairing code', async () => {
    const w = await RawWorker.connect(url);
    const answer = await w.handshake();
    expect(answer.type === 'ERROR' && answer.payload.code).toBe('unauthenticated');
  });

  it('404 for unknown or malformed worker ids', async () => {
    expect((await admin.req('GET', '/workers/wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa')).statusCode).toBe(404);
    expect((await admin.req('GET', '/workers/..%2Fetc')).statusCode).toBe(404);
  });

  it('rate-limits pairing requests per IP', async () => {
    const other = new Harness();
    await other.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 2 } },
    });
    const otherUrl = await other.listen();
    try {
      for (const code of ['RATE-AAAA', 'RATE-BBBB']) {
        expect((await (await RawWorker.connect(otherUrl)).handshake({ pairingCode: code })).type).toBe(
          'ENROLL_PENDING',
        );
      }
      const third = await RawWorker.connect(otherUrl);
      const answer = await third.handshake({ pairingCode: 'RATE-CCCC' });
      expect(answer.type === 'ERROR' && answer.payload.code).toBe('rate_limited');
      expect((await third.closed).code).toBe(4429);
    } finally {
      await other.stop();
    }
  });

  it('caps pending requests per network and tells the owners once per network', async () => {
    const other = new Harness();
    await other.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50, maxPendingPerNetwork: 2 },
      },
    });
    const otherUrl = await other.listen();
    try {
      for (const code of ['NETW-AAAA', 'NETW-BBBB']) {
        expect((await (await RawWorker.connect(otherUrl)).handshake({ pairingCode: code })).type).toBe(
          'ENROLL_PENDING',
        );
      }
      const third = await RawWorker.connect(otherUrl);
      const answer = await third.handshake({ pairingCode: 'NETW-CCCC' });
      expect(answer.type === 'ERROR' && answer.payload.code).toBe('rate_limited');
      const { rows } = await other.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM outbox WHERE topic = 'worker.pending'",
      );
      expect(rows[0]?.n).toBe(1);
    } finally {
      await other.stop();
    }
  });

  it('keeps the device key on the worker: only the public key reaches the master', async () => {
    const key = DeviceKey.generate();
    const { rows } = await h.db.pool.query<{ public_key: string }>(
      'SELECT public_key FROM worker_credentials',
    );
    expect(rows.every((r) => /^[A-Za-z0-9_-]{43}$/.test(r.public_key))).toBe(true);
    expect(JSON.stringify(key)).not.toContain('PRIVATE');
  });
});
