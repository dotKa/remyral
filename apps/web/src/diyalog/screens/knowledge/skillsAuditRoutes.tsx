import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const AuditScreen = lazyScreen(() => import('./AuditScreen'), 'AuditScreen');
const SkillsScreen = lazyScreen(() => import('./SkillsScreen'), 'SkillsScreen');

/** `/skills` and `/audit` in the Diyalog language (p12-diyalog wave 2, W3); null for every other path. */
export function matchSkillsAudit(pathname: string): ReactNode | null {
  if (pathname === '/skills') return <SkillsScreen />;
  if (pathname === '/audit') return <AuditScreen />;
  return null;
}
