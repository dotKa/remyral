import type { RuntimeUsageReading } from '@remyral/agent-adapters';
import type { Logger } from '@remyral/observability';
import {
  accountStoreId,
  DEFAULT_ACCOUNT_ID,
  dropExpiredWindows,
  MAX_REFRESH_SNAPSHOTS,
  MAX_USAGE_SNAPSHOTS,
  mergeUsageWindows,
  type RuntimeKind,
  type RuntimeUsageAuth,
  type RuntimeUsageReport,
  type RuntimeUsageSnapshot,
  type RuntimeUsageSource,
  RuntimeUsageWindow,
  type UsageIdentity,
  type UsageRefreshReport,
} from '@remyral/protocol';
import { loginStoreOf } from '../sandbox/login-stores.js';
import type { LoginGatePort } from './login-gate.js';

/**
 * p11-limit-visibility (docs/design/p11-limit-visibility.md §3): the worker's view of its runtimes' usage-limit windows,
 * per runtime × auth (subscription login store or API key).
 *
 *  - **Passive:** job sessions and assistant turns report what the runtime said (`SpawnContext.onUsage`,
 *    `AssistantSessionOptions.onUsage`) — Claude `rate_limit_event`, Codex `account/rateLimits/updated`. Sparse
 *    readings are merged into the last known windows.
 *  - **Probe:** every `probeIntervalMs` (default 10 min) each subscription-login runtime whose adapter offers
 *    `readUsage` (Codex `account/rateLimits/read`, Claude Code `/usage` data — read-only, no model request) is read,
 *    under the login store's gate (a CLI start may refresh the OAuth token); while the store's last probe failed it
 *    backs off ×2 up to 1 h. p15-usage-refresh: a passive reading no longer postpones it (passive readings are partial:
 *    Claude reports a window only when its state changes), a finished job / chat turn asks for a probe of its login
 *    soon (`afterRun`, at most one per login per {@link AFTER_RUN_GAP_MS}), and `refresh()` probes now (the remote op
 *    `usage.refresh`). A probe also names the login's provider account (`identity`, hashed); passive readings keep the
 *    last known one.
 *  - **Report:** HEARTBEAT `runtimeUsage` carries the snapshots that changed since the last heartbeat, and all of them
 *    every `refreshMs` (default 15 min) and after a reconnect. Bounded (≤ 8 snapshots of ≤ 12 windows).
 *
 * Never reads credential files; values only (no account ids, no tokens).
 */

export interface UsageReader {
  readUsage?(opts: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeUsageReading | null>;
}

/**
 * p13-runtime-accounts: one subscription login the probe reads — the configured one (`default`, the runtime's own
 * store) or an added account (its store and its own reader bound to its config dir).
 */
export interface UsageLogin {
  readonly runtime: RuntimeKind;
  readonly account: string;
  readonly store: string;
}

export interface RuntimeUsageCollectorOptions {
  readonly logger: Logger;
  /** Runtimes that run with the worker's own subscription login (`local-login`) now. */
  readonly localLogin: () => readonly RuntimeKind[];
  /** The long-lived reference adapter of a runtime (null: not available). */
  readonly reader: (runtime: RuntimeKind) => UsageReader | null;
  /**
   * p13-runtime-accounts: the added subscription accounts to probe besides `localLogin` (each with its own reader).
   * Absent: only the configured logins.
   */
  readonly accounts?: () => readonly (UsageLogin & { readonly reader: () => UsageReader | null })[];
  readonly gate?: LoginGatePort;
  readonly probeIntervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly refreshMs?: number;
  /** Ticker period (default 60 s). */
  readonly tickMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_USAGE_PROBE_MS = 10 * 60_000;
export const DEFAULT_USAGE_REFRESH_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/** p15-usage-refresh: the shortest gap between a probe of a login and a post-run probe of it. */
export const AFTER_RUN_GAP_MS = 2 * 60_000;
/** p15-usage-refresh: a post-run round starts this long after the run (its last events go first). */
const AFTER_RUN_DELAY_MS = 20_000;

interface Entry {
  snapshot: RuntimeUsageSnapshot;
  dirty: boolean;
  lastSentAt: number;
}

interface ProbeState {
  lastAttemptAt: number;
  backoffMs: number;
  /** p15-usage-refresh: a job / chat turn of this login ended since its last probe. */
  afterRun: boolean;
}

/** p15-usage-refresh: which logins `refresh()` reads (absent fields: all). */
export interface UsageRefreshFilter {
  readonly runtime?: RuntimeKind;
  readonly account?: string;
}

type ProbeLogin = UsageLogin & { readonly reader: () => UsageReader | null };

export class RuntimeUsageCollector {
  readonly #o: RuntimeUsageCollectorOptions;
  readonly #log: Logger;
  readonly #entries = new Map<string, Entry>();
  /** runtime#account → probe state. */
  readonly #probes = new Map<string, ProbeState>();
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #soon: NodeJS.Timeout | null = null;

  constructor(o: RuntimeUsageCollectorOptions) {
    this.#o = o;
    this.#log = o.logger.child({ component: 'runtime-usage' });
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** The hook a job / assistant session gets for `runtime` running with `auth`. */
  observer(
    runtime: RuntimeKind,
    auth: RuntimeUsageAuth,
    source: Exclude<RuntimeUsageSource, 'probe'>,
    /** p13-runtime-accounts: the runtime account (absent = `default`). */
    account?: string,
  ): (reading: RuntimeUsageReading) => void {
    return (reading) => {
      this.observe(runtime, auth, source, reading, account);
    };
  }

  /** Merge one reading. Invalid windows are dropped (never thrown). */
  observe(
    runtime: RuntimeKind,
    auth: RuntimeUsageAuth,
    source: RuntimeUsageSource,
    reading: RuntimeUsageReading,
    account: string = DEFAULT_ACCOUNT_ID,
  ): void {
    const key = entryKey(runtime, auth, account);
    const now = this.#now();
    const windows = reading.windows.filter((w) => RuntimeUsageWindow.safeParse(w).success);
    const prev = this.#entries.get(key);
    // Bounded: 2 runtimes × (1 + 8 accounts) × 2 auths at most in practice; a hard cap guards a bad config.
    if (prev === undefined && this.#entries.size >= MAX_ENTRIES) return;
    const merged =
      prev === undefined || !reading.partial ? windows : mergeUsageWindows(prev.snapshot.windows, windows);
    const plan = reading.plan ?? prev?.snapshot.plan;
    // p15-usage-refresh: only probes name the account; passive readings keep the last known identity.
    const identity: UsageIdentity | undefined =
      auth === 'subscription' ? (reading.identity ?? prev?.snapshot.identity) : undefined;
    const snapshot: RuntimeUsageSnapshot = {
      runtime,
      auth,
      ...(auth === 'subscription' ? { store: accountStoreId(runtime, account) } : {}),
      // p13-runtime-accounts: only added accounts are named (older masters see the same snapshots as before).
      ...(account === DEFAULT_ACCOUNT_ID ? {} : { account }),
      source,
      observedAt: new Date(now).toISOString(),
      ...(plan === undefined ? {} : { plan }),
      available: reading.available,
      windows: merged,
      ...(identity === undefined ? {} : { identity }),
    };
    const changed =
      prev === undefined ||
      JSON.stringify({ ...prev.snapshot, observedAt: '', source: '' }) !==
        JSON.stringify({ ...snapshot, observedAt: '', source: '' });
    this.#entries.set(key, {
      snapshot,
      // An unchanged reading still refreshes "last updated" at the next refresh, not at once.
      dirty: (prev?.dirty ?? false) || changed,
      lastSentAt: prev?.lastSentAt ?? 0,
    });
  }

  /** Snapshots for the next HEARTBEAT: the changed ones, or all when the refresh is due; undefined when none. */
  pending(): RuntimeUsageReport | undefined {
    const now = this.#now();
    const refresh = this.#o.refreshMs ?? DEFAULT_USAGE_REFRESH_MS;
    const out: RuntimeUsageSnapshot[] = [];
    // p13-runtime-accounts: more logins than one heartbeat carries: the oldest-sent go first, the rest next time.
    const due = [...this.#entries.values()]
      .filter((e) => e.dirty || now - e.lastSentAt >= refresh)
      .sort((a, b) => a.lastSentAt - b.lastSentAt);
    for (const e of due.slice(0, MAX_USAGE_SNAPSHOTS)) {
      out.push({ ...e.snapshot, windows: dropExpiredWindows(e.snapshot.windows, new Date(now)) });
    }
    return out.length === 0 ? undefined : out;
  }

  /** The heartbeat with `report` went out. */
  sent(report: RuntimeUsageReport): void {
    const now = this.#now();
    for (const s of report) {
      const e = this.#entries.get(entryKey(s.runtime, s.auth, s.account ?? DEFAULT_ACCOUNT_ID));
      if (e === undefined) continue;
      if (e.snapshot.observedAt === s.observedAt) e.dirty = false;
      e.lastSentAt = now;
    }
  }

  /** A new session with the master: send everything again with the next heartbeat. */
  resendAll(): void {
    for (const e of this.#entries.values()) e.dirty = true;
  }

  /** Last known snapshots (diagnostics, tests). */
  snapshots(): RuntimeUsageSnapshot[] {
    return [...this.#entries.values()].map((e) => e.snapshot);
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#o.tickMs ?? 60_000);
    this.#timer.unref();
    // First probe soon after start (not at once: CAPABILITIES and the first jobs go first).
    setTimeout(() => {
      void this.tick();
    }, 15_000).unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#soon !== null) clearTimeout(this.#soon);
    this.#soon = null;
  }

  /**
   * p15-usage-refresh: a job or chat turn of `runtime` / `account` ended. A subscription login is probed at the next
   * round at least {@link AFTER_RUN_GAP_MS} after its last probe; while the collector runs, a round starts shortly.
   * API-key runs are not probed (nothing free to read).
   */
  afterRun(runtime: RuntimeKind, auth: RuntimeUsageAuth, account: string = DEFAULT_ACCOUNT_ID): void {
    if (auth !== 'subscription') return;
    const key = `${runtime}#${account}`;
    const state = this.#probes.get(key) ?? { lastAttemptAt: 0, backoffMs: 0, afterRun: false };
    state.afterRun = true;
    this.#probes.set(key, state);
    if (this.#timer === null || this.#soon !== null) return;
    this.#soon = setTimeout(() => {
      this.#soon = null;
      void this.tick();
    }, AFTER_RUN_DELAY_MS);
    this.#soon.unref();
  }

  /**
   * p15-usage-refresh: read the matching subscription logins now (the remote op `usage.refresh`), regardless of the
   * routine interval and back-off; waits for a running round first, never overlaps one. Never throws.
   */
  async refresh(filter: UsageRefreshFilter = {}): Promise<UsageRefreshReport> {
    while (this.#running !== null) await this.#running.catch(() => undefined);
    const results: UsageRefreshReport['results'][number][] = [];
    const run = (async () => {
      for (const login of this.#logins()) {
        if (filter.runtime !== undefined && login.runtime !== filter.runtime) continue;
        if (filter.account !== undefined && login.account !== filter.account) continue;
        const reader = login.reader();
        if (reader?.readUsage === undefined) {
          results.push({ runtime: login.runtime, account: login.account, outcome: 'no_probe' });
          continue;
        }
        const ok = await this.#probeLogin(login, reader);
        results.push({ runtime: login.runtime, account: login.account, outcome: ok ? 'read' : 'failed' });
      }
    })();
    const tracked = run.finally(() => {
      this.#running = null;
    });
    this.#running = tracked;
    await tracked;
    const now = new Date(this.#now());
    const snapshots = results
      .flatMap((r) => {
        const e = this.#entries.get(entryKey(r.runtime, 'subscription', r.account));
        return e === undefined
          ? []
          : [{ ...e.snapshot, windows: dropExpiredWindows(e.snapshot.windows, now) }];
      })
      .slice(0, MAX_REFRESH_SNAPSHOTS);
    return { results: results.slice(0, 32), snapshots };
  }

  /** One probe round (exposed for tests). Never throws; never overlaps itself. */
  async tick(): Promise<void> {
    if (this.#running !== null) return this.#running;
    const run = this.#tick().finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return run;
  }

  /** The subscription logins to probe: the configured ones (`default`) and the added accounts. */
  #logins(): ProbeLogin[] {
    return [
      ...this.#o.localLogin().map((runtime) => ({
        runtime,
        account: DEFAULT_ACCOUNT_ID,
        store: loginStoreOf(runtime),
        reader: () => this.#o.reader(runtime),
      })),
      ...(this.#o.accounts?.() ?? []),
    ];
  }

  async #tick(): Promise<void> {
    const interval = this.#o.probeIntervalMs ?? DEFAULT_USAGE_PROBE_MS;
    for (const login of this.#logins()) {
      const state = this.#probes.get(`${login.runtime}#${login.account}`);
      const since = this.#now() - (state?.lastAttemptAt ?? 0);
      const routine = since >= Math.max(interval, state?.backoffMs ?? 0);
      const afterRun = state?.afterRun === true && since >= AFTER_RUN_GAP_MS;
      if (!routine && !afterRun) continue;
      const reader = login.reader();
      if (reader?.readUsage === undefined) continue;
      await this.#probeLogin(login, reader);
    }
  }

  /** One probe of one login: its probe state and the readings. True when it read something. */
  async #probeLogin(login: ProbeLogin, reader: UsageReader): Promise<boolean> {
    const interval = this.#o.probeIntervalMs ?? DEFAULT_USAGE_PROBE_MS;
    const probeKey = `${login.runtime}#${login.account}`;
    const state = this.#probes.get(probeKey) ?? { lastAttemptAt: 0, backoffMs: 0, afterRun: false };
    state.lastAttemptAt = this.#now();
    state.afterRun = false;
    this.#probes.set(probeKey, state);
    const reading = await this.#probe(login.runtime, reader, login.store);
    if (reading === null) {
      state.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(interval, state.backoffMs * 2));
      return false;
    }
    state.backoffMs = 0;
    this.observe(login.runtime, 'subscription', 'probe', reading, login.account);
    return true;
  }

  /** p13-runtime-accounts: forget the readings of a removed account. */
  forget(runtime: RuntimeKind, account: string): void {
    for (const auth of ['subscription', 'api_key'] as const)
      this.#entries.delete(entryKey(runtime, auth, account));
    this.#probes.delete(`${runtime}#${account}`);
  }

  async #probe(
    runtime: RuntimeKind,
    reader: UsageReader,
    store: string = loginStoreOf(runtime),
  ): Promise<RuntimeUsageReading | null> {
    const timeoutMs = this.#o.probeTimeoutMs ?? 60_000;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
    }, timeoutMs + 5_000);
    const hold = await this.#o.gate?.acquire(store, 'usage-probe', abort.signal).catch(() => null);
    try {
      return (await reader.readUsage?.({ timeoutMs, signal: abort.signal })) ?? null;
    } catch (err) {
      this.#log.debug('usage probe failed', { runtime, err });
      return null;
    } finally {
      clearTimeout(timer);
      hold?.release('usage probe done');
    }
  }
}

/** Entries are kept per runtime × auth × account (p13-runtime-accounts; `default` keeps the earlier key). */
function entryKey(runtime: RuntimeKind, auth: RuntimeUsageAuth, account: string): string {
  return account === DEFAULT_ACCOUNT_ID ? `${runtime}:${auth}` : `${runtime}:${auth}:${account}`;
}

/** Upper bound of tracked snapshots (a heartbeat still carries at most MAX_USAGE_SNAPSHOTS). */
const MAX_ENTRIES = 40;
