import { type ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { type AuthState, useAuth } from './auth/AuthProvider';
import { DiyalogShell } from './diyalog/DiyalogShell';
import { DyChecking } from './diyalog/auth/checking';
import {
  DyEnrollScreen,
  DyLoginScreen,
  DyPasswordChangeScreen,
  DyRecoveryCodesScreen,
  DyRecoveryLoginScreen,
  DySetupScreen,
  DyTotpScreen,
} from './diyalog/auth/lazyScreens';
import { useReportNotFound } from './diyalog/screens/NotFound';
import { withoutLegacyParams } from './lib/legacyUrl';

const HOME = '/';

function fromState(state: unknown): string {
  if (typeof state === 'object' && state !== null && 'from' in state) {
    const from = state.from;
    // Only same-app paths: never an absolute URL (open redirect).
    if (typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && from !== '/login')
      return from;
  }
  return HOME;
}

/** `/login`: shows whichever sign-in step the server-side session stage requires (p12-diyalog-w4 screens). */
function LoginRoute(): ReactNode {
  const { state } = useAuth();
  const location = useLocation();
  if (state.kind === 'signedIn') return <Navigate to={fromState(location.state)} replace />;
  return (
    // p14-web-perf: the sign-in steps load on demand; the session-check look covers that moment.
    <Suspense fallback={<DyChecking />}>
      <LoginStep state={state} />
    </Suspense>
  );
}

function LoginStep(props: { readonly state: Exclude<AuthState, { kind: 'signedIn' }> }): ReactNode {
  const { state } = props;
  switch (state.kind) {
    case 'checking':
      return <DyChecking />;
    case 'signedOut':
      return <DyLoginScreen notice={state.notice} />;
    case 'secondFactor':
      return state.method === 'totp' ? <DyTotpScreen /> : <DyRecoveryLoginScreen />;
    case 'enrollment':
      return <DyEnrollScreen setup={state.setup} setupError={state.setupError} />;
    case 'recoveryCodes':
      return <DyRecoveryCodesScreen user={state.user} codes={state.codes} />;
    case 'passwordChange':
      return <DyPasswordChangeScreen user={state.user} />;
  }
}

/** `/setup`: the first-owner form; a signed-in visitor goes home (setup is over for them). */
function SetupRoute(): ReactNode {
  const { state } = useAuth();
  if (state.kind === 'signedIn') return <Navigate to="/" replace />;
  return (
    <Suspense fallback={<DyChecking />}>
      <DySetupScreen />
    </Suspense>
  );
}

function RequireSignedIn(props: { readonly children: ReactNode }): ReactNode {
  const { state } = useAuth();
  const location = useLocation();
  if (state.kind === 'checking') return <DyChecking />;
  if (state.kind !== 'signedIn') {
    // The query string is kept: /sso/continue?flow=…&r=… must survive the sign-in (p5-coolify-sso).
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return props.children;
}

/**
 * p6-ui-refactor: an old URL that moved (`/fleet…` → `/machines…`). The rest of the path, the query (deep
 * links such as `?worker=<id>&section=tools`) and the hash are kept.
 */
export function MovedTo(props: { readonly from: string; readonly to: string }): ReactNode {
  const loc = useLocation();
  const rest = loc.pathname.startsWith(props.from) ? loc.pathname.slice(props.from.length) : '';
  return <Navigate replace to={{ pathname: `${props.to}${rest}`, search: loc.search, hash: loc.hash }} />;
}

/** The catch-all: reports this path to the Diyalog shell, which shows "Sayfa bulunamadı" (p12-diyalog-w4). */
function NotFound(): ReactNode {
  useReportNotFound();
  return null;
}

/**
 * p15-classic-removal §4: `?ui=…` / `?gorunum=klasik` from before the classic console was removed are dropped (same
 * path, the rest of the query, the hash and the router state kept), so old bookmarks and links open the screen.
 */
function LegacyParams(props: { readonly children: ReactNode }): ReactNode {
  const loc = useLocation();
  const cleaned = withoutLegacyParams(loc.search);
  if (cleaned === null) return props.children;
  return (
    <Navigate replace to={{ pathname: loc.pathname, search: cleaned, hash: loc.hash }} state={loc.state} />
  );
}

/**
 * The route table. The signed-in frame is the Diyalog shell: it picks the screen for a path itself (home, Sohbet, job
 * page, `diyalog/screens/routes.tsx`) and renders the route elements below only for what is left — the redirects of
 * moved URLs and the not-found catch-all.
 */
export function App(): ReactNode {
  return (
    <LegacyParams>
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        {/* p16-selfhost-onboarding: the first owner of a fresh install (one-time setup token). */}
        <Route path="/setup" element={<SetupRoute />} />
        <Route
          element={
            <RequireSignedIn>
              <DiyalogShell />
            </RequireSignedIn>
          }
        >
          <Route path="/settings/projects" element={<Navigate to="/projects" replace />} />
          <Route path="/fleet/*" element={<MovedTo from="/fleet" to="/machines" />} />
          <Route path="/fleet" element={<MovedTo from="/fleet" to="/machines" />} />
          {/* p6-automations: schedules are automations now. */}
          <Route path="/jobs/schedules" element={<Navigate to="/automations" replace />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </LegacyParams>
  );
}
