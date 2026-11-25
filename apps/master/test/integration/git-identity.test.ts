import { afterAll, beforeAll, expect, it } from 'vitest';
import { Cluster, PW } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin } from '../helpers/harness.js';
import { PROJECT } from '../helpers/job-worker.js';

/**
 * p5-git-identity against a real master (Postgres, migration 0040, dispatch loop) and a real worker daemon:
 *  - `GET/PUT /projects/:id/git-identity`: viewers read, project admins change with step-up; validated (400 with a
 *    readable reason), audited with before/after; null inherits;
 *  - `GET/PUT /settings/git-identity`: the workspace-wide default (admin + step-up, audited);
 *  - resolution project → workspace default → Remyral Agent, and ASSIGN_JOB carries the resolved identity;
 *  - the database refuses what the API refuses (check constraints).
 */
describeIntegration('git identity (integration, p5-git-identity)', { timeout: 120_000 }, () => {
  const c = new Cluster();
  let operator: Client;
  const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };
  const ORG = { name: 'Acme Bots', email: 'bots@acme.example' };

  const putProject = (identity: unknown, who: Client = c.admin) =>
    who.req('PUT', `/projects/${PROJECT}/git-identity`, { identity });
  const putDefault = (identity: unknown, who: Client = c.admin) =>
    who.req('PUT', '/settings/git-identity', { identity });

  async function audits(action: string): Promise<Record<string, unknown>[]> {
    const { rows } = await c.h.db.pool.query<{ metadata: Record<string, unknown>; target: string }>(
      "SELECT metadata, target FROM audit_events WHERE action = $1 AND outcome = 'success' ORDER BY id",
      [action],
    );
    return rows.map((r) => ({ target: r.target, ...r.metadata }));
  }

  beforeAll(async () => {
    await c.start(13);
    const op = await c.h.createUser('oper1', PW, 'operator');
    await c.h.grant(op, [PROJECT], 'operator');
    const o = await enroll(c.h, 'oper1', PW);
    operator = await fullLogin(c.h, 'oper1', PW, o.secret);
  });
  afterAll(async () => {
    await c.stop();
  });

  it('project identity: read by members, changed by admins with step-up, validated and audited', async () => {
    const initial = await operator.req('GET', `/projects/${PROJECT}/git-identity`);
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toEqual({
      project: PROJECT,
      identity: null,
      effective: { identity: { name: 'Remyral Agent', email: 'agent@remyral.invalid' }, source: 'default' },
      updatedAt: null,
      updatedBy: null,
    });

    expect((await putProject(ADA, operator)).statusCode).toBe(403);
    c.h.clock.advance(11 * 60_000);
    const stale = await putProject(ADA);
    expect(stale.statusCode).toBe(403);
    expect(stale.body).toContain('step_up_required');

    await c.stepUp();
    const badName = await putProject({ name: 'Ada\nEvil', email: 'ada@example.com' });
    expect(badName.statusCode).toBe(400);
    expect(badName.json()).toMatchObject({ error: 'invalid_git_identity' });
    // p14-i18n-errors: the issue code travels as params.reason (the console says it in the user's language).
    expect(badName.json()).toMatchObject({ params: { reason: 'name_forbidden' } });
    const badEmail = await putProject({ name: 'Ada', email: 'not-an-email' });
    expect(badEmail.statusCode).toBe(400);
    expect(badEmail.json<{ message: string }>().message).toContain('email address');
    expect(badEmail.json()).toMatchObject({ params: { reason: 'email_invalid' } });
    const long = await putProject({ name: 'x'.repeat(101), email: 'a@b.com' });
    expect(long.statusCode).toBe(400);
    expect(long.json()).toEqual({
      error: 'invalid_git_identity',
      message: 'Name is at most 100 characters.',
      params: { reason: 'name_too_long', max: 100 },
    });
    expect((await putProject({ name: 'Ada' })).statusCode).toBe(400);

    const saved = await putProject({ name: ' Ada Lovelace ', email: 'ada@example.com' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      identity: ADA,
      effective: { identity: ADA, source: 'project' },
      updatedBy: 'owner1',
    });
    expect(await audits('project.git_identity.update')).toEqual([
      { target: `project:${PROJECT}`, before: null, after: ADA, changed: true },
    ]);
    expect((await operator.req('GET', `/projects/${PROJECT}/git-identity`)).json()).toMatchObject({
      identity: ADA,
    });
    // Unknown projects are not found.
    await c.stepUp();
    expect((await c.admin.req('PUT', '/projects/nope/git-identity', { identity: ADA })).statusCode).toBe(404);
  });

  it('workspace default: admin only; a project without its own identity inherits it', async () => {
    expect((await operator.req('GET', '/settings/git-identity')).statusCode).toBe(403);
    expect((await putDefault(ORG, operator)).statusCode).toBe(403);
    await c.stepUp();
    expect((await putDefault({ name: 'Bots', email: 'bots@' })).statusCode).toBe(400);
    const saved = await putDefault(ORG);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ identity: ORG, effective: { identity: ORG, source: 'workspace' } });

    // The project still has its own identity; clearing it inherits the default.
    expect((await c.admin.req('GET', `/projects/${PROJECT}/git-identity`)).json()).toMatchObject({
      effective: { source: 'project', identity: ADA },
    });
    await c.stepUp();
    const cleared = await putProject(null);
    expect(cleared.json()).toMatchObject({
      identity: null,
      effective: { identity: ORG, source: 'workspace' },
    });

    await c.stepUp();
    const removed = await putDefault(null);
    expect(removed.json()).toMatchObject({
      identity: null,
      effective: { identity: { name: 'Remyral Agent', email: 'agent@remyral.invalid' }, source: 'default' },
    });
    expect(await audits('settings.git_identity.update')).toEqual([
      { target: 'settings:git-identity', before: null, after: ORG, changed: true },
      { target: 'settings:git-identity', before: ORG, after: null, changed: true },
    ]);
    expect((await audits('project.git_identity.update')).at(-1)).toMatchObject({ before: ADA, after: null });
  });

  it('the database refuses invalid identities and half-set pairs', async () => {
    const db = c.h.db.pool;
    await expect(
      db.query("UPDATE projects SET git_author_name = E'a\\nb', git_author_email = 'a@b.com' WHERE id = $1", [
        PROJECT,
      ]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query("UPDATE projects SET git_author_name = 'Ada', git_author_email = NULL WHERE id = $1", [
        PROJECT,
      ]),
    ).rejects.toThrow(/projects_git_identity_pair/);
    await expect(
      db.query("INSERT INTO git_identity_default (name, email, updated_at) VALUES ('A', 'no-at', now())"),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query(
        "INSERT INTO git_identity_default (id, name, email, updated_at) VALUES (2, 'A', 'a@b.c', now())",
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('ASSIGN_JOB carries the resolved identity: project, then workspace default, then Remyral Agent', async () => {
    const replay = c.h.app.fleetSessions.replay;
    const sent: Record<string, unknown>[] = [];
    const original = replay.enqueue.bind(replay);
    replay.enqueue = ((workerId: string, type: string, payload: Record<string, unknown>, opts?: unknown) => {
      if (type === 'ASSIGN_JOB') sent.push(payload);
      return (original as (...a: unknown[]) => Promise<unknown>)(workerId, type, payload, opts);
    }) as typeof replay.enqueue;
    try {
      await c.newWorker();
      const run = async (): Promise<unknown> => {
        const id = await c.submit();
        await expect.poll(() => c.state(id), { timeout: 30_000 }).toBe('SUCCEEDED');
        return sent.at(-1)?.gitIdentity;
      };
      expect(await run()).toEqual({ name: 'Remyral Agent', email: 'agent@remyral.invalid' });
      await c.stepUp();
      await putDefault(ORG);
      expect(await run()).toEqual(ORG);
      await c.stepUp();
      await putProject(ADA);
      expect(await run()).toEqual(ADA);
    } finally {
      replay.enqueue = original;
      await c.stopWorkers();
    }
  });
});
