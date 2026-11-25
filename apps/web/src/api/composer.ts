import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p5-composer API (docs/design/p5-composer.md): placement preview, job submission, workflow definitions and
 * runs, the project's git configuration, the context bundle preview and schedules. Every text field here
 * may come from users, workers or repositories: render as text only.
 */

type Opts = Omit<RequestOptions, 'body'>;

function arr(o: Record<string, unknown>, key: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`expected array at ${key}`);
  return v;
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError(`expected number at ${key}`);
  return v;
}

function optNum(o: Record<string, unknown>, key: string): number | undefined {
  return o[key] === undefined ? undefined : num(o, key);
}

// ------------------------------------------------------------------------------- placement preview

export interface Reason {
  readonly code: string;
  readonly permanent: boolean;
  readonly message: string;
}
export interface ReasonSummary extends Reason {
  readonly workers: readonly string[];
}

export interface JobLimitDefaults {
  readonly maxCostUsd?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly maxTurns?: number | undefined;
  readonly maxWallTimeSec?: number | undefined;
}

export interface PreviewWorker {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly connected: boolean;
  readonly os: string | null;
  readonly arch: string | null;
  readonly tools: readonly string[];
}

export interface PlacementPreview {
  readonly project: string;
  readonly hostExecution: boolean;
  /** p5-sandbox-ops: the project allows the unconfined profile (false for masters that predate it). */
  readonly unconfinedExecution: boolean;
  /** p5-full-access (ADR-0020): the project allows `approvalPolicy: "allow-all"` (false for older masters). */
  readonly autoApproveExecution: boolean;
  /**
   * p5-full-access: whether the composer's "Full access" (unconfined + allow-all + trusted) can be chosen, the
   * reasons when not, and the workers that could run it. Absent from older masters → not available.
   */
  readonly fullAccess: FullAccessAvailability;
  readonly sandboxProfile: string;
  readonly issues: readonly { readonly code: string; readonly message: string }[];
  readonly placement: {
    readonly runtime: string;
    readonly verdict: 'placed' | 'waiting' | 'infeasible' | 'held';
    readonly holds: readonly ReasonSummary[];
    readonly candidates: readonly { readonly workerId: string; readonly score: number }[];
    readonly rejected: readonly { readonly workerId: string; readonly reasons: readonly Reason[] }[];
    readonly summary: readonly ReasonSummary[];
    /** p6-smart-routing: why the first candidate would be chosen (null: not placed / older master). */
    readonly explanation: string | null;
  } | null;
  /** p6-smart-routing: the draft's kind and the routing rule in force (null fields for older masters). */
  readonly routing: RoutingFacts;
  readonly runtimes: readonly {
    readonly runtime: string;
    readonly verdict: 'placed' | 'waiting' | 'infeasible';
    readonly eligible: readonly string[];
    readonly feasible: readonly string[];
    readonly summary: readonly ReasonSummary[];
  }[];
  readonly modelProfiles: readonly ModelProfileOption[];
  /**
   * The model the draft resolves to for the chosen runtime — the project / global default applied when it names
   * none. Null when no runtime is chosen or the master predates it.
   */
  readonly model: ModelResolution | null;
  readonly sandbox: readonly { readonly profile: string; readonly workers: readonly string[] }[];
  readonly limits: JobLimitDefaults;
  readonly workers: readonly PreviewWorker[];
  /**
   * p19-repo-inputs-composer-workflows: may the job composer offer input files for the project now (absent: an older
   * master — the field follows the project kind alone).
   */
  readonly inputFiles?: InputFilesAvailability;
}

/**
 * p19-repo-inputs-composer-workflows: input files (job) / run files (workflow run) for a project right now. A
 * repository project needs a machine with `repo-inputs-v1` (`inputs_worker_update`: "makine güncellenmeli").
 */
export interface InputFilesAvailability {
  readonly available: boolean;
  readonly reason: 'inputs_worker_update' | 'inputs_project' | null;
}

/** Absent or malformed → undefined (an older master). */
export function parseInputFiles(v: unknown): InputFilesAvailability | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.available !== 'boolean') return undefined;
  const reason = o.reason === 'inputs_worker_update' || o.reason === 'inputs_project' ? o.reason : null;
  return { available: o.available, reason };
}

export interface ModelResolution {
  readonly runtime: string;
  readonly defaultProfile: string | null;
  readonly defaultScope: 'project' | 'global' | null;
  /** p6-smart-routing: `routing` = the kind's routing rule chose `defaultProfile`. */
  readonly defaultSource: 'routing' | 'default' | null;
}

export interface RoutingFacts {
  readonly role: string | null;
  readonly roleSource: 'explicit' | 'inferred' | null;
  readonly rule: {
    readonly modelProfile: string | null;
    readonly runtimes: readonly string[];
    readonly scope: 'project' | 'global';
  } | null;
  /** The runtime the rule's order picks for a draft that names none (null: none). */
  readonly runtime: string | null;
}

const NO_ROUTING: RoutingFacts = { role: null, roleSource: null, rule: null, runtime: null };

function parseRouting(v: unknown): RoutingFacts {
  if (typeof v !== 'object' || v === null) return NO_ROUTING;
  const o = v as Record<string, unknown>;
  const r = typeof o.rule === 'object' && o.rule !== null ? (o.rule as Record<string, unknown>) : null;
  return {
    role: typeof o.role === 'string' ? o.role : null,
    roleSource: o.roleSource === 'explicit' || o.roleSource === 'inferred' ? o.roleSource : null,
    rule:
      r === null
        ? null
        : {
            modelProfile: typeof r.modelProfile === 'string' ? r.modelProfile : null,
            runtimes: Array.isArray(r.runtimes)
              ? r.runtimes.filter((x): x is string => typeof x === 'string')
              : [],
            scope: r.scope === 'project' ? 'project' : 'global',
          },
    runtime: typeof o.runtime === 'string' ? o.runtime : null,
  };
}

function parseModelResolution(v: unknown): ModelResolution | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  return {
    runtime: str(o, 'runtime'),
    defaultProfile: typeof o.defaultProfile === 'string' ? o.defaultProfile : null,
    defaultScope: o.defaultScope === 'project' || o.defaultScope === 'global' ? o.defaultScope : null,
    defaultSource: o.defaultSource === 'routing' || o.defaultSource === 'default' ? o.defaultSource : null,
  };
}

/**
 * A model choice for the chosen runtime (p5-credentials-models): a runtime-policy profile or a model catalog
 * entry. `value` is what goes into the job's `model`: the profile name / catalog id (the master resolves a catalog
 * id into the job's model profile; older masters sent the runtime's model id for catalog entries).
 */
export interface ModelProfileOption {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly isDefault: boolean;
  readonly workers: readonly string[];
  readonly source: 'policy' | 'catalog';
  readonly value: string;
  readonly displayName?: string;
  readonly pricing?: { readonly inputPerMTok?: number; readonly outputPerMTok?: number };
  readonly projectDefault: boolean;
}

export interface FullAccessAvailability {
  readonly available: boolean;
  readonly reasons: readonly { readonly code: string; readonly message: string }[];
  readonly workers: readonly string[];
}

const FULL_ACCESS_UNKNOWN: FullAccessAvailability = {
  available: false,
  reasons: [
    {
      code: 'approval_policy_unsupported',
      message: 'this master does not report full-access availability; update the master',
    },
  ],
  workers: [],
};

function parseFullAccess(v: unknown): FullAccessAvailability {
  if (typeof v !== 'object' || v === null) return FULL_ACCESS_UNKNOWN;
  const o = v as Record<string, unknown>;
  return {
    available: o.available === true,
    reasons: Array.isArray(o.reasons)
      ? o.reasons.map((x) => {
          const r = obj(x);
          return { code: str(r, 'code'), message: str(r, 'message') };
        })
      : [],
    workers: Array.isArray(o.workers) ? o.workers.filter((w): w is string => typeof w === 'string') : [],
  };
}

export interface PreviewDraft {
  readonly project: string;
  readonly runtime?: string;
  readonly runtimeVersion?: string;
  readonly model?: string;
  readonly sandboxProfile?: string;
  readonly sourceTrust?: 'trusted' | 'untrusted';
  /** p5-full-access: the approval policy the job would use (`allow-all` is checked against the project). */
  readonly approvalPolicy?: string;
  readonly requirements?: {
    readonly os?: readonly string[];
    readonly arch?: readonly string[];
    readonly tools?: readonly string[];
    readonly workers?: readonly string[];
  };
  /** p6-smart-routing: the draft's explicit kind, or the start of its prompt for the master's heuristic. */
  readonly role?: string;
  readonly promptHead?: string;
}

function reason(v: unknown): Reason {
  const o = obj(v);
  return { code: str(o, 'code'), permanent: bool(o, 'permanent'), message: str(o, 'message') };
}

function summary(v: unknown): ReasonSummary {
  const o = obj(v);
  return { ...reason(v), workers: strArray(o, 'workers') };
}

const VERDICTS = new Set(['placed', 'waiting', 'infeasible', 'held']);

type Verdict = 'placed' | 'waiting' | 'infeasible' | 'held';

function verdict(o: Record<string, unknown>, key: string): Verdict {
  const v = str(o, key);
  if (!VERDICTS.has(v)) throw new ShapeError(`unexpected ${key}`);
  return v as Verdict;
}

function runtimeVerdict(o: Record<string, unknown>): Exclude<Verdict, 'held'> {
  const v = verdict(o, 'verdict');
  if (v === 'held') throw new ShapeError('unexpected verdict');
  return v;
}

export function parsePreview(body: unknown): PlacementPreview {
  const b = obj(body);
  const p = b.placement === null ? null : obj(b.placement);
  const limits = obj(b.limits);
  return {
    project: str(b, 'project'),
    hostExecution: bool(b, 'hostExecution'),
    unconfinedExecution: b.unconfinedExecution === true,
    autoApproveExecution: b.autoApproveExecution === true,
    fullAccess: parseFullAccess(b.fullAccess),
    sandboxProfile: str(b, 'sandboxProfile'),
    issues: arr(b, 'issues').map((x) => {
      const o = obj(x);
      return { code: str(o, 'code'), message: str(o, 'message') };
    }),
    placement:
      p === null
        ? null
        : {
            runtime: str(p, 'runtime'),
            verdict: verdict(p, 'verdict'),
            holds: arr(p, 'holds').map(summary),
            candidates: arr(p, 'candidates').map((x) => {
              const o = obj(x);
              return { workerId: str(o, 'workerId'), score: num(o, 'score') };
            }),
            rejected: arr(p, 'rejected').map((x) => {
              const o = obj(x);
              return { workerId: str(o, 'workerId'), reasons: arr(o, 'reasons').map(reason) };
            }),
            summary: arr(p, 'summary').map(summary),
            explanation: typeof p.explanation === 'string' ? p.explanation : null,
          },
    routing: parseRouting(b.routing),
    runtimes: arr(b, 'runtimes').map((x) => {
      const o = obj(x);
      return {
        runtime: str(o, 'runtime'),
        verdict: runtimeVerdict(o),
        eligible: strArray(o, 'eligible'),
        feasible: strArray(o, 'feasible'),
        summary: arr(o, 'summary').map(summary),
      };
    }),
    modelProfiles: arr(b, 'modelProfiles').map((x) => {
      const o = obj(x);
      const name = str(o, 'name');
      const pricing =
        typeof o.pricing === 'object' && o.pricing !== null
          ? (o.pricing as ModelProfileOption['pricing'])
          : undefined;
      const option: ModelProfileOption = {
        name,
        provider: str(o, 'provider'),
        model: str(o, 'model'),
        isDefault: bool(o, 'isDefault'),
        workers: strArray(o, 'workers'),
        // Older masters send policy profiles only (value = name).
        source: o.source === 'catalog' ? 'catalog' : 'policy',
        value: typeof o.value === 'string' ? o.value : name,
        ...(typeof o.displayName === 'string' ? { displayName: o.displayName } : {}),
        ...(pricing === undefined ? {} : { pricing }),
        projectDefault: o.projectDefault === true,
      };
      return option;
    }),
    model: parseModelResolution(b.model),
    sandbox: arr(b, 'sandbox').map((x) => {
      const o = obj(x);
      return { profile: str(o, 'profile'), workers: strArray(o, 'workers') };
    }),
    limits: {
      maxCostUsd: optNum(limits, 'maxCostUsd'),
      maxTokens: optNum(limits, 'maxTokens'),
      maxTurns: optNum(limits, 'maxTurns'),
      maxWallTimeSec: optNum(limits, 'maxWallTimeSec'),
    },
    workers: arr(b, 'workers').map((x) => {
      const o = obj(x);
      return {
        id: str(o, 'id'),
        name: str(o, 'name'),
        state: str(o, 'state'),
        connected: bool(o, 'connected'),
        os: nullableStr(o, 'os'),
        arch: nullableStr(o, 'arch'),
        tools: strArray(o, 'tools'),
      };
    }),
    ...inputFilesField('inputFiles', b.inputFiles),
  };
}

function inputFilesField<K extends string>(key: K, v: unknown): Partial<Record<K, InputFilesAvailability>> {
  const parsed = parseInputFiles(v);
  return parsed === undefined ? {} : ({ [key]: parsed } as Partial<Record<K, InputFilesAvailability>>);
}

export function previewPlacement(draft: PreviewDraft, opts: Opts = {}): Promise<PlacementPreview> {
  return apiRequest('POST', '/jobs/placement-preview', parsePreview, { ...opts, body: draft });
}

// ------------------------------------------------------------------------------- submission

export interface CreatedJob {
  readonly id: string;
  readonly state: string;
  /** `repository` when an older master omits it. */
  readonly projectKind: 'repository' | 'workspace';
}

/** A workspace job's uploaded file (p5-research-workspace): name + base64 content. */
export interface JobInputUpload {
  readonly name: string;
  readonly contentBase64: string;
}

export interface CreateJobExtras {
  /** Workspace projects only. */
  readonly inputs?: readonly JobInputUpload[];
  /** A previous job whose artifacts become this job's inputs (workspace projects only). */
  readonly continueFrom?: string;
  /** p15-workspace-retention: start from this job's kept working directory (workspace projects only). */
  readonly keptFilesFrom?: string;
  /** p16-zip-job-input: an input bundle of the project (a .zip uploaded with the composer or the chat). */
  readonly inputUpload?: string;
  /** p6-deploy-on-success (ADR-0030): deploy the result when the job succeeds (the submission is the approval). */
  readonly deployOnSuccess?: DeployOnSuccessRequest;
  /** p8-templates: the template version the composer was filled from (usage stats). */
  readonly template?: { readonly id: string; readonly version: number };
  /** p10-verify-health: "Verify when done" (absent: the project's default). */
  readonly verifyOnSuccess?: { readonly mode: 'off' | 'report' | 'gate' };
}

/** p6-deploy-on-success: what "deploy when done" names — the master resolves the real target. */
export interface DeployOnSuccessRequest {
  readonly target: 'pages' | 'coolify';
  readonly env: 'preview' | 'production';
  /** Pages: the directory the job writes the site into (default `site`). */
  readonly directory?: string;
  /** p10-publish-bundle (Pages only): the Pages project (new with createIfMissing), a custom domain, its DNS. */
  readonly pagesProject?: string;
  readonly createIfMissing?: boolean;
  readonly domain?: string;
  readonly dns?: 'auto' | 'skip';
}

export function createJob(
  project: string,
  spec: Readonly<Record<string, unknown>>,
  priority?: number,
  extras: CreateJobExtras = {},
  opts: Opts = {},
): Promise<CreatedJob> {
  return apiRequest(
    'POST',
    '/jobs',
    (v) => {
      const j = obj(obj(v).job);
      return {
        id: str(j, 'id'),
        state: str(j, 'state'),
        projectKind: j.projectKind === 'workspace' ? 'workspace' : 'repository',
      };
    },
    {
      ...opts,
      body: {
        project,
        spec,
        ...(priority === undefined ? {} : { priority }),
        ...(extras.inputs === undefined || extras.inputs.length === 0 ? {} : { inputs: extras.inputs }),
        ...(extras.continueFrom === undefined ? {} : { continueFrom: extras.continueFrom }),
        ...(extras.keptFilesFrom === undefined ? {} : { keptFilesFrom: extras.keptFilesFrom }),
        ...(extras.inputUpload === undefined ? {} : { inputUpload: extras.inputUpload }),
        ...(extras.deployOnSuccess === undefined ? {} : { deployOnSuccess: extras.deployOnSuccess }),
        ...(extras.template === undefined ? {} : { template: extras.template }),
        ...(extras.verifyOnSuccess === undefined ? {} : { verifyOnSuccess: extras.verifyOnSuccess }),
      },
    },
  );
}

// ------------------------------------------------------------------------------- workflows

export interface WorkflowDefinitionSummary {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly version: number;
  readonly nodes: number;
  /** p18-multi-project: `project` attached it from another project (runs and reads go through `project`). */
  readonly shared?: boolean;
}

export interface WorkflowDefinitionView {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly version: number;
  readonly description: string | null;
  readonly inputs: readonly {
    readonly name: string;
    readonly required: boolean;
    readonly description: string | null;
  }[];
  readonly nodes: readonly {
    readonly id: string;
    readonly role: string;
    readonly runtime: string;
    readonly gate: boolean;
    readonly dynamic: boolean;
  }[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly defaults: {
    readonly runtime: string;
    readonly sandboxProfile: string;
    readonly approvalPolicy: string;
    readonly repository: { readonly url: string; readonly baseRef: string } | null;
  };
  /** p19-repo-inputs-composer-workflows: run files for a run in the run's project (absent: an older master). */
  readonly runFiles?: InputFilesAvailability;
}

export function listWorkflowDefinitions(opts: Opts = {}): Promise<WorkflowDefinitionSummary[]> {
  return apiRequest(
    'GET',
    '/workflows',
    (v) =>
      arr(obj(v), 'definitions')
        // p13-workflows-ui: archived workflows take no new runs; pickers offer only the others.
        .filter((x) => obj(x).archived !== true)
        .map((x) => {
          const o = obj(x);
          return {
            id: str(o, 'id'),
            project: str(o, 'project'),
            name: str(o, 'name'),
            version: int(o, 'version'),
            nodes: int(o, 'nodes'),
            ...(typeof o.attachment === 'object' && o.attachment !== null ? { shared: true } : {}),
          };
        }),
    opts,
  );
}

export function parseDefinition(body: unknown): WorkflowDefinitionView {
  const b = obj(body);
  const d = obj(b.defaults);
  const repo = d.repository === null ? null : obj(d.repository);
  return {
    id: str(b, 'id'),
    project: str(b, 'project'),
    name: str(b, 'name'),
    version: int(b, 'version'),
    description: nullableStr(b, 'description'),
    inputs: arr(b, 'inputs').map((x) => {
      const o = obj(x);
      return {
        name: str(o, 'name'),
        required: bool(o, 'required'),
        description: nullableStr(o, 'description'),
      };
    }),
    nodes: arr(b, 'nodes').map((x) => {
      const o = obj(x);
      return {
        id: str(o, 'id'),
        role: str(o, 'role'),
        runtime: str(o, 'runtime'),
        gate: bool(o, 'gate'),
        dynamic: bool(o, 'dynamic'),
      };
    }),
    edges: arr(b, 'edges').map((x) => {
      const o = obj(x);
      return { from: str(o, 'from'), to: str(o, 'to') };
    }),
    defaults: {
      runtime: str(d, 'runtime'),
      sandboxProfile: str(d, 'sandboxProfile'),
      approvalPolicy: str(d, 'approvalPolicy'),
      repository: repo === null ? null : { url: str(repo, 'url'), baseRef: str(repo, 'baseRef') },
    },
    ...inputFilesField('runFiles', b.runFiles),
  };
}

/** p18-multi-project: `project` = a project that attached the workflow (read through it; its own repository). */
export function getWorkflowDefinition(
  id: string,
  opts: Opts & { readonly project?: string } = {},
): Promise<WorkflowDefinitionView> {
  const { project, ...rest } = opts;
  const q = project === undefined || project === '' ? '' : `?project=${encodeURIComponent(project)}`;
  return apiRequest('GET', `/workflows/${encodeURIComponent(id)}${q}`, parseDefinition, rest);
}

export function startWorkflowRun(
  id: string,
  body: {
    inputs: Readonly<Record<string, string>>;
    repository?: { url: string; baseRef: string };
    /** p5-research-workspace-next: workspace runs — files handed to every step, a job to continue from. */
    files?: readonly { name: string; contentBase64: string }[];
    continueFrom?: string;
    /** p9-queue-priority: the run's queue priority (class value or advanced number); absent = Normal. */
    priority?: number;
    /** p18-multi-project: the project the run belongs to (a project that attached it; default the owner). */
    project?: string;
  },
  opts: Opts = {},
): Promise<string> {
  return apiRequest('POST', `/workflows/${encodeURIComponent(id)}/runs`, (v) => str(obj(v), 'runId'), {
    ...opts,
    body,
  });
}

// ------------------------------------------------------------------------------- project git, context

export interface ProjectGit {
  readonly repositoryUrl: string;
  readonly baseBranch: string;
  readonly provider: string;
}

export function getProjectGit(project: string, opts: Opts = {}): Promise<ProjectGit | null> {
  return apiRequest(
    'GET',
    `/projects/${encodeURIComponent(project)}/git`,
    (v) => {
      const c = obj(v).config;
      if (c === null) return null;
      const o = obj(c);
      return {
        repositoryUrl: str(o, 'repositoryUrl'),
        baseBranch: str(o, 'baseBranch'),
        provider: str(o, 'provider'),
      };
    },
    opts,
  );
}

export interface BundlePreview {
  readonly bundleHash: string;
  readonly items: readonly {
    readonly position: number;
    /** `platform` | `global` | `user` (p11 personal rules) | `project` | `memory`. */
    readonly layer: string;
    readonly kind: string;
    /** p11-memory-layers: rule / fact / decision / lesson for typed records. */
    readonly recordType?: string;
    readonly title: string;
    readonly version: number;
    readonly content: string | null;
    readonly withheld: boolean;
  }[];
  readonly omitted: number;
}

export function getBundlePreview(project: string, runtime: string, opts: Opts = {}): Promise<BundlePreview> {
  const q = new URLSearchParams({ project, runtime });
  return apiRequest(
    'GET',
    `/context/bundle?${q.toString()}`,
    (v) => {
      const o = obj(v);
      return {
        bundleHash: str(o, 'bundleHash'),
        items: arr(o, 'items').map((x) => {
          const i = obj(x);
          return {
            position: int(i, 'position'),
            layer: str(i, 'layer'),
            kind: str(i, 'kind'),
            ...(typeof i.recordType === 'string' ? { recordType: i.recordType } : {}),
            title: str(i, 'title'),
            version: int(i, 'version'),
            content: nullableStr(i, 'content'),
            withheld: bool(i, 'withheld'),
          };
        }),
        omitted: arr(o, 'omitted').length,
      };
    },
    opts,
  );
}

// ------------------------------------------------------------------------------- schedules

export interface ScheduleInfo {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly target: {
    readonly kind: string;
    readonly runtime: string | null;
    readonly workflowId: string | null;
  };
  readonly when:
    { readonly kind: 'at'; readonly at: string } | { readonly kind: 'cron'; readonly cron: string };
  readonly state: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly lastJobId: string | null;
  readonly lastRunId: string | null;
  readonly lastError: string | null;
  readonly runCount: number;
  readonly createdAt: string;
  /** p6-automations: the automation behind the schedule (`/automations/<id>`; older masters: the schedule id). */
  readonly automationId: string;
}

export type ScheduleWhen = { kind: 'at'; at: string } | { kind: 'cron'; cron: string };
/** p5-research-workspace-next: input files and continue-from of a scheduled workspace job or run. */
interface ScheduleFiles {
  files?: readonly { name: string; contentBase64: string }[];
  continueFrom?: { kind: 'job'; jobId: string };
}
export type ScheduleTarget =
  | ({ kind: 'job'; spec: Readonly<Record<string, unknown>>; priority?: number } & ScheduleFiles)
  | ({
      kind: 'workflow';
      workflowId: string;
      inputs: Readonly<Record<string, string>>;
      repository?: { url: string; baseRef: string };
    } & ScheduleFiles);

export function parseSchedule(v: unknown): ScheduleInfo {
  const o = obj(v);
  const t = obj(o.target);
  const w = obj(o.when);
  const kind = str(w, 'kind');
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    name: str(o, 'name'),
    target: {
      kind: str(t, 'kind'),
      runtime: nullableStr(t, 'runtime'),
      workflowId: nullableStr(t, 'workflowId'),
    },
    when: kind === 'cron' ? { kind: 'cron', cron: str(w, 'cron') } : { kind: 'at', at: str(w, 'at') },
    state: str(o, 'state'),
    nextRunAt: nullableStr(o, 'nextRunAt'),
    lastRunAt: nullableStr(o, 'lastRunAt'),
    lastStatus: nullableStr(o, 'lastStatus'),
    lastJobId: nullableStr(o, 'lastJobId'),
    lastRunId: nullableStr(o, 'lastRunId'),
    lastError: nullableStr(o, 'lastError'),
    runCount: int(o, 'runCount'),
    createdAt: str(o, 'createdAt'),
    automationId: typeof o.automationId === 'string' ? o.automationId : str(o, 'id'),
  };
}

export function listSchedules(project?: string, opts: Opts = {}): Promise<ScheduleInfo[]> {
  const q = project === undefined ? '' : `?project=${encodeURIComponent(project)}`;
  return apiRequest('GET', `/schedules${q}`, (v) => arr(obj(v), 'items').map(parseSchedule), opts);
}

export function createSchedule(
  body: { project: string; name: string; target: ScheduleTarget; when: ScheduleWhen },
  opts: Opts = {},
): Promise<ScheduleInfo> {
  return apiRequest('POST', '/schedules', parseSchedule, { ...opts, body });
}

export function cancelSchedule(id: string, opts: Opts = {}): Promise<ScheduleInfo> {
  return apiRequest('DELETE', `/schedules/${encodeURIComponent(id)}`, parseSchedule, opts);
}

export function cronPreview(cron: string, opts: Opts = {}): Promise<string[]> {
  return apiRequest(
    'GET',
    `/schedules/cron-preview?cron=${encodeURIComponent(cron)}`,
    (v) => strArray(obj(v), 'nextRuns'),
    opts,
  );
}
