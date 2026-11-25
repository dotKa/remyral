import { z } from 'zod';

/**
 * p6-automations: a run ended `failed` / `error` (design §11) — or, p6-automation-defaults, was cancelled because
 * nobody approved in time (`approvalTimeout`). On the shared outbox for the notification producer (the project's
 * operators). Identifiers and enumerations only; `job_id` stays NULL.
 */
export const OUTBOX_TOPIC_AUTOMATION_RUN = 'automation.run';

export const AutomationRunOutboxPayload = z.strictObject({
  automationId: z.uuid(),
  runId: z.uuid(),
  state: z.enum(['failed', 'error', 'cancelled']),
  /** The automation stopped (its run-as user lost the right to submit). */
  stopped: z.boolean(),
  /** p6-automation-defaults: cancelled after waiting longer than the automation's approval timeout (minutes). */
  approvalTimeoutMinutes: z.number().int().min(1).optional(),
});
export type AutomationRunOutboxPayload = z.infer<typeof AutomationRunOutboxPayload>;

/**
 * p6-automation-defaults (design §11a): an unattended run waits for a human approval. Sent once per run (the first
 * time the start/sync pass sees it waiting); the producer notifies the project's operators.
 */
export const OUTBOX_TOPIC_AUTOMATION_WAITING = 'automation.waiting';

export const AutomationWaitingOutboxPayload = z.strictObject({
  automationId: z.uuid(),
  runId: z.uuid(),
  approvalId: z.uuid(),
});
export type AutomationWaitingOutboxPayload = z.infer<typeof AutomationWaitingOutboxPayload>;
