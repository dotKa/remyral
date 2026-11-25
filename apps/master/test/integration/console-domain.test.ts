import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Resolver } from '../../src/console-domain/dns.js';
import { DOMAIN_CHANGE_CONTEXT } from '../../src/console-domain/host-files.js';
import { LeaseSigner } from '../../src/orchestration/lease-signer.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';

interface StatusBody {
  readonly origin: string | null;
  readonly host: Record<string, unknown>;
  readonly request: { readonly id: string; readonly state: string; readonly domain: string } | null;
}
const ENV = 'https://env.example.com';
const keys = generateKeyPairSync('ed25519');
const signer = new LeaseSigner(keys.privateKey);

/** A fake DNS: names → addresses; `ENOTFOUND` / `ETIMEOUT` names throw like node:dns does. */
const DNS: Record<string, string[] | 'ENOTFOUND' | 'ETIMEOUT'> = {
  'env.example.com': ['203.0.113.10'],
  'console.example.com': ['203.0.113.10'],
  'good.example.com': ['203.0.113.10', '2001:db8::10'],
  'host-only.example.com': ['192.0.2.77'],
  'cf.example.com': ['104.16.1.1', '172.67.1.1'],
  'other.example.com': ['198.51.100.9'],
  'missing.example.com': 'ENOTFOUND',
  'slow.example.com': 'ETIMEOUT',
};
const lookups: string[] = [];
const resolver: Resolver = {
  resolve4: (host) => answer(host, 4),
  resolve6: (host) => answer(host, 6),
};
function answer(host: string, family: 4 | 6): Promise<string[]> {
  lookups.push(`${String(family)} ${host}`);
  const a = DNS[host] ?? 'ENOTFOUND';
  if (typeof a === 'string') return Promise.reject(Object.assign(new Error(a), { code: a }));
  return Promise.resolve(a.filter((x) => (family === 6 ? x.includes(':') : !x.includes(':'))));
}

/**
 * p17-domain-wizard against a real master (Postgres, Redis, migration 0151): the public address as a stored setting
 * (precedence over PUBLIC_ORIGIN, used by links at once), owners only with the `console.domain` step-up, the DNS check,
 * and for a remyral-ctl host the signed domain change request and the result file round trip (applied, rolled back,
 * refused, expired, cancelled).
 */
describeIntegration(
  'p17-domain-wizard: console address and host domain changes (integration)',
  { timeout: 60_000 },
  () => {
    const h = new Harness();
    let hostDir: string;
    let owner: Client;
    let ownerSecret: string;
    let admin: Client;

    const status = async () => (await owner.req('GET', '/console-domain')).json<StatusBody>();
    const stepUp = async () => {
      h.clock.advance(30_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
    };
    const heartbeat = async (over: Record<string, unknown> = {}) => {
      await writeFile(
        join(hostDir, 'status/applier.json'),
        `${JSON.stringify(
          {
            kind: 'remyral-host-applier/v1',
            version: '1.2.0',
            at: h.clock.now().toISOString(),
            domain: 'console.example.com',
            tls: 'letsencrypt',
            acmeEmail: 'ops@example.com',
            httpsPort: '',
            addresses: ['192.0.2.77'],
            ...over,
          },
          null,
          2,
        )}\n`,
      );
    };
    const hostResult = async (id: string, state: string, detail = '') => {
      await writeFile(
        join(hostDir, 'status/domain-result.json'),
        `${JSON.stringify(
          {
            kind: 'remyral-host-domain-result/v1',
            id,
            state,
            domain: 'new.example.com',
            detail,
            at: `${h.clock.now().toISOString().slice(0, 19)}Z`,
          },
          null,
          2,
        )}\n`,
      );
    };
    const auditOf = async (action: string) =>
      (
        await h.db.pool.query<{
          actor_type: string;
          actor_id: string;
          outcome: string;
          metadata: Record<string, unknown>;
        }>('SELECT actor_type, actor_id, outcome, metadata FROM audit_events WHERE action = $1 ORDER BY id', [
          action,
        ])
      ).rows;

    beforeAll(async () => {
      hostDir = await mkdtemp(join(tmpdir(), 'remyral-host-'));
      await mkdir(join(hostDir, 'requests'));
      await mkdir(join(hostDir, 'status'));
      await h.start({
        installers: { publicOrigin: ENV },
        notifications: { publicUrl: `${ENV}/` },
        orchestration: { tickIntervalMs: 0, signer },
        consoleDomain: { hostDir, resolver },
      });
      await h.createUser('owner1', PW, 'owner');
      ({ client: owner, secret: ownerSecret } = await enroll(h, 'owner1', PW));
      await h.createUser('admin1', PW, 'admin');
      ({ client: admin } = await enroll(h, 'admin1', PW));
    });
    afterAll(async () => {
      await h.stop();
      await rm(hostDir, { recursive: true, force: true });
    });
    beforeEach(async () => {
      // Every test's requests are newer than the previous test's (the latest request is shown).
      h.clock.advance(1_000);
      await rm(join(hostDir, 'status/applier.json'), { force: true });
      await rm(join(hostDir, 'status/domain-result.json'), { force: true });
    });

    describe('the public address as a setting (no host applier)', () => {
      it('falls back to PUBLIC_ORIGIN; owners only', async () => {
        const s = await status();
        expect(s).toMatchObject({
          origin: ENV,
          source: 'environment',
          setting: null,
          environment: ENV,
          host: { managed: false },
          request: null,
        });
        expect((await admin.req('GET', '/console-domain')).statusCode).toBe(403);
        expect((await admin.req('PUT', '/console-domain', { domain: 'x.example.com' })).statusCode).toBe(403);
      });

      it('saving needs the authenticator under the policy, validates the name, and links use it at once', async () => {
        h.clock.advance(20 * 60_000);
        const refused = await owner.req('PUT', '/console-domain', { domain: 'console.example.org' });
        expect(refused.statusCode).toBe(403);
        expect(refused.body).toContain('step_up_required');
        await stepUp();
        for (const bad of [
          'https://x.example.com/path',
          'localhost',
          '10.0.0.1',
          'a b.com',
          'x.example.com:8443',
        ]) {
          const r = await owner.req('PUT', '/console-domain', { domain: bad });
          expect(r.statusCode, bad).toBe(400);
          expect(r.json(), bad).toMatchObject({ error: 'invalid_domain' });
        }
        const r = await owner.req('PUT', '/console-domain', { domain: ' https://Console.Example.Org/ ' });
        expect(r.statusCode).toBe(200);
        expect(r.json()).toMatchObject({
          mode: 'setting',
          origin: 'https://console.example.org',
          status: {
            origin: 'https://console.example.org',
            source: 'setting',
            setting: { source: 'owner' },
          },
        });
        // Install commands, the GitHub App callback, notification links: the saved address, without a restart.
        expect((await owner.req('GET', '/installers')).json()).toMatchObject({
          publicOrigin: 'https://console.example.org',
          masterUrl: 'wss://console.example.org/v1/worker',
        });
        expect((await owner.req('GET', '/integrations/github')).json()).toMatchObject({
          available: true,
          consoleOrigin: 'https://console.example.org',
        });
        expect(h.app.consoleDomain.notifyBase()).toBe('https://console.example.org');
        expect(h.app.consoleDomain.consoleHosts().sort()).toEqual(['console.example.org', 'env.example.com']);
        const audit = await auditOf('console.domain.set');
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actor_type: 'user', outcome: 'success' });
        expect(audit[0]?.metadata).toMatchObject({
          origin: 'https://console.example.org',
          previous: ENV,
          applied: 'setting-only',
        });
      });

      it('another instance sees the saved address on its next tick; forgetting it goes back to the environment', async () => {
        await h.db.pool.query(
          "UPDATE console_domain_setting SET public_origin = 'https://elsewhere.example.com' WHERE id = 1",
        );
        await h.app.consoleDomain.tick();
        expect(h.app.consoleDomain.current()).toBe('https://elsewhere.example.com');
        const r = await owner.req('DELETE', '/console-domain');
        expect(r.statusCode).toBe(200);
        expect(r.json()).toMatchObject({ origin: ENV, source: 'environment', setting: null });
        expect(h.app.consoleDomain.notifyBase()).toBe(ENV);
        expect((await auditOf('console.domain.clear'))[0]?.metadata).toMatchObject({
          previous: 'https://elsewhere.example.com',
        });
      });
    });

    describe('DNS check', () => {
      const check = async (domain: string) =>
        (await owner.req('POST', '/console-domain/dns-check', { domain })).json<Record<string, unknown>>();

      it('compares the new name with the current one and the host addresses', async () => {
        expect(await check('good.example.com')).toMatchObject({
          verdict: 'match',
          addresses: ['2001:db8::10', '203.0.113.10'],
          expected: ['203.0.113.10'],
        });
        expect(await check('other.example.com')).toMatchObject({
          verdict: 'mismatch',
          addresses: ['198.51.100.9'],
        });
        expect(await check('cf.example.com')).toMatchObject({ verdict: 'cloudflare' });
        expect(await check('missing.example.com')).toMatchObject({ verdict: 'not_found', addresses: [] });
        expect(await check('slow.example.com')).toMatchObject({ verdict: 'error', detail: 'ETIMEOUT' });
        // The host applier's addresses count too (a name that points only at this host's interface).
        await heartbeat();
        expect(await check('host-only.example.com')).toMatchObject({ verdict: 'match' });
        const bad = await owner.req('POST', '/console-domain/dns-check', { domain: 'not a name' });
        expect(bad.statusCode).toBe(400);
        expect(
          (await admin.req('POST', '/console-domain/dns-check', { domain: 'good.example.com' })).statusCode,
        ).toBe(403);
      });
    });

    describe('a remyral-ctl host: signed requests and the result round trip', () => {
      it('writes a request signed with the lease key; applied → the setting follows', async () => {
        await heartbeat();
        let s = await status();
        expect(s.host).toMatchObject({
          managed: true,
          domain: 'console.example.com',
          tls: 'letsencrypt',
          acmeEmail: 'ops@example.com',
          httpsPort: 443,
          version: '1.2.0',
        });
        await stepUp();
        const r = await owner.req('PUT', '/console-domain', {
          domain: 'new.example.com',
          email: 'web@example.com',
        });
        expect(r.statusCode).toBe(200);
        const body = r.json<{ request: { id: string } }>();
        expect(body).toMatchObject({
          mode: 'host',
          request: {
            domain: 'new.example.com',
            tls: 'letsencrypt',
            previousDomain: 'console.example.com',
            state: 'pending',
          },
        });
        // The links do not move before the host reports the new name healthy.
        expect(h.app.consoleDomain.current()).toBe(ENV);
        const bytes = await readFile(join(hostDir, 'requests/domain-change.json'));
        const sig = JSON.parse(await readFile(join(hostDir, 'requests/domain-change.sig.json'), 'utf8')) as {
          keyId: string;
          signature: string;
        };
        expect(sig.keyId).toBe(signer.key.kid);
        expect(
          verify(
            null,
            Buffer.concat([Buffer.from(`${DOMAIN_CHANGE_CONTEXT}\n`), bytes]),
            createPublicKey(keys.privateKey),
            Buffer.from(sig.signature, 'base64url'),
          ),
        ).toBe(true);
        const doc = JSON.parse(bytes.toString('utf8')) as Record<string, string>;
        expect(Object.keys(doc)).toEqual([
          'kind',
          'id',
          'nonce',
          'domain',
          'tls',
          'email',
          'previousDomain',
          'createdAt',
          'expiresAt',
        ]);
        expect(doc).toMatchObject({
          kind: 'remyral-host-domain-change/v1',
          id: body.request.id,
          domain: 'new.example.com',
          tls: 'letsencrypt',
          email: 'web@example.com',
          previousDomain: 'console.example.com',
        });
        expect(doc.nonce).toMatch(/^[0-9a-f]{32}$/);
        expect(doc.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        // One open request at a time.
        const again = await owner.req('PUT', '/console-domain', { domain: 'third.example.com' });
        expect(again.statusCode).toBe(409);
        expect(again.json()).toMatchObject({ error: 'domain_change_in_progress' });

        // The host picks it up …
        await hostResult(doc.id ?? '', 'applying', 'switching from console.example.com');
        await h.app.consoleDomain.tick();
        expect((await status()).request).toMatchObject({ state: 'applying' });
        // … and reports the new name healthy.
        await heartbeat({ domain: 'new.example.com' });
        await hostResult(doc.id ?? '', 'applied', 'the console answers at https://new.example.com');
        await rm(join(hostDir, 'requests/domain-change.json'));
        await h.app.consoleDomain.tick();
        s = await status();
        expect(s).toMatchObject({
          origin: 'https://new.example.com',
          source: 'setting',
          setting: { origin: 'https://new.example.com', source: 'host-applier' },
          request: { state: 'applied', detail: 'the console answers at https://new.example.com' },
        });
        expect((await auditOf('console.domain.request'))[0]?.metadata).toMatchObject({
          domain: 'new.example.com',
          previousDomain: 'console.example.com',
          emailGiven: true,
        });
        expect(await auditOf('console.domain.applied')).toEqual([
          expect.objectContaining({ actor_type: 'system', actor_id: 'host-applier', outcome: 'success' }),
        ]);
      });

      it('rolled back on the host: the setting stays; the failure is audited with its reason', async () => {
        await heartbeat({ domain: 'new.example.com' });
        await stepUp();
        const r = await owner.req('PUT', '/console-domain', {
          domain: 'broken.example.com',
          tls: 'cloudflare',
        });
        expect(r.statusCode).toBe(200);
        const id = r.json<{ request: { id: string } }>().request.id;
        await hostResult(
          id,
          'rolled_back',
          'broken.example.com did not become healthy in time; back on new.example.com',
        );
        await h.app.consoleDomain.tick();
        const s = await status();
        expect(s.origin).toBe('https://new.example.com');
        expect(s.request).toMatchObject({ id, state: 'rolled_back' });
        expect((s.request as { detail?: string } | null)?.detail).toContain('back on');
        // The host consumes the request; a leftover of this request is removed by the master.
        expect(existsSync(join(hostDir, 'requests/domain-change.json'))).toBe(false);
        expect(await auditOf('console.domain.rolled_back')).toEqual([
          expect.objectContaining({ actor_id: 'host-applier', outcome: 'failure' }),
        ]);
      });

      it('a refusal the host could not attribute (bad signature) closes the waiting request', async () => {
        await heartbeat({ domain: 'new.example.com' });
        const r = await owner.req('PUT', '/console-domain', { domain: 'refused.example.com' });
        const id = r.json<{ request: { id: string } }>().request.id;
        await hostResult('', 'refused', 'signature check failed');
        await h.app.consoleDomain.tick();
        expect((await status()).request).toMatchObject({
          id,
          state: 'refused',
          detail: 'signature check failed',
        });
      });

      it('a request nobody picks up expires; a waiting one can be withdrawn', async () => {
        await heartbeat({ domain: 'new.example.com' });
        let r = await owner.req('PUT', '/console-domain', { domain: 'late.example.com' });
        expect(r.statusCode).toBe(200);
        h.clock.advance(16 * 60_000);
        await h.app.consoleDomain.tick();
        expect((await status()).request).toMatchObject({ domain: 'late.example.com', state: 'expired' });
        expect(existsSync(join(hostDir, 'requests/domain-change.json'))).toBe(false);

        await heartbeat({ domain: 'new.example.com' });
        await stepUp();
        r = await owner.req('PUT', '/console-domain', { domain: 'withdrawn.example.com' });
        expect(r.statusCode).toBe(200);
        r = await owner.req('POST', '/console-domain/request/cancel');
        expect(r.statusCode).toBe(200);
        expect(r.json()).toMatchObject({ request: { domain: 'withdrawn.example.com', state: 'cancelled' } });
        expect(existsSync(join(hostDir, 'requests/domain-change.json'))).toBe(false);
        expect((await owner.req('POST', '/console-domain/request/cancel')).statusCode).toBe(409);
      });

      it("Let's Encrypt needs an e-mail when the host has none; the name the host already serves only sets the links", async () => {
        await heartbeat({ domain: 'new.example.com', acmeEmail: '' });
        await stepUp();
        let r = await owner.req('PUT', '/console-domain', { domain: 'mail.example.com', tls: 'letsencrypt' });
        expect(r.statusCode).toBe(400);
        expect(r.json()).toMatchObject({ error: 'email_required' });
        await h.db.pool.query('DELETE FROM console_domain_setting');
        await h.app.consoleDomain.load();
        r = await owner.req('PUT', '/console-domain', { domain: 'new.example.com' });
        expect(r.json()).toMatchObject({ mode: 'setting', origin: 'https://new.example.com' });
        expect(existsSync(join(hostDir, 'requests/domain-change.json'))).toBe(false);
        r = await owner.req('PUT', '/console-domain', { domain: 'new.example.com' });
        expect(r.statusCode).toBe(409);
        expect(r.json()).toMatchObject({ error: 'domain_unchanged' });
      });

      it('a stale heartbeat means no applier: saving then only stores the address', async () => {
        await heartbeat({ domain: 'new.example.com' });
        h.clock.advance(6 * 60_000);
        expect((await status()).host).toMatchObject({ managed: false, domain: 'new.example.com' });
        await stepUp();
        const r = await owner.req('PUT', '/console-domain', { domain: 'stale.example.com' });
        expect(r.json()).toMatchObject({ mode: 'setting', origin: 'https://stale.example.com' });
      });
    });

    it('the resolver saw only the names asked about (no lookups of arbitrary input on read)', () => {
      expect(lookups.every((l) => /^[46] [a-z0-9.-]+$/.test(l))).toBe(true);
    });
  },
);
