import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../src/auth/AuthProvider';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ApiError } from '../src/api/client';
import { StepUpCancelledError, StepUpProvider, useStepUp } from '../src/stepup/StepUpProvider';
import { USER } from './helpers';

const STEP_UP_REQUIRED = new ApiError(403, 'step_up_required', 'Confirm with a current authenticator code.');

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

function Privileged(props: { readonly action: () => Promise<string> }): ReactNode {
  const stepUp = useStepUp();
  const [result, setResult] = useState('idle');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          stepUp.run(props.action, 'Approving a worker needs a fresh code.').then(setResult, (e: unknown) => {
            setResult(e instanceof StepUpCancelledError ? 'cancelled' : 'failed');
          });
        }}
      >
        Approve worker
      </button>
      <output data-testid="result">{result}</output>
    </>
  );
}

function setup(api: AuthApi, action: () => Promise<string>): void {
  render(
    <AuthProvider
      api={api}
      initialState={{ kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null }}
    >
      <StepUpProvider>
        <Privileged action={action} />
      </StepUpProvider>
    </AuthProvider>,
  );
}

describe('step-up', () => {
  it('opens the dialog on 403 step_up_required, verifies the code and retries the action once', async () => {
    const user = userEvent.setup();
    const stepUp = vi.fn((code: string) =>
      code === '111111'
        ? Promise.resolve({ stepUpValidUntil: '2026-10-12T10:10:00.000Z', stepUpScope: 'window' as const })
        : Promise.reject(new ApiError(401, 'invalid_credentials', 'Invalid credentials.')),
    );
    const action = vi.fn().mockRejectedValueOnce(STEP_UP_REQUIRED).mockResolvedValueOnce('approved');
    setup(fakeApi({ stepUp, getSession: () => Promise.reject(new Error('offline')) }), action);

    await user.click(screen.getByRole('button', { name: 'Approve worker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    expect(dialog.textContent).toContain('Approving a worker needs a fresh code.');

    await user.type(screen.getByLabelText('6 haneli kod'), '999999');
    await user.click(screen.getByRole('button', { name: 'Onayla' }));
    expect((await screen.findByTestId('api-error')).textContent).toBe('Giriş bilgileri geçersiz.');

    await user.type(screen.getByLabelText('6 haneli kod'), '111111');
    await user.click(screen.getByRole('button', { name: 'Onayla' }));
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('approved');
    });
    expect(action).toHaveBeenCalledTimes(2);
    expect(stepUp).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelling rejects with StepUpCancelledError and does not retry', async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockRejectedValue(STEP_UP_REQUIRED);
    setup(fakeApi({}), action);
    await user.click(screen.getByRole('button', { name: 'Approve worker' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Vazgeç' }));
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('cancelled');
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('p5-mobile: a code filled in one go (one-time-code autofill / paste) submits itself', async () => {
    const user = userEvent.setup();
    const stepUp = vi.fn(() =>
      Promise.resolve({ stepUpValidUntil: '2026-10-12T10:10:00.000Z', stepUpScope: 'window' as const }),
    );
    const action = vi.fn().mockRejectedValueOnce(STEP_UP_REQUIRED).mockResolvedValueOnce('approved');
    setup(fakeApi({ stepUp, getSession: () => Promise.reject(new Error('offline')) }), action);
    await user.click(screen.getByRole('button', { name: 'Approve worker' }));
    await screen.findByRole('dialog');
    const field = screen.getByLabelText('6 haneli kod');
    expect(field.getAttribute('autocomplete')).toBe('one-time-code');
    expect(field.getAttribute('inputmode')).toBe('numeric');
    field.focus();
    await user.paste('123 456');
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('approved');
    });
    expect(stepUp).toHaveBeenCalledWith('123456');
  });

  it('p5-mobile: typing the code digit by digit waits for Confirm', async () => {
    const user = userEvent.setup();
    const stepUp = vi.fn(() =>
      Promise.resolve({ stepUpValidUntil: '2026-10-12T10:10:00.000Z', stepUpScope: 'window' as const }),
    );
    const action = vi.fn().mockRejectedValueOnce(STEP_UP_REQUIRED).mockResolvedValueOnce('approved');
    setup(fakeApi({ stepUp, getSession: () => Promise.reject(new Error('offline')) }), action);
    await user.click(screen.getByRole('button', { name: 'Approve worker' }));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('6 haneli kod'), '123456');
    expect(stepUp).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Onayla' }));
    await waitFor(() => {
      expect(stepUp).toHaveBeenCalledWith('123456');
    });
  });

  it('passes other errors through without prompting', async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockRejectedValue(new ApiError(403, 'forbidden', 'Not allowed.'));
    setup(fakeApi({}), action);
    await user.click(screen.getByRole('button', { name: 'Approve worker' }));
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('failed');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
