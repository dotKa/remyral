import { randomUUID } from 'node:crypto';
import type { FakeScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, startJobWorker } from '../helpers/job-worker.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 12;
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
/** A provider-key canary the agent "finds on the web" and writes into its report. */
const CANARY = `sk-ant-api03-${'Q'.repeat(40)}canary${'z'.repeat(40)}`;

/** Reads its input, writes deliverables (one of them not allowed), sets a summary. */
const researchScript: FakeScript = () => [
  { kind: 'read-file', path: 'in/brief.md' },
  {
    kind: 'write-file',
    path: 'out/report.md',
    content: `# Findings\n\nThe brief was read.\nLeaked: ${CANARY}\n`,
  },
  { kind: 'write-file', path: 'out/charts/q3.png', content: PNG.toString('base64'), encoding: 'base64' },
  { kind: 'write-file', path: 'out/page.html', content: '<script>alert(1)</script>' },
  { kind: 'write-file', path: 'scratch-note.txt', content: 'not a deliverable' },
  { kind: 'summary', text: 'Research done: 2 deliverables.' },
];

const continueScript: FakeScript = () => [
  { kind: 'read-file', path: 'in/report.md' },
  { kind: 'read-file', path: 'in/previous-summary.md' },
  { kind: 'write-file', path: 'out/followup.md', content: '# Follow-up\n' },
];

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64');

interface Artifacts {
  artifacts: {
    id: string;
    name: string;
    mediaType: string;
    sizeBytes: number;
    kind: string;
    redacted: boolean;
  }[];
  inputs: { id: string; name: string; source: string; sourceJobId: string | null }[];
}

/**
 * p5-research-workspace end to end: real master (Postgres, BullMQ), real worker daemon over the WebSocket
 * transport, real scratch directories (WorkspaceManager) and the fake runtime writing files.
 */
describeIntegration('research workspaces (integration)', { timeout: 120_000 }, () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  let fileUrl: string;
  const dirs: string[] = [];
  const workers: JobWorker[] = [];

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        redisUrl: redisUrlWithDb(HINT_DB),
        hintPrefix: `t${randomUUID().slice(0, 8)}`,
        tickIntervalMs: 50,
        timing: { leaseTtlMs: 60_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
      },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    fileUrl = await createBareRepo(dirs);
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
  });
  afterAll(async () => {
    await h.stop();
    await removeDirs(dirs);
  });

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function newWorker(
    opts: Partial<Parameters<typeof startJobWorker>[2]>,
  ): Promise<{ id: string; w: JobWorker }> {
    const dir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dir);
    const w = await startJobWorker(url, dir, { fileUrl, ...opts });
    workers.push(w);
    await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
    return { id, w };
  }

  const spec = (over: Record<string, unknown> = {}) => ({
    runtime: 'codex',
    prompt: 'Research the market and write a report',
    sandboxProfile: 'host-restricted',
    sourceTrust: 'trusted',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 600 },
    ...over,
  });

  async function state(id: string): Promise<string> {
    const res = await admin.req('GET', `/jobs/${id}`);
    const d = res.json<{
      job: { state: string };
      orchestration?: { schedule: { reasons: { code: string }[] } | null };
    }>();
    if (d.job.state === 'QUEUED' && d.orchestration?.schedule) {
      return `QUEUED ${JSON.stringify(d.orchestration.schedule.reasons.map((r) => r.code))}`;
    }
    return d.job.state;
  }

  it('projects and workspace settings: kind, egress policy (admin + step-up, audited), repository routes refused', async () => {
    const list = await admin.req('GET', '/projects');
    expect(list.json<{ items: { id: string; kind: string }[] }>().items).toContainEqual(
      expect.objectContaining({ id: 'genel', kind: 'workspace' }),
    );
    const genel = await admin.req('GET', '/projects/genel/workspace');
    expect(genel.statusCode).toBe(200);
    expect(genel.json()).toMatchObject({
      project: 'genel',
      kind: 'workspace',
      egress: 'web',
      allowHosts: [],
    });

    await stepUp();
    const created = await admin.req('POST', '/projects', {
      id: 'research',
      name: 'Research',
      kind: 'workspace',
      egress: 'allowlist',
      allowHosts: ['Docs.Example.com'],
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ kind: 'workspace' });
    expect((await admin.req('GET', '/projects/research/workspace')).json()).toMatchObject({
      egress: 'allowlist',
      allowHosts: ['docs.example.com'],
    });
    const repo = await admin.req('POST', '/projects', { id: 'repo1', name: 'Repo 1' });
    expect(repo.json()).toMatchObject({ kind: 'repository' });
    expect((await admin.req('POST', '/projects', { id: 'repo2', name: 'R', egress: 'web' })).statusCode).toBe(
      400,
    );

    // Settings changes: validated, audited.
    const bad = await admin.req('PUT', '/projects/research/workspace', {
      egress: 'allowlist',
      allowHosts: [],
    });
    expect(bad.statusCode).toBe(400);
    const ip = await admin.req('PUT', '/projects/research/workspace', {
      egress: 'allowlist',
      allowHosts: ['10.0.0.1'],
    });
    expect(ip.statusCode).toBe(400);
    const put = await admin.req('PUT', '/projects/research/workspace', { egress: 'web' });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ egress: 'web', allowHosts: [], updatedBy: 'owner1' });
    const audit = await h.db.pool.query<{ metadata: { egress: string; previousEgress: string } }>(
      `SELECT metadata FROM audit_events WHERE action = 'project.workspace.update' AND target = 'project:research'`,
    );
    expect(audit.rows.at(-1)?.metadata).toMatchObject({ egress: 'web', previousEgress: 'allowlist' });

    // Kind-specific routes.
    expect((await admin.req('GET', '/projects/repo1/workspace')).json()).toMatchObject({
      error: 'not_a_workspace',
    });
    const git = await admin.req('PUT', '/projects/genel/git', {
      expectedVersion: 0,
      provider: 'git',
      repositoryUrl: 'https://example.com/a.git',
      baseBranch: 'main',
    });
    expect(git.statusCode).toBe(409);
    expect(git.json()).toMatchObject({ error: 'not_a_repository_project' });
  });

  it('job submission rules: no repository in a workspace, no inputs elsewhere, inputs validated and scanned', async () => {
    const withRepo = await admin.req('POST', '/jobs', {
      project: 'genel',
      spec: spec({ repository: { url: 'https://example.com/a.git', baseRef: 'main', workBranch: 'w' } }),
    });
    expect(withRepo.statusCode).toBe(400);
    expect(withRepo.body).toContain('spec.repository:not_allowed');
    // ADR-0010 rule 3 at submission: a host profile needs a trusted source (first live run: a chat draft
    // without sourceTrust reached the worker and was declined).
    const hostUntrusted = await admin.req('POST', '/jobs', {
      project: 'genel',
      spec: spec({ sandboxProfile: 'host-restricted', sourceTrust: undefined }),
    });
    expect(hostUntrusted.statusCode).toBe(400);
    expect(hostUntrusted.body).toContain('spec.sourceTrust:untrusted_requires_container');
    const repoInputs = await admin.req('POST', '/jobs', {
      project: 'repo1',
      spec: spec({ repository: { url: 'https://example.com/a.git', baseRef: 'main', workBranch: 'w' } }),
      inputs: [{ name: 'a.md', contentBase64: b64('x') }],
    });
    expect(repoInputs.statusCode).toBe(400);
    const html = await admin.req('POST', '/jobs', {
      project: 'genel',
      spec: spec(),
      inputs: [{ name: 'page.html', contentBase64: b64('<b>x</b>') }],
    });
    expect(html.statusCode).toBe(400);
    const fakePng = await admin.req('POST', '/jobs', {
      project: 'genel',
      spec: spec(),
      inputs: [{ name: 'x.png', contentBase64: b64('not a png') }],
    });
    expect(fakePng.statusCode).toBe(400);
    const leaky = await admin.req('POST', '/jobs', {
      project: 'genel',
      spec: spec(),
      inputs: [{ name: 'notes.md', contentBase64: b64(`# Notes\n\nkey: ${CANARY}\n`) }],
    });
    expect(leaky.statusCode).toBe(422);
    expect(leaky.json()).toMatchObject({ error: 'input_secret_detected' });
    expect(leaky.body).not.toContain(CANARY);
    expect(leaky.body).toContain('notes.md');
    const tooMany = await admin.req('POST', '/jobs', {
      project: 'genel',
      spec: spec(),
      inputs: Array.from({ length: 11 }, (_, i) => ({ name: `f${String(i)}.md`, contentBase64: b64('x') })),
    });
    expect(tooMany.statusCode).toBe(400);
    const unknownContinue = await admin.req('POST', '/jobs', {
      project: 'genel',
      spec: spec(),
      continueFrom: randomUUID(),
    });
    expect(unknownContinue.statusCode).toBe(404);
    // Nothing was stored for refused submissions.
    const stored = await h.db.pool.query('SELECT 1 FROM job_inputs');
    expect(stored.rowCount).toBe(0);
  });

  it('an old worker never gets a workspace job (workspace_unsupported)', async () => {
    await newWorker({ projects: ['acme', 'genel'] });
    const res = await admin.req('POST', '/jobs', { project: 'genel', spec: spec() });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ job: { id: string; projectKind: string } }>().job.id;
    expect(res.json()).toMatchObject({ job: { projectKind: 'workspace' } });
    await expect.poll(() => state(id), { timeout: 15_000 }).toBe('FAILED');
    const t = await h.db.pool.query<{ reason: string }>(
      `SELECT reason FROM job_transitions WHERE job_id = $1 AND trigger = 'infeasible'`,
      [id],
    );
    expect(t.rows[0]?.reason).toContain('workspace-v1');
  });

  it('kill switch and run budgets apply to a workspace like to any project', async () => {
    await stepUp();
    const kill = await admin.req('POST', '/projects/genel/kill', { reason: 'pause research', hold: true });
    expect(kill.statusCode, kill.body).toBe(200);
    await newWorker({
      workspaces: { genel: { egress: 'web', allowHosts: [] } },
      fake: { script: researchScript },
    });
    const res = await admin.req('POST', '/jobs', { project: 'genel', spec: spec() });
    const id = res.json<{ job: { id: string } }>().job.id;
    await expect.poll(() => state(id), { timeout: 10_000 }).toMatch(/^QUEUED .*project_held|^QUEUED/);
    await new Promise((r) => setTimeout(r, 500));
    expect(await state(id)).toMatch(/^QUEUED/);
    await stepUp();
    expect((await admin.req('DELETE', '/projects/genel/kill')).statusCode).toBe(200);
    await expect.poll(() => state(id), { timeout: 20_000 }).toBe('SUCCEEDED');
  });

  it('workspace job: inputs in, artifacts out (limits, redaction, types), download rules, continue-from', async () => {
    await stepUp();
    expect(
      (
        await admin.req('PUT', '/projects/genel/workspace', {
          egress: 'allowlist',
          allowHosts: ['docs.example.com'],
        })
      ).statusCode,
    ).toBe(200);
    const { w } = await newWorker({
      workspaces: { genel: { egress: 'web', allowHosts: [] } },
      fake: { script: researchScript },
    });
    const brief = '# Brief\n\nCompare three vendors.\n';
    const res = await admin.req('POST', '/jobs', {
      project: 'genel',
      spec: spec(),
      inputs: [{ name: 'brief.md', contentBase64: b64(brief) }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ job: { id: string } }>().job.id;
    await expect.poll(() => state(id), { timeout: 30_000 }).toBe('SUCCEEDED');

    // The egress policy in force at dispatch reached the worker (allowlist ∩ worker ceiling web).
    const started = w.lines.find((l) => l.msg === 'workspace job started' && l.jobId === id);
    expect(started).toMatchObject({ egress: 'allowlist', allowHosts: 1, inputs: 1 });
    // The agent read its input from in/.
    const events = await h.db.pool.query<{ payload: { event?: { kind: string; text?: string } } }>(
      `SELECT payload FROM worker_inbox WHERE job_id = $1 AND type = 'EVENT'`,
      [id],
    );
    expect(events.rows.some((r) => r.payload.event?.text?.includes('Compare three vendors'))).toBe(true);

    const list = await admin.req('GET', `/jobs/${id}/artifacts`);
    expect(list.statusCode).toBe(200);
    const a = list.json<Artifacts>();
    expect(a.artifacts.map((x) => x.name).sort()).toEqual(['charts/q3.png', 'report.md', 'summary.md']);
    expect(a.inputs).toEqual([
      expect.objectContaining({ name: 'brief.md', source: 'upload', sourceJobId: null }),
    ]);
    const report = a.artifacts.find((x) => x.name === 'report.md');
    const summary = a.artifacts.find((x) => x.kind === 'summary');
    const png = a.artifacts.find((x) => x.mediaType === 'image/png');
    if (report === undefined || summary === undefined || png === undefined)
      throw new Error('missing artifacts');

    const reportBody = await admin.req('GET', `/jobs/${id}/artifacts/${report.id}`);
    expect(reportBody.statusCode).toBe(200);
    expect(reportBody.headers['content-disposition']).toMatch(/^attachment; filename="report.md"/);
    expect(reportBody.headers['content-security-policy']).toContain('sandbox');
    expect(reportBody.headers['x-content-type-options']).toBe('nosniff');
    expect(reportBody.body).toContain('# Findings');
    expect(reportBody.body).not.toContain(CANARY);
    const inline = await admin.req('GET', `/jobs/${id}/artifacts/${report.id}?inline=1`);
    expect(inline.headers['content-disposition']).toMatch(/^inline;/);
    const image = await admin.req('GET', `/jobs/${id}/artifacts/${png.id}?inline=1`);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.rawPayload.subarray(0, 8)).toEqual(PNG.subarray(0, 8));
    const summaryBody = (await admin.req('GET', `/jobs/${id}/artifacts/${summary.id}`)).body;
    expect(summaryBody).toContain('Research done: 2 deliverables.');
    expect(summaryBody).toContain('page.html: file type or name not allowed');
    const input = await admin.req('GET', `/jobs/${id}/inputs/${a.inputs[0]?.id ?? ''}?inline=1`);
    expect(input.headers['content-disposition']).toMatch(/^attachment;/);
    expect(input.body).toBe(brief);

    // Chunk data never lands in the journal; staging rows are gone after the commits.
    const chunks = await h.db.pool.query<{ payload: Record<string, unknown>; outcome: string }>(
      `SELECT payload, outcome FROM worker_inbox WHERE job_id = $1 AND type = 'ARTIFACT_CHUNK'`,
      [id],
    );
    expect(chunks.rowCount).toBeGreaterThan(0);
    for (const c of chunks.rows) {
      expect(c.outcome).toBe('applied');
      expect(c.payload.data).toBeUndefined();
    }
    expect(
      (await h.db.pool.query('SELECT 1 FROM job_artifact_chunks WHERE job_id = $1', [id])).rowCount,
    ).toBe(0);
    // The canary never reached the database.
    const leak = await h.db.pool.query(
      `SELECT 1 FROM job_artifacts WHERE position(convert_to($1, 'UTF8') in content) > 0`,
      [CANARY],
    );
    expect(leak.rowCount).toBe(0);
    // p17-object-storage: nor the blob store (every stored file of the job is read back).
    const stored = await h.db.pool.query<{ blob_key: string }>(
      'SELECT blob_key FROM job_artifacts WHERE job_id = $1 AND blob_key IS NOT NULL',
      [id],
    );
    expect(stored.rowCount).toBeGreaterThan(0);
    for (const r of stored.rows) {
      expect((await h.app.blobs.read(r.blob_key)).toString('latin1')).not.toContain(CANARY);
    }

    // Detail and list carry the project kind; git flow never touched the job.
    expect((await admin.req('GET', `/jobs/${id}`)).json()).toMatchObject({
      job: { projectKind: 'workspace' },
    });
    expect((await h.db.pool.query('SELECT 1 FROM job_git WHERE job_id = $1', [id])).rowCount).toBe(0);

    // Continue from the first job: its artifacts become the inputs of the next one.
    const next = await admin.req('POST', '/jobs', {
      project: 'genel',
      spec: spec({ prompt: 'Follow up on the report' }),
      continueFrom: id,
    });
    expect(next.statusCode, next.body).toBe(201);
    const nextId = next.json<{ job: { id: string } }>().job.id;
    const inputs = await h.db.pool.query<{ name: string; source: string; source_job_id: string }>(
      'SELECT name, source, source_job_id FROM job_inputs WHERE job_id = $1 ORDER BY name',
      [nextId],
    );
    expect(inputs.rows.map((r) => r.name)).toEqual(['charts_q3.png', 'previous-summary.md', 'report.md']);
    expect(inputs.rows.every((r) => r.source === 'artifact' && r.source_job_id === id)).toBe(true);
    await expect.poll(() => state(nextId), { timeout: 30_000 }).toBe('SUCCEEDED');
  });

  it('managed workers: workspace projects are delivered (no repository) only to workspace-v1 workers; settings re-resolve', async () => {
    const caps = (features: string[]) => ({
      runtimes: [],
      sandboxProfiles: ['container'],
      maxParallelJobs: 1,
      tools: [],
      features,
      workerConfig: {
        source: 'local',
        generation: 0,
        effective: {
          projects: [],
          allowedRuntimes: ['codex'],
          maxParallelJobs: 1,
          sandboxProfiles: ['container'],
          runtimeAuth: {},
          labels: {},
        },
        ceiling: {
          projects: null,
          repoHosts: null,
          allowedRuntimes: null,
          maxParallelJobs: null,
          sandboxProfiles: null,
          pinnedRuntimes: [],
        },
        blocked: [],
      },
    });
    const connect = async (code: string, features: string[]) => {
      const raw = await RawWorker.connect(url, new TestKey());
      const pending = await raw.handshake({ pairingCode: code });
      const id = pending.workerId ?? '';
      expect((await admin.req('POST', `/workers/${id}/approve`, { pairingCode: code })).statusCode).toBe(200);
      await raw.next('SESSION_ESTABLISHED');
      raw.sendJson(raw.envelope('CAPABILITIES', caps(features), { workerId: id }));
      await expect
        .poll(async () => {
          const r = await h.db.pool.query<{ features: string[] | null }>(
            'SELECT features FROM workers WHERE id = $1',
            [id],
          );
          return r.rows[0]?.features?.length ?? 0;
        })
        .toBe(features.length);
      return { raw, id };
    };
    const a = await connect('WSPA-CEAA', ['worker-config-v1', 'workspace-v1']);
    const b = await connect('WSPA-CEBB', ['worker-config-v1']);
    try {
      await stepUp();
      await admin.req('PUT', '/projects/genel/workspace', {
        egress: 'allowlist',
        allowHosts: ['docs.example.com'],
      });
      const res = await admin.req('PUT', '/projects/genel/workers', { workerIds: [a.id, b.id] });
      expect(res.statusCode, res.body).toBe(200);
      const docA = await a.raw.next('APPLY_WORKER_CONFIG');
      expect(docA.payload.document.workspaces).toEqual({
        genel: { egress: 'allowlist', allowHosts: ['docs.example.com'] },
      });
      expect(docA.payload.document.projects).toEqual({});
      const docB = await b.raw.next('APPLY_WORKER_CONFIG');
      expect(docB.payload.document.workspaces).toBeUndefined();
      // The project options mark workspaces assignable without a repository.
      const cfg = await admin.req('GET', `/workers/${a.id}/config`);
      expect(cfg.json<{ projectOptions: { id: string; kind: string }[] }>().projectOptions).toContainEqual(
        expect.objectContaining({ id: 'genel', kind: 'workspace' }),
      );
      // A settings change re-resolves the assigned workers (cause `workspace`).
      await stepUp();
      expect((await admin.req('PUT', '/projects/genel/workspace', { egress: 'web' })).statusCode).toBe(200);
      const docA2 = await a.raw.next('APPLY_WORKER_CONFIG');
      expect(docA2.payload.document.workspaces).toEqual({ genel: { egress: 'web' } });
      expect(cfg.statusCode).toBe(200);
      const after = await admin.req('GET', `/workers/${a.id}/config`);
      expect(after.json<{ desired: { cause: string } }>().desired.cause).toBe('workspace');
      // Placement: the old worker is refused with a clear reason.
      const job = await admin.req('POST', '/jobs/placement-preview', {
        project: 'genel',
        runtime: 'codex',
        sandboxProfile: 'container',
        sourceTrust: 'trusted',
      });
      expect(job.statusCode, job.body).toBe(200);
      expect(job.body).toContain('workspace_unsupported');
    } finally {
      a.raw.close();
      b.raw.close();
    }
  });

  it('p8-preview-tunnels: a mobile app package beyond the output limit is stored for download only, never as an input', async () => {
    await stepUp();
    await admin.req('PUT', '/projects/genel/workspace', { egress: 'none' });
    // 6 MiB > the 5 MiB ordinary output limit; a ZIP local-file header like every APK.
    const apk = Buffer.alloc(6 * 1024 * 1024);
    apk.set([0x50, 0x4b, 0x03, 0x04], 0);
    const packageScript: FakeScript = () => [
      {
        kind: 'write-file',
        path: 'out/app-release.apk',
        content: apk.toString('base64'),
        encoding: 'base64',
      },
      { kind: 'write-file', path: 'out/fake.apk', content: 'not a zip' },
      { kind: 'write-file', path: 'out/notes.md', content: '# Build\n' },
    ];
    await newWorker({
      workspaces: { genel: { egress: 'web', allowHosts: [] } },
      fake: { script: packageScript },
    });
    const res = await admin.req('POST', '/jobs', {
      project: 'genel',
      spec: spec({ prompt: 'Build the APK' }),
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ job: { id: string } }>().job.id;
    await expect.poll(() => state(id), { timeout: 60_000 }).toBe('SUCCEEDED');
    const a = (await admin.req('GET', `/jobs/${id}/artifacts`)).json<Artifacts>();
    expect(a.artifacts.map((x) => x.name).sort()).toEqual(['app-release.apk', 'notes.md', 'summary.md']);
    const pkg = a.artifacts.find((x) => x.name === 'app-release.apk');
    expect(pkg?.mediaType).toBe('application/vnd.android.package-archive');
    const dl = await admin.req('GET', `/jobs/${id}/artifacts/${pkg?.id ?? ''}?inline=1`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="app-release.apk"/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.rawPayload.length).toBe(apk.length);
    // The summary names the refused fake package; continue-from never turns a package into an input.
    const summary = a.artifacts.find((x) => x.kind === 'summary');
    expect((await admin.req('GET', `/jobs/${id}/artifacts/${summary?.id ?? ''}`)).body).toContain('fake.apk');
    const next = await admin.req('POST', '/jobs', { project: 'genel', spec: spec(), continueFrom: id });
    expect(next.statusCode, next.body).toBe(201);
    const inputs = await h.db.pool.query<{ name: string }>(
      'SELECT name FROM job_inputs WHERE job_id = $1 ORDER BY name',
      [next.json<{ job: { id: string } }>().job.id],
    );
    expect(inputs.rows.map((r) => r.name)).toEqual(['notes.md', 'previous-summary.md']);
    await admin.req('POST', `/jobs/${next.json<{ job: { id: string } }>().job.id}/cancel`, {});
  });

  it('continue-from runs with the copied inputs', async () => {
    await stepUp();
    await admin.req('PUT', '/projects/genel/workspace', { egress: 'none' });
    const { w } = await newWorker({
      workspaces: { genel: { egress: 'web', allowHosts: [] } },
      fake: { script: researchScript },
    });
    const first = await admin.req('POST', '/jobs', {
      project: 'genel',
      spec: spec(),
      inputs: [{ name: 'brief.md', contentBase64: b64('# B\n') }],
    });
    const firstId = first.json<{ job: { id: string } }>().job.id;
    await expect.poll(() => state(firstId), { timeout: 30_000 }).toBe('SUCCEEDED');
    expect(w.lines.find((l) => l.msg === 'workspace job started' && l.jobId === firstId)).toMatchObject({
      egress: 'none',
    });
    await w.stop();
    workers.splice(workers.indexOf(w), 1);
    const { w: w2 } = await newWorker({
      workspaces: { genel: { egress: 'web', allowHosts: [] } },
      fake: { script: continueScript },
    });
    const next = await admin.req('POST', '/jobs', { project: 'genel', spec: spec(), continueFrom: firstId });
    const nextId = next.json<{ job: { id: string } }>().job.id;
    await expect.poll(() => state(nextId), { timeout: 30_000 }).toBe('SUCCEEDED');
    const events = await h.db.pool.query<{ payload: { event?: { text?: string } } }>(
      `SELECT payload FROM worker_inbox WHERE job_id = $1 AND type = 'EVENT'`,
      [nextId],
    );
    const texts = events.rows.map((r) => r.payload.event?.text ?? '');
    expect(texts.some((t) => t.startsWith('in/report.md: # Findings'))).toBe(true);
    expect(texts.some((t) => t.startsWith('in/previous-summary.md: # Summary'))).toBe(true);
    const out = (await admin.req('GET', `/jobs/${nextId}/artifacts`)).json<Artifacts>();
    expect(out.artifacts.map((x) => x.name).sort()).toEqual(['followup.md', 'summary.md']);
    expect(w2.lines.some((l) => l.msg === 'workspace inputs fetched' && l.jobId === nextId)).toBe(true);
  });
});
