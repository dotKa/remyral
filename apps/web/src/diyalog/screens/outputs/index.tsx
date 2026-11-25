import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const OutputsScreen = lazyScreen(() => import('./OutputsScreen'), 'OutputsScreen');

/**
 * p12-diyalog Faz 4: Çıktılar (/outputs) in the Diyalog language. Returns the screen for a path it owns, or null (the
 * shell then leaves the path to the route table).
 */
export function matchOutputs(pathname: string): ReactNode | null {
  return pathname === '/outputs' ? <OutputsScreen /> : null;
}
