import { afterAll, beforeAll, expect, it } from 'vitest';
import { verifyChain } from '../../src/audit/audit.js';
import { requireStepUp } from '../../src/auth/hooks.js';
import type { RoutePlugin } from '../../src/app.js';
import { describeIntegration } from '../helpers/env.js';
import { enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'violet-otter-harbor-42';
const GENERIC = { error: 'invalid_credentials', message: 'Invalid credentials.' };

// A privileged test-only route guarded by requireStepUp(10 min).
const privileged: RoutePlugin = (app) => {
  app.post(
    '/test/privileged',
    { config: { authz: { action: 'api.docs' } }, preHandler: requireStepUp(undefined, h.clock.now) },
    () => ({ ok: true }),
  );
};

let h: Harness;

describeIntegration('auth flows (integration, ADR-0009)', () => {
  beforeAll(async () => {
    h = new Harness();
    await h.start({ extraRoutes: [privileged] });
  });
  afterAll(async () => {
    await h.stop();
  });

  it('forces TOTP enrollment after the first password login and issues 10 recovery codes once', async () => {
    await h.createUser('enrolee', PW);
    const c = h.client();
    const login = await c.req('POST', '/auth/login', { username: 'enrolee', password: PW });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ status: 'enrollment_required' });
    const cookie = login.cookies.find((x) => x.name === '__Host-ras');
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });

    // Only enrollment is reachable in this state.
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(401);
    expect((await c.req('POST', '/auth/totp/verify', { code: '000000' })).statusCode).toBe(401);

    const start = await c.req('POST', '/auth/totp/enroll/start');
    expect(start.statusCode).toBe(200);
    const body = start.json<{ otpauthUri: string; secret: string; qrSvg: string }>();
    expect(body.otpauthUri).toBe(`otpauth://totp/Remyral:enrolee?secret=${body.secret}&issuer=Remyral`);
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.qrSvg.startsWith('<svg')).toBe(true);
    expect(body.qrSvg).not.toMatch(/<script|style=/i);

    const bad = await c.req('POST', '/auth/totp/enroll/confirm', { code: '000000' });
    expect(bad.statusCode).toBe(401);
    const ok = await c.req('POST', '/auth/totp/enroll/confirm', { code: h.code(body.secret) });
    expect(ok.statusCode).toBe(200);
    const confirmed = ok.json<{ recoveryCodes: string[]; user: { username: string } }>();
    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(new Set(confirmed.recoveryCodes).size).toBe(10);
    expect(confirmed.user.username).toBe('enrolee');

    const session = await c.req('GET', '/auth/session');
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ user: { username: 'enrolee', role: 'owner' } });

    // Enrollment cannot be repeated from a full session.
    expect((await c.req('POST', '/auth/totp/enroll/start')).statusCode).toBe(401);
    const { rows } = await h.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM recovery_codes r JOIN users u ON u.id = r.user_id WHERE u.username = 'enrolee'",
    );
    expect(rows[0]?.n).toBe(10);
  });

  it('logs in with password + TOTP and rotates the session id', async () => {
    await h.createUser('alice', PW);
    const { secret } = await enroll(h, 'alice', PW);
    h.clock.advance(30_000);
    const c = h.client();
    const login = await c.req('POST', '/auth/login', { username: 'alice', password: PW });
    expect(login.json()).toMatchObject({ status: 'mfa_required' });
    const pendingId = c.session;
    const pendingCopy = c.clone();

    expect((await c.req('GET', '/auth/session')).statusCode).toBe(401); // password alone is not enough
    const verify = await c.req('POST', '/auth/totp/verify', { code: h.code(secret) });
    expect(verify.statusCode).toBe(200);
    expect(c.session).toBeDefined();
    expect(c.session).not.toBe(pendingId);
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(200);
    // The pending id is dead after rotation.
    expect((await pendingCopy.req('POST', '/auth/totp/verify', { code: h.code(secret, 1) })).statusCode).toBe(
      401,
    );
  });

  it('rejects a replayed TOTP code and accepts ±1 step of clock skew', async () => {
    await h.createUser('bob', PW);
    const { secret } = await enroll(h, 'bob', PW);
    h.clock.advance(30_000);
    const code = h.code(secret);
    const a = h.client();
    await a.req('POST', '/auth/login', { username: 'bob', password: PW });
    expect((await a.req('POST', '/auth/totp/verify', { code })).statusCode).toBe(200);

    const b = h.client();
    await b.req('POST', '/auth/login', { username: 'bob', password: PW });
    const replay = await b.req('POST', '/auth/totp/verify', { code });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual(GENERIC);

    h.clock.advance(90_000);
    const skew = await b.req('POST', '/auth/totp/verify', { code: h.code(secret, -1) });
    expect(skew.statusCode).toBe(200);
  });

  it('uses one generic error for unknown user, bad password and bad TOTP', async () => {
    await h.createUser('carol', PW);
    const { secret } = await enroll(h, 'carol', PW);
    const unknown = await h.client().req('POST', '/auth/login', { username: 'nobody', password: PW });
    const badPw = await h.client().req('POST', '/auth/login', { username: 'carol', password: `${PW}x` });
    h.clock.advance(30_000);
    const c = h.client();
    await c.req('POST', '/auth/login', { username: 'carol', password: PW });
    const badTotp = await c.req('POST', '/auth/totp/verify', { code: h.code(secret, 5) });
    for (const r of [unknown, badPw, badTotp]) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual(GENERIC);
    }
  });

  it('locks the account with exponential backoff after repeated failures', async () => {
    await h.createUser('dave', PW);
    const { secret } = await enroll(h, 'dave', PW);
    for (let i = 0; i < 5; i++) {
      expect(
        (await h.client().req('POST', '/auth/login', { username: 'dave', password: 'wrong-password-xx' }))
          .statusCode,
      ).toBe(401);
    }
    const locked = await h.db.pool.query<{ failed_attempts: number; locked_until: Date }>(
      "SELECT failed_attempts, locked_until FROM users WHERE username = 'dave'",
    );
    expect(locked.rows[0]?.failed_attempts).toBe(5);
    expect(locked.rows[0]?.locked_until.getTime()).toBe(h.clock.now().getTime() + 30_000);

    // Correct password is refused while locked, with the same generic error.
    const during = await h.client().req('POST', '/auth/login', { username: 'dave', password: PW });
    expect(during.statusCode).toBe(401);
    expect(during.json()).toEqual(GENERIC);

    // After the lock expires, one more failure doubles the lock.
    h.clock.advance(31_000);
    await h.client().req('POST', '/auth/login', { username: 'dave', password: 'wrong-password-xx' });
    const second = await h.db.pool.query<{ locked_until: Date }>(
      "SELECT locked_until FROM users WHERE username = 'dave'",
    );
    expect(second.rows[0]?.locked_until.getTime()).toBe(h.clock.now().getTime() + 60_000);

    h.clock.advance(61_000);
    const c = await fullLogin(h, 'dave', PW, secret); // success resets the counter
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(200);
    const reset = await h.db.pool.query<{ failed_attempts: number }>(
      "SELECT failed_attempts FROM users WHERE username = 'dave'",
    );
    expect(reset.rows[0]?.failed_attempts).toBe(0);

    const { rows } = await h.db.pool.query("SELECT 1 FROM audit_events WHERE action = 'auth.lockout'");
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('destroys a pending session after 5 wrong second-factor codes', async () => {
    await h.createUser('erin', PW);
    const { secret } = await enroll(h, 'erin', PW);
    h.clock.advance(30_000);
    const c = h.client();
    await c.req('POST', '/auth/login', { username: 'erin', password: PW });
    for (let i = 0; i < 5; i++) await c.req('POST', '/auth/totp/verify', { code: h.code(secret, 7) });
    // Session gone (and the account is now locked), so even the right code fails.
    expect((await c.req('POST', '/auth/totp/verify', { code: h.code(secret) })).statusCode).toBe(401);
    await h.db.pool.query(
      "UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = 'erin'",
    );
  });

  it('accepts each recovery code exactly once and keeps step-up unsatisfied', async () => {
    await h.createUser('frank', PW);
    const { recoveryCodes } = await enroll(h, 'frank', PW);
    const code = recoveryCodes[0] ?? '';
    const a = h.client();
    await a.req('POST', '/auth/login', { username: 'frank', password: PW });
    const ok = await a.req('POST', '/auth/recovery', { code: code.toUpperCase() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ remainingRecoveryCodes: 9 });
    expect((await a.req('POST', '/test/privileged')).statusCode).toBe(403); // no fresh TOTP

    const b = h.client();
    await b.req('POST', '/auth/login', { username: 'frank', password: PW });
    const reuse = await b.req('POST', '/auth/recovery', { code });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toEqual(GENERIC);
  });

  it('requires a TOTP step-up within 10 minutes for privileged routes', async () => {
    await h.createUser('grace', PW);
    const { secret } = await enroll(h, 'grace', PW);
    const c = await fullLogin(h, 'grace', PW, secret);
    expect((await c.req('POST', '/test/privileged')).statusCode).toBe(200); // login TOTP counts
    h.clock.advance(10 * 60_000 + 1000);
    // keep the session alive (idle timeout is 30 min) but step-up has expired
    const denied = await c.req('POST', '/test/privileged');
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'step_up_required' });
    const wrong = await c.req('POST', '/auth/step-up', { code: '123' });
    expect(wrong.statusCode).toBe(401);
    const up = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(up.statusCode).toBe(200);
    expect((await c.req('POST', '/test/privileged')).statusCode).toBe(200);
    const s = await c.req('GET', '/auth/session');
    expect(
      s.json<{ session: { stepUpValidUntil: string | null } }>().session.stepUpValidUntil,
    ).not.toBeNull();
  });

  it('enforces the 30-minute idle and 12-hour absolute session lifetimes', async () => {
    await h.createUser('heidi', PW);
    const { secret } = await enroll(h, 'heidi', PW);
    const idle = await fullLogin(h, 'heidi', PW, secret);
    h.clock.advance(29 * 60_000);
    expect((await idle.req('GET', '/auth/session')).statusCode).toBe(200); // touches last_seen
    h.clock.advance(29 * 60_000);
    expect((await idle.req('GET', '/auth/session')).statusCode).toBe(200);
    h.clock.advance(31 * 60_000);
    expect((await idle.req('GET', '/auth/session')).statusCode).toBe(401);

    const abs = await fullLogin(h, 'heidi', PW, secret);
    for (let i = 0; i < 24; i++) {
      h.clock.advance(29 * 60_000);
      expect((await abs.req('GET', '/auth/session')).statusCode).toBe(200); // 24 × 29 min = 11.6 h
    }
    h.clock.advance(29 * 60_000);
    expect((await abs.req('GET', '/auth/session')).statusCode).toBe(401); // 12.1 h > 12 h absolute
  });

  it('expires pending login state after 5 minutes', async () => {
    await h.createUser('ivan', PW);
    const { secret } = await enroll(h, 'ivan', PW);
    h.clock.advance(30_000);
    const c = h.client();
    await c.req('POST', '/auth/login', { username: 'ivan', password: PW });
    h.clock.advance(5 * 60_000 + 1000);
    expect((await c.req('POST', '/auth/totp/verify', { code: h.code(secret) })).statusCode).toBe(401);
  });

  it('requires the CSRF double-submit token on state-changing requests', async () => {
    await h.createUser('judy', PW);
    const { secret } = await enroll(h, 'judy', PW);
    const c = await fullLogin(h, 'judy', PW, secret);
    c.sendCsrf = false;
    const missing = await c.req('POST', '/auth/logout');
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ error: 'csrf_failed' });
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(200); // safe methods need no token

    const forged = c.clone();
    forged.cookies.set('__Host-ras-csrf', 'A'.repeat(43));
    forged.sendCsrf = true;
    expect((await forged.req('POST', '/auth/logout')).statusCode).toBe(403);

    c.sendCsrf = true;
    expect((await c.req('POST', '/auth/logout')).statusCode).toBe(200);
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(401);
  });

  it('logs out everywhere', async () => {
    await h.createUser('kim', PW);
    const { secret } = await enroll(h, 'kim', PW);
    const a = await fullLogin(h, 'kim', PW, secret);
    const b = await fullLogin(h, 'kim', PW, secret);
    const res = await a.req('POST', '/auth/logout-all');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ revokedSessions: number }>().revokedSessions).toBeGreaterThanOrEqual(3);
    expect((await a.req('GET', '/auth/session')).statusCode).toBe(401);
    expect((await b.req('GET', '/auth/session')).statusCode).toBe(401);
  });

  it('serves the OpenAPI document publicly (p16-api-tokens: schemas only, no data) and to sessions alike', async () => {
    const anonymous = await h.client().req('GET', '/openapi.json');
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.headers['set-cookie']).toBeUndefined();
    await h.createUser('lena', PW);
    const { secret } = await enroll(h, 'lena', PW);
    const c = await fullLogin(h, 'lena', PW, secret);
    const doc = await c.req('GET', '/openapi.json');
    expect(doc.statusCode).toBe(200);
    const spec = doc.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/auth/login', '/auth/totp/verify', '/healthz']),
    );
  });

  it('stores only hashed session ids and encrypted TOTP secrets', async () => {
    await h.createUser('mallory', PW);
    const { client, secret } = await enroll(h, 'mallory', PW);
    const { rows } = await h.db.pool.query<{ dump: string }>(
      `SELECT (SELECT string_agg(t::text, ' ') FROM users t) || (SELECT string_agg(s::text, ' ') FROM sessions s) AS dump`,
    );
    const dump = rows[0]?.dump ?? '';
    expect(dump).not.toContain(client.session ?? 'x');
    expect(dump).not.toContain(Buffer.from(client.session ?? 'x').toString('hex'));
    expect(dump).not.toContain(secret);
    const raw = await h.db.pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE username = 'mallory'",
    );
    expect(raw.rows[0]?.password_hash).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$/);
  });

  it('audits every auth event in a valid hash chain', async () => {
    const { rows } = await h.db.pool.query<{ action: string }>('SELECT DISTINCT action FROM audit_events');
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'user.create',
        'auth.login.password',
        'auth.login.totp',
        'auth.login.recovery',
        'auth.totp.enroll.start',
        'auth.totp.enroll.confirm',
        'auth.step_up',
        'auth.logout',
        'auth.logout_all',
        'auth.lockout',
        'auth.csrf',
      ]),
    );
    expect(await verifyChain(h.db.pool)).toMatchObject({ ok: true });
  });
});

describeIntegration('auth rate limits (integration)', () => {
  let r: Harness;
  beforeAll(async () => {
    r = new Harness();
    await r.start({ rateLimits: { perIp: 4, perAccount: 3, windowMs: 60_000 } });
  });
  afterAll(async () => {
    await r.stop();
  });

  it('limits attempts per account and per IP with 429 + Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await r.client(`192.0.2.${String(i + 1)}`).req('POST', '/auth/login', {
        username: 'target',
        password: 'whatever-password',
      });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    }
    expect(statuses).toEqual([401, 401, 401, 429]); // per-account limit, across different IPs

    const ip = r.client('192.0.2.200');
    const perIp: number[] = [];
    for (let i = 0; i < 5; i++) {
      perIp.push(
        (await ip.req('POST', '/auth/login', { username: `user${String(i)}x`, password: 'pw-pw-pw-pw-pw' }))
          .statusCode,
      );
    }
    expect(perIp).toEqual([401, 401, 401, 401, 429]);
    const { rows } = await r.db.pool.query("SELECT 1 FROM audit_events WHERE action = 'auth.rate_limited'");
    expect(rows.length).toBe(2);
  });
});
