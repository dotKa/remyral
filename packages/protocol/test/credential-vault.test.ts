import { generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ApplyCredentialPayload,
  catalogProfile,
  catalogSettings,
  credentialDeliveryStatement,
  credentialValueIssue,
  CredentialVaultReport,
  leaseKeyId,
  MasterToWorker,
  ModelCatalogEntryInput,
  openCredential,
  type SealBinding,
  sealCredential,
  sealedDigest,
  SealError,
  signCredentialDelivery,
  vaultKeyFingerprint,
  vaultKeyId,
  vaultKeyStatement,
  verifyCredentialDelivery,
  verifyVaultKey,
  workerConfigIssues,
  type WorkerConfigDocument,
  WorkerToMaster,
  x25519Supported,
} from '../src/index.js';
import { masterMessages, workerMessages } from './fixtures.js';

type Key = Parameters<typeof openCredential>[1];
const subtle = webcrypto.subtle;

async function workerKey(): Promise<{ publicKey: string; privateKey: Key; keyId: string }> {
  const pair = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as unknown as {
    publicKey: Key;
    privateKey: Key;
  };
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const publicKey = Buffer.from(raw).toString('base64url');
  return { publicKey, privateKey: pair.privateKey, keyId: await vaultKeyId(publicKey) };
}

const VALUE = 'sk-test-0123456789abcdef';

function binding(keyId: string, over: Partial<SealBinding> = {}): SealBinding {
  return {
    workerId: 'wrk_mac1',
    credentialId: 'anthropic-main',
    version: 1,
    keyId,
    kind: 'anthropic',
    env: 'ANTHROPIC_API_KEY',
    ...over,
  };
}

describe('credential sealing (browser → worker)', () => {
  it('X25519 is available in this runtime', async () => {
    expect(await x25519Supported()).toBe(true);
  });

  it('seals and opens with the worker key; the ciphertext carries no plaintext', async () => {
    const k = await workerKey();
    const sealed = await sealCredential(VALUE, k.publicKey, binding(k.keyId));
    expect(ApplyCredentialPayload.shape.sealed.safeParse(sealed).success).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain(VALUE);
    expect(await openCredential(sealed, k.privateKey, k.publicKey, binding(k.keyId))).toBe(VALUE);
  });

  it('every seal is fresh (ephemeral key, nonce)', async () => {
    const k = await workerKey();
    const a = await sealCredential(VALUE, k.publicKey, binding(k.keyId));
    const b = await sealCredential(VALUE, k.publicKey, binding(k.keyId));
    expect(a.epk).not.toBe(b.epk);
    expect(a.ct).not.toBe(b.ct);
  });

  it('refuses a key id that does not belong to the public key', async () => {
    const k = await workerKey();
    await expect(sealCredential(VALUE, k.publicKey, binding('x'.repeat(22)))).rejects.toBeInstanceOf(
      SealError,
    );
  });

  it('a tampered ciphertext does not open', async () => {
    const k = await workerKey();
    const sealed = await sealCredential(VALUE, k.publicKey, binding(k.keyId));
    const ct = Buffer.from(sealed.ct, 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 1;
    await expect(
      openCredential(
        { ...sealed, ct: ct.toString('base64url') },
        k.privateKey,
        k.publicKey,
        binding(k.keyId),
      ),
    ).rejects.toMatchObject({ code: 'open_failed' });
  });

  it('another worker key cannot open it', async () => {
    const k = await workerKey();
    const other = await workerKey();
    const sealed = await sealCredential(VALUE, k.publicKey, binding(k.keyId));
    await expect(
      openCredential(sealed, other.privateKey, other.publicKey, binding(k.keyId)),
    ).rejects.toMatchObject({ code: 'open_failed' });
  });

  it.each([
    ['workerId', { workerId: 'wrk_other' }],
    ['credentialId', { credentialId: 'other' }],
    ['version (replay as another version)', { version: 2 }],
    ['env (re-targeting)', { env: 'NODE_OPTIONS' }],
    ['kind', { kind: 'openai' }],
  ] as const)('a changed %s does not open', async (_n, over) => {
    const k = await workerKey();
    const sealed = await sealCredential(VALUE, k.publicKey, binding(k.keyId));
    await expect(
      openCredential(sealed, k.privateKey, k.publicKey, binding(k.keyId, over)),
    ).rejects.toMatchObject({ code: 'open_failed' });
  });

  it('fingerprints are stable and formatted', async () => {
    const k = await workerKey();
    const fp = await vaultKeyFingerprint(k.publicKey);
    expect(fp).toMatch(/^X25519:([0-9A-F]{4}-){15}[0-9A-F]{4}$/);
    expect(await vaultKeyFingerprint(k.publicKey)).toBe(fp);
  });
});

describe('credential values and messages', () => {
  it('refuses Claude subscription tokens and out-of-bounds values', () => {
    expect(credentialValueIssue('sk-ant-oat01-abcdefghijkl')).toBe('subscription_token');
    expect(credentialValueIssue('abc')).toBe('too_short');
    expect(credentialValueIssue('a'.repeat(16 * 1024 + 1))).toBe('too_long');
    expect(credentialValueIssue('sk-ant-api03-abcdefgh')).toBeNull();
  });

  it('refuses forbidden target env vars', () => {
    const p = masterMessages.APPLY_CREDENTIAL.payload;
    for (const env of ['CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS', 'LD_PRELOAD', 'PATH']) {
      expect(ApplyCredentialPayload.safeParse({ ...p, env }).success).toBe(false);
    }
  });

  it('new messages parse', () => {
    for (const t of ['APPLY_CREDENTIAL', 'REVOKE_CREDENTIAL', 'ROTATE_VAULT_KEY'] as const) {
      expect(MasterToWorker.safeParse(masterMessages[t]).success).toBe(true);
    }
    expect(WorkerToMaster.safeParse(workerMessages.CREDENTIAL_STATUS).success).toBe(true);
  });
});

describe('signatures', () => {
  it('vault key announcement is bound to the worker and the device key', async () => {
    const device = generateKeyPairSync('ed25519');
    const devicePub = device.publicKey.export({ format: 'jwk' }).x ?? '';
    const k = await workerKey();
    const createdAt = '2026-10-14T10:00:00.000Z';
    const signature = sign(
      null,
      vaultKeyStatement({ workerId: 'wrk_mac1', keyId: k.keyId, publicKey: k.publicKey, createdAt }),
      device.privateKey,
    ).toString('base64url');
    const ann = { keyId: k.keyId, publicKey: k.publicKey, createdAt, signature };
    expect(verifyVaultKey('wrk_mac1', devicePub, ann)).toBe(true);
    expect(verifyVaultKey('wrk_other', devicePub, ann)).toBe(false);
    const other = await workerKey();
    expect(verifyVaultKey('wrk_mac1', devicePub, { ...ann, publicKey: other.publicKey })).toBe(false);
    expect(CredentialVaultReport.safeParse({ key: ann, credentials: [], revoked: [] }).success).toBe(true);
  });

  it('delivery signatures bind op, worker, credential, version and digest', () => {
    const lease = generateKeyPairSync('ed25519');
    const pub = lease.publicKey.export({ format: 'jwk' }).x ?? '';
    const kid = leaseKeyId(pub);
    const p = ApplyCredentialPayload.parse(masterMessages.APPLY_CREDENTIAL.payload);
    const input = {
      op: 'apply' as const,
      workerId: 'wrk_mac1',
      credentialId: p.credentialId,
      version: p.version,
      digest: sealedDigest(p),
      issuedAt: p.issuedAt,
    };
    const sig = signCredentialDelivery(input, kid, lease.privateKey);
    const keys = [{ kid, publicKey: pub }];
    expect(verifyCredentialDelivery(input, sig, keys)).toBe('ok');
    expect(verifyCredentialDelivery({ ...input, version: 3 }, sig, keys)).toBe('bad_signature');
    expect(verifyCredentialDelivery({ ...input, workerId: 'w2' }, sig, keys)).toBe('bad_signature');
    expect(verifyCredentialDelivery({ ...input, op: 'revoke' }, sig, keys)).toBe('bad_signature');
    expect(
      verifyCredentialDelivery({ ...input, digest: sealedDigest({ ...p, env: 'X_KEY' }) }, sig, keys),
    ).toBe('bad_signature');
    expect(verifyCredentialDelivery(input, undefined, keys)).toBe('missing');
    expect(verifyCredentialDelivery(input, sig, [])).toBe('unknown_key');
    expect(credentialDeliveryStatement(input).toString('utf8')).not.toContain('C'.repeat(40));
  });
});

describe('vault references in worker configuration', () => {
  const doc: WorkerConfigDocument = {
    schemaVersion: 1,
    projects: {},
    allowedRuntimes: ['pi'],
    maxParallelJobs: 1,
    sandboxProfiles: ['container'],
    workspace: {},
    labels: {},
    runtimes: {
      pi: { auth: { mode: 'secret-ref', credentialRef: { source: 'vault', id: 'openrouter' } } },
    },
  };
  it('is refused without vault support and accepted with it', () => {
    expect(workerConfigIssues(doc).map((i) => i.code)).toEqual(['credential_source_unsupported']);
    expect(workerConfigIssues(doc, { vault: true })).toEqual([]);
  });
});

describe('model catalog', () => {
  const entry = ModelCatalogEntryInput.parse({
    id: 'sonnet',
    displayName: 'Sonnet via OpenRouter',
    runtimes: ['pi', 'claude-code'],
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.5',
    credentialRef: { source: 'vault', id: 'openrouter' },
    enabled: true,
  });
  it('projects onto each runtime', () => {
    expect(catalogProfile(entry)).toEqual({
      name: 'sonnet',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      params: {},
    });
    expect(catalogSettings('pi', entry)).toMatchObject({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
    });
    expect(catalogSettings('claude-code', entry)).toMatchObject({ model: 'anthropic/claude-sonnet-4.5' });
  });
  it('refuses OpenHands for new entries (ADR-0023)', () => {
    expect(ModelCatalogEntryInput.safeParse({ ...entry, runtimes: ['openhands'] }).success).toBe(false);
  });
});
