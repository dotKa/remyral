import { jobRoleOf, RuntimeKind } from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';
import { resolveJobModel } from '../models/job-model.js';
import { loadWorkspaceEgress, projectKind } from '../workspaces/service.js';
import { ageText, type InputFingerprint, inputsDigest, isDigest, promptDigest } from './digest.js';

/**
 * p6-result-reuse (docs/design/p6-result-reuse.md): before a job is dispatched, find a recent SUCCEEDED job that did
 * exactly the same work — same project, runtime (the one it actually ran with), model profile and normalised prompt;
 * for repository jobs the same repository URL and resolved base commit, for workspace jobs the same input files and
 * egress. Read-only: nothing is written here. Callers decide what to do with a match and must never act on it
 * silently (composer and chat offer it, automations / workflow steps only with an opt-in policy, recorded on the run).
 *
 * Never for untrusted sources (ADR-0010): a draft whose source is not `trusted` is not looked up, and only trusted
 * jobs are ever matched. Never across projects (a match is in the draft's own project, and callers check that the
 * person may read it). Jobs with upstream dependencies, machine-admin jobs, pull request checkouts and site-bundle
 * builds are never candidates (their result depends on more than the spec).
 */

/** The composer / chat offer looks this far back by default. */
export const REUSE_OFFER_WINDOW_HOURS = 72;
/** Automation and workflow-step policies: 1–168 hours. */
export const REUSE_POLICY_MAX_HOURS = 168;

export type ReuseNoMatchReason =
  /** The draft's source is not trusted (fail closed: absent = untrusted). */
  | 'untrusted_source'
  /** Machine-admin job, pull request head, site bundle, or a spec the master would refuse. */
  | 'not_eligible'
  /** Repository job whose base commit cannot be resolved now (no git provider, other repository, non-target ref). */
  | 'base_unknown'
  | 'no_match';

export interface ReuseMatch {
  readonly kind: 'match';
  readonly jobId: string;
  readonly finishedAt: Date;
  readonly ageMs: number;
  /** "2 h ago". */
  readonly age: string;
  readonly runtime: string;
  readonly modelProfile: string | null;
  /** Repository jobs: the base commit both start from. */
  readonly baseCommit: string | null;
}

export type ReuseVerdict = ReuseMatch | { readonly kind: 'none'; readonly reason: ReuseNoMatchReason };

export interface ReuseQuery {
  readonly project: string;
  /** The job as it would be submitted (before the master fills model profile / workspace); unvalidated. */
  readonly spec: unknown;
  /** Workspace jobs: the input files the job would get (uploads and continued artifacts); [] = none. */
  readonly inputs?: readonly InputFingerprint[];
  readonly withinHours: number;
  /** Internal callers (workflow steps): the prompt digest to match instead of the digest of `spec.prompt`. */
  readonly promptDigest?: string;
  /** Jobs that never count as a match (e.g. the caller's own job). */
  readonly excludeJobIds?: readonly string[];
}

export interface ResultReuseDeps {
  readonly db: Queryable;
  readonly clock: () => Date;
  /** GitFlowService.resolveBaseCommit; absent / null = repository jobs are never matched. */
  readonly baseCommit?: (
    project: string,
    repository: { readonly url: string; readonly baseRef: string },
  ) => Promise<string | null>;
}

interface MatchRow {
  id: string;
  finished_at: Date;
  runtime: string;
  model_profile: string | null;
}

function fieldsOf(spec: unknown): Record<string, unknown> | null {
  return typeof spec === 'object' && spec !== null && !Array.isArray(spec)
    ? (spec as Record<string, unknown>)
    : null;
}

export class ResultReuseService {
  constructor(private readonly deps: ResultReuseDeps) {}

  async find(q: ReuseQuery): Promise<ReuseVerdict> {
    const s = fieldsOf(q.spec);
    if (s === null) return { kind: 'none', reason: 'not_eligible' };
    if (s.sourceTrust !== 'trusted') return { kind: 'none', reason: 'untrusted_source' };
    const runtime = RuntimeKind.safeParse(s.runtime);
    if (!runtime.success || typeof s.prompt !== 'string' || s.prompt.trim() === '') {
      return { kind: 'none', reason: 'not_eligible' };
    }
    if (s.kind !== undefined || s.siteBundle !== undefined || s.machineAdmin !== undefined) {
      return { kind: 'none', reason: 'not_eligible' };
    }
    const repo = fieldsOf(s.repository);
    if (repo !== null && repo.pullRequest !== undefined) return { kind: 'none', reason: 'untrusted_source' };
    const hours = Math.min(Math.max(Math.trunc(q.withinHours), 1), REUSE_POLICY_MAX_HOURS);
    const now = this.deps.clock();
    const since = new Date(now.getTime() - hours * 3_600_000);

    const kind = await projectKind(this.deps.db, q.project);
    if (kind === null) return { kind: 'none', reason: 'not_eligible' };
    const model = typeof s.model === 'string' && s.model !== '' ? s.model : undefined;
    const role = jobRoleOf({
      ...(typeof s.role === 'string' ? { role: s.role } : {}),
      prompt: s.prompt,
    });
    // The profile the master would resolve at submission (named, else routing rule / project / global default).
    const resolved = await resolveJobModel(this.deps.db, q.project, runtime.data, model, role.role);
    const profileId = resolved.modelProfile?.id ?? null;
    const profileModel = resolved.modelProfile?.model ?? resolved.model ?? null;
    const digest =
      q.promptDigest !== undefined && isDigest(q.promptDigest) ? q.promptDigest : promptDigest(s.prompt);

    const params: unknown[] = [
      q.project,
      digest,
      since,
      runtime.data,
      profileId,
      profileModel,
      q.excludeJobIds ?? [],
    ];
    let scope: string;
    let baseCommit: string | null = null;
    if (kind === 'workspace') {
      if (repo !== null) return { kind: 'none', reason: 'not_eligible' };
      const egress = (await loadWorkspaceEgress(this.deps.db, q.project)) ?? {
        egress: 'none',
        allowHosts: [],
      };
      params.push(inputsDigest(q.inputs ?? []), egress.egress, JSON.stringify(egress.allowHosts));
      scope = `j.spec->'workspace' IS NOT NULL AND j.inputs_digest = $8
           AND j.spec->'workspace'->>'egress' = $9
           AND COALESCE(j.spec->'workspace'->'allowHosts', '[]'::jsonb) = $10::jsonb`;
    } else {
      if (repo === null || typeof repo.url !== 'string' || typeof repo.baseRef !== 'string') {
        return { kind: 'none', reason: 'not_eligible' };
      }
      if ((q.inputs ?? []).length > 0) return { kind: 'none', reason: 'not_eligible' };
      baseCommit =
        (await this.deps.baseCommit?.(q.project, { url: repo.url, baseRef: repo.baseRef })) ?? null;
      if (baseCommit === null) return { kind: 'none', reason: 'base_unknown' };
      params.push(repo.url, baseCommit, repo.baseRef);
      // The earlier job checked out the same ref (or that very commit) and its recorded base is this commit; a job
      // with input files (p19-repo-job-inputs) is never offered.
      scope = `j.spec->'repository'->>'url' = $8 AND g.base_sha = $9
           AND j.spec->'repository'->>'baseRef' IN ($10, $9)
           AND j.spec->'repository'->'pullRequest' IS NULL
           AND j.spec->'repository'->'inputs' IS NULL`;
    }
    const { rows } = await this.deps.db.query<MatchRow>(
      `SELECT j.id, j.state_changed_at AS finished_at, j.spec->>'runtime' AS runtime,
              j.spec->'modelProfile'->>'id' AS model_profile
         FROM jobs j
         LEFT JOIN job_runs r ON r.attempt_id = j.current_attempt_id
         LEFT JOIN job_git g ON g.job_id = j.id
        WHERE j.project = $1 AND j.state = 'SUCCEEDED' AND j.prompt_digest = $2 AND j.state_changed_at >= $3
          AND j.spec->>'runtime' = $4
          -- it ran with its own runtime (not a fallback), so the runtime and model are what it declared
          AND (r.runtime_choice IS NULL OR (r.runtime_choice->>'index')::int = 0)
          AND j.spec->'modelProfile'->>'id' IS NOT DISTINCT FROM $5
          AND COALESCE(j.spec->'modelProfile'->>'model', j.spec->>'model') IS NOT DISTINCT FROM $6
          AND j.spec->>'sourceTrust' = 'trusted'
          AND j.spec->'kind' IS NULL AND j.spec->'siteBundle' IS NULL
          AND NOT (j.id = ANY($7::uuid[]))
          AND NOT EXISTS (SELECT 1 FROM job_dependencies d WHERE d.job_id = j.id)
          AND ${scope}
        ORDER BY j.state_changed_at DESC, j.id
        LIMIT 1`,
      params,
    );
    const m = rows[0];
    if (m === undefined) return { kind: 'none', reason: 'no_match' };
    const ageMs = Math.max(0, now.getTime() - m.finished_at.getTime());
    return {
      kind: 'match',
      jobId: m.id,
      finishedAt: m.finished_at,
      ageMs,
      age: ageText(ageMs),
      runtime: m.runtime,
      modelProfile: m.model_profile,
      baseCommit,
    };
  }
}
