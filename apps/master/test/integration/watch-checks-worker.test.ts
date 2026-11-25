import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NodeHttpExecutor, NodeProbeExecutor, NodeSmtpExecutor } from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

/**
 * p15-watches end to end with a real worker daemon: "localhost:<port> cevap verince haber ver" becomes a
 * `worker_probe` watch; the dry test runs as a `probe` function job on THAT machine (watch-checks-v1) against its own
 * loopback port — never from the master — and says "not yet" while the dev server boots; when it answers, the next
 * scheduled check (from the orchestrator tick, no AI) meets the condition and the conversation gets the note.
 */
const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 13;

describeIntegration('Takipler with a real worker (integration, p15-watches)', { timeout: 300_000 }, () => {
  let h: Harness;
  let url: string;
  let owner: Client;
  let secret: string;
  let w: JobWorker | undefined;
  let workerId = '';
  let server: Server;
  let port = 0;
  let ready = false;
  let hits = 0;
  const dirs: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      if (!ready) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('booting');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', path: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        redisUrl: redisUrlWithDb(HINT_DB),
        hintPrefix: `wc${randomUUID().slice(0, 8)}`,
        tickIntervalMs: 50,
        timing: { leaseTtlMs: 3_600_000, reconnectGraceMs: 60_000, retryBackoffMs: 0 },
      },
      watchChecks: { dryWaitMs: 30_000 },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, secret);
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
      [PROJECT],
    );
  });

  afterAll(async () => {
    await w?.stop().catch(() => undefined);
    await h.stop();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await removeDirs(dirs);
  });

  /** A real worker daemon advertising watch-checks-v1 (its probe executor tries 127.0.0.1 only). */
  async function startWorker(): Promise<void> {
    const fileUrl = await createBareRepo(dirs);
    const dir = await tempDataDir(dirs);
    h.clock.advance(31_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    workerId = await pairRealWorker(h, url, owner, secret, dir);
    const egress = {
      lookup: () => Promise.reject(new Error('ENOTFOUND')),
      isPublicAddress: () => false,
    };
    w = await startJobWorker(url, dir, {
      fileUrl,
      features: ['function-v1', 'watch-checks-v1'],
      functions: {
        http: new NodeHttpExecutor(egress),
        email: new NodeSmtpExecutor(egress),
        probe: new NodeProbeExecutor({ hosts: ['127.0.0.1'] }),
      },
    });
    await expect.poll(() => h.app.fleetSessions.hasReported(workerId), { timeout: 15_000 }).toBe(true);
  }

  it('the probe runs on the chosen machine: dry test "not yet", then met on a scheduled check', async () => {
    await startWorker();
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      watches: () => h.app.chatWatches,
    } as unknown as ChatToolsDeps);
    const { rows } = await h.db.pool.query<{ id: string }>(
      "SELECT id::text AS id FROM users WHERE username = 'owner1'",
    );
    const userId = rows[0]?.id ?? '';
    const thread = await store.createThread(userId, 'dev server');
    const caller = {
      userId,
      subject: await loadSubject(h.db.pool, { id: userId, role: 'owner' }),
      threadId: thread.id,
      turnId: randomUUID(),
    };
    const out = await tools.run(caller, 'create_watch', {
      condition: {
        kind: 'worker_probe',
        project: PROJECT,
        workerId,
        probe: { type: 'http', port, path: '/ready', expect: { bodyContains: 'ready' } },
      },
      label: 'Dev server',
      checkEverySec: 30,
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const data = (out.ok ? out.data : {}) as {
      watchId: string;
      dryTest: { ran: boolean; met: boolean; result: string; machine?: string };
    };
    // The worker probed its own loopback port and saw the booting server. Usually within the dry wait; on a loaded
    // machine the result may land just after the tool answered (it then says "still checking").
    const first = data.dryTest.ran
      ? { met: data.dryTest.met, summary: data.dryTest.result, workerId: data.dryTest.machine }
      : await (async () => {
          let last: { met: boolean; summary: string; workerId: string | null } | null = null;
          for (let i = 0; i < 240 && last === null; i++) {
            const { rows: r } = await h.db.pool.query<{
              last_check: { met: boolean; summary: string; workerId: string | null } | null;
            }>('SELECT last_check FROM chat_watches WHERE id = $1', [data.watchId]);
            last = r[0]?.last_check ?? null;
            if (last === null) await new Promise((res) => setTimeout(res, 250));
          }
          return last;
        })();
    expect(first).toMatchObject({ met: false, workerId });
    expect(first?.summary).toContain('503');
    expect(hits).toBe(1);
    const { rows: jobs } = await h.db.pool.query<{ spec: Record<string, unknown> }>(
      `SELECT spec FROM jobs WHERE spec->>'kind' = 'function' AND spec->'function'->>'type' = 'probe'`,
    );
    expect(jobs[0]?.spec).toMatchObject({
      function: { type: 'probe', probe: { kind: 'http', port, path: '/ready' } },
      requirements: { workers: [workerId] },
    });

    // The server is up; the next scheduled check (orchestrator tick, 30 s later) meets the condition.
    ready = true;
    h.clock.advance(31_000);
    await expect
      .poll(
        async () =>
          (
            await h.db.pool.query<{ state: string }>('SELECT state FROM chat_watches WHERE id = $1', [
              data.watchId,
            ])
          ).rows[0]?.state,
        { timeout: 60_000, interval: 250 },
      )
      .toBe('done');
    const notes = (await store.messages(thread.id)).filter((m) => m.meta?.notice === 'chat-watch');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain('Dev server');
    expect(hits).toBe(2);
    // No assistant turn was ever started.
    expect(
      Number((await h.db.pool.query<{ n: string }>('SELECT count(*) AS n FROM chat_turns')).rows[0]?.n),
    ).toBe(0);
  });
});
