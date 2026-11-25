import { type ReactNode, type SubmitEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  type CreatedUser,
  createUser,
  listUsers,
  type Role,
  ROLES,
  setUserDisabled,
  setUserRole,
  type UserAccount,
} from '../../../api/directory';
import { useAuth } from '../../../auth/AuthProvider';
import {
  approveRecovery,
  cancelRecovery,
  listRecoveryRequests,
  type RecoveryAction,
  type RecoveryOutcome,
  type RecoveryRequest,
  recoverUser,
} from '../../../api/panelSettings';
import { DyPager } from '../../common/pager';
import { DySortBar, sortRows, useSortParam } from '../../common/sort';
import { toApiError } from '../../../components/ui';
import { useClientPage } from '../../../lib/pager';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon, type IconName } from '../../icons';
import type { Tone } from '../../tone';
import { ConfirmButton, DyApiError, DyCopyButton, DyDialog, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, DyButtonLink, DySelect, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { DyTime } from '../records';
import { useT } from '../../../i18n/I18nProvider';
import type { Messages } from '@remyral/i18n';

/**
 * p12-diyalog wave 2 (W3) — Ayarlar → Kullanıcılar in the Diyalog language, feature for feature with the classic
 * `UsersPage` (docs/design/p5-rbac.md §6): owners and admins read the accounts (role, state, project access, last
 * sign-in); only the owner creates users (the temporary password is shown exactly once and never stored), changes
 * account roles and disables / enables accounts — every write through step-up. Same calls and username rule.
 */

const USERNAME = /^[a-z][a-z0-9_.-]{2,31}$/;

type UsersText = Messages['settings']['users'];

/** Role words (the projects catalog's, as the classic table) and the role select's options. */
function useRoles(): {
  readonly word: (r: string) => string;
  readonly options: readonly (readonly [Role, string])[];
} {
  const roles: Readonly<Record<string, string>> = useT().projects.roles;
  const word = (r: string): string => roles[r] ?? r;
  return { word, options: ROLES.map((r) => [r, word(r)] as const) };
}

const USER_SORT_KEYS = ['user', 'role'] as const;
type UserSortKey = (typeof USER_SORT_KEYS)[number];
const USER_COMPARE: Readonly<Record<UserSortKey, (a: UserAccount, b: UserAccount) => number>> = {
  user: (a, b) => a.username.localeCompare(b.username),
  role: (a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role),
};

function statusOf(u: UserAccount, t: UsersText): { word: string; tone: Tone; icon: IconName } {
  if (u.disabled) return { word: t.status.disabled, tone: 'red', icon: 'xc' };
  if (u.lockedUntil !== null) return { word: t.status.locked, tone: 'amber', icon: 'key' };
  if (!u.totpEnrolled) return { word: t.status.needsTotp, tone: 'amber', icon: 'shield' };
  return { word: t.status.active, tone: 'green', icon: 'checkc' };
}

function projectsText(u: UserAccount, t: UsersText, roleWord: (r: string) => string): string {
  if (u.memberships.length > 0)
    return u.memberships.map((m) => t.membership({ project: m.project, role: roleWord(m.role) })).join(', ');
  return u.role === 'owner' || u.role === 'admin' ? t.allProjects : t.noProjects;
}

function OneTimePassword(props: { readonly created: CreatedUser; readonly onDone: () => void }): ReactNode {
  const t = useT().settings.users;
  return (
    <DyNotice tone="amber" live title={t.oneTimeTitle({ username: props.created.username })}>
      <p className="m-0 mt-1 text-[0.8125rem]">{t.oneTimeBody}</p>
      <p
        className="m-0 mt-2 rounded-[9px] border border-dy-line bg-dy-card px-3 py-2 font-dy-mono text-[0.875rem] break-all text-dy-ink"
        data-testid="temporary-password"
      >
        {props.created.temporaryPassword}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <DyCopyButton text={props.created.temporaryPassword} label={t.copyPassword} />
        <DyButton variant="primary" onClick={props.onDone}>
          {t.delivered}
        </DyButton>
      </div>
    </DyNotice>
  );
}

function CreateUserForm(props: {
  readonly onCreated: (u: CreatedUser) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const stepUp = useStepUp();
  const submit = useSubmit();
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [invalid, setInvalid] = useState<string | null>(null);
  const t = useT().settings.users;
  const roles = useRoles();

  function onSubmit(e: SubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    const name = username.trim().toLowerCase();
    if (!USERNAME.test(name)) {
      setInvalid(t.usernameRule);
      return;
    }
    setInvalid(null);
    void submit.run(async () => {
      try {
        const created = await stepUp.run(() => createUser(name, role), t.createStepUp);
        setUsername('');
        props.onCreated(created);
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  }

  return (
    <form onSubmit={onSubmit} aria-label={t.create} className="grid gap-3 sm:grid-cols-[1fr_12rem]">
      <DyField
        label={t.username}
        value={username}
        mono
        autoComplete="off"
        spellCheck={false}
        error={invalid}
        onChange={setUsername}
      />
      <DySelect
        label={t.accountRole}
        value={role}
        options={roles.options}
        onChange={(v) => {
          setRole(v as Role);
        }}
      />
      <div className="sm:col-span-2">
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
      <FormActions className="sm:col-span-2">
        <DyButton type="submit" variant="primary" busy={submit.busy}>
          {t.create}
        </DyButton>
        <DyButton variant="ghost" onClick={props.onCancel}>
          {t.cancel}
        </DyButton>
      </FormActions>
    </form>
  );
}

function ManageUser(props: {
  readonly user: UserAccount;
  readonly onChanged: (u: UserAccount) => void;
  /** After a recovery: the list is read again (lock state). */
  readonly onDone: () => void;
  /** Owners change roles and disable accounts; admins only recover operators / viewers (p17-panel-settings). */
  readonly owner: boolean;
}): ReactNode {
  const { user } = props;
  const stepUp = useStepUp();
  const submit = useSubmit();
  const [role, setRole] = useState<Role>(user.role);
  const t = useT().settings.users;
  const roles = useRoles();
  const act = (fn: () => Promise<UserAccount>, why: string): void => {
    void submit.run(async () => {
      try {
        props.onChanged(await stepUp.run(fn, why));
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };
  if (!props.owner)
    return (
      <div className="flex flex-col gap-4" aria-label={t.userGroup({ username: user.username })} role="group">
        <RecoverySection user={user} onDone={props.onDone} />
      </div>
    );
  return (
    <div className="flex flex-col gap-4" aria-label={t.userGroup({ username: user.username })} role="group">
      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-[0.875rem] font-bold">{t.accountRole}</h3>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <DySelect
            label={t.roleFor({ username: user.username })}
            value={role}
            options={roles.options}
            onChange={(v) => {
              setRole(v as Role);
            }}
          />
          <DyButton
            disabled={role === user.role || submit.busy}
            onClick={() => {
              act(() => setUserRole(user.id, role), t.roleStepUp);
            }}
          >
            {t.changeRole}
          </DyButton>
        </div>
      </section>
      <section className="flex flex-col gap-2 border-t border-dy-line pt-4">
        <h3 className="m-0 text-[0.875rem] font-bold">{user.disabled ? t.disabledTitle : t.disableTitle}</h3>
        <p className="m-0 text-[0.875rem] text-dy-muted">{user.disabled ? t.disabledBody : t.disableBody}</p>
        <div>
          {user.disabled ? (
            <DyButton
              variant="secondary"
              disabled={submit.busy}
              onClick={() => {
                act(() => setUserDisabled(user.id, false), t.enableStepUp);
              }}
            >
              {t.enable}
            </DyButton>
          ) : (
            <ConfirmButton
              label={t.disable}
              question={t.disableQuestion({ username: user.username })}
              confirmLabel={t.disableConfirm}
              disabled={submit.busy}
              testId="user-disable"
              onConfirm={() => {
                act(() => setUserDisabled(user.id, true), t.disableStepUp);
              }}
            />
          )}
        </div>
      </section>
      <RecoverySection user={user} onDone={props.onDone} />
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </div>
  );
}

/**
 * p17-panel-settings Part 4 (docs/design/p17-panel-settings.md §6): authenticator reset, password reset (a one-time
 * password shown once), unlock — each with an always-fresh code; the master may answer "a second owner must approve".
 */
function RecoverySection(props: { readonly user: UserAccount; readonly onDone: () => void }): ReactNode {
  const { user } = props;
  const t = useT().panelSettings.recovery;
  const stepUp = useStepUp();
  const submit = useSubmit();
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<RecoveryOutcome | null>(null);
  const run = (action: RecoveryAction): void => {
    setResult(null);
    void submit.run(async () => {
      try {
        setResult(
          await stepUp.run(() => recoverUser(user.id, action, reason), t.stepUp({ user: user.username })),
        );
        props.onDone();
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };
  return (
    <section className="flex flex-col gap-2 border-t border-dy-line pt-4" data-testid="user-recovery">
      <h3 className="m-0 text-[0.875rem] font-bold">{t.title}</h3>
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.sub}</p>
      {user.role === 'owner' ? (
        <p className="m-0 text-[0.8125rem] text-dy-amber-ink">
          {t.ownerApprovalBody({ user: user.username })}
        </p>
      ) : null}
      <DyField label={t.reason} value={reason} onChange={setReason} maxLength={300} />
      <div className="flex flex-wrap gap-2">
        <ConfirmButton
          label={t.resetMfa}
          question={t.resetMfaBody({ user: user.username })}
          confirmLabel={t.confirm}
          disabled={submit.busy}
          testId="user-reset-mfa"
          onConfirm={() => {
            run('reset-mfa');
          }}
        />
        <ConfirmButton
          label={t.resetPassword}
          question={t.resetPasswordBody({ user: user.username })}
          confirmLabel={t.confirm}
          disabled={submit.busy}
          testId="user-reset-password"
          onConfirm={() => {
            run('reset-password');
          }}
        />
        {user.lockedUntil !== null ? (
          <ConfirmButton
            label={t.unlock}
            question={t.unlockBody({ user: user.username })}
            confirmLabel={t.confirm}
            disabled={submit.busy}
            testId="user-unlock"
            onConfirm={() => {
              run('unlock');
            }}
          />
        ) : null}
      </div>
      {result === null ? null : result.status === 'pending' ? (
        <DyNotice tone="amber" icon="shield" testId="user-recovery-pending">
          {t.requested}
        </DyNotice>
      ) : result.temporaryPassword !== null ? (
        <DyNotice tone="amber" icon="key" title={t.tempPassword} testId="user-recovery-password">
          <p className="m-0 text-[0.8125rem]">{t.tempPasswordHint}</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="font-dy-mono select-all">{result.temporaryPassword}</code>
            <DyCopyButton text={result.temporaryPassword} />
          </div>
        </DyNotice>
      ) : (
        <p className="m-0 text-[0.875rem] text-dy-green-ink" data-testid="user-recovery-done">
          {t.done}
        </p>
      )}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </section>
  );
}

/** p17-panel-settings Part 4: recoveries of an owner waiting for a second owner (approve / withdraw). */
function RecoveryRequests(props: { readonly onChanged: () => void }): ReactNode {
  const t = useT().panelSettings.recovery;
  const stepUp = useStepUp();
  const submit = useSubmit();
  const [items, setItems] = useState<readonly RecoveryRequest[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems(await listRecoveryRequests());
    } catch {
      setItems([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (items.length === 0 && shown === null) return null;
  return (
    <Panel title={t.pendingTitle} testId="user-recovery-requests">
      <ul className="m-0 grid list-none gap-2 p-0">
        {items.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">
              {t.pendingItem({
                action: t.actions[r.action] ?? r.action,
                user: r.target.username,
                by: r.requestedBy ?? '?',
              })}
              {r.reason === '' ? null : <span className="text-dy-muted"> — {r.reason}</span>}
            </span>
            <DyButton
              variant="primary"
              busy={submit.busy}
              onClick={() => {
                void submit.run(async () => {
                  try {
                    const out = await stepUp.run(
                      () => approveRecovery(r.id),
                      t.stepUp({ user: r.target.username }),
                    );
                    setShown(out.temporaryPassword);
                    await load();
                    props.onChanged();
                  } catch (err) {
                    if (!(err instanceof StepUpCancelledError)) throw err;
                  }
                });
              }}
            >
              {t.approve}
            </DyButton>
            <DyButton
              variant="ghost"
              onClick={() => {
                void submit.run(async () => {
                  await cancelRecovery(r.id);
                  await load();
                });
              }}
            >
              {t.cancel}
            </DyButton>
          </li>
        ))}
      </ul>
      {shown === null ? null : (
        <DyNotice tone="amber" icon="key" title={t.tempPassword} className="mt-2">
          <code className="font-dy-mono select-all">{shown}</code> <DyCopyButton text={shown} />
        </DyNotice>
      )}
      <DyApiError error={submit.error} />
    </Panel>
  );
}

export function UsersView(): ReactNode {
  const { state } = useAuth();
  const me = state.kind === 'signedIn' ? state.user : null;
  const [users, setUsers] = useState<UserAccount[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [created, setCreated] = useState<CreatedUser | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const t = useT().settings.users;
  const roles = useRoles();
  const roleWord = roles.word;

  const load = useCallback(async () => {
    try {
      setUsers(await listUsers());
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const isOwner = me?.role === 'owner';
  const managed = users?.find((u) => u.id === managing) ?? null;
  // The classic table's sortable columns (user ascending first, role by rank), kept in the URL.
  const [sort, setSort] = useSortParam(USER_SORT_KEYS, { initial: { key: 'user', dir: 'asc' } });
  const sorted = useMemo(() => sortRows(users ?? [], sort, USER_COMPARE), [users, sort]);
  const { pageItems, pagination } = useClientPage(sorted, { label: t.pages });
  const closeAdd = (): void => {
    setAdding(false);
    setCreated(null);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="dy-users">
      {error ? (
        error.status === 403 ? (
          <DyNotice tone="neutral" icon="shield">
            {t.forbidden}
          </DyNotice>
        ) : (
          <DyApiError error={error} />
        )
      ) : users === null ? (
        <Panel title={t.accounts} flush>
          <SkeletonRows label={t.loading} rows={3} />
        </Panel>
      ) : (
        <>
          {isOwner ? (
            <RecoveryRequests
              onChanged={() => {
                void load();
              }}
            />
          ) : null}
          <Panel
            title={t.accounts}
            count={String(users.length)}
            countLabel={t.accountCount({ n: users.length })}
            sub={t.sub}
            aside={
              <span className="flex flex-wrap gap-2">
                <DyButtonLink to="/projects" variant="ghost">
                  {t.memberships}
                </DyButtonLink>
                {isOwner ? (
                  <DyButton
                    variant="primary"
                    icon="plus"
                    onClick={() => {
                      setCreated(null);
                      setAdding(true);
                    }}
                  >
                    {t.add}
                  </DyButton>
                ) : null}
              </span>
            }
            flush
            testId="user-table"
          >
            <DySortBar
              keys={USER_SORT_KEYS}
              labels={t.sort}
              sort={sort}
              onSort={setSort}
              defaultNote={t.serverOrder}
              sortedNote={t.sortedNote}
              className="border-b border-dy-line"
              testId="user-sort"
            />
            <Rows label={t.list}>
              {pageItems.map((u) => {
                const st = statusOf(u, t);
                return (
                  <Row
                    key={u.id}
                    testId="user-row"
                    lead={<DyIcon name="key" className="size-4" />}
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        <span translate="no">{u.username}</span>
                        {u.id === me?.id ? (
                          <span className="text-[0.78125rem] font-normal text-dy-muted">{t.you}</span>
                        ) : null}
                        <Pill tone="neutral">{roleWord(u.role)}</Pill>
                        <span data-testid="user-status">
                          <Pill tone={st.tone} icon={st.icon}>
                            {st.word}
                          </Pill>
                        </span>
                      </span>
                    }
                    meta={
                      <>
                        <span>{projectsText(u, t, roleWord)}</span>
                        <span>
                          {u.lastLoginAt ? (
                            <>
                              {t.lastLogin} <DyTime iso={u.lastLoginAt} />
                            </>
                          ) : (
                            t.neverLoggedIn
                          )}
                        </span>
                      </>
                    }
                    actions={
                      (isOwner || (me?.role === 'admin' && (u.role === 'operator' || u.role === 'viewer'))) &&
                      u.id !== me.id ? (
                        <DyButton
                          aria-label={t.manageAria({ username: u.username })}
                          onClick={() => {
                            setManaging(u.id);
                          }}
                        >
                          {t.manage}
                        </DyButton>
                      ) : undefined
                    }
                  />
                );
              })}
            </Rows>
          </Panel>
          <DyPager {...pagination} />
        </>
      )}
      <DyDialog
        open={adding}
        onClose={closeAdd}
        title={created ? t.created : t.add}
        description={created ? undefined : t.addHint}
      >
        {created ? (
          <OneTimePassword created={created} onDone={closeAdd} />
        ) : (
          <CreateUserForm
            onCancel={closeAdd}
            onCreated={(u) => {
              setCreated(u);
              void load();
            }}
          />
        )}
      </DyDialog>
      <DyDialog
        open={managed !== null}
        onClose={() => {
          setManaging(null);
        }}
        title={managed ? t.manageAria({ username: managed.username }) : t.manageTitle}
        description={managed ? projectsText(managed, t, roleWord) : undefined}
      >
        {managed ? (
          <ManageUser
            key={managed.id}
            user={managed}
            owner={isOwner}
            onDone={() => {
              void load();
            }}
            onChanged={(next) => {
              setUsers((list) => (list ?? []).map((x) => (x.id === next.id ? next : x)));
            }}
          />
        ) : null}
      </DyDialog>
    </div>
  );
}
