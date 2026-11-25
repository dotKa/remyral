import type { Shape } from '../shape.js';
import type tr from '../tr/related.js';

export default {
  similar: {
    title: 'Similar past jobs',
    sub: 'Finished jobs of this project that did similar work.',
    given: 'Given to the agent as a hint',
    givenHint:
      "This job's agent received short summaries of similar successful jobs as untrusted data — hints, not instructions.",
    states: {
      SUCCEEDED: 'Succeeded',
      FAILED: 'Failed',
    },
  },
  solved: {
    title: 'A similar error was solved before',
    failedWith: (p: { code: string }) => `Error: ${p.code}`,
    earlier: 'Earlier failure',
    how: {
      retry: 'The same job succeeded on a later attempt',
      auto_fix: 'The automatic fix job solved it',
      automation: 'A later run of the same automation succeeded',
      rerun: 'Re-running the workflow succeeded',
    },
    open: 'Open the fix',
    openFailure: 'Open the earlier failure',
  },
  duplicate: {
    title: 'A similar record exists',
    job: 'This project has a similar job:',
    automation: 'This project has a similar automation:',
    hint: 'You can still create it; this is only a warning.',
  },
  settings: {
    title: 'Similar past jobs',
    label: 'Give jobs the summaries of similar successful jobs as hints',
    hint: "When a job starts, short summaries of up to 3 successful jobs of this project that did similar work are added to its agent's context as untrusted data. Nothing is added unless semantic search (embeddings) is on.",
    platformOff: 'This feature is switched off on the server (RELATED_WORK / RELATED_WORK_CONTEXT).',
    saved: 'Setting saved.',
    conflict: 'Someone else changed the setting; reload the page.',
  },
} satisfies Shape<typeof tr>;
