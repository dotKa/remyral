import type { Logger } from '@remyral/observability';
import type { LoginReport, LoginRuntime } from '@remyral/protocol';

/**
 * p10-claude-login-health (docs/design/p10-claude-login-health.md §3.3): the subscription login recovers by itself.
 *
 *  - **Re-check while signed out.** Every `recheckMs` (default 10 min) each login this worker flagged unusable is
 *    checked again (`LoginManager.check`: status command, then a minimal real request): usable → the flag is gone and
 *    CAPABILITIES go out at once, so queued jobs waiting for the login start without anyone pressing Check.
 *  - **Wake / resume.** A ticker every `tickMs` (30 s) notices when much more wall-clock time passed than it slept
 *    (the machine was asleep or off and the process was frozen): it runs `onWake` (the stale-lock janitor for the
 *    Claude login store) and re-checks the flagged logins right away.
 *
 * Only flagged logins are probed, so a healthy machine never sends a probe request.
 */
export interface LoginHealthLogin {
  expiredRuntimes(): LoginRuntime[];
  check(runtime: LoginRuntime, account?: string): Promise<LoginReport>;
  isExpired(runtime: LoginRuntime, account?: string): boolean;
  /** p13-runtime-accounts: every flagged login (runtime × account); absent: only `expiredRuntimes`. */
  expiredLogins?(): { runtime: LoginRuntime; account: string }[];
}

export interface LoginHealthOptions {
  readonly login: LoginHealthLogin;
  readonly logger: Logger;
  /** The login state changed (re-send CAPABILITIES). */
  readonly onChanged: () => void;
  /** Housekeeping after a wake (stale lock cleanup). Failures are logged. */
  readonly onWake?: () => Promise<void>;
  readonly recheckMs?: number;
  readonly tickMs?: number;
  /** Extra wall-clock time over a tick that counts as a wake (default 2 min). */
  readonly wakeGapMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_LOGIN_RECHECK_MS = 10 * 60_000;

export class LoginHealthMonitor {
  readonly #o: LoginHealthOptions;
  readonly #log: Logger;
  #timer: NodeJS.Timeout | null = null;
  #lastTick = 0;
  #lastRecheck = 0;
  #running: Promise<void> | null = null;

  constructor(o: LoginHealthOptions) {
    this.#o = o;
    this.#log = o.logger.child({ component: 'login-health' });
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#lastTick = this.#now();
    this.#lastRecheck = this.#lastTick;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#o.tickMs ?? 30_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One ticker step (exposed for tests). Never throws; never overlaps itself. */
  async tick(): Promise<void> {
    if (this.#running !== null) return this.#running;
    const run = this.#tick().finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return run;
  }

  async #tick(): Promise<void> {
    const now = this.#now();
    const gap = now - this.#lastTick - (this.#o.tickMs ?? 30_000);
    this.#lastTick = now;
    const woke = gap >= (this.#o.wakeGapMs ?? 2 * 60_000);
    if (woke) {
      this.#log.info('the machine resumed (clock gap); checking the subscription logins', {
        gapMinutes: Math.round(gap / 60_000),
      });
      try {
        await this.#o.onWake?.();
      } catch (err) {
        this.#log.warn('wake housekeeping failed', { err });
      }
    }
    const due = now - this.#lastRecheck >= (this.#o.recheckMs ?? DEFAULT_LOGIN_RECHECK_MS);
    if (!woke && !due) return;
    this.#lastRecheck = now;
    await this.recheck();
  }

  /** Re-checks every flagged login now; reports a change. */
  async recheck(): Promise<void> {
    let changed = false;
    const logins =
      this.#o.login.expiredLogins?.() ??
      this.#o.login.expiredRuntimes().map((runtime) => ({ runtime, account: 'default' }));
    for (const { runtime, account } of logins) {
      const acc = account === 'default' ? undefined : account;
      try {
        await this.#o.login.check(runtime, acc);
      } catch (err) {
        this.#log.warn('login re-check failed', { runtime, account, err });
        continue;
      }
      if (!this.#o.login.isExpired(runtime, acc)) {
        this.#log.info('subscription login usable again (background re-check)', { runtime, account });
        changed = true;
      }
    }
    if (changed) this.#o.onChanged();
  }
}
