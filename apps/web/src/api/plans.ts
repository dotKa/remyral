import { apiRequest, obj, type RequestOptions, str } from './client';
import { parseQuestionSet, type QuestionSet } from './questions';

/**
 * p18-plan-mode (docs/design/p18-plan-mode.md §5): the plan of a Sohbet conversation — plan mode, the active plan, the
 * person's review (approve, request changes, decisions), execution controls and the item edits. Everything in a plan
 * is model / person text: rendered as text only. Parsing is defensive (an older master sends no plan at all).
 */

export type PlanState =
  'drafting' | 'in_review' | 'approved' | 'executing' | 'paused' | 'done' | 'cancelled' | 'superseded';
export type PlanItemStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped';
export type PlanOwner = 'assistant' | 'user' | 'job' | 'workflow';
export type PlanLinkKind =
  // p18-multi-project W5: `batch` — a job batch (one job per project).
  'draft' | 'job' | 'workflow_run' | 'workflow' | 'automation' | 'pr' | 'output' | 'url' | 'batch';

export interface PlanLink {
  readonly kind: PlanLinkKind;
  readonly id: string;
  readonly label: string | null;
}

export interface PlanItem {
  readonly key: string;
  readonly phase: number;
  readonly phaseTitle: string;
  readonly position: number;
  readonly title: string;
  readonly activeTitle: string | null;
  readonly detail: string | null;
  readonly status: PlanItemStatus;
  readonly owner: PlanOwner;
  readonly project: string | null;
  readonly dependsOn: readonly string[];
  readonly estimate: string | number | null;
  readonly links: readonly PlanLink[];
  readonly note: string | null;
  readonly statusBy: 'assistant' | 'user' | 'derived';
  readonly decisionOpen: boolean;
  /** p18-plan-autonomy: the item waits for the person's card ("Senden bekleniyor"). */
  readonly awaitsUser: boolean;
  /** p18-plan-autonomy: consecutive failed attempts (at 3 the platform stops retrying it). */
  readonly failures: number;
}

export interface PlanDecision {
  readonly id: string;
  readonly itemKey: string | null;
  readonly prompt: string;
  readonly kind: 'single' | 'multi' | 'text';
  readonly options: readonly { readonly label: string; readonly description: string | null }[];
  readonly recommended: string | null;
  readonly rationale: string | null;
  readonly state: 'pending' | 'answered' | 'expired' | 'cancelled';
  readonly answer: string | null;
}

export interface Plan {
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
  /** p18-plan-autonomy: approved to run on its own (continuation drafts run without a card). */
  readonly autonomous: boolean;
  readonly stalled: string | null;
  readonly updatedAt: string;
  readonly phases: readonly { readonly index: number; readonly title: string }[];
  readonly items: readonly PlanItem[];
  readonly decisions: readonly PlanDecision[];
  readonly progress: {
    readonly done: number;
    readonly total: number;
    readonly skipped: number;
    readonly remainingMinutes: number | null;
  };
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

/** The thread view's plan part: plan mode (since when; null: off) and the active plan. */
export interface ThreadPlan {
  readonly mode: string | null;
  readonly active: Plan | null;
}

const STATES = new Set<PlanState>([
  'drafting',
  'in_review',
  'approved',
  'executing',
  'paused',
  'done',
  'cancelled',
  'superseded',
]);
const STATUSES = new Set<PlanItemStatus>(['pending', 'in_progress', 'done', 'blocked', 'skipped']);
const OWNERS = new Set<PlanOwner>(['assistant', 'user', 'job', 'workflow']);
const LINKS = new Set<PlanLinkKind>([
  'draft',
  'job',
  'workflow_run',
  'workflow',
  'automation',
  'pr',
  'output',
  'url',
  'batch',
]);

const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const ns = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const n = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

function parseItem(v: unknown): PlanItem | null {
  const o = rec(v);
  const status = o.status as PlanItemStatus;
  const owner = o.owner as PlanOwner;
  if (typeof o.key !== 'string' || !STATUSES.has(status) || !OWNERS.has(owner)) return null;
  return {
    key: o.key,
    phase: n(o.phase),
    phaseTitle: s(o.phaseTitle),
    position: n(o.position),
    title: s(o.title, o.key),
    activeTitle: ns(o.activeTitle),
    detail: ns(o.detail),
    status,
    owner,
    project: ns(o.project),
    dependsOn: arr(o.dependsOn).filter((x): x is string => typeof x === 'string'),
    estimate: typeof o.estimate === 'string' || typeof o.estimate === 'number' ? o.estimate : null,
    links: arr(o.links).flatMap((l): PlanLink[] => {
      const x = rec(l);
      const kind = x.kind as PlanLinkKind;
      return LINKS.has(kind) && typeof x.id === 'string' ? [{ kind, id: x.id, label: ns(x.label) }] : [];
    }),
    note: ns(o.note),
    statusBy: o.statusBy === 'user' || o.statusBy === 'derived' ? o.statusBy : 'assistant',
    decisionOpen: o.decisionOpen === true,
    awaitsUser: o.awaitsUser === true,
    failures: n(o.failures),
  };
}

function parseDecision(v: unknown): PlanDecision | null {
  const o = rec(v);
  if (typeof o.id !== 'string') return null;
  const kind = o.kind === 'single' || o.kind === 'multi' ? o.kind : 'text';
  const state =
    o.state === 'answered' || o.state === 'expired' || o.state === 'cancelled' ? o.state : 'pending';
  return {
    id: o.id,
    itemKey: ns(o.itemKey),
    prompt: s(o.prompt),
    kind,
    options: arr(o.options).flatMap((x) => {
      const r = rec(x);
      return typeof r.label === 'string' ? [{ label: r.label, description: ns(r.description) }] : [];
    }),
    recommended: ns(o.recommended),
    rationale: ns(o.rationale),
    state,
    answer: ns(o.answer),
  };
}

/** A plan from the master (null when it is not one). */
export function parsePlan(v: unknown): Plan | null {
  const o = rec(v);
  const state = o.state as PlanState;
  if (typeof o.id !== 'string' || !STATES.has(state)) return null;
  const p = rec(o.progress);
  const lc = o.lastChange === null || o.lastChange === undefined ? null : rec(o.lastChange);
  const items = arr(o.items)
    .map(parseItem)
    .filter((i): i is PlanItem => i !== null)
    .sort((a, b) => a.phase - b.phase || a.position - b.position);
  return {
    id: o.id,
    threadId: s(o.threadId),
    title: s(o.title),
    goal: s(o.goal),
    assumptions: arr(o.assumptions).filter((x): x is string => typeof x === 'string'),
    risks: arr(o.risks).filter((x): x is string => typeof x === 'string'),
    state,
    version: n(o.version, 1),
    rev: n(o.rev, 0),
    approvedVersion: typeof o.approvedVersion === 'number' ? o.approvedVersion : null,
    autonomous: o.autonomous === true,
    stalled: ns(o.stalled),
    updatedAt: s(o.updatedAt),
    phases: arr(o.phases).flatMap((x) => {
      const r = rec(x);
      return typeof r.index === 'number' && typeof r.title === 'string'
        ? [{ index: r.index, title: r.title }]
        : [];
    }),
    items,
    decisions: arr(o.decisions)
      .map(parseDecision)
      .filter((d): d is PlanDecision => d !== null),
    progress: {
      done: n(p.done),
      total: n(p.total, items.length),
      skipped: n(p.skipped),
      remainingMinutes: typeof p.remainingMinutes === 'number' ? p.remainingMinutes : null,
    },
    lastChange:
      lc === null
        ? null
        : {
            version: n(lc.version, 1),
            author: lc.author === 'user' ? 'user' : 'assistant',
            reason: ns(lc.reason),
            added: n(lc.added),
            removed: n(lc.removed),
            changed: n(lc.changed),
            moved: n(lc.moved),
          },
  };
}

/** The `plan` of a thread detail (older masters: absent → null). */
export function parseThreadPlan(v: unknown): ThreadPlan | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  return { mode: ns(o.mode), active: o.active === null ? null : parsePlan(o.active) };
}

const P = (id: string): string => `/chat/plans/${encodeURIComponent(id)}`;

export function setPlanMode(threadId: string, on: boolean): Promise<string | null> {
  return apiRequest(
    'PUT',
    `/chat/threads/${encodeURIComponent(threadId)}/plan-mode`,
    (v) => ns(obj(v).mode),
    { body: { on } },
  );
}

const planOf = (v: unknown): Plan => {
  const p = parsePlan(v);
  if (p === null) throw new Error('not a plan');
  return p;
};

export function getPlan(id: string, opts: RequestOptions = {}): Promise<Plan> {
  return apiRequest('GET', P(id), planOf, opts);
}

/** "Onayla"; p18-plan-autonomy: `autonomous` ("Otonom yürüt", default on) lets the plan's steps run without a card. */
export function approvePlan(id: string, version: number, autonomous = true): Promise<Plan> {
  return apiRequest('POST', `${P(id)}/approve`, planOf, { body: { version, autonomous } });
}

/** p18-plan-autonomy: ⋯ "Otonom yürütmeyi kapat / aç". */
export function setPlanAutonomy(id: string, autonomous: boolean): Promise<Plan> {
  return apiRequest('POST', `${P(id)}/autonomy`, planOf, { body: { autonomous } });
}

export function requestPlanChanges(id: string, version: number, note: string): Promise<string> {
  return apiRequest('POST', `${P(id)}/request-changes`, (v) => str(obj(v), 'turnId'), {
    body: { version, note },
  });
}

export function planAction(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<Plan> {
  return apiRequest('POST', `${P(id)}/${action}`, planOf, { body: {} });
}

export type PlanEstimate = 'S' | 'M' | 'L' | number;

/** A place in the plan: the phase (0-based) and the item it comes after there (null: first). */
export interface PlanPlace {
  readonly phase: number;
  readonly after: string | null;
}

/** The person's edits (`PATCH /chat/plans/:pid/items`; the master's PlanUserOp). */
export type PlanUserOp =
  | {
      readonly op: 'skip' | 'unskip' | 'done_mine' | 'assign_me' | 'remove' | 'restore';
      readonly key: string;
    }
  | { readonly op: 'rename'; readonly key: string; readonly title: string }
  | { readonly op: 'detail'; readonly key: string; readonly detail: string | null }
  | ({ readonly op: 'move'; readonly key: string } & PlanPlace)
  | ({
      readonly op: 'add';
      readonly item: {
        readonly title: string;
        readonly owner?: PlanOwner;
        readonly estimate?: PlanEstimate;
        readonly detail?: string;
      };
      /** W4: a new phase — `phase` one past the last, with its title. */
      readonly phaseTitle?: string;
    } & PlanPlace)
  | { readonly op: 'set_owner'; readonly key: string; readonly owner: PlanOwner }
  | { readonly op: 'set_project'; readonly key: string; readonly project: string | null }
  | { readonly op: 'set_estimate'; readonly key: string; readonly estimate: PlanEstimate | null }
  /** W4: dependencies (≤ 5 items of the plan, no cycle — the master refuses 409 plan_invalid). */
  | { readonly op: 'set_depends'; readonly key: string; readonly dependsOn: readonly string[] };

export function editPlanItems(id: string, baseRev: number, ops: readonly PlanUserOp[]): Promise<Plan> {
  return apiRequest('PATCH', `${P(id)}/items`, planOf, { body: { baseRev, ops } });
}

/* ------------------------------------------------------------------ versions & history (W3) */

export interface PlanVersionMeta {
  readonly version: number;
  readonly author: 'assistant' | 'user';
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface PlanVersion extends PlanVersionMeta {
  readonly items: number;
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly moved: number;
}

/** An item's shape in a version (what a diff compares). */
export interface PlanItemShape {
  readonly key: string;
  readonly phase: number;
  readonly phaseTitle: string;
  readonly position: number;
  readonly title: string;
  readonly detail: string | null;
  readonly owner: PlanOwner;
  readonly project: string | null;
  readonly dependsOn: readonly string[];
  readonly estimate: string | number | null;
}

export interface PlanDiffItem {
  readonly key: string;
  readonly change: 'added' | 'removed' | 'changed' | 'moved';
  readonly fields: readonly string[];
  readonly moved: boolean;
  readonly before: PlanItemShape | null;
  readonly after: PlanItemShape | null;
}

export interface PlanVersionDiff {
  readonly from: PlanVersionMeta;
  readonly to: PlanVersionMeta;
  readonly goalChanged: boolean;
  readonly titleChanged: boolean;
  readonly items: readonly PlanDiffItem[];
  readonly decisions: readonly {
    readonly id: string;
    readonly itemKey: string | null;
    readonly prompt: string;
    readonly change: 'asked' | 'answered';
    readonly answer: string | null;
  }[];
}

/** An earlier plan of the conversation ("Önceki planlar", read only). */
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

function parseMeta(v: unknown): PlanVersionMeta {
  const o = rec(v);
  return {
    version: n(o.version, 1),
    author: o.author === 'user' ? 'user' : 'assistant',
    reason: ns(o.reason),
    createdAt: s(o.createdAt),
  };
}

function parseShape(v: unknown): PlanItemShape | null {
  const o = rec(v);
  if (typeof o.key !== 'string') return null;
  const owner = OWNERS.has(o.owner as PlanOwner) ? (o.owner as PlanOwner) : 'assistant';
  return {
    key: o.key,
    phase: n(o.phase),
    phaseTitle: s(o.phaseTitle),
    position: n(o.position),
    title: s(o.title, o.key),
    detail: ns(o.detail),
    owner,
    project: ns(o.project),
    dependsOn: arr(o.dependsOn).filter((x): x is string => typeof x === 'string'),
    estimate: typeof o.estimate === 'string' || typeof o.estimate === 'number' ? o.estimate : null,
  };
}

export function parseVersions(v: unknown): PlanVersion[] {
  return arr(rec(v).versions).map((x) => {
    const o = rec(x);
    return {
      ...parseMeta(o),
      items: n(o.items),
      added: n(o.added),
      removed: n(o.removed),
      changed: n(o.changed),
      moved: n(o.moved),
    };
  });
}

const CHANGES = new Set(['added', 'removed', 'changed', 'moved']);

export function parseVersionDiff(v: unknown): PlanVersionDiff {
  const o = rec(v);
  return {
    from: parseMeta(o.from),
    to: parseMeta(o.to),
    goalChanged: o.goalChanged === true,
    titleChanged: o.titleChanged === true,
    items: arr(o.items).flatMap((x): PlanDiffItem[] => {
      const r = rec(x);
      const change = r.change as PlanDiffItem['change'];
      if (typeof r.key !== 'string' || !CHANGES.has(change)) return [];
      return [
        {
          key: r.key,
          change,
          fields: arr(r.fields).filter((f): f is string => typeof f === 'string'),
          moved: r.moved === true,
          before: parseShape(r.before),
          after: parseShape(r.after),
        },
      ];
    }),
    decisions: arr(o.decisions).flatMap((x) => {
      const r = rec(x);
      if (typeof r.id !== 'string') return [];
      return [
        {
          id: r.id,
          itemKey: ns(r.itemKey),
          prompt: s(r.prompt),
          change: r.change === 'answered' ? ('answered' as const) : ('asked' as const),
          answer: ns(r.answer),
        },
      ];
    }),
  };
}

export function getPlanVersions(id: string, opts: RequestOptions = {}): Promise<PlanVersion[]> {
  return apiRequest('GET', `${P(id)}/versions`, parseVersions, opts);
}

export function getPlanDiff(
  id: string,
  from: number,
  to: number,
  opts: RequestOptions = {},
): Promise<PlanVersionDiff> {
  return apiRequest('GET', `${P(id)}/diff?from=${String(from)}&to=${String(to)}`, parseVersionDiff, opts);
}

/** The conversation's earlier plans (closed / superseded), newest first. */
export function getEarlierPlans(threadId: string, opts: RequestOptions = {}): Promise<PlanSummary[]> {
  return apiRequest(
    'GET',
    `/chat/threads/${encodeURIComponent(threadId)}/plans`,
    (v) =>
      arr(rec(v).history).flatMap((x): PlanSummary[] => {
        const o = rec(x);
        const state = o.state as PlanState;
        if (typeof o.id !== 'string' || !STATES.has(state)) return [];
        return [
          {
            id: o.id,
            title: s(o.title),
            state,
            version: n(o.version, 1),
            done: n(o.done),
            total: n(o.total),
            createdAt: s(o.createdAt),
            closedAt: ns(o.closedAt),
          },
        ];
      }),
    opts,
  );
}

/* ------------------------------------------------------------------ "Senden bekleyen" (W4) */

/** p18-plan-mode W4: a plan of the caller that waits for them (`GET /chat/plans/waiting`). */
export interface PlanNeed {
  readonly planId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly title: string;
  readonly state: PlanState;
  readonly rev: number;
  readonly stalled: string | null;
  /** The open decisions as question rows (answered with the question card through the chat answer route). */
  readonly questions: readonly QuestionSet[];
  readonly waiting: readonly {
    readonly key: string;
    readonly title: string;
    readonly why: 'card' | 'blocked' | 'mine';
    readonly note: string | null;
  }[];
  readonly updatedAt: string;
}

const WHY = new Set(['card', 'blocked', 'mine']);

export function parsePlanNeed(v: unknown): PlanNeed | null {
  const o = rec(v);
  const state = o.state as PlanState;
  if (typeof o.planId !== 'string' || typeof o.threadId !== 'string' || !STATES.has(state)) return null;
  return {
    planId: o.planId,
    threadId: o.threadId,
    threadTitle: s(o.threadTitle),
    title: s(o.title),
    state,
    rev: n(o.rev),
    stalled: ns(o.stalled),
    questions: arr(o.questions).flatMap((q) => {
      try {
        return [parseQuestionSet(q)];
      } catch {
        return [];
      }
    }),
    waiting: arr(o.waiting).flatMap((x) => {
      const w = rec(x);
      if (typeof w.key !== 'string' || typeof w.why !== 'string' || !WHY.has(w.why)) return [];
      return [{ key: w.key, title: s(w.title), why: w.why as 'card' | 'blocked' | 'mine', note: ns(w.note) }];
    }),
    updatedAt: s(o.updatedAt),
  };
}

export function getWaitingPlans(opts: RequestOptions = {}): Promise<PlanNeed[]> {
  return apiRequest(
    'GET',
    '/chat/plans/waiting',
    (v) =>
      arr(rec(v).items).flatMap((x) => {
        const p = parsePlanNeed(x);
        return p === null ? [] : [p];
      }),
    opts,
  );
}

/* ------------------------------------------------------------------ scheduled results (W4) */

/** "Bu sohbete sonuç gönderme": mute / unmute one automation's / workflow's scheduled results in a conversation. */
export function setResultMute(threadId: string, target: string, muted: boolean): Promise<boolean> {
  return apiRequest(
    'PUT',
    `/chat/threads/${encodeURIComponent(threadId)}/result-mutes`,
    (v) => rec(v).muted === true,
    { body: { target, muted } },
  );
}

/* ------------------------------------------------------------------ the plans list (p18-plans-ui) */

/** The "Planlar" screen's filters (the master's PLAN_LIST_FILTERS). */
export type PlanListFilter = 'active' | 'executing' | 'review' | 'paused' | 'done' | 'cancelled';
export type PlanListScope = 'mine' | 'shared' | 'all';

/** p18-plans-ui: one row of `GET /chat/plans`. */
export interface PlanListItem {
  readonly id: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly archived: boolean;
  readonly role: 'owner' | 'reader';
  readonly title: string;
  readonly state: PlanState;
  readonly autonomous: boolean;
  readonly stalled: string | null;
  readonly version: number;
  readonly progress: {
    readonly done: number;
    readonly total: number;
    readonly skipped: number;
    readonly remainingMinutes: number | null;
  };
  readonly openDecisions: number;
  readonly waiting: number;
  readonly needsYou: boolean;
  readonly projects: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

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
  readonly next: number | null;
  readonly counts: PlanListCounts;
}

export function parsePlanListItem(v: unknown): PlanListItem | null {
  const o = rec(v);
  const state = o.state as PlanState;
  if (typeof o.id !== 'string' || typeof o.threadId !== 'string' || !STATES.has(state)) return null;
  const pr = rec(o.progress);
  return {
    id: o.id,
    threadId: o.threadId,
    threadTitle: s(o.threadTitle),
    archived: o.archived === true,
    role: o.role === 'reader' ? 'reader' : 'owner',
    title: s(o.title),
    state,
    autonomous: o.autonomous === true,
    stalled: ns(o.stalled),
    version: n(o.version, 1),
    progress: {
      done: n(pr.done),
      total: n(pr.total),
      skipped: n(pr.skipped),
      remainingMinutes: typeof pr.remainingMinutes === 'number' ? pr.remainingMinutes : null,
    },
    openDecisions: n(o.openDecisions),
    waiting: n(o.waiting),
    needsYou: o.needsYou === true,
    projects: arr(o.projects).filter((x): x is string => typeof x === 'string'),
    createdAt: s(o.createdAt),
    updatedAt: s(o.updatedAt),
    closedAt: ns(o.closedAt),
  };
}

const COUNT_KEYS = [
  'total',
  'active',
  'executing',
  'review',
  'paused',
  'done',
  'cancelled',
  'needsYou',
] as const;

export function parsePlanListPage(v: unknown): PlanListPage {
  const o = rec(v);
  const c = rec(o.counts);
  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, n(c[k])])) as unknown as PlanListCounts;
  return {
    items: arr(o.items).flatMap((x) => {
      const p = parsePlanListItem(x);
      return p === null ? [] : [p];
    }),
    next: typeof o.next === 'number' ? o.next : null,
    counts,
  };
}

/** p18-plans-ui: the caller's plans across their conversations (`GET /chat/plans`). */
export function getPlanList(
  q: {
    readonly filter?: PlanListFilter | null;
    readonly scope?: PlanListScope;
    readonly project?: string;
    readonly q?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
  opts: RequestOptions = {},
): Promise<PlanListPage> {
  const p = new URLSearchParams();
  if (q.filter != null) p.set('filter', q.filter);
  if (q.scope !== undefined && q.scope !== 'mine') p.set('scope', q.scope);
  if (q.project !== undefined && q.project !== '') p.set('project', q.project);
  if (q.q !== undefined && q.q.trim() !== '') p.set('q', q.q.trim());
  if (q.limit !== undefined) p.set('limit', String(q.limit));
  if (q.offset !== undefined && q.offset > 0) p.set('offset', String(q.offset));
  const qs = p.toString();
  return apiRequest('GET', `/chat/plans${qs === '' ? '' : `?${qs}`}`, parsePlanListPage, opts);
}
