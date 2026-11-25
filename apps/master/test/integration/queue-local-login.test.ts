import { randomUUID } from 'node:crypto';
import { FakeRuntimeAdapter, longRunningScript } from '@remyral/agent-adapters';
import type { WorkerToMaster } from '@remyral/protocol';
import { type CapabilitiesPayload, SANDBOX_DEFAULT_LIMITS, type SandboxPort } from '@remyral/worker';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  createBareRepo,
  JOB_CAPS,
  type JobWorker,
  jobSpec,
  PROJECT,
  startJobWorker,
} from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 13;

interface Detail {
  job: { id: string; state: string };
  transitions: { trigger: string; to: string; reason: string | null }[];
  orchestration?: {
    schedule: { status: string; reasons: { code: string; permanent: boolean; message: string }[] } | null;
  };
}

interface QueueMachine {
  id: string;
  running: number;
  slots: number | null;
  urgentReserve: number;
  urgentReserveEffective: number;
  subscriptionLogins: { runtimes: string[]; atATime: number } | null;
}
interface QueueJson {
  pools: {
    key: string;
    machines: QueueMachine[];
    jobs: { jobId: string; category: string | null; reasons: { code: string; message: string }[] }[];
  }[];
}

/**
 * windows-worker-1 on 2026-10-17 (worker 1.0.32): Windows per-job accounts verified (`job_user`, 3 accounts), so
 * API-key host attempts run in parallel, while a subscription-login (local-login) attempt runs as the worker account,
 * one at a time and alone (p9-windows-slots-local-login). The real job runner's `selectProfile` enforces it.
 */
function jobUserSandbox(): SandboxPort {
  return {
    runners: {
      runner: () => ({
        confiner: () => ({ kind: 'test', confine: (plan: unknown) => Promise.resolve(plan) }),
      }),
      capabilities: (opts: { runningAttempts: number; hostAttempts?: number }) =>
        Promise.resolve({
          platform: 'win32' as const,
          container: { ready: false, reason: 'no engine' },
          hostRestricted: {
            ready: true,
            filesystemConfinement: 'job_user' as const,
            egressEnforced: false,
            concurrency: 3,
          },
          runtimeSandboxes: [],
          runningAttempts: opts.runningAttempts,
          ...(opts.hostAttempts === undefined ? {} : { hostAttempts: opts.hostAttempts }),
        }),
    },
    limits: SANDBOX_DEFAULT_LIMITS,
    egressAllow: ['api.openai.com'],
  } as unknown as SandboxPort;
}

const fakeRuntime = (runtime: string) => ({
  runtime,
  version: '0.0.0-fake',
  installed: true,
  authenticated: 'yes' as const,
  capabilities: { approval: { status: 'supported' as const }, cancel: { status: 'supported' as const } },
  pinnedVersion: '0.0.0-fake',
  pinStatus: 'match' as const,
});

/**
 * p9-queue-local-login-accounting: "3 slots, 1 job running, 2 in queue — why?" end to end — real master (Postgres +
 * Redis), real worker daemons over the WebSocket transport, the real job runner with the Windows per-job account rules.
 */
describeIntegration(
  'queue: subscription logins run one at a time (integration)',
  { timeout: 120_000 },
  () => {
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
          hintPrefix: `ql${randomUUID().slice(0, 8)}`,
          tickIntervalMs: 50,
          // Long leases: the tests move the fake clock to pass decline retry times.
          timing: {
            leaseTtlMs: 3_600_000,
            reconnectGraceMs: 3_600_000,
            retryBackoffMs: 0,
            effectRetryAfterMs: 0,
          },
        },
      });
      url = await h.listen();
      await h.createUser('owner1', PW);
      ({ secret } = await enroll(h, 'owner1', PW));
      admin = await fullLogin(h, 'owner1', PW, secret);
      fileUrl = await createBareRepo(dirs);
      await h.db.pool.query(
        `INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT (id) DO NOTHING`,
        [PROJECT],
      );
      await h.db.pool.query('UPDATE projects SET host_execution = true WHERE id = $1', [PROJECT]);
    });
    afterEach(async () => {
      const open = await h.db.pool.query<{ id: string }>(
        "SELECT id FROM jobs WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')",
      );
      for (const r of open.rows) await admin.req('POST', `/jobs/${r.id}/cancel`, { reason: 'test cleanup' });
      await expect
        .poll(
          async () =>
            (
              await h.db.pool.query(
                "SELECT 1 FROM jobs WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')",
              )
            ).rowCount,
          { timeout: 20_000 },
        )
        .toBe(0);
      await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
      await h.db.pool.query('UPDATE workers SET archived_at = now() WHERE archived_at IS NULL');
    });
    afterAll(async () => {
      await h.stop();
      await removeDirs(dirs);
    });

    /** Codex and Claude Code on the subscription login; OpenCode (optional) without one (an API-key runtime). */
    async function desktop(
      caps: Partial<CapabilitiesPayload>,
      withOpenCode = false,
    ): Promise<{ id: string; w: JobWorker }> {
      const dir = await tempDataDir(dirs);
      const id = await pairRealWorker(h, url, admin, secret, dir);
      const w = await startJobWorker(url, dir, {
        fileUrl,
        fake: { script: longRunningScript },
        extraAdapters: {
          'claude-code': new FakeRuntimeAdapter({ runtime: 'claude-code', script: longRunningScript }),
          ...(withOpenCode
            ? { opencode: new FakeRuntimeAdapter({ runtime: 'opencode', script: longRunningScript }) }
            : {}),
        },
        runtimeAuth: { codex: { mode: 'local-login' }, 'claude-code': { mode: 'local-login' } },
        capabilities: {
          ...JOB_CAPS,
          runtimes: [
            fakeRuntime('codex'),
            fakeRuntime('claude-code'),
            ...(withOpenCode ? [fakeRuntime('opencode')] : []),
          ] as CapabilitiesPayload['runtimes'],
          maxParallelJobs: 3,
          sandboxProfiles: ['host-restricted'],
          features: ['profile-slots-v1'],
          profileConcurrency: { 'host-restricted': 3 },
          exclusiveProfiles: [],
          ...caps,
        },
        sandbox: jobUserSandbox(),
      });
      workers.push(w);
      await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
      return { id, w };
    }

    async function submit(prompt: string, runtime = 'codex'): Promise<string> {
      // The fake clock is frozen: one second between submissions gives the dispatch order (oldest first).
      h.clock.advance(1_000);
      const res = await admin.req('POST', '/jobs', { project: PROJECT, spec: jobSpec({ prompt, runtime }) });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ job: { id: string } }>().job.id;
    }
    async function detail(id: string): Promise<Detail> {
      const res = await admin.req('GET', `/jobs/${id}`);
      expect(res.statusCode).toBe(200);
      return res.json<Detail>();
    }
    const state = async (id: string) => (await detail(id)).job.state;
    const reasons = async (id: string) => (await detail(id)).orchestration?.schedule?.reasons ?? [];
    const codes = async (id: string) => (await reasons(id)).map((r) => r.code);
    const declines = async (id: string) =>
      (await detail(id)).transitions.filter((t) => t.trigger === 'lease_declined').length;
    async function queue(): Promise<QueueJson['pools'][number]> {
      const res = await admin.req('GET', `/queue?project=${PROJECT}`);
      expect(res.statusCode, res.body).toBe(200);
      const pool = res.json<QueueJson>().pools.find((p) => p.key === 'host-restricted');
      if (pool === undefined) throw new Error('no host-restricted pool');
      return pool;
    }
    async function finish(id: string): Promise<void> {
      expect((await admin.req('POST', `/jobs/${id}/cancel`, { reason: 'done' })).statusCode).toBe(200);
      await expect.poll(() => state(id), { timeout: 20_000 }).toBe('CANCELLED');
    }
    /** Polls for `ms` that `check` holds every time. */
    async function holds(ms: number, check: () => Promise<void>): Promise<void> {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await check();
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    /** Holds every message the worker sends (in order) until `release()`: the worker answers slowly. */
    function pauseAfter(
      w: JobWorker,
      when: (m: WorkerToMaster) => boolean,
    ): { paused: () => boolean; release: () => void } {
      const send = w.transport.send.bind(w.transport);
      let paused = false;
      let queued: { m: WorkerToMaster; done: (p: Promise<void>) => void }[] = [];
      w.transport.send = (m: WorkerToMaster) => {
        if (!paused && when(m)) paused = true;
        if (!paused) return send(m);
        return new Promise<void>((resolve, reject) => {
          queued.push({ m, done: (p) => void p.then(resolve, reject) });
        });
      };
      return {
        paused: () => paused,
        release: () => {
          paused = false;
          w.transport.send = send;
          const q = queued;
          queued = [];
          void (async () => {
            for (const x of q) {
              const p = send(x.m);
              x.done(p);
              await p.catch(() => undefined);
            }
          })();
        },
      };
    }

    it('worker 1.0.32 (no localLogin report): a busy-declined re-ask never takes a slot; declines back off', async () => {
      const { w } = await desktop({});
      const running = await submit('running subscription job');
      await expect.poll(() => state(running), { timeout: 20_000 }).toBe('RUNNING');
      const codex = await submit('queued codex (subscription)');
      await expect.poll(() => codes(codex), { timeout: 20_000 }).toContain('declined_busy');
      const claude = await submit('queued claude code (subscription)', 'claude-code');
      await expect.poll(() => codes(claude), { timeout: 20_000 }).toContain('declined_busy');
      const recorded = await h.db.pool.query<{ active_leases: number }>(
        'SELECT active_leases FROM job_declines WHERE job_id = ANY($1::uuid[])',
        [[codex, claude]],
      );
      expect(recorded.rows.map((r) => r.active_leases)).toEqual([1, 1]);

      // Back-off: inside the worker's retry window nobody is asked again (the clock is frozen).
      await holds(1_500, async () => {
        expect(await declines(codex)).toBe(1);
        expect(await declines(claude)).toBe(1);
      });

      // Past the window both are asked again; the worker answers the codex re-ask slowly. While that re-ask is
      // pending (RESERVED) it holds no slot: the claude job behind it is asked too instead of being told "2/3 slots in
      // use … kept for Acil".
      const pause = pauseAfter(w, (m) => m.type === 'LEASE_ACK' && m.jobId === codex && !m.payload.accepted);
      try {
        h.clock.advance(6_000);
        await expect.poll(() => pause.paused(), { timeout: 20_000 }).toBe(true);
        // The claude job behind it is asked again too (its re-ask may already be answered: the worker may handle it
        // before the paused codex answer).
        await expect
          .poll(
            async () => (await detail(claude)).transitions.filter((t) => t.trigger === 'reserve').length,
            {
              timeout: 20_000,
            },
          )
          .toBe(2);
        expect(await state(codex)).toBe('RESERVED');
        expect(await codes(claude)).not.toContain('urgent_slot_reserved');
      } finally {
        pause.release();
      }
      await expect.poll(() => declines(codex), { timeout: 20_000 }).toBe(2);
      await expect.poll(() => declines(claude), { timeout: 20_000 }).toBe(2);
      expect(await codes(claude)).not.toContain('urgent_slot_reserved');

      // The second busy decline doubles the wait (10 s): 6 s later still nobody is asked again …
      h.clock.advance(6_000);
      await holds(1_500, async () => {
        expect(await declines(codex)).toBe(2);
        expect(await declines(claude)).toBe(2);
      });
      // … and past it they are.
      h.clock.advance(5_000);
      await expect.poll(() => declines(codex), { timeout: 20_000 }).toBe(3);

      // The running job ends: a waiting one is asked at once (back-off or not) and runs; the other keeps waiting.
      await finish(running);
      // (A busy-declined job's re-ask from an outbox hint may come first: either one runs, never both.)
      await expect
        .poll(async () => [await state(codex), await state(claude)].sort(), { timeout: 20_000 })
        .toEqual(['QUEUED', 'RUNNING']);
      await holds(1_000, async () => {
        expect([await state(codex), await state(claude)].filter((x) => x === 'RUNNING')).toHaveLength(1);
      });
    });

    const reported = {
      localLogin: { runtimes: ['claude-code', 'codex'], exclusiveProfiles: ['host-restricted'] },
    } as Partial<CapabilitiesPayload>;

    it('the production case with the report: both queued subscription jobs wait on the login, never asked', async () => {
      await desktop(reported);
      const running = await submit('running subscription job');
      await expect.poll(() => state(running), { timeout: 20_000 }).toBe('RUNNING');
      const codex = await submit('queued codex (subscription)');
      const claude = await submit('queued claude code (subscription)', 'claude-code');
      for (const id of [codex, claude]) {
        await expect.poll(() => codes(id), { timeout: 20_000 }).toEqual(['subscription_login_exclusive']);
        const r = (await reasons(id))[0];
        expect(r?.permanent).toBe(false);
        expect(r?.message).toMatch(
          /^Claude Code \/ Codex subscription logins run one at a time on .+ \(shared login\); API-key jobs can run in parallel/,
        );
      }
      // No LEASE round-trip: no attempt, no decline, no context bundle for the waiting jobs.
      await holds(1_500, async () => {
        expect(await declines(codex)).toBe(0);
        expect(await declines(claude)).toBe(0);
      });
      const attempts = await h.db.pool.query('SELECT 1 FROM job_attempts WHERE job_id = ANY($1::uuid[])', [
        [codex, claude],
      ]);
      expect(attempts.rowCount).toBe(0);
      // Queue screen: the category and the pool header ("1 running of 3 slots · subscription logins: 1 at a time");
      // nothing is kept for Acil where only subscription-login work can run (D).
      const pool = await queue();
      expect(pool.jobs.filter((j) => j.jobId !== running).map((j) => j.category)).toEqual([
        'subscription_login',
        'subscription_login',
      ]);
      expect(pool.machines[0]).toMatchObject({
        running: 1,
        slots: 3,
        urgentReserve: 1,
        urgentReserveEffective: 0,
        subscriptionLogins: { runtimes: ['claude-code', 'codex'], atATime: 1 },
      });
      // The running job ends → one queued job runs alone; the other keeps waiting on the login, never asked.
      await finish(running);
      // (The lease may be released in the middle of a dispatch pass: either one runs first, alone.)
      await expect
        .poll(async () => [await state(codex), await state(claude)].sort(), { timeout: 20_000 })
        .toEqual(['QUEUED', 'RUNNING']);
      const waiting = (await state(codex)) === 'QUEUED' ? codex : claude;
      await expect.poll(() => codes(waiting), { timeout: 20_000 }).toEqual(['subscription_login_exclusive']);
      expect(await declines(codex)).toBe(0);
      expect(await declines(claude)).toBe(0);
    });

    it('API-key jobs run in parallel, but never beside a subscription-login job', async () => {
      await desktop(reported, true);
      const login = await submit('subscription job');
      await expect.poll(() => state(login), { timeout: 20_000 }).toBe('RUNNING');
      const api1 = await submit('api-key job 1', 'opencode');
      await expect.poll(() => codes(api1), { timeout: 20_000 }).toEqual(['subscription_login_exclusive']);
      expect((await reasons(api1))[0]?.message).toMatch(
        /subscription-login job is running on .+; it runs alone/,
      );
      expect(await declines(api1)).toBe(0);
      // With an API-key runtime on the machine the reserve applies to its parallel slots again.
      expect((await queue()).machines[0]?.urgentReserveEffective).toBe(1);
      await finish(login);
      await expect.poll(() => state(api1), { timeout: 20_000 }).toBe('RUNNING');
      const api2 = await submit('api-key job 2', 'opencode');
      await expect.poll(() => state(api2), { timeout: 20_000 }).toBe('RUNNING');
      const login2 = await submit('subscription job 2');
      await expect.poll(() => codes(login2), { timeout: 20_000 }).toEqual(['subscription_login_exclusive']);
      expect(await declines(login2)).toBe(0);
    });
  },
);
