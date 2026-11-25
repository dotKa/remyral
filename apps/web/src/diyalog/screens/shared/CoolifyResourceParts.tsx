import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  addStorage,
  getLogs,
  getStorages,
  lifecycle,
  type LifecycleAction,
  type LogsView,
  removeStorage,
  type Scope,
  type Storage,
  type StoragesView,
  type WriteResult,
} from '../../../api/coolifyResources';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyConfirmDialog } from '../../common/actions';
import { useDoneToast } from '../../toast/useDoneToast';
import {
  ConfirmButton,
  DyApiError,
  DyCheck,
  DyField,
  DyNotice,
  DyTextarea,
  FormActions,
  FormGrid,
} from '../forms';
import { DyButton, DySelect, Pill, Row, Rows, SkeletonRows } from '../parts';

/**
 * p17-coolify-full: the pieces the project's Coolify applications (Projeler → Deploy) and the Coolify-wide resources
 * (Ayarlar → Entegrasyonlar → Coolify → Kaynaklar) share — storages with the "not persistent" warnings, start / stop /
 * restart and the logs. Writes go through the step-up dialog when the security policy asks for a code; removing a
 * storage needs its name typed. File contents and passwords are never shown.
 */

/** Runs a write behind the step-up dialog; null when the user cancelled it. */
export function useCoolifyWrite(): <T>(fn: () => Promise<T>, why: string) => Promise<T | null> {
  const stepUp = useStepUp();
  return useCallback(
    async <T,>(fn: () => Promise<T>, why: string): Promise<T | null> => {
      try {
        return await stepUp.run(fn, why);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return null;
        throw err;
      }
    },
    [stepUp],
  );
}

function ResultNotes(props: { readonly result: WriteResult | null }): ReactNode {
  const r = props.result;
  if (r === null) return null;
  return (
    <>
      {r.lost.map((l) => (
        <DyNotice key={`l:${l}`} tone="amber">
          {l}
        </DyNotice>
      ))}
      {r.warnings.map((w) => (
        <DyNotice key={`w:${w}`} tone="amber">
          {w}
        </DyNotice>
      ))}
    </>
  );
}

const sectionClass = 'flex flex-col gap-3 rounded-[12px] border border-dy-line-2 p-4';

// ------------------------------------------------------------------------------------------------- storages

export function CoolifyStoragePanel(props: {
  readonly scope: Scope;
  readonly name: string;
  readonly canEdit: boolean;
  /** Services: the parts a storage can belong to. */
  readonly parts?: readonly { readonly uuid: string; readonly name: string }[] | undefined;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().coolifyApps.storage;
  const load = useSubmit();
  const { run } = load;
  const [view, setView] = useState<StoragesView | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Storage | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'coolify-storage-done' });
  const { scope } = props;
  const refresh = useCallback(() => {
    void run(async () => {
      setView(await getStorages(scope));
    });
  }, [run, scope]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const sourceText = (source: string): string =>
    source.startsWith('env:') ? t.sourceEnv({ key: source.slice(4) }) : t.sourceRemembered;
  return (
    <section
      aria-label={t.title({ name: props.name })}
      className={sectionClass}
      data-testid="coolify-storage"
    >
      <h3 className="m-0 text-[1rem] font-bold">{t.title({ name: props.name })}</h3>
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {view === null && load.error === null ? <SkeletonRows label={t.loading} rows={2} /> : null}
      {view?.unsupported != null ? (
        <DyNotice tone="amber" testId="coolify-storage-unsupported">
          <span className="font-bold">{t.unsupported}. </span>
          {view.unsupported}
        </DyNotice>
      ) : null}
      {view?.dataWarnings.map((w) => (
        <DyNotice key={w.path} tone="red" testId="coolify-storage-warning">
          {t.warning({ path: w.path })} <span className="text-dy-muted">({sourceText(w.source)})</span>
        </DyNotice>
      ))}
      {view !== null && view.unsupported === null && view.storages.length === 0 ? (
        <DyNotice tone="amber" testId="coolify-storage-empty">
          {t.empty}
        </DyNotice>
      ) : null}
      {view !== null && view.storages.length > 0 ? (
        <Rows label={t.listLabel} testId="coolify-storage-list">
          {view.storages.map((st) => (
            <Row
              key={st.uuid}
              title={<span className="font-dy-mono">{st.mountPath}</span>}
              meta={
                <>
                  {t.mounts[st.mount]}
                  {st.name === null ? '' : ` · ${st.name}`}
                  {st.hostPath === null ? '' : ` · ${t.host({ path: st.hostPath })}`}
                  {st.contentBytes === null ? '' : ` · ${t.bytes({ n: st.contentBytes })}`}
                </>
              }
              trail={st.readOnly ? <Pill tone="neutral">{t.readOnly}</Pill> : undefined}
              actions={
                props.canEdit && !st.readOnly && !view.controlPlane ? (
                  <DyButton
                    variant="danger"
                    aria-label={t.removeLabel({ path: st.mountPath })}
                    data-testid={`coolify-storage-remove-${st.uuid}`}
                    onClick={() => {
                      setRemoving(st);
                      setAdding(false);
                    }}
                  >
                    {t.remove}
                  </DyButton>
                ) : undefined
              }
            />
          ))}
        </Rows>
      ) : null}
      <ResultNotes result={result} />
      {removing !== null ? (
        <RemoveStorage
          scope={scope}
          storage={removing}
          onClose={() => {
            setRemoving(null);
          }}
          onRemoved={(r) => {
            setRemoving(null);
            setResult(r);
            setDone(t.removed);
            refresh();
          }}
        />
      ) : null}
      {adding ? (
        <AddStorage
          scope={scope}
          parts={props.parts}
          onClose={() => {
            setAdding(false);
          }}
          onAdded={(r, path) => {
            setAdding(false);
            setResult(r);
            setDone(t.added({ path }));
            refresh();
          }}
        />
      ) : null}
      <FormActions>
        {props.canEdit && !adding && view !== null && view.unsupported === null && !view.controlPlane ? (
          <DyButton
            variant="primary"
            icon="plus"
            data-testid="coolify-storage-add"
            onClick={() => {
              setAdding(true);
              setRemoving(null);
              setResult(null);
            }}
          >
            {t.add}
          </DyButton>
        ) : null}
        <DyButton onClick={props.onClose}>{t.close}</DyButton>
      </FormActions>
    </section>
  );
}

function AddStorage(props: {
  readonly scope: Scope;
  readonly parts?: readonly { readonly uuid: string; readonly name: string }[] | undefined;
  readonly onClose: () => void;
  readonly onAdded: (r: WriteResult, path: string) => void;
}): ReactNode {
  const tx = useT().coolifyApps;
  const t = tx.storage;
  const save = useSubmit();
  const write = useCoolifyWrite();
  const [mount, setMount] = useState<'volume' | 'file' | 'directory'>('volume');
  const [name, setName] = useState('data');
  const [mountPath, setMountPath] = useState('/data');
  const [hostPath, setHostPath] = useState('');
  const [content, setContent] = useState('');
  const [part, setPart] = useState(props.parts?.[0]?.uuid ?? '');
  const [deploy, setDeploy] = useState(false);
  const submit = async (): Promise<void> => {
    await save.run(async () => {
      const body: Record<string, unknown> = {
        mount,
        mountPath: mountPath.trim(),
        ...(mount === 'volume' ? { name: name.trim() } : {}),
        ...(hostPath.trim() === '' ? {} : { hostPath: hostPath.trim() }),
        ...(mount === 'file' && content !== '' ? { content } : {}),
        ...(props.parts !== undefined && part !== '' ? { resourceUuid: part } : {}),
        deploy,
      };
      const out = await write(() => addStorage(props.scope, body), t.stepUp);
      if (out !== null) props.onAdded(out, mountPath.trim());
    });
  };
  return (
    <div
      className="flex flex-col gap-3 rounded-[10px] border border-dy-line p-3"
      data-testid="coolify-storage-form"
    >
      <FormGrid>
        <DySelect
          label={t.mount}
          value={mount}
          options={[
            ['volume', t.mounts.volume],
            ['file', t.mounts.file],
            ['directory', t.mounts.directory],
          ]}
          onChange={(v) => {
            setMount(v === 'file' ? 'file' : v === 'directory' ? 'directory' : 'volume');
          }}
        />
        {props.parts === undefined || props.parts.length === 0 ? null : (
          <DySelect
            label={tx.logs.sub}
            value={part}
            options={props.parts.map((p) => [p.uuid, p.name] as const)}
            onChange={setPart}
          />
        )}
        {mount === 'volume' ? (
          <DyField label={t.name} hint={t.nameHint} mono value={name} onChange={setName} />
        ) : null}
        <DyField label={t.mountPath} hint={t.mountPathHint} mono value={mountPath} onChange={setMountPath} />
        <DyField label={t.hostPath} hint={t.hostPathHint} mono value={hostPath} onChange={setHostPath} />
      </FormGrid>
      {mount === 'file' ? (
        <DyTextarea
          label={t.content}
          hint={t.contentHint}
          mono
          rows={4}
          value={content}
          onChange={setContent}
        />
      ) : null}
      <DyCheck label={t.deploy} checked={deploy} onChange={setDeploy} />
      {mount !== 'file' ? (
        <DyNotice tone="amber" testId="coolify-storage-notice">
          {t.notice}
        </DyNotice>
      ) : null}
      <DyApiError error={save.error} retryLeft={save.retryLeft} />
      <FormActions>
        <DyButton
          variant="primary"
          busy={save.busy}
          data-testid="coolify-storage-save"
          onClick={() => void submit()}
        >
          {t.save}
        </DyButton>
        <DyButton onClick={props.onClose}>{t.cancel}</DyButton>
      </FormActions>
    </div>
  );
}

function RemoveStorage(props: {
  readonly scope: Scope;
  readonly storage: Storage;
  readonly onClose: () => void;
  readonly onRemoved: (r: WriteResult) => void;
}): ReactNode {
  const t = useT().coolifyApps.storage;
  const save = useSubmit();
  const write = useCoolifyWrite();
  const [confirm, setConfirm] = useState('');
  const expected = props.storage.name ?? props.storage.mountPath;
  const submit = async (): Promise<void> => {
    await save.run(async () => {
      const out = await write(
        () => removeStorage(props.scope, props.storage.uuid, confirm.trim(), false),
        t.stepUp,
      );
      if (out !== null) props.onRemoved(out);
    });
  };
  // p18-confirm-dialog: the typed-name confirmation is a dialog, not a panel on the page.
  return (
    <DyConfirmDialog
      open
      focusField
      onClose={props.onClose}
      title={t.removeTitle({ path: props.storage.mountPath })}
      confirmLabel={t.removeConfirm}
      cancelLabel={t.cancel}
      busy={save.busy}
      confirmDisabled={confirm.trim() === ''}
      testId="coolify-storage-remove"
      confirmTestId="coolify-storage-remove-submit"
      onConfirm={() => void submit()}
    >
      <DyField
        label={t.confirmLabel}
        hint={t.removeHint({ expected })}
        mono
        autoComplete="off"
        value={confirm}
        onChange={setConfirm}
      />
      <DyApiError error={save.error} retryLeft={save.retryLeft} />
    </DyConfirmDialog>
  );
}

// ------------------------------------------------------------------------------------------------ lifecycle

/** Start / restart, and stop behind a confirmation (it takes the site down). */
export function CoolifyLifecycle(props: {
  readonly scope: Scope;
  readonly name: string;
  readonly onDone?: (action: LifecycleAction) => void;
}): ReactNode {
  const t = useT().coolifyApps.lifecycle;
  const act = useSubmit();
  const write = useCoolifyWrite();
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'coolify-lifecycle-done' });
  const go = async (action: LifecycleAction): Promise<void> => {
    setDone(null);
    await act.run(async () => {
      const out = await write(() => lifecycle(props.scope, action), t.stepUp);
      if (out === null) return;
      setDone(t.done({ action: t[action] }));
      props.onDone?.(action);
    });
  };
  const id = props.scope.uuid;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <DyButton
          icon="bolt"
          disabled={act.busy}
          data-testid={`coolify-start-${id}`}
          onClick={() => void go('start')}
        >
          {t.start}
        </DyButton>
        <DyButton
          icon="retry"
          disabled={act.busy}
          data-testid={`coolify-restart-${id}`}
          onClick={() => void go('restart')}
        >
          {t.restart}
        </DyButton>
        <ConfirmButton
          label={t.stop}
          ariaLabel={t.stopLabel({ name: props.name })}
          question={t.stopQuestion({ name: props.name })}
          disabled={act.busy}
          testId={`coolify-stop-${id}`}
          onConfirm={() => void go('stop')}
        />
      </div>
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </div>
  );
}

// ----------------------------------------------------------------------------------------------------- logs

export function CoolifyLogsPanel(props: {
  readonly scope: Scope;
  readonly name: string;
  readonly parts?: readonly { readonly uuid: string; readonly name: string }[] | undefined;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().coolifyApps.logs;
  const load = useSubmit();
  const { run } = load;
  const [sub, setSub] = useState(props.parts?.[0]?.name ?? '');
  const [logs, setLogs] = useState<LogsView | null>(null);
  const { scope } = props;
  const refresh = useCallback(() => {
    void run(async () => {
      setLogs(await getLogs(scope, { lines: 200, ...(sub === '' ? {} : { sub }) }));
    });
  }, [run, scope, sub]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return (
    <section aria-label={t.title({ name: props.name })} className={sectionClass} data-testid="coolify-logs">
      <h3 className="m-0 text-[1rem] font-bold">{t.title({ name: props.name })}</h3>
      {props.parts !== undefined && props.parts.length > 1 ? (
        <DySelect
          label={t.sub}
          value={sub}
          options={props.parts.map((p) => [p.name, p.name] as const)}
          onChange={setSub}
        />
      ) : null}
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {logs === null && load.error === null ? <SkeletonRows label={t.loading} rows={3} /> : null}
      {logs?.notes.map((n) => (
        <DyNotice key={n} tone="neutral">
          {n}
        </DyNotice>
      ))}
      {logs !== null ? (
        logs.text === null || logs.text === '' ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{t.empty}</p>
        ) : (
          <pre
            aria-label={t.label}
            tabIndex={0}
            className="m-0 max-h-80 overflow-auto rounded-[8px] bg-dy-sunk p-3 font-dy-mono text-[0.75rem] whitespace-pre-wrap [overflow-wrap:anywhere]"
            data-testid="coolify-logs-text"
          >
            {logs.text}
          </pre>
        )
      ) : null}
      {logs?.truncated === true ? <p className="m-0 text-[0.75rem] text-dy-muted">{t.truncated}</p> : null}
      <FormActions>
        <DyButton icon="retry" busy={load.busy} onClick={refresh}>
          {t.refresh}
        </DyButton>
        <DyButton onClick={props.onClose}>{t.close}</DyButton>
      </FormActions>
    </section>
  );
}
