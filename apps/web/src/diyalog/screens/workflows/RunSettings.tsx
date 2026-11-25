import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import { listWorkflows } from '../../../api/workflowDefs';
import { workflowMetrics, type WorkflowMetrics } from '../../../api/workflowEngine';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { DyChoice, DyFieldset, DyInput } from '../kit';
import { EmptyLine, ErrorLine, Panel, Pill, SkeletonRows } from '../parts';
import { ExpressionField } from './ExpressionField';
import type { Doc } from './model';

/**
 * p14-workflow-engine 14.4 (docs/design/p14-workflow-engine.md §20.3, §20.4): the run settings of a v2 workflow in
 * the editor's workflow panel — concurrency (limit, what happens at the limit, an optional key expression), run
 * timeout, error workflow, data retention and the failure alert — written into `definition.settings` (saved with the
 * next version); and the Metrikler tab (runs by state, the failure streak against the alert threshold, per-node
 * runs / failures / durations, recent failed runs). Numbers are validated here only to guide; the master validates.
 */

type Settings = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function without(o: Record<string, unknown>, k: string): Record<string, unknown> {
  const { [k]: _drop, ...rest } = o;
  return rest;
}

/** A whole number within [min, max] from an input ('' → undefined; anything else invalid → null). */
function intIn(text: string, min: number, max: number): number | undefined | null {
  const v = text.trim();
  if (v === '') return undefined;
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

const UNITS = [
  ['sec', 1],
  ['min', 60],
  ['hour', 3600],
] as const;
type Unit = (typeof UNITS)[number][0];

function unitOf(sec: number | undefined): Unit {
  if (sec === undefined) return 'min';
  if (sec % 3600 === 0) return 'hour';
  if (sec % 60 === 0) return 'min';
  return 'sec';
}

const factor = (u: Unit): number => UNITS.find((x) => x[0] === u)?.[1] ?? 1;

/** A numeric field that keeps the typed text while it is not (yet) valid. */
function IntField(props: {
  readonly label: string;
  readonly hint?: string;
  readonly value: number | undefined;
  readonly min: number;
  readonly max: number;
  readonly placeholder?: string;
  readonly readOnly: boolean;
  readonly testId: string;
  readonly onChange: (v: number | undefined) => void;
}): ReactNode {
  const t = useT().workflows.settings;
  const [text, setText] = useState(props.value === undefined ? '' : String(props.value));
  const { value } = props;
  useEffect(() => {
    setText((cur) =>
      intIn(cur, props.min, props.max) === value ? cur : value === undefined ? '' : String(value),
    );
  }, [value, props.min, props.max]);
  const parsed = intIn(text, props.min, props.max);
  return (
    <DyInput
      label={props.label}
      hint={props.hint}
      inputMode="numeric"
      value={text}
      placeholder={props.placeholder}
      readOnly={props.readOnly}
      data-testid={props.testId}
      error={parsed === null ? t.range({ min: props.min, max: props.max }) : null}
      onChange={(e) => {
        setText(e.target.value);
        const v = intIn(e.target.value, props.min, props.max);
        if (v !== null) props.onChange(v);
      }}
    />
  );
}

export function RunSettingsFields(props: {
  readonly doc: Doc;
  readonly project: string;
  readonly readOnly: boolean;
  readonly onEdit: (next: Doc, tag?: string) => void;
}): ReactNode {
  const t = useT().workflows.settings;
  const { doc, readOnly } = props;
  const settings: Settings = isObj(doc.settings) ? doc.settings : {};
  const concurrency = isObj(settings.concurrency) ? settings.concurrency : null;
  const timeoutSec = typeof settings.timeoutSec === 'number' ? settings.timeoutSec : undefined;
  const [unit, setUnit] = useState<Unit>(unitOf(timeoutSec));
  const [workflows, setWorkflows] = useState<readonly string[]>([]);
  const { project } = props;
  useEffect(() => {
    let live = true;
    if (project === '') return;
    listWorkflows().then(
      (all) => {
        if (live)
          setWorkflows(
            all
              .filter((w) => w.project === project && !w.archived)
              .map((w) => w.name)
              .sort(),
          );
      },
      () => {
        if (live) setWorkflows([]);
      },
    );
    return () => {
      live = false;
    };
  }, [project]);

  const set = (key: string, value: unknown, tag: string): void => {
    const next = value === undefined ? without(settings, key) : { ...settings, [key]: value };
    const doc2: Doc =
      Object.keys(next).length === 0 ? (without(doc, 'settings') as Doc) : { ...doc, settings: next };
    props.onEdit(doc2, tag);
  };
  const setConcurrency = (patch: Record<string, unknown> | null): void => {
    if (patch === null) {
      set('concurrency', undefined, 'settings.concurrency');
      return;
    }
    const merged: Record<string, unknown> = { ...(concurrency ?? { onLimit: 'queue' }), ...patch };
    const clean = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
    set('concurrency', clean, 'settings.concurrency');
  };
  const onFailure =
    isObj(settings.onFailure) && typeof settings.onFailure.workflow === 'string'
      ? settings.onFailure.workflow
      : '';
  const alerts =
    isObj(settings.alerts) && typeof settings.alerts.failuresInARow === 'number'
      ? settings.alerts.failuresInARow
      : undefined;
  const key = concurrency?.key;
  const keyText =
    isObj(key) && typeof key.$expr === 'string' ? key.$expr : typeof key === 'string' ? key : '';
  const others = workflows.filter((w) => w !== doc.name);
  if (onFailure !== '' && !others.includes(onFailure)) others.push(onFailure);

  return (
    <DyFieldset legend={t.title} sub={t.sub}>
      <div className="grid gap-3" data-testid="workflow-run-settings">
        <IntField
          label={t.concurrencyMax}
          hint={t.concurrencyHint}
          value={typeof concurrency?.max === 'number' ? concurrency.max : undefined}
          min={1}
          max={50}
          readOnly={readOnly}
          testId="settings-concurrency-max"
          onChange={(v) => {
            setConcurrency(v === undefined ? null : { max: v });
          }}
        />
        {concurrency === null ? null : (
          <>
            <DyChoice
              label={t.onLimit}
              value={typeof concurrency.onLimit === 'string' ? concurrency.onLimit : 'queue'}
              disabled={readOnly}
              options={[
                ['queue', t.onLimitQueue],
                ['skip', t.onLimitSkip],
                ['cancelOldest', t.onLimitCancelOldest],
              ]}
              onChange={(v) => {
                setConcurrency({ onLimit: v });
              }}
            />
            <ExpressionField
              label={t.key}
              hint={t.keyHint}
              value={keyText}
              mode="expr"
              suggestions={[]}
              preview={null}
              readOnly={readOnly}
              testId="settings-concurrency-key"
              rows={1}
              onChange={(v) => {
                setConcurrency({ key: v.trim() === '' ? undefined : { $expr: v } });
              }}
            />
          </>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
          <IntField
            label={t.timeout}
            hint={t.timeoutHint}
            value={timeoutSec === undefined ? undefined : Math.round(timeoutSec / factor(unit))}
            min={1}
            max={Math.floor((90 * 24 * 3600) / factor(unit))}
            readOnly={readOnly}
            testId="settings-timeout"
            onChange={(v) => {
              set(
                'timeoutSec',
                v === undefined ? undefined : Math.max(60, v * factor(unit)),
                'settings.timeout',
              );
            }}
          />
          <DyChoice
            label={t.unitMin}
            className="[&_label]:sr-only"
            value={unit}
            disabled={readOnly}
            options={[
              ['sec', t.unitSec],
              ['min', t.unitMin],
              ['hour', t.unitHour],
            ]}
            onChange={(v) => {
              const u = v as Unit;
              setUnit(u);
              if (timeoutSec !== undefined)
                set(
                  'timeoutSec',
                  Math.max(60, Math.round(timeoutSec / factor(unit)) * factor(u)),
                  'settings.timeout',
                );
            }}
          />
        </div>
        <DyChoice
          label={t.onFailure}
          hint={t.onFailureHint}
          value={onFailure}
          disabled={readOnly}
          options={[['', t.onFailureNone], ...others.map((w) => [w, w] as const)]}
          onChange={(v) => {
            set('onFailure', v === '' ? undefined : { workflow: v }, 'settings.onFailure');
          }}
        />
        <IntField
          label={t.retention}
          hint={t.retentionHint}
          placeholder="30"
          value={typeof settings.retentionDays === 'number' ? settings.retentionDays : undefined}
          min={1}
          max={365}
          readOnly={readOnly}
          testId="settings-retention"
          onChange={(v) => {
            set('retentionDays', v, 'settings.retention');
          }}
        />
        <IntField
          label={t.alerts}
          hint={t.alertsHint}
          placeholder="3"
          value={alerts}
          min={0}
          max={100}
          readOnly={readOnly}
          testId="settings-alerts"
          onChange={(v) => {
            set('alerts', v === undefined ? undefined : { failuresInARow: v }, 'settings.alerts');
          }}
        />
      </div>
    </DyFieldset>
  );
}

// ------------------------------------------------------------------------------------------------ metrics tab

export function MetricsTab(props: {
  readonly definitionId: string;
  /** p18-multi-project: the runs of a project that attached the workflow (default: the owner project's). */
  readonly project?: string | undefined;
}): ReactNode {
  const t = useT().workflows.metrics;
  const fmt = useFormat();
  const [m, setM] = useState<WorkflowMetrics | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(() => {
    workflowMetrics(props.definitionId, 30, props.project).then(
      (r) => {
        setM(r);
        setError(null);
      },
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
  }, [props.definitionId, props.project]);
  useEffect(load, [load]);
  const ms = (v: number | null): string => (v === null ? '—' : fmt.duration(v));
  return (
    <div className="grid min-h-0 flex-1 content-start gap-4 overflow-auto px-3 pt-1 pb-8 sm:px-6">
      <ErrorLine error={error} what={t.what} onRetry={load} />
      {m === null ? (
        error === null ? (
          <SkeletonRows label={t.loading} />
        ) : null
      ) : (
        <>
          <Panel title={t.runs} sub={t.title({ days: m.days })} testId="workflow-metrics-runs">
            <div className="flex flex-wrap gap-2">
              {(['queued', 'active', 'paused', 'succeeded', 'failed', 'cancelled'] as const).map((s) => (
                <Pill
                  key={s}
                  tone={
                    s === 'failed'
                      ? 'red'
                      : s === 'succeeded'
                        ? 'green'
                        : s === 'paused'
                          ? 'amber'
                          : 'neutral'
                  }
                >
                  {`${t.states[s]}: ${fmt.number(m.runs[s])}`}
                </Pill>
              ))}
            </div>
            <p className="m-0 mt-3 text-[0.875rem]" data-testid="workflow-metrics-streak">
              {m.failureStreak === 0
                ? t.noStreak
                : m.alertAfter === 0
                  ? t.streakOff({ n: m.failureStreak })
                  : t.streak({ n: m.failureStreak, after: m.alertAfter })}
            </p>
          </Panel>
          <Panel title={t.nodes} flush testId="workflow-metrics-nodes">
            {m.nodes.length === 0 ? (
              <EmptyLine>{t.noNodes}</EmptyLine>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[0.84375rem]">
                  <thead>
                    <tr className="text-left text-dy-muted">
                      <th className="px-4 py-2 font-medium">{t.node}</th>
                      <th className="px-2 py-2 text-right font-medium">{t.count}</th>
                      <th className="px-2 py-2 text-right font-medium">{t.failed}</th>
                      <th className="px-2 py-2 text-right font-medium">{t.p50}</th>
                      <th className="px-2 py-2 text-right font-medium">{t.p95}</th>
                      <th className="px-4 py-2 text-right font-medium">{t.max}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.nodes.map((n) => (
                      <tr
                        key={n.node}
                        className="border-t border-dy-line"
                        data-testid="workflow-metrics-node"
                      >
                        <td className="px-4 py-2 font-dy-mono">{n.node}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{fmt.number(n.runs)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{fmt.number(n.failed)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{ms(n.p50Ms)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{ms(n.p95Ms)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{ms(n.maxMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <Panel title={t.recentFailures} testId="workflow-metrics-failures">
            {m.recentFailures.length === 0 ? (
              <p className="m-0 text-[0.875rem] text-dy-muted">{t.noFailures}</p>
            ) : (
              <ul className="m-0 grid list-none gap-1.5 p-0 text-[0.875rem]">
                {m.recentFailures.map((f) => (
                  <li key={f.runId} className="grid gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/jobs/workflows/${encodeURIComponent(f.runId)}`}
                        aria-label={t.openRun}
                        className="font-dy-mono text-dy-teal-ink"
                      >
                        {f.runId.slice(0, 8)}
                      </Link>
                      {f.endedAt === null ? null : (
                        <time className="text-dy-muted" dateTime={f.endedAt}>
                          {fmt.dateTime(f.endedAt)}
                        </time>
                      )}
                    </span>
                    {f.reason === null ? null : (
                      <span className="text-dy-muted [overflow-wrap:anywhere]">{f.reason}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
