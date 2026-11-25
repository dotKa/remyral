import { afterAll, beforeAll, expect, it } from 'vitest';
import { base32Encode } from '../../src/auth/totp.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

/**
 * Canary test (ADR-0009 "Verification", ADR-0006, T-SEC-1): a known password and a known TOTP secret go
 * through every auth flow with logging at `trace`; neither they nor any derived credential (TOTP codes,
 * recovery codes, session ids, CSRF tokens, otpauth URI) may appear in the captured logs or the audit log.
 */
const CANARY_PASSWORD = 'CANARY-pw-7f3a9c-do-not-log';
const CANARY_SECRET = Buffer.from('CANARY-totp-secret!!', 'utf8'); // 20 bytes
const CANARY_SECRET_B32 = base32Encode(CANARY_SECRET);

describeIntegration('secret canaries never reach logs (integration)', () => {
  let h: Harness;
  const forbidden = new Set<string>([CANARY_PASSWORD, CANARY_SECRET_B32, CANARY_SECRET.toString('hex')]);

  beforeAll(async () => {
    h = new Harness();
    await h.start({ totpSecretFactory: () => Buffer.from(CANARY_SECRET) });
    await h.createUser('birdwatch', CANARY_PASSWORD);

    const remember = (...values: (string | undefined)[]) => {
      for (const v of values) if (v) forbidden.add(v);
    };

    // Failed password attempt (password in body), including a wrong guess that embeds the canary.
    const c = h.client();
    await c.req('POST', '/auth/login', { username: 'birdwatch', password: `${CANARY_PASSWORD}-wrong` });
    remember(`${CANARY_PASSWORD}-wrong`);
    // Typo: password typed into the username field.
    await c.req('POST', '/auth/login', { username: CANARY_PASSWORD, password: 'x' });

    // Enrollment.
    const login = await c.req('POST', '/auth/login', { username: 'birdwatch', password: CANARY_PASSWORD });
    remember(c.session, login.json<{ csrfToken: string }>().csrfToken);
    const start = await c.req('POST', '/auth/totp/enroll/start');
    const { otpauthUri, secret } = start.json<{ otpauthUri: string; secret: string }>();
    expect(secret).toBe(CANARY_SECRET_B32);
    remember(otpauthUri);
    const wrongCode = h.code(secret, 5);
    await c.req('POST', '/auth/totp/enroll/confirm', { code: wrongCode });
    const code = h.code(secret);
    const confirm = await c.req('POST', '/auth/totp/enroll/confirm', { code });
    const { recoveryCodes, csrfToken } = confirm.json<{ recoveryCodes: string[]; csrfToken: string }>();
    remember(code, wrongCode, c.session, csrfToken, ...recoveryCodes);
    await c.req('POST', '/auth/logout');

    // Password + TOTP login, replay attempt, step-up, recovery login.
    h.clock.advance(30_000);
    const d = h.client();
    await d.req('POST', '/auth/login', { username: 'birdwatch', password: CANARY_PASSWORD });
    remember(d.session);
    const code2 = h.code(secret);
    await d.req('POST', '/auth/totp/verify', { code: code2 });
    remember(code2, d.session, d.cookies.get('__Host-ras-csrf'));
    await d.req('POST', '/auth/step-up', { code: code2 }); // replay → rejected
    h.clock.advance(30_000);
    const code3 = h.code(secret);
    await d.req('POST', '/auth/step-up', { code: code3 });
    remember(code3);
    await d.req('GET', '/auth/session');

    const e = h.client();
    await e.req('POST', '/auth/login', { username: 'birdwatch', password: CANARY_PASSWORD });
    remember(e.session);
    await e.req('POST', '/auth/recovery', { code: recoveryCodes[0] });
    remember(e.session);
    await e.req('POST', '/auth/logout-all');

    // Malformed bodies must not echo values either.
    await h
      .client()
      .req('POST', '/auth/login', { username: 'birdwatch', password: CANARY_PASSWORD, extra: 1 });
    await h.client().req('POST', '/auth/login', { username: ['x'], password: CANARY_PASSWORD });
  });
  afterAll(async () => {
    await h.stop();
  });

  it('captured at least the request logs (the capture works)', () => {
    expect(h.logs.entries.length).toBeGreaterThan(20);
    expect(h.logs.text).toContain('/auth/login');
  });

  it('logs contain no password, TOTP secret, code, recovery code, session id or CSRF token', () => {
    const text = h.logs.text;
    for (const value of forbidden) {
      // 6-digit codes may coincidentally match timestamps/ids; check them as JSON string values only.
      if (/^\d{6}$/.test(value)) expect(text).not.toContain(`"${value}"`);
      else {
        expect(text, 'a secret canary leaked into logs').not.toContain(value);
        expect(text.toLowerCase()).not.toContain(value.toLowerCase());
      }
    }
  });

  it('the audit log contains none of them either', async () => {
    const { rows } = await h.db.pool.query<{ dump: string }>(
      "SELECT coalesce(string_agg(a::text, '\n'), '') AS dump FROM audit_events a",
    );
    const dump = rows[0]?.dump ?? '';
    expect(dump).toContain('auth.login.totp');
    for (const value of forbidden) {
      if (/^\d{6}$/.test(value)) expect(dump).not.toContain(`"${value}"`);
      else expect(dump.toLowerCase()).not.toContain(value.toLowerCase());
    }
  });
});
