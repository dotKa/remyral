import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { BackupOverview } from '../../../api/backups';
import {
  type BackupManage,
  cancelBackupChange,
  clearOffsite,
  getBackupManage,
  type HostAction,
  OPEN_STATES,
  type OffsiteInput,
  restoreBackup,
  runBackupNow,
  saveBackupSettings,
  saveOffsite,
  startDrill,
  testOffsite,
} from '../../../api/hostActions';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { formatBytes } from '../../../screens/backupBytes';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyApiError, DyNotice } from '../../common/notices';
import { DATE_TIME_NUMERIC } from '../../common/time';
import { DyDialog } from '../../DyDialog';
import { DyIcon } from '../../icons';
import { DyCheck, DyField } from '../forms';
import { DyButton, DySelect, EmptyLine, ErrorLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { HostRequestProgress } from './host-request';
import { CommandLine, NoApplierNotice, OutdatedNotice } from './ServerUpdatePanel';

/**
 * p17-host-actions part 3 (docs/design/p17-host-actions.md §5): Ayarlar → Yedekler → Yedekleri yönet (owners). A backup
 * or a restore drill now, the schedule / retention / drill / WAL archiving and the encryption recipients (at least two;
 * the private key is made offline), the off-site target (tested, stored sealed) and a restore of a listed backup (typed
 * confirmation, what is lost, a fresh authenticator code) — each a signed request the remyral-ctl host applier runs.
 * Without an applier the screen says so and shows the lines the operator writes instead.
 */

const AGE = /^age1[02-9ac-hj-np-z]{58}$/;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const BACKUP_KINDS = ['backup-run', 'backup-drill', 'backup-restore', 'backup-config', 'backup-offsite'];
const RUN_COMMAND = 'sudo remyral-ctl backup --reason manual'; // i18n-ignore: a command

interface Form {
  mode: 'daily' | 'interval';
  time: string;
  intervalMinutes: string;
  keepDaily: string;
  keepWeekly: string;
  keepMonthly: string;
  keepRecentHours: string;
  drillEnabled: boolean;
  drillWeekday: string;
  drillTime: string;
  walArchive: boolean;
  recipients: string[];
}

function formOf(m: BackupManage, o: BackupOverview): Form {
  const s = m.settings;
  const hb = o.heartbeat;
  const pick = (host: string | undefined, fallback: string): string =>
    host !== undefined && host !== '' ? host : fallback;
  const interval = pick(s?.intervalMinutes, hb?.schedule.intervalMinutes?.toString() ?? '');
  return {
    mode: interval === '' ? 'daily' : 'interval',
    time: pick(s?.time, hb?.schedule.timeOfDay ?? '02:30'),
    intervalMinutes: interval,
    keepDaily: pick(s?.keepDaily, hb?.retention.daily.toString() ?? ''),
    keepWeekly: pick(s?.keepWeekly, hb?.retention.weekly.toString() ?? ''),
    keepMonthly: pick(s?.keepMonthly, hb?.retention.monthly.toString() ?? ''),
    keepRecentHours: pick(s?.keepRecentHours, hb?.retention.keepRecentHours.toString() ?? ''),
    drillEnabled: s?.drillEnabled !== 'false',
    drillWeekday: pick(s?.drillWeekday, 'sun'),
    drillTime: pick(s?.drillTime, '04:00'),
    walArchive: s !== null ? s.walArchive === 'on' : o.standby?.enabled === true,
    // p17-panel-settings Part 0: keys waiting for the host time lock stay in the list (marked), so saving the schedule
    // does not withdraw them by accident; removing one here and saving withdraws it.
    recipients: [
      ...new Set([
        ...(s?.recipients ?? []),
        ...(s?.pending.find((p) => p.change === 'recipients')?.added ?? []),
      ]),
    ],
  };
}

/**
 * p17-panel-settings Part 0: the changes the host keeps waiting (a new encryption key, a new off-site target) — shown
 * first and in red, each with "İptal et" (a signed request that can only withdraw it).
 */
function PendingChanges(props: {
  readonly data: BackupManage;
  readonly busy: boolean;
  readonly acting: boolean;
  readonly onCancel: (change: 'recipients' | 'offsite' | 'all') => void;
}): ReactNode {
  const t = useT().hostActions.backups.pending;
  const fmt = useFormat();
  const pending = props.data.settings?.pending ?? [];
  if (pending.length === 0) return null;
  const canCancel = props.data.applier.managed && props.data.applier.kinds.includes('backup-change-cancel');
  return (
    <DyNotice
      tone="red"
      icon="shield"
      live
      title={t.title}
      testId="dy-backup-pending"
      action={
        canCancel && pending.length > 1 ? (
          <DyButton
            variant="danger"
            busy={props.acting}
            disabled={props.busy}
            onClick={() => {
              props.onCancel('all');
            }}
          >
            {t.cancelAll}
          </DyButton>
        ) : undefined
      }
    >
      <p className="m-0 text-[0.875rem]">{t.sub}</p>
      <ul className="m-0 mt-2 grid list-none gap-2 p-0">
        {pending.map((p) => (
          <li
            key={p.change}
            className="grid gap-1 rounded-[10px] border border-dy-line p-2"
            data-testid={`dy-backup-pending-${p.change}`}
          >
            <span className="font-bold">{p.change === 'recipients' ? t.recipients : t.offsite}</span>
            {p.change === 'recipients' ? (
              <span className="text-[0.8125rem]">
                {t.added}:{' '}
                {p.added.map((k) => (
                  <code key={k} className="font-dy-mono text-[0.75rem] break-all">
                    {k}{' '}
                  </code>
                ))}
              </span>
            ) : (
              <code className="font-dy-mono text-[0.8125rem] break-all">{p.target}</code>
            )}
            <span className="text-[0.8125rem]">
              {t.until({ when: fmt.dateWith(p.until, DATE_TIME_NUMERIC) })}
            </span>
            <span className="text-[0.75rem] text-dy-muted">
              {t.since({ when: fmt.dateWith(p.since, DATE_TIME_NUMERIC) })}
            </span>
            {canCancel ? (
              <div>
                <DyButton
                  variant="danger"
                  icon="xc"
                  busy={props.acting}
                  disabled={props.busy}
                  onClick={() => {
                    props.onCancel(p.change);
                  }}
                >
                  {t.cancel}
                </DyButton>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="m-0 mt-2 text-[0.75rem] text-dy-muted">{t.operator}</p>
    </DyNotice>
  );
}

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v.trim()));

/** The stack.env / recipients.txt lines an operator writes when there is no applier (nothing secret). */
function envLines(f: Form): string {
  return [
    `BACKUP_TIME=${f.mode === 'daily' ? f.time : ''}`,
    `BACKUP_INTERVAL_MINUTES=${f.mode === 'interval' ? f.intervalMinutes : ''}`,
    `BACKUP_KEEP_DAILY=${f.keepDaily}`,
    `BACKUP_KEEP_WEEKLY=${f.keepWeekly}`,
    `BACKUP_KEEP_MONTHLY=${f.keepMonthly}`,
    `BACKUP_KEEP_RECENT_HOURS=${f.keepRecentHours}`,
    `BACKUP_DRILL_ENABLED=${String(f.drillEnabled)}`,
    `BACKUP_DRILL_WEEKDAY=${f.drillWeekday}`,
    `BACKUP_DRILL_TIME=${f.drillTime}`,
    `PG_WAL_ARCHIVE=${f.walArchive ? 'on' : 'off'}`,
  ].join('\n');
}

export function BackupManagePanel(props: {
  readonly overview: BackupOverview;
  readonly onChanged: () => void;
}): ReactNode {
  const all = useT();
  const t = all.hostActions.backups;
  const fmt = useFormat();
  const loader = useSubmit();
  const act = useSubmit();
  const stepUp = useStepUp();
  const [data, setData] = useState<BackupManage | null>(null);
  const [current, setCurrent] = useState<HostAction | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [reason, setReason] = useState('');
  const [drillId, setDrillId] = useState('');
  const [newKey, setNewKey] = useState('');
  const [showLines, setShowLines] = useState(false);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const { overview, onChanged } = props;

  const load = useCallback((): void => {
    void loader.run(async () => {
      const m = await getBackupManage();
      setData(m);
      setCurrent((c) => m.open ?? c);
      setForm((f) => f ?? formOf(m, overview));
    });
  }, [loader, overview]);
  useEffect(load, []);

  if (data === null || form === null)
    return (
      <div className="flex flex-col gap-4">
        <ErrorLine error={loader.error} what={t.status} onRetry={load} />
        {loader.error === null ? <SkeletonRows label={t.loading} rows={2} /> : null}
      </div>
    );

  const a = data.applier;
  const supports = BACKUP_KINDS.every((k) => a.kinds.includes(k));
  const managed = a.managed && supports;
  const busy = current !== null && OPEN_STATES.includes(current.state);
  const usable = overview.backups.filter((b) => b.outcome !== 'failed');
  const verified = new Set(overview.drills.filter((d) => d.outcome === 'passed').map((d) => d.backupId));
  const keyOk = AGE.test(newKey.trim());
  const waitingKeys = new Set(data.settings?.pending.find((p) => p.change === 'recipients')?.added ?? []);
  const set = (patch: Partial<Form>): void => {
    setForm({ ...form, ...patch });
  };

  const submit = (fn: () => Promise<HostAction>, why?: string): void => {
    void act.run(async () => {
      try {
        setCurrent(await stepUp.run(fn, why));
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  };
  const saveSettings = (): void => {
    submit(() =>
      saveBackupSettings({
        time: form.mode === 'daily' ? form.time : '',
        intervalMinutes: form.mode === 'interval' ? num(form.intervalMinutes) : null,
        keepDaily: num(form.keepDaily),
        keepWeekly: num(form.keepWeekly),
        keepMonthly: num(form.keepMonthly),
        keepRecentHours: num(form.keepRecentHours),
        drillEnabled: form.drillEnabled,
        drillWeekday: form.drillWeekday,
        drillTime: form.drillTime,
        walArchive: form.walArchive,
        recipients: form.recipients,
      }),
    );
  };
  const picked = usable.find((b) => b.runId === restoreId) ?? null;

  return (
    <div className="flex flex-col gap-4" data-testid="dy-backup-manage">
      <ErrorLine error={loader.error} what={t.status} onRetry={load} />
      <div>
        <h2 className="m-0 text-[1.0625rem] font-bold">{t.title}</h2>
        <p className="m-0 mt-1 text-[0.875rem] text-dy-muted">{t.sub}</p>
      </div>
      <PendingChanges
        data={data}
        busy={busy}
        acting={act.busy}
        onCancel={(change) => {
          submit(() => cancelBackupChange(change));
        }}
      />
      {current !== null ? (
        <HostRequestProgress
          action={current}
          onFinished={(fin) => {
            setCurrent(fin);
            load();
            onChanged();
          }}
        />
      ) : null}
      {!a.managed ? (
        <NoApplierNotice lastSeen={a.lastSeen} command={RUN_COMMAND} testId="dy-backup-no-applier" />
      ) : !supports ? (
        <OutdatedNotice />
      ) : (
        <Panel title={t.now.title} testId="dy-backup-now">
          <div className="grid gap-3">
            <DyField
              label={t.now.reason}
              hint={t.now.reasonHint}
              value={reason}
              onChange={setReason}
              maxLength={200}
            />
            <div>
              <DyButton
                variant="primary"
                icon="shield"
                busy={act.busy}
                disabled={busy}
                onClick={() => {
                  submit(() => runBackupNow(reason));
                }}
              >
                {t.now.button}
              </DyButton>
            </div>
            <div className="grid gap-2 border-t border-dy-line pt-3">
              <p className="m-0 text-[0.8125rem] text-dy-muted">{t.now.drillHint}</p>
              <DySelect
                label={t.now.drillBackup}
                value={drillId}
                options={[['', t.now.newest], ...usable.map((b) => [b.runId, b.runId] as const)]}
                onChange={setDrillId}
                className="max-w-md"
              />
              <div>
                <DyButton
                  icon="checkc"
                  busy={act.busy}
                  disabled={busy}
                  onClick={() => {
                    submit(() => startDrill(drillId === '' ? null : drillId));
                  }}
                >
                  {t.now.drill}
                </DyButton>
              </div>
            </div>
          </div>
        </Panel>
      )}
      <DyApiError error={act.error} />

      <Panel title={t.schedule.title} testId="dy-backup-settings">
        <div className="grid gap-3 sm:grid-cols-2">
          <DySelect
            label={t.schedule.mode}
            value={form.mode}
            options={[
              ['daily', t.schedule.daily],
              ['interval', t.schedule.interval],
            ]}
            onChange={(v) => {
              set({ mode: v === 'interval' ? 'interval' : 'daily' });
            }}
          />
          {form.mode === 'daily' ? (
            <DyField
              label={t.schedule.time}
              value={form.time}
              onChange={(v) => {
                set({ time: v });
              }}
              mono
            />
          ) : (
            <DyField
              label={t.schedule.intervalMinutes}
              value={form.intervalMinutes}
              onChange={(v) => {
                set({ intervalMinutes: v });
              }}
              inputMode="numeric"
              mono
            />
          )}
          <DyField
            label={t.schedule.keepDaily}
            hint={t.schedule.defaultHint}
            value={form.keepDaily}
            onChange={(v) => {
              set({ keepDaily: v });
            }}
            inputMode="numeric"
            mono
          />
          <DyField
            label={t.schedule.keepWeekly}
            value={form.keepWeekly}
            onChange={(v) => {
              set({ keepWeekly: v });
            }}
            inputMode="numeric"
            mono
          />
          <DyField
            label={t.schedule.keepMonthly}
            value={form.keepMonthly}
            onChange={(v) => {
              set({ keepMonthly: v });
            }}
            inputMode="numeric"
            mono
          />
          <DyField
            label={t.schedule.keepRecentHours}
            value={form.keepRecentHours}
            onChange={(v) => {
              set({ keepRecentHours: v });
            }}
            inputMode="numeric"
            mono
          />
          <DyCheck
            label={t.schedule.drillEnabled}
            checked={form.drillEnabled}
            onChange={(v) => {
              set({ drillEnabled: v });
            }}
          />
          <div />
          {form.drillEnabled ? (
            <>
              <DySelect
                label={t.schedule.drillWeekday}
                value={form.drillWeekday}
                options={WEEKDAYS.map((d) => [d, t.schedule.weekdays[d] ?? d] as const)}
                onChange={(v) => {
                  set({ drillWeekday: v });
                }}
              />
              <DyField
                label={t.schedule.drillTime}
                value={form.drillTime}
                onChange={(v) => {
                  set({ drillTime: v });
                }}
                mono
              />
            </>
          ) : null}
          <DyCheck
            label={t.schedule.wal}
            hint={t.schedule.walHint}
            checked={form.walArchive}
            onChange={(v) => {
              set({ walArchive: v });
            }}
            className="sm:col-span-2"
          />
        </div>
        <div className="mt-4 grid gap-2 border-t border-dy-line pt-3" data-testid="dy-backup-recipients">
          <p className="m-0 font-bold">{t.schedule.recipients}</p>
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.schedule.recipientsHint}</p>
          <ul className="m-0 grid list-none gap-1 p-0">
            {form.recipients.map((r) => (
              <li key={r} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-dy-mono text-[0.8125rem]">{r}</code>
                {waitingKeys.has(r) ? (
                  <Pill tone="red" icon="clock">
                    {all.hostActions.backups.pending.waiting}
                  </Pill>
                ) : null}
                <DyButton
                  variant="ghost"
                  icon="xc"
                  aria-label={t.schedule.recipientRemove({ key: r.slice(0, 12) })}
                  onClick={() => {
                    set({ recipients: form.recipients.filter((x) => x !== r) });
                  }}
                />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <DyField
              label={t.schedule.recipientAdd}
              value={newKey}
              onChange={setNewKey}
              mono
              autoComplete="off"
              wrapClassName="min-w-0 flex-1"
              error={newKey.trim() !== '' && !keyOk ? t.schedule.recipientBad : undefined}
            />
            <DyButton
              icon="plus"
              disabled={!keyOk}
              onClick={() => {
                const k = newKey.trim();
                if (!form.recipients.includes(k)) set({ recipients: [...form.recipients, k] });
                setNewKey('');
              }}
            >
              {t.schedule.recipientAddButton}
            </DyButton>
          </div>
          {form.recipients.length < 2 ? (
            <p className="m-0 text-[0.8125rem] font-bold text-dy-amber-ink" data-testid="dy-recipients-few">
              {t.schedule.recipientsTooFew}
            </p>
          ) : null}
          <details>
            <summary className="cursor-pointer text-[0.8125rem] font-bold">{t.schedule.keygenTitle}</summary>
            <p className="m-0 mt-2 text-[0.8125rem]">{t.schedule.keygenBody}</p>
            <CommandLine text="age-keygen -o remyral-backup-identity.txt" />
          </details>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {managed ? (
            <DyButton
              variant="primary"
              busy={act.busy}
              disabled={busy || form.recipients.length < 2}
              onClick={saveSettings}
            >
              {t.schedule.save}
            </DyButton>
          ) : (
            <DyButton
              onClick={() => {
                setShowLines(true);
              }}
            >
              {t.schedule.showLines}
            </DyButton>
          )}
        </div>
        {!managed && showLines ? (
          <div className="mt-3 grid gap-2" data-testid="dy-backup-env-lines">
            <p className="m-0 font-bold">{t.schedule.operatorTitle}</p>
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.schedule.operatorHint}</p>
            <pre className="m-0 rounded-[10px] bg-dy-sunk p-3 font-dy-mono text-[0.8125rem] whitespace-pre-wrap">
              {envLines(form)}
            </pre>
          </div>
        ) : null}
      </Panel>

      <OffsitePanel data={data} managed={managed} busy={busy} onRequest={setCurrent} onSaved={load} />

      <Panel title={t.list.title} flush testId="dy-backup-list">
        {overview.backups.length === 0 ? (
          <EmptyLine>{t.list.none}</EmptyLine>
        ) : (
          <Rows label={t.list.title}>
            {overview.backups.map((b) => (
              <Row
                key={b.runId}
                title={<span className="font-dy-mono text-[0.875rem]">{b.runId}</span>}
                meta={
                  <>
                    <span>{fmt.dateWith(b.finishedAt ?? b.startedAt, DATE_TIME_NUMERIC)}</span>
                    <span>{formatBytes(b.dbBytes)}</span>
                    {verified.has(b.runId) ? (
                      <Pill tone="green" icon="checkc">
                        {t.list.verified}
                      </Pill>
                    ) : (
                      <span className="text-dy-muted">{t.list.notVerified}</span>
                    )}
                  </>
                }
                trail={
                  managed && b.outcome !== 'failed' ? (
                    <DyButton
                      variant="danger"
                      icon="retry"
                      disabled={busy}
                      onClick={() => {
                        setRestoreId(b.runId);
                        setTyped('');
                      }}
                    >
                      {t.list.restore}
                    </DyButton>
                  ) : undefined
                }
              />
            ))}
          </Rows>
        )}
      </Panel>

      <DyDialog
        open={picked !== null}
        onClose={() => {
          setRestoreId(null);
        }}
        title={picked === null ? '' : t.list.restoreTitle({ id: picked.runId })}
        size="md"
        testId="dy-restore-dialog"
        footer={
          <>
            <DyButton
              onClick={() => {
                setRestoreId(null);
              }}
            >
              {t.list.cancel}
            </DyButton>
            <DyButton
              variant="danger"
              icon="retry"
              disabled={picked === null || typed.trim() !== picked.runId}
              onClick={() => {
                if (picked === null) return;
                const id = picked.runId;
                setRestoreId(null);
                submit(() => restoreBackup(id, typed.trim()), t.list.stepUp({ id }));
              }}
            >
              {t.list.confirm}
            </DyButton>
          </>
        }
      >
        {picked === null ? null : (
          <div className="grid gap-3">
            <p className="m-0">{t.list.restoreBody}</p>
            <p className="m-0 font-bold text-dy-red-ink" data-testid="dy-restore-lost">
              <DyIcon name="shield" className="mr-1 inline size-4" />
              {t.list.lost({ when: fmt.dateWith(picked.finishedAt ?? picked.startedAt, DATE_TIME_NUMERIC) })}
            </p>
            {picked.schemaVersion === null ? null : (
              <p className="m-0 text-[0.8125rem] text-dy-muted">
                {t.list.schema({ schema: picked.schemaVersion })}
              </p>
            )}
            <DyField
              label={t.list.confirmLabel({ id: picked.runId })}
              value={typed}
              onChange={setTyped}
              mono
              autoComplete="off"
            />
          </div>
        )}
      </DyDialog>
    </div>
  );
}

function OffsitePanel(props: {
  readonly data: BackupManage;
  readonly managed: boolean;
  readonly busy: boolean;
  readonly onRequest: (a: HostAction) => void;
  readonly onSaved: () => void;
}): ReactNode {
  const t = useT().hostActions.backups.offsite;
  const act = useSubmit();
  const stepUp = useStepUp();
  const o = props.data.offsite;
  const c = o.config;
  const [provider, setProvider] = useState(c?.provider ?? 'r2');
  const [endpoint, setEndpoint] = useState(c?.endpoint ?? '');
  const [region, setRegion] = useState(c?.region ?? 'auto');
  const [bucket, setBucket] = useState(c?.bucket ?? '');
  const [prefix, setPrefix] = useState(c?.prefix ?? '');
  const [pathStyle, setPathStyle] = useState(c?.pathStyle ?? true);
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [useStorage, setUseStorage] = useState(false);
  const [test, setTest] = useState<Readonly<Record<string, unknown>> | null>(null);

  const input = (): OffsiteInput => ({
    provider,
    endpoint: endpoint.trim(),
    region: region.trim(),
    bucket: bucket.trim(),
    prefix: prefix.trim(),
    pathStyle,
    ...(useStorage
      ? { useStorageKeys: true }
      : keyId.trim() !== '' || secret !== ''
        ? { accessKeyId: keyId.trim(), secretAccessKey: secret }
        : {}),
  });
  const testText = (r: Readonly<Record<string, unknown>>): string =>
    r.ok === true
      ? t.testOk({ ms: typeof r.latencyMs === 'number' ? String(r.latencyMs) : '?' })
      : t.testFailed({
          error: `${typeof r.error === 'string' ? r.error : '?'}${typeof r.hint === 'string' ? ` — ${r.hint}` : ''}`,
        });
  const operatorLines = [
    `BACKUP_S3_BUCKET=${bucket}`,
    `BACKUP_S3_REGION=${region}`,
    ...(endpoint === '' ? [] : [`BACKUP_S3_ENDPOINT=${endpoint}`]),
    ...(prefix === '' ? [] : [`BACKUP_S3_PREFIX=${prefix}`]),
    `BACKUP_S3_FORCE_PATH_STYLE=${String(pathStyle)}`,
    `BACKUP_S3_ACCESS_KEY_ID=${keyId === '' ? (o.keyIdHint === null ? '' : `…${o.keyIdHint}`) : keyId}`,
    `BACKUP_S3_SECRET_ACCESS_KEY=${t.secretPlaceholder}`,
  ].join('\n');

  return (
    <Panel title={t.title} sub={t.sub} testId="dy-backup-offsite">
      <p className="m-0 mb-3 text-[0.875rem]">
        <b>{t.current}: </b>
        {props.data.settings?.offsite ? (
          <code className="font-dy-mono">{props.data.settings.offsite}</code>
        ) : (
          t.none
        )}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <DySelect
          label={t.provider}
          value={provider}
          options={['aws', 'r2', 'minio', 'other'].map((p) => [p, t.providers[p] ?? p] as const)}
          onChange={(v) => {
            setProvider(v);
            if (v === 'r2') {
              setRegion('auto');
              setPathStyle(true);
            }
          }}
        />
        <DyField label={t.endpoint} value={endpoint} onChange={setEndpoint} mono />
        <DyField label={t.region} value={region} onChange={setRegion} mono />
        <DyField label={t.bucket} value={bucket} onChange={setBucket} mono />
        <DyField label={t.prefix} value={prefix} onChange={setPrefix} mono />
        <DyCheck label={t.pathStyle} checked={pathStyle} onChange={setPathStyle} />
        {o.storageKeysAvailable ? (
          <DyCheck
            label={t.useStorage}
            checked={useStorage}
            onChange={setUseStorage}
            className="sm:col-span-2"
          />
        ) : null}
        {useStorage ? null : (
          <>
            <DyField label={t.accessKeyId} value={keyId} onChange={setKeyId} mono autoComplete="off" />
            <DyField
              label={t.secretAccessKey}
              value={secret}
              onChange={setSecret}
              type="password"
              autoComplete="new-password"
              hint={o.keyIdHint === null ? undefined : t.keepKeys({ hint: o.keyIdHint })}
            />
          </>
        )}
      </div>
      {test !== null ? (
        <div className="mt-3" data-testid="dy-offsite-test">
          <DyNotice tone={test.ok === true ? 'green' : 'red'}>{testText(test)}</DyNotice>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <DyButton
          busy={act.busy}
          onClick={() => {
            void act.run(async () => {
              setTest(await testOffsite(input()));
            });
          }}
        >
          {t.test}
        </DyButton>
        <DyButton
          variant="primary"
          busy={act.busy}
          disabled={props.busy}
          onClick={() => {
            void act.run(async () => {
              try {
                const out = await stepUp.run(() => saveOffsite(input()));
                setTest(out.test);
                setSecret('');
                if (out.request !== null) props.onRequest(out.request);
                props.onSaved();
              } catch (err) {
                if (err instanceof StepUpCancelledError) return;
                throw err;
              }
            });
          }}
        >
          {t.save}
        </DyButton>
        {c !== null || props.data.settings?.offsite ? (
          <DyButton
            variant="danger"
            busy={act.busy}
            disabled={props.busy}
            onClick={() => {
              void act.run(async () => {
                try {
                  const out = await stepUp.run(() => clearOffsite());
                  if (out.request !== null) props.onRequest(out.request);
                  props.onSaved();
                } catch (err) {
                  if (err instanceof StepUpCancelledError) return;
                  throw err;
                }
              });
            }}
          >
            {t.remove}
          </DyButton>
        ) : null}
      </div>
      <DyApiError error={act.error} />
      {props.managed ? null : (
        <div className="mt-3 grid gap-2" data-testid="dy-offsite-operator">
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.operatorHint}</p>
          <pre className="m-0 rounded-[10px] bg-dy-sunk p-3 font-dy-mono text-[0.8125rem] whitespace-pre-wrap">
            {operatorLines}
          </pre>
        </div>
      )}
    </Panel>
  );
}
