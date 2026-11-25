import { isValidTimeZone, zonedParts, zonedToUtc } from '@remyral/protocol';

/**
 * p6-quota-scheduling: recognise a run that stopped because the provider's usage limit (subscription window,
 * plan quota, spend limit) was reached, and when it resets — so the worker reports `provider_usage_limit` with
 * `resetAt` (JOB_RESULT, ADR-0014 §5) and the master pauses that runtime on that machine / account until then
 * instead of failing every job sent to it.
 *
 * Sources, most reliable first:
 *  - Claude Code: the SDK `rate_limit_event` with `rate_limit_info.status: "rejected"` and `resetsAt` (epoch
 *    seconds; sdk.d.ts 0.3.296 `SDKRateLimitInfo`), the assistant error `rate_limit` / `billing_error`, and the
 *    CLI's text ("You've hit your limit · resets 3pm (Europe/Istanbul)", older "Claude AI usage limit
 *    reached|<epoch>");
 *  - Codex: `codexErrorInfo` `usageLimitExceeded` / `rateLimitExceeded` (generated protocol of codex-cli 0.162.1)
 *    with the message's "try again at 3:15 PM" / "try again in 2 hours 5 minutes";
 *  - OpenCode and Pi: the provider error text they forward (quota / usage-limit wording, `usage_limit_reached`
 *    bodies with `resets_at` / `resets_in_seconds`).
 *
 * Pure text matching over output that is already redacted; conservative: a plain transient 429 that the runtime
 * retries is not a usage limit. A reset time that cannot be read is left out (the master then uses its default
 * backoff); one in the past or more than 31 days ahead is ignored.
 */

/** The JOB_RESULT error code (and the adapter `errorCode`) of a run stopped by a provider usage limit. */
export const PROVIDER_USAGE_LIMIT = 'provider_usage_limit';

/**
 * p11-usage-limit-fallback: which limit was hit, as far as the runtime says — `session` (Claude 5-hour window),
 * `weekly`, `model_weekly` (a per-model weekly cap: Opus / Sonnet, Codex "usage limit for <model>"), `spend`
 * (overage / spend cap / out of credits), `quota` (provider quota), `rate` (a provider rate limit that the runtime gave
 * up on with a reset time).
 */
export type UsageLimitKind = 'session' | 'weekly' | 'model_weekly' | 'spend' | 'quota' | 'rate';

export interface UsageLimitSignal {
  /** When the provider says the limit resets (absent: not said or not readable). */
  readonly resetAt?: Date;
  /** p11-usage-limit-fallback: the limit's kind, when the runtime's event or text names it. */
  readonly kind?: UsageLimitKind;
  /** p11-usage-limit-fallback: the limit applies to one model only (another model of the same login still works). */
  readonly modelScoped?: boolean;
  /** p11-usage-limit-fallback: the runtime's own words (bounded; redacted before they leave the adapter). */
  readonly detail?: string;
}

/**
 * p11-usage-limit-fallback: `SessionResult.usageLimit` — what the worker forwards (with the scope it knows from the
 * job's auth) as JOB_RESULT `error.usageLimit`.
 */
export interface UsageLimitDetail {
  readonly kind?: UsageLimitKind;
  readonly modelScoped?: boolean;
  /** One line of the runtime's text, ≤ 300 characters (redacted by the adapter's secret redaction). */
  readonly message?: string;
}

/** How a runtime failure is classified (p11-usage-limit-fallback): a usage limit, a login problem, a transient fault. */
export type ProviderFailureClass =
  | { readonly class: 'usage_limited'; readonly signal: UsageLimitSignal }
  | { readonly class: 'auth' }
  | { readonly class: 'transient' };

/** Runtime error codes (as the adapters map them) that are a usage limit whatever the text says. */
const LIMIT_CODES = new Set([
  PROVIDER_USAGE_LIMIT,
  'codex_usageLimitExceeded',
  'codex_rateLimitExceeded',
  'claude_rate_limit',
  'claude_billing_error',
]);

const LIMIT_PATTERNS: readonly RegExp[] = [
  /claude ai usage limit reached/i,
  /\byou(?:'|’)ve (?:hit|reached) your\b[^.\n·]{0,40}?\blimit\b/i,
  /\busage limit (?:has been |was )?(?:reached|exceeded|hit)\b/i,
  /\b(?:5-hour|five[- ]hour|weekly|daily|monthly|session) (?:usage |spend )?limit (?:reached|exceeded)\b/i,
  /\bspend limit reached\b/i,
  /\busage_limit_(?:reached|exceeded)\b/i,
  /\binsufficient_quota\b/i,
  /\byou exceeded your current quota\b/i,
  /\bquota (?:has been )?exceeded\b/i,
  /\bresource_exhausted\b/i,
  /\bout of (?:usage )?credits\b/i,
  // p11-usage-limit-fallback: Codex workspace spend caps, Claude per-model / weekly caps.
  /\byou hit your spend cap\b/i,
  /\b(?:opus|sonnet|haiku)(?: 4(?:\.\d)?)? (?:weekly |usage )?limit (?:reached|exceeded|hit)\b/i,
  /\bweekly (?:usage )?limit (?:reached|exceeded|hit)\b/i,
];

/** Login / credential failures: never a usage limit (p10-claude-login-health keeps them `login_expired`). */
const AUTH_PATTERNS: readonly RegExp[] = [
  /\b401\b[^\n]{0,80}\b(?:unauthori[sz]ed|authentication|invalid)/i,
  /\bauthentication_(?:failed|error)\b/i,
  /\binvalid (?:x-)?api[ _-]?key\b/i,
  /\bincorrect api key\b/i,
  /\boauth token (?:has )?expired\b/i,
  /\bplease run \/login\b/i,
  /\binvalid_api_key\b/i,
  /\bnot logged in\b/i,
];

/** Faults the runtime retries itself (or that a plain retry fixes): never a usage limit. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\b5\d\d\b[^\n]{0,40}\b(?:server error|bad gateway|service unavailable|gateway time-?out|internal)/i,
  /\binternal server error\b/i,
  /\boverloaded(?:_error)?\b/i,
  /\b529\b/,
  /\bECONNRESET\b|\bETIMEDOUT\b|\bsocket hang up\b/i,
  /\bwould exceed your account's rate limit\b/i,
  /\brate limit(?:ed)?\b[^\n]{0,40}\bretrying\b/i,
  /\bserver_error\b/i,
];

/** Wording that says only one model is limited (another model of the same login still works). */
const MODEL_SCOPED: readonly RegExp[] = [
  /\busage limit for [^\n]{1,80}?\.\s*switch to another model\b/i,
  /\b(?:opus|sonnet|haiku)(?: 4(?:\.\d)?)? (?:weekly |usage )?limit\b/i,
];

const MAX_AHEAD_MS = 31 * 24 * 3600 * 1000;
const MAX_TEXT = 64 * 1024;

/** Whether `text` says a provider usage limit was reached. */
export function isUsageLimitText(text: string | undefined): boolean {
  if (text === undefined || text.length === 0) return false;
  const t = text.length > MAX_TEXT ? text.slice(-MAX_TEXT) : text;
  return LIMIT_PATTERNS.some((re) => re.test(t));
}

/**
 * A usage-limit signal from an adapter error event (`code`, `message`) — by the code, else by the text — or null.
 * `timeZone`: the zone wall times without one are read in (the worker's own zone by default, the zone the
 * runtime printed them in).
 */
export function usageLimitFromError(
  code: string | undefined,
  message: string | undefined,
  now: Date,
  timeZone?: string,
): UsageLimitSignal | null {
  const byCode = code !== undefined && LIMIT_CODES.has(code);
  if (!byCode && !isUsageLimitText(message)) return null;
  const resetAt = message === undefined ? undefined : parseResetTime(message, now, timeZone);
  const marked = message === undefined ? null : markersOf(message);
  const kind = marked?.kind ?? (message === undefined ? undefined : limitKindOf(message));
  const modelScoped =
    marked?.modelScoped === true ||
    kind === 'model_weekly' ||
    (message !== undefined && MODEL_SCOPED.some((re) => re.test(message)));
  const detail = message === undefined ? undefined : detailOf(message);
  return {
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(kind === undefined ? {} : { kind }),
    ...(modelScoped ? { modelScoped: true } : {}),
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * p11-usage-limit-fallback: classifies a runtime failure — a usage limit (with its reset, kind and scope), a login /
 * credential problem, a transient fault — or null (an ordinary failure). Login wording wins over limit wording (a 401
 * is never waited out); limit wording wins over transient wording (a 429 "usage limit reached … resets" is a limit, a
 * bare 529 or "retrying" is not).
 */
export function classifyProviderFailure(
  code: string | undefined,
  message: string | undefined,
  now: Date,
  timeZone?: string,
): ProviderFailureClass | null {
  const t = message === undefined ? '' : message.length > MAX_TEXT ? message.slice(-MAX_TEXT) : message;
  if (
    code === 'login_expired' ||
    code === 'authentication_failed' ||
    code === 'claude_authentication_failed' ||
    AUTH_PATTERNS.some((re) => re.test(t))
  ) {
    return { class: 'auth' };
  }
  const signal = usageLimitFromError(code, message, now, timeZone);
  if (signal !== null) return { class: 'usage_limited', signal };
  if (
    code === 'overloaded' ||
    code === 'server_error' ||
    code === 'claude_overloaded' ||
    code === 'claude_server_error' ||
    TRANSIENT_PATTERNS.some((re) => re.test(t))
  ) {
    return { class: 'transient' };
  }
  return null;
}

/** The limit's kind from its wording (the most specific that matches), or undefined. */
export function limitKindOf(text: string): UsageLimitKind | undefined {
  const t = text.length > MAX_TEXT ? text.slice(-MAX_TEXT) : text;
  if (MODEL_SCOPED.some((re) => re.test(t))) return 'model_weekly';
  if (/\b(?:weekly|7-day|seven[_ -]day)\b/i.test(t)) return 'weekly';
  if (/\b(?:5-hour|five[_ -]hour|session limit)\b/i.test(t)) return 'session';
  if (/\b(?:spend (?:limit|cap)|out of (?:usage )?credits|spend|overage)\b/i.test(t)) return 'spend';
  if (/\b(?:quota|resource_exhausted)\b/i.test(t)) return 'quota';
  return undefined;
}

/** Claude `rateLimitType` → kind (sdk.d.ts 0.3.296 `SDKRateLimitInfo.rateLimitType`). */
function claudeKind(type: unknown): UsageLimitKind | undefined {
  switch (type) {
    case 'five_hour':
      return 'session';
    case 'seven_day':
    case 'seven_day_overage_included':
      return 'weekly';
    case 'seven_day_opus':
    case 'seven_day_sonnet':
      return 'model_weekly';
    case 'overage':
      return 'spend';
    default:
      return undefined;
  }
}

const KINDS: readonly UsageLimitKind[] = ['session', 'weekly', 'model_weekly', 'spend', 'quota', 'rate'];

/** The `[limit=<kind>]` / `[model]` markers of a canonical message ({@link usageLimitMessage}). */
function markersOf(text: string): { kind?: UsageLimitKind; modelScoped: boolean } | null {
  const m = /\[limit=([a-z_]{3,16})\]/.exec(text);
  const scoped = /\[model\]/.test(text);
  if (m === null && !scoped) return null;
  const kind = KINDS.find((k) => k === m?.[1]);
  return { ...(kind === undefined ? {} : { kind }), modelScoped: scoped };
}

/** One line of the runtime's text, ≤ 300 characters, without the canonical prefix and markers. */
function detailOf(text: string): string | undefined {
  const line = text
    .replace(/^provider usage limit reached(?: \[[^\]]*\])*(?:; resets at \S+)?:?\s*/i, '')
    .replace(/\[(?:limit=[a-z_]+|model)\]\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (line === '') return undefined;
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/**
 * Claude Code SDK `rate_limit_event.rate_limit_info` (sdk.d.ts 0.3.296): `status: "rejected"` means the
 * subscription limit stops requests; `resetsAt` is epoch seconds. `allowed` / `allowed_warning` are not limits.
 */
export function claudeRateLimitSignal(info: unknown, now: Date): UsageLimitSignal | null {
  if (typeof info !== 'object' || info === null) return null;
  const i = info as {
    status?: unknown;
    resetsAt?: unknown;
    overageStatus?: unknown;
    overageResetsAt?: unknown;
  };
  if (i.status !== 'rejected') return null;
  // With overage in use the request may still go through; only a rejected overage (or none) stops the run.
  if (i.overageStatus === 'allowed' || i.overageStatus === 'allowed_warning') return null;
  const reset = epochToDate(i.resetsAt, now);
  const kind = claudeKind((info as { rateLimitType?: unknown }).rateLimitType);
  return {
    ...(reset === undefined ? {} : { resetAt: reset }),
    ...(kind === undefined ? {} : { kind }),
    ...(kind === 'model_weekly' ? { modelScoped: true } : {}),
  };
}

/** Keeps the latest signal of a session (the latest reset time wins: the runtime cannot run before it). */
export class UsageLimitTracker {
  #signal: UsageLimitSignal | undefined;

  get signal(): UsageLimitSignal | undefined {
    return this.#signal;
  }

  observe(signal: UsageLimitSignal | null): void {
    if (signal === null) return;
    const prev = this.#signal;
    const next = signal.resetAt;
    const prevAt = prev?.resetAt;
    // The latest reset wins; p11-usage-limit-fallback: kind, model scope and the runtime's words accumulate across
    // the events of a run (the SDK event names the window, the CLI text carries the words).
    const resetAt = next !== undefined && (prevAt === undefined || next > prevAt) ? next : prevAt;
    const kind = signal.kind ?? prev?.kind;
    const detail = signal.detail ?? prev?.detail;
    const modelScoped = signal.modelScoped === true || prev?.modelScoped === true;
    this.#signal = {
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(kind === undefined ? {} : { kind }),
      ...(modelScoped ? { modelScoped: true } : {}),
      ...(detail === undefined ? {} : { detail }),
    };
  }

  /**
   * `SessionResult` fields of a run that ended `provider_usage_limit`: `resetAt` when a reset is known and the typed
   * `usageLimit` detail (p11-usage-limit-fallback). `redact` removes secrets from the runtime's words.
   */
  resultFields(
    errorCode: string | undefined,
    redact: (s: string) => string = (s) => s,
  ): { resetAt?: string; usageLimit?: UsageLimitDetail } {
    const s = this.#signal;
    if (errorCode !== PROVIDER_USAGE_LIMIT || s === undefined) return {};
    const at = this.resetAtIso();
    const message = s.detail === undefined ? '' : redact(s.detail).slice(0, 300);
    const detail: UsageLimitDetail = {
      ...(s.kind === undefined ? {} : { kind: s.kind }),
      ...(s.modelScoped === true ? { modelScoped: true } : {}),
      ...(message === '' ? {} : { message }),
    };
    return { ...(at === undefined ? {} : { resetAt: at }), usageLimit: detail };
  }

  /** ISO reset time for `SessionResult.resetAt`, if one is known. */
  resetAtIso(): string | undefined {
    return this.#signal?.resetAt?.toISOString();
  }
}

/** Canonical error event text (parsed back by `usageLimitFromError`). */
export function usageLimitMessage(signal: UsageLimitSignal, detail?: string): string {
  // p11-usage-limit-fallback: the kind and the model scope travel as markers (read back by usageLimitFromError).
  const markers = `${signal.kind === undefined ? '' : ` [limit=${signal.kind}]`}${
    signal.modelScoped === true ? ' [model]' : ''
  }`;
  const head =
    signal.resetAt === undefined
      ? `provider usage limit reached${markers}`
      : `provider usage limit reached${markers}; resets at ${signal.resetAt.toISOString()}`;
  return detail === undefined || detail === '' ? head : `${head}: ${detail}`;
}

// ------------------------------------------------------------------------------------- reset time parsing

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function plausible(d: Date, now: Date): Date | undefined {
  const t = d.getTime();
  if (!Number.isFinite(t)) return undefined;
  if (t < now.getTime() - 60_000 || t > now.getTime() + MAX_AHEAD_MS) return undefined;
  return d;
}

function epochToDate(v: unknown, now: Date): Date | undefined {
  const n = typeof v === 'string' && /^\d{9,13}$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return plausible(new Date(n < 1e12 ? n * 1000 : n), now);
}

const UNIT_MS: Readonly<Record<string, number>> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1000,
};

function unitOf(word: string): number | undefined {
  const w = word.toLowerCase();
  if (/^d(ays?)?$/.test(w)) return UNIT_MS.d;
  if (/^h((ou)?rs?)?$/.test(w)) return UNIT_MS.h;
  if (/^m(in(ute)?s?)?$/.test(w)) return UNIT_MS.m;
  if (/^s(ec(ond)?s?)?$/.test(w)) return UNIT_MS.s;
  return undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function monthOf(word: string): number | undefined {
  const i = MONTHS.indexOf(word.slice(0, 3).toLowerCase());
  return i < 0 ? undefined : i + 1;
}

/** "3pm", "3:30 PM", "15:00", "noon", "midnight" → [hour, minute]. */
function parseClock(text: string): [number, number] | undefined {
  const t = text.trim().toLowerCase();
  if (t === 'noon') return [12, 0];
  if (t === 'midnight') return [0, 0];
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?\s*m\.?$|^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (m === null) return undefined;
  if (m[4] !== undefined) {
    const h = Number(m[4]);
    const min = Number(m[5]);
    return h <= 23 && min <= 59 ? [h, min] : undefined;
  }
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h < 1 || h > 12 || min > 59) return undefined;
  if (m[3] === 'a' && h === 12) h = 0;
  else if (m[3] === 'p' && h !== 12) h += 12;
  return [h, min];
}

/** "Oct 17", "October 17th, 2026", "17 Oct", "2026-10-17" → [year?, month, day]. */
function parseDate(text: string): [number | undefined, number, number] | undefined {
  const t = text.trim().replace(/,$/, '');
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m !== null) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(t);
  if (m?.[1] !== undefined) {
    const month = monthOf(m[1]);
    return month === undefined
      ? undefined
      : [m[3] === undefined ? undefined : Number(m[3]), month, Number(m[2])];
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?$/.exec(t);
  if (m?.[2] !== undefined) {
    const month = monthOf(m[2]);
    return month === undefined
      ? undefined
      : [m[3] === undefined ? undefined : Number(m[3]), month, Number(m[1])];
  }
  return undefined;
}

/** A wall-clock expression ("3pm", "Oct 17, 3:30pm", "2026-08-08 00:00") in `zone` → the next such instant. */
function parseWall(expr: string, zone: string, now: Date): Date | undefined {
  const e = expr
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+at\s+/i, ' ');
  // Split off the clock part: the last token(s) that parse as a time.
  const m = /^(.*?)[\s,]*(\d{1,2}(?::\d{2}){0,2}\s*(?:[ap]\.?\s*m\.?)?|noon|midnight)$/i.exec(e);
  if (m?.[2] === undefined) return undefined;
  const clock = parseClock(m[2]);
  if (clock === undefined) return undefined;
  const datePart = (m[1] ?? '').trim();
  const today = zonedParts(now, zone);
  if (datePart === '' || /^today$/i.test(datePart) || /^tomorrow$/i.test(datePart)) {
    const plusDay = /^tomorrow$/i.test(datePart) ? 1 : 0;
    let at = zonedToUtc(
      { year: today.year, month: today.month, day: today.day + plusDay, hour: clock[0], minute: clock[1] },
      zone,
    );
    if (plusDay === 0 && at.getTime() <= now.getTime()) {
      at = zonedToUtc(
        { year: today.year, month: today.month, day: today.day + 1, hour: clock[0], minute: clock[1] },
        zone,
      );
    }
    return at;
  }
  const date = parseDate(datePart);
  if (date === undefined) return undefined;
  const [year, month, day] = date;
  let at = zonedToUtc({ year: year ?? today.year, month, day, hour: clock[0], minute: clock[1] }, zone);
  if (year === undefined && at.getTime() < now.getTime() - 86_400_000) {
    at = zonedToUtc({ year: today.year + 1, month, day, hour: clock[0], minute: clock[1] }, zone);
  }
  return at;
}

/**
 * The reset instant a limit message names, or undefined. Understands epoch suffixes and JSON fields, ISO
 * timestamps, durations ("in 2 hours 5 minutes", "in 3h 20m") and wall times with an optional date and zone
 * ("resets 3pm (Europe/Istanbul)", "try again at Oct 17th, 2026 3:15 PM", "resets 2026-08-08 00:00 UTC").
 */
export function parseResetTime(text: string, now: Date, timeZone?: string): Date | undefined {
  const t = text.length > MAX_TEXT ? text.slice(-MAX_TEXT) : text;
  let m = /usage limit reached\|(\d{9,13})/i.exec(t) ?? /"resets?_?at"\s*:\s*"?(\d{9,13})"?/i.exec(t);
  if (m?.[1] !== undefined) return epochToDate(m[1], now);
  m = /"resets?_in_seconds"\s*:\s*(\d{1,9})/i.exec(t) ?? /\bretry-after"?\s*[:=]\s*"?(\d{1,9})\b/i.exec(t);
  if (m?.[1] !== undefined) return plausible(new Date(now.getTime() + Number(m[1]) * 1000), now);
  // p11-usage-limit-fallback: `Retry-After` as an HTTP date (RFC 9110 §10.2.3, IMF-fixdate).
  m =
    /\bretry-after"?\s*[:=]\s*"?((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT)/i.exec(
      t,
    );
  if (m?.[1] !== undefined) return plausible(new Date(m[1]), now);
  m =
    /\b(?:resets?|try again|available)(?: at| after| on)?\s*:?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(
      t,
    );
  if (m?.[1] !== undefined) return plausible(new Date(m[1]), now);
  m = /\b(?:resets?|try again|retry|available)\s+in\s+((?:\d+\s*[A-Za-z]+[\s,]*(?:and\s+)?){1,4})/i.exec(t);
  if (m?.[1] !== undefined) {
    let ms = 0;
    let any = false;
    for (const part of m[1].matchAll(/(\d+)\s*([A-Za-z]+)/g)) {
      const unit = unitOf(part[2] ?? '');
      if (unit === undefined) break;
      ms += Number(part[1]) * unit;
      any = true;
    }
    if (any) return plausible(new Date(now.getTime() + ms), now);
  }
  const kw = /\b(?:resets?|try again|available again)(?:\s+(?:at|on))?\s+/i.exec(t);
  if (kw === null) return undefined;
  const after = t.slice(kw.index + kw[0].length, kw.index + kw[0].length + 80);
  const cut = /[()·•;!\n]|\.\s|\.$|\s[-–—]\s|\s(?:or|to|and)\s/i.exec(after);
  let rest = (cut === null ? after : after.slice(0, cut.index)).trim();
  let zoneName = /^\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}|UTC|GMT)\)/.exec(
    cut === null ? '' : after.slice(cut.index).trimStart(),
  )?.[1];
  const trailing = /\s+(UTC|GMT)$/i.exec(rest);
  if (trailing !== null) {
    zoneName = 'UTC';
    rest = rest.slice(0, trailing.index);
  }
  const zone =
    zoneName === undefined ? (timeZone ?? localZone()) : /^(UTC|GMT)$/i.test(zoneName) ? 'UTC' : zoneName;
  if (!isValidTimeZone(zone)) return undefined;
  // Longest prefix that reads as a wall time ("Oct 17th, 2026 3:15 PM", "3pm", "15:00 tomorrow" → "15:00").
  const words = rest
    .replace(/[.,]+$/, '')
    .split(/\s+/)
    .slice(0, 8);
  for (let n = words.length; n > 0; n--) {
    const at = parseWall(
      words
        .slice(0, n)
        .join(' ')
        .replace(/[.,]+$/, ''),
      zone,
      now,
    );
    if (at !== undefined) return plausible(at, now);
  }
  return undefined;
}

/**
 * p11-usage-limit-fallback: an assistant turn that failed on a usage limit (any engine) → the `provider_usage_limit`
 * reason with the reset (ISO) and a one-line detail; null for every other failure (login problems and transient faults
 * included). Used by the worker's assistant host for every engine.
 */
export function assistantUsageLimit(
  errorCode: string | undefined,
  detail: string | undefined,
  now: Date,
  timeZone?: string,
): { readonly resetAt?: string; readonly detail: string } | null {
  const c = classifyProviderFailure(errorCode, detail, now, timeZone);
  if (c?.class !== 'usage_limited') return null;
  const at = c.signal.resetAt?.toISOString();
  const text = c.signal.detail ?? 'the engine reached its usage limit';
  return { ...(at === undefined ? {} : { resetAt: at }), detail: text.slice(0, 500) };
}
