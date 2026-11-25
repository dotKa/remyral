/**
 * Runtime validation (Zod) for the Codex app-server messages the adapter
 * consumes. The *types* come from `./generated` (generated from the pinned
 * codex-cli 0.162.1); every schema below validates only the fields the
 * adapter reads, and a compile-time `Conforms<>` check proves that the real
 * generated type satisfies the schema input — a field renamed or retyped in
 * a new Codex version breaks the build after regeneration.
 *
 * Unknown fields are allowed (the binary sends fields that the
 * non-experimental generated types omit, e.g. `emittedAtMs`, `environments`).
 */
import { z } from 'zod';
import type { ApplyPatchApprovalParams } from './generated/ApplyPatchApprovalParams.js';
import type { ExecCommandApprovalParams } from './generated/ExecCommandApprovalParams.js';
import type { InitializeResponse } from './generated/InitializeResponse.js';
import type { CommandExecutionRequestApprovalParams } from './generated/v2/CommandExecutionRequestApprovalParams.js';
import type { ErrorNotification } from './generated/v2/ErrorNotification.js';
import type { FileChangeRequestApprovalParams } from './generated/v2/FileChangeRequestApprovalParams.js';
import type { GetAccountResponse } from './generated/v2/GetAccountResponse.js';
import type { GetAccountRateLimitsResponse } from './generated/v2/GetAccountRateLimitsResponse.js';
import type { AccountRateLimitsUpdatedNotification } from './generated/v2/AccountRateLimitsUpdatedNotification.js';
import type { ItemCompletedNotification } from './generated/v2/ItemCompletedNotification.js';
import type { ItemStartedNotification } from './generated/v2/ItemStartedNotification.js';
import type { PermissionsRequestApprovalParams } from './generated/v2/PermissionsRequestApprovalParams.js';
import type { ThreadItem } from './generated/v2/ThreadItem.js';
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse.js';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse.js';
import type { ThreadTokenUsageUpdatedNotification } from './generated/v2/ThreadTokenUsageUpdatedNotification.js';
import type { TurnCompletedNotification } from './generated/v2/TurnCompletedNotification.js';
import type { TurnDiffUpdatedNotification } from './generated/v2/TurnDiffUpdatedNotification.js';
import type { TurnStartedNotification } from './generated/v2/TurnStartedNotification.js';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse.js';
import type { TurnInterruptResponse } from './generated/v2/TurnInterruptResponse.js';
import type { TurnSteerResponse } from './generated/v2/TurnSteerResponse.js';

/** `true` iff every value of the generated type `Real` is accepted by schema `S`. */
type Conforms<Real, S extends z.ZodType> = [Real] extends [z.input<S>] ? true : never;

const RequestId = z.union([z.string(), z.number()]);

/**
 * Every line from the app-server. Framing verified on the pinned binary
 * (2026-10-13): JSON-RPC 2.0 shapes **without** the `"jsonrpc"` member.
 */
export const InboundMessage = z.looseObject({
  id: RequestId.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

// ---------------------------------------------------------------- responses

export const InitializeResult = z.looseObject({
  codexHome: z.string(),
  platformOs: z.string(),
});
export const _initConforms: Conforms<InitializeResponse, typeof InitializeResult> = true;

export const AccountResult = z.looseObject({
  account: z.looseObject({ type: z.string() }).nullable(),
  requiresOpenaiAuth: z.boolean(),
});
export const _accountConforms: Conforms<GetAccountResponse, typeof AccountResult> = true;

// p11-limit-visibility: the plan's usage windows (`account/rateLimits/read`, `account/rateLimits/updated`).
const RateLimitWindowLite = z.looseObject({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullable(),
  resetsAt: z.number().nullable(),
});
const RateLimitSnapshotLite = z.looseObject({
  limitId: z.string().nullable(),
  limitName: z.string().nullable(),
  primary: RateLimitWindowLite.nullable(),
  secondary: RateLimitWindowLite.nullable(),
  individualLimit: z.looseObject({ remainingPercent: z.number(), resetsAt: z.number() }).nullable(),
  spendControlReached: z.boolean().nullable(),
  planType: z.string().nullable(),
  rateLimitReachedType: z.string().nullable(),
});
export const RateLimitsResult = z.looseObject({
  rateLimits: RateLimitSnapshotLite,
  rateLimitsByLimitId: z.record(z.string(), RateLimitSnapshotLite.optional()).nullable(),
});
export const _rateLimitsConforms: Conforms<GetAccountRateLimitsResponse, typeof RateLimitsResult> = true;
/** Sparse during turns: nullable metadata does not clear an earlier value (merged by the worker). */
export const RateLimitsUpdatedParams = z.looseObject({ rateLimits: RateLimitSnapshotLite });
export const _rateLimitsUpdatedConforms: Conforms<
  AccountRateLimitsUpdatedNotification,
  typeof RateLimitsUpdatedParams
> = true;

const SandboxPolicyLite = z.looseObject({ type: z.string() });

export const ThreadStartedResult = z.looseObject({
  thread: z.looseObject({ id: z.string() }),
  model: z.string(),
  modelProvider: z.string(),
  approvalPolicy: z.unknown(),
  approvalsReviewer: z.string(),
  sandbox: SandboxPolicyLite,
  instructionSources: z.array(z.string()),
});
export const _threadStartConforms: Conforms<ThreadStartResponse, typeof ThreadStartedResult> = true;
export const _threadResumeConforms: Conforms<ThreadResumeResponse, typeof ThreadStartedResult> = true;

export const TurnStartResult = z.looseObject({ turn: z.looseObject({ id: z.string() }) });
export const _turnStartConforms: Conforms<TurnStartResponse, typeof TurnStartResult> = true;

export const TurnSteerResult = z.looseObject({ turnId: z.string() });
export const _turnSteerConforms: Conforms<TurnSteerResponse, typeof TurnSteerResult> = true;

/** `turn/interrupt` answers an empty object. */
export const TurnInterruptResult = z.looseObject({});
export const _interruptConforms: Conforms<TurnInterruptResponse, typeof TurnInterruptResult> = true;

// ---------------------------------------------------------------- notifications

const TurnStatus = z.enum(['completed', 'interrupted', 'failed', 'inProgress']);
const TurnErrorLite = z.looseObject({ message: z.string(), codexErrorInfo: z.unknown() });

export const TurnStartedParams = z.looseObject({
  threadId: z.string(),
  turn: z.looseObject({ id: z.string(), status: TurnStatus }),
});
export const _turnStartedConforms: Conforms<TurnStartedNotification, typeof TurnStartedParams> = true;

export const TurnCompletedParams = z.looseObject({
  threadId: z.string(),
  turn: z.looseObject({
    id: z.string(),
    status: TurnStatus,
    error: TurnErrorLite.nullable(),
    durationMs: z.number().nullable(),
  }),
});
export const _turnCompletedConforms: Conforms<TurnCompletedNotification, typeof TurnCompletedParams> = true;

/** Envelope of any thread item; the per-type fields are parsed by `ThreadItemLite`. */
const ItemEnvelope = z.looseObject({ type: z.string(), id: z.string().optional() });
export const _itemConforms: Conforms<ThreadItem, typeof ItemEnvelope> = true;

export const ItemNotificationParams = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  item: ItemEnvelope,
});
export const _itemStartedConforms: Conforms<ItemStartedNotification, typeof ItemNotificationParams> = true;
export const _itemCompletedConforms: Conforms<ItemCompletedNotification, typeof ItemNotificationParams> =
  true;

const ItemStatus = z.enum(['inProgress', 'completed', 'failed', 'declined']);

/** The thread item kinds the adapter maps (others are ignored). */
export const ThreadItemLite = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('agentMessage'), id: z.string(), text: z.string() }),
  z.looseObject({
    type: z.literal('commandExecution'),
    id: z.string(),
    command: z.string(),
    status: ItemStatus,
    exitCode: z.number().nullable(),
    aggregatedOutput: z.string().nullable(),
  }),
  z.looseObject({
    type: z.literal('fileChange'),
    id: z.string(),
    changes: z.array(z.looseObject({ path: z.string() })),
    status: ItemStatus,
  }),
  z.looseObject({
    type: z.literal('mcpToolCall'),
    id: z.string(),
    server: z.string(),
    tool: z.string(),
    status: z.string(),
    arguments: z.unknown(),
    error: z.unknown().nullable(),
  }),
  z.looseObject({
    type: z.literal('dynamicToolCall'),
    id: z.string(),
    tool: z.string(),
    arguments: z.unknown(),
    success: z.boolean().nullable(),
    contentItems: z
      .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
      .nullable()
      .optional(),
  }),
  // p8-codex-images: a built-in image generation call (`result` = base64 image, `savedPath` = where the CLI saved it).
  // p17-pin-bump: since codex-cli 0.164.0 a completed item carries either `fileId` (the image went to Codex's
  // attachment store) or the inline base64 `result` (upload fallback); `savedPath` is still set in both cases.
  z.looseObject({
    type: z.literal('imageGeneration'),
    id: z.string(),
    status: z.string(),
    result: z.string().optional(),
    fileId: z.string().optional(),
    savedPath: z.string().optional(),
  }),
]);
export type ThreadItemLite = z.infer<typeof ThreadItemLite>;
type ItemOf<T extends ThreadItem['type']> = Extract<ThreadItem, { type: T }>;
type LiteOf<T extends ThreadItemLite['type']> = Extract<z.input<typeof ThreadItemLite>, { type: T }>;
export const _itemKindsConform: [
  [ItemOf<'agentMessage'>] extends [LiteOf<'agentMessage'>] ? true : never,
  [ItemOf<'commandExecution'>] extends [LiteOf<'commandExecution'>] ? true : never,
  [ItemOf<'fileChange'>] extends [LiteOf<'fileChange'>] ? true : never,
  [ItemOf<'mcpToolCall'>] extends [LiteOf<'mcpToolCall'>] ? true : never,
  [ItemOf<'dynamicToolCall'>] extends [LiteOf<'dynamicToolCall'>] ? true : never,
  [ItemOf<'imageGeneration'>] extends [LiteOf<'imageGeneration'>] ? true : never,
] = [true, true, true, true, true, true];

const Breakdown = z.looseObject({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteInputTokens: z.number(),
  outputTokens: z.number(),
});
export const TokenUsageParams = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  tokenUsage: z.looseObject({ total: Breakdown, last: Breakdown }),
});
export const _tokenUsageConforms: Conforms<ThreadTokenUsageUpdatedNotification, typeof TokenUsageParams> =
  true;

export const TurnDiffParams = z.looseObject({ threadId: z.string(), turnId: z.string(), diff: z.string() });
export const _diffConforms: Conforms<TurnDiffUpdatedNotification, typeof TurnDiffParams> = true;

export const ErrorParams = z.looseObject({
  error: TurnErrorLite,
  willRetry: z.boolean(),
  threadId: z.string(),
  turnId: z.string(),
});
export const _errorConforms: Conforms<ErrorNotification, typeof ErrorParams> = true;

// ---------------------------------------------------------------- server → client requests

export const CommandApprovalParams = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  approvalId: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
});
export const _cmdApprovalConforms: Conforms<
  CommandExecutionRequestApprovalParams,
  typeof CommandApprovalParams
> = true;

export const FileChangeApprovalParams = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  reason: z.string().nullable().optional(),
  grantRoot: z.string().nullable().optional(),
});
export const _fileApprovalConforms: Conforms<
  FileChangeRequestApprovalParams,
  typeof FileChangeApprovalParams
> = true;

export const PermissionsApprovalParams = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  reason: z.string().nullable(),
  permissions: z.looseObject({ network: z.unknown(), fileSystem: z.unknown() }),
});
export const _permApprovalConforms: Conforms<
  PermissionsRequestApprovalParams,
  typeof PermissionsApprovalParams
> = true;

export const LegacyExecApprovalParams = z.looseObject({
  conversationId: z.string(),
  callId: z.string(),
  command: z.array(z.string()),
  cwd: z.string(),
  reason: z.string().nullable(),
});
export const _legacyExecConforms: Conforms<ExecCommandApprovalParams, typeof LegacyExecApprovalParams> = true;

export const LegacyPatchApprovalParams = z.looseObject({
  conversationId: z.string(),
  callId: z.string(),
  fileChanges: z.record(z.string(), z.unknown()),
  reason: z.string().nullable(),
});
export const _legacyPatchConforms: Conforms<ApplyPatchApprovalParams, typeof LegacyPatchApprovalParams> =
  true;
