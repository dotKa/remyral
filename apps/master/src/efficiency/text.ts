import type { BudgetBilling, BudgetMetric, BudgetOnExceeded } from '@remyral/usage';

/**
 * p8-cost-efficiency: display helpers shared by notifications, quota hold reasons, the weekly report and the chat
 * note. Built from numbers, enumerations and identifiers only.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

/** "Sun 1 Nov 2026, 00:00 (Europe/Istanbul)" — an instant on the wall clock of `timeZone`. */
export function localTime(at: Date, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      return at.toISOString();
    }
    if (formatters.size > 128) formatters.clear();
    formatters.set(timeZone, f);
  }
  return `${f.format(at)} (${timeZone})`;
}

function trim(n: number, digits: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/\.?0+$/, '');
}

/** An amount of a budget metric: "$12.50", "1.2M tokens", "14 turns", "3.5 h". */
export function metricAmount(metric: BudgetMetric, n: number): string {
  switch (metric) {
    case 'cost_usd':
      return `$${n.toFixed(2)}`;
    case 'tokens':
      return n >= 1_000_000
        ? `${trim(n / 1_000_000, 2)}M tokens`
        : n >= 10_000
          ? `${trim(n / 1000, 1)}k tokens`
          : `${String(Math.round(n))} tokens`;
    case 'turns':
      return `${String(Math.round(n))} turns`;
    case 'wall_time_ms':
      return `${trim(n / 3_600_000, 2)} h`;
  }
}

export const BILLING_TEXT: Readonly<Record<BudgetBilling, string>> = {
  all: 'all usage',
  api: 'API-billed usage',
  subscription: 'subscription usage',
};

export const ON_EXCEEDED_TEXT: Readonly<Record<BudgetOnExceeded, string>> = {
  warn: 'warn only',
  pause_new: 'pause new jobs',
  block_automations: 'block automations only',
};

export function scopeText(scope: { readonly type: string; readonly value: string | null }): string {
  return scope.value === null ? scope.type : `${scope.type} ${scope.value}`;
}
