import { type ReactNode, useId } from 'react';
import { cx } from '../../components/ui';
import { PAGE_SIZES, type PaginationProps } from '../../lib/pager';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { DyIcon } from '../icons';

/**
 * p12-diyalog-final: the one pager of the Diyalog UI (it replaces the W1 / W2 copies and the classic `Pagination`
 * that W3 screens rendered through `.dy-bridge`). The classic contract unchanged (`PaginationProps` from
 * `lib/pager.ts`), so the URL state (`?page=&pageSize=`, per-list prefixes such as `?checksPage=`), the keyset cursors
 * kept in the history entry and "a filter resets the page" all stay in `usePageParams` / `useCursorList` /
 * `useOffsetList`. Shows "1–25 / 140 · Sayfa 2 / 6" (or "Sayfa 2" for keyset lists without a total), first / previous
 * / next / last and 25 / 50 / 100 rows; 44 px targets on phones. Hidden when the list fits on one page of the
 * smallest size.
 */

const BTN =
  'dy-press inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-[9px] border border-dy-line-2 bg-dy-card px-2.5 text-[0.84375rem] font-medium text-dy-ink disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-9 sm:min-w-9 [@media(hover:hover)_and_(pointer:fine)]:hover:enabled:border-dy-ink';

export function DyPager(props: PaginationProps): ReactNode {
  const sizeId = useId();
  const t = useT().shared.pager;
  const format = useFormat();
  const fmt = (n: number): string => format.number(n);
  const { page, pageSize, count, total, hasNext } = props;
  const known = typeof total === 'number';
  const pages = known ? Math.max(1, Math.ceil(total / pageSize)) : null;
  if (page <= 1 && !hasNext && (known ? total : count) <= PAGE_SIZES[0]) return null;
  const from = count === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = count === 0 ? 0 : from + count - 1;
  const busy = props.busy === true;
  return (
    <nav
      aria-label={props.label}
      data-testid={props['data-testid'] ?? 'pagination'}
      className={cx(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 text-[0.84375rem] text-dy-muted',
        props.className,
      )}
    >
      <p aria-live="polite" className="m-0 font-dy-mono text-[0.8125rem] tabular-nums">
        {count === 0 ? (
          t.empty
        ) : (
          <>
            {fmt(from)}–{fmt(to)}
            {known ? ` / ${fmt(total)}` : ''}
          </>
        )}
        <span className="mx-2" aria-hidden="true">
          ·
        </span>
        <span>
          {t.page} {fmt(page)}
          {pages === null ? '' : ` / ${fmt(pages)}`}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor={sizeId} className="mr-1 flex items-center gap-1.5">
          <span>{t.rows}</span>
          <select
            id={sizeId}
            value={pageSize}
            onChange={(e) => {
              props.onPageSize(Number(e.target.value));
            }}
            className="min-h-11 rounded-[9px] border border-dy-line-2 bg-dy-card px-2 text-[0.9375rem] text-dy-ink sm:min-h-9 sm:text-[0.84375rem]"
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            {PAGE_SIZES.includes(pageSize as (typeof PAGE_SIZES)[number]) ? null : (
              <option value={pageSize}>{pageSize}</option>
            )}
          </select>
        </label>
        {props.onFirst && page > 2 ? (
          <button type="button" className={BTN} disabled={busy} onClick={props.onFirst} aria-label={t.first}>
            <span aria-hidden="true">«</span>
          </button>
        ) : null}
        <button
          type="button"
          className={BTN}
          disabled={busy || page <= 1}
          onClick={props.onPrev}
          aria-label={t.previous}
        >
          <DyIcon name="back" className="size-4" />
          <span className="hidden sm:inline">{t.previousShort}</span>
        </button>
        <button
          type="button"
          className={BTN}
          disabled={busy || !hasNext}
          onClick={props.onNext}
          aria-label={t.next}
        >
          <span className="hidden sm:inline">{t.nextShort}</span>
          <DyIcon name="back" className="size-4 rotate-180" />
        </button>
        {props.onLast && pages !== null && page < pages - 1 ? (
          <button type="button" className={BTN} disabled={busy} onClick={props.onLast} aria-label={t.last}>
            <span aria-hidden="true">»</span>
          </button>
        ) : null}
      </div>
    </nav>
  );
}
