/** Source of "please shut down" requests. Injectable so tests can trigger shutdown. */
export interface ShutdownSignals {
  /** Registers `handler`; returns an unsubscribe function. */
  onShutdown(handler: (reason: string) => void): () => void;
}

/**
 * Process signals for the daemon:
 *  - POSIX: SIGTERM (systemd/launchd stop) and SIGINT (Ctrl-C).
 *  - Windows: SIGINT (Ctrl-C) and SIGBREAK (Ctrl-Break / console close).
 *    A Windows *Service* receives SERVICE_CONTROL_STOP from the SCM, not a signal;
 *    the service wrapper (p2-service-windows) must translate it into a call of the
 *    `requestStop` hook returned here — PLACEHOLDER, UNVERIFIED until then.
 */
export function nodeShutdownSignals(platform: NodeJS.Platform = process.platform): ShutdownSignals & {
  requestStop(reason: string): void;
} {
  const handlers = new Set<(reason: string) => void>();
  const signals: NodeJS.Signals[] = platform === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
  const fire = (reason: string) => {
    for (const h of handlers) h(reason);
  };
  const listeners = signals.map((signal) => {
    const listener = () => {
      fire(signal);
    };
    return { signal, listener };
  });
  return {
    onShutdown(handler) {
      if (handlers.size === 0) for (const { signal, listener } of listeners) process.on(signal, listener);
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) for (const { signal, listener } of listeners) process.off(signal, listener);
      };
    },
    requestStop: fire,
  };
}

/** Test double. */
export class ManualSignals implements ShutdownSignals {
  readonly #handlers = new Set<(reason: string) => void>();
  onShutdown(handler: (reason: string) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
  trigger(reason = 'SIGTERM'): void {
    for (const h of this.#handlers) h(reason);
  }
  get listenerCount(): number {
    return this.#handlers.size;
  }
}
