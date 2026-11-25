import { JOB_STATES, JOB_TRIGGERS } from '@remyral/scheduler';
import { z } from 'zod';

/**
 * Outbox contract consumed by the dispatcher (p4-dispatch, ADR-0003 §1–2). One row is written in the same
 * transaction as every job history row, so "outbox row exists" ⇔ "transition committed". The payload holds
 * identifiers only; consumers re-read Postgres and treat the message as a hint.
 */
export const OUTBOX_TOPIC_JOB_TRANSITION = 'job.transition';

export const JobTransitionOutboxPayload = z.strictObject({
  jobId: z.uuid(),
  /** job_transitions.id of the history row this event describes. */
  transitionId: z.string().regex(/^\d+$/),
  /** Job version after the transition (monotonic per job: consumers can drop stale events). */
  version: z.number().int().min(1),
  from: z.enum(JOB_STATES).nullable(),
  to: z.enum(JOB_STATES),
  trigger: z.union([z.enum(JOB_TRIGGERS), z.literal('create')]),
  attemptId: z.uuid().nullable(),
  /** Fencing epoch of the lease involved (ADR-0004), if any. */
  epoch: z.number().int().min(1).nullable(),
});
export type JobTransitionOutboxPayload = z.infer<typeof JobTransitionOutboxPayload>;
