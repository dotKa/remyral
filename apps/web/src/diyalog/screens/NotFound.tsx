import { createContext, type ReactNode, use, useLayoutEffect } from 'react';
import { useLocation } from 'react-router';
import { useT } from '../../i18n/I18nProvider';
import { DyButton, DyButtonLink, Panel } from './parts';
import { ScreenFrame } from './ScreenFrame';

/**
 * p12-diyalog-w4: "Sayfa bulunamadı" in the Diyalog language. The route table's catch-all (`*`) only reports its path
 * through this context (and renders nothing); the shell shows this screen for that path. Path-keyed, so the report
 * never flips back while the element unmounts.
 */
export const NotFoundReport = createContext<((path: string) => void) | null>(null);

/** In the Diyalog shell: report this path as unknown and return true (the caller renders nothing). */
export function useReportNotFound(): boolean {
  const report = use(NotFoundReport);
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    report?.(pathname);
  }, [report, pathname]);
  return report !== null;
}

export function DyNotFound(props: { readonly onAll: () => void }): ReactNode {
  const { pathname } = useLocation();
  const all = useT();
  const t = all.auth.notFound;
  return (
    <ScreenFrame title={t.title} purpose={t.purpose} width="narrow" testId="dy-not-found">
      <Panel title={t.panel}>
        <p className="m-0 mb-3 text-[0.875rem] text-dy-muted">
          {t.requested}{' '}
          <code className="font-dy-mono text-dy-ink [overflow-wrap:anywhere]" translate="no">
            {pathname}
          </code>
        </p>
        <div className="flex flex-wrap gap-2">
          <DyButtonLink to="/" variant="primary" icon="home">
            {all.nav.home}
          </DyButtonLink>
          <DyButtonLink to="/chat" icon="bubble">
            {all.nav.chat}
          </DyButtonLink>
          <DyButton icon="grid" onClick={props.onAll} aria-haspopup="dialog">
            {t.allScreens}
          </DyButton>
        </div>
      </Panel>
    </ScreenFrame>
  );
}
