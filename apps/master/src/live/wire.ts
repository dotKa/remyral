import { z } from 'zod';
import { ApprovalHintsBody, eventHints } from '../approvals/details.js';
import { EVENT_KINDS, type EventItem, type LiveItem, LOG_STREAMS, type LogItem } from './store.js';

/** JSON shapes shared by the SSE stream and the REST routes (docs/design/p5-live.md §5). */

export const LogBody = z.object({
  type: z.literal('log'),
  seq: z.number().int(),
  attemptId: z.string(),
  attemptNo: z.number().int(),
  epoch: z.number().int(),
  workerSeq: z.number().int(),
  stream: z.enum(LOG_STREAMS),
  chunkSeq: z.number().int(),
  ts: z.string(),
  text: z.string(),
});

export const EventBody = z.object({
  type: z.literal('event'),
  seq: z.number().int(),
  attemptId: z.string(),
  attemptNo: z.number().int(),
  epoch: z.number().int(),
  workerSeq: z.number().int(),
  kind: z.enum(EVENT_KINDS),
  payload: z.record(z.string(), z.unknown()),
  ts: z.string(),
  approval: z
    .object({
      requestId: z.string(),
      status: z.string(),
      stepUp: z.boolean(),
      approverRole: z.string(),
    })
    .nullable(),
  /** p10-approval-readable (additive, `approval_request` only): static reading of the call's `details`. */
  hints: ApprovalHintsBody.nullable().optional(),
});

export function logJson(i: LogItem): z.infer<typeof LogBody> {
  return {
    type: 'log',
    seq: i.streamSeq,
    attemptId: i.attemptId,
    attemptNo: i.attemptNo,
    epoch: i.epoch,
    workerSeq: i.workerSeq,
    stream: i.stream,
    chunkSeq: i.chunkSeq,
    ts: i.ts.toISOString(),
    text: i.text,
  };
}

export function eventJson(i: EventItem): z.infer<typeof EventBody> {
  return {
    type: 'event',
    seq: i.streamSeq,
    attemptId: i.attemptId,
    attemptNo: i.attemptNo,
    epoch: i.epoch,
    workerSeq: i.workerSeq,
    kind: i.kind,
    payload: i.payload,
    ts: i.ts.toISOString(),
    approval: i.approval,
    ...(i.kind === 'approval_request' ? { hints: eventHints(i.payload) } : {}),
  };
}

export function itemJson(i: LiveItem): z.infer<typeof LogBody> | z.infer<typeof EventBody> {
  return i.type === 'log' ? logJson(i) : eventJson(i);
}
