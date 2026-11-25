import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoutePlugin } from '../../src/app.js';
import { ApprovalService } from '../../src/approvals/index.js';
import { AuditLog } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import { Directory } from '../../src/authz/directory.js';
import { ContextStore } from '../../src/context/index.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { UsageStore } from '../../src/usage/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

/**
 * p5-rbac-api behaviour through the real handlers: project scoping of list/detail endpoints, the account
 * role ceiling, the project/user management API and its audit trail, disabled accounts, and the
 * deny-by-default for undeclared routes.
 */

const PW = 'quartz-meadow-lantern-7';

interface Person {
  readonly id: string;
  readonly secret: string;
  client: Client;
}

let h: Harness;
let jobs: JobStore;
let approvals: ApprovalService;
let context: ContextStore;
const p = {} as Record<'owner' | 'admin' | 'opA' | 'opB' | 'viewerA' | 'cappedA', Person>;
const ids = {} as Record<'jobA' | 'jobB' | 'approvalA' | 'approvalB' | 'docA' | 'docB', string>;

// An undeclared full-session route: must be refused (deny by default).
const undeclared: RoutePlugin = (app) => {
  app.get('/test/undeclared', () => ({ leaked: true }));
};

async function person(username: string, role: Role, grants: [string, 'operator' | 'viewer'][] = []) {
  const id = await h.createUser(username, PW, role);
  for (const [project, r] of grants) await h.grant(id, [project], r);
  const { client, secret } = await enroll(h, username, PW);
  return { id, secret, client };
}

async function stepUp(who: Person): Promise<void> {
  h.clock.advance(30_000);
  const res = await who.client.req('POST', '/auth/step-up', { code: h.code(who.secret) });
  expect(res.statusCode, res.body).toBe(200);
}

async function awaitingJob(project: string): Promise<{ job: string; approval: string }> {
  const creator: JobActor = { type: 'system', id: 'test' };
  const { job } = await jobs.create({
    project,
    actor: creator,
    submit: true,
    spec: {
      runtime: 'codex',
      prompt: `Work in ${project}`,
      repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/rbac' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    },
  });
  const grant = await jobs.acquireLease(job.id, 'worker-1', 3_600_000);
  const w: JobActor = { type: 'worker', id: 'worker-1' };
  for (const ev of ['lease_acked', 'runtime_started', 'run_finished', 'verification_passed'] as const) {
    await jobs.transition(job.id, ev, { actor: w, epoch: grant.lease.epoch });
  }
  const ev = await approvals.evaluate({
    action: 'git.merge',
    jobId: job.id,
    summary: `Merge in ${project}`,
    requestedBy: { type: 'system', id: 'integrator' },
  });
  if (ev.outcome !== 'pending') throw new Error('expected pending');
  return { job: job.id, approval: ev.requestId };
}

async function auditRows(action: string, outcome?: string) {
  const { rows } = await h.db.pool.query<{ actor_id: string; target: string | null; metadata: unknown }>(
    `SELECT actor_id, target, metadata FROM audit_events WHERE action = $1 AND ($2::text IS NULL OR outcome = $2)
      ORDER BY id`,
    [action, outcome ?? null],
  );
  return rows;
}

describeIntegration('RBAC API and project scoping (integration)', () => {
  beforeAll(async () => {
    h = new Harness();
    await h.start({ extraRoutes: [undeclared] });
    const audit = new AuditLog(h.db.pool, h.clock.now);
    jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    approvals = new ApprovalService({ pool: h.db.pool, audit, jobs, clock: h.clock.now });
    context = new ContextStore({ pool: h.db.pool, audit, clock: h.clock.now });
    p.owner = await person('owner1', 'owner');
    p.admin = await person('admin1', 'admin');
    p.opA = await person('opa', 'operator', [['alpha', 'operator']]);
    p.opB = await person('opb', 'operator', [['beta', 'operator']]);
    p.viewerA = await person('viewera', 'viewer', [['alpha', 'viewer']]);
    // A viewer account with an operator membership stays a viewer (account role is the ceiling).
    p.cappedA = await person('cappeda', 'viewer', [['alpha', 'operator']]);
    const a = await awaitingJob('alpha');
    const b = await awaitingJob('beta');
    ids.jobA = a.job;
    ids.approvalA = a.approval;
    ids.jobB = b.job;
    ids.approvalB = b.approval;
    const owner = { id: p.owner.id, role: 'owner' as const, mfaAt: h.clock.now() };
    ids.docA = (
      await context.create(owner, {
        namespace: 'project:alpha',
        kind: 'instructions',
        title: 'Alpha',
        content: 'alpha rules',
      })
    ).doc.id;
    ids.docB = (
      await context.create(owner, {
        namespace: 'project:beta',
        kind: 'instructions',
        title: 'Beta',
        content: 'beta rules',
      })
    ).doc.id;
    await context.create(owner, {
      namespace: 'global',
      kind: 'instructions',
      title: 'Global',
      content: 'global rules',
    });
  });

  afterAll(async () => {
    await h.stop();
  });

  describe('deny by default', () => {
    it('refuses a full-session route without an authorization declaration, even for the owner', async () => {
      const res = await p.owner.client.req('GET', '/test/undeclared');
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('leaked');
      expect(h.logs.text).toContain('route has no authorization declaration');
    });
  });

  describe('project scoping (T-CP-3)', () => {
    it('jobs: lists contain only member projects; other projects are 404', async () => {
      const list = async (c: Client, q = '') =>
        (await c.req('GET', `/jobs${q}`)).json<{ items: { id: string; project: string }[] }>().items;
      expect((await list(p.opA.client)).map((j) => j.project)).toEqual(['alpha']);
      expect((await list(p.opB.client)).map((j) => j.project)).toEqual(['beta']);
      // Filtering by a project one cannot see yields nothing (no leak through the filter).
      expect(await list(p.opA.client, '?project=beta')).toEqual([]);
      expect((await list(p.admin.client)).map((j) => j.project).sort()).toEqual(['alpha', 'beta']);

      expect((await p.opA.client.req('GET', `/jobs/${ids.jobA}`)).statusCode).toBe(200);
      const hidden = await p.opA.client.req('GET', `/jobs/${ids.jobB}`);
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json()).toEqual({ error: 'job_not_found', message: 'Job not found.' });
    });

    it('approvals: lists and details are scoped; deciding needs a visible project', async () => {
      const items = (await p.viewerA.client.req('GET', '/approvals?status=pending')).json<{
        items: { id: string; project: string }[];
      }>().items;
      expect(items.map((i) => i.id)).toEqual([ids.approvalA]);
      expect((await p.viewerA.client.req('GET', `/approvals/${ids.approvalB}`)).statusCode).toBe(404);
      const deny = await p.opA.client.req('POST', `/approvals/${ids.approvalB}/deny`, { reason: 'no' });
      expect(deny.statusCode).toBe(404);
      expect(
        (await h.db.pool.query("SELECT 1 FROM approval_requests WHERE status <> 'pending'")).rowCount,
      ).toBe(0);
      // The refusal is audited under the approval's own audit action.
      expect((await auditRows('approval.decide', 'denied')).map((r) => r.target)).toContain(
        `approval:${ids.approvalB}`,
      );
    });

    it('budgets: project budgets of other projects and cross-project budgets are hidden', async () => {
      const usage = new UsageStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
      const owner = { id: p.owner.id, role: 'owner' as const, mfaAt: h.clock.now() };
      const mk = async (scopeType: 'project' | 'global', scopeValue: string | null) =>
        (
          await usage.createBudget(
            owner,
            { name: `b-${scopeType}`, metric: 'tokens', limit: 10, scopeType, scopeValue, window: 'day' },
            {},
          )
        ).budget.id;
      const alphaBudget = await mk('project', 'alpha');
      const globalBudget = await mk('global', null);
      const ids = async (c: Client) =>
        (await c.req('GET', '/budgets'))
          .json<{ items: { budget: { id: string } }[] }>()
          .items.map((i) => i.budget.id);
      expect(await ids(p.opA.client)).toEqual([alphaBudget]);
      expect(await ids(p.opB.client)).toEqual([]);
      expect(await ids(p.admin.client)).toEqual(expect.arrayContaining([alphaBudget, globalBudget]));
      expect((await p.opA.client.req('GET', `/budgets/${alphaBudget}`)).statusCode).toBe(200);
      expect((await p.opB.client.req('GET', `/budgets/${alphaBudget}`)).statusCode).toBe(404);
      expect((await p.opA.client.req('GET', `/budgets/${globalBudget}`)).statusCode).toBe(404);
    });

    it('the account role caps the membership role', async () => {
      const res = await p.cappedA.client.req('POST', `/approvals/${ids.approvalA}/deny`, { reason: 'no' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden' });
      expect((await p.cappedA.client.req('GET', `/approvals/${ids.approvalA}`)).statusCode).toBe(200);
    });

    it('context: project documents of other projects are invisible; global ones are shared', async () => {
      const titles = async (c: Client) =>
        (await c.req('GET', '/context/docs'))
          .json<{ items: { document: { namespace: string } }[] }>()
          .items.map((i) => i.document.namespace)
          .sort();
      expect(await titles(p.opA.client)).toEqual(['global', 'project:alpha']);
      expect(await titles(p.opB.client)).toEqual(['global', 'project:beta']);
      expect(await titles(p.owner.client)).toEqual(['global', 'project:alpha', 'project:beta']);
      expect((await p.opA.client.req('GET', `/context/docs/${ids.docB}`)).statusCode).toBe(404);
      expect((await p.opA.client.req('GET', `/context/docs/${ids.docB}/versions`)).statusCode).toBe(404);
      const write = await p.opA.client.req('POST', '/context/docs', {
        namespace: 'project:beta',
        kind: 'instructions',
        title: 'Sneaky',
        content: 'x',
      });
      expect(write.statusCode).toBe(404);
      expect((await p.opA.client.req('GET', '/context/bundle?project=beta&runtime=codex')).statusCode).toBe(
        404,
      );
      expect((await p.opA.client.req('GET', '/context/bundle?project=alpha&runtime=codex')).statusCode).toBe(
        200,
      );
    });

    it('a membership grant takes effect on the next request; revocation too', async () => {
      await stepUp(p.admin);
      const put = await p.admin.client.req('PUT', '/projects/beta/members', {
        userId: p.opA.id,
        role: 'viewer',
      });
      expect(put.statusCode, put.body).toBe(200);
      expect((await p.opA.client.req('GET', `/jobs/${ids.jobB}`)).statusCode).toBe(200);
      // viewer in beta: may read, may not decide.
      expect(
        (await p.opA.client.req('POST', `/approvals/${ids.approvalB}/deny`, { reason: 'no' })).statusCode,
      ).toBe(403);
      const del = await p.admin.client.req('DELETE', `/projects/beta/members?userId=${p.opA.id}`);
      expect(del.statusCode, del.body).toBe(200);
      expect((await p.opA.client.req('GET', `/jobs/${ids.jobB}`)).statusCode).toBe(404);
      expect((await auditRows('project.member.set', 'success')).at(-1)?.target).toBe('project:beta');
      expect((await auditRows('project.member.remove', 'success')).at(-1)?.metadata).toMatchObject({
        userId: p.opA.id,
        previousRole: 'viewer',
      });
    });
  });

  describe('projects API', () => {
    it('lists visible projects with the caller’s effective role', async () => {
      const mine = (await p.cappedA.client.req('GET', '/projects')).json<{
        items: { id: string; myRole: string }[];
      }>().items;
      expect(mine).toEqual([expect.objectContaining({ id: 'alpha', myRole: 'viewer' })]);
      const all = (await p.admin.client.req('GET', '/projects')).json<{ items: { id: string }[] }>().items;
      expect(all.map((x) => x.id)).toEqual(expect.arrayContaining(['alpha', 'beta']));
    });

    it('creating needs owner/admin and step-up; duplicates are 409', async () => {
      expect((await p.opA.client.req('POST', '/projects', { id: 'gamma', name: 'Gamma' })).statusCode).toBe(
        403,
      );
      h.clock.advance(11 * 60_000);
      const stale = await p.admin.client.req('POST', '/projects', { id: 'gamma', name: 'Gamma' });
      expect(stale.statusCode).toBe(403);
      expect(stale.json()).toMatchObject({ error: 'step_up_required' });
      await stepUp(p.admin);
      expect((await p.admin.client.req('POST', '/projects', { id: 'gamma', name: 'Gamma' })).statusCode).toBe(
        201,
      );
      expect((await p.admin.client.req('POST', '/projects', { id: 'gamma', name: 'G' })).statusCode).toBe(
        409,
      );
      expect((await auditRows('project.create', 'success')).at(-1)?.target).toBe('project:gamma');
    });

    it('members: readable by project members, not by others; owner/admin accounts get no memberships', async () => {
      const members = await p.viewerA.client.req('GET', '/projects/alpha/members');
      expect(members.statusCode).toBe(200);
      expect(members.json<{ items: { username: string }[] }>().items.map((m) => m.username)).toEqual(
        expect.arrayContaining(['opa', 'viewera', 'cappeda']),
      );
      const other = await p.viewerA.client.req('GET', '/projects/beta/members');
      expect(other.statusCode).toBe(404);
      expect(other.json()).toMatchObject({ error: 'project_not_found' });
      await stepUp(p.admin);
      const global = await p.admin.client.req('PUT', '/projects/alpha/members', {
        userId: p.owner.id,
        role: 'operator',
      });
      expect(global.statusCode).toBe(400);
      expect(global.json()).toMatchObject({ error: 'global_role' });
      expect(
        (await p.opA.client.req('PUT', '/projects/alpha/members', { userId: p.opB.id, role: 'viewer' }))
          .statusCode,
      ).toBe(403);
    });
  });

  describe('users API', () => {
    let created: { id: string; username: string; temporaryPassword: string };

    it('only the owner creates users (step-up); the temporary password is shown once and never stored', async () => {
      await stepUp(p.admin);
      expect(
        (await p.admin.client.req('POST', '/users', { username: 'newbie', role: 'operator' })).statusCode,
      ).toBe(403);
      await stepUp(p.owner);
      const res = await p.owner.client.req('POST', '/users', { username: 'newbie', role: 'operator' });
      expect(res.statusCode, res.body).toBe(201);
      created = res.json();
      expect(created.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
      const dup = await p.owner.client.req('POST', '/users', { username: 'newbie', role: 'viewer' });
      expect(dup.statusCode).toBe(409);
      // Never in the audit log, the logs, or the users list.
      const { rows } = await h.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_events WHERE metadata::text LIKE '%' || $1 || '%'",
        [created.temporaryPassword],
      );
      expect(rows[0]?.n).toBe(0);
      expect(h.logs.text).not.toContain(created.temporaryPassword);
      const list = await p.admin.client.req('GET', '/users');
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(created.temporaryPassword);
      expect(list.json<{ items: { username: string; totpEnrolled: boolean }[] }>().items).toContainEqual(
        expect.objectContaining({ username: 'newbie', totpEnrolled: false }),
      );
      expect((await auditRows('user.create', 'success')).at(-1)?.metadata).toMatchObject({
        username: 'newbie',
        role: 'operator',
      });
      expect((await p.opA.client.req('GET', '/users')).statusCode).toBe(403);
    });

    it('a created user must enrol TOTP at first login, like the bootstrap owner', async () => {
      const c = h.client();
      const login = await c.req('POST', '/auth/login', {
        username: 'newbie',
        password: created.temporaryPassword,
      });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({ status: 'enrollment_required' });
      expect((await c.req('GET', '/jobs')).statusCode).toBe(401);
    });

    it('role changes: owner only, never one’s own, effective immediately', async () => {
      await stepUp(p.owner);
      expect(
        (await p.owner.client.req('PUT', `/users/${p.owner.id}/role`, { role: 'viewer' })).statusCode,
      ).toBe(409);
      const res = await p.owner.client.req('PUT', `/users/${p.opB.id}/role`, { role: 'viewer' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ role: 'viewer' });
      expect((await p.opB.client.req('GET', '/approvals')).statusCode).toBe(200);
      expect(
        (await p.opB.client.req('POST', `/approvals/${ids.approvalB}/deny`, { reason: 'no' })).statusCode,
      ).toBe(403);
      expect((await auditRows('user.role.change', 'success')).at(-1)?.metadata).toMatchObject({
        previousRole: 'operator',
        role: 'viewer',
      });
      expect((await auditRows('user.role.change', 'denied')).at(-1)?.metadata).toMatchObject({
        reason: 'self_change',
      });
    });

    it('disable ends every session and blocks login; enable restores it; the last owner stays', async () => {
      await stepUp(p.owner);
      const res = await p.owner.client.req('POST', `/users/${p.viewerA.id}/disable`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ disabled: true });
      expect((await p.viewerA.client.req('GET', '/auth/session')).statusCode).toBe(401);
      h.clock.advance(30_000);
      const login = await h.client().req('POST', '/auth/login', { username: 'viewera', password: PW });
      expect(login.statusCode).toBe(401);
      expect(login.json()).toMatchObject({ error: 'invalid_credentials' });
      expect((await auditRows('auth.login.password', 'denied')).at(-1)?.metadata).toMatchObject({
        reason: 'disabled',
      });

      expect((await p.owner.client.req('POST', `/users/${p.viewerA.id}/enable`)).statusCode).toBe(200);
      const again = await h.client().req('POST', '/auth/login', { username: 'viewera', password: PW });
      expect(again.statusCode).toBe(200);

      // Disabling oneself is refused.
      expect((await p.owner.client.req('POST', `/users/${p.owner.id}/disable`)).statusCode).toBe(409);
    });

    it('the last active owner can never be demoted or disabled (e.g. two owners demoting each other)', async () => {
      // Through the API the caller is always another active owner, so this guards the race where two
      // owners demote each other concurrently: the second change runs after the first committed.
      const directory = new Directory({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now) });
      const { rows } = await h.db.pool.query<{ id: string }>(
        "SELECT id FROM users WHERE role = 'owner' AND disabled_at IS NULL",
      );
      expect(rows.map((r) => r.id)).toEqual([p.owner.id]);
      const meta = { ip: null, userAgent: null };
      await expect(directory.setRole({ id: p.admin.id }, p.owner.id, 'admin', meta)).rejects.toMatchObject({
        statusCode: 409,
        code: 'last_owner',
      });
      await expect(directory.disable({ id: p.admin.id }, p.owner.id, meta)).rejects.toMatchObject({
        statusCode: 409,
        code: 'last_owner',
      });
      expect((await auditRows('user.disable', 'denied')).at(-1)?.metadata).toMatchObject({
        reason: 'last_owner',
      });
    });
  });
});
