import { type PointerEvent, type ReactNode, useId, useState } from 'react';
import type { SeriesPoint, SeriesRange } from '../../../api/uptime';
import { cx } from '../../../components/ui';
import { runs } from './shared';
import { HH_MM } from '../../common/time';
import type { Formatter } from '@remyral/i18n';
import { useFormat } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog-w2: the monitor page's chart — one series (average latency per bucket, teal 2 px line with a 10 %
 * wash; a bucket without checks breaks the line) on one axis, and under it a strip of uptime buckets: a red tick for
 * every bucket that was not fully up (status colour, explained in the legend line, never alone: the hover tooltip and
 * the figures table say the percent). Hover / touch: a crosshair with the bucket's time, latency, uptime and check
 * count. Screen readers get a summary sentence; "Rakamları göster" opens the same numbers as a table.
 */

const W = 640;
const H = 180;
const STRIP = 14;

function timeLabel(iso: string, range: SeriesRange, f: Formatter): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return range === '24h'
    ? f.dateWith(d, HH_MM)
    : f.dateWith(d, {
        day: 'numeric',
        month: 'short',
        ...(range === '7d' ? { hour: '2-digit', minute: '2-digit' } : {}),
      });
}

const ms = (v: number | null): string => (v === null ? '—' : `${String(Math.round(v))} ms`);
const up = (v: number | null): string => (v === null ? '—' : `%${v >= 99.995 ? '100' : v.toFixed(2)}`);

/** A rounded top for the axis: 1 / 2 / 5 × 10^n. */
function niceMax(v: number): number {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export function chartSummary(points: readonly SeriesPoint[], rangeWord: string): string {
  const lat = points.map((p) => p.latencyAvg).filter((v): v is number => v !== null);
  const down = points.filter((p) => p.uptime !== null && p.uptime < 100).length;
  const latText =
    lat.length === 0
      ? 'gecikme ölçümü yok'
      : `gecikme en düşük ${String(Math.round(Math.min(...lat)))} ms, en yüksek ${String(Math.round(Math.max(...lat)))} ms`;
  return `Son ${rangeWord}: ${latText}; ${down === 0 ? 'her dilimde tamamen ayakta' : `${String(down)} dilimde tam ayakta değil`}.`;
}

export function LatencyChart(props: {
  readonly points: readonly SeriesPoint[];
  readonly range: SeriesRange;
  readonly rangeWord: string;
}): ReactNode {
  const fmt = useFormat();
  const { points, range } = props;
  const [hover, setHover] = useState<number | null>(null);
  const tableId = useId();
  const n = points.length;
  const lat = points.map((p) => p.latencyAvg);
  const top = niceMax(Math.max(0, ...lat.map((v) => v ?? 0)));
  const plotH = H - STRIP - 8;
  const x = (i: number): number => (n <= 1 ? W / 2 : (i * W) / (n - 1));
  const y = (v: number): number => plotH - (v / top) * (plotH - 6);
  const xPct = (i: number): number => (x(i) / W) * 100;
  const yPct = (v: number): number => (y(v) / H) * 100;
  const step = n <= 1 ? W : W / (n - 1);
  const segments = runs(lat);
  /** One uptime cell per bucket, centred on its point, clipped to the plot, a 2 px gap between cells. */
  const cell = (i: number): { x: number; w: number } => {
    const l = Math.max(0, x(i) - step / 2 + 1);
    const r = Math.min(W, x(i) + step / 2 - 1);
    return { x: l, w: Math.max(2, r - l) };
  };
  const summary = chartSummary(points, props.rangeWord);
  const ticks = [top, top / 2, 0];

  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0 || n === 0) return;
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(f * (n - 1)));
  };
  const hp = hover === null ? undefined : points[hover];

  return (
    <figure className="m-0" data-testid="latency-chart">
      <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-2">
        <div className="relative" aria-hidden="true">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 font-dy-mono text-[0.6875rem] text-dy-faint tabular-nums"
              style={{ top: `${String(yPct(t))}%` }}
            >
              {Math.round(t)} ms
            </span>
          ))}
        </div>
        <div
          className="relative h-[180px] touch-pan-y"
          role="img"
          aria-label={summary}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => {
            setHover(null);
          }}
        >
          <svg
            viewBox={`0 0 ${String(W)} ${String(H)}`}
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible text-dy-teal"
            aria-hidden="true"
          >
            {ticks.map((t) => (
              <line
                key={t}
                x1={0}
                x2={W}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--dy-line)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {segments.map((seg) => {
              const first = seg[0];
              const end = seg[seg.length - 1];
              const line = seg
                .map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`)
                .join(' ');
              const area =
                first === undefined || end === undefined || seg.length < 2
                  ? null
                  : `${line} L${x(end.i).toFixed(1)} ${String(plotH)} L${x(first.i).toFixed(1)} ${String(plotH)} Z`;
              return (
                <g key={first?.i ?? 0} data-testid="chart-segment">
                  {area === null ? null : <path d={area} fill="currentColor" opacity={0.1} />}
                  <path
                    d={line}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })}
            {points.map((p, i) =>
              p.uptime !== null && p.uptime < 100 ? (
                <rect
                  key={p.t}
                  data-testid="uptime-dip"
                  x={cell(i).x}
                  y={H - STRIP}
                  width={cell(i).w}
                  height={STRIP}
                  rx={2}
                  className="fill-dy-red"
                />
              ) : p.uptime !== null ? (
                <rect
                  key={p.t}
                  x={cell(i).x}
                  y={H - STRIP + 5}
                  width={cell(i).w}
                  height={4}
                  rx={2}
                  className="fill-dy-green"
                  opacity={0.45}
                />
              ) : null,
            )}
            {hover === null ? null : (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={0}
                y2={H}
                stroke="var(--dy-ink)"
                strokeOpacity={0.35}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {hp === undefined || hover === null || hp.latencyAvg === null ? null : (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dy-card bg-dy-teal"
              style={{ left: `${String(xPct(hover))}%`, top: `${String(yPct(hp.latencyAvg))}%` }}
            />
          )}
          {hp === undefined || hover === null ? null : (
            <div
              role="status"
              data-testid="chart-tooltip"
              className={cx(
                'pointer-events-none absolute top-1 z-[1] min-w-[9.5rem] rounded-[10px] border border-dy-line bg-dy-card px-2.5 py-1.5 text-[0.78125rem] shadow-dy',
                xPct(hover) > 60 ? '-translate-x-[calc(100%+10px)]' : 'translate-x-[10px]',
              )}
              style={{ left: `${String(xPct(hover))}%` }}
            >
              <div className="font-bold">{timeLabel(hp.t, range, fmt)}</div>
              <div className="flex justify-between gap-3 text-dy-muted">
                Gecikme <span className="font-dy-mono text-dy-ink">{ms(hp.latencyAvg)}</span>
              </div>
              <div className="flex justify-between gap-3 text-dy-muted">
                Ayakta <span className="font-dy-mono text-dy-ink">{up(hp.uptime)}</span>
              </div>
              <div className="flex justify-between gap-3 text-dy-muted">
                Kontrol <span className="font-dy-mono text-dy-ink">{hp.checks}</span>
              </div>
            </div>
          )}
        </div>
      </div>
      <figcaption className="mt-2 ml-[3.75rem] flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[0.75rem] text-dy-muted">
        <span>
          {points[0] === undefined ? '' : timeLabel(points[0].t, '7d', fmt)} –{' '}
          {points[n - 1] === undefined ? '' : timeLabel(points[n - 1]?.t ?? '', '7d', fmt)}
        </span>
        <span className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-0.5 w-3.5 rounded bg-dy-teal" aria-hidden="true" />
            ortalama gecikme
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-1.5 rounded-sm bg-dy-red" aria-hidden="true" />
            tam ayakta değil
          </span>
        </span>
      </figcaption>
      <details className="mt-2 ml-[3.75rem] text-[0.8125rem]">
        <summary className="w-fit cursor-pointer font-medium text-dy-teal-ink" aria-controls={tableId}>
          Rakamları göster
        </summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-[10px] border border-dy-line">
          <table id={tableId} className="w-full border-collapse text-left" data-testid="chart-table">
            <caption className="sr-only">{summary}</caption>
            <thead className="sticky top-0 bg-dy-sunk text-dy-muted">
              <tr>
                <th className="px-3 py-1.5 font-medium">Zaman</th>
                <th className="px-3 py-1.5 text-right font-medium">Gecikme</th>
                <th className="px-3 py-1.5 text-right font-medium">Ayakta</th>
                <th className="px-3 py-1.5 text-right font-medium">Kontrol</th>
              </tr>
            </thead>
            <tbody className="font-dy-mono tabular-nums">
              {points.map((p) => (
                <tr key={p.t} className="border-t border-dy-line">
                  <td className="px-3 py-1 font-dy">{timeLabel(p.t, range, fmt)}</td>
                  <td className="px-3 py-1 text-right">{ms(p.latencyAvg)}</td>
                  <td
                    className={cx(
                      'px-3 py-1 text-right',
                      p.uptime !== null && p.uptime < 100 && 'font-bold text-dy-red-ink',
                    )}
                  >
                    {up(p.uptime)}
                  </td>
                  <td className="px-3 py-1 text-right">{p.checks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
