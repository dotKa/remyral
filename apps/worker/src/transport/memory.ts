import type { WorkerToMaster } from '@remyral/protocol';
import type { TransportEvent, TransportEventHandler, TransportPort, TransportStartOptions } from './port.js';

/**
 * In-memory transport for tests: the test plays the master by calling `emit`,
 * and inspects what the daemon sent in `sent`.
 */
export class MemoryTransport implements TransportPort {
  readonly sent: WorkerToMaster[] = [];
  startOptions: TransportStartOptions | null = null;
  started = false;
  stopped = false;
  connected = false;
  #onEvent: TransportEventHandler | null = null;

  start(options: TransportStartOptions, onEvent: TransportEventHandler): Promise<void> {
    if (this.started) return Promise.reject(new Error('transport already started'));
    this.started = true;
    this.startOptions = options;
    this.#onEvent = onEvent;
    return Promise.resolve();
  }

  send(message: WorkerToMaster): Promise<void> {
    if (!this.connected || this.stopped) return Promise.reject(new Error('not connected'));
    this.sent.push(message);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    return Promise.resolve();
  }

  /** Deliver an event to the daemon as the network layer would. */
  emit(event: TransportEvent): void {
    if (this.#onEvent === null) throw new Error('transport not started');
    if (this.stopped) return;
    if (event.kind === 'connected') this.connected = true;
    if (event.kind === 'disconnected') this.connected = false;
    void this.#onEvent(event);
  }
}

/**
 * Transport used by `remyral-worker run` until p2-transport lands: it never
 * connects, so the daemon truthfully stays `offline`.
 */
export class UnimplementedTransport implements TransportPort {
  start(): Promise<void> {
    return Promise.resolve();
  }
  send(): Promise<void> {
    return Promise.reject(new Error('network transport not implemented yet (p2-transport)'));
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}
