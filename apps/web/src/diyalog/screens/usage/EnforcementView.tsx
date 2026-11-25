import { type ReactNode, useId, useState } from 'react';
import { AccountDefaultsPanel } from '../projects/tabs/policy-accounts';
import { Link, useLocation } from 'react-router';
import { putNearSettings } from '../../../api/runtimeUsage';
import { getQuotaStatus, killProject, putQuotaPolicy, releaseHold, resumePause } from '../../../api/quotas';
import {
  clearUsageLimit,
  getUsageLimitDefaults,
  getUsageLimitStatus,
  putUsageLimitDefaults,
  type UsageLimitEpisode,
  type UsageLimitMode,
  type UsageLimitPolicy,
  usageLimitPolicyProblem,
} from '../../../api/usageLimits';
import { cx } from '../../../components/ui';
import { resetRuntimeUsageCache, useRuntimeUsage } from '../../../screens/usage/runtimeUsage';
import { DyTabs } from '../../formkit';
import { DyIcon } from '../../icons';
import { RuntimeMark, runtimeDisplayName } from '../../RuntimeMark';
import { DyApiError, DyCheck, DyChoice, DyConfirm, DyInput, DyNotice } from '../kit';
import {
  DyButton,
  DySelect,
  EmptyLine,
  ErrorLine,
  Meter,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
} from '../parts';
import { MODEL_RUNTIMES, type ModelRuntime } from '../../../api/models';
import { DyModelPicker, useRuntimeModels } from '../shared/ModelPicker';
import { shortWhen, TD, TH, useGuarded, useLoad, useProblemText } from './common';
import { LimitWindows } from './LimitWindows';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import type { Formatter, Messages } from '@remyral/i18n';
import { toast } from '../../toast/store';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p12-diyalog-w2: Kullanım → Limitler ve kotalar in the Diyalog language — what the quota layer does now and its
 * settings, each write through the classic call with step-up and only for admins / owners (`canEdit`): runtime
 * limit windows (Faz 4 `LimitWindows`) and the near-limit notice, the usage limits now and the workspace default
 * policy (`usageLimitPolicyProblem` checks first), provider pauses (resume now), kill-switch holds (release),
 * concurrency in use, budget enforcement, the recent decisions, the quota policy JSON (parsed before it can be
 * saved; the master validates it) and the project kill switch ("Tüm işleri durdur", a second confirmation, then
 * the code).
 */

type EnforcementText = Messages['usage']['enforcement'];

const MODES: readonly UsageLimitMode[] = ['auto', 'wait', 'fallback', 'fail'];

/** A text for a master-sent word, or the word itself when the catalog does not know it. */
function known(map: Readonly<Record<string, string>>, id: string): string {
  return Object.hasOwn(map, id) ? (map[id] ?? id) : id;
}

/** One line per known limit, in the user's language (the classic `limitLine`). */
export function limitLine(e: UsageLimitEpisode, t: EnforcementText, f: Formatter): string {
  const where =
    e.pauseScope === 'credential'
      ? t.credential({ id: e.credential ?? '' })
      : e.pauseScope === 'account'
        ? t.providerAccount({ id: e.accountId ?? '' })
        : t.machine({
            name: e.workerName ?? e.workerId ?? t.someMachine,
            subscription: e.scope === 'subscription',
          });
  return t.limitLine({
    runtime: runtimeDisplayName(e.runtime),
    kind: e.kind === null ? null : known(t.kinds, e.kind),
    model: e.model,
    where,
    when: shortWhen(e.resetAt ?? e.resumeAt, f),
    unreported: e.resetAt === null,
    hits: e.hits,
  });
}

/** What the policy does, in one sentence (the classic `describeUsageLimitPolicy`). */
export function describePolicy(p: UsageLimitPolicy, t: EnforcementText): string {
  const chain = p.fallbacks.map(
    (f) => `${runtimeDisplayName(f.runtime)}${f.model === undefined ? '' : ` (${f.model})`}`,
  );
  switch (p.mode) {
    case 'fail':
      return t.policy.fail;
    case 'wait':
      return t.policy.wait;
    case 'fallback':
      return chain.length === 0 ? t.policy.noFallback : t.policy.fallback({ chain: chain.join(' → ') });
    case 'auto':
      return t.policy.auto({ hours: p.maxWaitHours, chain: chain.length === 0 ? null : chain.join(' → ') });
  }
}

function NearSettings(props: {
  readonly canEdit: boolean;
  readonly threshold: number;
  readonly notify: boolean;
}): ReactNode {
  const [threshold, setThreshold] = useState(String(props.threshold));
  const [notify, setNotify] = useState(props.notify);
  const g = useGuarded();
  const t = useT().usage.enforcement.near;
  const n = Number(threshold);
  const bad = !Number.isInteger(n) || n < 50 || n > 99;
  if (!props.canEdit)
    return (
      <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="near-settings">
        {t.readOnly({ threshold: props.threshold, notify: props.notify })}
      </p>
    );
  return (
    <form
      aria-label={t.title}
      className="grid gap-3"
      data-testid="near-settings"
      onSubmit={(e) => {
        e.preventDefault();
        if (bad) return;
        void g
          .run(async () => {
            await putNearSettings({ nearThreshold: n, notifyNear: notify });
            resetRuntimeUsageCache();
          }, t.stepUp)
          // p17-toasts-rest: a save result → toast.
          .then((ok) => {
            if (ok) toast.success(t.saved, { id: 'near-settings-saved', testId: 'near-settings-saved' });
          });
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <DyInput
          label={t.threshold}
          name="near-threshold"
          inputMode="numeric"
          value={threshold}
          wrapClassName="w-36"
          error={bad ? '50–99' : null}
          onChange={(e) => {
            setThreshold(e.target.value);
          }}
        />
        <DyCheck
          label={t.notify}
          checked={notify}
          className="pb-2"
          onChange={(v) => {
            setNotify(v);
          }}
        />
        <DyButton type="submit" disabled={bad} busy={g.busy}>
          {t.save}
        </DyButton>
      </div>
      <DyApiError error={g.error} />
    </form>
  );
}

function NearPanel(props: { readonly canEdit: boolean }): ReactNode {
  const { data, error } = useRuntimeUsage({ history: true });
  const t = useT().usage.enforcement.near;
  if (data === null)
    // p12-diyalog-default (visual tour): the panel keeps its place while it loads (it used to appear from nothing and
    // push the panels below); nothing to show when the usage read failed — the limit windows above say why.
    return error === null ? (
      <Panel title={t.title}>
        <div className="-mx-4">
          <SkeletonRows label={t.loading} rows={2} />
        </div>
      </Panel>
    ) : null;
  return (
    <Panel title={t.title} testId="dy-near">
      <NearSettings
        key={`${String(data.nearThreshold)}-${String(data.notifyNear)}`}
        canEdit={props.canEdit}
        threshold={data.nearThreshold}
        notify={data.notifyNear}
      />
    </Panel>
  );
}

function UsageLimitsPanel(props: { readonly canEdit: boolean }): ReactNode {
  const status = useLoad(getUsageLimitStatus);
  const defaults = useLoad(getUsageLimitDefaults);
  const [draft, setDraft] = useState<UsageLimitPolicy | null>(null);
  const pl = useT().projects.limits;
  const catalog = useRuntimeModels();
  const [problem, setProblem] = useState<string | null>(null);
  const g = useGuarded();
  const fmt = useFormat();
  const all = useT().usage.enforcement;
  const t = all.limits;
  const problemText = useProblemText();
  const policy = defaults.data;
  const d = draft ?? policy;
  const [clearing, setClearing] = useState<string | null>(null);
  return (
    <Panel title={t.title} sub={t.sub} testId="dy-usage-limits">
      <DyApiError error={status.error ?? defaults.error} />
      {status.data === null ? null : status.data.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="usage-limits-none">
          {t.none}
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-1.5 p-0 text-[0.875rem]" data-testid="usage-limits">
          {status.data.map((e) => (
            <li key={e.id} className="flex flex-wrap items-start gap-2" data-testid="usage-limit-row">
              <DyIcon name="pause" className="mt-0.5 size-3.5 shrink-0 text-dy-violet" />
              <span className="min-w-0 flex-1">{limitLine(e, all, fmt)}</span>
              {props.canEdit ? (
                // p19-limit-clear: the provider reset it early (or the plan was raised) — clear it by hand.
                <DyButton
                  busy={clearing === e.id}
                  data-testid="usage-limit-clear"
                  title={t.clearHint}
                  onClick={() => {
                    setClearing(e.id);
                    clearUsageLimit(e.id)
                      .then(
                        () => {
                          toast.success(t.cleared);
                          status.reload();
                          resetRuntimeUsageCache();
                        },
                        (err: unknown) => {
                          toast.error(err instanceof Error ? err.message : String(err));
                        },
                      )
                      .finally(() => {
                        setClearing(null);
                      });
                  }}
                >
                  {t.clear}
                </DyButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {policy === null ? null : (
        <p className="m-0 mt-3 text-[0.875rem]" data-testid="usage-limit-default">
          <span className="font-bold">{t.defaultLabel}</span>
          {describePolicy(policy, all)}
        </p>
      )}
      {props.canEdit && d !== null ? (
        <form
          aria-label={t.form}
          className="mt-3 grid gap-3 border-t border-dy-line pt-3"
          data-testid="usage-limit-default-form"
          onSubmit={(e) => {
            e.preventDefault();
            const p = usageLimitPolicyProblem(d);
            setProblem(p === null ? null : problemText(p));
            if (p !== null) return;
            void g
              .run(async () => {
                const next = await putUsageLimitDefaults(d);
                defaults.set(next);
                setDraft(null);
              }, t.stepUp)
              // p17-toasts-rest: a save result → toast.
              .then((ok) => {
                if (ok)
                  toast.success(t.saved, {
                    id: 'usage-limit-default-saved',
                    testId: 'usage-limit-default-saved',
                  });
              });
          }}
        >
          <DyChoice
            label={t.whenHit}
            value={d.mode}
            options={MODES.map((m) => [m, all.modes[m]] as const)}
            className="max-w-[520px]"
            onChange={(v) => {
              setDraft({ ...d, mode: v as UsageLimitMode });
            }}
          />
          <DyInput
            label={t.maxWait}
            inputMode="decimal"
            wrapClassName="max-w-[260px]"
            value={String(d.maxWaitHours)}
            onChange={(e) => {
              setDraft({ ...d, maxWaitHours: Number(e.target.value) });
            }}
          />
          {/* p15-model-picker: one row per fallback (runtime + its model from the list) instead of "runtime:model" text. */}
          <fieldset
            className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
            data-testid="usage-limit-fallbacks"
          >
            <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{t.fallbacks}</legend>
            {d.fallbacks.map((f, i) => (
              <div
                key={`${f.runtime}-${String(i)}`}
                className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto]"
              >
                <DySelect
                  label={pl.fallbackRuntime({ n: i + 1 })}
                  value={f.runtime}
                  options={MODEL_RUNTIMES.map((r) => [r, runtimeDisplayName(r)] as const)}
                  onChange={(v) => {
                    setDraft({ ...d, fallbacks: d.fallbacks.map((x, j) => (j === i ? { runtime: v } : x)) });
                  }}
                />
                <DyModelPicker
                  label={pl.profile}
                  runtimes={
                    (MODEL_RUNTIMES as readonly string[]).includes(f.runtime)
                      ? [f.runtime as ModelRuntime]
                      : []
                  }
                  value={f.model ?? ''}
                  catalog={catalog}
                  testId="global-fallback-model-picker"
                  onChange={(v) => {
                    setDraft({
                      ...d,
                      fallbacks: d.fallbacks.map((x, j) =>
                        j === i ? (v === '' ? { runtime: x.runtime } : { runtime: x.runtime, model: v }) : x,
                      ),
                    });
                  }}
                />
                <DyButton
                  variant="ghost"
                  aria-label={pl.removeFallback({ n: i + 1 })}
                  onClick={() => {
                    setDraft({ ...d, fallbacks: d.fallbacks.filter((_, j) => j !== i) });
                  }}
                >
                  {pl.removeFallback({ n: i + 1 })}
                </DyButton>
              </div>
            ))}
            {d.fallbacks.length < 4 ? (
              <div>
                <DyButton
                  variant="ghost"
                  icon="plus"
                  onClick={() => {
                    setDraft({ ...d, fallbacks: [...d.fallbacks, { runtime: 'codex' }] });
                  }}
                >
                  {pl.addFallback}
                </DyButton>
              </div>
            ) : null}
          </fieldset>
          <DyCheck
            label={t.paid}
            checked={d.allowPaidFallback}
            onChange={(v) => {
              setDraft({ ...d, allowPaidFallback: v });
            }}
          />
          {problem === null ? null : <DyNotice tone="amber">{problem}</DyNotice>}
          <DyApiError error={g.error} />
          <div>
            <DyButton type="submit" variant="primary" busy={g.busy}>
              {t.save}
            </DyButton>
          </div>
        </form>
      ) : null}
    </Panel>
  );
}

const limitText = (t: EnforcementText, active: number, max: number | null): string =>
  max === null ? t.unlimited({ n: active }) : `${String(active)} / ${String(max)}`;

/** p17-settings-tabs: the sections of the tab, in order (`?section=`; the first is the clean URL). */
export const ENFORCEMENT_SECTIONS = ['limits', 'holds', 'load', 'events', 'policy'] as const;

/** Anchors to a card of the stacked tab open the section that holds it. */
const HASH_SECTIONS: Readonly<Record<string, (typeof ENFORCEMENT_SECTIONS)[number]>> = {
  '#limits': 'limits',
  '#near': 'limits',
  '#usage-limits': 'limits',
  '#pauses': 'holds',
  '#holds': 'holds',
  '#kill-switch': 'holds',
  '#concurrency': 'load',
  '#budgets': 'load',
  '#events': 'events',
  '#policy': 'policy',
};

/**
 * p17-settings-tabs (docs/design/p17-settings-tabs.md): the eleven cards of the tab in five sections (`?section=`,
 * the shared DyTabs): Kullanım sınırları (windows, near-limit notice, usage-limit and account defaults), Duraklatma ve
 * durdurma (provider pauses, kill-switch holds, the project kill switch; the count is what is held now), Eşzamanlılık
 * ve bütçe, Son kararlar and Kota politikası. Role gates are the same as before: writes for admins / owners only.
 */
export function EnforcementView(props: { readonly canEdit: boolean }): ReactNode {
  const fmt = useFormat();
  const usage = useT().usage;
  const tt = useT().forms.tabs.enforcement;
  const { hash } = useLocation();
  const t = usage.enforcement;
  const q = useLoad(getQuotaStatus);
  const g = useGuarded();
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice);
  const [draft, setDraft] = useState<string | null>(null);
  const [killTarget, setKillTarget] = useState('');
  const [killReason, setKillReason] = useState('');
  const [killHold, setKillHold] = useState(true);
  const policyId = useId();
  const listId = useId();
  const s = q.data;

  const act = (fn: () => Promise<unknown>, reason: string, message: string): void => {
    setNotice(null);
    void g.run(fn, reason).then((ok) => {
      if (!ok) return;
      setNotice(message);
      setDraft(null);
      q.reload();
    });
  };

  if (s === null)
    return q.error === null ? (
      <SkeletonRows label={t.loading} rows={4} />
    ) : (
      <ErrorLine error={q.error} what={t.what} onRetry={q.reload} />
    );

  const text = draft ?? JSON.stringify(s.policy.policy, null, 2);
  let parsed: unknown = null;
  let draftError: string | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    draftError = t.policyJson.invalid;
  }
  const concurrency = [
    ...s.projects.map((p) => ({
      key: `p-${p.project}`,
      label: t.project({ name: p.project }),
      scope: <span className="font-dy-mono">{t.project({ name: p.project })}</span>,
      active: p.active,
      max: p.maxConcurrent,
      detail: t.weight({ w: p.weight }),
    })),
    ...s.runtimes.map((r) => ({
      key: `r-${r.runtime}`,
      label: runtimeDisplayName(r.runtime),
      scope: <RuntimeMark runtime={r.runtime} />,
      active: r.active,
      max: r.maxConcurrent,
      detail: t.fleet,
    })),
    ...s.accounts.map((a) => ({
      key: `a-${a.id}`,
      label: t.account({ id: a.id }),
      scope: <span className="font-dy-mono">{t.account({ id: a.id })}</span>,
      active: a.active,
      max: a.maxConcurrent,
      detail: t.accountDetail({
        runtime: runtimeDisplayName(a.runtime),
        provider: a.provider,
        machines: a.workers.join(', '),
      }),
    })),
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="enforcement-panel">
      <DyApiError error={g.error} />
      <DyTabs
        label={tt.label}
        param="section"
        fallback={HASH_SECTIONS[hash]}
        testId="enforcement-tabs"
        items={[
          { id: 'limits', label: tt.limits },
          { id: 'holds', label: tt.holds, count: s.pauses.length + s.holds.length },
          { id: 'load', label: tt.load },
          { id: 'events', label: tt.events },
          { id: 'policy', label: tt.policy },
        ]}
      >
        {(section) =>
          section === 'holds' ? (
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <Panel title={t.pauses.title} count={String(s.pauses.length)} flush>
                  {s.pauses.length === 0 ? (
                    <EmptyLine>{t.pauses.none}</EmptyLine>
                  ) : (
                    <Rows label={t.pauses.title} testId="quota-pauses">
                      {s.pauses.map((p) => (
                        <Row
                          key={p.id}
                          lead={<DyIcon name="pause" className="size-4" />}
                          tone="violet"
                          title={<RuntimeMark runtime={p.runtime} />}
                          meta={
                            <span>
                              {t.pauses.line({
                                who:
                                  p.scope === 'account'
                                    ? t.account({ id: p.accountId ?? '' })
                                    : t.pauses.onMachine({ id: p.workerId ?? '' }),
                                when: shortWhen(p.resumeAt, fmt),
                              })}
                            </span>
                          }
                          actions={
                            props.canEdit ? (
                              <DyButton
                                icon="retry"
                                busy={g.busy}
                                onClick={() => {
                                  act(
                                    () => resumePause(p.id),
                                    t.pauses.stepUp({ runtime: runtimeDisplayName(p.runtime) }),
                                    t.pauses.resumed({ runtime: runtimeDisplayName(p.runtime) }),
                                  );
                                }}
                              >
                                {t.pauses.resume}
                              </DyButton>
                            ) : undefined
                          }
                        />
                      ))}
                    </Rows>
                  )}
                </Panel>

                <Panel title={t.holds.title} count={String(s.holds.length)} flush>
                  {s.holds.length === 0 ? (
                    <EmptyLine>{t.holds.none}</EmptyLine>
                  ) : (
                    <Rows label={t.holds.title} testId="quota-holds">
                      {s.holds.map((h) => (
                        <Row
                          key={h.project}
                          lead={<DyIcon name="shield" className="size-4" />}
                          tone="red"
                          title={<span className="font-dy-mono">{h.project}</span>}
                          meta={
                            <span>
                              {t.holds.line({
                                by: h.heldBy,
                                when: shortWhen(h.heldAt, fmt),
                                reason: h.reason,
                              })}
                            </span>
                          }
                          actions={
                            props.canEdit ? (
                              <DyButton
                                busy={g.busy}
                                onClick={() => {
                                  act(
                                    () => releaseHold(h.project),
                                    t.holds.stepUp({ project: h.project }),
                                    t.holds.released({ project: h.project }),
                                  );
                                }}
                              >
                                {t.holds.release}
                              </DyButton>
                            ) : undefined
                          }
                        />
                      ))}
                    </Rows>
                  )}
                </Panel>
              </div>

              {props.canEdit ? (
                <Panel
                  title={
                    <span className="inline-flex items-center gap-1.5 text-dy-red-ink">
                      <DyIcon name="xc" className="size-4" />
                      {t.kill.title}
                    </span>
                  }
                  sub={t.kill.sub}
                  testId="dy-kill-switch"
                >
                  <form
                    aria-label={t.kill.title}
                    className="grid gap-3 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] sm:items-end"
                    onSubmit={(e) => {
                      e.preventDefault();
                    }}
                  >
                    <DyInput
                      label={t.kill.project}
                      value={killTarget}
                      list={listId}
                      onChange={(e) => {
                        setKillTarget(e.target.value);
                      }}
                    />
                    <datalist id={listId}>
                      {s.projects.map((p) => (
                        <option key={p.project} value={p.project} />
                      ))}
                    </datalist>
                    <DyInput
                      label={t.kill.reason}
                      value={killReason}
                      maxLength={500}
                      onChange={(e) => {
                        setKillReason(e.target.value);
                      }}
                    />
                    <DyCheck label={t.kill.hold} checked={killHold} onChange={setKillHold} className="pb-2" />
                    <div className="sm:col-span-3">
                      <DyConfirm
                        label={t.kill.button}
                        icon="xc"
                        testId="kill-switch"
                        question={t.kill.question({ project: killTarget.trim() })}
                        confirmLabel={t.kill.confirm}
                        busy={g.busy}
                        disabled={killTarget.trim() === '' || killReason.trim() === ''}
                        onConfirm={() => {
                          const project = killTarget.trim();
                          act(
                            () => killProject(project, killReason.trim(), killHold),
                            t.kill.stepUp({ project }),
                            t.kill.done({ project }),
                          );
                        }}
                      />
                    </div>
                  </form>
                </Panel>
              ) : (
                <p className="m-0 text-[0.8125rem] text-dy-muted">
                  <Pill tone="neutral" icon="key">
                    {t.kill.readOnly}
                  </Pill>{' '}
                  {t.kill.readOnlyNote}
                </p>
              )}
            </div>
          ) : section === 'load' ? (
            <div className="flex flex-col gap-4">
              <Panel title={t.concurrency.title} count={String(concurrency.length)} flush>
                {concurrency.length === 0 ? (
                  <EmptyLine>{t.concurrency.none}</EmptyLine>
                ) : (
                  <Rows label={t.concurrency.rows} testId="quota-concurrency">
                    {concurrency.map((c) => (
                      <Row
                        key={c.key}
                        title={c.scope}
                        meta={<span>{c.detail}</span>}
                        trail={
                          c.max === null ? (
                            <span className="font-dy-mono text-[0.8125rem]">
                              {limitText(t, c.active, c.max)}
                            </span>
                          ) : (
                            <span className="flex w-[200px] items-center gap-2.5">
                              <span className="font-dy-mono text-[0.8125rem] whitespace-nowrap tabular-nums">
                                {limitText(t, c.active, c.max)}
                              </span>
                              <Meter
                                className="-mt-1 flex-1"
                                label={t.concurrency.meter({ label: c.label })}
                                value={c.max === 0 ? 100 : (c.active / c.max) * 100}
                                text={limitText(t, c.active, c.max)}
                                tone={c.active >= c.max ? 'amber' : 'teal'}
                                showLabel={false}
                              />
                            </span>
                          )
                        }
                      />
                    ))}
                  </Rows>
                )}
              </Panel>

              <Panel title={t.budgets.title} count={String(s.budgets.length)}>
                {s.budgets.length === 0 ? (
                  <p className="m-0 text-[0.875rem] text-dy-muted">
                    {t.budgets.none} (<Link to="/usage?tab=budgets">{t.budgets.link}</Link>).
                  </p>
                ) : (
                  <div className="-mx-4 overflow-x-auto px-4">
                    <table className="w-full min-w-[30rem]" data-testid="quota-budgets">
                      <caption className="sr-only">{t.budgets.title}</caption>
                      <thead>
                        <tr className="border-b border-dy-line">
                          <th scope="col" className={TH}>
                            {t.budgets.budget}
                          </th>
                          <th scope="col" className={TH}>
                            {t.budgets.status}
                          </th>
                          <th scope="col" className={TH}>
                            {t.budgets.enforcement}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.budgets.map((b) => (
                          <tr key={b.id} className="border-t border-dy-line first:border-t-0">
                            <td className="py-2 pr-4 text-[0.875rem]">{b.name}</td>
                            <td
                              className={cx(
                                TD,
                                b.status === 'over'
                                  ? 'text-dy-red-ink'
                                  : b.status === 'under'
                                    ? 'text-dy-green'
                                    : 'text-dy-amber-ink',
                              )}
                            >
                              {t.budgets.statusLine({
                                state: known(usage.budgetState, b.status),
                                complete: b.complete,
                                pct: fmt.percent(Math.round(b.ratio * 100) / 100),
                              })}
                            </td>
                            <td className="py-2 text-[0.8125rem]">{b.enforcement}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </div>
          ) : section === 'events' ? (
            <Panel title={t.events.title} count={String(Math.min(50, s.events.length))} flush>
              {s.events.length === 0 ? (
                <EmptyLine>{t.events.none}</EmptyLine>
              ) : (
                <Rows label={t.events.title} testId="quota-events">
                  {s.events.slice(0, 50).map((e) => (
                    <Row
                      key={e.id}
                      lead={<DyIcon name="flag" className="size-4" />}
                      title={<span className="text-[0.875rem] font-normal">{e.message}</span>}
                      meta={
                        <>
                          <span>{shortWhen(e.createdAt, fmt)}</span>
                          <span className="font-dy-mono">{e.code}</span>
                          {e.project === null ? null : <span className="font-dy-mono">{e.project}</span>}
                        </>
                      }
                      actions={
                        e.jobId === null ? undefined : (
                          <Link
                            to={`/jobs/${encodeURIComponent(e.jobId)}`}
                            className="text-[0.8125rem] font-medium text-dy-teal-ink no-underline hover:underline"
                          >
                            {t.events.openJob}
                          </Link>
                        )
                      }
                    />
                  ))}
                </Rows>
              )}
            </Panel>
          ) : section === 'policy' ? (
            <Panel
              title={t.policyJson.title}
              count={`v${String(s.policy.version)}`}
              countLabel={t.policyJson.version({ n: s.policy.version })}
              sub={t.policyJson.sub}
            >
              <label htmlFor={policyId} className="sr-only">
                {t.policyJson.label}
              </label>
              <textarea
                id={policyId}
                className="h-64 w-full rounded-[9px] border border-dy-line-2 bg-dy-sunk p-2.5 font-dy-mono text-[0.78125rem] text-dy-ink"
                value={text}
                readOnly={!props.canEdit}
                spellCheck={false}
                aria-invalid={draftError !== null || undefined}
                onChange={(e) => {
                  setDraft(e.target.value);
                }}
              />
              {draftError === null ? null : (
                <p className="m-0 mt-1 text-[0.78125rem] font-medium text-dy-red-ink">{draftError}</p>
              )}
              {props.canEdit ? (
                <div className="mt-2">
                  <DyButton
                    variant="primary"
                    busy={g.busy}
                    disabled={draftError !== null}
                    onClick={() => {
                      act(
                        () => putQuotaPolicy(s.policy.version, parsed),
                        t.policyJson.stepUp,
                        t.policyJson.saved,
                      );
                    }}
                  >
                    {t.policyJson.save}
                  </DyButton>
                </div>
              ) : null}
            </Panel>
          ) : (
            <div className="flex flex-col gap-4">
              <LimitWindows />
              <NearPanel canEdit={props.canEdit} />
              <UsageLimitsPanel canEdit={props.canEdit} />
              <AccountDefaultsPanel canEdit={props.canEdit} />
            </div>
          )
        }
      </DyTabs>
    </div>
  );
}
