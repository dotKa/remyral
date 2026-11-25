import {
  DEFAULT_SAFE_COMMANDS_MODE,
  SAFE_COMMAND_RULES,
  SAFE_COMMANDS_MODES,
  type SafeCommandRuleView,
  type SafeCommandsMode,
} from '@remyral/protocol/safe-commands';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getProjectExecution, type ProjectExecution, setProjectExecution } from '../../../../api/sandbox';
import { DELEGATION_RUNTIMES } from '../../../../screens/subtasks';
import { useSubmit } from '../../../../screens/useSubmit';
import { runtimeDisplayName } from '../../../RuntimeMark';
import { useCardForm, useSectionSave } from '../../../formkit';
import { DyCheck, DyDetails, DyNotice, FormActions } from '../../forms';
import { DyButton, Panel, Pill } from '../../parts';
import { LoadState, RadioCardGroup, SaveResult } from './policy-common';
import { useT } from '../../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Projeler → Politika: execution policy (host-native / unconfined profiles, "Hiç sorma",
 * the Full access preset), safe commands and sub-jobs. Same calls as the classic sections
 * (`GET/PUT /projects/:id/execution`), every save through step-up (a cancelled code is not an error), edit controls
 * for owners / admins only (`canEdit`), viewers read. p15-form-pattern: each card is a section of the Politika tab's
 * form (the tab's bar saves it); the three cards share one document, so the safe-command and sub-job saves read the
 * current document first and change only their own fields (a save of the execution card just before is kept).
 */

function useExecution(project: string): {
  readonly data: ProjectExecution | null;
  readonly load: ReturnType<typeof useSubmit>;
  readonly refresh: () => void;
  readonly set: (d: ProjectExecution) => void;
} {
  const [data, setData] = useState<ProjectExecution | null>(null);
  const load = useSubmit();
  const { run } = load;
  const refresh = useCallback(() => {
    void run(async () => {
      setData(await getProjectExecution(project));
    });
  }, [run, project]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, load, refresh, set: setData };
}

// ------------------------------------------------------------------------------------------------ execution

export function ExecutionPanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const t = useT().projects.execution;
  const { project } = props;
  const ex = useExecution(project);
  const [host, setHost] = useState(false);
  const [unconfined, setUnconfined] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const save = useSubmit();
  const sectionSave = useSectionSave();
  const data = ex.data;

  const reset = useCallback((d: ProjectExecution) => {
    setHost(d.hostExecution);
    setUnconfined(d.unconfined);
    setAutoApprove(d.allowAutoApprove);
  }, []);
  useEffect(() => {
    if (data !== null) reset(data);
  }, [data, reset]);

  const store = (
    body: { hostExecution: boolean; unconfined: boolean; allowAutoApprove: boolean },
    message: string,
  ): Promise<boolean> => {
    setDone(null);
    return sectionSave(
      save,
      async () => {
        ex.set(await setProjectExecution(project, body));
        setDone(message);
      },
      t.stepUp({ project }),
    );
  };

  const changed =
    data !== null &&
    (host !== data.hostExecution || unconfined !== data.unconfined || autoApprove !== data.allowAutoApprove);
  const card = useCardForm({
    dirty: props.canEdit && changed,
    busy: save.busy,
    save: () => store({ hostExecution: host, unconfined, allowAutoApprove: autoApprove }, t.saved),
    discard: () => {
      if (data !== null) reset(data);
    },
  });
  const fullAccess = data !== null && data.hostExecution && data.unconfined && data.allowAutoApprove;

  return (
    <Panel title={t.title} sub={t.sub} testId="execution-policy-panel">
      <section aria-label={t.region({ project })} className="flex flex-col gap-3">
        <LoadState
          loaded={data !== null}
          error={ex.load.error}
          what={t.title}
          onRetry={ex.refresh}
          rows={8}
        />
        {data === null ? null : (
          <div className="flex flex-col gap-3" data-testid="execution-policy">
            <div
              className="flex flex-col gap-2 rounded-[12px] border border-dy-red/35 bg-dy-red-soft/40 p-3.5 text-[0.875rem]"
              data-testid="full-access-preset"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold">{t.fullAccess}</span>
                {fullAccess ? (
                  <Pill tone="red" icon="shield">
                    {t.on}
                  </Pill>
                ) : (
                  <Pill tone="neutral">{t.off}</Pill>
                )}
              </div>
              <p className="m-0 text-[0.8125rem]">{t.fullAccessText}</p>
              <p className="m-0 text-[0.8125rem]">
                {t.stillGated({ list: t.alwaysGated })}
                <Link className="text-dy-ink underline" to="/machines">
                  {t.machineLink}
                </Link>{' '}
                {t.allowUnconfined}
              </p>
              {props.canEdit ? (
                <FormActions>
                  {fullAccess ? (
                    <DyButton
                      busy={save.busy}
                      onClick={() => {
                        void store(
                          { hostExecution: data.hostExecution, unconfined: false, allowAutoApprove: false },
                          t.fullAccessClosed,
                        );
                      }}
                    >
                      {t.closeFullAccess}
                    </DyButton>
                  ) : (
                    <DyButton
                      variant="danger"
                      icon="shield"
                      busy={save.busy}
                      onClick={() => {
                        void store(
                          { hostExecution: true, unconfined: true, allowAutoApprove: true },
                          t.fullAccessOpened,
                        );
                      }}
                    >
                      {t.openFullAccess}
                    </DyButton>
                  )}
                </FormActions>
              ) : null}
            </div>
            <DyCheck
              label={t.host}
              hint={t.hostHint}
              checked={host}
              disabled={!props.canEdit}
              onChange={(on) => {
                setHost(on);
                if (!on) setUnconfined(false);
              }}
            />
            <DyCheck
              label={t.unconfined}
              hint={t.unconfinedHint}
              checked={unconfined}
              disabled={!props.canEdit || !host}
              onChange={setUnconfined}
            />
            <DyCheck
              label={t.autoApprove}
              hint={t.autoApproveHint}
              checked={autoApprove}
              disabled={!props.canEdit}
              onChange={setAutoApprove}
            />
            {unconfined && !data.unconfined ? (
              <DyNotice tone="red">{t.unconfinedWarn({ project })}</DyNotice>
            ) : null}
            {autoApprove && !data.allowAutoApprove ? (
              <DyNotice tone="red">{t.autoApproveWarn({ project, list: t.alwaysGated })}</DyNotice>
            ) : null}
            {props.canEdit && !card.inScope ? (
              <FormActions>
                <DyButton variant="primary" busy={save.busy} disabled={!changed} onClick={card.submit}>
                  {t.save}
                </DyButton>
              </FormActions>
            ) : null}
            <SaveResult done={done} error={save.error} retryLeft={save.retryLeft} />
          </div>
        )}
      </section>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ safe commands

const MODE_KEY: Readonly<Record<SafeCommandsMode, 'off' | 'readOnly' | 'workspaceWrites'>> = {
  off: 'off',
  'read-only': 'readOnly',
  'workspace-writes': 'workspaceWrites',
};

const SHELL_GROUPS: readonly SafeCommandRuleView['shell'][] = ['any', 'posix', 'powershell', 'cmd'];

function covered(mode: SafeCommandsMode, rule: SafeCommandRuleView): boolean {
  if (mode === 'off') return false;
  return rule.needs === 'read' || mode === 'workspace-writes';
}

function RuleList(props: { readonly mode: SafeCommandsMode }): ReactNode {
  const t = useT().projects.safeCommands;
  return (
    <div className="flex flex-col gap-2" data-testid="safe-command-rules">
      {SHELL_GROUPS.map((shell) => {
        const rules = SAFE_COMMAND_RULES.filter((r) => r.shell === shell);
        const on = rules.filter((r) => covered(props.mode, r)).length;
        return (
          <DyDetails
            key={shell}
            summary={
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>{t.shells[shell]}</span>
                <span className="font-dy-mono text-[0.78125rem] font-normal text-dy-muted tabular-nums">
                  {t.autoApproved({ on, total: rules.length })}
                </span>
              </span>
            }
          >
            <ul className="-mx-3.5 -my-3 m-0 list-none p-0">
              {rules.map((r) => {
                const active = covered(props.mode, r);
                return (
                  <li
                    key={r.id}
                    data-rule={r.id}
                    data-active={active ? 'true' : 'false'}
                    className="flex flex-col gap-0.5 border-t border-dy-line px-3.5 py-2 text-[0.8125rem] first:border-t-0 sm:flex-row sm:items-baseline sm:gap-3"
                  >
                    <code
                      className={
                        active
                          ? 'font-dy-mono text-[0.78125rem] [overflow-wrap:anywhere]'
                          : 'font-dy-mono text-[0.78125rem] text-dy-faint line-through [overflow-wrap:anywhere]'
                      }
                    >
                      {r.names.join(', ')}
                    </code>
                    <span className={active ? 'min-w-0 flex-1' : 'min-w-0 flex-1 text-dy-muted'}>
                      {r.summary}
                    </span>
                    <span className="shrink-0 text-[0.75rem] text-dy-muted">
                      {r.needs === 'read' ? t.needsRead : t.needsWrite}
                    </span>
                  </li>
                );
              })}
            </ul>
          </DyDetails>
        );
      })}
    </div>
  );
}

export function SafeCommandsPanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const words = useT().projects;
  const t = words.safeCommands;
  const { project } = props;
  const ex = useExecution(project);
  const data = ex.data;
  const [mode, setMode] = useState<SafeCommandsMode>(DEFAULT_SAFE_COMMANDS_MODE);
  const [done, setDone] = useState<string | null>(null);
  const save = useSubmit();
  const sectionSave = useSectionSave();

  useEffect(() => {
    if (data !== null) setMode(data.safeCommands);
  }, [data]);

  const store = (): Promise<boolean> => {
    if (data === null) return Promise.resolve(false);
    setDone(null);
    return sectionSave(
      save,
      async () => {
        // The current document: the execution card of this tab may have been saved a moment ago.
        const cur = await getProjectExecution(project);
        ex.set(
          await setProjectExecution(project, {
            hostExecution: cur.hostExecution,
            unconfined: cur.unconfined,
            allowAutoApprove: cur.allowAutoApprove,
            safeCommands: mode,
          }),
        );
        setDone(t.saved);
      },
      t.stepUp({ project }),
    );
  };
  const card = useCardForm({
    dirty: props.canEdit && data !== null && mode !== data.safeCommands,
    busy: save.busy,
    save: store,
    discard: () => {
      if (data !== null) setMode(data.safeCommands);
    },
  });

  return (
    <Panel title={t.title} sub={t.sub} testId="safe-commands-panel">
      <section aria-label={t.region({ project })} className="flex flex-col gap-3">
        <LoadState loaded={data !== null} error={ex.load.error} what={t.title} onRetry={ex.refresh} />
        {data === null ? null : (
          <div className="flex flex-col gap-3" data-testid="safe-commands">
            <RadioCardGroup
              legend={t.legend}
              value={mode}
              disabled={!props.canEdit}
              options={SAFE_COMMANDS_MODES.map((m) => ({
                value: m,
                label: t.modes[MODE_KEY[m]].label,
                description: t.modes[MODE_KEY[m]].description,
                badge: m === DEFAULT_SAFE_COMMANDS_MODE ? words.policy.defaultBadge : undefined,
              }))}
              onChange={setMode}
            />
            <p className="m-0 text-[0.8125rem] text-dy-muted">
              {t.proofLead}
              <code className="font-dy-mono">;</code>, <code className="font-dy-mono">{'&&'}</code>,{' '}
              <code className="font-dy-mono">|</code>, {t.proofSubcommands}{' '}
              <code className="font-dy-mono">{'.git'}</code> {t.proofNever}
              <code className="font-dy-mono">{'approval.auto_safe'}</code>
              {t.proofTail}
            </p>
            {mode === 'workspace-writes' && data.safeCommands !== 'workspace-writes' ? (
              <DyNotice tone="amber">{t.writesWarn({ project })}</DyNotice>
            ) : null}
            <RuleList mode={mode} />
            {props.canEdit && !card.inScope ? (
              <FormActions>
                <DyButton
                  variant="primary"
                  busy={save.busy}
                  disabled={mode === data.safeCommands}
                  onClick={card.submit}
                >
                  {t.save}
                </DyButton>
              </FormActions>
            ) : null}
            <SaveResult done={done} error={save.error} retryLeft={save.retryLeft} />
          </div>
        )}
      </section>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ sub-jobs

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

export function SubtasksPanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const t = useT().projects.subtasks;
  const { project } = props;
  const ex = useExecution(project);
  const data = ex.data;
  const [enabled, setEnabled] = useState(false);
  const [runtimes, setRuntimes] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const save = useSubmit();
  const sectionSave = useSectionSave();

  const reset = useCallback((d: ProjectExecution) => {
    setEnabled(d.subtasks);
    setRuntimes([...d.delegationRuntimes]);
  }, []);
  useEffect(() => {
    if (data !== null) reset(data);
  }, [data, reset]);

  const dirty = data !== null && (enabled !== data.subtasks || !same(runtimes, data.delegationRuntimes));

  const store = (): Promise<boolean> => {
    if (data === null) return Promise.resolve(false);
    setDone(null);
    return sectionSave(
      save,
      async () => {
        // The current document: another card of this tab may have been saved a moment ago.
        const cur = await getProjectExecution(project);
        ex.set(
          await setProjectExecution(project, {
            hostExecution: cur.hostExecution,
            unconfined: cur.unconfined,
            allowAutoApprove: cur.allowAutoApprove,
            subtasks: enabled,
            delegationRuntimes: [...runtimes].sort(),
          }),
        );
        setDone(t.saved);
      },
      t.stepUp({ project }),
    );
  };
  const card = useCardForm({
    dirty: props.canEdit && dirty,
    busy: save.busy,
    save: store,
    discard: () => {
      if (data !== null) reset(data);
    },
  });

  return (
    <Panel title={t.title} sub={t.sub} testId="subtasks-panel">
      <section aria-label={t.region({ project })} className="flex flex-col gap-3">
        <LoadState loaded={data !== null} error={ex.load.error} what={t.what} onRetry={ex.refresh} />
        {data === null ? null : (
          <div className="flex flex-col gap-3" data-testid="subtasks-policy">
            {props.canEdit ? (
              <DyCheck label={t.enable} hint={t.enableHint} checked={enabled} onChange={setEnabled} />
            ) : (
              <p className="m-0 text-[0.875rem]">{data.subtasks ? t.allowed : t.notAllowed}</p>
            )}
            <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0" disabled={!props.canEdit}>
              <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{t.runtimes}</legend>
              <p className="m-0 text-[0.78125rem] text-dy-muted">{t.runtimesHint}</p>
              <div className="flex flex-wrap gap-x-5">
                {DELEGATION_RUNTIMES.map((r) => (
                  <DyCheck
                    key={r}
                    label={runtimeDisplayName(r)}
                    checked={runtimes.includes(r)}
                    disabled={!props.canEdit}
                    onChange={(on) => {
                      setRuntimes((cur) => (on ? [...new Set([...cur, r])] : cur.filter((x) => x !== r)));
                    }}
                  />
                ))}
              </div>
            </fieldset>
            {enabled && !data.subtasks ? <DyNotice tone="amber">{t.warn({ project })}</DyNotice> : null}
            {props.canEdit && !card.inScope ? (
              <FormActions>
                <DyButton variant="primary" busy={save.busy} disabled={!dirty} onClick={card.submit}>
                  {t.save}
                </DyButton>
              </FormActions>
            ) : null}
            <SaveResult done={done} error={save.error} retryLeft={save.retryLeft} />
          </div>
        )}
      </section>
    </Panel>
  );
}
