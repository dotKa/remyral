import { type ReactNode, type SubmitEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { createFirstOwner, getSetupStatus } from '../../api/selfhost';
import { useT } from '../../i18n/I18nProvider';
import { MIN_PASSWORD_LENGTH, validateNewPassword } from '../../screens/password';
import { useSubmit } from '../../screens/useSubmit';
import { DyErrorNotice, DyField, DyNotice } from '../forms';
import { DyButton } from '../screens/parts';
import { AuthFrame, FrameLink } from './AuthFrame';

/**
 * p16-selfhost-onboarding §3: `/setup` — the first owner of a fresh install, created with the one-time setup token
 * `remyral-ctl install` printed. The master decides everything (token, policy, "an account exists already"); this
 * screen only collects the fields and then sends the owner to the normal sign-in (authenticator enrollment first).
 */
export function DySetupScreen(): ReactNode {
  const t = useT().selfhost.setup;
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<
    Partial<Record<'token' | 'username' | 'password' | 'confirmation', string>>
  >({});
  const [done, setDone] = useState<string | null>(null);
  const [required, setRequired] = useState<boolean | null>(null);
  const submit = useSubmit();

  useEffect(() => {
    getSetupStatus().then(
      (s) => {
        setRequired(s.required);
      },
      () => {
        setRequired(true);
      },
    );
  }, []);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const found = validateNewPassword(password, confirmation);
    const said = {
      ...(token.trim() === '' ? { token: t.tokenRequired } : {}),
      ...(username.trim() === '' ? { username: t.usernameRequired } : {}),
      ...(found.newPassword === undefined ? {} : { password: t.tooShort({ min: MIN_PASSWORD_LENGTH }) }),
      ...(found.confirmation === undefined ? {} : { confirmation: t.mismatch }),
    };
    setErrors(said);
    if (Object.keys(said).length > 0) return;
    const name = username.trim();
    const ok = await submit.run(async () => {
      await createFirstOwner({ token: token.trim(), username: name, password });
    });
    if (ok) setDone(name);
    else {
      setPassword('');
      setConfirmation('');
    }
  }

  if (done !== null) {
    return (
      <AuthFrame step={t.step} title={t.doneTitle} testId="dy-setup-done">
        <p className="m-0 mb-4 text-[0.9375rem]">{t.doneText({ username: done })}</p>
        <DyButton
          variant="primary"
          className="min-h-11 w-full"
          onClick={() => {
            void navigate('/login', { replace: true });
          }}
        >
          {t.signIn}
        </DyButton>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      step={t.step}
      title={t.title}
      description={t.description}
      testId="dy-setup"
      footer={
        <FrameLink
          onClick={() => {
            void navigate('/login');
          }}
        >
          {t.signIn}
        </FrameLink>
      }
    >
      {required === false ? (
        <div className="mb-4">
          <DyNotice tone="teal" testId="dy-setup-not-required">
            {t.alreadyDone}
          </DyNotice>
        </div>
      ) : null}
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
        <DyField
          id="setup-token"
          label={t.token}
          hint={t.tokenHint}
          name="token"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          maxLength={100}
          mono
          value={token}
          error={errors.token ?? null}
          onChange={(e) => {
            setToken(e.target.value);
          }}
        />
        <DyField
          id="setup-username"
          label={t.username}
          hint={t.usernameHint}
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={32}
          value={username}
          error={errors.username ?? null}
          onChange={(e) => {
            setUsername(e.target.value);
          }}
        />
        <DyField
          id="setup-password"
          label={t.password}
          hint={t.passwordHint({ min: MIN_PASSWORD_LENGTH })}
          name="new-password"
          type="password"
          autoComplete="new-password"
          maxLength={1024}
          value={password}
          error={errors.password ?? null}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        <DyField
          id="setup-confirm"
          label={t.confirm}
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          maxLength={1024}
          value={confirmation}
          error={errors.confirmation ?? null}
          onChange={(e) => {
            setConfirmation(e.target.value);
          }}
        />
        <DyButton
          type="submit"
          variant="primary"
          busy={submit.busy}
          disabled={submit.blocked}
          className="min-h-11 w-full"
        >
          {submit.busy ? t.busy : t.submit}
        </DyButton>
        <DyErrorNotice error={submit.error} retryLeft={submit.retryLeft} />
      </form>
    </AuthFrame>
  );
}

/** Under the sign-in form while the installation has no account yet: the way to `/setup`. */
export function DySetupHint(): ReactNode {
  const t = useT().selfhost.setup;
  const [required, setRequired] = useState(false);
  useEffect(() => {
    let alive = true;
    getSetupStatus().then(
      (s) => {
        if (alive) setRequired(s.required);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  if (!required) return null;
  return (
    <Link
      to="/setup"
      data-testid="dy-setup-link"
      className="dy-press inline-flex min-h-10 items-center rounded-md px-1 text-[0.875rem] font-bold text-dy-teal-ink underline-offset-2"
    >
      {t.loginLink}
    </Link>
  );
}
