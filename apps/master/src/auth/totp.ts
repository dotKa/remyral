import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP per RFC 6238 (on HOTP, RFC 4226), implemented with node:crypto. Production parameters fixed by
 * ADR-0009 §4: SHA-1, 6 digits, 30-second step, ±1 step tolerance, replay of a used step rejected.
 */
export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20; // 160 bits, RFC 4226 §4 recommendation

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP with dynamic truncation. */
export function hotp(
  key: Buffer,
  counter: bigint,
  digits = TOTP_DIGITS,
  algorithm: TotpAlgorithm = 'sha1',
): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function totpStep(unixMs: number, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(unixMs / 1000 / stepSeconds);
}

export function totpAt(
  key: Buffer,
  unixMs: number,
  opts: { digits?: number; algorithm?: TotpAlgorithm; stepSeconds?: number } = {},
): string {
  return hotp(key, BigInt(totpStep(unixMs, opts.stepSeconds)), opts.digits, opts.algorithm);
}

/**
 * Verifies a 6-digit code against steps `now-window … now+window`. Steps at or below `lastUsedStep` are
 * never accepted (replay protection, ADR-0009 §4). Returns the matched step, or null.
 * All candidate steps are always computed and compared in constant time.
 */
export function verifyTotp(
  key: Buffer,
  code: string,
  unixMs: number,
  lastUsedStep: number | null,
  window = TOTP_WINDOW,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(unixMs);
  const given = Buffer.from(code, 'utf8');
  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step++) {
    const expected = Buffer.from(hotp(key, BigInt(step)), 'utf8');
    const equal = timingSafeEqual(expected, given);
    if (equal && matched === null && (lastUsedStep === null || step > lastUsedStep)) matched = step;
  }
  return matched;
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

export const TOTP_ISSUER = 'Remyral';

/** Key URI format understood by authenticator apps (Google Authenticator key-uri format). */
export function otpauthUri(secret: Buffer, account: string, issuer = TOTP_ISSUER): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}`;
}
