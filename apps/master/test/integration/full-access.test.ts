import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Cluster, PW } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin } from '../helpers/harness.js';
import { JOB_CAPS, jobSpec, PROJECT } from '../helpers/job-worker.js';

/**
 * p5-full-access (ADR-0020) against a real master (Postgres, dispatch loop) and real worker daemons with the fake
 * runtime:
 *  - `allowAutoApprove` on `PUT /projects/:id/execution`: admin + always-fresh step-up, audited with before/after,
 *    owners/admins notified (critical when switched on), an absent field keeps the value (older clients);
 *  - submission refuses `allow-all` without the opt-in and for an untrusted source (clear issue codes);
 *  - placement: workers without `full-access-v1` are never chosen (`approval_policy_unsupported`); an allow-all job
 *    runs to SUCCEEDED on a `full-access-v1` worker; a withdrawn opt-in stops placement (`auto_approve_not_allowed`);
 *  - the composer preview's one-switch "Full access" says exactly what is missing.
 */
describeIntegration('full access (integration, p5-full-access)', { timeout: 120_000 }, () => {
  const c = new Cluster();
  let operator: Client;

  const put = (body: unknown, who: Client = c.admin) =>
    who.req('PUT', `/projects/${PROJECT}/execution`, body);
  const allowAll = (over: Record<string, unknown> = {}) =>
    jobSpec({ sandboxProfile: 'host-restricted', approvalPolicy: 'allow-all', ...over });

  async function audits(): Promise<Record<string, unknown>[]> {
    const { rows } = await c.h.db.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = 'project.execution.update' AND outcome = 'success' ORDER BY id",
    );
    return rows.map((r) => r.metadata);
  }

  /** Codes of the latest scheduler verdict, waiting or infeasible. */
  async function scheduleCodes(id: string): Promise<string[]> {
    return (await c.detail(id)).orchestration?.schedule?.reasons.map((r) => r.code) ?? [];
  }

  async function setPolicy(p: { hostExecution: boolean; unconfined: boolean; allowAutoApprove: boolean }) {
    await c.stepUp();
    const res = await put(p);
    expect(res.statusCode, res.body).toBe(200);
  }

  beforeAll(async () => {
    await c.start(12);
    const op = await c.h.createUser('oper1', PW, 'operator');
    await c.h.grant(op, [PROJECT], 'operator');
    const o = await enroll(c.h, 'oper1', PW);
    operator = await fullLogin(c.h, 'oper1', PW, o.secret);
  });
  afterEach(async () => {
    await c.cancelAll();
    await c.stopWorkers();
  });
  afterAll(async () => {
    await c.stop();
  });

  it('allowAutoApprove: admin + always-fresh step-up, audited, owners notified; absent keeps the value', async () => {
    const all = { hostExecution: true, unconfined: true, allowAutoApprove: true };
    expect((await put(all, operator)).statusCode).toBe(403);
    c.h.clock.advance(11 * 60_000);
    const stale = await put(all);
    expect(stale.statusCode).toBe(403);
    expect(stale.body).toContain('step_up_required');
    expect((await c.admin.req('GET', `/projects/${PROJECT}/execution`)).json()).toEqual({
      project: PROJECT,
      hostExecution: false,
      unconfined: false,
      allowAutoApprove: false,
      safeCommands: 'read-only',
      subtasks: false,
      delegationRuntimes: [],
    });

    // The one-switch "Full access" preset of the panel: host + unconfined + auto-approve in one save.
    await c.stepUp();
    const on = await put(all);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toEqual({
      project: PROJECT,
      ...all,
      safeCommands: 'read-only',
      subtasks: false,
      delegationRuntimes: [],
    });
    expect(await audits()).toEqual([
      expect.objectContaining({
        before: {
          hostExecution: false,
          unconfined: false,
          allowAutoApprove: false,
          safeCommands: 'read-only',
          subtasks: false,
          delegationRuntimes: [],
        },
        after: { ...all, safeCommands: 'read-only', subtasks: false, delegationRuntimes: [] },
      }),
    ]);
    await c.h.app.notifications.consumeOutbox();
    const notes = await c.h.db.pool.query<{ severity: string; title: string; body: string }>(
      "SELECT DISTINCT severity, title, body FROM notifications WHERE kind = 'project.execution'",
    );
    expect(notes.rows).toEqual([
      expect.objectContaining({ severity: 'critical', title: `FULL ACCESS enabled for project ${PROJECT}` }),
    ]);
    expect(notes.rows[0]?.body).toContain('still need an approval');

    // An older client (no allowAutoApprove in the body) keeps the current value; no change, no notification.
    await c.stepUp();
    expect((await put({ hostExecution: true, unconfined: true })).json()).toMatchObject({
      allowAutoApprove: true,
    });
    await c.h.app.notifications.consumeOutbox();
    expect(
      (await c.h.db.pool.query("SELECT DISTINCT title FROM notifications WHERE kind = 'project.execution'"))
        .rowCount,
    ).toBe(1);
  });

  it('submission refuses allow-all without the opt-in or for an untrusted source', async () => {
    await setPolicy({ hostExecution: true, unconfined: false, allowAutoApprove: false });
    const notAllowed = await c.admin.req('POST', '/jobs', { project: PROJECT, spec: allowAll() });
    expect(notAllowed.statusCode).toBe(400);
    expect(notAllowed.body).toContain('spec.approvalPolicy:auto_approve_not_allowed');

    await setPolicy({ hostExecution: true, unconfined: false, allowAutoApprove: true });
    const untrusted = await c.admin.req('POST', '/jobs', {
      project: PROJECT,
      spec: allowAll({ sandboxProfile: 'container', sourceTrust: 'untrusted' }),
    });
    expect(untrusted.statusCode).toBe(400);
    expect(untrusted.body).toContain('spec.sourceTrust:auto_approve_requires_trusted_source');
    expect(untrusted.body).not.toContain('auto_approve_not_allowed');
  });

  it('placement: old builds are never chosen; a full-access-v1 worker runs it; withdrawing the opt-in stops placement', async () => {
    await setPolicy({ hostExecution: true, unconfined: false, allowAutoApprove: true });
    const old = await c.newWorker({ capabilities: { ...JOB_CAPS, features: [] } });
    // Only an older build: never chosen — the job is infeasible with a reason that says why.
    const first = await c.submit(allowAll());
    await expect
      .poll(() => scheduleCodes(first), { timeout: 20_000 })
      .toContain('approval_policy_unsupported');
    expect((await c.detail(first)).attempts).toEqual([]);

    const fresh = await c.newWorker({ capabilities: { ...JOB_CAPS, features: ['full-access-v1'] } });
    const second = await c.submit(allowAll());
    await expect.poll(() => c.state(second), { timeout: 30_000 }).toBe('SUCCEEDED');
    const d = await c.detail(second);
    expect(d.attempts.map((a) => a.workerId)).toEqual([fresh.id]);
    expect(d.attempts.map((a) => a.workerId)).not.toContain(old.id);

    // The opt-in is re-checked at every placement, not only at submission.
    await c.stopWorkers();
    const third = await c.submit(allowAll());
    await c.h.db.pool.query('UPDATE projects SET auto_approve_execution = false WHERE id = $1', [PROJECT]);
    await c.newWorker({ capabilities: { ...JOB_CAPS, features: ['full-access-v1'] } });
    await expect.poll(() => scheduleCodes(third), { timeout: 20_000 }).toContain('auto_approve_not_allowed');
    expect((await c.detail(third)).attempts).toEqual([]);
  });

  it('composer preview: the Full access switch names exactly what is missing', async () => {
    await setPolicy({ hostExecution: true, unconfined: false, allowAutoApprove: false });
    const preview = async (body: Record<string, unknown> = {}) =>
      (
        await c.admin.req('POST', '/jobs/placement-preview', {
          project: PROJECT,
          runtime: 'codex',
          sandboxProfile: 'unconfined',
          sourceTrust: 'trusted',
          approvalPolicy: 'allow-all',
          ...body,
        })
      ).json<{
        autoApproveExecution: boolean;
        fullAccess: { available: boolean; reasons: { code: string }[]; workers: string[] };
        issues: { code: string }[];
      }>();
    const off = await preview();
    expect(off.autoApproveExecution).toBe(false);
    expect(off.fullAccess.available).toBe(false);
    expect(off.fullAccess.reasons.map((r) => r.code)).toEqual([
      'unconfined_not_opted_in',
      'auto_approve_not_allowed',
      'unconfined_not_enabled',
    ]);
    expect(off.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['unconfined_not_opted_in', 'auto_approve_not_allowed']),
    );
    expect((await preview({ sourceTrust: 'untrusted' })).issues.map((i) => i.code)).toContain(
      'auto_approve_requires_trusted_source',
    );

    await setPolicy({ hostExecution: true, unconfined: true, allowAutoApprove: true });
    // A worker with unconfined ready but an older build: the switch says the build is the problem.
    await c.newWorker({
      capabilities: {
        ...JOB_CAPS,
        sandboxProfiles: ['host-restricted', 'unconfined'],
        features: ['sandbox-ops-v1'],
      },
    });
    expect((await preview()).fullAccess.reasons.map((r) => r.code)).toEqual(['approval_policy_unsupported']);
    const ready = await c.newWorker({
      capabilities: {
        ...JOB_CAPS,
        sandboxProfiles: ['host-restricted', 'unconfined'],
        features: ['sandbox-ops-v1', 'full-access-v1'],
      },
    });
    const on = await preview();
    expect(on.fullAccess).toEqual({ available: true, reasons: [], workers: [ready.id] });
    expect(on.autoApproveExecution).toBe(true);
    expect(on.issues).toEqual([]);
  });
});
