import { useErrorText } from '../../i18n/errors';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Messages } from '@remyral/i18n';
import { type OwnChatResult, searchMyChats } from '../../api/chatKnowledge';
import { useT } from '../../i18n/I18nProvider';

/**
 * p12-diyalog-w4: "search my conversations" by meaning (keyword fallback) under the Sohbet list search, in the Diyalog
 * language — the classic MeaningResults (screens/chat/Knowledge.tsx) over the same `GET /chat/search` (debounced
 * 300 ms, only the caller's own conversations). Snippets and titles are rendered as text.
 */

/** Why the search fell back to keywords (the master's reason codes), in the user's language; unknown codes as-is. */
export function fallbackText(t: Messages, reason: string): string {
  const f: Readonly<Record<string, string>> = t.chat.meaning.fallback;
  return f[reason] ?? reason;
}

export function DyMeaningResults(props: { readonly q: string; readonly onNavigate: () => void }): ReactNode {
  const sayError = useErrorText();
  const t = useT();
  const m = t.chat.meaning;
  const [found, setFound] = useState<OwnChatResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = props.q.trim();
  useEffect(() => {
    let live = true;
    setFound(null);
    const t = setTimeout(() => {
      searchMyChats(q).then(
        (r) => {
          if (live) {
            setFound(r);
            setError(null);
          }
        },
        (err: unknown) => {
          if (live) setError(sayError(err));
        },
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  if (error !== null)
    return (
      <p role="alert" className="m-0 mb-2 px-2.5 text-[0.78125rem] text-dy-red-ink">
        {m.error({ error })}
      </p>
    );
  if (found === null) return null;
  return (
    <section
      aria-label={m.region}
      className="mb-3 grid gap-0.5 border-b border-dy-line pb-3"
      data-testid="chat-meaning"
    >
      <h3 className="m-0 px-2.5 pb-1 text-[0.75rem] font-bold tracking-[0.02em] text-dy-muted uppercase">
        {found.mode === 'semantic' ? m.semantic : m.keyword}
      </h3>
      {found.fallbackReason === null ? null : (
        <p className="m-0 px-2.5 pb-1 text-[0.75rem] text-dy-faint" data-testid="chat-meaning-fallback">
          {m.noMeaning({ reason: fallbackText(t, found.fallbackReason) })}
        </p>
      )}
      {found.items.length === 0 ? (
        <p className="m-0 px-2.5 text-[0.8125rem] text-dy-muted">{m.none}</p>
      ) : (
        <ul className="m-0 grid list-none gap-0.5 p-0">
          {found.items.slice(0, 8).map((h) => (
            <li key={`${h.messageId}:${h.attachmentName ?? ''}`}>
              <Link
                to={`/chat/${encodeURIComponent(h.threadId)}`}
                onClick={props.onNavigate}
                data-testid="chat-meaning-hit"
                className="dy-press grid gap-0.5 rounded-[10px] px-2.5 py-1.5 no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card"
              >
                <span className="truncate text-[0.875rem] font-medium text-dy-ink">
                  {h.threadTitle}
                  {h.archived ? (
                    <span className="font-normal text-dy-muted">{` ${t.chat.archivedMark}`}</span>
                  ) : null}
                </span>
                {h.plan === null ? null : (
                  <span className="text-[0.75rem] font-bold text-dy-teal-ink" data-testid="chat-meaning-plan">
                    {m.plan({ title: h.plan.title })}
                  </span>
                )}
                <span className="line-clamp-2 text-[0.78125rem] text-dy-muted">{h.snippet}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
