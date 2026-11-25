import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { JobStore } from '../../src/jobs/store.js';
import { WorkflowService } from '../../src/workflows/engine.js';
import { checkStoredDefinitions, reportLines } from '../../src/workflows/v2/normalise-check.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p14-workflow-engine 14.5 (§5.7): switching WORKFLOW_ENGINE_V2_FOR_V1 on. A master started with the switch on (a
 * second WorkflowService on the same database, as after the redeploy) starts **new** runs of a version-1 workflow on
 * engine 2, while a run that started on engine 1 before the switch keeps its engine and finishes there (its legacy
 * `workflow_nodes` rows, no node runs). Switching back off (rollback) leaves engine-2 runs on engine 2. The dry run
 * (`workflow:normalise-check`) reports what the switch changes. The behavioural parity of both engines is
 * `workflows.test.ts` (run on engine 1 and engine 2).
 */

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'wf-migrate';
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/acme/migrate.git', baseRef: 'main' },
};

interface View {
  run: { id: string; state: string; engine: number };
  nodes: { id: string; state: string; jobId: string | null }[];
}

describeIntegration(
  'workflow engine switch for version-1 workflows (integration, 14.5)',
  { timeout: 300_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let ownerId = '';

    beforeAll(async () => {
      // The running master: engine 2 on for v2 documents, version-1 documents still on engine 1.
      await h.start({ orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } } });
      ownerId = await h.createUser('owner1', PW);
      owner = await fullLogin(h, 'owner1', PW, (await enroll(h, 'owner1', PW)).secret);
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT (id) DO NOTHING',
        [PROJECT],
      );
    });
    afterAll(async () => {
      await h.stop();
    });

    /** The master after the redeploy with the given flags (same database, fresh service). */
    function master(flags: { v2: boolean; v2ForV1: boolean }): WorkflowService {
      const audit = new AuditLog(h.db.pool, h.clock.now);
      return new WorkflowService({
        pool: h.db.pool,
        jobs: new JobStore({ pool: h.db.pool, audit, clock: h.clock.now }),
        audit,
        clock: h.clock.now,
        log: h.app.log,
        cancel: () => ({ sendCancel: () => Promise.resolve(true) }),
        engine: flags,
      });
    }
    async function view(runId: string): Promise<View> {
      const res = await owner.req('GET', `/workflows/runs/${runId}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<View>();
    }
    async function succeed(svc: WorkflowService, runId: string, node: string): Promise<void> {
      const n = (await view(runId)).nodes.find((x) => x.id === node);
      expect(n?.jobId, `${node} has a job`).toBeTruthy();
      await h.db.pool.query(`UPDATE jobs SET state = 'SUCCEEDED', version = version + 1 WHERE id = $1`, [
        n?.jobId,
      ]);
      await svc.progress();
      await svc.progress();
    }
    const nodeRows = async (runId: string) => ({
      legacy:
        (await h.db.pool.query('SELECT 1 FROM workflow_nodes WHERE run_id = $1', [runId])).rowCount ?? 0,
      nodeRuns:
        (await h.db.pool.query('SELECT 1 FROM workflow_node_runs WHERE run_id = $1', [runId])).rowCount ?? 0,
    });

    it('new runs of a version-1 workflow start on engine 2 after the switch; a run in progress finishes on engine 1', async () => {
      const d = await owner.req('POST', '/workflows', {
        project: PROJECT,
        definition: {
          name: 'classic',
          defaults: DEFAULTS,
          nodes: [
            { id: 'build', role: 'executor', prompt: 'build {{inputs.task}}' },
            { id: 'check', role: 'verifier', prompt: 'check {{upstream.build.summary}}' },
          ],
          edges: [{ from: 'build', to: 'check' }],
          inputs: { task: { required: true } },
        },
      });
      expect(d.statusCode, d.body).toBe(201);
      const id = d.json<{ id: string }>().id;

      // Before the switch: engine 1.
      const before = await owner.req('POST', `/workflows/${id}/runs`, { inputs: { task: 'x' } });
      expect(before.statusCode, before.body).toBe(201);
      const oldRun = before.json<{ runId: string }>().runId;
      expect((await view(oldRun)).run).toMatchObject({ engine: 1, state: 'running' });

      const dry = await checkStoredDefinitions(h.db.pool);
      expect(dry.failures).toEqual([]);
      expect(dry.v1Workflows).toBeGreaterThanOrEqual(1);
      expect(dry.openRuns.engine1).toBe(1);
      expect(reportLines(dry).at(-1)).toMatch(/^ready:/);

      // The redeploy with WORKFLOW_ENGINE_V2_FOR_V1=true.
      const on = master({ v2: true, v2ForV1: true });
      try {
        const newRun = await on.startRun({ type: 'user', id: ownerId }, id, { inputs: { task: 'y' } });
        expect((await view(newRun)).run).toMatchObject({ engine: 2, state: 'running' });
        expect(await nodeRows(newRun)).toMatchObject({ legacy: 0 });
        expect((await nodeRows(newRun)).nodeRuns).toBeGreaterThanOrEqual(2);

        // The engine-1 run keeps its engine and finishes there, driven by the switched master.
        await succeed(on, oldRun, 'build');
        await succeed(on, oldRun, 'check');
        const old = await view(oldRun);
        expect(old.run).toMatchObject({ engine: 1, state: 'succeeded' });
        expect(await nodeRows(oldRun)).toEqual({ legacy: 2, nodeRuns: 0 });

        // The engine-2 run finishes on engine 2.
        await succeed(on, newRun, 'build');
        await succeed(on, newRun, 'check');
        expect((await view(newRun)).run).toMatchObject({ engine: 2, state: 'succeeded' });

        // Rollback (switch off again): new runs go back to engine 1; an open engine-2 run stays on engine 2.
        const open2 = await on.startRun({ type: 'user', id: ownerId }, id, { inputs: { task: 'z' } });
        const off = master({ v2: true, v2ForV1: false });
        try {
          const back = await off.startRun({ type: 'user', id: ownerId }, id, { inputs: { task: 'w' } });
          expect((await view(back)).run.engine).toBe(1);
          await succeed(off, open2, 'build');
          await succeed(off, open2, 'check');
          expect((await view(open2)).run).toMatchObject({ engine: 2, state: 'succeeded' });
          const after = await checkStoredDefinitions(h.db.pool);
          expect(after.openRuns).toEqual({ engine1: 1, engine2: 0 });
        } finally {
          await off.close();
        }
      } finally {
        await on.close();
      }
    });
  },
);
