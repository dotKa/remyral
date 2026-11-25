import { z } from 'zod';
import { AttemptId, Epoch } from './common.js';

/**
 * p15-message-delivery (docs/design/p15-message-delivery.md): the delivery state of a human message to a job's agent
 * (`POST /jobs/:id/messages`, chat `draft_job_message`). Browser-safe (zod only): the master, the worker and the console
 * share the vocabulary.
 *
 * ```
 * waiting ─▶ sent ─▶ received ─▶ delivered ─▶ read
 *    │         │         │            │
 *    └─────────┴─────────┴────────────┴──▶ failed (code + detail)
 * ```
 *
 * - `waiting`   the master holds it: the job has no running agent yet (queued, paused, retry wait); sent on start.
 * - `sent`      in the worker's durable outbox (replayed after reconnects).
 * - `received`  the worker acknowledged it (outbox ACK; `held` while the runtime is still starting).
 * - `delivered` the runtime accepted it (`sendPrompt` resolved: queued for the next turn boundary or steered in).
 * - `read`      the agent took it into its context (the runtime says so, or the agent's next output after a steer).
 * - `failed`    it will not reach the agent; `code` says why.
 */
export const JOB_MESSAGE_STATUSES = ['waiting', 'sent', 'received', 'delivered', 'read', 'failed'] as const;
export type JobMessageDeliveryStatus = (typeof JOB_MESSAGE_STATUSES)[number];

/** Why a message failed. Unknown codes from newer workers are shown as `runtime_refused`. */
export const JOB_MESSAGE_FAILURES = [
  /** The worker no longer runs this job (it ended, or the worker restarted). */
  'job_not_running',
  /** The message names an attempt / lease the worker is not running any more (a newer attempt took over). */
  'attempt_superseded',
  /** The agent's run ended before the agent took the message (finished its turn, failed or was stopped). */
  'run_ended',
  /** The runtime refused the follow-up (detail: its reason). */
  'runtime_refused',
  /** The runtime of this job cannot take messages while it runs. */
  'unsupported',
  /** The worker running the job must be updated to take messages. */
  'worker_update_required',
  /** The job ended (or was cancelled) before the message could be sent. */
  'job_ended',
] as const;
export type JobMessageFailure = (typeof JOB_MESSAGE_FAILURES)[number];

/** Worker feature: answers JOB_MESSAGE carrying `receipts: true` with JOB_MESSAGE_STATUS. */
export const JOB_MESSAGE_RECEIPTS_FEATURE = 'job-message-receipts-v1';

/** The statuses a worker reports (the master derives `waiting` / `sent` itself). */
export const WORKER_MESSAGE_STATUSES = ['received', 'delivered', 'read', 'failed'] as const;

/**
 * `JOB_MESSAGE_STATUS` payload (worker → master, control, job message): one step of one message. Monotonic on the
 * master (a lower step after a higher one is ignored), idempotent (re-sent after a reconnect).
 */
export const JobMessageStatusPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  messageId: z.uuid(),
  status: z.enum(WORKER_MESSAGE_STATUSES),
  /** `received`: `held` while the runtime is starting. `failed`: one of {@link JOB_MESSAGE_FAILURES} (or newer). */
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
  /** Redacted, bounded human detail (e.g. the runtime's refusal). Untrusted text. */
  detail: z.string().max(500).optional(),
});
export type JobMessageStatusPayload = z.infer<typeof JobMessageStatusPayload>;

const RANK: Readonly<Record<JobMessageDeliveryStatus, number>> = {
  waiting: 0,
  sent: 1,
  received: 2,
  delivered: 3,
  read: 4,
  failed: 5,
};

/** Whether `next` may replace `current` (forward only; `read` and `failed` are final). */
export function jobMessageAdvances(
  current: JobMessageDeliveryStatus,
  next: JobMessageDeliveryStatus,
): boolean {
  if (current === 'read' || current === 'failed') return false;
  if (next === 'failed') return true;
  return RANK[next] > RANK[current];
}

/** Final statuses (nothing changes them any more). */
export function jobMessageFinal(status: JobMessageDeliveryStatus): boolean {
  return status === 'read' || status === 'failed';
}
