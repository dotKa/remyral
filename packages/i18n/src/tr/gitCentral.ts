/**
 * p15-git-central: "Git hazırlığı" — makine sayfasındaki Git kartı, filo genelinde düzeltme, Projeler → Depo → depo
 * kimlik bilgisi (GitHub dışı / SSH depolar) ve git kimliğinin her commit'e uygulandığı notu.
 */
export default {
  card: {
    title: 'Git',
    sub: 'Bu makinedeki git ve makine hesabının git ayarları. İşler bu ayarları kullanmaz: kimlik bilgisini ve git yapılandırmasını her iş için platform verir.',
    loading: 'Git durumu yükleniyor',
    gitPresent: (p: { version: string }) => `git ${p.version}`,
    gitMissing: 'git bulunamadı',
    sources: {
      config: 'yapılandırmadaki git',
      managed: 'Remyral’ın kurduğu git',
      system: 'sistemdeki git',
    },
    isolated:
      'İşler makinenin git ayarlarını, kimlik bilgisi yardımcılarını ve gh oturumunu kullanmaz; her iş kendi git yapılandırmasıyla çalışır.',
    notIsolated: (p: { min: string }) =>
      `Bu git sürümü makinenin genel ayarlarını işlerden uzak tutamıyor; git ${p.min} ya da daha yenisi gerekli.`,
    noProblems: 'Sorun yok.',
    notReported: 'Bu makine git durumunu henüz bildirmedi.',
    unsupported: 'Bu makine sürümü git durumunu bildirmiyor; makineyi güncelleyin.',
    offline: 'Makine bağlı değil; düzeltme bağlandığında yapılabilir.',
    checkedAt: (p: { at: string }) => `Son denetim: ${p.at}`,
    osStoreUnchecked: 'İşletim sisteminin kimlik deposu bu makinede denetlenemedi.',
    severity: {
      blocking: 'Engelliyor',
      warning: 'Uyarı',
      info: 'Bilgi',
    },
    codes: {
      git_missing: 'git yok: depo işleri bu makinede çalışamaz. Araçlar sekmesinden git kurun.',
      git_too_old: (p: { min: string }) =>
        `git çok eski: makinenin genel ayarları işlerden uzak tutulamaz. git ${p.min} ya da daha yenisini kurun.`,
      global_credential_helper: (p: { n: number; helpers: string }) =>
        `${String(p.n)} kimlik bilgisi yardımcısı tanımlı (${p.helpers}). İşler bunları kullanmaz.`,
      global_insteadof: (p: { n: number }) =>
        `github.com adreslerini değiştiren ${String(p.n)} genel URL yönlendirmesi (insteadOf) var. İşler bunları kullanmaz; elle çalışırken kafa karıştırır.`,
      insteadof_with_credentials: (p: { n: number }) =>
        `${String(p.n)} URL yönlendirmesi adresin içinde parola ya da token taşıyor. Değeri gösterilmez; kaldırılmalı.`,
      safe_directory_wildcard:
        'safe.directory=* tanımlı: git’in depo sahipliği koruması bu hesap için kapalı.',
      autocrlf_true:
        'core.autocrlf=true: işler kendi ayarını (false) kullanır; bu yalnız makinede elle yapılan işleri etkiler.',
      credential_store_file: 'Düz metin kimlik dosyası (~/.git-credentials) var.',
      os_store_github: (p: { n: number }) =>
        `İşletim sisteminin kimlik deposunda ${String(p.n)} eski GitHub girişi var (Windows Kimlik Yöneticisi / macOS anahtar zinciri).`,
      global_identity:
        'Genel user.name / user.email tanımlı: yok sayılır, commit’ler proje ya da çalışma alanı kimliğiyle atılır.',
    },
    fixes: {
      erase_github_credentials: 'Eski GitHub girişlerini sil',
      remove_github_insteadof: 'github.com yönlendirmelerini kaldır',
    },
    fix: 'Düzelt',
    fixWhy: (p: { machine: string }) =>
      `${p.machine} makinesinin git ayarlarını düzelt — güncel doğrulama kodunu gir.`,
    fixWillApply: (p: { fixes: string }) => `Düzelt şunları yapar: ${p.fixes}.`,
    what: 'Git düzeltmesi',
    outcomes: {
      applied: 'yapıldı',
      nothing_to_do: 'gerek yoktu',
      failed: 'yapılamadı',
      unsupported: 'desteklenmiyor',
    },
    result: (p: { fix: string; outcome: string }) => `${p.fix}: ${p.outcome}`,
  },
  fleet: {
    title: 'Git hazırlığı',
    sub: 'Tüm makinelerde git ve makine hesaplarının git ayarları. Düzeltme her makineye ayrı, imzalı bir uzak işlem olarak gider.',
    loading: 'Makinelerin git durumu yükleniyor',
    machine: 'Makine',
    git: 'git',
    problems: 'Sorunlar',
    none: 'Makine yok.',
    ok: 'Hazır',
    problemCount: (p: { n: number }) => `${String(p.n)} sorun`,
    fixable: (p: { n: number }) => `${String(p.n)} makinede düzeltilebilir sorun var.`,
    nothingFixable: 'Düzeltilebilir sorunu olan makine yok.',
    fixAll: 'Tümünde düzelt',
    fixAllWhy: 'Tüm makinelerin git ayarlarını düzelt — güncel doğrulama kodunu gir.',
    sent: (p: { sent: number; skipped: number }) =>
      `${String(p.sent)} makineye gönderildi, ${String(p.skipped)} makine atlandı.`,
    skipped: {
      worker_update_required: 'güncelleme gerekli',
      worker_offline: 'bağlı değil',
      nothing_to_fix: 'sorun yok',
      rate_limited: 'çok sık istek',
      default: 'atlandı',
    },
  },
  repo: {
    title: 'Depo erişimi (GitHub dışı / SSH)',
    sub: 'GitHub App’in kapsamadığı bir depo için proje kimlik bilgisi. Değer kasada, seçtiğiniz makinelere mühürlü durur; yalnız bu projenin işine, yalnız fetch ve push sırasında verilir. Makinelere kalıcı SSH anahtarı konmaz.',
    loading: 'Depo erişimi yükleniyor',
    githubNote:
      'GitHub depoları için bir şey gerekmez: her iş, fetch ve push’tan hemen önce GitHub App’ten yalnız o depoya yetkili yeni bir token alır.',
    none: 'Tanımlı değil.',
    kind: 'Tür',
    kinds: {
      'ssh-key': 'SSH deploy key',
      'https-token': 'HTTPS token',
    },
    credential: 'Kimlik bilgisi',
    credentialHint:
      'Ayarlar → Kimlik bilgileri’nde “Git SSH deploy key” ya da “Git HTTPS token” türünde oluşturulan, bu projenin işlerini çalıştıracak makinelere mühürlenmiş bir kimlik bilgisi.',
    noCredentials: 'Bu türde kimlik bilgisi yok. Önce Ayarlar → Kimlik bilgileri’nde oluşturun.',
    pick: 'Seçin',
    username: 'Kullanıcı adı',
    usernameHint: 'Token ile gönderilen kullanıcı adı (GitLab: oauth2, Bitbucket: x-token-auth). Boş: git.',
    knownHosts: 'Sabitlenmiş known_hosts satırları',
    knownHostsHint:
      'Sunucunun anahtarı, ssh-keyscan’in yazdığı biçimde ("sunucu anahtar-türü anahtar"). Parmak izini sunucunun yöneticisinden doğrulayın; bağlantı yalnız bu anahtarla kurulur.',
    knownHostsProblems: {
      empty: 'En az bir known_hosts satırı gerekli.',
      too_long: 'known_hosts satırları çok uzun (en çok 16 KiB).',
      too_many_lines: 'En çok 16 satır.',
      bad_line:
        'Bir satır geçerli değil: "sunucu anahtar-türü anahtar"; işaret, joker karakter ya da olumsuzlama olmadan.',
    },
    access: 'Depodaki yetkisi',
    accessRead: 'Yalnız okuma',
    accessWrite: 'Okuma ve yazma',
    accessHint:
      'Güvenilmeyen kaynaklı işler (ör. dış pull request’ler) yalnız “Yalnız okuma” işaretli bir kimlik bilgisini alır.',
    current: (p: { name: string; kind: string }) => `${p.name} (${p.kind})`,
    workers: (p: { names: string }) => `Bu kimlik bilgisini taşıyan makineler: ${p.names}`,
    noWorkers: 'Bu kimlik bilgisi hiçbir makineye mühürlenmemiş; işler fetch edemez.',
    oldWorkers: (p: { names: string }) =>
      `Şu makinelerin sürümü bu kimlik bilgisini kullanamıyor: ${p.names}. Güncelleyin.`,
    save: 'Kaydet',
    remove: 'Kaldır',
    saved: 'Depo erişimi kaydedildi; sonraki işler bununla fetch ve push yapar.',
    removed: 'Depo erişimi kaldırıldı.',
    why: (p: { project: string }) =>
      `${p.project} projesinin depo erişimini değiştir — güncel doğrulama kodunu gir.`,
    readOnly: 'Bunu yalnız proje sahipleri ve yöneticiler değiştirebilir.',
    edit: 'Değiştir',
    set: 'Tanımla',
    cancel: 'Vazgeç',
  },
  vault: {
    kinds: {
      gitSshKey: 'Git SSH deploy key',
      gitHttpsToken: 'Git HTTPS token',
    },
    keyValue: 'Özel anahtar',
    keyHint:
      'Parolasız bir OpenSSH özel anahtarı (-----BEGIN OPENSSH PRIVATE KEY-----). Yalnız bu tarayıcıda mühürlenir; açık hali hiçbir yere gönderilmez.',
    keyProblems: {
      not_a_private_key:
        'Bir özel anahtar değil: -----BEGIN … PRIVATE KEY----- ile başlayan metnin tamamını yapıştırın.',
      encrypted: 'Anahtar parolalı; makineler parola soramaz. Parolasız bir deploy key kullanın.',
    },
    gitOnly:
      'Yalnız platformun git’i (fetch ve push) kullanır; hiçbir işin ortam değişkenine konmaz. Yalnız güncel sürümdeki makinelere iletilir.',
  },
  identity: {
    appliesEverywhere:
      'Bu kimlik platformun ve ajanın kendi commit’lerinin hepsine uygulanır. Makinelerdeki genel git user.name / user.email ayarları yok sayılır.',
  },
};
