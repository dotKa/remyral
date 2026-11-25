import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p20-decisions (docs/design/p20-decisions.md): "Ertele" / "Yoksay" of "Senden bekleyen"
 * are kept by the master per person (migration 0202 `decision_deferrals`) — `GET/PUT/DELETE /me/deferrals`, own rows
 * only, CSRF, audited; the badge, the home and /needs read this one list on every device, and a deferral past its time
 * is no longer returned (the decision is back, it counts again).
 */
const PW = 'decision-deferrals-Passw0rd';
const A1 = '7c1e09ab-0000-4000-8000-000000000001';
const A2 = '7c1e09ab-0000-4000-8000-000000000002';
const PLAN = '5d3f2a10-0000-4000-8000-000000000009';
const HOUR = 3600_000;

interface Listed {
  items: { key: string; mode: string; until: string }[];
}

describeIntegration('decision deferrals (integration)', () => {
  let h: Harness;
  let viewer: Client;
  let viewerId: string;
  let phone: Client;
  let other: Client;
  let viewerSecret: string;

  const keys = async (c: Client): Promise<string[]> => {
    const r = await c.req('GET', '/me/deferrals');
    expect(r.statusCode, r.body).toBe(200);
    return r
      .json<Listed>()
      .items.map((i) => i.key)
      .sort();
  };

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    viewerId = await h.createUser('defer-viewer', PW, 'viewer');
    const a = await enroll(h, 'defer-viewer', PW);
    viewerSecret = a.secret;
    viewer = await fullLogin(h, 'defer-viewer', PW, viewerSecret);
    await h.createUser('defer-other', PW, 'operator');
    const b = await enroll(h, 'defer-other', PW);
    other = await fullLogin(h, 'defer-other', PW, b.secret);
  });
  afterAll(async () => {
    await h.stop();
  });

  it('migration 0202: one row per person and decision, modes and key parts checked, close_note bounded', async () => {
    const { rows } = await h.db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'decision_deferrals' ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'created_at',
      'kind',
      'mode',
      'subject',
      'until',
      'user_id',
    ]);
    const now = h.clock.now();
    await expect(
      h.db.pool.query(
        `INSERT INTO decision_deferrals (user_id, kind, subject, mode, until, created_at) VALUES ($1, 'approval', 'x', 'forever', $2, $2)`,
        [viewerId, now],
      ),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      h.db.pool.query(
        `INSERT INTO decision_deferrals (user_id, kind, subject, mode, until, created_at) VALUES ($1, 'Approval', 'x', 'snooze', $2, $2)`,
        [viewerId, now],
      ),
    ).rejects.toThrow(/check constraint/i);
    const note = await h.db.pool.query<{ is_nullable: string }>(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'user_questions' AND column_name = 'close_note'",
    );
    expect(note.rows).toEqual([{ is_nullable: 'YES' }]);
  });

  it('PUT stores a snooze (a day) and an ignore (a week); another device of the person reads the same; audited once', async () => {
    expect(await keys(viewer)).toEqual([]);
    const put = await viewer.req('PUT', '/me/deferrals', {
      items: [
        { key: `approval:${A1}`, mode: 'snooze' },
        { key: `plan:${PLAN}`, mode: 'snooze' },
        { key: 'machine:w-1', mode: 'ignore' },
      ],
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual({ stored: 3 });
    const listed = (await viewer.req('GET', '/me/deferrals')).json<Listed>().items;
    const at = h.clock.now().getTime();
    expect(Object.fromEntries(listed.map((i) => [i.key, [i.mode, Date.parse(i.until) - at]]))).toEqual({
      [`approval:${A1}`]: ['snooze', 24 * HOUR],
      [`plan:${PLAN}`]: ['snooze', 24 * HOUR],
      'machine:w-1': ['ignore', 7 * 24 * HOUR],
    });
    // The phone (another session of the same person) shows the same; another person has none.
    phone = await fullLogin(h, 'defer-viewer', PW, viewerSecret);
    expect(await keys(phone)).toEqual(['machine:w-1', `approval:${A1}`, `plan:${PLAN}`].sort());
    expect(await keys(other)).toEqual([]);
    const audit = await h.db.pool.query<{ actor_id: string; metadata: unknown }>(
      "SELECT actor_id, metadata FROM audit_events WHERE action = 'user.decision.defer' ORDER BY id",
    );
    expect(audit.rows).toEqual([
      {
        actor_id: viewerId,
        metadata: { count: 3, snooze: 2, ignore: 1, kinds: ['approval', 'machine', 'plan'] },
      },
    ]);
  });

  it('a deferral past its time is not returned: the decision counts again', async () => {
    // The day is over for both snoozes (moved back in the table: the sessions would not outlive a clock jump).
    await h.db.pool.query(`UPDATE decision_deferrals SET until = $2 WHERE user_id = $1 AND mode = 'snooze'`, [
      viewerId,
      new Date(h.clock.now().getTime() - 1000),
    ]);
    expect(await keys(phone)).toEqual(['machine:w-1']);
    // A new snooze of the same decision starts a new day (one row per decision; the expired one is replaced).
    expect(
      (
        await viewer.req('PUT', '/me/deferrals', { items: [{ key: `approval:${A1}`, mode: 'snooze' }] })
      ).json(),
    ).toEqual({ stored: 1 });
    expect(await keys(viewer)).toEqual(['machine:w-1', `approval:${A1}`].sort());
    const { rows } = await h.db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM decision_deferrals WHERE user_id = $1',
      [viewerId],
    );
    expect(rows[0]?.n).toBe('2'); // the expired plan snooze was pruned on the write
  });

  it('the one-time move of a browser list: explicit ends kept, past ones skipped, capped at a week', async () => {
    const now = h.clock.now().getTime();
    const r = await viewer.req('PUT', '/me/deferrals', {
      items: [
        { key: `approval:${A2}`, mode: 'snooze', until: new Date(now + 2 * HOUR).toISOString() },
        { key: 'failed:j-1', mode: 'ignore', until: new Date(now - HOUR).toISOString() },
        { key: 'runtime:w-1:codex', mode: 'ignore', until: new Date(now + 30 * 24 * HOUR).toISOString() },
      ],
    });
    expect(r.json()).toEqual({ stored: 2 });
    const items = (await viewer.req('GET', '/me/deferrals')).json<Listed>().items;
    const until = (k: string): number => Date.parse(items.find((i) => i.key === k)?.until ?? '') - now;
    expect(until(`approval:${A2}`)).toBe(2 * HOUR);
    expect(until('runtime:w-1:codex')).toBe(7 * 24 * HOUR);
    expect(items.some((i) => i.key === 'failed:j-1')).toBe(false);
  });

  it('DELETE brings one back, or every snoozed one ("Göster"); ignored ones stay', async () => {
    const one = await viewer.req('DELETE', `/me/deferrals?key=${encodeURIComponent(`approval:${A2}`)}`);
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json()).toEqual({ removed: 1 });
    const all = await viewer.req('DELETE', '/me/deferrals?mode=snooze');
    expect(all.json()).toEqual({ removed: 1 });
    expect(await keys(phone)).toEqual(['machine:w-1', 'runtime:w-1:codex']);
    expect((await viewer.req('DELETE', '/me/deferrals')).statusCode).toBe(400);
    const audit = await h.db.pool.query<{ metadata: unknown }>(
      "SELECT metadata FROM audit_events WHERE action = 'user.decision.undefer' ORDER BY id",
    );
    expect(audit.rows).toEqual([{ metadata: { removed: 1 } }, { metadata: { removed: 1, mode: 'snooze' } }]);
  });

  it('refuses bad keys and modes, extra fields, missing CSRF and no session; documented in OpenAPI', async () => {
    const bad = async (body: unknown): Promise<number> =>
      (await viewer.req('PUT', '/me/deferrals', body)).statusCode;
    expect(await bad({ items: [{ key: 'no-colon', mode: 'snooze' }] })).toBe(400);
    expect(await bad({ items: [{ key: 'approval: x', mode: 'snooze' }] })).toBe(400);
    expect(await bad({ items: [{ key: `approval:${A1}`, mode: 'forever' }] })).toBe(400);
    expect(await bad({ items: [{ key: `approval:${A1}`, mode: 'snooze', userId: 'x' }] })).toBe(400);
    expect(await bad({ items: [] })).toBe(400);
    expect(await bad({ items: [{ key: `approval:${A1}`, mode: 'snooze' }], userId: viewerId })).toBe(400);
    expect((await h.client().req('GET', '/me/deferrals')).statusCode).toBe(401);
    expect(
      (await h.client().req('PUT', '/me/deferrals', { items: [{ key: `approval:${A1}`, mode: 'snooze' }] }))
        .statusCode,
    ).toBe(401);
    const bare = viewer.clone();
    bare.sendCsrf = false;
    expect(
      (await bare.req('PUT', '/me/deferrals', { items: [{ key: `approval:${A1}`, mode: 'snooze' }] }))
        .statusCode,
    ).toBe(403);
    expect((await bare.req('DELETE', '/me/deferrals?mode=snooze')).statusCode).toBe(403);
    const doc = (await viewer.req('GET', '/openapi.json')).json<{
      paths: Record<string, Record<string, unknown>>;
    }>();
    expect(Object.keys(doc.paths['/me/deferrals'] ?? {}).sort()).toEqual(['delete', 'get', 'put']);
  });
});
