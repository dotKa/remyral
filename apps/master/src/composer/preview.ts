import { effectivePolicy } from '../security-policy/model.js';
import { loadSecurityDocument } from '../security-policy/service.js';
import {
  type ApprovalPolicy,
  type EffectiveRoutingRule,
  effectiveRoutingRule,
  type JobRole,
  jobRoleOf,
  type JobSpec,
  resolveModelProfile,
  routedRuntime,
  RuntimeKind,
  type RuntimePolicyDocument,
  SandboxProfile,
} from '@remyral/protocol';
import {
  type JobLimits,
  place,
  type PlacementJob,
  type PlacementOutcomes,
  type PlacementReason,
  type PlacementResult,
  type PlacementWorker,
  type ReasonSummary,
} from '@remyral/scheduler';
import type { Queryable } from '../db/pool.js';
import { resolveWorkerAffinity } from '../jobs/store.js';
import { type DefaultChoice, pickDefault, resolveWithCatalog } from '../models/job-model.js';
import { loadCatalog } from '../models/service.js';
import { catalogProblem, jobModelProfileFacts } from '../orchestration/credential-facts.js';
import { loadRoutingRules } from '../routing/rules.js';

/**
 * p5-composer "where would this run?" (docs/design/p5-composer.md §3): the scheduler's own placement
 * (`@remyral/scheduler` `place`) over the master's own facts, plus what admission would decide (quota holds,
 * worker-level quota exclusions) and what the worker's effective runtime policy would refuse (runtime not
 * allowed, model profile not allowed for the project). **No side effects**: nothing is written, no event is
 * recorded, no lease, no job.
 */

export type RequirementsDraft = NonNullable<JobSpec['requirements']>;

/** The placement-relevant part of a job being composed (everything optional except the project). */
export interface PreviewDraft {
  readonly project: string;
  readonly runtime?: RuntimeKind | undefined;
  readonly runtimeVersion?: string | undefined;
  readonly model?: string | undefined;
  readonly sandboxProfile?: SandboxProfile | undefined;
  readonly sourceTrust?: 'trusted' | 'untrusted' | undefined;
  /** p5-full-access: the draft's approval policy (absent = an asking policy). */
  readonly approvalPolicy?: ApprovalPolicy | undefined;
  readonly requirements?: RequirementsDraft | undefined;
  readonly secretRefs?: Readonly<Record<string, string>> | undefined;
  /** p6-smart-routing: the draft's explicit kind (JobSpec.role). */
  readonly role?: JobRole | undefined;
  /** p6-smart-routing: the start of the prompt, for the kind heuristic when no role is given (ROLE_HINT_CHARS). */
  readonly promptHead?: string | undefined;
}

export interface PreviewDeps {
  readonly db: Queryable;
  /** Orchestrator.candidates: the same facts dispatch uses. */
  readonly candidates: (project: string) => Promise<PlacementWorker[]>;
  /** QuotaService.preview: side-effect-free admission. */
  readonly quotas: (
    project: string,
    runtime: string,
  ) => Promise<{
    readonly holds: readonly ReasonSummary[];
    readonly adjust: (workers: PlacementWorker[]) => PlacementWorker[];
    readonly limits: JobLimits;
  }>;
  /** RuntimePolicyService.forWorker(...).effective?.document (null: no policy; compiled-in pins apply). */
  readonly policyOf: (workerId: string) => Promise<RuntimePolicyDocument | null>;
  /**
   * p6-smart-routing: recorded outcomes per worker for a runtime × model × kind (`outcomesFor`), the same facts
   * dispatch scores with. Absent = none (the pre-p6 ranking).
   */
  readonly outcomes?: (key: {
    project: string;
    runtime: string;
    model: string;
    kind: string;
  }) => Promise<ReadonlyMap<string, PlacementOutcomes>>;
}

export interface WorkerRef {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly connected: boolean;
  readonly os: string | null;
  readonly arch: string | null;
  readonly tools: readonly string[];
}

export interface PreviewRejection {
  readonly workerId: string;
  readonly reasons: readonly PlacementReason[];
}

export interface RuntimeAvailability {
  readonly runtime: RuntimeKind;
  readonly verdict: PlacementResult['kind'];
  /** Workers that could take it now. */
  readonly eligible: readonly string[];
  /** Workers that could run it at all (no permanent reason) — later, when free/online. */
  readonly feasible: readonly string[];
  readonly summary: readonly ReasonSummary[];
}

export interface ModelProfileOption {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  /** The runtime default (or the project's first allowed profile) on at least one worker. */
  readonly isDefault: boolean;
  /** Workers whose effective policy offers this profile to the project. */
  readonly workers: readonly string[];
  /**
   * p5-credentials-models: `policy` = a runtime-policy profile (the job's model is its name); `catalog` = a model
   * catalog profile offered to workers whose policy defines no profiles for the runtime. `value` is what to put in
   * the job's `model`: the profile name / catalog id (the master resolves a catalog id into the job's model
   * profile — runtime model string and credential).
   */
  readonly source: 'policy' | 'catalog';
  readonly value: string;
  readonly displayName?: string;
  readonly pricing?: Readonly<Record<string, number>>;
  readonly limits?: Readonly<Record<string, number>>;
  /** The project's (or the global) default profile for the runtime in the model catalog. */
  readonly projectDefault: boolean;
}

export interface PreviewIssue {
  readonly code: string;
  readonly message: string;
}

export interface PlacementPreview {
  readonly project: string;
  readonly hostExecution: boolean;
  /** p5-sandbox-ops: the project allows the unconfined profile (ADR-0019). */
  readonly unconfinedExecution: boolean;
  /** p5-full-access: the project allows `approvalPolicy: "allow-all"` (ADR-0020). */
  readonly autoApproveExecution: boolean;
  /**
   * p15-autonomy (ADR-0056): the approval policy a trusted job of this project gets when the user picks none —
   * `allow-all` when the security policy defaults jobs to "never ask" and the project allows it, else `ask-sensitive`.
   */
  readonly defaultApprovalPolicy: 'allow-all' | 'ask-sensitive';
  /**
   * The composer's one-switch "Full access" (unconfined + allow-all + trusted): available when the project allows
   * host execution, unconfined and auto-approve and at least one enrolled worker has `unconfined` ready and
   * advertises `full-access-v1`. `reasons` say exactly what is missing; `workers` are the workers that could run it.
   */
  readonly fullAccess: {
    readonly available: boolean;
    readonly reasons: readonly PreviewIssue[];
    readonly workers: readonly string[];
  };
  readonly sandboxProfile: SandboxProfile;
  /** Composer-level rules the master or worker would refuse (sandbox vs source trust, host opt-in). */
  readonly issues: readonly PreviewIssue[];
  /** Placement of the draft as is; null when no runtime is chosen yet. */
  readonly placement: {
    readonly runtime: RuntimeKind;
    readonly verdict: PlacementResult['kind'] | 'held';
    readonly holds: readonly ReasonSummary[];
    readonly candidates: readonly {
      readonly workerId: string;
      readonly score: number;
      readonly breakdown: Readonly<Record<string, number>>;
    }[];
    readonly rejected: readonly PreviewRejection[];
    readonly summary: readonly ReasonSummary[];
    /** p6-smart-routing: why the first candidate would be chosen ("chosen because …"); null when not placed. */
    readonly explanation: string | null;
  } | null;
  /**
   * p6-smart-routing: the draft's kind and the routing rule in force for it. `runtime`: the runtime the rule's order
   * picks for a draft that names none (first one a machine can take now, else could run; null = none / no order).
   */
  readonly routing: {
    readonly role: JobRole | null;
    readonly roleSource: 'explicit' | 'inferred' | null;
    readonly rule: EffectiveRoutingRule | null;
    readonly runtime: RuntimeKind | null;
  };
  /** Every runtime evaluated with the draft's other constraints. */
  readonly runtimes: readonly RuntimeAvailability[];
  readonly modelProfiles: readonly ModelProfileOption[];
  /**
   * The model the draft resolves to for the chosen runtime (null when no runtime is chosen). `defaultProfile`: the
   * project / global default applied when the draft names none (every runtime has a default model of its own).
   */
  readonly model: {
    readonly runtime: RuntimeKind;
    readonly defaultProfile: string | null;
    readonly defaultScope: 'project' | 'global' | null;
    /** p6-smart-routing: `routing` = the kind's routing rule picked `defaultProfile`; `default` = the model default. */
    readonly defaultSource: 'routing' | 'default' | null;
    /**
     * p15-model-picker: `defaultProfile` is a model id default, not a profile (the global one is soft: a machine's own
     * default model wins over it).
     */
    readonly defaultModel: boolean;
  } | null;
  /** Ready sandbox profiles and which workers have them ready. */
  readonly sandbox: readonly { readonly profile: SandboxProfile; readonly workers: readonly string[] }[];
  /** Effective run-limit defaults (project + global quota policy job limits). */
  readonly limits: JobLimits;
  readonly workers: readonly WorkerRef[];
}

const SECRET_WORKER = /^worker:([A-Za-z0-9_.:-]{1,128})\/secret:/;
const HOST_PROFILES = new Set<SandboxProfile>(['host-restricted', 'runtime-sandbox']);

function placementJob(
  draft: PreviewDraft,
  runtime: RuntimeKind,
  sandboxProfile: SandboxProfile,
  repositoryRegistered: boolean,
  modelProblem: string | null = null,
  workspace = false,
  unconfinedOptIn = false,
  autoApproveOptIn = false,
  model: Pick<PlacementJob, 'modelProfile'> = {},
  explain: Pick<PlacementJob, 'kind' | 'model'> = {},
): PlacementJob {
  const secretWorkers = new Set<string>();
  for (const ref of Object.values(draft.secretRefs ?? {})) {
    const m = SECRET_WORKER.exec(ref);
    if (m?.[1] !== undefined) secretWorkers.add(m[1]);
  }
  return {
    ...(modelProblem === null ? {} : { modelProfileUnavailable: modelProblem }),
    ...(model.modelProfile === undefined ? {} : { modelProfile: model.modelProfile }),
    ...explain,
    project: draft.project,
    // ADR-0015: a composed job uses the project's registered repository when it has one; a workspace job
    // (p5-research-workspace) has none and needs `workspace-v1` workers.
    // p5-live-fixes-2: a repository job needs git on the worker (implicit tool requirement).
    ...(workspace ? { workspace: true } : { repositoryRegistered, repository: true }),
    runtime,
    runtimeVersion: draft.runtimeVersion,
    sandboxProfile,
    ...(sandboxProfile === 'unconfined' ? { unconfinedOptIn } : {}),
    ...(draft.approvalPolicy === undefined ? {} : { approvalPolicy: draft.approvalPolicy }),
    ...(draft.approvalPolicy === 'allow-all' ? { autoApproveOptIn } : {}),
    os: draft.requirements?.os,
    arch: draft.requirements?.arch,
    tools: draft.requirements?.tools,
    workers: draft.requirements?.workers,
    secretWorkers: [...secretWorkers],
    // A job being composed has no history: nobody declined it, it failed nowhere.
    declinedBy: [],
    failedOn: [],
  };
}

/** Policy exclusions the worker's runtime gate would apply (p3-runtime-policy §1 resolution). */
export function policyBlocks(
  doc: RuntimePolicyDocument | null,
  runtime: RuntimeKind,
  project: string,
  model: string | undefined,
): PlacementReason[] {
  if (doc === null) return [];
  // Same as the worker gate (runtime-gate.ts): a job model names a policy profile only when the runtime's rule
  // defines profiles; otherwise it is a catalog id / model string and the policy has nothing to check.
  const hasProfiles = (doc.runtimes[runtime]?.modelProfiles.length ?? 0) > 0;
  const r = resolveModelProfile(doc, runtime, project, hasProfiles ? (model ?? null) : null);
  if (r.ok) return [];
  if (r.code === 'runtime_not_allowed') {
    return [{ code: 'runtime_not_allowed_by_policy', permanent: true, message: r.message }];
  }
  return [{ code: 'model_profile_not_allowed', permanent: true, message: r.message }];
}

/** Runtimes whose rule allows unverified capabilities (`allowUnverified`). */
function allowUnverifiedOf(doc: RuntimePolicyDocument | null): string[] {
  if (doc === null) return [];
  return Object.entries(doc.runtimes).flatMap(([runtime, rule]) =>
    rule.allowUnverified === true ? [runtime] : [],
  );
}

function verdictOf(result: PlacementResult) {
  const feasible = result.rejected.filter((r) => !r.reasons.some((x) => x.permanent)).map((r) => r.workerId);
  const eligible = result.kind === 'placed' ? result.ranked.map((x) => x.workerId) : [];
  const summary = result.kind === 'placed' ? summarizeRejected(result.rejected) : result.summary;
  return { eligible, feasible: [...eligible, ...feasible], summary };
}

function summarizeRejected(rejected: PlacementResult['rejected']): ReasonSummary[] {
  const by = new Map<string, { r: PlacementReason; workers: string[]; messages: Set<string> }>();
  for (const rej of rejected) {
    for (const r of rej.reasons) {
      const e = by.get(r.code) ?? { r, workers: [], messages: new Set<string>() };
      e.workers.push(rej.workerId);
      e.messages.add(r.message);
      by.set(r.code, e);
    }
  }
  return [...by.values()]
    .map((e) => ({
      code: e.r.code,
      permanent: e.r.permanent,
      message: [...e.messages].slice(0, 3).join('; '),
      workers: e.workers.sort(),
    }))
    .sort((a, b) => Number(b.permanent) - Number(a.permanent) || a.code.localeCompare(b.code));
}

function catalogMeta(e: {
  readonly displayName: string;
  readonly pricing: Readonly<Record<string, number | undefined>>;
  readonly limits: Readonly<Record<string, number | undefined>>;
}): { displayName: string; pricing?: Record<string, number>; limits?: Record<string, number> } {
  const defined = (o: Readonly<Record<string, number | undefined>>): Record<string, number> =>
    Object.fromEntries(Object.entries(o).filter((x): x is [string, number] => x[1] !== undefined));
  const pricing = defined(e.pricing);
  const limits = defined(e.limits);
  return {
    displayName: e.displayName,
    ...(Object.keys(pricing).length === 0 ? {} : { pricing }),
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
  };
}

export async function previewPlacement(deps: PreviewDeps, input: PreviewDraft): Promise<PlacementPreview> {
  // p21-pin-by-name: a machine pinned by its name or label ("linux-worker-1") is matched as the job store matches it
  // when the job is created (`resolveWorkerAffinity`) — the preview used to treat the name as an id and found no
  // machine ("No machine can run this target … pinned to linux-worker-1") for a job that then ran there.
  const affinity: { path: string; code: string }[] = [];
  const draft = (await resolveWorkerAffinity(deps.db, input, affinity)) as PreviewDraft;
  const sandboxProfile: SandboxProfile = draft.sandboxProfile ?? 'container';
  const project = await deps.db.query<{
    host_execution: boolean;
    unconfined_execution: boolean;
    auto_approve_execution: boolean;
    kind: string;
  }>(
    'SELECT host_execution, unconfined_execution, auto_approve_execution, kind FROM projects WHERE id = $1',
    [draft.project],
  );
  const hostExecution = project.rows[0]?.host_execution === true;
  const unconfinedExecution = project.rows[0]?.unconfined_execution === true;
  const autoApproveExecution = project.rows[0]?.auto_approve_execution === true;
  const workspace = project.rows[0]?.kind === 'workspace';
  const git = await deps.db.query('SELECT 1 FROM project_git_configs WHERE project = $1', [draft.project]);
  const repositoryRegistered = (git.rowCount ?? 0) > 0;
  const issues: PreviewIssue[] = [];
  for (const a of affinity) {
    const i = Number(a.path.split('.').at(-1));
    const name = input.requirements?.workers?.[i] ?? '?';
    issues.push({
      code: a.code,
      message:
        a.code === 'ambiguous_worker'
          ? `more than one machine is called ${name}; pin it by its id`
          : `no machine is called ${name}; pin a machine by its id or name (describe_worker)`,
    });
  }
  if (draft.sourceTrust !== 'trusted' && sandboxProfile !== 'container') {
    issues.push({
      code: 'untrusted_needs_container',
      message:
        'untrusted (or unspecified) source runs only in the container profile (ADR-0010 rule 3); mark the source trusted or choose container',
    });
  }
  if (HOST_PROFILES.has(sandboxProfile) && !hostExecution) {
    issues.push({
      code: 'host_execution_not_enabled',
      message: `project ${draft.project} has not opted in to host-native profiles; workers refuse ${sandboxProfile} (an admin enables host execution in Projects > ${draft.project} > Execution policy)`,
    });
  }
  if (sandboxProfile === 'unconfined' && !unconfinedExecution) {
    issues.push({
      code: 'unconfined_not_opted_in',
      message: `project ${draft.project} does not allow the unconfined profile (ADR-0019); an admin allows it in Projects > ${draft.project} > Policy > Execution policy, and the worker must allow it too (Machines > <machine> > Sandbox & policy)`,
    });
  }
  if (draft.approvalPolicy === 'allow-all') {
    if (draft.sourceTrust !== 'trusted') {
      issues.push({
        code: 'auto_approve_requires_trusted_source',
        message:
          'an untrusted (or unspecified) source is never auto-approved (ADR-0020); mark the source trusted or choose an asking approval policy',
      });
    }
    if (!autoApproveExecution) {
      issues.push({
        code: 'auto_approve_not_allowed',
        message: `project ${draft.project} does not allow auto-approve ("Never ask"); an admin allows it in Projects > ${draft.project} > Execution policy`,
      });
    }
  }

  const base = await deps.candidates(draft.project);
  const names = await deps.db.query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM workers WHERE state <> $1',
    ['pending'],
  );
  const nameOf = new Map(names.rows.map((r) => [r.id, r.display_name]));
  const enrolled = base.filter((w) => w.state !== 'quarantined');
  const policies = new Map<string, RuntimePolicyDocument | null>();
  for (const w of enrolled) policies.set(w.id, await deps.policyOf(w.id));
  const catalog = await loadCatalog(deps.db);
  const defaults = await deps.db.query<{
    project: string;
    runtime: string;
    profile_id: string | null;
    model: string | null;
  }>("SELECT project, runtime, profile_id, model FROM model_defaults WHERE project IN ('', $1)", [
    draft.project,
  ]);
  /** The project default wins over the global one (p15-model-picker: a profile or a model id). */
  const defaultScoped = (runtime: string): DefaultChoice | null =>
    pickDefault(
      defaults.rows.filter((d) => d.runtime === runtime),
      draft.project,
    );
  const defaultFor = (runtime: string): string | null => defaultScoped(runtime)?.id ?? null;
  // p6-smart-routing: the draft's kind and its routing rule (as the job store resolves them at submission).
  const role = jobRoleOf({ role: draft.role, prompt: draft.promptHead });
  const rule = effectiveRoutingRule(await loadRoutingRules(deps.db, draft.project), draft.project, role.role);

  const evaluate = async (runtime: RuntimeKind, draftModel: string | undefined) => {
    // What the master would make of the draft's model at submission (catalog profile,
    // or the project / global default when it names none).
    const resolved = resolveWithCatalog(
      catalog,
      runtime,
      draftModel,
      draftModel === undefined ? defaultScoped(runtime) : null,
      draftModel === undefined ? rule : null,
    );
    const model = resolved.model;
    const modelProfile = await jobModelProfileFacts(deps.db, resolved.modelProfile);
    const q = await deps.quotas(draft.project, runtime);
    const outcomes =
      deps.outcomes === undefined
        ? new Map<string, PlacementOutcomes>()
        : await deps.outcomes({ project: draft.project, runtime, model: model ?? '', kind: role.role ?? '' });
    const workers = q.adjust(base).map((w) => {
      const o = outcomes.get(w.id);
      const withOutcomes = o === undefined ? {} : { outcomes: o };
      const policy = policies.get(w.id) ?? null;
      const blocks = policyBlocks(policy, runtime, draft.project, model);
      // p5-first-live-fixes: predict the worker gate's capability_unverified refusal (ADR-0008); no policy
      // applied = nothing allows unverified capabilities.
      const allowUnverifiedRuntimes = allowUnverifiedOf(policy);
      return blocks.length === 0
        ? { ...w, ...withOutcomes, allowUnverifiedRuntimes }
        : { ...w, ...withOutcomes, policyBlocks: blocks, allowUnverifiedRuntimes };
    });
    return {
      result: place(
        placementJob(
          draft,
          runtime,
          sandboxProfile,
          repositoryRegistered,
          model === undefined ? null : catalogProblem(catalog, model, runtime),
          workspace,
          unconfinedExecution,
          autoApproveExecution,
          modelProfile === undefined ? {} : { modelProfile },
          { kind: role.role, ...(model === undefined ? {} : { model }) },
        ),
        workers,
      ),
      quotas: q,
      model,
      source: resolved.source,
    };
  };

  const runtimes: RuntimeAvailability[] = [];
  let limits: JobLimits = {};
  for (const runtime of RuntimeKind.options) {
    // Availability ignores the model choice (a profile belongs to one runtime), not the runtime's default.
    const { result, quotas } = await evaluate(runtime, undefined);
    limits = quotas.limits;
    const v = verdictOf(result);
    runtimes.push({
      runtime,
      verdict: result.kind,
      eligible: v.eligible,
      feasible: v.feasible,
      summary: v.summary,
    });
  }

  let placement: PlacementPreview['placement'] = null;
  let modelInfo: PlacementPreview['model'] = null;
  const modelProfiles: ModelProfileOption[] = [];
  if (draft.runtime !== undefined) {
    const { result, quotas, model: resolvedModel, source } = await evaluate(draft.runtime, draft.model);
    const scoped = draft.model === undefined ? defaultScoped(draft.runtime) : null;
    const routed = source === 'project-routing' || source === 'global-routing';
    modelInfo = {
      runtime: draft.runtime,
      // p15-model-picker: a model id default is shown by its id (`defaultModel` says which kind it is).
      defaultProfile: routed ? (resolvedModel ?? null) : (scoped?.id ?? scoped?.model ?? null),
      defaultModel: !routed && scoped?.model !== undefined,
      defaultScope: routed ? (source === 'project-routing' ? 'project' : 'global') : (scoped?.scope ?? null),
      defaultSource: routed ? 'routing' : scoped === null ? null : 'default',
    };
    const held = quotas.holds.length > 0;
    placement = {
      runtime: draft.runtime,
      verdict: held ? 'held' : result.kind,
      holds: quotas.holds,
      candidates:
        result.kind === 'placed'
          ? result.ranked.map((r) => ({
              workerId: r.workerId,
              score: r.score,
              breakdown: { ...r.breakdown },
            }))
          : [],
      rejected: result.rejected.map((r) => ({ workerId: r.workerId, reasons: r.reasons })),
      summary: verdictOf(result).summary,
      explanation: result.kind === 'placed' ? result.explanation : null,
    };
    const byName = new Map<string, { option: Omit<ModelProfileOption, 'workers'>; workers: string[] }>();
    for (const w of enrolled) {
      const doc = policies.get(w.id) ?? null;
      const rule = doc?.runtimes[draft.runtime];
      if (doc === null || rule === undefined) continue;
      const restriction = doc.projectProfiles[draft.project]?.[draft.runtime];
      const allowed = rule.modelProfiles.filter(
        (p) => restriction === undefined || restriction.includes(p.name),
      );
      const def = resolveModelProfile(doc, draft.runtime, draft.project, null);
      for (const p of allowed) {
        const c = catalog.get(p.name)?.entry;
        const e = byName.get(p.name) ?? {
          option: {
            name: p.name,
            provider: p.provider,
            model: p.model,
            isDefault: false,
            source: 'policy' as const,
            value: p.name,
            ...(c === undefined ? {} : catalogMeta(c)),
            projectDefault: defaultFor(draft.runtime) === p.name,
          },
          workers: [],
        };
        if (def.ok && def.profile?.name === p.name) e.option = { ...e.option, isDefault: true };
        e.workers.push(w.id);
        byName.set(p.name, e);
      }
    }
    // Catalog profiles for workers whose policy defines no profiles for the runtime (model id passed through).
    const runtime = draft.runtime;
    const plain = enrolled.filter((w) => {
      const doc = policies.get(w.id) ?? null;
      if (doc === null) return true;
      const rule = doc.runtimes[runtime];
      return rule !== undefined && rule.modelProfiles.length === 0;
    });
    if (plain.length > 0) {
      for (const { entry } of [...catalog.values()].sort((a, b) => a.entry.id.localeCompare(b.entry.id))) {
        if (!entry.enabled || !entry.runtimes.includes(runtime) || byName.has(entry.id)) continue;
        byName.set(entry.id, {
          option: {
            name: entry.id,
            provider: entry.provider,
            model: entry.model,
            isDefault: false,
            source: 'catalog',
            // The catalog id: the master resolves it into the job's model profile at submission.
            value: entry.id,
            ...catalogMeta(entry),
            projectDefault: defaultFor(runtime) === entry.id,
          },
          workers: plain.map((w) => w.id),
        });
      }
    }
    for (const { option, workers } of [...byName.values()].sort((a, b) =>
      a.option.name.localeCompare(b.option.name),
    )) {
      modelProfiles.push({ ...option, workers: workers.sort() });
    }
  }

  const sandbox = SandboxProfile.options.map((profile) => ({
    profile,
    workers: enrolled.filter((w) => w.sandboxProfiles.includes(profile)).map((w) => w.id),
  }));
  // The one-switch "Full access" (ADR-0020): what the project and the fleet allow, with the exact reasons.
  const fullAccessWorkers = enrolled
    .filter((w) => w.sandboxProfiles.includes('unconfined') && w.fullAccessSupported === true)
    .map((w) => w.id);
  const fullAccessReasons: PreviewIssue[] = [];
  const policyPath = `Projects > ${draft.project} > Execution policy`;
  if (!hostExecution) {
    fullAccessReasons.push({
      code: 'host_execution_not_enabled',
      message: `project ${draft.project} does not allow host execution (${policyPath}, "Full access" preset)`,
    });
  }
  if (!unconfinedExecution) {
    fullAccessReasons.push({
      code: 'unconfined_not_opted_in',
      message: `project ${draft.project} does not allow the unconfined profile (${policyPath}, "Full access" preset)`,
    });
  }
  if (!autoApproveExecution) {
    fullAccessReasons.push({
      code: 'auto_approve_not_allowed',
      message: `project ${draft.project} does not allow auto-approve (${policyPath}, "Full access" preset)`,
    });
  }
  if (!enrolled.some((w) => w.sandboxProfiles.includes('unconfined'))) {
    fullAccessReasons.push({
      code: 'unconfined_not_enabled',
      message:
        'no worker has the unconfined profile allowed and ready (Machines > <machine> > Sandbox & policy > "Allow unconfined")',
    });
  } else if (fullAccessWorkers.length === 0) {
    fullAccessReasons.push({
      code: 'approval_policy_unsupported',
      message:
        'no worker with the unconfined profile supports "Never ask" (full-access-v1); update the worker',
    });
  }
  const jobApproval = (
    await loadSecurityDocument(deps.db)
      .then(effectivePolicy)
      .catch(() => null)
  )?.autonomy.jobApproval;
  return {
    project: draft.project,
    hostExecution,
    unconfinedExecution,
    autoApproveExecution,
    defaultApprovalPolicy:
      jobApproval === 'allow-all' && autoApproveExecution ? 'allow-all' : 'ask-sensitive',
    fullAccess: {
      available: fullAccessReasons.length === 0,
      reasons: fullAccessReasons,
      workers: fullAccessWorkers,
    },
    sandboxProfile,
    issues,
    placement,
    routing: {
      role: role.role,
      roleSource: role.source,
      rule,
      runtime: rule === null ? null : routedRuntime(rule.runtimes, runtimes),
    },
    runtimes,
    modelProfiles,
    model: modelInfo,
    sandbox,
    limits,
    workers: enrolled.map((w) => ({
      id: w.id,
      name: nameOf.get(w.id) ?? w.id,
      state: w.state,
      connected: w.connected,
      os: w.os,
      arch: w.arch,
      tools: w.tools ?? [],
    })),
  };
}
