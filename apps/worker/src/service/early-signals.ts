import type { ShutdownSignals } from '../daemon/signals.js';

/**
 * A stop request can arrive while the daemon is still starting (service manager stop
 * right after a restart, reboot during boot). The daemon only subscribes to shutdown
 * signals inside `WorkerDaemon.start()`, after config/store/key loading; `bin.ts`
 * already swallows the first SIGTERM to implement "second signal forces exit", so an
 * early SIGTERM was lost and systemd had to SIGKILL the daemon after TimeoutStopSec
 * (found by infra/worker/linux/test/systemd-e2e.sh).
 *
 * This wrapper subscribes to the underlying signals immediately, remembers the first
 * request, and replays it to every handler that subscribes later.
 */
export function latchShutdownSignals(inner: ShutdownSignals): ShutdownSignals & {
  readonly requested: string | null;
  close(): void;
} {
  let requested: string | null = null;
  const handlers = new Set<(reason: string) => void>();
  const unsubscribe = inner.onShutdown((reason) => {
    requested ??= reason;
    for (const h of [...handlers]) h(reason);
  });
  return {
    get requested() {
      return requested;
    },
    /** Detach from the underlying signals (after the daemon stopped). */
    close() {
      handlers.clear();
      unsubscribe();
    },
    onShutdown(handler) {
      handlers.add(handler);
      if (requested !== null) {
        const reason = requested;
        // Asynchronously, so the subscriber finishes its own setup first.
        setImmediate(() => {
          if (handlers.has(handler)) handler(reason);
        });
      }
      return () => handlers.delete(handler);
    },
  };
}
