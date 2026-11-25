import { z } from 'zod';

/**
 * p10-verify-health: a job's verification failed (or could not run) / a deploy's health check failed — the
 * notification producer reads the rows. Identifiers only; `job_id` of these outbox rows stays NULL.
 */
export const OUTBOX_TOPIC_VERIFY = 'verify.result';
export const VerifyOutboxPayload = z.strictObject({
  kind: z.enum(['job', 'health']),
  id: z.uuid(),
});
export type VerifyOutboxPayload = z.infer<typeof VerifyOutboxPayload>;
