import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { createMasterApp } from '../../../src/compose.js';
import { createPool, type Pool } from '../../../src/db/pool.js';
import { LocalGitProvider } from '../../../src/gitflow/local-provider.js';
import type { OrchestratorTiming } from '../../../src/orchestration/orchestrator.js';
import type { WorkerFeature } from '@remyral/protocol';
import { LeaseSigner } from '../../../src/orchestration/lease-signer.js';
import { createRedis, type RedisClient } from '../../../src/redis.js';
import { createTestDatabase, uniquePrefix } from '../../helpers/env.js';
import { type Client, enroll, FAST_SCRYPT, fullLogin, Harness } from '../../helpers/harness.js';
import {
  createBareRepo,
  type JobWorker,
  jobSpec,
  PROJECT,
  REPO_URL,
  startJobWorker,
} from '../../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../../helpers/real-worker.js';
import { ChaosAdapter, SpawnLedger } from './adapter.js';
import { attemptCommits, checkInvariants, type InvariantOptions } from './invariants.js';

export const PW = 'quartz-meadow-lantern-7';
export const LEASE_TTL_MS = 600_000;
export const GRACE_MS = 1_200_000;

export interface ChaosConfig {
  /** Redis for the master's own client (rate limits, readiness); default: the dev stack's. */
  readonly redisUrl?: string;
  /** Redis for BullMQ delivery hints (a dedicated logical DB or a throw-away container). */
  readonly hintRedisUrl: string;
  /** Postgres server to create the throw-away database on (default: the dev stack's). */
  readonly adminDatabaseUrl?: string;
  readonly timing?: Partial<OrchestratorTiming>;
  /** Background relay/reconciliation loop period (0: tests drive tick()). */
  readonly tickIntervalMs?: number;
}

export interface InProcessWorker {
  readonly kind: 'in-process';
  readonly id: string;
  readonly tag: string;
  readonly dir: string;
  w: JobWorker;
  adapter: ChaosAdapter;
  /** p11-master-resilience: how the worker was started (kept across in-process restarts). */
  readonly opts?: WorkerOptions;
}

/** p11-master-resilience: extra worker settings for the outage scenarios. */
export interface WorkerOptions {
  readonly features?: readonly WorkerFeature[];
  /** The runner's lease clock (the outage scenarios tie it to the master's fake clock). */
  readonly leaseClock?: () => number;
  /** Connect through this URL (e.g. a CuttableProxy) instead of the master's own. */
  readonly url?: () => string;
}

/** A worker daemon in its own OS process (fixtures/worker-process.mjs) — SIGKILL is a real crash. */
export class ProcessWorker {
  readonly kind = 'process';
  readonly lines: Record<string, unknown>[] = [];
  readonly stderr: string[] = [];
  child: ChildProcess | null = null;

  constructor(
    readonly id: string,
    readonly tag: string,
    readonly dir: string,
    private readonly env: Record<string, unknown>,
    private readonly ledger: SpawnLedger,
  ) {}

  start(mode: 'normal' | 'drop-result' | 'stall-seq' = 'normal'): void {
    const fixture = fileURLToPath(new URL('../fixtures/worker-process.mjs', import.meta.url));
    const child = spawn(process.execPath, [fixture], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: {
        PATH: process.env.PATH,
        HOME: this.dir,
        CHAOS_WORKER: JSON.stringify({ ...this.env, dataDir: this.dir, tag: this.tag, mode }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          this.lines.push(ev);
          if (ev.ev === 'spawn') {
            this.ledger.spawns.push({
              worker: this.tag,
              jobId: String(ev.jobId),
              attemptId: String(ev.attemptId),
            });
          }
        } catch {
          // not ours
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => this.stderr.push(d.toString('utf8')));
    this.child = child;
  }

  has(ev: string, pred: (l: Record<string, unknown>) => boolean = () => true): boolean {
    return this.lines.some((l) => l.ev === ev && pred(l));
  }

  /** SIGKILL: no shutdown code runs, nothing is flushed or reported. */
  async kill(): Promise<void> {
    const child = this.child;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
    this.child = null;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(t);
    this.child = null;
  }
}

/**
 * Chaos cluster: a real master (Fastify + Postgres + BullMQ hints + git flow on a local bare repository)
 * that can be stopped and started again on the same database and port, plus in-process and out-of-process
 * worker daemons over the real WebSocket transport. The lease-signing key is shared across master restarts
 * (production reads it from LEASE_SIGNING_KEY_FILE).
 */
export class ChaosCluster extends Harness {
  readonly signer = LeaseSigner.ephemeral();
  readonly ledger = new SpawnLedger();
  readonly dirs: string[] = [];
  readonly inProcess: InProcessWorker[] = [];
  readonly processes: ProcessWorker[] = [];
  admin!: Client;
  secret!: string;
  fileUrl!: string;
  bare!: string;
  url = '';
  port = 0;
  #pool: Pool | null = null;
  /** p11-master-resilience: a master started on another database (a standby restore). */
  #databaseUrl: string | null = null;
  #loggedIn = false;
  #cfg!: ChaosConfig;
  #provider!: LocalGitProvider;
  readonly #hintPrefix = `c${randomUUID().slice(0, 8)}`;

  async boot(cfg: ChaosConfig): Promise<this> {
    this.#cfg = cfg;
    this.db = await createTestDatabase(
      cfg.adminDatabaseUrl === undefined ? {} : { adminUrl: cfg.adminDatabaseUrl },
    );
    this.fileUrl = await createBareRepo(this.dirs);
    this.bare = fileURLToPath(this.fileUrl);
    const cacheDir = await mkdtemp(join(tmpdir(), 'rw-chaos-cache-'));
    this.dirs.push(cacheDir);
    this.#provider = new LocalGitProvider({ url: this.fileUrl, cacheDir, allowFileUrls: true });
    await this.startMaster();
    await this.createUser('owner1', PW);
    ({ secret: this.secret } = await enroll(this, 'owner1', PW));
    this.admin = await fullLogin(this, 'owner1', PW, this.secret);
    this.#loggedIn = true;
    await this.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
      PROJECT,
      this.clock.now(),
    ]);
    const put = await this.admin.req('PUT', `/projects/${PROJECT}/git`, {
      expectedVersion: 0,
      provider: 'git',
      repositoryUrl: REPO_URL,
      baseBranch: 'main',
      mergeMethod: 'merge',
    });
    expect(put.statusCode, put.body).toBe(200);
    return this;
  }

  /** Starts a master instance (own pool and Redis client) on the cluster's database and port. */
  async startMaster(): Promise<FastifyInstance> {
    const cfg = this.#cfg;
    this.#pool = createPool({
      connectionString: this.#databaseUrl ?? this.db.url,
      max: 10,
      applicationName: 'remyral-chaos',
    });
    const redisUrl = cfg.redisUrl ?? process.env.REDIS_URL ?? '';
    this.redis = createRedis(redisUrl, 'remyral-chaos');
    await this.redis.connect().catch(() => undefined);
    this.app = await createMasterApp({
      pool: this.#pool,
      redis: this.redis,
      box: this.box,
      logLevel: process.env.CHAOS_LOG_LEVEL === 'debug' ? 'debug' : 'info',
      trustProxyHops: 0,
      bodyLimitBytes: 64 * 1024,
      logStream: this.logs,
      clock: this.clock.now,
      passwordParams: FAST_SCRYPT,
      rateLimitPrefix: uniquePrefix(),
      rateLimits: { perIp: 100_000, perAccount: 100_000, windowMs: 60_000 },
      workers: {
        connectRateLimit: { perIp: 100_000, windowMs: 60_000 },
        pairing: { perIp: 500 },
        sweepIntervalMs: 0,
      },
      orchestration: {
        signer: this.signer,
        redisUrl: cfg.hintRedisUrl,
        hintPrefix: this.#hintPrefix,
        tickIntervalMs: cfg.tickIntervalMs ?? 50,
        // Leases far longer than any real-time step (pairing and step-up advance the fake clock by 30 s
        // per TOTP step): the tests expire them on purpose with expireLeases()/pastGrace().
        timing: {
          leaseTtlMs: LEASE_TTL_MS,
          reconnectGraceMs: GRACE_MS,
          retryBackoffMs: 0,
          effectRetryAfterMs: 0,
          ...cfg.timing,
        },
      },
      gitflow: { providers: () => this.#provider, timing: { refreshIntervalMs: 0 } },
    });
    await this.app.ready();
    await this.app.listen({ host: '127.0.0.1', port: this.port });
    const address = this.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    this.port = address.port;
    this.url = `ws://127.0.0.1:${String(this.port)}`;
    if (this.#loggedIn) this.admin = this.rebind(this.admin);
    return this.app;
  }

  /** p11-master-resilience: the next `startMaster()` runs on this database (null: the cluster's own). */
  useDatabase(url: string | null): void {
    this.#databaseUrl = url;
  }

  /** Stops the master instance (graceful Fastify close: sockets get 1001, loops stop, pool ends). */
  async stopMaster(): Promise<void> {
    await this.app.close();
    this.redis.disconnect();
    await this.#pool?.end().catch(() => undefined);
    this.#pool = null;
  }

  /** The same browser session (cookies are rows in Postgres) against the current app instance. */
  rebind(c: Client): Client {
    const fresh = this.client();
    for (const [k, v] of c.cookies) fresh.cookies.set(k, v);
    return fresh;
  }

  async newWorker(tag: string, opts: WorkerOptions = {}): Promise<InProcessWorker> {
    const dir = await tempDataDir(this.dirs);
    const id = await pairRealWorker(this, this.url, this.admin, this.secret, dir);
    await this.#everySlotForNormalJobs(id);
    const adapter = new ChaosAdapter(tag, this.ledger);
    const w = await startJobWorker(opts.url?.() ?? this.url, dir, this.#workerOptions(adapter, opts));
    const worker: InProcessWorker = { kind: 'in-process', id, tag, dir, w, adapter, opts };
    this.inProcess.push(worker);
    await this.waitReported(id);
    return worker;
  }

  /**
   * p9-queue-priority keeps one slot per machine for urgent jobs (default 1). The chaos scenarios predate it and count on
   * every slot for normal jobs (two held jobs on one 2-slot worker), as the integration cluster does (reserve 0).
   */
  async #everySlotForNormalJobs(workerId: string): Promise<void> {
    await this.db.pool.query('UPDATE workers SET urgent_reserve = 0 WHERE id = $1', [workerId]);
  }

  #workerOptions(adapter: ChaosAdapter, opts: WorkerOptions): Parameters<typeof startJobWorker>[2] {
    return {
      fileUrl: this.fileUrl,
      adapter,
      ...(opts.features === undefined ? {} : { features: opts.features }),
      ...(opts.leaseClock === undefined ? {} : { leaseClock: opts.leaseClock }),
    };
  }

  /** In-process restart on the same data dir (after `w.kill()` or a stop): new store, adapter, socket. */
  async restartWorker(worker: InProcessWorker): Promise<void> {
    await worker.w.daemon.stop('restart').catch(() => undefined);
    worker.adapter = new ChaosAdapter(worker.tag, this.ledger);
    const opts = worker.opts ?? {};
    worker.w = await startJobWorker(
      opts.url?.() ?? this.url,
      worker.dir,
      this.#workerOptions(worker.adapter, opts),
    );
  }

  async newProcessWorker(
    tag: string,
    mode: Parameters<ProcessWorker['start']>[0] = 'normal',
    features?: readonly WorkerFeature[],
  ): Promise<ProcessWorker> {
    const dir = await tempDataDir(this.dirs);
    const id = await pairRealWorker(this, this.url, this.admin, this.secret, dir);
    await this.#everySlotForNormalJobs(id);
    const p = new ProcessWorker(
      id,
      tag,
      dir,
      {
        url: this.url,
        fileUrl: this.fileUrl,
        repoUrl: REPO_URL,
        project: PROJECT,
        ...(features === undefined ? {} : { features }),
      },
      this.ledger,
    );
    this.processes.push(p);
    p.start(mode);
    await this.waitReported(id);
    return p;
  }

  async waitReported(id: string): Promise<void> {
    await expect.poll(() => this.app.fleetSessions.hasReported(id), { timeout: 60_000 }).toBe(true);
  }

  async submit(prompt: string): Promise<string> {
    // The longest allowed wall time: the scenarios jump the master clock by lease TTLs and grace periods,
    // and the master's wall-time backstop (p4-quotas) must not be what ends a job.
    const spec = jobSpec({ prompt, limits: { maxDurationSec: 7 * 24 * 3600 } });
    const res = await this.admin.req('POST', '/jobs', { project: PROJECT, spec });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ job: { id: string } }>().job.id;
  }

  async job(id: string): Promise<{
    job: { id: string; state: string; leaseEpoch: number; currentAttemptId: string | null };
    transitions: {
      trigger: string;
      to: string;
      actor: { type: string; id: string | null };
      reason: string | null;
      epoch: number | null;
    }[];
    attempts: { id: string; number: number; workerId: string; outcome: string | null }[];
  }> {
    const res = await this.admin.req('GET', `/jobs/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  /** Job state straight from Postgres (works while the master is down). */
  async state(id: string): Promise<string> {
    const { rows } = await this.db.pool.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [
      id,
    ]);
    return rows[0]?.state ?? 'missing';
  }

  async stepUp(): Promise<void> {
    this.clock.advance(30_000);
    const res = await this.admin.req('POST', '/auth/step-up', { code: this.code(this.secret) });
    expect(res.statusCode, res.body).toBe(200);
  }

  /** Expire every lease: advance the master clock past the TTL and run one reconciliation pass. */
  async expireLeases(): Promise<void> {
    this.clock.advance(LEASE_TTL_MS + 1_000);
    await this.app.orchestrator.tick();
    await this.relogin();
  }

  /** Past the reconnect grace of LOST jobs (the reconciler then decides retry or fail). */
  async pastGrace(): Promise<void> {
    this.clock.advance(GRACE_MS + 1_000);
    await this.relogin();
  }

  /** A fresh login after a clock jump (the session idles out like any browser session would). */
  async relogin(): Promise<void> {
    this.admin = await fullLogin(this, 'owner1', PW, this.secret);
  }

  head(ref: string): string | null {
    try {
      return execFileSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${ref}`], {
        cwd: this.bare,
        env: { PATH: process.env.PATH, HOME: this.bare, GIT_CONFIG_NOSYSTEM: '1' },
        encoding: 'utf8',
      }).trim();
    } catch {
      return null;
    }
  }

  commitsOf(attemptId: string): string[] {
    return [
      ...new Set(
        attemptCommits(this.bare)
          .filter((c) => c.attempt === attemptId)
          .map((c) => c.sha),
      ),
    ];
  }

  connectedWorkers(): string[] {
    return [...this.inProcess, ...this.processes]
      .map((w) => w.id)
      .filter((id) => this.app.fleetSessions.isConnectedWorker(id));
  }

  /** Polls the shared invariant checker until it reports nothing (or fails with the remaining list). */
  async assertInvariants(opts: Omit<InvariantOptions, 'bareRepo' | 'connectedWorkers'> = {}): Promise<void> {
    await expect
      .poll(
        () =>
          checkInvariants(this.db.pool, {
            ...opts,
            bareRepo: this.bare,
            connectedWorkers: this.connectedWorkers(),
          }),
        { timeout: 60_000, interval: 250 },
      )
      .toEqual([]);
  }

  /**
   * Between scenarios of one file: dump the logs of a failed scenario, then stop every worker so the next
   * scenario's jobs land only on the workers it starts (their holds are per adapter).
   */
  async endScenario(name: string, failed: boolean): Promise<void> {
    if (failed) console.error(`chaos log: ${await this.dumpLogs(name)}`);
    await Promise.all(this.processes.splice(0).map((p) => p.kill()));
    await Promise.all(this.inProcess.splice(0).map((w) => w.w.stop().catch(() => undefined)));
  }

  override async stop(): Promise<void> {
    await Promise.all(this.processes.map((p) => p.kill()));
    await Promise.all(this.inProcess.map((w) => w.w.stop().catch(() => undefined)));
    // A boot that failed (e.g. Docker unavailable) leaves no master/database to clean up.
    if ((this as { db?: unknown }).db === undefined) return;
    await this.stopMaster().catch(() => undefined);
    await this.db.drop();
    await removeDirs(this.dirs);
  }

  /** Writes the master's log for a failed scenario next to the system temp dir (no secrets in it). */
  async dumpLogs(name: string): Promise<string> {
    const file = join(tmpdir(), `remyral-chaos-${name}-${String(Date.now())}.log`);
    const { rows } = await this.db.pool
      .query<{
        job_id: string;
        version: number;
        trigger: string;
        to_state: string;
        actor_type: string;
        reason: string | null;
      }>(
        `SELECT job_id, version, trigger, to_state, actor_type, reason FROM job_transitions ORDER BY job_id, version`,
      )
      .catch(() => ({ rows: [] }));
    const history = rows
      .map(
        (r) =>
          `${r.job_id.slice(0, 8)} v${String(r.version)} ${r.trigger} → ${r.to_state} (${r.actor_type}) ${r.reason ?? ''}`,
      )
      .join('\n');
    const workers = [
      ...this.inProcess.map(
        (w) => `--- worker ${w.tag} (${w.id})\n${w.w.lines.map((l) => JSON.stringify(l)).join('\n')}`,
      ),
      ...this.processes.map((p) => `--- process worker ${p.tag} (${p.id})\n${p.stderr.join('')}`),
    ].join('\n');
    await writeFile(file, `${history}\n\n${workers}\n\n${this.logs.text}`);
    return file;
  }
}

export type { RedisClient };
