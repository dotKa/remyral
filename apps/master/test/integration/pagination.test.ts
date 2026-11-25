import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeKeyset } from '../../src/http/pagination.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const A = 'pga';
const B = 'pgb';

interface Page {
  items?: { id: string }[];
  nextCursor?: string | null;
  total?: number;
}

/**
 * p9-pagination (docs/design/p9-pagination.md) against a real master (Postgres): every changed list endpoint pages
 * without skipping or repeating rows — also with equal sort keys (the id breaks ties) and with rows appended while
 * paging — enforces its page-size cap, refuses malformed or foreign cursors with 400 invalid_cursor, keeps the old
 * unpaged default for clients that send no page parameters, and keeps its authorization (a viewer of one project
 * pages through that project's rows only).
 */
describeIntegration('list pagination (integration, p9-pagination)', { timeout: 180_000 }, () => {
  let h: Harness;
  let owner: Client;
  let viewer: Client;
  let ownerId = '';
  let automationId = '';
  let monitorId = '';
  const workerId = 'wrk_pgpgpgpgpgpgpgpgpgpgpgpgpg';

  async function login(name: string, role: 'owner' | 'viewer', projects: string[]) {
    const id = await h.createUser(name, PW, role);
    if (role === 'viewer') await h.grant(id, projects, 'viewer');
    const { secret } = await enroll(h, name, PW);
    return { id, client: await fullLogin(h, name, PW, secret) };
  }

  async function get<T = Page>(c: Client, url: string): Promise<T> {
    const res = await c.req('GET', url);
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    return res.json<T>();
  }

  /** Follows nextCursor with `limit` until the end; returns the ids in page order. */
  async function walk(
    c: Client,
    base: string,
    limit: number,
    key: string = 'items',
    cursorKey: string = 'nextCursor',
    onPage?: (n: number) => Promise<void>,
  ): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 100; n++) {
      const sep = base.includes('?') ? '&' : '?';
      const at: string | null = cursor;
      const url = `${base}${sep}limit=${String(limit)}${at === null ? '' : `&cursor=${encodeURIComponent(at)}`}`;
      const body: Record<string, unknown> = await get<Record<string, unknown>>(c, url);
      const items = body[key] as { id: string }[];
      expect(items.length).toBeLessThanOrEqual(limit);
      ids.push(...items.map((i) => i.id));
      cursor = (body[cursorKey] as string | null | undefined) ?? null;
      if (onPage) await onPage(n);
      if (cursor === null) return ids;
      expect(items.length).toBe(limit);
    }
    throw new Error('pagination did not end');
  }

  async function bad(c: Client, url: string, code = 'invalid_cursor'): Promise<void> {
    const res = await c.req('GET', url);
    expect(res.statusCode, `${url}: ${res.body}`).toBe(400);
    if (code !== '') expect(res.json<{ error: string }>().error).toBe(code);
  }

  async function insertJob(project: string): Promise<string> {
    const now = h.clock.now();
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO jobs (project, spec, state, priority, version, lease_epoch, created_by_type, created_by_id,
                         created_at, updated_at, state_changed_at)
       VALUES ($1, $2, 'RUNNING', 0, 1, 0, 'user', 'test', $3, $3, $3) RETURNING id::text AS id`,
      [project, JSON.stringify({ runtime: 'codex', prompt: 'pagination fixture' }), now],
    );
    return rows[0]?.id ?? '';
  }

  async function insertOps(project: string, at: Date): Promise<void> {
    await h.db.pool.query(
      `INSERT INTO ops_actions (project, kind, env, params, params_hash, target, diff, policy_decision, policy_reason,
         state, requested_by_type, requested_by_id, via, idempotency_key, created_at, updated_at, finished_at)
       VALUES ($1, 'coolify.deploy', 'preview', '{}', repeat('0', 64), '{}', '{}', 'refused', 'fixture', 'refused',
         'system', 'pg', 'api', $2, $3, $3, $3)`,
      [project, `pg-${randomUUID()}`, at],
    );
  }

  async function insertApproval(jobId: string, status: 'pending' | 'cancelled', at: Date, expires: Date) {
    await h.db.pool.query(
      `INSERT INTO approval_requests (job_id, epoch, approval_key, kind, action, requested_action, risk, summary,
                                      requested_by_type, policy_version, approver_role, required_approvals,
                                      step_up, status, created_at, expires_at, decided_at, decision_reason)
       VALUES ($1, 0, $2, 'gate', 'git.merge', 'merge', 'high', 'Merge it', 'system', 0, 'operator', 1, false, $3,
               $4, $5, $6, $7)`,
      [
        jobId,
        `gate:pg-${randomUUID().slice(0, 8)}`,
        status,
        at,
        expires,
        status === 'pending' ? null : at,
        status === 'pending' ? null : 'fixture',
      ],
    );
  }

  beforeAll(async () => {
    h = await new Harness().start();
    const o = await login('pg.owner', 'owner', []);
    owner = o.client;
    ownerId = o.id;
    viewer = (await login('pg.viewer', 'viewer', [A])).client;
    await h.db.pool.query(
      `INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $3), ($2, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [A, B, h.clock.now()],
    );
    for (let i = 0; i < 3; i++) await h.createUser(`pg.extra${String(i)}`, PW, 'operator');
    for (let i = 0; i < 5; i++) {
      await h.db.pool.query(
        `INSERT INTO workers (id, display_name, state, facts, worker_version, last_seen_at, created_at, updated_at)
         VALUES ($1, $2, 'online', '{}'::jsonb, '1.0.0', $3, $3, $3)`,
        [`wrk_pg${String.fromCharCode(97 + i).repeat(24)}`, `pg-${String(i)}`, h.clock.now()],
      );
    }
    await h.db.pool.query(
      `INSERT INTO workers (id, display_name, state, facts, worker_version, last_seen_at, created_at, updated_at)
       VALUES ($1, 'pg-release', 'online', '{}'::jsonb, '1.0.0', $2, $2, $2)`,
      [workerId, h.clock.now()],
    );
    // An automation (cron, never due) with runs, five of them at the same instant (the id breaks the tie).
    const wf = await h.db.pool.query<{ id: string }>(
      `INSERT INTO workflow_definitions (project, name, version, definition, definition_hash, created_by, created_at)
       VALUES ($1, 'pg', 1, '{}', repeat('0', 64), 'fixture', now()) RETURNING id`,
      [A],
    );
    const auto = await h.db.pool.query<{ id: string }>(
      `INSERT INTO automations (project, name, state, trigger_kind, trigger, cron, next_run_at, target_kind,
                                workflow_id, workflow_inputs, run_as, created_by, created_at, updated_at)
       VALUES ($1, 'pg', 'active', 'cron', '{"kind":"cron","cron":"0 0 1 1 *"}', '0 0 1 1 *',
               now() + interval '300 days', 'workflow', $2, '{}', $3, $3, now(), now()) RETURNING id`,
      [A, wf.rows[0]?.id, ownerId],
    );
    automationId = auto.rows[0]?.id ?? '';
    const same = h.clock.now();
    for (let i = 0; i < 9; i++) {
      const at = i < 5 ? same : new Date(same.getTime() - (i + 1) * 60_000);
      await h.db.pool.query(
        `INSERT INTO automation_runs (automation_id, project, trigger_kind, dedup_key, state, created_at, finished_at)
         VALUES ($1, $2, 'manual', $3, 'skipped', $4, $4)`,
        [automationId, A, `manual:pg${String(i)}`, at],
      );
    }
    // A monitor with checks and incidents (rows only; nothing is probed).
    monitorId = randomUUID();
    await h.db.pool.query(
      `INSERT INTO uptime_monitors (id, project, name, type, config, interval_sec, timeout_ms, retries, status,
                                    next_check_at, created_by_type, created_by, created_at, updated_at)
       VALUES ($1, $2, 'pg monitor', 'tcp', '{"host":"example.com","port":443}', 300, 5000, 0, 'up',
               now() + interval '1 day', 'user', $3, now(), now())`,
      [monitorId, A, ownerId],
    );
    for (let i = 0; i < 3; i++) {
      await h.db.pool.query(
        `INSERT INTO uptime_monitors (id, project, name, type, config, interval_sec, timeout_ms, retries, status,
                                      next_check_at, created_by_type, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'tcp', '{"host":"example.com","port":443}', 300, 5000, 0, 'up',
                 now() + interval '1 day', 'user', $4, now(), now())`,
        [randomUUID(), i === 0 ? B : A, `pg extra ${String(i)}`, ownerId],
      );
    }
    for (let i = 0; i < 11; i++) {
      const at = i < 4 ? same : new Date(same.getTime() - (i + 1) * 60_000);
      await h.db.pool.query(
        `INSERT INTO uptime_checks (monitor_id, at, ok, latency_ms) VALUES ($1, $2, true, $3)`,
        [monitorId, at, i],
      );
    }
    for (let i = 0; i < 7; i++) {
      const start =
        i < 3 ? new Date(same.getTime() - 3_600_000) : new Date(same.getTime() - (i + 2) * 3_600_000);
      await h.db.pool.query(
        `INSERT INTO uptime_incidents (id, monitor_id, project, started_at, ended_at, cause)
         VALUES ($1, $2, $3, $4, $5, 'timeout')`,
        [randomUUID(), monitorId, A, start, new Date(start.getTime() + 60_000)],
      );
    }
    // Ops actions: seven in A (three at the same instant), three in B.
    for (let i = 0; i < 7; i++) await insertOps(A, i < 3 ? same : new Date(same.getTime() - i * 1_000));
    for (let i = 0; i < 3; i++) await insertOps(B, new Date(same.getTime() - i * 500));
    // Approvals: pending (deadline order) and decided (newest first) in A, two in B.
    const jobA = await insertJob(A);
    const jobB = await insertJob(B);
    for (let i = 0; i < 6; i++) {
      const exp = new Date(same.getTime() + (i < 3 ? 3_600_000 : (i + 2) * 3_600_000));
      await insertApproval(jobA, 'pending', same, exp);
      await insertApproval(jobA, 'cancelled', i < 2 ? same : new Date(same.getTime() - i * 1_000), exp);
    }
    await insertApproval(jobB, 'pending', same, new Date(same.getTime() + 60_000));
    await insertApproval(jobB, 'cancelled', same, new Date(same.getTime() + 60_000));
    // Chat threads of the owner (three with the same activity time).
    for (let i = 0; i < 8; i++) {
      const at = i < 3 ? same : new Date(same.getTime() - i * 1_000);
      await h.db.pool.query(
        `INSERT INTO chat_threads (id, user_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`,
        [randomUUID(), ownerId, `Thread ${String(i)}`, at],
      );
    }
    // A release with update attempts (rows only).
    await h.db.pool.query(
      `INSERT INTO worker_releases (version, channel, manifest, signature, key_id, sha256, size_bytes,
                                    protocol_versions, min_node, artifact, built_at, uploaded_at)
       VALUES ('9.9.9', 'stable', '\\x7b7d', '{}', '0123456789abcdef', repeat('a', 64), 1, '["1.0"]', '22.0.0',
               '\\x00', now(), now())`,
    );
    for (let i = 0; i < 6; i++) {
      const at = i < 3 ? same : new Date(same.getTime() - i * 1_000);
      await h.db.pool.query(
        `INSERT INTO worker_update_attempts (id, worker_id, from_version, to_version, source, rollback, force, status,
                                             created_at, updated_at)
         VALUES ($1, $2, '1.0.0', '9.9.9', 'channel', false, false, 'superseded', $3, $3)`,
        [randomUUID(), workerId, at],
      );
    }
  });

  afterAll(async () => {
    await h.stop();
  });

  // ------------------------------------------------------------------------------------------ keyset lists

  it('automation runs: keyset pages cover every run once, newest first, ties broken by id', async () => {
    const base = `/automations/${automationId}/runs`;
    const all = (await get(owner, `${base}?limit=200`)).items?.map((r) => r.id) ?? [];
    expect(all).toHaveLength(9);
    expect(await walk(owner, base, 2)).toEqual(all);
    expect(await walk(viewer, base, 4)).toEqual(all);
    const { rows } = await h.db.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM automation_runs WHERE automation_id = $1 ORDER BY created_at DESC, id DESC`,
      [automationId],
    );
    expect(all).toEqual(rows.map((r) => r.id));
    // Older clients: no page parameters → the first 50 (here: all), `before` still works.
    expect((await get(owner, base)).items).toHaveLength(9);
    await bad(owner, `${base}?limit=201`, '');
    await bad(owner, `${base}?cursor=not-a-cursor`);
    await bad(
      owner,
      `${base}?cursor=${encodeKeyset('uptime.checks', { k: '2026-01-01T00:00:00Z', id: '1' })}`,
    );
  });

  it('runs appended while paging do not shift later pages', async () => {
    const base = `/automations/${automationId}/runs`;
    const before = (await get(owner, `${base}?limit=200`)).items?.map((r) => r.id) ?? [];
    const seen = await walk(owner, base, 3, 'items', 'nextCursor', async (n) => {
      if (n !== 0) return;
      h.clock.advance(1_000);
      await h.db.pool.query(
        `INSERT INTO automation_runs (automation_id, project, trigger_kind, dedup_key, state, created_at, finished_at)
         VALUES ($1, $2, 'manual', 'manual:pg-late', 'skipped', $3, $3)`,
        [automationId, A, h.clock.now()],
      );
    });
    expect(seen).toEqual(before);
  });

  it('uptime checks and incidents: keyset pages (bigint and uuid ids), caps, foreign cursors refused', async () => {
    const checks = `/uptime/monitors/${monitorId}/checks`;
    const allChecks = (await get(owner, `${checks}?limit=500`)).items?.map((c) => c.id) ?? [];
    expect(allChecks).toHaveLength(11);
    expect(await walk(viewer, checks, 3)).toEqual(allChecks);
    await bad(owner, `${checks}?limit=501`, '');
    const incidents = `/uptime/monitors/${monitorId}/incidents`;
    const allIncidents = (await get(owner, `${incidents}?limit=200`)).items?.map((c) => c.id) ?? [];
    expect(allIncidents).toHaveLength(7);
    expect(await walk(owner, incidents, 2)).toEqual(allIncidents);
    // A cursor of the check list is not an incident cursor.
    const first = await get(owner, `${checks}?limit=2`);
    await bad(owner, `${incidents}?cursor=${encodeURIComponent(first.nextCursor ?? '')}`);
  });

  it('ops actions: keyset pages stay inside the caller’s projects', async () => {
    const all = (await get(owner, '/deploy/actions?limit=200')).items?.map((a) => a.id) ?? [];
    expect(all).toHaveLength(10);
    expect(await walk(owner, '/deploy/actions', 3)).toEqual(all);
    const mine = await walk(viewer, '/deploy/actions', 2);
    expect(mine).toHaveLength(7);
    const { rows } = await h.db.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM ops_actions WHERE project = $1 ORDER BY created_at DESC, id DESC`,
      [A],
    );
    expect(mine).toEqual(rows.map((r) => r.id));
    expect(await walk(owner, `/deploy/actions?project=${B}`, 2)).toHaveLength(3);
    await bad(owner, '/deploy/actions?limit=201', '');
  });

  it('approvals: pending pages by deadline, others newest first; project-scoped; cursors bound to the order', async () => {
    const pending = await walk(owner, '/approvals?status=pending', 2);
    expect(pending).toHaveLength(7);
    const p = await h.db.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM approval_requests WHERE status = 'pending' ORDER BY expires_at, id`,
    );
    expect(pending).toEqual(p.rows.map((r) => r.id));
    const recent = await walk(owner, '/approvals', 5);
    const r = await h.db.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM approval_requests ORDER BY created_at DESC, id DESC`,
    );
    expect(recent).toEqual(r.rows.map((x) => x.id));
    expect(await walk(viewer, '/approvals', 4)).toHaveLength(12);
    // Older clients without limit: up to 100 rows, as before.
    expect((await get(owner, '/approvals')).items).toHaveLength(14);
    const firstPending = await get(owner, '/approvals?status=pending&limit=1');
    await bad(owner, `/approvals?cursor=${encodeURIComponent(firstPending.nextCursor ?? '')}`);
    await bad(owner, '/approvals?limit=501', '');
  });

  it('chat threads: keyset pages of the caller’s own threads', async () => {
    const all = (await get(owner, '/chat/threads')).items?.map((t) => t.id) ?? [];
    expect(all).toHaveLength(8);
    expect(await walk(owner, '/chat/threads', 3)).toEqual(all);
    await bad(owner, '/chat/threads?limit=201', '');
  });

  it('release update attempts: keyset pages next to the release list', async () => {
    const first = await get<{ attempts: { id: string }[]; attemptsNextCursor: string | null }>(
      owner,
      `/releases?workerId=${workerId}`,
    );
    expect(first.attempts).toHaveLength(6);
    expect(first.attemptsNextCursor).toBeNull();
    expect(await walk(owner, `/releases?workerId=${workerId}`, 2, 'attempts', 'attemptsNextCursor')).toEqual(
      first.attempts.map((a) => a.id),
    );
    await bad(owner, '/releases?cursor=abc');
  });

  // ------------------------------------------------------------------------------------------ offset lists

  async function offsetPages(c: Client, base: string, key: string, size: number): Promise<void> {
    const full = await get<Record<string, unknown>>(c, base);
    const all = (full[key] as { id: string }[]).map((i) => i.id);
    expect(full.total).toBe(all.length);
    const seen: string[] = [];
    for (let offset = 0; offset < all.length + size; offset += size) {
      const sep = base.includes('?') ? '&' : '?';
      const page = await get<Record<string, unknown>>(
        c,
        `${base}${sep}limit=${String(size)}&offset=${String(offset)}`,
      );
      expect(page.total).toBe(all.length);
      seen.push(...(page[key] as { id: string }[]).map((i) => i.id));
    }
    expect(seen).toEqual(all);
    const sep = base.includes('?') ? '&' : '?';
    await bad(c, `${base}${sep}limit=501`, '');
    await bad(c, `${base}${sep}offset=-1`, '');
  }

  it('bounded admin lists: limit/offset pages with the total; no parameters return everything', async () => {
    await offsetPages(owner, '/projects', 'items', 2);
    await offsetPages(owner, '/users', 'items', 2);
    await offsetPages(owner, '/workers', 'workers', 2);
    await offsetPages(owner, '/automations', 'items', 1);
    await offsetPages(owner, '/schedules', 'items', 1);
    await offsetPages(owner, '/templates', 'items', 2);
    await offsetPages(owner, '/vault/credentials', 'items', 2);
    await offsetPages(owner, '/context/docs', 'items', 2);
    await offsetPages(owner, '/uptime/monitors', 'items', 3);
    expect((await get(owner, '/uptime/monitors')).total).toBe(4);
    // The viewer of A sees A's monitors only, with A's total.
    const v = await get(viewer, '/uptime/monitors?limit=1');
    expect(v.total).toBe(3);
    expect(v.items).toHaveLength(1);
    expect((await get(viewer, '/uptime/monitors?limit=1&offset=10')).total).toBe(3);
  });

  it('authorization is unchanged by the page parameters', async () => {
    expect((await viewer.req('GET', '/users?limit=1')).statusCode).toBe(403);
    expect((await viewer.req('GET', `/deploy/actions?project=${B}&limit=1`)).statusCode).toBe(404);
    const projects = await get(viewer, '/projects?limit=10');
    expect(projects.items?.map((p) => p.id)).toEqual([A]);
    expect(projects.total).toBe(1);
  });
});
