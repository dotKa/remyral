import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { TOKEN_REQUEST_LIMITS } from '../../src/api-tokens/limits.js';
import { DEFAULT_REQUEST_LIMITS } from '../../src/http/rate-policy.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { ExpiryService } from '../../src/ops-safety/expiry.js';
import { readServedCertificate } from '../../src/ops-safety/tls.js';
import { UsageStore } from '../../src/usage/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p16-ops-safety (docs/design/p16-ops-safety.md) against the real master (Postgres + Redis): keys and expiry (TLS
 * check against a local TLS server, threshold notifications once per threshold, rotation stamps, vault expiry dates,
 * the Cloudflare verify result), the rollout circuit breaker (automatic hold on simulated failures, no raising while
 * held, resume, rollback, audit), the owner's rate limits per person / API token / chat, and the cost brake (warn vs
 * block, admission holds non-urgent jobs only, assistant turns refused, an owner's lift).
 */
const PW = 'quartz-meadow-lantern-7';
const DAY = 86_400_000;
const fixtures = fileURLToPath(new URL('../fixtures/tls/', import.meta.url));

async function audits(
  h: Harness,
  action: string,
): Promise<{ target: string | null; metadata: Record<string, unknown> }[]> {
  const { rows } = await h.db.pool.query<{ target: string | null; metadata: Record<string, unknown> }>(
    'SELECT target, metadata FROM audit_events WHERE action = $1 ORDER BY id',
    [action],
  );
  return rows;
}

async function notices(
  h: Harness,
  kind: string,
): Promise<{ title: string; severity: string; recipient_id: string }[]> {
  const { rows } = await h.db.pool.query<{ title: string; severity: string; recipient_id: string }>(
    'SELECT title, severity, recipient_id::text FROM notifications WHERE kind = $1 ORDER BY created_at, id',
    [kind],
  );
  return rows;
}

describeIntegration('operations safety (integration, p16-ops-safety)', { timeout: 180_000 }, () => {
  let h: Harness;
  let owner: Client;
  let ownerSecret = '';
  let ownerId = '';
  let tls: Server;
  let tlsPort = 0;

  /** A fresh session after the clock moved past the session lifetime. */
  const relogin = async (): Promise<void> => {
    owner = await fullLogin(h, 'os-owner', PW, ownerSecret);
  };
  const stepUp = async (): Promise<void> => {
    h.clock.advance(30_000);
    const r = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
    expect(r.statusCode, r.body).toBe(200);
  };

  beforeAll(async () => {
    tls = createServer({
      key: readFileSync(`${fixtures}test-only-localhost.key.pem`),
      cert: readFileSync(`${fixtures}test-only-localhost.cert.pem`),
    });
    await new Promise<void>((resolve) => {
      tls.listen(0, '127.0.0.1', resolve);
    });
    const addr = tls.address();
    tlsPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
    h = new Harness();
    await h.start({
      opsSafety: {
        publicOrigin: `https://localhost:${String(tlsPort)}`,
        // The served certificate of the local TLS server (connect to 127.0.0.1, SNI localhost).
        readCertificate: (origin) => readServedCertificate(origin, { connectHost: '127.0.0.1' }),
        keyFiles: [
          {
            id: 'file:lease-key',
            label: 'leaseKey',
            path: '/run/secrets/lease.pem',
            rotateEveryDays: 365,
            runbook: 'x',
          },
          {
            id: 'file:totp-key',
            label: 'totpKey',
            path: '/run/secrets/missing',
            rotateEveryDays: 730,
            runbook: 'x',
          },
        ],
        // Only the lease key "exists": modified 300 days before the harness start.
        mtime: (path) =>
          Promise.resolve(
            path === '/run/secrets/lease.pem'
              ? new Date(Date.parse('2026-10-12T12:00:00Z') - 300 * DAY)
              : null,
          ),
      },
    });
    ownerId = await h.createUser('os-owner', PW, 'owner');
    const e = await enroll(h, 'os-owner', PW);
    owner = e.client;
    ownerSecret = e.secret;
  });
  afterAll(async () => {
    await h.stop();
    await new Promise<void>((resolve) => {
      tls.close(() => {
        resolve();
      });
    });
  });

  // ------------------------------------------------------------------------------------------------ expiry

  describe('keys and expiry', () => {
    it('reads the served certificate of the public origin through a TLS handshake (never its key)', async () => {
      const check = await owner.req('POST', '/ops-safety/expiry/check');
      expect(check.statusCode, check.body).toBe(200);
      const body = check.json<{
        items: { id: string; dueAt: string | null; state: string; detail: string | null }[];
      }>();
      const cert = body.items.find((i) => i.id === 'tls:public-origin');
      expect(cert?.dueAt?.slice(0, 10)).toBe('2126-09-19');
      expect(cert?.state).toBe('ok');
      expect(cert?.detail).toContain('not publicly trusted');
      const { rows } = await h.db.pool.query<{ ok: boolean }>(
        "SELECT ok FROM secret_expiry_checks WHERE item = 'tls:public-origin'",
      );
      expect(rows[0]?.ok).toBe(true);
    });

    it('reports a failed TLS check as an error, not as fine', async () => {
      const svc = new ExpiryService({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
        notifications: () => null,
        publicOrigin: 'https://localhost:1',
        readCertificate: (origin) =>
          readServedCertificate(origin, { connectHost: '127.0.0.1', timeoutMs: 2_000 }),
        cloudflareVerify: () => Promise.resolve(null),
        keyFiles: [],
      });
      await svc.refresh(true);
      const item = (await svc.list()).items.find((i) => i.id === 'tls:public-origin');
      expect(item?.state).toBe('error');
      expect(item?.detail).toMatch(/TLS check failed/);
    });

    it('lists key files by their date only, and a missing file as unknown', async () => {
      const r = await owner.req('GET', '/ops-safety/expiry');
      const items = r.json<{
        items: { id: string; ageDays: number | null; daysLeft: number | null; state: string }[];
      }>().items;
      const lease = items.find((i) => i.id === 'file:lease-key');
      expect(lease?.ageDays).toBe(300);
      expect(lease?.daysLeft).toBe(65);
      expect(lease?.state).toBe('ok');
      expect(items.find((i) => i.id === 'file:totp-key')?.state).toBe('unknown');
      // The backup identity lives off the master: unknown until the owner records a date.
      expect(items.find((i) => i.id === 'backup:age-identity')?.state).toBe('unknown');
    });

    it('notifies once per threshold (30 / 14 / 7 / 1 / expired) and starts over after a rotation stamp', async () => {
      const now = h.clock.now();
      // Created 340 days ago: due for rotation in 25 days (period 365).
      const stamp = await owner.req('POST', '/ops-safety/expiry/backup:age-identity/rotated', {
        rotatedAt: new Date(now.getTime() - 340 * DAY).toISOString(),
        note: 'created on the Mac',
      });
      expect(stamp.statusCode, stamp.body).toBe(200);
      const svc = h.app.opsSafety.expiry;
      expect(await svc.notify()).toBe(1);
      expect(await svc.notify()).toBe(0);
      let sent = (await notices(h, 'secret.expiring')).filter((n) =>
        n.title.startsWith('Backup age identity'),
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]?.title).toContain('in 30 days or less');
      expect(sent[0]?.severity).toBe('warning');
      expect(sent[0]?.recipient_id).toBe(ownerId);
      // 12 days later: 13 days left → the 14-day threshold, once.
      h.clock.advance(12 * DAY);
      expect(await svc.notify()).toBeGreaterThanOrEqual(1);
      expect(await svc.notify()).toBe(0);
      h.clock.advance(7 * DAY);
      await svc.notify();
      h.clock.advance(5 * DAY);
      await svc.notify();
      h.clock.advance(1 * DAY);
      await svc.notify();
      await relogin();
      sent = (await notices(h, 'secret.expiring')).filter((n) => n.title.startsWith('Backup age identity'));
      expect(sent.map((n) => n.title.replace(/^Backup age identity /, ''))).toEqual([
        'is due for rotation in 30 days or less',
        'is due for rotation in 14 days or less',
        'is due for rotation in 7 days or less',
        'is due for rotation in 1 day or less',
        'is overdue for rotation',
      ]);
      expect(sent.slice(2).every((n) => n.severity === 'critical')).toBe(true);
      const { rows } = await h.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM secret_expiry_notices WHERE item = 'backup:age-identity'",
      );
      expect(rows[0]?.n).toBe(5);
      // Rotated now: due in a year, nothing to send.
      expect((await owner.req('POST', '/ops-safety/expiry/backup:age-identity/rotated', {})).statusCode).toBe(
        200,
      );
      const before = (await notices(h, 'secret.expiring')).length;
      await svc.notify();
      expect(
        (await notices(h, 'secret.expiring')).filter((n) => n.title.startsWith('Backup age identity')),
      ).toHaveLength(5);
      expect((await notices(h, 'secret.expiring')).length).toBeGreaterThanOrEqual(before);
      const list = (await owner.req('GET', '/ops-safety/expiry')).json<{
        items: { id: string; state: string; rotatedAt: string | null }[];
      }>();
      const item = list.items.find((i) => i.id === 'backup:age-identity');
      expect(item?.state).toBe('ok');
      expect(item?.rotatedAt).toBe(h.clock.now().toISOString());
      const recorded = await audits(h, 'secret.rotation.recorded');
      expect(recorded.at(-1)?.target).toBe('backup:age-identity');
      expect(recorded.at(-1)?.metadata).toMatchObject({ source: 'console' });
      expect((await audits(h, 'secret.expiry.notice')).length).toBeGreaterThanOrEqual(5);
    });

    it('refuses a stamp for an unknown item or a future date', async () => {
      const unknown = await owner.req('POST', '/ops-safety/expiry/file:nope/rotated', {});
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json<{ error: string }>().error).toBe('expiry_item_unknown');
      const future = await owner.req('POST', '/ops-safety/expiry/backup:age-identity/rotated', {
        rotatedAt: new Date(h.clock.now().getTime() + DAY).toISOString(),
      });
      expect(future.statusCode).toBe(400);
      expect(future.json<{ error: string }>().error).toBe('rotation_date_invalid');
    });

    it('tracks a vault credential once an administrator records its expiry date', async () => {
      const now = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at)
         VALUES ('openrouter-main', 'OpenRouter main', 'openrouter', 'OPENROUTER_API_KEY', 1, 'active', $1, $1)`,
        [now],
      );
      const set = await owner.req('PUT', '/ops-safety/vault/openrouter-main/expiry', {
        expiresAt: new Date(now.getTime() + 5 * DAY).toISOString(),
      });
      expect(set.statusCode, set.body).toBe(200);
      const items = (await owner.req('GET', '/ops-safety/expiry')).json<{
        items: { id: string; state: string; daysLeft: number | null }[];
      }>().items;
      expect(items.find((i) => i.id === 'vault:openrouter-main')).toMatchObject({
        state: 'urgent',
        daysLeft: 5,
      });
      await h.app.opsSafety.expiry.notify();
      const sent = (await notices(h, 'secret.expiring')).filter((n) =>
        n.title.startsWith('Vault credential'),
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]?.title).toContain('expires in 7 days or less');
      expect((await audits(h, 'vault.credential.expiry')).at(-1)?.target).toBe('vault:openrouter-main');
    });

    it('takes the Cloudflare token expiry from its verify endpoint (fake API)', async () => {
      const now = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO ops_integrations (provider, config, secret, key_fingerprint, created_at, updated_at)
         VALUES ('cloudflare', '{}'::jsonb, '\\x00'::bytea, '0123456789abcdef', $1, $1)
         ON CONFLICT (provider) DO NOTHING`,
        [now],
      );
      const svc = new ExpiryService({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
        notifications: () => null,
        publicOrigin: null,
        readCertificate: () => Promise.reject(new Error('unused')),
        cloudflareVerify: () =>
          Promise.resolve({ status: 'active', expiresOn: new Date(now.getTime() + 10 * DAY).toISOString() }),
        keyFiles: [],
      });
      expect((await svc.refresh(true)).checked).toEqual(['cloudflare:token']);
      const cf = (await svc.list()).items.find((i) => i.id === 'cloudflare:token');
      expect(cf).toMatchObject({ basis: 'expires', state: 'soon', daysLeft: 10, detail: 'token active' });
      // A check that is not due is not repeated.
      expect((await svc.refresh(false)).checked).toEqual([]);
      await h.db.pool.query("DELETE FROM ops_integrations WHERE provider = 'cloudflare'");
    });
  });

  // ------------------------------------------------------------------------------------------------ breaker

  describe('rollout circuit breaker', () => {
    const W = [
      'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'wrk_bbbbbbbbbbbbbbbbbbbbbbbbbb',
      'wrk_cccccccccccccccccccccccccc',
    ];

    async function release(version: string): Promise<void> {
      await h.db.pool.query(
        `INSERT INTO worker_releases (version, channel, manifest, signature, key_id, sha256, size_bytes, protocol_versions,
                                      min_node, artifact, built_at, uploaded_at)
         VALUES ($1, 'stable', '\\x7b7d'::bytea, '{}'::jsonb, '0011223344556677', $2, 1, '["1.0"]'::jsonb, '24.0.0',
                 '\\x00'::bytea, $3, $3)`,
        [version, '0'.repeat(64), h.clock.now()],
      );
    }

    async function attempt(workerId: string, status: string, reason: string | null = null): Promise<void> {
      const now = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO worker_update_attempts (id, worker_id, from_version, to_version, source, rollback, force, status,
                                             reason, created_at, updated_at, finished_at)
         VALUES ($1, $2, '1.0.0', '1.1.0', 'channel', false, false, $3, $4, $5, $5, $5)`,
        [randomUUID(), workerId, status, reason, now],
      );
    }

    beforeAll(async () => {
      await relogin();
      const now = h.clock.now();
      for (const id of W) {
        await h.db.pool.query(
          `INSERT INTO workers (id, display_name, state, facts, worker_version, last_seen_at, approved_at, created_at, updated_at)
           VALUES ($1, $1, 'online', '{}'::jsonb, '1.0.0', $2, $2, $2, $2)`,
          [id, now],
        );
      }
      await release('1.0.0');
      await release('1.1.0');
      await stepUp();
      const r = await owner.req('PUT', '/releases/channels/stable', { version: '1.1.0', rolloutPercent: 50 });
      expect(r.statusCode, r.body).toBe(200);
    });

    it('holds the rollout when updated machines fail, notifies, audits and withdraws open offers', async () => {
      const breaker = h.app.opsSafety.breaker();
      if (breaker === null) throw new Error('no breaker');
      // One machine updated fine and is alive: nothing happens.
      await attempt(W[0] ?? '', 'succeeded');
      await h.db.pool.query("UPDATE workers SET worker_version = '1.1.0', last_seen_at = $2 WHERE id = $1", [
        W[0],
        h.clock.now(),
      ]);
      expect(await breaker.evaluate()).toEqual([]);
      // The second rolls back (health check failed); a third has an open offer.
      await attempt(W[1] ?? '', 'rolled_back', 'health_check_failed');
      await attempt(W[2] ?? '', 'offered');
      const tripped = await breaker.evaluate();
      expect(tripped).toHaveLength(1);
      expect(tripped[0]).toMatchObject({
        channel: 'stable',
        version: '1.1.0',
        rolloutPercent: 50,
        previousVersion: '1.0.0',
        reason: 'update_failures',
      });
      expect(tripped[0]?.evidence).toMatchObject({ judged: 2, failing: 1, failurePercent: 50 });
      const { rows } = await h.db.pool.query<{ status: string }>(
        'SELECT status FROM worker_update_attempts WHERE worker_id = $1',
        [W[2]],
      );
      expect(rows[0]?.status).toBe('superseded');
      expect((await audits(h, 'release.rollout.paused'))[0]?.metadata).toMatchObject({
        channel: 'stable',
        reason: 'update_failures',
        withdrawnOffers: 1,
      });
      const sent = await notices(h, 'release.rollout_paused');
      expect(sent.map((n) => n.recipient_id)).toEqual([ownerId]);
      expect(sent[0]?.severity).toBe('critical');
      // Evaluated again: one hold, not two.
      expect(await breaker.evaluate()).toEqual([]);
      const view = await owner.req('GET', '/releases/breaker');
      expect(view.statusCode).toBe(200);
      const ch = view.json<{ channels: { channel: string; hold: { reason: string } | null }[] }>().channels;
      expect(ch.find((c) => c.channel === 'stable')?.hold?.reason).toBe('update_failures');
    });

    it('never raises a held rollout (409 rollout_paused); lowering it is allowed', async () => {
      await stepUp();
      const up = await owner.req('PUT', '/releases/channels/stable', {
        version: '1.1.0',
        rolloutPercent: 100,
      });
      expect(up.statusCode).toBe(409);
      expect(up.json<{ error: string }>().error).toBe('rollout_paused');
      const down = await owner.req('PUT', '/releases/channels/stable', {
        version: '1.1.0',
        rolloutPercent: 50,
      });
      expect(down.statusCode, down.body).toBe(200);
    });

    it('resumes with a code; the failures so far are not counted again, new ones trip it again', async () => {
      h.clock.advance(20 * 60_000);
      const noCode = await owner.req('POST', '/releases/channels/stable/resume');
      expect(noCode.statusCode).toBe(403);
      await stepUp();
      const r = await owner.req('POST', '/releases/channels/stable/resume');
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json<{ hold: { resolution: string } }>().hold.resolution).toBe('resumed');
      expect(await audits(h, 'release.rollout.resumed')).toHaveLength(1);
      const breaker = h.app.opsSafety.breaker();
      if (breaker === null) throw new Error('no breaker');
      expect(await breaker.evaluate()).toEqual([]);
      h.clock.advance(60_000);
      await attempt(W[2] ?? '', 'failed', 'sha256_mismatch');
      const again = await breaker.evaluate();
      expect(again).toHaveLength(1);
    });

    it('rolls back: the channel points at the previous version and updated machines get a rollback target', async () => {
      // A machine that skipped 1.0.0 (0.9.0 -> 1.1.0) keeps 0.9.0 as its only rollback target (the worker refuses any
      // other): it is sent back to the version it came from, not to the channel's previous version.
      await release('0.9.0');
      const now = h.clock.now();
      await h.db.pool.query("UPDATE workers SET worker_version = '1.1.0' WHERE id = $1", [W[1]]);
      await h.db.pool.query(
        `INSERT INTO worker_update_attempts (id, worker_id, from_version, to_version, source, rollback, force, status,
                                             reason, created_at, updated_at, finished_at)
         VALUES ($1, $2, '0.9.0', '1.1.0', 'channel', false, false, 'succeeded', NULL, $3, $3, $3)`,
        [randomUUID(), W[1], now],
      );
      await stepUp();
      const r = await owner.req('POST', '/releases/channels/stable/rollback');
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json<{ channelVersion: string; machines: string[]; hold: { resolution: string } }>();
      expect(body).toMatchObject({ channelVersion: '1.0.0', machines: [W[0], W[1]] });
      const { rows: skipped } = await h.db.pool.query<{ target_version: string; rollback: boolean }>(
        'SELECT target_version, rollback FROM worker_update_targets WHERE worker_id = $1',
        [W[1]],
      );
      expect(skipped[0]).toEqual({ target_version: '0.9.0', rollback: true });
      expect(body.hold.resolution).toBe('rolled_back');
      const { rows: ch } = await h.db.pool.query<{ version: string }>(
        "SELECT version FROM worker_release_channels WHERE channel = 'stable'",
      );
      expect(ch[0]?.version).toBe('1.0.0');
      const { rows: t } = await h.db.pool.query<{ target_version: string; rollback: boolean }>(
        'SELECT target_version, rollback FROM worker_update_targets WHERE worker_id = $1',
        [W[0]],
      );
      expect(t[0]).toEqual({ target_version: '1.0.0', rollback: true });
      expect((await audits(h, 'release.rollout.rolled_back'))[0]?.metadata).toMatchObject({
        to: '1.0.0',
        machines: 2,
      });
      const noHold = await owner.req('POST', '/releases/channels/stable/resume');
      expect(noHold.statusCode).toBe(409);
      expect(noHold.json<{ error: string }>().error).toBe('rollout_not_paused');
    });
  });

  // ------------------------------------------------------------------------------------------------ cost brake

  describe('cost brake', () => {
    const PROJECT = 'brake-p';
    const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
    let jobs: JobStore;
    let usage: UsageStore;
    let seq = 0;

    const spec = () => ({
      runtime: 'codex',
      prompt: 'Summarise the README',
      repository: {
        url: 'https://example.com/acme/repo.git',
        baseRef: 'main',
        workBranch: `rac/b${String(++seq)}`,
      },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    });

    async function chatSpend(usd: number): Promise<void> {
      await h.db.pool.query(
        `INSERT INTO chat_turns (id, user_id, worker_id, runtime, state, cost_usd, created_at)
         VALUES ($1, $2, 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'claude-code', 'done', $3, $4)`,
        [randomUUID(), ownerId, usd, h.clock.now()],
      );
    }

    async function admitNew(priority?: number) {
      const { job } = await jobs.create({
        project: PROJECT,
        actor: CREATOR,
        submit: true,
        spec: spec(),
        ...(priority === undefined ? {} : { priority }),
      });
      const fresh = await jobs.get(job.id);
      if (fresh === null) throw new Error('no job');
      return h.app.quotas.admit(fresh);
    }

    beforeAll(async () => {
      const audit = new AuditLog(h.db.pool, h.clock.now);
      jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
      usage = new UsageStore({ pool: h.db.pool, audit, clock: h.clock.now });
      await h.grant(ownerId, [PROJECT], 'operator');
      // A new UTC day for the brake's windows.
      h.clock.advance(DAY);
      await relogin();
      await h.setSecurityPolicy({ preset: 'siki', costBrake: { dailyUsd: 1, monthlyUsd: null } });
    });

    it('warn mode (default): owners are told at the warning level and at the ceiling, nothing is held', async () => {
      await chatSpend(0.85);
      expect(await h.app.opsSafety.brake.sweep()).toBe(1);
      expect(await h.app.opsSafety.brake.sweep()).toBe(0);
      h.clock.advance(60_000);
      await chatSpend(0.3);
      expect(await h.app.opsSafety.brake.sweep()).toBe(1);
      const sent = await notices(h, 'cost.brake');
      expect(sent.map((n) => n.severity)).toEqual(['warning', 'critical']);
      expect(sent[1]?.title).toContain('ceiling reached');
      const state = (await owner.req('GET', '/cost-brake')).json<{
        mode: string;
        blocking: boolean;
        engaged: { scope: string; level: string }[];
      }>();
      expect(state).toMatchObject({ mode: 'warn', blocking: false });
      expect(state.engaged.map((c) => c.scope)).toEqual(['global']);
      expect((await admitNew()).kind).toBe('admit');
      expect((await audits(h, 'cost.brake.engaged')).length).toBe(1);
    });

    it('block mode: non-urgent jobs wait, urgent ones pass, assistant turns are refused', async () => {
      await h.setSecurityPolicy({
        preset: 'siki',
        costBrake: { dailyUsd: 1, monthlyUsd: null, mode: 'block' },
      });
      const held = await admitNew();
      expect(held.kind).toBe('hold');
      expect(JSON.stringify(held)).toContain('cost_brake');
      expect((await admitNew(60)).kind).toBe('admit');
      const thread = await owner.req('POST', '/chat/threads', { title: 'brake' });
      expect(thread.statusCode, thread.body).toBe(201);
      const id = thread.json<{ id: string }>().id;
      const msg = await owner.req('POST', `/chat/threads/${id}/messages`, { text: 'hello' });
      expect(msg.statusCode).toBe(429);
      expect(msg.json<{ error: string }>().error).toBe('cost_brake_active');
      expect((await owner.req('GET', '/cost-brake')).json<{ blocking: boolean }>().blocking).toBe(true);
    });

    it('an owner lifts it for N hours (audited); after the lift it engages again', async () => {
      await stepUp();
      const bad = await owner.req('POST', '/cost-brake/lifts', { scope: 'global', hours: 100, reason: 'x' });
      expect(bad.statusCode).toBe(400);
      const lift = await owner.req('POST', '/cost-brake/lifts', {
        scope: 'global',
        hours: 2,
        reason: 'release day',
      });
      expect(lift.statusCode, lift.body).toBe(200);
      expect((await admitNew()).kind).toBe('admit');
      expect((await audits(h, 'cost.brake.lift'))[0]?.metadata).toMatchObject({ hours: 2 });
      h.clock.advance(2 * 3_600_000 + 60_000);
      expect((await admitNew()).kind).toBe('hold');
      await relogin();
    });

    it('a project ceiling holds only that project (job spend of the project)', async () => {
      await h.setSecurityPolicy({
        preset: 'siki',
        costBrake: { dailyUsd: null, monthlyUsd: null, mode: 'block' },
      });
      expect((await admitNew()).kind).toBe('admit');
      await stepUp();
      const set = await owner.req('PUT', `/cost-brake/projects/${PROJECT}`, {
        dailyUsd: 2,
        monthlyUsd: null,
      });
      expect(set.statusCode, set.body).toBe(200);
      const { job } = await jobs.create({ project: PROJECT, actor: CREATOR, submit: true, spec: spec() });
      const grant = await jobs.acquireLease(job.id, 'worker-1', 3_600_000);
      const actor: JobActor = { type: 'worker', id: 'worker-1' };
      await jobs.transition(job.id, 'lease_acked', { actor, epoch: grant.lease.epoch });
      await jobs.transition(job.id, 'runtime_started', { actor, epoch: grant.lease.epoch });
      await usage.recordUsage(
        {
          kind: 'usage',
          provenance: 'reported-by-runtime',
          inputTokens: 10,
          outputTokens: 0,
          turns: 1,
          costUsd: 2.5,
          authMode: 'secret-ref',
          provider: 'openai',
          model: 'gpt-x',
        },
        { jobId: job.id, attemptId: grant.attempt.id, workerId: 'worker-1', sourceEventId: 'brake-1' },
      );
      expect((await admitNew()).kind).toBe('hold');
      const state = (await owner.req('GET', '/cost-brake')).json<{ engaged: { scope: string }[] }>();
      expect(state.engaged.map((c) => c.scope)).toEqual([PROJECT]);
      expect((await audits(h, 'cost.brake.project'))[0]?.target).toBe(`cost-brake:${PROJECT}`);
    });

    it('only owners lift the brake or set ceilings', async () => {
      await h.createUser('os-admin', PW, 'admin');
      const a = await enroll(h, 'os-admin', PW);
      const r = await a.client.req('POST', '/cost-brake/lifts', { scope: 'global', hours: 1, reason: 'x' });
      expect(r.statusCode).toBe(403);
      expect(r.json<{ error: string }>().error).toBe('owner_required');
    });
  });
});

describeIntegration(
  'owner rate limits per person, API token and chat (integration, p16-ops-safety)',
  { timeout: 120_000 },
  () => {
    let h: Harness;
    let owner: Client;

    beforeAll(async () => {
      h = new Harness();
      // The production budgets (scale 1), so the owner's numbers are the real limits.
      await h.start({ requestLimits: DEFAULT_REQUEST_LIMITS, tokenLimits: TOKEN_REQUEST_LIMITS });
      await h.createUser('rl-owner', PW, 'owner');
      owner = (await enroll(h, 'rl-owner', PW)).client;
    });
    afterAll(async () => {
      await h.stop();
    });

    it('applies the owner’s per-person read budget', async () => {
      await h.setSecurityPolicy({ preset: 'siki', limits: { userReadPerMinute: 10 } });
      const codes: number[] = [];
      for (let i = 0; i < 11; i += 1) codes.push((await owner.req('GET', '/chat/threads')).statusCode);
      expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
      expect(codes[10]).toBe(429);
      await h.setSecurityPolicy({ preset: 'siki' });
    });

    it('applies the owner’s per-token read budget', async () => {
      const issued = await owner.req('POST', '/me/api-tokens', {
        name: 'rl',
        scopes: ['read'],
        expiresInDays: 30,
      });
      expect(issued.statusCode, issued.body).toBe(201);
      const secret = issued.json<{ secret: string }>().secret;
      await h.setSecurityPolicy({ preset: 'siki', limits: { tokenReadPerMinute: 10 } });
      const codes: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const r = await h.app.inject({
          method: 'GET',
          url: '/jobs',
          headers: { authorization: `Bearer ${secret}` },
          remoteAddress: '198.51.100.30',
        });
        codes.push(r.statusCode);
      }
      expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
      expect(codes[10]).toBe(429);
      await h.setSecurityPolicy({ preset: 'siki' });
    });

    it('applies the chat message rate per person before anything else of a message', async () => {
      await h.setSecurityPolicy({ preset: 'siki', limits: { chatPerMinute: 2 } });
      const thread = await owner.req('POST', '/chat/threads', { title: 'rate' });
      const id = thread.json<{ id: string }>().id;
      const codes: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        codes.push(
          (await owner.req('POST', `/chat/threads/${id}/messages`, { text: `m${String(i)}` })).statusCode,
        );
      }
      // No assistant machine here: the first two are refused as unavailable, the third by the rate.
      expect(codes.slice(0, 2).every((c) => c !== 429)).toBe(true);
      expect(codes[2]).toBe(429);
      const last = await owner.req('POST', `/chat/threads/${id}/messages`, { text: 'again' });
      expect(last.json<{ error: string; params?: { reason?: string } }>()).toMatchObject({
        error: 'rate_limited',
        params: { reason: 'chat_messages' },
      });
    });
  },
);
