import { type ReactNode, useId } from 'react';
import type { TrendPoint } from '../../../api/efficiency';
import { cx } from '../../../components/ui';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { hoursText } from './common';
import { type UsageFormat, useUsageFormat } from './format';

/**
 * p12-diyalog Faz 4: spend per period as stacked columns (dataviz rules): API-billed dollars (solid teal) under the
 * subscription API-equivalent estimate (the lighter step of the same ramp — an estimate, never money spent). Columns
 * ≤ 24 px with a 4 px rounded data end, square at the baseline, a 2 px surface gap between the two segments and
 * between columns; a hairline recessive grid; text in text tokens only. Every column has a hover title; screen
 * readers get a summary line and the numbers as a table ("Rakamları göster").
 */

/** A clean axis top: 1 / 2 / 2.5 / 5 × 10^n at or above `max`. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= max) return m * exp;
  return 10 * exp;
}

function tick(n: number, u: UsageFormat): string {
  if (n === 0) return '$0';
  return n >= 1000 ? `$${u.formatCount(n)}` : u.formatUsd(n).replace(/[.,]00$/, '');
}

export function spendSummary(
  points: readonly TrendPoint[],
  u: UsageFormat,
  t: Messages['usage']['chart'],
): string {
  if (points.length === 0) return t.noSpend;
  const total = points.reduce((s, p) => s + p.costUsd, 0);
  const eq = points.reduce((s, p) => s + p.apiEquivalentUsd, 0);
  const top = points.reduce((a, b) =>
    b.costUsd + b.apiEquivalentUsd > a.costUsd + a.apiEquivalentUsd ? b : a,
  );
  return t.summary({
    n: points.length,
    total: u.formatUsd(total),
    eq: u.formatUsd(eq),
    top: top.key,
    topUsd: u.formatUsd(top.costUsd + top.apiEquivalentUsd),
  });
}

export function SpendChart(props: { readonly points: readonly TrendPoint[] }): ReactNode {
  const all = useT().usage;
  const t = all.chart;
  const fmt = useFormat();
  const usage = useUsageFormat();
  const { formatUsd, formatCount, spendText } = usage;
  const pts = props.points;
  const sumId = useId();
  const max = niceMax(Math.max(0, ...pts.map((p) => p.costUsd + p.apiEquivalentUsd)));
  const hasEq = pts.some((p) => p.apiEquivalentUsd > 0);
  const first = pts[0];
  const last = pts[pts.length - 1];
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-3" aria-describedby={sumId} data-testid="dy-spend-chart">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem] text-dy-muted">
        <span className="inline-flex items-center gap-1.5">
          <i className="size-2.5 rounded-[3px] bg-dy-teal" aria-hidden="true" />
          {t.legendApi}
        </span>
        {hasEq ? (
          <span className="inline-flex items-center gap-1.5">
            <i className="size-2.5 rounded-[3px] bg-dy-teal/35" aria-hidden="true" />
            {t.legendEquivalent}
          </span>
        ) : null}
      </div>
      {pts.length === 0 ? (
        <p className="m-0 py-6 text-center text-[0.875rem] text-dy-muted">{t.noRecords}</p>
      ) : (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
          <div
            className="flex h-40 flex-col justify-between py-0 text-right font-dy-mono text-[0.75rem] text-dy-faint tabular-nums"
            aria-hidden="true"
          >
            <span className="-translate-y-1/2">{tick(max, usage)}</span>
            <span>{tick(max / 2, usage)}</span>
            <span className="translate-y-1/2">$0</span>
          </div>
          <div className="relative h-40" aria-hidden="true">
            <i className="absolute inset-x-0 top-0 h-px bg-dy-line" />
            <i className="absolute inset-x-0 top-1/2 h-px bg-dy-line" />
            <i className="absolute inset-x-0 bottom-0 h-px bg-dy-line-2" />
            <ul className="absolute inset-0 m-0 flex list-none items-end justify-around gap-[2px] p-0">
              {pts.map((p) => {
                const api = (p.costUsd / max) * 100;
                const eq = (p.apiEquivalentUsd / max) * 100;
                const tip = `${t.tip({ key: p.key, spend: spendText(p) })}${p.apiEquivalentUsd > 0 ? t.tipEstimate({ usd: formatUsd(p.apiEquivalentUsd) }) : ''}`;
                return (
                  <li
                    key={p.key}
                    title={tip}
                    className="flex h-full max-w-6 min-w-[2px] flex-1 flex-col justify-end gap-[2px] [@media(hover:hover)_and_(pointer:fine)]:hover:opacity-80"
                  >
                    {eq > 0 ? (
                      <span
                        className={cx('block w-full bg-dy-teal/35', 'rounded-t-[4px]')}
                        style={{ height: `${String(eq)}%` }}
                      />
                    ) : null}
                    {api > 0 ? (
                      <span
                        className={cx('block w-full bg-dy-teal', eq > 0 ? 'rounded-none' : 'rounded-t-[4px]')}
                        style={{ height: `${String(api)}%` }}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
          <span />
          <div
            className="mt-1 flex justify-between font-dy-mono text-[0.75rem] text-dy-faint"
            aria-hidden="true"
          >
            <span>{first?.key}</span>
            {pts.length > 1 ? <span>{last?.key}</span> : null}
          </div>
        </div>
      )}
      <figcaption id={sumId} className="text-[0.8125rem] text-dy-muted">
        {spendSummary(pts, usage, t)}
      </figcaption>
      {pts.length === 0 ? null : (
        <details className="text-[0.8125rem]">
          <summary className="tap cursor-pointer text-dy-muted">{t.showNumbers}</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left">
              <caption className="sr-only">{t.caption}</caption>
              <thead className="text-dy-muted">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t.period}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t.apiSpend}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t.apiEquivalent}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {all.words.token}
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    {t.agentTime}
                  </th>
                </tr>
              </thead>
              <tbody className="font-dy-mono tabular-nums">
                {pts.map((p) => (
                  <tr key={p.key} className="border-t border-dy-line">
                    <th scope="row" className="py-1 pr-3 font-normal">
                      {p.key}
                    </th>
                    <td className="py-1 pr-3">{spendText(p)}</td>
                    <td className="py-1 pr-3">
                      {p.subscriptionRecords > 0 ? `≈ ${formatUsd(p.apiEquivalentUsd)}` : '—'}
                    </td>
                    <td className="py-1 pr-3">{formatCount(p.inputTokens + p.outputTokens)}</td>
                    <td className="py-1">{hoursText(all, fmt, p.wallTimeMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}
