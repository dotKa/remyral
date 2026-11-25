import { createHmac, randomInt } from 'node:crypto';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md §2, ADR-0058): the token format. Pure, DB-free.
 *
 * `ryl_pat_<40 base62 random><6 base62 CRC-32 of the random part>` for personal tokens, `ryl_sa_…` for service
 * accounts. The prefix and the checksum let secret scanners recognise a token and check it offline; the master refuses
 * a token with a bad checksum before any database work. 40 base62 characters carry ~238 bits of entropy.
 */
export const TOKEN_KINDS = ['personal', 'service'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export const TOKEN_PREFIX: Readonly<Record<TokenKind, string>> = { personal: 'ryl_pat_', service: 'ryl_sa_' };

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RANDOM_LEN = 40;
const CHECK_LEN = 6;
/** A token as it appears in a header or a secret scanner's rule. */
export const TOKEN_PATTERN = /^ryl_(pat|sa)_([0-9A-Za-z]{46})$/;

/** CRC-32 (IEEE 802.3, the zlib polynomial) of an ASCII string. */
export function crc32(s: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) & 0xff;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Fixed-width base62 (left-padded with `0`). */
function base62(n: number, width: number): string {
  let out = '';
  let v = n;
  while (v > 0) {
    out = ALPHABET.charAt(v % 62) + out;
    v = Math.floor(v / 62);
  }
  return out.padStart(width, '0');
}

function checksum(random: string): string {
  return base62(crc32(random), CHECK_LEN);
}

/** A new token of `kind` (the secret: shown once, never stored). */
export function generateToken(kind: TokenKind): string {
  let random = '';
  // randomInt draws uniformly (rejection sampling): no modulo bias.
  for (let i = 0; i < RANDOM_LEN; i++) random += ALPHABET.charAt(randomInt(62));
  return `${TOKEN_PREFIX[kind]}${random}${checksum(random)}`;
}

/** The kind of a well-formed token with a valid checksum, or null (malformed / not ours / typo). */
export function parseToken(token: string): TokenKind | null {
  const m = TOKEN_PATTERN.exec(token);
  if (m === null) return null;
  const body = m[2] ?? '';
  const random = body.slice(0, RANDOM_LEN);
  if (body.slice(RANDOM_LEN) !== checksum(random)) return null;
  return m[1] === 'pat' ? 'personal' : 'service';
}

/** The display hint of a token: prefix, first 4 and last 4 characters of its body. */
export function tokenHint(token: string): string {
  const m = TOKEN_PATTERN.exec(token);
  const prefix = m?.[1] === 'sa' ? TOKEN_PREFIX.service : TOKEN_PREFIX.personal;
  const body = m?.[2] ?? '';
  return `${prefix}${body.slice(0, 4)}…${body.slice(-4)}`;
}

/**
 * The stored form: HMAC-SHA256 with the token sub-key (`SecretBox.deriveKey('api-token')`). A keyed hash, not a
 * password hash: the secret is random (no dictionary to slow down), and every API request verifies one.
 */
export function hashToken(key: Buffer, token: string): Buffer {
  return createHmac('sha256', key).update(token, 'utf8').digest();
}

/** The `Authorization: Bearer <token>` value of a request, or undefined (no or another scheme). */
export function bearerOf(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  return m?.[1];
}
