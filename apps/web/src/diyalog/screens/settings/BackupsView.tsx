import { type ReactNode, useEffect, useState } from 'react';
import {
  type BackupOverview,
  type DrillRun,
  getBackupOverview,
  type HealthState,
  type StandbyStatus,
} from '../../../api/backups';
import { formatBytes } from '../../../screens/backupBytes';
import { useSubmit } from '../../../screens/useSubmit';
import { DyIcon, type IconName } from '../../icons';
import { KeyValue } from '../../KeyValue';
import type { Tone } from '../../tone';
import { INK } from '../../tone';
import { agoText, DyButton, ErrorLine, Panel, Pill, SkeletonRows, StatTile, StatTiles } from '../parts';
import { DATE_TIME_NUMERIC } from '../../common/time';
import type { Formatter, Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useIsOwner } from '../../onboarding/useOnboarding';
import { BackupManagePanel } from './backups-manage';

/**
 * p12-diyalog Faz 4 — Ayarlar → Yedekler: what `GET /backups/status` reports (the classic page's only source), in
 * the Diyalog language — health first (tone + icon + sentence), four tiles (last backup, last drill, standby lag,
 * storage), then the last backup, the drill checks, schedule and standby readiness as key–value panels. Status only:
 * nothing is downloadable, restores follow the runbook (docs/ops/backup-restore.md).
 * p14-i18n-screens-c: words from the `settings.backups` catalog.
 * p17-host-actions part 3: owners also manage the backups here (`backups-manage.tsx`) — a backup or drill now, the
 * schedule, retention, WAL archiving, encryption recipients, the off-site target and restores, through the host applier.
 */

type Words = Messages['settings']['backups'];

const HEALTH: Readonly<Record<HealthState, { tone: Tone; icon: IconName }>> = {
  ok: { tone: 'green', icon: 'checkc' },
  warning: { tone: 'amber', icon: 'shield' },
  failing: { tone: 'red', icon: 'xc' },
  not_configured: { tone: 'neutral', icon: 'clock' },
};

const OUTCOME: Readonly<Record<string, { tone: Tone; icon: IconName }>> = {
  ok: { tone: 'green', icon: 'checkc' },
  passed: { tone: 'green', icon: 'checkc' },
  partial: { tone: 'amber', icon: 'shield' },
  failed: { tone: 'red', icon: 'xc' },
};

function outcomeText(t: Words, v: string): string {
  const words: Readonly<Record<string, string>> = t.outcome;
  return words[v] ?? v;
}

function Outcome(props: { readonly value: string }): ReactNode {
  const t = useT().settings.backups;
  const o = OUTCOME[props.value] ?? { tone: 'neutral' as Tone, icon: 'clock' as IconName };
  return (
    <Pill tone={o.tone} icon={o.icon}>
      {outcomeText(t, props.value)}
    </Pill>
  );
}

function offsiteState(t: Words, v: string): string {
  const words: Readonly<Record<string, string>> = t.offsiteState;
  return words[v] ?? v.replace('_', ' ');
}

const when = (iso: string | null | undefined, f: Formatter): string =>
  iso ? f.dateWith(iso, DATE_TIME_NUMERIC) : '—';

function ms(t: Words, v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v < 1000) return t.ms({ n: String(v) });
  const s = v / 1000;
  return s < 120 ? t.seconds({ n: s.toFixed(1) }) : t.minutes({ n: (s / 60).toFixed(1) });
}

function lag(t: Words, seconds: number): string {
  return seconds < 60
    ? t.seconds({ n: String(seconds) })
    : t.minutes({ n: String(Math.round(seconds / 60)) });
}

function Checks(props: { readonly drill: DrillRun }): ReactNode {
  const t = useT().settings.backups;
  if (props.drill.checks.length === 0) return null;
  return (
    <ul className="m-0 mt-3 grid list-none gap-1 p-0" data-testid="dy-drill-checks">
      {props.drill.checks.map((c) => (
        <li key={c.name} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 text-[0.875rem]">
          <DyIcon name={c.ok ? 'checkc' : 'xc'} className={`mt-0.5 size-4 ${c.ok ? INK.green : INK.red}`} />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <b className="font-bold">
              {Object.hasOwn(t.checkNames, c.name)
                ? t.checkNames[c.name as keyof typeof t.checkNames]
                : c.name.replaceAll('_', ' ')}
            </b>
            <span className="sr-only">{c.ok ? t.checkPassed : t.checkFailed}</span>
            <span className="text-dy-muted"> — {c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Standby(props: { readonly s: StandbyStatus | undefined; readonly now: number }): ReactNode {
  const fmt = useFormat();
  const all = useT();
  const t = all.settings.backups;
  const w = all.screenKit.time;
  const s = props.s;
  if (!s?.enabled)
    return (
      <Panel title={t.standbyTitle} testId="dy-standby">
        <p className="m-0 flex items-center gap-1.5 text-[0.875rem] font-bold text-dy-muted">
          <DyIcon name="pause" className="size-4" /> {t.walOff}
        </p>
        <p className="m-0 mt-2 text-[0.875rem] text-dy-muted">
          {t.walHowA}
          <code>stack.env</code>
          {/* i18n-ignore: file / setting name */}
          {t.walHowB}
          <code>PG_WAL_ARCHIVE=on</code>
          {/* i18n-ignore: file / setting name */}
          {t.walHowC}
          <code>backup-config/offsite.env</code>
          {/* i18n-ignore: file / setting name */}
          {t.walHowD}
          <code>--infra</code>
          {/* i18n-ignore: file / setting name */}
          {t.walHowE}
        </p>
      </Panel>
    );
  const base = s.lastBaseBackup;
  const d = s.lastStandbyDrill;
  return (
    <Panel
      title={t.standbyTitle}
      testId="dy-standby"
      aside={
        s.pendingSegments === 0 ? (
          <Pill tone="green" icon="checkc">
            {t.current}
          </Pill>
        ) : (
          <Pill tone="amber" icon="clock">
            {t.behind({ lag: lag(t, s.lagSeconds) })}
          </Pill>
        )
      }
    >
      <KeyValue
        rows={[
          {
            k: t.lastShipped,
            v: s.lastShippedSegment
              ? t.shipped({ segment: s.lastShippedSegment, ago: agoText(s.lastShippedAt, props.now, w) })
              : s.offsiteConfigured
                ? t.notShipped
                : t.localOnly({ segment: s.lastArchivedSegment ?? '—' }),
            mono: s.lastShippedSegment !== null,
          },
          {
            k: t.lagLabel,
            v:
              s.pendingSegments === 0
                ? t.current
                : t.behindPending({ lag: lag(t, s.lagSeconds), n: s.pendingSegments }),
          },
          ...(s.lastError ? [{ k: t.error, v: s.lastError }] : []),
          ...(s.gaps.length > 0 ? [{ k: t.gap, v: t.missing({ list: s.gaps.join(', ') }), mono: true }] : []),
          {
            k: t.baseBackup,
            v: base ? (
              <span className="flex flex-wrap items-center gap-2">
                <Outcome value={base.outcome} />
                <span>{when(base.finishedAt ?? base.startedAt, fmt)}</span>
                <span className="text-dy-muted">
                  {t.baseDetail({ size: formatBytes(base.bytes), offsite: offsiteState(t, base.offsite) })}
                </span>
              </span>
            ) : (
              t.noBase
            ),
          },
          ...(base?.error ? [{ k: t.baseError, v: base.error }] : []),
          {
            k: t.standbyDrill,
            v: d ? (
              <span className="flex flex-wrap items-center gap-2">
                <Outcome value={d.outcome} />
                <span>{when(d.at, fmt)}</span>
                <span className="text-dy-muted">
                  {t.replayed({
                    n: d.replayedSegments,
                    time: ms(t, d.restoreMs),
                    recovered: d.recoveredTo ? when(d.recoveredTo, fmt) : '',
                  })}
                </span>
              </span>
            ) : (
              t.noStandbyDrill
            ),
          },
          ...(d?.error ? [{ k: t.drillError, v: d.error }] : []),
        ]}
      />
    </Panel>
  );
}

function offsite(t: Words, data: BackupOverview): string {
  const o = data.offsite;
  const run = data.lastBackup;
  if (!o?.configured) return t.offsiteOff;
  if (run?.offsite.status === 'failed')
    return t.offsiteFailed({ error: run.offsite.error ?? t.unknownError });
  if (run?.offsite.status === 'uploaded') return t.offsiteUploaded({ target: o.target ?? t.offsiteBucket });
  return o.target ?? t.offsiteConfigured;
}

export function BackupsView(): ReactNode {
  const fmt = useFormat();
  const all = useT();
  const t = all.settings.backups;
  const w = all.screenKit.time;
  const loader = useSubmit();
  const owner = useIsOwner();
  const [data, setData] = useState<BackupOverview | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const load = (): void => {
    void loader.run(async () => {
      setData(await getBackupOverview());
      setNow(Date.now());
    });
  };
  useEffect(load, []);

  if (data === null)
    return (
      <div className="flex flex-col gap-4">
        <ErrorLine error={loader.error} what={t.status} onRetry={load} />
        {loader.error === null ? <SkeletonRows label={t.loading} rows={4} /> : null}
      </div>
    );

  const h = HEALTH[data.health.state];
  const last = data.lastBackup;
  const drill = data.lastDrill;
  const hb = data.heartbeat;
  const standby = data.standby;
  const nextDrill = hb ? (hb.nextDrillAt ? when(hb.nextDrillAt, fmt) : hb.schedule.drill) : '—';
  return (
    <div className="flex flex-col gap-4" data-testid="dy-backups">
      <ErrorLine error={loader.error} what={t.status} onRetry={load} />
      <div
        role="status"
        data-testid="dy-backup-health"
        className={`flex flex-wrap items-start gap-3 rounded-[14px] border border-dy-line bg-dy-card px-4 py-3 shadow-dy`}
      >
        <DyIcon name={h.icon} className={`mt-0.5 size-5 shrink-0 ${INK[h.tone]}`} />
        <div className="min-w-0 flex-1">
          <p className={`m-0 font-bold ${INK[h.tone]}`}>{t.health[data.health.state]}</p>
          {data.health.reasons.length > 0 ? (
            <ul className="m-0 mt-1 list-disc pl-5 text-[0.875rem] text-dy-muted">
              {data.health.reasons.map((r) => (
                <li key={r.code + r.message}>{r.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <DyButton variant="ghost" icon="retry" busy={loader.busy} onClick={load}>
          {t.refresh}
        </DyButton>
      </div>

      <StatTiles label={t.summary}>
        <StatTile
          label={t.lastBackup}
          value={last ? agoText(last.finishedAt ?? last.startedAt, now, w) : '—'}
          note={last ? outcomeText(t, last.outcome) : t.none}
          tone={last ? (OUTCOME[last.outcome]?.tone ?? 'neutral') : 'neutral'}
        />
        <StatTile
          label={t.lastDrill}
          value={drill ? agoText(drill.finishedAt ?? drill.startedAt, now, w) : '—'}
          note={drill ? outcomeText(t, drill.outcome) : t.none}
          tone={drill ? (OUTCOME[drill.outcome]?.tone ?? 'neutral') : 'neutral'}
        />
        <StatTile
          label={t.standby}
          value={
            standby?.enabled
              ? standby.pendingSegments === 0
                ? t.current
                : lag(t, standby.lagSeconds)
              : t.off
          }
          note={
            standby?.enabled
              ? standby.pendingSegments === 0
                ? t.noWalLag
                : t.pending({ n: standby.pendingSegments })
              : t.walOff
          }
          tone={standby?.enabled ? (standby.pendingSegments === 0 ? 'green' : 'amber') : 'neutral'}
          testId="dy-standby-tile"
        />
        <StatTile
          label={t.onServer}
          value={data.storage ? formatBytes(data.storage.bytes) : '—'}
          note={
            data.storage
              ? t.storage({ n: data.storage.backups, free: formatBytes(data.storage.freeBytes) })
              : undefined
          }
        />
      </StatTiles>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={t.lastBackup} testId="dy-backup-last">
          <KeyValue
            rows={[
              {
                k: t.result,
                v: last ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <Outcome value={last.outcome} />
                    <span>{when(last.finishedAt ?? last.startedAt, fmt)}</span>
                    {last.tier ? <span className="text-dy-muted">({last.tier})</span> : null}
                  </span>
                ) : (
                  t.noBackup
                ),
              },
              ...(last?.error ? [{ k: t.error, v: last.error }] : []),
              {
                k: t.database,
                v:
                  last?.dbBytes != null
                    ? t.dbDetail({
                        size: formatBytes(last.dbBytes),
                        time: ms(t, last.durationMs),
                        schema: last.schemaVersion ?? '?',
                      })
                    : '—',
              },
              {
                k: t.secrets,
                v: last
                  ? last.secrets === 'ok'
                    ? t.secretsOk({ n: data.encryption?.recipients ?? 0 })
                    : last.secrets === 'failed'
                      ? t.secretsFailed
                      : t.secretsSkipped
                  : '—',
              },
              { k: t.offsite, v: offsite(t, data) },
              {
                k: t.lastSuccess,
                v: data.lastSuccessfulBackup ? when(data.lastSuccessfulBackup.finishedAt, fmt) : '—',
              },
              ...(last && last.warnings.length > 0 ? [{ k: t.warnings, v: last.warnings.join(' · ') }] : []),
            ]}
          />
        </Panel>
        <Panel title={t.scheduleTitle} testId="dy-backup-schedule">
          <KeyValue
            rows={[
              {
                k: t.schedule,
                v: hb
                  ? hb.schedule.mode === 'daily'
                    ? t.nightly({ time: hb.schedule.timeOfDay })
                    : t.every({ n: hb.schedule.intervalMinutes ?? 0 })
                  : '—',
              },
              { k: t.nextBackup, v: when(hb?.nextBackupAt, fmt) },
              {
                k: t.retention,
                v: hb
                  ? t.retentionValue({
                      daily: hb.retention.daily,
                      weekly: hb.retention.weekly,
                      monthly: hb.retention.monthly,
                    })
                  : '—',
              },
              { k: t.service, v: hb ? t.lastReport({ ago: agoText(hb.at, now, w) }) : t.notRunning },
            ]}
          />
        </Panel>
      </div>

      <Panel
        title={t.drillTitle}
        testId="dy-backup-drill"
        aside={drill ? <Outcome value={drill.outcome} /> : undefined}
      >
        {drill ? (
          <>
            <KeyValue
              rows={[
                { k: t.when, v: when(drill.finishedAt ?? drill.startedAt, fmt) },
                ...(drill.backupId ? [{ k: t.backup, v: drill.backupId, mono: true }] : []),
                {
                  k: t.restore,
                  v: t.restoreValue({ restore: ms(t, drill.restoreMs), total: ms(t, drill.totalMs) }),
                },
                {
                  k: t.size,
                  v: t.sizeValue({
                    dump: formatBytes(drill.dumpBytes),
                    restored: formatBytes(drill.restoredBytes),
                  }),
                },
                ...(drill.error ? [{ k: t.error, v: drill.error }] : []),
                { k: t.next, v: nextDrill },
              ]}
            />
            <Checks drill={drill} />
          </>
        ) : (
          <p className="m-0 text-[0.875rem] text-dy-muted">
            {t.noDrill} {nextDrill}
          </p>
        )}
      </Panel>

      <Standby s={standby} now={now} />

      {/* p17-host-actions part 3: the owner's management through the remyral-ctl host applier. */}
      {owner ? <BackupManagePanel overview={data} onChanged={load} /> : null}
    </div>
  );
}
