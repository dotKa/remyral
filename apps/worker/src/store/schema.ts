import {
  AttemptId,
  Ed25519PublicKey,
  Epoch,
  JobId,
  NonNegativeInt,
  Timestamp,
  WorkerId,
} from '@remyral/protocol';
import { z } from 'zod';

/** Lease the worker currently holds (ADR-0004: must survive daemon restarts). */
export const LeaseRecord = z.strictObject({
  jobId: JobId,
  attemptId: AttemptId,
  epoch: Epoch,
  expiresAt: Timestamp,
});
export type LeaseRecord = z.infer<typeof LeaseRecord>;
/** Unbranded input accepted by the store (validated on entry). */
export type LeaseInput = z.input<typeof LeaseRecord>;

export const WorkerIdentityRecord = z.strictObject({
  workerId: WorkerId,
  /** The device public key the enrollment was approved for. */
  publicKey: Ed25519PublicKey,
  enrolledAt: Timestamp,
});
export type WorkerIdentityRecord = z.infer<typeof WorkerIdentityRecord>;
export type WorkerIdentityInput = z.input<typeof WorkerIdentityRecord>;

export const STORE_VERSION = 1;

export const StoreState = z.strictObject({
  version: z.literal(STORE_VERSION),
  identity: WorkerIdentityRecord.nullable(),
  leases: z.array(LeaseRecord).max(64),
  cursors: z.strictObject({
    /** Highest master `seq` processed; sent as `HELLO.resumeFromSeq` (ADR-0011, p2-replay). */
    lastMasterSeq: NonNegativeInt,
    /** Highest own outbound `seq` the master acknowledged; the outbox drops everything ≤ it. */
    ackedOutboundSeq: NonNegativeInt,
  }),
});
export type StoreState = z.infer<typeof StoreState>;

export function emptyState(): StoreState {
  return {
    version: STORE_VERSION,
    identity: null,
    leases: [],
    cursors: { lastMasterSeq: 0, ackedOutboundSeq: 0 },
  };
}

/** One durable outbox line. `message` is an already-redacted protocol envelope. */
export const OutboxEntry = z.strictObject({ seq: z.number().int().min(1), message: z.unknown() });
export type OutboxEntry = z.infer<typeof OutboxEntry>;
