import { describe, expect, it } from 'vitest';
import { validateNewPassword } from '../src/screens/password';

/** p5-self-password: forced replacement of a temporary password, and Settings → Change password. */

const NEW_PW = 'orbit fjord lantern 58';

describe('validateNewPassword', () => {
  it('checks length in code points and the confirmation', () => {
    expect(validateNewPassword('short', 'short').newPassword).toBeDefined();
    expect(validateNewPassword('😀'.repeat(12), '😀'.repeat(12))).toEqual({});
    expect(validateNewPassword(NEW_PW, `${NEW_PW}x`).confirmation).toBe('The passwords do not match.');
  });
});
