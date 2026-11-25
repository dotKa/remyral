import type { Shape } from '../shape.js';
import type tr from '../tr/outputDelivery.js';

/**
 * p22-output-delivery: how a repository job delivers its result (a merge or Outputs) and approving several merge
 * decisions of one project together on "Waiting for you".
 */
export default {
  choice: {
    legend: 'Delivery',
    merge: 'Code change: with a merge approval (default)',
    outputs: 'File production: deliver to Outputs, no merge',
    hint: 'When the job exists to produce files (a report, a lead package, an export), its files arrive in Outputs and the job finishes without waiting for a merge approval; nothing reaches the base branch and the files also stay on the attempt branch. Only text files (CSV, JSON, Markdown, text…) are copied.',
  },
  chip: 'Delivered to Outputs',
  job: {
    delivered: 'This job delivers its files to Outputs; nothing is merged.',
  },
  bulk: {
    title: 'Approve merges together',
    project: (p) => `${p.project}: ${String(p.n)} merges waiting`,
    open: 'Select and approve',
    close: 'Close',
    all: 'Select all',
    none: 'Clear selection',
    approve: (p) => `Approve ${String(p.n)} merges`,
    busy: 'Approving…',
    hint: 'Each one is checked and recorded as if approved on its own; one authenticator code covers them all. The merges run one after another: one that conflicts after the earlier ones merged is not merged and waits for a new decision with the reason.',
    loadFailed: (p) => `Could not read the merge decisions: ${p.error}`,
    failed: (p) => `Could not approve: ${p.error}`,
    untitled: 'Untitled job',
    files: (p) => `${String(p.n)} files`,
    state: {
      clean: 'No conflicts',
      conflicts: (p) => `Conflicts: ${String(p.n)} files`,
      base_moved: 'Target branch rewritten',
      unknown: 'Merge check running',
    },
    result: {
      approved: 'Approved; the merge runs when its turn comes.',
      pending: 'Your approval is recorded; another approval is needed too.',
      refused: (p) => `Not approved: ${p.reason}`,
    },
    summary: (p) =>
      `${String(p.approved)} approved${p.refused > 0 ? `, ${String(p.refused)} not approved` : ''}.`,
  },
} satisfies Shape<typeof tr>;
