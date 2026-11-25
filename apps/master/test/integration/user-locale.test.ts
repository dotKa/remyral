import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p14-i18n-foundation (ADR-0053): the console language per user. Migration 0101 adds `users.locale` (NULL = never
 * chosen, CHECK tr/en); `GET /auth/session` returns the effective language (Turkish by default);
 * `PUT /me/locale` stores the caller's own choice — any role, full session + CSRF, strict body, audited on change.
 */
const PW = 'lingua-franca-Passw0rd-long';

describeIntegration('user locale (integration)', () => {
  let h: Harness;
  let viewer: Client;
  let viewerId: string;
  let other: Client;

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    viewerId = await h.createUser('locale-viewer', PW, 'viewer');
    const a = await enroll(h, 'locale-viewer', PW);
    viewer = await fullLogin(h, 'locale-viewer', PW, a.secret);
    await h.createUser('locale-other', PW, 'operator');
    const b = await enroll(h, 'locale-other', PW);
    other = await fullLogin(h, 'locale-other', PW, b.secret);
  });
  afterAll(async () => {
    await h.stop();
  });

  it('migration 0101: nullable column, only tr / en accepted', async () => {
    const { rows } = await h.db.pool.query<{ is_nullable: string; data_type: string }>(
      "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'locale'",
    );
    expect(rows).toEqual([{ is_nullable: 'YES', data_type: 'text' }]);
    const before = await h.db.pool.query<{ locale: string | null }>(
      'SELECT locale FROM users WHERE id = $1',
      [viewerId],
    );
    expect(before.rows[0]?.locale).toBeNull();
    await expect(h.db.pool.query("UPDATE users SET locale = 'de' WHERE id = $1", [viewerId])).rejects.toThrow(
      /check constraint/i,
    );
  });

  it('the session says Turkish until the user chooses', async () => {
    const res = await viewer.req('GET', '/auth/session');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ locale: string }>().locale).toBe('tr');
  });

  it('PUT /me/locale stores the choice, the session returns it, the change is audited once', async () => {
    const put = await viewer.req('PUT', '/me/locale', { locale: 'en' });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ locale: 'en', changed: true });
    expect((await viewer.req('GET', '/auth/session')).json<{ locale: string }>().locale).toBe('en');
    // Choosing the stored value again is a no-op (no second audit row).
    const again = await viewer.req('PUT', '/me/locale', { locale: 'en' });
    expect(again.json()).toEqual({ locale: 'en', changed: false });
    const audit = await h.db.pool.query<{
      actor_id: string;
      target: string;
      outcome: string;
      metadata: unknown;
    }>(
      "SELECT actor_id, target, outcome, metadata FROM audit_events WHERE action = 'user.locale.change' ORDER BY id",
    );
    expect(audit.rows).toEqual([
      {
        actor_id: viewerId,
        target: `user:${viewerId}`,
        outcome: 'success',
        metadata: { from: null, to: 'en' },
      },
    ]);
    // Only the caller's own row changed.
    expect((await other.req('GET', '/auth/session')).json<{ locale: string }>().locale).toBe('tr');
    const back = await viewer.req('PUT', '/me/locale', { locale: 'tr' });
    expect(back.json()).toEqual({ locale: 'tr', changed: true });
    expect((await viewer.req('GET', '/auth/session')).json<{ locale: string }>().locale).toBe('tr');
  });

  it('refuses unknown languages, extra fields, another user’s id and oversized bodies', async () => {
    expect((await viewer.req('PUT', '/me/locale', { locale: 'de' })).statusCode).toBe(400);
    expect((await viewer.req('PUT', '/me/locale', {})).statusCode).toBe(400);
    const extra = await viewer.req('PUT', '/me/locale', { locale: 'en', userId: 'someone-else' });
    expect(extra.statusCode).toBe(400);
    const big = await viewer.req('PUT', '/me/locale', { locale: 'en', pad: 'x'.repeat(2048) });
    expect(big.statusCode).toBe(413);
    const { rows } = await h.db.pool.query<{ locale: string | null }>(
      "SELECT locale FROM users WHERE username = 'locale-other'",
    );
    expect(rows[0]?.locale).toBeNull();
  });

  it('needs a full session and the CSRF token', async () => {
    expect((await h.client().req('PUT', '/me/locale', { locale: 'en' })).statusCode).toBe(401);
    const bare = viewer.clone();
    bare.sendCsrf = false;
    expect((await bare.req('PUT', '/me/locale', { locale: 'en' })).statusCode).toBe(403);
    const half = h.client();
    await half.req('POST', '/auth/login', { username: 'locale-viewer', password: PW });
    expect((await half.req('PUT', '/me/locale', { locale: 'en' })).statusCode).toBe(401);
  });

  it('is documented in the OpenAPI document', async () => {
    const doc = (await viewer.req('GET', '/openapi.json')).json<{
      paths: Record<string, Record<string, unknown>>;
    }>();
    expect(Object.keys(doc.paths['/me/locale'] ?? {})).toContain('put');
  });
});
