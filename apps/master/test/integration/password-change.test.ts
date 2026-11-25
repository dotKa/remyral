import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p5-self-password (ADR-0009 §3/§8/§10, threat model T-CP-1/T-CP-2/T-SEC-1): self-service password change
 * from a full session (current password + new password + step-up), and the forced change of a temporary
 * password (`password_change` session stage) before anything else is reachable.
 */
const PW = 'quartz-meadow-lantern-7';
const NEW_PW = 'CANARY-new-pw-58c1-orbit-fjord';
const FORCED_PW = 'CANARY-forced-pw-91d2-heron-delta';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

let h: Harness;

async function auditRows(action: string): Promise<{ outcome: string; metadata: Record<string, unknown> }[]> {
  const { rows } = await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
    'SELECT outcome, metadata FROM audit_events WHERE action = $1 ORDER BY id',
    [action],
  );
  return rows;
}

async function login(username: string, password: string): Promise<{ client: Client; status: number }> {
  const client = h.client();
  const res = await client.req('POST', '/auth/login', { username, password });
  return { client, status: res.statusCode };
}

describeIntegration('self-service password change (integration)', () => {
  beforeAll(async () => {
    h = new Harness();
    await h.start();
  });
  afterAll(async () => {
    await h.stop();
  });

  describe('POST /auth/password', () => {
    let secret: string;
    let main: Client;
    let other: Client;

    beforeAll(async () => {
      await h.createUser('alice', PW, 'operator');
      const e = await enroll(h, 'alice', PW);
      secret = e.secret;
      main = e.client; // fresh TOTP from enrollment: step-up is valid
      other = await fullLogin(h, 'alice', PW, secret);
    });

    it('needs a CSRF token and a fresh step-up', async () => {
      const noCsrf = main.clone();
      noCsrf.sendCsrf = false;
      const csrf = await noCsrf.req('POST', '/auth/password', { currentPassword: PW, newPassword: NEW_PW });
      expect(csrf.statusCode).toBe(403);
      expect(csrf.json()).toMatchObject({ error: 'csrf_failed' });

      // `other` logged in 30 s ago with TOTP; 11 minutes later the step-up has lapsed.
      const stale = await fullLogin(h, 'alice', PW, secret);
      h.clock.advance(11 * 60_000);
      const res = await stale.req('POST', '/auth/password', { currentPassword: PW, newPassword: NEW_PW });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'step_up_required' });
      // Step-up and retry would work; keep `main` and `other` fresh for the next tests.
      h.clock.advance(30_000);
      expect((await main.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
      expect((await other.req('GET', '/auth/session')).statusCode).toBe(200);
    });

    it('rejects a wrong current password generically, counts it and audits it', async () => {
      const res = await main.req('POST', '/auth/password', {
        currentPassword: 'not-the-password-123',
        newPassword: NEW_PW,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_credentials', message: 'Invalid credentials.' });
      const { rows } = await h.db.pool.query<{ failed_attempts: number }>(
        "SELECT failed_attempts FROM users WHERE username = 'alice'",
      );
      expect(rows[0]?.failed_attempts).toBe(1);
      expect((await auditRows('auth.password.change')).at(-1)).toMatchObject({
        outcome: 'failure',
        metadata: { reason: 'bad_current' },
      });
      // The session survives a wrong current password; the old password still works.
      expect((await main.req('GET', '/auth/session')).statusCode).toBe(200);
    });

    it('enforces the admin:create policy and refuses reuse', async () => {
      const cases: [string, string][] = [
        ['short-pw', 'weak_password'],
        ['password1234', 'weak_password'], // common list
        ['xx-alice-is-me-42', 'weak_password'], // contains the username
        [PW, 'password_reused'],
      ];
      for (const [newPassword, error] of cases) {
        const res = await main.req('POST', '/auth/password', { currentPassword: PW, newPassword });
        expect(res.statusCode, newPassword).toBe(400);
        expect(res.json<{ error: string }>().error, newPassword).toBe(error);
      }
      // p14-i18n-errors: the policy reason and its limit travel as params (the English message is unchanged).
      const short = await main.req('POST', '/auth/password', {
        currentPassword: PW,
        newPassword: 'short-pw',
      });
      expect(short.json()).toEqual({
        error: 'weak_password',
        message: 'Password must be at least 12 characters.',
        params: { reason: 'too_short', min: 12 },
      });
      expect(
        (await auditRows('auth.password.change'))
          .filter((r) => r.outcome === 'denied')
          .map((r) => r.metadata),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: 'policy_too_short' }),
          expect.objectContaining({ reason: 'policy_common' }),
          expect.objectContaining({ reason: 'policy_contains_username' }),
          expect.objectContaining({ reason: 'reused' }),
        ]),
      );
      // Over-long input is refused by validation without hashing.
      const long = await main.req('POST', '/auth/password', {
        currentPassword: PW,
        newPassword: 'x'.repeat(1025),
      });
      expect(long.statusCode).toBe(400);
    });

    it('changes the password, rotates this session and revokes every other one', async () => {
      const before = main.session;
      const res = await main.req('POST', '/auth/password', { currentPassword: PW, newPassword: NEW_PW });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ status: 'changed' });
      expect(main.session).toBeDefined();
      expect(main.session).not.toBe(before);
      // This browser continues with the new session id; the old id is dead; the other browser is signed out.
      expect((await main.req('GET', '/auth/session')).statusCode).toBe(200);
      const stale = main.clone();
      if (before) stale.cookies.set('__Host-ras', before);
      expect((await stale.req('GET', '/auth/session')).statusCode).toBe(401);
      expect((await other.req('GET', '/auth/session')).statusCode).toBe(401);
      // Old password no longer works, the new one does.
      expect((await login('alice', PW)).status).toBe(401);
      await fullLogin(h, 'alice', NEW_PW, secret);
      const { rows } = await h.db.pool.query<{ failed_attempts: number; password_changed_at: Date | null }>(
        "SELECT failed_attempts, password_changed_at FROM users WHERE username = 'alice'",
      );
      expect(rows[0]?.password_changed_at).not.toBeNull();
      expect((await auditRows('auth.password.change')).at(-1)).toMatchObject({
        outcome: 'success',
        metadata: { forced: false, revokedOtherSessions: 2 },
      });
    });
  });

  describe('temporary password: forced change at first login', () => {
    let owner: Client;
    let temporary: string;

    beforeAll(async () => {
      await h.createUser('boss', PW, 'owner');
      owner = (await enroll(h, 'boss', PW)).client;
      const res = await owner.req('POST', '/users', { username: 'newbie', role: 'operator' });
      expect(res.statusCode, res.body).toBe(201);
      temporary = res.json<{ temporaryPassword: string }>().temporaryPassword;
    });

    it('enrollment ends in the password_change stage, which reaches nothing else', async () => {
      const c = h.client();
      const loginRes = await c.req('POST', '/auth/login', { username: 'newbie', password: temporary });
      expect(loginRes.json()).toMatchObject({ status: 'enrollment_required' });
      const start = await c.req('POST', '/auth/totp/enroll/start');
      const { secret } = start.json<{ secret: string }>();
      const confirm = await c.req('POST', '/auth/totp/enroll/confirm', { code: h.code(secret) });
      expect(confirm.statusCode).toBe(200);
      expect(confirm.json()).toMatchObject({ status: 'password_change_required' });
      expect(confirm.json<{ recoveryCodes: string[] }>().recoveryCodes).toHaveLength(10);

      // Every route other than the forced change refuses this session (route-coverage checks all of them).
      for (const [method, url] of [
        ['GET', '/auth/session'],
        ['GET', '/jobs'],
        ['POST', '/auth/password'],
        ['POST', '/auth/step-up'],
        ['POST', '/auth/logout-all'],
        ['GET', '/users'],
        ['POST', '/auth/totp/enroll/start'],
      ] as [Method, string][]) {
        const res = await c.clone().req(method, url, method === 'GET' ? undefined : {});
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }

      // Policy and reuse of the temporary password are refused.
      const weak = await c.req('POST', '/auth/password/initial', { newPassword: 'too-short' });
      expect(weak.statusCode).toBe(400);
      expect(weak.json()).toMatchObject({ error: 'weak_password' });
      const reuse = await c.req('POST', '/auth/password/initial', { newPassword: temporary });
      expect(reuse.statusCode).toBe(400);
      expect(reuse.json()).toMatchObject({ error: 'password_reused' });

      const done = await c.req('POST', '/auth/password/initial', { newPassword: FORCED_PW });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({ status: 'authenticated', user: { username: 'newbie' } });
      expect((await c.req('GET', '/auth/session')).statusCode).toBe(200);
      expect((await c.req('POST', '/auth/password/initial', { newPassword: NEW_PW })).statusCode).toBe(401);

      const { rows } = await h.db.pool.query<{ password_change_required: boolean }>(
        "SELECT password_change_required FROM users WHERE username = 'newbie'",
      );
      expect(rows[0]?.password_change_required).toBe(false);
      expect((await login('newbie', temporary)).status).toBe(401);
      expect((await auditRows('auth.password.change')).at(-1)).toMatchObject({
        outcome: 'success',
        metadata: { forced: true },
      });
      expect((await auditRows('user.create')).at(-1)?.metadata).toMatchObject({
        firstLoginSteps: ['totp_enrollment', 'password_change'],
      });

      // Later logins go straight to a full session.
      await fullLogin(h, 'newbie', FORCED_PW, secret);
    });

    it('applies after TOTP and after a recovery code for enrolled accounts, and the stage expires', async () => {
      await h.createUser('flagged', PW, 'viewer');
      const { secret, recoveryCodes } = await enroll(h, 'flagged', PW);
      await h.db.pool.query("UPDATE users SET password_change_required = true WHERE username = 'flagged'");

      h.clock.advance(30_000);
      const c = h.client();
      await c.req('POST', '/auth/login', { username: 'flagged', password: PW });
      const verify = await c.req('POST', '/auth/totp/verify', { code: h.code(secret) });
      expect(verify.json()).toMatchObject({ status: 'password_change_required' });
      expect((await c.req('GET', '/auth/session')).statusCode).toBe(401);
      // The stage is a pending login: it ends after 5 minutes.
      h.clock.advance(5 * 60_000 + 1);
      expect((await c.req('POST', '/auth/password/initial', { newPassword: FORCED_PW })).statusCode).toBe(
        401,
      );

      const r = h.client();
      await r.req('POST', '/auth/login', { username: 'flagged', password: PW });
      const rec = await r.req('POST', '/auth/recovery', { code: recoveryCodes[0] });
      expect(rec.json()).toMatchObject({ status: 'password_change_required' });
      expect((await r.req('POST', '/auth/password/initial', { newPassword: FORCED_PW })).statusCode).toBe(
        200,
      );
      expect((await r.req('GET', '/auth/session')).statusCode).toBe(200);
    });

    it('the CLI-created bootstrap owner is never forced', async () => {
      const { rows } = await h.db.pool.query<{ password_change_required: boolean }>(
        "SELECT password_change_required FROM users WHERE username = 'boss'",
      );
      expect(rows[0]?.password_change_required).toBe(false);
    });
  });

  it('canary: no password value reaches the logs or the audit log', async () => {
    const { rows } = await h.db.pool.query<{ dump: string }>(
      "SELECT coalesce(string_agg(a::text, '\n'), '') AS dump FROM audit_events a",
    );
    const dump = rows[0]?.dump ?? '';
    expect(dump).toContain('auth.password.change');
    expect(h.logs.text).toContain('/auth/password');
    for (const value of [PW, NEW_PW, FORCED_PW, 'not-the-password-123', 'xx-alice-is-me-42']) {
      expect(h.logs.text, 'password in logs').not.toContain(value);
      expect(dump, 'password in audit log').not.toContain(value);
    }
  });
});
