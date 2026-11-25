import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEED_CONTEXT, keyIdOf } from '../../src/updates/feed.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ format: 'jwk' }).x ?? '';
const foreign = generateKeyPairSync('ed25519');

function release(version: string, extra: Record<string, unknown> = {}) {
  return {
    version,
    publishedAt: '2026-10-23T10:00:00.000Z',
    minWorkerVersion: '1.0.75',
    migrationsHead: '0147',
    breaking: [],
    summary: `Remyral ${version}`,
    notes: `- notes of ${version}`,
    ...extra,
  };
}
function feedBytes(generatedAt: string, versions: string[]): Buffer {
  const doc = {
    schema: 1,
    name: 'remyral-control-plane',
    channel: 'stable',
    generatedAt,
    releases: versions.map((v) => release(v)),
  };
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
}
function sigOf(bytes: Buffer, key = privateKey, pub = PUB): string {
  return JSON.stringify({
    keyId: keyIdOf(pub),
    signature: sign(null, Buffer.concat([Buffer.from(FEED_CONTEXT), bytes]), key).toString('base64url'),
  });
}

/**
 * p16-selfhost-onboarding against a real master (Postgres, Redis, migration 0148): the one-time setup token for the
 * first owner, the owners' setup wizard progress, and the signed update feed behind the "Güncelleme mevcut" banner.
 */
describeIntegration(
  'p16-selfhost-onboarding: setup token, wizard, update feed (integration)',
  { timeout: 60_000 },
  () => {
    const h = new Harness();
    let dir: string;
    let remote: { feed: Buffer; sig: string } | null = null;
    let owner: Client;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'remyral-update-'));
      await h.start({
        updates: {
          currentVersion: '1.0.0',
          keys: [PUB],
          feedUrl: 'https://releases.test/remyral/feed.json',
          feedFile: join(dir, 'feed.json'),
          fetch: (url) => {
            if (remote === null) return Promise.reject(new Error('offline'));
            const body = url.endsWith('/feed.sig.json') ? remote.sig : remote.feed;
            return Promise.resolve(new Response(body, { status: 200 }));
          },
        },
      });
    });
    afterAll(async () => {
      await h.stop();
      await rm(dir, { recursive: true, force: true });
    });

    describe('setup token (first owner)', () => {
      it('a fresh install needs setup; a wrong, expired or weak attempt creates nothing', async () => {
        const c = h.client();
        expect((await c.req('GET', '/setup/status')).json()).toEqual({ required: true });

        const short = await h.app.setup.issue({ ttlMs: 60_000 });
        h.clock.advance(120_000);
        let r = await c.req('POST', '/setup/owner', { token: short.token, username: 'acme', password: PW });
        expect(r.statusCode).toBe(401);
        expect(r.json()).toMatchObject({ error: 'invalid_setup_token' });

        const { token } = await h.app.setup.issue();
        r = await c.req('POST', '/setup/owner', {
          token: `${token.slice(0, -1)}a`,
          username: 'acme',
          password: PW,
        });
        expect(r.statusCode).toBe(401);
        r = await c.req('POST', '/setup/owner', { token, username: 'acme', password: 'short' });
        expect(r.statusCode).toBe(400);
        expect(r.json()).toMatchObject({ error: 'weak_password' });
        r = await c.req('POST', '/setup/owner', { token, username: 'A!', password: PW });
        expect(r.json()).toMatchObject({ error: 'invalid_username' });
        const { rows } = await h.db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
        expect(rows[0]?.n).toBe('0');
      });

      it('the token creates exactly one owner (concurrent claims), is stored hashed, and setup then closes', async () => {
        const { token } = await h.app.setup.issue();
        const stored = await h.db.pool.query<{ token_hash: Buffer }>(
          'SELECT token_hash FROM setup_tokens WHERE used_at IS NULL',
        );
        expect(stored.rows).toHaveLength(1);
        expect(stored.rows[0]?.token_hash.toString('utf8')).not.toContain(token);
        const [a, b] = await Promise.all([
          h.client('198.51.100.21').req('POST', '/setup/owner', { token, username: 'acme', password: PW }),
          h.client('198.51.100.22').req('POST', '/setup/owner', { token, username: 'acme2', password: PW }),
        ]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
        const { rows } = await h.db.pool.query<{ username: string; role: string }>(
          'SELECT username, role FROM users',
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.role).toBe('owner');
        expect((await h.client().req('GET', '/setup/status')).json()).toEqual({ required: false });
        await expect(h.app.setup.issue()).rejects.toMatchObject({ code: 'setup_done' });
        const again = await h
          .client()
          .req('POST', '/setup/owner', { token, username: 'other', password: PW });
        expect(again.statusCode).toBe(409);
        expect(again.json()).toMatchObject({ error: 'setup_done' });
        const audit = await h.db.pool.query<{ action: string; actor_id: string; outcome: string }>(
          `SELECT action, actor_id, outcome FROM audit_events WHERE action IN ('user.create', 'setup.token.claim', 'setup.token.issue') ORDER BY id`,
        );
        expect(audit.rows.filter((x) => x.action === 'user.create')).toEqual([
          { action: 'user.create', actor_id: 'setup-token', outcome: 'success' },
        ]);
        expect(audit.rows.some((x) => x.action === 'setup.token.claim' && x.outcome === 'denied')).toBe(true);
        expect(JSON.stringify(audit.rows)).not.toContain(token);
      });

      it('the new owner signs in through the normal flow: authenticator enrollment first', async () => {
        const { rows } = await h.db.pool.query<{ username: string }>('SELECT username FROM users');
        const username = rows[0]?.username ?? '';
        const c = h.client();
        const login = await c.req('POST', '/auth/login', { username, password: PW });
        expect(login.json()).toMatchObject({ status: 'enrollment_required' });
        owner = (await enroll(h, username, PW)).client;
      });
    });

    describe('setup wizard', () => {
      it('owners see the wizard with detected facts; marks, organisation name and completion are kept', async () => {
        let r = await owner.req('GET', '/onboarding');
        expect(r.statusCode).toBe(200);
        let v = r.json<{
          visible: boolean;
          current: string;
          steps: { id: string; state: string; detected: boolean }[];
          progress: { done: number; total: number };
        }>();
        expect(v.visible).toBe(true);
        expect(v.steps.find((s) => s.id === 'account')).toEqual({
          id: 'account',
          state: 'done',
          detected: true,
        });
        // p17-memory-import: "Seni tanıyalım" follows the account step (optional, skippable).
        expect(v.current).toBe('about_you');
        expect(v.progress).toEqual({ done: 1, total: 10 });
        r = await owner.req('PUT', '/onboarding/steps/about_you', { state: 'skipped' });
        expect(r.json<{ current: string }>().current).toBe('organisation');

        r = await owner.req('PUT', '/onboarding/organisation', { name: '  Acme   Yazılım  ' });
        // p17-remyral-brand: the domain step follows the organisation name (read-only; the owner marks it).
        expect(r.json()).toMatchObject({ organisationName: 'Acme Yazılım', current: 'domain' });
        r = await owner.req('PUT', '/onboarding/steps/domain', { state: 'done' });
        expect(r.json<{ current: string }>().current).toBe('security');
        r = await owner.req('PUT', '/onboarding/organisation', { name: 'x\u0007' });
        expect(r.statusCode).toBe(400);
        r = await owner.req('PUT', '/onboarding/steps/security', { state: 'skipped' });
        expect(r.json<{ current: string }>().current).toBe('machine');
        r = await owner.req('PUT', '/onboarding/steps/nope', { state: 'done' });
        expect(r.statusCode).toBe(400);
        expect(r.json()).toMatchObject({ error: 'unknown_step' });

        await h.db.pool.query(
          "INSERT INTO projects (id, name, created_by, created_at) SELECT 'demo', 'Demo', id, now() FROM users LIMIT 1",
        );
        v = (await owner.req('GET', '/onboarding')).json();
        expect(v.steps.find((s) => s.id === 'project')).toMatchObject({ state: 'done', detected: true });
        r = await owner.req('PUT', '/onboarding/steps/security', { state: 'todo' });
        expect(r.json<{ current: string }>().current).toBe('security');

        r = await owner.req('POST', '/onboarding/complete');
        expect(r.json()).toMatchObject({ visible: false });
        expect((await owner.req('GET', '/onboarding')).json()).toMatchObject({
          visible: false,
          organisationName: 'Acme Yazılım',
        });
        r = await owner.req('POST', '/onboarding/reopen');
        expect(r.json()).toMatchObject({ visible: true, completedAt: null });
        const audit = await h.db.pool.query<{ action: string }>(
          "SELECT action FROM audit_events WHERE action LIKE 'onboarding.%' ORDER BY id",
        );
        expect(audit.rows.map((x) => x.action)).toEqual([
          'onboarding.step',
          'onboarding.organisation',
          'onboarding.step',
          'onboarding.step',
          'onboarding.step',
          'onboarding.complete',
          'onboarding.reopen',
        ]);
      });

      it('admins and viewers cannot read or change it', async () => {
        await h.createUser('admin1', PW, 'admin');
        const admin = (await enroll(h, 'admin1', PW)).client;
        expect((await admin.req('GET', '/onboarding')).statusCode).toBe(403);
        expect((await admin.req('POST', '/onboarding/complete')).statusCode).toBe(403);
        expect((await admin.req('GET', '/updates/status')).statusCode).toBe(403);
      });
    });

    describe('update feed', () => {
      it('nothing reachable yet: not available, an error, no banner', async () => {
        await h.app.updates.refresh();
        const s = (await owner.req('GET', '/updates/status')).json<Record<string, unknown>>();
        expect(s).toMatchObject({
          configured: true,
          currentVersion: '1.0.0',
          updateAvailable: false,
          latest: null,
          error: 'unreachable',
          command: null,
        });
      });

      it('a signed feed (URL) shows the newer releases and the host command', async () => {
        const bytes = feedBytes('2026-10-23T11:00:00.000Z', ['1.1.0', '1.0.0', '0.9.0', '1.2.0-rc.1']);
        remote = { feed: bytes, sig: sigOf(bytes) };
        await h.app.updates.refresh();
        const s = (await owner.req('POST', '/updates/check')).json<{
          updateAvailable: boolean;
          newer: { version: string }[];
          latest: { version: string };
          command: string;
          source: string;
          error: string | null;
        }>();
        expect(s.updateAvailable).toBe(true);
        expect(s.newer.map((r) => r.version)).toEqual(['1.2.0-rc.1', '1.1.0']);
        expect(s.latest.version).toBe('1.2.0-rc.1');
        expect(s.command).toBe('sudo remyral-ctl upgrade --to 1.2.0-rc.1');
        expect(s.source).toBe('url');
        expect(s.error).toBeNull();
      });

      it('a feed signed by another key or changed after signing is ignored; the last good one stays', async () => {
        const bytes = feedBytes('2026-10-24T00:00:00.000Z', ['9.9.9']);
        const pub2 = foreign.publicKey.export({ format: 'jwk' }).x ?? '';
        remote = { feed: bytes, sig: sigOf(bytes, foreign.privateKey, pub2) };
        await h.app.updates.refresh();
        let s = h.app.updates.status();
        expect(s.error).toBe('unknown_key');
        expect(s.latest?.version).toBe('1.2.0-rc.1');
        const good = feedBytes('2026-10-24T00:00:00.000Z', ['9.9.9']);
        remote = { feed: Buffer.from(good.toString().replace('9.9.9', '9.9.8')), sig: sigOf(good) };
        await h.app.updates.refresh();
        s = h.app.updates.status();
        expect(s.error).toBe('bad_signature');
        expect(s.latest?.version).toBe('1.2.0-rc.1');
      });

      it('off-line: the copy remyral-ctl cached on the host is read (the newer generatedAt wins)', async () => {
        remote = null;
        const bytes = feedBytes('2026-10-25T00:00:00.000Z', ['1.3.0', '1.1.0']);
        await writeFile(join(dir, 'feed.json'), bytes);
        await writeFile(join(dir, 'feed.sig.json'), sigOf(bytes));
        await h.app.updates.refresh();
        const s = h.app.updates.status();
        expect(s.source).toBe('file');
        expect(s.latest?.version).toBe('1.3.0');
        expect(s.newer.map((r) => r.version)).toEqual(['1.3.0', '1.1.0']);
        expect(s.error).toBe('unreachable');
      });
    });
  },
);
