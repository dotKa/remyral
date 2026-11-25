import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const MonitorScreen = lazyScreen(() => import('./MonitorScreen'), 'MonitorScreen');
const UptimeScreen = lazyScreen(() => import('./UptimeScreen'), 'UptimeScreen');

/**
 * p12-diyalog Faz 4 / w2: Uptime (/uptime) and one monitor (/uptime/:id) in the Diyalog language. Returns the screen
 * for a path it owns, or null.
 */
export function matchUptime(pathname: string): ReactNode | null {
  if (pathname === '/uptime') return <UptimeScreen />;
  const m = /^\/uptime\/([^/]+)$/.exec(pathname);
  if (m === null) return null;
  const id = decodeURIComponent(m[1] ?? '');
  return <MonitorScreen key={id} id={id} />;
}
