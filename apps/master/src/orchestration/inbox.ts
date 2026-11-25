import {
  hasMemoryProposals,
  type JobPausedReport,
  type McpCallEvent,
  USAGE_LIMIT_ERROR_CODE as PROVIDER_USAGE_LIMIT_CODE,
} from '@remyral/protocol';
import type { LimitedResult } from '../usage-limits/service.js';
import { recordDecline } from '../queue/declines.js';
import type { JobState, JobTrigger } from '@remyral/scheduler';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool, PoolClient, Queryable } from '../db/pool.js';
import {
  IllegalTransitionError,
  JobNotFoundError,
  StaleEpochError,
  VersionConflictError,
} from '../jobs/errors.js';
import { type JobStore, LEASE_HELD_UNTIL_SQL } from '../jobs/store.js';
import type { AfterCommit, InboxSink, SequencedWorkerMessage, WorkerReplay } from '../workers/replay.js';
import type { WorkerSession } from '../workers/types.js';
import type { LeaseSigner } from './lease-signer.js';
import { recordJobMemory } from '../fleetview/memory-rollup.js';
import { renewPayload } from './messages.js';
import { SELF_HEAL_ACTOR, type AutoRetryService } from '../self-heal/retry.js';

export type InboxOutcome = 'journaled' | 'applied' | 'stale' | 'rejected';
export type EffectKind = 'usage' | 'approval' | 'memory';

/** Post-commit effects in other services (wired by the integration glue; absent = none recorded). */
export interface InboxEffects {
  /** Runs one effect; must be idempotent (it is retried after a crash). */
  run(
    inboxId: string,
    workerId: string,
    message: Extract<SequencedWorkerMessage, { type: 'EVENT' }>,
  ): Promise<void>;
}

/**
 * p5-live: stores accepted data messages (EVENT, LOG_CHUNK, ARTIFACT_REF) for the live view inside the
 * inbox transaction (docs/design/p5-live.md §3). Returns true when a row was added.
 */
export interface LiveSink {
  recordWithin(
    tx: Queryable,
    workerId: string,
    message: SequencedWorkerMessage,
    receivedAt: Date,
  ): Promise<boolean>;
  notifyWithin(tx: Queryable, jobId: string): Promise<void>;
}

export interface OrchestrationInboxDeps {
  readonly pool: Pool;
  readonly jobs: JobStore;
  readonly replay: () => WorkerReplay;
  readonly signer: LeaseSigner;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly leaseTtlMs: number;
  readonly log: FastifyBaseLogger;
  readonly effects?: () => InboxEffects | null;
  /** p4-git-flow: jobs enrolled in git flow are verified on the remote, not on the worker's claim. */
  readonly gitflow?: () => {
    usesGitFlow(db: Queryable, jobId: string): Promise<boolean>;
    kickVerification(jobId: string): void;
  } | null;
  /** p5-live: persistence of accepted events/log chunks/artifact refs for the live view. */
  readonly live?: () => LiveSink | null;
  /** p5-research-workspace: artifact chunk staging and commit (absent: workspace artifacts are refused). */
  readonly workspaces?: () => WorkspaceArtifactSink | null;
  /** p10-approval-pause: pause confirmations and declined resumes (absent: a paused result fails the run). */
  readonly pause?: () => PauseInbox | null;
  /** p11-usage-limit-fallback: wait / fall back / fail on a usage-limited result (absent: it fails the run). */
  readonly usageLimits?: () => UsageLimitInbox | null;
  /** p14-mcp-core: stores and audits `mcp_call` events (absent: they only reach the timeline). */
  readonly mcpCalls?: () => McpCallInbox | null;
  /** p15-auto-mode: automatic retries of transient failures (absent: a failed attempt fails the job). */
  readonly autoRetry?: () => AutoRetryService | null;
}

/** p14-mcp-core: what the inbox needs from the MCP service (inside the inbox transaction). */
export interface McpCallInbox {
  recordCall(
    tx: PoolClient,
    input: { jobId: string; attemptId: string; workerId: string; event: McpCallEvent; at: Date },
  ): Promise<boolean>;
}

/** p11-usage-limit-fallback: what the inbox needs from the usage-limit service (inside the inbox transaction). */
export interface UsageLimitInbox {
  onLimitedResultWithin(tx: PoolClient, result: LimitedResult): Promise<boolean>;
}

/** p10-approval-pause: what the inbox needs from the pause service (inside the inbox transaction). */
export interface PauseInbox {
  confirmWithin(
    tx: PoolClient,
    input: {
      readonly jobId: string;
      readonly attemptId: string;
      readonly epoch: number;
      readonly workerId: string;
      readonly report: JobPausedReport;
    },
  ): Promise<boolean>;
  resumeDeclinedWithin(
    tx: PoolClient,
    input: {
      readonly jobId: string;
      readonly attemptId: string;
      readonly epoch: number;
      readonly workerId: string;
      readonly reason: string;
      readonly permanent: boolean;
    },
  ): Promise<boolean>;
}

/** p5-research-workspace: what the inbox needs from the WorkspaceService. */
export interface WorkspaceArtifactSink {
  stageChunk(
    tx: Queryable,
    jobId: string,
    p: { attemptId: string; artifactId: string; index: number; data: string },
    now: Date,
  ): Promise<'ok' | 'limit' | 'invalid'>;
  commitArtifact(
    tx: Queryable,
    jobId: string,
    p: {
      attemptId: string;
      artifactId: string;
      name: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
    },
    now: Date,
  ): Promise<'ok' | 'incomplete' | 'invalid' | 'limit' | 'quota'>;
}

/** How a message's epoch relates to the job's leases (ADR-0004 §3). */
type Fence =
  | { kind: 'unknown_job' }
  | { kind: 'stale'; reason: string; state: JobState }
  /** The worker's lease for this epoch is the current, unreleased, unexpired one. */
  | { kind: 'live'; state: JobState }
  /** Latest lease of this worker for the job, but closed by a transition (job moved on). */
  | { kind: 'closed'; state: JobState; releaseReason: string | null }
  /** Latest lease of this worker, but it expired (job LOST or about to be): reconciliation decides. */
  | { kind: 'lost'; state: JobState };

interface Routed {
  outcome: InboxOutcome;
  reason: string | null;
  effect: EffectKind | null;
  /** Reply ERROR stale_epoch to the worker after commit. */
  staleReply: boolean;
  /** p4-git-flow: start the independent verification after commit. */
  verify?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROUTE_ATTEMPTS = 3;

/**
 * Routes sequenced worker messages into the job state machine (p4-leases/p4-dispatch, ADR-0003/0004).
 * Runs inside the replay transaction that advances the worker's cursor, so each message takes effect
 * exactly once: the journal row, the job transition (with its history/outbox/audit rows), the routing
 * outcome and any reply queued for the worker commit together.
 *
 * Fencing: every job message carries `(attemptId, epoch)`. Only the worker holding the job's current
 * live lease may change job state; anything else is `stale` — journaled, never applied, audited as
 * `job.message` denied and answered with `ERROR stale_epoch`. Data-only messages (logs, events,
 * artifacts) of the job's latest lease of this worker are still accepted after the lease closed (the tail
 * of a finished run), and a JOB_RESULT that arrives after the lease expired is recorded as reconciliation
 * input (`job_runs.result_late`) without changing state.
 */
export class OrchestrationInbox implements InboxSink {
  constructor(private readonly deps: OrchestrationInboxDeps) {}

  async handle(
    q: Queryable,
    workerId: string,
    message: SequencedWorkerMessage,
    receivedAt: Date,
  ): Promise<AfterCommit> {
    const tx = q as PoolClient;
    // Route first (inside a savepoint), then journal the message with its outcome in one statement.
    const routed: Routed = UUID.test(message.jobId)
      ? await this.#routeWithRetry(tx, workerId, message)
      : { outcome: 'stale', reason: 'unknown_job', effect: null, staleReply: true };
    const effects = this.deps.effects?.() ?? null;
    const effect = effects === null ? null : routed.effect;
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO worker_inbox (worker_id, seq, message_id, type, job_id, payload, received_at, outcome,
                                 outcome_reason, effect, effect_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id::text AS id`,
      [
        workerId,
        message.seq,
        message.messageId,
        message.type,
        message.jobId,
        // p5-research-workspace: chunk data lives in job_artifact_chunks; the journal keeps only its size.
        JSON.stringify(
          message.type === 'ARTIFACT_CHUNK'
            ? { ...message.payload, data: undefined, dataChars: message.payload.data.length }
            : message.payload,
        ),
        receivedAt,
        routed.outcome,
        routed.reason,
        effect,
        effect === null ? null : 'pending',
      ],
    );
    const inboxId = inserted.rows[0]?.id ?? '0';
    if (
      routed.outcome === 'applied' &&
      message.type !== 'LEASE_ACK' &&
      message.type !== 'JOB_RESULT' &&
      message.type !== 'ARTIFACT_CHUNK'
    ) {
      await this.#recordLive(tx, workerId, message, receivedAt);
    }
    // Messages for jobs that do not exist are journaled and answered, not audited (nothing to protect;
    // keeps a misbehaving worker from flooding the hash chain).
    if ((routed.outcome === 'stale' || routed.outcome === 'rejected') && routed.reason !== 'unknown_job') {
      await this.deps.audit.record(
        {
          actor: { type: 'worker', id: workerId },
          action: 'job.message',
          target: `job:${message.jobId.slice(0, 64)}`,
          outcome: 'denied',
          metadata: {
            type: message.type,
            attemptId: message.payload.attemptId,
            epoch: message.payload.epoch,
            denial: routed.outcome === 'stale' ? 'stale_epoch' : 'illegal_for_state',
            reason: routed.reason,
          },
        },
        tx,
      );
    }
    return async (session: WorkerSession) => {
      if (routed.staleReply) {
        await session
          .send('ERROR', {
            code: 'stale_epoch',
            message: `${message.type} for job ${message.jobId} epoch ${String(message.payload.epoch)} refused: ${routed.reason ?? 'stale'}`,
            retryable: false,
            inReplyTo: message.messageId,
          })
          .catch(() => undefined);
      }
      if (routed.verify === true) this.deps.gitflow?.()?.kickVerification(message.jobId);
      if (effect !== null && effects !== null && message.type === 'EVENT') {
        await runEffect(this.deps.pool, effects, inboxId, workerId, message, this.deps.clock()).catch(
          (err: unknown) => {
            this.deps.log.warn({ err, workerId, inboxId }, 'inbox effect failed; the reconciler retries it');
          },
        );
      }
    };
  }

  /**
   * Live-view copy of an accepted data message, in a savepoint: a failure here is logged and never blocks
   * the worker's replay cursor (the raw message stays in worker_inbox).
   */
  async #recordLive(
    tx: PoolClient,
    workerId: string,
    message: SequencedWorkerMessage,
    receivedAt: Date,
  ): Promise<void> {
    const live = this.deps.live?.() ?? null;
    if (live === null) return;
    await tx.query('SAVEPOINT orch_live');
    try {
      if (await live.recordWithin(tx, workerId, message, receivedAt)) {
        await live.notifyWithin(tx, message.jobId);
      }
      await tx.query('RELEASE SAVEPOINT orch_live');
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT orch_live');
      this.deps.log.warn({ err, workerId, jobId: message.jobId, type: message.type }, 'live copy failed');
    }
  }

  async #routeWithRetry(tx: PoolClient, workerId: string, message: SequencedWorkerMessage): Promise<Routed> {
    for (let attempt = 1; ; attempt++) {
      await tx.query('SAVEPOINT orch_route');
      try {
        const routed = await this.#route(tx, workerId, message);
        await tx.query('RELEASE SAVEPOINT orch_route');
        return routed;
      } catch (err) {
        await tx.query('ROLLBACK TO SAVEPOINT orch_route');
        if (err instanceof VersionConflictError && attempt < MAX_ROUTE_ATTEMPTS) continue;
        if (err instanceof StaleEpochError) {
          return { outcome: 'stale', reason: err.reason, effect: null, staleReply: true };
        }
        if (err instanceof IllegalTransitionError) {
          return { outcome: 'rejected', reason: err.reason, effect: null, staleReply: false };
        }
        if (err instanceof VersionConflictError) {
          // Persistent contention: the worker replays after reconnect; never lose the message silently.
          throw err;
        }
        if (err instanceof JobNotFoundError) {
          return { outcome: 'stale', reason: 'unknown_job', effect: null, staleReply: true };
        }
        throw err;
      }
    }
  }

  async #fence(tx: PoolClient, workerId: string, message: SequencedWorkerMessage): Promise<Fence> {
    if (!UUID.test(message.jobId)) return { kind: 'unknown_job' };
    const { rows } = await tx.query<{
      state: JobState;
      lease_epoch: number;
      l_worker: string | null;
      l_attempt: string | null;
      released_at: Date | null;
      release_reason: string | null;
      held_until: Date | null;
    }>(
      // p11-master-resilience: a lease in its offline hold is still live (ADR-0039).
      `SELECT j.state, j.lease_epoch, l.worker_id AS l_worker, l.attempt_id AS l_attempt, l.released_at,
              l.release_reason, ${LEASE_HELD_UNTIL_SQL('l')} AS held_until
         FROM jobs j LEFT JOIN leases l ON l.job_id = j.id AND l.epoch = $2
        WHERE j.id = $1`,
      [message.jobId, message.payload.epoch],
    );
    const r = rows[0];
    if (r === undefined) return { kind: 'unknown_job' };
    const p = message.payload;
    if (r.l_worker === null) return { kind: 'stale', reason: 'unknown_lease', state: r.state };
    if (r.l_worker !== workerId) return { kind: 'stale', reason: 'not_holder', state: r.state };
    if (r.l_attempt !== p.attemptId) return { kind: 'stale', reason: 'attempt_mismatch', state: r.state };
    if (p.epoch < r.lease_epoch) return { kind: 'stale', reason: 'superseded', state: r.state };
    if (r.released_at !== null) {
      return r.release_reason === 'expired'
        ? { kind: 'lost', state: r.state }
        : { kind: 'closed', state: r.state, releaseReason: r.release_reason };
    }
    if (r.held_until !== null && r.held_until.getTime() <= this.deps.clock().getTime()) {
      return { kind: 'lost', state: r.state };
    }
    return { kind: 'live', state: r.state };
  }

  async #route(tx: PoolClient, workerId: string, message: SequencedWorkerMessage): Promise<Routed> {
    const fence = await this.#fence(tx, workerId, message);
    const stale = (reason: string): Routed => ({ outcome: 'stale', reason, effect: null, staleReply: true });
    if (fence.kind === 'unknown_job') return stale('unknown_job');

    switch (message.type) {
      case 'LEASE_ACK':
        if (fence.kind !== 'live') return stale(fence.kind === 'stale' ? fence.reason : fence.kind);
        return this.#leaseAck(tx, workerId, message, fence.state);

      case 'EVENT': {
        const ev = message.payload.event;
        // Spent tokens are recorded even from a stale attempt (p6-cost: the money was spent); the usage
        // store still checks that this worker ran the attempt.
        if (ev.kind === 'usage') {
          const ok = fence.kind !== 'stale';
          return {
            outcome: ok ? 'applied' : 'stale',
            reason: ok ? null : fence.reason,
            effect: 'usage',
            staleReply: !ok,
          };
        }
        if (fence.kind === 'stale' || fence.kind === 'lost') {
          return stale(fence.kind === 'stale' ? fence.reason : 'lease_expired');
        }
        if (ev.kind === 'status') {
          await this.#recordPhase(tx, message.payload.attemptId, ev.phase);
          if (fence.kind === 'live' && ev.phase === 'running' && fence.state === 'STARTING') {
            await this.#transition(tx, workerId, message, 'runtime_started');
          }
        }
        // p11-memory-layers: an agent answer with LESSON: / MEMORY: lines goes to the memory effect (suggestions).
        if (ev.kind === 'message' && ev.role === 'assistant' && hasMemoryProposals(ev.text)) {
          if (fence.kind !== 'live') return stale('lease_closed');
          return { outcome: 'applied', reason: null, effect: 'memory', staleReply: false };
        }
        // p14-mcp-core: one external MCP tool call (metadata only) → job_mcp_calls + audit `mcp.tool.call`.
        if (ev.kind === 'mcp_call') {
          if (fence.kind !== 'live') return stale('lease_closed');
          await this.deps.mcpCalls?.()?.recordCall(tx, {
            jobId: message.jobId,
            attemptId: message.payload.attemptId,
            workerId,
            event: ev,
            at: this.deps.clock(),
          });
          return { outcome: 'applied', reason: null, effect: null, staleReply: false };
        }
        if (ev.kind === 'approval_request' || ev.kind === 'memory') {
          if (fence.kind !== 'live') return stale('lease_closed');
          return {
            outcome: 'applied',
            reason: null,
            effect: ev.kind === 'memory' ? 'memory' : 'approval',
            staleReply: false,
          };
        }
        return { outcome: 'applied', reason: null, effect: null, staleReply: false };
      }

      case 'LOG_CHUNK':
        if (fence.kind === 'stale' || fence.kind === 'lost') {
          return stale(fence.kind === 'stale' ? fence.reason : 'lease_expired');
        }
        return { outcome: 'applied', reason: null, effect: null, staleReply: false };

      case 'ARTIFACT_CHUNK': {
        if (fence.kind === 'stale' || fence.kind === 'lost') {
          return stale(fence.kind === 'stale' ? fence.reason : 'lease_expired');
        }
        const sink = this.deps.workspaces?.() ?? null;
        if (sink === null)
          return { outcome: 'rejected', reason: 'artifacts_unsupported', effect: null, staleReply: false };
        const staged = await sink.stageChunk(tx, message.jobId, message.payload, this.deps.clock());
        if (staged !== 'ok') {
          return { outcome: 'rejected', reason: `artifact_${staged}`, effect: null, staleReply: false };
        }
        return { outcome: 'applied', reason: null, effect: null, staleReply: false };
      }

      case 'ARTIFACT_REF': {
        if (fence.kind === 'stale' || fence.kind === 'lost') {
          return stale(fence.kind === 'stale' ? fence.reason : 'lease_expired');
        }
        if (message.payload.artifactId.startsWith('ws-')) {
          // p5-research-workspace: the commit of a streamed workspace artifact (assembled and verified here).
          const sink = this.deps.workspaces?.() ?? null;
          if (sink === null) {
            return { outcome: 'rejected', reason: 'artifacts_unsupported', effect: null, staleReply: false };
          }
          const committed = await sink.commitArtifact(tx, message.jobId, message.payload, this.deps.clock());
          if (committed !== 'ok') {
            this.deps.log.warn(
              { jobId: message.jobId, artifactId: message.payload.artifactId, reason: committed },
              'artifact rejected',
            );
            return { outcome: 'rejected', reason: `artifact_${committed}`, effect: null, staleReply: false };
          }
          this.deps.log.info(
            {
              jobId: message.jobId,
              artifactId: message.payload.artifactId,
              bytes: message.payload.sizeBytes,
            },
            'artifact committed',
          );
        }
        return { outcome: 'applied', reason: null, effect: null, staleReply: false };
      }

      case 'JOB_RESULT':
        return this.#result(tx, workerId, message, fence);
    }
  }

  async #leaseAck(
    tx: PoolClient,
    workerId: string,
    message: Extract<SequencedWorkerMessage, { type: 'LEASE_ACK' }>,
    state: JobState,
  ): Promise<Routed> {
    const p = message.payload;
    if (!p.accepted) {
      if (state !== 'RESERVED') {
        return { outcome: 'rejected', reason: 'decline_after_start', effect: null, staleReply: false };
      }
      // p10-approval-pause: a declined resume of a paused attempt goes back to PAUSED (never queued elsewhere).
      const pause = this.deps.pause?.() ?? null;
      if (
        pause !== null &&
        (await pause.resumeDeclinedWithin(tx, {
          jobId: message.jobId,
          attemptId: p.attemptId,
          epoch: p.epoch,
          workerId,
          reason: p.reason ?? 'declined by the worker',
          permanent: p.declineKind !== 'transient',
        }))
      ) {
        return { outcome: 'applied', reason: null, effect: null, staleReply: false };
      }
      await this.#transition(tx, workerId, message, 'lease_declined', p.reason ?? 'declined by the worker');
      // p9-queue-priority: transient (busy) declines keep the job waiting for this worker instead of excluding it.
      await recordDecline(tx, {
        jobId: message.jobId,
        attemptId: p.attemptId,
        workerId,
        reason: p.reason,
        declineKind: p.declineKind,
        retryAfterMs: p.retryAfterMs,
        now: this.deps.clock(),
      });
      return { outcome: 'applied', reason: null, effect: null, staleReply: false };
    }
    // First acknowledgement starts the attempt; every acknowledgement renews the lease (ADR-0004 §2).
    if (state === 'RESERVED') await this.#transition(tx, workerId, message, 'lease_acked');
    const lease = await this.deps.jobs.renewLeaseWithin(
      tx,
      message.jobId,
      workerId,
      p.epoch,
      this.deps.leaseTtlMs,
    );
    await this.deps.replay().enqueueWithin(
      tx,
      workerId,
      'RENEW_LEASE',
      // p11-master-resilience: the worker dates the confirmation by this acknowledgement's send time.
      renewPayload(this.deps.signer, lease, this.deps.clock(), message.messageId),
      { jobId: message.jobId },
    );
    return { outcome: 'applied', reason: null, effect: null, staleReply: false };
  }

  async #result(
    tx: PoolClient,
    workerId: string,
    message: Extract<SequencedWorkerMessage, { type: 'JOB_RESULT' }>,
    fence: Exclude<Fence, { kind: 'unknown_job' }>,
  ): Promise<Routed> {
    const p = message.payload;
    if (fence.kind === 'stale')
      return { outcome: 'stale', reason: fence.reason, effect: null, staleReply: true };
    const late = fence.kind !== 'live';
    const { attemptId: _a, epoch: _e, ...result } = p;
    await tx.query(
      `INSERT INTO job_runs (attempt_id, job_id, worker_id, result_outcome, result, result_epoch, result_late,
                             result_received_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)
       ON CONFLICT (attempt_id) DO UPDATE
         SET result_outcome = EXCLUDED.result_outcome, result = EXCLUDED.result,
             result_epoch = EXCLUDED.result_epoch, result_late = EXCLUDED.result_late,
             result_received_at = EXCLUDED.result_received_at, updated_at = EXCLUDED.updated_at
       WHERE job_runs.worker_id = EXCLUDED.worker_id`,
      [
        p.attemptId,
        message.jobId,
        workerId,
        p.outcome,
        JSON.stringify(result),
        p.epoch,
        late,
        this.deps.clock(),
      ],
    );
    // p6-capacity-advice: the attempt's measured peak memory feeds the worker × runtime rollup (idempotent per
    // attempt; a measurement is valid whatever happened to the lease).
    if (p.resources !== undefined) {
      await recordJobMemory(tx, {
        attemptId: p.attemptId,
        jobId: message.jobId,
        workerId,
        resources: p.resources,
        now: this.deps.clock(),
      });
    }
    if (fence.kind === 'lost') {
      // Recorded for the reconciler (reconcile_finished), but no state change under a lost lease.
      return { outcome: 'stale', reason: 'lease_expired', effect: null, staleReply: true };
    }
    if (fence.kind === 'closed') {
      return {
        outcome: 'rejected',
        reason: `lease_${fence.releaseReason ?? 'closed'}`,
        effect: null,
        staleReply: false,
      };
    }
    const reason = p.error ? `${p.error.code}: ${p.error.message}` : p.summary || `run ${p.outcome}`;
    let verify = false;
    // p11-usage-limit-fallback: a run stopped by a provider usage limit waits (parked or requeued), falls back or
    // fails as the project's policy says — instead of always failing.
    if (
      p.outcome === 'failed' &&
      p.error?.code === PROVIDER_USAGE_LIMIT_CODE &&
      (fence.state === 'RUNNING' || fence.state === 'STARTING')
    ) {
      const limits = this.deps.usageLimits?.() ?? null;
      if (
        limits !== null &&
        (await limits.onLimitedResultWithin(tx, {
          jobId: message.jobId,
          attemptId: p.attemptId,
          epoch: p.epoch,
          workerId,
          error: p.error,
          paused: p.paused ?? null,
        }))
      ) {
        return { outcome: 'applied', reason: null, effect: null, staleReply: false };
      }
    }
    // p10-approval-pause: the worker paused the run because the master asked it to (PAUSE_JOB).
    if (p.paused !== undefined && (fence.state === 'RUNNING' || fence.state === 'STARTING')) {
      const pause = this.deps.pause?.() ?? null;
      const confirmed =
        pause !== null &&
        (await pause.confirmWithin(tx, {
          jobId: message.jobId,
          attemptId: p.attemptId,
          epoch: p.epoch,
          workerId,
          report: p.paused,
        }));
      if (!confirmed) {
        await this.#transition(
          tx,
          workerId,
          message,
          'attempt_failed',
          'the run stopped as paused without a pause request',
        );
      }
      return { outcome: 'applied', reason: null, effect: null, staleReply: false };
    }
    // p15-auto-mode: a transient failure (runtime crash, disk, credentials / network, provider 5xx, worker restart, a
    // missing base ref the dispatcher heals) goes back to the queue after a backoff instead of failing the job.
    if (p.outcome === 'failed' && (fence.state === 'RUNNING' || fence.state === 'STARTING')) {
      const retry = this.deps.autoRetry?.() ?? null;
      const decision =
        retry === null
          ? null
          : await retry.decideWithin(tx, {
              jobId: message.jobId,
              attemptId: p.attemptId,
              workerId,
              phase: fence.state === 'STARTING' ? 'start' : 'run',
              code: p.error?.code ?? null,
              message: reason,
            });
      if (decision !== null) {
        await this.deps.jobs.transitionWithin(tx, message.jobId, 'attempt_retry', {
          actor: SELF_HEAL_ACTOR,
          retrySafe: true,
          reason: `${decision.reason}: ${reason}`.slice(0, 1000),
        });
        return { outcome: 'applied', reason: null, effect: null, staleReply: false };
      }
    }
    switch (fence.state) {
      case 'CANCELLING':
        await this.#transition(tx, workerId, message, 'cancel_confirmed', `run stopped (${p.outcome})`);
        break;
      case 'STARTING':
        if (p.outcome === 'succeeded') {
          await this.#transition(tx, workerId, message, 'runtime_started');
          verify = await this.#finish(tx, workerId, message);
        } else {
          await this.#transition(tx, workerId, message, 'attempt_failed', reason);
        }
        break;
      case 'RUNNING':
        if (p.outcome === 'succeeded') verify = await this.#finish(tx, workerId, message);
        else if (p.outcome === 'failed')
          await this.#transition(tx, workerId, message, 'attempt_failed', reason);
        else {
          await this.#transition(
            tx,
            workerId,
            message,
            'attempt_failed',
            'the run stopped as cancelled without a cancel request',
          );
        }
        break;
      default:
        return { outcome: 'rejected', reason: `result_in_${fence.state}`, effect: null, staleReply: false };
    }
    return { outcome: 'applied', reason: null, effect: null, staleReply: false, verify };
  }

  /**
   * RUNNING → VERIFYING (worker). Jobs enrolled in git flow stay in VERIFYING until the master verified the
   * attempt branch on the remote (p4-git-flow, T-WRK-2) — returns true so the verification starts after
   * commit. Other jobs (no git provider configured for the project) keep the earlier behaviour:
   * VERIFYING → SUCCEEDED by the `verifier` on the worker's report.
   */
  async #finish(
    tx: PoolClient,
    workerId: string,
    message: Extract<SequencedWorkerMessage, { type: 'JOB_RESULT' }>,
  ): Promise<boolean> {
    await this.#transition(tx, workerId, message, 'run_finished');
    const gitflow = this.deps.gitflow?.() ?? null;
    if (gitflow !== null && (await gitflow.usesGitFlow(tx, message.jobId))) return true;
    await this.deps.jobs.transitionWithin(tx, message.jobId, 'verification_passed_no_approval', {
      actor: { type: 'system', id: 'verifier' },
    });
    return false;
  }

  async #transition(
    tx: PoolClient,
    workerId: string,
    message: SequencedWorkerMessage,
    trigger: JobTrigger,
    reason?: string,
  ): Promise<void> {
    await this.deps.jobs.transitionWithin(tx, message.jobId, trigger, {
      actor: { type: 'worker', id: workerId },
      epoch: message.payload.epoch,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  async #recordPhase(tx: PoolClient, attemptId: string, phase: string): Promise<void> {
    await tx.query('UPDATE job_runs SET last_phase = $2, updated_at = $3 WHERE attempt_id = $1', [
      attemptId,
      phase,
      this.deps.clock(),
    ]);
  }
}

/**
 * Runs one effect after commit and records its status (the reconciler retries `pending` ones and claims
 * older than `staleClaimMs`). The claim (pending → running) makes concurrent runners mutually exclusive.
 */
export async function runEffect(
  db: Queryable,
  effects: InboxEffects,
  inboxId: string,
  workerId: string,
  message: Extract<SequencedWorkerMessage, { type: 'EVENT' }>,
  now: Date,
  staleClaimMs = 60_000,
): Promise<void> {
  const claimed = await db.query(
    `UPDATE worker_inbox SET effect_status = 'running', effect_claimed_at = $2,
            effect_attempts = effect_attempts + 1
      WHERE id = $1 AND (effect_status = 'pending' OR (effect_status = 'running' AND effect_claimed_at < $3))`,
    [inboxId, now, new Date(now.getTime() - staleClaimMs)],
  );
  if (claimed.rowCount !== 1) return;
  try {
    await effects.run(inboxId, workerId, message);
    await db.query(`UPDATE worker_inbox SET effect_status = 'done' WHERE id = $1`, [inboxId]);
  } catch (err) {
    const code = err instanceof Error ? err.name.slice(0, 64) : 'error';
    await db.query(
      `UPDATE worker_inbox SET effect_error = $2,
              effect_status = CASE WHEN effect_attempts >= 5 THEN 'failed' ELSE 'pending' END
        WHERE id = $1`,
      [inboxId, code],
    );
    throw err;
  }
}
