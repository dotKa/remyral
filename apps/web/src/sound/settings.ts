import { useCallback, useSyncExternalStore } from 'react';
import type { SoundVariant } from './synth';

/**
 * p9-notification-sound (docs/design/p9-notification-sound.md §4): sound settings per user per browser, in
 * localStorage. Volume is a property of the device (laptop speakers vs. a desk set-up), so a browser-local setting is
 * the right home; nothing about it is sensitive or needs to follow the user. Every storage access is wrapped: private
 * windows, blocked site data or a full quota fall back to the defaults (sound on).
 */

export type SoundCategory = 'chat' | 'notifications' | 'approvals';

export const CATEGORY_VARIANT: Readonly<Record<SoundCategory, SoundVariant>> = {
  chat: 'message',
  notifications: 'notification',
  approvals: 'urgent',
};

export interface SoundSettings {
  readonly enabled: boolean;
  /** 0..100. */
  readonly volume: number;
  readonly chat: boolean;
  readonly notifications: boolean;
  readonly approvals: boolean;
  /**
   * p17-toasts-shortcuts: a toast preview when a new notification arrives (the visual side of the same per-browser
   * preferences; independent of the sound switches above).
   */
  readonly previews: boolean;
}

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  enabled: true,
  volume: 60,
  chat: true,
  notifications: true,
  approvals: true,
  previews: true,
};

const PREFIX = 'remyral.sound.v1.';

export function settingsKey(userId: string): string {
  return `${PREFIX}${userId}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): SoundSettings {
  if (raw === null) return DEFAULT_SOUND_SETTINGS;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return DEFAULT_SOUND_SETTINGS;
  }
  if (typeof v !== 'object' || v === null) return DEFAULT_SOUND_SETTINGS;
  const o = v as Record<string, unknown>;
  const flag = (k: keyof SoundSettings): boolean =>
    typeof o[k] === 'boolean' ? o[k] : (DEFAULT_SOUND_SETTINGS[k] as boolean);
  const volume =
    typeof o.volume === 'number' && Number.isFinite(o.volume)
      ? Math.round(Math.min(100, Math.max(0, o.volume)))
      : DEFAULT_SOUND_SETTINGS.volume;
  return {
    enabled: flag('enabled'),
    volume,
    chat: flag('chat'),
    notifications: flag('notifications'),
    approvals: flag('approvals'),
    previews: flag('previews'),
  };
}

// Cache per key so useSyncExternalStore gets a stable snapshot.
const cache = new Map<string, { raw: string | null; value: SoundSettings }>();
const listeners = new Set<() => void>();
// Settings that could not be stored (private mode / quota): kept for this tab until reload.
const memory = new Map<string, string>();

export function readSoundSettings(userId: string): SoundSettings {
  const key = settingsKey(userId);
  let raw: string | null = memory.get(key) ?? null;
  if (raw === null) {
    try {
      raw = storage()?.getItem(key) ?? null;
    } catch {
      raw = null;
    }
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value;
  const value = parse(raw);
  cache.set(key, { raw, value });
  return value;
}

/** Saves a change (best effort) and tells every subscriber in this tab; other tabs get the `storage` event. */
export function writeSoundSettings(userId: string, patch: Partial<SoundSettings>): SoundSettings {
  const next = parse(JSON.stringify({ ...readSoundSettings(userId), ...patch }));
  const raw = JSON.stringify(next);
  const key = settingsKey(userId);
  memory.delete(key);
  try {
    const s = storage();
    if (s) s.setItem(key, raw);
    else memory.set(key, raw);
  } catch {
    memory.set(key, raw);
  }
  for (const l of [...listeners]) l();
  return next;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent): void => {
    if (e.key === null || e.key.startsWith(PREFIX)) fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function useSoundSettings(
  userId: string,
): readonly [SoundSettings, (p: Partial<SoundSettings>) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readSoundSettings(userId),
    () => DEFAULT_SOUND_SETTINGS,
  );
  const update = useCallback(
    (p: Partial<SoundSettings>) => {
      writeSoundSettings(userId, p);
    },
    [userId],
  );
  return [value, update] as const;
}

/** Whether a category may sound under `s`. */
export function categoryOn(s: SoundSettings, c: SoundCategory): boolean {
  return s.enabled && s.volume > 0 && s[c];
}

/** Test seam. */
export function resetSoundSettingsCache(): void {
  cache.clear();
  memory.clear();
}
