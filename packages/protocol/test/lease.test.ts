import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { challengePayload } from '../src/auth.js';
import {
  JobSpec,
  LEASE_SIGNATURE_CONTEXT,
  leaseKeyId,
  leaseTtlMs,
  MasterToWorker,
  MAX_VAULT_SCOPE_IDS,
  signLeaseToken,
  signVaultScope,
  vaultIdOfSecretRef,
  verifyLeaseToken,
  verifyVaultScope,
  WorkerToMaster,
} from '../src/index.js';
import { envelope, jobId, workerId } from './fixtures.js';

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

const claims = (kid: string) => ({
  v: 1 as const,
  kid,
  jobId: 'job-1',
  attemptId: 'att-1',
  workerId: 'wrk_abc',
  epoch: 4,
  iat: '2026-10-13T10:00:00.000Z',
  exp: '2026-10-13T10:01:30.000Z',
});

describe('lease tokens (ADR-0004 §1)', () => {
  it('round-trips and binds every field', () => {
    const { privateKey, key } = keyPair();
    const token = signLeaseToken(claims(key.kid), privateKey);
    expect(token.startsWith('rlt1.')).toBe(true);
    const ok = verifyLeaseToken(token, [key], {
      jobId: 'job-1',
      attemptId: 'att-1',
      workerId: 'wrk_abc',
      epoch: 4,
      expiresAt: '2026-10-13T10:01:30.000Z',
    });
    expect(ok).toEqual({ ok: true, claims: claims(key.kid) });
    if (ok.ok) expect(leaseTtlMs(ok.claims)).toBe(90_000);
    for (const wrong of [
      { epoch: 5 },
      { attemptId: 'att-2' },
      { workerId: 'wrk_other' },
      { jobId: 'job-2' },
      { expiresAt: '2026-10-13T11:00:00.000Z' },
    ]) {
      expect(verifyLeaseToken(token, [key], wrong)).toEqual({ ok: false, reason: 'mismatch' });
    }
  });

  it('refuses unknown keys, tampered claims and foreign signatures', () => {
    const a = keyPair();
    const b = keyPair();
    const token = signLeaseToken(claims(a.key.kid), a.privateKey);
    expect(verifyLeaseToken(token, [b.key])).toEqual({ ok: false, reason: 'unknown_key' });
    // Same kid, other key material.
    expect(verifyLeaseToken(token, [{ kid: a.key.kid, publicKey: b.key.publicKey }])).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const [p, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims(a.key.kid), epoch: 99 })).toString('base64url');
    expect(verifyLeaseToken(`${String(p)}.${forged}.${String(s)}`, [a.key]).ok).toBe(false);
    expect(verifyLeaseToken('garbage', [a.key])).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyLeaseToken('rlt1.!!.x', [a.key])).toEqual({ ok: false, reason: 'malformed' });
  });

  it('is domain separated from AUTH challenges', () => {
    const { privateKey, key } = keyPair();
    const segment = Buffer.from(JSON.stringify(claims(key.kid))).toString('base64url');
    // A signature the worker-auth context would produce over the same bytes is not a lease signature.
    const authSig = sign(null, challengePayload(segment), privateKey).toString('base64url');
    expect(verifyLeaseToken(`rlt1.${segment}.${authSig}`, [key])).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(LEASE_SIGNATURE_CONTEXT).toBe('remana-lease/v1\n');
  });

  it('judges expiry only when asked (master clock)', () => {
    const { privateKey, key } = keyPair();
    const token = signLeaseToken(claims(key.kid), privateKey);
    expect(verifyLeaseToken(token, [key], {}, new Date('2026-10-13T10:01:30.000Z'))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyLeaseToken(token, [key], {}, new Date('2026-10-13T10:01:29.999Z')).ok).toBe(true);
  });
});

describe('p4 protocol additions (additive in 1.0)', () => {
  const spec = {
    runtime: 'codex',
    prompt: 'x',
    repository: { url: 'https://example.com/r.git', baseRef: 'main', workBranch: 'w' },
    sandboxProfile: 'host-restricted',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 60 },
  };

  it('JobSpec without the new fields stays valid; new fields are validated', () => {
    expect(JobSpec.safeParse(spec).success).toBe(true);
    expect(
      JobSpec.safeParse({
        ...spec,
        projectId: 'acme',
        secretRefs: { GATEWAY_KEY: 'worker:wrk_abc/secret:gw' },
        requirements: { os: ['linux'], arch: ['arm64'] },
      }).success,
    ).toBe(true);
    expect(JobSpec.safeParse({ ...spec, secretRefs: { GATEWAY_KEY: 'sk-live-value' } }).success).toBe(false);
    expect(JobSpec.safeParse({ ...spec, secretRefs: { 'bad name': 'secret:x' } }).success).toBe(false);
  });

  it('JobSpec.requirements tools and worker affinity (p5-composer, additive) are validated', () => {
    expect(
      JobSpec.safeParse({
        ...spec,
        requirements: { tools: ['git', 'node', 'docker'], workers: ['wrk_abc'] },
      }).success,
    ).toBe(true);
    expect(JobSpec.safeParse({ ...spec, requirements: { tools: ['git; rm -rf /'] } }).success).toBe(false);
    expect(JobSpec.safeParse({ ...spec, requirements: { tools: [] } }).success).toBe(false);
    expect(JobSpec.safeParse({ ...spec, requirements: { workers: [] } }).success).toBe(false);
  });

  it('CREDENTIAL_REQUEST / JOB_CREDENTIAL / memory events parse', () => {
    const requestId = '6f1b4f1e-0d6a-4f39-9b1a-2d1a4f0c9e11';
    expect(
      WorkerToMaster.safeParse(
        envelope('CREDENTIAL_REQUEST', {
          workerId,
          jobId,
          payload: { attemptId: 'a', epoch: 1, requestId, kind: 'git' },
        }),
      ).success,
    ).toBe(true);
    expect(
      MasterToWorker.safeParse(
        envelope('JOB_CREDENTIAL', {
          workerId,
          jobId,
          payload: { attemptId: 'a', epoch: 1, requestId, kind: 'git', status: 'unavailable' },
        }),
      ).success,
    ).toBe(true);
    expect(
      WorkerToMaster.safeParse(
        envelope('EVENT', {
          workerId,
          jobId,
          seq: 1,
          payload: { attemptId: 'a', epoch: 1, event: { kind: 'memory', title: 't', content: 'c' } },
        }),
      ).success,
    ).toBe(true);
  });
});

describe('lease vault scope (job secret references)', () => {
  const scope = (kid: string, vault: string[]) => {
    const { iat: _i, exp: _e, ...rest } = claims(kid);
    return { ...rest, vault };
  };

  it('round-trips sorted and unique, bound to its lease', () => {
    const { privateKey, key } = keyPair();
    const token = signVaultScope(scope(key.kid, ['b', 'a', 'b']), privateKey);
    expect(token.startsWith('rvs1.')).toBe(true);
    const ok = verifyVaultScope(token, [key], {
      jobId: 'job-1',
      attemptId: 'att-1',
      workerId: 'wrk_abc',
      epoch: 4,
    });
    expect(ok).toMatchObject({ ok: true, claims: { vault: ['a', 'b'] } });
    expect(verifyVaultScope(token, [key], { epoch: 5 })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyVaultScope(token, [key], { attemptId: 'att-2' })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('is never interchangeable with a lease token (distinct prefix and signing context)', () => {
    const { privateKey, key } = keyPair();
    const token = signVaultScope(scope(key.kid, []), privateKey);
    expect(verifyLeaseToken(token, [key])).toEqual({ ok: false, reason: 'malformed' });
    // The same claims segment under the lease prefix does not verify as a lease (other context, other claims).
    expect(verifyLeaseToken(`rlt1.${token.slice(5)}`, [key])).toEqual({ ok: false, reason: 'bad_signature' });
    const lease = signLeaseToken(claims(key.kid), privateKey);
    expect(verifyVaultScope(`rvs1.${lease.slice(5)}`, [key], {})).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    // A signature made over the lease context does not verify a scope.
    const segment = token.split('.')[1] ?? '';
    const wrong = sign(null, Buffer.from(`${LEASE_SIGNATURE_CONTEXT}${segment}`), privateKey).toString(
      'base64url',
    );
    expect(verifyVaultScope(`rvs1.${segment}.${wrong}`, [key], {})).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses invalid ids and oversized scopes when signing', () => {
    const { privateKey, key } = keyPair();
    expect(() => signVaultScope(scope(key.kid, ['Upper']), privateKey)).toThrow();
    const many = Array.from({ length: MAX_VAULT_SCOPE_IDS + 1 }, (_, i) => `c${String(i)}`);
    expect(() => signVaultScope(scope(key.kid, many), privateKey)).toThrow();
  });

  it('vaultIdOfSecretRef: vault references in any case and form, nothing else', () => {
    expect(vaultIdOfSecretRef('secret:vault-a-db')).toBe('a-db');
    expect(vaultIdOfSecretRef('worker:w1/secret:vault-a-db')).toBe('a-db');
    expect(vaultIdOfSecretRef('secret:VAULT-a-db')).toBe('a-db');
    expect(vaultIdOfSecretRef('secret:my-vault-a')).toBeNull();
    expect(vaultIdOfSecretRef('secret:mine')).toBeNull();
  });
});
