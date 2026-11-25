import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  cancelJob,
  getJob,
  listJobs,
  MAINTENANCE_KINDS,
  type MaintenanceJob,
  type MaintenanceKind,
  startJob,
} from '../../../api/panelSettings';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyApiError } from '../forms';
import { DyButton, DySelect, EmptyLine, ErrorLine, Meter, Panel, Pill, SkeletonRows } from '../parts';
import type { Tone } from '../../tone';

/**
 * p17-panel-settings Part 7 (docs/design/p17-panel-settings.md §9): Ayarlar → Sunucu ayarları → Bakım — the maintenance
 * commands (`blobs:migrate` in every mode, `search:backfill`, `memory:autolearn`) as background jobs: a dry run first
 * (the real run is offered for the same choice once the dry run finished), progress while it runs (polled), cancel,
 * the report. One job of a kind at a time (the master refuses a second).
 */

export const MAINTENANCE_POLL = { ms: 2000 };

const STATE_TONE: Readonly<Record<MaintenanceJob['state'], Tone>> = {
  running: 'teal',
  done: 'green',
  failed: 'red',
  cancelled: 'neutral',
};

const BLOB_MODES = ['to-store', 'to-db', 'move-local', 'move-s3'] as const;

export function MaintenancePanel(props: { readonly owner: boolean }): ReactNode {
  const t = useT().panelSettings.maintenance;
  const loader = useSubmit();
  const [jobs, setJobs] = useState<readonly MaintenanceJob[] | null>(null);
  const load = useCallback((): void => {
    void loader.run(async () => {
      setJobs(await listJobs());
    });
  }, [loader]);
  useEffect(load, []);
  // While something runs, poll the list.
  const running = (jobs ?? []).some((j) => j.state === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, MAINTENANCE_POLL.ms);
    return () => {
      clearInterval(timer);
    };
  }, [running, load]);
  return (
    <div className="grid gap-4" data-testid="dy-panel-maintenance">
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.sub}</p>
      {MAINTENANCE_KINDS.map((k) => (
        <KindCard key={k} kind={k} owner={props.owner} jobs={jobs ?? []} onStarted={load} />
      ))}
      <ErrorLine error={loader.error} what={t.title} onRetry={load} />
      {jobs === null && loader.error === null ? <SkeletonRows label={t.title} rows={2} /> : null}
    </div>
  );
}

function KindCard(props: {
  readonly kind: MaintenanceKind;
  readonly owner: boolean;
  readonly jobs: readonly MaintenanceJob[];
  readonly onStarted: () => void;
}): ReactNode {
  const all = useT();
  const t = all.panelSettings.maintenance;
  const stepUp = useStepUp();
  const act = useSubmit();
  const [mode, setMode] = useState<string>('to-store');
  const mine = props.jobs.filter((j) => j.kind === props.kind);
  const last = mine[0] ?? null;
  const params = props.kind === 'blobs-migrate' ? { mode } : {};
  const sameParams = (j: MaintenanceJob): boolean =>
    props.kind !== 'blobs-migrate' || (j.params.mode ?? 'to-store') === mode;
  const dryDone = mine.some((j) => j.dryRun && j.state === 'done' && sameParams(j));
  const running = last?.state === 'running';
  const start = (dryRun: boolean): void => {
    void act.run(async () => {
      try {
        await stepUp.run(() => startJob({ kind: props.kind, dryRun, params }), t.stepUp);
        props.onStarted();
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  };
  return (
    <Panel title={t.kinds[props.kind] ?? props.kind} testId={`dy-maint-${props.kind}`}>
      {props.kind === 'blobs-migrate' ? (
        <DySelect
          label={t.mode}
          value={mode}
          options={BLOB_MODES.map((m) => [m, t.modes[m] ?? m] as const)}
          onChange={setMode}
          className="max-w-md"
        />
      ) : null}
      {props.owner ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <DyButton
            busy={act.busy}
            disabled={running}
            onClick={() => {
              start(true);
            }}
          >
            {t.dryRun}
          </DyButton>
          <DyButton
            variant="primary"
            busy={act.busy}
            disabled={running || !dryDone}
            onClick={() => {
              start(false);
            }}
          >
            {t.start}
          </DyButton>
          {last?.state === 'running' ? (
            <DyButton
              variant="danger"
              onClick={() => {
                void act.run(async () => {
                  await cancelJob(last.id);
                  props.onStarted();
                });
              }}
            >
              {t.cancel}
            </DyButton>
          ) : null}
        </div>
      ) : null}
      <DyApiError error={act.error} className="mt-2" />
      {last === null ? <EmptyLine>{t.none}</EmptyLine> : <JobLine job={last} />}
    </Panel>
  );
}

function JobLine(props: { readonly job: MaintenanceJob }): ReactNode {
  const t = useT().panelSettings.maintenance;
  const [job, setJob] = useState(props.job);
  useEffect(() => {
    setJob(props.job);
  }, [props.job]);
  useEffect(() => {
    if (job.state !== 'running') return;
    const timer = setInterval(() => {
      void getJob(job.id)
        .then(setJob)
        .catch(() => undefined);
    }, MAINTENANCE_POLL.ms);
    return () => {
      clearInterval(timer);
    };
  }, [job.id, job.state]);
  const p = job.progress;
  return (
    <div className="mt-3 grid gap-2" data-testid={`dy-maint-job-${job.kind}`}>
      <div className="flex flex-wrap items-center gap-2 text-[0.875rem]">
        <Pill tone={STATE_TONE[job.state]}>{t.state[job.state] ?? job.state}</Pill>
        {job.dryRun ? <Pill tone="neutral">{t.dryRun}</Pill> : null}
        <span className="font-dy-mono tabular-nums">
          {t.progress({ done: p.done, total: p.total === null ? '?' : String(p.total) })}
        </span>
        {p.step === '' ? null : <span className="text-dy-muted">{p.step}</span>}
      </div>
      {p.total !== null && p.total > 0 ? (
        <Meter
          value={Math.min(100, Math.round((p.done / p.total) * 100))}
          label={t.kinds[job.kind] ?? job.kind}
          text={t.progress({ done: p.done, total: String(p.total) })}
        />
      ) : null}
      {job.error === null ? null : <p className="m-0 text-[0.8125rem] text-dy-red-ink">{job.error}</p>}
      {p.lines.length === 0 ? null : (
        <pre className="m-0 max-h-48 overflow-auto rounded-[10px] bg-dy-sunk p-2 font-dy-mono text-[0.75rem] whitespace-pre-wrap">
          {p.lines.join('\n')}
        </pre>
      )}
      {job.report === null || job.state === 'running' ? null : (
        <details>
          <summary className="cursor-pointer text-[0.8125rem] font-bold">{t.report}</summary>
          <pre className="m-0 mt-1 max-h-64 overflow-auto rounded-[10px] bg-dy-sunk p-2 font-dy-mono text-[0.75rem] whitespace-pre-wrap">
            {JSON.stringify(job.report, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
