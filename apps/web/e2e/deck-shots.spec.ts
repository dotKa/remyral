import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  createEnrolledAdmin,
  type EnrolledAdmin,
  type FakeWorker,
  resetRateLimits,
  startFakeWorker,
  withE2ePool as withE2ePoolRaw,
} from './fixtures';
import { translateDeep, translateSeed } from './deck-seed-en';

/**
 * Product screenshots (not part of any suite; run on demand): seeds a believable organisation into the throw-away
 * e2e database — four machines, three projects, jobs in every state, a chat conversation, usage, approvals, outputs and
 * an audit trail — and captures the Diyalog console in Turkish at 1600x1000 @2x (light, some also dark).
 * Output: DECK_SHOTS_DIR (default test-results/deck/ under apps/web). DECK_ONLY=05,06 limits the shots taken.
 * p17-remyral-brand: DECK_LOCALE=en takes the set with the console in English (user locale en, browser en-US; the
 * demo data in English, e2e/deck-seed-en.ts), DECK_VIEWPORT=1440x900 another window size, DECK_ALL_DARK=1 every shot in dark too
 * (`-dark` suffix; the deck set has dark variants of 01/04/05/06 only), DECK_LOGIN=1 adds the signed-out 00-login.
 * Demo data: five projects (customer-portal, marketing-site, mobile-app and the work areas content-studio and
 * market-research). The product tour follows ONE job ("Fatura ekranına PDF dışa aktarma ekle"): the chat draft (02),
 * the live job (05, running), its machine (06), then a last test moves it to the merge decision (09) and filters the
 * audit trail on it (15). The weekly content calendar is a real engine-2 workflow run: defined and started through the
 * API, its step jobs (Claude Code plans, writes and reviews; Codex only generates the images) are finished in the
 * database, so the engine itself stops the run at the human approval step (16). 17: the research job's outputs.
 * Engine 2 is behind its flag (ADR-0055): run with WORKFLOW_ENGINE_V2=true (the e2e master inherits the environment),
 * e.g. `WORKFLOW_ENGINE_V2=true DECK_SHOTS_DIR=… pnpm --filter @remyral/web exec playwright test e2e/deck-shots.spec.ts
 * --project=dev`; without it 16 is skipped and 08 cannot instantiate its template.
 */
const OUT = process.env.DECK_SHOTS_DIR ?? 'test-results/deck/';
const ONLY = process.env.DECK_ONLY?.split(',') ?? null;
const want = (n: string): boolean => ONLY === null || ONLY.includes(n);
const EN = process.env.DECK_LOCALE === 'en';
const [VW, VH] = (process.env.DECK_VIEWPORT ?? '1600x1000').split('x').map(Number);
const ALL_DARK = process.env.DECK_ALL_DARK === '1';
/** A UI label in the console language of this run. */
const L = (tr: string, en: string): string => (EN ? en : tr);
/** Seeded demo text in the language of this run (deck-seed-en.ts: the English organisation). */
const tx = (s: string): string => (EN ? translateSeed(s) : s);
/**
 * The e2e pool; in an English run every query's text and parameters pass through the English seed, so the same seed
 * code writes the English organisation (job store and audit log included, they get this pool).
 */
type Queryable = {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  connect?: () => Promise<Queryable>;
};
/** `query` (and the clients `connect` hands out, for transactions) through the English seed. */
function translating<T extends Queryable>(target: T): T {
  return new Proxy(target, {
    get(t, key) {
      if (key === 'query')
        return (sql: string, params?: unknown[]) =>
          t.query(
            translateSeed(sql),
            params === undefined ? undefined : (translateDeep(params) as unknown[]),
          );
      if (key === 'connect' && typeof t.connect === 'function') {
        const connect = t.connect.bind(t);
        return async () => translating(await connect());
      }
      const v = Reflect.get(t, key, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}
const withE2ePool: typeof withE2ePoolRaw = (fn) =>
  withE2ePoolRaw((pool) =>
    EN ? fn(translating(pool as unknown as Queryable) as unknown as typeof pool) : fn(pool),
  );

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const wid = (): string => `wrk_${[...randomBytes(26)].map((b) => B32[b % 32] ?? 'a').join('')}`;
const sha = (s: string): string => createHash('sha1').update(s).digest('hex');
const ago = (min: number): Date => new Date(Date.now() - min * 60_000);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

test.describe.configure({ mode: 'serial', timeout: 900_000 });

const USERNAME = 'john.doe';
let admin: EnrolledAdmin;
let userId = '';

interface Machine {
  id: string;
  readonly project: string;
  readonly name: string;
  readonly os: 'linux' | 'darwin' | 'windows';
  readonly arch: 'x64' | 'arm64';
  readonly cpu: number;
  readonly memGb: number;
  readonly slots: number;
  readonly runtimes: readonly string[];
}
const M: Record<'build' | 'mac' | 'win' | 'gpu' | 'pi', Machine> = {
  build: {
    id: wid(),
    project: 'customer-portal',
    name: 'build-01',
    os: 'linux',
    arch: 'x64',
    cpu: 16,
    memGb: 64,
    slots: 4,
    runtimes: ['claude-code', 'codex'],
  },
  mac: {
    id: wid(),
    project: 'marketing-site',
    name: 'mac-studio',
    os: 'darwin',
    arch: 'arm64',
    cpu: 12,
    memGb: 32,
    slots: 3,
    runtimes: ['claude-code', 'codex', 'opencode'],
  },
  win: {
    id: wid(),
    project: 'mobile-app',
    name: 'win-ops-02',
    os: 'windows',
    arch: 'x64',
    cpu: 8,
    memGb: 32,
    slots: 2,
    runtimes: ['claude-code'],
  },
  gpu: {
    id: wid(),
    project: 'mobile-app',
    name: 'build-02',
    os: 'linux',
    arch: 'x64',
    cpu: 32,
    memGb: 128,
    slots: 6,
    runtimes: ['codex', 'claude-code'],
  },
  // The only machine whose allowlist has the content-studio work area; offline in the shots. Its offline state is
  // what keeps the content calendar's step jobs waiting in the queue (transient) instead of failing as infeasible, so
  // the spec can finish them in the database on mac-studio / build-02 before any worker process sees them.
  pi: {
    id: wid(),
    project: 'content-studio',
    name: 'pi-edge',
    os: 'linux',
    arch: 'arm64',
    cpu: 4,
    memGb: 8,
    slots: 1,
    runtimes: ['claude-code', 'codex'],
  },
};

interface SeedProject {
  readonly id: string;
  readonly name: string;
  /** Repository projects; absent: a work area (workspace project, no repository). */
  readonly repo?: string;
}
const P = {
  portal: {
    id: 'customer-portal',
    name: 'Müşteri Portalı',
    repo: 'https://git.example.com/acme/customer-portal.git',
  },
  site: {
    id: 'marketing-site',
    name: 'Pazarlama Sitesi',
    repo: 'https://git.example.com/acme/marketing-site.git',
  },
  mobile: {
    id: 'mobile-app',
    name: 'Mobil Uygulama',
    repo: 'https://git.example.com/acme/mobile-app.git',
  },
  content: { id: 'content-studio', name: 'İçerik Stüdyosu' },
  research: { id: 'market-research', name: 'Pazar Araştırması' },
} as const satisfies Record<string, SeedProject>;

type Pool = { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

interface JobStoreLike {
  create(input: Record<string, unknown>): Promise<{ job: { id: string } }>;
}
async function jobStore(pool: Pool, at: Date): Promise<JobStoreLike> {
  const dist = new URL('../../master/dist/', import.meta.url);
  const { JobStore } = (await import(new URL('jobs/store.js', dist).href)) as {
    JobStore: new (deps: { pool: unknown; audit: unknown; clock: () => Date }) => JobStoreLike;
  };
  const { AuditLog } = (await import(new URL('audit/audit.js', dist).href)) as {
    AuditLog: new (pool: unknown, clock?: () => Date) => unknown;
  };
  return new JobStore({ pool, audit: new AuditLog(pool, () => at), clock: () => at });
}

type Step = readonly [to: string, trigger: string, actor: 'user' | 'worker' | 'system', reason?: string];
const START: Step[] = [
  ['QUEUED', 'submit', 'user'],
  ['RESERVED', 'reserve', 'system'],
  ['STARTING', 'lease_acked', 'worker'],
  ['RUNNING', 'runtime_started', 'worker'],
];

interface SeedJob {
  readonly project: SeedProject;
  readonly title: string;
  readonly prompt: string;
  readonly runtime?: string;
  readonly machine: Machine;
  readonly startedMin: number;
  readonly stepMin?: number;
  readonly steps: readonly Step[];
  readonly logs?: readonly string[];
  readonly attemptOutcome?: 'succeeded' | 'failed' | null;
  readonly retryOn?: Machine;
}

async function seedJob(pool: Pool, j: SeedJob): Promise<{ id: string; attempt: string }> {
  const created = ago(j.startedMin + 1);
  const store = await jobStore(pool, created);
  const { job } = await store.create({
    project: j.project.id,
    spec: {
      projectId: j.project.id,
      title: j.title,
      runtime: j.runtime ?? 'claude-code',
      prompt: j.prompt,
      ...(j.project.repo === undefined
        ? { workspace: { egress: 'web' } }
        : {
            repository: {
              url: j.project.repo,
              baseRef: 'main',
              workBranch: `agent/${randomBytes(3).toString('hex')}`,
            },
          }),
      sandboxProfile: 'container',
      sourceTrust: 'trusted',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    },
    actor: { type: 'user', id: userId },
  });
  const step = (j.stepMin ?? 1.5) * 60_000;
  const t0 = created.getTime();
  let attempt = randomUUID();
  let attemptNo = 1;
  let machine = j.machine;
  await pool.query(
    `INSERT INTO job_attempts (id, job_id, number, worker_id, state, started_at) VALUES ($1, $2, 1, $3, 'active', $4)`,
    [attempt, job.id, machine.id, new Date(t0 + step * 2)],
  );
  for (const [i, [to, trigger, actor, reason]] of j.steps.entries()) {
    const at = new Date(t0 + (i + 1) * step);
    if (to === 'RETRY_WAIT' || (to === 'FAILED' && j.retryOn === undefined)) {
      await pool.query(`UPDATE job_attempts SET state = 'ended', outcome = $2, ended_at = $3 WHERE id = $1`, [
        attempt,
        to === 'RETRY_WAIT' ? 'retry' : 'failed',
        at,
      ]);
    }
    if (to === 'STARTING' && i > 4 && j.retryOn !== undefined) {
      attempt = randomUUID();
      attemptNo += 1;
      machine = j.retryOn;
      await pool.query(
        `INSERT INTO job_attempts (id, job_id, number, worker_id, state, started_at) VALUES ($1, $2, $3, $4, 'active', $5)`,
        [attempt, job.id, attemptNo, machine.id, at],
      );
    }
    const r = await pool.query(
      `UPDATE jobs SET state = $2, version = version + 1, state_changed_at = $3, updated_at = $3,
              current_attempt_id = $4, lease_epoch = $5 WHERE id = $1 RETURNING version`,
      [job.id, to, at, attempt, attemptNo],
    );
    await pool.query(
      `INSERT INTO job_transitions (job_id, version, from_state, to_state, trigger, actor_type, actor_id, reason,
                                    attempt_id, epoch, occurred_at)
       SELECT $1, $2, (SELECT to_state FROM job_transitions WHERE job_id = $1 ORDER BY version DESC LIMIT 1),
              $3, $4, $5, $6, $7, $8, $9, $10`,
      [
        job.id,
        Number(r.rows[0]?.version),
        to,
        trigger,
        actor,
        actor === 'worker' ? machine.id : actor === 'user' ? userId : null,
        reason ?? null,
        actor === 'worker' ? attempt : null,
        actor === 'worker' ? attemptNo : null,
        at,
      ],
    );
    if (to === 'SUCCEEDED' || (to === 'FAILED' && j.retryOn !== undefined)) {
      await pool.query(
        `UPDATE job_attempts SET state = 'ended', outcome = $2, ended_at = $3 WHERE id = $1 AND state <> 'ended'`,
        [attempt, to === 'SUCCEEDED' ? 'succeeded' : 'failed', at],
      );
    }
  }
  let seq = 0;
  for (const text of j.logs ?? []) {
    seq += 1;
    await pool.query(
      `INSERT INTO job_live_heads (job_id, head) VALUES ($1, $2) ON CONFLICT (job_id) DO UPDATE SET head = EXCLUDED.head`,
      [job.id, seq],
    );
    await pool.query(
      `INSERT INTO job_log_chunks (job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq, message_id,
                                   stream, chunk_seq, stream_seq, ts, received_at, text, size_bytes)
       VALUES ($1, $2, $7, $7, $6, $3, $4, 'stdout', $3, $3, $8, $8, $5, length($5))`,
      [job.id, attempt, seq, randomUUID(), text, machine.id, attemptNo, new Date(t0 + 3 * step + seq * 4000)],
    );
  }
  return { id: job.id, attempt };
}

/** One state change of a job: the jobs row (version + 1) and its job_transitions entry. */
async function transition(
  pool: Pool,
  t: {
    jobId: string;
    to: string;
    trigger: string;
    actor: 'user' | 'worker' | 'system';
    at: Date;
    attempt: string;
    attemptNo: number;
    worker: string;
  },
): Promise<void> {
  const r = await pool.query(
    `UPDATE jobs SET state = $2, version = version + 1, state_changed_at = $3, updated_at = $3,
            current_attempt_id = $4, lease_epoch = GREATEST(lease_epoch, $5) WHERE id = $1 RETURNING version`,
    [t.jobId, t.to, t.at, t.attempt, t.attemptNo],
  );
  await pool.query(
    `INSERT INTO job_transitions (job_id, version, from_state, to_state, trigger, actor_type, actor_id, reason,
                                  attempt_id, epoch, occurred_at)
     SELECT $1, $2, (SELECT to_state FROM job_transitions WHERE job_id = $1 ORDER BY version DESC LIMIT 1),
            $3, $4, $5, $6, NULL, $7, $8, $9`,
    [
      t.jobId,
      Number(r.rows[0]?.version),
      t.to,
      t.trigger,
      t.actor,
      t.actor === 'worker' ? t.worker : t.actor === 'user' ? userId : null,
      t.actor === 'worker' ? t.attempt : null,
      t.actor === 'worker' ? t.attemptNo : null,
      t.at,
    ],
  );
}

interface OutFile {
  readonly name: string;
  readonly content: Buffer;
}

const MEDIA: Readonly<Record<string, string>> = { md: 'text/markdown', csv: 'text/csv', png: 'image/png' };

/**
 * A workflow step job the engine created (QUEUED, no worker in the demo serves the work area) run to SUCCEEDED in the
 * database the way a worker leaves it: attempt on the given machine, log, result summary (what the engine reads as
 * the step output), output files and a usage record. The engine then advances the run on its next tick.
 */
async function finishStepJob(
  pool: Pool,
  jobId: string,
  f: {
    machine: Machine;
    summary: string;
    logs: readonly string[];
    files?: readonly OutFile[];
    model: string;
  },
): Promise<void> {
  const j = await pool.query(
    `SELECT state::text AS state, current_attempt_id, created_at, spec->>'runtime' AS runtime FROM jobs WHERE id = $1`,
    [jobId],
  );
  const row = j.rows[0];
  const created = new Date(String(row?.created_at)).getTime();
  let attempt = typeof row?.current_attempt_id === 'string' ? row.current_attempt_id : '';
  if (attempt === '') {
    attempt = randomUUID();
    await pool.query(
      `INSERT INTO job_attempts (id, job_id, number, worker_id, state, started_at) VALUES ($1, $2, 1, $3, 'active', $4)`,
      [attempt, jobId, f.machine.id, new Date(created + 500)],
    );
  } else {
    await pool.query(`UPDATE job_attempts SET worker_id = $2 WHERE id = $1`, [attempt, f.machine.id]);
  }
  const order: Step[] = [
    ['RESERVED', 'reserve', 'system'],
    ['STARTING', 'lease_acked', 'worker'],
    ['RUNNING', 'runtime_started', 'worker'],
    ['VERIFYING', 'run_finished', 'worker'],
    ['SUCCEEDED', 'verification_passed_no_approval', 'system'],
  ];
  const from = order.findIndex(([to]) => to === row?.state);
  const steps = order.slice(from + 1);
  const span = Math.max(1000, Date.now() - created - 200);
  for (const [i, [to, trigger, actor]] of steps.entries()) {
    const at = new Date(created + ((i + 1) * span) / steps.length);
    if (to === 'SUCCEEDED') {
      await pool.query(
        `INSERT INTO job_runs (attempt_id, job_id, worker_id, last_phase, result_outcome, result, result_epoch,
                               result_received_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'stopped', 'succeeded', $4, 1, $5, $6, $5) ON CONFLICT (attempt_id) DO UPDATE
           SET result_outcome = 'succeeded', result = EXCLUDED.result, result_received_at = EXCLUDED.result_received_at`,
        [
          attempt,
          jobId,
          f.machine.id,
          JSON.stringify({ outcome: 'succeeded', summary: f.summary }),
          at,
          new Date(created),
        ],
      );
      await pool.query(
        `UPDATE job_attempts SET state = 'ended', outcome = 'succeeded', ended_at = $2 WHERE id = $1`,
        [attempt, at],
      );
    }
    await transition(pool, { jobId, to, trigger, actor, at, attempt, attemptNo: 1, worker: f.machine.id });
  }
  let seq = 0;
  for (const text of f.logs) {
    seq += 1;
    await pool.query(
      `INSERT INTO job_live_heads (job_id, head) VALUES ($1, $2) ON CONFLICT (job_id) DO UPDATE SET head = EXCLUDED.head`,
      [jobId, seq],
    );
    await pool.query(
      `INSERT INTO job_log_chunks (job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq, message_id,
                                   stream, chunk_seq, stream_seq, ts, received_at, text, size_bytes)
       VALUES ($1, $2, 1, 1, $6, $3, $4, 'stdout', $3, $3, $7, $7, $5, length($5))`,
      [jobId, attempt, seq, randomUUID(), text, f.machine.id, new Date(created + 400 * seq)],
    );
  }
  if (f.files !== undefined) await seedOutputs(pool, jobId, f.files);
  const rt = String(row?.runtime);
  const inTok = 60_000 + Math.floor(Math.random() * 200_000);
  await pool.query(
    `INSERT INTO usage_records (job_id, attempt_id, worker_id, project, runtime, runtime_version, provider, model,
                                auth_mode, input_tokens, output_tokens, cache_read_tokens, turns, wall_time_ms,
                                cost_usd, provenance, source_event_id, payload_hash, recorded_at)
     SELECT $1, $2, $3, project, $4, '1.0', $5, $6, 'secret-ref', $7, $8, $9, 14, $10, $11, 'reported-by-runtime',
            $12, $13, now() FROM jobs WHERE id = $1`,
    [
      jobId,
      attempt,
      f.machine.id,
      rt,
      rt === 'codex' ? 'openai' : 'anthropic',
      f.model,
      inTok,
      Math.floor(inTok / 8),
      inTok * 2,
      span,
      (inTok / 1_000_000) * 3.2 + 0.05,
      `ev-${randomBytes(6).toString('hex')}`,
      createHash('sha256').update(randomUUID()).digest('hex'),
    ],
  );
}

const ids: Record<string, string> = {};
let threadId = '';

async function seedWorld(): Promise<void> {
  await withE2ePool(async (pool) => {
    const u = await pool.query('SELECT id FROM users WHERE username = $1', [USERNAME]);
    const uid = u.rows[0]?.id;
    userId = typeof uid === 'string' ? uid : '';
    // A set-up organisation: the first-run wizard is completed (no "Kurulumu tamamla" card in the shots).
    await pool.query(
      `INSERT INTO onboarding_state (id, organisation_name, steps, completed_at, updated_at)
       VALUES (1, 'Acme', '{}'::jsonb, now(), now())
       ON CONFLICT (id) DO UPDATE SET completed_at = now(), updated_at = now()`,
    );
    // Machines (DB-only, online, with runtimes).
    for (const m of Object.values(M)) {
      const winName = m.os === 'windows';
      await pool.query(
        `UPDATE workers SET display_name = $2, facts = $3, tools = $4, max_parallel_jobs = $5, load = $6,
                            worker_version = '1.0.64', last_ip = $7, created_at = now() - interval '40 days',
                            approved_at = now() - interval '40 days', connected_at = now() - interval '3 hours',
                            features = features || '["job-message-v1", "workspace-v1"]'::jsonb
          WHERE id = $1`,
        [
          m.id,
          m.name,
          JSON.stringify({
            os: m.os,
            osVersion: m.os === 'linux' ? 'Ubuntu 24.04' : m.os === 'darwin' ? '15.4' : '11',
            arch: m.arch,
            hostname: m.name,
            cpuCount: m.cpu,
            memoryBytes: m.memGb * 1024 ** 3,
            diskFreeBytes: 380 * 1024 ** 3,
          }),
          JSON.stringify([
            { name: 'git', version: '2.47' },
            { name: 'node', version: '22.11' },
            { name: 'docker', version: '27.3' },
            ...(winName ? [] : [{ name: 'python', version: '3.12' }]),
          ]),
          m.slots,
          JSON.stringify({
            cpuPercent: 18 + Math.floor(Math.random() * 30),
            memoryFreeBytes: m.memGb * 0.55 * 1024 ** 3,
            diskFreeBytes: 380 * 1024 ** 3,
          }),
          `10.0.0.${String(10 + Math.floor(Math.random() * 80))}`,
        ],
      );
      for (const rt of m.runtimes) {
        await pool.query(
          `INSERT INTO worker_runtimes (worker_id, runtime, version, os, arch, installed, authenticated, pinned_version,
                                        pin_status, capabilities, present, first_reported_at, last_reported_at)
           VALUES ($1, $2, $3, $4, $5, true, 'yes', $3, 'match',
                   '{"streaming":{"status":"supported"},"approval":{"status":"supported"},"cancel":{"status":"supported"},"interactive_prompt":{"status":"supported"}}',
                   true, now() - interval '30 days', now()) ON CONFLICT DO NOTHING`,
          [
            m.id,
            rt,
            rt === 'codex' ? '0.162.1' : rt === 'opencode' ? '0.9.4' : '2.1.30',
            m.os === 'windows' ? 'win32' : m.os,
            m.arch,
          ],
        );
      }
    }
    // Projects.
    for (const p of Object.values(P) as SeedProject[]) {
      const area = p.repo === undefined;
      await pool.query(
        `INSERT INTO projects (id, name, kind, created_by, created_at)
         VALUES ($1, $2, $3, $4, now() - interval '60 days')
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [p.id, p.name, area ? 'workspace' : 'repository', userId],
      );
      // Work areas: an empty scratch directory per attempt, public HTTPS through the egress proxy.
      if (area)
        await pool.query(
          `INSERT INTO project_workspaces (project, egress, allow_hosts, updated_by, updated_at)
           VALUES ($1, 'web', '[]'::jsonb, $2, now() - interval '60 days') ON CONFLICT (project) DO NOTHING`,
          [p.id, userId],
        );
    }

    // Jobs.
    const succeed = (extra: Step[] = []): Step[] => [
      ...START,
      ...extra,
      ['VERIFYING', 'run_finished', 'worker'],
      ['SUCCEEDED', 'verification_passed_no_approval', 'system'],
    ];
    ids.running = (
      await seedJob(pool, {
        project: P.portal,
        title: 'Fatura ekranına PDF dışa aktarma ekle',
        prompt:
          'Fatura listesine "PDF olarak indir" düğmesi ekle.\n\nHer fatura için şirket logosu ve KDV dökümü olsun; mevcut testler geçmeli.',
        machine: M.build,
        startedMin: 12,
        stepMin: 0.4,
        steps: START,
        logs: [
          '$ git checkout -b agent/fatura-pdf\n',
          '› Depo yapısı inceleniyor: apps/portal, packages/billing\n',
          '› packages/billing/src/invoice.ts okunuyor (412 satır)\n',
          '› Plan: InvoicePdf bileşeni + /api/invoices/:id/pdf uç noktası\n',
          '$ pnpm add @react-pdf/renderer\n',
          'Packages: +14\nProgress: resolved 812, reused 798, downloaded 14, added 14, done\n',
          '› apps/portal/src/invoices/InvoicePdf.tsx oluşturuldu (+186)\n',
          '› apps/portal/src/invoices/InvoiceList.tsx güncellendi (+22 −3)\n',
          '$ pnpm --filter portal test\n',
          '\u001b[32m✓\u001b[0m invoices/InvoiceList.test.tsx (14 tests) 412ms\n',
          '\u001b[32m✓\u001b[0m invoices/InvoicePdf.test.tsx (6 tests) 238ms\n',
          '\u001b[32m✓\u001b[0m billing/vat.test.ts (21 tests) 96ms\n',
          'Test Files  3 passed (3)\n     Tests  41 passed (41)\n',
          '$ pnpm --filter portal lint\n',
          '› Lint temiz. Değişiklikler commit ediliyor…\n',
        ],
      })
    ).id;
    ids.running2 = (
      await seedJob(pool, {
        project: P.mobile,
        title: 'Android 15 hedef SDK güncellemesi',
        prompt:
          'targetSdk 35’e çık, kenardan kenara ekran değişikliklerini uygula ve UI testlerini çalıştır.',
        runtime: 'codex',
        machine: M.gpu,
        startedMin: 7,
        stepMin: 0.5,
        steps: START,
        logs: ['$ ./gradlew assembleDebug\n', 'BUILD SUCCESSFUL in 1m 42s\n'],
      })
    ).id;
    await seedJob(pool, {
      project: P.site,
      title: 'Blog için SEO meta etiketlerini düzelt',
      prompt: 'Tüm blog sayfalarında og:image, canonical ve açıklama etiketlerini tamamla.',
      machine: M.mac,
      startedMin: 4,
      stepMin: 0.4,
      steps: START,
      logs: ['› 38 blog sayfası taranıyor\n'],
    });
    ids.approval = (
      await seedJob(pool, {
        project: P.portal,
        title: 'Oturum zaman aşımını 30 dakikaya çıkar',
        prompt: 'Oturum zaman aşımını 15 dakikadan 30 dakikaya çıkar, ayarı yapılandırılabilir yap.',
        machine: M.mac,
        startedMin: 38,
        steps: [
          ...START,
          ['VERIFYING', 'run_finished', 'worker'],
          ['AWAITING_APPROVAL', 'verification_passed', 'system'],
        ],
        logs: ['› Değişiklik doğrulandı, birleştirme onayı bekleniyor\n'],
      })
    ).id;
    ids.approval2 = (
      await seedJob(pool, {
        project: P.site,
        title: 'Fiyatlandırma sayfasını yayına al',
        prompt: 'Yeni fiyatlandırma sayfasını canlı ortama dağıt.',
        machine: M.build,
        startedMin: 55,
        steps: [
          ...START,
          ['VERIFYING', 'run_finished', 'worker'],
          ['AWAITING_APPROVAL', 'verification_passed', 'system'],
        ],
      })
    ).id;
    ids.retried = (
      await seedJob(pool, {
        project: P.mobile,
        title: 'Push bildirim izin akışını yenile',
        prompt:
          'iOS ve Android için bildirim izni isteme akışını yeniden tasarla; reddedilince tekrar sorma.',
        machine: M.win,
        retryOn: M.mac,
        startedMin: 95,
        steps: [
          ...START,
          [
            'RETRY_WAIT',
            'attempt_failed',
            'worker',
            'Makine bağlantısı koptu; iş başka makinede yeniden denenecek.',
          ],
          ['QUEUED', 'retry_due', 'system'],
          ['RESERVED', 'reserve', 'system'],
          ['STARTING', 'lease_acked', 'worker'],
          ['RUNNING', 'runtime_started', 'worker'],
          ['VERIFYING', 'run_finished', 'worker'],
          ['SUCCEEDED', 'verification_passed_no_approval', 'system'],
        ],
        logs: ['› İkinci deneme mac-studio üzerinde\n', '\u001b[32m✓\u001b[0m 128 test geçti\n'],
      })
    ).id;
    ids.failed = (
      await seedJob(pool, {
        project: P.portal,
        title: 'Ödeme sağlayıcısı SDK’sını v5’e yükselt',
        prompt: 'Ödeme SDK’sını v5’e yükselt ve kırılan API çağrılarını düzelt.',
        runtime: 'codex',
        machine: M.build,
        startedMin: 140,
        steps: [
          ...START,
          [
            'FAILED',
            'attempt_failed',
            'worker',
            'Testler başarısız: 3 entegrasyon testi sandbox anahtarı bekliyor.',
          ],
        ],
        logs: ['\u001b[31m✗\u001b[0m checkout.int.test.ts › 3 failed\n'],
      })
    ).id;
    const done: [keyof typeof P, string, keyof typeof M, number, string?][] = [
      ['site', 'Ana sayfa hero görsellerini yenile', 'mac', 180],
      ['portal', 'Sipariş geçmişine filtre ekle', 'build', 240],
      ['mobile', 'Karanlık tema renklerini düzelt', 'gpu', 320, 'codex'],
      ['site', 'Kampanya açılış sayfası oluştur', 'mac', 410],
      ['portal', 'Kullanıcı davet e-postasını çevir', 'win', 520],
      ['mobile', 'Uygulama içi satın alma testleri', 'gpu', 700, 'codex'],
      ['portal', 'Bağımlılık güvenlik güncellemeleri', 'build', 900],
    ];
    for (const [i, [p, title, m, min, rt]] of done.entries()) {
      const r = await seedJob(pool, {
        project: P[p],
        title,
        prompt: `${title}.`,
        machine: M[m],
        startedMin: min,
        steps: succeed(),
        ...(rt === undefined ? {} : { runtime: rt }),
      });
      if (i === 0) ids.heroJob = r.id;
      if (i === 3) ids.landing = r.id;
    }
    // Work areas: a research job with report / table / chart outputs, one still running, and a content draft.
    ids.research = (
      await seedJob(pool, {
        project: P.research,
        title: L(
          'Rakip analizi: müşteri portalı yazılımları',
          'Competitor analysis: customer portal software',
        ),
        prompt: L(
          'Müşteri portalı pazarındaki 6 rakibi karşılaştır: fiyat, fatura özellikleri, entegrasyonlar. Çıktı: out/rapor.md ve out/competitors.csv; kaynakları belirt.',
          'Compare 6 competitors in the customer portal market: pricing, invoicing features, integrations. Output: out/report.md and out/competitors.csv; cite the sources.',
        ),
        machine: M.gpu,
        startedMin: 150,
        stepMin: 3,
        steps: succeed(),
        logs: [
          L(
            '› 6 rakibin fiyat sayfası ve dokümantasyonu okunuyor\n',
            '› Reading the pricing pages and docs of 6 competitors\n',
          ),
          L(
            '› 41 kaynak not edildi, 9 tanesi elendi (tarihsiz)\n',
            '› 41 sources noted, 9 dropped (undated)\n',
          ),
          '$ python3 analyse.py --in notes.json --out out/competitors.csv\n',
          L('› out/rapor.md yazıldı (1.840 kelime)\n', '› out/report.md written (1,840 words)\n'),
        ],
      })
    ).id;
    await seedJob(pool, {
      project: P.research,
      title: L('Fiyat anketi yanıtlarını özetle', 'Summarise the pricing survey answers'),
      prompt: L(
        '312 anket yanıtını temalara ayır, öne çıkan 5 itirazı alıntılarla raporla.',
        'Group the 312 survey answers into themes and report the top 5 objections with quotes.',
      ),
      machine: M.mac,
      startedMin: 6,
      stepMin: 0.5,
      steps: START,
      logs: [L('› 312 yanıt okunuyor\n', '› Reading 312 answers\n')],
    });
    ids.contentDraft = (
      await seedJob(pool, {
        project: P.content,
        title: L('Kasım bülteni için içerik taslağı', 'Content draft for the November newsletter'),
        prompt: L(
          'Kasım bülteni: fatura PDF’i duyurusu, 2 müşteri ipucu ve webinar daveti. Ton samimi, 600 kelime.',
          'November newsletter: the invoice PDF announcement, 2 customer tips and the webinar invitation. Friendly tone, 600 words.',
        ),
        machine: M.mac,
        startedMin: 75,
        stepMin: 2,
        steps: succeed(),
      })
    ).id;

    // Usage (cost) records for every job with an attempt.
    const att = await pool.query(
      `SELECT a.id, a.job_id, a.worker_id, j.project, j.spec->>'runtime' AS runtime, a.started_at
         FROM job_attempts a JOIN jobs j ON j.id = a.job_id`,
    );
    for (const r of att.rows) {
      const rt = String(r.runtime);
      const inTok = 80_000 + Math.floor(Math.random() * 600_000);
      await pool.query(
        `INSERT INTO usage_records (job_id, attempt_id, worker_id, project, runtime, runtime_version, provider, model,
                                    auth_mode, input_tokens, output_tokens, cache_read_tokens, turns, wall_time_ms,
                                    cost_usd, provenance, source_event_id, payload_hash, recorded_at)
         VALUES ($1, $2, $3, $4, $5, '1.0', $6, $7, 'secret-ref', $8, $9, $10, $11, $12, $13, 'reported-by-runtime',
                 $14, $15, $16)`,
        [
          r.job_id,
          r.id,
          r.worker_id,
          r.project,
          rt,
          rt === 'codex' ? 'openai' : 'anthropic',
          rt === 'codex' ? 'gpt-5.5-codex' : 'claude-sonnet-5',
          inTok,
          Math.floor(inTok / 9),
          inTok * 3,
          12 + Math.floor(Math.random() * 40),
          240_000 + Math.floor(Math.random() * 900_000),
          (inTok / 1_000_000) * 3.2 + Math.random() * 0.4,
          `ev-${randomBytes(6).toString('hex')}`,
          createHash('sha256').update(randomUUID()).digest('hex'),
          r.started_at,
        ],
      );
    }
    // Subscription windows (usage & limits).
    for (const [m, rt, five, week] of [
      [M.build, 'claude-code', 46, 31],
      [M.mac, 'claude-code', 72, 58],
      [M.gpu, 'codex', 23, 64],
      [M.win, 'claude-code', 12, 31],
    ] as const) {
      const windows =
        rt === 'codex'
          ? [
              {
                id: 'primary',
                kind: 'session',
                usedPercent: five,
                windowMinutes: 300,
                resetsAt: ago(-140).toISOString(),
                status: 'allowed',
              },
              {
                id: 'secondary',
                kind: 'weekly',
                usedPercent: week,
                windowMinutes: 10080,
                resetsAt: ago(-3 * 1440).toISOString(),
                status: 'allowed',
              },
            ]
          : [
              {
                id: 'five_hour',
                kind: 'session',
                usedPercent: five,
                windowMinutes: 300,
                resetsAt: ago(-95).toISOString(),
                status: five > 70 ? 'warning' : 'allowed',
              },
              {
                id: 'seven_day',
                kind: 'weekly',
                usedPercent: week,
                windowMinutes: 10080,
                resetsAt: ago(-4 * 1440).toISOString(),
                status: 'allowed',
              },
            ];
      await pool.query(
        `INSERT INTO runtime_usage_snapshots (worker_id, runtime, auth, store, source, plan, available, windows,
                                              observed_at, received_at)
         VALUES ($1, $2, 'subscription', NULL, 'probe', $3, true, $4, now() - interval '3 minutes', now())`,
        [m.id, rt, rt === 'codex' ? 'pro' : 'max', JSON.stringify(windows)],
      );
      for (let h = 24; h >= 0; h -= 1) {
        for (const w of windows) {
          await pool.query(
            `INSERT INTO runtime_usage_history (worker_id, runtime, auth, window_id, at, used_percent)
             VALUES ($1, $2, 'subscription', $3, now() - ($4 || ' hours')::interval, $5)`,
            [
              m.id,
              rt,
              w.id,
              String(h),
              Math.max(0, Math.min(100, w.usedPercent - h * (w.kind === 'session' ? 1.6 : 0.4))),
            ],
          );
        }
      }
    }

    // Chat conversation.
    threadId = randomUUID();
    await pool.query(
      `INSERT INTO chat_threads (id, user_id, title, created_at, updated_at, next_seq)
       VALUES ($1, $2, 'Fatura PDF dışa aktarma', now() - interval '20 minutes', now(), 1)`,
      [threadId, userId],
    );
    let seq = 0;
    const msg = async (
      role: string,
      content: string,
      min: number,
      meta: unknown = null,
      turn: string | null = null,
    ) => {
      seq += 1;
      const id = randomUUID();
      await pool.query(
        `INSERT INTO chat_messages (id, thread_id, seq, role, content, meta, turn_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, threadId, seq, role, content, meta === null ? null : JSON.stringify(meta), turn, ago(min)],
      );
      return id;
    };
    const turn1 = randomUUID();
    await msg(
      'user',
      'Müşteri portalında faturalar PDF olarak indirilebilsin. Logomuz ve KDV dökümü olsun. Uygun bir makinede başlatır mısın?',
      16,
    );
    await msg('tool', 'Proje ayarları okundu', 15.8, { name: 'get_project', isError: false }, turn1);
    await msg(
      'tool',
      'Makine kapasitesi kontrol edildi',
      15.7,
      { name: 'list_workers', isError: false },
      turn1,
    );
    await msg(
      'assistant',
      '**Müşteri Portalı** için bir iş hazırladım:\n\n- `InvoicePdf` bileşeni ve `/api/invoices/:id/pdf` uç noktası\n- Şirket logosu ve KDV dökümü\n- Mevcut testler + 6 yeni test\n\n**build-01** şu an 1/4 slot kullanıyor; iş orada hemen başlayabilir. Onaylarsan başlatıyorum.',
      15.5,
      null,
      turn1,
    );
    await pool.query(
      `INSERT INTO chat_drafts (id, thread_id, user_id, turn_id, kind, title, payload, payload_hash, project, state,
                                result, created_at, expires_at, decided_at)
       VALUES ($1, $2, $3, $4, 'job', 'Fatura ekranına PDF dışa aktarma ekle', $5, $6, $7, 'confirmed', $8,
               now() - interval '15 minutes', now() + interval '1 day', now() - interval '14 minutes')`,
      [
        randomUUID(),
        threadId,
        userId,
        turn1,
        JSON.stringify({
          project: P.portal.id,
          spec: {
            projectId: P.portal.id,
            runtime: 'claude-code',
            title: 'Fatura ekranına PDF dışa aktarma ekle',
            prompt: 'Fatura listesine "PDF olarak indir" düğmesi ekle.',
            repository: { url: P.portal.repo, baseRef: 'main', workBranch: 'agent/fatura-pdf' },
            sandboxProfile: 'container',
            approvalPolicy: 'ask-sensitive',
            limits: { maxDurationSec: 3600 },
          },
        }),
        createHash('sha256').update('d1').digest('hex'),
        P.portal.id,
        JSON.stringify({ jobId: ids.running }),
      ],
    );
    await pool.query(
      `INSERT INTO chat_drafts (id, thread_id, user_id, turn_id, kind, title, payload, payload_hash, project, state,
                                result, created_at, expires_at, decided_at)
       VALUES ($1, $2, $3, $4, 'job', 'PDF şablonuna e-imza alanı ekle', $5, $6, $7, 'proposed', NULL,
               now() - interval '15 minutes', now() + interval '1 day', NULL)`,
      [
        randomUUID(),
        threadId,
        userId,
        turn1,
        JSON.stringify({
          project: P.portal.id,
          spec: {
            projectId: P.portal.id,
            runtime: 'codex',
            title: 'PDF şablonuna e-imza alanı ekle',
            prompt: 'PDF faturaya e-imza alanı ekle.',
            repository: { url: P.portal.repo, baseRef: 'main', workBranch: 'agent/e-imza' },
            sandboxProfile: 'container',
            approvalPolicy: 'ask-sensitive',
            limits: { maxDurationSec: 3600 },
          },
        }),
        createHash('sha256').update('d2').digest('hex'),
        P.portal.id,
      ],
    );
    await msg('user', 'Onayladım. Kampanya sayfası işi ne durumda?', 9);
    const turn2 = randomUUID();
    await msg(
      'assistant',
      'Kampanya açılış sayfası işi **tamamlandı** — mac-studio üzerinde 7 dakika sürdü. Özet aşağıda:',
      8.5,
      {
        notice: 'chat-watch',
        jobId: ids.landing,
        jobSummary: 'Açılış sayfası, form ve A/B varyantı hazır; Lighthouse 98.',
      },
      turn2,
    );
    await msg('user', 'Harika. Fatura PDF’i bitince müşterilere duyuru da hazırlayalım.', 3);
    const turn3 = randomUUID();
    await msg('assistant', 'Duyuruyu hazırlamadan önce birkaç şeyi netleştirelim:', 2.5, null, turn3);
    const qid = randomUUID();
    await pool.query(
      `INSERT INTO user_questions (id, source, thread_id, turn_id, user_id, project, title, questions, state, created_at,
                                   deadline_at)
       VALUES ($1, 'assistant', $2, $3, $4, $5, 'Duyuru tercihleri', $6, 'pending', now() - interval '2 minutes',
               now() + interval '1 hour')`,
      [
        qid,
        threadId,
        turn3,
        userId,
        P.portal.id,
        JSON.stringify({
          v: 1,
          questions: [
            {
              id: 'kanal',
              prompt: 'Duyuru hangi kanallardan gitsin?',
              kind: 'multi',
              options: [
                { label: 'E-posta bülteni', description: '12.400 abone' },
                { label: 'Uygulama içi bildirim' },
                { label: 'Blog yazısı' },
              ],
              default: ['E-posta bülteni'],
            },
            {
              id: 'ton',
              prompt: 'Metnin tonu nasıl olsun?',
              kind: 'single',
              options: [{ label: 'Kurumsal' }, { label: 'Samimi' }, { label: 'Kısa ve teknik' }],
              allowOther: true,
            },
          ],
        }),
      ],
    );
    await msg(
      'tool',
      'Kullanıcıya soru soruldu',
      2.4,
      { name: 'ask_user', isError: false, questionId: qid },
      turn3,
    );
    await pool.query(`UPDATE chat_threads SET next_seq = $2, project = $3 WHERE id = $1`, [
      threadId,
      seq + 1,
      P.portal.id,
    ]);
    await pool.query(
      `INSERT INTO chat_thread_reads (thread_id, user_id, last_read_seq, last_read_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_seq = EXCLUDED.last_read_seq`,
      [threadId, userId, seq],
    );
  });
}

/** Agent narration and tool calls of the running job (the "Akış günlüğü"). */
async function seedEvents(pool: Pool, jobId: string): Promise<void> {
  const a = await pool.query(
    `SELECT id, worker_id, started_at FROM job_attempts WHERE job_id = $1 ORDER BY number DESC LIMIT 1`,
    [jobId],
  );
  const attempt = String(a.rows[0]?.id);
  const worker = String(a.rows[0]?.worker_id);
  const t0 = new Date(String(a.rows[0]?.started_at)).getTime() + 30_000;
  const head = await pool.query(`SELECT head FROM job_live_heads WHERE job_id = $1`, [jobId]);
  let seq = Number(head.rows[0]?.head ?? 0);
  const ev = async (kind: string, payload: Record<string, unknown>, sec: number) => {
    seq += 1;
    const body = JSON.stringify({ kind, ...payload });
    await pool.query(
      `INSERT INTO job_events (job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq, message_id, stream_seq,
                               kind, payload, ts, received_at, size_bytes)
       VALUES ($1, $2, 1, 1, $3, $4, $5, $4, $6, $7, $8, $8, $9)`,
      [jobId, attempt, worker, seq, randomUUID(), kind, body, new Date(t0 + sec * 1000), body.length],
    );
  };
  let call = 0;
  const tool = async (name: string, input: string, output: string, sec: number) => {
    call += 1;
    await ev('tool_call', { callId: `c${String(call)}`, toolName: name, inputSummary: input }, sec);
    await ev('tool_result', { callId: `c${String(call)}`, ok: true, outputSummary: output }, sec + 4);
  };
  await ev(
    'message',
    { role: 'assistant', text: 'Depo yapısını inceliyorum: `apps/portal` ve `packages/billing`.' },
    0,
  );
  await tool('Read', 'packages/billing/src/invoice.ts', '412 satır', 6);
  await tool('Grep', '"exportInvoice" apps/portal', '3 eşleşme', 14);
  await ev(
    'message',
    {
      role: 'assistant',
      text: 'Plan: `InvoicePdf` bileşeni, `/api/invoices/:id/pdf` uç noktası ve listeye **PDF olarak indir** düğmesi. Logo ve KDV dökümü mevcut `VatBreakdown` yardımcısından gelecek.',
    },
    22,
  );
  await tool('Bash', 'pnpm add @react-pdf/renderer', '+14 paket', 40);
  await tool('Write', 'apps/portal/src/invoices/InvoicePdf.tsx', '+186 satır', 75);
  await tool('Edit', 'apps/portal/src/invoices/InvoiceList.tsx', '+22 −3', 110);
  await tool('Bash', 'pnpm --filter portal test', '41 test geçti (3 dosya)', 160);
  await ev(
    'message',
    {
      role: 'assistant',
      text: 'Testler geçti. Şimdi lint ve tip kontrolünü çalıştırıp değişiklikleri commit ediyorum.',
    },
    200,
  );
  await tool('Bash', 'pnpm --filter portal lint && pnpm typecheck', 'temiz', 215);
  await pool.query(`UPDATE job_live_heads SET head = $2 WHERE job_id = $1`, [jobId, seq]);
}

/** A pending gate approval of a job (the job's current attempt and lease epoch). */
async function approvalRequest(
  pool: Pool,
  jobId: string,
  action: string,
  risk: string,
  summary: string,
  min: number,
): Promise<string> {
  const id = randomUUID();
  const j = await pool.query(`SELECT current_attempt_id, lease_epoch FROM jobs WHERE id = $1`, [jobId]);
  await pool.query(
    `INSERT INTO approval_requests (id, job_id, attempt_id, epoch, approval_key, kind, action, requested_action, risk,
                                    summary, requested_by_type, policy_version, approver_role, required_approvals,
                                    step_up, status, created_at, expires_at)
     VALUES ($1, $2, $8, $9, $3, 'gate', $4, $4, $5, $6, 'system', 1, 'admin', 1, true, 'pending',
             now() - ($7 || ' minutes')::interval, now() + interval '1 day')`,
    [
      id,
      jobId,
      `gate:${action}`,
      action,
      risk,
      summary,
      String(min),
      j.rows[0]?.current_attempt_id,
      j.rows[0]?.lease_epoch,
    ],
  );
  return id;
}

interface ChangedFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly status?: string;
}

/** The verified change of a job waiting for its merge decision (job_git, as the git flow leaves it). */
async function verifiedChange(
  pool: Pool,
  c: {
    jobId: string;
    project: string;
    branch: string;
    subject: string;
    files: readonly ChangedFile[];
    min: number;
  },
): Promise<void> {
  const head = sha(`head-${c.jobId}`);
  const totals = c.files.reduce(
    (t, f) => ({
      files: t.files + 1,
      additions: t.additions + f.additions,
      deletions: t.deletions + f.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
  await pool.query(
    `INSERT INTO job_git (job_id, project, provider, target_branch, base_sha, base_captured_at, branch, head_sha,
                          verification, verified_at, changes, merge_state, merge_checked_at, ci_state, created_at,
                          updated_at)
     VALUES ($1, $2, 'git', 'main', $3, $7, $4, $5, 'passed', $8, $6, 'clean', $8, 'success', $7, now())`,
    [
      c.jobId,
      c.project,
      sha(`base-${c.jobId}`),
      c.branch,
      head,
      JSON.stringify({
        commits: [
          { sha: head, subject: c.subject, author: 'Remyral Agent', date: ago(c.min + 2).toISOString() },
        ],
        files: c.files.map((f) => ({ status: 'modified', ...f })),
        totals,
        truncated: false,
      }),
      ago(c.min + 30),
      ago(c.min),
    ],
  );
}

async function seedApprovals(pool: Pool): Promise<void> {
  await approvalRequest(
    pool,
    ids.approval ?? '',
    'git.merge',
    'medium',
    'agent/oturum-suresi dalını main’e birleştir: 4 dosya, +38 −9. Testler ve doğrulama geçti.',
    6,
  );
  await approvalRequest(
    pool,
    ids.approval2 ?? '',
    'deploy',
    'high',
    'Fiyatlandırma sayfasını üretim ortamına dağıt (marketing-site → production).',
    12,
  );
  await verifiedChange(pool, {
    jobId: ids.approval ?? '',
    project: P.portal.id,
    branch: 'agent/oturum-suresi',
    subject: 'Oturum zaman aşımı 30 dakika, yapılandırılabilir',
    min: 7,
    files: [
      { path: 'apps/portal/src/auth/session.ts', additions: 14, deletions: 6 },
      { path: 'apps/portal/src/config/defaults.ts', additions: 3, deletions: 1 },
      { path: 'apps/portal/src/auth/session.test.ts', additions: 19, deletions: 2 },
      { path: 'docs/yapilandirma.md', additions: 2, deletions: 0 },
    ],
  });
}

/**
 * The tour job reaches its merge decision: verified (VERIFYING → AWAITING_APPROVAL), its change recorded, a pending
 * git.merge approval and the audit rows of it. Run by the last test, after every shot that shows it running.
 */
async function pdfToMergeDecision(pool: Pool): Promise<void> {
  const jobId = ids.running ?? '';
  const j = await pool.query(
    `SELECT current_attempt_id, lease_epoch, (SELECT number FROM job_attempts WHERE id = current_attempt_id) AS no
       FROM jobs WHERE id = $1`,
    [jobId],
  );
  const attempt = String(j.rows[0]?.current_attempt_id);
  const attemptNo = Number(j.rows[0]?.no ?? 1);
  for (const [to, trigger, actor, min] of [
    ['VERIFYING', 'run_finished', 'worker', 2.5],
    ['AWAITING_APPROVAL', 'verification_passed', 'system', 1.5],
  ] as const) {
    await transition(pool, {
      jobId,
      to,
      trigger,
      actor,
      at: ago(min),
      attempt,
      attemptNo,
      worker: M.build.id,
    });
  }
  const head = await pool.query(`SELECT head FROM job_live_heads WHERE job_id = $1`, [jobId]);
  const seq = Number(head.rows[0]?.head ?? 0) + 1;
  await pool.query(`UPDATE job_live_heads SET head = $2 WHERE job_id = $1`, [jobId, seq]);
  await pool.query(
    `INSERT INTO job_log_chunks (job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq, message_id,
                                 stream, chunk_seq, stream_seq, ts, received_at, text, size_bytes)
     VALUES ($1, $2, $7, $7, $6, $3, $4, 'stdout', $3, $3, $8, $8, $5, length($5))`,
    [
      jobId,
      attempt,
      seq,
      randomUUID(),
      '› Değişiklik doğrulandı, birleştirme onayı bekleniyor\n',
      M.build.id,
      attemptNo,
      ago(1.5),
    ],
  );
  await verifiedChange(pool, {
    jobId,
    project: P.portal.id,
    branch: 'agent/fatura-pdf',
    subject: 'Faturalar PDF olarak indirilebilir (logo ve KDV dökümü)',
    min: 2,
    files: [
      { path: 'apps/portal/src/invoices/InvoicePdf.tsx', additions: 186, deletions: 0, status: 'added' },
      { path: 'apps/portal/src/invoices/InvoiceList.tsx', additions: 22, deletions: 3 },
      { path: 'apps/portal/src/api/invoices.ts', additions: 31, deletions: 2 },
      { path: 'apps/portal/src/invoices/InvoicePdf.test.tsx', additions: 64, deletions: 0, status: 'added' },
      { path: 'apps/portal/package.json', additions: 1, deletions: 0 },
    ],
  });
  await approvalRequest(
    pool,
    jobId,
    'git.merge',
    'medium',
    'agent/fatura-pdf dalını main’e birleştir: 5 dosya, +304 −5. 41 test ve doğrulama geçti.',
    1,
  );
}

type Look = readonly [
  name: string,
  c1: string,
  c2: string,
  title: string,
  sub: string,
  w?: number,
  h?: number,
];

/** Simple branded raster images for the outputs (rendered by the browser itself). */
async function renderImages(page: Page, looks: readonly Look[]): Promise<OutFile[]> {
  const out: OutFile[] = [];
  for (const [name, c1, c2, title, sub, w = 1200, h = 675] of looks) {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(
      `<body style="margin:0"><div style="width:${String(w)}px;height:${String(h)}px;background:linear-gradient(135deg,${c1},${c2});
        display:flex;flex-direction:column;justify-content:center;padding:0 90px;box-sizing:border-box;font-family:
        -apple-system,Helvetica,Arial,sans-serif;color:#fff;position:relative;overflow:hidden">
        <div style="position:absolute;right:-120px;top:-120px;width:520px;height:520px;border-radius:50%;
          background:rgba(255,255,255,.12)"></div>
        <div style="position:absolute;right:140px;bottom:-160px;width:360px;height:360px;border-radius:50%;
          background:rgba(255,255,255,.08)"></div>
        <div style="font-size:22px;letter-spacing:4px;opacity:.85;text-transform:uppercase">Acme</div>
        <div style="font-size:76px;font-weight:800;line-height:1.05;margin-top:18px;max-width:820px">${tx(title)}</div>
        <div style="font-size:30px;margin-top:22px;opacity:.92">${tx(sub)}</div>
        <div style="margin-top:44px;display:inline-block;background:#fff;color:${c1};font-weight:700;font-size:24px;
          padding:16px 30px;border-radius:999px;align-self:flex-start">${tx('Hemen keşfet →')}</div></div></body>`,
    );
    out.push({ name, content: await page.screenshot({ type: 'png' }) });
  }
  return out;
}

const CAMPAIGN: readonly Look[] = [
  ['kampanya/hero-1.png', '#0f766e', '#14b8a6', 'Bahar Kampanyası', '%30 indirim · 31 Mart’a kadar'],
  ['kampanya/hero-2.png', '#1e3a8a', '#6366f1', 'Yeni Müşteri Portalı', 'Faturalar artık tek tıkla PDF'],
  ['kampanya/sosyal-kare.png', '#9a3412', '#f59e0b', 'Mobil Uygulama 3.0', 'Karanlık tema · Hızlı ödeme'],
  ['kampanya/banner-genis.png', '#4c1d95', '#ec4899', 'Webinar: Ajanlarla DevOps', '12 Kasım · 14:00'],
];

/** The images the Codex step of the content calendar generates (copied to out/generated-images/ by the adapter). */
const SOCIAL: readonly Look[] = [
  [
    L('generated-images/linkedin-pazartesi.png', 'generated-images/linkedin-monday.png'),
    '#1e3a8a',
    '#0ea5e9',
    L('Faturalar artık PDF', 'Invoices, now as PDF'),
    L('Logo ve KDV dökümü tek tıkla', 'Logo and VAT breakdown in one click'),
  ],
  [
    L('generated-images/instagram-carsamba.png', 'generated-images/instagram-wednesday.png'),
    '#9d174d',
    '#f97316',
    L('3 ipucu: daha hızlı tahsilat', '3 tips for faster payments'),
    L('Müşteri portalı ile', 'With the customer portal'),
    1080,
    1080,
  ],
  [
    L('generated-images/x-cuma.png', 'generated-images/x-friday.png'),
    '#065f46',
    '#22c55e',
    L('Webinar: Ajanlarla DevOps', 'Webinar: DevOps with agents'),
    L('12 Kasım · 14:00 · Ücretsiz', '12 November · 14:00 · Free'),
  ],
];

/** The research job's chart: market share of the compared products (a plain bar chart). */
async function renderChart(page: Page): Promise<OutFile> {
  const rows: [string, number][] = [
    ['Northwind', 27],
    ['Contoso', 21],
    ['Fabrikam', 17],
    ['Tailspin', 12],
    ['Acme', 9],
    [L('Diğer', 'Other'), 14],
  ];
  await page.setViewportSize({ width: 1200, height: 675 });
  const bars = rows
    .map(
      ([n, v]) => `<div style="display:flex;align-items:center;gap:18px;margin:14px 0">
        <div style="width:170px;text-align:right;font-size:24px;color:#334155">${n}</div>
        <div style="height:44px;width:${String(v * 26)}px;border-radius:6px;background:${n === 'Acme' ? '#0f766e' : '#94a3b8'}"></div>
        <div style="font-size:24px;font-weight:700;color:#0f172a">%${String(v)}</div></div>`,
    )
    .join('');
  await page.setContent(
    `<body style="margin:0;background:#fff;font-family:-apple-system,Helvetica,Arial,sans-serif">
      <div style="width:1200px;height:675px;box-sizing:border-box;padding:56px 80px">
      <div style="font-size:34px;font-weight:800;color:#0f172a">${L('Müşteri portalı pazarı: tahmini pay (2026)', 'Customer portal market: estimated share (2026)')}</div>
      <div style="font-size:20px;color:#64748b;margin:8px 0 26px">${L('Kaynak: competitors.csv · 41 kaynak, 6 ürün', 'Source: competitors.csv · 41 sources, 6 products')}</div>
      ${bars}</div></body>`,
  );
  return { name: L('pazar-payi.png', 'market-share.png'), content: await page.screenshot({ type: 'png' }) };
}

const RESEARCH_FILES = (): OutFile[] => [
  {
    name: L('rapor.md', 'report.md'),
    content: Buffer.from(
      L(
        `# Rakip analizi: müşteri portalı yazılımları

**Özet.** İncelenen 6 üründen 4'ü faturayı PDF olarak sunuyor, yalnızca 2'si KDV dökümünü faturada gösteriyor.
Fiyatlar kullanıcı başına aylık 6–19 USD aralığında; entegrasyon sayısı en belirleyici fark.

## Öne çıkanlar

- **Northwind:** en geniş entegrasyon kataloğu (40+), fakat PDF şablonu özelleştirilemiyor.
- **Contoso:** e-imza ve tekrarlayan faturalar var; kurulum ücreti yüksek.
- **Fabrikam:** en uygun fiyat; çok dilli destek sınırlı.

## Öneriler

1. Fatura PDF'inde logo ve KDV dökümü bir fark olarak öne çıkarılmalı.
2. E-imza alanı (taslakta) ikinci çeyrekte rekabet eşiği olacak.
3. Fiyat sayfasında entegrasyon sayısı açıkça gösterilmeli.

## Yöntem

41 kaynak (fiyat sayfaları, dokümantasyon, sürüm notları) 21–27 Ekim 2026 arasında okundu; tarihsiz 9 kaynak elendi.
Tüm satırların kaynağı \`competitors.csv\` dosyasında.
`,
        `# Competitor analysis: customer portal software

**Summary.** 4 of the 6 products reviewed offer invoices as PDF; only 2 show the VAT breakdown on the invoice.
Prices range from 6 to 19 USD per user per month; the number of integrations is the clearest difference.

## Highlights

- **Northwind:** the largest integration catalogue (40+), but the PDF template cannot be customised.
- **Contoso:** e-signature and recurring invoices; a high setup fee.
- **Fabrikam:** the lowest price; limited multi-language support.

## Recommendations

1. Lead with the logo and VAT breakdown on the invoice PDF as a differentiator.
2. The e-signature field (drafted) becomes table stakes by the second quarter.
3. Show the number of integrations clearly on the pricing page.

## Method

41 sources (pricing pages, documentation, release notes) read 21–27 October 2026; 9 undated sources dropped.
Every row's source is in \`competitors.csv\`.
`,
      ),
    ),
  },
  {
    name: 'competitors.csv',
    content: Buffer.from(
      L(
        `urun,fiyat_usd_kullanici_ay,pdf_fatura,kdv_dokumu,e_imza,entegrasyon,kaynak
Northwind,19,evet,hayır,hayır,42,https://northwind.example.com/pricing
Contoso,15,evet,evet,evet,18,https://contoso.example.com/plans
Fabrikam,6,evet,hayır,hayır,11,https://fabrikam.example.com/pricing
Tailspin,12,hayır,hayır,hayır,23,https://tailspin.example.com/pricing
Litware,9,hayır,hayır,evet,7,https://litware.example.com/docs
Acme,10,evet,evet,taslak,14,https://www.acme.example/pricing
`,
        `product,price_usd_user_month,pdf_invoice,vat_breakdown,e_signature,integrations,source
Northwind,19,yes,no,no,42,https://northwind.example.com/pricing
Contoso,15,yes,yes,yes,18,https://contoso.example.com/plans
Fabrikam,6,yes,no,no,11,https://fabrikam.example.com/pricing
Tailspin,12,no,no,no,23,https://tailspin.example.com/pricing
Litware,9,no,no,yes,7,https://litware.example.com/docs
Acme,10,yes,yes,draft,14,https://www.acme.example/pricing
`,
      ),
    ),
  },
];

async function seedOutputs(
  pool: Pool,
  jobId: string,
  files: readonly OutFile[],
  minutesAgo = 0,
): Promise<void> {
  const a = await pool.query(`SELECT id FROM job_attempts WHERE job_id = $1 ORDER BY number DESC LIMIT 1`, [
    jobId,
  ]);
  const attempt = String(a.rows[0]?.id);
  for (const f of files) {
    await pool.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                  redacted, content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'output', false, $8, $9)`,
      [
        attempt,
        jobId,
        `ws-${f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        f.name,
        MEDIA[f.name.split('.').pop() ?? ''] ?? 'application/octet-stream',
        f.content.length,
        createHash('sha256').update(f.content).digest('hex'),
        f.content,
        ago(minutesAgo),
      ],
    );
  }
}

type AuditEvent = [number, string, string | null, string, string | null, Record<string, unknown>];

async function seedAudit(extra?: readonly AuditEvent[]): Promise<void> {
  const dist = new URL('../../master/dist/', import.meta.url);
  const { AuditLog } = (await import(new URL('audit/audit.js', dist).href)) as {
    AuditLog: new (
      pool: unknown,
      clock?: () => Date,
    ) => { record(e: Record<string, unknown>): Promise<unknown> };
  };
  await withE2ePool(async (pool) => {
    const ev: readonly AuditEvent[] = extra ?? [
      [50, 'user', userId, 'security.policy.update', 'security-policy', { preset: 'balanced' }],
      [42, 'worker', M.gpu.id, 'worker.capabilities', `worker:${M.gpu.id}`, {}],
      [
        35,
        'user',
        userId,
        'approval.decide',
        `job:${ids.retried ?? ''}`,
        { decision: 'approved', action: 'git.merge' },
      ],
      [28, 'system', null, 'job.retry', `job:${ids.retried ?? ''}`, { attempt: 2, reason: 'worker_lost' }],
      [
        21,
        'user',
        userId,
        'ops.action.request',
        `project:${P.site.id}`,
        { kind: 'pages.deploy', env: 'production' },
      ],
      [14, 'user', userId, 'chat.draft.confirm', `job:${ids.running ?? ''}`, { kind: 'job' }],
      [9, 'worker', M.build.id, 'job.lease.acked', `job:${ids.running ?? ''}`, { epoch: 1 }],
      [5, 'user', userId, 'project.policy.update', `project:${P.portal.id}`, { field: 'approvalPolicy' }],
      [
        3,
        'system',
        null,
        'approval.request',
        `job:${ids.approval ?? ''}`,
        { action: 'git.merge', risk: 'medium' },
      ],
    ];
    for (const [min, type, id, action, target, metadata] of ev) {
      const log = new AuditLog(pool, () => ago(min));
      await log.record({
        actor: { type, id },
        action,
        target,
        outcome: 'success',
        ip: type === 'user' ? '10.0.0.24' : null,
        metadata,
      });
    }
  });
}

async function seedDeploys(pool: Pool): Promise<void> {
  const conn = randomUUID();
  await pool.query(
    `INSERT INTO coolify_connections (id, label, config, secret, secret_aad, key_fingerprint, is_default, all_projects,
                                      last_test, last_test_at, created_at, updated_at)
     VALUES ($1, 'Acme Coolify', $2, $3, $4, $5, true, true, '{"ok":true}', now() - interval '2 hours',
             now() - interval '30 days', now())`,
    [
      conn,
      JSON.stringify({
        url: 'https://coolify.acme.example',
        team: null,
        denyResources: [],
        useServerSso: false,
      }),
      randomBytes(64),
      `coolify-connection:${conn}`,
      randomBytes(8).toString('hex'),
    ],
  );
  await pool.query(
    `INSERT INTO ops_integrations (provider, config, secret, key_fingerprint, last_test, last_test_at, created_at,
                                   updated_at)
     VALUES ('cloudflare', $1, $2, $3, '{"ok":true}', now() - interval '2 hours', now() - interval '30 days', now())
     ON CONFLICT (provider) DO NOTHING`,
    [
      JSON.stringify({ accountId: randomBytes(16).toString('hex') }),
      randomBytes(64),
      randomBytes(8).toString('hex'),
    ],
  );
  const zone = randomBytes(16).toString('hex');
  for (const p of [P.site, P.portal]) {
    await pool.query(
      `INSERT INTO project_deploy_targets (project, config, version, updated_by, updated_at)
       VALUES ($1, $2, 1, $3, now() - interval '10 days')`,
      [
        p.id,
        JSON.stringify({
          coolify: {
            preview: { connection: conn, uuids: [`${p.id.replace(/-/g, '').slice(0, 10)}prv01`], tags: [] },
            production: {
              connection: conn,
              uuids: [`${p.id.replace(/-/g, '').slice(0, 10)}prd01`],
              tags: [],
            },
          },
          pages: p === P.site ? { projectName: 'marketing-site' } : null,
          pagesProjects: [],
          dns: { zones: [{ id: zone, name: 'acme.example' }], protectedNames: ['acme.example'] },
          previews: null,
          policy: {
            previewDeploy: 'auto',
            productionDeploy: 'approval_step_up',
            dnsChange: 'approval',
            autoDeployProductionOnSuccess: false,
            pagesProject: 'approval',
            previewTunnel: 'auto',
            stableTunnel: 'approval',
          },
        }),
        userId,
      ],
    );
  }
  const acts: [string, string, string | null, string, number, string][] = [
    [P.site.id, 'pages.deploy', 'production', 'succeeded', 35, 'approval_step_up'],
    [P.site.id, 'coolify.deploy', 'preview', 'succeeded', 70, 'auto'],
    [P.portal.id, 'coolify.deploy', 'production', 'succeeded', 180, 'approval_step_up'],
    [P.site.id, 'pages.deploy', 'preview', 'succeeded', 260, 'auto'],
    [P.portal.id, 'coolify.restart', 'preview', 'succeeded', 400, 'auto'],
    [P.portal.id, 'coolify.deploy', 'preview', 'failed', 520, 'auto'],
  ];
  for (const [project, kind, env, state, min, decision] of acts) {
    const params = { env, project };
    await pool.query(
      `INSERT INTO ops_actions (project, kind, env, params, params_hash, target, diff, policy_decision, policy_reason,
                                state, requested_by_type, requested_by_id, via, idempotency_key, decided_by, decided_at,
                                result, error, created_at, updated_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, $8, $9, 'user', $10, $11, $12, $13, $14, $15, $16, $14, $14, $14)`,
      [
        project,
        kind,
        env,
        JSON.stringify(params),
        createHash('sha256').update(randomUUID()).digest('hex'),
        JSON.stringify(
          kind.startsWith('pages')
            ? { pagesProject: 'marketing-site', branch: env === 'production' ? 'main' : 'preview' }
            : { connection: 'Acme Coolify', resources: [`${project}-${env ?? ''}`] },
        ),
        decision,
        decision === 'auto'
          ? 'Önizleme ortamı: politika otomatik çalıştırır.'
          : 'Üretim: onay ve doğrulama kodu.',
        state,
        userId,
        kind.startsWith('pages') ? 'chat' : 'api',
        `deck-${randomBytes(6).toString('hex')}`,
        decision === 'auto' ? null : userId,
        ago(min),
        state === 'succeeded'
          ? JSON.stringify(
              kind.startsWith('pages')
                ? {
                    url: `https://${env === 'production' ? 'www' : 'preview'}.acme.example`,
                    deploymentId: randomBytes(4).toString('hex'),
                  }
                : { deploymentUuid: randomBytes(6).toString('hex'), status: 'finished' },
            )
          : null,
        state === 'failed' ? 'Sağlık kontrolü 120 sn içinde yanıt vermedi.' : null,
      ],
    );
  }
}

async function seedCatalog(pool: Pool): Promise<void> {
  const commit = sha('catalog');
  const skills: [string, string, number, number][] = [
    ['pdf', 'PDF dosyalarını okuma, birleştirme, form doldurma ve oluşturma.', 9, 61_000],
    ['docx', 'Word belgeleri oluşturma ve düzenleme; izlenen değişiklikler ve yorumlar.', 12, 98_000],
    ['xlsx', 'Elektronik tablolar: formüller, biçimlendirme, grafikler ve veri temizliği.', 8, 54_000],
    ['pptx', 'Sunum dosyaları oluşturma, düzenleme ve şablondan slayt üretme.', 11, 87_000],
    ['frontend-design', 'Özgün, üretim kalitesinde arayüzler ve bileşenler tasarlama.', 3, 14_000],
    [
      'webapp-testing',
      'Playwright ile yerel web uygulamalarını test etme ve ekran görüntüsü alma.',
      6,
      22_000,
    ],
    ['mcp-builder', 'Yüksek kaliteli MCP sunucuları geliştirme rehberi.', 14, 120_000],
    ['brand-guidelines', 'Marka renkleri ve tipografisini çıktılara uygulama.', 2, 6_000],
  ];
  const listing = skills.map(([name, description, fileCount, totalBytes]) => ({
    id: `anthropic:skills/${name}`,
    sourceId: 'anthropic',
    repo: 'anthropics/skills',
    path: `skills/${name}`,
    commit,
    name,
    description,
    fileCount,
    totalBytes,
    fit: totalBytes > 100_000 ? 'v2' : 'v1',
    url: `https://github.com/anthropics/skills/tree/${commit}/skills/${name}`,
  }));
  await pool.query(
    `UPDATE skill_catalog_sources SET listing = $1, listing_commit = $2, listed_at = now(), list_tried_at = now(),
            list_error = NULL WHERE id = 'anthropic'`,
    [JSON.stringify(listing), commit],
  );
}

/**
 * The weekly content calendar of the content-studio work area (engine 2): Claude Code plans, writes and reviews,
 * Codex is used only for the image step (per-step `runtime`), a human approves before the posts are scheduled.
 */
function contentDefinition(): Record<string, unknown> {
  const ai = (id: string, role: string, runtime: string, label: string, title: string, prompt: string) => ({
    id,
    type: 'ai.step',
    role,
    runtime,
    label,
    title,
    prompt,
  });
  const col = (x: number, y = 0) => ({ x: x * 280, y: y * 160 });
  return {
    schemaVersion: 2,
    name: L('haftalik-icerik-takvimi', 'weekly-content-calendar'),
    description: L(
      'Haftalık sosyal medya takvimi: Claude Code planlar, metinleri yazar ve gözden geçirir; Codex yalnızca görselleri üretir; gönderiler insan onayından sonra zamanlanır.',
      'Weekly social media calendar: Claude Code plans, writes and reviews the posts; Codex only generates the images; the posts are scheduled after a human approval.',
    ),
    inputs: {
      topic: { required: false, description: L('Haftanın odak konusu.', 'Focus topic of the week.') },
    },
    defaults: {
      runtime: 'claude-code',
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 1800 },
    },
    nodes: [
      {
        id: 'weekly',
        type: 'trigger.schedule',
        config: { cron: '0 6 * * 1', catchUp: 'once' },
        label: L('Her pazartesi 09:00', 'Every Monday 09:00'),
      },
      { id: 'manual', type: 'trigger.manual', config: {}, label: L('Elle başlat', 'Start manually') },
      ai(
        'plan',
        'executor',
        'claude-code',
        L('İçerik planı', 'Content plan'),
        L('Haftalık içerik planı', 'Weekly content plan'),
        L(
          'Gelecek haftanın sosyal medya planını çıkar: LinkedIn, Instagram ve X için pazartesi–cuma birer gönderi. Odak: {{inputs.topic}}. Uydurma rakam, müşteri veya bağlantı yok. Planı out/takvim.md olarak yaz.',
          'Plan next week on social media: one post per weekday on LinkedIn, Instagram and X. Focus: {{inputs.topic}}. No invented figures, customers or links. Write the plan to out/calendar.md.',
        ),
      ),
      ai(
        'copy',
        'executor',
        'claude-code',
        L('Gönderi metinleri', 'Post copy'),
        L('Gönderi metinleri', 'Post copy'),
        L(
          'Plandaki 15 gönderinin metnini yaz; kanal sınırlarına ve marka diline uy (LinkedIn ≤ 1300, X ≤ 270 karakter, Instagram en çok 5 etiket). out/gonderiler.md',
          'Write the 15 posts of the plan; respect the channel limits and the brand voice (LinkedIn ≤ 1300, X ≤ 270 characters, Instagram at most 5 hashtags). out/posts.md',
        ),
      ),
      ai(
        'visuals',
        'executor',
        'codex',
        L('Görsel üretimi', 'Image generation'),
        L('Gönderi görselleri', 'Post images'),
        L(
          'Yalnızca görsel üret: gonderiler.md’deki her gün için bir görsel (LinkedIn ve X 1200×675, Instagram 1080×1080), marka renkleri, metin en çok 6 kelime. Görseller out/generated-images/ altına.',
          'Generate images only: one image per day of posts.md (LinkedIn and X 1200×675, Instagram 1080×1080), brand colours, at most 6 words of text. Images go to out/generated-images/.',
        ),
      ),
      ai(
        'review',
        'reviewer',
        'claude-code',
        L('Gözden geçirme', 'Review'),
        L('Takvim ve marka kontrolü', 'Calendar and brand check'),
        L(
          'Takvimi, metinleri ve görselleri birlikte gözden geçir: tutarlılık, iddialar, yazım, kanal sınırları. Puan ver ve en fazla 5 öneri yaz; metni yeniden yazma.',
          'Review the calendar, copy and images together: consistency, claims, spelling, channel limits. Give a score and at most 5 suggestions; do not rewrite the copy.',
        ),
      ),
      {
        id: 'approve',
        type: 'control.approval',
        label: L('İçerik onayı', 'Content approval'),
        config: {
          approverRole: 'operator',
          title: L(
            'Haftalık içerik takvimi onayı (15 gönderi)',
            'Approve the weekly content calendar (15 posts)',
          ),
          details: L(
            'Claude Code gözden geçirmesi: 92/100. Öneriler: X gönderisinde bağlantıyı kısalt; cuma Instagram gönderisinde etiketleri 5’e indir. Görseller: Codex, 3 dosya.',
            'Claude Code review: 92/100. Suggestions: shorten the link in the X post; cut Friday’s Instagram hashtags to 5. Images: Codex, 3 files.',
          ),
          timeoutSec: 3 * 24 * 3600,
        },
      },
      {
        id: 'publish',
        type: 'http.request',
        label: L('Gönderileri zamanla', 'Schedule the posts'),
        config: {
          method: 'POST',
          origin: 'https://social.example.com',
          path: '/v1/posts',
          headers: { 'Content-Type': 'application/json' },
          body: {
            type: 'json',
            value: { $expr: '{"calendar": $node.copy.out.summary, "status": "scheduled"}' },
          },
          timeoutSec: 30,
        },
      },
      {
        id: 'notify',
        type: 'notify.users',
        label: L('Ekibe bildir', 'Notify the team'),
        config: {
          recipients: { creator: true },
          title: L('İçerik takvimi zamanlandı', 'Content calendar scheduled'),
          body: L(
            '15 gönderi sosyal medya planlayıcısına gönderildi.',
            '15 posts were sent to the social media scheduler.',
          ),
          severity: 'info',
        },
      },
      {
        id: 'denied',
        type: 'notify.users',
        label: L('Reddedildi', 'Rejected'),
        config: {
          recipients: { creator: true },
          title: L('İçerik takvimi reddedildi', 'Content calendar rejected'),
          body: '{{ $input.reason ? $input.reason : "-" }}',
          severity: 'info',
        },
      },
    ],
    edges: [
      { from: 'weekly', to: 'plan' },
      { from: 'manual', to: 'plan' },
      { from: 'plan', to: 'copy' },
      { from: 'copy', to: 'visuals' },
      { from: 'visuals', to: 'review' },
      { from: 'review', to: 'approve' },
      { from: 'approve', to: 'publish', fromPort: 'approved' },
      { from: 'approve', to: 'denied', fromPort: 'denied' },
      { from: 'publish', to: 'notify' },
    ],
    layout: {
      positions: {
        weekly: col(0, 0),
        manual: col(0, 1),
        plan: col(1),
        copy: col(2),
        visuals: col(3),
        review: col(4),
        approve: col(5),
        publish: col(6),
        denied: col(6, 1),
        notify: col(7),
      },
    },
  };
}

let contentWorkflow = '';
let contentRun = '';

/** Waits (polling the database) until `probe` returns a value. */
async function until<T>(what: string, probe: () => Promise<T | null>, timeoutMs = 120_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await probe();
    if (v !== null) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Defines and starts the content calendar through the API (the signed-in page), then finishes each step job the
 * engine creates; the engine itself moves on and stops at the approval step. Once per run of the spec.
 */
async function seedContentWorkflow(page: Page): Promise<void> {
  if (contentRun !== '') return;
  const csrf = (await page.context().cookies()).find((c) => c.name === '__Host-ras-csrf')?.value ?? '';
  const headers = { 'x-csrf-token': csrf };
  const d = await page.request.post('/api/workflows', {
    headers,
    data: { project: P.content.id, definition: contentDefinition() },
  });
  const def = (await d.json()) as { id?: string };
  if (!d.ok() || def.id === undefined)
    throw new Error(`workflow define ${String(d.status())}: ${JSON.stringify(def)}`);
  contentWorkflow = def.id;
  const r = await page.request.post(`/api/workflows/${def.id}/runs`, {
    headers,
    data: {
      inputs: { topic: L('Yeni müşteri portalı: fatura PDF’i', 'The new customer portal: invoice PDF') },
    },
  });
  const run = (await r.json()) as { runId?: string };
  if (!r.ok() || run.runId === undefined)
    throw new Error(`workflow run ${String(r.status())}: ${JSON.stringify(run)}`);
  contentRun = run.runId;
  const images = await (async () => {
    const p = await page.context().browser()?.newPage();
    if (p === undefined) return [];
    try {
      return await renderImages(p, SOCIAL);
    } finally {
      await p.close();
    }
  })();
  const steps: [string, Parameters<typeof finishStepJob>[2]][] = [
    [
      'plan',
      {
        machine: M.mac,
        model: 'claude-sonnet-5',
        summary: L(
          '44. hafta planı hazır: 3 kanal × 5 gün = 15 gönderi. Tema: yeni müşteri portalı ve fatura PDF’i; cuma webinar daveti.',
          'Week 44 plan ready: 3 channels × 5 days = 15 posts. Theme: the new customer portal and the invoice PDF; Friday the webinar invitation.',
        ),
        logs: [
          L('› Geçen haftanın etkileşim özeti okunuyor\n', '› Reading last week’s engagement summary\n'),
          L('› out/takvim.md yazıldı (15 gönderi)\n', '› out/calendar.md written (15 posts)\n'),
        ],
        files: [
          {
            name: L('takvim.md', 'calendar.md'),
            content: Buffer.from(
              L(
                '# 44. hafta içerik takvimi\n\n| Gün | LinkedIn | Instagram | X |\n|---|---|---|---|\n| Pzt | Fatura PDF duyurusu | Ekip arkası | Kısa duyuru |\n| Çar | Müşteri ipucu | 3 ipucu karuseli | Anket |\n| Cum | Webinar daveti | Geri sayım | Webinar bağlantısı |\n',
                '# Week 44 content calendar\n\n| Day | LinkedIn | Instagram | X |\n|---|---|---|---|\n| Mon | Invoice PDF announcement | Behind the scenes | Short announcement |\n| Wed | Customer tip | 3-tip carousel | Poll |\n| Fri | Webinar invitation | Countdown | Webinar link |\n',
              ),
            ),
          },
        ],
      },
    ],
    [
      'copy',
      {
        machine: M.mac,
        model: 'claude-sonnet-5',
        summary: L(
          '15 gönderi metni hazır (LinkedIn 5, Instagram 5, X 5); karakter sınırları ve marka dili kontrol edildi.',
          '15 posts written (LinkedIn 5, Instagram 5, X 5); character limits and the brand voice checked.',
        ),
        logs: [L('› out/gonderiler.md yazıldı\n', '› out/posts.md written\n')],
        files: [
          {
            name: L('gonderiler.md', 'posts.md'),
            content: Buffer.from(
              L(
                '## Pazartesi · LinkedIn\n\nFaturalarınız artık tek tıkla PDF: logonuz ve KDV dökümüyle. Müşteri portalında bugün herkese açık.\n\n## Pazartesi · X\n\nFaturalar artık PDF olarak iniyor. Logo + KDV dökümü dahil.\n',
                '## Monday · LinkedIn\n\nYour invoices are now one click away as PDF: with your logo and the VAT breakdown. Live in the customer portal for everyone today.\n\n## Monday · X\n\nInvoices now download as PDF. Logo + VAT breakdown included.\n',
              ),
            ),
          },
        ],
      },
    ],
    [
      'visuals',
      {
        machine: M.gpu,
        model: 'gpt-5.5-codex',
        summary: L(
          '3 görsel üretildi ve out/generated-images/ altına kaydedildi (1200×675 ve 1080×1080).',
          '3 images generated and saved under out/generated-images/ (1200×675 and 1080×1080).',
        ),
        logs: [
          L('› gonderiler.md okunuyor (girdi dosyası)\n', '› Reading posts.md (input file)\n'),
          L('› Görsel üretimi: 3 görsel tamamlandı\n', '› Image generation: 3 images completed\n'),
        ],
        files: images,
      },
    ],
    [
      'review',
      {
        machine: M.mac,
        model: 'claude-sonnet-5',
        summary: L(
          'Takvim tutarlı, puan 92/100. Öneriler: X gönderisinde bağlantıyı kısalt; cuma Instagram gönderisinde etiketleri 5’e indir.',
          'The calendar is consistent, score 92/100. Suggestions: shorten the link in the X post; cut Friday’s Instagram hashtags to 5.',
        ),
        logs: [
          L('› Takvim, metinler ve 3 görsel gözden geçirildi\n', '› Calendar, copy and 3 images reviewed\n'),
        ],
      },
    ],
  ];
  for (const [node, finish] of steps) {
    const jobId = await until(`the ${node} step job`, () =>
      withE2ePool(async (pool) => {
        const q = await pool.query(
          `SELECT l.job_id FROM workflow_node_runs nr JOIN workflow_node_run_jobs l ON l.node_run_id = nr.id
            WHERE nr.run_id = $1 AND nr.node_id = $2 ORDER BY l.created_at DESC LIMIT 1`,
          [contentRun, node],
        );
        return typeof q.rows[0]?.job_id === 'string' ? q.rows[0].job_id : null;
      }),
    );
    // A few seconds of "work" so the step jobs do not end in the second they were created.
    await sleep(4000);
    await withE2ePool((pool) => finishStepJob(pool, jobId, finish));
    ids[`content-${node}`] = jobId;
  }
  await until('the approval step', () =>
    withE2ePool(async (pool) => {
      const q = await pool.query(
        `SELECT state FROM workflow_node_runs WHERE run_id = $1 AND node_id = 'approve' AND state = 'waiting'`,
        [contentRun],
      );
      return q.rows.length > 0 ? true : null;
    }),
  );
}

const workers: FakeWorker[] = [];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  await mkdir(OUT, { recursive: true });
  await resetRateLimits();
  admin = await createEnrolledAdmin('deck');
  for (const m of Object.values(M)) {
    const w = await startFakeWorker(admin, {
      project: m.project,
      repoUrl: 'https://git.example.com/acme/app.git',
    });
    workers.push(w);
    m.id = w.id;
  }
  await withE2ePool(async (pool) => {
    await pool.query(`UPDATE users SET username = $2, locale = $3 WHERE username = $1`, [
      admin.username,
      USERNAME,
      EN ? 'en' : 'tr',
    ]);
  });
  await seedWorld();
  const page = await browser.newPage();
  const images = await renderImages(page, CAMPAIGN);
  const chart = await renderChart(page);
  await page.close();
  await withE2ePool(async (pool) => {
    await seedEvents(pool, ids.running ?? '');
    await seedApprovals(pool);
    await seedOutputs(pool, ids.landing ?? '', images, 180);
    await seedOutputs(pool, ids.research ?? '', [...RESEARCH_FILES(), chart], 120);
    await seedOutputs(
      pool,
      ids.contentDraft ?? '',
      [
        {
          name: L('bulten-kasim-taslak.md', 'newsletter-november-draft.md'),
          content: Buffer.from(
            L(
              '# Kasım bülteni (taslak)\n\nFaturalarınız artık tek tıkla PDF olarak iniyor: logonuz ve KDV dökümüyle.\n\n## Bu ayın iki ipucu\n\n1. Hatırlatmaları otomatik gönderin.\n2. Ödeme bağlantısını faturaya ekleyin.\n\n## Webinar: Ajanlarla DevOps\n\n12 Kasım, 14:00. Ücretsiz kayıt.\n',
              '# November newsletter (draft)\n\nYour invoices now download as PDF in one click: with your logo and the VAT breakdown.\n\n## Two tips this month\n\n1. Send reminders automatically.\n2. Add the payment link to the invoice.\n\n## Webinar: DevOps with agents\n\n12 November, 14:00. Free registration.\n',
            ),
          ),
        },
      ],
      70,
    );
    await seedDeploys(pool);
    await seedCatalog(pool);
  });
  await seedAudit();
  // pi-edge goes offline (its worker process stops; the master marks it offline when the socket closes).
  await workers.find((w) => w.id === M.pi.id)?.stop();
});

test.afterAll(async () => {
  for (const w of workers) await w.stop();
});

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/Username|Kullanıcı adı/).fill(USERNAME);
  await page.getByLabel(/^(Password|Parola)$/).fill(admin.password);
  await page.getByRole('button', { name: /^(Continue|Devam et)$/ }).click();
  const code = page.getByLabel(/6-digit code|6 haneli kod/);
  await code.fill(await admin.authenticator.nextCode());
  await code.press('Enter').catch(() => undefined);
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 20_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}${name}.png`, animations: 'disabled' });
}

async function attempt(name: string, fn: () => Promise<void>): Promise<void> {
  if (!want(name.slice(0, 2))) return;
  try {
    await fn();
  } catch (err) {
    console.log(
      `SHOT FAILED ${name}: ${err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)}`,
    );
  }
}

async function deckContext(
  browser: Browser,
  scheme: 'light' | 'dark',
  opts: { readonly phone?: boolean; readonly plan?: boolean } = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    // 18d: a phone (390x844 @3x, touch).
    viewport: opts.phone === true ? { width: 390, height: 844 } : { width: VW ?? 1600, height: VH ?? 1000 },
    deviceScaleFactor: opts.phone === true ? 3 : Number(process.env.DECK_DPR ?? 2),
    ...(opts.phone === true ? { isMobile: true, hasTouch: true } : {}),
    locale: EN ? 'en-US' : 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    colorScheme: scheme,
    reducedMotion: 'reduce',
  });
  context.setDefaultTimeout(15_000);
  await context.route('**/api/chat/status', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({
      response: res,
      json: {
        ...body,
        enabled: true,
        available: true,
        code: null,
        message: null,
        worker: { id: M.build.id, name: M.build.name, online: true },
        // 18: the answering machine has the plan tools (the Planla chip is on).
        ...(opts.plan === true ? { plan: true } : {}),
      },
    });
  });
  // Pairing notices of the throw-away workers (their pre-rename host name) and the empty weekly report.
  await withE2ePool(async (pool) => {
    await pool.query(`DELETE FROM notifications WHERE kind = 'worker.pending' OR title ILIKE '%report%'`);
  });
  return context;
}

for (const scheme of ['light', 'dark'] as const) {
  test(`deck shots (${scheme})`, async ({ browser }) => {
    const context = await deckContext(browser, scheme);
    const page = await context.newPage();
    await resetRateLimits();
    const sfx = scheme === 'dark' ? '-dark' : '';
    const dark = scheme === 'dark' && !ALL_DARK;
    if (process.env.DECK_LOGIN === '1') {
      await page.goto('/login');
      await shot(page, `00-login${sfx}`);
    }
    await signIn(page);
    try {
      await seedContentWorkflow(page);
    } catch (err) {
      console.log(`CONTENT WORKFLOW FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }

    await attempt(`01-home${sfx}`, async () => {
      await page.goto('/');
      await expect(page.getByText('build-01').first()).toBeVisible();
      await shot(page, `01-home${sfx}`);
      if (scheme === 'light') {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${OUT}01b-home-full.png`, fullPage: true, animations: 'disabled' });
      }
    });
    if (!dark) {
      await attempt('02-chat-job-cards', async () => {
        await page.goto(`/chat/${threadId}`);
        await expect(page.getByText(tx('PDF şablonuna e-imza alanı ekle')).first()).toBeVisible();
        await page.getByText(tx('Müşteri portalında faturalar PDF')).first().scrollIntoViewIfNeeded();
        await shot(page, `02-chat-job-cards${sfx}`);
      });
      await attempt('03-chat-question', async () => {
        await page.goto(`/chat/${threadId}`);
        await expect(page.getByText(tx('Duyuruyu hazırlamadan önce')).first()).toBeVisible();
        await page
          .getByRole('button', { name: EN ? /Answer/ : /Yanıtla/ })
          .last()
          .click();
        await expect(page.getByText(tx('Duyuru hangi kanallardan gitsin?')).first()).toBeVisible();
        await page
          .getByText(tx('Duyuruyu hazırlamadan önce'))
          .first()
          .evaluate((el) => {
            el.scrollIntoView({ block: 'start' });
          });
        await page.mouse.move(1000, 500);
        await page.mouse.wheel(0, -60);
        await shot(page, `03-chat-question${sfx}`);
      });
    }
    await attempt(`04-jobs${sfx}`, async () => {
      await page.goto('/jobs');
      await expect(page.getByText(tx('Fatura ekranına PDF dışa aktarma ekle')).first()).toBeVisible();
      await shot(page, `04-jobs${sfx}`);
    });
    await attempt(`05-job-live${sfx}`, async () => {
      await page.goto(`/jobs/${ids.running ?? ''}`);
      await expect(page.getByText(tx('Testler geçti')).first()).toBeVisible();
      await shot(page, `05-job-live${sfx}`);
    });
    await attempt(`06-machines${sfx}`, async () => {
      await page.goto('/machines');
      await expect(page.getByText('win-ops-02').first()).toBeVisible();
      await shot(page, `06-machines${sfx}`);
    });
    if (dark) return;
    await attempt('07-machine-detail', async () => {
      await page.goto(`/machines/${M.build.id}`);
      await expect(page.getByRole('heading', { name: 'build-01' }).first()).toBeVisible();
      await shot(page, `07-machine-detail${sfx}`);
    });
    await attempt('10-projects', async () => {
      await page.goto(`/projects/${tx(P.site.id)}`);
      await page.getByRole('tab', { name: L('Deploy', 'Deploys') }).click();
      await shot(page, `10-project-deploy${sfx}`);
      await page.goto('/deploys');
      await shot(page, `10b-deploys${sfx}`);
    });
    await attempt('11-usage', async () => {
      await page.goto('/usage');
      await expect(page.getByText(L('Limit pencereleri', 'Limit windows')).first()).toBeVisible();
      await shot(page, `11-usage${sfx}`);
      await page.getByRole('tab', { name: L('Limitler ve kotalar', 'Limits and quotas') }).click();
      await shot(page, `11b-usage-limits${sfx}`);
    });
    await attempt('12-security', async () => {
      await page.goto('/settings/security');
      await page.getByRole('tab', { name: L('Hazır ayarlar', 'Presets') }).click();
      await shot(page, `12-security-presets${sfx}`);
      await page.getByRole('tab', { name: L('Kod istenen olaylar', 'Events that ask for a code') }).click();
      await shot(page, `12b-security-events${sfx}`);
      await page.getByRole('tab', { name: L('Ajan otonomisi', 'Agent autonomy') }).click();
      await shot(page, `12c-security-autonomy${sfx}`);
    });
    await attempt('13-skills', async () => {
      await page.goto('/skills');
      await page.getByRole('tab', { name: L('Keşfet', 'Discover') }).click();
      await expect(page.getByText('frontend-design').first()).toBeVisible();
      await shot(page, `13-skills-discover${sfx}`);
    });
    await attempt('14-outputs', async () => {
      await page.goto('/outputs');
      await expect(page.getByText('hero-1.png').first()).toBeVisible();
      await shot(page, `14a-outputs${sfx}`);
      await page.getByText('hero-1.png').first().click();
      // The lightbox portals to <body>, outside the [data-ui=diyalog] token scope and under the drawer's top-layer
      // <dialog>: give <body> the scope and hide the drawer so the shot shows the lightbox as designed.
      await page.evaluate(() => {
        const ui = document.querySelector('[data-ui]');
        document.body.setAttribute('data-ui', ui?.getAttribute('data-ui') ?? 'diyalog');
      });
      await page.getByTestId('zoom-image').first().click();
      await expect(page.getByTestId('lightbox')).toBeVisible();
      // The lightbox may itself live in a top-layer dialog now: hide only the dialogs that do not hold it.
      await page.addStyleTag({
        content: "dialog[open]:not(:has([data-testid='lightbox'])){visibility:hidden!important}",
      });
      await shot(page, `14-outputs-lightbox${sfx}`);
    });
    await attempt('16-content-workflow', async () => {
      if (contentRun === '') throw new Error('no content workflow run');
      await page.goto(`/jobs/workflows/${encodeURIComponent(contentRun)}`);
      await expect(
        page.getByText(L('haftalik-icerik-takvimi', 'weekly-content-calendar')).first(),
      ).toBeVisible();
      await page.waitForTimeout(3000);
      await shot(page, `16c-content-workflow-run-full${sfx}`);
      // Zoom into the graph around the steps and select the approval step (its gate shows in the side panel).
      await page.mouse.move(645, 700);
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(800);
      await page
        .getByText('approve', { exact: true })
        .first()
        .click()
        .catch(() => undefined);
      await page.waitForTimeout(1500);
      await shot(page, `16-content-workflow-run${sfx}`);
      await page.goto(`/workflows/${encodeURIComponent(contentWorkflow)}`);
      await page.waitForTimeout(3000);
      await page.mouse.move(640, 584);
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(800);
      // The image step: its inspector shows the per-step runtime (Codex) next to the Claude Code steps.
      await page
        .getByText('visuals', { exact: true })
        .first()
        .click()
        .catch(() => undefined);
      await page.waitForTimeout(1200);
      await shot(page, `16b-content-workflow-editor${sfx}`);
    });
    await attempt('17-research-outputs', async () => {
      await page.goto(`/outputs?project=${P.research.id}`);
      await expect(page.getByText('competitors.csv').first()).toBeVisible();
      await shot(page, `17b-research-outputs-list${sfx}`);
      await page.getByText(L('rapor.md', 'report.md'), { exact: true }).first().click();
      await page.waitForTimeout(1500);
      await shot(page, `17-research-outputs${sfx}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.getByText('competitors.csv', { exact: true }).first().click();
      await page.waitForTimeout(1500);
      await shot(page, `17c-research-competitors${sfx}`);
    });
    await attempt('08-workflow', async () => {
      const csrf = (await context.cookies()).find((c) => c.name === '__Host-ras-csrf')?.value ?? '';
      const r = await page.request.post('/api/workflows/templates/content-production/instantiate', {
        headers: { 'x-csrf-token': csrf },
        data: {
          project: tx(P.site.id),
          name: L('blog-icerik-uretimi', 'blog-content-production'),
          locale: EN ? 'en' : 'tr',
          values: {
            research_origin: 'https://search.acme.example',
            research_path: '/search',
            cms_origin: 'https://cms.acme.example',
            cms_path: '/api/posts',
            cms_status: 'draft',
            runtime: 'claude-code',
          },
        },
      });
      const body = (await r.json()) as { id?: string };
      console.log('WORKFLOW', r.status(), JSON.stringify(body).slice(0, 600));
      await page.goto(`/workflows/${encodeURIComponent(body.id ?? '')}`);
      await page.waitForTimeout(3000);
      await shot(page, `08c-workflow-editor-full${sfx}`);
      await page.mouse.move(640, 596);
      for (let i = 0; i < 7; i++) {
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(800);
      await shot(page, `08b-workflow-editor-zoom${sfx}`);
      await page.getByText('draft', { exact: true }).first().click();
      await page.waitForTimeout(1200);
      await shot(page, `08-workflow-editor${sfx}`);
      await page.goto('/workflows');
      await shot(page, `08d-workflows${sfx}`);
    });
    await context.close();
  });
}

/**
 * p18-plan-mode (18): two planned conversations, written through the master's own plan service (master/dist
 * ChatPlanService + QuestionService on the e2e pool, as the plan tools of a turn call them; the tool lines carry the
 * meta the turn writes). "Fatura PDF dışa aktarma lansmanı" (customer-portal) is approved and executing: its job items
 * follow their jobs (the service's own derivation: the research job and the newsletter draft succeeded → done, the PDF
 * job runs → in progress), the assistant writes the release note, one decision waits. "Kasım kampanyası"
 * (content-studio) is in review in plan mode with two decisions, each with a recommended option. Only when 18 is
 * taken, so the conversation list of 02 / 03 stays as it was.
 */
const plans = { launch: '', campaign: '', launchThread: '', campaignThread: '' };

interface PlanServiceLike {
  create(c: Record<string, unknown>, raw: Record<string, unknown>): Promise<PlanOut>;
  askDecision(c: Record<string, unknown>, input: Record<string, unknown>): Promise<PlanOut>;
  setStatus(c: Record<string, unknown>, input: Record<string, unknown>): Promise<PlanOut>;
  approve(actor: Record<string, unknown>, planId: string, version: number): Promise<unknown>;
  tick(): Promise<number>;
}
type PlanOut =
  { ok: true; plan?: { id: string; version: number }; questionId?: string } | { ok: false; message: string };

async function planService(pool: Pool, clock: () => Date): Promise<PlanServiceLike> {
  const dist = new URL('../../master/dist/', import.meta.url);
  const { ChatPlanService } = (await import(new URL('chat/plans.js', dist).href)) as {
    ChatPlanService: new (deps: Record<string, unknown>) => PlanServiceLike;
  };
  const { QuestionService } = (await import(new URL('questions/service.js', dist).href)) as {
    QuestionService: new (deps: Record<string, unknown>) => unknown;
  };
  const { AuditLog } = (await import(new URL('audit/audit.js', dist).href)) as {
    AuditLog: new (pool: unknown, clock?: () => Date) => unknown;
  };
  const noop = (): void => undefined;
  const log = {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => log,
  };
  const audit = new AuditLog(pool, clock);
  const questions = new QuestionService({ pool, audit, clock, log });
  return new ChatPlanService({
    pool,
    audit,
    clock,
    log,
    // Events go to the master's streams; the console reads the plan with the conversation here.
    store: {
      thread: () => Promise.reject(new Error('not used')),
    },
    publish: noop,
    questions: () => questions,
    // No continuation turn from the seed (the conversation's assistant is not this process).
    chat: () => null,
  });
}

const must = (what: string, out: PlanOut): PlanOut & { ok: true } => {
  if (!out.ok) throw new Error(`${what}: ${out.message}`);
  return out;
};

async function seedPlans(): Promise<void> {
  if (plans.launch !== '') return;
  await withE2ePool(async (pool) => {
    let now = ago(30);
    const svc = await planService(pool, () => now);
    const thread = async (title: string, project: string, startMin: number): Promise<string> => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO chat_threads (id, user_id, title, project, created_at, updated_at, next_seq)
         VALUES ($1, $2, $3, $4, $5, now(), 1)`,
        [id, userId, title, project, ago(startMin)],
      );
      return id;
    };
    const writer = (tid: string) => {
      let seq = 0;
      return async (
        role: string,
        content: string,
        min: number,
        meta: unknown = null,
        turn: string | null = null,
      ) => {
        seq += 1;
        await pool.query(
          `INSERT INTO chat_messages (id, thread_id, seq, role, content, meta, turn_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            tid,
            seq,
            role,
            content,
            meta === null ? null : JSON.stringify(meta),
            turn,
            ago(min),
          ],
        );
        return seq;
      };
    };
    const close = async (tid: string, last: number): Promise<void> => {
      await pool.query(`UPDATE chat_threads SET next_seq = $2 WHERE id = $1`, [tid, last + 1]);
      await pool.query(
        `INSERT INTO chat_thread_reads (thread_id, user_id, last_read_seq, last_read_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_seq = EXCLUDED.last_read_seq`,
        [tid, userId, last],
      );
    };
    const planTool = (name: string, planId: string, questionId?: string) => ({
      name,
      isError: false,
      ...(questionId === undefined ? {} : { questionId }),
      planId,
      planVersion: 1,
    });

    // --- The launch plan: approved and executing.
    const tA = await thread('Fatura PDF dışa aktarma lansmanı', P.portal.id, 26);
    const msgA = writer(tA);
    const turnA1 = randomUUID();
    await msgA(
      'user',
      'Fatura PDF özelliğinin lansmanını planla: geliştirme, birleştirme onayı ve müşteri duyurusu. Önce planla, sonra adım adım ilerle.',
      25,
      { origin: 'user', planMode: true },
    );
    await msgA('tool', 'Proje ayarları okundu', 24.8, { name: 'get_project', isError: false }, turnA1);
    now = ago(24.5);
    const callerA = { userId, threadId: tA, turnId: turnA1, planMode: true };
    const created = must(
      'launch plan',
      await svc.create(callerA, {
        title: 'Fatura PDF dışa aktarma lansmanı',
        goal: 'Müşteriler faturalarını logolu ve KDV dökümlü PDF olarak indirebilsin; özellik testlerden geçip yayına çıksın ve müşterilere duyurulsun.',
        assumptions: [
          'PDF işi build-01 üzerinde çalışmaya devam ediyor.',
          'Duyuru metni İçerik Stüdyosu’nda hazırlanır.',
        ],
        risks: ['E-imza alanı için hukuk onayı gecikebilir.'],
        phases: [
          {
            title: L('Hazırlık', 'Preparation'),
            items: [
              {
                key: 'competitor-scan',
                title: 'Rakiplerin fatura PDF özelliklerini karşılaştır',
                owner: 'job',
                project: P.research.id,
                estimate: 'S',
              },
              {
                key: 'pdf-scope',
                title: 'PDF içeriğini netleştir: logo, KDV dökümü, e-imza',
                activeTitle: 'PDF içeriği netleştiriliyor',
                owner: 'assistant',
                estimate: 15,
              },
            ],
          },
          {
            title: L('Geliştirme', 'Development'),
            items: [
              {
                key: 'pdf-export',
                title: 'Fatura ekranına PDF dışa aktarma ekle',
                activeTitle: 'PDF dışa aktarma geliştiriliyor',
                owner: 'job',
                project: P.portal.id,
                dependsOn: ['pdf-scope'],
                estimate: 90,
              },
              {
                key: 'e-sign',
                title: 'PDF şablonuna e-imza alanı ekle',
                owner: 'job',
                project: P.portal.id,
                dependsOn: ['pdf-export'],
                estimate: 60,
              },
              {
                key: 'merge',
                title: 'Birleştirme onayını ver',
                owner: 'user',
                dependsOn: ['pdf-export', 'e-sign'],
                estimate: 5,
              },
            ],
          },
          {
            title: L('Lansman', 'Launch'),
            items: [
              {
                key: 'release-notes',
                title: 'Sürüm notunu ve yardım makalesini yaz',
                activeTitle: 'Sürüm notu ve yardım makalesi yazılıyor',
                owner: 'assistant',
                dependsOn: ['pdf-scope'],
                estimate: 30,
              },
              {
                key: 'newsletter',
                title: 'Kasım bültenine PDF haberini ekle',
                owner: 'job',
                project: P.content.id,
                estimate: 20,
              },
              {
                key: 'announce',
                title: 'Müşteri duyurusunu yayınla',
                owner: 'workflow',
                project: P.content.id,
                dependsOn: ['merge', 'release-notes'],
                estimate: 20,
              },
            ],
          },
        ],
      }),
    );
    plans.launch = created.plan?.id ?? '';
    await msgA('tool', 'plan_create: plan v1', 24.5, planTool('plan_create', plans.launch), turnA1);
    await msgA(
      'assistant',
      'Lansmanı 3 aşamada 8 maddelik bir plana döktüm. PDF işi build-01’de zaten çalışıyor, onu plana bağlayacağım. İnceleyip onaylarsan sürüm notuyla başlıyorum.',
      24.3,
      null,
      turnA1,
    );
    now = ago(20);
    await svc.approve({ userId, ip: '198.51.100.24', userAgent: 'Mozilla/5.0' }, plans.launch, 1);
    const turnA2 = randomUUID();
    await msgA(
      'user',
      'Onaylı plan v1 — sıradaki madde: Rakiplerin fatura PDF özelliklerini karşılaştır (competitor-scan). Planı sürdür.',
      19.8,
      { origin: 'plan', plan: { id: plans.launch, next: 'competitor-scan' } },
    );
    const callerA2 = { ...callerA, turnId: turnA2, planMode: false };
    now = ago(19.5);
    must(
      'launch statuses',
      await svc.setStatus(callerA2, {
        planId: plans.launch,
        items: [
          {
            key: 'competitor-scan',
            status: 'in_progress',
            link: {
              kind: 'job',
              id: ids.research ?? '',
              label: L('Rakip analizi işi', 'Competitor analysis job'),
            },
          },
          { key: 'pdf-scope', status: 'done' },
          {
            key: 'pdf-export',
            status: 'in_progress',
            link: { kind: 'job', id: ids.running ?? '', label: L('Fatura PDF işi', 'Invoice PDF job') },
          },
          {
            key: 'newsletter',
            status: 'in_progress',
            link: {
              kind: 'job',
              id: ids.contentDraft ?? '',
              label: L('Kasım bülteni', 'November newsletter'),
            },
          },
        ],
      }),
    );
    await msgA('tool', 'plan_set_status: ok', 19.5, { name: 'plan_set_status', isError: false }, turnA2);
    now = ago(6);
    must(
      'release notes',
      await svc.setStatus(callerA2, {
        planId: plans.launch,
        items: [{ key: 'release-notes', status: 'in_progress' }],
      }),
    );
    await msgA('tool', 'plan_set_status: ok', 6, { name: 'plan_set_status', isError: false }, turnA2);
    now = ago(5.5);
    const decA = must(
      'launch decision',
      await svc.askDecision(callerA2, {
        planId: plans.launch,
        itemKey: 'announce',
        prompt: 'Müşteri duyurusu ne zaman gitsin?',
        kind: 'single',
        options: [
          {
            label: 'Birleştirmeden sonraki salı',
            description: 'Destek ekibi hazır olur; bülten aynı haftaya denk gelir.',
          },
          { label: 'Birleştirme günü', description: 'En hızlı yol; destek ekibine hazırlık süresi kalmaz.' },
          { label: 'E-imza ile birlikte', description: 'Tek duyuru; lansman yaklaşık bir hafta kayar.' },
        ],
        recommended: 'Birleştirmeden sonraki salı',
        rationale:
          'Salı gönderimlerinde açılma oranı en yüksek; destek ekibi yeni soruları karşılamaya hazır olur.',
      }),
    );
    await msgA(
      'tool',
      'plan_ask_decision: plan v1',
      5.5,
      planTool('plan_ask_decision', plans.launch, decA.questionId),
      turnA2,
    );
    const lastA = await msgA(
      'assistant',
      'Rakip analizi ve Kasım bülteni hazır. PDF dışa aktarma işi build-01’de çalışıyor; bitince birleştirme onayı sana düşecek. Bu arada sürüm notunu ve yardım makalesini yazıyorum. Duyurunun zamanı için bir karar gerekiyor, önerimi işaretledim.',
      5,
      null,
      turnA2,
    );
    // The job items follow their jobs (the service's own derivation, as the master's tick does).
    now = ago(4.5);
    await svc.tick();
    // The assistant of this conversation is not reachable from the seed: no continuation is pending.
    await pool.query(`UPDATE chat_plans SET cont_due = false WHERE id = $1`, [plans.launch]);
    await close(tA, lastA);
    plans.launchThread = tA;

    // --- The campaign plan: in review, plan mode on, two decisions with a recommendation.
    const tB = await thread('Kasım kampanyası', P.content.id, 4);
    const msgB = writer(tB);
    const turnB = randomUUID();
    await msgB(
      'user',
      'Kasım kampanyasını planla: açılış sayfası, sosyal medya görselleri ve bülten. Önce planla, sonra başlarız.',
      3.5,
      { origin: 'user', planMode: true },
    );
    await msgB('tool', 'Proje ayarları okundu', 3.3, { name: 'get_project', isError: false }, turnB);
    now = ago(3);
    const callerB = { userId, threadId: tB, turnId: turnB, planMode: true };
    const campaign = must(
      'campaign plan',
      await svc.create(callerB, {
        title: 'Kasım kampanyası',
        goal: 'Kasım kampanyasını tek akışta yayına hazırlamak: açılış sayfası, sosyal medya görselleri ve bülten aynı mesajı taşısın; gönderimler takvime bağlansın.',
        assumptions: [
          'Marka renkleri ve logo İçerik Stüdyosu’ndaki kılavuzdan alınır.',
          'Görseller haftalık içerik takvimi iş akışıyla üretilir.',
        ],
        risks: [
          'İndirim oranı netleşmeden açılış sayfası metni yazılamaz.',
          'Görsel onayı bir iş günü sürebilir.',
        ],
        phases: [
          {
            title: L('Araştırma', 'Research'),
            items: [
              {
                key: 'audience',
                title: 'Hedef kitleyi ve ana mesajı belirle',
                activeTitle: 'Hedef kitle ve ana mesaj belirleniyor',
                owner: 'assistant',
                estimate: 20,
              },
              {
                key: 'competitor-offers',
                title: 'Rakiplerin Kasım kampanyalarını tara',
                owner: 'job',
                project: P.research.id,
                estimate: 'M',
              },
            ],
          },
          {
            title: L('İçerik', 'Content'),
            items: [
              {
                key: 'landing',
                title: 'Kampanya açılış sayfasını hazırla',
                owner: 'job',
                project: P.site.id,
                dependsOn: ['audience'],
                estimate: 90,
              },
              {
                key: 'visuals',
                title: 'Sosyal medya görsellerini üret',
                owner: 'workflow',
                project: P.content.id,
                dependsOn: ['audience'],
                estimate: 45,
              },
              {
                key: 'newsletter',
                title: 'Kasım bülten metnini yaz',
                owner: 'job',
                project: P.content.id,
                dependsOn: ['audience'],
                estimate: 40,
              },
            ],
          },
          {
            title: L('Yayın', 'Publishing'),
            items: [
              {
                key: 'review',
                title: 'Metinleri ve görselleri onayla',
                owner: 'user',
                dependsOn: ['landing', 'visuals', 'newsletter'],
                estimate: 15,
              },
              {
                key: 'schedule',
                title: 'Gönderimleri yayın takvimine koy',
                owner: 'workflow',
                project: P.content.id,
                dependsOn: ['review'],
                estimate: 10,
              },
            ],
          },
        ],
      }),
    );
    plans.campaign = campaign.plan?.id ?? '';
    await msgB('tool', 'plan_create: plan v1', 3, planTool('plan_create', plans.campaign), turnB);
    now = ago(2.9);
    const decB1 = must(
      'campaign decision 1',
      await svc.askDecision(callerB, {
        planId: plans.campaign,
        itemKey: 'landing',
        prompt: 'Kampanya indirimi ne kadar olsun?',
        kind: 'single',
        options: [
          { label: '%20 indirim', description: 'Marjı korur; geçen yılın dönüşümüne yakın.' },
          { label: '%30 indirim', description: 'Dönüşüm artar, marj belirgin düşer.' },
          {
            label: 'İlk ay ücretsiz',
            description: 'Yeni müşteri kazandırır; mevcut müşterilere etkisi yok.',
          },
        ],
        recommended: '%20 indirim',
        rationale: 'Geçen Kasım %20 ile dönüşüm %4,1 oldu; %30 marjı daraltır, ek dönüşüm sınırlı kalır.',
      }),
    );
    await msgB(
      'tool',
      'plan_ask_decision: plan v1',
      2.9,
      planTool('plan_ask_decision', plans.campaign, decB1.questionId),
      turnB,
    );
    now = ago(2.8);
    const decB2 = must(
      'campaign decision 2',
      await svc.askDecision(callerB, {
        planId: plans.campaign,
        itemKey: 'schedule',
        prompt: 'Öncelikli kanallar hangileri olsun?',
        kind: 'single',
        options: [
          { label: 'E-posta ve LinkedIn', description: 'Kurumsal müşterilerin çoğu buradan geliyor.' },
          { label: 'Instagram ve X', description: 'Erişim geniş, dönüşüm daha düşük.' },
          { label: 'Tüm kanallar eşit' },
        ],
        recommended: 'E-posta ve LinkedIn',
        rationale: 'Portal müşterilerinin %68’i e-posta ve LinkedIn üzerinden geliyor.',
      }),
    );
    await msgB(
      'tool',
      'plan_ask_decision: plan v1',
      2.8,
      planTool('plan_ask_decision', plans.campaign, decB2.questionId),
      turnB,
    );
    const lastB = await msgB(
      'assistant',
      'Kasım kampanyası için 3 aşamalı, 7 maddelik bir plan hazırladım. Başlamadan önce iki karar gerekiyor; önerilerimi işaretledim. Onaylayınca hedef kitle çalışmasıyla başlarım.',
      2.6,
      null,
      turnB,
    );
    // Plan mode stays on while the plan is in review (a thread state: the badge and the violet composer).
    await pool.query(`UPDATE chat_threads SET plan_mode_since = $2 WHERE id = $1`, [tB, ago(3.6)]);
    await close(tB, lastB);
    plans.campaignThread = tB;
  });
}

/** Every scrolled box inside the test id back at its top (the plan panel scrolls to its current item by itself). */
async function toTop(page: Page, testId: string): Promise<void> {
  await page
    .getByTestId(testId)
    .first()
    .evaluate((root) => {
      for (const el of [root, ...root.querySelectorAll('*')]) if (el.scrollTop > 0) el.scrollTop = 0;
    });
}

test('deck shots (plan mode)', async ({ browser }) => {
  if (!want('18')) return;
  await seedPlans();
  const light = await deckContext(browser, 'light', { plan: true });
  const page = await light.newPage();
  await resetRateLimits();
  await signIn(page);
  await attempt('18-plan-panel', async () => {
    await page.goto(`/chat/${plans.launchThread}`);
    await expect(page.getByTestId('plan-column')).toBeVisible();
    await expect(page.getByTestId('plan-progress').first()).toBeVisible();
    await page.mouse.move(800, 500);
    // The column scrolls to the current item; the second shot keeps that, the first shows the panel from its top.
    await page.waitForTimeout(1500);
    await shot(page, '18-plan-panel-items');
    await toTop(page, 'plan-column');
    await shot(page, '18-plan-panel');
  });
  await attempt('18b-plan-review', async () => {
    await page.goto(`/chat/${plans.campaignThread}`);
    await expect(page.getByTestId('plan-column')).toBeVisible();
    const card = page
      .getByTestId('strip-card')
      .filter({ hasText: tx('Kasım kampanyası') })
      .first();
    await card.getByTestId('strip-details').click();
    await expect(page.getByTestId('plan-card')).toBeVisible();
    await page.getByTestId('plan-card').locator('button[aria-expanded]').first().click();
    await page.getByTestId('plan-card').evaluate((el) => {
      el.scrollIntoView({ block: 'center' });
    });
    await toTop(page, 'plan-column');
    await page.mouse.move(800, 500);
    await shot(page, '18b-plan-review');
  });
  await attempt('18c-plan-mode-composer', async () => {
    await page.goto(`/chat/${plans.campaignThread}`);
    await expect(page.getByTestId('dy-plan-mode')).toBeVisible();
    await expect(page.getByTestId('dy-plan-badge')).toBeVisible();
    await page.getByTestId('plan-toggle').click();
    await expect(page.getByTestId('plan-column')).toBeHidden();
    await page
      .getByTestId('dy-composer-field')
      .fill(tx('Görseller için geçen yılın kampanya renklerini de değerlendir.'));
    await shot(page, '18c-plan-mode-composer');
    // The column stays the person's choice: open again for the next run.
    await page.getByTestId('plan-toggle').click();
  });
  await light.close();
  const phone = await deckContext(browser, 'light', { phone: true, plan: true });
  const mobile = await phone.newPage();
  await signIn(mobile);
  await attempt('18d-plan-phone', async () => {
    await mobile.goto(`/chat/${plans.launchThread}`);
    await expect(mobile.getByTestId('plan-pill')).toBeVisible();
    await shot(mobile, '18d-plan-phone-pill');
    await mobile.getByTestId('plan-mini-pill').click();
    await expect(mobile.getByTestId('plan-sheet')).toBeVisible();
    await mobile.waitForTimeout(800);
    await toTop(mobile, 'plan-sheet');
    await shot(mobile, '18d-plan-phone');
    // Dragged up: the sheet at 90 %.
    await mobile.getByTestId('plan-sheet-handle').focus();
    await mobile.keyboard.press('ArrowUp');
    await mobile.waitForTimeout(800);
    await toTop(mobile, 'plan-sheet');
    await shot(mobile, '18d-plan-phone-full');
  });
  await phone.close();
});

/**
 * The end of the product tour: the job from the chat (02) and the live view (05) is verified and waits for its merge
 * decision (09); the audit trail filtered on that job (15). After both scheme tests, so 05 shows it running.
 */
test('deck shots (merge decision)', async ({ browser }) => {
  if (!want('09') && !want('15')) return;
  await withE2ePool((pool) => pdfToMergeDecision(pool));
  await seedAudit([
    [
      1,
      'system',
      null,
      'approval.request',
      `job:${ids.running ?? ''}`,
      { action: 'git.merge', risk: 'medium' },
    ],
  ]);
  for (const scheme of ALL_DARK ? (['light', 'dark'] as const) : (['light'] as const)) {
    const context = await deckContext(browser, scheme);
    const page = await context.newPage();
    await resetRateLimits();
    const sfx = scheme === 'dark' ? '-dark' : '';
    await signIn(page);
    const job = tx('Fatura ekranına PDF dışa aktarma ekle');
    await attempt('09-approvals', async () => {
      await page.goto('/approvals');
      await expect(page.getByText(EN ? /invoice-pdf/i : /fatura-pdf/i).first()).toBeVisible();
      await shot(page, `09a-approvals${sfx}`);
      await page.goto(`/jobs/${ids.running ?? ''}`);
      await expect(page.getByText(job).first()).toBeVisible();
      await page.waitForTimeout(1000);
      await shot(page, `09-merge-decision${sfx}`);
    });
    await attempt('15-audit', async () => {
      await page.goto('/audit');
      await expect(page.getByText('security.policy.update').first()).toBeVisible();
      await shot(page, `15b-audit-all${sfx}`);
      await page.getByPlaceholder(/UUID/).fill(ids.running ?? '');
      await page.getByRole('button', { name: L('Uygula', 'Apply') }).click();
      await expect(page.getByText('chat.draft.confirm').first()).toBeVisible();
      await page.waitForTimeout(800);
      await shot(page, `15-audit${sfx}`);
    });
    await context.close();
  }
});
