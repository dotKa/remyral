import type { Readable, Writable } from 'node:stream';
import type { z } from 'zod';
import { jsonRpcCodec, JsonlTransport, TransportError, type Inbound } from '../../stdio-jsonl.js';
import type { InitializeParams } from './protocol/generated/InitializeParams.js';
import type { GetAccountParams } from './protocol/generated/v2/GetAccountParams.js';
import type { GetAccountRateLimitsParams } from './protocol/generated/v2/GetAccountRateLimitsParams.js';
import type { ThreadResumeParams } from './protocol/generated/v2/ThreadResumeParams.js';
import type { ThreadStartParams } from './protocol/generated/v2/ThreadStartParams.js';
import type { TurnInterruptParams } from './protocol/generated/v2/TurnInterruptParams.js';
import type { TurnStartParams } from './protocol/generated/v2/TurnStartParams.js';
import type { TurnSteerParams } from './protocol/generated/v2/TurnSteerParams.js';
import { InboundMessage } from './protocol/schemas.js';

/** Client → server requests the adapter sends, with their generated param types (codex-cli 0.162.1). */
export interface CodexRequestParams {
  initialize: InitializeParams;
  'account/read': GetAccountParams;
  /** p11-limit-visibility: read-only plan usage windows. */
  'account/rateLimits/read': GetAccountRateLimitsParams;
  'thread/start': ThreadStartParams;
  'thread/resume': ThreadResumeParams;
  'turn/start': TurnStartParams;
  'turn/steer': TurnSteerParams;
  'turn/interrupt': TurnInterruptParams;
}

/** JSON-RPC error codes used when the adapter refuses a server → client request. */
export const RPC_METHOD_NOT_FOUND = -32601;

/**
 * Typed JSON-RPC client for `codex app-server --listen stdio://` on top of the
 * shared `JsonlTransport` (LF framing, size limits, schema-validated lines,
 * fail-closed on bad lines). The pinned binary uses JSON-RPC 2.0 shapes
 * without the `"jsonrpc"` member (verified 2026-10-13).
 */
export class CodexRpc {
  readonly transport: JsonlTransport<InboundMessage, { method: string; params?: unknown }>;

  constructor(
    input: Readable,
    output: Writable,
    opts: {
      defaultTimeoutMs: number;
      onProtocolError?: (err: TransportError) => void;
      /** Inbound line bound (default the transport's 8 MiB). */
      maxLineBytes?: number;
    },
  ) {
    this.transport = new JsonlTransport({
      input,
      output,
      codec: jsonRpcCodec(InboundMessage, { includeVersionMember: false }),
      defaultTimeoutMs: opts.defaultTimeoutMs,
      onBadLine: 'fail',
      ...(opts.maxLineBytes === undefined ? {} : { maxLineBytes: opts.maxLineBytes }),
      ...(opts.onProtocolError ? { onProtocolError: opts.onProtocolError } : {}),
    });
  }

  /** Send a request and validate the result against `schema` (only the fields the adapter uses). */
  async call<M extends keyof CodexRequestParams, S extends z.ZodType>(
    method: M,
    params: CodexRequestParams[M],
    schema: S,
    timeoutMs?: number,
  ): Promise<z.output<S>> {
    const raw = await this.transport.request({ method, params }, timeoutMs);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new TransportError(
        'schema_violation',
        `${method}: response failed schema validation`,
        parsed.error,
      );
    }
    return parsed.data;
  }

  /** Client notification (`initialized`). */
  notify(method: 'initialized'): Promise<void> {
    return this.transport.send({ method });
  }

  /** Answer a server → client request with its original id (string or number, unchanged). */
  respond(id: string | number, result: unknown): Promise<void> {
    return this.transport.send({ id, result });
  }

  respondError(id: string | number, code: number, message: string): Promise<void> {
    return this.transport.send({ id, error: { code, message } });
  }

  inbound(signal?: AbortSignal): AsyncGenerator<Inbound<InboundMessage>> {
    return this.transport.inbound(signal);
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
