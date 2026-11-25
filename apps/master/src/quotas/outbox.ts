import { z } from 'zod';

/**
 * Outbox contract for quota enforcement decisions (p4-quotas → p5-notifications). Written in the same
 * transaction as the `quota_events` row that records the decision, only when that row was inserted (each
 * decision is announced once). Identifiers and enumerations only — never free text from a worker/runtime.
 */
export const OUTBOX_TOPIC_QUOTA_ENFORCEMENT = 'quota.enforcement';

export const QUOTA_EVENT_KINDS = [
  'dispatch_held',
  'job_stopped',
  'incomplete_cost',
  'provider_paused',
  'provider_resumed',
  'kill_switch',
  'hold_released',
] as const;
export type QuotaEventKind = (typeof QUOTA_EVENT_KINDS)[number];

export const QuotaEnforcementOutboxPayload = z.strictObject({
  kind: z.enum(QUOTA_EVENT_KINDS),
  code: z.string().regex(/^[a-z_]{1,64}$/),
  project: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
    .nullable(),
  jobId: z.uuid().nullable(),
  workerId: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
    .nullable(),
  runtime: z
    .string()
    .regex(/^[a-z0-9_-]{1,32}$/)
    .nullable(),
  at: z.iso.datetime(),
});
export type QuotaEnforcementOutboxPayload = z.infer<typeof QuotaEnforcementOutboxPayload>;
