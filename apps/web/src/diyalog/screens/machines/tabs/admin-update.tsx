import { type ReactNode, useEffect, useState } from 'react';
import type { WorkerOverview } from '../../../../api/fleet';
import { getReleases, targetWorkerUpdate } from '../../../../api/releases';
import type { WorkerDetail } from '../../../../api/workers';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { compareVersions } from '../../../../screens/fleet/releaseVersion';
import { useSubmit } from '../../../../screens/useSubmit';
import { DATE_TIME_NUMERIC } from '../../../common/time';
import { KeyValue, type KeyValueRow } from '../../../KeyValue';
import type { Tone } from '../../../tone';
import { DyApiError, DyCheck, DyNotice } from '../../forms';
import { DyButton, DySelect, Panel, Pill } from '../../parts';
import { DyConfirmDialog } from '../../../common/actions';
import { useGuardedValue } from './admin-guard';

/**
 * p17-worker-managed Part 1 — Makine → Yönetim → Sürüm: the machine's running version, channel and pin, and the
 * updater's last result shown prominently (a silent rollback such as 1.1.4 → 1.1.3 must be visible: outcome, reason
 * and the updater's own line). Owners and admins change the channel, pin a version (a lower one is a rollback), roll
 * back to the previous version, retry a failed version or remove the pin — `POST /workers/:id/update`, each through
 * step-up; a rollback needs a second press. An offline machine takes the request when it connects.
 */

const CHANNELS = ['stable', 'canary'] as const;
type Channel = (typeof CHANNELS)[number];

const STATUS_TONE: Readonly<Record<string, Tone>> = {
  succeeded: 'green',
  rolled_back: 'red',
  failed: 'red',
  refused: 'amber',
  timed_out: 'amber',
  superseded: 'neutral',
  offered: 'teal',
  downloading: 'teal',
  deferred: 'teal',
  activating: 'teal',
};

type Body = Parameters<typeof targetWorkerUpdate>[1];

export function UpdatePanel(props: {
  readonly worker: WorkerDetail;
  readonly overview: WorkerOverview | undefined;
  readonly isAdmin: boolean;
  readonly onChanged: () => void;
}): ReactNode {
  const { worker: w, overview: o } = props;
  const t = useT().machineManaged.update;
  const fmt = useFormat();
  const submit = useSubmit();
  const guarded = useGuardedValue();
  const [versions, setVersions] = useState<readonly string[]>([]);
  const rel = o?.release;
  const current: Channel = rel?.channel === 'canary' ? 'canary' : 'stable';
  const [channel, setChannel] = useState<Channel>(current);
  const [pinTo, setPinTo] = useState('');
  const [force, setForce] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setChannel(current);
  }, [current]);
  useEffect(() => {
    if (!props.isAdmin) return;
    let live = true;
    getReleases()
      .then((r) => {
        if (live)
          setVersions([...new Set(r.releases.map((x) => x.version))].sort((a, b) => compareVersions(b, a)));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [props.isAdmin]);

  const last = rel?.lastAttempt ?? null;
  const previous = rel?.previousVersion ?? null;
  const send = (body: Body, why: string): void => {
    setArmed(null);
    setDone(false);
    void submit.run(async () => {
      const r = await guarded(
        () => targetWorkerUpdate(w.id, { ...body, ...(force ? { force: true } : {}) }),
        why,
      );
      if (r !== null) {
        setDone(true);
        props.onChanged();
      }
    });
  };

  const rows: KeyValueRow[] = [
    { k: t.running, v: w.workerVersion, mono: true },
    { k: t.channel, v: t.channels[current] },
    { k: t.pinned, v: rel?.targetVersion ?? t.notPinned, mono: rel?.targetVersion != null },
  ];
  if (previous !== null) rows.push({ k: t.previous, v: previous, mono: true });

  const trouble = last !== null && (last.status === 'rolled_back' || last.status === 'failed');
  const statusText = (s: string): string =>
    Object.hasOwn(t.last.status, s) ? t.last.status[s as keyof typeof t.last.status] : s.replaceAll('_', ' ');
  const lastBlock =
    last === null ? (
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.last.none}</p>
    ) : (
      <DyNotice
        tone={trouble ? 'red' : (STATUS_TONE[last.status] ?? 'neutral')}
        live={trouble}
        testId="update-last-result"
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span>{t.last.title}</span>
            <Pill tone={STATUS_TONE[last.status] ?? 'neutral'}>{statusText(last.status)}</Pill>
            <span className="font-dy-mono text-[0.8125rem] font-normal">
              {t.last.line({ from: last.fromVersion ?? '?', to: last.toVersion })}
            </span>
            <span className="text-[0.8125rem] font-normal text-dy-muted">
              {fmt.dateWith(last.at, DATE_TIME_NUMERIC)}
            </span>
          </span>
        }
      >
        {last.status === 'rolled_back' ? (
          <p className="m-0">{t.last.rolledBack({ to: last.toVersion, running: w.workerVersion })}</p>
        ) : last.status === 'failed' ? (
          <p className="m-0">{t.last.failed({ to: last.toVersion })}</p>
        ) : null}
        {last.reason !== null ? (
          <p className="m-0 mt-1 text-[0.8125rem]">
            <b>{t.last.reason}:</b> <span className="font-dy-mono">{last.reason}</span>
          </p>
        ) : null}
        {last.detail != null && last.detail !== '' ? (
          <p className="m-0 mt-1 text-[0.8125rem]" data-testid="update-last-detail">
            <b>{t.last.detail}:</b> {last.detail}
          </p>
        ) : null}
        {trouble && last.hasDiagnostics === true ? (
          <p className="m-0 mt-1 text-[0.8125rem] text-dy-muted">{t.last.diagnostics}</p>
        ) : null}
      </DyNotice>
    );

  const a = t.actions;
  const pinDowngrade = pinTo !== '' && compareVersions(pinTo, w.workerVersion) < 0;
  // p18-confirm-dialog: the second step is a confirm dialog, not a button that turns into "Evet, …".
  const confirmRow = (key: string, label: string, confirm: string, body: Body, why: string): ReactNode => (
    <>
      <DyButton
        variant="danger"
        icon="retry"
        disabled={submit.busy || submit.blocked}
        aria-haspopup="dialog"
        onClick={() => {
          setArmed(key);
        }}
        data-testid={key}
      >
        {label}
      </DyButton>
      <DyConfirmDialog
        open={armed === key}
        onClose={() => {
          setArmed(null);
        }}
        title={label}
        description={why}
        confirmLabel={confirm}
        cancelLabel={a.cancel}
        variant="warn"
        busy={submit.busy}
        testId={`${key}-dialog`}
        confirmTestId={`${key}-confirm`}
        onConfirm={() => {
          send(body, why);
        }}
      />
    </>
  );

  return (
    <Panel title={t.title} sub={t.sub} testId="machine-update">
      <div className="flex flex-col gap-4">
        <KeyValue rows={rows} />
        {lastBlock}
        {!props.isAdmin ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{a.readOnly}</p>
        ) : (
          <div className="flex flex-col gap-3" data-testid="update-actions">
            <div className="flex flex-wrap items-end gap-2">
              <DySelect
                label={a.channelLabel}
                value={channel}
                options={CHANNELS.map((c) => [c, t.channels[c]] as const)}
                onChange={(v) => {
                  setChannel(v === 'canary' ? 'canary' : 'stable');
                }}
                className="min-w-[12rem]"
              />
              <DyButton
                disabled={
                  submit.busy || submit.blocked || (channel === current && rel?.targetVersion == null)
                }
                onClick={() => {
                  send({ channel }, a.why.channel({ name: w.name }));
                }}
                data-testid="update-save-channel"
              >
                {a.saveChannel}
              </DyButton>
            </div>
            <p className="m-0 text-[0.8125rem] text-dy-muted">{a.channelHint}</p>
            <div className="flex flex-wrap items-end gap-2">
              <DySelect
                label={a.versionLabel}
                value={pinTo}
                options={[['', a.chooseVersion] as const, ...versions.map((v) => [v, v] as const)]}
                onChange={setPinTo}
                className="min-w-[12rem]"
              />
              <DyButton
                disabled={pinTo === '' || submit.busy || submit.blocked}
                onClick={() => {
                  send(
                    { channel: current, version: pinTo, ...(pinDowngrade ? { rollback: true } : {}) },
                    pinDowngrade
                      ? a.why.rollback({ name: w.name, version: pinTo })
                      : a.why.pin({ name: w.name, version: pinTo }),
                  );
                }}
                data-testid="update-pin"
              >
                {a.pin}
              </DyButton>
              {rel?.targetVersion != null ? (
                <DyButton
                  variant="ghost"
                  disabled={submit.busy || submit.blocked}
                  onClick={() => {
                    send({ channel: current }, a.why.unpin({ name: w.name }));
                  }}
                  data-testid="update-unpin"
                >
                  {a.unpin}
                </DyButton>
              ) : null}
            </div>
            {pinDowngrade ? <DyNotice tone="amber">{a.pinDowngrade}</DyNotice> : null}
            <div className="flex flex-wrap items-center gap-2">
              {previous === null ? (
                <span className="text-[0.8125rem] text-dy-muted">{a.noPrevious}</span>
              ) : (
                confirmRow(
                  'update-rollback',
                  a.rollback({ version: previous }),
                  a.rollbackConfirm({ version: previous }),
                  { channel: current, version: previous, rollback: true },
                  a.why.rollback({ name: w.name, version: previous }),
                )
              )}
              {trouble ? (
                <DyButton
                  icon="retry"
                  disabled={submit.busy || submit.blocked}
                  onClick={() => {
                    send(
                      {
                        channel: current,
                        version: last.toVersion,
                        ...(compareVersions(last.toVersion, w.workerVersion) < 0 ? { rollback: true } : {}),
                      },
                      a.why.retry({ name: w.name, version: last.toVersion }),
                    );
                  }}
                  data-testid="update-retry"
                >
                  {a.retry({ version: last.toVersion })}
                </DyButton>
              ) : null}
            </div>
            <DyCheck label={a.force} checked={force} onChange={setForce} />
            {done ? (
              <DyNotice tone="green" live testId="update-done">
                {w.connected ? a.done : a.offline}
              </DyNotice>
            ) : null}
            <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
          </div>
        )}
      </div>
    </Panel>
  );
}
