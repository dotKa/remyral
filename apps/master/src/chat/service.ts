import { randomUUID } from 'node:crypto';
import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import {
  ASSISTANT_PLAN_FEATURE,
  ASSISTANT_FEATURE,
  ASSISTANT_TOOLS,
  assistantToolInput,
  ASSISTANT_PROPOSE_FEATURE,
  ASSISTANT_BUDGETS_FEATURE,
  ASSISTANT_CAPACITY_FEATURE,
  ASSISTANT_REPO_INPUTS_FEATURE,
  ASSISTANT_PROJECT_SETUP_FEATURE,
  ASSISTANT_CODE_FEATURE,
  AssistantCodeCard,
  ASSISTANT_IMAGES_FEATURE,
  AssistantImageCard,
  ASSISTANT_OPS_TOOLS_FEATURE,
  ASSISTANT_PROJECTS_FEATURE,
  RUNTIME_ACCOUNTS_FEATURE,
  ASSISTANT_INPUT_FEATURE,
  ASSISTANT_RESUME_FEATURE,
  type AssistantAttachmentRef,
  type AssistantAttachmentRequestPayload,
  AssistantEngineInput,
  AssistantReport,
  AssistantRuntime,
  ATTACHMENT_CHUNK_BYTES,
  MAX_ASSISTANT_CONTEXT,
  MAX_FRAME_BYTES,
  type AssistantToolResultPayload,
  type AssistantTurnPayload,
  type AssistantUpdatePayload,
  type AssistantUsage,
  answersText,
  fenceData,
  MAX_ASSISTANT_HISTORY,
  MAX_TOOL_RESULT,
  type ChatArchiveNote,
  isValidTimeZone,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import {
  type ChatSiteUploadFacts,
  type ChatSiteUploads,
  metaArchives,
  metaSiteUploads,
  siteZipBlocks,
  siteZipNotes,
} from './site-uploads.js';
import {
  type ChatInputUploadFacts,
  type ChatInputUploads,
  inputBundleBlocks,
  inputBundleNotes,
  metaInputUploads,
} from './input-uploads.js';
import type { AuditRecorder } from '../audit/audit.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import type { Role } from '../auth/users.js';
import { loadSubject } from '../authz/authorizer.js';
import { roleAtLeast, type Subject } from '../authz/model.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { completeDelivery, type DeliveryRef, fenceDelivery, noteDeliveryMessage } from './deliveries.js';
import { HttpError } from '../http/errors.js';
import {
  cancelQueued,
  editQueued,
  hasQueued,
  holdQueued,
  insertQueued,
  listQueued,
  lockQueued,
  markDelivered,
  type QueuedMessageView,
  readyThreads,
} from './queue.js';
import type { ActorContext } from '../workers/fleet.js';
import type { WorkerSession } from '../workers/types.js';
import { type AttachmentView, attachmentMeta, ChatAttachments } from './attachments.js';
import type { ChatBusMessage, ChatReplicaBus } from './bus.js';
import {
  type ChatMentions,
  type MentionChip,
  type MentionDrop,
  type MentionRef,
  MentionRefs,
} from './mentions.js';
import { mentionedProjects, type ChatKnowledge, type RelatedResult } from '../search/chat-knowledge.js';
import { type ThreadProjects, threadProjectIds, workingProjectsBlock } from './thread-projects.js';
import {
  ASSISTANT_RUNTIME_LABELS,
  type ChatSettings,
  type ChatSettingsStore,
  engineReadiness,
} from './settings.js';
import {
  type ChatStore,
  type DraftRecord,
  draftView,
  type DraftView,
  type MessageView,
  type OpenTurnRow,
  payloadHash,
  type TurnEffects,
  type TurnOrigin,
} from './store.js';
import { modelIdIssue } from '@remyral/protocol/runtime-models';
import { type DraftEdit, editedFields, jobDraftInput } from './draft-edit.js';
import type { ChatEventName, ChatStreams } from './streams.js';
import { type ChatTools, type ToolOutcome, toolSummary } from './tools.js';
import { type ChatCredentials, type CredentialChip, scrubUserText } from './credentials.js';
import {
  type ChatDirectActions,
  directDecision,
  type DirectOutcome,
  directToolData,
  planRunsDrafts,
  type TurnHuman,
} from './direct.js';
import { initialTaint, markTurnTainted, resultTaints, type UntrustedAllows } from './untrusted.js';
import { machinePolicyCard } from './drafts.js';
import type { QuestionService, QuestionView } from '../questions/service.js';
import { pickAutoFallbackAccount } from './auto-account.js';
import type { RuntimeAccountService } from '../runtime-accounts/service.js';
import { loadDefaultPolicy } from '../usage-limits/policy.js';
import { AUTO_FALLBACK_ACCOUNT } from './settings.js';
import { composeMessage } from '../workflows/ai.js';
import { planModeRefusal } from './plan-model.js';
import { ChatPlanService } from './plans.js';
import { normalizeChatTitle, renameRequested, titleAsk, titleBlock, titleWorthy } from './title.js';
import { consentHolds, guessLanguage, nextStepConsent } from './watches.js';
import type { ChatTurnObserver } from '../telemetry/instrument.js';
import {
  type ChatFailoverStore,
  chooseRoute,
  FAILOVER_STABLE_MS,
  type FailoverState,
  type MachineIssue,
  type RouteCandidate,
  type RouteReason,
} from './failover.js';

/**
 * The ops chat orchestration on the master (p5-ops-chat, ADR-0018, docs/design/p5-ops-chat.md §2–§4):
 * turns go to the assistant worker as signed ASSISTANT_TURNs, ASSISTANT_UPDATEs come back (deltas, tool
 * calls, the answer), tool calls are executed here with the authorization of the user who sent the turn
 * (reloaded per call, so a revoked membership takes effect at once), and everything is persisted per thread
 * and streamed to the thread's open views. The master never holds a model credential and never calls a model.
 *
 * Several master replicas (p5-ops-chat-next, `bus.ts`): the replica holding the assistant worker's connection
 * ("owner") runs the turn — it sends ASSISTANT_TURN, receives every update and serves the tool calls. Another
 * replica that receives the user's message stores it and the turn row as usual and asks the owner, by id, to
 * send it; Stop and the kill switch are forwarded the same way; every stream event is fanned out, and replicas
 * mirror the running turns they hear about so a view opened anywhere gets the text so far. With no peer
 * replica nothing is routed and the service behaves as a single process.
 */

export interface AssistantSigner {
  signAssistantTurn(input: { workerId: string; turn: Omit<AssistantTurnPayload, 'signature'> }): {
    kid: string;
    signature: string;
  };
}

export type ChatUnavailable =
  | 'disabled'
  | 'not_configured'
  | 'worker_offline'
  | 'worker_update_required'
  | 'disabled_on_worker'
  | 'engine_not_ready'
  // p11-usage-limit-fallback: the engine is at its usage limit and no fallback engine can take over.
  | 'engine_limited';

export interface ChatStatus {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly code: ChatUnavailable | null;
  readonly message: string | null;
  readonly worker: { readonly id: string; readonly name: string; readonly online: boolean } | null;
  /** The engine turns go to now (the fallback engine while the main one is at its usage limit). */
  readonly runtime: string;
  readonly model: string | null;
  /** p11-usage-limit-fallback: turns go to the fallback engine because the main engine is at its usage limit. */
  readonly fallback: boolean;
  /**
   * p13-runtime-accounts: the runtime account turns go to now (null: the machine's configured login / key; also on
   * machines without accounts). The fallback account while the main one is at its usage limit.
   */
  readonly account: string | null;
  /** p11-usage-limit-fallback: the main engine's usage limit, while it lasts. */
  readonly limit: {
    readonly runtime: string;
    readonly until: string;
    readonly resetAt: string | null;
  } | null;
  readonly limits: { readonly turnsPerUserPer10Min: number; readonly userDailyTokens: number | null };
  /**
   * p8-chat-attachments-mentions: what the configured engine on the assistant worker takes besides text
   * (`unsupported` + reason when the worker is too old or the engine cannot read images).
   */
  readonly input: ChatInputSupport;
  /** p15-chat-failover: the configured primary assistant machine (null: none configured). */
  readonly primary: { readonly id: string; readonly name: string; readonly online: boolean } | null;
  /**
   * p15-chat-failover: which machine of the chain answers and why (null: not configured / chat off). `worker` is that
   * machine (the primary while none can answer).
   */
  readonly routing: ChatRouting | null;
  /**
   * p16-chat-complete: the assistant engines the answering machine reports ready (regenerate with another engine).
   * Empty while nobody can answer.
   */
  readonly engines: AssistantRuntime[];
  /**
   * p18-plan-mode: the answering machine has the plan tools (`assistant-plan-v1`): plan mode can be turned on and plan
   * continuation turns are sent. False while nobody answers or on an older worker ("Asistan makinesi güncellenmeli").
   */
  readonly plan: boolean;
}

/** p15-chat-failover: the routing summary of the status (docs/design/p15-chat-failover.md §8). */
export interface ChatRouting {
  readonly machine: 'primary' | 'backup' | null;
  readonly reason: RouteReason | null;
  /** 0 = primary, 1.. = backups in order (null: none answers). */
  readonly position: number | null;
  readonly pinned: boolean;
  /** Automatic failover is on. */
  readonly auto: boolean;
  /** Why the primary cannot answer now (null: it can). */
  readonly primaryIssue: { readonly code: MachineIssue; readonly message: string } | null;
  /** `primary_unstable`: when the primary takes the turns back (if it stays connected). */
  readonly returnsAt: string | null;
  /** Number of backup machines configured (and still approved). */
  readonly backups: number;
  readonly pin: { readonly workerId: string; readonly name: string; readonly until: string } | null;
}

/** p15-chat-failover: the workers row a machine of the chain is evaluated from. */
interface WorkerRow {
  readonly id: string;
  readonly display_name: string;
  readonly features: unknown;
  readonly assistant: unknown;
  readonly connected_at: Date | null;
  readonly worker_version: string | null;
}

/** p15-chat-failover: how a machine would answer (engine, model, account; `fallback`: a usage-limit fallback). */
interface MachinePlan {
  readonly runtime: AssistantRuntime;
  readonly model: string | null;
  readonly account: string | null;
  readonly fallback: boolean;
  readonly limit: ChatStatus['limit'];
}

/** p15-chat-failover: one machine of [primary, ...backups] with its verdict. */
export interface MachineEval extends RouteCandidate {
  readonly name: string;
  readonly online: boolean;
  readonly workerVersion: string | null;
  readonly features: unknown;
  readonly assistant: unknown;
  readonly issueMessage: string | null;
  readonly plan: MachinePlan | null;
  /** The main engine's usage limit on this machine (when known). */
  readonly limitView: ChatStatus['limit'];
}

interface Route {
  readonly settings: ChatSettings;
  readonly state: FailoverState;
  readonly chain: readonly MachineEval[];
  readonly chosen: MachineEval | null;
  readonly reason: RouteReason | null;
  readonly status: ChatStatus;
}

const ISSUE_CODE: Readonly<Record<MachineIssue, ChatUnavailable>> = {
  offline: 'worker_offline',
  update_required: 'worker_update_required',
  disabled_on_worker: 'disabled_on_worker',
  engine_not_ready: 'engine_not_ready',
  engine_limited: 'engine_limited',
  not_found: 'not_configured',
};

/** p15-chat-failover: `GET /chat/failover` (design §7). */
export interface FailoverView {
  readonly status: ChatStatus;
  readonly auto: boolean;
  readonly stableSeconds: number;
  readonly pin: ChatRouting['pin'];
  readonly active: { workerId: string; name: string; reason: string | null; since: string } | null;
  readonly chain: {
    workerId: string;
    name: string;
    role: 'primary' | 'backup';
    position: number;
    online: boolean;
    connectedAt: string | null;
    workerVersion: string | null;
    eligible: boolean;
    issue: MachineIssue | null;
    message: string | null;
    runtime: string | null;
    fallback: boolean;
    account: string | null;
    answering: boolean;
  }[];
  readonly events: {
    id: string;
    kind: string;
    from: { id: string; name: string } | null;
    to: { id: string; name: string } | null;
    reason: string | null;
    actor: string | null;
    at: string;
  }[];
}

/** p15-chat-failover: a thread notice about the machine that answers (design §6). */
interface MachineNotice {
  readonly cause:
    | 'primary_offline'
    | 'primary_unavailable'
    | 'primary_unstable'
    | 'pinned'
    | 'returned'
    | 'rerun'
    // p16-chat-complete: a turn cut by a master restart is answered again.
    | 'restart';
  readonly from: string;
  readonly to: string;
}

/**
 * p15-chat-failover (design §5): turn ends that mean "this machine could not answer" — nothing the model decided — and
 * are re-run once on the next eligible machine when the turn did not act.
 */
const MACHINE_FAILURES: ReadonlySet<string> = new Set([
  'assistant_disconnected',
  'send_failed',
  'timeout',
  'runtime_not_configured',
  'runtime_start_failed',
  'runtime_crashed',
  'refused_disabled',
  'refused_runtime_unavailable',
]);

export interface ChatInputSupport {
  readonly images: 'supported' | 'model-dependent' | 'unsupported';
  readonly pdf: boolean;
  readonly mentions: boolean;
  readonly reason: string | null;
}

const NO_INPUT: ChatInputSupport = {
  images: 'unsupported',
  pdf: false,
  mentions: false,
  reason: 'The assistant is unavailable.',
};

interface ActiveTurn {
  readonly id: string;
  readonly threadId: string;
  readonly userId: string;
  readonly workerId: string;
  /** The worker connection the turn was sent over (a replaced connection ends its turns). */
  connectionId: string | null;
  text: string;
  lastSeq: number;
  toolCalls: number;
  /** p8-chat-attachments-mentions: attachments the worker may fetch for this turn. */
  readonly attachmentIds: ReadonlySet<string>;
  state: 'sent' | 'running';
  readonly startedAt: number;
  lastUpdateAt: number;
  /** p11-usage-limit-fallback: the engine the turn runs on and the user message it answers (for a re-send). */
  readonly runtime?: AssistantRuntime | undefined;
  readonly messageId?: string | undefined;
  /** p13-runtime-accounts: the runtime account the turn runs with (null / absent: the configured one). */
  readonly account?: string | null | undefined;
  /** p15-autonomy: the sender's step-up and client (direct actions); absent on a turn dispatched by another replica. */
  readonly human?: TurnHuman | undefined;
  /**
   * p15-chat-execute-default: the turn answers a message a person wrote (chat composer, question card answer, workflow
   * editor panel) — only such turns run drafts by default. False for system-written messages (automatic repair).
   */
  readonly byUser: boolean;
  /** p15-chat-execute-default: whether the assistant worker knows `propose` (looked up on the first draft). */
  proposeAware?: boolean;
  /** p18-assistant-gaps: whether the assistant worker has the ops tools (`assistant-ops-tools-v1`; looked up once). */
  opsTools?: boolean;
  /** p18-leftovers: whether the assistant worker has `assistant-budgets-v1` (looked up once). */
  budgetTools?: boolean;
  /** p19-linux-host-isolation: whether the assistant worker has `assistant-capacity-v1` (looked up once). */
  capacityRule?: boolean;
  /** p18-project-bootstrap: whether the assistant worker has `assistant-project-setup-v1` (looked up once). */
  projectSetup?: boolean;
  /** p19-ide W4: whether the assistant worker has `assistant-code-v1` (looked up once). */
  codeTools?: boolean;
  /** p20-chat-images: whether the assistant worker has `assistant-images-v1` (looked up once). */
  imageTools?: boolean;
  /**
   * p18-multi-project W3: whether the assistant worker knows the working projects (`assistant-projects-v1`; the write
   * rules apply only then) and the conversation's working projects (looked up on the first tool call).
   */
  projectsAware?: boolean;
  projects?: readonly string[] | undefined;
  /** p16-workflow-quality: the user message's time zone (null: none / unknown; looked up on the first tool call). */
  timeZone?: string | null;
  /**
   * p15-chat-failover: tool calls received in this turn that are not `read` (a card, a direct action, a note): a turn
   * that may have acted is never re-run on another machine (design §5).
   */
  actions: number;
  /** p15-chat-failover: the lost turn this message was already re-run for (once per message). */
  readonly rerunOf?: string | undefined;
  /** p16-chat-complete: why the turn was started (regenerate / retry / edit / restart re-run). */
  readonly origin?: TurnOrigin | undefined;
  /** p16-chat-complete: the model the turn asked for (labels a regenerated answer). */
  readonly model?: string | null | undefined;
  /**
   * p17-chat-reconnect: the worker process the turn was sent to (HELLO.instanceId; null / absent: unknown, an older
   * worker). Only the same process may continue the turn after its connection dropped.
   */
  instanceId?: string | null | undefined;
  /** p17-chat-reconnect: the connection dropped; the turn waits until `until` for the same process to come back. */
  grace?: { readonly until: number; readonly timer: NodeJS.Timeout } | undefined;
  /** p17-chat-reconnect: the latest tool results of the turn (re-sent after a resume; answered calls are ignored). */
  results?: Map<string, AssistantToolResultPayload> | undefined;
  /**
   * p18-plan-mode: the turn runs in plan mode (decided when it started): only read tools, ask_user, the plan tools and
   * set_chat_title run; everything else is refused (`plan_mode_read_only`).
   */
  readonly planMode?: boolean | undefined;
  /** p18-plan-mode: plan_propose / plan_create already answered in this turn (once each per turn). */
  planOnce?: Set<string> | undefined;
  /**
   * oss-sec3: what made this turn untrusted (tool / input names; empty: clean) — loaded once from the stored turn and
   * message (untrusted.ts initialTaint), grown by every untrusted tool result of the turn.
   */
  taint?: Set<string> | undefined;
  /**
   * p18-plan-autonomy: the plan this system-written continuation turn carries on (its message's `meta.plan.id`) — an
   * autonomous, executing plan runs the turn's drafts at once (`trigger: plan`).
   */
  readonly planTurn?: string | undefined;
  /** p19-watch-follow-up: the watch this system-written turn carries on after (`meta.origin = 'watch'`). */
  readonly followUp?: string | undefined;
  /**
   * p22-slow-tools: this system-written turn hands back a tool result that came after its turn had moved on
   * (`meta.origin = 'tool_result'`); the person's consent it carries (null: none — its drafts stay cards).
   */
  readonly lateResult?: { readonly consentAt: Date | null } | undefined;
  /** p22-slow-tools: calls answered "still running" whose real result is handed back later. */
  late?: Set<string> | undefined;
}

/** p22-slow-tools: when a running tool call is answered "still running" (the worker gives up at 60 s). */
export const SLOW_TOOL_MS = 45_000;
/** p22-slow-tools: how long a late result waits for the conversation to be free before it is only kept. */
const LATE_RESULT_WAIT_MS = 30 * 60_000;

/** p22-slow-tools: what the model reads when a call outlives the tool time. */
export function stillRunningText(tool: string): string {
  return (
    `${tool} is STILL RUNNING on the platform — it takes longer than a tool call may wait. It was not lost and has not ` +
    'failed: do NOT call it again and do not redo it another way, and do not judge its effect yet (a repository, a ' +
    'deployment or files may look unchanged until it ends). Its result is posted in this conversation when it ends and ' +
    'handed to you in a turn of its own, where you carry on. Now only continue with what does not depend on it, or end ' +
    'this turn telling the user briefly that it is still running.'
  );
}

/** p22-slow-tools: the system-written message that hands a late result back (an instruction to the assistant). */
export function lateResultText(lang: 'tr' | 'en', tool: string, content: string): string {
  return lang === 'tr'
    ? `Geç gelen sonuç: ${tool} sürerken "hala çalışıyor" demiştim; şimdi bitti. Sonucu aşağıda. Kullanıcının bu ` +
        'konuşmada istediği işe buradan kendiliğinden devam et; aynı çağrıyı tekrar yapma. Kısa yaz.\n\n' +
        content
    : `Late result: ${tool} was still running when it was answered "still running"; it has ended now. Its result is ` +
        'below. Carry on with the work the user asked for in this conversation from here by yourself; do not make the ' +
        'same call again. Be brief.\n\n' +
        content;
}

/** p17-chat-reconnect: how long a turn waits for its worker process to reconnect before it is lost (default). */
export const RECONNECT_GRACE_MS = 45_000;
/** p17-chat-reconnect: tool results kept per turn for a resume (a model waits on its latest calls only). */
const KEPT_TOOL_RESULTS = 8;

/** p11-usage-limit-fallback: an engine's known usage limit on the assistant machine. */
interface EngineLimit {
  readonly runtime: AssistantRuntime;
  /** p13-runtime-accounts: the runtime account at its limit (`default` = the configured one). */
  readonly account: string;
  readonly until: Date;
  readonly resetAt: Date | null;
}

/** Without a reported reset the engine is skipped this long before it is tried again. */
const ENGINE_LIMIT_DEFAULT_MS = 15 * 60_000;
const ENGINE_LIMIT_MAX_MS = 7 * 24 * 3600_000;

export interface ChatServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  /**
   * p16-ops-safety: the owner's chat message rate per person and the model cost brake — throws 429 when a new turn
   * must not start (checked before anything else of a message, an edit or a regeneration).
   */
  readonly turnGuard?: () => { chatTurn(userId: string): Promise<void> } | null;
  readonly signer: AssistantSigner;
  readonly limiter: RateLimiter;
  readonly settings: ChatSettingsStore;
  readonly store: ChatStore;
  readonly tools: ChatTools;
  readonly streams: ChatStreams;
  readonly session: (workerId: string) => WorkerSession | undefined;
  /** p5-ops-chat-next: coordination with other master replicas (absent: single process). */
  readonly bus?: ChatReplicaBus;
  /** How long a dispatch to the owning replica waits for its acknowledgement (default 5 s). */
  readonly dispatchAckMs?: number;
  /**
   * p15-chat-failover: the shared failover state (pin, automatic failover, the answering machine, switches). Absent: the
   * chain is still routed (first eligible machine), nothing is recorded.
   */
  readonly failover?: ChatFailoverStore;
  /** p15-chat-failover: how long a returning machine must stay connected before it takes the turns back (60 s). */
  readonly failoverStableMs?: number;
  /** A turn without any update for this long is failed (default 6 min; the worker's own bound is 5). */
  readonly turnTimeoutMs?: number;
  /**
   * p22-slow-tools: a tool call still running after this long is answered "still running" (under the worker's 60 s tool
   * timeout) and its real result is handed back in a turn of its own (default {@link SLOW_TOOL_MS}).
   */
  readonly slowToolMs?: number;
  /**
   * p17-chat-reconnect: how long a turn waits after its worker connection dropped for the same worker process to
   * reconnect and continue it (default {@link RECONNECT_GRACE_MS}; 0: fail at once as before).
   */
  readonly reconnectGraceMs?: number;
  /**
   * p16-chat-complete: the restart recovery (design §2) — how long after start orphans may still be re-run (default
   * 5 min), the oldest turn that is re-run (default 30 min) and the most re-runs per start (default 20).
   */
  readonly restartRecovery?: {
    readonly windowMs?: number;
    readonly maxAgeMs?: number;
    readonly maxReruns?: number;
    /** Nothing is recovered this soon after start (peer replicas announce themselves; default 15 s). */
    readonly graceMs?: number;
  };
  /** p8-chat-attachments-mentions: attachments and mention resolution (absent: text only). */
  readonly attachments?: ChatAttachments;
  readonly mentions?: ChatMentions;
  /** p15-chat-zip: site uploads a message carries (absent: such messages are refused). */
  readonly siteUploads?: ChatSiteUploads;
  /** p16-zip-job-input: job input bundles a message carries (absent: such messages are refused). */
  readonly inputUploads?: ChatInputUploads;
  /**
   * p10-semantic-defaults-chat: the related-knowledge lookup on every user turn (absent: none). Its fenced block joins
   * the turn's context (the same field mentions use — no new worker contract); the items are kept on the user message
   * (`meta.related`) for the "used N related items" disclosure.
   */
  readonly knowledge?: ChatKnowledge;
  /** p18-multi-project W3: the conversation's working projects (absent: none — the old single project only). */
  readonly threadProjects?: () => ThreadProjects | null;
  /**
   * p11-memory-layers: the sender's active personal rules (Profile → Personal rules), sent as a fenced block with every
   * turn of their own conversations (absent: none).
   */
  readonly personalRules?: (userId: string) => Promise<readonly { title: string; statement: string }[]>;
  /**
   * p14-ask-user: the assistant's question cards (absent: `ask_user` answers "unavailable"; answering is 404). A normal
   * message closes an open card (`superseded`); an answer starts the next turn.
   */
  readonly questions?: () => QuestionService | null;
  /** p15-autonomy: direct actions (`execute: true` on a draft tool); absent: every draft stays a card. */
  readonly direct?: () => ChatDirectActions | null;
  /** oss-sec3: the person's remembered confirmations for drafts held because a turn read untrusted content. */
  readonly untrustedAllows?: () => UntrustedAllows | null;
  /**
   * p15-message-delivery item 2: the machine's runtime accounts for the "Otomatik" fallback account (absent: Otomatik
   * finds no account and the fallback engine is next).
   */
  readonly accounts?: () => Pick<RuntimeAccountService, 'facts' | 'defaults'> | null;
  /**
   * p15-workflow-ai: the workflow editor's assistant (absent: none) — an instruction prefix and fenced blocks for turns
   * of a workflow-AI message or of a thread linked to a workflow, and one automatic repair turn after an invalid draft.
   */
  readonly workflowAi?: () => ChatWorkflowHooks | null;
  /**
   * p15-chat-vault: vault credentials by reference — `{{credential:NAME}}` chips and blocks, the result of a
   * run_http_request that ran at once (absent: tokens stay text, requests answer with their job id only).
   */
  readonly credentials?: () => ChatCredentials | null;
  /**
   * p16-observability: turn telemetry (a `chat.turn` span whose trace context rides on ASSISTANT_TURN, turn counters);
   * absent: none.
   */
  readonly observe?: ChatTurnObserver;
  /**
   * p18-plan-mode: plan mode, the plan block of every turn of a conversation with a plan, the plan tools' read-only
   * matrix, decisions, draft ↔ item links and continuation turns (absent: no plans).
   */
  readonly plans?: () => ChatPlanService | null;
}

/** p15-workflow-ai: what the chat asks the workflow-AI service (docs/design/p15-workflow-ai.md §2). */
export interface ChatWorkflowHooks {
  /** `messageId`: the user message of the turn (its stored meta is read by the hook, document included). */
  turnInput(
    userId: string,
    threadId: string,
    messageId: string,
  ): Promise<{ readonly instruction: string; readonly blocks: readonly string[] } | null>;
  afterTurn(t: {
    turnId: string;
    threadId: string;
    userId: string;
    messageId: string | undefined;
  }): Promise<boolean>;
}

export interface SendOptions {
  readonly attachments?: readonly string[];
  readonly mentions?: readonly MentionRef[];
  /** p15-chat-zip: ready site uploads of the sender (a .zip the console unpacked and uploaded) this message carries. */
  readonly siteUploads?: readonly string[];
  /** p15-chat-zip: .zip files the console read that are not a publishable site (nothing uploaded; a note only). */
  readonly archives?: readonly ChatArchiveNote[];
  /** p16-zip-job-input: ready job input bundles of the sender (a .zip the console unpacked and uploaded for a job). */
  readonly inputUploads?: readonly string[];
  /** p14-ask-user: this message is the answer to the question set with this id (kept as `meta.answerTo`). */
  readonly answerTo?: string;
  /**
   * p16-workflow-quality: the sender's IANA time zone (kept as `meta.timeZone` when the runtime knows it): the default
   * zone of the schedules the assistant drafts in this turn.
   */
  readonly timeZone?: string;
  /**
   * p15-autonomy: the sender's session step-up at the time of the message, for direct actions in this turn (each
   * judged by its card's event). Absent: direct actions that need a code become cards.
   */
  readonly stepUp?: {
    readonly mfaAt: Date | null;
    readonly stepUpMaxAgeMs?: number | undefined;
    readonly alwaysFreshMaxAgeMs?: number | undefined;
  };
  /** p15-workflow-ai: the editor panel's mode, workflow, document … (kept as `meta.workflowAi`). */
  readonly workflowAi?: Record<string, unknown>;
  /**
   * p17-chat-flow: "Sohbette düzenle" — the open, valid `draft_workflow` card of this conversation the message changes
   * (checked here: the sender's own, still proposed). The turn gets the card's document and the edit instruction; the
   * assistant's new card replaces it.
   */
  readonly editDraft?: string;
  /**
   * p15-chat-execute-default: a person wrote this message (kept as `meta.origin = 'user'`): its turn may run drafts at
   * once. Absent: a system-written message — its drafts stay cards.
   */
  readonly byUser?: boolean;
  /**
   * p16-chat-complete: this message is the edited text of user message `messageId` (seq `fromSeq`): the model history
   * ends before it, the current rows from it on are superseded by the new message in the same transaction, and its
   * attachments move to the new message.
   */
  readonly edit?: { readonly messageId: string; readonly fromSeq: number };
  /** p18-plan-mode: `mode: 'plan'` (`/plan …`, the Planla chip): plan mode is turned on for this message and after. */
  readonly mode?: 'plan';
  /**
   * p18-plan-mode: a system-written continuation turn of an executing plan (`meta.origin = 'plan'`; never `byUser`): its
   * drafts stay cards.
   */
  readonly plan?: { readonly planId: string; readonly next: string | null };
  /**
   * p19-watch-follow-up: a system-written turn that carries on after a watch of the conversation ended without its
   * condition (`meta.origin = 'watch'`; never `byUser`): only its service (re)starts run at once, the rest stay cards.
   */
  readonly followUp?: { readonly watchId: string };
  /**
   * oss-sec3: a system-written message whose text carries words from outside the person (a watch follow-up quoting a
   * log line or a job's attention): its turn counts as having read untrusted content (`meta.untrusted`).
   */
  readonly untrusted?: boolean;
  /**
   * p20-outcome: a system-written turn the person asked for from an intervention card ("Devam ettir") or that resumes
   * a goal (`meta.origin = 'goal'`; never `byUser`): its drafts stay cards.
   */
  readonly goal?: { readonly goalId: string };
  /**
   * p22-slow-tools: a system-written turn that hands back the result of a tool call that outlived its turn
   * (`meta.origin = 'tool_result'`; never `byUser`); `consentAt`: the person's message behind the call (its drafts run
   * like that message's for GOAL_GRANT_TTL_MS), null: none.
   */
  readonly lateResult?: { readonly tool: string; readonly consentAt: Date | null };
  /**
   * p20-outcome (docs/design/p20-outcome-contract.md, "Delivery outbox"): this turn is the delivery of a claimed
   * continuation — refused (`409 delivery_superseded`) unless the claim is still this sender's; "sent" is written in
   * the transaction that creates the turn.
   */
  readonly delivery?: DeliveryRef;
}

/** p22-chat-queue: what the composer's send did — sent as a turn, or queued behind the running one. */
export type PostResult =
  | { readonly message: MessageView; readonly turnId: string; readonly dropped: MentionDrop[] }
  | { readonly queued: QueuedMessageView; readonly dropped: MentionDrop[] };

/**
 * p22-chat-queue: a conversation's waiting messages are delivered only when no turn ended in this window (a turn that
 * ends and is continued — failover, a restart re-run — gets its successor first; the turn's own end delivers at once).
 */
const QUEUE_QUIET_MS = 10_000;

/** p16-chat-complete: the regenerate / retry request (design §1.2). */
export interface RegenerateOptions {
  readonly messageId?: string | undefined;
  readonly runtime?: AssistantRuntime | undefined;
  readonly model?: string | undefined;
  readonly mode?: 'regenerate' | 'retry' | undefined;
  readonly acknowledgeActions?: boolean | undefined;
  readonly stepUp?: SendOptions['stepUp'];
}

/** p16-chat-complete: an edit, regenerate or retry over turns that acted (409 `turn_acted`, with what they did). */
export function actedError(effects: TurnEffects): HttpError {
  const n = effects.actions;
  return new HttpError(
    409,
    'turn_acted',
    'The answer being replaced already acted: check what it did, then confirm to go on — nothing is repeated without your confirmation.',
    {},
    { effects: { actions: n, tools: effects.tools, cards: effects.cards } },
    { count: n },
  );
}

/** A message's model input besides its text (refs signed with the turn; context fenced). */
interface TurnExtras {
  readonly attachments: AssistantAttachmentRef[];
  readonly context: string | null;
}

const TURN_TTL_MS = 2 * 60_000;
/** p15-chat-vault: how long a tool call waits for a run_http_request response (the worker's tool timeout is 60 s). */
const HTTP_REQUEST_WAIT_MS = 40_000;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_ITEM = 6_000;
const MAX_TURN_TEXT = 256 * 1024;

const REASONS: Readonly<Record<string, string>> = {
  cancelled: 'Stopped.',
  timeout: 'The assistant did not answer in time.',
  assistant_disconnected: 'The assistant worker disconnected while answering.',
  send_failed: 'The assistant worker could not be reached.',
  refused_disabled: 'The assistant is switched off on its worker (local setting).',
  refused_unsigned: 'The assistant worker refused the request: it was not signed by a key it trusts.',
  refused_bad_signature: 'The assistant worker refused the request: the signature did not verify.',
  refused_expired: 'The assistant worker refused the request as expired (check the worker clock).',
  refused_replayed: 'The assistant worker refused a repeated request.',
  refused_busy: 'The assistant is still answering in this conversation.',
  refused_too_many_sessions: 'The assistant is busy with other conversations; try again shortly.',
  refused_runtime_unavailable: 'The assistant runtime is not available on its worker.',
  refused_invalid: 'The assistant worker refused the request.',
  runtime_not_configured: 'The assistant runtime has no login or credential on its worker.',
  runtime_start_failed: 'The assistant runtime could not start.',
  turn_timeout: 'The assistant took too long and was stopped.',
  runtime_crashed: 'The assistant runtime stopped unexpectedly.',
  code_mode_refused:
    'The assistant stopped: the Codex model tried to use code mode, which the assistant does not run.',
  attachment_unavailable: 'The assistant worker could not load the attached files.',
  // p11-usage-limit-fallback: the detail says which engine, when it works again and whether a fallback answers.
  provider_usage_limit: 'Usage limit reached.',
  // p16-chat-complete: the turn was cut by a master restart (or went silent for twice the turn timeout).
  lost: 'The answer was interrupted when the master restarted.',
};

/** The text the model gets for a user message (an attachment-only message still has words). */
export function modelText(text: string, atts: readonly { name: string }[]): string {
  if (text.trim() !== '') return text;
  if (atts.length === 0) return '(The user sent attachments without text.)';
  return `(The user sent ${atts.length === 1 ? 'an attachment' : `${String(atts.length)} attachments`} without text: ${atts
    .map((a) => a.name)
    .join(', ')}.)`;
}

/** p18-plan-autonomy: the plan a stored continuation message carries on (`meta.origin = 'plan'`), else null. */
function planTurnOf(meta: Record<string, unknown> | null | undefined): string | null {
  if (meta?.origin !== 'plan') return null;
  const plan = meta.plan as { id?: unknown } | undefined;
  return typeof plan?.id === 'string' ? plan.id : null;
}

/** p19-watch-follow-up: the watch a system-written follow-up message carries on after (null: not one). */
function followUpOf(meta: Record<string, unknown> | null | undefined): string | null {
  if (meta?.origin !== 'watch') return null;
  const watch = meta.watch as { id?: unknown } | undefined;
  return typeof watch?.id === 'string' ? watch.id : null;
}

/** p22-slow-tools: the consent a hand-back message of a late tool result carries (undefined: not one). */
function lateResultOf(
  meta: Record<string, unknown> | null | undefined,
): { readonly consentAt: Date | null } | undefined {
  if (meta?.origin !== 'tool_result') return undefined;
  const r = meta.lateResult as { consentAt?: unknown } | undefined;
  const at = typeof r?.consentAt === 'string' ? new Date(r.consentAt) : null;
  return { consentAt: at !== null && Number.isFinite(at.getTime()) ? at : null };
}

/** p18-plan-mode: a plan-mode turn's message leads with the plan-mode instruction. */
function planWrap(pin: { readonly instruction: string | null } | null, text: string): string {
  return pin?.instruction == null ? text : ChatPlanService.planMessage(pin.instruction, text);
}

/** p15-chat-zip: the names of a stored message's site uploads and "not a site" .zip notes. */
function zipNamesOf(meta: Record<string, unknown> | null): { name: string }[] {
  return [
    ...metaSiteUploads(meta).map((f) => ({ name: f.label ?? 'site.zip' })),
    ...metaArchives(meta).map((a) => ({ name: a.name })),
  ];
}

/** p22-chat-queue: the names of a stored message's files (`meta.attachments`). */
function metaFileNames(meta: Record<string, unknown> | null): { name: string }[] {
  const list = Array.isArray(meta?.attachments) ? (meta.attachments as unknown[]) : [];
  return list.flatMap((a) =>
    a !== null && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string'
      ? [{ name: (a as { name: string }).name }]
      : [],
  );
}

/**
 * p22-chat-queue: the input of a turn that answers messages written while the assistant was answering — their texts in
 * order, one paragraph each (as Claude Code joins queued messages); `last` alone when it is not a batch.
 */
export function batchText(batch: readonly MessageView[], last: string): string {
  if (batch.length === 0) return last;
  return [
    ...batch.map((m) => modelText(m.content, [...metaFileNames(m.meta), ...zipNamesOf(m.meta)])),
    last,
  ].join('\n\n');
}

/** `[image: a.png] [mentioned project: Alpha]` for the history of a new session (the bytes are not re-sent). */
function inputNotes(meta: Record<string, unknown> | null): string {
  const parts: string[] = [];
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v)
      ? v.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
      : [];
  for (const a of list(meta?.attachments)) {
    if (typeof a.name === 'string')
      parts.push(`[${typeof a.kind === 'string' ? a.kind : 'file'}: ${a.name}]`);
  }
  for (const c of list(meta?.mentions)) {
    if (typeof c.label === 'string') parts.push(`[mentioned ${String(c.type)}: ${c.label}]`);
  }
  // p15-chat-zip: the upload id stays in the history, so "publish it" works in a later turn and a new session.
  parts.push(...siteZipNotes(meta));
  // p16-zip-job-input: the bundle id stays in the history ("now do X with those files" in a later turn).
  parts.push(...inputBundleNotes(meta));
  return parts.join(' ').slice(0, 1_000);
}

/**
 * The turn must fit one control frame with its envelope and JSON escaping: when history + context are too large
 * together, the context is replaced by a short note (the attachments' refs and the message stay).
 */
function fitFrame(body: { context?: string | undefined }): void {
  if (body.context === undefined) return;
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_FRAME_BYTES - 48 * 1024) return;
  body.context = fenceData('context omitted', {
    note: 'The mentioned items and attached text files did not fit into this turn together with the conversation so far; ask the user to mention fewer items or start a new conversation.',
  });
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function features(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
}

/** p8-chat-attachments-mentions: what the engine `runtime` of a worker's report takes besides text. */
export function inputSupport(
  workerFeatures: readonly string[],
  report: unknown,
  runtime: string,
  workerName: string,
): ChatInputSupport {
  if (!workerFeatures.includes(ASSISTANT_INPUT_FEATURE)) {
    return {
      images: 'unsupported',
      pdf: false,
      mentions: false,
      reason: `The assistant worker “${workerName}” must be updated to read images, files and mentions.`,
    };
  }
  const engines =
    report !== null && typeof report === 'object' && Array.isArray((report as { engines?: unknown }).engines)
      ? (report as { engines: unknown[] }).engines
      : [];
  const entry = engines.find(
    (e): e is { input?: unknown } =>
      e !== null && typeof e === 'object' && (e as { runtime?: unknown }).runtime === runtime,
  );
  const parsed = AssistantEngineInput.safeParse(entry?.input);
  const input = parsed.success ? parsed.data : { images: 'unsupported' as const, pdf: false };
  const label =
    runtime in ASSISTANT_RUNTIME_LABELS
      ? ASSISTANT_RUNTIME_LABELS[runtime as keyof typeof ASSISTANT_RUNTIME_LABELS]
      : runtime;
  return {
    images: input.images,
    pdf: input.pdf,
    mentions: true,
    reason:
      input.images === 'unsupported'
        ? `${label} cannot read images as the chat assistant.`
        : input.images === 'model-dependent'
          ? `Whether ${label} sees images depends on its configured model.`
          : null,
  };
}

/** A turn running on another replica, as far as this one heard (stream events). */
interface MirroredTurn {
  readonly id: string;
  state: string;
  text: string;
  /** Known on the replica that dispatched it (needed to record the end if the owner never answers). */
  readonly userId: string | null;
  readonly workerId: string | null;
  at: number;
}

export class ChatService {
  readonly #turns = new Map<string, ActiveTurn>();
  readonly #byThread = new Map<string, string>();
  /** threadId → a turn running on another replica (p5-ops-chat-next). */
  readonly #mirror = new Map<string, MirroredTurn>();
  readonly #redactor = new Redactor({ rules: DEFAULT_RULES });
  readonly #timeoutMs: number;
  /** p16-chat-complete: this process as a turn's runner (the bus replica id, or a process id without a bus). */
  readonly #runner: string;
  /** p16-chat-complete: when this process started (orphans are open turns created before it). */
  readonly #startedAt: Date;
  /** p16-chat-complete: restart re-runs done by this process (bounded). */
  #reruns = 0;

  constructor(private readonly deps: ChatServiceDeps) {
    this.#timeoutMs = deps.turnTimeoutMs ?? 6 * 60_000;
    this.#runner = (deps.bus?.replicaId ?? randomUUID()).slice(0, 64);
    this.#startedAt = deps.clock();
    deps.bus?.on((m, origin) => {
      this.#onBus(m, origin);
    });
  }

  #now(): Date {
    return this.deps.clock();
  }

  /** p16-chat-complete: this process as the runner of the turns it sends (`chat_turns.runner`). */
  get runner(): string {
    return this.#runner;
  }

  // ------------------------------------------------------------------------------------------- status

  async status(): Promise<ChatStatus> {
    return (await this.#route()).status;
  }

  /**
   * p15-chat-failover: which machine of [primary, ...backups] answers a turn now and with which engine / account
   * (docs/design/p15-chat-failover.md §3–§4): every chain machine is evaluated with the same-machine rules (main engine,
   * fallback account, fallback engine), then `chooseRoute` picks one (pin, automatic failover, stability period).
   * `exclude`: machines not to use for this turn (a re-run after a loss).
   */
  async #route(opts: { readonly exclude?: ReadonlySet<string> } = {}): Promise<Route> {
    const s = await this.deps.settings.get();
    const state = (await this.deps.failover?.state()) ?? { auto: true, pin: null, active: null };
    const base = {
      enabled: s.enabled,
      runtime: s.runtime as string,
      model: (await this.deps.settings.modelFor(s)) ?? null,
      limits: {
        turnsPerUserPer10Min: s.limits.turnsPerUserPer10Min,
        userDailyTokens: s.limits.userDailyTokens,
      },
      fallback: false,
      limit: null as ChatStatus['limit'],
      account: null as string | null,
      primary: null as ChatStatus['primary'],
      routing: null as ChatRouting | null,
      engines: [] as AssistantRuntime[],
      plan: false,
    };
    const unavailable = (
      code: ChatUnavailable,
      message: string,
      worker: ChatStatus['worker'] = null,
      extra: Partial<ChatStatus> = {},
    ): ChatStatus => ({
      ...base,
      input: NO_INPUT,
      available: false,
      code,
      message,
      worker,
      ...extra,
    });
    const none = (status: ChatStatus, chain: MachineEval[] = []): Route => ({
      settings: s,
      state,
      chain,
      chosen: null,
      reason: null,
      status,
    });
    if (s.workerId === null) {
      return none(unavailable('not_configured', 'No assistant worker is configured (Settings → Chat).'));
    }
    const ids = [s.workerId, ...s.backupWorkerIds.filter((id) => id !== s.workerId)];
    const { rows } = await this.deps.pool.query<WorkerRow>(
      `SELECT id, display_name, features, assistant, connected_at, worker_version FROM workers
        WHERE id = ANY($1::text[]) AND approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL`,
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (!byId.has(s.workerId)) {
      return none(unavailable('not_configured', 'The configured assistant worker no longer exists.'));
    }
    const chain: MachineEval[] = [];
    for (const id of ids) {
      const w = byId.get(id);
      if (w === undefined) continue; // a removed backup is skipped
      chain.push(await this.#evaluate(s, w, chain.length));
    }
    const primary = chain[0] as MachineEval;
    const primaryView = { id: primary.workerId, name: primary.name, online: primary.online };
    base.primary = primaryView;
    if (!s.enabled) {
      return none(unavailable('disabled', 'Chat is turned off by an administrator.', primaryView), chain);
    }
    const now = this.#now();
    const choice = chooseRoute(chain, state, now, {
      stableMs: this.deps.failoverStableMs ?? FAILOVER_STABLE_MS,
      ...(opts.exclude === undefined ? {} : { exclude: opts.exclude }),
    });
    const pin = state.pin;
    const routing = (c: MachineEval | null): ChatRouting => ({
      machine: c === null ? null : c.role,
      reason: choice.reason,
      position: c === null ? null : c.position,
      pinned: choice.pinned,
      auto: state.auto,
      primaryIssue:
        primary.issue === null ? null : { code: primary.issue, message: primary.issueMessage ?? '' },
      returnsAt: choice.returnsAt?.toISOString() ?? null,
      backups: chain.length - 1,
      pin:
        pin === null || pin.until.getTime() <= now.getTime()
          ? null
          : {
              workerId: pin.workerId,
              name: chain.find((c) => c.workerId === pin.workerId)?.name ?? pin.workerId,
              until: pin.until.toISOString(),
            },
    });
    const chosen = choice.chosen;
    if (chosen?.plan == null) {
      // Nobody can answer: the primary's reason, as before (and why no backup took over).
      const code = ISSUE_CODE[primary.issue ?? 'engine_not_ready'];
      const tail =
        chain.length > 1
          ? state.auto
            ? ' No backup assistant machine can answer either.'
            : ' Automatic failover to the backup machines is off (Settings → Chat).'
          : '';
      return none(
        unavailable(code, `${primary.issueMessage ?? 'The assistant is unavailable.'}${tail}`, primaryView, {
          limit: primary.limitView,
          routing: routing(null),
        }),
        chain,
      );
    }
    const plan = chosen.plan;
    return {
      settings: s,
      state,
      chain,
      chosen,
      reason: choice.reason,
      status: {
        ...base,
        runtime: plan.runtime,
        model: plan.model,
        fallback: plan.fallback,
        limit: plan.limit,
        account: plan.account,
        input: inputSupport(features(chosen.features), chosen.assistant, plan.runtime, chosen.name),
        available: true,
        code: null,
        message: null,
        worker: { id: chosen.workerId, name: chosen.name, online: true },
        routing: routing(chosen),
        engines: engineReadiness(chosen.assistant)
          .engines.filter((e) => e.ready)
          .map((e) => e.runtime),
        plan: features(chosen.features).includes(ASSISTANT_PLAN_FEATURE),
      },
    };
  }

  /**
   * One machine of the chain with the same-machine rules (p11-usage-limit-fallback, p13-runtime-accounts,
   * p15-message-delivery item 2): online, assistant feature, local opt-out, then the main engine with its account, at
   * its usage limit the fallback account, then the fallback engine. Backups use their configured login (account ids are
   * per machine) and `auto` only when the setting is `auto`.
   */
  async #evaluate(s: ChatSettings, w: WorkerRow, position: number): Promise<MachineEval> {
    const isPrimary = position === 0;
    const online = this.deps.session(w.id) !== undefined || (this.deps.bus?.ownerOf(w.id) ?? null) !== null;
    const head = {
      workerId: w.id,
      name: w.display_name,
      role: isPrimary ? ('primary' as const) : ('backup' as const),
      position,
      online,
      connectedAt: online ? w.connected_at : null,
      workerVersion: w.worker_version,
      features: w.features,
      assistant: w.assistant,
    };
    const fail = (
      issue: MachineIssue,
      issueMessage: string,
      limitView: ChatStatus['limit'] = null,
    ): MachineEval => ({ ...head, issue, issueMessage, plan: null, limitView });
    if (!online) {
      return fail('offline', `The assistant worker “${w.display_name}” is offline; chat is unavailable.`);
    }
    if (!features(w.features).includes(ASSISTANT_FEATURE)) {
      return fail(
        'update_required',
        `The assistant worker “${w.display_name}” must be updated to run the chat assistant.`,
      );
    }
    // Tolerant of newer workers: unknown runtimes in the report are skipped, not fatal.
    const report = engineReadiness(w.assistant);
    if (report.disabled) {
      return fail('disabled_on_worker', `The assistant is switched off locally on “${w.display_name}”.`);
    }
    const ok = (plan: MachinePlan): MachineEval => ({
      ...head,
      issue: null,
      issueMessage: null,
      plan,
      limitView: plan.limit,
    });
    const model = (await this.deps.settings.modelFor(s)) ?? null;
    const accountsOn = features(w.features).includes(RUNTIME_ACCOUNTS_FEATURE);
    const mainAccount = accountsOn && isPrimary ? (s.account ?? 'default') : 'default';
    const limits = await this.#engineLimits(w.id);
    const mainLimit = limits.find((l) => l.runtime === s.runtime && l.account === mainAccount) ?? null;
    const mainEngine = report.engines.find((e) => e.runtime === s.runtime);
    if (mainLimit !== null) {
      const limitView = {
        runtime: s.runtime,
        until: mainLimit.until.toISOString(),
        resetAt: mainLimit.resetAt?.toISOString() ?? null,
      };
      // p15-message-delivery item 2: "Otomatik" picks another ready account of the same runtime on that machine.
      const fa = !accountsOn
        ? null
        : s.fallbackAccount === AUTO_FALLBACK_ACCOUNT
          ? await this.#autoFallbackAccount(w.id, s.runtime, mainAccount, limits)
          : isPrimary
            ? s.fallbackAccount
            : null;
      if (
        fa !== null &&
        fa !== mainAccount &&
        mainEngine?.ready === true &&
        !limits.some((l) => l.runtime === s.runtime && l.account === fa)
      ) {
        return ok({
          runtime: s.runtime,
          model,
          account: fa === 'default' ? null : fa,
          fallback: true,
          limit: limitView,
        });
      }
      const fb = s.fallbackRuntime;
      const fbEngine = fb === null ? undefined : report.engines.find((e) => e.runtime === fb);
      if (fb !== null && fbEngine?.ready === true && !limits.some((l) => l.runtime === fb)) {
        return ok({
          runtime: fb,
          model: (await this.deps.settings.fallbackModelFor(s)) ?? null,
          account: null,
          fallback: true,
          limit: limitView,
        });
      }
      return fail(
        'engine_limited',
        `${ASSISTANT_RUNTIME_LABELS[s.runtime]} reached its usage limit; the assistant works again at ${limitView.until}.${
          fb === null
            ? ' (An administrator can set a fallback engine in Settings → Chat.)'
            : ` The fallback engine ${ASSISTANT_RUNTIME_LABELS[fb]} is not available on “${w.display_name}” right now.`
        }`,
        limitView,
      );
    }
    if (mainEngine?.ready !== true) {
      return fail(
        'engine_not_ready',
        `${ASSISTANT_RUNTIME_LABELS[s.runtime]} is not ready on “${w.display_name}”${mainEngine?.reason === undefined ? '' : `: ${mainEngine.reason}`}.`,
      );
    }
    return ok({
      runtime: s.runtime,
      model,
      account: accountsOn && isPrimary && s.account !== null && s.account !== 'default' ? s.account : null,
      fallback: false,
      limit: null,
    });
  }

  /**
   * p15-message-delivery item 2: the account "Otomatik" continues with — another account of the same runtime on the
   * machine that jobs could use as a fallback right now (not paused, logged in, no open limit episode, API keys only
   * with the workspace's paid switch; the default key never as a fallback) and that the chat has not seen at its limit,
   * in the workspace's account strategy order. Null: none (the fallback engine is next).
   */
  async #autoFallbackAccount(
    workerId: string,
    runtime: string,
    mainAccount: string,
    limits: readonly EngineLimit[],
  ): Promise<string | null> {
    if (runtime !== 'claude-code' && runtime !== 'codex') return null;
    const accounts = this.deps.accounts?.() ?? null;
    if (accounts === null) return null;
    try {
      const [facts, defaults, paid] = await Promise.all([
        accounts.facts([workerId]),
        accounts.defaults(),
        loadDefaultPolicy(this.deps.pool),
      ]);
      return pickAutoFallbackAccount({
        workerId,
        runtime,
        mainAccount,
        accounts: facts.get(workerId)?.[runtime] ?? [],
        chatLimited: limits.filter((l) => l.runtime === runtime).map((l) => l.account),
        allowPaid: paid.policy.allowPaidFallback,
        policy: defaults.policy,
      });
    } catch (err) {
      this.deps.log.warn({ err, workerId }, 'automatic fallback account lookup failed');
      return null;
    }
  }

  /** p11-usage-limit-fallback: the engines of `workerId` known to be at their usage limit now. */
  async #engineLimits(workerId: string): Promise<EngineLimit[]> {
    const { rows } = await this.deps.pool.query<{
      runtime: AssistantRuntime;
      account: string;
      until: Date;
      reset_at: Date | null;
    }>(
      'SELECT runtime, account, until, reset_at FROM chat_engine_limits WHERE worker_id = $1 AND until > $2',
      [workerId, this.#now()],
    );
    return rows.map((r) => ({ runtime: r.runtime, account: r.account, until: r.until, resetAt: r.reset_at }));
  }

  /** p11-usage-limit-fallback: remembers an engine's usage limit (the latest reset wins). */
  async #recordEngineLimit(
    runtime: AssistantRuntime,
    workerId: string,
    resetAt: Date | null,
    detail: string | undefined,
    account = 'default',
  ): Promise<Date> {
    const now = this.#now();
    const until =
      resetAt === null
        ? new Date(now.getTime() + ENGINE_LIMIT_DEFAULT_MS)
        : new Date(
            Math.min(
              Math.max(resetAt.getTime(), now.getTime() + 60_000),
              now.getTime() + ENGINE_LIMIT_MAX_MS,
            ),
          );
    await this.deps.pool.query(
      `INSERT INTO chat_engine_limits (runtime, worker_id, until, reset_at, detail, since, account)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (runtime, worker_id, account) DO UPDATE
         SET until = CASE WHEN chat_engine_limits.until > $6 THEN GREATEST(chat_engine_limits.until, EXCLUDED.until)
                          ELSE EXCLUDED.until END,
             reset_at = EXCLUDED.reset_at, detail = EXCLUDED.detail,
             since = CASE WHEN chat_engine_limits.until > $6 THEN chat_engine_limits.since ELSE EXCLUDED.since END`,
      [runtime, workerId, until, resetAt, detail === undefined ? null : detail.slice(0, 500), now, account],
    );
    const { rows } = await this.deps.pool.query<{ until: Date }>(
      'SELECT until FROM chat_engine_limits WHERE runtime = $1 AND worker_id = $2 AND account = $3',
      [runtime, workerId, account],
    );
    return rows[0]?.until ?? until;
  }

  // ---------------------------------------------------------------------------------- p15-chat-failover

  /** The admin view (design §7): who answers and why, the chain's verdicts, the controls' state, recent switches. */
  async failoverView(): Promise<FailoverView> {
    const route = await this.#route();
    const events = (await this.deps.failover?.events()) ?? [];
    const active = route.state.active;
    const activeName =
      active === null
        ? null
        : (route.chain.find((c) => c.workerId === active.workerId)?.name ??
          (await this.#nameOf(active.workerId)));
    return {
      status: route.status,
      auto: route.state.auto,
      stableSeconds: Math.round((this.deps.failoverStableMs ?? FAILOVER_STABLE_MS) / 1000),
      pin: route.status.routing?.pin ?? null,
      active:
        active === null
          ? null
          : {
              workerId: active.workerId,
              name: activeName ?? active.workerId,
              reason: active.reason,
              since: active.since.toISOString(),
            },
      chain: route.chain.map((c) => ({
        workerId: c.workerId,
        name: c.name,
        role: c.role,
        position: c.position,
        online: c.online,
        connectedAt: c.connectedAt?.toISOString() ?? null,
        workerVersion: c.workerVersion,
        eligible: c.issue === null,
        issue: c.issue,
        message: c.issueMessage,
        runtime: c.plan?.runtime ?? null,
        fallback: c.plan?.fallback ?? false,
        account: c.plan?.account ?? null,
        answering: route.chosen?.workerId === c.workerId,
      })),
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        from:
          e.fromWorkerId === null ? null : { id: e.fromWorkerId, name: e.fromWorkerName ?? e.fromWorkerId },
        to: e.toWorkerId === null ? null : { id: e.toWorkerId, name: e.toWorkerName ?? e.toWorkerId },
        reason: e.reason,
        actor: e.actor,
        at: e.at.toISOString(),
      })),
    };
  }

  #failoverStore(): ChatFailoverStore {
    const store = this.deps.failover;
    if (store === undefined) {
      throw new HttpError(
        404,
        'not_available',
        'Chat failover is not available.',
        {},
        {},
        { reason: 'failover' },
      );
    }
    return store;
  }

  /** "Force back to primary": clears the pin and moves the chat to the primary now (it must be able to answer). */
  async forcePrimary(actor: ActorContext): Promise<FailoverView> {
    const store = this.#failoverStore();
    const route = await this.#route();
    const primary = route.chain[0];
    if (primary === undefined) {
      throw new HttpError(
        409,
        'primary_unavailable',
        'No primary assistant machine is configured.',
        {},
        {},
        {
          reason: 'not_configured',
        },
      );
    }
    if (primary.issue !== null) {
      throw new HttpError(
        409,
        'primary_unavailable',
        primary.issueMessage ?? 'The primary assistant machine cannot answer now.',
        {},
        {},
        { reason: primary.issue, machine: primary.name },
      );
    }
    await store.forcePrimary(primary.workerId, actor);
    return this.failoverView();
  }

  async pin(input: { workerId: string; minutes: number }, actor: ActorContext): Promise<FailoverView> {
    const store = this.#failoverStore();
    const s = await this.deps.settings.get();
    const chain = s.workerId === null ? [] : [s.workerId, ...s.backupWorkerIds];
    await store.pin(input, chain, actor);
    return this.failoverView();
  }

  async unpin(actor: ActorContext): Promise<FailoverView> {
    await this.#failoverStore().unpin(actor);
    return this.failoverView();
  }

  async setAutoFailover(enabled: boolean, actor: ActorContext): Promise<FailoverView> {
    await this.#failoverStore().setAuto(enabled, actor);
    return this.failoverView();
  }

  /**
   * p15-chat-failover (design §8): what the assistant's tools say about the chat itself ("sohbet hangi makinede?") — the
   * answering machine and why, the chain and the controls, from the master's own sentences.
   */
  async routingSummary(): Promise<Record<string, unknown>> {
    const route = await this.#route();
    const st = route.status;
    const r = st.routing;
    const why: Record<RouteReason, string> = {
      primary: 'the primary machine answers',
      pinned: 'an administrator pinned this machine',
      primary_offline: 'the primary machine is not connected',
      primary_unavailable: 'the primary machine cannot answer right now',
      primary_unstable: 'the primary machine reconnected recently and takes over once it has been stable',
    };
    return {
      available: st.available,
      ...(st.available ? {} : { unavailableReason: st.message }),
      answeringMachine: st.available ? (st.worker?.name ?? null) : null,
      role: r?.machine ?? null,
      why: r?.reason == null ? null : why[r.reason],
      engine: st.runtime,
      model: st.model,
      usageLimitFallback: st.fallback,
      account: st.account,
      primaryMachine: st.primary?.name ?? null,
      ...(r?.primaryIssue == null ? {} : { primaryIssue: r.primaryIssue.message }),
      backupMachines: route.chain.slice(1).map((c) => ({
        name: c.name,
        canAnswer: c.issue === null,
        ...(c.issue === null ? {} : { why: c.issueMessage }),
      })),
      automaticFailover: r?.auto ?? route.state.auto,
      ...(r?.pin == null ? {} : { pinned: { machine: r.pin.name, until: r.pin.until } }),
      ...(r?.returnsAt == null ? {} : { primaryReturnsAt: r.returnsAt }),
      settingsScreen: 'Settings → Chat → Failover',
    };
  }

  snapshot(threadId: string): { turn: { id: string; state: string; text: string } | null } {
    const id = this.#byThread.get(threadId);
    const t = id === undefined ? undefined : this.#turns.get(id);
    if (t !== undefined)
      return { turn: { id: t.id, state: t.grace === undefined ? t.state : 'reconnecting', text: t.text } };
    const m = this.#mirrored(threadId);
    return { turn: m === undefined ? null : { id: m.id, state: m.state, text: m.text } };
  }

  /** The mirrored remote turn of a thread (forgotten when it is older than two turn timeouts). */
  #mirrored(threadId: string): MirroredTurn | undefined {
    const m = this.#mirror.get(threadId);
    if (m !== undefined && Date.now() - m.at > 2 * this.#timeoutMs) {
      this.#mirror.delete(threadId);
      return undefined;
    }
    return m;
  }

  // -------------------------------------------------------------------------------------------- turns

  async send(
    actor: ActorContext,
    threadId: string,
    rawText: string,
    opts: SendOptions = {},
  ): Promise<{ message: MessageView; turnId: string; dropped: MentionDrop[] }> {
    const userId = actor.userId;
    // p15-chat-vault: a secret-looking value never reaches the transcript, the streams or a model (the browser already
    // replaced what it recognised; this is the master's own pass for anything left).
    const scrubbed = scrubUserText(rawText);
    const text = scrubbed.text;
    const thread = await this.deps.store.thread(userId, threadId);
    if (thread.archived) throw new HttpError(409, 'thread_archived', 'This conversation is archived.');
    await this.deps.turnGuard?.()?.chatTurn(userId);
    const attachmentIds = opts.attachments ?? [];
    const mentionRefs = opts.mentions ?? [];
    const siteUploadIds = opts.siteUploads ?? [];
    const archives = opts.archives ?? [];
    const inputUploadIds = opts.inputUploads ?? [];
    if (
      text.trim() === '' &&
      attachmentIds.length === 0 &&
      siteUploadIds.length === 0 &&
      archives.length === 0 &&
      inputUploadIds.length === 0
    ) {
      throw new HttpError(400, 'invalid_message', 'Write a message or attach a file.');
    }
    if (attachmentIds.length > 0 && this.deps.attachments === undefined) {
      throw new HttpError(409, 'attachment_unsupported', 'Attachments are not available on this master.');
    }
    // p15-chat-zip: the site uploads must be the sender's own, ready, in a project they can read (else 404).
    let siteFacts: ChatSiteUploadFacts[] = [];
    if (siteUploadIds.length > 0) {
      const subject = await this.#subject(userId);
      if (this.deps.siteUploads === undefined || subject === null) {
        throw new HttpError(409, 'attachment_unsupported', 'Attachments are not available on this master.');
      }
      siteFacts = await this.deps.siteUploads.resolve(subject, siteUploadIds);
    }
    // p16-zip-job-input: the input bundles must be the sender's own, ready, in a project where they create jobs.
    let inputFacts: ChatInputUploadFacts[] = [];
    if (inputUploadIds.length > 0) {
      const subject = await this.#subject(userId);
      if (this.deps.inputUploads === undefined || subject === null) {
        throw new HttpError(409, 'attachment_unsupported', 'Attachments are not available on this master.');
      }
      inputFacts = await this.deps.inputUploads.resolve(subject, inputUploadIds);
    }
    // p15-chat-failover: the machine of [primary, ...backups] that answers now.
    const route = await this.#route();
    const status = route.status;
    const settings = route.settings;
    if (!status.available || route.chosen === null) {
      throw new HttpError(
        409,
        status.code === 'disabled'
          ? 'chat_disabled'
          : status.code === 'engine_limited'
            ? 'assistant_usage_limited'
            : 'assistant_unavailable',
        status.message ?? 'Chat is unavailable.',
      );
    }
    if (this.#byThread.has(threadId) || this.#mirrored(threadId) !== undefined) {
      throw new HttpError(409, 'turn_in_progress', 'The assistant is still answering in this conversation.');
    }
    const open = await this.deps.store.openTurn(threadId);
    if (open !== null && this.#now().getTime() - open.createdAt.getTime() < this.#timeoutMs) {
      throw new HttpError(409, 'turn_in_progress', 'The assistant is still answering in this conversation.');
    }
    // p8-chat-attachments-mentions: what the engine cannot read is refused, not dropped silently.
    // p16-chat-complete: an edit carries the original message's attachments (checked the same way).
    const edit = opts.edit;
    const pendingCheck =
      this.deps.attachments === undefined
        ? []
        : [
            ...(attachmentIds.length === 0
              ? []
              : await this.deps.attachments.pending(userId, threadId, attachmentIds)),
            ...(edit === undefined ? [] : await this.deps.attachments.ofMessage(edit.messageId)),
          ];
    if (pendingCheck.length > 0) {
      const images = pendingCheck.some((a) => a.kind === 'image');
      const pdfs = pendingCheck.some((a) => a.kind === 'pdf');
      // p14-i18n-errors: `reason` names the variant; a reason text from the worker is shown as it is (no variant).
      const runtime = ASSISTANT_RUNTIME_LABELS[settings.runtime];
      const refusal: { message: string; params: Record<string, string> } | null = !status.input.mentions
        ? status.input.reason === null
          ? {
              message: 'The assistant worker must be updated to read attachments.',
              params: { reason: 'update' },
            }
          : { message: status.input.reason, params: { reason: 'worker_text' } }
        : images && status.input.images === 'unsupported'
          ? status.input.reason === null
            ? { message: 'The assistant cannot read images.', params: { reason: 'images' } }
            : { message: status.input.reason, params: { reason: 'worker_text' } }
          : pdfs && !status.input.pdf
            ? {
                message: `${runtime} cannot read PDF files; attach images or text instead.`,
                params: { reason: 'pdf', runtime },
              }
            : null;
      if (refusal !== null)
        throw new HttpError(409, 'attachment_unsupported', refusal.message, {}, {}, refusal.params);
    }
    await this.#limit(userId, settings);
    // p18-plan-mode: `/plan …` / the Planla chip turns plan mode on with this message (409 on an older assistant
    // machine); the plan part of the turn (plan mode, the instruction, the "aktif plan" block) is read once here.
    const plans = this.deps.plans?.() ?? null;
    if (opts.mode === 'plan' && plans !== null) await plans.setMode(userId, threadId, true);
    const pin = plans === null ? null : await plans.turnInput(threadId);
    // p17-chat-flow: the card being changed ("Sohbette düzenle") becomes the turn's workflow context.
    const editMeta =
      opts.editDraft === undefined || opts.workflowAi !== undefined
        ? undefined
        : await this.#editDraftMeta(userId, threadId, opts.editDraft);
    // p14-ask-user: writing instead of answering closes an open question card (the person answered in prose).
    if (opts.answerTo === undefined) await this.deps.questions?.()?.supersedeThread(threadId);
    const workerId = route.chosen.workerId;
    // p16-chat-complete: an edit's history ends before the message it replaces.
    const history =
      edit === undefined
        ? await this.#history(threadId)
        : this.#historyOf(
            (await this.deps.store.messages(threadId, { current: true }))
              .filter((m) => m.seq < edit.fromSeq)
              .slice(-MAX_HISTORY_MESSAGES),
          );
    const original = edit === undefined ? null : await this.deps.store.message(threadId, edit.messageId);
    // Mentions are resolved now, as the sender (reloaded: a membership revoked since picking counts).
    let chips: MentionChip[] = [];
    let mentionBlocks: string[] = [];
    let dropped: MentionDrop[] = [];
    if (mentionRefs.length > 0) {
      const subject = await this.#subject(userId);
      if (!status.input.mentions || this.deps.mentions === undefined || subject === null) {
        dropped = mentionRefs.map((m) => ({ type: m.type, id: m.id, reason: 'not_visible' as const }));
      } else {
        const r = await this.deps.mentions.resolve(subject, mentionRefs, MAX_ASSISTANT_CONTEXT / 2);
        chips = r.chips;
        mentionBlocks = r.blocks;
        dropped = r.dropped;
      }
    }
    // p15-chat-vault: `{{credential:NAME}}` tokens — chips for the message, metadata blocks for the model (no values).
    let credentialChips: CredentialChip[] = [];
    const credentialBlocks: string[] = [];
    const creds = this.deps.credentials?.() ?? null;
    if (creds !== null && text.includes('{{credential:')) {
      const subject = await this.#subject(userId);
      if (subject !== null) {
        // p22-vault-projects: a credential a working project may not use is not resolved in this conversation.
        const r = await creds.tokens(subject, text, await threadProjectIds(this.deps.pool, threadId));
        credentialChips = r.chips;
        if (status.input.mentions)
          for (const b of r.blocks)
            credentialBlocks.push(this.#redactor.redact(fenceData('vault credential', b)));
      }
    }
    // p10-semantic-defaults-chat: related knowledge (only what the sender may read; never fails the turn).
    const related = status.input.mentions
      ? await this.#related(
          userId,
          threadId,
          text,
          chips.filter((c) => c.type === 'project').map((c) => c.id),
        )
      : null;
    const attachments = this.deps.attachments;
    const { message, atts } = await withTransaction(this.deps.pool, async (tx) => {
      // p20-outcome: a continuation's claim must still be this sender's (a turnless message of an expired attempt goes).
      if (opts.delivery !== undefined) await fenceDelivery(tx, opts.delivery, threadId);
      const locked =
        attachmentIds.length === 0 || attachments === undefined
          ? []
          : await attachments.pending(userId, threadId, attachmentIds, tx);
      const carried: unknown[] = Array.isArray(original?.meta?.attachments)
        ? (original.meta.attachments as unknown[])
        : [];
      const meta: Record<string, unknown> = {
        ...(locked.length === 0 && carried.length === 0
          ? {}
          : { attachments: [...carried, ...locked.map(attachmentMeta)] }),
        ...(edit === undefined ? {} : { editOf: edit.messageId }),
        ...(chips.length === 0 ? {} : { mentions: chips }),
        ...(credentialChips.length === 0 ? {} : { credentials: credentialChips }),
        ...(scrubbed.removed === 0 ? {} : { secretsRemoved: scrubbed.removed }),
        ...(related === null || related.items.length === 0
          ? {}
          : { related: { mode: related.mode, items: related.items } }),
        ...(opts.answerTo === undefined ? {} : { answerTo: opts.answerTo }),
        ...(opts.workflowAi === undefined ? {} : { workflowAi: opts.workflowAi }),
        ...(editMeta === undefined ? {} : { workflowAi: editMeta }),
        ...(opts.byUser === true ? { origin: 'user' } : {}),
        // p18-plan-mode: a plan continuation (a system line in the console), a message written in plan mode.
        ...(opts.plan === undefined
          ? {}
          : { origin: 'plan', plan: { id: opts.plan.planId, next: opts.plan.next } }),
        ...(opts.followUp === undefined || opts.plan !== undefined || opts.byUser === true
          ? {}
          : { origin: 'watch', watch: { id: opts.followUp.watchId } }),
        // p20-outcome: a goal resume turn; the delivery key of a continuation (its idempotency key).
        ...(opts.goal === undefined ||
        opts.plan !== undefined ||
        opts.followUp !== undefined ||
        opts.byUser === true
          ? {}
          : { origin: 'goal', goal: { id: opts.goal.goalId } }),
        // p22-slow-tools: a late tool result handed back.
        ...(opts.lateResult === undefined ||
        opts.plan !== undefined ||
        opts.followUp !== undefined ||
        opts.goal !== undefined ||
        opts.byUser === true
          ? {}
          : {
              origin: 'tool_result',
              lateResult: {
                tool: opts.lateResult.tool,
                consentAt: opts.lateResult.consentAt?.toISOString() ?? null,
              },
            }),
        ...(opts.delivery === undefined ? {} : { delivery: opts.delivery.key }),
        // oss-sec3: words from outside the person in a system-written message (never on a person's own message).
        ...(opts.untrusted === true && opts.byUser !== true ? { untrusted: true } : {}),
        ...(pin?.planMode === true ? { planMode: true } : {}),
        ...(opts.timeZone !== undefined && isValidTimeZone(opts.timeZone) ? { timeZone: opts.timeZone } : {}),
        ...(siteFacts.length === 0 ? {} : { siteUploads: siteFacts }),
        ...(archives.length === 0 ? {} : { archives }),
        ...(inputFacts.length === 0 ? {} : { inputUploads: inputFacts }),
      };
      const m = await this.deps.store.addMessage(
        threadId,
        { role: 'user', content: text, ...(Object.keys(meta).length === 0 ? {} : { meta }) },
        tx,
      );
      if (attachments !== undefined) await attachments.bind(tx, attachmentIds, m.id);
      if (opts.delivery !== undefined) await noteDeliveryMessage(tx, opts.delivery, m.id);
      if (edit !== undefined) {
        // p16-chat-complete: the edited message takes the original's files; the rows from the original on are
        // replaced by this one (their open cards are dismissed).
        await tx.query('UPDATE chat_attachments SET message_id = $2 WHERE message_id = $1', [
          edit.messageId,
          m.id,
        ]);
        await this.deps.store.supersede(tx, threadId, { fromSeq: edit.fromSeq, untilSeq: m.seq }, m.id);
      }
      if (siteFacts.length > 0) {
        await this.deps.siteUploads?.bind(
          tx,
          siteFacts.map((f) => f.id),
          threadId,
          m.id,
        );
      }
      if (inputFacts.length > 0) {
        await this.deps.inputUploads?.bind(
          tx,
          inputFacts.map((f) => f.id),
          threadId,
          m.id,
        );
      }
      return { message: m, atts: locked };
    });
    // p16-chat-complete: an edited message's files are the original's (moved in the transaction) plus new ones.
    const turnAtts =
      edit !== undefined && attachments !== undefined ? await attachments.ofMessage(message.id) : atts;
    const zipNames = [
      ...siteFacts.map((f) => ({ name: f.label ?? 'site.zip' })),
      ...archives.map((a) => ({ name: a.name })),
      ...inputFacts.map((f) => ({ name: f.label ?? 'files.zip' })),
    ];
    if (message.seq === 1) {
      // p17-chat-github: the first words are the instant placeholder; a first message that says too little (a
      // greeting, one word, only a file) makes the title provisional (retitled once after 3–5 messages).
      await this.deps.store.autoTitle(
        threadId,
        text.trim() === '' ? (atts[0]?.name ?? zipNames[0]?.name ?? 'Attachment') : text,
        !titleWorthy(text),
      );
    }
    if (dropped.length > 0) {
      const note = await this.deps.store.addMessage(threadId, {
        role: 'tool',
        content: `mentions: left out ${String(dropped.length)} ${dropped.length === 1 ? 'mention' : 'mentions'} — not visible to you (or the assistant worker cannot read mentions yet)`,
        meta: { name: 'mentions', isError: true, dropped: dropped.map((d) => ({ type: d.type })) },
      });
      this.deps.streams.publish(threadId, 'tool', note);
    }
    const personal = status.input.mentions ? await this.#personalBlock(userId) : null;
    // p18-multi-project W3: the working projects (members without access are dropped now, with a notice).
    const projectsBlock = await this.#projectsBlock(userId, threadId, workerId);
    // p19-autonomy-aware: what happens to this turn's drafts (run at once / card).
    const autonomy = await this.#autonomyBlock({
      userId,
      threadId,
      workerId,
      byUser: opts.byUser === true,
      planId: opts.byUser !== true ? opts.plan?.planId : undefined,
      followUp: opts.byUser !== true && opts.plan === undefined && opts.followUp !== undefined,
      human:
        opts.stepUp === undefined
          ? undefined
          : {
              mfaAt: opts.stepUp.mfaAt,
              stepUpMaxAgeMs: opts.stepUp.stepUpMaxAgeMs,
              alwaysFreshMaxAgeMs: opts.stepUp.alwaysFreshMaxAgeMs,
              ip: actor.ip,
              userAgent: actor.userAgent,
            },
    });
    // p15-workflow-ai: the editor's instruction and the workflow blocks (document, selection, run data).
    const wf = await this.#workflowInput(userId, threadId, message.id);
    const titleAsk = status.input.mentions ? await this.#titleBlock(threadId) : null;
    const extras = await this.#extras(
      turnAtts,
      [
        ...(wf === null || !status.input.mentions ? [] : wf.blocks),
        // p17-chat-github: the request to name the conversation (small; first so it is never cut).
        ...(titleAsk === null ? [] : [titleAsk]),
        // p18-plan-mode: the conversation's active plan (≤ 6 KB).
        ...(pin === null ? [] : pin.blocks),
        // p18-multi-project W3: the working projects (small, before the files).
        ...(projectsBlock === null ? [] : [projectsBlock]),
        ...(autonomy === null ? [] : [autonomy]),
        // p15-chat-zip: the message's site uploads / "not a site" notes (first: they are what this message is about).
        ...(status.input.mentions ? this.#siteZipBlocks(siteFacts, archives) : []),
        // p16-zip-job-input: the message's input bundles.
        ...(status.input.mentions ? this.#inputBlocks(inputFacts) : []),
        ...(personal === null ? [] : [personal]),
        ...mentionBlocks,
        ...credentialBlocks,
        ...(related?.block == null ? [] : [related.block]),
      ],
      workerId,
    );
    const turnId = randomUUID();
    // p11-usage-limit-fallback: the engine the status chose (the fallback engine while the main one is limited).
    const engineRuntime = AssistantRuntime.parse(status.runtime);
    const model = status.model ?? undefined;
    // p15-chat-failover: record a switch of the answering machine; tell the thread when its machine changed.
    await this.#commit(route);
    const notice = await this.#machineNotice(threadId, route);
    const turnRow = {
      id: turnId,
      threadId,
      userId,
      workerId,
      runtime: engineRuntime,
      model,
      messageId: message.id,
      ...(edit === undefined ? {} : { origin: 'edit' as const }),
    };
    const delivery = opts.delivery;
    if (delivery === undefined) await this.deps.store.createTurn(turnRow);
    else {
      // p20-outcome: the turn and the continuation's "sent" commit together (fenced by the claim's token); a lost
      // claim creates no turn and its message goes.
      try {
        await withTransaction(this.deps.pool, async (tx) => {
          await this.deps.store.createTurn(turnRow, tx);
          await completeDelivery(tx, delivery, turnId, this.#now());
        });
      } catch (err) {
        await this.deps.pool
          .query(
            `DELETE FROM chat_messages m WHERE m.id = $1
                AND NOT EXISTS (SELECT 1 FROM chat_turns t WHERE t.message_id = m.id)`,
            [message.id],
          )
          .catch(() => undefined);
        throw err;
      }
    }
    const local = this.deps.session(workerId);
    const owner = local === undefined ? (this.deps.bus?.ownerOf(workerId) ?? null) : null;
    if (owner !== null && this.deps.bus !== undefined) {
      await this.#dispatchRemote(this.deps.bus, owner, { turnId, threadId, userId, workerId, message });
      await this.#postNotice(threadId, notice, turnId);
      return { message, turnId, dropped };
    }
    const now = this.#now();
    const turn: ActiveTurn = {
      id: turnId,
      threadId,
      userId,
      workerId,
      connectionId: null,
      text: '',
      lastSeq: 0,
      toolCalls: 0,
      actions: 0,
      attachmentIds: new Set(extras.attachments.map((a) => a.id)),
      state: 'sent',
      startedAt: Date.now(),
      lastUpdateAt: Date.now(),
      runtime: engineRuntime,
      messageId: message.id,
      account: status.account,
      byUser: opts.byUser === true,
      planMode: pin?.planMode === true,
      ...(opts.byUser !== true && opts.plan !== undefined ? { planTurn: opts.plan.planId } : {}),
      ...(opts.byUser !== true && opts.plan === undefined && opts.followUp !== undefined
        ? { followUp: opts.followUp.watchId }
        : {}),
      ...(opts.byUser !== true &&
      opts.plan === undefined &&
      opts.followUp === undefined &&
      opts.goal === undefined &&
      opts.lateResult !== undefined
        ? { lateResult: { consentAt: opts.lateResult.consentAt } }
        : {}),
      ...(edit === undefined ? {} : { origin: 'edit' as const }),
      ...(opts.stepUp === undefined
        ? {}
        : {
            human: {
              mfaAt: opts.stepUp.mfaAt,
              stepUpMaxAgeMs: opts.stepUp.stepUpMaxAgeMs,
              alwaysFreshMaxAgeMs: opts.stepUp.alwaysFreshMaxAgeMs,
              ip: actor.ip,
              userAgent: actor.userAgent,
            },
          }),
    };
    this.#turns.set(turnId, turn);
    this.#byThread.set(threadId, turnId);
    this.deps.streams.publish(threadId, 'message', message);
    await this.#postNotice(threadId, notice, turnId);
    this.deps.streams.publish(threadId, 'turn', { id: turnId, state: 'sent' });
    const body: Omit<AssistantTurnPayload, 'signature'> = {
      turnId,
      sessionKey: threadId,
      runtime: engineRuntime,
      ...(model === undefined ? {} : { model }),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + TURN_TTL_MS).toISOString(),
      message: planWrap(
        pin,
        wf === null
          ? modelText(text, [...turnAtts, ...zipNames])
          : composeMessage(wf.instruction, modelText(text, [...turnAtts, ...zipNames])),
      ),
      history,
      ...(extras.attachments.length === 0 ? {} : { attachments: extras.attachments }),
      ...(extras.context === null ? {} : { context: extras.context }),
      // p13-runtime-accounts: only an added account is named (the status sets it only for accounts-capable workers).
      ...(status.account === null ? {} : { account: status.account }),
    };
    fitFrame(body);
    const session = this.deps.session(workerId);
    try {
      if (session === undefined) throw new Error('assistant worker offline');
      turn.connectionId = session.connectionId;
      turn.instanceId = session.instanceId ?? null;
      // p16-chat-complete: this process runs the turn (a restart finds it as an orphan of this runner).
      await this.deps.store.setRunner(turnId, this.#runner);
      const traceparent = this.deps.observe?.started(turnId, { runtime: engineRuntime, workerId });
      await session.send(
        'ASSISTANT_TURN',
        { ...body, signature: this.deps.signer.signAssistantTurn({ workerId, turn: body }) },
        traceparent === undefined ? undefined : { traceparent },
      );
    } catch (err) {
      this.deps.log.warn({ err, turnId, workerId }, 'assistant turn could not be sent');
      // p15-chat-failover: nothing ran — the next machine of the chain gets it.
      await this.#lost(turn, 'send_failed');
    }
    return { message, turnId, dropped };
  }

  /**
   * p14-ask-user: answers the assistant's question card of the caller's conversation and continues it — the answer
   * becomes the user's next message (model text: the structured answer), which starts the next turn. Refused while a
   * turn still runs (409 `turn_in_progress`: the card keeps the choices). A repeated identical answer whose message was
   * already sent changes nothing; one whose message could not be sent (assistant unavailable) is sent now.
   */
  async answerQuestion(
    actor: ActorContext,
    threadId: string,
    questionId: string,
    answers: unknown,
    stepUp?: SendOptions['stepUp'],
  ): Promise<{ question: QuestionView; turnId: string | null }> {
    const svc = this.deps.questions?.() ?? null;
    if (svc === null) throw new HttpError(404, 'question_not_found', 'Question not found.');
    const thread = await this.deps.store.thread(actor.userId, threadId);
    if (thread.archived) throw new HttpError(409, 'thread_archived', 'This conversation is archived.');
    // p18-plan-mode: a plan decision is recorded on its plan (panel and card update together) — it starts no turn and
    // may be answered while one runs; an executing plan goes on.
    const plans = this.deps.plans?.() ?? null;
    if (plans !== null && (await svc.planOf(threadId, questionId)) !== null)
      return plans.answerDecision(actor, threadId, questionId, answers);
    const busy = (): HttpError =>
      new HttpError(409, 'turn_in_progress', 'The assistant is still answering in this conversation.');
    if (this.#byThread.has(threadId) || this.#mirrored(threadId) !== undefined) throw busy();
    const open = await this.deps.store.openTurn(threadId);
    if (open !== null && this.#now().getTime() - open.createdAt.getTime() < this.#timeoutMs) throw busy();
    const { view, repeated } = await svc.answerThread(actor, threadId, questionId, answers);
    if (repeated && (await this.#answerSent(threadId, questionId))) return { question: view, turnId: null };
    const title = view.title === null ? '' : ` (“${view.title}”)`;
    const text = `Answer to your questions${title}:\n${answersText(view.questions, view.answers ?? [])}`;
    // p15-chat-execute-default: the answer is the person's own instruction.
    const sent = await this.send(actor, threadId, text, {
      answerTo: questionId,
      byUser: true,
      ...(stepUp === undefined ? {} : { stepUp }),
    });
    return { question: view, turnId: sent.turnId };
  }

  // ------------------------------------------------------------------------------- p22-chat-queue

  /**
   * p22-chat-queue (docs/design/p22-chat-queue.md): the composer's send. While a turn of the conversation runs — or
   * messages already wait — the message waits in the queue ("Sırada") and is delivered with the next turn; otherwise it
   * is sent as usual. Only a plain composer message queues (no edit, card edit, answer, workflow panel or system turn);
   * everything else keeps `send`'s 409 `turn_in_progress`.
   */
  async post(
    actor: ActorContext,
    threadId: string,
    rawText: string,
    opts: SendOptions = {},
  ): Promise<PostResult> {
    const queueable =
      opts.byUser === true &&
      opts.edit === undefined &&
      opts.editDraft === undefined &&
      opts.workflowAi === undefined &&
      opts.answerTo === undefined &&
      opts.delivery === undefined &&
      opts.plan === undefined &&
      opts.followUp === undefined &&
      opts.goal === undefined &&
      opts.lateResult === undefined;
    if (!queueable) return this.send(actor, threadId, rawText, opts);
    // Messages already wait (a turn just ended and they are being delivered): this one goes behind them.
    if (!(await hasQueued(this.deps.pool, threadId))) {
      try {
        return await this.send(actor, threadId, rawText, opts);
      } catch (err) {
        // `send` refuses a busy conversation before any side effect (after the message-rate guard, which counted it).
        if (!(err instanceof HttpError && err.code === 'turn_in_progress')) throw err;
      }
    } else {
      await this.deps.store.thread(actor.userId, threadId);
      await this.deps.turnGuard?.()?.chatTurn(actor.userId);
    }
    return this.#enqueue(actor, threadId, rawText, opts);
  }

  /** p22-chat-queue: the waiting messages of one of the caller's conversations (oldest first). */
  async queued(userId: string, threadId: string): Promise<QueuedMessageView[]> {
    await this.deps.store.thread(userId, threadId);
    return listQueued(this.deps.pool, threadId);
  }

  /** p22-chat-queue: changes the text of a waiting message (409 `message_not_queued` once it was delivered or removed). */
  async editQueued(
    userId: string,
    threadId: string,
    id: string,
    rawText: string,
  ): Promise<QueuedMessageView> {
    await this.deps.store.thread(userId, threadId);
    const scrubbed = scrubUserText(rawText);
    const current = (await listQueued(this.deps.pool, threadId)).find((q) => q.id === id);
    if (current === undefined)
      throw new HttpError(
        409,
        'message_not_queued',
        'This message is no longer waiting; it was sent or removed.',
      );
    if (scrubbed.text.trim() === '' && current.attachments === 0)
      throw new HttpError(400, 'invalid_message', 'Write a message or attach a file.');
    const creds = this.deps.credentials?.() ?? null;
    let credentials: CredentialChip[] = [];
    if (creds !== null && scrubbed.text.includes('{{credential:')) {
      const subject = await this.#subject(userId);
      if (subject !== null) credentials = (await creds.tokens(subject, scrubbed.text)).chips;
    }
    const rest = Object.fromEntries(
      Object.entries(current.meta).filter(([k]) => k !== 'credentials' && k !== 'secretsRemoved'),
    );
    const meta: Record<string, unknown> = {
      ...rest,
      ...(credentials.length === 0 ? {} : { credentials }),
      ...(scrubbed.removed === 0 ? {} : { secretsRemoved: scrubbed.removed }),
    };
    const v = await editQueued(this.deps.pool, {
      userId,
      threadId,
      id,
      content: scrubbed.text,
      meta,
      now: this.#now(),
    });
    this.deps.streams.publish(threadId, 'queue', { change: 'edited', ids: [id] });
    return v;
  }

  /** p22-chat-queue: removes a waiting message before it is delivered (409 `message_not_queued` once it was). */
  async removeQueued(userId: string, threadId: string, id: string): Promise<void> {
    await this.deps.store.thread(userId, threadId);
    await cancelQueued(this.deps.pool, { userId, threadId, id, now: this.#now() });
    this.deps.streams.publish(threadId, 'queue', { change: 'removed', ids: [id] });
  }

  /**
   * p22-chat-queue: stores a composer message behind the running turn. The sender's mentions, credential tokens and
   * uploads are resolved now (as the sender); the files stay the sender's unsent uploads until delivery binds them.
   */
  async #enqueue(
    actor: ActorContext,
    threadId: string,
    rawText: string,
    opts: SendOptions,
  ): Promise<PostResult> {
    const userId = actor.userId;
    const scrubbed = scrubUserText(rawText);
    const text = scrubbed.text;
    const thread = await this.deps.store.thread(userId, threadId);
    if (thread.archived) throw new HttpError(409, 'thread_archived', 'This conversation is archived.');
    const attachmentIds = opts.attachments ?? [];
    const siteUploadIds = opts.siteUploads ?? [];
    const archives = opts.archives ?? [];
    const inputUploadIds = opts.inputUploads ?? [];
    if (
      text.trim() === '' &&
      attachmentIds.length === 0 &&
      siteUploadIds.length === 0 &&
      archives.length === 0 &&
      inputUploadIds.length === 0
    ) {
      throw new HttpError(400, 'invalid_message', 'Write a message or attach a file.');
    }
    const attachments = this.deps.attachments;
    if (attachmentIds.length > 0 && attachments === undefined) {
      throw new HttpError(409, 'attachment_unsupported', 'Attachments are not available on this master.');
    }
    const mentionRefs = opts.mentions ?? [];
    const subject =
      siteUploadIds.length > 0 || inputUploadIds.length > 0 || mentionRefs.length > 0
        ? await this.#subject(userId)
        : null;
    let siteFacts: ChatSiteUploadFacts[] = [];
    if (siteUploadIds.length > 0) {
      if (this.deps.siteUploads === undefined || subject === null) {
        throw new HttpError(409, 'attachment_unsupported', 'Attachments are not available on this master.');
      }
      siteFacts = await this.deps.siteUploads.resolve(subject, siteUploadIds);
    }
    let inputFacts: ChatInputUploadFacts[] = [];
    if (inputUploadIds.length > 0) {
      if (this.deps.inputUploads === undefined || subject === null) {
        throw new HttpError(409, 'attachment_unsupported', 'Attachments are not available on this master.');
      }
      inputFacts = await this.deps.inputUploads.resolve(subject, inputUploadIds);
    }
    // Mention chips now (as the sender); their blocks are read again when the turn is sent (as for a dispatched turn).
    let chips: MentionChip[] = [];
    let dropped: MentionDrop[] = [];
    if (mentionRefs.length > 0) {
      if (this.deps.mentions === undefined || subject === null) {
        dropped = mentionRefs.map((m) => ({ type: m.type, id: m.id, reason: 'not_visible' as const }));
      } else {
        const r = await this.deps.mentions.resolve(subject, mentionRefs, MAX_ASSISTANT_CONTEXT / 2);
        chips = r.chips;
        dropped = r.dropped;
      }
    }
    let credentialChips: CredentialChip[] = [];
    const creds = this.deps.credentials?.() ?? null;
    if (creds !== null && text.includes('{{credential:')) {
      const s = await this.#subject(userId);
      if (s !== null) credentialChips = (await creds.tokens(s, text)).chips;
    }
    // p18-plan-mode: `/plan …` turns plan mode on now (the running turn keeps what it was given).
    const plans = this.deps.plans?.() ?? null;
    if (opts.mode === 'plan' && plans !== null) await plans.setMode(userId, threadId, true);
    const meta: Record<string, unknown> = {
      ...(chips.length === 0 ? {} : { mentions: chips }),
      ...(credentialChips.length === 0 ? {} : { credentials: credentialChips }),
      ...(scrubbed.removed === 0 ? {} : { secretsRemoved: scrubbed.removed }),
      origin: 'user',
      ...(opts.timeZone !== undefined && isValidTimeZone(opts.timeZone) ? { timeZone: opts.timeZone } : {}),
      ...(siteFacts.length === 0 ? {} : { siteUploads: siteFacts }),
      ...(archives.length === 0 ? {} : { archives }),
      ...(inputFacts.length === 0 ? {} : { inputUploads: inputFacts }),
    };
    const queued = await withTransaction(this.deps.pool, async (tx) => {
      // The conversation row orders this message against a delivery under way (which holds the same lock).
      await tx.query('SELECT 1 FROM chat_threads WHERE id = $1 FOR UPDATE', [threadId]);
      const files =
        attachmentIds.length === 0 || attachments === undefined
          ? []
          : await attachments.pending(userId, threadId, attachmentIds, tx);
      return insertQueued(tx, {
        threadId,
        userId,
        content: text,
        meta,
        attachments: files.map((f) => f.id),
        now: this.#now(),
      });
    });
    await this.deps.audit
      .record({
        actor: { type: 'user', id: userId },
        action: 'chat.message.queued',
        target: `chat-thread:${threadId}`,
        outcome: 'success',
        metadata: { queuedId: queued.id, attachments: queued.attachments },
      })
      .catch(() => undefined);
    this.deps.streams.publish(threadId, 'queue', { change: 'queued', ids: [queued.id] });
    // The turn may have ended between the check and the insert: deliver now (a no-op while one runs).
    if (!(await this.#turnOpen(threadId))) this.#drainSoon(threadId);
    return { queued, dropped };
  }

  /** p22-chat-queue: a turn of the conversation runs here, on a peer, or is open in the database (as `send` decides). */
  async #turnOpen(threadId: string): Promise<boolean> {
    if (this.#byThread.has(threadId) || this.#mirrored(threadId) !== undefined) return true;
    const open = await this.deps.store.openTurn(threadId);
    return open !== null && this.#now().getTime() - open.createdAt.getTime() < this.#timeoutMs;
  }

  /** p22-chat-queue: delivers the conversation's waiting messages in the background (never throws). */
  #drainSoon(threadId: string): void {
    void this.#drain(threadId).catch((err: unknown) => {
      this.deps.log.warn({ err, threadId }, 'queued chat messages could not be delivered');
    });
  }

  /**
   * p22-chat-queue: the sweep's pass — conversations with waiting messages, no open turn and no turn ended in the last
   * {@link QUEUE_QUIET_MS} (a restart, a missed end, a delivery that waited for a machine or a limit). Returns how many
   * conversations got their turn.
   */
  async drainQueues(): Promise<number> {
    let n = 0;
    for (const threadId of await readyThreads(this.deps.pool, this.#now(), QUEUE_QUIET_MS)) {
      try {
        if (await this.#drain(threadId)) n += 1;
      } catch (err) {
        this.deps.log.warn({ err, threadId }, 'queued chat messages could not be delivered');
      }
    }
    return n;
  }

  /**
   * p22-chat-queue: delivers the waiting messages of a conversation whose turn ended. ONE transaction locks the
   * conversation row, checks that no turn is open, turns every waiting row into its own user message (in order), creates
   * the turn for the last one (its input: all of their texts) and marks the rows delivered — concurrent ends, replicas
   * and the sweep serialise on the lock, and the second finds the turn open or nothing waiting: exactly once. The turn
   * is then sent like a dispatched one. Returns whether a turn was created.
   */
  async #drain(threadId: string): Promise<boolean> {
    if (this.#byThread.has(threadId) || this.#mirrored(threadId) !== undefined) return false;
    const route = await this.#route();
    const now = this.#now();
    const chosen = route.chosen;
    const plan = chosen?.plan ?? null;
    if (!route.status.available || chosen === null || plan === null) {
      if (await hasQueued(this.deps.pool, threadId))
        await holdQueued(this.deps.pool, threadId, 'assistant_unavailable', now);
      return false;
    }
    const turnId = randomUUID();
    const attachments = this.deps.attachments;
    type Drained =
      | { readonly kind: 'none' }
      | { readonly kind: 'hold'; readonly reason: string }
      | { readonly kind: 'sent'; readonly userId: string; readonly messages: MessageView[] };
    const out = await withTransaction(this.deps.pool, async (tx): Promise<Drained> => {
      const { rows: th } = await tx.query<{ user_id: string; archived: boolean }>(
        `SELECT user_id::text AS user_id, archived_at IS NOT NULL AS archived FROM chat_threads
          WHERE id = $1 FOR UPDATE`,
        [threadId],
      );
      const thread = th[0];
      if (thread === undefined || thread.archived) return { kind: 'none' };
      const { rows: open } = await tx.query(
        `SELECT 1 FROM chat_turns WHERE thread_id = $1 AND state IN ('sent', 'running') AND created_at > $2 LIMIT 1`,
        [threadId, new Date(now.getTime() - this.#timeoutMs)],
      );
      if (open.length > 0) return { kind: 'none' };
      const rows = await lockQueued(tx, threadId);
      const first = rows[0];
      if (first === undefined) return { kind: 'none' };
      const userId = first.user_id;
      // One turn for the whole batch: the owner's message rate / cost brake and the per-turn rate limit and budgets,
      // as for any new turn (a refusal waits for the sweep).
      try {
        await this.deps.turnGuard?.()?.chatTurn(userId);
        await this.#limit(userId, route.settings);
      } catch (err) {
        if (err instanceof HttpError) return { kind: 'hold', reason: err.code };
        throw err;
      }
      const messages: MessageView[] = [];
      for (const [i, q] of rows.entries()) {
        const files =
          q.attachments.length === 0 || attachments === undefined
            ? []
            : await attachments.pending(q.user_id, threadId, q.attachments, tx);
        const meta: Record<string, unknown> = {
          ...q.meta,
          ...(files.length === 0 ? {} : { attachments: files.map(attachmentMeta) }),
          queued: true,
          // The last row carries the batch: a re-send (failover, restart, another replica) reads them again.
          ...(i === rows.length - 1 && messages.length > 0 ? { queuedWith: messages.map((m) => m.id) } : {}),
        };
        const m = await this.deps.store.addMessage(threadId, { role: 'user', content: q.content, meta }, tx);
        if (attachments !== undefined && files.length > 0)
          await attachments.bind(
            tx,
            files.map((f) => f.id),
            m.id,
          );
        const site = metaSiteUploads(meta).map((f) => f.id);
        if (site.length > 0) await this.deps.siteUploads?.bind(tx, site, threadId, m.id);
        const input = metaInputUploads(meta).map((f) => f.id);
        if (input.length > 0) await this.deps.inputUploads?.bind(tx, input, threadId, m.id);
        if (!(await markDelivered(tx, q.id, m.id, turnId, now))) throw new Error('queued message changed');
        messages.push(m);
      }
      const last = messages.at(-1);
      if (last === undefined) return { kind: 'none' };
      await this.deps.store.createTurn(
        {
          id: turnId,
          threadId,
          userId,
          workerId: chosen.workerId,
          runtime: plan.runtime,
          model: plan.model ?? undefined,
          messageId: last.id,
        },
        tx,
      );
      return { kind: 'sent', userId, messages };
    });
    if (out.kind === 'hold') {
      await holdQueued(this.deps.pool, threadId, out.reason, now);
      this.deps.streams.publish(threadId, 'queue', { change: 'held', ids: [] });
      return false;
    }
    if (out.kind === 'none') return false;
    const last = out.messages.at(-1);
    if (last === undefined) return false;
    await this.deps.audit
      .record({
        actor: { type: 'user', id: out.userId },
        action: 'chat.message.queue_delivered',
        target: `chat-turn:${turnId}`,
        outcome: 'success',
        metadata: { threadId, messages: out.messages.length },
      })
      .catch(() => undefined);
    // p14-ask-user: writing instead of answering closes an open question card.
    await this.deps
      .questions?.()
      ?.supersedeThread(threadId)
      .catch(() => 0);
    for (const m of out.messages.slice(0, -1)) this.deps.streams.publish(threadId, 'message', m);
    this.deps.streams.publish(threadId, 'queue', {
      change: 'delivered',
      ids: out.messages.map((m) => m.id),
      turnId,
    });
    await this.#commit(route);
    const workerId = chosen.workerId;
    const session = this.deps.session(workerId);
    const owner = session === undefined ? (this.deps.bus?.ownerOf(workerId) ?? null) : null;
    if (session === undefined && owner !== null && this.deps.bus !== undefined) {
      await this.#dispatchRemote(this.deps.bus, owner, {
        turnId,
        threadId,
        userId: out.userId,
        workerId,
        message: last,
      });
      return true;
    }
    this.deps.streams.publish(threadId, 'message', last);
    if (session === undefined) {
      // Nothing can take it now: the turn ends with the usual line (the console offers Retry).
      await this.#record(
        {
          id: turnId,
          threadId,
          userId: out.userId,
          workerId,
          connectionId: null,
          text: '',
          lastSeq: 0,
          toolCalls: 0,
          actions: 0,
          byUser: true,
          attachmentIds: new Set(),
          state: 'sent',
          startedAt: Date.now(),
          lastUpdateAt: Date.now(),
          messageId: last.id,
        },
        { state: 'failed', reason: 'send_failed', continues: true },
      );
      return true;
    }
    this.deps.streams.publish(threadId, 'turn', { id: turnId, state: 'sent' });
    const sent = await this.#sendStoredTurn({
      turnId,
      threadId,
      userId: out.userId,
      workerId,
      runtime: plan.runtime,
      model: plan.model,
      messageId: last.id,
      session,
      account: plan.account,
    });
    if (sent === 'missing') await this.deps.store.finishTurn(turnId, { state: 'failed', reason: 'lost' });
    return true;
  }

  /** p18-plan-mode: no turn of the conversation runs (here, on a peer, or open in the database). */
  async idle(threadId: string): Promise<boolean> {
    try {
      await this.#assertIdle(threadId);
      return true;
    } catch {
      return false;
    }
  }

  /** p18-plan-mode: the machine that answers now has the plan tools (`assistant-plan-v1`). */
  async planReady(): Promise<boolean> {
    return (await this.#route()).status.plan;
  }

  /**
   * p18-project-bootstrap: the machine that answers now has the project setup tools (`assistant-project-setup-v1`) —
   * a plan continuation then names a not-ready project's readiness decision.
   */
  async projectSetupReady(): Promise<boolean> {
    const id = (await this.#route()).status.worker?.id;
    if (id === undefined) return false;
    const { rows } = await this.deps.pool.query<{ features: unknown }>(
      'SELECT features FROM workers WHERE id = $1',
      [id],
    );
    return features(rows[0]?.features).includes(ASSISTANT_PROJECT_SETUP_FEATURE);
  }

  // ------------------------------------------------------------------ p16-chat-complete: edit / regenerate / retry

  /** No turn of the conversation runs (here, on a peer, or open in the database within the turn timeout). */
  async #assertIdle(threadId: string): Promise<void> {
    const busy = (): HttpError =>
      new HttpError(409, 'turn_in_progress', 'The assistant is still answering in this conversation.');
    if (this.#byThread.has(threadId) || this.#mirrored(threadId) !== undefined) throw busy();
    const open = await this.deps.store.openTurn(threadId);
    if (open !== null && this.#now().getTime() - open.createdAt.getTime() < this.#timeoutMs) throw busy();
  }

  /**
   * p16-chat-complete (design §1.1): edits one of the caller's own user messages — the conversation forks there: the
   * message and every later row are superseded by the edited text, sent as a new message (its files moved, its mentions
   * and site uploads resolved again as the sender). Turns that acted are not replaced without `acknowledgeActions`
   * (409 `turn_acted` with what they did — the failover replay rule).
   */
  async edit(
    actor: ActorContext,
    threadId: string,
    messageId: string,
    rawText: string,
    opts: { readonly acknowledgeActions?: boolean | undefined; readonly stepUp?: SendOptions['stepUp'] } = {},
  ): Promise<{ message: MessageView; turnId: string; dropped: MentionDrop[] }> {
    const userId = actor.userId;
    const thread = await this.deps.store.thread(userId, threadId);
    if (thread.archived) throw new HttpError(409, 'thread_archived', 'This conversation is archived.');
    await this.#assertIdle(threadId);
    const m = await this.deps.store.message(threadId, messageId);
    if (m?.role !== 'user') throw new HttpError(404, 'message_not_found', 'Message not found.');
    if (m.supersededAt !== undefined)
      throw new HttpError(409, 'message_superseded', 'This message was already replaced by a later edit.');
    if (rawText.trim() === '')
      throw new HttpError(400, 'invalid_message', 'Write a message or attach a file.');
    const later = (await this.deps.store.messages(threadId, { current: true }))
      .filter((x) => x.role === 'user' && x.seq >= m.seq)
      .map((x) => x.id);
    const effects = await this.deps.store.turnEffects(threadId, m.seq, later);
    if (effects.actions > 0 && opts.acknowledgeActions !== true) throw actedError(effects);
    const meta = m.meta ?? {};
    const refs = MentionRefs.safeParse(
      (Array.isArray(meta.mentions) ? (meta.mentions as unknown[]) : []).map((c) => {
        const x = (c ?? {}) as { type?: unknown; id?: unknown; project?: unknown };
        return { type: x.type, id: x.id, ...(typeof x.project === 'string' ? { project: x.project } : {}) };
      }),
    );
    const mentions = refs.success ? refs.data : [];
    const uploads = metaSiteUploads(meta).map((f) => f.id);
    const archives = metaArchives(meta);
    const bundles = metaInputUploads(meta).map((f) => f.id);
    const sent = await this.send(actor, threadId, rawText, {
      ...(mentions.length === 0 ? {} : { mentions }),
      ...(uploads.length === 0 ? {} : { siteUploads: uploads }),
      ...(archives.length === 0 ? {} : { archives }),
      ...(bundles.length === 0 ? {} : { inputUploads: bundles }),
      byUser: true,
      ...(opts.stepUp === undefined ? {} : { stepUp: opts.stepUp }),
      edit: { messageId: m.id, fromSeq: m.seq },
    });
    await this.deps.audit
      .record({
        actor: { type: 'user', id: userId },
        action: 'chat.message.edit',
        target: `chat-thread:${threadId}`,
        outcome: 'success',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: {
          messageId: m.id,
          newMessageId: sent.message.id,
          turnId: sent.turnId,
          ...(effects.actions > 0 ? { acknowledgedActions: effects.actions } : {}),
        },
      })
      .catch(() => undefined);
    return sent;
  }

  /**
   * p16-chat-complete (design §1.2): answers the last current user message again — optionally with another engine /
   * model the answering machine has ready — after superseding everything that followed it. `mode: 'retry'` is the same
   * for a failed / lost / cancelled last turn. Turns that acted ask first (409 `turn_acted`).
   */
  async regenerate(
    actor: ActorContext,
    threadId: string,
    o: RegenerateOptions = {},
  ): Promise<{ turnId: string }> {
    const userId = actor.userId;
    const thread = await this.deps.store.thread(userId, threadId);
    if (thread.archived) throw new HttpError(409, 'thread_archived', 'This conversation is archived.');
    await this.#assertIdle(threadId);
    await this.deps.turnGuard?.()?.chatTurn(userId);
    const user = await this.deps.store.lastUserMessage(threadId);
    if (user === null)
      throw new HttpError(409, 'nothing_to_regenerate', 'There is no message to answer again yet.');
    if (o.messageId !== undefined && o.messageId !== user.id)
      throw new HttpError(
        409,
        'not_last_message',
        'Only the answer to the last message can be produced again.',
      );
    const effects = await this.deps.store.turnEffects(threadId, user.seq + 1, [user.id]);
    if (effects.actions > 0 && o.acknowledgeActions !== true) throw actedError(effects);
    const route = await this.#route();
    const status = route.status;
    const chosen = route.chosen;
    if (!status.available || chosen?.plan == null) {
      throw new HttpError(
        409,
        status.code === 'disabled'
          ? 'chat_disabled'
          : status.code === 'engine_limited'
            ? 'assistant_usage_limited'
            : 'assistant_unavailable',
        status.message ?? 'Chat is unavailable.',
      );
    }
    const plan = chosen.plan;
    let runtime = plan.runtime;
    let model = plan.model;
    let account = plan.account;
    if (o.runtime !== undefined && o.runtime !== plan.runtime) {
      if (!status.engines.includes(o.runtime)) {
        throw new HttpError(
          409,
          'engine_not_ready',
          `${ASSISTANT_RUNTIME_LABELS[o.runtime]} is not ready on “${chosen.name}”; choose an engine that is.`,
          {},
          {},
          { runtime: ASSISTANT_RUNTIME_LABELS[o.runtime], machine: chosen.name },
        );
      }
      runtime = o.runtime;
      account = null;
      model =
        o.runtime === route.settings.fallbackRuntime
          ? ((await this.deps.settings.fallbackModelFor(route.settings)) ?? null)
          : null;
    }
    if (o.model !== undefined) {
      if (modelIdIssue(o.model) !== null)
        throw new HttpError(
          400,
          'invalid_model',
          'The model name is not valid.',
          {},
          {},
          { reason: 'model' },
        );
      model = o.model;
    }
    await this.#limit(userId, route.settings);
    const origin: TurnOrigin = o.mode === 'retry' ? 'retry' : 'regenerate';
    const turnId = randomUUID();
    const workerId = chosen.workerId;
    await withTransaction(this.deps.pool, (tx) =>
      this.deps.store.supersede(tx, threadId, { fromSeq: user.seq + 1, extraTurns: effects.turnIds }, turnId),
    );
    await this.#commit(route);
    await this.deps.store.createTurn({
      id: turnId,
      threadId,
      userId,
      workerId,
      runtime,
      model: model ?? undefined,
      messageId: user.id,
      origin,
    });
    await this.deps.audit
      .record({
        actor: { type: 'user', id: userId },
        action: `chat.turn.${origin}`,
        target: `chat-thread:${threadId}`,
        outcome: 'success',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: {
          messageId: user.id,
          turnId,
          runtime,
          model,
          workerId,
          ...(effects.actions > 0 ? { acknowledgedActions: effects.actions } : {}),
        },
      })
      .catch(() => undefined);
    this.deps.streams.publish(threadId, 'thread', thread);
    const session = this.deps.session(workerId);
    const owner = session === undefined ? (this.deps.bus?.ownerOf(workerId) ?? null) : null;
    if (session === undefined && owner !== null && this.deps.bus !== undefined) {
      await this.#dispatchRemote(this.deps.bus, owner, { turnId, threadId, userId, workerId, message: user });
      return { turnId };
    }
    if (session === undefined) {
      await this.deps.store.finishTurn(turnId, { state: 'failed', reason: 'send_failed' });
      throw new HttpError(409, 'assistant_unavailable', 'Chat is unavailable.');
    }
    this.deps.streams.publish(threadId, 'turn', { id: turnId, state: 'sent' });
    const sent = await this.#sendStoredTurn({
      turnId,
      threadId,
      userId,
      workerId,
      runtime,
      model,
      messageId: user.id,
      session,
      account,
      origin,
      ...(o.stepUp === undefined
        ? {}
        : {
            human: {
              mfaAt: o.stepUp.mfaAt,
              stepUpMaxAgeMs: o.stepUp.stepUpMaxAgeMs,
              alwaysFreshMaxAgeMs: o.stepUp.alwaysFreshMaxAgeMs,
              ip: actor.ip,
              userAgent: actor.userAgent,
            },
          }),
    });
    if (sent === 'missing') await this.deps.store.finishTurn(turnId, { state: 'failed', reason: 'lost' });
    return { turnId };
  }

  // ------------------------------------------------------------------- p16-chat-complete: restart recovery

  /** Whether `runner` is a live master process (this one, or a peer replica that announces itself). */
  #alive(runner: string): boolean {
    if (runner === this.#runner) return true;
    return this.deps.bus?.alive?.(runner) ?? false;
  }

  /**
   * p16-chat-complete (design §2): turns left open by a master process that stopped. Each orphan (created before this
   * process started; its runner neither this process nor a live peer) is claimed with the guarded end update — exactly
   * one replica wins — and answered once more when it did not act, was never re-run, is recent and a machine can answer
   * (bounded per start, only inside the recovery window; while no machine can answer it waits for the next sweep).
   * Otherwise it ends with the error line and the console's Retry. Never throws.
   */
  async recover(): Promise<{ lost: number; rerun: number }> {
    const cfg = this.deps.restartRecovery ?? {};
    const now = this.#now();
    const since = now.getTime() - this.#startedAt.getTime();
    const inWindow = since <= (cfg.windowMs ?? 5 * 60_000);
    let lost = 0;
    let rerun = 0;
    // Peers announce themselves every few seconds: before that, a live peer's turn would look orphaned.
    if (since < (cfg.graceMs ?? 15_000)) return { lost, rerun };
    let route: Route | null | undefined;
    let rows: OpenTurnRow[];
    try {
      rows = await this.deps.store.openTurnsBefore(this.#startedAt);
    } catch (err) {
      this.deps.log.warn({ err }, 'chat restart recovery could not read open turns');
      return { lost, rerun };
    }
    for (const r of rows) {
      try {
        if (this.#turns.has(r.id) || (r.runner !== null && this.#alive(r.runner))) continue;
        // No runner yet: a live replica may still be dispatching it (acknowledged within seconds).
        if (r.runner === null && now.getTime() - r.created_at.getTime() < 30_000) continue;
        const messageId =
          r.message_id ??
          (r.thread_id === null ? null : ((await this.deps.store.lastUserMessage(r.thread_id))?.id ?? null));
        const eligible =
          inWindow &&
          r.thread_id !== null &&
          messageId !== null &&
          r.actions === 0 &&
          r.rerun_of === null &&
          now.getTime() - r.created_at.getTime() <= (cfg.maxAgeMs ?? 30 * 60_000) &&
          this.#reruns < (cfg.maxReruns ?? 20);
        if (eligible) {
          route ??= await this.#route().catch(() => null);
          // No machine can answer yet (the worker is still reconnecting): wait for the next sweep.
          if (route?.chosen?.plan == null) continue;
        }
        if (!(await this.deps.store.finishTurn(r.id, { state: 'failed', reason: 'lost' }))) continue;
        lost += 1;
        if (!eligible || route?.chosen?.plan == null) {
          await this.#lostLine(r);
          continue;
        }
        this.#reruns += 1;
        rerun += 1;
        await this.deps.audit
          .record({
            actor: { type: 'system', id: 'chat' },
            action: 'chat.turn.restart_rerun',
            target: `chat-thread:${r.thread_id}`,
            outcome: 'success',
            metadata: { lostTurn: r.id, messageId, workerId: r.worker_id },
          })
          .catch(() => undefined);
        const runtime = AssistantRuntime.safeParse(r.runtime);
        await this.#continueTurn(
          {
            id: r.id,
            threadId: r.thread_id,
            userId: r.user_id,
            workerId: r.worker_id,
            connectionId: null,
            text: '',
            lastSeq: 0,
            toolCalls: 0,
            actions: 0,
            attachmentIds: new Set(),
            state: 'sent',
            startedAt: 0,
            lastUpdateAt: 0,
            ...(runtime.success ? { runtime: runtime.data } : {}),
            messageId,
            byUser: false,
            ...(r.origin === null ? {} : { origin: r.origin }),
          },
          route,
          { kind: 'rerun', cause: 'restart' },
        );
      } catch (err) {
        this.deps.log.warn({ err, turnId: r.id }, 'chat restart recovery of a turn failed');
      }
    }
    return { lost, rerun };
  }

  /** p16-chat-complete: the line of a turn that ended without an answer and is not answered again by itself. */
  async #lostLine(r: Pick<OpenTurnRow, 'id' | 'thread_id' | 'actions'>): Promise<void> {
    if (r.thread_id === null) return;
    const n = r.actions;
    const detail =
      n > 0
        ? ` It had already acted (${String(n)} ${n === 1 ? 'tool call' : 'tool calls'}), so it is not repeated automatically — check the results above, then use Retry.`
        : ' Use Retry to answer your message again.';
    try {
      const message = await this.deps.store.addMessage(r.thread_id, {
        role: 'error',
        content: `${REASONS.lost ?? ''}${detail}`.slice(0, 1000),
        meta: { reason: 'lost', actions: n },
        turnId: r.id,
      });
      this.deps.streams.publish(r.thread_id, 'message', message);
      this.deps.streams.publish(r.thread_id, 'error', {
        turnId: r.id,
        reason: 'lost',
        message: message.content,
      });
    } catch (err) {
      this.deps.log.debug({ err, turnId: r.id }, 'lost turn line not recorded');
    }
  }

  async #answerSent(threadId: string, questionId: string): Promise<boolean> {
    const { rows } = await this.deps.pool.query(
      `SELECT 1 FROM chat_messages WHERE thread_id = $1 AND role = 'user' AND meta->>'answerTo' = $2 LIMIT 1`,
      [threadId, questionId],
    );
    return rows.length > 0;
  }

  /** Signed refs of the binary attachments and the fenced context (mentions first, then the files). */
  async #extras(
    atts: readonly AttachmentView[],
    mentionBlocks: readonly string[],
    workerId: string | null = null,
  ): Promise<TurnExtras> {
    const a = this.deps.attachments;
    const fileBlocks =
      a === undefined || atts.length === 0
        ? []
        : await a.contextBlocks(
            atts,
            Math.max(0, MAX_ASSISTANT_CONTEXT - 8_192 - mentionBlocks.reduce((n, b) => n + b.length, 0)),
            { repoInputsRule: workerId !== null && (await this.#repoInputsRule(workerId)) },
          );
    const blocks: string[] = [];
    let size = 0;
    for (const b of [...mentionBlocks, ...fileBlocks]) {
      if (size + b.length + 2 > MAX_ASSISTANT_CONTEXT) break;
      blocks.push(b);
      size += b.length + 2;
    }
    return {
      attachments: ChatAttachments.refs(atts),
      context: blocks.length === 0 ? null : blocks.join('\n\n'),
    };
  }

  /** p10-semantic-defaults-chat: the related-knowledge lookup of a turn; a failure only loses the block. */
  async #related(
    userId: string,
    threadId: string,
    text: string,
    projects: readonly string[],
  ): Promise<RelatedResult | null> {
    const k = this.deps.knowledge;
    if (k === undefined) return null;
    try {
      const subject = await this.#subject(userId);
      return subject === null ? null : await k.related(subject, threadId, text, projects);
    } catch (err) {
      this.deps.log.warn(
        { errName: err instanceof Error ? err.name : 'error', threadId },
        'related knowledge lookup failed',
      );
      return null;
    }
  }

  /** The extras of a stored user message (a turn another replica asked this one to send). */
  async #extrasOf(
    userId: string,
    m: MessageView,
    threadId: string,
    workflowBlocks: readonly string[] = [],
    workerId: string | null = null,
    /** p22-chat-queue: the earlier messages of a delivered batch (their files, mentions and uploads count too). */
    batch: readonly MessageView[] = [],
  ): Promise<TurnExtras> {
    const a = this.deps.attachments;
    const all = [...batch, m];
    const atts = a === undefined ? [] : (await Promise.all(all.map((x) => a.ofMessage(x.id)))).flat();
    let blocks: string[] = [];
    const raw = all.flatMap((x) => (Array.isArray(x.meta?.mentions) ? (x.meta.mentions as unknown[]) : []));
    if (raw.length > 0 && this.deps.mentions !== undefined) {
      const refs = MentionRefs.safeParse(
        raw.map((c) => {
          const x = (c ?? {}) as { type?: unknown; id?: unknown; project?: unknown };
          return { type: x.type, id: x.id, ...(typeof x.project === 'string' ? { project: x.project } : {}) };
        }),
      );
      const subject = await this.#subject(userId);
      if (refs.success && subject !== null) {
        blocks = (await this.deps.mentions.resolve(subject, refs.data, MAX_ASSISTANT_CONTEXT / 2)).blocks;
      }
    }
    if (m.meta?.related !== undefined) {
      const related = await this.#related(userId, threadId, m.content, mentionedProjects(m.meta));
      if (related?.block != null) blocks = [...blocks, related.block];
    }
    const personal = await this.#personalBlock(userId);
    if (personal !== null) blocks = [personal, ...blocks];
    // p15-chat-zip: the stored facts of the message's site uploads / "not a site" notes (as in `send`).
    blocks = [
      ...all.flatMap((x) => this.#siteZipBlocks(metaSiteUploads(x.meta), metaArchives(x.meta))),
      ...all.flatMap((x) => this.#inputBlocks(metaInputUploads(x.meta))),
      ...blocks,
    ];
    // p15-workflow-ai: the workflow blocks first (as in `send`).
    const titleAsk = await this.#titleBlock(threadId);
    blocks = [...workflowBlocks, ...(titleAsk === null ? [] : [titleAsk]), ...blocks];
    return this.#extras(atts, blocks, workerId);
  }

  /** p22-chat-queue: the earlier messages of the batch `last` closes (`meta.queuedWith`), in order; empty: not a batch. */
  async #batchOf(threadId: string, last: MessageView): Promise<MessageView[]> {
    const ids = Array.isArray(last.meta?.queuedWith)
      ? (last.meta.queuedWith as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 50)
      : [];
    const out: MessageView[] = [];
    for (const id of ids) {
      const m = await this.deps.store.message(threadId, id);
      if (m?.role === 'user' && m.supersededAt === undefined && m.seq < last.seq) out.push(m);
    }
    return out.sort((x, y) => x.seq - y.seq);
  }

  /** p17-chat-github: the turn's request to name the conversation, when its title is still a placeholder. */
  async #titleBlock(threadId: string): Promise<string | null> {
    try {
      const st = await this.deps.store.titleState(threadId);
      if (st === null) return null;
      const ask = titleAsk(st.source, st.exchanged);
      return ask === null ? null : titleBlock(ask, st.title);
    } catch (err) {
      this.deps.log.debug({ err, threadId }, 'chat title state not read');
      return null;
    }
  }

  /**
   * p17-chat-github: the assistant named the conversation (`set_chat_title`) — stored only while the title is a
   * placeholder / provisional one (never over a title a person set, at most once after the placeholder); the open
   * console updates through the thread event and the thread shows a short notice (not model-visible: role `error`
   * rows never reach the history).
   */
  async applyAutoTitle(
    userId: string,
    threadId: string,
    raw: unknown,
    turnId?: string,
  ): Promise<{ changed: boolean; title: string | null }> {
    const title = normalizeChatTitle(raw);
    if (title === null) return { changed: false, title: null };
    const before = await this.deps.store.titleState(threadId);
    const thread = await this.deps.store.applyAutoTitle(threadId, userId, title);
    if (thread === null) return { changed: false, title: before?.title ?? null };
    this.deps.streams.publish(threadId, 'thread', thread);
    if (before !== null && before.title !== thread.title) {
      try {
        const note = await this.deps.store.addMessage(threadId, {
          role: 'error',
          content: `Conversation renamed: “${thread.title}”`,
          meta: { notice: 'chat-title', title: thread.title, from: before.title },
          ...(turnId === undefined ? {} : { turnId }),
        });
        this.deps.streams.publish(threadId, 'message', note);
      } catch (err) {
        this.deps.log.debug({ err, threadId }, 'chat title notice not recorded');
      }
    }
    return { changed: true, title: thread.title };
  }

  /** p16-zip-job-input: the fenced, redacted blocks of a message's input bundles. */
  #inputBlocks(uploads: readonly ChatInputUploadFacts[]): string[] {
    return inputBundleBlocks(uploads).map((b) => this.#redactor.redact(b));
  }

  /** p15-chat-zip: the fenced, redacted blocks of a message's site uploads and "not a site" notes. */
  #siteZipBlocks(uploads: readonly ChatSiteUploadFacts[], archives: readonly ChatArchiveNote[]): string[] {
    return siteZipBlocks(uploads, archives).map((b) => this.#redactor.redact(b));
  }

  /**
   * p17-chat-flow: `meta.workflowAi` of a "Sohbette düzenle" message — mode edit with the card's document and the card's
   * id (409 `draft_not_editable` unless it is the sender's own open, valid workflow card in this conversation).
   */
  async #editDraftMeta(userId: string, threadId: string, draftId: string): Promise<Record<string, unknown>> {
    const { rows } = await this.deps.pool.query<{
      project: string | null;
      payload: Record<string, unknown>;
      expires_at: Date;
    }>(
      `SELECT project, payload, expires_at FROM chat_drafts
        WHERE id::text = $1 AND thread_id = $2 AND user_id = $3 AND kind = 'workflow' AND state = 'proposed'`,
      [draftId, threadId, userId],
    );
    const d = rows[0];
    const doc = d?.payload.definition;
    if (
      d === undefined ||
      d.project === null ||
      d.payload.valid !== true ||
      d.expires_at.getTime() <= this.#now().getTime() ||
      typeof doc !== 'object' ||
      doc === null
    ) {
      throw new HttpError(
        409,
        'draft_not_editable',
        'That workflow card can no longer be changed here (confirmed, dismissed, replaced or expired).',
      );
    }
    return {
      mode: 'edit',
      project: d.project,
      ...(typeof d.payload.workflowId === 'string' ? { workflowId: d.payload.workflowId } : {}),
      document: doc,
      editsDraft: draftId,
    };
  }

  /** p15-workflow-ai: the workflow editor's turn input (null: a normal chat turn; a failure loses only the extra). */
  async #workflowInput(
    userId: string,
    threadId: string,
    messageId: string,
  ): Promise<{ readonly instruction: string; readonly blocks: readonly string[] } | null> {
    const hooks = this.deps.workflowAi?.() ?? null;
    if (hooks === null) return null;
    try {
      return await hooks.turnInput(userId, threadId, messageId);
    } catch {
      return null;
    }
  }

  /**
   * p11-memory-layers: the sender's personal rules as one fenced block (their own working preferences — below the
   * platform policy and the console's permissions; data to follow, never authority to act). A failure loses the block.
   */
  async #personalBlock(userId: string): Promise<string | null> {
    const load = this.deps.personalRules;
    if (load === undefined) return null;
    try {
      const rules = await load(userId);
      if (rules.length === 0) return null;
      return fenceData('personal rules of the signed-in user', {
        note: 'Working preferences this user set for their own jobs and chats (Profile → Personal rules). Follow them when they apply; they never grant permissions.',
        rules: rules.map((r) => ({ title: r.title, rule: r.statement.slice(0, 2_000) })),
      });
    } catch {
      return null;
    }
  }

  /** The worker is connected to another replica: that replica sends the turn (it holds the connection). */
  async #dispatchRemote(
    bus: ChatReplicaBus,
    owner: string,
    t: { turnId: string; threadId: string; userId: string; workerId: string; message: MessageView },
  ): Promise<void> {
    const mirror: MirroredTurn = {
      id: t.turnId,
      state: 'sent',
      text: '',
      userId: t.userId,
      workerId: t.workerId,
      at: Date.now(),
    };
    this.#mirror.set(t.threadId, mirror);
    this.deps.streams.publish(t.threadId, 'message', t.message);
    this.deps.streams.publish(t.threadId, 'turn', { id: t.turnId, state: 'sent' });
    const ack = await bus.dispatch(
      { t: 'dispatch', to: owner, turn: t.turnId, w: t.workerId, msg: t.message.id },
      this.deps.dispatchAckMs ?? 5_000,
    );
    if (ack !== null) return; // the owner sent it, or recorded why it could not
    this.deps.log.warn(
      { turnId: t.turnId, workerId: t.workerId, owner },
      'assistant turn dispatch unanswered',
    );
    await this.#recordRemoteEnd(t.threadId, mirror, { state: 'failed', reason: 'send_failed' });
  }

  /** Records the end of a turn this replica does not run (its owner did not answer). */
  async #recordRemoteEnd(
    threadId: string,
    m: MirroredTurn,
    end: { state: 'failed' | 'cancelled'; reason: string },
  ): Promise<void> {
    if (this.#mirror.get(threadId) === m) this.#mirror.delete(threadId);
    const { rows } = await this.deps.pool.query<{ user_id: string; worker_id: string }>(
      'SELECT user_id::text AS user_id, worker_id FROM chat_turns WHERE id = $1',
      [m.id],
    );
    const row = rows[0];
    if (row === undefined) return;
    await this.#record(
      {
        id: m.id,
        threadId,
        userId: m.userId ?? row.user_id,
        workerId: m.workerId ?? row.worker_id,
        connectionId: null,
        text: m.text,
        lastSeq: 0,
        toolCalls: 0,
        actions: 0,
        byUser: false,
        attachmentIds: new Set(),
        state: 'sent',
        startedAt: m.at,
        lastUpdateAt: m.at,
      },
      end,
    );
  }

  // ----------------------------------------------------------------------------------- other replicas

  #onBus(m: ChatBusMessage, origin: string): void {
    switch (m.t) {
      case 'event':
        this.#onRemoteEvent(m.th, m.ev, m.d);
        return;
      case 'dispatch':
        void this.#acceptDispatch(m, origin).catch((err: unknown) => {
          this.deps.log.error({ err, turnId: m.turn }, 'dispatched assistant turn failed');
        });
        return;
      case 'cancel': {
        const t = this.#turns.get(m.turn);
        if (t !== undefined) void this.#cancelTurn(t, m.reason.slice(0, 200));
        return;
      }
      case 'cancel_all':
        void this.#cancelLocal(m.reason.slice(0, 200));
        return;
      default:
        return;
    }
  }

  /** A stream event from another replica: to the views open here, and into the mirror of running turns. */
  #onRemoteEvent(threadId: string, ev: ChatEventName, data: unknown): void {
    if (typeof threadId !== 'string') return;
    const d = (data ?? {}) as { id?: unknown; turnId?: unknown; state?: unknown; text?: unknown };
    const m = this.#mirror.get(threadId);
    if (ev === 'turn' && typeof d.id === 'string' && !this.#turns.has(d.id)) {
      const state = typeof d.state === 'string' ? d.state : 'running';
      if (m?.id === d.id) {
        m.state = state;
        m.at = Date.now();
      } else {
        this.#mirror.set(threadId, {
          id: d.id,
          state,
          text: '',
          userId: null,
          workerId: null,
          at: Date.now(),
        });
      }
    } else if (ev === 'delta' && m !== undefined && m.id === d.turnId && typeof d.text === 'string') {
      if (m.text.length + d.text.length <= MAX_TURN_TEXT) m.text += d.text;
      m.at = Date.now();
    } else if ((ev === 'done' || ev === 'error') && m !== undefined && m.id === d.turnId) {
      this.#mirror.delete(threadId);
    }
    this.deps.streams.deliver(threadId, ev, data);
  }

  /** Owner side of a dispatch: reload the turn and its message, sign and send, acknowledge. */
  async #acceptDispatch(m: Extract<ChatBusMessage, { t: 'dispatch' }>, origin: string): Promise<void> {
    const bus = this.deps.bus;
    const ack = (ok: boolean): void => {
      bus?.publish({ t: 'ack', to: origin, turn: m.turn, ok });
    };
    const session = this.deps.session(m.w);
    if (session === undefined) return; // not ours (any more): the dispatcher times out
    const { rows } = await this.deps.pool.query<{
      thread_id: string | null;
      user_id: string;
      worker_id: string;
      runtime: string;
      model: string | null;
      state: string;
      rerun_of: string | null;
      origin: TurnOrigin | null;
    }>(
      `SELECT thread_id::text AS thread_id, user_id::text AS user_id, worker_id, runtime, model, state,
              rerun_of::text AS rerun_of, origin
         FROM chat_turns WHERE id = $1`,
      [m.turn],
    );
    const row = rows[0];
    if (row?.thread_id === null || row === undefined || row.state !== 'sent' || row.worker_id !== m.w) {
      ack(false);
      return;
    }
    const runtime = AssistantRuntime.safeParse(row.runtime);
    if (!runtime.success) {
      ack(false);
      return;
    }
    const sent = await this.#sendStoredTurn({
      turnId: m.turn,
      threadId: row.thread_id,
      userId: row.user_id,
      workerId: m.w,
      runtime: runtime.data,
      model: row.model,
      messageId: m.msg,
      session,
      rerunOf: row.rerun_of ?? undefined,
      origin: row.origin ?? undefined,
      onSent: () => {
        ack(true);
      },
    });
    if (sent !== 'sent') ack(false);
  }

  /**
   * Sends a turn for a user message that is already stored (another replica's dispatch, or p11-usage-limit-fallback:
   * the same message again on the fallback engine): reload the message, its extras and the history before it.
   */
  async #sendStoredTurn(t: {
    readonly turnId: string;
    readonly threadId: string;
    readonly userId: string;
    readonly workerId: string;
    readonly runtime: AssistantRuntime;
    readonly model: string | null;
    readonly messageId: string;
    readonly session: WorkerSession;
    readonly onSent?: () => void;
    /** p13-runtime-accounts: the account (absent: what the status says now). */
    readonly account?: string | null;
    /** p15-autonomy: the sender's step-up (the same replica's fallback turn keeps it; a dispatch has none). */
    readonly human?: TurnHuman | undefined;
    /** p15-chat-failover: the lost turn this message was already re-run for. */
    readonly rerunOf?: string | undefined;
    /** p16-chat-complete: why the turn was started. */
    readonly origin?: TurnOrigin | undefined;
  }): Promise<'sent' | 'missing' | 'failed'> {
    // p15-chat-failover: the account the route chose for this machine (another machine's account is not this one's).
    const account =
      t.account === undefined
        ? await this.#route().then((r) =>
            r.chosen?.workerId === t.workerId ? (r.chosen.plan?.account ?? null) : null,
          )
        : t.account;
    const threadId = t.threadId;
    // p16-chat-complete: only current rows reach the model (an edit / regenerate superseded the rest).
    const messages = await this.deps.store.messages(threadId, {
      limit: MAX_HISTORY_MESSAGES + 4,
      current: true,
    });
    const stored = await this.deps.store.message(threadId, t.messageId);
    const user = stored?.role === 'user' && stored.supersededAt === undefined ? stored : undefined;
    if (user === undefined) return 'missing';
    // p22-chat-queue: the messages that waited together are one turn — the earlier ones of the batch lead its input.
    const batch = await this.#batchOf(threadId, user);
    const firstSeq = batch[0]?.seq ?? user.seq;
    if (this.#mirror.get(threadId)?.id === t.turnId) this.#mirror.delete(threadId);
    const wf = await this.#workflowInput(t.userId, threadId, user.id);
    // p18-plan-mode: plan mode and the plan block, read again now (a dispatched or re-run turn).
    const pin = (await this.deps.plans?.()?.turnInput(threadId)) ?? null;
    // p18-multi-project W3: the working projects block, read again now.
    const projectsBlock = await this.#projectsBlock(t.userId, threadId, t.workerId);
    const autonomy = await this.#autonomyBlock({
      userId: t.userId,
      threadId,
      workerId: t.workerId,
      byUser: user.meta?.origin === 'user',
      planId: user.meta?.origin === 'user' ? undefined : (planTurnOf(user.meta) ?? undefined),
      followUp: followUpOf(user.meta) !== null,
      human: t.human,
    });
    const extras = await this.#extrasOf(
      t.userId,
      user,
      threadId,
      [
        ...(wf?.blocks ?? []),
        ...(pin?.blocks ?? []),
        ...(projectsBlock === null ? [] : [projectsBlock]),
        ...(autonomy === null ? [] : [autonomy]),
      ],
      t.workerId,
      batch,
    );
    // The last message's own file names (a batch's turn carries the files of every message of it).
    const ownFiles = batch.length === 0 ? extras.attachments : metaFileNames(user.meta);
    const turn: ActiveTurn = {
      id: t.turnId,
      threadId,
      userId: t.userId,
      workerId: t.workerId,
      connectionId: t.session.connectionId,
      instanceId: t.session.instanceId ?? null,
      text: '',
      lastSeq: 0,
      toolCalls: 0,
      actions: 0,
      attachmentIds: new Set(extras.attachments.map((a) => a.id)),
      state: 'sent',
      startedAt: Date.now(),
      lastUpdateAt: Date.now(),
      runtime: t.runtime,
      account,
      messageId: user.id,
      byUser: user.meta?.origin === 'user',
      planMode: pin?.planMode === true,
      ...(user.meta?.origin === 'user' ? {} : { planTurn: planTurnOf(user.meta) ?? undefined }),
      ...(followUpOf(user.meta) === null ? {} : { followUp: followUpOf(user.meta) ?? undefined }),
      ...(lateResultOf(user.meta) === undefined ? {} : { lateResult: lateResultOf(user.meta) }),
      ...(t.human === undefined ? {} : { human: t.human }),
      ...(t.rerunOf === undefined ? {} : { rerunOf: t.rerunOf }),
      ...(t.origin === undefined ? {} : { origin: t.origin }),
      model: t.model,
    };
    this.#turns.set(turn.id, turn);
    this.#byThread.set(threadId, turn.id);
    const now = this.#now();
    const body: Omit<AssistantTurnPayload, 'signature'> = {
      turnId: turn.id,
      sessionKey: threadId,
      runtime: t.runtime,
      ...(t.model === null ? {} : { model: t.model }),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + TURN_TTL_MS).toISOString(),
      message: planWrap(
        pin,
        wf === null
          ? batchText(batch, modelText(user.content, [...ownFiles, ...zipNamesOf(user.meta)]))
          : composeMessage(
              wf.instruction,
              batchText(batch, modelText(user.content, [...ownFiles, ...zipNamesOf(user.meta)])),
            ),
      ),
      history: this.#historyOf(messages.filter((x) => x.seq < firstSeq).slice(-MAX_HISTORY_MESSAGES)),
      ...(extras.attachments.length === 0 ? {} : { attachments: extras.attachments }),
      ...(extras.context === null ? {} : { context: extras.context }),
      ...(account === null ? {} : { account }),
    };
    fitFrame(body);
    try {
      await this.deps.store.setRunner(turn.id, this.#runner);
      const traceparent = this.deps.observe?.started(turn.id, { runtime: t.runtime, workerId: t.workerId });
      await t.session.send(
        'ASSISTANT_TURN',
        { ...body, signature: this.deps.signer.signAssistantTurn({ workerId: t.workerId, turn: body }) },
        traceparent === undefined ? undefined : { traceparent },
      );
      t.onSent?.();
      return 'sent';
    } catch (err) {
      this.deps.log.warn(
        { err, turnId: turn.id, workerId: t.workerId },
        'dispatched assistant turn could not be sent',
      );
      await this.#lost(turn, 'send_failed');
      return 'failed';
    }
  }

  /**
   * Answers the same stored user message again as a new turn on the machine / engine / account `route` chose:
   * p11-usage-limit-fallback (the engine hit its usage limit — fallback account, fallback engine, or since
   * p15-chat-failover another machine) and p15-chat-failover's re-run of a turn lost with its machine. Nothing is lost:
   * the message was stored before the first turn; when nothing can take it, the error line already says why.
   */
  async #continueTurn(
    prev: ActiveTurn,
    route: Route,
    why: { readonly kind: 'limit' } | { readonly kind: 'rerun'; readonly cause: string },
  ): Promise<void> {
    const chosen = route.chosen;
    if (prev.messageId === undefined || chosen?.plan == null) return;
    const plan = chosen.plan;
    const workerId = chosen.workerId;
    const turnId = randomUUID();
    // Once per message: a re-run marks the turn; a later usage-limit continuation keeps the mark.
    const rerunOf = why.kind === 'rerun' ? prev.id : prev.rerunOf;
    // p16-chat-complete: a restart re-run is labelled; a continuation keeps the turn's own origin.
    const origin: TurnOrigin | undefined =
      why.kind === 'rerun' && why.cause === 'restart' ? 'restart' : prev.origin;
    await this.deps.store.createTurn({
      id: turnId,
      threadId: prev.threadId,
      userId: prev.userId,
      workerId,
      runtime: plan.runtime,
      model: plan.model ?? undefined,
      messageId: prev.messageId,
      ...(rerunOf === undefined ? {} : { rerunOf }),
      ...(origin === undefined ? {} : { origin }),
    });
    if (why.kind === 'limit') {
      await this.deps.audit
        .record({
          actor: { type: 'system', id: 'chat' },
          action: 'chat.engine.fallback',
          target: `chat-turn:${turnId}`,
          outcome: 'success',
          metadata: {
            from: prev.runtime ?? null,
            to: plan.runtime,
            ...(prev.account === undefined ? {} : { fromAccount: prev.account ?? 'default' }),
            ...(plan.account === null ? {} : { toAccount: plan.account }),
            previousTurn: prev.id,
            workerId,
            ...(workerId === prev.workerId ? {} : { fromWorkerId: prev.workerId }),
          },
        })
        .catch(() => undefined);
    } else if (why.cause !== 'restart') {
      await this.deps.failover
        ?.rerun({ from: prev.workerId, to: workerId, cause: why.cause, lostTurn: prev.id, turn: turnId })
        .catch((err: unknown) => {
          this.deps.log.warn({ err, turnId }, 'chat failover re-run not recorded');
        });
    }
    await this.#commit(route);
    if (origin === 'restart' && prev.origin !== 'restart') {
      const name = route.chain.find((c) => c.workerId === workerId)?.name ?? chosen.name;
      await this.#postNotice(prev.threadId, { cause: 'restart', from: name, to: chosen.name }, turnId);
    } else if (workerId !== prev.workerId) {
      const from =
        route.chain.find((c) => c.workerId === prev.workerId)?.name ?? (await this.#nameOf(prev.workerId));
      await this.#postNotice(
        prev.threadId,
        why.kind === 'rerun'
          ? { cause: 'rerun', from, to: chosen.name }
          : ((await this.#machineNotice(prev.threadId, route, prev.workerId)) ?? null),
        turnId,
      );
    }
    const session = this.deps.session(workerId);
    const owner = session === undefined ? (this.deps.bus?.ownerOf(workerId) ?? null) : null;
    if (session === undefined && owner !== null && this.deps.bus !== undefined) {
      const messages = await this.deps.store.messages(prev.threadId, { limit: MAX_HISTORY_MESSAGES + 4 });
      const message = messages.find((x) => x.id === prev.messageId);
      if (message !== undefined) {
        await this.#dispatchRemote(this.deps.bus, owner, {
          turnId,
          threadId: prev.threadId,
          userId: prev.userId,
          workerId,
          message,
        });
      }
      return;
    }
    if (session === undefined) {
      await this.deps.store.finishTurn(turnId, { state: 'failed', reason: 'send_failed' });
      return;
    }
    this.deps.streams.publish(prev.threadId, 'turn', { id: turnId, state: 'sent' });
    const sent = await this.#sendStoredTurn({
      turnId,
      threadId: prev.threadId,
      userId: prev.userId,
      workerId,
      runtime: plan.runtime,
      model: plan.model,
      messageId: prev.messageId,
      session,
      account: plan.account,
      ...(prev.human === undefined ? {} : { human: prev.human }),
      ...(rerunOf === undefined ? {} : { rerunOf }),
      ...(origin === undefined ? {} : { origin }),
    });
    if (sent === 'missing') await this.deps.store.finishTurn(turnId, { state: 'failed', reason: 'lost' });
  }

  /**
   * p15-chat-failover (design §5): a turn that cannot finish on its machine (disconnected, could not be sent, silent,
   * refused by the machine). It is answered once more on the next eligible machine when it did nothing but read; a turn
   * that may have acted (a non-read tool call) or was already re-run ends with a line that says so.
   */
  async #lost(t: ActiveTurn, reason: string): Promise<void> {
    if (this.#turns.get(t.id) !== t) return;
    const canRerun = t.messageId !== undefined && t.rerunOf === undefined && t.actions === 0;
    let route: Route | null = null;
    if (canRerun) {
      route = await this.#route({ exclude: new Set([t.workerId]) }).catch((err: unknown) => {
        this.deps.log.warn({ err, turnId: t.id }, 'chat failover routing failed');
        return null;
      });
      if (route?.chosen == null || route.chosen.workerId === t.workerId) route = null;
    }
    if (route === null || route.chosen === null) {
      const n = t.actions;
      await this.#finish(t, {
        state: 'failed',
        reason,
        ...(n > 0
          ? {
              detail: `It had already acted (${String(n)} ${n === 1 ? 'tool call' : 'tool calls'}), so the answer is not repeated automatically — check the results above before sending your message again.`,
            }
          : {}),
      });
      return;
    }
    // The partial answer is not kept: the next machine answers the whole message.
    t.text = '';
    await this.#finish(t, {
      state: 'failed',
      reason,
      detail: `Continuing on ${route.chosen.name} — your message is answered there.`,
      continues: true,
    });
    await this.#continueTurn(t, route, { kind: 'rerun', cause: reason }).catch((err: unknown) => {
      this.deps.log.warn({ err, turnId: t.id }, 'assistant turn re-run could not start');
    });
    // p22-chat-queue: a no-op while the re-run runs (its end delivers); delivers when it could not start.
    this.#drainSoon(t.threadId);
  }

  /** p15-chat-failover: records a switch of the answering machine (never fails a turn). */
  async #commit(route: Route): Promise<void> {
    const store = this.deps.failover;
    const chosen = route.chosen;
    if (store === undefined || chosen === null || route.reason === null) return;
    const prev = route.state.active?.workerId ?? null;
    if (prev === chosen.workerId) return;
    const prevEval = prev === null ? undefined : route.chain.find((c) => c.workerId === prev);
    await store
      .commit({
        from: prev,
        to: chosen.workerId,
        toRole: chosen.role,
        fromRole: prevEval === undefined ? 'other' : prevEval.role,
        reason: route.reason,
        primaryIssue: route.chain[0]?.issue ?? null,
        notify: true,
      })
      .catch((err: unknown) => {
        this.deps.log.warn({ err }, 'chat failover switch not recorded');
      });
  }

  async #nameOf(workerId: string): Promise<string> {
    const { rows } = await this.deps.pool.query<{ display_name: string }>(
      'SELECT display_name FROM workers WHERE id = $1',
      [workerId],
    );
    return rows[0]?.display_name ?? workerId;
  }

  /**
   * p15-chat-failover (design §6): the thread notice when its answering machine changes — the turn goes to another
   * machine than the thread's previous turn and one of them is a backup (never on every turn). `last`: the machine of
   * the previous turn when known (default: read from the thread's turns).
   */
  async #machineNotice(threadId: string, route: Route, last?: string): Promise<MachineNotice | null> {
    const chosen = route.chosen;
    const primary = route.chain[0];
    if (chosen === null || primary === undefined) return null;
    let previous = last ?? null;
    if (last === undefined) {
      const { rows } = await this.deps.pool.query<{ worker_id: string }>(
        'SELECT worker_id FROM chat_turns WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1',
        [threadId],
      );
      previous = rows[0]?.worker_id ?? null;
    }
    if (previous === chosen.workerId) return null;
    if (chosen.role === 'primary') {
      // Back on the primary after a backup answered this thread.
      const was = route.chain.find((c) => c.workerId === previous);
      if (was?.role !== 'backup') return null;
      return { cause: 'returned', from: was.name, to: chosen.name };
    }
    const cause: MachineNotice['cause'] =
      route.reason === 'pinned'
        ? 'pinned'
        : route.reason === 'primary_offline'
          ? 'primary_offline'
          : route.reason === 'primary_unstable'
            ? 'primary_unstable'
            : 'primary_unavailable';
    return { cause, from: primary.name, to: chosen.name };
  }

  async #postNotice(threadId: string, n: MachineNotice | null, turnId: string): Promise<void> {
    if (n === null) return;
    const text: Record<MachineNotice['cause'], string> = {
      primary_offline: `${n.from} is not connected; the answer comes from ${n.to}.`,
      primary_unavailable: `${n.from} cannot answer right now; the answer comes from ${n.to}.`,
      primary_unstable: `${n.from} has just reconnected; ${n.to} keeps answering until it is stable.`,
      pinned: `The answer comes from ${n.to} (chosen by an administrator).`,
      returned: `The answer comes from ${n.to} again.`,
      rerun: `${n.from} was lost while answering; the answer comes from ${n.to}.`,
      restart: 'The master restarted while the assistant was answering; your message is answered again.',
    };
    try {
      const message = await this.deps.store.addMessage(threadId, {
        role: 'error',
        content: text[n.cause],
        meta: { notice: 'chat-failover', reason: null, cause: n.cause, from: n.from, to: n.to },
        turnId,
      });
      this.deps.streams.publish(threadId, 'message', message);
    } catch (err) {
      this.deps.log.debug({ err, threadId }, 'chat failover notice not recorded');
    }
  }

  async #limit(userId: string, s: ChatSettings): Promise<void> {
    const hit = await this.deps.limiter.hit('chat-turns', userId, s.limits.turnsPerUserPer10Min, 10 * 60_000);
    if (!hit.allowed) {
      throw new HttpError(
        429,
        'rate_limited',
        'Too many chat messages; try again in a few minutes.',
        {
          'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)),
        },
        {},
        { reason: 'chat_messages' },
      );
    }
    const now = this.#now();
    const day = utcDayStart(now);
    if (s.limits.userDailyTokens !== null) {
      const u = await this.deps.store.usageSince(day, userId);
      if (u.inputTokens + u.outputTokens >= s.limits.userDailyTokens) {
        throw new HttpError(
          429,
          'budget_exceeded',
          'Your daily chat token budget is used up; it resets at 00:00 UTC.',
          {},
          {},
          { reason: 'user_daily' },
        );
      }
    }
    if (s.limits.dailyTokens !== null) {
      const u = await this.deps.store.usageSince(day);
      if (u.inputTokens + u.outputTokens >= s.limits.dailyTokens) {
        throw new HttpError(
          429,
          'budget_exceeded',
          'The daily chat token budget is used up; it resets at 00:00 UTC.',
        );
      }
    }
    if (s.limits.monthlyCostUsd !== null) {
      const u = await this.deps.store.usageSince(utcMonthStart(now));
      if (u.costUsd >= s.limits.monthlyCostUsd) {
        throw new HttpError(
          429,
          'budget_exceeded',
          'The monthly chat cost budget is used up.',
          {},
          {},
          { reason: 'monthly_cost' },
        );
      }
    }
  }

  /** The thread so far as fenced data (the assistant treats it as context, not as instructions). */
  async #history(threadId: string): Promise<string> {
    return this.#historyOf(
      await this.deps.store.messages(threadId, { limit: MAX_HISTORY_MESSAGES, current: true }),
    );
  }

  #historyOf(messages: readonly MessageView[]): string {
    const items = messages
      .filter((m) => m.role !== 'error' && m.supersededAt === undefined)
      .map((m) => {
        const text =
          m.content.length > MAX_HISTORY_ITEM ? `${m.content.slice(0, MAX_HISTORY_ITEM)}…` : m.content;
        const notes = m.role === 'user' ? inputNotes(m.meta) : '';
        return { role: m.role, text: notes === '' ? text : `${text}${text === '' ? '' : ' '}${notes}` };
      });
    if (items.length === 0) return '';
    let fenced = fenceData('conversation so far', items);
    while (fenced.length > MAX_ASSISTANT_HISTORY - 1024 && items.length > 1) {
      items.shift();
      fenced = fenceData('conversation so far (older messages omitted)', items);
    }
    return fenced.length > MAX_ASSISTANT_HISTORY ? '' : fenced;
  }

  async cancel(userId: string, threadId: string): Promise<void> {
    await this.deps.store.thread(userId, threadId);
    const id = this.#byThread.get(threadId);
    const t = id === undefined ? undefined : this.#turns.get(id);
    if (t !== undefined) {
      await this.#cancelTurn(t, 'user stopped');
      return;
    }
    const m = this.#mirrored(threadId);
    const bus = this.deps.bus;
    if (m === undefined || bus === undefined)
      throw new HttpError(409, 'no_turn', 'The assistant is not answering in this conversation.');
    // Running on another replica: its owner stops it; if nobody does, the turn ends here.
    bus.publish({ t: 'cancel', turn: m.id, reason: 'user stopped' });
    setTimeout(() => {
      void this.#recordRemoteEnd(threadId, m, { state: 'cancelled', reason: 'cancelled' }).catch(
        (err: unknown) => {
          this.deps.log.debug({ err, turnId: m.id }, 'remote turn end not recorded');
        },
      );
    }, 12_000).unref();
  }

  async #cancelTurn(t: ActiveTurn, reason: string): Promise<void> {
    await this.#sendCancel(t, reason);
    // The worker confirms with `failed: cancelled`; if it cannot, the turn ends here.
    setTimeout(() => {
      if (this.#turns.get(t.id) === t) void this.#finish(t, { state: 'cancelled', reason: 'cancelled' });
    }, 10_000).unref();
  }

  async #sendCancel(t: ActiveTurn, reason: string): Promise<void> {
    await this.deps
      .session(t.workerId)
      ?.send('ASSISTANT_CANCEL', { turnId: t.id, reason })
      .catch(() => undefined);
  }

  /** Kill switch: every running turn is stopped (on every replica). */
  async cancelAll(reason: string): Promise<void> {
    this.deps.bus?.publish({ t: 'cancel_all', reason });
    await this.#cancelLocal(reason);
  }

  async #cancelLocal(reason: string): Promise<void> {
    for (const t of [...this.#turns.values()]) {
      await this.#sendCancel(t, reason);
      await this.#finish(t, { state: 'cancelled', reason: 'cancelled' });
    }
  }

  // --------------------------------------------------------------------------------- worker messages

  /** CAPABILITIES.assistant. */
  async onReport(session: WorkerSession, report: AssistantReport | undefined): Promise<void> {
    this.deps.bus?.announce();
    if (report === undefined) return;
    await this.deps.pool.query('UPDATE workers SET assistant = $2, assistant_at = $3 WHERE id = $1', [
      session.workerId,
      JSON.stringify(report),
      this.#now(),
    ]);
  }

  /** ASSISTANT_UPDATE: only for turns this master sent to this worker; ordered by seq; never throws. */
  async onUpdate(session: WorkerSession, u: AssistantUpdatePayload): Promise<void> {
    try {
      const t = this.#turns.get(u.turnId);
      if (t?.workerId !== session.workerId) {
        this.deps.log.warn(
          { workerId: session.workerId, turnId: u.turnId, kind: u.kind },
          'ASSISTANT_UPDATE for an unknown turn',
        );
        return;
      }
      if (u.seq <= t.lastSeq) return;
      t.lastSeq = u.seq;
      t.lastUpdateAt = Date.now();
      switch (u.kind) {
        case 'accepted':
          t.state = 'running';
          await this.deps.store.markRunning(t.id);
          this.deps.streams.publish(t.threadId, 'turn', { id: t.id, state: 'running', fresh: u.fresh });
          return;
        case 'delta': {
          const text = this.#redactor.redact(u.text);
          if (t.text.length + text.length <= MAX_TURN_TEXT) t.text += text;
          this.deps.streams.publish(t.threadId, 'delta', { turnId: t.id, text });
          return;
        }
        case 'tool_call':
          // p15-chat-failover: a call that may act (anything but a read) makes the turn not re-runnable.
          if ((ASSISTANT_TOOLS as Record<string, { kind: string } | undefined>)[u.tool]?.kind !== 'read') {
            t.actions += 1;
            // p16-chat-complete: persisted before the call runs (a restart and every replica see it).
            await this.deps.store.countAction(t.id).catch((err: unknown) => {
              this.deps.log.warn({ err, turnId: t.id }, 'chat turn action not counted');
            });
          }
          // In the background: a slow tool must not hold up this worker's message chain.
          // p22-slow-tools: one that outlives the worker's tool timeout is answered "still running" first.
          {
            const slow = setTimeout(() => {
              void this.#stillRunning(session, t, u.tool, u.callId).catch(() => undefined);
            }, this.deps.slowToolMs ?? SLOW_TOOL_MS);
            slow.unref();
            void this.#toolCall(session, t, u)
              .catch(async (err: unknown) => {
                this.deps.log.error({ err, turnId: t.id, tool: u.tool }, 'assistant tool call failed');
                // p19-tool-crash: the model still gets an answer (the turn would otherwise wait for the worker's tool
                // timeout and the user would see it hang).
                const content = `${u.tool} failed on the platform (internal error); tell the user it did not run and do not retry it in this turn.`;
                if (t.late?.has(u.callId) === true)
                  await this.#handBack(t, u.tool, content).catch(() => undefined);
                else
                  await this.#sendResult(session, t, {
                    turnId: t.id,
                    callId: u.callId,
                    isError: true,
                    content,
                  }).catch(() => undefined);
              })
              .finally(() => {
                clearTimeout(slow);
              });
          }
          return;
        case 'done':
          await this.#finish(t, { state: 'done', text: this.#redactor.redact(u.text), usage: u.usage });
          return;
        case 'failed':
          if (u.reason === 'provider_usage_limit') {
            await this.#usageLimited(t, u);
            return;
          }
          if (MACHINE_FAILURES.has(u.reason)) {
            await this.#lost(t, u.reason);
            return;
          }
          await this.#finish(t, {
            state: u.reason === 'cancelled' ? 'cancelled' : 'failed',
            reason: u.reason,
            ...(u.detail === undefined ? {} : { detail: this.#redactor.redact(u.detail) }),
            ...(u.usage === undefined ? {} : { usage: u.usage }),
          });
          return;
        case 'refused':
          if (MACHINE_FAILURES.has(`refused_${u.reason}`)) {
            await this.#lost(t, `refused_${u.reason}`);
            return;
          }
          await this.#finish(t, { state: 'failed', reason: `refused_${u.reason}` });
          return;
      }
    } catch (err) {
      this.deps.log.error({ err, turnId: u.turnId }, 'assistant update handling failed');
    }
  }

  /**
   * p11-usage-limit-fallback: the engine stopped at its usage limit. The limit is remembered until it resets (the status
   * then routes turns to the fallback engine, or says when the assistant works again); the chat gets one clear line; and,
   * when a fallback engine can take over, the same user message is answered there.
   */
  async #usageLimited(t: ActiveTurn, u: Extract<AssistantUpdatePayload, { kind: 'failed' }>): Promise<void> {
    const s = await this.deps.settings.get();
    const runtime = t.runtime ?? s.runtime;
    const resetAt = u.resetAt === undefined ? null : new Date(u.resetAt);
    const until = await this.#recordEngineLimit(
      runtime,
      t.workerId,
      resetAt !== null && Number.isFinite(resetAt.getTime()) ? resetAt : null,
      u.detail === undefined ? undefined : this.#redactor.redact(u.detail),
      t.account ?? 'default',
    );
    // p15-chat-failover: the chain is asked again — the same machine's fallback account / engine first, then the next
    // machine that can answer.
    const route = await this.#route();
    const label = ASSISTANT_RUNTIME_LABELS[runtime];
    const plan = route.chosen?.plan ?? null;
    const otherMachine = route.chosen !== null && route.chosen.workerId !== t.workerId;
    // p13-runtime-accounts: the same engine with its fallback account counts as a fallback too.
    const moved =
      plan !== null &&
      route.chosen !== null &&
      (otherMachine || plan.runtime !== runtime || plan.account !== (t.account ?? null));
    const detail = `${label} reached its usage limit; it works again at ${until.toISOString()}.${
      moved
        ? otherMachine
          ? ` Continuing on ${route.chosen.name} — your message is answered there.`
          : plan.runtime === runtime
            ? ` Continuing with another ${label} account — your message is answered there.`
            : ` Continuing with ${ASSISTANT_RUNTIME_LABELS[plan.runtime]} — your message is answered there.`
        : ' Your message is kept; send it again after that time (or an administrator sets a fallback engine in Settings → Chat).'
    }`;
    await this.#finish(t, {
      state: 'failed',
      reason: 'provider_usage_limit',
      detail,
      ...(u.usage === undefined ? {} : { usage: u.usage }),
      continues: moved,
    });
    if (moved) {
      await this.#continueTurn(t, route, { kind: 'limit' }).catch((err: unknown) => {
        this.deps.log.warn({ err, turnId: t.id }, 'assistant fallback engine turn could not start');
      });
      this.#drainSoon(t.threadId);
    }
  }

  /**
   * ASSISTANT_ATTACHMENT_REQUEST (p8-chat-attachments-mentions): one slice of an attachment, only for a turn this
   * master sent to this worker over this connection, still running, and only an attachment of that turn. Never
   * throws; the first slice is audited.
   */
  async onAttachmentRequest(session: WorkerSession, p: AssistantAttachmentRequestPayload): Promise<void> {
    const reply = (status: 'ok' | 'refused' | 'not_found', data = '', eof = true) =>
      session
        .send('ASSISTANT_ATTACHMENT_DATA', {
          turnId: p.turnId,
          requestId: p.requestId,
          attachmentId: p.attachmentId,
          status,
          offset: p.offset,
          data,
          eof,
        })
        .catch(() => undefined);
    try {
      const t = this.#turns.get(p.turnId);
      const allowed =
        t !== undefined &&
        t.workerId === session.workerId &&
        t.connectionId === session.connectionId &&
        t.attachmentIds.has(p.attachmentId);
      const a = this.deps.attachments;
      if (!allowed || a === undefined) {
        await this.deps.audit.record({
          actor: { type: 'worker', id: session.workerId },
          action: 'chat.attachment.read',
          target: `chat-turn:${p.turnId}`,
          outcome: 'denied',
          metadata: { attachmentId: p.attachmentId, offset: p.offset },
        });
        await reply('refused');
        return;
      }
      const slice = await a.slice(p.attachmentId, p.offset, ATTACHMENT_CHUNK_BYTES);
      if (slice === null) {
        await reply('not_found');
        return;
      }
      if (p.offset === 0) {
        await this.deps.audit.record({
          actor: { type: 'worker', id: session.workerId },
          action: 'chat.attachment.read',
          target: `chat-thread:${t.threadId}`,
          outcome: 'success',
          metadata: { attachmentId: p.attachmentId, turnId: p.turnId },
        });
      }
      t.lastUpdateAt = Date.now();
      await reply('ok', slice.data.toString('base64'), slice.eof);
    } catch (err) {
      this.deps.log.error({ err, turnId: p.turnId }, 'attachment request failed');
      await reply('refused');
    }
  }

  async #subject(userId: string): Promise<Subject | null> {
    const { rows } = await this.deps.pool.query<{ role: Role; disabled_at: Date | null }>(
      'SELECT role, disabled_at FROM users WHERE id = $1',
      [userId],
    );
    const u = rows[0];
    if (u === undefined || u.disabled_at !== null) return null;
    return loadSubject(this.deps.pool, { id: userId, role: u.role });
  }

  /** p16-workflow-quality: the zone the turn's user message carried (`meta.timeZone`), looked up once per turn. */
  async #turnZone(t: ActiveTurn): Promise<string | undefined> {
    if (t.timeZone !== undefined) return t.timeZone ?? undefined;
    if (t.messageId === undefined) return undefined;
    const { rows } = await this.deps.pool
      .query<{ tz: string | null }>(`SELECT meta->>'timeZone' AS tz FROM chat_messages WHERE id = $1`, [
        t.messageId,
      ])
      .catch(() => ({ rows: [] as { tz: string | null }[] }));
    const tz = rows[0]?.tz ?? null;
    t.timeZone = tz !== null && isValidTimeZone(tz) ? tz : null;
    return t.timeZone ?? undefined;
  }

  /**
   * p17-chat-github: `set_chat_title` — the conversation of the turn, for the user who sent it. p18-plan-mode:
   * `requested: true` — the person's own message (a turn they started, whose words ask for it) asked to
   * rename the conversation: renamed like a manual rename (any title, audited), except over a title they set by hand
   * since the turn started. Without a request the platform-block rules hold.
   */
  async #titleTool(t: ActiveTurn, input: unknown): Promise<ToolOutcome> {
    const parsed = assistantToolInput('set_chat_title').safeParse(input);
    if (!parsed.success)
      return { ok: false, code: 'invalid', message: 'title: one short line (1–120 characters).' };
    const data = parsed.data as { title: string; requested?: boolean };
    if (data.requested === true) return this.#requestedTitle(t, data.title);
    const out = await this.applyAutoTitle(t.userId, t.threadId, data.title, t.id);
    if (out.changed) return { ok: true, data: { renamed: true, title: out.title } };
    return {
      ok: true,
      data: {
        renamed: false,
        title: out.title,
        note: 'Not changed: the conversation already has its title (set by the user, or already named once), or the title was empty or looked like a secret. Do not try again. If the user asked to rename it, pass requested: true.',
      },
    };
  }

  async #requestedTitle(t: ActiveTurn, raw: string): Promise<ToolOutcome> {
    const refuse = (message: string): ToolOutcome => ({ ok: false, code: 'forbidden', message });
    if (!t.byUser || t.messageId === undefined)
      return refuse('Only the user can ask for a rename (this turn was not started by their message).');
    const msg = await this.deps.store.message(t.threadId, t.messageId).catch(() => null);
    if (msg?.role !== 'user' || !renameRequested(msg.content))
      return refuse(
        "The user's message does not ask to rename the conversation; rename only when they ask (they can also use the conversation menu).",
      );
    const title = normalizeChatTitle(raw);
    if (title === null)
      return {
        ok: false,
        code: 'invalid',
        message: 'The title is empty or looks like a secret; choose another.',
      };
    const before = await this.deps.store.titleState(t.threadId);
    const thread = await this.deps.store.applyRequestedTitle(t.threadId, t.userId, title, t.id);
    if (thread === null)
      return {
        ok: true,
        data: {
          renamed: false,
          title: before?.title ?? null,
          note: 'Not changed: the user renamed it by hand meanwhile (or the conversation is archived). Do not try again.',
        },
      };
    this.deps.streams.publish(t.threadId, 'thread', thread);
    await this.deps.audit
      .record({
        actor: { type: 'user', id: t.userId },
        action: 'chat.thread.rename',
        target: `chat-thread:${t.threadId}`,
        outcome: 'success',
        metadata: { via: 'chat', turnId: t.id, chars: thread.title.length },
      })
      .catch(() => undefined);
    if (before !== null && before.title !== thread.title) {
      try {
        const note = await this.deps.store.addMessage(t.threadId, {
          role: 'error',
          content: `Conversation renamed: “${thread.title}”`,
          meta: { notice: 'chat-title', title: thread.title, from: before.title },
          turnId: t.id,
        });
        this.deps.streams.publish(t.threadId, 'message', note);
      } catch (err) {
        this.deps.log.debug({ err, threadId: t.threadId }, 'chat title notice not recorded');
      }
    }
    return { ok: true, data: { renamed: true, title: thread.title } };
  }

  /** p15-chat-execute-default: whether the turn's assistant worker advertises `assistant-propose-v1` (once per turn). */
  async #proposeAware(t: ActiveTurn): Promise<boolean> {
    if (t.proposeAware !== undefined) return t.proposeAware;
    const { rows } = await this.deps.pool.query<{ features: unknown }>(
      'SELECT features FROM workers WHERE id = $1',
      [t.workerId],
    );
    t.proposeAware = features(rows[0]?.features).includes(ASSISTANT_PROPOSE_FEATURE);
    t.opsTools = features(rows[0]?.features).includes(ASSISTANT_OPS_TOOLS_FEATURE);
    return t.proposeAware;
  }

  /**
   * p19-autonomy-aware: the turn's "otonomi" block — whether its drafts run at once or stay cards, the code rule and
   * auto mode (direct.ts autonomyBlock). Never fails the turn.
   */
  async #autonomyBlock(i: {
    readonly userId: string;
    readonly threadId: string;
    readonly workerId: string;
    readonly byUser: boolean;
    readonly planId?: string | undefined;
    readonly followUp?: boolean | undefined;
    readonly human?: TurnHuman | undefined;
  }): Promise<string | null> {
    const direct = this.deps.direct?.() ?? null;
    if (direct === null) return null;
    try {
      const { rows } = await this.deps.pool.query<{ features: unknown }>(
        'SELECT features FROM workers WHERE id = $1',
        [i.workerId],
      );
      const plan =
        i.byUser || i.planId === undefined
          ? null
          : ((await this.deps.plans?.()?.directContext(i.threadId, i.planId, i.userId, null)) ?? null);
      const h = i.human;
      const codeFreshUntil =
        h?.mfaAt === null || h?.mfaAt === undefined || h.stepUpMaxAgeMs === undefined
          ? null
          : new Date(h.mfaAt.getTime() + h.stepUpMaxAgeMs);
      return await direct.turnBlock({
        byUser: i.byUser,
        proposeAware: features(rows[0]?.features).includes(ASSISTANT_PROPOSE_FEATURE),
        plan,
        followUp: !i.byUser && i.followUp === true,
        codeFreshUntil:
          codeFreshUntil !== null && codeFreshUntil.getTime() > this.deps.clock().getTime()
            ? codeFreshUntil
            : null,
      });
    } catch (err) {
      this.deps.log.warn(
        { errName: err instanceof Error ? err.name : 'error', threadId: i.threadId },
        'autonomy block not built',
      );
      return null;
    }
  }

  /** p18-multi-project W3: whether a worker advertises `assistant-projects-v1`. */
  async #projectsWorker(workerId: string): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ features: unknown }>(
      'SELECT features FROM workers WHERE id = $1',
      [workerId],
    );
    return features(rows[0]?.features).includes(ASSISTANT_PROJECTS_FEATURE);
  }

  /** p18-multi-project W3: the turn's worker feature and the conversation's working projects (once per turn). */
  async #turnProjects(t: ActiveTurn): Promise<{ aware: boolean; projects: readonly string[] }> {
    if (t.projectsAware === undefined) t.projectsAware = await this.#projectsWorker(t.workerId);
    if (t.projects === undefined) t.projects = await threadProjectIds(this.deps.pool, t.threadId);
    return { aware: t.projectsAware, projects: t.projects };
  }

  /**
   * p18-multi-project W3: the "Çalışma projeleri" block of a turn — the working projects the sender can still read
   * (members they lost access to are dropped now, with a notice in the conversation). Sent when the answering worker
   * knows the working projects, or always when there are several (data either way). Never fails the turn.
   */
  async #projectsBlock(userId: string, threadId: string, workerId: string): Promise<string | null> {
    const svc = this.deps.threadProjects?.() ?? null;
    if (svc === null) return null;
    try {
      const subject = await this.#subject(userId);
      if (subject === null) return null;
      const { view, dropped } = await svc.forTurn(subject, threadId);
      if (dropped.length > 0) {
        const note = await this.deps.store.addMessage(threadId, {
          role: 'tool',
          content: `projects: removed ${dropped.join(', ')} from the working projects — you no longer have access`,
          meta: { name: 'thread_projects', isError: true, dropped },
        });
        this.deps.streams.publish(threadId, 'tool', note);
        this.deps.streams.publish(threadId, 'thread', await this.deps.store.thread(userId, threadId));
      }
      if (view.length === 0) return null;
      if (view.length === 1 && !(await this.#projectsWorker(workerId))) return null;
      return workingProjectsBlock(view);
    } catch (err) {
      this.deps.log.warn(
        { errName: err instanceof Error ? err.name : 'error', threadId },
        'working projects not read',
      );
      return null;
    }
  }

  /** p18-leftovers: whether the turn's assistant worker advertises `assistant-budgets-v1` (once per turn). */
  async #budgetTools(t: ActiveTurn): Promise<boolean> {
    if (t.budgetTools !== undefined) return t.budgetTools;
    const { rows } = await this.deps.pool.query<{ features: unknown }>(
      'SELECT features FROM workers WHERE id = $1',
      [t.workerId],
    );
    t.budgetTools = features(rows[0]?.features).includes(ASSISTANT_BUDGETS_FEATURE);
    return t.budgetTools;
  }

  /**
   * p19-repo-job-inputs: whether the assistant worker advertises `assistant-repo-inputs-v1` (its prompt says chat
   * attachments reach repository jobs too). A failed lookup counts as "no" (the longer attachments note is harmless).
   */
  async #repoInputsRule(workerId: string): Promise<boolean> {
    try {
      const { rows } = await this.deps.pool.query<{ features: unknown }>(
        'SELECT features FROM workers WHERE id = $1',
        [workerId],
      );
      return features(rows[0]?.features).includes(ASSISTANT_REPO_INPUTS_FEATURE);
    } catch {
      return false;
    }
  }

  /** p19-linux-host-isolation: whether the turn's assistant worker advertises `assistant-capacity-v1` (once per turn). */
  async #capacityRule(t: ActiveTurn): Promise<boolean> {
    if (t.capacityRule !== undefined) return t.capacityRule;
    const { rows } = await this.deps.pool.query<{ features: unknown }>(
      'SELECT features FROM workers WHERE id = $1',
      [t.workerId],
    );
    t.capacityRule = features(rows[0]?.features).includes(ASSISTANT_CAPACITY_FEATURE);
    return t.capacityRule;
  }

  /** p18-project-bootstrap: whether the turn's assistant worker advertises `assistant-project-setup-v1` (once). */
  async #projectSetup(t: ActiveTurn): Promise<boolean> {
    if (t.projectSetup !== undefined) return t.projectSetup;
    const { rows } = await this.deps.pool.query<{ features: unknown }>(
      'SELECT features FROM workers WHERE id = $1',
      [t.workerId],
    );
    t.projectSetup = features(rows[0]?.features).includes(ASSISTANT_PROJECT_SETUP_FEATURE);
    return t.projectSetup;
  }

  /** p19-ide W4: whether the turn's assistant worker advertises `assistant-code-v1` (once). */
  async #codeTools(t: ActiveTurn): Promise<boolean> {
    if (t.codeTools !== undefined) return t.codeTools;
    const { rows } = await this.deps.pool.query<{ features: unknown }>(
      'SELECT features FROM workers WHERE id = $1',
      [t.workerId],
    );
    t.codeTools = features(rows[0]?.features).includes(ASSISTANT_CODE_FEATURE);
    return t.codeTools;
  }

  /** p20-chat-images: whether the turn's assistant worker advertises `assistant-images-v1` (once). */
  async #imageTools(t: ActiveTurn): Promise<boolean> {
    if (t.imageTools !== undefined) return t.imageTools;
    const { rows } = await this.deps.pool.query<{ features: unknown }>(
      'SELECT features FROM workers WHERE id = $1',
      [t.workerId],
    );
    t.imageTools = features(rows[0]?.features).includes(ASSISTANT_IMAGES_FEATURE);
    return t.imageTools;
  }

  /** p18-assistant-gaps: whether the turn's assistant worker advertises `assistant-ops-tools-v1` (once per turn). */
  async #opsTools(t: ActiveTurn): Promise<boolean> {
    if (t.opsTools !== undefined) return t.opsTools;
    const { rows } = await this.deps.pool.query<{ features: unknown }>(
      'SELECT features FROM workers WHERE id = $1',
      [t.workerId],
    );
    t.opsTools = features(rows[0]?.features).includes(ASSISTANT_OPS_TOOLS_FEATURE);
    return t.opsTools;
  }

  async #toolCall(
    session: WorkerSession,
    t: ActiveTurn,
    u: Extract<AssistantUpdatePayload, { kind: 'tool_call' }>,
  ): Promise<void> {
    t.toolCalls += 1;
    const settings = await this.deps.settings.get();
    const subject = await this.#subject(t.userId);
    let isError: boolean;
    let content: string;
    let summary: string;
    let draftId: string | null = null;
    let questionId: string | null = null;
    let planMeta: Record<string, unknown> = {};
    let outcome: 'success' | 'denied' | 'failure';
    // p18-plan-mode: the tool × mode matrix (plan mode is read-only; plan_create needs it) and once-per-turn tools.
    const planRefusal = planModeRefusal(u.tool, t.planMode === true);
    const planTwice =
      (u.tool === 'plan_propose' || u.tool === 'plan_create') && t.planOnce?.has(u.tool) === true;
    if (subject === null) {
      isError = true;
      content = 'The user account is disabled; no tool may run.';
      summary = `${u.tool}: refused — account disabled`;
      outcome = 'denied';
    } else if (t.toolCalls > settings.limits.maxToolCallsPerTurn) {
      isError = true;
      content = 'Tool call limit for this turn reached; answer with what you have.';
      summary = `${u.tool}: refused — tool call limit`;
      outcome = 'denied';
    } else if (planRefusal !== null || planTwice) {
      const code = planRefusal ?? 'plan_once_per_turn';
      isError = true;
      content = this.#fence(u.tool, {
        error: code,
        message:
          code === 'plan_mode_read_only'
            ? 'Plan mode is on: only read tools, ask_user, plan_ask_decision, plan_create / plan_update_items and set_chat_title run. Write it into the plan as an item instead; it runs as a card after the user approves the plan.'
            : code === 'plan_mode_active'
              ? 'Plan mode is already on: write the plan with plan_create.'
              : code === 'plan_mode_required'
                ? 'plan_create works in plan mode only: suggest planning with plan_propose and let the user turn it on.'
                : `${u.tool} runs once per turn.`,
      });
      summary = `${u.tool}: refused — ${code}`;
      outcome = 'denied';
      if (code === 'plan_mode_read_only')
        await this.deps.audit
          .record({
            actor: { type: 'user', id: t.userId },
            action: 'chat.plan.refused_tool',
            target: `chat-thread:${t.threadId}`,
            outcome: 'denied',
            metadata: { tool: u.tool, turnId: t.id, kind: ASSISTANT_TOOLS[u.tool].kind },
          })
          .catch(() => undefined);
    } else {
      const out: ToolOutcome =
        u.tool === 'set_chat_title'
          ? await this.#titleTool(t, u.input)
          : await this.deps.tools.run(
              {
                userId: t.userId,
                subject,
                threadId: t.threadId,
                turnId: t.id,
                // p15-watch-autorun: create_watch decides like a draft of this turn whether its `then` step runs by itself.
                turn: {
                  byUser: t.byUser,
                  // oss-sec3: a turn that read untrusted content stores a watch's `then` step as a card and gives its
                  // next step no consent of the person.
                  tainted: () => this.#tainted(t),
                  // p22-watch-next-step: a follow-up's new watches inherit the person's consent of its watch.
                  ...(t.byUser || t.followUp === undefined ? {} : { followUpWatch: t.followUp }),
                  ...(t.byUser || t.lateResult?.consentAt == null
                    ? {}
                    : { consentAt: t.lateResult.consentAt }),
                  proposeAware: () => this.#proposeAware(t),
                  // p18-plan-autonomy: in an autonomous plan's continuation the `then` step runs by itself too.
                  plan: (() => {
                    const planId = t.byUser ? undefined : t.planTurn;
                    if (planId === undefined) return undefined;
                    return async () =>
                      (await this.deps.plans?.()?.directContext(t.threadId, planId, t.userId, null)) ?? null;
                  })(),
                },
                // p16-workflow-quality: the sender's zone (their message's), the default zone of drafted schedules.
                timeZone: await this.#turnZone(t),
                // p18-plan-mode: the plan tools check the turn's mode.
                planMode: t.planMode === true,
                // p18-assistant-gaps: answers name the ops tools only to a worker that has them.
                opsTools: await this.#opsTools(t),
                // p18-leftovers: draft_budget_change and GitHub triggers in group cards only on worker 1.2.2.
                budgetTools: await this.#budgetTools(t),
                // p19-linux-host-isolation: describe_worker carries the capacity rule only for older assistants.
                capacityRule: await this.#capacityRule(t),
                // p18-project-bootstrap: describe_project_readiness / draft_project_network / _machines.
                projectSetup: await this.#projectSetup(t),
                // p19-ide W4: read_code / list_code / read_workspace_diff / open_code / open_diff / draft_review_changes.
                codeTools: await this.#codeTools(t),
                // p20-chat-images: show_image / draft_screenshot.
                imageTools: await this.#imageTools(t),
                // p18-multi-project W3: the working projects; their write rules only for a worker that knows them.
                ...(await this.#turnProjects(t).then((tp) => ({
                  projects: tp.projects,
                  projectRules: tp.aware,
                }))),
              },
              u.tool,
              u.input,
            );
      // oss-sec3: a result carrying content from outside the person taints the rest of the turn (and the
      // conversation's later system-written turns). Marked before anything else of this call is decided.
      if (resultTaints(u.tool, out)) await this.#taintTurn(t, [`tool:${u.tool}`]);
      isError = !out.ok;
      outcome = out.ok
        ? 'success'
        : out.code === 'forbidden' || out.code === 'not_found'
          ? 'denied'
          : 'failure';
      summary = toolSummary(u.tool, out);
      let data: unknown = out.ok ? out.data : { error: out.code, message: out.message };
      // p16-workflow-quality: a refused draft is stored hidden — the tool message carries its id (repair loop, give-up
      // line), but nothing is published as a card.
      if (!out.ok && out.draft !== undefined) draftId = out.draft.id;
      if (out.ok && out.draft !== undefined) {
        draftId = out.draft.id;
        // p15-chat-execute-default: the platform decides — a draft in a turn the user started runs at once for them
        // unless the assistant marked it as its own proposal (p15-autonomy's `execute: true` still runs it).
        const direct = this.deps.direct?.() ?? null;
        // p18-plan-autonomy: a continuation turn of a plan — the plan as it stands now (approved to run on its own?).
        const planCtx =
          t.byUser || t.planTurn === undefined
            ? null
            : ((await this.deps
                .plans?.()
                ?.directContext(t.threadId, t.planTurn, t.userId, out.planItem ?? null)) ?? null);
        // p20-scope-preview: a continuation turn of the user's goal (an autonomous plan running its drafts, a watch
        // follow-up) — is this draft inside what the user's own turns of this conversation ran directly? For a plan
        // only machine administration is checked (its approval already covers the rest).
        const followUpTurn = !t.byUser && t.followUp !== undefined;
        // p22-slow-tools: a late result handed back carries on the person's request like a watch follow-up.
        const lateTurn = !t.byUser && t.followUp === undefined && t.lateResult !== undefined;
        const goal =
          direct !== null &&
          !t.byUser &&
          (followUpTurn || (planRunsDrafts(planCtx ?? undefined) && machinePolicyCard(out.draft)))
            ? await direct.goal(t.userId, t.threadId, out.draft)
            : ({ state: 'off' } as const);
        const decision = directDecision({
          tool: u.tool,
          execute: out.execute === true,
          propose: out.propose === true,
          byUser: t.byUser,
          proposeAware: direct === null ? false : await this.#proposeAware(t),
          ...(planCtx === null ? {} : { plan: planCtx }),
          followUp: followUpTurn || lateTurn,
          // p22-watch-next-step: the follow-up carries out the step the person's request asked for.
          nextStep:
            (followUpTurn &&
              (await nextStepConsent(this.deps.pool, t.followUp ?? '', t.userId, this.#now()).catch(
                () => null,
              )) !== null) ||
            (lateTurn && consentHolds(t.lateResult?.consentAt ?? null, this.#now())),
          ...(goal.state === 'off' ? {} : { goal: goal.state }),
          // p22-timeout-continuity: a follow-up may extend a job's time at once when the policy says so.
          autoExtendTime:
            followUpTurn && u.tool === 'draft_time_limit' && direct !== null
              ? await direct.autoExtendTime()
              : false,
          // oss-sec3: the turn read untrusted content (or continues a conversation that did).
          tainted: (await this.#tainted(t)).size > 0,
        });
        const inherited = goal.state === 'in_scope' ? goal.grant : undefined;
        let done: DirectOutcome | null = null;
        // oss-sec3: the card as published (with its `held` mark when it was held for untrusted content).
        let card: DraftRecord = out.draft;
        // oss-sec3: a draft held for untrusted content runs only when the person's remembered choice covers it.
        let run = decision.run;
        let allowed: { readonly untrustedAllow: string } | null = null;
        if (direct !== null && decision.held !== undefined) {
          const allow = await this.deps
            .untrustedAllows?.()
            ?.match(t.userId, out.draft)
            .catch(() => null);
          if (allow != null) {
            run = decision.held.would;
            allowed = { untrustedAllow: allow.id };
          }
        }
        if (direct !== null && decision.held !== undefined && run === null) {
          // While the policy keeps cards anyway (chatDirect off) nothing would have run: a plain card, no hold.
          if (await direct.enabled()) {
            const held = (await this.deps.store.holdDraft(out.draft.id, 'untrusted_content')) ?? out.draft;
            card = held;
            done = await direct.hold(subject, t.human, held, decision.held.would, {
              sources: [...(await this.#tainted(t))],
              rememberable: held.held?.rememberable === true,
            });
          }
        } else if (direct !== null && run === 'plan' && planCtx !== null) {
          // The owner's consent was given when they approved the plan: no human context (like a watch) — a step that
          // needs a fresh authenticator code, a one-time secret or a destructive change stays a card (the item waits).
          done = await direct.execute(
            subject,
            subject.role,
            undefined,
            out.draft,
            'plan',
            {
              planId: planCtx.planId,
              planVersion: planCtx.version,
              planItem: out.planItem ?? null,
              approvedBy: 'plan',
              ...allowed,
            },
            inherited,
          );
        } else if (direct !== null && run === 'watch' && t.followUp !== undefined) {
          // p19-watch-follow-up: the user's request behind the watch is the consent; no human context.
          done = await direct.execute(
            subject,
            subject.role,
            undefined,
            out.draft,
            'watch',
            {
              watchId: t.followUp,
              approvedBy: inherited === undefined ? 'follow_up' : 'goal_grant',
              ...allowed,
            },
            inherited,
          );
        } else if (direct !== null && run === 'watch' && lateTurn) {
          // p22-slow-tools: the person's request behind the late call is the consent; no human context.
          done = await direct.execute(subject, subject.role, undefined, out.draft, 'watch', {
            approvedBy: 'tool_result',
            ...allowed,
          });
        } else if (direct !== null && run !== null) {
          // The default path stays a plain card (no audit noise) while the policy keeps cards.
          if (run === 'execute' || (await direct.enabled()))
            done = await direct.execute(subject, subject.role, t.human, out.draft, run, allowed ?? {});
        } else if (direct !== null && decision.refused === 'out_of_scope') {
          done = await direct.refuse(subject, undefined, out.draft, 'out_of_scope', {
            trigger: followUpTurn ? 'watch' : 'plan',
            ...(goal.state === 'out_of_scope' ? { scope: goal.scope } : {}),
          });
        } else if (direct !== null && decision.refused !== undefined) {
          done = await direct.refuse(subject, t.human, out.draft, decision.refused);
        }
        if (done?.executed === true) {
          this.deps.streams.publish(t.threadId, 'draft', done.draft);
          summary = `${u.tool}: done “${out.draft.title}”`.slice(0, 500);
          // p18-multi-project W3: the working projects changed — the rest of this turn reads them again.
          if (out.draft.kind === 'thread_projects') t.projects = undefined;
          // p15-chat-vault: a request that ran at once — the turn waits (bounded, under the worker's tool timeout) for
          // the response, so the assistant can answer with it.
          const jobId = done.result.jobId;
          const creds = this.deps.credentials?.() ?? null;
          if (out.draft.kind === 'http_request' && typeof jobId === 'string' && creds !== null) {
            const response = await creds
              .await(jobId, HTTP_REQUEST_WAIT_MS)
              .catch(() => ({ jobId, state: 'unknown' }));
            done = { ...done, result: { ...done.result, response } };
          }
        } else {
          this.deps.streams.publish(t.threadId, 'draft', draftView(card));
          if (done !== null && done.reason === 'needs_code')
            summary = `${u.tool}: card “${out.draft.title}” — authenticator code needed`.slice(0, 500);
        }
        if (done !== null) data = directToolData(out.data as Record<string, unknown>, done);
        // p18-plan-mode: a card for a plan item (`planItem`) — linked to it; the item is in progress from now on.
        if (out.planItem !== undefined) {
          const note = await this.deps
            .plans?.()
            // A card that already ran (an autonomous plan, the user's own turn) is linked as such: no "waits for you".
            ?.linkDraft(
              t.threadId,
              out.planItem,
              done?.executed === true ? { ...out.draft, state: done.draft.state } : card,
            )
            .catch(() => 'The card could not be linked to the plan item.');
          data = {
            ...(data as Record<string, unknown>),
            planItem: note ?? `linked to plan item ${out.planItem} (in progress; it follows the card)`,
          };
        }
      }
      if (out.ok && (u.tool === 'plan_propose' || u.tool === 'plan_create'))
        (t.planOnce ??= new Set()).add(u.tool);
      if (out.ok && out.plan !== undefined) planMeta = { planId: out.plan.id, planVersion: out.plan.version };
      if (out.ok && out.proposal !== undefined) planMeta = { proposal: { reason: out.proposal.reason } };
      // p19-ide W4: open_code / open_diff's "Aç" card rides on the tool message (validated shape only).
      if (out.ok && out.codeCard !== undefined) {
        const card = AssistantCodeCard.safeParse(out.codeCard);
        if (card.success) planMeta = { ...planMeta, codeCard: card.data };
      }
      // p20-chat-images: show_image's images ride on the tool message (validated shape only; the web builds the URLs).
      if (out.ok && out.images !== undefined) {
        const images = out.images.flatMap((x) => {
          const card = AssistantImageCard.safeParse(x);
          return card.success ? [card.data] : [];
        });
        if (images.length > 0) planMeta = { ...planMeta, images };
      }
      content = this.#fence(u.tool, data);
      // p14-ask-user: the tool message carries the question card's id (the thread view renders the card there).
      if (out.ok && out.question !== undefined) questionId = out.question.id;
      if (out.ok && out.questionId !== undefined) questionId = out.questionId;
    }
    // Persist before answering: the transcript order is call → answer (the answer can only follow it).
    const message = await this.deps.store.addMessage(t.threadId, {
      role: 'tool',
      content: summary,
      meta: {
        name: u.tool,
        isError,
        ...(draftId === null ? {} : { draftId }),
        ...(questionId === null ? {} : { questionId }),
        ...planMeta,
      },
      turnId: t.id,
    });
    await this.deps.store.countToolCall(t.id);
    this.deps.streams.publish(t.threadId, 'tool', message);
    await this.deps.audit.record({
      actor: { type: 'user', id: t.userId },
      action: 'chat.tool',
      target: `chat-thread:${t.threadId}`,
      outcome,
      metadata: {
        tool: u.tool,
        turnId: t.id,
        workerId: t.workerId,
        ...(draftId === null ? {} : { draftId }),
        ...(questionId === null ? {} : { questionId }),
        ...(isError ? { refused: summary.slice(0, 200) } : {}),
      },
    });
    // p22-slow-tools: the call was answered "still running" — its result goes back in a turn of its own.
    if (t.late?.has(u.callId) === true) {
      void this.#handBack(t, u.tool, content).catch((err: unknown) => {
        this.deps.log.warn({ err, turnId: t.id, tool: u.tool }, 'late tool result not handed back');
      });
      return;
    }
    await this.#sendResult(session, t, { turnId: t.id, callId: u.callId, isError, content });
  }

  /** oss-sec3: what made this turn untrusted (loaded once: the stored turn, its message, the conversation). */
  async #tainted(t: ActiveTurn): Promise<ReadonlySet<string>> {
    if (t.taint === undefined) {
      const initial = await initialTaint(this.deps.pool, {
        threadId: t.threadId,
        turnId: t.id,
        messageId: t.messageId,
        byUser: t.byUser,
      });
      // Another call of this turn may have tainted it meanwhile.
      t.taint ??= new Set();
      for (const x of initial) t.taint.add(x);
      if (initial.length > 0)
        await markTurnTainted(this.deps.pool, t.id, initial, this.#now()).catch(() => undefined);
    }
    return t.taint;
  }

  /** oss-sec3: adds taint sources to the turn (in memory and on its row, for later continuation turns). */
  async #taintTurn(t: ActiveTurn, sources: readonly string[]): Promise<void> {
    await this.#tainted(t);
    const fresh = sources.filter((x) => t.taint?.has(x) !== true);
    if (fresh.length === 0) return;
    for (const x of fresh) t.taint?.add(x);
    await markTurnTainted(this.deps.pool, t.id, fresh, this.#now()).catch((err: unknown) => {
      this.deps.log.warn({ err, turnId: t.id }, 'untrusted content mark not stored');
    });
  }

  /** p22-slow-tools: answer a call that outlives the worker's tool timeout with "still running" (once). */
  async #stillRunning(session: WorkerSession, t: ActiveTurn, tool: string, callId: string): Promise<void> {
    if (t.results?.has(callId) === true || t.late?.has(callId) === true) return;
    if (!this.#turns.has(t.id)) return;
    (t.late ??= new Set()).add(callId);
    this.deps.log.info(
      { turnId: t.id, tool },
      'tool call outlives the tool timeout; answered "still running"',
    );
    await this.#sendResult(session, t, {
      turnId: t.id,
      callId,
      isError: false,
      content: this.#fence(tool, { status: 'still_running', message: stillRunningText(tool) }),
    });
  }

  /**
   * p22-slow-tools: a late result is handed back in a system-written turn once the conversation is free — carrying the
   * person's consent of the turn the call belonged to (their own message, or the one that turn inherited).
   */
  async #handBack(t: ActiveTurn, tool: string, content: string): Promise<void> {
    const consentAt = t.byUser
      ? new Date(t.startedAt)
      : (t.lateResult?.consentAt ??
        (t.followUp === undefined
          ? null
          : await nextStepConsent(this.deps.pool, t.followUp, t.userId, this.#now()).catch(() => null)));
    const lang = guessLanguage([t.text]);
    const until = Date.now() + LATE_RESULT_WAIT_MS;
    const actor = { userId: t.userId, ip: 'system', userAgent: null };
    while (Date.now() < until) {
      if (await this.idle(t.threadId).catch(() => false)) {
        try {
          await this.send(actor, t.threadId, lateResultText(lang, tool, content), {
            lateResult: { tool, consentAt },
          });
          return;
        } catch (err) {
          const code = err instanceof HttpError ? err.code : 'error';
          if (code !== 'turn_in_progress' && code !== 'rate_limited' && code !== 'assistant_unavailable') {
            this.deps.log.warn({ err, threadId: t.threadId, tool }, 'late tool result not handed back');
            return;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 3_000).unref());
    }
    this.deps.log.warn({ threadId: t.threadId, tool }, 'late tool result: the conversation stayed busy');
  }

  /**
   * p17-chat-reconnect: a tool result goes over the turn's current connection (it may have changed while the tool ran);
   * while the turn waits for its worker to reconnect it is only kept — the resume sends the kept results again.
   */
  async #sendResult(origin: WorkerSession, t: ActiveTurn, r: AssistantToolResultPayload): Promise<void> {
    const kept = (t.results ??= new Map<string, AssistantToolResultPayload>());
    kept.delete(r.callId);
    kept.set(r.callId, r);
    while (kept.size > KEPT_TOOL_RESULTS) {
      const oldest = kept.keys().next().value;
      if (oldest === undefined) break;
      kept.delete(oldest);
    }
    if (t.grace !== undefined) return;
    const current = this.deps.session(t.workerId);
    const target = current !== undefined && current.connectionId === t.connectionId ? current : origin;
    await target.send('ASSISTANT_TOOL_RESULT', r).catch((err: unknown) => {
      this.deps.log.warn({ err, turnId: t.id }, 'tool result could not be sent');
    });
  }

  /** Fenced, redacted, bounded tool result for the model. */
  #fence(tool: string, data: unknown): string {
    let fenced = this.#redactor.redact(fenceData(`${tool} result`, data));
    if (fenced.length > MAX_TOOL_RESULT) {
      const json = JSON.stringify(data);
      fenced = this.#redactor.redact(
        fenceData(`${tool} result (truncated)`, {
          truncated: true,
          preview: json.slice(0, MAX_TOOL_RESULT / 2),
        }),
      );
    }
    return fenced.slice(0, MAX_TOOL_RESULT);
  }

  async #finish(
    t: ActiveTurn,
    end: {
      state: 'done' | 'failed' | 'cancelled';
      reason?: string;
      detail?: string;
      text?: string;
      usage?: AssistantUsage;
      /** p22-chat-queue: a successor turn answers the same message (failover, fallback): the queue waits for it. */
      continues?: boolean;
    },
  ): Promise<void> {
    if (this.#turns.get(t.id) !== t) return;
    this.#turns.delete(t.id);
    if (t.grace !== undefined) clearTimeout(t.grace.timer);
    t.grace = undefined;
    if (this.#byThread.get(t.threadId) === t.id) this.#byThread.delete(t.threadId);
    this.deps.observe?.ended(t.id, end.state, end.reason?.replace(/[^a-z0-9_]/g, '_').slice(0, 64));
    await this.#record(t, end);
  }

  /** Persists the end of a turn once (the turn row is the gate) and tells the thread's views. */
  async #record(
    t: ActiveTurn,
    end: {
      state: 'done' | 'failed' | 'cancelled';
      reason?: string;
      detail?: string;
      text?: string;
      usage?: AssistantUsage;
      continues?: boolean;
    },
  ): Promise<void> {
    if (this.#mirror.get(t.threadId)?.id === t.id) this.#mirror.delete(t.threadId);
    const reason = end.reason?.replace(/[^a-z0-9_]/g, '_').slice(0, 64);
    const ok = await this.deps.store.finishTurn(t.id, {
      state: end.state,
      ...(reason === undefined ? {} : { reason }),
      ...(end.usage === undefined ? {} : { usage: end.usage }),
    });
    if (!ok) return;
    // p18-plan-mode: a plan's continuation turn ended (progress, a stall, or the next item).
    const plans = this.deps.plans?.() ?? null;
    if (plans !== null) void plans.turnEnded({ turnId: t.id, threadId: t.threadId, state: end.state });
    try {
      if (end.state === 'done') {
        const text = end.text !== undefined && end.text.trim() !== '' ? end.text : t.text;
        // p16-chat-complete: a regenerated / retried answer says which engine and model it came from.
        const regenerated =
          t.origin === 'regenerate' || t.origin === 'retry'
            ? { regenerated: { origin: t.origin, runtime: t.runtime ?? null, model: t.model ?? null } }
            : null;
        const message = await this.deps.store.addMessage(t.threadId, {
          role: 'assistant',
          content: text.trim() === '' ? '(The assistant gave no answer.)' : text,
          turnId: t.id,
          ...(regenerated === null ? {} : { meta: regenerated }),
        });
        this.deps.streams.publish(t.threadId, 'message', message);
        this.deps.streams.publish(t.threadId, 'done', { turnId: t.id });
        // p15-workflow-ai: one automatic repair turn after an invalid workflow draft (never fails this turn); without
        // one, p16-workflow-quality: a turn that ends with refused drafts and no valid card of that kind says so once.
        const hooks = this.deps.workflowAi?.() ?? null;
        void (async () => {
          const repaired =
            hooks === null
              ? false
              : await hooks
                  .afterTurn({ turnId: t.id, threadId: t.threadId, userId: t.userId, messageId: t.messageId })
                  .catch(() => false);
          if (!repaired) await this.#invalidDraftNotice(t);
        })();
        return;
      }
      if (t.text.trim() !== '') {
        // Keep what was already said.
        const partial = await this.deps.store.addMessage(t.threadId, {
          role: 'assistant',
          content: t.text,
          turnId: t.id,
        });
        this.deps.streams.publish(t.threadId, 'message', partial);
      }
      const base = REASONS[reason ?? ''] ?? `The assistant failed (${reason ?? 'unknown'}).`;
      const text = end.detail === undefined || end.state === 'cancelled' ? base : `${base} ${end.detail}`;
      const message = await this.deps.store.addMessage(t.threadId, {
        role: 'error',
        content: text.slice(0, 1000),
        meta: { reason: reason ?? null },
        turnId: t.id,
      });
      this.deps.streams.publish(t.threadId, 'message', message);
      this.deps.streams.publish(t.threadId, 'error', {
        turnId: t.id,
        reason: reason ?? null,
        message: message.content,
      });
    } catch (err) {
      // The thread may have been deleted meanwhile.
      this.deps.log.debug({ err, turnId: t.id }, 'turn end not recorded in the thread');
    } finally {
      // p22-chat-queue: any end (done, failed, stopped) delivers the messages that waited — after the end's own rows,
      // so they follow the answer; a turn continued elsewhere delivers when its successor ends.
      if (end.continues !== true) this.#drainSoon(t.threadId);
    }
  }

  /**
   * p16-workflow-quality: the give-up line of a turn. Refused draft attempts (state `invalid`) are never cards; when a
   * kind's last attempt in the turn was refused and no valid card of that kind followed, ONE compact line names the
   * last issues (`meta.notice = 'draft-invalid'`, shown in the reader's language). Never fails the turn.
   */
  async #invalidDraftNotice(t: ActiveTurn): Promise<void> {
    try {
      const drafts = await this.deps.store.turnDrafts(t.id);
      const open = new Map<string, { attempts: number; last: (typeof drafts)[number] }>();
      for (const d of drafts) {
        if (d.state === 'invalid') {
          const cur = open.get(d.kind);
          open.set(d.kind, { attempts: (cur?.attempts ?? 0) + 1, last: d });
        } else {
          open.delete(d.kind);
        }
      }
      if (open.size === 0) return;
      const failed = [...open.entries()].map(([kind, v]) => {
        const raw = Array.isArray(v.last.payload.issues) ? (v.last.payload.issues as unknown[]) : [];
        const issues = raw
          .slice(0, 5)
          .map((x) => {
            const o = (typeof x === 'object' && x !== null ? x : {}) as { path?: unknown; code?: unknown };
            const path = typeof o.path === 'string' ? o.path : '';
            const code = typeof o.code === 'string' ? o.code : '';
            return (path === '' ? code : `${path}: ${code}`).slice(0, 300);
          })
          .filter((x) => x !== '');
        return { kind, attempts: v.attempts, issues };
      });
      const text = failed
        .map(
          (f) =>
            `Draft invalid (${f.kind}, ${String(f.attempts)} attempt(s)): ${f.issues.join('; ') || 'refused'}`,
        )
        .join('\n');
      const message = await this.deps.store.addMessage(t.threadId, {
        role: 'error',
        content: text.slice(0, 1000),
        meta: { notice: 'draft-invalid', reason: null, drafts: failed },
        turnId: t.id,
      });
      this.deps.streams.publish(t.threadId, 'message', message);
    } catch (err) {
      this.deps.log.debug({ err, turnId: t.id }, 'invalid draft notice not recorded');
    }
  }

  /**
   * A worker connection ended: the turns sent over it cannot finish over it. p17-chat-reconnect: when the worker
   * continues turns across a reconnect (`assistant-resume-v1`) and named its process, each turn waits up to the grace
   * period for that same process to come back (`onSessionStart` continues it); otherwise — and when the grace runs out
   * — it is lost as before (p15-chat-failover: re-run once on the next machine when the turn did not act).
   */
  async onSessionEnd(session: WorkerSession): Promise<void> {
    this.deps.bus?.announce();
    const bound = [...this.#turns.values()].filter(
      (t) => t.workerId === session.workerId && t.connectionId === session.connectionId,
    );
    if (bound.length === 0) return;
    const instance = session.instanceId ?? null;
    const graceMs = this.deps.reconnectGraceMs ?? RECONNECT_GRACE_MS;
    const resumable = instance !== null && graceMs > 0 && (await this.#resumeCapable(session.workerId));
    for (const t of bound) {
      if (resumable && (t.instanceId ?? null) === instance) this.#hold(t, graceMs);
      else await this.#lost(t, 'assistant_disconnected');
    }
  }

  /**
   * p17-chat-reconnect: a worker session started. Turns of this worker that wait for a reconnect (or are still bound to
   * an older connection whose end was not processed yet) continue here when the same process came back; a different
   * process (a restart, another machine with the key) means they are lost now.
   */
  async onSessionStart(session: WorkerSession): Promise<void> {
    const instance = session.instanceId ?? null;
    let capable: boolean | null = null;
    for (const t of [...this.#turns.values()]) {
      if (t.workerId !== session.workerId || t.connectionId === session.connectionId) continue;
      const held = t.grace !== undefined;
      if (!held && t.connectionId === null) continue; // not sent yet
      if (instance === null || (t.instanceId ?? null) !== instance) {
        this.deps.log.info(
          { turnId: t.id, workerId: t.workerId, held },
          'assistant worker came back as another process; its turn is lost',
        );
        await this.#lost(t, 'assistant_disconnected');
        continue;
      }
      if (!held) {
        capable ??=
          (this.deps.reconnectGraceMs ?? RECONNECT_GRACE_MS) > 0 && (await this.#resumeCapable(t.workerId));
        // The older connection's end still fails it as before.
        if (!capable) continue;
      }
      await this.#resume(t, session);
    }
  }

  async #resumeCapable(workerId: string): Promise<boolean> {
    const { rows } = await this.deps.pool
      .query<{ features: unknown }>('SELECT features FROM workers WHERE id = $1', [workerId])
      .catch(() => ({ rows: [] as { features: unknown }[] }));
    return features(rows[0]?.features).includes(ASSISTANT_RESUME_FEATURE);
  }

  /** p17-chat-reconnect: the turn's connection dropped; it waits (the console shows "reconnecting"). */
  #hold(t: ActiveTurn, graceMs: number): void {
    if (t.grace !== undefined) return;
    t.connectionId = null;
    const timer = setTimeout(() => {
      void this.#graceOver(t).catch((err: unknown) => {
        this.deps.log.error({ err, turnId: t.id }, 'assistant reconnect grace handling failed');
      });
    }, graceMs);
    timer.unref();
    t.grace = { until: Date.now() + graceMs, timer };
    this.deps.log.info(
      { turnId: t.id, workerId: t.workerId, graceMs },
      'assistant worker connection dropped; the turn waits for it to reconnect',
    );
    this.deps.streams.publish(t.threadId, 'turn', { id: t.id, state: 'reconnecting' });
  }

  async #graceOver(t: ActiveTurn): Promise<void> {
    if (this.#turns.get(t.id) !== t || t.grace === undefined) return;
    t.grace = undefined;
    this.deps.log.info(
      { turnId: t.id, workerId: t.workerId },
      'assistant worker did not reconnect in time; the turn is lost',
    );
    await this.#lost(t, 'assistant_disconnected');
  }

  /**
   * p17-chat-reconnect: the same worker process is back — the turn moves to the new connection, the worker re-sends
   * the updates after the last one processed here (ASSISTANT_RESUME; seq dedupe makes each count once), and the kept
   * tool results go again (the worker ignores calls it no longer waits for).
   */
  async #resume(t: ActiveTurn, session: WorkerSession): Promise<void> {
    if (t.grace !== undefined) clearTimeout(t.grace.timer);
    t.grace = undefined;
    t.connectionId = session.connectionId;
    t.lastUpdateAt = Date.now();
    this.deps.log.info(
      { turnId: t.id, workerId: t.workerId, afterSeq: t.lastSeq },
      'assistant worker reconnected; the turn continues',
    );
    try {
      await session.send('ASSISTANT_RESUME', { turnId: t.id, afterSeq: t.lastSeq });
    } catch (err) {
      this.deps.log.warn({ err, turnId: t.id }, 'assistant turn resume could not be sent');
      await this.#lost(t, 'assistant_disconnected');
      return;
    }
    for (const r of [...(t.results?.values() ?? [])]) {
      await session.send('ASSISTANT_TOOL_RESULT', r).catch(() => undefined);
    }
    this.deps.streams.publish(t.threadId, 'turn', { id: t.id, state: t.state });
  }

  /** Fails turns without news (and turns left open by a previous master process). */
  async sweep(): Promise<number> {
    let n = 0;
    const cutoff = Date.now() - this.#timeoutMs;
    for (const t of [...this.#turns.values()]) {
      if (t.lastUpdateAt < cutoff) {
        await this.#sendCancel(t, 'timeout');
        await this.#lost(t, 'timeout');
        n += 1;
      }
    }
    await this.deps.attachments?.sweep().catch((err: unknown) => {
      this.deps.log.warn({ err }, 'chat attachment sweep failed');
    });
    // p15-chat-failover: switches (and the return to the primary) also happen while nobody chats.
    await this.#sweepRoute().catch((err: unknown) => {
      this.deps.log.warn({ err }, 'chat failover sweep failed');
    });
    // p16-chat-complete: orphans of a stopped master are answered again once (inside the recovery window).
    const window = this.deps.restartRecovery?.windowMs ?? 5 * 60_000;
    if (this.#now().getTime() - this.#startedAt.getTime() <= window) n += (await this.recover()).lost;
    const stale = await this.deps.store.staleTurns(new Date(this.#now().getTime() - 2 * this.#timeoutMs));
    for (const s of stale) {
      if (this.#turns.has(s.id)) continue;
      if (await this.deps.store.finishTurn(s.id, { state: 'failed', reason: 'lost' })) {
        n += 1;
        // p16-chat-complete: the thread says so (and the console offers Retry).
        const row = await this.deps.store.turnRow(s.id);
        await this.#lostLine({ id: s.id, thread_id: s.threadId, actions: row?.actions ?? 0 });
      }
    }
    // p22-chat-queue: waiting messages of conversations without a turn (a restart, a missed end, a held delivery).
    await this.drainQueues().catch((err: unknown) => {
      this.deps.log.warn({ err }, 'chat queue sweep failed');
    });
    return n;
  }

  async #sweepRoute(): Promise<void> {
    const store = this.deps.failover;
    if (store === undefined) return;
    await store.sweep();
    const route = await this.#route();
    if (route.settings.enabled) await this.#commit(route);
  }

  // -------------------------------------------------------------------------------------------- usage

  async usage(subject: Subject): Promise<{
    limits: ChatSettings['limits'];
    me: {
      today: Awaited<ReturnType<ChatStore['usageSince']>>;
      month: Awaited<ReturnType<ChatStore['usageSince']>>;
    };
    all: {
      today: Awaited<ReturnType<ChatStore['usageSince']>>;
      month: Awaited<ReturnType<ChatStore['usageSince']>>;
    } | null;
  }> {
    const s = await this.deps.settings.get();
    const now = this.#now();
    const day = utcDayStart(now);
    const month = utcMonthStart(now);
    const me = {
      today: await this.deps.store.usageSince(day, subject.userId),
      month: await this.deps.store.usageSince(month, subject.userId),
    };
    const all = roleAtLeast(subject.role, 'admin')
      ? { today: await this.deps.store.usageSince(day), month: await this.deps.store.usageSince(month) }
      : null;
    return { limits: s.limits, me, all };
  }

  /**
   * p6-deploy-on-success: tells the conversation a job it started was deployed (or why not) — an assistant message
   * built by the master from identifiers, the provider URL and its own reasons (never job output).
   */
  async noteDeploy(threadId: string, text: string, meta: Record<string, unknown>): Promise<void> {
    const message = await this.deps.store.addMessage(threadId, {
      role: 'assistant',
      content: text.slice(0, 2000),
      meta,
    });
    this.deps.streams.publish(threadId, 'message', message);
  }

  /**
   * p14-workflow-engine 14.2 (`chat.message` node): posts a workflow's text into a conversation of the run's creator —
   * their thread of this workflow (`Workflow · <name>`, created on first use) or a thread they own — as an assistant
   * message built by the master (meta `source: workflow`; the text is workflow data and goes through the same safe
   * renderer as every assistant answer). Idempotent by `key`: a replay after a crash finds the message.
   */
  async postWorkflowMessage(input: {
    readonly userId: string;
    readonly thread: 'creator-ops' | { readonly threadId: string };
    readonly workflow: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly text: string;
    readonly key: string;
  }): Promise<{ threadId: string; messageId: string } | { refused: string }> {
    let threadId: string;
    if (input.thread === 'creator-ops') {
      const title = `Workflow · ${input.workflow}`.slice(0, 200);
      const { rows } = await this.deps.pool.query<{ id: string }>(
        `SELECT id FROM chat_threads WHERE user_id = $1 AND title = $2 AND archived_at IS NULL
          ORDER BY created_at LIMIT 1`,
        [input.userId, title],
      );
      threadId = rows[0]?.id ?? (await this.deps.store.createThread(input.userId, title)).id;
    } else {
      const { rows } = await this.deps.pool.query<{ id: string }>(
        'SELECT id FROM chat_threads WHERE id = $1 AND user_id = $2 AND archived_at IS NULL',
        [input.thread.threadId, input.userId],
      );
      const found = rows[0]?.id;
      if (found === undefined)
        return { refused: 'the conversation does not exist or is not the run creator’s' };
      threadId = found;
    }
    const seen = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM chat_messages WHERE thread_id = $1 AND meta->>'workflowEffect' = $2 LIMIT 1`,
      [threadId, input.key],
    );
    const existing = seen.rows[0]?.id;
    if (existing !== undefined) return { threadId, messageId: existing };
    const message = await this.deps.store.addMessage(threadId, {
      role: 'assistant',
      content: input.text.slice(0, 8000),
      meta: { source: 'workflow', runId: input.runId, node: input.nodeId, workflowEffect: input.key },
    });
    this.deps.streams.publish(threadId, 'message', message);
    return { threadId, messageId: message.id };
  }

  /**
   * p12-diyalog-f3: edits an open job draft in place (`PATCH /chat/drafts/:id`). The card is rebuilt by draft_job's own
   * checks for the editing person (draft-edit.ts) and replaces the earlier version only if nobody changed or decided it
   * meanwhile. Audited (`chat.draft.edit`, fields only) and noted in the conversation for the assistant.
   */
  async editDraft(
    subject: Subject,
    actor: ActorContext,
    draftId: string,
    edit: DraftEdit,
  ): Promise<DraftView> {
    const userId = subject.userId;
    const d = await this.deps.store.draft(userId, draftId);
    if (d.state !== 'proposed')
      throw new HttpError(409, 'draft_not_open', `The draft is ${d.state}.`, {}, {}, { state: d.state });
    if (d.kind !== 'job')
      throw new HttpError(400, 'not_editable', 'Only job cards can be edited here; ask the assistant.');
    if (payloadHash(d.payload) !== d.payloadHash)
      throw new HttpError(
        409,
        'draft_tampered',
        'The draft changed after it was proposed; it cannot be edited.',
        {},
        {},
        { reason: 'edit' },
      );
    const fields = editedFields(edit);
    const { input, inheritedDefaults, priorityClass, template } = jobDraftInput(d, edit);
    let saved: DraftRecord | null = null;
    const out = await this.deps.tools.reviseJobDraft(
      { userId, subject, threadId: d.threadId, turnId: '' },
      input,
      { priorityClass, inheritedDefaults, template },
      async (title, payload, project) => {
        saved = await this.deps.store.reviseDraft(d.id, userId, d.payloadHash, { title, project, payload });
        return { ok: true, data: null };
      },
    );
    const audit = (outcome: 'success' | 'denied' | 'failure', extra: Record<string, unknown>) =>
      this.deps.audit
        .record({
          actor: { type: 'user', id: userId },
          action: 'chat.draft.edit',
          target: `chat-draft:${d.id}`,
          outcome,
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { kind: d.kind, project: d.project, fields, ...extra },
        })
        .catch(() => undefined);
    if (!out.ok) {
      await audit(out.code === 'forbidden' ? 'denied' : 'failure', { code: out.code });
      const status =
        out.code === 'not_found'
          ? 404
          : out.code === 'forbidden'
            ? 403
            : out.code === 'unavailable'
              ? 503
              : 400;
      throw new HttpError(status, out.code === 'invalid' ? 'invalid_draft' : out.code, out.message);
    }
    const next = saved as DraftRecord | null;
    if (next === null) {
      throw new HttpError(409, 'draft_changed', 'The card changed or was decided meanwhile; reload it.');
    }
    await audit('success', { toProject: next.project });
    const view = draftView(next);
    this.deps.streams.publish(next.threadId, 'draft', view);
    const message = await this.deps.store.addMessage(next.threadId, {
      role: 'tool',
      content:
        `The user edited draft “${next.title}” on its card (${fields.join(', ')}); it now proposes: ${JSON.stringify(
          {
            project: next.project,
            runtime: (next.payload.spec as Record<string, unknown> | undefined)?.runtime,
            priorityClass: next.payload.priorityClass,
          },
        )}. It is still not confirmed.`.slice(0, 500),
      meta: { name: 'draft_edit', isError: false },
    });
    this.deps.streams.publish(next.threadId, 'tool', message);
    return view;
  }

  /** Appends a note about a confirmed draft (context for the next turn). */
  async noteConfirmed(threadId: string, text: string): Promise<void> {
    const message = await this.deps.store.addMessage(threadId, {
      role: 'tool',
      content: text.slice(0, 500),
      meta: { name: 'confirmation', isError: false },
    });
    this.deps.streams.publish(threadId, 'tool', message);
  }
}
