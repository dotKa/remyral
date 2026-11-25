import { z } from 'zod';
import { NonNegativeInt } from './common.js';
import { workerMessage } from './envelope.js';

/**
 * Cumulative acknowledgement of the peer's sequenced messages (both directions,
 * p2-replay). `throughSeq` is the highest seq the sender has durably processed;
 * every seq ≤ it may be dropped from the peer's outbox. Control message (`seq = 0`).
 */
export const Ack = workerMessage('ACK', z.object({ throughSeq: NonNegativeInt }));

/**
 * Message types that are sequenced (durable, replayed after reconnect, `seq >= 1`).
 * Every other type is a connection-scoped control message and carries `seq = 0`.
 */
export const SEQUENCED_WORKER_TYPES = [
  'LEASE_ACK',
  'EVENT',
  'LOG_CHUNK',
  'JOB_RESULT',
  'ARTIFACT_REF',
  /** p5-research-workspace (additive). */
  'ARTIFACT_CHUNK',
] as const;
export const SEQUENCED_MASTER_TYPES = [
  'ASSIGN_JOB',
  'RENEW_LEASE',
  'CANCEL_JOB',
  'APPROVAL_DECISION',
  'UPDATE_POLICY',
  'JOB_MESSAGE',
  'SET_APPROVAL_POLICY',
  /** p15-autonomy (additive): a running job's new time limit. */
  'SET_TIME_LIMIT',
  /** p10-approval-pause (additive). */
  'PAUSE_JOB',
] as const;

export function isSequencedWorkerType(type: string): boolean {
  return (SEQUENCED_WORKER_TYPES as readonly string[]).includes(type);
}

export function isSequencedMasterType(type: string): boolean {
  return (SEQUENCED_MASTER_TYPES as readonly string[]).includes(type);
}
