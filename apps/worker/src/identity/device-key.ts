import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { inspect } from 'node:util';
import { Ed25519PublicKey, Ed25519Signature } from '@remyral/protocol';
import { challengePayload, publicKeyFingerprint } from '@remyral/protocol/auth';

/**
 * The AUTH payload, its verification and the fingerprint live in
 * `@remyral/protocol/auth` so master and worker share one definition; they are
 * re-exported here for existing callers.
 */
export {
  AUTH_CHALLENGE_CONTEXT,
  challengePayload,
  publicKeyFromBase64Url,
  verifyChallenge,
} from '@remyral/protocol/auth';

/** Raw 32-byte Ed25519 public key → 43-char base64url (protocol `Ed25519PublicKey`). */
export function publicKeyToBase64Url(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new TypeError('not an Ed25519 public key');
  }
  return Ed25519PublicKey.parse(jwk.x);
}

/**
 * Human-comparable fingerprint shown on the worker and in the pairing UI
 * (ADR-0005 §3): SHA-256 of the raw public key, upper-case hex in 16 groups of 4.
 */
export function fingerprint(publicKeyB64Url: string): string {
  return publicKeyFingerprint(publicKeyB64Url);
}

/**
 * The worker's device identity. The private key is held as a non-extractable-by-
 * accident `KeyObject` in a private field: it is not an own enumerable property,
 * and JSON / inspect / String render only the public part.
 */
export class DeviceKey {
  readonly #privateKey: KeyObject;
  readonly publicKey: string;
  readonly fingerprint: string;

  constructor(privateKey: KeyObject) {
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
      throw new TypeError('device key must be an Ed25519 private key');
    }
    this.#privateKey = privateKey;
    this.publicKey = publicKeyToBase64Url(createPublicKey(privateKey));
    this.fingerprint = fingerprint(this.publicKey);
  }

  static generate(): DeviceKey {
    return new DeviceKey(generateKeyPairSync('ed25519').privateKey);
  }

  /** Restore from PKCS#8 DER (keystore format). */
  static fromPkcs8(der: Buffer): DeviceKey {
    return new DeviceKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
  }

  /** PKCS#8 DER of the private key. Only keystore implementations may call this. */
  exportPkcs8ForKeystore(): Buffer {
    return this.#privateKey.export({ format: 'der', type: 'pkcs8' });
  }

  /** Sign arbitrary bytes; 64-byte signature as 86-char base64url (protocol `Ed25519Signature`). */
  sign(data: Uint8Array): string {
    return Ed25519Signature.parse(sign(null, data, this.#privateKey).toString('base64url'));
  }

  /** Signature for an AUTH challenge nonce (ADR-0005 §4). */
  signChallenge(nonce: string): string {
    return this.sign(challengePayload(nonce));
  }

  toJSON(): { publicKey: string; fingerprint: string } {
    return { publicKey: this.publicKey, fingerprint: this.fingerprint };
  }

  toString(): string {
    return `DeviceKey(${this.fingerprint})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}
