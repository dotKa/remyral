import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { type BackupOverview, getBackupOverview } from '../../../api/backups';
import {
  getHostActions,
  type HostAction,
  type HostActions,
  OPEN_STATES,
  requestRollback,
  requestUpgrade,
} from '../../../api/hostActions';
import { getUpdateStatus, type UpdateStatus } from '../../../api/selfhost';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyCopyButton } from '../../common/actions';
import { DyApiError, DyNotice } from '../../common/notices';
import { DATE_TIME_NUMERIC } from '../../common/time';
import { DyDialog } from '../../DyDialog';
import { KeyValue } from '../../KeyValue';
import { DyCheck, DyField } from '../forms';
import {
  agoText,
  DyButton,
  DySelect,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
} from '../parts';
import { HostRequestProgress, STATE_LOOK } from './host-request';

/**
 * p17-host-actions (docs/design/p17-host-actions.md): Ayarlar → Sürümler → Sunucu — "Şimdi güncelle" (a newer release
 * of the verified feed) and "Geri al" (a release still on the host, optionally restoring a backup first) as signed
 * requests for the remyral-ctl host applier. Owners only; every request asks for a fresh authenticator code. Without
 * an applier (Coolify / EC2) the buttons are not shown: the panel says what the operator runs instead.
 */

export function CommandLine(props: { readonly text: string }): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <code className="block min-w-0 flex-1 rounded-[8px] bg-dy-sunk px-2.5 py-2 font-dy-mono text-[0.8125rem] [overflow-wrap:anywhere]">
        {props.text}
      </code>
      <DyCopyButton text={props.text} />
    </div>
  );
}

/** "Bu kurulumda host uygulayıcısı yok" — and what the operator does instead (never a dead button). */
export function NoApplierNotice(props: {
  readonly lastSeen: string | null;
  readonly command: string | null;
  readonly testId?: string;
}): ReactNode {
  const all = useT();
  const t = all.hostActions.noApplier;
  return (
    <div data-testid={props.testId ?? 'dy-no-applier'}>
      <DyNotice tone="amber" icon="shield" title={t.title}>
        <p className="m-0">{t.body}</p>
        {props.lastSeen === null ? null : (
          <p className="m-0 mt-1">
            {t.lastSeen({ ago: agoText(props.lastSeen, Date.now(), all.screenKit.time) })}
          </p>
        )}
        {props.command === null ? null : (
          <div className="mt-2 grid gap-1">
            <span>{t.remyralCtl}</span>
            <CommandLine text={props.command} />
          </div>
        )}
        <p className="m-0 mt-2">{t.coolify}</p>
      </DyNotice>
    </div>
  );
}

const CHECK_COMMAND = 'sudo remyral-ctl upgrade'; // i18n-ignore: a command, the same in every language

export function OutdatedNotice(): ReactNode {
  const t = useT().hostActions;
  return (
    <div data-testid="dy-applier-outdated">
      <DyNotice tone="amber" icon="shield">
        {t.outdatedA}
        <code>{CHECK_COMMAND}</code>
        {t.outdatedB}
      </DyNotice>
    </div>
  );
}

export function ServerUpdatePanel(): ReactNode {
  const all = useT();
  const t = all.hostActions;
  const fmt = useFormat();
  const loader = useSubmit();
  const act = useSubmit();
  const stepUp = useStepUp();
  const [data, setData] = useState<HostActions | null>(null);
  const [feed, setFeed] = useState<UpdateStatus | null>(null);
  const [current, setCurrent] = useState<HostAction | null>(null);
  const [target, setTarget] = useState('');
  const [accept, setAccept] = useState(false);
  const [back, setBack] = useState('');
  const [restore, setRestore] = useState(false);
  const [backups, setBackups] = useState<BackupOverview | null>(null);
  const [backupId, setBackupId] = useState('');
  const [typed, setTyped] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback((): void => {
    void loader.run(async () => {
      const [h, f] = await Promise.all([getHostActions(), getUpdateStatus().catch(() => null)]);
      setData(h);
      setFeed(f);
      setCurrent((c) => h.open ?? c);
    });
  }, [loader]);
  useEffect(load, []);

  useEffect(() => {
    if (!restore || backups !== null) return;
    getBackupOverview().then(setBackups, () => undefined);
  }, [restore, backups]);

  if (data === null)
    return (
      <div className="flex flex-col gap-4">
        <ErrorLine error={loader.error} what={t.status} onRetry={load} />
        {loader.error === null ? <SkeletonRows label={t.loading} rows={3} /> : null}
      </div>
    );

  const a = data.applier;
  const supports = a.kinds.includes('upgrade') && a.kinds.includes('rollback');
  const running = a.current ?? feed?.currentVersion ?? null;
  const newer = feed?.newer ?? [];
  const chosen = newer.find((r) => r.version === (target || newer[0]?.version)) ?? null;
  const backTargets = a.releases.filter((v) => v !== a.current);
  const backTo = back || backTargets[0] || '';
  const busy = current !== null && OPEN_STATES.includes(current.state);
  const candidates = (backups?.backups ?? []).filter((b) => b.outcome !== 'failed');
  const picked = candidates.find((b) => b.runId === backupId) ?? null;
  const hostCommand = newer[0] ? `sudo remyral-ctl upgrade --to ${newer[0].version}` : null;

  const submit = (fn: () => Promise<HostAction>, why: string): void => {
    void act.run(async () => {
      try {
        setCurrent(await stepUp.run(fn, why));
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  };
  const upgrade = (): void => {
    if (chosen === null) return;
    submit(
      () => requestUpgrade({ version: chosen.version, acceptBreaking: accept }),
      t.update.stepUp({ version: chosen.version }),
    );
  };
  const rollback = (): void => {
    setConfirmOpen(false);
    submit(
      () =>
        requestRollback(
          restore && picked !== null
            ? { version: backTo, backupId: picked.runId, restoreDatabase: true, confirm: typed.trim() }
            : { version: backTo },
        ),
      t.rollback.stepUp({ version: backTo }),
    );
  };
  // p18-confirm-dialog: the typed backup id lives in the confirm dialog, not on the page.
  const restoreReady = !restore || picked !== null;
  const typedOk = picked !== null && typed.trim() === picked.runId;

  return (
    <div className="flex flex-col gap-4" data-testid="dy-server-panel">
      <ErrorLine error={loader.error} what={t.status} onRetry={load} />
      <Panel title={t.title} sub={t.sub} testId="dy-server-version">
        <KeyValue
          rows={[
            { k: t.running, v: running ?? t.unknown, mono: running !== null },
            ...(a.previous ? [{ k: t.previous, v: a.previous, mono: true }] : []),
            ...(a.releases.length > 0 ? [{ k: t.onHost, v: a.releases.join(', '), mono: true }] : []),
            ...(a.managed
              ? [
                  {
                    k: t.applier,
                    v: t.applierSeen({
                      version: a.version ?? '?',
                      ago: agoText(a.lastSeen, Date.now(), all.screenKit.time),
                    }),
                  },
                ]
              : []),
          ]}
        />
      </Panel>

      {current !== null ? (
        <HostRequestProgress
          action={current}
          onFinished={(fin) => {
            setCurrent(fin);
            load();
          }}
        />
      ) : null}

      {!a.managed ? (
        <NoApplierNotice lastSeen={a.lastSeen} command={hostCommand} />
      ) : !supports ? (
        <OutdatedNotice />
      ) : (
        <>
          <Panel title={t.update.title} testId="dy-server-upgrade">
            {chosen === null ? (
              <p className="m-0 text-[0.875rem] text-dy-muted">
                {feed?.configured === true && running !== null
                  ? t.update.upToDate({ version: running })
                  : t.update.noFeed}
              </p>
            ) : (
              <div className="grid gap-3">
                <DySelect
                  label={t.update.version}
                  value={chosen.version}
                  options={newer.map(
                    (r, i) =>
                      [r.version, i === 0 ? t.update.newest({ version: r.version }) : r.version] as const,
                  )}
                  onChange={(v) => {
                    setTarget(v);
                    setAccept(false);
                  }}
                  className="max-w-xs"
                />
                {chosen.summary === '' ? null : <p className="m-0 text-[0.875rem]">{chosen.summary}</p>}
                {chosen.breaking.length === 0 ? null : (
                  <div data-testid="dy-server-breaking">
                    <p className="m-0 mb-1 font-bold text-dy-red-ink">{t.update.breaking}</p>
                    <ul className="m-0 mb-2 pl-5 text-[0.875rem]">
                      {chosen.breaking.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                    <DyCheck label={t.update.acceptBreaking} checked={accept} onChange={setAccept} />
                  </div>
                )}
                <details>
                  <summary className="cursor-pointer text-[0.8125rem] font-bold">{t.update.notes}</summary>
                  <pre className="m-0 mt-2 max-h-60 overflow-auto rounded-[10px] bg-dy-sunk p-3 text-[0.8125rem] whitespace-pre-wrap">
                    {chosen.notes}
                  </pre>
                </details>
                <p className="m-0 text-[0.8125rem] text-dy-muted">{t.update.downtime}</p>
                <div>
                  <DyButton
                    variant="primary"
                    icon="rocket"
                    busy={act.busy}
                    disabled={busy || (chosen.breaking.length > 0 && !accept)}
                    onClick={upgrade}
                  >
                    {t.update.button}
                  </DyButton>
                </div>
              </div>
            )}
          </Panel>

          <Panel title={t.rollback.title} testId="dy-server-rollback">
            {backTargets.length === 0 ? (
              <p className="m-0 text-[0.875rem] text-dy-muted">{t.rollback.none}</p>
            ) : (
              <div className="grid gap-3">
                <DySelect
                  label={t.rollback.version}
                  value={backTo}
                  options={backTargets.map((v) => [v, v] as const)}
                  onChange={setBack}
                  className="max-w-xs"
                />
                <DyCheck
                  label={t.rollback.restore}
                  hint={t.rollback.restoreHint}
                  checked={restore}
                  onChange={(v) => {
                    setRestore(v);
                    setTyped('');
                  }}
                  testId="dy-rollback-restore"
                />
                {restore ? (
                  <div
                    className="grid gap-3 rounded-[10px] border border-dy-line p-3"
                    data-testid="dy-rollback-backup"
                  >
                    {candidates.length === 0 ? (
                      <p className="m-0 text-[0.875rem] text-dy-muted">{t.rollback.noBackups}</p>
                    ) : (
                      <DySelect
                        label={t.rollback.backup}
                        value={backupId}
                        options={[
                          ['', t.rollback.chooseBackup],
                          ...candidates.map(
                            (b) =>
                              [
                                b.runId,
                                `${b.runId} — ${fmt.dateWith(b.finishedAt ?? b.startedAt, DATE_TIME_NUMERIC)}`,
                              ] as const,
                          ),
                        ]}
                        onChange={(v) => {
                          setBackupId(v);
                          setTyped('');
                        }}
                      />
                    )}
                    {picked === null ? null : (
                      <p
                        className="m-0 text-[0.875rem] font-bold text-dy-red-ink"
                        data-testid="dy-rollback-lost"
                      >
                        {t.rollback.lost({
                          when: fmt.dateWith(picked.finishedAt ?? picked.startedAt, DATE_TIME_NUMERIC),
                        })}
                      </p>
                    )}
                  </div>
                ) : null}
                <div>
                  <DyButton
                    variant="danger"
                    icon="retry"
                    busy={act.busy}
                    disabled={busy || backTo === '' || !restoreReady}
                    onClick={() => {
                      if (restore) {
                        setTyped('');
                        setConfirmOpen(true);
                      } else rollback();
                    }}
                  >
                    {t.rollback.button}
                  </DyButton>
                </div>
              </div>
            )}
          </Panel>
          <DyApiError error={act.error} />
        </>
      )}

      {data.recent.length > 0 ? (
        <Panel title={t.recent} flush testId="dy-server-recent">
          <Rows label={t.recent}>
            {data.recent.map((r) => (
              <Row
                key={r.id}
                title={
                  <span className="flex flex-wrap items-baseline gap-2">
                    <b>{t.progress.kinds[r.kind] ?? r.kind}</b>
                    {typeof r.params.version === 'string' ? (
                      <span className="font-dy-mono text-[0.875rem]">{r.params.version}</span>
                    ) : null}
                  </span>
                }
                meta={<span>{agoText(r.requestedAt, Date.now(), all.screenKit.time)}</span>}
                trail={
                  <Pill tone={STATE_LOOK[r.state].tone} icon={STATE_LOOK[r.state].icon}>
                    {t.progress.states[r.state] ?? r.state}
                  </Pill>
                }
              />
            ))}
          </Rows>
        </Panel>
      ) : (
        <EmptyLine>{t.none}</EmptyLine>
      )}

      <DyDialog
        open={confirmOpen}
        onClose={() => {
          setConfirmOpen(false);
        }}
        title={t.rollback.dialogTitle}
        description={
          picked === null ? undefined : t.rollback.dialogBody({ id: picked.runId, version: backTo })
        }
        size="sm"
        testId="dy-rollback-confirm"
        footer={
          <>
            <DyButton
              onClick={() => {
                setConfirmOpen(false);
              }}
            >
              {t.rollback.dialogCancel}
            </DyButton>
            <DyButton variant="danger" icon="retry" disabled={!typedOk} onClick={rollback}>
              {t.rollback.dialogConfirm}
            </DyButton>
          </>
        }
      >
        {picked === null ? null : (
          <DyField
            label={t.rollback.confirmLabel({ id: picked.runId })}
            value={typed}
            onChange={setTyped}
            mono
            autoComplete="off"
            error={typed !== '' && typed.trim() !== picked.runId ? t.rollback.confirmMismatch : undefined}
          />
        )}
      </DyDialog>
    </div>
  );
}
