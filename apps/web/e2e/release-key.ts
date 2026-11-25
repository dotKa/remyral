import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from 'node:crypto';

/**
 * p6-release-upload e2e: a deterministic, test-only Ed25519 release key (derived from a fixed label, so the
 * Playwright config — which passes the public half to the master as RELEASE_PUBLIC_KEYS — and the spec,
 * which signs with it, agree without any key material in the repository or the environment).
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKey(): KeyObject {
  const seed = createHash('sha256').update('remyral-e2e-release-key/v1').digest();
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function e2eReleasePublicKey(): string {
  return String(createPublicKey(privateKey()).export({ format: 'jwk' }).x);
}

export function e2eReleaseSign(payload: Buffer): Buffer {
  return sign(null, payload, privateKey());
}
