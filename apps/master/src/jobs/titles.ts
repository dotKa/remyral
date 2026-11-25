import { deriveJobTitle, jobTitleOf, JobTitle, normalizeJobTitle } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import type pg from 'pg';
import { HttpError } from '../http/errors.js';

/**
 * p15-job-titles (docs/design/p15-job-titles.md): a job's short title, kept in `job_titles` (migration 0130) beside
 * the immutable spec. Written with the job (`insertJobTitle`, JobStore.create), edited by people (`JobTitles.set`,
 * audited `job.title.update`), back-filled for older jobs after start-up (`JobTitles.backfill`). Readers use
 * `titleOrDerived` so a job without a row (not back-filled yet) still shows a short title, never its prompt.
 */

export type JobTitleSource = 'given' | 'derived' | 'edited';

/** Prompt characters a reader fetches to derive a missing title (the derivation needs only the first lines). */
export const TITLE_PROMPT_HEAD = 2000;

/**
 * SQL select list for readers: `<alias>_title` (the stored title or NULL) and `<alias>_title_prompt` (the prompt's
 * head, only when no title is stored). Needs `LEFT JOIN job_titles <t> ON <t>.job_id = <j>.id`.
 */
export function titleColumns(j = 'j', t = 'jt'): string {
  return `${t}.title AS title_stored, CASE WHEN ${t}.title IS NULL THEN left(${j}.spec ->> 'prompt', ${String(TITLE_PROMPT_HEAD)}) END AS title_prompt`;
}

/** The job's title from a row read with {@link titleColumns}. */
export function titleOrDerived(row: {
  readonly title_stored?: string | null;
  readonly title_prompt?: string | null;
}): string {
  if (typeof row.title_stored === 'string' && row.title_stored !== '') return row.title_stored;
  return deriveJobTitle(row.title_prompt ?? '');
}

/** Writes the title of a new job (inside its create transaction). */
export async function insertJobTitle(
  tx: Queryable,
  jobId: string,
  spec: { readonly title?: string | undefined; readonly prompt: string },
  now: Date,
): Promise<{ title: string; source: JobTitleSource }> {
  const t = jobTitleOf(spec);
  await tx.query(
    `INSERT INTO job_titles (job_id, title, source, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (job_id) DO NOTHING`,
    [jobId, t.title, t.source, now],
  );
  return t;
}

/** Current titles of these jobs (stored or derived), by id. */
export async function jobTitles(db: Queryable, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { rows } = await db.query<{ id: string; title_stored: string | null; title_prompt: string | null }>(
    `SELECT j.id::text AS id, ${titleColumns()} FROM jobs j LEFT JOIN job_titles jt ON jt.job_id = j.id
      WHERE j.id = ANY($1::uuid[])`,
    [[...ids]],
  );
  for (const r of rows) out.set(r.id, titleOrDerived(r));
  return out;
}

/** The current title of one job (null: no such job). */
export async function jobTitle(db: Queryable, jobId: string): Promise<string | null> {
  return (await jobTitles(db, [jobId])).get(jobId) ?? null;
}

export interface JobTitleView {
  readonly jobId: string;
  readonly title: string;
  readonly source: JobTitleSource;
  readonly updatedAt: string | null;
}

export class JobTitles {
  constructor(
    private readonly deps: {
      readonly pool: pg.Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
    },
  ) {}

  /**
   * A person renames a job (any state, finished ones too: the title is not part of the immutable spec). The caller
   * checked `jobs.create` on the job's project. Refuses an empty, multi-line or over-long title (400).
   */
  async set(
    jobId: string,
    raw: string,
    actor: { readonly userId: string; readonly ip?: string | null; readonly userAgent?: string | null },
  ): Promise<JobTitleView> {
    const parsed = JobTitle.safeParse(raw.trim());
    const title = parsed.success ? normalizeJobTitle(parsed.data) : null;
    if (title === null) {
      throw new HttpError(400, 'invalid_title', 'A job title is one line of 1–60 characters.');
    }
    const now = this.deps.clock();
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ project: string; before: string | null; prompt: string }>(
        `SELECT j.project, jt.title AS before, left(j.spec ->> 'prompt', ${String(TITLE_PROMPT_HEAD)}) AS prompt
           FROM jobs j LEFT JOIN job_titles jt ON jt.job_id = j.id WHERE j.id = $1 FOR UPDATE OF j`,
        [jobId],
      );
      const r = rows[0];
      if (r === undefined) throw new HttpError(404, 'job_not_found', 'Job not found.');
      const before = r.before ?? deriveJobTitle(r.prompt);
      await tx.query(
        `INSERT INTO job_titles (job_id, title, source, updated_at, updated_by) VALUES ($1, $2, 'edited', $3, $4)
         ON CONFLICT (job_id) DO UPDATE SET title = EXCLUDED.title, source = 'edited',
           updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
        [jobId, title, now, actor.userId],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'job.title.update',
          target: `job:${jobId}`,
          outcome: 'success',
          ...(actor.ip === undefined ? {} : { ip: actor.ip }),
          ...(actor.userAgent === undefined ? {} : { userAgent: actor.userAgent }),
          metadata: { project: r.project, from: before, to: title },
        },
        tx,
      );
      return { jobId, title, source: 'edited' as const, updatedAt: now.toISOString() };
    });
  }

  async get(jobId: string): Promise<JobTitleView | null> {
    const { rows } = await this.deps.pool.query<{
      title_stored: string | null;
      title_prompt: string | null;
      source: JobTitleSource | null;
      updated_at: Date | null;
    }>(
      `SELECT ${titleColumns()}, jt.source, jt.updated_at FROM jobs j LEFT JOIN job_titles jt ON jt.job_id = j.id
        WHERE j.id = $1`,
      [jobId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      jobId,
      title: titleOrDerived(r),
      source: r.source ?? 'derived',
      updatedAt: r.updated_at?.toISOString() ?? null,
    };
  }

  /**
   * Back-fill (migration 0130): a 'derived' title for jobs created before titles existed, newest first, `limit` per
   * batch, at most `maxBatches` batches. Idempotent and safe on several replicas (ON CONFLICT DO NOTHING). Returns
   * how many rows it wrote.
   */
  async backfill(limit = 500, maxBatches = 200): Promise<number> {
    let total = 0;
    for (let b = 0; b < maxBatches; b++) {
      const { rows } = await this.deps.pool.query<{
        id: string;
        prompt: string | null;
        title: string | null;
      }>(
        `SELECT j.id::text AS id, left(j.spec ->> 'prompt', ${String(TITLE_PROMPT_HEAD)}) AS prompt,
                j.spec ->> 'title' AS title
           FROM jobs j WHERE NOT EXISTS (SELECT 1 FROM job_titles t WHERE t.job_id = j.id)
          ORDER BY j.created_at DESC LIMIT $1`,
        [limit],
      );
      if (rows.length === 0) break;
      const now = this.deps.clock();
      const ids: string[] = [];
      const titles: string[] = [];
      const sources: string[] = [];
      for (const r of rows) {
        const t = jobTitleOf({ title: r.title ?? undefined, prompt: r.prompt ?? '' });
        ids.push(r.id);
        titles.push(t.title);
        sources.push(t.source);
      }
      const res = await this.deps.pool.query(
        `INSERT INTO job_titles (job_id, title, source, updated_at)
         SELECT u.id, u.title, u.source, $4 FROM unnest($1::uuid[], $2::text[], $3::text[]) AS u(id, title, source)
         ON CONFLICT (job_id) DO NOTHING`,
        [ids, titles, sources, now],
      );
      total += res.rowCount ?? 0;
      if (rows.length < limit) break;
    }
    return total;
  }
}
