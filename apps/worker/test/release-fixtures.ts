import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { releaseKeyId, releaseSigningPayload, sha256Hex } from '@remyral/protocol';

export interface ReleaseKey {
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

export function releaseKey(): ReleaseKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: String(publicKey.export({ format: 'jwk' }).x), privateKey };
}

export interface SignedRelease {
  readonly version: string;
  readonly artifact: Buffer;
  readonly manifest: Buffer;
  readonly signature: { keyId: string; signature: string };
}

export function signedRelease(
  key: ReleaseKey,
  version: string,
  over: Record<string, unknown> = {},
  artifact: Buffer = Buffer.from(`#!/usr/bin/env node\n// remyral-worker ${version}\n`),
): SignedRelease {
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        schema: 1,
        name: 'remyral-worker',
        version,
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
  return {
    version,
    artifact,
    manifest,
    signature: {
      keyId: releaseKeyId(key.publicKey),
      signature: sign(null, releaseSigningPayload(manifest), key.privateKey).toString('base64url'),
    },
  };
}
