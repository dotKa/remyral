import { randomInt } from 'node:crypto';

/**
 * Recovery codes (ADR-0009 §5): 10 single-use codes shown once at enrollment, stored as keyed hashes.
 * Format `xxxx-xxxx-xxxx` over Crockford base32 (no i/l/o/u): 12 symbols × 5 bits = 60 bits each.
 */
export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const GROUPS = 3;
const GROUP_LEN = 4;

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const groups: string[] = [];
    for (let g = 0; g < GROUPS; g++) {
      let s = '';
      for (let i = 0; i < GROUP_LEN; i++) s += ALPHABET.charAt(randomInt(ALPHABET.length));
      groups.push(s);
    }
    codes.add(groups.join('-'));
  }
  return [...codes];
}

/**
 * Canonical form used for hashing: lower-case, separators/whitespace removed, Crockford substitutions
 * (i/l → 1, o → 0). Returns null if the input cannot be a recovery code.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toLowerCase().replace(/[\s-]/g, '').replace(/[il]/g, '1').replace(/o/g, '0');
  if (s.length !== GROUPS * GROUP_LEN) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}
