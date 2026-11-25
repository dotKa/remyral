import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { CompatCell } from '../../../../api/fleet';
import type { LoginStatus } from '../../../../api/remoteOps';
import { getWorkerConfig, putWorkerConfig } from '../../../../api/workerConfig';
import { useT } from '../../../../i18n/I18nProvider';
import { reasonCauseOf, runtimeName } from '../../../../lib/reasons';
import { cleanSpec, cloneSpec } from '../../../../screens/fleet/workerConfig';
import { machinePath } from '../../../../screens/fleet/machineLinks';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyIcon } from '../../../icons';
import { DyApiError } from '../../forms';
import { DyButton, DyButtonLink } from '../../parts';
import { useGuarded } from './config-shared';
import type { Look } from './runtimes-ops';

/**
 * p14-login-status-consistency — Makine → Runtime’lar: one story about a runtime's login. The compatibility cell comes
 * from the machine's CAPABILITIES (the runtime probe), the login row from the remote-operations report (the runtime's
 * own status command). They disagree when
 *  - the machine's jobs do not use the subscription login at all: the applied `runtimeAuth` is `secret-ref` (an API
 *    key) or nothing is chosen (the worker then treats the runtime as an unbound key) — the tab says so, next to the
 *    login too, and offers to switch the machine's jobs to the subscription login (a configuration change, step-up);
 *  - the machine has not re-sent CAPABILITIES since the login changed (the tab keeps reloading for a few seconds).
 */

/**
 * How the machine's jobs authenticate this runtime (its applied configuration); `loading` while it is read, `unknown`
 * when it cannot be read.
 */
export type JobAuth = 'local-login' | 'secret-ref' | 'none' | 'loading' | 'unknown';

/** The applied `runtimeAuth` modes; `loading` while the read runs, null when not needed or not readable. */
export type JobAuthModes = Readonly<Record<string, string>> | 'loading' | null;

/** After a login operation: how often / how many times the compatibility cell is reloaded until it agrees. */
export const SYNC_POLL_MS = 2_000;
export const SYNC_TRIES = 5;

/**
 * The applied `runtimeAuth` of the machine, read when some row needs it (a login runtime that is not_authenticated
 * or logged in) and again on `reload()`. null: not needed yet, not readable (no access, older master) or the machine
 * never reported a configuration.
 */
export function useJobAuthModes(
  workerId: string,
  needed: boolean,
): { readonly modes: JobAuthModes; readonly reload: () => void } {
  const [modes, setModes] = useState<JobAuthModes>(null);
  const [round, setRound] = useState(0);
  const asked = useRef<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    const key = `${workerId}#${String(round)}`;
    if (!needed || asked.current === key) return;
    const first = asked.current === null || !asked.current.startsWith(`${workerId}#`);
    asked.current = key;
    if (first) setModes('loading');
    getWorkerConfig(workerId).then(
      (v) => {
        if (live.current) setModes(v.report?.effective.runtimeAuth ?? null);
      },
      () => {
        if (live.current && first) setModes(null); // not readable: the explanation falls back to the cell
      },
    );
  }, [workerId, needed, round]);
  const reload = useCallback(() => {
    setRound((n) => n + 1);
  }, []);
  return { modes, reload };
}

/** The job auth of one runtime; the master's cell reason fills in when the configuration cannot be read. */
export function jobAuthOf(modes: JobAuthModes, runtime: string, cell?: CompatCell): JobAuth {
  if (modes === null) {
    // p14-i18n-reasons: the cell's cause (the English text only for an older master, lib/reasons.ts LEGACY).
    const cause =
      cell?.status === 'not_authenticated' ? reasonCauseOf(cell.status, cell.reason, cell.params) : null;
    if (cause === 'no_job_auth') return 'none';
    if (cause === 'job_auth_secret_ref') return 'secret-ref';
    return 'unknown';
  }
  if (modes === 'loading') return 'loading';
  const m = modes[runtime];
  return m === 'local-login'
    ? 'local-login'
    : m === 'secret-ref'
      ? 'secret-ref'
      : m === undefined
        ? 'none'
        : 'unknown';
}

/**
 * Do the compatibility cell and the login report tell the same story? Only meaningful where jobs use the
 * subscription login (or that is not known yet); an unknown login state never waits.
 */
export function loginAgrees(
  cell: CompatCell | undefined,
  status: LoginStatus | undefined,
  auth: JobAuth,
): boolean {
  if (cell === undefined || status === undefined || status === 'unknown') return true;
  if (auth === 'secret-ref' || auth === 'none') return true;
  if (status === 'logged_in') return cell.status !== 'not_authenticated';
  return cell.status !== 'ready' && cell.status !== 'degraded';
}

export type AuthExplanation = 'secret-ref' | 'none' | 'refreshing' | 'stale' | null;

/** Which explanation replaces the plain "signed out" reason of a not_authenticated login runtime (null: none). */
export function authExplanation(
  cell: CompatCell | undefined,
  status: LoginStatus | undefined,
  auth: JobAuth,
  syncing: boolean,
): AuthExplanation {
  if (cell?.status !== 'not_authenticated') return null;
  if (auth === 'secret-ref') return 'secret-ref';
  if (auth === 'none') return 'none';
  // The configuration is still being read: "refreshing", never a flash of a contradictory "signed out".
  if (auth === 'loading') return 'refreshing';
  if (status === 'logged_in') return syncing ? 'refreshing' : 'stale';
  return null;
}

/** The header pill for an explained state (null: the cell's own look). */
export function explainedLook(e: AuthExplanation, t: ReturnType<typeof useT>['machines']): Look | null {
  switch (e) {
    case 'secret-ref':
      return { tone: 'amber', icon: 'key', word: t.runtimeAuth.pillKeyMissing };
    case 'none':
      return { tone: 'amber', icon: 'key', word: t.runtimeAuth.pillNoMethod };
    case 'refreshing':
      return { tone: 'teal', icon: 'retry', word: t.runtimeAuth.pillRefreshing };
    default:
      return null;
  }
}

/**
 * Switches the machine's jobs for `runtime` to the subscription login (`local-login`) — the same configuration write
 * as Makine → Yapılandırma (current generation, or the takeover prefill of an unmanaged machine), behind step-up.
 * Resolves `pinned` when the machine's local file pins the runtime's auth (the panel value would not be used).
 */
function useSwitchToLogin(
  workerId: string,
  workerName: string,
): (runtime: string) => Promise<'saved' | 'pinned' | 'cancelled'> {
  const guarded = useGuarded();
  const t = useT().machines.runtimeAuth;
  return useCallback(
    async (runtime: string) => {
      const view = await getWorkerConfig(workerId);
      if (view.report?.ceiling.pinnedRuntimes.includes(runtime) === true) return 'pinned';
      const spec = cloneSpec(view.desired?.spec ?? view.suggested);
      const rt = runtime as (typeof spec.allowedRuntimes)[number];
      if (!spec.allowedRuntimes.includes(rt)) spec.allowedRuntimes = [...spec.allowedRuntimes, rt];
      spec.runtimes = {
        ...spec.runtimes,
        [rt]: { ...(spec.runtimes[rt] ?? {}), auth: { mode: 'local-login' } },
      };
      const saved = await guarded(
        () =>
          putWorkerConfig(workerId, {
            spec: cleanSpec(spec),
            expectedGeneration: view.desired?.generation ?? 0,
            changeNote: t.switchNote({ runtime: runtimeName(runtime) }),
            ...(view.desired === null ? { adopt: true } : {}),
          }),
        t.switchWhy({ runtime: runtimeName(runtime), machine: workerName }),
      );
      return saved === null ? 'cancelled' : 'saved';
    },
    [workerId, workerName, guarded, t],
  );
}

/** "Open configuration" and, for an admin, "use the subscription login for jobs". */
function JobAuthActions(props: {
  readonly runtime: string;
  readonly workerId: string;
  readonly workerName: string;
  readonly onSwitched?: (() => void) | undefined;
}): ReactNode {
  const t = useT().machines.runtimeAuth;
  const submit = useSubmit();
  const switchToLogin = useSwitchToLogin(props.workerId, props.workerName);
  const [done, setDone] = useState<'saved' | 'pinned' | null>(null);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        {props.onSwitched === undefined || done === 'saved' ? null : (
          <DyButton
            variant="secondary"
            icon="key"
            busy={submit.busy}
            onClick={() => {
              void submit.run(async () => {
                const r = await switchToLogin(props.runtime);
                if (r === 'cancelled') return;
                setDone(r);
                if (r === 'saved') props.onSwitched?.();
              });
            }}
          >
            {t.switchToLogin}
          </DyButton>
        )}
        <DyButtonLink to={machinePath(props.workerId, 'configuration')} icon="gear">
          {t.openConfig}
        </DyButtonLink>
      </div>
      {done === null ? null : (
        <p className="m-0" data-testid={`runtime-auth-switch-${props.runtime}`} data-result={done}>
          {done === 'saved' ? t.switched : t.pinned}
        </p>
      )}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </div>
  );
}

export function AuthExplanationNotice(props: {
  readonly explanation: Exclude<AuthExplanation, null>;
  readonly runtime: string;
  readonly workerId: string;
  readonly workerName: string;
  /** Admin: offer to switch the jobs to the subscription login; called after the configuration was saved. */
  readonly onSwitched?: (() => void) | undefined;
}): ReactNode {
  const t = useT().machines.runtimeAuth;
  const p = { runtime: runtimeName(props.runtime), machine: props.workerName };
  const e = props.explanation;
  if (e === 'refreshing') {
    return (
      <p
        className="m-0 flex items-center gap-2 text-[0.8125rem] text-dy-teal-ink"
        data-testid={`runtime-auth-${props.runtime}`}
        data-explanation={e}
        aria-live="polite"
      >
        <DyIcon name="retry" className="dy-breathe size-4" /> {t.refreshing(p)}
      </p>
    );
  }
  const text = e === 'secret-ref' ? t.secretRef(p) : e === 'none' ? t.noMethod(p) : t.stale(p);
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-[10px] bg-dy-amber-soft px-3.5 py-3 text-[0.8125rem] text-dy-amber-ink"
      data-testid={`runtime-auth-${props.runtime}`}
      data-explanation={e}
    >
      <p className="m-0 min-w-0">{text}</p>
      {e === 'stale' ? null : (
        <JobAuthActions
          runtime={props.runtime}
          workerId={props.workerId}
          workerName={props.workerName}
          onSwitched={props.onSwitched}
        />
      )}
    </div>
  );
}

/**
 * Under the subscription-login row: the login is active, but this machine's jobs do not use it (an API key, or no
 * sign-in method) — so the limit windows, placement and the runtime's state follow the key, not this login.
 */
export function LoginNotUsedNote(props: {
  readonly auth: 'secret-ref' | 'none';
  readonly runtime: string;
  readonly workerId: string;
  readonly workerName: string;
  readonly onSwitched?: (() => void) | undefined;
}): ReactNode {
  const t = useT().machines.runtimeAuth;
  const p = { runtime: runtimeName(props.runtime), machine: props.workerName };
  return (
    <div
      className="flex min-w-0 flex-col gap-2 text-[0.8125rem] text-dy-amber-ink"
      data-testid={`login-not-used-${props.runtime}`}
      data-auth={props.auth}
    >
      <p className="m-0">{props.auth === 'secret-ref' ? t.notUsedKey(p) : t.notUsedNone(p)}</p>
      <JobAuthActions
        runtime={props.runtime}
        workerId={props.workerId}
        workerName={props.workerName}
        onSwitched={props.onSwitched}
      />
    </div>
  );
}
