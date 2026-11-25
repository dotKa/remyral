import { JobSpec } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withEnvRefs } from '../../src/orchestration/orchestrator.js';
import { ProjectEnvNotHeldError } from '../../src/project-env/service.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { jobSpec as rawSpec, PROJECT } from '../helpers/job-worker.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
const KEY_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const jobSpec = (over: Record<string, unknown> = {}): JobSpec => JobSpec.parse(rawSpec(over));

/**
 * p19-project-env against a real master: a project gives its jobs vault credentials of kind "generic" as environment
 * variables — viewers read, admin + step-up replaces the set (audited, ids only), wrong kinds / reserved variables /
 * duplicate variables are refused, placement keeps the job to machines holding every credential, and the
 * assignment adds `secret:vault-<id>` (never for an untrusted source; the job's own reference wins).
 */
describeIntegration(
  'project environment credentials (integration, p19-project-env)',
  { timeout: 120_000 },
  () => {
    let h: Harness;
    let owner: Client;
    let viewer: Client;
    let secret: string;
    let worker: RawWorker;
    let workerId = '';

    async function stepUp(): Promise<void> {
      h.clock.advance(31_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    }

    async function credential(id: string, kind: string, env: string): Promise<void> {
      await h.db.pool.query(
        `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at)
       VALUES ($1, $1, $2, $3, 1, 'active', now(), now())`,
        [id, kind, env],
      );
    }

    async function hold(id: string, acked: number | null): Promise<void> {
      await h.db.pool.query(
        `INSERT INTO vault_credential_workers (credential_id, worker_id, version, key_id, sealed, sealed_digest, state,
                                             acked_version, updated_at)
       VALUES ($1, $2, 1, $3, '{"c":"x"}', repeat('a', 64), 'active', $4, now())
       ON CONFLICT (credential_id, worker_id) DO UPDATE SET acked_version = EXCLUDED.acked_version`,
        [id, workerId, KEY_ID, acked],
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
      owner = await fullLogin(h, 'owner1', PW, secret);
      const viewerId = await h.createUser('viewer1', PW, 'viewer');
      await h.grant(viewerId, [PROJECT], 'viewer');
      const v = await enroll(h, 'viewer1', PW);
      viewer = await fullLogin(h, 'viewer1', PW, v.secret);
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
        [PROJECT],
      );
      worker = await RawWorker.connect(url, new TestKey());
      const pending = await worker.handshake({ pairingCode: 'PENV-ABCD' });
      workerId = pending.workerId ?? '';
      await stepUp();
      expect(
        (await owner.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'PENV-ABCD' })).statusCode,
      ).toBe(200);
      await worker.next('SESSION_ESTABLISHED');
      await credential('dev-database-url', 'generic', 'DEV_DATABASE_URL');
      await credential('redis-url', 'generic', 'REDIS_URL');
      await credential('other-db', 'generic', 'DEV_DATABASE_URL');
      await credential('anthropic-key', 'anthropic', 'ANTHROPIC_API_KEY');
      await credential('sneaky', 'generic', 'ANTHROPIC_API_KEY');
    });

    afterAll(async () => {
      worker.close();
      await h.stop();
    });

    it('settings: viewers read; admin + step-up replaces the set; kinds, reserved and duplicate variables refused', async () => {
      const empty = await viewer.req('GET', `/projects/${PROJECT}/env-credentials`);
      expect(empty.statusCode, empty.body).toBe(200);
      const body = empty.json<{ credentials: unknown[]; available: { id: string }[] }>();
      expect(body.credentials).toEqual([]);
      // Viewers do not see what could be added (it names every generic credential of the panel).
      expect(body.available).toEqual([]);
      const forAdmin = (await owner.req('GET', `/projects/${PROJECT}/env-credentials`)).json<{
        available: { id: string }[];
      }>();
      // Only generic credentials, and none targeting a runtime's own variable.
      expect(forAdmin.available.map((a) => a.id).sort()).toEqual([
        'dev-database-url',
        'other-db',
        'redis-url',
      ]);

      expect(
        (await viewer.req('PUT', `/projects/${PROJECT}/env-credentials`, { credentialIds: ['redis-url'] }))
          .statusCode,
      ).toBe(403);

      await stepUp();
      const kind = await owner.req('PUT', `/projects/${PROJECT}/env-credentials`, {
        credentialIds: ['anthropic-key'],
      });
      expect(kind.statusCode).toBe(400);
      expect(kind.json()).toMatchObject({ error: 'credential_kind_not_env' });
      const reserved = await owner.req('PUT', `/projects/${PROJECT}/env-credentials`, {
        credentialIds: ['sneaky'],
      });
      expect(reserved.json()).toMatchObject({ error: 'credential_env_reserved' });
      const dup = await owner.req('PUT', `/projects/${PROJECT}/env-credentials`, {
        credentialIds: ['dev-database-url', 'other-db'],
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json()).toMatchObject({ error: 'credential_env_duplicate' });
      const missing = await owner.req('PUT', `/projects/${PROJECT}/env-credentials`, {
        credentialIds: ['nope'],
      });
      expect(missing.statusCode).toBe(404);

      const ok = await owner.req('PUT', `/projects/${PROJECT}/env-credentials`, {
        credentialIds: ['dev-database-url'],
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({
        credentials: [{ credentialId: 'dev-database-url', env: 'DEV_DATABASE_URL', machines: [] }],
      });
      const audit = await h.db.pool.query<{ metadata: unknown }>(
        "SELECT metadata FROM audit_events WHERE action = 'project.env_credentials.update' AND outcome = 'success'",
      );
      expect(audit.rows.map((r) => r.metadata)).toEqual([{ before: [], after: ['dev-database-url'] }]);
    });

    it('placement and assignment: holders only, refs added, untrusted sources and own refs respected', async () => {
      const spec = jobSpec();
      // Not delivered yet: no machine can take it.
      expect(await h.app.projectEnv.placementFor(PROJECT, spec)).toEqual({
        credentials: ['dev-database-url'],
        credentialWorkers: [],
      });
      await expect(h.app.projectEnv.assignment(PROJECT, spec, workerId)).rejects.toBeInstanceOf(
        ProjectEnvNotHeldError,
      );
      // Delivered but not acknowledged at this version: still not held.
      await hold('dev-database-url', null);
      expect((await h.app.projectEnv.placementFor(PROJECT, spec))?.credentialWorkers).toEqual([]);
      await hold('dev-database-url', 1);
      expect((await h.app.projectEnv.placementFor(PROJECT, spec))?.credentialWorkers).toEqual([workerId]);
      const refs = await h.app.projectEnv.assignment(PROJECT, spec, workerId);
      expect(refs).toEqual({ DEV_DATABASE_URL: 'secret:vault-dev-database-url' });
      expect(withEnvRefs(spec, refs).secretRefs).toEqual({
        DEV_DATABASE_URL: 'secret:vault-dev-database-url',
      });

      const view = await viewer.req('GET', `/projects/${PROJECT}/env-credentials`);
      expect(view.json<{ credentials: { machines: string[] }[] }>().credentials[0]?.machines).toHaveLength(1);

      // An untrusted source never gets them.
      const untrusted = jobSpec({ sourceTrust: 'untrusted', sandboxProfile: 'container' });
      expect(await h.app.projectEnv.placementFor(PROJECT, untrusted)).toBeUndefined();
      expect(await h.app.projectEnv.assignment(PROJECT, untrusted, workerId)).toBeNull();

      // The job's own reference for the same variable wins (and needs no holder).
      const own = jobSpec({ secretRefs: { DEV_DATABASE_URL: 'secret:mine' } });
      expect(await h.app.projectEnv.placementFor(PROJECT, own)).toBeUndefined();
      expect(withEnvRefs(own, { DEV_DATABASE_URL: 'secret:vault-dev-database-url' }).secretRefs).toEqual({
        DEV_DATABASE_URL: 'secret:mine',
      });

      // A revoked credential drops out.
      await h.db.pool.query("UPDATE vault_credentials SET state = 'revoked' WHERE id = 'dev-database-url'");
      expect(await h.app.projectEnv.placementFor(PROJECT, spec)).toBeUndefined();
      const after = await viewer.req('GET', `/projects/${PROJECT}/env-credentials`);
      expect(after.json<{ credentials: unknown[] }>().credentials).toEqual([]);
    });
  },
);
