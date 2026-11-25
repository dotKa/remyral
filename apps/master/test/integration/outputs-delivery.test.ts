import { createHash, randomUUID } from 'node:crypto';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { ChatFlowService } from '../../src/chat/flow.js';
import { ChatStore } from '../../src/chat/store.js';
import { JobStore } from '../../src/jobs/index.js';
import { clearArchiveIndexCache } from '../../src/workspaces/full-archive.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p18-outputs-delivery (docs/design/p18-outputs-delivery.md) against a real master database and blob store:
 * "Tüm dosyaları indir (zip)" holds all 600 files of a job once (499 stored + the 101 of out-rest.zip unpacked in
 * place, not a zip in the zip) with `_summary.md` and a note for removed files; the listing's `q` filter, paging
 * totals and `archive` figures; and a job started from a conversation posts exactly one result card into it for
 * every outcome — failed before it ever ran (no eligible machine), succeeded (with the zipped-delivery line),
 * cancelled, a "Yeniden çalıştır" job — marking the conversation unread, with a notification, once across ticks and
 * replicas, never next to the conversation's own watch.
 */

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'deliv';
const WORKER = 'wrk-test-1';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const csv = (i: number): Buffer => Buffer.from(`${String(i).padStart(4, '0')},value-${String(i)}\n`);
const path = (i: number): string => `data/r${String(i).padStart(4, '0')}.csv`;

/** A zip in the worker's overflow format (sizes in the local headers, deflate, central directory). */
function makeZip(files: readonly { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const body = deflateRawSync(f.data);
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** Entries of a zip (name → bytes); every name must appear once. */
function unzip(buf: Buffer): Map<string, Buffer> {
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
    if (out.has(name)) throw new Error(`duplicate entry ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    at += 46 + nameLen;
  }
  return out;
}

describeIntegration('outputs delivery (integration, p18-outputs-delivery)', { timeout: 300_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let ownerId = '';
  let store: ChatStore;
  let jobs: JobStore;

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0 } });
    ownerId = await h.createUser('owner1', PW);
    owner = await fullLogin(h, 'owner1', PW, (await enroll(h, 'owner1', PW)).secret);
    await h.db.pool.query(`UPDATE users SET locale = 'tr' WHERE id = $1`, [ownerId]);
    await h.db.pool.query(
      `INSERT INTO projects (id, name, kind, created_at) VALUES ($1, $1, 'workspace', now()) ON CONFLICT (id) DO NOTHING`,
      [PROJECT],
    );
    await h.db.pool.query(
      `INSERT INTO project_workspaces (project, egress, updated_at) VALUES ($1, 'none', now())`,
      [PROJECT],
    );
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    clearArchiveIndexCache();
  });
  afterAll(async () => {
    await h.stop();
  });

  async function newJob(title: string): Promise<string> {
    const { job } = await jobs.create({
      project: PROJECT,
      actor: { type: 'user', id: ownerId },
      submit: true,
      spec: {
        runtime: 'codex',
        title,
        prompt: `${title} prompt`,
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 3600 },
      },
    });
    return job.id;
  }

  /** An attempt that ended, with its JOB_RESULT (the output report as the worker sends it). */
  async function attempt(jobId: string, outputs: Record<string, unknown> | null): Promise<string> {
    const id = randomUUID();
    const now = h.clock.now();
    await h.db.pool.query(
      `INSERT INTO job_attempts (id, job_id, number, worker_id, state, outcome, started_at, ended_at)
       VALUES ($1, $2, 1, $3, 'ended', 'succeeded', $4, $4)`,
      [id, jobId, WORKER, now],
    );
    await h.db.pool.query(
      `INSERT INTO job_runs (attempt_id, job_id, worker_id, result_outcome, result, result_received_at, created_at,
                             updated_at)
       VALUES ($1, $2, $3, 'succeeded', $4, $5, $5, $5)`,
      [
        id,
        jobId,
        WORKER,
        JSON.stringify({ summary: 'Data set ready.', ...(outputs === null ? {} : { outputs }) }),
        now,
      ],
    );
    return id;
  }

  async function artifact(
    jobId: string,
    attemptId: string,
    name: string,
    data: Buffer,
    opts: { kind?: string; blob?: boolean; mediaType?: string } = {},
  ): Promise<void> {
    const artifactId = `ws-o${createHash('md5').update(name).digest('hex').slice(0, 16)}`;
    let blobKey: string | null = null;
    if (opts.blob === true) {
      blobKey = await h.app.blobs.write('artifact', `artifacts/${jobId}/${attemptId}/${artifactId}`, data);
    }
    await h.db.pool.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                  redacted, content, blob_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10, $11)`,
      [
        attemptId,
        jobId,
        opts.kind === 'summary' ? 'ws-summary' : artifactId,
        name,
        opts.mediaType ?? (name.endsWith('.md') ? 'text/markdown' : 'text/csv'),
        data.length,
        sha(data),
        opts.kind ?? 'output',
        blobKey === null ? data : null,
        blobKey,
        h.clock.now(),
      ],
    );
  }

  /** Moves a job to a terminal state with its transition (what the orchestrator / worker path records). */
  async function finish(jobId: string, to: 'SUCCEEDED', trigger = 'verification_passed_no_approval') {
    await h.db.pool.query(
      `WITH j AS (UPDATE jobs SET state = $2, state_changed_at = $3, updated_at = $3, version = version + 1
                   WHERE id = $1 RETURNING version, state)
       INSERT INTO job_transitions (job_id, version, from_state, to_state, trigger, actor_type, occurred_at)
       SELECT $1, j.version, 'VERIFYING', $2, $4, 'system', $3 FROM j`,
      [jobId, to, h.clock.now(), trigger],
    );
  }

  async function cardThread(kind: string, result: Record<string, unknown>): Promise<string> {
    const thread = await store.createThread(ownerId, `delivery ${kind}`);
    const at = h.clock.now();
    await h.db.pool.query(
      `INSERT INTO chat_drafts (id, thread_id, user_id, turn_id, kind, title, payload, payload_hash, project, state,
                                result, created_at, expires_at, decided_at)
       VALUES ($1, $2, $3, $4, $5, 'card', '{}', $6, $7, 'confirmed', $8, $9, $9, $9)`,
      [
        randomUUID(),
        thread.id,
        ownerId,
        randomUUID(),
        kind,
        'a'.repeat(64),
        PROJECT,
        JSON.stringify(result),
        at,
      ],
    );
    return thread.id;
  }
  const results = async (threadId: string) =>
    (await store.messages(threadId)).filter((m) => m.meta?.notice === 'job-result');

  // 600 files: 499 stored one by one, 101 in out-rest.zip (the limit 500 counts the zip as one).
  const REPORT = {
    maxFiles: 500,
    returned: 500,
    storage: true,
    zip: { name: 'out-rest.zip', files: 101, bytes: 0 },
    skipped: [],
    skippedCount: 0,
  };
  let bigJob = '';

  describe('Tüm dosyaları indir (zip)', () => {
    it('one archive with all 600 paths once: the stored files, out-rest.zip unpacked in place, _summary.md', async () => {
      bigJob = await newJob('Six hundred files');
      const zip = makeZip(
        Array.from({ length: 101 }, (_, i) => ({ name: path(499 + i), data: csv(499 + i) })),
      );
      const a = await attempt(bigJob, { ...REPORT, zip: { ...REPORT.zip, bytes: zip.length } });
      await artifact(bigJob, a, 'summary.md', Buffer.from('# Summary\n'), { kind: 'summary' });
      for (let i = 0; i < 499; i++) await artifact(bigJob, a, path(i), csv(i));
      await artifact(bigJob, a, 'out-rest.zip', zip, { blob: true, mediaType: 'application/zip' });

      const dl = await owner.req('GET', `/jobs/${bigJob}/artifacts/all.zip`);
      expect(dl.statusCode, dl.body.slice(0, 300)).toBe(200);
      expect(dl.headers['content-type']).toBe('application/zip');
      const entries = unzip(dl.rawPayload);
      expect(entries.size).toBe(601);
      expect(entries.has('out-rest.zip')).toBe(false);
      expect(entries.get('_summary.md')?.toString()).toBe('# Summary\n');
      for (let i = 0; i < 600; i++) expect(entries.get(path(i))?.equals(csv(i)), path(i)).toBe(true);

      // out-rest.zip stays downloadable on its own.
      const list = (await owner.req('GET', `/jobs/${bigJob}/artifacts?limit=1000`)).json<{
        artifacts: { id: string; name: string }[];
        total: number;
        archive: { files: number; bytes: number; unpacked: { name: string; files: number } | null };
      }>();
      const zipRow = list.artifacts.find((x) => x.name === 'out-rest.zip');
      const own = await owner.req('GET', `/jobs/${bigJob}/artifacts/${zipRow?.id ?? ''}`);
      expect(own.statusCode).toBe(200);
      expect(own.rawPayload.equals(zip)).toBe(true);
      // The figures of the button: 600 files and their bytes (the summary's too).
      const bytes = Array.from({ length: 600 }, (_, i) => csv(i).length).reduce((x, y) => x + y, 0) + 10;
      expect(list.total).toBe(501);
      expect(list.archive).toEqual({
        files: 600,
        bytes,
        unpacked: { name: 'out-rest.zip', files: 101 },
        removed: 0,
      });
    });

    it('the file-name filter and the paging totals', async () => {
      type Page = { artifacts: { name: string }[]; total: number };
      const p1 = (await owner.req('GET', `/jobs/${bigJob}/artifacts?q=r00&limit=50`)).json<Page>();
      expect(p1.total).toBe(100); // r0000 … r0099
      expect(p1.artifacts).toHaveLength(50);
      expect(p1.artifacts[0]?.name).toBe('data/r0000.csv');
      const p2 = (await owner.req('GET', `/jobs/${bigJob}/artifacts?q=r00&limit=50&offset=50`)).json<Page>();
      expect(p2.artifacts.map((x) => x.name).at(-1)).toBe('data/r0099.csv');
      expect((await owner.req('GET', `/jobs/${bigJob}/artifacts?q=OUT-REST`)).json<Page>().total).toBe(1);
      // `%` and `_` are taken literally.
      expect((await owner.req('GET', `/jobs/${bigJob}/artifacts?q=%25`)).json<Page>().total).toBe(0);
      expect((await owner.req('GET', `/jobs/${bigJob}/artifacts?q=r_0`)).json<Page>().total).toBe(0);
      const all = (await owner.req('GET', `/jobs/${bigJob}/artifacts?limit=100&offset=500`)).json<Page>();
      expect(all.total).toBe(501);
      expect(all.artifacts).toHaveLength(1);
      expect((await owner.req('GET', `/jobs/${bigJob}/artifacts?q=${'x'.repeat(201)}`)).statusCode).toBe(400);
    });

    it('a removed file is left out and named in _removed-files.txt', async () => {
      await h.db.pool.query(
        `UPDATE job_artifacts SET pruned_at = now(), pruned_reason = 'retention', content = NULL
          WHERE job_id = $1 AND name = $2`,
        [bigJob, path(3)],
      );
      const entries = unzip((await owner.req('GET', `/jobs/${bigJob}/artifacts/all.zip`)).rawPayload);
      expect(entries.size).toBe(601);
      expect(entries.has(path(3))).toBe(false);
      expect(entries.get('_removed-files.txt')?.toString()).toContain(`${path(3)}\tretention`);
      const list = (await owner.req('GET', `/jobs/${bigJob}/artifacts?limit=1`)).json<{
        archive: { files: number; removed: number };
      }>();
      expect(list.archive).toMatchObject({ files: 599, removed: 1 });
    });
  });

  describe('a conversation hears how its jobs end', () => {
    it('a job failing at placement posts exactly one failure card, marks the conversation unread and notifies', async () => {
      const jobId = await newJob('Needs a GPU');
      const thread = await cardThread('job', { jobId, project: PROJECT, state: 'QUEUED' });
      const other = await store.createThread(ownerId, 'newer conversation');
      await store.addMessage(other.id, { role: 'user', content: 'hello' });
      expect(await h.app.chatFlow.tick()).toBe(0);
      await jobs.transition(jobId, 'infeasible', {
        actor: { type: 'system', id: 'scheduler' },
        reason: 'no eligible worker: needs gpu',
      });
      h.clock.advance(10_000);
      // Two replicas at once, then once more: one card.
      const replica = new ChatFlowService({
        pool: h.db.pool,
        store,
        clock: h.clock.now,
        log: h.app.log,
        audit: new AuditLog(h.db.pool, h.clock.now),
        notifications: () => null,
        publish: () => undefined,
      });
      await Promise.all([h.app.chatFlow.tick(), replica.tick()]);
      await h.app.chatFlow.tick();
      const cards = await results(thread);
      expect(cards).toHaveLength(1);
      expect(cards[0]?.meta).toMatchObject({
        jobId,
        jobOutcome: 'failed',
        jobState: 'FAILED',
        link: `/jobs/${jobId}`,
      });
      expect(cards[0]?.content).toBe(
        '**İş başlatılamadı:** Needs a GPU — bu işi çalıştırabilecek uygun bir makine yok.',
      );
      // Unread and on top of the list.
      const listed = await store.listThreads(ownerId);
      expect(listed[0]?.id).toBe(thread);
      expect(listed[0]?.unreadCount).toBeGreaterThan(0);
      const notes = await h.db.pool.query<{ title: string; link: string; severity: string }>(
        `SELECT title, link, severity FROM notifications WHERE recipient_id = $1 AND kind = 'chat.watch'
            AND dedupe_key LIKE $2`,
        [ownerId, `chat.flow.job:${jobId}:%`],
      );
      expect(notes.rows).toEqual([
        { title: 'İş başlatılamadı: Needs a GPU', link: `/chat/${thread}`, severity: 'warning' },
      ]);
    });

    it('success (with the zipped-delivery line), cancel and a "Yeniden çalıştır" job; a watched job gets no second card', async () => {
      const ok = await cardThread('job', { jobId: bigJob });
      await finish(bigJob, 'SUCCEEDED');

      const cancelled = await newJob('Stop me');
      const cancelThread = await cardThread('machine_task', { workerId: WORKER, jobId: cancelled });
      await jobs.transition(cancelled, 'cancel_requested', {
        actor: { type: 'user', id: ownerId },
        reason: 'not needed',
      });

      const rerun = await newJob('Run it again');
      const rerunThread = await cardThread('job_action', {
        action: 'run_again',
        results: [{ jobId: cancelled, outcome: 'done', newJobId: rerun }],
        jobId: rerun,
      });
      await jobs.transition(rerun, 'cancel_requested', { actor: { type: 'user', id: ownerId }, reason: 'x' });

      // A conversation whose own watch tells it.
      const watched = await newJob('Watched one');
      const watchedThread = await cardThread('job', { jobId: watched });
      await h.db.pool.query(
        `INSERT INTO chat_watches (id, user_id, thread_id, target_kind, target_uuid, project, label, conditions,
                                   repeat, language, state, cursor, created_at, updated_at, expires_at)
         VALUES ($1, $2, $3, 'job', $4, $5, 'watched', '{finished}', 'once', 'tr', 'active', '{}', $6, $6, $7)`,
        [
          randomUUID(),
          ownerId,
          watchedThread,
          watched,
          PROJECT,
          h.clock.now(),
          new Date(h.clock.now().getTime() + 3600_000),
        ],
      );
      await jobs.transition(watched, 'cancel_requested', {
        actor: { type: 'user', id: ownerId },
        reason: 'x',
      });

      h.clock.advance(10_000);
      await h.app.chatFlow.tick();
      await h.app.chatFlow.tick();

      const s = await results(ok);
      expect(s).toHaveLength(1);
      expect(s[0]?.meta).toMatchObject({
        jobOutcome: 'succeeded',
        jobSummary: 'Data set ready.',
        jobZipped: { name: 'out-rest.zip', files: 101 },
      });
      expect(s[0]?.content).toBe(
        // Markdown-escaped (the console renders the parentheses).
        '**İş bitti:** Six hundred files.\n\n600 dosya üretildi: 499’u tek tek, 101’i out-rest.zip içinde \\(iş başına 500 dosya sınırı\\).',
      );
      const c = await results(cancelThread);
      expect(c).toHaveLength(1);
      expect(c[0]?.content).toBe('**İş iptal edildi:** Stop me — başlamadan iptal edildi.');
      // The run-again card's conversation hears about the new job (not about the job it re-ran).
      const r = await results(rerunThread);
      expect(r.map((m) => m.meta?.jobId)).toEqual([rerun]);
      expect(await results(watchedThread)).toHaveLength(0);
    });

    it('the agent’s first answer to a message sent from the conversation comes back as one note', async () => {
      const job = await newJob('Answer me');
      const messageId = randomUUID();
      const sentAt = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO job_messages (id, job_id, source, sent_by, text, status, created_at, updated_at)
         VALUES ($1, $2, 'chat', $3, 'Hangi dosyaları değiştirdin?', 'read', $4, $4)`,
        [messageId, job, ownerId, sentAt],
      );
      const thread = await cardThread('job_message', { jobId: job, messageId, delivery: 'read' });
      const event = async (seq: number, role: string, text: string): Promise<void> => {
        await h.db.pool.query(
          `INSERT INTO job_events (job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq, message_id, stream_seq,
                                   kind, payload, ts, received_at, size_bytes)
           VALUES ($1, $2, 1, 1, 'worker-1', $3, $4, $3, 'message', $5, $6, $6, 10)`,
          [
            job,
            randomUUID(),
            seq,
            randomUUID(),
            JSON.stringify({ kind: 'message', role, text }),
            new Date(sentAt.getTime() + seq * 1000),
          ],
        );
      };
      const replies = async () =>
        (await store.messages(thread)).filter((m) => m.meta?.notice === 'job-reply');

      // Nothing yet: the agent has not taken the message.
      await event(1, 'assistant', 'Working on the earlier step.');
      h.clock.advance(10_000);
      await h.app.chatFlow.tick();
      expect(await replies()).toHaveLength(0);

      await event(2, 'user', 'Hangi dosyaları değiştirdin?');
      await event(3, 'assistant', 'src/a.ts ve src/b.ts dosyalarını değiştirdim.');
      await event(4, 'assistant', 'Ayrıca testleri güncelledim.');
      h.clock.advance(10_000);
      await h.app.chatFlow.tick();
      await h.app.chatFlow.tick();
      const r = await replies();
      expect(r).toHaveLength(1);
      expect(r[0]?.meta).toMatchObject({ jobId: job, link: `/jobs/${job}` });
      expect(r[0]?.content).toContain('src/a.ts ve src/b.ts');
      expect(r[0]?.content).not.toContain('earlier step');
    });

    it('a job started here that waits for its merge approval says so here, once (p19-job-waits)', async () => {
      const job = await newJob('Reskin the slots');
      const thread = await cardThread('job', { jobId: job });
      const other = await newJob('Run now job');
      const runNow = await cardThread('automation_change', {
        automationId: randomUUID(),
        runId: randomUUID(),
        runState: 'running',
        jobId: other,
      });
      const at = h.clock.now();
      const pending = async (jobId: string, action: string): Promise<string> => {
        const { rows } = await h.db.pool.query<{ id: string }>(
          `INSERT INTO approval_requests (job_id, epoch, approval_key, kind, action, requested_action, risk, summary,
                                          requested_by_type, policy_version, approver_role, required_approvals,
                                          step_up, status, created_at, expires_at, details)
           VALUES ($1, 0, $2, 'gate', $3, 'merge', 'high', 'Merge it', 'system', 0, 'operator', 1, false, 'pending',
                   $4, $5, '{"tool":"Bash","description":"Run the deploy script","command":"sh deploy.sh"}')
           RETURNING id::text AS id`,
          [jobId, `gate:jw-${randomUUID().slice(0, 8)}`, action, at, new Date(at.getTime() + 24 * 3_600_000)],
        );
        return rows[0]?.id ?? '';
      };
      const merge = await pending(job, 'git.merge');
      const gated = await pending(other, 'runtime.dangerous_tool');
      const waits = async (threadId: string) =>
        (await store.messages(threadId)).filter((m) => m.meta?.notice === 'job-approval');

      h.clock.advance(10_000);
      await h.app.chatFlow.tick();
      await h.app.chatFlow.tick();

      const w = await waits(thread);
      expect(w).toHaveLength(1);
      expect(w[0]?.meta).toMatchObject({ jobId: job, approvalId: merge, link: `/approvals/${merge}` });
      expect(w[0]?.content).toContain('birleştirme onayını bekliyor');
      expect(w[0]?.content).toContain('Reskin the slots');
      const g = await waits(runNow);
      expect(g).toHaveLength(1);
      expect(g[0]?.meta).toMatchObject({ jobId: other, approvalId: gated });
      expect(g[0]?.content).toContain('Run the deploy script');
      const { rows: notes } = await h.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifications WHERE dedupe_key = $1`,
        [`chat.flow.jobwait:${merge}:${thread}`],
      );
      expect(notes[0]?.n).toBe(1);

      // The approval is granted and the job ends: its result card follows, the wait note is not repeated.
      await h.db.pool.query(
        `UPDATE approval_requests SET status = 'approved', decided_at = $2, decided_by = $3 WHERE id = $1`,
        [merge, h.clock.now(), ownerId],
      );
      await finish(job, 'SUCCEEDED', 'approval_granted');
      h.clock.advance(10_000);
      await h.app.chatFlow.tick();
      await h.app.chatFlow.tick();
      expect(await waits(thread)).toHaveLength(1);
      expect((await results(thread)).map((m) => m.meta?.jobId)).toEqual([job]);
    });

    it('every job of a confirmed job batch card ends with its own result card in that conversation', async () => {
      const first = await newJob('Batch one');
      const second = await newJob('Batch two');
      const batchThread = await cardThread('job_batch', {
        batchId: randomUUID(),
        created: [
          { project: PROJECT, jobId: first },
          { project: PROJECT, jobId: second },
        ],
        refused: [],
      });
      await finish(first, 'SUCCEEDED');
      await jobs.transition(second, 'cancel_requested', {
        actor: { type: 'user', id: ownerId },
        reason: 'x',
      });

      h.clock.advance(10_000);
      await h.app.chatFlow.tick();
      await h.app.chatFlow.tick();

      const b = await results(batchThread);
      expect(b.map((m) => m.meta?.jobId).sort()).toEqual([first, second].sort());
      expect(b.find((m) => m.meta?.jobId === first)?.meta?.jobOutcome).toBe('succeeded');
      expect(b.find((m) => m.meta?.jobId === second)?.meta?.jobOutcome).toBe('cancelled');
    });
  });
});
