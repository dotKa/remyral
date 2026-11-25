import { fill } from '@remyral/i18n';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  type ApiToken,
  createServiceAccount,
  createServiceToken,
  type IssuedToken,
  listAllTokens,
  listServiceAccounts,
  revokeAnyToken,
  rotateServiceToken,
  type ServiceAccount,
  SERVICE_ROLES,
  type ServiceRole,
  type TokenRules,
  updateServiceAccount,
} from '../../../api/apiTokens';
import type { ApiError } from '../../../api/client';
import {
  listProjects,
  type Project,
  PROJECT_ROLES,
  type ProjectRole,
  removeMember,
  setMember,
} from '../../../api/directory';
import { toApiError } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { ConfirmButton, DyApiError, DyDetails, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, DySelect, EmptyLine, Panel, Pill, Rows, SkeletonRows } from '../parts';
import { CreateTokenForm, RotateDialog, SecretReveal, TokenRow } from './api-tokens-parts';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md §1, §8): Ayarlar → Servis hesapları (owners / admins) — non-human
 * accounts with a role (never owner, at most the admin's own), project memberships (the project members API) and
 * their tokens (create, rotate, revoke), plus every person's personal tokens (revoke). Creating an account or changing
 * its role / state is the safe-core event `users.roles`; a token create / rotate is `api.tokens`.
 */

type Run = ReturnType<typeof useSubmit>['run'];

function CreateAccountForm(props: { readonly onCreated: (a: ServiceAccount) => void }): ReactNode {
  const t = useT().apiTokens;
  const stepUp = useStepUp();
  const submit = useSubmit();
  const [name, setName] = useState('');
  const [role, setRole] = useState<ServiceRole>('operator');
  const [description, setDescription] = useState('');

  return (
    <form
      className="grid gap-3"
      data-testid="service-account-create"
      onSubmit={(e) => {
        e.preventDefault();
        void submit.run(async () => {
          try {
            const a = await stepUp.run(
              () =>
                createServiceAccount({
                  name: name.trim(),
                  role,
                  ...(description.trim() === '' ? {} : { description: description.trim() }),
                }),
              t.service.stepUp,
            );
            setName('');
            setDescription('');
            props.onCreated(a);
          } catch (err) {
            if (err instanceof StepUpCancelledError) return;
            throw err;
          }
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <DyField
          label={t.service.name}
          hint={t.service.nameHint}
          value={name}
          maxLength={32}
          mono
          onChange={(v) => {
            setName(v.toLowerCase());
          }}
        />
        <DySelect
          label={t.service.role}
          value={role}
          options={SERVICE_ROLES.map((r) => [r, t.roles[r]] as const)}
          onChange={(v) => {
            setRole(v === 'admin' || v === 'viewer' ? v : 'operator');
          }}
        />
      </div>
      <DyField
        label={t.service.description}
        placeholder={t.service.descriptionPlaceholder}
        value={description}
        maxLength={500}
        onChange={setDescription}
      />
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      <FormActions>
        <DyButton
          type="submit"
          variant="primary"
          icon="plus"
          busy={submit.busy}
          disabled={name.trim().length < 3}
        >
          {t.service.submit}
        </DyButton>
      </FormActions>
    </form>
  );
}

function Memberships(props: {
  readonly account: ServiceAccount;
  readonly projects: readonly Project[];
  readonly run: Run;
  readonly busy: boolean;
  readonly reload: () => Promise<void>;
}): ReactNode {
  const t = useT().apiTokens;
  const stepUp = useStepUp();
  const a = props.account;
  const free = props.projects.filter((p) => !a.memberships.some((m) => m.project === p.id));
  const [project, setProject] = useState('');
  const [role, setRole] = useState<ProjectRole>('viewer');
  const chosen = project === '' ? (free[0]?.id ?? '') : project;

  const guarded = (fn: () => Promise<unknown>): void => {
    void props.run(async () => {
      try {
        await stepUp.run(fn, t.service.memberStepUp);
        await props.reload();
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  };

  return (
    <div className="grid gap-2" data-testid={`service-account-members-${a.name}`}>
      <h3 className="m-0 text-[0.875rem] font-bold">{t.service.memberships}</h3>
      {a.role === 'admin' ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.service.globalRole}</p>
      ) : null}
      {a.memberships.length === 0 ? (
        a.role === 'admin' ? null : (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.service.noMemberships}</p>
        )
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {a.memberships.map((m) => (
            <li key={m.project} className="flex flex-wrap items-center gap-2 text-[0.875rem]">
              <span className="font-dy-mono">{m.project}</span>
              <Pill tone="neutral">{t.roles[m.role === 'operator' ? 'operator' : 'viewer']}</Pill>
              <ConfirmButton
                label={t.service.removeMember}
                question={fill(t.service.removeMemberQuestion, { project: m.project })}
                disabled={props.busy}
                onConfirm={() => {
                  guarded(() => removeMember(m.project, a.id));
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {free.length === 0 ? null : (
        <div className="flex flex-wrap items-end gap-2">
          <DySelect
            label={t.service.project}
            value={chosen}
            options={free.map((p) => [p.id, p.name === p.id ? p.id : `${p.name} (${p.id})`] as const)}
            onChange={setProject}
          />
          <DySelect
            label={t.service.projectRole}
            value={role}
            options={PROJECT_ROLES.map((r) => [r, t.roles[r]] as const)}
            onChange={(v) => {
              setRole(v === 'operator' ? 'operator' : 'viewer');
            }}
          />
          <DyButton
            icon="plus"
            disabled={props.busy || chosen === ''}
            data-testid={`service-account-add-member-${a.name}`}
            onClick={() => {
              guarded(() => setMember(chosen, a.id, role));
            }}
          >
            {t.service.addMember}
          </DyButton>
        </div>
      )}
    </div>
  );
}

function AccountPanel(props: {
  readonly account: ServiceAccount;
  readonly rules: TokenRules;
  readonly projects: readonly Project[];
  readonly reload: () => Promise<void>;
  readonly onIssued: (i: IssuedToken) => void;
}): ReactNode {
  const t = useT().apiTokens;
  const stepUp = useStepUp();
  const submit = useSubmit();
  const a = props.account;
  const [role, setRole] = useState<ServiceRole>(a.role);
  const [rotating, setRotating] = useState<ApiToken | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);

  const change = (patch: { role?: ServiceRole; disabled?: boolean }): void => {
    setDone(null);
    void submit.run(async () => {
      try {
        await stepUp.run(() => updateServiceAccount(a.id, patch), t.service.stepUp);
        setDone(t.service.saved);
        await props.reload();
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  };

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-dy-mono">{a.name}</span>
          <Pill tone={a.role === 'admin' ? 'violet' : 'teal'}>{t.roles[a.role]}</Pill>
          {a.disabled ? <Pill tone="neutral">{t.service.disabled}</Pill> : null}
        </span>
      }
      sub={a.description ?? undefined}
      aside={
        a.disabled ? (
          <DyButton
            disabled={submit.busy}
            onClick={() => {
              change({ disabled: false });
            }}
          >
            {t.service.enable}
          </DyButton>
        ) : (
          <ConfirmButton
            label={t.service.disable}
            question={fill(t.service.disableQuestion, { name: a.name })}
            disabled={submit.busy}
            testId={`service-account-disable-${a.name}`}
            onConfirm={() => {
              change({ disabled: true });
            }}
          />
        )
      }
      testId={`service-account-${a.name}`}
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <DySelect
            label={t.service.role}
            value={role}
            options={SERVICE_ROLES.map((r) => [r, t.roles[r]] as const)}
            onChange={(v) => {
              setRole(v === 'admin' || v === 'viewer' ? v : 'operator');
            }}
          />
          <DyButton
            disabled={submit.busy || role === a.role}
            onClick={() => {
              change({ role });
            }}
          >
            {t.service.saveRole}
          </DyButton>
        </div>
        <Memberships
          account={a}
          projects={props.projects}
          run={submit.run}
          busy={submit.busy}
          reload={props.reload}
        />
        <div className="grid gap-2">
          <h3 className="m-0 text-[0.875rem] font-bold">{t.service.tokens}</h3>
          {a.tokens.length === 0 ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.service.noTokens}</p>
          ) : (
            <div className="-mx-4">
              <Rows label={t.service.tokens}>
                {a.tokens.map((tok) => (
                  <TokenRow
                    key={tok.id}
                    token={tok}
                    busy={submit.busy}
                    onRotate={a.disabled ? undefined : setRotating}
                    onRevoke={(x) => {
                      setDone(null);
                      void submit.run(async () => {
                        await revokeAnyToken(x.id);
                        setDone(fill(t.revoke.done, { name: x.name }));
                        await props.reload();
                      });
                    }}
                  />
                ))}
              </Rows>
            </div>
          )}
          {a.disabled ? null : (
            <DyDetails summary={t.service.newToken} testId={`service-account-new-token-${a.name}`}>
              <CreateTokenForm
                rules={props.rules}
                testId={`service-token-create-${a.name}`}
                create={(input) => createServiceToken(a.id, input)}
                onCreated={(out) => {
                  props.onIssued(out);
                  void props.reload();
                }}
              />
            </DyDetails>
          )}
        </div>
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
      <RotateDialog
        token={rotating}
        rules={props.rules}
        rotate={(tok, input) => rotateServiceToken(a.id, tok.id, input)}
        onClose={() => {
          setRotating(null);
        }}
        onRotated={(out) => {
          setRotating(null);
          props.onIssued(out);
          void props.reload();
        }}
      />
    </Panel>
  );
}

function PersonalTokensPanel(): ReactNode {
  const t = useT().apiTokens;
  const [items, setItems] = useState<readonly ApiToken[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const submit = useSubmit();
  const load = useCallback(async () => {
    try {
      setItems(await listAllTokens('personal'));
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Panel
      title={t.service.allPersonal}
      sub={t.service.allPersonalSub}
      count={items === null ? undefined : String(items.length)}
      countLabel={items === null ? undefined : fill(t.list.count, { n: items.length })}
      flush
      testId="all-personal-tokens"
    >
      <div className="px-4 empty:hidden">
        <DyApiError error={error} />
      </div>
      {items === null ? (
        error === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : null
      ) : items.length === 0 ? (
        <EmptyLine>{t.list.empty}</EmptyLine>
      ) : (
        <Rows label={t.service.allPersonal}>
          {items.map((tok) => (
            <TokenRow
              key={tok.id}
              token={tok}
              showOwner
              busy={submit.busy}
              onRevoke={(x) => {
                setDone(null);
                void submit.run(async () => {
                  await revokeAnyToken(x.id);
                  setDone(fill(t.revoke.done, { name: x.name }));
                  await load();
                });
              }}
            />
          ))}
        </Rows>
      )}
      <div className="flex flex-col gap-2 px-4 pb-4 empty:hidden">
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </Panel>
  );
}

export function ServiceAccountsView(): ReactNode {
  const t = useT().apiTokens;
  const [accounts, setAccounts] = useState<readonly ServiceAccount[] | null>(null);
  const [rules, setRules] = useState<TokenRules | null>(null);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const out = await listServiceAccounts();
      setAccounts(out.items);
      setRules(out.rules);
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  }, []);

  useEffect(() => {
    void load();
    listProjects().then(setProjects, () => {
      setProjects([]);
    });
  }, [load]);

  if (accounts === null || rules === null)
    return error === null ? (
      <Panel title={t.pages.service.label}>
        <SkeletonRows label={t.loading} rows={3} />
      </Panel>
    ) : (
      <DyApiError error={error} />
    );

  return (
    <div className="grid gap-4" data-testid="dy-service-accounts">
      {issued === null ? null : (
        <SecretReveal
          issued={issued}
          onClose={() => {
            setIssued(null);
          }}
        />
      )}
      <Panel title={t.service.createTitle} sub={t.service.createSub} testId="service-account-create-panel">
        <CreateAccountForm
          onCreated={(a) => {
            setNotice(fill(t.service.created, { name: a.name }));
            void load();
          }}
        />
        {notice === null ? null : (
          <DyNotice tone="green" live className="mt-3">
            {notice}
          </DyNotice>
        )}
      </Panel>
      {accounts.length === 0 ? (
        <Panel title={t.service.listTitle}>
          <EmptyLine testId="service-accounts-empty">{t.service.empty}</EmptyLine>
        </Panel>
      ) : (
        accounts.map((a) => (
          <AccountPanel
            key={a.id}
            account={a}
            rules={rules}
            projects={projects}
            reload={load}
            onIssued={(out) => {
              setIssued(out);
              setNotice(fill(t.created, { name: out.token.name }));
            }}
          />
        ))
      )}
      <PersonalTokensPanel />
    </div>
  );
}
