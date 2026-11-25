import { useEffect, useRef } from 'react';
import { toast, type ToastAction, type ToastTone } from './store';

/**
 * p17-toasts-shortcuts (docs/design/p17-toasts-shortcuts.md §4): the bridge for screens that kept an action's result
 * in a `done` / `note` state shown next to the button — the text now becomes a toast each time it is set (setting it
 * back to null clears nothing: the toast leaves on its own). For transient results only ("Kaydedildi.", "Çalıştırma
 * başladı."); validation errors, field hints and lasting states stay inline.
 */
export function useDoneToast(
  done: string | null,
  opts: {
    readonly tone?: ToastTone | undefined;
    readonly testId?: string | undefined;
    /** Same id → a repeat replaces the toast on screen (default: the test id). */
    readonly id?: string | undefined;
    readonly actions?: readonly ToastAction[] | undefined;
  } = {},
): void {
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    if (done === null || done === '') return;
    const o = latest.current;
    toast({
      tone: o.tone ?? 'success',
      title: done,
      testId: o.testId,
      id: o.id ?? o.testId,
      actions: o.actions,
    });
  }, [done]);
}
