import { deriveJobTitle } from '@remyral/protocol/job-title';
import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';
import { type DownloadOptions, downloadExport, type ExportResult } from './download';
import { type JobPauseView, parsePause } from './approvalPause';
import { type ApprovalHeadline, parseApprovalHeadline } from './approvalDetails';
import { parseReason, type ReasonParams, reasonParamsField } from '../lib/reasons';

/**
 * Typed wrappers for the read-only jobs API (apps/master/src/jobs/read-routes.ts,
 * docs/design/p5-search-audit.md §4). Prompts, reasons and approval summaries are untrusted text.
 */

export const JOB_STATES = [
  'DRAFT',
  'QUEUED',
  'RESERVED',
  'STARTING',
  'RUNNING',
  'VERIFYING',
  'AWAITING_APPROVAL',
  'SUCCEEDED',
  'RETRY_WAIT',
  'FAILED',
  'CANCELLING',
  'CANCELLED',
  'BLOCKED',
  'LOST',
  // p10-approval-pause: waiting for an approval with its machine slot freed (resumes on the same machine).
  'PAUSED',
] as const;
export type JobState = (typeof JOB_STATES)[number];
/**
 * Runtimes the job list filters by: the four the platform runs, plus OpenHands, which was removed (ADR-0023) but
 * still names stored history (read-only).
 */
export const RUNTIMES = ['claude-code', 'codex', 'pi', 'opencode', 'openhands'] as const;

export interface JobFilter {
  readonly state?: string;
  readonly project?: string;
  readonly runtime?: string;
  readonly worker?: string;
}

interface Actor {
  readonly type: string;
  readonly id: string | null;
}

export type ProjectKind = 'repository' | 'workspace';

/** Older masters omit `projectKind`: those jobs are repository jobs. */
function kindOf(o: Record<string, unknown>): ProjectKind {
  return o.projectKind === 'workspace' ? 'workspace' : 'repository';
}

/**
 * p19-verifier-jobs: a platform verifier job's marker (absent / null: an ordinary job, or an older master). `outcome`
 * is the CHECKED job's verification as this verifier left it — shown instead of the verifier's own job state.
 */
export type PlatformPurpose = 'verify' | 'health' | 'integration-verify';
export type PlatformOutcome = 'verified' | 'issues' | 'unverifiable' | 'running';
export interface JobPlatform {
  readonly purpose: PlatformPurpose;
  readonly checkedJobId: string | null;
  readonly checkedTitle: string | null;
  readonly outcome: PlatformOutcome | null;
  readonly errorCause: string | null;
}

const PURPOSES: readonly string[] = ['verify', 'health', 'integration-verify'];
const OUTCOMES: readonly string[] = ['verified', 'issues', 'unverifiable', 'running'];

/** Lenient: anything odd reads as null (an ordinary job). */
export function parsePlatform(v: unknown): JobPlatform | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.purpose !== 'string' || !PURPOSES.includes(o.purpose)) return null;
  const s = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);
  return {
    purpose: o.purpose as PlatformPurpose,
    checkedJobId: s(o.checkedJobId),
    checkedTitle: s(o.checkedTitle),
    outcome:
      typeof o.outcome === 'string' && OUTCOMES.includes(o.outcome) ? (o.outcome as PlatformOutcome) : null,
    errorCause: s(o.errorCause),
  };
}

export interface JobSummary {
  readonly id: string;
  readonly project: string;
  readonly projectKind: ProjectKind;
  readonly state: string;
  readonly runtime: string | null;
  readonly title: string;
  readonly attempts: number;
  readonly workerId: string | null;
  readonly createdBy: Actor;
  readonly createdAt: string;
  readonly stateChangedAt: string;
  /** p19-verifier-jobs (absent: older master / fixture). */
  readonly platform?: JobPlatform | null;
}

export interface Transition {
  readonly id: string;
  readonly version: number;
  readonly from: string | null;
  readonly to: string;
  readonly trigger: string;
  readonly actor: Actor;
  readonly reason: string | null;
  readonly epoch: number | null;
  readonly occurredAt: string;
  /** p14-i18n-reasons: the attempt the step belongs to (absent: older master / fixture). */
  readonly attemptId?: string | null;
}

/** p14-i18n-reasons: the code and params of an attempt's JOB_RESULT error (`orchestration.runs[].resultError`). */
export interface RunError {
  readonly attemptId: string;
  readonly code: string;
  readonly params?: ReasonParams;
}

export interface Attempt {
  readonly id: string;
  readonly number: number;
  readonly workerId: string;
  readonly state: string;
  readonly outcome: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface Lease {
  readonly id: string;
  readonly workerId: string;
  readonly epoch: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  readonly releaseReason: string | null;
}

export interface ApprovalSummary {
  readonly id: string;
  readonly action: string;
  readonly risk: string;
  readonly status: string;
  readonly summary: string;
  readonly approvals: number;
  readonly requiredApprovals: number;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  /** p10-approval-pause: when the open request was marked stale (null: not stale / older master). */
  readonly staleAt: string | null;
  /** p10-approval-pause: when the job was paused for this request (null: never). */
  readonly pauseRequestedAt: string | null;
  /** p10-approval-readable: one readable line (`agent`: the agent's own, unverified description). */
  readonly headline: ApprovalHeadline;
}

/** p13-runtime-accounts: a runtime account a job runs with or is pinned to. */
export interface JobAccountRef {
  readonly workerId: string;
  readonly runtime: string;
  readonly id: string;
  readonly label: string;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** `orchestration.accountPin`: {workerId, runtime, account, label|null}. */
function parseAccountPin(orchestration: unknown): JobAccountRef | null {
  const o = rec(rec(orchestration)?.accountPin);
  if (o === null) return null;
  if (typeof o.workerId !== 'string' || typeof o.runtime !== 'string' || typeof o.account !== 'string')
    return null;
  return {
    workerId: o.workerId,
    runtime: o.runtime,
    id: o.account,
    label: typeof o.label === 'string' ? o.label : o.account,
  };
}

/** The latest run's account: `orchestration.runs[-1].runtimeChoice.account` (+ `accountLabel`). */
function parseRunAccount(orchestration: unknown, workerId: string | null): JobAccountRef | null {
  const runs = rec(orchestration)?.runs;
  const last = Array.isArray(runs) ? rec(runs.at(-1)) : null;
  const c = rec(last?.runtimeChoice);
  if (c === null || typeof c.account !== 'string' || typeof c.runtime !== 'string') return null;
  const w = typeof last?.workerId === 'string' ? last.workerId : workerId;
  if (w === null) return null;
  return {
    workerId: w,
    runtime: c.runtime,
    id: c.account,
    label: typeof c.accountLabel === 'string' ? c.accountLabel : c.account,
  };
}

export interface JobDetail {
  readonly job: {
    readonly id: string;
    readonly project: string;
    readonly projectKind: ProjectKind;
    readonly state: string;
    readonly version: number;
    readonly leaseEpoch: number;
    readonly createdBy: Actor;
    readonly createdAt: string;
    readonly stateChangedAt: string;
    /** p15-job-titles: the job's short title (older masters: derived here from the prompt). */
    readonly title: string;
    /** Where the title came from (older masters: `derived`). */
    readonly titleSource: 'given' | 'derived' | 'edited';
    readonly spec: Readonly<Record<string, unknown>>;
    /** p9-queue-priority: the job's priority (null: an older master). */
    readonly priority?: number | null;
    /** p19-verifier-jobs (absent: older master / fixture). */
    readonly platform?: JobPlatform | null;
  };
  readonly transitions: Transition[];
  readonly attempts: Attempt[];
  readonly leases: Lease[];
  readonly approvals: ApprovalSummary[];
  readonly dependsOn: string[];
  readonly dependents: string[];
  /** p6-quota-scheduling: the scheduler's latest verdict and runtime choice (null: older master / none). */
  readonly scheduling: JobScheduling | null;
  /** p14-i18n-reasons: the attempts' JOB_RESULT errors with their params (absent / empty: older master, none). */
  readonly runErrors?: readonly RunError[];
  /** p6-smart-routing: the job's kind and why the scheduler chose its machine (null: unknown / older master). */
  readonly routing: JobRouting;
  /** p10-approval-pause: the latest pause episode (open or most recent closed); null: never paused. */
  readonly pause: JobPauseView | null;
  /** p13-runtime-accounts: the runtime account the latest attempt ran with (null / absent: unknown, older master). */
  readonly runtimeAccount?: JobAccountRef | null;
  /** p13-runtime-accounts: the account a person pinned the job to (null / absent: none). */
  readonly accountPin?: JobAccountRef | null;
  /** p10-approval-pause: time spent paused (not counted against the run limit). */
  readonly pausedMs: number;
  /** p10-approval-pause: the job ended because an approval expired and can be continued in a new job. */
  readonly continueAvailable: boolean;
  /** p15-chat-cards-scroll: the newest attempt's result summary (the agent's own words; null: none / older master). */
  readonly resultSummary?: string | null;
  /** p22-run-attention: the agent's `OUTCOME:` line of the newest succeeded attempt (null / absent: none). */
  readonly resultAttention?: JobAttention | null;
}

export interface JobAttention {
  readonly kind: 'partial' | 'none';
  readonly note: string;
}

/** p22-run-attention (lenient): `orchestration.runs[].resultAttention` of the newest attempt that reported a summary. */
function parseResultAttention(orchestration: unknown): JobAttention | null {
  const runs = rec(orchestration)?.runs;
  if (!Array.isArray(runs)) return null;
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = rec(runs[i]);
    const s = r?.resultSummary;
    if (typeof s !== 'string' || s.trim() === '') continue;
    const a = rec(r?.resultAttention);
    if (a === null || (a.kind !== 'partial' && a.kind !== 'none')) return null;
    return { kind: a.kind, note: typeof a.note === 'string' ? a.note : '' };
  }
  return null;
}

/** p15-chat-cards-scroll (lenient): `orchestration.runs[].resultSummary` of the newest attempt that reported one. */
function parseResultSummary(orchestration: unknown): string | null {
  const runs = rec(orchestration)?.runs;
  if (!Array.isArray(runs)) return null;
  for (let i = runs.length - 1; i >= 0; i--) {
    const s = rec(runs[i])?.resultSummary;
    if (typeof s === 'string' && s.trim() !== '') return s;
  }
  return null;
}

export interface JobRouting {
  readonly kind: string | null;
  readonly kindSource: 'explicit' | 'inferred' | null;
  readonly explanation: string | null;
}

function parseRouting(v: unknown): JobRouting {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const kind = typeof o.kind === 'object' && o.kind !== null ? (o.kind as Record<string, unknown>) : {};
  const schedule =
    typeof o.schedule === 'object' && o.schedule !== null ? (o.schedule as Record<string, unknown>) : {};
  return {
    kind: typeof kind.role === 'string' ? kind.role : null,
    kindSource: kind.source === 'explicit' || kind.source === 'inferred' ? kind.source : null,
    explanation: typeof schedule.explanation === 'string' ? schedule.explanation : null,
  };
}

/** p6-quota-scheduling: why a queued job waits, and which runtime the latest attempt ran with. */
export interface JobScheduling {
  readonly status: string | null;
  readonly reasons: readonly {
    readonly code: string;
    readonly message: string;
    readonly until: string | null;
    /** p14-i18n-reasons: the reason's params (`cause` picks the sentence variant); absent from older masters. */
    readonly params?: ReasonParams;
  }[];
  readonly runtimeChoice: {
    readonly index: number;
    readonly runtime: string;
    readonly model: string | null;
    readonly reason: string | null;
    /** p11-usage-limit-fallback: the fallback came from the project's usage-limit policy. */
    readonly policy?: boolean;
  } | null;
  readonly runNow: boolean;
}

/** p14-i18n-reasons (lenient): the attempts' JOB_RESULT error codes and params; [] from an older master. */
export function parseRunErrors(v: unknown): RunError[] {
  const runs = typeof v === 'object' && v !== null ? (v as Record<string, unknown>).runs : undefined;
  if (!Array.isArray(runs)) return [];
  return runs.flatMap((r: unknown): RunError[] => {
    if (typeof r !== 'object' || r === null) return [];
    const x = r as Record<string, unknown>;
    const e = x.resultError;
    if (typeof x.attemptId !== 'string' || typeof e !== 'object' || e === null) return [];
    const err = e as Record<string, unknown>;
    if (typeof err.code !== 'string') return [];
    return [{ attemptId: x.attemptId, code: err.code, ...reasonParamsField(err.params) }];
  });
}

/**
 * p14-i18n-reasons: the params of a step's reason — those of its attempt's JOB_RESULT error when the step's reason
 * is that error (`code: message`); undefined otherwise (the reason is then said from its code, or LEGACY its text).
 */
export function transitionReasonParams(
  detail: Pick<JobDetail, 'runErrors'>,
  t: Pick<Transition, 'reason' | 'attemptId'>,
): ReasonParams | undefined {
  if (t.reason === null || t.attemptId === null || t.attemptId === undefined) return undefined;
  const code = parseReason(t.reason).code;
  if (code === null) return undefined;
  return detail.runErrors?.find((e) => e.attemptId === t.attemptId && e.code === code)?.params;
}

/** Lenient: a missing or odd `orchestration` block reads as null (never breaks the job page). */
export function parseScheduling(v: unknown): JobScheduling | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const s =
    typeof o.schedule === 'object' && o.schedule !== null ? (o.schedule as Record<string, unknown>) : null;
  const text = (x: Record<string, unknown>, k: string): string | null =>
    typeof x[k] === 'string' ? x[k] : null;
  const reasons = Array.isArray(s?.reasons)
    ? s.reasons.flatMap((r: unknown) => {
        if (typeof r !== 'object' || r === null) return [];
        const x = r as Record<string, unknown>;
        const code = text(x, 'code');
        return code === null
          ? []
          : [
              {
                code,
                message: text(x, 'message') ?? '',
                until: text(x, 'until'),
                ...reasonParamsField(x.params),
              },
            ];
      })
    : [];
  const runs = Array.isArray(o.runs) ? o.runs : [];
  const last: unknown = runs.at(-1);
  const rc =
    typeof last === 'object' && last !== null ? (last as Record<string, unknown>).runtimeChoice : undefined;
  let runtimeChoice: JobScheduling['runtimeChoice'] = null;
  if (typeof rc === 'object' && rc !== null) {
    const c = rc as Record<string, unknown>;
    const runtime = text(c, 'runtime');
    if (runtime !== null && typeof c.index === 'number') {
      runtimeChoice = {
        index: c.index,
        runtime,
        model: text(c, 'model'),
        reason: text(c, 'reason'),
        ...(c.origin === 'policy' ? { policy: true } : {}),
      };
    }
  }
  return {
    status: s === null ? null : text(s, 'status'),
    reasons,
    runtimeChoice,
    runNow: typeof o.runNow === 'object' && o.runNow !== null,
  };
}

/** Starts a deferred job now instead of waiting for its project's off-peak window. */
export function runJobNow(id: string, opts: Opts = {}): Promise<{ state: string }> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(id)}/run-now`,
    (v) => ({ state: str(obj(v), 'state') }),
    { ...opts, body: {} },
  );
}

type Opts = Omit<RequestOptions, 'body'>;

function array<T>(v: unknown, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v.map(item);
}

function actor(v: unknown): Actor {
  const o = obj(v);
  return { type: str(o, 'type'), id: nullableStr(o, 'id') };
}

function nullableInt(o: Record<string, unknown>, key: string): number | null {
  return o[key] === null ? null : int(o, key);
}

export function jobQuery(filter: JobFilter, cursor: string | null, limit = 50): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...filter, limit: String(limit), cursor })) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t) params.append(k, t);
  }
  return `?${params.toString()}`;
}

export function parseSummary(v: unknown): JobSummary {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    projectKind: kindOf(o),
    state: str(o, 'state'),
    runtime: nullableStr(o, 'runtime'),
    title: str(o, 'title'),
    attempts: int(o, 'attempts'),
    workerId: nullableStr(o, 'workerId'),
    createdBy: actor(o.createdBy),
    createdAt: str(o, 'createdAt'),
    stateChangedAt: str(o, 'stateChangedAt'),
    platform: parsePlatform(o.platform),
  };
}

export function listJobs(
  filter: JobFilter,
  cursor: string | null,
  opts: Opts & { readonly limit?: number } = {},
): Promise<{ items: JobSummary[]; nextCursor: string | null }> {
  return apiRequest(
    'GET',
    `/jobs${jobQuery(filter, cursor, opts.limit)}`,
    (v) => {
      const o = obj(v);
      return { items: array(o.items, parseSummary), nextCursor: nullableStr(o, 'nextCursor') };
    },
    opts,
  );
}

export function parseJobDetail(v: unknown): JobDetail {
  const o = obj(v);
  const j = obj(o.job);
  return {
    job: {
      id: str(j, 'id'),
      project: str(j, 'project'),
      projectKind: kindOf(j),
      state: str(j, 'state'),
      version: int(j, 'version'),
      leaseEpoch: int(j, 'leaseEpoch'),
      createdBy: actor(j.createdBy),
      createdAt: str(j, 'createdAt'),
      stateChangedAt: str(j, 'stateChangedAt'),
      title:
        typeof j.title === 'string' && j.title !== ''
          ? j.title
          : deriveJobTitle(typeof obj(j.spec).prompt === 'string' ? String(obj(j.spec).prompt) : ''),
      titleSource: j.titleSource === 'given' || j.titleSource === 'edited' ? j.titleSource : 'derived',
      spec: obj(j.spec),
      priority: typeof j.priority === 'number' && Number.isFinite(j.priority) ? j.priority : null,
      platform: parsePlatform(j.platform),
    },
    transitions: array(o.transitions, (x) => {
      const t = obj(x);
      return {
        id: str(t, 'id'),
        version: int(t, 'version'),
        from: nullableStr(t, 'from'),
        to: str(t, 'to'),
        trigger: str(t, 'trigger'),
        actor: actor(t.actor),
        reason: nullableStr(t, 'reason'),
        epoch: nullableInt(t, 'epoch'),
        attemptId: typeof t.attemptId === 'string' ? t.attemptId : null,
        occurredAt: str(t, 'occurredAt'),
      };
    }),
    attempts: array(o.attempts, (x) => {
      const a = obj(x);
      return {
        id: str(a, 'id'),
        number: int(a, 'number'),
        workerId: str(a, 'workerId'),
        state: str(a, 'state'),
        outcome: nullableStr(a, 'outcome'),
        startedAt: str(a, 'startedAt'),
        endedAt: nullableStr(a, 'endedAt'),
      };
    }),
    leases: array(o.leases, (x) => {
      const l = obj(x);
      return {
        id: str(l, 'id'),
        workerId: str(l, 'workerId'),
        epoch: int(l, 'epoch'),
        acquiredAt: str(l, 'acquiredAt'),
        expiresAt: str(l, 'expiresAt'),
        releasedAt: nullableStr(l, 'releasedAt'),
        releaseReason: nullableStr(l, 'releaseReason'),
      };
    }),
    approvals: array(o.approvals, (x) => {
      const a = obj(x);
      return {
        id: str(a, 'id'),
        action: str(a, 'action'),
        risk: str(a, 'risk'),
        status: str(a, 'status'),
        summary: str(a, 'summary'),
        approvals: int(a, 'approvals'),
        requiredApprovals: int(a, 'requiredApprovals'),
        createdAt: str(a, 'createdAt'),
        decidedAt: nullableStr(a, 'decidedAt'),
        staleAt: typeof a.staleAt === 'string' ? a.staleAt : null,
        pauseRequestedAt: typeof a.pauseRequestedAt === 'string' ? a.pauseRequestedAt : null,
        headline: parseApprovalHeadline(a.headline, null, str(a, 'summary')),
      };
    }),
    dependsOn: array(o.dependsOn, (x) => (typeof x === 'string' ? x : '')),
    dependents: array(o.dependents, (x) => (typeof x === 'string' ? x : '')),
    scheduling: parseScheduling(o.orchestration),
    runErrors: parseRunErrors(o.orchestration),
    routing: parseRouting(o.orchestration),
    pause: parsePause(o.pause),
    runtimeAccount: parseRunAccount(
      o.orchestration,
      (() => {
        const a = Array.isArray(o.attempts) ? rec(o.attempts.at(-1)) : null;
        return typeof a?.workerId === 'string' ? a.workerId : null;
      })(),
    ),
    accountPin: parseAccountPin(o.orchestration),
    pausedMs: typeof o.pausedMs === 'number' && o.pausedMs > 0 ? o.pausedMs : 0,
    continueAvailable: o.continueAvailable === true,
    resultSummary: parseResultSummary(o.orchestration),
    resultAttention: parseResultAttention(o.orchestration),
  };
}

export function getJob(id: string, opts: Opts = {}): Promise<JobDetail> {
  return apiRequest('GET', `/jobs/${encodeURIComponent(id)}`, parseJobDetail, opts);
}

export function exportJob(id: string, opts: DownloadOptions = {}): Promise<ExportResult> {
  return downloadExport(`/jobs/${encodeURIComponent(id)}/export`, `job-${id.slice(0, 8)}.jsonl`, opts);
}

/** p15-job-titles: rename a job (one line, ≤ 60 characters; whoever may start jobs in its project). */
export function setJobTitle(jobId: string, title: string): Promise<{ readonly title: string }> {
  return apiRequest(
    'PUT',
    `/jobs/${encodeURIComponent(jobId)}/title`,
    (v) => ({ title: str(obj(v), 'title') }),
    { body: { title } },
  );
}
