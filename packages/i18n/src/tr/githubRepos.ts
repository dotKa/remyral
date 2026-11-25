/**
 * p15-github-create-repo: Remyral GitHub'da private depo açar ve projeye bağlar — Ayarlar → Entegrasyonlar → GitHub →
 * "GitHub hesabı" (hesabı yetkilendirme, yedek yol olarak ince ayarlı belirteç), Projeler → Depo → "GitHub'da yeni
 * private repo aç", yeni proje sihirbazındaki seçenek ve sohbet kartı (`github_repo`).
 */
export default {
  accounts: {
    title: 'GitHub hesabı',
    sub: 'Kişisel GitHub hesabında depo açmak için Remyral’ın bu hesap adına işlem yapmasına bir kez izin verin. Belirteç yalnızca ana sunucuda şifreli tutulur; makinelere ve tarayıcıya gitmez.',
    authorize: 'GitHub hesabını yetkilendir',
    reauthorize: 'Yeniden yetkilendir',
    authorizeHint:
      'GitHub’a gidersiniz, bağlı GitHub App için “Authorize” dersiniz ve buraya dönersiniz. App’in “Administration: Read and write” izni olmalı.',
    stepUpAuthorize: 'GitHub hesabını yetkilendirmek için doğrulama kodu',
    noSecret: 'Bağlı App’in istemci sırrı bu sunucuda yok; aşağıdaki belirteç yolunu kullanın.',
    none: 'Henüz yetkilendirilmiş GitHub hesabı yok.',
    kinds: {
      app_user: 'GitHub App yetkisi',
      pat: 'Kişisel erişim belirteci',
    },
    expires: (p: { at: string }) => `Geçerlilik: ${p.at}`,
    renews: 'Süresi dolunca kendiliğinden yenilenir',
    noExpiry: 'Süresiz',
    unusable: 'Bu yetki artık kullanılamıyor: hesabı yeniden yetkilendirin.',
    remove: 'Kaldır',
    removeConfirm: (p: { login: string }) =>
      `${p.login} hesabının yetkisi Remyral’dan silinsin mi? GitHub tarafındaki izni GitHub → Settings → Applications’dan da kaldırabilirsiniz.`,
    stepUpRemove: 'GitHub hesabını kaldırmak için doğrulama kodu',
    removed: 'Hesap kaldırıldı.',
    authorized: (p: { login: string }) =>
      `${p.login} hesabı yetkilendirildi. Artık bu hesapta depo açılabilir.`,
    pat: {
      toggle: 'Belirteçle bağla (yedek yol)',
      label: 'İnce ayarlı kişisel erişim belirteci',
      hint: '“github_pat_” ile başlar. Repository access: All repositories; Repository permissions → Administration: Read and write. Yalnızca ana sunucuda şifreli saklanır ve bir daha gösterilmez.',
      save: 'Belirteci kaydet',
      stepUp: 'Belirteci kaydetmek için doğrulama kodu',
      saved: (p: { login: string }) => `${p.login} için belirteç kaydedildi.`,
    },
    owners: 'Depo açılabilecek yerler',
    ownerType: {
      User: 'kişisel hesap',
      Organization: 'organizasyon',
    },
    methods: {
      installation: 'GitHub App kurulumu ile',
      app_user: 'yetkilendirilmiş hesap ile',
      pat: 'kişisel erişim belirteci ile',
    },
    blocked: {
      installation_suspended: 'GitHub App kurulumu askıya alınmış.',
      administration_missing:
        'GitHub App’in “Administration: Read and write” izni yok. App ayarlarında izni ekleyin, kurulumda kabul edin, sonra “Kurulumları yenile”.',
      permissions_unknown: 'Kurulumun izinleri henüz okunmadı: “Kurulumları yenile”.',
      user_authorization_missing: 'Kişisel hesap: önce “GitHub hesabını yetkilendir”.',
      user_authorization_expired: 'Hesabın yetkisinin süresi doldu: yeniden yetkilendirin.',
    },
  },
  callback: {
    title: 'GitHub hesabı',
    purpose: 'GitHub’dan dönülen yetkilendirme tamamlanıyor.',
    working: 'GitHub hesabı yetkilendiriliyor',
    stepUp: 'GitHub hesabının yetkilendirmesini tamamlamak için doğrulama kodu',
  },
  create: {
    open: 'GitHub’da yeni private repo aç',
    title: 'GitHub’da yeni depo',
    sub: 'Remyral depoyu açar, GitHub App kurulumuna ekler ve bu projeye bağlar.',
    owner: 'Sahip',
    name: 'Depo adı',
    nameHint: 'Harf, rakam, “.”, “_” ve “-”; boşluk yok.',
    nameInvalid:
      'Depo adı yalnızca harf, rakam, “.”, “_” ve “-” içerebilir (en çok 100 karakter, “.git” olmadan).',
    description: 'Açıklama (isteğe bağlı)',
    private: 'Private (önerilen)',
    autoInit: 'README ile ilk commit (temel branch hemen oluşur)',
    gitignore: '.gitignore şablonu',
    gitignoreNone: 'Yok',
    link: (p: { project: string }) => `${p.project} projesine bağla`,
    replaceLink: (p: { current: string }) => `Projenin şu anki deposunun yerine geçsin (${p.current})`,
    submit: 'Depoyu aç',
    stepUp: 'GitHub’da depo açmak için doğrulama kodu',
    loading: 'GitHub seçenekleri yükleniyor',
    noOwner:
      'Remyral henüz hiçbir yerde depo açamıyor. Ayarlar → Entegrasyonlar → GitHub’da hesabı yetkilendirin ya da App’e izin verin.',
    toSettings: 'GitHub ayarlarına git',
    created: (p: { name: string }) => `${p.name} açıldı.`,
    linked: (p: { project: string }) => `${p.project} projesine bağlandı; git akışı temel branch’te çalışır.`,
    notLinked: 'Depo açıldı ama projeye bağlanamadı.',
    openOnGitHub: 'GitHub’da aç',
    warnings: {
      not_in_installation:
        'GitHub App kurulumu depoya erişemiyor: GitHub → Settings → Applications → Configure’dan depoyu kuruluma ekleyin.',
      empty_repository: 'Depo boş: temel branch ilk push ile oluşur.',
      link_failed: 'Projeye bağlanamadı.',
    },
    cancel: 'Vazgeç',
  },
  wizard: {
    offer: 'Proje oluşunca GitHub’da private repo aç ve bağla',
    offerHint: 'Bir sonraki adımda depo adını ve sahibini seçersiniz.',
  },
  card: {
    label: 'GitHub deposu',
    kind: 'GitHub deposu',
    repository: 'Depo',
    visibility: 'Görünürlük',
    private: 'private',
    public: 'herkese açık',
    method: 'Yol',
    initial: 'İlk commit',
    initialValue: (p: { readme: boolean; gitignore: string }) =>
      p.readme ? (p.gitignore === '' ? 'README' : `README + .gitignore (${p.gitignore})`) : 'yok (boş depo)',
    project: 'Proje',
    replaces: 'Yerine geçtiği depo',
    linkOnly: 'Var olan depo bağlanır; yeni depo açılmaz.',
    note: 'Depo GitHub’da açılır, App kurulumuna eklenir ve projeye bağlanır. Belirteç kartta yer almaz.',
  },
};
