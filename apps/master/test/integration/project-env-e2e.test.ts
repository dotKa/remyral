import { randomBytes } from 'node:crypto';
import { createNodeFileOps, FileSecretStore } from '@remyral/worker';
import type { FakeScript } from '@remyral/agent-adapters';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Cluster } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { type JobWorker, jobSpec, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, tempDataDir } from '../helpers/real-worker.js';

const VALUE = `postgres://dev:${randomBytes(12).toString('hex')}@db.internal/app`;
const CRED = 'dev-database-url';

/** The fake agent prints `env=<value>` of DEV_DATABASE_URL (empty when the variable is not set). */
const script: FakeScript = () => [{ kind: 'leak-secret', envName: 'DEV_DATABASE_URL', into: 'message' }];

/**
 * p19-project-env end to end: a real master (dispatch loop) and a real worker daemon holding the vault credential in
 * its secret store. A project binding puts the value into the job's environment as DEV_DATABASE_URL (the agent sees
 * it; the log shows it redacted), and the worker records the credential as used.
 */
describeIntegration(
  'project environment credentials end to end (p19-project-env)',
  { timeout: 120_000 },
  () => {
    const c = new Cluster();
    let worker: JobWorker | undefined;
    let workerId = '';

    async function messages(jobId: string): Promise<string[]> {
      const { rows } = await c.h.db.pool.query<{ payload: { text?: string } }>(
        "SELECT payload FROM job_events WHERE job_id = $1 AND kind = 'message' ORDER BY id",
        [jobId],
      );
      // The agent's own lines (the prompt is a message too).
      return rows.map((r) => r.payload.text ?? '').filter((t) => t.startsWith('env='));
    }

    async function run(): Promise<string> {
      const id = await c.submit(jobSpec({ prompt: 'print the database url' }));
      await expect.poll(() => c.state(id), { timeout: 30_000 }).toBe('SUCCEEDED');
      return id;
    }

    beforeAll(async () => {
      await c.start(12);
    });

    afterAll(async () => {
      await worker?.stop();
      await c.stop();
    });

    it('without a binding the job has no variable; with one the agent gets the value (redacted in the log)', async () => {
      const dir = await tempDataDir(c.dirs);
      workerId = await pairRealWorker(c.h, c.url, c.admin, c.secret, dir);
      await new FileSecretStore(createNodeFileOps(), dir).set(`vault-${CRED}`, VALUE);
      worker = await startJobWorker(c.url, dir, { fileUrl: c.fileUrl, fake: { script } });
      await expect.poll(() => c.h.app.fleetSessions.hasReported(workerId), { timeout: 15_000 }).toBe(true);
      await c.h.db.pool.query(
        `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at)
       VALUES ($1, 'DEV_DATABASE_URL', 'generic', 'DEV_DATABASE_URL', 1, 'active', now(), now())`,
        [CRED],
      );
      await c.h.db.pool.query(
        `INSERT INTO vault_credential_workers (credential_id, worker_id, version, key_id, sealed, sealed_digest, state,
                                             acked_version, updated_at)
       VALUES ($1, $2, 1, 'AAAAAAAAAAAAAAAAAAAAAA', '{"c":"x"}', repeat('a', 64), 'active', 1, now())`,
        [CRED, workerId],
      );

      const before = await run();
      expect(await messages(before)).toEqual(['env=']);

      await c.stepUp();
      const put = await c.admin.req('PUT', `/projects/${PROJECT}/env-credentials`, { credentialIds: [CRED] });
      expect(put.statusCode, put.body).toBe(200);

      const after = await run();
      const texts = await messages(after);
      expect(texts).toHaveLength(1);
      expect(texts[0]).not.toBe('env=');
      // Never the value itself: the worker registers every injected secret with its redactor.
      expect(JSON.stringify(texts)).not.toContain(VALUE);
      expect(JSON.stringify(worker.lines)).not.toContain(VALUE);
    });
  },
);
