import { type ReactNode, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import type { Formatter, Messages } from '@remyral/i18n';
import { listProjects, type Project } from '../../../api/directory';
import {
  getRuntimeOutcomes,
  type MatrixCell,
  type OutcomeMatrix as Matrix,
} from '../../../api/runtimeAdvice';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useUsageFormat } from './format';
import { RuntimeMark, runtimeDisplayName } from '../../RuntimeMark';
import { DySelect, EmptyLine, ErrorLine, Panel, Pill, SkeletonRows } from '../parts';

/**
 * p12-diyalog Faz 4: Kullanım → Sonuçlar, the runtime × work-area matrix in the Diyalog language. Same data and the
 * same numbers as the classic matrix (`GET /usage/runtime-outcomes`: smoothed good-outcome rate, its interval, n,
 * raw rate, median time, mean cost, the 30-day trend, the models) — the rate is the value, a teal bar (one hue,
 * sequential) shows it with the interval drawn behind; the area's recommended runtime carries a word ("önerilen").
 */

type MatrixT = Messages['usage']['matrix'];

function trendText(c: MatrixCell, t: MatrixT): string | null {
  if (c.recent.rate === null || c.previous.rate === null) return null;
  const d = Math.round((c.recent.rate - c.previous.rate) * 100);
  if (d === 0) return t.steady;
  return t.points({ arrow: d > 0 ? '▲' : '▼', n: Math.abs(d) });
}

/** A work area's name ("Frontend", "Testler" / "Tests"); an area the catalog does not know reads as sent. */
export function areaText(t: MatrixT, a: string | null): string {
  if (a === null) return t.areas.unclassified;
  return Object.hasOwn(t.areas, a) ? t.areas[a as keyof MatrixT['areas']] : a;
}

/** Seconds as the console's duration ("12 dk 05 sn" / "12 min 05 s"); "–" when unknown. */
function secText(f: Formatter, sec: number | null): string {
  return sec === null ? '–' : f.duration(Math.max(0, sec) * 1000);
}

function Cell(props: { readonly c: MatrixCell | undefined; readonly recommended: boolean }): ReactNode {
  const t = useT().usage.matrix;
  const fmt = useFormat();
  const { formatUsd } = useUsageFormat();
  const { c } = props;
  if (c === undefined) return <span className="text-dy-faint">–</span>;
  const tr = trendText(c, t);
  const pct = (v: number | null): string => (v === null ? '–' : fmt.percent(v));
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-testid={`matrix-cell-${c.area ?? 'unclassified'}-${c.runtime}`}
    >
      <span className="flex flex-wrap items-baseline gap-x-2">
        <b className="text-[1.0625rem] font-extrabold">{pct(c.rate)}</b>
        <span className="font-dy-mono text-[0.75rem] text-dy-muted">
          {pct(c.low)}–{pct(c.high)}
        </span>
        {props.recommended ? (
          <Pill tone="teal" icon="check">
            {t.recommended}
          </Pill>
        ) : null}
      </span>
      <span
        className="relative block h-1.5 w-full max-w-[160px] overflow-hidden rounded-full bg-dy-line"
        aria-hidden="true"
      >
        <i
          className="absolute inset-y-0 bg-dy-teal-soft"
          style={{
            left: `${String(c.low * 100)}%`,
            width: `${String(Math.max(0, (c.high - c.low) * 100))}%`,
          }}
        />
        <i
          className="absolute inset-y-0 left-0 rounded-full bg-dy-teal"
          style={{ width: `${String(c.rate * 100)}%` }}
        />
      </span>
      <span className="text-[0.75rem] text-dy-muted">
        {t.stats({ n: c.n, raw: pct(c.rawRate), median: secText(fmt, c.medianDurationSec) })}
        {c.meanCostUsd === null ? '' : ` · ${formatUsd(c.meanCostUsd)}`}
        {tr === null ? '' : ` · ${tr}`}
      </span>
      {c.models.length > 1 ? (
        <span className="text-[0.75rem] text-dy-faint">
          {c.models
            .map((m) => `${m.model === '' ? t.defaultModel : m.model} ${String(m.good)}/${String(m.n)}`)
            .join(', ')}
        </span>
      ) : null}
    </div>
  );
}

export function OutcomeMatrix(): ReactNode {
  const t = useT().usage.matrix;
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [project, setProject] = useState('');
  const [m, setM] = useState<Matrix | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    listProjects().then(
      (p) => {
        setProjects(p);
        setProject((cur) => (cur === '' ? (p[0]?.id ?? '') : cur));
      },
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
  }, []);

  useEffect(() => {
    if (project === '') return;
    let live = true;
    setM(null);
    setError(null);
    getRuntimeOutcomes(project).then(
      (r) => {
        if (live) setM(r);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [project]);

  const areas = m === null ? [] : m.areas.filter((a) => m.cells.some((c) => c.area === a));
  const rec = new Map((m?.advice ?? []).map((a) => [a.area ?? '', a.recommended] as const));
  return (
    <Panel
      title={t.title}
      testId="dy-outcome-matrix"
      sub={t.sub}
      aside={
        projects !== null && projects.length > 0 ? (
          <DySelect
            label={t.project}
            value={project}
            options={projects.map((p) => [p.id, p.name] as const)}
            onChange={setProject}
            className="min-w-[180px]"
          />
        ) : undefined
      }
    >
      <ErrorLine error={error} what={t.what} />
      {m === null ? (
        error === null && project !== '' ? (
          <SkeletonRows label={t.loading} rows={3} />
        ) : projects !== null && projects.length === 0 ? (
          <EmptyLine>{t.noProjects}</EmptyLine>
        ) : null
      ) : m.cells.length === 0 ? (
        <EmptyLine>{t.empty}</EmptyLine>
      ) : (
        <>
          <div className="-mx-4 overflow-x-auto px-4" tabIndex={0} role="region" aria-label={t.region}>
            <table className="w-full min-w-[36rem] border-collapse" data-testid="runtime-area-matrix">
              <caption className="sr-only">{t.caption}</caption>
              <thead>
                <tr className="border-b border-dy-line">
                  <th scope="col" className="py-2 pr-4 text-left text-[0.78125rem] font-medium text-dy-muted">
                    {t.area}
                  </th>
                  {m.runtimes.map((r) => (
                    <th key={r} scope="col" className="py-2 pr-4 text-left text-[0.8125rem] font-medium">
                      <RuntimeMark runtime={r} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {areas.map((a) => (
                  <tr
                    key={a ?? 'unclassified'}
                    className="border-t border-dy-line align-top first:border-t-0"
                  >
                    <th scope="row" className="py-3 pr-4 text-left text-[0.875rem] font-bold">
                      {areaText(t, a)}
                    </th>
                    {m.runtimes.map((r) => (
                      <td key={r} className="py-3 pr-4">
                        <Cell
                          c={m.cells.find((c) => c.area === a && c.runtime === r)}
                          recommended={rec.get(a ?? '') === r}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul
            className="m-0 mt-3 grid list-none gap-1.5 p-0 text-[0.875rem]"
            data-testid="runtime-area-advice"
          >
            {m.advice.map((a) => (
              <li key={a.area ?? 'unclassified'} className="flex flex-wrap items-baseline gap-2">
                <b className="font-bold">{areaText(t, a.area)}</b>
                {a.recommended === null ? null : (
                  <span className="text-dy-muted">→ {runtimeDisplayName(a.recommended)}</span>
                )}
                <span className="min-w-0 basis-full text-dy-muted sm:basis-auto">{a.text}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 mt-3 text-[0.75rem] text-dy-faint">
            {t.footer({
              jobs: m.jobs,
              min: m.settings.minSamples,
              half: m.settings.halfLifeDays,
              mode: m.settings.mode,
            })}
          </p>
        </>
      )}
    </Panel>
  );
}
