import { z } from 'zod';

/**
 * Fleet events on the shared outbox (p5-notifications, additive). Identifiers only; consumers re-read
 * Postgres. `job_id` of these rows stays NULL.
 */

/** A new worker requested enrollment (pairing request created a `pending` worker). */
export const OUTBOX_TOPIC_WORKER_PENDING = 'worker.pending';
export const WorkerPendingOutboxPayload = z.strictObject({ workerId: z.string().min(1).max(128) });
export type WorkerPendingOutboxPayload = z.infer<typeof WorkerPendingOutboxPayload>;
