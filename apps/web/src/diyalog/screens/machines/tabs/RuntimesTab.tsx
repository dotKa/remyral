import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { CompatCell } from '../../../../api/fleet';
import {
  checkLogin,
  LOGIN_RUNTIMES,
  type LoginRuntime,
  type LoginStatus,
  logoutRuntime,
  type ManagedRuntime,
  type Op,
  OPS_RUNTIMES,
  RUNTIME_NAME,
  startLogin,
  TERMINAL_STATES,
} from '../../../../api/remoteOps';
import type { RuntimeInfo } from '../../../../api/workers';
import { DyReason } from '../../../common/notices';
import {
  reportReflects,
  type RuntimeAction,
  runtimeActions,
  useOp,
  useOpsStatus,
} from '../../../../screens/fleet/remoteOps';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyIcon } from '../../../icons';
import { RuntimeMark } from '../../../RuntimeMark';
import { ConfirmButton, DyApiError, DyNotice } from '../../forms';
import { DyButton, EmptyLine, Panel, Pill, SkeletonRows } from '../../parts';
import { FleetCellsProvider, FleetVersionLine } from '../fleet-tools-parts';
import { RuntimeAccounts } from './runtimes-accounts';
import { RuntimeProof, useWorkerVerification } from './runtimes-verify';
import type { WorkerVerification } from '../../../../api/runtimeVerification';
import { LoginDialog } from './runtimes-login';
import { OpLine, opWord, runtimeLook, StatePill, useGuardedOp } from './runtimes-ops';
import type { Messages } from '@remyral/i18n';
import { type MachineTabProps, operable } from './types';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import {
  type AuthExplanation,
  AuthExplanationNotice,
  type JobAuth,
  LoginNotUsedNote,
  authExplanation,
  explainedLook,
  jobAuthOf,
  loginAgrees,
  SYNC_POLL_MS,
  SYNC_TRIES,
  useJobAuthModes,
} from './runtimes-auth';
import { DATE_TIME_NUMERIC } from '../../../common/time';

/**
 * p12-diyalog wave 2 (W3) — Makine → Runtime’lar in the Diyalog language, feature for feature with the classic
 * `RuntimesPanel` (screens/fleet/RemoteOpsPanel.tsx; p5-remote-ops, ADR-0017): one row per runtime with its readiness,
 * versions and every action that applies (install / upgrade to the pin / roll back to the previous pin / reinstall a
 * modified install / restart / remove a version — the classic `runtimeActions` decides), the subscription login of
 * Claude Code and Codex (log in, check, log out; expired and refresh-contention notes), the live operation, and the
 * bounded reload until the machine's next report shows an ended install / remove (`reportReflects`). Every action goes
 * through step-up; roll back, remove and log out are confirmed first. Owners / admins on an operable machine with a
 * remote-ops worker build manage; everyone else sees what the machine reports.
 */

/** After an operation ended: how often / how long to reload until the machine's report shows it (as classic). */
const REPORT_POLL_MS = 1_500;
const REPORT_POLL_TRIES = 20;

type RuntimesText = Messages['machineRuntimes']['runtimes'];

interface LoginInfo {
  readonly status: LoginStatus;
  readonly method?: string;
  readonly reason?: string;
  readonly checkedAt?: string;
}

/** The action's label and confirmation (the action set and its rules are the classic ones). */
function actionText(
  a: RuntimeAction,
  r: ManagedRuntime,
  t: RuntimesText['actions'],
): { label: string; question?: string } {
  const runtime = RUNTIME_NAME[r.runtime];
  switch (a.key) {
    case 'install':
      return { label: t.install({ version: r.pinned }) };
    case 'upgrade':
      return { label: t.upgrade({ version: r.pinned }) };
    case 'rollback':
      return {
        label: t.rollback({ version: r.previous ?? '' }),
        question: t.rollbackQuestion({ runtime, version: r.previous ?? '' }),
      };
    case 'repair':
      return { label: t.repair({ version: r.active ?? '' }) };
    case 'restart':
      return { label: t.restart };
    default: {
      const version = a.key.startsWith('remove-') ? a.key.slice('remove-'.length) : '';
      return {
        label: t.remove({ version }),
        question: t.removeQuestion({ runtime, version, inUse: version === r.active }),
      };
    }
  }
}

/** Step-up reason for an action (what is done, on which runtime). */
function actionWhy(a: RuntimeAction, r: ManagedRuntime, machine: string, t: RuntimesText['actions']): string {
  const name = RUNTIME_NAME[r.runtime];
  return `${machine}: ${name} — ${actionText(a, r, t).label}`;
}

/** A not-ready runtime's reason (the master's code, in plain words with its fix); hidden for ready / not installed. */
function RuntimeReason(props: {
  readonly cell: CompatCell | undefined;
  readonly workerId: string;
  readonly workerName: string;
  readonly fixInRow: boolean;
}): ReactNode {
  const t = useT().machineRuntimes.runtimes;
  const c = props.cell;
  if (c === undefined || c.status === 'ready' || c.status === 'not_installed') return null;
  const inRow =
    props.fixInRow &&
    (c.status === 'not_authenticated' || c.status === 'pin_mismatch' || c.status === 'not_installed');
  return (
    <DyReason
      reason={`${c.status}: ${c.reason}`}
      context={{ workerId: props.workerId, workerName: props.workerName, runtime: c.runtime }}
      params={c.params}
      tone={c.status === 'unsupported' ? 'neutral' : 'attention'}
      {...(inRow ? { action: <span className="sr-only">{t.fixInRow}</span> } : {})}
    />
  );
}

function RowShell(props: {
  readonly runtime: string;
  readonly state: ReactNode;
  readonly facts: ReactNode;
  readonly actions?: ReactNode;
  readonly testId: string;
  readonly children?: ReactNode;
  readonly data?: { readonly runtime?: string; readonly status?: string | undefined };
  /** p16-runtime-updates: the unverified install / back-to-the-pin buttons (managing rows only). */
  readonly manage?: { readonly workerId: string; readonly workerName: string };
}): ReactNode {
  return (
    <li
      className="flex min-w-0 flex-col gap-3 border-t border-dy-line px-4 py-4 first:border-t-0"
      data-testid={props.testId}
      data-runtime={props.data?.runtime}
      data-status={props.data?.status}
    >
      <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h3 className="m-0 text-[0.9375rem] font-bold">
              <RuntimeMark runtime={props.runtime} />
            </h3>
            {props.state}
          </div>
          <div className="mt-1 text-[0.8125rem] text-dy-muted">{props.facts}</div>
          {/* p13-fleet-tools: installed · pin · en son + status from the fleet view (nothing on an older master). */}
          <FleetVersionLine item={props.runtime} manage={props.manage} />
        </div>
        {props.actions === undefined ? null : (
          <div className="flex flex-wrap gap-2 md:max-w-[60%] md:justify-end">{props.actions}</div>
        )}
      </div>
      {props.children}
    </li>
  );
}

function RuntimeRow(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly runtime: ManagedRuntime;
  readonly cell: CompatCell | undefined;
  readonly login: LoginInfo | null;
  readonly busy: boolean;
  readonly pending: string | null;
  readonly onStarted: (op: Op) => void;
  readonly onLogin: (runtime: LoginRuntime, op: Op) => void;
  /** p13-runtime-accounts: bumped after a login dialog closed (the accounts list reloads). */
  readonly accountsRefresh: number;
  /** p14-login-status-consistency: why the runtime is not signed in for jobs (null: the cell's own reason). */
  readonly explanation: AuthExplanation;
  /** How the machine's jobs authenticate this runtime (its applied configuration). */
  readonly jobAuth: JobAuth;
  /** After the jobs were switched to the subscription login (configuration saved). */
  readonly onAuthSwitched: () => void;
  /** p17-runtime-verify: the machine's proof view (null: an older master) and its reload. */
  readonly proof: WorkerVerification | null;
  readonly onProofChanged: () => void;
}): ReactNode {
  const fmt = useFormat();
  const all = useT();
  const tm = all.machines;
  const t = all.machineRuntimes.runtimes;
  const ops = all.machineRuntimes.ops;
  const r = props.runtime;
  const name = RUNTIME_NAME[r.runtime];
  const submit = useSubmit();
  const guarded = useGuardedOp();
  const isLogin = (LOGIN_RUNTIMES as readonly string[]).includes(r.runtime);
  const loginRuntime = r.runtime as LoginRuntime;
  const actions = runtimeActions(props.workerId, r);
  const start = (fn: () => Promise<Op>, why: string, then: (op: Op) => void = props.onStarted): void => {
    void submit.run(async () => {
      const started = await guarded(fn, why);
      if (started !== null) then(started);
    });
  };
  const status = props.login?.status ?? 'unknown';
  const contention = props.login?.reason === 'login_refresh_contention';
  const needsRelogin = status === 'expired' || props.login?.reason === 'login_expired' || contention;
  const modified = r.installed.filter((i) => i.integrity === 'modified');
  const v = (x: string): ReactNode => <span className="font-dy-mono text-dy-ink">{x}</span>;
  const facts: ReactNode[] = [
    r.active === null ? (
      t.notInstalled
    ) : (
      <>
        {t.version} {v(r.active)}
      </>
    ),
    <>
      {t.pinned} {v(r.pinned)}
    </>,
    r.previous === undefined ? null : (
      <>
        {t.previous} {v(r.previous)}
      </>
    ),
    t.installedWith({ method: r.method === 'binary' ? t.methodBinary : r.method }),
  ].filter((x) => x !== null);
  const explained = explainedLook(props.explanation, tm);
  const state =
    props.cell !== undefined ? (
      <StatePill look={explained ?? runtimeLook(props.cell.status, ops)} />
    ) : r.active === null ? (
      <StatePill look={runtimeLook('not_installed', ops)} />
    ) : null;
  const loginLook = runtimeLook(status, ops);
  return (
    <RowShell
      runtime={r.runtime}
      testId={`runtime-card-${r.runtime}`}
      manage={{ workerId: props.workerId, workerName: props.workerName }}
      state={state}
      facts={
        <span data-testid="runtime-active" className="flex flex-wrap gap-x-2.5 gap-y-0.5">
          {facts.map((f, i) => (
            <span key={i}>{f}</span>
          ))}
        </span>
      }
      actions={
        actions.length === 0 ? undefined : (
          <>
            {actions.map((a) => {
              const text = actionText(a, r, t.actions);
              const why = actionWhy(a, r, props.workerName, t.actions);
              return a.confirm !== undefined ? (
                <ConfirmButton
                  key={a.key}
                  label={text.label}
                  question={text.question}
                  variant={a.variant === 'danger' ? 'danger' : 'secondary'}
                  busy={submit.busy}
                  disabled={props.busy}
                  onConfirm={() => {
                    start(a.run, why);
                  }}
                />
              ) : (
                <DyButton
                  key={a.key}
                  variant={a.variant === 'danger' ? 'danger' : 'secondary'}
                  busy={submit.busy}
                  disabled={props.busy}
                  onClick={() => {
                    start(a.run, why);
                  }}
                >
                  {text.label}
                </DyButton>
              );
            })}
          </>
        )
      }
    >
      {props.pending !== null ? (
        <p
          className="m-0 flex items-center gap-2 text-[0.8125rem] text-dy-teal-ink"
          data-testid="runtime-pending"
        >
          <DyIcon name="retry" className="dy-breathe size-4" /> {props.pending}
        </p>
      ) : null}
      {r.installed.length > 1 || modified.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={t.installedVersions}>
          {r.installed.map((i) => (
            <li key={i.version} data-testid="runtime-installed">
              <Pill tone={i.integrity === 'modified' ? 'red' : 'neutral'} className="font-dy-mono">
                {i.version}
                {i.integrity === 'modified' ? ` — ${t.modified}` : ''}
              </Pill>
            </li>
          ))}
        </ul>
      ) : null}
      {!r.supported ? (
        <p className="m-0 text-[0.8125rem] text-dy-amber-ink" data-testid="runtime-unsupported">
          {t.cannotInstall}
          {r.unsupportedReason === undefined ? '' : `: ${r.unsupportedReason}`}
        </p>
      ) : null}
      {props.explanation !== null ? (
        <AuthExplanationNotice
          explanation={props.explanation}
          runtime={r.runtime}
          workerId={props.workerId}
          workerName={props.workerName}
          {...(isLogin ? { onSwitched: props.onAuthSwitched } : {})}
        />
      ) : (
        <RuntimeReason cell={props.cell} workerId={props.workerId} workerName={props.workerName} fixInRow />
      )}
      <RuntimeProof
        workerId={props.workerId}
        workerName={props.workerName}
        runtime={r.runtime}
        view={props.proof}
        manage
        onChanged={props.onProofChanged}
      />
      {isLogin ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-[10px] bg-dy-sunk px-3.5 py-3">
          <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem]">
              <span className="font-bold">{t.login}</span>
              <span data-testid={`login-status-${r.runtime}`} data-state={status}>
                <Pill tone={loginLook.tone} icon={loginLook.icon}>
                  {loginLook.word}
                </Pill>
              </span>
              {props.login?.method === undefined ? null : (
                <span className="text-dy-muted">{t.loginMethod({ method: props.login.method })}</span>
              )}
              {props.login?.checkedAt === undefined ? null : (
                <span className="text-dy-muted" data-testid={`login-checked-${r.runtime}`}>
                  {t.checkedAt({ when: fmt.dateWith(props.login.checkedAt, DATE_TIME_NUMERIC) })}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <DyButton
                variant={needsRelogin ? 'warn' : 'secondary'}
                icon="key"
                busy={submit.busy}
                onClick={() => {
                  start(
                    () => startLogin(props.workerId, loginRuntime),
                    t.whyLogIn({ machine: props.workerName, runtime: name }),
                    (op) => {
                      props.onLogin(loginRuntime, op);
                    },
                  );
                }}
              >
                {needsRelogin ? t.loginAgain : t.logIn}
              </DyButton>
              <DyButton
                busy={submit.busy}
                onClick={() => {
                  start(
                    () => checkLogin(props.workerId, loginRuntime),
                    t.whyCheck({ machine: props.workerName, runtime: name }),
                  );
                }}
              >
                {t.check}
              </DyButton>
              {status === 'logged_in' || status === 'expired' ? (
                <ConfirmButton
                  label={t.logOut}
                  question={t.logOutQuestion({ runtime: name })}
                  busy={submit.busy}
                  onConfirm={() => {
                    start(
                      () => logoutRuntime(props.workerId, loginRuntime),
                      t.whyLogOut({ machine: props.workerName, runtime: name }),
                    );
                  }}
                />
              ) : null}
            </div>
          </div>
          {needsRelogin ? (
            <p className="m-0 text-[0.8125rem] text-dy-amber-ink" data-testid={`login-expired-${r.runtime}`}>
              {contention
                ? t.contention({ runtime: name })
                : props.login?.reason === 'login_expired'
                  ? t.refreshFailed({ runtime: name })
                  : t.expired}
            </p>
          ) : null}
          {/* p14-login-status-consistency: an active login that jobs do not use says so (the notice above covers a
              not-signed-in runtime). */}
          {status === 'logged_in' &&
          props.explanation === null &&
          (props.jobAuth === 'secret-ref' || props.jobAuth === 'none') ? (
            <LoginNotUsedNote
              auth={props.jobAuth}
              runtime={r.runtime}
              workerId={props.workerId}
              workerName={props.workerName}
              onSwitched={props.onAuthSwitched}
            />
          ) : null}
        </div>
      ) : null}
      {isLogin ? (
        <RuntimeAccounts
          workerId={props.workerId}
          workerName={props.workerName}
          runtime={loginRuntime}
          manage
          onLogin={props.onLogin}
          refresh={props.accountsRefresh}
        />
      ) : null}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </RowShell>
  );
}

/** Read-only row (viewers, a worker build without remote operations, a machine nobody can operate). */
function ReportedRow(props: {
  readonly runtime: string;
  readonly cell: CompatCell | undefined;
  readonly info: RuntimeInfo | undefined;
  readonly workerId: string;
  readonly workerName: string;
}): ReactNode {
  const { cell, info } = props;
  const all = useT();
  const t = all.machineRuntimes.runtimes;
  const installed = info !== undefined && info.installed;
  const signed =
    info?.authenticated === 'yes' ? t.signedIn : info?.authenticated === 'no' ? t.signedOut : null;
  const facts = installed
    ? [
        t.versionFact({ version: info.version }),
        info.pinnedVersion ? t.pinnedFact({ version: info.pinnedVersion }) : null,
        signed,
      ].filter((x) => x !== null)
    : [];
  const st = cell?.status ?? (info?.installed === true ? 'unknown' : 'not_installed');
  return (
    <RowShell
      runtime={props.runtime}
      testId="runtime-row"
      data={{ runtime: props.runtime, status: cell?.status }}
      state={<StatePill look={runtimeLook(st, all.machineRuntimes.ops)} />}
      facts={facts.length > 0 ? facts.join(' · ') : null}
    >
      <RuntimeReason cell={cell} workerId={props.workerId} workerName={props.workerName} fixInRow={false} />
    </RowShell>
  );
}

function Reported(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly compatibility: readonly CompatCell[];
  readonly reported: readonly RuntimeInfo[];
}): ReactNode {
  const t = useT().machineRuntimes.runtimes;
  const present = props.reported.filter((r) => r.present);
  const ids = OPS_RUNTIMES.filter(
    (id) => props.compatibility.some((c) => c.runtime === id) || present.some((r) => r.runtime === id),
  );
  return (
    <Panel title={t.title} sub={t.reportedSub} flush testId="runtime-table">
      {ids.length === 0 ? (
        <EmptyLine>{t.noneReported}</EmptyLine>
      ) : (
        <ul className="m-0 list-none p-0">
          {ids.map((id) => (
            <ReportedRow
              key={id}
              runtime={id}
              cell={props.compatibility.find((c) => c.runtime === id)}
              info={present.find((r) => r.runtime === id)}
              workerId={props.workerId}
              workerName={props.workerName}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Managed(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly compatibility: readonly CompatCell[];
  readonly reported: readonly RuntimeInfo[];
  readonly onChanged: () => void;
}): ReactNode {
  const all = useT();
  const t = all.machineRuntimes.runtimes;
  const { status, error, load } = useOpsStatus(props.workerId);
  // p17-runtime-verify: one proof view for every row ("Doğrula", progress, results, history).
  const proof = useWorkerVerification(props.workerId);
  const [tracked, setTracked] = useState<Op | null>(null);
  const [login, setLogin] = useState<{ runtime: LoginRuntime; op: Op } | null>(null);
  const [awaiting, setAwaiting] = useState<{ readonly op: Op; readonly tries: number } | null>(null);
  const [accountsRefresh, setAccountsRefresh] = useState(0);
  /** p14-login-status-consistency: after a login operation, the runtime whose cell is reloaded until it agrees. */
  // `switched`: the jobs were just switched to the subscription login — wait for the applied configuration too.
  const [sync, setSync] = useState<{
    readonly runtime: string;
    readonly tries: number;
    readonly switched?: boolean;
  } | null>(null);
  const progress = useOp(props.workerId, tracked);
  const onChanged = props.onChanged;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const loginReport = status?.report?.login;
  // The machine's job auth is read when it can contradict the login row: a login runtime not signed in for jobs, or
  // a subscription login that is active (jobs may still use an API key).
  const authNeeded =
    props.compatibility.some(
      (c) => c.status === 'not_authenticated' && (LOGIN_RUNTIMES as readonly string[]).includes(c.runtime),
    ) ||
    (loginReport?.some((l) => l.status === 'logged_in') ?? false);
  const { modes: authModes, reload: reloadAuth } = useJobAuthModes(props.workerId, authNeeded);
  const defaultLogin = (rt: string): LoginStatus | undefined =>
    loginReport?.find((x) => x.runtime === rt)?.status;

  const ended = progress.op !== null && TERMINAL_STATES.has(progress.op.state) ? progress.op : null;
  useEffect(() => {
    if (ended !== null) setAwaiting({ op: ended, tries: 0 });
  }, [ended?.id, ended?.state]);

  useEffect(() => {
    if (awaiting === null) return;
    let live = true;
    const timer = setTimeout(
      () => {
        void load().then((s) => {
          if (!live) return;
          const done = s !== null && reportReflects(awaiting.op, s);
          if (done || awaiting.tries >= REPORT_POLL_TRIES) {
            setAwaiting(null);
            onChanged();
            const rt = awaiting.op.params.runtime;
            if (awaiting.op.kind.startsWith('login.') && typeof rt === 'string')
              setSync({ runtime: rt, tries: 0 });
          } else {
            setAwaiting({ op: awaiting.op, tries: awaiting.tries + 1 });
          }
        });
      },
      awaiting.tries === 0 ? 0 : REPORT_POLL_MS,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [awaiting, load, onChanged]);

  // p14-login-status-consistency: the machine re-sends CAPABILITIES after a login operation, which may land after the
  // single reload above — keep reloading (bounded) until the runtime's compatibility cell agrees with the login report.
  const syncCell = sync === null ? undefined : props.compatibility.find((c) => c.runtime === sync.runtime);
  const syncAuth = sync === null ? 'unknown' : jobAuthOf(authModes, sync.runtime, syncCell);
  const syncAgrees =
    sync === null ||
    ((sync.switched !== true || syncAuth === 'local-login') &&
      loginAgrees(syncCell, defaultLogin(sync.runtime), syncAuth));
  useEffect(() => {
    if (sync === null) return;
    if (syncAgrees || sync.tries >= (sync.switched === true ? 2 * SYNC_TRIES : SYNC_TRIES)) {
      setSync(null);
      return;
    }
    const timer = setTimeout(() => {
      onChangedRef.current();
      if (sync.switched === true) reloadAuth();
      setSync({ ...sync, tries: sync.tries + 1 });
    }, SYNC_POLL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [sync, syncAgrees, reloadAuth]);

  if (error !== null && status === null) {
    // Remote operations unavailable (an older master, a network error): still show what the machine reports.
    return (
      <div className="flex flex-col gap-4">
        <DyApiError error={error} />
        <Reported {...props} />
      </div>
    );
  }
  if (status === null)
    return (
      <Panel title={t.title} flush>
        <SkeletonRows label={t.loading} rows={3} />
      </Panel>
    );
  if (!status.supported || status.report === null) {
    return (
      <div className="flex flex-col gap-4">
        {!status.supported ? (
          <DyNotice tone="amber" title={t.remoteUnsupported}>
            <span data-testid="remote-ops-unsupported">{t.updateFirst}</span>
          </DyNotice>
        ) : (
          <p className="m-0 text-[0.875rem] text-dy-muted">{t.notReportedYet}</p>
        )}
        <Reported {...props} />
      </div>
    );
  }
  const report = status.report;
  const running = progress.op !== null && !TERMINAL_STATES.has(progress.op.state);
  const pendingFor = (rt: string): string | null => {
    const op = awaiting?.op;
    if (op === undefined || op.state !== 'succeeded' || op.params.runtime !== rt) return null;
    if (op.kind === 'runtime.install' || op.kind === 'runtime.remove')
      return t.awaitingReport({ what: opWord(op.kind, all.machineRuntimes.ops) });
    return null;
  };
  // ADR-0023: an older worker may still report a managed OpenHands install; only the current runtimes show.
  const rows = report.runtimes.filter((r) => (OPS_RUNTIMES as readonly string[]).includes(r.runtime));
  return (
    <div className="flex flex-col gap-4" data-testid="remote-ops">
      <DyApiError error={error} />
      {!status.connected ? (
        <DyNotice tone="amber" icon="xc">
          {t.offline}
        </DyNotice>
      ) : null}
      {progress.op !== null ? (
        <div
          className="rounded-[12px] border border-dy-line bg-dy-card px-4 py-3 shadow-dy"
          aria-live="polite"
        >
          <OpLine op={progress.op} />
        </div>
      ) : null}
      <Panel
        title={t.title}
        count={String(rows.length)}
        countLabel={t.count({ n: rows.length })}
        sub={t.managedSub}
        flush
      >
        <ul className="m-0 list-none p-0">
          {rows.map((r) => {
            const l = report.login.find((x) => x.runtime === r.runtime);
            const cell = props.compatibility.find((c) => c.runtime === r.runtime);
            const jobAuth = jobAuthOf(authModes, r.runtime, cell);
            return (
              <RuntimeRow
                key={r.runtime}
                workerId={props.workerId}
                workerName={props.workerName}
                runtime={r}
                cell={props.compatibility.find((c) => c.runtime === r.runtime)}
                login={
                  l === undefined
                    ? null
                    : {
                        status: l.status,
                        ...(l.method === undefined ? {} : { method: l.method }),
                        ...(l.reason === undefined ? {} : { reason: l.reason }),
                        ...(l.checkedAt === undefined ? {} : { checkedAt: l.checkedAt }),
                      }
                }
                busy={running}
                pending={pendingFor(r.runtime)}
                accountsRefresh={accountsRefresh}
                explanation={
                  (LOGIN_RUNTIMES as readonly string[]).includes(r.runtime)
                    ? authExplanation(cell, l?.status, jobAuth, sync?.runtime === r.runtime)
                    : null
                }
                jobAuth={jobAuth}
                proof={proof.view}
                onProofChanged={() => {
                  proof.reload();
                  onChanged();
                }}
                onAuthSwitched={() => {
                  reloadAuth();
                  onChanged();
                  setSync({ runtime: r.runtime, tries: 0, switched: true });
                }}
                onStarted={setTracked}
                onLogin={(runtime, op) => {
                  setLogin({ runtime, op });
                }}
              />
            );
          })}
        </ul>
      </Panel>
      {login !== null ? (
        <LoginDialog
          workerId={props.workerId}
          runtime={login.runtime}
          op={login.op}
          onClose={() => {
            setSync({ runtime: login.runtime, tries: 0 });
            setLogin(null);
            setAccountsRefresh((n) => n + 1);
            void load();
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

/** Makine → Runtime’lar (below the limit windows in `MachineScreen`). */
export function RuntimesTab(props: MachineTabProps): ReactNode {
  const w = props.worker;
  const common = {
    workerId: w.id,
    workerName: w.name,
    compatibility: props.overview?.compatibility ?? [],
    reported: w.runtimes,
  };
  return (
    <FleetCellsProvider workerId={w.id}>
      {props.isAdmin && operable(w) ? (
        <Managed {...common} onChanged={props.onChanged} />
      ) : (
        <Reported {...common} />
      )}
    </FleetCellsProvider>
  );
}
