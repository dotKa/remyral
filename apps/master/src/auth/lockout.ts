/**
 * Account lockout with exponential backoff (ADR-0009 §7). Every failed factor (password, TOTP, recovery
 * code, step-up) increments `failed_attempts`; from the threshold on, each failure locks the account for
 * base × 2^(failures − threshold), capped. A successful full login resets the counter. Attempts made while
 * locked are rejected without being counted, so an attacker cannot extend the lock indefinitely faster
 * than the backoff allows.
 */
export interface LockoutPolicy {
  readonly threshold: number;
  readonly baseMs: number;
  readonly maxMs: number;
}

export const DEFAULT_LOCKOUT: LockoutPolicy = { threshold: 5, baseMs: 30_000, maxMs: 60 * 60_000 };

export function lockoutDurationMs(failedAttempts: number, policy: LockoutPolicy = DEFAULT_LOCKOUT): number {
  if (failedAttempts < policy.threshold) return 0;
  const exponent = Math.min(failedAttempts - policy.threshold, 30);
  return Math.min(policy.baseMs * 2 ** exponent, policy.maxMs);
}
