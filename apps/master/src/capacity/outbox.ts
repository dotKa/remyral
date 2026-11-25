import { z } from 'zod';

/**
 * p8-capacity-auto: a capacity suggestion was recorded (suggest mode) — the notification producer reads the event
 * row. Identifiers only; `job_id` of these outbox rows stays NULL.
 */
export const OUTBOX_TOPIC_WORKER_CAPACITY = 'worker.capacity';
export const WorkerCapacityOutboxPayload = z.strictObject({
  workerId: z.string().min(1).max(128),
  eventId: z.string().regex(/^\d{1,19}$/),
});
export type WorkerCapacityOutboxPayload = z.infer<typeof WorkerCapacityOutboxPayload>;
