import type { Messages } from '@remyral/i18n';
import type { Plan, PlanItem, PlanState, PlanUserOp } from '../../api/plans';
import type { DyState } from '../StateBadge';

/**
 * p18-plan-mode (docs/design/p18-plan-mode.md §3): the console's pure plan rules — which snapshot wins (rev ordering),
 * the current item, the items a phase shows (open / all, folded done items), the progress line, the plan's chip and
 * the live-region sentences between two snapshots. Tested without rendering.
 */

/**
 * The plan to show: the newest by `rev` for the same plan; another plan replaces it when it is active (a new plan
 * superseded the old one) or newer. A stale event (lower rev) never rolls the view back.
 */
export function newerPlan(cur: Plan | null, next: Plan | null): Plan | null {
  if (next === null) return cur;
  if (cur === null) return next;
  if (cur.id === next.id) return next.rev >= cur.rev ? next : cur;
  const active = (p: Plan): boolean => ACTIVE.has(p.state);
  if (active(next) && !active(cur)) return next;
  if (active(cur) && !active(next)) return cur;
  return Date.parse(next.updatedAt) >= Date.parse(cur.updatedAt) ? next : cur;
}

export const ACTIVE: ReadonlySet<PlanState> = new Set<PlanState>([
  'drafting',
  'in_review',
  'approved',
  'executing',
  'paused',
]);

/** The item being worked on: an assistant item in progress first, then any item in progress. */
export function currentItem(p: Plan): PlanItem | null {
  return (
    p.items.find((i) => i.status === 'in_progress' && i.owner === 'assistant') ??
    p.items.find((i) => i.status === 'in_progress') ??
    null
  );
}

/** The title an item shows: its activeTitle while in progress. */
export function itemTitle(i: PlanItem): string {
  return i.status === 'in_progress' && i.activeTitle !== null ? i.activeTitle : i.title;
}

export interface PhaseView {
  readonly index: number;
  readonly title: string;
  readonly done: number;
  readonly total: number;
  /** Shown rows (open filter: done / skipped fold away). */
  readonly items: readonly PlanItem[];
  /** Done / skipped items folded into "n tamamlandı" (open filter). */
  readonly folded: number;
}

export function phasesOf(
  p: Plan,
  filter: 'open' | 'all',
  recent: ReadonlySet<string> = new Set(),
  /** Editing: phases left empty by a move in progress stay (a drop target). */
  keepEmpty = false,
): PhaseView[] {
  const indexes = [
    ...new Set([...p.items.map((i) => i.phase), ...(keepEmpty ? p.phases.map((x) => x.index) : [])]),
  ].sort((a, b) => a - b);
  return indexes.map((index) => {
    const items = p.items.filter((i) => i.phase === index);
    const closed = (i: PlanItem): boolean =>
      (i.status === 'done' || i.status === 'skipped') && !recent.has(i.key);
    const shown = filter === 'all' ? items : items.filter((i) => !closed(i));
    return {
      index,
      title: items[0]?.phaseTitle ?? p.phases.find((x) => x.index === index)?.title ?? '',
      done: items.filter((i) => i.status === 'done').length,
      total: items.filter((i) => i.status !== 'skipped').length,
      items: shown,
      folded: items.length - shown.length,
    };
  });
}

/**
 * p18-multi-project W3: the phases with only the items of one project (`project` a project id, `null` the items without
 * a project, `undefined` every item). Phases left without an item are dropped.
 */
export function filterByProject(
  phases: readonly PhaseView[],
  project: string | null | undefined,
): PhaseView[] {
  if (project === undefined) return [...phases];
  return phases
    .map((ph) => ({ ...ph, items: ph.items.filter((i) => i.project === project) }))
    .filter((ph) => ph.items.length > 0);
}

/** p18-multi-project W3: the projects a plan's item editor and filter offer — the working projects, then the items'. */
export function planProjects(p: Plan, working: readonly string[]): string[] {
  return [...new Set([...working, ...p.items.flatMap((i) => (i.project === null ? [] : [i.project]))])];
}

export function openDecisions(p: Plan): number {
  return p.decisions.filter((d) => d.state === 'pending').length;
}

/** "2 sa 30 dk" / "45 dk" from minutes. */
export function durationText(minutes: number, t: Messages['plan']): string {
  if (minutes < 60) return t.minutes({ n: minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? t.hours({ n: h }) : `${t.hours({ n: h })} ${t.minutes({ n: m })}`;
}

/** "5/12 · ~2 sa kaldı". */
export function progressText(p: Plan, t: Messages['plan']): string {
  const base = t.progress({ done: p.progress.done, total: p.progress.total });
  return p.progress.remainingMinutes === null || p.progress.remainingMinutes === 0
    ? base
    : `${base} · ${t.remaining({ time: durationText(p.progress.remainingMinutes, t) })}`;
}

/** 0 … 1: done of the non-skipped items. */
export function progressRatio(p: Plan): number {
  return p.progress.total === 0 ? 0 : Math.min(1, p.progress.done / p.progress.total);
}

/** The plan's chip: a state of the shared badge and its word. */
export function planChip(s: PlanState): DyState {
  switch (s) {
    case 'drafting':
    case 'in_review':
      return 'needs';
    case 'approved':
    case 'executing':
      return 'running';
    case 'paused':
      return 'paused';
    case 'done':
      return 'done';
    default:
      return 'cancelled';
  }
}

/**
 * What the polite live region says when the plan changed from `prev` to `next` (one sentence per change, in order):
 * an item done ("Madde 4/12 tamamlandı: …") and the next one, an item started or blocked, decisions waiting, a new
 * state. Nothing on the first snapshot or for another plan's first view (only the plan is announced then).
 */
export function announcements(prev: Plan | null, next: Plan, t: Messages['plan']): string[] {
  if (prev === null) return [];
  if (prev.id !== next.id) return [t.live.created({ title: next.title })];
  const out: string[] = [];
  const before = new Map(prev.items.map((i) => [i.key, i] as const));
  const order = next.items.filter((i) => i.status !== 'skipped');
  for (const i of next.items) {
    const was = before.get(i.key);
    if (was === undefined || was.status === i.status) continue;
    if (i.status === 'done') {
      out.push(
        t.live.done({ i: order.findIndex((x) => x.key === i.key) + 1, n: order.length, title: i.title }),
      );
      const nxt = currentItem(next) ?? next.items.find((x) => x.status === 'pending');
      if (nxt !== undefined) out.push(t.live.next({ title: itemTitle(nxt) }));
    } else if (i.status === 'in_progress') out.push(t.live.started({ title: itemTitle(i) }));
    else if (i.status === 'blocked') out.push(t.live.blocked({ title: i.title }));
  }
  const d0 = openDecisions(prev);
  const d1 = openDecisions(next);
  if (d1 > d0) out.push(d1 === 1 ? t.live.decision : t.live.decisions({ n: d1 }));
  if (prev.state !== next.state) out.push(t.live.state({ state: t.states[next.state] }));
  return [...new Set(out)];
}

/** Items that changed status between two snapshots (their motion runs once). */
export function changedItems(prev: Plan | null, next: Plan): Map<string, PlanItem['status']> {
  const out = new Map<string, PlanItem['status']>();
  if (prev?.id !== next.id) return out;
  const before = new Map(prev.items.map((i) => [i.key, i.status] as const));
  for (const i of next.items) {
    const s = before.get(i.key);
    if (s !== undefined && s !== i.status) out.set(i.key, i.status);
  }
  return out;
}

/* ------------------------------------------------------------------ editing (W3) */

/** The plan can be edited here: the owner (not a shared reader) and an active plan (not done / cancelled). */
export function canEditPlan(p: Plan, readOnly: boolean): boolean {
  return !readOnly && ACTIVE.has(p.state);
}

/** An item can be edited (renamed, moved, removed …): everything but a done item (only the assistant reopens it). */
export function canEditItem(i: PlanItem): boolean {
  return i.status !== 'done';
}

interface LocalPhase {
  index: number;
  title: string;
  items: PlanItem[];
}

function toLocalPhases(p: Plan): LocalPhase[] {
  const out: LocalPhase[] = [];
  const indexes = [...new Set([...p.phases.map((x) => x.index), ...p.items.map((i) => i.phase)])].sort(
    (a, b) => a - b,
  );
  for (const index of indexes) {
    const items = p.items.filter((i) => i.phase === index).sort((a, b) => a.position - b.position);
    out.push({
      index,
      title: items[0]?.phaseTitle ?? p.phases.find((x) => x.index === index)?.title ?? '',
      items,
    });
  }
  return out;
}

/**
 * The person's operations applied here, before the master answers (optimistic; the answer replaces it): the same
 * rules as the master's `applyUserOps` for what the console sends. `keepPhases`: a phase a move empties stays with its
 * index (a move in progress — the drop is computed against the plan as it is); otherwise phases are numbered again
 * like the master does. `removed`: items removed here (an undo brings them back). An operation that does not fit (an
 * item gone meanwhile) is left out — the master decides.
 */
export function applyLocal(
  p: Plan,
  ops: readonly PlanUserOp[],
  opts: { readonly keepPhases?: boolean; readonly removed?: ReadonlyMap<string, PlanItem> } = {},
): Plan {
  if (ops.length === 0) return p;
  // Positions are relative to the list as it is, so phase indexes in ops are those of `p` (its phases array order).
  const phases = toLocalPhases(p);
  const at = (index: number): LocalPhase | undefined => phases[index];
  const find = (key: string): { ph: LocalPhase; idx: number; item: PlanItem } | null => {
    for (const ph of phases) {
      const idx = ph.items.findIndex((i) => i.key === key);
      const item = ph.items[idx];
      if (item !== undefined) return { ph, idx, item };
    }
    return null;
  };
  const put = (item: PlanItem, phase: number, after: string | null): boolean => {
    const ph = at(phase);
    if (ph === undefined) return false;
    if (after === null) {
      ph.items.unshift(item);
      return true;
    }
    const i = ph.items.findIndex((x) => x.key === after);
    if (i < 0) return false;
    ph.items.splice(i + 1, 0, item);
    return true;
  };
  let seq = 0;
  for (const op of ops) {
    if (op.op === 'add') {
      seq++;
      const item: PlanItem = {
        key: `local-${String(seq)}-${op.item.title.length.toString(36)}`,
        phase: op.phase,
        phaseTitle: '',
        position: 0,
        title: op.item.title,
        activeTitle: null,
        detail: op.item.detail ?? null,
        status: 'pending',
        owner: op.item.owner ?? 'user',
        project: null,
        dependsOn: [],
        estimate: op.item.estimate ?? null,
        links: [],
        note: null,
        statusBy: 'user',
        decisionOpen: false,
        awaitsUser: false,
        failures: 0,
      };
      // W4: one past the last phase opens a new phase with its title (as the master does).
      if (op.phase === phases.length && op.phaseTitle !== undefined)
        phases.push({ index: -1, title: op.phaseTitle, items: [item] });
      else put(item, op.phase, op.after);
      continue;
    }
    if (op.op === 'restore') {
      const gone = opts.removed?.get(op.key);
      if (gone === undefined || find(op.key) !== null) continue;
      const ph = phases.find((x) => x.title === gone.phaseTitle);
      if (ph !== undefined) ph.items.splice(Math.min(gone.position, ph.items.length), 0, gone);
      else {
        const idx = Math.min(gone.phase, phases.length);
        phases.splice(idx, 0, { index: -1, title: gone.phaseTitle, items: [gone] });
      }
      continue;
    }
    const f = find(op.key);
    if (f === null) continue;
    const set = (next: PlanItem): void => {
      f.ph.items[f.idx] = next;
    };
    switch (op.op) {
      case 'rename':
        set({ ...f.item, title: op.title });
        break;
      case 'detail':
        set({ ...f.item, detail: op.detail });
        break;
      case 'move':
        f.ph.items.splice(f.idx, 1);
        if (!put(f.item, op.phase, op.after)) f.ph.items.splice(f.idx, 0, f.item);
        break;
      case 'remove':
        f.ph.items.splice(f.idx, 1);
        break;
      case 'skip':
        set({ ...f.item, status: 'skipped', statusBy: 'user' });
        break;
      case 'unskip':
        set({ ...f.item, status: 'pending', statusBy: 'user' });
        break;
      case 'done_mine':
        set({ ...f.item, status: 'done', statusBy: 'user', note: null });
        break;
      case 'assign_me':
        set({ ...f.item, owner: 'user' });
        break;
      case 'set_owner':
        set({ ...f.item, owner: op.owner });
        break;
      case 'set_project':
        set({ ...f.item, project: op.project });
        break;
      case 'set_estimate':
        set({ ...f.item, estimate: op.estimate });
        break;
      case 'set_depends':
        set({ ...f.item, dependsOn: [...new Set(op.dependsOn)] });
        break;
    }
  }
  const kept = opts.keepPhases === true ? phases : phases.filter((ph) => ph.items.length > 0);
  const items = kept.flatMap((ph, n) =>
    ph.items.map((i, position) => ({
      ...i,
      phase: opts.keepPhases === true && ph.index >= 0 ? ph.index : n,
      phaseTitle: ph.title,
      position,
    })),
  );
  const done = items.filter((i) => i.status === 'done').length;
  const skipped = items.filter((i) => i.status === 'skipped').length;
  return {
    ...p,
    items,
    phases: kept.map((ph, n) => ({
      index: opts.keepPhases === true && ph.index >= 0 ? ph.index : n,
      title: ph.title,
    })),
    progress: { ...p.progress, done, skipped, total: items.length - skipped },
  };
}

/**
 * The move that puts `key` in phase `phase` (an index of `p.phases`) right before `before` (null: at the end of the
 * phase) — `after` is the item before that place in the full list (hidden done / skipped items count), so the master
 * puts it exactly there.
 */
export function moveOp(p: Plan, key: string, phase: number, before: string | null): PlanUserOp {
  const rest = p.items
    .filter((i) => i.phase === phase && i.key !== key)
    .sort((a, b) => a.position - b.position);
  const at = before === null ? rest.length : rest.findIndex((i) => i.key === before);
  const prev = at <= 0 ? null : (rest[at - 1]?.key ?? null);
  return { op: 'move', key, phase, after: at < 0 ? (rest[rest.length - 1]?.key ?? null) : prev };
}

/** Where an item is among the rows shown: its phase (index) and place (1-based) of the phase's shown rows. */
export function placeIn(
  shown: readonly PhaseView[],
  key: string,
): { phase: number; title: string; index: number; count: number } | null {
  for (const ph of shown) {
    const i = ph.items.findIndex((x) => x.key === key);
    if (i >= 0) return { phase: ph.index, title: ph.title, index: i + 1, count: ph.items.length };
  }
  return null;
}

/**
 * One keyboard step (↑ / ↓) of a picked-up item among the rows shown: within its phase, or over the edge into the
 * phase before (its end) / after (its start). Returns the drop place (phase index, the row it goes before; null: the
 * end), or null at the top / bottom of the plan.
 */
export function stepMove(
  shown: readonly PhaseView[],
  key: string,
  dir: -1 | 1,
): { phase: number; before: string | null } | null {
  const pi = shown.findIndex((ph) => ph.items.some((i) => i.key === key));
  const ph = shown[pi];
  if (ph === undefined) return null;
  const rows = ph.items.filter((i) => i.key !== key);
  const idx = ph.items.findIndex((i) => i.key === key);
  if (dir === -1) {
    if (idx > 0) return { phase: ph.index, before: rows[idx - 1]?.key ?? null };
    const prev = shown[pi - 1];
    return prev === undefined ? null : { phase: prev.index, before: null };
  }
  if (idx < rows.length) return { phase: ph.index, before: rows[idx + 1]?.key ?? null };
  const next = shown[pi + 1];
  if (next === undefined) return null;
  return { phase: next.index, before: next.items[0]?.key ?? null };
}

/** What changed between two snapshots of the same plan (the merge view): per item, with titles. */
export interface LocalChange {
  readonly key: string;
  readonly title: string;
  readonly change: 'added' | 'removed' | 'renamed' | 'moved' | 'status' | 'changed';
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export function planChanges(base: Plan, cur: Plan): LocalChange[] {
  const a = new Map(base.items.map((i) => [i.key, i] as const));
  const b = new Map(cur.items.map((i) => [i.key, i] as const));
  const out: LocalChange[] = [];
  const order = (p: Plan): string[] =>
    p.items.filter((i) => a.has(i.key) && b.has(i.key)).map((i) => `${i.phaseTitle}\u0000${i.key}`);
  const oldOrder = order(base);
  const newOrder = order(cur);
  for (const i of cur.items) {
    const was = a.get(i.key);
    if (was === undefined) {
      out.push({ key: i.key, title: i.title, change: 'added' });
      continue;
    }
    if (was.title !== i.title)
      out.push({ key: i.key, title: i.title, change: 'renamed', from: was.title, to: i.title });
    if (
      was.phaseTitle !== i.phaseTitle ||
      oldOrder.indexOf(`${was.phaseTitle}\u0000${i.key}`) !==
        newOrder.indexOf(`${i.phaseTitle}\u0000${i.key}`)
    )
      out.push({ key: i.key, title: i.title, change: 'moved', from: was.phaseTitle, to: i.phaseTitle });
    if (was.status !== i.status)
      out.push({ key: i.key, title: i.title, change: 'status', from: was.status, to: i.status });
    if (
      was.owner !== i.owner ||
      was.estimate !== i.estimate ||
      was.project !== i.project ||
      was.detail !== i.detail
    )
      out.push({ key: i.key, title: i.title, change: 'changed' });
  }
  for (const i of base.items) if (!b.has(i.key)) out.push({ key: i.key, title: i.title, change: 'removed' });
  return out;
}

/** "S" / "M" / "L" / "45 dk" / "2 sa". */
export function estimateText(e: string | number | null, t: Messages['plan']): string | null {
  if (e === null) return null;
  if (typeof e === 'string') return e === 'S' || e === 'M' || e === 'L' ? t.edit.sizes[e] : e;
  return durationText(e, t);
}

/** The live-region sentence of one of the person's edits (said at once, politely). */
export function editSentence(
  op: PlanUserOp,
  p: Plan,
  t: Messages['plan'],
  removed: ReadonlyMap<string, PlanItem> = new Map(),
): string {
  const title = (k: string): string => p.items.find((i) => i.key === k)?.title ?? removed.get(k)?.title ?? k;
  switch (op.op) {
    case 'rename':
      return t.edit.live.renamed({ title: op.title });
    case 'add':
      return t.edit.live.added({ title: op.item.title });
    case 'remove':
      return t.edit.live.removed({ title: title(op.key) });
    case 'restore':
      return t.edit.live.restored({ title: title(op.key) });
    case 'skip':
      return t.edit.live.skipped({ title: title(op.key) });
    case 'unskip':
      return t.edit.live.unskipped({ title: title(op.key) });
    case 'done_mine':
      return t.edit.live.doneMine({ title: title(op.key) });
    case 'move':
      return t.edit.live.moved({ title: title(op.key) });
    default:
      return t.edit.live.changed({ title: title(op.key) });
  }
}

/* ------------------------------------------------------------------ W4 */

/** p18-plan-mode W4: an item depends on at most this many items (the master's PLAN_LIMITS.dependsOn). */
export const PLAN_DEPENDS_MAX = 5;
/** The master's PLAN_LIMITS.phases. */
export const PLAN_PHASES_MAX = 8;

/**
 * W4: would `key` depending on `deps` close a cycle (it reaches `key` again through the others' dependencies)? The item
 * editor refuses it before sending (the master refuses it too: 409 plan_invalid).
 */
export function dependsCycle(items: readonly PlanItem[], key: string, deps: readonly string[]): boolean {
  const of = new Map(items.map((i) => [i.key, i.key === key ? [...deps] : i.dependsOn] as const));
  const seen = new Set<string>();
  const stack = [...deps];
  while (stack.length > 0) {
    const k = stack.pop() as string;
    if (k === key) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...(of.get(k) ?? []));
  }
  return false;
}

/** W4: the number of phases of a plan (a new phase from the panel is this index). */
export function phaseCount(p: Plan): number {
  return new Set([...p.phases.map((x) => x.index), ...p.items.map((i) => i.phase)]).size;
}

/** The platform stops retrying an item after this many failed attempts in a row (the master's PLAN_ITEM_FAILURE_CAP). */
const FAILURE_CAP = 3;

/**
 * p18-plans-ui: the items of an executing / paused plan that wait for the person — the master's `waitingItems` rule
 * ("Senden bekleyen"): a card to confirm, a blocked item the platform does not retry by itself, their own ready item.
 */
export function waitingFor(
  p: Plan,
): { readonly item: PlanItem; readonly why: 'card' | 'blocked' | 'mine' }[] {
  if (p.state !== 'executing' && p.state !== 'paused') return [];
  const finished = new Set(
    p.items.filter((i) => i.status === 'done' || i.status === 'skipped').map((i) => i.key),
  );
  return p.items.flatMap((i) => {
    if (i.status === 'done' || i.status === 'skipped') return [];
    const why = i.awaitsUser
      ? ('card' as const)
      : i.status === 'blocked' && (i.statusBy === 'assistant' || i.failures >= FAILURE_CAP)
        ? ('blocked' as const)
        : i.owner === 'user' &&
            (i.status === 'pending' || i.status === 'in_progress') &&
            !i.decisionOpen &&
            i.dependsOn.every((d) => finished.has(d))
          ? ('mine' as const)
          : null;
    return why === null ? [] : [{ item: i, why }];
  });
}
