import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  addAutomationGroupProjects,
  type Automation,
  type AutomationGroup,
  type AutomationGroupAction,
  type AutomationGroupAdded,
  type AutomationGroupApplied,
  type AutomationGroupCreated,
  type AutomationGroupLifecycle,
  automationGroupAction,
  getAutomationGroup,
} from '../../../api/automations';
import { ApiError } from '../../../api/client';
import { listProjects, type Project } from '../../../api/directory';
import { toApiError } from '../../../components/ui';
import { useErrorText } from '../../../i18n/errors';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { ProjectChecks } from '../../common/ProjectChecks';
import { DyApiError, DyCheck, DyConfirm, DyNotice } from '../kit';
import { DyButton, DyButtonLink, ErrorLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { AutomationPill, SecretPanel } from './shared';

/**
 * p18-multi-project W4 (docs/design/p18-multi-project.md §2.2): automation groups in the Diyalog automation screens —
 * "Başka projelerde de oluştur" in the form (one automation per project), "Tümüne uygula" when editing a grouped
 * automation, the result of either (created / changed per project, refused / skipped ones with their reason, webhook
 * secrets once), and the group panel of an automation's page (its siblings, which ones diverged).
 */

const href = (id: string): string => `/automations/${encodeURIComponent(id)}`;

/** The refusal of one project in the user's language (the catalog's text for its code, else the master's). */
function useRefusalText(): (r: { readonly code: string; readonly message: string }) => string {
  const say = useErrorText();
  return (r) => say(new ApiError(400, r.code, r.message));
}

/** Form (create): the other projects the same automation is also created in. */
export function GroupExtras(props: {
  readonly projects: readonly Project[] | null;
  readonly primary: string;
  readonly chosen: readonly string[];
  readonly onChange: (next: string[]) => void;
}): ReactNode {
  const t = useT().multiProject.groups;
  const others = (props.projects ?? []).filter((p) => p.id !== props.primary && p.myRole !== 'viewer');
  return (
    <div className="grid gap-1.5">
      <ProjectChecks
        legend={t.extra}
        hint={t.extraHint}
        empty={t.extraNone}
        projects={others}
        chosen={props.chosen}
        onChange={props.onChange}
        max={19}
        testId="automation-group-extras"
      />
      {props.chosen.length === 0 ? null : (
        <p className="m-0 text-[0.8125rem] font-bold text-dy-teal-ink" data-testid="automation-group-count">
          {t.count({ n: props.chosen.length + 1 })}
        </p>
      )}
    </div>
  );
}

/** Form (edit): apply the change to every sibling of the group. */
export function GroupApplyToggle(props: {
  readonly automation: Automation;
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
}): ReactNode {
  const t = useT().multiProject.groups;
  const g = props.automation.group;
  if (g === null || g.size < 2) return null;
  return (
    <div data-testid="automation-group-apply">
      <DyCheck
        label={t.applyAll({ n: g.size })}
        hint={t.applyHint}
        checked={props.checked}
        onChange={props.onChange}
      />
    </div>
  );
}

/** The result of creating a group: what was created where (webhook secrets once), what was refused and why. */
export function GroupCreatedResult(props: { readonly out: AutomationGroupCreated }): ReactNode {
  const t = useT().multiProject.groups;
  const refusal = useRefusalText();
  const { out } = props;
  const total = out.created.length + out.refused.length;
  return (
    <div className="grid gap-4" data-testid="automation-group-result">
      <DyNotice tone={out.refused.length === 0 ? 'green' : 'amber'} live>
        {t.created({ n: out.created.length, total })}
      </DyNotice>
      <Panel title={t.createdTitle} flush>
        <Rows label={t.createdTitle}>
          {out.created.map((c) => (
            <Row
              key={c.automation.id}
              testId="automation-group-created"
              title={
                <Link to={href(c.automation.id)} className="text-dy-ink no-underline hover:underline">
                  {c.automation.name}
                </Link>
              }
              meta={<span>{c.project}</span>}
              trail={<AutomationPill state={c.automation.state} />}
            />
          ))}
        </Rows>
      </Panel>
      {out.created
        .filter((c) => c.webhook !== null)
        .map((c) =>
          c.webhook === null ? null : (
            <section key={`hook:${c.automation.id}`} aria-label={t.webhookFor({ project: c.project })}>
              <h3 className="m-0 mb-2 text-[0.9375rem] font-bold">{t.webhookFor({ project: c.project })}</h3>
              <SecretPanel webhook={c.webhook} />
            </section>
          ),
        )}
      {out.refused.length === 0 ? null : (
        <Panel title={t.refusedTitle} flush>
          <Rows label={t.refusedTitle}>
            {out.refused.map((r) => (
              <Row
                key={r.project}
                testId="automation-group-refused"
                tone="amber"
                title={r.project}
                meta={<span className="[overflow-wrap:anywhere]">{refusal(r)}</span>}
              />
            ))}
          </Rows>
        </Panel>
      )}
      <div>
        <DyButtonLink to="/automations">{t.back}</DyButtonLink>
      </div>
    </div>
  );
}

/** The result of "Tümüne uygula": how many changed, which were skipped (diverged) and why. */
export function GroupAppliedResult(props: {
  readonly out: AutomationGroupApplied;
  readonly back: string;
}): ReactNode {
  const t = useT().multiProject.groups;
  const refusal = useRefusalText();
  const { out } = props;
  const total = out.applied.length + out.skipped.length + out.hiddenSkipped;
  return (
    <div className="grid gap-4" data-testid="automation-group-applied">
      <DyNotice tone={out.skipped.length === 0 && out.hiddenSkipped === 0 ? 'green' : 'amber'} live>
        {t.applied({ n: out.applied.length, total })}
      </DyNotice>
      {out.applied
        .filter((a) => a.webhook !== null)
        .map((a) =>
          a.webhook === null ? null : (
            <section key={`hook:${a.id}`} aria-label={t.webhookFor({ project: a.project })}>
              <h3 className="m-0 mb-2 text-[0.9375rem] font-bold">{t.webhookFor({ project: a.project })}</h3>
              <SecretPanel webhook={a.webhook} />
            </section>
          ),
        )}
      {out.skipped.length === 0 ? null : (
        <Panel title={t.skippedTitle} flush>
          <Rows label={t.skippedTitle}>
            {out.skipped.map((k) => (
              <Row
                key={k.id}
                testId="automation-group-skipped"
                tone="amber"
                title={
                  <Link to={href(k.id)} className="text-dy-ink no-underline hover:underline">
                    {k.project}
                  </Link>
                }
                meta={<span className="[overflow-wrap:anywhere]">{refusal(k)}</span>}
              />
            ))}
          </Rows>
        </Panel>
      )}
      {out.hiddenSkipped === 0 ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.hiddenSkipped({ n: out.hiddenSkipped })}</p>
      )}
      <div>
        <DyButtonLink to={props.back} variant="primary">
          {t.open}
        </DyButtonLink>
      </div>
    </div>
  );
}

/** The list row's group pill ("Grup · 3 proje", amber when this sibling diverged). */
export function GroupPill(props: { readonly automation: Automation }): ReactNode {
  const t = useT().multiProject.groups;
  const g = props.automation.group;
  if (g === null || g.size < 2) return null;
  return (
    <Pill tone={g.diverged ? 'amber' : 'teal'} icon="folder" title={g.diverged ? t.divergedHint : undefined}>
      <span data-testid="automation-group-pill">
        {g.diverged ? `${t.pill({ n: g.size })} · ${t.diverged}` : t.pill({ n: g.size })}
      </span>
    </Pill>
  );
}

/** The automation page's group panel: the siblings in the projects the reader can see. */
export function GroupPanel(props: {
  readonly automation: Automation;
  /** p18-leftovers: a whole-group action changed this automation too (the page reloads it). */
  readonly onChanged?: () => void;
}): ReactNode {
  const t = useT().multiProject.groups;
  const g = props.automation.group;
  const groupId = g?.id ?? null;
  const [group, setGroup] = useState<AutomationGroup | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (groupId === null) return;
    let live = true;
    getAutomationGroup(groupId).then(
      (x) => {
        if (live) setGroup(x);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [groupId, tick]);
  if (g === null || g.size < 2) return null;
  const self = props.automation.id;
  return (
    <Panel
      title={t.panelTitle}
      sub={t.panelSub}
      flush
      testId="automation-group-panel"
      aside={
        props.automation.workflowBinding === null ? (
          <DyButtonLink to={`${href(self)}/edit`} icon="pen">
            {t.editAll}
          </DyButtonLink>
        ) : undefined
      }
    >
      <div className="px-4 empty:hidden">
        <ErrorLine error={error} what={t.panelTitle} />
      </div>
      {group === null ? (
        error === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : null
      ) : (
        <>
          <Rows label={t.panelTitle}>
            {group.members.map((m) => (
              <Row
                key={m.id}
                testId="automation-group-member"
                title={
                  m.id === self ? (
                    <span>{`${m.project} · ${t.thisOne}`}</span>
                  ) : (
                    <Link to={href(m.id)} className="text-dy-ink no-underline hover:underline">
                      {m.project}
                    </Link>
                  )
                }
                meta={
                  <>
                    <span>{m.triggerSummary}</span>
                    {m.canEdit ? null : <span>{t.readOnly}</span>}
                  </>
                }
                trail={
                  <>
                    {m.diverged ? (
                      <Pill tone="amber" title={t.divergedHint}>
                        <span data-testid="automation-group-diverged">{t.diverged}</span>
                      </Pill>
                    ) : null}
                    <AutomationPill state={m.state} />
                  </>
                }
              />
            ))}
          </Rows>
          {group.hidden === 0 ? null : (
            <p className="m-0 px-4 py-2 text-[0.8125rem] text-dy-muted">{t.hidden({ n: group.hidden })}</p>
          )}
          {props.automation.workflowBinding === null && group.members.some((m) => m.canEdit) ? (
            <GroupActions
              group={group}
              onChanged={() => {
                setTick((n) => n + 1);
                props.onChanged?.();
              }}
            />
          ) : null}
        </>
      )}
    </Panel>
  );
}

/**
 * p18-leftovers (docs/design/p18-multi-project.md §11 "Leftovers"): the group panel's actions — "Projeye ekle" (the
 * group's automation in more projects, step-up) and the whole group's pause / resume / delete in one action. Each
 * result lists what changed and what was refused with its reason.
 */
function GroupActions(props: { readonly group: AutomationGroup; readonly onChanged: () => void }): ReactNode {
  const t = useT().multiProject.groups;
  const refusal = useRefusalText();
  const stepUp = useStepUp();
  const submit = useSubmit();
  const { group } = props;
  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [added, setAdded] = useState<AutomationGroupAdded | null>(null);
  const [result, setResult] = useState<{
    action: AutomationGroupAction;
    out: AutomationGroupLifecycle;
  } | null>(null);
  useEffect(() => {
    if (!adding || projects !== null) return;
    listProjects().then(setProjects, () => {
      setProjects([]);
    });
  }, [adding, projects]);
  const inGroup = new Set(group.members.map((m) => m.project));
  const candidates = (projects ?? []).filter((p) => !inGroup.has(p.id) && p.myRole !== 'viewer');
  const room = Math.max(0, 20 - group.members.length - group.hidden);
  const anyActive = group.members.some((m) => m.canEdit && m.state === 'active');
  const anyPaused = group.members.some((m) => m.canEdit && (m.state === 'paused' || m.state === 'failed'));
  const run = (action: AutomationGroupAction): void => {
    setAdded(null);
    void submit
      .run(async () => {
        try {
          const out = await stepUp.run(() => automationGroupAction(group.id, action), t.stepUpResume);
          setResult({ action, out });
        } catch (err) {
          if (!(err instanceof StepUpCancelledError)) throw err;
        }
      })
      .then((ok) => {
        if (ok) props.onChanged();
      });
  };
  const add = (): void => {
    setResult(null);
    void submit
      .run(async () => {
        try {
          const out = await stepUp.run(
            () => addAutomationGroupProjects(group.id, { projects: chosen }),
            t.stepUpAdd,
          );
          setAdded(out);
          setChosen([]);
          setAdding(false);
        } catch (err) {
          if (!(err instanceof StepUpCancelledError)) throw err;
        }
      })
      .then((ok) => {
        if (ok) props.onChanged();
      });
  };
  const editable = group.members.filter((m) => m.canEdit).length;
  return (
    <div className="grid gap-3 border-t border-dy-line px-4 py-3" data-testid="automation-group-actions">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.8125rem] font-bold text-dy-muted">{t.wholeGroup}</span>
        <DyButton
          icon="plus"
          busy={submit.busy && adding}
          aria-expanded={adding}
          data-testid="automation-group-add"
          onClick={() => {
            setAdding((v) => !v);
          }}
        >
          {t.addTitle}
        </DyButton>
        {anyActive ? (
          <DyButton
            icon="pause"
            busy={submit.busy}
            data-testid="automation-group-pause"
            onClick={() => {
              run('pause');
            }}
          >
            {t.pauseAll}
          </DyButton>
        ) : null}
        {anyPaused ? (
          <DyButton
            icon="retry"
            busy={submit.busy}
            data-testid="automation-group-resume"
            onClick={() => {
              run('resume');
            }}
          >
            {t.resumeAll}
          </DyButton>
        ) : null}
        <DyConfirm
          label={t.deleteAll}
          icon="trash"
          question={t.deleteAllQuestion({ n: editable })}
          description={t.deleteAllDesc}
          confirmLabel={t.deleteAllConfirm}
          testId="automation-group-delete"
          busy={submit.busy}
          onConfirm={() => {
            run('delete');
          }}
        />
      </div>
      {adding ? (
        <div className="grid gap-2" data-testid="automation-group-add-form">
          {projects === null ? (
            <SkeletonRows label={t.loading} rows={1} />
          ) : (
            <ProjectChecks
              legend={t.addTitle}
              hint={t.addHint}
              empty={t.addNone}
              projects={candidates}
              chosen={chosen}
              onChange={setChosen}
              max={room}
              testId="automation-group-add-projects"
            />
          )}
          <div>
            <DyButton
              variant="primary"
              busy={submit.busy}
              disabled={chosen.length === 0}
              data-testid="automation-group-add-submit"
              onClick={add}
            >
              {t.addSubmit({ n: chosen.length })}
            </DyButton>
          </div>
        </div>
      ) : null}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      {added === null ? null : (
        <div className="grid gap-2" data-testid="automation-group-added">
          <DyNotice tone={added.refused.length === 0 ? 'green' : 'amber'} live>
            {t.added({ n: added.created.length, total: added.created.length + added.refused.length })}
          </DyNotice>
          {added.created.map((c) => (
            <div key={c.automation.id} className="grid gap-2">
              <Link to={href(c.automation.id)} className="text-[0.875rem] font-bold text-dy-teal-ink">
                {`${c.project} · ${c.automation.name}`}
              </Link>
              {c.webhook === null ? null : <SecretPanel webhook={c.webhook} />}
            </div>
          ))}
          {added.refused.map((r) => (
            <p
              key={r.project}
              className="m-0 text-[0.8125rem] text-dy-amber-ink [overflow-wrap:anywhere]"
              data-testid="automation-group-add-refused"
            >
              {`${r.project}: ${refusal(r)}`}
            </p>
          ))}
        </div>
      )}
      {result === null ? null : (
        <div className="grid gap-2" data-testid="automation-group-lifecycle">
          <DyNotice tone={result.out.skipped.length === 0 ? 'green' : 'amber'} live>
            {t.lifecycleDone({
              action: result.action,
              n: result.out.done.length,
              total: result.out.done.length + result.out.skipped.length + result.out.unchanged.length,
            })}
          </DyNotice>
          {result.out.unchanged.length === 0 ? null : (
            <p className="m-0 text-[0.8125rem] text-dy-muted">
              {t.unchanged({ n: result.out.unchanged.length })}
            </p>
          )}
          {result.out.skipped.length === 0 ? null : (
            <div className="grid gap-1">
              <h4 className="m-0 text-[0.8125rem] font-bold">{t.notChangedTitle}</h4>
              {result.out.skipped.map((k) => (
                <p
                  key={k.id}
                  className="m-0 text-[0.8125rem] text-dy-amber-ink [overflow-wrap:anywhere]"
                  data-testid="automation-group-lifecycle-skipped"
                >
                  {`${k.project}: ${refusal(k)}`}
                </p>
              ))}
            </div>
          )}
          {result.out.hiddenSkipped === 0 ? null : (
            <p className="m-0 text-[0.8125rem] text-dy-muted">
              {t.hiddenSkipped({ n: result.out.hiddenSkipped })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
