import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { offlineWorkersWithLeases } from '../../src/notifications/producers.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
const MIN = 60_000;
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const KEYLESS = 'wrk_keylessaaaaaaaaaaaaaaaaaaa';
const BUSY_REVOKED = 'wrk_busyrevokedaaaaaaaaaaaaaaa';
const CONTROL = 'wrk_controlaaaaaaaaaaaaaaaaaaa';

interface Summary {
  id: string;
  state: string;
  quarantineReason: string | null;
  connected: boolean;
  archivedAt: string | null;
}

/**
 * p5-fleet-archive: "remove from list" for workers that can never work again. Archiving keeps the row, the
 * credentials (denied/revoked keys stay refused) and the audit trail; archived workers leave the fleet list,
 * the overview, placement and the offline-with-work alert; `?archived=1` lists them and unarchive restores.
 */
describeIntegration('worker archive (integration)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  let adminId: string;
  let jobs: JobStore;

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      alerts: { listeners: [] },
    });
    url = await h.listen();
    adminId = await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
  });
  afterAll(async () => {
    await h.stop();
  });

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function listed(query = ''): Promise<Summary[]> {
    const res = await admin.req('GET', `/workers${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ workers: Summary[] }>().workers;
  }

  async function overviewIds(): Promise<string[]> {
    const res = await admin.req('GET', '/fleet/overview');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ workers: { id: string }[] }>().workers.map((w) => w.id);
  }

  async function errorOf(id: string, action: 'archive' | 'unarchive'): Promise<[number, string]> {
    const res = await admin.req('POST', `/workers/${id}/${action}`, {});
    return [res.statusCode, res.json<{ error?: string }>().error ?? ''];
  }

  async function seed(id: string, state: string, opts: { reason?: string; cred?: string } = {}) {
    const now = h.clock.now();
    await h.db.pool.query(
      `INSERT INTO workers (id, display_name, state, quarantine_reason, facts, worker_version, last_seen_at,
                            approved_at, created_at, updated_at)
       VALUES ($1, $1, $2, $3, '{}'::jsonb, '1.0.0', $4, $4, $4, $4)`,
      [id, state, opts.reason ?? null, now],
    );
    if (opts.cred !== undefined) {
      const key = new TestKey();
      await h.db.pool.query(
        `INSERT INTO worker_credentials (worker_id, public_key, fingerprint, status, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, key.publicKey, key.fingerprint, opts.cred, now],
      );
    }
  }

  async function leaseFor(workerId: string): Promise<void> {
    const { job } = await jobs.create({
      project: 'alpha',
      actor: CREATOR,
      submit: true,
      spec: {
        runtime: 'codex',
        prompt: 'archive test',
        repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/archive' },
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 3600 },
      },
    });
    await jobs.acquireLease(job.id, workerId, 60 * MIN);
  }

  it('denied enrollment: archive needs step-up, hides the worker everywhere, keeps the key refused', async () => {
    const key = new TestKey();
    const w = await RawWorker.connect(url, key);
    const answer = await w.handshake({ pairingCode: 'ARCH-ABCD' });
    expect(answer.type).toBe('ENROLL_PENDING');
    const id = answer.workerId ?? '';

    // Unauthenticated → 401; pending → deny it first (409).
    expect((await h.client().req('POST', `/workers/${id}/archive`, {})).statusCode).toBe(401);
    await stepUp();
    expect(await errorOf(id, 'archive')).toEqual([409, 'not_archivable']);
    expect((await admin.req('POST', `/workers/${id}/deny`, {})).statusCode).toBe(200);
    await w.closed;

    // Stale step-up → 403.
    h.clock.advance(11 * MIN);
    const stale = await admin.req('POST', `/workers/${id}/archive`, {});
    expect(stale.statusCode).toBe(403);
    expect(stale.json<{ error: string }>().error).toBe('step_up_required');

    await stepUp();
    const res = await admin.req('POST', `/workers/${id}/archive`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Summary>()).toMatchObject({ id, state: 'quarantined' });
    expect(typeof res.json<Summary>().archivedAt).toBe('string');
    expect(await errorOf(id, 'archive')).toEqual([409, 'already_archived']);

    expect((await listed()).map((x) => x.id)).not.toContain(id);
    expect((await listed('?archived=0')).map((x) => x.id)).not.toContain(id);
    expect((await listed('?archived=1')).map((x) => x.id)).toEqual([id]);
    expect((await admin.req('GET', '/workers?archived=yes')).statusCode).toBe(400);
    const detail = await admin.req('GET', `/workers/${id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json<Summary>()).toMatchObject({ quarantineReason: 'enrollment_denied' });
    expect(detail.json<Summary>().archivedAt).not.toBeNull();
    expect(await overviewIds()).not.toContain(id);

    // The denied key stays denied: a new pairing from the same device is refused, no new worker appears.
    const retry = await RawWorker.connect(url, key);
    const refused = await retry.handshake({ pairingCode: 'ARCH-EFGH' });
    expect(refused.type === 'ERROR' && refused.payload.code).toBe('enrollment_denied');
    expect((await listed()).filter((x) => x.state === 'pending')).toEqual([]);

    // Audit: who archived, and the timeline shows it. Unarchive restores the listing, also audited.
    const { rows } = await h.db.pool.query<{ action: string; actor_id: string; metadata: unknown }>(
      `SELECT action, actor_id, metadata FROM audit_events
        WHERE target = $1 AND action IN ('worker.archive', 'worker.unarchive') ORDER BY id`,
      [id],
    );
    expect(rows).toEqual([
      {
        action: 'worker.archive',
        actor_id: adminId,
        metadata: { state: 'quarantined', reason: 'enrollment_denied' },
      },
    ]);
    const history = await admin.req('GET', `/workers/${id}/history`);
    expect(history.json<{ items: { action: string }[] }>().items.map((i) => i.action)).toContain(
      'worker.archive',
    );

    const back = await admin.req('POST', `/workers/${id}/unarchive`, {});
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json<Summary>().archivedAt).toBeNull();
    expect((await listed()).map((x) => x.id)).toContain(id);
    expect(await listed('?archived=1')).toEqual([]);
    expect(await errorOf(id, 'unarchive')).toEqual([409, 'not_archived']);
    const after = await h.db.pool.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_events WHERE target = $1 AND action = 'worker.unarchive'`,
      [id],
    );
    expect(after.rows).toEqual([{ action: 'worker.unarchive', actor_id: adminId }]);
  });

  it('refuses a still-valid worker (revoke first); a revoked worker can be archived and stays refused', async () => {
    const key = new TestKey();
    const w = await RawWorker.connect(url, key);
    const answer = await w.handshake({ pairingCode: 'ARCH-JKLM' });
    const id = answer.workerId ?? '';
    await stepUp();
    expect((await admin.req('POST', `/workers/${id}/approve`, { pairingCode: 'ARCH-JKLM' })).statusCode).toBe(
      200,
    );
    await w.next('SESSION_ESTABLISHED');
    await expect.poll(async () => (await listed()).find((x) => x.id === id)?.state).toBe('online');
    expect(await errorOf(id, 'archive')).toEqual([409, 'connected']);

    // Disconnected but still enrolled (active key): refused, revoke it first.
    w.close();
    await w.closed;
    await expect.poll(async () => (await listed()).find((x) => x.id === id)?.state).toBe('offline');
    const refused = await admin.req('POST', `/workers/${id}/archive`, {});
    expect(refused.statusCode).toBe(409);
    const refusedBody = refused.json<{ error: string; message: string }>();
    expect(refusedBody.error).toBe('not_archivable');
    expect(refusedBody.message).toContain('revoke');

    expect((await admin.req('POST', `/workers/${id}/revoke`, {})).statusCode).toBe(200);
    expect((await admin.req('POST', `/workers/${id}/archive`, {})).statusCode).toBe(200);
    const again = await RawWorker.connect(url, key);
    const answer2 = await again.handshake({ pairingCode: 'ARCH-NPQR' });
    expect(answer2.type === 'ERROR' && answer2.payload.code).toBe('revoked');
  });

  it('refuses a worker that holds a lease; archives a key-less offline worker', async () => {
    await seed(BUSY_REVOKED, 'quarantined', { reason: 'revoked', cred: 'revoked' });
    await leaseFor(BUSY_REVOKED);
    await stepUp();
    const res = await admin.req('POST', `/workers/${BUSY_REVOKED}/archive`, {});
    expect(res.statusCode).toBe(409);
    const resBody = res.json<{ error: string; message: string }>();
    expect(resBody.error).toBe('has_work');
    expect(resBody.message).toContain('lease');
    expect((await listed()).map((x) => x.id)).toContain(BUSY_REVOKED);

    // Offline with an active key: refused; offline with only revoked/superseded keys: allowed.
    await seed(CONTROL, 'offline', { cred: 'active' });
    expect(await errorOf(CONTROL, 'archive')).toEqual([409, 'not_archivable']);
    await seed(KEYLESS, 'offline', { cred: 'superseded' });
    expect((await admin.req('POST', `/workers/${KEYLESS}/archive`, {})).statusCode).toBe(200);
    const meta = await h.db.pool.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_events WHERE target = $1 AND action = 'worker.archive'`,
      [KEYLESS],
    );
    expect(meta.rows).toEqual([{ metadata: { state: 'offline', reason: 'no_usable_key' } }]);

    expect(await errorOf('wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'archive')).toEqual([404, 'not_found']);
    expect(await errorOf('nope', 'unarchive')).toEqual([404, 'not_found']);
  });

  it('archived workers are excluded from placement, the offline-with-work alert and its notification', async () => {
    // Stale work recorded against archived/unarchived offline workers (e.g. data from before the archive).
    await leaseFor(KEYLESS);
    await leaseFor(CONTROL);
    const candidates = (await h.app.orchestrator.candidates('alpha')).map((c) => c.id);
    expect(candidates).toContain(CONTROL);
    expect(candidates).not.toContain(KEYLESS);
    expect(await overviewIds()).not.toContain(KEYLESS);

    h.clock.advance(15 * MIN);
    const fired = (await h.app.alerts.evaluate()).fired;
    expect(fired).toContain(`worker.offline_with_work|${CONTROL}`);
    expect(fired).not.toContain(`worker.offline_with_work|${KEYLESS}`);
    const notes = await offlineWorkersWithLeases(h.db.pool);
    const titles = notes.map((n) => n.draft.title);
    expect(titles).toContain(`Worker offline with running work: ${CONTROL}`);
    expect(titles).not.toContain(`Worker offline with running work: ${KEYLESS}`);
  });
});
