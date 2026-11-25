import { useErrorText } from '../../../i18n/errors';
import { type ReactNode, useEffect, useState } from 'react';
import { cronPreview, type PlacementPreview } from '../../../api/composer';
import type { ApiError } from '../../../api/client';
import { PRIORITY_CLASS_VALUE, PRIORITY_CLASSES, priorityClassOf } from '../../../api/queue';
import type { BudgetView } from '../../../api/usage';
import { cx, toApiError } from '../../../components/ui';
import { APPROVAL_POLICIES, type Draft, type Errors } from '../../../screens/composer/draft';
import { APPROVAL_TR, CLASS_HINT_TR, CLASS_TR } from '../../compose/labels';
import { DyChoice, DyText, LABEL, More, Reason, Tag } from './fields';
import { useFormat } from '../../../i18n/I18nProvider';
import { TR_FORMAT } from '../../common/time';
import type { Formatter } from '@remyral/i18n';

/**
 * p12-diyalog-w1 "Kurallar": limits (time, cost, tokens, turns) under the project's ceiling with the budgets that
 * apply, the approval policy, the queue class (+ the numeric priority under "Gelişmiş") and when it starts (now, once
 * at a time, repeat on a cron with the next runs). Same rules as the classic `screens/composer/rules.tsx`.
 */

interface Props {
  readonly draft: Draft;
  readonly set: (p: Partial<Draft>) => void;
  readonly errors: Errors;
}

function fmtLimit(n: number | undefined, unit = '', f: Formatter = TR_FORMAT): string {
  return n === undefined ? 'sınırsız' : `${f.number(n)}${unit}`;
}

const SCOPE_TR: Readonly<Record<string, string>> = { global: 'genel', project: 'proje', runtime: 'runtime' };
const WINDOW_TR: Readonly<Record<string, string>> = { day: 'gün', week: 'hafta', month: 'ay' };

export function LimitsFields(
  props: Props & { readonly preview: PlacementPreview | null; readonly budgets: readonly BudgetView[] },
): ReactNode {
  const fmt = useFormat();
  const { draft, set, errors } = props;
  const l = props.preview?.limits;
  const relevant = props.budgets.filter(
    (b) =>
      b.budget.enabled &&
      (b.budget.scope.type === 'global' ||
        (b.budget.scope.type === 'project' && b.budget.scope.value === draft.project) ||
        (b.budget.scope.type === 'runtime' && b.budget.scope.value === draft.runtime)),
  );
  return (
    <fieldset className="m-0 grid min-w-0 gap-3 border-0 p-0">
      <legend className={LABEL}>Sınırlar</legend>
      {l !== undefined ? (
        <p className="m-0 -mt-1 text-[0.78125rem] text-dy-muted" data-testid="project-limits">
          Proje en çok şuna izin veriyor: maliyet {fmtLimit(l.maxCostUsd, ' USD', fmt)}, token{' '}
          {fmtLimit(l.maxTokens, '', fmt)}, tur {fmtLimit(l.maxTurns, '', fmt)}, süre{' '}
          {l.maxWallTimeSec === undefined ? 'sınırsız' : `${String(Math.floor(l.maxWallTimeSec / 60))} dk`}.
          Bir iş yalnızca daha sıkı olabilir.
        </p>
      ) : null}
      <div className="grid gap-3.5 sm:grid-cols-2">
        <DyText
          label="En uzun süre (dakika)"
          inputMode="numeric"
          mono
          value={draft.maxDurationMin}
          error={errors.maxDurationMin ?? null}
          onChange={(v) => {
            set({ maxDurationMin: v });
          }}
        />
        <DyText
          label="En yüksek maliyet (USD)"
          inputMode="decimal"
          mono
          value={draft.maxCostUsd}
          placeholder="sınırsız"
          error={errors.maxCostUsd ?? null}
          onChange={(v) => {
            set({ maxCostUsd: v });
          }}
        />
        <DyText
          label="En çok token"
          inputMode="numeric"
          mono
          value={draft.maxTokens}
          placeholder="sınırsız"
          error={errors.maxTokens ?? null}
          onChange={(v) => {
            set({ maxTokens: v });
          }}
        />
        <DyText
          label="En çok tur"
          inputMode="numeric"
          mono
          value={draft.maxTurns}
          placeholder="sınırsız"
          error={errors.maxTurns ?? null}
          onChange={(v) => {
            set({ maxTurns: v });
          }}
        />
      </div>
      {relevant.length > 0 ? (
        <div className="grid gap-1.5" data-testid="budget-headroom">
          <h3 className="m-0 text-[0.84375rem] font-bold">Geçerli bütçeler</h3>
          <ul className="m-0 grid list-none gap-1 p-0">
            {relevant.map((b) => {
              const e = b.evaluation;
              const pct = e === null ? null : Math.round(e.ratio * 100);
              return (
                <li key={b.budget.id} className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
                  <span className="font-bold">{b.budget.name}</span>
                  <span className="text-dy-muted">
                    {SCOPE_TR[b.budget.scope.type] ?? b.budget.scope.type} · {b.budget.metric} /{' '}
                    {WINDOW_TR[b.budget.window] ?? b.budget.window}
                  </span>
                  {pct === null ? null : (
                    <Tag tone={e?.status === 'over' ? 'red' : pct >= 80 ? 'amber' : 'green'}>
                      {`%${String(pct)} kullanıldı${e?.complete === false ? ' (eksik)' : ''}`}
                    </Tag>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </fieldset>
  );
}

export function ApprovalChoice(props: Props & { readonly preview: PlacementPreview | null }): ReactNode {
  const { draft, set, errors, preview } = props;
  return (
    <DyChoice
      legend="Onaylar"
      name="approval"
      value={draft.approvalPolicy}
      columns={2}
      testId="dy-composer-approval"
      error={errors.approvalPolicy ?? null}
      onChange={(v) => {
        set({ approvalPolicy: v });
      }}
      options={APPROVAL_POLICIES.map((p) => {
        const notAllowed = p === 'allow-all' && preview?.autoApproveExecution !== true;
        const untrusted = p === 'allow-all' && draft.sourceTrust !== 'trusted';
        const blocked = (notAllowed || untrusted) && draft.approvalPolicy !== p;
        return {
          value: p,
          label: APPROVAL_TR[p]?.label ?? p,
          disabled: blocked,
          description: APPROVAL_TR[p]?.text,
          aside: !blocked ? undefined : notAllowed ? (
            <Reason compact reason="auto_approve_not_allowed" />
          ) : (
            <span className="text-dy-muted">Yalnızca güvenilir kaynak için.</span>
          ),
        };
      })}
    />
  );
}

/**
 * p9-queue-priority: the class (Acil · Normal · Arka plan) is the everyday choice; the numeric priority it stands for
 * (+50 / 0 / -50) stays editable under "Gelişmiş" for fine-tuning within a class.
 */
export function PriorityField(props: Props): ReactNode {
  const { draft, set, errors } = props;
  const n = Number(draft.priority.trim());
  const cls = priorityClassOf(Number.isFinite(n) ? n : 0);
  return (
    <div className="grid gap-2" data-testid="dy-composer-class">
      <span className={LABEL} id="dy-composer-class-label">
        Kuyruk sınıfı
      </span>
      <div
        role="radiogroup"
        aria-labelledby="dy-composer-class-label"
        className="inline-flex w-fit flex-wrap gap-0.5 rounded-[10px] border border-dy-line bg-dy-sunk p-[3px]"
      >
        {PRIORITY_CLASSES.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === cls}
            onClick={() => {
              set({ priority: String(PRIORITY_CLASS_VALUE[c]) });
            }}
            className={cx(
              'dy-press min-h-9 rounded-[7px] px-3 text-[0.875rem]',
              c === cls
                ? 'bg-dy-card font-bold text-dy-ink shadow-dy-seg'
                : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
            )}
          >
            {CLASS_TR[c]}
          </button>
        ))}
      </div>
      <p className="m-0 text-[0.78125rem] text-dy-muted">{CLASS_HINT_TR[cls]}</p>
      <More summary="Gelişmiş: sayısal öncelik" open={errors.priority !== undefined}>
        <DyText
          label="Öncelik (sayı)"
          className="sm:max-w-56"
          inputMode="numeric"
          mono
          value={draft.priority}
          hint="-100 ile 100: Acil 50…100, Normal -49…49, Arka plan -100…-50. Bekleyen işler dakikada bir puan kazanır."
          error={errors.priority ?? null}
          onChange={(v) => {
            set({ priority: v });
          }}
        />
      </More>
    </div>
  );
}

function CronRuns(props: { readonly cron: string }): ReactNode {
  const sayError = useErrorText();
  const fmt = useFormat();
  const [runs, setRuns] = useState<string[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    const expr = props.cron.trim();
    if (expr.split(/\s+/).length !== 5) {
      setRuns(null);
      setError(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      cronPreview(expr).then(
        (r) => {
          if (!live) return;
          setRuns(r);
          setError(null);
        },
        (err: unknown) => {
          if (!live) return;
          setRuns(null);
          setError(toApiError(err));
        },
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [props.cron]);
  if (error) return <p className="m-0 text-[0.8125rem] font-medium text-dy-red-ink">{sayError(error)}</p>;
  if (runs === null) return null;
  return (
    <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="cron-runs">
      Sonraki çalışmalar:{' '}
      {runs.slice(0, 3).map((r, i) => (
        <span key={r}>
          {i > 0 ? ', ' : ''}
          <time dateTime={r}>{fmt.dateWith(r, { dateStyle: 'medium', timeStyle: 'short' })}</time>
        </span>
      ))}
    </p>
  );
}

export function ScheduleFields(props: Props): ReactNode {
  const { draft, set, errors } = props;
  return (
    <div className="grid gap-4" data-testid="dy-composer-when">
      <DyChoice
        legend="Ne zaman"
        name="when"
        value={draft.when}
        columns={3}
        error={errors.when ?? null}
        onChange={(v) => {
          set({ when: v === 'at' ? 'at' : v === 'cron' ? 'cron' : 'now' });
        }}
        options={[
          { value: 'now', label: 'Şimdi', description: 'Gönderince başlar.' },
          { value: 'at', label: 'Bir zamanda', description: 'Bir kez, sonra. Authenticator kodu ister.' },
          {
            value: 'cron',
            label: 'Tekrarla',
            description: 'Bir zamanlamayla (UTC). Authenticator kodu ister.',
          },
        ]}
      />
      {draft.when !== 'now' ? (
        <div className="grid gap-3.5">
          <DyText
            label="Zamanlama adı"
            value={draft.scheduleName}
            maxLength={200}
            placeholder="Gece bağımlılık güncellemesi"
            error={errors.scheduleName ?? null}
            onChange={(v) => {
              set({ scheduleName: v });
            }}
          />
          {draft.when === 'at' ? (
            <DyText
              label="Çalışma zamanı (yerel saatin)"
              className="sm:max-w-72"
              type="datetime-local"
              value={draft.at}
              error={errors.at ?? null}
              onChange={(v) => {
                set({ at: v });
              }}
            />
          ) : (
            <div className="grid gap-1.5 sm:max-w-96">
              <DyText
                label="Cron ifadesi (UTC)"
                mono
                value={draft.cron}
                spellCheck={false}
                autoComplete="off"
                hint="dakika saat ayın-günü ay haftanın-günü; örneğin 0 3 * * 1-5 (hafta içi 03:00 UTC). En sık 5 dakikada bir."
                error={errors.cron ?? null}
                onChange={(v) => {
                  set({ cron: v });
                }}
              />
              <CronRuns cron={draft.cron} />
            </div>
          )}
          <p className="m-0 text-[0.8125rem] text-dy-muted">
            Her çalışma senin adınla gönderilir: projeye erişimini kaybedersen zamanlama durur.
          </p>
        </div>
      ) : null}
    </div>
  );
}
