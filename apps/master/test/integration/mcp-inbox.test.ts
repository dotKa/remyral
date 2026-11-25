import { longRunningScript } from '@remyral/agent-adapters';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Cluster } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';

/**
 * p14-mcp-core: an `mcp_call` EVENT from the worker holding the job's live lease goes through the orchestration inbox
 * into `job_mcp_calls` and the audit log (`mcp.tool.call`, metadata only) and into the job timeline; a call naming a
 * server the job did not pin, or from a stale epoch, is not recorded. Real master + real worker daemon (fake runtime).
 */
describeIntegration(
  'MCP call events through the inbox (integration, p14-mcp-core)',
  { timeout: 120_000 },
  () => {
    const c = new Cluster();

    beforeAll(async () => {
      await c.start(14);
    });
    afterAll(async () => {
      await c.stop();
    });

    it('records calls of pinned servers from the live attempt only', async () => {
      const { w } = await c.newWorker({ fake: { script: longRunningScript } });
      const jobId = await c.submit();
      await expect.poll(() => c.state(jobId), { timeout: 20_000 }).toBe('RUNNING');
      const d = await c.detail(jobId);
      const attemptId = d.job.currentAttemptId ?? '';
      const epoch = (d.job as unknown as { leaseEpoch: number }).leaseEpoch;
      // The pin a real issue would have written (the issue itself: mcp.test.ts).
      await c.h.db.pool.query(
        `INSERT INTO job_mcp_pins (job_id, server_id, version, spec_sha256, policy_sha256, pinned_at, rules)
       VALUES ($1, 'github', '1.0.0', $2, $2, now(), '[]')`,
        [jobId, 'd'.repeat(64)],
      );
      const event = (server: string, tool: string) => ({
        kind: 'mcp_call' as const,
        server,
        tool,
        decision: 'deny' as const,
        outcome: 'denied' as const,
        durationMs: 0,
        argsBytes: 17,
        argsSha256: 'e'.repeat(64),
        resultBytes: 0,
      });
      const send = (ev: ReturnType<typeof event>, e = epoch) =>
        w.daemon.sendSequenced({
          type: 'EVENT',
          correlationId: `mcp-${ev.tool}`,
          jobId: jobId as never,
          payload: { attemptId: attemptId as never, epoch: e, event: ev },
        });
      await send(event('github', 'delete_repo'));
      await send(event('other', 'x'));
      await expect
        .poll(
          async () =>
            (
              await c.h.db.pool.query<{ tool: string; decision: string; outcome: string }>(
                'SELECT tool, decision, outcome FROM job_mcp_calls WHERE job_id = $1',
                [jobId],
              )
            ).rows,
          { timeout: 15_000 },
        )
        .toEqual([{ tool: 'delete_repo', decision: 'deny', outcome: 'denied' }]);
      const audit = await c.h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
        "SELECT outcome, metadata FROM audit_events WHERE action = 'mcp.tool.call'",
      );
      expect(audit.rows).toEqual([
        {
          outcome: 'denied',
          metadata: expect.objectContaining({ jobId, server: 'github', tool: 'delete_repo' }) as unknown,
        },
      ]);
      // The timeline keeps the event (metadata only) like every other agent event.
      await expect
        .poll(
          async () =>
            (
              await c.h.db.pool.query("SELECT 1 FROM job_events WHERE job_id = $1 AND kind = 'mcp_call'", [
                jobId,
              ])
            ).rowCount,
          { timeout: 15_000 },
        )
        .toBe(2);
      // A stale epoch never writes.
      await send(event('github', 'late'), epoch - 1);
      await new Promise((r) => setTimeout(r, 500));
      expect(
        (await c.h.db.pool.query("SELECT 1 FROM job_mcp_calls WHERE job_id = $1 AND tool = 'late'", [jobId]))
          .rowCount,
      ).toBe(0);
      await c.admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'done' });
      await expect.poll(() => c.state(jobId), { timeout: 20_000 }).toBe('CANCELLED');
    });
  },
);
