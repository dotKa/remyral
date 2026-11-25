/**
 * End-to-end sealing of a vault credential to one worker (p5-credentials-models, ADR-0016,
 * docs/design/p5-credentials-models.md §2).
 *
 * The **browser** of the administrator seals the value to the worker's X25519 vault public key; the master only
 * stores and relays the ciphertext; the worker opens it with its private key. Scheme (an HPKE-style base-mode
 * construction built only from WebCrypto primitives, so it runs unchanged in browsers and in Node ≥ 24 and
 * needs no dependency):
 *
 *   eph            = fresh X25519 key pair (per seal)
 *   shared         = X25519(eph.private, workerPublic)                         (32 bytes)
 *   key            = HKDF-SHA256(ikm = shared, salt = eph.public ‖ workerPublic,
 *                                info = "remana-credential-seal/v1")          (AES-256-GCM key)
 *   ct             = AES-256-GCM(key, iv = 12 random bytes, aad = sealAad(binding), plaintext = UTF-8 value)
 *
 * The additional data binds the ciphertext to the worker, credential id, version, recipient key id, kind and
 * target environment variable: a relay (or a compromised master) cannot re-target a sealed value to another
 * worker, another credential, an older/newer version or another env var (e.g. `NODE_OPTIONS`) — opening fails.
 *
 * Pure: no Node or zod imports (the web console bundles this file). `subtle` defaults to `globalThis.crypto`.
 */

export const CREDENTIAL_SEAL_ALG = 'x25519-hkdf-sha256-a256gcm' as const;
export const CREDENTIAL_SEAL_INFO = 'remana-credential-seal/v1';

/** What one sealed value is bound to (all of it is in the AEAD additional data). */
export interface SealBinding {
  readonly workerId: string;
  readonly credentialId: string;
  readonly version: number;
  /** {@link vaultKeyId} of the recipient public key. */
  readonly keyId: string;
  readonly kind: string;
  readonly env: string;
}

/** Ciphertext as stored by the master and delivered to the worker (base64url, no padding). */
export interface SealedValue {
  readonly alg: typeof CREDENTIAL_SEAL_ALG;
  readonly keyId: string;
  /** Ephemeral X25519 public key (32 bytes → 43 chars). */
  readonly epk: string;
  /** AES-GCM nonce (12 bytes → 16 chars). */
  readonly iv: string;
  /** AES-GCM ciphertext ‖ tag. */
  readonly ct: string;
}

export class SealError extends Error {
  constructor(
    readonly code: 'x25519_unavailable' | 'bad_key' | 'bad_input' | 'open_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SealError';
  }
}

/** WebCrypto types that resolve both with the DOM lib (browser) and with @types/node (no DOM lib). */
type Subtle = typeof globalThis.crypto.subtle;
type Key = Awaited<ReturnType<Subtle['importKey']>>;
interface KeyPair {
  readonly publicKey: Key;
  readonly privateKey: Key;
}

const encoder = new TextEncoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new SealError('bad_input', 'not base64url');
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** The exact additional-data bytes of a seal (shared by sealer and opener). */
export function sealAad(b: SealBinding): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    `${CREDENTIAL_SEAL_INFO}\n${b.workerId}\n${b.credentialId}\n${String(b.version)}\n${b.keyId}\n${b.kind}\n${b.env}`,
  );
}

function subtleOf(subtle?: Subtle): Subtle {
  const s = subtle ?? (globalThis.crypto as typeof globalThis.crypto | undefined)?.subtle;
  if (s === undefined) throw new SealError('x25519_unavailable', 'WebCrypto is not available');
  return s;
}

/**
 * Key id of a raw X25519 public key: the first 22 base64url characters (132 bits) of its SHA-256. Deterministic,
 * so the master can check that an announced key id belongs to the announced key.
 */
export async function vaultKeyId(publicKey: string, subtle?: Subtle): Promise<string> {
  const raw = base64UrlToBytes(publicKey);
  if (raw.length !== 32) throw new SealError('bad_key', 'an X25519 public key has 32 bytes');
  const digest = new Uint8Array(await subtleOf(subtle).digest('SHA-256', raw));
  return bytesToBase64Url(digest).slice(0, 22);
}

/**
 * Fingerprint shown in the panel and by `remyral-worker vault key` for comparison: `X25519:` + upper-case hex
 * SHA-256 of the raw public key in 16 groups of 4 (same layout as the device-key fingerprint).
 */
export async function vaultKeyFingerprint(publicKey: string, subtle?: Subtle): Promise<string> {
  const raw = base64UrlToBytes(publicKey);
  if (raw.length !== 32) throw new SealError('bad_key', 'an X25519 public key has 32 bytes');
  const digest = new Uint8Array(await subtleOf(subtle).digest('SHA-256', raw));
  const hex = [...digest]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `X25519:${(hex.match(/.{4}/g) ?? []).join('-')}`;
}

/** Whether this environment's WebCrypto implements X25519 (feature detection for the panel). */
export async function x25519Supported(subtle?: Subtle): Promise<boolean> {
  try {
    await subtleOf(subtle).generateKey({ name: 'X25519' }, false, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

async function aesKey(
  s: Subtle,
  shared: ArrayBuffer,
  epk: Uint8Array,
  recipient: Uint8Array,
  usage: 'encrypt' | 'decrypt',
): Promise<Key> {
  const ikm = await s.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return s.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: concat(epk, recipient),
      info: encoder.encode(CREDENTIAL_SEAL_INFO),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/**
 * Seals `value` to the worker public key `recipientPublicKey` (raw X25519, base64url). The binding's `keyId`
 * must be the key id of that public key (checked).
 */
export async function sealCredential(
  value: string,
  recipientPublicKey: string,
  binding: SealBinding,
  subtle?: Subtle,
): Promise<SealedValue> {
  const s = subtleOf(subtle);
  if (value.length === 0) throw new SealError('bad_input', 'empty value');
  const recipient = base64UrlToBytes(recipientPublicKey);
  if (recipient.length !== 32) throw new SealError('bad_key', 'an X25519 public key has 32 bytes');
  if ((await vaultKeyId(recipientPublicKey, s)) !== binding.keyId) {
    throw new SealError('bad_key', 'key id does not belong to the public key');
  }
  let eph: KeyPair;
  let recipientKey: Key;
  try {
    eph = (await s.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as unknown as KeyPair;
    recipientKey = await s.importKey('raw', recipient, { name: 'X25519' }, false, []);
  } catch (err) {
    throw new SealError(
      'x25519_unavailable',
      `this browser does not support X25519 in WebCrypto (${err instanceof Error ? err.name : 'error'})`,
    );
  }
  const epk = new Uint8Array(await s.exportKey('raw', eph.publicKey));
  const shared = await s.deriveBits({ name: 'X25519', public: recipientKey }, eph.privateKey, 256);
  const key = await aesKey(s, shared, epk, recipient, 'encrypt');
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await s.encrypt({ name: 'AES-GCM', iv, additionalData: sealAad(binding) }, key, encoder.encode(value)),
  );
  return {
    alg: CREDENTIAL_SEAL_ALG,
    keyId: binding.keyId,
    epk: bytesToBase64Url(epk),
    iv: bytesToBase64Url(iv),
    ct: bytesToBase64Url(ct),
  };
}

/**
 * Opens a sealed value with the worker's X25519 private key (`deriveBits` usage) and its raw public key.
 * Throws {@link SealError} `open_failed` for any mismatch (wrong key, tampered ciphertext, other binding) —
 * deliberately without saying which.
 */
export async function openCredential(
  sealed: SealedValue,
  privateKey: Key,
  recipientPublicKey: string,
  binding: SealBinding,
  subtle?: Subtle,
): Promise<string> {
  const s = subtleOf(subtle);
  if ((sealed.alg as string) !== CREDENTIAL_SEAL_ALG || sealed.keyId !== binding.keyId) {
    throw new SealError('open_failed', 'sealed value does not match this key');
  }
  try {
    const epk = base64UrlToBytes(sealed.epk);
    const iv = base64UrlToBytes(sealed.iv);
    if (epk.length !== 32 || iv.length !== 12) throw new SealError('bad_input', 'malformed');
    const recipient = base64UrlToBytes(recipientPublicKey);
    const ephKey = await s.importKey('raw', epk, { name: 'X25519' }, false, []);
    const shared = await s.deriveBits({ name: 'X25519', public: ephKey }, privateKey, 256);
    const key = await aesKey(s, shared, epk, recipient, 'decrypt');
    const plain = await s.decrypt(
      { name: 'AES-GCM', iv, additionalData: sealAad(binding) },
      key,
      base64UrlToBytes(sealed.ct),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    throw new SealError('open_failed', 'the sealed value could not be opened with this key and binding');
  }
}
