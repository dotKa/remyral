/**
 * p22-ops-hygiene (docs/design/p22-ops-hygiene.md): one shared view of whether Redis and Postgres answer, so a
 * dependency outage is one warning (when it goes down) and one info line (when it is back) — not a thousand error
 * lines from fifteen independent background sweeps, and not a storm of "unhandled error" 500s.
 *
 * - A sweep error that looks like a dependency failure ({@link dependencyOf}) is confirmed with a probe (PING /
 *   SELECT 1, bounded); only a failed probe marks the dependency down — a misclassified error is logged as before.
 * - While a dependency is down, a sweep that failed on it is skipped (one debug line per outage) until a probe
 *   succeeds. Probes back off exponentially (1 s … 30 s) while it stays down.
 * - {@link DependencyUnavailableError} is what a fail-closed caller (the Redis rate limiter) throws; the HTTP error
 *   handler answers it with 503 + Retry-After instead of a logged 500.
 */

export type Dependency = 'redis' | 'postgres';

export class DependencyUnavailableError extends Error {
  override name = 'DependencyUnavailableError';
  constructor(
    readonly dependency: Dependency,
    message: string,
  ) {
    super(message);
  }
}

export interface HealthLog {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Postgres SQLSTATEs of a server that is gone, starting, shutting down or out of connections. */
const PG_CODES = new Set(['57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006', '53300']);
const NET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'EAI_AGAIN']);
const PG_MESSAGE =
  /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|the database system is (?:starting up|shutting down|in recovery mode)/;
/** ioredis while disconnected (enableOfflineQueue off, maxRetriesPerRequest) and our own bounded waits. */
const REDIS_MESSAGE =
  /\bRedis\b|Stream isn't writeable|enableOfflineQueue|Reached the max retries per request/;

/** Which dependency an error says is unreachable (null: none / not recognisable). Follows `cause` a few levels. */
export function dependencyOf(err: unknown, depth = 0): Dependency | null {
  if (!(err instanceof Error) || depth > 3) return null;
  if (err instanceof DependencyUnavailableError) return err.dependency;
  const code = (err as { code?: unknown }).code;
  if (err.name === 'MaxRetriesPerRequestError' || REDIS_MESSAGE.test(err.message)) return 'redis';
  if (typeof code === 'string' && PG_CODES.has(code)) return 'postgres';
  if (PG_MESSAGE.test(err.message)) return 'postgres';
  if (typeof code === 'string' && NET_CODES.has(code)) {
    const port = (err as { port?: unknown }).port;
    if (port === 6379) return 'redis';
    if (port === 5432) return 'postgres';
  }
  if (err instanceof AggregateError) {
    for (const e of err.errors) {
      const d = dependencyOf(e, depth + 1);
      if (d !== null) return d;
    }
  }
  const cause = (err as { cause?: unknown }).cause;
  return cause === undefined ? null : dependencyOf(cause, depth + 1);
}

export interface DependencyHealthOptions {
  readonly log: HealthLog;
  /** How to ask each dependency (PING, SELECT 1). A dependency without a probe is trusted to be down on the error. */
  readonly probes?: Partial<Record<Dependency, () => Promise<unknown>>>;
  /** Milliseconds clock (tests). */
  readonly now?: () => number;
  /** A probe without an answer within this counts as failed. Default 1 s. */
  readonly probeTimeoutMs?: number;
  /** Probe backoff while down: min · 2^(failures−1), at most max. Defaults 1 s / 30 s. */
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

interface DepState {
  down: boolean;
  since: number;
  failures: number;
  nextProbeAt: number;
  probing: Promise<boolean> | null;
}

export class DependencyHealth {
  readonly #o: DependencyHealthOptions;
  readonly #now: () => number;
  readonly #state = new Map<Dependency, DepState>();
  /** sweep name → the dependency it last failed on (cleared when that dependency is back). */
  readonly #blocked = new Map<string, Dependency>();
  /** sweeps whose skip was logged in the current outage. */
  readonly #skipLogged = new Set<string>();

  constructor(opts: DependencyHealthOptions) {
    this.#o = opts;
    this.#now = opts.now ?? Date.now;
  }

  #s(dep: Dependency): DepState {
    let s = this.#state.get(dep);
    if (s === undefined) {
      s = { down: false, since: 0, failures: 0, nextProbeAt: 0, probing: null };
      this.#state.set(dep, s);
    }
    return s;
  }

  isDown(dep: Dependency): boolean {
    return this.#state.get(dep)?.down === true;
  }

  /** Dependencies that are down now (diagnostics, tests). */
  down(): Dependency[] {
    return [...this.#state.entries()].filter(([, s]) => s.down).map(([d]) => d);
  }

  #backoff(failures: number): number {
    const min = this.#o.minBackoffMs ?? 1_000;
    const max = this.#o.maxBackoffMs ?? 30_000;
    return Math.min(max, min * 2 ** Math.max(0, Math.min(failures, 20) - 1));
  }

  /** Marks `dep` down (one warning on the transition). */
  markDown(dep: Dependency, err?: unknown): void {
    const s = this.#s(dep);
    const t = this.#now();
    s.failures += 1;
    s.nextProbeAt = t + this.#backoff(s.failures);
    if (s.down) return;
    s.down = true;
    s.since = t;
    this.#skipLogged.clear();
    this.#o.log.warn(
      { dependency: dep, err: err instanceof Error ? err.message.slice(0, 300) : undefined },
      `${dep} unavailable; background work that needs it is paused until it answers again`,
    );
  }

  /** Marks `dep` up (one info line on the transition) and lets the sweeps that waited for it run again. */
  markUp(dep: Dependency): void {
    const s = this.#s(dep);
    s.failures = 0;
    s.nextProbeAt = 0;
    if (!s.down) return;
    s.down = false;
    for (const [name, d] of this.#blocked) if (d === dep) this.#blocked.delete(name);
    this.#o.log.info({ dependency: dep, downMs: this.#now() - s.since }, `${dep} available again`);
  }

  /**
   * Asks `dep` now (one probe at a time). True: it answered (marked up). Without a probe: true once its backoff
   * elapsed (the next real call decides).
   */
  probe(dep: Dependency): Promise<boolean> {
    const s = this.#s(dep);
    if (s.probing !== null) return s.probing;
    const fn = this.#o.probes?.[dep];
    if (fn === undefined) return Promise.resolve(!s.down || this.#now() >= s.nextProbeAt);
    const ms = this.#o.probeTimeoutMs ?? 1_000;
    let timer: NodeJS.Timeout | undefined;
    const attempt = Promise.race([
      fn().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, ms);
        timer.unref();
      }),
    ])
      .catch(() => false)
      .then((ok) => {
        clearTimeout(timer);
        if (ok) this.markUp(dep);
        else if (s.down) {
          s.failures += 1;
          s.nextProbeAt = this.#now() + this.#backoff(s.failures);
        }
        return ok;
      })
      .finally(() => {
        s.probing = null;
      });
    s.probing = attempt;
    return attempt;
  }

  /** Probes every down dependency whose backoff elapsed (the background loop). */
  async probeDue(): Promise<void> {
    const t = this.#now();
    const due = [...this.#state.entries()].filter(([, s]) => s.down && t >= s.nextProbeAt).map(([d]) => d);
    await Promise.all(due.map((d) => this.probe(d)));
  }

  /**
   * Whether `err` is a dependency outage (confirmed by a failed probe, or the dependency already down). Marks it
   * down and returns the dependency; null when the error is something else (log it as before).
   */
  async report(err: unknown): Promise<Dependency | null> {
    const dep = dependencyOf(err);
    if (dep === null) return null;
    if (this.isDown(dep)) return dep;
    const fn = this.#o.probes?.[dep];
    if (fn !== undefined && (await this.probe(dep))) return null;
    this.markDown(dep, err);
    return dep;
  }

  /**
   * Runs one pass of a background sweep through the gate: skipped (one debug line per outage) while the dependency
   * it last failed on is down; a dependency failure is absorbed (debug) — anything else is rethrown.
   */
  async run<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    const waiting = this.#blocked.get(name);
    if (waiting !== undefined && this.isDown(waiting)) {
      const s = this.#s(waiting);
      const back = this.#now() >= s.nextProbeAt && (await this.probe(waiting));
      if (!back) {
        if (!this.#skipLogged.has(name)) {
          this.#skipLogged.add(name);
          this.#o.log.debug({ sweep: name, dependency: waiting }, 'sweep skipped: dependency unavailable');
        }
        return undefined;
      }
    }
    try {
      const out = await fn();
      if (waiting !== undefined) {
        this.#blocked.delete(name);
        // A dependency without a probe is back when a sweep that waited for it succeeds.
        if (this.#o.probes?.[waiting] === undefined) this.markUp(waiting);
      }
      return out;
    } catch (err) {
      const dep = await this.report(err);
      if (dep === null) throw err;
      this.#blocked.set(name, dep);
      this.#o.log.debug({ sweep: name, dependency: dep }, 'sweep failed: dependency unavailable');
      return undefined;
    }
  }

  /**
   * The `onError` of a self-scheduled loop (`service.start(ms, onError)`): a dependency failure is one debug line
   * (the transition is the warning); anything else goes to `fallback` as before.
   */
  onError(name: string, fallback: (err: unknown) => void): (err: unknown) => void {
    return (err: unknown) => {
      void this.report(err).then(
        (dep) => {
          if (dep === null) fallback(err);
          else this.#o.log.debug({ sweep: name, dependency: dep }, 'sweep failed: dependency unavailable');
        },
        () => {
          fallback(err);
        },
      );
    };
  }

  /** Background probing of down dependencies; returns a stop function. */
  start(intervalMs = 1_000): () => void {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.probeDue().finally(() => {
        busy = false;
      });
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }
}
