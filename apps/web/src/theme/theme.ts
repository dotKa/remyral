import { useCallback, useEffect, useState } from 'react';
import { apiRequest, obj, type RequestOptions } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

/**
 * p17-remyral-brand (docs/design/p17-remyral-rebrand.md, "Light / dark switch"): Açık / Koyu / Sistem.
 *
 * - The account's choice lives on the master (`users.theme`, `PUT /me/theme`, `GET /auth/session` → `theme`).
 * - This browser keeps a copy in localStorage (`remyral.theme`, every access in try/catch) so `public/theme-boot.js`
 *   can mark `<html data-theme>` before the first paint — also on the sign-in and setup screens.
 * - "system" removes the mark: prefers-color-scheme applies (the token blocks in diyalog.css / index.css).
 */
export const THEME_CHOICES = ['light', 'dark', 'system'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export const THEME_STORAGE_KEY = 'remyral.theme';
/** Tells every mounted switch (account menu, Profil) that the choice changed. */
const THEME_EVENT = 'remyral:theme';

export const isThemeChoice = (v: unknown): v is ThemeChoice =>
  typeof v === 'string' && (THEME_CHOICES as readonly string[]).includes(v);

export function readStoredTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function storeTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* the mark on <html> still applies for this page */
  }
}

/** Marks `<html>` (light / dark) or clears the mark (system) and keeps this browser's copy. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  storeTheme(choice);
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: choice }));
}

export function setMyTheme(
  theme: ThemeChoice,
  opts: Omit<RequestOptions, 'body'> = {},
): Promise<{ theme: ThemeChoice; changed: boolean }> {
  return apiRequest(
    'PUT',
    '/me/theme',
    (v) => {
      const o = obj(v);
      if (!isThemeChoice(o.theme) || typeof o.changed !== 'boolean') throw new Error('unexpected body');
      return { theme: o.theme, changed: o.changed };
    },
    { ...opts, body: { theme } },
  );
}

/**
 * The current choice and a setter: applies at once (every open screen, this tab), then saves it for the account when
 * signed in. A failed save keeps the local choice and reports the error.
 */
export function useThemeChoice(): {
  readonly choice: ThemeChoice;
  readonly busy: boolean;
  readonly error: unknown;
  choose(c: ThemeChoice): Promise<void>;
} {
  const { state, actions } = useAuth();
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredTheme());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const on = (e: Event): void => {
      const d = (e as CustomEvent<unknown>).detail;
      if (isThemeChoice(d)) setChoice(d);
    };
    window.addEventListener(THEME_EVENT, on);
    return () => {
      window.removeEventListener(THEME_EVENT, on);
    };
  }, []);
  const signedIn = state.kind === 'signedIn';
  const choose = useCallback(
    async (c: ThemeChoice) => {
      applyTheme(c);
      setError(null);
      if (!signedIn) return;
      setBusy(true);
      try {
        await setMyTheme(c);
        await actions.refreshSession().catch(() => undefined);
      } catch (err) {
        setError(err);
      } finally {
        setBusy(false);
      }
    },
    [signedIn, actions],
  );
  return { choice, busy, error, choose };
}

/**
 * Follows the account: when the session carries a theme that differs from this browser's copy (chosen on another
 * device), it is applied and stored. An older master sends none: the local choice stays.
 */
export function ThemeSync(): null {
  const { state } = useAuth();
  const theme = state.kind === 'signedIn' ? state.session?.theme : undefined;
  useEffect(() => {
    if (theme !== undefined && theme !== readStoredTheme()) applyTheme(theme);
  }, [theme]);
  return null;
}
