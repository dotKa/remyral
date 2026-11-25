import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p17-remyral-brand: the console colour theme per user. Migration 0150 adds `users.theme` (NULL = system, CHECK
 * light/dark); `GET /auth/session` returns it ("system" by default); `PUT /me/theme` stores the caller's own choice —
 * any role, full session + CSRF, strict body, audited on change.
 */
const PW = 'colour-scheme-Passw0rd-long';

describeIntegration('user theme (integration)', () => {
  let h: Harness;
  let viewer: Client;
  let viewerId: string;
  let other: Client;

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    viewerId = await h.createUser('theme-viewer', PW, 'viewer');
    const a = await enroll(h, 'theme-viewer', PW);
    viewer = await fullLogin(h, 'theme-viewer', PW, a.secret);
    await h.createUser('theme-other', PW, 'operator');
    const b = await enroll(h, 'theme-other', PW);
    other = await fullLogin(h, 'theme-other', PW, b.secret);
  });
  afterAll(async () => {
    await h.stop();
  });

  it('migration 0150: nullable column, only light / dark stored', async () => {
    const { rows } = await h.db.pool.query<{ is_nullable: string; data_type: string }>(
      "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'theme'",
    );
    expect(rows).toEqual([{ is_nullable: 'YES', data_type: 'text' }]);
    await expect(
      h.db.pool.query("UPDATE users SET theme = 'system' WHERE id = $1", [viewerId]),
    ).rejects.toThrow(/check constraint/i);
  });

  it('PUT /me/theme stores the choice, the session returns it, the change is audited once', async () => {
    expect((await viewer.req('GET', '/auth/session')).json<{ theme: string }>().theme).toBe('system');
    const put = await viewer.req('PUT', '/me/theme', { theme: 'dark' });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ theme: 'dark', changed: true });
    expect((await viewer.req('GET', '/auth/session')).json<{ theme: string }>().theme).toBe('dark');
    expect((await viewer.req('PUT', '/me/theme', { theme: 'dark' })).json()).toEqual({
      theme: 'dark',
      changed: false,
    });
    const audit = await h.db.pool.query<{ actor_id: string; metadata: unknown }>(
      "SELECT actor_id, metadata FROM audit_events WHERE action = 'user.theme.change' ORDER BY id",
    );
    expect(audit.rows).toEqual([{ actor_id: viewerId, metadata: { from: 'system', to: 'dark' } }]);
    expect((await other.req('GET', '/auth/session')).json<{ theme: string }>().theme).toBe('system');
    // "system" clears the column.
    expect((await viewer.req('PUT', '/me/theme', { theme: 'system' })).json()).toEqual({
      theme: 'system',
      changed: true,
    });
    const { rows } = await h.db.pool.query<{ theme: string | null }>(
      'SELECT theme FROM users WHERE id = $1',
      [viewerId],
    );
    expect(rows[0]?.theme).toBeNull();
  });

  it('refuses unknown values, extra fields, missing CSRF and half sessions', async () => {
    expect((await viewer.req('PUT', '/me/theme', { theme: 'sepia' })).statusCode).toBe(400);
    expect((await viewer.req('PUT', '/me/theme', { theme: 'dark', userId: 'x' })).statusCode).toBe(400);
    expect((await h.client().req('PUT', '/me/theme', { theme: 'dark' })).statusCode).toBe(401);
    const bare = viewer.clone();
    bare.sendCsrf = false;
    expect((await bare.req('PUT', '/me/theme', { theme: 'dark' })).statusCode).toBe(403);
    const doc = (await viewer.req('GET', '/openapi.json')).json<{
      paths: Record<string, Record<string, unknown>>;
    }>();
    expect(Object.keys(doc.paths['/me/theme'] ?? {})).toContain('put');
  });
});
