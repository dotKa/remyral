import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const AddMachineScreen = lazyScreen(() => import('./AddMachineScreen'), 'AddMachineScreen');
const FleetToolsScreen = lazyScreen(() => import('./FleetToolsScreen'), 'FleetToolsScreen');
const MachineScreen = lazyScreen(() => import('./MachineScreen'), 'MachineScreen');
const MachinesScreen = lazyScreen(() => import('./MachinesScreen'), 'MachinesScreen');

/**
 * p12-diyalog Faz 4 + wave 2 (W3): Makineler (/machines, /machines/add, /machines/:id) in the Diyalog language.
 * Returns the screen for a path it owns, or null (the shell then leaves the path to the route table).
 */
export function matchMachines(pathname: string): ReactNode | null {
  if (pathname === '/machines') return <MachinesScreen />;
  if (pathname === '/machines/add') return <AddMachineScreen />;
  // p13-fleet-tools: before the /machines/:id match (`tools` is never a machine id).
  if (pathname === '/machines/tools') return <FleetToolsScreen />;
  const m = /^\/machines\/([^/]+)$/.exec(pathname);
  if (m === null) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  // `add` is the add-machine screen above, never a machine id.
  if (id === '' || id === 'add' || id === 'tools') return null;
  return <MachineScreen key={id} id={id} />;
}
