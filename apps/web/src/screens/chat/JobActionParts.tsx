import { isPriorityClass, PRIORITY_CLASS_LABEL } from '../../api/queue';

/**
 * p10-chat-job-actions: the parts of a job action card (cancel / run again / continue / class / move / run now on
 * existing jobs) and the quick buttons of a job card. Every value comes from the master's payload (ids, titles, states
 * it read for the drafting user) and is rendered as text only.
 */

export interface ActionJob {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly state: string;
  readonly priorityClass: string | null;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const UUID = /^[0-9a-f-]{36}$/i;

/** The jobs listed on a job action card (well-formed entries only). */
export function actionJobs(p: Record<string, unknown>): ActionJob[] {
  if (!Array.isArray(p.jobs)) return [];
  return p.jobs.map(rec).flatMap((j) =>
    typeof j.id === 'string' && UUID.test(j.id)
      ? [
          {
            id: j.id,
            title: typeof j.title === 'string' ? j.title.slice(0, 200) : '',
            project: typeof j.project === 'string' ? j.project : '',
            state: typeof j.state === 'string' ? j.state : '',
            priorityClass: typeof j.priorityClass === 'string' ? j.priorityClass : null,
          },
        ]
      : [],
  );
}

const ACTION_LABEL: Readonly<Record<string, string>> = {
  cancel: 'Cancel',
  run_again: 'Run again',
  continue: 'Continue',
  set_class: 'Change class',
  move: 'Move in the queue',
  run_now: 'Run now (Acil)',
  resolve_conflicts: 'Resolve conflicts',
};

export function jobActionLabel(action: unknown): string {
  return typeof action === 'string' ? (ACTION_LABEL[action] ?? action) : 'Job action';
}

/** What confirming the card does, in one sentence. */
export function jobActionEffect(p: Record<string, unknown>): string {
  const n = actionJobs(p).length;
  const each = n === 1 ? 'The job' : 'Each checked job';
  switch (p.action) {
    case 'cancel':
      return `${each} is cancelled; a running one is stopped on its machine.`;
    case 'run_again':
      return `A new job starts for ${n === 1 ? 'it' : 'each checked job'} with the same settings and a new work branch${
        typeof p.prompt === 'string' ? ' and the edited prompt' : ''
      } (input files and deploy on success are not carried over).`;
    case 'continue':
      return `A new job continues ${n === 1 ? 'it' : 'each checked job'} after its approval expired; nothing is pre-approved.`;
    case 'set_class':
      return `${each} moves to ${isPriorityClass(p.priorityClass) ? PRIORITY_CLASS_LABEL[p.priorityClass] : 'another class'} in the queue.`;
    case 'move': {
      const t = rec(p.target);
      const other = typeof t.id === 'string' ? `job ${t.id.slice(0, 8)}` : 'the other job';
      return `The job moves ${p.before !== undefined ? 'before' : 'after'} ${other} in the queue (within its class).`;
    }
    case 'run_now':
      return 'The job becomes Acil (urgent) and goes first in the queue.';
    case 'resolve_conflicts':
      return 'A new job carries the conflicting result onto the current target; when it merges, the platform closes the old pull request.';
    default:
      return 'Runs the action on each checked job.';
  }
}
