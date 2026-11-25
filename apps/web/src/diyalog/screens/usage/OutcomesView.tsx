import { type ReactNode, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import type { Messages } from '@remyral/i18n';
import { type JobStatsRow, listJobStats, STATS_GROUPS, type StatsGroup } from '../../../api/routing';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { machineName, useMachineNames } from '../../../lib/machineDirectory';
import { useResetPageOn } from '../../../lib/pageReset';
import { useClientPage } from '../../../lib/pager';
import { RuntimeMark } from '../../RuntimeMark';
import { DyCheck, DyPager } from '../kit';
import { EmptyLine, ErrorLine, Panel, SkeletonRows } from '../parts';
import { TD, TH } from './common';

/**
 * p12-diyalog-w2: Kullanım → Sonuçlar, the `job_stats` rollup (success rate, p50 / p90 attempt duration, cost per
 * attempt) per runtime × model × kind × project × machine, as the scheduler ranks machines — the classic
 * `listJobStats` call and client paging (`?outcomesPage=`), drawn in the Diyalog language.
 */

function groupText(t: Messages['usage'], g: StatsGroup): string {
  return g === 'runtime' ? t.words.runtime : g === 'model' ? t.words.model : t.outcomes.groups[g];
}

type SortKey = 'attempts' | 'success' | null;

export function OutcomesView(): ReactNode {
  const all = useT().usage;
  const t = all.outcomes;
  const fmt = useFormat();
  const pct = (v: number | null): string => (v === null ? '–' : fmt.percent(v));
  const sec = (v: number | null): string => (v === null ? '–' : fmt.duration(Math.max(0, v) * 1000));
  const usd4 = (v: number): string =>
    fmt.number(v, {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });
  const [groupBy, setGroupBy] = useState<StatsGroup[]>(['runtime', 'model', 'kind']);
  const [rows, setRows] = useState<JobStatsRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: null, desc: true });
  const key = groupBy.join(',');
  const names = useMachineNames();
  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    listJobStats({ groupBy: key === '' ? [] : (key.split(',') as StatsGroup[]) }).then(
      (r) => {
        if (live) setRows(r);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  const sorted =
    rows === null || sort.key === null
      ? (rows ?? [])
      : [...rows].sort((a, b) => {
          const d =
            sort.key === 'attempts' ? a.attempts - b.attempts : (a.successRate ?? -1) - (b.successRate ?? -1);
          return sort.desc ? -d : d;
        });
  const page = useClientPage(sorted, { label: t.pages, prefix: 'outcomes' });
  useResetPageOn(key, 'outcomes');
  const dims = STATS_GROUPS.filter((g) => groupBy.includes(g));
  const cell = (r: JobStatsRow, g: StatsGroup): ReactNode => {
    switch (g) {
      case 'runtime':
        return r.runtime === null ? '–' : <RuntimeMark runtime={r.runtime} />;
      case 'model':
        return r.model === '' ? t.machineDefault : (r.model ?? '–');
      case 'kind':
        return r.kind === '' ? t.unclassified : (r.kind ?? '–');
      case 'project':
        return <span className="font-dy-mono">{r.project ?? '–'}</span>;
      default:
        return r.workerId === null ? '–' : machineName(names, r.workerId);
    }
  };
  const sortHead = (k: Exclude<SortKey, null>, label: string): ReactNode => (
    <th
      scope="col"
      className={TH}
      aria-sort={sort.key === k ? (sort.desc ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 font-medium text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
        onClick={() => {
          setSort((s) => ({ key: k, desc: s.key === k ? !s.desc : true }));
        }}
      >
        {label}
        <span aria-hidden="true">{sort.key === k ? (sort.desc ? '↓' : '↑') : '↕'}</span>
      </button>
    </th>
  );
  return (
    <Panel
      title={t.title}
      count={rows === null ? undefined : String(rows.length)}
      sub={t.sub}
      testId="dy-outcomes"
    >
      <fieldset className="m-0 mb-3 flex flex-wrap gap-x-5 gap-y-2 border-0 p-0">
        <legend className="mb-1.5 p-0 text-[0.8125rem] font-bold">{t.grouping}</legend>
        {STATS_GROUPS.map((g) => (
          <DyCheck
            key={g}
            label={groupText(all, g)}
            checked={groupBy.includes(g)}
            onChange={(on) => {
              setGroupBy((cur) => STATS_GROUPS.filter((x) => (x === g ? on : cur.includes(x))));
            }}
          />
        ))}
      </fieldset>
      <ErrorLine error={error} what={t.what} />
      {rows === null ? (
        error === null ? (
          <SkeletonRows label={t.loading} rows={3} />
        ) : null
      ) : rows.length === 0 ? (
        <EmptyLine>{t.empty}</EmptyLine>
      ) : (
        <>
          <div className="-mx-4 overflow-x-auto px-4" tabIndex={0} role="region" aria-label={t.region}>
            <table className="w-full min-w-[40rem]" data-testid="outcomes-table">
              <caption className="sr-only">{t.caption}</caption>
              <thead>
                <tr className="border-b border-dy-line">
                  {dims.map((g) => (
                    <th key={g} scope="col" className={TH}>
                      {groupText(all, g)}
                    </th>
                  ))}
                  {sortHead('attempts', t.attempts)}
                  {sortHead('success', t.success)}
                  <th scope="col" className={TH}>
                    {all.words.p50}
                  </th>
                  <th scope="col" className={TH}>
                    {all.words.p90}
                  </th>
                  <th scope="col" className={TH}>
                    {t.perAttempt}
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.pageItems.map((r) => (
                  <tr
                    key={JSON.stringify([r.runtime, r.model, r.kind, r.project, r.workerId])}
                    className="border-t border-dy-line first:border-t-0"
                    data-testid="outcome-row"
                  >
                    {dims.map((g) => (
                      <td key={g} className="py-2 pr-4 text-[0.875rem] [overflow-wrap:anywhere]">
                        {cell(r, g)}
                      </td>
                    ))}
                    <td className={TD}>{r.attempts}</td>
                    <td className={TD}>{pct(r.successRate)}</td>
                    <td className={TD}>{sec(r.p50DurationSec)}</td>
                    <td className={TD}>{sec(r.p90DurationSec)}</td>
                    <td className={TD}>{r.costPerAttemptUsd === null ? '–' : usd4(r.costPerAttemptUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DyPager {...page.pagination} className="-mx-4 -mb-4" />
        </>
      )}
    </Panel>
  );
}
