import type { ReactNode } from 'react';
import { matchComposer } from './composer';
import { matchApprovals } from './approvals';
import { matchAutomations } from './automations';
import { matchDeploys } from './deploys';
import { matchJobs } from './jobs';
import { matchKnowledge } from './knowledge';
import { matchMachines } from './machines';
import { matchNeeds } from './needs';
import { matchOutputs } from './outputs';
import { matchPlans } from './plans';
import { matchProjects } from './projects';
import { matchSection } from './SectionPage';
import { matchSettings } from './settings';
import { matchTemplates } from './templates';
import { matchUptime } from './uptime';
import { matchUsage } from './usage';
import { matchWorkflows } from './workflows';
import { matchChatPrint } from '../chat/print';
import { matchOnboarding } from '../onboarding';

/**
 * p12-diyalog Faz 4 (docs/design/p12-diyalog.md §12): which routes have a Diyalog screen. The shell asks this for
 * every path but the home, Sohbet and the job page; null leaves the path to the route table (a redirect of a moved
 * URL, or "Sayfa bulunamadı").
 */
const MATCHERS: readonly ((pathname: string) => ReactNode | null)[] = [
  // p17-needs-page: "Senden bekleyen", moved off the home.
  matchNeeds,
  // p18-plans-ui: every plan of the person.
  matchPlans,
  matchMachines,
  matchJobs,
  matchWorkflows,
  matchComposer,
  matchTemplates,
  matchUsage,
  matchProjects,
  matchOutputs,
  matchUptime,
  matchSettings,
  matchAutomations,
  matchApprovals,
  matchDeploys,
  matchKnowledge,
  // p16-chat-complete: /chat/:id/yazdir (print / save as PDF).
  matchChatPrint,
  // p16-selfhost-onboarding: the owners' setup wizard.
  matchOnboarding,
  // p12-diyalog-final: last — a section with no screen gets the Diyalog placeholder (classic SectionPage).
  matchSection,
];

export function diyalogScreen(pathname: string): ReactNode | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const m of MATCHERS) {
    const el = m(path);
    if (el !== null) return el;
  }
  return null;
}
