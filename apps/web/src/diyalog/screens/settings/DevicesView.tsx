import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  listTrustedDevices,
  revokeAllTrustedDevices,
  revokeTrustedDevice,
  type TrustedDevice,
} from '../../../api/auth';
import type { ApiError } from '../../../api/client';
import {
  getPreferences,
  getPushStatus,
  type PushDevice,
  type PushStatus,
  registerPushSubscription,
  revokePushDevice,
  sendTestPush,
  updatePreferences,
} from '../../../api/notifications';
import { toApiError } from '../../../components/ui';
import { promptInstall, useInstallState } from '../../../pwa/install';
import {
  currentSubscription,
  disablePush,
  enablePush,
  isIos,
  isStandalone,
  permission,
  PushSetupError,
  pushSupport,
  RECOMMENDED_PUSH_KINDS,
  subscriptionJson,
} from '../../../pwa/push';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon } from '../../icons';
import { ConfirmButton, DyApiError, DyNotice } from '../forms';
import { DyButton, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { DyTime } from '../records';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { DATE_NUMERIC } from '../../common/time';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p12-diyalog wave 2 (W3) — Ayarlar → Cihazlar in the Diyalog language, same rules as the classic `DevicesPage`
 * (p8-pwa, p5-remember-device): this device (push on / off with step-up to add it, the recommended kinds on the first
 * device, a test notification; install as an app or the iOS / browser instructions), the push devices with revoke
 * (no step-up), and the trusted browsers with revoke / revoke all (no step-up: it only removes trust).
 */

type Here = 'checking' | 'on' | 'off';

function ThisDevicePanel(props: {
  readonly status: PushStatus | null;
  readonly loadError: ApiError | null;
  readonly here: Here;
  readonly onChanged: () => Promise<void>;
  readonly submit: ReturnType<typeof useSubmit>;
  readonly setDone: (s: string | null) => void;
  readonly done: string | null;
}): ReactNode {
  const { status, here, submit, setDone } = props;
  const stepUp = useStepUp();
  const install = useInstallState();
  const [setupError, setSetupError] = useState<string | null>(null);
  const support = pushSupport();
  const standalone = isStandalone(window, navigator);
  const ios = isIos(navigator);
  const t = useT().settings.devices.here;

  function turnOn(): void {
    const publicKey = status?.publicKey;
    if (!publicKey) return;
    setDone(null);
    setSetupError(null);
    void submit.run(async () => {
      try {
        await stepUp.run(() => enablePush(publicKey, (sub) => registerPushSubscription(sub)), t.stepUp);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        if (err instanceof PushSetupError) {
          setSetupError(err.message);
          return;
        }
        throw err;
      }
      // First device: push on for decisions and failures (changeable in Bildirimler), as classic.
      const prefs = await getPreferences();
      if (!prefs.kinds.some((k) => k.push)) {
        await updatePreferences({
          kinds: prefs.kinds
            .filter((k) => RECOMMENDED_PUSH_KINDS.includes(k.kind))
            .map((k) => ({ kind: k.kind, push: true })),
        });
        setDone(t.onFirst);
      } else {
        setDone(t.on);
      }
      await props.onChanged();
    });
  }

  function turnOff(): void {
    setDone(null);
    void submit.run(async () => {
      await disablePush('user');
      setDone(t.off);
      await props.onChanged();
    });
  }

  function test(): void {
    setDone(null);
    void submit.run(async () => {
      const r = await sendTestPush();
      setDone(t.testSent({ n: r.sent }));
    });
  }

  function installNow(): void {
    void promptInstall().then((outcome) => {
      if (outcome === 'accepted') setDone(t.installed);
    });
  }

  let pushBody: ReactNode;
  if (props.loadError !== null) pushBody = <DyApiError error={props.loadError} />;
  // p12-diyalog-default (visual tour): the check holds the height of the usual answer (a sentence and a button).
  else if (status === null)
    pushBody = <p className="m-0 min-h-[5.5rem] text-[0.875rem] text-dy-muted">{t.checking}</p>;
  else if (!status.available) pushBody = <p className="m-0 text-[0.875rem] text-dy-muted">{t.unavailable}</p>;
  else if (support === 'ios-needs-install')
    pushBody = (
      <DyNotice tone="neutral" icon="flag">
        {t.iosNeedsInstall}
      </DyNotice>
    );
  else if (support === 'unsupported')
    pushBody = <p className="m-0 text-[0.875rem] text-dy-muted">{t.unsupported}</p>;
  else if (permission() === 'denied') pushBody = <DyNotice tone="amber">{t.denied}</DyNotice>;
  else if (here === 'on')
    pushBody = (
      <div className="flex flex-col gap-3">
        <p className="m-0 flex flex-wrap items-center gap-2 text-[0.875rem]">
          <Pill tone="green" icon="checkc">
            {t.onPill}
          </Pill>
          <span className="text-dy-muted">
            {t.pickBefore}
            <Link to="/settings/notifications" className="font-medium text-dy-teal-ink">
              {t.pickLink}
            </Link>
            {t.pickAfter}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <DyButton icon="send" disabled={submit.busy} onClick={test}>
            {t.test}
          </DyButton>
          <DyButton disabled={submit.busy} onClick={turnOff}>
            {t.turnOff}
          </DyButton>
        </div>
      </div>
    );
  else
    pushBody = (
      <div className="flex flex-col gap-3">
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.offBody}</p>
        <div>
          <DyButton
            variant="primary"
            icon="flag"
            busy={submit.busy}
            disabled={submit.blocked || here === 'checking'}
            onClick={turnOn}
          >
            {t.turnOn}
          </DyButton>
        </div>
      </div>
    );

  let installBody: ReactNode;
  if (standalone || install.installedNow)
    installBody = <p className="m-0 text-[0.875rem] text-dy-muted">{t.standalone}</p>;
  else if (install.canPrompt)
    installBody = (
      <div className="flex flex-col gap-3">
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.canInstall}</p>
        <div>
          <DyButton icon="tray" onClick={installNow}>
            {t.install}
          </DyButton>
        </div>
      </div>
    );
  else if (ios)
    installBody = (
      <p className="m-0 text-[0.875rem] text-dy-muted">
        {t.iosA}
        <b className="text-dy-ink">{t.iosShare}</b>
        {t.iosB}
        <b className="text-dy-ink">{t.iosAdd}</b>
        {t.iosC}
      </p>
    );
  else
    installBody = (
      <p className="m-0 text-[0.875rem] text-dy-muted">
        {t.browserA}
        <b className="text-dy-ink">{t.browserInstall}</b>
        {t.browserB}
        <b className="text-dy-ink">{t.browserAdd}</b>
        {t.browserC}
      </p>
    );

  return (
    <Panel title={t.title} testId="dy-this-device">
      <div className="flex flex-col gap-4">
        <section aria-label={t.push} className="flex flex-col gap-2">
          <h3 className="m-0 text-[0.875rem] font-bold">{t.push}</h3>
          {pushBody}
        </section>
        <section aria-label={t.app} className="flex flex-col gap-2 border-t border-dy-line pt-4">
          <h3 className="m-0 text-[0.875rem] font-bold">{t.app}</h3>
          {installBody}
        </section>
        {setupError !== null ? (
          <DyNotice tone="amber" live>
            {setupError}
          </DyNotice>
        ) : null}
        {props.done !== null ? (
          <DyNotice tone="green" live>
            {props.done}
          </DyNotice>
        ) : null}
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </Panel>
  );
}

function PushDevicesPanel(props: {
  readonly devices: readonly PushDevice[];
  readonly hereId: string | null;
  readonly busy: boolean;
  readonly onRevoke: (d: PushDevice) => void;
}): ReactNode {
  const all = useT().settings.devices;
  const t = all.push;
  return (
    <Panel
      title={t.title}
      count={String(props.devices.length)}
      countLabel={all.deviceCount({ n: props.devices.length })}
      sub={t.sub}
      flush
      testId="dy-push-devices"
    >
      {props.devices.length === 0 ? (
        <EmptyLine testId="no-push-devices">{t.empty}</EmptyLine>
      ) : (
        <Rows label={t.title}>
          {props.devices.map((d) => {
            const here = d.id === props.hereId;
            return (
              <Row
                key={d.id}
                testId="dy-push-device"
                lead={<DyIcon name="flag" className="size-4" />}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {d.label}
                    {here ? <Pill tone="teal">{t.thisDevice}</Pill> : null}
                  </span>
                }
                meta={
                  <>
                    <span>
                      {t.lastSeen} <DyTime iso={d.lastSeenAt} />
                    </span>
                    <span>
                      {d.lastSuccessAt === null ? (
                        t.notDelivered
                      ) : (
                        <>
                          {t.lastDelivered} <DyTime iso={d.lastSuccessAt} />
                        </>
                      )}
                    </span>
                    <span className="font-dy-mono">{d.service}</span>
                  </>
                }
                actions={
                  <ConfirmButton
                    label={t.remove}
                    question={t.removeQuestion({ label: d.label, here })}
                    confirmLabel={t.removeConfirm}
                    disabled={props.busy}
                    testId={`push-revoke-${d.id}`}
                    ariaLabel={t.removeAria({ label: d.label, here })}
                    onConfirm={() => {
                      props.onRevoke(d);
                    }}
                  />
                }
              />
            );
          })}
        </Rows>
      )}
    </Panel>
  );
}

function TrustedDevicesPanel(): ReactNode {
  const fmt = useFormat();
  const all = useT().settings.devices;
  const t = all.trusted;
  const [devices, setDevices] = useState<readonly TrustedDevice[] | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const submit = useSubmit();

  const load = useCallback(async () => {
    try {
      setDevices(await listTrustedDevices());
      setLoadError(null);
    } catch (err) {
      setLoadError(toApiError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function revoke(d: TrustedDevice): void {
    setDone(null);
    void submit.run(async () => {
      await revokeTrustedDevice(d.id);
      setDone(d.current ? t.removedCurrent : t.removed({ label: d.label }));
      await load();
    });
  }

  function revokeAll(): void {
    setDone(null);
    void submit.run(async () => {
      const r = await revokeAllTrustedDevices();
      setDone(t.removedAll({ n: r.revoked }));
      await load();
    });
  }

  return (
    <Panel
      title={t.title}
      count={devices === null ? undefined : String(devices.length)}
      countLabel={devices === null ? undefined : all.deviceCount({ n: devices.length })}
      sub={t.sub}
      aside={
        devices !== null && devices.length > 0 ? (
          <ConfirmButton
            label={t.removeAll}
            question={t.removeAllQuestion}
            disabled={submit.busy}
            onConfirm={revokeAll}
            testId="revoke-all-trusted"
          />
        ) : undefined
      }
      flush
      testId="dy-trusted-devices"
    >
      <div className="px-4 empty:hidden">
        <DyApiError error={loadError} />
      </div>
      {devices === null ? (
        loadError === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : null
      ) : devices.length === 0 ? (
        <EmptyLine testId="no-trusted-devices">{t.empty}</EmptyLine>
      ) : (
        <Rows label={t.title}>
          {devices.map((d) => (
            <Row
              key={d.id}
              testId="dy-trusted-device"
              lead={<DyIcon name="shield" className="size-4" />}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {d.label}
                  {d.current ? <Pill tone="teal">{t.thisBrowser}</Pill> : null}
                </span>
              }
              meta={
                <>
                  <span>
                    {t.lastUsed} <DyTime iso={d.lastUsedAt} />
                  </span>
                  <span>
                    {t.expires} <time dateTime={d.expiresAt}>{fmt.dateWith(d.expiresAt, DATE_NUMERIC)}</time>
                  </span>
                  <span className="font-dy-mono">
                    {d.createdIp === null ? t.ipUnknown : t.ipFrom({ ip: d.createdIp })}
                  </span>
                </>
              }
              actions={
                <ConfirmButton
                  label={t.remove}
                  question={t.removeQuestion({ label: d.label, current: d.current })}
                  confirmLabel={t.removeConfirm}
                  disabled={submit.busy}
                  testId={`trusted-revoke-${d.id}`}
                  ariaLabel={t.removeAria({ label: d.label, current: d.current })}
                  onConfirm={() => {
                    revoke(d);
                  }}
                />
              }
            />
          ))}
        </Rows>
      )}
      <div className="flex flex-col gap-2 px-4 pb-4 empty:hidden">
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </Panel>
  );
}

export function DevicesView(): ReactNode {
  const submit = useSubmit();
  const t = useT().settings.devices.push;
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [here, setHere] = useState<Here>('checking');
  const [hereId, setHereId] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const support = pushSupport();

  const load = useCallback(async () => {
    try {
      const s = await getPushStatus();
      setStatus(s);
      setLoadError(null);
      const sub = support === 'supported' && permission() === 'granted' ? await currentSubscription() : null;
      if (sub && s.publicKey !== null) {
        // Refresh (no step-up for a device the master knows) and learn which row is this browser (classic).
        try {
          const r = await registerPushSubscription(subscriptionJson(sub));
          setHere('on');
          setHereId(r.device.id);
          return;
        } catch {
          // Unknown to the master (revoked elsewhere): off; turning it on registers it again.
        }
      }
      setHere('off');
      setHereId(null);
    } catch (err) {
      setLoadError(toApiError(err));
      setHere('off');
    }
  }, [support]);

  useEffect(() => {
    void load();
  }, [load]);

  function revoke(d: PushDevice): void {
    setDone(null);
    void submit.run(async () => {
      if (d.id === hereId) await disablePush('user');
      else await revokePushDevice(d.id);
      setDone(t.removed({ label: d.label }));
      await load();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <ThisDevicePanel
        status={status}
        loadError={loadError}
        here={here}
        onChanged={load}
        submit={submit}
        setDone={setDone}
        done={done}
      />

      <TrustedDevicesPanel />
      {/* p12-diyalog-default (visual tour): the push device list after the trusted devices — it appears only once the
          push status is read, and above them it pushed them down. */}
      {status?.available === true ? (
        <PushDevicesPanel devices={status.devices} hereId={hereId} busy={submit.busy} onRevoke={revoke} />
      ) : null}
    </div>
  );
}
