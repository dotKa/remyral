import { randomUUID } from 'node:crypto';
import type { FakeScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 13;
const MiB = 1024 * 1024;

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64');
/** Readable text of about `bytes` bytes (passes the input secret scan: no high-entropy literals). */
const text = (bytes: number, word = 'lorem'): string => {
  const line = `${word} ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor\n`;
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
};

/**
 * One fake runtime for every job here: it acts on the step / task named in the prompt.
 * - workflow step "gather": reads the run file, writes notes; step "write": reads the upstream file and the run file
 * - automation task "Weekly research": reads its inputs, writes a report
 */
const script: FakeScript = (prompt) => {
  if (prompt.includes('step "gather"')) {
    return [
      { kind: 'read-file', path: 'in/brief.md' },
      { kind: 'write-file', path: 'out/notes.md', content: '# Notes\n\nGathered three sources.\n' },
      { kind: 'summary', text: 'Gathered.' },
    ];
  }
  if (prompt.includes('step "write"')) {
    return [
      { kind: 'read-file', path: 'in/gather-notes.md' },
      { kind: 'read-file', path: 'in/brief.md' },
      { kind: 'write-file', path: 'out/final.md', content: '# Final\n' },
      { kind: 'summary', text: 'Written.' },
    ];
  }
  return [
    { kind: 'read-file', path: 'in/brief.md' },
    { kind: 'read-file', path: 'in/report.md' },
    { kind: 'write-file', path: 'out/report.md', content: '# Weekly report\n' },
    { kind: 'summary', text: 'Reported.' },
  ];
};

interface Artifacts {
  artifacts: { id: string; name: string; prunedAt: string | null; prunedReason: string | null }[];
  inputs: { id: string; name: string; source: string; prunedReason: string | null }[];
}

/**
 * p5-research-workspace-next: storage policy (retention, quota, usage, sweeper), workflows on workspace projects
 * (run files, upstream files), automations with input files and continue-from — real master (Postgres, BullMQ),
 * real worker daemon and the fake runtime where jobs run.
 */
describeIntegration('workspace follow-ups (integration)', { timeout: 180_000 }, () => {
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
    await stepUp();
    for (const id of ['store', 'flow']) {
      const res = await admin.req('POST', '/projects', { id, name: id, kind: 'workspace', egress: 'none' });
      expect(res.statusCode, res.body).toBe(201);
    }
    expect((await admin.req('POST', '/projects', { id: 'repo1', name: 'Repo 1' })).statusCode).toBe(201);
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

  async function newWorker(): Promise<JobWorker> {
    const dir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dir);
    const w = await startJobWorker(url, dir, {
      fileUrl,
      workspaces: { flow: { egress: 'none', allowHosts: [] } },
      fake: { script },
    });
    workers.push(w);
    await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
    return w;
  }

  const spec = (over: Record<string, unknown> = {}) => ({
    runtime: 'codex',
    prompt: 'Weekly research: compare vendors',
    sandboxProfile: 'host-restricted',
    sourceTrust: 'trusted',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 600 },
    ...over,
  });

  async function jobState(id: string): Promise<string> {
    return (await admin.req('GET', `/jobs/${id}`)).json<{ job: { state: string } }>().job.state;
  }

  async function submit(project: string, files: Record<string, string>): Promise<string> {
    const res = await admin.req('POST', '/jobs', {
      project,
      spec: spec(),
      inputs: Object.entries(files).map(([name, content]) => ({ name, contentBase64: b64(content) })),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ job: { id: string } }>().job.id;
  }

  async function cancel(id: string): Promise<void> {
    const res = await admin.req('POST', `/jobs/${id}/cancel`, { reason: 'test' });
    expect(res.statusCode, res.body).toBe(200);
    await expect.poll(() => jobState(id)).toBe('CANCELLED');
  }

  async function settings(project: string) {
    const res = await admin.req('GET', `/projects/${project}/workspace`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{
      artifactRetentionDays: number | null;
      storageQuotaBytes: number | null;
      usage: { bytes: number; files: number; inputBytes: number; prunedFiles: number };
    }>();
  }

  async function prunes(project: string): Promise<{ reason: string; files: number }[]> {
    const { rows } = await h.db.pool.query<{ metadata: { reason: string; files: number } }>(
      `SELECT metadata FROM audit_events WHERE action = 'workspace.files.prune' AND target = $1 ORDER BY id`,
      [`project:${project}`],
    );
    return rows.map((r) => r.metadata);
  }

  it('settings: retention and quota (validated, audited, unchanged when omitted) and usage', async () => {
    const before = await settings('store');
    expect(before).toMatchObject({
      artifactRetentionDays: null,
      storageQuotaBytes: null,
      usage: { bytes: 0, files: 0, prunedFiles: 0 },
    });
    await stepUp();
    for (const bad of [
      { artifactRetentionDays: 0 },
      { storageQuotaBytes: 1000 },
      { artifactRetentionDays: 1.5 },
    ]) {
      const res = await admin.req('PUT', '/projects/store/workspace', { egress: 'none', ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const put = await admin.req('PUT', '/projects/store/workspace', {
      egress: 'none',
      artifactRetentionDays: 30,
      storageQuotaBytes: 10 * MiB,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ artifactRetentionDays: 30, storageQuotaBytes: 10 * MiB });
    // Omitted: unchanged (an egress-only change keeps the policy).
    const egressOnly = await admin.req('PUT', '/projects/store/workspace', { egress: 'web' });
    expect(egressOnly.json()).toMatchObject({
      egress: 'web',
      artifactRetentionDays: 30,
      storageQuotaBytes: 10 * MiB,
    });
    const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'project.workspace.update' AND target = 'project:store'
        ORDER BY id`,
    );
    expect(audit.rows.at(-2)?.metadata).toMatchObject({
      artifactRetentionDays: 30,
      storageQuotaBytes: 10 * MiB,
      previousArtifactRetentionDays: null,
      previousStorageQuotaBytes: null,
    });
    // Repository projects have no workspace settings.
    expect((await admin.req('GET', '/projects/repo1/workspace')).statusCode).toBe(409);
  });

  it('quota at submission: old files of finished jobs make room, running jobs are never pruned, 413 when full', async () => {
    await stepUp();
    await admin.req('PUT', '/projects/store/workspace', {
      egress: 'none',
      artifactRetentionDays: null,
      storageQuotaBytes: 10 * MiB,
    });
    const a = await submit('store', { 'a1.md': text(4 * MiB), 'a2.md': text(4 * MiB, 'alpha') });
    expect((await settings('store')).usage).toMatchObject({ bytes: 8 * MiB, files: 2, inputBytes: 8 * MiB });
    await cancel(a);
    // 8 + 4 > 10: the oldest file of the finished job A goes (one is enough).
    const b = await submit('store', { 'b.md': text(4 * MiB, 'beta') });
    const listA = (await admin.req('GET', `/jobs/${a}/artifacts`)).json<Artifacts>();
    const pruned = listA.inputs.filter((i) => i.prunedReason === 'quota');
    expect(pruned).toHaveLength(1);
    expect((await settings('store')).usage).toMatchObject({ bytes: 8 * MiB, prunedFiles: 1 });
    const gone = await admin.req('GET', `/jobs/${a}/inputs/${pruned[0]?.id ?? ''}`);
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toMatchObject({ error: 'file_removed' });
    expect(await prunes('store')).toEqual([expect.objectContaining({ reason: 'quota', files: 1 })]);
    // B is queued (no worker): its file is never pruned; C needs A's last file.
    const c = await submit('store', { 'c.md': text(5 * MiB, 'gamma') });
    expect((await settings('store')).usage.bytes).toBe(9 * MiB);
    // Nothing finished is left to free: refused, nothing changed.
    const d = await admin.req('POST', '/jobs', {
      project: 'store',
      spec: spec(),
      inputs: [{ name: 'd.md', contentBase64: b64(text(5 * MiB, 'delta')) }],
    });
    expect(d.statusCode).toBe(413);
    expect(d.json()).toMatchObject({ error: 'storage_quota_exceeded' });
    expect((await settings('store')).usage.bytes).toBe(9 * MiB);
    const queued = await h.db.pool.query(
      `SELECT 1 FROM job_inputs i WHERE i.job_id = ANY($1::uuid[]) AND i.pruned_at IS NOT NULL`,
      [[b, c]],
    );
    expect(queued.rowCount).toBe(0);
    await cancel(b);
    await cancel(c);
  });

  it('sweeper: retention prunes old files of finished jobs (metadata kept); a lowered quota is enforced', async () => {
    await stepUp();
    await admin.req('PUT', '/projects/store/workspace', {
      egress: 'none',
      artifactRetentionDays: null,
      storageQuotaBytes: null,
    });
    const old = await submit('store', { 'old.md': text(1024, 'old') });
    const running = await submit('store', { 'live.md': text(1024, 'live') });
    await cancel(old);
    // Both are "old"; only the finished job's file may go.
    await h.db.pool.query(
      `UPDATE job_inputs SET created_at = created_at - interval '3 days' WHERE job_id = ANY($1::uuid[])`,
      [[old, running]],
    );
    await stepUp();
    await admin.req('PUT', '/projects/store/workspace', { egress: 'none', artifactRetentionDays: 2 });
    const swept = await h.app.workspaceStorage.sweep();
    expect(swept).toContainEqual(expect.objectContaining({ project: 'store', reason: 'retention' }));
    const oldList = (await admin.req('GET', `/jobs/${old}/artifacts`)).json<Artifacts>();
    expect(oldList.inputs).toEqual([expect.objectContaining({ name: 'old.md', prunedReason: 'retention' })]);
    const liveList = (await admin.req('GET', `/jobs/${running}/artifacts`)).json<Artifacts>();
    expect(liveList.inputs).toEqual([expect.objectContaining({ name: 'live.md', prunedReason: null })]);
    expect((await prunes('store')).at(-1)).toMatchObject({ reason: 'retention' });
    await cancel(running);

    // A lowered quota: the sweeper prunes the oldest finished files until the project fits.
    await stepUp();
    await admin.req('PUT', '/projects/store/workspace', {
      egress: 'none',
      artifactRetentionDays: null,
      storageQuotaBytes: null,
    });
    const big = [];
    for (const w of ['e', 'f', 'g']) {
      h.clock.advance(1_000); // distinct creation times (the test clock stands still otherwise)
      big.push(await submit('store', { [`${w}.md`]: text(5 * MiB, w) }));
    }
    for (const id of big) await cancel(id);
    expect((await settings('store')).usage.bytes).toBeGreaterThan(10 * MiB);
    await stepUp();
    await admin.req('PUT', '/projects/store/workspace', { egress: 'none', storageQuotaBytes: 10 * MiB });
    await h.app.workspaceStorage.sweep();
    expect((await settings('store')).usage.bytes).toBeLessThanOrEqual(10 * MiB);
    expect((await prunes('store')).at(-1)).toMatchObject({ reason: 'quota' });
    // The newest finished file survived.
    const newest = (await admin.req('GET', `/jobs/${big[2] ?? ''}/artifacts`)).json<Artifacts>();
    expect(newest.inputs[0]?.prunedReason).toBeNull();
  });

  it('workflows on a workspace: no repository, run files to every step, upstream files to the next step', async () => {
    const DEFAULTS = {
      runtime: 'codex',
      sandboxProfile: 'host-restricted',
      sourceTrust: 'trusted',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 600 },
    };
    const integrator = await admin.req('POST', '/workflows', {
      project: 'flow',
      definition: {
        name: 'merge',
        defaults: DEFAULTS,
        nodes: [
          { id: 'a', role: 'executor', prompt: 'a' },
          { id: 'm', role: 'integrator', prompt: 'merge' },
        ],
        edges: [{ from: 'a', to: 'm' }],
      },
    });
    expect(integrator.statusCode).toBe(400);
    expect(integrator.body).toContain('integrator_needs_repository');
    const withRepo = await admin.req('POST', '/workflows', {
      project: 'flow',
      definition: {
        name: 'repo',
        defaults: { ...DEFAULTS, repository: { url: 'https://example.com/a.git', baseRef: 'main' } },
        nodes: [{ id: 'a', role: 'executor', prompt: 'a' }],
        edges: [],
      },
    });
    expect(withRepo.statusCode).toBe(400);
    expect(withRepo.body).toContain('defaults.repository:not_allowed');

    const def = await admin.req('POST', '/workflows', {
      project: 'flow',
      definition: {
        name: 'research',
        defaults: DEFAULTS,
        nodes: [
          { id: 'gather', role: 'executor', prompt: 'Gather sources for the brief.' },
          { id: 'write', role: 'executor', prompt: 'Write the final report.' },
        ],
        edges: [{ from: 'gather', to: 'write' }],
      },
    });
    expect(def.statusCode, def.body).toBe(201);
    const wf = def.json<{ id: string }>().id;
    const brief = '# Brief\n\nCompare three vendors.\n';
    const repoRun = await admin.req('POST', `/workflows/${wf}/runs`, {
      repository: { url: 'https://example.com/a.git', baseRef: 'main' },
    });
    expect(repoRun.statusCode).toBe(400);
    expect(repoRun.body).toContain('repository:not_allowed');
    // Files on a repository project's workflow are refused before anything is stored.
    await newWorker();
    const started = await admin.req('POST', `/workflows/${wf}/runs`, {
      files: [{ name: 'brief.md', contentBase64: b64(brief) }],
    });
    expect(started.statusCode, started.body).toBe(201);
    const runId = started.json<{ runId: string }>().runId;
    const view = async () =>
      (await admin.req('GET', `/workflows/runs/${runId}`)).json<{
        run: { state: string; repository: unknown; files: { name: string }[] };
        nodes: { id: string; state: string; jobId: string | null; reason: string | null }[];
      }>();
    await expect.poll(async () => (await view()).run.state, { timeout: 60_000 }).toBe('succeeded');
    const v = await view();
    expect(v.run.repository).toBeNull();
    expect(v.run.files.map((f) => f.name)).toEqual(['brief.md']);
    const writeJob = v.nodes.find((n) => n.id === 'write')?.jobId ?? '';
    const gatherJob = v.nodes.find((n) => n.id === 'gather')?.jobId ?? '';
    const inputs = (await admin.req('GET', `/jobs/${writeJob}/artifacts`)).json<Artifacts>().inputs;
    expect(inputs.map((i) => [i.name, i.source]).sort()).toEqual([
      ['brief.md', 'upload'],
      ['gather-notes.md', 'upstream'],
      ['gather-summary.md', 'upstream'],
    ]);
    // The downstream step read both files from in/.
    const events = await h.db.pool.query<{ payload: { event?: { text?: string } } }>(
      `SELECT payload FROM worker_inbox WHERE job_id = $1 AND type = 'EVENT'`,
      [writeJob],
    );
    const texts = events.rows.map((r) => r.payload.event?.text ?? '');
    expect(texts.some((t) => t.startsWith('in/gather-notes.md: # Notes'))).toBe(true);
    expect(texts.some((t) => t.startsWith('in/brief.md: # Brief'))).toBe(true);

    // Retention removes the finished steps' artifacts: 410 on download, continue-from refuses an emptied job.
    await stepUp();
    await admin.req('PUT', '/projects/flow/workspace', { egress: 'none', artifactRetentionDays: 1 });
    await h.db.pool.query(
      `UPDATE job_artifacts SET created_at = created_at - interval '2 days' WHERE job_id = $1`,
      [gatherJob],
    );
    await h.app.workspaceStorage.sweep();
    const arts = (await admin.req('GET', `/jobs/${gatherJob}/artifacts`)).json<Artifacts>().artifacts;
    expect(arts.length).toBeGreaterThan(0);
    expect(arts.every((a) => a.prunedReason === 'retention')).toBe(true);
    expect((await admin.req('GET', `/jobs/${gatherJob}/artifacts/${arts[0]?.id ?? ''}`)).statusCode).toBe(
      410,
    );
    const cont = await admin.req('POST', '/jobs', { project: 'flow', spec: spec(), continueFrom: gatherJob });
    expect(cont.statusCode).toBe(400);
    expect(cont.json()).toMatchObject({ error: 'invalid_inputs' });
    await stepUp();
    await admin.req('PUT', '/projects/flow/workspace', { egress: 'none', artifactRetentionDays: null });
  });

  it('quota at artifact commit: finished files make way; a full quota refuses the artifact (job unaffected)', async () => {
    await stepUp();
    await admin.req('PUT', '/projects/flow/workspace', {
      egress: 'none',
      artifactRetentionDays: null,
      storageQuotaBytes: 10 * MiB,
    });
    // X's own inputs fill the quota (older finished files of the project make room for them).
    const x = await submit('flow', { 'brief.md': text(5 * MiB, 'brief'), 'more.md': text(5 * MiB, 'more') });
    expect((await settings('flow')).usage.bytes).toBe(10 * MiB);
    await newWorker();
    await expect.poll(() => jobState(x), { timeout: 60_000 }).toBe('SUCCEEDED');
    // Its deliverables did not fit: refused (nothing finished to prune — X itself was running).
    const rejected = await h.db.pool.query<{ reason: string }>(
      `SELECT outcome_reason AS reason FROM worker_inbox WHERE job_id = $1 AND type = 'ARTIFACT_REF' AND outcome = 'rejected'`,
      [x],
    );
    expect(rejected.rows.map((r) => r.reason)).toContain('artifact_quota');
    expect((await admin.req('GET', `/jobs/${x}/artifacts`)).json<Artifacts>().artifacts).toEqual([]);
    // Now X is finished: the next job's artifacts push X's oldest input out.
    h.clock.advance(1_000);
    const y = await admin.req('POST', '/jobs', { project: 'flow', spec: spec() });
    const yId = y.json<{ job: { id: string } }>().job.id;
    await expect.poll(() => jobState(yId), { timeout: 60_000 }).toBe('SUCCEEDED');
    const yArtifacts = (await admin.req('GET', `/jobs/${yId}/artifacts`)).json<Artifacts>().artifacts;
    expect(yArtifacts.map((a) => a.name).sort()).toEqual(['report.md', 'summary.md']);
    const xInputs = (await admin.req('GET', `/jobs/${x}/artifacts`)).json<Artifacts>().inputs;
    expect(xInputs.filter((i) => i.prunedReason === 'quota')).toHaveLength(1);
    expect((await settings('flow')).usage.bytes).toBeLessThanOrEqual(10 * MiB);
    await stepUp();
    await admin.req('PUT', '/projects/flow/workspace', { egress: 'none', storageQuotaBytes: null });
  });

  it('automations on a workspace: stored files, continue from the last run, chain-source rules, schedules', async () => {
    await stepUp();
    const repoFiles = await admin.req('POST', '/automations', {
      project: 'repo1',
      name: 'repo',
      trigger: { kind: 'cron', cron: '0 * * * *' },
      target: {
        kind: 'job',
        spec: spec({ repository: { url: 'https://example.com/a.git', baseRef: 'main', workBranch: 'w' } }),
        files: [{ name: 'brief.md', contentBase64: b64('# B\n') }],
      },
    });
    expect(repoFiles.statusCode).toBe(400);
    expect(repoFiles.json()).toMatchObject({ error: 'invalid_target' });
    const chainOnCron = await admin.req('POST', '/automations', {
      project: 'flow',
      name: 'bad',
      trigger: { kind: 'cron', cron: '0 * * * *' },
      target: { kind: 'job', spec: spec(), continueFrom: { kind: 'chain-source' } },
    });
    expect(chainOnCron.statusCode).toBe(400);
    const unknownJob = await admin.req('POST', '/automations', {
      project: 'flow',
      name: 'bad',
      trigger: { kind: 'cron', cron: '0 * * * *' },
      target: { kind: 'job', spec: spec(), continueFrom: { kind: 'job', jobId: randomUUID() } },
    });
    expect(unknownJob.statusCode).toBe(404);

    const created = await admin.req('POST', '/automations', {
      project: 'flow',
      name: 'Weekly research',
      trigger: { kind: 'cron', cron: '0 9 * * 1' },
      target: {
        kind: 'job',
        spec: spec(),
        files: [{ name: 'brief.md', contentBase64: b64('# Brief\n\nWeekly vendors.\n') }],
        continueFrom: { kind: 'last-run' },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ automation: { id: string } }>().automation.id;
    const detail = async () =>
      (await admin.req('GET', `/automations/${id}`)).json<{
        targetSpec: { files: { id: string; name: string }[]; continueFrom: unknown };
      }>();
    expect((await detail()).targetSpec).toMatchObject({
      files: [expect.objectContaining({ name: 'brief.md' })],
      continueFrom: { kind: 'last-run' },
    });

    await newWorker();
    const runOnce = async (): Promise<{ jobId: string; reason: string | null }> => {
      const res = await admin.req('POST', `/automations/${id}/run`, {});
      expect(res.statusCode, res.body).toBe(202);
      const runId = res.json<{ id: string }>().id;
      const run = async () =>
        (await admin.req('GET', `/automations/${id}/runs/${runId}`)).json<{
          state: string;
          jobId: string | null;
          reason: string | null;
        }>();
      await expect.poll(async () => (await run()).state, { timeout: 60_000 }).toBe('succeeded');
      const r = await run();
      return { jobId: r.jobId ?? '', reason: r.reason };
    };
    const first = await runOnce();
    expect(first.reason).toContain('no earlier succeeded run');
    const firstInputs = (await admin.req('GET', `/jobs/${first.jobId}/artifacts`)).json<Artifacts>().inputs;
    expect(firstInputs.map((i) => i.name)).toEqual(['brief.md']);
    const second = await runOnce();
    const secondInputs = (await admin.req('GET', `/jobs/${second.jobId}/artifacts`)).json<Artifacts>().inputs;
    expect(secondInputs.map((i) => [i.name, i.source]).sort()).toEqual([
      ['brief.md', 'upload'],
      ['previous-summary.md', 'artifact'],
      ['report.md', 'artifact'],
    ]);
    const events = await h.db.pool.query<{ payload: { event?: { text?: string } } }>(
      `SELECT payload FROM worker_inbox WHERE job_id = $1 AND type = 'EVENT'`,
      [second.jobId],
    );
    expect(
      events.rows.some((r) => (r.payload.event?.text ?? '').startsWith('in/report.md: # Weekly report')),
    ).toBe(true);

    // Update: keep the stored file by id, add one, drop continue-from; omitted files stay unchanged.
    await stepUp();
    const keep = (await detail()).targetSpec.files[0]?.id ?? '';
    const patched = await admin.req('PATCH', `/automations/${id}`, {
      target: {
        kind: 'job',
        spec: spec(),
        files: [{ inputId: keep }, { name: 'extra.csv', contentBase64: b64('a,b\n1,2\n') }],
        continueFrom: null,
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await detail()).targetSpec).toMatchObject({
      files: [
        expect.objectContaining({ id: keep, name: 'brief.md' }),
        expect.objectContaining({ name: 'extra.csv' }),
      ],
      continueFrom: null,
    });
    await stepUp();
    expect(
      (
        await admin.req('PATCH', `/automations/${id}`, {
          target: { kind: 'job', spec: spec({ prompt: 'Weekly research v2' }) },
        })
      ).statusCode,
    ).toBe(200);
    expect((await detail()).targetSpec.files).toHaveLength(2);

    // The composer's "Repeat" (/schedules alias) keeps the attached files.
    await stepUp();
    const sched = await admin.req('POST', '/schedules', {
      project: 'flow',
      name: 'Scheduled research',
      target: { kind: 'job', spec: spec(), files: [{ name: 'brief.md', contentBase64: b64('# S\n') }] },
      when: { kind: 'cron', cron: '0 9 * * *' },
    });
    expect(sched.statusCode, sched.body).toBe(201);
    const automationId = sched.json<{ automationId: string }>().automationId;
    const sd = (await admin.req('GET', `/automations/${automationId}`)).json<{
      targetSpec: { files: { name: string }[] };
    }>();
    expect(sd.targetSpec.files.map((f) => f.name)).toEqual(['brief.md']);
  });

  it('p8-orchestration: a workflow-target automation on a workspace hands its stored files to the run', async () => {
    await stepUp();
    const def = await admin.req('POST', '/workflows', {
      project: 'flow',
      definition: {
        name: 'auto-files',
        defaults: {
          runtime: 'codex',
          sandboxProfile: 'host-restricted',
          sourceTrust: 'trusted',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 600 },
        },
        nodes: [{ id: 'only', role: 'executor', prompt: 'Read the brief.' }],
        edges: [],
      },
    });
    expect(def.statusCode, def.body).toBe(201);
    const workflowId = def.json<{ id: string }>().id;
    const created = await admin.req('POST', '/automations', {
      project: 'flow',
      name: 'Workflow with files',
      trigger: { kind: 'cron', cron: '0 9 * * 1' },
      target: {
        kind: 'workflow',
        workflowId,
        inputs: {},
        files: [{ name: 'brief.md', contentBase64: b64('# Brief\n') }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ automation: { id: string } }>().automation.id;
    const res = await admin.req('POST', `/automations/${id}/run`, {});
    expect(res.statusCode, res.body).toBe(202);
    const runId = res.json<{ workflowRunId: string | null }>().workflowRunId;
    expect(runId).not.toBeNull();
    const files = await h.db.pool.query<{ name: string; source: string }>(
      'SELECT name, source FROM workflow_run_files WHERE run_id = $1',
      [runId],
    );
    expect(files.rows).toEqual([{ name: 'brief.md', source: 'upload' }]);
    const cancelled = await admin.req('POST', `/workflows/runs/${runId ?? ''}/cancel`, {
      reason: 'test done',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
  });
});
