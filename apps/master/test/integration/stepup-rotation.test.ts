import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/auth/hooks.js';
import { MAX_MFA_FAILURES_PER_SESSION } from '../../src/auth/service.js';
import { sha256 } from '../../src/auth/sessions.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

/**
 * p9-stepup-rotation-logout (docs/design/p1-master-auth.md, addendum 2026-10-17): a step-up rotates the
 * session id. A request that was already on its way with the old cookie (another tab, a poll, a stream
 * reconnect, a double submit) must not wipe the browser's NEW cookie with a clearing Set-Cookie — that is
 * what logged the owner out minutes after a successful step-up. And the step-up's 401 tells the dialog
 * why a code failed (already used / wrong) and how many tries the session has left.
 */
const PW = 'violet-otter-harbor-42';

let h: Harness;

function setCookieNames(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as string[]) : [];
  return list.map((c) => c.split('=')[0] ?? '');
}

async function newUser(name: string): Promise<string> {
  await h.createUser(name, PW, 'owner');
  return (await enroll(h, name, PW)).secret;
}

async function login(username: string, secret: string): Promise<Client> {
  h.clock.advance(30_000);
  const c = h.client();
  expect((await c.req('POST', '/auth/login', { username, password: PW })).statusCode).toBe(200);
  const v = await c.req('POST', '/auth/totp/verify', { code: h.code(secret) });
  expect(v.statusCode, v.body).toBe(200);
  return c;
}

async function mfaFailures(c: Client): Promise<number | undefined> {
  const { rows } = await h.db.pool.query<{ mfa_failures: number }>(
    'SELECT mfa_failures FROM sessions WHERE id_hash = $1',
    [sha256(c.session ?? '')],
  );
  return rows[0]?.mfa_failures;
}

async function failedAttempts(username: string): Promise<number> {
  const { rows } = await h.db.pool.query<{ failed_attempts: number }>(
    'SELECT failed_attempts FROM users WHERE username = $1',
    [username],
  );
  return rows[0]?.failed_attempts ?? -1;
}

interface StepUpFailure {
  error: string;
  message: string;
  reason?: string;
  attemptsRemaining?: number;
  sessionTerminated?: boolean;
}

describeIntegration('step-up rotation and stale cookies (integration, p9-stepup-rotation-logout)', () => {
  beforeAll(async () => {
    h = new Harness();
    await h.start();
  });
  afterAll(async () => {
    await h.stop();
  });

  describe('a request still carrying the rotated-away id', () => {
    it('GET gets 401 but never a Set-Cookie that would clear the new session cookie', async () => {
      const secret = await newUser('stale-get');
      const tab = await login('stale-get', secret);
      const otherTab = tab.clone(); // a poll / stream reconnect sent before the step-up response arrived
      h.clock.advance(30_000);
      const up = await tab.req('POST', '/auth/step-up', { code: h.code(secret) });
      expect(up.statusCode, up.body).toBe(200);
      expect(tab.session).not.toBe(otherTab.session);

      const stale = await otherTab.req('GET', '/auth/session');
      expect(stale.statusCode).toBe(401);
      // The bug: `__Host-ras=; Max-Age=0` here deleted the cookie the step-up had just set.
      expect(setCookieNames(stale)).not.toContain(SESSION_COOKIE);
      expect(setCookieNames(stale)).not.toContain(CSRF_COOKIE);
      // The browser (one shared jar) still holds the rotated session: the re-check succeeds.
      expect((await tab.req('GET', '/auth/session')).statusCode).toBe(200);
    });

    it('a mutation and a step-up double submit with the old id also leave the cookies alone', async () => {
      const secret = await newUser('stale-post');
      const tab = await login('stale-post', secret);
      const doubleSubmit = tab.clone();
      h.clock.advance(30_000);
      const code = h.code(secret);
      expect((await tab.req('POST', '/auth/step-up', { code })).statusCode).toBe(200);

      const second = await doubleSubmit.req('POST', '/auth/step-up', { code });
      expect(second.statusCode).toBe(401);
      expect(second.json<StepUpFailure>().error).toBe('unauthorized');
      expect(setCookieNames(second)).toHaveLength(0);
      const mutation = await doubleSubmit.req('POST', '/auth/logout');
      expect(mutation.statusCode).toBe(401);
      expect(setCookieNames(mutation)).toHaveLength(0);

      const s = await tab.req('GET', '/auth/session');
      expect(s.statusCode).toBe(200);
      expect(
        s.json<{ session: { stepUpValidUntil: string | null } }>().session.stepUpValidUntil,
      ).not.toBeNull();
    });

    it('rotation stays strict: the old id is refused at once for reads and writes (no grace)', async () => {
      const secret = await newUser('no-grace');
      const tab = await login('no-grace', secret);
      const old = tab.clone();
      h.clock.advance(30_000);
      expect((await tab.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
      expect((await old.req('GET', '/auth/session')).statusCode).toBe(401);
      expect((await old.req('GET', '/auth/devices')).statusCode).toBe(401);
    });

    it('a logout still clears the cookies (explicit end of the session)', async () => {
      const secret = await newUser('bye');
      const tab = await login('bye', secret);
      const out = await tab.req('POST', '/auth/logout');
      expect(out.statusCode).toBe(200);
      expect(setCookieNames(out)).toContain(SESSION_COOKIE);
      expect(tab.session).toBeUndefined();
    });
  });

  describe('step-up failures tell the dialog what happened', () => {
    it('the login code reused right away is "already used" and does not count towards termination', async () => {
      const secret = await newUser('replay-own');
      const tab = await login('replay-own', secret);
      h.clock.advance(2_000); // same 30-second step as the login code
      const before = await failedAttempts('replay-own');
      const res = await tab.req('POST', '/auth/step-up', { code: h.code(secret) });
      expect(res.statusCode).toBe(401);
      const body = res.json<StepUpFailure>();
      expect(body.error).toBe('invalid_credentials');
      expect(body.reason).toBe('replayed_totp');
      expect(body.attemptsRemaining).toBe(MAX_MFA_FAILURES_PER_SESSION);
      expect(body.sessionTerminated).toBe(false);
      expect(await mfaFailures(tab)).toBe(0);
      expect(await failedAttempts('replay-own')).toBe(before);
      const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'auth.step_up' AND outcome = 'failure'
          ORDER BY id DESC LIMIT 1`,
      );
      expect(rows[0]?.metadata).toMatchObject({ reason: 'replayed_totp', counted: false });
      // The next code works.
      h.clock.advance(30_000);
      expect((await tab.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    });

    it('a code consumed by ANOTHER session (or long ago) still counts', async () => {
      const secret = await newUser('replay-other');
      const a = await login('replay-other', secret);
      h.clock.advance(2 * 60_000);
      expect((await a.req('GET', '/auth/session')).statusCode).toBe(200);
      const b = await login('replay-other', secret); // consumes the current step on session B
      h.clock.advance(1_000);
      const res = await a.req('POST', '/auth/step-up', { code: h.code(secret) });
      expect(res.statusCode).toBe(401);
      const body = res.json<StepUpFailure>();
      expect(body.reason).toBe('replayed_totp');
      expect(body.attemptsRemaining).toBe(MAX_MFA_FAILURES_PER_SESSION - 1);
      expect(await mfaFailures(a)).toBe(1);
      expect(await mfaFailures(b)).toBe(0);
    });

    it('wrong codes count down and the fifth ends the session (sessionTerminated)', async () => {
      const secret = await newUser('bad-codes');
      const tab = await login('bad-codes', secret);
      const wrong = h.code(secret, 5); // a well-formed code from outside the accepted window
      for (let i = 1; i <= MAX_MFA_FAILURES_PER_SESSION; i++) {
        h.clock.advance(1_000);
        const res = await tab.req('POST', '/auth/step-up', { code: wrong });
        expect(res.statusCode).toBe(401);
        const body = res.json<StepUpFailure>();
        expect(body.reason).toBe('bad_totp');
        expect(body.attemptsRemaining).toBe(MAX_MFA_FAILURES_PER_SESSION - i);
        expect(body.sessionTerminated).toBe(i === MAX_MFA_FAILURES_PER_SESSION);
      }
      expect((await tab.req('GET', '/auth/session')).statusCode).toBe(401);
    });

    it('the login second factor keeps its generic answer (no reason before the session is full)', async () => {
      const secret = await newUser('login-generic');
      h.clock.advance(30_000);
      const c = h.client();
      expect(
        (await c.req('POST', '/auth/login', { username: 'login-generic', password: PW })).statusCode,
      ).toBe(200);
      const res = await c.req('POST', '/auth/totp/verify', { code: h.code(secret, 5) });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_credentials', message: 'Invalid credentials.' });
    });
  });
});
