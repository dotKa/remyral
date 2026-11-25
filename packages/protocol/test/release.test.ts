import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compareReleaseVersions,
  MasterToWorker,
  MAX_RELEASE_MANIFEST_BYTES,
  nodeVersionAtLeast,
  releaseKeyId,
  releaseSigningPayload,
  ReleaseVersion,
  sha256Hex,
  TrustedReleaseKeys,
  verifyReleaseArtifact,
  verifyReleaseManifest,
} from '../src/index.js';
import { masterMessages } from './fixtures.js';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { publicKey: jwk.x ?? '', privateKey };
}

const artifact = Buffer.from('#!/usr/bin/env node\nconsole.log("worker 1.2.0")\n');
const manifestFor = (over: Record<string, unknown> = {}) =>
  Buffer.from(
    `${JSON.stringify(
      {
        schema: 1,
        name: 'remyral-worker',
        version: '1.2.0',
        channel: 'stable',
        protocolVersions: ['1.0'],
        minNode: '24.0.0',
        sha256: sha256Hex(artifact),
        size: artifact.byteLength,
        createdAt: '2026-10-13T10:00:00.000Z',
        ...over,
      },
      null,
      2,
    )}\n`,
  );

function signDoc(manifest: Buffer, k: ReturnType<typeof keyPair>) {
  return {
    keyId: releaseKeyId(k.publicKey),
    signature: sign(null, releaseSigningPayload(manifest), k.privateKey).toString('base64url'),
  };
}

describe('release signatures (T-SUP-2)', () => {
  const release = keyPair();
  const other = keyPair();

  it('accepts a manifest signed by a trusted key and returns the parsed manifest', () => {
    const m = manifestFor();
    const r = verifyReleaseManifest(m, signDoc(m, release), [release.publicKey]);
    expect(r).toMatchObject({ ok: true, keyId: releaseKeyId(release.publicKey) });
    if (r.ok) expect(verifyReleaseArtifact(r.manifest, artifact)).toEqual({ ok: true });
  });

  it('accepts either key during a rotation overlap', () => {
    const m = manifestFor();
    expect(verifyReleaseManifest(m, signDoc(m, other), [release.publicKey, other.publicKey]).ok).toBe(true);
  });

  it('refuses a tampered manifest (one byte changed after signing)', () => {
    const m = manifestFor();
    const sig = signDoc(m, release);
    const tampered = Buffer.from(m.toString('utf8').replace('"1.2.0"', '"9.2.0"'));
    expect(verifyReleaseManifest(tampered, sig, [release.publicKey])).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
    // Whitespace is signed too: no canonicalisation games.
    expect(
      verifyReleaseManifest(Buffer.concat([m, Buffer.from(' ')]), sig, [release.publicKey]),
    ).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a signature by an untrusted key, also when it claims a trusted key id', () => {
    const m = manifestFor();
    expect(verifyReleaseManifest(m, signDoc(m, other), [release.publicKey])).toMatchObject({
      ok: false,
      reason: 'unknown_key',
    });
    const forged = { ...signDoc(m, other), keyId: releaseKeyId(release.publicKey) };
    expect(verifyReleaseManifest(m, forged, [release.publicKey])).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a signature made for another purpose (no domain separation bypass)', () => {
    const m = manifestFor();
    const raw = {
      keyId: releaseKeyId(release.publicKey),
      signature: sign(null, m, release.privateKey).toString('base64url'),
    };
    expect(verifyReleaseManifest(m, raw, [release.publicKey])).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses without trusted keys, with a malformed signature document or an oversized manifest', () => {
    const m = manifestFor();
    expect(verifyReleaseManifest(m, signDoc(m, release), [])).toMatchObject({ reason: 'no_trusted_keys' });
    expect(verifyReleaseManifest(m, { keyId: 'x', signature: 'y' }, [release.publicKey])).toMatchObject({
      reason: 'invalid_signature_document',
    });
    const big = Buffer.alloc(MAX_RELEASE_MANIFEST_BYTES + 1, 0x20);
    expect(verifyReleaseManifest(big, signDoc(big, release), [release.publicKey])).toMatchObject({
      reason: 'manifest_too_large',
    });
  });

  it('refuses a correctly signed manifest that is not a valid manifest (unknown fields, wrong name)', () => {
    for (const bad of [
      manifestFor({ extra: true }),
      manifestFor({ name: 'other' }),
      manifestFor({ version: '1.2' }),
    ]) {
      expect(verifyReleaseManifest(bad, signDoc(bad, release), [release.publicKey])).toMatchObject({
        ok: false,
        reason: 'invalid_manifest',
      });
    }
  });

  it('detects a swapped or truncated artifact', () => {
    const m = manifestFor();
    const r = verifyReleaseManifest(m, signDoc(m, release), [release.publicKey]);
    if (!r.ok) throw new Error('expected ok');
    const evil = Buffer.from(artifact);
    evil[evil.length - 2] = 0x41;
    expect(verifyReleaseArtifact(r.manifest, evil)).toEqual({ ok: false, reason: 'sha256_mismatch' });
    expect(verifyReleaseArtifact(r.manifest, artifact.subarray(1))).toEqual({
      ok: false,
      reason: 'size_mismatch',
    });
  });

  it('trusted key lists hold at most two distinct keys', () => {
    expect(TrustedReleaseKeys.safeParse([release.publicKey, other.publicKey]).success).toBe(true);
    expect(TrustedReleaseKeys.safeParse([release.publicKey, release.publicKey]).success).toBe(false);
    expect(
      TrustedReleaseKeys.safeParse([release.publicKey, other.publicKey, keyPair().publicKey]).success,
    ).toBe(false);
  });
});

describe('versions', () => {
  it('orders semantic versions by precedence', () => {
    const sorted = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.2.0',
      '1.10.0',
      '2.0.0',
    ];
    for (let i = 1; i < sorted.length; i++) {
      expect(compareReleaseVersions(sorted[i - 1] ?? '', sorted[i] ?? '')).toBe(-1);
      expect(compareReleaseVersions(sorted[i] ?? '', sorted[i - 1] ?? '')).toBe(1);
    }
    expect(compareReleaseVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('validates the version grammar', () => {
    for (const v of ['0.1.0', '1.2.3-rc.1', '10.20.30'])
      expect(ReleaseVersion.safeParse(v).success).toBe(true);
    for (const v of ['1.2', '01.2.3', '1.2.3+build', 'v1.2.3', '../1.2.3']) {
      expect(ReleaseVersion.safeParse(v).success).toBe(false);
    }
  });

  it('compares Node versions', () => {
    expect(nodeVersionAtLeast('24.11.0', '24.0.0')).toBe(true);
    expect(nodeVersionAtLeast('v24.11.0', '24.11.0')).toBe(true);
    expect(nodeVersionAtLeast('24.10.9', '24.11.0')).toBe(false);
    expect(nodeVersionAtLeast('garbage', '24.0.0')).toBe(false);
  });
});

describe('UPDATE_AVAILABLE', () => {
  it('only carries download paths on the master origin', () => {
    const base = masterMessages.UPDATE_AVAILABLE;
    expect(MasterToWorker.safeParse(base).success).toBe(true);
    for (const url of [
      'https://evil.example/v1/worker/releases/1.2.0/artifact',
      '//evil.example/x',
      '/v1/worker/releases/../../x/artifact',
      '/v1/worker/releases/../artifact',
    ]) {
      const msg = { ...base, payload: { ...base.payload, artifactUrl: url } };
      expect(MasterToWorker.safeParse(msg).success, url).toBe(false);
    }
  });
});
