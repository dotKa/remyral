import {
  isRetiredRuntime,
  type RuntimeKind,
  satisfiedToolNames,
  ToolInventoryReport,
} from '@remyral/protocol';
import { loadSubject } from '../authz/authorizer.js';
import { authorize, type Role } from '../authz/model.js';
import type { Pool, Queryable } from '../db/pool.js';
import type { JobStore } from '../jobs/store.js';
import type { PreparedInput } from '../workspaces/service.js';
import { type ChecklistInput, REPO_REPORT_BUNDLE_DIR, verifierPrompt } from './checklist.js';
import { LIMITS } from './model.js';
import { markReportOnly, platformJobTitle, type ReportOnlyPurpose } from './report-only.js';

/**
 * p10-verify-health: creates the verifier (or post-deploy screenshot) job — an ordinary job of the same project, created
 * as the person who started the verified job / requested the deploy, re-authorised (`jobs.create`) at this moment. Its
 * spec is built by the master: the checklist prompt, the parent's sandbox profile, approval policy and source trust, no
 * secret references, no deploy, no previews, a capped time limit, `role: verify`, `requirements.tools: [browser]` when a
 * machine reports a browser, and (repository) the job's pushed branch checked out on a `verify/…` work branch with the
 * report folder returned as a site bundle. A verifier never gets a verification of its own (no row is created for it).
 *
 * p11-fixes-a: every such job is a **report-only** job (`report_only_jobs`, written in its creation transaction): git
 * flow skips it, so it never commits, pushes or waits for a merge approval — its report is an artifact, not a commit.
 */

/**
 * A platform report job that already went through git flow (created before report-only jobs existed) and now waits
 * for a merge decision: its run is done and its report is read; the pointless gate is closed (cancelled by the
 * system — the verification branch is never merged). Best effort: a concurrent change is left alone.
 */
export async function closeReportJobGate(
  jobs: Pick<JobStore, 'get' | 'transition'>,
  jobId: string,
  reason: string,
): Promise<void> {
  try {
    const job = await jobs.get(jobId);
    if (job?.state !== 'AWAITING_APPROVAL') return;
    await jobs.transition(jobId, 'cancel_requested', {
      actor: { type: 'system', id: 'verification' },
      reason,
      expectedVersion: job.version,
    });
  } catch {
    // Another actor moved it first; nothing to close.
  }
}

export class VerifierRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Whether a user is active and may create jobs in `project` now. */
export async function mayCreateJobs(pool: Pool, userId: string, project: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: string; role: Role; disabled_at: Date | null }>(
    'SELECT id::text AS id, role, disabled_at FROM users WHERE id::text = $1',
    [userId],
  );
  const u = rows[0];
  if (u === undefined || u.disabled_at !== null) return false;
  const subject = await loadSubject(pool, { id: u.id, role: u.role });
  return authorize(subject, 'jobs.create', { project }).allow;
}

/** Whether any approved, non-archived machine reports a browser (managed Playwright Chromium or a system browser). */
export async function browserAvailable(pool: Queryable): Promise<boolean> {
  const { rows } = await pool.query<{ tools: { name?: unknown }[] | null; tool_inventory: unknown }>(
    `SELECT tools, tool_inventory FROM workers WHERE state <> 'pending' AND archived_at IS NULL`,
  );
  for (const r of rows) {
    const inv = ToolInventoryReport.safeParse(r.tool_inventory);
    const names = inv.success
      ? satisfiedToolNames(inv.data)
      : Array.isArray(r.tools)
        ? r.tools.flatMap((t) => (typeof t.name === 'string' ? [t.name] : []))
        : [];
    if (names.includes('browser')) return true;
  }
  return false;
}

export interface VerifierJobInput {
  readonly project: string;
  readonly creator: string;
  /** The verified job's stored spec (repository URL, sandbox, approval policy, trust, limits) — or a base spec. */
  readonly parentSpec: Record<string, unknown>;
  readonly runtime: RuntimeKind;
  readonly priority: number;
  readonly checklist: ChecklistInput;
  /** Repository verifier: the branch to check out (the verified job's pushed branch). */
  readonly checkoutRef?: string;
  readonly workBranch?: string;
  readonly inputs?: readonly PreparedInput[];
  /** Report-only marker purpose (default `verify`). */
  readonly purpose?: ReportOnlyPurpose;
  /**
   * p19-verifier-jobs: what the report job checks, for its readable title ("Doğrula: <title>") — the checked job's
   * title, the deploy's address. Absent: the purpose's name alone.
   */
  readonly subject?: string | null;
  /** p19-verifier-jobs: the job this report job checks (`report_only_jobs.checked_job_id`; none for a deploy check). */
  readonly checkedJobId?: string | null;
  /** Extra rows in the creation transaction (e.g. linking the verification to this job before it can dispatch). */
  readonly withinCreate?: (tx: Queryable, jobId: string) => Promise<void>;
}

/** The verifier's spec (pure). */
export function verifierSpec(i: VerifierJobInput): Record<string, unknown> {
  const p = i.parentSpec;
  const limits = (p.limits ?? {}) as { maxDurationSec?: unknown; maxTokens?: unknown };
  const parentMax =
    typeof limits.maxDurationSec === 'number' ? limits.maxDurationSec : LIMITS.verifierMaxDurationSec;
  const repo = p.repository as { url?: unknown } | undefined;
  const spec: Record<string, unknown> = {
    runtime: i.runtime,
    ...(i.runtime === p.runtime && typeof p.model === 'string' ? { model: p.model } : {}),
    prompt: verifierPrompt(i.checklist),
    // p19-verifier-jobs: a readable title instead of the prompt's first clause ("You are a VERIFIER…").
    title: platformJobTitle(i.purpose ?? 'verify', i.subject ?? null),
    sandboxProfile: p.sandboxProfile,
    approvalPolicy: p.approvalPolicy,
    ...(p.sourceTrust === undefined ? {} : { sourceTrust: p.sourceTrust }),
    limits: {
      maxDurationSec: Math.max(60, Math.min(parentMax, LIMITS.verifierMaxDurationSec)),
      ...(typeof limits.maxTokens === 'number' ? { maxTokens: limits.maxTokens } : {}),
    },
    role: 'verify',
    ...(i.checklist.browser ? { requirements: { tools: ['browser'] } } : {}),
  };
  if (i.checklist.projectKind === 'repository') {
    if (typeof repo?.url !== 'string' || i.checkoutRef === undefined || i.workBranch === undefined) {
      throw new VerifierRefusal('The repository or the branch to check out is unknown.');
    }
    spec.repository = { url: repo.url, baseRef: i.checkoutRef, workBranch: i.workBranch };
    spec.siteBundle = { directory: REPO_REPORT_BUNDLE_DIR };
  }
  return spec;
}

export async function createVerifierJob(
  deps: {
    readonly pool: Pool;
    readonly jobs: JobStore;
    readonly dispatch: (jobId: string) => Promise<unknown>;
    readonly clock?: () => Date;
  },
  i: VerifierJobInput,
): Promise<string> {
  if (isRetiredRuntime(i.runtime)) throw new VerifierRefusal('The verifier runtime was removed.');
  if (!(await mayCreateJobs(deps.pool, i.creator, i.project))) {
    throw new VerifierRefusal('The person who started it may no longer create jobs in this project.');
  }
  const spec = verifierSpec(i);
  const { job } = await deps.jobs.create({
    project: i.project,
    spec,
    priority: i.priority,
    actor: { type: 'user', id: i.creator },
    submit: true,
    ...((i.inputs ?? []).length > 0 ? { inputs: [...(i.inputs ?? [])] } : {}),
    withinCreate: async (tx, jobId) => {
      await markReportOnly(
        tx,
        jobId,
        i.purpose ?? 'verify',
        deps.clock?.() ?? new Date(),
        i.checkedJobId ?? null,
      );
      await i.withinCreate?.(tx, jobId);
    },
  });
  void deps.dispatch(job.id).catch(() => undefined);
  return job.id;
}
