import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { isCommonPassword } from './common-passwords.js';

/**
 * Password hashing per ADR-0009 §3: scrypt (node:crypto), N=2^17, r=8, p=1, 16-byte salt, 32-byte key.
 * Encoded as `$scrypt$ln=17,r=8,p=1$<salt b64>$<key b64>` so parameters can be raised later
 * (`needsRehash`) without invalidating existing hashes.
 */
export interface ScryptParams {
  readonly log2N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLen: number;
  readonly saltLen: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { log2N: 17, r: 8, p: 1, keyLen: 32, saltLen: 16 };

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLen, opts, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function scryptOptions(log2N: number, r: number, p: number): ScryptOptions {
  const N = 2 ** log2N;
  // Memory needed is ~128 * N * r bytes; node's default maxmem (32 MiB) is too small for N=2^17.
  return { N, r, p, maxmem: 128 * N * r * 2 };
}

/** NFC-normalise so the same password typed on different platforms hashes identically. */
function normalize(password: string): string {
  return password.normalize('NFC');
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(params.saltLen);
  const key = await scrypt(
    normalize(password),
    salt,
    params.keyLen,
    scryptOptions(params.log2N, params.r, params.p),
  );
  return `$scrypt$ln=${String(params.log2N)},r=${String(params.r)},p=${String(params.p)}$${salt.toString('base64')}$${key.toString('base64')}`;
}

interface Decoded {
  log2N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

const ENCODED = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

function decode(encoded: string): Decoded | null {
  const m = ENCODED.exec(encoded);
  if (!m) return null;
  const [, ln, r, p, salt, key] = m;
  if (!ln || !r || !p || !salt || !key) return null;
  const decoded = {
    log2N: Number(ln),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, 'base64'),
    key: Buffer.from(key, 'base64'),
  };
  if (decoded.log2N < 10 || decoded.log2N > 22 || decoded.key.length < 16) return null;
  return decoded;
}

/** Constant-time verification. Returns false (never throws) for malformed hashes. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const d = decode(encoded);
  if (!d) return false;
  const candidate = await scrypt(normalize(password), d.salt, d.key.length, scryptOptions(d.log2N, d.r, d.p));
  return timingSafeEqual(candidate, d.key);
}

export function needsRehash(encoded: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): boolean {
  const d = decode(encoded);
  if (!d) return true;
  return d.log2N < params.log2N || d.r !== params.r || d.p !== params.p || d.key.length < params.keyLen;
}

/**
 * A valid hash of a random password, verified against when the username does not exist so that unknown
 * and known usernames take the same time (no user enumeration by timing).
 */
const dummyHashes = new Map<string, Promise<string>>();
export function dummyHash(params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  const k = `${String(params.log2N)}/${String(params.r)}/${String(params.p)}`;
  let h = dummyHashes.get(k);
  if (!h) {
    h = hashPassword(randomBytes(24).toString('base64'), params);
    dummyHashes.set(k, h);
  }
  return h;
}

export type PasswordPolicyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'too_short' | 'too_long' | 'common' | 'contains_username' };

/** ADR-0009 §3: minimum 12 characters, not on the common-password list. */
export function checkPasswordPolicy(password: string, username: string): PasswordPolicyResult {
  const length = Array.from(normalize(password)).length; // code points
  if (length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'too_short' };
  if (length > MAX_PASSWORD_LENGTH) return { ok: false, reason: 'too_long' };
  if (isCommonPassword(password)) return { ok: false, reason: 'common' };
  if (username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) {
    return { ok: false, reason: 'contains_username' };
  }
  return { ok: true };
}

/** p14-i18n-errors: the `weak_password` error params — the policy reason and the limit its sentence names. */
export function policyFailureParams(
  reason: Exclude<PasswordPolicyResult, { ok: true }>['reason'],
): Record<string, string | number> {
  if (reason === 'too_short') return { reason, min: MIN_PASSWORD_LENGTH };
  if (reason === 'too_long') return { reason, max: MAX_PASSWORD_LENGTH };
  return { reason };
}

export function describePolicyFailure(reason: Exclude<PasswordPolicyResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'too_short':
      return `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`;
    case 'too_long':
      return `Password must be at most ${String(MAX_PASSWORD_LENGTH)} characters.`;
    case 'common':
      return 'Password is too common. Choose a less predictable passphrase.';
    case 'contains_username':
      return 'Password must not contain the username.';
  }
}
