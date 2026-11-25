import { randomInt } from 'node:crypto';
import {
  classifyJob,
  effectiveRoutingRule,
  JOB_AREAS,
  type JobArea,
  type JobClassification,
  RuntimeAdviceSettings,
  RuntimeKind,
  type SandboxProfile,
} from '@remyral/protocol';
import {
  adviseRuntime,
  aggregateByRuntime,
  aggregateCell,
  type AutoCandidate,
  type AutoDecision,
  chooseAutoRuntime,
  judgeOutcome,
  type OutcomeCell,
  type OutcomeJudgement,
  priorOf,
  type RuntimeAdvice,
} from '@remyral/scheduler';
import type { AuditRecorder } from '../audit/audit.js';
import { previewPlacement, type PreviewDeps, type PreviewDraft } from '../composer/preview.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { resolveJobModel } from '../models/job-model.js';
import { loadRoutingRules } from '../routing/rules.js';
import {
  backfillClassifications,
  loadAdviceSettings,
  loadOutcomes,
  type OutcomeRow,
  saveAdviceSettings,
  toSample,
} from './store.js';

/**
 * p11-runtime-advice (docs/design/p11-runtime-advice.md §4–6, ADR-0044): advice ("Claude Code does 91% good outcomes
 * on this project's frontend jobs"), auto routing for jobs submitted with runtime "auto" (per project opt-in), the
 * runtime × area insights matrix, ratings and the per-project settings. Advice never changes a job; auto mode only
 * acts on an explicit "auto" and never overrides an explicit runtime.
 */

export class RuntimeAdviceError extends HttpError {}

export interface AdviceDraft {
  readonly prompt?: string | undefined;
  readonly role?: string | undefined;
  readonly area?: string | undefined;
  readonly paths?: readonly string[] | undefined;
  readonly templateName?: string | undefined;
}

export interface AdviceView {
  readonly mode: RuntimeAdviceSettings['mode'];
  readonly classification: JobClassification;
  /** null when advice is off for the project. */
  readonly advice: RuntimeAdvice | null;
}

export interface AutoResolution {
  readonly runtime: RuntimeKind;
  readonly decision: AutoDecision;
  readonly classification: JobClassification;
}

export interface MatrixCell {
  readonly area: JobArea | null;
  readonly runtime: string;
  readonly n: number;
  readonly rate: number;
  readonly low: number;
  readonly high: number;
  readonly rawRate: number | null;
  readonly medianDurationSec: number | null;
  readonly meanCostUsd: number | null;
  readonly recent: { readonly n: number; readonly rate: number | null };
  readonly previous: { readonly n: number; readonly rate: number | null };
  readonly models: readonly { readonly model: string; readonly n: number; readonly good: number }[];
}

export interface OutcomeMatrix {
  readonly project: string;
  readonly settings: RuntimeAdviceSettings;
  readonly runtimes: readonly string[];
  readonly areas: readonly (JobArea | null)[];
  readonly cells: readonly MatrixCell[];
  readonly advice: readonly {
    readonly area: JobArea | null;
    readonly recommended: string | null;
    readonly text: string;
  }[];
  readonly jobs: number;
}

export interface JobOutcomeView {
  readonly classification: {
    readonly kind: string | null;
    readonly kindSource: string | null;
    readonly area: string | null;
    readonly areaSource: string | null;
    readonly signals: unknown;
    readonly stage: string;
  } | null;
  readonly decision: {
    readonly runtime: string;
    readonly how: string;
    readonly reasons: readonly string[];
    readonly considered: unknown;
    readonly decidedAt: string;
  } | null;
  readonly rating: { readonly value: 1 | -1; readonly at: string } | null;
  readonly outcome: (OutcomeJudgement & { readonly runtime: string; readonly model: string }) | null;
}

export interface RuntimeAdviceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock?: () => Date;
  /** Placement preview facts (machine availability, quota holds) for auto mode; absent = no machine check. */
  readonly preview?: () => PreviewDeps;
  /** Exploration draw in [0, 1) (tests inject a fixed sequence). */
  readonly random?: () => number;
}

const scopeLabel = (area: JobArea | null): string =>
  area === null ? "this project's jobs" : `this project's ${area} jobs`;

export class RuntimeAdviceService {
  private readonly clock: () => Date;
  private readonly random: () => number;

  constructor(private readonly deps: RuntimeAdviceDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.random = deps.random ?? (() => randomInt(0, 1_000_000) / 1_000_000);
  }

  get pool(): Pool {
    return this.deps.pool;
  }

  settings(project: string, db: Queryable = this.deps.pool): Promise<RuntimeAdviceSettings> {
    return loadAdviceSettings(db, project);
  }

  /** Validates and stores a project's settings (project admin + step-up at the route); audited with before / after. */
  async saveSettings(
    project: string,
    input: unknown,
    actor: { readonly userId: string; readonly ip: string | null; readonly userAgent: string | null },
  ): Promise<RuntimeAdviceSettings> {
    const parsed = RuntimeAdviceSettings.safeParse(input);
    if (!parsed.success) {
      throw new RuntimeAdviceError(
        400,
        'runtime_advice_invalid',
        `Invalid settings: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}:${i.code}`).join(', ')}`.slice(
          0,
          1000,
        ),
      );
    }
    const exists = await this.deps.pool.query('SELECT 1 FROM projects WHERE id = $1', [project]);
    if ((exists.rowCount ?? 0) === 0)
      throw new RuntimeAdviceError(404, 'project_not_found', 'Project not found.');
    const now = this.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const before = await loadAdviceSettings(tx, project);
      await saveAdviceSettings(tx, project, parsed.data, actor.userId, now);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'project.runtime_advice.update',
          target: `project:${project}`,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { before, after: parsed.data },
        },
        tx,
      );
    });
    return parsed.data;
  }

  /** Per-runtime cells of a scope (this project × area, prior = the same area across the fleet). */
  async #cells(
    project: string,
    area: JobArea | null,
    s: RuntimeAdviceSettings,
    runtimes: readonly string[] = RuntimeKind.options,
  ): Promise<OutcomeCell[]> {
    const now = this.clock();
    const fleet = await loadOutcomes(this.deps.pool, {
      project: null,
      area,
      rerunWindowDays: s.rerunWindowDays,
      now,
    });
    const local = fleet.filter((r) => r.project === project);
    const keep = new Set(runtimes);
    const cells = aggregateByRuntime(
      local.filter((r) => keep.has(r.runtime)).map(toSample),
      fleet.filter((r) => keep.has(r.runtime)).map(toSample),
      s.halfLifeDays,
    );
    return cells;
  }

  /** Advice for a draft (composer, chat draft card, sub-job request). Never changes anything. */
  async advise(project: string, draft: AdviceDraft): Promise<AdviceView> {
    const s = await this.settings(project);
    const classification = classifyJob({
      prompt: draft.prompt,
      role: draft.role,
      area: draft.area,
      pathHints: draft.paths,
      templateName: draft.templateName,
      projectRules: s.areaRules,
    });
    if (s.mode === 'off') return { mode: s.mode, classification, advice: null };
    const cells = await this.#cells(project, classification.area, s);
    return {
      mode: s.mode,
      classification,
      advice: adviseRuntime({ cells, minSamples: s.minSamples, scope: scopeLabel(classification.area) }),
    };
  }

  /**
   * Auto mode: the runtime for a job submitted with runtime "auto" — only when the project opted in; constrained by
   * the allowed runtimes, the paid policy, open usage limits, quota holds and machine availability; bounded
   * exploration never for production deploy jobs. Throws (400) when auto mode is off or nothing can run.
   */
  async resolveAuto(
    project: string,
    spec: Record<string, unknown>,
    opts: {
      readonly allowExploration: boolean;
      readonly restrictTo?: readonly RuntimeKind[];
      /** Sub-job `paths` (classification hints). */
      readonly pathHints?: readonly string[];
    },
  ): Promise<AutoResolution> {
    const s = await this.settings(project);
    if (s.mode !== 'auto') {
      throw new RuntimeAdviceError(
        400,
        'runtime_auto_not_enabled',
        `Runtime "auto" is not enabled for project ${project}; choose a runtime or ask an admin to turn on auto mode (Projects → ${project} → Policy → Runtime advice).`,
      );
    }
    const str = (k: string): string | undefined => (typeof spec[k] === 'string' ? spec[k] : undefined);
    const classification = classifyJob({
      prompt: str('prompt'),
      role: str('role'),
      area: str('area'),
      pathHints: opts.pathHints,
      projectRules: s.areaRules,
    });
    const allowed = (s.allowedRuntimes.length === 0 ? RuntimeKind.options : s.allowedRuntimes).filter(
      (r) => opts.restrictTo === undefined || opts.restrictTo.includes(r),
    );
    const cells = await this.#cells(project, classification.area, s);
    const now = this.clock();
    const limited = await this.deps.pool.query<{ runtime: string; resume_at: Date }>(
      `SELECT runtime, min(resume_at) AS resume_at FROM usage_limit_episodes
        WHERE ended_at IS NULL AND resume_at > $1 AND pause_scope IN ('account', 'credential')
        GROUP BY runtime`,
      [now],
    );
    const availability = await this.#availability(project, spec, classification);
    const candidates: AutoCandidate[] = [];
    for (const runtime of RuntimeKind.options) {
      const cell = cells.find((c) => c.runtime === runtime) ?? null;
      let excluded: string | null = null;
      if (!allowed.includes(runtime)) excluded = 'not allowed for auto mode in this project';
      else if (!s.allowPaid) {
        const m = await resolveJobModel(this.deps.pool, project, runtime, undefined, classification.kind);
        if (m.modelProfile?.credentialRef !== undefined)
          excluded = 'its model bills per token (paid runtimes not allowed)';
      }
      if (excluded === null) {
        const lim = limited.rows.find((r) => r.runtime === runtime);
        if (lim !== undefined) excluded = `at its usage limit until ${lim.resume_at.toISOString()}`;
      }
      if (excluded === null && availability !== null) {
        const a = availability.get(runtime);
        if (a !== undefined && a.held !== null) excluded = `held: ${a.held}`;
        else if (a !== undefined && !a.runnable) excluded = 'no machine can run it';
      }
      candidates.push({ runtime, cell, excluded });
    }
    const rule = effectiveRoutingRule(
      await loadRoutingRules(this.deps.pool, project),
      project,
      classification.kind,
    );
    const decision = chooseAutoRuntime({
      candidates,
      minSamples: s.minSamples,
      explorationShare: s.explorationPct / 100,
      allowExploration: opts.allowExploration,
      random: this.random,
      fallbackOrder: rule?.runtimes ?? [],
    });
    const picked = RuntimeKind.safeParse(decision.runtime);
    if (!picked.success) {
      throw new RuntimeAdviceError(
        400,
        'runtime_auto_unavailable',
        `Auto mode found no runtime that can run this job now: ${decision.reasons.join('; ')}`.slice(0, 1000),
      );
    }
    return { runtime: picked.data, decision, classification };
  }

  /** Machine availability and quota holds per runtime from the placement preview (null: no preview deps). */
  async #availability(
    project: string,
    spec: Record<string, unknown>,
    c: JobClassification,
  ): Promise<Map<string, { runnable: boolean; held: string | null }> | null> {
    const deps = this.deps.preview?.();
    if (deps === undefined) return null;
    const draft: PreviewDraft = {
      project,
      sandboxProfile: (typeof spec.sandboxProfile === 'string' ? spec.sandboxProfile : undefined) as
        SandboxProfile | undefined,
      sourceTrust: spec.sourceTrust === 'trusted' ? 'trusted' : 'untrusted',
      ...(c.kind === null ? {} : { role: c.kind }),
      ...(typeof spec.requirements === 'object' && spec.requirements !== null
        ? { requirements: spec.requirements }
        : {}),
    };
    const preview = await previewPlacement(deps, draft);
    const out = new Map<string, { runnable: boolean; held: string | null }>();
    for (const r of preview.runtimes) {
      const q = await deps.quotas(project, r.runtime);
      out.set(r.runtime, {
        runnable: r.feasible.length > 0,
        held: q.holds.length === 0 ? null : (q.holds[0]?.message ?? 'quota hold').slice(0, 200),
      });
    }
    return out;
  }

  /** Records an auto decision with the job (inside the job's creation transaction). */
  async recordDecision(tx: Queryable, jobId: string, project: string, r: AutoResolution): Promise<void> {
    if (r.decision.how === 'none') return;
    await tx.query(
      `INSERT INTO job_runtime_decisions (job_id, project, runtime, how, area, kind, reasons, considered, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (job_id) DO NOTHING`,
      [
        jobId,
        project,
        r.runtime,
        r.decision.how,
        r.classification.area,
        r.classification.kind,
        JSON.stringify(r.decision.reasons.slice(0, 12).map((x) => x.slice(0, 400))),
        JSON.stringify(r.decision.considered.slice(0, 8)),
        this.clock(),
      ],
    );
  }

  /** Usage → Outcomes: runtime × area for one project (smoothed towards the fleet, with trend and models). */
  async matrix(project: string): Promise<OutcomeMatrix> {
    const s = await this.settings(project);
    const now = this.clock();
    const fleet = await loadOutcomes(this.deps.pool, {
      project: null,
      rerunWindowDays: s.rerunWindowDays,
      now,
    });
    const local = fleet.filter((r) => r.project === project);
    const runtimes = [...new Set(local.map((r) => r.runtime))].sort();
    const areas: (JobArea | null)[] = [...JOB_AREAS, null];
    const cells: MatrixCell[] = [];
    const advice: OutcomeMatrix['advice'][number][] = [];
    for (const area of areas) {
      const inArea = (r: OutcomeRow) => r.area === area;
      const areaCells: OutcomeCell[] = [];
      for (const runtime of runtimes) {
        const mine = local.filter((r) => inArea(r) && r.runtime === runtime);
        if (mine.length === 0) continue;
        const prior = priorOf(
          fleet.filter((r) => inArea(r) && r.runtime === runtime).map(toSample),
          s.halfLifeDays,
        );
        const cell = aggregateCell(runtime, mine.map(toSample), { halfLifeDays: s.halfLifeDays, prior });
        areaCells.push(cell);
        const models = new Map<string, { n: number; good: number }>();
        for (const r of mine) {
          const m = models.get(r.model) ?? { n: 0, good: 0 };
          m.n += 1;
          if (judgeOutcome(r.signals).good) m.good += 1;
          models.set(r.model, m);
        }
        cells.push({
          area,
          runtime,
          n: cell.n,
          rate: cell.rate,
          low: cell.low,
          high: cell.high,
          rawRate: cell.rawRate,
          medianDurationSec: cell.medianDurationSec,
          meanCostUsd: cell.meanCostUsd,
          recent: cell.recent,
          previous: cell.previous,
          models: [...models.entries()]
            .map(([model, v]) => ({ model, ...v }))
            .sort((a, b) => b.n - a.n || a.model.localeCompare(b.model)),
        });
      }
      if (areaCells.length > 0) {
        const a = adviseRuntime({ cells: areaCells, minSamples: s.minSamples, scope: scopeLabel(area) });
        advice.push({ area, recommended: a.recommended, text: a.text });
      }
    }
    return { project, settings: s, runtimes, areas, cells, advice, jobs: local.length };
  }

  /** A 👍 / 👎 (or null to clear) on a finished job; audited. */
  async rate(
    jobId: string,
    rating: 1 | -1 | null,
    actor: { readonly userId: string; readonly ip: string | null; readonly userAgent: string | null },
  ): Promise<void> {
    const job = await this.deps.pool.query<{ state: string; project: string }>(
      'SELECT state, project FROM jobs WHERE id = $1',
      [jobId],
    );
    const j = job.rows[0];
    if (j === undefined) throw new RuntimeAdviceError(404, 'job_not_found', 'Job not found.');
    if (j.state !== 'SUCCEEDED' && j.state !== 'FAILED') {
      throw new RuntimeAdviceError(
        409,
        'job_not_finished',
        'Only a finished job (succeeded or failed) can be rated.',
      );
    }
    const now = this.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      if (rating === null) await tx.query('DELETE FROM job_ratings WHERE job_id = $1', [jobId]);
      else {
        await tx.query(
          `INSERT INTO job_ratings (job_id, rating, rated_by, rated_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (job_id) DO UPDATE SET rating = EXCLUDED.rating, rated_by = EXCLUDED.rated_by,
                                              rated_at = EXCLUDED.rated_at`,
          [jobId, rating, actor.userId, now],
        );
      }
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'job.rating.set',
          target: `job:${jobId}`,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { project: j.project, rating },
        },
        tx,
      );
    });
  }

  /** The job page: classification (and its signals), the auto decision, the rating, the outcome judgement. */
  async jobView(jobId: string): Promise<JobOutcomeView> {
    const db = this.deps.pool;
    const c = await db.query<{
      kind: string | null;
      kind_source: string | null;
      area: string | null;
      area_source: string | null;
      signals: unknown;
      stage: string;
      project: string;
    }>(
      'SELECT kind, kind_source, area, area_source, signals, stage, project FROM job_classifications WHERE job_id = $1',
      [jobId],
    );
    const d = await db.query<{
      runtime: string;
      how: string;
      reasons: string[];
      considered: unknown;
      decided_at: Date;
    }>('SELECT runtime, how, reasons, considered, decided_at FROM job_runtime_decisions WHERE job_id = $1', [
      jobId,
    ]);
    const r = await db.query<{ rating: number; rated_at: Date }>(
      'SELECT rating, rated_at FROM job_ratings WHERE job_id = $1',
      [jobId],
    );
    const cl = c.rows[0];
    const project = cl?.project ?? null;
    let outcome: JobOutcomeView['outcome'] = null;
    if (project !== null) {
      const s = await this.settings(project);
      const rows = await loadOutcomes(db, {
        project,
        jobId,
        rerunWindowDays: s.rerunWindowDays,
        now: this.clock(),
      });
      const o = rows[0];
      if (o !== undefined) outcome = { ...judgeOutcome(o.signals), runtime: o.runtime, model: o.model };
    }
    const dr = d.rows[0];
    const rr = r.rows[0];
    return {
      classification:
        cl === undefined
          ? null
          : {
              kind: cl.kind,
              kindSource: cl.kind_source,
              area: cl.area,
              areaSource: cl.area_source,
              signals: cl.signals,
              stage: cl.stage,
            },
      decision:
        dr === undefined
          ? null
          : {
              runtime: dr.runtime,
              how: dr.how,
              reasons: dr.reasons,
              considered: dr.considered,
              decidedAt: dr.decided_at.toISOString(),
            },
      rating: rr === undefined ? null : { value: rr.rating === 1 ? 1 : -1, at: rr.rated_at.toISOString() },
      outcome,
    };
  }

  /** Classifies back-filled history in bounded batches (called at start and by the maintenance tick). */
  async backfill(maxBatches = 20): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const n = await backfillClassifications(this.deps.pool, this.clock());
      total += n;
      if (n === 0) break;
    }
    return total;
  }
}
