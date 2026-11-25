import type { Queryable } from '../db/pool.js';
import { jobTitle } from '../jobs/titles.js';
import { shortId } from './model.js';

/**
 * p15-job-titles: how a notification names a job — its short title (≤ 60 characters, written by the submitter or
 * derived from the prompt's first clause), with the short id for reference. Notification text is cleaned and
 * redacted (`cleanText`) before it is stored or sent.
 */
export interface JobName {
  /** `0a1b2c3d`. */
  readonly id: string;
  /** The title, or the short id when the job is gone. */
  readonly title: string;
  /** `0a1b2c3d “title”` for sentences. */
  readonly ref: string;
}

export async function jobName(db: Queryable, jobId: string): Promise<JobName> {
  const id = shortId(jobId);
  const title = await jobTitle(db, jobId).catch(() => null);
  return title === null ? { id, title: id, ref: id } : { id, title, ref: `${id} “${title}”` };
}
