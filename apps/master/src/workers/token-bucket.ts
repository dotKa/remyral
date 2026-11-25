/** Token bucket for per-connection rate limits (T-WRK-3). Time source injectable for tests. */
export class TokenBucket {
  #tokens: number;
  #last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.#tokens = burst;
    this.#last = now();
  }

  /** Takes `cost` tokens; false (and nothing taken) if not enough are available. */
  take(cost = 1): boolean {
    const t = this.now();
    this.#tokens = Math.min(this.burst, this.#tokens + ((t - this.#last) / 1000) * this.ratePerSec);
    this.#last = t;
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }
}
