/**
 * p17-panel-settings (docs/design/p17-panel-settings.md): Ayarlar → Sunucu ayarları — eskiden yalnız ortam değişkeni
 * olan ayarlar (panelde saklanır, ortam değişkeni varsayılan olarak kalır), anahtar yenileme ve bakım işleri.
 */
export default {
  page: {
    label: 'Sunucu ayarları',
    purpose:
      'Eskiden yalnız ortam değişkeniyle değişen ayarlar: bildirim kanalları, arama, ağ, oturumlar, loglar, hafıza, workflow motoru, Coolify koruması; anahtar yenileme ve bakım işleri.',
  },
  loading: 'Sunucu ayarları yükleniyor…',
  status: 'sunucu ayarları',
  tabs: {
    notifications: 'Bildirimler',
    search: 'Arama',
    network: 'Ağ',
    sessions: 'Oturumlar',
    jobs: 'İşler',
    logs: 'Loglar',
    memory: 'Hafıza',
    workflows: 'Workflow motoru',
    ops: 'Coolify koruması',
    keys: 'Anahtarlar',
    maintenance: 'Bakım',
  } as Record<string, string>,
  source: {
    panel: 'panel',
    env: 'ortam değişkeni',
  },
  sourceLine: (p: { source: string; env: string }) => `Kaynak: ${p.source} (${p.env})`,
  sourceOnly: (p: { source: string }) => `Kaynak: ${p.source}`,
  envDefault: (p: { value: string }) => `Ortam değişkeni değeri: ${p.value}`,
  envUnset: 'Ortam değişkeni ayarlı değil',
  restart: 'Yeniden başlatma gerekir',
  reset: 'Ortam değişkenine dön',
  save: 'Kaydet',
  saved: 'Kaydedildi.',
  stepUp: 'Sunucu ayarlarını değiştir',
  listHint: 'Her satıra bir değer.',
  on: 'Açık',
  off: 'Kapalı',
  none: '(yok)',
  secret: {
    set: 'Ayarlı',
    unset: 'Ayarlı değil',
    change: 'Değiştir',
    cancelChange: 'Vazgeç',
    remove: 'Kaldır',
    generate: 'Sunucuda üret',
    regenerate: 'Yeniden üret',
    placeholder: 'Yeni değer (bir daha gösterilmez)',
    shownOnce: 'Bu değer yalnız şimdi gösteriliyor; alıcı sistemlere şimdi kopyala.',
    publicKey: 'Açık anahtar',
  },
  confirm: {
    title: 'Onay gerekiyor',
    clientIp: (p: { current: string; after: string }) =>
      `Bu ayarlarla sunucu bu isteği ${p.current} yerine ${p.after} adresinden geliyor sayacak. Yanlışsa oturum ve hız sınırları etkilenebilir. Yine de kaydedilsin mi?`,
    push: (p: { devices: number }) =>
      `Yeni bildirim anahtarı, bildirimleri açık olan ${String(p.devices)} cihazda kapatır; kullanıcılar Ayarlar → Cihazlar'dan yeniden açar. Devam edilsin mi?`,
    yes: 'Evet, kaydet',
    no: 'Vazgeç',
  },
  sections: {
    notifications:
      'Webhook izin listesi ve imza anahtarı, Web Push (VAPID) anahtarı, konu ve servis izin listesi.',
    search:
      'Anlamsal arama sağlayıcısı: AWS Bedrock (Entegrasyonlar sayfasında) ya da HTTP embedding servisi. SEARCH_PROVIDER=off sunucuda kapatma anahtarı olarak kalır.',
    network:
      'Güvenilen proxy sayısı ve CDN istemci IP başlığı. Yanlış ayar, oturumları ve hız sınırlarını yanlış adrese bağlar.',
    sessions: '"Beni hatırla" ve güvenilen cihaz süreleri, makine anahtarı yenileme onayı.',
    jobs: 'Bir işin, makinede runtime girişi için ne kadar bekleyeceği.',
    logs: 'Konsoldaki log aramasının saklama süresi, seviyesi ve istek satırları.',
    memory:
      'Otomatik öğrenmenin genel anahtarı ve eşikler. MEMORY_AUTO_LEARN=off sunucuda kapatma anahtarı olarak kalır.',
    workflows: 'Workflow motoru 2. Açmadan önce ön kontrolü çalıştır.',
    ops: 'Coolify ve DNS işlemlerinde iç adresler ve korunan control-plane kaynakları.',
  } as Record<string, string>,
  info: {
    // p17-output-limits: what decides where a job's output files go.
    outputsStore: {
      local: 'Büyük çıktılar sunucunun diskindeki depolamaya yüklenir.',
      s3: 'Büyük çıktılar nesne depolamaya (S3) yüklenir.',
      unavailable:
        'Nesne depolama seçili ama şu an kullanılamıyor: işler yalnızca doğrudan dönüş yolunu kullanır. Dosya sayısı sınırı yine geçerli; sığmayan dosyalar iş sayfasında sebebiyle listelenir.',
    },
    outputsBudget: (p: { inlineFile: string; inlineTotal: string; file: string; job: string }) =>
      `Dosyanın boyutu yolu belirler: küçük dosyalar doğrudan döner (dosya başına ${p.inlineFile}, toplam ${p.inlineTotal}); büyükler ve bu toplamı aşanlar depolamaya gider (dosya başına ${p.file}, iş başına ${p.job}; Ayarlar → Entegrasyonlar → Depolama). Sınırı aşan dosyalar tek bir out-rest.zip içinde paketlenir.`,
    outputsOldWorkers:
      'Yazılımı eski makineler (output-limits-v1 olmayan) eski sınırları kullanır: 20 dosya, zip yok.',
    clientIp: (p: { ip: string }) => `Sunucunun bu istek için gördüğü istemci adresi: ${p.ip}`,
    socket: (p: { ip: string; xff: string }) => `Bağlantı adresi: ${p.ip}; X-Forwarded-For: ${p.xff}`,
  },
  fields: {
    'notify.webhook.allowlist': {
      label: 'Webhook izin listesi',
      hint: 'Kullanıcıların webhook adresi olarak girebileceği https:// adres önekleri.',
    },
    'notify.webhook.secret': {
      label: 'Webhook imza anahtarı (HMAC)',
      hint: 'Her bildirim bu anahtarla imzalanır (X-Remyral-Signature). Yenilemek için Anahtarlar sekmesini kullan.',
    },
    'push.vapidKey': {
      label: 'Web Push anahtarı (VAPID)',
      hint: 'Sunucuda üretilir; gizli yarısı hiç gösterilmez.',
    },
    'push.subject': {
      label: 'Web Push iletişim adresi',
      hint: 'Push servislerinin gördüğü mailto: adresi ya da https:// adres.',
    },
    'push.endpointAllowlist': {
      label: 'Push servisi izin listesi',
      hint: 'Boş: bilinen tarayıcı push servisleri.',
    },
    'search.provider': { label: 'Sağlayıcı', hint: 'HTTP: OpenAI uyumlu bir embedding servisi.' },
    'search.http.url': { label: 'HTTP adresi', hint: 'https:// (http:// yalnız bu makine için).' },
    'search.http.model': { label: 'Model', hint: 'Servisin model adı.' },
    'search.http.key': { label: 'API anahtarı', hint: 'Şifreli saklanır, bir daha gösterilmez.' },
    'search.http.dimensions': { label: 'Boyut', hint: 'Boş: servisin varsayılanı.' },
    'net.trustProxyHops': {
      label: 'Güvenilen proxy sayısı',
      hint: 'Sunucunun önündeki proxy sayısı (Traefik: 1; Cloudflare + Traefik: 1 ve aşağıdaki başlık).',
    },
    'net.clientIpHeader': {
      label: 'İstemci IP başlığı',
      hint: 'Örneğin Cloudflare için cf-connecting-ip. Yalnız aşağıdaki adreslerden gelirse kabul edilir.',
    },
    'net.clientIpSources': {
      label: 'Başlığa güvenilen adresler',
      hint: 'CDN çıkış adresleri (IP ya da CIDR).',
    },
    'auth.rememberIdleDays': {
      label: '"Beni hatırla" boşta kalma (gün)',
      hint: '0: "Beni hatırla" kapalı.',
    },
    'auth.rememberAbsoluteDays': { label: '"Beni hatırla" en uzun süre (gün)', hint: '0: kapalı.' },
    'auth.trustedDeviceDays': {
      label: 'Güvenilen cihaz süresi (gün)',
      hint: '0: güvenilen cihaz kapalı (her girişte doğrulama kodu).',
    },
    'workers.rotationApproval': {
      label: 'Makine anahtarı yenilemesi onay ister',
      hint: 'Açık: bir makinenin yeni anahtarı bir yönetici onaylayana kadar bekler.',
    },
    'jobs.loginWaitMinutes': {
      label: 'Giriş bekleme süresi (dakika)',
      hint: 'Bir iş, makinede runtime girişi yapılmasını bu kadar bekler. 0: beklemez.',
    },
    'jobs.outputMaxFiles': {
      label: 'İş başına çıktı dosyası',
      hint: 'Bir çalışma alanı işinin döndürebileceği en çok dosya (doğrudan + depolama birlikte; 1–2000). Fazlası tek bir out-rest.zip içinde döner. Projeler daha düşük bir değer seçebilir.',
    },
    'logs.retentionDays': { label: 'Saklama (gün)', hint: '0: konsol log araması kapalı.' },
    'logs.level': { label: 'En düşük seviye', hint: 'Bu seviyenin altındaki satırlar saklanmaz.' },
    'logs.requests': { label: 'İstek satırları', hint: 'problems: yalnız hatalı istekler; all: hepsi.' },
    'memory.autoLearn': {
      label: 'Otomatik öğrenme',
      hint: 'Kapalı: öneriler bir kişinin onayını bekler (proje ayarları da geçersiz olur).',
    },
    'memory.duplicateThreshold': {
      label: 'Tekrar eşiği',
      hint: 'Bu benzerliğin üstündeki öneri mevcut bir kaydın tekrarı sayılır (0,5–0,999).',
    },
    'memory.chatPerThreadDay': {
      label: 'Sohbet başına günlük öneri',
      hint: '0: sohbetten öneri çıkarılmaz.',
    },
    'workflow.engineV2': {
      label: 'Workflow motoru 2',
      hint: 'Sürüm 2 belgeleri kaydedilip motor 2 ile çalışır.',
    },
    'workflow.engineV2ForV1': {
      label: 'Sürüm 1 workflowlar da motor 2 ile',
      hint: 'Önce ön kontrolü çalıştır; açık işler kendi motorlarında biter.',
    },
    'ops.internalOrigins': {
      label: 'İç adresler',
      hint: 'http:// ya da özel adres olsa da erişilebilecek tam adresler (ör. http://coolify:8000).',
    },
    'ops.controlPlaneUuids': {
      label: 'Korunan Coolify kaynakları',
      hint: 'Remyral control-plane kaynaklarının uuid değerleri: hiçbir işlem bunlara deploy etmez.',
    },
    'ops.controlPlaneAddresses': {
      label: 'Control-plane adresleri',
      hint: 'DNS kayıtlarının yönlenemeyeceği adresler.',
    },
  } as Record<string, { label: string; hint: string }>,
  mail: {
    title: 'E-posta (SMTP)',
    sub: 'Bildirim e-postaları ve destek raporu aynı SMTP ayarını kullanır. Panelde ayarlı değilse NOTIFY_SMTP_* ortam değişkenleri kullanılır.',
    source: {
      panel: 'panel',
      env: 'ortam değişkeni',
      none: 'ayarlı değil',
    } as Record<string, string>,
    host: 'Sunucu',
    port: 'Port',
    security: 'TLS',
    from: 'Gönderen',
    username: 'Kullanıcı adı',
    password: 'Parola',
    passwordSet: 'Parola ayarlı',
    edit: 'Düzenle',
    save: 'SMTP ayarını kaydet',
    remove: 'Panel ayarını kaldır',
    testTo: 'Test alıcısı (boş: senin bildirim adresin)',
    test: 'Test e-postası gönder',
    testOk: (p: { to: string }) => `Test e-postası gönderildi: ${p.to}`,
    testFailed: (p: { error: string }) => `Gönderilemedi: ${p.error}`,
  },
  workflowCheck: {
    title: 'Ön kontrol (workflow:normalise-check)',
    sub: 'Kayıtlı her workflow tanımının sürüm 2 belgesine dönüştüğünü ve değişmeden geri döndüğünü kuru çalıştırmayla denetler; hiçbir şey değişmez.',
    run: 'Ön kontrolü çalıştır',
    running: 'Çalışıyor…',
    ok: 'Ön kontrol geçti.',
    failed: (p: { n: number }) => `${String(p.n)} tanım geçemedi; motoru açmadan önce düzelt.`,
    needCheck: 'Sürüm 1 workflowları motor 2ye taşımadan önce ön kontrolü çalıştır.',
  },
  keys: {
    title: 'Anahtar yenileme',
    sub: 'Her yenileme önce kuru çalıştırmayla ne değişeceğini gösterir; sonra denetim kaydına yazılır.',
    dryRun: 'Ne değişeceğini göster',
    rotate: 'Yenile',
    activate: 'Yeni anahtarı etkinleştir',
    cancel: 'Yenilemeyi iptal et',
    age: (p: { days: number }) => `${String(p.days)} gün önce`,
    online: 'Panelden',
    host: 'Sunucuda',
    procedure: 'Sunucuda izlenecek adımlar',
    items: {
      webhookHmac: {
        title: 'Webhook imza anahtarı',
        sub: 'Yeni anahtar hazırlanır ve bir kez gösterilir; etkinleştirene kadar bildirimler iki imza taşır (X-Remyral-Signature-Next), alıcılar önceden geçebilir.',
      },
      skillsPanel: {
        title: 'Yetenek imza anahtarı (panel)',
        sub: 'Sohbette yazılan yetenekleri imzalayan anahtar. Sunucuda üretilir; açık anahtarı makinelere yönetilen ayarla gider.',
      },
      leaseSigning: {
        title: 'Lease imza anahtarı',
        sub: 'Makinelere verilen işleri imzalar ve sunucu uygulayıcısı isteklerini doğrular.',
      },
      totp: {
        title: 'Ana anahtar (TOTP_KEY_FILE)',
        sub: 'Doğrulama kodlarını, kurtarma kodlarını, API anahtarlarını ve panelde saklanan her sırrı korur.',
      },
    },
    pending: 'Hazırlanan yeni anahtar etkinleştirilmeyi bekliyor.',
    publicKey: 'Açık anahtar',
    retiredKeys: 'Hala güvenilen eski açık anahtarlar',
    secretOnce: 'Yeni anahtar (yalnız şimdi gösterilir)',
    effect: 'Etkisi',
  },
  maintenance: {
    title: 'Bakım işleri',
    sub: 'Arka planda çalışır, ilerlemesi görünür, iptal edilebilir. Her türden aynı anda bir iş çalışır. Önce kuru çalıştırma.',
    kinds: {
      'blobs-migrate': 'Depolama taşıma (blobs:migrate)',
      'search-backfill': 'Eksik vektörleri doldurma (search:backfill)',
      'memory-autolearn': 'Hafıza otomatik öğrenme (memory:autolearn)',
    } as Record<string, string>,
    mode: 'Kip',
    modes: {
      legacy: 'Eski kayıtları depolamaya taşı',
      'to-store': 'Yereldeki dosyaları seçili depolamaya taşı',
    } as Record<string, string>,
    searchKinds: 'Türler',
    dryRun: 'Kuru çalıştır',
    start: 'Başlat',
    cancel: 'İptal et',
    state: {
      queued: 'Sırada',
      running: 'Çalışıyor',
      done: 'Bitti',
      failed: 'Hata',
      cancelled: 'İptal edildi',
    } as Record<string, string>,
    progress: (p: { done: number; total: string }) => `${String(p.done)} / ${p.total}`,
    report: 'Rapor',
    none: 'Henüz bakım işi yok.',
    stepUp: 'Bakım işini başlat',
  },
  recovery: {
    needsLabel: 'Hesap',
    title: 'Hesap kurtarma',
    sub: 'Doğrulayıcı sıfırlama, parola sıfırlama ve kilit açma. Her biri taze doğrulama kodu ister, denetim kaydına yazılır ve kullanıcıya bildirilir.',
    resetMfa: 'Doğrulayıcıyı sıfırla',
    resetMfaBody: (p: { user: string }) =>
      `${p.user} için doğrulayıcı uygulaması ve kurtarma kodları silinir, güvenilen cihazlar ve oturumlar kapanır. Bir sonraki girişte yeniden kurar.`,
    resetPassword: 'Parolayı sıfırla',
    resetPasswordBody: (p: { user: string }) =>
      `${p.user} için tek kullanımlık bir parola üretilir ve yalnız şimdi gösterilir; oturumları kapanır, ilk girişte yeni parola seçmesi istenir.`,
    unlock: 'Kilidi aç',
    unlockBody: (p: { user: string }) => `${p.user} için hatalı giriş kilidi kaldırılır.`,
    confirm: 'Evet, uygula',
    cancel: 'Vazgeç',
    reason: 'Neden (denetim kaydına yazılır)',
    tempPassword: 'Geçici parola (yalnız şimdi gösterilir)',
    tempPasswordHint: 'Kullanıcıya güvenli bir kanaldan ilet; ilk girişte değiştirmesi istenir.',
    done: 'Tamamlandı.',
    ownerApproval: 'Başka bir sahibin onayı gerekir',
    ownerApprovalBody: (p: { user: string }) =>
      `${p.user} bir sahip. Birden çok sahip varken başka bir sahibi sıfırlamak için ikinci bir sahibin onayı gerekir: istek oluşturulur, diğer sahip Senden bekleyenler'den onaylar.`,
    requested: 'Onay isteği oluşturuldu; ikinci bir sahip onaylayınca uygulanır.',
    approve: 'Onayla ve uygula',
    pendingTitle: 'Onay bekleyen kurtarma istekleri',
    pendingItem: (p: { action: string; user: string; by: string }) => `${p.by}: ${p.user} için ${p.action}`,
    locked: 'Kilitli',
    actions: {
      'reset-mfa': 'doğrulayıcı sıfırlama',
      'reset-password': 'parola sıfırlama',
      unlock: 'kilit açma',
    } as Record<string, string>,
    stepUp: (p: { user: string }) => `${p.user} hesabını kurtar`,
  },
};
