import { z } from 'zod';

/**
 * p18-plan-mode (docs/design/p18-plan-mode.md §2, §5): the plan of a Sohbet conversation — a goal, phases and items the
 * assistant writes in plan mode, the person reviews (edits, decisions, approval) and the platform follows while it is
 * executed. One schema for the tool inputs (the worker registers them, the master re-validates every call), the person's
 * edit operations (REST) and the limits the console shows. Browser-safe: zod only.
 *
 * Everything a plan carries comes from a model or a person: untrusted data. It is bounded here, stored as data and
 * rendered as plain text (never HTML, never Markdown).
 */

/** The worker feature: the plan tools and the planning rule of the system prompt are in this worker's assistant. */
export const ASSISTANT_PLAN_FEATURE = 'assistant-plan-v1';

export const PLAN_LIMITS = {
  title: 120,
  goal: 1000,
  /** Assumptions and risks: at most this many lines each, each line at most `listItem` characters. */
  listLines: 8,
  listItem: 300,
  phases: 8,
  phaseTitle: 80,
  itemsPerPhase: 20,
  items: 60,
  itemTitle: 140,
  detail: 1000,
  dependsOn: 5,
  /** An estimate in minutes (one week at most) or S / M / L. */
  estimateMinutes: 10_080,
  links: 8,
  linkLabel: 80,
  note: 300,
  reason: 300,
  /** "Değişiklik iste": the person's note to the assistant. */
  changeNote: 2000,
  /** Operations per assistant update / per edit of the person / items per status call. */
  updateOps: 40,
  userOps: 20,
  statusItems: 20,
  /** Open decisions per plan; a decision's prompt, options, labels, descriptions and rationale. */
  openDecisions: 6,
  decisionPrompt: 300,
  decisionOptionsMin: 2,
  decisionOptionsMax: 6,
  optionLabel: 60,
  optionDescription: 300,
  rationale: 500,
  /** Versions kept per plan, the size of one stored snapshot and of the per-turn plan block. */
  versionsKept: 50,
  snapshotBytes: 64 * 1024,
  blockBytes: 6 * 1024,
} as const;

/** C0 controls (newline / tab allowed where lines are), DEL, line / paragraph separators, bidi overrides / isolates. */
const hex4 = (n: number): string => n.toString(16).padStart(4, '0');
const charClass = (ranges: readonly (readonly [number, number])[]): RegExp =>
  new RegExp(`[${ranges.map(([a, b]) => `\\u${hex4(a)}-\\u${hex4(b)}`).join('')}]`, 'u');
const SEPARATORS: readonly (readonly [number, number])[] = [
  [0x7f, 0x7f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const LINE_CONTROL = charClass([[0x00, 0x1f], ...SEPARATORS]);
const BLOCK_CONTROL = charClass([[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], ...SEPARATORS]);

/** A bounded, non-empty text; `lines`: newlines allowed (details, goals). */
export function planText(max: number, opts: { lines?: boolean } = {}) {
  return z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0, { message: 'empty' })
    .refine((s) => !(opts.lines === true ? BLOCK_CONTROL : LINE_CONTROL).test(s), {
      message: 'control characters are not allowed',
    });
}

/** An item's stable key within its plan (lower-case letters, digits, dashes). */
export const PlanItemKey = z.string().regex(/^[a-z0-9-]{1,32}$/, 'item key');
export type PlanItemKey = z.infer<typeof PlanItemKey>;

export const PLAN_OWNERS = ['assistant', 'user', 'job', 'workflow'] as const;
export const PlanOwner = z.enum(PLAN_OWNERS);
export type PlanOwner = z.infer<typeof PlanOwner>;

export const PLAN_ITEM_STATUSES = ['pending', 'in_progress', 'done', 'blocked', 'skipped'] as const;
export const PlanItemStatus = z.enum(PLAN_ITEM_STATUSES);
export type PlanItemStatus = z.infer<typeof PlanItemStatus>;

export const PLAN_STATES = [
  'drafting',
  'in_review',
  'approved',
  'executing',
  'paused',
  'done',
  'cancelled',
  'superseded',
] as const;
export const PlanState = z.enum(PLAN_STATES);
export type PlanState = z.infer<typeof PlanState>;

/** The states of the one active plan of a conversation (the partial unique index). */
export const ACTIVE_PLAN_STATES: readonly PlanState[] = [
  'drafting',
  'in_review',
  'approved',
  'executing',
  'paused',
];

/** A project id as the rest of the protocol takes it. */
const Project = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'project id');

export const PlanEstimate = z.union([
  z.enum(['S', 'M', 'L']),
  z.number().int().min(1).max(PLAN_LIMITS.estimateMinutes),
]);
export type PlanEstimate = z.infer<typeof PlanEstimate>;

export const PLAN_LINK_KINDS = [
  'draft',
  'job',
  'workflow_run',
  'workflow',
  'automation',
  'pr',
  'output',
  'url',
  // p18-multi-project W5: a job batch (one job per project); its status follows the batch's jobs.
  'batch',
] as const;
export const PlanLinkKind = z.enum(PLAN_LINK_KINDS);
export type PlanLinkKind = z.infer<typeof PlanLinkKind>;

/** What an item points at: an id of the platform, or (kind url / pr) an https URL. */
export const PlanLink = z
  .strictObject({
    kind: PlanLinkKind,
    id: z.string().min(1).max(500),
    label: planText(PLAN_LIMITS.linkLabel).optional(),
  })
  .superRefine((l, ctx) => {
    if (l.kind === 'url' || l.kind === 'pr') {
      if (!/^https:\/\/[^\s]+$/.test(l.id))
        ctx.addIssue({ code: 'custom', path: ['id'], message: 'an https URL' });
      return;
    }
    if (!/^[A-Za-z0-9_.:/-]{1,200}$/.test(l.id))
      ctx.addIssue({ code: 'custom', path: ['id'], message: 'an id' });
  });
export type PlanLink = z.infer<typeof PlanLink>;

/** One item as the assistant writes it (plan_create, plan_update_items `add`). */
export const PlanItemInput = z.strictObject({
  key: PlanItemKey,
  /** Imperative ("Testleri düzelt"). */
  title: planText(PLAN_LIMITS.itemTitle),
  /** Shown while the item is in progress ("Testleri düzeltiyorum"). */
  activeTitle: planText(PLAN_LIMITS.itemTitle).optional(),
  detail: planText(PLAN_LIMITS.detail, { lines: true }).optional(),
  owner: PlanOwner,
  project: Project.optional(),
  dependsOn: z.array(PlanItemKey).max(PLAN_LIMITS.dependsOn).optional(),
  estimate: PlanEstimate.optional(),
});
export type PlanItemInput = z.infer<typeof PlanItemInput>;

export const PlanPhaseInput = z.strictObject({
  title: planText(PLAN_LIMITS.phaseTitle),
  items: z.array(PlanItemInput).min(1).max(PLAN_LIMITS.itemsPerPhase),
});
export type PlanPhaseInput = z.infer<typeof PlanPhaseInput>;

const PlanLines = z.array(planText(PLAN_LIMITS.listItem)).max(PLAN_LIMITS.listLines);

/** The raw shape of `plan_create` (the assistant tool catalog takes raw shapes). */
export const PLAN_CREATE_SHAPE = {
  title: planText(PLAN_LIMITS.title),
  /** Business language: what is reached when the plan is done. */
  goal: planText(PLAN_LIMITS.goal, { lines: true }),
  assumptions: PlanLines.optional(),
  risks: PlanLines.optional(),
  phases: z.array(PlanPhaseInput).min(1).max(PLAN_LIMITS.phases),
};

/** Keys unique across the plan, at most 60 items, dependencies only on other items of the plan, no cycle. */
export function planStructureIssues(
  phases: readonly { readonly items: readonly PlanItemInput[] }[],
): string[] {
  const issues: string[] = [];
  const items = phases.flatMap((p) => p.items);
  if (items.length > PLAN_LIMITS.items) issues.push(`at most ${String(PLAN_LIMITS.items)} items`);
  const keys = new Set<string>();
  for (const i of items) {
    if (keys.has(i.key)) issues.push(`duplicate item key ${i.key}`);
    keys.add(i.key);
  }
  for (const i of items) {
    for (const d of i.dependsOn ?? []) {
      if (d === i.key) issues.push(`${i.key} depends on itself`);
      else if (!keys.has(d)) issues.push(`${i.key} depends on unknown item ${d}`);
    }
  }
  if (dependencyCycle(items) !== null) issues.push('the dependencies form a cycle');
  return issues;
}

/** The first dependency cycle among `items` (keys in order), or null. */
export function dependencyCycle(
  items: readonly { readonly key: string; readonly dependsOn?: readonly string[] | undefined }[],
): string[] | null {
  const deps = new Map(items.map((i) => [i.key, i.dependsOn ?? []] as const));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (k: string): string[] | null => {
    const s = state.get(k);
    if (s === 'done') return null;
    if (s === 'visiting') return [...path.slice(path.indexOf(k)), k];
    state.set(k, 'visiting');
    path.push(k);
    for (const d of deps.get(k) ?? []) {
      if (!deps.has(d)) continue;
      const c = visit(d);
      if (c !== null) return c;
    }
    path.pop();
    state.set(k, 'done');
    return null;
  };
  for (const k of deps.keys()) {
    const c = visit(k);
    if (c !== null) return c;
  }
  return null;
}

export const PlanCreateInput = z.strictObject(PLAN_CREATE_SHAPE).superRefine((p, ctx) => {
  for (const issue of planStructureIssues(p.phases))
    ctx.addIssue({ code: 'custom', path: ['phases'], message: issue });
});
export type PlanCreateInput = z.infer<typeof PlanCreateInput>;

/** A place in the plan: a phase (0-based; one past the last opens a new phase with `phaseTitle`) and after which item. */
const Place = {
  phase: z
    .number()
    .int()
    .min(0)
    .max(PLAN_LIMITS.phases - 1),
  /** The new phase's title (only when `phase` is one past the last phase). */
  phaseTitle: planText(PLAN_LIMITS.phaseTitle).optional(),
  /** The item it comes after in that phase (null / absent: first). */
  after: PlanItemKey.nullable().optional(),
};

/** `plan_update_items` operations (structural: each update makes a new version). */
export const PlanUpdateOp = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), item: PlanItemInput, ...Place }),
  z.strictObject({
    op: z.literal('rename'),
    key: PlanItemKey,
    title: planText(PLAN_LIMITS.itemTitle),
    activeTitle: planText(PLAN_LIMITS.itemTitle).nullable().optional(),
  }),
  z.strictObject({
    op: z.literal('detail'),
    key: PlanItemKey,
    detail: planText(PLAN_LIMITS.detail, { lines: true }).nullable(),
  }),
  z.strictObject({ op: z.literal('move'), key: PlanItemKey, ...Place }),
  z.strictObject({ op: z.literal('remove'), key: PlanItemKey }),
  z.strictObject({ op: z.literal('set_owner'), key: PlanItemKey, owner: PlanOwner }),
  z.strictObject({ op: z.literal('set_project'), key: PlanItemKey, project: Project.nullable() }),
  z.strictObject({
    op: z.literal('set_depends'),
    key: PlanItemKey,
    dependsOn: z.array(PlanItemKey).max(PLAN_LIMITS.dependsOn),
  }),
]);
export type PlanUpdateOp = z.infer<typeof PlanUpdateOp>;

/**
 * The person's edits (`PATCH /chat/plans/:pid/items`). Structural ones make a user version (no re-approval; the
 * assistant gets them as a diff in its next turn); skip / unskip / done_mine do not.
 */
export const PlanUserOp = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('add'),
    item: z.strictObject({
      key: PlanItemKey.optional(),
      title: planText(PLAN_LIMITS.itemTitle),
      detail: planText(PLAN_LIMITS.detail, { lines: true }).optional(),
      owner: PlanOwner.optional(),
      estimate: PlanEstimate.optional(),
    }),
    ...Place,
  }),
  z.strictObject({ op: z.literal('rename'), key: PlanItemKey, title: planText(PLAN_LIMITS.itemTitle) }),
  z.strictObject({
    op: z.literal('detail'),
    key: PlanItemKey,
    detail: planText(PLAN_LIMITS.detail, { lines: true }).nullable(),
  }),
  z.strictObject({ op: z.literal('move'), key: PlanItemKey, ...Place }),
  z.strictObject({ op: z.literal('remove'), key: PlanItemKey }),
  z.strictObject({ op: z.literal('skip'), key: PlanItemKey }),
  z.strictObject({ op: z.literal('unskip'), key: PlanItemKey }),
  z.strictObject({ op: z.literal('assign_me'), key: PlanItemKey }),
  z.strictObject({ op: z.literal('done_mine'), key: PlanItemKey }),
  // p18-plan-mode W3: the item editor (owner / project / estimate) and the undo of a removal (the item comes back
  // where it was: its phase by title, its place clamped; a vanished phase is opened again).
  z.strictObject({ op: z.literal('set_owner'), key: PlanItemKey, owner: PlanOwner }),
  z.strictObject({ op: z.literal('set_project'), key: PlanItemKey, project: Project.nullable() }),
  z.strictObject({ op: z.literal('set_estimate'), key: PlanItemKey, estimate: PlanEstimate.nullable() }),
  z.strictObject({ op: z.literal('restore'), key: PlanItemKey }),
  // p18-plan-mode W4: the person edits an item's dependencies too (≤ 5, items of the plan, no cycle — refused 409
  // plan_invalid otherwise).
  z.strictObject({
    op: z.literal('set_depends'),
    key: PlanItemKey,
    dependsOn: z.array(PlanItemKey).max(PLAN_LIMITS.dependsOn),
  }),
]);
export type PlanUserOp = z.infer<typeof PlanUserOp>;

export const PlanUserEdit = z.strictObject({
  baseRev: z.number().int().min(0),
  ops: z.array(PlanUserOp).min(1).max(PLAN_LIMITS.userOps),
});
export type PlanUserEdit = z.infer<typeof PlanUserEdit>;

/** `plan_set_status` per item. */
export const PlanStatusChange = z.strictObject({
  key: PlanItemKey,
  status: PlanItemStatus,
  note: planText(PLAN_LIMITS.note).optional(),
  link: PlanLink.optional(),
});
export type PlanStatusChange = z.infer<typeof PlanStatusChange>;

/** A plan decision's option (a smaller bound than ask_user's: decisions are read in a side panel). */
export const PlanDecisionOption = z.strictObject({
  label: planText(PLAN_LIMITS.optionLabel),
  description: planText(PLAN_LIMITS.optionDescription).optional(),
});

/** `plan_set_state` targets (the assistant pauses, finishes or gives up a plan). */
export const PlanSetStateTarget = z.enum(['paused', 'done', 'cancelled']);
