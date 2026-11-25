/**
 * p17-chat-github: sohbet adları anlamdan (iş parçacığındaki kısa bildirim), sohbetten proje oluşturma kartı ve birden
 * çok GitHub App bağlantısı (Ayarlar → Entegrasyonlar → GitHub).
 */
export default {
  title: {
    renamed: (p: { title: string }) => `Sohbet adı güncellendi: “${p.title}”`,
  },
  project: {
    label: 'Yeni proje',
    kind: 'Proje oluşturma',
    id: 'Proje kimliği',
    name: 'Ad',
    description: 'Açıklama',
    type: 'Tür',
    typeRepository: 'Depolu proje',
    typeWorkspace: 'Çalışma alanı (depo yok)',
    repository: 'Depo',
    baseBranch: 'Ana branch',
    connection: 'GitHub bağlantısı',
    dnsZone: 'İzinli DNS bölgesi',
    egress: 'Ağ erişimi',
    knowledge: 'Proje bilgisi',
    knowledgeValue: (p: { search: boolean; memory: boolean }) =>
      `${p.search ? 'Arama açık' : 'Arama kapalı'} · ${p.memory ? 'Hafıza önerileri açık' : 'Hafıza önerileri kapalı'}`,
    note: 'Onaylayana kadar hiçbir şey oluşturulmaz. Onaylayınca proje oluşturulur; varsa depo ve DNS bölgesi bağlanır (sahip / yönetici).',
  },
  connections: {
    title: 'GitHub App’leri',
    sub: 'Her hesap veya organizasyon için ayrı, özel bir GitHub App. Yalnızca kabul ettiğiniz kurulumlar kullanılır.',
    guideSummary: 'Neden her hesap için ayrı özel App?',
    guideWhy:
      'Özel (private) bir GitHub App yalnızca sahibi olan hesaba ya da organizasyona kurulabilir. Başka bir organizasyonun depoları için o organizasyonda ayrı bir özel App bağlayın.',
    guideSteps: {
      s1: '“App ekle”de organizasyonu seçin; GitHub’da App’in oluşturulmasını onaylayın.',
      s2: 'App’i GitHub’da o organizasyona kurun (App’in kartında “Depolara kur”).',
      s3: 'App’in kartında “Kurulumları yenile” ile kurulumu görün ve “Kabul et” ile kullanıma açın.',
    },
    guidePublic:
      'Herkese açık (public) bir App’i herkes kurabilir: tanımadığınız hesapların webhook olayları gelir ve kurulumları kabul bekler. Bu yüzden özel App önerilir.',
    pending: 'Kabul bekliyor',
    accepted: 'Kabul edildi',
    accept: 'Kabul et',
    withdraw: 'Kabulü geri al',
    pendingHint:
      'Yeni kurulumlar kabul edilene kadar kullanılmaz (depo listesi, proje bağlantısı, erişim anahtarı).',
    stepUpAccept: 'GitHub kurulumunu kabul et — güncel doğrulama kodunu girin.',
    stepUpWithdraw: 'GitHub kurulumunun kabulünü geri al — güncel doğrulama kodunu girin.',
    acceptedToast: (p: { account: string }) => `${p.account} kurulumu kabul edildi`,
    withdrawnToast: (p: { account: string }) => `${p.account} kurulumunun kabulü geri alındı`,
    envSource: 'Ortamdan (salt okunur)',
    envHint: 'GITHUB_APP_ID ile sunucu ortamından gelir; panelden değiştirilemez.',
    keyUnusable: 'Anahtar kullanılamıyor',
    rename: 'Yeniden adlandır',
    labelField: 'Bağlantı adı',
    save: 'Kaydet',
    cancel: 'Vazgeç',
    stepUpRename: 'GitHub bağlantısını yeniden adlandır — güncel doğrulama kodunu girin.',
    remove: 'Bağlantıyı kaldır',
    removeConfirm: 'Kaldır',
    removeTitle: 'Bu bağlantı kaldırılsın mı?',
    removeBody: (p: { n: number; projects: string }) =>
      p.n === 0
        ? 'Anahtar ve kurulumlar silinir. App GitHub’da kalır; orada siz silersiniz.'
        : `Anahtar ve kurulumlar silinir; ${p.projects} artık bu App’le erişemez. App GitHub’da kalır.`,
    stepUpRemove: 'GitHub bağlantısını kaldır — güncel doğrulama kodunu girin.',
    removed: 'Bağlantı kaldırıldı',
    add: 'App ekle',
    addTitle: 'Yeni GitHub App',
    labelOptional: 'Bağlantı adı (isteğe bağlı)',
    limit: (p: { n: number }) => `En fazla ${String(p.n)} App eklenebilir.`,
    stepUpAdd: 'GitHub App bağlantısı ekle — güncel doğrulama kodunu girin.',
    // p17-github-apps-ui: every App is one card in the "GitHub App'leri" list.
    appsCount: (p: { n: number }) => `${String(p.n)} App`,
    counts: (p: { installations: number; projects: number }) =>
      `${String(p.installations)} kurulum · ${String(p.projects)} proje`,
    pendingPill: 'Bekleyen kurulum var',
    defaultApp: 'Varsayılan App',
    defaultHint:
      'Bağlantısı seçilmemiş depolar ve “GitHub hesabı” yetkilendirmesi bu App’i kullanır. Diğer işlemler her App’in kendi kartında, yalnızca o App için çalışır.',
    webhookSet: 'kurulu',
    wideTitle: 'Tüm App’ler',
    wideSub: 'Buradaki işlem tek bir App’e değil, bağlı tüm App’lere uygulanır.',
    syncAll: 'Tüm App’lerin kurulumlarını yenile',
    syncAllHint:
      'Ortamdan gelen App’ler dahil her App’in kurulumlarını GitHub’dan yeniden okur. Tek bir App için kartındaki “Kurulumları yenile”yi kullanın.',
  },
};
