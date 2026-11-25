/**
 * p18-multi-project W1 + W2: paylaşılan workflow'lar — sahip projede "Paylaş" ve "Nerede kullanılıyor", hedef projede
 * "Paylaşılan workflow ekle", "Bu projedeki ayarlar" (etkin / devre dışı, takip / sabit, bekleyen sürüm, gizli anahtar
 * yuvaları, girdi varsayılanları, onaylayıcı rolleri, tetikleyiciler, hata workflow'u, saklama süresi) ve "Projeye
 * kopyala".
 */
export default {
  share: {
    open: 'Paylaş',
    title: 'Workflow’u paylaş',
    sub: 'Seçtiğin projelerin yöneticileri bu workflow’u kendi projelerine bağlayabilir. Her çalıştırma bağlayan projede, onun deposu, izinleri ve onaylayıcılarıyla çalışır; workflow yalnızca bu projede düzenlenir.',
    none: 'Paylaşılmıyor',
    all: 'Tüm projeler',
    selected: 'Seçili projeler',
    projects: 'Projeler',
    noOtherProjects: 'Paylaşılacak başka proje yok.',
    save: 'Paylaşımı kaydet',
    saved: 'Paylaşım güncellendi.',
    stepUp: 'Bir workflow’u paylaşmak için doğrulama kodu gerekiyor.',
    noPermission: 'Paylaşmak için bu projede yönetici olman gerekir.',
    withdrawNote:
      'Paylaşımdan çıkardığın projelerdeki bağlantılar kalır; yeni sürümleri artık kendiliğinden almazlar.',
  },
  used: {
    title: 'Nerede kullanılıyor',
    none: 'Henüz hiçbir proje bu workflow’u bağlamadı.',
    hidden: (p: { n: number }) => `Göremediğin ${String(p.n)} proje daha bağladı.`,
    loading: 'Bağlayan projeler yükleniyor…',
    follow: { auto: 'Takip ediyor', pin: 'Sabit' },
    state: { enabled: 'Etkin', disabled: 'Devre dışı', detached: 'Ayrıldı' },
    pending: (p: { version: number }) => `v${String(p.version)} onay bekliyor`,
    neverRan: 'Hiç çalışmadı',
    lastRun: (p: { state: string; ago: string }) => `Son çalışma: ${p.state}, ${p.ago}`,
  },
  list: {
    sharedPill: (p: { owner: string }) => `Paylaşılan · ${p.owner}`,
    pendingPill: 'Güncelleme onay bekliyor',
    disabledPill: 'Devre dışı',
    add: 'Paylaşılan workflow ekle',
    settings: 'Bu projedeki ayarlar',
    copyToProject: 'Projeye kopyala',
  },
  offers: {
    title: 'Paylaşılan workflow ekle',
    sub: 'Başka projelerin bu projeye paylaştığı workflow’lar. Bağladığında bu projede, bu projenin deposu, izinleri ve onaylayıcılarıyla çalışır.',
    project: 'Proje',
    loading: 'Paylaşılan workflow’lar yükleniyor…',
    none: 'Bu projeye paylaşılan workflow yok.',
    from: (p: { owner: string; version: number; n: number }) =>
      `${p.owner} · v${String(p.version)} · ${String(p.n)} adım`,
    attached: 'Bağlı',
    nameTaken: 'Bu projede aynı adda bir workflow var; önce kopyalayıp başka adla kullanabilirsin.',
    attach: 'Bağla',
    attachAria: (p: { name: string }) => `${p.name}: bağla`,
    stepUp: 'Ağ, deploy ya da kod adımı olan bir workflow’u bağlamak için doğrulama kodu gerekiyor.',
    attachedNotice: (p: { name: string }) => `${p.name} bağlandı.`,
    disabledNotice: (p: { slots: string }) =>
      `Gizli anahtar yuvaları bağlanana kadar devre dışı: ${p.slots}. "Bu projedeki ayarlar"dan bağla.`,
    noAdmin: 'Workflow bağlamak için bir projede yönetici olman gerekir.',
  },
  attachment: {
    title: 'Bu projedeki ayarlar',
    sub: (p: { owner: string; project: string }) =>
      `${p.owner} projesinin workflow’u ${p.project} projesinde bu ayarlarla çalışır.`,
    loading: 'Ayarlar yükleniyor…',
    readOnly:
      'Bu workflow başka bir projeye ait; burada salt okunur. Değiştirmek istersen projeye kopyala ve kendi workflow’un olarak düzenle.',
    state: 'Durum',
    enabled: 'Etkin',
    disabled: 'Devre dışı',
    enable: 'Etkinleştir',
    disable: 'Devre dışı bırak',
    version: 'Sürüm',
    runs: (p: { version: number; latest: number }) =>
      `Bu proje v${String(p.version)} sürümünü çalıştırıyor (sahibin son sürümü v${String(p.latest)}).`,
    follow: 'Yeni sürümler',
    followAuto: 'Takip et — ayrıcalıksız değişiklikler kendiliğinden gelir',
    followPin: 'Sabit — yalnızca elle geçilir',
    pending: (p: { version: number }) => `v${String(p.version)} bu projenin yöneticisinin onayını bekliyor.`,
    pendingReason: {
      privileged: 'Ağ, deploy ya da kod adımı ekliyor veya değiştiriyor.',
      inputs: 'Bu projede varsayılanı olmayan yeni zorunlu girdiler istiyor.',
      privileged_inputs:
        'Ağ, deploy ya da kod adımı ekliyor veya değiştiriyor ve varsayılanı olmayan yeni girdiler istiyor.',
    },
    review: 'Bu sürümü incele',
    accept: (p: { version: number }) => `v${String(p.version)} sürümünü kabul et`,
    acceptStepUp: 'Ayrıcalıklı adımları bu projeye kabul etmek için doğrulama kodu gerekiyor.',
    switchTo: 'Elle geçilecek sürüm',
    switchVersion: (p: { version: number }) => `v${String(p.version)}`,
    switch: 'Bu sürüme geç',
    ownerArchived: 'Sahip proje bu workflow’u arşivledi; burada da yeni çalıştırma başlamaz.',
    notOffered: 'Sahip proje artık bu projeye paylaşmıyor; yeni sürümler kendiliğinden gelmez.',
    slots: 'Gizli anahtar yuvaları',
    slotsSub:
      'Workflow’da yazan her kasa anahtarı bir yuvadır. Bu projede yalnızca burada bağlanan anahtar kullanılır; sahibin anahtarı asla.',
    slotHosts: (p: { kind: string; hosts: string; nodes: string }) =>
      `${p.kind} · ${p.hosts} · adımlar: ${p.nodes}`,
    bound: (p: { id: string }) => `Bağlı: ${p.id}`,
    unbound: 'Bağlı değil',
    credential: 'Kasa anahtarı',
    pick: 'Anahtar seç',
    bind: 'Bağla',
    unbind: 'Bağlantıyı kaldır',
    bindStepUp: 'Kasa anahtarı bağlamak için güncel bir doğrulama kodu gerekiyor.',
    settings: 'Bu projedeki değerler',
    inputs: 'Girdi varsayılanları',
    inputsHint: 'Bir çalıştırma girdiyi boş bırakırsa bu değer kullanılır.',
    approvers: 'Onaylayıcı rolleri',
    approversHint: 'Yalnızca yükseltilebilir; tanımdaki rolden düşüğü kabul edilmez.',
    approverOf: (p: { node: string }) => `${p.node} adımının onaylayıcısı`,
    asDefined: (p: { role: string }) => `Tanımdaki gibi (${p.role})`,
    roles: { operator: 'Operatör', admin: 'Yönetici', owner: 'Sahip' },
    triggers: 'Tetikleyiciler',
    triggersHint:
      'Tetikleyiciler bu projede ayrıca etkinleştirilir: kendi otomasyonu, webhook adresi ve gizli anahtarıyla.',
    cron: (p: { node: string }) => `${p.node}: zamanlama (cron)`,
    timeZone: (p: { node: string }) => `${p.node}: saat dilimi`,
    githubRepo: (p: { node: string }) => `${p.node}: GitHub deposu (sahip/ad)`,
    onFailure: 'Hata workflow’u',
    onFailureHint: 'Bu projedeki bir workflow adı (kendi ya da bağlı).',
    retention: 'Saklama süresi (gün)',
    concurrency: 'Aynı anda en çok çalıştırma',
    concurrencyHint: (p: { max: number }) => `Tanımdaki üst sınır: ${String(p.max)}; yalnızca düşürülebilir.`,
    repository: 'Depo adresi',
    baseRef: 'Temel branch',
    repositoryHint:
      'Boş bırakırsan projenin kayıtlı deposu kullanılır; sahibin deposu hiçbir zaman kullanılmaz.',
    save: 'Ayarları kaydet',
    saved: 'Ayarlar kaydedildi.',
    detach: 'Projeden ayır',
    detachConfirm: 'Ayır',
    detachQuestion: 'Bu proje workflow’u artık çalıştırmaz; tetikleyicileri durur, çalıştırma geçmişi kalır.',
    detached: (p: { name: string }) => `${p.name} bu projeden ayrıldı.`,
    copy: 'Projeye kopyala',
    report: {
      repositoryMissing:
        'Bu projenin kayıtlı deposu yok; kodla çalışan adımlar için depo kaydet ya da yukarıda bir depo gir.',
      egress: (p: { n: number }) =>
        `${String(p.n)} HTTP / e-posta adımı bu projenin çıkış izinlerine uymuyor; projenin HTTP izin listesine bak.`,
      unbound: (p: { slots: string }) => `Bağlanmamış yuvalar: ${p.slots}. Bağlanmadan etkinleştirilemez.`,
      privileged: (p: { nodes: string }) => `Ayrıcalıklı adımlar: ${p.nodes}.`,
    },
    noPermission: 'Bu ayarları yalnızca projenin yöneticileri değiştirebilir.',
  },
  editor: {
    sharedFrom: (p: { owner: string }) => `Paylaşılan · ${p.owner}`,
    pending: (p: { version: number }) => `v${String(p.version)} onay bekliyor`,
    savedSharing: (p: { advanced: number; pending: number }) =>
      `Bağlayan projeler: ${String(p.advanced)} proje yeni sürüme geçti, ${String(p.pending)} proje yöneticisinin onayını bekliyor.`,
    activationNote:
      'Paylaşılan workflow’un hangi sürümle çalışacağını bağlantının takip / sabit ayarı belirler.',
  },
  copy: {
    title: 'Projeye kopyala',
    description: (p: { name: string; project: string }) =>
      `${p.name}, ${p.project} projesinin kendi workflow’u olarak yeni bir adla kopyalanır; sahibin deposu kopyalanmaz.`,
    name: 'Yeni ad',
    copy: 'Kopyala',
    cancel: 'Vazgeç',
    suffix: '-kopya',
  },
};
