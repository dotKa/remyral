import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { errorSentence } from '@remyral/i18n';
import {
  describeGitIdentityIssue,
  getDefaultGitIdentity,
  getProjectGitIdentity,
  type GitIdentity,
  gitIdentityEmailIssue,
  type GitIdentityIssue,
  gitIdentityNameIssue,
  type GitIdentitySetting,
  putDefaultGitIdentity,
  putProjectGitIdentity,
} from '../../../api/gitIdentity';
import { DyActor } from '../../common/actor';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { useFormScope, useFormSection, useSectionSave } from '../../formkit';
import { DyApiError, DyField, FormActions } from '../forms';
import { DyButton, Panel, SkeletonRows } from '../parts';
import { DyFields } from '../records';
import { useFormat, useLocale, useT } from '../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../common/time';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p12-diyalog wave 2 (W3): the git commit identity of agent commits in the Diyalog language — per project
 * (Projeler → Depo) and the workspace default (Ayarlar → Entegrasyonlar). Same requests, validation
 * (`gitIdentityNameIssue` / `gitIdentityEmailIssue` from the protocol, worded by the `errors` catalog's
 * `invalid_git_identity` — the code the master sends for the same check) and step-up as the
 * classic `ProjectGitIdentitySection` / `DefaultGitIdentityCard`; changes apply to jobs dispatched afterwards.
 */

/**
 * p14-i18n-errors: a validation issue in the user's language — the same sentence the master's `invalid_git_identity`
 * error gets (no more matching of the English text); the protocol's English if the catalog has no variant.
 */
export function useIdentityIssueText(): (issue: GitIdentityIssue | null) => string | null {
  const t = useT();
  const { locale } = useLocale();
  return useCallback(
    (issue: GitIdentityIssue | null) =>
      issue === null
        ? null
        : (errorSentence(t, locale, 'invalid_git_identity', {
            reason: issue.code,
            ...(issue.max === undefined ? {} : { max: issue.max }),
          }) ?? describeGitIdentityIssue(issue)),
    [t, locale],
  );
}

function useGuarded(): (fn: () => Promise<void>, why: string) => Promise<void> {
  const stepUp = useStepUp();
  return useCallback(
    async (fn, why) => {
      try {
        await stepUp.run(fn, why);
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    },
    [stepUp],
  );
}

function IdentityText(props: { readonly identity: GitIdentity }): ReactNode {
  return (
    <span className="font-dy-mono [overflow-wrap:anywhere]">
      {`${props.identity.name} <${props.identity.email}>`}
    </span>
  );
}

function Editor(props: {
  readonly label: string;
  readonly testId: string;
  readonly canEdit: boolean;
  readonly load: () => Promise<GitIdentitySetting>;
  readonly save: (identity: GitIdentity | null) => Promise<GitIdentitySetting>;
  readonly why: string;
  readonly clearLabel: string;
  readonly unsetText: string;
}): ReactNode {
  const fmt = useFormat();
  const t = useT().knowledge.gitIdentity;
  const tc = useT().gitCentral;
  const issueText = useIdentityIssueText();
  const [data, setData] = useState<GitIdentitySetting | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ name: string | null; email: string | null }>({
    name: null,
    email: null,
  });
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const loader = useSubmit();
  const saver = useSubmit();
  const guarded = useGuarded();
  const sectionSave = useSectionSave();
  const { load, save } = props;
  // p15-form-pattern: inside a tab's form the fields are always open and the tab's bar saves them (no "Düzenle",
  // no own Kaydet / İptal); outside one the classic view → edit toggle stays.
  const scope = useFormScope();
  const inline = scope !== null && props.canEdit;
  const open = inline || editing;

  const apply = (s: GitIdentitySetting): void => {
    setData(s);
    setName(s.identity?.name ?? '');
    setEmail(s.identity?.email ?? '');
    setErrors({ name: null, email: null });
  };

  useEffect(() => {
    void loader.run(async () => {
      apply(await load());
    });
  }, [load]);

  const store = (identity: GitIdentity | null, message: string): void => {
    setDone(null);
    void saver.run(() =>
      guarded(async () => {
        apply(await save(identity));
        setEditing(false);
        setDone(message);
      }, props.why),
    );
  };

  const checked = (): GitIdentity | null => {
    const v = { name: name.trim(), email: email.trim() };
    const next = {
      name: issueText(gitIdentityNameIssue(v.name)),
      email: issueText(gitIdentityEmailIssue(v.email)),
    };
    setErrors(next);
    return next.name !== null || next.email !== null ? null : v;
  };

  const submit = (): void => {
    const v = checked();
    if (v !== null) store(v, t.saved);
  };

  const dirty =
    open &&
    data !== null &&
    (name.trim() !== (data.identity?.name ?? '') || email.trim() !== (data.identity?.email ?? ''));
  useFormSection({
    dirty,
    busy: saver.busy,
    save: async () => {
      const v = checked();
      if (v === null) return false;
      setDone(null);
      return sectionSave(
        saver,
        async () => {
          apply(await save(v));
          setEditing(false);
          setDone(t.saved);
        },
        props.why,
      );
    },
    discard: () => {
      if (data !== null) apply(data);
    },
  });

  // The name / e-mail fields (a plain function, not a component: the inputs keep their focus across renders).
  const fields = (): ReactNode =>
    data === null ? null : (
      <form
        aria-label={t.editForm({ label: props.label })}
        className="grid gap-3 sm:grid-cols-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (inline) void scope.saveAll();
          else submit();
        }}
      >
        <DyField
          label={t.name}
          value={name}
          maxLength={100}
          autoComplete="off"
          placeholder="Acme Bot" // i18n-ignore: example name
          error={errors.name}
          onChange={setName}
        />
        <DyField
          label={t.email}
          type="email"
          value={email}
          maxLength={254}
          autoComplete="off"
          spellCheck={false}
          placeholder="bot@example.com" // i18n-ignore: example address
          error={errors.email}
          mono
          onChange={setEmail}
        />
        <p className="m-0 text-[0.78125rem] text-dy-muted sm:col-span-2">{t.hint}</p>
        {inline ? null : (
          <FormActions className="sm:col-span-2">
            <DyButton type="submit" variant="primary" busy={saver.busy}>
              {t.save}
            </DyButton>
            <DyButton
              variant="ghost"
              onClick={() => {
                apply(data);
                setEditing(false);
              }}
            >
              {t.cancel}
            </DyButton>
          </FormActions>
        )}
      </form>
    );

  return (
    <div data-testid={props.testId} className="flex flex-col gap-3">
      <DyApiError error={loader.error} retryLeft={loader.retryLeft} />
      {data === null ? (
        loader.error === null ? (
          <SkeletonRows label={t.loading({ label: props.label })} rows={1} />
        ) : null
      ) : !open || inline ? (
        <>
          <DyFields
            rows={[
              {
                k: t.committer,
                v: (
                  <span data-testid="git-identity-effective">
                    <IdentityText identity={data.effective.identity} />{' '}
                    <span className="text-dy-muted">({t.source[data.effective.source]})</span>
                  </span>
                ),
              },
              ...(data.identity === null ? [{ k: t.setting, v: props.unsetText }] : []),
              ...(data.updatedAt !== null
                ? [
                    {
                      k: t.changed,
                      v: (
                        <>
                          {fmt.dateWith(data.updatedAt, DATE_TIME_NUMERIC)}
                          {data.updatedBy !== null ? (
                            <>
                              {' · '}
                              <DyActor actor={data.updatedBy} />
                            </>
                          ) : null}
                        </>
                      ),
                    },
                  ]
                : []),
            ]}
          />
          {/* p15-git-central: every commit carries this identity; the machines' own git identity never applies. */}
          <p className="m-0 text-[0.78125rem] text-dy-muted" data-testid="git-identity-applies">
            {tc.identity.appliesEverywhere}
          </p>
          {inline ? fields() : null}
          {props.canEdit ? (
            <FormActions>
              {inline ? null : (
                <DyButton
                  icon="pen"
                  onClick={() => {
                    setDone(null);
                    setEditing(true);
                  }}
                >
                  {data.identity === null ? t.set : t.edit}
                </DyButton>
              )}
              {data.identity !== null ? (
                <DyButton
                  variant="ghost"
                  busy={saver.busy}
                  onClick={() => {
                    store(null, t.removed);
                  }}
                >
                  {props.clearLabel}
                </DyButton>
              ) : null}
            </FormActions>
          ) : null}
        </>
      ) : (
        fields()
      )}
      <DyApiError error={saver.error} retryLeft={saver.retryLeft} />
    </div>
  );
}

/** Projeler → Depo → Git kimliği (project admins; same props as the classic section). */
export function ProjectGitIdentityPanel(props: {
  readonly project: string;
  readonly canEdit: boolean;
}): ReactNode {
  const { project } = props;
  const t = useT().knowledge.gitIdentity;
  const load = useCallback(() => getProjectGitIdentity(project), [project]);
  const save = useCallback(
    (identity: GitIdentity | null) => putProjectGitIdentity(project, identity),
    [project],
  );
  return (
    <Panel title={t.projectTitle} sub={t.projectSub} testId="dy-project-git-identity">
      <Editor
        label={t.projectTitle}
        testId="project-git-identity"
        canEdit={props.canEdit}
        load={load}
        save={save}
        why={t.projectWhy({ project })}
        clearLabel={t.useDefault}
        unsetText={t.projectUnset}
      />
    </Panel>
  );
}

/** Ayarlar → Entegrasyonlar → Varsayılan git kimliği (admins; same as the classic card). */
export function DefaultGitIdentityPanel(): ReactNode {
  const t = useT().knowledge.gitIdentity;
  const load = useCallback(() => getDefaultGitIdentity(), []);
  const save = useCallback((identity: GitIdentity | null) => putDefaultGitIdentity(identity), []);
  return (
    <Panel title={t.defaultTitle} sub={t.defaultSub} testId="dy-default-git-identity">
      <Editor
        label={t.defaultTitle}
        testId="default-git-identity"
        canEdit
        load={load}
        save={save}
        why={t.defaultWhy}
        clearLabel={t.clearDefault}
        unsetText={t.defaultUnset}
      />
    </Panel>
  );
}
