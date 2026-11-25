import { useErrorText } from '../../../i18n/errors';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { automationCronPreview, CRON_PRESETS } from '../../../api/automations';
import type { ApiError } from '../../../api/client';
import { type DeployTargets, getDeployTargets } from '../../../api/deploy';
import { PRIORITY_CLASSES, type PriorityClass } from '../../../api/queue';
import {
  ALLOWED_EXTENSIONS,
  formatBytes,
  MAX_INPUT_FILES,
  MAX_INPUT_TOTAL_BYTES,
} from '../../../api/workspaces';
import { cx, toApiError } from '../../../components/ui';
import type { ContinueKind, FilesState } from '../../../screens/automations/files';
import {
  type DeployChoice,
  type DeployEnvChoice,
  type DeployTarget,
  deployError,
  deployOptions,
  type VerifyChoice,
  verifyChoiceOf,
} from '../../../screens/composer/deploy';
import { inputFileError, readInputFile } from '../../../screens/composer/inputs';
import {
  EMPTY_PUBLISH,
  needsPublish,
  NEW_PROJECT,
  publishOptions,
  publishProblem,
  type PublishState,
} from '../../../screens/deploy/publish';
import { CLASS_HINT_TR, CLASS_TR } from '../../compose/labels';
import { DyIcon } from '../../icons';
import { DyCheck, DyChoice, DyInput, DyNotice } from '../kit';
import { DyButton } from '../parts';
import { CRON_PRESET_TR, errTr } from './labels';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { isTimeZone, timeZoneNames } from '../../../lib/schedule';

/**
 * p12-diyalog-w2: the native fields of the automation form — choice cards, check groups, the cron builder with the
 * master's preview, the priority class, input files with continue-from, "deploy when done" with the publish chain
 * and "verify when done". The rules (validation, offered targets) are the classic helpers; only the UI is new.
 */

export interface CardOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly aside?: ReactNode;
}

/** A radio group as selectable cards (one column on phones). */
export function ChoiceCards(props: {
  readonly legend: string;
  readonly name: string;
  readonly value: string;
  readonly options: readonly CardOption[];
  readonly onChange: (v: string) => void;
  readonly hint?: ReactNode;
  readonly columns?: 1 | 2 | 3;
  readonly error?: string | null;
  readonly testId?: string;
}): ReactNode {
  const id = useId();
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" data-testid={props.testId}>
      <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{props.legend}</legend>
      {props.hint === undefined ? null : (
        <p className="m-0 -mt-1 text-[0.78125rem] text-dy-muted">{props.hint}</p>
      )}
      <div
        className={cx(
          'grid gap-2',
          props.columns === 3 ? 'sm:grid-cols-3' : props.columns === 1 ? '' : 'sm:grid-cols-2',
        )}
      >
        {props.options.map((o) => {
          const checked = props.value === o.value;
          return (
            <label
              key={o.value}
              htmlFor={`${id}-${o.value}`}
              className={cx(
                'flex min-w-0 cursor-pointer items-start gap-2.5 rounded-[11px] border px-3 py-2.5 transition-colors duration-150',
                checked ? 'border-dy-teal bg-dy-teal-soft' : 'border-dy-line-2 bg-dy-card',
                o.disabled === true && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                id={`${id}-${o.value}`}
                type="radio"
                name={props.name}
                value={o.value}
                checked={checked}
                disabled={o.disabled}
                onChange={() => {
                  props.onChange(o.value);
                }}
                className="mt-1 size-4 shrink-0 accent-[var(--dy-teal)]"
              />
              <span className="min-w-0">
                <span className="block text-[0.875rem] font-bold">{o.label}</span>
                {o.description === undefined ? null : (
                  <span className="block text-[0.78125rem] text-dy-muted">{o.description}</span>
                )}
                {o.aside}
              </span>
            </label>
          );
        })}
      </div>
      {props.error === undefined || props.error === null ? null : (
        <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{props.error}</p>
      )}
    </fieldset>
  );
}

/** Several checkboxes (GitHub events / actions, chain outcomes). Labels show `_` as spaces. */
export function CheckGroup<T extends string>(props: {
  readonly legend: string;
  readonly options: readonly T[];
  readonly value: readonly T[];
  readonly onChange: (v: T[]) => void;
  readonly label?: (o: T) => string;
  readonly error?: string | null;
}): ReactNode {
  const id = useId();
  return (
    <fieldset className="m-0 grid min-w-0 gap-1.5 border-0 p-0">
      <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{props.legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {props.options.map((o) => {
          const on = props.value.includes(o);
          return (
            <label
              key={o}
              htmlFor={`${id}-${o}`}
              className={cx(
                'inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[0.8125rem]',
                on
                  ? 'border-dy-teal bg-dy-teal-soft font-bold text-dy-teal-ink'
                  : 'border-dy-line-2 bg-dy-card',
              )}
            >
              <input
                id={`${id}-${o}`}
                type="checkbox"
                checked={on}
                onChange={(e) => {
                  props.onChange(e.target.checked ? [...props.value, o] : props.value.filter((x) => x !== o));
                }}
                className="size-3.5 accent-[var(--dy-teal)]"
              />
              {props.label === undefined ? o.replace(/_/g, ' ') : props.label(o)}
            </label>
          );
        })}
      </div>
      {props.error === undefined || props.error === null ? null : (
        <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{props.error}</p>
      )}
    </fieldset>
  );
}

/** Presets, the expression, and the master's human summary with the next runs (debounced preview). */
export function CronBuilder(props: {
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly error: string | null;
  /** p16-workflow-quality: the IANA zone the expression is read in (absent: UTC, no zone field). */
  readonly timeZone?: string;
  readonly onTimeZone?: (v: string) => void;
}): ReactNode {
  const sayError = useErrorText();
  const fmt = useFormat();
  const tz = useT().workflowQuality.schedule;
  const zonesId = useId();
  const zone = props.timeZone?.trim() ?? 'UTC';
  const zoneOk = zone === '' || isTimeZone(zone);
  const [preview, setPreview] = useState<{ summary: string; nextRuns: string[] } | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  useEffect(() => {
    const cron = props.value.trim();
    if (cron.split(/\s+/).length !== 5) {
      setPreview(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      automationCronPreview(cron, {}, zoneOk && zone !== '' ? zone : undefined).then(
        (p) => {
          if (!live) return;
          setPreview(p);
          setProblem(null);
        },
        (err: unknown) => {
          if (!live) return;
          setPreview(null);
          setProblem(toApiError(err));
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [props.value, zone, zoneOk]);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Hazır zamanlamalar">
        {CRON_PRESETS.map((p) => {
          const on = props.value.trim() === p.cron;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              onClick={() => {
                props.onChange(p.cron);
              }}
              className={cx(
                'dy-press inline-flex min-h-9 items-center rounded-full border px-3 text-[0.8125rem] font-medium',
                on ? 'border-dy-ink bg-dy-ink text-dy-card' : 'border-dy-line-2 bg-dy-card text-dy-ink',
              )}
            >
              {CRON_PRESET_TR[p.id] ?? p.label}
            </button>
          );
        })}
      </div>
      <DyInput
        label={tz.expression}
        className="font-dy-mono"
        value={props.value}
        error={props.error}
        spellCheck={false}
        autoComplete="off"
        hint="dakika saat ayın-günü ay haftanın-günü — en sık 5 dakikada bir"
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
      />
      {props.onTimeZone === undefined ? null : (
        <>
          <DyInput
            label={tz.zone}
            className="font-dy-mono"
            value={props.timeZone ?? ''}
            list={zonesId}
            spellCheck={false}
            autoComplete="off"
            data-testid="cron-timezone"
            hint={tz.zoneHint}
            error={zoneOk ? null : tz.zoneInvalid}
            onChange={(e) => {
              props.onTimeZone?.(e.target.value);
            }}
          />
          <datalist id={zonesId}>
            {timeZoneNames().map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </>
      )}
      <div aria-live="polite" data-testid="cron-preview">
        {preview !== null ? (
          <div className="rounded-[10px] bg-dy-sunk px-3 py-2 text-[0.875rem]">
            <p className="m-0 font-bold" data-testid="cron-summary">
              {preview.summary}
            </p>
            <p className="m-0 text-[0.78125rem] text-dy-muted">
              Sonraki:{' '}
              {preview.nextRuns
                .slice(0, 3)
                .map((r) =>
                  fmt.dateWith(r, {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                )
                .join(' · ')}
            </p>
          </div>
        ) : null}
        {problem !== null ? (
          <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{sayError(problem)}</p>
        ) : null}
      </div>
    </div>
  );
}

/** Acil · Normal · Arka plan as a segmented radio group. */
export function ClassPicker(props: {
  readonly value: PriorityClass;
  readonly onChange: (v: PriorityClass) => void;
}): ReactNode {
  return (
    <div className="grid gap-1.5" data-testid="automation-priority">
      <span className="text-[0.8125rem] font-bold" id="automation-priority-label">
        Öncelik sınıfı
      </span>
      <div
        role="radiogroup"
        aria-labelledby="automation-priority-label"
        className="inline-flex w-fit flex-wrap gap-0.5 rounded-[10px] border border-dy-line bg-dy-sunk p-[3px]"
      >
        {PRIORITY_CLASSES.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={props.value === c}
            data-class={c}
            onClick={() => {
              props.onChange(c);
            }}
            className={cx(
              'inline-flex min-h-9 items-center rounded-[7px] px-3 text-[0.84375rem] font-medium',
              props.value === c
                ? cx('bg-dy-card shadow-dy-seg', c === 'urgent' ? 'text-dy-red-ink' : 'text-dy-ink')
                : 'text-dy-muted',
            )}
          >
            {CLASS_TR[c]}
          </button>
        ))}
      </div>
      <p className="m-0 text-[0.78125rem] text-dy-muted">{CLASS_HINT_TR[props.value]}</p>
    </div>
  );
}

/** Input files of a workspace automation and its continue-from rule (classic helpers check sizes and types). */
export function FilesFields(props: {
  readonly value: FilesState;
  readonly onChange: (next: FilesState) => void;
  readonly target: 'job' | 'workflow';
  readonly trigger: string;
  readonly errors: Readonly<Record<string, string>>;
}): ReactNode {
  const { value, onChange, errors } = props;
  const [problems, setProblems] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const all = [...value.keepFiles, ...value.newFiles];
  const total = all.reduce((n, f) => n + f.sizeBytes, 0);
  async function add(files: readonly File[]): Promise<void> {
    const issues: string[] = [];
    let added = value.newFiles;
    setReading(true);
    try {
      for (const file of files) {
        const why = inputFileError(file, [...value.keepFiles, ...added]);
        if (why !== null) {
          issues.push(why);
          continue;
        }
        try {
          added = [...added, await readInputFile(file)];
        } catch {
          issues.push(`${file.name}: dosya okunamadı.`);
        }
      }
    } finally {
      setReading(false);
    }
    setProblems(issues);
    onChange({ ...value, newFiles: added });
  }
  const options: CardOption[] = [
    {
      value: 'none',
      label: 'Sıfırdan başla',
      description: 'Her çalıştırma yalnızca yukarıdaki dosyaları alır.',
    },
    ...(props.target === 'job'
      ? [
          {
            value: 'last-run',
            label: 'Son çalıştırmasından',
            description: 'Bu otomasyonun son başarılı çalıştırmasının sonuçları eklenir.',
          },
        ]
      : []),
    ...(props.trigger === 'chain'
      ? [
          {
            value: 'chain-source',
            label: 'Onu başlatan çalıştırmadan',
            description: 'Arkasından geldiği otomasyonun işinin sonuçları eklenir.',
          },
        ]
      : []),
    {
      value: 'job',
      label: 'Bir işten',
      description: 'Seçtiğin bir işin sonuçları her çalıştırmaya eklenir.',
    },
  ];
  return (
    <div className="grid gap-4" data-testid="automation-files">
      <div className="grid gap-1.5">
        <label htmlFor="automation-inputs" className="text-[0.8125rem] font-bold">
          Girdi dosyaları
        </label>
        <input
          id="automation-inputs"
          type="file"
          multiple
          accept={ALLOWED_EXTENSIONS.join(',')}
          aria-describedby="automation-inputs-hint"
          className="text-[0.875rem] file:mr-3 file:min-h-9 file:rounded-[9px] file:border file:border-dy-line-2 file:bg-dy-card file:px-3 file:text-[0.875rem] file:font-medium file:text-dy-ink"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void add(files);
          }}
        />
        <p id="automation-inputs-hint" className="m-0 text-[0.78125rem] text-dy-muted">
          Her çalıştırma <span className="font-dy-mono">in/</span> altında taze bir kopya alır
          {props.target === 'workflow' ? ' (iş akışının her adımı)' : ''}. En çok {MAX_INPUT_FILES} dosya,
          toplam {formatBytes(MAX_INPUT_TOTAL_BYTES)}; türler {ALLOWED_EXTENSIONS.join(' ')}. Kaydederken sır
          taraması yapılır.
        </p>
        {reading ? (
          <p role="status" className="m-0 text-[0.78125rem] text-dy-muted">
            Dosyalar okunuyor…
          </p>
        ) : null}
        {problems.length > 0 ? (
          <ul
            className="m-0 grid list-none gap-0.5 p-0"
            aria-live="polite"
            data-testid="automation-file-problems"
          >
            {problems.map((p) => (
              <li key={p} className="text-[0.78125rem] font-medium text-dy-red-ink">
                {p}
              </li>
            ))}
          </ul>
        ) : null}
        {errors.files ? (
          <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{errTr(errors.files)}</p>
        ) : null}
      </div>
      {all.length > 0 ? (
        <ul
          className="m-0 grid list-none rounded-[10px] border border-dy-line p-0"
          aria-label="Girdi dosyaları"
        >
          {value.keepFiles.map((f) => (
            <li
              key={`keep:${f.id}`}
              data-testid="automation-file"
              className="flex items-center gap-2 border-b border-dy-line px-3 py-1.5 text-[0.875rem]"
            >
              <DyIcon name="file" className="size-4 shrink-0 text-dy-muted" />
              <span className="min-w-0 flex-1 truncate font-dy-mono">{f.name}</span>
              <span className="text-[0.75rem] text-dy-muted tabular-nums">
                {formatBytes(f.sizeBytes)} · kayıtlı
              </span>
              <DyButton
                variant="ghost"
                aria-label={`${f.name} dosyasını çıkar`}
                onClick={() => {
                  onChange({ ...value, keepFiles: value.keepFiles.filter((x) => x.id !== f.id) });
                }}
              >
                Çıkar
              </DyButton>
            </li>
          ))}
          {value.newFiles.map((f) => (
            <li
              key={`new:${f.name}`}
              data-testid="automation-file"
              className="flex items-center gap-2 border-b border-dy-line px-3 py-1.5 text-[0.875rem]"
            >
              <DyIcon name="file" className="size-4 shrink-0 text-dy-muted" />
              <span className="min-w-0 flex-1 truncate font-dy-mono">{f.name}</span>
              <span className="text-[0.75rem] text-dy-muted tabular-nums">
                {formatBytes(f.sizeBytes)} · yeni
              </span>
              <DyButton
                variant="ghost"
                aria-label={`${f.name} dosyasını çıkar`}
                onClick={() => {
                  onChange({ ...value, newFiles: value.newFiles.filter((x) => x.name !== f.name) });
                }}
              >
                Çıkar
              </DyButton>
            </li>
          ))}
          <li className="px-3 py-1.5 font-dy-mono text-[0.75rem] text-dy-muted tabular-nums">
            {all.length} / {MAX_INPUT_FILES} dosya · {formatBytes(total)} /{' '}
            {formatBytes(MAX_INPUT_TOTAL_BYTES)}
          </li>
        </ul>
      ) : null}
      <ChoiceCards
        legend="Nereden devam"
        name="automation-continue"
        value={value.continueKind}
        hint="Önceki sonuçlar her çalıştırmaya girdi dosyası olarak eklenir (ajan için veri, asla talimat değil)."
        options={options}
        error={errTr(errors.continueKind)}
        onChange={(v) => {
          const kind = (options.find((o) => o.value === v)?.value ?? 'none') as ContinueKind;
          onChange({ ...value, continueKind: kind });
        }}
      />
      {value.continueKind === 'job' ? (
        <DyInput
          label="Devam edilecek iş"
          className="font-dy-mono"
          value={value.continueJob}
          autoComplete="off"
          spellCheck={false}
          placeholder="iş kimliği"
          hint="İşe erişimin olmalı; otomasyonun adına çalıştığı kişi her çalıştırmada yeniden denetlenir."
          error={errTr(errors.continueJob)}
          onChange={(e) => {
            onChange({ ...value, continueJob: e.target.value });
          }}
        />
      ) : null}
    </div>
  );
}

/** "Bitince doğrula" — '' = the project's default. */
export function VerifyField(props: {
  readonly value: VerifyChoice;
  readonly onChange: (v: VerifyChoice) => void;
  readonly deploying: boolean;
}): ReactNode {
  return (
    <div data-testid="verify-when-done">
      <DyChoice
        label="Bitince doğrula"
        value={props.value}
        options={[
          ['', 'Proje varsayılanı'],
          ['off', 'Kapalı'],
          ['report', 'Raporla — sonucu denetle ve bildir'],
          ['gate', 'Kapı — yayın denetim geçene kadar bekler'],
        ]}
        hint={`Bir doğrulayıcı iş başarılı olunca sabit bir liste çalıştırır: derleme / lint / testler; site için ekran görüntüleri, konsol hataları ve kırık bağlantılar.${
          props.value === 'gate' && !props.deploying ? ' Kapı yalnızca “Bitince yayınla” ile anlamlı.' : ''
        }`}
        onChange={(v) => {
          props.onChange(verifyChoiceOf(v));
        }}
      />
    </div>
  );
}

/** "Bitince yayınla": the project's offered targets only; Pages may publish through the one-approval chain. */
export function DeployField(props: {
  readonly project: string;
  readonly workspace: boolean;
  readonly value: DeployChoice;
  readonly onChange: (next: DeployChoice) => void;
  readonly showErrors: boolean;
}): ReactNode {
  const { project, value, onChange } = props;
  const [targets, setTargets] = useState<{ project: string; t: DeployTargets | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const enabled = value.enabled;
  useEffect(() => {
    if (project === '' || !enabled) return;
    const ctl = new AbortController();
    setFailed(false);
    getDeployTargets(project, { signal: ctl.signal }).then(
      (r) => {
        setTargets({ project, t: r.targets });
      },
      () => {
        if (!ctl.signal.aborted) setFailed(true);
      },
    );
    return () => {
      ctl.abort();
    };
  }, [project, enabled]);
  const known = targets !== null && targets.project === project;
  const opts = deployOptions(known ? targets.t : null);
  const anyTarget = opts.pages || opts.coolify.preview || opts.coolify.production;
  const productionOk = opts.productionAllowed && (value.target === 'pages' || opts.coolify.production);
  useEffect(() => {
    if (!known || !value.enabled || !anyTarget) return;
    const targetOk = value.target === 'pages' ? opts.pages : opts.coolify.preview || opts.coolify.production;
    if (!targetOk) onChange({ ...value, target: opts.pages ? 'pages' : 'coolify' });
    else if (value.env === 'production' && !productionOk) onChange({ ...value, env: 'preview' });
  }, [
    known,
    anyTarget,
    opts.pages,
    opts.coolify.preview,
    opts.coolify.production,
    productionOk,
    value,
    onChange,
  ]);
  const error = props.showErrors ? errTr(deployError(value)) : null;
  const pub: PublishState = value.publish ?? EMPTY_PUBLISH;
  const pagesTarget = known ? (targets.t?.pages?.projectName ?? null) : null;
  const setPub = (patch: Partial<PublishState>): void => {
    onChange({ ...value, publish: { ...pub, ...patch } });
  };
  const pubProblem = errTr(publishProblem(pub, pagesTarget));
  return (
    <div className="grid gap-3" data-testid="deploy-when-done">
      <DyCheck
        label="Bitince yayınla"
        hint="İş başarılı olunca master sonucunu yayınlar ve canlı bağlantıyı bildirir. Kaydetmek yayını onaylar."
        checked={value.enabled}
        onChange={(checked) => {
          onChange({ ...value, enabled: checked });
        }}
      />
      {value.enabled ? (
        project === '' ? (
          <DyNotice tone="neutral">Önce bir proje seç.</DyNotice>
        ) : failed ? (
          <DyNotice tone="amber">Projenin yayın hedefleri okunamadı; master kaydederken denetler.</DyNotice>
        ) : !known ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">Projenin yayın hedefleri yükleniyor…</p>
        ) : !anyTarget ? (
          <DyNotice tone="amber">
            Bu projenin henüz yayın hedefi yok. Bir proje yöneticisi Projeler → {project} → Deploy’dan
            ayarlar.
          </DyNotice>
        ) : (
          <div className="grid gap-3 border-l-2 border-dy-line pl-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <DyChoice
                label="Nereye"
                value={value.target}
                options={[
                  ...(opts.pages ? [['pages', 'Cloudflare Pages (statik site)'] as const] : []),
                  ...(opts.coolify.preview || opts.coolify.production
                    ? [['coolify', 'Coolify uygulaması'] as const]
                    : []),
                ]}
                onChange={(v) => {
                  onChange({ ...value, target: v as DeployTarget });
                }}
              />
              <DyChoice
                label="Ortam"
                value={value.env}
                options={
                  productionOk
                    ? [
                        ['preview', 'Önizleme'],
                        ['production', 'Production'],
                      ]
                    : [['preview', 'Önizleme']]
                }
                hint={
                  productionOk
                    ? 'Production kaydederken güncel bir doğrulama kodu ister.'
                    : 'Production kapalı: bir proje yöneticisi Proje → Deploy’dan başarıda production’a otomatik yayına izin verebilir.'
                }
                onChange={(v) => {
                  onChange({ ...value, env: v as DeployEnvChoice });
                }}
              />
            </div>
            {value.target === 'pages' && targets.t !== null ? (
              <div className="grid gap-3" data-testid="deploy-publish-to">
                <DyChoice
                  label="Pages projesi"
                  value={pub.choice}
                  options={[
                    ['', pagesTarget === null ? '— seç —' : `${pagesTarget} (hedef)`],
                    ...targets.t.pagesProjects.filter((c) => c !== pagesTarget).map((c) => [c, c] as const),
                    [NEW_PROJECT, 'Yeni proje…'],
                  ]}
                  onChange={(c) => {
                    setPub({ choice: c });
                  }}
                />
                {pub.choice === NEW_PROJECT ? (
                  <DyInput
                    label="Yeni Pages projesinin adı"
                    className="font-dy-mono"
                    value={pub.newName}
                    hint="Yoksa oluşturulur (Direct Upload) ve projenin Pages projelerine eklenir; hedef değişmez."
                    onChange={(e) => {
                      setPub({ newName: e.target.value });
                    }}
                  />
                ) : null}
                <DyInput
                  label="Özel alan adı (isteğe bağlı)"
                  className="font-dy-mono"
                  placeholder="site.example.com"
                  value={pub.domain}
                  onChange={(e) => {
                    setPub({ domain: e.target.value });
                  }}
                />
                {pub.domain.trim() !== '' ? (
                  <DyChoice
                    label="Alan adının DNS’i"
                    value={pub.dns}
                    options={[
                      ['auto', 'CNAME kaydını yaz (projenin izinli bölgeleri)'],
                      ['skip', 'DNS’e dokunma'],
                    ]}
                    onChange={(d) => {
                      setPub({ dns: d === 'skip' ? 'skip' : 'auto' });
                    }}
                  />
                ) : null}
                {(() => {
                  const o = publishOptions(pub);
                  if (!needsPublish(o)) return null;
                  const name = o.pagesProject ?? pagesTarget ?? 'Pages hedefi';
                  const parts = [
                    ...(o.createIfMissing === true ? [`${name} yoksa oluşturulur`] : []),
                    `${value.env === 'production' ? 'production' : 'önizleme'} ${name} projesine yayınlanır`,
                    ...(o.domain === undefined
                      ? []
                      : [
                          `${o.domain} bağlanır${o.dns === 'skip' ? ' (DNS’e dokunulmaz)' : ' ve CNAME kaydı yazılır'}`,
                        ]),
                  ];
                  return (
                    <p className="m-0 text-[0.78125rem] text-dy-muted" data-testid="deploy-chain">
                      {parts.join(', ')}. Tek onay şimdi (production ya da DNS varsa güncel bir doğrulama
                      kodu).
                    </p>
                  );
                })()}
                {pubProblem === null || value.publish === undefined ? null : (
                  <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{pubProblem}</p>
                )}
              </div>
            ) : null}
            {value.target === 'pages' ? (
              <DyInput
                label="Site klasörü"
                className="font-dy-mono"
                value={value.directory}
                error={error}
                hint={`Ajan bitmiş siteyi (index.html, CSS, görseller) ${value.directory.trim() || 'site'}/ klasörüne yazmalı${props.workspace ? ' (out/ altında)' : ' (deponun içinde)'}; görevde bunu söyle.`}
                onChange={(e) => {
                  onChange({ ...value, directory: e.target.value });
                }}
              />
            ) : (
              <p className="m-0 text-[0.78125rem] text-dy-muted">
                Coolify depodan derlediğini yayınlar (örneğin işin push ettiği dal).
              </p>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}
