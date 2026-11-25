import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FakeScript } from '@remyral/agent-adapters';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { JobStore } from '../../src/jobs/index.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  createBareRepo,
  type JobWorker,
  jobSpec,
  PROJECT,
  REPO_URL,
  startJobWorker,
} from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

/**
 * p19-repo-inputs-composer-workflows (docs/design/p19-repo-job-inputs.md §9) against a real master (Postgres, Redis
 * hints) and a real job worker (fake runtime): run files of a REPOSITORY project's workflow run — POST
 * /workflows/:id/runs `files` / `continueFrom` and the chat's draft_workflow_run — refused with "makine güncellenmeli"
 * while no machine advertises `repo-inputs-v1` (the composer is told the same: placement preview `inputFiles`,
 * GET /workflows/:id `runFiles`), then stored with the run and handed to every AI step's job as
 * `spec.repository.inputs` (engine 1 and engine 2); the step's agent reads them from the scratch in/ next to its
 * checkout.
 */
const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 11;

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const b64 = (s: string): string => Buffer.from(s).toString('base64');

describeIntegration(
  'run files for repository workflows (integration, p19-repo-inputs-composer-workflows)',
  { timeout: 240_000 },
  () => {
    let h: Harness;
    let url = '';
    let fileUrl = '';
    let owner: Client;
    let ownerId = '';
    let ownerSecret = '';
    let operator: Client;
    let jobs: JobStore;
    const dirs: string[] = [];
    const workers: JobWorker[] = [];
    let sourceJob = '';
    let wfV1 = '';
    let wfV2 = '';

    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
    }

    async function newWorker(opts: Partial<Parameters<typeof startJobWorker>[2]>): Promise<JobWorker> {
      const dir = await tempDataDir(dirs);
      const id = await pairRealWorker(h, url, owner, ownerSecret, dir);
      const w = await startJobWorker(url, dir, { fileUrl, ...opts });
      workers.push(w);
      await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
      return w;
    }

    async function define(definition: Record<string, unknown>): Promise<string> {
      const res = await owner.req('POST', '/workflows', { project: PROJECT, definition });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    }

    /** The step jobs of a run (engine 1: workflow_nodes; engine 2: the node runs' AI jobs). */
    async function stepJobs(runId: string): Promise<{ id: string; spec: Record<string, unknown> }[]> {
      const { rows } = await h.db.pool.query<{ id: string; spec: Record<string, unknown> }>(
        `SELECT j.id, j.spec FROM jobs j
          WHERE j.id IN (SELECT job_id FROM workflow_nodes WHERE run_id = $1 AND job_id IS NOT NULL
                         UNION
                         SELECT rj.job_id FROM workflow_node_run_jobs rj
                           JOIN workflow_node_runs nr ON nr.id = rj.node_run_id
                          WHERE nr.run_id = $1 AND rj.kind = 'ai')`,
        [runId],
      );
      return rows;
    }

    const repoInputNames = (spec: Record<string, unknown>): string[] =>
      (((spec.repository as { inputs?: { name: string }[] } | undefined)?.inputs ?? []) as { name: string }[])
        .map((i) => i.name)
        .sort();

    beforeAll(async () => {
      h = new Harness(Date.now());
      await h.start({
        // The test repository is a local bare repository (plain git), like the other git flow tests.
        gitflow: { allowPlainGit: true },
        workers: {
          connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
          pairing: { perIp: 50 },
          sweepIntervalMs: 3_600_000,
        },
        orchestration: {
          redisUrl: redisUrlWithDb(HINT_DB),
          hintPrefix: `t${randomUUID().slice(0, 8)}`,
          tickIntervalMs: 50,
          // Engine 1 for v1 documents, engine 2 for v2 documents (both covered below).
          workflowEngine: { v2: true, v2ForV1: false },
          timing: {
            leaseTtlMs: 3_600_000,
            reconnectGraceMs: 7_200_000,
            retryBackoffMs: 0,
            effectRetryAfterMs: 0,
          },
        },
      });
      url = await h.listen();
      fileUrl = await createBareRepo(dirs);
      jobs = new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
      ownerId = await h.createUser('owner1', PW);
      ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      await h.db.pool.query(
        "INSERT INTO projects (id, name, kind, created_at) VALUES ($1, $1, 'repository', now()) ON CONFLICT DO NOTHING",
        [PROJECT],
      );
      await h.db.pool.query(
        `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                          require_ci, ci_timeout_sec, updated_by, updated_at)
         VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 3600, $3, now()) ON CONFLICT (project) DO NOTHING`,
        [PROJECT, REPO_URL, ownerId],
      );
      const operatorId = await h.createUser('oper1', PW, 'operator');
      await h.grant(operatorId, [PROJECT], 'operator');
      operator = await fullLogin(h, 'oper1', PW, (await enroll(h, 'oper1', PW)).secret);
      // An earlier job of the project with an output a run can continue from.
      sourceJob = (
        await jobs.create({
          project: PROJECT,
          actor: { type: 'user', id: ownerId },
          spec: jobSpec({ prompt: 'write the old proposal notes' }),
        })
      ).job.id;
      const content = Buffer.from('# Eski teklif\n\nMavi başlık, iki sütun.\n');
      await h.db.pool.query(
        `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                    redacted, content, created_at)
         VALUES (gen_random_uuid(), $1, 'ws-teklif-md', 'teklif.md', 'text/markdown', $2, $3, 'output', false, $4, now())`,
        [sourceJob, content.length, sha(content), content],
      );
      const defaults = {
        runtime: 'codex',
        sandboxProfile: 'host-restricted',
        // Host profiles need trusted sources (untrusted → container only), like the other workflow tests.
        sourceTrust: 'trusted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
      };
      // No repository in the definition: the run takes the project's registered one.
      wfV1 = await define({
        name: 'teklif-v1',
        defaults,
        nodes: [{ id: 'build', role: 'executor', prompt: 'Rebuild the proposal page from the input files.' }],
        edges: [],
      });
      wfV2 = await define({
        schemaVersion: 2,
        name: 'teklif-v2',
        defaults,
        nodes: [
          { id: 'start', type: 'trigger.manual' },
          {
            id: 'build',
            type: 'ai.step',
            role: 'executor',
            prompt: 'Rebuild the proposal page from the input files.',
          },
        ],
        edges: [{ from: 'start', to: 'build' }],
      });
    });
    afterAll(async () => {
      await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
      await h.stop();
      await removeDirs(dirs);
    });

    it('without a repo-inputs-v1 machine: the composer is told, and a run with files is refused (no run)', async () => {
      const def = await operator.req('GET', `/workflows/${wfV1}`);
      expect(def.statusCode, def.body).toBe(200);
      expect(def.json<{ runFiles: unknown }>().runFiles).toEqual({
        available: false,
        reason: 'inputs_worker_update',
      });
      const preview = await operator.req('POST', '/jobs/placement-preview', { project: PROJECT });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json<{ inputFiles: unknown }>().inputFiles).toEqual({
        available: false,
        reason: 'inputs_worker_update',
      });
      const before = await h.db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM workflow_runs WHERE project = $1',
        [PROJECT],
      );
      const res = await operator.req('POST', `/workflows/${wfV1}/runs`, {
        inputs: {},
        files: [{ name: 'notes.md', contentBase64: b64('# notes\n') }],
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json<{ message: string }>().message).toContain('makine güncellenmeli');
      const after = await h.db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM workflow_runs WHERE project = $1',
        [PROJECT],
      );
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
      // A run without files is unaffected.
      const plain = await operator.req('POST', `/workflows/${wfV1}/runs`, { inputs: {} });
      expect(plain.statusCode, plain.body).toBe(201);
      const plainJobs = await stepJobs(plain.json<{ runId: string }>().runId);
      expect(plainJobs.map((j) => repoInputNames(j.spec))).toEqual([[]]);
    });

    it('engine 1 with a repo-inputs-v1 machine: every step job gets the run files; the agent reads them next to the checkout', async () => {
      const seen: { dir: string | null; notes: string | null; teklif: string | null } = {
        dir: null,
        notes: null,
        teklif: null,
      };
      const script: FakeScript = (prompt) => {
        const m = /read-only in (\S+): /.exec(prompt);
        if (m?.[1] !== undefined && seen.dir === null) {
          seen.dir = m[1];
          try {
            seen.notes = readFileSync(`${m[1]}/notes.md`, 'utf8');
            seen.teklif = readFileSync(`${m[1]}/teklif.md`, 'utf8');
          } catch {
            // Recorded as null: the assertion below says which file was missing.
          }
        }
        return [
          { kind: 'write-file', path: 'design/teklif.html', content: '<h1>Teklif</h1>\n' },
          { kind: 'summary', text: 'rebuilt the design' },
        ];
      };
      await newWorker({ projects: [PROJECT], fake: { script }, features: ['repo-inputs-v1'] });
      const def = await operator.req('GET', `/workflows/${wfV1}`);
      expect(def.json<{ runFiles: unknown }>().runFiles).toEqual({ available: true, reason: null });
      const res = await operator.req('POST', `/workflows/${wfV1}/runs`, {
        inputs: {},
        files: [{ name: 'notes.md', contentBase64: b64('# Notlar\n\nİki sütun.\n') }],
        continueFrom: sourceJob,
      });
      expect(res.statusCode, res.body).toBe(201);
      const runId = res.json<{ runId: string }>().runId;
      const stored = await h.db.pool.query<{ name: string; source: string }>(
        'SELECT name, source FROM workflow_run_files WHERE run_id = $1 ORDER BY name',
        [runId],
      );
      expect(stored.rows).toEqual([
        { name: 'notes.md', source: 'upload' },
        { name: 'teklif.md', source: 'artifact' },
      ]);
      const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action = 'workflow.run.start' AND target = $1",
        [`workflow-run:${runId}`],
      );
      expect(audit.rows[0]?.metadata).toMatchObject({ files: 2, continueFrom: sourceJob });
      expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('notes.md');
      const steps = await stepJobs(runId);
      expect(steps).toHaveLength(1);
      expect(repoInputNames(steps[0]?.spec ?? {})).toEqual(['notes.md', 'teklif.md']);
      const inputs = await h.db.pool.query<{ name: string }>(
        'SELECT name FROM job_inputs WHERE job_id = $1 ORDER BY name',
        [steps[0]?.id],
      );
      expect(inputs.rows.map((r) => r.name)).toEqual(['notes.md', 'teklif.md']);
      // The run view lists the run's files (metadata only).
      const view = await operator.req('GET', `/workflows/runs/${runId}`);
      expect(
        view
          .json<{ run: { files: { name: string }[] } }>()
          .run.files.map((f) => f.name)
          .sort(),
      ).toEqual(['notes.md', 'teklif.md']);
      // The step ran on the repo-inputs-v1 machine and its agent read both files from the scratch in/.
      await expect.poll(() => seen.dir, { timeout: 30_000 }).not.toBeNull();
      expect(seen.dir).toMatch(/sandboxes\/[0-9a-f-]+\/[^/]+\/in$/);
      expect(seen.notes).toBe('# Notlar\n\nİki sütun.\n');
      expect(seen.teklif).toBe('# Eski teklif\n\nMavi başlık, iki sütun.\n');
    });

    it('engine 2: the AI step’s job gets the run files as repository inputs', async () => {
      const res = await operator.req('POST', `/workflows/${wfV2}/runs`, {
        inputs: {},
        continueFrom: sourceJob,
      });
      expect(res.statusCode, res.body).toBe(201);
      const runId = res.json<{ runId: string }>().runId;
      const engine = await h.db.pool.query<{ engine: number }>(
        'SELECT engine FROM workflow_runs WHERE id = $1',
        [runId],
      );
      expect(engine.rows[0]?.engine).toBe(2);
      await expect.poll(async () => (await stepJobs(runId)).length, { timeout: 20_000 }).toBe(1);
      const [step] = await stepJobs(runId);
      expect(repoInputNames(step?.spec ?? {})).toEqual(['teklif.md']);
      expect((step?.spec.repository as { url?: string } | undefined)?.url).toBe(REPO_URL);
    });

    it('the chat: draft_workflow_run continueFrom on a repository workflow — card with the note, confirm, run files', async () => {
      const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      const tools = new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
        workflows: () => h.app.workflows,
        automations: () => h.app.automations,
      } as unknown as ChatToolsDeps);
      const thread = await store.createThread(ownerId, 'repo run files');
      const c: ToolCaller = {
        userId: ownerId,
        subject: await loadSubject(h.db.pool, { id: ownerId, role: 'owner' }),
        threadId: thread.id,
        turnId: randomUUID(),
      };
      const drafted = await tools.run(c, 'draft_workflow_run', { workflowId: wfV1, continueFrom: sourceJob });
      if (!drafted.ok || drafted.draft === undefined) throw new Error(JSON.stringify(drafted));
      expect(drafted.draft.payload).toMatchObject({ workflowId: wfV1, continueFrom: sourceJob });
      expect(drafted.data).toMatchObject({
        files: [{ name: 'teklif.md', sourceJobId: sourceJob }],
        filesNote: expect.stringContaining('next to its checkout') as unknown,
      });
      await stepUp();
      const confirmed = await owner.req('POST', `/chat/drafts/${drafted.draft.id}/confirm`, {});
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const result = confirmed.json<{ result: { runId: string; files: number } }>().result;
      expect(result.files).toBe(1);
      const files = await h.db.pool.query<{ name: string; source_job_id: string | null }>(
        'SELECT name, source_job_id::text AS source_job_id FROM workflow_run_files WHERE run_id = $1',
        [result.runId],
      );
      expect(files.rows).toEqual([{ name: 'teklif.md', source_job_id: sourceJob }]);
    });
  },
);
