import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import { jobTitleOf, pullRequestTitle, type JobSpec } from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';

/**
 * p15-job-titles (docs/design/p15-job-titles.md §5): the pull request a verified job opens is named by the job's
 * title (≤ 72 characters, no id prefix); its body carries the description (the prompt), the agent's summary and the
 * job link. The squash / merge commit the master writes uses the same title as its subject. Branch names do not
 * change (`rac/<jobId>/<attemptId>`).
 *
 * The prompt and the summary go through the pattern redactor (no credential reaches GitHub through a PR body) and
 * are clipped; "@name" mentions are defused so a PR never pings people the job's text happens to name.
 */

/** Characters of the description / the agent summary in a PR body (GitHub allows 65 536 for the whole body). */
export const PR_DESCRIPTION_MAX = 6000;
export const PR_SUMMARY_MAX = 4000;

const redactor = new Redactor({ rules: DEFAULT_RULES });

interface PrJob {
  readonly id: string;
  readonly spec: Pick<JobSpec, 'prompt' | 'runtime'> & { readonly title?: string | undefined };
}

export function prTitle(job: PrJob): string {
  return pullRequestTitle(jobTitleOf(job.spec).title);
}

/** Redacted, clipped, mentions defused (`@name` → `@\u200bname`). */
function safeText(raw: string, max: number): string {
  const text = redactor.redact(raw.replaceAll('\u0000', '')).trim();
  const clipped = text.length > max ? `${text.slice(0, max).trimEnd()}\n\n…` : text;
  return clipped.replace(/(^|[^\w`])@(?=[A-Za-z0-9])/gu, '$1@\u200b');
}

export interface PrBodyFacts {
  readonly totals: { readonly files: number; readonly additions: number; readonly deletions: number };
  /** The agent's summary of the latest finished run (untrusted runtime text), if any. */
  readonly summary: string | null;
  /** Console origin for the job link (null: the id only). */
  readonly consoleOrigin: string | null;
}

export function prBody(job: PrJob, facts: PrBodyFacts): string {
  const t = facts.totals;
  const link =
    facts.consoleOrigin === null
      ? `\`${job.id}\``
      : `[${job.id.slice(0, 8)}](${facts.consoleOrigin.replace(/\/+$/u, '')}/jobs/${job.id})`;
  const description = safeText(job.spec.prompt, PR_DESCRIPTION_MAX);
  const summary = facts.summary === null ? '' : safeText(facts.summary, PR_SUMMARY_MAX);
  return [
    '## Description',
    '',
    description === '' ? '_No description._' : description,
    '',
    ...(summary === '' ? [] : ['## Agent summary', '', summary, '']),
    '---',
    `Remyral job ${link} (${job.spec.runtime}) · ${String(t.files)} files changed, +${String(t.additions)} -${String(t.deletions)}.`,
    '',
    'Merging is gated by the Remyral approval policy (admin + step-up); do not merge from here unless the',
    'project intends to bypass it.',
  ].join('\n');
}

/** The summary of the job's latest run that reported one. */
export async function latestRunSummary(db: Queryable, jobId: string): Promise<string | null> {
  const { rows } = await db.query<{ summary: string | null }>(
    `SELECT result->>'summary' AS summary FROM job_runs
      WHERE job_id = $1 AND result ? 'summary' ORDER BY result_received_at DESC NULLS LAST LIMIT 1`,
    [jobId],
  );
  const s = rows[0]?.summary;
  return typeof s === 'string' && s.trim() !== '' ? s : null;
}
