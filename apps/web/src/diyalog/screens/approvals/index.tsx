import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const ApprovalsScreen = lazyScreen(() => import('./ApprovalsScreen'), 'ApprovalsScreen');

/**
 * p12-diyalog-w2 (docs/design/p12-diyalog.md §14): /approvals and /approvals/:id in the Diyalog language. Returns the
 * screen for a path it owns, or null (the shell then leaves the path to the route table). The list keeps
 * its state while another request opens (one key for both paths).
 */
export function matchApprovals(pathname: string): ReactNode | null {
  if (pathname === '/approvals') return <ApprovalsScreen key="approvals" id={null} />;
  const m = /^\/approvals\/([^/]+)$/.exec(pathname);
  if (m === null) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  return <ApprovalsScreen key="approvals" id={id} />;
}
