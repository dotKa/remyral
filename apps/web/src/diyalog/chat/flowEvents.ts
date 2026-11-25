import { useSyncExternalStore } from 'react';

/**
 * p17-chat-flow leftover (p18-plan-mode W4): the conversation stream's `flow` events — a workflow approval step shown
 * as a card in the conversation was decided or closed elsewhere (`{kind: 'workflow-approval', runId, nodeRunId,
 * state}`). The card reads its live state again on such an event instead of polling; a stream that (re)opens counts
 * as one refresh for every card (whatever happened while it was closed).
 */
const signals = new Map<string, number>();
let opened = 0;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** A `flow` stream event (anything that is not a workflow approval's is ignored). */
export function pushFlowEvent(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const d = data as Record<string, unknown>;
  if (d.kind !== 'workflow-approval' || typeof d.nodeRunId !== 'string') return;
  signals.set(d.nodeRunId, (signals.get(d.nodeRunId) ?? 0) + 1);
  emit();
}

/** A conversation stream (re)opened: every card refreshes once. */
export function flowStreamOpened(): void {
  opened++;
  emit();
}

/** Grows whenever the step `nodeRunId` was told decided / closed, or a stream (re)opened. */
export function useFlowSignal(nodeRunId: string): number {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return (signals.get(nodeRunId) ?? 0) + opened;
}

/** Tests: forget everything. */
export function resetFlowEvents(): void {
  signals.clear();
  opened = 0;
  emit();
}
