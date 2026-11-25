import { IDE_FEATURE } from '@remyral/protocol';
import {
  type StreamControl,
  StreamMux,
  StreamRefusedError,
  type StreamTargetRef,
  type TunnelStream,
} from '@remyral/protocol/stream-mux';
import type { FastifyBaseLogger } from 'fastify';
import type { SessionStreamSink, StreamSinkFactory, WorkerSession } from '../workers/types.js';

export interface TunnelOptions {
  /** Receive window per stream (bytes). Default 256 KiB. */
  readonly window?: number;
  /** Concurrent streams per worker connection. Default 128. */
  readonly maxStreams?: number;
  readonly openTimeoutMs?: number;
}

/**
 * p19-ide W2 (ADR-0066): the master's end of the STREAM_* plane — one {@link StreamMux} per authenticated worker
 * session; the IDE proxy opens streams to a worker through it. A replaced or closed connection resets every stream of
 * that connection (the browser sees a dropped request / socket, never data of another workspace). Streams are opened
 * only to sessions whose worker advertises `ide-v1` (the features of the session are checked by the caller through
 * {@link TunnelRegistry.has}; a worker without the feature never gets a STREAM_OPEN).
 */
export class TunnelRegistry implements StreamSinkFactory {
  readonly #muxes = new Map<string, { readonly connectionId: string; readonly mux: StreamMux }>();
  readonly #o: TunnelOptions;
  readonly #features: (workerId: string) => readonly string[] | null;

  constructor(
    private readonly log: FastifyBaseLogger,
    options: TunnelOptions & {
      /** The features the worker advertised (CAPABILITIES); streams only to `ide-v1` workers. */
      readonly features?: (workerId: string) => readonly string[] | null;
    } = {},
  ) {
    this.#o = options;
    this.#features = options.features ?? (() => null);
  }

  attach(session: WorkerSession): SessionStreamSink {
    const mux = new StreamMux(
      {
        sendControl: (m: StreamControl) =>
          session.send(m.type as 'STREAM_OPEN', m.payload as never, {
            correlationId: `stream-${String(m.payload.streamId)}`,
          }),
        sendData: (frame) => session.sendBinary(frame),
      },
      {
        window: this.#o.window ?? 256 * 1024,
        maxStreams: this.#o.maxStreams ?? 128,
        ...(this.#o.openTimeoutMs === undefined ? {} : { openTimeoutMs: this.#o.openTimeoutMs }),
      },
    );
    const previous = this.#muxes.get(session.workerId);
    previous?.mux.close('shutdown');
    this.#muxes.set(session.workerId, { connectionId: session.connectionId, mux });
    return {
      onControl: (message) => {
        mux.handleControl({ type: message.type, payload: message.payload } as StreamControl);
      },
      onData: (frame) => {
        mux.handleData(frame);
        if (mux.tooManyViolations) {
          this.log.warn({ workerId: session.workerId }, 'worker broke the stream protocol repeatedly');
          return false;
        }
        return true;
      },
      onEnd: () => {
        mux.close('shutdown');
        const current = this.#muxes.get(session.workerId);
        if (current?.connectionId === session.connectionId) this.#muxes.delete(session.workerId);
      },
    };
  }

  /** True when the worker has a live session with a stream plane on this master process and speaks `ide-v1`. */
  has(workerId: string): boolean {
    if (!this.#muxes.has(workerId)) return false;
    const features = this.#features(workerId);
    return features === null || features.includes(IDE_FEATURE);
  }

  /** Opens a stream to `ref` on the worker; rejects with {@link StreamRefusedError}. */
  open(workerId: string, ref: StreamTargetRef): Promise<TunnelStream> {
    const entry = this.#muxes.get(workerId);
    if (entry === undefined || !this.has(workerId))
      return Promise.reject(new StreamRefusedError('unavailable'));
    return entry.mux.open(ref);
  }

  /** Resets every stream of a workspace on its worker (the workspace stopped or access was revoked). */
  resetWorkspace(workerId: string, workspaceId: string): number {
    return this.#muxes.get(workerId)?.mux.resetWorkspace(workspaceId, 'shutdown') ?? 0;
  }

  /** Streams open to one worker (tests, metrics). */
  openStreams(workerId: string): number {
    return this.#muxes.get(workerId)?.mux.size ?? 0;
  }
}
