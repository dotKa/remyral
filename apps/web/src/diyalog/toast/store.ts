import type { IconName } from '../icons';

/**
 * p17-toasts-shortcuts (docs/design/p17-toasts-shortcuts.md §2): the toast queue of the Diyalog console — one per
 * tab, shown by the one `DyToaster` the shell mounts.
 *
 * `toast()` can be called from anywhere (an event handler, a hook, a background watcher); it never touches focus.
 * Success / info / warning toasts leave after their duration (5 s / 5 s / 8 s by default, longer for a long text, up
 * to 12 s); errors stay until the person dismisses them. Every timer pauses while the pointer or the keyboard is in the toaster and while the tab is
 * hidden (a toast nobody could read does not expire), and resumes with what it had left. A toast with an `id` that is
 * already shown is replaced in place (its timer starts again) — a burst updates one toast instead of stacking.
 *
 * Texts arrive already in the console language (the caller reads its catalog); they are rendered as React text.
 */

export type ToastTone = 'success' | 'info' | 'warning' | 'error';

export interface ToastAction {
  readonly label: string;
  /** In-app path: the action is a link (react-router) that also closes the toast. */
  readonly to?: string | undefined;
  /** Runs on click; the toast closes afterwards unless `keepOpen`. */
  readonly onClick?: (() => void) | undefined;
  readonly keepOpen?: boolean | undefined;
  readonly testId?: string | undefined;
}

export interface ToastOptions {
  /** Same id → the shown toast is replaced (and its timer restarts); otherwise a new one is added. */
  readonly id?: string | undefined;
  readonly tone?: ToastTone | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  /** At most two buttons ("İşi aç", "Geri al"). */
  readonly actions?: readonly ToastAction[] | undefined;
  /** A quieter link under the text ("Ayrıntılar"). */
  readonly link?: { readonly label: string; readonly to: string } | undefined;
  /** ms; `Infinity` keeps it until dismissed. Default by tone (errors: until dismissed). */
  readonly duration?: number | undefined;
  readonly icon?: IconName | undefined;
  readonly testId?: string | undefined;
}

export interface Toast {
  readonly id: string;
  readonly tone: ToastTone;
  readonly title: string;
  readonly description: string | undefined;
  readonly actions: readonly ToastAction[];
  readonly link: { readonly label: string; readonly to: string } | undefined;
  readonly duration: number;
  readonly icon: IconName | undefined;
  readonly testId: string | undefined;
  /** False while it plays its exit (then the toaster removes it). */
  readonly open: boolean;
  /** Bumped on every show / replace: the toaster announces a toast once per version. */
  readonly version: number;
  readonly createdAt: number;
}

export const DEFAULT_DURATION: Readonly<Record<ToastTone, number>> = {
  success: 5_000,
  info: 5_000,
  warning: 8_000,
  error: Number.POSITIVE_INFINITY,
};

/** A long text gets time to be read: this much per character over the tone's default, up to READ_MAX_MS. */
export const READ_MS_PER_CHAR = 60;
export const READ_MAX_MS = 12_000;

/** The default duration of a toast: its tone's, longer for a long text (never for an error: it stays). */
export function defaultDuration(tone: ToastTone, text: string): number {
  const base = DEFAULT_DURATION[tone];
  if (!Number.isFinite(base)) return base;
  return Math.max(base, Math.min(READ_MAX_MS, 2_000 + text.length * READ_MS_PER_CHAR));
}

/** Toasts kept in the queue (shown or collapsed); beyond this the oldest that may expire goes first. */
export const MAX_QUEUE = 12;
/** Toasts shown at once; older ones collapse into the "+N" stack. */
export const MAX_VISIBLE = 3;

interface Entry {
  toast: Toast;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  remaining: number;
}

let entries: Entry[] = [];
let snapshot: readonly Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const pauses = new Set<string>();
let now: () => number = () => Date.now();

function emit(): void {
  snapshot = entries.map((e) => e.toast);
  for (const l of [...listeners]) l();
}

function clear(e: Entry): void {
  if (e.timer !== null) clearTimeout(e.timer);
  e.timer = null;
}

function arm(e: Entry): void {
  clear(e);
  if (pauses.size > 0 || !e.toast.open || !Number.isFinite(e.remaining)) return;
  e.startedAt = now();
  const id = e.toast.id;
  e.timer = setTimeout(
    () => {
      dismissToast(id);
    },
    Math.max(0, e.remaining),
  );
}

/** Shows a toast; returns its id (for `dismissToast` / a later replace). */
export function toast(opts: ToastOptions): string {
  const tone = opts.tone ?? 'info';
  const id = opts.id ?? `t${String(++seq)}`;
  const duration = opts.duration ?? defaultDuration(tone, `${opts.title} ${opts.description ?? ''}`);
  const prev = entries.find((e) => e.toast.id === id);
  const next: Toast = {
    id,
    tone,
    title: opts.title,
    description: opts.description,
    actions: (opts.actions ?? []).slice(0, 2),
    link: opts.link,
    duration,
    icon: opts.icon,
    testId: opts.testId,
    open: true,
    version: (prev?.toast.version ?? 0) + 1,
    createdAt: now(),
  };
  if (prev !== undefined) {
    // Replaced in place, moved to the top (newest), timer from the start.
    entries = entries.filter((e) => e !== prev);
    clear(prev);
  }
  const entry: Entry = { toast: next, timer: null, startedAt: now(), remaining: duration };
  entries = [entry, ...entries];
  // Over the cap: drop the oldest that would expire anyway, else the oldest.
  while (entries.length > MAX_QUEUE) {
    const victim =
      [...entries].reverse().find((e) => Number.isFinite(e.remaining)) ?? entries[entries.length - 1];
    if (victim === undefined) break;
    clear(victim);
    entries = entries.filter((e) => e !== victim);
  }
  arm(entry);
  emit();
  return id;
}

/** Shorthands: `toast.success('Kaydedildi.')`. */
toast.success = (title: string, opts: Omit<ToastOptions, 'title' | 'tone'> = {}): string =>
  toast({ ...opts, title, tone: 'success' });
toast.info = (title: string, opts: Omit<ToastOptions, 'title' | 'tone'> = {}): string =>
  toast({ ...opts, title, tone: 'info' });
toast.warning = (title: string, opts: Omit<ToastOptions, 'title' | 'tone'> = {}): string =>
  toast({ ...opts, title, tone: 'warning' });
toast.error = (title: string, opts: Omit<ToastOptions, 'title' | 'tone'> = {}): string =>
  toast({ ...opts, title, tone: 'error' });

/**
 * The element sits in an open modal dialog. A modal makes the rest of the page inert — the toaster too — so a result
 * shown from inside one stays inside it (next to the action), as before.
 */
export function insideModal(el: Element | null): boolean {
  return el?.closest('dialog[open]') != null;
}

/** Starts the toast's exit (the toaster removes it when the exit has played). */
export function dismissToast(id: string): void {
  const e = entries.find((x) => x.toast.id === id);
  if (e === undefined || !e.toast.open) return;
  clear(e);
  e.toast = { ...e.toast, open: false };
  emit();
}

/** Takes a closed toast out of the queue (its exit has played). */
export function removeToast(id: string): void {
  const e = entries.find((x) => x.toast.id === id);
  if (e === undefined) return;
  clear(e);
  entries = entries.filter((x) => x !== e);
  emit();
}

/** Pauses every timer for `reason` ('hover', 'focus', 'hidden'); timers resume once no reason is left. */
export function pauseToasts(reason: string): void {
  if (pauses.has(reason)) return;
  const first = pauses.size === 0;
  pauses.add(reason);
  if (!first) return;
  const t = now();
  for (const e of entries) {
    if (e.timer === null) continue;
    e.remaining = Math.max(0, e.remaining - (t - e.startedAt));
    clear(e);
  }
}

export function resumeToasts(reason: string): void {
  if (!pauses.delete(reason) || pauses.size > 0) return;
  for (const e of entries) arm(e);
}

export function toastsPaused(): boolean {
  return pauses.size > 0;
}

export function subscribeToasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getToasts(): readonly Toast[] {
  return snapshot;
}

/** Test seam: an empty queue, no pauses, the real clock (or `clock`). */
export function resetToasts(clock?: () => number): void {
  for (const e of entries) clear(e);
  entries = [];
  pauses.clear();
  seq = 0;
  now = clock ?? (() => Date.now());
  emit();
}
