import { rotationPayload } from '@remyral/protocol/auth';
import { createNodeFileOps, DeviceKey, FileKeystore, loadOrCreateDeviceKey } from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker } from '../helpers/raw-worker.js';
import { pairRealWorker, removeDirs, runRealWorker, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';

interface Detail {
  state: string;
  quarantineReason: string | null;
  connected: boolean;
  fingerprint: string | null;
  credentials: { fingerprint: string; status: string }[];
}

async function setup(rotationRequiresApproval: boolean) {
  const h = new Harness();
  await h.start({
    workers: {
      connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
      pairing: { perIp: 50 },
      sweepIntervalMs: 3_600_000,
      rotationRequiresApproval,
    },
  });
  const url = await h.listen();
  await h.createUser('owner1', PW);
  const { secret } = await enroll(h, 'owner1', PW);
  const admin = await fullLogin(h, 'owner1', PW, secret);
  return { h, url, admin, secret };
}

/** p2-identity-rotation: revocation within 1 s, refused reconnects, key rotation with and without approval. */
describeIntegration('worker revocation and key rotation (integration)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    ({ h, url, admin, secret } = await setup(false));
  });
  afterAll(async () => {
    await h.stop();
    await removeDirs(dirs);
  });

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function detail(id: string): Promise<Detail> {
    return (await admin.req('GET', `/workers/${id}`)).json<Detail>();
  }

  async function keyOf(dataDir: string): Promise<DeviceKey> {
    return (await loadOrCreateDeviceKey(new FileKeystore(createNodeFileOps(), dataDir))).key;
  }

  it('revocation closes the live socket within 1 s, quarantines the worker and refuses every later connect', async () => {
    const dataDir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dataDir);
    const worker = await runRealWorker(url, dataDir);
    try {
      await expect.poll(() => worker.transport.established).toBe(true);
      await stepUp();
      const started = performance.now();
      const res = await admin.req('POST', `/workers/${id}/revoke`, { reason: 'laptop stolen' });
      expect(res.statusCode).toBe(200);
      await expect.poll(() => worker.daemon.machine.state, { interval: 10 }).toBe('quarantined');
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(1_000);
      expect(worker.transport.established).toBe(false);
      expect(await detail(id)).toMatchObject({
        state: 'quarantined',
        quarantineReason: 'revoked',
        connected: false,
      });
      expect((await detail(id)).credentials.map((c) => c.status)).toEqual(['revoked']);

      // The daemon stopped its transport; nothing reconnects by itself.
      await new Promise((r) => setTimeout(r, 300));
      expect(worker.transport.stats.connects).toBe(1);
      // A manual reconnect with the same key: challenge passes, the directory refuses.
      const raw = await RawWorker.connect(url, await keyOf(dataDir));
      const answer = await raw.handshake();
      expect(answer.type === 'ERROR' && answer.payload.code).toBe('revoked');
      expect((await raw.closed).code).toBe(4403);
      // Even with a pairing code the revoked key cannot re-enroll.
      const again = await RawWorker.connect(url, await keyOf(dataDir));
      const reenroll = await again.handshake({ pairingCode: 'RVKD-2345' });
      expect(reenroll.type === 'ERROR' && reenroll.payload.code).toBe('revoked');

      const { rows } = await h.db.pool.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE target = $1 AND action = 'worker.revoke'`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect((await admin.req('POST', `/workers/${id}/revoke`, {})).statusCode).toBe(409);
      expect((await admin.req('POST', `/workers/${id}/rotate`, {})).statusCode).toBe(409);
    } finally {
      await worker.stop();
    }
  });

  it('rotates the device key (old key vouches, new key proves) and the old key is superseded', async () => {
    const dataDir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dataDir);
    const oldKey = await keyOf(dataDir);
    const worker = await runRealWorker(url, dataDir);
    try {
      await expect.poll(() => worker.transport.established).toBe(true);
      await stepUp();
      const res = await admin.req('POST', `/workers/${id}/rotate`, {});
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'requested', requiresApproval: false });

      // The worker switches keys and reconnects with the new one.
      await expect.poll(() => worker.transport.stats.sessions, { timeout: 10_000 }).toBe(2);
      const newKey = await keyOf(dataDir);
      expect(newKey.publicKey).not.toBe(oldKey.publicKey);
      expect(worker.store.identity?.publicKey).toBe(newKey.publicKey);
      // The master records the new session after SESSION_ESTABLISHED is sent: wait for it.
      await expect.poll(async () => (await detail(id)).state, { timeout: 10_000 }).toBe('online');
      const d = await detail(id);
      expect(d.fingerprint).toBe(newKey.fingerprint);
      expect(d.credentials.map((c) => [c.fingerprint, c.status])).toEqual([
        [newKey.fingerprint, 'active'],
        [oldKey.fingerprint, 'superseded'],
      ]);
      // The master marks the new session online right after SESSION_ESTABLISHED (not before): poll.
      await expect.poll(async () => (await detail(id)).state).toBe('online');

      // The old key gets credential_superseded (and no new pairing).
      const raw = await RawWorker.connect(url, oldKey);
      const answer = await raw.handshake({ pairingCode: 'OLDK-2345' });
      expect(answer.type === 'ERROR' && answer.payload.code).toBe('credential_superseded');

      const { rows } = await h.db.pool.query<{ action: string; outcome: string }>(
        `SELECT action, outcome FROM audit_events WHERE target = $1 AND action LIKE 'worker.rotate%' ORDER BY id`,
        [id],
      );
      expect(rows.map((r) => `${r.action}:${r.outcome}`)).toEqual([
        'worker.rotate.request:success',
        'worker.rotate:success',
      ]);
    } finally {
      await worker.stop();
    }
  });

  it('refuses forged or replayed rotation statements', async () => {
    const dataDir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dataDir);
    const key = await keyOf(dataDir);
    const raw = await RawWorker.connect(url, key);
    expect((await raw.handshake()).type).toBe('SESSION_ESTABLISHED');

    // Without an outstanding request.
    const attacker = DeviceKey.generate();
    const forged = (nonce: string, newSigner = attacker, oldSigner: DeviceKey | null = key) => {
      const statement = rotationPayload({
        workerId: id,
        oldPublicKey: key.publicKey,
        newPublicKey: attacker.publicKey,
        nonce,
      });
      return {
        nonce,
        newPublicKey: attacker.publicKey,
        oldKeySignature: (oldSigner ?? attacker).sign(statement),
        newKeySignature: newSigner.sign(statement),
      };
    };
    raw.sendJson(raw.envelope('ROTATE_KEY', forged('n'.repeat(43)), { workerId: id }));
    expect((await raw.next('ERROR')).payload).toMatchObject({
      code: 'rotation_refused',
      message: 'no_outstanding_request',
    });

    // With a request, but the old-key signature is missing (signed by the attacker only).
    await stepUp();
    expect((await admin.req('POST', `/workers/${id}/rotate`, {})).statusCode).toBe(202);
    const request = await raw.next('ROTATE_CREDENTIAL');
    const nonce = request.payload.nonce ?? '';
    raw.sendJson(raw.envelope('ROTATE_KEY', forged(nonce, attacker, null), { workerId: id }));
    expect((await raw.next('ERROR')).payload).toMatchObject({
      code: 'rotation_refused',
      message: 'bad_signature',
    });

    // The nonce was consumed by the failed attempt: a correct statement now is refused too.
    raw.sendJson(raw.envelope('ROTATE_KEY', forged(nonce), { workerId: id }));
    expect((await raw.next('ERROR')).payload).toMatchObject({
      code: 'rotation_refused',
      message: 'no_outstanding_request',
    });
    expect((await detail(id)).credentials.map((c) => c.status)).toEqual(['active']);
    raw.close();
  });

  it('with the approval policy the rotated key waits until an administrator approves it', async () => {
    const strict = await setup(true);
    const dataDir = await tempDataDir(dirs);
    try {
      const id = await pairRealWorker(strict.h, strict.url, strict.admin, strict.secret, dataDir);
      const oldKey = await keyOf(dataDir);
      const worker = await runRealWorker(strict.url, dataDir);
      try {
        await expect.poll(() => worker.transport.established).toBe(true);
        strict.h.clock.advance(30_000);
        await strict.admin.req('POST', '/auth/step-up', { code: strict.h.code(strict.secret) });
        const res = await strict.admin.req('POST', `/workers/${id}/rotate`, {});
        expect(res.json()).toEqual({ status: 'requested', requiresApproval: true });
        await expect
          .poll(() =>
            worker.lines.some((l) => l.msg === 'rotated key registered; waiting for administrator approval'),
          )
          .toBe(true);
        const pending = (await strict.admin.req('GET', `/workers/${id}`)).json<Detail>();
        expect(pending.credentials.map((c) => c.status)).toEqual(['pending', 'active']);
        expect((await keyOf(dataDir)).publicKey).toBe(oldKey.publicKey); // still the old key

        const ok = await strict.admin.req('POST', `/workers/${id}/approve-rotation`, {});
        expect(ok.statusCode).toBe(200);
        await expect.poll(() => worker.transport.stats.sessions, { timeout: 10_000 }).toBe(2);
        const newKey = await keyOf(dataDir);
        expect(newKey.publicKey).not.toBe(oldKey.publicKey);
        const after = (await strict.admin.req('GET', `/workers/${id}`)).json<Detail>();
        expect(after.credentials.map((c) => [c.fingerprint, c.status])).toEqual([
          [newKey.fingerprint, 'active'],
          [oldKey.fingerprint, 'superseded'],
        ]);
        expect((await strict.admin.req('POST', `/workers/${id}/approve-rotation`, {})).statusCode).toBe(409);
      } finally {
        await worker.stop();
      }
    } finally {
      await strict.h.stop();
    }
  });
});
