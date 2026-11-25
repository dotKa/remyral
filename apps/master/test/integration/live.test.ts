import { randomUUID } from 'node:crypto';
import { longRunningScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/pool.js';
import type { SequencedWorkerMessage } from '../../src/workers/replay.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, jobSpec, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
/** A token that "slipped past" the worker's exact-value redaction (not registered there). */
const CANARY = `ghp_${'Zq9Lk2Wm7Xr4'.repeat(3)}`;

interface Frame {
  id: number | null;
  event: string;
  data: Record<string, unknown>;
}

/** Minimal SSE reader over fetch (the browser's EventSource is not available in Node). */
class SseReader {
  readonly frames: Frame[] = [];
  readonly raw: string[] = [];
  #buf = '';
  #done = false;
  #waiters: (() => void)[] = [];
  readonly ctrl = new AbortController();
  status = 0;
  headers = new Headers();

  static async open(base: string, path: string, client: Client, extra: Record<string, string> = {}) {
    const r = new SseReader();
    const res = await fetch(`${base}${path}`, {
      headers: {
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        accept: 'text/event-stream',
        ...extra,
      },
      signal: r.ctrl.signal,
    });
    r.status = res.status;
    r.headers = res.headers;
    if (res.status !== 200 || res.body === null) {
      r.raw.push(await res.text());
      r.#done = true;
      return r;
    }
    void r.#read(res.body);
    return r;
  }

  async #read(body: ReadableStream<Uint8Array>): Promise<void> {
    const dec = new TextDecoder();
    try {
      for await (const chunk of body) {
        this.#buf += dec.decode(chunk, { stream: true });
        for (;;) {
          const i = this.#buf.indexOf('\n\n');
          if (i < 0) break;
          const block = this.#buf.slice(0, i);
          this.#buf = this.#buf.slice(i + 2);
          this.raw.push(block);
          let id: number | null = null;
          let event = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) id = Number(line.slice(4));
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (data.length > 0) {
            this.frames.push({ id, event, data: JSON.parse(data.join('\n')) as Record<string, unknown> });
          }
        }
        this.#notify();
      }
    } catch {
      // aborted
    } finally {
      this.#done = true;
      this.#notify();
    }
  }

  #notify(): void {
    for (const w of this.#waiters.splice(0)) w();
  }

  get done(): boolean {
    return this.#done;
  }

  async until(pred: (frames: Frame[]) => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred(this.frames)) {
      if (this.#done)
        throw new Error(`stream ended; frames: ${JSON.stringify(this.frames.map((f) => f.event))}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; frames: ${JSON.stringify(this.frames.slice(-5))}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 500));
        this.#waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async ended(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#done) {
      if (Date.now() > deadline) throw new Error('stream did not end');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  close(): void {
    this.ctrl.abort();
  }

  logs(): Frame[] {
    return this.frames.filter((f) => f.event === 'log');
  }
}

function logMsg(
  jobId: string,
  attemptId: string,
  seq: number,
  stream: 'stdout' | 'stderr' | 'runtime',
  chunkSeq: number,
  data: string,
  messageId: string = randomUUID(),
): SequencedWorkerMessage {
  return {
    protocolVersion: '1.0',
    type: 'LOG_CHUNK',
    messageId,
    seq,
    ts: new Date().toISOString(),
    correlationId: 'live-test',
    workerId: 'w-live',
    jobId,
    payload: { attemptId, epoch: 1, stream, chunkSeq, data, redacted: true },
  } as unknown as SequencedWorkerMessage;
}

function eventMsg(
  jobId: string,
  attemptId: string,
  seq: number,
  event: Record<string, unknown>,
  messageId: string = randomUUID(),
): SequencedWorkerMessage {
  return {
    protocolVersion: '1.0',
    type: 'EVENT',
    messageId,
    seq,
    ts: new Date().toISOString(),
    correlationId: 'live-test',
    workerId: 'w-live',
    jobId,
    payload: { attemptId, epoch: 1, event },
  } as unknown as SequencedWorkerMessage;
}

describeIntegration('p5-live: persistence, SSE stream, search (integration)', { timeout: 90_000 }, () => {
  let h: Harness;
  let base: string;
  let admin: Client;
  let secret: string;
  let fileUrl: string;
  const dirs: string[] = [];
  const workers: JobWorker[] = [];
  const open: SseReader[] = [];

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        tickIntervalMs: 50,
        timing: { leaseTtlMs: 30_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
      },
      live: {
        stream: { maxPerUser: 3, maxLag: 40, pageSize: 7, heartbeatMs: 150, pollMs: 300, maxAgeMs: 60_000 },
      },
    });
    base = (await h.listen()).replace('ws://', 'http://');
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    fileUrl = await createBareRepo(dirs);
  });
  afterEach(async () => {
    for (const s of open.splice(0)) s.close();
    await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
  });
  afterAll(async () => {
    await h.stop();
    await removeDirs(dirs);
  });

  async function stream(
    path: string,
    extra: Record<string, string> = {},
    client = admin,
  ): Promise<SseReader> {
    const s = await SseReader.open(base, path, client, extra);
    open.push(s);
    return s;
  }

  async function submit(spec: Record<string, unknown> = jobSpec()): Promise<string> {
    const res = await admin.req('POST', '/jobs', { project: PROJECT, spec });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ job: { id: string } }>().job.id;
  }

  /** A job (stays QUEUED: no worker) with two attempt rows, for driving the store directly. */
  async function seededJob(): Promise<{ jobId: string; a1: string; a2: string }> {
    const jobId = await submit();
    const a1 = randomUUID();
    const a2 = randomUUID();
    for (const [id, n] of [
      [a1, 1],
      [a2, 2],
    ] as const) {
      await h.db.pool.query(
        n === 1
          ? `INSERT INTO job_attempts (id, job_id, number, worker_id, state, outcome, started_at, ended_at)
             VALUES ($1, $2, $3, 'w-live', 'ended', 'retry', now(), now())`
          : `INSERT INTO job_attempts (id, job_id, number, worker_id, state, started_at)
             VALUES ($1, $2, $3, 'w-live', 'active', now())`,
        [id, jobId, n],
      );
    }
    return { jobId, a1, a2 };
  }

  async function record(messages: SequencedWorkerMessage[]): Promise<boolean[]> {
    const out: boolean[] = [];
    for (const m of messages) {
      out.push(
        await withTransaction(h.db.pool, (tx) => h.app.live.store.recordWithin(tx, 'w-live', m, new Date())),
      );
    }
    return out;
  }

  async function logsApi(
    jobId: string,
    query = '',
  ): Promise<{
    items: { text: string; seq: number; attemptNo: number; chunkSeq: number; stream: string }[];
    nextCursor: string | null;
  }> {
    const res = await admin.req('GET', `/jobs/${jobId}/logs${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  async function newWorker(): Promise<{ id: string; w: JobWorker }> {
    const dir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, base.replace('http://', 'ws://'), admin, secret, dir);
    const w = await startJobWorker(base.replace('http://', 'ws://'), dir, {
      fileUrl,
      fake: { script: longRunningScript },
    });
    workers.push(w);
    await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
    return { id, w };
  }

  async function jobState(id: string): Promise<{ state: string; currentAttemptId: string | null }> {
    const res = await admin.req('GET', `/jobs/${id}`);
    return res.json<{ job: { state: string; currentAttemptId: string | null } }>().job;
  }

  describe('store', () => {
    it('orders by (attempt, worker seq, chunk seq) whatever the arrival order; dedupes replays', async () => {
      const { jobId, a1, a2 } = await seededJob();
      const dupId = randomUUID();
      const stored = await record([
        // Attempt 2 arrives first, then the late tail of attempt 1, then attempt 1's start.
        logMsg(jobId, a2, 10, 'stdout', 0, 'a2-first\n'),
        logMsg(jobId, a1, 7, 'stdout', 3, 'a1-tail\n', dupId),
        logMsg(jobId, a1, 5, 'stdout', 1, 'a1-second\n'),
        logMsg(jobId, a1, 4, 'stderr', 0, 'a1-err\n'),
        logMsg(jobId, a1, 3, 'stdout', 0, 'a1-first\n'),
        // Replays: the same message again, and the same chunk under a new message id.
        logMsg(jobId, a1, 7, 'stdout', 3, 'a1-tail\n', dupId),
        logMsg(jobId, a1, 99, 'stdout', 1, 'a1-second (resent)\n'),
      ]);
      expect(stored).toEqual([true, true, true, true, true, false, false]);
      const page = await logsApi(jobId);
      expect(page.items.map((i) => i.text)).toEqual([
        'a1-first\n',
        'a1-err\n',
        'a1-second\n',
        'a1-tail\n',
        'a2-first\n',
      ]);
      // Arrival order is the stream sequence (what the live tail appends), gap-free.
      expect(page.items.map((i) => i.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
      const counted = await h.db.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM job_log_chunks WHERE job_id = $1',
        [jobId],
      );
      expect(counted.rows[0]?.n).toBe('5');
      // Keyset pages and tail.
      const p1 = await logsApi(jobId, '?limit=2');
      expect(p1.items.map((i) => i.text)).toEqual(['a1-first\n', 'a1-err\n']);
      const p2 = await logsApi(jobId, `?limit=2&cursor=${p1.nextCursor ?? ''}`);
      expect(p2.items.map((i) => i.text)).toEqual(['a1-second\n', 'a1-tail\n']);
      expect((await logsApi(jobId, '?tail=1&limit=2')).items.map((i) => i.text)).toEqual([
        'a1-tail\n',
        'a2-first\n',
      ]);
      expect((await logsApi(jobId, '?stream=stderr')).items.map((i) => i.text)).toEqual(['a1-err\n']);
      expect((await logsApi(jobId, '?attempt=2')).items.map((i) => i.text)).toEqual(['a2-first\n']);
      expect((await admin.req('GET', `/jobs/${jobId}/logs?cursor=bogus`)).statusCode).toBe(400);
      expect((await admin.req('GET', `/jobs/${jobId}/logs?limit=501`)).statusCode).toBe(400);
    });

    it('redacts a canary secret that slipped past the worker — whole, split across chunks, in events', async () => {
      const { jobId, a1 } = await seededJob();
      await record([
        logMsg(jobId, a1, 1, 'stdout', 0, `export GH=${CANARY}\n`),
        logMsg(jobId, a1, 2, 'stderr', 0, `pushing with token ${CANARY.slice(0, 15)}`),
        logMsg(jobId, a1, 3, 'stderr', 1, `${CANARY.slice(15)} ok\n`),
        eventMsg(jobId, a1, 4, {
          kind: 'tool_call',
          callId: 'c1',
          toolName: 'bash',
          inputSummary: `git push https://x:${CANARY}@github.com/a/b`,
        }),
      ]);
      const dump = await h.db.pool.query<{ t: string }>(
        `SELECT coalesce(string_agg(text, ''), '') || (SELECT coalesce(string_agg(payload::text, ''), '')
           FROM job_events WHERE job_id = $1) AS t FROM job_log_chunks WHERE job_id = $1`,
        [jobId],
      );
      const all = dump.rows[0]?.t ?? '';
      expect(all).not.toContain(CANARY);
      expect(all).not.toContain(CANARY.slice(15));
      expect(all).toContain('[REDACTED:github-token]');
      const found = await logsApi(jobId, '?q=REDACTED%20pushing');
      expect(found.items).toHaveLength(1);
      expect(found.items[0]?.text).toBe('pushing with token [REDACTED:github-token]');
      // Search terms never match the secret (it is not stored).
      expect((await logsApi(jobId, `?q=${CANARY.slice(4, 14)}`)).items).toEqual([]);
      // LIKE wildcards are literal.
      expect((await logsApi(jobId, '?q=%25')).items).toEqual([]);
      const ev = await admin.req('GET', `/jobs/${jobId}/events`);
      expect(ev.body).not.toContain(CANARY);
      expect(ev.json<{ items: { kind: string }[] }>().items.map((i) => i.kind)).toEqual(['tool_call']);
    });

    it('enforces the per-job log budget with one notice, and purges ended jobs (retention hook)', async () => {
      const { jobId, a1 } = await seededJob();
      const store = h.app.live.store;
      const limits = store.limits as { maxLogBytesPerJob: number };
      const saved = limits.maxLogBytesPerJob;
      limits.maxLogBytesPerJob = 20;
      try {
        expect(
          await record([
            logMsg(jobId, a1, 1, 'stdout', 0, '0123456789\n'),
            logMsg(jobId, a1, 2, 'stdout', 1, '0123456789\n'),
            logMsg(jobId, a1, 3, 'stdout', 2, '0123456789\n'),
          ]),
        ).toEqual([true, true, false]);
      } finally {
        limits.maxLogBytesPerJob = saved;
      }
      const ev = await admin.req('GET', `/jobs/${jobId}/events?kind=notice`);
      expect(ev.json<{ items: { payload: { code: string } }[] }>().items.map((i) => i.payload.code)).toEqual([
        'log_limit_reached',
      ]);
      const summary = await admin.req('GET', `/jobs/${jobId}/live`);
      expect(summary.json()).toMatchObject({ logChunks: 1, logLimited: true, head: 2 });

      expect((await admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'done' })).statusCode).toBe(200);
      // Not yet 30 days: nothing purged.
      // The harness clock (not the wall clock): the job ended at its instant, which is fixed in the past.
      expect(await store.purge(h.clock.now(), { retentionDays: 30 })).toBe(0);
      const later = new Date(h.clock.now().getTime() + 40 * 86_400_000);
      expect(await store.purge(later, { retentionDays: 30 })).toBeGreaterThanOrEqual(2);
      expect((await logsApi(jobId)).items).toEqual([]);
      expect(await store.purge(later, { retentionDays: 30 })).toBe(0);
      // Stream sequences are never reused after a purge.
      expect(await store.head(jobId)).toBe(2);
      // p14-web-perf-2: the kept chunk count is reset with the purge.
      expect((await admin.req('GET', `/jobs/${jobId}/live`)).json()).toMatchObject({ logChunks: 0 });
    });

    it('p14-web-perf-2: the chunk count is kept on the head (no count per call); a pre-0116 head is counted once', async () => {
      const { jobId, a1 } = await seededJob();
      const live = async () => (await admin.req('GET', `/jobs/${jobId}/live`)).json<{ logChunks: number }>();
      expect(
        await record([logMsg(jobId, a1, 1, 'stdout', 0, 'a\n'), logMsg(jobId, a1, 2, 'stderr', 0, 'b\n')]),
      ).toEqual([true, true]);
      // A duplicate delivery is not counted.
      expect(await record([logMsg(jobId, a1, 1, 'stdout', 0, 'a\n')])).toEqual([false]);
      const kept = await h.db.pool.query<{ n: string }>(
        'SELECT log_chunk_count::text AS n FROM job_live_heads WHERE job_id = $1',
        [jobId],
      );
      expect(kept.rows[0]?.n).toBe('2');
      expect((await live()).logChunks).toBe(2);
      // A head from before migration 0116 (NULL): counted once, then stored and kept up to date.
      await h.db.pool.query('UPDATE job_live_heads SET log_chunk_count = NULL WHERE job_id = $1', [jobId]);
      expect((await live()).logChunks).toBe(2);
      expect(await record([logMsg(jobId, a1, 3, 'stdout', 1, 'c\n')])).toEqual([true]);
      expect((await live()).logChunks).toBe(3);
      const after = await h.db.pool.query<{ n: string }>(
        'SELECT log_chunk_count::text AS n FROM job_live_heads WHERE job_id = $1',
        [jobId],
      );
      expect(after.rows[0]?.n).toBe('3');
    });
  });

  describe('stream', () => {
    it('backfills from ?after=, tails live, resumes with Last-Event-ID, heartbeats', async () => {
      const { jobId, a1 } = await seededJob();
      await record([
        logMsg(jobId, a1, 1, 'stdout', 0, 'one\n'),
        logMsg(jobId, a1, 2, 'stdout', 1, '<script>alert(1)</script>\u001b]52;c;ZXZpbA==\u0007\n'),
        eventMsg(jobId, a1, 3, { kind: 'message', role: 'assistant', text: 'hello' }),
      ]);
      const s = await stream(`/jobs/${jobId}/stream?after=0`);
      expect(s.status).toBe(200);
      expect(s.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(s.headers.get('cache-control')).toBe('no-store');
      expect(s.headers.get('content-security-policy')).toContain("default-src 'self'");
      await s.until((f) => f.filter((x) => x.id !== null).length === 3);
      expect(s.frames[0]).toMatchObject({ event: 'ready', data: { head: 3, cursor: 0 } });
      expect(s.frames.filter((f) => f.id !== null).map((f) => [f.id, f.event])).toEqual([
        [1, 'log'],
        [2, 'log'],
        [3, 'event'],
      ]);
      // Hostile text arrives as JSON data (the console renders it as text).
      expect(s.logs()[1]?.data.text).toContain('<script>');
      // Live tail: a new row is pushed without reconnecting.
      await record([logMsg(jobId, a1, 4, 'stdout', 2, 'live!\n')]);
      await s.until((f) => f.some((x) => x.id === 4));
      await s.until(() => s.raw.some((b) => b.startsWith(': hb')));
      s.close();

      // Resume after id 2 with the header EventSource sends on reconnect.
      await record([logMsg(jobId, a1, 5, 'stdout', 3, 'while away\n')]);
      const r = await stream(`/jobs/${jobId}/stream`, { 'last-event-id': '2' });
      await r.until((f) => f.some((x) => x.id === 5));
      expect(r.frames.filter((f) => f.id !== null).map((f) => f.id)).toEqual([3, 4, 5]);
      r.close();

      // No cursor: starts at the head (history comes from REST).
      const t = await stream(`/jobs/${jobId}/stream`);
      await t.until((f) => f.some((x) => x.event === 'ready'));
      await record([logMsg(jobId, a1, 6, 'stdout', 4, 'new\n')]);
      await t.until((f) => f.some((x) => x.id === 6));
      expect(t.frames.filter((f) => f.id !== null).map((f) => f.id)).toEqual([6]);
    });

    it('sends `behind` and closes when the client is too far behind', async () => {
      const { jobId, a1 } = await seededJob();
      await record(
        Array.from({ length: 45 }, (_, i) => logMsg(jobId, a1, i + 1, 'stdout', i, `line ${String(i)}\n`)),
      );
      const s = await stream(`/jobs/${jobId}/stream?after=0`);
      await s.ended();
      expect(s.frames.at(-1)).toMatchObject({ event: 'behind', data: { head: 45 } });
      expect(s.logs()).toEqual([]);
      // Within the lag window the backfill is paged (page size 7) and complete.
      const ok = await stream(`/jobs/${jobId}/stream?after=10`);
      await ok.until((f) => f.filter((x) => x.event === 'log').length === 35);
      expect(ok.logs().map((f) => f.id)).toEqual(Array.from({ length: 35 }, (_, i) => i + 11));
    });

    it('limits concurrent streams per user (429 before any data)', async () => {
      const { jobId } = await seededJob();
      const a = await stream(`/jobs/${jobId}/stream`);
      const b = await stream(`/jobs/${jobId}/stream`);
      const c = await stream(`/jobs/${jobId}/stream`);
      for (const s of [a, b, c]) await s.until((f) => f.some((x) => x.event === 'ready'));
      const d = await stream(`/jobs/${jobId}/stream`);
      expect(d.status).toBe(429);
      expect(JSON.parse(d.raw[0] ?? '{}')).toMatchObject({ error: 'too_many_streams' });
      a.close();
      await expect.poll(() => h.app.live.streams.stats().total, { timeout: 5_000 }).toBe(2);
      const e = await stream(`/jobs/${jobId}/stream`);
      expect(e.status).toBe(200);
    });

    it('authorization: no session → 401, other project → 404, member viewer → 200', async () => {
      const { jobId } = await seededJob();
      const anon = h.client();
      expect((await stream(`/jobs/${jobId}/stream`, {}, anon)).status).toBe(401);
      await h.createUser('viewer-beta', PW, 'viewer');
      const vb = await enroll(h, 'viewer-beta', PW);
      const viewerId = (
        await h.db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'viewer-beta'")
      ).rows[0]?.id;
      await h.grant(viewerId ?? '', ['beta'], 'viewer');
      const viewer = await fullLogin(h, 'viewer-beta', PW, vb.secret);
      for (const path of ['stream', 'logs', 'events', 'live', 'diff']) {
        const res =
          path === 'stream'
            ? (await stream(`/jobs/${jobId}/${path}`, {}, viewer)).status
            : (await viewer.req('GET', `/jobs/${jobId}/${path}`)).statusCode;
        expect([path, res]).toEqual([path, 404]);
      }
      await h.grant(viewerId ?? '', [PROJECT], 'viewer');
      expect((await stream(`/jobs/${jobId}/stream`, {}, viewer)).status).toBe(200);
      expect((await viewer.req('GET', `/jobs/${jobId}/logs`)).statusCode).toBe(200);
      // No verified git flow record → no diff.
      expect((await viewer.req('GET', `/jobs/${jobId}/diff`)).json()).toMatchObject({
        error: 'diff_unavailable',
      });
    });
  });

  it('end to end: real worker output is stored, streamed, fenced and redacted; cancel ends in the stream', async () => {
    const { w } = await newWorker();
    const jobId = await submit();
    await expect.poll(async () => (await jobState(jobId)).state, { timeout: 20_000 }).toBe('RUNNING');
    const attemptId = (await jobState(jobId)).currentAttemptId ?? '';
    const s = await stream(`/jobs/${jobId}/stream?after=0`);
    await s.until((f) =>
      f.some((x) => x.event === 'event' && (x.data.payload as { kind: string }).kind === 'tool_call'),
    );
    const send = (payload: Record<string, unknown>) =>
      w.daemon.sendSequenced({
        type: 'LOG_CHUNK',
        correlationId: 'live-e2e',
        jobId: jobId as never,
        payload: { attemptId, epoch: 1, redacted: true, ...payload } as never,
      });
    await send({ stream: 'stderr', chunkSeq: 9000, data: `token ${CANARY.slice(0, 20)}` });
    await send({ stream: 'stderr', chunkSeq: 9001, data: `${CANARY.slice(20)} end\n` });
    // Same chunk again under a new message id: dropped.
    await send({ stream: 'stderr', chunkSeq: 9001, data: 'duplicate\n' });
    // Stale epoch: journaled as stale by the inbox, never stored for the live view.
    await send({ stream: 'stderr', chunkSeq: 9002, data: 'zombie output\n', epoch: 0 });
    await s.until((f) => f.filter((x) => x.event === 'log' && x.data.stream === 'stderr').length >= 2);
    await expect
      .poll(
        async () =>
          (
            await h.db.pool.query<{ outcome: string }>(
              `SELECT outcome FROM worker_inbox WHERE job_id = $1 AND type = 'LOG_CHUNK' ORDER BY id DESC LIMIT 1`,
              [jobId],
            )
          ).rows[0]?.outcome,
      )
      .toBe('stale');
    const texts = (await logsApi(jobId, '?stream=stderr')).items.map((i) => i.text);
    expect(texts).toEqual(['token [REDACTED:github-token]', ' end\n']);
    expect(s.raw.join('\n')).not.toContain(CANARY.slice(20));
    expect(JSON.stringify(await logsApi(jobId))).not.toContain('zombie');

    const cancel = await admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'stop from phone' });
    expect(cancel.statusCode, cancel.body).toBe(200);
    await s.until((f) => f.some((x) => x.event === 'job' && x.data.state === 'CANCELLED'), 20_000);
    const summary = (await admin.req('GET', `/jobs/${jobId}/live`)).json<{
      terminal: { supported: boolean; status: string | null };
      events: number;
    }>();
    expect(summary.events).toBeGreaterThan(0);
    expect(summary.terminal.status).toBeNull();
  });
});
