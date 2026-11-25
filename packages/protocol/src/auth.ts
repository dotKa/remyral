import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { Ed25519PublicKey, Ed25519Signature } from './common.js';

/**
 * Domain-separation prefix for the session challenge (ADR-0005 §4). The worker
 * never signs a bare server-chosen nonce, so an AUTH signature cannot be
 * repurposed as a signature over anything else (e.g. a key-rotation statement).
 * Shared by master and worker so the two can never diverge.
 */
export const AUTH_CHALLENGE_CONTEXT = 'remana-worker-auth/v1\n';

/** Bytes signed for an AUTH challenge: `remana-worker-auth/v1\n<nonce>` (UTF-8). */
export function challengePayload(nonce: string): Buffer {
  return Buffer.from(`${AUTH_CHALLENGE_CONTEXT}${nonce}`, 'utf8');
}

/** Raw 32-byte Ed25519 public key (43-char base64url) → `KeyObject`. Throws on malformed input. */
export function publicKeyFromBase64Url(value: string): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Ed25519PublicKey.parse(value) },
    format: 'jwk',
  });
}

/** Verify an Ed25519 signature (86-char base64url) over `data`. Never throws. */
export function verifyEd25519(publicKeyB64Url: string, data: Uint8Array, signature: string): boolean {
  if (!Ed25519Signature.safeParse(signature).success) return false;
  let key: KeyObject;
  try {
    key = publicKeyFromBase64Url(publicKeyB64Url);
  } catch {
    return false;
  }
  try {
    return verify(null, data, key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** Verify an AUTH signature over {@link challengePayload}. Never throws. */
export function verifyChallenge(publicKeyB64Url: string, nonce: string, signature: string): boolean {
  return verifyEd25519(publicKeyB64Url, challengePayload(nonce), signature);
}

/**
 * Human-comparable fingerprint shown on the worker and in the pairing UI
 * (ADR-0005 §3): `SHA256:` + SHA-256 of the raw public key, upper-case hex in
 * 16 groups of 4.
 */
/** Domain-separation prefix for key-rotation statements (ADR-0005 §5, p2-identity-rotation). */
export const ROTATION_CONTEXT = 'remana-worker-rotate/v1\n';

export interface RotationStatement {
  readonly workerId: string;
  readonly oldPublicKey: string;
  readonly newPublicKey: string;
  /** Single-use nonce from ROTATE_CREDENTIAL. */
  readonly nonce: string;
}

/**
 * Bytes both keys sign for a rotation: the old key vouches for the new one
 * (continuity), the new key proves possession. Bound to the worker, both keys
 * and the master's nonce, so a statement cannot be replayed or re-targeted.
 */
export function rotationPayload(s: RotationStatement): Buffer {
  return Buffer.from(
    `${ROTATION_CONTEXT}${s.workerId}\n${s.oldPublicKey}\n${s.newPublicKey}\n${s.nonce}`,
    'utf8',
  );
}

/** Both signatures over {@link rotationPayload} are valid. Never throws. */
export function verifyRotation(
  s: RotationStatement,
  oldKeySignature: string,
  newKeySignature: string,
): boolean {
  if (s.oldPublicKey === s.newPublicKey) return false;
  const data = rotationPayload(s);
  return (
    verifyEd25519(s.oldPublicKey, data, oldKeySignature) &&
    verifyEd25519(s.newPublicKey, data, newKeySignature)
  );
}

export function publicKeyFingerprint(publicKeyB64Url: string): string {
  const raw = Buffer.from(Ed25519PublicKey.parse(publicKeyB64Url), 'base64url');
  const hex = createHash('sha256').update(raw).digest('hex').toUpperCase();
  return `SHA256:${(hex.match(/.{4}/g) ?? []).join('-')}`;
}
