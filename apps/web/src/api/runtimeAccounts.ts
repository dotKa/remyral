import { apiRequest, obj, type RequestOptions, str } from './client';
import type { UsageLevel, UsageWindow } from './runtimeUsage';

/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md, ADR-0049): several Claude Code / Codex accounts per
 * machine — subscription logins in their own folders on the worker, or API keys from the vault — and the policy that
 * picks one. The master keeps labels, kinds, opaque ids and login states only (never a token or an identity).
 */

export type AccountRuntime = 'claude-code' | 'codex';
export type AccountKind = 'subscription' | 'api_key';
export type AccountState = 'logged_in' | 'needs_login' | 'paused' | 'limited' | 'unknown';
export type AccountLoginStatus = 'logged_in' | 'logged_out' | 'expired' | 'unknown' | 'unsupported';

export interface RuntimeAccount {
  readonly workerId: string;
  readonly workerName: string;
  readonly runtime: AccountRuntime;
  readonly id: string;
  readonly label: string;
  readonly kind: AccountKind;
  readonly credentialId: string | null;
  readonly store: string | null;
  readonly isDefault: boolean;
  readonly position: number;
  readonly paused: boolean;
  readonly pausedReason: string | null;
  readonly login: {
    readonly status: AccountLoginStatus | null;
    readonly reason: string | null;
    readonly checkedAt: string | null;
  };
  readonly state: AccountState;
  readonly limit: {
    readonly episodeId: string;
    readonly resetAt: string | null;
    readonly resumeAt: string;
  } | null;
  readonly usage: {
    readonly level: UsageLevel;
    readonly observedAt: string | null;
    readonly windows: readonly UsageWindow[];
  } | null;
  readonly running: number;
  readonly lendable: boolean;
  readonly supported: boolean;
}

export interface AccountsList {
  readonly accounts: readonly RuntimeAccount[];
  readonly workers: readonly { readonly id: string; readonly name: string; readonly supported: boolean }[];
}

export type AccountStrategy = 'balanced' | 'fill_first' | 'least_used';

export interface AccountPolicy {
  readonly strategy: AccountStrategy;
  readonly order: readonly string[];
  readonly skipPercent: number;
}

export const DEFAULT_ACCOUNT_POLICY: AccountPolicy = { strategy: 'balanced', order: [], skipPercent: 90 };

export const STRATEGY_TR: Readonly<Record<AccountStrategy, string>> = {
  balanced: 'Dengeli dağıt (varsayılan)',
  fill_first: 'Önce birini bitir (sıralı)',
  least_used: 'En az kullanılan',
};

export interface PolicyAccount {
  readonly ref: string;
  readonly workerId: string;
  readonly workerName: string;
  readonly runtime: AccountRuntime;
  readonly id: string;
  readonly label: string;
  readonly kind: AccountKind;
}

export interface ProjectAccountPolicy {
  readonly own: AccountPolicy | null;
  readonly effective: AccountPolicy;
  readonly source: 'project' | 'default';
  readonly defaults: AccountPolicy;
  readonly allowPaid: boolean;
  readonly accounts: readonly PolicyAccount[];
}

export type SwitchResult = 'pinned' | 'resuming' | 'pausing' | 'restarting';

type Opts = Omit<RequestOptions, 'body'>;

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const LEVELS: readonly UsageLevel[] = ['ok', 'near', 'limited', 'unknown'];
const level = (v: unknown): UsageLevel => (LEVELS.includes(v as UsageLevel) ? (v as UsageLevel) : 'unknown');
const STATES: readonly AccountState[] = ['logged_in', 'needs_login', 'paused', 'limited', 'unknown'];
const LOGINS: readonly AccountLoginStatus[] = [
  'logged_in',
  'logged_out',
  'expired',
  'unknown',
  'unsupported',
];

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

export function parseAccount(v: unknown): RuntimeAccount {
  const o = obj(v);
  const login = o.login === null || o.login === undefined ? {} : obj(o.login);
  const lim = o.limit === null || o.limit === undefined ? null : obj(o.limit);
  const usage = o.usage === null || o.usage === undefined ? null : obj(o.usage);
  const status = login.status;
  return {
    workerId: str(o, 'workerId'),
    workerName: typeof o.workerName === 'string' ? o.workerName : str(o, 'workerId'),
    runtime: o.runtime === 'codex' ? 'codex' : 'claude-code',
    id: str(o, 'id'),
    label: str(o, 'label'),
    kind: o.kind === 'api_key' ? 'api_key' : 'subscription',
    credentialId: strOrNull(o.credentialId),
    store: strOrNull(o.store),
    isDefault: o.isDefault === true,
    position: typeof o.position === 'number' ? o.position : 0,
    paused: o.paused === true,
    pausedReason: strOrNull(o.pausedReason),
    login: {
      status: LOGINS.includes(status as AccountLoginStatus) ? (status as AccountLoginStatus) : null,
      reason: strOrNull(login.reason),
      checkedAt: strOrNull(login.checkedAt),
    },
    state: STATES.includes(o.state as AccountState) ? (o.state as AccountState) : 'unknown',
    limit:
      lim === null
        ? null
        : {
            episodeId: str(lim, 'episodeId'),
            resetAt: strOrNull(lim.resetAt),
            resumeAt: str(lim, 'resumeAt'),
          },
    usage:
      usage === null
        ? null
        : {
            level: level(usage.level),
            observedAt: strOrNull(usage.observedAt),
            windows: Array.isArray(usage.windows) ? usage.windows.map(parseWindow) : [],
          },
    running: typeof o.running === 'number' ? o.running : 0,
    lendable: o.lendable === true,
    supported: o.supported !== false,
  };
}

function parseList(v: unknown): AccountsList {
  const o = obj(v);
  return {
    accounts: Array.isArray(o.accounts) ? o.accounts.map(parseAccount) : [],
    workers: Array.isArray(o.workers)
      ? o.workers.map((w) => {
          const x = obj(w);
          return {
            id: str(x, 'id'),
            name: strOrNull(x.name) ?? str(x, 'id'),
            supported: x.supported === true,
          };
        })
      : [],
  };
}

export function parsePolicy(v: unknown): AccountPolicy {
  const o = obj(v);
  const s = o.strategy;
  return {
    strategy: s === 'fill_first' || s === 'least_used' ? s : 'balanced',
    order: Array.isArray(o.order) ? o.order.filter((x): x is string => typeof x === 'string') : [],
    skipPercent: typeof o.skipPercent === 'number' ? o.skipPercent : 90,
  };
}

/** Bounds of the skip threshold (as the master checks them). */
export function policyProblem(p: AccountPolicy): string | null {
  if (!Number.isInteger(p.skipPercent) || p.skipPercent < 50 || p.skipPercent > 100) {
    return 'Eşik 50 ile 100 arasında bir tam sayı olmalı.';
  }
  return null;
}

const wid = (id: string) => `/workers/${encodeURIComponent(id)}`;

export function listRuntimeAccounts(
  q: { readonly worker?: string; readonly runtime?: string } = {},
  opts: Opts = {},
): Promise<AccountsList> {
  const p = new URLSearchParams();
  if (q.worker !== undefined) p.set('worker', q.worker);
  if (q.runtime !== undefined) p.set('runtime', q.runtime);
  const qs = p.toString();
  return apiRequest('GET', `/runtime-accounts${qs === '' ? '' : `?${qs}`}`, parseList, opts);
}

const accountOf = (v: unknown): RuntimeAccount => parseAccount(obj(v).account);

export function createRuntimeAccount(
  workerId: string,
  body: {
    readonly runtime: AccountRuntime;
    readonly label: string;
    readonly kind: AccountKind;
    readonly credentialId?: string;
  },
  opts: Opts = {},
): Promise<RuntimeAccount> {
  return apiRequest('POST', `${wid(workerId)}/runtime-accounts`, accountOf, { ...opts, body });
}

export function updateRuntimeAccount(
  workerId: string,
  runtime: AccountRuntime,
  account: string,
  body: {
    readonly label?: string;
    readonly paused?: boolean;
    readonly pausedReason?: string;
    readonly isDefault?: boolean;
    readonly position?: number;
  },
  opts: Opts = {},
): Promise<RuntimeAccount> {
  return apiRequest(
    'PATCH',
    `${wid(workerId)}/runtime-accounts/${runtime}/${encodeURIComponent(account)}`,
    accountOf,
    { ...opts, body },
  );
}

export function deleteRuntimeAccount(
  workerId: string,
  runtime: AccountRuntime,
  account: string,
  opts: Opts = {},
): Promise<void> {
  return apiRequest(
    'DELETE',
    `${wid(workerId)}/runtime-accounts/${runtime}/${encodeURIComponent(account)}`,
    () => undefined,
    opts,
  );
}

export function getAccountDefaults(
  opts: Opts = {},
): Promise<{ policy: AccountPolicy; updatedAt: string | null }> {
  return apiRequest(
    'GET',
    '/runtime-accounts/policy',
    (v) => {
      const o = obj(v);
      return { policy: parsePolicy(o.policy), updatedAt: strOrNull(o.updatedAt) };
    },
    opts,
  );
}

export function putAccountDefaults(policy: AccountPolicy, opts: Opts = {}): Promise<AccountPolicy> {
  return apiRequest(
    'PUT',
    '/runtime-accounts/policy',
    (v) => {
      const o = obj(v);
      return parsePolicy(o.policy ?? o);
    },
    { ...opts, body: { policy } },
  );
}

function parseProjectPolicy(v: unknown): ProjectAccountPolicy {
  const o = obj(v);
  return {
    own: o.own === null || o.own === undefined ? null : parsePolicy(o.own),
    effective: o.effective === undefined ? DEFAULT_ACCOUNT_POLICY : parsePolicy(o.effective),
    source: o.source === 'project' ? 'project' : 'default',
    defaults: o.defaults === undefined ? DEFAULT_ACCOUNT_POLICY : parsePolicy(o.defaults),
    allowPaid: o.allowPaid === true,
    accounts: Array.isArray(o.accounts)
      ? o.accounts.map((a) => {
          const x = obj(a);
          return {
            ref: str(x, 'ref'),
            workerId: str(x, 'workerId'),
            workerName: strOrNull(x.workerName) ?? str(x, 'workerId'),
            runtime: x.runtime === 'codex' ? ('codex' as const) : ('claude-code' as const),
            id: str(x, 'id'),
            label: str(x, 'label'),
            kind: x.kind === 'api_key' ? ('api_key' as const) : ('subscription' as const),
          };
        })
      : [],
  };
}

const pid = (id: string) => `/projects/${encodeURIComponent(id)}/account-policy`;

export function getProjectAccountPolicy(project: string, opts: Opts = {}): Promise<ProjectAccountPolicy> {
  return apiRequest('GET', pid(project), parseProjectPolicy, opts);
}

export function putProjectAccountPolicy(
  project: string,
  policy: AccountPolicy | null,
  opts: Opts = {},
): Promise<ProjectAccountPolicy> {
  return apiRequest('PUT', pid(project), parseProjectPolicy, { ...opts, body: { policy } });
}

export function switchJobAccount(
  jobId: string,
  body: { readonly workerId: string; readonly runtime?: string; readonly account: string },
  opts: Opts = {},
): Promise<SwitchResult> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/switch-account`,
    (v) => {
      const r = obj(v).result;
      return r === 'resuming' || r === 'pausing' || r === 'restarting' ? r : 'pinned';
    },
    { ...opts, body },
  );
}

// --------------------------------------------------------------------------------------------- texts (Turkish)

export const ACCOUNT_STATE_TR: Readonly<Record<AccountState, string>> = {
  logged_in: 'Hazır',
  needs_login: 'Giriş gerekli',
  paused: 'Duraklatıldı',
  limited: 'Limitte',
  unknown: 'Bilinmiyor',
};

export const ACCOUNT_KIND_TR: Readonly<Record<AccountKind, string>> = {
  subscription: 'Abonelik',
  api_key: 'API anahtarı',
};

export const SWITCH_RESULT_TR: Readonly<Record<SwitchResult, string>> = {
  pinned: 'İş bu hesaba sabitlendi; sıradaki yerleştirmede kullanılır.',
  resuming: 'İş seçilen hesapla aynı çalışma alanında sürdürülüyor.',
  pausing: 'Çalışan iş durduruluyor; ardından seçilen hesapla aynı çalışma alanında sürer.',
  restarting: 'İş seçilen hesabın makinesinde yeni deneme olarak başlıyor.',
};

/** The fullest window of an account (0..100), null when unknown. */
export function accountUsed(a: Pick<RuntimeAccount, 'usage'>): number | null {
  const known = (a.usage?.windows ?? []).map((w) => w.usedPercent).filter((p): p is number => p !== null);
  return known.length === 0 ? null : Math.max(...known);
}
