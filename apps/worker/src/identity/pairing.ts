import { randomInt } from 'node:crypto';
import { PairingCode } from '@remyral/protocol';

/**
 * Alphabet for pairing codes: the protocol allows `[A-Z2-9]`; we additionally
 * avoid I and O (confusable with 1/0 when read aloud or hand-typed).
 * 32 symbols × 8 positions = 40 bits; single-use, 10-minute expiry and rate
 * limiting on the master (ADR-0005 §3) make that ample.
 */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePairingCode(random: (max: number) => number = randomInt): string {
  let raw = '';
  for (let i = 0; i < 8; i++) raw += PAIRING_ALPHABET.charAt(random(PAIRING_ALPHABET.length));
  return PairingCode.parse(`${raw.slice(0, 4)}-${raw.slice(4)}`);
}
