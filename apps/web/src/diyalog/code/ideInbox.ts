import { useEffect } from 'react';
import { claimIdeReferences } from '../../api/ide';
import { useT } from '../../i18n/I18nProvider';
import { toast } from '../toast/store';
import { addPendingCodeRef, parseCodeRef } from './refs';

/**
 * p19-ide W2 (docs/design/p19-ide.md §6): "Sohbete ekle" in the Tam IDE tab reaches the console — the bridge extension
 * posts the reference to the master (path + range), and every console tab of the user takes it from there and adds it
 * to the composer's pending references (the same chips as the viewer's). Small and in the shell: it polls only while
 * the user opened an IDE in the last 8 hours (a local flag) and the tab is visible.
 */

const KEY = 'remyral.ideActiveAt';
const WINDOW_MS = 8 * 60 * 60_000;
const POLL_MS = 5_000;

/** Called when the user opens an IDE (the inbox starts polling). */
export function markIdeActive(now: number = Date.now()): void {
  try {
    localStorage.setItem(KEY, String(now));
  } catch {
    // Storage off: no inbox polling (the references wait at the master for an hour).
  }
}

export function ideActive(now: number = Date.now()): boolean {
  try {
    const at = Number(localStorage.getItem(KEY) ?? '0');
    return Number.isFinite(at) && at > 0 && now - at < WINDOW_MS;
  } catch {
    return false;
  }
}

/** Takes the user's IDE references once and adds them to the pending chips; returns how many were added. */
export async function drainIdeReferences(words: {
  added: (p: { label: string }) => string;
  goChat: string;
}): Promise<number> {
  const refs = await claimIdeReferences({ noSessionRetry: true }).catch(() => []);
  let n = 0;
  for (const r of refs) {
    const ref = parseCodeRef(r.id, r.project);
    if (ref === null) continue;
    if (addPendingCodeRef(ref)) {
      n++;
      toast({
        tone: 'success',
        title: words.added({ label: r.label }),
        actions: [{ label: words.goChat, to: '/chat' }],
        testId: 'ide-ref-toast',
      });
    }
  }
  return n;
}

export function useIdeInbox(): void {
  const t = useT().ide.inbox;
  useEffect(() => {
    let stopped = false;
    let running = false;
    const tick = (): void => {
      if (stopped || running || !ideActive() || document.visibilityState !== 'visible') return;
      running = true;
      void drainIdeReferences(t).finally(() => {
        running = false;
      });
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [t]);
}
