import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  getMyIdeExtensions,
  type IdeUserExtensions,
  putMyIdeExtensions,
  resetMyIdeSettings,
} from '../../api/ideExtensions';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { DyNotice } from '../common/notices';
import { DyButton } from '../screens/parts';
import { toast } from '../toast/store';

/**
 * p19-ide W3 (docs/design/p19-ide.md §4): the Tam IDE panel's "Eklentilerim" — the caller picks their
 * own extensions from what the administrator allowed and the project does not deny. The project's required ones are
 * always installed (shown checked, not removable); recommended ones are marked. Changes apply at the next start of a
 * workspace. Below: the synced settings (sizes, last save) and "Ayarları sıfırla".
 */
export function IdeExtensionsPicker(props: { readonly project: string }): ReactNode {
  const t = useT().ide.extensions;
  const sayError = useErrorText();
  const { project } = props;
  const [data, setData] = useState<IdeUserExtensions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (signal?: AbortSignal) => {
      getMyIdeExtensions(project, signal === undefined ? {} : { signal }).then(
        (d) => {
          setData(d);
          setDraft(d.mine);
          setError(null);
        },
        (err: unknown) => {
          if (signal?.aborted !== true) setError(sayError(err));
        },
      );
    },
    [project, sayError],
  );
  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal);
    return () => {
      ctl.abort();
    };
  }, [load]);

  if (error !== null)
    return (
      <DyNotice tone="red" testId="ide-ext-error">
        {error}
      </DyNotice>
    );
  if (data === null) return null;
  const dirty = draft.length !== data.mine.length || draft.some((x) => !data.mine.includes(x));
  const toggle = (id: string): void => {
    setDraft((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  };
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const mine = await putMyIdeExtensions(draft.filter((id) => data.available.some((a) => a.id === id)));
      setData({ ...data, mine });
      setDraft(mine);
      toast({ tone: 'success', title: t.saved });
    } catch (err) {
      toast({ tone: 'error', title: sayError(err) });
    } finally {
      setBusy(false);
    }
  };
  const reset = async (): Promise<void> => {
    setBusy(true);
    try {
      await resetMyIdeSettings();
      toast({ tone: 'success', title: t.settingsReset });
      load();
    } catch (err) {
      toast({ tone: 'error', title: sayError(err) });
    } finally {
      setBusy(false);
    }
  };
  const kib = (n: number | null): string =>
    n === null ? '—' : `${String(Math.max(1, Math.round(n / 1024)))} KiB`; // i18n-ignore: a unit
  return (
    <details className="rounded-[9px] border border-dy-line px-3 py-2" data-testid="ide-extensions">
      <summary className="cursor-pointer font-bold">
        {t.title}{' '}
        <span className="font-normal text-dy-muted">
          {t.count({ n: draft.length + data.required.length })}
        </span>
      </summary>
      <div className="mt-2 grid gap-2">
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.purpose}</p>
        {data.blocked.length === 0 ? null : (
          <DyNotice tone="amber" testId="ide-ext-blocked">
            {t.blocked({ list: data.blocked.map((b) => b.id).join(', ') })}
          </DyNotice>
        )}
        {data.available.length === 0 ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="ide-ext-empty">
            {t.empty}
          </p>
        ) : (
          <ul className="grid gap-1" aria-label={t.title}>
            {data.available.map((e) => {
              const checked = e.required || draft.includes(e.id);
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-2" data-testid="ide-ext-item">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={e.required || busy}
                      onChange={() => {
                        toggle(e.id);
                      }}
                      data-testid={`ide-ext-${e.id}`}
                    />
                    <span className="font-bold">{e.displayName}</span>
                  </label>
                  <span className="font-dy-mono text-[0.75rem] text-dy-muted">
                    {e.id}@{e.version}
                  </span>
                  {e.required ? (
                    <span className="text-[0.75rem] text-dy-muted" data-testid="ide-ext-required">
                      {t.required}
                    </span>
                  ) : e.recommended ? (
                    <span className="text-[0.75rem] text-dy-muted" data-testid="ide-ext-recommended">
                      {t.recommended}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <DyButton
            variant="primary"
            busy={busy}
            disabled={!dirty}
            onClick={() => void save()}
            data-testid="ide-ext-save"
          >
            {t.save}
          </DyButton>
          <span className="text-[0.75rem] text-dy-muted">{t.nextStart}</span>
        </div>
        <div
          className="flex flex-wrap items-center gap-2 border-t border-dy-line pt-2"
          data-testid="ide-settings-sync"
        >
          <span className="text-[0.8125rem]">
            {data.settings.updatedAt === null
              ? t.settingsNone
              : t.settingsLine({
                  settings: kib(data.settings.settingsBytes),
                  keybindings: kib(data.settings.keybindingsBytes),
                })}
          </span>
          {data.settings.updatedAt === null ? null : (
            <DyButton
              variant="ghost"
              busy={busy}
              onClick={() => void reset()}
              data-testid="ide-settings-reset"
            >
              {t.settingsResetButton}
            </DyButton>
          )}
        </div>
      </div>
    </details>
  );
}
