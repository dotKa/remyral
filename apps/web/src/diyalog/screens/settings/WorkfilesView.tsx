import { type ReactNode, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  getProjectWorkfilesPolicy,
  getWorkfilesSettings,
  putProjectWorkfilesPolicy,
  putWorkfilesSettings,
  type WorkfilesSettings,
} from '../../../api/workfiles';
import { toApiError } from '../../../components/ui';
import { useErrorText } from '../../../i18n/errors';
import { useT } from '../../../i18n/I18nProvider';
import { DyApiError, DyInput, DyNotice } from '../kit';
import { DyButton, SkeletonRows } from '../parts';

const GIB = 1024 ** 3;

/**
 * p15-workspace-retention: Ayarlar → Çalışma dosyaları — how long the working directory of a repository-less job stays on
 * its machine after the job ended (0 = deleted at the end as before) and the per-machine cap (oldest unpinned first).
 * Admins change it (audited); everyone signed in reads it.
 */
export function WorkfilesView(): ReactNode {
  const t = useT().workfiles.settings;
  const sayError = useErrorText();
  const [s, setS] = useState<WorkfilesSettings | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [days, setDays] = useState('');
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    getWorkfilesSettings({ signal: ctl.signal }).then(
      (r) => {
        setS(r);
        setDays(String(r.retentionDays));
        setCap(String(Math.round((r.machineCapBytes / GIB) * 10) / 10));
      },
      (err: unknown) => {
        if (!ctl.signal.aborted) setError(toApiError(err));
      },
    );
    return () => {
      ctl.abort();
    };
  }, []);
  if (error !== null) return <DyApiError error={error} />;
  if (s === null) return <SkeletonRows label={t.title} rows={2} />;
  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await putWorkfilesSettings({
        retentionDays: Number(days),
        machineCapBytes: Math.round(Number(cap) * GIB),
      });
      setS(r);
      setNotice({ tone: 'green', text: t.saved });
    } catch (err) {
      setNotice({ tone: 'red', text: sayError(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label={t.title}
      className="flex max-w-[40rem] flex-col gap-3"
      data-testid="workfiles-settings"
    >
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.sub}</p>
      <DyInput
        label={t.retention}
        hint={t.retentionHint}
        type="number"
        min={0}
        max={s.limits.retentionDaysMax}
        value={days}
        onChange={(e) => {
          setDays(e.target.value);
        }}
      />
      <DyInput
        label={t.cap}
        hint={t.capHint}
        type="number"
        min={s.limits.machineCapBytesMin / GIB}
        step={0.5}
        value={cap}
        onChange={(e) => {
          setCap(e.target.value);
        }}
      />
      <DyButton
        variant="primary"
        busy={busy}
        className="self-start"
        onClick={() => {
          void save();
        }}
      >
        {t.save}
      </DyButton>
      {notice === null ? null : <DyNotice tone={notice.tone}>{notice.text}</DyNotice>}
    </section>
  );
}

/** A workspace project's own retention (Projeler → proje → Ağ erişimi tab of workspace projects). */
export function ProjectWorkfilesPolicy(props: {
  readonly project: string;
  readonly canEdit: boolean;
}): ReactNode {
  const t = useT().workfiles.settings;
  const sayError = useErrorText();
  const [global, setGlobal] = useState<number | null>(null);
  const [days, setDays] = useState('');
  const [notice, setNotice] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    getProjectWorkfilesPolicy(props.project, { signal: ctl.signal }).then(
      (r) => {
        setGlobal(r.globalDays);
        setDays(r.retentionDays === null ? '' : String(r.retentionDays));
      },
      () => undefined,
    );
    return () => {
      ctl.abort();
    };
  }, [props.project]);
  if (global === null) return null;
  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await putProjectWorkfilesPolicy(props.project, days.trim() === '' ? null : Number(days));
      setNotice({ tone: 'green', text: t.saved });
    } catch (err) {
      setNotice({ tone: 'red', text: sayError(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex max-w-[40rem] flex-col gap-2" data-testid="project-workfiles-policy">
      <DyInput
        label={t.project}
        hint={t.projectHint({ days: global })}
        type="number"
        min={0}
        value={days}
        disabled={!props.canEdit}
        onChange={(e) => {
          setDays(e.target.value);
        }}
      />
      {props.canEdit ? (
        <DyButton
          busy={busy}
          className="self-start"
          onClick={() => {
            void save();
          }}
        >
          {t.save}
        </DyButton>
      ) : null}
      {notice === null ? null : <DyNotice tone={notice.tone}>{notice.text}</DyNotice>}
    </div>
  );
}
