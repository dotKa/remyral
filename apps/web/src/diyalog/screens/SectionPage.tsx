import type { ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { type Section, SECTIONS } from '../../shell/sections';
import { DyButtonLink, EmptyLine, Panel } from './parts';
import { ScreenFrame } from './ScreenFrame';

/**
 * p12-diyalog-final: the classic `SectionPage` placeholder in the Diyalog language — a section of the route table that
 * has no screen yet gets its title, its one-line summary and an empty state that says so, with the way home. The
 * matcher runs last, so every section with a Diyalog screen (all of them today) never reaches it; it keeps the
 * classic fallback for a section added later without a screen.
 */
export function DySectionPage(props: { readonly section: Section }): ReactNode {
  const s = props.section;
  const t = useT().screenKit.section;
  return (
    <ScreenFrame title={s.title} purpose={s.summary} width="narrow" testId="dy-section-page">
      <Panel title={t.emptyTitle} flush>
        <EmptyLine
          testId="empty-state"
          action={
            <DyButtonLink to="/" icon="home">
              {t.home}
            </DyButtonLink>
          }
        >
          <span className="inline-flex items-center gap-2">
            <s.icon className="size-5 shrink-0" />
            {t.notReady}
          </span>
        </EmptyLine>
      </Panel>
    </ScreenFrame>
  );
}

/** A section path (other than Home and Sohbet, which the shell draws) for which no other matcher had a screen. */
export function matchSection(pathname: string): ReactNode | null {
  const s = SECTIONS.find((x) => x.path === pathname && x.path !== '/' && x.path !== '/chat');
  return s === undefined ? null : <DySectionPage section={s} />;
}
