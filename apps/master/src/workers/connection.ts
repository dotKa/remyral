import { randomBytes, randomUUID } from 'node:crypto';
import {
  isStreamMessageType,
  type LeaseKey,
  MasterToWorker,
  negotiateProtocolVersion,
  parseFrame,
  WorkerToMaster,
  type ProtocolVersion,
  type WorkerDisconnectReport,
} from '@remyral/protocol';
import { publicKeyFingerprint, verifyChallenge } from '@remyral/protocol/auth';
import type { FastifyBaseLogger } from 'fastify';
import WebSocket from 'ws';
import type { AuditRecorder } from '../audit/audit.js';
import { TokenBucket } from './token-bucket.js';
import type {
  DeviceDirectory,
  MasterPayload,
  RefusalCode,
  SessionStreamSink,
  StreamSinkFactory,
  WorkerSession,
  WorkerSessionHandler,
} from './types.js';

/** Close codes on the worker channel; mirrored in apps/worker/src/transport/ws.ts. */
export const CloseCode = {
  normal: 1000,
  goingAway: 1001,
  unsupportedData: 1003,
  protocolViolation: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  timeout: 4408,
  replaced: 4409,
  upgradeRequired: 4426,
  rateLimited: 4429,
  overloaded: 4503,
} as const;

export interface GatewayTiming {
  /** The worker must send HELLO within this after the upgrade. */
  helloTimeoutMs: number;
  /** A CHALLENGE nonce is valid this long (single use). */
  challengeTtlMs: number;
  /** Connection-bound session lifetime (ADR-0005 §4: ≤ 15 min). */
  sessionTtlMs: number;
  /** In-band re-authentication starts this long before the session expires. */
  reauthBeforeMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
}

export const DEFAULT_GATEWAY_TIMING: GatewayTiming = {
  helloTimeoutMs: 10_000,
  challengeTtlMs: 30_000,
  sessionTtlMs: 15 * 60_000,
  reauthBeforeMs: 60_000,
  pingIntervalMs: 30_000,
  pongTimeoutMs: 15_000,
};

export interface GatewayLimits {
  /** Sustained / burst messages per second per connection. */
  messagesPerSec: number;
  messageBurst: number;
  /** Sustained / burst inbound bytes per second per connection. */
  bytesPerSec: number;
  byteBurst: number;
  /** Inbound messages waiting for processing; at this level reading pauses. */
  maxPendingInbound: number;
  resumeBelowInbound: number;
  /** Outbound bytes buffered in the socket; above it the worker is too slow and gets disconnected. */
  maxBufferedBytes: number;
  /** Invalid frames tolerated per authenticated connection (none before authentication). */
  maxInvalidFrames: number;
  /**
   * p19-ide W2 (ADR-0066): STREAM_* control messages per second (sustained / burst), counted apart from the message
   * budget above (an IDE page load opens many short streams). Binary data frames are bounded by per-stream credit.
   */
  streamMessagesPerSec: number;
  streamMessageBurst: number;
  /** Binary frames wait while the socket buffers more than this (the JSON lane keeps its 8 MiB guard). */
  binaryHighWaterBytes: number;
}

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = {
  messagesPerSec: 200,
  messageBurst: 400,
  bytesPerSec: 2 * 1024 * 1024,
  byteBurst: 8 * 1024 * 1024,
  maxPendingInbound: 256,
  resumeBelowInbound: 64,
  maxBufferedBytes: 8 * 1024 * 1024,
  maxInvalidFrames: 10,
  streamMessagesPerSec: 1000,
  streamMessageBurst: 4000,
  binaryHighWaterBytes: 2 * 1024 * 1024,
};

export interface ConnectionHost {
  readonly directory: DeviceDirectory;
  readonly handler: WorkerSessionHandler;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly timing: GatewayTiming;
  readonly limits: GatewayLimits;
  readonly supportedVersions: readonly ProtocolVersion[];
  /** p4-leases: lease-signing public keys announced in SESSION_ESTABLISHED. */
  readonly leaseKeys?: () => readonly LeaseKey[];
  /**
   * p19-ide W2: the STREAM_* plane (ADR-0066). Without it binary frames and STREAM_* messages are protocol violations;
   * with it only sessions of workers that advertise `ide-v1` carry streams (the master opens none to others).
   */
  readonly streams?: StreamSinkFactory;
  /**
   * p7-rate-limit: may this worker open another session now (per-worker session budget)? Absent: yes.
   * A worker over its budget is refused with `rate_limited` (close 4429) before any session state changes.
   */
  readonly admitSession?: (workerId: string) => Promise<boolean>;
  /** Register an authenticated (or pending) connection; replaces an older one of the same worker. */
  attach(workerId: string, connection: WorkerConnection): void;
  detach(workerId: string, connection: WorkerConnection): void;
}

type Phase = 'hello' | 'auth' | 'pending' | 'session' | 'closed';

const REFUSAL_CLOSE: Record<RefusalCode, number> = {
  unauthenticated: CloseCode.unauthenticated,
  revoked: CloseCode.forbidden,
  enrollment_denied: CloseCode.forbidden,
  pairing_invalid: CloseCode.unauthenticated,
  // Not 4403: the worker keeps reconnecting and switches to its rotated key (p2-identity-rotation).
  credential_superseded: CloseCode.unauthenticated,
  rate_limited: CloseCode.rateLimited,
};

interface HelloInfo {
  publicKey: string;
  fingerprint: string;
  pairingCode: string | null;
  resumeFromSeq: number;
  facts: Extract<WorkerToMaster, { type: 'HELLO' }>['payload']['facts'];
  workerVersion: string;
  version: ProtocolVersion;
  /** p5-live-fixes-2: the worker process's id (null: older worker). */
  instanceId: string | null;
  /** p5-live-fixes-2: `remyral-worker pair` — confirm the enrollment, never open a session. */
  pairOnly: boolean;
  /** p17-chat-reconnect: why the worker's previous connection ended (null: not reported). */
  lastDisconnect: WorkerDisconnectReport | null;
}

/**
 * One worker WebSocket on the master (p2-transport). Owns the handshake
 * (HELLO → CHALLENGE → AUTH → SESSION_ESTABLISHED | ENROLL_PENDING), per-connection
 * rate limits, frame validation, ordered inbound processing with read
 * backpressure, liveness pings and in-band re-authentication. Until the device
 * proved possession of its key nothing but HELLO and AUTH is accepted, and any
 * deviation closes the socket.
 */
export class WorkerConnection {
  readonly id = randomUUID();
  #phase: Phase = 'hello';
  #hello: HelloInfo | null = null;
  #nonce: { value: string; timer: NodeJS.Timeout } | null = null;
  #workerId: string | null = null;
  #session: WorkerSession | null = null;
  #streams: SessionStreamSink | null = null;
  #invalidFrames = 0;
  #pendingInbound = 0;
  #chain: Promise<void> = Promise.resolve();
  #closedReason: string | null = null;
  readonly #messages: TokenBucket;
  readonly #bytes: TokenBucket;
  readonly #streamMessages: TokenBucket;
  readonly #timers = new Set<NodeJS.Timeout>();
  #helloTimer: NodeJS.Timeout | null = null;
  #pingTimer: NodeJS.Timeout | null = null;
  #pongTimer: NodeJS.Timeout | null = null;
  #reauthTimer: NodeJS.Timeout | null = null;
  #expiryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly ip: string,
    private readonly host: ConnectionHost,
    private readonly log: FastifyBaseLogger,
  ) {
    const l = host.limits;
    this.#messages = new TokenBucket(l.messagesPerSec, l.messageBurst);
    this.#bytes = new TokenBucket(l.bytesPerSec, l.byteBurst);
    this.#streamMessages = new TokenBucket(l.streamMessagesPerSec, l.streamMessageBurst);
    this.#helloTimer = this.#timer(() => {
      this.#refuse('unauthenticated', 'no HELLO received in time', CloseCode.timeout);
    }, host.timing.helloTimeoutMs);
    this.#pingTimer = setInterval(() => {
      this.#ping();
    }, host.timing.pingIntervalMs);
    ws.on('message', (data, isBinary) => {
      this.#onFrame(data, isBinary);
    });
    ws.on('pong', () => {
      if (this.#pongTimer !== null) clearTimeout(this.#pongTimer);
      this.#pongTimer = null;
    });
    ws.on('error', (error) => {
      this.log.debug({ err: error, connectionId: this.id }, 'worker socket error');
    });
    ws.on('close', (code, reason) => {
      this.#onClose(code, reason.toString('utf8'));
    });
  }

  get phase(): Phase {
    return this.#phase;
  }

  get workerId(): string | null {
    return this.#workerId;
  }

  /** p5-live-fixes-2: the worker process behind this socket (HELLO.instanceId), null when not reported. */
  get instanceId(): string | null {
    return this.#hello?.instanceId ?? null;
  }

  /** p17-chat-reconnect: why the worker's previous connection ended, as it reported in HELLO (null: not reported). */
  get lastDisconnect(): WorkerDisconnectReport | null {
    return this.#hello?.lastDisconnect ?? null;
  }

  /** The authenticated session, once established. */
  get session(): WorkerSession | null {
    return this.#phase === 'session' ? this.#session : null;
  }

  /**
   * Close with an ERROR first (best effort) — used for revocation, replacement
   * and shutdown. Resolves once the socket is closed (or terminated after 1 s).
   */
  shutdown(
    code: number,
    reason: string,
    error?: { code: RefusalCode | 'overloaded'; message: string },
  ): Promise<void> {
    if (this.#phase === 'closed' || this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    if (error !== undefined) this.#sendError(error.code, error.message, false);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 1_000);
      this.ws.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      this.#closeSocket(code, reason);
    });
  }

  /**
   * Pending enrollment was approved while this socket waits: send ENROLL_APPROVED
   * and open the session on the same connection (the key was already proven).
   */
  async approve(workerId: string, approvedAt: Date, resumeFromSeq: number): Promise<void> {
    if (this.#phase !== 'pending' || this.#hello === null) return;
    // Run inside the inbound chain so no worker message is handled before the session exists.
    const run = this.#chain.then(async () => {
      if (this.#phase !== 'pending') return;
      await this.#sendRaw('ENROLL_APPROVED', { workerId, approvedAt: approvedAt.toISOString() });
      if (this.#hello?.pairOnly === true) {
        this.#endPairOnly(workerId);
        return;
      }
      await this.#openSession(workerId, resumeFromSeq);
    });
    this.#chain = run.catch(() => undefined);
    await run;
  }

  // ----------------------------------------------------------------- inbound

  #onFrame(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.#phase === 'closed') return;
    if (isBinary) {
      // Binary frames carry STREAM_* data only, within a session with a stream plane (ADR-0066). They are bounded by
      // the credit the master grants per stream, not by the message / byte buckets below.
      const sink = this.#streams;
      if (this.#phase !== 'session' || sink === null) {
        this.#violation('binary frames are not accepted', CloseCode.unsupportedData);
        return;
      }
      const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (!sink.onData(frame)) this.#violation('stream protocol violations', CloseCode.protocolViolation);
      return;
    }
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    const streamControl = this.#phase === 'session' && this.#streams !== null && isStreamFrame(buf);
    const allowed = streamControl
      ? this.#streamMessages.take(1)
      : this.#messages.take(1) && this.#bytes.take(buf.length);
    if (!allowed) {
      this.log.warn(
        { connectionId: this.id, workerId: this.#workerId, ip: this.ip },
        'worker rate limit exceeded',
      );
      this.#sendError('rate_limited', 'message rate limit exceeded', true);
      this.#closeSocket(CloseCode.rateLimited, 'rate limited');
      return;
    }
    const parsed = parseFrame(WorkerToMaster, buf.toString('utf8'));
    if (!parsed.ok) {
      if (this.#phase !== 'session') {
        // An unauthenticated peer gets no tolerance.
        this.#refuse('unauthenticated', 'invalid message before authentication', CloseCode.protocolViolation);
        return;
      }
      this.#invalidFrames++;
      this.log.warn(
        {
          connectionId: this.id,
          workerId: this.#workerId,
          error: parsed.error,
          issues: parsed.issues?.slice(0, 5),
        },
        'invalid frame from worker',
      );
      this.#sendError('invalid_message', `invalid frame: ${parsed.error}`, false);
      if (this.#invalidFrames > this.host.limits.maxInvalidFrames) {
        this.#violation('too many invalid frames', CloseCode.protocolViolation);
      }
      return;
    }
    const message = parsed.message;
    if (isStreamMessageType(message.type)) {
      // Stream control is handled at once, in frame order with the binary data frames, outside the ordered
      // (database-backed) message chain.
      const sink = this.#streams;
      const session = this.#session;
      if (this.#phase !== 'session' || sink === null || session === null) {
        this.#violation(`${message.type} without a stream plane`, CloseCode.protocolViolation);
        return;
      }
      if (message.workerId !== session.workerId) {
        this.#violation('workerId does not match the authenticated session', CloseCode.protocolViolation);
        return;
      }
      sink.onControl(message as Parameters<SessionStreamSink['onControl']>[0]);
      return;
    }
    this.#pendingInbound++;
    if (this.#pendingInbound >= this.host.limits.maxPendingInbound && !this.ws.isPaused) {
      // Processing lags: stop reading; TCP flow control pushes back on the worker.
      this.ws.pause();
    }
    this.#chain = this.#chain
      .then(() => this.#handle(message))
      .catch((error: unknown) => {
        this.log.error(
          { err: error, connectionId: this.id, type: message.type },
          'worker message handling failed',
        );
        this.#sendError('internal', 'internal error', true);
        this.#closeSocket(CloseCode.overloaded, 'internal error');
      })
      .finally(() => {
        this.#pendingInbound--;
        if (this.ws.isPaused && this.#pendingInbound <= this.host.limits.resumeBelowInbound) this.ws.resume();
      });
  }

  async #handle(message: WorkerToMaster): Promise<void> {
    if (this.#phase === 'closed') return;
    switch (this.#phase) {
      case 'hello':
        if (message.type !== 'HELLO') {
          this.#refuse('unauthenticated', `${message.type} before HELLO`, CloseCode.unauthenticated);
          return;
        }
        this.#onHello(message);
        return;
      case 'auth':
        if (message.type !== 'AUTH') {
          this.#refuse('unauthenticated', `${message.type} before AUTH`, CloseCode.unauthenticated);
          return;
        }
        await this.#onAuth(message);
        return;
      case 'pending':
        // Nothing is accepted until an admin approves.
        this.#refuse(
          'unauthenticated',
          `${message.type} while enrollment is pending`,
          CloseCode.protocolViolation,
        );
        return;
      case 'session':
        await this.#onSessionMessage(message);
        return;
    }
  }

  #onHello(message: Extract<WorkerToMaster, { type: 'HELLO' }>): void {
    if (this.#helloTimer !== null) clearTimeout(this.#helloTimer);
    const p = message.payload;
    const version = negotiateProtocolVersion(p.supportedVersions, this.host.supportedVersions);
    if (version === undefined) {
      this.log.info({ ip: this.ip, offered: p.supportedVersions }, 'worker protocol version not supported');
      this.#sendError(
        'upgrade_required',
        `master speaks ${this.host.supportedVersions.join(', ')}; update the worker`,
        false,
      );
      this.#closeSocket(CloseCode.upgradeRequired, 'upgrade required');
      return;
    }
    let fingerprint: string;
    try {
      fingerprint = publicKeyFingerprint(p.publicKey);
    } catch {
      this.#refuse('unauthenticated', 'malformed public key', CloseCode.unauthenticated);
      return;
    }
    this.#hello = {
      publicKey: p.publicKey,
      fingerprint,
      pairingCode: p.pairingCode ?? null,
      resumeFromSeq: p.resumeFromSeq ?? 0,
      facts: p.facts,
      workerVersion: p.workerVersion,
      version,
      instanceId: p.instanceId ?? null,
      pairOnly: p.pairOnly === true,
      lastDisconnect: p.lastDisconnect ?? null,
    };
    this.#phase = 'auth';
    this.#challenge();
  }

  /** Issue a fresh single-use nonce (handshake and in-band re-authentication). */
  #challenge(): void {
    if (this.#nonce !== null) clearTimeout(this.#nonce.timer);
    const value = randomBytes(32).toString('base64url');
    const ttl = this.host.timing.challengeTtlMs;
    const timer = this.#timer(() => {
      this.#refuse('unauthenticated', 'challenge expired', CloseCode.timeout);
    }, ttl);
    this.#nonce = { value, timer };
    void this.#sendRaw('CHALLENGE', {
      nonce: value,
      expiresAt: new Date(this.host.clock().getTime() + ttl).toISOString(),
    }).catch(() => undefined);
  }

  /** Consumes the outstanding nonce (single use) and verifies the signature over it. */
  #verifyAuth(message: Extract<WorkerToMaster, { type: 'AUTH' }>): boolean {
    const nonce = this.#nonce;
    this.#nonce = null;
    if (nonce === null || this.#hello === null) return false;
    clearTimeout(nonce.timer);
    return (
      message.payload.nonce === nonce.value &&
      verifyChallenge(this.#hello.publicKey, message.payload.nonce, message.payload.signature)
    );
  }

  async #onAuth(message: Extract<WorkerToMaster, { type: 'AUTH' }>): Promise<void> {
    const hello = this.#hello;
    if (hello === null) return;
    if (!this.#verifyAuth(message)) {
      await this.host.audit.record({
        actor: { type: 'anonymous' },
        action: 'worker.auth',
        outcome: 'denied',
        target: hello.fingerprint,
        ip: this.ip,
        metadata: { reason: 'bad_signature_or_nonce' },
      });
      this.#refuse('unauthenticated', 'challenge signature invalid', CloseCode.unauthenticated);
      return;
    }
    const result = await this.host.directory.authenticate({
      publicKey: hello.publicKey,
      fingerprint: hello.fingerprint,
      pairingCode: hello.pairingCode,
      facts: hello.facts,
      workerVersion: hello.workerVersion,
      negotiatedVersion: hello.version,
      ip: this.ip,
      resumeFromSeq: hello.resumeFromSeq,
    });
    if (this.#phase === 'closed') return;
    switch (result.kind) {
      case 'refused':
        this.log.info({ ip: this.ip, code: result.code, fingerprint: hello.fingerprint }, 'worker refused');
        this.#refuse(result.code, result.message, REFUSAL_CLOSE[result.code]);
        return;
      case 'pending':
        this.#workerId = result.workerId;
        this.#phase = 'pending';
        this.host.attach(result.workerId, this);
        await this.#sendRaw('ENROLL_PENDING', {
          fingerprint: hello.fingerprint,
          expiresAt: result.expiresAt.toISOString(),
        });
        // A pending socket lives at most until the pairing request expires.
        this.#expiryTimer = this.#timer(
          () => {
            this.#refuse('pairing_invalid', 'pairing request expired', CloseCode.timeout);
          },
          Math.max(0, result.expiresAt.getTime() - this.host.clock().getTime()),
        );
        return;
      case 'session':
        if (hello.pairOnly) {
          // p5-live-fixes-2: `remyral-worker pair` of an enrolled key — confirm it, but never open a session
          // (that would replace the running service's connection).
          this.#workerId = result.workerId; // ENROLL_APPROVED is a worker-addressed message
          await this.#sendRaw('ENROLL_APPROVED', {
            workerId: result.workerId,
            approvedAt: this.host.clock().toISOString(),
          });
          this.#endPairOnly(result.workerId);
          return;
        }
        if (this.host.admitSession !== undefined && !(await this.host.admitSession(result.workerId))) {
          // The socket may have closed while the limiter was asked (TS keeps the earlier narrowing).
          if ((this.#phase as Phase) === 'closed') return;
          this.log.warn({ ip: this.ip, workerId: result.workerId }, 'worker session refused: rate limited');
          await this.host.audit.record({
            actor: { type: 'worker', id: result.workerId },
            action: 'worker.auth',
            outcome: 'denied',
            target: result.workerId,
            ip: this.ip,
            metadata: { reason: 'session_rate_limited' },
          });
          this.#refuse('rate_limited', 'too many sessions', CloseCode.rateLimited);
          return;
        }
        if ((this.#phase as Phase) === 'closed') return;
        if (hello.pairingCode !== null) {
          // The worker still thinks it is unenrolled (approval happened while it was away).
          // p5-live-fixes-2: the envelope needs the workerId (it failed with `internal` before).
          this.#workerId = result.workerId;
          await this.#sendRaw('ENROLL_APPROVED', {
            workerId: result.workerId,
            approvedAt: this.host.clock().toISOString(),
          });
        }
        await this.#openSession(result.workerId, result.resumeFromSeq);
        return;
    }
  }

  /** A pair-only connection ends right after ENROLL_APPROVED; the service opens the session itself. */
  #endPairOnly(workerId: string): void {
    this.log.info(
      { workerId, connectionId: this.id, ip: this.ip },
      'pair-only connection confirmed; closing',
    );
    if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer);
    this.#closeSocket(CloseCode.normal, 'enrollment confirmed (pair only)');
  }

  async #openSession(workerId: string, resumeFromSeq: number): Promise<void> {
    const hello = this.#hello;
    if (hello === null || this.#phase === 'closed') return;
    if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer);
    this.#workerId = workerId;
    this.#phase = 'session';
    this.host.attach(workerId, this);
    await this.#sendSessionEstablished(resumeFromSeq);
    const session: WorkerSession = {
      workerId,
      connectionId: this.id,
      publicKey: hello.publicKey,
      ip: this.ip,
      negotiatedVersion: hello.version,
      facts: hello.facts,
      workerVersion: hello.workerVersion,
      workerResumeFromSeq: hello.resumeFromSeq,
      instanceId: hello.instanceId,
      lastDisconnect: hello.lastDisconnect,
      send: (type, payload, options) => this.#sendRaw(type, payload, options),
      close: (code, reason) => {
        this.#closeSocket(code, reason);
      },
      sendBinary: (frame) => this.#sendBinary(frame),
    };
    this.#session = session;
    this.#streams = this.host.streams?.attach(session) ?? null;
    await this.host.audit.record({
      actor: { type: 'worker', id: workerId },
      action: 'worker.session.start',
      outcome: 'success',
      target: workerId,
      ip: this.ip,
      metadata: { connectionId: this.id, protocolVersion: hello.version, workerVersion: hello.workerVersion },
    });
    this.log.info(
      {
        workerId,
        connectionId: this.id,
        ip: this.ip,
        // p17-chat-reconnect: the worker's own account of why its previous connection ended.
        ...(hello.lastDisconnect === null ? {} : { lastDisconnect: hello.lastDisconnect }),
      },
      'worker session established',
    );
    await this.host.handler.onSessionStart(session);
  }

  async #sendSessionEstablished(resumeFromSeq: number | undefined): Promise<void> {
    const t = this.host.timing;
    const expiresAt = new Date(this.host.clock().getTime() + t.sessionTtlMs);
    await this.#sendRaw('SESSION_ESTABLISHED', {
      negotiatedVersion: this.#hello?.version ?? '1.0',
      sessionExpiresAt: expiresAt.toISOString(),
      ...(resumeFromSeq === undefined ? {} : { resumeFromSeq }),
      ...(this.host.leaseKeys === undefined ? {} : { leaseKeys: [...this.host.leaseKeys()] }),
    });
    if (this.#reauthTimer !== null) clearTimeout(this.#reauthTimer);
    if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer);
    this.#reauthTimer = this.#timer(
      () => {
        this.#challenge();
      },
      Math.max(0, t.sessionTtlMs - t.reauthBeforeMs),
    );
    this.#expiryTimer = this.#timer(() => {
      this.#refuse(
        'unauthenticated',
        'session expired without re-authentication',
        CloseCode.unauthenticated,
        'session_expired',
      );
    }, t.sessionTtlMs);
  }

  async #onSessionMessage(message: WorkerToMaster): Promise<void> {
    const session = this.#session;
    if (session === null) return;
    if (message.type === 'HELLO') {
      this.#violation('HELLO on an established session', CloseCode.protocolViolation);
      return;
    }
    if (message.type === 'AUTH') {
      // Answer to an in-band re-authentication challenge.
      const ok =
        this.#verifyAuth(message) &&
        (await this.host.directory.isActive(session.workerId, session.publicKey));
      if (!ok) {
        this.#refuse('unauthenticated', 're-authentication failed', CloseCode.unauthenticated);
        return;
      }
      await this.#sendSessionEstablished(undefined);
      return;
    }
    if (message.workerId !== session.workerId) {
      this.#violation('workerId does not match the authenticated session', CloseCode.protocolViolation);
      return;
    }
    await this.host.handler.onMessage(session, message);
  }

  // ---------------------------------------------------------------- outbound

  #sendRaw<T extends MasterToWorker['type']>(
    type: T,
    payload: MasterPayload<T>,
    options: { seq?: number; jobId?: string; correlationId?: string; traceparent?: string } = {},
  ): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('worker socket not open'));
    const message = MasterToWorker.parse({
      protocolVersion: this.#hello?.version ?? '1.0',
      type,
      messageId: randomUUID(),
      seq: options.seq ?? 0,
      ts: this.host.clock().toISOString(),
      correlationId: options.correlationId ?? `conn-${this.id}`,
      ...(this.#workerId === null ? {} : { workerId: this.#workerId }),
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }),
      payload,
    });
    if (this.ws.bufferedAmount > this.host.limits.maxBufferedBytes) {
      // The worker does not read: drop it; durable messages are replayed on reconnect.
      this.log.warn(
        { workerId: this.#workerId, buffered: this.ws.bufferedAmount },
        'worker too slow; disconnecting',
      );
      this.#closeSocket(CloseCode.overloaded, 'send buffer full');
      return Promise.reject(new Error('worker send buffer full'));
    }
    return new Promise((resolve, reject) => {
      this.ws.send(JSON.stringify(message), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  /**
   * One binary STREAM_* data frame (ADR-0066). Waits while the socket buffers more than `binaryHighWaterBytes` (the
   * stream's writer stalls; per-stream credit bounds the rest), so stream traffic never pushes the JSON lane over its
   * own guard. Gives up after 30 s (the stream is reset; the connection stays).
   */
  async #sendBinary(frame: Buffer): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (
      this.ws.readyState === WebSocket.OPEN &&
      this.ws.bufferedAmount > this.host.limits.binaryHighWaterBytes
    ) {
      if (Date.now() > deadline) throw new Error('worker send buffer stays full');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('worker socket not open');
    await new Promise<void>((resolve, reject) => {
      this.ws.send(frame, { binary: true }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  #sendError(
    code:
      | RefusalCode
      | 'invalid_message'
      | 'rate_limited'
      | 'internal'
      | 'upgrade_required'
      | 'session_expired'
      | 'overloaded',
    message: string,
    retryable: boolean,
  ): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    void this.#sendRaw('ERROR', { code, message, retryable }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- lifecycle

  #refuse(
    code: RefusalCode,
    reason: string,
    closeCode: number,
    errorCode: RefusalCode | 'session_expired' = code,
  ): void {
    this.#sendError(errorCode, reason, code === 'rate_limited');
    this.#closeSocket(closeCode, reason);
  }

  #violation(reason: string, closeCode: number): void {
    this.log.warn({ connectionId: this.id, workerId: this.#workerId, reason }, 'worker protocol violation');
    this.#sendError('invalid_message', reason, false);
    this.#closeSocket(closeCode, reason);
  }

  #closeSocket(code: number, reason: string): void {
    this.#closedReason ??= reason;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(code, reason.slice(0, 120));
      // A peer that does not complete the closing handshake is cut off.
      setTimeout(() => {
        if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
      }, 1_000).unref();
    } else if (this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    }
  }

  #ping(): void {
    if (this.ws.readyState !== WebSocket.OPEN || this.#pongTimer !== null) return;
    this.#pongTimer = setTimeout(() => {
      this.log.info(
        { workerId: this.#workerId, connectionId: this.id },
        'worker did not answer ping; terminating',
      );
      this.#closedReason ??= 'ping timeout';
      this.ws.terminate();
    }, this.host.timing.pongTimeoutMs);
    this.ws.ping();
  }

  #onClose(code: number, reason: string): void {
    const wasSession = this.#phase === 'session';
    this.#phase = 'closed';
    this.#streams?.onEnd();
    this.#streams = null;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    if (this.#pingTimer !== null) clearInterval(this.#pingTimer);
    if (this.#pongTimer !== null) clearTimeout(this.#pongTimer);
    if (this.#nonce !== null) clearTimeout(this.#nonce.timer);
    const why = this.#closedReason ?? (reason === '' ? `closed (${String(code)})` : reason);
    if (this.#workerId !== null) this.host.detach(this.#workerId, this);
    const session = this.#session;
    if (wasSession && session !== null) {
      // Let in-flight messages finish first so the end is ordered after them.
      this.#chain = this.#chain
        .then(async () => {
          await this.host.handler.onSessionEnd(session, why);
          await this.host.audit.record({
            actor: { type: 'worker', id: session.workerId },
            action: 'worker.session.end',
            outcome: 'success',
            target: session.workerId,
            ip: this.ip,
            metadata: { connectionId: this.id, code, reason: why.slice(0, 200) },
          });
        })
        .catch((error: unknown) => {
          this.log.error({ err: error, workerId: session.workerId }, 'worker session end handling failed');
        });
    }
    this.log.info(
      { workerId: this.#workerId, connectionId: this.id, code, reason: why },
      'worker connection closed',
    );
  }

  #timer(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    this.#timers.add(t);
    return t;
  }

  /** Resolves when all queued inbound messages and the session end are processed (tests, shutdown). */
  async settled(): Promise<void> {
    let last: Promise<void> | null = null;
    while (last !== this.#chain) {
      last = this.#chain;
      await last;
    }
  }
}

/** A text frame that is a STREAM_* control message (cheap check before the full parse, for the stream budget). */
function isStreamFrame(buf: Buffer): boolean {
  if (buf.length > 4096) return false;
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
  return /"type"\s*:\s*"STREAM_(?:ACCEPT|WINDOW|CLOSE)"/.test(head);
}
