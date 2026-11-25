import { z } from 'zod';
import { AssignedTlsPins, FunctionSpec } from './function-job.js';
import { IntegrationPlan } from './integration.js';
import { JobTitle } from './job-title.js';
import {
  ApprovalPolicy,
  Arch,
  AttemptId,
  Epoch,
  Identifier,
  OsFamily,
  RuntimeKind,
  SandboxProfile,
  Text,
  Timestamp,
  WorkerId,
} from './common.js';
import { Ack } from './control.js';
import { LeaseKey } from './lease.js';
import { anonymousMessage, jobMessage, workerMessage } from './envelope.js';
import { ReleaseChannel, ReleaseVersion } from './release.js';
import { ApplyVersionCatalogPayload } from './update-channel.js';
import { PolicyName, RuntimePolicyDelivery } from './runtime-policy.js';
import { AssignedSkills, SkillFilePathV2 } from './skills.js';
import { AssignedMcp } from './mcp.js';
import { JobRole } from './routing.js';
import { JobArea } from './runtime-advice.js';
import { CredentialRef, ModelId, WorkerConfigDelivery } from './worker-config.js';
import {
  ApplyCredentialPayload,
  RevokeCredentialPayload,
  RotateVaultKeyPayload,
} from './credential-vault.js';
import { OpsCommandPayload } from './remote-ops.js';
import {
  AssistantCancelPayload,
  AssistantResumePayload,
  AssistantToolResultPayload,
  AssistantTurnPayload,
  JobMessagePayload,
} from './assistant.js';
import { AssistantAttachmentDataPayload } from './chat-input.js';
import { InputRef, MAX_INPUTS, SiteBundleRequest, WorkspaceJobSpec } from './workspace.js';
import { AssignedRepoEgress } from './repo-egress.js';
import { AssignedMachineAdmin, MachineAdminDecisionPayload } from './machine-admin.js';
import { JobDelivery } from './job-delivery.js';
import { SetApprovalPolicyPayload } from './approval-mode.js';
import { SetTimeLimitPayload } from './time-limit.js';
import { ApprovalWait, AssignedResume, PauseJobPayload } from './approval-pause.js';
import { UsageLimitPark } from './usage-limit.js';
import { ContinuityPolicy } from './continuity.js';
import { AssignedAccount } from './runtime-accounts.js';
import { AssignedSubtasks, JobFamily, SubtaskStatusPayload } from './subtasks.js';
import { AssignedAskUser, QuestionStatusPayload } from './questions.js';
import {
  AssignedServices,
  ServiceControlPayload,
  ServiceLogsRequestPayload,
  ServiceResultPayload,
  ServiceStartPayload,
  ServiceTunnelPayload,
} from './services.js';
import { gitIdentityEmailProblem, gitIdentityNameProblem } from './git-identity.js';
import {
  IdeControlPayload,
  IdeFileRequestPayload,
  IdeGitPayload,
  IdeNoticePayload,
  IdeStartPayload,
} from './ide.js';
import { StreamClose, StreamOpen, StreamWindow } from './stream.js';
import { AssignedGitAuth } from './git-central.js';
import {
  AssignedKeepFiles,
  AssignedSeedFiles,
  WorkfilesDataPayload,
  WorkfilesRequestPayload,
} from './workfiles.js';
import { AssignedInputBundle, InputBundleDataPayload } from './input-bundles.js';
import { AssignedBlobUpload, BlobUploadGrantPayload, BlobUploadStatusPayload } from './blob-uploads.js';
import { AssignedOutputLimits } from './output-limits.js';
import { AssignedVerifiedCapabilities } from './runtime-verification.js';
import { ProtocolVersion } from './version.js';
import {
  AssignedPreviews,
  JobPreviewRequest,
  PreviewResultPayload,
  TunnelStartPayload,
  TunnelStopPayload,
} from './previews.js';

/** Lease token signed by the master (ADR-0004); opaque to the worker except for verification. */
const LeaseToken = z.string().min(16).max(4096);

export const Challenge = anonymousMessage(
  'CHALLENGE',
  z.object({ nonce: z.string().min(16).max(128), expiresAt: Timestamp }),
);

export const SessionEstablished = workerMessage(
  'SESSION_ESTABLISHED',
  z.object({
    negotiatedVersion: ProtocolVersion,
    sessionExpiresAt: Timestamp,
    /** Highest worker `seq` the master has durably processed; the worker replays anything after it. */
    resumeFromSeq: z.number().int().min(0).optional(),
    /**
     * Public keys the master signs lease tokens with (p4-leases; additive in 1.0). The worker verifies
     * ASSIGN_JOB / RENEW_LEASE tokens against them (and against its configured pin, if any).
     */
    leaseKeys: z.array(LeaseKey).max(8).optional(),
  }),
);

/**
 * The worker proved possession of an unknown key and presented a pairing code:
 * it is now a `pending` worker waiting for an admin to approve it after matching
 * the code and the fingerprint (ADR-0005 §3). The connection stays open; nothing
 * but waiting (and HEARTBEAT-free silence) is allowed until ENROLL_APPROVED.
 */
export const EnrollPending = workerMessage(
  'ENROLL_PENDING',
  z.object({
    fingerprint: z.string().regex(/^SHA256:([0-9A-F]{4}-){15}[0-9A-F]{4}$/),
    /** The pairing request expires (and must be restarted) at this time. */
    expiresAt: Timestamp,
  }),
);

export const EnrollApproved = workerMessage(
  'ENROLL_APPROVED',
  z.object({ workerId: WorkerId, approvedAt: Timestamp }),
);

/** `secret:<name>` or `worker:<workerId>/secret:<name>` (ADR-0006 §2); values never cross the wire. */
export const SecretRefString = z
  .string()
  .max(256)
  .regex(/^(worker:[A-Za-z0-9_.:-]{1,128}\/)?secret:[A-Za-z0-9_-]{1,64}$/, 'secret reference');

export const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'environment variable name');

/**
 * p5-openhands-model-headers (additive in 1.0; only to `model-profile-v1` workers): the model catalog profile a
 * job uses — the one it named (`model` = the catalog id) or the project / global default for its runtime
 * (Settings → Models → Defaults). Filled by the master from the catalog at submission; a submitter's value is
 * never trusted. Never a credential value: `credentialRef` is a reference the worker resolves in its own store.
 *
 *  - `model`: what the runtime is started with (Pi / OpenCode `provider/model`, else the model id);
 *  - `credentialRef`: replaces the worker's runtime auth for this job (env: the reference's, else the runtime's).
 *
 * ADR-0023: the OpenHands-only `baseUrl` and `headers` were removed (stored history may still carry them).
 */
export const JobModelProfile = z.object({
  id: PolicyName,
  model: ModelId,
  credentialRef: CredentialRef.optional(),
});
export type JobModelProfile = z.infer<typeof JobModelProfile>;

/**
 * p6-quota-scheduling (additive in 1.0): one fallback runtime of a job. `model` is what the submitter named (a
 * catalog profile id or a model id, like `JobSpec.model`); `modelProfile` is the master's resolution of the
 * catalog for that runtime at submission (never the submitter's value).
 */
export const JobRuntimeFallback = z.object({
  runtime: RuntimeKind,
  model: z.string().max(128).optional(),
  modelProfile: JobModelProfile.optional(),
  /** p15-model-picker: the global default model for that runtime (see `JobSpec.defaultModel`). */
  defaultModel: ModelId.optional(),
});
export type JobRuntimeFallback = z.infer<typeof JobRuntimeFallback>;

/** At most this many fallback runtimes per job (p6-quota-scheduling). */
export const MAX_RUNTIME_FALLBACKS = 3;

/**
 * p6-quota-scheduling: JobSpec fields the master keeps for scheduling and never sends to a worker (the
 * ASSIGN_JOB spec is the chosen runtime's plain spec).
 */
export const MASTER_ONLY_SPEC_FIELDS = ['fallbacks', 'deferrable', 'delivery'] as const;

export const JobSpec = z
  .object({
    /**
     * Project the job belongs to; the worker checks it against its local repository allowlist
     * (p3-workspace, T-WRK-4). Optional on the wire for 1.0 compatibility: the master always fills it from
     * the job record when it sends ASSIGN_JOB, and the worker refuses a job without it.
     */
    projectId: Identifier.optional(),
    runtime: RuntimeKind,
    runtimeVersion: z.string().max(64).optional(),
    model: z.string().max(128).optional(),
    /** The resolved catalog profile ({@link JobModelProfile}); master-filled. */
    modelProfile: JobModelProfile.optional(),
    /**
     * p15-model-picker (additive in 1.0, `runtime-models-v1`): the panel's global default model for the runtime (a
     * model id), master-filled when the job names no model and no project default / routing rule applies. Weaker than
     * the machine's own default: the worker uses it only when its configuration names no model for the runtime and its
     * runtime policy defines no profiles. Older workers strip it (their own default applies).
     */
    defaultModel: ModelId.optional(),
    prompt: z
      .string()
      .min(1)
      .max(256 * 1024),
    /**
     * p15-job-titles (additive in 1.0): the job's short title (one line, ≤ 60 characters); the prompt is its
     * description. Absent = the master derives one from the prompt (`deriveJobTitle`). The master keeps the current
     * title (it can be edited) in `job_titles` and sends it in ASSIGN_JOB; the worker uses it as the subject of its
     * publish commit. Older workers strip it when parsing.
     */
    title: JobTitle.optional(),
    /**
     * The repository the attempt checks out. Optional on the wire since p5-research-workspace (additive in 1.0): a
     * spec has exactly one of `repository` (repository project) and `workspace` (workspace project). Workers that
     * predate workspaces require it; the master never sends them a workspace job (feature `workspace-v1`).
     */
    repository: z
      .object({
        url: z.url({ protocol: /^(https|ssh)$/ }),
        baseRef: z.string().min(1).max(255),
        workBranch: z.string().min(1).max(255),
        /**
         * p18-leftovers (additive in 1.0, master-only): the branch the job's pull request targets when `baseRef` is a
         * commit (the "Değişiklik iste" follow-up of a reviewed job starts at the reviewed head). Absent: `baseRef` when
         * it is a branch, else the project's base branch. Workers ignore it.
         */
        targetBranch: z.string().min(1).max(255).optional(),
        /**
         * p6-automations-next (ADR-0026; additive in 1.0, only to `pr-head-v1` workers): an untrusted pull request
         * checked out at its head SHA — the worker fetches `refs/pull/<number>/head` of `url` into a quarantine
         * mirror, requires `headSha` there and checks it out (never the ref). Only with `baseRef = headSha`,
         * `sourceTrust: untrusted`, the `container` profile and no `secretRefs`; never pushed.
         */
        pullRequest: z
          .object({
            number: z.number().int().min(1).max(2_147_483_647),
            headSha: z.string().regex(/^[0-9a-f]{40}$/),
          })
          .optional(),
        /**
         * p19-repo-job-inputs (additive in 1.0; only to `repo-inputs-v1` workers): input files of a REPOSITORY job (chat
         * attachments, earlier job outputs, continueFrom) — stored with the job like a workspace job's inputs and
         * fetched with JOB_INPUT_REQUEST. The worker puts them read-only into a scratch `in/` next to the checkout (the
         * attempt's sandbox dir, never inside the repository), so git never sees them. Set by the master from the
         * job's stored inputs only (a submitter's value is dropped); older workers strip it and are never chosen.
         */
        inputs: z.array(InputRef).min(1).max(MAX_INPUTS).optional(),
      })
      .optional(),
    /**
     * p5-research-workspace (additive in 1.0): the job runs in an empty per-attempt scratch directory with these
     * inputs and egress mode, and returns artifacts from `out/`. Filled by the master from the project's workspace
     * settings; a submitter's value is never trusted.
     */
    workspace: WorkspaceJobSpec.optional(),
    /**
     * p6-deploy-pipeline (ADR-0028; additive in 1.0, only to `site-bundle-v1` workers): after a successful run the
     * worker packs the static site under `directory` (relative to the repository worktree, or to `out/` of a
     * workspace job) into one `site-bundle.json` artifact (SiteBundle) that the master can publish to Cloudflare
     * Pages through an ops action. Files are secret-scanned; a hit drops the whole bundle.
     */
    siteBundle: SiteBundleRequest.optional(),
    sandboxProfile: SandboxProfile,
    /**
     * `allow-all` (p5-full-access, ADR-0020; additive in 1.0) is sent only to `full-access-v1` workers, for trusted
     * sources of projects with `allowAutoApprove` (`execution.autoApproveOptIn`). Older workers do not parse it and
     * are never chosen for such a job (placement reason `approval_policy_unsupported`).
     */
    approvalPolicy: ApprovalPolicy,
    limits: z.object({
      maxDurationSec: z
        .number()
        .int()
        .min(1)
        .max(7 * 24 * 3600),
      maxCostUsd: z.number().min(0).optional(),
      /**
       * p4-quotas run budget (additive in 1.0): input + output tokens and model turns of the whole job, summed
       * from its usage events. The master stops the job (`CANCEL_JOB`, reason `budget_exceeded`) when reached.
       */
      maxTokens: z.number().int().min(1).optional(),
      maxTurns: z.number().int().min(1).optional(),
    }),
    /** Additional secrets by reference, env var → reference (p3-secrets-worker). References only. */
    secretRefs: z.record(EnvName, SecretRefString).optional(),
    /**
     * Who authored the source the agent works on (p3-sandbox, ADR-0010 rule 3): `untrusted` (fork PRs,
     * external contributors) runs only in the `container` profile. Absent = `untrusted` (fail closed).
     */
    sourceTrust: z.enum(['trusted', 'untrusted']).optional(),
    /**
     * Job type (additive in 1.0). Absent = an ordinary batch run of `prompt`. ADR-0023 removed the
     * `interactive-openhands` kind (stored history may still carry it; new ones are refused).
     */
    kind: z.enum(['machine-admin', 'integration', 'function']).optional(),
    /**
     * p11-merge-pipeline (ADR-0041; with `kind: "integration"`, only to `integration-v1` workers): the deterministic
     * integration step the master plans — branches to merge into the checked-out integration head, in order. No agent
     * runs; only the master creates such jobs.
     */
    integration: IntegrationPlan.optional(),
    /**
     * p14-workflow-engine 14.3 (ADR-0055; with `kind: "function"`, only to `function-v1` / `function-code-v1` workers):
     * a workflow's HTTP request, e-mail or code node. No agent, no repository, no workspace; only the workflow engine
     * creates such jobs (function-job.ts).
     */
    function: FunctionSpec.optional(),
    /**
     * p6-smart-routing (additive in 1.0): what kind of work the job is (plan, execute, verify, summarise, research,
     * chore). Master-side only: routing rules pick the model / runtime when the job names none, and outcome
     * statistics are kept per kind. Absent = the master's conservative heuristic over the prompt's first line
     * (`inferJobRole`), else unclassified. Workers ignore it (older ones strip it when parsing).
     */
    role: JobRole.optional(),
    /**
     * p11-runtime-advice (additive in 1.0, ADR-0044): the work area (frontend, backend, tests, docs, infra) when the
     * submitter knows it. Master-side only (classification and outcome statistics); absent = the master's
     * deterministic classifier. Workers ignore it (older ones strip it when parsing).
     */
    area: JobArea.optional(),
    /**
     * p5-machine-admin (ADR-0021; with `kind: "machine-admin"`, only to `machine-admin-v1` workers): the one worker
     * the job administers. The job belongs to the built-in `machines` workspace project and is pinned to this
     * worker (`requirements.workers`). Only the master's machine-admin service creates such jobs.
     */
    machineAdmin: z.object({ workerId: Identifier }).optional(),
    /** Placement constraints for the scheduler (p4-scheduler); absent = any. */
    requirements: z
      .object({
        os: z.array(OsFamily).min(1).max(3).optional(),
        arch: z.array(Arch).min(1).max(2).optional(),
        /**
         * p5-composer (additive in 1.0): tools the worker must report in CAPABILITIES.tools (by name, e.g.
         * `git`, `docker`, `node`). Master-side placement only; the worker does not re-check it.
         */
        tools: z
          .array(z.string().regex(/^[A-Za-z0-9_.+-]{1,64}$/, 'tool name'))
          .min(1)
          .max(16)
          .optional(),
        /**
         * p5-composer (additive in 1.0): worker affinity — only these workers may run the job. Master-side
         * placement only (secret-bound jobs are already pinned by their `worker:<id>/secret:` references).
         */
        workers: z.array(Identifier).min(1).max(16).optional(),
      })
      .optional(),
    /**
     * p6-quota-scheduling (additive in 1.0; master-side only, never sent to a worker): runtimes to run the job
     * with, in order, when its own runtime cannot start now — paused by a provider usage limit on every machine
     * that could run it, or not ready (not installed, not logged in, not enabled, model profile unusable). The
     * job record keeps which one ran and why. Distinct runtimes, none equal to `runtime`.
     */
    fallbacks: z.array(JobRuntimeFallback).min(1).max(MAX_RUNTIME_FALLBACKS).optional(),
    /**
     * p6-quota-scheduling (additive in 1.0; master-side only): the job may wait for its project's off-peak window
     * (project setting). Without a window it runs at once; "Run now" overrides the wait.
     */
    deferrable: z.boolean().optional(),
    /**
     * p8-preview-tunnels (ADR-0032; additive in 1.0): "open a preview when the dev server is up" — the port (and
     * name / protection / lifetime) the human declared at submission. The master turns it into
     * `execution.previews` only when the project's previews are configured; workers ignore the spec field.
     */
    previews: JobPreviewRequest.optional(),
    /**
     * p22-output-delivery (additive in 1.0; master-only, never sent to a worker): how a REPOSITORY job delivers its
     * result. `merge` (default when absent): the verified attempt branch waits for the protected merge decision, as
     * before. `outputs`: the job's purpose is producing files — the master copies the files the verified attempt added
     * or changed into the job's outputs (Çıktılar) and the job succeeds without a pull request or a merge decision; the
     * attempt branch stays on the remote as the source. Nothing is merged, so no approval is needed (AGENTS.md rule 10).
     * Workspace jobs always deliver outputs (the value is accepted and changes nothing there).
     */
    delivery: JobDelivery.optional(),
  })
  .refine(
    (s) =>
      s.kind === 'function'
        ? s.repository === undefined && s.workspace === undefined
        : (s.repository === undefined) !== (s.workspace === undefined),
    {
      message: 'a job has exactly one of repository and workspace (a function job has neither)',
      path: ['repository'],
    },
  )
  .refine(
    (s) => {
      const seen = new Set<string>([s.runtime]);
      for (const f of s.fallbacks ?? []) {
        if (seen.has(f.runtime)) return false;
        seen.add(f.runtime);
      }
      return true;
    },
    { message: 'fallback runtimes are distinct and differ from the job runtime', path: ['fallbacks'] },
  )
  .refine((s) => (s.kind === 'integration') === (s.integration !== undefined), {
    message: 'an integration job has kind "integration" and an integration plan (and only it)',
    path: ['integration'],
  })
  .refine(
    (s) =>
      s.integration === undefined ||
      (s.repository !== undefined &&
        s.repository.pullRequest === undefined &&
        s.secretRefs === undefined &&
        s.siteBundle === undefined),
    {
      message: 'an integration job checks out a repository (no pull request head, secrets or site bundle)',
      path: ['integration'],
    },
  )
  .refine((s) => (s.kind === 'function') === (s.function !== undefined), {
    message: 'a function job has kind "function" and a function spec (and only it)',
    path: ['function'],
  })
  .refine(
    (s) =>
      s.function === undefined ||
      (s.secretRefs === undefined &&
        s.siteBundle === undefined &&
        s.integration === undefined &&
        s.modelProfile === undefined &&
        s.machineAdmin === undefined),
    {
      message:
        'a function job has no secret references, site bundle, integration plan, model profile or admin target',
      path: ['function'],
    },
  )
  .refine(
    (s) => s.delivery !== 'outputs' || (s.kind === undefined && s.repository?.pullRequest === undefined),
    {
      message:
        'delivery "outputs" is for ordinary repository or workspace jobs (no pull request head, integration or function)',
      path: ['delivery'],
    },
  )
  .refine((s) => s.repository?.pullRequest === undefined || pullRequestCheckoutProblem(s) === null, {
    message:
      'a pull request checkout needs baseRef = headSha, sourceTrust untrusted, the container profile and no secretRefs',
    path: ['repository', 'pullRequest'],
  });

/**
 * p6-automations-next (ADR-0026): why a spec with `repository.pullRequest` may not run, or null. Shared by the
 * protocol refinement, the master and the worker preflight.
 */
export function pullRequestCheckoutProblem(s: {
  readonly repository?:
    { readonly baseRef: string; readonly pullRequest?: { readonly headSha: string } | undefined } | undefined;
  readonly sourceTrust?: 'trusted' | 'untrusted' | undefined;
  readonly sandboxProfile: string;
  readonly secretRefs?: Readonly<Record<string, string>> | undefined;
}): string | null {
  const pr = s.repository?.pullRequest;
  if (pr === undefined) return null;
  if (s.repository?.baseRef !== pr.headSha) return 'baseRef must be the pinned head SHA';
  if (s.sourceTrust !== 'untrusted') return 'a pull request head is always an untrusted source';
  if (s.sandboxProfile !== 'container') return 'a pull request head runs only in the container profile';
  if (Object.keys(s.secretRefs ?? {}).length > 0) return 'a pull request head job gets no secret references';
  return null;
}

/** p6-automations-next: workers that check out pinned pull request heads (JobSpec.repository.pullRequest). */
export const PR_HEAD_FEATURE = 'pr-head-v1';
/** p6-deploy-pipeline: workers that build `JobSpec.siteBundle` (the master places such jobs only there). */
export const SITE_BUNDLE_FEATURE = 'site-bundle-v1';
export type JobSpec = z.infer<typeof JobSpec>;

/** p11-master-resilience (ADR-0039): the longest offline grace a master may grant (1 h). */
export const MAX_OFFLINE_GRACE_MS = 3_600_000;

const Lease = z.object({
  epoch: Epoch,
  token: LeaseToken,
  expiresAt: Timestamp,
  /**
   * p11-master-resilience (ADR-0039; additive in 1.0, only to `offline-grace-v1` workers): while the worker cannot
   * reach the master at all it keeps running the attempt for up to `ttl + offlineGraceMs` after the send time of
   * its last confirmed LEASE_ACK. The master holds the lease (no LOST, no reassignment) at least that long. Absent
   * or 0: the classic rule (self-fence after ttl + one grace without a confirmed renewal). Older workers ignore it.
   */
  offlineGraceMs: z.number().int().min(0).max(MAX_OFFLINE_GRACE_MS).optional(),
  /**
   * Job secret references (additive in 1.0, ASSIGN_JOB only): the signed vault scope (lease.ts `signVaultScope`) —
   * the vault credential ids this attempt may receive through `spec.secretRefs`. A worker that knows it verifies it
   * (refusing the assignment when it does not verify) and drops every other `secret:vault-*` reference; older workers
   * ignore it. Absent (an older master): no scope, every reference is resolved as before.
   */
  vaultScope: z.string().max(8192).optional(),
});

/**
 * Context bundle issued for the job (p6-context-model `issueForJob`): the rendered, fenced text and its
 * bundle hash. Additive in 1.0.
 */
export const AssignedContext = z.object({
  bundleHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  rendered: z.string().max(192 * 1024),
});

/**
 * p5-git-identity: the commit identity of a repository job (author and committer). Same rules as the panel
 * (`gitIdentityProblem`): name 1–100 characters without control characters or `< >`, a simple email address.
 */
export const GitIdentity = z.object({
  name: z.string().refine((v) => gitIdentityNameProblem(v) === null, 'invalid git identity name'),
  email: z.string().refine((v) => gitIdentityEmailProblem(v) === null, 'invalid git identity email'),
});
export type GitIdentity = z.infer<typeof GitIdentity>;

export const AssignJob = jobMessage(
  'ASSIGN_JOB',
  z.object({
    attemptId: AttemptId,
    lease: Lease,
    spec: JobSpec,
    context: AssignedContext.optional(),
    /**
     * p6-skills (additive in 1.0): signed skill bundles pinned for the job. The worker verifies every
     * signature with the skills keys of its own config and the set hash before materialising anything.
     */
    skills: AssignedSkills.optional(),
    /**
     * p14-mcp-core (ADR-0054; additive in 1.0, only to `mcp-v1` workers): the job's pinned external MCP servers —
     * signed specs, tool rules per server, secret slot → vault reference. The worker verifies every signature with
     * the skills keys of its own config and the set hash, honours its local vetoes, and declines the job on any
     * mismatch. Never sent for untrusted-source jobs.
     */
    mcp: AssignedMcp.optional(),
    /**
     * p5-machine-admin (ADR-0021; only with `kind: "machine-admin"`, only to `machine-admin-v1` workers): the
     * signed session grant the root/SYSTEM helper starts the elevated broker for, the machine's memory and
     * whether elevated commands are signed without a human.
     */
    machineAdmin: AssignedMachineAdmin.optional(),
    /**
     * p5-git-identity (additive in 1.0; repository jobs): the commit identity the project resolves to (project
     * setting, else the workspace default, else Remyral Agent). The worker authors and commits the publish commit
     * with it and exports GIT_AUTHOR_* / GIT_COMMITTER_* into the runtime's environment. Absent (older masters):
     * the worker's built-in default. Older workers ignore it.
     */
    gitIdentity: GitIdentity.optional(),
    /**
     * Project execution policy the worker needs for profile selection (p3-sandbox; additive in 1.0).
     * `hostExecutionOptIn`: the project explicitly allows host-native profiles (ADR-0007). Absent = false.
     * `pushResult` (p4-git-flow, additive): on success the worker commits the final tree with the attempt
     * trailer and pushes `rac/<jobId>/<attemptId>` (force-with-lease, pre-push secret scan); the master then
     * verifies the remote independently. Absent = false (nothing is pushed).
     */
    execution: z
      .object({
        hostExecutionOptIn: z.boolean(),
        pushResult: z.boolean().optional(),
        /**
         * p5-sandbox-ops (ADR-0019; only to `sandbox-ops-v1` workers): the project allows the `unconfined` profile.
         * A job with `sandboxProfile: "unconfined"` is refused without it.
         */
        unconfinedOptIn: z.boolean().optional(),
        /**
         * p5-full-access (ADR-0020; only to `full-access-v1` workers): the project allows `approvalPolicy:
         * "allow-all"`. A job with that policy is refused without it (and always for an untrusted source).
         */
        autoApproveOptIn: z.boolean().optional(),
        /**
         * p6-warm-caches (ADR-0029): the project allows the machine's shared package caches for this job. The worker
         * still hands them only to trusted-source jobs on host profiles. Absent = false (older masters never enable
         * them); older workers ignore it.
         */
        packageCaches: z.boolean().optional(),
        /**
         * p14-skill-import (ADR-0054; sent with skills, honoured by `skill-trust-v1` workers): the project accepts only
         * skills signed with the owner's offline key. The worker then verifies the bundles without its panel skills keys
         * and declines the job if one is panel-signed. Absent = any trusted key. Older workers ignore it.
         */
        skillTrust: z.literal('offline-only').optional(),
        /**
         * p8-orchestration (ADR-0031; only to `subtasks-v1` workers): the project lets this job's agent request
         * sub-jobs (`request_subtask`), with these runtimes and this many levels below it. Absent = no sub-jobs.
         */
        subtasks: AssignedSubtasks.optional(),
        /**
         * p14-ask-user (only to `ask-user-v1` workers): the job's agent may ask the user structured questions
         * (`ask_user` / `wait_for_answer`). Absent = no question tools (the agent asks in its text, as before).
         */
        askUser: AssignedAskUser.optional(),
        /**
         * p8-preview-tunnels (ADR-0032; only to `preview-tunnels-v1` workers): the job may open preview tunnels —
         * the agent's tools, the ports a human declared and the auto-open request. Absent: no previews. Older
         * workers ignore it.
         */
        previews: AssignedPreviews.optional(),
        /**
         * p15-services (only to `services-v1` workers): the job's agent gets `start_service` & co. (SERVICE_REQUEST,
         * fenced by the lease); a service it starts may keep the attempt's worktree after the job ends. Absent: no
         * service tools. Older workers ignore it.
         */
        services: AssignedServices.optional(),
        /**
         * p9-subjob-local-login-deadlock (docs/design/p9-subjob-local-login.md §3): the job's family — the root job of
         * its agent-requested sub-job tree (ADR-0031), its own id for a root job. A worker lets attempts that run as
         * its own account share the machine only within one family (same project). Absent (older masters): every
         * job is its own family. Older workers ignore it.
         */
        family: JobFamily.optional(),
        /**
         * p10-approval-pause (ADR-0036; only to `approval-pause-v1` workers): the master marks long approval waits stale
         * and pauses the job with PAUSE_JOB; the runtime's own approval wait lasts until `pauseAfterSec` plus a backstop
         * margin (instead of the worker default). Absent: the worker default applies. Older workers ignore it.
         */
        approvalWait: ApprovalWait.optional(),
        /**
         * p10-approval-pause: this assignment continues the paused attempt (same `attemptId`, new epoch) from the
         * workspace the worker kept, with the human's decision. Only to the worker that paused it.
         */
        resume: AssignedResume.optional(),
        /**
         * p11-usage-limit-fallback (ADR-0040; only to `usage-limit-park-v1` workers): when the run ends on a provider
         * usage limit, keep the attempt's workspace and session (parked, like an approval pause) until `retainUntil` and
         * report `JOB_RESULT.paused{cause: "usage_limit"}` with the failure. Absent: release as before.
         */
        usageLimitPark: UsageLimitPark.optional(),
        /**
         * p11-session-continuity (ADR-0042; only to `session-continuity-v1` workers): checkpoint this attempt and keep it
         * resumable across a worker restart (CHECKPOINT_REPORT, HEARTBEAT `recoverableJobs`). Absent: no checkpoints,
         * a restart drops the attempt as before (the master reconciles it).
         */
        continuity: ContinuityPolicy.optional(),
        /**
         * p13-runtime-accounts (ADR-0049; only to `runtime-accounts-v1` workers): the runtime account this attempt runs
         * with — one the worker reported in CAPABILITIES `runtimeAccounts`. A model profile's own credential still
         * wins (ADR-0016). Absent: the machine's configured runtime auth (`default`), as before.
         */
        account: AssignedAccount.optional(),
        /**
         * p14-repo-egress (only to `repo-egress-v1` workers; repository agent jobs): the project's effective egress
         * policy (presets expanded). The worker adds `hosts` (allowlist) or any public host on 443 (web) to the job's
         * egress proxy on top of its `sandbox.egressAllow` and the MCP hosts; private / LAN / metadata addresses stay
         * refused. Absent (older masters, `none`): model APIs only, as before. Older workers ignore it.
         */
        repoEgress: AssignedRepoEgress.optional(),
        /**
         * p15-git-central (only to `git-central-v1` workers; repository jobs of a project with a repository credential):
         * the vault credential (deploy key / HTTPS token) the worker uses for this job's fetch / push — a reference,
         * never a value. Absent: the master's job-scoped token (GitHub App), else no credential.
         */
        gitAuth: AssignedGitAuth.optional(),
        /**
         * p15-workspace-retention (only to `workfiles-v1` workers; workspace jobs): keep the attempt's whole working
         * directory after the job ends (any outcome) until `expiresAt`, within the machine cap. Absent: removed at the
         * end as before (succeeded) / retained by the worker's own failure rule. Older workers ignore it.
         */
        keepFiles: AssignedKeepFiles.optional(),
        /**
         * p15-workspace-retention (only to `workfiles-v1` workers; workspace jobs): start from the kept files of an
         * earlier job (follow-up, run again, fix, deploy retry) instead of an empty directory.
         */
        seedFiles: AssignedSeedFiles.optional(),
        /**
         * p16-zip-job-input (only to `input-bundle-v1` workers): the job's input bundle — pulled into `in/` (workspace
         * jobs) or a scratch `in/` next to the checkout (repository jobs, never committed) before the agent runs.
         */
        inputBundle: AssignedInputBundle.optional(),
        /**
         * p17-object-storage (only to `blob-upload-v1` workers; workspace jobs): large outputs go to the master's blob
         * store with an upload grant (BLOB_UPLOAD_REQUEST) instead of ARTIFACT_CHUNKs, within these limits. Absent:
         * the chunk path and its limits, as before. Older workers ignore it.
         */
        blobUpload: AssignedBlobUpload.optional(),
        /**
         * p17-output-limits (only to `output-limits-v1` workers; workspace jobs): the job's output file limit (inline +
         * blob together) and whether the files beyond it may be packed into one overflow zip (with `blobUpload`).
         * Absent: the legacy limits (20 inline files, `blobUpload.maxFiles` large files, no zip).
         */
        outputLimits: AssignedOutputLimits.optional(),
        /**
         * p17-runtime-verify (only to `runtime-capability-verify-v1` workers): the capabilities master-side evidence
         * proved for exactly this worker's runtime tuple (version, OS, arch, adapter revision). The worker's gate admits
         * them although its own table says `unverified` — only when the tuple equals its probe. Older workers ignore it.
         */
        verifiedCapabilities: AssignedVerifiedCapabilities.optional(),
        /**
         * p22-runtime-diagnostics (only to `function-tls-pins-v1` workers; function jobs): the certificates the project
         * pinned per `host:port` (Trust this certificate). An HTTPS hop whose certificate fails verification is accepted
         * only when the presented certificate matches a pin of that hop. Absent: strict verification, as before.
         */
        tlsPins: AssignedTlsPins.optional(),
        /**
         * Job secret references (additive in 1.0; older workers ignore it): the variables of the job's `secretRefs` the
         * master left out of this assignment because the vault credential is not (or no longer) one the project gives
         * its jobs. Names only. The worker reports them in the job's timeline (EVENT `error` `secret_refs_withheld`).
         */
        secretRefsWithheld: z.array(EnvName).max(64).optional(),
      })
      .optional(),
  }),
);

export const RenewLease = jobMessage(
  'RENEW_LEASE',
  z.object({
    attemptId: AttemptId,
    lease: Lease,
    /**
     * p11-master-resilience (ADR-0039; additive in 1.0): the `messageId` of the LEASE_ACK this renewal answers. The
     * worker dates the confirmation by that acknowledgement's send time (never by when the renewal arrived), so a
     * renewal delivered late can never stretch its offline grace past the master's hold. Absent (older masters, a
     * reconciliation resume): the renewal does not start an offline grace by itself.
     */
    ackId: z.uuid().optional(),
  }),
);

export const CancelJob = jobMessage(
  'CANCEL_JOB',
  z.object({ attemptId: AttemptId, epoch: Epoch, reason: Text }),
);

/** p10-approval-pause (ADR-0036): stop the runtime, keep workspace + session, free the slot (`approval-pause-v1`). */
export const PauseJob = jobMessage('PAUSE_JOB', PauseJobPayload);

export const ApprovalDecision = jobMessage(
  'APPROVAL_DECISION',
  z.object({
    attemptId: AttemptId,
    epoch: Epoch,
    approvalId: Identifier,
    decision: z.enum(['approve', 'deny']),
    decidedBy: Identifier,
  }),
);

/**
 * Answer to CREDENTIAL_REQUEST (p4-leases, ADR-0006 §3, T-WRK-4): a short-lived, job-scoped git token.
 * Control message (seq 0): it is never written to the master's durable outbox, so the token exists on the
 * master only in memory while it is sent. `granted` carries the token; `unavailable` means the master has
 * no credential for this repository (public / ssh repos); `refused` means the request was not for the
 * caller's live lease.
 */
export const JobCredential = jobMessage(
  'JOB_CREDENTIAL',
  z.object({
    attemptId: AttemptId,
    epoch: Epoch,
    requestId: z.uuid(),
    kind: z.literal('git'),
    status: z.enum(['granted', 'unavailable', 'refused']),
    token: z.string().min(8).max(4096).optional(),
    username: z.string().min(1).max(128).optional(),
    expiresAt: Timestamp.optional(),
  }),
);

/**
 * Answer to JOB_INPUT_REQUEST (p5-research-workspace; additive in 1.0, control message seq 0): one slice of an
 * input file of a workspace job, only for the holder of the job's live lease. `data` is base64 of at most
 * INPUT_CHUNK_BYTES; `eof` marks the last slice. Never written to the master's durable outbox.
 */
export const JobInputData = jobMessage(
  'JOB_INPUT_DATA',
  z.object({
    attemptId: AttemptId,
    epoch: Epoch,
    requestId: z.uuid(),
    inputId: z.string().regex(/^in-[a-z0-9]{1,32}$/),
    status: z.enum(['ok', 'refused', 'not_found']),
    offset: z.number().int().min(0),
    data: z
      .string()
      .max(262_144)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64'),
    eof: z.boolean(),
  }),
);

/**
 * Answer to SKILL_FILE_REQUEST (p14-skill-catalogs; additive in 1.0, control message seq 0): one slice of a file of a
 * deferred skill pinned to the job, only for the holder of the job's live lease. `data` is base64 of at most
 * SKILL_FILE_CHUNK_BYTES; `eof` marks the last slice. Never written to the master's durable outbox.
 */
export const SkillFileData = jobMessage(
  'SKILL_FILE_DATA',
  z.object({
    attemptId: AttemptId,
    epoch: Epoch,
    requestId: z.uuid(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    path: SkillFilePathV2,
    status: z.enum(['ok', 'refused', 'not_found']),
    offset: z.number().int().min(0),
    data: z
      .string()
      .max(262_144)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64'),
    eof: z.boolean(),
  }),
);

export const Drain = workerMessage('DRAIN', z.object({ deadline: Timestamp.optional(), reason: Text }));

export const RotateCredential = workerMessage(
  'ROTATE_CREDENTIAL',
  z.object({
    deadline: Timestamp,
    reason: Text,
    /** Single-use nonce the rotation statement must include (p2-identity-rotation). */
    nonce: z.string().min(16).max(128).optional(),
  }),
);

/** Outcome of ROTATE_KEY: the new key is active now, or waits for an administrator. */
export const CredentialRotated = workerMessage(
  'CREDENTIAL_ROTATED',
  z.object({
    fingerprint: z.string().regex(/^SHA256:([0-9A-F]{4}-){15}[0-9A-F]{4}$/),
    status: z.enum(['active', 'pending_approval']),
  }),
);

export const WorkerPolicy = z.object({
  allowedProjects: z.array(Identifier).max(1024),
  allowedRuntimes: z.array(RuntimeKind).max(8),
  allowedSandboxProfiles: z.array(SandboxProfile).max(8),
  maxParallelJobs: z.number().int().min(0).max(64),
  /**
   * p3-runtime-policy (additive in protocol 1.0): true = the master does not narrow the worker's local
   * project allowlist with this message (`allowedProjects` is then empty and must be ignored).
   */
  projectsUnrestricted: z.boolean().optional(),
  /**
   * p3-runtime-policy (additive in protocol 1.0): pinned versions, auth modes and model profiles per
   * runtime (docs/design/p3-runtime-policy.md). Workers that predate it strip the field (ADR-0011 §4).
   */
  runtimePolicy: RuntimePolicyDelivery.optional(),
});

export const UpdatePolicy = workerMessage(
  'UPDATE_POLICY',
  z.object({ policyVersion: z.number().int().min(1), policy: WorkerPolicy }),
);

/**
 * A signed worker release is available for this worker (p2-signed-updates, additive in protocol 1.0).
 * Control message (seq 0): the master owns the intent (channel / explicit target in Postgres) and
 * re-evaluates it on every session, like DRAIN. Workers that predate the updater drop it as an unknown
 * type (ADR-0011 §4).
 *
 * The worker downloads manifest + signature and the artifact over HTTPS from the same master origin,
 * presenting `downloadToken` (single worker, single release, short-lived), and trusts nothing in this
 * message: the release signature (pinned key), SHA-256, size, protocol and Node compatibility are all
 * verified locally before anything is staged.
 */
export const UpdateAvailable = workerMessage(
  'UPDATE_AVAILABLE',
  z.object({
    attemptId: z.uuid(),
    version: ReleaseVersion,
    channel: ReleaseChannel,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(1),
    /** Absolute paths on the master origin (never another host). */
    manifestUrl: z.string().regex(/^\/v1\/worker\/releases\/\d[0-9A-Za-z.-]{0,63}\/manifest$/),
    artifactUrl: z.string().regex(/^\/v1\/worker\/releases\/\d[0-9A-Za-z.-]{0,63}\/artifact$/),
    downloadToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    tokenExpiresAt: Timestamp,
    /** Explicit administrator rollback: the only case in which a lower version is acceptable. */
    rollback: z.boolean(),
    /** Activate even while jobs run (they are cancelled by the restart); otherwise drain first. */
    force: z.boolean(),
  }),
);

/**
 * p17-update-channel (ADR-0065; additive in 1.0, control message, only to `version-catalog-v1` workers): the newest
 * version catalog the master accepted, as exact bytes + the catalog-key signature. The worker verifies it with its own
 * catalog keys and the acceptance rules (protocol `checkVersionCatalog`) and answers VERSION_CATALOG_STATUS. Re-sent
 * when the worker's CAPABILITIES report an older sequence.
 */
export const ApplyVersionCatalog = workerMessage('APPLY_VERSION_CATALOG', ApplyVersionCatalogPayload);

/**
 * Panel-managed worker configuration (ADR-0015; additive in protocol 1.0). Control message (seq 0): the master
 * owns the desired generation in Postgres and re-sends it whenever the worker reports another one (every
 * session's CAPABILITIES carries the applied generation), so nothing is queued in the durable outbox. Sent only
 * to workers that advertise the `worker-config-v1` feature; older workers never see it.
 *
 * The worker re-validates everything (schema, consistency rules, hash, signature against its lease keys) and
 * intersects the document with its local ceiling before anything takes effect, then answers with
 * WORKER_CONFIG_STATUS. Credentials never travel in this document: APPLY_CREDENTIAL below carries them, sealed
 * to the worker's own key.
 */
export const ApplyWorkerConfig = workerMessage('APPLY_WORKER_CONFIG', WorkerConfigDelivery);

/**
 * p5-credentials-models (ADR-0016; additive in 1.0, control message, only to workers advertising
 * `credential-vault-v1`): one vault credential version sealed end-to-end to the worker's X25519 vault key by
 * the administrator's browser. The master relays ciphertext only and signs the delivery with a lease key; the
 * worker verifies, opens, stores the value as `vault-<id>` and answers CREDENTIAL_STATUS. Re-sent whenever the
 * worker's CAPABILITIES report does not show the desired version.
 */
export const ApplyCredential = workerMessage('APPLY_CREDENTIAL', ApplyCredentialPayload);

/** Deletes a vault credential (every version ≤ `version`) on the worker; answered with CREDENTIAL_STATUS. */
export const RevokeCredential = workerMessage('REVOKE_CREDENTIAL', RevokeCredentialPayload);

/** Asks the worker to generate a new vault key and announce it (already stored values stay). */
export const RotateVaultKey = workerMessage('ROTATE_VAULT_KEY', RotateVaultKeyPayload);

/**
 * p5-remote-ops (ADR-0017; additive in 1.0, control message, only to workers advertising `remote-ops-v1`): one
 * signed remote operation — install / remove / restart a runtime, login relay, service restart, logs,
 * diagnostics. Never re-sent: the panel shows the outcome from OPS_UPDATE and the operator retries.
 */
export const OpsCommand = workerMessage('OPS_COMMAND', OpsCommandPayload);

/**
 * p5-ops-chat (ADR-0018; additive in 1.0, control messages, only to workers advertising `assistant-v1`): one
 * signed assistant turn, the answer to one of its tool calls, and the cancellation of a turn.
 */
export const AssistantTurn = workerMessage('ASSISTANT_TURN', AssistantTurnPayload);
export const AssistantToolResult = workerMessage('ASSISTANT_TOOL_RESULT', AssistantToolResultPayload);
export const AssistantCancel = workerMessage('ASSISTANT_CANCEL', AssistantCancelPayload);
/** p17-chat-reconnect (control, only to `assistant-resume-v1` workers): continue a turn after a reconnect. */
export const AssistantResume = workerMessage('ASSISTANT_RESUME', AssistantResumePayload);
/**
 * p8-chat-attachments-mentions (control, only to `assistant-input-v1` workers): one slice of an attachment of a
 * running turn, answering ASSISTANT_ATTACHMENT_REQUEST.
 */
export const AssistantAttachmentData = workerMessage(
  'ASSISTANT_ATTACHMENT_DATA',
  AssistantAttachmentDataPayload,
);

/**
 * p5-ops-chat (additive in 1.0, sequenced, only to workers advertising `job-message-v1`): a human message to the
 * running agent of a job (fenced by attempt and epoch like APPROVAL_DECISION).
 */
export const JobMessage = jobMessage('JOB_MESSAGE', JobMessagePayload);

/**
 * p5-machine-admin (ADR-0021; control, job-scoped, only to `machine-admin-v1` workers): the master's answer to a
 * MACHINE_ADMIN_REQUEST — granted (with the signed grant), pending (an approval was opened) or denied.
 */
export const MachineAdminDecision = jobMessage('MACHINE_ADMIN_DECISION', MachineAdminDecisionPayload);

/**
 * p6-approval-mode-switch (additive in 1.0, sequenced, only to workers advertising `approval-mode-switch-v1`): the
 * running job's new approval mode, signed with a lease key and fenced by attempt and epoch.
 */
export const SetApprovalPolicy = jobMessage('SET_APPROVAL_POLICY', SetApprovalPolicyPayload);

/**
 * p15-autonomy (additive in 1.0, sequenced, only to workers advertising `time-limit-v1`): the running attempt's new
 * time limit, signed with a lease key and fenced by attempt and epoch.
 */
export const SetTimeLimit = jobMessage('SET_TIME_LIMIT', SetTimeLimitPayload);

/**
 * p8-orchestration (ADR-0031; control, job-scoped, only to `subtasks-v1` workers): the master's answer to one
 * SUBTASK_REQUEST (created / state / result of a sub-job, or why it was refused).
 */
export const SubtaskStatus = jobMessage('SUBTASK_STATUS', SubtaskStatusPayload);
/** p14-ask-user (control, job-scoped, only to `ask-user-v1` workers): the answer to one QUESTION_REQUEST. */
export const QuestionStatus = jobMessage('QUESTION_STATUS', QuestionStatusPayload);
/**
 * p8-preview-tunnels (ADR-0032; control, never in the durable outbox): the answer to a PREVIEW_REQUEST (job message),
 * and the start / stop of one preview connector (worker messages, signed with a lease key). TUNNEL_START carries
 * the connector token of exactly that tunnel — the only Cloudflare credential a worker ever receives.
 */
export const PreviewResult = jobMessage('PREVIEW_RESULT', PreviewResultPayload);
export const TunnelStart = workerMessage('TUNNEL_START', TunnelStartPayload);
export const TunnelStop = workerMessage('TUNNEL_STOP', TunnelStopPayload);
/**
 * p15-services (control, never in the durable outbox; only to `services-v1` workers): start / update, stop / restart /
 * remove a service the worker owns (signed with a lease key), the connector of its named tunnel (the connector token
 * of that one tunnel, ADR-0032 addendum), a request for its last log lines, and the answer to a job's SERVICE_REQUEST.
 */
export const ServiceStart = workerMessage('SERVICE_START', ServiceStartPayload);
export const ServiceControl = workerMessage('SERVICE_CONTROL', ServiceControlPayload);
export const ServiceTunnel = workerMessage('SERVICE_TUNNEL', ServiceTunnelPayload);
export const ServiceLogsRequest = workerMessage('SERVICE_LOGS_REQUEST', ServiceLogsRequestPayload);
export const ServiceResult = jobMessage('SERVICE_RESULT', ServiceResultPayload);
/**
 * p19-ide W2 (ADR-0066; control, never in the durable outbox; only to `ide-v1` workers): start / stop / remove an IDE
 * workspace (signed with a lease key), its git status / push through the daemon (signed; the push token travels only
 * here), a file for a chat reference and the answer to a bridge request.
 */
export const IdeStart = workerMessage('IDE_START', IdeStartPayload);
export const IdeControl = workerMessage('IDE_CONTROL', IdeControlPayload);
export const IdeGit = workerMessage('IDE_GIT', IdeGitPayload);
export const IdeFileRequest = workerMessage('IDE_FILE_REQUEST', IdeFileRequestPayload);
export const IdeNotice = workerMessage('IDE_NOTICE', IdeNoticePayload);
/** p15-workspace-retention (control, only to `workfiles-v1` workers): read / remove / extend a kept directory. */
export const WorkfilesRequest = workerMessage('WORKFILES_REQUEST', WorkfilesRequestPayload);
/** p15-workspace-retention (control, job message): the relayed answer to a seeding attempt's WORKFILES_FETCH. */
export const WorkfilesFetchData = jobMessage('WORKFILES_FETCH_DATA', WorkfilesDataPayload);
/** p16-zip-job-input (control, job message): the answer to an INPUT_BUNDLE_REQUEST. */
export const InputBundleData = jobMessage('INPUT_BUNDLE_DATA', InputBundleDataPayload);
/** p17-object-storage (control, job messages): the answers to BLOB_UPLOAD_REQUEST / BLOB_UPLOAD_COMPLETE. */
export const BlobUploadGrant = jobMessage('BLOB_UPLOAD_GRANT', BlobUploadGrantPayload);
export const BlobUploadStatus = jobMessage('BLOB_UPLOAD_STATUS', BlobUploadStatusPayload);

export const ErrorCode = z.enum([
  'upgrade_required',
  'unauthenticated',
  'revoked',
  'invalid_message',
  'stale_epoch',
  'rate_limited',
  'internal',
  /** Pairing code missing/malformed/expired, or the pairing request was refused (p2-pairing). */
  'pairing_invalid',
  /** An admin denied this device's enrollment; the key will never be accepted (p2-pairing). */
  'enrollment_denied',
  /** This key was replaced by a rotation; the worker must use its new key (p2-identity-rotation). */
  'credential_superseded',
  /** The connection-bound session expired without a fresh AUTH (ADR-0005 §4). */
  'session_expired',
  /** The receiver cannot keep up (send queue / reorder buffer full); reconnect and resume. */
  'overloaded',
  /** ROTATE_KEY was refused (no outstanding request, bad nonce or signature, key in use). */
  'rotation_refused',
]);

export const ProtocolError = anonymousMessage(
  'ERROR',
  z.object({
    code: ErrorCode,
    message: Text,
    retryable: z.boolean(),
    /** Echoes the offending message, if any. */
    inReplyTo: z.uuid().optional(),
  }),
);

export const MasterToWorker = z.discriminatedUnion('type', [
  Challenge,
  SessionEstablished,
  EnrollPending,
  EnrollApproved,
  Ack,
  AssignJob,
  RenewLease,
  CancelJob,
  PauseJob,
  ApprovalDecision,
  JobCredential,
  JobInputData,
  SkillFileData,
  Drain,
  RotateCredential,
  CredentialRotated,
  UpdatePolicy,
  UpdateAvailable,
  ApplyVersionCatalog,
  ApplyWorkerConfig,
  ApplyCredential,
  RevokeCredential,
  RotateVaultKey,
  OpsCommand,
  AssistantTurn,
  AssistantToolResult,
  AssistantCancel,
  AssistantResume,
  AssistantAttachmentData,
  JobMessage,
  MachineAdminDecision,
  SetApprovalPolicy,
  SetTimeLimit,
  SubtaskStatus,
  QuestionStatus,
  PreviewResult,
  TunnelStart,
  TunnelStop,
  ServiceStart,
  ServiceControl,
  ServiceTunnel,
  ServiceLogsRequest,
  ServiceResult,
  WorkfilesRequest,
  WorkfilesFetchData,
  InputBundleData,
  BlobUploadGrant,
  BlobUploadStatus,
  IdeStart,
  IdeControl,
  IdeGit,
  IdeFileRequest,
  IdeNotice,
  StreamOpen,
  StreamWindow,
  StreamClose,
  ProtocolError,
]);
export type MasterToWorker = z.infer<typeof MasterToWorker>;
