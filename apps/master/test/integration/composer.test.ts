import { afterAll, beforeAll, expect, it } from 'vitest';
import { Cluster, PW } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { enroll, fullLogin } from '../helpers/harness.js';
import { JOB_CAPS, jobSpec, PROJECT, REPO_URL } from '../helpers/job-worker.js';

interface Preview {
  issues: { code: string }[];
  placement: {
    verdict: string;
    candidates: { workerId: string }[];
    rejected: { workerId: string; reasons: { code: string; message: string }[] }[];
    summary: { code: string; workers: string[] }[];
  } | null;
  runtimes: { runtime: string; verdict: string; eligible: string[]; summary: { code: string }[] }[];
  modelProfiles: { name: string; isDefault: boolean; workers: string[] }[];
  sandbox: { profile: string; workers: string[] }[];
  limits: Record<string, number>;
  workers: { id: string; tools: string[] }[];
}

interface Schedule {
  id: string;
  state: string;
  nextRunAt: string | null;
  lastStatus: string | null;
  lastJobId: string | null;
  lastRunId: string | null;
  lastError: string | null;
  runCount: number;
}

/**
 * p5-composer (docs/design/p5-composer.md): placement preview against real workers (no side effects), the
 * tools / worker-affinity constraints honoured by real dispatch, the workflow definition read, and
 * schedules (step-up, cron validation, at-most-once firing, creator re-check, cancel, audit).
 */
describeIntegration(
  'job composer: placement preview, constraints, schedules (integration)',
  { timeout: 240_000 },
  () => {
    const c = new Cluster();
    let a = '';
    let b = '';

    beforeAll(async () => {
      // No background loop: the test drives orchestrator.tick() (the schedule sweeper is a tick step).
      await c.start(0, { loop: false });
    });
    /** Two workers, paired once (pairing uses expect.poll, so not from beforeAll); b also reports docker. */
    async function ensureWorkers(): Promise<void> {
      if (a === '') ({ id: a } = await c.newWorker());
      if (b === '') {
        ({ id: b } = await c.newWorker({
          capabilities: { ...JOB_CAPS, tools: [...JOB_CAPS.tools, { name: 'docker', version: '27' }] },
        }));
      }
    }
    afterAll(async () => {
      await c.stop();
    });

    async function preview(body: Record<string, unknown>): Promise<Preview> {
      await ensureWorkers();
      const res = await c.admin.req('POST', '/jobs/placement-preview', { project: PROJECT, ...body });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Preview>();
    }

    it('previews placement over the real fleet with reasons, and has no side effects', async () => {
      const counts = async () =>
        (
          await c.h.db.pool.query<{ jobs: number; status: number; leases: number }>(
            `SELECT (SELECT count(*)::int FROM jobs) AS jobs, (SELECT count(*)::int FROM job_schedule_status) AS status,
                  (SELECT count(*)::int FROM leases) AS leases`,
          )
        ).rows[0];
      const before = await counts();
      const p = await preview({
        runtime: 'codex',
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
      });
      expect(p.placement?.verdict).toBe('placed');
      expect(p.placement?.candidates.map((x) => x.workerId).sort()).toEqual([a, b].sort());
      // Every runtime is evaluated: only codex is installed on these workers.
      const pi = p.runtimes.find((r) => r.runtime === 'pi');
      expect(pi?.verdict).toBe('infeasible');
      expect(pi?.summary.map((s) => s.code)).toContain('runtime_not_installed');
      expect(p.runtimes.find((r) => r.runtime === 'codex')?.eligible.sort()).toEqual([a, b].sort());
      expect(p.sandbox.find((s) => s.profile === 'host-restricted')?.workers.sort()).toEqual([a, b].sort());
      expect(p.workers.find((w) => w.id === b)?.tools).toContain('docker');
      // The project has not opted in to host execution, and an unspecified source is untrusted.
      expect(
        (await preview({ runtime: 'codex', sandboxProfile: 'host-restricted' })).issues.map((i) => i.code),
      ).toEqual(['untrusted_needs_container', 'host_execution_not_enabled']);
      expect(await counts()).toEqual(before);
    });

    it('explains tool and worker-affinity constraints per worker', async () => {
      const tools = await preview({
        runtime: 'codex',
        sandboxProfile: 'host-restricted',
        requirements: { tools: ['docker'] },
      });
      expect(tools.placement?.candidates.map((x) => x.workerId)).toEqual([b]);
      const ra = tools.placement?.rejected.find((r) => r.workerId === a);
      expect(ra?.reasons.map((r) => r.code)).toEqual(['tool_missing']);
      expect(ra?.reasons[0]?.message).toContain('docker');

      const pinned = await preview({
        runtime: 'codex',
        sandboxProfile: 'host-restricted',
        requirements: { workers: [a], tools: ['docker'] },
      });
      expect(pinned.placement?.verdict).toBe('infeasible');
      expect(pinned.placement?.summary.map((s) => s.code).sort()).toEqual([
        'tool_missing',
        'worker_not_selected',
      ]);

      const bad = await c.admin.req('POST', '/jobs/placement-preview', {
        project: PROJECT,
        requirements: { tools: ['rm -rf'] },
      });
      expect(bad.statusCode).toBe(400);
      const missing = await c.admin.req('POST', '/jobs/placement-preview', { project: 'no-such-project' });
      expect(missing.statusCode).toBe(404);
    });

    it('real dispatch honours worker affinity and tool requirements', async () => {
      await ensureWorkers();
      const id = await c.submit(jobSpec({ requirements: { workers: [b] } }));
      await expect.poll(async () => (await c.detail(id)).attempts[0]?.workerId, { timeout: 30_000 }).toBe(b);
      const id2 = await c.submit(jobSpec({ requirements: { tools: ['docker'] } }));
      await expect.poll(async () => (await c.detail(id2)).attempts[0]?.workerId, { timeout: 30_000 }).toBe(b);
      await c.cancelAll();
    });

    it('affinity by machine name resolves to the worker id; an unknown machine is refused at submission', async () => {
      // A chat draft may pin a job to "linux-worker-1" (the name); placement must match it, not only the id.
      await ensureWorkers();
      // Test workers share the host's name, so give b its own (a shared name is refused as ambiguous).
      const renamed = await c.admin.req('PUT', `/workers/${b}/name`, { name: 'build-box-b' });
      expect(renamed.statusCode, renamed.body).toBe(200);
      // p21-pin-by-name: the card's placement preview matches the name too — it said "No machine
      // can run this target … pinned to linux-worker-1" for a job that then ran there.
      const byName = await preview({
        runtime: 'codex',
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
        requirements: { workers: ['BUILD-BOX-B'] },
      });
      expect(byName.placement?.verdict).toBe('placed');
      expect(byName.placement?.candidates.map((x) => x.workerId)).toEqual([b]);
      expect(
        (
          await preview({
            runtime: 'codex',
            sandboxProfile: 'host-restricted',
            sourceTrust: 'trusted',
            requirements: { workers: ['no-such-machine'] },
          })
        ).issues.map((i) => i.code),
      ).toContain('unknown_worker');
      const id = await c.submit(jobSpec({ requirements: { workers: ['BUILD-BOX-B'] } }));
      await expect.poll(async () => (await c.detail(id)).attempts[0]?.workerId, { timeout: 30_000 }).toBe(b);
      const bad = await c.admin.req('POST', '/jobs', {
        project: PROJECT,
        spec: jobSpec({ requirements: { workers: ['no-such-machine'] } }),
      });
      expect(bad.statusCode, bad.body).toBe(400);
      expect(bad.body).toContain('unknown_worker');
      await c.cancelAll();
    });

    it('reads a workflow definition without its prompts', async () => {
      const res = await c.admin.req('POST', '/workflows', {
        project: PROJECT,
        definition: {
          name: 'composer-wf',
          inputs: { task: { required: true, description: 'What to build' } },
          defaults: {
            runtime: 'codex',
            sandboxProfile: 'host-restricted',
            sourceTrust: 'trusted',
            limits: { maxDurationSec: 600 },
            repository: { url: REPO_URL, baseRef: 'main' },
          },
          nodes: [
            { id: 'build', role: 'executor', prompt: 'SECRET-PROMPT-TEXT build {{inputs.task}}' },
            { id: 'check', role: 'verifier', prompt: 'verify it', approval: { approverRole: 'admin' } },
          ],
          edges: [{ from: 'build', to: 'check' }],
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json<{ id: string }>().id;
      const d = await c.admin.req('GET', `/workflows/${id}`);
      expect(d.statusCode, d.body).toBe(200);
      expect(d.body).not.toContain('SECRET-PROMPT-TEXT');
      expect(d.json()).toMatchObject({
        name: 'composer-wf',
        inputs: [{ name: 'task', required: true, description: 'What to build' }],
        nodes: [
          { id: 'build', role: 'executor', runtime: 'codex', gate: false },
          { id: 'check', role: 'verifier', gate: true },
        ],
        edges: [{ from: 'build', to: 'check' }],
        defaults: { runtime: 'codex', repository: { url: REPO_URL, baseRef: 'main' } },
      });
      expect((await c.admin.req('GET', '/workflows/00000000-0000-4000-8000-000000000000')).statusCode).toBe(
        404,
      );
    });

    /** Cancels what is still open and lets the reconciler (no background loop here) confirm it. */
    async function settle(): Promise<void> {
      const open = "SELECT id FROM jobs WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')";
      for (const r of (await c.h.db.pool.query<{ id: string }>(open)).rows) {
        await c.admin.req('POST', `/jobs/${r.id}/cancel`, { reason: 'test cleanup' });
      }
      await expect
        .poll(
          async () => {
            await c.h.app.orchestrator.tick();
            return (await c.h.db.pool.query(open)).rowCount;
          },
          { timeout: 45_000 },
        )
        .toBe(0);
    }

    /** Moves the fake clock; sessions idle out after 30 min, so long jumps sign the admin in again. */
    async function advance(ms: number): Promise<void> {
      c.h.clock.advance(ms);
      if (ms >= 20 * 60_000) c.admin = await fullLogin(c.h, 'owner1', PW, c.secret);
    }

    async function createSchedule(body: Record<string, unknown>): Promise<Schedule> {
      await c.stepUp();
      const res = await c.admin.req('POST', '/schedules', { project: PROJECT, name: 'nightly', ...body });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<Schedule>();
    }

    async function scheduleRow(id: string): Promise<Schedule> {
      const res = await c.admin.req('GET', `/schedules?project=${PROJECT}`);
      expect(res.statusCode).toBe(200);
      const s = res.json<{ items: Schedule[] }>().items.find((x) => x.id === id);
      if (s === undefined) throw new Error('schedule not listed');
      return s;
    }

    it('validates cron expressions and needs a fresh step-up to create a schedule', async () => {
      const ok = await c.admin.req(
        'GET',
        `/schedules/cron-preview?cron=${encodeURIComponent('0 3 * * 1-5')}`,
      );
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json<{ nextRuns: string[] }>().nextRuns).toHaveLength(5);
      for (const bad of ['* * * * *', '61 * * * *', 'every day']) {
        const res = await c.admin.req('GET', `/schedules/cron-preview?cron=${encodeURIComponent(bad)}`);
        expect(res.statusCode, bad).toBe(400);
      }
      c.h.clock.advance(11 * 60_000); // step-up window (10 min) passed
      const res = await c.admin.req('POST', '/schedules', {
        project: PROJECT,
        name: 'x',
        target: { kind: 'job', spec: jobSpec() },
        when: { kind: 'cron', cron: '0 3 * * *' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('step_up_required');
      // Invalid specs are refused with paths and codes only (never the prompt).
      await c.stepUp();
      const invalid = await c.admin.req('POST', '/schedules', {
        project: PROJECT,
        name: 'x',
        target: { kind: 'job', spec: jobSpec({ prompt: '', limits: { maxDurationSec: 0 } }) },
        when: { kind: 'cron', cron: '0 3 * * *' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json<{ message: string }>().message).toContain('spec.limits.maxDurationSec');
    });

    it('fires a cron schedule at most once per occurrence and re-arms it', async () => {
      const s = await createSchedule({
        target: { kind: 'job', spec: jobSpec({ prompt: 'scheduled run' }), priority: 5 },
        when: { kind: 'cron', cron: '0 * * * *' },
      });
      expect(s.state).toBe('active');
      const due = Date.parse(s.nextRunAt ?? '');
      await advance(due - c.h.clock.now().getTime() + 1_000);
      // Two sweepers racing (two ticks / two replicas): one job.
      const fired = await Promise.all([c.h.app.schedules.fireDue(), c.h.app.schedules.fireDue()]);
      expect(fired.reduce((x, y) => x + y, 0)).toBe(1);
      await c.h.app.orchestrator.tick();
      const after = await scheduleRow(s.id);
      expect(after).toMatchObject({ state: 'active', lastStatus: 'created', runCount: 1 });
      expect(Date.parse(after.nextRunAt ?? '')).toBe(due + 3_600_000);
      const job = await c.h.db.pool.query<{ created_by_id: string; priority: number; prompt: string }>(
        "SELECT created_by_id, priority, spec->>'prompt' AS prompt FROM jobs WHERE id = $1",
        [after.lastJobId],
      );
      expect(job.rows[0]).toMatchObject({ priority: 5, prompt: 'scheduled run' });
      const audit = await c.h.db.pool.query<{ action: string; outcome: string }>(
        'SELECT action, outcome FROM audit_events WHERE target = $1 ORDER BY id',
        [`automation:${s.id}`],
      );
      // p6-automations: a schedule is a cron automation (audited as one).
      expect(audit.rows).toEqual([
        { action: 'automation.create', outcome: 'success' },
        { action: 'automation.fire', outcome: 'success' },
      ]);
      // Not due again until the next hour.
      expect(await c.h.app.schedules.fireDue()).toBe(0);
      const cancel = await c.admin.req('DELETE', `/schedules/${s.id}`);
      expect(cancel.statusCode, cancel.body).toBe(200);
      expect(cancel.json<Schedule>()).toMatchObject({ state: 'cancelled', nextRunAt: null });
      expect((await c.admin.req('DELETE', `/schedules/${s.id}`)).statusCode).toBe(409);
      await advance(3_600_000);
      expect(await c.h.app.schedules.fireDue()).toBe(0);
      await settle();
    });

    it('a one-shot workflow schedule starts the run once; a creator who lost access stops their schedules', async () => {
      const wf = await c.h.db.pool.query<{ id: string }>(
        "SELECT id FROM workflow_definitions WHERE name = 'composer-wf'",
      );
      const at = new Date(c.h.clock.now().getTime() + 30 * 60_000).toISOString();
      const s = await createSchedule({
        target: { kind: 'workflow', workflowId: wf.rows[0]?.id, inputs: { task: 'scheduled' } },
        when: { kind: 'at', at },
      });
      await advance(31 * 60_000);
      expect(await c.h.app.schedules.fireDue()).toBe(1);
      const done = await scheduleRow(s.id);
      expect(done).toMatchObject({ state: 'done', lastStatus: 'created', nextRunAt: null });
      expect(done.lastRunId).toMatch(/^[0-9a-f-]{36}$/);

      // An operator member creates a schedule, then loses the membership: the next fire is refused.
      const opId = await c.h.createUser('op.sched', PW, 'operator');
      await c.h.grant(opId, [PROJECT], 'operator');
      const { secret } = await enroll(c.h, 'op.sched', PW);
      c.h.clock.advance(30_000);
      const op = await fullLogin(c.h, 'op.sched', PW, secret);
      const created = await op.req('POST', '/schedules', {
        project: PROJECT,
        name: 'op',
        target: { kind: 'job', spec: jobSpec() },
        when: { kind: 'at', at: new Date(c.h.clock.now().getTime() + 10 * 60_000).toISOString() },
      });
      expect(created.statusCode, created.body).toBe(201);
      const opSchedule = created.json<Schedule>();
      await c.h.db.pool.query('DELETE FROM project_memberships WHERE user_id = $1', [opId]);
      const jobsBefore = (await c.h.db.pool.query('SELECT 1 FROM jobs')).rowCount;
      await advance(11 * 60_000);
      expect(await c.h.app.schedules.fireDue()).toBe(1);
      const failed = await scheduleRow(opSchedule.id);
      expect(failed.state).toBe('failed');
      expect(failed.lastError).toContain('may no longer submit jobs');
      expect((await c.h.db.pool.query('SELECT 1 FROM jobs')).rowCount).toBe(jobsBefore);
      const denied = await c.h.db.pool.query<{ outcome: string }>(
        "SELECT outcome FROM audit_events WHERE target = $1 AND action = 'automation.fire'",
        [`automation:${opSchedule.id}`],
      );
      expect(denied.rows.map((r) => r.outcome)).toEqual(['denied']);
      await settle();
    });
    it('names capability_unverified for a worker whose runtime capabilities are unverified (p5-first-live-fixes)', async () => {
      await ensureWorkers();
      const { id: u } = await c.newWorker({
        capabilities: {
          ...JOB_CAPS,
          runtimes: JOB_CAPS.runtimes.map((r) => ({
            ...r,
            capabilities: { ...r.capabilities, approval: { status: 'unverified' } },
          })),
        },
      });
      const p = await preview({
        runtime: 'codex',
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
      });
      const rejected = p.placement?.rejected.find((r) => r.workerId === u);
      expect(rejected?.reasons.map((r) => r.code)).toEqual(['capability_unverified']);
      expect(rejected?.reasons[0]?.message).toContain('Settings → Runtimes');
      // Nobody is asked under deny-sensitive: approval is not needed, so the worker is a candidate.
      const deny = await preview({
        runtime: 'codex',
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
        approvalPolicy: 'deny-sensitive',
      });
      expect(deny.placement?.candidates.map((x) => x.workerId)).toContain(u);
    });
  },
);
