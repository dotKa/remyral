import type { GitHubAppAuth } from './github-app.js';

/**
 * p22-github-rate (docs/design/p22-github-rate.md): what the master knows about one GitHub App installation's
 * request budget, shared by every provider of that installation (all projects on one installation spend the same
 * budget). Two jobs:
 *
 * - **Pause while limited.** A rate-limited answer (429, 403 with `x-ratelimit-remaining: 0`, or a secondary limit's
 *   `retry-after`) pauses every request of the installation until the reset GitHub names; requests in the pause fail
 *   at once without reaching GitHub, so a busy loop no longer keeps the limit exhausted.
 * - **Keep a reserve for work that cannot wait.** Background re-checks (the merge-state refresh of jobs awaiting
 *   approval) stop while the remaining budget is below the reserve, so a job's base capture, verification and merges
 *   still find budget.
 */
export class ApiRateBudget {
  #limit: number | null = null;
  #remaining: number | null = null;
  #resetAt = 0;
  #pausedUntil = 0;

  /**
   * Records the rate headers of an answer; true when the answer itself is a rate limit. GitHub sends
   * `x-ratelimit-limit / -remaining / -reset`, GitLab `ratelimit-limit / -remaining / -reset` (p22-harness-gaps);
   * both may send `retry-after` (seconds). Bitbucket only answers 429.
   */
  note(status: number, headers: Headers, nowMs: number): boolean {
    const h = (name: string): string | null => headers.get(`x-${name}`) ?? headers.get(name);
    const limit = Number(h('ratelimit-limit') ?? '');
    const remaining = Number(h('ratelimit-remaining') ?? '');
    const reset = Number(h('ratelimit-reset') ?? '');
    if (h('ratelimit-limit') !== null && Number.isFinite(limit) && limit > 0) this.#limit = limit;
    if (h('ratelimit-remaining') !== null && Number.isFinite(remaining)) this.#remaining = remaining;
    if (h('ratelimit-reset') !== null && Number.isFinite(reset) && reset > 0) this.#resetAt = reset * 1000;
    const retryAfter = Number(headers.get('retry-after') ?? '');
    const hasRetryAfter =
      headers.get('retry-after') !== null && Number.isFinite(retryAfter) && retryAfter >= 0;
    const limited = status === 429 || (status === 403 && (h('ratelimit-remaining') === '0' || hasRetryAfter));
    if (!limited) return false;
    const until = hasRetryAfter
      ? nowMs + retryAfter * 1000
      : this.#resetAt > nowMs
        ? this.#resetAt
        : nowMs + DEFAULT_PAUSE_MS;
    // A clock skew or a bogus header never pauses longer than an hour.
    this.#pausedUntil = Math.max(this.#pausedUntil, Math.min(until, nowMs + MAX_PAUSE_MS));
    return true;
  }

  /** Until when requests are paused (ms epoch), or null when they are not. */
  pausedUntil(nowMs: number): number | null {
    return this.#pausedUntil > nowMs ? this.#pausedUntil : null;
  }

  /** True while paused, or while the known remaining budget of the current window is below the reserve. */
  low(nowMs: number): boolean {
    if (this.pausedUntil(nowMs) !== null) return true;
    if (this.#remaining === null || this.#limit === null) return false;
    if (this.#resetAt !== 0 && this.#resetAt <= nowMs) return false; // the window has reset since
    return this.#remaining < reserveOf(this.#limit);
  }
}

/** Pause when GitHub names no reset. */
const DEFAULT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 60 * 60_000;

/** The part of an installation's hourly budget kept for work that cannot wait: a fifth, at least 200 requests. */
export function reserveOf(limit: number): number {
  return Math.max(200, Math.floor(limit / 5));
}

const budgets = new WeakMap<GitHubAppAuth, Map<number, ApiRateBudget>>();

/** The budget of `installationId` of the App behind `auth` (one per App and installation in this process). */
export function rateBudgetOf(auth: GitHubAppAuth, installationId: number): ApiRateBudget {
  let perApp = budgets.get(auth);
  if (perApp === undefined) {
    perApp = new Map();
    budgets.set(auth, perApp);
  }
  let b = perApp.get(installationId);
  if (b === undefined) {
    b = new ApiRateBudget();
    perApp.set(installationId, b);
  }
  return b;
}

const hostBudgets = new Map<string, ApiRateBudget>();

/**
 * p22-harness-gaps: the budget of one GitLab / Bitbucket connection (its token) in this process — every project on the
 * connection spends the same limit.
 */
export function hostRateBudgetOf(kind: 'gitlab' | 'bitbucket', connectionId: string): ApiRateBudget {
  const key = `${kind}:${connectionId}`;
  let b = hostBudgets.get(key);
  if (b === undefined) {
    b = new ApiRateBudget();
    hostBudgets.set(key, b);
  }
  return b;
}
