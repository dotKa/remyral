import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidate } from '../src/lib/invalidate';
import { announceOwnAction, isOwnAction } from '../src/lib/ownActions';
import { handleWorkerMessage, resetServiceWorkerState, setPushSoundHandler } from '../src/pwa/serviceWorker';
import { memorySoundChannel } from '../src/sound/channel';
import {
  categoryOfKind,
  COALESCE_MS,
  CONFIRM_MS,
  MIN_GAP_MS,
  OWN_ACTION_GRACE_MS,
  type SeenNotification,
  SoundGate,
  SoundWatcher,
} from '../src/sound/controller';
import {
  type LeaderElection,
  LEASE_KEY,
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  storageLeaseElection,
  webLocksElection,
} from '../src/sound/leader';
import { resetSoundOutput, SoundOutput } from '../src/sound/output';
import {
  DEFAULT_SOUND_SETTINGS,
  readSoundSettings,
  resetSoundSettingsCache,
  settingsKey,
  type SoundCategory,
  type SoundSettings,
  writeSoundSettings,
} from '../src/sound/settings';
import { chimeDuration, PATTERNS, PEAK, peakGain, playChime, type SoundVariant } from '../src/sound/synth';
import { ACTIVE_WINDOW_MS, POLL_MS, startNotificationSound } from '../src/sound/useNotificationSound';
import { askClientsForSound, type PortLike, pushSoundInfo } from '../src/sw/logic';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

/**
 * p9-notification-sound (docs/design/p9-notification-sound.md): the synthesised chimes on a fake AudioContext, the
 * gesture unlock, the rules (coalescing, 2 s gap, settings, own actions, chat confirmation), one tab per browser,
 * the hidden-tab window, the push hand-off to the service worker and the settings card.
 */

// ------------------------------------------------------------------------------------- fake Web Audio

class FakeParam {
  value = 0;
  readonly events: [string, number, number][] = [];
  setValueAtTime(v: number, t: number): this {
    this.events.push(['set', v, t]);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.events.push(['ramp', v, t]);
    return this;
  }
}

class FakeNode {
  readonly connections: unknown[] = [];
  disconnected = false;
  connect(d: unknown): unknown {
    this.connections.push(d);
    return d;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeOsc extends FakeNode {
  type = 'sine';
  readonly frequency = new FakeParam();
  onended: (() => void) | null = null;
  startAt = -1;
  stopAt = -1;
  start(t: number): void {
    this.startAt = t;
  }
  stop(t: number): void {
    this.stopAt = t;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeCtx extends EventTarget {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 1;
  readonly destination = new FakeNode();
  readonly oscillators: FakeOsc[] = [];
  readonly gains: FakeGain[] = [];
  chimes = 0;
  /** false: the browser refuses to start the context (no gesture / policy). */
  allowResume = true;
  resume(): Promise<void> {
    if (this.allowResume && this.state !== 'running') {
      this.state = 'running';
      this.dispatchEvent(new Event('statechange'));
    }
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  createOscillator(): FakeOsc {
    const o = new FakeOsc();
    this.oscillators.push(o);
    return o;
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBiquadFilter(): FakeNode & { type: string; frequency: FakeParam; Q: FakeParam } {
    this.chimes++;
    return Object.assign(new FakeNode(), { type: '', frequency: new FakeParam(), Q: new FakeParam() });
  }
  createWaveShaper(): FakeNode & { curve: Float32Array | null } {
    return Object.assign(new FakeNode(), { curve: null as Float32Array | null });
  }
  /** Carrier oscillators of all chimes (the modulators are sine). */
  carriers(): FakeOsc[] {
    return this.oscillators.filter((o) => o.type !== 'sine');
  }
}

const asCtx = (c: FakeCtx): AudioContext => c as unknown as AudioContext;

beforeEach(() => {
  localStorage.clear();
  resetSoundSettingsCache();
});

afterEach(() => {
  vi.useRealTimers();
  resetSoundOutput();
  resetServiceWorkerState();
});

// ------------------------------------------------------------------------------------------- synth

describe('robotic chimes (Web Audio, no files)', () => {
  it('three distinguishable variants of 300–500 ms with click-free envelopes', () => {
    const shapes = new Set<string>();
    for (const v of ['message', 'notification', 'urgent'] as SoundVariant[]) {
      const ctx = new FakeCtx();
      const len = playChime(asCtx(ctx), v, 100);
      expect(len).toBe(chimeDuration(v));
      expect(len).toBeGreaterThanOrEqual(0.3);
      expect(len).toBeLessThanOrEqual(0.5);
      const carriers = ctx.carriers();
      expect(carriers).toHaveLength(PATTERNS[v].beeps.length);
      shapes.add(`${carriers[0]?.type ?? ''}:${carriers.map((o) => o.frequency.events[0]?.[1]).join(',')}`);
      // Every envelope starts at 0 and ends at 0 (soft attack and release).
      const envs = ctx.gains.filter((g) => g.gain.events[0]?.[1] === 0);
      expect(envs).toHaveLength(PATTERNS[v].beeps.length);
      for (const e of envs) {
        expect(e.gain.events[1]?.[0]).toBe('ramp');
        expect(e.gain.events.at(-1)).toEqual(['ramp', 0, expect.any(Number)]);
      }
      // Scheduled from the context's clock, stopped after the chime.
      for (const o of ctx.oscillators) {
        expect(o.startAt).toBeGreaterThanOrEqual(ctx.currentTime);
        expect(o.stopAt).toBeGreaterThan(o.startAt);
      }
    }
    expect(shapes.size).toBe(3);
  });

  it('moderate volume (squared slider), silent at 0, disconnects everything when done', () => {
    expect(peakGain(100, 'notification')).toBeCloseTo(PEAK);
    expect(peakGain(50, 'notification')).toBeCloseTo(PEAK / 4);
    expect(peakGain(250, 'message')).toBeLessThanOrEqual(PEAK);
    expect(peakGain(Number.NaN, 'message')).toBe(0);
    const silent = new FakeCtx();
    expect(playChime(asCtx(silent), 'message', 0)).toBe(0);
    expect(silent.oscillators).toHaveLength(0);
    const ctx = new FakeCtx();
    playChime(asCtx(ctx), 'message', 80);
    for (const o of ctx.oscillators) o.onended?.();
    expect(ctx.oscillators.every((o) => o.disconnected)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------- output

describe('audio output and the autoplay policy', () => {
  it('plays nothing before a gesture; the first pointerdown / keydown creates and resumes the context', () => {
    const created: FakeCtx[] = [];
    const target = new EventTarget();
    const output = new SoundOutput(() => {
      const c = new FakeCtx();
      created.push(c);
      return asCtx(c);
    }, target);
    const ready = vi.fn();
    output.onReady(ready);
    output.arm();
    expect(output.play('message', 60)).toBe(false);
    expect(created).toHaveLength(0);
    target.dispatchEvent(new Event('keydown'));
    expect(created).toHaveLength(1);
    expect(output.ready()).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event('pointerdown'));
    expect(created).toHaveLength(1); // one context per tab
    expect(ready).toHaveBeenCalledTimes(1);
    expect(output.play('message', 60)).toBe(true);
    expect(created[0]?.chimes).toBe(1);
  });

  it('a context the browser keeps suspended skips silently; no Web Audio at all never plays', () => {
    const ctx = new FakeCtx();
    ctx.allowResume = false;
    const target = new EventTarget();
    const output = new SoundOutput(() => asCtx(ctx), target);
    output.arm();
    target.dispatchEvent(new Event('pointerdown'));
    expect(output.ready()).toBe(false);
    expect(output.play('urgent', 100)).toBe(false);
    expect(ctx.chimes).toBe(0);
    const none = new SoundOutput(() => null, target);
    none.arm();
    target.dispatchEvent(new Event('pointerdown'));
    expect(none.play('urgent', 100)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------ settings

describe('settings (per user, per browser)', () => {
  it('defaults to on, persists per user, tolerates garbage and blocked storage', () => {
    expect(readSoundSettings('u1')).toEqual(DEFAULT_SOUND_SETTINGS);
    writeSoundSettings('u1', { volume: 35, chat: false });
    expect(JSON.parse(localStorage.getItem(settingsKey('u1')) ?? '{}')).toMatchObject({
      volume: 35,
      chat: false,
    });
    expect(readSoundSettings('u2')).toEqual(DEFAULT_SOUND_SETTINGS);
    localStorage.setItem(settingsKey('u3'), '{not json');
    expect(readSoundSettings('u3')).toEqual(DEFAULT_SOUND_SETTINGS);
    localStorage.setItem(settingsKey('u4'), JSON.stringify({ enabled: 'yes', volume: 900 }));
    expect(readSoundSettings('u4')).toEqual({ ...DEFAULT_SOUND_SETTINGS, volume: 100 });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => writeSoundSettings('u5', { enabled: false })).not.toThrow();
    expect(readSoundSettings('u5').enabled).toBe(false); // kept for this tab
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readSoundSettings('u6')).toEqual(DEFAULT_SOUND_SETTINGS);
  });
});

// ------------------------------------------------------------------------------------------ the rules

function gateWith(s: Partial<SoundSettings> = {}, ready = true) {
  let settings: SoundSettings = { ...DEFAULT_SOUND_SETTINGS, ...s };
  const played: SoundCategory[] = [];
  const gate = new SoundGate({
    settings: () => settings,
    ready: () => ready,
    play: (c) => {
      if (!ready) return false;
      played.push(c);
      return true;
    },
  });
  return {
    gate,
    played,
    set(p: Partial<SoundSettings>) {
      settings = { ...settings, ...p };
    },
  };
}

describe('when a sound plays (gate)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('coalesces a burst into one chime of its most important category', () => {
    const { gate, played } = gateWith();
    expect(gate.request('chat')).toBe('scheduled');
    expect(gate.request('approvals')).toBe('coalesced');
    expect(gate.request('notifications')).toBe('coalesced');
    vi.advanceTimersByTime(COALESCE_MS);
    expect(played).toEqual(['approvals']);
  });

  it('at most one chime per 2 s; a more important one waits for the end of the gap', () => {
    const { gate, played } = gateWith();
    gate.request('notifications');
    vi.advanceTimersByTime(COALESCE_MS);
    expect(gate.request('notifications')).toBe('dropped');
    expect(gate.request('chat')).toBe('dropped');
    expect(gate.request('approvals')).toBe('scheduled');
    vi.advanceTimersByTime(MIN_GAP_MS - 1 - COALESCE_MS);
    expect(played).toEqual(['notifications']);
    vi.advanceTimersByTime(COALESCE_MS + 1);
    expect(played).toEqual(['notifications', 'approvals']);
    vi.advanceTimersByTime(MIN_GAP_MS);
    gate.request('chat');
    vi.advanceTimersByTime(COALESCE_MS);
    expect(played).toEqual(['notifications', 'approvals', 'chat']);
  });

  it('respects the master switch, the volume and each category', () => {
    const g = gateWith({ enabled: false });
    expect(g.gate.request('approvals')).toBe('off');
    g.set({ enabled: true, chat: false });
    expect(g.gate.request('chat')).toBe('off');
    g.set({ volume: 0 });
    expect(g.gate.request('notifications')).toBe('off');
    g.set({ volume: 50 });
    g.gate.request('notifications');
    g.set({ notifications: false }); // switched off while the chime waited
    vi.advanceTimersByTime(COALESCE_MS);
    expect(g.played).toEqual([]);
  });

  it('a chime that cannot play (no gesture) is skipped, not queued, and does not start the gap', () => {
    const { gate, played } = gateWith({}, false);
    gate.request('notifications');
    vi.advanceTimersByTime(COALESCE_MS * 10);
    expect(played).toEqual([]);
    expect(gate.audible('notifications')).toBe(false);
  });
});

function sources(initial: { notifications?: SeenNotification[]; chat?: number[] } = {}) {
  const state = { notifications: initial.notifications ?? [], chat: initial.chat ?? [0] };
  const calls = { notifications: 0, chat: 0 };
  return {
    state,
    calls,
    notifications: () => {
      calls.notifications++;
      return Promise.resolve(state.notifications);
    },
    chatUnread: () => {
      calls.chat++;
      // Each call takes the next value; the last one repeats.
      const v = state.chat.length > 1 ? state.chat.shift() : state.chat[0];
      return Promise.resolve(v ?? 0);
    },
  };
}

const note = (id: string, kind = 'job.failed', readAt: string | null = null): SeenNotification => ({
  id,
  kind,
  readAt,
});

describe('what is new (watcher)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('notifications: the first look is the baseline; new unread ones sound; approvals use the urgent chime', async () => {
    const { gate, played } = gateWith();
    const src = sources({ notifications: [note('a'), note('b')] });
    const w = new SoundWatcher(gate, src);
    await w.checkNotifications();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(played).toEqual([]);
    src.state.notifications = [note('c', 'job.failed', '2026-10-17T10:00:00Z'), note('a'), note('b')];
    await w.checkNotifications();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(played).toEqual([]); // already read elsewhere
    src.state.notifications = [note('d', 'approval.requested'), note('e'), note('a')];
    await w.checkNotifications();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(played).toEqual(['approvals']);
    expect(categoryOfKind('deploy.waiting')).toBe('approvals');
    expect(categoryOfKind('automation.waiting')).toBe('approvals');
    expect(categoryOfKind('monitor.down')).toBe('notifications');
  });

  it('never for the user’s own action: notifications right after a mutation stay silent', async () => {
    const { gate, played } = gateWith();
    const src = sources({ notifications: [] });
    const w = new SoundWatcher(gate, src);
    await w.checkNotifications();
    w.noteOwnAction();
    src.state.notifications = [note('mine', 'job.waiting')];
    await w.checkNotifications();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(played).toEqual([]);
    vi.advanceTimersByTime(OWN_ACTION_GRACE_MS);
    src.state.notifications = [note('later', 'deploy.failed'), note('mine', 'job.waiting')];
    await w.checkNotifications();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(played).toEqual(['notifications']);
    expect(isOwnAction('POST', '/jobs')).toBe(true);
    expect(isOwnAction('GET', '/jobs')).toBe(false);
    expect(isOwnAction('POST', '/chat/threads/x/read')).toBe(false);
    expect(isOwnAction('POST', '/notifications/push/test')).toBe(false);
    expect(isOwnAction('POST', '/auth/step-up')).toBe(false);
  });

  it('chat: a rise that is still there after the confirmation sounds; a conversation read meanwhile does not', async () => {
    const { gate, played } = gateWith();
    // baseline 2 → rises to 3 → after the pause it was marked read (2): silent.
    const src = sources({ chat: [2, 3, 2] });
    const w = new SoundWatcher(gate, src);
    await w.checkChat();
    const p = w.checkChat();
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    await p;
    vi.advanceTimersByTime(COALESCE_MS);
    expect(played).toEqual([]);
    // 2 → 4 and still 4: one chime.
    src.state.chat = [4, 4];
    const q = w.checkChat();
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    await q;
    vi.advanceTimersByTime(COALESCE_MS);
    expect(played).toEqual(['chat']);
    // Falling (read elsewhere) is never a sound.
    src.state.chat = [1];
    await w.checkChat();
    vi.advanceTimersByTime(COALESCE_MS + MIN_GAP_MS);
    expect(played).toEqual(['chat']);
  });

  it('push: handled when audible, not again when the next check sees it, unhandled when muted', async () => {
    const g = gateWith();
    const { gate, played } = g;
    const src = sources({ notifications: [] });
    const w = new SoundWatcher(gate, src);
    await w.checkNotifications();
    expect(w.onPush({ id: 'p1', kind: 'approval.requested' })).toBe(true);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(played).toEqual(['approvals']);
    src.state.notifications = [note('p1', 'approval.requested')];
    await w.checkNotifications();
    vi.advanceTimersByTime(COALESCE_MS + MIN_GAP_MS);
    expect(played).toEqual(['approvals']);
    g.set({ notifications: false });
    expect(w.onPush({ id: 'p2', kind: 'job.failed' })).toBe(false);
  });
});

// ----------------------------------------------------------------------------------- one tab plays

describe('leader election (one tab per browser)', () => {
  it('localStorage lease: one leader; the other takes over when it stops or its lease expires', () => {
    vi.useFakeTimers();
    let t = 1_000_000;
    const now = () => t;
    const a = vi.fn();
    const b = vi.fn();
    const stopA = storageLeaseElection(localStorage, 'tab-a', now).start(a);
    const stopB = storageLeaseElection(localStorage, 'tab-b', now).start(b);
    expect(a).toHaveBeenLastCalledWith(true);
    expect(b).not.toHaveBeenCalled();
    t += LEASE_RENEW_MS;
    vi.advanceTimersByTime(LEASE_RENEW_MS);
    expect(b).not.toHaveBeenCalled();
    stopA();
    expect(a).toHaveBeenLastCalledWith(false);
    expect(localStorage.getItem(LEASE_KEY)).toBeNull();
    t += LEASE_RENEW_MS;
    vi.advanceTimersByTime(LEASE_RENEW_MS);
    expect(b).toHaveBeenLastCalledWith(true);
    stopB();
    // A crashed leader (no clean stop) loses the lease after the TTL.
    localStorage.setItem(LEASE_KEY, JSON.stringify({ tab: 'gone', until: t + LEASE_TTL_MS }));
    const c = vi.fn();
    const stopC = storageLeaseElection(localStorage, 'tab-c', now).start(c);
    expect(c).not.toHaveBeenCalled();
    t += LEASE_TTL_MS + 1;
    vi.advanceTimersByTime(LEASE_RENEW_MS);
    expect(c).toHaveBeenLastCalledWith(true);
    stopC();
  });

  it('Web Locks: the lock holder leads; stopping hands the lock to the next tab', async () => {
    // A minimal exclusive lock manager.
    const queue: { cb: () => Promise<void>; signal: AbortSignal; reject: (e: unknown) => void }[] = [];
    let held = false;
    const pump = (): void => {
      if (held) return;
      const next = queue.shift();
      if (!next) return;
      held = true;
      void next.cb().then(() => {
        held = false;
        pump();
      });
    };
    const locks = {
      request(_name: string, o: { signal: AbortSignal }, cb: () => Promise<void>): Promise<unknown> {
        return new Promise((resolve, reject) => {
          const entry = { cb: () => cb().then(resolve), signal: o.signal, reject };
          o.signal.addEventListener('abort', () => {
            const i = queue.indexOf(entry);
            if (i >= 0) queue.splice(i, 1);
            reject(new DOMException('aborted', 'AbortError'));
          });
          queue.push(entry);
          pump();
        });
      },
    };
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const stopA = webLocksElection(locks).start(a);
    const stopB = webLocksElection(locks).start(b);
    const stopC = webLocksElection(locks).start(c);
    expect(a).toHaveBeenCalledWith(true);
    expect(b).not.toHaveBeenCalled();
    stopC(); // gave up while waiting
    stopA();
    expect(a).toHaveBeenLastCalledWith(false);
    await waitFor(() => {
      expect(b).toHaveBeenCalledWith(true);
    });
    expect(c).not.toHaveBeenCalled();
    stopB();
  });
});

// ------------------------------------------------------------------------- the tab wiring (two tabs)

function sharedElection(): { tab(): LeaderElection } {
  let leader: ((v: boolean) => void) | null = null;
  const waiting: ((v: boolean) => void)[] = [];
  return {
    tab() {
      return {
        start(onChange) {
          if (leader === null) {
            leader = onChange;
            onChange(true);
          } else waiting.push(onChange);
          return () => {
            if (leader === onChange) {
              leader = null;
              onChange(false);
              const next = waiting.shift();
              if (next) {
                leader = next;
                next(true);
              }
            } else waiting.splice(waiting.indexOf(onChange), 1);
          };
        },
      };
    },
  };
}

describe('the console tabs together', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function tab(
    election: { tab(): LeaderElection },
    channel: ReturnType<typeof memorySoundChannel>,
    src: ReturnType<typeof sources>,
    target: EventTarget,
  ) {
    const ctx = new FakeCtx();
    const output = new SoundOutput(() => asCtx(ctx), target);
    const stop = startNotificationSound(USER.id, {
      output,
      election: election.tab(),
      channel: channel.tab(),
      notifications: src.notifications,
      chatUnread: src.chatUnread,
    });
    return { ctx, output, stop, gesture: () => target.dispatchEvent(new Event('pointerdown')) };
  }

  it('no gesture → no leader, no checks, no sound; after a gesture only the leader tab plays', async () => {
    const election = sharedElection();
    const channel = memorySoundChannel();
    const src = sources({ notifications: [note('old')] });
    const t1 = tab(election, channel, src, new EventTarget());
    const t2 = tab(election, channel, src, new EventTarget());
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(src.calls.notifications).toBe(0);
    t1.gesture();
    t2.gesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(src.calls.notifications).toBe(1); // the leader's baseline
    src.state.notifications = [note('new', 'approval.requested'), note('old')];
    await vi.advanceTimersByTimeAsync(POLL_MS + COALESCE_MS);
    expect(t1.ctx.chimes).toBe(1);
    expect(t2.ctx.chimes).toBe(0);
    expect(t1.ctx.carriers()[0]?.type).toBe('sawtooth'); // urgent
    // The leader closes: the other tab takes over with a fresh baseline (no replay).
    t1.stop();
    await vi.advanceTimersByTimeAsync(POLL_MS + COALESCE_MS);
    expect(t2.ctx.chimes).toBe(0);
    src.state.notifications = [note('newer'), note('new', 'approval.requested'), note('old')];
    await vi.advanceTimersByTimeAsync(POLL_MS + COALESCE_MS);
    expect(t2.ctx.chimes).toBe(1);
    t2.stop();
  });

  it('a chat change seen in another tab makes the leader look now; own actions from any tab silence echoes', async () => {
    const election = sharedElection();
    const channel = memorySoundChannel();
    const src = sources({ notifications: [], chat: [0] });
    const leaderTarget = new EventTarget();
    const t1 = tab(election, channel, src, leaderTarget);
    t1.gesture();
    await vi.advanceTimersByTimeAsync(0);
    const before = src.calls.chat;
    // Another tab (the channel) reports a chat change.
    src.state.chat = [1, 1];
    channel.tab().post('chat');
    await vi.advanceTimersByTimeAsync(CONFIRM_MS + COALESCE_MS);
    expect(src.calls.chat).toBeGreaterThan(before);
    expect(t1.ctx.chimes).toBe(1);
    expect(t1.ctx.carriers()[0]?.frequency.events[0]?.[1]).toBe(PATTERNS.message.beeps[0]?.freq);
    // invalidate('chat') in the leader's own document works too (2 → after the gap).
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS);
    src.state.chat = [2, 2];
    act(() => {
      invalidate('chat');
    });
    await vi.advanceTimersByTimeAsync(CONFIRM_MS + COALESCE_MS);
    expect(t1.ctx.chimes).toBe(2);
    // The user acts (a mutation from this document): the notification that follows is silent.
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS);
    announceOwnAction('POST', '/jobs');
    await vi.advanceTimersByTimeAsync(1_000);
    src.state.notifications = [note('echo', 'approval.requested')];
    await vi.advanceTimersByTimeAsync(POLL_MS + COALESCE_MS);
    expect(t1.ctx.chimes).toBe(2);
    // Something new later is not an echo.
    src.state.notifications = [note('other', 'monitor.down'), note('echo', 'approval.requested')];
    await vi.advanceTimersByTimeAsync(POLL_MS + COALESCE_MS);
    expect(t1.ctx.chimes).toBe(3);
    t1.stop();
  });

  it('hidden tab: still plays while the user was recently active, stops checking after the active window', async () => {
    const election = sharedElection();
    const channel = memorySoundChannel();
    const src = sources({ notifications: [] });
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const t1 = tab(election, channel, src, new EventTarget());
    t1.gesture();
    await vi.advanceTimersByTimeAsync(0);
    src.state.notifications = [note('n1')];
    await vi.advanceTimersByTimeAsync(POLL_MS + COALESCE_MS);
    expect(t1.ctx.chimes).toBe(1); // hidden, but the point of a sound
    await vi.advanceTimersByTimeAsync(ACTIVE_WINDOW_MS);
    const calls = src.calls.notifications;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(src.calls.notifications).toBe(calls); // idle: no hidden-tab requests (sessions may expire)
    // Activity in another tab of the browser revives it.
    channel.tab().post('activity');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(src.calls.notifications).toBeGreaterThan(calls);
    vis.mockRestore();
    t1.stop();
  });

  it('answers the service worker: the leader plays a push, other tabs and muted settings leave the system sound', async () => {
    const election = sharedElection();
    const channel = memorySoundChannel();
    const src = sources({ notifications: [] });
    const t1 = tab(election, channel, src, new EventTarget());
    t1.gesture();
    await vi.advanceTimersByTimeAsync(0);
    const replies: unknown[] = [];
    const port = { postMessage: (m: unknown) => replies.push(m), close: () => undefined };
    handleWorkerMessage({ type: 'remyral:push', id: 'p-1', kind: 'deploy.waiting' }, window, [
      port as unknown as MessagePort,
    ]);
    expect(replies).toEqual([{ handled: true }]);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(t1.ctx.chimes).toBe(1);
    writeSoundSettings(USER.id, { approvals: false });
    handleWorkerMessage({ type: 'remyral:push', id: 'p-2', kind: 'approval.requested' }, window, [
      port as unknown as MessagePort,
    ]);
    expect(replies.at(-1)).toEqual({ handled: false });
    t1.stop();
    // Stopped (signed out): no handler, the system sound stays.
    handleWorkerMessage({ type: 'remyral:push', id: 'p-3', kind: 'job.failed' }, window, [
      port as unknown as MessagePort,
    ]);
    expect(replies.at(-1)).toEqual({ handled: false });
    setPushSoundHandler(() => {
      throw new Error('boom');
    });
    handleWorkerMessage({ type: 'remyral:push' }, window, [port as unknown as MessagePort]);
    expect(replies.at(-1)).toEqual({ handled: false });
  });
});

// ------------------------------------------------------------------------------- service worker side

class FakePort implements PortLike {
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
  }
}

describe('service worker: silent system notification when a tab plays the sound', () => {
  it('reads only a validated id and kind from the push payload', () => {
    expect(pushSoundInfo(JSON.stringify({ v: 1, id: 'abc-1', kind: 'approval.requested' }))).toEqual({
      id: 'abc-1',
      kind: 'approval.requested',
    });
    expect(pushSoundInfo(JSON.stringify({ v: 1, id: '<script>', kind: 'X Y' }))).toEqual({
      id: null,
      kind: null,
    });
    expect(pushSoundInfo(JSON.stringify({ v: 2, id: 'a', kind: 'b' }))).toEqual({ id: null, kind: null });
    expect(pushSoundInfo('nope')).toEqual({ id: null, kind: null });
    expect(pushSoundInfo(null)).toEqual({ id: null, kind: null });
  });

  it('resolves true on the first yes, false when all say no, false on timeout or without windows', async () => {
    vi.useFakeTimers();
    const msg = { type: 'remyral:push', id: 'a', kind: 'job.failed' };
    const make = (answer: boolean | null) => {
      const ports: FakePort[] = [];
      const client = {
        postMessage: (m: unknown, transfer: unknown[]) => {
          expect(m).toEqual(msg);
          expect(transfer).toHaveLength(1);
          const p = ports.at(-1);
          if (answer !== null && p) queueMicrotask(() => p.onmessage?.({ data: { handled: answer } }));
        },
      };
      const channel = () => {
        const p = new FakePort();
        ports.push(p);
        return { port1: p, port2: {} };
      };
      return { client, channel, ports };
    };
    const yes = make(true);
    const no = make(false);
    // Two windows: one says no, one says yes.
    const sharedPorts: FakePort[] = [];
    const both = askClientsForSound(
      [
        {
          postMessage: (m, t) => {
            no.client.postMessage(m, t);
          },
        },
        {
          postMessage: (m, t) => {
            yes.client.postMessage(m, t);
          },
        },
      ],
      msg,
      () => {
        const c = sharedPorts.length === 0 ? no.channel() : yes.channel();
        sharedPorts.push(c.port1);
        return c;
      },
    );
    await expect(both).resolves.toBe(true);
    expect(sharedPorts.every((p) => p.closed)).toBe(true);
    const allNo = make(false);
    await expect(askClientsForSound([allNo.client], msg, allNo.channel)).resolves.toBe(false);
    const silent = make(null);
    const late = askClientsForSound([silent.client], msg, silent.channel, 400);
    await vi.advanceTimersByTimeAsync(400);
    await expect(late).resolves.toBe(false);
    await expect(askClientsForSound([], msg, silent.channel)).resolves.toBe(false);
  });
});

// ------------------------------------------------------------------------------------ settings card
// p15-classic-removal: the classic sound card test, on the Diyalog Ayarlar → Bildirimler page (same settings store).
describe('Ayarlar → Bildirimler → Ses', () => {
  const routes: Record<string, Handler> = {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/notifications/preferences': () => ({
      status: 200,
      body: {
        kinds: [],
        channels: {
          email: { available: false, address: null },
          webhook: { available: false, url: null },
        },
      },
    }),
  };
  const signedIn = { kind: 'signedIn' as const, user: USER, session: null, remainingRecoveryCodes: null };

  it('toggles, volume and categories apply at once; "Sesi dene" plays at the chosen volume', async () => {
    const ctx = new FakeCtx();
    resetSoundOutput(new SoundOutput(() => asCtx(ctx)));
    const user = userEvent.setup();
    renderApp({ path: '/settings/notifications', initialState: signedIn, routes });
    await screen.findByTestId('dy-sound');
    const volume = screen.getByLabelText<HTMLInputElement>('Ses düzeyi');
    expect(volume.value).toBe('60');
    fireEvent.change(volume, { target: { value: '30' } });
    expect(readSoundSettings(USER.id).volume).toBe(30);
    await user.click(screen.getByRole('checkbox', { name: 'Sohbet mesajları' }));
    expect(readSoundSettings(USER.id).chat).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Sesi dene' }));
    await waitFor(() => {
      expect(ctx.chimes).toBe(1);
    });
    expect(ctx.gains[0]?.gain.events[0]?.[1]).toBeCloseTo(peakGain(30, 'notification'));
    await user.click(screen.getByRole('button', { name: 'Onaylar sesini çal' }));
    await waitFor(() => {
      expect(ctx.chimes).toBe(2);
    });
    await user.click(screen.getByRole('checkbox', { name: 'Ses çal' }));
    expect(readSoundSettings(USER.id).enabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sesi dene' }).disabled).toBe(true);
  });

  it('says so when the browser has no Web Audio', async () => {
    // jsdom has no AudioContext: the browser default output.
    resetSoundOutput();
    renderApp({ path: '/settings/notifications', initialState: signedIn, routes });
    expect(await screen.findByText('Bu tarayıcı ses çalamıyor (Web Audio yok).')).toBeTruthy();
  });
});
