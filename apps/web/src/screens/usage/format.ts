/** Display helpers for the Usage section (docs/design/p6-cost.md §7). */

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const INTEGER = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const USD_BIG = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const USD_SMALL = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n > 0 && n < 0.0001) return '<$0.0001';
  return n >= 1 ? USD_BIG.format(n) : USD_SMALL.format(n);
}

export function formatCount(n: number): string {
  return n < 10_000 ? INTEGER.format(n) : COMPACT.format(n);
}

export function formatDurationMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)} min ${String(s % 60).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  return `${String(h)} h ${String(m % 60).padStart(2, '0')} min`;
}

export type Period = '24h' | '7d' | '30d' | '90d' | 'month';

/** `[from, to)` for a period ending now (`to` is one second ahead so the newest record is included). */
export function periodRange(p: Period, now: number = Date.now()): { from: string; to: string } {
  const to = new Date(now + 1000);
  const day = 86_400_000;
  let from: Date;
  switch (p) {
    case '24h':
      from = new Date(now - day);
      break;
    case '7d':
      from = new Date(now - 7 * day);
      break;
    case '30d':
      from = new Date(now - 30 * day);
      break;
    case '90d':
      from = new Date(now - 90 * day);
      break;
    case 'month': {
      const d = new Date(now);
      from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      break;
    }
  }
  return { from: from.toISOString(), to: to.toISOString() };
}
