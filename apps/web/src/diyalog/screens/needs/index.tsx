import type { ReactNode } from 'react';
import { lazyScreen } from '../../../lib/lazyScreen';
import { NEEDS_PATH } from '../../ops/anchors';

const NeedsScreen = lazyScreen(() => import('./NeedsScreen'), 'NeedsScreen');

/**
 * p17-needs-page (docs/design/p17-needs-page.md): "Senden bekleyen" — the decisions page (`/needs`), moved off the
 * home. Returns the screen for the path it owns, or null.
 */
export function matchNeeds(pathname: string): ReactNode | null {
  return pathname === NEEDS_PATH ? <NeedsScreen /> : null;
}
