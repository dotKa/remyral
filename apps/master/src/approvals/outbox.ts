import { ApprovalDecision, PROTOCOL_VERSION, WorkerId } from '@remyral/protocol';
import { z } from 'zod';

/**
 * Outbox contract for in-run approval decisions (p4-approvals → worker transport). One row is written in
 * the same transaction that decides (or expires) an `in_run` request, so "row exists" ⇔ "decision
 * committed". The transport relays it as an `APPROVAL_DECISION` message to `workerId`; the worker drops
 * it if `message.epoch` is not its current lease epoch (ADR-0004 fencing on the receiving side too).
 *
 * Gate requests (job in AWAITING_APPROVAL) need no worker message: their decision is the
 * `approval_granted`/`approval_denied` job transition, published on the `job.transition` topic.
 */
export const OUTBOX_TOPIC_APPROVAL_DECISION = 'approval.decision';

/** Exactly the protocol `APPROVAL_DECISION` payload. */
export const ApprovalDecisionMessagePayload = ApprovalDecision.shape.payload;
export type ApprovalDecisionMessagePayload = z.infer<typeof ApprovalDecisionMessagePayload>;

export const ApprovalDecisionOutboxPayload = z.strictObject({
  requestId: z.uuid(),
  jobId: z.uuid(),
  /** Worker holding the lease the request was made under; the message is addressed to it. */
  workerId: WorkerId,
  /** `approved`/`denied` by a human, or `expired`/`cancelled` by the system (sent to the worker as deny). */
  status: z.enum(['approved', 'denied', 'expired', 'cancelled']),
  message: ApprovalDecisionMessagePayload,
});
export type ApprovalDecisionOutboxPayload = z.infer<typeof ApprovalDecisionOutboxPayload>;

export interface EnvelopeFields {
  readonly messageId: string;
  readonly seq: number;
  readonly ts: string;
  readonly correlationId: string;
}

/**
 * Builds the wire message for one outbox row (for the transport; validates against the protocol schema,
 * so a malformed row can never be sent).
 */
export function toApprovalDecisionMessage(
  payload: ApprovalDecisionOutboxPayload,
  envelope: EnvelopeFields,
): ApprovalDecisionMessage {
  return ApprovalDecision.parse({
    protocolVersion: PROTOCOL_VERSION,
    ...envelope,
    type: 'APPROVAL_DECISION',
    workerId: payload.workerId,
    jobId: payload.jobId,
    payload: payload.message,
  });
}

export type ApprovalDecisionMessage = z.infer<typeof ApprovalDecision>;

/**
 * p5-notifications: written in the transaction that creates a pending approval request (gate or in-run), so
 * users who can decide it are notified. Identifiers only; the consumer re-reads the request. `job_id` of the
 * outbox row stays NULL (this is not a job state event; per-job outbox consumers are unaffected).
 */
export const OUTBOX_TOPIC_APPROVAL_REQUESTED = 'approval.requested';

export const ApprovalRequestedOutboxPayload = z.strictObject({ requestId: z.uuid(), jobId: z.uuid() });
export type ApprovalRequestedOutboxPayload = z.infer<typeof ApprovalRequestedOutboxPayload>;
