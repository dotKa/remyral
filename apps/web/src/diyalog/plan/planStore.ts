import { useSyncExternalStore } from 'react';
import { type Plan, parsePlan } from '../../api/plans';
import { newerPlan } from './planModel';

/**
 * p18-plan-mode: the plans the conversation streams pushed (`plan` events carry the full plan), per conversation. The
 * thread view (REST) and the stream meet here: the newer revision wins (planModel.newerPlan), so a late REST answer
 * never rolls a live update back, and a reconnect's reload brings the plan back by REST.
 */
interface Entry {
  readonly plan: Plan;
  readonly at: number;
}

const pushed = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version++;
  for (const l of listeners) l();
}

/** A `plan` stream event of conversation `threadId` (ignored when it is not a plan). */
export function pushPlanEvent(threadId: string, data: unknown): void {
  const raw = typeof data === 'object' && data !== null ? (data as { plan?: unknown }).plan : undefined;
  const plan = parsePlan(raw);
  if (plan === null) return;
  const cur = pushed.get(threadId)?.plan ?? null;
  const next = newerPlan(cur, plan);
  if (next === cur) return;
  if (next !== null) pushed.set(threadId, { plan: next, at: Date.now() });
  emit();
}

/** A plan the person changed here (approve, edit …): the answer is shown at once. */
export function putPlan(threadId: string, plan: Plan): void {
  pushPlanEvent(threadId, { plan: plan as unknown });
  const e = pushed.get(threadId);
  if (e === undefined || e.plan.rev < plan.rev) {
    pushed.set(threadId, { plan, at: Date.now() });
    emit();
  }
}

/** Tests: forget everything. */
export function resetPlanStore(): void {
  pushed.clear();
  focus.clear();
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** A pushed plan younger than this survives a thread view that does not have it yet. */
const FRESH_MS = 4_000;

/**
 * The plan to show for a conversation: the thread view's active plan merged with the pushed ones. `fromDetail`
 * undefined: the thread view is not loaded (only pushed plans count); null: the conversation has no active plan.
 */
export function usePlan(threadId: string | null, fromDetail: Plan | null | undefined): Plan | null {
  // The store's version re-renders the caller when a plan is pushed; the merge itself is cheap.
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  if (threadId === null) return null;
  const e = pushed.get(threadId);
  if (fromDetail === undefined) return e?.plan ?? null;
  if (fromDetail === null) return e !== undefined && Date.now() - e.at < FRESH_MS ? e.plan : null;
  return newerPlan(e?.plan ?? null, fromDetail);
}

/* ------------------------------------------------------------------ W4: show an item (a chat card's plan link) */

/** `key` null: the plan's open decisions (p20-quick "Kalan N kararı göster"), not an item. */
export interface PlanFocus {
  readonly key: string | null;
  readonly n: number;
}

const focus = new Map<string, PlanFocus>();
let focusN = 0;

/**
 * p18-plan-mode W4: a chat card that serves a plan item ("Plan maddesi: …") asks the conversation's plan panel to show
 * that item — the panel unfolds its phase, scrolls it into view, marks it for a moment and moves the focus to it.
 */
export function focusPlanItem(threadId: string, key: string): void {
  focusN++;
  focus.set(threadId, { key, n: focusN });
  emit();
}

/**
 * p20-quick: "Kalan N kararı göster" — the plan panel scrolls its open decisions into view and moves the focus to the
 * first one (its first answer control).
 */
export function focusPlanDecisions(threadId: string): void {
  focusN++;
  focus.set(threadId, { key: null, n: focusN });
  emit();
}

/** The latest "show this item" request of a conversation (`n` grows per request), or null. */
export function usePlanFocus(threadId: string | null): PlanFocus | null {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return threadId === null ? null : (focus.get(threadId) ?? null);
}
