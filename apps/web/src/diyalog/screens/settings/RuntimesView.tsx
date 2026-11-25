import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listModels, type ModelView } from '../../../api/models';
import {
  getRuntimePolicyTemplate,
  listRuntimePolicyDetails,
  listRuntimePolicyVersions,
  type PolicyDocument,
  type PolicyModelProfile,
  type PolicyRule,
  type PolicyVersion,
  promoteRuntimePolicy,
  putRuntimePolicy,
  rollbackRuntimePolicyTo,
  type RuntimeAuthMode,
  type RuntimePolicyDetail,
} from '../../../api/runtimePolicy';
import { useAuth } from '../../../auth/AuthProvider';
import { isRetiredRuntime } from '../../../lib/reasons';
import { type Draft, type DraftRow, documentOf, draftOf } from '../../../screens/runtimePolicyDraft';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon } from '../../icons';
import { RuntimeMark, runtimeDisplayName } from '../../RuntimeMark';
import { ConfirmButton, DyApiError, DyCheck, DyDialog, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, EmptyLine, Panel, Pill, SkeletonRows } from '../parts';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../common/time';
import { useDoneToast } from '../../toast/useDoneToast';
import { PlatformProofsPanel, PolicyDependencePanel } from './runtimes-verification';

/**
 * p12-diyalog wave 2 (W3) — Ayarlar → Runtime’lar in the Diyalog language, feature for feature with the classic
 * `RuntimesSettingsPage` (p5-runtime-policy-ui): runtime policy documents (which runtimes a machine group may run, at
 * which pin, how they sign in, unverified / unpinned allowances, model profiles from the catalog and the default),
 * saved as a new version for every machine or staged on canary machines (PUT with step-up and the optimistic
 * `expectedVersion`; a 409 offers "Yeniden yükle"), promote the canary, version history with roll back (step-up).
 * The draft / document conversion is the classic code (`draftOf`, `documentOf`). Owners and admins only.
 */

type RuntimesText = Messages['integrations']['runtimes'];

function name(runtime: string): string {
  return runtimeDisplayName(runtime);
}

/** Problems the master would reject, said before the step-up prompt (the classic checks). */
function draftProblems(t: RuntimesText, d: Draft): string[] {
  const out: string[] = [];
  for (const row of d.rows) {
    if (!row.allowed) continue;
    if (row.rule.authModes.length === 0) out.push(t.problemAuth({ runtime: name(row.runtime) }));
    if (row.rule.modelProfiles.length > 0 && row.rule.defaultProfile === null)
      out.push(t.problemDefault({ runtime: name(row.runtime) }));
  }
  return out;
}

function statusLine(t: RuntimesText, p: RuntimePolicyDetail): string {
  return [
    p.activeVersion === null ? t.noActive : t.active({ version: p.activeVersion }),
    p.canaryVersion === null ? null : t.canaryWaiting({ version: p.canaryVersion }),
    t.machines({ n: p.workers }),
    p.canaryWorkers > 0 ? t.canaryCount({ n: p.canaryWorkers }) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');
}

function RuleEditor(props: {
  readonly row: DraftRow;
  readonly pin: string | undefined;
  readonly models: readonly ModelView[] | null;
  readonly onChange: (row: DraftRow) => void;
}): ReactNode {
  const t = useT().integrations.runtimes;
  const { row } = props;
  const r = row.rule;
  const label = name(row.runtime);
  const set = (rule: Partial<PolicyRule>): void => {
    props.onChange({ ...row, rule: { ...r, ...rule } });
  };
  const toggleAuth = (mode: RuntimeAuthMode, on: boolean): void => {
    set({
      authModes: on
        ? [...r.authModes.filter((m) => m !== mode), mode]
        : r.authModes.filter((m) => m !== mode),
    });
  };
  const catalog = (props.models ?? []).filter(
    (m) =>
      m.enabled &&
      (m.runtimes as readonly string[]).includes(row.runtime) &&
      !r.modelProfiles.some((p) => p.name === m.id),
  );
  const removeProfile = (n: string): void => {
    const modelProfiles = r.modelProfiles.filter((p) => p.name !== n);
    set({
      modelProfiles,
      defaultProfile:
        r.defaultProfile === n || modelProfiles.length === 0
          ? (modelProfiles[0]?.name ?? null)
          : r.defaultProfile,
    });
  };
  const addProfile = (m: ModelView): void => {
    const p: PolicyModelProfile = {
      name: m.id,
      provider: m.provider,
      model: m.model,
      params: { ...m.params },
    };
    set({ modelProfiles: [...r.modelProfiles, p], defaultProfile: r.defaultProfile ?? p.name });
  };
  return (
    <li className="border-t border-dy-line px-4 py-3.5 first:border-t-0" data-testid={`rule-${row.runtime}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <DyCheck
          label={
            <span className="inline-flex items-center gap-2">
              <RuntimeMark runtime={row.runtime} className="font-bold" /> {t.allowedWord}
            </span>
          }
          checked={row.allowed}
          onChange={(allowed) => {
            props.onChange({ ...row, allowed });
          }}
        />
        <span
          className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-dy-muted"
          data-testid={`pin-${row.runtime}`}
        >
          {r.pin === 'hold' ? (
            <span className="flex flex-wrap items-center gap-2" data-testid={`hold-${row.runtime}`}>
              <Pill tone="amber" icon="flag">
                {t.holdBadge({ version: r.version })}
              </Pill>
              {r.hold === undefined ? null : (
                <span>
                  {t.holdBy({ by: r.hold.by, at: r.hold.at.slice(0, 10) })}
                  {r.hold.note === undefined ? '' : ` — ${r.hold.note}`}
                </span>
              )}
            </span>
          ) : (
            <span>
              {t.pinned} <span className="font-dy-mono">{r.version}</span> · {t.followBadge}
            </span>
          )}
          {props.pin !== undefined && props.pin !== r.version ? (
            <Pill tone="amber" icon="flag">
              {t.machinesPin({ pin: props.pin })}
            </Pill>
          ) : null}
        </span>
      </div>
      {row.allowed ? (
        <div className="mt-2 flex flex-col gap-3 pl-[26px]">
          <fieldset className="m-0 border-0 p-0" data-testid={`pin-mode-${row.runtime}`}>
            <legend className="mb-0.5 text-[0.8125rem] font-bold">{t.pinLegend}</legend>
            <div className="flex flex-col gap-1">
              <DyCheck
                label={t.pinFollow}
                hint={t.pinFollowHint}
                checked={r.pin !== 'hold'}
                onChange={(on) => {
                  set({ pin: on ? 'follow' : 'hold' });
                }}
              />
              <DyCheck
                label={t.pinHold({ version: r.version })}
                hint={t.pinHoldHint}
                checked={r.pin === 'hold'}
                onChange={(on) => {
                  set({ pin: on ? 'hold' : 'follow' });
                }}
              />
            </div>
          </fieldset>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-0.5 text-[0.8125rem] font-bold">{t.authLegend}</legend>
            <div className="flex flex-wrap gap-x-5">
              <DyCheck
                label={t.authSecretRef}
                checked={r.authModes.includes('secret-ref')}
                onChange={(on) => {
                  toggleAuth('secret-ref', on);
                }}
              />
              <DyCheck
                label={t.authLocalLogin}
                checked={r.authModes.includes('local-login')}
                onChange={(on) => {
                  toggleAuth('local-login', on);
                }}
              />
            </div>
          </fieldset>
          <DyCheck
            label={t.allowUnverified}
            hint={t.allowUnverifiedHint}
            checked={r.allowUnverified === true}
            onChange={(on) => {
              set({ allowUnverified: on });
            }}
          />
          <DyCheck
            label={t.allowUnpinned}
            hint={t.allowUnpinnedHint({ version: r.version })}
            checked={r.allowUnpinned}
            onChange={(on) => {
              set({ allowUnpinned: on });
            }}
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-bold">{t.profiles}</span>
            {r.modelProfiles.length === 0 ? (
              <span className="text-[0.8125rem] text-dy-muted">{t.noProfiles}</span>
            ) : (
              <ul className="m-0 list-none overflow-hidden rounded-[10px] border border-dy-line p-0">
                {r.modelProfiles.map((p) => (
                  <li
                    key={p.name}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-dy-line px-3 py-1 first:border-t-0"
                  >
                    <label className="flex min-h-11 items-center gap-2 text-[0.875rem] md:min-h-9">
                      <input
                        type="radio"
                        className="size-4 accent-[var(--dy-teal)]"
                        name={`rt-${row.runtime}-default`}
                        checked={r.defaultProfile === p.name}
                        onChange={() => {
                          set({ defaultProfile: p.name });
                        }}
                        aria-label={t.defaultProfile({ name: p.name })}
                      />
                      <span className="font-dy-mono">{p.name}</span>
                      {r.defaultProfile === p.name ? <Pill tone="teal">{t.defaultPill}</Pill> : null}
                    </label>
                    <span className="font-dy-mono text-[0.78125rem] text-dy-muted [overflow-wrap:anywhere]">
                      {p.provider}/{p.model}
                    </span>
                    <DyButton
                      variant="ghost"
                      className="ml-auto"
                      aria-label={t.removeName({ name: p.name })}
                      onClick={() => {
                        removeProfile(p.name);
                      }}
                    >
                      {t.remove}
                    </DyButton>
                  </li>
                ))}
              </ul>
            )}
            {props.models === null ? (
              <span className="text-[0.8125rem] text-dy-muted">{t.catalogFailed}</span>
            ) : catalog.length > 0 ? (
              <label className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-dy-muted">
                {t.addFromCatalog}
                <select
                  className="min-h-10 rounded-[9px] border border-dy-line-2 bg-dy-card px-2.5 text-[0.875rem] text-dy-ink sm:min-h-9"
                  value=""
                  aria-label={t.addProfileFor({ runtime: label })}
                  onChange={(e) => {
                    const m = catalog.find((x) => x.id === e.target.value);
                    if (m !== undefined) addProfile(m);
                  }}
                >
                  <option value="">{t.choose}</option>
                  {catalog.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName} ({m.id})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function PolicyEditor(props: {
  readonly draft: Draft;
  readonly policy: RuntimePolicyDetail | null;
  readonly template: PolicyDocument;
  readonly models: readonly ModelView[] | null;
  readonly onSaved: (message: string) => void;
  readonly onReload: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const t = useT().integrations.runtimes;
  const [draft, setDraft] = useState(props.draft);
  const [note, setNote] = useState('');
  const [stage, setStage] = useState<'all' | 'canary'>('all');
  const [problems, setProblems] = useState<string[]>([]);
  const save = useSubmit();
  const stepUp = useStepUp();
  const conflict = save.error?.status === 409;

  const submit = async (): Promise<void> => {
    const found = draftProblems(t, draft);
    setProblems(found);
    if (found.length > 0) return;
    const outcome = { saved: false };
    const ok = await save.run(async () => {
      try {
        await stepUp.run(
          () =>
            putRuntimePolicy(draft.name, {
              document: documentOf(draft),
              stage,
              expectedVersion: draft.expectedVersion,
              ...(note.trim() === '' ? {} : { changeNote: note.trim() }),
            }),
          t.stepUpSave({ name: draft.name }),
        );
        outcome.saved = true;
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
    if (ok && outcome.saved)
      props.onSaved(stage === 'all' ? t.savedAll({ name: draft.name }) : t.savedCanary({ name: draft.name }));
  };

  return (
    <Panel
      testId="policy-editor"
      title={
        <span>
          {draft.expectedVersion === 0 ? t.newPolicy : t.editPolicy}{' '}
          <span className="font-dy-mono">{draft.name}</span>
        </span>
      }
      sub={
        <>
          {draft.expectedVersion === 0
            ? null
            : t.basedOn({
                version:
                  props.policy?.canary?.version ?? props.policy?.activeVersion ?? draft.expectedVersion,
              })}
          {t.editorSub}
        </>
      }
      flush
    >
      <ul className="m-0 list-none border-y border-dy-line p-0">
        {draft.rows.map((row) => (
          <RuleEditor
            key={row.runtime}
            row={row}
            pin={props.template.runtimes[row.runtime]?.version}
            models={props.models}
            onChange={(next) => {
              setDraft((d) => ({ ...d, rows: d.rows.map((x) => (x.runtime === next.runtime ? next : x)) }));
            }}
          />
        ))}
      </ul>
      <div className="flex flex-col gap-4 px-4 py-4">
        <DyField
          label={t.changeNote}
          value={note}
          maxLength={1000}
          placeholder={t.changeNotePlaceholder}
          onChange={setNote}
        />
        <fieldset className="m-0 flex flex-col border-0 p-0">
          <legend className="mb-0.5 text-[0.8125rem] font-bold">{t.rollout}</legend>
          {(
            [
              ['all', t.rolloutAll],
              ['canary', t.rolloutCanary],
            ] as const
          ).map(([v, l]) => (
            <label key={v} className="flex min-h-11 items-center gap-2.5 text-[0.875rem] md:min-h-8">
              <input
                type="radio"
                name="dy-policy-stage"
                className="size-4 accent-[var(--dy-teal)]"
                checked={stage === v}
                onChange={() => {
                  setStage(v);
                }}
              />
              {l}
            </label>
          ))}
        </fieldset>
        {problems.length > 0 ? (
          <DyNotice tone="red" live>
            <ul className="m-0 list-none p-0">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </DyNotice>
        ) : null}
        <DyApiError error={save.error} retryLeft={save.retryLeft} />
        {save.error !== null && save.error.issues.length > 0 ? (
          <ul className="m-0 list-none p-0 text-[0.78125rem] text-dy-red-ink" data-testid="policy-issues">
            {save.error.issues.map((i) => (
              <li key={`${i.path}:${i.code}`}>
                <span className="font-dy-mono">{i.path || t.documentPath}</span>: {i.code}
              </li>
            ))}
          </ul>
        ) : null}
        {conflict ? (
          <DyNotice
            tone="amber"
            title={t.conflictTitle}
            action={<DyButton onClick={props.onReload}>{t.reload}</DyButton>}
          >
            {t.conflictBody}
          </DyNotice>
        ) : null}
        <FormActions>
          <DyButton variant="primary" busy={save.busy} disabled={conflict} onClick={() => void submit()}>
            {t.savePolicy}
          </DyButton>
          <DyButton variant="ghost" onClick={props.onCancel}>
            {t.cancel}
          </DyButton>
        </FormActions>
      </div>
    </Panel>
  );
}

function History(props: {
  readonly policy: RuntimePolicyDetail;
  readonly onChanged: (message: string) => void;
}): ReactNode {
  const t = useT().integrations.runtimes;
  const fmt = useFormat();
  const [items, setItems] = useState<PolicyVersion[] | null>(null);
  const load = useSubmit();
  const act = useSubmit();
  const stepUp = useStepUp();
  const p = props.policy;
  const guarded = async (fn: () => Promise<unknown>, reason: string, message: string): Promise<void> => {
    const outcome = { done: false };
    await act.run(async () => {
      try {
        await stepUp.run(fn, reason);
        outcome.done = true;
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
    if (outcome.done) props.onChanged(message);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {p.canaryVersion !== null ? (
          <DyButton
            variant="warn"
            icon="rocket"
            busy={act.busy}
            onClick={() =>
              void guarded(
                () => promoteRuntimePolicy(p.name, p.canaryVersion ?? 0),
                t.stepUpPromote({ name: p.name, version: p.canaryVersion ?? 0 }),
                t.promoted({ name: p.name, version: p.canaryVersion ?? 0 }),
              )
            }
          >
            {t.promote({ version: p.canaryVersion })}
          </DyButton>
        ) : null}
        {items === null ? (
          <DyButton
            variant="ghost"
            icon="clock"
            busy={load.busy}
            onClick={() =>
              void load.run(async () => {
                setItems(await listRuntimePolicyVersions(p.name));
              })
            }
          >
            {t.history}
          </DyButton>
        ) : null}
      </div>
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
      {items !== null ? (
        <ol
          className="m-0 list-none overflow-hidden rounded-[10px] border border-dy-line p-0 text-[0.875rem]"
          data-testid="policy-history"
        >
          {items.map((v) => (
            <li
              key={v.version}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-dy-line px-3 py-2 first:border-t-0"
            >
              <span className="font-dy-mono">v{v.version}</span>
              {/* i18n-ignore: version, product or permission name */}
              {v.version === p.activeVersion ? (
                <Pill tone="green" icon="checkc">
                  {t.activePill}
                </Pill>
              ) : null}
              {v.version === p.canaryVersion ? (
                <Pill tone="violet" icon="flag">
                  {t.canaryWord}
                </Pill>
              ) : null}
              <span className="text-[0.78125rem] text-dy-muted">
                {fmt.dateWith(v.createdAt, DATE_TIME_NUMERIC)}
              </span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{v.changeNote ?? ''}</span>
              {v.version !== p.activeVersion && v.version !== p.canaryVersion ? (
                <ConfirmButton
                  label={t.rollback({ version: v.version })}
                  variant="ghost"
                  icon="retry"
                  className="ml-auto"
                  question={t.rollbackQuestion({ name: p.name, version: v.version })}
                  confirmLabel={t.rollbackConfirm}
                  disabled={act.busy}
                  testId={`policy-rollback-${String(v.version)}`}
                  onConfirm={() =>
                    void guarded(
                      () => rollbackRuntimePolicyTo(p.name, v.version),
                      t.stepUpRollback({ name: p.name, version: v.version }),
                      t.rolledBack({ name: p.name, version: v.version }),
                    )
                  }
                />
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function PolicyPanel(props: {
  readonly p: RuntimePolicyDetail;
  readonly busy: boolean;
  readonly canEdit: boolean;
  readonly onEdit: () => void;
  readonly onChanged: (message: string) => void;
}): ReactNode {
  const t = useT().integrations.runtimes;
  const { p } = props;
  const doc = p.canary?.document ?? p.active?.document ?? null;
  const allowed = doc === null ? [] : Object.keys(doc.runtimes).filter((r) => !isRetiredRuntime(r));
  const unverified = allowed.filter((r) => doc?.runtimes[r]?.allowUnverified === true);
  return (
    <Panel
      testId={`policy-${p.name}`}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-dy-mono">{p.name}</span>
          {p.activeVersion === null ? (
            <Pill tone="amber" icon="flag">
              {t.noActive}
            </Pill>
          ) : (
            <Pill tone="green" icon="checkc">
              {t.active({ version: p.activeVersion })}
            </Pill>
          )}
          {p.canaryVersion === null ? null : (
            <Pill tone="violet" icon="flag">
              {t.canaryPill({ version: p.canaryVersion })}
            </Pill>
          )}
        </span>
      }
      sub={
        <span data-testid="policy-status">
          {p.name === 'default' ? t.unassigned : ''}
          {statusLine(t, p)}
        </span>
      }
      aside={
        <DyButton icon="pen" busy={props.busy} disabled={!props.canEdit} onClick={props.onEdit}>
          {t.editName({ name: p.name })}
        </DyButton>
      }
    >
      <div className="flex flex-col gap-3">
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.875rem]">
          <dt className="text-dy-muted">{t.allowed}</dt>
          <dd className="m-0 flex flex-wrap gap-x-3">
            {allowed.length === 0 ? t.none : allowed.map((r) => <RuntimeMark key={r} runtime={r} />)}
          </dd>
          {unverified.length > 0 ? (
            <>
              <dt className="text-dy-muted">{t.unverifiedAllowed}</dt>
              <dd className="m-0 text-dy-amber-ink">{unverified.map(name).join(', ')}</dd>
            </>
          ) : null}
        </dl>
        <History policy={p} onChanged={props.onChanged} />
      </div>
    </Panel>
  );
}

export function RuntimesView(): ReactNode {
  const t = useT().integrations.runtimes;
  const { state } = useAuth();
  const isAdmin = state.kind === 'signedIn' && (state.user.role === 'owner' || state.user.role === 'admin');
  const [policies, setPolicies] = useState<RuntimePolicyDetail[] | null>(null);
  const [template, setTemplate] = useState<PolicyDocument | null>(null);
  const [models, setModels] = useState<ModelView[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newName, setNewName] = useState('');
  const [naming, setNaming] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const load = useSubmit();
  const open = useSubmit();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [list, tpl] = await Promise.all([listRuntimePolicyDetails(), getRuntimePolicyTemplate()]);
      setPolicies(
        [...list].sort((a, b) =>
          a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name),
        ),
      );
      setTemplate(tpl);
    });
    listModels().then(
      (r) => {
        setModels(r.items);
      },
      () => {
        setModels(null);
      },
    );
  }, [load]);

  useEffect(() => {
    if (isAdmin) void refresh();
  }, [isAdmin]);

  if (!isAdmin)
    return (
      <DyNotice tone="neutral" icon="shield" testId="runtimes-admin-only">
        {t.adminOnly}
      </DyNotice>
    );

  const loadDraft = async (p: RuntimePolicyDetail): Promise<void> => {
    const tpl = template ?? (await getRuntimePolicyTemplate());
    const versions = await listRuntimePolicyVersions(p.name);
    const base = p.canary ?? p.active ?? versions[0] ?? null;
    setDone(null);
    setDraft(draftOf(p.name, base?.document ?? tpl, tpl, versions[0]?.version ?? 0));
  };
  const createFromTemplate = (n: string): Promise<boolean> =>
    open.run(async () => {
      const tpl = await getRuntimePolicyTemplate();
      setTemplate(tpl);
      setDone(null);
      setDraft(draftOf(n, tpl, tpl, 0));
    });

  const hasDefault = policies?.some((p) => p.name === 'default') === true;
  const nameOk = /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(newName) && newName !== 'template';
  const nameTaken = policies?.some((p) => p.name === newName) === true;

  return (
    <div className="flex flex-col gap-5" data-testid="dy-runtimes">
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      <DyApiError error={open.error} retryLeft={open.retryLeft} />
      {policies === null ? (
        load.error === null ? (
          <Panel title={t.policies} flush>
            <SkeletonRows label={t.loading} rows={3} />
          </Panel>
        ) : null
      ) : (
        <>
          {!hasDefault && draft === null ? (
            <DyNotice
              tone="amber"
              testId="no-default-policy"
              title={t.noDefaultTitle}
              action={
                <DyButton
                  variant="primary"
                  busy={open.busy}
                  onClick={() => void createFromTemplate('default')}
                >
                  {t.createFromPins}
                </DyButton>
              }
            >
              {t.noDefaultBody}
            </DyNotice>
          ) : null}
          {draft !== null && template !== null ? (
            <PolicyEditor
              key={`${draft.name}:${String(draft.expectedVersion)}`}
              draft={draft}
              policy={policies.find((p) => p.name === draft.name) ?? null}
              template={template}
              models={models}
              onSaved={(m) => {
                setDraft(null);
                setDone(m);
                void refresh();
              }}
              onReload={() => {
                const n = draft.name;
                setDraft(null);
                void open.run(async () => {
                  const fresh = (await listRuntimePolicyDetails()).find((x) => x.name === n);
                  if (fresh !== undefined) await loadDraft(fresh);
                });
                void refresh();
              }}
              onCancel={() => {
                setDraft(null);
              }}
            />
          ) : null}
          {/* p17-runtime-verify: what still depends on "Doğrulanmamışa izin ver" and the way out. */}
          <PolicyDependencePanel />
          <section aria-label={t.sectionLabel} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="m-0 text-[1rem] font-bold">{t.policies}</h2>
              {draft === null ? (
                <DyButton
                  icon="plus"
                  onClick={() => {
                    setNewName('');
                    setNaming(true);
                  }}
                >
                  {t.newPolicy}
                </DyButton>
              ) : null}
            </div>
            {policies.length === 0 ? (
              <Panel title={t.noPolicyTitle} flush>
                <EmptyLine>{t.noPolicy}</EmptyLine>
              </Panel>
            ) : null}
            {policies.map((p) => (
              <PolicyPanel
                key={p.name}
                p={p}
                busy={open.busy}
                canEdit={template !== null}
                onEdit={() => void open.run(() => loadDraft(p))}
                onChanged={(m) => {
                  setDone(m);
                  void refresh();
                }}
              />
            ))}
          </section>
          <PlatformProofsPanel />
          <p className="m-0 flex items-start gap-2 text-[0.84375rem] text-dy-muted">
            <DyIcon name="flag" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {t.footer.before}{' '}
              <Link to="/machines" className="text-dy-teal-ink">
                {t.footer.machines}
              </Link>{' '}
              {t.footer.middle}{' '}
              <Link to="/settings/models" className="text-dy-teal-ink">
                {t.footer.models}
              </Link>
              {t.footer.after}
            </span>
          </p>
        </>
      )}
      <DyDialog
        open={naming}
        onClose={() => {
          setNaming(false);
        }}
        size="sm"
        title={t.newTitle}
        description={t.newDescription}
      >
        <form
          aria-label={t.newTitle}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!nameOk || nameTaken) return;
            setNaming(false);
            void createFromTemplate(newName);
          }}
        >
          <DyField
            label={t.nameLabel}
            value={newName}
            placeholder="gpu" // i18n-ignore: product name or example value
            mono
            error={nameTaken ? t.nameTaken : null}
            hint={t.nameHint}
            onChange={(v) => {
              setNewName(v.trim().toLowerCase());
            }}
          />
          <FormActions>
            <DyButton type="submit" variant="primary" disabled={!nameOk || nameTaken} busy={open.busy}>
              {t.startFromPins}
            </DyButton>
            <DyButton
              variant="ghost"
              onClick={() => {
                setNaming(false);
              }}
            >
              {t.cancel}
            </DyButton>
          </FormActions>
        </form>
      </DyDialog>
    </div>
  );
}
