import { type ReactNode, useEffect, useState } from 'react';
import type { ApiError } from '../../../../api/client';
import {
  listMembers,
  listUsers,
  type Member,
  type Project,
  type ProjectRole,
  PROJECT_ROLES,
  removeMember,
  setMember,
  type UserAccount,
} from '../../../../api/directory';
import { DyPager } from '../../../common/pager';
import { toApiError } from '../../../../components/ui';
import { useClientPage } from '../../../../lib/pager';
import { usePrivileged } from '../../../../screens/privileged';
import { ConfirmButton, DyApiError } from '../../forms';
import { DyButton, DySelect, EmptyLine, ErrorLine, Panel, Pill, Row, Rows, SkeletonRows } from '../../parts';
import { roleText } from '../states';
import { useT } from '../../../../i18n/I18nProvider';

/**
 * Projeler → Üyeler in the Diyalog language (p12-diyalog wave 2, W3): the project's members with their project role
 * and the role they act as, pages of 25 in the URL (`?membersPage=`, the classic `useClientPage`), and for owners /
 * admins: make operator / viewer, remove (confirmed), add an operator or viewer account. Same calls and step-up as
 * the classic `MembershipEditor` (`usePrivileged`: a cancelled code dialog is not an error).
 */

export function MembersTab(props: { readonly project: Project; readonly canEdit: boolean }): ReactNode {
  const words = useT().projects;
  const t = words.members;
  const roleWord = (r: string): string => roleText(r, words);
  const { project, canEdit } = props;
  const [members, setMembers] = useState<Member[] | null>(null);
  const memberPage = useClientPage(members ?? [], { label: t.pages, prefix: 'members' });
  const [error, setError] = useState<ApiError | null>(null);
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [newUser, setNewUser] = useState('');
  const [newRole, setNewRole] = useState<ProjectRole>('viewer');
  const { submit, run } = usePrivileged();

  useEffect(() => {
    let live = true;
    setMembers(null);
    listMembers(project.id).then(
      (m) => {
        if (live) setMembers(m);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    if (canEdit) {
      listUsers().then(
        (u) => {
          if (live) setUsers(u);
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [project.id, canEdit]);

  // Owner / admin accounts are global; only per-project accounts that are not yet members can be added.
  const candidates = users.filter(
    (u) =>
      (u.role === 'operator' || u.role === 'viewer') &&
      !u.disabled &&
      !(members ?? []).some((m) => m.userId === u.id),
  );

  return (
    <Panel
      title={t.title}
      count={members === null ? undefined : String(members.length)}
      countLabel={members === null ? undefined : t.count({ n: members.length })}
      sub={t.sub}
      flush
      testId="dy-project-members"
    >
      {error === null ? null : (
        <div className="px-4">
          <ErrorLine error={error} what={t.what} />
        </div>
      )}
      {members === null && error === null ? <SkeletonRows label={t.loading} rows={2} /> : null}
      {members !== null && members.length === 0 ? <EmptyLine>{t.empty}</EmptyLine> : null}
      {members !== null && members.length > 0 ? (
        <Rows label={t.rows} testId="dy-member-rows">
          {memberPage.pageItems.map((m) => {
            const other: ProjectRole = m.role === 'operator' ? 'viewer' : 'operator';
            return (
              <Row
                key={m.userId}
                testId="dy-member"
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span translate="no">{m.username}</span>
                    {m.disabled ? <Pill tone="neutral">{t.disabled}</Pill> : null}
                  </span>
                }
                meta={
                  <>
                    <span>{t.projectRole({ role: roleWord(m.role) })}</span>
                    {m.effectiveRole !== m.role ? (
                      <span>
                        {t.actsAs({ role: roleWord(m.effectiveRole), account: roleWord(m.accountRole) })}
                      </span>
                    ) : null}
                  </>
                }
                actions={
                  canEdit ? (
                    <>
                      <DyButton
                        disabled={submit.busy}
                        aria-label={t.makeLabel({ user: m.username, role: roleWord(other) })}
                        onClick={() => {
                          run(async () => {
                            setMembers(await setMember(project.id, m.userId, other));
                          }, t.changeStepUp);
                        }}
                      >
                        {t.make({ role: roleWord(other) })}
                      </DyButton>
                      <ConfirmButton
                        label={t.remove}
                        question={t.removeQuestion({ user: m.username })}
                        disabled={submit.busy}
                        testId={`remove-member-${m.username}`}
                        onConfirm={() => {
                          run(async () => {
                            setMembers(await removeMember(project.id, m.userId));
                          }, t.removeStepUp);
                        }}
                      />
                    </>
                  ) : undefined
                }
              />
            );
          })}
        </Rows>
      ) : null}
      {members !== null ? <DyPager {...memberPage.pagination} className="px-4 pb-3" /> : null}
      {canEdit && members !== null ? (
        <form
          aria-label={t.addLabel({ project: project.id })}
          className="grid gap-3 border-t border-dy-line px-4 pt-3 pb-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (newUser === '') return;
            run(async () => {
              setMembers(await setMember(project.id, newUser, newRole));
              setNewUser('');
            }, t.addStepUp);
          }}
        >
          <DySelect
            label={t.user}
            value={newUser}
            options={[
              ['', candidates.length > 0 ? t.pickUser : t.noCandidates],
              ...candidates.map(
                (u) => [u.id, t.userOption({ user: u.username, role: roleWord(u.role) })] as const,
              ),
            ]}
            onChange={setNewUser}
          />
          <DySelect
            label={t.role}
            value={newRole}
            options={PROJECT_ROLES.map((r) => [r, roleWord(r)] as const)}
            onChange={(v) => {
              const r = PROJECT_ROLES.find((x) => x === v);
              if (r !== undefined) setNewRole(r);
            }}
          />
          <DyButton type="submit" variant="primary" icon="plus" disabled={newUser === ''} busy={submit.busy}>
            {t.add}
          </DyButton>
        </form>
      ) : null}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} className="px-4 pb-4" />
    </Panel>
  );
}
