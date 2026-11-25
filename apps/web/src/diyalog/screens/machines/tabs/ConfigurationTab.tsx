import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, type ApiIssue } from '../../../../api/client';
import {
  type ConfigStatus,
  getWorkerConfig,
  putWorkerConfig,
  type WorkerConfigReport,
  type WorkerConfigView,
} from '../../../../api/workerConfig';
import { cx, toApiError } from '../../../../components/ui';
import {
  cleanSpec,
  cloneSpec,
  type Draft,
  labelsText,
  parseLabels,
} from '../../../../screens/fleet/workerConfig';
import { useSubmit } from '../../../../screens/useSubmit';
import { KeyValue, type KeyValueRow } from '../../../KeyValue';
import type { IconName } from '../../../icons';
import type { Tone } from '../../../tone';
import { DyApiError, DyField, DyNotice, FormActions } from '../../forms';
import { DyButton, Panel, Pill, SkeletonRows } from '../../parts';
import { ConfigHistory } from './config-history';
import { CredentialsSection, GeneralSection, RuntimesSection } from './config-sections';
import { LocalSettingsSection } from './config-local';
import { useGuarded, whenText } from './config-shared';
import { DyFormScope, sameValue, useCardForm } from '../../../formkit';
import type { MachineTabProps } from './types';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { useDoneToast } from '../../../toast/useDoneToast';

/**
 * p12-diyalog wave 2 (W3) — Makine → Yapılandırma in the Diyalog language, feature for feature with the classic
 * `WorkerConfigPanel` (ADR-0015, p5-managed-workers): desired vs applied generation, drift, the worker's local
 * ceiling and what it blocks, a refused generation with its reason; owners / admins edit projects (registered
 * repositories only), runtimes, parallelism, sandbox profiles, workspace options, labels, per-runtime models and
 * auth (by reference only), take an unmanaged worker over from its local file, discard edits, and roll back to an
 * earlier generation. Every write through step-up with `expectedGeneration`; a 409 reloads the current generation.
 * The classic helpers (`cloneSpec`, `cleanSpec`, `parseLabels`) shape what is sent.
 *
 * p17-worker-managed: Yerel ayarlar — the worker's local settings (config-local.tsx) in the same document.
 *
 * p15-form-pattern: the configuration is ONE versioned document, so the Genel · Runtime'lar · Kimlik bilgileri section
 * tabs are views of one form — switching keeps the edits (no question), and the tab's sticky bar saves the whole
 * document (Vazgeç reloads the current generation). Geçmiş (roll back) is an action on the saved generations.
 */

const STATUS: Readonly<Record<ConfigStatus, { tone: Tone; icon: IconName }>> = {
  applied: { tone: 'green', icon: 'checkc' },
  pending: { tone: 'amber', icon: 'clock' },
  rejected: { tone: 'red', icon: 'xc' },
  unmanaged: { tone: 'neutral', icon: 'file' },
  unsupported: { tone: 'red', icon: 'xc' },
};

type Section = 'general' | 'runtimes' | 'credentials' | 'local' | 'history';
const SECTIONS: readonly Section[] = ['general', 'runtimes', 'credentials', 'local', 'history'];

function SectionTabs(props: {
  readonly value: Section;
  readonly onChange: (s: Section) => void;
  readonly panelId: string;
  readonly baseId: string;
}): ReactNode {
  const t = useT().machineConfig.config;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = SECTIONS.findIndex((s) => s === props.value);
    const last = SECTIONS.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = i >= last ? 0 : i + 1;
    else if (e.key === 'ArrowLeft') next = i <= 0 ? last : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    const item = SECTIONS[next];
    if (item === undefined) return;
    props.onChange(item);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={t.sectionsLabel}
      onKeyDown={move}
      className="dy-noscrollbar dy-scroll-fade flex max-w-full gap-0.5 overflow-x-auto rounded-[10px] border border-dy-line bg-dy-sunk p-[3px] sm:inline-flex sm:self-start"
    >
      {SECTIONS.map((s, i) => {
        const on = s === props.value;
        return (
          <button
            key={s}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${props.baseId}-${s}`}
            aria-selected={on}
            aria-controls={props.panelId}
            tabIndex={on ? 0 : -1}
            onClick={() => {
              props.onChange(s);
            }}
            className={cx(
              'inline-flex min-h-9 shrink-0 items-center rounded-[7px] px-3 text-[0.84375rem] font-medium whitespace-nowrap',
              on
                ? 'bg-dy-card text-dy-ink shadow-dy-seg'
                : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
            )}
          >
            {t.sections[s]}
          </button>
        );
      })}
    </div>
  );
}

/** The worker's report: what is in effect, the local ceiling, blocked items, a refused generation. */
function ReportDetails(props: { readonly report: WorkerConfigReport | null }): ReactNode {
  const t = useT().machineConfig.config;
  const r = props.report;
  if (r === null) return <p className="m-0 text-[0.875rem] text-dy-muted">{t.notReported}</p>;
  const c = r.ceiling;
  const none = (l: readonly string[]): string => (l.length === 0 ? t.none : l.join(', '));
  const ceiling: KeyValueRow[] = [];
  if (c.projects !== null) ceiling.push({ k: t.ceilingProjects, v: none(c.projects) });
  if (c.repoHosts !== null) ceiling.push({ k: t.ceilingRepoHosts, v: none(c.repoHosts) });
  if (c.allowedRuntimes !== null) ceiling.push({ k: t.ceilingRuntimes, v: none(c.allowedRuntimes) });
  if (c.maxParallelJobs !== null) ceiling.push({ k: t.ceilingParallel, v: String(c.maxParallelJobs) });
  if (c.sandboxProfiles !== null) ceiling.push({ k: t.ceilingSandbox, v: none(c.sandboxProfiles) });
  if (c.pinnedRuntimes.length > 0) ceiling.push({ k: t.ceilingPinned, v: c.pinnedRuntimes.join(', ') });
  return (
    <div className="flex flex-col gap-3 text-[0.875rem]">
      <p className="m-0" data-testid="config-effective">
        <span className="font-bold">{t.effectiveNow}</span>{' '}
        {t.effective({
          n: r.effective.projects.length,
          projects: none(r.effective.projects),
          runtimes: none(r.effective.allowedRuntimes),
          parallel: r.effective.maxParallelJobs,
        })}
      </p>
      {ceiling.length > 0 ? (
        <div data-testid="config-ceiling">
          <p className="m-0 mb-1 font-bold">{t.ceiling}</p>
          <KeyValue rows={ceiling} />
        </div>
      ) : (
        <p className="m-0 text-dy-muted">{t.noCeiling}</p>
      )}
      {r.blocked.length > 0 ? (
        <ul
          className="m-0 flex list-none flex-col gap-0.5 p-0 text-[0.8125rem] text-dy-amber-ink"
          data-testid="config-blocked"
          aria-label={t.blocked}
        >
          {r.blocked.map((b) => (
            <li key={`${b.path}-${b.code}`} className="[overflow-wrap:anywhere]">
              <span className="font-dy-mono">{b.path}</span> — {b.code}
              {b.detail === undefined ? '' : `: ${b.detail}`}
            </li>
          ))}
        </ul>
      ) : null}
      {r.rejected !== undefined ? (
        <DyNotice tone="red" title={t.rejectedBy({ generation: r.rejected.generation })}>
          <span data-testid="config-rejected">
            {r.rejected.reason}
            {r.rejected.detail === undefined ? '' : ` — ${r.rejected.detail}`}
          </span>
          {r.rejected.issues.length > 0 ? (
            <ul className="m-0 mt-1 list-disc pl-4">
              {r.rejected.issues.map((i) => (
                <li key={`${i.path}-${i.code}`}>
                  <span className="font-dy-mono">{i.path}</span>: {i.code}
                </li>
              ))}
            </ul>
          ) : null}
        </DyNotice>
      ) : null}
    </div>
  );
}

export function ConfigurationTab(props: MachineTabProps): ReactNode {
  return (
    <DyFormScope>
      <ConfigurationForm {...props} />
    </DyFormScope>
  );
}

function ConfigurationForm(props: MachineTabProps): ReactNode {
  const fmt = useFormat();
  const t = useT().machineConfig.config;
  const workerId = props.worker.id;
  const workerName = props.worker.name;
  const [view, setView] = useState<WorkerConfigView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adopt, setAdopt] = useState(false);
  const [labels, setLabels] = useState('');
  const [note, setNote] = useState('');
  const [section, setSection] = useState<Section>('general');
  const [issues, setIssues] = useState<readonly ApiIssue[]>([]);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const load = useSubmit();
  const save = useSubmit();
  const guarded = useGuarded();
  const baseId = useId();
  const panelId = `${baseId}-panel`;

  const refresh = useCallback(
    async (message: string | null = null) => {
      await load.run(async () => {
        const v = await getWorkerConfig(workerId);
        setView(v);
        setAdopt(false);
        const base = v.desired?.spec ?? null;
        setDraft(base === null ? null : cloneSpec(base));
        setLabels(base === null ? '' : labelsText(base.labels));
        setDone(message);
      });
    },
    [load.run, workerId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const takeOver = (): void => {
    if (view === null) return;
    setDraft(cloneSpec(view.suggested));
    setLabels(labelsText(view.suggested.labels));
    setAdopt(true);
    setSection('general');
  };

  const onSave = async (): Promise<boolean> => {
    if (view === null || draft === null) return false;
    const parsed = parseLabels(labels);
    if (parsed.invalid.length > 0) {
      setIssues([{ path: 'labels', code: t.notKeyValue({ lines: parsed.invalid.join(', ') }) }]);
      return false;
    }
    setIssues([]);
    setDone(null);
    const spec = cleanSpec({ ...draft, labels: parsed.labels });
    const expectedGeneration = view.desired?.generation ?? 0;
    const flags = { conflict: false, saved: false };
    const ok = await save.run(async () => {
      try {
        await guarded(
          async () => {
            const next = await putWorkerConfig(workerId, {
              spec,
              expectedGeneration,
              ...(note.trim() === '' ? {} : { changeNote: note.trim() }),
              ...(adopt ? { adopt: true } : {}),
            });
            setView(next);
            setDraft(next.desired === null ? null : cloneSpec(next.desired.spec));
            setLabels(next.desired === null ? '' : labelsText(next.desired.spec.labels));
            setAdopt(false);
            setNote('');
            setDone(t.saved({ generation: String(next.desired?.generation ?? '?') }));
            flags.saved = true;
          },
          t.whySave({ machine: workerName }),
        );
      } catch (err) {
        const e = toApiError(err);
        if (e.status === 400 && e.issues.length > 0) setIssues(e.issues);
        if (e.status === 409 && e.code === 'version_conflict') flags.conflict = true;
        throw err;
      }
    });
    if (!ok && flags.conflict) {
      await refresh(t.conflict);
    }
    return ok && flags.saved;
  };

  const base = view?.desired?.spec ?? null;
  const card = useCardForm({
    dirty:
      draft !== null &&
      (adopt ||
        base === null ||
        !sameValue(draft, cloneSpec(base)) ||
        labels.trim() !== labelsText(base.labels).trim()),
    busy: save.busy,
    save: onSave,
    discard: () => {
      setIssues([]);
      void refresh();
    },
    saveLabel: adopt ? t.adoptAndSave : undefined,
  });

  if (view === null)
    return (
      <div className="flex flex-col gap-4" data-testid="worker-config-panel">
        <DyApiError error={load.error} retryLeft={load.retryLeft} />
        {load.error === null ? (
          <Panel title={t.title} flush>
            <SkeletonRows label={t.loading} rows={3} />
          </Panel>
        ) : null}
      </div>
    );

  const desired = view.desired;
  const report = view.report;
  const applied = report?.source === 'panel' ? report.generation : null;
  const st = STATUS[view.status];
  const facts: KeyValueRow[] = [
    {
      k: t.desired,
      v: desired === null ? '—' : <span className="font-dy-mono">g{desired.generation}</span>,
    },
    { k: t.applied, v: applied === null ? '—' : <span className="font-dy-mono">g{applied}</span> },
  ];
  if (view.delivered.at !== null) facts.push({ k: t.delivered, v: whenText(view.delivered.at, fmt) });

  return (
    <div className="flex flex-col gap-5" data-testid="worker-config-panel">
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      <Panel
        title={t.statusTitle}
        aside={
          <span data-testid="config-status" data-status={view.status}>
            <Pill tone={st.tone} icon={st.icon}>
              {t.status[view.status]}
            </Pill>
          </span>
        }
      >
        <div className="flex flex-col gap-3">
          <div data-testid="config-summary">
            <KeyValue rows={facts} />
          </div>
          {view.status === 'unsupported' ? <DyNotice tone="amber">{t.unsupported}</DyNotice> : null}
          {view.drift.length > 0 ? (
            <ul
              className="m-0 flex list-none flex-col gap-0.5 rounded-[10px] bg-dy-amber-soft px-3.5 py-2.5 text-[0.8125rem] text-dy-amber-ink"
              data-testid="config-drift"
              aria-label={t.drift}
            >
              {view.drift.map((d) => (
                <li key={`${d.path}-${d.reason}`} className="[overflow-wrap:anywhere]">
                  {d.path === '' ? '' : <span className="font-dy-mono">{d.path}: </span>}
                  {d.reason}
                </li>
              ))}
            </ul>
          ) : null}
          <ReportDetails report={report} />
        </div>
      </Panel>

      {draft === null && section !== 'history' ? (
        <Panel title={t.unmanagedTitle} testId="config-unmanaged">
          <p className="m-0 mb-3 text-[0.875rem] text-dy-muted">{t.unmanagedBody}</p>
          <FormActions>
            <DyButton variant="primary" icon="file" onClick={takeOver}>
              {t.takeOver}
            </DyButton>
            <DyButton
              variant="ghost"
              onClick={() => {
                setSection('history');
              }}
            >
              {t.history}
            </DyButton>
          </FormActions>
        </Panel>
      ) : (
        <Panel title={t.edit} sub={adopt ? undefined : t.editSub}>
          <div className="flex flex-col gap-4">
            <SectionTabs value={section} onChange={setSection} panelId={panelId} baseId={baseId} />
            {adopt ? (
              <DyNotice tone="teal" icon="file">
                {t.adopted}
              </DyNotice>
            ) : null}
            <div role="tabpanel" id={panelId} aria-labelledby={`${baseId}-${section}`}>
              {section === 'history' ? (
                <ConfigHistory
                  workerId={workerId}
                  current={desired?.generation ?? null}
                  onRolledBack={() => void refresh(t.rolledBack)}
                />
              ) : draft === null ? null : section === 'general' ? (
                <GeneralSection
                  draft={draft}
                  setDraft={setDraft}
                  view={view}
                  issues={issues}
                  labels={labels}
                  setLabels={setLabels}
                />
              ) : section === 'runtimes' ? (
                <RuntimesSection draft={draft} setDraft={setDraft} issues={issues} view={view} />
              ) : section === 'local' ? (
                <LocalSettingsSection draft={draft} setDraft={setDraft} issues={issues} view={view} />
              ) : (
                <CredentialsSection draft={draft} setDraft={setDraft} issues={issues} view={view} />
              )}
            </div>
            {section !== 'history' && draft !== null ? (
              <div className="flex flex-col gap-3 border-t border-dy-line pt-4">
                <DyField
                  label={t.note}
                  value={note}
                  maxLength={1000}
                  placeholder={t.optional}
                  onChange={setNote}
                  wrapClassName="sm:max-w-[32rem]"
                />
                {issues.length > 0 ? (
                  <DyNotice tone="red" title={t.issuesTitle}>
                    <ul className="m-0 list-disc pl-4" data-testid="config-issues">
                      {issues.map((i) => (
                        <li key={`${i.path}-${i.code}`}>
                          <span className="font-dy-mono">{i.path === '' ? t.document : i.path}</span>:{' '}
                          {i.code}
                        </li>
                      ))}
                    </ul>
                  </DyNotice>
                ) : null}
                {card.inScope ? null : (
                  <FormActions>
                    <DyButton variant="primary" busy={save.busy} onClick={card.submit}>
                      {adopt ? t.adoptAndSave : t.save}
                    </DyButton>
                    <DyButton
                      variant="ghost"
                      disabled={save.busy}
                      onClick={() => {
                        setIssues([]);
                        void refresh();
                      }}
                    >
                      {t.discard}
                    </DyButton>
                  </FormActions>
                )}
              </div>
            ) : null}
          </div>
        </Panel>
      )}
      {save.error !== null && !(save.error instanceof ApiError && save.error.status === 409) ? (
        <DyApiError error={save.error} retryLeft={save.retryLeft} />
      ) : null}
    </div>
  );
}
