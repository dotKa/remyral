import type {
  AssignedVerifiedCapabilities,
  ContinuityPolicy,
  ApprovalWait,
  AssignedResume,
  AssignedMachineAdmin,
  AssignedSkills,
  AssignedMcp,
  AssignedPreviews,
  AssignedSubtasks,
  GitIdentityValue,
  JobSpec,
  UsageLimitPark,
  AssignedAccount,
  AssignedRepoEgress,
  AssignedGitAuth,
  AssignedKeepFiles,
  AssignedSeedFiles,
  AssignedInputBundle,
  AssignedBlobUpload,
  AssignedOutputLimits,
} from '@remyral/protocol';
import type { LeaseRecord } from '../jobs/store.js';
import type { MasterPayload } from '../workers/types.js';
import type { LeaseSigner } from './lease-signer.js';

/** Builds the signed `lease` object of ASSIGN_JOB / RENEW_LEASE from a lease row (ADR-0004 §1). */
export function signedLease(
  signer: LeaseSigner,
  lease: LeaseRecord,
  issuedAt: Date,
  vaultScope?: readonly string[],
): MasterPayload<'RENEW_LEASE'>['lease'] {
  const grace = lease.offlineGraceMs ?? 0;
  return {
    epoch: lease.epoch,
    expiresAt: lease.expiresAt.toISOString(),
    // p11-master-resilience (ADR-0039): only leases granted to offline-grace-v1 workers carry it.
    ...(grace > 0 ? { offlineGraceMs: grace } : {}),
    token: signer.sign({
      jobId: lease.jobId,
      attemptId: lease.attemptId,
      workerId: lease.workerId,
      epoch: lease.epoch,
      issuedAt,
      expiresAt: lease.expiresAt,
    }),
    // Job secret references: only ASSIGN_JOB carries the vault scope (the environment is planned at assignment).
    ...(vaultScope === undefined
      ? {}
      : {
          vaultScope: signer.signVaultScope({
            jobId: lease.jobId,
            attemptId: lease.attemptId,
            workerId: lease.workerId,
            epoch: lease.epoch,
            vault: vaultScope,
          }),
        }),
  };
}

/** `ackId` (p11-master-resilience): the LEASE_ACK `messageId` this renewal answers (absent for a reconciliation resume). */
export function renewPayload(
  signer: LeaseSigner,
  lease: LeaseRecord,
  now: Date,
  ackId?: string,
): MasterPayload<'RENEW_LEASE'> {
  return {
    attemptId: lease.attemptId,
    lease: signedLease(signer, lease, now),
    ...(ackId === undefined ? {} : { ackId }),
  };
}

export interface AssignInput {
  readonly lease: LeaseRecord;
  readonly project: string;
  readonly spec: JobSpec;
  readonly context?: { readonly bundleHash: string; readonly rendered: string } | undefined;
  /** p6-skills: the job's pinned, signed skills (verified again by the worker). */
  readonly skills?: AssignedSkills | undefined;
  /** p14-skill-import: the project accepts only offline-signed skills (sent only with skills). */
  readonly skillTrust?: 'offline-only' | undefined;
  /** p14-mcp-core: the job's pinned, signed external MCP servers (only to mcp-v1 workers; verified by the worker). */
  readonly mcp?: AssignedMcp | undefined;
  /** Project opted in to host-native sandbox profiles (ADR-0007). */
  readonly hostExecutionOptIn?: boolean;
  /** ADR-0019: the project allows the unconfined profile (sent only for unconfined jobs). */
  readonly unconfinedOptIn?: boolean;
  /** ADR-0020: the project allows auto-approve (sent only with allow-all jobs, to full-access-v1 workers). */
  readonly autoApproveOptIn?: boolean;
  /** p4-git-flow: the job's project integrates through git flow; the worker pushes its attempt branch. */
  readonly pushResult?: boolean;
  /** p5-machine-admin (ADR-0021): session grant, machine memory and auto-approve of a machine-admin job. */
  readonly machineAdmin?: AssignedMachineAdmin | undefined;
  /** p5-git-identity: the commit identity the project resolves to (repository jobs only). */
  readonly gitIdentity?: GitIdentityValue | undefined;
  /** p6-warm-caches (ADR-0029): the project allows the machines' shared package caches (sent only when true). */
  readonly packageCaches?: boolean;
  /** p8-orchestration (ADR-0031): the job's agent may request sub-jobs (only to subtasks-v1 workers). */
  readonly subtasks?: AssignedSubtasks | undefined;
  /** p8-preview-tunnels (ADR-0032): preview tools, declared port and auto-open (only to preview-tunnels-v1 workers). */
  readonly previews?: AssignedPreviews | undefined;
  /** p9-subjob-local-login-deadlock: the root job of the job's sub-job tree (its own id for a root job). */
  readonly family?: string | undefined;
  /** p10-approval-pause: the master manages long approval waits (only to approval-pause-v1 workers). */
  readonly approvalWait?: ApprovalWait | undefined;
  /** p10-approval-pause: continue the paused attempt (same attempt id, new epoch) on the worker that paused it. */
  readonly resume?: AssignedResume | undefined;
  /** p11-usage-limit-fallback: park on a usage limit (only to usage-limit-park-v1 workers). */
  readonly usageLimitPark?: UsageLimitPark | undefined;
  /** p11-session-continuity (ADR-0042): checkpoint policy (only for `session-continuity-v1` workers). */
  readonly continuity?: ContinuityPolicy;
  /** p13-runtime-accounts: the runtime account the attempt runs with (only to `runtime-accounts-v1` workers). */
  readonly account?: AssignedAccount | undefined;
  /** p14-repo-egress: the repository project's effective egress policy (only to `repo-egress-v1` workers). */
  readonly repoEgress?: AssignedRepoEgress | undefined;
  /**
   * p15-git-central: the project's repository credential (a vault reference, never a value; only to `git-central-v1`
   * workers). The payload is persisted in the outbox, which is why it may only ever hold the reference.
   */
  readonly gitAuth?: AssignedGitAuth | undefined;
  /** p15-workspace-retention: keep the scratch dir after the end / start from kept files (`workfiles-v1` workers). */
  readonly keepFiles?: AssignedKeepFiles | undefined;
  readonly seedFiles?: AssignedSeedFiles | undefined;
  /** p16-zip-job-input: the job's input bundle (`input-bundle-v1` workers; placement guarantees it). */
  readonly inputBundle?: AssignedInputBundle | undefined;
  /** p17-object-storage: large outputs through the blob store (`blob-upload-v1` workers, workspace jobs). */
  readonly blobUpload?: AssignedBlobUpload | undefined;
  /** p17-output-limits: the job's output file limit and the zip fallback (`output-limits-v1` workers). */
  readonly outputLimits?: AssignedOutputLimits | undefined;
  /** p17-runtime-verify: capabilities proved for the worker's exact tuple (`runtime-capability-verify-v1` workers). */
  readonly verifiedCapabilities?: AssignedVerifiedCapabilities | undefined;
  /**
   * Job secret references: the vault credential ids the attempt may receive through `spec.secretRefs` (signed into
   * `lease.vaultScope`; older workers ignore it). Absent: no scope is sent.
   */
  readonly vaultScope?: readonly string[] | undefined;
  /** Job secret references the master left out of this assignment (variable names; reported in the job's timeline). */
  readonly secretRefsWithheld?: readonly string[] | undefined;
}

/**
 * ASSIGN_JOB payload. `projectId` always comes from the job record (the authoritative project), never
 * from the stored spec. No credential is ever part of it: the payload is persisted in `worker_outbox`
 * until acknowledged, so git tokens travel only in the non-durable JOB_CREDENTIAL control message.
 */
export function assignPayload(
  signer: LeaseSigner,
  input: AssignInput,
  now: Date,
): MasterPayload<'ASSIGN_JOB'> {
  return {
    attemptId: input.lease.attemptId,
    lease: signedLease(signer, input.lease, now, input.vaultScope),
    spec: { ...input.spec, projectId: input.project },
    ...(input.context === undefined ? {} : { context: { ...input.context } }),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
    ...(input.mcp === undefined ? {} : { mcp: input.mcp }),
    ...(input.machineAdmin === undefined ? {} : { machineAdmin: input.machineAdmin }),
    ...(input.gitIdentity === undefined
      ? {}
      : { gitIdentity: { name: input.gitIdentity.name, email: input.gitIdentity.email } }),
    execution: {
      hostExecutionOptIn: input.hostExecutionOptIn === true,
      ...(input.pushResult === true ? { pushResult: true } : {}),
      ...(input.unconfinedOptIn === true ? { unconfinedOptIn: true } : {}),
      ...(input.autoApproveOptIn === true ? { autoApproveOptIn: true } : {}),
      ...(input.packageCaches === true ? { packageCaches: true } : {}),
      ...(input.skillTrust === 'offline-only' && input.skills !== undefined
        ? { skillTrust: 'offline-only' as const }
        : {}),
      ...(input.subtasks === undefined ? {} : { subtasks: input.subtasks }),
      ...(input.previews === undefined ? {} : { previews: input.previews }),
      ...(input.family === undefined ? {} : { family: { rootJobId: input.family } }),
      ...(input.approvalWait === undefined ? {} : { approvalWait: { ...input.approvalWait } }),
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      ...(input.usageLimitPark === undefined ? {} : { usageLimitPark: { ...input.usageLimitPark } }),
      ...(input.continuity === undefined ? {} : { continuity: { ...input.continuity } }),
      ...(input.account === undefined ? {} : { account: { id: input.account.id, kind: input.account.kind } }),
      ...(input.repoEgress === undefined
        ? {}
        : { repoEgress: { mode: input.repoEgress.mode, hosts: [...input.repoEgress.hosts] } }),
      ...(input.gitAuth === undefined ? {} : { gitAuth: { ...input.gitAuth } }),
      ...(input.keepFiles === undefined ? {} : { keepFiles: { ...input.keepFiles } }),
      ...(input.seedFiles === undefined ? {} : { seedFiles: { ...input.seedFiles } }),
      ...(input.inputBundle === undefined ? {} : { inputBundle: { ...input.inputBundle } }),
      ...(input.blobUpload === undefined ? {} : { blobUpload: { ...input.blobUpload } }),
      ...(input.outputLimits === undefined ? {} : { outputLimits: { ...input.outputLimits } }),
      ...(input.secretRefsWithheld === undefined || input.secretRefsWithheld.length === 0
        ? {}
        : { secretRefsWithheld: [...input.secretRefsWithheld] }),
      ...(input.verifiedCapabilities === undefined
        ? {}
        : {
            verifiedCapabilities: {
              ...input.verifiedCapabilities,
              capabilities: [...input.verifiedCapabilities.capabilities],
            },
          }),
    },
  };
}
