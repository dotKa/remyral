import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as realApi from '../api/auth';
import {
  type EnrollmentSetup,
  type SessionInfo,
  STEP_UP_SESSION_ENDED,
  stepUpFailureMessage,
  stepUpFailureOf,
  type User,
} from '../api/auth';
import { ApiError, SESSION_REFRESHED, SESSION_REFRESHED_MESSAGE } from '../api/client';
import { forgetRemembered } from '../lib/remembered';
import { disablePush } from '../pwa/push';
import { type AuthChannel, type AuthSignal, browserAuthChannel } from './authChannel';

/**
 * p8-pwa: logging out also turns push off on this browser (the master forgets it, the browser drops it),
 * so a shared or handed-over device stops receiving the account's notifications. Best effort, bounded.
 */
async function dropPushHere(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    disablePush('logout').catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 3000);
    }),
  ]);
  clearTimeout(timer);
}

export type AuthApi = Pick<
  typeof realApi,
  | 'login'
  | 'verifyTotp'
  | 'loginWithRecoveryCode'
  | 'startEnrollment'
  | 'confirmEnrollment'
  | 'stepUp'
  | 'completePasswordChange'
  | 'changePassword'
  | 'logout'
  | 'logoutAll'
  | 'getSession'
>;

/**
 * Client-side view of the master's session stages (ADR-0009). The server is authoritative: this state only
 * selects the screen. Nothing here is persisted (no localStorage/sessionStorage); a reload re-derives it
 * from `GET /auth/session`, and a reload during a pending login returns to the login form.
 */
export type AuthState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'signedOut'; readonly notice: string | null }
  | { readonly kind: 'secondFactor'; readonly method: 'totp' | 'recovery' }
  | {
      readonly kind: 'enrollment';
      readonly setup: EnrollmentSetup | null;
      readonly setupError: ApiError | null;
    }
  | {
      readonly kind: 'recoveryCodes';
      readonly user: User;
      readonly codes: readonly string[];
      /** A temporary password must be replaced after the codes were stored (p5-self-password). */
      readonly passwordChangeRequired: boolean;
    }
  | {
      /** Both factors passed, but the account still holds a temporary password: replace it first. */
      readonly kind: 'passwordChange';
      readonly user: User;
      readonly remainingRecoveryCodes: number | null;
    }
  | {
      readonly kind: 'signedIn';
      readonly user: User;
      readonly session: SessionInfo | null;
      readonly remainingRecoveryCodes: number | null;
    };

export interface AuthActions {
  /** `remember`: "Remember me" (p5-remember-device). A trusted device may sign in without a code. */
  login(username: string, password: string, remember?: boolean): Promise<void>;
  /** `trustDevice`: "Trust this device" — the next sign-in from this browser skips the code step. */
  verifyTotp(code: string, trustDevice?: boolean): Promise<void>;
  loginWithRecoveryCode(code: string, trustDevice?: boolean): Promise<void>;
  chooseMethod(method: 'totp' | 'recovery'): void;
  retryEnrollment(): Promise<void>;
  confirmEnrollment(code: string): Promise<void>;
  acknowledgeRecoveryCodes(): void;
  /** Replaces a temporary password (passwordChange state) and continues to the console. */
  completePasswordChange(newPassword: string): Promise<void>;
  /** Self-service change from Settings; wrap in `useStepUp().run` (403 step_up_required). */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  refreshSession(): Promise<void>;
  stepUp(code: string): Promise<string>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  /** Back to the login form (abandons a pending login; the server expires it after 5 minutes). */
  restart(notice?: string | null): void;
}

interface AuthContextValue {
  readonly state: AuthState;
  readonly actions: AuthActions;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Shown after the server ended a pending login (expired, or too many wrong codes). */
export const PENDING_LOGIN_ENDED = 'Your sign-in attempt has ended. Sign in again.';
export const SESSION_ENDED = 'Your session has ended. Sign in again.';

/** A 401 that is not the generic factor failure means the session (pending or full) is gone. */
export function isSessionGone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && err.code !== 'invalid_credentials';
}

/** A step-up this recent (mfa_at) was most likely this very confirmation, sent twice or from another tab. */
const JUST_STEPPED_UP_MS = 60_000;

/** The default cross-tab channel, created once per page. */
let sharedChannel: AuthChannel | null | undefined;
function defaultChannel(): AuthChannel | null {
  if (sharedChannel === undefined) sharedChannel = browserAuthChannel();
  return sharedChannel;
}

export function AuthProvider(props: {
  readonly children: ReactNode;
  readonly api?: AuthApi;
  readonly initialState?: AuthState;
  /** p9-stepup-rotation-logout: cross-tab hints (default: BroadcastChannel; `null` disables). */
  readonly channel?: AuthChannel | null;
}): ReactNode {
  const api = props.api ?? realApi;
  const channel = props.channel === undefined ? defaultChannel() : props.channel;
  const [state, setState] = useState<AuthState>(props.initialState ?? { kind: 'checking' });
  const enrollInFlight = useRef<Promise<void> | null>(null);
  // Latest state for actions that continue a step (kept out of the actions' dependencies so their identity
  // stays stable across state changes).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  // p14-web-perf: the screens' remembered data (lib/remembered.ts) belongs to one signed-in user; a sign-out or a
  // different user drops it before anything renders with it. A ref, so the first sign-in of the tab drops nothing.
  const signedInAs = state.kind === 'signedIn' ? state.user.id : null;
  const rememberedFor = useRef(signedInAs);
  if (rememberedFor.current !== signedInAs) {
    rememberedFor.current = signedInAs;
    forgetRemembered();
  }

  const endPending = useCallback((err: unknown): never => {
    if (isSessionGone(err)) setState({ kind: 'signedOut', notice: PENDING_LOGIN_ENDED });
    throw err;
  }, []);

  const signal = useCallback(
    (s: AuthSignal) => {
      channel?.post(s);
    },
    [channel],
  );

  /**
   * p9-stepup-rotation-logout: a 401 from a full-session call does not prove the session is gone — the
   * request may have left with an id a step-up (this tab, another tab, a double submit) had just rotated
   * away, while the browser already holds the new cookie. Ask the master once with the current cookie:
   * only a second "no session" signs out. Resolves with the live session, else throws.
   */
  const recheck = useCallback(
    async (err: unknown): Promise<SessionInfo> => {
      if (!isSessionGone(err)) throw err;
      let session: SessionInfo;
      try {
        session = await api.getSession();
      } catch (again) {
        if (isSessionGone(again)) setState({ kind: 'signedOut', notice: SESSION_ENDED });
        throw err;
      }
      setState((prev) => ({
        kind: 'signedIn',
        user: session.user,
        session,
        remainingRecoveryCodes: prev.kind === 'signedIn' ? prev.remainingRecoveryCodes : null,
      }));
      return session;
    },
    [api],
  );

  /** A failed full-session mutation: sign out only if the re-check agrees; else a retryable error. */
  const endFull = useCallback(
    async (err: unknown): Promise<never> => {
      await recheck(err);
      throw new ApiError(409, SESSION_REFRESHED, SESSION_REFRESHED_MESSAGE);
    },
    [recheck],
  );

  const loadSession = useCallback(
    async (extra: { remainingRecoveryCodes?: number | null } = {}) => {
      const session = await api.getSession();
      setState((prev) => ({
        kind: 'signedIn',
        user: session.user,
        session,
        remainingRecoveryCodes:
          extra.remainingRecoveryCodes ?? (prev.kind === 'signedIn' ? prev.remainingRecoveryCodes : null),
      }));
    },
    [api],
  );

  // Initial check: does the browser already hold a full session?
  useEffect(() => {
    if (props.initialState) return;
    let cancelled = false;
    api.getSession().then(
      (session) => {
        if (!cancelled)
          setState({ kind: 'signedIn', user: session.user, session, remainingRecoveryCodes: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        // 401 is the normal "not signed in"; anything else is surfaced on the login form.
        const notice = err instanceof ApiError && err.status !== 401 ? err.message : null;
        setState({ kind: 'signedOut', notice });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, props.initialState]);

  // p9-stepup-rotation-logout: another tab stepped up, signed in or signed out — re-read the session from
  // the master (the message itself is only a hint and carries nothing).
  useEffect(() => {
    if (!channel) return;
    return channel.subscribe((s) => {
      const kind = stateRef.current.kind;
      if (s === 'session-changed' && (kind === 'signedIn' || kind === 'signedOut')) {
        api.getSession().then(
          (session) => {
            setState((prev) => ({
              kind: 'signedIn',
              user: session.user,
              session,
              remainingRecoveryCodes: prev.kind === 'signedIn' ? prev.remainingRecoveryCodes : null,
            }));
          },
          () => undefined,
        );
      } else if (s === 'signed-out' && kind === 'signedIn') {
        api.getSession().then(
          () => undefined,
          (err: unknown) => {
            if (isSessionGone(err) && stateRef.current.kind === 'signedIn')
              setState({ kind: 'signedOut', notice: 'You are signed out.' });
          },
        );
      }
    });
  }, [channel, api]);

  const startEnrollment = useCallback((): Promise<void> => {
    // One request at a time: each call generates a new server-side secret, so a duplicate request (double
    // click, StrictMode) must never race the QR code the user is scanning.
    if (enrollInFlight.current) return enrollInFlight.current;
    setState({ kind: 'enrollment', setup: null, setupError: null });
    const p = api
      .startEnrollment()
      .then(
        (setup) => {
          setState({ kind: 'enrollment', setup, setupError: null });
        },
        (err: unknown) => {
          if (isSessionGone(err)) {
            setState({ kind: 'signedOut', notice: PENDING_LOGIN_ENDED });
            return;
          }
          setState({
            kind: 'enrollment',
            setup: null,
            setupError: err instanceof ApiError ? err : new ApiError(0, 'unknown', 'Enrollment failed.'),
          });
        },
      )
      .finally(() => {
        enrollInFlight.current = null;
      });
    enrollInFlight.current = p;
    return p;
  }, [api]);

  const actions = useMemo<AuthActions>(
    () => ({
      async login(username, password, remember = false) {
        const outcome = await api.login(username, password, remember);
        if (outcome.status === 'authenticated') {
          // Trusted device: the code step was skipped (privileged actions still ask for a code).
          setState({ kind: 'signedIn', user: outcome.user, session: null, remainingRecoveryCodes: null });
          signal('session-changed');
          await loadSession().catch(() => undefined);
        } else if (outcome.status === 'mfa_required') setState({ kind: 'secondFactor', method: 'totp' });
        else await startEnrollment();
      },
      async verifyTotp(code, trustDevice = false) {
        const r = await api.verifyTotp(code, trustDevice).catch(endPending);
        if (r.passwordChangeRequired) {
          setState({ kind: 'passwordChange', user: r.user, remainingRecoveryCodes: null });
          return;
        }
        setState({ kind: 'signedIn', user: r.user, session: null, remainingRecoveryCodes: null });
        signal('session-changed');
        await loadSession().catch(() => undefined);
      },
      async loginWithRecoveryCode(code, trustDevice = false) {
        const r = await api.loginWithRecoveryCode(code, trustDevice).catch(endPending);
        if (r.passwordChangeRequired) {
          setState({
            kind: 'passwordChange',
            user: r.user,
            remainingRecoveryCodes: r.remainingRecoveryCodes,
          });
          return;
        }
        setState({
          kind: 'signedIn',
          user: r.user,
          session: null,
          remainingRecoveryCodes: r.remainingRecoveryCodes,
        });
        await loadSession({ remainingRecoveryCodes: r.remainingRecoveryCodes }).catch(() => undefined);
      },
      chooseMethod(method) {
        setState((prev) => (prev.kind === 'secondFactor' ? { kind: 'secondFactor', method } : prev));
      },
      retryEnrollment: startEnrollment,
      async confirmEnrollment(code) {
        const r = await api.confirmEnrollment(code).catch(endPending);
        setState({
          kind: 'recoveryCodes',
          user: r.user,
          codes: r.recoveryCodes,
          passwordChangeRequired: r.passwordChangeRequired,
        });
      },
      acknowledgeRecoveryCodes() {
        const state = stateRef.current;
        if (state.kind !== 'recoveryCodes') return;
        if (state.passwordChangeRequired) {
          setState({ kind: 'passwordChange', user: state.user, remainingRecoveryCodes: state.codes.length });
          return;
        }
        setState({
          kind: 'signedIn',
          user: state.user,
          session: null,
          remainingRecoveryCodes: state.codes.length,
        });
        void loadSession().catch(() => undefined);
      },
      async completePasswordChange(newPassword) {
        const u = await api.completePasswordChange(newPassword).catch(endPending);
        const prev = stateRef.current;
        const remaining = prev.kind === 'passwordChange' ? prev.remainingRecoveryCodes : null;
        setState({ kind: 'signedIn', user: u, session: null, remainingRecoveryCodes: remaining });
        await loadSession({ remainingRecoveryCodes: remaining }).catch(() => undefined);
      },
      async changePassword(currentPassword, newPassword) {
        await api.changePassword(currentPassword, newPassword).catch(endFull);
        await loadSession().catch(() => undefined);
      },
      async refreshSession() {
        try {
          await loadSession();
        } catch (err) {
          await recheck(err);
        }
      },
      async stepUp(code) {
        let r: Awaited<ReturnType<AuthApi['stepUp']>>;
        try {
          r = await api.stepUp(code);
        } catch (err) {
          const failure = stepUpFailureOf(err);
          if (failure?.sessionTerminated) {
            setState({ kind: 'signedOut', notice: STEP_UP_SESSION_ENDED });
            throw new ApiError(401, 'invalid_credentials', STEP_UP_SESSION_ENDED);
          }
          if (failure) throw new ApiError(401, 'invalid_credentials', stepUpFailureMessage(failure));
          // p9-stepup-rotation-logout: a double submit, or another tab confirmed first — the request left
          // with the rotated-away id. If the live session was stepped up just now, this confirmation is done.
          const session = await recheck(err);
          const mfaAt = session.mfaAt === null ? Number.NaN : Date.parse(session.mfaAt);
          if (session.stepUpValidUntil !== null && Date.now() - mfaAt <= JUST_STEPPED_UP_MS) {
            signal('session-changed');
            return session.stepUpValidUntil;
          }
          throw new ApiError(409, SESSION_REFRESHED, SESSION_REFRESHED_MESSAGE);
        }
        signal('session-changed');
        await loadSession().catch(() => undefined);
        return r.stepUpValidUntil;
      },
      async logout() {
        await dropPushHere();
        try {
          await api.logout();
        } catch (err) {
          if (!isSessionGone(err)) throw err;
        }
        signal('signed-out');
        setState({ kind: 'signedOut', notice: 'You are signed out.' });
      },
      async logoutAll() {
        let notice = 'You are signed out.';
        await dropPushHere();
        try {
          const r = await api.logoutAll();
          notice = `Signed out everywhere (${String(r.revokedSessions)} ${r.revokedSessions === 1 ? 'session' : 'sessions'} ended).`;
        } catch (err) {
          if (!isSessionGone(err)) throw err;
        }
        signal('signed-out');
        setState({ kind: 'signedOut', notice });
      },
      restart(notice = null) {
        setState({ kind: 'signedOut', notice });
      },
    }),
    [api, startEnrollment, loadSession, endPending, endFull, recheck, signal],
  );

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <AuthContext value={value}>{props.children}</AuthContext>;
}

/** p15-chat-vault: the auth state where a component may also render outside the provider (tests, previews). */
export function useOptionalAuth(): AuthContextValue | null {
  return use(AuthContext) ?? null;
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
