import { describe, expect, it } from 'vitest';
import { isCommonPassword } from '../../src/auth/common-passwords.js';
import {
  checkPasswordPolicy,
  DEFAULT_SCRYPT_PARAMS,
  dummyHash,
  hashPassword,
  needsRehash,
  type ScryptParams,
  verifyPassword,
} from '../../src/auth/password.js';

const FAST: ScryptParams = { log2N: 10, r: 8, p: 1, keyLen: 32, saltLen: 16 };

describe('scrypt password hashing (ADR-0009 §3)', () => {
  it('uses N=2^17, r=8, p=1, 16-byte salt, 32-byte key by default', async () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ log2N: 17, r: 8, p: 1, keyLen: 32, saltLen: 16 });
    const encoded = await hashPassword('correct-staple-horse-battery');
    const m = /^\$scrypt\$ln=17,r=8,p=1\$([^$]+)\$([^$]+)$/.exec(encoded);
    expect(m).not.toBeNull();
    expect(Buffer.from(m?.[1] ?? '', 'base64')).toHaveLength(16);
    expect(Buffer.from(m?.[2] ?? '', 'base64')).toHaveLength(32);
    expect(await verifyPassword('correct-staple-horse-battery', encoded)).toBe(true);
    expect(await verifyPassword('correct-staple-horse-batterY', encoded)).toBe(false);
  });

  it('salts every hash', async () => {
    const a = await hashPassword('same-password-twice', FAST);
    const b = await hashPassword('same-password-twice', FAST);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-twice', a)).toBe(true);
    expect(await verifyPassword('same-password-twice', b)).toBe(true);
  });

  it('verifies with the parameters stored in the hash and flags weaker ones for rehash', async () => {
    const weak = await hashPassword('upgrade-me-please', FAST);
    expect(await verifyPassword('upgrade-me-please', weak)).toBe(true);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(weak, FAST)).toBe(false);
  });

  it('normalises Unicode (NFC) before hashing', async () => {
    const composed = 'café-password-1';
    const decomposed = 'café-password-1';
    expect(await verifyPassword(decomposed, await hashPassword(composed, FAST))).toBe(true);
  });

  it('returns false for malformed or tampered hashes', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', '$scrypt$ln=40,r=8,p=1$AAAA$AAAA')).toBe(false);
    const h = await hashPassword('tamper-target-1', FAST);
    expect(await verifyPassword('tamper-target-1', h.slice(0, -4) + 'AAA=')).toBe(false);
  });

  it('provides a dummy hash for timing equalisation', async () => {
    const d = await dummyHash(FAST);
    expect(await verifyPassword('anything', d)).toBe(false);
    expect(await dummyHash(FAST)).toBe(d);
  });
});

describe('password policy', () => {
  it('requires at least 12 characters (code points)', () => {
    expect(checkPasswordPolicy('short-pw-11', 'alex')).toEqual({ ok: false, reason: 'too_short' });
    expect(checkPasswordPolicy('🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑', 'alex')).toEqual({
      ok: false,
      reason: 'too_short',
    });
    expect(checkPasswordPolicy('violet-otter-harbor', 'alex')).toEqual({ ok: true });
  });

  it('rejects common passwords and trivial patterns', () => {
    for (const p of [
      'password1234',
      'Password1234',
      'qwertyuiop12',
      '123456789012',
      'aaaaaaaaaaaaaa',
      'abababababab',
      'abcdefghijklmn',
      'zyxwvutsrqponm',
      'correcthorsebatterystaple',
    ]) {
      expect(isCommonPassword(p)).toBe(true);
      expect(checkPasswordPolicy(p, 'alex')).toEqual({ ok: false, reason: 'common' });
    }
  });

  it('rejects passwords containing the username', () => {
    expect(checkPasswordPolicy('my-ALEX-password', 'alex')).toEqual({
      ok: false,
      reason: 'contains_username',
    });
  });

  it('caps the length', () => {
    expect(checkPasswordPolicy('x'.repeat(1025) + 'yz', 'alex')).toEqual({ ok: false, reason: 'too_long' });
  });
});
