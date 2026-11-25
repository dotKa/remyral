import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCKOUT, lockoutDurationMs } from '../../src/auth/lockout.js';
import { MemoryRateLimiter } from '../../src/auth/rate-limit.js';
import {
  generateRecoveryCodes,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from '../../src/auth/recovery-codes.js';
import { SecretBox, SecretBoxError } from '../../src/auth/secret-box.js';

describe('recovery codes (ADR-0009 §5)', () => {
  it('generates 10 distinct xxxx-xxxx-xxxx codes from a 32-symbol alphabet', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes)
      expect(c).toMatch(/^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/);
  });

  it('spreads over the whole alphabet (no obvious bias)', () => {
    const counts = new Map<string, number>();
    for (const c of generateRecoveryCodes(500))
      for (const ch of c.replaceAll('-', '')) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(32);
    for (const n of counts.values()) expect(n).toBeGreaterThan(100); // expected 187.5 each
  });

  it('normalises user input (case, separators, Crockford look-alikes)', () => {
    expect(normalizeRecoveryCode('ABCD-EFGH-JK01')).toBe('abcdefghjk01');
    expect(normalizeRecoveryCode(' abcd efgh jkOI ')).toBe('abcdefghjk01');
    expect(normalizeRecoveryCode('abcd-efgh-jk0')).toBeNull();
    expect(normalizeRecoveryCode('abcd-efgh-jku1')).toBeNull(); // u is not in the alphabet
  });
});

describe('lockout backoff (ADR-0009 §7)', () => {
  it('starts at the threshold and doubles up to the cap', () => {
    expect(DEFAULT_LOCKOUT).toEqual({ threshold: 5, baseMs: 30_000, maxMs: 3_600_000 });
    expect([0, 1, 4].map((n) => lockoutDurationMs(n))).toEqual([0, 0, 0]);
    expect([5, 6, 7, 8, 9].map((n) => lockoutDurationMs(n))).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000,
    ]);
    expect(lockoutDurationMs(12)).toBe(3_600_000);
    expect(lockoutDurationMs(1_000_000)).toBe(3_600_000);
  });
});

describe('MemoryRateLimiter', () => {
  it('allows `limit` hits per window then reports retry-after', async () => {
    let t = 0;
    const rl = new MemoryRateLimiter(() => t);
    for (let i = 0; i < 3; i++) expect((await rl.hit('b', 'k', 3, 1000)).allowed).toBe(true);
    expect(await rl.hit('b', 'k', 3, 1000)).toEqual({ allowed: false, retryAfterMs: 1000, count: 4 });
    expect((await rl.hit('b', 'other', 3, 1000)).allowed).toBe(true);
    t = 1000;
    expect((await rl.hit('b', 'k', 3, 1000)).allowed).toBe(true);
  });
});

describe('SecretBox (AES-256-GCM + HMAC pepper)', () => {
  const box = new SecretBox(randomBytes(32));

  it('round-trips and binds ciphertext to its AAD', () => {
    const secret = randomBytes(20);
    const ct = box.encrypt(secret, 'totp:user-1');
    expect(ct.includes(secret)).toBe(false);
    expect(box.decrypt(ct, 'totp:user-1').equals(secret)).toBe(true);
    expect(() => box.decrypt(ct, 'totp:user-2')).toThrow(SecretBoxError);
  });

  it('detects tampering and uses a fresh IV each time', () => {
    const ct = box.encrypt(Buffer.from('abc'), 'a');
    const tampered = Buffer.from(ct);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => box.decrypt(tampered, 'a')).toThrow(SecretBoxError);
    expect(box.encrypt(Buffer.from('abc'), 'a').equals(ct)).toBe(false);
    expect(() => new SecretBox(randomBytes(32)).decrypt(ct, 'a')).toThrow(SecretBoxError);
  });

  it('derives a stable keyed MAC independent of the encryption key', () => {
    expect(box.mac('abc').equals(box.mac('abc'))).toBe(true);
    expect(new SecretBox(randomBytes(32)).mac('abc').equals(box.mac('abc'))).toBe(false);
  });

  it('loads a base64 key file and rejects bad ones without echoing content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remyral-key-'));
    try {
      const good = join(dir, 'good.key');
      await writeFile(good, `${randomBytes(32).toString('base64')}\n`);
      await expect(SecretBox.fromKeyFile(good)).resolves.toBeInstanceOf(SecretBox);
      const bad = join(dir, 'bad.key');
      await writeFile(bad, 'S3CRET-short');
      await expect(SecretBox.fromKeyFile(bad)).rejects.toThrow(/exactly 32 bytes/);
      await expect(SecretBox.fromKeyFile(bad)).rejects.not.toThrow(/S3CRET/);
      await expect(SecretBox.fromKeyFile(join(dir, 'missing.key'))).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
