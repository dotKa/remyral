import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { ApiError } from '../../api/client';
import { toApiError } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { StepUpCancelledError, useOptionalStepUp } from '../../stepup/StepUpProvider';
import { DyApiError } from '../common/notices';
import { DySwitch } from '../screens/forms';
import { toast } from '../toast/store';

/**
 * p15-form-pattern (docs/design/p15-form-pattern.md §4): a switch that applies at once — no save bar, no unsaved
 * state. It moves when clicked (optimistic), sends the change (through step-up when the master asks), then says
 * "Kaydedildi ✓" (p17-toasts-shortcuts: as a toast; "Kaydediliyor…" stays next to the switch while it is sent);
 * when the master refuses (or the code dialog is cancelled) it moves back and, for a refusal, shows why next to it. Used for personal, reversible, one-bit preferences (see the design note for the list);
 * anything that needs a review before it takes effect belongs in a form.
 */
export function DyInstantToggle(props: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  /** The value the master has now. */
  readonly checked: boolean;
  /** Sends the change; resolve when the master accepted it. */
  readonly onCommit: (next: boolean) => Promise<void>;
  /** The step-up dialog's reason (shown only if the master asks for a code). */
  readonly stepUpReason?: string | undefined;
  /** What the confirmation says for this change (default "Kaydedildi ✓"), e.g. "Paylaşım açık.". */
  readonly savedText?: ((next: boolean) => string) | undefined;
  readonly disabled?: boolean | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  const t = useT().forms.instant;
  const stepUp = useOptionalStepUp();
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [undone, setUndone] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const shown = pending ?? props.checked;

  const commit = async (next: boolean): Promise<void> => {
    setPending(next);
    setBusy(true);
    setError(null);
    setUndone(false);
    try {
      const send = () => props.onCommit(next);
      if (stepUp === null) await send();
      else await stepUp.run(send, props.stepUpReason);
      if (live.current)
        toast.success(props.savedText === undefined ? t.saved : props.savedText(next), {
          testId: 'instant-saved',
        });
    } catch (err) {
      if (!live.current) return;
      // Undo: the switch goes back to what the master still has.
      if (!(err instanceof StepUpCancelledError)) {
        setError(toApiError(err));
        setUndone(true);
      }
    } finally {
      if (live.current) {
        setPending(null);
        setBusy(false);
      }
    }
  };

  return (
    <div
      className="flex min-w-0 flex-col gap-1.5"
      data-testid={props.testId === undefined ? undefined : `${props.testId}-instant`}
    >
      <DySwitch
        label={props.label}
        hint={props.hint}
        checked={shown}
        busy={busy}
        disabled={props.disabled}
        testId={props.testId}
        onChange={(v) => void commit(v)}
      />
      <div aria-live="polite" className="empty:hidden">
        {busy ? <span className="text-[0.78125rem] text-dy-muted">{t.saving}</span> : null}
      </div>
      {error === null ? null : (
        <div className="flex flex-col gap-1" data-testid="instant-undone">
          <span className="text-[0.78125rem] font-medium text-dy-red-ink">{undone ? t.undone : null}</span>
          <DyApiError error={error} />
        </div>
      )}
    </div>
  );
}
