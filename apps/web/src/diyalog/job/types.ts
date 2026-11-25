import type { JobContinuity } from '../../api/continuity';
import type { JobDetail } from '../../api/jobs';
import type { JobMemory } from '../../api/memoryRecords';
import type { JobFacts } from './steps';

/**
 * p12-diyalog Faz 2: what every job-level card of a job thread receives (registry.ts `renderJob`). Each card reads its
 * own data through the endpoint its classic card uses and renders nothing when there is nothing to say.
 */
export interface JobCardProps {
  readonly detail: JobDetail;
  /** The live state (the stream may be ahead of `detail`). */
  readonly state: string;
  /** SUCCEEDED / FAILED / CANCELLED / LOST. */
  readonly finished: boolean;
  /** Operators and up (viewers read only; the master decides per project). */
  readonly canAct: boolean;
  /** Re-read the job (after an action changed it). */
  readonly reload: () => void;
  /** Machine id → name. */
  readonly names: ReadonlyMap<string, string>;
  /** Opens the cancel dialog of the page. */
  readonly onCancel: () => void;
  /** Where the job's log and files are (the "Ayrıntılar" view). */
  readonly detailsHref: (tab: 'files' | 'logs' | 'details') => string;
  /** Shared reads the header uses too (one request each). */
  readonly continuity: JobContinuity | null;
  readonly memory: JobMemory | null;
  /**
   * p12-diyalog panels: a card tells the control panel what it learned (verification / integration / deploy state)
   * so the step bar needs no request of its own.
   */
  readonly report?: ((facts: JobFacts) => void) | undefined;
}
