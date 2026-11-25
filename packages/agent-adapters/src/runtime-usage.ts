import { createHash } from 'node:crypto';
import {
  MAX_USAGE_WINDOWS,
  type RuntimeUsageWindow,
  type UsageIdentity,
  type UsageWindowKind,
  type UsageWindowStatus,
} from '@remyral/protocol';

/**
 * p11-limit-visibility (docs/design/p11-limit-visibility.md §2): the runtimes' usage-limit windows, parsed from what
 * the pinned runtimes expose — never from credential files, never by sending anything to a model.
 *
 *  - **Claude Code** (Agent SDK 0.3.296 `sdk.d.ts`):
 *    - `rate_limit_event.rate_limit_info` (`SDKRateLimitInfo`): `status`, `rateLimitType` (`five_hour`, `seven_day`,
 *      `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`), `utilization` (a fraction
 *      0–1 — the Agent SDK reference via Context7: "Fraction of the rate limit consumed (0.0 to 1.0)"), `resetsAt`
 *      (epoch seconds). Emitted when the state changes (passive: seen in jobs / assistant turns).
 *    - `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors: true})`
 *      (`SDKControlGetUsageResponse`): `subscription_type`, `rate_limits_available`, `rate_limits.{five_hour,
 *      seven_day, seven_day_oauth_apps, seven_day_opus, seven_day_sonnet}.{utilization 0–100, resets_at ISO}`,
 *      `model_scoped[]` (`display_name`), `extra_usage`. The structured `/usage` data: read from the claude.ai usage
 *      endpoint, no model request. Experimental in the SDK — parsed defensively, unknown shapes are ignored.
 *  - **Codex** (app-server of codex-cli 0.162.1, `codex app-server generate-ts`): `account/rateLimits/read` →
 *    `GetAccountRateLimitsResponse.rateLimits` / `rateLimitsByLimitId` (`RateLimitSnapshot`: `primary` / `secondary`
 *    `RateLimitWindow {usedPercent, windowDurationMins, resetsAt (epoch s)}`, `planType`, `rateLimitReachedType`,
 *    `individualLimit {remainingPercent, resetsAt}`); the sparse `account/rateLimits/updated` notification carries the
 *    same snapshot during turns.
 */

/** One reading of a runtime's windows (sparse readings are merged into the previous ones by the worker). */
export interface RuntimeUsageReading {
  /** Plan name as reported (`max`, `pro`, `plus`, …). */
  readonly plan?: string;
  /** false: plan limits do not apply (API key / 3rd-party provider sessions). */
  readonly available: boolean;
  readonly windows: readonly RuntimeUsageWindow[];
  /** Only some windows (an event / a sparse notification): merge, do not replace. */
  readonly partial: boolean;
  /**
   * p15-usage-refresh: which provider account the login is (probes only; hashed — see {@link usageIdentity}). Absent:
   * not known (passive readings, API keys, 3rd-party providers).
   */
  readonly identity?: UsageIdentity;
}

/**
 * p15-usage-refresh (docs/design/p15-usage-refresh.md §2): the provider account behind a subscription login, as the
 * runtime reports it (Claude `AccountInfo.email` / `organization`, Codex `account/read` e-mail) → a stable,
 * domain-separated SHA-256 prefix (the same account on another machine gives the same key) and a masked e-mail
 * (`y…@example.com`). Null without a plausible e-mail. The e-mail and organization never leave this function.
 */
export function usageIdentity(
  provider: 'anthropic' | 'openai',
  email: unknown,
  organization?: unknown,
): UsageIdentity | null {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  if (e.length < 3 || e.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(e)) return null;
  const org = typeof organization === 'string' ? organization.trim().slice(0, 200) : '';
  const key = createHash('sha256')
    .update(`remana-usage-identity/v1\n${provider}\n${e}\n${org}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  const at = e.indexOf('@');
  const hint = `${e.slice(0, 1)}…${e.slice(at)}`.replace(/\p{Cc}/gu, '').slice(0, 64);
  return { key, ...(hint.length > 0 ? { hint } : {}) };
}

/** Observation hook adapters call (`SpawnContext.onUsage`, `AssistantSessionOptions.onUsage`). Never throws through. */
export type UsageObserver = (reading: RuntimeUsageReading) => void;

/** Calls `observer` and swallows anything it throws (observation must never break a run). */
export function reportUsage(observer: UsageObserver | undefined, reading: RuntimeUsageReading | null): void {
  if (observer === undefined || reading === null) return;
  try {
    observer(reading);
  } catch {
    // observation only
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const MAX_RESET_AHEAD_MS = 62 * 24 * 3600 * 1000;

/** Epoch seconds (or ms) / ISO text → ISO with ms, when plausible (not long past, ≤ 62 days ahead). */
export function resetIso(v: unknown, now: Date): string | undefined {
  let ms: number | undefined;
  const n = num(v);
  if (n !== undefined) ms = n > 1e12 ? n : n * 1000;
  else if (typeof v === 'string' && v.length <= 64) {
    const p = Date.parse(v);
    if (Number.isFinite(p)) ms = p;
  }
  if (ms === undefined) return undefined;
  if (ms < now.getTime() - 24 * 3600 * 1000 || ms > now.getTime() + MAX_RESET_AHEAD_MS) return undefined;
  return new Date(ms).toISOString();
}

const clampPercent = (p: number): number => Math.round(Math.min(100, Math.max(0, p)) * 10) / 10;

/** Window label: one line, no control characters, ≤ 64 characters. */
function label(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, 64);
  return s === '' ? undefined : s;
}

function slug(v: string): string {
  const s = v
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s === '' ? 'x' : s;
}

function plan(v: unknown): string | undefined {
  return typeof v === 'string' && /^[a-z0-9_.-]{1,32}$/.test(v) ? v : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code

const CLAUDE_WINDOWS: Readonly<Record<string, { kind: UsageWindowKind; minutes?: number; label?: string }>> =
  {
    five_hour: { kind: 'session', minutes: 300 },
    seven_day: { kind: 'weekly', minutes: 10080 },
    seven_day_opus: { kind: 'model_weekly', minutes: 10080, label: 'Opus' },
    seven_day_sonnet: { kind: 'model_weekly', minutes: 10080, label: 'Sonnet' },
    seven_day_oauth_apps: { kind: 'weekly', minutes: 10080, label: 'OAuth apps' },
    seven_day_overage_included: { kind: 'weekly', minutes: 10080, label: 'Overage included' },
    overage: { kind: 'spend', label: 'Extra usage' },
  };

function claudeStatus(v: unknown): UsageWindowStatus | undefined {
  return v === 'allowed'
    ? 'allowed'
    : v === 'allowed_warning'
      ? 'warning'
      : v === 'rejected'
        ? 'rejected'
        : undefined;
}

/**
 * `rate_limit_event.rate_limit_info` → one window (partial). `utilization` is a fraction (0–1) per the SDK reference;
 * a value above 1 is read as a percentage (defensive: the TS typings do not state the unit).
 */
export function claudeUsageFromRateLimitInfo(info: unknown, now: Date): RuntimeUsageReading | null {
  if (!isObj(info)) return null;
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined;
  const spec = type === undefined ? undefined : CLAUDE_WINDOWS[type];
  if (type === undefined || spec === undefined) return null;
  const u = num(info.utilization);
  const status = claudeStatus(info.status);
  const usedPercent =
    u === undefined ? (status === 'rejected' ? 100 : null) : clampPercent(u <= 1 ? u * 100 : u);
  const resetsAt = resetIso(info.resetsAt, now);
  const w: RuntimeUsageWindow = {
    id: type,
    kind: spec.kind,
    usedPercent,
    ...(spec.label === undefined ? {} : { label: spec.label }),
    ...(spec.minutes === undefined ? {} : { windowMinutes: spec.minutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(status === undefined ? {} : { status }),
  };
  return { available: true, windows: [w], partial: true };
}

/** `SDKControlGetUsageResponse` (experimental `/usage` data) → a full reading; null when the shape is not known. */
export function claudeUsageFromGetUsage(resp: unknown, now: Date): RuntimeUsageReading | null {
  if (!isObj(resp) || typeof resp.rate_limits_available !== 'boolean') return null;
  const p = plan(resp.subscription_type);
  if (!resp.rate_limits_available || !isObj(resp.rate_limits)) {
    return { ...(p === undefined ? {} : { plan: p }), available: false, windows: [], partial: false };
  }
  const rl = resp.rate_limits;
  const windows: RuntimeUsageWindow[] = [];
  for (const [id, spec] of Object.entries(CLAUDE_WINDOWS)) {
    const w = rl[id];
    if (!isObj(w)) continue;
    const u = num(w.utilization);
    const resetsAt = resetIso(w.resets_at, now);
    windows.push({
      id,
      kind: spec.kind,
      usedPercent: u === undefined ? null : clampPercent(u),
      ...(spec.label === undefined ? {} : { label: spec.label }),
      ...(spec.minutes === undefined ? {} : { windowMinutes: spec.minutes }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  if (Array.isArray(rl.model_scoped)) {
    for (const m of rl.model_scoped.slice(0, 6)) {
      if (!isObj(m)) continue;
      const name = label(m.display_name);
      if (name === undefined) continue;
      const u = num(m.utilization);
      const resetsAt = resetIso(m.resets_at, now);
      windows.push({
        id: `model:${slug(name)}`,
        kind: 'model_weekly',
        label: name,
        usedPercent: u === undefined ? null : clampPercent(u),
        windowMinutes: 10080,
        ...(resetsAt === undefined ? {} : { resetsAt }),
      });
    }
  }
  if (isObj(rl.extra_usage) && rl.extra_usage.is_enabled === true) {
    const u = num(rl.extra_usage.utilization);
    windows.push({
      id: 'extra_usage',
      kind: 'spend',
      label: 'Extra usage',
      usedPercent: u === undefined ? null : clampPercent(u),
    });
  }
  return {
    ...(p === undefined ? {} : { plan: p }),
    available: true,
    windows: dedupe(windows),
    partial: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Codex

/** A Codex window's kind from its length: ≤ 6 h → session (the 5-hour window), 6–8 days → weekly. */
export function codexWindowKind(minutes: number | undefined, slot: 'primary' | 'secondary'): UsageWindowKind {
  if (minutes === undefined) return slot === 'primary' ? 'session' : 'weekly';
  if (minutes <= 360) return 'session';
  if (minutes >= 6 * 1440 && minutes <= 8 * 1440) return 'weekly';
  return 'other';
}

const REACHED: ReadonlySet<string> = new Set([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

function codexWindows(snapshot: Record<string, unknown>, prefix: string, now: Date): RuntimeUsageWindow[] {
  const out: RuntimeUsageWindow[] = [];
  const reached =
    typeof snapshot.rateLimitReachedType === 'string' && REACHED.has(snapshot.rateLimitReachedType);
  const name = label(snapshot.limitName);
  for (const slot of ['primary', 'secondary'] as const) {
    const w = snapshot[slot];
    if (!isObj(w)) continue;
    const used = num(w.usedPercent);
    const minutes = num(w.windowDurationMins);
    const mins = minutes === undefined ? undefined : Math.max(1, Math.min(100_000, Math.round(minutes)));
    const resetsAt = resetIso(w.resetsAt, now);
    const usedPercent = used === undefined ? null : clampPercent(used);
    out.push({
      id: `${prefix}${slot}`,
      kind: codexWindowKind(mins, slot),
      usedPercent,
      ...(name === undefined || prefix === '' ? {} : { label: name }),
      ...(mins === undefined ? {} : { windowMinutes: mins }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(reached && usedPercent !== null && usedPercent >= 100 ? { status: 'rejected' as const } : {}),
    });
  }
  const spend = snapshot.individualLimit;
  if (isObj(spend)) {
    const remaining = num(spend.remainingPercent);
    const resetsAt = resetIso(spend.resetsAt, now);
    if (remaining !== undefined) {
      out.push({
        id: `${prefix}spend`,
        kind: 'spend',
        label: 'Spend limit',
        usedPercent: clampPercent(100 - remaining),
        ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(snapshot.spendControlReached === true ? { status: 'rejected' as const } : {}),
      });
    }
  }
  return out;
}

/**
 * `account/rateLimits/read` result (full) or an `account/rateLimits/updated` notification's params (`{rateLimits}`,
 * sparse) → a reading. Extra buckets of `rateLimitsByLimitId` other than the main one become `<limitId>:primary` /
 * `<limitId>:secondary` windows with the bucket's name.
 */
export function codexUsageFromRateLimits(
  body: unknown,
  now: Date,
  opts: { readonly partial: boolean },
): RuntimeUsageReading | null {
  if (!isObj(body) || !isObj(body.rateLimits)) return null;
  const main = body.rateLimits;
  const windows = codexWindows(main, '', now);
  const mainId = typeof main.limitId === 'string' ? main.limitId : 'codex';
  if (isObj(body.rateLimitsByLimitId)) {
    for (const [id, snap] of Object.entries(body.rateLimitsByLimitId).slice(0, 4)) {
      if (id === mainId || !isObj(snap)) continue;
      windows.push(...codexWindows(snap, `${slug(id)}:`, now));
    }
  }
  const p = plan(main.planType);
  return {
    ...(p === undefined || p === 'unknown' ? {} : { plan: p }),
    available: true,
    windows: dedupe(windows),
    partial: opts.partial,
  };
}

function dedupe(windows: readonly RuntimeUsageWindow[]): RuntimeUsageWindow[] {
  const seen = new Set<string>();
  const out: RuntimeUsageWindow[] = [];
  for (const w of windows) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    out.push(w);
    if (out.length >= MAX_USAGE_WINDOWS) break;
  }
  return out;
}
