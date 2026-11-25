import { randomUUID } from 'node:crypto';
import type { Logger } from '@remyral/observability';
import { PROTOCOL_VERSION, WorkerId, type WorkerToMaster } from '@remyral/protocol';
import {
  type AcceptDecision,
  type StreamControl,
  StreamMux,
  type StreamOpenRequest,
} from '@remyral/protocol/stream-mux';
import type { StreamControlMessage, TransportPort, TransportStreamHandler } from '../transport/port.js';
import type { IdeGateway } from './gateway.js';

/**
 * p19-ide W2 (ADR-0066): the worker's end of the STREAM_* plane — one {@link StreamMux} per authenticated master
 * connection (a reconnect resets every stream). `STREAM_OPEN{target: ide, workspaceId}` reaches the gateway of a
 * workspace this worker runs right now, or is refused (`not_found`); the master can never name a host or a port.
 */
export interface IdeStreamsOptions {
  readonly logger: Logger;
  readonly transport: Pick<TransportPort, 'send' | 'sendBinary'>;
  readonly workerId: () => string | null;
  /** The gateway of a running workspace (null: not running here). */
  readonly gateway: (workspaceId: string) => IdeGateway | null;
  /** Receive window per stream; default 256 KiB. */
  readonly streamWindow?: number;
  readonly maxStreams?: number;
}

export class IdeStreams {
  readonly #o: IdeStreamsOptions;
  readonly #log: Logger;
  #mux: StreamMux | null = null;
  #violationClose = false;

  constructor(options: IdeStreamsOptions) {
    this.#o = options;
    this.#log = options.logger.child({ component: 'ide-streams' });
  }

  /** Streams open on the current connection (tests, metrics). */
  get openStreams(): number {
    return this.#mux?.size ?? 0;
  }

  /** Accepted streams of one workspace on the current connection. */
  countFor(workspaceId: string): number {
    return this.#mux?.countFor(workspaceId) ?? 0;
  }

  /** Ends every stream of a workspace (it stopped). */
  resetWorkspace(workspaceId: string): void {
    this.#mux?.resetWorkspace(workspaceId, 'shutdown');
  }

  handler(): TransportStreamHandler {
    return {
      onSessionStart: () => {
        this.#mux?.close('shutdown');
        this.#violationClose = false;
        this.#mux = new StreamMux(
          {
            sendControl: (m) => this.#sendControl(m),
            sendData: (frame) =>
              this.#o.transport.sendBinary?.(frame) ?? Promise.reject(new Error('no binary channel')),
          },
          {
            ...(this.#o.streamWindow === undefined ? {} : { window: this.#o.streamWindow }),
            maxStreams: this.#o.maxStreams ?? 128,
            onOpen: (req) => this.#accept(req),
          },
        );
      },
      onSessionEnd: () => {
        this.#mux?.close('shutdown');
        this.#mux = null;
      },
      onControl: (message: StreamControlMessage) => {
        const mux = this.#mux;
        if (mux === null) return;
        mux.handleControl({ type: message.type, payload: message.payload } as StreamControl);
      },
      onData: (frame: Buffer) => {
        const mux = this.#mux;
        if (mux === null) return true;
        mux.handleData(frame);
        if (mux.tooManyViolations && !this.#violationClose) {
          this.#violationClose = true;
          this.#log.warn('master broke the stream protocol repeatedly; dropping the connection');
          return false;
        }
        return true;
      },
    };
  }

  #accept(req: StreamOpenRequest): AcceptDecision {
    const gateway = this.#o.gateway(req.workspaceId);
    if (gateway === null) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      attach: (stream) => {
        // A reset (workspace stopped, link lost) must never become an unhandled 'error'.
        stream.on('error', () => undefined);
        gateway.handle(stream);
      },
    };
  }

  #sendControl(m: StreamControl): Promise<void> {
    const workerId = this.#o.workerId();
    if (workerId === null) return Promise.reject(new Error('not enrolled'));
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: m.type,
      messageId: randomUUID(),
      seq: 0,
      ts: new Date().toISOString(),
      correlationId: `stream-${String(m.payload.streamId)}`,
      workerId: WorkerId.parse(workerId),
      payload: m.payload,
    } as WorkerToMaster;
    return this.#o.transport.send(message);
  }
}
