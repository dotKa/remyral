import { z } from 'zod';

/**
 * p8-uptime: a monitor went down, is up again, started flapping, or its TLS certificate expires soon — the notification producer reads the monitor and
 * incident rows. Identifiers only; `job_id` of these outbox rows stays NULL.
 */
export const OUTBOX_TOPIC_MONITOR = 'uptime.monitor';
export const MonitorOutboxPayload = z.strictObject({
  monitorId: z.uuid(),
  event: z.enum(['down', 'up', 'flapping', 'tls']),
  /** The incident the event belongs to (down: the one opened; up: the one closed), when there is one. */
  incidentId: z.uuid().nullable(),
  /** The check that caused it (dedupe per event). */
  checkId: z.string().regex(/^\d{1,19}$/),
});
export type MonitorOutboxPayload = z.infer<typeof MonitorOutboxPayload>;
