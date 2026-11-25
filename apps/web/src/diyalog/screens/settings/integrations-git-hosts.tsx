import type { Messages } from '@remyral/i18n';
import {
  BITBUCKET_TOKEN_KINDS,
  GITLAB_COM_URL,
  GITLAB_TOKEN_KINDS,
  type GitHostTokenKindName,
} from '@remyral/protocol/git-host-rules';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../../api/client';
import {
  createGitHost,
  deleteGitHost,
  type GitHostConnection,
  type GitHostInput,
  type GitHostKind,
  type GitHostTest,
  listGitHosts,
  parseGitHostTest,
  patchGitHost,
  rotateGitHost,
  testGitHost,
  testGitHostDraft,
} from '../../../api/gitHosts';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { ConfirmButton, DyApiError, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, DySelect, EmptyLine, Panel, Pill, SkeletonRows } from '../parts';
import { useGuardedOp } from './integrations-ops';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p16-git-providers (ADR-0061) — Ayarlar → Entegrasyonlar → GitLab ve Bitbucket: the master-held access tokens of
 * GitLab (gitlab.com / self-managed) and Bitbucket Cloud. A token field is write-only (the master never returns one;
 * the browser forgets it after the request); "Bağlantıyı test et" asks the host before anything is saved; saving,
 * entering a new token, rotating (GitLab) and removing ask a fresh authenticator code.
 */

type Words = Messages['gitHosts'];

/** A test result code in words (`push_…` prefixes the push token). */
export function testReason(t: Words['settings'], code: string): string {
  const push = code.startsWith('push_');
  const base = push ? code.slice(5) : code;
  const known = t.codes as unknown as Readonly<Record<string, unknown>>;
  const word = typeof known[base] === 'string' ? known[base] : t.codes.other({ code: base });
  return `${push ? t.codes.push : ''}${word}`;
}

function TestLine(props: { readonly test: GitHostTest }): ReactNode {
  const t = useT().gitHosts.settings;
  const f = useFormat();
  const r = props.test;
  if (!r.ok)
    return (
      <DyNotice tone="red" live>
        <span data-testid="git-host-test">{t.testFailed({ reason: testReason(t, r.code) })}</span>
        {r.missingScopes.length > 0 ? (
          <span className="font-dy-mono"> ({r.missingScopes.join(', ')})</span>
        ) : null}
      </DyNotice>
    );
  return (
    <DyNotice tone="green" live>
      <span data-testid="git-host-test">{t.testOk({ name: r.tokenName ?? '' })}</span>
      {r.scopes.length > 0 ? <span> {t.testScopes({ scopes: r.scopes.join(', ') })}.</span> : null}
      {r.expiresAt === null ? null : <span> {t.testExpires({ date: f.date(r.expiresAt) })}.</span>}
    </DyNotice>
  );
}

const tokenKindsOf = (kind: GitHostKind): readonly GitHostTokenKindName[] =>
  kind === 'gitlab' ? GITLAB_TOKEN_KINDS : BITBUCKET_TOKEN_KINDS;

/** The add form: kind, name, address (GitLab), token kind + scope, API token, optional push token, expiry. */
function AddForm(props: { readonly onSaved: () => void; readonly onCancel: () => void }): ReactNode {
  const w = useT().gitHosts;
  const t = w.settings;
  const [kind, setKind] = useState<GitHostKind>('gitlab');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState(GITLAB_COM_URL);
  const [tokenKind, setTokenKind] = useState<GitHostTokenKindName>('group');
  const [scope, setScope] = useState('');
  const [token, setToken] = useState('');
  const [pushToken, setPushToken] = useState('');
  const [expires, setExpires] = useState('');
  const [test, setTest] = useState<GitHostTest | null>(null);
  const act = useSubmit();
  const guarded = useGuardedOp();

  const input = (): GitHostInput => ({
    kind,
    label: label.trim(),
    ...(kind === 'gitlab' ? { baseUrl: baseUrl.trim() } : {}),
    tokenKind,
    scope: scope.trim(),
    token: token.trim(),
    ...(pushToken.trim() === '' ? {} : { pushToken: pushToken.trim() }),
    ...(expires === '' ? {} : { expiresAt: `${expires}T00:00:00Z` }),
  });

  const runTest = async (): Promise<void> => {
    await act.run(async () => {
      setTest(await testGitHostDraft(input()));
    });
  };
  const save = async (): Promise<void> => {
    await act.run(async () => {
      try {
        const out = await guarded(() => createGitHost(input()), t.stepUpSave);
        if (out === null) return;
      } catch (err) {
        // A refused save carries the host's answer: show it like a test.
        if (err instanceof ApiError && typeof err.details.test === 'object' && err.details.test !== null) {
          try {
            setTest(parseGitHostTest(err.details.test));
          } catch {
            // Not a test result: the error line below says enough.
          }
        }
        throw err;
      }
      setToken('');
      setPushToken('');
      props.onSaved();
    });
  };

  return (
    <form
      aria-label={t.addTitle}
      className="flex flex-col gap-3"
      data-testid="git-host-add"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <DySelect
          label={t.kind}
          value={kind}
          options={[
            ['gitlab', w.kinds.gitlab],
            ['bitbucket', w.kinds.bitbucket],
          ]}
          onChange={(v) => {
            const next: GitHostKind = v === 'bitbucket' ? 'bitbucket' : 'gitlab';
            setKind(next);
            setTokenKind(next === 'gitlab' ? 'group' : 'repository');
            setTest(null);
          }}
        />
        <DyField label={t.label} value={label} placeholder={t.labelPlaceholder} onChange={setLabel} />
        {kind === 'gitlab' ? (
          <DyField
            label={t.baseUrl}
            value={baseUrl}
            mono
            spellCheck={false}
            autoComplete="off"
            hint={t.baseUrlHint}
            wrapClassName="sm:col-span-2"
            onChange={setBaseUrl}
          />
        ) : null}
        <DySelect
          label={t.tokenKind}
          value={tokenKind}
          options={tokenKindsOf(kind).map((k) => [k, w.tokenKinds[k]] as const)}
          onChange={(v) => {
            const k = tokenKindsOf(kind).find((x) => x === v);
            if (k !== undefined) setTokenKind(k);
          }}
        />
        <DyField
          label={t.scope}
          value={scope}
          mono
          spellCheck={false}
          autoComplete="off"
          placeholder={kind === 'gitlab' ? 'acme/web' : 'acme/app'} // i18n-ignore: example path
          hint={t.scopeHint({ kind })}
          onChange={setScope}
        />
      </div>
      <DyField
        label={t.token}
        type="password"
        autoComplete="off"
        value={token}
        hint={t.tokenHint({ kind })}
        onChange={setToken}
      />
      <DyField
        label={t.pushToken}
        type="password"
        autoComplete="off"
        value={pushToken}
        hint={t.pushTokenHint({ kind })}
        onChange={setPushToken}
      />
      <DyField label={t.expiresAt} type="date" value={expires} hint={t.expiresAtHint} onChange={setExpires} />
      <FormActions>
        <DyButton type="submit" variant="primary" busy={act.busy}>
          {t.save}
        </DyButton>
        <DyButton icon="retry" disabled={act.busy || token.trim() === ''} onClick={() => void runTest()}>
          {t.test}
        </DyButton>
        <DyButton variant="ghost" onClick={props.onCancel}>
          {t.cancel}
        </DyButton>
      </FormActions>
      {test === null ? null : <TestLine test={test} />}
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </form>
  );
}

/** One stored connection: facts, last test, and its actions. */
function ConnectionCard(props: { readonly c: GitHostConnection; readonly onChanged: () => void }): ReactNode {
  const w = useT().gitHosts;
  const t = w.settings;
  const f = useFormat();
  const { c } = props;
  const [test, setTest] = useState<GitHostTest | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice);
  const act = useSubmit();
  const guarded = useGuardedOp();

  const retest = async (): Promise<void> => {
    setNotice(null);
    await act.run(async () => {
      setTest(await testGitHost(c.id));
    });
  };
  const rotate = async (): Promise<void> => {
    setNotice(null);
    await act.run(async () => {
      const out = await guarded(() => rotateGitHost(c.id, 90), t.stepUpRotate);
      if (out === null) return;
      setNotice(t.rotated);
      props.onChanged();
    });
  };
  const replace = async (): Promise<void> => {
    setNotice(null);
    await act.run(async () => {
      const out = await guarded(
        () => patchGitHost(c.id, { expectedVersion: c.version, token: token.trim() }),
        t.stepUpReplace,
      );
      if (out === null) return;
      setToken('');
      setReplacing(false);
      setNotice(t.replaced);
      props.onChanged();
    });
  };
  const remove = async (): Promise<void> => {
    setNotice(null);
    await act.run(async () => {
      const out = await guarded(async () => {
        await deleteGitHost(c.id);
        return true;
      }, t.stepUpRemove);
      if (out === null) return;
      props.onChanged();
    });
  };

  const last = test ?? c.lastTest;
  return (
    <section
      aria-label={c.label}
      className="flex flex-col gap-2 rounded-[12px] border border-dy-line bg-dy-card p-3"
      data-testid={`git-host-${c.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-[0.9375rem]">{c.label}</strong>
        <Pill tone="neutral">{w.kinds[c.kind]}</Pill>
        {c.usable ? (
          <Pill tone="green" icon="checkc">
            {t.usable}
          </Pill>
        ) : (
          <Pill tone="red" icon="xc">
            {t.unusable}
          </Pill>
        )}
        <Pill tone={c.expiresAt === null ? 'neutral' : 'amber'} icon="clock">
          {c.expiresAt === null ? t.noExpiry : t.expires({ date: f.date(c.expiresAt) })}
        </Pill>
      </div>
      <p className="m-0 text-[0.84375rem] [overflow-wrap:anywhere] text-dy-muted">
        <span className="font-dy-mono">{c.webHost}</span> · {w.tokenKinds[c.tokenKind]}
        {c.scope === '' ? '' : ' · '}
        <span className="font-dy-mono">{c.scope}</span> · {t.fingerprint({ fp: c.tokenFingerprint })}
      </p>
      <p className="m-0 text-[0.84375rem]">
        {c.separatePushToken ? (
          t.pushSeparate
        ) : (
          <span className="text-dy-amber-ink" data-testid="git-host-push-shared">
            {t.pushShared}
          </span>
        )}
      </p>
      <p className="m-0 text-[0.84375rem] text-dy-muted">
        {c.projects.length === 0 ? t.unused : t.projects({ list: c.projects.join(', ') })}
      </p>
      <p className="m-0 text-[0.84375rem] text-dy-muted">
        {last === null
          ? t.neverTested
          : last.ok
            ? t.lastTestOk({ at: f.dateTime(last.checkedAt) })
            : t.lastTestFailed({ reason: testReason(t, last.code) })}
      </p>
      {test === null ? null : <TestLine test={test} />}
      {replacing ? (
        <form
          aria-label={t.replaceTitle}
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void replace();
          }}
        >
          <DyField
            label={t.replaceTitle}
            type="password"
            autoComplete="off"
            value={token}
            hint={t.replaceHint}
            onChange={setToken}
          />
          <FormActions>
            <DyButton type="submit" variant="primary" busy={act.busy} disabled={token.trim() === ''}>
              {t.save}
            </DyButton>
            <DyButton
              variant="ghost"
              onClick={() => {
                setReplacing(false);
                setToken('');
              }}
            >
              {t.cancel}
            </DyButton>
          </FormActions>
        </form>
      ) : (
        <FormActions>
          <DyButton icon="retry" disabled={act.busy} onClick={() => void retest()}>
            {t.retest}
          </DyButton>
          <DyButton
            icon="pen"
            disabled={act.busy}
            onClick={() => {
              setReplacing(true);
            }}
          >
            {t.replace}
          </DyButton>
          {c.kind === 'gitlab' && c.rotatable ? (
            <ConfirmButton
              label={t.rotate}
              question={t.rotateQuestion}
              disabled={act.busy}
              onConfirm={() => void rotate()}
            />
          ) : null}
          <ConfirmButton
            label={t.remove}
            question={t.removeQuestion}
            disabled={act.busy}
            onConfirm={() => void remove()}
          />
        </FormActions>
      )}
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </section>
  );
}

export function GitHostsPanel(): ReactNode {
  const t = useT().gitHosts.settings;
  const [items, setItems] = useState<GitHostConnection[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState(false);
  const load = useSubmit();
  const reload = useCallback(async () => {
    setItems(await listGitHosts());
  }, []);
  useEffect(() => {
    void load.run(reload);
    // load.run is stable.
  }, []);
  return (
    <Panel title={t.title} sub={t.sub} testId="dy-git-hosts">
      <div className="flex flex-col gap-3">
        <DyApiError error={load.error} retryLeft={load.retryLeft} />
        {items === null ? (
          load.error === null ? (
            <SkeletonRows label={t.loading} rows={2} />
          ) : null
        ) : items.length === 0 && !adding ? (
          <EmptyLine>{t.none}</EmptyLine>
        ) : (
          items.map((c) => (
            <ConnectionCard
              key={`${c.id}:${String(c.version)}`}
              c={c}
              onChanged={() => {
                setSaved(false);
                void load.run(reload);
              }}
            />
          ))
        )}
        {adding ? (
          <AddForm
            onSaved={() => {
              setAdding(false);
              setSaved(true);
              void load.run(reload);
            }}
            onCancel={() => {
              setAdding(false);
            }}
          />
        ) : (
          <div>
            <DyButton
              icon="plus"
              variant="primary"
              onClick={() => {
                setSaved(false);
                setAdding(true);
              }}
            >
              {t.add}
            </DyButton>
          </div>
        )}
        {saved ? (
          <DyNotice tone="green" live>
            {t.saved}
          </DyNotice>
        ) : null}
      </div>
    </Panel>
  );
}
