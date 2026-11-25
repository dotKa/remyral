import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Sealed request state for the SSO redirects (docs/design/p5-coolify-sso.md §4): an AES-256-GCM box around
 * a small JSON object, bound to a purpose (AAD) and an expiry. Used for the `r` parameter that travels
 * through the console (`/sso/continue`) and back, so the master never stores anything for anonymous
 * requests and nobody can forge or read the carried values (e.g. a `next` path with a query string).
 *
 * Format: base64url(version 1 | iv 12 | tag 16 | ciphertext).
 */
export type SealPurpose = 'oidc' | 'gate';

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
/** Upper bound of an encoded box accepted from a request. */
export const MAX_SEALED_LENGTH = 4096;
export const SEALED_PATTERN = /^[A-Za-z0-9_-]{16,4096}$/;

interface Envelope {
  readonly p: SealPurpose;
  /** Expiry, epoch milliseconds. */
  readonly e: number;
  readonly d: unknown;
}

export class Sealer {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('sealing key must be 32 bytes');
    this.#key = Buffer.from(key);
  }

  seal(purpose: SealPurpose, data: unknown, expiresAt: Date): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv, { authTagLength: TAG_LEN });
    cipher.setAAD(Buffer.from(`remyral-sso:${purpose}`, 'utf8'));
    const envelope: Envelope = { p: purpose, e: expiresAt.getTime(), d: data };
    const ct = Buffer.concat([cipher.update(JSON.stringify(envelope), 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]).toString('base64url');
  }

  /** The sealed data, or null when the box is malformed, forged, for another purpose or expired. */
  open(purpose: SealPurpose, sealed: unknown, now: Date): unknown {
    if (typeof sealed !== 'string' || !SEALED_PATTERN.test(sealed)) return null;
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 1 + IV_LEN + TAG_LEN + 1 || raw[0] !== VERSION) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(1, 1 + IV_LEN), {
        authTagLength: TAG_LEN,
      });
      decipher.setAAD(Buffer.from(`remyral-sso:${purpose}`, 'utf8'));
      decipher.setAuthTag(raw.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN));
      const plain = Buffer.concat([decipher.update(raw.subarray(1 + IV_LEN + TAG_LEN)), decipher.final()]);
      const env = JSON.parse(plain.toString('utf8')) as Partial<Envelope>;
      if (env.p !== purpose || typeof env.e !== 'number' || now.getTime() >= env.e) return null;
      return env.d;
    } catch {
      return null;
    }
  }
}

/**
 * An origin-relative path that is safe to append to a fixed origin: starts with one `/`, no `//` or `/\`
 * prefix (protocol-relative URLs), no backslashes or control/space characters, at most 2048 characters.
 */
export function safeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\\\u0000- \u007f]/.test(value)) return null;
  return value;
}
