import type { Messages } from '@remyral/i18n';
import { useErrorText } from '../../i18n/errors';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { continueJob } from '../../api/approvalPause';
import { getJobMessageStatus, type JobMessageMode, sendJobMessage } from '../../api/chat';
import { useT } from '../../i18n/I18nProvider';
import type { JobDetail } from '../../api/jobs';
import { cx } from '../../components/ui';
import { CANCELLABLE, RERUNNABLE, runAgainHref, TERMINAL } from '../../screens/job/format';
import { DyIcon } from '../icons';
import { CardButton, CardLink } from '../LiveCard';
import { useAgentMessageSeed } from './agentMessage';

/**
 * p12-diyalog Faz 2: the job thread's composer. While the agent runs, writing in the thread IS messaging the agent
 * (`POST /jobs/:id/messages`, the classic "Message the agent": operators and up, audited, delivered at the agent's next
 * turn boundary). When the job is not running the field gives way to the job's actions through their existing paths:
 * Cancel (the classic cancel dialog), Continue (`POST /jobs/:id/continue`), Run again (the composer prefilled from this
 * job) and Run again with an edited prompt (the composer prefilled with the edited prompt — still confirmed there).
 */

type Mode = 'message' | 'queue' | 'unsupported' | 'waiting' | 'cancelling' | 'ended' | 'readonly';

function modeOf(
  state: string,
  canAct: boolean,
  retired: boolean,
  supported: { ok: boolean; mode: JobMessageMode | null } | null,
): Mode {
  if (!canAct || retired) return 'readonly';
  if (state === 'CANCELLING') return 'cancelling';
  if (state === 'RUNNING') return supported?.ok === false ? 'unsupported' : 'message';
  if (TERMINAL.has(state)) return 'ended';
  // p15-message-delivery: not running yet / paused — a message waits for the agent (held by the master).
  if (supported?.ok === true && supported.mode === 'queue') return 'queue';
  if (state === 'BLOCKED') return 'ended';
  return 'waiting';
}

function waitingText(state: string, w: Messages['job']['composer']): string {
  return Object.hasOwn(w.waiting, state) ? w.waiting[state as keyof typeof w.waiting] : w.notRunning;
}

export function JobComposer(props: {
  readonly detail: JobDetail;
  readonly state: string;
  readonly canAct: boolean;
  readonly retired: boolean;
  /** A message went to the agent: the thread shows it until the agent's own event confirms it. */
  readonly onSent: (text: string) => void;
  readonly onCancel: () => void;
  /** p12-diyalog panels: rendered inside the activity log's footer (no sticky bottom bar). */
  readonly inline?: boolean | undefined;
}): ReactNode {
  const sayError = useErrorText();
  const w = useT().job.composer;
  const j = props.detail.job;
  const { state } = props;
  const navigate = useNavigate();
  const [supported, setSupported] = useState<{
    ok: boolean;
    reason: string | null;
    mode: JobMessageMode | null;
  } | null>(null);
  const tm = useT().jobMessages;
  // p15-message-delivery: one id per typed message, reused when the same text is retried after an error.
  const pendingSend = useRef<{ text: string; clientId: string } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const errId = useId();
  const prompt = typeof j.spec.prompt === 'string' ? j.spec.prompt : '';

  const open = !TERMINAL.has(state);
  useEffect(() => {
    if (!open || !props.canAct) return;
    let live = true;
    getJobMessageStatus(j.id).then(
      (s) => {
        if (live) setSupported({ ok: s.supported, reason: s.reason, mode: s.mode });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [j.id, open, state, props.canAct]);

  // p12-diyalog Faz 3: "Ajana yaz" on a card of this job puts its text here (agentMessage.ts).
  const seed = useAgentMessageSeed(j.id);
  useEffect(() => {
    if (seed === null) return;
    setText(seed.text);
    setEditing(false);
    setError(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el === null) return;
      el.focus();
      el.setSelectionRange(seed.text.length, seed.text.length);
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    });
  }, [seed]);

  const mode = modeOf(state, props.canAct, props.retired, supported);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${String(Math.min(el.scrollHeight, editing ? 260 : 168))}px`;
  }, [text, editing, mode]);

  async function sendMessage(): Promise<void> {
    const t = text.trim();
    if (t === '' || busy) return;
    setBusy(true);
    setError(null);
    setSent(false);
    const prev = pendingSend.current;
    const clientId = prev !== null && prev.text === t ? prev.clientId : crypto.randomUUID();
    pendingSend.current = { text: t, clientId };
    try {
      await sendJobMessage(j.id, t, { clientId });
      pendingSend.current = null;
      props.onSent(t);
      setText('');
      setSent(true);
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  }

  async function runContinue(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const out = await continueJob(j.id);
      void navigate(`/jobs/${encodeURIComponent(out.jobId)}`);
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(false);
    }
  }

  function runEdited(): void {
    const t = text.trim();
    if (t === '') return;
    void navigate('/jobs/new', {
      state: { prefill: { project: j.project, spec: { ...j.spec, prompt: t } } },
    });
  }

  const field = (opts: {
    label: string;
    placeholder: string;
    onSubmit: () => void;
    sendLabel: string;
  }): ReactNode => (
    <form
      className="grid gap-1.5"
      aria-label={opts.label}
      onSubmit={(e) => {
        e.preventDefault();
        opts.onSubmit();
      }}
    >
      <div
        className={cx(
          'flex items-end gap-2 rounded-[14px] border bg-dy-card py-2 pr-2 pl-3.5 shadow-dy',
          error === null ? 'border-dy-line-2 focus-within:border-dy-teal' : 'border-dy-red',
        )}
      >
        <textarea
          ref={ref}
          rows={1}
          value={text}
          maxLength={8192}
          autoComplete="off"
          aria-label={opts.label}
          aria-describedby={error === null ? hintId : `${errId} ${hintId}`}
          aria-invalid={error === null ? undefined : true}
          placeholder={opts.placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setSent(false);
            if (error !== null) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !editing) {
              e.preventDefault();
              opts.onSubmit();
            }
            if (e.key === 'Escape' && editing) {
              setEditing(false);
              setText('');
            }
          }}
          className="max-h-[260px] min-h-9 flex-1 resize-none border-0 bg-transparent py-1.5 text-base leading-[1.45] text-dy-ink outline-none placeholder:text-dy-faint focus-visible:outline-none sm:text-[0.9375rem]"
        />
        <button
          type="submit"
          disabled={busy || text.trim() === ''}
          aria-label={opts.sendLabel}
          title={opts.sendLabel}
          className="dy-press grid size-9 shrink-0 place-items-center rounded-[10px] bg-dy-teal text-dy-on-fill disabled:opacity-45"
        >
          {busy ? (
            <span className="dy-breathe size-2 rounded-full bg-current" aria-hidden="true" />
          ) : (
            <DyIcon name={editing ? 'retry' : 'send'} />
          )}
        </button>
      </div>
    </form>
  );

  let body: ReactNode;
  let hint: ReactNode = null;
  switch (mode) {
    case 'message':
      body = field({
        label: w.label,
        placeholder: w.placeholder,
        onSubmit: () => void sendMessage(),
        sendLabel: w.send,
      });
      hint = sent ? tm.composer.sentHint : w.hint;
      break;
    case 'queue':
      body = (
        <div className="grid gap-1.5">
          {field({
            label: tm.box.title,
            placeholder: tm.composer.queuedPlaceholder,
            onSubmit: () => void sendMessage(),
            sendLabel: tm.box.send,
          })}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.8125rem] text-dy-muted">{waitingText(state, w)}</span>
            {CANCELLABLE.has(state) ? (
              <span className="ml-auto">
                <CardButton variant="danger" onClick={props.onCancel}>
                  {w.cancelJob}
                </CardButton>
              </span>
            ) : null}
          </div>
        </div>
      );
      hint = sent ? tm.composer.sentHint : tm.composer.queuedHint;
      break;
    case 'unsupported':
      body = (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.875rem] text-dy-muted">
            {tm.composer.unavailable({ reason: supported?.reason ?? w.unsupportedReason })}
          </span>
          <span className="ml-auto">
            <CardButton variant="danger" onClick={props.onCancel}>
              {w.cancelJob}
            </CardButton>
          </span>
        </div>
      );
      break;
    case 'waiting':
      body = (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.875rem] text-dy-muted">{waitingText(state, w)}</span>
          {CANCELLABLE.has(state) ? (
            <span className="ml-auto">
              <CardButton variant="danger" onClick={props.onCancel}>
                {w.cancelJob}
              </CardButton>
            </span>
          ) : null}
        </div>
      );
      break;
    case 'cancelling':
      body = <p className="m-0 text-[0.875rem] text-dy-muted">{w.cancelling}</p>;
      break;
    case 'readonly':
      body = <p className="m-0 text-[0.875rem] text-dy-muted">{props.retired ? w.retired : w.readOnly}</p>;
      break;
    case 'ended':
      body = editing ? (
        field({
          label: w.editLabel,
          placeholder: w.editPlaceholder,
          onSubmit: runEdited,
          sendLabel: w.editSend,
        })
      ) : (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={w.actions}>
          {props.detail.continueAvailable ? (
            <CardButton variant="primary" icon="retry" busy={busy} onClick={() => void runContinue()}>
              {w.continue}
            </CardButton>
          ) : null}
          {/* p19-verifier-jobs: a platform verifier is never run again or edited as ordinary work. */}
          {RERUNNABLE.has(state) && (j.platform ?? null) === null ? (
            <>
              <CardLink
                to={runAgainHref(j.id)}
                variant={props.detail.continueAvailable ? 'secondary' : 'primary'}
                icon="retry"
              >
                {w.rerun}
              </CardLink>
              <CardButton
                icon="pen"
                onClick={() => {
                  setText(prompt);
                  setEditing(true);
                  requestAnimationFrame(() => ref.current?.focus());
                }}
              >
                {w.edit}
              </CardButton>
            </>
          ) : null}
          {state === 'BLOCKED' && CANCELLABLE.has(state) ? (
            <CardButton variant="danger" onClick={props.onCancel}>
              {w.cancelJob}
            </CardButton>
          ) : null}
        </div>
      );
      hint = editing ? w.editHint : w.rerunHint;
      break;
  }

  const inner = (
    <div
      className={cx('grid gap-1.5', props.inline !== true && 'mx-auto max-w-[780px]')}
      data-testid="dy-job-composer"
      data-mode={mode}
    >
      {body}
      {error === null ? null : (
        <p id={errId} role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
          {error}
        </p>
      )}
      {hint === null ? null : (
        <p id={hintId} role={sent ? 'status' : undefined} className="m-0 text-[0.75rem] text-dy-faint">
          {hint}
        </p>
      )}
      {editing && mode === 'ended' ? (
        <button
          type="button"
          className="justify-self-start text-[0.8125rem] text-dy-muted underline-offset-2 hover:underline"
          onClick={() => {
            setEditing(false);
            setText('');
          }}
        >
          {w.discard}
        </button>
      ) : null}
    </div>
  );
  if (props.inline === true) return inner;
  return (
    <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-[4] bg-gradient-to-t from-dy-thread from-70% to-transparent px-3 pt-6 pb-3 sm:px-6 md:bottom-0 md:pb-4">
      {inner}
    </div>
  );
}
