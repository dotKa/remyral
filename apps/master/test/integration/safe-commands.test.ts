import type { FakeScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../src/approvals/index.js';
import { AuditLog } from '../../src/audit/audit.js';
import { JobStore } from '../../src/jobs/index.js';
import { Cluster } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { jobSpec, PROJECT } from '../helpers/job-worker.js';

/**
 * p6-safe-auto-approve end to end: a real master and a real worker daemon with the fake runtime, whose scripted shell
 * tool call goes through the same claim builder as the real adapters (`safeCommandClaim`, real filesystem).
 *  - default mode (read-only): `git status; git log` of an ask-sensitive job is approved by the master, audited as
 *    `approval.auto_safe` with the command and the matched rules, and the job finishes without a human;
 *  - an unsafe command still waits for a human (the request's audit says why the claim did not count);
 *  - a workspace write waits under read-only and is auto-approved after the admin enables workspace writes;
 *  - mode off and `ask-all` jobs always ask;
 *  - the master never trusts the claim: a forged verdict or an unsafe command inside a claim opens a request.
 */

function shellScript(command: string, tool = 'Bash'): FakeScript {
  return () => [
    {
      kind: 'approval',
      approvalId: 'sh-1',
      action: tool,
      description: `${tool}: ${command}`,
      risk: 'high',
      shell: { tool, command, shells: ['posix'] },
    },
    { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'finished' } },
  ];
}

describeIntegration('safe commands (integration, p6-safe-auto-approve)', { timeout: 120_000 }, () => {
  const c = new Cluster();

  async function autoSafeAudits(jobId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await c.h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'approval.auto_safe' AND target = $1 ORDER BY id`,
      [`job:${jobId}`],
    );
    return rows.map((r) => r.metadata);
  }

  async function pendingRequest(jobId: string): Promise<{ id: string; requestedAction: string } | undefined> {
    return (await c.admin.req('GET', '/approvals?status=pending'))
      .json<{ items: { id: string; jobId: string; requestedAction: string }[] }>()
      .items.find((r) => r.jobId === jobId);
  }

  async function requestAudit(jobId: string): Promise<Record<string, unknown> | undefined> {
    const { rows } = await c.h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'approval.request' AND outcome = 'success'
          AND metadata->>'jobId' = $1 ORDER BY id`,
      [jobId],
    );
    return rows[0]?.metadata;
  }

  async function toolResult(jobId: string): Promise<string> {
    const { rows } = await c.h.db.pool.query<{ payload: unknown }>(
      `SELECT payload FROM worker_inbox WHERE job_id = $1 AND payload->'event'->>'kind' = 'tool_result'`,
      [jobId],
    );
    return JSON.stringify(rows.map((r) => r.payload));
  }

  async function setMode(safeCommands: string): Promise<void> {
    await c.stepUp();
    const res = await c.admin.req('PUT', `/projects/${PROJECT}/execution`, {
      hostExecution: false,
      unconfined: false,
      safeCommands,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ safeCommands });
  }

  async function waitsForHuman(jobId: string): Promise<string> {
    await expect.poll(() => pendingRequest(jobId), { timeout: 20_000 }).toBeDefined();
    expect(await c.state(jobId)).toBe('RUNNING');
    expect(await autoSafeAudits(jobId)).toEqual([]);
    return (await pendingRequest(jobId))?.id ?? '';
  }

  beforeAll(async () => {
    await c.start(13);
  });
  afterEach(async () => {
    await c.cancelAll();
    await c.stopWorkers();
  });
  afterAll(async () => {
    await c.stop();
  });

  it('defaults to read-only for a project that never chose', async () => {
    const res = await c.admin.req('GET', `/projects/${PROJECT}/execution`);
    expect(res.json()).toEqual({
      project: PROJECT,
      hostExecution: false,
      unconfined: false,
      allowAutoApprove: false,
      safeCommands: 'read-only',
      subtasks: false,
      delegationRuntimes: [],
    });
  });

  it('auto-approves `git status; git log` of an ask-sensitive job and audits it', async () => {
    await c.newWorker({ fake: { script: shellScript('git status; git log --oneline -n 3') } });
    const jobId = await c.submit();
    await expect.poll(() => c.state(jobId), { timeout: 30_000 }).toBe('SUCCEEDED');
    expect(await autoSafeAudits(jobId)).toEqual([
      expect.objectContaining({
        jobId,
        action: 'runtime.dangerous_tool',
        requestedAction: 'Bash',
        tool: 'Bash',
        command: 'git status; git log --oneline -n 3',
        shells: 'posix',
        verdict: 'read',
        rules: 'git.read',
        mode: 'read-only',
      }),
    ]);
    expect(await toolResult(jobId)).toContain('Bash approved');
    const rows = await c.h.db.pool.query('SELECT 1 FROM approval_requests WHERE job_id = $1', [jobId]);
    expect(rows.rowCount).toBe(0);
  });

  it('an unsafe command still waits for a human; the audit says why the claim did not count', async () => {
    await c.newWorker({ fake: { script: shellScript('rm -rf src') } });
    const jobId = await c.submit();
    await waitsForHuman(jobId);
    // The worker made no claim at all (not proven safe): nothing to check on the master either.
    expect(await requestAudit(jobId)).not.toHaveProperty('safeCheck');
  });

  it('a workspace write waits under read-only and is auto-approved with workspace writes', async () => {
    await c.newWorker({ fake: { script: shellScript('mkdir -p out && date > out/date.md') } });
    const first = await c.submit();
    await waitsForHuman(first);
    expect(await requestAudit(first)).toMatchObject({ safeCheck: 'mode_read_only' });
    await c.cancelAll();

    await setMode('workspace-writes');
    try {
      const second = await c.submit();
      await expect.poll(() => c.state(second), { timeout: 30_000 }).toBe('SUCCEEDED');
      expect(await autoSafeAudits(second)).toEqual([
        expect.objectContaining({
          verdict: 'workspace_write',
          mode: 'workspace-writes',
          rules: 'posix.date,posix.mkdir,redirect.write',
        }),
      ]);
    } finally {
      await setMode('read-only');
    }
  });

  it('mode off asks for everything', async () => {
    await setMode('off');
    try {
      await c.newWorker({ fake: { script: shellScript('git status') } });
      const jobId = await c.submit();
      await waitsForHuman(jobId);
      expect(await requestAudit(jobId)).toMatchObject({ safeCheck: 'mode_off' });
    } finally {
      await setMode('read-only');
    }
  });

  it('an ask-all job asks even for a safe command (no claim is made)', async () => {
    await c.newWorker({ fake: { script: shellScript('git status') } });
    const jobId = await c.submit(jobSpec({ approvalPolicy: 'ask-all' }));
    await waitsForHuman(jobId);
  });

  describe('the master never trusts the claim', () => {
    it('re-classifies the command and compares the verdict', async () => {
      await c.newWorker({ fake: { script: shellScript('rm -rf src') } });
      const jobId = await c.submit();
      await waitsForHuman(jobId);
      const { rows } = await c.h.db.pool.query<{
        current_attempt_id: string;
        lease_epoch: number;
        worker_id: string;
      }>(
        `SELECT j.current_attempt_id, j.lease_epoch, l.worker_id FROM jobs j
           JOIN leases l ON l.job_id = j.id AND l.released_at IS NULL WHERE j.id = $1`,
        [jobId],
      );
      const live = rows[0];
      if (live === undefined) throw new Error('no live lease');
      const audit = new AuditLog(c.h.db.pool, c.h.clock.now);
      const approvals = new ApprovalService({
        pool: c.h.db.pool,
        audit,
        jobs: new JobStore({ pool: c.h.db.pool, audit, clock: c.h.clock.now }),
        clock: c.h.clock.now,
      });
      const base = {
        action: 'Bash',
        jobId,
        attemptId: live.current_attempt_id,
        epoch: live.lease_epoch,
        summary: 'git status (the description is never classified)',
        requestedBy: { type: 'runtime' as const, id: live.worker_id },
      };
      const claim = {
        tool: 'Bash',
        command: 'git status',
        shells: ['posix'],
        platform: 'posix',
        workspaceRoot: '/srv/ws/job',
        verdict: 'read',
        rules: ['git.read'],
      };
      // Sanity: an honest claim is approved.
      expect(await approvals.evaluate({ ...base, approvalKey: 'k-ok', safeCommand: claim })).toMatchObject({
        outcome: 'allow',
        autoSafe: { verdict: 'read', rules: ['git.read'] },
      });
      const forged: [string, unknown, string][] = [
        ['k-rm', { ...claim, command: 'rm -rf /' }, 'not_safe'],
        ['k-push', { ...claim, command: 'git status; git push' }, 'not_safe'],
        ['k-verdict', { ...claim, command: 'echo x > out/a', verdict: 'read' }, 'verdict_mismatch'],
        ['k-root', { ...claim, command: 'cat /etc/passwd' }, 'not_safe'],
        ['k-shape', { ...claim, shells: ['fish'] }, 'invalid_claim'],
        ['k-str', 'git status', 'invalid_claim'],
      ];
      for (const [key, safeCommand, why] of forged) {
        const ev = await approvals.evaluate({ ...base, approvalKey: key, safeCommand });
        expect(ev.outcome, key).toBe('pending');
        const { rows: a } = await c.h.db.pool.query<{ metadata: { safeCheck?: string } }>(
          `SELECT metadata FROM audit_events WHERE action = 'approval.request' AND target = $1`,
          [`approval:${ev.requestId ?? ''}`],
        );
        expect(a[0]?.metadata.safeCheck, key).toBe(why);
      }
      // Only `runtime.dangerous_tool` requests: a catalogued action keeps its rule whatever the claim says.
      const merge = await approvals.evaluate({
        ...base,
        action: 'git.merge',
        approvalKey: 'k-merge',
        safeCommand: claim,
      });
      expect(merge.outcome).toBe('pending');
      // A replay of a request that went to a human keeps that answer, even with an honest claim now.
      const replay = await approvals.evaluate({ ...base, approvalKey: 'k-rm', safeCommand: claim });
      expect(replay).toMatchObject({ outcome: 'pending', created: false });
    });
  });
});
