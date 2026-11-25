import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LeaseSigner } from '../../src/orchestration/lease-signer.js';
import { FEED_CONTEXT, keyIdOf } from '../../src/updates/feed.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const keys = generateKeyPairSync('ed25519');
const signer = new LeaseSigner(keys.privateKey);
const vendor = generateKeyPairSync('ed25519');
const VENDOR_PUB = vendor.publicKey.export({ format: 'jwk' }).x ?? '';

function feed(): { bytes: Buffer; sig: string } {
  const rel = (version: string, breaking: string[] = []) => ({
    version,
    publishedAt: '2026-10-26T10:00:00.000Z',
    minWorkerVersion: '1.0.75',
    migrationsHead: '0160',
    breaking,
    summary: `Remyral ${version}`,
    notes: `- notes of ${version}`,
  });
  const doc = {
    schema: 1,
    name: 'remyral-control-plane',
    channel: 'stable',
    generatedAt: '2026-10-26T11:00:00.000Z',
    releases: [rel('1.2.0', ['The API path /x moved']), rel('1.1.0'), rel('1.0.0')],
  };
  const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  const sig = JSON.stringify({
    keyId: keyIdOf(VENDOR_PUB),
    signature: sign(null, Buffer.concat([Buffer.from(FEED_CONTEXT), bytes]), vendor.privateKey).toString(
      'base64url',
    ),
  });
  return { bytes, sig };
}

interface Action {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly step: string | null;
  readonly detail: string | null;
  readonly log: string[];
  readonly params: Record<string, unknown>;
}

/**
 * p17-host-actions part 2 against a real master (Postgres, Redis, migration 0160): control-plane update and rollback
 * requests for the remyral-ctl host applier — owners only, always-fresh step-up, the signed request files (own domain
 * per kind, closed fields), one open request, the result round trip (steps, log tail without secrets, outcome), cancel,
 * expiry, an applier that is absent or too old, and the audit trail.
 */
describeIntegration(
  'p17-host-actions: update and rollback through the host applier (integration)',
  { timeout: 60_000 },
  () => {
    const h = new Harness();
    let hostDir: string;
    let feedDir: string;
    let owner: Client;
    let ownerSecret: string;
    let admin: Client;

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
            version: '1.0.0',
            at: h.clock.now().toISOString(),
            domain: 'console.example.com',
            tls: 'letsencrypt',
            acmeEmail: '',
            httpsPort: '',
            addresses: [],
            kinds: ['domain-change', 'upgrade', 'rollback'],
            current: '1.0.0',
            previous: '0.9.0',
            releases: ['1.0.0', '0.9.0'],
            ...over,
          },
          null,
          2,
        )}\n`,
      );
    };
    const hostResult = async (
      kind: string,
      id: string,
      state: string,
      step: string,
      detail = '',
      log: string[] = [],
    ) => {
      await writeFile(
        join(hostDir, `status/${kind}-result.json`),
        `${JSON.stringify(
          {
            kind: 'remyral-host-result/v1',
            request: kind,
            id,
            state,
            step,
            detail,
            at: `${h.clock.now().toISOString().slice(0, 19)}Z`,
            log,
          },
          null,
          2,
        )}\n`,
      );
    };
    const auditOf = async (action: string) =>
      (
        await h.db.pool.query<{ actor_type: string; outcome: string; metadata: Record<string, unknown> }>(
          'SELECT actor_type, outcome, metadata FROM audit_events WHERE action = $1 ORDER BY id',
          [action],
        )
      ).rows;
    const get = async (id: string) => (await owner.req('GET', `/host-actions/requests/${id}`)).json<Action>();

    beforeAll(async () => {
      hostDir = await mkdtemp(join(tmpdir(), 'remyral-host-'));
      feedDir = await mkdtemp(join(tmpdir(), 'remyral-feed-'));
      await mkdir(join(hostDir, 'requests'));
      await mkdir(join(hostDir, 'status'));
      const f = feed();
      await writeFile(join(feedDir, 'feed.json'), f.bytes);
      await writeFile(join(feedDir, 'feed.sig.json'), f.sig);
      await h.start({
        orchestration: { tickIntervalMs: 0, signer },
        consoleDomain: { hostDir },
        updates: {
          currentVersion: '1.0.0',
          keys: [VENDOR_PUB],
          feedUrl: null,
          feedFile: join(feedDir, 'feed.json'),
        },
      });
      await h.app.updates.refresh();
      await h.createUser('owner1', PW, 'owner');
      ({ client: owner, secret: ownerSecret } = await enroll(h, 'owner1', PW));
      await h.createUser('admin1', PW, 'admin');
      ({ client: admin } = await enroll(h, 'admin1', PW));
    });
    afterAll(async () => {
      await h.stop();
      await rm(hostDir, { recursive: true, force: true });
      await rm(feedDir, { recursive: true, force: true });
    });
    beforeEach(async () => {
      h.clock.advance(1_000);
      await rm(join(hostDir, 'status/applier.json'), { force: true });
      for (const k of ['upgrade', 'rollback'])
        await rm(join(hostDir, `status/${k}-result.json`), { force: true });
    });

    describe('without a host applier (Coolify / EC2)', () => {
      it('shows no applier and refuses requests with what the operator does instead; owners only', async () => {
        const s = (await owner.req('GET', '/host-actions')).json<{
          applier: { managed: boolean };
          open: unknown;
        }>();
        expect(s).toMatchObject({
          applier: { managed: false, kinds: [], releases: [] },
          open: null,
          recent: [],
        });
        expect((await admin.req('GET', '/host-actions')).statusCode).toBe(403);
        expect((await admin.req('POST', '/host-actions/upgrade', { version: '1.1.0' })).statusCode).toBe(403);
        await stepUp();
        const r = await owner.req('POST', '/host-actions/upgrade', { version: '1.1.0' });
        expect(r.statusCode).toBe(503);
        expect(r.json()).toMatchObject({ error: 'host_applier_unavailable' });
        // An applier without the newer request kinds (upgraded by an older remyral-ctl).
        await heartbeat({ kinds: ['domain-change'] });
        const old = await owner.req('POST', '/host-actions/upgrade', { version: '1.1.0' });
        expect(old.statusCode).toBe(409);
        expect(old.json()).toMatchObject({ error: 'host_applier_outdated' });
        // A stale heartbeat is no applier.
        await heartbeat();
        h.clock.advance(6 * 60_000);
        await stepUp();
        expect((await owner.req('POST', '/host-actions/upgrade', { version: '1.1.0' })).statusCode).toBe(503);
      });
    });

    describe('with a remyral-ctl host', () => {
      it('needs a recent authenticator code (always-fresh class)', async () => {
        await heartbeat();
        await stepUp();
        h.clock.advance(11 * 60_000);
        await heartbeat();
        const r = await owner.req('POST', '/host-actions/upgrade', { version: '1.1.0' });
        expect(r.statusCode).toBe(403);
        expect(r.body).toContain('step_up_required');
      });

      it('upgrade: validated against the verified feed; a signed request with exactly its fields; the result round trip', async () => {
        await heartbeat();
        await stepUp();
        for (const [version, code] of [
          ['1.0.0', 'release_not_in_feed'],
          ['9.9.9', 'release_not_in_feed'],
          ['1.2', 'invalid_release_version'],
          ['1.2.0', 'breaking_not_accepted'],
        ] as const) {
          const bad = await owner.req('POST', '/host-actions/upgrade', { version });
          expect(bad.json(), version).toMatchObject({ error: code });
        }
        const r = await owner.req('POST', '/host-actions/upgrade', {
          version: '1.2.0',
          acceptBreaking: true,
        });
        expect(r.statusCode).toBe(200);
        const action = r.json<Action>();
        expect(action).toMatchObject({
          kind: 'upgrade',
          state: 'pending',
          params: { version: '1.2.0', fromVersion: '1.0.0', acceptBreaking: true },
        });
        const bytes = await readFile(join(hostDir, 'requests/upgrade.json'));
        const sig = JSON.parse(await readFile(join(hostDir, 'requests/upgrade.sig.json'), 'utf8')) as {
          signature: string;
        };
        const ok = (ctx: string) =>
          verify(
            null,
            Buffer.concat([Buffer.from(`${ctx}\n`), bytes]),
            createPublicKey(keys.privateKey),
            Buffer.from(sig.signature, 'base64url'),
          );
        expect(ok('remyral-host-upgrade/v1')).toBe(true);
        expect(ok('remyral-host-domain-change/v1')).toBe(false);
        const doc = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        expect(Object.keys(doc)).toEqual([
          'kind',
          'id',
          'nonce',
          'version',
          'fromVersion',
          'acceptBreaking',
          'createdAt',
          'expiresAt',
        ]);
        expect(Object.values(doc).every((v) => typeof v === 'string')).toBe(true);
        expect(doc).toMatchObject({
          kind: 'remyral-host-upgrade/v1',
          id: action.id,
          version: '1.2.0',
          fromVersion: '1.0.0',
          acceptBreaking: 'yes',
        });
        // One open request of any kind at a time.
        const again = await owner.req('POST', '/host-actions/rollback', { version: '0.9.0' });
        expect(again.statusCode).toBe(409);
        expect(again.json()).toMatchObject({ error: 'host_request_in_progress' });

        // The host picks it up and reports steps; the console polls the request.
        await hostResult(
          'upgrade',
          action.id,
          'applying',
          'pre-upgrade backup (blocks; a failed backup stops the upgrade)',
          '',
          [
            '[ 5] pre-upgrade backup (blocks; a failed backup stops the upgrade)',
            'POSTGRES_SUPERUSER_PASSWORD=should-never-show',
          ],
        );
        let g = await get(action.id);
        expect(g).toMatchObject({
          state: 'applying',
          step: 'pre-upgrade backup (blocks; a failed backup stops the upgrade)',
        });
        expect(g.log).toEqual(['[ 5] pre-upgrade backup (blocks; a failed backup stops the upgrade)']);
        // The master is stopped during the upgrade; the new one reads the final result on its next tick.
        await hostResult(
          'upgrade',
          action.id,
          'applied',
          'health gate',
          'OK: Remyral 1.2.0 runs at https://console.example.com',
          ['[ 8] health gate', 'OK: Remyral 1.2.0 runs at https://console.example.com'],
        );
        await h.app.hostActions.tick();
        g = await get(action.id);
        expect(g).toMatchObject({
          state: 'applied',
          step: 'health gate',
          detail: 'OK: Remyral 1.2.0 runs at https://console.example.com',
        });
        expect(g.log).toContain('OK: Remyral 1.2.0 runs at https://console.example.com');
        const s = (await owner.req('GET', '/host-actions')).json<{ open: unknown; recent: Action[] }>();
        expect(s.open).toBeNull();
        expect(s.recent[0]).toMatchObject({ id: action.id, state: 'applied' });
        expect((await auditOf('host.upgrade.request'))[0]).toMatchObject({
          actor_type: 'user',
          outcome: 'success',
          metadata: { version: '1.2.0', fromVersion: '1.0.0', acceptBreaking: true },
        });
        expect((await auditOf('host.upgrade.applied'))[0]).toMatchObject({
          actor_type: 'system',
          outcome: 'success',
        });
      });

      it('rollback: only to a release kept on the host; a restore needs the backup id typed again', async () => {
        await heartbeat();
        await stepUp();
        const notOnHost = await owner.req('POST', '/host-actions/rollback', { version: '0.8.0' });
        expect(notOnHost.json()).toMatchObject({ error: 'release_not_on_host' });
        const running = await owner.req('POST', '/host-actions/rollback', { version: '1.0.0' });
        expect(running.json()).toMatchObject({ error: 'release_not_on_host' });
        const id = 'remana-prod-20261026T020000Z';
        for (const body of [
          { version: '0.9.0', backupId: id },
          { version: '0.9.0', backupId: id, restoreDatabase: true },
          { version: '0.9.0', backupId: id, restoreDatabase: true, confirm: 'remana-prod-20261026T020001Z' },
          { version: '0.9.0', restoreDatabase: true, confirm: id },
        ]) {
          const r = await owner.req('POST', '/host-actions/rollback', body);
          expect(r.statusCode, JSON.stringify(body)).toBe(400);
          expect(r.json()).toMatchObject({ error: 'restore_confirmation_required' });
        }
        expect(
          (
            await owner.req('POST', '/host-actions/rollback', { version: '0.9.0', backupId: 'x; rm -rf /' })
          ).json(),
        ).toMatchObject({ error: 'invalid_backup_id' });
        const r = await owner.req('POST', '/host-actions/rollback', {
          version: '0.9.0',
          backupId: id,
          restoreDatabase: true,
          confirm: id,
        });
        expect(r.statusCode).toBe(200);
        const action = r.json<Action>();
        const doc = JSON.parse(await readFile(join(hostDir, 'requests/rollback.json'), 'utf8')) as Record<
          string,
          string
        >;
        expect(doc).toMatchObject({
          kind: 'remyral-host-rollback/v1',
          version: '0.9.0',
          fromVersion: '1.0.0',
          backupId: id,
          restoreDatabase: 'yes',
        });
        await hostResult(
          'rollback',
          action.id,
          'failed',
          'restore backup',
          '0.9.0 is unhealthy: master is unhealthy',
        );
        await h.app.hostActions.tick();
        expect(await get(action.id)).toMatchObject({
          state: 'failed',
          detail: '0.9.0 is unhealthy: master is unhealthy',
        });
        expect((await auditOf('host.rollback.failed'))[0]).toMatchObject({ outcome: 'failure' });
      });

      it('cancel while pending removes the file; an unpicked request expires; a refused one is final', async () => {
        await heartbeat();
        await stepUp();
        const a = (await owner.req('POST', '/host-actions/upgrade', { version: '1.1.0' })).json<Action>();
        expect(existsSync(join(hostDir, 'requests/upgrade.json'))).toBe(true);
        const c = await owner.req('POST', `/host-actions/requests/${a.id}/cancel`);
        expect(c.statusCode).toBe(200);
        expect(c.json()).toMatchObject({ state: 'cancelled' });
        expect(existsSync(join(hostDir, 'requests/upgrade.json'))).toBe(false);
        expect(existsSync(join(hostDir, 'requests/upgrade.sig.json'))).toBe(false);
        expect((await owner.req('POST', `/host-actions/requests/${a.id}/cancel`)).json()).toMatchObject({
          error: 'no_pending_host_request',
        });
        expect((await auditOf('host.request.cancel'))[0]).toMatchObject({ metadata: { kind: 'upgrade' } });

        const b = (await owner.req('POST', '/host-actions/upgrade', { version: '1.1.0' })).json<Action>();
        h.clock.advance(16 * 60_000);
        await h.app.hostActions.tick();
        expect(await get(b.id)).toMatchObject({ state: 'expired' });
        expect(existsSync(join(hostDir, 'requests/upgrade.json'))).toBe(false);

        await heartbeat();
        await stepUp();
        const d = (await owner.req('POST', '/host-actions/upgrade', { version: '1.1.0' })).json<Action>();
        // The host could not verify the signature: unattributed refusal of the waiting request.
        await hostResult('upgrade', '', 'refused', '', 'signature check failed');
        await h.app.hostActions.tick();
        expect(await get(d.id)).toMatchObject({ state: 'refused', detail: 'signature check failed' });
        expect(
          (await owner.req('GET', `/host-actions/requests/00000000-0000-4000-8000-000000000000`)).statusCode,
        ).toBe(404);
      });
    });
  },
);
