import { apiRequest, nullableStr, obj, type RequestOptions, str } from './client';

/**
 * p11-limit-visibility (docs/design/p11-limit-visibility.md): how much of each runtime's usage limits is used now —
 * per machine and runtime login (Claude Code 5-hour / weekly / per-model windows, Codex primary / secondary windows),
 * with reset times, where the numbers come from and how old they are, merged with known limit hits.
 */

export type UsageLevel = 'ok' | 'near' | 'limited' | 'unknown';

export interface UsageWindow {
  readonly id: string;
  readonly kind: string;
  readonly label: string | null;
  readonly usedPercent: number | null;
  readonly windowMinutes: number | null;
  readonly resetsAt: string | null;
  readonly status: string | null;
  /** p15-usage-refresh: the reset passed; the new period is not read yet (usedPercent null, not 0). */
  readonly restarted: boolean;
  readonly level: UsageLevel;
  readonly history: readonly { readonly at: string; readonly usedPercent: number }[];
}

export interface UsageEntry {
  readonly workerId: string;
  readonly workerName: string;
  readonly workerState: string;
  readonly runtime: string;
  readonly auth: 'subscription' | 'api_key';
  readonly store: string | null;
  /** p13-runtime-accounts: the runtime account (`default` = the machine's configured login / key). */
  readonly account: string;
  /** p13-runtime-accounts: the person's label of the account (null: not named / older master). */
  readonly accountLabel: string | null;
  readonly source: 'probe' | 'job' | 'assistant' | null;
  readonly plan: string | null;
  readonly available: boolean;
  readonly observedAt: string | null;
  readonly stale: boolean;
  readonly reports: boolean;
  readonly level: UsageLevel;
  readonly windows: readonly UsageWindow[];
  readonly limit: UsageLimitRef | null;
  /** p15-usage-refresh: the provider account (hashed key, masked e-mail); null when not known. */
  readonly identity: UsageIdentity | null;
  /** p15-usage-refresh: the windows come from this other machine's newer reading of the same account. */
  readonly readOn: MachineRef | null;
  /** p15-usage-refresh: the login no longer exists (a removed account). */
  readonly orphan: boolean;
  /** p15-usage-refresh: "Şimdi kontrol et" works for this login (connected, worker new enough). */
  readonly canRefresh: boolean;
}

export interface UsageLimitRef {
  readonly kind: string | null;
  readonly resetAt: string | null;
  readonly resumeAt: string;
}

export interface UsageIdentity {
  readonly key: string;
  readonly hint: string | null;
}

export interface MachineRef {
  readonly workerId: string;
  readonly workerName: string;
}

/** p15-usage-refresh: a machine an account is logged in on. */
export interface UsageGroupMachine {
  readonly workerId: string;
  readonly workerName: string;
  readonly workerState: string;
  readonly account: string;
  readonly accountLabel: string | null;
  readonly observedAt: string | null;
  readonly orphan: boolean;
  readonly canRefresh: boolean;
}

/** p15-usage-refresh: one provider account (its logins on every machine), or one login of unknown identity. */
export interface UsageGroup {
  readonly key: string;
  readonly runtime: string;
  readonly auth: 'subscription' | 'api_key';
  readonly identity: UsageIdentity | null;
  readonly labels: readonly string[];
  readonly source: 'probe' | 'job' | 'assistant' | null;
  readonly plan: string | null;
  readonly available: boolean;
  readonly observedAt: string | null;
  readonly readOn: MachineRef | null;
  readonly stale: boolean;
  readonly reports: boolean;
  readonly level: UsageLevel;
  readonly windows: readonly UsageWindow[];
  readonly limit: UsageLimitRef | null;
  readonly orphan: boolean;
  readonly canRefresh: boolean;
  readonly machines: readonly UsageGroupMachine[];
}

export interface OtherLimit {
  readonly id: string;
  readonly runtime: string;
  readonly pauseScope: string;
  readonly workerName: string | null;
  readonly credential: string | null;
  readonly accountId: string | null;
  /** p13-runtime-accounts: the runtime account the limit applies to (null: not account-scoped / older master). */
  readonly runtimeAccount: string | null;
  readonly model: string | null;
  readonly kind: string | null;
  readonly resetAt: string | null;
  readonly resumeAt: string;
}

export interface UsageOverview {
  readonly generatedAt: string;
  readonly nearThreshold: number;
  readonly notifyNear: boolean;
  readonly entries: readonly UsageEntry[];
  /** p15-usage-refresh: one row per provider account (older masters: one per login, built from `entries`). */
  readonly groups: readonly UsageGroup[];
  readonly otherLimits: readonly OtherLimit[];
}

type Opts = Omit<RequestOptions, 'body'>;

const LEVELS: readonly UsageLevel[] = ['ok', 'near', 'limited', 'unknown'];
const level = (v: unknown): UsageLevel => (LEVELS.includes(v as UsageLevel) ? (v as UsageLevel) : 'unknown');
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseWindow(v: unknown): UsageWindow {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    kind: str(o, 'kind'),
    label: strOrNull(o.label),
    usedPercent: numOrNull(o.usedPercent),
    windowMinutes: numOrNull(o.windowMinutes),
    resetsAt: strOrNull(o.resetsAt),
    status: strOrNull(o.status),
    restarted: o.restarted === true,
    level: level(o.level),
    history: Array.isArray(o.history)
      ? o.history.flatMap((p) => {
          const x = obj(p);
          const u = numOrNull(x.usedPercent);
          return typeof x.at === 'string' && u !== null ? [{ at: x.at, usedPercent: u }] : [];
        })
      : [],
  };
}

function parseLimit(v: unknown): UsageLimitRef | null {
  if (v === null || v === undefined) return null;
  const lim = obj(v);
  return { kind: strOrNull(lim.kind), resetAt: strOrNull(lim.resetAt), resumeAt: str(lim, 'resumeAt') };
}

function parseIdentity(v: unknown): UsageIdentity | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return typeof o.key === 'string' ? { key: o.key, hint: strOrNull(o.hint) } : null;
}

function parseMachineRef(v: unknown): MachineRef | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return typeof o.workerId === 'string' && typeof o.workerName === 'string'
    ? { workerId: o.workerId, workerName: o.workerName }
    : null;
}

const sourceOf = (v: unknown): UsageEntry['source'] =>
  v === 'probe' || v === 'job' || v === 'assistant' ? v : null;

function parseEntry(v: unknown): UsageEntry {
  const o = obj(v);
  const source = o.source;
  return {
    workerId: str(o, 'workerId'),
    workerName: str(o, 'workerName'),
    workerState: str(o, 'workerState'),
    runtime: str(o, 'runtime'),
    auth: o.auth === 'api_key' ? 'api_key' : 'subscription',
    store: nullableStr(o, 'store'),
    account: typeof o.account === 'string' && o.account !== '' ? o.account : 'default',
    accountLabel: strOrNull(o.accountLabel),
    source: sourceOf(source),
    plan: strOrNull(o.plan),
    available: o.available !== false,
    observedAt: strOrNull(o.observedAt),
    stale: o.stale === true,
    reports: o.reports === true,
    level: level(o.level),
    windows: Array.isArray(o.windows) ? o.windows.map(parseWindow) : [],
    limit: parseLimit(o.limit),
    identity: parseIdentity(o.identity),
    readOn: parseMachineRef(o.readOn),
    orphan: o.orphan === true,
    canRefresh: o.canRefresh === true,
  };
}

function parseGroupMachine(v: unknown): UsageGroupMachine {
  const x = obj(v);
  return {
    workerId: str(x, 'workerId'),
    workerName: str(x, 'workerName'),
    workerState: typeof x.workerState === 'string' ? x.workerState : '',
    account: typeof x.account === 'string' && x.account !== '' ? x.account : 'default',
    accountLabel: strOrNull(x.accountLabel),
    observedAt: strOrNull(x.observedAt),
    orphan: x.orphan === true,
    canRefresh: x.canRefresh === true,
  };
}

function parseGroup(v: unknown): UsageGroup {
  const o = obj(v);
  return {
    key: str(o, 'key'),
    runtime: str(o, 'runtime'),
    auth: o.auth === 'api_key' ? 'api_key' : 'subscription',
    identity: parseIdentity(o.identity),
    labels: Array.isArray(o.labels) ? o.labels.filter((x): x is string => typeof x === 'string') : [],
    source: sourceOf(o.source),
    plan: strOrNull(o.plan),
    available: o.available !== false,
    observedAt: strOrNull(o.observedAt),
    readOn: parseMachineRef(o.readOn),
    stale: o.stale === true,
    reports: o.reports === true,
    level: level(o.level),
    windows: Array.isArray(o.windows) ? o.windows.map(parseWindow) : [],
    limit: parseLimit(o.limit),
    orphan: o.orphan === true,
    canRefresh: o.canRefresh === true,
    machines: Array.isArray(o.machines) ? o.machines.map(parseGroupMachine) : [],
  };
}

/** An older master sends no groups: one group per login, as before. */
export function groupsFromEntries(entries: readonly UsageEntry[]): UsageGroup[] {
  return entries.map((e) => ({
    key: `login:${e.workerId}|${e.runtime}|${e.auth}|${e.account}`,
    runtime: e.runtime,
    auth: e.auth,
    identity: e.identity,
    labels: e.accountLabel === null ? [] : [e.accountLabel],
    source: e.source,
    plan: e.plan,
    available: e.available,
    observedAt: e.observedAt,
    readOn: e.readOn,
    stale: e.stale,
    reports: e.reports,
    level: e.level,
    windows: e.windows,
    limit: e.limit,
    orphan: e.orphan,
    canRefresh: e.canRefresh,
    machines: [
      {
        workerId: e.workerId,
        workerName: e.workerName,
        workerState: e.workerState,
        account: e.account,
        accountLabel: e.accountLabel,
        observedAt: e.observedAt,
        orphan: e.orphan,
        canRefresh: e.canRefresh,
      },
    ],
  }));
}

function parseOther(v: unknown): OtherLimit {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    runtime: str(o, 'runtime'),
    pauseScope: str(o, 'pauseScope'),
    workerName: strOrNull(o.workerName),
    credential: strOrNull(o.credential),
    accountId: strOrNull(o.accountId),
    runtimeAccount: strOrNull(o.runtimeAccount),
    model: strOrNull(o.model),
    kind: strOrNull(o.kind),
    resetAt: strOrNull(o.resetAt),
    resumeAt: str(o, 'resumeAt'),
  };
}

export function parseOverview(v: unknown): UsageOverview {
  const o = obj(v);
  const s = obj(o.settings);
  const entries = Array.isArray(o.entries) ? o.entries.map(parseEntry) : [];
  return {
    generatedAt: str(o, 'generatedAt'),
    nearThreshold: typeof s.nearThreshold === 'number' ? s.nearThreshold : 80,
    notifyNear: s.notifyNear !== false,
    entries,
    groups: Array.isArray(o.groups) ? o.groups.map(parseGroup) : groupsFromEntries(entries),
    otherLimits: Array.isArray(o.otherLimits) ? o.otherLimits.map(parseOther) : [],
  };
}

export function getUsageOverview(
  q: { readonly history?: boolean; readonly worker?: string; readonly runtime?: string } = {},
  opts: Opts = {},
): Promise<UsageOverview> {
  const p = new URLSearchParams();
  if (q.history === true) p.set('history', '1');
  if (q.worker !== undefined) p.set('worker', q.worker);
  if (q.runtime !== undefined) p.set('runtime', q.runtime);
  const qs = p.toString();
  return apiRequest('GET', `/usage-limits/overview${qs === '' ? '' : `?${qs}`}`, parseOverview, opts);
}

/** p15-usage-refresh: what to read now (absent fields: everything visible). */
export interface UsageRefreshTarget {
  readonly workerId?: string;
  readonly runtime?: string;
  readonly account?: string;
  readonly identity?: string;
}

export interface UsageRefreshStart {
  readonly ops: readonly { readonly workerId: string; readonly workerName: string; readonly opId: string }[];
  readonly skipped: readonly {
    readonly workerId: string;
    readonly workerName: string;
    readonly reason: string;
  }[];
}

export interface UsageRefreshOpState {
  readonly opId: string;
  readonly workerId: string;
  readonly state: string;
  readonly done: boolean;
  readonly reason: string | null;
  readonly results: readonly {
    readonly runtime: string;
    readonly account: string;
    readonly outcome: string;
  }[];
}

const records = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.map((y) => obj(y)) : []);

/** p15-usage-refresh: "Şimdi kontrol et" / "Tümünü yenile" — one usage.refresh remote operation per machine. */
export function startUsageRefresh(body: UsageRefreshTarget, opts: Opts = {}): Promise<UsageRefreshStart> {
  return apiRequest(
    'POST',
    '/usage-limits/refresh',
    (v) => {
      const o = obj(v);
      return {
        ops: records(o.ops).map((x) => ({
          workerId: str(x, 'workerId'),
          workerName: str(x, 'workerName'),
          opId: str(x, 'opId'),
        })),
        skipped: records(o.skipped).map((x) => ({
          workerId: str(x, 'workerId'),
          workerName: str(x, 'workerName'),
          reason: str(x, 'reason'),
        })),
      };
    },
    { ...opts, body },
  );
}

export function getUsageRefreshStatus(
  opIds: readonly string[],
  opts: Opts = {},
): Promise<UsageRefreshOpState[]> {
  return apiRequest(
    'GET',
    `/usage-limits/refresh-status?ops=${encodeURIComponent(opIds.join(','))}`,
    (v) =>
      records(obj(v).ops).map((x) => ({
        opId: str(x, 'opId'),
        workerId: str(x, 'workerId'),
        state: str(x, 'state'),
        done: x.done === true,
        reason: strOrNull(x.reason),
        results: records(x.results).map((z) => ({
          runtime: str(z, 'runtime'),
          account: str(z, 'account'),
          outcome: str(z, 'outcome'),
        })),
      })),
    opts,
  );
}

/** p15-usage-refresh: delete the readings of logins that no longer exist (admin, step-up). */
export function cleanupUsage(opts: Opts = {}): Promise<{ removed: number }> {
  return apiRequest('POST', '/usage-limits/cleanup', (v) => ({ removed: Number(obj(v).removed) }), opts);
}

export function putNearSettings(
  body: { readonly nearThreshold: number; readonly notifyNear: boolean },
  opts: Opts = {},
): Promise<{ nearThreshold: number; notifyNear: boolean }> {
  return apiRequest(
    'PUT',
    '/usage-limits/near-settings',
    (v) => {
      const o = obj(v);
      return { nearThreshold: Number(o.nearThreshold), notifyNear: o.notifyNear === true };
    },
    { ...opts, body },
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Texts (English like the rest of the console; times in the viewer's locale)

const WINDOW_SHORT: Readonly<Record<string, string>> = {
  five_hour: '5h',
  seven_day: 'weekly',
  seven_day_opus: 'Opus weekly',
  seven_day_sonnet: 'Sonnet weekly',
  seven_day_oauth_apps: 'apps weekly',
  seven_day_overage_included: 'weekly (overage)',
  extra_usage: 'extra usage',
};

/**
 * What a window is, for naming it in any language (p14-i18n-screens-b): a known Claude Code window, an N-hour or
 * N-day window, a weekly or spend window, or just its id — plus the model / account label to put in front.
 */
export type WindowShape =
  | { readonly kind: 'known'; readonly id: keyof typeof WINDOW_SHORT_IDS }
  | { readonly kind: 'hours'; readonly n: number }
  | { readonly kind: 'days'; readonly n: number }
  | { readonly kind: 'weekly' }
  | { readonly kind: 'spend' }
  | { readonly kind: 'id'; readonly id: string };

const WINDOW_SHORT_IDS = {
  five_hour: true,
  seven_day: true,
  seven_day_opus: true,
  seven_day_sonnet: true,
  seven_day_oauth_apps: true,
  seven_day_overage_included: true,
  extra_usage: true,
} as const;

export function windowShape(w: Pick<UsageWindow, 'id' | 'kind' | 'windowMinutes'>): WindowShape {
  if (Object.hasOwn(WINDOW_SHORT_IDS, w.id))
    return { kind: 'known', id: w.id as keyof typeof WINDOW_SHORT_IDS };
  if (w.kind === 'session')
    return {
      kind: 'hours',
      n: w.windowMinutes !== null && w.windowMinutes !== 300 ? Math.round(w.windowMinutes / 60) : 5,
    };
  if (w.kind === 'weekly' || w.kind === 'model_weekly') return { kind: 'weekly' };
  if (w.kind === 'spend') return { kind: 'spend' };
  if (w.windowMinutes !== null)
    return w.windowMinutes >= 1440
      ? { kind: 'days', n: Math.round(w.windowMinutes / 1440) }
      : { kind: 'hours', n: Math.round(w.windowMinutes / 60) };
  return { kind: 'id', id: w.id };
}

/** Short window name: "5h", "weekly", "Opus weekly", Codex windows by length ("5h" / "weekly" / "24h"). */
export function windowName(w: Pick<UsageWindow, 'id' | 'kind' | 'label' | 'windowMinutes'>): string {
  const shape = windowShape(w);
  if (shape.kind === 'known') return WINDOW_SHORT[shape.id] ?? shape.id;
  const base =
    shape.kind === 'hours'
      ? `${String(shape.n)}h`
      : shape.kind === 'days'
        ? `${String(shape.n)}d`
        : shape.kind === 'weekly'
          ? 'weekly'
          : shape.kind === 'spend'
            ? 'spend'
            : shape.id;
  return w.label === null ? base : `${w.label} ${base}`;
}

/** When a reset happens, relative to now: today (a time), this week (weekday + time), or later (a date). */
export function resetWhen(iso: string, now: number = Date.now()): 'today' | 'week' | 'later' {
  const d = new Date(iso);
  const diff = d.getTime() - now;
  if (diff < 20 * 3600_000 && d.getDate() === new Date(now).getDate()) return 'today';
  if (diff < 6 * 86400_000) return 'week';
  return 'later';
}

export function percentText(p: number | null): string {
  return p === null ? '—' : `${String(Math.round(p))}%`;
}

/** "15:00" today, "Thu 08:00" this week, else the date. */
export function resetText(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const when = resetWhen(iso, now);
  if (when === 'today') return time;
  if (when === 'week') return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "in 2 h 14 min", "in 3 d 4 h", "now". */
export function countdown(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${String(m)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${String(h)} h ${String(m % 60)} min`;
  return `in ${String(Math.floor(h / 24))} d ${String(h % 24)} h`;
}

/** "2 min ago", "3 h ago". */
export function ageText(iso: string, now: number = Date.now()): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${String(m)} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${String(h)} h ago` : `${String(Math.round(h / 24))} d ago`;
}

/** Where the numbers come from, in words. */
export function sourceText(
  e: Pick<UsageEntry, 'source' | 'observedAt' | 'reports'>,
  now: number = Date.now(),
): string {
  if (e.source === null || e.observedAt === null)
    return e.reports
      ? 'No reading yet'
      : 'This machine’s worker does not report usage windows yet (update it)';
  const age = ageText(e.observedAt, now);
  if (e.source === 'probe') return `Read ${age}`;
  return `Last seen in ${e.source === 'job' ? 'a job' : 'a chat turn'} ${age}`;
}

export const LEVEL_TEXT: Readonly<Record<UsageLevel, string>> = {
  ok: 'OK',
  near: 'Near the limit',
  limited: 'Limit reached',
  unknown: 'No data',
};

/** The windows worth showing first: session, weekly, then the rest (model windows, spend). */
export function orderedWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  const rank = (w: UsageWindow): number =>
    w.kind === 'session' ? 0 : w.kind === 'weekly' ? 1 : w.kind === 'model_weekly' ? 2 : 3;
  return [...windows].sort((a, b) => rank(a) - rank(b));
}

/**
 * For the composer: the entries of one runtime, best (least used) store first — a job can run on any of the
 * machines that have it — and the runtime's overall level (limited only when every store is limited).
 */
export function runtimeSummary(
  entries: readonly UsageEntry[],
  runtime: string,
): {
  readonly best: UsageEntry | null;
  readonly stores: number;
  readonly level: UsageLevel;
  /** p13-runtime-accounts: the runtime has added accounts somewhere (lines name the account). */
  readonly multiAccount: boolean;
} {
  const mine = entries.filter((e) => e.runtime === runtime && e.auth === 'subscription');
  if (mine.length === 0) return { best: null, stores: 0, level: 'unknown', multiAccount: false };
  const score = (e: UsageEntry): number =>
    e.level === 'limited'
      ? 1000
      : Math.max(0, ...e.windows.map((w) => w.usedPercent ?? 0)) + (e.level === 'unknown' ? 500 : 0);
  const sorted = [...mine].sort((a, b) => score(a) - score(b));
  const best = sorted[0] ?? null;
  return {
    best,
    stores: mine.length,
    level: best?.level ?? 'unknown',
    multiAccount: mine.some((e) => e.account !== 'default'),
  };
}

/** p13-runtime-accounts: an account's name in limit lines ("Kişisel Max", "Varsayılan"). */
export function accountText(e: Pick<UsageEntry, 'account' | 'accountLabel'>): string {
  return e.accountLabel ?? (e.account === 'default' ? 'Varsayılan' : e.account);
}

/** p13-runtime-accounts: whether a machine's runtime has several accounts (rows then name each account). */
export function machineHasAccounts(
  entries: readonly UsageEntry[],
  workerId: string,
  runtime: string,
): boolean {
  return entries.some((e) => e.workerId === workerId && e.runtime === runtime && e.account !== 'default');
}

/** The highest used share of an entry's windows (0..100), null when none is known. */
export function topPercent(e: Pick<UsageEntry, 'windows'>): number | null {
  const known = e.windows.map((w) => w.usedPercent).filter((p): p is number => p !== null);
  return known.length === 0 ? null : Math.max(...known);
}
