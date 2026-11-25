import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  CAPACITY_MODES,
  type CapacityMetrics,
  type CapacityMode,
  type CapacityView,
  getCapacity,
  setCapacity,
} from '../../../../api/capacity';
import type { CapacityModeSummary } from '../../../../api/fleet';
import { bulkWorkerConfig } from '../../../../api/workerConfig';
import { formatGb } from '../../../../screens/fleet/capacityAdvice';
import { chartSeries } from '../../../../screens/fleet/capacityChart';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyApiError, DyDetails, DyField, DyNotice, FormActions } from '../../forms';
import { DyButton, Panel, SkeletonRows } from '../../parts';
import { useGuardedValue } from './admin-guard';
import { useCardForm } from '../../../formkit';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC, TIME_NUMERIC } from '../../../common/time';
import { useDoneToast } from '../../../toast/useDoneToast';

/**
 * p12-diyalog wave 2 (W3) — Makine → Genel bakış → Kapasite modu (p8-capacity-auto) in the Diyalog language. The
 * classic `CapacityModeCard` rules: manual / suggest / auto; what runs now and who decides; the last decision with
 * its reasons; the live measurements; a suggestion with "Uygula" (managed configuration, step-up, the classic change
 * note); the history as a step chart and a list; and for admins the mode form (bounds 1 ≤ min ≤ max ≤ 64, auto only
 * on a panel-managed machine), saved with step-up. Details are read when opened (open by default when not manual)
 * and refreshed every 30 s while open.
 */

type ModeText = Messages['machineAdmin']['mode'];

/** Why the upper limit is what it is (the classic `upperReason`). */
export function upperReasonText(t: ModeText, v: CapacityView): string {
  if (v.hardwareCeiling !== null && v.upper === v.hardwareCeiling && v.upper < v.max) return t.upperHardware;
  if (v.mode === 'auto' && v.reportedMax !== null && v.upper === v.reportedMax && v.upper < v.max)
    return t.upperMachine;
  return t.upperYours;
}

export function modeText(t: ModeText, v: CapacityView): string {
  const n = v.effective === null ? '?' : String(v.effective);
  switch (v.mode) {
    case 'manual':
      return t.sentenceManual({ n });
    case 'suggest':
      return t.sentenceSuggest({ n });
    case 'auto':
      return t.sentenceAuto({
        slots: v.slots ?? 0,
        min: v.min,
        max: v.max,
        upper: v.upper,
        reason: upperReasonText(t, v),
      });
  }
}

function decisionText(t: ModeText, action: string): string {
  return action === 'raise' || action === 'lower' || action === 'clamp' || action === 'hold'
    ? t.decision[action]
    : action;
}

export function metricsText(t: ModeText, m: CapacityMetrics): string {
  const x = t.metric;
  const parts: string[] = [];
  if (m.cpuPercent !== null) parts.push(x.cpu({ pct: Math.round(m.cpuPercent) }));
  if (m.memoryAvailableBytes !== null)
    parts.push(
      x.memoryFree({
        total: m.memoryTotalBytes === null ? null : formatGb(m.memoryTotalBytes),
        free: formatGb(m.memoryAvailableBytes),
      }),
    );
  if (m.swapTotalBytes !== null && m.swapTotalBytes > 0 && m.swapUsedBytes !== null)
    parts.push(x.swap({ used: formatGb(m.swapUsedBytes), total: formatGb(m.swapTotalBytes) }));
  if (m.swapInPerSec !== null) parts.push(x.swapIn({ n: Math.round(m.swapInPerSec) }));
  if (m.commitPercent !== null) parts.push(x.commit({ pct: Math.round(m.commitPercent) }));
  if (m.memoryPressurePercent !== null) parts.push(x.pressure({ pct: Math.round(m.memoryPressurePercent) }));
  parts.push(x.running({ n: m.running }), x.waiting({ n: m.waiting }));
  if (m.oomFailures > 0) parts.push(x.oom({ n: m.oomFailures }));
  if (m.timeouts > 0) parts.push(x.timeouts({ n: m.timeouts }));
  return parts.join(' · ');
}

function HistoryChart(props: { readonly view: CapacityView }): ReactNode {
  const fmt = useFormat();
  const t = useT().machineAdmin.mode;
  const v = props.view;
  const now = Date.now();
  const current = v.mode === 'auto' ? v.slots : v.effective;
  const { line, dots } = chartSeries(v.events, now, current);
  if (line.length < 2 && dots.length === 0) return null;
  const W = 600;
  const H = 140;
  const pad = { l: 28, r: 8, t: 8, b: 20 };
  const all = [...line, ...dots];
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(now, ...all.map((p) => p.t));
  const vMax = Math.max(1, v.upper, ...all.map((p) => p.v)) + 1;
  const x = (t: number): number => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (n: number): number => pad.t + (1 - n / vMax) * (H - pad.t - pad.b);
  let d = '';
  line.forEach((p, i) => {
    d +=
      i === 0 ? `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}` : `H${x(p.t).toFixed(1)}V${y(p.v).toFixed(1)}`; // i18n-ignore: SVG path
  });
  const step = vMax > 12 ? Math.ceil(vMax / 6) : vMax > 6 ? 2 : 1;
  const ticks: number[] = [];
  for (let n = 0; n < vMax; n += step) ticks.push(n);
  const label = t.chartLabel({
    from: String(line[0]?.v ?? '?'),
    to: String(line.at(-1)?.v ?? '?'),
    n: v.events.length,
  });
  return (
    <figure className="m-0 flex flex-col gap-1" data-testid="capacity-chart">
      <svg viewBox={`0 0 ${String(W)} ${String(H)}`} className="h-36 w-full" role="img" aria-label={label}>
        <title>{label}</title>
        {ticks.map((n) => (
          <g key={n}>
            <line x1={pad.l} x2={W - pad.r} y1={y(n)} y2={y(n)} stroke="var(--dy-line)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(n) + 4} textAnchor="end" fill="var(--dy-muted)" fontSize={11}>
              {n}
            </text>
          </g>
        ))}
        {v.mode === 'auto' ? (
          <line
            x1={pad.l}
            x2={W - pad.r}
            y1={y(v.upper)}
            y2={y(v.upper)}
            stroke="var(--dy-amber)"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
        ) : null}
        <path d={d} fill="none" stroke="var(--dy-teal)" strokeWidth={2} strokeLinejoin="round" />
        {dots.map((p) => (
          <circle
            key={`${String(p.t)}-${String(p.v)}`}
            cx={x(p.t)}
            cy={y(p.v)}
            r={4}
            fill="var(--dy-green)"
            stroke="var(--dy-card)"
            strokeWidth={2}
          />
        ))}
        <text x={pad.l} y={H - 4} fill="var(--dy-muted)" fontSize={11}>
          {fmt.dateWith(t0, DATE_TIME_NUMERIC)}
        </text>
        <text x={W - pad.r} y={H - 4} textAnchor="end" fill="var(--dy-muted)" fontSize={11}>
          {t.now}
        </text>
      </svg>
      <figcaption className="text-[0.78125rem] text-dy-muted">
        {t.legend({ auto: v.mode === 'auto', dots: dots.length > 0 })}
      </figcaption>
    </figure>
  );
}

export function CapacityModePanel(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly summary: CapacityModeSummary | null;
  readonly isAdmin: boolean;
  readonly onChanged: () => void;
  /** Tests: polling off. */
  readonly refreshMs?: number;
}): ReactNode {
  const fmt = useFormat();
  const all = useT().machineAdmin;
  const t = all.mode;
  const { workerId } = props;
  const [view, setView] = useState<CapacityView | null>(null);
  const load = useSubmit();
  const save = useSubmit();
  const guarded = useGuardedValue();
  const [mode, setMode] = useState<CapacityMode>('manual');
  const [min, setMin] = useState('1');
  const [max, setMax] = useState('1');
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const formId = useId();
  const [open, setOpen] = useState(props.summary !== null && props.summary.mode !== 'manual');
  const { run } = load;

  const refresh = useCallback(
    async (resetForm: boolean) => {
      await run(async () => {
        const v = await getCapacity(workerId);
        setView(v);
        if (resetForm) {
          setMode(v.mode);
          setMin(String(v.min));
          setMax(String(v.max));
        }
      });
    },
    [workerId, run],
  );

  // p15-form-pattern: the mode form is a section of the Genel bakış capacity form (its sticky bar saves it). The hook
  // sits before the early returns; the save itself is the `submit` below.
  const submitRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const card = useCardForm({
    dirty:
      props.isAdmin &&
      open &&
      view !== null &&
      (mode !== view.mode || Number(min) !== view.min || Number(max) !== view.max),
    busy: save.busy,
    save: () => submitRef.current(),
    discard: () => {
      if (view === null) return;
      setMode(view.mode);
      setMin(String(view.min));
      setMax(String(view.max));
    },
  });

  useEffect(() => {
    if (!open) return;
    void refresh(true);
    const every = props.refreshMs ?? 30_000;
    if (every <= 0) return;
    const t = setInterval(() => void refresh(false), every);
    return () => {
      clearInterval(t);
    };
  }, [refresh, props.refreshMs, open]);

  if (!open)
    return (
      <Panel title={t.title} testId="capacity-mode">
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 min-w-0 flex-1 text-[0.875rem]" data-testid="capacity-mode-sentence">
            {t.closed}
          </p>
          <DyButton
            onClick={() => {
              setOpen(true);
            }}
            data-testid="capacity-mode-open"
          >
            {props.isAdmin ? t.setUp : all.details}
          </DyButton>
        </div>
      </Panel>
    );

  if (view === null)
    return (
      <Panel title={t.title} flush testId="capacity-mode">
        {load.error === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : (
          <DyApiError error={load.error} retryLeft={load.retryLeft} className="px-4 pb-4" />
        )}
      </Panel>
    );

  const v = view;
  const minN = Number(min);
  const maxN = Number(max);
  const boundsError =
    !Number.isInteger(minN) || !Number.isInteger(maxN) || minN < 1 || maxN > 64 || minN > maxN
      ? t.boundsError
      : null;
  const dirty = mode !== v.mode || minN !== v.min || maxN !== v.max;
  const autoBlocked = mode === 'auto' && !v.managed;

  const submit = async (): Promise<boolean> => {
    setDone(null);
    if (boundsError !== null && mode !== 'manual') return false;
    if (autoBlocked) return false;
    let saved = false;
    const ok = await save.run(async () => {
      const next = await guarded(
        () => setCapacity(workerId, { mode, min: minN, max: maxN }),
        all.stepUp({
          machine: props.workerName,
          what: t.why({ mode: t.modes[mode].label.toLocaleLowerCase(fmt.locale) }),
        }),
      );
      if (next !== null) {
        setView(next);
        setDone(
          mode === 'auto'
            ? t.savedAuto({ min: minN, max: maxN })
            : t.savedMode({ mode: t.modes[mode].label.toLocaleLowerCase(fmt.locale) }),
        );
        saved = true;
        props.onChanged();
      }
    });
    return ok && saved;
  };
  submitRef.current = submit;

  const applySuggestion = (): void => {
    const s = v.suggestion;
    if (s === null) return;
    setDone(null);
    void save.run(async () => {
      const ok = await guarded(
        async () => {
          await bulkWorkerConfig({
            workerIds: [workerId],
            patch: { maxParallelJobs: s.value },
            // The classic change note (audit trail): the master's reasons as they came.
            changeNote: `Capacity suggestion: ${s.reasons.map((r) => r.text).join('; ')}`.slice(0, 1000),
          });
          return true;
        },
        all.stepUp({ machine: props.workerName, what: all.advice.why({ n: s.value }) }),
      );
      if (ok === true) {
        setDone(all.advice.saved({ n: s.value }));
        await refresh(false);
        props.onChanged();
      }
    });
  };

  const decision = v.lastDecision;
  const recent = [...v.events].reverse().slice(0, 8);

  return (
    <Panel title={t.title} testId="capacity-mode">
      <div className="flex flex-col gap-3 text-[0.875rem]">
        <p className="m-0 font-bold" data-testid="capacity-mode-sentence">
          {modeText(t, v)}
        </p>
        {!v.metricsSupported && v.mode !== 'manual' ? (
          <DyNotice tone="amber">
            <span data-testid="capacity-metrics-missing">{t.metricsMissing}</span>
          </DyNotice>
        ) : null}

        {v.mode === 'suggest' && v.suggestion !== null ? (
          <div
            className="flex flex-col gap-1.5 rounded-[10px] bg-dy-sunk px-3.5 py-2.5"
            data-testid="capacity-suggestion"
          >
            <p className="m-0 font-bold">{t.suggestion({ n: v.suggestion.value, current: v.effective })}</p>
            <ul className="m-0 list-disc pl-5 text-[0.8125rem] text-dy-muted">
              {v.suggestion.reasons.map((r) => (
                <li key={r.code + r.text}>{r.text}</li>
              ))}
            </ul>
            {props.isAdmin && v.managed && v.suggestion.value !== v.configured ? (
              <div>
                <DyButton
                  variant="primary"
                  busy={save.busy}
                  disabled={save.blocked}
                  onClick={applySuggestion}
                  data-testid="capacity-apply-suggestion"
                >
                  {all.advice.apply({ n: v.suggestion.value })}
                </DyButton>
              </div>
            ) : null}
          </div>
        ) : v.mode === 'suggest' ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="capacity-suggestion-pending">
            {t.noSuggestion}
          </p>
        ) : null}

        {decision !== null ? (
          <div data-testid="capacity-decision">
            <p className="m-0">
              <span className="font-bold">
                {decisionText(t, decision.action)}
                {decision.action === 'hold' ? '' : ` ${String(decision.from)} → ${String(decision.to)}`}
              </span>
              <span className="text-[0.8125rem] text-dy-muted">
                {' '}
                · {fmt.dateWith(decision.at, TIME_NUMERIC)}
              </span>
            </p>
            {decision.reasons.length > 0 ? (
              <ul className="m-0 mt-0.5 list-disc pl-5 text-[0.8125rem] text-dy-muted" aria-label={t.reasons}>
                {decision.reasons.map((r) => (
                  <li key={r.code + r.text}>{r.text}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {v.metrics !== null && v.mode !== 'manual' ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="capacity-metrics">
            {t.measured({ at: v.metrics.at === null ? null : fmt.dateWith(v.metrics.at, TIME_NUMERIC) })}{' '}
            {metricsText(t, v.metrics)}
          </p>
        ) : null}

        <DyDetails summary={t.howTitle}>
          <ul className="m-0 list-disc pl-5 text-[0.8125rem] text-dy-muted">
            <li>{t.how1}</li>
            <li>{t.how2}</li>
            <li>{t.how3}</li>
            <li>{t.how4}</li>
            <li>{t.how5}</li>
          </ul>
        </DyDetails>

        <HistoryChart view={v} />
        {recent.length > 0 ? (
          <ol
            className="m-0 flex list-none flex-col gap-1 p-0 text-[0.8125rem]"
            aria-label={t.historyLabel}
            data-testid="capacity-history"
          >
            {recent.map((e) => (
              <li key={e.id}>
                <span className="font-bold">{t.event[e.kind]}</span>
                {e.to !== null ? ` ${e.from === null ? '' : `${String(e.from)} → `}${String(e.to)}` : ''}
                <span className="text-dy-muted">
                  {' '}
                  · {fmt.dateWith(e.at, DATE_TIME_NUMERIC)} ·{' '}
                  {e.actorType === 'user' ? t.byAdmin : t.byMaster}
                  {e.reasons.length > 0 ? ` · ${e.reasons.map((r) => r.text).join('; ')}` : ''}
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        {props.isAdmin ? (
          <form
            className="flex flex-col gap-3 border-t border-dy-line pt-3"
            aria-labelledby={`${formId}-legend`}
            onSubmit={(e) => {
              e.preventDefault();
              card.submit();
            }}
          >
            <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
              <legend id={`${formId}-legend`} className="mb-1 p-0 text-[0.8125rem] font-bold">
                {t.modeLegend}
              </legend>
              {CAPACITY_MODES.map((m) => (
                <label key={m} className="flex min-h-11 cursor-pointer items-start gap-2.5 py-1 md:min-h-0">
                  <input
                    type="radio"
                    name={`${formId}-mode`}
                    value={m}
                    checked={mode === m}
                    onChange={() => {
                      setMode(m);
                    }}
                    className="mt-1 size-4 shrink-0 accent-[var(--dy-teal)]"
                    data-testid={`capacity-mode-${m}`}
                  />
                  <span className="min-w-0">
                    <span className="font-bold">{t.modes[m].label}</span>{' '}
                    <span className="text-[0.8125rem] text-dy-muted">{t.modes[m].hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {mode !== 'manual' ? (
              <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
                <DyField
                  label={t.min}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={64}
                  value={min}
                  onChange={setMin}
                  data-testid="capacity-min"
                />
                <DyField
                  label={t.max}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={64}
                  value={max}
                  onChange={setMax}
                  hint={v.hardwareCeiling === null ? undefined : t.hardwareCeiling({ n: v.hardwareCeiling })}
                  data-testid="capacity-max"
                />
              </div>
            ) : null}
            {mode !== 'manual' && boundsError !== null ? <DyNotice tone="red">{boundsError}</DyNotice> : null}
            {autoBlocked ? (
              <DyNotice tone="amber">
                <span data-testid="capacity-auto-unmanaged">{t.autoUnmanaged}</span>
              </DyNotice>
            ) : null}
            {card.inScope ? null : (
              <FormActions>
                <DyButton
                  type="submit"
                  busy={save.busy}
                  disabled={
                    !dirty || save.blocked || (mode !== 'manual' && boundsError !== null) || autoBlocked
                  }
                  data-testid="capacity-save"
                >
                  {t.save}
                </DyButton>
              </FormActions>
            )}
          </form>
        ) : null}
        <DyApiError error={save.error} retryLeft={save.retryLeft} />
      </div>
    </Panel>
  );
}
