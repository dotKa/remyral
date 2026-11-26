import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FakeScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { migrateBlobs } from '../../src/blobs/migrate.js';
import { FakeS3 } from '../helpers/fake-s3.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

/**
 * p17-object-storage end to end: Settings → Integrations → Storage (owner, always-fresh step-up, round trip against a
 * signature-checking S3 fake), large outputs of a real worker daemon through the blob store (local disk: the master's
 * upload endpoint, in parts; object storage: presigned PUTs), downloads (stream / 302 to a presigned GET), share links,
 * an older worker on the chunk path, retention → blob GC, and `blobs:migrate` (bytea → store and back).
 */

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 13;
const KEY = { accessKeyId: 'remyral-int-key', secretAccessKey: 'remyral-int-secret-0123456789' };
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

interface Artifact {
  id: string;
  name: string;
  sizeBytes: number;
  kind: string;
  sha256: string;
}

/** A ZIP-like payload (local file header) of `n` bytes with random content after the signature. */
function zipLike(n: number): Buffer {
  const b = randomBytes(n);
  b.set([0x50, 0x4b, 0x03, 0x04], 0);
  return b;
}

describeIntegration('object storage for job outputs (integration)', { timeout: 180_000 }, () => {
  let h: Harness;
  let url: string;
  let owner: Client;
  let admin: Client;
  let ownerSecret: string;
  let adminSecret: string;
  let fileUrl: string;
  let blobDir: string;
  const s3 = new FakeS3({ bucket: 'remyral-outputs', ...KEY });
  const dirs: string[] = [];
  const workers: JobWorker[] = [];

  beforeAll(async () => {
    await s3.start();
    blobDir = await mkdtemp(join(tmpdir(), 'remyral-blobs-int-'));
    dirs.push(blobDir);
    // Real clock: the worker's uploads and the presigned URLs are checked against wall-clock time.
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
        timing: { leaseTtlMs: 60_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
      },
      blobs: { dataDir: blobDir, settingsTtlMs: 0 },
    });
    url = await h.listen();
    await h.createUser('owner1', PW, 'owner');
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    await h.createUser('admin1', PW, 'admin');
    ({ secret: adminSecret } = await enroll(h, 'admin1', PW));
    admin = await fullLogin(h, 'admin1', PW, adminSecret);
    fileUrl = await createBareRepo(dirs);
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
  });
  afterAll(async () => {
    await h.stop();
    await s3.stop();
    await removeDirs(dirs);
  });

  async function stepUp(c: Client, secret: string): Promise<void> {
    h.clock.advance(30_000);
    const r = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
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

  const spec = (over: Record<string, unknown> = {}) => ({
    runtime: 'codex',
    prompt: 'Build the release',
    sandboxProfile: 'host-restricted',
    sourceTrust: 'trusted',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 600 },
    ...over,
  });

  async function runJob(
    script: FakeScript,
    features: { blob: boolean },
  ): Promise<{ id: string; a: Artifact[] }> {
    const w = await newWorker({
      workspaces: { genel: { egress: 'web', allowHosts: [] } },
      fake: { script },
      ...(features.blob ? { blobPut: true as const } : {}),
    });
    const res = await owner.req('POST', '/jobs', { project: 'genel', spec: spec() });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ job: { id: string } }>().job.id;
    await expect
      .poll(
        async () => (await owner.req('GET', `/jobs/${id}`)).json<{ job: { state: string } }>().job.state,
        {
          timeout: 90_000,
        },
      )
      .toBe('SUCCEEDED')
      .catch((err: unknown) => {
        // Diagnostics: the worker's view of the run (no secrets in the fake runtime's lines).
        const lines = w.lines.filter((l) => /artifact|upload|blob|error|warn/i.test(JSON.stringify(l)));
        throw new Error(`${String(err)}\n${JSON.stringify(lines.slice(-30), null, 1)}`);
      });
    const a = (await owner.req('GET', `/jobs/${id}/artifacts`)).json<{ artifacts: Artifact[] }>().artifacts;
    return { id, a };
  }

  async function summaryOf(id: string, a: Artifact[]): Promise<string> {
    const s = a.find((x) => x.kind === 'summary');
    return (await owner.req('GET', `/jobs/${id}/artifacts/${s?.id ?? ''}`)).body;
  }

  const s3Config = () => ({
    provider: 'minio',
    endpoint: s3.url,
    region: 'us-east-1',
    bucket: 'remyral-outputs',
    pathStyle: true,
    prefix: 'prod',
    sse: 'none',
    kmsKeyId: '',
  });

  it('settings: admin reads, only the owner writes with a fresh code; a failing bucket changes nothing', async () => {
    const read = await admin.req('GET', '/integrations/storage');
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ mode: 'local', usable: true, config: null, legacyBytes: 0 });
    expect(read.json<{ local: { dir: string } }>().local.dir).toBe(blobDir);
    await stepUp(admin, adminSecret);
    const adminPut = await admin.req('PUT', '/integrations/storage', { mode: 'local' });
    expect(adminPut.statusCode).toBe(403);
    // Past the always-fresh window of the login's code.
    h.clock.advance(10 * 60_000);
    const stale = await owner.req('PUT', '/integrations/storage', { mode: 'local' });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ error: 'step_up_required' });

    await stepUp(owner, ownerSecret);
    const wrong = await owner.req('PUT', '/integrations/storage', {
      mode: 's3',
      config: s3Config(),
      accessKeyId: KEY.accessKeyId,
      secretAccessKey: 'not-the-secret-000000',
    });
    expect(wrong.statusCode, wrong.body).toBe(400);
    expect(wrong.json()).toMatchObject({
      error: 'storage_test_failed',
      result: { ok: false, error: 'SignatureDoesNotMatch', step: 'put' },
    });
    expect((await owner.req('GET', '/integrations/storage')).json()).toMatchObject({ mode: 'local' });

    await stepUp(owner, ownerSecret);
    const ok = await owner.req('PUT', '/integrations/storage', {
      mode: 's3',
      config: s3Config(),
      accessKeyId: KEY.accessKeyId,
      secretAccessKey: KEY.secretAccessKey,
      limits: {
        maxFileBytes: 64 * 1024 * 1024,
        maxJobBytes: 256 * 1024 * 1024,
        thresholdBytes: 1024 * 1024,
        downloadTtlSeconds: 120,
        shareMaxDays: 3,
      },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      mode: 's3',
      usable: true,
      keyIdHint: '-key',
      config: { bucket: 'remyral-outputs', prefix: 'prod/' },
      limits: { thresholdBytes: 1024 * 1024, shareMaxDays: 3 },
    });
    expect(ok.body).not.toContain(KEY.secretAccessKey);
    // The round trip left nothing behind; the key is stored sealed, never in clear.
    expect([...s3.objects.keys()].filter((k) => k.includes('storage-test'))).toEqual([]);
    const row = await h.db.pool.query<{ secret: Buffer; config: Record<string, unknown> }>(
      'SELECT secret, config FROM object_storage_settings WHERE id = 1',
    );
    expect(row.rows[0]?.secret.toString('latin1')).not.toContain(KEY.secretAccessKey);
    expect(JSON.stringify(row.rows[0]?.config)).not.toContain(KEY.secretAccessKey);
    const audit = await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
      `SELECT outcome, metadata FROM audit_events WHERE action = 'storage.settings.save' ORDER BY id`,
    );
    expect(audit.rows.map((r) => r.outcome)).toEqual(['failure', 'success']);
    expect(JSON.stringify(audit.rows)).not.toContain(KEY.secretAccessKey);
    const test = await owner.req('POST', '/integrations/storage/test');
    expect(test.json()).toMatchObject({ ok: true, provider: 'minio' });

    // Back to local disk (the bucket settings are kept, so blobs written meanwhile stay readable).
    await stepUp(owner, ownerSecret);
    const local = await owner.req('PUT', '/integrations/storage', { mode: 'local' });
    expect(local.statusCode, local.body).toBe(200);
    expect(local.json()).toMatchObject({ mode: 'local', config: { bucket: 'remyral-outputs' } });
  });

  it('local disk: a large output goes to the master endpoint in parts; small files land in the blob directory', async () => {
    // 9 MiB > the 8 MiB local part size: two parts. Plus an installer and a small report.
    const zip = zipLike(9 * 1024 * 1024);
    const exe = Buffer.concat([Buffer.from('MZ'), randomBytes(2 * 1024 * 1024)]);
    const script: FakeScript = () => [
      { kind: 'write-file', path: 'out/release.zip', content: zip.toString('base64'), encoding: 'base64' },
      { kind: 'write-file', path: 'out/setup.exe', content: exe.toString('base64'), encoding: 'base64' },
      { kind: 'write-file', path: 'out/report.md', content: '# Release\n\nDone.\n' },
    ];
    const { id, a } = await runJob(script, { blob: true });
    expect(a.map((x) => x.name).sort(), await summaryOf(id, a)).toEqual([
      'release.zip',
      'report.md',
      'setup.exe',
      'summary.md',
    ]);
    const big = a.find((x) => x.name === 'release.zip');
    expect(big).toMatchObject({ sizeBytes: zip.length, sha256: sha(zip) });
    const rows = await h.db.pool.query<{ name: string; content: Buffer | null; blob_key: string | null }>(
      'SELECT name, content, blob_key FROM job_artifacts WHERE job_id = $1 ORDER BY name',
      [id],
    );
    // Never Postgres: every row (chunk path included) points at a blob.
    for (const r of rows.rows) {
      expect(r.content, r.name).toBeNull();
      expect(r.blob_key, r.name).toMatch(/^artifacts\//);
    }
    const objs = await h.db.pool.query<{ key: string; location: string; verified_at: Date | null }>(
      `SELECT o.key, o.location, o.verified_at FROM blob_objects o JOIN job_artifacts a ON a.blob_key = o.key
        WHERE a.job_id = $1`,
      [id],
    );
    expect(objs.rows.every((o) => o.location === 'local' && o.verified_at !== null)).toBe(true);
    const zipKey = rows.rows.find((r) => r.name === 'release.zip')?.blob_key ?? '';
    const st = await stat(join(blobDir, ...zipKey.split('/')));
    expect(st.size).toBe(zip.length);
    expect(st.mode & 0o777).toBe(0o600);
    // Download: streamed attachment (local), and the old route for the console's fetch.
    const dl = await owner.req('GET', `/jobs/${id}/artifacts/${big?.id ?? ''}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment; filename="release.zip"');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(sha(dl.rawPayload)).toBe(sha(zip));
    const old = await owner.req('GET', `/jobs/${id}/artifacts/${big?.id ?? ''}`);
    expect(sha(old.rawPayload)).toBe(sha(zip));
    const report = a.find((x) => x.name === 'report.md');
    expect((await owner.req('GET', `/jobs/${id}/artifacts/${report?.id ?? ''}?inline=1`)).body).toContain(
      'Done.',
    );
    expect(await summaryOf(id, a)).toContain('release.zip');
    // The grants were audited and are committed.
    const uploads = await h.db.pool.query<{ state: string; location: string }>(
      'SELECT state, location FROM blob_uploads WHERE job_id = $1',
      [id],
    );
    expect(uploads.rows.map((u) => `${u.location}:${u.state}`).sort()).toEqual([
      'local:committed',
      'local:committed',
    ]);
    const audits = await h.db.pool.query<{ action: string; outcome: string }>(
      `SELECT action, outcome FROM audit_events WHERE target = $1 AND action LIKE 'blob.upload.%'`,
      [`job:${id}`],
    );
    expect(audits.rows.filter((r) => r.outcome === 'success').length).toBe(4);
  });

  it('object storage: presigned PUTs, a 302 to a presigned GET; share links (fresh code, audited, revocable)', async () => {
    await stepUp(owner, ownerSecret);
    const toS3 = await owner.req('PUT', '/integrations/storage', { mode: 's3' });
    expect(
      toS3.statusCode,
      JSON.stringify(h.logs.entries.filter((e) => (e.level as number) >= 50).slice(-3)),
    ).toBe(200);
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypisom'),
      randomBytes(3 * 1024 * 1024),
    ]);
    const script: FakeScript = () => [
      { kind: 'write-file', path: 'out/demo.mp4', content: mp4.toString('base64'), encoding: 'base64' },
      { kind: 'write-file', path: 'out/notes.md', content: '# Notes\n' },
    ];
    const { id, a } = await runJob(script, { blob: true });
    const video = a.find((x) => x.name === 'demo.mp4');
    expect(video).toMatchObject({ sizeBytes: mp4.length });
    const key = (
      await h.db.pool.query<{ blob_key: string }>(
        `SELECT blob_key FROM job_artifacts WHERE job_id = $1 AND name = 'demo.mp4'`,
        [id],
      )
    ).rows[0]?.blob_key;
    expect(s3.objects.get(`prod/${key ?? ''}`)?.data.equals(mp4)).toBe(true);
    // The worker never saw the keys: only presigned URLs.
    const grants = s3.log.filter((l) => l.method === 'PUT' && !l.path.includes('demo.mp4'));
    expect(grants.length).toBeGreaterThan(0);

    const dl = await owner.req('GET', `/jobs/${id}/artifacts/${video?.id ?? ''}/download`);
    expect(dl.statusCode).toBe(302);
    const location = String(dl.headers.location);
    expect(location.startsWith(s3.url)).toBe(true);
    expect(location).toContain('X-Amz-Expires=120');
    expect(location).not.toContain(KEY.secretAccessKey);
    const got = await fetch(location);
    expect(got.headers.get('content-disposition')).toContain('attachment');
    expect(sha(Buffer.from(await got.arrayBuffer()))).toBe(sha(mp4));
    // "S3'te aç": the browser's own viewer for a video, still on the bucket's origin.
    const open = await owner.req('GET', `/jobs/${id}/artifacts/${video?.id ?? ''}/download?open=1`);
    expect(decodeURIComponent(String(open.headers.location))).toContain('inline; filename="demo.mp4"');

    // Share links: admin+ only, a fresh code under the strict preset, at most shareMaxDays.
    const tooLong = await admin.req('POST', `/jobs/${id}/artifacts/${video?.id ?? ''}/shares`, { days: 5 });
    expect([400, 403]).toContain(tooLong.statusCode);
    await stepUp(admin, adminSecret);
    const share = await admin.req('POST', `/jobs/${id}/artifacts/${video?.id ?? ''}/shares`, { days: 2 });
    expect(share.statusCode, share.body).toBe(200);
    const path = share.json<{ path: string; link: { id: string } }>().path;
    expect(path).toMatch(/^\/share\/f\/[A-Za-z0-9_-]{43}$/);
    const anon = await h.app.inject({ method: 'GET', url: path });
    expect(anon.statusCode).toBe(302);
    expect((await fetch(String(anon.headers.location))).status).toBe(200);
    const list = await admin.req('GET', `/jobs/${id}/artifacts/${video?.id ?? ''}/shares`);
    expect(list.json<{ links: { useCount: number }[] }>().links[0]?.useCount).toBe(1);
    expect(list.body).not.toContain(path.slice(-43));
    const shareId = share.json<{ link: { id: string } }>().link.id;
    const revoked = await admin.req('DELETE', `/jobs/${id}/artifacts/${video?.id ?? ''}/shares/${shareId}`);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: path })).statusCode).toBe(410);
    expect((await h.app.inject({ method: 'GET', url: '/share/f/' + 'A'.repeat(43) })).statusCode).toBe(404);
    const audits = await h.db.pool.query<{ action: string; outcome: string }>(
      `SELECT action, outcome FROM audit_events WHERE action LIKE 'outputs.share.%' ORDER BY id`,
    );
    expect(audits.rows.map((r) => `${r.action}:${r.outcome}`)).toEqual([
      'outputs.share.create:success',
      'outputs.share.open:success',
      'outputs.share.revoke:success',
      'outputs.share.open:denied',
    ]);
    // Back to local for the next cases.
    await stepUp(owner, ownerSecret);
    expect((await owner.req('PUT', '/integrations/storage', { mode: 'local' })).statusCode).toBe(200);
    // The bucket's blob stays readable after the switch.
    expect((await owner.req('GET', `/jobs/${id}/artifacts/${video?.id ?? ''}/download`)).statusCode).toBe(
      302,
    );
  });

  it('an older worker (no blob-upload-v1) keeps the chunk path; large deliverables are named as not returned', async () => {
    const script: FakeScript = () => [
      {
        kind: 'write-file',
        path: 'out/bundle.zip',
        content: zipLike(1024).toString('base64'),
        encoding: 'base64',
      },
      { kind: 'write-file', path: 'out/readme.md', content: '# Readme\n' },
    ];
    const { id, a } = await runJob(script, { blob: false });
    expect(a.map((x) => x.name).sort()).toEqual(['readme.md', 'summary.md']);
    expect(await summaryOf(id, a)).toContain(
      'bundle.zip: large files need a master with object storage support',
    );
    // The chunk path still never stores bytes in Postgres.
    const rows = await h.db.pool.query<{ content: Buffer | null; blob_key: string | null }>(
      'SELECT content, blob_key FROM job_artifacts WHERE job_id = $1',
      [id],
    );
    expect(rows.rows.every((r) => r.content === null && r.blob_key !== null)).toBe(true);
  });

  it('retention prunes the reference; the blob GC deletes the blob after its grace period (audited)', async () => {
    const script: FakeScript = () => [{ kind: 'write-file', path: 'out/old.md', content: '# Old\n' }];
    const { id } = await runJob(script, { blob: true });
    const before = await h.db.pool.query<{ blob_key: string }>(
      `SELECT blob_key FROM job_artifacts WHERE job_id = $1 AND name = 'old.md'`,
      [id],
    );
    const key = before.rows[0]?.blob_key ?? '';
    expect(await stat(join(blobDir, ...key.split('/')))).toBeTruthy();
    await h.db.pool.query('UPDATE project_workspaces SET artifact_retention_days = 1 WHERE project = $1', [
      'genel',
    ]);
    h.clock.advance(3 * 86_400_000);
    await h.app.workspaceStorage.sweep();
    const after = await h.db.pool.query<{ blob_key: string | null; pruned_reason: string | null }>(
      `SELECT blob_key, pruned_reason FROM job_artifacts WHERE job_id = $1 AND name = 'old.md'`,
      [id],
    );
    expect(after.rows[0]).toEqual({ blob_key: null, pruned_reason: 'retention' });
    const gc = await h.app.blobs.gc();
    expect(gc.deleted).toBeGreaterThan(0);
    await expect(stat(join(blobDir, ...key.split('/')))).rejects.toThrow();
    expect((await h.db.pool.query('SELECT 1 FROM blob_objects WHERE key = $1', [key])).rowCount).toBe(0);
    const audit = await h.db.pool.query(`SELECT 1 FROM audit_events WHERE action = 'blobs.gc'`);
    expect(audit.rowCount).toBeGreaterThan(0);
    await h.db.pool.query('UPDATE project_workspaces SET artifact_retention_days = NULL WHERE project = $1', [
      'genel',
    ]);
  });

  it('blobs:migrate moves legacy bytea rows into the store (verified, resumable) and back with --to-db', async () => {
    const job = await h.db.pool.query<{ id: string; attempt: string }>(
      `SELECT j.id::text AS id, a.attempt_id::text AS attempt FROM jobs j JOIN job_artifacts a ON a.job_id = j.id
        LIMIT 1`,
    );
    const j = job.rows[0];
    if (j === undefined) throw new Error('no job');
    const legacy = Buffer.from('# Legacy bytes kept in Postgres\n');
    const corrupt = Buffer.from('# Corrupt\n');
    await h.db.pool.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                  redacted, content, created_at)
       VALUES ($1, $2, 'ws-legacy-1', 'legacy.md', 'text/markdown', $3, $4, 'output', false, $5, $9),
              ($1, $2, 'ws-legacy-2', 'corrupt.md', 'text/markdown', $6, $7, 'output', false, $8, $9)`,
      // Created "now" on the master's (test) clock, which the previous test moved 3 days ahead: with the database's
      // now() the rows were older than the 1-day retention a still running background sweep of that test applied,
      // and it could prune them between the dry run and the run.
      [
        j.attempt,
        j.id,
        legacy.length,
        sha(legacy),
        legacy,
        corrupt.length,
        'f'.repeat(64),
        corrupt,
        h.clock.now(),
      ],
    );
    const deps = {
      pool: h.db.pool,
      blobs: h.app.blobs,
      audit: { record: () => Promise.resolve({ id: '', hash: Buffer.alloc(0) }) },
    };
    const dry = await migrateBlobs(deps, { dryRun: true, kinds: ['artifact'] });
    expect(dry[0]).toMatchObject({ kind: 'artifact', candidates: 2, moved: 0 });
    const run = await migrateBlobs(deps, { dryRun: false, kinds: ['artifact', 'input'] });
    expect(run[0]).toMatchObject({ moved: 1, failed: 1 });
    expect(run[0]?.failures[0]).toContain('do not match the row SHA-256');
    const moved = await h.db.pool.query<{ content: Buffer | null; blob_key: string | null }>(
      `SELECT content, blob_key FROM job_artifacts WHERE artifact_id = 'ws-legacy-1'`,
    );
    expect(moved.rows[0]?.content).toBeNull();
    expect((await h.app.blobs.read(moved.rows[0]?.blob_key ?? '')).equals(legacy)).toBe(true);
    // The corrupt row keeps its bytes (never dropped without a verified copy); a second run moves nothing new.
    const again = await migrateBlobs(deps, { dryRun: false, kinds: ['artifact'] });
    expect(again[0]).toMatchObject({ candidates: 1, moved: 0, failed: 1 });
    // Rollback path.
    const back = await migrateBlobs(deps, { dryRun: false, kinds: ['artifact'], toDb: true });
    expect(back[0]?.moved).toBeGreaterThan(0);
    const restored = await h.db.pool.query<{ content: Buffer | null; blob_key: string | null }>(
      `SELECT content, blob_key FROM job_artifacts WHERE artifact_id = 'ws-legacy-1'`,
    );
    expect(restored.rows[0]?.content?.equals(legacy)).toBe(true);
    expect(restored.rows[0]?.blob_key).toBeNull();
    await h.db.pool.query(`DELETE FROM job_artifacts WHERE artifact_id IN ('ws-legacy-1', 'ws-legacy-2')`);
  });
});
