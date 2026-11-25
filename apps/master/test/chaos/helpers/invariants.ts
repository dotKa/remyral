import { execFileSync } from 'node:child_process';
import {
  findRule,
  type ActorType,
  type JobState,
  type JobTrigger,
  TERMINAL_STATES,
} from '@remyral/scheduler';
import { verifyChain } from '../../../src/audit/audit.js';
import type { Queryable } from '../../../src/db/pool.js';
import { ATTEMPT_TRAILER_KEY, trailerValues } from '../../../src/gitflow/refs.js';

/**
 * The shared chaos invariant checker (docs/design/p4-chaos.md §2). Every scenario ends with
 * `await expect.poll(() => checkInvariants(...)).toEqual([])`: structural violations (an illegal
 * transition, a broken audit chain, two commits of one attempt) never heal, so polling only waits for the
 * convergent ones (outbox drained, leases released) and reports the final list otherwise.
 */
export interface InvariantOptions {
  /** Bare repository (path) every attempt pushes to; null skips the remote checks. */
  readonly bareRepo: string | null;
  /** Workers connected right now: their master → worker outbox must drain (others keep theirs durably). */
  readonly connectedWorkers?: readonly string[];
  /** Jobs that must have reached a terminal state (default: none required). */
  readonly terminalJobs?: readonly string[];
}

/** States in which a job may hold an unreleased lease (a worker may be acting, or verification extends it). */
const LEASE_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'RESERVED',
  'STARTING',
  'RUNNING',
  'CANCELLING',
  'VERIFYING',
]);

export async function checkInvariants(db: Queryable, opts: InvariantOptions): Promise<string[]> {
  const out: string[] = [];
  await stateMachine(db, out, opts);
  await auditChain(db, out);
  await leasesAndAttempts(db, out);
  await executions(db, out);
  await outboxes(db, out, opts);
  if (opts.bareRepo !== null) await remote(db, out, opts.bareRepo);
  return out;
}

/** Every job's history is a gap-free chain of legal transitions ending in its current state. */
async function stateMachine(db: Queryable, out: string[], opts: InvariantOptions): Promise<void> {
  const jobs = await db.query<{ id: string; state: JobState; version: number }>(
    'SELECT id, state, version FROM jobs ORDER BY created_at, id',
  );
  const { rows } = await db.query<{
    job_id: string;
    version: number;
    from_state: JobState | null;
    to_state: JobState;
    trigger: JobTrigger | 'create';
    actor_type: ActorType;
  }>(
    `SELECT job_id, version, from_state, to_state, trigger, actor_type FROM job_transitions
      ORDER BY job_id, version`,
  );
  const byJob = new Map<string, typeof rows>();
  for (const r of rows) byJob.set(r.job_id, [...(byJob.get(r.job_id) ?? []), r]);
  const audited = await db.query<{ target: string; n: number }>(
    `SELECT target, count(*)::int AS n FROM audit_events WHERE action = 'job.transition' GROUP BY target`,
  );
  const auditCount = new Map(audited.rows.map((r) => [r.target, r.n]));
  for (const job of jobs.rows) {
    const history = byJob.get(job.id) ?? [];
    const tag = `job ${job.id.slice(0, 8)}`;
    let prev: JobState | null = null;
    for (const [i, t] of history.entries()) {
      if (t.version !== i + 1) out.push(`${tag}: history gap at version ${String(t.version)}`);
      if (i === 0) {
        if (t.trigger !== 'create' || t.from_state !== null)
          out.push(`${tag}: first transition is not create`);
      } else {
        const rule =
          t.from_state === null || t.trigger === 'create' ? undefined : findRule(t.from_state, t.trigger);
        if (t.from_state !== prev)
          out.push(
            `${tag}: v${String(t.version)} starts in ${String(t.from_state)}, previous ended in ${String(prev)}`,
          );
        if (rule === undefined || rule.to !== t.to_state) {
          out.push(`${tag}: illegal ${String(t.from_state)} --${t.trigger}--> ${t.to_state}`);
        } else if (!rule.actors.includes(t.actor_type)) {
          out.push(`${tag}: ${t.trigger} by a ${t.actor_type} is not allowed`);
        }
      }
      prev = t.to_state;
    }
    if (prev !== job.state) out.push(`${tag}: state ${job.state} but history ends in ${String(prev)}`);
    if (history.at(-1)?.version !== job.version) out.push(`${tag}: version ${String(job.version)} ≠ history`);
    // Every transition after create is in the hash-chained audit log (same transaction as the change).
    const expected = history.filter((t) => t.trigger !== 'create').length;
    const got = auditCount.get(`job:${job.id}`) ?? 0;
    if (got !== expected)
      out.push(`${tag}: ${String(expected)} transitions but ${String(got)} audit records`);
    if (opts.terminalJobs?.includes(job.id) === true && !TERMINAL_STATES.has(job.state)) {
      out.push(`${tag}: expected a terminal state, is ${job.state}`);
    }
  }
}

async function auditChain(db: Queryable, out: string[]): Promise<void> {
  const v = await verifyChain(db);
  if (!v.ok) out.push(`audit chain broken at ${v.brokenAtId} (${v.reason})`);
}

/** No orphan leases or attempts: they belong to the job's current attempt/epoch in a lease-holding state. */
async function leasesAndAttempts(db: Queryable, out: string[]): Promise<void> {
  const { rows } = await db.query<{
    job_id: string;
    state: JobState;
    attempt_id: string;
    epoch: number;
    current_attempt_id: string | null;
    lease_epoch: number;
  }>(
    `SELECT l.job_id, j.state, l.attempt_id, l.epoch, j.current_attempt_id, j.lease_epoch
       FROM leases l JOIN jobs j ON j.id = l.job_id WHERE l.released_at IS NULL`,
  );
  for (const l of rows) {
    const tag = `job ${l.job_id.slice(0, 8)}`;
    if (!LEASE_STATES.has(l.state)) out.push(`${tag}: orphan lease epoch ${String(l.epoch)} in ${l.state}`);
    if (l.attempt_id !== l.current_attempt_id) out.push(`${tag}: lease of a non-current attempt`);
    if (l.epoch !== l.lease_epoch)
      out.push(`${tag}: lease epoch ${String(l.epoch)} ≠ job epoch ${String(l.lease_epoch)}`);
  }
  const open = await db.query<{ job_id: string; state: JobState }>(
    `SELECT a.job_id, j.state FROM job_attempts a JOIN jobs j ON j.id = a.job_id WHERE a.state <> 'ended'`,
  );
  for (const a of open.rows) {
    if (TERMINAL_STATES.has(a.state))
      out.push(`job ${a.job_id.slice(0, 8)}: open attempt on a ${a.state} job`);
  }
  const won = await db.query<{ job_id: string; n: number }>(
    `SELECT job_id, count(*)::int AS n FROM job_attempts WHERE outcome = 'succeeded' GROUP BY job_id HAVING count(*) > 1`,
  );
  for (const w of won.rows) out.push(`job ${w.job_id.slice(0, 8)}: ${String(w.n)} succeeded attempts`);
}

/** At most one applied JOB_RESULT per attempt, and every state-changing message came from a live lease. */
async function executions(db: Queryable, out: string[]): Promise<void> {
  const dup = await db.query<{ attempt: string; n: number }>(
    `SELECT payload->>'attemptId' AS attempt, count(*)::int AS n FROM worker_inbox
      WHERE type = 'JOB_RESULT' AND outcome = 'applied' GROUP BY 1 HAVING count(*) > 1`,
  );
  for (const d of dup.rows) out.push(`attempt ${d.attempt.slice(0, 8)}: ${String(d.n)} applied JOB_RESULTs`);
  // Per lease epoch: a paused attempt (approval pause, usage limit, worker restart — p10 / p11) starts its runtime once
  // more under its resume epoch; two starts under one epoch are a double run.
  const runtime = await db.query<{ attempt_id: string; n: number }>(
    `SELECT attempt_id, count(*)::int AS n FROM job_transitions
      WHERE trigger = 'runtime_started' AND attempt_id IS NOT NULL GROUP BY attempt_id, epoch HAVING count(*) > 1`,
  );
  for (const r of runtime.rows)
    out.push(`attempt ${r.attempt_id.slice(0, 8)}: runtime started ${String(r.n)}×`);
  // Every refused (stale) job message is audited as a denial.
  const stale = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM worker_inbox WHERE outcome = 'stale' AND outcome_reason <> 'unknown_job'`,
  );
  const denied = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events WHERE action = 'job.message' AND outcome = 'denied'
        AND metadata->>'denial' = 'stale_epoch'`,
  );
  if ((denied.rows[0]?.n ?? 0) < (stale.rows[0]?.n ?? 0)) {
    out.push(
      `${String(stale.rows[0]?.n)} stale messages but ${String(denied.rows[0]?.n)} stale_epoch denials audited`,
    );
  }
}

async function outboxes(db: Queryable, out: string[], opts: InvariantOptions): Promise<void> {
  // The relay's own topics; others (usage thresholds, notifications) belong to their consumers.
  const pending = await db.query<{ topic: string; n: number }>(
    `SELECT topic, count(*)::int AS n FROM outbox WHERE dispatched_at IS NULL
        AND topic IN ('job.transition', 'approval.decision') GROUP BY topic`,
  );
  for (const p of pending.rows) out.push(`outbox: ${String(p.n)} undispatched ${p.topic}`);
  if ((opts.connectedWorkers ?? []).length > 0) {
    const w = await db.query<{ worker_id: string; n: number }>(
      `SELECT worker_id, count(*)::int AS n FROM worker_outbox WHERE worker_id = ANY($1) GROUP BY worker_id`,
      [opts.connectedWorkers],
    );
    for (const r of w.rows) out.push(`worker_outbox ${r.worker_id}: ${String(r.n)} unacknowledged`);
  }
  const effects = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM worker_inbox WHERE effect_status IN ('pending', 'running')`,
  );
  if ((effects.rows[0]?.n ?? 0) > 0) out.push(`${String(effects.rows[0]?.n)} inbox effects not settled`);
}

export interface RemoteCommit {
  readonly sha: string;
  readonly refs: string[];
  readonly attempt: string;
  readonly epoch: number;
}

/** Every commit reachable from any branch of the bare repository that carries an attempt trailer. */
export function attemptCommits(bareRepo: string): RemoteCommit[] {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: bareRepo,
      env: { PATH: process.env.PATH, HOME: bareRepo, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  const refs = git('for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter((r) => r !== '');
  const byCommit = new Map<string, { refs: string[]; body: string }>();
  for (const ref of refs) {
    const log = git('log', '--format=%H%x00%B%x1e', ref);
    for (const entry of log.split('\x1e')) {
      const [sha, body] = entry.replace(/^\n/, '').split('\0');
      if (sha === undefined || body === undefined || sha === '') continue;
      const known = byCommit.get(sha) ?? { refs: [], body };
      known.refs.push(ref);
      byCommit.set(sha, known);
    }
  }
  const commits: RemoteCommit[] = [];
  for (const [sha, c] of byCommit) {
    for (const value of trailerValues(c.body, ATTEMPT_TRAILER_KEY)) {
      const m = /^([0-9a-f-]{36})\/(\d+)$/.exec(value);
      if (m?.[1] !== undefined) commits.push({ sha, refs: c.refs, attempt: m[1], epoch: Number(m[2]) });
    }
  }
  return commits;
}

/**
 * Remote side effects: never two commits of one attempt; a verified head carries the job's current
 * attempt/epoch; the target branch only received merges that a human approved.
 */
async function remote(db: Queryable, out: string[], bareRepo: string): Promise<void> {
  const commits = attemptCommits(bareRepo);
  const perAttempt = new Map<string, Set<string>>();
  for (const c of commits) perAttempt.set(c.attempt, (perAttempt.get(c.attempt) ?? new Set()).add(c.sha));
  for (const [attempt, shas] of perAttempt) {
    if (shas.size > 1) out.push(`remote: attempt ${attempt.slice(0, 8)} has ${String(shas.size)} commits`);
  }
  const verified = await db.query<{ job_id: string; attempt_id: string; epoch: number; head_sha: string }>(
    `SELECT job_id, attempt_id, epoch, head_sha FROM job_git WHERE verification = 'passed'`,
  );
  for (const v of verified.rows) {
    const c = commits.find((x) => x.sha === v.head_sha);
    if (c === undefined || c.attempt !== v.attempt_id || c.epoch !== v.epoch) {
      out.push(
        `job ${v.job_id.slice(0, 8)}: verified head ${v.head_sha.slice(0, 8)} lacks trailer ${v.attempt_id.slice(0, 8)}/${String(v.epoch)}`,
      );
    }
  }
  const merged = await db.query<{ job_id: string; status: string; approved: boolean }>(
    `SELECT m.job_id, m.status,
            (m.approved_by IS NOT NULL AND a.status = 'approved') AS approved
       FROM git_merge_requests m JOIN approval_requests a ON a.id = m.approval_request_id
      WHERE m.status = 'merged'`,
  );
  for (const m of merged.rows) {
    if (!m.approved) out.push(`job ${m.job_id.slice(0, 8)}: merged without an approved approval request`);
  }
}
