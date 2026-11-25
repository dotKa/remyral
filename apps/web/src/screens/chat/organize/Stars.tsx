import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChatMessage } from '../../../api/chat';
import { starMessage } from '../../../api/chatOrganize';
import { useSharedT } from '../../../i18n/scope';
import { invalidate } from '../../../lib/invalidate';

/**
 * p10-chat-organize: starring messages. The conversation provides the set of starred ids (from the thread view) and a
 * toggle; each user / assistant message shows a star button in its action row (hover / focus, always on touch) and a
 * long press on the message toggles it on touch screens. Optimistic, rolled back when the master refuses.
 */

interface StarApi {
  readonly starred: ReadonlySet<string>;
  readonly toggle: (messageId: string) => void;
}

const StarContext = createContext<StarApi | null>(null);

export function useStars(initial: readonly string[] | undefined, onError: (err: unknown) => void): StarApi {
  const [starred, setStarred] = useState<ReadonlySet<string>>(() => new Set(initial ?? []));
  const key = (initial ?? []).join(',');
  // The server's list wins whenever the conversation reloads.
  useEffect(() => {
    setStarred(new Set(key === '' ? [] : key.split(',')));
  }, [key]);
  const current = useRef(starred);
  current.current = starred;
  const toggle = useCallback(
    (id: string) => {
      const next = !current.current.has(id);
      const apply = (on: boolean): void => {
        setStarred((s) => {
          const n = new Set(s);
          if (on) n.add(id);
          else n.delete(id);
          return n;
        });
      };
      apply(next);
      starMessage(id, next).then(
        () => {
          invalidate('chat-organize');
        },
        (err: unknown) => {
          apply(!next);
          onError(err);
        },
      );
    },
    [onError],
  );
  return useMemo(() => ({ starred, toggle }), [starred, toggle]);
}

export function StarProvider(props: { readonly value: StarApi; readonly children: ReactNode }): ReactNode {
  return <StarContext value={props.value}>{props.children}</StarContext>;
}

const starrable = (m: ChatMessage): boolean => m.role === 'user' || m.role === 'assistant';

/** The star toggle of one message (nothing outside a conversation or for tool / error lines). */
export function StarButton(props: { readonly m: ChatMessage }): ReactNode {
  const api = useContext(StarContext);
  // p14-i18n-shell: Diyalog Sohbet rows render this too (English in the classic console).
  const t = useSharedT().shared.chat;
  if (api === null || !starrable(props.m)) return null;
  const on = api.starred.has(props.m.id);
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? t.unstarMessage : t.starMessage}
      title={on ? t.unstar : t.star}
      data-testid="star-toggle"
      onClick={() => {
        api.toggle(props.m.id);
      }}
      className={`inline-flex size-11 items-center justify-center rounded-md hover:bg-surface-2 md:size-7 ${
        on ? 'text-amber-500' : 'text-muted hover:text-fg'
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-4"
        fill={on ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
      >
        <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
      </svg>
    </button>
  );
}
