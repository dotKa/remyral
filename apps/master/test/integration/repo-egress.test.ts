import { randomUUID } from 'node:crypto';
import { REPO_EGRESS_PRESETS } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { loadProjectEgress, loadRepoEgress } from '../../src/repo-egress/service.js';
import { Cluster, PW } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin } from '../helpers/harness.js';
import { PROJECT } from '../helpers/job-worker.js';

/**
 * p14-repo-egress against a real master (Postgres, migration 0117, dispatch loop) and real worker daemons:
 *  - `GET/PUT /projects/:id/repo-egress`: default `none` (model APIs only); members read; project admins change it with
 *    an always-fresh step-up; public DNS names only (IP literals, internal names refused with `invalid_egress`);
 *    presets validated; workspace projects refused (`repo_egress_not_repository`); audited with before / after;
 *  - ASSIGN_JOB `execution.repoEgress` carries the effective policy (presets expanded) to `repo-egress-v1` workers only;
 *    an older worker gets nothing (model APIs only) and the GET lists it under `unsupportedWorkers`.
 */
describeIntegration('repository project egress (integration, p14-repo-egress)', { timeout: 180_000 }, () => {
  const c = new Cluster();
  let operator: Client;
  let operatorId = '';
  const put = (body: unknown, who: Client = c.admin, project = PROJECT) =>
    who.req('PUT', `/projects/${project}/repo-egress`, body);

  beforeAll(async () => {
    await c.start(14);
    const op = await c.h.createUser('oper1', PW, 'operator');
    operatorId = op;
    await c.h.grant(op, [PROJECT], 'operator');
    operator = await fullLogin(c.h, 'oper1', PW, (await enroll(c.h, 'oper1', PW)).secret);
    await c.h.db.pool.query(
      "INSERT INTO projects (id, name, kind, created_at) VALUES ('research', 'research', 'workspace', now())",
    );
  });
  afterAll(async () => {
    await c.stop();
  });

  it('default none; operators read, admins change with a fresh step-up; validated; audited', async () => {
    const initial = await operator.req('GET', `/projects/${PROJECT}/repo-egress`);
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({
      project: PROJECT,
      kind: 'repository',
      mode: 'none',
      presets: [],
      hosts: [],
      effective: { mode: 'none', hosts: [] },
      updatedAt: null,
      updatedBy: null,
    });

    const body = {
      mode: 'allowlist',
      presets: ['pypi', 'npm'],
      hosts: ['Cdn.Example.com ', 'git.example.org:2222'],
    };
    expect((await put(body, operator)).statusCode).toBe(403);
    c.h.clock.advance(11 * 60_000);
    const stale = await put(body);
    expect(stale.statusCode).toBe(403);
    expect(stale.body).toContain('step_up_required');

    await c.stepUp();
    for (const [host, problem] of [
      ['10.0.0.1', 'ip_literal'],
      ['nas.local', 'forbidden_host'],
      ['metadata.google.internal', 'forbidden_host'],
      ['localhost', 'invalid_host'],
    ] as const) {
      const bad = await put({ mode: 'allowlist', presets: [], hosts: [host] });
      expect(bad.statusCode, host).toBe(422);
      expect(bad.json()).toMatchObject({ error: 'invalid_egress', params: { entry: host, problem } });
    }
    expect((await put({ mode: 'allowlist', presets: ['npm', 'docker'], hosts: [] })).statusCode).toBe(400);
    expect((await put({ mode: 'open', presets: [], hosts: [] })).statusCode).toBe(400);
    expect(
      (
        await put({
          mode: 'allowlist',
          presets: [],
          hosts: Array.from({ length: 49 }, (_, i) => `h${String(i)}.example.com`),
        })
      ).statusCode,
    ).toBe(400);

    const saved = await put(body);
    expect(saved.statusCode, saved.body).toBe(200);
    const v = saved.json<{ effective: { mode: string; hosts: string[] } }>();
    expect(v).toMatchObject({
      mode: 'allowlist',
      presets: ['npm', 'pypi'],
      hosts: ['cdn.example.com', 'git.example.org:2222'],
      updatedBy: 'owner1',
    });
    expect(v.effective.mode).toBe('allowlist');
    expect(v.effective.hosts).toEqual(
      [
        ...REPO_EGRESS_PRESETS.npm,
        ...REPO_EGRESS_PRESETS.pypi,
        'cdn.example.com',
        'git.example.org:2222',
      ].sort(),
    );
    const { rows } = await c.h.db.pool.query<{ metadata: Record<string, unknown>; target: string }>(
      "SELECT metadata, target FROM audit_events WHERE action = 'project.repo_egress.update' AND outcome = 'success' ORDER BY id",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe(`project:${PROJECT}`);
    expect(rows[0]?.metadata).toMatchObject({
      project: PROJECT,
      before: { mode: 'none', presets: [], hosts: [] },
      after: {
        mode: 'allowlist',
        presets: ['npm', 'pypi'],
        hosts: ['cdn.example.com', 'git.example.org:2222'],
      },
    });
    // Denied writes are audited by the authorization layer.
    const { rows: denied } = await c.h.db.pool.query(
      "SELECT 1 FROM audit_events WHERE action = 'project.repo_egress.update' AND outcome <> 'success'",
    );
    expect(denied.length).toBeGreaterThan(0);

    // Workspace projects keep their own setting; unknown projects are not found.
    await c.stepUp();
    const ws = await put({ mode: 'web', presets: [], hosts: [] }, c.admin, 'research');
    expect(ws.statusCode).toBe(409);
    expect(ws.json()).toMatchObject({ error: 'repo_egress_not_repository' });
    expect((await c.admin.req('GET', '/projects/research/repo-egress')).json()).toMatchObject({
      kind: 'workspace',
    });
    await c.stepUp();
    expect((await put({ mode: 'none', presets: [], hosts: [] }, c.admin, 'nope')).statusCode).toBe(404);

    // The database refuses what the API refuses.
    await expect(
      c.h.db.pool.query("UPDATE project_repo_egress SET presets = '{docker}' WHERE project = $1", [PROJECT]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      c.h.db.pool.query("UPDATE project_repo_egress SET mode = 'open' WHERE project = $1", [PROJECT]),
    ).rejects.toThrow(/check constraint/);
  });

  it('ASSIGN_JOB carries the effective policy to repo-egress-v1 workers only; older workers are listed', async () => {
    const replay = c.h.app.fleetSessions.replay;
    const sent: Record<string, unknown>[] = [];
    const original = replay.enqueue.bind(replay);
    replay.enqueue = ((workerId: string, type: string, payload: Record<string, unknown>, opts?: unknown) => {
      if (type === 'ASSIGN_JOB') sent.push(payload);
      return (original as (...a: unknown[]) => Promise<unknown>)(workerId, type, payload, opts);
    }) as typeof replay.enqueue;
    const run = async (): Promise<unknown> => {
      const id = await c.submit();
      await expect.poll(() => c.state(id), { timeout: 30_000 }).toBe('SUCCEEDED');
      return (sent.at(-1)?.execution as { repoEgress?: unknown } | undefined)?.repoEgress;
    };
    try {
      // An older worker (no repo-egress-v1): nothing is sent, and the panel lists it.
      const old = await c.newWorker();
      expect(await run()).toBeUndefined();
      const listed = (await c.admin.req('GET', `/projects/${PROJECT}/repo-egress`)).json<{
        unsupportedWorkers: { id: string }[];
      }>();
      expect(listed.unsupportedWorkers.map((w) => w.id)).toContain(old.id);
      await c.stopWorkers();
      await c.h.db.pool.query('UPDATE workers SET archived_at = now() WHERE id = $1', [old.id]);

      const current = await c.newWorker({ features: ['repo-egress-v1'] });
      const eff = await run();
      expect(eff).toEqual({
        mode: 'allowlist',
        hosts: [
          ...REPO_EGRESS_PRESETS.npm,
          ...REPO_EGRESS_PRESETS.pypi,
          'cdn.example.com',
          'git.example.org:2222',
        ].sort(),
      });
      // A change applies to the next assignment; web carries no preset expansion beyond what is listed.
      await c.stepUp();
      expect((await put({ mode: 'web', presets: [], hosts: [] })).statusCode).toBe(200);
      expect(await run()).toEqual({ mode: 'web', hosts: [] });
      await c.stepUp();
      expect((await put({ mode: 'none', presets: ['npm'], hosts: [] })).statusCode).toBe(200);
      expect(await run()).toEqual({ mode: 'none', hosts: [] });
      expect(
        (await c.admin.req('GET', `/projects/${PROJECT}/repo-egress`))
          .json<{ unsupportedWorkers: { id: string }[] }>()
          .unsupportedWorkers.map((w) => w.id),
      ).not.toContain(current.id);
    } finally {
      replay.enqueue = original;
      await c.stopWorkers();
    }
  });

  it('the assistant sees the real setting: list_projects names the mode and the screen to change it', async () => {
    const tools = new ChatTools({ db: c.h.db.pool, clock: c.h.clock.now } as unknown as ChatToolsDeps);
    const caller = {
      userId: operatorId,
      subject: await loadSubject(c.h.db.pool, { id: operatorId, role: 'operator' }),
      threadId: randomUUID(),
      turnId: randomUUID(),
    };
    const out = await tools.run(caller, 'list_projects', {});
    if (!out.ok) throw new Error(JSON.stringify(out));
    const projects = (out.data as { projects: { id: string; networkAccess: unknown }[] }).projects;
    expect(projects.find((p) => p.id === PROJECT)?.networkAccess).toEqual({
      mode: 'none',
      presets: ['npm'],
      customHosts: 0,
      setting: `Projects → ${PROJECT} → Policy → Network access`,
    });
  });

  it('p22-worker-limits: services / IDEs of a workspace project get its Workspace-tab egress setting', async () => {
    const db = c.h.db.pool;
    // No settings row: model APIs only.
    await db.query("DELETE FROM project_workspaces WHERE project = 'research'");
    expect(await loadProjectEgress(db, 'research')).toEqual({ mode: 'none', hosts: [] });
    await db.query(
      `INSERT INTO project_workspaces (project, egress, allow_hosts, updated_at)
       VALUES ('research', 'allowlist', '["pkg.example.com", "api.example.org"]'::jsonb, now())`,
    );
    expect(await loadProjectEgress(db, 'research')).toEqual({
      mode: 'allowlist',
      hosts: ['api.example.org', 'pkg.example.com'],
    });
    await db.query(
      "UPDATE project_workspaces SET egress = 'web', allow_hosts = '[]'::jsonb WHERE project = 'research'",
    );
    expect(await loadProjectEgress(db, 'research')).toEqual({ mode: 'web', hosts: [] });
    // A repository project keeps its Network access setting (the same as loadRepoEgress).
    expect(await loadProjectEgress(db, PROJECT)).toEqual(await loadRepoEgress(db, PROJECT));
  });
});
