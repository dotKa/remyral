import { type ReactNode, useState } from 'react';
import { deleteQueuedMessage, editQueuedMessage, type QueuedMessage } from '../../api/chat';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';

/**
 * p22-chat-queue (docs/design/p22-chat-queue.md): the messages written while Remyral answers, under the answer being
 * written — each a dimmed bubble marked "Sırada" with Düzenle / Kaldır, and "Şimdi gönder" while the answer runs (it
 * stops the answer: when a turn ends, every queued message is sent together as the next turn). The master owns the
 * queue (it survives a reload and other devices see it); this view only reads and changes it.
 */
export function QueuedMessages(props: {
  readonly threadId: string;
  readonly items: readonly QueuedMessage[];
  /** The assistant is answering (then "Şimdi gönder" is offered). */
  readonly busy: boolean;
  /** Stops the running answer (the chat's Stop); absent: no "Şimdi gönder". */
  readonly onSendNow?: (() => void) | undefined;
  /** Read the conversation again after a change. */
  readonly onChanged: () => void;
}): ReactNode {
  const t = useT().chatQueue;
  const sayError = useErrorText();
  const [editing, setEditing] = useState<{ readonly id: string; readonly text: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (props.items.length === 0) return null;

  const run = (fn: () => Promise<void>): void => {
    setWorking(true);
    setError(null);
    fn().then(
      () => {
        setWorking(false);
        props.onChanged();
      },
      (err: unknown) => {
        setWorking(false);
        setError(t.failed({ error: sayError(err) }));
        props.onChanged();
      },
    );
  };
  const held = props.items.find((q) => q.holdReason !== null)?.holdReason ?? null;

  return (
    <section aria-label={t.label} className="mt-3 flex flex-col items-end gap-2" data-testid="chat-queued">
      {props.items.map((q) => (
        <div
          key={q.id}
          className="flex max-w-[min(520px,88%)] flex-col items-end gap-1 self-end"
          data-testid="chat-queued-item"
        >
          <div className="rounded-[14px] border border-dashed border-dy-line-2 bg-dy-me px-3.5 opacity-80 py-2 text-[0.9375rem] [overflow-wrap:anywhere] whitespace-pre-wrap text-dy-me-ink">
            {editing?.id === q.id ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = editing.text;
                  run(async () => {
                    await editQueuedMessage(props.threadId, q.id, text);
                    setEditing(null);
                  });
                }}
              >
                <textarea
                  aria-label={t.editLabel}
                  value={editing.text}
                  rows={3}
                  onChange={(e) => {
                    setEditing({ id: q.id, text: e.target.value });
                  }}
                  className="min-w-[min(420px,70vw)] resize-y rounded-lg border border-dy-line-2 bg-dy-card px-2 py-1 text-dy-ink"
                />
                <span className="flex justify-end gap-2 text-[0.8125rem]">
                  <button
                    type="button"
                    className="dy-press min-h-9 rounded-full px-3"
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    {t.cancel}
                  </button>
                  <button
                    type="submit"
                    disabled={working || (editing.text.trim() === '' && q.attachments === 0)}
                    className="dy-press min-h-9 rounded-full bg-dy-teal px-3 font-bold text-dy-on-fill disabled:opacity-50"
                  >
                    {t.save}
                  </button>
                </span>
              </form>
            ) : (
              q.content
            )}
          </div>
          <small className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-dy-faint">
            <span className="font-bold text-dy-amber-ink" data-testid="chat-queued-badge">
              {t.badge}
            </span>
            {q.attachments > 0 ? <span>{t.files({ n: q.attachments })}</span> : null}
            <span>{t.note}</span>
            {editing?.id === q.id ? null : (
              <>
                <button
                  type="button"
                  disabled={working}
                  aria-label={t.editLabel}
                  className="dy-press min-h-9 underline disabled:opacity-50 sm:min-h-0"
                  onClick={() => {
                    setEditing({ id: q.id, text: q.content });
                  }}
                >
                  {t.edit}
                </button>
                <button
                  type="button"
                  disabled={working}
                  aria-label={t.removeLabel}
                  className="dy-press min-h-9 underline disabled:opacity-50 sm:min-h-0"
                  onClick={() => {
                    run(() => deleteQueuedMessage(props.threadId, q.id));
                  }}
                >
                  {t.remove}
                </button>
              </>
            )}
          </small>
        </div>
      ))}
      {props.busy && props.onSendNow !== undefined ? (
        <button
          type="button"
          title={t.sendNowHint}
          disabled={working}
          onClick={props.onSendNow}
          className="dy-press inline-flex min-h-9 items-center rounded-full border border-dy-line-2 bg-dy-card px-3 text-[0.8125rem] font-bold text-dy-ink disabled:opacity-50"
          data-testid="chat-queued-send-now"
        >
          {t.sendNow}
        </button>
      ) : null}
      {held === null ? null : (
        <p role="status" className="m-0 text-[0.8125rem] text-dy-amber-ink" data-testid="chat-queued-held">
          {held === 'assistant_unavailable' || held === 'rate_limited' || held === 'budget_exceeded'
            ? t.held[held]
            : t.held.other}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
          {error}
        </p>
      )}
    </section>
  );
}
