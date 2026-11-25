import type { Shape } from '../shape.js';
import type tr from '../tr/workflowQuality.js';

/**
 * p16-workflow-quality: the invalid-draft line (chat), schedules described with their time zone (automations, draft
 * cards), triggers turned on by a workflow card and the optional repository fields of the run form.
 */
export default {
  draftInvalid: {
    line: 'Draft invalid: {issues}',
    lineCount: 'Draft invalid ({kind}, {n} attempts): {issues}',
    refused: 'did not pass validation',
  },
  schedule: {
    everyMinutes: 'every {n} minutes',
    hourly: 'every hour on the hour',
    hourlyAt: 'every hour at minute {m}',
    daily: 'every day at {time}',
    weekdays: 'weekdays at {time}',
    weekly: 'every {day} at {time}',
    withZone: '{text} · {zone}',
    once: 'once, at {time}',
    days: {
      d0: 'Sunday',
      d1: 'Monday',
      d2: 'Tuesday',
      d3: 'Wednesday',
      d4: 'Thursday',
      d5: 'Friday',
      d6: 'Saturday',
    },
    expression: 'Expression',
    zone: 'Time zone',
    zoneHint: 'An IANA name such as Europe/Istanbul; daylight saving changes are applied automatically.',
    zoneInvalid: 'Unknown time zone: enter an IANA name such as Europe/Istanbul.',
  },
  run: {
    repoUrl: 'Repository URL (optional)',
    baseRef: 'Base branch (optional)',
    fromWorkflow: "Leave empty for the workflow's own repository: {url}",
    fromProject: "Leave empty for the project's repository: {url}",
    none: 'You may leave it empty: without a repository the AI steps run in a scratch folder, without code.',
  },
  workflowCard: {
    activates: 'Confirming also turns on its triggers: {list}',
    inactive: 'The triggers stay off: they start no runs until the workflow is activated.',
    repoWorkflow: "Repository: the workflow's ({url})",
    repoProject: "Repository: the project's ({url})",
    repoNone: 'No repository: the steps run in a scratch folder, without code',
  },
} satisfies Shape<typeof tr>;
