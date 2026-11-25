import { fill } from '@remyral/i18n';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  type Ceiling,
  checkExpiryNow,
  type CostBrake,
  endCostBrakeLift,
  type ExpiryItem,
  type ExpiryList,
  type ExpiryState,
  getCostBrake,
  getExpiry,
  liftCostBrake,
  recordRotation,
  setProjectCeiling,
  setVaultExpiry,
} from '../../../api/opsSafety';
import {
  getSecurityPolicy,
  putSecurityPolicy,
  type SecurityPolicyPatch,
  type SecurityPolicyView,
} from '../../../api/security';
import { useLocation } from 'react-router';
import { useAuth } from '../../../auth/AuthProvider';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyTabs } from '../../formkit';
import { DyIcon, type IconName } from '../../icons';
import type { Tone } from '../../tone';
import { DyApiError, DyField, DySwitch, FormActions, FormGrid } from '../forms';
import {
  agoText,
  DyButton,
  DySelect,
  EmptyLine,
  Meter,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
} from '../parts';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p16-ops-safety (docs/design/p16-ops-safety.md §5): Ayarlar → Operasyon güvenliği.
 * - Anahtarlar ve süreler: every tracked key / token / certificate with its expiry or rotation date, "check now" (the
 *   outside checks), "rotated" stamps, a vault credential's expiry date.
 * - Maliyet freni: spend against the ceilings now, the mode and ceilings (security policy, step-up), owners' lifts
 *   and project ceilings.
 * - İstek sınırları and the rollout breaker thresholds (security policy, step-up).
 * p17-settings-tabs: each of these is a tab (project ceilings got one of their own, owners only).
 * Owners and admins only (the master refuses everyone else); lifting the brake and project ceilings: owners.
 */

const STATE_LOOK: Readonly<Record<ExpiryState, { tone: Tone; icon: IconName }>> = {
  ok: { tone: 'green', icon: 'checkc' },
  soon: { tone: 'amber', icon: 'clock' },
  urgent: { tone: 'red', icon: 'shield' },
  expired: { tone: 'red', icon: 'xc' },
  unknown: { tone: 'neutral', icon: 'clock' },
  error: { tone: 'red', icon: 'xc' },
};

const LEVEL_TONE: Readonly<Record<Ceiling['level'], Tone>> = {
  ok: 'teal',
  warning: 'amber',
  exceeded: 'red',
};

function dueText(
  t: ReturnType<typeof useT>['opsSafety'],
  i: ExpiryItem,
  date: (s: string) => string,
): string {
  if (i.dueAt === null) return i.ageDays === null ? t.expiry.noDate : fill(t.expiry.age, { days: i.ageDays });
  const days = i.daysLeft ?? 0;
  if (i.basis === 'expires')
    return days < 0
      ? fill(t.expiry.expiredOn, { date: date(i.dueAt) })
      : fill(t.expiry.expires, { date: date(i.dueAt), days });
  return days < 0
    ? fill(t.expiry.overdue, { date: date(i.dueAt) })
    : fill(t.expiry.due, { date: date(i.dueAt), days });
}

function ExpiryRow(props: {
  readonly item: ExpiryItem;
  readonly busy: boolean;
  readonly onStamp: (i: ExpiryItem) => void;
}): ReactNode {
  const t = useT().opsSafety;
  const f = useFormat();
  const i = props.item;
  const look = STATE_LOOK[i.state];
  const name = i.name === null ? t.expiry.labels[i.label] : `${t.expiry.labels[i.label]} · ${i.name}`;
  return (
    <Row
      testId="ops-expiry-item"
      lead={<DyIcon name={look.icon} className="size-4" />}
      tone={look.tone}
      title={name}
      meta={
        <>
          <span>{dueText(t, i, (s) => f.date(s))}</span>
          {i.rotateEveryDays === null ? null : (
            <span>{fill(t.expiry.every, { days: i.rotateEveryDays })}</span>
          )}
          {i.rotatedAt === null ? null : (
            <span>{fill(t.expiry.rotatedAt, { date: f.date(i.rotatedAt) })}</span>
          )}
          {i.detail === null ? null : <span className="w-full">{i.detail}</span>}
          <span className="w-full font-dy-mono text-[0.75rem]">
            {fill(t.expiry.runbook, { path: i.runbook })}
          </span>
        </>
      }
      trail={
        <Pill tone={look.tone} icon={look.icon}>
          {t.expiry.states[i.state]}
        </Pill>
      }
      actions={
        i.stampable ? (
          <DyButton
            variant="ghost"
            icon="checkc"
            busy={props.busy}
            aria-label={fill(t.expiry.stampWhy, { name })}
            onClick={() => {
              props.onStamp(i);
            }}
          >
            {t.expiry.stamp}
          </DyButton>
        ) : undefined
      }
    />
  );
}

function ExpiryPanel(): ReactNode {
  const all = useT();
  const t = all.opsSafety;
  const [data, setData] = useState<ExpiryList | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'ops-expiry-done' });
  const [vaultId, setVaultId] = useState('');
  const [vaultDate, setVaultDate] = useState('');
  const submit = useSubmit();

  const load = useCallback(async () => {
    try {
      setData(await getExpiry());
      setLoadError(null);
    } catch (err) {
      setLoadError(toApiError(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const check = (): void => {
    setDone(null);
    void submit.run(async () => {
      setData(await checkExpiryNow());
      setDone(t.expiry.checked);
    });
  };
  const stamp = (i: ExpiryItem): void => {
    setDone(null);
    void submit.run(async () => {
      await recordRotation(i.id);
      setDone(fill(t.expiry.stamped, { name: i.name ?? t.expiry.labels[i.label] }));
      await load();
    });
  };
  const saveVault = (clear: boolean): void => {
    setDone(null);
    void submit.run(async () => {
      await setVaultExpiry(vaultId.trim(), clear ? null : new Date(`${vaultDate}T00:00:00Z`).toISOString());
      setDone(clear ? t.expiry.vault.cleared : t.expiry.vault.saved);
      await load();
    });
  };

  if (data === null)
    return loadError === null ? (
      <Panel title={t.expiry.title}>
        <SkeletonRows label={t.page.loading} rows={4} />
      </Panel>
    ) : (
      <DyApiError error={loadError} />
    );
  return (
    <Panel
      title={t.expiry.title}
      sub={t.expiry.sub}
      count={String(data.items.length)}
      countLabel={fill(t.expiry.count, { n: data.items.length })}
      aside={
        <DyButton variant="secondary" icon="retry" busy={submit.busy} onClick={check}>
          {t.expiry.checkNow}
        </DyButton>
      }
      flush
      testId="ops-expiry"
    >
      <p className="m-0 px-4 pb-2 text-[0.8125rem] text-dy-muted">
        {data.checkedAt === null
          ? t.expiry.never
          : fill(t.expiry.lastCheck, { ago: agoText(data.checkedAt, Date.now(), all.screenKit.time) })}
      </p>
      {data.items.length === 0 ? (
        <EmptyLine>{t.expiry.empty}</EmptyLine>
      ) : (
        <Rows label={t.expiry.title}>
          {data.items.map((i) => (
            <ExpiryRow key={i.id} item={i} busy={submit.busy} onStamp={stamp} />
          ))}
        </Rows>
      )}
      <form
        aria-label={t.expiry.vault.title}
        className="grid gap-3 border-t border-dy-line bg-dy-sunk px-4 py-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          saveVault(false);
        }}
      >
        <div>
          <h3 className="m-0 text-[0.875rem] font-bold">{t.expiry.vault.title}</h3>
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.expiry.vault.sub}</p>
        </div>
        <FormGrid>
          <DyField label={t.expiry.vault.credential} value={vaultId} onChange={setVaultId} mono />
          <DyField label={t.expiry.vault.date} type="date" value={vaultDate} onChange={setVaultDate} />
        </FormGrid>
        <FormActions>
          <DyButton
            type="submit"
            variant="primary"
            disabled={vaultId.trim() === '' || vaultDate === ''}
            busy={submit.busy}
          >
            {t.expiry.vault.save}
          </DyButton>
          <DyButton
            variant="ghost"
            disabled={vaultId.trim() === ''}
            busy={submit.busy}
            onClick={() => {
              saveVault(true);
            }}
          >
            {t.expiry.vault.clear}
          </DyButton>
        </FormActions>
      </form>
      <div className="flex flex-col gap-2 px-4 pb-4 empty:hidden">
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ policy forms

type Save = (patch: SecurityPolicyPatch) => Promise<void>;

/** A positive whole number from a field, or null when invalid. */
function whole(v: string): number | null {
  const n = Number(v);
  return v.trim() !== '' && Number.isInteger(n) && n > 0 ? n : null;
}
/** A ceiling: empty = none (null), else a number above 0; undefined when invalid. */
function usd(v: string): number | null | undefined {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function CeilingLine(props: { readonly c: Ceiling }): ReactNode {
  const t = useT().opsSafety.brake;
  const f = useFormat();
  const c = props.c;
  const where = c.scope === 'global' ? t.global : fill(t.project, { project: c.scope });
  const label = `${where} · ${c.window === 'day' ? t.day : t.month}`;
  return (
    <li className="grid gap-1" data-testid="ops-ceiling">
      <Meter
        label={label}
        value={Math.min(100, c.percent)}
        text={fill(t.spent, {
          spent: f.usd(c.spentUsd),
          limit: f.usd(c.limitUsd),
          pct: Math.round(c.percent),
        })}
        tone={LEVEL_TONE[c.level]}
      />
      <span className="text-[0.75rem] text-dy-muted">{c.lifted ? t.lifted : t.levels[c.level]}</span>
    </li>
  );
}

function BrakePanel(props: {
  readonly policy: SecurityPolicyView;
  readonly save: Save;
  readonly owner: boolean;
}): ReactNode {
  const t = useT().opsSafety;
  const f = useFormat();
  const stepUp = useStepUp();
  const cb = props.policy.effective.costBrake;
  const [brake, setBrake] = useState<CostBrake | null>(null);
  const [mode, setMode] = useState<string>(cb.mode);
  const [daily, setDaily] = useState(cb.dailyUsd === null ? '' : String(cb.dailyUsd));
  const [monthly, setMonthly] = useState(cb.monthlyUsd === null ? '' : String(cb.monthlyUsd));
  const [warn, setWarn] = useState(String(cb.warnPercent));
  const [scope, setScope] = useState('global');
  const [hours, setHours] = useState('2');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'ops-brake-done' });
  const submit = useSubmit();

  const load = useCallback(async () => {
    setBrake(await getCostBrake());
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const d = usd(daily);
  const m = usd(monthly);
  const w = whole(warn);
  const valid = d !== undefined && m !== undefined && w !== null && w >= 10 && w <= 99;
  const run = (fn: () => Promise<void>, ok: string, why: string): void => {
    setDone(null);
    void submit.run(async () => {
      try {
        await stepUp.run(fn, why);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
      setDone(ok);
      await load();
    });
  };
  const h = whole(hours);
  return (
    <Panel title={t.brake.title} sub={t.brake.sub} testId="ops-brake">
      <div className="grid gap-4">
        <section aria-label={t.brake.now} className="grid gap-2">
          {brake === null ? (
            <SkeletonRows label={t.page.loading} rows={1} />
          ) : brake.ceilings.length === 0 ? (
            <EmptyLine>{t.brake.noCeilings}</EmptyLine>
          ) : (
            <ul className="m-0 grid list-none gap-3 p-0">
              {brake.ceilings.map((c) => (
                <CeilingLine key={`${c.scope}-${c.window}`} c={c} />
              ))}
            </ul>
          )}
        </section>
        <form
          aria-label={t.brake.title}
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            run(
              () =>
                props.save({
                  costBrake: {
                    mode: mode === 'block' ? 'block' : 'warn',
                    dailyUsd: d,
                    monthlyUsd: m,
                    warnPercent: w,
                  },
                }),
              t.page.saved,
              t.page.stepUp,
            );
          }}
        >
          <FormGrid>
            <DySelect
              label={t.brake.modeLabel}
              value={mode}
              options={[
                ['warn', t.brake.modes.warn],
                ['block', t.brake.modes.block],
              ]}
              onChange={setMode}
            />
            <DyField label={t.brake.warnPercent} inputMode="numeric" value={warn} onChange={setWarn} />
            <DyField
              label={t.brake.daily}
              inputMode="decimal"
              value={daily}
              onChange={setDaily}
              error={d === undefined ? t.brake.invalid : undefined}
            />
            <DyField
              label={t.brake.monthly}
              inputMode="decimal"
              value={monthly}
              onChange={setMonthly}
              error={m === undefined ? t.brake.invalid : undefined}
            />
          </FormGrid>
          <FormActions>
            <DyButton type="submit" variant="primary" disabled={!valid} busy={submit.busy}>
              {t.page.save}
            </DyButton>
          </FormActions>
        </form>
        <section aria-label={t.brake.lift.title} className="grid gap-3 border-t border-dy-line pt-3">
          <div>
            <h3 className="m-0 text-[0.875rem] font-bold">{t.brake.lift.title}</h3>
            <p className="m-0 text-[0.8125rem] text-dy-muted">
              {props.owner ? t.brake.lift.sub : t.brake.lift.ownerOnly}
            </p>
          </div>
          {(brake?.lifts ?? []).map((l) => (
            <div
              key={l.id}
              className="flex flex-wrap items-center gap-2 text-[0.875rem]"
              data-testid="ops-lift"
            >
              <span className="min-w-0 flex-1">
                {fill(t.brake.lift.active, {
                  scope: l.scope === 'global' ? t.brake.lift.all : l.scope,
                  until: f.dateTime(l.expiresAt),
                  reason: l.reason,
                })}
              </span>
              {props.owner ? (
                <DyButton
                  variant="ghost"
                  busy={submit.busy}
                  onClick={() => {
                    run(() => endCostBrakeLift(l.id), t.brake.lift.ended, t.brake.lift.stepUp);
                  }}
                >
                  {t.brake.lift.end}
                </DyButton>
              ) : null}
            </div>
          ))}
          {props.owner ? (
            <form
              aria-label={t.brake.lift.title}
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (h === null) return;
                run(
                  () => liftCostBrake({ scope, hours: h, reason: reason.trim() }),
                  fill(t.brake.lift.done, { hours: h }),
                  t.brake.lift.stepUp,
                );
              }}
            >
              <FormGrid>
                <DySelect
                  label={t.brake.lift.scope}
                  value={scope}
                  options={[
                    ['global', t.brake.lift.all],
                    ...(brake?.projects ?? []).map((p) => [p.project, p.project] as const),
                  ]}
                  onChange={setScope}
                />
                <DyField label={t.brake.lift.hours} inputMode="numeric" value={hours} onChange={setHours} />
                <DyField label={t.brake.lift.reason} value={reason} onChange={setReason} maxLength={300} />
              </FormGrid>
              <FormActions>
                <DyButton
                  type="submit"
                  variant="secondary"
                  disabled={h === null || h > 72 || reason.trim() === ''}
                  busy={submit.busy}
                >
                  {t.brake.lift.submit}
                </DyButton>
              </FormActions>
            </form>
          ) : null}
        </section>
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </Panel>
  );
}

/** p17-settings-tabs: Proje tavanları (owners) — its own tab, split from the cost brake card. */
function ProjectCeilingsPanel(): ReactNode {
  const t = useT().opsSafety;
  const f = useFormat();
  const stepUp = useStepUp();
  const [brake, setBrake] = useState<CostBrake | null>(null);
  const [project, setProject] = useState('');
  const [pDaily, setPDaily] = useState('');
  const [pMonthly, setPMonthly] = useState('');
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'ops-projects-done' });
  const submit = useSubmit();

  const load = useCallback(async () => {
    setBrake(await getCostBrake());
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const run = (fn: () => Promise<void>, ok: string, why: string): void => {
    setDone(null);
    void submit.run(async () => {
      try {
        await stepUp.run(fn, why);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
      setDone(ok);
      await load();
    });
  };
  const pd = usd(pDaily);
  const pm = usd(pMonthly);
  return (
    <Panel title={t.brake.projects.title} sub={t.brake.projects.sub} testId="ops-projects">
      <div className="grid gap-4">
        {brake === null ? (
          <SkeletonRows label={t.page.loading} rows={1} />
        ) : brake.projects.length === 0 ? (
          <EmptyLine>{t.brake.projects.empty}</EmptyLine>
        ) : (
          <ul className="m-0 grid list-none gap-1 p-0 text-[0.875rem]">
            {brake.projects.map((p) => (
              <li key={p.project}>
                {fill(t.brake.projects.line, {
                  project: p.project,
                  daily: p.dailyUsd === null ? t.brake.projects.none : f.usd(p.dailyUsd),
                  monthly: p.monthlyUsd === null ? t.brake.projects.none : f.usd(p.monthlyUsd),
                })}
              </li>
            ))}
          </ul>
        )}
        <form
          aria-label={t.brake.projects.title}
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (pd === undefined || pm === undefined) return;
            const id = project.trim();
            run(
              () => setProjectCeiling(id, { dailyUsd: pd, monthlyUsd: pm }),
              fill(t.brake.projects.saved, { project: id }),
              t.brake.projects.stepUp,
            );
          }}
        >
          <FormGrid>
            <DyField label={t.brake.projects.project} value={project} onChange={setProject} mono />
            <DyField label={t.brake.daily} inputMode="decimal" value={pDaily} onChange={setPDaily} />
            <DyField label={t.brake.monthly} inputMode="decimal" value={pMonthly} onChange={setPMonthly} />
          </FormGrid>
          <FormActions>
            <DyButton
              type="submit"
              variant="secondary"
              disabled={project.trim() === '' || pd === undefined || pm === undefined}
              busy={submit.busy}
            >
              {t.brake.projects.save}
            </DyButton>
          </FormActions>
        </form>
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </Panel>
  );
}

function NumberForm(props: {
  readonly title: string;
  readonly sub: string;
  readonly testId: string;
  readonly fields: readonly { readonly key: string; readonly label: string; readonly value: number }[];
  readonly toggle?: { readonly label: string; readonly value: boolean } | undefined;
  readonly onSave: (values: Record<string, number>, toggle: boolean) => Promise<void>;
}): ReactNode {
  const t = useT().opsSafety;
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(props.fields.map((x) => [x.key, String(x.value)])),
  );
  const [on, setOn] = useState(props.toggle?.value ?? true);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const submit = useSubmit();
  const parsed = Object.fromEntries(props.fields.map((x) => [x.key, whole(values[x.key] ?? '')]));
  const valid = Object.values(parsed).every((v) => v !== null);
  return (
    <Panel title={props.title} sub={props.sub} testId={props.testId}>
      <form
        aria-label={props.title}
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          setDone(null);
          void submit.run(async () => {
            try {
              await props.onSave(parsed as Record<string, number>, on);
            } catch (err) {
              if (err instanceof StepUpCancelledError) return;
              throw err;
            }
            setDone(t.page.saved);
          });
        }}
      >
        {props.toggle === undefined ? null : (
          <DySwitch label={props.toggle.label} checked={on} onChange={setOn} />
        )}
        <FormGrid>
          {props.fields.map((x) => (
            <DyField
              key={x.key}
              label={x.label}
              inputMode="numeric"
              value={values[x.key] ?? ''}
              onChange={(v) => {
                setValues((s) => ({ ...s, [x.key]: v }));
              }}
              error={parsed[x.key] === null ? t.limits.invalid : undefined}
            />
          ))}
        </FormGrid>
        <FormActions>
          <DyButton type="submit" variant="primary" disabled={!valid} busy={submit.busy}>
            {t.page.save}
          </DyButton>
        </FormActions>
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </form>
    </Panel>
  );
}

/** p17-settings-tabs: the tabs of the page, in order (the first is the clean URL). */
export const OPS_SAFETY_TABS = ['keys', 'brake', 'projects', 'limits', 'breaker'] as const;
export type OpsSafetyTab = (typeof OPS_SAFETY_TABS)[number];

/**
 * Anchors of the stacked page (`#ops-brake`, the cards' ids) and short ones (`#brake`) still open their card: the tab
 * that holds it. Links name the tab with `?tab=` (notifications, the doctor, the home page's brake line).
 */
const HASH_TABS: Readonly<Record<string, OpsSafetyTab>> = {
  '#keys': 'keys',
  '#expiry': 'keys',
  '#ops-expiry': 'keys',
  '#brake': 'brake',
  '#cost-brake': 'brake',
  '#ops-brake': 'brake',
  '#projects': 'projects',
  '#ops-projects': 'projects',
  '#limits': 'limits',
  '#ops-limits': 'limits',
  '#breaker': 'breaker',
  '#ops-breaker-settings': 'breaker',
};

/**
 * p16-ops-safety + p17-settings-tabs (docs/design/p17-settings-tabs.md): the page in tabs — Anahtarlar ve süreler,
 * Maliyet freni (spend now, mode and ceilings, lifts), Proje tavanları (owners only), İstek sınırları and Sürüm devre
 * kesici. Only the open tab renders; the security policy (brake, limits, breaker) is loaded once for all of them.
 */
export function OpsSafetyView(): ReactNode {
  const t = useT().opsSafety;
  const tt = useT().forms.tabs.opsSafety;
  const { state } = useAuth();
  const { hash } = useLocation();
  const owner = state.kind === 'signedIn' && state.user.role === 'owner';
  const stepUp = useStepUp();
  const [view, setView] = useState<SecurityPolicyView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let live = true;
    getSecurityPolicy().then(
      (v) => {
        if (live) setView(v);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const save = useCallback<Save>(
    async (patch) => {
      if (view === null) return;
      const next = await putSecurityPolicy({ ...patch, expectedVersion: view.version });
      setView(next);
    },
    [view],
  );
  const guarded = useCallback<Save>(
    (patch) => stepUp.run(() => save(patch), t.page.stepUp),
    [save, stepUp, t],
  );

  // Proje tavanları is an owner's tab (the master refuses an admin's change; the card was owners-only too).
  const tabs = OPS_SAFETY_TABS.filter((id) => owner || id !== 'projects').map((id) => ({
    id,
    label: tt[id],
  }));
  const l = view?.effective.limits;
  const r = view?.effective.rollout;
  const policyBody = (body: (v: SecurityPolicyView) => ReactNode): ReactNode =>
    view === null ? (
      error === null ? (
        <SkeletonRows label={t.page.loading} rows={3} />
      ) : (
        <DyApiError error={error} />
      )
    ) : (
      body(view)
    );
  return (
    <div className="grid gap-4" data-testid="dy-ops-safety">
      <DyTabs label={tt.label} items={tabs} fallback={HASH_TABS[hash]} testId="ops-safety-tabs">
        {(tab) =>
          tab === 'brake' ? (
            policyBody((v) => <BrakePanel policy={v} save={save} owner={owner} />)
          ) : tab === 'projects' ? (
            <ProjectCeilingsPanel />
          ) : tab === 'limits' ? (
            policyBody(() =>
              l === undefined ? null : (
                <NumberForm
                  title={t.limits.title}
                  sub={t.limits.sub}
                  testId="ops-limits"
                  fields={[
                    { key: 'userReadPerMinute', label: t.limits.userRead, value: l.userReadPerMinute },
                    { key: 'userWritePerMinute', label: t.limits.userWrite, value: l.userWritePerMinute },
                    { key: 'tokenReadPerMinute', label: t.limits.tokenRead, value: l.tokenReadPerMinute },
                    { key: 'tokenWritePerMinute', label: t.limits.tokenWrite, value: l.tokenWritePerMinute },
                    { key: 'chatPerMinute', label: t.limits.chatMinute, value: l.chatPerMinute },
                    { key: 'chatPerHour', label: t.limits.chatHour, value: l.chatPerHour },
                  ]}
                  onSave={(v) => guarded({ limits: v })}
                />
              ),
            )
          ) : tab === 'breaker' ? (
            policyBody(() =>
              r === undefined ? null : (
                <NumberForm
                  title={t.breaker.settingsTitle}
                  sub={t.breaker.settingsSub}
                  testId="ops-breaker-settings"
                  toggle={{ label: t.breaker.on, value: r.breaker }}
                  fields={[
                    { key: 'failurePercent', label: t.breaker.failurePercent, value: r.failurePercent },
                    { key: 'minFailures', label: t.breaker.minFailures, value: r.minFailures },
                    { key: 'watchMinutes', label: t.breaker.watchMinutes, value: r.watchMinutes },
                    { key: 'jobFailureDelta', label: t.breaker.jobFailureDelta, value: r.jobFailureDelta },
                    { key: 'minJobs', label: t.breaker.minJobs, value: r.minJobs },
                  ]}
                  onSave={(v, on) => guarded({ rollout: { ...v, breaker: on } })}
                />
              ),
            )
          ) : (
            <ExpiryPanel />
          )
        }
      </DyTabs>
    </div>
  );
}
