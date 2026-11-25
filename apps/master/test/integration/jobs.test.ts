import { JOB_STATES } from '@remyral/scheduler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuditEventInput, AuditLog, type AuditRecorder, verifyChain } from '../../src/audit/audit.js';
import type { Queryable } from '../../src/db/pool.js';
import {
  DependencyCycleError,
  DependencyRejectedError,
  IllegalTransitionError,
  InvalidJobError,
  type JobActor,
  JobNotFoundError,
  JobStore,
  JobTransitionOutboxPayload,
  LeaseConflictError,
  LeaseReleaseRejectedError,
  StaleEpochError,
  VersionConflictError,
} from '../../src/jobs/index.js';
import { createTestDatabase, describeIntegration, type TestDatabase } from '../helpers/env.js';

class Clock {
  t = Date.parse('2026-10-12T12:00:00.000Z');
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Wraps the real audit log; throws on `job.transition` while armed (simulates a mid-transaction failure). */
class FailingAudit implements AuditRecorder {
  armed = false;
  constructor(private readonly inner: AuditRecorder) {}
  async record(event: AuditEventInput, tx?: Queryable) {
    if (this.armed && event.action === 'job.transition' && event.outcome === 'success') {
      throw new Error('injected audit failure');
    }
    return this.inner.record(event, tx);
  }
}

const USER: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const SYSTEM: JobActor = { type: 'system', id: 'reconciler' };
const TTL = 30_000;

function spec(prompt = 'Fix the failing test in packages/foo') {
  return {
    runtime: 'claude-code',
    prompt,
    repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/test' },
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 3600 },
  };
}

const worker = (id: string): JobActor => ({ type: 'worker', id });

describeIntegration('JobStore (integration)', () => {
  let db: TestDatabase;
  let clock: Clock;
  let audit: FailingAudit;
  let store: JobStore;

  beforeAll(async () => {
    db = await createTestDatabase();
    clock = new Clock();
    audit = new FailingAudit(new AuditLog(db.pool, clock.now));
    store = new JobStore({ pool: db.pool, audit, clock: clock.now });
  });
  afterAll(async () => {
    await db.drop();
  });

  /** Everything the store writes for one job, to prove "nothing written". */
  async function snapshot(jobId: string) {
    const q = async (sql: string) => (await db.pool.query<Record<string, unknown>>(sql, [jobId])).rows;
    return {
      job: await q(
        'SELECT state, version, lease_epoch, current_attempt_id, updated_at FROM jobs WHERE id = $1',
      ),
      transitions: await q('SELECT id FROM job_transitions WHERE job_id = $1 ORDER BY id'),
      outbox: await q('SELECT id FROM outbox WHERE job_id = $1 ORDER BY id'),
      attempts: await q('SELECT id, state, outcome FROM job_attempts WHERE job_id = $1 ORDER BY number'),
      leases: await q('SELECT epoch, expires_at, released_at FROM leases WHERE job_id = $1 ORDER BY epoch'),
      deps: await q('SELECT depends_on_job_id FROM job_dependencies WHERE job_id = $1'),
    };
  }

  async function auditCount(action: string, outcome: string, jobId: string): Promise<number> {
    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM audit_events WHERE action = $1 AND outcome = $2 AND target = $3',
      [action, outcome, `job:${jobId}`],
    );
    return Number(rows[0]?.n);
  }

  async function queued(project = 'proj-a'): Promise<string> {
    const { job } = await store.create({ project, spec: spec(), actor: USER, submit: true });
    return job.id;
  }

  /** QUEUED → RUNNING on `workerId`; returns the epoch. */
  async function running(jobId: string, workerId = 'w-1'): Promise<number> {
    const { lease } = await store.acquireLease(jobId, workerId, TTL);
    await store.transition(jobId, 'lease_acked', { actor: worker(workerId), epoch: lease.epoch });
    await store.transition(jobId, 'runtime_started', { actor: worker(workerId), epoch: lease.epoch });
    return lease.epoch;
  }

  describe('schema', () => {
    it('mirrors the scheduler states in the job_state enum', async () => {
      const { rows } = await db.pool.query<{ s: string[] }>(
        'SELECT enum_range(NULL::job_state)::text[] AS s',
      );
      expect(rows[0]?.s).toEqual([...JOB_STATES]);
    });
  });

  describe('create', () => {
    it('creates a DRAFT with history, outbox and audit in one transaction', async () => {
      const { job, transition } = await store.create({ project: 'proj-a', spec: spec(), actor: USER });
      expect(job).toMatchObject({
        state: 'DRAFT',
        version: 1,
        leaseEpoch: 0,
        currentAttemptId: null,
        priority: 0,
      });
      expect(job.createdBy).toEqual({ type: 'user', id: USER.id });
      expect(transition).toMatchObject({ from: null, to: 'DRAFT', trigger: 'create', version: 1 });
      const snap = await snapshot(job.id);
      expect(snap.transitions).toHaveLength(1);
      expect(snap.outbox).toHaveLength(1);
      expect(await auditCount('job.create', 'success', job.id)).toBe(1);
    });

    it('validates the spec against the protocol JobSpec and reports paths, not values', async () => {
      const before = await db.pool.query('SELECT count(*) FROM jobs');
      const err = await store
        .create({ project: 'bad project!', spec: { ...spec('SECRET-CANARY'), runtime: 'nope' }, actor: USER })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidJobError);
      const issues = (err as InvalidJobError).issues.map((i) => i.path);
      expect(issues).toEqual(expect.arrayContaining(['project', 'spec.runtime']));
      expect((err as Error).message).not.toContain('SECRET-CANARY');
      await expect(
        store.create({ project: 'p', spec: spec(), priority: 101, actor: USER }),
      ).rejects.toBeInstanceOf(InvalidJobError);
      expect((await db.pool.query('SELECT count(*) FROM jobs')).rows).toEqual(before.rows);
    });

    it('strips unknown spec keys and can submit atomically', async () => {
      const { job } = await store.create({
        project: 'proj-a',
        spec: { ...spec(), injected: 'x' },
        actor: USER,
        submit: true,
      });
      expect(job).toMatchObject({ state: 'QUEUED', version: 2 });
      expect(job.spec).not.toHaveProperty('injected');
      const history = await store.history(job.id);
      expect(history.map((h) => [h.from, h.to, h.trigger])).toEqual([
        [null, 'DRAFT', 'create'],
        ['DRAFT', 'QUEUED', 'submit'],
      ]);
    });
  });

  describe('transition', () => {
    it('drives the happy path with one history + outbox row per committed transition', async () => {
      const id = await queued();
      const epoch = await running(id, 'w-happy');
      const w = worker('w-happy');
      await store.transition(id, 'run_finished', { actor: w, epoch });
      await store.transition(id, 'verification_passed', { actor: SYSTEM });
      const { job } = await store.transition(id, 'approval_granted', { actor: USER });
      expect(job).toMatchObject({ state: 'SUCCEEDED', version: 8, leaseEpoch: 1 });

      const history = await store.history(id);
      expect(history.map((h) => h.to)).toEqual([
        'DRAFT',
        'QUEUED',
        'RESERVED',
        'STARTING',
        'RUNNING',
        'VERIFYING',
        'AWAITING_APPROVAL',
        'SUCCEEDED',
      ]);
      expect(history.map((h) => h.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

      const outbox = await db.pool.query<{ topic: string; payload: unknown }>(
        'SELECT topic, payload FROM outbox WHERE job_id = $1 ORDER BY id',
        [id],
      );
      expect(outbox.rows).toHaveLength(history.length);
      outbox.rows.forEach((row, i) => {
        expect(row.topic).toBe('job.transition');
        const payload = JobTransitionOutboxPayload.parse(row.payload);
        expect(payload).toMatchObject({ jobId: id, version: i + 1, transitionId: history[i]?.id });
      });

      const [attempt] = await store.attempts(id);
      expect(attempt).toMatchObject({ number: 1, workerId: 'w-happy', state: 'ended', outcome: 'succeeded' });
      const [lease] = await store.leases(id);
      expect(lease).toMatchObject({ epoch: 1, releaseReason: 'verification_passed' });
      expect(await auditCount('job.transition', 'success', id)).toBe(7);
      expect(await verifyChain(db.pool)).toMatchObject({ ok: true });
    });

    it('rejects illegal transitions and writes nothing but a denied audit event', async () => {
      const id = await queued();
      const before = await snapshot(id);
      const cases: [Parameters<JobStore['transition']>[1], Parameters<JobStore['transition']>[2], string][] =
        [
          ['run_finished', { actor: SYSTEM }, 'no_transition'],
          ['dependency_unblocked', { actor: SYSTEM }, 'no_transition'],
          ['infeasible', { actor: USER, reason: 'x' }, 'actor_not_allowed'],
          ['cancel_requested', { actor: USER }, 'reason_required'],
          ['cancel_requested', { actor: USER, reason: '   ' }, 'reason_required'],
        ];
      for (const [trigger, opts, code] of cases) {
        const err = await store.transition(id, trigger, opts).catch((e: unknown) => e);
        expect(err, trigger).toBeInstanceOf(IllegalTransitionError);
        expect((err as IllegalTransitionError).reason).toBe(code);
      }
      expect(await snapshot(id)).toEqual(before);
      expect(await auditCount('job.transition', 'denied', id)).toBe(cases.length);
    });

    it('requires a verified-safe assertion to retry and only humans may approve', async () => {
      const id = await queued();
      const epoch = await running(id);
      const before = await snapshot(id);
      await expect(
        store.transition(id, 'attempt_retry', { actor: SYSTEM, reason: 'flaky' }),
      ).rejects.toMatchObject({ reason: 'retry_not_safe' });
      expect(await snapshot(id)).toEqual(before);
      await store.transition(id, 'run_finished', { actor: worker('w-1'), epoch });
      await store.transition(id, 'verification_passed', { actor: SYSTEM });
      await expect(store.transition(id, 'approval_granted', { actor: SYSTEM })).rejects.toMatchObject({
        reason: 'actor_not_allowed',
      });
      await expect(
        store.transition(id, 'approval_granted', { actor: worker('w-1'), epoch }),
      ).rejects.toBeInstanceOf(IllegalTransitionError);
    });

    it('keeps terminal states immutable (store and database)', async () => {
      const id = await queued();
      await store.transition(id, 'cancel_requested', { actor: USER, reason: 'not needed' });
      const before = await snapshot(id);
      await expect(store.transition(id, 'submit', { actor: USER })).rejects.toMatchObject({
        reason: 'terminal_state',
      });
      await expect(
        db.pool.query("UPDATE jobs SET state = 'QUEUED', version = version + 1 WHERE id = $1", [id]),
      ).rejects.toThrow(/terminal state/);
      expect(await snapshot(id)).toEqual(before);
    });

    it('rejects a stale expectedVersion without writing', async () => {
      const id = await queued();
      const before = await snapshot(id);
      await expect(
        store.transition(id, 'cancel_requested', { actor: USER, reason: 'x', expectedVersion: 1 }),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(await snapshot(id)).toEqual(before);
      await store.transition(id, 'cancel_requested', { actor: USER, reason: 'x', expectedVersion: 2 });
    });

    it('reports unknown jobs', async () => {
      await expect(
        store.transition('00000000-0000-4000-8000-0000000000ff', 'submit', { actor: USER }),
      ).rejects.toBeInstanceOf(JobNotFoundError);
      await expect(store.transition('not-a-uuid', 'submit', { actor: USER })).rejects.toBeInstanceOf(
        JobNotFoundError,
      );
      expect(await store.get('not-a-uuid')).toBeNull();
    });

    it('refuses lease-creating triggers outside acquireLease', async () => {
      const id = await queued();
      await expect(store.transition(id, 'reserve', { actor: SYSTEM })).rejects.toThrow(/acquireLease/);
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of many parallel identical transitions win', async () => {
      const id = await queued();
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          store.transition(id, 'cancel_requested', { actor: USER, reason: `racer ${String(i)}` }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason instanceof VersionConflictError || r.reason instanceof IllegalTransitionError).toBe(
            true,
          );
        }
      }
      const history = await store.history(id);
      expect(history.filter((h) => h.trigger === 'cancel_requested')).toHaveLength(1);
      expect((await snapshot(id)).outbox).toHaveLength(history.length);
    });

    it('lets exactly one of different transitions racing on the same version win', async () => {
      const id = await queued();
      const epoch = await running(id, 'w-race');
      const job = await store.get(id);
      const v = job?.version ?? 0;
      const w = worker('w-race');
      const results = await Promise.allSettled([
        store.transition(id, 'run_finished', { actor: w, epoch, expectedVersion: v }),
        store.transition(id, 'cancel_requested', { actor: USER, reason: 'stop', expectedVersion: v }),
        store.transition(id, 'attempt_failed', { actor: w, epoch, reason: 'crash', expectedVersion: v }),
        store.transition(id, 'attempt_failed', { actor: SYSTEM, reason: 'timeout', expectedVersion: v }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(VersionConflictError);
      }
      expect((await store.get(id))?.version).toBe(v + 1);
      const snap = await snapshot(id);
      expect(snap.transitions).toHaveLength(v + 1);
      expect(snap.outbox).toHaveLength(v + 1);
    });

    it('gives a lease to exactly one of several racing workers', async () => {
      const id = await queued();
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => store.acquireLease(id, `w-${String(i)}`, TTL)),
      );
      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      for (const r of results)
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(LeaseConflictError);
      const snap = await snapshot(id);
      expect(snap.leases).toHaveLength(1);
      expect(snap.attempts).toHaveLength(1);
      expect(snap.job[0]).toMatchObject({ state: 'RESERVED', lease_epoch: 1 });
    });
  });

  describe('leases and fencing', () => {
    it('never reserves a sub-job whose parent ended; reserves it while the parent runs (p14-followups race)', async () => {
      // The parent's end and the release of its lease commit together: a dispatcher that read the parent as running
      // and then found its slot free must not lease the child — the lease transaction itself refuses it.
      const parent = await queued();
      const epoch = await running(parent, 'w-sub');
      const child = await queued();
      const sibling = await queued();
      for (const c of [child, sibling]) {
        await db.pool.query(
          `INSERT INTO job_subtasks (child_job_id, parent_job_id, root_job_id, depth, request_id, parent_attempt_id,
                                     worker_id, title, wait, requires, placement, created_at)
           VALUES ($1, $2, $2, 1, gen_random_uuid(), gen_random_uuid(), 'w-sub', 'part', true, '{}', '{}', $3)`,
          [c, parent, clock.now()],
        );
      }
      // While the parent runs, its sub-job may start (another login store, another slot).
      await store.acquireLease(sibling, 'w-sub', TTL);
      await store.transition(parent, 'run_finished', { actor: worker('w-sub'), epoch });
      await store.transition(parent, 'verification_passed_no_approval', { actor: SYSTEM });
      expect((await store.get(parent))?.state).toBe('SUCCEEDED');
      const before = await snapshot(child);
      await expect(store.acquireLease(child, 'w-sub', TTL)).rejects.toThrow(
        /cannot be leased in state QUEUED \(its parent job ended \(succeeded\)\)/,
      );
      await expect(store.acquireLease(child, 'w-sub', TTL)).rejects.toBeInstanceOf(LeaseConflictError);
      expect(await snapshot(child)).toEqual(before);
    });

    it('rejects stale, foreign and missing epochs on renew, release and worker transitions', async () => {
      const id = await queued();
      const epoch = await running(id, 'w-a');
      const before = await snapshot(id);
      await expect(store.renewLease(id, 'w-a', epoch + 1, TTL)).rejects.toMatchObject({
        reason: 'unknown_lease',
      });
      await expect(store.renewLease(id, 'w-b', epoch, TTL)).rejects.toMatchObject({ reason: 'not_holder' });
      await expect(store.releaseLease(id, 'w-b', epoch)).rejects.toBeInstanceOf(StaleEpochError);
      await expect(
        store.transition(id, 'run_finished', { actor: worker('w-a'), epoch: epoch + 1 }),
      ).rejects.toBeInstanceOf(StaleEpochError);
      await expect(store.transition(id, 'run_finished', { actor: worker('w-a') })).rejects.toBeInstanceOf(
        StaleEpochError,
      );
      await expect(
        store.transition(id, 'run_finished', { actor: worker('w-b'), epoch }),
      ).rejects.toMatchObject({ reason: 'not_holder' });
      expect(await snapshot(id)).toEqual(before);
      expect(await auditCount('job.lease.renew', 'denied', id)).toBe(2);
      expect(await auditCount('job.lease.release', 'denied', id)).toBe(1);
      expect(await auditCount('job.transition', 'denied', id)).toBe(3);
    });

    it('renews a live lease without ever shortening it', async () => {
      const id = await queued();
      const { lease } = await store.acquireLease(id, 'w-r', TTL);
      clock.advance(10_000);
      const renewed = await store.renewLease(id, 'w-r', lease.epoch, TTL);
      expect(renewed.expiresAt.getTime()).toBe(clock.now().getTime() + TTL);
      const again = await store.renewLease(id, 'w-r', lease.epoch, 1_000);
      expect(again.expiresAt).toEqual(renewed.expiresAt);
    });

    it('expires into LOST, finds expired leases and increases the epoch on every re-lease', async () => {
      const id = await queued();
      const e1 = await running(id, 'w-old');
      await expect(store.transition(id, 'lease_expired', { actor: SYSTEM })).rejects.toMatchObject({
        reason: 'lease_not_expired',
      });
      expect((await store.findExpiredLeases()).map((l) => l.jobId)).not.toContain(id);

      clock.advance(TTL + 1);
      const expired = await store.findExpiredLeases();
      expect(expired).toContainEqual(
        expect.objectContaining({ jobId: id, epoch: e1, workerId: 'w-old', jobState: 'RUNNING' }),
      );
      await expect(store.renewLease(id, 'w-old', e1, TTL)).rejects.toMatchObject({ reason: 'expired' });
      await expect(
        store.transition(id, 'run_finished', { actor: worker('w-old'), epoch: e1 }),
      ).rejects.toMatchObject({ reason: 'expired' });

      const lost = await store.transition(id, 'lease_expired', { actor: SYSTEM });
      expect(lost.job.state).toBe('LOST');
      expect((await store.findExpiredLeases()).map((l) => l.jobId)).not.toContain(id);
      expect((await store.attempts(id))[0]).toMatchObject({ state: 'lost', outcome: null });
      // LOST is never rescheduled blindly.
      await expect(store.acquireLease(id, 'w-new', TTL)).rejects.toMatchObject({ reason: 'worker_mismatch' });
      await expect(store.transition(id, 'retry_due', { actor: SYSTEM })).rejects.toBeInstanceOf(
        IllegalTransitionError,
      );

      // Resume of the same attempt on the same worker: new epoch.
      const resumed = await store.acquireLease(id, 'w-old', TTL, {
        reason: 'worker reconnected, session alive',
      });
      expect(resumed.job.state).toBe('RUNNING');
      expect(resumed.lease.epoch).toBe(e1 + 1);
      expect(resumed.attempt).toMatchObject({ number: 1, state: 'active' });
      await expect(store.renewLease(id, 'w-old', e1, TTL)).rejects.toMatchObject({ reason: 'superseded' });

      // Lose it again, reconcile to a safe retry and lease to another worker: new attempt, new epoch.
      clock.advance(TTL + 1);
      await store.transition(id, 'lease_expired', { actor: SYSTEM });
      await store.transition(id, 'reconcile_retry', {
        actor: SYSTEM,
        reason: 'remote branch has no commits from this attempt',
        retrySafe: true,
      });
      expect((await store.attempts(id))[0]).toMatchObject({ state: 'ended', outcome: 'retry' });
      await store.transition(id, 'retry_due', { actor: SYSTEM });
      const relet = await store.acquireLease(id, 'w-new', TTL);
      expect(relet.lease.epoch).toBe(e1 + 2);
      expect(relet.attempt).toMatchObject({ number: 2, workerId: 'w-new' });

      const epochs = (await store.leases(id)).map((l) => l.epoch);
      expect(epochs).toEqual([1, 2, 3]);
      await expect(store.releaseLease(id, 'w-old', e1 + 1)).rejects.toMatchObject({ reason: 'superseded' });
      await expect(
        store.transition(id, 'lease_acked', { actor: worker('w-old'), epoch: e1 + 1 }),
      ).rejects.toMatchObject({ reason: 'superseded' });
      await store.transition(id, 'lease_acked', { actor: worker('w-new'), epoch: relet.lease.epoch });
    });

    it('closes the lease through worker-reported transitions, and release only where allowed', async () => {
      const id = await queued();
      const epoch = await running(id, 'w-rel');
      await expect(store.releaseLease(id, 'w-rel', epoch)).rejects.toBeInstanceOf(LeaseReleaseRejectedError);
      await store.transition(id, 'run_finished', { actor: worker('w-rel'), epoch });
      const released = await store.releaseLease(id, 'w-rel', epoch);
      expect(released).toMatchObject({ alreadyReleased: false, lease: { releaseReason: 'released' } });
      expect(await store.releaseLease(id, 'w-rel', epoch)).toMatchObject({ alreadyReleased: true });
      await expect(store.renewLease(id, 'w-rel', epoch, TTL)).rejects.toMatchObject({ reason: 'released' });
      await expect(store.transition(id, 'lease_expired', { actor: SYSTEM })).rejects.toMatchObject({
        reason: 'no_active_lease',
      });
      await store.transition(id, 'verification_passed_no_approval', { actor: SYSTEM });
      expect((await store.get(id))?.state).toBe('SUCCEEDED');
    });

    it('lets a worker decline a reservation, which ends the attempt and requeues', async () => {
      const id = await queued();
      const { lease } = await store.acquireLease(id, 'w-d', TTL);
      const { job } = await store.transition(id, 'lease_declined', {
        actor: worker('w-d'),
        epoch: lease.epoch,
      });
      expect(job.state).toBe('QUEUED');
      expect((await store.attempts(id))[0]).toMatchObject({ state: 'ended', outcome: 'declined' });
      expect((await store.leases(id))[0]).toMatchObject({ releaseReason: 'lease_declined' });
      expect((await store.acquireLease(id, 'w-e', TTL)).lease.epoch).toBe(2);
    });

    it('cancels through CANCELLING with worker confirmation', async () => {
      const id = await queued();
      const epoch = await running(id, 'w-c');
      await store.transition(id, 'cancel_requested', { actor: USER, reason: 'wrong branch' });
      await expect(store.renewLease(id, 'w-c', epoch, TTL)).resolves.toBeDefined();
      const { job } = await store.transition(id, 'cancel_confirmed', { actor: worker('w-c'), epoch });
      expect(job.state).toBe('CANCELLED');
      expect((await store.attempts(id))[0]).toMatchObject({ outcome: 'cancelled' });
    });

    it('enforces one active lease and monotonic epochs in the database too', async () => {
      const id = await queued();
      const { lease } = await store.acquireLease(id, 'w-db', TTL);
      const now = clock.now();
      const later = new Date(now.getTime() + TTL);
      await expect(
        db.pool.query(
          `INSERT INTO leases (job_id, attempt_id, worker_id, epoch, acquired_at, expires_at)
           VALUES ($1, $2, 'w-db', $3, $4, $5)`,
          [id, lease.attemptId, lease.epoch, now, later],
        ),
      ).rejects.toThrow();
      await expect(db.pool.query('UPDATE leases SET epoch = 7 WHERE job_id = $1', [id])).rejects.toThrow(
        /immutable/,
      );
      await expect(
        db.pool.query('UPDATE jobs SET lease_epoch = 0, version = version + 1 WHERE id = $1', [id]),
      ).rejects.toThrow(/must not decrease/);
      await expect(db.pool.query('UPDATE jobs SET priority = 5 WHERE id = $1', [id])).rejects.toThrow(
        /increment version/,
      );
      await expect(db.pool.query('DELETE FROM leases WHERE job_id = $1', [id])).rejects.toThrow(
        /cannot be removed/,
      );
    });
  });

  describe('transactional outbox', () => {
    it('writes no outbox or history row when the transaction fails midway', async () => {
      const id = await queued();
      const before = await snapshot(id);
      audit.armed = true;
      try {
        await expect(store.acquireLease(id, 'w-f', TTL)).rejects.toThrow('injected audit failure');
        await expect(store.transition(id, 'cancel_requested', { actor: USER, reason: 'x' })).rejects.toThrow(
          'injected audit failure',
        );
        await expect(
          store.create({ project: 'proj-a', spec: spec(), actor: USER, submit: true }),
        ).rejects.toThrow('injected audit failure');
      } finally {
        audit.armed = false;
      }
      expect(await snapshot(id)).toEqual(before);
      // The job is still usable afterwards: the epoch was not consumed by the failed attempt.
      const { lease } = await store.acquireLease(id, 'w-f', TTL);
      expect(lease.epoch).toBe(1);
      const after = await snapshot(id);
      expect(after.outbox).toHaveLength(after.transitions.length);
    });

    it('allows the outbox only to be marked dispatched once and pruned after dispatch', async () => {
      const id = await queued();
      const { rows } = await db.pool.query<{ id: string }>(
        'SELECT id::text AS id FROM outbox WHERE job_id = $1 ORDER BY id LIMIT 1',
        [id],
      );
      const rowId = rows[0]?.id;
      await expect(db.pool.query('DELETE FROM outbox WHERE id = $1', [rowId])).rejects.toThrow(
        /not been dispatched/,
      );
      await expect(
        db.pool.query(`UPDATE outbox SET payload = '{"x":1}' WHERE id = $1`, [rowId]),
      ).rejects.toThrow(/marked dispatched once/);
      await db.pool.query('UPDATE outbox SET dispatched_at = now() WHERE id = $1', [rowId]);
      await expect(
        db.pool.query('UPDATE outbox SET dispatched_at = now() WHERE id = $1', [rowId]),
      ).rejects.toThrow(/marked dispatched once/);
      await db.pool.query('DELETE FROM outbox WHERE id = $1', [rowId]);
      await expect(db.pool.query('TRUNCATE outbox')).rejects.toThrow(/truncated/);
    });
  });

  describe('history protection', () => {
    it('rejects UPDATE, DELETE and TRUNCATE of job_transitions', async () => {
      const id = await queued();
      await expect(
        db.pool.query("UPDATE job_transitions SET reason = 'edited' WHERE job_id = $1", [id]),
      ).rejects.toThrow(/append-only/);
      await expect(db.pool.query('DELETE FROM job_transitions WHERE job_id = $1', [id])).rejects.toThrow(
        /append-only/,
      );
      await expect(db.pool.query('TRUNCATE job_transitions CASCADE')).rejects.toThrow(/append-only/);
      expect(await store.history(id)).toHaveLength(2);
    });

    it('keeps ended attempts immutable', async () => {
      const id = await queued();
      const { lease } = await store.acquireLease(id, 'w-i', TTL);
      await store.transition(id, 'lease_declined', { actor: worker('w-i'), epoch: lease.epoch });
      await expect(
        db.pool.query("UPDATE job_attempts SET outcome = 'succeeded' WHERE job_id = $1", [id]),
      ).rejects.toThrow(/immutable/);
      await expect(db.pool.query('DELETE FROM job_attempts WHERE job_id = $1', [id])).rejects.toThrow(
        /cannot be removed/,
      );
    });
  });

  describe('dependencies', () => {
    async function draft(project = 'proj-dag'): Promise<string> {
      return (await store.create({ project, spec: spec(), actor: USER })).job.id;
    }

    it('accepts a DAG and rejects cycles, self-edges and duplicates', async () => {
      const [a, b, c] = [await draft(), await draft(), await draft()];
      expect(await store.addDependency(a, b, USER)).toBe(true);
      expect(await store.addDependency(b, c, USER)).toBe(true);
      expect(await store.addDependency(a, c, USER)).toBe(true);
      expect(await store.addDependency(a, b, USER)).toBe(false);
      const before = await snapshot(c);
      await expect(store.addDependency(c, a, USER)).rejects.toBeInstanceOf(DependencyCycleError);
      await expect(store.addDependency(c, b, USER)).rejects.toBeInstanceOf(DependencyCycleError);
      await expect(store.addDependency(c, c, USER)).rejects.toBeInstanceOf(DependencyCycleError);
      expect(await snapshot(c)).toEqual(before);
      expect(await auditCount('job.dependency.add', 'denied', c)).toBe(3);
      // The trigger is the backstop even for direct inserts.
      await expect(
        db.pool.query(
          'INSERT INTO job_dependencies (job_id, depends_on_job_id, created_at) VALUES ($1, $2, now())',
          [c, a],
        ),
      ).rejects.toThrow(/cycle/);
    });

    it('rejects cross-project edges and edges on started jobs', async () => {
      const a = await draft('proj-x');
      const b = await draft('proj-y');
      await expect(store.addDependency(a, b, USER)).rejects.toMatchObject({ reason: 'cross_project' });
      const c = await queued('proj-x');
      await running(c);
      await expect(store.addDependency(c, a, USER)).rejects.toBeInstanceOf(DependencyRejectedError);
    });

    it('cannot create a cycle with concurrent inserts', async () => {
      for (let i = 0; i < 5; i++) {
        const [a, b] = [await draft(), await draft()];
        const results = await Promise.allSettled([
          store.addDependency(a, b, USER),
          store.addDependency(b, a, USER),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((r) => r.status === 'rejected');
        expect(rejected?.reason).toBeInstanceOf(DependencyCycleError);
      }
    });
  });

  it('leaves a verifiable audit chain', async () => {
    expect(await verifyChain(db.pool)).toMatchObject({ ok: true });
  });
});
