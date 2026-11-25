import type { StepOutcome } from '@remyral/protocol';
import { messagesFor } from '@remyral/i18n/all';
import type { OutputReportView } from '../workspaces/output-limits.js';
import { plainLine } from './flow-model.js';
import { mdText, type WatchLanguage } from './watches.js';

/**
 * p18-outputs-delivery (docs/design/p18-outputs-delivery.md §3–4): the words of a job's outcome in a conversation —
 * the note's short line (state, title, the reason in plain words), the zipped-delivery line from the output report,
 * and the notification. The console draws the job result card under the note from fresh data (`meta.jobId`).
 */

export type JobOutcome = 'succeeded' | 'failed' | 'cancelled';

/** The terminal transition a result card announces. */
export interface JobEnd {
  readonly jobId: string;
  readonly transitionId: string;
  readonly state: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'LOST';
  readonly fromState: string | null;
  readonly trigger: string;
  /** Attempts the job had (0: it never reached a machine). */
  readonly attempts: number;
  /** p18-project-bootstrap: the transition's reason (the worker's error text; null / absent: none). */
  readonly reason?: string | null;
  /** p20-job-clock: it stopped on its time limit (the card offers "Aynı yerden devam et"). */
  readonly timedOut?: boolean;
  /** p22-run-attention: a succeeded job whose agent said it could not (fully) do the task (absent / null: none). */
  readonly attention?: StepOutcome | null;
  /** p22-timeout-continuity: the unfinished work its worker kept when the time ran out (absent: none). */
  readonly kept?: {
    readonly files: number;
    readonly branch: string;
    readonly pushed: boolean;
    readonly workerId?: string;
  } | null;
}

/** p18-project-bootstrap: the worker's BaseRefNotFoundError text (`… (the repository is empty …` from newer workers). */
const BASE_REF_MISSING =
  /base ref "([^"\n]{1,255})" was not found in the repository( \(the repository is empty)?/;

/**
 * p18-project-bootstrap: the repair hint of a job whose base branch was missing — an empty repository (the machine's
 * Remyral is too old to start one: newer workers create the base branch's first commit themselves) or a branch that a
 * non-empty repository does not have (pick an existing one).
 */
export function baseRefHint(reason: string | null | undefined, lang: WatchLanguage): string | null {
  const m = BASE_REF_MISSING.exec(reason ?? '');
  if (m === null) return null;
  const ref = plainLine(m[1] ?? '', 80);
  const tr = lang === 'tr';
  if (m[2] !== undefined)
    return tr
      ? `repo boş ("${ref}" dalı henüz yok) ve bu iş türü boş repoda başlayamıyor — önce normal bir iş çalıştırın (ilk iş ana dalı oluşturur)`
      : `the repository is empty (no "${ref}" branch yet) and this kind of job cannot start an empty repository — run an ordinary job first (the first job creates the base branch)`;
  return tr
    ? `"${ref}" dalı repoda yok — repo boşsa makinenin Remyral sürümünü güncelleyin (yeni sürüm ilk işte ana dalı oluşturur); değilse var olan bir dal seçin`
    : `the branch "${ref}" is not in the repository — if the repository is empty, update the machine's Remyral (newer versions create the base branch on the first job); otherwise pick an existing branch`;
}

/**
 * p22-git-preflight: the repair hint of a job the repository access preflight failed before dispatch (the transition
 * reason starts with its code; `why` in parentheses). Null for any other reason.
 */
export function repoAccessHint(reason: string | null | undefined, lang: WatchLanguage): string | null {
  const m = /^(repo_credentials_missing|repo_access_denied): /.exec(reason ?? '');
  if (m === null) return null;
  const tr = lang === 'tr';
  const text = reason ?? '';
  if (m[1] === 'repo_access_denied') {
    return /not installed|HTTP 40[4]|HTTP 422/.test(text)
      ? tr
        ? 'projenin Git bağlantısı bu repoyu göremiyor — GitHub uygulamasının kurulumuna bu repoyu ekleyin (Ayarlar → Entegrasyonlar → GitHub) ya da projenin repo adresini düzeltin; iş hiçbir makinede başlatılmadı'
        : 'the project’s git connection cannot see this repository — add the repository to the GitHub App installation (Settings → Integrations → GitHub) or correct the project’s repository URL; the job was not started on any machine'
      : tr
        ? 'projenin Git bağlantısı bu repoya erişemiyor (bağlantının izni ya da token’ı geçersiz/süresi dolmuş) — Ayarlar → Entegrasyonlar’da bağlantıyı yenileyin; iş hiçbir makinede başlatılmadı'
        : 'the project’s git connection was refused for this repository (its permission or token is invalid or expired) — reconnect it in Settings → Integrations; the job was not started on any machine';
  }
  if (/\(untrusted source\)/.test(text)) {
    return tr
      ? 'repo özel ve bu iş güvenilmeyen bir kaynaktan geldiği için ona Git kimlik bilgisi verilmez — işi güvenilir kaynakla başlatın; iş hiçbir makinede başlatılmadı'
      : 'the repository is private and this job comes from an untrusted source, which gets no git credential — start it from a trusted source; the job was not started on any machine';
  }
  if (/\(other repository\)/.test(text)) {
    return tr
      ? 'repo özel ve projenin Git bağlantısı başka bir repo için ayarlı — projenin Git ayarındaki repo adresini bu repo yapın ya da işi doğru projede başlatın; iş hiçbir makinede başlatılmadı'
      : 'the repository is private and the project’s git connection is set up for another repository — point the project’s git settings at this repository or start the job in the right project; the job was not started on any machine';
  }
  return tr
    ? 'repo özel (ya da yok) ve bu proje için bir Git bağlantısı yok — GitHub’ı bağlayın (Ayarlar → Entegrasyonlar → GitHub) ve projenin Git ayarında bu repoyu seçin, ya da projeye bir repo kimlik bilgisi ekleyin; iş hiçbir makinede başlatılmadı'
    : 'the repository is private (or does not exist) and the project has no git connection for it — connect GitHub (Settings → Integrations → GitHub) and pick this repository in the project’s git settings, or add a repository credential to the project; the job was not started on any machine';
}

export function outcomeOf(state: JobEnd['state']): JobOutcome {
  return state === 'SUCCEEDED' ? 'succeeded' : state === 'CANCELLED' ? 'cancelled' : 'failed';
}

/** Why it ended, in plain words of the reader's language (null: nothing to add). Never the raw (English) reason. */
export function reasonWords(end: JobEnd, lang: WatchLanguage): string | null {
  const tr = lang === 'tr';
  if (end.state === 'SUCCEEDED' && end.attention != null) return attentionWords(end.attention, lang);
  if (end.timedOut === true && (end.state === 'FAILED' || end.state === 'CANCELLED')) {
    const k = end.kept ?? null;
    if (k !== null) {
      const where = plainLine(k.branch, 120);
      return tr
        ? `süre sınırı doldu (insan beklemeleri sayılmadan) — yapılan iş kaybolmadı: ${String(k.files)} dosyalık değişiklik ${k.pushed ? `${where} dalına gönderildi` : 'yalnızca o makinede saklandı'} (birleştirilmedi). “Aynı yerden devam et” bu işten devam eder`
        : `its time limit ran out (human waits not counted) — the work was not lost: ${String(k.files)} changed file(s) ${k.pushed ? `pushed to ${where}` : 'kept on that machine only'} (not merged). "Continue where it stopped" carries on from that work`;
    }
    return tr
      ? 'süre sınırı doldu (insan beklemeleri sayılmadan) — “Aynı yerden devam et” ile kaldığı yerden daha uzun bir süreyle sürdürülebilir'
      : 'its time limit ran out (human waits not counted) — "Continue where it stopped" carries on from there with a longer limit';
  }
  if (end.state === 'LOST') {
    return tr
      ? 'çalıştığı makine yanıt vermeyi bıraktı (iş kayboldu)'
      : 'its machine stopped answering (the job was lost)';
  }
  if (end.state === 'CANCELLED') {
    return end.attempts === 0 ? (tr ? 'başlamadan iptal edildi' : 'cancelled before it started') : null;
  }
  if (end.state !== 'FAILED') return null;
  switch (end.trigger) {
    case 'infeasible':
      return (
        repoAccessHint(end.reason, lang) ??
        (tr ? 'bu işi çalıştırabilecek uygun bir makine yok' : 'no machine can run this job')
      );
    case 'dependency_failed':
      return tr ? 'bağlı olduğu iş başarısız oldu' : 'a job it depends on failed';
    case 'verification_failed':
      // p22-git-preflight: the work no longer sits on the base it started from and the platform could not rebase it.
      if (/is not a descendant of the base at job start/.test(end.reason ?? ''))
        return tr
          ? 'iş, başladığı temel daldan ayrıştı ve otomatik olarak üzerine taşınamadı — işi güncel temel üzerinde yeniden çalıştırın'
          : 'the work no longer sits on the base it started from and could not be moved onto it automatically — run the job again on the current base';
      return tr ? 'sonucu doğrulanamadı' : 'its result did not pass verification';
    case 'approval_denied':
      return tr ? 'sonucu reddedildi' : 'its result was rejected';
    case 'reconcile_fail':
      return tr
        ? 'makineyle bağlantı koptu ve kurtarılamadı'
        : 'the machine was lost and could not be recovered';
    case 'attempt_failed':
      return (
        baseRefHint(end.reason, lang) ??
        (end.fromState === 'STARTING'
          ? tr
            ? 'makinede hazırlık başarısız oldu'
            : 'setting it up on the machine failed'
          : tr
            ? 'çalışırken hata verdi ya da sınırlarını aştı'
            : 'it failed while running or exceeded its limits')
      );
    default:
      return tr ? 'başarısız oldu' : 'it failed';
  }
}

const HEAD: Record<WatchLanguage, Record<JobOutcome | 'notStarted', string>> = {
  tr: {
    succeeded: 'İş bitti',
    failed: 'İş başarısız oldu',
    cancelled: 'İş iptal edildi',
    notStarted: 'İş başlatılamadı',
  },
  en: {
    succeeded: 'Job finished',
    failed: 'Job failed',
    cancelled: 'Job cancelled',
    notStarted: 'Job could not start',
  },
};

/** p22-run-attention: what the agent said it could not do, in plain words. */
export function attentionWords(a: StepOutcome, lang: WatchLanguage): string {
  const what =
    lang === 'tr'
      ? a.kind === 'none'
        ? 'ajan işi yapamadığını söyledi'
        : 'ajan işin bir kısmını yapamadığını söyledi'
      : a.kind === 'none'
        ? 'the agent said it could not do the task'
        : 'the agent said it left part of the task undone';
  return a.note === '' ? what : `${what}: ${plainLine(a.note, 300)}`;
}

function head(end: JobEnd, lang: WatchLanguage): string {
  if (end.state === 'SUCCEEDED' && end.attention != null)
    return lang === 'tr' ? 'İş bitti ama dikkat istiyor' : 'Job finished but needs attention';
  const outcome = outcomeOf(end.state);
  return outcome === 'failed' && end.attempts === 0 ? HEAD[lang].notStarted : HEAD[lang][outcome];
}

/**
 * The zipped-delivery line ("600 dosya üretildi: 499’u tek tek, 101’i out-rest.zip içinde (iş başına 500 dosya
 * sınırı).") — null when no overflow zip was made.
 */
export function deliveredLine(report: OutputReportView | null, lang: WatchLanguage): string | null {
  if (report?.zip == null || report.returned === null) return null;
  const single = Math.max(0, report.returned - 1);
  return messagesFor(lang).jobDetail.files.report.delivered({
    total: single + report.zip.files,
    single,
    zipped: report.zip.files,
    name: report.zip.name,
    max: report.maxFiles ?? report.returned,
  });
}

/** The note's text (Markdown-safe: the title and names escaped; no links — the card has them). */
export function jobResultText(
  end: JobEnd,
  title: string,
  report: OutputReportView | null,
  lang: WatchLanguage,
): string {
  const reason = reasonWords(end, lang);
  const delivered = deliveredLine(report, lang);
  const line = `**${head(end, lang)}:** ${mdText(plainLine(title, 120))}${reason === null ? '' : ` — ${reason}`}.`;
  return delivered === null ? line : `${line}\n\n${mdText(delivered)}`;
}

/** The notification (plain text) for the conversation's owner. */
export function jobResultNotification(
  end: JobEnd,
  title: string,
  report: OutputReportView | null,
  lang: WatchLanguage,
): { title: string; body: string; severity: 'info' | 'warning' } {
  const reason = reasonWords(end, lang);
  const delivered = deliveredLine(report, lang);
  const t = plainLine(title, 120);
  return {
    title: plainLine(`${head(end, lang)}: ${t}`, 200),
    body: plainLine(
      [reason === null ? `${t}.` : `${t} — ${reason}.`, delivered ?? ''].filter((s) => s !== '').join(' '),
      1000,
    ),
    severity: outcomeOf(end.state) === 'succeeded' && end.attention == null ? 'info' : 'warning',
  };
}
