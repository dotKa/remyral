import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  type AccountPolicy,
  type AccountStrategy,
  getAccountDefaults,
  getProjectAccountPolicy,
  type PolicyAccount,
  policyProblem,
  type ProjectAccountPolicy,
  putAccountDefaults,
  putProjectAccountPolicy,
} from '../../../../api/runtimeAccounts';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { sameValue, useCardForm, useSectionSave } from '../../../formkit';
import { runtimeDisplayName } from '../../../RuntimeMark';
import { DyField, FormActions } from '../../forms';
import { DyButton, DySelect, Panel, Pill } from '../../parts';
import { LoadState, ProblemLine, SaveResult } from './policy-common';

/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md §3.3, §7): how the scheduler picks among several runtime
 * accounts — strategy, preferred order and the "nearly full" threshold — per project (with the workspace default) and
 * the workspace default itself (Usage → Enforcement). The paid switch stays the usage-limit policy's checkbox and is
 * authoritative for accounts too. Every save goes through step-up. p15-form-pattern: the form is a section of the
 * tab form around it (its edits are saved by the tab's bar; outside a tab form it keeps its own button).
 */

const STRATEGIES: readonly AccountStrategy[] = ['balanced', 'fill_first', 'least_used'];

/** What the account policy does, in one sentence of the user's language. */
export function describeAccountPolicy(p: AccountPolicy, t: Messages['projects']['accounts']): string {
  const skip = p.skipPercent >= 100 ? '' : t.skip({ pct: p.skipPercent });
  return `${t.describe[p.strategy]}${skip}`;
}

/** The editable form (strategy, order, threshold), shared by the project panel and the workspace default. */
export function AccountPolicyForm(props: {
  readonly value: AccountPolicy;
  readonly accounts: readonly PolicyAccount[];
  readonly busy: boolean;
  /** Saves the policy; true when it was saved (false: refused or the code dialog cancelled). */
  readonly onSave: (p: AccountPolicy) => Promise<boolean>;
  readonly onReset?: (() => void) | undefined;
  readonly resetLabel?: string;
  readonly testId: string;
}): ReactNode {
  const words = useT().projects;
  const t = words.accounts;
  const [draft, setDraft] = useState<AccountPolicy>(props.value);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);
  const known = new Map(props.accounts.map((a) => [a.ref, a]));
  // The order shown: the policy's order first, then every visible account not listed yet.
  const listed = [
    ...draft.order,
    ...props.accounts.map((a) => a.ref).filter((r) => !draft.order.includes(r)),
  ];
  const card = useCardForm({
    dirty: !sameValue(draft, props.value),
    busy: props.busy,
    save: () => {
      const p = policyProblem(draft) === null ? null : t.thresholdProblem;
      setProblem(p);
      return p === null ? props.onSave(draft) : Promise.resolve(false);
    },
    discard: () => {
      setDraft(props.value);
      setProblem(null);
    },
  });
  const move = (i: number, d: -1 | 1): void => {
    const list = [...listed];
    const a = list[i];
    const b = list[i + d];
    if (a === undefined || b === undefined) return;
    list[i] = b;
    list[i + d] = a;
    setDraft({ ...draft, order: list });
  };
  const name = (ref: string): string => {
    const a = known.get(ref);
    return a === undefined
      ? ref
      : `${a.label} — ${runtimeDisplayName(a.runtime)}, ${a.workerName}${a.kind === 'api_key' ? t.apiKey : ''}`;
  };
  return (
    <form
      aria-label={t.formLabel}
      className="flex flex-col gap-3 rounded-[12px] border border-dy-line bg-dy-sunk/50 p-3.5"
      data-testid={props.testId}
      onSubmit={(e) => {
        e.preventDefault();
        card.submit();
      }}
    >
      <DySelect
        label={t.strategy}
        value={draft.strategy}
        options={STRATEGIES.map((s) => [s, t.strategies[s]] as const)}
        onChange={(v) => {
          setDraft({ ...draft, strategy: v as AccountStrategy });
        }}
      />
      <DyField
        label={t.threshold}
        inputMode="numeric"
        value={String(draft.skipPercent)}
        wrapClassName="sm:w-64"
        hint={t.thresholdHint}
        onChange={(v) => {
          setDraft({ ...draft, skipPercent: Number(v) });
        }}
      />
      {listed.length > 0 ? (
        <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{t.order}</legend>
          <ol className="m-0 flex list-none flex-col gap-1 p-0" data-testid="account-order">
            {listed.map((ref, i) => (
              <li key={ref} className="flex flex-wrap items-center gap-2 text-[0.875rem]" data-ref={ref}>
                <span className="min-w-0 flex-1">
                  {String(i + 1)}. {name(ref)}
                </span>
                <DyButton
                  variant="ghost"
                  disabled={i === 0}
                  aria-label={t.moveUp({ name: name(ref) })}
                  onClick={() => {
                    move(i, -1);
                  }}
                >
                  {words.policy.up}
                </DyButton>
                <DyButton
                  variant="ghost"
                  disabled={i === listed.length - 1}
                  aria-label={t.moveDown({ name: name(ref) })}
                  onClick={() => {
                    move(i, 1);
                  }}
                >
                  {words.policy.down}
                </DyButton>
              </li>
            ))}
          </ol>
        </fieldset>
      ) : null}
      <ProblemLine problem={problem} />
      <FormActions>
        {card.inScope ? null : (
          <DyButton type="submit" variant="primary" busy={props.busy}>
            {words.policy.save}
          </DyButton>
        )}
        {props.onReset === undefined ? null : (
          <DyButton variant="ghost" busy={props.busy} onClick={props.onReset}>
            {props.resetLabel ?? words.policy.useDefault}
          </DyButton>
        )}
      </FormActions>
    </form>
  );
}

export function AccountPolicyPanel(props: {
  readonly project: string;
  readonly canEdit: boolean;
}): ReactNode {
  const words = useT().projects;
  const t = words.accounts;
  const { project } = props;
  const sectionSave = useSectionSave();
  const loader = useSubmit();
  const saver = useSubmit();
  const [data, setData] = useState<ProjectAccountPolicy | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;
  const refresh = useCallback(() => {
    void run(async () => {
      setData(await getProjectAccountPolicy(project));
    });
  }, [run, project]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const save = (policy: AccountPolicy | null): Promise<boolean> => {
    setDone(null);
    return sectionSave(
      saver,
      async () => {
        setData(await putProjectAccountPolicy(project, policy));
        setDone(policy === null ? words.policy.followsDefault : t.saved);
      },
      t.stepUp({ project }),
    );
  };
  return (
    <Panel title={t.title} sub={t.sub} testId="account-policy-panel">
      <LoadState loaded={data !== null} error={loader.error} what={t.title} onRetry={refresh} />
      {data === null ? null : (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[0.875rem]" data-testid="account-policy-current">
            <Pill tone={data.source === 'default' ? 'neutral' : 'violet'} className="mr-2 align-[1px]">
              {data.source === 'default' ? words.policy.workspaceDefault : words.policy.thisProject}
            </Pill>
            {describeAccountPolicy(data.effective, t)}
          </p>
          <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="account-policy-paid">
            {data.allowPaid ? t.paidOn : t.paidOff}
          </p>
          {props.canEdit ? (
            <AccountPolicyForm
              value={data.own ?? data.effective}
              accounts={data.accounts}
              busy={saver.busy}
              testId="account-policy-form"
              onSave={save}
              {...(data.source === 'project'
                ? {
                    onReset: () => {
                      void save(null);
                    },
                    resetLabel: words.policy.useWorkspaceDefault,
                  }
                : {})}
            />
          ) : null}
          <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
        </div>
      )}
    </Panel>
  );
}

/** Usage → Enforcement: the workspace default of the account selection (admins, step-up). */
export function AccountDefaultsPanel(props: { readonly canEdit: boolean }): ReactNode {
  const t = useT().projects.accounts;
  const sectionSave = useSectionSave();
  const loader = useSubmit();
  const saver = useSubmit();
  const [policy, setPolicy] = useState<AccountPolicy | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;
  const refresh = useCallback(() => {
    void run(async () => {
      setPolicy((await getAccountDefaults()).policy);
    });
  }, [run]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return (
    <Panel title={t.defaultsTitle} sub={t.defaultsSub} testId="account-defaults-panel">
      <LoadState loaded={policy !== null} error={loader.error} what={t.defaultsWhat} onRetry={refresh} />
      {policy === null ? null : (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[0.875rem]">{describeAccountPolicy(policy, t)}</p>
          {props.canEdit ? (
            <AccountPolicyForm
              value={policy}
              accounts={[]}
              busy={saver.busy}
              testId="account-defaults-form"
              onSave={(p) => {
                setDone(null);
                return sectionSave(
                  saver,
                  async () => {
                    setPolicy(await putAccountDefaults(p));
                    setDone(t.defaultsSaved);
                  },
                  t.defaultsStepUp,
                );
              }}
            />
          ) : null}
          <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
        </div>
      )}
    </Panel>
  );
}
