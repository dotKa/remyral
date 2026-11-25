import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from '../../../auth/AuthProvider';
import { useT } from '../../../i18n/I18nProvider';
import type { TabItem } from '../../../lib/tabs';
import { ScreenFrame, SegTabs } from '../ScreenFrame';
import { BudgetsView } from './BudgetsView';
import { DashboardTab } from './Dashboard';
import { EnforcementView } from './EnforcementView';
import { OutcomeMatrix } from './OutcomeMatrix';
import { OutcomesView } from './OutcomesView';
import { OverviewView, useSummary } from './OverviewView';
import { PricesView } from './PricesView';
import { ReportsView } from './ReportsView';
import { SuggestionsView } from './SuggestionsView';

/**
 * p12-diyalog Faz 4 + p12-diyalog-w2 (docs/design/p12-diyalog.md §12): Kullanım in the Diyalog language, flag on
 * only. Same tabs and `?tab=` ids as the classic page (budget notifications deep-link `/usage?tab=budgets`). Every
 * tab is drawn in the Diyalog language — dashboard, suggestions, reports, cost breakdown, outcomes, prices, budgets
 * (+ the ops-chat usage) and enforcement — over the classic calls and the classic rule helpers (validation, role
 * checks, step-up on every write); no classic component is rendered. p14-i18n-screens-b: text from the `usage`
 * catalog, in the user's language.
 */

export const USAGE_TAB_IDS = [
  'dashboard',
  'suggestions',
  'reports',
  'overview',
  'outcomes',
  'prices',
  'budgets',
  'enforcement',
] as const;

function PricesTab(props: { readonly canEdit: boolean }): ReactNode {
  // The classic page passes the models without a price from the current summary (project, 30 days).
  const { summary } = useSummary('project', '30d');
  return <PricesView canEdit={props.canEdit} missing={summary?.totals.missingPrices ?? []} />;
}

export function DiyalogUsage(): ReactNode {
  const t = useT().usage.screen;
  const { state } = useAuth();
  const role = state.kind === 'signedIn' ? state.user.role : 'viewer';
  const canEdit = role === 'admin' || role === 'owner';
  const [, setParams] = useSearchParams();
  const toPrices = (): void => {
    setParams({ tab: 'prices' }, { replace: true });
  };
  const tabs: readonly TabItem[] = USAGE_TAB_IDS.map((id) => ({ id, label: t.tabs[id] }));
  return (
    <ScreenFrame title={t.title} purpose={t.purpose} testId="dy-usage">
      <SegTabs label={t.tabsLabel} items={tabs}>
        {(tab) => (
          <div className="flex flex-col gap-4" data-tab={tab}>
            {tab === 'dashboard' ? <DashboardTab canExportJobs={role !== 'viewer'} /> : null}
            {tab === 'suggestions' ? (
              <SuggestionsView
                role={role === 'owner' || role === 'admin' || role === 'operator' ? role : 'viewer'}
              />
            ) : null}
            {tab === 'reports' ? <ReportsView /> : null}
            {tab === 'overview' ? <OverviewView onAddPrices={canEdit ? toPrices : undefined} /> : null}
            {tab === 'outcomes' ? (
              <section aria-label={t.outcomes} className="flex flex-col gap-4">
                <OutcomeMatrix />
                <OutcomesView />
              </section>
            ) : null}
            {tab === 'prices' ? <PricesTab canEdit={canEdit} /> : null}
            {tab === 'budgets' ? <BudgetsView canEdit={canEdit} /> : null}
            {tab === 'enforcement' ? (
              <section aria-label={t.tabs.enforcement}>
                <EnforcementView canEdit={canEdit} />
              </section>
            ) : null}
          </div>
        )}
      </SegTabs>
    </ScreenFrame>
  );
}
