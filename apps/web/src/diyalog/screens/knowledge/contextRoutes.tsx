import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const ContextScreen = lazyScreen(() => import('./ContextView'), 'ContextScreen');

/** `/context` in the Diyalog language (p12-diyalog wave 2, W3); `/settings/context` lives in `screens/settings`. */
export function matchContext(pathname: string): ReactNode | null {
  return pathname === '/context' ? <ContextScreen /> : null;
}
