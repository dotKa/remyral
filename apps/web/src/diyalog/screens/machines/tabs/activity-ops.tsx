import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../../../../api/client';
import { getWorkerHistory, type HistoryEntry } from '../../../../api/fleet';
import {
  diagnosticsOf,
  type DiagnosticsView,
  fetchLogs,
  type LogSource,
  type Op,
  runDiagnostics,
} from '../../../../api/remoteOps';
import { DyLogView } from '../../../common/logs';
import { cx, toApiError } from '../../../../components/ui';
import { useOp, useOpsStatus } from '../../../../screens/fleet/remoteOps';
import { workerLogRows } from '../../../../screens/fleet/workerLogLines';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyIcon } from '../../../icons';
import { DyApiError, DyField, DyNotice } from '../../forms';
import { DyButton, DySelect, EmptyLine, Panel, Pill, SkeletonRows } from '../../parts';
import { OpLine, useGuardedOp } from './runtimes-ops';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../../common/time';

/**
 * p12-diyalog wave 2 (W3) — Makine → Etkinlik in the Diyalog language: the lifecycle history (classic
 * `HistoryTimeline`), worker logs on demand (worker / boot / updater, line count, redacted on the worker, shown as
 * text only), diagnostics and the remote-operation history (classic `OpsActivity`). Logs and diagnostics go through
 * step-up, exactly as classic.
 */

// ------------------------------------------------------------------------------------------------ history

type ActivityText = Messages['machineAdmin']['activity'];

/** The audit action of a lifecycle event → its catalog key. */
const ACTION_KEY: Readonly<Record<string, keyof ActivityText['action']>> = {
  'worker.pairing.request': 'pairingRequest',
  'worker.approve': 'approve',
  'worker.deny': 'deny',
  'worker.session.start': 'sessionStart',
  'worker.session.end': 'sessionEnd',
  'worker.drain': 'drain',
  'worker.revoke': 'revoke',
  'worker.archive': 'archive',
  'worker.unarchive': 'unarchive',
  'worker.rotate.request': 'rotateRequest',
  'worker.rotate': 'rotate',
  'worker.rotate.approve': 'rotateApprove',
  'worker.runtime_policy.assign': 'runtimePolicyAssign',
  'worker.update.offer': 'updateOffer',
  'worker.update.target': 'updateTarget',
};

function actionWord(t: ActivityText, action: string): string {
  const key = Object.hasOwn(ACTION_KEY, action) ? ACTION_KEY[action] : undefined;
  return key === undefined ? action : t.action[key];
}

function outcomeWord(t: ActivityText, outcome: string): string {
  return outcome === 'failure' || outcome === 'denied' || outcome === 'error' ? t.outcome[outcome] : outcome;
}

export function HistoryPanel(props: { readonly workerId: string }): ReactNode {
  const fmt = useFormat();
  const t = useT().machineAdmin.activity;
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [limit, setLimit] = useState(8);
  useEffect(() => {
    let live = true;
    getWorkerHistory(props.workerId).then(
      (h) => {
        if (live) setItems(h);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [props.workerId]);
  return (
    <Panel title={t.historyTitle} sub={t.historySub} testId="dy-worker-history">
      <DyApiError error={error} />
      {items === null && error === null ? <SkeletonRows label={t.historyLoading} rows={3} /> : null}
      {items !== null && items.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.historyEmpty}</p>
      ) : null}
      {items !== null && items.length > 0 ? (
        <>
          <ol
            className="m-0 ml-1.5 flex list-none flex-col gap-3 border-l border-dy-line p-0 pl-4"
            data-testid="worker-history"
          >
            {items.slice(0, limit).map((h, i) => {
              const bad = h.outcome !== 'success';
              const detail = Object.entries(h.detail);
              return (
                <li key={`${h.at}-${String(i)}`} className="relative text-[0.875rem]">
                  <span
                    aria-hidden="true"
                    className={cx(
                      'absolute top-1.5 -left-[1.4rem] size-2.5 rounded-full ring-2 ring-dy-card',
                      bad ? 'bg-dy-red' : 'bg-dy-green',
                    )}
                  />
                  <span className="font-medium">{actionWord(t, h.action)}</span>
                  {bad ? (
                    <span className="font-bold text-dy-red-ink"> ({outcomeWord(t, h.outcome)})</span>
                  ) : null}{' '}
                  <time className="text-[0.8125rem] text-dy-muted" dateTime={h.at}>
                    {fmt.dateWith(h.at, DATE_TIME_NUMERIC)}
                  </time>
                  {detail.length > 0 ? (
                    <span className="block font-dy-mono text-[0.78125rem] text-dy-muted [overflow-wrap:anywhere]">
                      {detail.map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {items.length > limit ? (
            <DyButton
              variant="ghost"
              className="mt-2"
              onClick={() => {
                setLimit((l) => l + 20);
              }}
            >
              {t.more({ n: items.length - limit })}
            </DyButton>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ logs

/** The fetched worker log: line numbers, time and level from the JSON records, follow, wrap, copy. Text only. */
function WorkerLog(props: { readonly lines: readonly string[] }): ReactNode {
  const rows = useMemo(() => workerLogRows(props.lines), [props.lines]);
  const t = useT().machineAdmin.ops;
  return (
    <DyLogView
      label={t.logLabel}
      rows={rows}
      copyText={() => props.lines.join('\n')}
      count={t.lines({ n: props.lines.length })}
      empty={t.noLines}
      badge={rows.some((r) => r.badge !== null)}
      initialWrap
      testId="log-viewer"
      viewportTestId="worker-log-viewport"
      viewportClassName="h-96 max-h-[60vh] min-h-48"
    />
  );
}

// ------------------------------------------------------------------------------------------------ diagnostics

function bytes(n: number | null): string {
  if (n === null) return '?';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`; // i18n-ignore: unit
  return `${String(Math.round(n / 1024 ** 2))} MiB`; // i18n-ignore: unit
}

function Diagnostics(props: { readonly d: DiagnosticsView }): ReactNode {
  const d = props.d;
  const t = useT().machineAdmin.diag;
  const sev = (s: string): 'red' | 'amber' | 'neutral' =>
    s === 'error' ? 'red' : s === 'warning' ? 'amber' : 'neutral';
  return (
    <div className="flex min-w-0 flex-col gap-3 text-[0.8125rem]" data-testid="diagnostics">
      <dl className="m-0 grid gap-x-4 gap-y-1.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt className="text-dy-muted">{t.version}</dt>
        <dd className="m-0 font-dy-mono">{d.workerVersion}</dd>
        <dt className="text-dy-muted">Node{/* i18n-ignore: product name */}</dt>
        <dd className="m-0">
          <span className="font-dy-mono">{d.node.version}</span>{' '}
          <span className={d.node.ok ? 'font-bold text-dy-green' : 'font-bold text-dy-red-ink'}>
            {d.node.ok ? t.nodeOk : t.nodeNeeds({ major: d.node.requiredMajor })}
          </span>
        </dd>
        <dt className="text-dy-muted">{t.system}</dt>
        <dd className="m-0 font-dy-mono [overflow-wrap:anywhere]">
          {d.os.platform}/{d.os.arch} {d.os.release}
        </dd>
        <dt className="text-dy-muted">{t.service}</dt>
        <dd className="m-0">
          {d.service.manager}
          {d.service.state === undefined ? '' : ` (${d.service.state})`}
        </dd>
        <dt className="text-dy-muted">{t.memory}</dt>
        <dd className="m-0">
          {t.memoryFree({ total: bytes(d.memory.totalBytes), free: bytes(d.memory.freeBytes) })}
        </dd>
        <dt className="text-dy-muted">{t.disk}</dt>
        <dd className="m-0">
          {d.disk.map((x) => t.diskFree({ name: x.name, free: bytes(x.freeBytes) })).join(', ')}
        </dd>
      </dl>
      {d.sandbox.length > 0 ? (
        <div>
          <h4 className="m-0 mb-1 text-[0.8125rem] font-bold">{t.sandboxProfiles}</h4>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {d.sandbox.map((s) => (
              <li key={s.profile} className="flex flex-wrap items-center gap-x-2">
                <span className="font-dy-mono">{s.profile}</span>
                <Pill tone={s.ready ? 'green' : 'amber'}>{s.ready ? t.ready : t.notReady}</Pill>
                {s.reason === undefined ? null : <span className="text-dy-muted">{s.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.runtimes.length > 0 ? (
        <div>
          <h4 className="m-0 mb-1 text-[0.8125rem] font-bold">{t.runtimes}</h4>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {d.runtimes.map((r) => (
              <li key={r.runtime} className="[overflow-wrap:anywhere]">
                <span className="font-dy-mono">{r.runtime}</span>:{' '}
                {t.runtimeLine({
                  version: r.version,
                  source: r.source,
                  enabled: r.enabled,
                  auth: r.authenticated,
                  integrity: r.integrity ?? null,
                })}
                {r.problem === undefined ? null : <span className="text-dy-amber-ink"> — {r.problem}</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.problems.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="diagnostics-problems">
          {d.problems.map((p) => (
            <li key={p.code + p.message} className="flex flex-wrap items-start gap-2">
              <Pill tone={sev(p.severity)}>{p.severity}</Pill>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="font-dy-mono">{p.code}</span>: {p.message}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 flex items-center gap-1.5 font-bold text-dy-green">
          <DyIcon name="checkc" className="size-4" /> {t.noProblems}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ ops activity

/** Logs, diagnostics and the remote-operation history (owners / admins on an operable machine). */
export function OpsActivityPanels(props: {
  readonly workerId: string;
  readonly workerName: string;
}): ReactNode {
  const { workerId } = props;
  const t = useT().machineAdmin.ops;
  const { status, error } = useOpsStatus(workerId);
  const submit = useSubmit();
  const guarded = useGuardedOp();
  const [logLines, setLogLines] = useState('300');
  const [logSource, setLogSource] = useState<LogSource>('worker');
  const [logsOp, setLogsOp] = useState<Op | null>(null);
  const [diagOp, setDiagOp] = useState<Op | null>(null);
  const logs = useOp(workerId, logsOp);
  const diag = useOp(workerId, diagOp);
  const start = (fn: () => Promise<Op>, why: string, then: (op: Op) => void): void => {
    void submit.run(async () => {
      const started = await guarded(fn, why);
      if (started !== null) then(started);
    });
  };
  const diagnostics = diag.op === null ? null : diagnosticsOf(diag.op);
  if (status === null) {
    return error === null ? (
      <Panel title={t.title} flush>
        <SkeletonRows label={t.loading} rows={2} />
      </Panel>
    ) : (
      <DyApiError error={error} />
    );
  }
  if (!status.supported) {
    return (
      <DyNotice tone="amber" title={t.unsupportedTitle}>
        <span data-testid="remote-ops-unsupported">{t.unsupported}</span>
      </DyNotice>
    );
  }
  return (
    <>
      <Panel title={t.logsTitle} sub={t.logsSub} testId="dy-worker-logs">
        <div className="flex flex-col gap-3">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              start(
                () => fetchLogs(workerId, Math.max(1, Math.min(2000, Number(logLines || '300'))), logSource),
                t.logWhy({ machine: props.workerName, source: t.source[logSource] }),
                setLogsOp,
              );
            }}
          >
            <DySelect
              label={t.log}
              value={logSource}
              options={[
                ['worker', t.sourceOption.worker],
                ['boot', t.sourceOption.boot],
                ['updater', t.sourceOption.updater],
              ]}
              onChange={(v) => {
                setLogSource(v === 'boot' || v === 'updater' ? v : 'worker');
              }}
              className="min-w-[13rem]"
            />
            <DyField
              label={t.lineCount}
              inputMode="numeric"
              value={logLines}
              onChange={(v) => {
                setLogLines(v.replace(/\D/g, '').slice(0, 4));
              }}
              wrapClassName="w-24"
            />
            <DyButton type="submit" icon="tray" busy={submit.busy} disabled={!status.connected}>
              {t.fetch}
            </DyButton>
          </form>
          {!status.connected ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.needsConnection}</p>
          ) : null}
          {logs.op !== null ? (
            <div className="flex min-w-0 flex-col gap-2">
              <OpLine op={logs.op} />
              <WorkerLog lines={logs.lines} />
              {logs.op.logs?.truncated === true ? (
                <p className="m-0 text-[0.78125rem] text-dy-muted">{t.logTruncated}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel
        title={t.diagTitle}
        sub={t.diagSub}
        aside={
          <DyButton
            icon="search"
            busy={submit.busy}
            disabled={!status.connected}
            onClick={() => {
              start(() => runDiagnostics(workerId), t.diagWhy({ machine: props.workerName }), setDiagOp);
            }}
          >
            {t.diagRun}
          </DyButton>
        }
        testId="dy-worker-diagnostics"
      >
        {diag.op === null ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{t.diagNotRun}</p>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <OpLine op={diag.op} />
            {diagnostics !== null ? <Diagnostics d={diagnostics} /> : null}
          </div>
        )}
      </Panel>
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />

      <Panel
        title={t.historyTitle}
        count={String(status.ops.length)}
        countLabel={t.opCount({ n: status.ops.length })}
        sub={t.historySub}
        flush
      >
        {status.ops.length === 0 ? (
          <EmptyLine>{t.historyEmpty}</EmptyLine>
        ) : (
          <ul className="m-0 list-none p-0" data-testid="ops-history">
            {status.ops.map((o) => (
              <li key={o.id} className="border-t border-dy-line px-4 py-2.5 first:border-t-0">
                <OpLine op={o} at />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
