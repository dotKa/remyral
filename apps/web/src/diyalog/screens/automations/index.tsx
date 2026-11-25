import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const AutomationFormScreen = lazyScreen(() => import('./AutomationFormScreen'), 'AutomationFormScreen');
const AutomationScreen = lazyScreen(() => import('./AutomationScreen'), 'AutomationScreen');
const AutomationsScreen = lazyScreen(() => import('./AutomationsScreen'), 'AutomationsScreen');

/**
 * p12-diyalog-w2 (docs/design/p12-diyalog.md §14): Otomasyonlar in the Diyalog language — the list
 * (/automations), the form (/automations/new, /automations/:id/edit) and the automation (/automations/:id). Returns
 * the screen for a path it owns, or null (the shell then leaves the path to the route table). Detail and
 * edit screens are keyed by id.
 */
export function matchAutomations(pathname: string): ReactNode | null {
  if (pathname === '/automations') return <AutomationsScreen />;
  if (pathname === '/automations/new') return <AutomationFormScreen key="new" />;
  const edit = /^\/automations\/([^/]+)\/edit$/.exec(pathname);
  if (edit?.[1] !== undefined) {
    const id = decodeURIComponent(edit[1]);
    return <AutomationFormScreen key={`edit:${id}`} id={id} />;
  }
  const one = /^\/automations\/([^/]+)$/.exec(pathname);
  if (one?.[1] !== undefined) {
    const id = decodeURIComponent(one[1]);
    return <AutomationScreen key={id} id={id} />;
  }
  return null;
}
