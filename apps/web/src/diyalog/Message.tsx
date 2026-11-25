import type { ReactNode } from 'react';
import { cx } from '../components/ui';
import { useT } from '../i18n/I18nProvider';
import { BrandSymbol } from './Brand';
import { DyIcon, type IconName } from './icons';
import { runtimeCode, type RuntimeCode } from './RuntimeMark';

/**
 * p12-diyalog: one turn in a thread.
 *   me         the signed-in person — a dark bubble on the right
 *   assistant  Remyral, the operations assistant — the brand symbol, full-width text
 *   agent      a coding agent speaking in its job thread — the runtime's colour
 *   system     an event line across the thread (deploy finished, machine offline) — no speaker
 *   note       a centred info block the platform wrote into the conversation (a goal check, a watch or plan
 *              hand-back, a late tool result) — set apart from the event lines and from the person's bubbles
 * Phones drop the avatar column; a small square in the speaker's colour keeps who-is-talking visible.
 */
export type MessageRole = 'me' | 'assistant' | 'agent' | 'system' | 'note';

function Time(props: { readonly at?: string | undefined; readonly text?: string | undefined }): ReactNode {
  if (props.at === undefined) return null;
  return (
    <time dateTime={props.at} className="font-dy-mono text-xs text-dy-faint">
      {props.text ?? props.at}
    </time>
  );
}

const AVATAR: Readonly<Record<RuntimeCode, string>> = {
  cc: 'bg-dy-cc',
  cx: 'bg-dy-cx',
  pi: 'bg-dy-pi',
  oc: 'bg-dy-oc',
};

export function Message(props: {
  readonly role: MessageRole;
  readonly children: ReactNode;
  /** ISO time of the message and its short display form ("13:24"). */
  readonly at?: string | undefined;
  readonly atText?: string | undefined;
  /** Speaker name (assistant: "Remyral"; agent: "Claude Code"; me: the user name under the bubble). */
  readonly author?: string | undefined;
  /** Speaker role line ("operasyon asistanı", "acme · kestrel-mac"). */
  readonly meta?: string | undefined;
  /** Agent messages: the runtime id (`claude-code`, `codex`, …) picks the colour. */
  readonly runtime?: string | undefined;
  /** System lines: `warn` for failures and outages. */
  readonly tone?: 'neutral' | 'warn' | undefined;
  readonly icon?: IconName | undefined;
  readonly className?: string | undefined;
  /**
   * p17-chat-send-motion: the person's message is on its way to the master — this label ("Gönderiliyor…") replaces
   * the time and author line, and the bubble has no tail yet (it grows its corner when the sent message settles in).
   */
  readonly sending?: string | undefined;
}): ReactNode {
  const t = useT().shared;
  const { role } = props;
  if (role === 'system') {
    return (
      <div
        data-role="system"
        className={cx(
          'my-1.5 flex items-center gap-3 text-[0.78125rem] before:h-px before:flex-1 before:bg-dy-line after:h-px after:flex-1 after:bg-dy-line',
          props.tone === 'warn' ? 'text-dy-red-ink' : 'text-dy-faint',
          props.className,
        )}
      >
        <span className="flex max-w-[80%] min-w-0 flex-wrap items-center justify-center gap-1.5 text-center [overflow-wrap:anywhere]">
          {props.icon === undefined ? null : <DyIcon name={props.icon} className="size-3.5 shrink-0" />}
          {props.children}
          <Time at={props.at} text={props.atText} />
        </span>
      </div>
    );
  }
  // p22-note-block: platform notes are a centred info block, so they are not confused with one-line event rows.
  if (role === 'note') {
    return (
      <div data-role="note" className={cx('my-2 flex justify-center', props.className)}>
        <div className="flex max-w-[min(560px,92%)] min-w-0 flex-col items-center gap-1 rounded-[var(--dy-r-card)] border border-dy-line bg-dy-sunk px-4 py-2.5 text-center text-[0.8125rem] text-dy-muted">
          <span className="flex min-w-0 items-start justify-center gap-1.5 [overflow-wrap:anywhere]">
            {props.icon === undefined ? null : (
              <DyIcon name={props.icon} className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span>{props.children}</span>
          </span>
          <Time at={props.at} text={props.atText} />
        </div>
      </div>
    );
  }
  if (role === 'me') {
    return (
      <div
        data-role="me"
        data-state={props.sending === undefined ? undefined : 'sending'}
        className={cx('flex max-w-[min(520px,88%)] flex-col items-end gap-1 self-end', props.className)}
      >
        <div
          className={cx(
            'dy-m-bubble bg-dy-me px-3.5 py-2 text-[0.9375rem] [overflow-wrap:anywhere] text-dy-me-ink',
            props.sending === undefined ? 'rounded-[14px_14px_4px_14px]' : 'rounded-[14px]',
          )}
        >
          {props.children}
        </div>
        {props.sending !== undefined ? (
          <small className="dy-m-meta text-xs text-dy-faint" data-testid="dy-message-sending">
            {props.sending}
          </small>
        ) : props.at === undefined && props.author === undefined ? null : (
          <small className="dy-m-meta flex gap-1.5 text-xs text-dy-faint">
            <Time at={props.at} text={props.atText} />
            {props.author}
          </small>
        )}
      </div>
    );
  }
  const code = role === 'agent' ? runtimeCode(props.runtime) : null;
  const fill = role === 'assistant' ? 'bg-dy-brand' : code === null ? 'bg-dy-muted' : AVATAR[code];
  const name = props.author ?? (role === 'assistant' ? t.speaker.assistant : t.speaker.agent);
  return (
    <div
      data-role={role}
      className={cx('grid grid-cols-1 gap-3 sm:grid-cols-[32px_minmax(0,1fr)]', props.className)}
    >
      {role === 'assistant' ? (
        // p17-remyral-brand: the assistant is Remyral — its avatar is the brand symbol on the navy tile.
        <BrandSymbol className="hidden size-8 sm:grid" />
      ) : (
        <span
          aria-hidden="true"
          className={cx(
            'hidden size-8 place-items-center rounded-[10px] text-xs font-extrabold text-dy-on-fill sm:grid',
            fill,
          )}
        >
          {(code ?? name.slice(0, 2)).toUpperCase()}
        </span>
      )}
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-baseline gap-2 text-[0.8125rem]">
          <span aria-hidden="true" className={cx('size-2.5 self-center rounded-[3px] sm:hidden', fill)} />
          <b className="text-sm font-bold">{name}</b>
          {props.meta === undefined ? null : <span className="text-dy-muted">{props.meta}</span>}
          <Time at={props.at} text={props.atText} />
        </div>
        <div className="max-w-[68ch] text-[1rem] leading-[1.55] [overflow-wrap:anywhere]">
          {props.children}
        </div>
      </div>
    </div>
  );
}
