import type { Formatter } from '@remyral/i18n';
import { useFormat } from '../../../i18n/I18nProvider';

/**
 * p14-i18n-shell (i18n Phase 2): the Usage section's number helpers (classic `screens/usage/format.ts`, which stays
 * English for the classic console) bound to the Diyalog language — "$12,50" / "12,3 B" / "3 dk 05 sn" / "%42" in
 * Turkish, "$12.50" / "12.3K" / "3 min 05 s" / "42%" in English. Same names and rules as the classic helpers, so a
 * component reads them with `const { formatUsd, … } = useUsageFormat()`.
 */
export interface UsageFormat {
  readonly formatUsd: (n: number) => string;
  readonly formatCount: (n: number) => string;
  readonly formatExact: (n: number) => string;
  readonly formatDurationMs: (ms: number) => string;
  readonly formatPercent: (ratio: number) => string;
  /** "≥ $3,00" — a spend, marked as a lower bound when some prices are missing. */
  readonly spendText: (s: { readonly costUsd: number; readonly costComplete: boolean }) => string;
}

const USD = { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' } as const;

export function usageFormat(f: Formatter): UsageFormat {
  const usd = (n: number, max: number): string =>
    f.number(n, { ...USD, minimumFractionDigits: 2, maximumFractionDigits: max });
  const formatUsd = (n: number): string => {
    if (n > 0 && n < 0.0001) return `<${usd(0.0001, 4)}`;
    return usd(n, n === 0 || n >= 1 ? 2 : 4);
  };
  return {
    formatUsd,
    spendText: (s) => `${s.costComplete ? '' : '≥ '}${formatUsd(s.costUsd)}`,
    formatCount: (n) => (n < 10_000 ? f.number(n, { maximumFractionDigits: 0 }) : f.compact(n)),
    formatExact: (n) => f.number(n, { maximumFractionDigits: 0 }),
    formatDurationMs: (ms) => f.duration(ms),
    formatPercent: (ratio) => f.percent(ratio),
  };
}

export function useUsageFormat(): UsageFormat {
  return usageFormat(useFormat());
}
