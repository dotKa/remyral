import type { WorkerOverview } from '../../../../api/fleet';
import type { WorkerDetail } from '../../../../api/workers';

/** What every machine-page tab gets from `MachineScreen` (polled every 5 s there). */
export interface MachineTabProps {
  readonly worker: WorkerDetail;
  readonly overview: WorkerOverview | undefined;
  /** Owner or admin (the classic gate for every machine change). */
  readonly isAdmin: boolean;
  /** Re-read the machine (after a change). */
  readonly onChanged: () => void;
}

/** The classic rule for "this machine can take remote operations" (not archived, paired, not quarantined). */
export function operable(w: WorkerDetail): boolean {
  return w.archivedAt === null && w.state !== 'pending' && w.state !== 'quarantined';
}
