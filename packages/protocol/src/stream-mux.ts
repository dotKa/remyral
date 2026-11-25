import { Duplex } from 'node:stream';
import {
  DEFAULT_STREAM_WINDOW,
  decodeStreamData,
  encodeStreamData,
  MAX_STREAM_ID,
  MAX_STREAM_PAYLOAD,
  MAX_STREAM_WINDOW,
  MIN_STREAM_WINDOW,
  type StreamCloseReason,
  type StreamTarget,
} from './stream.js';

/**
 * Shared implementation of the STREAM_* multiplexer (ADR-0066, restored from ADR-0013's plane; docs/design/p19-ide.md
 * §2.2). The master (opener) and the worker (acceptor) use the same class so both ends apply identical credit-based
 * flow control. It knows nothing about WebSockets: the owner feeds it parsed control payloads and raw binary frames
 * and gives it a {@link MuxLink} to send through.
 */

/** What a stream reaches: an IDE workspace the worker runs (target `ide`). */
export interface StreamTargetRef {
  readonly target: StreamTarget;
  readonly workspaceId: string;
}

/** Control payloads (the envelope is the owner's business). */
export type StreamControl =
  | {
      readonly type: 'STREAM_OPEN';
      readonly payload: {
        streamId: number;
        target: StreamTarget;
        workspaceId: string;
        window: number;
      };
    }
  | { readonly type: 'STREAM_ACCEPT'; readonly payload: { streamId: number; window: number } }
  | { readonly type: 'STREAM_WINDOW'; readonly payload: { streamId: number; credit: number } }
  | {
      readonly type: 'STREAM_CLOSE';
      readonly payload: { streamId: number; mode: 'fin' | 'reset'; reason?: StreamCloseReason };
    };

export interface MuxLink {
  /** Send one control message. Rejects when the link is down. */
  sendControl(message: StreamControl): Promise<void>;
  /** Send one encoded binary data frame; resolves once handed to the socket (backpressure). */
  sendData(frame: Buffer): Promise<void>;
}

export interface StreamOpenRequest {
  readonly streamId: number;
  readonly target: StreamTarget;
  readonly workspaceId: string;
}

/** Acceptor decision: attach the new stream to the target, or refuse with a reason. */
export type AcceptDecision =
  | { readonly ok: true; readonly attach: (stream: TunnelStream) => void }
  | { readonly ok: false; readonly reason: StreamCloseReason };

export interface StreamMuxOptions {
  /** Receive window granted per stream (bytes). Default 128 KiB. */
  readonly window?: number;
  /** Concurrent streams on this link. Default 64. */
  readonly maxStreams?: number;
  /** Opener: how long to wait for STREAM_ACCEPT. Default 15 s. */
  readonly openTimeoutMs?: number;
  /** Largest payload per data frame. Default MAX_STREAM_PAYLOAD. */
  readonly maxPayload?: number;
  /** Protocol violations tolerated before {@link StreamMux.violations} asks the owner to drop the link. */
  readonly maxViolations?: number;
  /** Acceptor: decides about STREAM_OPEN. Without it every STREAM_OPEN is refused. */
  readonly onOpen?: (request: StreamOpenRequest) => AcceptDecision | Promise<AcceptDecision>;
}

export class StreamRefusedError extends Error {
  constructor(readonly reason: StreamCloseReason) {
    super(`stream refused: ${reason}`);
    this.name = 'StreamRefusedError';
  }
}

export class StreamResetError extends Error {
  constructor(readonly reason: StreamCloseReason) {
    super(`stream reset: ${reason}`);
    this.name = 'StreamResetError';
  }
}

/** Result of feeding one inbound item: `violation` = the peer broke the protocol (owner counts/drops). */
export type MuxVerdict = 'ok' | 'violation';

interface Pending {
  readonly stream: TunnelStream;
  readonly resolve: (stream: TunnelStream) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * One end of a multiplexed link. Stream ids are allocated by the opener (the master) only; the acceptor
 * never opens streams, so ids never collide.
 */
export class StreamMux {
  readonly #link: MuxLink;
  readonly #window: number;
  readonly #maxStreams: number;
  readonly #openTimeoutMs: number;
  readonly #maxPayload: number;
  readonly #maxViolations: number;
  readonly #onOpen: StreamMuxOptions['onOpen'];
  readonly #streams = new Map<number, TunnelStream>();
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed: StreamCloseReason | null = null;
  #violations = 0;
  readonly stats = { opened: 0, accepted: 0, refused: 0, resets: 0, violations: 0, bytesIn: 0, bytesOut: 0 };

  constructor(link: MuxLink, options: StreamMuxOptions = {}) {
    const window = options.window ?? DEFAULT_STREAM_WINDOW;
    if (window < MIN_STREAM_WINDOW || window > MAX_STREAM_WINDOW) throw new RangeError('invalid window');
    this.#link = link;
    this.#window = window;
    this.#maxStreams = options.maxStreams ?? 64;
    this.#openTimeoutMs = options.openTimeoutMs ?? 15_000;
    this.#maxPayload = Math.min(options.maxPayload ?? MAX_STREAM_PAYLOAD, MAX_STREAM_PAYLOAD);
    this.#maxViolations = options.maxViolations ?? 3;
    this.#onOpen = options.onOpen;
  }

  /** Open streams (accepted or pending). */
  get size(): number {
    return this.#streams.size + this.#pending.size;
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  /** True once the peer broke the protocol more often than tolerated: the owner should drop the link. */
  get tooManyViolations(): boolean {
    return this.#violations > this.#maxViolations;
  }

  // ------------------------------------------------------------------------------------- opener

  /** Opens a stream to `ref`; resolves once the peer accepted it. */
  open(ref: StreamTargetRef): Promise<TunnelStream> {
    if (this.#closed !== null) return Promise.reject(new StreamRefusedError(this.#closed));
    if (this.size >= this.#maxStreams) return Promise.reject(new StreamRefusedError('overloaded'));
    const streamId = this.#allocate();
    const stream = new TunnelStream(this, streamId, this.#window, 0);
    stream.targetRef = { target: ref.target, workspaceId: ref.workspaceId };
    return new Promise<TunnelStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.get(streamId)?.stream !== stream) return;
        this.#pending.delete(streamId);
        reject(new StreamRefusedError('timeout'));
        this.#send({ type: 'STREAM_CLOSE', payload: { streamId, mode: 'reset', reason: 'timeout' } });
        stream.destroy();
      }, this.#openTimeoutMs);
      timer.unref();
      this.#pending.set(streamId, { stream, resolve, reject, timer });
      this.stats.opened++;
      this.#link
        .sendControl({
          type: 'STREAM_OPEN',
          payload: { streamId, target: ref.target, workspaceId: ref.workspaceId, window: this.#window },
        })
        .catch(() => {
          const p = this.#pending.get(streamId);
          if (p?.stream !== stream) return;
          clearTimeout(p.timer);
          this.#pending.delete(streamId);
          reject(new StreamRefusedError('unavailable'));
        });
    });
  }

  #allocate(): number {
    for (let i = 0; i < MAX_STREAM_ID; i++) {
      const id = this.#nextId;
      this.#nextId = this.#nextId >= MAX_STREAM_ID ? 1 : this.#nextId + 1;
      if (!this.#streams.has(id) && !this.#pending.has(id)) return id;
    }
    throw new Error('no free stream id');
  }

  // ------------------------------------------------------------------------------------- inbound

  /** Feed one control message from the peer. */
  handleControl(message: StreamControl): MuxVerdict {
    if (this.#closed !== null) return 'ok';
    switch (message.type) {
      case 'STREAM_OPEN':
        return this.#onOpenMessage(message.payload);
      case 'STREAM_ACCEPT': {
        const p = this.#pending.get(message.payload.streamId);
        if (p === undefined) {
          return this.#streams.has(message.payload.streamId) ? this.#violation() : 'ok';
        }
        clearTimeout(p.timer);
        this.#pending.delete(message.payload.streamId);
        this.#streams.set(message.payload.streamId, p.stream);
        p.stream.addCredit(message.payload.window);
        this.stats.accepted++;
        p.resolve(p.stream);
        return 'ok';
      }
      case 'STREAM_WINDOW': {
        const s = this.#streams.get(message.payload.streamId);
        if (s === undefined) return 'ok'; // raced with a close
        if (!s.addCredit(message.payload.credit)) return this.#violation(s);
        return 'ok';
      }
      case 'STREAM_CLOSE': {
        const { streamId, mode, reason } = message.payload;
        const p = this.#pending.get(streamId);
        if (p !== undefined) {
          clearTimeout(p.timer);
          this.#pending.delete(streamId);
          this.stats.refused++;
          p.reject(new StreamRefusedError(reason ?? 'refused'));
          p.stream.discard();
          return 'ok';
        }
        const s = this.#streams.get(streamId);
        if (s === undefined) return 'ok';
        if (mode === 'fin') {
          if (!s.remoteFin()) return this.#violation(s);
        } else {
          this.stats.resets++;
          s.remoteReset(reason ?? 'error');
        }
        return 'ok';
      }
    }
  }

  /** Feed one binary frame from the peer. */
  handleData(frame: Buffer): MuxVerdict {
    if (this.#closed !== null) return 'ok';
    const decoded = decodeStreamData(frame);
    if (decoded === null) return this.#violation();
    const s = this.#streams.get(decoded.streamId);
    if (s === undefined) {
      // Data for a pending stream (before ACCEPT) is a violation; for an unknown/closed one it is a race.
      return this.#pending.has(decoded.streamId) ? this.#violation() : 'ok';
    }
    this.stats.bytesIn += decoded.payload.length;
    if (!s.remoteData(decoded.payload)) return this.#violation(s);
    return 'ok';
  }

  #onOpenMessage(p: Extract<StreamControl, { type: 'STREAM_OPEN' }>['payload']): MuxVerdict {
    const { streamId } = p;
    if (this.#streams.has(streamId) || this.#pending.has(streamId)) return this.#violation();
    const refuse = (reason: StreamCloseReason) => {
      this.stats.refused++;
      this.#send({ type: 'STREAM_CLOSE', payload: { streamId, mode: 'reset', reason } });
    };
    if (this.#onOpen === undefined) {
      refuse('refused');
      return 'ok';
    }
    if (this.size >= this.#maxStreams) {
      refuse('overloaded');
      return 'ok';
    }
    // Reserve the id while the decision is made (a duplicate OPEN meanwhile is a violation).
    const onOpen = this.#onOpen;
    const stream = new TunnelStream(this, streamId, this.#window, p.window);
    stream.targetRef = { target: p.target, workspaceId: p.workspaceId };
    this.#streams.set(streamId, stream);
    const decide = async (): Promise<void> => {
      let decision: AcceptDecision;
      try {
        decision = await onOpen({ streamId, target: p.target, workspaceId: p.workspaceId });
      } catch {
        decision = { ok: false, reason: 'error' };
      }
      if (this.#streams.get(streamId) !== stream || this.#closed !== null) return;
      if (!decision.ok) {
        this.#streams.delete(streamId);
        refuse(decision.reason);
        stream.discard();
        return;
      }
      this.stats.accepted++;
      this.#send({ type: 'STREAM_ACCEPT', payload: { streamId, window: this.#window } });
      try {
        decision.attach(stream);
      } catch {
        stream.destroy(new StreamResetError('error'));
      }
    };
    void decide();
    return 'ok';
  }

  #violation(stream?: TunnelStream): MuxVerdict {
    this.#violations++;
    this.stats.violations++;
    if (stream !== undefined) stream.resetLocal('protocol');
    return 'violation';
  }

  // ------------------------------------------------------------------------------------- lifecycle

  /** The link is gone (socket closed, session ended): every stream ends with a reset. Idempotent. */
  close(reason: StreamCloseReason = 'shutdown'): void {
    if (this.#closed !== null) return;
    this.#closed = reason;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new StreamRefusedError(reason));
      p.stream.destroy();
    }
    this.#pending.clear();
    for (const s of [...this.#streams.values()]) s.linkGone(reason);
    this.#streams.clear();
  }

  /** Reset every stream of one workspace (it stopped); returns how many were reset. */
  resetWorkspace(workspaceId: string, reason: StreamCloseReason = 'shutdown'): number {
    let n = 0;
    for (const s of [...this.#streams.values()]) {
      if (s.targetRef?.workspaceId === workspaceId) {
        s.resetLocal(reason);
        n++;
      }
    }
    return n;
  }

  /** Accepted streams per workspace (idle tracking, metrics). */
  countFor(workspaceId: string): number {
    let n = 0;
    for (const s of this.#streams.values()) if (s.targetRef?.workspaceId === workspaceId) n++;
    return n;
  }

  // ------------------------------------------------------------------------------------- internal (streams)

  /** @internal */
  get maxPayload(): number {
    return this.#maxPayload;
  }

  /** @internal */
  sendFrame(streamId: number, payload: Buffer): Promise<void> {
    if (this.#closed !== null) return Promise.reject(new StreamResetError(this.#closed));
    this.stats.bytesOut += payload.length;
    return this.#link.sendData(encodeStreamData(streamId, payload));
  }

  /** @internal */
  sendControl(message: StreamControl): void {
    this.#send(message);
  }

  /** @internal */
  forget(stream: TunnelStream): void {
    if (this.#streams.get(stream.id) === stream) this.#streams.delete(stream.id);
  }

  #send(message: StreamControl): void {
    if (this.#closed !== null) return;
    this.#link.sendControl(message).catch(() => undefined);
  }
}

/**
 * One multiplexed byte stream (a `net.Socket`-like Duplex). Writes wait for credit and for the link to
 * take each frame; reads grant credit back as the consumer drains the readable buffer.
 */
export class TunnelStream extends Duplex {
  /** What the stream reaches (set at open / accept). */
  targetRef: StreamTargetRef | undefined;
  readonly #mux: StreamMux;
  readonly #recvWindow: number;
  #sendCredit: number;
  /** Bytes received and not yet credited back. */
  #outstanding = 0;
  #creditWaiters: (() => void)[] = [];
  #localFin = false;
  #remoteFinSeen = false;
  #resetSent = false;
  #remoteResetSeen = false;
  // net.Socket compatibility for http / ws (they inspect these).
  readonly remoteAddress = '127.0.0.1';
  readonly remotePort = 0;
  readonly localAddress = '127.0.0.1';
  readonly localPort = 0;
  readonly encrypted = false;

  constructor(
    mux: StreamMux,
    readonly id: number,
    recvWindow: number,
    sendCredit: number,
  ) {
    super({ allowHalfOpen: true, readableHighWaterMark: recvWindow, writableHighWaterMark: 64 * 1024 });
    this.#mux = mux;
    this.#recvWindow = recvWindow;
    this.#sendCredit = sendCredit;
  }

  /** Bytes this side may still send before the peer grants more (tests, metrics). */
  get sendCredit(): number {
    return this.#sendCredit;
  }

  // --------------------------------------------------------------------- net.Socket shims
  setTimeout(_ms: number, callback?: () => void): this {
    if (callback) this.once('timeout', callback);
    return this;
  }
  setNoDelay(_noDelay?: boolean): this {
    return this;
  }
  setKeepAlive(_enable?: boolean, _delay?: number): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  address(): { address: string; family: string; port: number } {
    return { address: '127.0.0.1', family: 'IPv4', port: 0 };
  }

  // --------------------------------------------------------------------- Duplex

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#writeAll(chunk).then(
      () => {
        callback();
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error('stream write failed'));
      },
    );
  }

  async #writeAll(chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.destroyed || this.#resetSent || this.#remoteResetSeen) throw new StreamResetError('error');
      if (this.#sendCredit <= 0) {
        await new Promise<void>((resolve) => this.#creditWaiters.push(resolve));
        continue;
      }
      const n = Math.min(this.#sendCredit, this.#mux.maxPayload, chunk.length - offset);
      this.#sendCredit -= n;
      await this.#mux.sendFrame(this.id, chunk.subarray(offset, offset + n));
      offset += n;
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#localFin = true;
    this.#mux.sendControl({ type: 'STREAM_CLOSE', payload: { streamId: this.id, mode: 'fin' } });
    this.#maybeDone();
    callback();
  }

  override _read(): void {
    // Readable#read() calls _read before it removes the chunk it returns: look again once it did.
    queueMicrotask(() => {
      this.#grant();
    });
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#wake();
    const clean = this.#localFin && this.#remoteFinSeen;
    if (!clean && !this.#resetSent && !this.#remoteResetSeen) {
      this.#resetSent = true;
      const reason = error instanceof StreamResetError ? error.reason : 'error';
      this.#mux.sendControl({ type: 'STREAM_CLOSE', payload: { streamId: this.id, mode: 'reset', reason } });
    }
    this.#mux.forget(this);
    callback(error);
  }

  // --------------------------------------------------------------------- from the mux

  /** @internal Peer granted `credit` more bytes. False if the grant overflows the window (violation). */
  addCredit(credit: number): boolean {
    this.#sendCredit += credit;
    if (this.#sendCredit > MAX_STREAM_WINDOW) return false;
    this.#wake();
    return true;
  }

  /** @internal Payload from the peer. False if it exceeds the granted window or follows a FIN. */
  remoteData(payload: Buffer): boolean {
    if (this.#remoteFinSeen || this.destroyed) return this.destroyed;
    if (this.#outstanding + payload.length > this.#recvWindow) return false;
    this.#outstanding += payload.length;
    this.push(payload);
    // A flowing consumer has already taken it: give the credit back promptly.
    queueMicrotask(() => {
      this.#grant();
    });
    return true;
  }

  /** @internal Peer half-closed. False for a second FIN. */
  remoteFin(): boolean {
    if (this.#remoteFinSeen) return false;
    this.#remoteFinSeen = true;
    this.push(null);
    this.#maybeDone();
    return true;
  }

  /** @internal Peer aborted the stream. */
  remoteReset(reason: StreamCloseReason): void {
    this.#remoteResetSeen = true;
    this.destroy(new StreamResetError(reason));
  }

  /** @internal Abort locally (and tell the peer). */
  resetLocal(reason: StreamCloseReason): void {
    if (this.destroyed) return;
    this.destroy(new StreamResetError(reason));
  }

  /** @internal Drop a stream the peer never accepted (or that was refused): no reset is sent for it. */
  discard(): void {
    this.#resetSent = true;
    if (!this.destroyed) this.destroy();
  }

  /** @internal The link died: nothing can be sent any more. */
  linkGone(reason: StreamCloseReason): void {
    this.#remoteResetSeen = true;
    if (!this.destroyed) this.destroy(new StreamResetError(reason));
  }

  #grant(): void {
    if (this.destroyed || this.#outstanding === 0) return;
    const consumed = this.#outstanding - this.readableLength;
    if (consumed <= 0) return;
    if (consumed < this.#recvWindow / 4 && this.readableLength > 0) return;
    this.#outstanding -= consumed;
    this.#mux.sendControl({ type: 'STREAM_WINDOW', payload: { streamId: this.id, credit: consumed } });
  }

  #wake(): void {
    const waiters = this.#creditWaiters;
    this.#creditWaiters = [];
    for (const w of waiters) w();
  }

  #maybeDone(): void {
    if (this.#localFin && this.#remoteFinSeen) this.#mux.forget(this);
  }
}
