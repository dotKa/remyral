import { parseThreadPlan, type ThreadPlan } from './plans';
import { JOB_MESSAGE_STATUSES } from '@remyral/protocol/job-messages';
import { browserTimeZone } from '../lib/schedule';
import { type QuestionSet, threadQuestions } from './questions';
import {
  API_PREFIX,
  apiRequest,
  int,
  nullableStr,
  obj,
  type RequestOptions,
  ShapeError,
  str,
  strArray,
} from './client';
import { parseThreadKnowledge, type ThreadKnowledge } from './chatKnowledge';
import { type ChatOrganize, parseOrganize } from './chatOrganize';

/**
 * Ops chat API (p5-ops-chat, ADR-0018; apps/master/src/chat/routes.ts). Threads are private to the caller.
 * Assistant text, tool summaries and draft payloads come from a model that read untrusted data: render them
 * as text only (assistant Markdown through the safe renderer, never as HTML).
 */

type Opts = Omit<RequestOptions, 'body'>;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type MessageRole = 'user' | 'assistant' | 'tool' | 'error';
export type DraftKind =
  | 'job'
  | 'workflow_run'
  | 'worker_config'
  | 'approval_decision'
  | 'job_message'
  // p5-machine-admin (ADR-0021)
  | 'machine_task'
  | 'tool_install'
  | 'skill'
  // p6-automations (ADR-0024)
  | 'automation'
  | 'automation_change'
  // p6-deploy-integrations (ADR-0028)
  | 'ops_action'
  // p8-uptime
  | 'monitor'
  // p10-approval-pause
  | 'job_resume'
  // p10-chat-job-actions: cancel / run again / continue / class / move / run now on existing jobs
  | 'job_action'
  // p11-memory-layers: add / replace / retire a typed memory record
  | 'memory_change'
  // p13-runtime-accounts: pause / resume a runtime account, or move a job to another account
  | 'account_action'
  // p13-workflows-ui: a workflow definition (new, or a new version of a saved one)
  | 'workflow'
  // p14-skill-catalogs: install a skill from a catalog / GitHub link / import preview (propose_skill_install)
  | 'skill_import'
  // p14-mcp-chat: install an MCP server from a master-resolved preview (propose_mcp_install)
  | 'mcp_install'
  // p19-install-scripts: approve npm install scripts for local MCP installs (draft_install_script_approval)
  | 'install_script_approval'
  // p15-autonomy: a settings / permissions / policy change (change_settings)
  | 'settings_change'
  // p15-autonomy: a job's time limit (draft_time_limit)
  | 'time_limit'
  // p15-services: start / stop / restart a service (start_service, stop_service, restart_service)
  | 'service_action'
  // p15-coolify-create: create a Coolify application / set its variables or domains (coolify_* tools)
  | 'coolify_change'
  // p15-github-create-repo: open a GitHub repository and link it to a project (create_repository)
  | 'github_repo'
  // p17-chat-github: create a project, optionally with a repository and a DNS zone (draft_project_create)
  | 'project_create'
  // p18-multi-project W3 + W5: working projects, attaching a shared workflow, one job per project (a batch)
  | 'thread_projects'
  | 'workflow_attach'
  | 'job_batch'
  // p15-workspace-retention: push a job's kept working files to a repository (export_workfiles)
  | 'workfiles_export'
  // p15-chat-vault: an HTTP request with a vault credential (run_http_request); save a pasted secret (browser-completed)
  | 'http_request'
  | 'credential_save'
  // p16-runtime-updates: a runtime update on machines through the fleet pipeline (draft_runtime_update)
  | 'runtime_update'
  // p16-webhooks-out: create / pause / resume an outgoing webhook (draft_webhook)
  | 'webhook'
  // p16-doctor: build and e-mail the redacted support report (draft_support_report)
  | 'support_report';

export interface ChatThread {
  readonly id: string;
  readonly title: string;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** p9-chat-unread: unread answers / notes since the caller last read it (list rows only; capped at 100). */
  readonly unreadCount?: number;
  /** p10-chat-organize: the caller's pin, group and tags (list rows of newer masters only). */
  readonly pinnedAt?: string | null;
  readonly groupId?: string | null;
  readonly tagIds?: readonly string[];
}

/** p9-chat-unread: the caller's read position in one conversation. */
export interface ChatReadState {
  readonly threadId: string;
  readonly lastReadSeq: number;
  readonly lastReadAt: string;
  readonly unreadCount: number;
}

/** p9-chat-unread: unread totals over the caller's conversations that are not archived. */
export interface ChatUnread {
  readonly total: number;
  readonly threads: number;
}

export interface ChatMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly content: string;
  readonly meta: Record<string, unknown> | null;
  readonly turnId: string | null;
  readonly createdAt: string;
  /** p16-chat-complete: replaced by an edit / regenerate / retry (folded; never sent to a model again). */
  readonly supersededAt?: string;
  readonly supersededBy?: string;
}

export interface ChatDraft {
  readonly id: string;
  readonly threadId: string;
  /** A known `DraftKind`, or a newer kind this console renders generically (p5-chat-ux). */
  readonly kind: DraftKind | (string & {});
  readonly title: string;
  readonly payload: Record<string, unknown>;
  readonly project: string | null;
  readonly state: string;
  readonly result: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  /** p16-chat-complete: a shared reader may not see this card's project ("erişimin yok"). */
  readonly restricted?: boolean;
  /**
   * oss-sec3: the draft would have run at once, but its turn read untrusted content (a job log, a file, a web
   * response …); `rememberable`: the card may offer "remember" for this kind of action on this target.
   */
  readonly held?: { readonly reason: 'untrusted_content'; readonly rememberable: boolean };
}

export interface ChatTurn {
  readonly id: string;
  readonly state: string;
  readonly text: string;
}

/** p6-chat-notify: something the assistant watches for the caller ("let me know when …"). */
export interface ChatWatch {
  readonly id: string;
  readonly threadId: string | null;
  readonly target: { readonly kind: string; readonly id: string };
  readonly label: string;
  readonly project: string | null;
  readonly conditions: readonly string[];
  readonly repeat: 'once' | 'every';
  readonly state: string;
  readonly endReason: string | null;
  readonly fireCount: number;
  readonly lastFiredAt: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Console-relative page of the watched resource. */
  readonly link: string;
  /** p15-watches (Takipler): condition, last and next check of a `check` watch (null: other kinds / older masters). */
  readonly check: ChatWatchCheck | null;
  /** p20-quick: the originating conversation's title (the caller's full list only; null: none / older masters). */
  readonly threadTitle?: string | null;
}

/** p15-watches: one check of a watch (dry test, event, poll). */
export interface ChatWatchCheckRun {
  readonly at: string;
  readonly met: boolean;
  readonly summary: string;
  readonly mode: string;
}

export interface ChatWatchCheck {
  readonly kind: string;
  /** The condition as one sentence (the watch's language). */
  readonly summary: string;
  /** `event`: when its rows change; `poll`: a machine checks it on a schedule. */
  readonly mode: 'event' | 'poll';
  readonly everySec: number | null;
  readonly lastCheck: ChatWatchCheckRun | null;
  readonly nextCheckAt: string | null;
  readonly checking: boolean;
  readonly checks: number;
  /** What it delivered when met (the URL, a status, a value). */
  readonly result: { readonly summary: string; readonly url: string | null } | null;
  readonly hasThen: boolean;
  /** p15-watch-autorun: the `then` step runs by itself (`auto`, where the policy allows) or waits as a card (`ask`). */
  readonly thenMode: 'auto' | 'ask' | null;
}

export interface ThreadDetail {
  readonly thread: ChatThread;
  readonly messages: ChatMessage[];
  readonly drafts: ChatDraft[];
  readonly turn: ChatTurn | null;
  /** p6-chat-notify: active watches of this conversation (older masters: none). */
  readonly watches: ChatWatch[];
  /** p10-semantic-defaults-chat: the thread's project and knowledge sharing (older masters: null). */
  readonly knowledge: ThreadKnowledge | null;
  /** p10-chat-organize: ids of the caller's starred messages (older masters: none). */
  readonly starred: readonly string[];
  /** p14-ask-user: the assistant's question cards of this conversation (older masters: none). */
  readonly questions?: readonly QuestionSet[];
  /** p15-workflow-ai: the workflow this conversation belongs to (the editor's AI panel); null / absent: none. */
  readonly workflow?: ChatWorkflowLink | null;
  /** p16-chat-complete: the caller owns the conversation or reads it shared (read-only), and its owner. */
  readonly access?: 'owner' | 'reader';
  readonly owner?: { readonly id: string; readonly username: string } | null;
  /** p18-plan-mode: plan mode and the active plan (older masters: absent). */
  readonly plan?: ThreadPlan | null;
  /** p22-chat-queue: the owner's messages waiting for the running answer to end (older masters: none). */
  readonly queued?: readonly QueuedMessage[];
}

/** p22-chat-queue: a message written while the assistant was answering; delivered with the next turn. */
export interface QueuedMessage {
  readonly id: string;
  readonly content: string;
  readonly meta: Record<string, unknown>;
  /** How many files it carries. */
  readonly attachments: number;
  /** Why the last delivery attempt waited (`assistant_unavailable`, `rate_limited`, `budget_exceeded`), else null. */
  readonly holdReason: string | null;
  readonly createdAt: string;
}

/** p22-chat-queue: one waiting message (defensive: an unknown shape is left out). */
export function parseQueued(v: unknown): QueuedMessage | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.content !== 'string') return null;
  return {
    id: o.id,
    content: o.content,
    meta: typeof o.meta === 'object' && o.meta !== null ? (o.meta as Record<string, unknown>) : {},
    attachments: typeof o.attachments === 'number' ? o.attachments : 0,
    holdReason: typeof o.holdReason === 'string' ? o.holdReason : null,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
  };
}

/** p15-workflow-ai: a conversation's workflow (name null: a new workflow not saved yet). */
export interface ChatWorkflowLink {
  readonly project: string;
  readonly name: string | null;
  readonly definitionId: string | null;
}

/** p15-workflow-ai: the workflow link of a thread detail (defensive: older masters send none). */
export function parseWorkflowLink(v: unknown): ChatWorkflowLink | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.project !== 'string') return null;
  return {
    project: o.project,
    name: typeof o.name === 'string' ? o.name : null,
    definitionId: typeof o.definitionId === 'string' ? o.definitionId : null,
  };
}

export interface ChatStatus {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly code: string | null;
  readonly message: string | null;
  readonly worker: { readonly id: string; readonly name: string; readonly online: boolean } | null;
  readonly runtime: string;
  readonly model: string | null;
  /** p11-usage-limit-fallback: the fallback engine answers while the main engine is at its usage limit. */
  readonly fallback: boolean;
  /** p11-usage-limit-fallback: the main engine's usage limit, while it lasts (older masters: null). */
  readonly limit: {
    readonly runtime: string;
    readonly until: string;
    readonly resetAt: string | null;
  } | null;
  readonly limits: { readonly turnsPerUserPer10Min: number; readonly userDailyTokens: number | null };
  /**
   * p8-chat-attachments-mentions: what the configured engine takes besides text. Older masters omit it — then
   * nothing beyond text is offered.
   */
  readonly input: ChatInput | null;
  /** p15-chat-failover: the configured primary machine (older masters: null). */
  readonly primary: { readonly id: string; readonly name: string; readonly online: boolean } | null;
  /** p15-chat-failover: which machine of the chain answers and why (older masters: null). */
  readonly routing: ChatRouting | null;
  /** p16-chat-complete: assistant engines the answering machine has ready (regenerate with another). */
  readonly engines?: readonly string[];
  /** p18-plan-mode: the answering machine has the plan tools (older masters: absent → no plan mode). */
  readonly plan?: boolean;
  /**
   * p20-quick: the security policy lets the assistant act directly (a request runs at once, no card); null: unknown
   * (an older master) — the console then promises neither cards nor direct runs.
   */
  readonly direct?: boolean | null;
}

export const ROUTE_REASONS = [
  'primary',
  'pinned',
  'primary_offline',
  'primary_unavailable',
  'primary_unstable',
] as const;
export type RouteReason = (typeof ROUTE_REASONS)[number];

/** p15-chat-failover: the routing summary of `GET /chat/status`. */
export interface ChatRouting {
  readonly machine: 'primary' | 'backup' | null;
  readonly reason: RouteReason | null;
  readonly position: number | null;
  readonly pinned: boolean;
  readonly auto: boolean;
  readonly primaryIssue: { readonly code: string; readonly message: string } | null;
  readonly returnsAt: string | null;
  readonly backups: number;
  readonly pin: { readonly workerId: string; readonly name: string; readonly until: string } | null;
}

/** `ChatStatus.routing`; absent or malformed (older master) → null. */
export function parseRouting(v: unknown): ChatRouting | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const issue = o.primaryIssue as Record<string, unknown> | null | undefined;
  const pin = o.pin as Record<string, unknown> | null | undefined;
  return {
    machine: o.machine === 'primary' || o.machine === 'backup' ? o.machine : null,
    reason: ROUTE_REASONS.find((r) => r === o.reason) ?? null,
    position: typeof o.position === 'number' ? o.position : null,
    pinned: o.pinned === true,
    auto: o.auto !== false,
    primaryIssue:
      issue !== null && typeof issue === 'object' && typeof issue.code === 'string'
        ? { code: issue.code, message: typeof issue.message === 'string' ? issue.message : '' }
        : null,
    returnsAt: typeof o.returnsAt === 'string' ? o.returnsAt : null,
    backups: typeof o.backups === 'number' ? o.backups : 0,
    pin:
      pin !== null &&
      typeof pin === 'object' &&
      typeof pin.workerId === 'string' &&
      typeof pin.until === 'string'
        ? {
            workerId: pin.workerId,
            name: typeof pin.name === 'string' ? pin.name : pin.workerId,
            until: pin.until,
          }
        : null,
  };
}

/** How the assistant engine takes images / PDFs, and whether mentions reach it (p8-chat-attachments-mentions). */
export interface ChatInput {
  readonly images: 'supported' | 'model-dependent' | 'unsupported';
  readonly pdf: boolean;
  readonly mentions: boolean;
  /** Why images / mentions are unavailable (e.g. "update the assistant worker"), or null. */
  readonly reason: string | null;
}

export type AttachmentKind = 'image' | 'pdf' | 'text';

/** An uploaded chat attachment (scrubbed and stored by the master; private to the thread's owner). */
export interface ChatAttachment {
  readonly id: string;
  readonly threadId: string;
  readonly messageId: string | null;
  readonly kind: AttachmentKind;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** What the master removed (exif, gps, xmp, secrets:N …). */
  readonly scrubbed: readonly string[];
  readonly createdAt: string;
}

// p15-chat-vault: `credential` — a vault credential by reference (name and kind; never a value).
export const MENTION_TYPES = [
  'project',
  'thread',
  'output',
  'job',
  'worker',
  'folder',
  'credential',
  // p19-ide W1: lines of a file ("Sohbete ekle" in the code viewer / diff); id = the master's reference id.
  'code',
] as const;
export type MentionType = (typeof MENTION_TYPES)[number];

/** What a message stores for a mention (type + id; the master resolves it as the sender at send time). */
export interface MentionRef {
  readonly type: MentionType;
  readonly id: string;
  readonly project?: string;
}

/** A picker entry (`GET /chat/mentions`). */
export interface MentionItem {
  readonly type: MentionType;
  readonly id: string;
  readonly project: string | null;
  readonly label: string;
  readonly detail: string | null;
}

/** A mention the master left out (not visible to the sender, or unknown). */
export interface DroppedMention {
  readonly type: string;
  readonly id: string;
  readonly reason: string;
}

export interface ChatLimits {
  readonly turnsPerUserPer10Min: number;
  readonly userDailyTokens: number | null;
  readonly dailyTokens: number | null;
  readonly monthlyCostUsd: number | null;
  readonly maxToolCallsPerTurn: number;
}

/** The four runtimes that can run the ops chat assistant (p5-ops-chat-next). */
export const ASSISTANT_RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'] as const;
export type AssistantRuntime = (typeof ASSISTANT_RUNTIMES)[number];

export const ASSISTANT_RUNTIME_LABELS: Readonly<Record<AssistantRuntime, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

export function isAssistantRuntime(v: string): v is AssistantRuntime {
  return (ASSISTANT_RUNTIMES as readonly string[]).includes(v);
}

export interface ChatEngineReadiness {
  readonly runtime: string;
  readonly ready: boolean;
  readonly reason: string | null;
}

/** A worker that runs an assistant host and the engines it reported. */
export interface ChatWorkerEngines {
  readonly workerId: string;
  readonly workerName: string;
  readonly online: boolean;
  readonly disabled: boolean;
  readonly engines: readonly ChatEngineReadiness[];
  readonly reportedAt: string | null;
  /** p15-chat-failover: worker release, whether it runs the assistant (`assistant-v1`), connected since (older masters: null / true). */
  readonly workerVersion: string | null;
  readonly assistantFeature: boolean;
  readonly connectedAt: string | null;
}

export interface ChatSettings {
  readonly enabled: boolean;
  readonly workerId: string | null;
  readonly runtime: string;
  /** Engines per assistant worker (older masters send none). */
  readonly engines: readonly ChatWorkerEngines[];
  readonly modelProfile: string | null;
  /** p11-usage-limit-fallback: the engine the chat continues on while the main one is at its usage limit. */
  readonly fallbackRuntime: string | null;
  readonly fallbackModelProfile: string | null;
  /** p15-model-picker: the engine's / fallback engine's model as a model id (instead of a profile; older masters: null). */
  readonly model: string | null;
  readonly fallbackModel: string | null;
  /** p13-runtime-accounts: the runtime account of the engine and its fallback account (null = the machine's default). */
  readonly account: string | null;
  readonly fallbackAccount: string | null;
  /** p15-chat-failover: the ordered backup assistant machines after the primary (older masters: none). */
  readonly backupWorkerIds: readonly string[];
  readonly limits: ChatLimits;
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
}

export interface UsageCounts {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly unknownTurns: number;
}

export interface ChatUsage {
  readonly limits: ChatLimits;
  readonly me: { readonly today: UsageCounts; readonly month: UsageCounts };
  readonly all: { readonly today: UsageCounts; readonly month: UsageCounts } | null;
}

const ROLES: readonly MessageRole[] = ['user', 'assistant', 'tool', 'error'];
export const KNOWN_DRAFT_KINDS: readonly DraftKind[] = [
  'job',
  'workflow_run',
  'worker_config',
  'approval_decision',
  'job_message',
  'machine_task',
  'tool_install',
  'skill',
  'automation',
  'automation_change',
  'ops_action',
  'monitor',
  'account_action',
];

const DRAFT_KIND = /^[a-z][a-z0-9_]{0,63}$/;

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

function nullableNum(o: Record<string, unknown>, key: string): number | null {
  return o[key] === null ? null : num(o, key);
}

function record(v: unknown): Record<string, unknown> | null {
  return v === null || v === undefined ? null : obj(v);
}

function array(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v;
}

export function parseThread(v: unknown): ChatThread {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    title: str(o, 'title'),
    archived: bool(o, 'archived'),
    createdAt: str(o, 'createdAt'),
    updatedAt: str(o, 'updatedAt'),
    ...(o.unreadCount === undefined ? {} : { unreadCount: int(o, 'unreadCount') }),
    ...(o.pinnedAt === undefined ? {} : { pinnedAt: nullableStr(o, 'pinnedAt') }),
    ...(o.groupId === undefined ? {} : { groupId: nullableStr(o, 'groupId') }),
    ...(o.tagIds === undefined ? {} : { tagIds: strArray(o, 'tagIds') }),
  };
}

export function parseMessage(v: unknown): ChatMessage {
  const o = obj(v);
  const role = str(o, 'role');
  if (!ROLES.includes(role as MessageRole)) throw new ShapeError('role');
  return {
    id: str(o, 'id'),
    seq: int(o, 'seq'),
    role: role as MessageRole,
    content: str(o, 'content'),
    meta: record(o.meta),
    turnId: nullableStr(o, 'turnId'),
    createdAt: str(o, 'createdAt'),
    ...(typeof o.supersededAt === 'string' ? { supersededAt: o.supersededAt } : {}),
    ...(typeof o.supersededBy === 'string' ? { supersededBy: o.supersededBy } : {}),
  };
}

export function parseDraft(v: unknown): ChatDraft {
  const o = obj(v);
  const kind = str(o, 'kind');
  // Newer master kinds (machine tasks, tool installs, skill drafts …) are shown with the generic card.
  if (!DRAFT_KIND.test(kind)) throw new ShapeError('kind');
  return {
    id: str(o, 'id'),
    threadId: str(o, 'threadId'),
    kind,
    title: str(o, 'title'),
    payload: obj(o.payload),
    project: nullableStr(o, 'project'),
    state: str(o, 'state'),
    result: record(o.result),
    createdAt: str(o, 'createdAt'),
    expiresAt: str(o, 'expiresAt'),
    decidedAt: nullableStr(o, 'decidedAt'),
    ...(o.restricted === true ? { restricted: true } : {}),
    ...heldOf(o.held),
  };
}

function heldOf(v: unknown): { held?: NonNullable<ChatDraft['held']> } {
  if (typeof v !== 'object' || v === null) return {};
  const h = v as { reason?: unknown; rememberable?: unknown };
  return h.reason === 'untrusted_content'
    ? { held: { reason: 'untrusted_content', rememberable: h.rememberable === true } }
    : {};
}

/** Console-relative only (never an absolute or protocol-relative URL). */
const LOCAL_LINK = /^\/(?!\/)[A-Za-z0-9/_.:=?&%-]{0,500}$/;

export function parseWatch(v: unknown): ChatWatch {
  const o = obj(v);
  const target = obj(o.target);
  const repeat = str(o, 'repeat');
  if (repeat !== 'once' && repeat !== 'every') throw new ShapeError('repeat');
  const link = str(o, 'link');
  return {
    id: str(o, 'id'),
    threadId: nullableStr(o, 'threadId'),
    target: { kind: str(target, 'kind'), id: str(target, 'id') },
    label: str(o, 'label'),
    project: nullableStr(o, 'project'),
    conditions: strArray(o, 'conditions'),
    repeat,
    state: str(o, 'state'),
    endReason: nullableStr(o, 'endReason'),
    fireCount: int(o, 'fireCount'),
    lastFiredAt: nullableStr(o, 'lastFiredAt'),
    createdAt: str(o, 'createdAt'),
    expiresAt: str(o, 'expiresAt'),
    link: LOCAL_LINK.test(link) ? link : '/chat',
    check: parseWatchCheck(o.check),
    threadTitle: typeof o.threadTitle === 'string' ? o.threadTitle : null,
  };
}

const HTTP_LINK = /^https?:\/\/[^\s<>()[\]`]{1,2000}$/;

function parseWatchCheck(v: unknown): ChatWatchCheck | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const mode = str(o, 'mode');
  const last = o.lastCheck === null || o.lastCheck === undefined ? null : obj(o.lastCheck);
  const result = o.result === null || o.result === undefined ? null : obj(o.result);
  const url = result === null ? null : result.url;
  return {
    kind: str(o, 'kind'),
    summary: str(o, 'summary'),
    mode: mode === 'poll' ? 'poll' : 'event',
    everySec: typeof o.everySec === 'number' ? o.everySec : null,
    lastCheck:
      last === null
        ? null
        : {
            at: str(last, 'at'),
            met: bool(last, 'met'),
            summary: str(last, 'summary'),
            mode: str(last, 'mode'),
          },
    nextCheckAt: nullableStr(o, 'nextCheckAt'),
    checking: bool(o, 'checking'),
    checks: int(o, 'checks'),
    result:
      result === null
        ? null
        : {
            summary: typeof result.summary === 'string' ? result.summary : '',
            url: typeof url === 'string' && HTTP_LINK.test(url) ? url : null,
          },
    hasThen: o.then !== null && o.then !== undefined,
    thenMode: o.then === null || o.then === undefined ? null : obj(o.then).mode === 'auto' ? 'auto' : 'ask',
  };
}

function parseTurn(v: unknown): ChatTurn | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return { id: str(o, 'id'), state: str(o, 'state'), text: str(o, 'text') };
}

export function parseStatus(v: unknown): ChatStatus {
  const o = obj(v);
  const w = o.worker === null ? null : obj(o.worker);
  const l = obj(o.limits);
  return {
    enabled: bool(o, 'enabled'),
    available: bool(o, 'available'),
    code: nullableStr(o, 'code'),
    message: nullableStr(o, 'message'),
    worker: w === null ? null : { id: str(w, 'id'), name: str(w, 'name'), online: bool(w, 'online') },
    runtime: str(o, 'runtime'),
    model: nullableStr(o, 'model'),
    fallback: o.fallback === true,
    limit: (() => {
      if (typeof o.limit !== 'object' || o.limit === null) return null;
      const x = o.limit as Record<string, unknown>;
      return typeof x.runtime === 'string' && typeof x.until === 'string'
        ? { runtime: x.runtime, until: x.until, resetAt: typeof x.resetAt === 'string' ? x.resetAt : null }
        : null;
    })(),
    limits: {
      turnsPerUserPer10Min: num(l, 'turnsPerUserPer10Min'),
      userDailyTokens: nullableNum(l, 'userDailyTokens'),
    },
    input: parseInput(o.input),
    primary: (() => {
      if (o.primary === null || typeof o.primary !== 'object') return null;
      const p = obj(o.primary);
      return { id: str(p, 'id'), name: str(p, 'name'), online: bool(p, 'online') };
    })(),
    routing: parseRouting(o.routing),
    engines: Array.isArray(o.engines) ? o.engines.filter((e): e is string => typeof e === 'string') : [],
    plan: o.plan === true,
    direct: typeof o.direct === 'boolean' ? o.direct : null,
  };
}

const IMAGE_SUPPORT = ['supported', 'model-dependent', 'unsupported'] as const;

/** `ChatStatus.input`; absent or malformed (older master) → null: text only. */
export function parseInput(v: unknown): ChatInput | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const images = IMAGE_SUPPORT.find((x) => x === o.images);
  if (images === undefined) return null;
  return {
    images,
    pdf: o.pdf === true,
    mentions: o.mentions === true,
    reason: typeof o.reason === 'string' ? o.reason.slice(0, 300) : null,
  };
}

const ATTACHMENT_KINDS: readonly AttachmentKind[] = ['image', 'pdf', 'text'];

export function parseAttachment(v: unknown): ChatAttachment {
  const o = obj(v);
  const kind = str(o, 'kind');
  if (!ATTACHMENT_KINDS.includes(kind as AttachmentKind)) throw new ShapeError('kind');
  const id = str(o, 'id');
  if (!UUID_RE.test(id)) throw new ShapeError('id');
  return {
    id,
    threadId: str(o, 'threadId'),
    messageId: nullableStr(o, 'messageId'),
    kind: kind as AttachmentKind,
    name: str(o, 'name'),
    mediaType: str(o, 'mediaType'),
    sizeBytes: num(o, 'sizeBytes'),
    sha256: str(o, 'sha256'),
    scrubbed: Array.isArray(o.scrubbed) ? o.scrubbed.filter((x): x is string => typeof x === 'string') : [],
    createdAt: str(o, 'createdAt'),
  };
}

export function isMentionType(v: unknown): v is MentionType {
  return typeof v === 'string' && (MENTION_TYPES as readonly string[]).includes(v);
}

export function parseMentionItem(v: unknown): MentionItem {
  const o = obj(v);
  const type = o.type;
  if (!isMentionType(type)) throw new ShapeError('type');
  return {
    type,
    id: str(o, 'id'),
    project: o.project === undefined ? null : nullableStr(o, 'project'),
    label: str(o, 'label'),
    detail: o.detail === undefined ? null : nullableStr(o, 'detail'),
  };
}

function parseLimits(v: unknown): ChatLimits {
  const o = obj(v);
  return {
    turnsPerUserPer10Min: num(o, 'turnsPerUserPer10Min'),
    userDailyTokens: nullableNum(o, 'userDailyTokens'),
    dailyTokens: nullableNum(o, 'dailyTokens'),
    monthlyCostUsd: nullableNum(o, 'monthlyCostUsd'),
    maxToolCallsPerTurn: num(o, 'maxToolCallsPerTurn'),
  };
}

function parseWorkerEngines(v: unknown): ChatWorkerEngines {
  const o = obj(v);
  return {
    workerId: str(o, 'workerId'),
    workerName: str(o, 'workerName'),
    online: bool(o, 'online'),
    disabled: bool(o, 'disabled'),
    engines: array(o.engines).map((e) => {
      const x = obj(e);
      return {
        runtime: str(x, 'runtime'),
        ready: bool(x, 'ready'),
        reason: typeof x.reason === 'string' ? x.reason : null,
      };
    }),
    reportedAt: o.reportedAt === undefined ? null : nullableStr(o, 'reportedAt'),
    workerVersion: typeof o.workerVersion === 'string' ? o.workerVersion : null,
    assistantFeature: o.assistantFeature !== false,
    connectedAt: typeof o.connectedAt === 'string' ? o.connectedAt : null,
  };
}

export function parseSettings(v: unknown): ChatSettings {
  const o = obj(v);
  return {
    enabled: bool(o, 'enabled'),
    workerId: nullableStr(o, 'workerId'),
    runtime: str(o, 'runtime'),
    engines: o.engines === undefined ? [] : array(o.engines).map(parseWorkerEngines),
    modelProfile: nullableStr(o, 'modelProfile'),
    fallbackRuntime: typeof o.fallbackRuntime === 'string' ? o.fallbackRuntime : null,
    fallbackModelProfile: typeof o.fallbackModelProfile === 'string' ? o.fallbackModelProfile : null,
    model: typeof o.model === 'string' ? o.model : null,
    fallbackModel: typeof o.fallbackModel === 'string' ? o.fallbackModel : null,
    account: typeof o.account === 'string' ? o.account : null,
    fallbackAccount: typeof o.fallbackAccount === 'string' ? o.fallbackAccount : null,
    backupWorkerIds: Array.isArray(o.backupWorkerIds)
      ? o.backupWorkerIds.filter((x): x is string => typeof x === 'string')
      : [],
    limits: parseLimits(o.limits),
    version: int(o, 'version'),
    updatedBy: nullableStr(o, 'updatedBy'),
    updatedAt: str(o, 'updatedAt'),
  };
}

function parseCounts(v: unknown): UsageCounts {
  const o = obj(v);
  return {
    turns: num(o, 'turns'),
    inputTokens: num(o, 'inputTokens'),
    outputTokens: num(o, 'outputTokens'),
    costUsd: num(o, 'costUsd'),
    unknownTurns: num(o, 'unknownTurns'),
  };
}

function parsePeriod(v: unknown): { today: UsageCounts; month: UsageCounts } {
  const o = obj(v);
  return { today: parseCounts(o.today), month: parseCounts(o.month) };
}

export function parseUsage(v: unknown): ChatUsage {
  const o = obj(v);
  return {
    limits: parseLimits(o.limits),
    me: parsePeriod(o.me),
    all: o.all === null ? null : parsePeriod(o.all),
  };
}

const t = (id: string): string => `/chat/threads/${encodeURIComponent(id)}`;

export function getChatStatus(opts: Opts = {}): Promise<ChatStatus> {
  return apiRequest('GET', '/chat/status', parseStatus, opts);
}

export function listThreads(
  q: { q?: string; archived?: boolean } = {},
  opts: Opts = {},
): Promise<ChatThread[]> {
  const p = new URLSearchParams();
  if (q.q !== undefined && q.q.trim() !== '') p.set('q', q.q.trim());
  if (q.archived === true) p.set('archived', 'true');
  const s = p.toString();
  return apiRequest(
    'GET',
    `/chat/threads${s === '' ? '' : `?${s}`}`,
    (v) => array(obj(v).items).map(parseThread),
    opts,
  );
}

/**
 * p9-pagination: one page of the caller's conversations (most recently active first). The thread list is a
 * stream: the console shows the first page and appends the next one on "Load more conversations".
 */
export function listThreadsPage(
  q: {
    q?: string;
    archived?: boolean;
    limit?: number;
    cursor?: string | null;
    /** p10-chat-organize: the pinned section (true) or the rest (false); a group id or 'none'; a tag id. */
    pinned?: boolean;
    group?: string;
    tag?: string;
  } = {},
  opts: Opts = {},
): Promise<{
  items: ChatThread[];
  nextCursor: string | null;
  organize: ChatOrganize | null;
  /** p16-chat-complete: conversations shared with the caller (the first plain page only; empty otherwise). */
  shared: SharedThread[];
}> {
  const p = new URLSearchParams();
  if (q.q !== undefined && q.q.trim() !== '') p.set('q', q.q.trim());
  if (q.archived === true) p.set('archived', 'true');
  if (q.pinned !== undefined) p.set('pinned', String(q.pinned));
  if (q.group !== undefined) p.set('group', q.group);
  if (q.tag !== undefined) p.set('tag', q.tag);
  if (q.limit !== undefined) p.set('limit', String(q.limit));
  if (q.cursor !== undefined && q.cursor !== null) p.set('cursor', q.cursor);
  const s = p.toString();
  return apiRequest(
    'GET',
    `/chat/threads${s === '' ? '' : `?${s}`}`,
    (v) => {
      const o = obj(v);
      const next = o.nextCursor;
      return {
        items: array(o.items).map(parseThread),
        nextCursor: typeof next === 'string' ? next : null,
        organize: parseOrganize(o.organize),
        shared: Array.isArray(o.shared) ? o.shared.map(parseSharedThread) : [],
      };
    },
    opts,
  );
}

/** p16-chat-complete: a conversation another user shared with the caller (read-only). */
export interface SharedThread extends ChatThread {
  readonly owner: { readonly id: string; readonly username: string };
  readonly sharedAt: string;
}

export function parseSharedThread(v: unknown): SharedThread {
  const o = obj(v);
  const owner = obj(o.owner);
  return {
    ...parseThread(v),
    owner: { id: str(owner, 'id'), username: str(owner, 'username') },
    sharedAt: str(o, 'sharedAt'),
  };
}

export function createThread(opts: Opts = {}): Promise<ChatThread> {
  return apiRequest('POST', '/chat/threads', parseThread, { ...opts, body: {} });
}

export function getThread(id: string, opts: Opts = {}): Promise<ThreadDetail> {
  return apiRequest(
    'GET',
    t(id),
    (v) => {
      const o = obj(v);
      return {
        thread: parseThread(o.thread),
        messages: array(o.messages).map(parseMessage),
        drafts: array(o.drafts).map(parseDraft),
        turn: parseTurn(o.turn),
        watches: o.watches === undefined ? [] : array(o.watches).map(parseWatch),
        knowledge:
          o.knowledge === undefined || o.knowledge === null ? null : parseThreadKnowledge(o.knowledge),
        starred: Array.isArray(o.starred) ? o.starred.filter((x): x is string => typeof x === 'string') : [],
        questions: threadQuestions(o.questions),
        workflow: parseWorkflowLink(o.workflow),
        plan: parseThreadPlan(o.plan),
        queued: Array.isArray(o.queued)
          ? o.queued.map(parseQueued).filter((q): q is QueuedMessage => q !== null)
          : [],
        ...(o.access === 'reader' || o.access === 'owner' ? { access: o.access } : {}),
        ...(typeof o.owner === 'object' && o.owner !== null
          ? {
              owner: {
                id: str(obj(o.owner), 'id'),
                username: str(obj(o.owner), 'username'),
              },
            }
          : {}),
      };
    },
    opts,
  );
}

export function updateThread(
  id: string,
  patch: { title?: string; archived?: boolean },
  opts: Opts = {},
): Promise<ChatThread> {
  return apiRequest('PATCH', t(id), parseThread, { ...opts, body: patch });
}

export function deleteThread(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', t(id), () => undefined, opts);
}

/** p8-chat-attachments-mentions: what a message carries besides its text. */
export interface SendExtras {
  readonly attachments?: readonly string[];
  readonly mentions?: readonly MentionRef[];
  /** p15-chat-zip: ready site uploads (a .zip the composer unpacked and uploaded). */
  readonly siteUploads?: readonly string[];
  /** p15-chat-zip: .zip files that are not a publishable site (a note only). */
  readonly archives?: readonly {
    readonly name: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly problems: readonly string[];
  }[];
  /** p16-zip-job-input: ready job input bundles (a .zip the composer unpacked for a job). */
  readonly inputUploads?: readonly string[];
  /** p17-chat-flow: "Sohbette düzenle" — the open workflow card this message changes. */
  readonly editDraft?: string;
  /** p18-plan-mode: `/plan …` / the Planla chip — plan mode is turned on with this message. */
  readonly mode?: 'plan';
  /** p22-chat-queue: while the assistant answers, the message waits for the next turn (instead of 409). */
  readonly queue?: boolean;
}

export function sendMessage(
  id: string,
  text: string,
  opts: Opts = {},
  extras: SendExtras = {},
): Promise<{
  /** Null when the message was queued (p22-chat-queue). */
  message: ChatMessage | null;
  turnId: string | null;
  dropped: DroppedMention[];
  /** p22-chat-queue: the message waits for the running answer to end. */
  queued: QueuedMessage | null;
}> {
  const attachments = extras.attachments ?? [];
  const mentions = extras.mentions ?? [];
  const zone = browserTimeZone();
  return apiRequest(
    'POST',
    `${t(id)}/messages`,
    (v) => {
      const o = obj(v);
      const dropped = Array.isArray(o.dropped)
        ? o.dropped.flatMap((d): DroppedMention[] => {
            if (d === null || typeof d !== 'object') return [];
            const x = d as Record<string, unknown>;
            return typeof x.type === 'string' && typeof x.id === 'string'
              ? [{ type: x.type, id: x.id, reason: typeof x.reason === 'string' ? x.reason : 'not_visible' }]
              : [];
          })
        : [];
      const queued = o.queued === undefined ? null : parseQueued(o.queued);
      if (queued !== null) return { message: null, turnId: null, dropped, queued };
      return { message: parseMessage(o.message), turnId: str(o, 'turnId'), dropped, queued: null };
    },
    {
      ...opts,
      body: {
        text,
        ...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
        ...(mentions.length === 0
          ? {}
          : {
              mentions: mentions.map((m) => ({
                type: m.type,
                id: m.id,
                ...(m.project === undefined ? {} : { project: m.project }),
              })),
            }),
        ...((extras.siteUploads ?? []).length === 0 ? {} : { siteUploads: [...(extras.siteUploads ?? [])] }),
        ...((extras.archives ?? []).length === 0
          ? {}
          : { archives: (extras.archives ?? []).map((a) => ({ ...a, problems: [...a.problems] })) }),
        ...((extras.inputUploads ?? []).length === 0
          ? {}
          : { inputUploads: [...(extras.inputUploads ?? [])] }),
        // p16-workflow-quality: the sender's zone — the default zone of schedules the assistant drafts.
        ...(zone === null ? {} : { timeZone: zone }),
        ...(extras.editDraft === undefined ? {} : { editDraft: extras.editDraft }),
        ...(extras.mode === undefined ? {} : { mode: extras.mode }),
        ...(extras.queue === true ? { queue: true } : {}),
      },
    },
  );
}

/** p22-chat-queue: changes the text of a waiting message (409 `not_queued` once it was sent). */
export function editQueuedMessage(
  threadId: string,
  id: string,
  text: string,
  opts: Opts = {},
): Promise<void> {
  return apiRequest('PATCH', `${t(threadId)}/queued/${encodeURIComponent(id)}`, () => undefined, {
    ...opts,
    body: { text },
  });
}

/** p22-chat-queue: removes a waiting message before it is sent. */
export function deleteQueuedMessage(threadId: string, id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `${t(threadId)}/queued/${encodeURIComponent(id)}`, () => undefined, opts);
}

/** p8-chat-attachments-mentions: upload one file (base64) into a thread; bound to the next message sent. */
export function uploadAttachment(
  threadId: string,
  name: string,
  contentBase64: string,
  opts: Opts = {},
): Promise<ChatAttachment> {
  return apiRequest('POST', `${t(threadId)}/attachments`, parseAttachment, {
    ...opts,
    body: { name, contentBase64 },
  });
}

/** Removes an upload that was not sent yet. */
export function deleteAttachment(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/chat/attachments/${encodeURIComponent(id)}`, () => undefined, opts);
}

/** Same-origin URL of an attachment's (scrubbed) content; null for an id that is not a UUID. */
export function attachmentUrl(id: string): string | null {
  return UUID_RE.test(id) ? `${API_PREFIX}/chat/attachments/${id}/content` : null;
}

/** The `@` picker: projects, own conversations, outputs, jobs and machines the caller can see. */
export function searchMentions(q: string, type?: MentionType, opts: Opts = {}): Promise<MentionItem[]> {
  const p = new URLSearchParams();
  p.set('q', q);
  if (type !== undefined) p.set('type', type);
  return apiRequest(
    'GET',
    `/chat/mentions?${p.toString()}`,
    (v) =>
      array(obj(v).items).flatMap((i) => {
        try {
          return [parseMentionItem(i)];
        } catch {
          return []; // a newer master's unknown type is skipped
        }
      }),
    opts,
  );
}

/** p9-chat-unread: marks a conversation read up to `seq` (default: its latest message). Idempotent. */
export function markThreadRead(id: string, seq?: number, opts: Opts = {}): Promise<ChatReadState> {
  return apiRequest(
    'POST',
    `${t(id)}/read`,
    (v) => {
      const o = obj(v);
      return {
        threadId: str(o, 'threadId'),
        lastReadSeq: int(o, 'lastReadSeq'),
        lastReadAt: str(o, 'lastReadAt'),
        unreadCount: int(o, 'unreadCount'),
      };
    },
    { ...opts, body: seq === undefined ? {} : { seq } },
  );
}

/**
 * p12-chat-scroll-anchor: the caller's read position in a conversation without moving it. The master's read mark is
 * monotonic (`GREATEST`), so marking up to seq 0 never changes a position and answers with the current one; the
 * Sohbet screen reads it before its own read mark to open at the first unread message.
 */
export function readPosition(id: string, opts: Opts = {}): Promise<ChatReadState> {
  return markThreadRead(id, 0, opts);
}

export function markAllThreadsRead(opts: Opts = {}): Promise<number> {
  return apiRequest('POST', '/chat/threads/read-all', (v) => int(obj(v), 'updated'), { ...opts, body: {} });
}

export function getChatUnread(opts: Opts = {}): Promise<ChatUnread> {
  return apiRequest(
    'GET',
    '/chat/unread',
    (v) => {
      const o = obj(v);
      return { total: int(o, 'total'), threads: int(o, 'threads') };
    },
    opts,
  );
}

export function cancelTurn(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('POST', `${t(id)}/cancel`, () => undefined, { ...opts, body: {} });
}

export function confirmDraft(
  id: string,
  opts: Opts = {},
  /** p6-approval-mode-switch: the approval mode the user picked on a job / machine-task card (absent: as drafted). */
  overrides: {
    readonly approvalPolicy?: string;
    readonly priorityClass?: string;
    /** p10-chat-job-actions: the jobs left checked on a job action card (absent: all). */
    readonly jobIds?: readonly string[];
    /** p14-mcp-chat: an MCP install card's "turn on MCP for this project" box (sent only when ticked). */
    readonly enableMcpProject?: boolean;
    /** oss-sec3: a card held for untrusted content — remember this kind of action on this target (only when ticked). */
    readonly remember?: boolean;
  } = {},
): Promise<{ draft: ChatDraft; result: Record<string, unknown> }> {
  return apiRequest(
    'POST',
    `/chat/drafts/${encodeURIComponent(id)}/confirm`,
    (v) => {
      const o = obj(v);
      return { draft: parseDraft(o.draft), result: obj(o.result) };
    },
    {
      ...opts,
      body: {
        ...(overrides.approvalPolicy === undefined ? {} : { approvalPolicy: overrides.approvalPolicy }),
        // p9-queue-priority: the class the user picked on a job / workflow-run card.
        ...(overrides.priorityClass === undefined ? {} : { priorityClass: overrides.priorityClass }),
        ...(overrides.jobIds === undefined ? {} : { jobIds: overrides.jobIds }),
        ...(overrides.enableMcpProject === undefined ? {} : { enableMcpProject: overrides.enableMcpProject }),
        ...(overrides.remember === true ? { remember: true } : {}),
      },
    },
  );
}

/**
 * p10-chat-job-actions: a quick button on a job card (Cancel, Run again) drafts a job action card in the conversation —
 * nothing runs until the user confirms that card like any other.
 */
export function draftJobAction(
  threadId: string,
  body: {
    readonly action: 'cancel' | 'run_again';
    readonly jobIds: readonly string[];
    readonly reason?: string;
  },
  opts: Opts = {},
): Promise<ChatDraft> {
  return apiRequest('POST', `/chat/threads/${encodeURIComponent(threadId)}/job-actions`, parseDraft, {
    ...opts,
    body,
  });
}

/**
 * p12-diyalog-f3: what a person can change on an open job card before confirming it (`PATCH /chat/drafts/:id`). The
 * master rebuilds the card with the assistant's own draft_job checks for the caller and answers the new version; null
 * removes (machines pin → placement chooses, deploy when done, input files) or resets (verify → project default).
 */
export interface DraftEdit {
  readonly title?: string;
  readonly project?: string;
  readonly runtime?: string;
  readonly prompt?: string;
  readonly priorityClass?: 'urgent' | 'normal' | 'background';
  readonly approvalPolicy?: string;
  readonly sandboxProfile?: string;
  readonly workers?: readonly string[] | null;
  readonly deployOnSuccess?: null;
  readonly deployEnv?: 'preview' | 'production';
  readonly verifyOnSuccess?: 'off' | 'report' | 'gate' | null;
  readonly inputs?: null;
  /** p15-autonomy: the job's time limit (s). */
  readonly maxDurationSec?: number;
}

export function editDraft(id: string, edit: DraftEdit, opts: Opts = {}): Promise<ChatDraft> {
  return apiRequest('PATCH', `/chat/drafts/${encodeURIComponent(id)}`, parseDraft, { ...opts, body: edit });
}

/**
 * p15-chat-vault: the browser sealed a pasted value and created vault credential `credentialId` (POST /vault/credentials)
 * for an open "save to vault" card — the master marks the card done. No value travels here.
 */
export function markCredentialSaved(
  id: string,
  credentialId: string,
  opts: Opts = {},
): Promise<{ draft: ChatDraft; result: Record<string, unknown> }> {
  return apiRequest(
    'POST',
    `/chat/drafts/${encodeURIComponent(id)}/credential-saved`,
    (v) => {
      const o = obj(v);
      return { draft: parseDraft(o.draft), result: obj(o.result) };
    },
    { ...opts, body: { credentialId } },
  );
}

export function dismissDraft(id: string, opts: Opts = {}): Promise<ChatDraft> {
  return apiRequest('POST', `/chat/drafts/${encodeURIComponent(id)}/dismiss`, parseDraft, {
    ...opts,
    body: {},
  });
}

/** p6-chat-notify: the caller's watches (of one conversation, or all). */
export function listWatches(
  q: { threadId?: string; includeEnded?: boolean } = {},
  opts: Opts = {},
): Promise<ChatWatch[]> {
  const p = new URLSearchParams();
  if (q.threadId !== undefined) p.set('threadId', q.threadId);
  if (q.includeEnded === true) p.set('includeEnded', 'true');
  const qs = p.toString();
  return apiRequest(
    'GET',
    `/chat/watches${qs === '' ? '' : `?${qs}`}`,
    (v) => array(obj(v).items).map(parseWatch),
    opts,
  );
}

export function cancelWatch(id: string, opts: Opts = {}): Promise<ChatWatch> {
  return apiRequest('DELETE', `/chat/watches/${encodeURIComponent(id)}`, parseWatch, opts);
}

export function getChatUsage(opts: Opts = {}): Promise<ChatUsage> {
  return apiRequest('GET', '/chat/usage', parseUsage, opts);
}

export function getChatSettings(opts: Opts = {}): Promise<ChatSettings> {
  return apiRequest('GET', '/chat/settings', parseSettings, opts);
}

export function putChatSettings(
  body: {
    enabled: boolean;
    workerId: string | null;
    runtime: AssistantRuntime;
    modelProfile: string | null;
    /** p11-usage-limit-fallback: absent = unchanged; null = none. */
    fallbackRuntime?: AssistantRuntime | null;
    fallbackModelProfile?: string | null;
    /** p15-model-picker: a model id instead of a profile (absent = unchanged; null = none). */
    model?: string | null;
    fallbackModel?: string | null;
    /** p13-runtime-accounts: absent = unchanged; null = the machine's default account. */
    account?: string | null;
    fallbackAccount?: string | null;
    /** p15-chat-failover: absent = unchanged; the ordered backup machines. */
    backupWorkerIds?: readonly string[];
    limits: ChatLimits;
    expectedVersion: number;
  },
  opts: Opts = {},
): Promise<ChatSettings> {
  return apiRequest('PUT', '/chat/settings', parseSettings, { ...opts, body });
}

/** p15-message-delivery: `live` = the agent runs (sent now); `queue` = held until it runs. */
export type JobMessageMode = 'live' | 'queue';

export function getJobMessageStatus(
  jobId: string,
  opts: Opts = {},
): Promise<{ supported: boolean; reason: string | null; mode: JobMessageMode | null }> {
  return apiRequest(
    'GET',
    `/jobs/${encodeURIComponent(jobId)}/messages/status`,
    (v) => {
      const o = obj(v);
      const mode = o.mode === 'live' || o.mode === 'queue' ? o.mode : null;
      // Older masters have no `mode`: a supported box was always live.
      return {
        supported: bool(o, 'supported'),
        reason: nullableStr(o, 'reason'),
        mode: mode ?? (bool(o, 'supported') ? 'live' : null),
      };
    },
    opts,
  );
}

/** p15-message-delivery: how far one message to the job's agent got. */
export type JobMessageDelivery = (typeof JOB_MESSAGE_STATUSES)[number];

export interface JobMessageItem {
  readonly id: string;
  readonly text: string;
  readonly source: 'panel' | 'chat';
  readonly sentBy: string;
  readonly sentByName: string | null;
  readonly status: JobMessageDelivery;
  readonly code: string | null;
  readonly detail: string | null;
  readonly receipts: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function parseJobMessage(v: unknown): JobMessageItem {
  const o = obj(v);
  const status = str(o, 'status');
  return {
    id: str(o, 'id'),
    text: str(o, 'text'),
    source: o.source === 'chat' ? 'chat' : 'panel',
    sentBy: str(o, 'sentBy'),
    sentByName: nullableStr(o, 'sentByName'),
    status: (JOB_MESSAGE_STATUSES as readonly string[]).includes(status)
      ? (status as JobMessageDelivery)
      : 'failed',
    code: nullableStr(o, 'code'),
    detail: nullableStr(o, 'detail'),
    receipts: o.receipts === true,
    createdAt: str(o, 'createdAt'),
    updatedAt: str(o, 'updatedAt'),
  };
}

export function listJobMessages(jobId: string, opts: Opts = {}): Promise<JobMessageItem[]> {
  return apiRequest(
    'GET',
    `/jobs/${encodeURIComponent(jobId)}/messages`,
    (v) => {
      const list = obj(v).messages;
      return Array.isArray(list) ? list.map(parseJobMessage) : [];
    },
    opts,
  );
}

export function sendJobMessage(
  jobId: string,
  text: string,
  opts: Opts & { readonly clientId?: string } = {},
): Promise<{ messageId: string; status: JobMessageDelivery }> {
  const { clientId, ...rest } = opts;
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/messages`,
    (v) => {
      const o = obj(v);
      const status = typeof o.status === 'string' ? o.status : 'sent';
      return {
        messageId: str(o, 'messageId'),
        status: (JOB_MESSAGE_STATUSES as readonly string[]).includes(status)
          ? (status as JobMessageDelivery)
          : 'sent',
      };
    },
    // p15-message-delivery: one clientId per typed message — a retried request is the same message.
    { ...rest, body: { text, ...(clientId === undefined ? {} : { clientId }) } },
  );
}

/** Same-origin SSE URL of a thread's live view (the session cookie goes along). */
export function chatStreamUrl(id: string): string {
  return `${API_PREFIX}${t(id)}/stream`;
}

/** oss-sec3: one of the caller's remembered confirmations (cards held because a turn read untrusted content). */
export interface UntrustedAllow {
  readonly id: string;
  readonly action: string;
  readonly target: string;
  readonly label: string;
  readonly threadId: string | null;
  readonly createdAt: string;
}

export function listUntrustedAllows(opts: Opts = {}): Promise<UntrustedAllow[]> {
  return apiRequest(
    'GET',
    '/chat/untrusted-allows',
    (v) =>
      array(obj(v).allows).map((x) => {
        const o = obj(x);
        return {
          id: str(o, 'id'),
          action: str(o, 'action'),
          target: typeof o.target === 'string' ? o.target : '',
          label: str(o, 'label'),
          threadId: nullableStr(o, 'threadId'),
          createdAt: str(o, 'createdAt'),
        };
      }),
    opts,
  );
}

export function revokeUntrustedAllow(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/chat/untrusted-allows/${encodeURIComponent(id)}`, () => undefined, opts);
}
