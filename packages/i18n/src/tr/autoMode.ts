/**
 * p15-auto-mode: "Otomatik mod" — approvals granted by the security policy, automatic retries,
 * self-healing (base ref, rebase, auto-fix job) and the failure digest.
 */
export default {
  settings: {
    title: 'Otomatik mod',
    on: 'Açık: politikanın verebildiği her onay sorulmadan verilir.',
    off: 'Kapalı: onaylar kurallara göre sorulur.',
    hint: 'Araç onayları, birleştirme kararları, deploy’lar (üretim dahil) ve MCP araçları sorulmadan geçer; geçici hatalar kendiliğinden yeniden denenir, kalıcı bir hatada bir düzeltme işi açılır. Her zaman sorulanlar: makine yönetimi, force push / branch silme / çalışma alanı dışında silme ve güvenlik çekirdeği (2FA, güvenlik politikası).',
    switchLabel: 'Otomatik modu kullan',
    retries: 'Otomatik yeniden deneme',
    retriesOff: 'Kapalı',
    retriesN: (p: { n: number }) => `En çok ${String(p.n)} kez (1, 5, 20 dk arayla)`,
    turnedOn: 'Otomatik mod açıldı.',
    turnedOff: 'Otomatik mod kapatıldı.',
  },
  job: {
    title: 'Otomatik işlemler',
    retrying: (p: { n: number; max: number }) => `Otomatik yeniden deneme ${String(p.n)}/${String(p.max)}`,
    nextAt: (p: { time: string }) => `Sonraki deneme ${p.time}`,
    approved: (p: { action: string }) => `Otomatik mod onayladı: ${p.action}`,
    approvedPolicy: (p: { action: string }) => `Güvenlik politikası onayladı: ${p.action}`,
    retry: (p: { n: number; max: number; cause: string }) =>
      `Otomatik yeniden deneme ${String(p.n)}/${String(p.max)} (${p.cause})`,
    otherMachine: 'Başka bir uygun makinede denenir.',
    exhausted: (p: { max: number }) => `${String(p.max)} otomatik deneme de başarısız oldu.`,
    baseRef: (p: { from: string; to: string }) => `Temel referans düzeltildi: ${p.from} → ${p.to}`,
    rebased:
      'İş, başlangıçtaki temel üzerine otomatik olarak yeniden dizildi (rebase) ve yeniden doğrulandı.',
    rebaseConflicts: (p: { n: number }) =>
      `Otomatik rebase ${String(p.n)} dosyada çakıştı; bir kişinin (ya da düzeltme işinin) çözmesi gerekiyor.`,
    rebaseOther: 'Otomatik rebase yapılamadı.',
    // p22-git-preflight: the repository access check before dispatch refused the job (no machine started it).
    repoAccess: {
      repo_credentials_missing:
        'Repo erişim kontrolü: repo özel (ya da yok) ve bu iş için bir Git kimlik bilgisi yok; iş hiçbir makinede başlatılmadı.',
      repo_access_denied:
        'Repo erişim kontrolü: projenin Git bağlantısı bu repoya erişemiyor; iş hiçbir makinede başlatılmadı.',
    },
    repoAccessFix: {
      no_connection:
        'Çözüm: GitHub’ı bağlayın (Ayarlar → Entegrasyonlar → GitHub) ve projenin Git ayarında bu repoyu seçin ya da projeye bir repo kimlik bilgisi ekleyin.',
      other_repository:
        'Çözüm: projenin Git bağlantısı başka bir repo için ayarlı; Git ayarındaki repo adresini bu repo yapın ya da işi doğru projede başlatın.',
      untrusted_source:
        'Çözüm: güvenilmeyen kaynaktan gelen işlere Git kimlik bilgisi verilmez; işi güvenilir bir kaynaktan başlatın.',
      not_installed:
        'Çözüm: GitHub uygulamasının kurulumuna bu repoyu ekleyin (Ayarlar → Entegrasyonlar → GitHub) ya da projenin repo adresini düzeltin.',
      connection_refused:
        'Çözüm: bağlantının izni ya da token’ı geçersiz veya süresi dolmuş; Ayarlar → Entegrasyonlar’da bağlantıyı yenileyin.',
    },
    fixOpened: 'Düzeltme işi açıldı.',
    fixDone: (p: { state: string }) => `Düzeltme işi bitti: ${p.state}`,
    fixLink: 'Düzeltme işini aç',
    fixOf: 'Bu iş, başarısız bir işin otomatik düzeltme işi.',
    fixOfLink: 'Asıl işi aç',
    // p22-conflict-resolve: a verified result that conflicts with its target, carried onto it by a new job.
    conflictResolvable:
      'Bu işin sonucu hedef dalla çakışıyor: arada başka işler birleşti. Çakışmayı çöz, işi baştan yaptırmadan sonucu güncel dalın üzerine taşır.',
    conflictResolve: 'Çakışmayı çöz',
    conflictResolveStarted: 'Çakışma çözme işi açıldı.',
    conflictResolveOpened:
      'Çakışma çözme işi açıldı; birleşince bu iş kapanır ve eski PR platform tarafından kapatılır.',
    conflictResolveMerged: (p: { prClosed: boolean }) =>
      `Çakışma çözme işi birleşti; bu iş onun yerine geçti.${p.prClosed ? ' Eski PR kapatıldı.' : ''}`,
    conflictResolveFailed: 'Çakışma çözme işi birleşmeden bitti; bu iş olduğu gibi duruyor.',
    conflictResolveLink: 'Çakışma çözme işini aç',
    conflictResolveOf: 'Bu iş, hedef dalla çakışan bir sonucu güncel dala taşıyan çakışma çözme işi.',
    conflictResolveOfLink: 'Asıl işi aç',
    causes: {
      runtime_crash: 'runtime çöktü',
      disk_low: 'disk dolu',
      git_auth: 'git kimlik doğrulama',
      git_network: 'ağ hatası',
      git_cache: 'makinenin git önbelleği',
      login: 'runtime oturumu',
      worker_restart: 'makine yeniden başladı',
      provider_error: 'sağlayıcı hatası',
      lease_lost: 'makine bağlantısı koptu',
      publish_missing: 'sonuç gönderilemedi',
      usage_limit: 'kullanım sınırı',
      base_ref: 'temel referans yok',
      diverged: 'temelden ayrıştı',
      policy: 'politika reddi',
      invalid: 'geçersiz istek',
      timeout: 'süre aşıldı',
      cancelled: 'iptal',
      verification: 'doğrulama',
      run_failed: 'çalışma başarısız',
    },
    reasons: {
      previous_job_head: 'önceki işin sonucu',
      previous_job_target: 'önceki işin birleştiği branch',
      project_base: 'projenin temel branch’i',
      repository_default: 'deponun varsayılan branch’i',
    },
    fixStates: {
      created: 'çalışıyor',
      succeeded: 'başarılı',
      failed: 'başarısız',
      cancelled: 'iptal edildi',
      skipped: 'açılmadı',
    },
  },
  digest: {
    line: (p: { failed: number; healed: number; waiting: number }) =>
      `Son 24 saat: ${String(p.failed)} başarısız · ${String(p.healed)} kendiliğinden düzeldi · ${String(p.waiting)} senden bekliyor`,
    link: 'Başarısız işler',
  },
};
