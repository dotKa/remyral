import type { MasterToWorker, WorkerToMaster } from '@remyral/protocol';

/** Session facts from SESSION_ESTABLISHED. */
export interface SessionInfo {
  negotiatedVersion: string;
  expiresAt: string;
  /** Highest worker seq the master durably processed (present on the first SESSION_ESTABLISHED of a connection). */
  resumeFromSeq: number | undefined;
}

/**
 * Boundary between the daemon core and the network transport (ADR-0005). The
 * core only depends on this port. Implementations must deliver only
 * schema-validated `MasterToWorker` messages, in order.
 */
export type TransportEvent =
  /**
   * Emitted once per connection: an authenticated session is up (`enrolled`), or
   * the master accepted the pairing request and the worker awaits approval (`!enrolled`).
   */
  | { kind: 'connected'; enrolled: boolean; session?: SessionInfo }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'message'; message: MasterToWorker };

/** What the transport needs to (re)connect. Re-read before every connection attempt. */
export interface ConnectParams {
  /** Device public key (43-char base64url). */
  publicKey: string;
  /** Known after enrollment. */
  workerId: string | null;
  /** Present only when not yet enrolled (ADR-0005 §3). */
  pairingCode: string | null;
  /** Highest master seq processed (HELLO.resumeFromSeq). */
  resumeFromSeq: number;
  /** Signs a CHALLENGE nonce with the device key; the key itself never crosses this port. */
  signChallenge(nonce: string): string;
  /**
   * p5-live-fixes-2: `remyral-worker pair` — the master only confirms the enrollment and never opens a worker
   * session for this connection (a CLI call must not replace the running service's session).
   */
  pairOnly?: boolean;
}

export interface TransportStartOptions extends ConnectParams {
  /**
   * Fresh parameters for each (re)connect attempt (cursor moved, enrollment
   * completed, key rotated). Without it the snapshot above is reused.
   */
  refresh?: () => ConnectParams;
}

/**
 * Event consumer. Returning a promise lets the transport apply backpressure: it
 * stops reading from the socket while too many events are still being processed.
 */
export type TransportEventHandler = (event: TransportEvent) => void | Promise<void>;

/** STREAM_* control messages from the master (ADR-0066). */
export type StreamControlMessage = Extract<
  MasterToWorker,
  { type: 'STREAM_OPEN' | 'STREAM_WINDOW' | 'STREAM_CLOSE' }
>;

/**
 * Receiver of the multiplexed stream plane (ADR-0066, p19-ide W2). Called synchronously from the socket's frame
 * handler — outside the ordered, backpressured event queue of the daemon — so stream traffic is never stuck behind job
 * events and job events are never stuck behind stream traffic (per-stream credits bound it).
 */
export interface TransportStreamHandler {
  /** An authenticated session is up (a fresh multiplexer per connection). */
  onSessionStart(): void;
  /** The connection is gone: every stream ends. */
  onSessionEnd(): void;
  onControl(message: StreamControlMessage): void;
  /** One binary data frame; returns false when the master broke the stream protocol too often. */
  onData(frame: Buffer): boolean;
}

export interface TransportPort {
  /** Begin connecting (and reconnecting); events arrive through `onEvent`. */
  start(options: TransportStartOptions, onEvent: TransportEventHandler): Promise<void>;
  /**
   * Send one message; resolves once handed to the socket. Rejects if there is no
   * authenticated session or the bounded send queue is full (callers keep durable
   * messages in the outbox and replay them after the next SESSION_ESTABLISHED).
   */
  send(message: WorkerToMaster): Promise<void>;
  /** Close the connection and stop reconnecting. Idempotent. */
  stop(): Promise<void>;
  /** Drop the current connection and reconnect (e.g. after a key rotation). Optional. */
  reconnect?(reason: string): void;
  /** Install the stream plane receiver (ADR-0066). Transports without streams omit it. */
  setStreamHandler?(handler: TransportStreamHandler | null): void;
  /**
   * Send one binary stream data frame on the data lane (after earlier messages). Waits while the send queue is full
   * (backpressure on the stream's writer); rejects when there is no session or the queue stays full too long.
   */
  sendBinary?(frame: Buffer): Promise<void>;
}
