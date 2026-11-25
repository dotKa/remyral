import { cardFor, registerCard } from '../registry';
import {
  ChangesCard,
  ContinuityCard,
  DeployCard,
  IntegrationCard,
  MemoryCard,
  OutputsCard,
  PauseCard,
  QueueCard,
  RuntimeOutcomeCard,
  SubtasksCard,
  VerificationCard,
} from './cards';
import { PreviewsCard } from './previews';
import { JobQuestionsCard } from '../questions/JobQuestionsCard';

/**
 * p12-diyalog Faz 2: attaches the job thread's card renderers to the registry (`job:<card>`; kinds in registry.ts).
 * Imported once by the job control panel (DiyalogJob.tsx), which places them as side panels.
 */
const RENDERERS = {
  'job:questions': JobQuestionsCard,
  'job:pause': PauseCard,
  'job:queue': QueueCard,
  'job:subtasks': SubtasksCard,
  'job:continuity': ContinuityCard,
  'job:verification': VerificationCard,
  'job:integration': IntegrationCard,
  'job:changes': ChangesCard,
  'job:deploy': DeployCard,
  'job:outputs': OutputsCard,
  'job:previews': PreviewsCard,
  'job:runtime': RuntimeOutcomeCard,
  'job:memory': MemoryCard,
} as const;

export type JobCardType = keyof typeof RENDERERS;

/**
 * p12-diyalog panels: the control panel's side column. First what holds the job now and needs a person (beside the
 * pending approvals), then the panels in the owner's priority order.
 */
export const JOB_URGENT_CARDS: readonly JobCardType[] = ['job:questions', 'job:pause', 'job:queue'];

export const JOB_SIDE_CARDS: readonly JobCardType[] = [
  'job:verification',
  'job:integration',
  'job:changes',
  'job:deploy',
  'job:outputs',
  'job:continuity',
  'job:memory',
  'job:runtime',
  'job:subtasks',
  'job:previews',
];

for (const [type, Card] of Object.entries(RENDERERS)) {
  registerCard(type, { kind: cardFor(type).kind, renderJob: (p) => <Card {...p} /> });
}
