import { useErrorText } from '../../i18n/errors';
import { type ReactNode, type SubmitEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { EnrollmentSetup, User } from '../../api/auth';
import type { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { useLoginOptions } from '../../auth/useLoginOptions';
import { useT } from '../../i18n/I18nProvider';
import { groupSecret, safeOtpauthUri, svgToDataUri } from '../../lib/svg';
import { MIN_PASSWORD_LENGTH, validateNewPassword } from '../../screens/password';
import { recoveryCodesText } from '../../screens/recoveryCodes';
import { CODE_PATTERN, digitsOnly, isBulkCodeEntry, useSubmit } from '../../screens/useSubmit';
import { DyCheck, DyCopyButton, DyErrorNotice, DyField, DyNotice } from '../forms';
import { DyIcon } from '../icons';
import { DyButton } from '../screens/parts';
import { AuthFrame, FrameLink } from './AuthFrame';
import { DySetupHint } from './setup';
import { noticeText } from './notices';

/**
 * p12-diyalog-w4: the sign-in steps in the Diyalog language (the only sign-in since p15-classic-removal). Every step
 * reuses the classic logic unchanged — the
 * AuthProvider actions, `useSubmit` (busy, the master's error, the `Retry-After` block), the login options, the code
 * helpers, the enrollment QR / key helpers, the recovery-codes file and the password policy check; only the words
 * (the `auth` catalog, i18n Phase 2) and the look are new. The master stays the authority for every check.
 */

function SubmitButton(props: {
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <DyButton
      type="submit"
      variant="primary"
      busy={props.busy}
      disabled={props.blocked}
      className="min-h-11 w-full"
    >
      {props.children}
    </DyButton>
  );
}

// ------------------------------------------------------------------------------------------------ checking

export { DyChecking } from './checking';

// ------------------------------------------------------------------------------------------------ login

export function DyLoginScreen(props: { readonly notice: string | null }): ReactNode {
  const { actions } = useAuth();
  const all = useT().auth;
  const t = all.login;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const options = useLoginOptions();
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const submit = useSubmit();

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const errors: { username?: string; password?: string } = {};
    if (username.trim() === '') errors.username = t.usernameRequired;
    if (password === '') errors.password = t.passwordRequired;
    setFieldErrors(errors);
    if (errors.username !== undefined || errors.password !== undefined) {
      document.getElementById(errors.username !== undefined ? 'login-username' : 'login-password')?.focus();
      return;
    }
    const ok = await submit.run(() =>
      actions.login(username.trim(), password, remember && options.rememberMe !== null),
    );
    if (!ok) setPassword('');
  }

  return (
    // p16-selfhost-onboarding: a fresh install without any account offers the first-owner setup under the card.
    <AuthFrame step={t.step} title={t.title} description={t.description} footer={<DySetupHint />}>
      {props.notice === null ? null : (
        <div className="mb-4">
          <DyNotice tone="teal" live testId="dy-auth-notice">
            {noticeText(props.notice, all.notice)}
          </DyNotice>
        </div>
      )}
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
        <DyField
          id="login-username"
          label={t.username}
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          maxLength={64}
          value={username}
          error={fieldErrors.username ?? null}
          onChange={(e) => {
            setUsername(e.target.value);
          }}
        />
        <DyField
          id="login-password"
          label={t.password}
          name="password"
          type="password"
          autoComplete="current-password"
          maxLength={1024}
          value={password}
          error={fieldErrors.password ?? null}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        {options.rememberMe === null ? null : (
          <DyCheck
            id="login-remember"
            name="remember"
            label={t.remember}
            hint={t.rememberHint({
              days: options.rememberMe.absoluteDays,
              idleDays: options.rememberMe.idleDays,
            })}
            checked={remember}
            onChange={setRemember}
          />
        )}
        <SubmitButton busy={submit.busy} blocked={submit.blocked}>
          {submit.busy ? t.busy : t.submit}
        </SubmitButton>
        <DyErrorNotice error={submit.error} retryLeft={submit.retryLeft} />
      </form>
    </AuthFrame>
  );
}

// ------------------------------------------------------------------------------------------------ second factor

/** "Bu cihaza güven" (p5-remember-device), only when the master offers it. */
function TrustDevice(props: {
  readonly id: string;
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
}): ReactNode {
  const { trustedDevice } = useLoginOptions();
  const t = useT().auth.secondFactor;
  if (trustedDevice === null) return null;
  return (
    <DyCheck
      id={props.id}
      name="trust-device"
      label={t.trustDevice({ days: trustedDevice.days })}
      hint={t.trustDeviceHint}
      checked={props.checked}
      onChange={props.onChange}
    />
  );
}

function SecondFactorFooter(props: { readonly children: ReactNode }): ReactNode {
  const { actions } = useAuth();
  const t = useT().auth.secondFactor;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {props.children}
      <FrameLink
        onClick={() => {
          actions.restart();
        }}
      >
        {t.restart}
      </FrameLink>
    </div>
  );
}

export function DyTotpScreen(): ReactNode {
  const { actions } = useAuth();
  const all = useT().auth;
  const t = all.totp;
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const submit = useSubmit();
  const formRef = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!CODE_PATTERN.test(code)) {
      setFieldError(all.codeRequired);
      document.getElementById('totp-code')?.focus();
      return;
    }
    // One verification at a time: an autofill submit followed by Enter must not send the code twice.
    if (inFlight.current) return;
    inFlight.current = true;
    setFieldError(null);
    try {
      const ok = await submit.run(() => actions.verifyTotp(code, trust));
      if (!ok) setCode('');
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <AuthFrame
      step={all.secondFactor.step}
      title={t.title}
      description={t.description}
      footer={
        <SecondFactorFooter>
          <FrameLink
            onClick={() => {
              actions.chooseMethod('recovery');
            }}
          >
            {t.useRecovery}
          </FrameLink>
        </SecondFactorFooter>
      }
    >
      <form ref={formRef} noValidate onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
        {/* Above the code: a code filled in one go submits itself, so this choice comes first. */}
        <TrustDevice id="totp-trust-device" checked={trust} onChange={setTrust} />
        <DyField
          id="totp-code"
          label={t.code}
          name="code"
          mono
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          enterKeyHint="done"
          placeholder="000000"
          value={code}
          error={fieldError}
          className="text-center text-lg"
          onChange={(e) => {
            const next = digitsOnly(e.target.value);
            const bulk = isBulkCodeEntry(code, next);
            setCode(next);
            // One-time-code autofill, a password manager or a paste: submit once React committed the value.
            if (bulk && !submit.busy && !submit.blocked) {
              setTimeout(() => formRef.current?.requestSubmit(), 0);
            }
          }}
        />
        <SubmitButton busy={submit.busy} blocked={submit.blocked}>
          {submit.busy ? all.secondFactor.verifying : t.submit}
        </SubmitButton>
        <DyErrorNotice error={submit.error} retryLeft={submit.retryLeft} />
      </form>
    </AuthFrame>
  );
}

export function DyRecoveryLoginScreen(): ReactNode {
  const { actions } = useAuth();
  const all = useT().auth;
  const t = all.recoveryLogin;
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const submit = useSubmit();

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const trimmed = code.trim();
    if (trimmed === '') {
      setFieldError(t.required);
      document.getElementById('recovery-code')?.focus();
      return;
    }
    setFieldError(null);
    const ok = await submit.run(() => actions.loginWithRecoveryCode(trimmed, trust));
    if (!ok) setCode('');
  }

  return (
    <AuthFrame
      step={all.secondFactor.step}
      title={t.title}
      description={t.description}
      footer={
        <SecondFactorFooter>
          <FrameLink
            onClick={() => {
              actions.chooseMethod('totp');
            }}
          >
            {t.useTotp}
          </FrameLink>
        </SecondFactorFooter>
      }
    >
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
        <DyField
          id="recovery-code"
          label={t.code}
          name="recovery-code"
          mono
          autoFocus
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
          placeholder="xxxx-xxxx-xxxx" // i18n-ignore: code shape
          value={code}
          error={fieldError}
          hint={t.hint}
          onChange={(e) => {
            setCode(e.target.value);
          }}
        />
        <TrustDevice id="recovery-trust-device" checked={trust} onChange={setTrust} />
        <SubmitButton busy={submit.busy} blocked={submit.blocked}>
          {submit.busy ? all.secondFactor.verifying : t.submit}
        </SubmitButton>
        <DyErrorNotice error={submit.error} retryLeft={submit.retryLeft} />
      </form>
    </AuthFrame>
  );
}

// ------------------------------------------------------------------------------------------------ enrollment

const QR_SIZE = 200;

function StepHeading(props: {
  readonly n: number;
  readonly id: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <h2 className="m-0 flex items-center gap-2 text-[1rem] font-bold">
      <span
        aria-hidden="true"
        className="grid size-6 place-items-center rounded-full bg-dy-teal-soft font-dy-mono text-[0.78125rem] text-dy-teal-ink"
      >
        {props.n}
      </span>
      <span id={props.id}>{props.children}</span>
    </h2>
  );
}

function SetupDetails(props: { readonly setup: EnrollmentSetup }): ReactNode {
  const { setup } = props;
  const qr = svgToDataUri(setup.qrSvg);
  const link = safeOtpauthUri(setup.otpauthUri);
  const t = useT().auth;
  const e = t.enroll;
  return (
    <section aria-labelledby="enroll-scan" className="grid gap-3">
      <StepHeading n={1} id="enroll-scan">
        {e.scan}
      </StepHeading>
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        {/* Fixed white plate: no layout shift while decoding, and the code scans in dark mode. */}
        <div className="shrink-0 rounded-[12px] border border-dy-line bg-white p-2">
          {qr === null ? (
            <div className="flex size-[200px] items-center justify-center p-3 text-center text-[0.8125rem] text-[#3a4253]">
              {e.noQr}
            </div>
          ) : (
            <img
              src={qr}
              width={QR_SIZE}
              height={QR_SIZE}
              alt={e.qrAlt}
              className="block size-[200px]"
              data-testid="enroll-qr"
            />
          )}
        </div>
        <p className="m-0 text-[0.875rem] text-dy-muted">
          {e.appsBefore} <b className="font-bold text-dy-ink">{t.frame.product}</b>
          {e.appsAfter}
          {link === null ? null : (
            <>
              {' '}
              {e.onThisPhone}{' '}
              <a href={link} className="font-bold text-dy-teal-ink underline underline-offset-2">
                {e.openInApp}
              </a>
              .
            </>
          )}
        </p>
      </div>
      <details className="group rounded-[12px] border border-dy-line bg-dy-sunk px-3 py-2">
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 text-[0.875rem] font-bold marker:hidden">
          <DyIcon
            name="chev"
            className="size-3.5 transition-transform duration-150 ease-dy group-open:rotate-180"
          />
          {e.cantScan}
        </summary>
        <div className="mt-2 grid gap-3 pb-1">
          <div>
            <p className="m-0 text-[0.8125rem] text-dy-muted">{e.keyDetails}</p>
            <p
              className="m-0 mt-1 font-dy-mono text-[0.9375rem] break-all select-all"
              data-testid="enroll-secret"
              aria-label={e.key}
            >
              {groupSecret(setup.secret)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <DyCopyButton text={setup.secret} label={e.copyKey} />
            <DyCopyButton text={setup.otpauthUri} label={e.copyLink} />
          </div>
        </div>
      </details>
    </section>
  );
}

function ConfirmEnrollment(): ReactNode {
  const { actions } = useAuth();
  const all = useT().auth;
  const e = all.enroll;
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const submit = useSubmit();

  async function onSubmit(ev: SubmitEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    if (!CODE_PATTERN.test(code)) {
      setFieldError(all.codeRequired);
      document.getElementById('enroll-code')?.focus();
      return;
    }
    setFieldError(null);
    const ok = await submit.run(() => actions.confirmEnrollment(code));
    if (!ok) setCode('');
  }

  return (
    <section aria-labelledby="enroll-confirm" className="grid gap-3">
      <StepHeading n={2} id="enroll-confirm">
        {e.confirm}
      </StepHeading>
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
        <DyField
          id="enroll-code"
          label={e.confirmCode}
          name="code"
          mono
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          enterKeyHint="done"
          placeholder="000000"
          value={code}
          error={fieldError}
          className="text-center text-lg"
          onChange={(e) => {
            setCode(digitsOnly(e.target.value));
          }}
        />
        <SubmitButton busy={submit.busy} blocked={submit.blocked}>
          {submit.busy ? e.confirming : e.confirmSubmit}
        </SubmitButton>
        <DyErrorNotice error={submit.error} retryLeft={submit.retryLeft} />
      </form>
    </section>
  );
}

export function DyEnrollScreen(props: {
  readonly setup: EnrollmentSetup | null;
  readonly setupError: ApiError | null;
}): ReactNode {
  const sayError = useErrorText();
  const { actions } = useAuth();
  const t = useT().auth.enroll;
  return (
    <AuthFrame
      wide
      step={t.step}
      title={t.title}
      description={t.description}
      footer={
        <FrameLink
          onClick={() => {
            actions.restart();
          }}
        >
          {t.cancel}
        </FrameLink>
      }
    >
      <div className="grid gap-6">
        {props.setup !== null ? (
          <>
            <SetupDetails setup={props.setup} />
            <ConfirmEnrollment />
          </>
        ) : props.setupError !== null ? (
          <div className="grid gap-3">
            <DyNotice tone="red" live>
              {sayError(props.setupError)}
            </DyNotice>
            <DyButton icon="retry" onClick={() => void actions.retryEnrollment()}>
              {t.retry}
            </DyButton>
          </div>
        ) : (
          <div
            role="status"
            className="flex h-[200px] items-center justify-center gap-2.5 text-[0.9375rem] text-dy-muted"
          >
            <span className="dy-breathe size-2.5 rounded-full bg-dy-teal" aria-hidden="true" />
            {t.preparing}
          </div>
        )}
      </div>
    </AuthFrame>
  );
}

// ------------------------------------------------------------------------------------------------ recovery codes

function DownloadLink(props: { readonly text: string; readonly filename: string }): ReactNode {
  const [url, setUrl] = useState<string | null>(null);
  const t = useT().auth.recoveryCodes;
  // A blob: URL (never a data: URL carrying the codes in an attribute), revoked when the screen unmounts.
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([props.text], { type: 'text/plain;charset=utf-8' }));
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
    };
  }, [props.text]);
  return (
    <a
      href={url ?? undefined}
      download={props.filename}
      aria-disabled={url === null ? true : undefined}
      className="dy-press inline-flex min-h-10 items-center gap-1.5 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-medium whitespace-nowrap text-dy-ink no-underline sm:min-h-9 [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink"
    >
      <DyIcon name="tray" className="size-4" />
      {t.download}
    </a>
  );
}

export function DyRecoveryCodesScreen(props: {
  readonly user: User;
  readonly codes: readonly string[];
}): ReactNode {
  const { actions } = useAuth();
  const t = useT().auth.recoveryCodes;
  const [stored, setStored] = useState(false);
  const text = useMemo(() => recoveryCodesText(props.user, props.codes), [props.user, props.codes]);
  return (
    <AuthFrame wide step={t.step} title={t.title} description={t.description}>
      <div className="grid gap-4">
        <DyNotice tone="amber">{t.warning}</DyNotice>
        <ol
          aria-label={t.list}
          data-testid="recovery-codes"
          className="m-0 grid list-none grid-cols-2 gap-x-6 gap-y-1.5 rounded-[12px] border border-dy-line bg-dy-sunk px-4 py-3 font-dy-mono text-[0.9375rem] tabular-nums select-all"
        >
          {props.codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <DyCopyButton text={props.codes.join('\n')} label={t.copyAll} />
          <DownloadLink text={text} filename={`remyral-recovery-codes-${props.user.username}.txt`} />
        </div>
        <div className="rounded-[12px] border border-dy-line px-3 py-1.5">
          <DyCheck id="recovery-stored" label={t.stored} checked={stored} onChange={setStored} />
        </div>
        <DyButton
          variant="primary"
          disabled={!stored}
          className="min-h-11 w-full"
          onClick={() => {
            actions.acknowledgeRecoveryCodes();
          }}
        >
          {t.continue}
        </DyButton>
      </div>
    </AuthFrame>
  );
}

// ------------------------------------------------------------------------------------------------ password change

export function DyPasswordChangeScreen(props: { readonly user: User }): ReactNode {
  const { actions } = useAuth();
  const all = useT().auth;
  const t = all.password;
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<{ newPassword?: string; confirmation?: string }>({});
  const submit = useSubmit();

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    // The classic policy check decides; only its words come from the catalog here.
    const found = validateNewPassword(newPassword, confirmation);
    const said = {
      ...(found.newPassword === undefined ? {} : { newPassword: t.tooShort({ min: MIN_PASSWORD_LENGTH }) }),
      ...(found.confirmation === undefined ? {} : { confirmation: t.mismatch }),
    };
    setErrors(said);
    if (said.newPassword !== undefined || said.confirmation !== undefined) {
      document
        .getElementById(said.newPassword !== undefined ? 'forced-new-password' : 'forced-confirm-password')
        ?.focus();
      return;
    }
    const ok = await submit.run(() => actions.completePasswordChange(newPassword));
    if (!ok) {
      setNewPassword('');
      setConfirmation('');
    }
  }

  return (
    <AuthFrame
      step={t.step}
      title={t.title}
      description={
        <>
          <b className="font-bold text-dy-ink">{props.user.username}</b>
          {t.description}
        </>
      }
      footer={
        <FrameLink
          onClick={() => {
            actions.restart();
          }}
        >
          {all.enroll.cancel}
        </FrameLink>
      }
    >
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
        {/* Lets password managers file the new password under the right account. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={props.user.username}
          hidden
          readOnly
        />
        <DyField
          id="forced-new-password"
          label={t.newPassword}
          name="new-password"
          type="password"
          autoComplete="new-password"
          autoFocus
          maxLength={1024}
          value={newPassword}
          hint={t.hint({ min: MIN_PASSWORD_LENGTH })}
          error={errors.newPassword ?? null}
          onChange={(e) => {
            setNewPassword(e.target.value);
          }}
        />
        <DyField
          id="forced-confirm-password"
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
        <SubmitButton busy={submit.busy} blocked={submit.blocked}>
          {submit.busy ? t.saving : t.submit}
        </SubmitButton>
        <DyErrorNotice error={submit.error} retryLeft={submit.retryLeft} />
      </form>
    </AuthFrame>
  );
}
