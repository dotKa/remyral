import { type ReactNode, type SubmitEvent, useEffect, useId, useMemo, useState } from 'react';
import type { ApiError } from '../../api/client';
import type { EventItem } from '../../api/live';
import { cancelJob } from '../../api/live';
import { toApiError } from '../../components/ui';
import { DyDialog } from '../../diyalog/DyDialog';
import { DyApiError } from '../../diyalog/common/notices';
import { DY_INPUT } from '../../diyalog/forms';
import { DyButton } from '../../diyalog/screens/parts';
import { useT } from '../../i18n/I18nProvider';
import type { LiveData } from './useLive';

/**
 * Live building blocks of the job page (docs/design/p5-live.md §6, p6-ui-jobs): the live/reconnecting
 * indicator for the header, the cancel dialog, the agent events and the log/terminal view. The page owns one
 * `useLive` stream and hands its data to these, so switching tabs never reopens the stream. Everything shown
 * is untrusted output, rendered as text (logs through the strict SGR-only ANSI parser).
 */

export type Live = LiveData & {
  reload: () => void;
  refreshEvents: () => void;
  setJobState: (s: string) => void;
};

/**
 * Confirmation with a required reason; a running agent is stopped. Never the default of anything. p16-chat-complete:
 * the Diyalog dialog (DyDialog) in the reader's language.
 */
export function CancelDialog(props: {
  readonly jobId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCancelled: (state: string) => void;
}): ReactNode {
  const t = useT().chatComplete.jobCancel;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const reasonId = useId();
  const formId = useId();
  useEffect(() => {
    if (!props.open) {
      setError(null);
      setBusy(false);
    }
  }, [props.open]);

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (reason.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const out = await cancelJob(props.jobId, reason);
      props.onCancelled(out.state);
      setReason('');
      props.onClose();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      size="sm"
      title={t.title}
      description={t.body}
      testId="job-cancel-dialog"
      footer={
        <>
          <DyButton onClick={props.onClose}>{t.keep}</DyButton>
          <DyButton
            type="submit"
            form={formId}
            variant="danger"
            busy={busy}
            disabled={reason.trim() === ''}
            data-testid="job-cancel-confirm"
          >
            {t.confirm}
          </DyButton>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-1.5">
        <label htmlFor={reasonId} className="text-[0.8125rem] font-bold">
          {t.reason}
        </label>
        <textarea
          id={reasonId}
          required
          value={reason}
          maxLength={1000}
          rows={2}
          onChange={(e) => {
            setReason(e.target.value);
          }}
          className={`${DY_INPUT} border-dy-line-2 py-2`}
        />
        <p className="m-0 text-[0.75rem] text-dy-muted">{t.reasonHint}</p>
      </form>
      <DyApiError error={error} retryLeft={0} />
    </DyDialog>
  );
}

/** Artifacts the run reported (summary plus streamed ones, de-duplicated). */
export function useLiveArtifacts(live: Live): EventItem[] {
  return useMemo(() => {
    const seen = new Set<number>();
    return [...(live.summary?.artifacts ?? []), ...live.events.filter((e) => e.kind === 'artifact')].filter(
      (a) => {
        if (seen.has(a.seq)) return false;
        seen.add(a.seq);
        return true;
      },
    );
  }, [live.summary, live.events]);
}
