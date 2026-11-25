import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AttemptId, Epoch, RuntimeKind, Sha256Hex } from './common.js';
import { InputName, InputRef, MAX_INPUT_BYTES, MAX_INPUTS_TOTAL_BYTES } from './workspace.js';

/**
 * p8-orchestration (ADR-0031, docs/design/p8-orchestration.md): agent-requested sub-jobs and the capability tags that
 * planned workflow tasks and sub-jobs may ask for. Shared by the master (validation, placement), the worker (tool
 * host) and the adapters (tool definitions).
 *
 * Wire (additive in 1.0, control messages, job-scoped, only from / to `subtasks-v1` workers):
 *  - worker → master `SUBTASK_REQUEST {attemptId, epoch, requestId, op}` — op `create | status | cancel`;
 *  - master → worker `SUBTASK_STATUS {attemptId, epoch, requestId, state, …}` — the answer to exactly that request.
 * Every request is fenced to the parent job's live lease; creation is idempotent per (parent job, requestId).
 */

export const SUBTASKS_FEATURE = 'subtasks-v1';

/** Hard limits (the master enforces them; the worker's tool host mirrors the input limits to fail early). */
export const SUBTASK_LIMITS = {
  /** A sub-job's sub-job is the deepest level (root depth 0). */
  maxDepth: 2,
  /** Sub-jobs one job may create in total. */
  maxChildren: 8,
  /** Sub-jobs one job may have open (not terminal) at a time. */
  maxOpenChildren: 4,
  /** Sub-jobs of a whole family (the root job and every descendant). */
  maxFamily: 16,
  /** Inline input files per request and their total raw size (the 512 KiB control frame). */
  maxInputs: 8,
  maxInputBytes: 256 * 1024,
  /**
   * p22-previews-inputs: inputs above {@link maxInputBytes} are staged as chunked artifacts of the requesting attempt
   * (`subtask-staged-inputs-v1`): at most this much per request (the child's input limit), each file at most
   * {@link maxStagedFileBytes}, and at most {@link maxStagedBytesPerAttempt} staged by one attempt in total.
   */
  maxStagedInputBytes: MAX_INPUTS_TOTAL_BYTES,
  maxStagedFileBytes: MAX_INPUT_BYTES,
  maxStagedBytesPerAttempt: 32 * 1024 * 1024,
  maxTitleChars: 200,
  maxPromptChars: 32 * 1024,
  /** Capability tags per request / planned task. */
  maxRequires: 8,
  /** File-ownership entries (`paths`) per request. */
  maxPaths: 32,
  /** Longest a single tool call waits for a sub-job before it returns "still running". */
  maxWaitSec: 600,
  defaultWaitSec: 540,
  /** Result summary handed to the parent. */
  maxSummaryChars: 8 * 1024,
  /** A child's duration ends this long before the parent's deadline at the latest. */
  deadlineMarginSec: 60,
  /** Below this a child is not worth starting (`budget_exhausted`). */
  minDurationSec: 120,
} as const;

/**
 * Capability tags (`requires`): what a planned task or a sub-job needs. Tool tags are placed against the machines'
 * tool reports (`requirements.tools`, CAPABILITIES.tools / toolInventory — `browser` is satisfied by any reported
 * browser, `container` by Docker or Podman); `image-generation` restricts the runtime to those that can generate
 * images (Codex's built-in `image_generation` tool, verified on the pinned 0.162.1).
 */
export const CAPABILITY_TAGS = {
  'image-generation': { runtimes: ['codex'] },
  browser: { tools: ['browser'] },
  ffmpeg: { tools: ['ffmpeg'] },
  python: { tools: ['python'] },
  git: { tools: ['git'] },
  docker: { tools: ['docker'] },
  container: { tools: ['container'] },
  node: { tools: ['node'] },
} as const satisfies Readonly<
  Record<string, { readonly tools?: readonly string[]; readonly runtimes?: readonly RuntimeKind[] }>
>;
export type CapabilityTag = keyof typeof CAPABILITY_TAGS;
export const CAPABILITY_TAG_NAMES = Object.keys(CAPABILITY_TAGS) as CapabilityTag[];

export const CapabilityTagName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'capability tag');

/** What a list of tags means for placement; `unknown` lists tags this release does not know. */
export interface ResolvedCapabilities {
  readonly tools: string[];
  /** Runtimes that satisfy every tag (null: any runtime). */
  readonly runtimes: RuntimeKind[] | null;
  readonly unknown: string[];
}

export function resolveCapabilities(tags: readonly string[]): ResolvedCapabilities {
  const tools = new Set<string>();
  let runtimes: RuntimeKind[] | null = null;
  const unknown: string[] = [];
  for (const tag of tags) {
    if (!Object.hasOwn(CAPABILITY_TAGS, tag)) {
      unknown.push(tag);
      continue;
    }
    const spec: { readonly tools?: readonly string[]; readonly runtimes?: readonly RuntimeKind[] } =
      CAPABILITY_TAGS[tag as CapabilityTag];
    for (const t of spec.tools ?? []) tools.add(t);
    if (spec.runtimes !== undefined) {
      const allowed = spec.runtimes;
      runtimes = runtimes === null ? [...allowed] : runtimes.filter((r) => allowed.includes(r));
    }
  }
  return { tools: [...tools].sort(), runtimes, unknown };
}

// ------------------------------------------------------------------------------------------- messages

const LeaseRef = { attemptId: AttemptId, epoch: Epoch };

/** A sub-job id as the agent sees it (the child job's UUID). */
export const SubtaskId = z.uuid();

export const SubtaskInlineInput = z.object({
  name: InputName,
  contentBase64: z
    .string()
    .max(Math.ceil((SUBTASK_LIMITS.maxInputBytes * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64'),
});
export type SubtaskInlineInput = z.infer<typeof SubtaskInlineInput>;

/**
 * p11-merge-pipeline: one entry of a sub-job's file ownership (`paths`) — a relative POSIX path, directory prefix
 * (trailing `/`) or glob (`*`, `**`) of what the sub-job is expected to change. The platform merges every sub-job
 * branch into one integration branch, so sibling sub-jobs should own disjoint paths. Advisory (not enforced on the
 * runtime); refused: absolute paths, backslashes, `..` segments, empty segments (except one trailing `/`), whitespace and
 * anything outside `[A-Za-z0-9._/*@+-]`.
 */
export const SubtaskPath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/*@+-]+$/, 'path characters')
  .refine((p) => !p.startsWith('/'), 'must be relative')
  .refine((p) => {
    const parts = (p.endsWith('/') ? p.slice(0, -1) : p).split('/');
    return parts.every((seg) => seg !== '' && seg !== '..');
  }, 'no empty or ".." segment');
export type SubtaskPath = z.infer<typeof SubtaskPath>;

/** p22-previews-inputs: artifact ids of staged sub-job inputs (`ws-subin-<24 hex>`). */
export const SUBTASK_INPUT_ARTIFACT_PREFIX = 'ws-subin-';
export const SubtaskInputArtifactId = z.string().regex(/^ws-subin-[0-9a-f]{24}$/, 'staged input artifact id');

/**
 * The artifact id of a staged input: derived from its name and content hash, so the same file staged again (a retried
 * request, a second sub-job) is the same artifact (its commit is idempotent).
 */
export function subtaskInputArtifactId(name: string, sha256: string): string {
  const h = createHash('sha256').update(`${name}\0${sha256}`, 'utf8').digest('hex');
  return `${SUBTASK_INPUT_ARTIFACT_PREFIX}${h.slice(0, 24)}`;
}

/**
 * p22-previews-inputs: one input file the worker staged as an artifact of the requesting attempt before it sent the
 * request. The master copies the committed artifact (same attempt, size and SHA-256) into the sub-job's inputs.
 */
export const SubtaskStagedInput = z.object({
  name: InputName,
  artifactId: SubtaskInputArtifactId,
  sizeBytes: z.number().int().min(0).max(SUBTASK_LIMITS.maxStagedFileBytes),
  sha256: Sha256Hex,
});
export type SubtaskStagedInput = z.infer<typeof SubtaskStagedInput>;

/**
 * `SUBTASK_STATUS.reason` with `state: "refused"` for a create whose staged inputs are not committed yet (the
 * sequenced ARTIFACT_REF has not been applied): the worker retries the same request id shortly.
 */
export const SUBTASK_INPUTS_PENDING = 'inputs_pending';

export const SubtaskCreateOp = z.object({
  kind: z.literal('create'),
  title: z.string().min(1).max(SUBTASK_LIMITS.maxTitleChars),
  prompt: z.string().min(1).max(SUBTASK_LIMITS.maxPromptChars),
  runtime: RuntimeKind.optional(),
  requires: z.array(CapabilityTagName).max(SUBTASK_LIMITS.maxRequires).optional(),
  inputs: z.array(SubtaskInlineInput).max(SUBTASK_LIMITS.maxInputs).optional(),
  /**
   * p22-previews-inputs (additive; `subtask-staged-inputs-v1` workers, only when the assignment says
   * `stagedInputs`): input files staged as artifacts of the requesting attempt instead of inline. A request carries
   * either `inputs` or `stagedInputs`, never both.
   */
  stagedInputs: z.array(SubtaskStagedInput).max(SUBTASK_LIMITS.maxInputs).optional(),
  /** p11-merge-pipeline: files / directories the sub-job owns (additive; advisory, see {@link SubtaskPath}). */
  paths: z.array(SubtaskPath).max(SUBTASK_LIMITS.maxPaths).optional(),
  wait: z.boolean(),
});
export type SubtaskCreateOp = z.infer<typeof SubtaskCreateOp>;

export const SubtaskRequestOp = z.discriminatedUnion('kind', [
  SubtaskCreateOp,
  z.object({ kind: z.literal('status'), subtaskId: SubtaskId }),
  z.object({ kind: z.literal('cancel'), subtaskId: SubtaskId }),
]);
export type SubtaskRequestOp = z.infer<typeof SubtaskRequestOp>;

/** `SUBTASK_REQUEST` payload (worker → master, control, job-scoped). */
export const SubtaskRequestPayload = z.object({
  ...LeaseRef,
  requestId: z.uuid(),
  op: SubtaskRequestOp,
});
export type SubtaskRequestPayload = z.infer<typeof SubtaskRequestPayload>;

export const SUBTASK_STATES = ['refused', 'queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const SubtaskState = z.enum(SUBTASK_STATES);
export type SubtaskState = z.infer<typeof SubtaskState>;

/**
 * ASSIGN_JOB `execution.family` (p9-subjob-local-login-deadlock): the root job of the job's sub-job tree (its own id
 * for a root job). Members of one family share data by design (prompts, inputs, delivered results).
 */
export const JobFamily = z.object({ rootJobId: z.uuid() });
export type JobFamily = z.infer<typeof JobFamily>;

/**
 * `SUBTASK_STATUS.reason` with `state: "queued"` (p9-subjob-local-login-deadlock): the sub-job can only run on the
 * machine where the requesting job runs, and there it waits for the requesting job itself — waiting for it would
 * deadlock. The tool host stops waiting and tells the agent (do the work itself, or cancel the sub-job).
 */
export const SUBTASK_BLOCKED_BY_PARENT = 'blocked_by_parent';

/** `SUBTASK_STATUS` payload (master → worker, control, job-scoped): the answer to one SUBTASK_REQUEST. */
export const SubtaskStatusPayload = z.object({
  ...LeaseRef,
  requestId: z.uuid(),
  state: SubtaskState,
  subtaskId: SubtaskId.optional(),
  /**
   * `refused`: a stable code (`not_enabled`, `depth_limit`, `runtime_not_allowed`, `stale_lease`, …); `queued`:
   * {@link SUBTASK_BLOCKED_BY_PARENT} when waiting for it would deadlock.
   */
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  /** Plain language for the agent (no secrets, bounded). */
  detail: z.string().max(1000).optional(),
  title: z.string().max(SUBTASK_LIMITS.maxTitleChars).optional(),
  runtime: RuntimeKind.optional(),
  /** Where it runs / ran (display name), when placed. */
  worker: z.string().max(200).optional(),
  /** `succeeded` / `failed`: the child's result summary (redacted on the master, bounded). */
  summary: z.string().max(SUBTASK_LIMITS.maxSummaryChars).optional(),
  /** `succeeded` (workspace projects): the child's files, now inputs of the parent job (fetch with JOB_INPUT_REQUEST). */
  files: z.array(InputRef).max(10).optional(),
  /** Child files that were not handed over and why (`name: reason`). */
  dropped: z.array(z.string().max(300)).max(30).optional(),
});
export type SubtaskStatusPayload = z.infer<typeof SubtaskStatusPayload>;

/** ASSIGN_JOB `execution.subtasks` (only to `subtasks-v1` workers): the job's agent may request sub-jobs. */
export const AssignedSubtasks = z.object({
  /** Runtimes a sub-job may name (the job's own first). */
  runtimes: z.array(RuntimeKind).min(1).max(4),
  /** How many more levels below this job are allowed (≥ 1). */
  depthLeft: z.number().int().min(1).max(SUBTASK_LIMITS.maxDepth),
  /**
   * p22-previews-inputs (additive; only to `subtask-staged-inputs-v1` workers): the master accepts staged inputs
   * (`op.stagedInputs`) above the inline limit. Absent: inline inputs only (≤ 256 KiB per request).
   */
  stagedInputs: z.boolean().optional(),
});
export type AssignedSubtasks = z.infer<typeof AssignedSubtasks>;

/** The stricter of two approval policies (sub-jobs never loosen their parent's): deny > ask-all > ask-sensitive > allow-all. */
const APPROVAL_STRICTNESS: Readonly<Record<string, number>> = {
  'deny-sensitive': 3,
  'ask-all': 2,
  'ask-sensitive': 1,
  'allow-all': 0,
};
export function stricterApprovalPolicy<P extends string>(a: P, b: P): P {
  return (APPROVAL_STRICTNESS[a] ?? 3) >= (APPROVAL_STRICTNESS[b] ?? 3) ? a : b;
}
