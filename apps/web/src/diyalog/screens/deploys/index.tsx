import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const DeploysScreen = lazyScreen(() => import('./DeploysScreen'), 'DeploysScreen');

/**
 * p12-diyalog-w2 (docs/design/p12-diyalog.md §14): /deploys and /deploys/:id in the Diyalog language. Returns the
 * screen for a path it owns, or null (the shell then leaves the path to the route table).
 */
export function matchDeploys(pathname: string): ReactNode | null {
  if (pathname === '/deploys') return <DeploysScreen id={null} />;
  const m = /^\/deploys\/([^/]+)$/.exec(pathname);
  if (m === null) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  return <DeploysScreen key={id} id={id} />;
}
