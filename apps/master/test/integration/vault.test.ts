import { sign, webcrypto } from 'node:crypto';
import {
  type LeaseKey,
  type MasterToWorker,
  openCredential,
  sealCredential,
  sealedDigest,
  vaultKeyId,
  vaultKeyStatement,
  verifyCredentialDelivery,
  type WorkerConfigSpec,
} from '@remyral/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
const REPO = 'https://git.example.com/acme/alpha.git';
/** A value that must never appear anywhere on the master. */
const VALUE = 'sk-or-v1-PLAINTEXT-must-never-reach-the-master-0123456789';
const VALUE_2 = 'sk-or-v1-SECOND-PLAINTEXT-must-never-reach-the-master-987';

type Key = Parameters<typeof openCredential>[1];
type Apply = Extract<MasterToWorker, { type: 'APPLY_CREDENTIAL' }>;

interface VaultKey {
  publicKey: string;
  privateKey: Key;
  keyId: string;
}

async function vaultKey(): Promise<VaultKey> {
  const pair = (await webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as unknown as {
    publicKey: Key;
    privateKey: Key;
  };
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const publicKey = Buffer.from(raw).toString('base64url');
  return { publicKey, privateKey: pair.privateKey, keyId: await vaultKeyId(publicKey) };
}

interface CredentialBody {
  id: string;
  version: number;
  state: string;
  workers: { workerId: string; status: string; version: number; ackedVersion: number | null }[];
}

describeIntegration('credential vault (integration, p5-credentials-models)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  let worker: RawWorker;
  let device: TestKey;
  let workerId = '';
  let leaseKeys: LeaseKey[] = [];
  let vk: VaultKey;
  const createdAt = '2026-10-14T10:00:00.000Z';
  const responses: string[] = [];

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function req(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    const res = await admin.req(method, path, body);
    responses.push(res.body);
    return res;
  }

  function announcement(k: VaultKey, signer: TestKey = device) {
    return {
      keyId: k.keyId,
      publicKey: k.publicKey,
      createdAt,
      signature: sign(
        null,
        vaultKeyStatement({ workerId, keyId: k.keyId, publicKey: k.publicKey, createdAt }),
        signer.privateKey,
      ).toString('base64url'),
    };
  }

  function capabilities(vault: unknown): void {
    worker.sendJson(
      worker.envelope(
        'CAPABILITIES',
        {
          runtimes: [],
          sandboxProfiles: ['container'],
          maxParallelJobs: 1,
          tools: [],
          features: ['worker-config-v1', 'credential-vault-v1'],
          credentialVault: vault,
        },
        { workerId },
      ),
    );
  }

  async function seal(value: string, version: number, k: VaultKey = vk, id = 'openrouter') {
    return {
      workerId,
      keyId: k.keyId,
      sealed: await sealCredential(value, k.publicKey, {
        workerId,
        credentialId: id,
        version,
        keyId: k.keyId,
        kind: 'openrouter',
        env: 'OPENROUTER_API_KEY',
      }),
    };
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      gitflow: { allowPlainGit: true },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
      'alpha',
      h.clock.now(),
    ]);
    await stepUp();
    expect(
      (
        await admin.req('PUT', '/projects/alpha/git', {
          expectedVersion: 0,
          provider: 'git',
          repositoryUrl: REPO,
          baseBranch: 'main',
        })
      ).statusCode,
    ).toBe(200);
    device = new TestKey();
    worker = await RawWorker.connect(url, device);
    const pending = await worker.handshake({ pairingCode: 'VALT-ABCD' });
    workerId = pending.workerId ?? '';
    expect(
      (await admin.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'VALT-ABCD' })).statusCode,
    ).toBe(200);
    leaseKeys = (await worker.next('SESSION_ESTABLISHED')).payload.leaseKeys ?? [];
    vk = await vaultKey();
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
  });

  describe('vault keys', () => {
    it('refuses an announcement not signed by the worker device key', async () => {
      capabilities({ key: announcement(vk, new TestKey()), credentials: [], revoked: [] });
      await expect
        .poll(
          async () =>
            (
              await h.db.pool.query(
                "SELECT 1 FROM audit_events WHERE action = 'vault.key.refused' AND target = $1",
                [workerId],
              )
            ).rowCount,
        )
        .toBe(1);
      const res = await req('GET', '/vault/workers');
      expect(
        res.json<{ items: { workerId: string; key: unknown }[] }>().items.find((w) => w.workerId === workerId)
          ?.key,
      ).toBeNull();
    });

    it('pins a correctly signed key and shows its fingerprint', async () => {
      capabilities({ key: announcement(vk), credentials: [], revoked: [] });
      await expect
        .poll(async () => {
          const res = await req('GET', '/vault/workers');
          return res
            .json<{ items: { workerId: string; key: { keyId: string } | null }[] }>()
            .items.find((w) => w.workerId === workerId)?.key?.keyId;
        })
        .toBe(vk.keyId);
      const res = await req('GET', '/vault/workers');
      const w = res.json<{
        items: { workerId: string; supported: boolean; key: { fingerprint: string } }[];
      }>().items[0];
      expect(w?.supported).toBe(true);
      expect(w?.key.fingerprint).toMatch(/^X25519:/);
    });
  });

  describe('credentials', () => {
    let apply: Apply;

    it('refuses forbidden env vars, a wrong key id and requires step-up', async () => {
      await stepUp();
      const ok = await seal(VALUE, 1);
      const env = await req('POST', '/vault/credentials', {
        id: 'bad',
        name: 'x',
        kind: 'anthropic',
        env: 'CLAUDE_CODE_OAUTH_TOKEN',
        workers: [ok],
      });
      expect(env.statusCode).toBe(400);
      expect(env.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain('env');
      const other = await vaultKey();
      const wrongKey = await req('POST', '/vault/credentials', {
        id: 'openrouter',
        name: 'OpenRouter',
        kind: 'openrouter',
        env: 'OPENROUTER_API_KEY',
        workers: [await seal(VALUE, 1, other)],
      });
      expect(wrongKey.statusCode).toBe(400);
      expect(wrongKey.json<{ issues: { code: string }[] }>().issues.map((i) => i.code)).toContain(
        'key_mismatch',
      );
      h.clock.advance(11 * 60_000);
      const stale = await req('POST', '/vault/credentials', {
        id: 'openrouter',
        name: 'OpenRouter',
        kind: 'openrouter',
        env: 'OPENROUTER_API_KEY',
        workers: [ok],
      });
      expect(stale.statusCode).toBe(403);
      expect(stale.json<{ error: string }>().error).toBe('step_up_required');
    });

    it('stores ciphertext only and delivers a signed APPLY_CREDENTIAL the worker can open', async () => {
      await stepUp();
      const res = await req('POST', '/vault/credentials', {
        id: 'openrouter',
        name: 'OpenRouter',
        kind: 'openrouter',
        env: 'OPENROUTER_API_KEY',
        description: 'shared team key',
        workers: [await seal(VALUE, 1)],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<CredentialBody>()).toMatchObject({ id: 'openrouter', version: 1, state: 'active' });
      apply = await worker.next('APPLY_CREDENTIAL');
      const p = apply.payload;
      expect(p).toMatchObject({ credentialId: 'openrouter', version: 1, env: 'OPENROUTER_API_KEY' });
      expect(
        verifyCredentialDelivery(
          {
            op: 'apply',
            workerId,
            credentialId: p.credentialId,
            version: p.version,
            digest: sealedDigest(p),
            issuedAt: p.issuedAt,
          },
          p.signature,
          leaseKeys,
        ),
      ).toBe('ok');
      const opened = await openCredential(p.sealed, vk.privateKey, vk.publicKey, {
        workerId,
        credentialId: 'openrouter',
        version: 1,
        keyId: vk.keyId,
        kind: p.kind,
        env: p.env,
      });
      expect(opened).toBe(VALUE);
    });

    it('records the acknowledgement (id + version) and marks the worker applied', async () => {
      worker.sendJson(
        worker.envelope(
          'CREDENTIAL_STATUS',
          { credentialId: 'openrouter', version: 1, outcome: 'applied' },
          { workerId },
        ),
      );
      await expect
        .poll(
          async () =>
            (await req('GET', '/vault/credentials')).json<{ items: CredentialBody[] }>().items[0]?.workers[0]
              ?.status,
        )
        .toBe('applied');
    });

    it('lets a worker configuration reference the credential and reports placement readiness', async () => {
      const spec: WorkerConfigSpec = {
        projects: ['alpha'],
        allowedRuntimes: ['pi'],
        maxParallelJobs: 1,
        sandboxProfiles: ['container'],
        workspace: {},
        labels: {},
        runtimes: {
          pi: {
            auth: { mode: 'secret-ref', credentialRef: { source: 'vault', id: 'nope' } },
          },
        },
      };
      await stepUp();
      const unknown = await req('PUT', `/workers/${workerId}/config`, { spec, expectedGeneration: 0 });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json<{ issues: { code: string }[] }>().issues.map((i) => i.code)).toContain(
        'unknown_credential',
      );
      const good = {
        ...spec,
        runtimes: {
          pi: {
            auth: {
              mode: 'secret-ref' as const,
              credentialRef: { source: 'vault' as const, id: 'openrouter' },
            },
          },
        },
      };
      const ok = await req('PUT', `/workers/${workerId}/config`, { spec: good, expectedGeneration: 0 });
      expect(ok.statusCode, ok.body).toBe(200);
      const view = ok.json<{
        credentialOptions: { id: string; sharedWithWorker: boolean }[];
        vault: { supported: boolean };
      }>();
      expect(view.vault.supported).toBe(true);
      expect(view.credentialOptions).toEqual([
        expect.objectContaining({ id: 'openrouter', sharedWithWorker: true }),
      ]);
      const c = (await h.app.orchestrator.candidates('alpha')).find((w) => w.id === workerId);
      expect(c?.managed?.runtimeCredentials?.pi).toEqual({
        credentialId: 'openrouter',
        state: 'ready',
      });
    });

    it('rotation is a new version (optimistic) and resets the acknowledgement', async () => {
      await stepUp();
      const conflict = await req('PUT', '/vault/credentials/openrouter/value', {
        expectedVersion: 7,
        workers: [await seal(VALUE_2, 8)],
      });
      expect(conflict.statusCode).toBe(409);
      const res = await req('PUT', '/vault/credentials/openrouter/value', {
        expectedVersion: 1,
        workers: [await seal(VALUE_2, 2)],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<CredentialBody>().workers[0]).toMatchObject({ version: 2, status: 'pending' });
      const a = await worker.next('APPLY_CREDENTIAL');
      expect(a.payload.version).toBe(2);
      const c = (await h.app.orchestrator.candidates('alpha')).find((w) => w.id === workerId);
      expect(c?.managed?.runtimeCredentials?.pi?.state).toBe('pending');
      // A refusal is recorded (and not re-sent in a loop); the panel asks for re-entry on key problems.
      worker.sendJson(
        worker.envelope(
          'CREDENTIAL_STATUS',
          { credentialId: 'openrouter', version: 2, outcome: 'rejected', reason: 'unknown_key' },
          { workerId },
        ),
      );
      await expect
        .poll(
          async () =>
            (await req('GET', '/vault/credentials')).json<{ items: CredentialBody[] }>().items[0]?.workers[0]
              ?.status,
        )
        .toBe('needs_reseal');
    });

    it('revocation deletes every ciphertext and tells the worker to delete it', async () => {
      // The worker still holds v1 (its report says so).
      capabilities({
        key: announcement(vk),
        credentials: [
          {
            id: 'openrouter',
            version: 1,
            kind: 'openrouter',
            env: 'OPENROUTER_API_KEY',
            appliedAt: createdAt,
          },
        ],
        revoked: [],
      });
      await stepUp();
      const res = await req('DELETE', '/vault/credentials/openrouter');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<CredentialBody>().state).toBe('revoked');
      const revoke = await worker.next('REVOKE_CREDENTIAL');
      expect(revoke.payload).toMatchObject({ credentialId: 'openrouter' });
      const rows = await h.db.pool.query('SELECT 1 FROM vault_credential_workers WHERE sealed IS NOT NULL');
      expect(rows.rowCount).toBe(0);
      worker.sendJson(
        worker.envelope(
          'CREDENTIAL_STATUS',
          { credentialId: 'openrouter', version: 2, outcome: 'revoked' },
          { workerId },
        ),
      );
      await expect
        .poll(
          async () =>
            (await req('GET', '/vault/credentials')).json<{ items: CredentialBody[] }>().items[0]?.workers[0]
              ?.status,
        )
        .toBe('revoked');
    });

    it('never stores, logs, audits or returns a plaintext value', async () => {
      const tables = [
        'vault_credentials',
        'vault_credential_workers',
        'audit_events',
        'outbox',
        'notifications',
      ];
      for (const t of tables) {
        const { rows } = await h.db.pool.query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM ${t} x`);
        const dump = rows.map((r) => r.j).join('\n');
        expect(dump, t).not.toContain(VALUE);
        expect(dump, t).not.toContain(VALUE_2);
      }
      expect(h.logs.text).not.toContain(VALUE);
      expect(h.logs.text).not.toContain(VALUE_2);
      for (const body of responses) {
        expect(body).not.toContain(VALUE);
        expect(body).not.toContain(VALUE_2);
        // Responses never carry ciphertext either.
        expect(body).not.toContain('"ct"');
      }
      const audit = await h.db.pool.query<{ action: string }>(
        "SELECT action FROM audit_events WHERE action LIKE 'vault.%' ORDER BY occurred_at",
      );
      expect(audit.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'vault.key.pinned',
          'vault.credential.create',
          'vault.credential.rotate',
          'vault.credential.rejected',
          'vault.credential.revoke',
        ]),
      );
    });
  });
});
