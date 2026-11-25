import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { PlacementPreview } from '../../../api/composer';
import { JOB_ROLES } from '../../../api/routing';
import { type AdviceView, areaLabel, AUTO_RUNTIME, getRuntimeAdvice } from '../../../api/runtimeAdvice';
import { cx } from '../../../components/ui';
import { describeReason, runtimeName } from '../../../lib/reasons';
import {
  ARCHS,
  type Draft,
  type Errors,
  isFullAccess,
  OS_FAMILIES,
  RUNTIMES,
  SANDBOX_PROFILES,
} from '../../../screens/composer/draft';
import { modelLabel } from '../../../screens/composer/labels';
import { MODEL_RUNTIMES, type ModelRuntime } from '../../../api/models';
import { useT } from '../../../i18n/I18nProvider';
import { DyModelPicker, useRuntimeModels } from '../shared/ModelPicker';
import { useRuntimeUsage } from '../../../screens/usage/runtimeUsage';
import { limitLine } from '../../compose/labels';
import { SANDBOX_TR } from '../../compose/labels';
import { RuntimeMark } from '../../RuntimeMark';
import { DyButton } from '../parts';
import { DyChecks, DyChoice, DySelectField, DyText, DyToggle, More, Reason, Tag } from './fields';
import { OS_TR, ROLE_TR } from './words';

/**
 * p12-diyalog-w1 "Nerede": job kind and its routing rule, runtime advice (use / let auto choose), the runtimes with
 * their readiness on the machines and their usage-limit line, model profile, an exact runtime version, fallbacks
 * and off-peak, the sandbox with the Full access switch, and machine requirements. Same rules as the classic
 * `screens/composer/where.tsx` (a disabled option is disabled for the same reason; untrusted → container only).
 */

interface Props {
  readonly draft: Draft;
  readonly set: (p: Partial<Draft>) => void;
  readonly errors: Errors;
  readonly preview: PlacementPreview | null;
}

const STATE_TR: Readonly<Record<string, string>> = {
  online: 'çevrimiçi',
  busy: 'meşgul',
  draining: 'boşaltılıyor',
  quarantined: 'karantinada',
};

/** The preview counts only when it was computed for the sandbox the job will use. */
function currentPreview(draft: Draft, preview: PlacementPreview | null): PlacementPreview | null {
  return preview?.sandboxProfile === draft.sandboxProfile ? preview : null;
}

function roleTr(role: string): string {
  return ROLE_TR[role] ?? role;
}

/** p6-smart-routing: the job's kind and the routing rule in force for it; offers the rule's runtime. */
export function KindChoice(props: Props): ReactNode {
  const { draft, set } = props;
  const routing = props.preview?.project === draft.project ? props.preview.routing : null;
  const rule = routing?.rule ?? null;
  const detected =
    draft.role === '' && routing?.roleSource === 'inferred' && routing.role !== null
      ? ` (algılanan: ${roleTr(routing.role)})`
      : '';
  return (
    <div className="grid gap-2" data-testid="kind-choice">
      <DySelectField
        label="İş türü"
        value={draft.role}
        options={[['', `İstemden${detected}`], ...JOB_ROLES.map((r) => [r, roleTr(r)] as const)]}
        onChange={(v) => {
          set({ role: v });
        }}
        hint={
          <span data-testid="routing-hint">
            {routing === null || routing.role === null
              ? 'Sınıflanmadı: model varsayılanları geçerli. Yönlendirme kuralını kullanmak için bir tür seç.'
              : rule === null
                ? `${roleTr(routing.role)} işleri için yönlendirme kuralı yok: model varsayılanları geçerli.`
                : `${roleTr(routing.role)} işleri için yönlendirme kuralı (${rule.scope === 'project' ? 'bu proje' : 'tüm projeler'}):${
                    rule.modelProfile === null ? '' : ` model ${rule.modelProfile}`
                  }${rule.runtimes.length === 0 ? '' : ` · runtime’lar ${rule.runtimes.map(runtimeName).join(' → ')}`}. Sen seçmezsen bu kullanılır.`}
          </span>
        }
      />
      {routing?.runtime != null && routing.runtime !== draft.runtime ? (
        <div>
          <DyButton
            data-testid="use-routed-runtime"
            onClick={() => {
              set({ runtime: routing.runtime ?? '', model: '' });
            }}
          >
            {runtimeName(routing.runtime)} kullan
          </DyButton>
        </div>
      ) : null}
    </div>
  );
}

/** p11-runtime-advice: the project's advice for the draft (advice only; the person chooses). */
export function RuntimeAdvice(props: Props): ReactNode {
  const { draft, set } = props;
  const [view, setView] = useState<AdviceView | null>(null);
  useEffect(() => {
    if (draft.project === '' || (draft.prompt.trim() === '' && draft.role === '')) {
      setView(null);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      getRuntimeAdvice(
        { project: draft.project, prompt: draft.prompt, ...(draft.role === '' ? {} : { role: draft.role }) },
        { signal: ctl.signal },
      ).then(setView, () => {
        // Advice is optional: a failure (or no permission) shows nothing.
        setView(null);
      });
    }, 600);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [draft.project, draft.prompt, draft.role]);
  if (view === null || view.mode === 'off') return null;
  const a = view.advice;
  const c = view.classification;
  const rec = a?.recommended ?? null;
  const differs = rec !== null && rec !== draft.runtime;
  return (
    <div
      data-testid="runtime-advice"
      className={cx(
        'grid gap-1.5 rounded-[10px] px-3 py-2 text-[0.875rem]',
        differs ? 'bg-dy-amber-soft text-dy-amber-ink' : 'bg-dy-sunk text-dy-muted',
      )}
    >
      <p className="m-0" data-testid="runtime-advice-text">
        <b className="font-bold">Runtime önerisi: </b>
        {a?.text ?? 'Bu taslak için henüz runtime önerisi yok.'}
      </p>
      <p className="m-0 text-[0.78125rem] opacity-90" data-testid="runtime-advice-area">
        İş alanı: {areaLabel(c.area)}
        {c.signals.length === 0
          ? ' (taslakta projenin hangi kısmına dokunduğunu söyleyen bir şey yok)'
          : ` — ${c.signals
              .slice(0, 4)
              .map((s) => `${s.source} “${s.detail}”`)
              .join(', ')}`}
        . Yalnızca öneri: runtime’ı sen seçersin.
      </p>
      <div className="flex flex-wrap gap-2">
        {differs ? (
          <DyButton
            data-testid="use-advised-runtime"
            onClick={() => {
              set({ runtime: rec, model: '' });
            }}
          >
            {runtimeName(rec)} kullan
          </DyButton>
        ) : null}
        {view.mode === 'auto' && draft.runtime !== AUTO_RUNTIME ? (
          <DyButton
            data-testid="use-auto-runtime"
            onClick={() => {
              set({ runtime: AUTO_RUNTIME, model: '', fallbacks: [] });
            }}
          >
            Otomatik mod seçsin
          </DyButton>
        ) : null}
      </div>
    </div>
  );
}

/** Runtimes with their readiness and their usage-limit line (the Faz 3 card's runtime rows). */
export function RuntimeChoice(props: Props): ReactNode {
  const { draft, set, errors } = props;
  const preview = currentPreview(draft, props.preview);
  const { data: usage } = useRuntimeUsage();
  const byRuntime = new Map((preview?.runtimes ?? []).map((r) => [r.runtime, r]));
  const names = new Map((props.preview?.workers ?? []).map((w) => [w.id, w.name]));
  const anyReady = (preview?.runtimes ?? []).some((r) => r.verdict === 'placed');
  return (
    <div className="grid gap-1.5" data-testid="dy-composer-runtimes">
      <DyChoice
        legend="Runtime"
        name="runtime"
        value={draft.runtime}
        error={errors.runtime ?? null}
        hint="Hazır olma durumu her makinenin runtime’larından, runtime politikasından ve aşağıdaki gereksinimlerden gelir."
        onChange={(v) => {
          set({ runtime: v, model: '' });
        }}
        options={[
          ...RUNTIMES.map((r) => {
            const a = byRuntime.get(r);
            const unavailable = a?.verdict === 'infeasible';
            const top = a?.summary.find((s) => s.permanent) ?? a?.summary[0];
            const single = top?.workers.length === 1 ? (top.workers[0] ?? null) : null;
            const context = {
              runtime: r,
              workerId: single,
              workerName: single === null ? null : (names.get(single) ?? null),
            };
            const showFix = draft.runtime === r || !anyReady;
            const line = limitLine(usage, r);
            return {
              value: r,
              testId: `dy-composer-runtime-${r}`,
              label: <RuntimeMark runtime={r} />,
              disabled: unavailable && draft.runtime !== r,
              badge: (
                <>
                  {a === undefined ? null : a.verdict === 'placed' ? (
                    <Tag tone="green">{`${String(a.eligible.length)} makinede hazır`}</Tag>
                  ) : a.verdict === 'waiting' ? (
                    <Tag tone="amber">
                      {a.feasible.length > 0 ? 'makineler meşgul ya da kapalı' : 'bekler'}
                    </Tag>
                  ) : (
                    <Tag tone="red">kullanılamaz</Tag>
                  )}
                  {line?.level === 'limited' ? (
                    <Tag tone="red">limitte</Tag>
                  ) : line?.level === 'near' ? (
                    <Tag tone="violet">limite yakın</Tag>
                  ) : null}
                </>
              ),
              description: (
                <>
                  {a === undefined ? null : a.verdict === 'placed' ? (
                    'Bir makine hemen başlatabilir.'
                  ) : top === undefined ? (
                    a.verdict === 'waiting' ? (
                      'Bir makine boşalana ya da açılana kadar bekler.'
                    ) : (
                      'Şu an hiçbir makine çalıştıramaz.'
                    )
                  ) : (
                    <span data-testid={`runtime-reason-${r}`} data-reason={top.code}>
                      {describeReason(`${top.code}: ${top.message}`, context, { locale: 'tr' }).sentence}
                      {top.workers.length > 1
                        ? ` (${top.workers.map((w) => names.get(w) ?? w).join(', ')})`
                        : ''}
                    </span>
                  )}
                  {line === null ? null : (
                    <span className="mt-0.5 block text-[0.78125rem]" data-testid={`dy-composer-limit-${r}`}>
                      Limit: {line.text}
                    </span>
                  )}
                </>
              ),
              aside:
                a === undefined || a.verdict === 'placed' || top === undefined || !showFix ? undefined : (
                  <div data-testid={`runtime-fix-${r}`}>
                    <Reason compact reason={`${top.code}: ${top.message}`} context={context} />
                  </div>
                ),
            };
          }),
          // p11-runtime-advice: shown once chosen ("Otomatik mod seçsin" in an auto-mode project).
          ...(draft.runtime === AUTO_RUNTIME
            ? [
                {
                  value: AUTO_RUNTIME,
                  label: 'Otomatik (sonuç geçmişine göre)',
                  description:
                    'Gönderdiğinde platform, burada bu tür işte en iyi sonucu veren runtime’ı seçer; iş sayfası nedenini söyler.',
                },
              ]
            : []),
        ]}
      />
      <Link
        to="/usage?tab=enforcement"
        className="w-fit text-[0.8125rem] text-dy-teal-ink no-underline hover:underline"
      >
        Limit ayrıntıları
      </Link>
    </div>
  );
}

/** Profiles valid for the runtime and the default that applies. */
export function ModelField(props: Props): ReactNode {
  const { draft, set, errors } = props;
  const preview = currentPreview(draft, props.preview);
  const profiles = preview?.placement?.runtime === draft.runtime ? preview.modelProfiles : [];
  const resolution = preview?.model?.runtime === draft.runtime ? preview.model : null;
  const mp = useT().modelPicker;
  const catalog = useRuntimeModels(draft.project === '' ? undefined : draft.project);
  const name = draft.runtime === '' ? 'Runtime' : runtimeName(draft.runtime);
  const defaultLabel =
    resolution?.defaultProfile != null
      ? `${resolution.defaultSource === 'routing' ? 'Yönlendirme' : 'Varsayılan'}: ${resolution.defaultProfile} (${resolution.defaultScope === 'project' ? 'bu proje' : 'tüm projeler'})`
      : 'Runtime’ın kendi modeli';
  // p15-model-picker: profiles first, then the runtime's models (machines' lists + catalog) and a custom id.
  const pickable = (MODEL_RUNTIMES as readonly string[]).includes(draft.runtime);
  return (
    <div className="grid gap-1.5">
      <DyModelPicker
        label={mp.composerLabel}
        runtimes={pickable ? [draft.runtime as ModelRuntime] : []}
        disabled={!pickable}
        value={draft.model}
        catalog={catalog}
        defaultLabel={defaultLabel}
        profiles={profiles.map((p) => ({ value: p.value, label: modelLabel(p) }))}
        testId="composer-model-picker"
        onChange={(v) => {
          set({ model: v });
        }}
        error={errors.model ?? null}
        hint={
          draft.runtime === ''
            ? 'Önce bir runtime seç.'
            : profiles.length > 0
              ? 'Yalnızca bu runtime için, onu çalıştırabilen makinelerde geçerli profiller sunulur.'
              : `${name} için bu makinelerde model profili yok; kendi modelini kullanır.`
        }
      />
      {profiles.length > 0 ? (
        <ul
          className="m-0 grid list-none gap-0.5 p-0 text-[0.78125rem] text-dy-muted"
          data-testid="model-options"
        >
          {(['policy', 'catalog'] as const).map((src) => {
            const group = profiles.filter((p) => p.source === src);
            if (group.length === 0) return null;
            return (
              <li key={src}>
                <span className="font-bold text-dy-ink">
                  {src === 'policy' ? 'Runtime politikası profilleri' : 'Model kataloğu'}:
                </span>{' '}
                {group.map((p) => p.displayName ?? p.name).join(', ')}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function RuntimeVersion(props: Props): ReactNode {
  const { draft, set, errors } = props;
  return (
    <More
      summary="Tam bir runtime sürümü sabitle"
      open={draft.runtimeVersion !== '' || errors.runtimeVersion !== undefined}
    >
      <DyText
        label="Runtime sürümü"
        className="sm:max-w-64"
        value={draft.runtimeVersion}
        placeholder="sabitlenmiş herhangi bir sürüm"
        autoComplete="off"
        mono
        error={errors.runtimeVersion ?? null}
        onChange={(v) => {
          set({ runtimeVersion: v });
        }}
      />
    </More>
  );
}

/** p6-quota-scheduling: fallback runtimes (in the order ticked) and the off-peak deferral. */
export function RuntimeFallbacks(props: Props): ReactNode {
  const { draft, set, errors } = props;
  return (
    <div className="grid gap-4">
      <DyChecks
        legend="Yedek runtime’lar"
        hint="Runtime bir kullanım limitiyle duraklarsa ya da hazır değilse bunları işaretlediğin sırayla dene. İş hangisinin çalıştığını kaydeder."
        values={draft.fallbacks}
        error={errors.fallbacks ?? null}
        options={RUNTIMES.filter((r) => r !== draft.runtime).map((r) => {
          const pos = draft.fallbacks.indexOf(r);
          return {
            value: r,
            label: runtimeName(r),
            badge: pos < 0 ? undefined : <Tag tone="neutral">{String(pos + 1)}</Tag>,
          };
        })}
        onChange={(v) => {
          set({ fallbacks: v.slice(0, 3) });
        }}
      />
      <DyChecks
        legend="Yoğun olmayan saat"
        hint="Projenin yoğun olmayan penceresini bekle (Projeler → Çalıştırma politikası); işteki “Şimdi çalıştır” daha erken başlatır. Pencere yoksa hemen çalışır."
        values={draft.deferrable ? ['defer'] : []}
        options={[{ value: 'defer', label: 'Yoğun olmayan pencereye ertele' }]}
        onChange={(v) => {
          set({ deferrable: v.includes('defer') });
        }}
      />
    </div>
  );
}

/** Which sandbox profiles the job may pick: container always; host profiles for trusted source where allowed. */
function sandboxBlock(p: string, draft: Draft, preview: PlacementPreview | null): string | null {
  if (p === 'container') return null;
  if (draft.sourceTrust !== 'trusted') return 'untrusted';
  if (preview?.hostExecution === false) return 'host_execution_not_enabled';
  if (p === 'unconfined' && preview?.unconfinedExecution === false) return 'unconfined_not_opted_in';
  return null;
}

export function SandboxChoice(props: Props & { readonly onFullAccess: (on: boolean) => void }): ReactNode {
  const { draft, set, errors, preview } = props;
  const ready = new Map((preview?.sandbox ?? []).map((s) => [s.profile, s.workers.length]));
  const blocks = [
    ...new Set(
      SANDBOX_PROFILES.map((p) => sandboxBlock(p, draft, preview)).filter((b): b is string => b !== null),
    ),
  ];
  const own = preview?.fullAccess.reasons.map((r) => r.code) ?? [];
  return (
    <div className="grid gap-3">
      <DyChoice
        legend="Yalıtım (sandbox)"
        name="sandbox"
        value={draft.sandboxProfile}
        columns={2}
        testId="dy-composer-sandbox"
        error={errors.sandboxProfile ?? null}
        onChange={(v) => {
          set({ sandboxProfile: v });
        }}
        options={SANDBOX_PROFILES.map((p) => {
          const n = ready.get(p);
          const block = sandboxBlock(p, draft, preview);
          return {
            value: p,
            label: SANDBOX_TR[p]?.label ?? p,
            disabled: block !== null && draft.sandboxProfile !== p,
            badge:
              n === undefined ? null : n > 0 ? (
                <Tag tone="green">{`${String(n)} makinede hazır`}</Tag>
              ) : (
                <Tag tone="red">hiçbir yerde hazır değil</Tag>
              ),
            description: SANDBOX_TR[p]?.text,
          };
        })}
      />
      {blocks.length > 0 ? (
        <div className="grid gap-1.5" data-testid="sandbox-blocks">
          {blocks.map((b) =>
            b === 'untrusted' ? (
              <p key={b} className="m-0 text-[0.8125rem] text-dy-muted">
                Makinede çalışan yalıtımlar güvenilmeyen kaynak için değil.
              </p>
            ) : (
              <Reason key={b} reason={b} tone="info" />
            ),
          )}
        </div>
      ) : null}
      <FullAccess
        draft={draft}
        preview={preview}
        onToggle={props.onFullAccess}
        shown={blocks.filter((b) => own.includes(b))}
      />
    </div>
  );
}

/**
 * p5-full-access (ADR-0020): one switch for the whole machine + never ask + trusted source, offered only when the
 * project allows all of it and some machine can run it; otherwise disabled with each reason and its fix.
 */
function FullAccess(props: {
  readonly draft: Draft;
  readonly preview: PlacementPreview | null;
  readonly onToggle: (on: boolean) => void;
  readonly shown: readonly string[];
}): ReactNode {
  const { draft, preview } = props;
  const on = isFullAccess(draft);
  const fa = preview?.fullAccess;
  const available = fa?.available === true;
  const names = new Map((preview?.workers ?? []).map((w) => [w.id, w.name]));
  const rest = (fa?.reasons ?? []).filter((r) => !props.shown.includes(r.code));
  return (
    <DyToggle
      testId="full-access-toggle"
      danger
      label="Tam erişim"
      hint="Ajan makinenin tamamını alır ve hiçbir araç çağrısından önce sorulmaz (yalıtım “Tüm makine”, onay “Hiç sorma”, güvenilir kaynak). Korumalı dala birleştirme, force-push, deploy ve kimlik kasası yine onayını ister."
      checked={on}
      disabled={!on && !available}
      onChange={props.onToggle}
    >
      {on ? (
        <p className="m-0 text-[0.8125rem] text-dy-red-ink">
          Dosya ya da ağ sınırı yok, soru yok. Kapatınca önceki seçimlerin geri gelir.
        </p>
      ) : available ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          Çalışabileceği makineler: {fa.workers.map((w) => names.get(w) ?? w).join(', ') || '—'}.
        </p>
      ) : rest.length === 0 && fa !== undefined ? null : (
        <ul className="m-0 grid list-none gap-1.5 p-0" data-testid="full-access-reasons">
          {rest.map((r) => (
            <li key={r.code}>
              <Reason compact reason={`${r.code}: ${r.message}`} />
            </li>
          ))}
          {fa === undefined ? <li className="text-[0.8125rem] text-dy-muted">Önce bir proje seç.</li> : null}
        </ul>
      )}
    </DyToggle>
  );
}

export function MachineRequirements(props: Props): ReactNode {
  const { draft, set, errors, preview } = props;
  const workers = preview?.workers ?? [];
  const knownTools = [...new Set(workers.flatMap((w) => w.tools))].sort();
  return (
    <div className="grid gap-4" data-testid="dy-composer-machines">
      <div className="grid gap-4 sm:grid-cols-2">
        <DyChecks
          legend="İşletim sistemi"
          hint="Hiçbiri işaretli değilse: herhangi biri."
          values={draft.os}
          options={OS_FAMILIES.map((o) => ({ value: o, label: OS_TR[o] ?? o }))}
          onChange={(v) => {
            set({ os: v });
          }}
        />
        <DyChecks
          legend="Mimari"
          hint="Hiçbiri işaretli değilse: herhangi biri."
          values={draft.arch}
          options={ARCHS.map((o) => ({ value: o, label: o }))}
          onChange={(v) => {
            set({ arch: v });
          }}
        />
      </div>
      <DyText
        label="Gerekli araçlar"
        value={draft.tools}
        autoComplete="off"
        spellCheck={false}
        mono
        placeholder="git, node, docker"
        hint={
          knownTools.length > 0
            ? `Makinelerin bildirdikleri: ${knownTools.join(', ')}.`
            : 'Makinede olması gereken araçlar, virgülle ayrılmış.'
        }
        error={errors.tools ?? null}
        onChange={(v) => {
          set({ tools: v });
        }}
      />
      <DyChecks
        legend="Makineler"
        hint="Yalnızca bu makinelerde çalıştır. Hiçbiri işaretli değilse: çalıştırabilen herhangi bir makine."
        values={draft.workers}
        error={errors.workers ?? null}
        options={workers.map((w) => ({
          value: w.id,
          label: <span translate="no">{w.name}</span>,
          badge: (
            <Tag tone={w.connected ? 'green' : 'neutral'}>
              {w.connected ? (STATE_TR[w.state] ?? w.state) : 'kapalı'}
            </Tag>
          ),
        }))}
        onChange={(v) => {
          set({ workers: v });
        }}
      />
    </div>
  );
}
