import { type ReactNode, type SubmitEvent, useState } from 'react';
import type { Project } from '../../../api/directory';
import {
  createMonitor,
  type Monitor,
  type MonitorType,
  MONITOR_TYPES,
  updateMonitor,
  validateMonitorForm,
} from '../../../api/uptime';
import {
  coolifyConnectionOptions,
  monitorConfigOf,
  monitorFormInitial,
  type MonitorFormState,
  useProjectCoolifyConnections,
} from '../../../screens/uptime/coolifyConnections';
import { useSubmit } from '../../../screens/useSubmit';
import { DyApiError, DyCheck, DyChoice, DyDialog, DyFieldset, DyInput, DyNotice } from '../kit';
import { DyButton } from '../parts';
import { TYPE_WORD } from './shared';

/**
 * p12-diyalog-w2: the New / Edit monitor form in the Diyalog language, for every type — http(s), tcp, Cloudflare
 * Pages, Coolify app. The state, defaults and payload are the classic form's (`monitorFormInitial`,
 * `monitorConfigOf`), the checks the classic `validateMonitorForm` (messages in Turkish), the calls the classic
 * `createMonitor` / `updateMonitor`; the master checks everything again and its message is shown verbatim.
 */

/** The classic validation messages in Turkish (the field keys are the classic ones). */
export function validationTr(field: string, message: string): string {
  if (field === 'name') return 'Monitöre bir ad ver.';
  if (field === 'project') return 'Bir proje seç.';
  if (field === 'intervalSec')
    return message.startsWith('Provider')
      ? 'Sağlayıcı kontrolleri en fazla dakikada bir çalışır (60–86400 sn).'
      : 'En az 30 sn, en fazla 86400 sn.';
  if (field === 'url') {
    const port = /^Port (\d+)/.exec(message);
    if (port !== null) return `${port[1] ?? ''} portuna izin yok: 80, 443, 8080 ya da 8443 kullan.`;
    if (message.startsWith('Only')) return 'Yalnızca http:// ve https:// adresleri.';
    if (message.startsWith('No user')) return 'URL’de kullanıcı adı ya da parola olmasın.';
    return 'Tam bir http:// ya da https:// adresi yaz.';
  }
  if (field === 'keyword') return 'Anahtar kelime denetimi GET ister (HEAD’in gövdesi yok).';
  if (field === 'host') return 'Bir alan adı ya da adres yaz.';
  if (field === 'port') return '1 ile 65535 arasında bir port.';
  if (field === 'pagesProject') return 'Pages proje adı (küçük harf).';
  if (field === 'coolifyUuid') return 'Coolify uygulamasının uuid’i.';
  return message;
}

export function MonitorFormDialog(props: {
  readonly open: boolean;
  /** Editing this monitor (type and project fixed), or null for a new one. */
  readonly monitor: Monitor | null;
  readonly projects: readonly Project[];
  readonly defaultProject: string;
  readonly onSaved: (m: Monitor) => void;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      size="md"
      testId="monitor-form-dialog"
      title={props.monitor === null ? 'Yeni monitör' : 'Monitörü düzenle'}
      description="Kontroller master’dan (tek bölge) çalışır."
    >
      {props.open ? <MonitorFormBody {...props} /> : null}
    </DyDialog>
  );
}

function MonitorFormBody(props: {
  readonly monitor: Monitor | null;
  readonly projects: readonly Project[];
  readonly defaultProject: string;
  readonly onSaved: (m: Monitor) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [f, setF] = useState<MonitorFormState>(() => monitorFormInitial(props.defaultProject, props.monitor));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = useSubmit();
  const editing = props.monitor !== null;
  const set = <K extends keyof MonitorFormState>(k: K, v: MonitorFormState[K]): void => {
    setF((x) => ({ ...x, [k]: v }));
  };
  const provider = f.type === 'pages' || f.type === 'coolify';
  const err = (k: string): string | null => errors[k] ?? null;
  // p13-multi-coolify: which Coolify connection to ask (empty: the master picks the project's target / default).
  const coolifyChoices = useProjectCoolifyConnections(f.project, f.type === 'coolify');

  function onSubmit(e: SubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    const found: Record<string, string> = {};
    for (const [k, v] of Object.entries(validateMonitorForm(f))) found[k] = validationTr(k, v);
    if (!editing && f.project === '') found.project = validationTr('project', '');
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    void submit.run(async () => {
      const schedule = {
        intervalSec: Number(f.intervalSec),
        timeoutMs: Number(f.timeoutMs),
        retries: Number(f.retries),
        paused: f.paused,
      };
      const saved =
        props.monitor === null
          ? await createMonitor({
              project: f.project,
              name: f.name.trim(),
              type: f.type,
              config: monitorConfigOf(f),
              ...schedule,
            })
          : await updateMonitor(props.monitor.id, {
              name: f.name.trim(),
              config: monitorConfigOf(f),
              ...schedule,
            });
      props.onSaved(saved);
    });
  }

  const count = Object.keys(errors).length;
  return (
    <form
      className="grid gap-5"
      onSubmit={onSubmit}
      aria-label={editing ? 'Monitörü düzenle' : 'Yeni monitör'}
      noValidate
    >
      {count > 0 ? (
        <DyNotice tone="red" live>
          {count === 1 ? 'Bir alanı düzeltmen gerekiyor.' : `${String(count)} alanı düzeltmen gerekiyor.`}
        </DyNotice>
      ) : null}
      <DyFieldset legend="Ne kontrol edilsin">
        {editing ? (
          <p className="m-0 text-[0.84375rem] text-dy-muted">
            <span translate="no">{f.project}</span> · {TYPE_WORD[f.type]} (proje ve tür sonradan değişmez)
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <DyChoice
              label="Proje"
              value={f.project}
              error={err('project')}
              options={[
                ...(f.project === '' ? [['', 'Proje seç'] as const] : []),
                ...props.projects.map((p) => [p.id, p.name] as const),
              ]}
              onChange={(v) => {
                set('project', v);
              }}
            />
            <DyChoice
              label="Tür"
              value={f.type}
              options={MONITOR_TYPES.map((t) => [t, TYPE_WORD[t]] as const)}
              onChange={(v) => {
                const t = v as MonitorType;
                setF((x) => ({
                  ...x,
                  type: t,
                  intervalSec:
                    (t === 'pages' || t === 'coolify') && Number(x.intervalSec) < 60 ? '300' : x.intervalSec,
                }));
              }}
            />
          </div>
        )}
        <DyInput
          label="Ad"
          value={f.name}
          maxLength={200}
          error={err('name')}
          onChange={(e) => {
            set('name', e.target.value);
          }}
        />
        {f.type === 'http' ? (
          <>
            <DyInput
              label="URL"
              type="url"
              placeholder="https://ornek.example/health"
              value={f.url}
              maxLength={2048}
              hint="80, 443, 8080 ya da 8443 portunda http:// veya https://. Özel, loopback ve iç adresler reddedilir."
              error={err('url')}
              onChange={(e) => {
                set('url', e.target.value);
              }}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <DyChoice
                label="Yöntem"
                value={f.method}
                options={[
                  ['GET', 'GET'],
                  ['HEAD', 'HEAD'],
                ]}
                onChange={(v) => {
                  set('method', v === 'HEAD' ? 'HEAD' : 'GET');
                }}
              />
              <DyInput
                label="Durum kodu, en az"
                inputMode="numeric"
                value={f.statusMin}
                onChange={(e) => {
                  set('statusMin', e.target.value);
                }}
              />
              <DyInput
                label="Durum kodu, en çok"
                inputMode="numeric"
                value={f.statusMax}
                onChange={(e) => {
                  set('statusMax', e.target.value);
                }}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <DyInput
                label="Anahtar kelime (isteğe bağlı)"
                value={f.keyword}
                maxLength={200}
                hint="Sayfanın ilk 64 KiB’ında aranır (yalnızca GET)."
                error={err('keyword')}
                onChange={(e) => {
                  set('keyword', e.target.value);
                }}
              />
              <DyChoice
                label="Anahtar kelime"
                value={f.keywordMode}
                options={[
                  ['present', 'sayfada olmalı'],
                  ['absent', 'sayfada olmamalı'],
                ]}
                onChange={(v) => {
                  set('keywordMode', v === 'absent' ? 'absent' : 'present');
                }}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <DyInput
                label="En fazla gecikme (ms)"
                inputMode="numeric"
                placeholder="yok"
                value={f.maxLatencyMs}
                onChange={(e) => {
                  set('maxLatencyMs', e.target.value);
                }}
              />
              <DyInput
                label="İzlenecek yönlendirme"
                inputMode="numeric"
                value={f.maxRedirects}
                hint="0–5"
                onChange={(e) => {
                  set('maxRedirects', e.target.value);
                }}
              />
              <DyInput
                label="Sertifika uyarısı (gün)"
                inputMode="numeric"
                value={f.tlsWarnDays}
                hint="0: uyarı yok"
                onChange={(e) => {
                  set('tlsWarnDays', e.target.value);
                }}
              />
            </div>
          </>
        ) : f.type === 'tcp' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <DyInput
              label="Host"
              wrapClassName="sm:col-span-2"
              value={f.host}
              maxLength={253}
              hint="Yalnızca genel adresler."
              error={err('host')}
              onChange={(e) => {
                set('host', e.target.value);
              }}
            />
            <DyInput
              label="Port"
              inputMode="numeric"
              value={f.port}
              error={err('port')}
              onChange={(e) => {
                set('port', e.target.value);
              }}
            />
          </div>
        ) : f.type === 'pages' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <DyInput
              label="Pages projesi"
              value={f.pagesProject}
              maxLength={58}
              hint="Son dağıtımın durumu, master’ın Cloudflare anahtarıyla."
              error={err('pagesProject')}
              onChange={(e) => {
                set('pagesProject', e.target.value);
              }}
            />
            <DyChoice
              label="Ortam"
              value={f.env}
              options={[
                ['production', 'production'],
                ['preview', 'preview'],
              ]}
              onChange={(v) => {
                set('env', v === 'preview' ? 'preview' : 'production');
              }}
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <DyInput
              label="Coolify uygulama uuid’i"
              value={f.coolifyUuid}
              maxLength={64}
              hint="Uygulamanın durumu, master’ın Coolify anahtarıyla."
              error={err('coolifyUuid')}
              onChange={(e) => {
                set('coolifyUuid', e.target.value);
              }}
            />
            <DyChoice
              label="Coolify bağlantısı"
              value={f.coolifyConnection}
              options={coolifyConnectionOptions(
                coolifyChoices,
                f.coolifyConnection,
                'Otomatik (projenin hedefi, yoksa varsayılan)',
                '(bu projeye açık değil)',
              )}
              onChange={(v) => {
                set('coolifyConnection', v);
              }}
            />
          </div>
        )}
      </DyFieldset>
      <DyFieldset legend="Ne sıklıkla">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <DyInput
            label="Kontrol aralığı (sn)"
            inputMode="numeric"
            value={f.intervalSec}
            hint={provider ? 'Sağlayıcı kontrollerinde en az 60 sn.' : 'En az 30 sn.'}
            error={err('intervalSec')}
            onChange={(e) => {
              set('intervalSec', e.target.value);
            }}
          />
          <DyInput
            label="Zaman aşımı (ms)"
            inputMode="numeric"
            value={f.timeoutMs}
            hint="1000–30000"
            onChange={(e) => {
              set('timeoutMs', e.target.value);
            }}
          />
          <DyInput
            label="Kapalı saymadan önce hata"
            inputMode="numeric"
            value={f.retries}
            hint="Üst üste tolere edilen hatalı kontrol (0–10)."
            onChange={(e) => {
              set('retries', e.target.value);
            }}
          />
        </div>
        <DyCheck
          label="Duraklatılmış"
          hint="Duraklatılmış monitör kontrol edilmez ve bildirim göndermez."
          checked={f.paused}
          onChange={(v) => {
            set('paused', v);
          }}
        />
      </DyFieldset>
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <DyButton variant="ghost" onClick={props.onClose}>
          Vazgeç
        </DyButton>
        <DyButton type="submit" variant="primary" busy={submit.busy} disabled={submit.blocked}>
          {editing ? 'Kaydet' : 'Monitörü oluştur'}
        </DyButton>
      </div>
    </form>
  );
}
