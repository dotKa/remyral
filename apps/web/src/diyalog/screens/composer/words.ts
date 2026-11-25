import type { PlacementPreview } from '../../../api/composer';
import { PRIORITY_CLASS_VALUE, priorityClassOf } from '../../../api/queue';
import { runtimeName } from '../../../lib/reasons';
import type { Draft } from '../../../screens/composer/draft';
import { APPROVAL_TR, CLASS_TR, SANDBOX_TR } from '../../compose/labels';
import { TR_FORMAT } from '../../common/time';

/**
 * p12-diyalog-w1: the composer's words in Turkish. The validation itself is the classic one (`screens/composer/
 * draft.ts`, the master validates again); only what the person reads is translated here. Unknown messages (a newer
 * rule) are shown as they are — never dropped.
 */

const EXACT: Readonly<Record<string, string>> = {
  'Choose a project.': 'Bir proje seç.',
  'Describe the task.': 'Ajanın ne yapacağını yaz.',
  'The prompt is larger than 256 KiB.': 'İstem 256 KiB’den büyük.',
  'Choose a runtime.': 'Bir runtime seç.',
  'Choose a workflow.': 'Bir iş akışı seç.',
  'Required.': 'Gerekli.',
  'Enter the repository URL.': 'Depo adresini yaz.',
  'Use the ssh:// form (ssh://git@host/owner/repo.git); scp-style addresses are not accepted.':
    'ssh:// biçimini kullan (ssh://git@host/sahip/depo.git); scp biçimli adres kabul edilmez.',
  'Enter a full https:// or ssh:// URL.': 'Tam bir https:// ya da ssh:// adresi yaz.',
  'Only https:// and ssh:// repositories.': 'Yalnızca https:// ve ssh:// depolar.',
  'Enter the base branch.': 'Temel dalı yaz.',
  'The base branch is longer than 255 characters.': 'Temel dal 255 karakterden uzun.',
  'The base branch is not a valid git ref name.': 'Temel dal geçerli bir git dal adı değil.',
  'Enter the work branch.': 'Çalışma dalını yaz.',
  'The work branch is longer than 255 characters.': 'Çalışma dalı 255 karakterden uzun.',
  'The work branch is not a valid git ref name.': 'Çalışma dalı geçerli bir git dal adı değil.',
  'Enter a job id (a UUID such as 3f2b…-…), or leave it empty.':
    'Bir iş kimliği yaz (3f2b…-… gibi bir UUID) ya da boş bırak.',
  'At most 64 characters.': 'En çok 64 karakter.',
  'At most 128 characters.': 'En çok 128 karakter.',
  'At most 200 characters.': 'En çok 200 karakter.',
  'At most 3 fallback runtimes.': 'En çok 3 yedek runtime.',
  'A fallback must differ from the runtime.': 'Yedek runtime, seçilen runtime’dan farklı olmalı.',
  'Untrusted source runs only in the container profile.': 'Güvenilmeyen kaynak yalnızca konteynerde çalışır.',
  '“Never ask” is only for trusted sources.': '“Hiç sorma” yalnızca güvenilen kaynak için.',
  'At most 16 tools.': 'En çok 16 araç.',
  'Tool names: letters, digits, . _ + - only.': 'Araç adları: yalnızca harf, rakam ve . _ + -',
  'At most 16 workers.': 'En çok 16 makine.',
  'Set a maximum duration.': 'Bir en uzun süre gir.',
  'Max cost must be a non-negative amount.': 'En yüksek maliyet negatif olamaz.',
  'Priority is a whole number from -100 to 100.': 'Öncelik -100 ile 100 arasında bir tam sayı.',
  'Name the schedule.': 'Zamanlamaya bir ad ver.',
  'Choose a date and time.': 'Bir tarih ve saat seç.',
  'Choose a time in the future.': 'İleride bir zaman seç.',
  'Five fields: minute hour day-of-month month day-of-week (UTC).':
    'Beş alan: dakika saat ayın-günü ay haftanın-günü (UTC).',
  'A relative directory such as site or dist.': 'site ya da dist gibi göreli bir klasör.',
  'A port between 1024 and 65535.': '1024 ile 65535 arasında bir port.',
  'A stable preview needs a name.': 'Sabit önizlemenin bir adı olmalı.',
  '1–20 lower-case letters, digits and hyphens.': '1–20 küçük harf, rakam ve tire.',
  'Choose a Pages project (or a new one).': 'Bir Pages projesi seç (ya da yeni bir tane).',
  'New Pages project name: 1–58 lowercase letters, digits and hyphens, starting and ending with a letter or digit.':
    'Yeni Pages proje adı: 1–58 küçük harf, rakam ve tire; harf ya da rakamla başlayıp biter.',
  'The custom domain is not a valid host name.': 'Özel alan adı geçerli bir ana makine adı değil.',
};

const FIELD_TR: Readonly<Record<string, string>> = {
  'Max duration': 'En uzun süre',
  'Max tokens': 'En çok token',
  'Max turns': 'En çok tur',
};

/** A classic validation message in Turkish (the original when there is no translation). */
export function trError(msg: string): string {
  const exact = EXACT[msg];
  if (exact !== undefined) return exact;
  const m = /^(Max duration|Max tokens|Max turns) must be (a whole number|at least 1|at most (\d+))\.$/.exec(
    msg,
  );
  if (m !== null) {
    const f = FIELD_TR[m[1] ?? ''] ?? m[1] ?? '';
    if (m[2] === 'a whole number') return `${f} bir tam sayı olmalı.`;
    if (m[2] === 'at least 1') return `${f} en az 1 olmalı.`;
    return `${f} en çok ${m[3] ?? ''} olabilir.`;
  }
  return msg;
}

/** What a missing field is called in the footer's "Eksik:" line. */
export const NEEDED_TR: Readonly<Record<string, string>> = {
  project: 'proje',
  prompt: 'görev',
  runtime: 'runtime',
  workflowId: 'iş akışı',
  repoUrl: 'depo',
  baseRef: 'temel dal',
  model: 'model profili',
  scheduleName: 'zamanlama adı',
  at: 'zaman',
};

export const VERDICT_TR: Readonly<
  Record<string, { readonly tone: 'green' | 'amber' | 'red'; readonly label: string; readonly text: string }>
> = {
  placed: { tone: 'green', label: 'Hemen başlar', text: 'Gönderdiğin anda bir makine bu işi alabilir.' },
  waiting: {
    tone: 'amber',
    label: 'Bekleyecek',
    text: 'Makineler çalıştırabilir ama şu an boşta ya da çevrimiçi olan yok; iş kuyrukta bekler.',
  },
  held: {
    tone: 'amber',
    label: 'Tutuluyor',
    text: 'Kotalar bu projenin ya da runtime’ın yeni işlerini şu an tutuyor; izin verince başlar.',
  },
  infeasible: {
    tone: 'red',
    label: 'Hiçbir makine çalıştıramaz',
    text: 'Her makine dışarıda kaldı. Aşağıdaki sebeplerden birini düzelt; yoksa iş gönderildiği anda başarısız olur.',
  },
};

export const OS_TR: Readonly<Record<string, string>> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

export const ROLE_TR: Readonly<Record<string, string>> = {
  plan: 'Plan',
  execute: 'Uygulama',
  verify: 'Doğrulama / inceleme',
  summarise: 'Özet',
  research: 'Araştırma',
  chore: 'Rutin iş',
};

/** Turkish sandbox name (falls back to the API value). */
export function sandboxTr(p: string): string {
  return SANDBOX_TR[p]?.label ?? p;
}

function list(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' ya da ');
  return `${names.slice(0, -1).join(', ')} ya da ${names.at(-1) ?? ''}`;
}

/** The model the job will use, in a few words. */
export function modelSummaryTr(draft: Draft, preview: PlacementPreview | null): string {
  if (draft.model !== '') {
    const p = preview?.modelProfiles.find((m) => m.value === draft.model || m.name === draft.model);
    return p?.displayName ?? p?.name ?? draft.model;
  }
  const r = preview?.model?.runtime === draft.runtime ? preview.model : null;
  if (r?.defaultProfile != null) return r.defaultProfile;
  return 'kendi modeli';
}

/** "Codex · Sonnet (OpenRouter) · Konteyner, herhangi bir makinede" — the collapsed "Nerede". */
export function whereSummaryTr(draft: Draft, preview: PlacementPreview | null): string {
  const names = new Map((preview?.workers ?? []).map((w) => [w.id, w.name]));
  const os = draft.os.length > 0 ? `${draft.os.map((o) => OS_TR[o] ?? o).join('/')} ` : '';
  const arch = draft.arch.length > 0 ? `${draft.arch.join('/')} ` : '';
  const machines =
    draft.workers.length > 0
      ? list(draft.workers.map((w) => names.get(w) ?? w))
      : `herhangi bir ${os}${arch}makinede`;
  const runtime =
    draft.runtime === ''
      ? 'Runtime seçilmedi'
      : draft.runtime === 'auto'
        ? 'Otomatik (sonuç geçmişine göre)'
        : runtimeName(draft.runtime);
  const parts = [runtime];
  if (draft.runtime !== '' && draft.runtime !== 'auto') parts.push(modelSummaryTr(draft, preview));
  parts.push(`${sandboxTr(draft.sandboxProfile)}, ${machines}`);
  return parts.join(' · ');
}

function whenTr(draft: Draft): string {
  if (draft.when === 'at') {
    const t = Date.parse(draft.at);
    return Number.isNaN(t) ? 'bir kez, belirli bir zamanda' : `bir kez, ${TR_FORMAT.dateTime(t)}`;
  }
  if (draft.when === 'cron') return `tekrar: ${draft.cron.trim()} (UTC)`;
  return 'hemen başlar';
}

/** "Hassas adımlarda sor · 60 dk · en çok $5 · Acil · hemen başlar" — the collapsed "Kurallar". */
export function rulesSummaryTr(draft: Draft): string {
  const cap = (s: string): string => `${s.charAt(0).toLocaleUpperCase('tr-TR')}${s.slice(1)}`;
  if (draft.mode === 'workflow') {
    const pn = Number(draft.priority.trim());
    const parts = [cap(whenTr(draft))];
    if (Number.isFinite(pn) && pn !== 0) parts.unshift(CLASS_TR[priorityClassOf(pn)]);
    return parts.join(' · ');
  }
  const parts = [
    APPROVAL_TR[draft.approvalPolicy]?.label ?? draft.approvalPolicy,
    `${draft.maxDurationMin} dk`,
  ];
  if (draft.maxCostUsd.trim() !== '') parts.push(`en çok $${draft.maxCostUsd.trim()}`);
  if (draft.maxTokens.trim() !== '') parts.push(`${TR_FORMAT.number(Number(draft.maxTokens))} token`);
  if (draft.maxTurns.trim() !== '') parts.push(`${draft.maxTurns.trim()} tur`);
  const pn = Number(draft.priority.trim());
  if (Number.isFinite(pn) && pn !== 0) {
    const cls = priorityClassOf(pn);
    parts.push(
      pn === PRIORITY_CLASS_VALUE[cls]
        ? CLASS_TR[cls]
        : `${CLASS_TR[cls]} (öncelik ${draft.priority.trim()})`,
    );
  }
  parts.push(whenTr(draft));
  return parts.join(' · ');
}
