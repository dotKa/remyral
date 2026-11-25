import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  isStreamMessageType,
  MasterToWorker,
  MAX_FRAME_BYTES,
  parseFrame,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  WorkerId,
  WorkerToMaster,
  type HostFacts,
  type ProtocolVersion,
  type WorkerDisconnectReport,
} from '@remyral/protocol';
import type { Logger } from '@remyral/observability';
import WebSocket from 'ws';
import type {
  ConnectParams,
  StreamControlMessage,
  TransportEvent,
  TransportEventHandler,
  TransportPort,
  TransportStartOptions,
  TransportStreamHandler,
} from './port.js';

/**
 * Close codes used on the worker channel (application range 4000–4999). The
 * master sends them; the worker uses 4400 / 4408 itself when the master breaks
 * the protocol. Shared semantics are documented in docs/design/p2-transport.md.
 */
export const CloseCode = {
  normal: 1000,
  goingAway: 1001,
  unsupportedData: 1003,
  policyViolation: 1008,
  tooBig: 1009,
  protocolViolation: 4400,
  unauthenticated: 4401,
  /** Revoked, denied, or superseded credential: reconnecting cannot help. */
  forbidden: 4403,
  timeout: 4408,
  /** A newer connection of the same worker replaced this one. */
  replaced: 4409,
  upgradeRequired: 4426,
  rateLimited: 4429,
  overloaded: 4503,
} as const;

export interface TransportTiming {
  /** TCP + TLS + HTTP upgrade must finish within this. */
  handshakeTimeoutMs: number;
  /** After HELLO, the master must answer (CHALLENGE / ERROR) within this. */
  helloTimeoutMs: number;
  /** WebSocket ping interval (liveness of the master and of NAT mappings). */
  pingIntervalMs: number;
  /** A ping without pong within this terminates the connection. */
  pongTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** A connection that stayed up this long resets the backoff. */
  stableAfterMs: number;
}

export const DEFAULT_TIMING: TransportTiming = {
  handshakeTimeoutMs: 10_000,
  helloTimeoutMs: 15_000,
  pingIntervalMs: 20_000,
  pongTimeoutMs: 10_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  stableAfterMs: 30_000,
};

export interface TransportLimits {
  /** Messages waiting in the send queue (all lanes). */
  maxQueuedMessages: number;
  /** Serialized bytes waiting in the send queue. */
  maxQueuedBytes: number;
  /** Bytes handed to the socket but not yet written; above it the queue waits. */
  socketHighWaterBytes: number;
  /** Delivered events still being processed by the consumer; at this level reading pauses. */
  maxUnprocessedEvents: number;
  /** Reading resumes once the consumer is down to this many. */
  resumeBelowEvents: number;
  /** Invalid frames from the master tolerated per connection before closing it. */
  maxInvalidFrames: number;
  /**
   * p22-byte-pace: the send budget of text frames (sustained / burst, messages and bytes per second), kept below the
   * master's per-connection buckets (GatewayLimits: 200 / 400 messages, 2 / 8 MiB) so a large upload is paced instead
   * of the connection being closed `rate_limited` (4429). Binary stream frames and STREAM_* control messages have
   * their own budgets on the master and are not counted here.
   */
  messagesPerSec: number;
  messageBurst: number;
  bytesPerSec: number;
  byteBurst: number;
}

export const DEFAULT_LIMITS: TransportLimits = {
  maxQueuedMessages: 1024,
  maxQueuedBytes: 8 * 1024 * 1024,
  socketHighWaterBytes: 1024 * 1024,
  maxUnprocessedEvents: 64,
  resumeBelowEvents: 16,
  maxInvalidFrames: 10,
  messagesPerSec: 150,
  messageBurst: 300,
  bytesPerSec: 1.5 * 1024 * 1024,
  byteBurst: 6 * 1024 * 1024,
};

/**
 * p22-byte-pace: a token bucket like the master's (full on a new connection, refilled continuously). An item larger
 * than the whole burst may go once the bucket is full, so nothing waits forever.
 */
export class SendBudget {
  #tokens: number;
  #at: number;
  constructor(
    readonly rate: number,
    readonly burst: number,
    now: number,
  ) {
    this.#tokens = burst;
    this.#at = now;
  }
  reset(now: number): void {
    this.#tokens = this.burst;
    this.#at = now;
  }
  #refill(now: number): void {
    if (now > this.#at)
      this.#tokens = Math.min(this.burst, this.#tokens + ((now - this.#at) / 1000) * this.rate);
    this.#at = Math.max(this.#at, now);
  }
  /** Milliseconds until `n` can be taken (0: now). */
  waitMs(n: number, now: number): number {
    this.#refill(now);
    const need = Math.min(n, this.burst);
    if (this.#tokens >= need) return 0;
    return Math.max(1, Math.ceil(((need - this.#tokens) / this.rate) * 1000));
  }
  take(n: number, now: number): void {
    this.#refill(now);
    this.#tokens -= n;
  }
}

export class NotConnectedError extends Error {
  constructor(reason = 'no authenticated session') {
    super(`not connected: ${reason}`);
    this.name = 'NotConnectedError';
  }
}

export class SendQueueFullError extends Error {
  constructor() {
    super('send queue full (backpressure)');
    this.name = 'SendQueueFullError';
  }
}

export class FrameTooLargeError extends Error {
  constructor(bytes: number) {
    super(`outgoing frame of ${String(bytes)} bytes exceeds ${String(MAX_FRAME_BYTES)}`);
    this.name = 'FrameTooLargeError';
  }
}

export class InvalidMasterUrlError extends Error {
  constructor(reason: string) {
    super(`invalid master URL: ${reason}`);
    this.name = 'InvalidMasterUrlError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** `wss://` anywhere; `ws://` only to loopback (dev). Path defaults to `/v1/worker`. */
export function workerEndpoint(masterUrl: string): URL {
  let url: URL;
  try {
    url = new URL(masterUrl);
  } catch {
    throw new InvalidMasterUrlError('not a URL');
  }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new InvalidMasterUrlError('scheme must be wss:// (ws:// only for loopback)');
  }
  if (url.protocol === 'ws:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new InvalidMasterUrlError('ws:// is only allowed for 127.0.0.1, localhost or [::1]');
  }
  if (url.username !== '' || url.password !== '') throw new InvalidMasterUrlError('credentials in URL');
  if (url.search !== '' || url.hash !== '') throw new InvalidMasterUrlError('query or fragment in URL');
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/v1/worker';
  return url;
}

/** Exponential backoff with "equal jitter": half fixed, half random, capped. */
export function backoffDelay(
  attempt: number,
  timing: Pick<TransportTiming, 'backoffBaseMs' | 'backoffMaxMs'>,
  random: () => number = Math.random,
): number {
  const exp = Math.min(timing.backoffMaxMs, timing.backoffBaseMs * 2 ** Math.min(attempt, 30));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Control messages jump the data lane so a burst of events never starves liveness/acks. */
const CONTROL_TYPES = new Set(['AUTH', 'HELLO', 'ACK', 'HEARTBEAT', 'CAPABILITIES']);

interface Queued {
  /** A JSON envelope (text frame) or a stream data frame (binary, ADR-0066). */
  data: string | Buffer;
  bytes: number;
  /** p22-byte-pace: counted against the send budget (text frames other than STREAM_* control). */
  budgeted: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

type Phase = 'connecting' | 'hello' | 'auth' | 'pending' | 'session';

interface Connection {
  readonly id: number;
  readonly ws: WebSocket;
  phase: Phase;
  announced: boolean;
  openedAt: number;
  invalidFrames: number;
  unprocessed: number;
  lastNonce: string | null;
  helloTimer: NodeJS.Timeout | null;
  pingTimer: NodeJS.Timeout | null;
  pongTimer: NodeJS.Timeout | null;
  /** p17-chat-reconnect: when the outstanding ping was sent (clock ms). */
  pingSentAt: number;
  closeReason: string | null;
  /** p17-chat-reconnect: the first structured cause of the end (reported in the next HELLO). */
  cause: Omit<WorkerDisconnectReport, 'at' | 'connectedMs'> | null;
}

/**
 * p17-chat-reconnect: the worst event-loop delay (ms) over roughly the last minute — two 30 s windows of
 * `perf_hooks.monitorEventLoopDelay`. A pong timeout with a large delay means the worker itself stalled.
 */
export interface LoopDelayProbe {
  start(): void;
  stop(): void;
  maxMs(): number | null;
}

export function eventLoopDelayProbe(windowMs = 30_000): LoopDelayProbe {
  let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  let previousMax = 0;
  let timer: NodeJS.Timeout | null = null;
  return {
    start() {
      if (histogram !== null) return;
      const h = monitorEventLoopDelay({ resolution: 20 });
      h.enable();
      histogram = h;
      timer = setInterval(() => {
        previousMax = h.max;
        h.reset();
      }, windowMs);
      timer.unref();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      histogram?.disable();
      histogram = null;
    },
    maxMs() {
      if (histogram === null) return null;
      // The histogram reports nanoseconds and includes the sampling resolution itself.
      const ns = Math.max(previousMax, histogram.count > 0 ? histogram.max : 0);
      return Math.max(0, Math.round(ns / 1e6));
    },
  };
}

export interface WsTransportOptions {
  /** Master base URL from the config (`wss://host` → `wss://host/v1/worker`). */
  masterUrl: string;
  logger: Logger;
  workerVersion: string;
  /** Host facts for HELLO, evaluated on every connect. */
  facts: () => HostFacts | Promise<HostFacts>;
  supportedVersions?: readonly ProtocolVersion[];
  timing?: Partial<TransportTiming>;
  limits?: Partial<TransportLimits>;
  random?: () => number;
  /**
   * Extra trust anchors (PEM) for a private CA. Certificate verification itself
   * can never be disabled.
   */
  ca?: string | Buffer;
  clock?: () => number;
  /**
   * p5-live-fixes-2: id of this worker process in HELLO (default: random per transport, kept across
   * reconnects), so the master can tell a reconnect from a second process using the same device key.
   */
  instanceId?: string;
  /** p17-chat-reconnect: event-loop delay source for pong-timeout reports (default: perf_hooks; tests inject one). */
  loopDelay?: LoopDelayProbe;
}

/**
 * Outbound-only WebSocket transport to the master (ADR-0005, p2-transport).
 *
 * - `wss://` with certificate verification and TLS ≥ 1.3; `ws://` only to loopback.
 * - Handshake: HELLO → CHALLENGE → AUTH(signature) → SESSION_ESTABLISHED |
 *   ENROLL_PENDING; protocol version negotiated by the master (ADR-0011).
 * - Every incoming frame is size-limited (`maxPayload`) and validated with
 *   `parseFrame(MasterToWorker)`; binary frames are only accepted as STREAM_*
 *   data frames during a session with a stream handler installed (ADR-0066).
 * - Backpressure: bounded two-lane send queue that only writes while the socket
 *   buffer is below a high-water mark; reading pauses while the consumer lags.
 * - Liveness: WebSocket ping/pong; reconnect with exponential backoff + jitter.
 */
export class WsTransport implements TransportPort {
  readonly #opts: WsTransportOptions;
  readonly #timing: TransportTiming;
  readonly #limits: TransportLimits;
  readonly #url: URL;
  readonly #log: Logger;
  readonly #random: () => number;
  readonly #clock: () => number;
  readonly #instanceId: string;
  readonly #loopDelay: LoopDelayProbe;
  /** p17-chat-reconnect: why the last session's connection ended; sent in HELLO until a session is up again. */
  #lastDisconnect: WorkerDisconnectReport | null = null;
  #start: TransportStartOptions | null = null;
  #onEvent: TransportEventHandler | null = null;
  #streams: TransportStreamHandler | null = null;
  /** sendBinary callers waiting for queue space (backpressure of the stream plane). */
  readonly #spaceWaiters: (() => void)[] = [];
  #conn: Connection | null = null;
  #nextConnId = 1;
  #stopped = false;
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #nextDelayOverride: number | null = null;
  readonly #control: Queued[] = [];
  readonly #data: Queued[] = [];
  #queuedBytes = 0;
  #inflightBytes = 0;
  /** p22-byte-pace: the text-frame send budget of the current connection, and the timer that resumes the pump. */
  #msgBudget: SendBudget;
  #byteBudget: SendBudget;
  #budgetTimer: NodeJS.Timeout | null = null;
  /** Handed to the socket, callback not yet seen: settled on close so no sender waits forever. */
  readonly #inflight = new Set<Queued>();
  /** Counters for operational metrics (docs/design/p2-transport.md). */
  readonly stats = {
    connects: 0,
    sessions: 0,
    disconnects: 0,
    invalidFrames: 0,
    pausedReads: 0,
    queueFull: 0,
  };

  constructor(options: WsTransportOptions) {
    this.#opts = options;
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#url = workerEndpoint(options.masterUrl);
    this.#log = options.logger.child({ component: 'transport' });
    this.#random = options.random ?? Math.random;
    this.#clock = options.clock ?? Date.now;
    this.#instanceId = options.instanceId ?? randomUUID();
    this.#loopDelay = options.loopDelay ?? eventLoopDelayProbe();
    this.#msgBudget = new SendBudget(this.#limits.messagesPerSec, this.#limits.messageBurst, this.#clock());
    this.#byteBudget = new SendBudget(this.#limits.bytesPerSec, this.#limits.byteBurst, this.#clock());
  }

  /** p17-chat-reconnect: why the previous session's connection ended (null: none, or already reported). */
  get lastDisconnect(): WorkerDisconnectReport | null {
    return this.#lastDisconnect;
  }

  /** This process's id in HELLO (p5-live-fixes-2). */
  get instanceId(): string {
    return this.#instanceId;
  }

  get url(): string {
    return this.#url.toString();
  }

  /** True while an authenticated session is up. */
  get established(): boolean {
    return this.#conn?.phase === 'session';
  }

  start(options: TransportStartOptions, onEvent: TransportEventHandler): Promise<void> {
    if (this.#start !== null) return Promise.reject(new Error('transport already started'));
    this.#start = options;
    this.#onEvent = onEvent;
    this.#loopDelay.start();
    this.#connect();
    return Promise.resolve();
  }

  send(message: WorkerToMaster): Promise<void> {
    const conn = this.#conn;
    if (this.#stopped || conn?.phase !== 'session') return Promise.reject(new NotConnectedError());
    return this.#enqueue(message);
  }

  setStreamHandler(handler: TransportStreamHandler | null): void {
    this.#streams = handler;
  }

  /**
   * One binary stream data frame, on the data lane (ordered after earlier STREAM_* control messages). While the send
   * queue is full the caller waits (its stream stalls; credits bound how much any stream can queue), up to 30 s.
   */
  async sendBinary(frame: Buffer): Promise<void> {
    if (frame.length > MAX_FRAME_BYTES) throw new FrameTooLargeError(frame.length);
    const deadline = this.#clock() + 30_000;
    for (;;) {
      const conn = this.#conn;
      if (this.#stopped || conn?.phase !== 'session') throw new NotConnectedError();
      const full =
        this.#control.length + this.#data.length >= this.#limits.maxQueuedMessages ||
        this.#queuedBytes + frame.length > this.#limits.maxQueuedBytes;
      if (!full) break;
      if (this.#clock() >= deadline) {
        this.stats.queueFull++;
        throw new SendQueueFullError();
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        timer.unref();
        this.#spaceWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return new Promise((resolve, reject) => {
      this.#data.push({ data: frame, bytes: frame.length, budgeted: false, resolve, reject });
      this.#queuedBytes += frame.length;
      this.#pump();
    });
  }

  stop(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#stopped = true;
    this.#loopDelay.stop();
    if (this.#budgetTimer !== null) clearTimeout(this.#budgetTimer);
    this.#budgetTimer = null;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const conn = this.#conn;
    if (conn === null) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        conn.ws.terminate();
        resolve();
      }, 2_000);
      conn.ws.once('close', done);
      this.#close(conn, CloseCode.goingAway, 'worker stopping');
    });
  }

  reconnect(reason: string): void {
    const conn = this.#conn;
    if (conn === null || this.#stopped) return;
    this.#nextDelayOverride = 0;
    this.#close(conn, CloseCode.normal, reason);
  }

  // ---------------------------------------------------------------- connection

  #params(): ConnectParams {
    const s = this.#start;
    if (s === null) throw new Error('transport not started');
    return s.refresh?.() ?? s;
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#reconnectTimer = null;
    const ws = new WebSocket(this.#url, {
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: this.#timing.handshakeTimeoutMs,
      // Compression off: avoids decompression bombs and CRIME-style length leaks.
      perMessageDeflate: false,
      followRedirects: false,
      // Never configurable: certificate verification on, TLS 1.3 only (ADR-0005 §1).
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      ...(this.#opts.ca === undefined ? {} : { ca: this.#opts.ca }),
      headers: { 'user-agent': `remyral-worker/${this.#opts.workerVersion}` },
    });
    const conn: Connection = {
      id: this.#nextConnId++,
      ws,
      phase: 'connecting',
      announced: false,
      openedAt: 0,
      invalidFrames: 0,
      unprocessed: 0,
      lastNonce: null,
      helloTimer: null,
      pingTimer: null,
      pongTimer: null,
      pingSentAt: 0,
      closeReason: null,
      cause: null,
    };
    this.#conn = conn;
    // p22-byte-pace: the master counts each connection from a full bucket.
    this.#msgBudget.reset(this.#clock());
    this.#byteBudget.reset(this.#clock());
    this.stats.connects++;
    this.#log.debug('connecting to master', { url: this.url, attempt: this.#attempt });

    ws.on('open', () => {
      void this.#onOpen(conn);
    });
    ws.on('message', (data, isBinary) => {
      this.#onFrame(conn, data, isBinary);
    });
    ws.on('pong', () => {
      if (conn.pongTimer !== null) clearTimeout(conn.pongTimer);
      conn.pongTimer = null;
    });
    ws.on('unexpected-response', (_req, res) => {
      conn.closeReason = `master refused the upgrade with HTTP ${String(res.statusCode)}`;
      conn.cause ??= { cause: 'upgrade_refused', code: res.statusCode ?? 0 };
      if (res.statusCode === 429) this.#nextDelayOverride = this.#timing.backoffMaxMs;
      res.resume();
      ws.terminate();
    });
    ws.on('error', (error) => {
      conn.closeReason ??= error.message;
      conn.cause ??= { cause: 'socket_error', detail: error.message.slice(0, 300) };
    });
    ws.on('close', (code, reason) => {
      this.#onClose(conn, code, reason.toString('utf8'));
    });
  }

  async #onOpen(conn: Connection): Promise<void> {
    conn.openedAt = this.#clock();
    conn.phase = 'hello';
    this.#startPing(conn);
    conn.helloTimer = setTimeout(() => {
      this.#log.warn('master did not complete the handshake in time', { phase: conn.phase });
      this.#close(conn, CloseCode.timeout, 'handshake timeout');
    }, this.#timing.helloTimeoutMs);
    let facts: HostFacts;
    try {
      facts = await this.#opts.facts();
    } catch (error) {
      this.#log.error('could not collect host facts for HELLO', { err: error });
      this.#close(conn, CloseCode.normal, 'host facts unavailable');
      return;
    }
    if (this.#conn !== conn || conn.ws.readyState !== WebSocket.OPEN) return;
    const p = this.#params();
    const hello: WorkerToMaster = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'HELLO',
      messageId: randomUUID(),
      seq: 0,
      ts: new Date().toISOString(),
      correlationId: `conn-${String(conn.id)}`,
      ...(p.workerId === null ? {} : { workerId: WorkerId.parse(p.workerId) }),
      payload: {
        supportedVersions: [...(this.#opts.supportedVersions ?? SUPPORTED_PROTOCOL_VERSIONS)],
        workerVersion: this.#opts.workerVersion,
        publicKey: p.publicKey,
        ...(p.pairingCode === null ? {} : { pairingCode: p.pairingCode }),
        resumeFromSeq: p.resumeFromSeq,
        facts,
        instanceId: this.#instanceId,
        ...(p.pairOnly === true ? { pairOnly: true } : {}),
        ...(this.#lastDisconnect === null ? {} : { lastDisconnect: this.#lastDisconnect }),
      },
    };
    this.#enqueue(hello, true).catch((error: unknown) => {
      this.#log.warn('HELLO could not be sent', { err: error });
    });
  }

  #onFrame(conn: Connection, data: WebSocket.RawData, isBinary: boolean): void {
    if (this.#conn !== conn) return;
    if (isBinary) {
      // Binary frames carry STREAM_* data only (ADR-0066), and only within a session with a stream handler.
      const streams = this.#streams;
      if (conn.phase !== 'session' || streams === null) {
        this.#protocolError(conn, CloseCode.unsupportedData, 'binary frame from master');
        return;
      }
      const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (!streams.onData(frame)) {
        this.#protocolError(conn, CloseCode.protocolViolation, 'stream protocol violations');
      }
      return;
    }
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data as Buffer).toString('utf8');
    const parsed = parseFrame(MasterToWorker, text);
    if (!parsed.ok) {
      conn.invalidFrames++;
      this.stats.invalidFrames++;
      this.#log.warn('invalid frame from master ignored', { error: parsed.error, issues: parsed.issues });
      if (conn.invalidFrames > this.#limits.maxInvalidFrames) {
        this.#protocolError(conn, CloseCode.protocolViolation, 'too many invalid frames');
      }
      return;
    }
    this.#onMessage(conn, parsed.message);
  }

  #onMessage(conn: Connection, message: MasterToWorker): void {
    switch (message.type) {
      case 'CHALLENGE': {
        if (conn.phase === 'connecting') return;
        // Handshake or in-band re-authentication before the session expires.
        const nonce = message.payload.nonce;
        if (nonce === conn.lastNonce) {
          this.#protocolError(conn, CloseCode.protocolViolation, 'master reused a challenge nonce');
          return;
        }
        conn.lastNonce = nonce;
        if (conn.phase === 'hello') conn.phase = 'auth';
        const p = this.#params();
        const auth: WorkerToMaster = {
          protocolVersion: PROTOCOL_VERSION,
          type: 'AUTH',
          messageId: randomUUID(),
          seq: 0,
          ts: new Date().toISOString(),
          correlationId: message.correlationId,
          ...(p.workerId === null ? {} : { workerId: WorkerId.parse(p.workerId) }),
          payload: { nonce, signature: p.signChallenge(nonce) },
        };
        this.#enqueue(auth, true).catch((error: unknown) => {
          this.#log.warn('AUTH could not be sent', { err: error });
        });
        return;
      }
      case 'ENROLL_PENDING':
        this.#clearHelloTimer(conn);
        conn.phase = 'pending';
        if (!conn.announced) {
          conn.announced = true;
          this.#deliver(conn, { kind: 'connected', enrolled: false });
        }
        this.#deliver(conn, { kind: 'message', message });
        return;
      case 'SESSION_ESTABLISHED': {
        this.#clearHelloTimer(conn);
        const first = conn.phase !== 'session';
        conn.phase = 'session';
        if (first) {
          this.stats.sessions++;
          // p17-chat-reconnect: the HELLO of this connection carried it.
          this.#lastDisconnect = null;
          this.#log.info('session established', {
            negotiatedVersion: message.payload.negotiatedVersion,
            expiresAt: message.payload.sessionExpiresAt,
          });
        }
        if (!conn.announced) {
          conn.announced = true;
          this.#deliver(conn, {
            kind: 'connected',
            enrolled: true,
            session: {
              negotiatedVersion: message.payload.negotiatedVersion,
              expiresAt: message.payload.sessionExpiresAt,
              resumeFromSeq: message.payload.resumeFromSeq,
            },
          });
        }
        if (first) this.#streams?.onSessionStart();
        this.#deliver(conn, { kind: 'message', message });
        return;
      }
      case 'ERROR':
        if (message.payload.code === 'upgrade_required') {
          this.#nextDelayOverride = this.#timing.backoffMaxMs;
        }
        if (message.payload.code === 'rate_limited') {
          this.#nextDelayOverride = this.#timing.backoffMaxMs;
        }
        this.#deliver(conn, { kind: 'message', message });
        return;
      default:
        if (conn.phase !== 'session' && message.type !== 'ENROLL_APPROVED') {
          // Before authentication only handshake messages make sense.
          this.#protocolError(conn, CloseCode.protocolViolation, `${message.type} before session`);
          return;
        }
        if (isStreamMessageType(message.type) && this.#streams !== null) {
          // Stream plane: handled at once, in frame order with the binary data frames.
          this.#streams.onControl(message as StreamControlMessage);
          return;
        }
        this.#deliver(conn, { kind: 'message', message });
    }
  }

  #deliver(conn: Connection, event: TransportEvent): void {
    const handler = this.#onEvent;
    if (handler === null || this.#stopped) return;
    conn.unprocessed++;
    if (conn.unprocessed >= this.#limits.maxUnprocessedEvents && !conn.ws.isPaused) {
      // The consumer lags: stop reading; TCP flow control pushes back on the master.
      conn.ws.pause();
      this.stats.pausedReads++;
      this.#log.debug('consumer lagging; pausing reads', { unprocessed: conn.unprocessed });
    }
    const done = () => {
      conn.unprocessed--;
      if (conn.ws.isPaused && conn.unprocessed <= this.#limits.resumeBelowEvents) conn.ws.resume();
    };
    let result: void | Promise<void>;
    try {
      result = handler(event);
    } catch (error) {
      this.#log.error('transport event handler threw', { event: event.kind, err: error });
      done();
      return;
    }
    if (result instanceof Promise) {
      result.then(done, (error: unknown) => {
        this.#log.error('transport event handler failed', { event: event.kind, err: error });
        done();
      });
    } else {
      done();
    }
  }

  #onClose(conn: Connection, code: number, reason: string): void {
    this.#clearHelloTimer(conn);
    this.#stopPing(conn);
    if (this.#conn !== conn) return;
    this.#conn = null;
    if (conn.phase === 'session') this.#streams?.onSessionEnd();
    this.#failQueue(new NotConnectedError('connection closed'));
    this.#inflightBytes = 0;
    const why = conn.closeReason ?? (reason === '' ? `closed (${String(code)})` : reason);
    if (conn.phase === 'session') this.#rememberDisconnect(conn, code, reason);
    if (conn.announced) {
      this.stats.disconnects++;
      this.#deliver(conn, { kind: 'disconnected', reason: why });
    }
    if (this.#stopped) return;
    if (code === CloseCode.forbidden) {
      // Revoked / denied / superseded: the daemon decides (it received the ERROR); never hammer the master.
      this.#log.error('master refused this worker; not reconnecting', { code, reason: why });
      this.#stopped = true;
      return;
    }
    const stable = conn.openedAt > 0 && this.#clock() - conn.openedAt >= this.#timing.stableAfterMs;
    if (stable && conn.phase === 'session') this.#attempt = 0;
    if (code === CloseCode.upgradeRequired || code === CloseCode.rateLimited) {
      this.#nextDelayOverride = this.#timing.backoffMaxMs;
    }
    if (code === CloseCode.replaced) {
      // p5-live-fixes-2: our own reconnects never arrive here (a superseded socket is ignored above), so another
      // process presented this worker's device key. Back off fully instead of fighting it every few seconds.
      this.#log.warn('another process using this worker identity replaced the connection', {
        instanceId: this.#instanceId,
        reason: why,
      });
      this.#nextDelayOverride = this.#timing.backoffMaxMs;
    }
    const delay = this.#nextDelayOverride ?? backoffDelay(this.#attempt, this.#timing, this.#random);
    this.#nextDelayOverride = null;
    this.#attempt++;
    this.#log.info('disconnected from master; reconnecting', {
      code,
      reason: why,
      delayMs: delay,
      ...(this.#lastDisconnect === null ? {} : { cause: this.#lastDisconnect }),
    });
    this.#reconnectTimer = setTimeout(() => {
      this.#connect();
    }, delay);
  }

  /** p17-chat-reconnect: the structured cause of a session's end, for the next HELLO. */
  #rememberDisconnect(conn: Connection, code: number, reason: string): void {
    const cause = conn.cause ?? {
      cause: 'closed' as const,
      code,
      ...(reason === '' ? {} : { detail: reason.slice(0, 300) }),
    };
    this.#lastDisconnect = {
      at: new Date(this.#clock()).toISOString(),
      ...cause,
      ...(conn.openedAt > 0 ? { connectedMs: Math.max(0, Math.round(this.#clock() - conn.openedAt)) } : {}),
    };
  }

  #close(conn: Connection, code: number, reason: string): void {
    conn.closeReason ??= reason;
    conn.cause ??= { cause: 'worker_closed', code, detail: reason.slice(0, 300) };
    const ws = conn.ws;
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(code, reason.slice(0, 120));
      // A peer that does not complete the closing handshake is cut off.
      setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }, 2_000).unref();
    }
  }

  #protocolError(conn: Connection, code: number, reason: string): void {
    this.#log.warn('protocol violation by master; closing', { reason });
    this.#close(conn, code, reason);
  }

  #clearHelloTimer(conn: Connection): void {
    if (conn.helloTimer !== null) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
  }

  #startPing(conn: Connection): void {
    conn.pingTimer = setInterval(() => {
      if (conn.ws.readyState !== WebSocket.OPEN) return;
      if (conn.pongTimer !== null) return;
      conn.pingSentAt = this.#clock();
      const timer = setTimeout(() => {
        // p17-chat-reconnect: after an event-loop stall the timers phase runs before the socket's pending input is
        // read, so a pong that already arrived would lose the race. Decide one I/O turn later (setImmediate runs
        // after the poll phase): a pong read meanwhile cleared `pongTimer`.
        setImmediate(() => {
          if (conn.pongTimer !== timer) return;
          const waited = Math.max(0, Math.round(this.#clock() - conn.pingSentAt));
          const loop = this.#loopDelay.maxMs();
          this.#log.warn('master did not answer ping; terminating connection', {
            pongWaitMs: waited,
            ...(loop === null ? {} : { loopDelayMaxMs: loop }),
          });
          conn.closeReason ??= 'ping timeout';
          conn.cause ??= {
            cause: 'pong_timeout',
            pongWaitMs: waited,
            ...(loop === null ? {} : { loopDelayMaxMs: loop }),
          };
          conn.ws.terminate();
        });
      }, this.#timing.pongTimeoutMs);
      conn.pongTimer = timer;
      conn.ws.ping();
    }, this.#timing.pingIntervalMs);
  }

  #stopPing(conn: Connection): void {
    if (conn.pingTimer !== null) clearInterval(conn.pingTimer);
    if (conn.pongTimer !== null) clearTimeout(conn.pongTimer);
    conn.pingTimer = null;
    conn.pongTimer = null;
  }

  // ---------------------------------------------------------------- send queue

  #enqueue(message: WorkerToMaster, internal = false): Promise<void> {
    const checked = WorkerToMaster.safeParse(message);
    if (!checked.success) {
      return Promise.reject(new TypeError(`refusing to send an invalid ${message.type} message`));
    }
    const data = JSON.stringify(checked.data);
    const bytes = Buffer.byteLength(data, 'utf8');
    if (bytes > MAX_FRAME_BYTES) return Promise.reject(new FrameTooLargeError(bytes));
    const queued = this.#control.length + this.#data.length;
    if (
      !internal &&
      (queued >= this.#limits.maxQueuedMessages || this.#queuedBytes + bytes > this.#limits.maxQueuedBytes)
    ) {
      this.stats.queueFull++;
      return Promise.reject(new SendQueueFullError());
    }
    return new Promise((resolve, reject) => {
      const item: Queued = { data, bytes, budgeted: !message.type.startsWith('STREAM_'), resolve, reject };
      (CONTROL_TYPES.has(message.type) ? this.#control : this.#data).push(item);
      this.#queuedBytes += bytes;
      this.#pump();
    });
  }

  #pump(): void {
    const conn = this.#conn;
    if (conn === null || conn.ws.readyState !== WebSocket.OPEN) return;
    while (this.#inflightBytes < this.#limits.socketHighWaterBytes) {
      const head = this.#control[0] ?? this.#data[0];
      if (head === undefined) break;
      if (head.budgeted) {
        const now = this.#clock();
        const wait = Math.max(this.#msgBudget.waitMs(1, now), this.#byteBudget.waitMs(head.bytes, now));
        if (wait > 0) {
          if (this.#budgetTimer === null) {
            this.#budgetTimer = setTimeout(() => {
              this.#budgetTimer = null;
              this.#pump();
            }, wait);
          }
          break;
        }
        this.#msgBudget.take(1, now);
        this.#byteBudget.take(head.bytes, now);
      }
      const item = (this.#control[0] === head ? this.#control : this.#data).shift();
      if (item === undefined) break;
      this.#queuedBytes -= item.bytes;
      this.#inflightBytes += item.bytes;
      this.#inflight.add(item);
      conn.ws.send(item.data, { binary: typeof item.data !== 'string' }, (error) => {
        if (!this.#inflight.delete(item)) return; // already failed by the close
        if (this.#conn === conn) this.#inflightBytes = Math.max(0, this.#inflightBytes - item.bytes);
        if (error) item.reject(error);
        else item.resolve();
        if (this.#conn === conn) this.#pump();
      });
    }
    // Room again: stream writers waiting in sendBinary re-check.
    if (this.#spaceWaiters.length > 0 && this.#queuedBytes < this.#limits.maxQueuedBytes / 2) {
      for (const wake of this.#spaceWaiters.splice(0)) wake();
    }
  }

  #failQueue(error: Error): void {
    // Written-but-unconfirmed frames may or may not have reached the master: the sender
    // treats them as unsent (durable ones are replayed and deduplicated by the master).
    for (const item of [...this.#inflight, ...this.#control.splice(0), ...this.#data.splice(0)])
      item.reject(error);
    this.#inflight.clear();
    this.#queuedBytes = 0;
    for (const wake of this.#spaceWaiters.splice(0)) wake();
  }
}
