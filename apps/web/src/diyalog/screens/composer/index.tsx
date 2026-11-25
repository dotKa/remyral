import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const ComposerScreen = lazyScreen(() => import('./ComposerScreen'), 'ComposerScreen');

/**
 * p12-diyalog-w1: the composer page (exactly `/jobs/new`) in the Diyalog language (docs/design/p12-diyalog.md §14).
 * Returns null for every other path.
 */
export function matchComposer(pathname: string): ReactNode | null {
  return pathname === '/jobs/new' ? <ComposerScreen /> : null;
}
