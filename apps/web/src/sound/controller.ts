import { categoryOn, type SoundCategory, type SoundSettings } from './settings';

/**
 * p9-notification-sound (docs/design/p9-notification-sound.md §5): when a sound plays. Runs only in the leader tab.
 *
 * - `SoundGate`: settings, coalescing and the rate limit. Requests within `COALESCE_MS` become one chime (the most
 *   important category of the burst wins: approvals > notifications > chat); at most one chime per `MIN_GAP_MS` — a
 *   request inside the gap is dropped unless it is more important than the chime just played, then it plays once
 *   the gap is over.
 * - `SoundWatcher`: what is new. Notifications by id against those already seen (the first look only sets the
 *   baseline); chat by the unread total rising and still being higher after `CONFIRM_MS` (a conversation the user is
 *   looking at is marked read within that time, so it never sounds); notifications that appear within
 *   `OWN_ACTION_GRACE_MS` after the user acted in this browser are the echo of that action and stay silent.
 */

export const COALESCE_MS = 300;
export const MIN_GAP_MS = 2_000;
export const CONFIRM_MS = 1_500;
export const OWN_ACTION_GRACE_MS = 10_000;

const PRIORITY: Readonly<Record<SoundCategory, number>> = { chat: 1, notifications: 2, approvals: 3 };

/** Notification kinds that wait for the user's decision: the urgent chime. */
export const APPROVAL_KINDS: ReadonlySet<string> = new Set([
  'approval.requested',
  'approval.expiring',
  // p10-approval-pause: still waiting for the user's decision.
  'approval.stale',
  'deploy.waiting',
  'automation.waiting',
]);

export function categoryOfKind(kind: string): SoundCategory {
  return APPROVAL_KINDS.has(kind) ? 'approvals' : 'notifications';
}

export interface GateDeps {
  readonly settings: () => SoundSettings;
  /** Plays the category's chime; false when the audio cannot play (no gesture yet) — skipped, not retried. */
  readonly play: (category: SoundCategory) => boolean;
  readonly ready: () => boolean;
  readonly now?: () => number;
}

export type GateResult = 'off' | 'scheduled' | 'coalesced' | 'dropped';

export class SoundGate {
  private pending: { category: SoundCategory; timer: ReturnType<typeof setTimeout> } | null = null;
  private lastAt: number | null = null;
  private lastPriority = 0;

  constructor(private readonly deps: GateDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  request(category: SoundCategory): GateResult {
    if (!categoryOn(this.deps.settings(), category)) return 'off';
    if (this.pending) {
      if (PRIORITY[category] > PRIORITY[this.pending.category]) this.pending.category = category;
      return 'coalesced';
    }
    const t = this.now();
    let delay = COALESCE_MS;
    if (this.lastAt !== null && t - this.lastAt < MIN_GAP_MS) {
      if (PRIORITY[category] <= this.lastPriority) return 'dropped';
      delay = Math.max(COALESCE_MS, this.lastAt + MIN_GAP_MS - t);
    }
    const timer = setTimeout(() => {
      this.fire();
    }, delay);
    this.pending = { category, timer };
    return 'scheduled';
  }

  /** Whether a request for `category` now would end up audible (or merged into an audible chime). */
  audible(category: SoundCategory): boolean {
    return categoryOn(this.deps.settings(), category) && this.deps.ready();
  }

  private fire(): void {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    // Settings may have changed while the chime waited.
    if (!categoryOn(this.deps.settings(), p.category)) return;
    if (this.deps.play(p.category)) {
      this.lastAt = this.now();
      this.lastPriority = PRIORITY[p.category];
    }
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}

export interface SeenNotification {
  readonly id: string;
  readonly kind: string;
  readonly readAt: string | null;
}

export interface WatcherSources {
  readonly notifications: () => Promise<readonly SeenNotification[]>;
  readonly chatUnread: () => Promise<number>;
}

const SEEN_CAP = 500;

export class SoundWatcher {
  private readonly seen = new Set<string>();
  private notificationsBaseline = false;
  private chatLast: number | null = null;
  private chatBusy = false;
  private chatAgain = false;
  private lastOwnAction = Number.NEGATIVE_INFINITY;
  private disposed = false;

  /** Read through a method: the flag changes while a check awaits. */
  private gone(): boolean {
    return this.disposed;
  }

  /** A chat hint arrived while a check was running (set by a concurrent `checkChat`). */
  private again(): boolean {
    return this.chatAgain;
  }

  constructor(
    private readonly gate: SoundGate,
    private readonly sources: WatcherSources,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => {
        setTimeout(r, ms);
      }),
  ) {}

  /** The user acted (in this or another tab of the browser) at `at`. */
  noteOwnAction(at: number = this.now()): void {
    this.lastOwnAction = Math.max(this.lastOwnAction, at);
  }

  private inGrace(): boolean {
    return this.now() - this.lastOwnAction < OWN_ACTION_GRACE_MS;
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > SEEN_CAP) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
  }

  async checkNotifications(): Promise<void> {
    let items: readonly SeenNotification[];
    try {
      items = await this.sources.notifications();
    } catch {
      return; // background check: a failure is silent, the next one catches up
    }
    if (this.gone()) return;
    const fresh = items.filter((n) => !this.seen.has(n.id) && n.readAt === null);
    for (const n of items) this.remember(n.id);
    if (!this.notificationsBaseline) {
      this.notificationsBaseline = true;
      return;
    }
    if (fresh.length === 0 || this.inGrace()) return;
    this.gate.request(fresh.some((n) => APPROVAL_KINDS.has(n.kind)) ? 'approvals' : 'notifications');
  }

  async checkChat(): Promise<void> {
    if (this.chatBusy) {
      this.chatAgain = true;
      return;
    }
    this.chatBusy = true;
    try {
      do {
        this.chatAgain = false;
        await this.chatOnce();
      } while (this.again() && !this.gone());
    } finally {
      this.chatBusy = false;
    }
  }

  private async chatOnce(): Promise<void> {
    let total: number;
    try {
      total = await this.sources.chatUnread();
    } catch {
      return;
    }
    if (this.gone()) return;
    const last = this.chatLast;
    if (last === null || total <= last) {
      this.chatLast = total;
      return;
    }
    // Risen: give the tab showing that conversation time to mark it read, then look again.
    await this.sleep(CONFIRM_MS);
    if (this.gone()) return;
    let confirmed: number;
    try {
      confirmed = await this.sources.chatUnread();
    } catch {
      return; // chatLast unchanged: the next check compares again
    }
    if (this.gone()) return;
    this.chatLast = confirmed;
    if (confirmed > last) this.gate.request('chat');
  }

  /**
   * A push arrived (service worker → page). Returns true when this tab takes care of the sound — it plays (or it is
   * merged into a chime) or it is deliberately silent as the echo of the user's own action — so the system
   * notification can be shown without its own sound.
   */
  onPush(info: { readonly id: string | null; readonly kind: string | null }): boolean {
    const category = categoryOfKind(info.kind ?? '');
    const known = info.id !== null && this.seen.has(info.id);
    if (info.id !== null) this.remember(info.id);
    if (!this.gate.audible(category)) return false;
    // Already sounded by a check (or silenced as an echo) / the echo of the user's own action.
    if (known || this.inGrace()) return true;
    const r = this.gate.request(category);
    return r !== 'off';
  }

  dispose(): void {
    this.disposed = true;
    this.gate.dispose();
  }
}
