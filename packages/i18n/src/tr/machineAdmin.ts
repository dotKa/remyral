/**
 * p14-i18n-screens-b (i18n Phase 5): Makine → Yönetim (erişim, makine servisini yeniden başlatma, makine yönetimi),
 * Makine → Etkinlik (geçmiş, günlükler, tanılama, uzak işlemler) and Makine → Genel bakış → Kapasite (paralel işler,
 * kapasite modu, slotlar ve Acil ayrımı, paket önbellekleri).
 */
export default {
  cancel: 'Vazgeç',
  details: 'Ayrıntılar',
  close: 'Kapat',
  configuration: 'Yapılandırma',
  /** Step-up prompt after "<machine>: <what>". */
  stepUp: (p: { machine: string; what: string }) =>
    `${p.machine}: ${p.what} — güncel doğrulama kodunu girin.`,
  /** The state of a remote operation (restart). */
  opState: {
    sent: 'Gönderildi',
    accepted: 'Başladı',
    running: 'Sürüyor',
    waiting_for_user: 'Sizi bekliyor',
    succeeded: 'Başarılı',
    failed: 'Başarısız',
    refused: 'Reddedildi',
    lost: 'Kayboldu',
    cancelled: 'İptal edildi',
  },

  lifecycle: {
    title: 'Erişim',
    sub: 'Makinenin cihaz anahtarı ve yeni iş alıp almadığı. Her eylem güncel bir doğrulama kodu ister.',
    none: 'Bu makinede şu an yapılacak bir erişim işlemi yok.',
    archiveConfirm: (p: { machine: string }) =>
      `${p.machine} makine listesinden kaldırılsın mı? Hiçbir şey silinmez: geçmişi ve denetim kaydı durur, cihaz anahtarı reddedilmeye devam eder. Arşivdekileri gösterip sonra arşivden çıkarabilirsiniz.`,
    actionsLabel: 'Erişim işlemleri',
    deviceKeys: 'Cihaz anahtarları',
    actions: {
      drain: {
        label: 'Boşalt',
        hint: 'Çalışan işleri bitirir, sonra yeni iş almaz.',
        confirm: 'Boşaltmayı onayla',
      },
      rotate: {
        label: 'Anahtarı yenile',
        hint: 'Makine yeni bir cihaz anahtarı oluşturur; onu burada onaylarsınız.',
      },
      approveRotation: {
        label: 'Yeni anahtarı onayla',
        hint: 'Makine cihaz anahtarını değiştirmek istedi.',
      },
      revoke: {
        label: 'Anahtarı iptal et',
        hint: 'Cihaz anahtarını kalıcı olarak reddeder. Makinenin yeniden eşlenmesi gerekir.',
        confirm: 'İptali onayla',
      },
      archive: {
        label: 'Listeden kaldır',
        hint: 'Listeden gizler. Geçmiş ve denetim kaydı durur.',
        confirm: 'Kaldırmayı onayla',
      },
      unarchive: {
        label: 'Arşivden çıkar',
        hint: 'Makineyi listede yeniden gösterir.',
      },
    },
    keyState: {
      active: 'Etkin',
      pending: 'Onay bekliyor',
      revoked: 'İptal edildi',
      superseded: 'Yenisiyle değişti',
    },
  },

  restart: {
    title: 'Makine servisini yeniden başlat',
    sub: 'Makine servisi, servis yöneticisiyle yeniden başlar; cihaz anahtarı ve yapılandırma aynı kalır.',
    loading: 'Yeniden başlatma durumu yükleniyor',
    notManaged:
      'Makine servisi bir servis yöneticisi altında çalışmıyor; yeniden başlatılırsa kendiliğinden geri gelemez.',
    unsupported: 'Bu makinedeki Remyral sürümü uzaktan yeniden başlatılamaz. Önce güncelleyin.',
    why: 'Makine servisini yeniden başlat — güncel doğrulama kodunu girin.',
    drain: 'Önce çalışan işleri bekle (bu sırada yeni iş başlamaz)',
    giveUp: 'Şu kadar dakika sonra vazgeç',
    stopNote: 'Çalışan işler durdurulur; master onları yeniden başlatmadan sonra uzlaştırır.',
    notConnected: 'Makine bağlı değil; bağlandığında yeniden başlatabilirsiniz.',
    button: 'Makine servisini yeniden başlat',
    confirm: 'Yeniden başlatmayı onayla',
    op: 'Yeniden başlatma',
  },

  admin: {
    title: 'Makine yönetimi',
    intro:
      'Bir yapay zeka ajanının bu makinede root / Administrator yetkisiyle komut çalıştırması. Her komut master tarafından imzalanır, kaydedilir ve denetlenir.',
    loading: 'Makine yönetimi yükleniyor',
    unsupported:
      'Bu makinedeki Remyral sürümü makine yönetimini çalıştıramaz; önce makineyi güncelleyin (Ayarlar → sürümler).',
    status: 'Durum',
    ownerOnly: 'Makine yönetimini yalnızca bir sahip (owner) açıp kapatabilir.',
    on: 'Açık',
    off: 'Kapalı',
    autoApproveOn: 'tam erişim izinli (tümüne izin veren işlerin komutları onaysız çalışır)',
    autoApproveOff: 'her yetkili komut bir onay ister',
    helper: 'Ayrıcalıklı yardımcı',
    helperInstalled: 'Kullanılabilir',
    helperMissing: 'Kullanılamıyor',
    helperUnknown: 'Bilinmiyor',
    /** p17-worker-1-1-1: why the root/SYSTEM helper cannot start admin sessions (the worker's readiness probe). */
    helperReason: {
      install_dir_unknown: 'Makine yazılımı kurulum klasörünü bilmiyor.',
      helper_missing: 'Ayrıcalıklı yardımcı kurulu değil (imzalı güncelleyici olmadan kurulmuş).',
      helper_outdated:
        'Kurulu ayrıcalıklı yardımcı makine yönetiminden eski; bu sürümün kurulum paketini bir kez yönetici / root olarak yeniden çalıştırın.',
      admin_unit_missing:
        'Yönetim oturumlarını başlatan systemd tetikleyicisi kurulu değil; kurulum paketini bir kez root olarak yeniden çalıştırın.',
      admin_unit_disabled:
        'Yönetim oturumlarını başlatan systemd tetikleyicisi etkin değil; kurulum paketini bir kez root olarak yeniden çalıştırın.',
      state_dir_not_traversable:
        'Makine yazılımının hesabı yardımcının yanıt klasörüne (state/machine-admin) erişemiyor; bu sürümün kurulum paketini bir kez root olarak yeniden çalıştırın.',
      admin_task_missing:
        'Yönetim oturumlarının zamanlanmış görevi (RemyralWorkerAdmin) bulunamadı; kurulum paketini bir kez Yönetici olarak yeniden çalıştırın.',
      admin_task_unreadable: 'Yönetim oturumlarının zamanlanmış görevi (RemyralWorkerAdmin) sorgulanamadı.',
      admin_plist_missing:
        'Yönetim oturumlarının LaunchDaemon’ı kurulu değil; kurulum paketini bir kez yönetici olarak yeniden çalıştırın.',
      probe_failed: 'Hazırlık denetimi tamamlanamadı.',
      helper_not_bound:
        'Makine yönetimi henüz bu makinenin çalışanına bağlanmadı; yardımcı her oturumu reddediyor. Yazdırılan parmak izini bu sayfayla karşılaştırdıktan sonra makinede bir kez root / Yönetici olarak şunu çalıştırın (ya da kurulum paketini yeniden çalıştırın):',
      helper_bound_elsewhere:
        'Bu makinedeki yardımcı başka bir çalışan kimliğine hizmet ediyor (makine yeniden mi eşlendi?). Parmak izini bu sayfayla karşılaştırdıktan sonra makinede bir kez root / Yönetici olarak şunu çalıştırın:',
      host_unconfined:
        'Bu makinedeki host işleri dosya sistemi kısıtlaması olmadan çalışıyor; bu yüzden yardımcı makine yönetimini reddediyor. Kısıtlamayı etkinleştirin (Sandbox sekmesi) ya da makinenin yerel yapılandırmasında açıkça izin verin (localCeiling.allowMachineAdmin: true).',
    },
    runningJob: 'Çalışan iş',
    notReported: 'Makine, makine yönetimi durumunu henüz bildirmedi.',
    vetoBefore: 'Makinenin yerel yapılandırması makine yönetimini yasaklıyor (',
    vetoAfter: '); paneldeki ayarın orada etkisi yok.',
    notApplied: 'Makine değişikliği henüz uygulamadı.',
    switchWhy: (p: { machine: string; enable: boolean }) =>
      `${p.machine} üzerinde makine yönetimini ${p.enable ? 'aç' : 'kapat'} — yeni bir doğrulama kodu girin.`,
    warningTitle: 'Bunu açmadan önce',
    warning: (p: { machine: string }) =>
      `Makine yönetimi bir yapay zeka ajanının ${p.machine} üzerinde root / Administrator / SYSTEM olarak komut çalıştırmasına izin verir: yazılım kurup kaldırma, servisler, kullanıcılar, güvenlik duvarı ve sistem dosyaları. Her komut tek bir iş için master tarafından imzalanır, kaydedilir, denetlenir ve tam erişim aşağıda ve Machines projesinde açık değilse bir insan onayı ister. Ajanın okuduğu bir içerikteki komut enjeksiyonu bunu kötüye kullanmayı deneyebilir — yalnızca anladığınız komutları onaylayın. Makinenin yerel yapılandırması bunu engelleyebilir. Her değişiklik sahiplere bildirilir.`,
    autoApprove: 'Tam erişime izin ver (tümüne izin veren işlerin yetkili komutları onaysız çalışır)',
    autoApproveHint:
      'Machines projesinde de “otomatik onaya izin ver” gerekir (Projeler → machines → Politika). Her komut yine kaydedilir.',
    projectNoteBefore: 'Machines projesi henüz otomatik onaya izin vermiyor: bir yönetici',
    projectNoteLink: 'Projeler',
    projectNoteAfter: ' ekranında açana kadar komutlar yine onay ister.',
    disable: 'Makine yönetimini kapat',
    saveAutoApprove: 'Tam erişim ayarını kaydet',
    enable: 'Makine yönetimini aç…',
    enableConfirm: 'Anladım — makine yönetimini aç',
    taskTitle: 'Yeni makine görevi',
    taskSub: 'Ajana bu makinede ne yapması gerektiğini anlatın. Görev sıradan bir iş olarak açılır.',
    taskForm: (p: { machine: string }) => `${p.machine} üzerinde yeni makine görevi`,
    taskWhy: (p: { machine: string }) =>
      `${p.machine} üzerinde makine yönetimi işi başlat — yeni bir doğrulama kodu girin.`,
    taskName: 'Başlık',
    taskPrompt: 'Ajan bu makinede ne yapsın?',
    approvals: 'Onaylar',
    askAll: 'Her yetkili komut için sor (önerilen)',
    allowAll: 'Tam erişim — onay sorma',
    maxMinutes: 'En uzun süre (dakika)',
    noFullAccess: 'Tam erişim bu makine ya da Machines projesi için izinli değil; her komut onay ister.',
    startTask: 'Makine görevini başlat',
    started: 'Başladı.',
    taskLink: 'Makine görevi',
    commandsTitle: 'Son yetkili komutlar',
    commandsNone: 'Bu makinede henüz yetkili bir komut çalışmadı.',
    commandsLabel: 'Yetkili komutlar',
    autoApproved: 'onaysız çalıştı',
    exitCode: (p: { code: number }) => `çıkış ${String(p.code)}`,
    commandDetails: (p: { summary: string }) => `${p.summary}: ayrıntılar`,
    commandJob: 'Komutun işi',
    /** p17-worker-1-1-1: the agent's stated purpose of an elevated command. */
    purpose: 'Amaç (ajanın açıklaması, doğrulanmadı)',
    fileLine: (p: { path: string; bytes: number; before: string | null; after: string | null }) =>
      `${p.path} · ${String(p.bytes)} bayt · sha256 ${p.before ?? 'yeni'} → ${p.after ?? '—'}`,
    output: 'Çıktı',
    truncated: '[kısaltıldı]',
    cmdState: {
      requested: 'İstendi',
      pending: 'Onay bekliyor',
      granted: 'İzin verildi',
      denied: 'Reddedildi',
      succeeded: 'Başarılı',
      failed: 'Başarısız',
      refused: 'Geri çevrildi',
    },
    kind: {
      exec: 'Komut',
      write_file: 'Dosya yazma',
      read_file: 'Dosya okuma',
    },
    memoryTitle: 'Makine hafızası',
    memoryUpdated: (p: { at: string }) => `güncellendi ${p.at}`,
    memorySub:
      'Önceki makine yönetimi işlerinin kurduğu ya da değiştirdiği şeyler; bu makinedeki her yeni iş bunu okur.',
    memoryWhy: 'Makine hafızasını kaydetmek güncel bir doğrulama kodu ister.',
    memorySave: 'Hafızayı kaydet',
    memoryEmpty: 'Henüz bir şey kaydedilmedi.',
    memoryEdit: 'Hafızayı düzenle',
  },

  activity: {
    historyTitle: 'Geçmiş',
    historySub: 'Eşleşme, bağlantılar, anahtar değişiklikleri ve güncellemeler; en yenisi üstte.',
    historyLoading: 'Geçmiş yükleniyor',
    historyEmpty: 'Henüz olay yok.',
    more: (p: { n: number }) => `Daha fazla göster (${String(p.n)})`,
    action: {
      pairingRequest: 'Eşleşme istendi',
      approve: 'Onaylandı',
      deny: 'Kayıt reddedildi',
      sessionStart: 'Bağlandı',
      sessionEnd: 'Bağlantı koptu',
      drain: 'Boşaltma istendi',
      revoke: 'Anahtarı iptal edildi',
      archive: 'Listeden kaldırıldı',
      unarchive: 'Listeye geri döndü',
      rotateRequest: 'Anahtar yenileme istendi',
      rotate: 'Anahtar yenilendi',
      rotateApprove: 'Yeni anahtar onaylandı',
      runtimePolicyAssign: 'Runtime politikası atandı',
      updateOffer: 'Güncelleme önerildi',
      updateTarget: 'Güncelleme hedefi belirlendi',
    },
    outcome: {
      failure: 'başarısız',
      denied: 'reddedildi',
      error: 'hata',
    },
  },

  ops: {
    title: 'Uzak işlemler',
    loading: 'İşlemler yükleniyor',
    unsupportedTitle: 'Bu makinedeki Remyral sürümü günlük ve tanılamayı uzaktan gönderemiyor',
    unsupported: 'Önce makineyi güncelleyin (Ayarlar → sürümler).',
    logsTitle: 'Makine günlükleri',
    logsSub:
      'İstendiğinde makineden alınır; makinede maskelenmiş olarak gelir ve yalnız metin olarak gösterilir.',
    logLabel: 'Makine günlüğü',
    lines: (p: { n: number }) => `${String(p.n)} satır`,
    noLines: 'Henüz satır yok.',
    logWhy: (p: { machine: string; source: string }) => `${p.machine}: ${p.source} günlüğünü al`,
    log: 'Günlük',
    source: {
      worker: 'makine servisi',
      boot: 'açılış',
      updater: 'güncelleyici',
    },
    sourceOption: {
      worker: 'Makine servisi',
      boot: 'Açılış (başlatma hataları)',
      updater: 'Güncelleyici',
    },
    lineCount: 'Satır',
    fetch: 'Günlüğü al',
    needsConnection: 'Günlük ve tanılama bağlı bir makine ister.',
    logTruncated: 'Eski satırlar dışarıda kaldı (satır / boyut sınırı).',
    diagTitle: 'Tanılama',
    diagSub:
      'Makine sürümü, Node, işletim sistemi, bellek ve disk, sandbox profilleri, runtime’lar ve bulunan sorunlar.',
    diagWhy: (p: { machine: string }) => `${p.machine}: tanılamayı çalıştır`,
    diagRun: 'Tanılamayı çalıştır',
    diagNotRun: 'Henüz çalıştırılmadı.',
    historyTitle: 'Uzak işlemler',
    opCount: (p: { n: number }) => `${String(p.n)} işlem`,
    historySub: 'Bu makinede istenen kurulumlar, oturumlar, yeniden başlatmalar, günlükler ve tanılamalar.',
    historyEmpty: 'Henüz işlem yok.',
  },

  diag: {
    disk: 'Disk',
    version: 'Sürüm',
    system: 'Sistem',
    service: 'Servis',
    memory: 'Bellek',
    nodeOk: 'uygun',
    nodeNeeds: (p: { major: number }) => `${String(p.major)}+ gerekli`,
    memoryFree: (p: { total: string; free: string }) => `${p.total} içinde ${p.free} boş`,
    diskFree: (p: { name: string; free: string }) => `${p.name} ${p.free} boş`,
    sandboxProfiles: 'Sandbox profilleri',
    ready: 'hazır',
    notReady: 'hazır değil',
    runtimes: 'Runtime’lar',
    runtimeLine: (p: {
      version: string | null;
      source: string;
      enabled: boolean;
      auth: string;
      integrity: string | null;
    }) =>
      `${p.version ?? 'bulunamadı'} (${p.source}${p.enabled ? ', etkin' : ''}, oturum ${p.auth}${p.integrity === null ? '' : `, bütünlük ${p.integrity}`})`,
    noProblems: 'Sorun bulunmadı.',
  },

  capacity: {
    title: 'Kapasite',
  },

  advice: {
    title: 'Paralel işler',
    recommended: (p: {
      n: number;
      cpus: number;
      ram: string;
      runtime: string;
      estimated: boolean;
      peak: string;
    }) =>
      `Önerilen: ${String(p.n)} paralel iş — ${String(p.cpus)} CPU, ${p.ram} RAM, ${p.runtime} ${p.estimated ? 'tahminen' : 'genelde en çok'} ~${p.peak} kullanıyor`,
    peakMeasured: (p: { n: number }) => `bu makinede ${String(p.n)} işte ölçüldü`,
    peakFleet: 'diğer makinelerde ölçüldü',
    peakEstimateSome: (p: { n: number }) => `tahmin (burada şimdiye kadar yalnız ${String(p.n)} iş ölçüldü)`,
    peakEstimateNone: 'tahmin; henüz ölçülen iş yok',
    panel: (p: { n: string }) => `Panel yapılandırmasının dediği gibi aynı anda ${p.n} iş çalıştırıyor.`,
    localCeiling: (p: { n: string; configured: string; ceiling: string }) =>
      `Aynı anda ${p.n} iş çalıştırıyor: panel yapılandırması ${p.configured} diyor ama makinenin yerel ayar dosyası ${p.ceiling} ile sınırlıyor (localCeiling.maxParallelJobs ya da maxParallelJobs). Bunu yalnızca makinedeki biri yükseltebilir.`,
    pending: (p: { n: string; configured: string }) =>
      `Yerel ayar dosyasından aynı anda ${p.n} iş çalıştırıyor; panel yapılandırmasındaki ${p.configured} henüz uygulanmadı.`,
    localFile: (p: { n: string }) =>
      `Yerel ayar dosyasından aynı anda ${p.n} iş çalıştırıyor (varsayılan 1); panelden yönetilmiyor.`,
    unknown: 'Makine aynı anda kaç iş çalıştırdığını henüz bildirmedi.',
    why: (p: { n: number }) => `${String(p.n)} paralel iş`,
    saved: (p: { n: number }) => `Kaydedildi: ${String(p.n)} paralel iş. Makine bağlandığında uygular.`,
    cpuLimited: (p: { byMemory: number }) =>
      `CPU sınırlıyor (çekirdek başına 2 iş, biri boş tutulur). Bellek ${String(p.byMemory)} işe izin verirdi.`,
    memoryLimited: (p: { reserve: string; usable: string; perJob: string }) =>
      `Bellek sınırlıyor: ${p.reserve} ayrıldıktan sonra ${p.usable} kullanılabilir, iş başına ${p.perJob} hesaplandı.`,
    peakLine: (p: { runtime: string; source: string }) => `${p.runtime}: ${p.source}.`,
    none: 'Öneri yok: makine CPU ve bellek bilgisini bildirmedi.',
    auto: (p: { slots: number; configured: string }) =>
      `Otomatik kapasite açık: master şu an en çok ${String(p.slots)} paralel iş gönderiyor; yapılandırmadaki ${p.configured} yalnızca üst sınır. Aşağıdaki Kapasite modu’na bakın.`,
    above: (p: { managed: boolean; n: number; recommended: number }) =>
      `${p.managed ? 'Panel yapılandırması' : 'Makine'} ${String(p.n)} paralel iş ${p.managed ? 'istiyor' : 'çalıştırıyor'}; bu, önerilen değerden (${String(p.recommended)}) fazla. İşler bellek için yarışıp makineyi yavaşlatabilir ya da başarısız olabilir.`,
    ceilingBelow: (p: { ceiling: number }) =>
      `Makinenin yerel ayar dosyası bunu ${String(p.ceiling)} ile sınırlıyor; öneriyi uygulamak bunun üstüne çıkamaz.`,
    apply: (p: { n: number }) => `${String(p.n)} paralel işi uygula`,
    applyNote: 'Makinenin panel yapılandırmasına yazar.',
    unmanaged: (p: { n: number }) =>
      `Uygulamak için bu makinenin yapılandırmasını Yapılandırma sekmesinde devralıp ${String(p.n)} paralel iş ayarlayın.`,
  },

  caches: {
    title: 'Paket önbellekleri',
    sub: 'Yalnızca güvenilen, makinede çalışan işler paylaşır; güvenilmeyen kaynaklar ve konteyner işleri asla.',
    changeLimit: 'Sınırı değiştir',
    notReported: 'Bildirilmedi: makine paylaşılan paket önbelleği olmayan bir sürüm çalıştırıyor.',
    offLocal: 'Kapalı: makinenin yerel ayar dosyası paket önbelleklerini kapatıyor (packageCaches.enabled).',
    offZero: 'Kapalı: boyut sınırı 0.',
    summary: (p: { max: string; used: string; pct: string; projects: number }) =>
      `${p.max} sınırın ${p.used} kadarı kullanılıyor (${p.pct}), ${String(p.projects)} proje.`,
    meter: 'Önbellek kullanımı',
    projects: 'Önbelleği olan projeler',
    inUse: 'kullanımda',
    lastUsed: (p: { at: string }) => `son kullanım ${p.at}`,
    truncated: 'Yalnızca en büyük projeler listelendi.',
    noEviction: 'Henüz bir şey çıkarılmadı.',
    eviction: (p: { at: string; projects: number; bytes: string }) =>
      `Son çıkarma ${p.at}: en uzun süredir kullanılmayan ${String(p.projects)} proje önbelleği, ${p.bytes}.`,
    scanned: (p: { at: string }) => ` Boyutlar ${p.at} itibarıyla.`,
    projectPolicy: 'Bir proje önbellekleri kendi yürütme politikasında kapatabilir.',
  },

  // p17-disk-selfclean: Makine → Genel bakış → Kapasite → Disk temizliği.
  disk: {
    title: 'Disk temizliği',
    sub: 'Makine yalnızca kendi oluşturduğu ve yeniden oluşturabildiği dosyaları siler; kullanıcı verisine, Docker imajlarına ve git aynalarına dokunmaz.',
    onPill: 'Açık',
    offPill: 'Kapalı',
    cleanNow: 'Şimdi temizle',
    why: (p: { machine: string }) => `${p.machine} üzerinde disk temizliği`,
    what: 'Disk temizliği',
    notSupported: 'Bu makine sürümü kendi diskini temizleyemiyor; makineyi güncelleyin.',
    notReported: 'Henüz bildirilmedi.',
    offline: 'Makine çevrimdışı: temizlik bağlanınca başlatılabilir.',
    on: (p: { target: string; threshold: string; margin: string }) =>
      `Açık: boş alan ${p.target} altına inince kendiliğinden temizler (en az boş disk ${p.threshold} + pay ${p.margin}).`,
    off: 'Kapalı: makine kendiliğinden temizlemiyor. “Şimdi temizle” yine çalışır.',
    free: (p: { free: string; at: string }) => `Boş: ${p.free} (${p.at}).`,
    noRun: 'Henüz temizlik yapılmadı.',
    lastRun: (p: { at: string; trigger: string; freed: string }) =>
      `Son temizlik ${p.at} (${p.trigger}): ${p.freed} açıldı.`,
    trigger: { low_disk: 'disk azaldı', daily: 'günlük', manual: 'elle' },
    freedLabel: 'Açılan yer',
    category: {
      temp: 'Biten işlerin geçici klasörleri',
      logs: 'Eski günlükler',
      releases: 'İndirilen sürümler',
      workspaces: 'Süresi dolan çalışma klasörleri',
      runtimes: 'Kullanılmayan runtime sürümleri',
      packageCaches: 'Paket önbellekleri',
    },
    items: (p: { n: number }) => `${String(p.n)} öğe`,
    skipped: (p: { n: number }) =>
      `${String(p.n)} öğe başka bir hesaba ait (iş başına hesapların klasörleri); silinmedi, hata değil.`,
    errors: (p: { n: number }) => `${String(p.n)} öğe silinemedi (makinenin günlüğünde yazıyor).`,
    stillLow:
      'Temizlikten sonra da boş alan hedefin altında: makinenin silebileceği bir şey kalmadı. Yeri neyin kapladığı aşağıda.',
    nextDaily: (p: { at: string }) => `Sonraki günlük temizlik ${p.at}.`,
    nextLowDisk: (p: { at: string }) => `Sonraki otomatik temizlik en erken ${p.at}.`,
    changeSettings: 'Ayarları değiştir',
    usageTitle: (p: { at: string }) => `Yer kullanımı (${p.at})`,
    usageData: 'Makine verisi',
    usageWorkspace: 'Çalışma kökü',
    usageName: { 'workspace-root': 'çalışma kökü', other: 'diğer' },
    usagePartial: 'Boyutlar en az bu kadar: tarama sınırına ulaşıldı.',
  },

  slots: {
    title: 'Slotlar ve Acil ayrımı',
    sub: 'Acil işler için ayrılan slotlar; normal ve arka plan işleri kalanları görür.',
    slots: (p: { n: number }) => `${String(p.n)} slot`,
    profile: {
      'host-restricted': 'makinede',
      'runtime-sandbox': 'runtime sandbox’ı',
      container: 'konteyner',
      unconfined: 'sınırsız',
    },
    exclusive: (p: { profiles: string }) =>
      ` · ${p.profiles} tek başına çalışır (denemeler arasında yalıtım yok)`,
    noReserve: 'Bu makinede Acil işler için slot ayrılmıyor.',
    reserve: (p: { n: number }) => `${String(p.n)} slot Acil işler için ayrılıyor.`,
    defaultMark: ' (varsayılan)',
    reserveLabel: 'Acil ayrımı',
    reserveDefault: 'Varsayılan (3 slottan itibaren 1)',
    save: 'Ayrımı kaydet',
    why: (p: { machine: string }) =>
      `${p.machine} makinesinin Acil ayrımını değiştir — güncel doğrulama kodunu girin.`,
    saved: 'Acil ayrımı kaydedildi.',
    note: 'Varsayılan olarak yalnızca en az üç slotu olan makinelerde bir slot ayrılır; iki slotlu bir makine iki normal iş çalıştırır. Bu makinede zaten çalışan bir işin alt işi (ya da entegrasyon işi) ayrılan slotu her zaman kullanabilir; böylece bir iş kendi alt işini beklemez.',
  },

  mode: {
    title: 'Kapasite modu',
    modes: {
      manual: {
        label: 'Elle',
        hint: 'Yapılandırmanın dediğini çalıştırır. Hiçbir şey ölçülmez ya da değişmez.',
      },
      suggest: {
        label: 'Öneri',
        hint: 'Makineyi ölçer ve bir değer önerir (bildirimle). Kararı siz verirsiniz.',
      },
      auto: {
        label: 'Otomatik',
        hint: 'Master, gönderdiği paralel iş sayısını sizin sınırlarınız içinde birer birer artırır ya da azaltır.',
      },
    },
    upperHardware: 'donanım tavanı (CPU ve iş başına bellek)',
    upperMachine: 'makinenin kendi sınırı (yerel ayar dosyası ya da henüz uygulanmamış bir yapılandırma)',
    upperYours: 'sizin üst sınırınız',
    sentenceManual: (p: { n: string }) => `Elle: yapılandırıldığı gibi aynı anda ${p.n} iş çalıştırıyor.`,
    sentenceSuggest: (p: { n: string }) =>
      `Öneri: yapılandırıldığı gibi aynı anda ${p.n} iş çalıştırıyor; master ölçüp öneriyor, hiçbir şey kendiliğinden değişmiyor.`,
    sentenceAuto: (p: { slots: number; min: number; max: number; upper: number; reason: string }) =>
      `Otomatik: şu an ${String(p.slots)} paralel iş, ${String(p.min)} ile ${String(p.max)} arasında; üst sınır ${String(p.upper)} — ${p.reason}.`,
    decision: {
      raise: 'Artırıldı',
      lower: 'Azaltıldı',
      clamp: 'Sınırların içine alındı',
      hold: 'Aynı kalıyor',
    },
    event: {
      raise: 'Artırıldı',
      lower: 'Azaltıldı',
      clamp: 'Sınırların içine alındı',
      suggest: 'Önerildi',
      mode: 'Mod değişti',
      bounds: 'Sınırlar değişti',
      override: 'Elle değer',
    },
    metric: {
      cpu: (p: { pct: number }) => `CPU %${String(p.pct)}`,
      memoryFree: (p: { total: string | null; free: string }) =>
        `${p.total === null ? '' : `${p.total} belleğin `}${p.free} kadarı boş`,
      swap: (p: { used: string; total: string }) => `takas ${p.used} / ${p.total}`,
      swapIn: (p: { n: number }) => `takas girişi ${String(p.n)}/sn`,
      commit: (p: { pct: number }) => `commit %${String(p.pct)}`,
      pressure: (p: { pct: number }) => `bellek beklemesi %${String(p.pct)}`,
      running: (p: { n: number }) => `${String(p.n)} çalışıyor`,
      waiting: (p: { n: number }) => `${String(p.n)} slot bekliyor`,
      oom: (p: { n: number }) => `${String(p.n)} iş bellek yetmedi`,
      timeouts: (p: { n: number }) => `${String(p.n)} iş zaman aşımı`,
    },
    chartLabel: (p: { from: string; to: string; n: number }) =>
      `Zaman içinde paralel işler: ${p.from} değerinden ${p.to} değerine, ${String(p.n)} değişiklik kaydedildi.`,
    now: 'şimdi',
    legend: (p: { auto: boolean; dots: boolean }) =>
      `Çizgi: geçerli paralel iş sayısı${p.auto ? '; kesikli: üst sınır' : ''}${p.dots ? '; noktalar: öneriler' : ''}.`,
    closed:
      'Elle: makine yapılandırmasının dediğini çalıştırır. Master onu ölçüp bir değer önerebilir ya da sizin belirlediğiniz sınırlar içinde kendisi ayarlayabilir.',
    setUp: 'Kur',
    loading: 'Kapasite yükleniyor',
    boundsError: 'Tam sayı girin: 1 ≤ en az ≤ en çok ≤ 64.',
    why: (p: { mode: string }) => `kapasite modu ${p.mode}`,
    savedAuto: (p: { min: number; max: number }) =>
      `Kaydedildi: ${String(p.min)} ile ${String(p.max)} arasında otomatik. Makinenin yapılandırması artık ${String(p.max)} işe izin veriyor; master en çok otomatik değeri gönderir.`,
    savedMode: (p: { mode: string }) => `Kaydedildi: ${p.mode} mod.`,
    metricsMissing:
      'Bu makinedeki Remyral sürümü kapasite ölçümlerini göndermiyor (Windows’ta CPU, macOS’ta boş bellek, takas ve bellek baskısı). Makineyi güncelleyin; o zamana kadar otomatik mod yalnızca hatalarda azaltır, hiç artırmaz.',
    suggestion: (p: { n: number; current: number | null }) =>
      `Öneri: ${String(p.n)} paralel iş${p.current === null ? '' : ` (şu an ${String(p.current)})`}`,
    noSuggestion: 'Henüz öneri yok: master’ın 10 dakikalık ölçüme ihtiyacı var.',
    reasons: 'Neden',
    measured: (p: { at: string | null }) => `Ölçüm${p.at === null ? '' : ` ${p.at}`}:`,
    howTitle: 'Otomatik kapasite nasıl karar verir',
    how1: 'Asla sizin üst sınırınızın, donanım tavanının ya da makinenin kendi sınırının üstüne, alt sınırınızın altına inmez.',
    how2: 'Baskı altında — az boş bellek, takas, yüksek commit, CPU doygunluğu, belleği yetmeyen bir iş ya da tekrarlanan zaman aşımları — hemen bir azaltır (en çok dakikada bir).',
    how3: 'Yalnızca burada slot bekleyen işler varken, her slot doluyken ve makinenin 5 dakikadır payı varken bir artırır; her değişiklikten 10 dakika, azaltmadan 30 dakika sonra.',
    how4: 'Çalışan işler asla durdurulmaz: düşük bir değer yalnızca daha az yeni iş demektir.',
    how5: 'Paralel iş sayısını elle değiştirmek (Yapılandırma, Uygula) otomatik modu kapatır.',
    historyLabel: 'Kapasite geçmişi',
    byAdmin: 'bir yönetici',
    byMaster: 'master',
    modeLegend: 'Mod',
    min: 'En az',
    max: 'En çok',
    hardwareCeiling: (p: { n: number }) => `Donanım tavanı ${String(p.n)}`,
    autoUnmanaged:
      'Otomatik kapasite panelden yönetilen bir makine ister: önce Yapılandırma sekmesinde yapılandırmasını devralın. Öneri modu onsuz da çalışır.',
    save: 'Kapasite modunu kaydet',
  },
};
