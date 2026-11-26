import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
 * p19-repo-job-inputs (docs/design/p19-repo-job-inputs.md) against a real master (Postgres, Redis hints) and a real job
 * worker (fake runtime): input files of a REPOSITORY job — POST /jobs `inputs` and the chat's draft_job
 * `inputArtifacts` — refused with "makine güncellenmeli" while no machine advertises `repo-inputs-v1`, then stored with
 * the job (`spec.repository.inputs`, audited by count and size), fetched by the worker into a read-only scratch in/
 * next to the checkout, and never part of the pushed attempt branch. A copied spec's `repository.inputs` is dropped.
 */
const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 10;

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const b64 = (s: string): string => Buffer.from(s).toString('base64');

describeIntegration(
  'input files for repository jobs (integration, p19-repo-job-inputs)',
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

    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
    }

    async function state(id: string): Promise<string> {
      const d = (await operator.req('GET', `/jobs/${id}`)).json<{
        job: { state: string };
        orchestration?: { schedule: { reasons: { code: string }[] } | null };
      }>();
      if (d.job.state === 'QUEUED' && d.orchestration?.schedule) {
        return `QUEUED ${JSON.stringify(d.orchestration.schedule.reasons.map((r) => r.code))}`;
      }
      return d.job.state;
    }

    async function newWorker(opts: Partial<Parameters<typeof startJobWorker>[2]>): Promise<JobWorker> {
      const dir = await tempDataDir(dirs);
      const id = await pairRealWorker(h, url, owner, ownerSecret, dir);
      const w = await startJobWorker(url, dir, { fileUrl, ...opts });
      workers.push(w);
      await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
      return w;
    }

    const gitBare = (...args: string[]): string =>
      execFileSync('git', ['--git-dir', fileURLToPath(fileUrl), ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

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
      // An earlier job of the project with an output the chat can hand on (inputArtifacts).
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
    });
    afterAll(async () => {
      await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
      await h.stop();
      await removeDirs(dirs);
    });

    it('without a repo-inputs-v1 machine: POST /jobs with inputs is refused with "makine güncellenmeli", no job', async () => {
      const before = await h.db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM jobs WHERE project = $1',
        [PROJECT],
      );
      const res = await operator.req('POST', '/jobs', {
        project: PROJECT,
        spec: jobSpec(),
        inputs: [{ name: 'notes.md', contentBase64: b64('# notes\n') }],
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json<{ error: string; message: string }>()).toMatchObject({ error: 'invalid_job' });
      expect(res.json<{ message: string }>().message).toContain('makine güncellenmeli');
      const after = await h.db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM jobs WHERE project = $1',
        [PROJECT],
      );
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    });

    it('a copied spec never carries repository.inputs (only the stored inputs count)', async () => {
      const forged = {
        inputId: 'in-forged',
        name: 'secret.md',
        mediaType: 'text/markdown',
        sizeBytes: 3,
        sha256: 'a'.repeat(64),
      };
      const { job } = await jobs.create({
        project: PROJECT,
        actor: { type: 'user', id: ownerId },
        spec: jobSpec({
          repository: { url: REPO_URL, baseRef: 'main', workBranch: 'w', inputs: [forged] },
        }),
      });
      const { rows } = await h.db.pool.query<{ inputs: unknown }>(
        "SELECT spec->'repository'->'inputs' AS inputs FROM jobs WHERE id = $1",
        [job.id],
      );
      expect(rows[0]?.inputs).toBeNull();
    });

    it('a repo-inputs-v1 machine: the job gets the files read-only next to the checkout; the push never has them', async () => {
      const seen: { dir: string | null; text: string | null; prompt: string } = {
        dir: null,
        text: null,
        prompt: '',
      };
      const script: FakeScript = (prompt) => {
        seen.prompt = prompt;
        const m = /read-only in (\S+): /.exec(prompt);
        seen.dir = m?.[1] ?? null;
        // (The chat's job below gets teklif.md instead; only the first job's notes are recorded.)
        if (seen.dir !== null && seen.text === null) {
          try {
            seen.text = readFileSync(`${seen.dir}/notes.md`, 'utf8');
          } catch {
            seen.text = null;
          }
        }
        return [
          { kind: 'write-file', path: 'design/teklif.html', content: '<h1>Teklif</h1>\n' },
          { kind: 'summary', text: 'rebuilt the design' },
        ];
      };
      await newWorker({ projects: [PROJECT], fake: { script }, features: ['repo-inputs-v1'] });
      const res = await operator.req('POST', '/jobs', {
        project: PROJECT,
        spec: jobSpec({ prompt: 'Eski teklifin tasarımını notlara göre kur' }),
        inputs: [{ name: 'notes.md', contentBase64: b64('# Notlar\n\nİki sütun.\n') }],
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json<{ job: { id: string } }>().job.id;
      const stored = await h.db.pool.query<{ n: number }>(
        "SELECT jsonb_array_length(spec->'repository'->'inputs')::int AS n FROM jobs WHERE id = $1",
        [id],
      );
      expect(stored.rows[0]?.n).toBe(1);
      const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action = 'job.create' AND target = $1",
        [`job:${id}`],
      );
      expect(audit.rows[0]?.metadata).toMatchObject({
        repositoryInputs: { files: 1, bytes: Buffer.byteLength('# Notlar\n\nİki sütun.\n') },
      });
      expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('notes.md');
      // The run finished and its result arrived (the master's git flow verification then needs a real provider
      // with pull requests: VERIFYING or SUCCEEDED both mean the attempt itself succeeded).
      await expect.poll(() => state(id), { timeout: 30_000 }).toMatch(/^(VERIFYING|SUCCEEDED|FAILED)$/);
      const ends = await h.db.pool.query<{ trigger: string; reason: string | null }>(
        'SELECT trigger, reason FROM job_transitions WHERE job_id = $1 ORDER BY occurred_at, id',
        [id],
      );
      expect(await state(id), JSON.stringify(ends.rows)).toMatch(/^(VERIFYING|SUCCEEDED)$/);
      expect(ends.rows.map((r) => r.trigger)).toContain('run_finished');
      expect(seen.text).toBe('# Notlar\n\nİki sütun.\n');
      expect(seen.dir).toMatch(/sandboxes\/[0-9a-f-]+\/[^/]+\/in$/);
      expect(seen.prompt).toContain('NOT part of the repository checkout');
      // Every pushed commit of the job holds the agent's work and none of the inputs.
      const result = await h.db.pool.query<{ payload: { commits?: { sha: string; branch: string }[] } }>(
        "SELECT payload FROM worker_inbox WHERE job_id = $1 AND type = 'JOB_RESULT'",
        [id],
      );
      for (const commit of result.rows.flatMap((r) => r.payload.commits ?? [])) {
        const tree = gitBare('ls-tree', '-r', '--name-only', commit.sha).split('\n');
        expect(tree).toContain('design/teklif.html');
        expect(tree.some((p) => p.endsWith('notes.md') || p.startsWith('in/'))).toBe(false);
      }
      // The job page lists the input (GET /jobs/:id/artifacts is not limited to workspace jobs).
      const listed = await operator.req('GET', `/jobs/${id}/artifacts?limit=1`);
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json<{ inputs: { name: string }[] }>().inputs.map((i) => i.name)).toEqual(['notes.md']);
    });

    it('the chat: draft_job inputArtifacts on a repository project — card, confirm, stored inputs', async () => {
      const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      const tools = new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
      } as unknown as ChatToolsDeps);
      const thread = await store.createThread(ownerId, 'repo inputs');
      const c: ToolCaller = {
        userId: ownerId,
        subject: await loadSubject(h.db.pool, { id: ownerId, role: 'owner' }),
        threadId: thread.id,
        turnId: randomUUID(),
      };
      const drafted = await tools.run(c, 'draft_job', {
        project: PROJECT,
        mode: 'repository',
        title: 'Teklif tasarımı',
        prompt: 'Rebuild the old proposal design described in the input notes',
        runtime: 'codex',
        inputArtifacts: [{ jobId: sourceJob, artifactId: 'ws-teklif-md' }],
      });
      if (!drafted.ok || drafted.draft === undefined) throw new Error(JSON.stringify(drafted));
      expect(drafted.draft.payload).toMatchObject({
        inputArtifacts: [{ jobId: sourceJob, artifactId: 'ws-teklif-md' }],
        inputFiles: [{ name: 'teklif.md', sourceJobId: sourceJob }],
      });
      expect(drafted.data).toMatchObject({
        inputs: [{ name: 'teklif.md' }],
        inputsNote: expect.stringContaining('next to the checkout') as unknown,
      });
      await stepUp();
      const confirmed = await owner.req('POST', `/chat/drafts/${drafted.draft.id}/confirm`, {});
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const jobId = confirmed.json<{ result: { jobId: string } }>().result.jobId;
      const rows = await h.db.pool.query<{ name: string; source: string; source_job_id: string | null }>(
        'SELECT name, source, source_job_id::text AS source_job_id FROM job_inputs WHERE job_id = $1',
        [jobId],
      );
      expect(rows.rows).toEqual([{ name: 'teklif.md', source: 'artifact', source_job_id: sourceJob }]);
      const spec = await h.db.pool.query<{ names: string[] }>(
        "SELECT ARRAY(SELECT x->>'name' FROM jsonb_array_elements(spec->'repository'->'inputs') x) AS names FROM jobs WHERE id = $1",
        [jobId],
      );
      expect(spec.rows[0]?.names).toEqual(['teklif.md']);
    });
  },
);
