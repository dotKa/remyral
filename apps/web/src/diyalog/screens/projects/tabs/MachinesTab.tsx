import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Project } from '../../../../api/directory';
import { getProjectGitConfig } from '../../../../api/gitflow';
import {
  getPreferredWorkers,
  listProjectWorkers,
  type ProjectWorker,
  setPreferredWorkers,
  setProjectWorkers,
} from '../../../../api/workerConfig';
import { DyReason } from '../../../common/notices';
import { machineHref } from '../../../../lib/reasons';
import { DyFormScope, useCardForm, useSectionSave } from '../../../formkit';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyIcon, type IconName } from '../../../icons';
import { INK, type Tone } from '../../../tone';
import { DyApiError, DyNotice } from '../../forms';
import { DyButton, DyButtonLink, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../../parts';
import { useT } from '../../../../i18n/I18nProvider';
import { toast } from '../../../toast/store';
import type { Messages } from '@remyral/i18n';

/**
 * Projeler → Makineler in the Diyalog language (p12-diyalog wave 2, W3): which machines may run this project's jobs.
 * Same requests and rules as the classic `ProjectWorkersSection`: `GET/PUT /projects/:id/workers`, a repository
 * project needs a registered repository before a machine can be newly assigned, saving goes through step-up and each
 * changed machine receives a new configuration generation. Viewers and operators read only. p15-form-pattern: the
 * tab is one form; the assignment checkboxes are saved by its sticky bar.
 * p18-project-bootstrap: "Tercih edilen" marks the project's preferred machines (`GET/PUT /projects/:id/preferred-workers`,
 * a soft placement preference of all its jobs); saved by the same bar. An older master (no route): not shown.
 */

const STATE: Readonly<Record<string, { tone: Tone; icon: IconName }>> = {
  online: { tone: 'green', icon: 'checkc' },
  busy: { tone: 'teal', icon: 'retry' },
  updating: { tone: 'violet', icon: 'retry' },
  draining: { tone: 'amber', icon: 'pause' },
  offline: { tone: 'red', icon: 'xc' },
  quarantined: { tone: 'red', icon: 'shield' },
  pending: { tone: 'amber', icon: 'key' },
  revoked: { tone: 'neutral', icon: 'xc' },
};

function stateOf(
  w: ProjectWorker,
  words: Messages['projects']['machines']['states'],
): { tone: Tone; icon: IconName; label: string } {
  const key = w.connected ? w.state : 'offline';
  const s = STATE[key];
  const label = (words as Readonly<Record<string, string>>)[key];
  return s === undefined || label === undefined
    ? { tone: 'neutral', icon: 'cpu', label: key }
    : { ...s, label };
}

export function MachinesTab(props: { readonly project: Project; readonly canEdit: boolean }): ReactNode {
  return (
    <DyFormScope readOnly={!props.canEdit}>
      <MachinesCard project={props.project} canEdit={props.canEdit} />
    </DyFormScope>
  );
}

function MachinesCard(props: { readonly project: Project; readonly canEdit: boolean }): ReactNode {
  const t = useT().projects.machines;
  const project = props.project.id;
  const workspace = props.project.kind === 'workspace';
  const [items, setItems] = useState<ProjectWorker[] | null>(null);
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  // p18-project-bootstrap: the preferred machines as saved (null: not supported here) and as edited.
  const [preferred, setPreferred] = useState<ReadonlySet<string> | null>(null);
  const [prefChosen, setPrefChosen] = useState<ReadonlySet<string>>(new Set());
  const load = useSubmit();
  const save = useSubmit();
  const sectionSave = useSectionSave();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [list, git, pref] = await Promise.all([
        listProjectWorkers(project),
        workspace ? Promise.resolve(null) : getProjectGitConfig(project),
        getPreferredWorkers(project).catch(() => null),
      ]);
      setItems(list);
      setChosen(new Set(list.filter((w) => w.assigned).map((w) => w.workerId)));
      setRegistered(workspace || git !== null);
      setPreferred(pref === null ? null : new Set(pref.workerIds));
      setPrefChosen(new Set(pref?.workerIds ?? []));
    });
  }, [load, project, workspace]);

  useEffect(() => {
    void refresh();
    // refresh depends on the project only (load.run is stable).
  }, [project]);

  const prefChanged =
    preferred !== null &&
    (preferred.size !== prefChosen.size || [...prefChosen].some((id) => !preferred.has(id)));
  const changed = (items !== null && items.some((w) => w.assigned !== chosen.has(w.workerId))) || prefChanged;
  const assigned = items === null ? 0 : items.filter((w) => w.assigned).length;

  const store = (): Promise<boolean> => {
    return sectionSave(
      save,
      async () => {
        if (items !== null && items.some((w) => w.assigned !== chosen.has(w.workerId))) {
          const list = await setProjectWorkers(project, [...chosen]);
          setItems(list);
          setChosen(new Set(list.filter((w) => w.assigned).map((w) => w.workerId)));
        }
        if (prefChanged) {
          const pref = await setPreferredWorkers(project, [...prefChosen]);
          setPreferred(new Set(pref.workerIds));
          setPrefChosen(new Set(pref.workerIds));
        }
        // p17-toasts-rest: a save result → toast. Saved from the tab's sticky bar, the bar's own "Kaydedildi"
        // toast is the result (one toast, not two).
        if (!card.inScope)
          toast.success(t.saved, { id: 'project-machines-saved', testId: 'project-machines-saved' });
      },
      t.stepUp({ project }),
    );
  };
  const card = useCardForm({
    dirty: props.canEdit && changed,
    busy: save.busy,
    save: store,
    discard: () => {
      if (items !== null) setChosen(new Set(items.filter((w) => w.assigned).map((w) => w.workerId)));
      setPrefChosen(new Set(preferred ?? []));
    },
  });

  return (
    <Panel
      title={t.title}
      count={items === null ? undefined : `${String(assigned)}/${String(items.length)}`}
      countLabel={items === null ? undefined : t.countLabel({ total: items.length, assigned })}
      sub={t.sub}
      flush
      testId="dy-project-machines-tab"
    >
      <DyApiError error={load.error} retryLeft={load.retryLeft} className="px-4" />
      {items === null ? (
        load.error === null ? (
          <SkeletonRows label={t.loading} rows={3} />
        ) : null
      ) : (
        <div className="flex flex-col gap-3">
          {registered === false ? (
            <div className="px-4">
              <DyNotice tone="amber" testId="workers-need-repo">
                {t.needRepo}
              </DyNotice>
            </div>
          ) : null}
          {items.length === 0 ? (
            <EmptyLine
              action={
                <DyButtonLink to="/machines/add" icon="plus">
                  {t.add}
                </DyButtonLink>
              }
            >
              {t.none}
            </EmptyLine>
          ) : (
            <Rows label={t.rows}>
              {items.map((w) => {
                const st = stateOf(w, t.states);
                const on = chosen.has(w.workerId);
                return (
                  <Row
                    key={w.workerId}
                    testId="project-worker"
                    lead={
                      <label className="-m-2 inline-flex size-9 items-center justify-center">
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--dy-teal)]"
                          aria-label={t.assign({ name: w.displayName })}
                          checked={on}
                          disabled={!props.canEdit || (registered === false && !on)}
                          onChange={(e) => {
                            const next = new Set(chosen);
                            if (e.target.checked) next.add(w.workerId);
                            else next.delete(w.workerId);
                            setChosen(next);
                          }}
                        />
                      </label>
                    }
                    title={
                      <Link
                        to={machineHref(w.workerId)}
                        translate="no"
                        className="font-dy-mono text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                      >
                        {w.displayName}
                      </Link>
                    }
                    meta={
                      <>
                        <span
                          className={`inline-flex items-center gap-1 font-bold ${INK[st.tone]}`}
                          data-testid="project-worker-state"
                        >
                          <DyIcon name={st.icon} className="size-3.5" />
                          {st.label}
                        </span>
                        {w.assigned && w.generation !== null ? (
                          <span className="font-dy-mono tabular-nums">
                            {t.generation({
                              applied: w.appliedGeneration === null ? '—' : String(w.appliedGeneration),
                              generation: String(w.generation),
                            })}
                          </span>
                        ) : null}
                      </>
                    }
                    trail={
                      <>
                        {w.assigned ? (
                          <Pill tone="teal" icon="check">
                            {t.assigned}
                          </Pill>
                        ) : null}
                        {w.effective === true ? (
                          <Pill tone="green" icon="checkc">
                            {t.applied}
                          </Pill>
                        ) : null}
                        {w.assigned && w.effective === false && w.blocked === null ? (
                          <Pill tone="amber" icon="clock">
                            {t.notApplied}
                          </Pill>
                        ) : null}
                        {!w.managed ? (
                          <Pill tone="neutral" icon="file">
                            {t.localFile}
                          </Pill>
                        ) : null}
                        {w.managed && !w.supported ? (
                          <Pill tone="red" icon="xc">
                            {t.tooOld}
                          </Pill>
                        ) : null}
                        {preferred !== null && (props.canEdit || prefChosen.has(w.workerId)) ? (
                          <button
                            type="button"
                            className="cursor-pointer rounded-full disabled:cursor-default"
                            data-testid="project-worker-preferred"
                            aria-pressed={prefChosen.has(w.workerId)}
                            aria-label={t.preferToggle({ name: w.displayName })}
                            title={t.preferHint}
                            disabled={!props.canEdit}
                            onClick={() => {
                              const next = new Set(prefChosen);
                              if (next.has(w.workerId)) next.delete(w.workerId);
                              else next.add(w.workerId);
                              setPrefChosen(next);
                            }}
                          >
                            <Pill tone={prefChosen.has(w.workerId) ? 'violet' : 'neutral'} icon="flag">
                              {prefChosen.has(w.workerId) ? t.preferred : t.prefer}
                            </Pill>
                          </button>
                        ) : null}
                      </>
                    }
                  />
                );
              })}
            </Rows>
          )}
          {items
            .filter((w) => w.blocked !== null)
            .map((w) => (
              <div key={`blocked-${w.workerId}`} className="px-4">
                <DyReason
                  reason={w.blocked ?? ''}
                  tone="danger"
                  context={{ workerId: w.workerId, workerName: w.displayName }}
                />
              </div>
            ))}
          {props.canEdit && items.length > 0 && !card.inScope ? (
            <div className="flex flex-wrap items-center gap-3 px-4 pb-4">
              <DyButton variant="primary" disabled={!changed} busy={save.busy} onClick={card.submit}>
                {t.save}
              </DyButton>
              {changed ? <span className="text-[0.8125rem] text-dy-muted">{t.unsaved}</span> : null}
            </div>
          ) : null}
          <DyApiError error={save.error} retryLeft={save.retryLeft} className="px-4 pb-4" />
        </div>
      )}
    </Panel>
  );
}
