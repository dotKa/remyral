import { createHash, randomBytes } from 'node:crypto';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `wrk_` + 26 lower-case base32 characters (128 random bits). */
export function newWorkerId(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(16);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return `wrk_${out}`;
}

export const WORKER_ID_PATTERN = /^wrk_[a-z2-7]{26}$/;

/** Pairing codes are compared case- and whitespace-insensitively: `abcd efgh` = `ABCD-EFGH`. */
export function normalizePairingCode(code: string): string | null {
  const raw = code.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z2-9]{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** SHA-256 of the normalised code (stored; the code itself never is). */
export function pairingCodeHash(normalized: string): Buffer {
  return createHash('sha256').update(`remyral-pairing-code/v1\n${normalized}`).digest();
}
