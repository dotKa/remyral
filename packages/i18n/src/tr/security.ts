/** p15-autonomy (ADR-0056): Ayarlar → Güvenlik — güvenlik politikası, doğrulama kodu süresi, ajan özerkliği. */
export default {
  page: {
    label: 'Güvenlik',
    purpose:
      'Doğrulama kodunun ne kadar geçerli kaldığı, hangi işlemlerin kod istediği ve ajanların ne kadar özerk çalıştığı.',
    loading: 'Güvenlik politikası yükleniyor…',
    loadFailed: (p: { reason: string }) => `Güvenlik politikası yüklenemedi: ${p.reason}`,
    readOnly: 'Bu politikayı yalnızca sahipler ve yöneticiler değiştirebilir.',
    version: (p: { version: string; who: string; when: string }) =>
      `Sürüm ${p.version} · ${p.who} · ${p.when}`,
    versionNever: (p: { version: string }) => `Sürüm ${p.version} · kurulum varsayılanı`,
    save: 'Kaydet',
    saving: 'Kaydediliyor…',
    saved: (p: { count: number }) => `Kaydedildi: ${String(p.count)} değişiklik.`,
    nothing: 'Değişiklik yok.',
    reset: 'Değişiklikleri geri al',
    failed: (p: { reason: string }) => `Kaydedilemedi: ${p.reason}`,
    chatHint:
      'Bunların hepsini sohbetten de söyleyebilirsin: “authenticator süresini 1 güne çıkar”, “deploy için kod istesin”, “sıkı moda al”.',
  },
  presets: {
    title: 'Hazır ayar',
    customized: 'özelleştirilmiş',
    apply: 'Bu ayarı uygula',
    confirmApply: (p: { name: string }) =>
      `${p.name} uygulanırsa bütün özel ayarlar bu hazır ayarın değerlerine döner. Devam edilsin mi?`,
    serbest: {
      name: 'Serbest',
      description:
        'Kod 12 saat geçerli; “bu cihazı hatırla” ile girişte verilen tek kod bütün oturumu kapsar. Yalnız güvenlik çekirdeği (güvenlik ayarları, 2FA, kullanıcı ve rol değişiklikleri, sırları açık göstermek) kod ister. Kod İSTEMEYENLER: makine yönetimini açmak, sandbox’ı kaldırmak, makine onaylamak, üretim deploy’u, kimlik bilgileri, entegrasyonlar, sürümler, MCP kurulumu. Otomatik mod açık: deploy dahil onaylar kendiliğinden geçer; asistan açık talimatları doğrudan yapar. Ele geçirilmiş bir oturum bunların hepsini kodsuz yapabilir; yalnız tek kişilik, kapalı bir kurulumda seç.',
    },
    dengeli: {
      name: 'Dengeli (yeni kurulum varsayılanı)',
      description:
        'Kod 4 saat geçerli; güvenlik çekirdeğine ek olarak kimlik bilgileri, oturum açma, sandbox, makine yönetimi, üretim deploy’u, entegrasyonlar, sürümler ve MCP kurulumu kod ister. Deploy, force push, çalışma alanı dışı silme ve gizli okuma yine insana sorulur. Otomatik mod kapalı.',
    },
    siki: {
      name: 'Sıkı',
      description:
        'Önceki davranış: her ayrıcalıklı işlem sunucu süresi içinde (varsayılan 10 dk) kod ister, hesap güvenliği işlemleri her seferinde yeni kod ister; otomatik onay yok, asistan yalnız kart hazırlar.',
    },
  },
  stepUp: {
    title: 'Doğrulama kodu süresi',
    hint: 'Bir authenticator kodu, kod isteyen işlemler için bu süre boyunca geçerli kalır (en az 5 dakika, en çok 30 gün). Oturumun kendi süresi her zaman sınırdır.',
    window: 'Kod geçerlilik süresi',
    serverDefault: (p: { minutes: string }) => `Sunucu varsayılanı (${p.minutes})`,
    serverDefaultPlain: 'Sunucu varsayılanı',
    custom: 'Özel süre (dakika)',
    minutes: (p: { n: number }) => `${String(p.n)} dk`,
    hours: (p: { n: number }) => `${String(p.n)} saat`,
    days: (p: { n: number }) => `${String(p.n)} gün`,
    rememberDevice: 'Bu cihazı hatırla',
    rememberDeviceHint:
      'Hatırlanan bir cihazda (güvenilen cihaz ya da “Beni hatırla”) bir kod oturumun sonuna kadar geçerli olur.',
    rememberServer: 'Sunucu ayarı',
    rememberOn: 'Açık',
    rememberOff: 'Kapalı',
    alwaysFresh: 'Hesap güvenliği işlemlerinde her seferinde yeni kod',
    alwaysFreshHint:
      'Parola değişikliği, kasa, oturum açma aktarımı gibi işlemler son N dakikadaki bir kodu ister. Kapalıysa yukarıdaki süre geçerlidir.',
    alwaysFreshOff: 'Kapalı',
    rangeError: 'Süre 5 dakika ile 30 gün arasında olmalı.',
  },
  events: {
    title: 'Hangi işlemler kod istesin',
    hint: 'Açık olan işlemler (TOTP iste) güncel bir authenticator kodu ister; kapalı olanlar kod sormadan geçer. Güvenlik çekirdeği her hazır ayarda varsayılan olarak açıktır.',
    ask: 'TOTP iste',
    core: 'Çekirdek',
    coreOffWarning:
      'Güvenlik çekirdeğinden bir işlemi kapatıyorsun: bu işlem çalınmış bir oturumla kod sorulmadan yapılabilir.',
    categories: {
      account: 'Hesap güvenliği',
      security: 'Güvenlik politikası',
      users: 'Kullanıcılar ve roller',
      secrets: 'Kasa ve gizli bilgiler',
      machines: 'Makineler ve sandbox',
      deploy: 'Deploy ve üretim',
      extensions: 'MCP ve yetenek kurulumları',
      workflows: 'Workflow ayrıcalıklı düğümleri',
      integrations: 'Entegrasyonlar',
      policies: 'Proje politikaları ve sınırlar',
      jobs: 'İşler, onaylar ve sohbet kartları',
      data: 'Veri erişimi ve bildirim kanalları',
    },
    labels: {
      'account.password': 'Kendi parolanı değiştirme',
      'account.devices': 'Bütün güvenilen cihazları iptal etme',
      'account.mfa': '2FA’yı kapatma / sıfırlama, kurtarma kodları',
      'security.policy': 'Güvenlik politikasını değiştirme',
      'users.roles': 'Kullanıcı ve rol değişiklikleri, proje üyelikleri, servis hesapları',
      'api.tokens': 'API anahtarı oluşturma ve yenileme (kişisel ve servis hesabı)',
      'credentials.write': 'Kasaya kimlik bilgisi yazma, silme, paylaşımı kaldırma',
      'secrets.reveal': 'Gizli bilgiyi açık metin gösterme',
      'machines.fleet': 'Makine onayı, iptali, boşaltma, arşiv, anahtar yenileme, güncelleme',
      'machines.config': 'Makine yapılandırması, runtime politikaları, kapasite, hesaplar',
      'machines.ops': 'Runtime kurma / kaldırma, yeniden başlatma, günlük, araçlar',
      'machines.logins': 'Runtime oturum açma / kapatma aktarımı, hesap kaldırma',
      'machines.sandbox': 'Sandbox hazırlama, kısıtsız profil, proje çalıştırma politikası',
      'machines.admin': 'Makine yönetimi (root / Administrator) işleri',
      'ide.start': 'Tam IDE çalışma alanı oluşturma ve başlatma (makinede etkileşimli kod)',
      'deploy.production': 'Deploy istekleri ve onayları, başarıda deploy ön onayı',
      'deploy.targets': 'Deploy hedefleri, otomatik düzeltme, doğrulama ayarları',
      'deploy.coolify': 'Coolify’da uygulama oluşturma, ortam değişkenleri ve alan adları',
      'coolify.manage':
        'Coolify genelinde değişiklik: depolama, başlatma / yeniden başlatma, veritabanı ve yedekler, servisler, projeler',
      'coolify.destructive':
        'Coolify’da veri kaybettiren veya siteyi durduran işlemler: depolama kaldırma, durdurma, silme',
      'releases.publish': 'Makine yazılımı sürümü yükleme ve kanala yayma',
      'console.domain': 'Konsolun genel adresini (alan adını) değiştirme',
      'host.update': 'Sunucuyu (control plane) güncelleme veya geri alma, isteğe bağlı yedekten geri yükleme',
      'backups.manage':
        'Şimdi yedek ve tatbikat, yedek zamanlaması, saklama, şifreleme anahtarları ve off-site hedef',
      'backups.restore': 'Canlı veritabanını bir yedekle değiştirme',
      'extensions.skills': 'Yetenek yayınlama, içe aktarma ve atama',
      'extensions.mcp': 'MCP sunucusu kurma, sırları, araç politikası, atama',
      'extensions.install_scripts': 'npm kurulum betiğine onay verme (paketin kodu makinelerde çalışır)',
      'extensions.ide':
        'IDE eklentileri: izin listesi, yasak listeleri, projenin zorunlu / önerilen eklentileri ve zorunlu ayarları',
      'workflows.privileged':
        'Ağ, deploy ve kod düğümlü workflow kaydı, etkinleştirme, çıkış izinleri, paylaşma ve bağlama',
      'integrations.connections': 'GitHub, Coolify, Cloudflare ve Bedrock bağlantıları',
      'integrations.git': 'Proje Git ayarları ve Git kimliği',
      'integrations.webhooks':
        'Giden webhook oluşturma, değiştirme, sürdürme; gizli anahtarı yenileme ya da gösterme',
      'projects.policy': 'Proje oluşturma, onay kuralları, çalışma alanı, durdurma, sıra ayarları',
      'limits.budgets': 'Kotalar, bütçeler, fiyatlar',
      'models.routing': 'Model profilleri ve yönlendirme kuralları',
      'context.admin': 'Bağlam ve hafıza yönetimi (silme, saklama, arama, varsayılanlar)',
      'chat.settings': 'Sohbet asistanı ayarları',
      'approvals.decide': 'Onay isteklerine ve workflow onaylarına karar verme',
      'jobs.control': 'İşi hemen çalıştırma, sürdürme, hesap değiştirme, onay modu',
      'automations.manage': 'Otomasyonlar, zamanlamalar ve şablonlar',
      'chat.cards': 'Sohbet kartlarını onaylama (iş, workflow çalıştırma, mesaj, izleme)',
      'data.access': 'Denetim kaydı, kullanım ve iş dışa aktarma',
      'support.report': 'Tanılama raporunu destek adresine e-postayla gönderme, destek adresi ve SMTP ayarı',
      'notifications.channels': 'Bildirim kanalları ve push abonelikleri',
    },
  },
  /** p16-api-tokens (ADR-0058): API anahtarları ve servis hesapları. */
  apiTokens: {
    title: 'API anahtarları',
    hint: 'Otomasyon için kişisel token’lar ve servis hesabı token’ları. Bir token hiçbir zaman doğrulama kodu veremez.',
    personal: 'Kişisel API anahtarlarına izin ver',
    personalHint:
      'Kapalıysa yalnızca servis hesapları token alabilir; mevcut kişisel token’lar çalışmaya devam eder (iptal etmek için Servis hesapları sayfası).',
    maxDays: 'Bir token en çok ne kadar geçerli olabilir',
    maxDaysHint: 'Yeni ve yenilenen token’lar için. Geçerlilik süresi her zaman zorunludur.',
    days: '{n} gün',
    eventGrants: 'Yöneticiler token’lara kod isteyen işlem izni verebilsin',
    eventGrantsHint:
      'Kapalıyken (varsayılan) doğrulama kodu isteyen her işlem token’la reddedilir. Açıkken bir yönetici, token oluştururken güncel bir kodla seçtiği işlemlere izin verebilir; güvenlik çekirdeği hiçbir zaman verilemez.',
  },
  /** The assistant's change_settings card (Sohbet). */
  card: {
    label: 'Ayar',
    kind: 'Ayar değişikliği',
    target: 'Hedef',
    changed: 'Değişenler',
    project: 'Proje',
    machine: 'Makine',
    reason: 'Gerekçe',
    targets: {
      security_policy: 'Güvenlik politikası',
      apply_autonomy: 'Özerklik varsayılanlarını mevcut projelere uygula',
      project_execution: 'Proje çalıştırma politikası',
      project_approval_rules: 'Proje onay kuralları',
      worker_runtime_policy: 'Makinenin runtime politikası',
    },
  },
  autonomy: {
    title: 'Ajan özerkliği',
    hint: 'Yeni projeler ve işler için varsayılanlar. Bir projenin kendi ayarı her zaman geçerlidir; makinenin izin vermediği hiçbir şey açılmaz.',
    hostExecution: 'Yeni projelerde doğrudan makinede çalıştırmaya izin ver',
    autoApprove: 'Yeni projelerde “Hiç sorma” işlerine izin ver',
    jobApproval: 'İşlerin varsayılan onay modu',
    jobApprovalAllowAll: 'Hiç sorma (proje izin veriyorsa)',
    jobApprovalAskSensitive: 'Hassas adımlarda sor',
    chatDirect: 'Sohbetteki açık komutlar kartsız uygulanır',
    chatDirectHint:
      '“PR’ları onayla”, “deploy et” gibi kendi yazdığın komutlar hemen yapılır; yalnızca asistanın kendi önerileri, otomatik mesajlar ve kod isteyen işlemler kart olarak bekler. Kapatırsan her işlem kartla onaylanır.',
    maxJobMinutes: 'Bir işin süre sınırı en çok',
    maxJobMinutesHint: 'Kartta ayarlanan ya da iş sürerken uzatılan süre sınırı bunu aşamaz.',
    applyExisting: 'Mevcut projelere uygula',
    applyExistingHint:
      'Bütün projeler (Makineler hariç) yukarıdaki “yeni proje” ayarlarını alır. Kısıtsız profil asla açılmaz.',
    applyConfirm: 'Bütün mevcut projelerin çalıştırma ayarları değişecek. Devam edilsin mi?',
    applied: (p: { count: number }) => `${String(p.count)} proje güncellendi.`,
    rulesTitle: 'Risk tabanlı onay kuralları',
    rulesHint:
      '“Hiç sorma” işlerinde bu master onayları politikayla geçer (açık) ya da yine bir insana sorulur (kapalı). Makine yönetimi komutları her zaman kendi iki anahtarına bağlıdır.',
    passes: 'Politikayla geçer',
    actions: {
      'git.push_protected': 'Korumalı branch’e push',
      'git.merge': 'Korumalı branch’e merge',
      'git.force_push': 'Force push / geçmişi yeniden yazma',
      deploy: 'Deploy (üretim dahil)',
      'fs.delete_outside_workspace': 'Çalışma alanı dışında dosya silme',
      'network.egress_non_allowlisted': 'İzin listesi dışında ağ erişimi',
      'secret.read': 'İzin verilenlerin ötesinde gizli bilgi okuma',
      'runtime.dangerous_tool': 'Runtime’ın onay istediği araç çağrısı',
      'job.budget_increase': 'İş bütçesini artırma',
      'tool.mcp': 'MCP aracının “sor” işaretli çağrısı',
    },
  },
  /** p16-zip-job-input (ADR-0060): bir .zip'ten işe girdi dosyası olarak ne gidebilir. */
  inputs: {
    title: 'İş girdisi dosyaları',
    hint: 'Sohbete ya da iş oluşturucuya bırakılan bir .zip, işin girdi dosyaları olur (in/). Yerel programlar ve kütüphaneler dışında her dosya türüne izin verilir.',
    switch: 'Çalıştırılabilir dosyalar iş girdisi olabilsin',
    switchHint:
      'Açık: yerel programlar ve kütüphaneler (ELF, Windows .exe / .dll, macOS Mach-O, .so, .dylib) bir .zip’ten ajanın çalışma klasörüne gidebilir. Kapalı: tek tek adlarıyla reddedilir. Varsayılan: kapalı.',
  },
};
