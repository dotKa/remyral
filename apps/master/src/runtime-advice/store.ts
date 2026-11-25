import {
  AreaPathRule,
  classifyJob,
  type JobClassification,
  type JobSpec,
  RUNTIME_ADVICE_DEFAULTS,
  RuntimeAdviceSettings,
} from '@remyral/protocol';
import { judgeOutcome, type OutcomeSample, type OutcomeSignals } from '@remyral/scheduler';
import { z } from 'zod';
import type { Queryable } from '../db/pool.js';

/**
 * p11-runtime-advice (docs/design/p11-runtime-advice.md §2–3): the database side — job classifications (at
 * submission and when the job ends), the finished-job outcome rows, the later quality signals joined at read time,
 * the per-project settings and the history back-fill. Every writer here runs inside the job store's transactions
 * behind a savepoint (never blocks a transition).
 */

/** Jobs that are not agent work (no runtime choice to learn from). */
const NOT_AGENT_WORK = new Set(['machine-admin', 'integration', 'function']);

export async function loadAdviceSettings(db: Queryable, project: string): Promise<RuntimeAdviceSettings> {
  const { rows } = await db.query<{
    mode: string;
    exploration_pct: number;
    min_samples: number;
    allowed_runtimes: string[];
    allow_paid: boolean;
    half_life_days: number;
    rerun_window_days: number;
    area_rules: unknown;
  }>(
    `SELECT mode, exploration_pct, min_samples, allowed_runtimes, allow_paid, half_life_days, rerun_window_days,
            area_rules FROM runtime_advice_settings WHERE project = $1`,
    [project],
  );
  const r = rows[0];
  if (r === undefined) return RUNTIME_ADVICE_DEFAULTS;
  const parsed = RuntimeAdviceSettings.safeParse({
    mode: r.mode,
    explorationPct: r.exploration_pct,
    minSamples: r.min_samples,
    // A runtime removed since (ADR-0023) is dropped, never fails the read.
    allowedRuntimes: r.allowed_runtimes.filter((x) => x !== 'openhands'),
    allowPaid: r.allow_paid,
    halfLifeDays: r.half_life_days,
    rerunWindowDays: r.rerun_window_days,
    areaRules: r.area_rules,
  });
  // A stored value that no longer parses falls back to the defaults (auto off), never to something more permissive.
  return parsed.success ? parsed.data : RUNTIME_ADVICE_DEFAULTS;
}

export async function saveAdviceSettings(
  db: Queryable,
  project: string,
  s: RuntimeAdviceSettings,
  userId: string,
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO runtime_advice_settings (project, mode, exploration_pct, min_samples, allowed_runtimes, allow_paid,
                                          half_life_days, rerun_window_days, area_rules, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (project) DO UPDATE SET mode = EXCLUDED.mode, exploration_pct = EXCLUDED.exploration_pct,
       min_samples = EXCLUDED.min_samples, allowed_runtimes = EXCLUDED.allowed_runtimes,
       allow_paid = EXCLUDED.allow_paid, half_life_days = EXCLUDED.half_life_days,
       rerun_window_days = EXCLUDED.rerun_window_days, area_rules = EXCLUDED.area_rules,
       updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [
      project,
      s.mode,
      s.explorationPct,
      s.minSamples,
      s.allowedRuntimes,
      s.allowPaid,
      s.halfLifeDays,
      s.rerunWindowDays,
      JSON.stringify(s.areaRules),
      userId,
      now,
    ],
  );
}

async function projectRules(db: Queryable, project: string): Promise<AreaPathRule[]> {
  const { rows } = await db.query<{ area_rules: unknown }>(
    'SELECT area_rules FROM runtime_advice_settings WHERE project = $1',
    [project],
  );
  const parsed = z.array(AreaPathRule).safeParse(rows[0]?.area_rules ?? []);
  return parsed.success ? parsed.data : [];
}

/** Bounded signal list for storage (the detail strings are already short). */
function storedSignals(c: JobClassification): string {
  return JSON.stringify(c.signals.slice(0, 40).map((s) => ({ ...s, detail: s.detail.slice(0, 200) })));
}

export async function writeClassification(
  db: Queryable,
  jobId: string,
  project: string,
  c: JobClassification,
  stage: 'submitted' | 'final' | 'backfill',
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO job_classifications (job_id, project, kind, kind_source, area, area_source, signals, scores, stage,
                                      classified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (job_id) DO UPDATE SET kind = EXCLUDED.kind, kind_source = EXCLUDED.kind_source,
       area = EXCLUDED.area, area_source = EXCLUDED.area_source, signals = EXCLUDED.signals,
       scores = EXCLUDED.scores, stage = EXCLUDED.stage, classified_at = EXCLUDED.classified_at`,
    [
      jobId,
      project,
      c.kind,
      c.kindSource,
      c.area,
      c.areaSource,
      storedSignals(c),
      JSON.stringify(c.scores),
      stage,
      now,
    ],
  );
}

/** Hints known at submission or later: sub-job `paths`, the template's title, the automation's name. */
async function hintsOf(
  db: Queryable,
  jobId: string,
): Promise<{ pathHints: string[]; templateName: string | undefined; touchedPaths: string[] }> {
  const { rows } = await db.query<{
    paths: string[] | null;
    template: string | null;
    automation: string | null;
    touched: string[] | null;
  }>(
    `SELECT (SELECT s.paths FROM job_subtasks s WHERE s.child_job_id = $1) AS paths,
            (SELECT t.title FROM job_template_runs r JOIN job_templates t ON t.id = r.template_id
              WHERE r.job_id = $1) AS template,
            (SELECT a.name FROM automation_runs ar JOIN automations a ON a.id = ar.automation_id
              WHERE ar.job_id = $1 LIMIT 1) AS automation,
            (SELECT array_agg(f->>'path') FROM job_git g,
                    jsonb_array_elements(COALESCE(g.changes->'files', '[]'::jsonb)) AS f
              WHERE g.job_id = $1 AND jsonb_typeof(g.changes->'files') = 'array') AS touched`,
    [jobId],
  );
  const r = rows[0];
  return {
    pathHints: r?.paths ?? [],
    templateName: r?.template ?? r?.automation ?? undefined,
    touchedPaths: (r?.touched ?? []).filter((p): p is string => typeof p === 'string'),
  };
}

/** Classification at submission (prompt, explicit role / area; hints the job store knows only later are added at the end). */
export async function classifyAtCreate(
  db: Queryable,
  jobId: string,
  project: string,
  spec: JobSpec,
  now: Date,
): Promise<JobClassification | null> {
  if (spec.kind !== undefined && NOT_AGENT_WORK.has(spec.kind)) return null;
  const c = classifyJob({
    prompt: spec.prompt,
    role: spec.role,
    area: spec.area,
    kind: spec.kind,
    projectRules: await projectRules(db, project),
  });
  await writeClassification(db, jobId, project, c, 'submitted', now);
  return c;
}

/** Re-classifies a finished job with everything known now (touched paths, sub-job paths, template / automation). */
export async function classifyFinal(
  db: Queryable,
  jobId: string,
  project: string,
  spec: Pick<JobSpec, 'prompt' | 'role' | 'area' | 'kind'>,
  stage: 'final' | 'backfill',
  now: Date,
): Promise<JobClassification> {
  const hints = await hintsOf(db, jobId);
  const c = classifyJob({
    prompt: spec.prompt,
    role: spec.role,
    area: spec.area,
    kind: spec.kind,
    pathHints: hints.pathHints,
    touchedPaths: hints.touchedPaths,
    templateName: hints.templateName,
    projectRules: await projectRules(db, project),
  });
  await writeClassification(db, jobId, project, c, stage, now);
  return c;
}

/**
 * The outcome row of a job that just reached SUCCEEDED or FAILED (in the transition's transaction). The runtime / model
 * are those the last attempt ran with (a usage-limit fallback counts for the fallback). Returns false when the job is
 * not agent work.
 */
export async function recordJobOutcome(
  db: Queryable,
  job: { readonly id: string; readonly project: string; readonly spec: JobSpec; readonly state: string },
  lastAttemptId: string | null,
  now: Date,
): Promise<boolean> {
  if (job.state !== 'SUCCEEDED' && job.state !== 'FAILED') return false;
  if (job.spec.kind !== undefined && NOT_AGENT_WORK.has(job.spec.kind)) return false;
  let runtime: string = job.spec.runtime;
  let model = job.spec.model ?? '';
  if (lastAttemptId !== null) {
    const choice = await db.query<{ runtime_choice: { runtime?: unknown; model?: unknown } | null }>(
      'SELECT runtime_choice FROM job_runs WHERE attempt_id = $1',
      [lastAttemptId],
    );
    const ch = choice.rows[0]?.runtime_choice;
    if (ch != null && typeof ch.runtime === 'string' && ch.runtime !== job.spec.runtime) {
      runtime = ch.runtime;
      model = typeof ch.model === 'string' ? ch.model : '';
    }
  }
  const c = await classifyFinal(db, job.id, job.project, job.spec, 'final', now);
  await db.query(
    `INSERT INTO job_outcomes (job_id, project, runtime, model, kind, area, classified, succeeded, duration_sec,
                               cost_usd, prompt_digest, ended_at)
     VALUES ($1, $2, $3, left($4, 128), $5, $6, true, $7,
             (SELECT sum(extract(epoch FROM (a.ended_at - a.started_at)))
                FROM job_attempts a WHERE a.job_id = $1 AND a.ended_at IS NOT NULL),
             (SELECT sum(u.cost_usd) FROM usage_records u WHERE u.job_id = $1),
             (SELECT j.prompt_digest FROM jobs j WHERE j.id = $1), $8)
     ON CONFLICT (job_id) DO UPDATE SET runtime = EXCLUDED.runtime, model = EXCLUDED.model, kind = EXCLUDED.kind,
       area = EXCLUDED.area, classified = true, succeeded = EXCLUDED.succeeded, duration_sec = EXCLUDED.duration_sec,
       cost_usd = EXCLUDED.cost_usd, ended_at = EXCLUDED.ended_at`,
    [job.id, job.project, runtime, model, c.kind, c.area, job.state === 'SUCCEEDED', now],
  );
  return true;
}

/** One finished job with its later quality signals (read model). */
export interface OutcomeRow {
  readonly jobId: string;
  readonly project: string;
  readonly runtime: string;
  readonly model: string;
  readonly kind: string | null;
  readonly area: string | null;
  readonly signals: OutcomeSignals;
  readonly ageDays: number;
  readonly durationSec: number | null;
  readonly costUsd: number | null;
  readonly endedAt: Date;
}

interface RawOutcome {
  job_id: string;
  project: string;
  runtime: string;
  model: string;
  kind: string | null;
  area: string | null;
  succeeded: boolean;
  duration_sec: number | null;
  cost: number | null;
  ended_at: Date;
  verification: string | null;
  overridden: boolean;
  git_verification: string | null;
  ci_state: string | null;
  merged: boolean;
  merge_status: string | null;
  rating: number | null;
  rerun: boolean;
}

/** How far back outcomes are read (older ones have decayed to almost nothing anyway). */
export const OUTCOME_LOOKBACK_DAYS = 365;
const MAX_ROWS = 20_000;

/** Pure: the quality signals of one raw row. */
export function signalsOf(
  r: Omit<
    RawOutcome,
    'job_id' | 'project' | 'runtime' | 'model' | 'kind' | 'area' | 'duration_sec' | 'cost' | 'ended_at'
  >,
): OutcomeSignals {
  const verification =
    r.verification === 'failed'
      ? r.overridden
        ? 'overridden'
        : 'failed'
      : r.verification === 'passed' || r.verification === 'warned'
        ? r.verification
        : null;
  const merge =
    r.merged || r.merge_status === 'merged'
      ? 'merged'
      : r.merge_status === 'discarded' || r.merge_status === 'denied' || r.merge_status === 'refused'
        ? 'rejected'
        : null;
  return {
    succeeded: r.succeeded,
    verification,
    gitVerification:
      r.git_verification === 'passed' || r.git_verification === 'failed' ? r.git_verification : null,
    ci:
      r.ci_state === 'success' || r.ci_state === 'failure' || r.ci_state === 'timed_out' ? r.ci_state : null,
    merge,
    rerun: r.rerun,
    rating: r.rating === 1 ? 1 : r.rating === -1 ? -1 : null,
  };
}

/**
 * Finished-job outcomes with their signals: of one project (null = all projects), optionally one area (null =
 * every area; `unclassified` = rows without one) or one job. `rerunWindowDays`: the same prompt submitted again in the
 * same project within that many days marks a job as corrected.
 */
export async function loadOutcomes(
  db: Queryable,
  q: {
    readonly project: string | null;
    readonly projects?: readonly string[] | null;
    /** An area, `unclassified` (rows without one) or null / absent (every area). */
    readonly area?: string | null;
    readonly jobId?: string;
    readonly rerunWindowDays: number;
    readonly now: Date;
  },
): Promise<OutcomeRow[]> {
  const since = new Date(q.now.getTime() - OUTCOME_LOOKBACK_DAYS * 86_400_000);
  const { rows } = await db.query<RawOutcome>(
    `SELECT o.job_id, o.project, o.runtime, o.model, o.kind, o.area, o.succeeded, o.duration_sec,
            o.cost_usd::float8 AS cost, o.ended_at,
            v.state AS verification, (v.override_by IS NOT NULL) AS overridden,
            g.verification AS git_verification, g.ci_state, (g.merged_at IS NOT NULL) AS merged,
            (SELECT m.status FROM git_merge_requests m WHERE m.job_id = o.job_id
              ORDER BY m.created_at DESC LIMIT 1) AS merge_status,
            r.rating,
            ($6::int > 0 AND o.prompt_digest IS NOT NULL AND EXISTS (
               SELECT 1 FROM jobs j2 WHERE j2.project = o.project AND j2.prompt_digest = o.prompt_digest
                  AND j2.id <> o.job_id AND j2.created_at > o.ended_at
                  AND j2.created_at <= o.ended_at + make_interval(days => $6::int))) AS rerun
       FROM job_outcomes o
       LEFT JOIN job_verifications v ON v.job_id = o.job_id
       LEFT JOIN job_git g ON g.job_id = o.job_id
       LEFT JOIN job_ratings r ON r.job_id = o.job_id
      WHERE o.ended_at >= $1
        AND ($2::text IS NULL OR o.project = $2)
        AND ($3::text[] IS NULL OR o.project = ANY($3))
        AND ($4::text IS NULL OR ($4 = 'unclassified' AND o.area IS NULL) OR o.area = $4)
        AND ($5::uuid IS NULL OR o.job_id = $5)
      ORDER BY o.ended_at DESC
      LIMIT ${String(MAX_ROWS)}`,
    [
      since,
      q.project,
      q.projects == null ? null : [...q.projects],
      q.area ?? null,
      q.jobId ?? null,
      q.rerunWindowDays,
    ],
  );
  return rows.map((r) => ({
    jobId: r.job_id,
    project: r.project,
    runtime: r.runtime,
    model: r.model,
    kind: r.kind,
    area: r.area,
    signals: signalsOf(r),
    ageDays: Math.max(0, (q.now.getTime() - r.ended_at.getTime()) / 86_400_000),
    durationSec: r.duration_sec === null ? null : Math.round(r.duration_sec),
    costUsd: r.cost,
    endedAt: r.ended_at,
  }));
}

export function toSample(r: OutcomeRow): OutcomeSample {
  return {
    runtime: r.runtime,
    model: r.model,
    area: r.area,
    good: judgeOutcome(r.signals).good,
    ageDays: r.ageDays,
    durationSec: r.durationSec,
    costUsd: r.costUsd,
  };
}

/**
 * Back-fill: classifies outcome rows written by the migration from history (prompt + the paths the result changed +
 * sub-job paths + template / automation). Bounded per call; returns how many rows it classified.
 */
export async function backfillClassifications(db: Queryable, now: Date, limit = 500): Promise<number> {
  const { rows } = await db.query<{ job_id: string; project: string; spec: JobSpec; has: boolean }>(
    `SELECT o.job_id, o.project, j.spec, (c.job_id IS NOT NULL AND c.stage = 'final') AS has
       FROM job_outcomes o JOIN jobs j ON j.id = o.job_id
       LEFT JOIN job_classifications c ON c.job_id = o.job_id
      WHERE NOT o.classified ORDER BY o.ended_at DESC LIMIT $1`,
    [limit],
  );
  for (const r of rows) {
    const c = await classifyFinal(db, r.job_id, r.project, r.spec, r.has ? 'final' : 'backfill', now);
    await db.query('UPDATE job_outcomes SET kind = $2, area = $3, classified = true WHERE job_id = $1', [
      r.job_id,
      c.kind,
      c.area,
    ]);
  }
  return rows.length;
}
