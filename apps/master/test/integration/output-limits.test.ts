import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { FakeScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { WorkspaceService } from '../../src/workspaces/service.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

/**
 * p17-output-limits end to end: the server setting (Ayarlar → Sunucu ayarları → İşler) and the project override within
 * the ceiling, a real worker returning 500 files through the blob store plus the overflow zip, the output report, the
 * paged listing and "Hepsini indir (zip)" (authz as the files), an older worker on the legacy limits, and the master's
 * own bounds (staging, commit, grants) against the limits recorded on the attempt.
 */

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 12;
const MiB = 1024 * 1024;

interface Artifact {
  id: string;
  name: string;
  sizeBytes: number;
  kind: string;
}

interface Report {
  attemptId: string;
  maxFiles: number | null;
  returned: number | null;
  storage: boolean | null;
  zip: { name: string; files: number; bytes: number } | null;
  skipped: { name: string; code: string; reason: string }[];
  skippedCount: number;
}

/** Entries of a stored zip with data descriptors (central directory → local data). */
function zipEntries(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const lname = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + lname, local + 30 + lname + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLen;
  }
  return out;
}

describeIntegration('output limits (integration)', { timeout: 300_000 }, () => {
  let h: Harness;
  let url: string;
  let owner: Client;
  let ownerSecret: string;
  let viewer: Client;
  let fileUrl: string;
  const dirs: string[] = [];
  const workers: JobWorker[] = [];

  beforeAll(async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'remyral-out-limits-'));
    dirs.push(blobDir);
    h = new Harness(Date.now());
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
        timing: { leaseTtlMs: 120_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
      },
      blobs: { dataDir: blobDir, settingsTtlMs: 0 },
    });
    url = await h.listen();
    await h.createUser('owner1', PW, 'owner');
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    await h.createUser('viewer1', PW, 'viewer');
    const { secret: viewerSecret } = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, viewerSecret);
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
    const r = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
    expect(r.statusCode, r.body).toBe(200);
  }

  async function newWorker(opts: Partial<Parameters<typeof startJobWorker>[2]>): Promise<JobWorker> {
    const dir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, owner, ownerSecret, dir);
    const w = await startJobWorker(url, dir, { fileUrl, ...opts });
    workers.push(w);
    await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
    return w;
  }

  const spec = () => ({
    runtime: 'codex',
    prompt: 'Produce the data set',
    sandboxProfile: 'host-restricted',
    sourceTrust: 'trusted',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 600 },
  });

  async function runJob(script: FakeScript, opts: { outputLimits: boolean }): Promise<string> {
    const w = await newWorker({
      workspaces: { genel: { egress: 'web', allowHosts: [] } },
      fake: { script },
      blobPut: true,
      ...(opts.outputLimits ? { features: ['output-limits-v1' as const] } : {}),
    });
    const res = await owner.req('POST', '/jobs', { project: 'genel', spec: spec() });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ job: { id: string } }>().job.id;
    await expect
      .poll(
        async () => (await owner.req('GET', `/jobs/${id}`)).json<{ job: { state: string } }>().job.state,
        { timeout: 200_000, interval: 500 },
      )
      .toBe('SUCCEEDED')
      .catch((err: unknown) => {
        const lines = w.lines.filter((l) => /artifact|upload|blob|error|warn/i.test(JSON.stringify(l)));
        throw new Error(`${String(err)}\n${JSON.stringify(lines.slice(-30), null, 1)}`);
      });
    return id;
  }

  it('server setting with the environment default; a project lowers it within the ceiling', async () => {
    const section = await owner.req('GET', '/panel-settings/jobs');
    expect(section.statusCode, section.body).toBe(200);
    const body = section.json<{
      fields: { key: string; value: unknown; source: string; env: string; max: number }[];
      info: { outputs?: { maxFiles: number; storage: string; inlineTotalBytes: number } };
    }>();
    expect(body.fields.find((f) => f.key === 'jobs.outputMaxFiles')).toMatchObject({
      value: 500,
      source: 'env',
      env: 'JOB_OUTPUT_MAX_FILES',
      max: 2000,
    });
    expect(body.info.outputs).toMatchObject({ maxFiles: 500, storage: 'local', inlineTotalBytes: 15 * MiB });

    await stepUp();
    const tooHigh = await owner.req('PUT', '/panel-settings/jobs', {
      values: { 'jobs.outputMaxFiles': 2001 },
    });
    expect(tooHigh.statusCode).toBe(400);
    await stepUp();
    const set = await owner.req('PUT', '/panel-settings/jobs', { values: { 'jobs.outputMaxFiles': 300 } });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json<{ info: { outputs: { maxFiles: number } } }>().info.outputs.maxFiles).toBe(300);

    // The project may set up to the ceiling, but only a lower value takes effect.
    await stepUp();
    const over = await owner.req('PUT', '/projects/genel/workspace', { egress: 'web', outputMaxFiles: 2001 });
    expect(over.statusCode).toBe(400);
    await stepUp();
    const high = await owner.req('PUT', '/projects/genel/workspace', {
      egress: 'web',
      outputMaxFiles: 1000,
      outputMaxJobBytes: 2 * 1024 * MiB,
    });
    expect(high.statusCode, high.body).toBe(200);
    expect(high.json()).toMatchObject({
      outputMaxFiles: 1000,
      outputMaxJobBytes: 2 * 1024 * MiB,
      outputLimits: {
        effectiveMaxFiles: 300,
        effectiveMaxJobBytes: 2 * 1024 * MiB,
        ceilingMaxFiles: 2000,
        server: { maxFiles: 300, storage: 'local' },
      },
    });
    await stepUp();
    const low = await owner.req('PUT', '/projects/genel/workspace', { egress: 'web', outputMaxFiles: 100 });
    expect(low.json()).toMatchObject({ outputMaxFiles: 100, outputLimits: { effectiveMaxFiles: 100 } });
    // Omitted fields stay; null returns to the server's value.
    await stepUp();
    const back = await owner.req('PUT', '/projects/genel/workspace', {
      egress: 'web',
      outputMaxFiles: null,
      outputMaxJobBytes: null,
    });
    expect(back.json()).toMatchObject({ outputMaxFiles: null, outputMaxJobBytes: null });
    const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'project.workspace.update' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ outputMaxFiles: null, previousOutputMaxFiles: 100 });

    // Back to the environment's default for the next tests.
    await stepUp();
    expect(
      (await owner.req('PUT', '/panel-settings/jobs', { values: { 'jobs.outputMaxFiles': null } }))
        .statusCode,
    ).toBe(200);
  });

  it('500 files through the blob store, the rest in out-rest.zip; report, paged list, download all (authz)', async () => {
    // Every file of 66 KiB or more goes to the store (threshold 64 KiB).
    await stepUp();
    const limits = await owner.req('PUT', '/integrations/storage', {
      mode: 'local',
      limits: {
        maxFileBytes: 64 * MiB,
        maxJobBytes: 1024 * MiB,
        thresholdBytes: 64 * 1024,
        downloadTtlSeconds: 300,
        shareMaxDays: 7,
      },
    });
    expect(limits.statusCode, limits.body).toBe(200);
    const row = (i: number): string => `${String(i).padStart(4, '0')},${'x'.repeat(66 * 1024)}\n`;
    const script: FakeScript = () => [
      ...Array.from({ length: 10 }, (_, i) => ({
        kind: 'write-file' as const,
        path: `out/a-${String(i).padStart(2, '0')}.md`,
        content: `# Note ${String(i)}\n`,
      })),
      ...Array.from({ length: 495 }, (_, i) => ({
        kind: 'write-file' as const,
        path: `out/data/r${String(i).padStart(4, '0')}.csv`,
        content: row(i),
      })),
    ];
    const id = await runJob(script, { outputLimits: true });

    const attempt = await h.db.pool.query<{ output_max_files: number | null; output_max_job_bytes: string }>(
      'SELECT output_max_files, output_max_job_bytes FROM job_attempts WHERE job_id = $1',
      [id],
    );
    expect(attempt.rows[0]).toMatchObject({
      output_max_files: 500,
      output_max_job_bytes: String(1024 * MiB),
    });

    // 10 inline + 489 through the store + the zip = 500 outputs; the 6 last files are in the zip.
    const uploads = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM blob_uploads WHERE job_id = $1 AND state = 'committed'`,
      [id],
    );
    expect(uploads.rows[0]?.n).toBe(490);
    const report = (await owner.req('GET', `/jobs/${id}/output-report`)).json<{ report: Report }>().report;
    expect(report).toMatchObject({
      maxFiles: 500,
      returned: 500,
      storage: true,
      zip: { name: 'out-rest.zip', files: 6 },
      skippedCount: 0,
    });

    // Paged list: 500 outputs + the summary.
    const page1 = (await owner.req('GET', `/jobs/${id}/artifacts?limit=200`)).json<{
      artifacts: Artifact[];
      total: number;
    }>();
    expect(page1.total).toBe(501);
    expect(page1.artifacts).toHaveLength(200);
    expect(page1.artifacts[0]?.kind).toBe('summary');
    const page3 = (await owner.req('GET', `/jobs/${id}/artifacts?limit=200&offset=400`)).json<{
      artifacts: Artifact[];
    }>();
    expect(page3.artifacts).toHaveLength(101);
    const all = (await owner.req('GET', `/jobs/${id}/artifacts?limit=1000`)).json<{
      artifacts: Artifact[];
    }>();
    expect(new Set(all.artifacts.map((a) => a.id)).size).toBe(501);
    expect(all.artifacts.some((a) => a.name === 'out-rest.zip')).toBe(true);

    // The overflow zip keeps the paths.
    const zipRow = all.artifacts.find((a) => a.name === 'out-rest.zip');
    const zip = await owner.req('GET', `/jobs/${id}/artifacts/${zipRow?.id ?? ''}`);
    expect([...zipEntries(zip.rawPayload).keys()]).toEqual([
      'data/r0489.csv',
      'data/r0490.csv',
      'data/r0491.csv',
      'data/r0492.csv',
      'data/r0493.csv',
      'data/r0494.csv',
    ]);
    const summary = all.artifacts.find((a) => a.kind === 'summary');
    expect((await owner.req('GET', `/jobs/${id}/artifacts/${summary?.id ?? ''}`)).body).toContain(
      '## Packed into out-rest.zip',
    );

    // Download all: one streamed zip of the latest attempt (the summary as _summary.md); p18-outputs-delivery: the
    // overflow zip's 6 files unpacked in place — 505 files and the summary, no zip in the zip.
    const dl = await owner.req('GET', `/jobs/${id}/artifacts/all.zip`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="job-/);
    const entries = zipEntries(dl.rawPayload);
    expect(entries.size).toBe(506);
    expect(entries.has('out-rest.zip')).toBe(false);
    expect(entries.get('_summary.md')?.toString()).toContain('# Summary');
    expect(entries.get('data/r0007.csv')?.toString()).toBe(row(7));
    expect(entries.get('data/r0494.csv')?.toString()).toBe(row(494));
    // Authz as the files: a viewer gets exactly what the list gives them; without a session 401.
    const vl = await viewer.req('GET', `/jobs/${id}/artifacts`);
    const vz = await viewer.req('GET', `/jobs/${id}/artifacts/all.zip`);
    const vr = await viewer.req('GET', `/jobs/${id}/output-report`);
    expect([200, 404]).toContain(vl.statusCode);
    expect(vz.statusCode).toBe(vl.statusCode);
    expect(vr.statusCode).toBe(vl.statusCode);
    const anon = await h.app.inject({ method: 'GET', url: `/jobs/${id}/artifacts/all.zip` });
    expect(anon.statusCode).toBe(401);
    expect((await owner.req('GET', `/jobs/${randomUUID()}/artifacts/all.zip`)).statusCode).toBe(404);
    // An unknown job (an owner passes the project check): nothing to report, like its empty list.
    expect((await owner.req('GET', `/jobs/${randomUUID()}/output-report`)).json()).toEqual({ report: null });
  });

  it('a worker without output-limits-v1 keeps the legacy limits: 20 files, no zip, nothing recorded', async () => {
    const script: FakeScript = () =>
      Array.from({ length: 25 }, (_, i) => ({
        kind: 'write-file' as const,
        path: `out/n${String(i).padStart(2, '0')}.txt`,
        content: `${String(i)}\n`,
      }));
    const id = await runJob(script, { outputLimits: false });
    const attempt = await h.db.pool.query<{ output_max_files: number | null }>(
      'SELECT output_max_files FROM job_attempts WHERE job_id = $1',
      [id],
    );
    expect(attempt.rows[0]?.output_max_files).toBeNull();
    const list = (await owner.req('GET', `/jobs/${id}/artifacts`)).json<{ artifacts: Artifact[] }>();
    expect(list.artifacts.filter((a) => a.kind === 'output')).toHaveLength(20);
    expect(list.artifacts.some((a) => a.name.endsWith('.zip'))).toBe(false);
    // No report from an older worker (and no refusal).
    expect((await owner.req('GET', `/jobs/${id}/output-report`)).json()).toEqual({ report: null });
  });

  it('master bounds: staging and commits follow the attempt record; the staging budget leaves blob uploads out', async () => {
    const svc = new WorkspaceService({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
      log: h.app.log,
    });
    // A job and attempts with recorded limits (a worker paired earlier; no lease is needed for these calls).
    const res = await owner.req('POST', '/jobs', { project: 'genel', spec: spec() });
    const jobId = res.json<{ job: { id: string } }>().job.id;
    const worker = (await h.db.pool.query<{ id: string }>('SELECT id FROM workers LIMIT 1')).rows[0]?.id;
    const attempt = async (n: number, maxFiles: number): Promise<string> => {
      const a = randomUUID();
      await h.db.pool.query(
        `INSERT INTO job_attempts (id, job_id, number, worker_id, state, outcome, started_at, ended_at,
                                   output_max_files)
         VALUES ($1, $2, $3, $4, 'ended', 'failed', now(), now(), $5)`,
        [a, jobId, n, worker, maxFiles],
      );
      return a;
    };
    const attemptId = await attempt(90, 2);
    const now = new Date();
    const data = Buffer.from('hello\n');
    const stage = (a: string, artifactId: string) =>
      svc.stageChunk(
        h.db.pool,
        jobId,
        { attemptId: a, artifactId, index: 0, data: data.toString('base64') },
        now,
      );
    const commit = async (n: number): Promise<string> => {
      const artifactId = `ws-o${String(n)}-test`;
      const staged = await stage(attemptId, artifactId);
      if (staged !== 'ok') return `stage:${staged}`;
      return svc.commitArtifact(
        h.db.pool,
        jobId,
        {
          attemptId,
          artifactId,
          name: `f${String(n)}.txt`,
          mediaType: 'text/plain',
          sizeBytes: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
        },
        now,
      );
    };
    expect(await commit(1)).toBe('ok');
    expect(await commit(2)).toBe('ok');
    // The third output is over the recorded limit (2): refused at commit, its chunks dropped.
    expect(await commit(3)).toBe('limit');
    // Staging stops at the limit + 2 (summary, site bundle) artifacts of the attempt.
    expect(await stage(attemptId, 'ws-o10-x')).toBe('ok');
    expect(await stage(attemptId, 'ws-o11-x')).toBe('ok');
    expect(await stage(attemptId, 'ws-o12-x')).toBe('limit');

    // A committed blob upload of 200 MiB does not use the Postgres staging budget.
    const attempt2 = await attempt(91, 500);
    const big = 200 * MiB;
    await h.db.pool.query(
      `INSERT INTO blob_objects (key, kind, location, size_bytes, sha256, created_at)
       VALUES ('artifacts/x/y/ws-o0-big', 'artifact', 'local', $1, $2, now())`,
      [big, 'a'.repeat(64)],
    );
    await h.db.pool.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                  redacted, content, blob_key, created_at)
       VALUES ($1, $2, 'ws-o0-big', 'big.zip', 'application/zip', $3, $4, 'output', false, NULL,
               'artifacts/x/y/ws-o0-big', now())`,
      [attempt2, jobId, big, 'a'.repeat(64)],
    );
    await h.db.pool.query(
      `INSERT INTO blob_uploads (id, job_id, attempt_id, epoch, worker_id, artifact_id, name, media_type, size_bytes,
                                 sha256, key, location, state, created_at, expires_at)
       VALUES ($1, $2, $3, 1, $4, 'ws-o0-big', 'big.zip', 'application/zip', $5, $6, 'artifacts/x/y/ws-o0-big',
               'local', 'committed', now(), now())`,
      [randomUUID(), jobId, attempt2, worker, big, 'a'.repeat(64)],
    );
    expect(await stage(attempt2, 'ws-summary')).toBe('ok');
  });
});
