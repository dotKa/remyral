import type { ReactNode } from 'react';
import { lazyScreen } from '../../lib/lazyScreen';

const WizardScreen = lazyScreen(() => import('./WizardScreen'), 'WizardScreen');

/** p16-selfhost-onboarding: `/onboarding` (`?step=<id>` opens a step) — the owners' setup wizard. */
export function matchOnboarding(pathname: string): ReactNode | null {
  return pathname === '/onboarding' ? <WizardScreen /> : null;
}
