import { createHash } from 'node:crypto';
import { AgentEvent, HistoricalRuntimeKind } from '@remyral/protocol';
import {
  assessCost,
  AUTH_MODES,
  type AuthMode,
  BUDGET_BILLINGS,
  BUDGET_METRICS,
  BUDGET_ON_EXCEEDED,
  BUDGET_SCOPE_TYPES,
  BUDGET_WINDOWS,
  type BudgetBilling,
  type BudgetDefinition,
  type BudgetEvaluation,
  type BudgetMetric,
  type BudgetOnExceeded,
  type BudgetScope,
  type BudgetScopeType,
  type BudgetWindow,
  type CostAssessment,
  type CostProvenance,
  DEFAULT_THRESHOLDS_PCT,
  evaluateBudget,
  type GroupBy,
  type GroupSummary,
  isValidTimeZone,
  levelOfThreshold,
  normalizeThresholds,
  type PriceEntry,
  summarize,
  thresholdsReached,
  type UsageBucket,
  type UsageSummary,
  windowBounds,
} from '@remyral/usage';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { DEFAULT_STEP_UP_WINDOW_MS } from '../auth/step-up.js';
import type { Role } from '../auth/users.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import {
  type InputIssue,
  InvalidUsageInputError,
  UsageError,
  UsageForbiddenError,
  UsageNotFoundError,
  UsageRejectedError,
  UsageStepUpRequiredError,
  UsageVersionConflictError,
} from './errors.js';
import { type BudgetThresholdOutboxPayload, OUTBOX_TOPIC_BUDGET_THRESHOLD } from './outbox.js';

// ------------------------------------------------------------------------------------------------ types

/** An authenticated human acting through the console/API. */
export interface UsageActor {
  readonly id: string;
  readonly role: Role;
  /** Last TOTP verification of the session (login or step-up), ADR-0009 §10. */
  readonly mfaAt: Date | null;
  /**
   * p5-stepup-window: accepted age of `mfaAt` for this session (Infinity for a remember-me / trusted-device
   * session after its TOTP). Omitted: the standard 10 minutes.
   */
  readonly stepUpMaxAgeMs?: number;
}

export interface RequestMeta {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/**
 * What the worker transport knows when an `EVENT{kind:'usage'}` arrives. Event fields win over these for
 * provider/model/authMode; the job spec supplies runtime (always) and model/runtime version (fallback).
 */
export interface UsageEventContext {
  readonly jobId: string;
  readonly attemptId: string;
  /** The authenticated worker the message came from (not a field of the payload). */
  readonly workerId: string;
  /** Idempotency key: the EVENT envelope `messageId`. */
  readonly sourceEventId: string;
  readonly runtimeVersion?: string | null | undefined;
  readonly authMode?: AuthMode | null | undefined;
  readonly provider?: string | null | undefined;
  readonly model?: string | null | undefined;
}

export interface UsageRecord {
  readonly id: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly project: string;
  readonly runtime: string;
  readonly runtimeVersion: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly authMode: AuthMode | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly turns: number | null;
  readonly wallTimeMs: number | null;
  /** As reported by the event (see `cost` for the value shown to users). */
  readonly reportedCostUsd: number | null;
  readonly reportedProvenance: CostProvenance;
  readonly sourceEventId: string;
  readonly recordedAt: Date;
}

export interface RecordView extends UsageRecord {
  readonly cost: CostAssessment;
}

export interface BudgetAlert {
  readonly budgetId: string;
  readonly level: 'notice' | 'warning' | 'exceeded';
  /** p8-cost-efficiency: the threshold (percent of the limit) crossed. */
  readonly thresholdPct: number;
  readonly evaluation: BudgetEvaluation;
}

export interface RecordUsageResult {
  readonly status: 'recorded' | 'duplicate';
  /** Duplicate whose content differs from the stored record (the stored record stands). */
  readonly conflicting: boolean;
  readonly record: UsageRecord;
  /** Threshold crossings this record caused (each also written to the outbox). */
  readonly alerts: readonly BudgetAlert[];
}

export interface UsageFilter {
  readonly project?: string | undefined;
  readonly worker?: string | undefined;
  readonly runtime?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly jobId?: string | undefined;
  readonly authMode?: AuthMode | undefined;
  /** p5-rbac scoping: only records of these projects (null/undefined = every project; empty = none). */
  readonly projects?: readonly string[] | null | undefined;
  /** p8-cost-efficiency: `api` = not local-login (incl. unreported auth mode), `subscription` = local-login. */
  readonly billing?: BudgetBilling | undefined;
  /** p8-cost-efficiency: only records of these jobs. */
  readonly jobIds?: readonly string[] | undefined;
}

export interface SummaryQuery extends UsageFilter {
  readonly groupBy: GroupBy;
  readonly from: Date;
  readonly to: Date;
}

export interface SummaryResult extends UsageSummary {
  readonly priceTableVersion: number;
}

export interface RecordsQuery extends UsageFilter {
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface RecordsPage {
  readonly items: readonly RecordView[];
  readonly nextCursor: string | null;
  readonly priceTableVersion: number;
}

export interface PriceTable {
  readonly version: number;
  readonly note: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date | null;
  readonly entries: readonly PriceEntry[];
}

export interface PriceTableVersionMeta {
  readonly version: number;
  readonly note: string | null;
  readonly entryCount: number;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface PriceEntryInput {
  readonly provider: string;
  readonly model: string;
  readonly effectiveFrom: Date;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly cacheReadUsdPerMTok?: number | null | undefined;
  readonly cacheWriteUsdPerMTok?: number | null | undefined;
  readonly source: string;
}

export interface ReplacePriceTableInput {
  /** The current version the editor saw (0 = the empty initial table). */
  readonly expectedVersion: number;
  readonly note?: string | undefined;
  readonly entries: readonly PriceEntryInput[];
}

export interface BudgetRecord extends BudgetDefinition {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** p8-cost-efficiency. */
  readonly billing: BudgetBilling;
  readonly timeZone: string;
  readonly thresholds: readonly number[];
  readonly onExceeded: BudgetOnExceeded;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedBy: string;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
}

export interface BudgetView {
  readonly budget: BudgetRecord;
  /** Current-window evaluation (`null` for deleted budgets). */
  readonly evaluation: BudgetEvaluation | null;
}

export interface BudgetInput {
  readonly name: string;
  readonly metric: BudgetMetric;
  readonly limit: number;
  readonly scopeType: BudgetScopeType;
  readonly scopeValue?: string | null | undefined;
  readonly window: BudgetWindow;
  readonly enabled?: boolean | undefined;
  /** p8-cost-efficiency (omitted on create: all / UTC / 50-80-100 / pause_new; on update: unchanged). */
  readonly billing?: BudgetBilling | undefined;
  readonly timeZone?: string | undefined;
  readonly thresholds?: readonly number[] | undefined;
  readonly onExceeded?: BudgetOnExceeded | undefined;
}

/** p8-cost-efficiency: an owner/admin lets work through an exhausted budget. */
export interface BudgetOverride {
  readonly id: string;
  readonly budgetId: string;
  readonly budgetVersion: number;
  readonly windowStart: Date;
  readonly jobId: string | null;
  readonly expiresAt: Date;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
}

export interface BudgetOverrideInput {
  readonly reason: string;
  /** Only this job (else every job held by the budget). */
  readonly jobId?: string | null | undefined;
  /** Default and maximum: the end of the budget's current window. */
  readonly until?: Date | undefined;
}

export interface UsageStoreDeps {
  readonly pool: pg.Pool;
  readonly audit: AuditRecorder;
  readonly clock?: () => Date;
}

// ------------------------------------------------------------------------------------------------ rules

const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2, owner: 3 };
function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/** Who may do what (docs/design/p6-cost.md §6). */
export const USAGE_ROLES = {
  /** Aggregated summaries, price table, budgets (read). */
  readSummary: 'viewer',
  /** Record-level detail (job, attempt, worker per event). */
  readRecords: 'operator',
  /** Price table edits (step-up). */
  writePrices: 'admin',
  /** Budget create/update/delete (step-up). */
  writeBudgets: 'admin',
  /** p8-cost-efficiency: let work through an exhausted budget (step-up). */
  overrideBudgets: 'admin',
} as const satisfies Record<string, Role>;

export const LIMITS = {
  maxPriceEntries: 1000,
  maxUsdPerMTok: 1_000_000,
  maxSourceLength: 500,
  maxNoteLength: 1000,
  maxBudgetNameLength: 200,
  maxBudgetLimit: 1e15,
  maxRangeDays: 400,
  maxRecordsPage: 500,
  maxOverrideReasonLength: 500,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[A-Za-z0-9_.:-]{1,128}$/;
export const PROVIDER_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/;
const SCOPE_VALUE = /^[A-Za-z0-9_.:/@+-]{1,128}$/;
// ADR-0023: usage of a removed runtime (OpenHands) stays valid history.
const RUNTIMES = new Set<string>(HistoricalRuntimeKind.options);

export function stepUpFresh(mfaAt: Date | null, now: Date, maxAgeMs = DEFAULT_STEP_UP_WINDOW_MS): boolean {
  return mfaAt !== null && mfaAt <= now && now.getTime() - mfaAt.getTime() <= maxAgeMs;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function num(v: string | number | null): number | null {
  return v === null ? null : Number(v);
}

function cleanText(s: string | null | undefined, max: number): string | null {
  if (s === undefined || s === null) return null;
  const t = s.replaceAll('\u0000', '').trim();
  return t === '' ? null : t.slice(0, max);
}

// ------------------------------------------------------------------------------------------------ rows

interface RecordRow {
  id: string;
  job_id: string;
  attempt_id: string;
  worker_id: string;
  project: string;
  runtime: string;
  runtime_version: string | null;
  provider: string | null;
  model: string | null;
  auth_mode: AuthMode | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  turns: number | null;
  wall_time_ms: string | null;
  cost_usd: string | null;
  provenance: CostProvenance;
  source_event_id: string;
  payload_hash: string;
  recorded_at: Date;
}

const RECORD_COLUMNS = `id::text AS id, job_id, attempt_id, worker_id, project, runtime, runtime_version, provider,
  model, auth_mode, input_tokens::text, output_tokens::text, cache_read_tokens::text, cache_write_tokens::text, turns,
  wall_time_ms::text, cost_usd::text, provenance, source_event_id, payload_hash, recorded_at`;

function toRecord(r: RecordRow): UsageRecord {
  return {
    id: r.id,
    jobId: r.job_id,
    attemptId: r.attempt_id,
    workerId: r.worker_id,
    project: r.project,
    runtime: r.runtime,
    runtimeVersion: r.runtime_version,
    provider: r.provider,
    model: r.model,
    authMode: r.auth_mode,
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    cacheWriteTokens: num(r.cache_write_tokens),
    turns: r.turns,
    wallTimeMs: num(r.wall_time_ms),
    reportedCostUsd: num(r.cost_usd),
    reportedProvenance: r.provenance,
    sourceEventId: r.source_event_id,
    recordedAt: r.recorded_at,
  };
}

interface PriceRow {
  provider: string;
  model: string;
  effective_from: Date;
  input_usd_per_mtok: string;
  output_usd_per_mtok: string;
  cache_read_usd_per_mtok: string | null;
  cache_write_usd_per_mtok: string | null;
  source: string;
}

function toPrice(r: PriceRow): PriceEntry {
  return {
    provider: r.provider,
    model: r.model,
    effectiveFrom: r.effective_from,
    inputUsdPerMTok: Number(r.input_usd_per_mtok),
    outputUsdPerMTok: Number(r.output_usd_per_mtok),
    cacheReadUsdPerMTok: num(r.cache_read_usd_per_mtok),
    cacheWriteUsdPerMTok: num(r.cache_write_usd_per_mtok),
    source: r.source,
  };
}

interface BudgetRow {
  id: string;
  name: string;
  metric: BudgetMetric;
  limit_value: string;
  scope_type: BudgetScopeType;
  scope_value: string | null;
  time_window: BudgetWindow;
  enabled: boolean;
  version: number;
  created_by: string;
  created_at: Date;
  updated_by: string;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_by: string | null;
  billing: BudgetBilling;
  time_zone: string;
  thresholds: number[];
  on_exceeded: BudgetOnExceeded;
}

interface OverrideRow {
  id: string;
  budget_id: string;
  budget_version: number;
  window_start: Date;
  job_id: string | null;
  expires_at: Date;
  reason: string;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
}

function toOverride(r: OverrideRow): BudgetOverride {
  return {
    id: r.id,
    budgetId: r.budget_id,
    budgetVersion: r.budget_version,
    windowStart: r.window_start,
    jobId: r.job_id,
    expiresAt: r.expires_at,
    reason: r.reason,
    createdBy: r.created_by,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
  };
}

function toScope(type: BudgetScopeType, value: string | null): BudgetScope {
  if (type === 'global') return { type, value: null };
  return { type, value: value ?? '' };
}

function toBudget(r: BudgetRow): BudgetRecord {
  return {
    id: r.id,
    name: r.name,
    metric: r.metric,
    limit: Number(r.limit_value),
    scope: toScope(r.scope_type, r.scope_value),
    window: r.time_window,
    enabled: r.enabled,
    version: r.version,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    deletedBy: r.deleted_by,
    billing: r.billing,
    timeZone: r.time_zone,
    thresholds: r.thresholds,
    onExceeded: r.on_exceeded,
  };
}

/** Whether a record of `authMode` counts for a budget of `billing`. */
export function billingCovers(billing: BudgetBilling, authMode: AuthMode | null): boolean {
  if (billing === 'all') return true;
  return billing === 'subscription' ? authMode === 'local-login' : authMode !== 'local-login';
}

/**
 * The bucket key of a usage query: a whitelisted group-by column, none (totals), or an internal SQL expression
 * (p8-cost-efficiency: per job, per trend period). The expression builder may bind parameters; it never
 * interpolates caller input.
 */
export type BucketKey = GroupBy | null | { readonly sql: (params: unknown[]) => string };

interface BucketRow {
  key: string | null;
  auth_mode: AuthMode | null;
  has_reported: boolean;
  tokens_complete: boolean;
  provider: string | null;
  model: string | null;
  uses_cache_read: boolean;
  uses_cache_write: boolean;
  price_from: Date | null;
  records: number;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  tokens_unknown: number;
  turns: string;
  turns_unknown: number;
  wall_time_ms: string;
  wall_unknown: number;
  reported_cost: string;
}

/** Group-by columns (whitelist: the only values ever interpolated into SQL). */
const GROUP_COLUMN: Readonly<Record<GroupBy, string>> = {
  project: 'r.project',
  worker: 'r.worker_id',
  runtime: 'r.runtime',
  provider: 'r.provider',
  model: 'r.model',
};

const SCOPE_FILTER: Readonly<Record<Exclude<BudgetScopeType, 'global'>, keyof UsageFilter>> = {
  project: 'project',
  runtime: 'runtime',
  provider: 'provider',
  worker: 'worker',
};

/** Builds `AND …` conditions for a filter; values are always bound parameters. */
function filterSql(f: UsageFilter, params: unknown[]): string {
  const parts: string[] = [];
  const bind = (col: string, v: string | undefined): void => {
    if (v === undefined) return;
    params.push(v);
    parts.push(`${col} = $${String(params.length)}`);
  };
  bind('r.project', f.project);
  bind('r.worker_id', f.worker);
  bind('r.runtime', f.runtime);
  bind('r.provider', f.provider);
  bind('r.model', f.model);
  bind('r.job_id', f.jobId);
  bind('r.auth_mode', f.authMode);
  if (f.projects !== undefined && f.projects !== null) {
    params.push([...f.projects]);
    parts.push(`r.project = ANY($${String(params.length)}::text[])`);
  }
  if (f.billing === 'api') parts.push(`r.auth_mode IS DISTINCT FROM 'local-login'`);
  if (f.billing === 'subscription') parts.push(`r.auth_mode = 'local-login'`);
  if (f.jobIds !== undefined) {
    params.push([...f.jobIds]);
    parts.push(`r.job_id = ANY($${String(params.length)}::uuid[])`);
  }
  return parts.map((p) => ` AND ${p}`).join('');
}

function priceKey(provider: string, model: string, from: Date): string {
  return `${provider}\u0000${model}\u0000${String(from.getTime())}`;
}

/** Keyset cursor: base64url("<recordedAt ms>.<id>"). */
function encodeCursor(r: UsageRecord): string {
  return Buffer.from(`${String(r.recordedAt.getTime())}.${r.id}`).toString('base64url');
}

function decodeCursor(c: string): { at: Date; id: string } {
  const m = /^(\d{1,15})\.(\d{1,19})$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
  if (!m?.[1] || !m[2]) throw new InvalidUsageInputError([{ field: 'cursor', code: 'invalid' }]);
  return { at: new Date(Number(m[1])), id: m[2] };
}

// ------------------------------------------------------------------------------------------------ store

/**
 * Usage records, price table and budgets (docs/design/p6-cost.md). Pure math lives in @remyral/usage;
 * this class owns persistence, permissions, idempotency and auditing.
 */
export class UsageStore {
  private readonly pool: pg.Pool;
  private readonly audit: AuditRecorder;
  private readonly clock: () => Date;

  constructor(deps: UsageStoreDeps) {
    this.pool = deps.pool;
    this.audit = deps.audit;
    this.clock = deps.clock ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------------------- ingestion

  /**
   * Records one `usage` agent event for (job, attempt) from `workerId`. Idempotent per
   * (attempt, sourceEventId): a replay returns the stored record (`duplicate`) and changes nothing; a
   * replay with different content is reported as `conflicting` and audited, never applied. In the same
   * transaction, every enabled budget whose scope covers the record is evaluated and each newly crossed
   * 80 %/100 % threshold is written once to `usage_budget_alerts` and the outbox.
   *
   * Usage from an attempt that is no longer current is still recorded (the tokens were spent), but only
   * the worker that ran the attempt may report it.
   */
  async recordUsage(event: unknown, ctx: UsageEventContext): Promise<RecordUsageResult> {
    const parsed = AgentEvent.safeParse(event);
    if (!parsed.success || parsed.data.kind !== 'usage') {
      await this.denyIngest(ctx, 'invalid_event');
      throw new UsageRejectedError('invalid_event');
    }
    const ev = parsed.data;
    if (
      !UUID.test(ctx.jobId) ||
      !UUID.test(ctx.attemptId) ||
      !IDENT.test(ctx.workerId) ||
      !IDENT.test(ctx.sourceEventId)
    ) {
      await this.denyIngest(ctx, 'invalid_context');
      throw new UsageRejectedError('invalid_context');
    }
    const ctxProvider = ctx.provider?.trim().toLowerCase() ?? null;
    const provider =
      ev.provider ?? (ctxProvider !== null && PROVIDER_ID.test(ctxProvider) ? ctxProvider : null);
    const ctxModel = ctx.model ?? null;
    const authMode =
      ev.authMode ??
      (ctx.authMode && (AUTH_MODES as readonly string[]).includes(ctx.authMode) ? ctx.authMode : null);
    const now = this.clock();

    try {
      return await withTransaction(this.pool, async (tx) => {
        const { rows } = await tx.query<{
          project: string;
          runtime: string;
          spec_model: string | null;
          spec_runtime_version: string | null;
          worker_id: string;
        }>(
          `SELECT j.project, COALESCE(r.runtime_choice->>'runtime', j.spec->>'runtime') AS runtime,
                  CASE WHEN r.runtime_choice IS NULL OR (r.runtime_choice->>'index')::int = 0
                       THEN j.spec->>'model' ELSE r.runtime_choice->>'model' END AS spec_model,
                  CASE WHEN r.runtime_choice IS NULL OR (r.runtime_choice->>'index')::int = 0
                       THEN j.spec->>'runtimeVersion' END AS spec_runtime_version, a.worker_id
             FROM jobs j JOIN job_attempts a ON a.job_id = j.id
             LEFT JOIN job_runs r ON r.attempt_id = a.id
            WHERE j.id = $1 AND a.id = $2`,
          [ctx.jobId, ctx.attemptId],
        );
        const job = rows[0];
        if (!job) throw new UsageRejectedError('attempt_not_of_job');
        if (job.worker_id !== ctx.workerId) throw new UsageRejectedError('worker_mismatch');
        if (!RUNTIMES.has(job.runtime)) throw new UsageRejectedError('job_runtime_invalid');

        const modelCandidate = ev.model ?? ctxModel ?? job.spec_model;
        const model = modelCandidate !== null && MODEL_ID.test(modelCandidate) ? modelCandidate : null;
        const rv = cleanText(ctx.runtimeVersion ?? job.spec_runtime_version, 64);
        const values = {
          runtimeVersion: rv,
          provider,
          model,
          authMode,
          inputTokens: ev.inputTokens ?? null,
          outputTokens: ev.outputTokens ?? null,
          cacheReadTokens: ev.cacheReadTokens ?? null,
          cacheWriteTokens: ev.cacheWriteTokens ?? null,
          turns: ev.turns ?? null,
          wallTimeMs: ev.durationMs ?? null,
          costUsd: ev.costUsd ?? null,
          provenance: ev.provenance,
        };
        const payloadHash = createHash('sha256')
          .update(JSON.stringify(Object.entries(values)))
          .digest('hex');

        const inserted = await tx.query<RecordRow>(
          `INSERT INTO usage_records
             (job_id, attempt_id, worker_id, project, runtime, runtime_version, provider, model, auth_mode,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, turns, wall_time_ms, cost_usd,
              provenance, source_event_id, payload_hash, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
           ON CONFLICT (attempt_id, source_event_id) DO NOTHING
           RETURNING ${RECORD_COLUMNS}`,
          [
            ctx.jobId,
            ctx.attemptId,
            ctx.workerId,
            job.project,
            job.runtime,
            values.runtimeVersion,
            values.provider,
            values.model,
            values.authMode,
            values.inputTokens,
            values.outputTokens,
            values.cacheReadTokens,
            values.cacheWriteTokens,
            values.turns,
            values.wallTimeMs,
            values.costUsd,
            values.provenance,
            ctx.sourceEventId,
            payloadHash,
            now,
          ],
        );
        const row = inserted.rows[0];
        if (!row) {
          const existing = await tx.query<RecordRow>(
            `SELECT ${RECORD_COLUMNS} FROM usage_records WHERE attempt_id = $1 AND source_event_id = $2`,
            [ctx.attemptId, ctx.sourceEventId],
          );
          const prior = existing.rows[0];
          if (!prior) throw new Error('usage record conflict without a stored row');
          const conflicting = prior.payload_hash !== payloadHash;
          if (conflicting) {
            await this.audit.record(
              {
                actor: { type: 'worker', id: ctx.workerId },
                action: 'usage.record.conflict',
                target: `job:${ctx.jobId}`,
                outcome: 'denied',
                metadata: { attemptId: ctx.attemptId, sourceEventId: ctx.sourceEventId, recordId: prior.id },
              },
              tx,
            );
          }
          return { status: 'duplicate' as const, conflicting, record: toRecord(prior), alerts: [] };
        }
        const record = toRecord(row);
        const alerts = await this.checkBudgets(tx, record, now);
        return { status: 'recorded' as const, conflicting: false, record, alerts };
      });
    } catch (err) {
      if (err instanceof UsageRejectedError) await this.denyIngest(ctx, err.reason);
      throw err;
    }
  }

  private async denyIngest(ctx: Partial<UsageEventContext>, reason: string): Promise<void> {
    await this.audit.record({
      actor: { type: 'worker', id: typeof ctx.workerId === 'string' ? ctx.workerId.slice(0, 128) : null },
      action: 'usage.record',
      target: typeof ctx.jobId === 'string' ? `job:${ctx.jobId.slice(0, 64)}` : null,
      outcome: 'denied',
      metadata: { reason },
    });
  }

  /** Evaluates the budgets covering `record` and raises each newly crossed level once. */
  private async checkBudgets(tx: Queryable, record: UsageRecord, now: Date): Promise<BudgetAlert[]> {
    const { rows } = await tx.query<BudgetRow>(
      `SELECT * FROM usage_budgets
        WHERE deleted_at IS NULL AND enabled
          AND (scope_type = 'global'
               OR (scope_type = 'project' AND scope_value = $1)
               OR (scope_type = 'runtime' AND scope_value = $2)
               OR (scope_type = 'worker' AND scope_value = $3)
               OR (scope_type = 'provider' AND scope_value = $4))
        ORDER BY created_at, id`,
      [record.project, record.runtime, record.workerId, record.provider],
    );
    if (rows.length === 0) return [];
    const prices = await this.currentPriceTable(tx);
    const alerts: BudgetAlert[] = [];
    for (const row of rows) {
      const budget = toBudget(row);
      // p8: a subscription budget does not move with API usage (and vice versa).
      if (!billingCovers(budget.billing, record.authMode)) continue;
      const evaluation = await this.evaluateWith(tx, budget, record.recordedAt, prices);
      for (const pct of thresholdsReached(budget.thresholds, evaluation.used, budget.limit)) {
        const level = levelOfThreshold(pct);
        // Each threshold once per (budget version, window). An alert of this window written before p8 (no
        // percent: the 80 % `warning` / 100 % `exceeded` pair) counts as the same announcement.
        const ins = await tx.query(
          `INSERT INTO usage_budget_alerts
             (budget_id, budget_version, window_start, level, threshold_pct, used, complete, raised_at, job_id)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
            WHERE NOT EXISTS (SELECT 1 FROM usage_budget_alerts
                               WHERE budget_id = $1 AND budget_version = $2 AND window_start = $3
                                 AND threshold_pct IS NULL
                                 AND ((level = 'warning' AND $5::int = 80) OR (level = 'exceeded' AND $5::int = 100)))
           ON CONFLICT (budget_id, budget_version, window_start, threshold_pct) WHERE threshold_pct IS NOT NULL
           DO NOTHING RETURNING budget_id`,
          [
            budget.id,
            budget.version,
            evaluation.window.start,
            level,
            pct,
            evaluation.used,
            evaluation.complete,
            now,
            record.jobId,
          ],
        );
        if (ins.rowCount !== 1) continue;
        const payload: BudgetThresholdOutboxPayload = {
          budgetId: budget.id,
          budgetVersion: budget.version,
          name: budget.name,
          metric: budget.metric,
          limit: budget.limit,
          scope: { type: budget.scope.type, value: budget.scope.value },
          window: {
            kind: budget.window,
            start: evaluation.window.start.toISOString(),
            end: evaluation.window.end.toISOString(),
          },
          level,
          thresholdPct: pct,
          onExceeded: budget.onExceeded,
          billing: budget.billing,
          timeZone: budget.timeZone,
          status: evaluation.status,
          used: evaluation.used,
          ratio: evaluation.ratio,
          complete: evaluation.complete,
          unknownRecords: evaluation.unknownRecords,
          jobId: record.jobId,
          raisedAt: now.toISOString(),
        };
        await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, $2, $3, $4)', [
          OUTBOX_TOPIC_BUDGET_THRESHOLD,
          record.jobId,
          JSON.stringify(payload),
          now,
        ]);
        await this.audit.record(
          {
            actor: { type: 'system', id: 'usage' },
            action: 'usage.budget.threshold',
            target: `budget:${budget.id}`,
            outcome: 'success',
            metadata: {
              budgetId: budget.id,
              budgetVersion: budget.version,
              level,
              thresholdPct: pct,
              onExceeded: budget.onExceeded,
              status: evaluation.status,
              metric: budget.metric,
              used: evaluation.used,
              limit: budget.limit,
              complete: evaluation.complete,
              windowStart: evaluation.window.start.toISOString(),
              jobId: record.jobId,
            },
          },
          tx,
        );
        alerts.push({ budgetId: budget.id, level, thresholdPct: pct, evaluation });
      }
    }
    return alerts;
  }

  // ---------------------------------------------------------------------------------------- reads

  /** Aggregated usage per group with dollars, provenance coverage and gap flags (viewer+). */
  async summary(user: UsageActor, q: SummaryQuery): Promise<SummaryResult> {
    this.requireRole(user, USAGE_ROLES.readSummary);
    this.checkRange(q.from, q.to);
    const { version, entries } = await this.currentPriceTable(this.pool);
    const buckets = await this.buckets(this.pool, q.groupBy, q, q.from, q.to, version, entries);
    return { ...summarize(buckets), priceTableVersion: version };
  }

  /** Usage records, newest first, keyset-paginated, each with its derived cost (operator+). */
  async records(user: UsageActor, q: RecordsQuery): Promise<RecordsPage> {
    this.requireRole(user, USAGE_ROLES.readRecords);
    if (q.from && q.to && q.to <= q.from)
      throw new InvalidUsageInputError([{ field: 'to', code: 'before_from' }]);
    const limit = Math.min(Math.max(1, Math.trunc(q.limit)), LIMITS.maxRecordsPage);
    const params: unknown[] = [];
    let where = 'WHERE true';
    if (q.from) {
      params.push(q.from);
      where += ` AND r.recorded_at >= $${String(params.length)}`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND r.recorded_at < $${String(params.length)}`;
    }
    where += filterSql(q, params);
    if (q.cursor !== undefined) {
      const c = decodeCursor(q.cursor);
      params.push(c.at, c.id);
      where += ` AND (r.recorded_at, r.id) < ($${String(params.length - 1)}, $${String(params.length)}::bigint)`;
    }
    params.push(limit + 1);
    const { rows } = await this.pool.query<RecordRow>(
      `SELECT ${RECORD_COLUMNS}
         FROM usage_records r ${where}
        ORDER BY r.recorded_at DESC, r.id DESC LIMIT $${String(params.length)}`,
      params,
    );
    const { version, entries } = await this.currentPriceTable(this.pool);
    const page = rows.slice(0, limit).map(toRecord);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        ...r,
        cost: assessCost(
          {
            provider: r.provider,
            model: r.model,
            authMode: r.authMode,
            reportedProvenance: r.reportedProvenance,
            reportedCostUsd: r.reportedCostUsd,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            cacheReadTokens: r.cacheReadTokens,
            cacheWriteTokens: r.cacheWriteTokens,
            recordedAt: r.recordedAt,
          },
          entries,
        ),
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
      priceTableVersion: version,
    };
  }

  /** SQL GROUP BY over exactly the features `classify()` needs, priced via the current table. */
  private async buckets(
    db: Queryable,
    groupBy: BucketKey,
    filter: UsageFilter,
    from: Date,
    to: Date,
    priceVersion: number,
    prices: readonly PriceEntry[],
  ): Promise<UsageBucket[]> {
    const params: unknown[] = [priceVersion, from, to];
    const keyCol =
      groupBy === null
        ? 'NULL::text'
        : typeof groupBy === 'string'
          ? GROUP_COLUMN[groupBy]
          : groupBy.sql(params);
    const where = filterSql(filter, params);
    const { rows } = await db.query<BucketRow>(
      `SELECT ${keyCol} AS key,
              r.auth_mode,
              (r.provenance = 'reported-by-runtime' AND r.cost_usd IS NOT NULL) AS has_reported,
              (r.input_tokens IS NOT NULL AND r.output_tokens IS NOT NULL) AS tokens_complete,
              r.provider, r.model,
              (COALESCE(r.cache_read_tokens, 0) > 0) AS uses_cache_read,
              (COALESCE(r.cache_write_tokens, 0) > 0) AS uses_cache_write,
              p.effective_from AS price_from,
              count(*)::int AS records,
              COALESCE(sum(r.input_tokens), 0)::text AS input_tokens,
              COALESCE(sum(r.output_tokens), 0)::text AS output_tokens,
              COALESCE(sum(r.cache_read_tokens), 0)::text AS cache_read_tokens,
              COALESCE(sum(r.cache_write_tokens), 0)::text AS cache_write_tokens,
              (count(*) FILTER (WHERE r.input_tokens IS NULL OR r.output_tokens IS NULL))::int AS tokens_unknown,
              COALESCE(sum(r.turns), 0)::text AS turns,
              (count(*) FILTER (WHERE r.turns IS NULL))::int AS turns_unknown,
              COALESCE(sum(r.wall_time_ms), 0)::text AS wall_time_ms,
              (count(*) FILTER (WHERE r.wall_time_ms IS NULL))::int AS wall_unknown,
              COALESCE(sum(r.cost_usd), 0)::text AS reported_cost
         FROM usage_records r
         LEFT JOIN LATERAL (
           SELECT up.effective_from FROM usage_prices up
            WHERE up.version = $1 AND up.provider = r.provider AND up.model = r.model
              AND up.effective_from <= r.recorded_at
            ORDER BY up.effective_from DESC LIMIT 1
         ) p ON true
        WHERE r.recorded_at >= $2 AND r.recorded_at < $3${where}
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`,
      params,
    );
    const byKey = new Map(prices.map((p) => [priceKey(p.provider, p.model, p.effectiveFrom), p]));
    return rows.map((r) => ({
      key: r.key,
      authMode: r.auth_mode,
      hasReportedCost: r.has_reported,
      tokensComplete: r.tokens_complete,
      provider: r.provider,
      model: r.model,
      usesCacheRead: r.uses_cache_read,
      usesCacheWrite: r.uses_cache_write,
      price:
        r.price_from !== null && r.provider !== null && r.model !== null
          ? (byKey.get(priceKey(r.provider, r.model, r.price_from)) ?? null)
          : null,
      records: r.records,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      tokensUnknownRecords: r.tokens_unknown,
      turns: Number(r.turns),
      turnsUnknownRecords: r.turns_unknown,
      wallTimeMs: Number(r.wall_time_ms),
      wallTimeUnknownRecords: r.wall_unknown,
      reportedCostUsd: Number(r.reported_cost),
    }));
  }

  // ---------------------------------------------------------------------------------------- prices

  async priceTable(user: UsageActor, version?: number): Promise<PriceTable> {
    this.requireRole(user, USAGE_ROLES.readSummary);
    if (version === undefined) return this.currentPriceTableMeta(this.pool);
    if (version === 0) return { version: 0, note: null, createdBy: null, createdAt: null, entries: [] };
    const meta = await this.pool.query<{ note: string | null; created_by: string; created_at: Date }>(
      'SELECT note, created_by, created_at FROM usage_price_tables WHERE version = $1',
      [version],
    );
    const m = meta.rows[0];
    if (!m) throw new UsageNotFoundError(`price table version ${String(version)}`);
    return {
      version,
      note: m.note,
      createdBy: m.created_by,
      createdAt: m.created_at,
      entries: await this.priceEntries(this.pool, version),
    };
  }

  async priceTableVersions(user: UsageActor): Promise<PriceTableVersionMeta[]> {
    this.requireRole(user, USAGE_ROLES.readSummary);
    const { rows } = await this.pool.query<{
      version: number;
      note: string | null;
      entry_count: number;
      created_by: string;
      created_at: Date;
    }>(
      'SELECT version, note, entry_count, created_by, created_at FROM usage_price_tables ORDER BY version DESC LIMIT 200',
    );
    return rows.map((r) => ({
      version: r.version,
      note: r.note,
      entryCount: r.entry_count,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  /**
   * Replaces the price table with a complete new version (admin+, fresh step-up). Optimistic:
   * `expectedVersion` must be the current version. Earlier versions stay readable.
   */
  async replacePriceTable(
    user: UsageActor,
    input: ReplacePriceTableInput,
    meta: RequestMeta,
  ): Promise<PriceTable> {
    return this.audited('usage.prices.update', user, 'usage:prices', meta, async () => {
      this.requirePrivileged(user, USAGE_ROLES.writePrices);
      const entries = this.validatePrices(input.entries);
      const note = cleanText(input.note, LIMITS.maxNoteLength);
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
        throw new InvalidUsageInputError([{ field: 'expectedVersion', code: 'invalid' }]);
      }
      try {
        return await withTransaction(this.pool, async (tx) => {
          const current = await this.latestPriceVersion(tx);
          if (current !== input.expectedVersion) {
            throw new UsageVersionConflictError('price table', input.expectedVersion, current);
          }
          const version = current + 1;
          const now = this.clock();
          await tx.query(
            'INSERT INTO usage_price_tables (version, note, entry_count, created_by, created_at) VALUES ($1, $2, $3, $4, $5)',
            [version, note, entries.length, user.id, now],
          );
          for (const e of entries) {
            await tx.query(
              `INSERT INTO usage_prices (version, provider, model, effective_from, input_usd_per_mtok, output_usd_per_mtok,
                 cache_read_usd_per_mtok, cache_write_usd_per_mtok, source)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                version,
                e.provider,
                e.model,
                e.effectiveFrom,
                e.inputUsdPerMTok,
                e.outputUsdPerMTok,
                e.cacheReadUsdPerMTok,
                e.cacheWriteUsdPerMTok,
                e.source,
              ],
            );
          }
          await this.audit.record(
            {
              actor: { type: 'user', id: user.id },
              action: 'usage.prices.update',
              target: 'usage:prices',
              outcome: 'success',
              ip: meta.ip ?? null,
              userAgent: meta.userAgent ?? null,
              metadata: { version, previousVersion: current, entries: entries.length },
            },
            tx,
          );
          return {
            version,
            note,
            createdBy: user.id,
            createdAt: now,
            entries: await this.priceEntries(tx, version),
          };
        });
      } catch (err) {
        // Two editors racing past the version check collide on the version primary key.
        if (isUniqueViolation(err)) {
          throw new UsageVersionConflictError(
            'price table',
            input.expectedVersion,
            input.expectedVersion + 1,
          );
        }
        throw err;
      }
    });
  }

  private validatePrices(input: readonly PriceEntryInput[]): PriceEntry[] {
    const issues: InputIssue[] = [];
    if (input.length > LIMITS.maxPriceEntries) issues.push({ field: 'entries', code: 'too_many' });
    const seen = new Set<string>();
    const out: PriceEntry[] = [];
    const price = (
      v: number | null | undefined,
      field: string,
      i: number,
      required: boolean,
    ): number | null => {
      if (v === undefined || v === null) {
        if (required) issues.push({ field: `entries.${String(i)}.${field}`, code: 'required' });
        return null;
      }
      if (!Number.isFinite(v) || v < 0 || v > LIMITS.maxUsdPerMTok) {
        issues.push({ field: `entries.${String(i)}.${field}`, code: 'out_of_range' });
      }
      return v;
    };
    input.forEach((e, i) => {
      const provider = e.provider.trim().toLowerCase();
      const model = e.model.trim();
      if (!PROVIDER_ID.test(provider))
        issues.push({ field: `entries.${String(i)}.provider`, code: 'invalid' });
      if (!MODEL_ID.test(model)) issues.push({ field: `entries.${String(i)}.model`, code: 'invalid' });
      if (Number.isNaN(e.effectiveFrom.getTime())) {
        issues.push({ field: `entries.${String(i)}.effectiveFrom`, code: 'invalid' });
      }
      const source = cleanText(e.source, LIMITS.maxSourceLength);
      if (source === null) issues.push({ field: `entries.${String(i)}.source`, code: 'required' });
      const key = priceKey(provider, model, e.effectiveFrom);
      if (seen.has(key)) issues.push({ field: `entries.${String(i)}`, code: 'duplicate' });
      seen.add(key);
      out.push({
        provider,
        model,
        effectiveFrom: e.effectiveFrom,
        inputUsdPerMTok: price(e.inputUsdPerMTok, 'inputUsdPerMTok', i, true) ?? 0,
        outputUsdPerMTok: price(e.outputUsdPerMTok, 'outputUsdPerMTok', i, true) ?? 0,
        cacheReadUsdPerMTok: price(e.cacheReadUsdPerMTok, 'cacheReadUsdPerMTok', i, false),
        cacheWriteUsdPerMTok: price(e.cacheWriteUsdPerMTok, 'cacheWriteUsdPerMTok', i, false),
        source: source ?? '',
      });
    });
    if (issues.length > 0) throw new InvalidUsageInputError(issues.slice(0, 50));
    return out;
  }

  private async latestPriceVersion(db: Queryable): Promise<number> {
    const { rows } = await db.query<{ v: number | null }>('SELECT max(version) AS v FROM usage_price_tables');
    return rows[0]?.v ?? 0;
  }

  private async priceEntries(db: Queryable, version: number): Promise<PriceEntry[]> {
    const { rows } = await db.query<PriceRow>(
      `SELECT provider, model, effective_from, input_usd_per_mtok::text, output_usd_per_mtok::text,
              cache_read_usd_per_mtok::text, cache_write_usd_per_mtok::text, source
         FROM usage_prices WHERE version = $1 ORDER BY provider, model, effective_from`,
      [version],
    );
    return rows.map(toPrice);
  }

  private async currentPriceTable(db: Queryable): Promise<{ version: number; entries: PriceEntry[] }> {
    const version = await this.latestPriceVersion(db);
    return { version, entries: version === 0 ? [] : await this.priceEntries(db, version) };
  }

  private async currentPriceTableMeta(db: Queryable): Promise<PriceTable> {
    const { rows } = await db.query<{
      version: number;
      note: string | null;
      created_by: string;
      created_at: Date;
    }>('SELECT version, note, created_by, created_at FROM usage_price_tables ORDER BY version DESC LIMIT 1');
    const m = rows[0];
    if (!m) return { version: 0, note: null, createdBy: null, createdAt: null, entries: [] };
    return {
      version: m.version,
      note: m.note,
      createdBy: m.created_by,
      createdAt: m.created_at,
      entries: await this.priceEntries(db, m.version),
    };
  }

  // ---------------------------------------------------------------------------------------- budgets

  /**
   * `projects` (p5-rbac scoping): when set, only project-scoped budgets of these projects are visible —
   * global/runtime/worker/provider budgets aggregate across projects and stay owner/admin-only.
   */
  async listBudgets(
    user: UsageActor,
    opts: { includeDeleted?: boolean; projects?: readonly string[] | null } = {},
  ): Promise<BudgetView[]> {
    this.requireRole(user, USAGE_ROLES.readSummary);
    const scoped = opts.projects !== undefined && opts.projects !== null;
    const { rows } = await this.pool.query<BudgetRow>(
      `SELECT * FROM usage_budgets
        WHERE ($1::boolean OR deleted_at IS NULL)
          AND (NOT $2::boolean OR (scope_type = 'project' AND scope_value = ANY($3::text[])))
        ORDER BY created_at, id LIMIT 500`,
      [opts.includeDeleted === true, scoped, scoped ? [...(opts.projects ?? [])] : []],
    );
    const prices = await this.currentPriceTable(this.pool);
    const now = this.clock();
    const out: BudgetView[] = [];
    for (const r of rows) {
      const budget = toBudget(r);
      out.push({
        budget,
        evaluation:
          budget.deletedAt === null ? await this.evaluateWith(this.pool, budget, now, prices) : null,
      });
    }
    return out;
  }

  async getBudget(user: UsageActor, id: string, projects?: readonly string[] | null): Promise<BudgetView> {
    this.requireRole(user, USAGE_ROLES.readSummary);
    const budget = await this.requireBudget(this.pool, id);
    if (
      projects !== undefined &&
      projects !== null &&
      !(budget.scope.type === 'project' && projects.includes(budget.scope.value))
    ) {
      throw new UsageNotFoundError(`budget ${id}`);
    }
    return {
      budget,
      evaluation:
        budget.deletedAt === null
          ? await this.evaluateWith(this.pool, budget, this.clock(), await this.currentPriceTable(this.pool))
          : null,
    };
  }

  /**
   * Budget input for p4-quotas: evaluation of one budget for the window containing `at` (default now).
   * No permission check (internal callers only; there is no route that reaches it without one).
   */
  async evaluateBudget(id: string, at: Date = this.clock()): Promise<BudgetEvaluation> {
    const budget = await this.requireBudget(this.pool, id);
    if (budget.deletedAt !== null) throw new UsageNotFoundError(`budget ${id}`);
    return this.evaluateWith(this.pool, budget, at, await this.currentPriceTable(this.pool));
  }

  /**
   * Aggregated consumption of the records matching `filter` in [from, to) with the current price table
   * (p4-quotas: per-job run limits). Internal callers only, like {@link evaluateBudget}.
   */
  async consumption(filter: UsageFilter, from: Date, to: Date): Promise<GroupSummary> {
    const prices = await this.currentPriceTable(this.pool);
    const buckets = await this.buckets(this.pool, null, filter, from, to, prices.version, prices.entries);
    return summarize(buckets).totals;
  }

  /** Active budgets of the given scope types, evaluated now (p4-quotas: worker/provider budgets). */
  async evaluateBudgetsOfScopes(
    scopes: readonly BudgetScopeType[],
    at: Date = this.clock(),
  ): Promise<{ budget: BudgetRecord; evaluation: BudgetEvaluation }[]> {
    const { rows } = await this.pool.query<BudgetRow>(
      `SELECT * FROM usage_budgets WHERE deleted_at IS NULL AND enabled AND scope_type = ANY($1::text[])
        ORDER BY created_at, id`,
      [[...scopes]],
    );
    const prices = await this.currentPriceTable(this.pool);
    const out: { budget: BudgetRecord; evaluation: BudgetEvaluation }[] = [];
    for (const r of rows) {
      const budget = toBudget(r);
      out.push({ budget, evaluation: await this.evaluateWith(this.pool, budget, at, prices) });
    }
    return out;
  }

  /** Every active budget that covers a (project, runtime, worker, provider) tuple, evaluated now. */
  async evaluateBudgetsFor(
    target: { project?: string; runtime?: string; worker?: string; provider?: string },
    at: Date = this.clock(),
  ): Promise<{ budget: BudgetRecord; evaluation: BudgetEvaluation }[]> {
    const { rows } = await this.pool.query<BudgetRow>(
      `SELECT * FROM usage_budgets
        WHERE deleted_at IS NULL AND enabled
          AND (scope_type = 'global'
               OR (scope_type = 'project' AND scope_value = $1)
               OR (scope_type = 'runtime' AND scope_value = $2)
               OR (scope_type = 'worker' AND scope_value = $3)
               OR (scope_type = 'provider' AND scope_value = $4))
        ORDER BY created_at, id`,
      [target.project ?? null, target.runtime ?? null, target.worker ?? null, target.provider ?? null],
    );
    const prices = await this.currentPriceTable(this.pool);
    const out: { budget: BudgetRecord; evaluation: BudgetEvaluation }[] = [];
    for (const r of rows) {
      const budget = toBudget(r);
      out.push({ budget, evaluation: await this.evaluateWith(this.pool, budget, at, prices) });
    }
    return out;
  }

  async createBudget(user: UsageActor, input: BudgetInput, meta: RequestMeta): Promise<BudgetView> {
    return this.audited('usage.budget.create', user, 'usage:budgets', meta, async () => {
      this.requirePrivileged(user, USAGE_ROLES.writeBudgets);
      const v = this.validateBudget(input);
      const now = this.clock();
      return withTransaction(this.pool, async (tx) => {
        const { rows } = await tx.query<BudgetRow>(
          `INSERT INTO usage_budgets (name, metric, limit_value, scope_type, scope_value, time_window, enabled,
             created_by, created_at, updated_by, updated_at, billing, time_zone, thresholds, on_exceeded)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $9, $10, $11, $12, $13) RETURNING *`,
          [
            v.name,
            v.metric,
            v.limit,
            v.scope.type,
            v.scope.value,
            v.window,
            v.enabled,
            user.id,
            now,
            v.billing,
            v.timeZone,
            v.thresholds,
            v.onExceeded,
          ],
        );
        const row = rows[0];
        if (!row) throw new Error('budget insert returned no row');
        const budget = toBudget(row);
        await this.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'usage.budget.create',
            target: `budget:${budget.id}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: budgetMeta(budget),
          },
          tx,
        );
        return {
          budget,
          evaluation: await this.evaluateWith(tx, budget, now, await this.currentPriceTable(tx)),
        };
      });
    });
  }

  async updateBudget(
    user: UsageActor,
    id: string,
    input: BudgetInput & { readonly expectedVersion: number },
    meta: RequestMeta,
  ): Promise<BudgetView> {
    return this.audited('usage.budget.update', user, `budget:${id}`, meta, async () => {
      this.requirePrivileged(user, USAGE_ROLES.writeBudgets);
      this.validateBudget(input, { billing: 'all', timeZone: 'UTC', thresholds: [100], onExceeded: 'warn' });
      const now = this.clock();
      return withTransaction(this.pool, async (tx) => {
        const prev = await this.requireBudget(tx, id, true);
        if (prev.deletedAt !== null) throw new UsageNotFoundError(`budget ${id}`);
        if (prev.version !== input.expectedVersion) {
          throw new UsageVersionConflictError(`budget ${id}`, input.expectedVersion, prev.version);
        }
        // p8 fields left out keep their stored value (clients written before p8 send the p6 body).
        const v = this.validateBudget(input, prev);
        const { rows } = await tx.query<BudgetRow>(
          `UPDATE usage_budgets SET name = $2, metric = $3, limit_value = $4, scope_type = $5, scope_value = $6,
                  time_window = $7, enabled = $8, version = version + 1, updated_by = $9, updated_at = $10,
                  billing = $11, time_zone = $12, thresholds = $13, on_exceeded = $14
            WHERE id = $1 RETURNING *`,
          [
            id,
            v.name,
            v.metric,
            v.limit,
            v.scope.type,
            v.scope.value,
            v.window,
            v.enabled,
            user.id,
            now,
            v.billing,
            v.timeZone,
            v.thresholds,
            v.onExceeded,
          ],
        );
        const row = rows[0];
        if (!row) throw new UsageNotFoundError(`budget ${id}`);
        const budget = toBudget(row);
        await this.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'usage.budget.update',
            target: `budget:${id}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: { ...budgetMeta(budget), previous: budgetMeta(prev) },
          },
          tx,
        );
        return {
          budget,
          evaluation: await this.evaluateWith(tx, budget, now, await this.currentPriceTable(tx)),
        };
      });
    });
  }

  async deleteBudget(
    user: UsageActor,
    id: string,
    expectedVersion: number,
    meta: RequestMeta,
  ): Promise<BudgetRecord> {
    return this.audited('usage.budget.delete', user, `budget:${id}`, meta, async () => {
      this.requirePrivileged(user, USAGE_ROLES.writeBudgets);
      const now = this.clock();
      return withTransaction(this.pool, async (tx) => {
        const prev = await this.requireBudget(tx, id, true);
        if (prev.deletedAt !== null) throw new UsageNotFoundError(`budget ${id}`);
        if (prev.version !== expectedVersion) {
          throw new UsageVersionConflictError(`budget ${id}`, expectedVersion, prev.version);
        }
        const { rows } = await tx.query<BudgetRow>(
          `UPDATE usage_budgets SET deleted_at = $2, deleted_by = $3, version = version + 1, updated_by = $3,
                  updated_at = $2
            WHERE id = $1 RETURNING *`,
          [id, now, user.id],
        );
        const row = rows[0];
        if (!row) throw new UsageNotFoundError(`budget ${id}`);
        await this.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'usage.budget.delete',
            target: `budget:${id}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: budgetMeta(prev),
          },
          tx,
        );
        return toBudget(row);
      });
    });
  }

  /**
   * p18-leftovers: the console's budget checks without a write (the chat's draft_budget_change plans a card with them;
   * the write itself checks again). Throws InvalidUsageInputError like createBudget / updateBudget.
   */
  checkBudgetInput(
    input: BudgetInput,
    prev?: Pick<BudgetRecord, 'billing' | 'timeZone' | 'thresholds' | 'onExceeded'>,
  ): ReturnType<UsageStore['validateBudget']> {
    return this.validateBudget(input, prev);
  }

  private validateBudget(
    input: BudgetInput,
    prev?: Pick<BudgetRecord, 'billing' | 'timeZone' | 'thresholds' | 'onExceeded'>,
  ): {
    name: string;
    metric: BudgetMetric;
    limit: number;
    scope: BudgetScope;
    window: BudgetWindow;
    enabled: boolean;
    billing: BudgetBilling;
    timeZone: string;
    thresholds: number[];
    onExceeded: BudgetOnExceeded;
  } {
    const issues: InputIssue[] = [];
    const billing = input.billing ?? prev?.billing ?? 'all';
    if (!(BUDGET_BILLINGS as readonly string[]).includes(billing)) {
      issues.push({ field: 'billing', code: 'invalid' });
    } else if (billing === 'subscription' && input.metric === 'cost_usd') {
      // ADR-0014: subscription runs have no per-run dollars — budget them by tokens, turns or hours.
      issues.push({ field: 'billing', code: 'subscription_has_no_dollars' });
    }
    const timeZone = input.timeZone ?? prev?.timeZone ?? 'UTC';
    if (!isValidTimeZone(timeZone)) issues.push({ field: 'timeZone', code: 'invalid' });
    const thresholds = normalizeThresholds(input.thresholds ?? prev?.thresholds ?? DEFAULT_THRESHOLDS_PCT);
    if (thresholds === null) issues.push({ field: 'thresholds', code: 'invalid' });
    const onExceeded = input.onExceeded ?? prev?.onExceeded ?? 'pause_new';
    if (!(BUDGET_ON_EXCEEDED as readonly string[]).includes(onExceeded)) {
      issues.push({ field: 'onExceeded', code: 'invalid' });
    }
    const name = cleanText(input.name, LIMITS.maxBudgetNameLength + 1);
    if (name === null) issues.push({ field: 'name', code: 'required' });
    else if (name.length > LIMITS.maxBudgetNameLength) issues.push({ field: 'name', code: 'too_long' });
    if (!(BUDGET_METRICS as readonly string[]).includes(input.metric))
      issues.push({ field: 'metric', code: 'invalid' });
    if (!(BUDGET_WINDOWS as readonly string[]).includes(input.window))
      issues.push({ field: 'window', code: 'invalid' });
    if (!Number.isFinite(input.limit) || input.limit <= 0 || input.limit > LIMITS.maxBudgetLimit) {
      issues.push({ field: 'limit', code: 'out_of_range' });
    } else if (input.metric !== 'cost_usd' && !Number.isInteger(input.limit)) {
      issues.push({ field: 'limit', code: 'not_integer' });
    }
    let scope: BudgetScope = { type: 'global', value: null };
    if (!(BUDGET_SCOPE_TYPES as readonly string[]).includes(input.scopeType)) {
      issues.push({ field: 'scopeType', code: 'invalid' });
    } else if (input.scopeType === 'global') {
      if (input.scopeValue !== undefined && input.scopeValue !== null && input.scopeValue !== '') {
        issues.push({ field: 'scopeValue', code: 'not_allowed' });
      }
    } else {
      let value = input.scopeValue?.trim() ?? '';
      if (input.scopeType === 'provider') value = value.toLowerCase();
      const ok =
        input.scopeType === 'runtime'
          ? RUNTIMES.has(value)
          : input.scopeType === 'provider'
            ? PROVIDER_ID.test(value)
            : IDENT.test(value) && SCOPE_VALUE.test(value);
      if (!ok) issues.push({ field: 'scopeValue', code: value === '' ? 'required' : 'invalid' });
      scope = { type: input.scopeType, value };
    }
    if (issues.length > 0) throw new InvalidUsageInputError(issues);
    return {
      name: name ?? '',
      metric: input.metric,
      limit: input.limit,
      scope,
      window: input.window,
      enabled: input.enabled ?? true,
      billing,
      timeZone,
      thresholds: thresholds ?? [],
      onExceeded,
    };
  }

  private async requireBudget(db: Queryable, id: string, forUpdate = false): Promise<BudgetRecord> {
    if (!UUID.test(id)) throw new UsageNotFoundError(`budget ${id}`);
    const { rows } = await db.query<BudgetRow>(
      `SELECT * FROM usage_budgets WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new UsageNotFoundError(`budget ${id}`);
    return toBudget(row);
  }

  private async evaluateWith(
    db: Queryable,
    budget: BudgetRecord,
    at: Date,
    prices: { version: number; entries: readonly PriceEntry[] },
  ): Promise<BudgetEvaluation> {
    const window = windowBounds(budget.window, at, budget.timeZone);
    const filter: UsageFilter = {
      ...(budget.scope.type === 'global' ? {} : { [SCOPE_FILTER[budget.scope.type]]: budget.scope.value }),
      billing: budget.billing,
    };
    const buckets = await this.buckets(
      db,
      null,
      filter,
      window.start,
      window.end,
      prices.version,
      prices.entries,
    );
    return evaluateBudget(budget, summarize(buckets).totals, window);
  }

  // ---------------------------------------------------------------------------------------- p8 queries

  /**
   * p8-cost-efficiency: priced usage buckets for [from, to) keyed by `key` (a group-by column or an internal SQL
   * expression), for the efficiency dashboard and the weekly report, which regroup and summarise them. Internal
   * callers only (they apply the caller's project visibility through `filter.projects`).
   */
  async pricedBuckets(
    key: BucketKey,
    filter: UsageFilter,
    from: Date,
    to: Date,
  ): Promise<{ buckets: UsageBucket[]; priceTableVersion: number }> {
    const prices = await this.currentPriceTable(this.pool);
    return {
      buckets: await this.buckets(this.pool, key, filter, from, to, prices.version, prices.entries),
      priceTableVersion: prices.version,
    };
  }

  // ---------------------------------------------------------------------------------------- p8 overrides

  /**
   * Overrides of these budgets that are in force at `at` (not revoked, not expired). The caller still checks that
   * an override belongs to the budget's current version and window ({@link overrideApplies}).
   */
  async activeOverrides(budgetIds: readonly string[], at: Date = this.clock()): Promise<BudgetOverride[]> {
    if (budgetIds.length === 0) return [];
    const { rows } = await this.pool.query<OverrideRow>(
      `SELECT * FROM usage_budget_overrides
        WHERE budget_id = ANY($1::uuid[]) AND revoked_at IS NULL AND expires_at > $2 AND created_at <= $2
        ORDER BY created_at`,
      [[...budgetIds], at],
    );
    return rows.map(toOverride);
  }

  /** The overrides of one budget, newest first (budgets.read visibility as {@link getBudget}). */
  async listOverrides(
    user: UsageActor,
    budgetId: string,
    projects?: readonly string[] | null,
  ): Promise<BudgetOverride[]> {
    await this.getBudget(user, budgetId, projects);
    const { rows } = await this.pool.query<OverrideRow>(
      'SELECT * FROM usage_budget_overrides WHERE budget_id = $1 ORDER BY created_at DESC LIMIT 50',
      [budgetId],
    );
    return rows.map(toOverride);
  }

  /**
   * Lets work through an exhausted budget until `until` (default and maximum: the end of the current window), for
   * every job the budget holds or for one job (owner/admin, fresh step-up, audited `usage.budget.override`).
   */
  async createOverride(
    user: UsageActor,
    budgetId: string,
    input: BudgetOverrideInput,
    meta: RequestMeta,
  ): Promise<BudgetOverride> {
    return this.audited('usage.budget.override', user, `budget:${budgetId}`, meta, async () => {
      this.requirePrivileged(user, USAGE_ROLES.overrideBudgets);
      const now = this.clock();
      const issues: InputIssue[] = [];
      const reason = cleanText(input.reason, LIMITS.maxOverrideReasonLength + 1);
      if (reason === null) issues.push({ field: 'reason', code: 'required' });
      else if (reason.length > LIMITS.maxOverrideReasonLength)
        issues.push({ field: 'reason', code: 'too_long' });
      const jobId = input.jobId ?? null;
      if (jobId !== null && !UUID.test(jobId)) issues.push({ field: 'jobId', code: 'invalid' });
      if (issues.length > 0) throw new InvalidUsageInputError(issues);
      return withTransaction(this.pool, async (tx) => {
        const budget = await this.requireBudget(tx, budgetId, true);
        if (budget.deletedAt !== null) throw new UsageNotFoundError(`budget ${budgetId}`);
        const window = windowBounds(budget.window, now, budget.timeZone);
        const until = input.until ?? window.end;
        if (Number.isNaN(until.getTime()) || until <= now || until > window.end) {
          throw new InvalidUsageInputError([{ field: 'until', code: 'out_of_window' }]);
        }
        if (jobId !== null) {
          const { rows: jobs } = await tx.query<{ project: string }>(
            'SELECT project FROM jobs WHERE id = $1',
            [jobId],
          );
          const job = jobs[0];
          if (job === undefined || (budget.scope.type === 'project' && job.project !== budget.scope.value)) {
            throw new InvalidUsageInputError([{ field: 'jobId', code: 'not_in_scope' }]);
          }
        }
        const { rows } = await tx.query<OverrideRow>(
          `INSERT INTO usage_budget_overrides
             (budget_id, budget_version, window_start, job_id, expires_at, reason, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [budget.id, budget.version, window.start, jobId, until, reason ?? '', user.id, now],
        );
        const row = rows[0];
        if (!row) throw new Error('override insert returned no row');
        const o = toOverride(row);
        await this.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'usage.budget.override',
            target: `budget:${budget.id}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: {
              overrideId: o.id,
              budgetId: budget.id,
              budgetVersion: budget.version,
              windowStart: window.start.toISOString(),
              jobId,
              expiresAt: until.toISOString(),
              reasonLength: (reason ?? '').length,
            },
          },
          tx,
        );
        return o;
      });
    });
  }

  /** Ends an override early (owner/admin, fresh step-up, audited `usage.budget.override.revoke`). */
  async revokeOverride(
    user: UsageActor,
    budgetId: string,
    overrideId: string,
    meta: RequestMeta,
  ): Promise<BudgetOverride> {
    return this.audited('usage.budget.override.revoke', user, `budget:${budgetId}`, meta, async () => {
      this.requirePrivileged(user, USAGE_ROLES.overrideBudgets);
      if (!UUID.test(overrideId)) throw new UsageNotFoundError(`override ${overrideId}`);
      const now = this.clock();
      return withTransaction(this.pool, async (tx) => {
        const { rows } = await tx.query<OverrideRow>(
          `UPDATE usage_budget_overrides SET revoked_at = $3, revoked_by = $4
            WHERE id = $1 AND budget_id = $2 AND revoked_at IS NULL RETURNING *`,
          [overrideId, budgetId, now, user.id],
        );
        const row = rows[0];
        if (!row) throw new UsageNotFoundError(`override ${overrideId}`);
        await this.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'usage.budget.override.revoke',
            target: `budget:${budgetId}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: { overrideId, budgetId },
          },
          tx,
        );
        return toOverride(row);
      });
    });
  }

  // ---------------------------------------------------------------------------------------- helpers

  private checkRange(from: Date, to: Date): void {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new InvalidUsageInputError([{ field: 'from', code: 'invalid' }]);
    }
    if (to <= from) throw new InvalidUsageInputError([{ field: 'to', code: 'before_from' }]);
    if (to.getTime() - from.getTime() > LIMITS.maxRangeDays * 86_400_000) {
      throw new InvalidUsageInputError([{ field: 'to', code: 'range_too_long' }]);
    }
  }

  private requireRole(user: UsageActor, required: Role): void {
    if (!roleAtLeast(user.role, required)) throw new UsageForbiddenError('role');
  }

  private requirePrivileged(user: UsageActor, required: Role): void {
    this.requireRole(user, required);
    if (!stepUpFresh(user.mfaAt, this.clock(), user.stepUpMaxAgeMs)) throw new UsageStepUpRequiredError();
  }

  /** Runs a human write; refusals (UsageError) are audited as `denied` with the error code only. */
  private async audited<T>(
    action: string,
    user: UsageActor,
    target: string,
    meta: RequestMeta,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof UsageError) {
        await this.audit.record({
          actor: { type: 'user', id: user.id },
          action,
          target,
          outcome: 'denied',
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: {
            code: err.code,
            ...(err instanceof InvalidUsageInputError
              ? { issues: err.issues.map((i) => `${i.field}:${i.code}`) }
              : {}),
          },
        });
      }
      throw err;
    }
  }
}

/**
 * Whether an override lets `jobId` through `budget` for the window containing `at`: the same budget version and
 * window, not revoked, not expired, and either for every job or for this one.
 */
export function overrideApplies(
  o: BudgetOverride,
  budget: BudgetRecord,
  at: Date,
  jobId: string | null,
): boolean {
  if (o.budgetId !== budget.id || o.budgetVersion !== budget.version || o.revokedAt !== null) return false;
  if (o.expiresAt <= at || o.createdAt > at) return false;
  if (o.windowStart.getTime() !== windowBounds(budget.window, at, budget.timeZone).start.getTime())
    return false;
  return o.jobId === null || o.jobId === jobId;
}

function budgetMeta(b: BudgetRecord): Record<string, unknown> {
  return {
    budgetId: b.id,
    version: b.version,
    metric: b.metric,
    limit: b.limit,
    scopeType: b.scope.type,
    scopeValue: b.scope.value,
    window: b.window,
    enabled: b.enabled,
    billing: b.billing,
    timeZone: b.timeZone,
    thresholds: b.thresholds.join(','),
    onExceeded: b.onExceeded,
  };
}
