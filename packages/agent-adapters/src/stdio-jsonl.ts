import type { Readable, Writable } from 'node:stream';
import type { z } from 'zod';

/**
 * Line-delimited JSON transport over a child's stdio (Pi `--mode rpc`, Codex
 * `app-server --listen stdio://`). Splits on LF bytes only (a CR before the
 * LF is stripped); U+2028/U+2029 inside JSON strings are not line breaks.
 * The wire shape of requests/responses is supplied by a codec because the
 * runtimes differ (Codex: JSON-RPC style; Pi: `{type, id}` commands); the
 * adapter must derive its codec + Zod schema from the pinned runtime's types
 * (AGENTS.md rule 12).
 */

export class TransportError extends Error {
  constructor(
    readonly code:
      | 'line_too_long'
      | 'invalid_json'
      | 'schema_violation'
      | 'timeout'
      | 'closed'
      | 'queue_overflow'
      | 'remote_error'
      | 'write_failed',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export type Classified =
  | { readonly kind: 'response'; readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly kind: 'response'; readonly id: string; readonly ok: false; readonly error: unknown }
  /** Runtime -> us request that expects an answer (e.g. a Codex approval request). */
  | { readonly kind: 'request'; readonly id: string }
  | { readonly kind: 'notification' };

export interface JsonlCodec<In, Req> {
  /** Validation hook: every inbound line is parsed through this schema. */
  readonly schema: z.ZodType<In>;
  classify(message: In): Classified;
  encodeRequest(id: string, request: Req): unknown;
  /** Answer a runtime -> us request. */
  encodeResponse?(id: string, result: unknown): unknown;
}

export type Inbound<In> =
  | { readonly kind: 'notification'; readonly message: In }
  | {
      readonly kind: 'request';
      readonly id: string;
      readonly message: In;
    };

export interface JsonlTransportOptions<In, Req> {
  readonly input: Readable;
  readonly output: Writable;
  readonly codec: JsonlCodec<In, Req>;
  /** Max bytes per line (excluding LF). Default 8 MiB. */
  readonly maxLineBytes?: number;
  /** Inbound notifications buffered before overflow is a fatal error. Default 10 000. */
  readonly maxQueued?: number;
  readonly defaultTimeoutMs?: number;
  /** `fail` (default) closes the transport on a bad line; `skip` reports via onProtocolError and continues. */
  readonly onBadLine?: 'fail' | 'skip';
  readonly onProtocolError?: (err: TransportError) => void;
  readonly idGenerator?: () => string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const LF = 0x0a;
const CR = 0x0d;

/** Incremental LF splitter with a hard per-line byte limit. */
export class LineSplitter {
  private parts: Buffer[] = [];
  private size = 0;
  private discarding = false;

  constructor(private readonly maxLineBytes: number) {}

  /** Returns complete lines; throws `line_too_long` when a line exceeds the limit (then resyncs at next LF). */
  push(chunk: Buffer, onLine: (line: string) => void, onOversize: (bytes: number) => void): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(LF, start);
      const end = nl === -1 ? chunk.length : nl;
      const piece = chunk.subarray(start, end);
      if (!this.discarding) {
        if (this.size + piece.length > this.maxLineBytes + 1) {
          onOversize(this.size + piece.length);
          this.parts = [];
          this.size = 0;
          this.discarding = nl === -1;
        } else {
          this.parts.push(piece);
          this.size += piece.length;
        }
      }
      if (nl === -1) return;
      if (this.discarding) {
        this.discarding = false;
      } else {
        let line = Buffer.concat(this.parts, this.size);
        if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, line.length - 1);
        this.parts = [];
        this.size = 0;
        if (line.length > this.maxLineBytes) onOversize(line.length);
        else if (line.length > 0) onLine(line.toString('utf8'));
      }
      start = nl + 1;
    }
  }

  /** Bytes of an unterminated trailing line. */
  get pendingBytes(): number {
    return this.size;
  }
}

export class JsonlTransport<In, Req> {
  private readonly pending = new Map<string, Pending>();
  private readonly queue: Inbound<In>[] = [];
  private waiters: (() => void)[] = [];
  private readonly splitter: LineSplitter;
  private closedError: TransportError | undefined;
  private isClosed = false;
  private nextId = 1;
  private readonly maxQueued: number;
  private readonly defaultTimeoutMs: number;
  /** Resolves when the transport is closed (input ended, close(), or fatal error). */
  readonly done: Promise<TransportError | undefined>;
  private resolveDone!: (err: TransportError | undefined) => void;

  constructor(private readonly opts: JsonlTransportOptions<In, Req>) {
    this.splitter = new LineSplitter(opts.maxLineBytes ?? 8 * 1024 * 1024);
    this.maxQueued = opts.maxQueued ?? 10_000;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.done = new Promise((r) => (this.resolveDone = r));
    opts.input.on('data', this.onData);
    opts.input.once('end', this.onEnd);
    opts.input.once('close', this.onEnd);
    opts.input.on('error', this.onInputError);
    opts.output.on('error', this.onOutputError);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Send a request and await the correlated response. Rejects on timeout/close/remote error. */
  request(request: Req, timeoutMs = this.defaultTimeoutMs): Promise<unknown> {
    if (this.isClosed) return Promise.reject(this.closedErr());
    const id = this.opts.idGenerator?.() ?? String(this.nextId++);
    if (this.pending.has(id)) return Promise.reject(new Error(`duplicate request id ${id}`));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TransportError('timeout', `request ${id} timed out after ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeLine(this.opts.codec.encodeRequest(id, request)).catch((err: unknown) => {
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  /** Fire-and-forget message (no correlation), e.g. a JSON-RPC notification. */
  async send(message: unknown): Promise<void> {
    if (this.isClosed) throw this.closedErr();
    await this.writeLine(message);
  }

  /** Answer a runtime -> us request. */
  async respond(id: string, result: unknown): Promise<void> {
    const codec = this.opts.codec;
    if (!codec.encodeResponse) throw new Error('codec does not support responses');
    await this.send(codec.encodeResponse(id, result));
  }

  /** Inbound notifications and runtime requests, in arrival order; ends when the transport closes. */
  async *inbound(signal?: AbortSignal): AsyncGenerator<Inbound<In>> {
    for (;;) {
      if (signal?.aborted) return;
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.isClosed) {
        if (this.closedError && this.closedError.code !== 'closed') throw this.closedError;
        return;
      }
      await new Promise<void>((resolve) => {
        const done = (): void => {
          signal?.removeEventListener('abort', done);
          resolve();
        };
        this.waiters.push(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }

  /** Clean shutdown: end our side (EOF on the child's stdin), fail pending requests. */
  close(): Promise<void> {
    this.shutdown(new TransportError('closed', 'transport closed'));
    return new Promise((resolve) => {
      if (this.opts.output.writableEnded) {
        resolve();
        return;
      }
      this.opts.output.end(() => {
        resolve();
      });
    });
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.isClosed) return;
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.splitter.push(
      buf,
      (line) => {
        this.onLine(line);
      },
      (bytes) => {
        this.protocolError(
          new TransportError('line_too_long', `inbound line of ${String(bytes)} bytes exceeds limit`),
        );
      },
    );
  };

  private readonly onEnd = (): void => {
    this.shutdown(new TransportError('closed', 'input ended'));
  };

  private readonly onInputError = (err: Error): void => {
    this.shutdown(new TransportError('closed', `input error: ${err.message}`));
  };

  private readonly onOutputError = (err: Error): void => {
    this.shutdown(new TransportError('write_failed', `output error: ${err.message}`));
  };

  private onLine(line: string): void {
    if (this.isClosed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.protocolError(new TransportError('invalid_json', 'inbound line is not valid JSON'));
      return;
    }
    const parsed = this.opts.codec.schema.safeParse(raw);
    if (!parsed.success) {
      this.protocolError(
        new TransportError('schema_violation', 'inbound message failed schema validation', parsed.error),
      );
      return;
    }
    const message = parsed.data;
    const c = this.opts.codec.classify(message);
    if (c.kind === 'response') {
      const p = this.pending.get(c.id);
      if (!p) {
        this.protocolError(new TransportError('remote_error', `response for unknown request id ${c.id}`));
        return;
      }
      clearTimeout(p.timer);
      this.pending.delete(c.id);
      if (c.ok) p.resolve(c.result);
      else p.reject(new TransportError('remote_error', `request ${c.id} failed`, c.error));
      return;
    }
    if (this.queue.length >= this.maxQueued) {
      this.shutdown(
        new TransportError('queue_overflow', `more than ${String(this.maxQueued)} unconsumed messages`),
      );
      return;
    }
    this.queue.push(
      c.kind === 'request' ? { kind: 'request', id: c.id, message } : { kind: 'notification', message },
    );
    this.wake();
  }

  private protocolError(err: TransportError): void {
    this.opts.onProtocolError?.(err);
    if ((this.opts.onBadLine ?? 'fail') === 'fail' && err.code !== 'remote_error') this.shutdown(err);
  }

  private writeLine(message: unknown): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
      const ok = this.opts.output.write(line, (err) => {
        if (err) reject(new TransportError('write_failed', err.message));
        else if (ok) resolve();
      });
      if (!ok) {
        this.opts.output.once('drain', () => {
          resolve();
        });
      }
    });
  }

  private closedErr(): TransportError {
    return this.closedError ?? new TransportError('closed', 'transport closed');
  }

  private shutdown(err: TransportError): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closedError = err;
    this.opts.input.off('data', this.onData);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(
        err.code === 'closed' ? new TransportError('closed', `request ${id} aborted: ${err.message}`) : err,
      );
    }
    this.pending.clear();
    this.wake();
    this.resolveDone(err.code === 'closed' ? undefined : err);
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }
}

/**
 * JSON-RPC 2.0 codec (https://www.jsonrpc.org/specification). Adapters must
 * confirm the pinned runtime actually uses this exact framing (e.g. whether
 * the `"jsonrpc":"2.0"` member is present) before using it.
 */
export function jsonRpcCodec<In extends Record<string, unknown>>(
  schema: z.ZodType<In>,
  opts: { includeVersionMember: boolean },
): JsonlCodec<In, { method: string; params?: unknown }> {
  const version = opts.includeVersionMember ? { jsonrpc: '2.0' } : {};
  return {
    schema,
    classify(m) {
      const id = m.id;
      const hasId = typeof id === 'string' || typeof id === 'number';
      if (hasId && typeof m.method === 'string') return { kind: 'request', id: String(id) };
      if (hasId && 'error' in m) return { kind: 'response', id: String(id), ok: false, error: m.error };
      if (hasId && 'result' in m) return { kind: 'response', id: String(id), ok: true, result: m.result };
      return { kind: 'notification' };
    },
    encodeRequest: (id, req) => ({ ...version, id: Number.isNaN(Number(id)) ? id : Number(id), ...req }),
    encodeResponse: (id, result) => ({ ...version, id: Number.isNaN(Number(id)) ? id : Number(id), result }),
  };
}
