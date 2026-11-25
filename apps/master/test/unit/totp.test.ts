import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hotp,
  otpauthUri,
  totpAt,
  type TotpAlgorithm,
  verifyTotp,
} from '../../src/auth/totp.js';

// RFC 6238 Appendix B: seeds are the ASCII strings below (20/32/64 bytes), T0 = 0, X = 30, 8 digits.
const SEED: Record<TotpAlgorithm, Buffer> = {
  sha1: Buffer.from('12345678901234567890', 'ascii'),
  sha256: Buffer.from('12345678901234567890123456789012', 'ascii'),
  sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii'),
};

const RFC6238_VECTORS: [number, string, TotpAlgorithm][] = [
  [59, '94287082', 'sha1'],
  [59, '46119246', 'sha256'],
  [59, '90693936', 'sha512'],
  [1111111109, '07081804', 'sha1'],
  [1111111109, '68084774', 'sha256'],
  [1111111109, '25091201', 'sha512'],
  [1111111111, '14050471', 'sha1'],
  [1111111111, '67062674', 'sha256'],
  [1111111111, '99943326', 'sha512'],
  [1234567890, '89005924', 'sha1'],
  [1234567890, '91819424', 'sha256'],
  [1234567890, '93441116', 'sha512'],
  [2000000000, '69279037', 'sha1'],
  [2000000000, '90698825', 'sha256'],
  [2000000000, '38618901', 'sha512'],
  [20000000000, '65353130', 'sha1'],
  [20000000000, '77737706', 'sha256'],
  [20000000000, '47863826', 'sha512'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(RFC6238_VECTORS)('Appendix B: T=%i → %s (%s)', (seconds, expected, algorithm) => {
    expect(totpAt(SEED[algorithm], seconds * 1000, { digits: 8, algorithm })).toBe(expected);
  });

  it('matches RFC 4226 Appendix D HOTP values (6 digits)', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expected.forEach((code, counter) => {
      expect(hotp(SEED.sha1, BigInt(counter))).toBe(code);
    });
  });

  const key = SEED.sha1;
  const t = 1_791_800_000_000; // a fixed instant
  const step = Math.floor(t / 30_000);

  it('accepts the current step and ±1 step of skew, rejects ±2', () => {
    expect(verifyTotp(key, totpAt(key, t), t, null)).toBe(step);
    expect(verifyTotp(key, totpAt(key, t - 30_000), t, null)).toBe(step - 1);
    expect(verifyTotp(key, totpAt(key, t + 30_000), t, null)).toBe(step + 1);
    expect(verifyTotp(key, totpAt(key, t - 60_000), t, null)).toBeNull();
    expect(verifyTotp(key, totpAt(key, t + 60_000), t, null)).toBeNull();
  });

  it('rejects replay of an already used step (and of older steps)', () => {
    const code = totpAt(key, t);
    expect(verifyTotp(key, code, t, step)).toBeNull();
    expect(verifyTotp(key, code, t + 10_000, step)).toBeNull();
    expect(verifyTotp(key, totpAt(key, t - 30_000), t, step - 1)).toBeNull();
    // a newer step is still fine
    expect(verifyTotp(key, totpAt(key, t + 30_000), t, step)).toBe(step + 1);
  });

  it('rejects malformed codes', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456', '12345a', '１２３４５６']) {
      expect(verifyTotp(key, bad, t, null)).toBeNull();
    }
  });

  it('round-trips base32 (RFC 4648 vectors)', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded).toString()).toBe(plain);
    }
    expect(base32Decode('mzxw 6ytb-oi======').toString()).toBe('foobar');
    expect(() => base32Decode('MZ1')).toThrow();
  });

  it('builds the otpauth URI authenticator apps expect', () => {
    expect(otpauthUri(Buffer.from('foobar'), 'alex')).toBe(
      'otpauth://totp/Remyral:alex?secret=MZXW6YTBOI&issuer=Remyral',
    );
  });
});
