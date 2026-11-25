import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { MemoryRateLimiter } from '../../src/auth/rate-limit.js';
import { normalizeWorkerLabel } from '../../src/workers/fleet.js';
import { PgDeviceDirectory } from '../../src/workers/directory.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
const A = 'wrk_renameaaaaaaaaaaaaaaaaaaaa';
const B = 'wrk_renamebbbbbbbbbbbbbbbbbbbb';

interface Summary {
  id: string;
  name: string;
  label: string | null;
  hostname: string | null;
}

/**
 * p15-chat-cards-scroll item 4: a machine's display name. `PUT /workers/:id/name` sets `label` and the one name every
 * reader uses (`display_name`) at once; clearing it gives the hostname back; the worker's HELLO keeps the label; names
 * are unique among listed machines (case-insensitive); admin only; audited.
 */
describeIntegration('worker rename (integration)', () => {
  let h: Harness;
  let admin: Client;
  let viewer: Client;
  const key = new TestKey();

  beforeAll(async () => {
    h = new Harness();
    await h.start({ alerts: { listeners: [] } });
    await h.listen();
    await h.createUser('owner1', PW);
    const { secret } = await enroll(h, 'owner1', PW);
    admin = await fullLogin(h, 'owner1', PW, secret);
    await h.createUser('viewer1', PW, 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
    const now = h.clock.now();
    for (const [id, host] of [
      [A, 'mac-mini-01'],
      [B, 'win-box-02'],
    ] as const) {
      await h.db.pool.query(
        `INSERT INTO workers (id, display_name, state, facts, worker_version, last_seen_at, approved_at,
                              created_at, updated_at)
         VALUES ($1, $2, 'offline', $3, '1.0.0', $4, $4, $4, $4)`,
        [id, host, JSON.stringify({ hostname: host, os: 'linux', arch: 'x64' }), now],
      );
    }
    await h.db.pool.query(
      `INSERT INTO worker_credentials (worker_id, public_key, fingerprint, status, created_at, activated_at)
       VALUES ($1, $2, $3, 'active', $4, $4)`,
      [A, key.publicKey, key.fingerprint, now],
    );
  });
  afterAll(async () => {
    await h.stop();
  });

  async function rename(
    c: Client,
    id: string,
    name: string | null,
  ): Promise<[number, Summary & { error?: string }]> {
    const res = await c.req('PUT', `/workers/${id}/name`, { name });
    return [res.statusCode, res.json<Summary & { error?: string }>()];
  }
  async function shown(id: string): Promise<Summary | undefined> {
    const res = await admin.req('GET', '/workers');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ workers: Summary[] }>().workers.find((w) => w.id === id);
  }

  it('sets, keeps across HELLO, refuses duplicates and bad names, clears back to the hostname; admin only, audited', async () => {
    expect(await shown(A)).toMatchObject({ name: 'mac-mini-01', label: null, hostname: 'mac-mini-01' });

    const [st, body] = await rename(admin, A, '  Ofis   Mac  ');
    expect(st, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ id: A, name: 'Ofis Mac', label: 'Ofis Mac', hostname: 'mac-mini-01' });
    expect(await shown(A)).toMatchObject({ name: 'Ofis Mac', label: 'Ofis Mac' });

    // The worker reconnects (HELLO with a new hostname): the label stays the name, the hostname is refreshed.
    const directory = new PgDeviceDirectory({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      limiter: new MemoryRateLimiter(() => h.clock.now().getTime()),
      clock: h.clock.now,
    });
    const hello = {
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
      pairingCode: null,
      facts: { hostname: 'mac-mini-renamed', os: 'linux', arch: 'x64' },
      workerVersion: '1.0.1',
      negotiatedVersion: '1.0',
      ip: '127.0.0.1',
      resumeFromSeq: 0,
    } as unknown as Parameters<PgDeviceDirectory['authenticate']>[0];
    expect((await directory.authenticate(hello)).kind).toBe('session');
    expect(await shown(A)).toMatchObject({
      name: 'Ofis Mac',
      label: 'Ofis Mac',
      hostname: 'mac-mini-renamed',
    });

    // Another machine may not take the same name (any case); too long / control characters → 400.
    const [dup, dupBody] = await rename(admin, B, 'ofis mac');
    expect([dup, dupBody.error]).toEqual([409, 'worker_name_taken']);
    expect((await rename(admin, B, 'x'.repeat(61)))[0]).toBe(400);
    expect((await rename(admin, B, 'bad\u0007name'))[0]).toBe(400);
    expect((await rename(admin, B, 'x'.repeat(60)))[0]).toBe(200);

    // A viewer cannot rename; unknown worker → 404.
    expect((await rename(viewer, A, 'Hijack'))[0]).toBe(403);
    expect((await rename(admin, 'wrk_unknownaaaaaaaaaaaaaaaaaaa', 'X'))[0]).toBe(404);

    // Clearing: the hostname again (and the next HELLO refreshes it).
    const [cleared, cb] = await rename(admin, A, '');
    expect(cleared).toBe(200);
    expect(cb).toMatchObject({ name: 'mac-mini-renamed', label: null });
    expect((await rename(admin, A, null))[0]).toBe(200);

    const audit = await h.db.pool.query<{ action: string; metadata: { from: string; to: string } }>(
      `SELECT action, metadata FROM audit_events WHERE action = 'worker.rename' AND target = $1 ORDER BY id`,
      [A],
    );
    expect(audit.rows.map((r) => [r.metadata.from, r.metadata.to])).toEqual([
      ['mac-mini-01', 'Ofis Mac'],
      ['Ofis Mac', 'mac-mini-renamed'],
      ['mac-mini-renamed', 'mac-mini-renamed'],
    ]);
  });
});

it('normalizeWorkerLabel trims, folds spaces, clears empty names and refuses control characters / > 60', () => {
  expect(normalizeWorkerLabel(null)).toBeNull();
  expect(normalizeWorkerLabel('   ')).toBeNull();
  expect(normalizeWorkerLabel(' a   b ')).toBe('a b');
  expect(normalizeWorkerLabel('ğ'.repeat(60))).toBe('ğ'.repeat(60));
  expect(() => normalizeWorkerLabel('ğ'.repeat(61))).toThrow();
  expect(() => normalizeWorkerLabel('a\nb')).toThrow();
});
