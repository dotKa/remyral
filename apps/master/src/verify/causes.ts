import { classifyFailure } from '../self-heal/classify.js';

/**
 * p19-verifier-jobs (docs/design/p19-verifier-jobs.md §3): why a job's verification could not run (state `error`,
 * "Doğrulanamadı") as a short cause id (`job_verifications.error_cause`). The verifier job's own failure is classified
 * with the self-heal rules (codes and fixed patterns only — the failure text is untrusted and never echoed); the master's
 * own reasons have ids of their own. The console says each in the reader's language (`verify.causes`); the notification
 * says it in Turkish (the console's default language) with {@link causeText}.
 */

export const UNVERIFIABLE_CAUSES = [
  'git_auth',
  'git_network',
  'timeout',
  'runtime_crash',
  'login',
  'disk_low',
  'provider_error',
  'machine_lost',
  'cancelled',
  'not_started',
  'no_report',
  'verifier_missing',
  'run_failed',
] as const;
export type UnverifiableCause = (typeof UNVERIFIABLE_CAUSES)[number];

/** The cause of a verifier job that ended without a report (FAILED / CANCELLED / LOST). */
export function verifierFailureCause(
  verifierState: string,
  failure: { readonly code: string | null; readonly message: string } | null,
): UnverifiableCause {
  if (verifierState === 'CANCELLED') return 'cancelled';
  if (verifierState === 'LOST') return 'machine_lost';
  if (failure === null) return 'run_failed';
  const v = classifyFailure({ code: failure.code, message: failure.message, phase: 'run' });
  switch (v.cause) {
    case 'git_auth':
    case 'git_network':
    case 'timeout':
    case 'runtime_crash':
    case 'login':
    case 'disk_low':
    case 'provider_error':
    case 'cancelled':
      return v.cause;
    case 'worker_restart':
    case 'lease_lost':
      return 'machine_lost';
    default:
      return 'run_failed';
  }
}

/** The worker error code at the start of a transition reason (`<code>: <message>`), if any. */
export function reasonCode(reason: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9_]{1,63}): /.exec(reason);
  return m?.[1] ?? null;
}

const HOST_NAME: Readonly<Record<string, string>> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
};

/** The cause in plain Turkish words ("repo okunamadı (GitHub kimlik bilgisi yok)"); `provider`: the project's git host. */
export function causeText(cause: string | null, provider: string | null): string {
  const host = HOST_NAME[provider ?? ''] ?? 'git';
  switch (cause) {
    case 'git_auth':
      return `repo okunamadı (${host} kimlik bilgisi yok)`;
    case 'git_network':
      return 'repoya ulaşılamadı (ağ hatası)';
    case 'timeout':
      return 'doğrulayıcı süre sınırını aştı';
    case 'runtime_crash':
      return 'ajanın runtime’ı çöktü';
    case 'login':
      return 'runtime’ın oturumu sona ermiş';
    case 'disk_low':
      return 'makinede yeterli disk alanı yok';
    case 'provider_error':
      return 'model sağlayıcısı hata verdi';
    case 'machine_lost':
      return 'doğrulayıcının makinesiyle bağlantı koptu';
    case 'cancelled':
      return 'doğrulayıcı iş iptal edildi';
    case 'not_started':
      return 'doğrulayıcı iş başlatılamadı';
    case 'no_report':
      return 'doğrulayıcı geçerli bir rapor üretmedi';
    case 'verifier_missing':
      return 'doğrulayıcı iş artık yok';
    default:
      return 'doğrulayıcı iş hata ile bitti';
  }
}
