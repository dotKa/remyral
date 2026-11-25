import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  sign,
} from 'node:crypto';

/**
 * Web Push message encryption and VAPID (docs/design/p8-pwa.md §4) on node:crypto only — no dependency
 * (docs/security/dependency-policy.md §2: built-ins preferred).
 *
 * - RFC 8291 (Message Encryption for Web Push) with the `aes128gcm` content coding of RFC 8188: ECDH P-256
 *   between an ephemeral sender key and the subscription's `p256dh` key, HKDF-SHA-256 with the
 *   subscription's 16-byte `auth` secret, AES-128-GCM, one record. Verified against the RFC 8291 Appendix A
 *   test vector (test/unit/webpush.test.ts).
 * - RFC 8292 (VAPID): an ES256 JWT `{aud: <push service origin>, exp, sub}` in
 *   `Authorization: vapid t=<jwt>, k=<public key>`.
 */

/** Record size written into the RFC 8188 header (one record; the plaintext must fit in it). */
export const RECORD_SIZE = 4096;
/** Plaintext bytes that fit in one record: rs − 16 (tag) − 1 (delimiter). Push services accept ≥ 4096 bodies. */
export const MAX_PLAINTEXT = RECORD_SIZE - 17;

const P256_PUBLIC_LENGTH = 65;

export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

/** Strict base64url (no padding, no other characters) → bytes, or null. */
export function fromB64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  return Buffer.from(value, 'base64url');
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** HKDF-SHA-256 with a single output block (≤ 32 bytes), as RFC 8291 §3.3/§3.4 use it. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

/** A valid uncompressed P-256 point (0x04 || X || Y on the curve). */
export function isP256PublicKey(raw: Buffer): boolean {
  if (raw.length !== P256_PUBLIC_LENGTH || raw[0] !== 0x04) return false;
  try {
    createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: b64url(raw.subarray(1, 33)),
        y: b64url(raw.subarray(33, 65)),
      },
      format: 'jwk',
    });
    return true;
  } catch {
    return false;
  }
}

export interface EncryptInput {
  /** Subscription `keys.p256dh`: the user agent's uncompressed P-256 public key (65 bytes). */
  readonly uaPublic: Buffer;
  /** Subscription `keys.auth`: 16 random bytes. */
  readonly authSecret: Buffer;
  readonly plaintext: Buffer;
  /** Test seams (RFC test vector): the sender's ephemeral private key (32 bytes) and the 16-byte salt. */
  readonly senderPrivate?: Buffer;
  readonly salt?: Buffer;
}

/** RFC 8291 §4: the complete `aes128gcm` body (header + one encrypted record). */
export function encryptPayload(input: EncryptInput): Buffer {
  if (!isP256PublicKey(input.uaPublic)) throw new Error('invalid p256dh key');
  if (input.authSecret.length !== 16) throw new Error('invalid auth secret');
  if (input.plaintext.length > MAX_PLAINTEXT) throw new Error('push payload too large');
  const ecdh = createECDH('prime256v1');
  if (input.senderPrivate) ecdh.setPrivateKey(input.senderPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(input.uaPublic);
  const salt = input.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new Error('salt must be 16 bytes');

  // §3.3: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), input.uaPublic, asPublic]);
  const ikm = hkdf(input.authSecret, ecdhSecret, keyInfo, 32);
  // RFC 8188 §2.2/§2.3 with the salt from the header.
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);

  // One record, last-record delimiter 0x02, no further padding.
  const padded = Buffer.concat([input.plaintext, Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

// ---------------------------------------------------------------------------------------------- VAPID

export interface VapidKeys {
  readonly privateKey: KeyObject;
  /** Uncompressed P-256 public key, base64url — the browser's `applicationServerKey`. */
  readonly publicKey: string;
}

/**
 * Loads the VAPID key pair from a PEM private key (PKCS#8 or SEC1 "EC PRIVATE KEY", curve P-256), as written
 * by `pnpm --filter @remyral/master vapid:keygen` or `openssl ecparam -name prime256v1 -genkey`.
 */
export function vapidKeysFromPem(pem: string): VapidKeys {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new Error('VAPID key file is not a PEM private key');
  }
  const jwk = privateKey.export({ format: 'jwk' });
  if (privateKey.asymmetricKeyType !== 'ec' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new Error('VAPID key must be an EC P-256 (prime256v1) private key');
  }
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return { privateKey, publicKey: b64url(raw) };
}

/** RFC 8292 §2: `vapid t=<ES256 JWT>, k=<public key>` for the push service origin `audience`. */
export function vapidAuthorization(
  keys: VapidKeys,
  audience: string,
  subject: string,
  now: Date,
  ttlSeconds = 12 * 3600,
): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({ aud: audience, exp: Math.floor(now.getTime() / 1000) + ttlSeconds, sub: subject }),
    ),
  );
  const input = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(input), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64url(signature)}, k=${keys.publicKey}`;
}
