/**
 * p15-services: a small typed in-process hook other master features subscribe to (docs/design/p15-services.md §8).
 *
 * The {@link ServiceRegistry} emits one {@link ServiceEvent} per change it stores (from a worker's SERVICE_STATUS, a
 * person's stop / restart, the sweep):
 *
 *  - `service.url_up`   — the service has a public https URL and is running (quick tunnel URL captured, or a named
 *                         tunnel's connector reports `running`). Emitted again when a quick tunnel's URL changes.
 *  - `service.healthy`  — its health probe passed (first time after a start / restart), or it runs without a probe.
 *  - `service.down`     — it stopped being alive: `unhealthy`, `restarting`, `failed`, `expired`, `stopped`, `refused`.
 *  - `service.removed`  — removed by a person, the assistant or the job that started it.
 *
 * Delivery is best effort and synchronous with the write (a throwing listener is logged and ignored). Durable
 * consumers — p15-watches' `service_url` condition — do not rely on it: the `services` table's trigger (migration 0120)
 * wakes their watches through `remana_watch` (`service:<id>`), on every master replica, after the commit; they read
 * the current state through {@link ServiceRegistry.resolveUrl} (the `ServiceUrlSource` of WatchChecks).
 */

export type ServiceEventKind = 'service.url_up' | 'service.healthy' | 'service.down' | 'service.removed';

export interface ServiceEvent {
  readonly kind: ServiceEventKind;
  readonly serviceId: string;
  readonly project: string;
  readonly workerId: string;
  readonly name: string;
  /** The public URL (`url_up`, and on the others when known). */
  readonly url: string | null;
  /** The reported state after the change (e.g. `running`, `failed`). */
  readonly state: string;
  readonly at: Date;
}

export type ServiceEventListener = (event: ServiceEvent) => void;

export interface ServiceEventFilter {
  readonly kinds?: readonly ServiceEventKind[];
  readonly project?: string;
  readonly serviceId?: string;
}

export class ServiceEvents {
  readonly #listeners = new Set<{ filter: ServiceEventFilter; fn: ServiceEventListener }>();

  constructor(private readonly onError: (err: unknown, event: ServiceEvent) => void = () => undefined) {}

  /** Subscribes; returns the unsubscribe function. */
  subscribe(filter: ServiceEventFilter, fn: ServiceEventListener): () => void {
    const entry = { filter, fn };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  emit(event: ServiceEvent): void {
    for (const { filter, fn } of this.#listeners) {
      if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) continue;
      if (filter.project !== undefined && filter.project !== event.project) continue;
      if (filter.serviceId !== undefined && filter.serviceId !== event.serviceId) continue;
      try {
        fn(event);
      } catch (err) {
        this.onError(err, event);
      }
    }
  }

  get size(): number {
    return this.#listeners.size;
  }
}

/** The events one stored change produces (pure; the registry compares the row before and after). */
export function serviceTransitions(
  before: { state: string; health: string; url: string | null; desired: string } | null,
  after: { state: string; health: string; url: string | null; desired: string },
): ServiceEventKind[] {
  const out: ServiceEventKind[] = [];
  const alive = (s: string) => s === 'running' || s === 'starting';
  const wasUp = before !== null && before.state === 'running' && before.url !== null;
  const isUp = after.state === 'running' && after.url !== null;
  if (isUp && (!wasUp || before.url !== after.url)) out.push('service.url_up');
  const wasHealthy = before !== null && before.state === 'running' && before.health !== 'unhealthy';
  const isHealthy = after.state === 'running' && (after.health === 'healthy' || after.health === 'none');
  if (isHealthy && (!wasHealthy || before.health !== after.health)) out.push('service.healthy');
  const down = ['unhealthy', 'restarting', 'failed', 'expired', 'stopped', 'refused'];
  if (down.includes(after.state) && (before === null || before.state !== after.state)) {
    if (
      before === null ||
      alive(before.state) ||
      before.state === 'unhealthy' ||
      before.state === 'restarting' ||
      before.state === 'pending'
    )
      out.push('service.down');
  }
  if (after.desired === 'removed' && before?.desired !== 'removed') out.push('service.removed');
  return out;
}
