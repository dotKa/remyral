import { z } from 'zod';
import { workerMessage } from './envelope.js';

/**
 * Multiplexed byte streams over the worker WebSocket (ADR-0066; the plane of ADR-0013 that ADR-0023 removed with
 * OpenHands, brought back for "Tam IDE", docs/design/p19-ide.md §2.2). Additive in protocol 1.0: the master opens
 * streams only to workers that advertise the `ide-v1` feature in CAPABILITIES, so older peers never see them.
 *
 * - Control messages are ordinary JSON envelopes (seq 0, never replayed): `STREAM_OPEN` (master → worker),
 *   `STREAM_ACCEPT` (worker → master), `STREAM_WINDOW` and `STREAM_CLOSE` (both directions).
 * - Data travels in **binary** WebSocket frames `[u8 kind = 0x01][u32 BE streamId][payload]` — no base64 and no
 *   JSON parse per chunk; binary frames carry nothing else.
 * - Flow control is credit based per stream and per direction: a peer may only send as many payload bytes as the
 *   receiver granted (`window` at open / accept, then `STREAM_WINDOW{credit}` as the receiver's consumer drains).
 *   Exceeding the credit is a protocol violation. A slow consumer stalls only its own stream, never control traffic
 *   or other streams, and memory per stream is bounded by its window (the "backpressure" of the plane).
 * - Only the master opens streams, and only to an allow-listed **target** (never a host:port): `ide` + a workspace id
 *   the worker runs itself. The worker looks up that workspace's loopback port and connection token and refuses
 *   everything else.
 */

/** Binary data frame kind byte. */
export const STREAM_DATA_KIND = 0x01;
/** Bytes before the payload of a binary data frame: kind (1) + stream id (4). */
export const STREAM_HEADER_BYTES = 5;
/** Largest payload of one data frame (well below MAX_FRAME_BYTES). */
export const MAX_STREAM_PAYLOAD = 64 * 1024;
export const MAX_STREAM_ID = 2 ** 31 - 1;
/** Smallest / largest receive window a peer may grant at open / accept. */
export const MIN_STREAM_WINDOW = 1024;
export const MAX_STREAM_WINDOW = 1024 * 1024;
/** Default receive window per stream (bytes). */
export const DEFAULT_STREAM_WINDOW = 256 * 1024;

export const StreamId = z.number().int().min(1).max(MAX_STREAM_ID);
export type StreamId = z.infer<typeof StreamId>;

/** Allow-listed stream targets. A target names *what* to reach; the receiver decides *where* it is. */
export const StreamTarget = z.enum(['ide']);
export type StreamTarget = z.infer<typeof StreamTarget>;

export const StreamCloseReason = z.enum([
  /** Normal end (with `mode: fin` this is implied). */
  'done',
  /** The target refused or is not allowed (unknown target, wrong workspace). */
  'refused',
  /** The addressed workspace does not run here (any more). */
  'not_found',
  /** The local target could not be reached (server not listening, connect error). */
  'unavailable',
  /** Too many streams, or the receiver cannot keep up. */
  'overloaded',
  /** The peer broke the stream protocol (credit exceeded, data after FIN, duplicate id). */
  'protocol',
  /** The stream was not accepted / did not progress in time. */
  'timeout',
  /** The workspace stopped (idle, stop, memory) or the process is shutting down. */
  'shutdown',
  /** Any other local error (I/O). */
  'error',
]);
export type StreamCloseReason = z.infer<typeof StreamCloseReason>;

const Window = z.number().int().min(MIN_STREAM_WINDOW).max(MAX_STREAM_WINDOW);

export const StreamOpen = workerMessage(
  'STREAM_OPEN',
  z.object({
    streamId: StreamId,
    target: StreamTarget,
    /** The IDE workspace the stream reaches (target `ide`). */
    workspaceId: z.uuid(),
    /** Bytes the worker may send on this stream before the master grants more. */
    window: Window,
  }),
);

export const StreamAccept = workerMessage(
  'STREAM_ACCEPT',
  z.object({
    streamId: StreamId,
    /** Bytes the master may send on this stream before the worker grants more. */
    window: Window,
  }),
);

export const StreamWindow = workerMessage(
  'STREAM_WINDOW',
  z.object({ streamId: StreamId, credit: z.number().int().min(1).max(MAX_STREAM_WINDOW) }),
);

export const StreamClose = workerMessage(
  'STREAM_CLOSE',
  z.object({
    streamId: StreamId,
    /** `fin`: the sender will send no more data (half close). `reset`: abort both directions now. */
    mode: z.enum(['fin', 'reset']),
    reason: StreamCloseReason.optional(),
  }),
);

export const STREAM_MESSAGE_TYPES = [
  'STREAM_OPEN',
  'STREAM_ACCEPT',
  'STREAM_WINDOW',
  'STREAM_CLOSE',
] as const;
export type StreamMessageType = (typeof STREAM_MESSAGE_TYPES)[number];

export function isStreamMessageType(type: string): type is StreamMessageType {
  return (STREAM_MESSAGE_TYPES as readonly string[]).includes(type);
}

/** Builds a binary data frame. Throws on an invalid id or an empty / oversized payload. */
export function encodeStreamData(streamId: number, payload: Uint8Array): Buffer {
  if (!Number.isInteger(streamId) || streamId < 1 || streamId > MAX_STREAM_ID) {
    throw new RangeError('invalid stream id');
  }
  if (payload.length === 0 || payload.length > MAX_STREAM_PAYLOAD) {
    throw new RangeError(`stream payload must be 1..${String(MAX_STREAM_PAYLOAD)} bytes`);
  }
  const frame = Buffer.allocUnsafe(STREAM_HEADER_BYTES + payload.length);
  frame.writeUInt8(STREAM_DATA_KIND, 0);
  frame.writeUInt32BE(streamId, 1);
  frame.set(payload, STREAM_HEADER_BYTES);
  return frame;
}

/** Parses a binary data frame; `null` for anything malformed (wrong kind, bad id, empty or too large). */
export function decodeStreamData(frame: Buffer): { streamId: number; payload: Buffer } | null {
  if (frame.length <= STREAM_HEADER_BYTES || frame.length > STREAM_HEADER_BYTES + MAX_STREAM_PAYLOAD) {
    return null;
  }
  if (frame.readUInt8(0) !== STREAM_DATA_KIND) return null;
  const streamId = frame.readUInt32BE(1);
  if (streamId < 1 || streamId > MAX_STREAM_ID) return null;
  return { streamId, payload: frame.subarray(STREAM_HEADER_BYTES) };
}
