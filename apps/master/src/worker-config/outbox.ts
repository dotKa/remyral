import { z } from 'zod';

/**
 * Worker configuration events on the shared outbox (ADR-0015 §7, p5-notifications). Identifiers only;
 * consumers re-read Postgres. `job_id` of these rows stays NULL.
 */
export const OUTBOX_TOPIC_WORKER_CONFIG = 'worker.config';
export const WorkerConfigOutboxPayload = z.strictObject({
  workerId: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  /** `changed`: a new desired generation was stored; `rejected`: the worker refused a generation. */
  event: z.enum(['changed', 'rejected']),
});
export type WorkerConfigOutboxPayload = z.infer<typeof WorkerConfigOutboxPayload>;
