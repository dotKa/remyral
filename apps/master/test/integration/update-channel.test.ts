import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CATALOG_CONTEXT,
  npmTarballUrl,
  releaseKeyId,
  releaseSigningPayload,
  RUNTIME_PINS,
  sha256Hex,
  WORKER_FEED_CONTEXT,
} from '@remyral/protocol';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { WorkerSession } from '../../src/workers/types.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
interface Key {
  pub: string;
  priv: KeyObject;
}
function key(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: String(publicKey.export({ format: 'jwk' }).x), priv: privateKey };
}
const sigOf = (context: string, bytes: Buffer, k: Key) => ({
  keyId: releaseKeyId(k.pub),
  signature: sign(null, Buffer.concat([Buffer.from(context), bytes]), k.priv).toString('base64url'),
});
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A signed release.json (sign.mjs build output) for `version`. */
function releaseJson(k: Key, version: string): { bytes: Buffer; artifactSha: string; size: number } {
  const artifact = Buffer.from(`#!/usr/bin/env node\n// remyral-worker ${version}\n`);
  const manifest = Buffer.from(
    `${JSON.stringify({
      schema: 1,
      name: 'remyral-worker',
      version,
      channel: 'stable',
      protocolVersions: ['1.0'],
      minNode: '24.0.0',
      sha256: sha256Hex(artifact),
      size: artifact.byteLength,
      createdAt: '2026-10-26T07:00:00.000Z',
    })}\n`,
  );
  const signature = {
    keyId: releaseKeyId(k.pub),
    signature: sign(null, releaseSigningPayload(manifest), k.priv).toString('base64url'),
  };
  const bytes = Buffer.from(
    JSON.stringify({
      manifest: manifest.toString('base64'),
      signature,
      artifact: artifact.toString('base64'),
    }),
  );
  return { bytes, artifactSha: sha256Hex(artifact), size: artifact.byteLength };
}

const BASE = 'https://releases.test/remyral';
const integ = (c: string) => `sha512-${c.repeat(86)}==`;
const codexPin = RUNTIME_PINS.codex.version;
const wid = (n: string) => `wrk_${n}${'a'.repeat(26)}`.slice(0, 30);
const NEXT = codexPin.replace(/\d+$/, (n) => String(Number(n) + 2));

describeIntegration(
  'p17-update-channel: worker feed, policy, canary-first rollout, catalog (integration)',
  { timeout: 60_000 },
  () => {
    const rk = key();
    const ck = key();
    const site = new Map<string, Buffer>();
    const h = new Harness();
    let owner: Client;
    let secret: string;
    let admin: Client;
    let adminSecret: string;
    let viewer: Client;

    function publishRelease(version: string, k = rk) {
      const r = releaseJson(k, version);
      site.set(`${BASE}/workers/${version}/release.json`, r.bytes);
      return {
        version,
        channel: 'stable',
        publishedAt: '2026-10-26T07:00:00.000Z',
        protocolVersions: ['1.0'],
        minNode: '24.0.0',
        sha256: r.artifactSha,
        size: r.size,
        bundle: { path: `${version}/release.json`, sha256: sha(r.bytes), size: r.bytes.byteLength },
        summary: `Worker ${version}`,
        notes: `- worker ${version}`,
      };
    }
    let generated = Date.parse('2026-10-26T08:00:00.000Z');
    function publishFeed(releases: unknown[], signer = rk, tamper = false) {
      generated += 60_000;
      const bytes = Buffer.from(
        `${JSON.stringify({ schema: 1, name: 'remyral-worker-feed', channel: 'stable', generatedAt: new Date(generated).toISOString(), catalogKeys: [ck.pub], releases }, null, 2)}\n`,
      );
      const signature = sigOf(WORKER_FEED_CONTEXT, bytes, signer);
      site.set(
        `${BASE}/workers/feed.json`,
        tamper ? Buffer.from(bytes.toString().replace('Worker', 'Wörker')) : bytes,
      );
      site.set(`${BASE}/workers/feed.sig.json`, Buffer.from(JSON.stringify(signature)));
    }
    function publishCatalog(sequence: number, signer = ck) {
      const doc = {
        schema: 1,
        name: 'remyral-version-catalog',
        sequence,
        generatedAt: '2026-10-12T11:00:00.000Z',
        runtimes: {
          codex: [
            {
              version: NEXT,
              packageVersion: NEXT,
              integrity: integ('a'),
              verified: true,
              packages: [
                {
                  path: 'node_modules/@openai/codex',
                  name: '@openai/codex',
                  version: NEXT,
                  resolved: npmTarballUrl('@openai/codex', NEXT),
                  integrity: integ('a'),
                },
              ],
            },
          ],
        },
        tools: {},
      };
      const bytes = Buffer.from(JSON.stringify(doc));
      site.set(`${BASE}/catalog/catalog.json`, bytes);
      site.set(
        `${BASE}/catalog/catalog.sig.json`,
        Buffer.from(JSON.stringify(sigOf(CATALOG_CONTEXT, bytes, signer))),
      );
    }

    const tick = () => h.app.updateChannel.check();
    const view = async (c: Client = owner) => {
      const r = await c.req('GET', '/update-channel');
      expect(r.statusCode).toBe(200);
      return r.json<{
        configured: boolean;
        policy: string;
        feed: { error: string | null; source: string | null };
        stableVersion: string | null;
        releases: { version: string; state: string; bump: string; imported: boolean; error: string | null }[];
        rollout: { version: string; stage: string; canary: { workerId: string; status: string }[] } | null;
        catalog: {
          sequence: number | null;
          error: string | null;
          items: { item: string; version: string; verified: boolean }[];
          workers: { workerId: string; lastOutcome: string | null }[];
        };
      }>();
    };
    const stepUp = async (c: Client, s: string) => {
      h.clock.advance(30_000);
      expect((await c.req('POST', '/auth/step-up', { code: h.code(s) })).statusCode).toBe(200);
    };
    async function worker(id: string, version: string, canary = false) {
      const now = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO workers (id, display_name, state, facts, worker_version, last_seen_at, approved_at, created_at, updated_at)
       VALUES ($1, $1, 'online', '{}'::jsonb, $2, $3, $3, $3, $3)`,
        [id, version, now],
      );
      if (canary)
        await h.db.pool.query('INSERT INTO worker_runtime_policies (worker_id, canary) VALUES ($1, true)', [
          id,
        ]);
    }
    async function attempt(workerId: string, to: string, status: string) {
      const now = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO worker_update_attempts (id, worker_id, from_version, to_version, source, rollback, force, status,
                                           created_at, updated_at, finished_at)
       VALUES (gen_random_uuid(), $1, '1.1.4', $2, 'target', false, false, $3, $4, $4, $4)`,
        [workerId, to, status, now],
      );
      if (status === 'succeeded')
        await h.db.pool.query('UPDATE workers SET worker_version = $2 WHERE id = $1', [workerId, to]);
    }
    const targets = async () =>
      (
        await h.db.pool.query<{ worker_id: string; target_version: string | null }>(
          'SELECT worker_id, target_version FROM worker_update_targets ORDER BY worker_id',
        )
      ).rows;

    beforeAll(async () => {
      await h.start({
        releases: { publicKeys: [rk.pub] },
        updateChannel: {
          feedUrl: `${BASE}/workers/feed.json`,
          feedFile: null,
          catalogUrl: `${BASE}/catalog/catalog.json`,
          catalogFile: null,
          catalogKeys: [],
          catalog: true,
          fetch: (url) => {
            const body = site.get(url);
            if (body === undefined) return Promise.reject(new Error('offline'));
            return Promise.resolve(new Response(body, { status: 200 }));
          },
        },
      });
      await h.createUser('owner1', PW);
      ({ secret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, secret);
      await h.createUser('admin1', PW, 'admin');
      ({ secret: adminSecret } = await enroll(h, 'admin1', PW));
      admin = await fullLogin(h, 'admin1', PW, adminSecret);
      await h.createUser('viewer1', PW, 'viewer');
      const vw = await enroll(h, 'viewer1', PW);
      viewer = await fullLogin(h, 'viewer1', PW, vw.secret);
    });
    afterAll(async () => {
      await h.stop();
    });

    it('refuses a feed of a foreign key or with tampered bytes; nothing is imported', async () => {
      publishFeed([publishRelease('1.1.4')], key());
      await tick();
      let v = await view();
      expect(v.configured).toBe(true);
      expect(v.feed.error).toBe('unknown_key');
      expect(v.releases).toEqual([]);
      publishFeed([publishRelease('1.1.4')], rk, true);
      await tick();
      v = await view();
      expect(v.feed.error).toBe('bad_signature');
      expect((await h.db.pool.query('SELECT 1 FROM worker_releases')).rowCount).toBe(0);
    });

    it('imports the first release like an upload and waits for "Güncelle"; Güncelle needs step-up and an admin', async () => {
      publishFeed([publishRelease('1.1.4')]);
      await tick();
      const v = await view(viewer);
      expect(v.releases[0]).toMatchObject({
        version: '1.1.4',
        state: 'awaiting_approval',
        bump: 'first',
        imported: true,
      });
      expect(v.stableVersion).toBeNull();
      const audit = await h.db.pool.query(
        "SELECT 1 FROM audit_events WHERE action = 'release.upload' AND outcome = 'success'",
      );
      expect(audit.rowCount).toBe(1);
      const n = await h.db.pool.query("SELECT 1 FROM notifications WHERE kind = 'release.update'");
      expect(n.rowCount).toBeGreaterThan(0);
      expect((await viewer.req('POST', '/update-channel/releases/1.1.4/install')).statusCode).toBe(403);
      h.clock.advance(11 * 60_000);
      const noStep = await admin.req('POST', '/update-channel/releases/1.1.4/install');
      expect(noStep.json()).toMatchObject({ error: 'step_up_required' });
      await stepUp(admin, adminSecret);
      const r = await admin.req('POST', '/update-channel/releases/1.1.4/install');
      expect(r.statusCode).toBe(200);
      // No canary machine: the stable channel directly.
      expect(r.json()).toMatchObject({
        stableVersion: '1.1.4',
        releases: [{ version: '1.1.4', state: 'done' }],
      });
    });

    it('a patch release rolls out by itself, canary first; the fleet follows after the soak', async () => {
      await worker(wid('canary'), '1.1.4', true);
      await worker(wid('other'), '1.1.4');
      publishFeed([publishRelease('1.1.5'), publishRelease('1.1.4')]);
      await tick();
      let v = await view();
      expect(v.releases[0]).toMatchObject({ version: '1.1.5', bump: 'patch', state: 'rolling_out' });
      expect(v.rollout).toMatchObject({
        version: '1.1.5',
        stage: 'canary',
        canary: [{ workerId: wid('canary'), status: 'waiting' }],
      });
      expect(await targets()).toEqual([{ worker_id: wid('canary'), target_version: '1.1.5' }]);
      expect(v.stableVersion).toBe('1.1.4');
      await attempt(wid('canary'), '1.1.5', 'succeeded');
      await tick();
      expect((await view()).rollout?.stage).toBe('canary'); // soak (30 min) not over
      h.clock.advance(31 * 60_000);
      await tick();
      owner = await fullLogin(h, 'owner1', PW, secret);
      admin = await fullLogin(h, 'admin1', PW, adminSecret);
      v = await view();
      expect(v.stableVersion).toBe('1.1.5');
      expect(v.rollout?.stage).toBe('done');
      expect(v.releases[0]?.state).toBe('done');
      expect(await targets()).toEqual([{ worker_id: wid('canary'), target_version: null }]);
    });

    it('a minor release waits; only the owner may change the policy; a failed canary stops the rollout', async () => {
      publishFeed([publishRelease('1.2.0'), publishRelease('1.1.5')]);
      await tick();
      expect((await view()).releases[0]).toMatchObject({
        version: '1.2.0',
        bump: 'minor',
        state: 'awaiting_approval',
      });
      await stepUp(admin, adminSecret);
      expect((await admin.req('PUT', '/update-channel/policy', { policy: 'auto' })).statusCode).toBe(403);
      h.clock.advance(11 * 60_000);
      expect((await owner.req('PUT', '/update-channel/policy', { policy: 'auto' })).json()).toMatchObject({
        error: 'step_up_required',
      });
      await stepUp(owner, secret);
      const r = await owner.req('PUT', '/update-channel/policy', { policy: 'auto' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ policy: 'auto' });
      await tick();
      expect((await view()).rollout).toMatchObject({ version: '1.2.0', stage: 'canary' });
      await attempt(wid('canary'), '1.2.0', 'rolled_back');
      await tick();
      const v = await view();
      expect(v.rollout).toMatchObject({ version: '1.2.0', stage: 'canary_failed' });
      expect(v.releases[0]?.state).toBe('canary_failed');
      expect(v.stableVersion).toBe('1.1.5');
      expect(await targets()).toEqual([{ worker_id: wid('canary'), target_version: null }]);
      const audit = await h.db.pool.query(
        "SELECT 1 FROM audit_events WHERE action = 'update_channel.policy'",
      );
      expect(audit.rowCount).toBe(1);
    });

    it('a feed release whose bundle does not match the signed hash is not imported', async () => {
      const entry = publishRelease('1.2.1');
      site.set(`${BASE}/workers/1.2.1/release.json`, releaseJson(rk, '1.2.2').bytes);
      publishFeed([entry]);
      await tick();
      expect((await view()).releases[0]).toMatchObject({
        version: '1.2.1',
        state: 'import_failed',
        error: 'bundle_mismatch',
      });
    });

    it('the version catalog: accepted, shown, sent once to a worker holding an older one, statuses recorded', async () => {
      publishCatalog(3, key());
      await h.app.versionCatalog.refresh();
      let v = await view();
      // A foreign key: the feed vouches for `ck` only.
      expect(v.catalog).toMatchObject({ sequence: null, error: 'unknown_key' });
      publishCatalog(3);
      await h.app.versionCatalog.refresh();
      v = await view();
      expect(v.catalog).toMatchObject({
        sequence: 3,
        error: null,
        items: [{ item: 'codex', version: NEXT, verified: true }],
      });

      await worker(wid('cat'), '1.3.0');
      const send = vi.fn(() => Promise.resolve());
      const session = { workerId: wid('cat'), connectionId: 'c1', send } as unknown as WorkerSession;
      const caps = (sequence: number, lastRefusal?: { sequence: number; reason: string }) => ({
        runtimes: [],
        sandboxProfiles: [],
        maxParallelJobs: 1,
        tools: [],
        features: ['version-catalog-v1' as const],
        versionCatalog: { enabled: true, keys: 1, sequence, ...(lastRefusal ? { lastRefusal } : {}) },
      });
      await h.app.versionCatalog.onReport(session, caps(0));
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]).toMatchObject(['APPLY_VERSION_CATALOG', { sequence: 3 }]);
      await h.app.versionCatalog.onReport(session, caps(0));
      expect(send).toHaveBeenCalledTimes(1); // not twice per session
      const s2 = { workerId: wid('cat'), connectionId: 'c2', send } as unknown as WorkerSession;
      await h.app.versionCatalog.onReport(s2, caps(0, { sequence: 3, reason: 'unknown_key' }));
      expect(send).toHaveBeenCalledTimes(1); // it refused exactly this one: not again in a loop
      await h.app.versionCatalog.onStatus(session, { sequence: 3, outcome: 'accepted' });
      v = await view();
      expect(v.catalog.workers).toContainEqual(
        expect.objectContaining({ workerId: wid('cat'), lastOutcome: 'accepted' }),
      );
      // The fleet matrix shows the catalog version of the item.
      const tools = await owner.req('GET', '/fleet/tools');
      expect(tools.statusCode).toBe(200);
      const codex = tools
        .json<{ catalog: { id: string; catalog?: { version: string; verified: boolean } | null }[] }>()
        .catalog.find((c) => c.id === 'codex');
      expect(codex?.catalog).toEqual({ version: NEXT, verified: true, sequence: 3 });
    });
  },
);

describeIntegration(
  'p17-update-channel: a master without internet uses the host-cached feed and bundle',
  { timeout: 60_000 },
  () => {
    const rk = key();
    const h = new Harness();
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'remyral-uc-'));
      await mkdir(join(dir, 'workers', '1.1.4'), { recursive: true });
      const r = releaseJson(rk, '1.1.4');
      await writeFile(join(dir, 'workers', '1.1.4', 'release.json'), r.bytes);
      const feed = Buffer.from(
        JSON.stringify({
          schema: 1,
          name: 'remyral-worker-feed',
          channel: 'stable',
          generatedAt: '2026-10-26T08:00:00.000Z',
          releases: [
            {
              version: '1.1.4',
              channel: 'stable',
              publishedAt: '2026-10-26T07:00:00.000Z',
              protocolVersions: ['1.0'],
              minNode: '24.0.0',
              sha256: r.artifactSha,
              size: r.size,
              bundle: { path: '1.1.4/release.json', sha256: sha(r.bytes), size: r.bytes.byteLength },
              summary: 'x',
              notes: '',
            },
          ],
        }),
      );
      await writeFile(join(dir, 'workers', 'feed.json'), feed);
      await writeFile(
        join(dir, 'workers', 'feed.sig.json'),
        JSON.stringify(sigOf(WORKER_FEED_CONTEXT, feed, rk)),
      );
      await h.start({
        releases: { publicKeys: [rk.pub] },
        updateChannel: {
          feedUrl: null,
          feedFile: join(dir, 'workers', 'feed.json'),
          catalogUrl: null,
          catalogFile: join(dir, 'catalog', 'catalog.json'),
          catalogKeys: [],
          catalog: true,
          fetch: () => Promise.reject(new Error('no internet')),
        },
      });
    });
    afterAll(async () => {
      await h.stop();
      await rm(dir, { recursive: true, force: true });
    });

    it('reads the cached feed and imports the cached bundle', async () => {
      await h.app.updateChannel.check();
      const v = await h.app.updateChannel.view();
      expect(v.feed).toMatchObject({ source: 'file', error: null });
      expect(v.releases[0]).toMatchObject({ version: '1.1.4', imported: true, state: 'awaiting_approval' });
    });
  },
);
