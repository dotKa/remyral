import type { Shape } from '../shape.js';
import type tr from '../tr/repoFiles.js';

/**
 * p19-repo-inputs-composer-workflows: input files of repository projects — the job form's file field and a workflow
 * run's files (every AI step gets them). The files go to a scratch in/ folder next to the checkout.
 */
export default {
  composer: {
    jobNote:
      'A repository job reads these from a read-only scratch in/ folder next to the checkout; they are never committed or pushed.',
    runNote:
      'Every AI step gets these read-only in a scratch in/ folder next to its checkout; they are never committed.',
    limits: (p) =>
      `At most ${p.files} files, ${p.each} each, ${p.total} in total; types ${p.types}. The files are scanned for secrets when sent.`,
    continueHint:
      'The results of this earlier job are given as input files (they never enter the repository).',
    update:
      'No machine can take input files for a repository project yet: the machines must be updated (repo-inputs-v1). Until then, describe the files in the task.',
  },
  card: {
    runNote:
      'Every AI step gets these in a scratch in/ folder next to its checkout; they are never committed.',
  },
} satisfies Shape<typeof tr>;
