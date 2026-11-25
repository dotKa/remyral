import { type ReactNode, useCallback, useState } from 'react';
import type { DiskHygiene, DiskHygieneRun, DiskUsageEntry } from '../../../../api/fleet';
import { cleanDisk, type Op, TERMINAL_STATES } from '../../../../api/remoteOps';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { formatBytes } from '../../../../screens/fleet/cacheBytes';
import { machinePath } from '../../../../screens/fleet/machineLinks';
import { useSubmit } from '../../../../screens/useSubmit';
import { DATE_TIME_NUMERIC } from '../../../common/time';
import { DyApiError } from '../../forms';
import { DyButton, DyButtonLink, Panel, Pill, Row, Rows } from '../../parts';
import { OpLine, useGuarded, useOpPoll } from './config-shared';

/**
 * p17-disk-selfclean (docs/design/p17-disk-selfclean.md) — Makine → Genel bakış → Kapasite → "Disk temizliği": the
 * worker's own cleanup of what it created and can recreate. Shows on / off and the target, the last run (bytes freed
 * per category, why it ran), the next runs and — when space stayed low after a run — the space per top-level directory
 * of the worker's data dir and workspace root (directory names the worker creates, never a file name). Admins get
 * "Şimdi temizle" (the remote op `disk.clean`, step-up, audited) on workers with `disk-hygiene-v1`.
 */
export function DiskHygienePanel(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly connected: boolean;
  readonly hygiene: DiskHygiene;
  readonly isAdmin: boolean;
  readonly onChanged: () => void;
}): ReactNode {
  const fmt = useFormat();
  const t = useT().machineAdmin.disk;
  const { workerId, hygiene } = props;
  const r = hygiene.report;
  const [op, setOp] = useState<Op | null>(null);
  const act = useSubmit();
  const guarded = useGuarded();
  const onDone = useCallback(() => {
    // The worker re-sends CAPABILITIES right after the run; read the overview again.
    props.onChanged();
  }, [props.onChanged]);
  useOpPoll(workerId, op, setOp, onDone);
  const running = (op !== null && !TERMINAL_STATES.has(op.state)) || r?.running === true;
  const when = (iso: string): string => fmt.dateWith(iso, DATE_TIME_NUMERIC);
  // The run the operation returned is newer than the stored report until CAPABILITIES arrive.
  const opRun = op?.state === 'succeeded' ? runOf(op.result) : null;
  const last = opRun ?? r?.lastRun ?? null;

  return (
    <Panel
      title={t.title}
      sub={t.sub}
      testId="disk-hygiene"
      aside={
        <span className="flex flex-wrap items-center gap-2">
          {r !== null ? (
            <Pill tone={r.enabled ? 'green' : 'amber'} icon={r.enabled ? 'checkc' : undefined}>
              {r.enabled ? t.onPill : t.offPill}
            </Pill>
          ) : null}
          {props.isAdmin && hygiene.supported ? (
            <DyButton
              icon="retry"
              busy={act.busy || running}
              disabled={running || !props.connected}
              data-testid="disk-clean"
              onClick={() => {
                void act.run(async () => {
                  const o = await guarded(() => cleanDisk(workerId), t.why({ machine: props.workerName }));
                  if (o !== null) setOp(o);
                });
              }}
            >
              {t.cleanNow}
            </DyButton>
          ) : null}
        </span>
      }
    >
      <div className="flex min-w-0 flex-col gap-2 text-[0.875rem]" data-testid="disk-hygiene-body">
        {!hygiene.supported ? (
          <p className="m-0 text-dy-muted">{t.notSupported}</p>
        ) : r === null ? (
          <p className="m-0 text-dy-muted">{t.notReported}</p>
        ) : (
          <>
            <p className="m-0" data-testid="disk-hygiene-state">
              {r.enabled
                ? t.on({
                    target: formatBytes(r.targetBytes),
                    threshold: formatBytes(r.thresholdBytes),
                    margin: formatBytes(r.marginBytes),
                  })
                : t.off}
              {r.freeBytes !== null && r.checkedAt !== null
                ? ` ${t.free({ free: formatBytes(r.freeBytes), at: when(r.checkedAt) })}`
                : ''}
            </p>
            {last === null ? (
              <p className="m-0 text-dy-muted">{t.noRun}</p>
            ) : (
              <LastRun run={last} when={when} />
            )}
            {r.enabled && (r.nextDailyAt !== null || r.nextLowDiskAt !== null) ? (
              <p className="m-0 text-[0.8125rem] text-dy-muted">
                {r.nextDailyAt !== null ? t.nextDaily({ at: when(r.nextDailyAt) }) : ''}
                {r.nextLowDiskAt !== null ? ` ${t.nextLowDisk({ at: when(r.nextLowDiskAt) })}` : ''}
              </p>
            ) : null}
          </>
        )}
        {props.isAdmin && hygiene.supported && !props.connected ? (
          <p className="m-0 text-dy-muted">{t.offline}</p>
        ) : null}
        {op !== null ? <OpLine op={op} what={t.what} testId="disk-clean-op" /> : null}
        <DyApiError error={act.error} retryLeft={act.retryLeft} />
        {props.isAdmin && hygiene.supported ? (
          <p className="m-0">
            <DyButtonLink to={machinePath(workerId, 'configuration')}>{t.changeSettings}</DyButtonLink>
          </p>
        ) : null}
      </div>
      {r?.usage !== null && r?.usage !== undefined && last?.stillLow === true ? (
        <Usage usage={r.usage} when={when} />
      ) : null}
    </Panel>
  );
}

function LastRun(props: { readonly run: DiskHygieneRun; readonly when: (iso: string) => string }): ReactNode {
  const t = useT().machineAdmin.disk;
  const { run } = props;
  return (
    <div className="flex flex-col gap-1" data-testid="disk-hygiene-last">
      <p className={`m-0 ${run.stillLow ? 'font-bold text-dy-red-ink' : ''}`}>
        {t.lastRun({
          at: props.when(run.finishedAt),
          trigger: t.trigger[run.trigger],
          freed: formatBytes(run.freedBytes),
        })}
      </p>
      {run.freed.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[0.8125rem]" aria-label={t.freedLabel}>
          {run.freed.map((f) => (
            <li key={f.category} className="flex flex-wrap gap-x-2" data-testid="disk-hygiene-freed">
              <span>{t.category[f.category]}</span>
              <span className="font-dy-mono tabular-nums text-dy-muted">
                {formatBytes(f.bytes)} · {t.items({ n: f.items })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {run.skipped > 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="disk-skipped">
          {t.skipped({ n: run.skipped })}
        </p>
      ) : null}
      {run.errors > 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-amber-ink">{t.errors({ n: run.errors })}</p>
      ) : null}
      {run.stillLow ? (
        <p className="m-0 text-[0.8125rem] text-dy-red-ink" role="alert">
          {t.stillLow}
        </p>
      ) : null}
    </div>
  );
}

function Usage(props: {
  readonly usage: NonNullable<NonNullable<DiskHygiene['report']>['usage']>;
  readonly when: (iso: string) => string;
}): ReactNode {
  const t = useT().machineAdmin.disk;
  const name = (e: DiskUsageEntry): ReactNode =>
    e.name === 'workspace-root' || e.name === 'other' ? (
      t.usageName[e.name]
    ) : (
      <span className="font-dy-mono">{e.name}</span>
    );
  const list = (label: string, entries: readonly DiskUsageEntry[], testId: string): ReactNode =>
    entries.length === 0 ? null : (
      <Rows label={label} testId={testId}>
        {entries.map((e) => (
          <Row
            key={e.name}
            title={name(e)}
            trail={
              <span className="font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums">
                {formatBytes(e.bytes)}
              </span>
            }
          />
        ))}
      </Rows>
    );
  return (
    <div className="mt-3 flex flex-col gap-1 border-t border-dy-line pt-3" data-testid="disk-usage">
      <p className="m-0 text-[0.875rem] font-bold">{t.usageTitle({ at: props.when(props.usage.at) })}</p>
      {list(t.usageData, props.usage.dataDir, 'disk-usage-data')}
      {list(t.usageWorkspace, props.usage.workspaceRoot, 'disk-usage-workspace')}
      {props.usage.partial ? <p className="m-0 text-[0.8125rem] text-dy-muted">{t.usagePartial}</p> : null}
    </div>
  );
}

/** The run in a finished `disk.clean` operation's result (null when absent / malformed). */
function runOf(result: Readonly<Record<string, unknown>> | null): DiskHygieneRun | null {
  const v = result?.diskClean;
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.freedBytes !== 'number' || typeof o.finishedAt !== 'string' || !Array.isArray(o.freed))
    return null;
  return v as DiskHygieneRun;
}
