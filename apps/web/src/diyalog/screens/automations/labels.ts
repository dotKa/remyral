import type { AutomationRun, RunState } from '../../../api/automations';
import type { IconName } from '../../icons';
import type { Tone } from '../../tone';
import { TR_FORMAT } from '../../common/time';
import type { Formatter } from '@remyral/i18n';

/**
 * p12-diyalog-w2: the Diyalog words for automations (states, triggers, policies, run events) and the Turkish form of
 * the classic validation sentences. API values and the rules themselves stay in the classic modules; only what the
 * person reads is Turkish. Untrusted event text is interpolated as text only.
 */

export interface StateWord {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: IconName;
}

export const RUN_TR: Readonly<Record<RunState, StateWord>> = {
  queued: { label: 'Kuyrukta', tone: 'neutral', icon: 'clock' },
  starting: { label: 'Başlıyor', tone: 'teal', icon: 'clock' },
  running: { label: 'Çalışıyor', tone: 'teal', icon: 'retry' },
  succeeded: { label: 'Başarılı', tone: 'green', icon: 'checkc' },
  failed: { label: 'Başarısız', tone: 'red', icon: 'xc' },
  cancelled: { label: 'İptal edildi', tone: 'neutral', icon: 'xc' },
  skipped: { label: 'Atlandı', tone: 'neutral', icon: 'chev' },
  error: { label: 'Başlatılamadı', tone: 'red', icon: 'xc' },
};

export const AUTOMATION_TR: Readonly<Record<string, StateWord>> = {
  active: { label: 'Açık', tone: 'green', icon: 'checkc' },
  paused: { label: 'Duraklatıldı', tone: 'neutral', icon: 'pause' },
  done: { label: 'Bitti', tone: 'neutral', icon: 'check' },
  failed: { label: 'Durduruldu', tone: 'red', icon: 'xc' },
  deleted: { label: 'Silindi', tone: 'neutral', icon: 'trash' },
};

export function automationWord(state: string): StateWord {
  return AUTOMATION_TR[state] ?? { label: state, tone: 'neutral', icon: 'more' };
}

export const TRIGGER_TR: Readonly<Record<string, string>> = {
  cron: 'Zamanlama',
  at: 'Bir kez',
  github: 'GitHub',
  webhook: 'Webhook',
  chain: 'Başka otomasyondan sonra',
  manual: 'Elle (şimdi çalıştır)',
};

export const TRIGGER_ICON: Readonly<Record<string, IconName>> = {
  cron: 'clock',
  at: 'flag',
  github: 'branch',
  webhook: 'globe',
  chain: 'merge',
  manual: 'send',
};

export const TRIGGER_HINT_TR: Readonly<Record<string, string>> = {
  cron: 'Bir takvime göre tekrarlar (UTC).',
  at: 'Seçtiğin bir zamanda bir kez çalışır.',
  github: 'Bir GitHub deposunda pull request, push, issue ya da yorum komutu (proje yöneticileri).',
  webhook: 'Başka bir sistem imzalı bir URL’yi çağırır (proje yöneticileri).',
  chain: 'Başka bir otomasyon bitince başlar (bu projeden; yöneticiler başka proje seçebilir).',
};

export const CRON_PRESET_TR: Readonly<Record<string, string>> = {
  hourly: 'Her saat',
  daily: 'Her gün 03:00',
  weekdays: 'Hafta içi 09:00',
  weekly: 'Pazartesi 08:00',
};

export const CONCURRENCY_TR: Readonly<Record<string, string>> = {
  skip: 'Önceki hala çalışıyorsa atla',
  queue: 'Sıraya al, birbiri ardına çalıştır',
  parallel: 'Paralel çalıştır (en çok 5)',
};

export const CATCH_UP_TR: Readonly<Record<string, string>> = {
  skip: 'Kaçırılan zamanları atla',
  once: 'Kaçırılanların hepsi için bir kez çalıştır',
  all: 'Kaçırılan her zaman için çalıştır (en çok 10)',
};

export const OUTCOME_TR: Readonly<Record<string, string>> = {
  succeeded: 'başarılı olunca',
  failed: 'başarısız olunca',
  cancelled: 'iptal edilince',
};

export function percentText(rate: number | null): string {
  return rate === null ? '—' : `%${String(Math.round(rate * 100))}`;
}

/** "31 Ekim 03:00" style absolute time in Turkish. */
export function whenText(iso: string | null, f: Formatter = TR_FORMAT): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return f.dateWith(d, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

/** In "x dk sonra" form for a future time (falls back to the absolute time). */
export function untilText(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const m = Math.round((t - now) / 60_000);
  if (m < 0) return whenText(iso);
  if (m < 1) return 'birazdan';
  if (m < 60) return `${String(m)} dk sonra`;
  const h = Math.round(m / 60);
  if (h < 36) return `${String(h)} sa sonra`;
  return whenText(iso);
}

export function timeoutTr(minutes: number | null): string {
  if (minutes === null) return 'Zaman aşımı yok: çalıştırma onayın kendisi bitene kadar bekler.';
  const t = minutes % 60 === 0 ? `${String(minutes / 60)} saat` : `${String(minutes)} dakika`;
  return `${t} içinde kimsenin onaylamadığı çalıştırma iptal edilir.`;
}

/** One line describing the event of a run (untrusted text, rendered as text by the caller). */
export function eventLineTr(run: AutomationRun): string {
  const e = run.eventSummary;
  if (e === null) return TRIGGER_TR[run.triggerKind] ?? run.triggerKind;
  const s = (k: string): string => (typeof e[k] === 'string' || typeof e[k] === 'number' ? String(e[k]) : '');
  switch (run.triggerKind) {
    case 'github': {
      const head = [s('event'), s('action')].filter(Boolean).join(' ');
      const num = s('number') === '' ? '' : ` #${s('number')}`;
      const title = s('title') === '' ? '' : ` “${s('title')}”`;
      const branch = s('branch') === '' ? '' : ` (${s('branch')})`;
      const actor = s('actor') === '' ? '' : ` · ${s('actor')}`;
      return `${head}${num}${title}${branch}${actor}`;
    }
    case 'webhook':
      return `Webhook çağrısı (${s('bytes')} bayt)${
        s('signedWith') === 'previous' ? ', önceki sırla imzalı' : ''
      }`;
    case 'chain':
      return `“${s('source')}” ${OUTCOME_TR[s('outcome')] ?? s('outcome')}`;
    case 'cron':
    case 'at':
      return typeof e.missed === 'number' ? `${String(e.missed)} kez kaçırıldı` : 'Planlanan zaman';
    default:
      return TRIGGER_TR[run.triggerKind] ?? run.triggerKind;
  }
}

export function durationTr(run: AutomationRun, now: number = Date.now()): string {
  if (run.startedAt === null) return '—';
  const end = run.finishedAt === null ? now : Date.parse(run.finishedAt);
  const s = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  if (s < 60) return `${String(s)} sn`;
  if (s < 3600) return `${String(Math.floor(s / 60))} dk`;
  return `${String(Math.floor(s / 3600))} sa ${String(Math.floor((s % 3600) / 60))} dk`;
}

/** The classic validation sentences (screens/automations, composer/deploy) in Turkish; unknown ones as they are. */
const ERR_TR: Readonly<Record<string, string>> = {
  'Choose a project.': 'Bir proje seç.',
  'Give it a name.': 'Bir ad ver.',
  'Five fields: minute hour day month weekday.': 'Beş alan: dakika saat gün ay haftanın-günü.',
  'Choose a date and time.': 'Bir tarih ve saat seç.',
  'owner/name, e.g. acme/app.': 'sahip/ad, örneğin acme/app.',
  'Choose at least one.': 'En az birini seç.',
  'Addresses or CIDRs, e.g. 203.0.113.7, 198.51.100.0/24.':
    'Adres ya da CIDR, örneğin 203.0.113.7, 198.51.100.0/24.',
  'Choose the automation it follows.': 'Hangi otomasyondan sonra başlayacağını seç.',
  'Choose at least one outcome.': 'En az bir sonuç seç.',
  'Say what the agent should do.': 'Ajanın ne yapacağını yaz.',
  'Choose a workflow.': 'Bir iş akışı seç.',
  'A deploy does not check anything out; use the default checkout.':
    'Deploy hiçbir şeyi checkout etmez; varsayılan checkout’u kullan.',
  '1 to 120.': '1 ile 120 arası.',
  '5 to 1440 minutes.': '5 ile 1440 dakika arası.',
  '1 to 168 hours.': '1 ile 168 saat arası.',
  'A relative directory such as site or dist.': 'site ya da dist gibi göreli bir klasör.',
  'Enter a job id (a UUID such as 3f2b…-…).': 'Bir iş kimliği gir (3f2b…-… gibi bir UUID).',
  '“Its last run” is for job automations.': '“Son çalıştırmasından” yalnızca iş otomasyonları için.',
  '“The run that triggered it” needs the “After another automation” trigger.':
    '“Onu başlatan çalıştırmadan” için tetik “Başka otomasyondan sonra” olmalı.',
  'Choose a Pages project (or a new one).': 'Bir Pages projesi seç (ya da yeni bir tane).',
  'The custom domain is not a valid host name.': 'Özel alan adı geçerli bir ana makine adı değil.',
};

export function errTr(msg: string | undefined | null): string | null {
  if (msg === undefined || msg === null) return null;
  return ERR_TR[msg] ?? msg;
}
