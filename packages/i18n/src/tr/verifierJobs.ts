/**
 * p19-verifier-jobs (docs/design/p19-verifier-jobs.md): platform verifier jobs — the "Doğrulama" badge, their title
 * from the checked job, the outcome of the checked job's verification instead of a generic "Başarısız", why a
 * verification could not run, and "Doğrulamayı yeniden dene".
 */
export default {
  badge: 'Doğrulama',
  badgeTitle: 'Platformun başlattığı doğrulama işi; sonucu doğrulanan işin sonucudur.',
  title: {
    verify: (p: { title: string }) => `Doğrula: ${p.title}`,
    health: (p: { title: string }) => `Sağlık kontrolü: ${p.title}`,
    'integration-verify': (p: { title: string }) => `Entegrasyon doğrulaması: ${p.title}`,
  },
  outcome: {
    verified: 'Doğrulandı',
    issues: 'Doğrulama sorun buldu',
    unverifiable: 'Doğrulanamadı',
    running: 'Doğrulanıyor',
  },
  checkedJob: 'Doğrulanan iş',
  openChecked: 'Doğrulanan işi aç',
  cause: {
    git_auth: 'repo okunamadı (git kimlik bilgisi yok)',
    git_network: 'repoya ulaşılamadı (ağ hatası)',
    timeout: 'doğrulayıcı süre sınırını aştı',
    runtime_crash: 'ajanın runtime’ı çöktü',
    login: 'runtime’ın oturumu sona ermiş',
    disk_low: 'makinede yeterli disk alanı yok',
    provider_error: 'model sağlayıcısı hata verdi',
    machine_lost: 'doğrulayıcının makinesiyle bağlantı koptu',
    cancelled: 'doğrulayıcı iş iptal edildi',
    not_started: 'doğrulayıcı iş başlatılamadı',
    no_report: 'doğrulayıcı geçerli bir rapor üretmedi',
    verifier_missing: 'doğrulayıcı iş artık yok',
    run_failed: 'doğrulayıcı iş hata ile bitti',
  },
  couldNotRun: (p: { cause: string }) => `Doğrulama çalıştırılamadı: ${p.cause}`,
  retry: 'Doğrulamayı yeniden dene',
  retrying: 'Başlatılıyor…',
  retried: 'Doğrulama yeniden başlatılacak; birkaç saniye içinde yeni bir doğrulama işi açılır.',
  retryFailed: (p: { error: string }) => `Doğrulama yeniden başlatılamadı: ${p.error}`,
  resultLine: (p: { outcome: string }) => `Doğrulama: ${p.outcome}`,
};
