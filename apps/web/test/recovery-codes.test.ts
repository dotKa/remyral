import { describe, expect, it } from 'vitest';
import { recoveryCodesText } from '../src/screens/recoveryCodes';
import { digitsOnly } from '../src/screens/useSubmit';
import { USER } from './helpers';

describe('recoveryCodesText', () => {
  it('lists every code with account and timestamp', () => {
    const text = recoveryCodesText(
      USER,
      ['aaaa-bbbb-cccc', 'dddd-eeee-ffff'],
      new Date('2026-10-12T10:00:00Z'),
    );
    expect(text).toContain('Account: alex');
    expect(text).toContain('Generated: 2026-10-12T10:00:00.000Z');
    expect(text.split('\n')).toEqual(expect.arrayContaining(['aaaa-bbbb-cccc', 'dddd-eeee-ffff']));
  });
});

describe('digitsOnly', () => {
  it('keeps at most six digits from pasted input', () => {
    expect(digitsOnly('123 456')).toBe('123456');
    expect(digitsOnly('12a3-45 678')).toBe('123456');
    expect(digitsOnly('')).toBe('');
  });
});
