import { useErrorText } from '../../../i18n/errors';
import { type ReactNode, type SubmitEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { isLocale, LOCALE_NAME, LOCALES } from '@remyral/i18n';
import { useLocation, useSearchParams } from 'react-router';
import type { SessionInfo } from '../../../api/auth';
import { listPersonal, type MemoryRecord } from '../../../api/memoryRecords';
import { useAuth } from '../../../auth/AuthProvider';
import { MIN_PASSWORD_LENGTH, validateNewPassword } from '../../../screens/password';
import { useSubmit } from '../../../screens/useSubmit';
import { canOpenCoolify, useCoolifyLinks } from '../../../shell/OpenCoolify';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useLanguageChoice } from '../../../i18n/useLanguageChoice';
import { DyIcon } from '../../icons';
import { ThemeSwitch } from '../../ThemeSwitch';
import { ConfirmButton, DyApiError, DyDetails, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, EmptyLine, Panel, SkeletonRows } from '../parts';
import { NewRecordForm, RecordItem } from '../projects/tabs/memory-records';
import { DyTabs, useFormSection } from '../../formkit';
import { MemoryImportPanel } from '../../memory-import/MemoryImportPanel';
import { toast } from '../../toast/store';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p12-diyalog Faz 4 + wave 2 (W3) — Ayarlar → Profil ve güvenlik, every part in the Diyalog language: the console
 * language, the session (timing as the account menu shows it), log out / log out everywhere, confirm with the authenticator now, change password (classic rules: current
 * password + the policy minimum + confirmation checked before the request, then step-up; fields cleared after every
 * attempt), Coolify sign-on (owners / admins; `noopener noreferrer`) and personal rules (`#personal-rules`, the
 * Diyalog memory record views over `/memory-records/personal`).
 */

/**
 * p14-i18n-foundation (ADR-0053): "Dil / Language" — the console language, saved on the master for this account
 * (`PUT /me/locale`). The Diyalog screens switch at once, without a reload; every language is listed in its own name.
 */
export function LanguagePanel(): ReactNode {
  const t = useT().settings.language;
  const choice = useLanguageChoice();
  // p17-toasts-rest: "Dil kaydedildi." is a transient result → toast (a failure stays inline).
  useDoneToast(choice.saved ? t.saved : null, { testId: 'language-saved' });
  const id = useId();
  const hint = useId();
  return (
    <Panel title={t.label} testId="dy-language">
      <div className="flex flex-wrap items-center gap-3">
        <select
          id={id}
          aria-label={t.label}
          aria-describedby={hint}
          value={choice.locale}
          disabled={choice.busy}
          data-testid="dy-language-select"
          onChange={(e) => {
            const v = e.target.value;
            if (isLocale(v)) void choice.choose(v);
          }}
          className="min-h-10 rounded-[9px] border border-dy-line-2 bg-dy-card px-2.5 text-[0.875rem] text-dy-ink sm:min-h-9"
        >
          {LOCALES.map((l) => (
            <option key={l} value={l} lang={l}>
              {LOCALE_NAME[l]}
            </option>
          ))}
        </select>
        {choice.busy ? <span className="text-[0.8125rem] text-dy-muted">{t.saving}</span> : null}
      </div>
      <p id={hint} className="m-0 mt-2 text-[0.8125rem] text-dy-muted">
        {t.hint}
      </p>
      {choice.error !== null ? (
        <DyNotice tone="red" live className="mt-3">
          {t.failed({ reason: choice.error })}
        </DyNotice>
      ) : null}
    </Panel>
  );
}

/** p17-remyral-brand: "Görünüm" — Açık / Koyu / Sistem (also in the account menu). */
function ThemePanel(): ReactNode {
  const t = useT().settings.theme;
  return (
    <Panel title={t.label} testId="dy-theme-panel">
      <ThemeSwitch />
    </Panel>
  );
}

function When(props: { readonly iso: string; readonly short?: boolean }): ReactNode {
  const fmt = useFormat();
  const d = new Date(props.iso);
  if (Number.isNaN(d.getTime())) return <span>—</span>;
  return <time dateTime={props.iso}>{props.short === true ? fmt.time(d) : fmt.dateTime(d)}</time>;
}

/** The classic `StepUpState` rules in the user's language (session-scoped vs. windowed confirmation). */
function StepUpText(props: { readonly session: SessionInfo }): ReactNode {
  const t = useT().settings.profile.session;
  const fmt = useFormat();
  const s = props.session;
  if (s.stepUpScope === 'session')
    return s.stepUpValidUntil ? (
      <span>
        {t.stepUpSession}
        <span className="block text-[0.78125rem] text-dy-muted">{t.stepUpSessionHint}</span>
      </span>
    ) : (
      <span>{t.stepUpSessionPending}</span>
    );
  if (!s.stepUpValidUntil) return <span>{t.stepUpStale}</span>;
  const d = new Date(s.stepUpValidUntil);
  return <span>{t.stepUpUntil({ time: Number.isNaN(d.getTime()) ? '—' : fmt.time(d) })}</span>;
}

function SessionRows(props: {
  readonly session: SessionInfo | null;
  readonly remainingRecoveryCodes: number | null;
}): ReactNode {
  const t = useT().settings.profile.session;
  const fmt = useFormat();
  const s = props.session;
  const rows: [string, ReactNode][] =
    s === null
      ? []
      : [
          [t.type, s.type === 'remembered' ? t.remembered : t.standard],
          [t.createdAt, <When key="c" iso={s.createdAt} />],
          [t.idleExpiresAt, <When key="i" iso={s.idleExpiresAt} short={s.type !== 'remembered'} />],
          [t.expiresAt, <When key="e" iso={s.expiresAt} />],
          [t.stepUp, <StepUpText key="s" session={s} />],
        ];
  if (props.remainingRecoveryCodes !== null)
    rows.push([t.recoveryCodes, fmt.number(props.remainingRecoveryCodes)]);
  if (rows.length === 0) return <p className="m-0 text-[0.875rem] text-dy-muted">{t.loading}</p>;
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[0.875rem]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-dy-muted">{k}</dt>
          <dd className="m-0 tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function SessionPanel(): ReactNode {
  const { state, actions } = useAuth();
  const submit = useSubmit();
  const profile = useT().settings.profile;
  const t = profile.session;
  if (state.kind !== 'signedIn') return null;
  const seesAll = state.user.role === 'owner' || state.user.role === 'admin';
  const roles: Readonly<Record<string, string>> = profile.roles;
  return (
    <Panel title={t.title} testId="dy-session">
      <SessionRows session={state.session} remainingRecoveryCodes={state.remainingRecoveryCodes} />
      <p className="m-0 mt-3 text-[0.875rem] text-dy-muted">
        {t.signedInAs({ username: state.user.username, role: roles[state.user.role] ?? state.user.role })}{' '}
        {seesAll ? t.seesAll : t.seesMember}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <DyButton busy={submit.busy} onClick={() => void submit.run(() => actions.logout())}>
          {t.logout}
        </DyButton>
        <ConfirmButton
          label={t.logoutAll}
          question={t.logoutAllQuestion}
          confirmLabel={t.logoutAllConfirm}
          disabled={submit.busy}
          testId="logout-all"
          onConfirm={() => void submit.run(() => actions.logoutAll())}
        />
      </div>
      <p className="m-0 mt-2 text-[0.78125rem] text-dy-muted">{t.logoutAllHint}</p>
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} className="mt-3" />
    </Panel>
  );
}

function PrivilegedPanel(): ReactNode {
  const stepUp = useStepUp();
  const t = useT().settings.profile.privileged;
  return (
    <Panel title={t.title} testId="dy-privileged">
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.body}</p>
      <div className="mt-3">
        <DyButton
          icon="key"
          onClick={() =>
            void stepUp
              .confirm(t.prompt)
              .then((ok) => {
                // p17-toasts-rest: the confirmation is an action's result → toast.
                if (ok) toast.success(t.done, { id: 'privileged-confirmed', testId: 'privileged-confirmed' });
              })
              .catch((err: unknown) => {
                if (!(err instanceof StepUpCancelledError)) throw err;
              })
          }
        >
          {t.button}
        </DyButton>
      </div>
    </Panel>
  );
}

interface PasswordErrors {
  current?: string;
  newPassword?: string;
  confirmation?: string;
}

/**
 * Parolayı değiştir (p5-self-password): the classic checks (`validateNewPassword`, current required), then the
 * request through step-up; the master signs out every other session. Fields are cleared after every attempt (a
 * cancelled code dialog keeps them as typed, as classic).
 */
function PasswordPanel(): ReactNode {
  const { state, actions } = useAuth();
  const stepUp = useStepUp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<PasswordErrors>({});
  const submit = useSubmit();
  const t = useT().settings.profile.password;
  const username = state.kind === 'signedIn' ? state.user.username : '';
  // p15-form-pattern: an action form (it keeps its own "Parolayı değiştir" button); typed fields still count as
  // unsaved for the leave guard — leaving drops them.
  useFormSection({
    dirty: current !== '' || next !== '' || confirmation !== '',
    busy: submit.busy,
    save: () => attempt(),
    discard: () => {
      setCurrent('');
      setNext('');
      setConfirmation('');
      setErrors({});
    },
  });

  /** True when the password was changed (false: invalid, refused or the code dialog cancelled). */
  async function attempt(): Promise<boolean> {
    const v = validateNewPassword(next, confirmation);
    const found: PasswordErrors = {};
    if (current === '') found.current = t.currentMissing;
    if (v.newPassword !== undefined) found.newPassword = t.tooShort({ min: MIN_PASSWORD_LENGTH });
    if (v.confirmation !== undefined) found.confirmation = t.mismatch;
    setErrors(found);
    const first =
      found.current !== undefined
        ? 'dy-current-password'
        : found.newPassword !== undefined
          ? 'dy-new-password'
          : found.confirmation !== undefined
            ? 'dy-confirm-new-password'
            : null;
    if (first !== null) {
      document.getElementById(first)?.focus();
      return false;
    }
    let changed = false;
    const ok = await submit.run(async () => {
      try {
        await stepUp.run(() => actions.changePassword(current, next), t.stepUp);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
      changed = true;
      toast.success(t.done, { id: 'password-changed', testId: 'password-changed' });
      setCurrent('');
      setNext('');
      setConfirmation('');
    });
    if (!ok) {
      setCurrent('');
      setNext('');
      setConfirmation('');
    }
    return ok && changed;
  }

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    await attempt();
  }

  return (
    <Panel title={t.title} sub={t.sub} testId="dy-password">
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
        <input type="text" name="username" autoComplete="username" value={username} hidden readOnly />
        <DyField
          id="dy-current-password"
          label={t.current}
          name="current-password"
          type="password"
          autoComplete="current-password"
          maxLength={1024}
          value={current}
          error={errors.current}
          onChange={setCurrent}
        />
        <DyField
          id="dy-new-password"
          label={t.next}
          name="new-password"
          type="password"
          autoComplete="new-password"
          maxLength={1024}
          value={next}
          hint={t.nextHint({ min: MIN_PASSWORD_LENGTH })}
          error={errors.newPassword}
          onChange={setNext}
        />
        <DyField
          id="dy-confirm-new-password"
          label={t.confirmation}
          name="confirm-new-password"
          type="password"
          autoComplete="new-password"
          maxLength={1024}
          value={confirmation}
          error={errors.confirmation}
          onChange={setConfirmation}
        />
        <FormActions>
          <DyButton type="submit" icon="key" busy={submit.busy} disabled={submit.blocked}>
            {submit.busy ? t.busy : t.submit}
          </DyButton>
        </FormActions>
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </form>
    </Panel>
  );
}

/** Coolify sign-on (owners / admins, the master's `sso.coolify` action); a new tab without opener or referrer. */
function CoolifyPanel(): ReactNode {
  const { state } = useAuth();
  const links = useCoolifyLinks();
  const t = useT().settings.profile.coolify;
  if (state.kind !== 'signedIn' || !canOpenCoolify(state.user.role)) return null;
  return (
    <Panel
      title="Coolify" // i18n-ignore product name
      sub={t.sub}
      testId="dy-coolify"
    >
      {links.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.none}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {links.map((l) => (
            <a
              key={l.key}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={l.testId}
              className="dy-press inline-flex min-h-9 items-center gap-1.5 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-medium text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink"
            >
              <DyIcon name="globe" className="size-4" />
              {t.open}
              {l.label === null ? '' : ` — ${l.label}`}
              <span className="sr-only">{t.newTab}</span>
            </a>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Kişisel kurallar (p11-memory-layers): the caller's own rules, on every runtime; only they see them. */
function PersonalRulesPanel(): ReactNode {
  const sayError = useErrorText();
  const t = useT().settings.profile.personal;
  const [items, setItems] = useState<MemoryRecord[] | null>(null);
  const [reload, setReload] = useState(0);
  const [adding, setAdding] = useState(false);
  const load = useSubmit();
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void load.run(async () => {
      setItems(await listPersonal());
    });
    // load.run is stable.
  }, [reload]);

  useEffect(() => {
    const el = ref.current;
    if (location.hash !== '#personal-rules' || el === null || typeof el.scrollIntoView !== 'function') return;
    el.scrollIntoView({ block: 'start' });
  }, [location.hash]);

  const changed = useCallback((text: string) => {
    // p17-toasts-rest: an add / edit / retire result → toast.
    toast.success(text, { id: 'personal-notice', testId: 'personal-notice' });
    setReload((n) => n + 1);
  }, []);

  const active = (items ?? []).filter((r) => r.status === 'active');
  const retired = (items ?? []).filter((r) => r.status !== 'active');

  return (
    <div ref={ref} id="personal-rules" className="scroll-mt-20">
      <Panel
        title={t.title}
        sub={t.sub}
        aside={
          <DyButton
            variant={adding ? 'secondary' : 'primary'}
            icon={adding ? 'xc' : 'plus'}
            aria-expanded={adding}
            onClick={() => {
              setAdding((a) => !a);
            }}
          >
            {adding ? t.close : t.add}
          </DyButton>
        }
        testId="dy-personal-rules"
      >
        <section aria-label={t.title} className="flex flex-col gap-3">
          {adding ? (
            <div className="rounded-[12px] border border-dy-line bg-dy-sunk/50 p-3.5">
              <NewRecordForm
                scopeMode={{ personal: true }}
                onCreated={(c) => {
                  changed(t.added({ title: c.record.title }));
                }}
                onCancel={() => {
                  setAdding(false);
                }}
              />
            </div>
          ) : null}
          {load.error !== null ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">
              {t.loadFailed({ reason: sayError(load.error) })}
            </p>
          ) : null}
          {items === null ? (
            load.error === null ? (
              <SkeletonRows label={t.loading} rows={2} />
            ) : null
          ) : items.length === 0 ? (
            <EmptyLine testId="personal-empty">{t.empty}</EmptyLine>
          ) : (
            <>
              <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="personal-rules">
                {active.map((r) => (
                  <RecordItem
                    key={`${r.id}:${String(r.version)}`}
                    record={r}
                    api="personal"
                    onChanged={changed}
                  />
                ))}
              </ul>
              {retired.length > 0 ? (
                <DyDetails summary={t.retired({ n: retired.length })}>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {retired.map((r) => (
                      <RecordItem
                        key={`${r.id}:${String(r.version)}:${r.status}`}
                        record={r}
                        api="personal"
                        onChanged={changed}
                      />
                    ))}
                  </ul>
                </DyDetails>
              ) : null}
            </>
          )}
        </section>
      </Panel>
    </div>
  );
}

/**
 * p17-memory-import: İçe aktar — a person's memory from their own AI assistant (`?project=<id>` from a project's
 * Hafıza tab proposes that project for team items).
 */
function ImportPanel(): ReactNode {
  const [params] = useSearchParams();
  const project = params.get('project');
  return (
    <MemoryImportPanel
      project={project !== null && /^[A-Za-z0-9_.:-]{1,128}$/.test(project) ? project : null}
    />
  );
}

/**
 * p15-form-pattern: Profil in tabs — Görünüm ve dil (instant: the interface switch and the language), Oturum (the
 * session facts and actions, the authenticator confirmation, Coolify sign-on), Parola (an action form) and Kişisel
 * kurallar (a resource list). A `#personal-rules` link opens its tab.
 */
export function ProfileView(): ReactNode {
  const tt = useT().forms.tabs.profile;
  const { hash } = useLocation();
  return (
    <DyTabs
      label={tt.label}
      fallback={hash === '#personal-rules' ? 'rules' : undefined}
      items={[
        { id: 'look', label: tt.look },
        { id: 'session', label: tt.session },
        { id: 'password', label: tt.password },
        { id: 'rules', label: tt.rules },
        { id: 'import', label: tt.import },
      ]}
    >
      {(tab) =>
        tab === 'session' ? (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <SessionPanel />
            <PrivilegedPanel />
            <CoolifyPanel />
          </div>
        ) : tab === 'password' ? (
          <div className="max-w-[40rem]">
            <PasswordPanel />
          </div>
        ) : tab === 'rules' ? (
          <PersonalRulesPanel />
        ) : tab === 'import' ? (
          <ImportPanel />
        ) : (
          <div className="flex flex-col gap-4">
            <LanguagePanel />
            <ThemePanel />
          </div>
        )
      }
    </DyTabs>
  );
}
