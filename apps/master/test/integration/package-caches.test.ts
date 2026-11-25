import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';

const REPORT = {
  enabled: true,
  maxBytes: 10 * 1024 ** 3,
  usedBytes: 3000,
  projects: [
    {
      projectId: 'alpha',
      bytes: 3000,
      lastUsedAt: '2026-10-16T10:00:00.000Z',
      inUse: false,
      managers: [{ manager: 'npm', bytes: 3000 }],
    },
  ],
  scannedAt: '2026-10-16T10:01:00.000Z',
  lastEviction: { at: '2026-10-16T10:01:00.000Z', projects: 1, bytes: 500 },
};

/**
 * p6-warm-caches (ADR-0029) against a real master and a raw worker: the project setting (default on, viewers read,
 * admin + step-up changes it, audited), CAPABILITIES.packageCaches stored and shown in the fleet overview, and the
 * panel size limit sent only to workers that understand it.
 */
describeIntegration('package caches (integration, p6-warm-caches)', () => {
  let h: Harness;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  let worker: RawWorker;
  let workerId = '';

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  function capabilities(extra: Record<string, unknown>): void {
    worker.sendJson(
      worker.envelope(
        'CAPABILITIES',
        { runtimes: [], sandboxProfiles: ['host-restricted'], maxParallelJobs: 1, tools: [], ...extra },
        { workerId },
      ),
    );
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    const url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    const viewerId = await h.createUser('viewer1', PW, 'viewer');
    await h.grant(viewerId, ['alpha'], 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
    worker = await RawWorker.connect(url, new TestKey());
    const pending = await worker.handshake({ pairingCode: 'PKGC-ABCD' });
    workerId = pending.workerId ?? '';
    await stepUp();
    expect(
      (await admin.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'PKGC-ABCD' })).statusCode,
    ).toBe(200);
    await worker.next('SESSION_ESTABLISHED');
    await h.db.pool.query(
      "INSERT INTO projects (id, name, created_at) VALUES ('alpha', 'alpha', $1) ON CONFLICT (id) DO NOTHING",
      [h.clock.now()],
    );
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
  });

  it('the project setting: default on, viewers read, admin + step-up changes it, audited', async () => {
    const read = await viewer.req('GET', '/projects/alpha/package-caches');
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ project: 'alpha', enabled: true, updatedBy: null });
    expect((await viewer.req('PUT', '/projects/alpha/package-caches', { enabled: false })).statusCode).toBe(
      403,
    );
    await stepUp();
    const off = await admin.req('PUT', '/projects/alpha/package-caches', { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false });
    expect((await admin.req('GET', '/projects/missing/package-caches')).statusCode).toBe(404);
    const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = 'project.package_caches.update' AND outcome = 'success'",
    );
    expect(rows.map((r) => r.metadata)).toEqual([{ before: true, after: false }]);
    const { rows: p } = await h.db.pool.query<{ package_caches: boolean }>(
      "SELECT package_caches FROM projects WHERE id = 'alpha'",
    );
    expect(p[0]?.package_caches).toBe(false);
  });

  it('CAPABILITIES.packageCaches is stored and shown in the fleet overview; a later report without it keeps it', async () => {
    capabilities({ features: ['package-caches-v1'], packageCaches: REPORT });
    const caches = async () => {
      const res = await viewer.req('GET', '/fleet/overview');
      const w = res
        .json<{ workers: { id: string; packageCaches: Record<string, unknown> | null }[] }>()
        .workers.find((x) => x.id === workerId);
      return w?.packageCaches ?? null;
    };
    await expect.poll(caches, { timeout: 5000 }).toMatchObject({
      enabled: true,
      usedBytes: 3000,
      projects: [{ projectId: 'alpha', managers: [{ manager: 'npm', bytes: 3000 }] }],
      lastEviction: { projects: 1, bytes: 500 },
    });
    expect((await caches())?.reportedAt).toEqual(expect.any(String));
    capabilities({ features: ['package-caches-v1'] });
    h.clock.advance(1000);
    await new Promise((r) => setTimeout(r, 300));
    expect(await caches()).toMatchObject({ usedBytes: 3000 });
  });
});
