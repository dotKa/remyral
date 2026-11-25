import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { getCodeSource } from '../../api/code';
import {
  createIdeWorkspace,
  deleteIdeWorkspace,
  getIdeGit,
  getIdeState,
  IDE_LIVE_STATES,
  IDE_MOVING_STATES,
  type IdeMachine,
  type IdeState,
  type IdeWorkspace,
  openIdeWorkspace,
  startIdeWorkspace,
  stopIdeWorkspace,
} from '../../api/ide';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { DyNotice } from '../common/notices';
import { DyDialog } from '../DyDialog';
import { DyButton } from '../screens/parts';
import { toast } from '../toast/store';
import { IdeExtensionsPicker } from './IdeExtensions';
import { markIdeActive } from './ideInbox';

/**
 * p19-ide W2 (docs/design/p19-ide.md §8): "Tam IDE" on the Kod tab — for operators of the project: start a workspace on
 * a machine (Linux: openvscode-server; W2b macOS / Windows: code-server; its own branch), list the caller's workspaces
 * (running / stopped), stop, start, delete, and open one in a new tab on the IDE origin (a one-time ticket the master
 * redeems there). Clear states for "not configured", "no machine" (each machine's reason, named with its OS — e.g.
 * "Windows: henüz desteklenmiyor — …" only where the machine itself says so) and "capacity full". Phones get a note:
 * the IDE is a desktop tool.
 */

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** A catalog word for a code the master may extend (unknown codes: undefined). */
function lookup(words: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(words, key) ? words[key] : undefined;
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: IdeState }
  | { readonly kind: 'error' };

export function IdePanel(props: { readonly project: string }): ReactNode {
  const t = useT().ide;
  const sayError = useErrorText();
  const stepUp = useStepUp();
  const { project } = props;
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ ws: IdeWorkspace; dirty: string | null } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [repo, setRepo] = useState<{ repository: boolean; defaultBranch: string | null }>({
    repository: false,
    defaultBranch: null,
  });

  useEffect(() => {
    let live = true;
    getCodeSource(project).then(
      (src) => {
        if (live) setRepo({ repository: src.kind === 'repository', defaultBranch: src.defaultBranch });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [project]);

  const reload = useCallback(() => {
    getIdeState(project).then(
      (value) => {
        setState({ kind: 'ready', value });
      },
      () => {
        setState({ kind: 'error' });
      },
    );
  }, [project]);

  useEffect(() => {
    reload();
  }, [reload]);

  // While a workspace is coming up, follow it.
  const moving = state.kind === 'ready' && state.value.workspaces.some((w) => IDE_MOVING_STATES.has(w.state));
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(reload, 3_000);
    return () => {
      clearInterval(timer);
    };
  }, [moving, reload]);

  // Viewers (no ide.use) and a failed read see nothing: the viewer below works for everyone.
  if (state.kind !== 'ready' || !state.value.canUse) return null;
  const s = state.value;

  const act = async (id: string, run: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(id);
    try {
      await run();
      if (done !== undefined) toast({ tone: 'success', title: done });
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) toast({ tone: 'error', title: sayError(err) });
    } finally {
      setBusy(null);
      reload();
    }
  };

  const open = async (ws: IdeWorkspace): Promise<void> => {
    // The tab opens on the click (a popup blocker allows that); the ticket URL is set once the master answered.
    const win = window.open('about:blank', '_blank');
    setBusy(ws.id);
    try {
      const { url } = await openIdeWorkspace(ws.id);
      markIdeActive();
      if (win === null) {
        setLink(url);
        toast({ tone: 'warning', title: t.list.popupBlocked });
        return;
      }
      win.opener = null;
      win.location.href = url;
      toast({ tone: 'success', title: t.list.opened });
    } catch (err) {
      win?.close();
      toast({ tone: 'error', title: sayError(err) });
    } finally {
      setBusy(null);
    }
  };

  const askRemove = async (ws: IdeWorkspace): Promise<void> => {
    let dirty: string | null = null;
    if (ws.source === 'repository' && ws.workerConnected) {
      const g = await getIdeGit(ws.id).catch(() => null);
      if (g?.status === 'ok' && ((g.changedFiles ?? 0) > 0 || (g.ahead ?? 0) > 0)) {
        dirty = t.list.dirty({ files: g.changedFiles ?? 0, ahead: g.ahead ?? 0 });
      }
    }
    setConfirm({ ws, dirty });
  };

  const available = s.machines.filter((m) => m.available);
  const full =
    available.length === 0 &&
    s.machines.some((m) => m.reason === 'capacity') &&
    s.machines.every(
      (m) => m.reason === 'capacity' || m.reason === 'offline' || m.reason === 'platform_update',
    );
  const reasonOf = (m: IdeMachine): string => {
    if (m.reason === null) return '';
    const os = m.platform === null ? null : (lookup(t.platforms, m.platform) ?? m.platform);
    const withOs = (reason: string): string => (os === null ? reason : t.osReason({ os, reason }));
    if (m.reason === 'unavailable') {
      // W2b: the machine's own reason code first, then its English detail (an older worker), then the generic word.
      const coded = m.detailCode === null ? undefined : lookup(t.unavailable, m.detailCode);
      return withOs(coded ?? m.detail ?? t.reasons.unavailable);
    }
    if (m.reason === 'platform_update') return withOs(t.reasons.platform_update);
    return lookup(t.reasons, m.reason) ?? m.detail ?? m.reason;
  };

  return (
    <section
      className="grid gap-2 rounded-[12px] border border-dy-line bg-dy-card p-3"
      aria-label={t.title}
      data-testid="ide-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[0.9375rem] font-bold">{t.title}</h2>
        <span className="text-[0.8125rem] text-dy-muted">{t.purpose}</span>
        {s.configured ? (
          <DyButton
            variant="primary"
            icon="code"
            className="ml-auto hidden md:inline-flex"
            disabled={available.length === 0}
            onClick={() => {
              setDialog(true);
            }}
            data-testid="ide-new"
          >
            {t.open}
          </DyButton>
        ) : null}
      </div>
      <p className="text-[0.8125rem] text-dy-muted md:hidden" data-testid="ide-desktop-only">
        {t.desktopOnly}
      </p>
      {!s.configured ? (
        <DyNotice tone="amber" testId="ide-not-configured">
          {t.notConfigured}
        </DyNotice>
      ) : full ? (
        <DyNotice tone="amber" testId="ide-capacity">
          {t.capacityFull({ max: s.limits.perMachine })}
        </DyNotice>
      ) : available.length === 0 ? (
        <DyNotice tone="amber" title={t.noMachine} testId="ide-no-machine">
          {s.machines.length === 0 ? null : (
            <ul className="list-disc pl-5">
              {s.machines.map((m) => (
                <li key={m.id}>{t.machineLine({ name: m.name, reason: reasonOf(m) })}</li>
              ))}
            </ul>
          )}
        </DyNotice>
      ) : null}
      {link === null ? null : (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="font-bold underline"
          data-testid="ide-link"
        >
          {t.list.openLink}
        </a>
      )}
      {s.workspaces.length === 0 ? null : (
        <ul className="grid gap-1.5" aria-label={t.list.title} data-testid="ide-workspaces">
          {s.workspaces.map((ws) => {
            const live = IDE_LIVE_STATES.has(ws.state) && ws.desired === 'running';
            const reason = ws.stopReason === null ? null : (lookup(t.stopReasons, ws.stopReason) ?? null);
            return (
              <li
                key={ws.id}
                className="flex flex-wrap items-center gap-2 rounded-[9px] border border-dy-line px-3 py-2"
                data-testid="ide-workspace"
              >
                <span className="font-bold">{ws.name}</span>
                <span className="text-[0.8125rem]" data-testid="ide-state">
                  {lookup(t.states, ws.state) ?? ws.state}
                </span>
                {reason === null || live ? null : (
                  <span className="text-[0.8125rem] text-dy-muted">{reason}</span>
                )}
                {ws.branch === null ? null : (
                  <span className="font-dy-mono text-[0.75rem] text-dy-muted" title={t.list.branch}>
                    {ws.branch}
                  </span>
                )}
                <span className="text-[0.75rem] text-dy-muted" title={t.list.machine}>
                  {ws.workerName ?? ws.workerId}
                  {ws.workerConnected ? '' : ` (${t.list.offline})`}
                </span>
                {ws.extensions === null ||
                (ws.extensions.failed.length === 0 && ws.extensions.skipped.length === 0) ? null : (
                  <span className="basis-full text-[0.75rem] text-dy-muted" data-testid="ide-ext-report">
                    {t.extensions.report({
                      list: [...ws.extensions.failed, ...ws.extensions.skipped]
                        .map((x) => `${x.id} (${lookup(t.extensions.reasons, x.reason) ?? x.reason})`)
                        .join(', '),
                    })}
                  </span>
                )}
                {ws.pullRequestUrl === null ? null : (
                  <a
                    href={ws.pullRequestUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[0.75rem] underline"
                  >
                    {t.list.pullRequest}
                  </a>
                )}
                <span className="ml-auto flex flex-wrap gap-1.5">
                  {ws.state === 'running' && ws.desired === 'running' ? (
                    <DyButton
                      variant="primary"
                      icon="code"
                      className="hidden md:inline-flex"
                      busy={busy === ws.id}
                      onClick={() => void open(ws)}
                      data-testid="ide-open"
                    >
                      {t.list.open}
                    </DyButton>
                  ) : null}
                  {live ? (
                    <DyButton
                      icon="pause"
                      busy={busy === ws.id}
                      onClick={() => void act(ws.id, () => stopIdeWorkspace(ws.id), t.list.stopped)}
                      data-testid="ide-stop"
                    >
                      {t.list.stop}
                    </DyButton>
                  ) : (
                    <DyButton
                      icon="retry"
                      className="hidden md:inline-flex"
                      busy={busy === ws.id}
                      disabled={!ws.workerConnected}
                      onClick={() =>
                        void act(
                          ws.id,
                          () => stepUp.run(() => startIdeWorkspace(ws.id), t.stepUpStart),
                          t.list.started,
                        )
                      }
                      data-testid="ide-start"
                    >
                      {t.list.start}
                    </DyButton>
                  )}
                  <DyButton
                    variant="ghost"
                    icon="trash"
                    busy={busy === ws.id}
                    onClick={() => void askRemove(ws)}
                    data-testid="ide-remove"
                  >
                    {t.list.remove}
                  </DyButton>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {s.configured && s.canUse ? <IdeExtensionsPicker project={project} /> : null}
      <StartDialog
        open={dialog}
        project={project}
        state={s}
        repository={repo.repository}
        defaultBranch={repo.defaultBranch}
        onClose={() => {
          setDialog(false);
        }}
        onCreated={() => {
          setDialog(false);
          toast({ tone: 'success', title: t.list.started });
          reload();
        }}
      />
      <DyDialog
        open={confirm !== null}
        size="sm"
        onClose={() => {
          setConfirm(null);
        }}
        title={t.list.remove}
        testId="ide-remove-dialog"
        footer={
          <>
            <DyButton
              onClick={() => {
                setConfirm(null);
              }}
            >
              {t.dialog.cancel}
            </DyButton>
            <DyButton
              variant="danger"
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                if (c !== null) void act(c.ws.id, () => deleteIdeWorkspace(c.ws.id), t.list.removed);
              }}
              data-testid="ide-remove-confirm"
            >
              {confirm?.dirty === null ? t.list.remove : t.list.removeAnyway}
            </DyButton>
          </>
        }
      >
        <p>{confirm === null ? null : t.list.removeConfirm({ name: confirm.ws.name })}</p>
        {confirm?.dirty === null || confirm === null ? null : (
          <DyNotice tone="amber" testId="ide-dirty">
            {confirm.dirty}
          </DyNotice>
        )}
      </DyDialog>
    </section>
  );
}

function StartDialog(props: {
  readonly open: boolean;
  readonly project: string;
  readonly state: IdeState;
  readonly repository: boolean;
  readonly defaultBranch: string | null;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}): ReactNode {
  const t = useT().ide;
  const sayError = useErrorText();
  const stepUp = useStepUp();
  const [name, setName] = useState('');
  const [worker, setWorker] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const available = props.state.machines.filter((m) => m.available);
  const valid = NAME.test(name);

  useEffect(() => {
    if (!props.open) return;
    setName(props.state.workspaces.length === 0 ? 'main' : '');
    setWorker('');
    setBaseRef('');
    setError(null);
  }, [props.open, props.state.workspaces.length]);

  const submit = async (): Promise<void> => {
    if (!valid) {
      setError(t.dialog.invalidName);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await stepUp.run(
        () =>
          createIdeWorkspace(props.project, {
            name,
            ...(worker === '' ? {} : { worker }),
            ...(baseRef.trim() === '' ? {} : { baseRef: baseRef.trim() }),
          }),
        t.stepUpStart,
      );
      props.onCreated();
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(sayError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={t.dialog.title}
      backdropClose={false}
      testId="ide-start-dialog"
      footer={
        <>
          <DyButton onClick={props.onClose}>{t.dialog.cancel}</DyButton>
          <DyButton
            variant="primary"
            busy={busy}
            disabled={!valid || available.length === 0}
            onClick={() => void submit()}
            data-testid="ide-create"
          >
            {t.dialog.create}
          </DyButton>
        </>
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="grid gap-1 text-[0.8125rem] font-bold">
          {t.dialog.name}
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value.toLowerCase());
            }}
            maxLength={32}
            spellCheck={false}
            aria-describedby="ide-name-hint"
            className="min-h-9 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 font-dy-mono text-[0.875rem] font-normal"
            data-testid="ide-name"
          />
          <span id="ide-name-hint" className="font-normal text-dy-muted">
            {t.dialog.nameHint}
          </span>
        </label>
        <label className="grid gap-1 text-[0.8125rem] font-bold">
          {t.dialog.machine}
          <select
            value={worker}
            onChange={(e) => {
              setWorker(e.target.value);
            }}
            className="min-h-9 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-normal"
            data-testid="ide-machine"
          >
            <option value="">{t.dialog.machineAuto}</option>
            {available.map((m) => (
              <option key={m.id} value={m.id}>
                {t.dialog.machineOption({ name: m.name, running: m.running, max: m.max })}
              </option>
            ))}
          </select>
        </label>
        {props.repository ? (
          <>
            <label className="grid gap-1 text-[0.8125rem] font-bold">
              {t.dialog.base}
              <input
                value={baseRef}
                onChange={(e) => {
                  setBaseRef(e.target.value);
                }}
                maxLength={255}
                spellCheck={false}
                placeholder={props.defaultBranch ?? ''}
                className="min-h-9 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 font-dy-mono text-[0.875rem] font-normal"
                data-testid="ide-base"
              />
              <span className="font-normal text-dy-muted">
                {t.dialog.baseHint({ branch: props.defaultBranch ?? '' })}
              </span>
            </label>
            {valid ? (
              <p className="text-[0.8125rem] text-dy-muted">
                {t.dialog.branchNote({ branch: `remyral/ide/…/${name}` })}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-[0.8125rem] text-dy-muted">{t.dialog.filesNote}</p>
        )}
        <p className="text-[0.8125rem] text-dy-muted">
          {t.dialog.limits({
            memory: Math.round(props.state.limits.memoryMb / 1024),
            idle: props.state.limits.idleMinutes,
          })}
        </p>
        <p className="text-[0.8125rem] text-dy-muted">{t.dialog.codeNote}</p>
        {error === null ? null : (
          <DyNotice tone="red" testId="ide-error">
            {error}
          </DyNotice>
        )}
      </form>
    </DyDialog>
  );
}
