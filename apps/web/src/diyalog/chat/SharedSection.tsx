import { fill } from '@remyral/i18n';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { SharedThread } from '../../api/chat';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';

/**
 * p16-chat-complete (docs/design/p16-chat-complete.md §4): "Paylaşılanlar" under the conversation list — the
 * conversations other people shared with the caller, opened read-only. Hidden while there are none (or the master is
 * older and has no sharing).
 */
export function SharedSection(props: {
  readonly items: readonly SharedThread[];
  readonly activeId: string | null;
  readonly onNavigate?: (() => void) | undefined;
}): ReactNode {
  const t = useT().chatComplete.shared;
  const items = props.items;
  if (items.length === 0) return null;
  return (
    <section className="mt-3" data-testid="shared-section" aria-label={t.section}>
      <h3 className="m-0 px-2.5 pt-1 pb-1.5 text-[0.75rem] font-bold tracking-[0.02em] text-dy-faint">
        {t.section}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {items.map((x) => (
          <li key={x.id}>
            <Link
              to={`/chat/${encodeURIComponent(x.id)}`}
              onClick={props.onNavigate}
              aria-current={props.activeId === x.id ? 'page' : undefined}
              className={cx(
                'dy-press flex min-h-11 flex-col justify-center rounded-[9px] px-2.5 py-1 no-underline md:min-h-9',
                props.activeId === x.id
                  ? 'bg-dy-card text-dy-ink shadow-dy'
                  : 'text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card',
              )}
            >
              <span className="truncate text-[0.875rem]">{x.title}</span>
              <span className="truncate text-[0.75rem] text-dy-muted">
                {fill(t.by, { owner: x.owner.username })}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
