import type { Logger } from '@remyral/observability';

/**
 * p10-claude-login-health (docs/design/p10-claude-login-health.md §3.1): one OAuth-refresh-prone runtime start at a
 * time per subscription login store, across job attempts **and** ops-chat assistant sessions.
 *
 * Claude Code refreshes its OAuth token at the first request after the access token expired (after a sleep / a
 * shutdown it always has). A refresh takes `<config dir>/.oauth_refresh.lock` plus the legacy `<config dir>.lock`
 * and gives up after 5 tries 1–2 s apart (read from the pinned CLI 2.1.296). Live 2026-10-18 the first job after the
 * PC woke failed with "another Claude Code process is refreshing it" while the assistant's Claude Code process (same
 * worker account, same `.claude`) answered fine: the two refreshed at once. p9-subjob-local-login-deadlock made jobs
 * exclusive per store; the assistant was not part of that accounting.
 *
 * The gate is a FIFO mutex per store (`loginStoreOf(runtime)`). A holder takes it right before it starts the runtime
 * process (or sends a turn to a running one) and releases it at the first sign that the runtime talked to the model
 * (its first assistant message / tool call / streamed text) or when the run ends — a refresh, if one was needed, has
 * happened by then. Bounded both ways, so a stuck holder never blocks the store for long:
 *  - `maxHoldMs` (default 60 s, the CLI's own stale threshold for the refresh lock): the hold ends by itself;
 *  - `maxWaitMs` (default 120 s): a waiter proceeds anyway (logged) — degraded to the CLI's own lock, never a hang.
 * Before the hold is handed out the store's `prepare` hook runs (Claude: the stale-lock janitor), so the janitor sees
 * no starting process of the same store. The gate never touches credentials.
 */

export const DEFAULT_LOGIN_GATE_HOLD_MS = 60_000;
export const DEFAULT_LOGIN_GATE_WAIT_MS = 120_000;

export interface LoginGateHold {
  /** Ends the hold (idempotent). `why` is logged when the hold ran long. */
  release(why?: string): void;
  /** How long the holder waited for the gate (ms). */
  readonly waitedMs: number;
}

/** The port job runner and assistant host use (a fake in tests). */
export interface LoginGatePort {
  acquire(store: string, holder: string, signal?: AbortSignal): Promise<LoginGateHold>;
}

export interface LoginStoreGateOptions {
  readonly logger: Logger;
  readonly maxHoldMs?: number;
  readonly maxWaitMs?: number;
  /** Housekeeping before a hold is handed out, per store (never throws through: failures are logged). */
  readonly prepare?:
    | Readonly<Partial<Record<string, () => Promise<void>>>>
    /** p13-runtime-accounts: per store, also for the stores of added accounts (`claude-<id>`). */
    | ((store: string) => (() => Promise<void>) | undefined);
  readonly now?: () => number;
}

export class LoginStoreGate implements LoginGatePort {
  readonly #o: LoginStoreGateOptions;
  readonly #log: Logger;
  /** store → the promise the next waiter waits for (resolves when every earlier holder released). */
  readonly #tails = new Map<string, Promise<void>>();
  /** store → holders currently holding or waiting (diagnostics, tests). */
  readonly #queued = new Map<string, number>();

  constructor(o: LoginStoreGateOptions) {
    this.#o = o;
    this.#log = o.logger.child({ component: 'login-gate' });
  }

  /** Holders currently holding or waiting for `store`. */
  queued(store: string): number {
    return this.#queued.get(store) ?? 0;
  }

  async acquire(store: string, holder: string, signal?: AbortSignal): Promise<LoginGateHold> {
    const now = this.#o.now ?? Date.now;
    const started = now();
    const prev = this.#tails.get(store) ?? Promise.resolve();
    let done!: () => void;
    const mine = new Promise<void>((resolve) => {
      done = resolve;
    });
    // The next waiter waits for this holder *and* every earlier one (a waiter that gave up still counts).
    const tail = Promise.all([prev, mine]).then(() => undefined);
    this.#tails.set(store, tail);
    this.#queued.set(store, this.queued(store) + 1);

    const waited = await waitBounded(prev, this.#o.maxWaitMs ?? DEFAULT_LOGIN_GATE_WAIT_MS, signal);
    if (waited === 'timeout') {
      this.#log.warn('subscription login gate: waited too long, starting anyway', { store, holder });
    }
    const p = this.#o.prepare;
    const prepare = typeof p === 'function' ? p(store) : p?.[store];
    if (prepare !== undefined && waited !== 'aborted') {
      try {
        await prepare();
      } catch (err) {
        this.#log.warn('subscription login gate: housekeeping failed', { store, err });
      }
    }
    const waitedMs = Math.max(0, now() - started);
    let released = false;
    const release = (why?: string): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      done();
      const left = this.queued(store) - 1;
      if (left <= 0) this.#queued.delete(store);
      else this.#queued.set(store, left);
      // The map entry goes once nobody queued behind this holder.
      if (this.#tails.get(store) === tail) this.#tails.delete(store);
      if (why === 'timeout') {
        this.#log.info('subscription login gate: hold ended by its time limit', { store, holder });
      }
    };
    const timer = setTimeout(() => {
      release('timeout');
    }, this.#o.maxHoldMs ?? DEFAULT_LOGIN_GATE_HOLD_MS);
    timer.unref();
    if (waited === 'aborted') release();
    else if (waitedMs > 1_000) this.#log.info('subscription login gate taken', { store, holder, waitedMs });
    return { release, waitedMs };
  }
}

async function waitBounded(
  p: Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<'ok' | 'timeout' | 'aborted'> {
  if (signal?.aborted === true) return 'aborted';
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      p.then(() => 'ok' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, ms);
        timer.unref();
      }),
      new Promise<'aborted'>((resolve) => {
        onAbort = () => {
          resolve('aborted');
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}

/** A gate that never waits (tests, a worker without subscription logins). */
export const OPEN_LOGIN_GATE: LoginGatePort = {
  acquire: () => Promise.resolve({ release: () => undefined, waitedMs: 0 }),
};
