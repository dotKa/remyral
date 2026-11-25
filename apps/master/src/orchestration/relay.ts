import { Queue, Worker } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { ApprovalDecisionOutboxPayload, OUTBOX_TOPIC_APPROVAL_DECISION } from '../approvals/outbox.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { JobTransitionOutboxPayload, OUTBOX_TOPIC_JOB_TRANSITION } from '../jobs/outbox.js';
import type { WorkerReplay } from '../workers/replay.js';
import type { JobHint } from './orchestrator.js';

/** Where delivery hints go (ADR-0003 §2). Implementations must not be the source of truth. */
export interface HintQueue {
  publish(hints: readonly JobHint[]): Promise<void>;
  close(): Promise<void>;
}

export const HINT_QUEUE_NAME = 'remyral-job-hints';
/** Job states whose hints a dispatcher acts on; others are dropped at the relay. */
const ACTIONABLE = new Set(['QUEUED', 'CANCELLING']);

export interface OutboxRelayDeps {
  readonly pool: Pool;
  readonly queue: HintQueue;
  readonly replay: () => WorkerReplay;
  readonly log: FastifyBaseLogger;
  readonly clock: () => Date;
  /** A publish that does not finish in time leaves the rows for the next pass (Redis down). */
  readonly publishTimeoutMs?: number;
}

/**
 * Relays the transactional outbox (ADR-0003 §1–2):
 * - `job.transition` rows become BullMQ delivery hints `{jobId, version}` (only for states a dispatcher
 *   acts on). Redis being down only delays dispatch: rows stay pending, and the reconciliation loop
 *   re-derives work from Postgres anyway.
 * - `approval.decision` rows become a durable `APPROVAL_DECISION` in the addressed worker's outbox, written
 *   in the same transaction that marks the row dispatched (exactly once).
 * Other topics (`usage.budget.threshold`, …) belong to other consumers and are left untouched.
 * Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several relays never double-publish a row.
 */
export class OutboxRelay {
  constructor(private readonly deps: OutboxRelayDeps) {}

  async relayOnce(limit = 200): Promise<number> {
    const touched = new Set<string>();
    const count = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string; topic: string; payload: unknown }>(
        `SELECT id::text AS id, topic, payload FROM outbox
          WHERE dispatched_at IS NULL AND topic = ANY($1)
          ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [[OUTBOX_TOPIC_JOB_TRANSITION, OUTBOX_TOPIC_APPROVAL_DECISION], limit],
      );
      if (rows.length === 0) return 0;
      const hints: JobHint[] = [];
      for (const row of rows) {
        if (row.topic === OUTBOX_TOPIC_JOB_TRANSITION) {
          const p = JobTransitionOutboxPayload.safeParse(row.payload);
          if (p.success && ACTIONABLE.has(p.data.to))
            hints.push({ jobId: p.data.jobId, version: p.data.version });
        } else {
          const p = ApprovalDecisionOutboxPayload.safeParse(row.payload);
          if (!p.success) {
            this.deps.log.error({ outboxId: row.id }, 'malformed approval.decision outbox row skipped');
            continue;
          }
          await this.deps
            .replay()
            .enqueueWithin(tx, p.data.workerId, 'APPROVAL_DECISION', p.data.message, { jobId: p.data.jobId });
          touched.add(p.data.workerId);
        }
      }
      if (hints.length > 0) {
        await withTimeout(this.deps.queue.publish(hints), this.deps.publishTimeoutMs ?? 2_000);
      }
      await tx.query('UPDATE outbox SET dispatched_at = $2 WHERE id = ANY($1::bigint[])', [
        rows.map((r) => r.id),
        this.deps.clock(),
      ]);
      return rows.length;
    });
    for (const w of touched) this.deps.replay().kick(w);
    return count;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('hint publish timed out'));
      }, ms);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

/** In-process hints (no Redis): used where BullMQ is not configured. */
export class DirectHintQueue implements HintQueue {
  constructor(private readonly onHint: (hint: JobHint) => Promise<void>) {}
  async publish(hints: readonly JobHint[]): Promise<void> {
    for (const h of hints) void this.onHint(h).catch(() => undefined);
    await Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface BullHintQueueOptions {
  readonly redisUrl: string;
  /** Redis key prefix (BullMQ `prefix`), e.g. per environment or test. */
  readonly prefix?: string;
  readonly concurrency?: number;
  readonly onHint: (hint: JobHint) => Promise<void>;
  readonly log: FastifyBaseLogger;
}

/**
 * BullMQ transport for hints (bullmq 6.3.11). Job id `<jobId>.<version>` deduplicates repeated relays of
 * the same transition; completed hints are removed (a hint is worthless once acted on). The consumer is a
 * BullMQ Worker that calls back into the orchestrator, which re-reads Postgres.
 */
export class BullHintQueue implements HintQueue {
  readonly #queue: Queue;
  readonly #worker: Worker;
  readonly #connections: Redis[] = [];

  constructor(opts: BullHintQueueOptions) {
    const connection = (name: string): Redis => {
      // BullMQ requires maxRetriesPerRequest: null for blocking worker connections.
      const r = new Redis(opts.redisUrl, {
        maxRetriesPerRequest: null,
        connectionName: name,
        lazyConnect: false,
      });
      r.on('error', () => undefined);
      this.#connections.push(r);
      return r;
    };
    const prefix = opts.prefix ?? 'remyral';
    this.#queue = new Queue(HINT_QUEUE_NAME, { connection: connection('remyral-hints-queue'), prefix });
    this.#queue.on('error', (err) => {
      opts.log.debug({ err }, 'hint queue error');
    });
    this.#worker = new Worker(
      HINT_QUEUE_NAME,
      async (job) => {
        const data = job.data as { jobId?: unknown; version?: unknown };
        if (typeof data.jobId !== 'string' || typeof data.version !== 'number') return;
        await opts.onHint({ jobId: data.jobId, version: data.version });
      },
      { connection: connection('remyral-hints-worker'), prefix, concurrency: opts.concurrency ?? 4 },
    );
    this.#worker.on('error', (err) => {
      opts.log.debug({ err }, 'hint consumer error');
    });
  }

  async publish(hints: readonly JobHint[]): Promise<void> {
    await this.#queue.addBulk(
      hints.map((h) => ({
        name: 'job',
        data: h,
        opts: { jobId: `${h.jobId}.${String(h.version)}`, removeOnComplete: true, removeOnFail: 1000 },
      })),
    );
  }

  async close(): Promise<void> {
    await this.#worker.close().catch(() => undefined);
    await this.#queue.close().catch(() => undefined);
    for (const c of this.#connections) c.disconnect();
  }
}
