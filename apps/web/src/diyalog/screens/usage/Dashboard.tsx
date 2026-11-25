import type { Messages } from '@remyral/i18n';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import { saveWithLink } from '../../../api/download';
import {
  type Dashboard as DashboardData,
  type DashboardQuery,
  DIMENSIONS,
  type Dimension,
  downloadCsv,
  getDashboard,
  type Grain,
  GRAINS,
  type TopJob,
} from '../../../api/efficiency';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useResetPageOn } from '../../../lib/pageReset';
import { useClientPage } from '../../../lib/pager';
import { browserTimeZone } from '../../../screens/usage/budgets';
import { type DashPeriod, dashRange } from '../../../screens/usage/dashRange';
import { DyIcon } from '../../icons';
import { RuntimeMark } from '../../RuntimeMark';
import {
  DyButton,
  DySelect,
  ErrorLine,
  Panel,
  Row,
  Rows,
  SkeletonRows,
  StatTile,
  StatTiles,
  ThreadLink,
} from '../parts';
import { DyPager } from '../kit';
import { LimitWindows } from './LimitWindows';
import { hoursText } from './common';
import { SpendChart } from './SpendChart';
import { type UsageFormat, useUsageFormat } from './format';

/**
 * p12-diyalog Faz 4: Kullanım → Pano in the Diyalog language — the classic dashboard's data (`GET /usage/dashboard`,
 * same filters, same CSV exports, same provenance rules: "≥" when part of the cost is unknown, subscription usage
 * only as an API-equivalent *estimate*) as stat tiles, a spend chart, the runtime limit windows, the breakdown, the
 * costliest / slowest jobs (each opens its job thread) and the savings. p14-i18n-screens-b: `usage.dashboard`.
 */

type UsageT = Messages['usage'];

export function dimensionLabel(t: UsageT, d: Dimension): string {
  return d === 'runtime' ? t.words.runtime : d === 'model' ? t.words.model : t.dashboard.dimensions[d];
}

function periods(t: UsageT['dashboard']): readonly (readonly [DashPeriod, string])[] {
  return [
    ['7d', t.periods.d7],
    ['30d', t.periods.d30],
    ['90d', t.periods.d90],
    ['month', t.periods.month],
    ['last-month', t.periods.lastMonth],
  ];
}

type Billing = 'all' | 'api' | 'subscription';

function perSuccess(v: number | null, complete: boolean, u: UsageFormat): string {
  return v === null ? '—' : `${complete ? '' : '≥ '}${u.formatUsd(v)}`;
}

const TH = 'py-2 pr-4 text-left text-[0.78125rem] font-medium text-dy-muted';
const TD = 'py-2 pr-4 font-dy-mono text-[0.84375rem] tabular-nums';

function Breakdown(props: { readonly d: DashboardData }): ReactNode {
  const all = useT().usage;
  const t = all.dashboard;
  const usage = useUsageFormat();
  const { formatUsd, formatCount, formatPercent, spendText } = usage;
  const { d } = props;
  const page = useClientPage(d.breakdown.rows, { label: t.breakdownPages, prefix: 'breakdown' });
  useResetPageOn(d.breakdown.dimension, 'breakdown');
  const dim = dimensionLabel(all, d.breakdown.dimension);
  return (
    <Panel title={t.byDimension({ dim })} count={String(d.breakdown.rows.length)} testId="dy-breakdown">
      <div
        className="-mx-4 overflow-x-auto px-4"
        tabIndex={0}
        role="region"
        aria-label={t.breakdownRegion({ dim })}
      >
        <table className="w-full min-w-[40rem]" data-testid="dash-breakdown">
          <caption className="sr-only">{t.breakdownCaption({ dim })}</caption>
          <thead>
            <tr className="border-b border-dy-line">
              <th scope="col" className={TH}>
                {dim}
              </th>
              <th scope="col" className={TH}>
                {t.cols.apiSpend}
              </th>
              <th scope="col" className={TH}>
                {t.cols.subscriptionEstimate}
              </th>
              <th scope="col" className={TH}>
                {all.words.token}
              </th>
              <th scope="col" className={TH}>
                {t.cols.jobs}
              </th>
              <th scope="col" className={TH}>
                {t.cols.success}
              </th>
              <th scope="col" className={TH}>
                {t.cols.perSuccess}
              </th>
            </tr>
          </thead>
          <tbody>
            {page.pageItems.map((r) => (
              <tr key={r.key ?? '∅'} className="border-t border-dy-line first:border-t-0">
                <th
                  scope="row"
                  className="py-2 pr-4 text-left text-[0.875rem] font-medium [overflow-wrap:anywhere]"
                >
                  {d.breakdown.dimension === 'runtime' && r.key !== null ? (
                    <RuntimeMark runtime={r.key} />
                  ) : (
                    r.label
                  )}
                </th>
                <td className={TD}>{spendText(r.spend)}</td>
                <td className={TD}>
                  {r.spend.subscriptionRecords > 0 ? `≈ ${formatUsd(r.spend.apiEquivalentUsd)}` : '—'}
                </td>
                <td className={TD}>{formatCount(r.spend.inputTokens + r.spend.outputTokens)}</td>
                <td className={TD}>{formatCount(r.jobs)}</td>
                <td className={TD}>{r.successRate === null ? '—' : formatPercent(r.successRate)}</td>
                <td className={TD}>{perSuccess(r.costPerSuccessUsd, r.costPerSuccessComplete, usage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DyPager {...page.pagination} className="-mx-4 -mb-4" />
    </Panel>
  );
}

function JobRows(props: {
  readonly title: string;
  readonly jobs: readonly TopJob[];
  readonly testId: string;
}): ReactNode {
  const all = useT().usage;
  const usage = useUsageFormat();
  const { formatUsd, formatDurationMs, spendText } = usage;
  if (props.jobs.length === 0) return null;
  return (
    <Panel title={props.title} count={String(props.jobs.length)} flush testId={props.testId}>
      <Rows label={props.title}>
        {props.jobs.map((j) => (
          <Row
            key={j.jobId}
            lead={<DyIcon name="jobs" className="size-4" />}
            title={
              <Link
                to={`/jobs/${encodeURIComponent(j.jobId)}`}
                className="font-dy-mono no-underline hover:underline"
              >
                {j.jobId.slice(0, 8)}
              </Link>
            }
            meta={
              <>
                <span>{j.project}</span>
                <RuntimeMark runtime={j.runtime} />
                {j.model === null ? null : <span className="font-dy-mono">{j.model}</span>}
                <span>{j.state.toLowerCase()}</span>
              </>
            }
            trail={
              <span className="flex flex-col font-dy-mono text-[0.8125rem] tabular-nums sm:items-end">
                <span>{spendText(j)}</span>
                <span className="text-dy-muted">
                  {j.durationSec === null ? '—' : formatDurationMs(j.durationSec * 1000)}
                  {j.apiEquivalentUsd > 0
                    ? ` · ${all.dashboard.estimate({ usd: formatUsd(j.apiEquivalentUsd) })}`
                    : ''}
                </span>
              </span>
            }
            actions={
              <ThreadLink
                target={{ kind: 'job', id: j.jobId }}
                about={all.jobAbout({ id: j.jobId.slice(0, 8) })}
              />
            }
          />
        ))}
      </Rows>
    </Panel>
  );
}

export function DashboardBody(props: { readonly d: DashboardData }): ReactNode {
  const all = useT().usage;
  const t = all.dashboard;
  const fmt = useFormat();
  const usage = useUsageFormat();
  const { formatUsd, formatCount, formatDurationMs, formatPercent, spendText } = usage;
  const { d } = props;
  const tot = d.totals;
  const o = d.outcomes;
  const s = d.savings;
  return (
    <div className="flex flex-col gap-4">
      {d.truncated ? (
        <p
          role="note"
          className="m-0 rounded-[10px] bg-dy-amber-soft px-3.5 py-2.5 text-[0.875rem] text-dy-amber-ink"
        >
          {t.truncated}
        </p>
      ) : null}
      <StatTiles label={t.summary}>
        <StatTile
          label={t.apiSpend}
          value={<span data-testid="dash-spend">{spendText(tot)}</span>}
          note={tot.costComplete ? t.fromSources : t.unknownCost({ n: tot.unknownCostRecords })}
          tone={tot.costComplete ? undefined : 'amber'}
        />
        <StatTile
          label={t.subscription}
          value={
            <span data-testid="dash-subscription">
              {t.records({ n: formatCount(tot.subscriptionRecords) })}
            </span>
          }
          note={
            tot.subscriptionRecords === 0
              ? t.noneThisPeriod
              : t.apiEquivalent({ usd: formatUsd(tot.apiEquivalentUsd) })
          }
        />
        <StatTile
          label={t.tokensTurns}
          value={`${formatCount(tot.inputTokens + tot.outputTokens)} · ${formatCount(tot.turns)}`}
          note={t.agentTime({ h: hoursText(all, fmt, tot.wallTimeMs) })}
        />
        <StatTile
          label={t.perSuccess}
          value={perSuccess(o.costPerSuccessUsd, o.costPerSuccessComplete, usage)}
          note={`${t.outcomes({ ok: o.succeeded, failed: o.failed })}${o.successRate === null ? '' : ` · ${formatPercent(o.successRate)}`}`}
          tone={o.failed > o.succeeded ? 'red' : undefined}
        />
      </StatTiles>
      <div className="grid gap-4 min-[1100px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Panel title={t.spendPerPeriod} sub={t.spendSub}>
          <SpendChart points={d.trends} />
        </Panel>
        <LimitWindows />
      </div>
      <Breakdown d={d} />
      <div className="grid gap-4 min-[1100px]:grid-cols-2">
        <JobRows title={t.topCostly} jobs={d.topCostly} testId="dash-top-costly" />
        <JobRows title={t.slowest} jobs={d.slowest} testId="dash-slowest" />
      </div>
      {d.successRates.length > 0 ? (
        <Panel title={t.successTitle} sub={t.successSub}>
          <div className="-mx-4 overflow-x-auto px-4" tabIndex={0} role="region" aria-label={t.successTitle}>
            <table className="w-full min-w-[34rem]">
              <thead>
                <tr className="border-b border-dy-line">
                  <th scope="col" className={TH}>
                    {all.words.runtime}
                  </th>
                  <th scope="col" className={TH}>
                    {all.words.model}
                  </th>
                  <th scope="col" className={TH}>
                    {t.attempts}
                  </th>
                  <th scope="col" className={TH}>
                    {t.success}
                  </th>
                  <th scope="col" className={TH}>
                    {t.p50Duration}
                  </th>
                  <th scope="col" className={TH}>
                    {t.perAttempt}
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.successRates.map((r) => (
                  <tr
                    key={`${r.runtime ?? ''}:${r.model ?? ''}`}
                    className="border-t border-dy-line first:border-t-0"
                  >
                    <td className="py-2 pr-4 text-[0.875rem]">
                      {r.runtime === null ? '—' : <RuntimeMark runtime={r.runtime} />}
                    </td>
                    <td className={TD}>{r.model === null || r.model === '' ? t.defaultModel : r.model}</td>
                    <td className={TD}>{formatCount(r.attempts)}</td>
                    <td className={TD}>{r.successRate === null ? '—' : formatPercent(r.successRate)}</td>
                    <td className={TD}>
                      {r.p50DurationSec === null ? '—' : formatDurationMs(r.p50DurationSec * 1000)}
                    </td>
                    <td className={TD}>
                      {r.costPerAttemptUsd === null ? '—' : formatUsd(r.costPerAttemptUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
      <section aria-label={t.savings} data-testid="dash-savings">
        <StatTiles label={t.savings} className="sm:grid-cols-3">
          <StatTile
            label={t.reuse}
            value={t.hits({ n: formatCount(s.reuse.hits) })}
            note={t.reuseNote({
              time: formatDurationMs(s.reuse.estimatedSeconds * 1000),
              usd: formatUsd(s.reuse.estimatedCostUsd),
            })}
            tone="green"
          />
          <StatTile label={t.warm} value={t.runs({ n: formatCount(s.warmCaches.runs) })} note={t.warmNote} />
          <StatTile
            label={t.autoApprove}
            value={t.commands({ n: formatCount(s.safeAutoApprove.approvals) })}
            note={t.autoApproveNote({
              time: formatDurationMs(s.safeAutoApprove.estimatedSecondsSaved * 1000),
              measured: s.safeAutoApprove.measured,
            })}
          />
        </StatTiles>
      </section>
      {d.missingPrices.length > 0 ? (
        <p
          role="note"
          className="m-0 rounded-[10px] bg-dy-amber-soft px-3.5 py-2.5 text-[0.875rem] text-dy-amber-ink"
        >
          {t.missingPrices({ list: d.missingPrices.map((m) => `${m.provider} / ${m.model}`).join(', ') })}
        </p>
      ) : null}
    </div>
  );
}

export function DashboardTab(props: { readonly canExportJobs: boolean }): ReactNode {
  const all = useT().usage;
  const t = all.dashboard;
  const [period, setPeriod] = useState<DashPeriod>('30d');
  const [grain, setGrain] = useState<Grain>('day');
  const [dimension, setDimension] = useState<Dimension>('project');
  const [billing, setBilling] = useState<Billing>('all');
  const [zone] = useState(browserTimeZone);
  const [d, setD] = useState<DashboardData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [exportError, setExportError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<'breakdown' | 'jobs' | null>(null);
  const [tick, setTick] = useState(0);

  const query: DashboardQuery = { ...dashRange(period), grain, timeZone: zone, dimension, billing };
  useEffect(() => {
    let live = true;
    setError(null);
    setD(null);
    getDashboard({ ...dashRange(period), grain, timeZone: zone, dimension, billing }).then(
      (v) => {
        if (live) setD(v);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [period, grain, zone, dimension, billing, tick]);

  async function exportCsv(kind: 'breakdown' | 'jobs'): Promise<void> {
    setBusy(kind);
    setExportError(null);
    try {
      await downloadCsv(kind, query, saveWithLink);
    } catch (err) {
      setExportError(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label={t.section} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-0 flex-[1_1_520px] grid-cols-2 gap-2 sm:grid-cols-4">
          <DySelect
            label={t.period}
            value={period}
            options={periods(t)}
            onChange={(v) => {
              setPeriod(v as DashPeriod);
            }}
          />
          <DySelect
            label={t.grain}
            value={grain}
            options={GRAINS.map((g) => [g, t.grains[g]] as const)}
            onChange={(v) => {
              setGrain(v as Grain);
            }}
          />
          <DySelect
            label={t.breakdown}
            value={dimension}
            options={DIMENSIONS.map((x) => [x, dimensionLabel(all, x)] as const)}
            onChange={(v) => {
              setDimension(v as Dimension);
            }}
          />
          <DySelect
            label={t.billing}
            value={billing}
            options={[
              ['all', t.billingAll],
              ['api', t.billingApi],
              ['subscription', t.billingSubscription],
            ]}
            onChange={(v) => {
              setBilling(v as Billing);
            }}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <DyButton icon="tray" busy={busy === 'breakdown'} onClick={() => void exportCsv('breakdown')}>
            {t.breakdownCsv}
          </DyButton>
          {props.canExportJobs ? (
            <DyButton icon="tray" busy={busy === 'jobs'} onClick={() => void exportCsv('jobs')}>
              {t.jobsCsv}
            </DyButton>
          ) : null}
        </div>
      </div>
      <p className="-mt-2 m-0 text-[0.75rem] text-dy-faint">{t.timeZone({ zone })}</p>
      <ErrorLine error={exportError} what={t.csvExport} />
      <ErrorLine
        error={error}
        what={t.what}
        onRetry={() => {
          setTick((n) => n + 1);
        }}
      />
      {d === null ? (
        error === null ? (
          <SkeletonRows label={t.loading} rows={4} />
        ) : null
      ) : (
        <DashboardBody d={d} />
      )}
    </section>
  );
}
