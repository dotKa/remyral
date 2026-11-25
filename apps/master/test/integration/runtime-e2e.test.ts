import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LocalGitProvider } from '../../src/gitflow/local-provider.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, jobSpec, PROJECT, REPO_URL } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';
import { type RuntimeWorker, startRuntimeWorker } from '../helpers/runtime-worker.js';

/**
 * Worker job-runner integration with **real runtime binaries** (pre-p3-e2e, no credentials): a real master
 * (Postgres + BullMQ on Redis) in-process, real worker daemons over the WebSocket transport with the
 * production job wiring (runtime registry → real Pi / OpenCode adapters, runtime-policy + capability
 * gate, sandbox selection, per-attempt git view, worker commit with the attempt trailer + pre-push secret
 * scan + push with force-with-lease to a local bare repository), and the runtimes' scripted model
 * providers from the adapters' own real-binary suites:
 *  - Pi: `packages/agent-adapters/test/fixtures/pi/faux-provider.mjs` (Pi's built-in faux provider);
 *  - OpenCode: `packages/agent-adapters/test/fixtures/opencode/fake-provider.mjs` (OpenAI-compatible
 *    server on 127.0.0.1).
 *
 * Opt-in per runtime (docs/ops/runtime-setup.md "Running the real-binary suites"):
 *   REMYRAL_PI_BIN=<prefix>/node_modules/.bin/pi                       (Pi 1.1.0)
 *   REMYRAL_OPENCODE_BIN=<prefix>/node_modules/opencode-<os>-<arch>/bin/opencode   (OpenCode 1.19.0)
 * The Pi container case additionally needs a reachable Docker with `remyral/runtime-pi:0.1.0` and
 * `remyral/egress-proxy:0.1.0` built (`node infra/worker/images/build.mjs`); set REMYRAL_SKIP_DOCKER_TESTS=1
 * to skip it.
 */

const PI_BIN = process.env.REMYRAL_PI_BIN ?? '';
const OC_BIN = process.env.REMYRAL_OPENCODE_BIN ?? '';
const FIXTURES = new URL('../../../../packages/agent-adapters/test/fixtures/', import.meta.url);
const PI_FAUX = fileURLToPath(new URL('pi/faux-provider.mjs', FIXTURES));
const OC_PROVIDER = fileURLToPath(new URL('opencode/fake-provider.mjs', FIXTURES));
const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 12;
/** p4-git-flow: a pushed change is verified on the remote → AWAITING_APPROVAL (merge); no change → SUCCEEDED. */
const DONE = ['SUCCEEDED', 'VERIFYING', 'AWAITING_APPROVAL'];

function dockerReady(): boolean {
  if (process.env.REMYRAL_SKIP_DOCKER_TESTS === '1') return false;
  try {
    for (const image of ['remyral/runtime-pi:0.1.0', 'remyral/egress-proxy:0.1.0']) {
      execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 10_000 });
    }
    return true;
  } catch {
    return false;
  }
}

interface Detail {
  job: { id: string; state: string; currentAttemptId: string | null };
  transitions: { trigger: string; to: string; reason: string | null }[];
  orchestration?: {
    schedule: { status: string; reasons: { code: string; message: string }[] } | null;
    runs: { attemptId: string; lastPhase: string | null; resultOutcome: string | null }[];
  };
}

const describeRuntimes = PI_BIN === '' && OC_BIN === '' ? describe.skip : describeIntegration;

describeRuntimes('worker job runner with real runtimes (integration)', { timeout: 300_000 }, () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  let fileUrl: string;
  let bare: string;
  const dirs: string[] = [];
  const workers: RuntimeWorker[] = [];

  beforeAll(async () => {
    fileUrl = await createBareRepo(dirs);
    bare = fileURLToPath(fileUrl);
    const cacheDir = await mkdtemp(join(tmpdir(), 'rw-rt-gf-'));
    dirs.push(cacheDir);
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        redisUrl: redisUrlWithDb(HINT_DB),
        hintPrefix: `rt${String(Date.now())}`,
        tickIntervalMs: 100,
        timing: { leaseTtlMs: 60_000, reconnectGraceMs: 120_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
      },
      // The project is enrolled in git flow: ASSIGN_JOB carries pushResult and the master verifies the push.
      gitflow: {
        providers: () => new LocalGitProvider({ url: fileUrl, cacheDir, allowFileUrls: true }),
        timing: { refreshIntervalMs: 0 },
      },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    // The project opts in to host-native execution (ADR-0007 host-restricted needs it).
    await h.db.pool.query(
      `INSERT INTO projects (id, name, created_at, host_execution) VALUES ($1, $1, now(), true)
         ON CONFLICT (id) DO UPDATE SET host_execution = true`,
      [PROJECT],
    );
    const put = await admin.req('PUT', `/projects/${PROJECT}/git`, {
      expectedVersion: 0,
      provider: 'git',
      repositoryUrl: REPO_URL,
      baseBranch: 'main',
      mergeMethod: 'merge',
    });
    expect(put.statusCode, put.body).toBe(200);
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
  });
  afterAll(async () => {
    await h.stop();
    await removeDirs(dirs);
  });

  async function newWorker(opts: Omit<Parameters<typeof startRuntimeWorker>[2], 'fileUrl'>) {
    const dir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dir);
    const w = await startRuntimeWorker(url, dir, { fileUrl, ...opts });
    workers.push(w);
    await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 30_000 }).toBe(true);
    return { id, w };
  }

  async function stepUp(): Promise<void> {
    // Fresh step-up before the job (the clock jump for a new TOTP step must not age a lease).
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function submit(spec: Record<string, unknown>): Promise<string> {
    const res = await admin.req('POST', '/jobs', { project: PROJECT, spec });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ job: { id: string } }>().job.id;
  }

  async function detail(id: string): Promise<Detail> {
    return (await admin.req('GET', `/jobs/${id}`)).json<Detail>();
  }

  async function state(id: string): Promise<string> {
    const d = await detail(id);
    if (d.job.state === 'QUEUED' && d.orchestration?.schedule) {
      return `QUEUED ${JSON.stringify(d.orchestration.schedule.reasons.map((r) => `${r.code}: ${r.message}`))}`;
    }
    if (d.job.state === 'FAILED') {
      return `FAILED ${JSON.stringify(d.transitions.slice(-3).map((t) => `${t.trigger}: ${t.reason ?? ''}`))}`;
    }
    return d.job.state;
  }

  async function inbox(jobId: string) {
    const { rows } = await h.db.pool.query<{
      type: string;
      outcome: string;
      payload: { event?: { kind: string; phase?: string }; commits?: { sha: string; branch: string }[] };
    }>('SELECT type, outcome, payload FROM worker_inbox WHERE job_id = $1 ORDER BY id', [jobId]);
    return rows;
  }

  async function pendingApproval(jobId: string): Promise<string> {
    let id: string | undefined;
    await expect
      .poll(
        async () => {
          id = (await admin.req('GET', '/approvals?status=pending'))
            .json<{ items: { id: string; jobId: string }[] }>()
            .items.find((r) => r.jobId === jobId)?.id;
          return id;
        },
        { timeout: 90_000, interval: 250 },
      )
      .toBeDefined();
    return id ?? '';
  }

  const gitBare = (...args: string[]) =>
    execFileSync('git', ['--git-dir', bare, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

  /** The pushed attempt commit: trailer, author and (optionally) a file the agent wrote. */
  async function expectPushed(jobId: string, file?: { path: string; content: string }) {
    const result = (await inbox(jobId)).find((r) => r.type === 'JOB_RESULT');
    expect(result?.outcome).toBe('applied');
    const commit = result?.payload.commits?.[0];
    const d = await detail(jobId);
    expect(commit?.branch).toBe(`rac/${jobId}/${d.job.currentAttemptId ?? ''}`);
    expect(gitBare('rev-parse', commit?.branch ?? '')).toBe(commit?.sha);
    const message = gitBare('log', '-1', '--format=%an <%ae>%n%B', commit?.sha ?? '');
    expect(message).toContain('Remyral Agent <agent@remyral.invalid>');
    expect(message).toMatch(new RegExp(`Remyral-Attempt: ${d.job.currentAttemptId ?? ''}/\\d+`));
    if (file !== undefined) expect(gitBare('show', `${commit?.sha ?? ''}:${file.path}`)).toBe(file.content);
    expect((await inbox(jobId)).some((r) => r.type === 'ARTIFACT_REF' && r.outcome === 'applied')).toBe(true);
  }

  describe.skipIf(PI_BIN === '')('Pi 1.1.0 (real binary, faux provider)', () => {
    const pi = { binary: PI_BIN, model: 'remyral-faux/scripted', extensions: [PI_FAUX] };
    const sandbox = process.platform === 'darwin' ? ('host' as const) : ('none' as const);

    it('repository edit with an approval round trip: submit → running → approval → commit pushed → done', async () => {
      await stepUp();
      const { w } = await newWorker({ runtime: 'pi', settings: pi, sandbox });
      const jobId = await submit(jobSpec({ runtime: 'pi', prompt: 'faux:approval' }));
      await expect.poll(() => state(jobId), { timeout: 60_000 }).toBe('RUNNING');
      const approvalId = await pendingApproval(jobId);
      expect((await detail(jobId)).orchestration?.runs[0]?.lastPhase).toBe('waiting_approval');
      const res = await admin.req('POST', `/approvals/${approvalId}/approve`, { reason: 'ok' });
      expect(res.statusCode, res.body).toBe(200);
      await expect.poll(() => state(jobId), { timeout: 120_000 }).toSatisfy((s: string) => DONE.includes(s));
      const kinds = (await inbox(jobId)).filter((r) => r.type === 'EVENT').map((r) => r.payload.event?.kind);
      expect(kinds).toEqual(
        expect.arrayContaining(['status', 'message', 'tool_call', 'tool_result', 'approval_request']),
      );
      await expectPushed(jobId, { path: 'approved.txt', content: 'approved' });
      // Host profile: the runtime ran confined (Seatbelt on macOS) and the attempt state was per-attempt.
      if (sandbox === 'host') {
        expect(w.lines.some((l) => l.msg === 'declining job')).toBe(false);
      }
    });

    it('plain run reads the repository and still pushes one trailer commit', async () => {
      await newWorker({ runtime: 'pi', settings: pi, sandbox });
      const jobId = await submit(jobSpec({ runtime: 'pi', prompt: 'summarise the readme' }));
      // No file change: the master verifies the pushed trailer commit; nothing to merge → SUCCEEDED.
      await expect.poll(() => state(jobId), { timeout: 120_000 }).toBe('SUCCEEDED');
      await expectPushed(jobId);
    });

    it('cancel mid-run stops the real runtime through the adapter → CANCELLED, nothing pushed', async () => {
      const { w } = await newWorker({ runtime: 'pi', settings: pi, sandbox });
      const jobId = await submit(jobSpec({ runtime: 'pi', prompt: 'faux:long' }));
      await expect.poll(() => state(jobId), { timeout: 60_000 }).toBe('RUNNING');
      const res = await admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'no longer needed' });
      expect(res.statusCode).toBe(200);
      await expect.poll(() => state(jobId), { timeout: 60_000 }).toBe('CANCELLED');
      expect(w.runner.activeCount).toBe(0);
      const d = await detail(jobId);
      expect(() =>
        gitBare('rev-parse', '--verify', `refs/heads/rac/${jobId}/${d.job.currentAttemptId ?? ''}`),
      ).toThrow();
    });

    it.skipIf(!dockerReady())(
      'container profile: the pinned Pi image runs the job, edit pushed',
      async () => {
        await stepUp();
        await newWorker({
          runtime: 'pi',
          settings: pi,
          sandbox: 'container',
          containerImages: { pi: 'remyral/runtime-pi:0.1.0' },
        });
        const jobId = await submit(
          jobSpec({
            runtime: 'pi',
            prompt: 'faux:approval',
            sandboxProfile: 'container',
            sourceTrust: 'untrusted',
          }),
        );
        const approvalId = await pendingApproval(jobId);
        expect(
          (await admin.req('POST', `/approvals/${approvalId}/approve`, { reason: 'ok' })).statusCode,
        ).toBe(200);
        await expect
          .poll(() => state(jobId), { timeout: 180_000 })
          .toSatisfy((s: string) => DONE.includes(s));
        await expectPushed(jobId, { path: 'approved.txt', content: 'approved' });
      },
    );
  });

  describe.skipIf(OC_BIN === '')('OpenCode 1.19.0 (real binary, scripted OpenAI-compatible provider)', () => {
    let provider: ChildProcess | undefined;
    let port = 0;
    beforeAll(async () => {
      provider = spawn(process.execPath, [OC_PROVIDER], { stdio: ['ignore', 'pipe', 'inherit'] });
      port = await new Promise<number>((resolve) => {
        provider?.stdout?.once('data', (d: Buffer) => {
          resolve(Number(d.toString().trim()));
        });
      });
    });
    afterAll(() => {
      provider?.kill('SIGKILL');
    });
    const oc = () => ({
      binary: OC_BIN,
      model: 'fake/scripted',
      extensions: [],
      config: {
        provider: {
          fake: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Scripted',
            options: { baseURL: `http://127.0.0.1:${String(port)}/v1`, apiKey: '{env:REMYRAL_UNUSED_KEY}' },
            models: { scripted: { name: 'Scripted' } },
          },
        },
      },
    });

    it('repository edit with an approval round trip → commit pushed → done', async () => {
      await stepUp();
      await newWorker({ runtime: 'opencode', settings: oc(), sandbox: 'none' });
      const jobId = await submit(jobSpec({ runtime: 'opencode', prompt: 'faux:approval' }));
      const approvalId = await pendingApproval(jobId);
      expect((await admin.req('POST', `/approvals/${approvalId}/approve`, { reason: 'ok' })).statusCode).toBe(
        200,
      );
      await expect.poll(() => state(jobId), { timeout: 120_000 }).toSatisfy((s: string) => DONE.includes(s));
      await expectPushed(jobId, { path: 'approved.txt', content: 'approved' });
    });

    it('cancel mid-run → CANCELLED', async () => {
      const { w } = await newWorker({ runtime: 'opencode', settings: oc(), sandbox: 'none' });
      const jobId = await submit(jobSpec({ runtime: 'opencode', prompt: 'faux:long' }));
      await expect.poll(() => state(jobId), { timeout: 60_000 }).toBe('RUNNING');
      expect((await admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'stop' })).statusCode).toBe(200);
      await expect.poll(() => state(jobId), { timeout: 60_000 }).toBe('CANCELLED');
      expect(w.runner.activeCount).toBe(0);
    });
  });
});
