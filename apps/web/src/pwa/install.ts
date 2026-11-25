import { useSyncExternalStore } from 'react';

/**
 * p8-pwa install prompt (docs/design/p8-pwa.md §6). Chromium (Android, desktop Chrome/Edge) fires
 * `beforeinstallprompt`; we keep the event and offer an "Install app" button instead of the browser's
 * mini-infobar. Safari (iOS/macOS) and Firefox have no such event: the UI shows instructions instead.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Call once at start-up (main.tsx). */
export function listenForInstallPrompt(win: Window = window): void {
  win.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  win.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    emit();
  });
}

export interface InstallState {
  /** The browser offered installation (Chromium); `promptInstall` shows its dialog. */
  readonly canPrompt: boolean;
  /** Installed during this page's lifetime. */
  readonly installedNow: boolean;
}

let snapshot: InstallState = { canPrompt: false, installedNow: false };
function current(): InstallState {
  if (snapshot.canPrompt !== (deferred !== null) || snapshot.installedNow !== installed) {
    snapshot = { canPrompt: deferred !== null, installedNow: installed };
  }
  return snapshot;
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    current,
    () => snapshot,
  );
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const e = deferred;
  if (!e) return 'unavailable';
  deferred = null; // the event can be used once
  emit();
  await e.prompt();
  const choice = await e.userChoice;
  return choice.outcome;
}
