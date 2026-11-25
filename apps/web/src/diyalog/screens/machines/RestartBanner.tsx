import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getWorkerConfig } from '../../../api/workerConfig';
import { useT } from '../../../i18n/I18nProvider';
import { machinePath } from '../../../screens/fleet/machineLinks';
import { DyNotice } from '../../common/notices';

/** How often the banner re-reads the machine's report while a restart is pending (the restart clears it). */
const RECHECK_MS = 30_000;

/**
 * p22-harness-gaps (a pending restart was shown nowhere, so the machine screen says it at the top): saved settings that
 * wait for a restart of the machine are named at the top of every machine tab, with the way to the restart. The
 * report's `pendingRestart` is the source (the same list the local settings tab shows); it is re-read every 30 s while
 * it is not empty, so the banner leaves after the restart.
 */
export function RestartBanner(props: { readonly workerId: string; readonly isAdmin: boolean }): ReactNode {
  const t = useT().machineManaged.settings;
  const [pending, setPending] = useState<readonly string[]>([]);
  const { workerId, isAdmin } = props;
  useEffect(() => {
    if (!isAdmin) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (): void => {
      getWorkerConfig(workerId, { signal: ctrl.signal }).then(
        (view) => {
          const next = view.report?.effective.settings?.pendingRestart ?? [];
          setPending(next);
          if (next.length > 0) timer = setTimeout(load, RECHECK_MS);
        },
        () => undefined,
      );
    };
    load();
    return () => {
      ctrl.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [workerId, isAdmin]);
  if (pending.length === 0) return null;
  const labels = pending.map((p) => settingLabel(t, p));
  return (
    <DyNotice
      tone="amber"
      icon="retry"
      title={t.restartBannerTitle}
      testId="machine-restart-banner"
      action={<Link to={machinePath(workerId, 'admin')}>{t.restartBannerAction}</Link>}
    >
      <p className="m-0">{t.restartBannerBody({ settings: labels.join(', ') })}</p>
    </DyNotice>
  );
}

type SettingsTexts = ReturnType<typeof useT>['machineManaged']['settings'];

/** The panel's name of a setting path (the raw path for one without a label). */
function settingLabel(t: SettingsTexts, path: string): string {
  const known: Record<string, string> = {
    'updates.enabled': t.updatesEnabled,
    'updates.channel': t.channel,
    'updates.minVersion': t.minVersion,
    'updates.healthTimeoutSec': t.healthTimeout,
    logLevel: t.logLevel,
    telemetry: t.telemetry,
    'assistant.disabled': t.assistantDisabled,
    'assistant.maxSessions': t.maxSessions,
    'assistant.sandbox': t.assistantSandbox,
    'remoteOps.npmRegistry': t.npmRegistry,
    'remoteOps.restartable': t.restartable,
    'remoteOps.logFileBytes': t.logFileMib,
    'packageCaches.enabled': t.cachesEnabled,
    'probes.loginRecheckMinutes': t.loginRecheck,
    'probes.usageProbeMinutes': t.usageProbe,
    'probes.claudeLockMaxAgeMinutes': t.claudeLock,
    'sandbox.linuxLoginStoreView': t.linuxLoginStoreView,
    'sandbox.linuxPrivateNetwork': t.linuxPrivateNetwork,
  };
  return known[path] ?? path;
}
