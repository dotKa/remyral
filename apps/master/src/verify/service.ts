import { createHash, randomBytes } from 'node:crypto';
import { RuntimeKind, SiteBundle } from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { stepUpFresh } from '../approvals/policy-store.js';
import { STEP_UP_ALWAYS_FRESH_MS } from '../auth/step-up.js';
import type { Pool, Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { rowContent } from '../blobs/registry.js';
import type { JobStore } from '../jobs/store.js';
import { jobTitle } from '../jobs/titles.js';
import type { PageFetcher } from '../uptime/probe.js';
import type { PreparedInput } from '../workspaces/service.js';
import { type BundleFile, checkDocs, checkSiteBundle } from './bundle-check.js';
import {
  type Check,
  cleanText,
  combine,
  type Finding,
  type OutputType,
  type Screenshot,
  stateOf,
  type VerificationSource,
  type VerificationState,
  VerifyRequest,
  type VerifyMode,
} from './model.js';
import { OUTBOX_TOPIC_VERIFY } from './outbox.js';
import { reasonCode, type UnverifiableCause, verifierFailureCause } from './causes.js';
import { readVerifierFiles } from './report.js';
import type { VerifySettingsStore } from './settings.js';
import { browserAvailable, closeReportJobGate, createVerifierJob, VerifierRefusal } from './verifier-job.js';

/**
 * p10-verify-health (docs/design/p10-verify-health.md §2–§4, ADR-0035): "Verify when done".
 *
 * - **At creation** (`resolve` + `record`): the request's mode, else the project's default; one row per job, written
 *   in the job's creation transaction. Off → no row.
 * - **After success** (`tick`, an orchestrator step; the work runs outside the tick, `drain()` waits for it): the
 *   master's deterministic checks (site bundle / docs), then — when the checklist needs execution — a verifier job;
 *   its report is read as data and combined into passed / warned / failed / error.
 * - **Gate**: the deploy-on-success tick claims a pending deploy only when the verification passed / warned / was
 *   overridden (see `GATE_HOLDS_SQL`); `override` lets a project admin release it with a fresh step-up.
 */

export type VerifyVia = 'request' | 'chat' | 'template' | 'automation';

export interface PreparedVerification {
  readonly mode: Exclude<VerifyMode, 'off'>;
  readonly runtime: RuntimeKind | null;
  readonly source: VerificationSource;
}

export interface VerificationView {
  readonly id: string;
  readonly jobId: string;
  readonly project: string;
  readonly mode: 'report' | 'gate';
  readonly runtime: string | null;
  readonly source: VerificationSource;
  readonly state: VerificationState;
  readonly outputType: OutputType | null;
  readonly verifierJobId: string | null;
  readonly verifierJobState: string | null;
  readonly checks: Check[];
  readonly findings: Finding[];
  readonly screenshots: Screenshot[];
  readonly summary: string | null;
  readonly reason: string | null;
  /**
   * p19-verifier-jobs: why the verification could not run (state `error`; `UNVERIFIABLE_CAUSES`), null otherwise or
   * unknown (an older row).
   */
  readonly errorCause: string | null;
  /** Gate mode: whether a pending deploy on success waits for this verification right now. */
  readonly holdsDeploy: boolean;
  readonly hasDeployOnSuccess: boolean;
  readonly override: {
    readonly by: string | null;
    readonly at: string;
    readonly reason: string | null;
  } | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** States in which a gate verification holds the deploy (no override). */
const HOLDING = ['waiting', 'checking', 'verifying', 'failed', 'error'] as const;

const TERMINAL_JOB = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
/**
 * p11-fixes-a: a verifier's run is over in these states. AWAITING_APPROVAL = a verifier created before report-only jobs
 * existed (or by an older master) that went through git flow: its run succeeded, its report is read, its gate closed.
 */
const VERIFIER_DONE = [...TERMINAL_JOB, 'AWAITING_APPROVAL'];
/** Verifier states that count as a finished run with a report. */
const VERIFIER_RAN = ['SUCCEEDED', 'AWAITING_APPROVAL'];
const CLAIM_TIMEOUT_MS = 10 * 60_000;

interface Row {
  id: string;
  job_id: string;
  project: string;
  mode: 'report' | 'gate';
  runtime: string | null;
  source: VerificationSource;
  created_by: string | null;
  origin: Record<string, unknown> | null;
  state: VerificationState;
  output_type: OutputType | null;
  verifier_job_id: string | null;
  verifier_state: string | null;
  checks: Check[];
  findings: Finding[];
  screenshots: Screenshot[];
  summary: string | null;
  reason: string | null;
  error_cause: string | null;
  override_by: string | null;
  override_at: Date | null;
  override_reason: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  dos_state: string | null;
}

const COLS = `v.id::text AS id, v.job_id::text AS job_id, v.project, v.mode, v.runtime, v.source,
  v.created_by::text AS created_by, v.origin, v.state, v.output_type, v.verifier_job_id::text AS verifier_job_id,
  (SELECT j.state::text FROM jobs j WHERE j.id = v.verifier_job_id) AS verifier_state, v.checks, v.findings,
  v.screenshots, v.summary, v.reason, v.error_cause, v.override_by::text AS override_by, v.override_at, v.override_reason,
  v.created_at, v.started_at, v.finished_at,
  (SELECT d.state FROM job_deploy_on_success d WHERE d.job_id = v.job_id) AS dos_state`;

export interface VerificationDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly jobs: JobStore;
  readonly dispatch: (jobId: string) => Promise<unknown>;
  readonly settings: VerifySettingsStore;
  /** Guarded fetcher for the docs' external links (null: not checked). */
  readonly fetcher: PageFetcher | null;
  readonly chatNote?: (threadId: string, text: string, meta: Record<string, unknown>) => Promise<void>;
}

export class VerificationService {
  readonly #running = new Set<Promise<void>>();

  constructor(private readonly deps: VerificationDeps) {}

  // ------------------------------------------------------------------------------------------ creation

  /** Parses a `verifyOnSuccess` body field (400 on anything else). */
  parse(raw: unknown): VerifyRequest {
    const p = VerifyRequest.safeParse(raw);
    if (!p.success) {
      throw new HttpError(
        400,
        'invalid_verify',
        `Invalid verifyOnSuccess: ${p.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`.slice(0, 300),
        {},
        {},
        {
          issues: p.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
            .join('; ')
            .slice(0, 300),
        },
      );
    }
    return p.data;
  }

  /**
   * What a new job of `project` gets: the request's mode, else the project's default. Null = no verification. Special
   * job kinds are never verified.
   */
  async resolve(
    project: string,
    requested: VerifyRequest | undefined,
    via: VerifyVia,
    spec: unknown,
  ): Promise<PreparedVerification | null> {
    const s = typeof spec === 'object' && spec !== null ? (spec as Record<string, unknown>) : {};
    if (s.kind !== undefined || s.machineAdmin !== undefined) return null;
    if (requested !== undefined) {
      if (requested.mode === 'off') return null;
      return { mode: requested.mode, runtime: requested.runtime ?? null, source: via };
    }
    const settings = await this.deps.settings.get(project);
    if (settings.verifyDefault === 'off') return null;
    return { mode: settings.verifyDefault, runtime: settings.verifyRuntime, source: 'project' };
  }

  /** Stores the verification of a new job (inside the job's creation transaction) and audits it. */
  async record(
    tx: Queryable,
    jobId: string,
    project: string,
    p: PreparedVerification,
    createdBy: string | null,
    origin: Record<string, unknown> | null,
  ): Promise<string> {
    const now = this.deps.clock();
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO job_verifications (job_id, project, mode, runtime, source, created_by, origin, state, created_at,
                                      updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'waiting', $8, $8) RETURNING id::text AS id`,
      [jobId, project, p.mode, p.runtime, p.source, createdBy, origin, now],
    );
    const id = rows[0]?.id ?? '';
    await this.deps.audit.record(
      {
        actor: createdBy === null ? { type: 'system', id: 'verification' } : { type: 'user', id: createdBy },
        action: 'verify.create',
        target: `job:${jobId}`,
        outcome: 'success',
        metadata: { id, project, mode: p.mode, runtime: p.runtime, source: p.source },
      },
      tx,
    );
    return id;
  }

  // --------------------------------------------------------------------------------------------- reads

  async forJob(jobId: string): Promise<VerificationView | null> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM job_verifications v WHERE v.job_id = $1`,
      [jobId],
    );
    const r = rows[0];
    return r === undefined ? null : view(r);
  }

  /** Badges for job lists: state per job id. */
  async states(jobIds: readonly string[]): Promise<Map<string, { mode: string; state: VerificationState }>> {
    const out = new Map<string, { mode: string; state: VerificationState }>();
    if (jobIds.length === 0) return out;
    const { rows } = await this.deps.pool.query<{ job_id: string; mode: string; state: VerificationState }>(
      'SELECT job_id::text AS job_id, mode, state FROM job_verifications WHERE job_id = ANY($1::uuid[])',
      [jobIds],
    );
    for (const r of rows) out.set(r.job_id, { mode: r.mode, state: r.state });
    return out;
  }

  // -------------------------------------------------------------------------------------------- override

  /**
   * Releases a held gate (ADR-0035): the route checked `deploy.approve` in the job's project; this checks the
   * always-fresh step-up and the state, records who and why, and audits it. The deploy runs on the next tick with its
   * own pre-approval checks unchanged.
   */
  async override(
    actor: {
      readonly userId: string;
      readonly mfaAt: Date | null;
      readonly stepUpMaxAgeMs?: number;
      readonly ip?: string | null;
      readonly userAgent?: string | null;
    },
    jobId: string,
    reason: string,
  ): Promise<VerificationView> {
    const r = await this.forJob(jobId);
    const deny = async (status: number, code: string, message: string): Promise<never> => {
      await this.deps.audit.record({
        actor: { type: 'user', id: actor.userId },
        action: 'verify.gate.override',
        target: `job:${jobId}`,
        outcome: 'denied',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: { code },
      });
      throw new HttpError(status, code, message);
    };
    if (r === null) return deny(404, 'verification_not_found', 'This job has no verification.');
    if (r.mode !== 'gate')
      return deny(409, 'not_a_gate', 'This verification does not hold a deploy (report mode).');
    if (r.override !== null) return deny(409, 'already_overridden', 'The gate was already overridden.');
    if (!(HOLDING as readonly string[]).includes(r.state)) {
      return deny(409, 'gate_not_holding', 'The verification does not hold the deploy.');
    }
    const maxAge = Math.min(actor.stepUpMaxAgeMs ?? STEP_UP_ALWAYS_FRESH_MS, STEP_UP_ALWAYS_FRESH_MS);
    if (!stepUpFresh(actor.mfaAt, this.deps.clock(), maxAge)) {
      return deny(
        403,
        'step_up_required',
        'Confirm with a current authenticator code: deploying without a passed verification is approved now.',
      );
    }
    const text = cleanText(reason, 500);
    const now = this.deps.clock();
    const { rowCount } = await this.deps.pool.query(
      `UPDATE job_verifications SET override_by = $2, override_at = $3, override_reason = $4, updated_at = $3
        WHERE id = $1 AND override_at IS NULL`,
      [r.id, actor.userId, now, text === '' ? null : text],
    );
    if (rowCount === 0) return deny(409, 'already_overridden', 'The gate was already overridden.');
    await this.deps.pool.query(
      `UPDATE job_deploy_on_success SET reason = NULL, updated_at = $2 WHERE job_id = $1 AND state = 'pending'`,
      [jobId, now],
    );
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'verify.gate.override',
      target: `job:${jobId}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { id: r.id, state: r.state, reason: text === '' ? null : text },
    });
    return (await this.forJob(jobId)) as VerificationView;
  }

  // ----------------------------------------------------------------------------------------------- retry

  /**
   * p19-verifier-jobs: "Doğrulamayı yeniden dene" — a verification that could not run (`error`: the verifier failed on
   * infrastructure, git or its runtime) starts over: the row goes back to `waiting` and the next tick checks the job
   * again and creates a new verifier job (as the job's creator, re-authorised then). The route checked `jobs.create` in
   * the job's project. Only from `error`, only for a job that succeeded (otherwise there is nothing to verify); the
   * earlier verifier job stays in the job list with its own outcome. Audited `verify.retry`.
   */
  async retry(
    actor: { readonly userId: string; readonly ip?: string | null; readonly userAgent?: string | null },
    jobId: string,
  ): Promise<VerificationView> {
    const audit = async (outcome: 'success' | 'denied', metadata: Record<string, unknown>): Promise<void> => {
      await this.deps.audit.record({
        actor: { type: 'user', id: actor.userId },
        action: 'verify.retry',
        target: `job:${jobId}`,
        outcome,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata,
      });
    };
    const r = await this.forJob(jobId);
    if (r === null) {
      await audit('denied', { denial: 'verification_not_found' });
      throw new HttpError(404, 'verification_not_found', 'This job has no verification.');
    }
    if (r.state !== 'error') {
      await audit('denied', { id: r.id, denial: 'verification_not_retryable', state: r.state });
      throw new HttpError(
        409,
        'verification_not_retryable',
        'Only a verification that could not run can be started again.',
      );
    }
    const now = this.deps.clock();
    const { rowCount } = await this.deps.pool.query(
      `UPDATE job_verifications v SET state = 'waiting', verifier_job_id = NULL, error_cause = NULL, reason = NULL,
              summary = NULL, checks = '[]'::jsonb, findings = '[]'::jsonb, screenshots = '[]'::jsonb,
              output_type = NULL, claimed_at = NULL, started_at = NULL, finished_at = NULL, notified_at = NULL,
              updated_at = $2
        WHERE v.id = $1 AND v.state = 'error'
          AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = v.job_id AND j.state = 'SUCCEEDED')`,
      [r.id, now],
    );
    if ((rowCount ?? 0) === 0) {
      await audit('denied', { id: r.id, denial: 'verification_not_retryable' });
      throw new HttpError(
        409,
        'verification_not_retryable',
        'Only a verification that could not run can be started again.',
      );
    }
    await audit('success', { id: r.id, previousVerifierJobId: r.verifierJobId, cause: r.errorCause });
    return (await this.forJob(jobId)) as VerificationView;
  }

  // ------------------------------------------------------------------------------------------- the tick

  step(): { name: string; run: () => Promise<number> } {
    return { name: 'verification', run: () => this.tick() };
  }

  /** Waits for the work started by earlier ticks (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
  }

  #spawn(fn: () => Promise<void>): void {
    const p = fn()
      .catch((err: unknown) => {
        this.deps.log.error({ err }, 'verification step failed unexpectedly');
      })
      .finally(() => {
        this.#running.delete(p);
      });
    this.#running.add(p);
  }

  async tick(): Promise<number> {
    const now = this.deps.clock();
    const stale = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
    // A replica that died while checking: the claim is released.
    await this.deps.pool.query(
      `UPDATE job_verifications SET state = 'waiting', claimed_at = NULL, updated_at = $1
        WHERE state = 'checking' AND claimed_at < $2`,
      [now, stale],
    );
    // The job ended without success: nothing to verify.
    const skipped = await this.deps.pool.query<{ id: string; job_state: string }>(
      `SELECT v.id::text AS id, j.state::text AS job_state FROM job_verifications v JOIN jobs j ON j.id = v.job_id
        WHERE v.state = 'waiting' AND j.state IN ('FAILED', 'CANCELLED') LIMIT 50`,
    );
    for (const s of skipped.rows) {
      await this.#finish(s.id, 'skipped', {
        reason: `The job ended ${s.job_state.toLowerCase()}; nothing was verified.`,
      });
    }
    let n = skipped.rows.length;
    // Succeeded jobs: claim and start (outside the tick).
    const claimed = await this.deps.pool.query<{ id: string }>(
      `WITH c AS (SELECT v.id FROM job_verifications v JOIN jobs j ON j.id = v.job_id
                   WHERE v.state = 'waiting' AND j.state = 'SUCCEEDED'
                   ORDER BY v.created_at LIMIT 5 FOR UPDATE OF v SKIP LOCKED)
       UPDATE job_verifications v SET state = 'checking', claimed_at = $1, started_at = $1, updated_at = $1
         FROM c WHERE v.id = c.id RETURNING v.id::text AS id`,
      [now],
    );
    for (const c of claimed.rows) {
      this.#spawn(() => this.#start(c.id));
      n++;
    }
    // Verifier jobs that ended: collect (claimed by stamping claimed_at).
    const ended = await this.deps.pool.query<{ id: string }>(
      `UPDATE job_verifications v SET claimed_at = $1, updated_at = $1
        WHERE v.id IN (SELECT v2.id FROM job_verifications v2 JOIN jobs j ON j.id = v2.verifier_job_id
                        WHERE v2.state = 'verifying' AND j.state = ANY($3::job_state[])
                          AND (v2.claimed_at IS NULL OR v2.claimed_at < $2)
                        ORDER BY v2.created_at LIMIT 10 FOR UPDATE OF v2 SKIP LOCKED)
       RETURNING v.id::text AS id`,
      [now, stale, VERIFIER_DONE],
    );
    for (const e of ended.rows) {
      this.#spawn(() => this.#collect(e.id));
      n++;
    }
    // A verifier job that vanished (deleted): error.
    const orphaned = await this.deps.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM job_verifications WHERE state = 'verifying' AND verifier_job_id IS NULL LIMIT 10`,
    );
    for (const o of orphaned.rows) {
      await this.#finish(o.id, 'error', {
        reason: 'The verifier job no longer exists.',
        cause: 'verifier_missing',
      });
    }
    return n;
  }

  async #row(id: string): Promise<Row | null> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM job_verifications v WHERE v.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** The verified job succeeded: master checks, then (when needed) the verifier job. */
  async #start(id: string): Promise<void> {
    const r = await this.#row(id);
    if (r?.state !== 'checking') return;
    const { rows } = await this.deps.pool.query<{
      spec: Record<string, unknown>;
      priority: number;
      created_by_type: string;
      created_by_id: string | null;
      current_attempt_id: string | null;
      kind: string | null;
    }>(
      `SELECT j.spec, j.priority, j.created_by_type, j.created_by_id, j.current_attempt_id::text AS current_attempt_id,
              p.kind FROM jobs j LEFT JOIN projects p ON p.id = j.project WHERE j.id = $1`,
      [r.job_id],
    );
    const job = rows[0];
    if (job === undefined) {
      await this.#finish(id, 'error', { reason: 'The job no longer exists.', cause: 'not_started' });
      return;
    }
    const projectKind: 'repository' | 'workspace' = job.kind === 'workspace' ? 'workspace' : 'repository';
    const checks: Check[] = [];
    const findings: Finding[] = [];
    const bundle = await this.#siteBundle(r.job_id, job.current_attempt_id);
    let outputType: OutputType;
    let docs: { name: string; content: Buffer }[] = [];
    let allNames: string[] = [];
    if (bundle !== null) outputType = 'site';
    else if (projectKind === 'repository') outputType = 'repo';
    else {
      const files = await this.deps.pool.query<{
        name: string;
        content: Buffer | null;
        blob_key: string | null;
      }>(
        `SELECT name, content, blob_key FROM job_artifacts WHERE job_id = $1 AND kind IN ('output', 'summary')
           AND ($2::uuid IS NULL OR attempt_id = $2::uuid) ORDER BY created_at`,
        [r.job_id, job.current_attempt_id],
      );
      allNames = files.rows.map((f) => f.name);
      // p17-object-storage: Markdown outputs are read from the blob store (bounded; a missing blob is skipped).
      docs = [];
      for (const f of files.rows) {
        if (!/\.(md|markdown)$/i.test(f.name)) continue;
        const content = await rowContent(f, 8 * 1024 * 1024).catch(() => null);
        if (content !== null) docs.push({ name: f.name, content });
      }
      outputType = docs.length > 0 ? 'docs' : 'none';
    }
    // 1. Master checks.
    if (outputType === 'site' && bundle !== null) {
      if (bundle.problem !== null) {
        checks.push({ source: 'master', id: 'bundle', status: 'fail', detail: bundle.problem });
        findings.push({ source: 'master', severity: 'fail', kind: 'build', message: bundle.problem });
      } else {
        const out = checkSiteBundle(bundle.files);
        checks.push(...out.checks);
        findings.push(...out.findings);
      }
    } else if (outputType === 'docs') {
      const out = await checkDocs(docs, allNames, this.deps.fetcher);
      checks.push(...out.checks);
      findings.push(...out.findings);
    }
    await this.deps.pool.query(
      `UPDATE job_verifications SET output_type = $2, checks = $3, findings = $4, updated_at = $5 WHERE id = $1`,
      [id, outputType, JSON.stringify(checks), JSON.stringify(findings), this.deps.clock()],
    );
    if (r.mode === 'gate') {
      await this.deps.pool.query(
        `UPDATE job_deploy_on_success SET reason = $2, updated_at = $3 WHERE job_id = $1 AND state = 'pending'`,
        [r.job_id, 'Waiting for the verification (gate).', this.deps.clock()],
      );
    }
    if (outputType === 'docs' || outputType === 'none') {
      if (outputType === 'none') {
        await this.#finish(id, 'skipped', {
          reason: 'Nothing to verify: the job produced no site, branch or documents.',
        });
        return;
      }
      await this.#finish(id, stateOf(combine(checks, findings, null)), {});
      return;
    }
    // 2. The verifier job.
    const settings = await this.deps.settings.get(r.project);
    const runtimeParsed = RuntimeKind.safeParse(r.runtime ?? settings.verifyRuntime ?? job.spec.runtime);
    const why = async (reason: string): Promise<void> => {
      if (outputType === 'site') {
        // The master's bundle check stands on its own; the missing browser / build part is a warning.
        findings.push({
          source: 'master',
          severity: 'warn',
          kind: 'other',
          message: `Verifier not run: ${reason}`,
        });
        await this.#finish(id, stateOf(combine(checks, findings, null)), { checks, findings, reason });
      } else {
        await this.#finish(id, 'error', {
          checks,
          findings,
          reason: `Verifier not run: ${reason}`,
          cause: 'not_started',
        });
      }
    };
    if (!runtimeParsed.success) {
      await why('no runtime is available for the verifier.');
      return;
    }
    if (job.created_by_type !== 'user' || job.created_by_id === null) {
      await why('the job was not started by a person.');
      return;
    }
    let checkoutRef: string | undefined;
    if (projectKind === 'repository') {
      const git = await this.deps.pool.query<{ branch: string | null }>(
        'SELECT branch FROM job_git WHERE job_id = $1',
        [r.job_id],
      );
      const branch = git.rows[0]?.branch ?? null;
      if (branch === null) {
        await why(
          'the job’s changes were not pushed to a branch (no git flow for this project), so there is nothing to check out.',
        );
        return;
      }
      checkoutRef = branch;
    }
    let inputs: PreparedInput[] = [];
    let handOver: string | null = null;
    if (projectKind === 'workspace') {
      if (bundle?.raw == null) handOver = 'the site bundle cannot be read';
      else {
        inputs = [siteBundleInput(bundle.raw, r.job_id)];
      }
    }
    if (handOver !== null) {
      await why(`the site could not be handed to a verifier (${handOver}).`);
      return;
    }
    const bundleInput = inputs.length > 0;
    const browser = outputType === 'site' ? await browserAvailable(this.deps.pool) : false;
    const siteDir = (job.spec.siteBundle as { directory?: unknown } | undefined)?.directory;
    try {
      const verifierId = await createVerifierJob(
        {
          pool: this.deps.pool,
          jobs: this.deps.jobs,
          dispatch: this.deps.dispatch,
          clock: this.deps.clock,
        },
        {
          purpose: 'verify',
          // p19-verifier-jobs: "Doğrula: <the verified job's title>", linked to the verified job.
          subject: await jobTitle(this.deps.pool, r.job_id).catch(() => null),
          checkedJobId: r.job_id,
          project: r.project,
          creator: job.created_by_id,
          parentSpec: job.spec,
          runtime: runtimeParsed.data,
          priority: job.priority,
          checklist: {
            type: outputType,
            jobId: r.job_id,
            projectKind,
            siteDirectory: typeof siteDir === 'string' ? siteDir : null,
            bundleInput,
            testCommand: settings.testCommand,
            browser,
          },
          ...(checkoutRef === undefined
            ? {}
            : { checkoutRef, workBranch: `verify/${r.job_id.slice(0, 8)}/${id.slice(0, 8)}` }),
          inputs,
        },
      );
      await this.deps.pool.query(
        `UPDATE job_verifications SET state = 'verifying', verifier_job_id = $2, claimed_at = NULL, updated_at = $3
          WHERE id = $1 AND state = 'checking'`,
        [id, verifierId, this.deps.clock()],
      );
      await this.deps.audit.record({
        actor: { type: 'system', id: 'verification' },
        action: 'verify.start',
        target: `job:${r.job_id}`,
        outcome: 'success',
        metadata: { id, verifierJobId: verifierId, outputType, runtime: runtimeParsed.data, browser },
      });
    } catch (err) {
      if (err instanceof VerifierRefusal) {
        await why(err.reason);
        return;
      }
      this.deps.log.warn({ err, id }, 'verifier job could not be created');
      await why(
        err instanceof HttpError
          ? err.publicMessage
          : 'the verifier job could not be created (see the master log).',
      );
    }
  }

  /** The site bundle of the job's final attempt: its files, or why it cannot be read. Null when there is none. */
  async #siteBundle(
    jobId: string,
    attemptId: string | null,
  ): Promise<{ files: BundleFile[]; raw: Buffer | null; problem: string | null } | null> {
    const { rows } = await this.deps.pool.query<{
      content: Buffer | null;
      blob_key: string | null;
      redacted: boolean;
    }>(
      `SELECT content, blob_key, redacted FROM job_artifacts WHERE job_id = $1 AND kind = 'site'
          AND ($2::uuid IS NULL OR attempt_id = $2::uuid) ORDER BY created_at DESC LIMIT 1`,
      [jobId, attemptId],
    );
    const row = rows[0];
    // p17-object-storage: the bundle's bytes may be in the blob store (unreadable: treated like removed).
    const b =
      row === undefined
        ? undefined
        : { redacted: row.redacted, content: await rowContent(row, 16 * 1024 * 1024).catch(() => null) };
    if (b === undefined) return null;
    if (b.redacted) {
      return {
        files: [],
        raw: null,
        problem: 'The site bundle looks like it contains a secret (master scan).',
      };
    }
    if (b.content === null)
      return { files: [], raw: null, problem: 'The site bundle was removed by retention.' };
    try {
      const p = SiteBundle.safeParse(JSON.parse(b.content.toString('utf8')));
      if (!p.success) return { files: [], raw: null, problem: 'The site bundle is invalid.' };
      return {
        raw: b.content,
        problem: null,
        files: p.data.files.map((f) => ({
          path: f.path,
          contentType: f.contentType,
          content: Buffer.from(f.base64, 'base64'),
        })),
      };
    } catch {
      return { files: [], raw: null, problem: 'The site bundle is invalid.' };
    }
  }

  /** The verifier job ended: read its report as data and decide. */
  async #collect(id: string): Promise<void> {
    const r = await this.#row(id);
    if (r?.state !== 'verifying' || r.verifier_job_id === null) return;
    const checks = [...r.checks];
    const findings = [...r.findings];
    if (!VERIFIER_RAN.includes(String(r.verifier_state))) {
      // p19-verifier-jobs: why it could not run, from the verifier's own failure (classified, never echoed).
      const failure = await this.deps.pool.query<{ reason: string | null }>(
        `SELECT reason FROM job_transitions WHERE job_id = $1 AND to_state IN ('FAILED', 'LOST')
          ORDER BY version DESC LIMIT 1`,
        [r.verifier_job_id],
      );
      const text = failure.rows[0]?.reason ?? null;
      const cause = verifierFailureCause(
        String(r.verifier_state),
        text === null ? null : { code: reasonCode(text), message: text },
      );
      await this.#finish(id, 'error', {
        checks,
        findings,
        reason: `The verifier job ended ${String(r.verifier_state).toLowerCase()} without a result.`,
        cause,
      });
      return;
    }
    if (r.verifier_state === 'AWAITING_APPROVAL') {
      await closeReportJobGate(
        this.deps.jobs,
        r.verifier_job_id,
        'Platform verifier: its report was collected; a verification branch is never merged.',
      );
    }
    const files = await readVerifierFiles(this.deps.pool, r.verifier_job_id);
    if (files.report === null) {
      await this.#finish(id, 'error', {
        checks,
        findings,
        reason: files.problem ?? 'No valid report.',
        cause: 'no_report',
      });
      return;
    }
    checks.push(...files.report.checks);
    findings.push(...files.report.findings);
    const status = combine(checks, findings, files.report.status);
    await this.#finish(id, stateOf(status), {
      checks,
      findings,
      screenshots: files.screenshots,
      summary: files.report.summary,
    });
  }

  /** Final state, exactly once; audit, notification on failure, a note in the originating chat thread. */
  async #finish(
    id: string,
    state: 'passed' | 'warned' | 'failed' | 'error' | 'skipped',
    extra: {
      readonly checks?: readonly Check[];
      readonly findings?: readonly Finding[];
      readonly screenshots?: readonly Screenshot[];
      readonly summary?: string | null;
      readonly reason?: string | null;
      /** p19-verifier-jobs: why an `error` verification could not run. */
      readonly cause?: UnverifiableCause;
    },
  ): Promise<void> {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `UPDATE job_verifications SET state = $2,
              checks = COALESCE($3::jsonb, checks), findings = COALESCE($4::jsonb, findings),
              screenshots = COALESCE($5::jsonb, screenshots), summary = COALESCE($6, summary),
              reason = COALESCE($7, reason), finished_at = $8, notified_at = $8, claimed_at = NULL, updated_at = $8,
              error_cause = $9
        WHERE id = $1 AND state IN ('waiting', 'checking', 'verifying') RETURNING id::text AS id`,
      [
        id,
        state,
        extra.checks === undefined ? null : JSON.stringify(extra.checks),
        extra.findings === undefined ? null : JSON.stringify(extra.findings),
        extra.screenshots === undefined ? null : JSON.stringify(extra.screenshots),
        extra.summary ?? null,
        extra.reason === undefined || extra.reason === null ? null : extra.reason.slice(0, 1000),
        now,
        state === 'error' ? (extra.cause ?? 'run_failed') : null,
      ],
    );
    if (rows[0] === undefined) return;
    const r = await this.#row(id);
    if (r === null) return;
    await this.deps.audit.record({
      actor: { type: 'system', id: 'verification' },
      action: 'verify.finish',
      target: `job:${r.job_id}`,
      outcome:
        state === 'passed' || state === 'warned' ? 'success' : state === 'skipped' ? 'success' : 'failure',
      metadata: {
        id,
        state,
        outputType: r.output_type,
        verifierJobId: r.verifier_job_id,
        findings: r.findings.length,
        screenshots: r.screenshots.length,
        ...(state === 'error' ? { cause: r.error_cause } : {}),
      },
    });
    const holds = r.mode === 'gate' && r.dos_state === 'pending';
    if (holds) {
      const deployReason =
        state === 'failed' || state === 'error'
          ? `Waiting: the verification ${state === 'failed' ? 'failed' : 'could not run'} — a project admin can deploy anyway on the job page.`
          : null;
      await this.deps.pool.query(
        `UPDATE job_deploy_on_success SET reason = $2, updated_at = $3 WHERE job_id = $1 AND state = 'pending'`,
        [r.job_id, deployReason, now],
      );
    }
    if (state === 'failed' || state === 'error') {
      await this.deps.pool.query(
        'INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)',
        [OUTBOX_TOPIC_VERIFY, JSON.stringify({ kind: 'job', id }), now],
      );
    }
    const thread = r.origin?.chatThreadId;
    if (typeof thread === 'string' && this.deps.chatNote !== undefined && state !== 'skipped') {
      const job = `[\`${r.job_id.slice(0, 8)}\`](/jobs/${r.job_id})`;
      const word = {
        passed: 'passed',
        warned: 'passed with warnings',
        failed: 'failed',
        error: 'could not run',
      }[state];
      const text =
        `Verification of job ${job} ${word}` +
        (state === 'error' && r.error_cause !== null ? ` (${r.error_cause})` : '') +
        (r.findings.length > 0 ? ` — ${String(r.findings.length)} finding(s).` : '.') +
        (holds && (state === 'failed' || state === 'error') ? ' Its deploy waits (gate).' : '');
      try {
        await this.deps.chatNote(thread, text, {
          notice: 'verification',
          jobId: r.job_id,
          state,
          ...(state === 'error' && r.error_cause !== null ? { cause: r.error_cause } : {}),
        });
      } catch (err) {
        this.deps.log.debug({ err, id }, 'verification: chat note not posted');
      }
    }
  }
}

/**
 * The verified job's own site bundle as the verifier's input `site-bundle.json`. Not run through the upload scanner
 * again: the base64 file contents read as high-entropy text to it, and this exact content already passed the worker's
 * per-file secret scan and the master's scan when it was stored (a flagged bundle — `redacted` — never gets here). It
 * goes to a job of the same project, as the same person.
 */
function siteBundleInput(content: Buffer, sourceJobId: string): PreparedInput {
  return {
    ref: {
      inputId: `in-${randomBytes(8).toString('hex')}`,
      name: 'site-bundle.json',
      mediaType: 'application/json',
      sizeBytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    },
    content,
    source: 'artifact',
    sourceJobId,
  };
}

function view(r: Row): VerificationView {
  const holding = (HOLDING as readonly string[]).includes(r.state);
  return {
    id: r.id,
    jobId: r.job_id,
    project: r.project,
    mode: r.mode,
    runtime: r.runtime,
    source: r.source,
    state: r.state,
    outputType: r.output_type,
    verifierJobId: r.verifier_job_id,
    verifierJobState: r.verifier_state,
    checks: r.checks,
    findings: r.findings,
    screenshots: r.screenshots,
    summary: r.summary,
    reason: r.reason,
    errorCause: r.state === 'error' ? r.error_cause : null,
    holdsDeploy: r.mode === 'gate' && r.override_at === null && holding && r.dos_state === 'pending',
    hasDeployOnSuccess: r.dos_state !== null,
    override:
      r.override_at === null
        ? null
        : { by: r.override_by, at: r.override_at.toISOString(), reason: r.override_reason },
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}
