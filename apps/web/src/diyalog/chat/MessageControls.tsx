import { fill } from '@remyral/i18n';
import { type ReactNode, useCallback, useId, useRef, useState } from 'react';
import { actedEffects, type TurnEffects } from '../../api/chatComplete';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { DyDialog } from '../DyDialog';
import { DyIcon } from '../icons';
import { DyButton, DySelect } from '../screens/parts';
import { DyModelPicker, useRuntimeModels } from '../screens/shared/ModelPicker';
import type { ModelRuntime } from '../../api/models';

/**
 * p16-chat-complete (docs/design/p16-chat-complete.md §1): the controls on the conversation's messages — edit one of
 * your messages (inline), regenerate the last answer (optionally with another ready engine / model), retry a failed
 * last turn — and the question the master asks when the answer being replaced already acted (409 `turn_acted`: what it
 * did, then "go on anyway"). Nothing is replaced without that confirmation.
 */

const ACTION =
  'dy-press inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-[0.75rem] text-dy-muted md:min-h-8 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink';

/** Runs an edit / regenerate / retry; a `turn_acted` refusal opens the dialog and runs it again acknowledged. */
export function useActedGuard(): {
  readonly run: (fn: (acknowledge: boolean) => Promise<unknown>) => Promise<void>;
  readonly dialog: ReactNode;
  readonly error: string | null;
  readonly busy: boolean;
  readonly clear: () => void;
} {
  const sayError = useErrorText();
  const [pending, setPending] = useState<{
    readonly effects: TurnEffects;
    readonly fn: (acknowledge: boolean) => Promise<unknown>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn: (acknowledge: boolean) => Promise<unknown>, acknowledge = false): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await fn(acknowledge);
        setPending(null);
      } catch (err) {
        const effects = actedEffects(err);
        if (effects !== null && !acknowledge) setPending({ effects, fn });
        else setError(sayError(err));
      } finally {
        setBusy(false);
      }
    },
    [sayError],
  );
  const dialog = (
    <ActedDialog
      effects={pending?.effects ?? null}
      busy={busy}
      onCancel={() => {
        setPending(null);
      }}
      onConfirm={() => {
        if (pending !== null) void run(pending.fn, true);
      }}
    />
  );
  return {
    run: (fn) => run(fn),
    dialog,
    error,
    busy,
    clear: () => {
      setError(null);
    },
  };
}

/** "Bu yanıt işlem yaptı": the replaced answer's tool calls and cards, then go on or cancel. */
export function ActedDialog(props: {
  readonly effects: TurnEffects | null;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const t = useT().chatComplete.acted;
  const e = props.effects;
  return (
    <DyDialog
      open={e !== null}
      onClose={props.onCancel}
      size="sm"
      title={t.title}
      description={fill(t.body, { count: e?.actions ?? 0 })}
      testId="acted-dialog"
      footer={
        <>
          <DyButton onClick={props.onCancel}>{t.cancel}</DyButton>
          <DyButton variant="warn" busy={props.busy} onClick={props.onConfirm} data-testid="acted-confirm">
            {t.confirm}
          </DyButton>
        </>
      }
    >
      {e === null ? null : (
        <div className="grid gap-3 text-[0.875rem]">
          {e.tools.length === 0 ? null : (
            <section>
              <h3 className="m-0 mb-1 text-[0.8125rem] font-bold">{t.tools}</h3>
              <ul className="m-0 list-disc pl-5" data-testid="acted-tools">
                {e.tools.map((x, i) => (
                  <li key={`${x.name}:${String(i)}`} className="[overflow-wrap:anywhere]">
                    <span className="font-dy-mono">{x.name}</span> — {x.summary}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {e.cards.length === 0 ? null : (
            <section>
              <h3 className="m-0 mb-1 text-[0.8125rem] font-bold">{t.cards}</h3>
              <ul className="m-0 list-disc pl-5" data-testid="acted-cards">
                {e.cards.map((c) => (
                  <li key={c.id}>{fill(t.card, { title: c.title, state: c.state })}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </DyDialog>
  );
}

/** Inline editor of one of the person's messages (Enter keeps a new line; Send submits). */
export function MessageEditor(props: {
  readonly initial: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const t = useT().chatComplete.edit;
  const id = useId();
  const [text, setText] = useState(props.initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <form
      className="flex w-full min-w-[min(28rem,80vw)] flex-col gap-2"
      data-testid="message-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() !== '') props.onSave(text.trim());
      }}
    >
      <label htmlFor={id} className="sr-only">
        {t.label}
      </label>
      <textarea
        ref={ref}
        id={id}
        value={text}
        rows={Math.min(8, Math.max(2, text.split('\n').length))}
        maxLength={32_768}
        // The editor opens on a click of "Mesajı düzenle": focus follows the person's own action.
        autoFocus
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            props.onCancel();
          }
        }}
        className="w-full rounded-[10px] border border-dy-teal bg-dy-card px-3 py-2 text-[0.9375rem] text-dy-ink outline-none"
      />
      <p className="m-0 text-[0.75rem] text-dy-muted">{t.hint}</p>
      {props.error === null ? null : (
        <p role="alert" className="m-0 text-[0.75rem] text-dy-red-ink">
          {props.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <DyButton onClick={props.onCancel}>{t.cancel}</DyButton>
        <DyButton
          type="submit"
          variant="primary"
          busy={props.busy}
          disabled={text.trim() === '' || text.trim() === props.initial.trim()}
          data-testid="message-editor-save"
        >
          {t.save}
        </DyButton>
      </div>
    </form>
  );
}

export function EditButton(props: { readonly onClick: () => void; readonly disabled?: boolean }): ReactNode {
  const t = useT().chatComplete.edit;
  return (
    <button
      type="button"
      className={ACTION}
      aria-label={t.button}
      title={t.button}
      disabled={props.disabled}
      onClick={props.onClick}
      data-testid="message-edit"
    >
      <DyIcon name="pen" className="size-3.5" />
    </button>
  );
}

/** Under the last answer: regenerate, and regenerate with another engine / model. */
export function AnswerControls(props: {
  readonly disabled: boolean;
  readonly onRegenerate: () => void;
  readonly onOther: () => void;
}): ReactNode {
  const t = useT().chatComplete.regenerate;
  return (
    <span className="inline-flex items-center" data-testid="answer-controls">
      <button
        type="button"
        className={ACTION}
        disabled={props.disabled}
        onClick={props.onRegenerate}
        data-testid="answer-regenerate"
      >
        <DyIcon name="retry" className="size-3.5" />
        {t.button}
      </button>
      <button
        type="button"
        className={ACTION}
        disabled={props.disabled}
        onClick={props.onOther}
        data-testid="answer-regenerate-other"
        aria-label={t.other}
        title={t.other}
      >
        <DyIcon name="cpu" className="size-3.5" />
      </button>
    </span>
  );
}

export function RetryButton(props: { readonly disabled: boolean; readonly onRetry: () => void }): ReactNode {
  const t = useT().chatComplete.retry;
  return (
    <DyButton
      icon="retry"
      disabled={props.disabled}
      onClick={props.onRetry}
      data-testid="turn-retry"
      className="mt-2"
    >
      {t.button}
    </DyButton>
  );
}

/** The engines the answering machine has ready, and a model for the chosen one (the shared model picker). */
export function RegenerateDialog(props: {
  readonly open: boolean;
  readonly engines: readonly string[];
  readonly current: string;
  readonly workerId?: string | undefined;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (runtime: string, model: string | null) => void;
}): ReactNode {
  const t = useT().chatComplete.regenerate;
  const catalog = useRuntimeModels();
  const engines = props.engines.length === 0 ? [props.current] : props.engines;
  const [runtime, setRuntime] = useState(
    engines.includes(props.current) ? props.current : (engines[0] ?? ''),
  );
  const [model, setModel] = useState('');
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={t.title}
      description={t.body}
      testId="regenerate-dialog"
      footer={
        <DyButton
          variant="primary"
          busy={props.busy}
          disabled={runtime === ''}
          data-testid="regenerate-submit"
          onClick={() => {
            props.onSubmit(runtime, model === '' ? null : model);
          }}
        >
          {t.submit}
        </DyButton>
      }
    >
      <div className="grid gap-3">
        <DySelect
          label={t.runtime}
          value={runtime}
          options={engines.map((e) => [e, e] as const)}
          onChange={(v) => {
            setRuntime(v);
            setModel('');
          }}
        />
        <DyModelPicker
          label={t.model}
          runtimes={[runtime as ModelRuntime]}
          value={model}
          valueKind="model"
          catalog={catalog}
          workerId={props.workerId}
          testId="regenerate-model"
          onChange={(v, kind) => {
            setModel(kind === 'model' ? v : '');
          }}
        />
      </div>
    </DyDialog>
  );
}

/** "yeniden üretildi · codex · gpt-5" under a regenerated / retried answer (null: a plain answer). */
export function regeneratedLabel(
  t: ReturnType<typeof useT>['chatComplete']['regenerate'],
  meta: Record<string, unknown> | null,
): string | null {
  const r = meta?.regenerated;
  if (typeof r !== 'object' || r === null) return null;
  const x = r as Record<string, unknown>;
  const runtime = typeof x.runtime === 'string' ? x.runtime : '';
  const model = typeof x.model === 'string' ? x.model : null;
  if (x.origin === 'retry') return fill(t.retried, { runtime });
  return model === null ? fill(t.label, { runtime }) : fill(t.labelModel, { runtime, model });
}
