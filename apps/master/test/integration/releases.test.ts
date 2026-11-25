import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import { releaseKeyId, releaseSigningPayload, sha256Hex } from '@remyral/protocol';
import {
  createNodeFileOps,
  dataLayout,
  httpsDownloader,
  installLayout,
  UpdateAgent,
  updateSettingsSchema,
} from '@remyral/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { CAPS, pairRealWorker, removeDirs, runRealWorker, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';

interface Key {
  publicKey: string;
  privateKey: KeyObject;
}
function key(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: String(publicKey.export({ format: 'jwk' }).x), privateKey };
}

function release(k: Key, version: string, over: Record<string, unknown> = {}, artifact?: Buffer) {
  const bytes = artifact ?? Buffer.from(`#!/usr/bin/env node\n// remyral-worker ${version}\n`);
  const manifest = Buffer.from(
    `${JSON.stringify({
      schema: 1,
      name: 'remyral-worker',
      version,
      channel: 'stable',
      protocolVersions: ['1.0'],
      minNode: '24.0.0',
      sha256: sha256Hex(bytes),
      size: bytes.byteLength,
      createdAt: '2026-10-13T10:00:00.000Z',
      ...over,
    })}\n`,
  );
  const signature = {
    keyId: releaseKeyId(k.publicKey),
    signature: sign(null, releaseSigningPayload(manifest), k.privateKey).toString('base64url'),
  };
  return {
    body: { manifest: manifest.toString('base64'), signature, artifact: bytes.toString('base64') },
    manifest,
    artifact: bytes,
  };
}

/**
 * p2-signed-updates against the real master (Postgres) and a real worker daemon + transport + update agent
 * over loopback: signed upload (and every way it can be refused), authz/step-up, channel promotion with
 * rollout, worker-scoped download tokens, UPDATE_AVAILABLE → verified staging → activation request →
 * outcome report, explicit rollback, and no automatic retry of a failed version.
 */
describeIntegration('signed worker releases (integration)', () => {
  const releaseK = key();
  const nextK = key();
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  let operator: Client;
  let viewer: Client;
  const dirs: string[] = [];

  const stepUp = async () => {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  };

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, sweepIntervalMs: 3_600_000 },
      releases: { publicKeys: [releaseK.publicKey, nextK.publicKey] },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    await h.createUser('op1', PW, 'operator');
    const op = await enroll(h, 'op1', PW);
    operator = await fullLogin(h, 'op1', PW, op.secret);
    await h.createUser('viewer1', PW, 'viewer');
    const vw = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, vw.secret);
  });
  afterAll(async () => {
    await h.stop();
    await removeDirs(dirs);
  });

  describe('registry', () => {
    it('requires a fresh step-up and an admin; viewers can read', async () => {
      h.clock.advance(20 * 60_000);
      const r = await admin.req('POST', '/releases', release(releaseK, '1.0.0').body);
      expect(r.statusCode).toBe(403);
      expect(r.json<{ error: string }>().error).toBe('step_up_required');
      for (const c of [operator, viewer]) {
        expect((await c.req('POST', '/releases', release(releaseK, '1.0.0').body)).statusCode).toBe(403);
        expect((await c.req('PUT', '/releases/channels/stable', { version: '1.0.0' })).statusCode).toBe(403);
        expect(
          (await c.req('POST', '/workers/wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa/update', { channel: 'canary' }))
            .statusCode,
        ).toBe(403);
      }
      expect((await viewer.req('GET', '/releases')).statusCode).toBe(200);
    });

    it('accepts a release signed with a trusted key (either key of the rotation overlap), idempotently', async () => {
      await stepUp();
      const r1 = await admin.req('POST', '/releases', release(releaseK, '1.0.0').body);
      expect(r1.statusCode, r1.body).toBe(201);
      expect(r1.json()).toMatchObject({
        version: '1.0.0',
        channel: 'stable',
        keyId: releaseKeyId(releaseK.publicKey),
      });
      expect((await admin.req('POST', '/releases', release(releaseK, '1.0.0').body)).statusCode).toBe(200);
      const r2 = await admin.req('POST', '/releases', release(nextK, '1.1.0').body);
      expect(r2.statusCode, r2.body).toBe(201);
    });

    it('refuses tampered, foreign-key, mismatching, conflicting and protocol-incompatible releases', async () => {
      await stepUp();
      const good = release(releaseK, '1.5.0');
      const tamperedManifest = Buffer.from(good.manifest.toString().replace('"1.5.0"', '"1.5.1"'));
      const cases: [string, unknown, number, string][] = [
        [
          'tampered manifest',
          { ...good.body, manifest: tamperedManifest.toString('base64') },
          422,
          'signature_invalid',
        ],
        ['untrusted key', release(key(), '1.5.0').body, 422, 'signature_invalid'],
        [
          'artifact swapped',
          { ...good.body, artifact: Buffer.from('evil()').toString('base64') },
          422,
          'artifact_mismatch',
        ],
        [
          'incompatible protocol',
          release(releaseK, '3.0.0', { protocolVersions: ['3.0'] }).body,
          422,
          'protocol_incompatible',
        ],
        [
          'same version, other bytes',
          release(releaseK, '1.0.0', {}, Buffer.from('other build')).body,
          409,
          'version_exists',
        ],
      ];
      for (const [name, body, status, error] of cases) {
        const res = await admin.req('POST', '/releases', body);
        expect(res.statusCode, name).toBe(status);
        expect(res.json<{ error: string }>().error, name).toBe(error);
      }
      const { rows } = await h.db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events WHERE action = 'release.upload' AND outcome = 'denied'`,
      );
      expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(4);
      const list = (await admin.req('GET', '/releases')).json<{ releases: { version: string }[] }>();
      expect(list.releases.map((r) => r.version)).toEqual(['1.1.0', '1.0.0']);
    });

    it('a canary-signed build can only go to canary until it is re-signed for stable', async () => {
      await stepUp();
      const art = Buffer.from('// 1.2.0-rc.1\n');
      expect(
        (
          await admin.req(
            'POST',
            '/releases',
            release(releaseK, '1.2.0-rc.1', { channel: 'canary' }, art).body,
          )
        ).statusCode,
      ).toBe(201);
      const stable = await admin.req('PUT', '/releases/channels/stable', { version: '1.2.0-rc.1' });
      expect(stable.statusCode).toBe(409);
      expect(stable.json<{ error: string }>().error).toBe('channel_mismatch');
      expect(
        (await admin.req('PUT', '/releases/channels/canary', { version: '1.2.0-rc.1', rolloutPercent: 50 }))
          .statusCode,
      ).toBe(200);
      // Same bytes re-signed for stable upgrade the release in place.
      const resigned = await admin.req('POST', '/releases', release(releaseK, '1.2.0-rc.1', {}, art).body);
      expect(resigned.json()).toMatchObject({ channel: 'stable' });
      expect(
        (await admin.req('PUT', '/releases/channels/stable', { version: '1.0.0', rolloutPercent: 0 }))
          .statusCode,
      ).toBe(200);
    });
  });

  describe('updates end to end with a real worker', () => {
    let id: string;
    let dataDir: string;
    let installDir: string;

    async function startWorker(version: string) {
      const agent = new UpdateAgent({
        ops: createNodeFileOps(),
        data: dataLayout(process.platform, dataDir),
        install: installLayout(process.platform, installDir),
        settings: updateSettingsSchema(process.platform).parse({}),
        currentVersion: version,
        trustedKeys: [releaseK.publicKey, nextK.publicKey],
        download: httpsDownloader({ masterUrl: url, workerVersion: version }),
        logger: createLogger({ sink: () => undefined }),
        nodeVersion: process.versions.node,
      });
      const worker = await runRealWorker(url, dataDir, {
        capabilities: CAPS,
        heartbeatIntervalMs: 100,
        workerVersion: version,
        updates: agent,
      });
      await expect.poll(() => worker.transport.established).toBe(true);
      return worker;
    }

    const attempts = async () =>
      (await admin.req('GET', `/releases?workerId=${id}`)).json<{
        attempts: {
          id: string;
          toVersion: string;
          status: string;
          reason: string | null;
          rollback: boolean;
        }[];
      }>().attempts;

    /**
     * Plays the privileged updater's part: records the outcome in its (root-owned) result file and, after an activation
     * from `previous`, its state with the retained previous version (the only rollback target the worker accepts).
     */
    async function updaterOutcome(
      attemptId: string,
      version: string,
      outcome: string,
      reason: string | null = null,
      previous?: string,
    ) {
      await mkdir(join(installDir, 'state'), { recursive: true });
      if (previous !== undefined) {
        const sha256 = sha256Hex(Buffer.from(`#!/usr/bin/env node\n// remyral-worker ${previous}\n`));
        await writeFile(
          join(installDir, 'state', 'update.json'),
          JSON.stringify({
            schema: 1,
            lastAttemptId: attemptId,
            phase: 'idle',
            target: null,
            previous: { version: previous, sha256 },
            attemptId: null,
            restartedAt: null,
          }),
        );
      }
      await writeFile(
        join(installDir, 'state', 'last-result.json'),
        JSON.stringify({
          schema: 1,
          attemptId,
          version,
          outcome,
          reason,
          detail: null,
          activeVersion: version,
          finishedAt: new Date().toISOString(),
        }),
      );
    }

    it('pairs a worker', async () => {
      dataDir = await tempDataDir(dirs);
      installDir = await tempDataDir(dirs);
      id = await pairRealWorker(h, url, admin, secret, dataDir);
    });

    it('promotion offers the release; the worker verifies, stages and requests activation; the outcome is reported', async () => {
      const worker = await startWorker('1.0.0');
      try {
        expect(await attempts()).toEqual([]); // stable is at 1.0.0 with 0 %: nothing to do
        await stepUp();
        const promote = await admin.req('PUT', '/releases/channels/stable', {
          version: '1.1.0',
          rolloutPercent: 100,
        });
        expect(promote.statusCode, promote.body).toBe(200);
        await expect.poll(async () => (await attempts())[0]?.status, { timeout: 10_000 }).toBe('activating');
        const attempt = (await attempts())[0];
        expect(attempt).toMatchObject({ toVersion: '1.1.0', rollback: false });
        const staged = await readFile(join(dataDir, 'updates', 'staged', '1.1.0', 'remyral-worker.mjs'));
        expect(staged.toString()).toBe('#!/usr/bin/env node\n// remyral-worker 1.1.0\n');
        const request = JSON.parse(
          await readFile(join(dataDir, 'updates', 'request.json'), 'utf8'),
        ) as Record<string, unknown>;
        expect(request).toMatchObject({ attemptId: attempt?.id, version: '1.1.0', rollback: false });

        await updaterOutcome(attempt?.id ?? '', '1.1.0', 'succeeded', null, '1.0.0');
        await expect.poll(async () => (await attempts())[0]?.status, { timeout: 10_000 }).toBe('succeeded');
        const audit = await h.db.pool.query(
          `SELECT 1 FROM audit_events WHERE action = 'worker.update.succeeded' AND target = $1`,
          [id],
        );
        expect(audit.rowCount).toBe(1);
      } finally {
        await worker.stop();
      }
    });

    it('download tokens are worker-scoped, release-scoped and die with the attempt', async () => {
      const { rows } = await h.db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM worker_update_attempts WHERE token_hash IS NOT NULL AND worker_id = $1`,
        [id],
      );
      expect(rows[0]?.n).toBe('0');
      const res = await h.client().req('GET', '/v1/worker/releases/1.1.0/artifact', undefined, {
        authorization: `Bearer ${'x'.repeat(43)}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('a lower version needs an explicit rollback; the rollback is offered with the flag set', async () => {
      const worker = await startWorker('1.1.0');
      try {
        await stepUp();
        const refused = await admin.req('POST', `/workers/${id}/update`, { version: '1.0.0' });
        expect(refused.statusCode).toBe(409);
        expect(refused.json<{ error: string }>().error).toBe('downgrade_requires_rollback');
        // A signed older release that is not the version this machine ran before: the worker refuses it
        // (rollback_not_retained) before downloading anything.
        expect((await admin.req('POST', '/releases', release(releaseK, '0.9.0').body)).statusCode).toBe(201);
        await stepUp();
        const other = await admin.req('POST', `/workers/${id}/update`, { version: '0.9.0', rollback: true });
        expect(other.statusCode, other.body).toBe(202);
        await expect.poll(async () => (await attempts())[0]?.status, { timeout: 10_000 }).toBe('refused');
        expect((await attempts())[0]).toMatchObject({
          toVersion: '0.9.0',
          rollback: true,
          reason: 'rollback_not_retained',
        });
        expect(
          await readFile(join(dataDir, 'updates', 'staged', '0.9.0', 'remyral-worker.mjs')).catch(() => null),
        ).toBeNull();
        // The retained previous version (recorded by the updater when 1.1.0 was activated) is a legitimate rollback.
        await stepUp();
        const ok = await admin.req('POST', `/workers/${id}/update`, { version: '1.0.0', rollback: true });
        expect(ok.statusCode, ok.body).toBe(202);
        await expect.poll(async () => (await attempts())[0]?.status, { timeout: 10_000 }).toBe('activating');
        const attempt = (await attempts())[0];
        expect(attempt).toMatchObject({ toVersion: '1.0.0', rollback: true });
        await updaterOutcome(attempt?.id ?? '', '1.0.0', 'succeeded');
        await expect.poll(async () => (await attempts())[0]?.status, { timeout: 10_000 }).toBe('succeeded');
      } finally {
        await worker.stop();
      }
    });

    it('a version that failed its health check is not re-offered automatically', async () => {
      await stepUp();
      expect((await admin.req('POST', `/workers/${id}/update`, { channel: 'stable' })).statusCode).toBe(202);
      let worker = await startWorker('1.0.0');
      try {
        await expect.poll(async () => (await attempts())[0]?.status, { timeout: 10_000 }).toBe('activating');
        const attempt = (await attempts())[0];
        expect(attempt?.toVersion).toBe('1.1.0');
        // p6-worker-boot-diagnostics: the updater's evidence travels with UPDATE_STATUS (redacted again here).
        const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
        await mkdir(join(installDir, 'state'), { recursive: true });
        await writeFile(
          join(installDir, 'state', 'last-diagnostics.json'),
          JSON.stringify({
            schema: 1,
            attemptId: attempt?.id,
            diagnostics: {
              collectedBy: 'updater',
              verdict: 'crashed',
              bootLog: [`{"event":"fatal","version":"1.1.0","error":{"message":"boom ${token}"}}`],
              restartErrors: ['net.exe start RemyralWorker failed (2): The service is starting or stopping.'],
              redacted: true,
            },
          }),
        );
        await updaterOutcome(attempt?.id ?? '', '1.1.0', 'rolled_back', 'health_check_failed');
        await expect.poll(async () => (await attempts())[0]?.status, { timeout: 10_000 }).toBe('rolled_back');
        const listed = (await admin.req('GET', `/releases?workerId=${id}`)).json<{
          attempts: { id: string; verdict: string | null; hasDiagnostics: boolean }[];
        }>().attempts[0];
        expect(listed).toMatchObject({ id: attempt?.id, verdict: 'crashed', hasDiagnostics: true });
        const diag = await admin.req('GET', `/releases/attempts/${attempt?.id ?? ''}/diagnostics`);
        expect(diag.statusCode, diag.body).toBe(200);
        const body = diag.json<{
          diagnostics: { verdict: string; bootLog: string[]; restartErrors: string[] };
        }>();
        expect(body.diagnostics).toMatchObject({ verdict: 'crashed', collectedBy: 'updater' });
        expect(body.diagnostics.restartErrors[0]).toContain('starting or stopping');
        expect(diag.body).toContain('boom');
        expect(diag.body).not.toContain(token);
        const unknown = await admin.req(
          'GET',
          '/releases/attempts/7d0c4c1e-3c55-4c1e-9d6a-1f4f3b8a2b10/diagnostics',
        );
        expect(unknown.statusCode).toBe(404);
      } finally {
        await worker.stop();
      }
      worker = await startWorker('1.0.0');
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const all = await attempts();
        expect(all[0]).toMatchObject({ status: 'rolled_back', reason: 'health_check_failed' });
        expect(all.filter((a) => a.toVersion === '1.1.0' && a.status === 'offered')).toEqual([]);
        // p17-worker-managed: the rollback is a notification (owners/admins, once per attempt) …
        const notes = await h.db.pool.query<{ title: string; link: string; dedupe_key: string }>(
          "SELECT title, link, dedupe_key FROM notifications WHERE kind = 'worker.update_failed'",
        );
        expect(notes.rows).toHaveLength(1);
        expect(notes.rows[0]?.title).toContain('1.1.0 was rolled back');
        expect(notes.rows[0]?.link).toBe(`/machines/${id}?tab=admin`);
        expect(notes.rows[0]?.dedupe_key).toBe(`worker.update_failed:${all[0]?.id ?? ''}`);
        // … and the machine list / page show the outcome with the attempt's id, start version and evidence flag.
        const ov = (await admin.req('GET', '/fleet/overview')).json<{
          workers: {
            id: string;
            release: {
              lastAttempt: {
                id: string;
                status: string;
                fromVersion: string;
                hasDiagnostics: boolean;
              } | null;
              previousVersion: string | null;
            };
          }[];
        }>();
        const mine = ov.workers.find((x) => x.id === id);
        expect(mine?.release.lastAttempt).toMatchObject({
          id: all[0]?.id,
          status: 'rolled_back',
          fromVersion: '1.0.0',
          hasDiagnostics: true,
        });
        // "Yeniden dene": re-targeting the failed version is a new intent, so it is offered again.
        const before = all.filter((a) => a.toVersion === '1.1.0').length;
        await stepUp();
        expect((await admin.req('POST', `/workers/${id}/update`, { version: '1.1.0' })).statusCode).toBe(202);
        await expect
          .poll(async () => (await attempts()).filter((a) => a.toVersion === '1.1.0').length, {
            timeout: 10_000,
          })
          .toBe(before + 1);
      } finally {
        await worker.stop();
      }
    });
  });
});
