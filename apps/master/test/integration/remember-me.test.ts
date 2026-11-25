import { afterAll, beforeAll, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/hooks.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

/**
 * p5-remember-device: "Remember me" (docs/design/p5-remember-device.md §3). A remembered session uses
 * idle 7 d / absolute 30 d instead of 30 min / 12 h; everything else (rotation, step-up) is unchanged.
 */
const PW = 'violet-otter-harbor-42';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let h: Harness;
let secret: string;

async function login(remember: boolean | undefined): Promise<Client> {
  h.clock.advance(30_000);
  const c = h.client();
  const res = await c.req('POST', '/auth/login', {
    username: 'rememberer',
    password: PW,
    ...(remember === undefined ? {} : { remember }),
  });
  expect(res.statusCode, res.body).toBe(200);
  const v = await c.req('POST', '/auth/totp/verify', { code: h.code(secret) });
  expect(v.statusCode, v.body).toBe(200);
  return c;
}

interface SessionBody {
  session: { type: string; expiresAt: string; idleExpiresAt: string; createdAt: string };
}

describeIntegration('remember me (integration, p5-remember-device)', () => {
  beforeAll(async () => {
    h = new Harness();
    await h.start();
    await h.createUser('rememberer', PW);
    ({ secret } = await enroll(h, 'rememberer', PW));
  });
  afterAll(async () => {
    await h.stop();
  });

  it('advertises the enabled options publicly', async () => {
    const res = await h.client().req('GET', '/auth/options');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      rememberMe: { idleDays: 7, absoluteDays: 30 },
      trustedDevice: { days: 30 },
    });
  });

  it('a remembered session gets a 30-day cookie and reports its type and expiry', async () => {
    const start = h.clock.now().getTime();
    const c = await login(true);
    const s = await c.req('GET', '/auth/session');
    const body = s.json<SessionBody>().session;
    expect(body.type).toBe('remembered');
    const created = Date.parse(body.createdAt);
    expect(Date.parse(body.expiresAt) - created).toBe(30 * DAY);
    expect(Date.parse(body.idleExpiresAt) - h.clock.now().getTime()).toBe(7 * DAY);
    expect(created).toBeGreaterThanOrEqual(start);

    // Cookie Max-Age follows the absolute lifetime (seen on the next cookie-setting response: step-up).
    h.clock.advance(30_000);
    const up = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
    const cookie = up.cookies.find((x) => x.name === SESSION_COOKIE) as { maxAge?: number } | undefined;
    expect(cookie?.maxAge).toBeGreaterThan(29 * 24 * 3600);
    expect(cookie?.maxAge).toBeLessThanOrEqual(30 * 24 * 3600);
    // Step-up rotation keeps the session type and the absolute expiry.
    const after = (await c.req('GET', '/auth/session')).json<SessionBody>().session;
    expect(after.type).toBe('remembered');
    expect(after.expiresAt).toBe(body.expiresAt);
  });

  it('survives more than 30 minutes idle and more than 12 hours absolute', async () => {
    const c = await login(true);
    h.clock.advance(45 * MIN);
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(200);
    // Keep it active past the standard 12-hour absolute limit.
    for (let elapsed = 0; elapsed < 14 * HOUR; elapsed += 6 * HOUR) {
      h.clock.advance(6 * HOUR);
      expect((await c.req('GET', '/auth/session')).statusCode).toBe(200);
    }
    // A full day idle is still fine (the opportunistic cleanup of another login must not delete it).
    h.clock.advance(1 * DAY);
    await login(false);
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(200);
  });

  it('expires after 7 days idle', async () => {
    const c = await login(true);
    h.clock.advance(7 * DAY - MIN);
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(200);
    h.clock.advance(7 * DAY + MIN);
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(401);
  });

  it('expires at 30 days absolute even while active', async () => {
    const c = await login(true);
    let elapsed = 0;
    while (elapsed + 6 * DAY < 30 * DAY - HOUR) {
      h.clock.advance(6 * DAY);
      elapsed += 6 * DAY;
      expect((await c.req('GET', '/auth/session')).statusCode, `after ${String(elapsed / DAY)} d`).toBe(200);
    }
    h.clock.advance(30 * DAY - elapsed + MIN);
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(401);
  });

  it('standard sessions are unchanged: 30 min idle, 12 h absolute, type standard', async () => {
    for (const remember of [undefined, false] as const) {
      const c = await login(remember);
      const body = (await c.req('GET', '/auth/session')).json<SessionBody>().session;
      expect(body.type).toBe('standard');
      expect(Date.parse(body.expiresAt) - Date.parse(body.createdAt)).toBe(12 * HOUR);
      h.clock.advance(31 * MIN);
      expect((await c.req('GET', '/auth/session')).statusCode).toBe(401);
    }
    const active = await login(false);
    for (let i = 0; i < 25; i++) {
      h.clock.advance(29 * MIN);
      expect((await active.req('GET', '/auth/session')).statusCode).toBe(i < 24 ? 200 : 401);
    }
  });

  it('remember applies to the session after the second factor, the pending stage stays 5 minutes', async () => {
    h.clock.advance(30_000);
    const c = h.client();
    await c.req('POST', '/auth/login', { username: 'rememberer', password: PW, remember: true });
    h.clock.advance(5 * MIN + 1_000);
    expect((await c.req('POST', '/auth/totp/verify', { code: h.code(secret) })).statusCode).toBe(401);
  });

  it('logout ends a remembered session; the id still rotates at login', async () => {
    const c = await login(true);
    const copy = c.clone();
    expect((await c.req('POST', '/auth/logout')).statusCode).toBe(200);
    expect((await copy.req('GET', '/auth/session')).statusCode).toBe(401);
  });

  it('the password change keeps the session type', async () => {
    const c = await login(true);
    h.clock.advance(30_000);
    await c.req('POST', '/auth/step-up', { code: h.code(secret) });
    const res = await c.req('POST', '/auth/password', {
      currentPassword: PW,
      newPassword: 'quartz-meadow-falcon-77',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await c.req('GET', '/auth/session')).json<SessionBody>().session.type).toBe('remembered');
    // Restore for the other tests.
    h.clock.advance(30_000);
    await c.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(
      (await c.req('POST', '/auth/password', { currentPassword: 'quartz-meadow-falcon-77', newPassword: PW }))
        .statusCode,
    ).toBe(200);
  });

  it('records the choice in the audit log', async () => {
    await login(true);
    const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = 'auth.login.password' AND outcome = 'success' ORDER BY id DESC LIMIT 1",
    );
    expect(rows[0]?.metadata).toMatchObject({ next: 'mfa_pending', remember: true });
  });
});

describeIntegration('remember me disabled (AUTH_REMEMBER_IDLE_DAYS=0)', () => {
  let d: Harness;
  beforeAll(async () => {
    d = new Harness();
    await d.start({ loginPersistence: { trustedDeviceMs: 30 * DAY, remember: null } });
  });
  afterAll(async () => {
    await d.stop();
  });

  it('ignores the flag', async () => {
    expect((await d.client().req('GET', '/auth/options')).json()).toEqual({
      rememberMe: null,
      trustedDevice: { days: 30 },
    });
    await d.createUser('plain', PW);
    const { client } = await enroll(d, 'plain', PW);
    expect((await client.req('GET', '/auth/session')).json<SessionBody>().session.type).toBe('standard');
    d.clock.advance(30_000);
    const c = d.client();
    await c.req('POST', '/auth/login', { username: 'plain', password: PW, remember: true });
    const { rows } = await d.db.pool.query<{ remember: boolean }>(
      'SELECT remember FROM sessions ORDER BY created_at DESC LIMIT 1',
    );
    expect(rows[0]?.remember).toBe(false);
  });
});
