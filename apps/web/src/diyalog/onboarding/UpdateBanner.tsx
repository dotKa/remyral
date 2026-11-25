import { type ReactNode, useEffect, useState } from 'react';
import { getUpdateStatus, type UpdateStatus } from '../../api/selfhost';
import { useT } from '../../i18n/I18nProvider';
import { DyCopyButton } from '../common/actions';
import { DyDialog } from '../DyDialog';
import { DyIcon } from '../icons';
import { DyButton, DyButtonLink } from '../screens/parts';
import { useIsOwner } from './useOnboarding';

/**
 * p16-selfhost-onboarding §4: "Güncelleme mevcut" — for owners, when the master's signed update feed names a newer
 * control-plane release than the installed one. Read every 30 minutes (the master itself checks the feed every 6 h
 * and the host copy every 5 min); hidden per version on this browser. "Notlar" shows the release notes, breaking
 * changes, the worker floor and the host command — the console never upgrades the server itself.
 * p17-host-actions: "Şimdi güncelle" opens Ayarlar → Sürümler → Sunucu, where a remyral-ctl host applier runs the update
 * from a signed request (the master still never touches the host).
 */
const DISMISS_KEY = 'remyral.update.dismissed';
const POLL_MS = 30 * 60_000;
// A background read: a 401 (signed out meanwhile) is not re-checked here; the shell handles the session.
const quietStatus = (): Promise<UpdateStatus> => getUpdateStatus({ noSessionRetry: true });

function dismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function DyServerUpdateBanner(props: { readonly load?: () => Promise<UpdateStatus> }): ReactNode {
  const owner = useIsOwner();
  const t = useT().selfhost.update;
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [hidden, setHidden] = useState<string | null>(dismissed);
  const [open, setOpen] = useState(false);
  const load = props.load ?? quietStatus;
  useEffect(() => {
    if (!owner) return;
    let alive = true;
    const read = (): void => {
      load().then(
        (s) => {
          if (alive) setStatus(s);
        },
        () => undefined,
      );
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [owner, load]);
  const next = status?.updateAvailable === true ? (status.newer[0] ?? null) : null;
  if (!owner || next === null || hidden === next.version) return null;
  return (
    <>
      <div
        role="status"
        data-testid="dy-server-update"
        className="dy-surface flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-dy-line bg-dy-teal-soft px-4 py-2 text-[0.875rem] text-dy-teal-ink"
      >
        <DyIcon name="rocket" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 font-bold">
          {t.banner({ version: next.version })}
          {next.summary === '' ? null : <span className="font-normal"> — {next.summary}</span>}
        </span>
        <DyButton
          variant="secondary"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t.notes}
        </DyButton>
        {/* p17-host-actions: the update itself, on the host applier (Ayarlar → Sürümler → Sunucu). */}
        <DyButtonLink to="/settings/releases?tab=server" variant="primary" icon="rocket">
          {t.updateNow}
        </DyButtonLink>
        <DyButton
          variant="ghost"
          onClick={() => {
            try {
              localStorage.setItem(DISMISS_KEY, next.version);
            } catch {
              // a private window: hidden for this page only
            }
            setHidden(next.version);
          }}
        >
          {t.dismiss}
        </DyButton>
      </div>
      <DyDialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={t.dialogTitle({ version: next.version })}
        description={
          status?.currentVersion === null || status === null
            ? undefined
            : t.current({ version: status.currentVersion })
        }
        size="md"
        footer={
          <DyButton
            onClick={() => {
              setOpen(false);
            }}
          >
            {t.close}
          </DyButton>
        }
      >
        <div className="grid gap-4" data-testid="dy-server-update-notes">
          {next.breaking.length === 0 ? null : (
            <div>
              <p className="m-0 mb-1 font-bold text-dy-red-ink">{t.breaking}</p>
              <ul className="m-0 pl-5">
                {next.breaking.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          <pre className="m-0 max-h-72 overflow-auto rounded-[10px] bg-dy-sunk p-3 text-[0.8125rem] whitespace-pre-wrap">
            {next.notes}
          </pre>
          <p className="m-0 text-[0.875rem] text-dy-muted">
            {t.machineFloor({ version: next.minWorkerVersion })}
          </p>
          {status?.command === null || status === null ? null : (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold">{t.command}</span>
                <DyCopyButton text={status.command} />
              </div>
              <code className="block rounded-[8px] bg-dy-sunk px-2.5 py-2 font-dy-mono text-[0.8125rem]">
                {status.command}
              </code>
              <p className="m-0 text-[0.8125rem] text-dy-muted">{t.commandHint}</p>
            </div>
          )}
        </div>
      </DyDialog>
    </>
  );
}
