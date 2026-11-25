import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { type ChatThread, updateThread } from '../../api/chat';
import type { ApiError } from '../../api/client';
import { toApiError } from '../../components/ui';

/** p9-chat-unread: how often the conversation list refreshes its unread counts while the page is visible. */
export const LIST_POLL_MS = 15_000;

/**
 * The conversation list (p5-chat-ux): new conversation, search, show archived, threads grouped by Today /
 * Yesterday / Last 7 days / Older, the active one highlighted, and a per-thread menu (rename inline, archive or
 * restore, delete with a confirmation). It scrolls on its own; on phones the chat page shows it as a drawer.
 */

export type ThreadAction = 'renamed' | 'archived' | 'restored' | 'deleted';

/** Inline title editor: Enter or leaving the field saves, Escape cancels. */
export function RenameField(props: {
  readonly thread: ChatThread;
  readonly onDone: (saved: boolean) => void;
  readonly onError: (err: ApiError) => void;
  readonly className?: string;
}): ReactNode {
  const id = useId();
  const [title, setTitle] = useState(props.thread.title);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  async function save(): Promise<void> {
    if (done.current) return;
    done.current = true;
    const next = title.trim();
    if (next === '' || next === props.thread.title) {
      props.onDone(false);
      return;
    }
    try {
      await updateThread(props.thread.id, { title: next });
      props.onDone(true);
    } catch (err) {
      props.onError(toApiError(err));
      props.onDone(false);
    }
  }
  return (
    <form
      className="min-w-0 flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={id} className="sr-only">
        Conversation title
      </label>
      <input
        ref={input}
        id={id}
        value={title}
        maxLength={200}
        onChange={(e) => {
          setTitle(e.target.value);
        }}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            done.current = true;
            props.onDone(false);
          }
        }}
        className={
          props.className ??
          'h-11 w-full min-w-0 rounded-md border border-accent bg-surface px-2 text-base sm:h-9 sm:text-sm'
        }
      />
    </form>
  );
}
