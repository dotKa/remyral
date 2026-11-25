import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../../../api/client';
import {
  checkLogin,
  type LoginRuntime,
  logoutRuntime,
  type Op,
  RUNTIME_NAME,
  startLogin,
} from '../../../../api/remoteOps';
import {
  type AccountKind,
  type AccountRuntime,
  type AccountState,
  createRuntimeAccount,
  deleteRuntimeAccount,
  listRuntimeAccounts,
  type RuntimeAccount,
  updateRuntimeAccount,
} from '../../../../api/runtimeAccounts';
import { useLimitTexts } from '../../usage/limitText';
import { type CredentialView, listCredentials } from '../../../../api/vault';
import { toApiError } from '../../../../components/ui';
import { useSubmit } from '../../../../screens/useSubmit';
import { ConfirmButton, DyApiError, DyDialog, DyField, DyNotice } from '../../forms';
import { DyButton, DySelect, Pill } from '../../parts';
import type { Tone } from '../../../tone';
import { WindowLine } from '../shared';
import { useGuardedOp } from './runtimes-ops';
import { useT } from '../../../../i18n/I18nProvider';

/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md §7): the accounts of one runtime on a machine — the
 * configured one ("Varsayılan") and the added ones (subscription logins in their own folders on the worker, or vault
 * API keys). Each shows its kind, state, usage windows and running jobs; admins add, log in / out, check, make
 * default, pause / resume, rename and remove them — every write through step-up (remove: always-fresh). The master
 * keeps only labels, kinds, opaque ids and login states.
 */

const STATE_TONE: Readonly<Record<AccountState, Tone>> = {
  logged_in: 'green',
  needs_login: 'amber',
  paused: 'neutral',
  limited: 'red',
  unknown: 'neutral',
};

/** The vault credential kind an API-key account of a runtime needs. */
const CREDENTIAL_KIND: Readonly<Record<AccountRuntime, string>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
};

/** The provider whose key an API-key account needs (product names, not translated). */
const PROVIDER: Readonly<Record<AccountRuntime, string>> = {
  'claude-code': 'Anthropic', // i18n-ignore
  codex: 'OpenAI', // i18n-ignore
};

export function RuntimeAccounts(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly runtime: LoginRuntime;
  readonly manage: boolean;
  readonly onLogin: (runtime: LoginRuntime, op: Op) => void;
  /** Bumped by the parent after a login dialog closed (reload). */
  readonly refresh?: number;
}): ReactNode {
  const t = useT().machineRuntimes.accounts;
  const [accounts, setAccounts] = useState<readonly RuntimeAccount[] | null>(null);
  const [supported, setSupported] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await listRuntimeAccounts({ worker: props.workerId, runtime: props.runtime });
      setAccounts(r.accounts.filter((a) => a.workerId === props.workerId && a.runtime === props.runtime));
      const w = r.workers.find((x) => x.id === props.workerId);
      setSupported(w?.supported ?? r.accounts.some((a) => a.supported));
      setLoadError(null);
    } catch (err) {
      setLoadError(toApiError(err));
    }
  }, [props.workerId, props.runtime]);
  useEffect(() => {
    void load();
  }, [load, props.refresh]);

  if (loadError !== null && accounts === null) {
    // Older master without accounts: the single login block above is all there is.
    return [401, 403, 404].includes(loadError.status) ? null : <DyApiError error={loadError} />;
  }
  if (accounts === null) return null;
  const name = RUNTIME_NAME[props.runtime];
  const def = accounts.find((a) => a.isDefault);
  const configured = accounts.find((a) => a.id === 'default');
  const showHint =
    configured !== undefined &&
    configured.kind === 'subscription' &&
    !configured.lendable &&
    accounts.some((a) => a.id !== 'default' && a.lendable);
  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-dy-line px-3.5 py-3"
      data-testid={`accounts-${props.runtime}`}
      aria-label={t.label({ runtime: name })}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[0.8125rem] font-bold">
          {t.title} <span className="font-normal text-dy-muted">({String(accounts.length)})</span>
        </span>
        {props.manage && supported ? (
          <DyButton
            icon="plus"
            onClick={() => {
              setAdding(true);
            }}
            data-testid={`account-add-${props.runtime}`}
          >
            {t.add}
          </DyButton>
        ) : null}
      </div>
      {!supported ? (
        <p className="m-0 text-[0.8125rem] text-dy-amber-ink" data-testid="accounts-unsupported">
          {t.unsupported}
        </p>
      ) : null}
      {showHint ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="accounts-default-hint">
          {t.defaultHint}
        </p>
      ) : null}
      <ul className="m-0 grid list-none gap-2 p-0">
        {accounts.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            preferred={def?.id === a.id}
            workerName={props.workerName}
            manage={props.manage && supported}
            onChanged={load}
            onLogin={props.onLogin}
          />
        ))}
      </ul>
      {adding ? (
        <AddAccountDialog
          workerId={props.workerId}
          workerName={props.workerName}
          runtime={props.runtime}
          onClose={() => {
            setAdding(false);
            void load();
          }}
          onLogin={props.onLogin}
        />
      ) : null}
    </section>
  );
}

function AccountRow(props: {
  readonly account: RuntimeAccount;
  readonly preferred: boolean;
  readonly workerName: string;
  readonly manage: boolean;
  readonly onChanged: () => Promise<void>;
  readonly onLogin: (runtime: LoginRuntime, op: Op) => void;
}): ReactNode {
  const t = useT().machineRuntimes.accounts;
  const lt = useLimitTexts();
  const a = props.account;
  const submit = useSubmit();
  const guarded = useGuardedOp();
  const [renaming, setRenaming] = useState<string | null>(null);
  const rt: LoginRuntime = a.runtime;
  const where = t.where({ machine: props.workerName, runtime: RUNTIME_NAME[rt], label: a.label });
  const accountArg = a.id === 'default' ? undefined : a.id;
  const run = (fn: () => Promise<unknown>, why: string, after?: (v: unknown) => void): void => {
    void submit.run(async () => {
      const r = await guarded(fn, why);
      if (r === null) return;
      after?.(r);
      await props.onChanged();
    });
  };
  const patch = (body: Parameters<typeof updateRuntimeAccount>[3], why: string): void => {
    run(() => updateRuntimeAccount(a.workerId, a.runtime, a.id, body), `${where} — ${why}`);
  };
  const needsLogin = a.kind === 'subscription' && a.login.status !== 'logged_in';
  const now = Date.now();
  return (
    <li
      className="flex min-w-0 flex-col gap-2 rounded-[9px] bg-dy-sunk px-3 py-2.5"
      data-testid={`account-${a.runtime}-${a.id}`}
      data-state={a.state}
    >
      <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem]">
          <span className="font-bold" data-testid="account-label">
            {a.label}
          </span>
          <Pill tone={a.kind === 'api_key' ? 'violet' : 'teal'}>{t.kinds[a.kind]}</Pill>
          <span data-testid="account-state">
            <Pill tone={STATE_TONE[a.state]}>{t.states[a.state]}</Pill>
          </span>
          {props.preferred ? (
            <Pill tone="neutral" icon="flag">
              {t.preferred}
            </Pill>
          ) : null}
          {a.running > 0 ? <span className="text-dy-muted">{t.running({ n: a.running })}</span> : null}
          {a.limit !== null ? (
            <span className="text-dy-red-ink" data-testid="account-limit">
              {t.limited({ when: lt.resetText(a.limit.resetAt ?? a.limit.resumeAt, now) })}
            </span>
          ) : null}
          {a.paused && a.pausedReason !== null ? (
            <span className="text-dy-muted">({a.pausedReason})</span>
          ) : null}
        </div>
        {props.manage ? (
          <div className="flex flex-wrap gap-1.5">
            {a.kind === 'subscription' ? (
              <>
                <DyButton
                  variant={needsLogin ? 'warn' : 'secondary'}
                  icon="key"
                  busy={submit.busy}
                  data-testid={`account-login-${a.id}`}
                  onClick={() => {
                    run(
                      () => startLogin(a.workerId, rt, accountArg),
                      `${where} — ${t.whyLogIn}`,
                      (op) => {
                        props.onLogin(rt, op as Op);
                      },
                    );
                  }}
                >
                  {a.login.status === 'logged_in' || a.login.status === 'expired' ? t.loginAgain : t.logIn}
                </DyButton>
                <DyButton
                  busy={submit.busy}
                  onClick={() => {
                    run(() => checkLogin(a.workerId, rt, accountArg), `${where} — ${t.whyCheck}`);
                  }}
                >
                  {t.check}
                </DyButton>
                {a.login.status === 'logged_in' || a.login.status === 'expired' ? (
                  <ConfirmButton
                    label={t.logOut}
                    question={t.logOutQuestion({ label: a.label })}
                    busy={submit.busy}
                    onConfirm={() => {
                      run(() => logoutRuntime(a.workerId, rt, accountArg), `${where} — ${t.whyLogOut}`);
                    }}
                  />
                ) : null}
              </>
            ) : null}
            {!props.preferred ? (
              <DyButton
                busy={submit.busy}
                data-testid={`account-default-${a.id}`}
                onClick={() => {
                  patch({ isDefault: true }, t.whyDefault);
                }}
              >
                {t.makeDefault}
              </DyButton>
            ) : null}
            <DyButton
              busy={submit.busy}
              data-testid={`account-pause-${a.id}`}
              onClick={() => {
                patch({ paused: !a.paused }, a.paused ? t.whyResume : t.whyPause);
              }}
            >
              {a.paused ? t.resume : t.pause}
            </DyButton>
            <DyButton
              busy={submit.busy}
              data-testid={`account-rename-${a.id}`}
              onClick={() => {
                setRenaming(a.label);
              }}
            >
              {t.rename}
            </DyButton>
            {a.id === 'default' ? null : (
              <ConfirmButton
                label={t.delete}
                testId={`account-delete-${a.id}`}
                question={t.deleteQuestion({ label: a.label })}
                busy={submit.busy}
                onConfirm={() => {
                  run(() => deleteRuntimeAccount(a.workerId, a.runtime, a.id), `${where} — ${t.whyDelete}`);
                }}
              />
            )}
          </div>
        ) : null}
      </div>
      {a.usage !== null && a.usage.windows.length > 0 ? (
        <ul className="m-0 grid list-none gap-2 p-0" data-testid="account-windows">
          {a.usage.windows.slice(0, 2).map((w) => (
            <WindowLine key={w.id} runtime={a.runtime} window={w} nearThreshold={80} now={now} />
          ))}
        </ul>
      ) : null}
      {renaming !== null ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const label = renaming.trim();
            if (label === '') return;
            setRenaming(null);
            patch({ label }, t.whyRename);
          }}
        >
          <DyField label={t.newName} value={renaming} maxLength={64} onChange={setRenaming} />
          <DyButton type="submit" variant="primary">
            {t.save}
          </DyButton>
          <DyButton
            variant="ghost"
            onClick={() => {
              setRenaming(null);
            }}
          >
            {t.cancel}
          </DyButton>
        </form>
      ) : null}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </li>
  );
}

function AddAccountDialog(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly runtime: LoginRuntime;
  readonly onClose: () => void;
  readonly onLogin: (runtime: LoginRuntime, op: Op) => void;
}): ReactNode {
  const t = useT().machineRuntimes.accounts;
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<AccountKind>('subscription');
  const [credentialId, setCredentialId] = useState('');
  const [credentials, setCredentials] = useState<readonly CredentialView[] | null>(null);
  const submit = useSubmit();
  const guarded = useGuardedOp();
  const name = RUNTIME_NAME[props.runtime];
  useEffect(() => {
    if (kind !== 'api_key' || credentials !== null) return;
    void listCredentials()
      .then((list) => {
        const fit = list.filter(
          (c) =>
            c.state === 'active' &&
            c.kind === CREDENTIAL_KIND[props.runtime] &&
            (c.workers.length === 0 || c.workers.some((w) => w.workerId === props.workerId)),
        );
        setCredentials(fit);
        if (fit[0] !== undefined) setCredentialId(fit[0].id);
      })
      .catch(() => {
        setCredentials([]);
      });
  }, [kind, credentials, props.runtime, props.workerId]);
  const ready = label.trim() !== '' && (kind === 'subscription' || credentialId !== '');
  const save = (): void => {
    void submit.run(async () => {
      const created = await guarded(
        () =>
          createRuntimeAccount(props.workerId, {
            runtime: props.runtime,
            label: label.trim(),
            kind,
            ...(kind === 'api_key' ? { credentialId } : {}),
          }),
        t.whyAdd({ machine: props.workerName, runtime: name }),
      );
      if (created === null) return;
      if (created.kind === 'subscription') {
        const op = await guarded(
          () => startLogin(props.workerId, props.runtime, created.id),
          t.whyAddLogin({ machine: props.workerName, runtime: name, label: created.label }),
        );
        props.onClose();
        if (op !== null) props.onLogin(props.runtime, op);
        return;
      }
      props.onClose();
    });
  };
  return (
    <DyDialog
      open
      onClose={props.onClose}
      title={t.addTitle({ runtime: name })}
      description={t.addDescription}
      testId="account-add-dialog"
      backdropClose={false}
      footer={
        <>
          <DyButton variant="ghost" onClick={props.onClose}>
            {t.cancel}
          </DyButton>
          <DyButton variant="primary" busy={submit.busy} disabled={!ready} onClick={save}>
            {kind === 'subscription' ? t.addAndLogIn : t.addOnly}
          </DyButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <DyField label={t.name} value={label} maxLength={64} onChange={setLabel} hint={t.nameHint} />
        <DySelect
          label={t.kind}
          value={kind}
          options={[
            ['subscription', t.kindSubscription],
            ['api_key', t.kindApiKey],
          ]}
          onChange={(v) => {
            setKind(v === 'api_key' ? 'api_key' : 'subscription');
          }}
        />
        {kind === 'api_key' ? (
          credentials === null ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.loadingKeys}</p>
          ) : credentials.length === 0 ? (
            <DyNotice tone="amber">{t.noKey({ provider: PROVIDER[props.runtime] })}</DyNotice>
          ) : (
            <DySelect
              label={t.vaultKey}
              value={credentialId}
              options={credentials.map((c) => [c.id, c.name] as const)}
              onChange={setCredentialId}
            />
          )
        ) : null}
        {kind === 'api_key' ? <p className="m-0 text-[0.8125rem] text-dy-muted">{t.apiKeyNote}</p> : null}
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </DyDialog>
  );
}
