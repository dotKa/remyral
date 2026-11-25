import {
  ASSISTANT_TOOLS,
  type AssistantToolName,
  dependencyCycle,
  fenceData,
  PLAN_LIMITS,
  type PlanEstimate,
  type PlanItemInput,
  type PlanItemStatus,
  type PlanLink,
  type PlanOwner,
  type PlanState,
  type PlanUpdateOp,
  type PlanUserOp,
} from '@remyral/protocol';

/**
 * p18-plan-mode (docs/design/p18-plan-mode.md): the pure rules of a conversation's plan — items and phases, the
 * operations of the assistant and of the person, versions and their diff, status transitions, the status an item takes
 * from what it is linked to, readiness, progress, the plan-mode tool matrix and the compact per-turn block. No I/O
 * (unit tested); `plans.ts` stores and serves it.
 */

export type StatusBy = 'assistant' | 'user' | 'derived';

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
  readonly estimate: PlanEstimate | null;
  readonly links: readonly PlanLink[];
  readonly note: string | null;
  readonly statusBy: StatusBy;
}

/** The structural part of an item (what a version records and a diff compares). */
export interface ItemShape {
  readonly key: string;
  readonly phase: number;
  readonly phaseTitle: string;
  readonly position: number;
  readonly title: string;
  readonly activeTitle: string | null;
  readonly detail: string | null;
  readonly owner: PlanOwner;
  readonly project: string | null;
  readonly dependsOn: readonly string[];
  readonly estimate: PlanEstimate | null;
}

export interface PlanSnapshot {
  readonly title: string;
  readonly goal: string;
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
  readonly items: readonly ItemShape[];
}

export const STRUCTURAL_FIELDS = [
  'title',
  'activeTitle',
  'detail',
  'owner',
  'project',
  'dependsOn',
  'estimate',
] as const satisfies readonly (keyof ItemShape)[];

export function shapeOf(i: PlanItem | ItemShape): ItemShape {
  return {
    key: i.key,
    phase: i.phase,
    phaseTitle: i.phaseTitle,
    position: i.position,
    title: i.title,
    activeTitle: i.activeTitle,
    detail: i.detail,
    owner: i.owner,
    project: i.project,
    dependsOn: [...i.dependsOn],
    estimate: i.estimate,
  };
}

/** Items in plan order: phase, then position. */
export function ordered<T extends { readonly phase: number; readonly position: number }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => a.phase - b.phase || a.position - b.position);
}

/** The items `plan_create` describes, numbered (phase index, position within it). */
export function itemsFromCreate(
  phases: readonly { readonly title: string; readonly items: readonly PlanItemInput[] }[],
): PlanItem[] {
  return phases.flatMap((p, phase) => p.items.map((i, position) => newItem(i, phase, p.title, position)));
}

function newItem(i: PlanItemInput, phase: number, phaseTitle: string, position: number): PlanItem {
  return {
    key: i.key,
    phase,
    phaseTitle,
    position,
    title: i.title,
    activeTitle: i.activeTitle ?? null,
    detail: i.detail ?? null,
    status: 'pending',
    owner: i.owner,
    project: i.project ?? null,
    dependsOn: [...new Set(i.dependsOn ?? [])],
    estimate: i.estimate ?? null,
    links: [],
    note: null,
    statusBy: 'assistant',
  };
}

// ------------------------------------------------------------------------------------------------ operations

export class PlanOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Phase {
  title: string;
  items: PlanItem[];
}

function toPhases(items: readonly PlanItem[]): Phase[] {
  const out: Phase[] = [];
  for (const i of ordered(items)) {
    let p = out[out.length - 1];
    if (p === undefined || out.length - 1 !== i.phase) {
      while (out.length <= i.phase) out.push({ title: i.phaseTitle, items: [] });
      p = out[i.phase];
    }
    if (p === undefined) continue;
    p.items.push(i);
  }
  return out.filter((p) => p.items.length > 0);
}

function fromPhases(phases: readonly Phase[]): PlanItem[] {
  return phases
    .filter((p) => p.items.length > 0)
    .flatMap((p, phase) => p.items.map((i, position) => ({ ...i, phase, phaseTitle: p.title, position })));
}

function find(phases: Phase[], key: string): { phase: Phase; index: number; item: PlanItem } {
  for (const phase of phases) {
    const index = phase.items.findIndex((i) => i.key === key);
    const item = phase.items[index];
    if (item !== undefined) return { phase, index, item };
  }
  throw new PlanOpError('plan_item_not_found', `No item ${key} in the plan.`);
}

function place(
  phases: Phase[],
  item: PlanItem,
  at: {
    readonly phase: number;
    readonly phaseTitle?: string | undefined;
    readonly after?: string | null | undefined;
  },
): void {
  let target = phases[at.phase];
  if (target === undefined) {
    if (at.phase !== phases.length)
      throw new PlanOpError(
        'plan_invalid',
        `Phase ${String(at.phase)} does not exist (next new phase: ${String(phases.length)}).`,
      );
    if (at.phaseTitle === undefined) throw new PlanOpError('plan_invalid', 'A new phase needs phaseTitle.');
    if (phases.length >= PLAN_LIMITS.phases)
      throw new PlanOpError('plan_invalid', `At most ${String(PLAN_LIMITS.phases)} phases.`);
    target = { title: at.phaseTitle, items: [] };
    phases.push(target);
  }
  const after = at.after ?? null;
  if (after === null) {
    target.items.unshift(item);
    return;
  }
  const idx = target.items.findIndex((i) => i.key === after);
  if (idx < 0) throw new PlanOpError('plan_invalid', `Item ${after} is not in that phase.`);
  target.items.splice(idx + 1, 0, item);
}

function editable(item: PlanItem): void {
  if (item.status === 'done')
    throw new PlanOpError('plan_item_done', `Item ${item.key} is done and cannot be changed.`);
}

function finalCheck(items: readonly PlanItem[]): void {
  if (items.length === 0) throw new PlanOpError('plan_invalid', 'A plan needs at least one item.');
  if (items.length > PLAN_LIMITS.items)
    throw new PlanOpError('plan_invalid', `At most ${String(PLAN_LIMITS.items)} items.`);
  const phases = new Set(items.map((i) => i.phase));
  if (phases.size > PLAN_LIMITS.phases)
    throw new PlanOpError('plan_invalid', `At most ${String(PLAN_LIMITS.phases)} phases.`);
  for (const p of phases) {
    if (items.filter((i) => i.phase === p).length > PLAN_LIMITS.itemsPerPhase)
      throw new PlanOpError('plan_invalid', `At most ${String(PLAN_LIMITS.itemsPerPhase)} items per phase.`);
  }
  const keys = new Set(items.map((i) => i.key));
  for (const i of items) {
    for (const d of i.dependsOn) {
      if (d === i.key) throw new PlanOpError('plan_invalid', `${i.key} depends on itself.`);
      if (!keys.has(d))
        throw new PlanOpError('plan_invalid', `${i.key} depends on ${d}, which is not in the plan.`);
    }
  }
  const cycle = dependencyCycle(items);
  if (cycle !== null)
    throw new PlanOpError('plan_invalid', `The dependencies form a cycle: ${cycle.join(' → ')}.`);
}

/**
 * The assistant's structural operations (`plan_update_items`), in order, on the current items. `usedKeys`: every key
 * the plan ever had (a removed item's key is not reused). Returns the new items and the keys removed.
 */
export function applyUpdateOps(
  items: readonly PlanItem[],
  ops: readonly PlanUpdateOp[],
  usedKeys: ReadonlySet<string>,
): { items: PlanItem[]; removed: string[] } {
  const phases = toPhases(items);
  const removed: string[] = [];
  const taken = new Set(usedKeys);
  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        if (taken.has(op.item.key))
          throw new PlanOpError('plan_invalid', `Key ${op.item.key} is already used in this plan.`);
        taken.add(op.item.key);
        place(phases, newItem(op.item, 0, '', 0), op);
        break;
      }
      case 'rename': {
        const f = find(phases, op.key);
        editable(f.item);
        f.phase.items[f.index] = {
          ...f.item,
          title: op.title,
          ...(op.activeTitle === undefined ? {} : { activeTitle: op.activeTitle }),
        };
        break;
      }
      case 'detail': {
        const f = find(phases, op.key);
        editable(f.item);
        f.phase.items[f.index] = { ...f.item, detail: op.detail };
        break;
      }
      case 'move': {
        const f = find(phases, op.key);
        editable(f.item);
        f.phase.items.splice(f.index, 1);
        if (op.after === op.key) throw new PlanOpError('plan_invalid', 'An item cannot follow itself.');
        place(phases, f.item, op);
        break;
      }
      case 'remove': {
        const f = find(phases, op.key);
        editable(f.item);
        f.phase.items.splice(f.index, 1);
        removed.push(op.key);
        for (const p of phases)
          p.items = p.items.map((i) =>
            i.dependsOn.includes(op.key) ? { ...i, dependsOn: i.dependsOn.filter((d) => d !== op.key) } : i,
          );
        break;
      }
      case 'set_owner': {
        const f = find(phases, op.key);
        editable(f.item);
        f.phase.items[f.index] = { ...f.item, owner: op.owner };
        break;
      }
      case 'set_project': {
        const f = find(phases, op.key);
        editable(f.item);
        f.phase.items[f.index] = { ...f.item, project: op.project };
        break;
      }
      case 'set_depends': {
        const f = find(phases, op.key);
        editable(f.item);
        f.phase.items[f.index] = { ...f.item, dependsOn: [...new Set(op.dependsOn)] };
        break;
      }
    }
  }
  const out = fromPhases(phases);
  finalCheck(out);
  return { items: out, removed };
}

/** A key for an item the person adds without one (`u1`, `u2` … not used before). */
export function freeKey(used: ReadonlySet<string>, base = 'u'): string {
  for (let n = 1; ; n++) {
    const k = `${base}${String(n)}`;
    if (!used.has(k)) return k;
  }
}

/**
 * Where a removed item comes back (the undo of a removal): the phase with its title (at its old place, clamped), else
 * its phase opened again at its old index (the phase vanished with its last item), else the end of the last phase.
 */
function restorePlace(phases: Phase[], item: PlanItem): void {
  const same = phases.find((p) => p.title === item.phaseTitle);
  if (same !== undefined) {
    same.items.splice(Math.min(Math.max(0, item.position), same.items.length), 0, item);
    return;
  }
  if (phases.length < PLAN_LIMITS.phases) {
    phases.splice(Math.min(Math.max(0, item.phase), phases.length), 0, {
      title: item.phaseTitle,
      items: [item],
    });
    return;
  }
  const last = phases[phases.length - 1];
  if (last === undefined) phases.push({ title: item.phaseTitle, items: [item] });
  else last.items.push(item);
}

/**
 * The person's operations (`PATCH /chat/plans/:pid/items`). `structural`: something a version records changed (add,
 * rename, detail, move, remove, restore, assign_me / set_owner, set_project, set_estimate, set_depends). skip / unskip / done_mine
 * change only status. `deleted`: the plan's removed items by key (`restore` brings one back, status and links kept).
 */
export function applyUserOps(
  items: readonly PlanItem[],
  ops: readonly PlanUserOp[],
  usedKeys: ReadonlySet<string>,
  deleted: ReadonlyMap<string, PlanItem> = new Map(),
): { items: PlanItem[]; removed: string[]; structural: boolean; doneMine: string[] } {
  const phases = toPhases(items);
  const removed: string[] = [];
  const doneMine: string[] = [];
  const taken = new Set(usedKeys);
  let structural = false;
  const set = (key: string, fn: (i: PlanItem) => PlanItem): void => {
    const f = find(phases, key);
    f.phase.items[f.index] = fn(f.item);
  };
  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        const key = op.item.key ?? freeKey(taken);
        if (taken.has(key)) throw new PlanOpError('plan_invalid', `Key ${key} is already used in this plan.`);
        taken.add(key);
        place(
          phases,
          {
            ...newItem(
              {
                key,
                title: op.item.title,
                owner: op.item.owner ?? 'user',
                ...(op.item.estimate === undefined ? {} : { estimate: op.item.estimate }),
              },
              0,
              '',
              0,
            ),
            detail: op.item.detail ?? null,
            statusBy: 'user',
          },
          op,
        );
        structural = true;
        break;
      }
      case 'rename':
        editable(find(phases, op.key).item);
        set(op.key, (i) => ({ ...i, title: op.title }));
        structural = true;
        break;
      case 'detail':
        editable(find(phases, op.key).item);
        set(op.key, (i) => ({ ...i, detail: op.detail }));
        structural = true;
        break;
      case 'move': {
        const f = find(phases, op.key);
        editable(f.item);
        f.phase.items.splice(f.index, 1);
        place(phases, f.item, op);
        structural = true;
        break;
      }
      case 'remove': {
        const f = find(phases, op.key);
        editable(f.item);
        f.phase.items.splice(f.index, 1);
        removed.push(op.key);
        for (const p of phases)
          p.items = p.items.map((i) =>
            i.dependsOn.includes(op.key) ? { ...i, dependsOn: i.dependsOn.filter((d) => d !== op.key) } : i,
          );
        structural = true;
        break;
      }
      case 'skip': {
        const f = find(phases, op.key);
        editable(f.item);
        if (f.item.status === 'in_progress' && f.item.statusBy === 'derived')
          throw new PlanOpError('plan_item_running', `Item ${op.key} follows a running job or run.`);
        set(op.key, (i) => ({ ...i, status: 'skipped', statusBy: 'user' }));
        break;
      }
      case 'unskip': {
        const f = find(phases, op.key);
        if (f.item.status !== 'skipped')
          throw new PlanOpError('plan_invalid', `Item ${op.key} is not skipped.`);
        set(op.key, (i) => ({ ...i, status: 'pending', statusBy: 'user' }));
        break;
      }
      case 'assign_me': {
        editable(find(phases, op.key).item);
        set(op.key, (i) => ({ ...i, owner: 'user' }));
        structural = true;
        break;
      }
      case 'done_mine': {
        const f = find(phases, op.key);
        if (f.item.owner !== 'user')
          throw new PlanOpError('plan_not_mine', `Item ${op.key} is not yours (owner ${f.item.owner}).`);
        if (f.item.status === 'done') break;
        set(op.key, (i) => ({ ...i, status: 'done', statusBy: 'user', note: null }));
        doneMine.push(op.key);
        break;
      }
      case 'set_owner':
        editable(find(phases, op.key).item);
        set(op.key, (i) => ({ ...i, owner: op.owner }));
        structural = true;
        break;
      case 'set_project':
        editable(find(phases, op.key).item);
        set(op.key, (i) => ({ ...i, project: op.project }));
        structural = true;
        break;
      case 'set_estimate':
        editable(find(phases, op.key).item);
        set(op.key, (i) => ({ ...i, estimate: op.estimate }));
        structural = true;
        break;
      // W4: dependencies from the item editor (finalCheck refuses unknown keys, self and cycles).
      case 'set_depends':
        editable(find(phases, op.key).item);
        set(op.key, (i) => ({ ...i, dependsOn: [...new Set(op.dependsOn)] }));
        structural = true;
        break;
      case 'restore': {
        if (phases.some((p) => p.items.some((i) => i.key === op.key)))
          throw new PlanOpError('plan_invalid', `Item ${op.key} is in the plan already.`);
        const gone = deleted.get(op.key);
        if (gone === undefined) throw new PlanOpError('plan_item_not_found', `No removed item ${op.key}.`);
        const back = removed.indexOf(op.key);
        if (back >= 0) removed.splice(back, 1);
        // Dependencies on items that left meanwhile are dropped (finalCheck refuses unknown keys).
        const present = new Set(phases.flatMap((p) => p.items.map((i) => i.key)));
        restorePlace(phases, { ...gone, dependsOn: gone.dependsOn.filter((d) => present.has(d)) });
        structural = true;
        break;
      }
    }
  }
  const out = fromPhases(phases);
  finalCheck(out);
  return { items: out, removed, structural, doneMine };
}

// ------------------------------------------------------------------------------------------------ versions & diff

export interface PlanDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly { readonly key: string; readonly fields: readonly string[] }[];
  readonly moved: readonly string[];
  readonly goalChanged: boolean;
  readonly titleChanged: boolean;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Per item key: added / removed / changed fields / moved (phase or position among the kept items). */
export function diffSnapshots(from: PlanSnapshot, to: PlanSnapshot): PlanDiff {
  const a = new Map(from.items.map((i) => [i.key, i] as const));
  const b = new Map(to.items.map((i) => [i.key, i] as const));
  const added = to.items.filter((i) => !a.has(i.key)).map((i) => i.key);
  const removed = from.items.filter((i) => !b.has(i.key)).map((i) => i.key);
  const changed: { key: string; fields: string[] }[] = [];
  for (const i of to.items) {
    const old = a.get(i.key);
    if (old === undefined) continue;
    const fields = STRUCTURAL_FIELDS.filter((f) => !same(old[f], i[f]));
    if (fields.length > 0) changed.push({ key: i.key, fields });
  }
  // Moved: another phase, or another place among the items both versions have (insertions / removals do not count).
  const keptOrder = (s: PlanSnapshot): string[] =>
    ordered(s.items)
      .filter((i) => a.has(i.key) && b.has(i.key))
      .map((i) => i.key);
  const oldOrder = keptOrder(from);
  const newOrder = keptOrder(to);
  const common = lcs(oldOrder, newOrder);
  const moved = newOrder.filter((k) => {
    const o = a.get(k);
    const n = b.get(k);
    if (o === undefined || n === undefined) return false;
    return o.phaseTitle !== n.phaseTitle || !common.has(k);
  });
  return {
    added,
    removed,
    changed,
    moved,
    goalChanged: from.goal !== to.goal,
    titleChanged: from.title !== to.title,
  };
}

/** The keys of a longest common subsequence of two orders (a key outside it moved). */
function lcs(a: readonly string[], b: readonly string[]): Set<string> {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      (dp[i] as number[])[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((dp[i + 1] as number[])[j] as number, (dp[i] as number[])[j + 1] as number);
  const out = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.add(a[i] as string);
      i++;
      j++;
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number)) i++;
    else j++;
  }
  return out;
}

/** One item of a version diff as the console and the assistant read it: its key and both sides' visible shape. */
export interface DiffItem {
  readonly key: string;
  readonly change: 'added' | 'removed' | 'changed' | 'moved';
  /** For changed: the structural fields that differ. */
  readonly fields: readonly string[];
  /** It also moved (a changed item can move too). */
  readonly moved: boolean;
  readonly before: ItemShape | null;
  readonly after: ItemShape | null;
}

/** The diff's items in reading order (the newer version's order; removed ones where they stood in the older one). */
export function diffItems(
  from: PlanSnapshot,
  to: PlanSnapshot,
  d: PlanDiff = diffSnapshots(from, to),
): DiffItem[] {
  const a = new Map(from.items.map((i) => [i.key, i] as const));
  const b = new Map(to.items.map((i) => [i.key, i] as const));
  const changed = new Map(d.changed.map((c) => [c.key, c.fields] as const));
  const moved = new Set(d.moved);
  const out: DiffItem[] = [];
  for (const i of ordered(to.items)) {
    const old = a.get(i.key) ?? null;
    const fields = changed.get(i.key) ?? [];
    const change = old === null ? 'added' : fields.length > 0 ? 'changed' : moved.has(i.key) ? 'moved' : null;
    if (change !== null)
      out.push({ key: i.key, change, fields, moved: moved.has(i.key), before: old, after: i });
  }
  for (const i of ordered(from.items)) {
    if (b.has(i.key)) continue;
    out.push({ key: i.key, change: 'removed', fields: [], moved: false, before: i, after: null });
  }
  return out;
}

/**
 * The person's edits since the assistant's own last version, for the "aktif plan" block: what was added, removed,
 * changed (with the fields) and moved, each with its title (a removed item is no longer in the plan the block shows).
 */
export interface UserEditView {
  readonly sinceVersion: number;
  readonly version: number;
  readonly added: readonly { readonly key: string; readonly title: string; readonly phase: string }[];
  readonly removed: readonly { readonly key: string; readonly title: string }[];
  readonly changed: readonly {
    readonly key: string;
    readonly title: string;
    readonly fields: readonly string[];
    readonly before: Readonly<Record<string, unknown>>;
  }[];
  readonly moved: readonly { readonly key: string; readonly title: string; readonly phase: string }[];
}

export function userEditView(
  base: { readonly version: number; readonly snapshot: PlanSnapshot },
  latest: { readonly version: number; readonly snapshot: PlanSnapshot },
): UserEditView | null {
  const d = diffSnapshots(base.snapshot, latest.snapshot);
  if (d.added.length + d.removed.length + d.changed.length + d.moved.length === 0) return null;
  const items = diffItems(base.snapshot, latest.snapshot, d);
  const after = (x: DiffItem): ItemShape => x.after ?? (x.before as ItemShape);
  return {
    sinceVersion: base.version,
    version: latest.version,
    added: items
      .filter((x) => x.change === 'added')
      .map((x) => ({ key: x.key, title: after(x).title, phase: after(x).phaseTitle })),
    removed: items
      .filter((x) => x.change === 'removed')
      .map((x) => ({ key: x.key, title: x.before?.title ?? x.key })),
    changed: items
      .filter((x) => x.change === 'changed')
      .map((x) => ({
        key: x.key,
        title: after(x).title,
        fields: x.fields,
        before: Object.fromEntries(
          x.fields.map((f) => [f, x.before === null ? null : x.before[f as keyof ItemShape]]),
        ),
      })),
    // A changed item that also moved is listed under moved too.
    moved: d.moved.map((k) => {
      const i = latest.snapshot.items.find((x) => x.key === k);
      return { key: k, title: i?.title ?? k, phase: i?.phaseTitle ?? '' };
    }),
  };
}

export function diffCounts(d: PlanDiff): { added: number; removed: number; changed: number; moved: number } {
  return {
    added: d.added.length,
    removed: d.removed.length,
    changed: d.changed.length,
    moved: d.moved.length,
  };
}

// ------------------------------------------------------------------------------------------------ status

/** The job / run states an item follows, as one word. */
export type TargetState = 'waiting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'dismissed';

export interface LinkFacts {
  /** Per draft id: proposed → waiting, confirmed (with its result's job / run id), dismissed / expired / failed. */
  readonly drafts: ReadonlyMap<
    string,
    {
      readonly state: string;
      readonly jobId: string | null;
      readonly runId: string | null;
      /** W4: an automation card's automation (it is followed like a job once confirmed). */
      readonly automationId?: string | null;
      /** p18-multi-project W5: a job batch card's batch (followed like a job once confirmed). */
      readonly batchId?: string | null;
    }
  >;
  /**
   * p18-multi-project W5: job batches by id — running while a created job runs, done when every created job succeeded,
   * failed when one failed / was cancelled (the note names how many), refused when no job was created.
   */
  readonly batches?: ReadonlyMap<
    string,
    { readonly state: 'running' | 'done' | 'failed' | 'refused'; readonly note: string | null }
  >;
  readonly jobs: ReadonlyMap<string, { readonly state: string; readonly summary: string | null }>;
  readonly runs: ReadonlyMap<string, { readonly state: string; readonly reason: string | null }>;
  /** W4: pull requests by URL (the platform's own: a job's PR or an integration's) — open, merged or closed. */
  readonly prs?: ReadonlyMap<
    string,
    { readonly state: 'open' | 'merged' | 'closed'; readonly reason: string | null }
  >;
  /**
   * W4: automations by id — their state, whether a run succeeded, and the newest finished run's state / reason (a
   * failure before any success blocks the item: "the first run failed").
   */
  readonly automations?: ReadonlyMap<
    string,
    {
      readonly state: string;
      readonly succeeded: boolean;
      readonly lastState: string | null;
      readonly lastReason: string | null;
    }
  >;
}

/** W4: the job an `output` link points at (`<job id>`, `job:<job id>…` or `/jobs/<job id>/…`), or null. */
export function outputJob(id: string): string | null {
  const m = /(?:^|job:|\/jobs\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(id);
  return m?.[1]?.toLowerCase() ?? null;
}

/** W4: link kinds an item's status follows (the newest one whose state is known wins). */
const FOLLOWED: ReadonlySet<string> = new Set(['job', 'workflow_run', 'pr', 'automation', 'output', 'batch']);

function jobTarget(state: string): TargetState {
  if (state === 'SUCCEEDED') return 'succeeded';
  if (state === 'CANCELLED') return 'cancelled';
  if (state === 'FAILED' || state === 'LOST') return 'failed';
  return 'running';
}

function runTarget(state: string): TargetState {
  if (state === 'succeeded') return 'succeeded';
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  return 'running';
}

export interface Derived {
  readonly status: PlanItemStatus;
  /** For blocked: a short reason (the job's summary, the run's reason, "dismissed"). */
  readonly note: string | null;
  /** Links the platform adds (a confirmed card's job / run). */
  readonly addLinks: readonly PlanLink[];
  /** What it follows (for the change event). */
  readonly target: TargetState;
}

/**
 * The status an item takes from its links (null: nothing to follow — the assistant / the person decide). A proposed card
 * that is the item's newest link waits (in progress); otherwise the newest job / run link wins; without one, the newest
 * card: a proposed card waits (in progress), a confirmed card follows the
 * job / run it created (added as a link), a dismissed / expired / failed card blocks the item.
 */
export function derivedStatus(links: readonly PlanLink[], facts: LinkFacts): Derived | null {
  const addLinks: PlanLink[] = [];
  const all = [...links];
  for (const l of links) {
    if (l.kind !== 'draft') continue;
    const d = facts.drafts.get(l.id);
    if (d === undefined || d.state !== 'confirmed') continue;
    if (d.jobId !== null && !all.some((x) => x.kind === 'job' && x.id === d.jobId)) {
      const link: PlanLink = { kind: 'job', id: d.jobId };
      addLinks.push(link);
      all.push(link);
    }
    if (d.runId !== null && !all.some((x) => x.kind === 'workflow_run' && x.id === d.runId)) {
      const link: PlanLink = { kind: 'workflow_run', id: d.runId };
      addLinks.push(link);
      all.push(link);
    }
    // p18-multi-project W5: a confirmed batch card follows its batch.
    const batch = d.batchId ?? null;
    if (batch !== null && !all.some((x) => x.kind === 'batch' && x.id === batch)) {
      const link: PlanLink = { kind: 'batch', id: batch };
      addLinks.push(link);
      all.push(link);
    }
    const auto = d.automationId ?? null;
    if (
      auto !== null &&
      d.jobId === null &&
      d.runId === null &&
      !all.some((x) => x.kind === 'automation' && x.id === auto)
    ) {
      const link: PlanLink = { kind: 'automation', id: auto };
      addLinks.push(link);
      all.push(link);
    }
  }
  // p18-plan-autonomy: a card made after an earlier job / run (a retry waiting for the person — the item's newest link)
  // is what the item waits for now, not the earlier job's end.
  const newest = links.at(-1);
  const retryWaits = newest?.kind === 'draft' && facts.drafts.get(newest.id)?.state === 'proposed';
  // The newest followed link whose target the platform knows (a PR URL of another host, an unknown automation, an
  // output of no job are skipped: the older link decides).
  const known = (l: PlanLink): boolean => {
    if (!FOLLOWED.has(l.kind)) return false;
    if (l.kind === 'pr') return facts.prs?.has(l.id) === true;
    if (l.kind === 'automation') return facts.automations?.has(l.id) === true;
    if (l.kind === 'batch') return facts.batches?.has(l.id) === true;
    if (l.kind === 'output') {
      const j = outputJob(l.id);
      return j !== null && facts.jobs.has(j);
    }
    return true;
  };
  const followed = [...all].reverse().find(known);
  const from = (target: TargetState, note: string | null): Derived => ({
    status:
      target === 'succeeded'
        ? 'done'
        : target === 'running' || target === 'waiting'
          ? 'in_progress'
          : 'blocked',
    note,
    addLinks,
    target,
  });
  if (retryWaits) return from('waiting', null);
  if (followed !== undefined) {
    // W4: a pull request — merged → done, closed → blocked (not a failed attempt), open → in progress.
    if (followed.kind === 'pr') {
      const pr = facts.prs?.get(followed.id);
      if (pr === undefined) return null;
      return pr.state === 'merged'
        ? from('succeeded', null)
        : pr.state === 'closed'
          ? from('cancelled', clipNote(pr.reason ?? 'pull request closed'))
          : from('running', null);
    }
    // W4: an automation — enabled (or done) with its first run not failed, or any run succeeded → done; deleted / failed,
    // or failed before any success → blocked; paused → in progress.
    if (followed.kind === 'automation') {
      const a = facts.automations?.get(followed.id);
      if (a === undefined) return null;
      if (a.succeeded) return from('succeeded', null);
      if (a.state === 'deleted' || a.state === 'failed')
        return from('failed', clipNote(a.lastReason ?? `automation ${a.state}`));
      if (a.lastState === 'failed' || a.lastState === 'error')
        return from('failed', clipNote(a.lastReason ?? 'first run failed'));
      return a.state === 'active' || a.state === 'done' ? from('succeeded', null) : from('running', null);
    }
    // p18-multi-project W5: a job batch — done when every created job succeeded, blocked when one failed.
    if (followed.kind === 'batch') {
      const b = facts.batches?.get(followed.id);
      if (b === undefined) return null;
      return b.state === 'done'
        ? from('succeeded', null)
        : b.state === 'running'
          ? from('running', null)
          : from('failed', clipNote(b.note ?? `batch ${b.state}`));
    }
    // W4: a job's output — there once the job succeeded.
    if (followed.kind === 'output') {
      const j = facts.jobs.get(outputJob(followed.id) ?? '');
      if (j === undefined) return null;
      const t = jobTarget(j.state);
      return from(
        t,
        t === 'failed' || t === 'cancelled' ? clipNote(j.summary ?? j.state.toLowerCase()) : null,
      );
    }
    if (followed.kind === 'job') {
      const j = facts.jobs.get(followed.id);
      if (j === undefined) return null;
      const t = jobTarget(j.state);
      return from(
        t,
        t === 'failed' || t === 'cancelled' ? clipNote(j.summary ?? j.state.toLowerCase()) : null,
      );
    }
    const r = facts.runs.get(followed.id);
    if (r === undefined) return null;
    const t = runTarget(r.state);
    return from(t, t === 'failed' || t === 'cancelled' ? clipNote(r.reason ?? r.state) : null);
  }
  const card = [...all].reverse().find((l) => l.kind === 'draft');
  if (card === undefined) return null;
  const d = facts.drafts.get(card.id);
  if (d === undefined) return null;
  if (d.state === 'proposed') return from('waiting', null);
  if (d.state === 'confirmed') return from('running', null);
  return from('dismissed', clipNote(`card ${d.state}`));
}

/**
 * p18-plan-autonomy: consecutive failed attempts of the same item after which the platform stops retrying it by itself —
 * the item stays blocked with the reason and the owner is told ("Devam et" clears the count).
 */
export const PLAN_ITEM_FAILURE_CAP = 3;

/**
 * p18-plan-autonomy: an item's count of consecutive failed attempts after a derived change (null: unchanged). A job / run
 * that failed (not cancelled, not a dismissed card) counts once when it blocks the item; done clears it.
 */
export function failuresAfter(prev: PlanItemStatus, d: Derived, failures: number): number | null {
  if (d.status === 'done') return failures === 0 ? null : 0;
  if (d.status === 'blocked' && prev !== 'blocked' && d.target === 'failed') return failures + 1;
  return null;
}

export function clipNote(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > PLAN_LIMITS.note ? `${one.slice(0, PLAN_LIMITS.note - 1)}…` : one || '—';
}

/** Whether the item follows a job or a run (its status is derived; the assistant may only block it with a note). */
export function followsTarget(i: PlanItem): boolean {
  return i.links.some((l) => l.kind === 'job' || l.kind === 'workflow_run');
}

/**
 * The assistant's `plan_set_status` for one item: done is final; a job / run-linked item's derived status is not
 * overridden (except blocked with a note); at most one assistant-owned item in progress.
 */
export function checkStatusChange(
  items: readonly PlanItem[],
  key: string,
  next: PlanItemStatus,
  note: string | undefined,
): string | null {
  const item = items.find((i) => i.key === key);
  if (item === undefined) return `No item ${key} in the plan.`;
  if (item.status === 'done' && next !== 'done') return `Item ${key} is done; done is final.`;
  if (followsTarget(item) && next !== item.status && !(next === 'blocked' && note !== undefined))
    return `Item ${key} follows its job / run: its status changes by itself (only blocked with a note is allowed).`;
  if (next === 'in_progress' && item.owner === 'assistant') {
    const other = items.find(
      (i) => i.key !== key && i.owner === 'assistant' && i.status === 'in_progress' && !followsTarget(i),
    );
    if (other !== undefined)
      return `Item ${other.key} is already in progress: finish it (done / blocked) before you start ${key} — one assistant item at a time.`;
  }
  return null;
}

/** Items whose dependencies are done / skipped, still pending, not the person's own and without an open decision. */
export function readyItems(
  items: readonly PlanItem[],
  openDecisionItems: ReadonlySet<string> = new Set(),
): PlanItem[] {
  const finished = new Set(
    items.filter((i) => i.status === 'done' || i.status === 'skipped').map((i) => i.key),
  );
  return ordered(items).filter(
    (i) =>
      i.status === 'pending' &&
      i.owner !== 'user' &&
      !openDecisionItems.has(i.key) &&
      i.dependsOn.every((d) => finished.has(d)),
  );
}

export interface Progress {
  readonly done: number;
  /** Items not skipped. */
  readonly total: number;
  readonly skipped: number;
  /**
   * Estimated minutes left on the critical path, in agent time (see {@link remainingMinutes}); null when no open item
   * has an estimate. Items the user owns are waits for a person and are not counted.
   */
  readonly remainingMinutes: number | null;
}

/**
 * Agent-time minutes of a size, per owner. Measured on the cluster's jobs (2026-10-28, last 30 days, jobs over a
 * minute: median ≈ 5 min, p75 ≈ 20, p90 ≈ 31): a job / workflow item S 5, M 20, L 45; an assistant item (chat actions)
 * S 2, M 5, L 15. A person's item counts 0 (it waits for them; the plan shows it as such).
 */
const SIZE_MINUTES: Readonly<Record<'agent' | 'assistant', Readonly<Record<'S' | 'M' | 'L', number>>>> = {
  agent: { S: 5, M: 20, L: 45 },
  assistant: { S: 2, M: 5, L: 15 },
};

export function estimateMinutes(e: PlanEstimate | null, owner: PlanOwner = 'job'): number | null {
  if (e === null) return null;
  if (owner === 'user') return 0;
  if (typeof e === 'number') return e;
  return SIZE_MINUTES[owner === 'assistant' ? 'assistant' : 'agent'][e];
}

/**
 * Minutes left on the critical path: an open item finishes after its open dependencies (job / workflow items run in
 * parallel), the assistant's own items one after another (in plan order); an item in progress counts half of its
 * estimate. Null when no open item has an estimate.
 */
export function remainingMinutes(items: readonly PlanItem[]): number | null {
  const open = ordered(items).filter((i) => i.status !== 'done' && i.status !== 'skipped');
  if (!open.some((i) => i.estimate !== null)) return null;
  const byKey = new Map(open.map((i) => [i.key, i]));
  const finish = new Map<string, number>();
  let assistantFree = 0;
  const visit = (i: PlanItem, seen: Set<string>): number => {
    const known = finish.get(i.key);
    if (known !== undefined) return known;
    if (seen.has(i.key)) return 0;
    seen.add(i.key);
    const deps = i.dependsOn.map((k) => byKey.get(k)).filter((d): d is PlanItem => d !== undefined);
    let start = Math.max(0, ...deps.map((d) => visit(d, seen)));
    const own = estimateMinutes(i.estimate, i.owner) ?? 0;
    const d = i.status === 'in_progress' ? own / 2 : own;
    if (i.owner === 'assistant') {
      start = Math.max(start, assistantFree);
      assistantFree = start + d;
    }
    const end = start + d;
    finish.set(i.key, end);
    return end;
  };
  for (const i of open) visit(i, new Set());
  return Math.round(Math.max(0, ...finish.values()));
}

export function progressOf(items: readonly PlanItem[]): Progress {
  const skipped = items.filter((i) => i.status === 'skipped').length;
  const done = items.filter((i) => i.status === 'done').length;
  return {
    done,
    total: items.length - skipped,
    skipped,
    remainingMinutes: remainingMinutes(items),
  };
}

/** A short fingerprint of where the plan stands (a continuation turn that leaves it unchanged made no progress). */
export function progressMark(items: readonly PlanItem[], answered: number, version: number): string {
  const s = ordered(items)
    .map((i) => `${i.key}:${i.status}:${String(i.links.length)}`)
    .join('|');
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619) >>> 0;
  return `${String(version)}.${String(answered)}.${h.toString(36)}`;
}

/** Whether something is still under way (a card waits, a job / run runs, an assistant item is in progress). */
export function anythingUnderway(items: readonly PlanItem[]): boolean {
  return items.some((i) => i.status === 'in_progress');
}

// ------------------------------------------------------------------------------------------------ states

export const ACTIVE: ReadonlySet<PlanState> = new Set<PlanState>([
  'drafting',
  'in_review',
  'approved',
  'executing',
  'paused',
]);

export function isActive(s: PlanState): boolean {
  return ACTIVE.has(s);
}

// ------------------------------------------------------------------------------------------------ plan mode

/**
 * The tool × mode matrix (design §2): while planning only `read` tools, `ask_user`, the plan tools (but not
 * `plan_propose`) and `set_chat_title` run; outside plan mode `plan_create` is refused. Returns the refusal code, or
 * null when the tool may run.
 */
export function planModeRefusal(tool: AssistantToolName, planMode: boolean): string | null {
  const kind = ASSISTANT_TOOLS[tool].kind as string;
  if (planMode) {
    if (tool === 'plan_propose') return 'plan_mode_active';
    if (kind === 'read' || kind === 'plan') return null;
    if (tool === 'ask_user' || tool === 'set_chat_title') return null;
    return 'plan_mode_read_only';
  }
  if (tool === 'plan_create') return 'plan_mode_required';
  return null;
}

// ------------------------------------------------------------------------------------------------ turn block

export interface BlockDecision {
  readonly id: string;
  readonly itemKey: string | null;
  readonly prompt: string;
  readonly state: string;
  readonly answer: string | null;
}

/**
 * The compact per-turn "aktif plan" block (≤ 6 KB): id, version, state, items (key, title, status, owner, project,
 * dependencies), decisions, the person's last edit. Fenced as data; long plans drop details first, then done items.
 */
export function planBlock(p: {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly version: number;
  readonly state: PlanState;
  readonly items: readonly PlanItem[];
  readonly decisions: readonly BlockDecision[];
  readonly userEdit: UserEditView | null;
  readonly stalled: string | null;
  /** p18-plan-autonomy: approved to run on its own (continuation drafts run at once). */
  readonly autonomous?: boolean | undefined;
}): string {
  const items = ordered(p.items);
  const progress = progressOf(items);
  const build = (compact: number): string => {
    const shown = compact >= 2 ? items.filter((i) => i.status !== 'done' && i.status !== 'skipped') : items;
    const body = {
      planId: p.id,
      title: p.title,
      goal: compact >= 1 ? p.goal.slice(0, 200) : p.goal,
      version: p.version,
      state: p.state,
      ...(p.autonomous === true && (p.state === 'executing' || p.state === 'approved')
        ? { autonomous: true }
        : {}),
      progress: `${String(progress.done)}/${String(progress.total)}`,
      ...(p.stalled === null ? {} : { stalled: p.stalled }),
      ...(compact >= 2 ? { omitted: `${String(items.length - shown.length)} done / skipped items` } : {}),
      items: shown.map((i) => ({
        key: i.key,
        phase: i.phaseTitle,
        title: i.title,
        status: i.status,
        owner: i.owner,
        ...(i.project === null ? {} : { project: i.project }),
        ...(i.dependsOn.length === 0 ? {} : { dependsOn: i.dependsOn }),
        ...(i.note === null || compact >= 3 ? {} : { note: i.note }),
        ...(i.links.length === 0 || compact >= 3 ? {} : { links: i.links.map((l) => `${l.kind}:${l.id}`) }),
      })),
      decisions: p.decisions.map((d) => ({
        id: d.id,
        ...(d.itemKey === null ? {} : { item: d.itemKey }),
        prompt: d.prompt,
        state: d.state,
        ...(d.answer === null ? {} : { answer: d.answer }),
      })),
      ...(p.userEdit === null
        ? {}
        : {
            userEdited: {
              note: `Kullanıcı planı düzenledi (the user edited the plan: your v${String(p.userEdit.sinceVersion)} → their v${String(p.userEdit.version)}) — follow the edited plan; do not undo their edits.`,
              added: p.userEdit.added,
              removed: p.userEdit.removed,
              changed:
                compact >= 1
                  ? p.userEdit.changed.map((c) => ({ key: c.key, fields: c.fields }))
                  : p.userEdit.changed,
              moved: p.userEdit.moved,
            },
          }),
    };
    return fenceData('aktif plan', body);
  };
  for (let c = 0; c <= 3; c++) {
    const b = build(c);
    if (Buffer.byteLength(b, 'utf8') <= PLAN_LIMITS.blockBytes || c === 3) return b;
  }
  return build(3);
}

/** The instruction that leads a plan-mode turn's message (a master block, like p15-workflow-ai's). */
export const PLAN_MODE_INSTRUCTION =
  'PLAN MODE (the user turned it on): you only analyse and plan — read-only. Use read tools to look things up, ask what you need (ask_user, or plan_ask_decision with a recommended option and a rationale), then write the plan with plan_create — or, when the "aktif plan" block shows a plan not yet approved, revise it with plan_update_items (with a reason). Drafts, watches, notes and actions are refused in plan mode; do not try them. Keep items small and concrete with an imperative title, an activeTitle, the right owner (assistant / job / workflow / user) and project. Finish with a short summary of the plan and the open decisions.';

/**
 * p18-plan-autonomy: what a continuation turn of an autonomous plan is told (appended to the continuation message — a
 * master-side instruction; the worker's prompt rule 52 still says "approval is not confirmation", this overrides it for
 * these turns).
 */
export const PLAN_AUTONOMY_INSTRUCTION = [
  'AUTONOMOUS PLAN: the user approved this plan to run on its own. Create the drafts for the next item(s) now (pass planItem with the item key) — they run immediately, with no card and no confirmation; do not ask the user to confirm and do not end the turn waiting for a click.',
  'Independent job / workflow items whose dependsOn are done may be started in this same turn (in parallel); assistant-owned items one at a time (mark them with plan_set_status as you go).',
  'If a step failed (a blocked item with a reason, or a draft that was refused), investigate with read tools (the job, its log, the run), fix the cause and retry with a new draft for the same item; if the plan itself must change, use plan_update_items (a structural change sends the plan back to the user for review). Set an item blocked with a clear reason only when it truly cannot proceed. After ' +
    String(PLAN_ITEM_FAILURE_CAP) +
    ' failed attempts of the same item the platform stops retrying it and asks the user.',
  'A draft that still comes back as a card (the security policy wants an authenticator code, a one-time secret, a destructive change, or a card-only tool) waits for the user: link it to its item and go on with other ready items.',
].join(' ');

export function composePlanMessage(instruction: string, text: string, max: number): string {
  const head = `${instruction}\n\nThe user's message:\n`;
  const room = max - head.length - 16;
  return `${head}${text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text}`;
}
