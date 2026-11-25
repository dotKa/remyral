import { z } from 'zod';
import { RuntimeKind, Timestamp } from './common.js';
import { LoginStoreId } from './queue.js';
import { RuntimeAccountId } from './runtime-account-ids.js';

/**
 * p11-limit-visibility (docs/design/p11-limit-visibility.md): how much of a runtime's usage limits is used **before** a
 * limit is hit — Claude Code's 5-hour / weekly (and per-model weekly) subscription windows, Codex's plan windows
 * (primary / secondary), their reset times — per worker login store, with the time and the source of each reading.
 *
 * Worker → master: HEARTBEAT `runtimeUsage` (additive in 1.0, with the `runtime-usage-v1` feature), sent only when a
 * reading changed or at a slow refresh, bounded to a few snapshots of a few windows. Values only: no account ids, no
 * tokens, no provider text beyond a bounded window label.
 */

export const RUNTIME_USAGE_FEATURE = 'runtime-usage-v1';

/** A window's stable id inside one snapshot (`five_hour`, `seven_day`, `primary`, `model:fable`, `codex:secondary`). */
export const UsageWindowId = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,47}$/, 'usage window id');

/**
 * What a window measures: `session` (Claude 5-hour; a Codex window of ≤ 6 h), `weekly`, `model_weekly` (one model's
 * weekly window), `spend` (extra usage / spend cap), `other` (a window of another length).
 */
export const UsageWindowKind = z.enum(['session', 'weekly', 'model_weekly', 'spend', 'other']);
export type UsageWindowKind = z.infer<typeof UsageWindowKind>;

/** The runtime's own state of a window (Claude `allowed` / `allowed_warning` / `rejected`; Codex reached types). */
export const UsageWindowStatus = z.enum(['allowed', 'warning', 'rejected']);
export type UsageWindowStatus = z.infer<typeof UsageWindowStatus>;

export const RuntimeUsageWindow = z.object({
  id: UsageWindowId,
  kind: UsageWindowKind,
  /** Server-supplied bucket name (a model's display name), one line; untrusted text shown as text only. */
  label: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[^\p{Cc}]*$/u)
    .optional(),
  /** Share of the window used, 0–100; null when the runtime did not say. */
  usedPercent: z.number().min(0).max(100).nullable(),
  windowMinutes: z.number().int().min(1).max(100_000).optional(),
  resetsAt: Timestamp.optional(),
  status: UsageWindowStatus.optional(),
  /**
   * p15-usage-refresh: the window's reset passed since the last reading — its new period has not been read yet
   * (`usedPercent` is null then, never an assumed 0).
   */
  restarted: z.literal(true).optional(),
});
export type RuntimeUsageWindow = z.infer<typeof RuntimeUsageWindow>;

/**
 * Where a reading came from: `probe` — a read-only call that sends nothing to a model (Codex `account/rateLimits/read`,
 * Claude Code's `/usage` data); `job` / `assistant` — seen passively in a job's or an assistant turn's event stream.
 */
export const RuntimeUsageSource = z.enum(['probe', 'job', 'assistant']);
export type RuntimeUsageSource = z.infer<typeof RuntimeUsageSource>;

/** How the runtime authenticated: the worker's subscription login (`store`) or an API key. */
export const RuntimeUsageAuth = z.enum(['subscription', 'api_key']);
export type RuntimeUsageAuth = z.infer<typeof RuntimeUsageAuth>;

export const MAX_USAGE_WINDOWS = 12;

/**
 * p15-usage-refresh (docs/design/p15-usage-refresh.md §2): which provider account a subscription login is — the same
 * Claude / ChatGPT account logged in on several machines has one usage limit. `key`: a domain-separated SHA-256
 * prefix of provider, e-mail and organization (computed on the worker); `hint`: the masked e-mail (`y…@example.com`).
 * Never the e-mail, organization name or a token.
 */
export const UsageIdentity = z.object({
  key: z.string().regex(/^[a-f0-9]{32}$/, 'usage identity key'),
  hint: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[^\p{Cc}]*$/u)
    .optional(),
});
export type UsageIdentity = z.infer<typeof UsageIdentity>;
export const MAX_USAGE_SNAPSHOTS = 8;

export const RuntimeUsageSnapshot = z.object({
  runtime: RuntimeKind,
  auth: RuntimeUsageAuth,
  /** The login store (CAPABILITIES.localLogin.stores) for subscription readings. */
  store: LoginStoreId.optional(),
  /**
   * p13-runtime-accounts (additive, `runtime-accounts-v1` workers): the runtime account the reading belongs to (absent =
   * `default`). One snapshot per runtime × auth × account.
   */
  account: RuntimeAccountId.optional(),
  source: RuntimeUsageSource,
  /** When the newest window value was read on the worker. */
  observedAt: Timestamp,
  /** Plan name as the runtime says it (`max`, `pro`, `plus`, `team`, …). */
  plan: z
    .string()
    .regex(/^[a-z0-9_.-]{1,32}$/)
    .optional(),
  /** false: the runtime says plan limits do not apply to this login (an API key, a 3rd-party provider). */
  available: z.boolean().optional(),
  windows: z.array(RuntimeUsageWindow).max(MAX_USAGE_WINDOWS),
  /** p15-usage-refresh (additive, `usage-refresh-v1` workers): the provider account of a subscription login. */
  identity: UsageIdentity.optional(),
});
export type RuntimeUsageSnapshot = z.infer<typeof RuntimeUsageSnapshot>;

/** HEARTBEAT `runtimeUsage`. */
export const RuntimeUsageReport = z.array(RuntimeUsageSnapshot).max(MAX_USAGE_SNAPSHOTS);
export type RuntimeUsageReport = z.infer<typeof RuntimeUsageReport>;

/** Display level of a window: `limited` (rejected / 100 %), `near` (≥ the threshold), `ok`, `unknown` (no value). */
export type UsageLevel = 'ok' | 'near' | 'limited' | 'unknown';

export const DEFAULT_NEAR_THRESHOLD = 80;

/**
 * p15-usage-refresh: `near` only at or above the workspace threshold. A runtime's own warning (Claude
 * `allowed_warning`, which it may raise far below the threshold) counts only when the runtime gave no number.
 */
export function usageLevel(
  w: Pick<RuntimeUsageWindow, 'usedPercent' | 'status'>,
  nearThreshold: number = DEFAULT_NEAR_THRESHOLD,
): UsageLevel {
  if (w.status === 'rejected' || (w.usedPercent !== null && w.usedPercent >= 100)) return 'limited';
  if (w.usedPercent === null) return w.status === 'warning' ? 'near' : 'unknown';
  if (w.usedPercent >= nearThreshold) return 'near';
  return 'ok';
}

/** The worse of two levels (limited > near > ok > unknown). */
export function worseLevel(a: UsageLevel, b: UsageLevel): UsageLevel {
  const rank: Readonly<Record<UsageLevel, number>> = { unknown: 0, ok: 1, near: 2, limited: 3 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Merge a sparse reading into the previous windows (Codex `account/rateLimits/updated` is sparse; a Claude
 * `rate_limit_event` carries one window): windows of `next` replace those with the same id, the others stay. A window
 * whose reset time passed is dropped by {@link dropExpiredWindows}, not here.
 */
export function mergeUsageWindows(
  previous: readonly RuntimeUsageWindow[],
  next: readonly RuntimeUsageWindow[],
): RuntimeUsageWindow[] {
  const out = new Map<string, RuntimeUsageWindow>();
  for (const w of previous) out.set(w.id, w);
  for (const w of next) {
    const old = out.get(w.id);
    // A sparse update without a value keeps the known value / reset (it never "clears" one).
    out.set(
      w.id,
      old === undefined
        ? w
        : {
            ...old,
            ...w,
            usedPercent: w.usedPercent ?? old.usedPercent,
            ...(w.resetsAt === undefined && old.resetsAt !== undefined ? { resetsAt: old.resetsAt } : {}),
            ...(w.windowMinutes === undefined && old.windowMinutes !== undefined
              ? { windowMinutes: old.windowMinutes }
              : {}),
            ...(w.label === undefined && old.label !== undefined ? { label: old.label } : {}),
          },
    );
  }
  return [...out.values()].slice(0, MAX_USAGE_WINDOWS);
}

/**
 * A window whose reset time is in the past is stale: its usage started over, but nothing has read the new period yet.
 * p15-usage-refresh: it is kept as `restarted` with **no value** (`usedPercent: null`, not an assumed 0 — that showed
 * "0 %" for a window that was at 9 %) and without the old reset; the next reading fills it in.
 */
export function dropExpiredWindows(windows: readonly RuntimeUsageWindow[], now: Date): RuntimeUsageWindow[] {
  return windows.map((w) => {
    if (w.resetsAt === undefined || Date.parse(w.resetsAt) > now.getTime()) return w;
    const { resetsAt: _r, status: _s, ...rest } = w;
    return { ...rest, usedPercent: null, restarted: true };
  });
}

/** p15-usage-refresh: the remote op `usage.refresh` and OPS_UPDATE `usageRefresh` (with `usage-refresh-v1`). */
export const USAGE_REFRESH_FEATURE = 'usage-refresh-v1';

/** What happened to one login in a `usage.refresh`. */
export const UsageRefreshOutcome = z.enum(['read', 'no_probe', 'failed']);
export type UsageRefreshOutcome = z.infer<typeof UsageRefreshOutcome>;

/** Every login of a machine fits (2 runtimes × (configured + 8 accounts) and API-key rows). */
export const MAX_REFRESH_SNAPSHOTS = 24;

export const UsageRefreshReport = z.object({
  results: z
    .array(
      z.object({
        runtime: RuntimeKind,
        account: RuntimeAccountId,
        outcome: UsageRefreshOutcome,
      }),
    )
    .max(32),
  /** The fresh snapshots (stored by the master before the operation is shown as finished). */
  snapshots: z.array(RuntimeUsageSnapshot).max(MAX_REFRESH_SNAPSHOTS),
});
export type UsageRefreshReport = z.infer<typeof UsageRefreshReport>;
