import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrateBlobs } from '../../src/blobs/migrate.js';
import { moveBlobs } from '../../src/blobs/move.js';
import type { BlobKind } from '../../src/blobs/store.js';
import { FakeS3 } from '../helpers/fake-s3.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { removeDirs } from '../helpers/real-worker.js';

/**
 * p17-object-storage-rest (docs/design/p17-object-storage.md §13) end to end on a real master: chat attachments,
 * automation files, workflow run files and job input bundles are written to the blob store (never bytea), read back
 * through their authorised routes (another user gets 404), and deleting / pruning them leaves blobs the GC removes from
 * the disk; `blobs:migrate` moves mixed legacy rows (a corrupt one is kept) and back; `--to-store` moves blobs from
 * the local disk into a bucket (signature-checking S3 fake) and back, with a failing PUT and a failing delete midway.
 */

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 13;
const KEY = { accessKeyId: 'remyral-rest-key', secretAccessKey: 'remyral-rest-secret-0123456789' };
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const b64 = (s: string | Buffer): string => (typeof s === 'string' ? Buffer.from(s) : s).toString('base64');
const REST_KINDS: BlobKind[] = ['chat-attachment', 'workflow-file', 'automation-file', 'input-bundle'];

describeIntegration('object storage for the remaining blobs (integration)', { timeout: 240_000 }, () => {
  let h: Harness;
  let owner: Client;
  let ownerSecret: string;
  let other: Client;
  let otherSecret: string;
  let blobDir: string;
  const s3 = new FakeS3({ bucket: 'remyral-rest', ...KEY });
  const dirs: string[] = [];
  const noAudit = { record: () => Promise.resolve({ id: '', hash: Buffer.alloc(0) }) };

  beforeAll(async () => {
    await s3.start();
    blobDir = await mkdtemp(join(tmpdir(), 'remyral-blobs-rest-'));
    dirs.push(blobDir);
    h = new Harness();
    await h.start({
      orchestration: {
        redisUrl: redisUrlWithDb(HINT_DB),
        hintPrefix: `t${randomUUID().slice(0, 8)}`,
        tickIntervalMs: 50,
        timing: { leaseTtlMs: 60_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
      },
      blobs: { dataDir: blobDir, settingsTtlMs: 0 },
    });
    await h.createUser('owner1', PW, 'owner');
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    const otherId = await h.createUser('op.other', PW, 'operator');
    ({ secret: otherSecret } = await enroll(h, 'op.other', PW));
    other = await fullLogin(h, 'op.other', PW, otherSecret);
    await stepUp();
    const ws = await owner.req('POST', '/projects', {
      id: 'store',
      name: 'store',
      kind: 'workspace',
      egress: 'none',
    });
    expect(ws.statusCode, ws.body).toBe(201);
    const ws2 = await owner.req('POST', '/projects', {
      id: 'elsewhere',
      name: 'e',
      kind: 'workspace',
      egress: 'none',
    });
    expect(ws2.statusCode, ws2.body).toBe(201);
    await h.grant(otherId, ['elsewhere'], 'operator');
  });
  afterAll(async () => {
    await h.stop();
    await s3.stop();
    await removeDirs(dirs);
  });

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
  }

  const onDisk = async (key: string): Promise<boolean> =>
    stat(join(blobDir, ...key.split('/'))).then(
      () => true,
      () => false,
    );

  async function blobRow(key: string) {
    const r = await h.db.pool.query<{ location: string; prior_location: string | null; kind: string }>(
      'SELECT location, prior_location, kind FROM blob_objects WHERE key = $1',
      [key],
    );
    return r.rows[0] ?? null;
  }

  /** Moves the clock (sessions expire: both users log in again). */
  async function later(ms: number): Promise<void> {
    h.clock.advance(ms);
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    other = await fullLogin(h, 'op.other', PW, otherSecret);
  }

  /** Past the GC grace period, then one GC pass. */
  async function gcLater(): Promise<void> {
    await later(2 * 60 * 60_000);
    await h.app.blobs.gc();
  }

  async function newThread(): Promise<string> {
    const res = await owner.req('POST', '/chat/threads', {});
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function bundle(project: string, files: { path: string; content: Buffer }[]): Promise<string> {
    const s = await owner.req('POST', `/projects/${project}/input-uploads`, {
      files: files.map((f) => ({ path: f.path, size: f.content.length, sha256: sha(f.content) })),
      label: 'proje.zip',
    });
    expect(s.statusCode, s.body).toBe(201);
    const up = s.json<{ id: string; partSize: number; partCount: number }>();
    const all = Buffer.concat(files.map((f) => f.content));
    for (let n = 0; n < up.partCount; n++) {
      const part = all.subarray(n * up.partSize, (n + 1) * up.partSize);
      const r = await owner.req(
        'PUT',
        `/projects/${project}/input-uploads/${up.id}/parts/${String(n)}`,
        part,
        {
          'content-type': 'application/octet-stream',
          'x-part-sha256': sha(part),
        },
      );
      expect(r.statusCode, r.body).toBe(200);
    }
    const done = await owner.req('POST', `/projects/${project}/input-uploads/${up.id}/complete`, {});
    expect(done.statusCode, done.body).toBe(200);
    return up.id;
  }

  it('chat attachments: stored as blobs, readable only by the thread owner, gone from the disk after a thread delete', async () => {
    const t = await newThread();
    const up = await owner.req('POST', `/chat/threads/${t}/attachments`, {
      name: 'notes.txt',
      contentBase64: b64('hello from the blob store'),
    });
    expect(up.statusCode, up.body).toBe(201);
    const id = up.json<{ id: string }>().id;
    const row = await h.db.pool.query<{ content: Buffer | null; blob_key: string | null }>(
      'SELECT content, blob_key FROM chat_attachments WHERE id = $1',
      [id],
    );
    const key = row.rows[0]?.blob_key ?? '';
    expect(row.rows[0]?.content).toBeNull();
    expect(key).toBe(`chat-attachments/${t}/${id}`);
    expect((await stat(join(blobDir, ...key.split('/')))).mode & 0o777).toBe(0o600);
    expect(await blobRow(key)).toMatchObject({ kind: 'chat-attachment', location: 'local' });
    const own = await owner.req('GET', `/chat/attachments/${id}/content`);
    expect(own.statusCode).toBe(200);
    expect(own.body).toBe('hello from the blob store');
    // No cross-user read: the blob key never helps another user.
    expect((await other.req('GET', `/chat/attachments/${id}/content`)).statusCode).toBe(404);

    // A legacy bytea row (written before this release) still reads.
    const legacyId = randomUUID();
    const legacy = Buffer.from('legacy bytes');
    await h.db.pool.query(
      `INSERT INTO chat_attachments (id, thread_id, user_id, kind, name, media_type, size_bytes, sha256, content,
                                     created_at)
       SELECT $1, $2, user_id, 'text', 'old.txt', 'text/plain', $3, $4, $5, now() FROM chat_threads WHERE id = $2`,
      [legacyId, t, legacy.length, sha(legacy), legacy],
    );
    expect((await owner.req('GET', `/chat/attachments/${legacyId}/content`)).body).toBe('legacy bytes');

    // Thread delete → the row goes with it → the GC deletes the blob (no orphan file).
    expect((await owner.req('DELETE', `/chat/threads/${t}`)).statusCode).toBe(204);
    expect(await onDisk(key)).toBe(true);
    await gcLater();
    expect(await onDisk(key)).toBe(false);
    expect(await blobRow(key)).toBeNull();
  });

  it('automation and workflow run files: blobs; the run job reads them; pruning / deleting leaves nothing behind', async () => {
    await stepUp();
    const def = await owner.req('POST', '/workflows', {
      project: 'store',
      definition: {
        name: 'blob-files',
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
    const created = await owner.req('POST', '/automations', {
      project: 'store',
      name: 'Automation with files',
      trigger: { kind: 'cron', cron: '0 9 * * 1' },
      target: {
        kind: 'workflow',
        workflowId: def.json<{ id: string }>().id,
        inputs: {},
        files: [{ name: 'brief.md', contentBase64: b64('# Brief\n') }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const automationId = created.json<{ automation: { id: string } }>().automation.id;
    const af = await h.db.pool.query<{ content: Buffer | null; blob_key: string; input_id: string }>(
      'SELECT content, blob_key, input_id FROM automation_files WHERE automation_id = $1',
      [automationId],
    );
    const autoKey = af.rows[0]?.blob_key ?? '';
    expect(af.rows[0]?.content).toBeNull();
    expect(autoKey).toBe(`automation-files/${automationId}/${af.rows[0]?.input_id ?? ''}`);
    expect(await onDisk(autoKey)).toBe(true);

    const run = await owner.req('POST', `/automations/${automationId}/run`, {});
    expect(run.statusCode, run.body).toBe(202);
    const runId = run.json<{ workflowRunId: string | null }>().workflowRunId ?? '';
    const rf = await h.db.pool.query<{ content: Buffer | null; blob_key: string }>(
      'SELECT content, blob_key FROM workflow_run_files WHERE run_id = $1',
      [runId],
    );
    const runKey = rf.rows[0]?.blob_key ?? '';
    expect(rf.rows[0]?.content).toBeNull();
    expect(runKey.startsWith(`workflow-files/${runId}/`)).toBe(true);
    // The step job got the run's file as its input (read back from the blob store).
    await expect
      .poll(
        async () => {
          const r = await h.db.pool.query<{ name: string; blob_key: string | null }>(
            `SELECT i.name, i.blob_key FROM job_inputs i JOIN jobs j ON j.id = i.job_id
            WHERE j.project = 'store' AND i.name = 'brief.md' AND i.blob_key IS NOT NULL`,
          );
          return r.rows.length;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    expect(
      (await owner.req('POST', `/workflows/runs/${runId}/cancel`, { reason: 'test done' })).statusCode,
    ).toBe(200);

    // Retention prunes the run file (bytea and blob reference); deleting the automation drops its file rows.
    await h.db.pool.query('UPDATE project_workspaces SET artifact_retention_days = 1 WHERE project = $1', [
      'store',
    ]);
    await later(3 * 86_400_000);
    await h.app.workspaceStorage.sweep();
    const pruned = await h.db.pool.query<{ blob_key: string | null; pruned: boolean }>(
      'SELECT blob_key, pruned_at IS NOT NULL AS pruned FROM workflow_run_files WHERE run_id = $1',
      [runId],
    );
    expect(pruned.rows[0]).toEqual({ blob_key: null, pruned: true });
    await h.db.pool.query('UPDATE project_workspaces SET artifact_retention_days = NULL WHERE project = $1', [
      'store',
    ]);
    await stepUp();
    const del = await owner.req('DELETE', `/automations/${automationId}`);
    expect(del.statusCode, del.body).toBe(200);
    // A deleted automation keeps its history, not its stored files.
    const afterDelete = await h.db.pool.query('SELECT 1 FROM automation_files WHERE automation_id = $1', [
      automationId,
    ]);
    expect(afterDelete.rowCount).toBe(0);
    await gcLater();
    expect(await onDisk(runKey)).toBe(false);
    expect(await onDisk(autoKey)).toBe(false);
  });

  it('job input bundles: files as blobs, the relay reads ranges of them, deleting the bundle deletes them', async () => {
    const big = Buffer.alloc(300_000, 'a');
    const id = await bundle('store', [
      { path: 'README.md', content: Buffer.from('# Bundle\n') },
      { path: 'data/big.txt', content: big },
    ]);
    const files = await h.db.pool.query<{ idx: number; content: Buffer | null; blob_key: string }>(
      'SELECT idx, content, blob_key FROM input_upload_files WHERE upload_id = $1 ORDER BY idx',
      [id],
    );
    expect(files.rows.map((r) => [r.content, r.blob_key])).toEqual([
      [null, `input-uploads/${id}/0`],
      [null, `input-uploads/${id}/1`],
    ]);
    const job = await owner.req('POST', '/jobs', {
      project: 'store',
      spec: {
        runtime: 'codex',
        prompt: 'Use the bundle',
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
      },
      inputUpload: id,
    });
    expect(job.statusCode, job.body).toBe(201);
    const jobId = job.json<{ job: { id: string } }>().job.id;
    // The relay's file slices come from the blob (range reads), the last one says eof.
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const r = await h.app.inputUploads.slice(jobId, { op: 'read', index: 1, offset });
      if (r === null || r.kind !== 'read') throw new Error('no slice');
      parts.push(r.data);
      offset += r.data.length;
      if (r.eof) break;
    }
    expect(Buffer.concat(parts).equals(big)).toBe(true);
    // Another user (another project) cannot use the bundle.
    const foreign = await other.req('POST', '/jobs', {
      project: 'elsewhere',
      spec: {
        runtime: 'codex',
        prompt: 'x',
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
      },
      inputUpload: id,
    });
    expect(foreign.statusCode).toBeGreaterThanOrEqual(400);
    expect((await owner.req('POST', `/jobs/${jobId}/cancel`, { reason: 'done' })).statusCode).toBe(200);
    const removed = await owner.req('DELETE', `/projects/store/input-uploads/${id}`);
    expect([200, 204]).toContain(removed.statusCode);
    await gcLater();
    for (const r of files.rows) expect(await onDisk(r.blob_key)).toBe(false);
  });

  it('blobs:migrate moves mixed legacy rows of the four tables (a corrupt one is kept), resumes, and goes back', async () => {
    // Parents: a thread, an automation without files, a cancelled run, a ready bundle.
    const t = await newThread();
    const user = await h.db.pool.query<{ user_id: string }>(
      'SELECT user_id::text FROM chat_threads WHERE id = $1',
      [t],
    );
    const auto = await h.db.pool.query<{ id: string }>('SELECT id::text AS id FROM automations LIMIT 1');
    let automationId = auto.rows[0]?.id;
    if (automationId === undefined) {
      await stepUp();
      const c = await owner.req('POST', '/automations', {
        project: 'store',
        name: 'Holder',
        trigger: { kind: 'cron', cron: '0 9 * * 1' },
        target: { kind: 'job', spec: { runtime: 'codex', prompt: 'x', sandboxProfile: 'host-restricted' } },
      });
      expect(c.statusCode, c.body).toBe(201);
      automationId = c.json<{ automation: { id: string } }>().automation.id;
    }
    const runRow = await h.db.pool.query<{ id: string }>('SELECT id::text AS id FROM workflow_runs LIMIT 1');
    const runId = runRow.rows[0]?.id ?? '';
    const uploadId = await bundle('store', [{ path: 'a.txt', content: Buffer.from('aaa') }]);
    const bytes = (s: string): Buffer => Buffer.from(s);
    const chatOk = bytes('legacy chat');
    const chatBad = bytes('corrupt chat');
    const wf = bytes('legacy run file');
    const am = bytes('legacy automation file');
    const ib = bytes('legacy bundle file');
    const [chatA, chatB] = [randomUUID(), randomUUID()];
    await h.db.pool.query(
      `INSERT INTO chat_attachments (id, thread_id, user_id, kind, name, media_type, size_bytes, sha256, content,
                                     created_at)
       VALUES ($1, $3, $4, 'text', 'a.txt', 'text/plain', $5, $6, $7, now()),
              ($2, $3, $4, 'text', 'b.txt', 'text/plain', $8, $9, $10, now())`,
      [
        chatA,
        chatB,
        t,
        user.rows[0]?.user_id,
        chatOk.length,
        sha(chatOk),
        chatOk,
        chatBad.length,
        'e'.repeat(64),
        chatBad,
      ],
    );
    await h.db.pool.query(
      `INSERT INTO workflow_run_files (run_id, input_id, name, media_type, size_bytes, sha256, content, source,
                                       created_at)
       VALUES ($1, 'in-legacy1', 'legacy.md', 'text/markdown', $2, $3, $4, 'upload', now())`,
      [runId, wf.length, sha(wf), wf],
    );
    await h.db.pool.query(
      `INSERT INTO automation_files (automation_id, input_id, name, media_type, size_bytes, sha256, content,
                                     created_at)
       VALUES ($1, 'in-legacy2', 'legacy2.md', 'text/markdown', $2, $3, $4, now())`,
      [automationId, am.length, sha(am), am],
    );
    await h.db.pool.query(
      `INSERT INTO input_upload_files (upload_id, idx, path, size_bytes, sha256, content)
       VALUES ($1, 99, 'legacy.txt', $2, $3, $4)`,
      [uploadId, ib.length, sha(ib), ib],
    );
    const deps = { pool: h.db.pool, blobs: h.app.blobs, audit: noAudit };
    const dry = await migrateBlobs(deps, { dryRun: true, kinds: REST_KINDS });
    expect(dry.map((r) => [r.kind, r.candidates, r.moved])).toEqual([
      ['chat-attachment', 2, 0],
      ['workflow-file', 1, 0],
      ['automation-file', 1, 0],
      ['input-bundle', 1, 0],
    ]);
    expect(dry[0]?.candidateBytes).toBe(chatOk.length + chatBad.length);
    // Resumable: a first run limited to one row per kind, then the rest.
    const first = await migrateBlobs(deps, { dryRun: false, kinds: REST_KINDS, limit: 1, batch: 1 });
    expect(first.reduce((n, r) => n + r.moved + r.failed, 0)).toBe(4);
    const rest = await migrateBlobs(deps, { dryRun: false, kinds: REST_KINDS });
    const all = [...first, ...rest];
    const moved = (k: BlobKind) => all.filter((r) => r.kind === k).reduce((n, r) => n + r.moved, 0);
    expect(REST_KINDS.map(moved)).toEqual([1, 1, 1, 1]);
    expect(rest.find((r) => r.kind === 'chat-attachment')?.failures.join()).toContain(
      'do not match the row SHA-256',
    );
    // The moved rows read through the normal paths; the corrupt one keeps its bytes.
    expect((await owner.req('GET', `/chat/attachments/${chatA}/content`)).body).toBe('legacy chat');
    const kept = await h.db.pool.query<{ content: Buffer | null; blob_key: string | null }>(
      'SELECT content, blob_key FROM chat_attachments WHERE id = $1',
      [chatB],
    );
    expect(kept.rows[0]?.content?.equals(chatBad)).toBe(true);
    expect(kept.rows[0]?.blob_key).toBeNull();
    const keys = await h.db.pool.query<{ k: string }>(
      `SELECT blob_key AS k FROM workflow_run_files WHERE input_id = 'in-legacy1'
       UNION ALL SELECT blob_key FROM automation_files WHERE input_id = 'in-legacy2'
       UNION ALL SELECT blob_key FROM input_upload_files WHERE upload_id = $1 AND idx = 99`,
      [uploadId],
    );
    expect(keys.rows.map((r) => r.k)).toEqual([
      `workflow-files/${runId}/in-legacy1`,
      `automation-files/${automationId}/in-legacy2`,
      `input-uploads/${uploadId}/99`,
    ]);
    expect((await h.app.blobs.read(keys.rows[2]?.k ?? '')).equals(ib)).toBe(true);
    // Idempotent: nothing new on a second run; the corrupt row is reported again.
    const again = await migrateBlobs(deps, { dryRun: false, kinds: REST_KINDS });
    expect(again.map((r) => r.moved)).toEqual([0, 0, 0, 0]);
    // Rollback path.
    const back = await migrateBlobs(deps, { dryRun: false, kinds: ['automation-file'], toDb: true });
    expect(back[0]?.moved).toBeGreaterThan(0);
    const restored = await h.db.pool.query<{ content: Buffer | null; blob_key: string | null }>(
      `SELECT content, blob_key FROM automation_files WHERE input_id = 'in-legacy2'`,
    );
    expect(restored.rows[0]?.content?.equals(am)).toBe(true);
    expect(restored.rows[0]?.blob_key).toBeNull();
    await h.db.pool.query('DELETE FROM chat_attachments WHERE id = $1', [chatB]);
  });

  it('blobs:migrate --to-store: local disk → bucket → local disk, surviving a failed PUT and a failed delete', async () => {
    await stepUp();
    const put = await owner.req('PUT', '/integrations/storage', {
      mode: 's3',
      config: {
        provider: 'minio',
        endpoint: s3.url,
        region: 'us-east-1',
        bucket: 'remyral-rest',
        pathStyle: true,
        prefix: 'prod',
        sse: 'none',
        kmsKeyId: '',
      },
      accessKeyId: KEY.accessKeyId,
      secretAccessKey: KEY.secretAccessKey,
    });
    expect(put.statusCode, put.body).toBe(200);
    // Three chat attachments on the local disk (written before the switch).
    await h.db.pool.query(`UPDATE object_storage_settings SET mode = 'local'`);
    const t = await newThread();
    const bodies = ['one', 'two', 'three'].map((s) => `${s} ${randomUUID()}`);
    const ids: string[] = [];
    for (const [i, b] of bodies.entries()) {
      const r = await owner.req('POST', `/chat/threads/${t}/attachments`, {
        name: `f${String(i)}.txt`,
        contentBase64: b64(b),
      });
      expect(r.statusCode, r.body).toBe(201);
      ids.push(r.json<{ id: string }>().id);
    }
    await h.db.pool.query(`UPDATE object_storage_settings SET mode = 's3'`);
    const keys = ids.map((id) => `chat-attachments/${t}/${id}`);
    const deps = { pool: h.db.pool, blobs: h.app.blobs, audit: noAudit };
    const kinds: BlobKind[] = ['chat-attachment'];

    const dry = await moveBlobs(deps, { to: 's3', dryRun: true, kinds });
    expect(dry[0]?.candidates).toBeGreaterThanOrEqual(3);
    expect(dry[0]?.candidateBytes).toBeGreaterThan(0);
    expect(s3.objects.size).toBe(0);
    const total = dry[0]?.candidates ?? 0;

    // A PUT fails midway (the provider answers 503): that blob stays on the disk, readable; the others move.
    s3.failNext = { status: 503, code: 'SlowDown' };
    const first = await moveBlobs(deps, { to: 's3', dryRun: false, kinds });
    expect(first[0]).toMatchObject({ moved: total - 1, failed: 1 });
    expect(first[0]?.failures[0]).toContain('SlowDown');
    for (const [i, id] of ids.entries()) {
      expect((await owner.req('GET', `/chat/attachments/${id}/content`)).body).toBe(bodies[i]);
    }
    const stillLocal = (
      await h.db.pool.query<{ key: string }>(
        `SELECT key FROM blob_objects WHERE kind = 'chat-attachment' AND location = 'local'`,
      )
    ).rows.map((r) => r.key);
    expect(stillLocal).toHaveLength(1);
    // The moved ones are gone from the disk, the bucket holds a verified copy.
    for (const k of keys.filter((x) => !stillLocal.includes(x))) {
      expect(await onDisk(k)).toBe(false);
      expect(s3.objects.has(`prod/${k}`)).toBe(true);
    }

    // The next run: the copy is verified and switched, but deleting the old copy fails → recorded, not lost.
    const spy = vi.spyOn(h.app.blobs, 'deleteObject').mockRejectedValueOnce(new Error('disk busy'));
    const second = await moveBlobs(deps, { to: 's3', dryRun: false, kinds });
    spy.mockRestore();
    expect(second[0]).toMatchObject({ moved: 1, failed: 0, leftoversPending: 1 });
    const left = stillLocal[0] ?? '';
    expect(await blobRow(left)).toMatchObject({ location: 's3', prior_location: 'local' });
    expect(await onDisk(left)).toBe(true);
    expect((await h.app.blobs.read(left)).length).toBeGreaterThan(0);

    // Resume: the leftover old copy is deleted first; nothing else to move.
    const third = await moveBlobs(deps, { to: 's3', dryRun: false, kinds });
    expect(third[0]).toMatchObject({ candidates: 0, moved: 0, leftoversDeleted: 1, leftoversPending: 0 });
    expect(await onDisk(left)).toBe(false);
    expect(await blobRow(left)).toMatchObject({ location: 's3', prior_location: null });
    for (const [i, id] of ids.entries()) {
      expect((await owner.req('GET', `/chat/attachments/${id}/content`)).body).toBe(bodies[i]);
    }

    // With the bucket selected, a new attachment is written straight to it.
    const direct = await owner.req('POST', `/chat/threads/${t}/attachments`, {
      name: 'direct.txt',
      contentBase64: b64('written to the bucket'),
    });
    expect(direct.statusCode, direct.body).toBe(201);
    const directKey = `chat-attachments/${t}/${direct.json<{ id: string }>().id}`;
    expect(s3.objects.get(`prod/${directKey}`)?.data.toString()).toBe('written to the bucket');
    expect(await onDisk(directKey)).toBe(false);
    expect(
      (await owner.req('GET', `/chat/attachments/${direct.json<{ id: string }>().id}/content`)).body,
    ).toBe('written to the bucket');
    keys.push(directKey);

    // And back to the local disk: the bucket copies are deleted after the switch.
    await h.db.pool.query(`UPDATE object_storage_settings SET mode = 'local'`);
    const home = await moveBlobs(deps, { to: 'local', dryRun: false, kinds });
    expect(home[0]).toMatchObject({ moved: total + 1, failed: 0, leftoversPending: 0 });
    for (const k of keys) {
      expect(await onDisk(k)).toBe(true);
      expect(s3.objects.has(`prod/${k}`)).toBe(false);
      expect(await blobRow(k)).toMatchObject({ location: 'local', prior_location: null });
    }
    for (const [i, id] of ids.entries()) {
      expect((await owner.req('GET', `/chat/attachments/${id}/content`)).body).toBe(bodies[i]);
    }
    // Deleting the thread now removes the local blobs through the GC as usual.
    expect((await owner.req('DELETE', `/chat/threads/${t}`)).statusCode).toBe(204);
    await gcLater();
    for (const k of keys) expect(await onDisk(k)).toBe(false);
  });
});
