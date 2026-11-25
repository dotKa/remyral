import type {
  HostFacts,
  MasterToWorker,
  ProtocolVersion,
  WorkerDisconnectReport,
  WorkerToMaster,
} from '@remyral/protocol';
import type { z } from 'zod';

/** Payload of a master message of type `T`, for building messages without the envelope. */
export type MasterPayload<T extends MasterToWorker['type']> = Extract<
  z.input<typeof MasterToWorker>,
  { type: T }
>['payload'];

/** What the gateway knows about a device after it proved possession of its key (AUTH verified). */
export interface DeviceAuthRequest {
  readonly publicKey: string;
  readonly fingerprint: string;
  /** Present when the worker believes it is not enrolled (ADR-0005 §3). */
  readonly pairingCode: string | null;
  readonly facts: HostFacts;
  readonly workerVersion: string;
  readonly negotiatedVersion: ProtocolVersion;
  readonly ip: string;
  /** Highest master seq the worker processed (HELLO.resumeFromSeq). */
  readonly resumeFromSeq: number;
}

export type RefusalCode =
  | 'unauthenticated'
  | 'revoked'
  | 'enrollment_denied'
  | 'pairing_invalid'
  | 'credential_superseded'
  | 'rate_limited';

export type DeviceAuthResult =
  /** Known, approved key: open a session. */
  | { readonly kind: 'session'; readonly workerId: string; readonly resumeFromSeq: number }
  /** Pairing request recorded (or still waiting): keep the socket open for approval. */
  | {
      readonly kind: 'pending';
      readonly workerId: string;
      readonly expiresAt: Date;
    }
  | { readonly kind: 'refused'; readonly code: RefusalCode; readonly message: string };

/**
 * Who may connect (p2-pairing implements it on Postgres). Called only after the
 * signature over the server nonce verified, i.e. with proof of key possession.
 */
export interface DeviceDirectory {
  authenticate(request: DeviceAuthRequest): Promise<DeviceAuthResult>;
  /** Re-checked on in-band re-authentication: is this key still the worker's active credential? */
  isActive(workerId: string, publicKey: string): Promise<boolean>;
}

/** Refuses every device (used until a directory is wired in). */
export const denyAllDirectory: DeviceDirectory = {
  authenticate() {
    return Promise.resolve({
      kind: 'refused',
      code: 'unauthenticated',
      message: 'worker enrollment is not available',
    });
  },
  isActive() {
    return Promise.resolve(false);
  },
};

/** An authenticated worker session as seen by session handlers. */
export interface WorkerSession {
  readonly workerId: string;
  readonly connectionId: string;
  readonly publicKey: string;
  readonly ip: string;
  readonly negotiatedVersion: ProtocolVersion;
  readonly facts: HostFacts;
  readonly workerVersion: string;
  /** HELLO.resumeFromSeq: replay master messages after this seq. */
  readonly workerResumeFromSeq: number;
  /**
   * p5-live-fixes-2 / p17-chat-reconnect: the worker process behind the session (HELLO.instanceId; null / absent: an
   * older worker). The same id on a new session means the same process reconnected.
   */
  readonly instanceId?: string | null;
  /** p17-chat-reconnect: why the worker's previous connection ended, as it saw it (HELLO.lastDisconnect). */
  readonly lastDisconnect?: WorkerDisconnectReport | null;
  /** Send a master → worker message; the envelope (seq 0 unless given) is filled in. */
  send<T extends MasterToWorker['type']>(
    type: T,
    payload: MasterPayload<T>,
    options?: {
      seq?: number;
      jobId?: string;
      correlationId?: string;
      /** p16-observability: W3C trace context of the sending span (envelope `traceparent`). */
      traceparent?: string;
    },
  ): Promise<void>;
  close(code: number, reason: string): void;
  /**
   * p19-ide W2 (ADR-0066): send one binary STREAM_* data frame. Resolves once handed to the socket; waits while the
   * socket buffer is high; rejects when the socket is gone.
   */
  sendBinary(frame: Buffer): Promise<void>;
}

/** Stream-plane receiver of one authenticated session (ADR-0066). */
export interface SessionStreamSink {
  /** A STREAM_* control message from the worker (already validated and bound to the session). */
  onControl(
    message: Extract<WorkerToMaster, { type: 'STREAM_ACCEPT' | 'STREAM_WINDOW' | 'STREAM_CLOSE' }>,
  ): void;
  /** One binary data frame; false = the worker broke the stream protocol too often (drop the link). */
  onData(frame: Buffer): boolean;
  /** The session ended. */
  onEnd(): void;
}

/** Creates the stream sink of each new session (the IDE tunnel registry implements it). */
export interface StreamSinkFactory {
  attach(session: WorkerSession): SessionStreamSink;
}

/**
 * Application logic behind an authenticated session (heartbeat/capabilities,
 * replay, jobs). Messages arrive strictly in order, one at a time per session.
 */
export interface WorkerSessionHandler {
  /** Session up (after SESSION_ESTABLISHED was sent). */
  onSessionStart(session: WorkerSession): Promise<void>;
  /** Any message other than HELLO/AUTH, already validated and bound to `session.workerId`. */
  onMessage(session: WorkerSession, message: WorkerToMaster): Promise<void>;
  /** Connection ended (any reason). Never throws to the caller. */
  onSessionEnd(session: WorkerSession, reason: string): Promise<void>;
}

/** Logs and ignores everything (until p2-heartbeat-caps / p2-replay wire real handlers). */
export const noopSessionHandler: WorkerSessionHandler = {
  onSessionStart: () => Promise.resolve(),
  onMessage: () => Promise.resolve(),
  onSessionEnd: () => Promise.resolve(),
};
