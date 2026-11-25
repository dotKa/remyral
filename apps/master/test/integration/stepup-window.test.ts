import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireStepUp, SESSION_COOKIE } from '../../src/auth/hooks.js';
import { sha256 } from '../../src/auth/sessions.js';
import { DEVICE_COOKIE } from '../../src/auth/trusted-devices.js';
import type { RoutePlugin } from '../../src/app.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness, type HarnessOptions } from '../helpers/harness.js';

/**
 * p5-stepup-window (docs/design/p5-remember-device.md §8): the step-up window resolved per session.
 * Standard session: 10 minutes. Remember-me or trusted-device session: one TOTP holds for the rest of the
 * session. Always-fresh (account-security) actions: 10 minutes on every session type.
 */
const PW = 'violet-otter-harbor-42';
const NEW_PW = 'quartz-meadow-falcon-77';
const MIN = 60_000;
const HOUR = 60 * MIN;

let h: Harness;

const routes: RoutePlugin = (app) => {
  app.post(
    '/test/privileged',
    { config: { authz: { action: 'api.docs' } }, preHandler: requireStepUp(undefined, () => h.clock.now()) },
    () => ({ ok: true }),
  );
  app.post(
    '/test/always-fresh',
    {
      config: { authz: { action: 'api.docs' } },
      preHandler: requireStepUp('always-fresh', () => h.clock.now()),
    },
    () => ({ ok: true }),
  );
};

interface SessionBody {
  session: {
    type: string;
    mfaAt: string | null;
    expiresAt: string;
    stepUpValidUntil: string | null;
    stepUpScope: 'window' | 'session';
    alwaysFreshValidUntil: string | null;
  };
}

async function start(opts: HarnessOptions = {}): Promise<void> {
  h = new Harness();
  await h.start({ extraRoutes: [routes], ...opts });
}

async function newUser(name: string, role: 'owner' | 'admin' | 'operator' | 'viewer' = 'owner') {
  const id = await h.createUser(name, PW, role);
  const { secret } = await enroll(h, name, PW);
  return { id, secret };
}

/** Password + TOTP login; `remember` / `trustDevice` as on the login form. */
async function login(
  username: string,
  secret: string,
  opts: { remember?: boolean; trustDevice?: boolean; browser?: Client } = {},
): Promise<Client> {
  h.clock.advance(30_000);
  const c = opts.browser ?? h.client();
  const res = await c.req('POST', '/auth/login', {
    username,
    password: PW,
    ...(opts.remember === undefined ? {} : { remember: opts.remember }),
  });
  expect(res.statusCode, res.body).toBe(200);
  const v = await c.req('POST', '/auth/totp/verify', {
    code: h.code(secret),
    ...(opts.trustDevice === undefined ? {} : { trustDevice: opts.trustDevice }),
  });
  expect(v.statusCode, v.body).toBe(200);
  return c;
}

/** A new browser holding only the device cookie of `from`; logs in with the password (no code step). */
async function deviceLogin(from: Client, username: string, remember = false): Promise<Client> {
  const c = h.client();
  c.cookies.set(DEVICE_COOKIE, from.cookies.get(DEVICE_COOKIE) ?? '');
  h.clock.advance(1_000);
  const res = await c.req('POST', '/auth/login', { username, password: PW, remember });
  expect(res.json(), res.body).toMatchObject({ status: 'authenticated' });
  return c;
}

async function stepUp(c: Client, secret: string) {
  h.clock.advance(30_000);
  const res = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ stepUpValidUntil: string; stepUpScope: string; alwaysFreshValidUntil: string }>();
}

async function session(c: Client): Promise<SessionBody['session']> {
  const res = await c.req('GET', '/auth/session');
  expect(res.statusCode, res.body).toBe(200);
  return res.json<SessionBody>().session;
}

/** Passes `ms` with activity every 20 minutes (a standard session idles out after 30). */
async function activeFor(c: Client, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 20 * MIN) {
    h.clock.advance(Math.min(20 * MIN, left));
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(200);
  }
}

const privileged = (c: Client) => c.req('POST', '/test/privileged');
const alwaysFresh = (c: Client) => c.req('POST', '/test/always-fresh');

async function sessionRow(c: Client) {
  const { rows } = await h.db.pool.query<{ trusted_device_id: string | null; remember: boolean }>(
    'SELECT trusted_device_id, remember FROM sessions WHERE id_hash = $1',
    [sha256(c.cookies.get(SESSION_COOKIE) ?? '')],
  );
  return rows[0];
}

describeIntegration('step-up window per session (integration, p5-stepup-window)', () => {
  beforeAll(async () => {
    await start();
  });
  afterAll(async () => {
    await h.stop();
  });

  it('standard session: the login TOTP counts as a step-up for 10 minutes', async () => {
    const { secret } = await newUser('std');
    const c = await login('std', secret);
    const s = await session(c);
    expect(s.stepUpScope).toBe('window');
    expect(Date.parse(s.stepUpValidUntil ?? '') - Date.parse(s.mfaAt ?? '')).toBe(10 * MIN);
    expect(s.alwaysFreshValidUntil).toBe(s.stepUpValidUntil);
    expect((await privileged(c)).statusCode).toBe(200);
    await activeFor(c, 11 * MIN);
    const denied = await privileged(c);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'step_up_required' });
    expect((await session(c)).stepUpValidUntil).toBeNull();
    const up = await stepUp(c, secret);
    expect(up.stepUpScope).toBe('window');
    expect(Date.parse(up.stepUpValidUntil) - h.clock.now().getTime()).toBe(10 * MIN);
    expect((await privileged(c)).statusCode).toBe(200);
  });

  it('remember-me session: one TOTP holds for the rest of the session; always-fresh still 10 minutes', async () => {
    const { id, secret } = await newUser('remembered');
    const c = await login('remembered', secret, { remember: true });
    const s = await session(c);
    expect(s.type).toBe('remembered');
    expect(s.stepUpScope).toBe('session');
    expect(s.stepUpValidUntil).toBe(s.expiresAt); // "verified for this session"
    h.clock.advance(5 * HOUR);
    expect((await privileged(c)).statusCode).toBe(200);
    h.clock.advance(3 * 24 * HOUR);
    expect((await privileged(c)).statusCode).toBe(200);
    // Handler-level checks follow the same rule: the audit export gate (AccessGate) and a service that
    // re-checks the actor's step-up in its transaction (usage budgets: route hook + store check).
    expect((await c.req('GET', '/audit/export')).statusCode).toBe(200);
    expect((await c.req('POST', '/projects', { id: 'remember-proj', name: 'Remembered' })).statusCode).toBe(
      201,
    );
    const policy = await c.req('PUT', '/projects/remember-proj/policy', {
      expectedVersion: 0,
      rules: { 'git.merge': { outcome: 'require_approval', expiresInSec: 60 } },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    // Account-security actions: a TOTP from the last 10 minutes on every session type.
    const fresh = await alwaysFresh(c);
    expect(fresh.statusCode).toBe(403);
    expect(fresh.json()).toMatchObject({ error: 'step_up_required' });
    expect((await session(c)).alwaysFreshValidUntil).toBeNull();
    const up = await stepUp(c, secret);
    expect(up.stepUpScope).toBe('session');
    expect(Date.parse(up.alwaysFreshValidUntil) - h.clock.now().getTime()).toBe(10 * MIN);
    expect((await alwaysFresh(c)).statusCode).toBe(200);
    h.clock.advance(11 * MIN);
    expect((await alwaysFresh(c)).statusCode).toBe(403);
    expect((await privileged(c)).statusCode).toBe(200);
    // The step-up is audited with its scope.
    const { rows } = await h.db.pool.query<{ metadata: { scope?: string } }>(
      "SELECT metadata FROM audit_events WHERE action = 'auth.step_up' AND actor_id = $1 AND outcome = 'success'",
      [id],
    );
    expect(rows.map((r) => r.metadata.scope)).toEqual(['session']);
  });

  it('trusted-device login without a code: the first privileged action asks once, then it holds', async () => {
    const { secret } = await newUser('device');
    const first = await login('device', secret, { trustDevice: true });
    // The TOTP login that created the trust is itself a long-lived session with a step-up.
    expect((await session(first)).stepUpScope).toBe('session');
    const firstDevice = (await sessionRow(first))?.trusted_device_id;
    expect(firstDevice).toMatch(/^[0-9a-f-]{36}$/);
    await activeFor(first, HOUR);
    expect((await privileged(first)).statusCode).toBe(200);

    const c = await deviceLogin(first, 'device');
    const before = await session(c);
    expect(before.type).toBe('standard');
    expect(before.stepUpScope).toBe('session');
    expect(before.mfaAt).toBeNull();
    expect(before.stepUpValidUntil).toBeNull(); // "not confirmed yet"
    expect((await privileged(c)).statusCode).toBe(403);
    const oldCookie = c.cookies.get(SESSION_COOKIE);
    const up = await stepUp(c, secret);
    expect(up.stepUpScope).toBe('session');
    // Rotation: new id, the device binding is kept; the old id is gone.
    expect(c.cookies.get(SESSION_COOKIE)).not.toBe(oldCookie);
    expect((await sessionRow(c))?.trusted_device_id).toBe(firstDevice);
    const stale = h.client();
    stale.cookies.set(SESSION_COOKIE, oldCookie ?? '');
    expect((await stale.req('GET', '/auth/session')).statusCode).toBe(401);
    await activeFor(c, 3 * HOUR);
    expect((await privileged(c)).statusCode).toBe(200);
    expect((await alwaysFresh(c)).statusCode).toBe(403);
  });

  it('revoking the device turns its sessions back into standard ones', async () => {
    const { secret } = await newUser('revoker');
    const first = await login('revoker', secret, { trustDevice: true });
    const c = await deviceLogin(first, 'revoker');
    await stepUp(c, secret);
    await activeFor(c, HOUR);
    expect((await privileged(c)).statusCode).toBe(200);
    const devices = await c.req('GET', '/auth/devices');
    const id = devices.json<{ devices: { id: string }[] }>().devices[0]?.id ?? '';
    expect((await c.req('DELETE', `/auth/devices/${id}`)).statusCode).toBe(200);
    expect((await sessionRow(c))?.trusted_device_id).toBeNull();
    // Every session established on that device lost the binding (ON DELETE SET NULL).
    expect((await sessionRow(first))?.trusted_device_id).toBeNull();
    const s = await session(c);
    expect(s.stepUpScope).toBe('window');
    expect(s.stepUpValidUntil).toBeNull();
    expect((await privileged(c)).statusCode).toBe(403);
  });

  it('a recovery-code login that trusts the device has not stepped up yet', async () => {
    const id = await h.createUser('recover', PW, 'owner');
    const { recoveryCodes } = await enroll(h, 'recover', PW);
    expect(id).toBeTruthy();
    h.clock.advance(30_000);
    const c = h.client();
    await c.req('POST', '/auth/login', { username: 'recover', password: PW });
    const r = await c.req('POST', '/auth/recovery', { code: recoveryCodes[0], trustDevice: true });
    expect(r.statusCode, r.body).toBe(200);
    const s = await session(c);
    expect(s.stepUpScope).toBe('session');
    expect(s.stepUpValidUntil).toBeNull();
    expect((await privileged(c)).statusCode).toBe(403);
  });

  it('always-fresh routes: password change, revoke all devices and user management ask on long-lived sessions', async () => {
    const { secret } = await newUser('boss');
    const target = await h.createUser('someone', PW, 'viewer');
    const c = await login('boss', secret, { remember: true, trustDevice: true });
    h.clock.advance(HOUR); // remembered: no idle timeout in an hour
    expect((await c.req('POST', '/projects', { id: 'stepup-proj', name: 'Step-up' })).statusCode).toBe(201);
    for (const [method, url, body] of [
      ['POST', '/auth/password', { currentPassword: PW, newPassword: NEW_PW }],
      ['POST', '/auth/devices/revoke-all', undefined],
      ['POST', '/users', { username: 'newbie', role: 'viewer' }],
      ['PUT', `/users/${target}/role`, { role: 'operator' }],
      ['POST', `/users/${target}/disable`, {}],
      ['POST', `/users/${target}/enable`, {}],
    ] as const) {
      const res = await c.req(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json(), `${method} ${url}`).toMatchObject({ error: 'step_up_required' });
    }
    await stepUp(c, secret);
    // Within 10 minutes they pass; the password change keeps the session type, drops the device binding.
    const changed = await c.req('POST', '/auth/password', { currentPassword: PW, newPassword: NEW_PW });
    expect(changed.statusCode, changed.body).toBe(200);
    const row = await sessionRow(c);
    expect(row).toEqual({ trusted_device_id: null, remember: true });
    expect((await session(c)).stepUpScope).toBe('session');
    expect((await c.req('POST', `/users/${target}/disable`, {})).statusCode).toBe(200);
  });

  it('logout ends the session and its step-up', async () => {
    const { secret } = await newUser('leaver');
    const c = await login('leaver', secret, { remember: true });
    const cookie = c.cookies.get(SESSION_COOKIE);
    expect((await c.req('POST', '/auth/logout')).statusCode).toBe(200);
    const replay = h.client();
    replay.cookies.set(SESSION_COOKIE, cookie ?? '');
    expect((await replay.req('POST', '/test/privileged')).statusCode).toBe(401);
  });
});

describe('configured step-up windows', () => {
  describeIntegration('AUTH_STEP_UP_TRUSTED=off, AUTH_STEP_UP_MINUTES=5', () => {
    beforeAll(async () => {
      await start({ stepUp: { windowMs: 5 * MIN, longLived: { kind: 'off' } } });
    });
    afterAll(async () => {
      await h.stop();
    });

    it('a remember-me session falls back to the (configured) standard window', async () => {
      const { secret } = await newUser('offuser');
      const c = await login('offuser', secret, { remember: true });
      const s = await session(c);
      expect(s.stepUpScope).toBe('window');
      expect(Date.parse(s.stepUpValidUntil ?? '') - Date.parse(s.mfaAt ?? '')).toBe(5 * MIN);
      // Always fresh is min(standard window, 10 min) = 5 min.
      expect(s.alwaysFreshValidUntil).toBe(s.stepUpValidUntil);
      h.clock.advance(6 * MIN);
      expect((await privileged(c)).statusCode).toBe(403);
      expect((await alwaysFresh(c)).statusCode).toBe(403);
    });
  });

  describeIntegration('AUTH_STEP_UP_TRUSTED=60 (minutes)', () => {
    beforeAll(async () => {
      await start({ stepUp: { windowMs: 10 * MIN, longLived: { kind: 'window', ms: 60 * MIN } } });
    });
    afterAll(async () => {
      await h.stop();
    });

    it('a remember-me session gets a 60-minute window; a standard one keeps 10', async () => {
      const { secret } = await newUser('hour');
      const remembered = await login('hour', secret, { remember: true });
      const s = await session(remembered);
      expect(s.stepUpScope).toBe('window');
      expect(Date.parse(s.stepUpValidUntil ?? '') - Date.parse(s.mfaAt ?? '')).toBe(60 * MIN);
      h.clock.advance(30 * MIN);
      expect((await privileged(remembered)).statusCode).toBe(200);
      expect((await alwaysFresh(remembered)).statusCode).toBe(403);
      h.clock.advance(31 * MIN);
      expect((await privileged(remembered)).statusCode).toBe(403);

      const standard = await login('hour', secret);
      expect((await session(standard)).stepUpScope).toBe('window');
      await activeFor(standard, 11 * MIN);
      expect((await privileged(standard)).statusCode).toBe(403);
    });
  });
});
