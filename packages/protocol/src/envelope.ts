import { z } from 'zod';
import { Identifier, JobId, NonNegativeInt, Timestamp, WorkerId } from './common.js';
import { ProtocolVersion } from './version.js';

/**
 * Fields every message carries (ARCHITECTURE.md "Worker protocol").
 *
 * `seq` semantics (p2-replay, docs/design/p2-transport.md):
 * - `seq >= 1` marks a **sequenced** (durable) message. Each sender keeps one
 *   monotonic counter per worker that is **durable across reconnects and
 *   restarts** — it is not per connection. The worker's counter lives in its
 *   outbox (LEASE_ACK, EVENT, LOG_CHUNK, JOB_RESULT, ARTIFACT_REF); the master's
 *   in its per-worker outbox (ASSIGN_JOB, RENEW_LEASE, CANCEL_JOB, …). The
 *   receiver processes each seq once, in order, and acknowledges with
 *   `ACK{throughSeq}`; after a reconnect the sender replays everything after the
 *   peer's resume cursor (`HELLO.resumeFromSeq` / `SESSION_ESTABLISHED.resumeFromSeq`).
 * - `seq = 0` marks a connection-scoped **control** message (HELLO, AUTH,
 *   CHALLENGE, SESSION_ESTABLISHED, HEARTBEAT, CAPABILITIES, ACK, ERROR, …):
 *   never replayed, never moves a cursor.
 *
 * `messageId` is the idempotency key (ADR-0004 §4).
 *
 * `traceparent` (p16-observability, docs/design/p16-observability.md §4): optional W3C Trace Context of the span that
 * sent the message (ASSIGN_JOB, RENEW_LEASE, ASSISTANT_TURN …), so the receiver continues the trace. Ids and the
 * sampled flag only. Older peers strip the unknown field; a malformed value is refused like any invalid envelope.
 */
export const Traceparent = z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);

const base = {
  protocolVersion: ProtocolVersion,
  messageId: z.uuid(),
  seq: NonNegativeInt,
  ts: Timestamp,
  correlationId: Identifier,
  traceparent: Traceparent.optional(),
};

/** Before enrollment completes the worker has no id yet. */
export function anonymousMessage<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...base, type: z.literal(type), workerId: WorkerId.optional(), payload });
}

export function workerMessage<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...base, type: z.literal(type), workerId: WorkerId, payload });
}

/** Job-scoped messages must name the job in the envelope. */
export function jobMessage<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...base, type: z.literal(type), workerId: WorkerId, jobId: JobId, payload });
}
