import { randomUUID } from 'node:crypto';
import { FakeRuntimeAdapter, type FakeScript } from '@remyral/agent-adapters';
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
const HINT_DB = 14;

interface Detail {
  job: { id: string; state: string };
  orchestration?: {
    schedule: { status: string; reasons: { code: string; permanent: boolean; message: string }[] } | null;
  };
}

/** Windows worker with verified per-job accounts (`job_user`, 3 accounts); the real runner's selectProfile decides. */
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
 * - "Delegate images" (Claude Code parent): asks a Codex sub-job for images and waits for it (the live case);
 * - "Delegate to myself" (Claude Code parent): asks a Claude Code sub-job (same login store) and waits;
 * - a sub-job ("a sub-job requested"): works 2 s and reports;
 * - anything else: runs until cancelled.
 */
const script: FakeScript = (prompt) => {
  if (prompt.includes('a sub-job requested')) {
    return [
      { kind: 'sleep', ms: 2_000 },
      { kind: 'summary', text: 'Generated the images.' },
    ];
  }
  if (prompt.includes('Delegate images')) {
    return [
      {
        kind: 'subtask',
        tool: 'request_subtask',
        args: {
          title: 'Images',
          prompt: 'Generate the images.',
          runtime: 'codex',
          requires: ['image-generation'],
          wait: true,
          waitSec: 90,
        },
      },
      { kind: 'summary', text: 'Video assembled.' },
    ];
  }
  if (prompt.includes('Delegate to myself')) {
    return [
      {
        kind: 'subtask',
        tool: 'request_subtask',
        args: {
          title: 'Same login',
          prompt: 'Do part two.',
          runtime: 'claude-code',
          wait: true,
          waitSec: 300,
        },
      },
      { kind: 'summary', text: 'Did it myself.' },
    ];
  }
  return [{ kind: 'sleep', ms: 300_000 }];
};

/**
 * p9-subjob-local-login-deadlock (live 2026-10-17, worker 1.0.34): a Claude Code job (subscription login) asked a Codex
 * sub-job (subscription login) and waited; the child stayed queued with `subscription_login_exclusive` until the
 * parent's wait ran out. Real master (Postgres + Redis), a real worker daemon with the Windows per-job account rules,
 * the fake runtimes calling the real sub-job tools.
 */
describeIntegration(
  'sub-jobs beside their parent on subscription logins (integration)',
  { timeout: 180_000 },
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
          hintPrefix: `sj${randomUUID().slice(0, 8)}`,
          tickIntervalMs: 50,
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
      // The project of the live case: host jobs, sub-jobs on, delegation runtimes Claude Code + Codex.
      await h.db.pool.query(
        `UPDATE projects SET host_execution = true, subtasks_enabled = true,
                delegation_runtimes = ARRAY['claude-code', 'codex'] WHERE id = $1`,
        [PROJECT],
      );
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
          { timeout: 30_000 },
        )
        .toBe(0);
      await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
      await h.db.pool.query('UPDATE workers SET archived_at = now() WHERE archived_at IS NULL');
    });
    afterAll(async () => {
      await h.stop();
      await removeDirs(dirs);
    });

    /** windows-worker-1: Claude Code and Codex both on the subscription login; the worker reports `stores`. */
    async function desktop(stores = true): Promise<string> {
      const dir = await tempDataDir(dirs);
      const id = await pairRealWorker(h, url, admin, secret, dir);
      const w = await startJobWorker(url, dir, {
        fileUrl,
        adapter: new FakeRuntimeAdapter({ runtime: 'codex', script }),
        extraAdapters: { 'claude-code': new FakeRuntimeAdapter({ runtime: 'claude-code', script }) },
        runtimeAuth: { codex: { mode: 'local-login' }, 'claude-code': { mode: 'local-login' } },
        features: ['subtasks-v1'],
        capabilities: {
          ...JOB_CAPS,
          runtimes: [fakeRuntime('codex'), fakeRuntime('claude-code')] as CapabilitiesPayload['runtimes'],
          maxParallelJobs: 3,
          sandboxProfiles: ['host-restricted'],
          features: ['profile-slots-v1'],
          profileConcurrency: { 'host-restricted': 3 },
          exclusiveProfiles: [],
          localLogin: {
            runtimes: ['claude-code', 'codex'],
            exclusiveProfiles: ['host-restricted'],
            ...(stores ? { stores: { 'claude-code': 'claude', codex: 'codex' } } : {}),
          },
        },
        sandbox: jobUserSandbox(),
      });
      workers.push(w);
      await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
      // No slot kept for Acil: these tests are about the login rule.
      await h.db.pool.query('UPDATE workers SET urgent_reserve = 0 WHERE id = $1', [id]);
      return id;
    }

    async function submit(prompt: string, runtime: string): Promise<string> {
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
    const codes = async (id: string) => (await reasons(id)).map((r) => r.code).sort();
    async function childOf(parent: string): Promise<string | null> {
      const { rows } = await h.db.pool.query<{ child: string }>(
        'SELECT child_job_id::text AS child FROM job_subtasks WHERE parent_job_id = $1',
        [parent],
      );
      return rows[0]?.child ?? null;
    }
    async function toolResults(jobId: string): Promise<string[]> {
      const { rows } = await h.db.pool.query<{ kind: string; payload: { outputSummary?: string } }>(
        'SELECT kind, payload FROM job_events WHERE job_id = $1 ORDER BY stream_seq',
        [jobId],
      );
      return rows.filter((r) => r.kind === 'tool_result').map((r) => r.payload.outputSummary ?? '');
    }

    it('the live case: a Codex sub-job runs beside its waiting Claude Code parent (both subscription logins)', async () => {
      await desktop();
      const parent = await submit('Delegate images', 'claude-code');
      await expect.poll(() => childOf(parent), { timeout: 20_000 }).not.toBeNull();
      const child = (await childOf(parent)) ?? '';
      // Both run at the same time on the one machine (the child no longer waits for its parent).
      await expect
        .poll(async () => [await state(parent), await state(child)], { timeout: 20_000 })
        .toEqual(['RUNNING', 'RUNNING']);
      await expect.poll(() => state(child), { timeout: 30_000 }).toBe('SUCCEEDED');
      await expect.poll(() => state(parent), { timeout: 30_000 }).toBe('SUCCEEDED');
      const results = await toolResults(parent);
      expect(results.join('\n')).toMatch(/Sub-job .* "Images" \(codex.*\): succeeded\./);
      expect(results.join('\n')).toContain('Generated the images.');
      // (The worker's own selectProfile admitted the child beside the parent only because its ASSIGN_JOB named the
      // parent as the family root: a job of another family is refused there — see the next test.)
    });

    it('unrelated subscription-login jobs still serialise — different runtimes and the same store', async () => {
      await desktop();
      const first = await submit('long claude code job', 'claude-code');
      await expect.poll(() => state(first), { timeout: 20_000 }).toBe('RUNNING');
      const codex = await submit('long codex job', 'codex');
      await expect.poll(() => codes(codex), { timeout: 20_000 }).toEqual(['subscription_login_exclusive']);
      expect((await reasons(codex))[0]?.message).toMatch(
        /is running another job \(1\); a Codex subscription-login job runs as the worker account/,
      );
      const claude = await submit('second claude code job', 'claude-code');
      await expect
        .poll(() => codes(claude), { timeout: 20_000 })
        .toEqual(['subscription_login_busy', 'subscription_login_exclusive']);
      // Nothing was asked (no LEASE round-trip) and nothing runs beside the first job.
      const attempts = await h.db.pool.query('SELECT 1 FROM job_attempts WHERE job_id = ANY($1::uuid[])', [
        [codex, claude],
      ]);
      expect(attempts.rowCount).toBe(0);
    });

    it('a Claude Code sub-job of a Claude Code parent (same login) is reported as blocked_by_parent at once', async () => {
      await desktop();
      const parent = await submit('Delegate to myself', 'claude-code');
      await expect.poll(() => childOf(parent), { timeout: 20_000 }).not.toBeNull();
      const child = (await childOf(parent)) ?? '';
      await expect.poll(() => codes(child), { timeout: 20_000 }).toEqual(['subscription_login_busy']);
      // The parent's wait (300 s budget) ends within seconds with the reason; its agent goes on by itself.
      await expect.poll(() => state(parent), { timeout: 30_000 }).toBe('SUCCEEDED');
      const text = (await toolResults(parent)).join('\n');
      expect(text).toMatch(/: queued\./);
      expect(text).toMatch(
        /This sub-job cannot start while this job runs: it can only run on .+, and there it waits for this job itself \(waiting for the Claude Code subscription login/,
      );
      expect(text).toContain('Not waiting: this sub-job cannot start before this job ends.');
      // The open sub-job is cancelled with its parent (cascade), never run.
      await expect.poll(() => state(child), { timeout: 30_000 }).toBe('CANCELLED');
      const attempts = await h.db.pool.query('SELECT 1 FROM job_attempts WHERE job_id = $1', [child]);
      expect(attempts.rowCount).toBe(0);
    });

    it('a worker without `stores` keeps the old rule; the deadlock is reported as blocked_by_parent', async () => {
      await desktop(false);
      const parent = await submit('Delegate images', 'claude-code');
      await expect.poll(() => childOf(parent), { timeout: 20_000 }).not.toBeNull();
      const child = (await childOf(parent)) ?? '';
      await expect.poll(() => codes(child), { timeout: 20_000 }).toEqual(['subscription_login_exclusive']);
      await expect.poll(() => state(parent), { timeout: 30_000 }).toBe('SUCCEEDED');
      expect((await toolResults(parent)).join('\n')).toContain('waits for this job itself');
      await expect.poll(() => state(child), { timeout: 30_000 }).toBe('CANCELLED');
    });
  },
);
