import { type RuntimeUsageWindow, RuntimeUsageWindow as WindowSchema, usageLevel } from '@remyral/protocol';

/**
 * p15-usage-refresh (docs/design/p15-usage-refresh.md §3, §5): one subscription account logged in on several machines
 * has one usage limit. Snapshots carry the login's provider account (`identity_key`, hashed on the worker); among the
 * snapshots of one runtime and identity the **newest reading wins** — for the overview, the placement facts and the
 * usage-limit fallback alike. Pure helpers (no I/O).
 */

export interface UsageSnapshotRow {
  readonly worker_id: string;
  readonly runtime: string;
  readonly auth: 'subscription' | 'api_key';
  readonly account: string;
  readonly identity_key: string | null;
  readonly identity_hint: string | null;
  readonly windows: unknown;
  readonly observed_at: Date;
}

export const windowsOf = (v: unknown): RuntimeUsageWindow[] =>
  Array.isArray(v)
    ? v.flatMap((w) => (WindowSchema.safeParse(w).success ? [w as RuntimeUsageWindow] : []))
    : [];

/** `runtime \0 identity` of a subscription snapshot with a known identity, else null. */
export function identityGroupKey(
  r: Pick<UsageSnapshotRow, 'runtime' | 'auth' | 'identity_key'>,
): string | null {
  return r.auth === 'subscription' && r.identity_key !== null ? `${r.runtime}\u0000${r.identity_key}` : null;
}

/** The newest snapshot of every identity group (ties: the first seen). */
export function newestByIdentity<T extends UsageSnapshotRow>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    const k = identityGroupKey(r);
    if (k === null) continue;
    const cur = out.get(k);
    if (cur === undefined || r.observed_at.getTime() > cur.observed_at.getTime()) out.set(k, r);
  }
  return out;
}

/** The reading that counts for `row`: the newest of its identity group (itself when it has no identity). */
export function effectiveSnapshot<T extends UsageSnapshotRow>(row: T, newest: ReadonlyMap<string, T>): T {
  const k = identityGroupKey(row);
  if (k === null) return row;
  return newest.get(k) ?? row;
}

const LIMIT_KINDS: ReadonlySet<string> = new Set(['session', 'weekly']);
/** A claimed reset further ahead than a weekly window never holds an account (a bogus reading cannot hold it long). */
const MAX_HOLD_MS = 8 * 86_400_000;

/**
 * A reading that says the account is at its limit right now: a session or weekly window at ≥ 100 % (or rejected by the
 * runtime) whose reset is still ahead → that reset (the latest such one: the account is limited until all reset).
 * Model-scoped and spend windows never hold the whole account. Null otherwise.
 */
export function readingLimitUntil(windows: readonly RuntimeUsageWindow[], now: Date): string | null {
  let until: number | null = null;
  for (const w of windows) {
    if (!LIMIT_KINDS.has(w.kind) || w.resetsAt === undefined) continue;
    const at = Date.parse(w.resetsAt);
    if (!Number.isFinite(at) || at <= now.getTime() || at > now.getTime() + MAX_HOLD_MS) continue;
    if (usageLevel(w) !== 'limited') continue;
    if (until === null || at > until) until = at;
  }
  return until === null ? null : new Date(until).toISOString();
}
