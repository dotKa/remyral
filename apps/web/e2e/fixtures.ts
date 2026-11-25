import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { loadE2eEnv, MASTER_ORIGIN } from './env';
import { Authenticator } from './totp';

/**
 * Test-setup helpers. Users are created through the master's own programmatic API (`createUser` from
 * apps/master/src/cli/admin.ts, the function behind `admin:create`), against the throw-away e2e database
 * only. The interactive CLI stays TTY-only; nothing here weakens it.
 */

interface MasterPool {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}
interface MasterRedis {
  connect(): Promise<void>;
  flushdb(): Promise<unknown>;
  disconnect(): void;
}
interface MasterModules {
  createPool(opts: { connectionString: string; max?: number }): MasterPool;
  createRedis(url: string, connectionName?: string): MasterRedis;
  AuditLog: new (pool: MasterPool) => unknown;
  createUser(
    deps: { pool: MasterPool; audit: unknown },
    input: { username: string; role: string; password: string },
  ): Promise<string>;
}

async function masterModules(): Promise<MasterModules> {
  const dist = new URL('../../master/dist/', import.meta.url);
  const [pool, audit, admin, redis] = (await Promise.all([
    import(new URL('db/pool.js', dist).href),
    import(new URL('audit/audit.js', dist).href),
    import(new URL('cli/admin.js', dist).href),
    import(new URL('redis.js', dist).href),
  ])) as [
    Pick<MasterModules, 'createPool'>,
    Pick<MasterModules, 'AuditLog'>,
    Pick<MasterModules, 'createUser'>,
    Pick<MasterModules, 'createRedis'>,
  ];
  return {
    createPool: pool.createPool,
    AuditLog: audit.AuditLog,
    createUser: admin.createUser,
    createRedis: redis.createRedis,
  };
}

/**
 * Clears the master's rate-limit counters in the dedicated e2e Redis DB. All e2e traffic comes from
 * 127.0.0.1, so without this the per-IP limit (30 / 15 min) would make later tests flaky. Rate limiting
 * itself is covered by the master's integration tests and by the web unit tests (429 rendering).
 */
export async function resetRateLimits(): Promise<void> {
  const env = loadE2eEnv();
  const m = await masterModules();
  const redis = m.createRedis(env.redisUrl, 'remyral-web-e2e');
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

export interface TestAdmin {
  readonly username: string;
  readonly password: string;
}

/** Creates an owner account (no TOTP yet) with a unique name and a random 24-char password. */
export async function createTestAdmin(prefix = 'e2e'): Promise<TestAdmin> {
  const env = loadE2eEnv();
  const m = await masterModules();
  const pool = m.createPool({ connectionString: env.databaseUrl, max: 1 });
  const username = `${prefix}-${randomBytes(4).toString('hex')}`;
  const password = `Pw-${randomBytes(18).toString('base64url')}`;
  try {
    await m.createUser({ pool, audit: new m.AuditLog(pool) }, { username, role: 'owner', password });
  } finally {
    await pool.end();
  }
  return { username, password };
}

/** Minimal cookie-keeping client that talks to the master directly (not through the browser). */
class MasterClient {
  private readonly cookies = new Map<string, string>();

  async post(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'user-agent': 'remyral-web-e2e-setup' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const csrf = this.cookies.get('__Host-ras-csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
    headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${MASTER_ORIGIN}${path}`, {
      method: 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair = ''] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === '' || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    if (!res.ok) throw new Error(`setup request ${path} failed with HTTP ${String(res.status)}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async get(path: string): Promise<unknown> {
    const res = await fetch(`${MASTER_ORIGIN}${path}`, {
      headers: {
        'user-agent': 'remyral-web-e2e-setup',
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
    });
    if (!res.ok) throw new Error(`setup request ${path} failed with HTTP ${String(res.status)}`);
    return res.json();
  }
}

export interface EnrolledAdmin extends TestAdmin {
  readonly authenticator: Authenticator;
  readonly recoveryCodes: readonly string[];
}

/** Creates an admin and completes TOTP enrollment through the API (for tests that start at login). */
export async function createEnrolledAdmin(prefix = 'e2e'): Promise<EnrolledAdmin> {
  const admin = await createTestAdmin(prefix);
  const c = new MasterClient();
  await c.post('/auth/login', { username: admin.username, password: admin.password });
  const start = await c.post('/auth/totp/enroll/start');
  const authenticator = new Authenticator(String(start.secret));
  const confirm = await c.post('/auth/totp/enroll/confirm', { code: await authenticator.nextCode() });
  await c.post('/auth/logout');
  return { ...admin, authenticator, recoveryCodes: confirm.recoveryCodes as string[] };
}

/**
 * p15-classic-removal: signs an enrolled admin in through the Diyalog sign-in steps (Turkish: a new account's
 * language) and waits until the console is open. `tap` uses touch (mobile projects).
 */
export async function signInWithCode(
  page: Page,
  admin: EnrolledAdmin,
  opts: { readonly tap?: boolean } = {},
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Kullanıcı adı').fill(admin.username);
  await page.getByLabel('Parola', { exact: true }).fill(admin.password);
  const go = page.getByRole('button', { name: 'Devam et' });
  await (opts.tap === true ? go.tap() : go.click());
  await page.getByLabel('6 haneli kod').fill(await admin.authenticator.nextCode());
  const verify = page.getByRole('button', { name: 'Doğrula' });
  // A code filled in one go submits itself (one-time-code autofill); press only while the step is still there.
  if (await verify.isVisible().catch(() => false))
    await (opts.tap === true ? verify.tap() : verify.click()).catch(() => undefined);
  await page.waitForURL((u) => u.pathname !== '/login');
}

/**
 * p5-live: a job (DRAFT, created through the master's JobStore) with one attempt and the given log
 * chunks stored the way the live view stores them. Throw-away e2e database only.
 */
export async function createJobWithLogs(
  texts: readonly string[],
  opts: { readonly workerId?: string } = {},
): Promise<string> {
  const workerId = opts.workerId ?? 'e2e-worker';
  const env = loadE2eEnv();
  const dist = new URL('../../master/dist/', import.meta.url);
  const m = await masterModules();
  const { JobStore } = (await import(new URL('jobs/store.js', dist).href)) as {
    JobStore: new (deps: { pool: MasterPool; audit: unknown; clock: () => Date }) => {
      create(input: Record<string, unknown>): Promise<{ job: { id: string } }>;
    };
  };
  const pool = m.createPool({ connectionString: env.databaseUrl, max: 1 });
  try {
    const store = new JobStore({ pool, audit: new m.AuditLog(pool), clock: () => new Date() });
    const { job } = await store.create({
      project: 'e2e',
      spec: {
        projectId: 'e2e',
        runtime: 'codex',
        prompt: 'live view e2e',
        repository: { url: 'https://git.example.test/e2e/app.git', baseRef: 'main', workBranch: 'w' },
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
      },
      actor: { type: 'system', id: 'e2e' },
    });
    const attempt = randomUUID();
    await pool.query(
      `INSERT INTO job_attempts (id, job_id, number, worker_id, state, started_at)
       VALUES ($1, $2, 1, $3, 'active', now())`,
      [attempt, job.id, workerId],
    );
    let seq = 0;
    for (const text of texts) {
      seq += 1;
      await pool.query(
        `INSERT INTO job_live_heads (job_id, head) VALUES ($1, $2)
         ON CONFLICT (job_id) DO UPDATE SET head = EXCLUDED.head`,
        [job.id, seq],
      );
      await pool.query(
        `INSERT INTO job_log_chunks (job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq, message_id,
                                     stream, chunk_seq, stream_seq, ts, received_at, text, size_bytes)
         VALUES ($1, $2, 1, 1, $6, $3, $4, 'stdout', $3, $3, now(), now(), $5, length($5))`,
        [job.id, attempt, seq, randomUUID(), text, workerId],
      );
    }
    return job.id;
  } finally {
    await pool.end();
  }
}

/**
 * p9-files-image-preview: a finished job of the built-in work area `genel` with stored output files, written
 * straight into `job_artifacts` (as the master's ARTIFACT_REF commit leaves them).
 */
export async function createWorkspaceJobWithFiles(
  files: readonly { readonly name: string; readonly mediaType: string; readonly content: Buffer }[],
): Promise<string> {
  const env = loadE2eEnv();
  const dist = new URL('../../master/dist/', import.meta.url);
  const m = await masterModules();
  const { JobStore } = (await import(new URL('jobs/store.js', dist).href)) as {
    JobStore: new (deps: { pool: MasterPool; audit: unknown; clock: () => Date }) => {
      create(input: Record<string, unknown>): Promise<{ job: { id: string } }>;
    };
  };
  const pool = m.createPool({ connectionString: env.databaseUrl, max: 1 });
  try {
    const store = new JobStore({ pool, audit: new m.AuditLog(pool), clock: () => new Date() });
    const { job } = await store.create({
      project: 'genel',
      spec: {
        runtime: 'codex',
        prompt: 'Draw a hero image',
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
      },
      actor: { type: 'system', id: 'e2e' },
    });
    const attempt = randomUUID();
    for (const f of files) {
      await pool.query(
        `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                    redacted, content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'output', false, $8, now())`,
        [
          attempt,
          job.id,
          `ws-${f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          f.name,
          f.mediaType,
          f.content.length,
          createHash('sha256').update(f.content).digest('hex'),
          f.content,
        ],
      );
    }
    return job.id;
  } finally {
    await pool.end();
  }
}

type RowPool = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

/** p5-mobile: runs queries against the throw-away e2e database. */
export async function withE2ePool<T>(fn: (pool: RowPool) => Promise<T>): Promise<T> {
  const env = loadE2eEnv();
  const m = await masterModules();
  const pool = m.createPool({ connectionString: env.databaseUrl, max: 1 }) as MasterPool & RowPool;
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * p5-mobile: makes the sessions of `username` look as if the last authenticator code was entered 11 minutes
 * ago (the step-up window is 10), so the next privileged action asks for a fresh code — the state of a phone
 * user who signed in a while ago. Throw-away e2e database only.
 */
export async function ageStepUp(username: string): Promise<void> {
  await withE2ePool(async (pool) => {
    await pool.query(
      `UPDATE sessions SET mfa_at = now() - interval '11 minutes'
        WHERE user_id = (SELECT id FROM users WHERE username = $1) AND stage = 'full'`,
      [username],
    );
  });
}

export interface FakeWorker {
  readonly id: string;
  readonly spawned: () => readonly string[];
  stop(): Promise<void>;
}

/**
 * p5-mobile (A-UX-1): starts `e2e/fake-worker.mjs` (a real worker daemon with the fake runtime, from the
 * built packages) and pairs it the way an admin does: login with TOTP, step-up, approve with the pairing
 * code the worker printed. Returns once the daemon is connected.
 */
export async function startFakeWorker(
  admin: EnrolledAdmin,
  opts: { readonly project: string; readonly repoUrl: string },
): Promise<FakeWorker> {
  const dataDir = await mkdtemp(join(tmpdir(), 'rw-e2e-mobile-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('fake-worker.mjs', import.meta.url))], {
    env: {
      PATH: process.env.PATH,
      HOME: dataDir,
      FAKE_WORKER: JSON.stringify({
        masterUrl: MASTER_ORIGIN.replace(/^http/, 'ws'),
        dataDir,
        project: opts.project,
        repoUrl: opts.repoUrl,
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  let buf = '';
  const waiters: { ev: string; resolve: (l: Record<string, unknown>) => void }[] = [];
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        lines.push(ev);
        for (const w of waiters.filter((x) => x.ev === ev.ev)) w.resolve(ev);
      } catch {
        // not a protocol line
      }
    }
  });
  child.stderr.on('data', (d: Buffer) => stderr.push(d.toString('utf8')));
  const waitFor = (ev: string, ms: number) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const hit = lines.find((l) => l.ev === ev);
      if (hit) {
        resolve(hit);
        return;
      }
      const t = setTimeout(() => {
        reject(
          new Error(
            `fake worker: no "${ev}" within ${String(ms)} ms: ${JSON.stringify(lines)} ${stderr.join('').slice(-2000)}`,
          ),
        );
      }, ms);
      waiters.push({
        ev,
        resolve: (l) => {
          clearTimeout(t);
          resolve(l);
        },
      });
      child.once('exit', () => {
        clearTimeout(t);
        reject(new Error(`fake worker exited: ${JSON.stringify(lines)} ${stderr.join('').slice(-2000)}`));
      });
    });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(t);
    }
    await rm(dataDir, { recursive: true, force: true });
  };
  try {
    const pairing = await waitFor('pairing', 30_000);
    const c = new MasterClient();
    await c.post('/auth/login', { username: admin.username, password: admin.password });
    await c.post('/auth/totp/verify', { code: await admin.authenticator.nextCode() });
    const list = (await c.get('/workers')) as { workers: { id: string; fingerprint: string }[] };
    const pending = list.workers.find((w) => w.fingerprint === pairing.fingerprint);
    if (pending === undefined) throw new Error('paired worker is not listed as pending');
    await c.post(`/workers/${pending.id}/approve`, { pairingCode: pairing.code });
    await c.post('/auth/logout');
    await waitFor('ready', 30_000);
    return {
      id: pending.id,
      spawned: () => lines.filter((l) => l.ev === 'spawn').map((l) => String(l.jobId)),
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
