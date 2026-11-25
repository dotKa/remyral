import { randomUUID } from 'node:crypto';
import {
  MAX_ASSISTANT_MESSAGE,
  PLAN_LIMITS,
  PlanCreateInput,
  type PlanEstimate,
  type PlanItemStatus,
  type PlanLink,
  type PlanOwner,
  type PlanSetStateTarget,
  type PlanState,
  type PlanStatusChange,
  type PlanUpdateOp,
  PlanUserEdit,
  planStructureIssues,
  type QuestionAnswer,
  UserQuestionInput,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { NotificationService } from '../notifications/service.js';
import type { QuestionService, QuestionView } from '../questions/service.js';
import type { ActorContext } from '../workers/fleet.js';
import { batchState } from '../jobs/batches.js';
import { threadProjectIds } from './thread-projects.js';
import {
  ACTIVE,
  anythingUnderway,
  applyUpdateOps,
  applyUserOps,
  type BlockDecision,
  checkStatusChange,
  clipNote,
  composePlanMessage,
  type Derived,
  derivedStatus,
  failuresAfter,
  diffCounts,
  diffSnapshots,
  itemsFromCreate,
  type LinkFacts,
  ordered,
  outputJob,
  PLAN_AUTONOMY_INSTRUCTION,
  PLAN_ITEM_FAILURE_CAP,
  PLAN_MODE_INSTRUCTION,
  planBlock,
  type DiffItem,
  diffItems,
  type PlanDiff,
  type PlanItem,
  PlanOpError,
  type PlanSnapshot,
  type Progress,
  progressMark,
  progressOf,
  readyItems,
  shapeOf,
  type StatusBy,
  type UserEditView,
  userEditView,
} from './plan-model.js';
import { type PlanNoticeKind, planNotice } from './plan-notify.js';
import {
  claimDelivery,
  completeDelivery,
  type DeliveryRef,
  failDelivery,
  reapDeliveries,
  releaseDelivery,
} from './deliveries.js';
import type { ChatStore, DraftRecord, ThreadView } from './store.js';
import { guessLanguage } from './watches.js';
import { followCheckedJobs } from '../verify/platform-marker.js';

/**
 * p18-plan-mode (docs/design/p18-plan-mode.md): the plan of a Sohbet conversation — plan mode, the plan the assistant
 * writes and revises, the person's review (decisions, approval, change requests, edits), execution with live progress
 * (statuses the items take from their cards, jobs and runs) and the continuation turns that carry an approved plan on
 * when what it waited for is resolved.
 *
 * Authority: the master. A plan grants nothing — every side effect of an item is still a normal card of a system
 * turn (`byUser: false`), confirmed, stepped-up and audited as any other. Only the conversation's owner changes a plan;
 * shared readers read it. Plan texts are model / person text: stored as data, bounded, rendered as text.
 */

export interface PlanDecisionView {
  readonly id: string;
  readonly itemKey: string | null;
  readonly prompt: string;
  readonly kind: 'single' | 'multi' | 'text';
  readonly options: readonly { readonly label: string; readonly description?: string | undefined }[];
  readonly recommended: string | null;
  readonly rationale: string | null;
  readonly state: QuestionView['state'];
  readonly answers: readonly QuestionAnswer[] | null;
  /** The answer as one line ("preview"), null while open. */
  readonly answer: string | null;
  readonly createdAt: string;
  readonly answeredAt: string | null;
}

export interface PlanItemView extends PlanItem {
  /** An open decision is tied to this item (it waits; shown as "Karar gerekiyor"). */
  readonly decisionOpen: boolean;
  /**
   * p18-plan-autonomy: the item waits for the person's card (its newest link is a proposed card — a step the plan could
   * not run by itself, or every card of a plan that is not autonomous): "Senden bekleniyor".
   */
  readonly awaitsUser: boolean;
  /** p18-plan-autonomy: consecutive failed attempts (job / run failed); at PLAN_ITEM_FAILURE_CAP no more retries. */
  readonly failures: number;
}

export interface PlanView {
  readonly id: string;
  readonly threadId: string;
  readonly title: string;
  readonly goal: string;
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
  readonly state: PlanState;
  readonly version: number;
  readonly rev: number;
  readonly approvedVersion: number | null;
  /** p18-plan-autonomy: continuation drafts run at once (approved with "Otonom yürüt"). */
  readonly autonomous: boolean;
  /** Why an executing plan does not go on by itself (cost_brake, budget, no_progress, turn_failed), else null. */
  readonly stalled: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly phases: readonly { readonly index: number; readonly title: string }[];
  readonly items: readonly PlanItemView[];
  readonly decisions: readonly PlanDecisionView[];
  readonly progress: Progress;
  /** The newest version's change against the one before it ("v2 · 3 değişiklik"); null for version 1. */
  readonly lastChange: {
    readonly version: number;
    readonly author: 'assistant' | 'user';
    readonly reason: string | null;
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly moved: number;
  } | null;
}

export interface PlanSummary {
  readonly id: string;
  readonly title: string;
  readonly state: PlanState;
  readonly version: number;
  readonly done: number;
  readonly total: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

/**
 * p18-plan-mode W4: a plan of the caller that waits for them ("Senden bekleyen"): its open decisions (answered in place
 * through the question answer route — the same rows as the panel and the card) and the items that wait for them.
 */
export interface PlanNeedView {
  readonly planId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly title: string;
  readonly state: PlanState;
  readonly rev: number;
  /** The plan stalled ("Plana devam edeyim mi?"): the reason, else null. */
  readonly stalled: string | null;
  /** The open decisions as question rows (the console answers them with its question card, through the same route). */
  readonly questions: readonly QuestionView[];
  /**
   * Items waiting for the person: `card` — its card waits for confirmation; `blocked` — blocked and not retried by
   * itself (capped, or blocked by the assistant with a reason); `mine` — their own item is ready in an executing plan.
   */
  readonly waiting: readonly PlanNeedItem[];
  readonly updatedAt: string;
}

export interface PlanNeedItem {
  readonly key: string;
  readonly title: string;
  readonly why: 'card' | 'blocked' | 'mine';
  readonly note: string | null;
}

/** What waits for the person in an executing plan (pure; see {@link PlanNeedView}). */
export function waitingItems(items: readonly PlanItemView[]): PlanNeedItem[] {
  const finished = new Set(
    items.filter((i) => i.status === 'done' || i.status === 'skipped').map((i) => i.key),
  );
  const out: PlanNeedItem[] = [];
  for (const i of items) {
    if (i.status === 'done' || i.status === 'skipped') continue;
    const why: PlanNeedItem['why'] | null = i.awaitsUser
      ? 'card'
      : i.status === 'blocked' && (i.statusBy === 'assistant' || i.failures >= PLAN_ITEM_FAILURE_CAP)
        ? 'blocked'
        : i.owner === 'user' &&
            (i.status === 'pending' || i.status === 'in_progress') &&
            !i.decisionOpen &&
            i.dependsOn.every((d) => finished.has(d))
          ? 'mine'
          : null;
    if (why !== null) out.push({ key: i.key, title: i.title, why, note: i.note });
  }
  return out;
}

/**
 * p18-plans-ui: the "Planlar" screen's filters (`GET /chat/plans?filter=`): Aktif (every active state), Yürütülüyor
 * (approved / executing), İncelemede (drafting / in review), Duraklatıldı, Bitti, İptal (cancelled / superseded).
 */
export const PLAN_LIST_FILTERS = ['active', 'executing', 'review', 'paused', 'done', 'cancelled'] as const;
export type PlanListFilter = (typeof PLAN_LIST_FILTERS)[number];

export const PLAN_LIST_STATES: Readonly<Record<PlanListFilter, readonly PlanState[]>> = {
  active: ['drafting', 'in_review', 'approved', 'executing', 'paused'],
  executing: ['approved', 'executing'],
  review: ['drafting', 'in_review'],
  paused: ['paused'],
  done: ['done'],
  cancelled: ['cancelled', 'superseded'],
};

/** Whose plans: the caller's own (default), the ones shared with them (read only), or both. */
export const PLAN_LIST_SCOPES = ['mine', 'shared', 'all'] as const;
export type PlanListScope = (typeof PLAN_LIST_SCOPES)[number];

export const PLAN_LIST_LIMIT = { default: 30, max: 100 } as const;

export interface PlanListQuery {
  readonly filter?: PlanListFilter | undefined;
  readonly scope?: PlanListScope | undefined;
  /** A project id: the conversation's working projects or an item's project. */
  readonly project?: string | undefined;
  /** Text in the plan's or the conversation's title (case-insensitive). */
  readonly q?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** p18-plans-ui: one row of the "Planlar" screen — the plan summary's fields plus where it lives and what waits. */
export interface PlanListItem {
  readonly id: string;
  readonly threadId: string;
  readonly threadTitle: string;
  /** The conversation is archived. */
  readonly archived: boolean;
  /** The caller owns the conversation, or reads it shared (read only). */
  readonly role: 'owner' | 'reader';
  readonly title: string;
  readonly state: PlanState;
  readonly autonomous: boolean;
  readonly stalled: string | null;
  readonly version: number;
  readonly progress: Progress;
  /** Decisions still open. */
  readonly openDecisions: number;
  /** Items that wait for the person (a card, a blocked item, their own ready item; executing / paused plans). */
  readonly waiting: number;
  /** The plan waits for the caller (the same rule as "Senden bekleyen"); never for a shared reader. */
  readonly needsYou: boolean;
  /** The conversation's working projects and the items' projects (ids, primary first). */
  readonly projects: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

/** The overview line over every plan of the scope (filters other than the scope do not apply). */
export interface PlanListCounts {
  readonly total: number;
  readonly active: number;
  readonly executing: number;
  readonly review: number;
  readonly paused: number;
  readonly done: number;
  readonly cancelled: number;
  readonly needsYou: number;
}

export interface PlanListPage {
  readonly items: readonly PlanListItem[];
  /** The offset of the next page, null at the end. */
  readonly next: number | null;
  readonly counts: PlanListCounts;
}

/**
 * Whether a plan waits for the person (pure): the owner's plan of a conversation that is not archived, in review, or
 * executing / paused with an open decision, a stall or an item that waits for them — the rule of `waiting()`.
 */
export function planNeedsYou(p: {
  readonly role: 'owner' | 'reader';
  readonly archived: boolean;
  readonly state: PlanState;
  readonly stalled: string | null;
  readonly openDecisions: number;
  readonly waiting: number;
}): boolean {
  if (p.role !== 'owner' || p.archived) return false;
  if (p.state === 'in_review') return true;
  if (p.state !== 'executing' && p.state !== 'paused') return false;
  return p.openDecisions > 0 || p.waiting > 0 || p.stalled !== null;
}

/** The overview counts from per-state counts (pure). */
export function planListCounts(byState: ReadonlyMap<PlanState, number>, needsYou: number): PlanListCounts {
  const sum = (f: PlanListFilter): number =>
    PLAN_LIST_STATES[f].reduce((a, s) => a + (byState.get(s) ?? 0), 0);
  return {
    total: [...byState.values()].reduce((a, n) => a + n, 0),
    active: sum('active'),
    executing: sum('executing'),
    review: sum('review'),
    paused: sum('paused'),
    done: sum('done'),
    cancelled: sum('cancelled'),
    needsYou,
  };
}

/** `%`, `_` and `\` taken literally in an ILIKE pattern. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface PlanVersionMeta {
  readonly version: number;
  readonly author: 'assistant' | 'user';
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface PlanVersionSummary extends PlanVersionMeta {
  /** Items in that version. */
  readonly items: number;
  /** Its change against the kept version before it (zeros for the first kept one). */
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly moved: number;
}

export interface PlanVersionDiff extends PlanDiff {
  readonly from: PlanVersionMeta;
  readonly to: PlanVersionMeta;
  readonly items: readonly DiffItem[];
  readonly decisions: readonly {
    readonly id: string;
    readonly itemKey: string | null;
    readonly prompt: string;
    readonly change: 'asked' | 'answered';
    readonly answer: string | null;
  }[];
}

interface VersionRow {
  version: number;
  author: 'assistant' | 'user';
  reason: string | null;
  created_at: Date;
}

const versionMeta = (r: VersionRow): PlanVersionMeta => ({
  version: r.version,
  author: r.author,
  reason: r.reason,
  createdAt: r.created_at.toISOString(),
});

export type PlanChange = 'created' | 'items' | 'status' | 'state' | 'decision' | 'version' | 'mode';

/** What the plans need of the chat service (sending a continuation turn, whether the conversation is idle). */
export interface PlanChat {
  idle(threadId: string): Promise<boolean>;
  /** The answering machine has the plan tools (`assistant-plan-v1`). */
  planReady(): Promise<boolean>;
  /** p18-project-bootstrap: the answering machine has the project setup tools (`assistant-project-setup-v1`). */
  projectSetupReady?(): Promise<boolean>;
  send(
    actor: ActorContext,
    threadId: string,
    text: string,
    opts: {
      readonly byUser?: boolean;
      readonly plan?: { readonly planId: string; readonly next: string | null };
      readonly stepUp?: { mfaAt: Date | null; stepUpMaxAgeMs?: number; alwaysFreshMaxAgeMs?: number };
      /** p20-outcome: the continuation's claim (chat_deliveries). */
      readonly delivery?: DeliveryRef;
    },
  ): Promise<{ turnId: string }>;
}

export interface ChatPlanDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly store: ChatStore;
  /** After commit: the `plan` / `thread` / `message` events of the conversation's streams. */
  readonly publish: (threadId: string, event: 'plan' | 'thread' | 'message', data: unknown) => void;
  readonly questions: () => QuestionService | null;
  readonly chat: () => PlanChat | null;
  /** p18-plan-autonomy: the owner hears when an item failed PLAN_ITEM_FAILURE_CAP times in a row. */
  readonly notifications?: () => NotificationService | null;
  /**
   * p18-project-bootstrap: what a project still lacks before its first job (`repository`, `network`, `machines`; the
   * cheap check without a provider call) — a job / workflow item of a project that is not ready gets a readiness
   * decision first (the continuation says so). Absent / null / a failure: not checked.
   */
  readonly readiness?: () => ((project: string) => Promise<readonly string[] | null>) | null;
}

/** The tool caller as the plan tools see it. */
export interface PlanCaller {
  readonly userId: string;
  readonly threadId: string;
  readonly turnId: string;
  /** The turn runs in plan mode (decided when it started). */
  readonly planMode: boolean;
}

export type PlanToolOutcome =
  | {
      readonly ok: true;
      readonly data: unknown;
      readonly plan?: { readonly id: string; readonly version: number };
      readonly questionId?: string;
      readonly proposal?: { readonly reason: string };
    }
  | { readonly ok: false; readonly code: 'invalid' | 'forbidden' | 'not_found'; readonly message: string };

interface PlanRow {
  id: string;
  thread_id: string;
  user_id: string;
  title: string;
  goal: string;
  meta: { assumptions?: string[]; risks?: string[] } | null;
  state: PlanState;
  version: number;
  rev: string | number;
  approved_version: number | null;
  autonomous: boolean;
  cont_due: boolean;
  stalled: string | null;
  cont_turn: string | null;
  cont_mark: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

interface ItemRow {
  key: string;
  phase: number;
  phase_title: string;
  position: number;
  title: string;
  active_title: string | null;
  detail: string | null;
  status: PlanItemStatus;
  owner: PlanOwner;
  project: string | null;
  depends_on: string[];
  estimate: PlanEstimate | null;
  links: PlanLink[];
  note: string | null;
  status_by: StatusBy;
  deleted_at: Date | null;
}

/** p18-plans-ui: a row of the plans list (the plan, its conversation, the projects). */
interface ListRow extends PlanRow {
  thread_title: string;
  archived_at: Date | null;
  mine: boolean;
  projects: string[] | null;
}

const PLAN_COLS = `id::text AS id, thread_id::text AS thread_id, user_id::text AS user_id, title, goal, meta, state,
  version, rev, approved_version, autonomous, cont_due, stalled, cont_turn::text AS cont_turn, cont_mark, created_at, updated_at,
  closed_at`;

/** {@link PLAN_COLS} of `chat_plans p` (joined reads). */
const PLAN_COLS_P = `p.id::text AS id, p.thread_id::text AS thread_id, p.user_id::text AS user_id, p.title, p.goal, p.meta,
  p.state, p.version, p.rev, p.approved_version, p.autonomous, p.cont_due, p.stalled, p.cont_turn::text AS cont_turn,
  p.cont_mark, p.created_at, p.updated_at, p.closed_at`;

/** The person's edits that may free work for the assistant (an executing plan becomes due). */
const FREEING_OPS: ReadonlySet<string> = new Set([
  'add',
  'restore',
  'remove',
  'skip',
  'unskip',
  'done_mine',
  'set_owner',
  // W4: a dependency the person dropped may make an item ready.
  'set_depends',
]);

const ACTIVE_SQL = `('drafting', 'in_review', 'approved', 'executing', 'paused')`;

const itemOf = (r: ItemRow): PlanItem => ({
  key: r.key,
  phase: r.phase,
  phaseTitle: r.phase_title,
  position: r.position,
  title: r.title,
  activeTitle: r.active_title,
  detail: r.detail,
  status: r.status,
  owner: r.owner,
  project: r.project,
  dependsOn: r.depends_on,
  estimate: r.estimate,
  links: Array.isArray(r.links) ? r.links : [],
  note: r.note,
  statusBy: r.status_by,
});

/** An edit of the person the plan's rules refuse (409, the rule's code; the console says it in the person's language). */
function editRefused(code: string, message: string): HttpError {
  switch (code) {
    case 'plan_item_done':
      return new HttpError(409, 'plan_item_done', message);
    case 'plan_item_running':
      return new HttpError(409, 'plan_item_running', message);
    case 'plan_item_not_found':
      return new HttpError(409, 'plan_item_not_found', message);
    case 'plan_not_mine':
      return new HttpError(409, 'plan_not_mine', message);
    // p18-multi-project W3: the item's project must be one of the conversation's working projects.
    case 'project_not_in_thread':
      return new HttpError(409, 'project_not_in_thread', message);
    default:
      return new HttpError(409, 'plan_invalid', message);
  }
}

const planNotFound = (): HttpError => new HttpError(404, 'plan_not_found', 'Plan not found.');

/** A tool refusal the model reads (and fixes). */
const refuse = (code: string, message: string): PlanToolOutcome => ({
  ok: false,
  code: 'invalid',
  message: `${code}: ${message}`,
});

function decisionOf(q: QuestionView): PlanDecisionView {
  const one = q.questions[0];
  return {
    id: q.id,
    itemKey: q.planItemKey ?? null,
    prompt: one?.prompt ?? '',
    kind: one?.kind ?? 'text',
    options: (one?.options ?? []).map((o) => ({
      label: o.label,
      ...(o.description === undefined ? {} : { description: o.description }),
    })),
    recommended: one?.recommended ?? null,
    rationale: one?.rationale ?? null,
    state: q.state,
    answers: q.answers,
    answer:
      q.answers === null
        ? null
        : q.answers
            .map((a) =>
              [...(a.choices ?? []), ...(a.other === undefined ? [] : [a.other]), a.text ?? ''].join(', '),
            )
            .join('; ')
            .replace(/(, )+$/, '')
            .slice(0, 300),
    createdAt: q.createdAt,
    answeredAt: q.answeredAt,
  };
}

export class ChatPlanService {
  #lastStep = 0;
  /** Plans whose continuation is being sent by this process (no second send while one is on its way). */
  readonly #sending = new Set<string>();

  constructor(private readonly deps: ChatPlanDeps) {}

  #now(): Date {
    return this.deps.clock();
  }

  // ---------------------------------------------------------------------------------------------- reads

  async #plan(db: Queryable, planId: string, lock = false): Promise<PlanRow | null> {
    const { rows } = await db.query<PlanRow>(
      `SELECT ${PLAN_COLS} FROM chat_plans WHERE id::text = $1${lock ? ' FOR UPDATE' : ''}`,
      [planId],
    );
    return rows[0] ?? null;
  }

  async #activeRow(db: Queryable, threadId: string, lock = false): Promise<PlanRow | null> {
    const { rows } = await db.query<PlanRow>(
      `SELECT ${PLAN_COLS} FROM chat_plans WHERE thread_id = $1 AND state IN ${ACTIVE_SQL}${lock ? ' FOR UPDATE' : ''}`,
      [threadId],
    );
    return rows[0] ?? null;
  }

  async #items(
    db: Queryable,
    planId: string,
  ): Promise<{ items: PlanItem[]; used: Set<string>; deleted: Map<string, PlanItem> }> {
    const { rows } = await db.query<ItemRow>(
      `SELECT key, phase, phase_title, position, title, active_title, detail, status, owner, project, depends_on,
              estimate, links, note, status_by, deleted_at
         FROM chat_plan_items WHERE plan_id = $1`,
      [planId],
    );
    return {
      items: ordered(rows.filter((r) => r.deleted_at === null).map(itemOf)),
      used: new Set(rows.map((r) => r.key)),
      deleted: new Map(rows.filter((r) => r.deleted_at !== null).map((r) => [r.key, itemOf(r)] as const)),
    };
  }

  /** p18-plan-autonomy: the items' consecutive failed attempts (only items that have any). */
  async #failures(db: Queryable, planId: string): Promise<Map<string, number>> {
    const { rows } = await db.query<{ key: string; failures: number }>(
      'SELECT key, failures FROM chat_plan_items WHERE plan_id = $1 AND failures > 0 AND deleted_at IS NULL',
      [planId],
    );
    return new Map(rows.map((r) => [r.key, r.failures] as const));
  }

  /** p18-plan-autonomy: open items whose newest link is a proposed card (they wait for the person). */
  async #awaiting(db: Queryable, items: readonly PlanItem[]): Promise<Set<string>> {
    const newest = new Map<string, string>();
    for (const i of items) {
      if (i.status !== 'in_progress' && i.status !== 'blocked') continue;
      const l = i.links.at(-1);
      if (l?.kind === 'draft' && /^[0-9a-f-]{36}$/i.test(l.id)) newest.set(i.key, l.id);
    }
    if (newest.size === 0) return new Set();
    const { rows } = await db.query<{ id: string }>(
      `SELECT id::text AS id FROM chat_drafts WHERE id = ANY($1::uuid[]) AND state = 'proposed'`,
      [[...new Set(newest.values())]],
    );
    const waiting = new Set(rows.map((r) => r.id));
    return new Set([...newest].filter(([, id]) => waiting.has(id)).map(([key]) => key));
  }

  async #decisions(planId: string, db?: Queryable): Promise<PlanDecisionView[]> {
    const q = this.deps.questions();
    if (q === null) return [];
    return (await q.forPlan(planId, db)).map(decisionOf);
  }

  async #lastChange(db: Queryable, p: PlanRow): Promise<PlanView['lastChange']> {
    if (p.version <= 1) return null;
    const { rows } = await db.query<{
      version: number;
      author: 'assistant' | 'user';
      reason: string | null;
      snapshot: PlanSnapshot;
    }>(
      `SELECT version, author, reason, snapshot FROM chat_plan_versions
        WHERE plan_id = $1 AND version IN ($2, $3) ORDER BY version`,
      [p.id, p.version - 1, p.version],
    );
    const prev = rows.find((r) => r.version === p.version - 1);
    const cur = rows.find((r) => r.version === p.version);
    if (cur === undefined) return null;
    const counts =
      prev === undefined
        ? { added: 0, removed: 0, changed: 0, moved: 0 }
        : diffCounts(diffSnapshots(prev.snapshot, cur.snapshot));
    return { version: cur.version, author: cur.author, reason: cur.reason, ...counts };
  }

  async #view(db: Queryable, p: PlanRow): Promise<PlanView> {
    const { items } = await this.#items(db, p.id);
    const decisions = await this.#decisions(p.id, db);
    const failures = await this.#failures(db, p.id);
    const awaiting = await this.#awaiting(db, items);
    const open = new Set(
      decisions.filter((d) => d.state === 'pending' && d.itemKey !== null).map((d) => d.itemKey as string),
    );
    const phases: { index: number; title: string }[] = [];
    for (const i of items)
      if (!phases.some((x) => x.index === i.phase)) phases.push({ index: i.phase, title: i.phaseTitle });
    return {
      id: p.id,
      threadId: p.thread_id,
      title: p.title,
      goal: p.goal,
      assumptions: p.meta?.assumptions ?? [],
      risks: p.meta?.risks ?? [],
      state: p.state,
      version: p.version,
      rev: Number(p.rev),
      approvedVersion: p.approved_version,
      autonomous: p.autonomous,
      stalled: p.stalled,
      createdAt: p.created_at.toISOString(),
      updatedAt: p.updated_at.toISOString(),
      closedAt: p.closed_at?.toISOString() ?? null,
      phases,
      items: items.map((i) => ({
        ...i,
        decisionOpen: open.has(i.key),
        awaitsUser: awaiting.has(i.key),
        failures: failures.get(i.key) ?? 0,
      })),
      decisions,
      progress: progressOf(items),
      lastChange: await this.#lastChange(db, p),
    };
  }

  /** The plan as the owner or a shared reader sees it (`version`: that stored version, read-only). */
  async get(planId: string, version?: number): Promise<PlanView> {
    const p = await this.#plan(this.deps.pool, planId);
    if (p === null) throw planNotFound();
    if (version === undefined || version === p.version) return this.#view(this.deps.pool, p);
    const { rows } = await this.deps.pool.query<{ snapshot: PlanSnapshot }>(
      'SELECT snapshot FROM chat_plan_versions WHERE plan_id = $1 AND version = $2',
      [planId, version],
    );
    const snap = rows[0]?.snapshot;
    if (snap === undefined)
      throw new HttpError(404, 'plan_version_not_found', 'That plan version is not kept.');
    const items: PlanItemView[] = ordered(snap.items).map((i) => ({
      ...i,
      status: 'pending',
      links: [],
      note: null,
      statusBy: 'assistant',
      decisionOpen: false,
      awaitsUser: false,
      failures: 0,
    }));
    const phases: { index: number; title: string }[] = [];
    for (const i of items)
      if (!phases.some((x) => x.index === i.phase)) phases.push({ index: i.phase, title: i.phaseTitle });
    return {
      ...(await this.#view(this.deps.pool, p)),
      title: snap.title,
      goal: snap.goal,
      assumptions: snap.assumptions,
      risks: snap.risks,
      version,
      items,
      phases,
      progress: progressOf(items),
      lastChange: null,
    };
  }

  /** The thread a plan belongs to (route ownership checks). */
  async threadOf(planId: string): Promise<string> {
    const p = await this.#plan(this.deps.pool, planId);
    if (p === null) throw planNotFound();
    return p.thread_id;
  }

  /**
   * What changed between two kept versions: per item added / removed / changed fields / moved (keys, as before), the
   * items with both sides (the console's diff view), the two versions (author, reason, when) and the decisions asked
   * or answered between them (decisions are question rows, not part of a snapshot: by time).
   */
  async diff(planId: string, from: number, to: number): Promise<PlanVersionDiff> {
    const { rows } = await this.deps.pool.query<VersionRow & { snapshot: PlanSnapshot }>(
      `SELECT version, author, reason, snapshot, created_at FROM chat_plan_versions
        WHERE plan_id = $1 AND version IN ($2, $3)`,
      [planId, from, to],
    );
    const a = rows.find((r) => r.version === from);
    const b = rows.find((r) => r.version === to);
    if (a === undefined || b === undefined)
      throw new HttpError(404, 'plan_version_not_found', 'That plan version is not kept.');
    const d = diffSnapshots(a.snapshot, b.snapshot);
    const [lo, hi] = a.version <= b.version ? [a, b] : [b, a];
    const within = (iso: string | null): boolean =>
      iso !== null && Date.parse(iso) > lo.created_at.getTime() && Date.parse(iso) <= hi.created_at.getTime();
    const decisions = (await this.#decisions(planId)).flatMap((q): PlanVersionDiff['decisions'][number][] => {
      const out: PlanVersionDiff['decisions'][number][] = [];
      if (within(q.createdAt))
        out.push({ id: q.id, itemKey: q.itemKey, prompt: q.prompt, change: 'asked', answer: null });
      if (q.answeredAt !== null && within(q.answeredAt))
        out.push({ id: q.id, itemKey: q.itemKey, prompt: q.prompt, change: 'answered', answer: q.answer });
      return out;
    });
    return {
      ...d,
      from: versionMeta(a),
      to: versionMeta(b),
      items: diffItems(a.snapshot, b.snapshot, d),
      decisions,
    };
  }

  /** The kept versions of a plan, newest first, each with its change against the version before it. */
  async versions(planId: string): Promise<PlanVersionSummary[]> {
    const { rows } = await this.deps.pool.query<VersionRow & { snapshot: PlanSnapshot }>(
      `SELECT version, author, reason, snapshot, created_at FROM chat_plan_versions
        WHERE plan_id = $1 ORDER BY version`,
      [planId],
    );
    return rows
      .map((r, i): PlanVersionSummary => {
        const prev = rows[i - 1];
        return {
          ...versionMeta(r),
          items: r.snapshot.items.length,
          ...(prev === undefined
            ? { added: 0, removed: 0, changed: 0, moved: 0 }
            : diffCounts(diffSnapshots(prev.snapshot, r.snapshot))),
        };
      })
      .reverse();
  }

  /** The active plan and the earlier ones of a conversation (history: title, state, n/m). */
  async ofThread(threadId: string): Promise<{ active: PlanView | null; history: PlanSummary[] }> {
    const { rows } = await this.deps.pool.query<PlanRow & { done: string; total: string }>(
      `SELECT ${PLAN_COLS},
              (SELECT count(*) FROM chat_plan_items i WHERE i.plan_id = p.id AND i.deleted_at IS NULL AND i.status = 'done') AS done,
              (SELECT count(*) FROM chat_plan_items i WHERE i.plan_id = p.id AND i.deleted_at IS NULL AND i.status <> 'skipped') AS total
         FROM chat_plans p WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [threadId],
    );
    const active = rows.find((r) => ACTIVE.has(r.state));
    return {
      active: active === undefined ? null : await this.#view(this.deps.pool, active),
      history: rows
        .filter((r) => !ACTIVE.has(r.state))
        .map((r) => ({
          id: r.id,
          title: r.title,
          state: r.state,
          version: r.version,
          done: Number(r.done),
          total: Number(r.total),
          createdAt: r.created_at.toISOString(),
          closedAt: r.closed_at?.toISOString() ?? null,
        })),
    };
  }

  /**
   * p18-plan-mode W4: the caller's plans that wait for them — in review (approval), with open decisions, a stall, a card
   * to confirm, a blocked item the platform does not retry by itself, or their own ready item. Own, not archived
   * conversations only (a shared reader never answers a plan). Newest first, at most 20.
   */
  async waiting(userId: string): Promise<PlanNeedView[]> {
    const { rows } = await this.deps.pool.query<PlanRow & { thread_title: string }>(
      `SELECT ${PLAN_COLS_P}, t.title AS thread_title
         FROM chat_plans p JOIN chat_threads t ON t.id = p.thread_id AND t.user_id = p.user_id
        WHERE p.user_id = $1 AND t.archived_at IS NULL AND p.state IN ('in_review', 'executing', 'paused')
        ORDER BY p.updated_at DESC LIMIT 20`,
      [userId],
    );
    const out: PlanNeedView[] = [];
    for (const p of rows) {
      const v = await this.#view(this.deps.pool, p);
      const questions = ((await this.deps.questions()?.forPlan(v.id)) ?? []).filter(
        (q) => q.state === 'pending',
      );
      const waiting = v.state === 'executing' || v.state === 'paused' ? waitingItems(v.items) : [];
      if (v.state !== 'in_review' && questions.length === 0 && waiting.length === 0 && v.stalled === null)
        continue;
      out.push({
        planId: v.id,
        threadId: v.threadId,
        threadTitle: p.thread_title,
        title: v.title,
        state: v.state,
        rev: v.rev,
        stalled: v.stalled,
        questions,
        waiting,
        updatedAt: v.updatedAt,
      });
    }
    return out;
  }

  /**
   * p18-plans-ui: the caller's plans across their conversations ("Planlar"; `scope` shared / all adds the conversations
   * shared with them, read only) — newest change first, a page at a time, with the summary's figures (progress,
   * remaining time, open decisions, items waiting) and the overview counts of the scope. Ownership is the
   * conversation's (as the plan routes check it).
   */
  async list(userId: string, query: PlanListQuery = {}): Promise<PlanListPage> {
    const db = this.deps.pool;
    const scope = query.scope ?? 'mine';
    const limit = Math.min(Math.max(query.limit ?? PLAN_LIST_LIMIT.default, 1), PLAN_LIST_LIMIT.max);
    const offset = Math.max(query.offset ?? 0, 0);
    const shared = 'EXISTS (SELECT 1 FROM chat_thread_shares s WHERE s.thread_id = t.id AND s.user_id = $1)';
    const scopeSql =
      scope === 'mine'
        ? 't.user_id = $1'
        : scope === 'shared'
          ? `t.user_id <> $1 AND ${shared}`
          : `(t.user_id = $1 OR ${shared})`;
    const params: unknown[] = [userId];
    const where = [scopeSql];
    if (query.filter !== undefined) {
      params.push([...PLAN_LIST_STATES[query.filter]]);
      where.push(`p.state = ANY($${String(params.length)}::text[])`);
    }
    if (query.project !== undefined && query.project !== '') {
      params.push(query.project);
      const k = `$${String(params.length)}`;
      where.push(`(t.project = ${k}
        OR EXISTS (SELECT 1 FROM chat_thread_projects tp WHERE tp.thread_id = t.id AND tp.project = ${k})
        OR EXISTS (SELECT 1 FROM chat_plan_items i WHERE i.plan_id = p.id AND i.deleted_at IS NULL AND i.project = ${k}))`);
    }
    const q = query.q?.trim() ?? '';
    if (q !== '') {
      params.push(likePattern(q));
      const k = `$${String(params.length)}`;
      where.push(`(p.title ILIKE ${k} OR t.title ILIKE ${k})`);
    }
    params.push(limit + 1, offset);
    const { rows } = await db.query<ListRow>(
      `SELECT ${PLAN_COLS_P}, t.title AS thread_title, t.archived_at, (t.user_id = $1) AS mine,
              ARRAY(SELECT x.project FROM (
                      SELECT t.project, 0 AS o, NULL::timestamptz AS at WHERE t.project IS NOT NULL
                      UNION ALL SELECT tp.project, 1, tp.added_at FROM chat_thread_projects tp WHERE tp.thread_id = t.id
                      UNION ALL SELECT DISTINCT i.project, 2, NULL::timestamptz FROM chat_plan_items i
                       WHERE i.plan_id = p.id AND i.deleted_at IS NULL AND i.project IS NOT NULL
                    ) x GROUP BY x.project ORDER BY min(x.o), min(x.at), x.project) AS projects
         FROM chat_plans p JOIN chat_threads t ON t.id = p.thread_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT $${String(params.length - 1)} OFFSET $${String(params.length)}`,
      params,
    );
    const page = rows.slice(0, limit);
    const items = await this.#listItems(page);

    // The overview: per state over the whole scope, and the plans that wait for the caller (own, active, not archived).
    const { rows: byState } = await db.query<{ state: PlanState; n: string }>(
      `SELECT p.state, count(*) AS n FROM chat_plans p JOIN chat_threads t ON t.id = p.thread_id
        WHERE ${scopeSql} GROUP BY p.state`,
      [userId],
    );
    let needsYou = 0;
    if (scope !== 'shared') {
      const { rows: open } = await db.query<ListRow>(
        `SELECT ${PLAN_COLS_P}, t.title AS thread_title, t.archived_at, true AS mine, ARRAY[]::text[] AS projects
           FROM chat_plans p JOIN chat_threads t ON t.id = p.thread_id
          WHERE t.user_id = $1 AND t.archived_at IS NULL AND p.state IN ('in_review', 'executing', 'paused')
          ORDER BY p.updated_at DESC LIMIT 200`,
        [userId],
      );
      needsYou = (await this.#listItems(open)).filter((i) => i.needsYou).length;
    }
    return {
      items,
      next: rows.length > limit ? offset + limit : null,
      counts: planListCounts(new Map(byState.map((r) => [r.state, Number(r.n)] as const)), needsYou),
    };
  }

  /** The list rows' figures, read for all of them at once (items, open decisions, cards that wait). */
  async #listItems(rows: readonly ListRow[]): Promise<PlanListItem[]> {
    if (rows.length === 0) return [];
    const db = this.deps.pool;
    const ids = rows.map((r) => r.id);
    const { rows: itemRows } = await db.query<ItemRow & { plan_id: string; failures: number }>(
      `SELECT plan_id::text AS plan_id, key, phase, phase_title, position, title, active_title, detail, status, owner,
              project, depends_on, estimate, links, note, status_by, deleted_at, failures
         FROM chat_plan_items WHERE plan_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [ids],
    );
    const { rows: openRows } = await db.query<{ plan_id: string; item_key: string | null }>(
      `SELECT plan_id::text AS plan_id, plan_item_key AS item_key FROM user_questions
        WHERE plan_id = ANY($1::uuid[]) AND state = 'pending'`,
      [ids],
    );
    const byPlan = new Map<string, (PlanItem & { failures: number })[]>();
    for (const r of itemRows) {
      const list = byPlan.get(r.plan_id) ?? [];
      list.push({ ...itemOf(r), failures: r.failures });
      byPlan.set(r.plan_id, list);
    }
    // The cards that wait: the newest link of an open item is a proposed draft (as #awaiting, for every plan at once).
    const newest = new Map<string, string>();
    for (const [planId, items] of byPlan)
      for (const i of items) {
        if (i.status !== 'in_progress' && i.status !== 'blocked') continue;
        const l = i.links.at(-1);
        if (l?.kind === 'draft' && /^[0-9a-f-]{36}$/i.test(l.id)) newest.set(`${planId} ${i.key}`, l.id);
      }
    let proposed = new Set<string>();
    if (newest.size > 0) {
      const { rows: d } = await db.query<{ id: string }>(
        `SELECT id::text AS id FROM chat_drafts WHERE id = ANY($1::uuid[]) AND state = 'proposed'`,
        [[...new Set(newest.values())]],
      );
      proposed = new Set(d.map((x) => x.id));
    }
    return rows.map((r): PlanListItem => {
      const items = ordered(byPlan.get(r.id) ?? []);
      const open = openRows.filter((o) => o.plan_id === r.id);
      const openKeys = new Set(open.flatMap((o) => (o.item_key === null ? [] : [o.item_key])));
      const views: PlanItemView[] = items.map((i) => ({
        ...i,
        decisionOpen: openKeys.has(i.key),
        awaitsUser: proposed.has(newest.get(`${r.id} ${i.key}`) ?? ''),
        failures: i.failures,
      }));
      const role = r.mine ? ('owner' as const) : ('reader' as const);
      const archived = r.archived_at !== null;
      const waiting = r.state === 'executing' || r.state === 'paused' ? waitingItems(views).length : 0;
      return {
        id: r.id,
        threadId: r.thread_id,
        threadTitle: r.thread_title,
        archived,
        role,
        title: r.title,
        state: r.state,
        autonomous: r.autonomous,
        stalled: r.stalled,
        version: r.version,
        progress: progressOf(items),
        openDecisions: open.length,
        waiting,
        needsYou: planNeedsYou({
          role,
          archived,
          state: r.state,
          stalled: r.stalled,
          openDecisions: open.length,
          waiting,
        }),
        projects: Array.isArray(r.projects) ? r.projects : [],
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        closedAt: r.closed_at?.toISOString() ?? null,
      };
    });
  }

  /** The thread detail's part: plan mode and the active plan. */
  async summary(threadId: string): Promise<{ mode: string | null; active: PlanView | null }> {
    const [mode, active] = await Promise.all([
      this.mode(threadId),
      this.#activeRow(this.deps.pool, threadId).then((p) =>
        p === null ? null : this.#view(this.deps.pool, p),
      ),
    ]);
    return { mode, active };
  }

  async mode(threadId: string, db: Queryable = this.deps.pool): Promise<string | null> {
    const { rows } = await db.query<{ since: Date | null }>(
      'SELECT plan_mode_since AS since FROM chat_threads WHERE id = $1',
      [threadId],
    );
    return rows[0]?.since?.toISOString() ?? null;
  }

  // ---------------------------------------------------------------------------------------------- writes (shared)

  async #saveItems(
    db: Queryable,
    planId: string,
    items: readonly PlanItem[],
    removed: readonly string[],
  ): Promise<void> {
    const now = this.#now();
    for (const i of items) {
      await db.query(
        `INSERT INTO chat_plan_items (id, plan_id, key, phase, phase_title, position, title, active_title, detail, status,
                                     owner, project, depends_on, estimate, links, note, status_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (plan_id, key) DO UPDATE SET phase = EXCLUDED.phase, phase_title = EXCLUDED.phase_title,
           position = EXCLUDED.position, title = EXCLUDED.title, active_title = EXCLUDED.active_title,
           detail = EXCLUDED.detail, status = EXCLUDED.status, owner = EXCLUDED.owner, project = EXCLUDED.project,
           depends_on = EXCLUDED.depends_on, estimate = EXCLUDED.estimate, links = EXCLUDED.links, note = EXCLUDED.note,
           status_by = EXCLUDED.status_by, deleted_at = NULL, updated_at = EXCLUDED.updated_at`,
        [
          randomUUID(),
          planId,
          i.key,
          i.phase,
          i.phaseTitle,
          i.position,
          i.title,
          i.activeTitle,
          i.detail,
          i.status,
          i.owner,
          i.project,
          [...i.dependsOn],
          i.estimate === null ? null : JSON.stringify(i.estimate),
          JSON.stringify(i.links),
          i.note,
          i.statusBy,
          now,
        ],
      );
    }
    if (removed.length > 0) {
      await db.query(
        'UPDATE chat_plan_items SET deleted_at = $3, updated_at = $3 WHERE plan_id = $1 AND key = ANY($2::text[])',
        [planId, removed, now],
      );
    }
  }

  async #version(
    db: Queryable,
    p: { id: string; title: string; goal: string; meta: PlanRow['meta'] },
    version: number,
    author: 'assistant' | 'user',
    reason: string | null,
    items: readonly PlanItem[],
  ): Promise<void> {
    const snapshot: PlanSnapshot = {
      title: p.title,
      goal: p.goal,
      assumptions: p.meta?.assumptions ?? [],
      risks: p.meta?.risks ?? [],
      items: items.map(shapeOf),
    };
    await db.query(
      `INSERT INTO chat_plan_versions (plan_id, version, author, reason, snapshot, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [p.id, version, author, reason, JSON.stringify(snapshot), this.#now()],
    );
    // ≤ 50 kept — but never the assistant's newest version: the person's edits reach the assistant as a diff against it.
    await db.query(
      `DELETE FROM chat_plan_versions WHERE plan_id = $1 AND version <= $2
          AND version <> coalesce((SELECT max(version) FROM chat_plan_versions
                                    WHERE plan_id = $1 AND author = 'assistant'), 0)`,
      [p.id, version - PLAN_LIMITS.versionsKept],
    );
  }

  /** rev + 1 (and optional column changes) — every change of a plan bumps its revision. */
  async #touch(db: Queryable, planId: string, set = '', params: unknown[] = []): Promise<void> {
    await db.query(
      `UPDATE chat_plans SET rev = rev + 1, updated_at = $2${set === '' ? '' : `, ${set}`} WHERE id = $1`,
      [planId, this.#now(), ...params],
    );
  }

  /** After commit: the full plan to the conversation's open views (they replace theirs when `rev` is newer). */
  async #publish(planId: string, change: PlanChange): Promise<PlanView | null> {
    try {
      const p = await this.#plan(this.deps.pool, planId);
      if (p === null) return null;
      const plan = await this.#view(this.deps.pool, p);
      this.deps.publish(p.thread_id, 'plan', {
        planId,
        rev: plan.rev,
        version: plan.version,
        state: plan.state,
        change,
        plan,
      });
      return plan;
    } catch (err) {
      this.deps.log.debug({ err, planId }, 'plan event not published');
      return null;
    }
  }

  async #audit(
    action: string,
    actor: { userId: string; ip?: string; userAgent?: string | null },
    p: { id: string; thread_id?: string; threadId?: string },
    metadata: Record<string, unknown>,
    db?: Queryable,
  ): Promise<void> {
    await this.deps.audit
      .record(
        {
          actor: { type: 'user', id: actor.userId },
          action,
          target: `chat-plan:${p.id}`,
          outcome: 'success',
          ...(actor.ip === undefined ? {} : { ip: actor.ip }),
          ...(actor.userAgent === undefined ? {} : { userAgent: actor.userAgent }),
          metadata: { threadId: p.thread_id ?? p.threadId, ...metadata },
        },
        db,
      )
      .catch((err: unknown) => {
        this.deps.log.warn({ err, action }, 'plan audit not recorded');
      });
  }

  /**
   * p18-plan-mode W4: a `chat.plan` notification to the plan's owner (the notification path: their channel preferences,
   * one per occurrence by its dedupe key). Never throws.
   */
  async #notify(
    p: { id: string; thread_id: string; user_id: string; title: string; goal?: string },
    kind: PlanNoticeKind,
    x: Parameters<typeof planNotice>[3],
  ): Promise<void> {
    const svc = this.deps.notifications?.() ?? null;
    if (svc === null) return;
    const n = planNotice(
      kind,
      guessLanguage([p.title, p.goal ?? '', x.item ?? '']),
      { planId: p.id, title: p.title },
      x,
    );
    await svc
      .notify(this.deps.pool, [p.user_id], {
        kind: 'chat.plan',
        severity: n.severity,
        title: n.title,
        body: n.body,
        link: `/chat/${p.thread_id}`,
        dedupeKey: n.dedupeKey,
      })
      .catch((err: unknown) => {
        this.deps.log.debug({ err, planId: p.id, kind }, 'plan notification not sent');
      });
  }

  // ---------------------------------------------------------------------------------------------- plan mode

  /** Turns plan mode on / off for the owner's conversation (`PUT /chat/threads/:id/plan-mode`, `/plan`, `mode: plan`). */
  async setMode(userId: string, threadId: string, on: boolean): Promise<string | null> {
    const thread = await this.deps.store.thread(userId, threadId);
    if (thread.archived) throw new HttpError(409, 'thread_archived', 'This conversation is archived.');
    if (on) {
      const chat = this.deps.chat();
      if (chat !== null && !(await chat.planReady()))
        throw new HttpError(
          409,
          'plan_mode_unavailable',
          'The assistant machine must be updated before plan mode can be used.',
        );
    }
    const { rows } = await this.deps.pool.query<{ since: Date | null }>(
      `UPDATE chat_threads SET plan_mode_since = CASE WHEN $3 THEN coalesce(plan_mode_since, $2) ELSE NULL END
        WHERE id = $1 RETURNING plan_mode_since AS since`,
      [threadId, this.#now(), on],
    );
    const since = rows[0]?.since?.toISOString() ?? null;
    this.#threadChanged(thread);
    return since;
  }

  #threadChanged(thread: ThreadView): void {
    this.deps.publish(thread.id, 'thread', thread);
  }

  /**
   * The plan part of a turn's input: whether it runs in plan mode, the instruction that leads its message (plan mode)
   * and the "aktif plan" block (when the conversation has an active plan). Never throws (a failure loses the extra).
   */
  async turnInput(
    threadId: string,
  ): Promise<{ planMode: boolean; instruction: string | null; blocks: string[] }> {
    try {
      const mode = (await this.mode(threadId)) !== null;
      const p = await this.#activeRow(this.deps.pool, threadId);
      const blocks: string[] = [];
      if (p !== null) {
        const { items } = await this.#items(this.deps.pool, p.id);
        const decisions = await this.#decisions(p.id);
        blocks.push(
          planBlock({
            id: p.id,
            title: p.title,
            goal: p.goal,
            version: p.version,
            state: p.state,
            items,
            decisions: decisions.map((d): BlockDecision => ({
              id: d.id,
              itemKey: d.itemKey,
              prompt: d.prompt,
              state: d.state,
              answer: d.answer,
            })),
            userEdit: await this.#userEdit(p),
            stalled: p.stalled,
            autonomous: p.autonomous,
          }),
        );
      }
      return { planMode: mode, instruction: mode ? PLAN_MODE_INSTRUCTION : null, blocks };
    } catch (err) {
      this.deps.log.warn({ err, threadId }, 'plan turn input not built');
      return { planMode: false, instruction: null, blocks: [] };
    }
  }

  /**
   * The person's edits since the assistant's own newest version (null: none) — the newest version against the
   * assistant's newest one, however many edits lie between (that version is never pruned).
   */
  async #userEdit(p: PlanRow): Promise<UserEditView | null> {
    const { rows } = await this.deps.pool.query<{ version: number; author: string; snapshot: PlanSnapshot }>(
      `(SELECT version, author, snapshot FROM chat_plan_versions WHERE plan_id = $1 ORDER BY version DESC LIMIT 1)
       UNION ALL
       (SELECT version, author, snapshot FROM chat_plan_versions WHERE plan_id = $1 AND author = 'assistant'
         ORDER BY version DESC LIMIT 1)`,
      [p.id],
    );
    const latest = rows[0];
    const base = rows.find((r) => r.author === 'assistant');
    if (latest === undefined || latest.author !== 'user' || base === undefined) return null;
    if (base.version >= latest.version) return null;
    return userEditView(base, latest);
  }

  /** Wraps a plan-mode turn's message: the instruction first, then the person's words. */
  static planMessage(instruction: string, text: string): string {
    return composePlanMessage(instruction, text, MAX_ASSISTANT_MESSAGE);
  }

  // ---------------------------------------------------------------------------------------------- assistant tools

  /** `plan_propose`: a two-button card (outside plan mode). */
  propose(c: PlanCaller, input: { reason: string }): PlanToolOutcome {
    if (c.planMode)
      return refuse('plan_mode_active', 'Plan mode is already on: write the plan with plan_create.');
    return {
      ok: true,
      proposal: { reason: input.reason },
      data: {
        shown: 'a card asking the user whether to plan first ([Planla] / [Hemen yap])',
        next: 'End your turn now with at most one short sentence. The user decides; if they choose to plan, plan mode is on in the next turn.',
      },
    };
  }

  /** `plan_create` (plan mode only): replaces an unapproved active plan; refused while one is executing. */
  async create(c: PlanCaller, raw: Record<string, unknown>): Promise<PlanToolOutcome> {
    if (!c.planMode)
      return refuse(
        'plan_mode_required',
        'plan_create works in plan mode only; suggest planning with plan_propose.',
      );
    const parsed = PlanCreateInput.safeParse(raw);
    if (!parsed.success)
      return refuse(
        'plan_invalid',
        parsed.error.issues
          .slice(0, 5)
          .map((i) => i.message)
          .join('; '),
      );
    const input = parsed.data;
    const issues = planStructureIssues(input.phases);
    if (issues.length > 0) return refuse('plan_invalid', issues.join('; '));
    const now = this.#now();
    const id = randomUUID();
    const items = itemsFromCreate(input.phases);
    const meta = { assumptions: input.assumptions ?? [], risks: input.risks ?? [] };
    const out = await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT 1 FROM chat_threads WHERE id = $1 FOR UPDATE', [c.threadId]);
      const cur = await this.#activeRow(tx, c.threadId, true);
      if (cur !== null && (cur.state === 'approved' || cur.state === 'executing' || cur.state === 'paused'))
        return { ok: false as const, cur };
      if (cur !== null) {
        await tx.query(
          `UPDATE chat_plans SET state = 'superseded', closed_at = $2, updated_at = $2, rev = rev + 1, cont_due = false
            WHERE id = $1`,
          [cur.id, now],
        );
        await this.deps.questions()?.closePlanDecisions(cur.id, 'plan_superseded', tx);
      }
      await tx.query(
        `INSERT INTO chat_plans (id, thread_id, user_id, title, goal, meta, state, version, rev, created_turn,
                                 created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'in_review', 1, 1, $7, $8, $8)`,
        [id, c.threadId, c.userId, input.title, input.goal, JSON.stringify(meta), c.turnId, now],
      );
      await this.#saveItems(tx, id, items, []);
      await this.#version(
        tx,
        { id, title: input.title, goal: input.goal, meta },
        1,
        'assistant',
        null,
        items,
      );
      await this.#audit(
        'chat.plan.create',
        { userId: c.userId },
        { id, threadId: c.threadId },
        {
          version: 1,
          turnId: c.turnId,
          items: items.length,
          title: input.title,
          ...(cur === null ? {} : { supersedes: cur.id }),
        },
        tx,
      );
      return { ok: true as const, supersedes: cur?.id ?? null };
    });
    if (!out.ok)
      return refuse(
        'plan_active',
        `Plan ${out.cur.id} is being executed (${out.cur.state}); change it with plan_update_items, or the user cancels it first.`,
      );
    if (out.supersedes !== null) await this.#publish(out.supersedes, 'state');
    await this.#publish(id, 'created');
    // p18-leftovers: the plan card waits for its owner's review (the person may have left the conversation).
    await this.#notify(
      { id, thread_id: c.threadId, user_id: c.userId, title: input.title, goal: input.goal },
      'ready',
      { occurrence: 'v1', count: items.length },
    );
    return {
      ok: true,
      plan: { id, version: 1 },
      data: {
        planId: id,
        version: 1,
        state: 'in_review',
        items: items.length,
        shown: 'as a plan card in this conversation and in the plan panel',
        next: 'Ask the decisions the plan needs with plan_ask_decision (with a recommended option), then end your turn with a short summary. The user reviews and approves.',
      },
    };
  }

  async #toolPlan(
    c: PlanCaller,
    planId: string,
    db: Queryable,
    lock: boolean,
  ): Promise<PlanRow | PlanToolOutcome> {
    const p = await this.#plan(db, planId, lock);
    if (p === null || p.thread_id !== c.threadId || p.user_id !== c.userId)
      return { ok: false, code: 'not_found', message: `Plan ${planId} is not a plan of this conversation.` };
    if (!ACTIVE.has(p.state)) return refuse('plan_closed', `Plan ${planId} is ${p.state}.`);
    return p;
  }

  /** `plan_update_items`: a structural change (new version); an approved plan goes back to review. */
  async update(
    c: PlanCaller,
    input: { planId: string; baseVersion: number; reason: string; ops: PlanUpdateOp[] },
  ): Promise<PlanToolOutcome> {
    const out = await withTransaction(this.deps.pool, async (tx): Promise<PlanToolOutcome> => {
      const p = await this.#toolPlan(c, input.planId, tx, true);
      if (!('id' in p)) return p;
      if (p.version !== input.baseVersion)
        return refuse(
          'plan_version_conflict',
          `The plan is at version ${String(p.version)} (you based the change on ${String(input.baseVersion)}); read it again (plan_read) and redo the change.`,
        );
      const { items, used } = await this.#items(tx, p.id);
      let next: { items: PlanItem[]; removed: string[] };
      try {
        next = applyUpdateOps(items, input.ops, used);
      } catch (err) {
        if (err instanceof PlanOpError) return refuse(err.code, err.message);
        throw err;
      }
      const version = p.version + 1;
      const back = p.state === 'approved' || p.state === 'executing' || p.state === 'paused';
      await this.#saveItems(tx, p.id, next.items, next.removed);
      await this.#version(tx, p, version, 'assistant', input.reason, next.items);
      await this.#touch(
        tx,
        p.id,
        back ? `version = $3, state = 'in_review', cont_due = false` : 'version = $3',
        [version],
      );
      await this.#audit(
        'chat.plan.edit',
        { userId: c.userId },
        p,
        {
          by: 'assistant',
          version,
          turnId: c.turnId,
          ops: input.ops.map((o) => o.op),
          ...(back ? { backToReview: true } : {}),
        },
        tx,
      );
      return {
        ok: true,
        plan: { id: p.id, version },
        data: {
          planId: p.id,
          version,
          state: back ? 'in_review' : p.state,
          ...(back
            ? {
                note: 'The approved plan changed: it is back in review and execution waits until the user approves it again.',
              }
            : {}),
        },
      };
    });
    if (out.ok) {
      const v = await this.#publish(input.planId, 'version');
      // W4: the approved plan went back to review — its owner approves it again.
      const back = (out.data as { state?: string }).state === 'in_review' && 'note' in (out.data as object);
      if (back && v !== null)
        await this.#notify(
          { id: v.id, thread_id: v.threadId, user_id: c.userId, title: v.title, goal: v.goal },
          'review',
          {
            occurrence: String(v.version),
            note: input.reason,
          },
        );
    }
    return out;
  }

  /** `plan_set_status` (execution): progress of items; links an item to what serves it. */
  async setStatus(
    c: PlanCaller,
    input: { planId: string; items: PlanStatusChange[] },
  ): Promise<PlanToolOutcome> {
    const out = await withTransaction(this.deps.pool, async (tx): Promise<PlanToolOutcome> => {
      const p = await this.#toolPlan(c, input.planId, tx, true);
      if (!('id' in p)) return p;
      if (p.state !== 'executing' && p.state !== 'paused' && p.state !== 'approved')
        return refuse(
          'plan_not_executing',
          `Plan ${p.id} is ${p.state}: statuses change only while it is executed.`,
        );
      const { items } = await this.#items(tx, p.id);
      let cur = items;
      const refused: string[] = [];
      const changed: string[] = [];
      for (const ch of input.items) {
        const why = checkStatusChange(cur, ch.key, ch.status, ch.note);
        if (why !== null) {
          refused.push(why);
          continue;
        }
        cur = cur.map((i) =>
          i.key !== ch.key
            ? i
            : {
                ...i,
                status: ch.status,
                statusBy: 'assistant',
                note: ch.note ?? (ch.status === 'done' || ch.status === 'in_progress' ? null : i.note),
                links:
                  ch.link === undefined ||
                  i.links.some((l) => l.kind === ch.link?.kind && l.id === ch.link.id)
                    ? i.links
                    : [...i.links, ch.link].slice(-PLAN_LIMITS.links),
              },
        );
        changed.push(ch.key);
      }
      if (changed.length > 0) {
        await this.#saveItems(
          tx,
          p.id,
          cur.filter((i) => changed.includes(i.key)),
          [],
        );
        await this.#touch(tx, p.id);
      }
      const progress = progressOf(cur);
      return {
        ok: true,
        data: {
          planId: p.id,
          changed,
          ...(refused.length === 0 ? {} : { refused }),
          progress: `${String(progress.done)}/${String(progress.total)}`,
          next: readyItems(cur)
            .slice(0, 3)
            .map((i) => i.key),
        },
      };
    });
    if (out.ok && (out.data as { changed: string[] }).changed.length > 0) {
      const v = await this.#publish(input.planId, 'status');
      // W4: the assistant blocked an item with its reason — it cannot go on by itself (autonomy instruction).
      const changed = new Set((out.data as { changed: string[] }).changed);
      if (v !== null)
        for (const ch of input.items) {
          if (ch.status !== 'blocked' || !changed.has(ch.key)) continue;
          const item = v.items.find((i) => i.key === ch.key);
          await this.#notify(
            { id: v.id, thread_id: v.threadId, user_id: c.userId, title: v.title, goal: v.goal },
            'blocked',
            {
              occurrence: `${ch.key}:${String(v.rev)}`,
              item: item?.title ?? ch.key,
              note: ch.note ?? null,
            },
          );
        }
    }
    return out;
  }

  /** `plan_ask_decision`: a decision row (a question keyed by plan and item). */
  async askDecision(
    c: PlanCaller,
    input: {
      planId: string;
      itemKey?: string;
      prompt: string;
      kind: 'single' | 'multi' | 'text';
      options?: { label: string; description?: string }[];
      recommended?: string;
      rationale?: string;
    },
  ): Promise<PlanToolOutcome> {
    const q = this.deps.questions();
    if (q === null) return { ok: false, code: 'invalid', message: 'Decisions are not available.' };
    const question = UserQuestionInput.safeParse({
      prompt: input.prompt,
      kind: input.kind,
      // p19-plan-decide: a decision is never limited to the listed options — the person can
      // always write their own answer.
      ...(input.kind === 'text' ? {} : { allowOther: true }),
      ...(input.options === undefined ? {} : { options: input.options }),
      ...(input.recommended === undefined ? {} : { recommended: input.recommended }),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    });
    if (!question.success)
      return refuse(
        'plan_invalid',
        question.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; '),
      );
    if (input.kind !== 'text' && (input.options?.length ?? 0) < PLAN_LIMITS.decisionOptionsMin)
      return refuse('plan_invalid', 'single / multi decisions need 2–6 options.');
    const out = await withTransaction(this.deps.pool, async (tx): Promise<PlanToolOutcome> => {
      const p = await this.#toolPlan(c, input.planId, tx, true);
      if (!('id' in p)) return p;
      const { items } = await this.#items(tx, p.id);
      if (input.itemKey !== undefined && !items.some((i) => i.key === input.itemKey))
        return refuse('plan_item_not_found', `No item ${input.itemKey} in the plan.`);
      const { rows } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM user_questions WHERE plan_id = $1 AND state = 'pending'`,
        [p.id],
      );
      if (Number(rows[0]?.n ?? 0) >= PLAN_LIMITS.openDecisions)
        return refuse(
          'plan_decisions_limit',
          `At most ${String(PLAN_LIMITS.openDecisions)} open decisions per plan.`,
        );
      const id = await q.askPlanDecision(
        { userId: c.userId, threadId: c.threadId, turnId: c.turnId },
        { planId: p.id, itemKey: input.itemKey ?? null, question: question.data },
        tx,
      );
      await this.#touch(tx, p.id);
      return {
        ok: true,
        questionId: id,
        plan: { id: p.id, version: p.version },
        data: {
          decisionId: id,
          shown: 'on the plan panel and as a card in this conversation',
          next: 'The user answers there; the answer reaches you in the plan block of the next turn. Do not ask it again in prose.',
        },
      };
    });
    if (out.ok) {
      const v = await this.#publish(input.planId, 'decision');
      // W4: one notification per turn, however many decisions it asked (the count is the open ones now).
      if (v !== null)
        await this.#notify(
          { id: v.id, thread_id: v.threadId, user_id: c.userId, title: v.title, goal: v.goal },
          'decision',
          {
            occurrence: c.turnId,
            prompt: input.prompt,
            count: v.decisions.filter((d) => d.state === 'pending').length,
          },
        );
    }
    return out;
  }

  /**
   * p19-plan-decide: a decision settled in the chat must update its card instead of leaving a stale one behind.
   * `plan_close_decision` — an open decision that the conversation settled or made moot is closed (its card leaves
   * "Senden bekleyen" and the plan panel; the item it blocked is no longer held by it). `answer`: what was settled,
   * kept as the close note.
   */
  async closeDecision(
    c: PlanCaller,
    input: { planId: string; decisionId: string; answer?: string; reason: string },
  ): Promise<PlanToolOutcome> {
    const q = this.deps.questions();
    if (q === null) return { ok: false, code: 'invalid', message: 'Decisions are not available.' };
    const out = await withTransaction(this.deps.pool, async (tx): Promise<PlanToolOutcome> => {
      const p = await this.#toolPlan(c, input.planId, tx, true);
      if (!('id' in p)) return p;
      // The stored reason is a code (user_questions.close_reason); what was settled is kept as close_note (p20-decisions:
      // the folded card says it) and goes to the audit log with the reason.
      if (!(await q.closePlanDecision(p.id, input.decisionId, 'settled_in_chat', tx, input.answer)))
        return refuse(
          'plan_decision_not_open',
          'No open decision with that id in the plan (answered or closed already?).',
        );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: c.userId },
          action: 'chat.plan.decision_closed',
          target: `chat-plan:${p.id}`,
          outcome: 'success',
          metadata: {
            decisionId: input.decisionId,
            via: 'assistant',
            turnId: c.turnId,
            ...(input.answer === undefined ? {} : { answer: input.answer }),
            reason: input.reason,
          },
        },
        tx,
      );
      await this.#touch(tx, p.id);
      return {
        ok: true,
        plan: { id: p.id, version: p.version },
        data: {
          closed: input.decisionId,
          shown: 'its card is gone from the plan panel and from "Senden bekleyen"',
          next: 'Carry on with what was settled; ask a new decision with plan_ask_decision only if something is still open.',
        },
      };
    });
    if (out.ok) await this.#publish(input.planId, 'decision');
    return out;
  }

  /** `plan_set_state`: the assistant pauses, finishes (all done / skipped) or gives up the plan. */
  async setState(
    c: PlanCaller,
    input: { planId: string; state: z.infer<typeof PlanSetStateTarget>; note?: string },
  ): Promise<PlanToolOutcome> {
    const out = await withTransaction(this.deps.pool, async (tx): Promise<PlanToolOutcome> => {
      const p = await this.#toolPlan(c, input.planId, tx, true);
      if (!('id' in p)) return p;
      if (input.state === 'paused' && p.state !== 'executing')
        return refuse('plan_not_executing', `Only an executing plan can be paused (it is ${p.state}).`);
      if (input.state === 'done') {
        const { items } = await this.#items(tx, p.id);
        const open = items.filter((i) => i.status !== 'done' && i.status !== 'skipped');
        if (open.length > 0)
          return refuse(
            'plan_not_finished',
            `Items not done or skipped: ${open.map((i) => i.key).join(', ')}.`,
          );
      }
      const closes = input.state !== 'paused';
      await this.#touch(tx, p.id, `state = $3, cont_due = false${closes ? ', closed_at = $2' : ''}`, [
        input.state,
      ]);
      if (closes) await this.deps.questions()?.closePlanDecisions(p.id, `plan_${input.state}`, tx);
      await this.#audit(
        input.state === 'paused'
          ? 'chat.plan.pause'
          : input.state === 'done'
            ? 'chat.plan.done'
            : 'chat.plan.cancel',
        { userId: c.userId },
        p,
        { by: 'assistant', version: p.version, turnId: c.turnId },
        tx,
      );
      return { ok: true, data: { planId: p.id, state: input.state } };
    });
    if (out.ok) {
      const v = await this.#publish(input.planId, 'state');
      if (v !== null && input.state === 'done')
        await this.#notify(
          { id: v.id, thread_id: v.threadId, user_id: c.userId, title: v.title, goal: v.goal },
          'done',
          {
            occurrence: 'done',
          },
        );
    }
    return out;
  }

  /** `plan_read`: the full plan (default: the active one). */
  async read(c: PlanCaller, input: { planId?: string }): Promise<PlanToolOutcome> {
    const p =
      input.planId === undefined
        ? await this.#activeRow(this.deps.pool, c.threadId)
        : await this.#plan(this.deps.pool, input.planId);
    if (p?.thread_id !== c.threadId)
      return { ok: false, code: 'not_found', message: 'This conversation has no such plan.' };
    const v = await this.#view(this.deps.pool, p);
    return {
      ok: true,
      data: {
        planId: v.id,
        title: v.title,
        goal: v.goal,
        assumptions: v.assumptions,
        risks: v.risks,
        state: v.state,
        version: v.version,
        approvedVersion: v.approvedVersion,
        stalled: v.stalled,
        progress: v.progress,
        phases: v.phases.map((ph) => ({
          title: ph.title,
          items: v.items
            .filter((i) => i.phase === ph.index)
            .map((i) => ({
              key: i.key,
              title: i.title,
              activeTitle: i.activeTitle,
              detail: i.detail,
              status: i.status,
              owner: i.owner,
              project: i.project,
              dependsOn: i.dependsOn,
              estimate: i.estimate,
              links: i.links,
              note: i.note,
              ...(i.decisionOpen ? { decisionOpen: true } : {}),
            })),
        })),
        decisions: v.decisions.map((d) => ({
          id: d.id,
          item: d.itemKey,
          prompt: d.prompt,
          state: d.state,
          recommended: d.recommended,
          answer: d.answer,
        })),
        userEdited: await this.#userEdit(p),
      },
    };
  }

  /**
   * A card a draft tool made for an item (`planItem`): linked to the item of the conversation's active plan, which is
   * then in progress (it follows the card from now on). Returns a note for the model (null: linked).
   */
  async linkDraft(threadId: string, key: string, draft: DraftRecord): Promise<string | null> {
    const out = await withTransaction(this.deps.pool, async (tx) => {
      const p = await this.#activeRow(tx, threadId, true);
      if (p === null) return 'There is no active plan in this conversation; planItem was ignored.';
      const { items } = await this.#items(tx, p.id);
      const item = items.find((i) => i.key === key);
      if (item === undefined) return `No item ${key} in the plan; the card is not linked.`;
      if (item.status === 'done') return `Item ${key} is done; the card is not linked.`;
      const link: PlanLink = {
        kind: 'draft',
        id: draft.id,
        label: clipNote(draft.title).slice(0, PLAN_LIMITS.linkLabel),
      };
      const next: PlanItem = {
        ...item,
        status: 'in_progress',
        statusBy: 'derived',
        note: null,
        links: [...item.links, link].slice(-PLAN_LIMITS.links),
      };
      await this.#saveItems(tx, p.id, [next], []);
      await this.#touch(tx, p.id);
      return { planId: p.id, plan: p, item: item.title };
    });
    if (typeof out === 'string') return out;
    await this.#publish(out.planId, 'status');
    // W4: an executing plan's item waits for its owner's card (autonomy off, or the policy keeps it on a card).
    if (draft.state === 'proposed' && out.plan.state === 'executing')
      await this.#notify(out.plan, 'waiting', { occurrence: draft.id, item: out.item });
    return null;
  }

  // ---------------------------------------------------------------------------------------------- the person

  async #ownPlan(userId: string, planId: string, db: Queryable, lock = false): Promise<PlanRow> {
    const p = await this.#plan(db, planId, lock);
    if (p === null || p.user_id !== userId) throw planNotFound();
    return p;
  }

  /** The current plan for a 409 answer (the console shows "Plan güncellendi — farkları gör"). */
  async #current(planId: string): Promise<{ plan: PlanView | null }> {
    const p = await this.#plan(this.deps.pool, planId);
    return { plan: p === null ? null : await this.#view(this.deps.pool, p) };
  }

  /**
   * "Onayla": leaves plan mode and starts execution (the first continuation turn follows). p18-plan-autonomy:
   * `autonomous` (default true, "Otonom yürüt") is the owner's consent to run the plan's drafts without a card each.
   */
  async approve(actor: ActorContext, planId: string, version: number, autonomous = true): Promise<PlanView> {
    const res = await withTransaction(this.deps.pool, async (tx) => {
      const p = await this.#ownPlan(actor.userId, planId, tx, true);
      if (p.state !== 'in_review' && p.state !== 'drafting')
        return { conflict: 'plan_not_in_review' as const, state: p.state };
      if (p.version !== version) return { conflict: 'plan_version_conflict' as const, state: p.state };
      const { rows } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM user_questions WHERE plan_id = $1 AND state = 'pending'`,
        [p.id],
      );
      const open = Number(rows[0]?.n ?? 0);
      if (open > 0) return { conflict: 'plan_decisions_open' as const, state: p.state, open };
      await this.#touch(
        tx,
        p.id,
        `state = 'executing', approved_version = version, cont_due = true, stalled = NULL, cont_turn = NULL, cont_mark = NULL,
         autonomous = $3`,
        [autonomous],
      );
      await tx.query('UPDATE chat_threads SET plan_mode_since = NULL WHERE id = $1', [p.thread_id]);
      await tx.query('UPDATE chat_plan_items SET failures = 0 WHERE plan_id = $1 AND failures > 0', [p.id]);
      await this.#audit('chat.plan.approve', actor, p, { version: p.version, autonomous }, tx);
      return { conflict: null, threadId: p.thread_id };
    });
    if (res.conflict === 'plan_not_in_review')
      throw new HttpError(
        409,
        'plan_not_in_review',
        `The plan is ${res.state}; only a plan in review can be approved.`,
        {},
        await this.#current(planId),
      );
    if (res.conflict === 'plan_version_conflict')
      throw new HttpError(
        409,
        'plan_version_conflict',
        'The plan was updated meanwhile — review the changes, then approve.',
        {},
        await this.#current(planId),
      );
    if (res.conflict === 'plan_decisions_open')
      throw new HttpError(
        409,
        'plan_decisions_open',
        `Answer the plan's open decisions first (${String(res.open)}).`,
        {},
        {},
        { count: res.open },
      );
    const plan = await this.#publish(planId, 'state');
    try {
      this.#threadChanged(await this.deps.store.thread(actor.userId, res.threadId));
    } catch {
      // deleted meanwhile
    }
    void this.#continue(planId);
    if (plan === null) throw planNotFound();
    return plan;
  }

  /** "Değişiklik iste": the note goes to the assistant as the person's message in plan mode (it revises → v+1). */
  async requestChanges(
    actor: ActorContext,
    planId: string,
    version: number,
    note: string,
    stepUp?: { mfaAt: Date | null; stepUpMaxAgeMs?: number; alwaysFreshMaxAgeMs?: number },
  ): Promise<{ turnId: string }> {
    const p = await this.#ownPlan(actor.userId, planId, this.deps.pool);
    if (p.state !== 'in_review' && p.state !== 'drafting')
      throw new HttpError(
        409,
        'plan_not_in_review',
        `The plan is ${p.state}; changes are asked while it is in review.`,
        {},
        await this.#current(planId),
      );
    if (p.version !== version)
      throw new HttpError(
        409,
        'plan_version_conflict',
        'The plan was updated meanwhile — review the changes, then approve.',
        {},
        await this.#current(planId),
      );
    const chat = this.deps.chat();
    if (chat === null) throw new HttpError(409, 'chat_disabled', 'Chat is turned off.');
    await this.setMode(actor.userId, p.thread_id, true);
    const tr = guessLanguage([note, p.title]) === 'tr';
    const text = tr
      ? `Plan v${String(p.version)} için değişiklik isteği:\n${note}`
      : `Change request for plan v${String(p.version)}:\n${note}`;
    const sent = await chat.send(actor, p.thread_id, text, {
      byUser: true,
      ...(stepUp === undefined ? {} : { stepUp }),
    });
    await this.#audit('chat.plan.request_changes', actor, p, {
      version: p.version,
      chars: note.length,
      turnId: sent.turnId,
    });
    return sent;
  }

  async pause(actor: ActorContext, planId: string): Promise<PlanView> {
    return this.#transition(
      actor,
      planId,
      ['executing'],
      `state = 'paused', cont_due = false`,
      'chat.plan.pause',
    );
  }

  /** "Devam": a paused plan executes again; a stalled one ("Plana devam edeyim mi?") goes on. */
  async resume(actor: ActorContext, planId: string): Promise<PlanView> {
    const v = await this.#transition(
      actor,
      planId,
      ['paused', 'executing'],
      `state = 'executing', cont_due = true, stalled = NULL, cont_turn = NULL, cont_mark = NULL`,
      'chat.plan.resume',
      // p18-plan-autonomy: "Devam et" also lets the platform retry an item it stopped retrying (failure cap).
      async (tx, id) => {
        await tx.query('UPDATE chat_plan_items SET failures = 0 WHERE plan_id = $1 AND failures >= $2', [
          id,
          PLAN_ITEM_FAILURE_CAP,
        ]);
      },
    );
    void this.#continue(planId);
    return v;
  }

  async cancel(actor: ActorContext, planId: string): Promise<PlanView> {
    const v = await this.#transition(
      actor,
      planId,
      ['drafting', 'in_review', 'approved', 'executing', 'paused'],
      `state = 'cancelled', cont_due = false, closed_at = $2`,
      'chat.plan.cancel',
      async (tx, id) => {
        await this.deps.questions()?.closePlanDecisions(id, 'plan_cancelled', tx);
      },
    );
    return v;
  }

  /**
   * p18-plan-autonomy: ⋯ "Otonom yürütmeyi kapat / aç" — the owner turns autonomous execution off (drafts wait as cards
   * again) or on (continuation drafts run at once). Audited `chat.plan.autonomy`; an executing plan turned on is due.
   */
  async setAutonomy(actor: ActorContext, planId: string, autonomous: boolean): Promise<PlanView> {
    const bad = await withTransaction(this.deps.pool, async (tx) => {
      const p = await this.#ownPlan(actor.userId, planId, tx, true);
      if (!ACTIVE.has(p.state)) return p.state;
      if (p.autonomous === autonomous) return null;
      await this.#touch(
        tx,
        p.id,
        `autonomous = $3${autonomous && p.state === 'executing' ? ', cont_due = true' : ''}`,
        [autonomous],
      );
      await this.#audit(
        'chat.plan.autonomy',
        actor,
        p,
        { version: p.version, autonomous, state: p.state },
        tx,
      );
      return null;
    });
    if (bad !== null)
      throw new HttpError(409, 'plan_state_conflict', `The plan is ${bad}.`, {}, await this.#current(planId));
    const v = await this.#publish(planId, 'state');
    if (autonomous) void this.#continue(planId);
    if (v === null) throw planNotFound();
    return v;
  }

  /**
   * p18-plan-autonomy: the plan a continuation turn carries on, for the direct decision of a draft it made — null when
   * it is not this conversation's active plan of this owner. `capped`: the draft's item failed PLAN_ITEM_FAILURE_CAP
   * times in a row (the person decides on the card).
   */
  async directContext(
    threadId: string,
    planId: string,
    userId: string,
    itemKey: string | null,
  ): Promise<{
    readonly planId: string;
    readonly version: number;
    readonly state: PlanState;
    readonly autonomous: boolean;
    readonly capped: boolean;
  } | null> {
    try {
      const p = await this.#plan(this.deps.pool, planId);
      if (p === null || p.thread_id !== threadId || p.user_id !== userId || !ACTIVE.has(p.state)) return null;
      const capped =
        itemKey !== null &&
        ((await this.#failures(this.deps.pool, p.id)).get(itemKey) ?? 0) >= PLAN_ITEM_FAILURE_CAP;
      return { planId: p.id, version: p.version, state: p.state, autonomous: p.autonomous, capped };
    } catch (err) {
      this.deps.log.warn({ err, planId }, 'plan direct context not read');
      return null;
    }
  }

  async #transition(
    actor: ActorContext,
    planId: string,
    from: readonly PlanState[],
    set: string,
    action: string,
    also?: (tx: Queryable, planId: string) => Promise<void>,
  ): Promise<PlanView> {
    const bad = await withTransaction(this.deps.pool, async (tx) => {
      const p = await this.#ownPlan(actor.userId, planId, tx, true);
      if (!from.includes(p.state)) return p.state;
      await this.#touch(tx, p.id, set);
      await also?.(tx, p.id);
      await this.#audit(action, actor, p, { version: p.version, from: p.state }, tx);
      return null;
    });
    if (bad !== null)
      throw new HttpError(409, 'plan_state_conflict', `The plan is ${bad}.`, {}, await this.#current(planId));
    const v = await this.#publish(planId, 'state');
    if (v === null) throw planNotFound();
    return v;
  }

  /** The person's edits with the revision they saw (409 `plan_rev_conflict` with the current plan). */
  async edit(actor: ActorContext, planId: string, raw: unknown): Promise<PlanView> {
    const parsed = PlanUserEdit.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, 'invalid_plan_edit', 'The plan change is not valid.');
    const body = parsed.data;
    const res = await withTransaction(this.deps.pool, async (tx) => {
      const p = await this.#ownPlan(actor.userId, planId, tx, true);
      if (!ACTIVE.has(p.state)) return { error: 'closed' as const, state: p.state };
      if (Number(p.rev) !== body.baseRev) return { error: 'rev' as const };
      const { items, used, deleted } = await this.#items(tx, p.id);
      // p18-multi-project W3: an item's project is one of the conversation's working projects (when it has any).
      const named = body.ops.flatMap((o) =>
        o.op === 'set_project' && o.project !== null ? [o.project] : [],
      );
      if (named.length > 0) {
        const set = await threadProjectIds(tx, p.thread_id);
        const outside = named.filter((x) => !set.includes(x));
        if (set.length > 0 && outside.length > 0)
          return {
            error: 'op' as const,
            code: 'project_not_in_thread',
            message: `${outside.join(', ')} is not one of this conversation's working projects.`,
          };
      }
      let next: ReturnType<typeof applyUserOps>;
      try {
        next = applyUserOps(items, body.ops, used, deleted);
      } catch (err) {
        if (err instanceof PlanOpError) return { error: 'op' as const, code: err.code, message: err.message };
        throw err;
      }
      await this.#saveItems(tx, p.id, next.items, next.removed);
      const version = next.structural ? p.version + 1 : p.version;
      if (next.structural) await this.#version(tx, p, version, 'user', null, next.items);
      // While executing, an edit that may free work (an item added / restored / unskipped, a blocker skipped, removed or
      // done, an owner changed) makes the plan due — a continuation follows only when something is actionable for the
      // assistant and no turn runs. A rename, a move or an estimate never starts a turn.
      const due = p.state === 'executing' && body.ops.some((o) => FREEING_OPS.has(o.op));
      await this.#touch(tx, p.id, `version = $3${due ? ', cont_due = true' : ''}`, [version]);
      await this.#audit(
        'chat.plan.edit',
        actor,
        p,
        {
          by: 'user',
          version,
          ops: body.ops.map((o) => o.op),
          ...(next.structural ? { structural: true } : {}),
        },
        tx,
      );
      return { error: null, due };
    });
    if (res.error === 'closed')
      throw new HttpError(
        409,
        'plan_state_conflict',
        `The plan is ${res.state}; it cannot be edited.`,
        {},
        await this.#current(planId),
      );
    if (res.error === 'rev')
      throw new HttpError(
        409,
        'plan_rev_conflict',
        'The plan changed meanwhile (the assistant too) — see the current plan.',
        {},
        await this.#current(planId),
      );
    if (res.error === 'op') throw editRefused(res.code, res.message);
    const v = await this.#publish(planId, 'items');
    if (res.due) void this.#continue(planId);
    if (v === null) throw planNotFound();
    return v;
  }

  /**
   * A plan decision answered (the question answer route, from the panel or the card — the same row): recorded, the views
   * refreshed; while executing, the plan goes on. No turn starts by itself during review (the answers reach the
   * assistant in the plan block of the next turn).
   */
  async answerDecision(
    actor: ActorContext,
    threadId: string,
    questionId: string,
    answers: unknown,
  ): Promise<{ question: QuestionView; turnId: null }> {
    const q = this.deps.questions();
    if (q === null) throw new HttpError(404, 'question_not_found', 'Question not found.');
    const { view } = await q.answerThread(actor, threadId, questionId, answers);
    const planId = view.planId ?? null;
    if (planId !== null) {
      await this.deps.pool.query(
        `UPDATE chat_plans SET rev = rev + 1, updated_at = $2,
                cont_due = cont_due OR state = 'executing'
          WHERE id = $1`,
        [planId, this.#now()],
      );
      await this.#publish(planId, 'decision');
      void this.#continue(planId);
    }
    return { question: view, turnId: null };
  }

  // ---------------------------------------------------------------------------------------------- execution

  step(everyMs = 5_000): { name: string; run: () => Promise<number> } {
    return {
      name: 'chat-plans',
      run: async () => {
        const t = this.#now().getTime();
        if (t - this.#lastStep < everyMs) return 0;
        this.#lastStep = t;
        return this.tick();
      },
    };
  }

  /** One pass: statuses from linked cards / jobs / runs, then the continuation of plans whose wait ended. */
  async tick(): Promise<number> {
    let n = 0;
    // p20-outcome: a continuation claimed but never turned into a turn (the process died, the send hung past its
    // lease) is due again — its claim expired, a turnless message of it removed.
    try {
      for (const r of await reapDeliveries(this.deps.pool, 'plan', this.#now())) {
        await this.deps.pool.query(
          `UPDATE chat_plans SET cont_due = true WHERE id = $1 AND state = 'executing'`,
          [r.refId],
        );
        this.deps.log.info({ planId: r.refId, key: r.key }, 'plan continuation lease expired; due again');
      }
    } catch (err) {
      this.deps.log.warn({ err }, 'plan continuation claims not reaped');
    }
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM chat_plans WHERE state IN ('executing', 'paused') ORDER BY updated_at LIMIT 200`,
    );
    for (const r of rows) {
      try {
        if (await this.#derive(r.id)) n++;
      } catch (err) {
        this.deps.log.error({ err, planId: r.id }, 'plan statuses not derived');
      }
    }
    const { rows: due } = await this.deps.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM chat_plans WHERE state = 'executing' AND cont_due AND stalled IS NULL
        ORDER BY updated_at LIMIT 50`,
    );
    for (const r of due) {
      if (await this.#continue(r.id)) n++;
    }
    return n;
  }

  async #facts(items: readonly PlanItem[]): Promise<LinkFacts> {
    const ids = (kind: string): string[] => [
      ...new Set(items.flatMap((i) => i.links.filter((l) => l.kind === kind).map((l) => l.id))),
    ];
    const uuid = (v: string): boolean =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const draftIds = ids('draft').filter(uuid);
    const { rows: drafts } =
      draftIds.length === 0
        ? { rows: [] }
        : await this.deps.pool.query<{ id: string; state: string; result: Record<string, unknown> | null }>(
            `SELECT id::text AS id, state, result FROM chat_drafts WHERE id = ANY($1::uuid[])`,
            [draftIds],
          );
    const draftMap = new Map(
      drafts.map((d) => {
        const jobId = typeof d.result?.jobId === 'string' && uuid(d.result.jobId) ? d.result.jobId : null;
        const runId = typeof d.result?.runId === 'string' && uuid(d.result.runId) ? d.result.runId : null;
        const automationId =
          typeof d.result?.automationId === 'string' && uuid(d.result.automationId)
            ? d.result.automationId
            : null;
        const batchId =
          typeof d.result?.batchId === 'string' && uuid(d.result.batchId) ? d.result.batchId : null;
        return [d.id, { state: d.state, jobId, runId, automationId, batchId }] as const;
      }),
    );
    const jobIds = [
      ...new Set([
        ...ids('job').filter(uuid),
        // W4: an output link follows its job.
        ...ids('output').flatMap((o) => {
          const j = outputJob(o);
          return j === null ? [] : [j];
        }),
        ...[...draftMap.values()].flatMap((d) => (d.jobId === null ? [] : [d.jobId])),
      ]),
    ];
    const runIds = [
      ...new Set([
        ...ids('workflow_run').filter(uuid),
        ...[...draftMap.values()].flatMap((d) => (d.runId === null ? [] : [d.runId])),
      ]),
    ];
    // p19-verifier-jobs: an item linked to a platform verifier follows the job it checks, not the verifier (a verifier
    // that could not run is the verification's matter, never a failed plan item).
    const { rows: followed } =
      jobIds.length === 0
        ? { rows: [] }
        : await this.deps.pool.query<{ id: string; checked: string }>(
            `SELECT job_id::text AS id, checked_job_id::text AS checked FROM report_only_jobs
              WHERE job_id = ANY($1::uuid[]) AND checked_job_id IS NOT NULL`,
            [jobIds],
          );
    const follow = new Map(followed.map((f) => [f.id, f.checked] as const));
    const readIds = [...new Set(jobIds.map((id) => follow.get(id) ?? id))];
    const { rows: jobRows } =
      readIds.length === 0
        ? { rows: [] }
        : await this.deps.pool.query<{ id: string; state: string; summary: string | null }>(
            `SELECT j.id::text AS id, j.state::text AS state,
                    (SELECT r.result->>'summary' FROM job_runs r WHERE r.job_id = j.id
                      ORDER BY r.created_at DESC LIMIT 1) AS summary
               FROM jobs j WHERE j.id = ANY($1::uuid[])`,
            [readIds],
          );
    const jobs = followCheckedJobs(jobIds, follow, jobRows);
    const { rows: runs } =
      runIds.length === 0
        ? { rows: [] }
        : await this.deps.pool.query<{ id: string; state: string; reason: string | null }>(
            `SELECT id::text AS id, state, reason FROM workflow_runs WHERE id = ANY($1::uuid[])`,
            [runIds],
          );
    // W4: pull requests the platform opened (a job's PR, an integration's) by URL.
    const prUrls = ids('pr').filter((u) => /^https:\/\/\S{1,2000}$/.test(u));
    const prs = new Map<string, { state: 'open' | 'merged' | 'closed'; reason: string | null }>();
    if (prUrls.length > 0) {
      const { rows } = await this.deps.pool.query<{
        url: string;
        state: 'open' | 'merged' | 'closed';
        reason: string | null;
      }>(
        `SELECT g.pr_url AS url,
                CASE WHEN g.merged_at IS NOT NULL THEN 'merged'
                     WHEN (SELECT m.status FROM git_merge_requests m WHERE m.job_id = g.job_id
                            ORDER BY m.created_at DESC LIMIT 1) = 'discarded' THEN 'closed'
                     ELSE 'open' END AS state,
                NULL::text AS reason
           FROM job_git g WHERE g.pr_url = ANY($1::text[])
         UNION ALL
         SELECT i.pr_url, CASE WHEN i.state = 'merged' THEN 'merged'
                               WHEN i.state IN ('failed', 'cancelled') THEN 'closed' ELSE 'open' END, i.reason
           FROM integrations i WHERE i.pr_url = ANY($1::text[])`,
        [prUrls],
      );
      // A merged / closed row wins over an open one of the same URL.
      for (const r of rows) {
        const cur = prs.get(r.url);
        if (cur === undefined || cur.state === 'open') prs.set(r.url, { state: r.state, reason: r.reason });
      }
    }
    // W4: automations (linked directly or through a confirmed automation card).
    const autoIds = [
      ...new Set([
        ...ids('automation').filter(uuid),
        ...[...draftMap.values()].flatMap((d) => (d.automationId === null ? [] : [d.automationId])),
      ]),
    ];
    const { rows: autos } =
      autoIds.length === 0
        ? { rows: [] }
        : await this.deps.pool.query<{
            id: string;
            state: string;
            succeeded: boolean;
            last_state: string | null;
            last_reason: string | null;
          }>(
            `SELECT a.id::text AS id, a.state,
                    EXISTS (SELECT 1 FROM automation_runs r WHERE r.automation_id = a.id AND r.state = 'succeeded')
                      AS succeeded,
                    l.state AS last_state, l.reason AS last_reason
               FROM automations a
               LEFT JOIN LATERAL (SELECT r.state, r.reason FROM automation_runs r
                                   WHERE r.automation_id = a.id AND r.finished_at IS NOT NULL
                                     AND r.state IN ('succeeded', 'failed', 'error', 'cancelled')
                                   ORDER BY r.finished_at DESC LIMIT 1) l ON true
              WHERE a.id = ANY($1::uuid[])`,
            [autoIds],
          );
    // p18-multi-project W5: job batches (linked directly or through a confirmed batch card).
    const batchIds = [
      ...new Set([
        ...ids('batch').filter(uuid),
        ...[...draftMap.values()].flatMap((d) => (d.batchId === null ? [] : [d.batchId])),
      ]),
    ];
    const batches = new Map<
      string,
      { state: 'running' | 'done' | 'failed' | 'refused'; note: string | null }
    >();
    if (batchIds.length > 0) {
      const { rows } = await this.deps.pool.query<{
        batch_id: string;
        job_id: string | null;
        state: string | null;
      }>(
        `SELECT m.batch_id::text AS batch_id, m.job_id::text AS job_id, j.state::text AS state
           FROM job_batch_members m LEFT JOIN jobs j ON j.id = m.job_id WHERE m.batch_id = ANY($1::uuid[])`,
        [batchIds],
      );
      for (const id of batchIds) {
        const members = rows
          .filter((r) => r.batch_id === id)
          .map((r) => ({ jobId: r.job_id, state: r.state }));
        if (members.length === 0) continue;
        const st = batchState(members);
        const created = members.filter((m) => m.jobId !== null).length;
        batches.set(id, {
          state: st.state,
          note: st.state === 'failed' ? `${String(st.failed)}/${String(created)} jobs failed` : null,
        });
      }
    }
    return {
      batches,
      drafts: draftMap,
      jobs: new Map(jobs.map((j) => [j.id, { state: j.state, summary: j.summary }] as const)),
      runs: new Map(runs.map((r) => [r.id, { state: r.state, reason: r.reason }] as const)),
      prs,
      automations: new Map(
        autos.map(
          (a) =>
            [
              a.id,
              { state: a.state, succeeded: a.succeeded, lastState: a.last_state, lastReason: a.last_reason },
            ] as const,
        ),
      ),
    };
  }

  /** Statuses from links; a change that ends a wait marks the plan due for continuation. True when anything changed. */
  async #derive(planId: string): Promise<boolean> {
    const pre = await this.#items(this.deps.pool, planId);
    if (!pre.items.some((i) => i.links.length > 0)) return false;
    const facts = await this.#facts(pre.items);
    const changed = await withTransaction(this.deps.pool, async (tx) => {
      const p = await this.#plan(tx, planId, true);
      if (p === null || (p.state !== 'executing' && p.state !== 'paused')) return null;
      const { items } = await this.#items(tx, planId);
      const failures = await this.#failures(tx, planId);
      const updates: PlanItem[] = [];
      const counts: { key: string; n: number }[] = [];
      const capped: PlanItem[] = [];
      let event = false;
      for (const i of items) {
        if (i.status === 'done' || i.status === 'skipped' || i.links.length === 0) continue;
        const d: Derived | null = derivedStatus(i.links, facts);
        if (d === null) continue;
        // The assistant blocked a running item with a note: keep it until the target itself ends.
        if (i.status === 'blocked' && i.statusBy === 'assistant' && d.status === 'in_progress') continue;
        const links =
          d.addLinks.length === 0 ? i.links : [...i.links, ...d.addLinks].slice(-PLAN_LIMITS.links);
        const note =
          d.status === 'blocked'
            ? d.note
            : d.status === 'done'
              ? null
              : i.statusBy === 'derived'
                ? null
                : i.note;
        if (d.status === i.status && links.length === i.links.length && note === i.note) continue;
        // p18-plan-autonomy: consecutive failed attempts of the item (a failed job / run counts once, done clears).
        const n = failuresAfter(i.status, d, failures.get(i.key) ?? 0);
        if (n !== null) counts.push({ key: i.key, n });
        const next: PlanItem = { ...i, status: d.status, statusBy: 'derived', note, links };
        if (n !== null && n >= PLAN_ITEM_FAILURE_CAP) capped.push(next);
        updates.push(next);
        if (d.status !== i.status || d.addLinks.length > 0) event = true;
      }
      if (updates.length === 0) return null;
      await this.#saveItems(tx, planId, updates, []);
      for (const c of counts)
        await tx.query('UPDATE chat_plan_items SET failures = $3 WHERE plan_id = $1 AND key = $2', [
          planId,
          c.key,
          c.n,
        ]);
      await this.#touch(tx, planId, event && p.state === 'executing' ? 'cont_due = true' : '');
      return { p, capped };
    });
    if (changed === null) return false;
    for (const item of changed.capped) await this.#capped(changed.p, item);
    await this.#publish(planId, 'status');
    return true;
  }

  /**
   * p18-plan-autonomy: an item failed PLAN_ITEM_FAILURE_CAP times in a row — the platform stops retrying it; the owner is
   * told in the conversation (the "Plana devam edeyim mi?" notice with the item: "Devam et" clears the count) and by a
   * notification. Other ready items go on.
   */
  async #capped(p: PlanRow, item: PlanItem): Promise<void> {
    await this.#audit('chat.plan.item_capped', { userId: p.user_id }, p, {
      version: p.version,
      item: item.key,
      failures: PLAN_ITEM_FAILURE_CAP,
    });
    try {
      const message = await this.deps.store.addMessage(p.thread_id, {
        role: 'error',
        content: `The plan item “${item.title}” failed ${String(PLAN_ITEM_FAILURE_CAP)} times in a row and is blocked: ${item.note ?? ''}. Continue the plan to let the assistant try again.`,
        meta: {
          notice: 'plan-continue',
          planId: p.id,
          reason: 'item_failed',
          itemKey: item.key,
          itemTitle: item.title,
          ...(item.note === null ? {} : { note: item.note }),
        },
      });
      this.deps.publish(p.thread_id, 'message', message);
    } catch (err) {
      this.deps.log.debug({ err, planId: p.id }, 'plan item cap notice not recorded');
    }
    await this.#notify(p, 'blocked', {
      occurrence: `${item.key}:capped:${String(this.#now().getTime())}`,
      item: item.title,
      note:
        guessLanguage([p.title, item.title]) === 'tr'
          ? `${String(PLAN_ITEM_FAILURE_CAP)} denemede başarısız oldu: ${item.note ?? ''}`
          : `failed ${String(PLAN_ITEM_FAILURE_CAP)} times: ${item.note ?? ''}`,
    });
  }

  /**
   * Sends the next continuation turn of an executing plan when it is due and nothing runs in the conversation: a
   * system-written message (`byUser: false`, so every draft stays a card) naming the next item. The cost brake and the
   * daily token budget stop it ("Plana devam edeyim mi?"); an unavailable assistant only delays it.
   */
  async #continue(planId: string): Promise<boolean> {
    if (this.#sending.has(planId)) return false;
    this.#sending.add(planId);
    try {
      const chat = this.deps.chat();
      if (chat === null) return false;
      const p = await this.#plan(this.deps.pool, planId);
      if (p?.state !== 'executing' || !p.cont_due || p.stalled !== null) return false;
      if (!(await chat.idle(p.thread_id))) return false;
      if (!(await chat.planReady())) return false;
      const { items } = await this.#items(this.deps.pool, planId);
      const decisions = await this.#decisions(planId);
      const open = new Set(
        decisions.filter((d) => d.state === 'pending' && d.itemKey !== null).map((d) => d.itemKey as string),
      );
      const next = readyItems(items, open)[0] ?? null;
      // Something for the assistant to do: a ready item, or an item its job / run / card blocked. Otherwise the plan
      // waits (a job runs, a card or a decision waits for the person) — nothing is sent.
      // p18-plan-autonomy: an item that failed PLAN_ITEM_FAILURE_CAP times in a row is not retried by itself.
      const failures = await this.#failures(this.deps.pool, planId);
      const blocked =
        items.find(
          (i) =>
            i.status === 'blocked' &&
            i.statusBy === 'derived' &&
            (failures.get(i.key) ?? 0) < PLAN_ITEM_FAILURE_CAP,
        ) ?? null;
      if (next === null && blocked === null) {
        await this.deps.pool.query('UPDATE chat_plans SET cont_due = false WHERE id = $1', [planId]);
        return false;
      }
      const tr = guessLanguage([p.title, p.goal]) === 'tr';
      const head = tr ? `Onaylı plan v${String(p.version)}` : `Approved plan v${String(p.version)}`;
      const blockedLine =
        blocked === null
          ? ''
          : tr
            ? ` Engellenen madde: ${blocked.title} (${blocked.key}): ${blocked.note ?? ''}.`
            : ` Blocked item: ${blocked.title} (${blocked.key}): ${blocked.note ?? ''}.`;
      const line =
        next !== null
          ? tr
            ? `${head} — sıradaki madde: ${next.title} (${next.key}).${blockedLine} Planı sürdür.`
            : `${head} — next item: ${next.title} (${next.key}).${blockedLine} Continue the plan.`
          : tr
            ? `${head} — madde engellendi.${blockedLine} Planı sürdür.`
            : `${head} — an item is blocked.${blockedLine} Continue the plan.`;
      // p18-project-bootstrap: the next job / workflow item's project is not set up yet — a readiness decision first.
      const setup = next === null ? null : await this.#readinessLine(next, tr, chat);
      // p18-plan-autonomy: an autonomous plan's turn is told to act (its drafts run at once), not to wait for clicks.
      const body = setup === null ? line : `${line}\n\n${setup}`;
      const text = p.autonomous ? `${body}\n\n${PLAN_AUTONOMY_INSTRUCTION}` : body;
      const mark = progressMark(items, decisions.filter((d) => d.state === 'answered').length, p.version);
      // p20-outcome: a leased claim (chat_deliveries) — "sent" only with the turn; a claim that never became a turn is
      // due again after its lease (tick). One live claim per plan, also across replicas.
      const claim = await claimDelivery(this.deps.pool, {
        key: `plan:${planId}:${randomUUID()}`,
        kind: 'plan',
        refId: planId,
        threadId: p.thread_id,
        now: this.#now(),
      });
      if (claim === null) return false;
      // Claimed before sending: an event that arrives while the turn is on its way sets `cont_due` again.
      await this.deps.pool.query(
        `UPDATE chat_plans SET cont_due = false, cont_mark = $2, updated_at = $3 WHERE id = $1`,
        [planId, mark, this.#now()],
      );
      let turnId: string;
      try {
        turnId = (
          await chat.send({ userId: p.user_id, ip: 'system', userAgent: null }, p.thread_id, text, {
            plan: { planId, next: next?.key ?? null },
            delivery: claim,
          })
        ).turnId;
      } catch (err) {
        const code = err instanceof HttpError ? err.code : 'error';
        // Taken over (the lease ran out and the continuation is due / sent again): nothing to restore.
        if (code === 'delivery_superseded') return false;
        await this.deps.pool.query('UPDATE chat_plans SET cont_due = true WHERE id = $1', [planId]);
        if (code === 'cost_brake_active' || code === 'budget_exceeded') {
          await failDelivery(this.deps.pool, claim, code, this.#now());
          await this.#stall(p, code === 'cost_brake_active' ? 'cost_brake' : 'budget');
          return false;
        }
        await releaseDelivery(this.deps.pool, claim, code.replace(/[^a-z_]/g, '_').slice(0, 40), this.#now());
        if (code !== 'turn_in_progress' && code !== 'rate_limited' && code !== 'assistant_unavailable')
          this.deps.log.info({ planId, code }, 'plan continuation not sent; retried later');
        return false;
      }
      // The chat service wrote "sent" with the turn; a sender that does not (a test double) is completed here.
      await completeDelivery(this.deps.pool, claim, turnId, this.#now()).catch((err: unknown) => {
        this.deps.log.warn({ err, planId }, 'plan continuation delivery not completed');
      });
      await this.deps.pool.query(`UPDATE chat_plans SET cont_turn = $2 WHERE id = $1`, [planId, turnId]);
      return true;
    } catch (err) {
      this.deps.log.warn({ err, planId }, 'plan continuation failed');
      return false;
    } finally {
      this.#sending.delete(planId);
    }
  }

  /**
   * p18-project-bootstrap (docs/design/p18-project-bootstrap.md §4.3): the continuation's readiness instruction when the
   * next item is a job / workflow item of a project without a linked repository, a decided network access or a machine
   * that can run its jobs — null when it is ready, not a job / workflow item, or the answering machine has no setup
   * tools. Opening the network and assigning machines are the user's decisions, also in an autonomous plan.
   */
  async #readinessLine(
    item: { readonly owner: string; readonly project: string | null },
    tr: boolean,
    chat: PlanChat,
  ): Promise<string | null> {
    if ((item.owner !== 'job' && item.owner !== 'workflow') || item.project === null) return null;
    const check = this.deps.readiness?.() ?? null;
    if (check === null) return null;
    try {
      if (chat.projectSetupReady === undefined || !(await chat.projectSetupReady())) return null;
      const gaps = ((await check(item.project)) ?? []).filter(
        (g) => g === 'repository' || g === 'network' || g === 'machines',
      );
      if (gaps.length === 0) return null;
      return planReadinessLine(item.project, gaps, tr);
    } catch (err) {
      this.deps.log.debug({ err, project: item.project }, 'plan readiness not checked');
      return null;
    }
  }

  /** The plan cannot go on by itself: say so once with the "Plana devam edeyim mi?" card. */
  async #stall(p: PlanRow, reason: string): Promise<void> {
    const { rowCount } = await this.deps.pool.query(
      `UPDATE chat_plans SET stalled = $2, cont_due = false, rev = rev + 1, updated_at = $3
        WHERE id = $1 AND stalled IS NULL`,
      [p.id, reason, this.#now()],
    );
    if ((rowCount ?? 0) === 0) return;
    try {
      const message = await this.deps.store.addMessage(p.thread_id, {
        role: 'error',
        content: `The plan “${p.title}” is waiting: ${reason}. Continue it from the plan panel or this card.`,
        meta: { notice: 'plan-continue', planId: p.id, reason },
      });
      this.deps.publish(p.thread_id, 'message', message);
    } catch (err) {
      this.deps.log.debug({ err, planId: p.id }, 'plan stall notice not recorded');
    }
    const v = await this.#publish(p.id, 'state');
    await this.#notify(p, 'waiting', {
      occurrence: `stall:${String(v?.rev ?? this.#now().getTime())}`,
      note: reason,
    });
  }

  /**
   * A turn of the conversation ended: a continuation turn that left the plan exactly where it was made no progress (the
   * plan waits for the person: "Plana devam edeyim mi?"); one that failed waits the same way; one that progressed while
   * nothing is under way and items are ready goes on.
   */
  async turnEnded(t: {
    turnId: string;
    threadId: string;
    state: 'done' | 'failed' | 'cancelled';
  }): Promise<void> {
    try {
      const p = await this.#activeRow(this.deps.pool, t.threadId);
      if (p?.state !== 'executing') return;
      // A continuation turn of this plan: its message says so (the turn may end before its id was recorded).
      const { rows: own } = await this.deps.pool.query<{ plan: string | null }>(
        `SELECT m.meta->'plan'->>'id' AS plan FROM chat_turns t JOIN chat_messages m ON m.id = t.message_id
          WHERE t.id = $1 AND m.meta->>'origin' = 'plan'`,
        [t.turnId],
      );
      if (own[0]?.plan === p.id) {
        if (t.state !== 'done') {
          if (t.state === 'failed') await this.#stall(p, 'turn_failed');
          return;
        }
        const { items } = await this.#items(this.deps.pool, p.id);
        const decisions = await this.#decisions(p.id);
        const mark = progressMark(items, decisions.filter((d) => d.state === 'answered').length, p.version);
        if (mark === p.cont_mark && !p.cont_due) {
          await this.#stall(p, 'no_progress');
          return;
        }
        const open = new Set(
          decisions
            .filter((d) => d.state === 'pending' && d.itemKey !== null)
            .map((d) => d.itemKey as string),
        );
        if (!anythingUnderway(items) && readyItems(items, open).length > 0)
          await this.deps.pool.query(`UPDATE chat_plans SET cont_due = true WHERE id = $1`, [p.id]);
      }
      // Whatever ended the wait while this turn ran (a job finished, a decision answered) goes on now.
      void this.#continue(p.id);
    } catch (err) {
      this.deps.log.warn({ err, turnId: t.turnId }, 'plan turn end not handled');
    }
  }

  /** For the decision answer: is this question one of a plan? */
  async isDecision(threadId: string, questionId: string): Promise<boolean> {
    const q = this.deps.questions();
    if (q === null) return false;
    return (await q.planOf(threadId, questionId)) !== null;
  }
}

/**
 * p18-project-bootstrap: the continuation's readiness instruction (exported for tests) — look, ask with a plan decision
 * (recommended option first), never open the network or assign machines silently, apply the answer with the setup tools.
 */
export function planReadinessLine(project: string, gaps: readonly string[], tr: boolean): string {
  return tr
    ? `HAZIRLIK: ${project} projesi henüz hazır değil (eksik: ${gaps.join(', ')}). Bu maddeden önce describe_project_readiness ile bak ve somut kurulumu plan_ask_decision ile sor (önerilen seçenek önce: hangi alan adlarına ağ erişimi, hangi makineler). Ağ erişimini açmak ve makine atamak kullanıcının kararıdır — otonom planda da sessizce yapma; karar verildiyse draft_project_network / draft_project_machines ile uygula (ağı kapalı tutmak da bir karardır: mode none).`
    : `READINESS: project ${project} is not set up yet (missing: ${gaps.join(', ')}). Before this item, read describe_project_readiness and ask for the concrete setup with plan_ask_decision (recommended option first: which hosts to open, which machines). Opening network access and assigning machines are the user's decisions — never silent, also in an autonomous plan; once decided apply it with draft_project_network / draft_project_machines (keeping the network closed is a decision too: mode none).`;
}
