/**
 * p16-git-providers (ADR-0061): Ayarlar → Entegrasyonlar → GitLab ve Bitbucket (master'da saklanan erişim anahtarları)
 * ve Projeler → Depo'daki sağlayıcı seçimi (GitHub / GitLab / Bitbucket / düz git).
 */
export default {
  kinds: { gitlab: 'GitLab', bitbucket: 'Bitbucket Cloud' },
  tokenKinds: {
    project: 'Proje erişim anahtarı',
    group: 'Grup erişim anahtarı',
    personal: 'Kişisel erişim anahtarı',
    repository: 'Depo erişim anahtarı',
    workspace: 'Çalışma alanı erişim anahtarı',
  },
  settings: {
    title: 'GitLab ve Bitbucket',
    sub: 'Master bu anahtarlarla merge request / pull request açar, CI’yi okur ve onaylı birleştirmeyi yapar. Anahtar bir kez girilir, şifreli saklanır, bir daha gösterilmez ve modele hiçbir zaman gitmez.',
    loading: 'Bağlantılar yükleniyor',
    none: 'Henüz GitLab ya da Bitbucket bağlantısı yok.',
    add: 'GitLab / Bitbucket bağla',
    addTitle: 'Yeni bağlantı',
    kind: 'Sağlayıcı',
    label: 'Ad',
    labelPlaceholder: 'ör. Şirket GitLab',
    baseUrl: 'GitLab adresi',
    baseUrlHint: 'gitlab.com ya da şirketinizin GitLab sunucusu (https://…). /api/v4 eklemeyin.',
    tokenKind: 'Anahtar türü',
    scope: 'Anahtarın kapsamı',
    scopeHint: (p: { kind: string }) =>
      p.kind === 'gitlab'
        ? 'Proje anahtarı için grup/proje, grup anahtarı için grup yolu; kişisel anahtarda boş bırakılabilir.'
        : 'Depo anahtarı için çalışma-alanı/depo, proje anahtarı için çalışma-alanı/PROJE, çalışma alanı anahtarı için yalnızca çalışma alanı.',
    token: 'Erişim anahtarı',
    tokenHint: (p: { kind: string }) =>
      p.kind === 'gitlab'
        ? 'Kapsam: api. Rol: Maintainer (birleştirme için). Anahtar bir daha gösterilmez.'
        : 'Kapsamlar: repository:write, pullrequest:write, pipeline (Bitbucket app password’leri artık kabul etmiyor). Anahtar bir daha gösterilmez.',
    pushToken: 'Makineler için itme anahtarı (önerilir)',
    pushTokenHint: (p: { kind: string }) =>
      p.kind === 'gitlab'
        ? 'Yalnızca write_repository kapsamlı ayrı bir anahtar. Boş bırakılırsa makineler API anahtarını alır.'
        : 'Yalnızca repository:write kapsamlı ayrı bir anahtar. Boş bırakılırsa makineler API anahtarını alır.',
    expiresAt: 'Bitiş tarihi',
    expiresAtHint:
      'Bitbucket anahtarın bitişini bildirmez; biliyorsanız girin, Anahtarlar ve süreler listesi hatırlatır. GitLab bitişi kendisi bildirir.',
    test: 'Bağlantıyı test et',
    save: 'Bağlantıyı kaydet',
    cancel: 'Vazgeç',
    retest: 'Yeniden test et',
    rotate: 'Anahtarı GitLab’da yenile',
    rotateQuestion:
      'GitLab yeni bir anahtar üretir ve eskisini hemen iptal eder. Master yenisini kullanmaya devam eder. Yenilensin mi?',
    replace: 'Yeni anahtar gir',
    replaceTitle: 'Yeni anahtar',
    replaceHint: 'Kaydetmeden önce yeni anahtar test edilir; geçmezse eskisi kalır.',
    removePush: 'Ayrı itme anahtarını kaldır',
    remove: 'Bağlantıyı kaldır',
    removeQuestion: 'Bu bağlantı ve anahtarları silinsin mi? Kullanan proje varsa kaldırılamaz.',
    stepUpSave: 'GitLab / Bitbucket anahtarını kaydet — güncel doğrulama kodunu girin.',
    stepUpRotate: 'GitLab anahtarını yenile — güncel doğrulama kodunu girin.',
    stepUpReplace: 'Yeni anahtarı kaydet — güncel doğrulama kodunu girin.',
    stepUpRemove: 'Bağlantıyı kaldır — güncel doğrulama kodunu girin.',
    saved: 'Bağlantı kaydedildi.',
    rotated: 'Anahtar yenilendi; eski anahtar artık çalışmıyor.',
    replaced: 'Yeni anahtar kaydedildi.',
    removed: 'Bağlantı kaldırıldı.',
    usable: 'Kullanılabilir',
    unusable: 'Anahtar okunamıyor — yeniden girin',
    expires: (p: { date: string }) => `Bitiş: ${p.date}`,
    noExpiry: 'Bitiş tarihi bilinmiyor',
    fingerprint: (p: { fp: string }) => `Anahtar izi ${p.fp}`,
    pushSeparate: 'Makineler ayrı itme anahtarını alır',
    pushShared: 'Makineler API anahtarını alır — yalnızca itme yetkili ayrı bir anahtar önerilir',
    projects: (p: { list: string }) => `Kullanan projeler: ${p.list}`,
    unused: 'Henüz bir proje kullanmıyor',
    lastTestOk: (p: { at: string }) => `Son test geçti (${p.at})`,
    lastTestFailed: (p: { reason: string }) => `Son test başarısız: ${p.reason}`,
    neverTested: 'Hiç test edilmedi',
    testOk: (p: { name: string }) => `Bağlantı çalışıyor${p.name === '' ? '' : ` — anahtar “${p.name}”`}.`,
    testScopes: (p: { scopes: string }) => `Kapsamlar: ${p.scopes}`,
    testExpires: (p: { date: string }) => `Anahtarın bitişi: ${p.date}`,
    testFailed: (p: { reason: string }) => `Bağlantı çalışmıyor: ${p.reason}`,
    codes: {
      unauthorized: 'anahtar reddedildi (yanlış, süresi dolmuş ya da iptal edilmiş)',
      forbidden: 'anahtar geçerli ama kapsamını okuyamıyor',
      not_found: 'anahtar ya da kapsamı bulunamadı',
      scope_mismatch: 'anahtar verilen projeye, gruba, depoya ya da çalışma alanına erişemiyor',
      missing_scopes: 'anahtarın gereken bir kapsamı eksik',
      inactive: 'anahtar iptal edilmiş ya da pasif',
      unreachable: 'sunucuya ulaşılamadı',
      undecryptable: 'saklanan anahtar çözülemedi (master anahtarı değişmiş) — yeniden girin',
      push: 'itme anahtarı: ',
      other: (p: { code: string }) => `beklenmeyen yanıt (${p.code})`,
    },
  },
  repo: {
    connection: 'Bağlantı',
    connectionValue: (p: { label: string; host: string }) => `${p.label} · ${p.host}`,
    noConnections: (p: { kind: string }) =>
      `Henüz ${p.kind} bağlantısı yok. Önce Ayarlar → Entegrasyonlar → GitLab ve Bitbucket’tan bir bağlantı ekleyin.`,
    connectionsUnavailable:
      'Bağlantılar okunamadı (yönetici yetkisi gerekir). Bağlantı kimliği değişmeden kalır.',
    pickConnection: 'Bağlantı seçin',
    testConnection: 'Bağlantıyı test et',
    search: 'Depolarda ara',
    searchPlaceholder: 'grup/proje',
    reposLabel: 'Bağlantının depoları',
    reposLoading: 'Depolar yükleniyor',
    noRepos: 'Eşleşen depo yok. Anahtarın kapsamı bu depoyu içermiyor olabilir.',
    mergeHint:
      'GitLab’da birleştirme yöntemi projenin ayarına uyar (merge commit / fast-forward); squash isteğe bağlıdır. Rebase ile birleştirme sunulmaz.',
  },
};
