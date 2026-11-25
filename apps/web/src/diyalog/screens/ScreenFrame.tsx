import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { PwaBridge } from '../../pwa/PwaBridge';
import { DyIcon } from '../icons';
import { DyHeaderTools } from '../topbar';
import { UnsavedGuardProvider } from '../formkit/guard';

/**
 * p12-diyalog Faz 4 (docs/design/p12-diyalog.md §12): the frame of a secondary screen in the Diyalog language — the
 * sticky top bar of the home / job thread (title, an optional way back, live state, bell, account), a page head
 * (title, one purpose line, the screen's primary actions) and the content column. `.dy-bridge` is only a token
 * scope now (p12-diyalog-final: no classic component renders inside a Diyalog screen): shared renderers that read the
 * semantic tokens — the safe Markdown view, attachment previews — take the Diyalog palette and type.
 */
export function ScreenFrame(props: {
  /** Page title (h1) and the document title. */
  readonly title: string;
  /** p15-chat-cards-scroll: shown next to the h1 (an edit pencil). */
  readonly titleAccessory?: ReactNode;
  /** p15-chat-cards-scroll: replaces the h1 while the title is being edited (an inline name field). */
  readonly titleEditor?: ReactNode;
  /** One line under the title: what this screen answers. */
  readonly purpose?: ReactNode;
  /** Back link in the top bar (detail screens). */
  readonly back?: { readonly to: string; readonly label: string } | undefined;
  /** Primary actions right of the title. */
  readonly actions?: ReactNode;
  /** Short facts under the purpose line (chips, counts); `null` = still loading (the row's height is kept). */
  readonly facts?: ReactNode;
  /** "Canlı" dot in the top bar for screens that poll. */
  readonly live?: 'live' | 'error' | undefined;
  /** Content width: `wide` (tables, dashboards; 1200 px) or `narrow` (settings forms; 820 px). */
  readonly width?: 'wide' | 'narrow' | undefined;
  /**
   * p13-workflows-ui: `canvas` — the page head stays, the content below it fills the rest of the window edge to edge
   * (no max width, no scrolling page): an editor canvas.
   */
  readonly layout?: 'page' | 'canvas' | undefined;
  readonly testId?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const canvas = props.layout === 'canvas';
  const t = useT();
  useEffect(() => {
    document.title = `${props.title} · Remyral`; // i18n-ignore: product name
  }, [props.title]);
  // p14-diyalog-polish-2: the top bar names the page only once the h1 has scrolled away (the title was shown twice,
  // one above the other, on every screen). Without IntersectionObserver (old browsers, tests) the bar keeps it.
  const h1 = useRef<HTMLHeadingElement>(null);
  const [h1Visible, setH1Visible] = useState(() => typeof IntersectionObserver !== 'undefined');
  useEffect(() => {
    const el = h1.current;
    if (el === null || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        if (e !== undefined) setH1Visible(e.isIntersecting);
      },
      // The sticky bar is ~53 px tall: the h1 counts as gone once it is under the bar.
      { rootMargin: '-56px 0px 0px 0px' },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, []);
  return (
    // p15-form-pattern: every screen's forms share one unsaved-changes guard (tabs, in-app links, browser unload).
    <UnsavedGuardProvider>
      <div
        className={cx(
          'dy-surface dy-bridge flex min-w-0 flex-1 flex-col bg-dy-thread',
          canvas
            ? 'h-[var(--app-vh,100dvh)] overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0'
            : 'min-h-dvh',
        )}
        data-testid={props.testId}
      >
        <div className="sticky top-0 z-[5] flex min-h-[53px] items-center gap-3 border-b border-dy-line bg-dy-thread/85 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] backdrop-blur-[14px] backdrop-saturate-150 sm:px-6">
          {props.back === undefined ? (
            <span
              className="grid size-[26px] shrink-0 place-items-center rounded-lg bg-dy-teal text-dy-on-fill md:hidden"
              aria-hidden="true"
            >
              <DyIcon name="bubble" />
            </span>
          ) : (
            <Link
              to={props.back.to}
              className="dy-press -ml-1 inline-flex min-h-9 items-center gap-1 rounded-lg px-1.5 text-[0.84375rem] font-medium text-dy-muted no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
            >
              <DyIcon name="back" className="size-4" />
              {props.back.label}
            </Link>
          )}
          {/* With a back link the phone bar has no room for the title too; the h1 below carries it. */}
          <span
            className={cx(
              'dy-bar-title min-w-0 truncate text-[0.9375rem] font-extrabold tracking-[-0.01em]',
              props.back !== undefined && 'max-sm:hidden',
            )}
            data-shown={h1Visible ? 'false' : 'true'}
            aria-hidden="true"
          >
            {props.title}
          </span>
          {props.live === undefined ? null : (
            <span className="hidden items-center gap-[7px] text-[0.78125rem] text-dy-muted sm:flex">
              <span
                className={cx(
                  'size-2 rounded-full',
                  props.live === 'error' ? 'bg-dy-red' : 'dy-breathe bg-dy-green',
                )}
                aria-hidden="true"
              />
              {props.live === 'error' ? t.screenKit.frame.liveError : t.screenKit.frame.live}
            </span>
          )}
          <DyHeaderTools className="ml-auto" />
        </div>
        <main
          id="main"
          tabIndex={-1}
          className={cx(
            canvas
              ? 'flex min-h-0 w-full min-w-0 flex-1 flex-col outline-none'
              : 'mx-auto w-full min-w-0 flex-1 px-3 pt-5 pb-[calc(6rem+env(safe-area-inset-bottom))] outline-none sm:px-6 md:pb-12',
            !canvas && (props.width === 'narrow' ? 'max-w-[820px]' : 'max-w-[1200px]'),
          )}
        >
          {/* p12-diyalog-parity: the shell shows the "new version" offer once, in the Diyalog language. */}
          <PwaBridge />
          <header
            className={cx(
              'flex flex-wrap items-start gap-x-6 gap-y-3',
              canvas ? 'shrink-0 px-3 pt-3 pb-3 sm:px-6' : 'mb-5 sm:mb-6',
            )}
          >
            <div className="min-w-0 flex-[1_1_320px]">
              {props.titleEditor !== undefined && props.titleEditor !== null ? (
                props.titleEditor
              ) : (
                <div className={props.titleAccessory ? 'flex min-w-0 items-center' : 'contents'}>
                  <h1
                    ref={h1}
                    className={cx(
                      'm-0 min-w-0 leading-tight font-extrabold tracking-[-0.02em] text-balance',
                      canvas ? 'text-[1.375rem]' : 'text-[1.625rem]',
                    )}
                  >
                    {props.title}
                  </h1>
                  {props.titleAccessory}
                </div>
              )}
              {props.purpose === undefined ? null : (
                <p className="m-0 mt-1 max-w-[68ch] text-[0.9375rem] text-pretty text-dy-muted max-sm:text-[0.875rem]">
                  {props.purpose}
                </p>
              )}
              {props.facts === undefined ? null : props.facts === null ? (
                // p12-diyalog-default (visual tour): facts still loading — their row is kept, so the page does not
                // jump down when they arrive.
                <div className="mt-3 min-h-[1.625rem]" aria-hidden="true" data-testid="dy-facts-pending" />
              ) : (
                <div className="mt-3 flex min-h-[1.625rem] flex-wrap items-center gap-1.5">{props.facts}</div>
              )}
            </div>
            {props.actions === undefined ? null : (
              // p14-diyalog-polish-2: on phones the actions stay on one line and scroll sideways (edge to edge, faded at
              // the end) instead of wrapping a lone button ("Otomasyonlar") onto a line of its own.
              <div className="dy-noscrollbar dy-action-row flex items-center gap-2 max-sm:-mx-3 max-sm:w-[calc(100%+1.5rem)] max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:px-3 max-sm:[&>*]:shrink-0 sm:flex-wrap">
                {props.actions}
              </div>
            )}
          </header>
          {props.children}
        </main>
      </div>
    </UnsavedGuardProvider>
  );
}

/**
 * Segmented tabs in the mockup's `.tabs` shape, URL-synced (`?<param>=<id>`) with the WAI-ARIA tabs keyboard. Since
 * p15-form-pattern this is `DyTabs`: it also asks the unsaved-changes guard before it switches.
 */
export { DyTabs as SegTabs } from '../formkit/tabs';
