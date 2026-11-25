import { fill } from '@remyral/i18n';
import { type ReactNode, useId, useState } from 'react';
import type { ChatMessage } from '../../api/chat';
import { Markdown } from '../../screens/chat/markdown';
import { useT } from '../../i18n/I18nProvider';
import { DyIcon } from '../icons';

/**
 * p16-chat-complete (docs/design/p16-chat-complete.md §1.1): a block of rows an edit / regenerate / retry replaced,
 * folded into one line where it stood; "Göster" shows it dimmed and read-only (it never reaches a model again).
 */
export function SupersededFold(props: { readonly messages: readonly ChatMessage[] }): ReactNode {
  const t = useT().chatComplete.superseded;
  const id = useId();
  const [open, setOpen] = useState(false);
  const shown = props.messages.filter((m) => m.role !== 'tool' || open);
  return (
    <div className="text-[0.8125rem] text-dy-muted" data-testid="superseded-fold">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="dy-press inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 md:min-h-8 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
      >
        <DyIcon name="chev" className={`size-3.5 ${open ? '' : '-rotate-90'}`} />
        {fill(t.fold, { count: props.messages.length })}
        <span className="font-bold">{open ? t.hide : t.show}</span>
      </button>
      <ol
        id={id}
        hidden={!open}
        className="m-0 mt-1 flex list-none flex-col gap-2 border-l border-dy-line py-0 pl-3 opacity-70"
      >
        {shown.map((m) => (
          <li key={m.id} data-testid="superseded-message" className="[overflow-wrap:anywhere]">
            <span className="font-bold">
              {m.role === 'user' ? t.user : m.role === 'tool' ? t.tool : t.assistant}:
            </span>{' '}
            {m.role === 'assistant' ? <Markdown text={m.content} /> : <span>{m.content}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
