import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { RemoteBranchInspector, RemoteBranchState } from '../../src/orchestration/remote-branch.js';
import { redisUrlWithDb } from './env.js';
import { type Client, enroll, fullLogin, Harness } from './harness.js';
import { createBareRepo, type JobWorker, JOB_CAPS, jobSpec, PROJECT, startJobWorker } from './job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from './real-worker.js';

export const PW = 'quartz-meadow-lantern-7';

class AbsentInspector implements RemoteBranchInspector {
  inspect(): Promise<RemoteBranchState> {
    return Promise.resolve('absent');
  }
}

export interface JobDetail {
  job: { id: string; state: string; currentAttemptId: string | null };
  transitions: {
    trigger: string;
    to: string;
    actor: { type: string; id: string | null };
    reason: string | null;
  }[];
  attempts: { id: string; number: number; workerId: string; outcome: string | null }[];
  orchestration?: {
    schedule: {
      status: string;
      reasons: { code: string; permanent: boolean; message: string; workers: string[] }[];
    } | null;
  };
}

/**
 * A real master (Postgres + BullMQ hints on Redis, background loop) with real worker daemons over the
 * WebSocket transport and the fake runtime — shared by the p4-quotas and p4-dag integration suites.
 */
export class Cluster {
  h!: Harness;
  url!: string;
  admin!: Client;
  secret!: string;
  fileUrl!: string;
  readonly dirs: string[] = [];
  readonly workers: JobWorker[] = [];

  /** `loop: false` — no background loop and no BullMQ: the test drives `orchestrator.tick()` itself. */
  async start(
    hintDb: number,
    opts: {
      loop?: boolean;
      /** p14-workflow-engine: run workflows on engine 2 (`v2ForV1`: version-1 documents too — the parity suite). */
      workflowEngine?: { v2?: boolean; v2ForV1?: boolean };
    } = {},
  ): Promise<void> {
    const loop = opts.loop ?? true;
    // The worker daemons run on the wall clock and check master-issued instants against it (a parked workspace's
    // retainUntil, 7 days): the master's fake clock must start at the wall clock too, never at a fixed date.
    this.h = new Harness(Date.now());
    await this.h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        redisUrl: loop ? redisUrlWithDb(hintDb) : null,
        hintPrefix: `t${randomUUID().slice(0, 8)}`,
        tickIntervalMs: loop ? 50 : 0,
        inspector: new AbsentInspector(),
        ...(opts.workflowEngine === undefined
          ? process.env.REMYRAL_TEST_WORKFLOW_ENGINE === '2'
            ? { workflowEngine: { v2: true, v2ForV1: true } }
            : {}
          : { workflowEngine: opts.workflowEngine }),
        // Long leases: tests advance the fake clock for step-up codes (30 s per step-up).
        timing: {
          leaseTtlMs: 3_600_000,
          reconnectGraceMs: 7_200_000,
          retryBackoffMs: 0,
          effectRetryAfterMs: 0,
        },
      },
    });
    this.url = await this.h.listen();
    await this.h.createUser('owner1', PW);
    ({ secret: this.secret } = await enroll(this.h, 'owner1', PW));
    this.admin = await fullLogin(this.h, 'owner1', PW, this.secret);
    this.fileUrl = await createBareRepo(this.dirs);
    await this.h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT (id) DO NOTHING',
      [PROJECT],
    );
  }

  async stopWorkers(): Promise<void> {
    await Promise.all(this.workers.splice(0).map((w) => w.stop().catch(() => undefined)));
  }

  async stop(): Promise<void> {
    await this.stopWorkers();
    await this.h.stop();
    await removeDirs(this.dirs);
  }

  async newWorker(
    opts: Partial<Parameters<typeof startJobWorker>[2]> & {
      slots?: number;
      /**
       * p9-queue-priority: slots kept for urgent jobs. These suites predate the reservation and count on every slot
       * for normal jobs, so the default here is 0 (production default 1; covered by queue-priority.test.ts).
       */
      urgentReserve?: number;
    } = {},
  ): Promise<{ id: string; w: JobWorker }> {
    const dir = await tempDataDir(this.dirs);
    const id = await pairRealWorker(this.h, this.url, this.admin, this.secret, dir);
    const { slots, urgentReserve = 0, ...rest } = opts;
    await this.h.db.pool.query('UPDATE workers SET urgent_reserve = $2 WHERE id = $1', [id, urgentReserve]);
    const w = await startJobWorker(this.url, dir, {
      fileUrl: this.fileUrl,
      ...(slots === undefined
        ? {}
        : {
            capabilities: {
              ...JOB_CAPS,
              maxParallelJobs: slots,
              ...(rest.projects === undefined ? {} : { projects: [...rest.projects] }),
            },
          }),
      ...rest,
    });
    this.workers.push(w);
    // A plain wait (usable from beforeAll, where expect.poll is not).
    const until = Date.now() + 45_000;
    while (!this.h.app.fleetSessions.hasReported(id)) {
      if (Date.now() > until) throw new Error(`worker ${id} did not report`);
      await new Promise((r) => setTimeout(r, 25));
    }
    return { id, w };
  }

  async submit(spec: Record<string, unknown> = jobSpec(), priority?: number): Promise<string> {
    const res = await this.admin.req('POST', '/jobs', {
      project: PROJECT,
      spec,
      ...(priority === undefined ? {} : { priority }),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ job: { id: string } }>().job.id;
  }

  async detail(id: string): Promise<JobDetail> {
    const res = await this.admin.req('GET', `/jobs/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json<JobDetail>();
  }

  async state(id: string): Promise<string> {
    return (await this.detail(id)).job.state;
  }

  /** Codes of the latest scheduler verdict (waiting reasons). */
  async waitingCodes(id: string): Promise<string[]> {
    const d = await this.detail(id);
    return d.orchestration?.schedule?.status === 'waiting'
      ? d.orchestration.schedule.reasons.map((r) => r.code)
      : [];
  }

  /** A fresh step-up (POST /auth/step-up) for admin writes. */
  async stepUp(): Promise<void> {
    this.h.clock.advance(30_000);
    const res = await this.admin.req('POST', '/auth/step-up', { code: this.h.code(this.secret) });
    expect(res.statusCode, res.body).toBe(200);
  }

  /** Cancels every non-terminal job of the project (between tests). */
  async cancelAll(): Promise<void> {
    const { rows } = await this.h.db.pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`,
    );
    for (const r of rows) await this.admin.req('POST', `/jobs/${r.id}/cancel`, { reason: 'test cleanup' });
    await expect
      .poll(
        async () =>
          (
            await this.h.db.pool.query(
              `SELECT 1 FROM jobs WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`,
            )
          ).rowCount,
        { timeout: 45_000 },
      )
      .toBe(0);
  }
}
