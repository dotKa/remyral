import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  installerKitFileName,
  installerSigningPayload,
  MAX_INSTALLER_INDEX_BYTES,
  releaseKeyId,
  releaseSigningPayload,
  sha256Hex,
  verifyInstallerIndex,
  verifyInstallerKit,
  verifyReleaseManifest,
} from '../src/index.js';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ format: 'jwk' }).x ?? '', privateKey };
}

const kit = Buffer.from('fake kit bytes');
const indexFor = (over: Record<string, unknown> = {}) =>
  Buffer.from(
    `${JSON.stringify(
      {
        schema: 1,
        name: 'remyral-worker-installers',
        version: '1.2.0',
        releaseManifestSha256: 'a'.repeat(64),
        node: { version: '24.21.0' },
        kits: [
          {
            os: 'linux',
            file: 'remyral-worker-1.2.0-linux.tar.gz',
            sha256: sha256Hex(kit),
            size: kit.length,
          },
        ],
        createdAt: '2026-10-14T10:00:00.000Z',
        ...over,
      },
      null,
      2,
    )}\n`,
  );
const signWith = (bytes: Buffer, k: ReturnType<typeof keyPair>, payload = installerSigningPayload) => ({
  keyId: releaseKeyId(k.publicKey),
  signature: sign(null, payload(bytes), k.privateKey).toString('base64url'),
});

describe('installer index (p5-worker-onboarding)', () => {
  const k = keyPair();

  it('verifies a signed index and the kit bytes', () => {
    const bytes = indexFor();
    const v = verifyInstallerIndex(bytes, signWith(bytes, k), [k.publicKey]);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const first = v.index.kits[0];
    if (first === undefined) throw new Error('no kit');
    expect(first.os).toBe('linux');
    expect(verifyInstallerKit(first, kit)).toEqual({ ok: true });
    expect(verifyInstallerKit(first, Buffer.from('fake kit byteS'))).toEqual({
      ok: false,
      reason: 'sha256_mismatch',
    });
    expect(verifyInstallerKit(first, Buffer.from('x'))).toEqual({
      ok: false,
      reason: 'size_mismatch',
    });
  });

  it('domain separation: a release-manifest signature is not an index signature and vice versa', () => {
    const bytes = indexFor();
    expect(
      verifyInstallerIndex(bytes, signWith(bytes, k, releaseSigningPayload), [k.publicKey]),
    ).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyReleaseManifest(bytes, signWith(bytes, k), [k.publicKey])).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses tampering, unknown keys, malformed documents and oversized indexes', () => {
    const bytes = indexFor();
    const sig = signWith(bytes, k);
    const tampered = Buffer.from(bytes.toString().replace('24.21.0', '24.21.1'));
    expect(verifyInstallerIndex(tampered, sig, [k.publicKey])).toMatchObject({ reason: 'bad_signature' });
    expect(verifyInstallerIndex(bytes, sig, [keyPair().publicKey])).toMatchObject({ reason: 'unknown_key' });
    expect(verifyInstallerIndex(bytes, sig, [])).toMatchObject({ reason: 'no_trusted_keys' });
    expect(verifyInstallerIndex(bytes, { keyId: 'x' }, [k.publicKey])).toMatchObject({
      reason: 'invalid_signature_document',
    });
    const big = Buffer.alloc(MAX_INSTALLER_INDEX_BYTES + 1, 32);
    expect(verifyInstallerIndex(big, signWith(big, k), [k.publicKey])).toMatchObject({
      reason: 'index_too_large',
    });
  });

  it('refuses signed but invalid indexes (file names, duplicates, Node major, unknown fields)', () => {
    const cases: Record<string, unknown>[] = [
      { kits: [{ os: 'linux', file: 'remyral-worker-1.2.1-linux.tar.gz', sha256: sha256Hex(kit), size: 1 }] },
      { kits: [{ os: 'linux', file: '../evil.tar.gz', sha256: sha256Hex(kit), size: 1 }] },
      {
        kits: [
          { os: 'linux', file: 'remyral-worker-1.2.0-linux.tar.gz', sha256: sha256Hex(kit), size: 1 },
          { os: 'linux', file: 'remyral-worker-1.2.0-linux.tar.gz', sha256: sha256Hex(kit), size: 1 },
        ],
      },
      { node: { version: '22.1.0' } },
      { extra: true },
      { kits: [] },
    ];
    for (const over of cases) {
      const bytes = indexFor(over);
      expect(
        verifyInstallerIndex(bytes, signWith(bytes, k), [k.publicKey]),
        JSON.stringify(over),
      ).toMatchObject({
        ok: false,
        reason: 'invalid_index',
      });
    }
  });

  it('kit file names', () => {
    expect(installerKitFileName('1.2.0', 'linux')).toBe('remyral-worker-1.2.0-linux.tar.gz');
    expect(installerKitFileName('1.2.0-rc.1', 'macos')).toBe('remyral-worker-1.2.0-rc.1-macos.tar.gz');
    expect(installerKitFileName('1.2.0', 'windows')).toBe('remyral-worker-1.2.0-windows.zip');
  });
});
