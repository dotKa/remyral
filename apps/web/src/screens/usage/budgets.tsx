import {
  type BudgetBilling,
  type BudgetInput,
  type BudgetMetric,
  type BudgetPolicy,
  type BudgetScopeType,
  type BudgetView,
  type BudgetWindow,
} from '../../api/usage';
import { formatCount, formatDurationMs, formatUsd } from './format';

/** The browser's IANA zone (falls back to UTC). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Runtimes a new budget can be scoped to (ADR-0023: OpenHands was removed). */
export const RUNTIMES = ['claude-code', 'codex', 'pi', 'opencode'] as const;

export function formatMetric(metric: BudgetMetric, n: number): string {
  switch (metric) {
    case 'cost_usd':
      return formatUsd(n);
    case 'wall_time_ms':
      return formatDurationMs(n);
    default:
      return formatCount(n);
  }
}

export interface FormState {
  name: string;
  metric: BudgetMetric;
  limit: string;
  scopeType: BudgetScopeType;
  scopeValue: string;
  window: BudgetWindow;
  enabled: boolean;
  /** p8-cost-efficiency (absent: the master's defaults). */
  billing?: BudgetBilling;
  timeZone?: string;
  thresholds?: string;
  onExceeded?: BudgetPolicy;
}

export const EMPTY: FormState = {
  name: '',
  metric: 'tokens',
  limit: '',
  scopeType: 'project',
  scopeValue: '',
  window: 'month',
  enabled: true,
  billing: 'all',
  timeZone: browserTimeZone(),
  thresholds: '50, 80, 100',
  onExceeded: 'pause_new',
};

export function toForm(v: BudgetView): FormState {
  const b = v.budget;
  return {
    name: b.name,
    metric: b.metric,
    limit: String(b.metric === 'wall_time_ms' ? b.limit / 3_600_000 : b.limit),
    scopeType: b.scope.type,
    scopeValue: b.scope.value ?? '',
    window: b.window,
    enabled: b.enabled,
    billing: b.billing,
    timeZone: b.timeZone,
    thresholds: b.thresholds.join(', '),
    onExceeded: b.onExceeded,
  };
}

/** "50, 80, 100" → [50, 80, 100]; null when not 1–5 whole percentages of 1–100. */
export function parseThresholds(s: string): number[] | null {
  const parts = s
    .split(/[,\s]+/)
    .map((x) => x.replace('%', '').trim())
    .filter((x) => x !== '');
  if (parts.length === 0 || parts.length > 5) return null;
  const n = parts.map(Number);
  if (!n.every((x) => Number.isInteger(x) && x >= 1 && x <= 100)) return null;
  return [...new Set(n)].sort((a, b) => a - b);
}

/** Validates the form; agent time is entered in hours and sent in milliseconds. */
export function formToInput(f: FormState): {
  input: BudgetInput | null;
  errors: Partial<Record<keyof FormState, string>>;
} {
  const errors: Partial<Record<keyof FormState, string>> = {};
  if (f.name.trim() === '') errors.name = 'Give the budget a name.';
  const n = Number(f.limit);
  if (f.limit.trim() === '' || !Number.isFinite(n) || n <= 0) errors.limit = 'Enter a limit greater than 0.';
  else if ((f.metric === 'tokens' || f.metric === 'turns') && !Number.isInteger(n))
    errors.limit = 'Use a whole number.';
  if (f.scopeType !== 'global' && f.scopeValue.trim() === '') errors.scopeValue = 'Required for this scope.';
  const thresholds = f.thresholds === undefined ? undefined : parseThresholds(f.thresholds);
  if (thresholds === null)
    errors.thresholds = 'Up to five whole percentages from 1 to 100, e.g. 50, 80, 100.';
  if (f.billing === 'subscription' && f.metric === 'cost_usd') {
    errors.billing = 'Subscription runs have no per-run dollars: budget them by tokens, turns or hours.';
  }
  if (f.timeZone !== undefined && f.timeZone.trim() === '')
    errors.timeZone = 'Enter a time zone, e.g. Europe/Istanbul.';
  if (Object.keys(errors).length > 0) return { input: null, errors };
  return {
    input: {
      name: f.name.trim(),
      metric: f.metric,
      limit: f.metric === 'wall_time_ms' ? Math.round(n * 3_600_000) : n,
      scope: { type: f.scopeType, value: f.scopeType === 'global' ? null : f.scopeValue.trim() },
      window: f.window,
      enabled: f.enabled,
      ...(f.billing === undefined ? {} : { billing: f.billing }),
      ...(f.timeZone === undefined ? {} : { timeZone: f.timeZone.trim() }),
      ...(thresholds === undefined || thresholds === null ? {} : { thresholds }),
      ...(f.onExceeded === undefined ? {} : { onExceeded: f.onExceeded }),
    },
    errors,
  };
}
