import { type ReactNode, useEffect, useState } from 'react';
import { type DeployTargets, getDeployTargets } from '../../../api/deploy';
import { PROTECTIONS, type PreviewProtection } from '../../../api/previews';
import {
  type DeployChoice,
  type DeployEnvChoice,
  deployError,
  deployOptions,
  type DeployTarget,
  type VerifyChoice,
  verifyChoiceOf,
} from '../../../screens/composer/deploy';
import { type PreviewChoice, previewError } from '../../../screens/composer/previews';
import {
  EMPTY_PUBLISH,
  needsPublish,
  NEW_PROJECT,
  publishOptions,
  publishProblem,
  type PublishState,
} from '../../../screens/deploy/publish';
import { DySelectField, DyText, DyToggle, Note } from './fields';
import { trError } from './words';

/**
 * p12-diyalog-w1: what happens when the job is done — "Bitince yayınla" (deploy-on-success with the Pages publish
 * chain: project, new project, custom domain + CNAME), "Bitince doğrula" and "Geliştirme sunucusu açılınca önizleme
 * aç". The checks are the classic ones (`deployError`, `deployOptions`, `publishProblem`, `previewError`); submitting
 * the job is the approval (production asks for a fresh authenticator code in the controller).
 */

export function VerifyWhenDone(props: {
  readonly value: VerifyChoice;
  readonly onChange: (next: VerifyChoice) => void;
  readonly deploying: boolean;
}): ReactNode {
  return (
    <DySelectField
      label="Bitince doğrula"
      testId="verify-when-done"
      value={props.value}
      options={[
        ['', 'Proje varsayılanı'],
        ['off', 'Kapalı'],
        ['report', 'Raporla — sonucu kontrol et ve bildir'],
        ['gate', 'Kapı — yayın kontrol geçene kadar bekler'],
      ]}
      onChange={(v) => {
        props.onChange(verifyChoiceOf(v));
      }}
      hint={`İş başarılı olunca bir doğrulayıcı sabit bir kontrol listesi çalıştırır: build / lint / testler; site için ekran görüntüleri, konsol hataları ve kırık linkler.${
        props.value === 'gate' && !props.deploying ? ' Kapı yalnızca “Bitince yayınla” ile anlam taşır.' : ''
      }`}
    />
  );
}

/** "Creates x if missing, deploys preview to x, attaches d and writes its CNAME." in Turkish. */
function chainTr(o: ReturnType<typeof publishOptions>, env: string, target: string | null): string {
  const project = o.pagesProject ?? target ?? 'Pages hedefi';
  const parts = [
    ...(o.createIfMissing === true ? [`${project} yoksa oluşturur`] : []),
    `${env === 'production' ? 'canlıya' : 'önizlemeye'} ${project} projesine yayınlar`,
    ...(o.domain === undefined
      ? []
      : [
          `${o.domain} alan adını bağlar${o.dns === 'skip' ? ' (DNS’e dokunmaz)' : ' ve CNAME kaydını yazar'}`,
        ]),
  ];
  const s = parts.join(', ');
  return `${s.charAt(0).toLocaleUpperCase('tr-TR')}${s.slice(1)}.`;
}

function PublishTo(props: {
  readonly targets: DeployTargets;
  readonly value: PublishState;
  readonly env: DeployEnvChoice;
  readonly onChange: (p: PublishState) => void;
}): ReactNode {
  const v = props.value;
  const target = props.targets.pages?.projectName ?? null;
  const set = (patch: Partial<PublishState>): void => {
    props.onChange({ ...v, ...patch });
  };
  const problem = publishProblem(v, target);
  const o = publishOptions(v);
  return (
    <div className="grid gap-3" data-testid="deploy-publish-to">
      <DySelectField
        label="Pages projesi"
        value={v.choice}
        options={[
          ['', target === null ? '— seç —' : `${target} (hedef)`],
          ...props.targets.pagesProjects.filter((c) => c !== target).map((c) => [c, c] as const),
          [NEW_PROJECT, 'Yeni proje…'],
        ]}
        onChange={(c) => {
          set({ choice: c });
        }}
      />
      {v.choice === NEW_PROJECT ? (
        <DyText
          label="Yeni Pages proje adı"
          mono
          value={v.newName}
          hint="Yoksa oluşturulur (Direct Upload) ve bu projenin Pages projelerine eklenir; hedef değişmez."
          onChange={(x) => {
            set({ newName: x });
          }}
        />
      ) : null}
      <DyText
        label="Özel alan adı (isteğe bağlı)"
        mono
        placeholder="site.example.com"
        value={v.domain}
        onChange={(x) => {
          set({ domain: x });
        }}
      />
      {v.domain.trim() !== '' ? (
        <DySelectField
          label="Alan adı için DNS"
          value={v.dns}
          options={[
            ['auto', 'CNAME kaydını yaz (projenin izinli bölgeleri)'],
            ['skip', 'DNS’e dokunma'],
          ]}
          onChange={(d) => {
            set({ dns: d === 'skip' ? 'skip' : 'auto' });
          }}
        />
      ) : null}
      {problem === null ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-red-ink" data-testid="field-error">
          {trError(problem)}
        </p>
      )}
      {needsPublish(o) ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="deploy-chain">
          {chainTr(o, props.env, target)} Şimdi tek onay (canlı ya da DNS söz konusuysa yeni bir authenticator
          kodu).
        </p>
      ) : null}
    </div>
  );
}

export function DeployWhenDone(props: {
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
  // Keep the choice consistent with what the project offers (the classic rule).
  useEffect(() => {
    if (!known || !value.enabled || !anyTarget) return;
    const targetOk = value.target === 'pages' ? opts.pages : opts.coolify.preview || opts.coolify.production;
    if (!targetOk) {
      onChange({ ...value, target: opts.pages ? 'pages' : 'coolify' });
    } else if (value.env === 'production' && !productionOk) {
      onChange({ ...value, env: 'preview' });
    }
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

  const error = props.showErrors ? deployError(value) : null;

  return (
    <DyToggle
      testId="deploy-when-done"
      label="Bitince yayınla"
      hint="İş başarılı olunca master sonucunu yayınlar ve canlı linki söyler. İşi göndermek yayını onaylamaktır."
      checked={value.enabled}
      onChange={(checked) => {
        onChange({ ...value, enabled: checked });
      }}
    >
      {!value.enabled ? null : project === '' ? (
        <Note>Önce bir proje seç.</Note>
      ) : failed ? (
        <Note tone="warn">Projenin yayın hedefleri okunamadı; master gönderirken kontrol eder.</Note>
      ) : !known ? (
        <p role="status" className="m-0 text-[0.8125rem] text-dy-muted">
          Projenin yayın hedefleri yükleniyor…
        </p>
      ) : !anyTarget ? (
        <Note tone="warn">
          Bu projenin henüz yayın hedefi yok. Bir proje yöneticisi Projeler → {project} → Yayın’da ayarlar.
        </Note>
      ) : (
        <>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <DySelectField
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
            <DySelectField
              label="Ortam"
              value={value.env}
              options={[
                ['preview', 'Önizleme'],
                ['production', 'Canlı', !productionOk],
              ]}
              onChange={(v) => {
                onChange({ ...value, env: v as DeployEnvChoice });
              }}
              hint={
                productionOk
                  ? 'Canlı, gönderirken güncel bir authenticator kodu ister.'
                  : 'Canlı kapalı: bir proje yöneticisi Proje → Yayın’da başarıda canlıya otomatik yayına izin verebilir.'
              }
            />
          </div>
          {value.target === 'pages' && targets.t !== null ? (
            <PublishTo
              targets={targets.t}
              value={value.publish ?? EMPTY_PUBLISH}
              env={value.env}
              onChange={(p) => {
                onChange({ ...value, publish: p });
              }}
            />
          ) : null}
          {value.target === 'pages' ? (
            <DyText
              label="Site klasörü"
              mono
              value={value.directory}
              error={error}
              hint={`Ajan bitmiş siteyi (index.html, CSS, görseller) ${value.directory.trim() || 'site'}/ klasörüne${props.workspace ? ' out/ altında' : ', depoda'} yazmalı; istemde bunu söyle.`}
              onChange={(v) => {
                onChange({ ...value, directory: v });
              }}
            />
          ) : (
            <p className="m-0 text-[0.8125rem] text-dy-muted">
              Coolify depodan derlediğini yayınlar (örneğin işin gönderdiği dal).
            </p>
          )}
        </>
      )}
    </DyToggle>
  );
}

const PROTECTION_TR: Readonly<Record<PreviewProtection, string>> = {
  none: 'Herkese açık link',
  access: 'Cloudflare Access (e-posta kodu)',
  'service-token': 'Servis jetonu (uygulama arka ucu)',
};

export function PreviewWhenUp(props: {
  readonly value: PreviewChoice;
  readonly onChange: (next: PreviewChoice) => void;
  readonly showErrors: boolean;
}): ReactNode {
  const { value, onChange } = props;
  const errors = props.showErrors ? previewError(value) : {};
  return (
    <DyToggle
      testId="preview-when-up"
      label="Geliştirme sunucusu açılınca önizleme aç"
      hint="İşin bir parçası porttan dinlemeye başlayınca master bir önizleme linki açar (Cloudflare Tunnel) ve iş sayfasında gösterir. Proje → Yayın’da önizleme linklerinin kurulu olması gerekir."
      checked={value.enabled}
      onChange={(checked) => {
        onChange({ ...value, enabled: checked });
      }}
    >
      {value.enabled ? (
        <>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <DyText
              label="Geliştirme sunucusu portu"
              type="number"
              mono
              min={1024}
              max={65535}
              value={value.port}
              error={errors.port ?? null}
              onChange={(v) => {
                onChange({ ...value, port: v });
              }}
            />
            <DySelectField
              label="Koruma"
              value={value.protect}
              options={PROTECTIONS.map((p) => [p, PROTECTION_TR[p]] as const)}
              onChange={(v) => {
                onChange({ ...value, protect: v as PreviewProtection });
              }}
            />
            <DyText
              label="Önizleme adı"
              mono
              value={value.name}
              maxLength={20}
              error={errors.name ?? null}
              hint="İş önizlemesi için isteğe bağlı; örneğin web ya da api."
              onChange={(v) => {
                onChange({ ...value, name: v });
              }}
            />
            <label className="flex min-h-11 cursor-pointer items-start gap-2.5 self-end text-[0.875rem]">
              <input
                type="checkbox"
                checked={value.stable}
                onChange={(e) => {
                  onChange({ ...value, stable: e.target.checked });
                }}
                className="mt-[3px] size-4 shrink-0 accent-[var(--dy-teal)]"
              />
              <span>
                <b className="block font-bold">Sabit adres (uygulama arka ucu)</b>
                <span className="text-[0.8125rem] text-dy-muted">
                  Sonraki işler için de aynı ana makine adı — bir uygulama paketine göm. Genelde onay ister.
                </span>
              </span>
            </label>
          </div>
          {value.protect === 'none' ? (
            <Note tone="warn">Herkese açık link: linki bilen herkes önizlemeyi açabilir.</Note>
          ) : null}
        </>
      ) : null}
    </DyToggle>
  );
}
