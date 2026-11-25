import type { ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider';
import { DyIcon } from './icons';
import { DyButton, SkeletonRows } from './screens/parts';

/**
 * p14-web-perf (docs/design/p14-web-perf.md §2): what the Diyalog shell shows in its content area while a screen's
 * chunk loads for the first time (the rail stays), and when that chunk could not be loaded. The skeleton uses the
 * screens' own skeleton rows on the thread surface, at the screen frame's width, so the screen replaces it in place.
 */
export function DyRouteLoading(): ReactNode {
  const t = useT().shell.route;
  return (
    <div
      className="dy-surface flex min-h-dvh min-w-0 flex-1 flex-col bg-dy-thread"
      data-testid="dy-route-loading"
    >
      <div className="min-h-[53px] border-b border-dy-line" aria-hidden="true" />
      <div className="mx-auto w-full max-w-[1200px] px-3 pt-5 sm:px-6">
        <SkeletonRows label={t.loading} rows={5} />
      </div>
    </div>
  );
}

export function DyRouteFailed(props: { readonly onReload: () => void }): ReactNode {
  const t = useT().shell.route;
  return (
    <div
      className="dy-surface flex min-h-dvh min-w-0 flex-1 flex-col bg-dy-thread"
      data-testid="dy-route-failed"
    >
      <div className="mx-auto w-full max-w-[1200px] px-3 pt-5 sm:px-6">
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-[10px] bg-dy-red-soft px-3.5 py-2.5 text-[0.875rem] text-dy-red-ink"
        >
          <DyIcon name="xc" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">{t.failed}</span>
          <DyButton variant="ghost" onClick={props.onReload}>
            {t.reload}
          </DyButton>
        </div>
      </div>
    </div>
  );
}
