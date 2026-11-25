import type { ReactNode } from 'react';
import { lazyScreen } from '../../../lib/lazyScreen';

const PlansScreen = lazyScreen(() => import('./PlansScreen'), 'PlansScreen');

/** p18-plans-ui: "Planlar" — every plan of the person (`/plans`). Returns the screen for the path it owns, or null. */
export function matchPlans(pathname: string): ReactNode | null {
  return pathname === '/plans' ? <PlansScreen /> : null;
}
