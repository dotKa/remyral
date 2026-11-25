import { INTL_TAG, type Messages } from '@remyral/i18n';
import { type ReactNode, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  type CostClass,
  type Coverage,
  GROUP_BYS,
  type GroupBy,
  getUsageSummary,
  type UsageGroup,
  type UsageSummary,
} from '../../../api/usage';
import { cx, toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { type Period, periodRange } from '../../../screens/usage/format';
import { SOFT, type Tone } from '../../tone';
import { DyNotice } from '../kit';
import { DyButton, DySelect, EmptyLine, ErrorLine, Panel, SkeletonRows, StatTile, StatTiles } from '../parts';
import { TD, TH } from './common';
import { type UsageFormat, useUsageFormat } from './format';

/**
 * p12-diyalog-w2: Kullanım → Maliyet dökümü in the Diyalog language — the classic overview's data
 * (`GET /usage/summary`, same period / group-by) with the same provenance rules: every cost shows its source
 * (runtime-reported, estimated, unknown, subscription), "≥" when part of it is unknown, the missing prices with a
 * way to the price table for admins. One-series horizontal bars (magnitude, one hue; lower bounds hatched and
 * named), a hover title per bar, and the full table as the non-visual view. p14-i18n-screens-b: `usage.overview`.
 */

type UsageT = Messages['usage'];

function periods(t: UsageT['overview']): readonly (readonly [Period, string])[] {
  return [
    ['24h', t.periods.h24],
    ['7d', t.periods.d7],
    ['30d', t.periods.d30],
    ['90d', t.periods.d90],
    ['month', t.periods.month],
  ];
}

export function groupLabel(t: UsageT, g: GroupBy): string {
  return g === 'runtime' ? t.words.runtime : g === 'model' ? t.words.model : t.overview.groups[g];
}

const COVERAGE_TONE: Readonly<Record<CostClass, Tone>> = {
  reported: 'green',
  estimated: 'neutral',
  unknown: 'amber',
  subscription: 'violet',
};

export function CoverageChips(props: { readonly coverage: Coverage }): ReactNode {
  const t = useT().usage.overview;
  const usage = useUsageFormat();
  const { formatExact } = usage;
  const classes = (Object.keys(COVERAGE_TONE) as CostClass[]).filter((c) => props.coverage[c] > 0);
  if (classes.length === 0) return <span className="text-[0.8125rem] text-dy-muted">{t.noRecords}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {classes.map((c) => (
        <span
          key={c}
          title={t.coverage[c].help}
          data-testid={`badge-${c}`}
          className={cx(
            'relative inline-flex items-center gap-1 rounded-full px-2 py-px text-[0.75rem] font-bold whitespace-nowrap',
            SOFT[COVERAGE_TONE[c]],
          )}
        >
          {t.coverage[c].label}
          <span className="font-dy-mono font-normal">{formatExact(props.coverage[c])}</span>
          <span className="sr-only">{t.recordsHelp({ help: t.coverage[c].help })}</span>
        </span>
      ))}
    </span>
  );
}

export function costText(g: UsageGroup, u: UsageFormat, t: UsageT['overview']): string {
  if (g.flags.noPerRunCost) return t.noPerRunCost;
  if (g.records === 0) return '—';
  return `${g.flags.costComplete ? '' : '≥ '}${u.formatUsd(g.costUsd.total)}`;
}

function Bars(props: { readonly summary: UsageSummary }): ReactNode {
  const all = useT().usage;
  const t = all.overview;
  const fmt = useFormat();
  const usage = useUsageFormat();
  const { formatCount } = usage;
  const { summary } = props;
  const [metric, setMetric] = useState<'cost' | 'tokens'>(
    summary.totals.costUsd.total > 0 ? 'cost' : 'tokens',
  );
  const keyText = (k: string | null): string => k ?? t.notReported;
  const value = (g: UsageGroup): number =>
    metric === 'cost' ? g.costUsd.total : g.inputTokens + g.outputTokens;
  const rows = [...summary.groups].sort((a, b) => value(b) - value(a)).slice(0, 12);
  const max = Math.max(0, ...rows.map(value));
  const dim = groupLabel(all, summary.groupBy).toLocaleLowerCase(INTL_TAG[fmt.locale]);
  const lower = metric === 'cost' && rows.some((g) => !g.flags.costComplete);
  const show = (g: UsageGroup): string => (metric === 'cost' ? costText(g, usage, t) : formatCount(value(g)));
  return (
    <Panel
      title={metric === 'cost' ? t.knownCostBy({ dim }) : t.tokensBy({ dim })}
      aside={
        <div
          role="group"
          aria-label={t.metric}
          className="inline-flex rounded-[9px] border border-dy-line bg-dy-sunk p-0.5"
        >
          {(
            [
              ['cost', t.cost],
              ['tokens', all.words.token],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={metric === m}
              onClick={() => {
                setMetric(m);
              }}
              className={cx(
                'min-h-8 rounded-[7px] px-2.5 text-[0.8125rem] font-medium',
                metric === m ? 'bg-dy-card text-dy-ink shadow-dy-seg' : 'text-dy-muted',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      }
      testId="dy-usage-bars"
    >
      <ul className="m-0 grid list-none gap-2 p-0" data-testid="usage-chart">
        {rows.map((g) => {
          const v = value(g);
          const width = max > 0 ? Math.max(v > 0 ? 1 : 0, (v / max) * 100) : 0;
          const partial = metric === 'cost' && !g.flags.costComplete;
          return (
            <li
              key={g.key ?? '\u0000'}
              title={`${keyText(g.key)}: ${show(g)}`}
              className="grid grid-cols-[minmax(5rem,10rem)_minmax(0,1fr)_auto] items-center gap-3 text-[0.8125rem]"
            >
              <span className="truncate">{keyText(g.key)}</span>
              <span className="h-3 rounded-r-[4px]" aria-hidden="true">
                <span
                  className={cx(
                    'block h-3 rounded-r-[4px]',
                    partial
                      ? 'bg-[repeating-linear-gradient(135deg,var(--dy-teal)_0_3px,color-mix(in_oklab,var(--dy-teal)_45%,transparent)_3px_6px)]'
                      : 'bg-dy-teal',
                  )}
                  style={{ width: `${String(width)}%` }}
                />
              </span>
              <span className="text-right font-dy-mono tabular-nums">{show(g)}</span>
            </li>
          );
        })}
      </ul>
      {lower ? <p className="m-0 mt-2 text-[0.78125rem] text-dy-muted">{t.hatched}</p> : null}
    </Panel>
  );
}

function OverviewBody(props: {
  readonly summary: UsageSummary;
  readonly onAddPrices?: (() => void) | undefined;
}): ReactNode {
  const all = useT().usage;
  const t = all.overview;
  const usage = useUsageFormat();
  const { formatUsd, formatCount, formatExact, formatDurationMs } = usage;
  const { summary } = props;
  const tot = summary.totals;
  const missing = tot.missingPrices;
  const dim = groupLabel(all, summary.groupBy);
  return (
    <div className="flex flex-col gap-4">
      <StatTiles label={t.totals}>
        <StatTile
          label={t.knownCost}
          value={<span data-testid="overview-cost">{costText(tot, usage, t)}</span>}
          note={
            tot.flags.noPerRunCost
              ? t.subscriptionOnly
              : tot.flags.costComplete
                ? t.reportedEstimated({
                    reported: formatUsd(tot.costUsd.reported),
                    estimated: formatUsd(tot.costUsd.estimated),
                  })
                : t.lowerBound({ n: formatExact(tot.coverage.unknown) })
          }
          tone={tot.flags.costComplete ? undefined : 'amber'}
        />
        <StatTile
          label={t.tokensInOut}
          value={`${formatCount(tot.inputTokens)} / ${formatCount(tot.outputTokens)}`}
          note={
            tot.tokensUnknownRecords > 0
              ? t.noTokens({ n: formatExact(tot.tokensUnknownRecords) })
              : undefined
          }
        />
        <StatTile
          label={t.turns}
          value={formatCount(tot.turns)}
          note={
            tot.turnsUnknownRecords > 0 ? t.noTurns({ n: formatExact(tot.turnsUnknownRecords) }) : undefined
          }
        />
        <StatTile
          label={t.agentTime}
          value={formatDurationMs(tot.wallTimeMs)}
          note={
            tot.wallTimeUnknownRecords > 0
              ? t.noTime({ n: formatExact(tot.wallTimeUnknownRecords) })
              : undefined
          }
        />
      </StatTiles>

      <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-dy-muted">
        <span className="font-bold text-dy-ink">{t.sources}</span>
        <CoverageChips coverage={tot.coverage} />
        {tot.flags.hasSubscription ? <span className="w-full">{t.subscriptionNote}</span> : null}
      </div>

      {missing.length === 0 ? null : (
        <DyNotice
          tone="amber"
          action={
            props.onAddPrices === undefined ? undefined : (
              <DyButton variant="secondary" onClick={props.onAddPrices}>
                {t.addPrices}
              </DyButton>
            )
          }
        >
          <p className="m-0 font-bold">{t.missingTitle}</p>
          <ul className="m-0 mt-1 list-disc pl-5" data-testid="missing-prices">
            {missing.map((m) => (
              <li key={`${m.reason}-${m.provider}-${m.model}`}>
                <span className="font-dy-mono">
                  {m.provider} / {m.model}
                </span>{' '}
                {t.missingRecords({ n: formatExact(m.records), cache: m.reason === 'cache_price_missing' })}
              </li>
            ))}
          </ul>
        </DyNotice>
      )}

      {summary.groups.length === 0 ? (
        <Panel title={t.byDimension({ dim })} flush>
          <EmptyLine testId="usage-empty">{t.empty}</EmptyLine>
        </Panel>
      ) : (
        <>
          <Bars key={summary.groupBy} summary={summary} />
          <Panel title={t.byDimension({ dim })} count={String(summary.groups.length)}>
            <div
              className="-mx-4 overflow-x-auto px-4"
              tabIndex={0}
              role="region"
              aria-label={t.tableRegion({ dim })}
            >
              <table className="w-full min-w-[46rem]">
                <caption className="sr-only">{t.caption({ dim })}</caption>
                <thead>
                  <tr className="border-b border-dy-line">
                    <th scope="col" className={TH}>
                      {dim}
                    </th>
                    <th scope="col" className={TH}>
                      {t.records}
                    </th>
                    <th scope="col" className={TH}>
                      {t.tokensInOut}
                    </th>
                    <th scope="col" className={TH}>
                      {t.turns}
                    </th>
                    <th scope="col" className={TH}>
                      {t.duration}
                    </th>
                    <th scope="col" className={TH}>
                      {t.cost}
                    </th>
                    <th scope="col" className={TH}>
                      {t.source}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summary.groups.map((g) => (
                    <tr
                      key={g.key ?? '\u0000'}
                      className="border-t border-dy-line first:border-t-0"
                      data-testid="usage-row"
                    >
                      <th
                        scope="row"
                        className="max-w-[14rem] py-2 pr-4 text-left text-[0.875rem] font-medium [overflow-wrap:anywhere]"
                      >
                        {g.key === null ? (
                          <span className="text-dy-muted italic">{t.notReported}</span>
                        ) : (
                          g.key
                        )}
                      </th>
                      <td className={TD}>{formatExact(g.records)}</td>
                      <td className={TD}>
                        {formatCount(g.inputTokens)} / {formatCount(g.outputTokens)}
                        {g.tokensUnknownRecords > 0 ? <span className="text-dy-amber-ink"> *</span> : null}
                      </td>
                      <td className={TD}>{formatCount(g.turns)}</td>
                      <td className={TD}>{formatDurationMs(g.wallTimeMs)}</td>
                      <td className={TD} data-testid="usage-cost">
                        {costText(g, usage, t)}
                      </td>
                      <td className="py-2">
                        <CoverageChips coverage={g.coverage} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {summary.groups.some((g) => g.tokensUnknownRecords > 0) ? (
              <p className="m-0 mt-2 text-[0.78125rem] text-dy-muted">{t.someNoTokens}</p>
            ) : null}
          </Panel>
        </>
      )}
    </div>
  );
}

export function useSummary(
  groupBy: GroupBy,
  period: Period,
): { summary: UsageSummary | null; error: ApiError | null } {
  const [state, setState] = useState<{ summary: UsageSummary | null; error: ApiError | null }>({
    summary: null,
    error: null,
  });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, error: null }));
    getUsageSummary({ groupBy, ...periodRange(period) }).then(
      (summary) => {
        if (live) setState({ summary, error: null });
      },
      (err: unknown) => {
        if (live) setState({ summary: null, error: toApiError(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [groupBy, period]);
  return state;
}

export function OverviewView(props: { readonly onAddPrices?: (() => void) | undefined }): ReactNode {
  const all = useT().usage;
  const t = all.overview;
  const [groupBy, setGroupBy] = useState<GroupBy>('project');
  const [period, setPeriod] = useState<Period>('30d');
  const { summary, error } = useSummary(groupBy, period);
  return (
    <section aria-label={t.section} className="flex flex-col gap-4" data-testid="dy-overview">
      <div className="grid max-w-[480px] grid-cols-2 gap-2">
        <DySelect
          label={t.period}
          value={period}
          options={periods(t)}
          onChange={(v) => {
            setPeriod(v as Period);
          }}
        />
        <DySelect
          label={t.grouping}
          value={groupBy}
          options={GROUP_BYS.map((g) => [g, groupLabel(all, g)] as const)}
          onChange={(v) => {
            setGroupBy(v as GroupBy);
          }}
        />
      </div>
      <ErrorLine error={error} what={t.what} />
      {error !== null ? null : summary !== null && summary.groupBy === groupBy ? (
        <OverviewBody summary={summary} onAddPrices={props.onAddPrices} />
      ) : (
        <SkeletonRows label={t.loading} rows={3} />
      )}
    </section>
  );
}
