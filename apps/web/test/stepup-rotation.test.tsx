import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SessionInfo, STEP_UP_SESSION_ENDED, stepUpFailureMessage } from '../src/api/auth';
import { ApiError, apiRequest, SESSION_REFRESHED } from '../src/api/client';
import { type AuthApi, AuthProvider, SESSION_ENDED, useAuth } from '../src/auth/AuthProvider';
import { memoryAuthChannel } from '../src/auth/authChannel';
import { StepUpCancelledError, StepUpProvider, useStepUp } from '../src/stepup/StepUpProvider';
import { fakeFetch, type Handler, USER } from './helpers';

/**
 * p9-stepup-rotation-logout (a step-up used to sign the person out before the Prepare code could be entered).
 * A step-up rotates the session id + CSRF token; requests that left with the old ones get
 * 401/403 although the browser already holds the new cookies. The console must re-check before it signs
 * anybody out, retry what is safe to retry, and keep other tabs in step.
 */

const parseAny = (v: unknown): unknown => v;
const ok =
  (body: unknown = { ok: true }): Handler =>
  () => ({ status: 200, body });
const UNAUTHORIZED = { error: 'unauthorized', message: 'Authentication required.' };
const CSRF = { error: 'csrf_failed', message: 'CSRF validation failed.' };

/** A handler answering from a queue (the last answer repeats). */
function seq(...answers: { status: number; body?: unknown }[]): Handler {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)] ?? { status: 500 };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client: re-check before a rotated-away 401/403 reaches the screen', () => {
  it('a GET that raced a step-up is retried once after GET /auth/session confirms the session', async () => {
    const f = fakeFetch({
      'GET /api/workers': seq({ status: 401, body: UNAUTHORIZED }, { status: 200, body: { items: [] } }),
      'GET /api/auth/session': ok(),
    });
    await expect(apiRequest('GET', '/workers', parseAny, { fetchImpl: f.fetch })).resolves.toEqual({
      items: [],
    });
    expect(f.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/workers',
      'GET /api/auth/session',
      'GET /api/workers',
    ]);
  });

  it('a burst of failing polls shares ONE session re-check (single flight)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = fakeFetch({
      'GET /api/a': seq({ status: 401, body: UNAUTHORIZED }, { status: 200, body: 'a' }),
      'GET /api/b': seq({ status: 401, body: UNAUTHORIZED }, { status: 200, body: 'b' }),
      'GET /api/c': seq({ status: 401, body: UNAUTHORIZED }, { status: 200, body: 'c' }),
      'GET /api/auth/session': ok(),
    });
    let rechecks = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/auth/session') {
        rechecks++;
        await gate;
      }
      return inner.fetch(input, init);
    }) as typeof fetch;
    const all = Promise.all(['/a', '/b', '/c'].map((p) => apiRequest('GET', p, parseAny, { fetchImpl })));
    await waitFor(() => {
      expect(inner.requests.filter((r) => r.url !== '/api/auth/session')).toHaveLength(3);
    });
    release();
    await expect(all).resolves.toEqual(['a', 'b', 'c']);
    expect(rechecks).toBe(1);
  });

  it('a mutation that raced a rotation is NOT replayed: retryable session_refreshed instead', async () => {
    const f = fakeFetch({
      'POST /api/workers/w1/sandbox/prepare': () => ({ status: 401, body: UNAUTHORIZED }),
      'GET /api/auth/session': ok(),
    });
    const err = await apiRequest('POST', '/workers/w1/sandbox/prepare', parseAny, {
      fetchImpl: f.fetch,
      cookieString: '__Host-ras-csrf=t',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(SESSION_REFRESHED);
    expect((err as ApiError).status).toBe(409);
    expect(f.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('multi-tab: a 403 csrf_failed after another tab rotated the token is retried with the NEW cookie token', async () => {
    let jar = '__Host-ras-csrf=old-token';
    const f = fakeFetch({
      'POST /api/projects': (req) =>
        req.headers['x-csrf-token'] === 'new-token'
          ? { status: 200, body: { id: 'p1' } }
          : { status: 403, body: CSRF },
      'GET /api/auth/session': () => {
        jar = '__Host-ras-csrf=new-token'; // the other tab's step-up already set it
        return { status: 200, body: {} };
      },
    });
    await expect(
      apiRequest('POST', '/projects', parseAny, {
        body: { name: 'x' },
        fetchImpl: f.fetch,
        cookieString: () => jar,
      }),
    ).resolves.toEqual({ id: 'p1' });
    const posts = f.requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.headers['x-csrf-token'])).toEqual(['old-token', 'new-token']);
  });

  it('a 401 the re-check confirms (no session) surfaces unchanged; so does an unreachable master', async () => {
    const gone = fakeFetch({ 'GET /api/workers': () => ({ status: 401, body: UNAUTHORIZED }) });
    const e1 = await apiRequest('GET', '/workers', parseAny, { fetchImpl: gone.fetch }).catch(
      (e: unknown) => e,
    );
    expect((e1 as ApiError).code).toBe('unauthorized');
    expect(gone.requests.map((r) => r.url)).toEqual(['/api/workers', '/api/auth/session']);

    const flaky = fakeFetch({
      'GET /api/workers': () => ({ status: 401, body: UNAUTHORIZED }),
      'GET /api/auth/session': () => ({ status: 503, body: { error: 'x', message: 'down' } }),
    });
    const e2 = await apiRequest('GET', '/workers', parseAny, { fetchImpl: flaky.fetch }).catch(
      (e: unknown) => e,
    );
    expect((e2 as ApiError).code).toBe('unauthorized');
    expect(flaky.requests.filter((r) => r.url === '/api/workers')).toHaveLength(1);
  });

  it('auth endpoints never re-check (their callers own the session state)', async () => {
    const f = fakeFetch({ 'POST /api/auth/step-up': () => ({ status: 401, body: UNAUTHORIZED }) });
    await expect(
      apiRequest('POST', '/auth/step-up', parseAny, { fetchImpl: f.fetch, body: { code: '123456' } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.requests).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ AuthProvider + step-up dialog

function fakeApi(over: Partial<AuthApi>): AuthApi {
  const unused = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    login: unused,
    verifyTotp: unused,
    loginWithRecoveryCode: unused,
    startEnrollment: unused,
    confirmEnrollment: unused,
    stepUp: unused,
    completePasswordChange: unused,
    changePassword: unused,
    logout: unused,
    logoutAll: unused,
    getSession: unused,
    ...over,
  };
}

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  const now = Date.now();
  return {
    user: USER,
    createdAt: new Date(now - 3_600_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    idleExpiresAt: new Date(now + 1_800_000).toISOString(),
    mfaAt: new Date(now - 5_000).toISOString(),
    stepUpValidUntil: new Date(now + 595_000).toISOString(),
    stepUpScope: 'window',
    alwaysFreshValidUntil: new Date(now + 595_000).toISOString(),
    type: 'standard',
    ...over,
  };
}

const SIGNED_IN = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null } as const;

function StateProbe(props: { readonly id?: string }): ReactNode {
  const { state, actions } = useAuth();
  return (
    <>
      <output data-testid={`state${props.id ?? ''}`}>
        {state.kind === 'signedOut' ? `signedOut:${state.notice ?? ''}` : state.kind}
      </output>
      <output data-testid={`stepup${props.id ?? ''}`}>
        {state.kind === 'signedIn' ? (state.session?.stepUpValidUntil ?? 'none') : '-'}
      </output>
      <button
        type="button"
        onClick={() => {
          actions.refreshSession().catch(() => undefined);
        }}
      >
        refresh{props.id ?? ''}
      </button>
      <button
        type="button"
        onClick={() => {
          actions.logout().catch(() => undefined);
        }}
      >
        logout{props.id ?? ''}
      </button>
    </>
  );
}

function Privileged(props: { readonly action: () => Promise<string> }): ReactNode {
  const stepUp = useStepUp();
  const [result, setResult] = useState('idle');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          stepUp
            .run(props.action, 'Preparing the sandbox needs a fresh code.')
            .then(setResult, (e: unknown) => {
              setResult(e instanceof StepUpCancelledError ? 'cancelled' : 'failed');
            });
        }}
      >
        Prepare
      </button>
      <output data-testid="result">{result}</output>
    </>
  );
}

function renderConsole(api: AuthApi, action: () => Promise<string> = () => Promise.resolve('done')): void {
  render(
    <AuthProvider api={api} initialState={SIGNED_IN} channel={null}>
      <StepUpProvider>
        <StateProbe />
        <Privileged action={action} />
      </StepUpProvider>
    </AuthProvider>,
  );
}

const STEP_UP_REQUIRED = new ApiError(403, 'step_up_required', 'Confirm with a current authenticator code.');

function stepUpFailure(details: Record<string, unknown>): ApiError {
  return new ApiError(401, 'invalid_credentials', 'Invalid credentials.', null, [], {
    error: 'invalid_credentials',
    message: 'Invalid credentials.',
    ...details,
  });
}

async function openDialogAndSubmit(code = '123456'): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Prepare' }));
  await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
  await user.type(screen.getByLabelText('6 haneli kod'), code);
  await user.click(screen.getByRole('button', { name: 'Onayla' }));
}

describe('AuthProvider: a 401 alone never signs out', () => {
  it('a step-up whose request raced a rotation (double submit / other tab) completes and stays signed in', async () => {
    const stepUp = vi.fn(() => Promise.reject(new ApiError(401, 'unauthorized', 'Authentication required.')));
    const getSession = vi.fn(() => Promise.resolve(session()));
    const action = vi.fn().mockRejectedValueOnce(STEP_UP_REQUIRED).mockResolvedValueOnce('prepared');
    renderConsole(fakeApi({ stepUp, getSession }), action);

    await openDialogAndSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('prepared');
    });
    expect(screen.getByTestId('state').textContent).toBe('signedIn');
    expect(getSession).toHaveBeenCalled();
  });

  it('a concurrent request during the step-up (refresh gets 401, re-check finds the session) keeps the user in', async () => {
    const getSession = vi
      .fn<() => Promise<SessionInfo>>()
      .mockRejectedValueOnce(new ApiError(401, 'unauthorized', 'Authentication required.'))
      .mockResolvedValue(session());
    renderConsole(fakeApi({ getSession }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => {
      expect(screen.getByTestId('stepup').textContent).not.toBe('none');
    });
    expect(screen.getByTestId('state').textContent).toBe('signedIn');
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('signs out only when the re-check also finds no session', async () => {
    const getSession = vi.fn(() =>
      Promise.reject(new ApiError(401, 'unauthorized', 'Authentication required.')),
    );
    renderConsole(fakeApi({ getSession }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe(`signedOut:${SESSION_ENDED}`);
    });
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('an unreachable master during the re-check does not sign out', async () => {
    const getSession = vi
      .fn<() => Promise<SessionInfo>>()
      .mockRejectedValueOnce(new ApiError(401, 'unauthorized', 'Authentication required.'))
      .mockRejectedValue(new ApiError(0, 'network_error', 'offline'));
    renderConsole(fakeApi({ getSession }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => {
      expect(getSession).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId('state').textContent).toBe('signedIn');
  });
});

describe('step-up dialog: replayed and wrong codes', () => {
  it('a replayed code says "already used — wait for the next code" with the attempts left', async () => {
    const stepUp = vi.fn(() =>
      Promise.reject(
        stepUpFailure({ reason: 'replayed_totp', attemptsRemaining: 5, sessionTerminated: false }),
      ),
    );
    renderConsole(fakeApi({ stepUp, getSession: () => Promise.resolve(session()) }), () =>
      Promise.reject(STEP_UP_REQUIRED),
    );
    await openDialogAndSubmit();
    const msg = await screen.findByTestId('api-error');
    expect(msg.textContent).toBe(
      'This code was already used — wait for the next code in your authenticator app. 5 wrong codes left before this session ends.',
    );
    expect(screen.getByTestId('state').textContent).toBe('signedIn');
  });

  it('a wrong code shows how many tries are left; the last one says so', () => {
    expect(stepUpFailureMessage({ reason: 'bad_totp', attemptsRemaining: 3, sessionTerminated: false })).toBe(
      'That code is not right. 3 wrong codes left before this session ends.',
    );
    expect(stepUpFailureMessage({ reason: 'bad_totp', attemptsRemaining: 1, sessionTerminated: false })).toBe(
      'That code is not right. 1 more wrong code ends this session.',
    );
    // An older master without the fields keeps the plain message.
    expect(
      stepUpFailureMessage({ reason: 'bad_totp', attemptsRemaining: null, sessionTerminated: false }),
    ).toBe('That code is not right.');
  });

  it('the fifth wrong code ends the session with a clear notice', async () => {
    const stepUp = vi.fn(() =>
      Promise.reject(stepUpFailure({ reason: 'bad_totp', attemptsRemaining: 0, sessionTerminated: true })),
    );
    renderConsole(fakeApi({ stepUp }), () => Promise.reject(STEP_UP_REQUIRED));
    await openDialogAndSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe(`signedOut:${STEP_UP_SESSION_ENDED}`);
    });
  });

  it('a second submit while the first is in flight is not sent (no double submit)', async () => {
    let resolve: (v: { stepUpValidUntil: string; stepUpScope: 'window' }) => void = () => undefined;
    const stepUp = vi.fn(
      () =>
        new Promise<{ stepUpValidUntil: string; stepUpScope: 'window' }>((r) => {
          resolve = r;
        }),
    );
    renderConsole(
      fakeApi({ stepUp, getSession: () => Promise.resolve(session()) }),
      vi.fn().mockRejectedValueOnce(STEP_UP_REQUIRED).mockResolvedValueOnce('ok'),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    await user.type(screen.getByLabelText('6 haneli kod'), '123456');
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(stepUp).toHaveBeenCalledTimes(1);
    act(() => {
      resolve({ stepUpValidUntil: new Date(Date.now() + 600_000).toISOString(), stepUpScope: 'window' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('ok');
    });
  });
});

describe('multi-tab', () => {
  function twoTabs(apiA: AuthApi, apiB: AuthApi): void {
    const bus = memoryAuthChannel();
    render(
      <>
        <AuthProvider api={apiA} initialState={SIGNED_IN} channel={bus.tab()}>
          <StepUpProvider>
            <StateProbe id="A" />
            <Privileged action={vi.fn().mockRejectedValueOnce(STEP_UP_REQUIRED).mockResolvedValue('done')} />
          </StepUpProvider>
        </AuthProvider>
        <AuthProvider api={apiB} initialState={SIGNED_IN} channel={bus.tab()}>
          <StateProbe id="B" />
        </AuthProvider>
      </>,
    );
  }

  it('a step-up in tab A refreshes tab B from the master (B stays signed in, now stepped up)', async () => {
    const validUntil = new Date(Date.now() + 600_000).toISOString();
    const apiA = fakeApi({
      stepUp: () => Promise.resolve({ stepUpValidUntil: validUntil, stepUpScope: 'window' }),
      getSession: () => Promise.resolve(session({ stepUpValidUntil: validUntil })),
    });
    const getSessionB = vi.fn(() => Promise.resolve(session({ stepUpValidUntil: validUntil })));
    twoTabs(apiA, fakeApi({ getSession: getSessionB }));
    expect(screen.getByTestId('stepupB').textContent).toBe('none');
    await openDialogAndSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('stepupB').textContent).toBe(validUntil);
    });
    expect(getSessionB).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('stateB').textContent).toBe('signedIn');
  });

  it('a logout in tab A signs tab B out only after B confirmed the session is gone', async () => {
    const apiA = fakeApi({ logout: () => Promise.resolve() });
    const getSessionB = vi.fn(() =>
      Promise.reject(new ApiError(401, 'unauthorized', 'Authentication required.')),
    );
    twoTabs(apiA, fakeApi({ getSession: getSessionB }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'logoutA' }));
    await waitFor(() => {
      expect(screen.getByTestId('stateB').textContent).toBe('signedOut:You are signed out.');
    });
    expect(getSessionB).toHaveBeenCalledTimes(1);
  });
});
