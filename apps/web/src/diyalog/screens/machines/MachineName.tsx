import { type SyntheticEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { MACHINE_NAME_MAX, renameWorker, type WorkerSummary } from '../../../api/workers';
import { useErrorText } from '../../../i18n/errors';
import { useT } from '../../../i18n/I18nProvider';
import { DY_INPUT } from '../../forms';
import { DyIcon } from '../../icons';
import { DyButton } from '../parts';

/**
 * p15-chat-cards-scroll item 4 ("Makinelerin isimlerini düzenleyebilmeliyim"): the machine page's name, editable in
 * place by an admin — a pencil in the title opens a one-line field (Enter saves, Escape cancels); empty or "Ana
 * bilgisayar adına dön" clears the name (the hostname again). The master keeps the name unique among listed machines.
 */
export function useMachineNameEdit(props: {
  readonly worker: WorkerSummary | null;
  readonly canEdit: boolean;
  readonly onSaved: () => void;
}): { readonly accessory: ReactNode; readonly editor: ReactNode; readonly status: ReactNode } {
  const t = useT().machines.page;
  const sayError = useErrorText();
  const { worker: w } = props;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const pencil = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const reopen = useRef(false);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    } else if (reopen.current) {
      reopen.current = false;
      pencil.current?.focus();
    }
  }, [editing]);

  const close = (): void => {
    reopen.current = true;
    setEditing(false);
    setError(null);
  };
  const save = async (name: string | null): Promise<void> => {
    if (w === null) return;
    const v = name === null ? '' : name.trim();
    if (Array.from(v).length > MACHINE_NAME_MAX) {
      setError(t.nameTooLong({ max: MACHINE_NAME_MAX }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await renameWorker(w.id, v === '' ? null : v);
      setSaved(t.nameSaved({ name: r.name }));
      close();
      props.onSaved();
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(false);
    }
  };
  const onSubmit = (e: SyntheticEvent): void => {
    e.preventDefault();
    void save(value);
  };

  if (w === null) return { accessory: null, editor: null, status: null };
  const accessory = props.canEdit ? (
    <button
      ref={pencil}
      type="button"
      aria-label={t.nameEdit}
      title={t.nameEdit}
      data-testid="machine-name-edit"
      onClick={() => {
        setValue(w.label ?? w.name);
        setSaved(null);
        setEditing(true);
      }}
      className="dy-press ml-2 inline-grid size-9 place-items-center rounded-[9px] align-middle text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
    >
      <DyIcon name="pen" className="size-4" />
    </button>
  ) : null;

  const hostname = w.hostname ?? w.id;
  const editor =
    props.canEdit && editing ? (
      <form className="flex flex-col gap-1.5" onSubmit={onSubmit} data-testid="machine-name-form">
        <label htmlFor="machine-name" className="text-[0.8125rem] font-bold text-dy-muted">
          {t.nameLabel}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={input}
            id="machine-name"
            value={value}
            maxLength={MACHINE_NAME_MAX * 2}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error !== null || undefined}
            aria-describedby="machine-name-hint"
            className={`${DY_INPUT} max-w-[28rem] flex-[1_1_16rem] text-[1.125rem] font-bold ${error === null ? 'border-dy-line-2' : 'border-dy-red'}`}
            onChange={(e) => {
              setValue(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
            }}
          />
          <DyButton type="submit" variant="primary" busy={busy}>
            {t.nameSave}
          </DyButton>
          <DyButton onClick={close} disabled={busy}>
            {t.nameCancel}
          </DyButton>
          {w.label === null ? null : (
            <DyButton
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void save(null);
              }}
            >
              {t.nameReset}
            </DyButton>
          )}
        </div>
        <p id="machine-name-hint" className="m-0 text-[0.78125rem] text-dy-muted">
          {t.nameHint({ hostname })}
        </p>
        {error === null ? null : (
          <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
            {error}
          </p>
        )}
      </form>
    ) : null;

  const status =
    saved === null ? null : (
      <span className="sr-only" role="status" data-testid="machine-name-saved">
        {saved}
      </span>
    );
  return { accessory, editor, status };
}
