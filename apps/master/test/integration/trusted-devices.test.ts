import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog, verifyChain } from '../../src/audit/audit.js';
import { requireStepUp } from '../../src/auth/hooks.js';
import { DEVICE_COOKIE, MAX_TRUSTED_DEVICES } from '../../src/auth/trusted-devices.js';
import type { RoutePlugin } from '../../src/app.js';
import { resetUser } from '../../src/cli/admin.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, FAST_SCRYPT, Harness } from '../helpers/harness.js';

/**
 * p5-remember-device: "Trust this device for 30 days" (docs/design/p5-remember-device.md §4).
 * Each test uses its own user so the cases stay independent.
 */
const PW = 'violet-otter-harbor-42';
const NEW_PW = 'quartz-meadow-falcon-77';
const DAY = 24 * 60 * 60_000;
const UA_FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0';

const privileged: RoutePlugin = (app) => {
  app.post(
    '/test/privileged',
    { config: { authz: { action: 'api.docs' } }, preHandler: requireStepUp(undefined, h.clock.now) },
    () => ({ ok: true }),
  );
};

let h: Harness;

/** Logs in with password + TOTP; `trustDevice` asks for a device trust. Returns the browser. */
async function loginWithTotp(
  username: string,
  secret: string,
  opts: { trustDevice?: boolean; browser?: Client; ua?: string } = {},
): Promise<Client> {
  h.clock.advance(30_000);
  const c = opts.browser ?? h.client();
  const headers = opts.ua ? { 'user-agent': opts.ua } : {};
  const login = await c.req('POST', '/auth/login', { username, password: PW }, headers);
  expect(login.statusCode, login.body).toBe(200);
  expect(login.json<{ status: string }>().status).toBe('mfa_required');
  const verify = await c.req(
    'POST',
    '/auth/totp/verify',
    { code: h.code(secret), ...(opts.trustDevice === undefined ? {} : { trustDevice: opts.trustDevice }) },
    headers,
  );
  expect(verify.statusCode, verify.body).toBe(200);
  return c;
}

/** A new browser that only holds the device cookie of `from` (the session cookies are gone). */
function deviceOnly(from: Client): Client {
  const c = h.client();
  const token = from.cookies.get(DEVICE_COOKIE);
  if (token) c.cookies.set(DEVICE_COOKIE, token);
  return c;
}

async function passwordLogin(c: Client, username: string, password = PW) {
  h.clock.advance(1_000);
  return c.req('POST', '/auth/login', { username, password });
}

async function deviceCount(userId: string): Promise<number> {
  const { rows } = await h.db.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM trusted_devices WHERE user_id = $1',
    [userId],
  );
  return rows[0]?.n ?? 0;
}

async function auditRows(action: string, userId: string) {
  const { rows } = await h.db.pool.query<{
    outcome: string;
    target: string | null;
    metadata: Record<string, unknown>;
  }>('SELECT outcome, target, metadata FROM audit_events WHERE action = $1 AND actor_id = $2 ORDER BY id', [
    action,
    userId,
  ]);
  return rows;
}

async function newUser(name: string, role: 'owner' | 'admin' | 'operator' | 'viewer' = 'owner') {
  const id = await h.createUser(name, PW, role);
  const { secret } = await enroll(h, name, PW);
  return { id, secret };
}

describeIntegration('trusted devices (integration, p5-remember-device)', () => {
  beforeAll(async () => {
    h = new Harness();
    await h.start({ extraRoutes: [privileged] });
  });
  afterAll(async () => {
    await h.stop();
  });

  it('issues a hashed device cookie and skips the code step on the next login, rotating the token', async () => {
    const { id, secret } = await newUser('trusty');
    const first = await loginWithTotp('trusty', secret, { trustDevice: true, ua: UA_FIREFOX_MAC });
    const token = first.cookies.get(DEVICE_COOKIE);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const { rows } = await h.db.pool.query<{
      token_hash: Buffer;
      label: string;
      created_ip: string;
      expires_at: Date;
    }>('SELECT token_hash, label, created_ip, expires_at FROM trusted_devices WHERE user_id = $1', [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Firefox on macOS');
    expect(rows[0]?.created_ip).toBe('198.51.100.10');
    expect(rows[0]?.token_hash.toString('base64url')).not.toBe(token);
    const createdExpiry = rows[0]?.expires_at.getTime();

    const next = deviceOnly(first);
    const login = await passwordLogin(next, 'trusty');
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json()).toMatchObject({ status: 'authenticated', user: { username: 'trusty' } });
    const cookie = login.cookies.find((c) => c.name === DEVICE_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(cookie?.value).not.toBe(token);
    expect((await next.req('GET', '/auth/session')).statusCode).toBe(200);

    // Expiry is fixed at creation (use never extends it).
    const after = await h.db.pool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM trusted_devices WHERE user_id = $1',
      [id],
    );
    expect(after.rows[0]?.expires_at.getTime()).toBe(createdExpiry);

    const used = await auditRows('auth.login.trusted_device', id);
    expect(used.at(-1)).toMatchObject({ outcome: 'success' });
    expect(await auditRows('auth.trusted_device.create', id)).toHaveLength(1);
  });

  it('does not issue a device trust without the opt-in', async () => {
    const { id, secret } = await newUser('optout');
    const c = await loginWithTotp('optout', secret);
    expect(c.cookies.has(DEVICE_COOKIE)).toBe(false);
    expect(await deviceCount(id)).toBe(0);
  });

  it('rejects the rotated-away value and treats its reuse as theft (trust withdrawn)', async () => {
    const { id, secret } = await newUser('rotator');
    const first = await loginWithTotp('rotator', secret, { trustDevice: true });
    const stolen = deviceOnly(first); // a copy of the cookie taken before the next use
    const legit = deviceOnly(first);
    expect((await passwordLogin(legit, 'rotator')).json<{ status: string }>().status).toBe('authenticated');

    const replay = await passwordLogin(stolen, 'rotator');
    expect(replay.json<{ status: string }>().status).toBe('mfa_required');
    expect(replay.cookies.find((c) => c.name === DEVICE_COOKIE)?.value).toBe('');
    expect(await deviceCount(id)).toBe(0);
    const fails = await auditRows('auth.login.trusted_device', id);
    expect(fails.at(-1)).toMatchObject({ outcome: 'failure', metadata: { reason: 'reused', revoked: true } });

    // The legitimate holder now needs the code again.
    expect((await passwordLogin(deviceOnly(legit), 'rotator')).json<{ status: string }>().status).toBe(
      'mfa_required',
    );
  });

  it("ignores another user's token and does not delete it", async () => {
    const a = await newUser('owner.a');
    const b = await newUser('owner.b');
    const browser = await loginWithTotp('owner.a', a.secret, { trustDevice: true });
    const shared = deviceOnly(browser);
    const login = await passwordLogin(shared, 'owner.b');
    expect(login.json<{ status: string }>().status).toBe('mfa_required');
    expect(login.cookies.find((c) => c.name === DEVICE_COOKIE)).toBeUndefined();
    expect(await deviceCount(a.id)).toBe(1);
    expect((await auditRows('auth.login.trusted_device', b.id)).at(-1)).toMatchObject({
      outcome: 'failure',
      metadata: { reason: 'other_user' },
    });
    // A still skips the code on that browser.
    expect((await passwordLogin(shared, 'owner.a')).json<{ status: string }>().status).toBe('authenticated');
  });

  it('ignores an expired token (and removes it)', async () => {
    const { id, secret } = await newUser('expiring');
    const browser = await loginWithTotp('expiring', secret, { trustDevice: true });
    h.clock.advance(30 * DAY + 1_000);
    const login = await passwordLogin(deviceOnly(browser), 'expiring');
    expect(login.json<{ status: string }>().status).toBe('mfa_required');
    expect(await deviceCount(id)).toBe(0);
    expect((await auditRows('auth.login.trusted_device', id)).at(-1)?.metadata.reason).toBe('expired');
  });

  it('ignores unknown and malformed tokens', async () => {
    const { id } = await newUser('stranger');
    for (const value of ['A'.repeat(43), 'not-a-token']) {
      const c = h.client();
      c.cookies.set(DEVICE_COOKIE, value);
      expect((await passwordLogin(c, 'stranger')).json<{ status: string }>().status).toBe('mfa_required');
    }
    const fails = await auditRows('auth.login.trusted_device', id);
    expect(fails.map((r) => r.metadata.reason)).toEqual(['unknown']); // malformed: not even looked up
  });

  it('a wrong password with a valid device token still fails generically', async () => {
    const { secret } = await newUser('wrongpw');
    const browser = deviceOnly(await loginWithTotp('wrongpw', secret, { trustDevice: true }));
    const res = await passwordLogin(browser, 'wrongpw', 'definitely-not-it-1234');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials', message: 'Invalid credentials.' });
  });

  it('never satisfies step-up: privileged actions still require a fresh TOTP', async () => {
    const { secret } = await newUser('stepper');
    const browser = deviceOnly(await loginWithTotp('stepper', secret, { trustDevice: true }));
    h.clock.advance(30_000);
    expect((await passwordLogin(browser, 'stepper')).json<{ status: string }>().status).toBe('authenticated');
    const session = await browser.req('GET', '/auth/session');
    expect(session.json<{ session: { mfaAt: string | null } }>().session.mfaAt).toBeNull();
    const denied = await browser.req('POST', '/test/privileged');
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: string }>().error).toBe('step_up_required');
    h.clock.advance(30_000);
    expect((await browser.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    expect((await browser.req('POST', '/test/privileged')).statusCode).toBe(200);
  });

  it('is revoked by revoking it (one / all) from Settings, own devices only', async () => {
    const a = await newUser('lister');
    const other = await newUser('lister.other');
    const b1 = await loginWithTotp('lister', a.secret, { trustDevice: true });
    const b2 = await loginWithTotp('lister', a.secret, { trustDevice: true, ua: UA_FIREFOX_MAC });
    const o1 = await loginWithTotp('lister.other', other.secret, { trustDevice: true });

    const list = await b2.req('GET', '/auth/devices');
    expect(list.statusCode).toBe(200);
    const devices = list.json<{
      devices: { id: string; label: string; current: boolean; createdIp: string }[];
    }>().devices;
    expect(devices).toHaveLength(2);
    expect(devices.filter((d) => d.current).map((d) => d.label)).toEqual(['Firefox on macOS']);
    expect(JSON.stringify(list.json())).not.toContain(b2.cookies.get(DEVICE_COOKIE));

    // Another user's device id → 404 (no existence oracle), and it stays.
    const otherId = (await o1.req('GET', '/auth/devices')).json<{ devices: { id: string }[] }>().devices[0]
      ?.id;
    const cross = await b2.req('DELETE', `/auth/devices/${otherId ?? 'x'}`);
    expect(cross.statusCode).toBe(404);
    expect((await b2.req('DELETE', '/auth/devices/not-a-uuid')).statusCode).toBe(404);
    expect(await deviceCount(other.id)).toBe(1);

    // Revoke the current one: the cookie is cleared and the next login asks for the code.
    const current = devices.find((d) => d.current);
    const del = await b2.req('DELETE', `/auth/devices/${current?.id ?? 'x'}`);
    expect(del.statusCode, del.body).toBe(200);
    expect(b2.cookies.has(DEVICE_COOKIE)).toBe(false);
    expect((await auditRows('auth.trusted_device.revoke', a.id)).at(-1)).toMatchObject({
      outcome: 'success',
      metadata: { reason: 'user', current: true },
    });

    // b1's trust is still there; revoke-all removes it.
    const b1Device = deviceOnly(b1);
    const all = await b2.req('POST', '/auth/devices/revoke-all');
    expect(all.json()).toEqual({ status: 'revoked', revoked: 1 });
    expect((await passwordLogin(b1Device, 'lister')).json<{ status: string }>().status).toBe('mfa_required');
    expect((await auditRows('auth.trusted_device.revoke', a.id)).at(-1)?.metadata).toEqual({
      reason: 'user_all',
      devices: 1,
    });
    expect(await deviceCount(other.id)).toBe(1);
  });

  it('the device routes need CSRF and a full session', async () => {
    const { secret } = await newUser('csrfdev');
    const c = await loginWithTotp('csrfdev', secret, { trustDevice: true });
    c.sendCsrf = false;
    expect((await c.req('POST', '/auth/devices/revoke-all')).statusCode).toBe(403);
    expect((await h.client().req('GET', '/auth/devices')).statusCode).toBe(401);
  });

  it('is revoked by a password change', async () => {
    const { id, secret } = await newUser('pwchanger');
    const browser = await loginWithTotp('pwchanger', secret, { trustDevice: true });
    const device = deviceOnly(browser);
    h.clock.advance(30_000);
    expect((await browser.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    const change = await browser.req('POST', '/auth/password', { currentPassword: PW, newPassword: NEW_PW });
    expect(change.statusCode, change.body).toBe(200);
    expect(await deviceCount(id)).toBe(0);
    expect((await auditRows('auth.trusted_device.revoke', id)).at(-1)?.metadata).toEqual({
      reason: 'password_change',
      devices: 1,
    });
    const login = await passwordLogin(device, 'pwchanger', NEW_PW);
    expect(login.json<{ status: string }>().status).toBe('mfa_required');
  });

  it('is revoked by "log out everywhere" (cookie cleared), but not by a plain logout', async () => {
    const { id, secret } = await newUser('everywhere');
    const browser = await loginWithTotp('everywhere', secret, { trustDevice: true });
    await browser.req('POST', '/auth/logout');
    expect(browser.cookies.has(DEVICE_COOKIE)).toBe(true);
    expect((await passwordLogin(browser, 'everywhere')).json<{ status: string }>().status).toBe(
      'authenticated',
    );
    const out = await browser.req('POST', '/auth/logout-all');
    expect(out.statusCode).toBe(200);
    expect(browser.cookies.has(DEVICE_COOKIE)).toBe(false);
    expect(await deviceCount(id)).toBe(0);
    expect((await auditRows('auth.trusted_device.revoke', id)).at(-1)?.metadata.reason).toBe('logout_all');
  });

  it('is revoked by an MFA reset (admin:reset --reset-mfa); the epoch check also guards re-enrollment', async () => {
    const { id, secret } = await newUser('resetme');
    const browser = deviceOnly(await loginWithTotp('resetme', secret, { trustDevice: true }));
    await resetUser(
      { pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), passwordParams: FAST_SCRYPT },
      { username: 'resetme', resetMfa: true, unlock: false },
    );
    expect(await deviceCount(id)).toBe(0);
    const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = 'auth.trusted_device.revoke' AND target = $1",
      [`user:${id}`],
    );
    expect(rows.at(-1)?.metadata).toEqual({ reason: 'admin_reset', devices: 1 });
    // After the reset the account must enroll again — never skipped.
    expect((await passwordLogin(browser, 'resetme')).json<{ status: string }>().status).toBe(
      'enrollment_required',
    );
  });

  it('a trust from before a re-enrollment is refused even if its row survived (epoch check)', async () => {
    const { id, secret } = await newUser('epoch');
    const browser = deviceOnly(await loginWithTotp('epoch', secret, { trustDevice: true }));
    // Simulate a re-enrollment that bypassed the reset path.
    await h.db.pool.query(
      "UPDATE users SET totp_enrolled_at = totp_enrolled_at + interval '1 second' WHERE id = $1",
      [id],
    );
    expect((await passwordLogin(browser, 'epoch')).json<{ status: string }>().status).toBe('mfa_required');
    expect((await auditRows('auth.login.trusted_device', id)).at(-1)?.metadata.reason).toBe('mfa_reset');
    expect(await deviceCount(id)).toBe(0);
  });

  it('is revoked by account disable and by a role elevation (not by a demotion)', async () => {
    const owner = await newUser('boss');
    const ownerBrowser = await loginWithTotp('boss', owner.secret);
    h.clock.advance(30_000);
    expect((await ownerBrowser.req('POST', '/auth/step-up', { code: h.code(owner.secret) })).statusCode).toBe(
      200,
    );

    const v = await newUser('climber', 'viewer');
    await loginWithTotp('climber', v.secret, { trustDevice: true });
    const down = await ownerBrowser.req('PUT', `/users/${v.id}/role`, { role: 'viewer' });
    expect(down.statusCode).toBe(200); // no change
    const up = await ownerBrowser.req('PUT', `/users/${v.id}/role`, { role: 'operator' });
    expect(up.statusCode, up.body).toBe(200);
    expect(await deviceCount(v.id)).toBe(0);
    const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = 'user.role.change' AND target = $1 ORDER BY id",
      [`user:${v.id}`],
    );
    expect(rows.at(-1)?.metadata).toMatchObject({ revokedDevices: 1 });

    await loginWithTotp('climber', v.secret, { trustDevice: true });
    const demote = await ownerBrowser.req('PUT', `/users/${v.id}/role`, { role: 'viewer' });
    expect(demote.statusCode).toBe(200);
    expect(await deviceCount(v.id)).toBe(1);

    const disable = await ownerBrowser.req('POST', `/users/${v.id}/disable`);
    expect(disable.statusCode, disable.body).toBe(200);
    expect(await deviceCount(v.id)).toBe(0);
    const revokes = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = 'auth.trusted_device.revoke' AND target = $1 ORDER BY id",
      [`user:${v.id}`],
    );
    expect(revokes.rows.map((r) => r.metadata.reason)).toEqual(['role_elevation', 'disabled']);
  });

  it('never skips the code for an account that must replace a temporary password', async () => {
    const { id, secret } = await newUser('temporary');
    const browser = deviceOnly(await loginWithTotp('temporary', secret, { trustDevice: true }));
    await h.db.pool.query('UPDATE users SET password_change_required = true WHERE id = $1', [id]);
    expect((await passwordLogin(browser, 'temporary')).json<{ status: string }>().status).toBe(
      'mfa_required',
    );
    expect((await auditRows('auth.login.trusted_device', id)).at(-1)?.metadata.reason).toBe(
      'password_change',
    );

    // And no trust is issued while the stage is password_change.
    h.clock.advance(30_000);
    const verify = await browser.req('POST', '/auth/totp/verify', {
      code: h.code(secret),
      trustDevice: true,
    });
    expect(verify.json<{ status: string }>().status).toBe('password_change_required');
    expect(await deviceCount(id)).toBe(1); // only the earlier one
  });

  it('can be granted from the recovery-code step', async () => {
    const id = await h.createUser('recoverer', PW);
    const { recoveryCodes } = await enroll(h, 'recoverer', PW);
    const c = h.client();
    await passwordLogin(c, 'recoverer');
    const res = await c.req('POST', '/auth/recovery', { code: recoveryCodes[0], trustDevice: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(c.cookies.has(DEVICE_COOKIE)).toBe(true);
    expect(await deviceCount(id)).toBe(1);
  });

  it(`keeps at most ${String(MAX_TRUSTED_DEVICES)} devices per user, evicting the oldest`, async () => {
    const { id, secret } = await newUser('collector');
    const browsers: Client[] = [];
    for (let i = 0; i < MAX_TRUSTED_DEVICES + 2; i++) {
      browsers.push(deviceOnly(await loginWithTotp('collector', secret, { trustDevice: true })));
    }
    expect(await deviceCount(id)).toBe(MAX_TRUSTED_DEVICES);
    // The two oldest are gone, the newest works.
    expect((await passwordLogin(browsers[0] as Client, 'collector')).json<{ status: string }>().status).toBe(
      'mfa_required',
    );
    expect((await passwordLogin(browsers[1] as Client, 'collector')).json<{ status: string }>().status).toBe(
      'mfa_required',
    );
    expect(
      (await passwordLogin(browsers.at(-1) as Client, 'collector')).json<{ status: string }>().status,
    ).toBe('authenticated');
    const evictions = (await auditRows('auth.trusted_device.revoke', id)).filter(
      (r) => r.metadata.reason === 'evicted',
    );
    expect(evictions).toHaveLength(2);
  });

  it('never writes device tokens to logs or the audit log; the audit chain stays valid', async () => {
    const { secret } = await newUser('canary.dev');
    const browser = await loginWithTotp('canary.dev', secret, { trustDevice: true });
    const t1 = browser.cookies.get(DEVICE_COOKIE) ?? 'missing';
    const next = deviceOnly(browser);
    await passwordLogin(next, 'canary.dev');
    const t2 = next.cookies.get(DEVICE_COOKIE) ?? 'missing';
    const logs = h.logs.text;
    const { rows } = await h.db.pool.query<{ t: string }>(
      'SELECT row_to_json(a)::text AS t FROM audit_events a',
    );
    const audit = rows.map((r) => r.t).join('\n');
    for (const t of [t1, t2]) {
      expect(logs).not.toContain(t);
      expect(audit).not.toContain(t);
    }
    expect((await verifyChain(h.db.pool)).ok).toBe(true);
  });
});

describeIntegration('trusted devices disabled (AUTH_TRUSTED_DEVICE_DAYS=0)', () => {
  let d: Harness;
  beforeAll(async () => {
    d = new Harness();
    await d.start({ loginPersistence: { trustedDeviceMs: null, remember: null } });
  });
  afterAll(async () => {
    await d.stop();
  });

  it('issues no trust, ignores presented tokens and reports the feature as off', async () => {
    const options = await d.client().req('GET', '/auth/options');
    expect(options.json()).toEqual({ rememberMe: null, trustedDevice: null });
    await d.createUser('nodevice', PW);
    const { secret } = await enroll(d, 'nodevice', PW);
    d.clock.advance(30_000);
    const c = d.client();
    await c.req('POST', '/auth/login', { username: 'nodevice', password: PW, remember: true });
    const v = await c.req('POST', '/auth/totp/verify', { code: d.code(secret), trustDevice: true });
    expect(v.statusCode).toBe(200);
    expect(c.cookies.has(DEVICE_COOKIE)).toBe(false);
    const s = await c.req('GET', '/auth/session');
    expect(s.json<{ session: { type: string } }>().session.type).toBe('standard');
  });
});
