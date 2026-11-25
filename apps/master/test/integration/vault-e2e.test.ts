import { sealCredential } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const VALUE = 'sk-proj-END-TO-END-plaintext-only-on-the-worker-0123456789';

interface VaultWorker {
  workerId: string;
  key: { keyId: string; publicKey: string; fingerprint: string } | null;
}

/**
 * Master ↔ real worker contract for the credential vault (p5-credentials-models): the real worker announces its
 * device-signed X25519 key, the "browser" (this test) seals to it, the master relays ciphertext signed with its
 * lease key, the worker's own vault verifies, opens and stores the value, acknowledges it, and deletes it on
 * revocation. The value exists only here and on the worker.
 */
describeIntegration('credential vault with a real worker (integration, p5-credentials-models)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  const dirs: string[] = [];
  let running: RunningWorker | undefined;
  let workerId = '';

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function status(): Promise<string | undefined> {
    const res = await admin.req('GET', '/vault/credentials');
    return res.json<{ items: { workers: { status: string }[] }[] }>().items[0]?.workers[0]?.status;
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
  });

  afterAll(async () => {
    await running?.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  it('pins the worker key, delivers a sealed value the worker stores, and revokes it', async () => {
    await stepUp();
    const dataDir = await tempDataDir(dirs);
    workerId = await pairRealWorker(h, url, admin, secret, dataDir);
    const w = await runRealWorker(url, dataDir, { capabilities: CAPS, vault: true });
    running = w;
    let key: VaultWorker['key'] = null;
    await expect
      .poll(
        async () => {
          const res = await admin.req('GET', '/vault/workers');
          key = res.json<{ items: VaultWorker[] }>().items.find((w) => w.workerId === workerId)?.key ?? null;
          return key?.keyId;
        },
        { timeout: 10_000 },
      )
      .toBe(w.vault?.keys.current.keyId);
    const k = key as unknown as NonNullable<VaultWorker['key']>;
    await stepUp();
    const sealed = await sealCredential(VALUE, k.publicKey, {
      workerId,
      credentialId: 'openai',
      version: 1,
      keyId: k.keyId,
      kind: 'openai',
      env: 'OPENAI_API_KEY',
    });
    const res = await admin.req('POST', '/vault/credentials', {
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai',
      env: 'OPENAI_API_KEY',
      workers: [{ workerId, keyId: k.keyId, sealed }],
    });
    expect(res.statusCode, res.body).toBe(200);
    await expect.poll(status, { timeout: 10_000 }).toBe('applied');
    expect((await w.secrets.get('vault-openai'))?.reveal()).toBe(VALUE);
    expect(JSON.stringify(w.lines)).not.toContain(VALUE);
    expect(h.logs.text).not.toContain(VALUE);

    await stepUp();
    expect((await admin.req('DELETE', '/vault/credentials/openai')).statusCode).toBe(200);
    await expect.poll(status, { timeout: 10_000 }).toBe('revoked');
    expect(await w.secrets.get('vault-openai')).toBeNull();
  });
});
