import { createHmac } from 'node:crypto';

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s) with node:crypto, independent of the master's implementation, so
 * the e2e test acts like a real authenticator app.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

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

export function hotp(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 1_000_000).toString().padStart(6, '0');
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / STEP_MS);
}

/**
 * Hands out codes for one secret the way a careful user would: never a step that was already accepted
 * (the master rejects replays). Uses the next step (the master accepts ±1) and waits only when even that
 * one is used up.
 */
export class Authenticator {
  private lastStep = -1;

  constructor(readonly secretBase32: string) {}

  async nextCode(): Promise<string> {
    let step = Math.max(currentStep(), this.lastStep + 1);
    while (step > currentStep() + 1) {
      await new Promise((r) => setTimeout(r, 1_000));
      step = Math.max(currentStep(), this.lastStep + 1);
    }
    this.lastStep = step;
    return hotp(base32Decode(this.secretBase32), step);
  }

  /** A syntactically valid code that is certainly wrong for the current window. */
  wrongCode(): string {
    const key = base32Decode(this.secretBase32);
    const now = currentStep();
    const valid = new Set([now - 1, now, now + 1, now + 2].map((s) => hotp(key, s)));
    for (let i = 0; ; i++) {
      const c = String(i).padStart(6, '0');
      if (!valid.has(c)) return c;
    }
  }
}
