import { type ReactNode, useState } from 'react';
import { getChatUsage, type UsageCounts } from '../../../api/chat';
import {
  BUDGET_BILLINGS,
  BUDGET_METRICS,
  BUDGET_POLICIES,
  BUDGET_SCOPES,
  BUDGET_WINDOWS,
  type BudgetBilling,
  type BudgetMetric,
  type BudgetPolicy,
  type BudgetScopeType,
  type BudgetStatus,
  type BudgetView,
  type BudgetWindow,
  createBudget,
  createBudgetOverride,
  deleteBudget,
  listBudgetOverrides,
  listBudgets,
  revokeBudgetOverride,
  updateBudget,
} from '../../../api/usage';
import { useClientPage } from '../../../lib/pager';
import {
  EMPTY,
  type FormState,
  formatMetric,
  formToInput,
  RUNTIMES,
  toForm,
} from '../../../screens/usage/budgets';
import type { Tone } from '../../tone';
import { DyApiError, DyCheck, DyChoice, DyConfirm, DyInput, DyPager } from '../kit';
import { DyButton, EmptyLine, ErrorLine, Meter, Panel, Pill, SkeletonRows } from '../parts';
import { shortWhen, TD, TH, useGuarded, useLoad, useProblemText } from './common';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { type Formatter, INTL_TAG, type Messages } from '@remyral/i18n';
import { useUsageFormat } from './format';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p12-diyalog-w2: Kullanım → Bütçeler in the Diyalog language, plus the ops-chat usage. Same budget calls, the same
 * form rules (`formToInput`: names, limits, scope values, thresholds, subscription × dollars), optimistic versions,
 * step-up on create / edit / delete / override, admins and owners only edit; the exhausted-budget override
 * (reason required, optional job) as in the classic panel. A dollar budget with unknown costs reads "bilinmiyor",
 * never safe.
 */

type BudgetText = Messages['usage']['budgets'];

const STATUS_TONE: Readonly<Record<BudgetStatus, Tone>> = {
  under: 'green',
  warning: 'amber',
  over: 'red',
  unknown: 'amber',
};

/** A scope type's name ("Proje" / "Project"); runtime reads the same in both languages. */
function scopeName(all: Messages['usage'], s: BudgetScopeType): string {
  return s === 'runtime' ? all.words.runtime : all.budgets.scopes[s];
}

/** The window end on the wall clock of the budget's zone, in the user's language. */
function zonedWhen(iso: string, timeZone: string, f: Formatter): string {
  try {
    return f.dateWith(new Date(iso), {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return iso;
  }
}

function BudgetForm(props: {
  readonly initial: BudgetView | null;
  readonly onDone: (message: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [f, setF] = useState<FormState>(props.initial === null ? EMPTY : toForm(props.initial));
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const g = useGuarded();
  const all = useT().usage;
  const t: BudgetText = all.budgets;
  const problemText = useProblemText();
  const err = (k: keyof FormState): string | null => {
    const e = errors[k];
    return e === undefined ? null : problemText(e);
  };
  const unit =
    f.metric === 'cost_usd'
      ? 'USD'
      : f.metric === 'wall_time_ms'
        ? t.units.hours
        : f.metric === 'turns'
          ? t.units.turns
          : t.units.tokens;
  const editing = props.initial;
  return (
    <Panel
      title={editing === null ? t.newBudget : t.editTitle({ name: editing.budget.name })}
      testId="budget-form"
    >
      <form
        aria-label={editing === null ? t.newBudget : t.editForm}
        noValidate
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const { input, errors: errs } = formToInput(f);
          setErrors(errs);
          if (input === null) return;
          void g
            .run(
              () =>
                editing === null
                  ? createBudget(input)
                  : updateBudget(editing.budget.id, { ...input, expectedVersion: editing.budget.version }),
              t.stepUpWrite,
            )
            .then((ok) => {
              if (ok) props.onDone(editing === null ? t.created : t.updated);
            });
        }}
      >
        <DyInput
          label={t.name}
          value={f.name}
          maxLength={200}
          error={err('name')}
          onChange={(e) => {
            setF({ ...f, name: e.target.value });
          }}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <DyChoice
            label={t.metric}
            value={f.metric}
            options={BUDGET_METRICS.map((m) => [m, t.metrics[m]] as const)}
            onChange={(v) => {
              setF({ ...f, metric: v as BudgetMetric });
            }}
          />
          <DyInput
            label={t.limit({ unit })}
            inputMode="decimal"
            value={f.limit}
            error={err('limit')}
            onChange={(e) => {
              setF({ ...f, limit: e.target.value });
            }}
          />
          <DyChoice
            label={t.scope}
            value={f.scopeType}
            options={BUDGET_SCOPES.map((s) => [s, scopeName(all, s)] as const)}
            onChange={(v) => {
              setF({ ...f, scopeType: v as BudgetScopeType, scopeValue: '' });
            }}
          />
          {f.scopeType === 'global' ? null : f.scopeType === 'runtime' ? (
            <DyChoice
              label={all.words.runtime}
              value={f.scopeValue}
              error={err('scopeValue')}
              options={[['', t.choose], ...RUNTIMES.map((r) => [r, r] as const)]}
              onChange={(v) => {
                setF({ ...f, scopeValue: v });
              }}
            />
          ) : (
            <DyInput
              label={scopeName(all, f.scopeType)}
              value={f.scopeValue}
              maxLength={128}
              error={err('scopeValue')}
              onChange={(e) => {
                setF({ ...f, scopeValue: e.target.value });
              }}
            />
          )}
          <DyChoice
            label={t.window}
            value={f.window}
            options={BUDGET_WINDOWS.map((w) => [w, t.windows[w]] as const)}
            onChange={(v) => {
              setF({ ...f, window: v as BudgetWindow });
            }}
          />
          <DyCheck
            label={t.enabled}
            checked={f.enabled}
            onChange={(v) => {
              setF({ ...f, enabled: v });
            }}
            className="self-end pb-2"
          />
          <DyChoice
            label={t.counted}
            value={f.billing ?? 'all'}
            error={err('billing')}
            options={BUDGET_BILLINGS.map((b) => [b, t.billing[b]] as const)}
            onChange={(v) => {
              setF({ ...f, billing: v as BudgetBilling });
            }}
          />
          <DyChoice
            label={t.atFull}
            value={f.onExceeded ?? 'pause_new'}
            hint={t.policyHelp[f.onExceeded ?? 'pause_new']}
            options={BUDGET_POLICIES.map((p) => [p, t.policies[p]] as const)}
            onChange={(v) => {
              setF({ ...f, onExceeded: v as BudgetPolicy });
            }}
          />
          <DyInput
            label={t.zone}
            value={f.timeZone ?? 'UTC'}
            maxLength={64}
            error={err('timeZone')}
            onChange={(e) => {
              setF({ ...f, timeZone: e.target.value });
            }}
          />
          <DyInput
            label={t.thresholds}
            value={f.thresholds ?? '80, 100'}
            maxLength={40}
            error={err('thresholds')}
            onChange={(e) => {
              setF({ ...f, thresholds: e.target.value });
            }}
          />
        </div>
        {f.metric === 'cost_usd' ? <p className="m-0 text-[0.78125rem] text-dy-muted">{t.costNote}</p> : null}
        <DyApiError error={g.error} />
        <div className="flex flex-wrap gap-2">
          <DyButton type="submit" variant="primary" busy={g.busy}>
            {editing === null ? t.create : t.save}
          </DyButton>
          <DyButton variant="ghost" disabled={g.busy} onClick={props.onCancel}>
            {all.cancel}
          </DyButton>
        </div>
      </form>
    </Panel>
  );
}

function Overrides(props: { readonly budgetId: string; readonly windowEnd: string }): ReactNode {
  const fmt = useFormat();
  const all = useT().usage;
  const t = all.budgets.overrides;
  const list = useLoad(() => listBudgetOverrides(props.budgetId));
  const g = useGuarded();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [jobId, setJobId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const active = (list.data ?? []).filter((o) => o.active);
  return (
    <div className="mt-3 grid gap-2 border-t border-dy-line pt-3" data-testid="budget-overrides">
      {active.map((o) => (
        <div key={o.id} className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
          <Pill tone="violet" icon="key">
            {t.overridden}
          </Pill>
          <span className="min-w-0 flex-1">
            {t.line({
              who: o.jobId === null ? t.everyJob : t.forJob({ id: o.jobId.slice(0, 8) }),
              when: shortWhen(o.expiresAt, fmt),
              reason: o.reason,
            })}
          </span>
          <DyConfirm
            label={t.end}
            variant="warn"
            question={t.endQuestion}
            confirmLabel={t.endConfirm}
            disabled={g.busy}
            testId="override-end"
            onConfirm={() => {
              void g
                .run(() => revokeBudgetOverride(props.budgetId, o.id), t.endStepUp)
                .then((ok) => {
                  if (ok) list.reload();
                });
            }}
          />
        </div>
      ))}
      {open ? (
        <form
          aria-label={t.form}
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim() === '') {
              setFormError(t.needReason);
              return;
            }
            setFormError(null);
            void g
              .run(
                () =>
                  createBudgetOverride(props.budgetId, {
                    reason: reason.trim(),
                    ...(jobId.trim() === '' ? {} : { jobId: jobId.trim() }),
                  }),
                t.stepUp,
              )
              .then((ok) => {
                if (!ok) return;
                setOpen(false);
                setReason('');
                setJobId('');
                list.reload();
              });
          }}
        >
          <DyInput
            label={t.reason}
            value={reason}
            maxLength={500}
            error={formError}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          <DyInput
            label={t.jobOnly}
            value={jobId}
            maxLength={64}
            onChange={(e) => {
              setJobId(e.target.value);
            }}
          />
          <p className="m-0 text-[0.78125rem] text-dy-muted">
            {t.heldRun({ when: shortWhen(props.windowEnd, fmt) })}
          </p>
          <div className="flex flex-wrap gap-2">
            <DyButton type="submit" variant="warn" busy={g.busy}>
              {t.override}
            </DyButton>
            <DyButton
              variant="ghost"
              disabled={g.busy}
              onClick={() => {
                setOpen(false);
              }}
            >
              {all.cancel}
            </DyButton>
          </div>
        </form>
      ) : (
        <div>
          <DyButton
            icon="key"
            onClick={() => {
              setOpen(true);
            }}
          >
            {t.overrideMore}
          </DyButton>
        </div>
      )}
      <DyApiError error={g.error ?? list.error} />
    </div>
  );
}

function BudgetRow(props: {
  readonly view: BudgetView;
  readonly canEdit: boolean;
  readonly onEdit: () => void;
  readonly onDeleted: (message: string) => void;
}): ReactNode {
  const { formatPercent } = useUsageFormat();
  const fmt = useFormat();
  const all = useT().usage;
  const t = all.budgets;
  const tag = INTL_TAG[fmt.locale];
  const lower = (x: string): string => x.toLocaleLowerCase(tag);
  const { budget: b, evaluation: e } = props.view;
  const g = useGuarded();
  const st = e === null ? null : { ...t.status[e.status], tone: STATUS_TONE[e.status] };
  const usage =
    e === null
      ? ''
      : t.usageLine({
          complete: e.complete,
          used: formatMetric(b.metric, e.used),
          limit: formatMetric(b.metric, e.limit),
          pct: formatPercent(e.ratio),
        });
  const scope =
    b.scope.type === 'global'
      ? t.everything
      : `${lower(scopeName(all, b.scope.type))} ${b.scope.value ?? ''}`;
  return (
    <li className="border-t border-dy-line px-4 py-3.5 first:border-t-0" data-testid="budget-row">
      <div className="flex flex-wrap items-center gap-2">
        {st === null || e === null ? null : (
          <span title={st.help} data-testid="budget-status" className="relative">
            <Pill tone={st.tone} icon={e.status === 'under' ? 'checkc' : e.status === 'over' ? 'xc' : 'flag'}>
              {st.label}
            </Pill>
            <span className="sr-only">. {st.help}</span>
          </span>
        )}
        <span className="min-w-0 font-bold [overflow-wrap:anywhere]">{b.name}</span>
        {b.enabled ? null : <Pill tone="neutral">{t.off}</Pill>}
      </div>
      <p className="m-0 mt-1 text-[0.8125rem] text-dy-muted">
        {t.metrics[b.metric]} · {scope} · {lower(t.windows[b.window])} ({b.timeZone}) ·{' '}
        {lower(t.billing[b.billing])} · {lower(t.policies[b.onExceeded])} ·{' '}
        {t.thresholdList({ values: b.thresholds })}
      </p>
      {e?.status === 'over' && b.onExceeded !== 'warn' ? (
        <p className="m-0 mt-1 text-[0.8125rem] font-bold text-dy-red-ink" data-testid="budget-exhausted">
          {t.exhausted({
            when: zonedWhen(e.window.end, b.timeZone, fmt),
            zone: b.timeZone,
            pausing: b.onExceeded === 'pause_new',
          })}
        </p>
      ) : null}
      {e === null ? null : (
        <div className="mt-2 max-w-[640px]">
          <Meter
            label={t.meter({ name: b.name })}
            value={Math.min(100, e.ratio * 100)}
            text={usage}
            tone={e.status === 'over' ? 'red' : e.status === 'under' ? 'green' : 'amber'}
            mark={80}
            showLabel={false}
          />
          <p
            className="m-0 mt-1 font-dy-mono text-[0.78125rem] text-dy-muted tabular-nums"
            data-testid="budget-usage"
          >
            {usage}
            {e.unknownRecords > 0 ? t.unknownRecords({ n: e.unknownRecords }) : ''}
            {b.metric === 'cost_usd' && e.subscriptionRecords > 0
              ? t.subscriptionSkipped({ n: e.subscriptionRecords })
              : ''}
          </p>
        </div>
      )}
      {props.canEdit ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <DyButton icon="pen" onClick={props.onEdit} disabled={g.busy}>
            {t.edit}
          </DyButton>
          <DyConfirm
            label={t.delete}
            icon="trash"
            question={t.deleteQuestion({ name: b.name })}
            confirmLabel={t.deleteConfirm}
            busy={g.busy}
            onConfirm={() => {
              void g
                .run(() => deleteBudget(b.id, b.version), t.deleteStepUp)
                .then((ok) => {
                  if (ok) props.onDeleted(t.deleted({ name: b.name }));
                });
            }}
          />
        </div>
      ) : null}
      {g.error === null ? null : (
        <div className="mt-2">
          <DyApiError error={g.error} />
        </div>
      )}
      {props.canEdit && e?.status === 'over' && b.onExceeded !== 'warn' ? (
        <Overrides budgetId={b.id} windowEnd={e.window.end} />
      ) : null}
    </li>
  );
}

function ChatUsagePanel(): ReactNode {
  const u = useLoad(getChatUsage);
  const fmt = useFormat();
  const all = useT().usage;
  const t = all.budgets.chat;
  const row = (label: string, c: UsageCounts, cap?: number | null): ReactNode => (
    <tr className="border-t border-dy-line first:border-t-0">
      <th scope="row" className="py-2 pr-4 text-left text-[0.875rem] font-normal text-dy-muted">
        {label}
      </th>
      <td className={TD}>{fmt.number(c.turns)}</td>
      <td className={TD}>
        {fmt.number(c.inputTokens + c.outputTokens)}
        {cap === undefined || cap === null ? null : (
          <span className="text-dy-muted"> / {fmt.number(cap)}</span>
        )}
      </td>
      <td className={TD}>${c.costUsd.toFixed(2)}</td>
    </tr>
  );
  return (
    <Panel title={t.title} sub={t.sub} testId="dy-chat-usage">
      <DyApiError error={u.error} />
      {u.data === null ? (
        u.error === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : null
      ) : (
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[26rem]" aria-label={t.table}>
            <thead>
              <tr className="border-b border-dy-line">
                <th scope="col" className={TH}>
                  <span className="sr-only">{t.period}</span>
                </th>
                <th scope="col" className={TH}>
                  {t.turns}
                </th>
                <th scope="col" className={TH}>
                  {all.words.token}
                </th>
                <th scope="col" className={TH}>
                  {t.reported}
                </th>
              </tr>
            </thead>
            <tbody>
              {row(t.meToday, u.data.me.today, u.data.limits.userDailyTokens)}
              {row(t.meMonth, u.data.me.month)}
              {u.data.all === null ? null : (
                <>
                  {row(t.allToday, u.data.all.today, u.data.limits.dailyTokens)}
                  {row(t.allMonth, u.data.all.month)}
                </>
              )}
            </tbody>
          </table>
          {u.data.limits.monthlyCostUsd === null ? null : (
            <p className="m-0 mt-2 text-[0.78125rem] text-dy-muted">
              {t.monthlyCap({ usd: `$${u.data.limits.monthlyCostUsd.toFixed(2)}` })}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

export function BudgetsView(props: { readonly canEdit: boolean }): ReactNode {
  const t = useT().usage.budgets;
  const list = useLoad(listBudgets);
  const page = useClientPage(list.data ?? [], { label: t.pages, prefix: 'budgets' });
  const [editing, setEditing] = useState<BudgetView | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice);
  const done = (m: string): void => {
    setEditing(null);
    setNotice(m);
    list.reload();
  };
  return (
    <section aria-label={t.section} className="flex flex-col gap-4" data-testid="dy-budgets">
      {editing === null ? null : (
        <BudgetForm
          key={editing === 'new' ? 'new' : editing.budget.id}
          initial={editing === 'new' ? null : editing}
          onDone={done}
          onCancel={() => {
            setEditing(null);
          }}
        />
      )}
      <ErrorLine error={list.error} what={t.what} onRetry={list.reload} />
      <Panel
        title={t.title}
        count={list.data === null ? undefined : String(list.data.length)}
        sub={t.sub}
        aside={
          props.canEdit && editing === null ? (
            <DyButton
              variant="primary"
              icon="plus"
              onClick={() => {
                setNotice(null);
                setEditing('new');
              }}
            >
              {t.newBudget}
            </DyButton>
          ) : undefined
        }
        flush
      >
        {list.data === null ? (
          list.error === null ? (
            <SkeletonRows label={t.loading} rows={5} />
          ) : null
        ) : list.data.length === 0 ? (
          <EmptyLine testId="budgets-empty">{t.empty}</EmptyLine>
        ) : (
          <>
            <ul className="m-0 grid list-none p-0" aria-label={t.title}>
              {page.pageItems.map((v) => (
                <BudgetRow
                  key={v.budget.id}
                  view={v}
                  canEdit={props.canEdit}
                  onEdit={() => {
                    setNotice(null);
                    setEditing(v);
                  }}
                  onDeleted={done}
                />
              ))}
            </ul>
            <DyPager {...page.pagination} />
          </>
        )}
      </Panel>
      <ChatUsagePanel />
    </section>
  );
}
