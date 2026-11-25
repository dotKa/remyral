import { generateKeyPairSync, sign } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import {
  type ApplyCredentialPayload,
  type LeaseKey,
  leaseKeyId,
  type RevokeCredentialPayload,
  sealCredential,
  sealedDigest,
  signCredentialDelivery,
  verifyVaultKey,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { FileSecretStore } from '../src/secrets/store.js';
import { CredentialVault, trackVaultUse, VAULT_INDEX_FILE, VAULT_KEY_FILE } from '../src/vault/index.js';
import { captureLines, isWindows, nodeOps, tempDir } from './helpers.js';

const WORKER = 'wrk_1';
const VALUE = 'sk-live-0123456789abcdefSECRET';
const ISSUED = '2026-10-14T10:00:00.000Z';

function leasePair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  const key: LeaseKey = { kid: leaseKeyId(raw), publicKey: raw };
  return { privateKey, key };
}
const master = leasePair();

async function setup(opts: { keys?: readonly LeaseKey[]; pinned?: boolean } = {}) {
  const dataDir = await tempDir();
  const ops = nodeOps();
  const secrets = new FileSecretStore(ops, dataDir);
  const log = captureLines();
  const logger = createLogger({ level: 'debug', sink: log.sink });
  const { vault, keyCreated } = await CredentialVault.open({
    ops,
    dataDir,
    secrets,
    keySource: () => ({ keys: opts.keys ?? [master.key], pinned: opts.pinned ?? false }),
    logger,
  });
  return { dataDir, ops, secrets, log, logger, vault, keyCreated };
}

async function delivery(
  vault: CredentialVault,
  over: Partial<{
    id: string;
    version: number;
    value: string;
    env: string;
    workerId: string;
    sign: boolean;
    signFor: string;
    publicKey: string;
    keyId: string;
  }> = {},
): Promise<ApplyCredentialPayload> {
  const id = over.id ?? 'anthropic-main';
  const version = over.version ?? 1;
  const env = over.env ?? 'ANTHROPIC_API_KEY';
  const kind = 'anthropic' as const;
  const keyId = over.keyId ?? vault.keys.current.keyId;
  const publicKey = over.publicKey ?? vault.keys.current.publicKey;
  const sealed = await sealCredential(over.value ?? VALUE, publicKey, {
    workerId: over.workerId ?? WORKER,
    credentialId: id,
    version,
    keyId,
    kind,
    env,
  });
  const base = { credentialId: id, version, kind, env, sealed, issuedAt: ISSUED };
  if (over.sign === false) return base;
  return {
    ...base,
    signature: signCredentialDelivery(
      {
        op: 'apply',
        workerId: over.signFor ?? WORKER,
        credentialId: id,
        version,
        digest: sealedDigest(base),
        issuedAt: ISSUED,
      },
      master.key.kid,
      master.privateKey,
    ),
  };
}

/** Re-signs a (modified) delivery as the master would, so only the sealed content is wrong. */
function resign(p: ApplyCredentialPayload): ApplyCredentialPayload {
  const { signature: _s, ...base } = p;
  return {
    ...base,
    signature: signCredentialDelivery(
      {
        op: 'apply',
        workerId: WORKER,
        credentialId: p.credentialId,
        version: p.version,
        digest: sealedDigest(base),
        issuedAt: p.issuedAt,
      },
      master.key.kid,
      master.privateKey,
    ),
  };
}

function revocation(id: string, version: number, signFor = WORKER): RevokeCredentialPayload {
  return {
    credentialId: id,
    version,
    issuedAt: ISSUED,
    signature: signCredentialDelivery(
      { op: 'revoke', workerId: signFor, credentialId: id, version, digest: '-', issuedAt: ISSUED },
      master.key.kid,
      master.privateKey,
    ),
  };
}

describe('vault key', () => {
  it('is generated on first start, private (0600), and reused afterwards', async () => {
    const s = await setup();
    expect(s.keyCreated).toBe(true);
    if (!isWindows) {
      expect((await stat(join(s.dataDir, VAULT_KEY_FILE))).mode & 0o777).toBe(0o600);
    }
    const again = await CredentialVault.open({
      ops: s.ops,
      dataDir: s.dataDir,
      secrets: s.secrets,
      keySource: () => ({ keys: [], pinned: false }),
      logger: s.logger,
    });
    expect(again.keyCreated).toBe(false);
    expect(again.vault.keys.current.keyId).toBe(s.vault.keys.current.keyId);
  });

  it('is announced signed by the device key, bound to the worker id; not before enrollment', async () => {
    const { vault } = await setup();
    const device = generateKeyPairSync('ed25519');
    const devicePub = String(device.publicKey.export({ format: 'jwk' }).x);
    const report = vault.report(WORKER, (d) => sign(null, d, device.privateKey).toString('base64url'));
    expect(report.key).not.toBeNull();
    if (report.key === null) return;
    expect(verifyVaultKey(WORKER, devicePub, report.key)).toBe(true);
    expect(verifyVaultKey('wrk_other', devicePub, report.key)).toBe(false);
    expect(vault.report(null, () => 'x').key).toBeNull();
  });

  it('rotation keeps the previous key so a value sealed before it still opens', async () => {
    const { vault, secrets } = await setup();
    const old = vault.keys.current;
    const sealedBefore = await delivery(vault);
    await vault.rotateKey();
    expect(vault.keys.current.keyId).not.toBe(old.keyId);
    expect(vault.keys.previous?.keyId).toBe(old.keyId);
    expect(vault.report(WORKER, () => 'A'.repeat(86)).previousKeyId).toBe(old.keyId);
    expect((await vault.apply(WORKER, sealedBefore)).status.outcome).toBe('applied');
    expect((await secrets.get('vault-anthropic-main'))?.reveal()).toBe(VALUE);
    // Two rotations later the old key is gone: the master must have it re-entered.
    await vault.rotateKey();
    await vault.rotateKey();
    const r = await vault.apply(
      WORKER,
      resign({ ...(await delivery(vault, { version: 2 })), sealed: { ...sealedBefore.sealed } }),
    );
    expect(r.status).toMatchObject({ outcome: 'rejected', reason: 'unknown_key' });
  });
});

describe('APPLY_CREDENTIAL / REVOKE_CREDENTIAL', () => {
  it('applies, stores the value as vault-<id>, reports id and version only, and acks unchanged on replay', async () => {
    const { vault, secrets, dataDir, log } = await setup();
    const d = await delivery(vault);
    const r = await vault.apply(WORKER, d);
    expect(r).toMatchObject({
      status: { credentialId: 'anthropic-main', version: 1, outcome: 'applied' },
      changed: true,
    });
    expect(JSON.stringify(r)).not.toContain(VALUE);
    expect((await secrets.get('vault-anthropic-main'))?.reveal()).toBe(VALUE);
    expect(vault.held('anthropic-main')).toBe(true);
    expect(vault.env('anthropic-main')).toBe('ANTHROPIC_API_KEY');
    const report = vault.report(WORKER, () => 'A'.repeat(86));
    expect(report.credentials).toEqual([
      expect.objectContaining({
        id: 'anthropic-main',
        version: 1,
        kind: 'anthropic',
        env: 'ANTHROPIC_API_KEY',
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain(VALUE);
    // Replay of the same delivery: no effect.
    expect(await vault.apply(WORKER, d)).toMatchObject({ status: { outcome: 'unchanged' }, changed: false });
    // The index never holds the value; neither do logs.
    const index = await nodeOps().readFile(join(dataDir, VAULT_INDEX_FILE), 1 << 20);
    expect(index?.toString('utf8')).not.toContain(VALUE);
    if (!isWindows) expect((await stat(join(dataDir, VAULT_INDEX_FILE))).mode & 0o777).toBe(0o600);
    expect(log.lines.join('\n')).not.toContain(VALUE);
  });

  it('rotation = new version; older versions are stale; same version with another value is refused', async () => {
    const { vault, secrets } = await setup();
    await vault.apply(WORKER, await delivery(vault, { version: 1 }));
    const v2 = await vault.apply(WORKER, await delivery(vault, { version: 2, value: 'sk-rotated-value-2' }));
    expect(v2.status.outcome).toBe('applied');
    expect((await secrets.get('vault-anthropic-main'))?.reveal()).toBe('sk-rotated-value-2');
    expect((await vault.apply(WORKER, await delivery(vault, { version: 1 }))).status).toMatchObject({
      outcome: 'stale',
      reason: 'older_version',
    });
    expect(
      (await vault.apply(WORKER, await delivery(vault, { version: 2, value: 'sk-other-value-x' }))).status,
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'version_conflict',
    });
    expect((await secrets.get('vault-anthropic-main'))?.reveal()).toBe('sk-rotated-value-2');
  });

  it.each([
    ['tampered ciphertext', 'open_failed'],
    ['sealed for another worker', 'open_failed'],
    ['another worker key', 'unknown_key'],
    ['re-targeted env var', 'open_failed'],
    ['signature for another worker', 'bad_signature'],
    ['unsigned', 'unsigned'],
    ['subscription token', 'subscription_token'],
  ] as const)('refuses %s (%s) and stores nothing', async (what, reason) => {
    const { vault, secrets, log } = await setup();
    let d: ApplyCredentialPayload;
    switch (what) {
      case 'tampered ciphertext': {
        d = await delivery(vault);
        const ct = Buffer.from(d.sealed.ct, 'base64url');
        ct[3] = (ct[3] ?? 0) ^ 0xff;
        d = resign({ ...d, sealed: { ...d.sealed, ct: ct.toString('base64url') } });
        break;
      }
      case 'sealed for another worker':
        d = await delivery(vault, { workerId: 'wrk_other' });
        break;
      case 'another worker key': {
        const other = await setup();
        d = await delivery(vault, {
          publicKey: other.vault.keys.current.publicKey,
          keyId: other.vault.keys.current.keyId,
        });
        break;
      }
      case 're-targeted env var':
        d = resign({ ...(await delivery(vault)), env: 'OPENAI_API_KEY' });
        break;
      case 'signature for another worker':
        d = await delivery(vault, { signFor: 'wrk_other' });
        break;
      case 'unsigned':
        d = await delivery(vault, { sign: false });
        break;
      case 'subscription token':
        d = await delivery(vault, { value: 'sk-ant-oat01-abcdefghijklmnop' });
        break;
    }
    const r = await vault.apply(WORKER, d);
    expect(r.status).toMatchObject({ outcome: 'rejected', reason });
    expect(r.changed).toBe(false);
    expect(await secrets.list()).toEqual([]);
    expect(vault.held('anthropic-main')).toBe(false);
    expect(log.lines.join('\n')).not.toContain(VALUE);
    expect(log.lines.join('\n')).not.toContain('sk-ant-oat01');
  });

  it('pinned master keys make an unsigned delivery fail even without session keys', async () => {
    const { vault } = await setup({ keys: [], pinned: true });
    expect((await vault.apply(WORKER, await delivery(vault, { sign: false }))).status.reason).toBe(
      'unsigned',
    );
  });

  it('with no trusted keys at all an unsigned delivery is accepted (logged)', async () => {
    const { vault, log } = await setup({ keys: [], pinned: false });
    expect((await vault.apply(WORKER, await delivery(vault, { sign: false }))).status.outcome).toBe(
      'applied',
    );
    expect(log.lines.join('\n')).toContain('without signature check');
  });

  it('refuses before enrollment', async () => {
    const { vault } = await setup();
    const enrolledAs: string | null = null;
    const r = await vault.apply(enrolledAs, await delivery(vault));
    expect(r.status.reason).toBe('not_enrolled');
  });

  it('revocation deletes the value, leaves a tombstone and makes a late re-delivery stale', async () => {
    const { vault, secrets } = await setup();
    const d = await delivery(vault, { version: 2 });
    await vault.apply(WORKER, d);
    const unsigned = await vault.revoke(WORKER, {
      credentialId: 'anthropic-main',
      version: 2,
      issuedAt: ISSUED,
    });
    expect(unsigned.status.reason).toBe('unsigned');
    expect(vault.held('anthropic-main')).toBe(true);
    const r = await vault.revoke(WORKER, revocation('anthropic-main', 2));
    expect(r).toMatchObject({ status: { outcome: 'revoked' }, changed: true });
    expect(await secrets.get('vault-anthropic-main')).toBeNull();
    expect(vault.held('anthropic-main')).toBe(false);
    expect(vault.report(WORKER, () => 'A'.repeat(86)).revoked).toEqual([
      { id: 'anthropic-main', version: 2 },
    ]);
    expect((await vault.apply(WORKER, d)).status).toMatchObject({ outcome: 'stale', reason: 'revoked' });
    // Idempotent; a newer version is accepted again.
    expect((await vault.revoke(WORKER, revocation('anthropic-main', 2))).changed).toBe(false);
    expect((await vault.apply(WORKER, await delivery(vault, { version: 3 }))).status.outcome).toBe('applied');
    // A revocation older than the held version does not delete it.
    expect((await vault.revoke(WORKER, revocation('anthropic-main', 2))).status.outcome).toBe('stale');
    expect(vault.held('anthropic-main')).toBe(true);
    expect((await vault.revoke(WORKER, revocation('anthropic-main', 3, 'wrk_other'))).status.reason).toBe(
      'bad_signature',
    );
  });

  it('state survives a restart', async () => {
    const s = await setup();
    const d = await delivery(s.vault);
    await s.vault.apply(WORKER, d);
    const again = await CredentialVault.open({
      ops: s.ops,
      dataDir: s.dataDir,
      secrets: s.secrets,
      keySource: () => ({ keys: [master.key], pinned: false }),
      logger: s.logger,
    });
    expect(again.vault.held('anthropic-main')).toBe(true);
    expect((await again.vault.apply(WORKER, d)).status.outcome).toBe('unchanged');
    expect(again.vault.keys.current.keyId).toBe(s.vault.keys.current.keyId);
  });

  it('records last use when a job reads the credential, and notifies subscribers on change', async () => {
    let t = Date.parse('2026-10-14T10:00:00.000Z');
    const dataDir = await tempDir();
    const ops = nodeOps();
    const secrets = new FileSecretStore(ops, dataDir);
    const { vault } = await CredentialVault.open({
      ops,
      dataDir,
      secrets,
      keySource: () => ({ keys: [master.key], pinned: false }),
      logger: createLogger({ level: 'silent', sink: () => undefined }),
      clock: () => new Date(t),
    });
    let notified = 0;
    vault.subscribe(() => {
      notified++;
    });
    await vault.apply(WORKER, await delivery(vault));
    expect(notified).toBe(1);
    const tracked = trackVaultUse(secrets, (n) => {
      vault.markUsed(n);
    });
    t += 5_000;
    expect((await tracked.get('vault-anthropic-main'))?.reveal()).toBe(VALUE);
    expect(vault.report(WORKER, () => 'A'.repeat(86)).credentials[0]?.lastUsedAt).toBe(
      '2026-10-14T10:00:05.000Z',
    );
  });
});
