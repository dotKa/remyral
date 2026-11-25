import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { users } from '../../src/auth/users.js';
import {
  AdminError,
  assertUserAbsent,
  createUser,
  parseRole,
  resetUser,
  validateNewPassword,
  validateUsername,
} from '../../src/cli/admin.js';
import { describeIntegration } from '../helpers/env.js';
import { enroll, FAST_SCRYPT, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'amber-falcon-river-31';

describeIntegration('admin CLI operations (integration)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = new Harness();
    await h.start();
  });
  afterAll(async () => {
    await h.stop();
  });

  const deps = () => ({ pool: h.db.pool, audit: new AuditLog(h.db.pool), passwordParams: FAST_SCRYPT });

  it('creates the owner without TOTP and refuses an existing username', async () => {
    await createUser(deps(), { username: 'alex', role: 'owner', password: PW });
    const u = await users.findByUsername(h.db.pool, 'alex');
    expect(u).toMatchObject({ role: 'owner', totpEnabled: false, totpSecretEnc: null });
    await expect(assertUserAbsent(h.db.pool, 'alex')).rejects.toThrow(/already exists/);
    await expect(
      createUser(deps(), { username: 'alex', role: 'owner', password: PW }),
    ).rejects.toBeInstanceOf(AdminError);
    const { rows } = await h.db.pool.query("SELECT 1 FROM audit_events WHERE action = 'user.create'");
    expect(rows).toHaveLength(1);
  });

  it('validates input before touching the database', () => {
    expect(() => validateUsername('Alex')).toThrow(AdminError);
    expect(() => validateUsername('a')).toThrow(AdminError);
    expect(validateUsername('alex')).toBe('alex');
    expect(() => parseRole('root')).toThrow(AdminError);
    expect(() => {
      validateNewPassword(PW, `${PW}!`, 'alex');
    }).toThrow(/do not match/);
    expect(() => {
      validateNewPassword('short', 'short', 'alex');
    }).toThrow(/at least 12/);
    expect(() => {
      validateNewPassword('password1234', 'password1234', 'alex');
    }).toThrow(/too common/);
  });

  it('resets MFA, password and lockout from the shell and revokes all sessions', async () => {
    await createUser(deps(), { username: 'owner2', role: 'owner', password: PW });
    const { secret } = await enroll(h, 'owner2', PW);
    const session = await fullLogin(h, 'owner2', PW, secret);
    await h.db.pool.query(
      "UPDATE users SET failed_attempts = 9, locked_until = now() + interval '1 hour' WHERE username = 'owner2'",
    );

    const newPw = 'granite-swallow-meadow-8';
    const result = await resetUser(deps(), {
      username: 'owner2',
      resetMfa: true,
      unlock: true,
      newPassword: newPw,
    });
    expect(result.revokedSessions).toBeGreaterThanOrEqual(1);
    expect((await session.req('GET', '/auth/session')).statusCode).toBe(401);
    const u = await users.findByUsername(h.db.pool, 'owner2');
    expect(u).toMatchObject({
      totpEnabled: false,
      totpSecretEnc: null,
      failedAttempts: 0,
      lockedUntil: null,
    });
    const codes = await h.db.pool.query(
      "SELECT 1 FROM recovery_codes r JOIN users u ON u.id = r.user_id WHERE u.username = 'owner2'",
    );
    expect(codes.rows).toHaveLength(0);

    // Old password no longer works; new one leads to mandatory re-enrollment.
    expect(
      (await h.client().req('POST', '/auth/login', { username: 'owner2', password: PW })).statusCode,
    ).toBe(401);
    const again = await h.client().req('POST', '/auth/login', { username: 'owner2', password: newPw });
    expect(again.json()).toMatchObject({ status: 'enrollment_required' });

    await expect(resetUser(deps(), { username: 'owner2', resetMfa: false, unlock: false })).rejects.toThrow(
      /nothing to do/,
    );
    await expect(resetUser(deps(), { username: 'ghost', resetMfa: true, unlock: false })).rejects.toThrow(
      /does not exist/,
    );
  });
});
