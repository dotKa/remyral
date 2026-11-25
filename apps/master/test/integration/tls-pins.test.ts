import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { JobStore } from '../../src/jobs/index.js';
import { loadTlsPins } from '../../src/tls-pins/service.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p22-runtime-diagnostics against a real master (Postgres, migration 0209): "Trust this certificate" pins exactly the
 * certificate a failed function job of the project reported (`http_error`, `params.cause = tls_untrusted`), for that
 * host:port; nothing typed by the client is pinned; audited add / remove; jobs of other projects and other failures are
 * refused; the pins are what a function job of the project carries (`loadTlsPins`).
 */

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'tlspin';
const OTHER = 'tlspin-other';
const WORKER = 'wrk-test-1';
const SHA = 'ab'.repeat(32);

describeIntegration(
  'project certificate pins (integration, p22-runtime-diagnostics)',
  { timeout: 120_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let ownerId = '';
    let jobs: JobStore;

    beforeAll(async () => {
      await h.start({ orchestration: { tickIntervalMs: 0 } });
      ownerId = await h.createUser('owner1', PW);
      owner = await fullLogin(h, 'owner1', PW, (await enroll(h, 'owner1', PW)).secret);
      for (const p of [PROJECT, OTHER]) {
        await h.db.pool.query(
          `INSERT INTO projects (id, name, kind, created_at) VALUES ($1, $1, 'workspace', now()) ON CONFLICT (id) DO NOTHING`,
          [p],
        );
        await h.db.pool.query(
          `INSERT INTO project_workspaces (project, egress, updated_at) VALUES ($1, 'none', now()) ON CONFLICT DO NOTHING`,
          [p],
        );
      }
      jobs = new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
    });
    afterAll(async () => {
      await h.stop();
    });

    /** A job of `project` whose attempt ended with `error`. */
    async function failedJob(project: string, error: Record<string, unknown>): Promise<string> {
      const { job } = await jobs.create({
        project,
        actor: { type: 'user', id: ownerId },
        submit: true,
        spec: {
          runtime: 'codex',
          title: 'call the internal API',
          prompt: 'p',
          sandboxProfile: 'host-restricted',
          sourceTrust: 'trusted',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 3600 },
        },
      });
      const id = randomUUID();
      const now = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO job_attempts (id, job_id, number, worker_id, state, outcome, started_at, ended_at)
       VALUES ($1, $2, 1, $3, 'ended', 'failed', $4, $4)`,
        [id, job.id, WORKER, now],
      );
      await h.db.pool.query(
        `INSERT INTO job_runs (attempt_id, job_id, worker_id, result_outcome, result, result_received_at, created_at,
                             updated_at)
       VALUES ($1, $2, $3, 'failed', $4, $5, $5, $5)`,
        [id, job.id, WORKER, JSON.stringify({ summary: 'failed', error }), now],
      );
      return job.id;
    }

    const untrusted = {
      code: 'http_error',
      message: 'request failed (DEPTH_ZERO_SELF_SIGNED_CERT): self-signed certificate',
      params: {
        cause: 'tls_untrusted',
        tlsCode: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        host: 'nas.internal.example.com',
        port: 8443,
        certSha256: SHA,
      },
    };

    it('pins exactly the reported certificate, audited; idempotent; removable', async () => {
      const jobId = await failedJob(PROJECT, untrusted);
      expect((await owner.req('GET', `/projects/${PROJECT}/tls-pins`)).json()).toEqual({ pins: [] });
      // The body names only the job: no fingerprint or host can be supplied by the client.
      const smuggled = await owner.req('POST', `/projects/${PROJECT}/tls-pins`, {
        jobId,
        sha256: '00'.repeat(32),
      });
      expect(smuggled.statusCode).toBe(400);

      const added = await owner.req('POST', `/projects/${PROJECT}/tls-pins`, { jobId });
      expect(added.statusCode, added.body).toBe(200);
      const pins = added.json<{ pins: { id: string; host: string; port: number; sha256: string }[] }>().pins;
      expect(pins).toMatchObject([
        { host: 'nas.internal.example.com', port: 8443, sha256: SHA, sourceJob: jobId },
      ]);
      expect(await loadTlsPins(h.db.pool, PROJECT)).toEqual([
        { host: 'nas.internal.example.com', port: 8443, sha256: SHA },
      ]);
      expect(await loadTlsPins(h.db.pool, OTHER)).toEqual([]);

      // Again: no second row, no second audit entry.
      expect((await owner.req('POST', `/projects/${PROJECT}/tls-pins`, { jobId })).statusCode).toBe(200);
      const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action = 'project.tls_pin.add' AND outcome = 'success'",
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]?.metadata).toMatchObject({
        project: PROJECT,
        host: 'nas.internal.example.com',
        port: 8443,
        sha256: SHA,
        sourceJob: jobId,
      });

      const id = pins[0]?.id ?? '';
      const removed = await owner.req('DELETE', `/projects/${PROJECT}/tls-pins/${id}`);
      expect(removed.statusCode, removed.body).toBe(200);
      expect(removed.json()).toEqual({ pins: [] });
      const gone = await h.db.pool.query(
        "SELECT 1 FROM audit_events WHERE action = 'project.tls_pin.remove' AND outcome = 'success'",
      );
      expect(gone.rows).toHaveLength(1);
    });

    it('refuses a job of another project and a failure that is not tls_untrusted', async () => {
      const elsewhere = await failedJob(OTHER, untrusted);
      expect(
        (await owner.req('POST', `/projects/${PROJECT}/tls-pins`, { jobId: elsewhere })).statusCode,
      ).toBe(404);
      const dns = await failedJob(PROJECT, {
        code: 'dns_failed',
        message: 'x does not resolve',
        params: { host: 'x.example.com' },
      });
      const r = await owner.req('POST', `/projects/${PROJECT}/tls-pins`, { jobId: dns });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: 'no_untrusted_certificate' });
      // The database refuses a malformed fingerprint whatever the code does.
      await expect(
        h.db.pool.query(
          `INSERT INTO project_tls_pins (id, project, host, port, sha256, created_at) VALUES ($1, $2, 'a.example', 443, 'XYZ', now())`,
          [randomUUID(), PROJECT],
        ),
      ).rejects.toThrow(/check constraint/);
    });
  },
);
