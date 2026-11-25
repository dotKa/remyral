import { playChime, type SoundVariant } from './synth';

/**
 * p9-notification-sound (docs/design/p9-notification-sound.md §3): the tab's audio output.
 *
 * Browser autoplay policy: an AudioContext only runs after a user gesture on the page. The context is created (or
 * resumed) inside the first `pointerdown` / `keydown` of this tab; until it runs, `play` is a silent no-op — a sound
 * that cannot be played is skipped, never queued. If the browser later suspends it (iOS interruptions), the next
 * gesture resumes it. A browser without Web Audio never plays anything.
 */

export type AudioContextFactory = () => AudioContext | null;

function browserFactory(): AudioContext | null {
  const Ctor =
    typeof window === 'undefined'
      ? undefined
      : ((window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
          .AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (Ctor === undefined) return null;
  try {
    return new Ctor({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
}

const GESTURES = ['pointerdown', 'keydown'] as const;

export class SoundOutput {
  private ctx: AudioContext | null = null;
  private armed = false;
  private readonly readyListeners = new Set<() => void>();

  constructor(
    private readonly factory: AudioContextFactory = browserFactory,
    private readonly target: EventTarget | null = typeof document === 'undefined' ? null : document,
  ) {}

  /** Whether this browser can play sounds at all. */
  supported(): boolean {
    if (this.ctx) return true;
    if (this.factory !== browserFactory) return true;
    return typeof window !== 'undefined' && ('AudioContext' in window || 'webkitAudioContext' in window);
  }

  /** True once the context runs (after a gesture). */
  ready(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Called when the context starts running. Returns the unsubscribe function. */
  onReady(fn: () => void): () => void {
    this.readyListeners.add(fn);
    return () => {
      this.readyListeners.delete(fn);
    };
  }

  /** Listens for gestures (capture phase, passive) until the context runs. Idempotent. */
  arm(): void {
    if (this.armed || this.target === null) return;
    this.armed = true;
    for (const g of GESTURES)
      this.target.addEventListener(g, this.onGesture, { capture: true, passive: true });
  }

  disarm(): void {
    if (!this.armed || this.target === null) return;
    this.armed = false;
    for (const g of GESTURES) this.target.removeEventListener(g, this.onGesture, { capture: true });
  }

  /** Inside a gesture: create / resume the context. */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = this.factory();
      if (!this.ctx) {
        this.disarm();
        return;
      }
      this.ctx.addEventListener('statechange', this.onState);
    }
    if (this.ctx.state !== 'running') {
      this.ctx.resume().then(this.onState, () => undefined);
    }
    this.onState();
  }

  /** Plays now if the context runs; otherwise skips silently. Returns whether it played. */
  play(variant: SoundVariant, volume: number): boolean {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return false;
    try {
      return playChime(ctx, variant, volume) > 0;
    } catch {
      return false;
    }
  }

  /** "Test sound": called from a click (a gesture), so it may resume the context first. */
  async preview(variant: SoundVariant, volume: number): Promise<boolean> {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return false;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        return false;
      }
    }
    return this.play(variant, volume);
  }

  /** Releases the context (sign-out / tests). */
  close(): void {
    this.disarm();
    const ctx = this.ctx;
    this.ctx = null;
    this.wasRunning = false;
    if (ctx) {
      ctx.removeEventListener('statechange', this.onState);
      void ctx.close().catch(() => undefined);
    }
  }

  private readonly onGesture = (): void => {
    this.unlock();
  };

  private wasRunning = false;

  private readonly onState = (): void => {
    const running = this.ctx?.state === 'running';
    // Only on the transition to running (a gesture on an already running context changes nothing).
    if (running && !this.wasRunning) for (const fn of [...this.readyListeners]) fn();
    this.wasRunning = running;
  };
}

let shared: SoundOutput | null = null;

/** The tab's output (one AudioContext per tab). */
export function soundOutput(): SoundOutput {
  shared ??= new SoundOutput();
  return shared;
}

/** Test seam: forget the shared output. */
export function resetSoundOutput(next: SoundOutput | null = null): void {
  shared?.close();
  shared = next;
}
