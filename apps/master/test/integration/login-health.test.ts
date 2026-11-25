import { randomUUID } from 'node:crypto';
import { FakeRuntimeAdapter, type FakeScript } from '@remyral/agent-adapters';
import { createLogger } from '@remyral/observability';
import { applyRunLogin, type CapabilitiesPayload, LoginManager } from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
  orchestration?: {
    schedule: {
      status: string;
      reasons: { code: string; permanent: boolean; message: string; params?: Record<string, unknown> }[];
    } | null;
    runs?: { attemptId: string; resultError: { code: string; params?: Record<string, unknown> } | null }[];
  };
}

/** The live texts (Claude Code 2.1.x): a lost refresh race, and a real expiry. */
const CONTENTION =
  'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh';
const EXPIRED = 'OAuth token has expired. Please run /login';

const script: FakeScript = (prompt) => {
  if (prompt.includes('lose the refresh race')) {
    return [
      { kind: 'summary', text: CONTENTION },
      { kind: 'crash', code: 'login_expired', message: CONTENTION },
    ];
  }
  if (prompt.includes('login expired')) {
    return [
      { kind: 'summary', text: EXPIRED },
      { kind: 'crash', code: 'login_expired', message: EXPIRED },
    ];
  }
  return [{ kind: 'summary', text: 'Done.' }];
};

/**
 * p10-claude-login-health (live 2026-10-18, Windows worker 1.0.37): after a wake-up the first Claude Code job lost
 * the OAuth refresh race to the assistant's process; the worker marked Claude Code signed out, the next job failed at
 * once with `runtime_not_authenticated`, and a successful Check did not clear the state. Real master (Postgres +
 * Redis), a real worker daemon + job runner, the worker's real LoginManager rule, a fake Claude Code runtime.
 */
describeIntegration('subscription login health (integration)', { timeout: 180_000 }, () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  let fileUrl: string;
  let ownerId: string;
  let workerId: string;
  let worker: JobWorker | undefined;
  const dirs: string[] = [];
  /** What the fake `claude -p` probe answers. */
  let probeUsable = false;
  let probes = 0;
  const login = new LoginManager({
    binary: () => Promise.resolve('/fake/claude'),
    env: {},
    logger: createLogger({ sink: () => undefined }),
    run: (_file, args) => {
      if (args[0] === 'auth') {
        return Promise.resolve({
          exitCode: 0,
          stdout: '{"loggedIn": true, "authMethod": "claude.ai"}',
          stderr: '',
          timedOut: false,
        });
      }
      probes += 1;
      return Promise.resolve(
        probeUsable
          ? { exitCode: 0, stdout: '{"type":"result","is_error":false}', stderr: '', timedOut: false }
          : { exitCode: 1, stdout: '', stderr: EXPIRED, timedOut: false },
      );
    },
  });

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
        hintPrefix: `lh${randomUUID().slice(0, 8)}`,
        tickIntervalMs: 50,
        timing: {
          leaseTtlMs: 3_600_000,
          reconnectGraceMs: 3_600_000,
          retryBackoffMs: 0,
          effectRetryAfterMs: 0,
          loginWaitMs: 30 * 60_000,
        },
      },
    });
    url = await h.listen();
    ownerId = await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    fileUrl = await createBareRepo(dirs);
    await h.db.pool.query(
      `INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT (id) DO NOTHING`,
      [PROJECT],
    );
  });
  afterAll(async () => {
    await worker?.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  /** The machine (paired and started on first use: pairing polls, which only works inside a test). */
  async function ensureWorker(): Promise<void> {
    if (worker !== undefined) return;
    const dir = await tempDataDir(dirs);
    workerId = await pairRealWorker(h, url, admin, secret, dir);
    const holder: { w: JobWorker | null } = { w: null };
    // The worker reports Claude Code signed out exactly while its LoginManager flags the login (daemon/run.ts).
    const caps: CapabilitiesPayload = {
      ...JOB_CAPS,
      get runtimes() {
        return [
          ...JOB_CAPS.runtimes,
          {
            runtime: 'claude-code' as const,
            version: '0.0.0-fake',
            installed: true,
            authenticated: login.isExpired('claude-code') ? ('no' as const) : ('yes' as const),
            capabilities: {
              approval: { status: 'supported' as const },
              cancel: { status: 'supported' as const },
            },
            pinnedVersion: '0.0.0-fake',
            pinStatus: 'match' as const,
          },
        ];
      },
    };
    worker = await startJobWorker(url, dir, {
      fileUrl,
      extraAdapters: { 'claude-code': new FakeRuntimeAdapter({ runtime: 'claude-code', script }) },
      runtimeAuth: { 'claude-code': { mode: 'local-login' } },
      capabilities: caps,
      onRuntimeLogin: (runtime, state, cause) => {
        if (applyRunLogin(login, runtime, state, cause, true)) holder.w?.daemon.refreshCapabilities();
      },
    });
    holder.w = worker;
    await expect.poll(() => h.app.fleetSessions.hasReported(workerId), { timeout: 15_000 }).toBe(true);
    await h.db.pool.query('UPDATE workers SET urgent_reserve = 0 WHERE id = $1', [workerId]);
  }

  async function submit(prompt: string): Promise<string> {
    await ensureWorker();
    h.clock.advance(1_000);
    const res = await admin.req('POST', '/jobs', {
      project: PROJECT,
      spec: jobSpec({ prompt, runtime: 'claude-code' }),
    });
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
  async function failure(id: string): Promise<string> {
    const { rows } = await h.db.pool.query<{ reason: string | null }>(
      `SELECT reason FROM job_transitions WHERE job_id = $1 AND to_state = 'FAILED'`,
      [id],
    );
    return rows[0]?.reason ?? '';
  }

  it('a lost refresh race fails only that run: the runtime stays signed in and the next job runs', async () => {
    const lost = await submit('lose the refresh race');
    await expect.poll(() => state(lost), { timeout: 20_000 }).toBe('FAILED');
    expect(await failure(lost)).toMatch(/^login_refresh_contention: .*run the job again/);
    // p14-i18n-reasons: the worker's cause reaches the job detail API (the console says it from there).
    expect((await detail(lost)).orchestration?.runs?.at(-1)?.resultError).toEqual({
      code: 'login_refresh_contention',
      params: { cause: 'run_again' },
    });
    expect(login.isExpired('claude-code')).toBe(false);
    const next = await submit('just work');
    await expect.poll(() => state(next), { timeout: 20_000 }).toBe('SUCCEEDED');
  });

  it('a real expiry signs it out; the next job waits (owner told once), and runs after a Check finds it usable', async () => {
    const expired = await submit('login expired');
    await expect.poll(() => state(expired), { timeout: 20_000 }).toBe('FAILED');
    expect(await failure(expired)).toMatch(/^login_expired: /);
    expect(login.isExpired('claude-code')).toBe(true);

    const waiting = await submit('after the expiry');
    const waitingSecond = await submit('another one after the expiry');
    await expect
      .poll(async () => (await reasons(waiting)).find((r) => r.code === 'runtime_not_authenticated'), {
        timeout: 20_000,
      })
      .toMatchObject({
        permanent: false,
        message: expect.stringMatching(/needs a login on .* waiting/) as unknown,
        // p14-i18n-reasons: the scheduler's cause survives job_schedule_status and the API schema.
        params: { cause: 'login_wait', until: expect.any(String) as unknown },
      });
    expect(await state(waiting)).toBe('QUEUED');
    // One notice for the machine's login, not one per waiting job.
    await expect
      .poll(
        async () =>
          (
            await h.db.pool.query(
              `SELECT 1 FROM notifications WHERE recipient_id = $1 AND kind = 'job.waiting'
                  AND dedupe_key LIKE 'runtime.login:%'`,
              [ownerId],
            )
          ).rowCount,
        { timeout: 20_000 },
      )
      .toBe(1);

    // Check while the login is still unusable: the probe fails, the flag stays.
    probeUsable = false;
    expect((await login.check('claude-code')).status).toBe('expired');
    expect(login.isExpired('claude-code')).toBe(true);
    // Check after the owner logged in again: the probe works → flag cleared at once → both jobs run.
    probeUsable = true;
    expect((await login.check('claude-code')).status).toBe('logged_in');
    expect(probes).toBe(2);
    worker?.daemon.refreshCapabilities();
    await expect.poll(() => state(waiting), { timeout: 20_000 }).toBe('SUCCEEDED');
    await expect.poll(() => state(waitingSecond), { timeout: 20_000 }).toBe('SUCCEEDED');
    const notices = await h.db.pool.query(
      `SELECT 1 FROM notifications WHERE recipient_id = $1 AND dedupe_key LIKE 'runtime.login:%'`,
      [ownerId],
    );
    expect(notices.rowCount).toBe(1);
  });

  it('the wait is bounded: after the login wait the job fails with runtime_not_authenticated', async () => {
    probeUsable = false;
    const expired = await submit('login expired');
    await expect.poll(() => state(expired), { timeout: 20_000 }).toBe('FAILED');
    expect(login.isExpired('claude-code')).toBe(true);
    const late = await submit('too late');
    await expect
      .poll(async () => (await reasons(late)).some((r) => r.code === 'runtime_not_authenticated'), {
        timeout: 20_000,
      })
      .toBe(true);
    // The job has been waiting for longer than the login wait (31 minutes ago).
    const since = new Date(h.clock.now().getTime() - 31 * 60_000).toISOString();
    await h.db.pool.query(
      `UPDATE job_schedule_status
          SET reasons = (SELECT jsonb_agg(CASE WHEN r->>'code' = 'runtime_not_authenticated'
                                               THEN r || jsonb_build_object('waitingSince', $2::text) ELSE r END)
                           FROM jsonb_array_elements(reasons) r)
        WHERE job_id = $1`,
      [late, since],
    );
    await expect.poll(() => state(late), { timeout: 20_000 }).toBe('FAILED');
    expect(await failure(late)).toMatch(/runtime_not_authenticated .*still signed out/);
  });
});
