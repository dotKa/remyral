import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const DiyalogUsage = lazyScreen(() => import('./DiyalogUsage'), 'DiyalogUsage');
const ReportScreen = lazyScreen(() => import('./ReportsView'), 'ReportScreen');

/**
 * p12-diyalog Faz 4 + w2: Kullanım (/usage) and a weekly report (/usage/reports/:id) in the Diyalog language.
 * Returns the screen for a path it owns, or null (the shell then shows "Sayfa bulunamadı").
 */
export function matchUsage(pathname: string): ReactNode | null {
  if (pathname === '/usage') return <DiyalogUsage />;
  const m = /^\/usage\/reports\/([^/]+)$/.exec(pathname);
  if (m?.[1] === undefined) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return <ReportScreen key={id} id={id} />;
}
