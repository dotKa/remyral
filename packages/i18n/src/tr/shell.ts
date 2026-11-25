/**
 * Diyalog shell chrome (i18n Phase 2, p14-i18n-shell): top bar tools, the notification bell's frame (never the
 * notification title / body — Phase 6), the account menu, the update banner, the rail clock, the
 * keyboard shortcuts dialog, "Tüm ekranlar", the shared dialog and countdown.
 */
export default {
  skipToContent: 'İçeriğe geç',
  search: 'Ara',
  searchTitle: 'Sayfalara, sohbetlere, işlere git; yapay zeka ile ara',
  close: 'Kapat',
  allScreens: {
    title: 'Tüm ekranlar',
  },
  bell: {
    title: 'Bildirimler',
    withUnread: (p: { n: number }) => `Bildirimler, ${String(p.n)} okunmamış`,
    readFailed: 'Bildirimler okunamadı.',
    markFailed: 'Bildirimler okundu sayılamadı.',
    readAll: 'Tümünü okundu say',
    loading: 'Bildirimler yükleniyor…',
    empty: 'Bildirimin yok.',
    listLabel: 'Son bildirimler',
    severity: { info: 'Bilgi', warning: 'Uyarı', critical: 'Kritik' },
    /** Screen-reader prefix of an item: "Uyarı, okunmamış: ". */
    itemPrefix: (p: { severity: string; unread: boolean }) =>
      `${p.severity}${p.unread ? ', okunmamış' : ''}: `,
    loadingMore: 'Yükleniyor…',
    more: 'Daha fazla',
    settings: 'Bildirim ayarları',
  },
  account: {
    menu: 'Hesap menüsü',
    region: 'Hesap',
    role: (p: { role: string }) => `Rol: ${p.role}`,
    loading: 'Oturum yükleniyor…',
    sessionType: 'Oturum türü',
    remembered: 'Hatırlanan (Beni hatırla)',
    standard: 'Standart',
    signedIn: 'Giriş',
    idle: 'Boşta kapanma',
    ends: 'Oturum sonu',
    stepUp: 'Ek doğrulama',
    recoveryLeft: 'Kalan kurtarma kodu',
    stepUpSession: 'bu oturum boyunca doğrulandı',
    stepUpSessionNote: 'Parola ve hesap değişiklikleri 10 dakika sonra yine sorar.',
    stepUpSessionPending: 'henüz doğrulanmadı — ilk yetkili işlem bu oturum için bir kez sorar',
    stepUpValidUntil: (p: { time: string }) => `${p.time}’e kadar geçerli`,
    stepUpNotRecent: 'yakın zamanda doğrulanmadı',
    openCoolify: (p: { label: string | null }) => `Coolify’ı aç${p.label === null ? '' : ` — ${p.label}`}`,
    newTab: ' (yeni sekmede)',
    logout: 'Çıkış yap',
    logoutAll: 'Her yerden çıkış yap',
    logoutAllQuestion: 'Bütün oturumların kapansın mı?',
    logoutAllConfirm: 'Evet, her yerden çık',
  },
  update: {
    ready: 'Remyral’ın yeni sürümü hazır.',
    reload: 'Yenile',
  },
  /** p14-web-perf: a screen whose code loads on demand (its skeleton, and a chunk that failed to load). */
  route: {
    loading: 'Sayfa yükleniyor…',
    failed: 'Bu sayfa yüklenemedi. Bağlantını kontrol et ve sayfayı yenile.',
    reload: 'Sayfayı yenile',
  },
  clock: {
    server: (p: { utc: string }) => `Sunucu saati: ${p.utc} UTC`,
    local: (p: { zone: string; time: string }) => `Senin saat diliminde (${p.zone}): ${p.time}`,
    behind: (p: { skew: string }) =>
      `Cihaz saatin sunucudan ${p.skew} geri — bu tarayıcıdaki zamanlar kayık görünebilir.`,
    ahead: (p: { skew: string }) =>
      `Cihaz saatin sunucudan ${p.skew} ileri — bu tarayıcıdaki zamanlar kayık görünebilir.`,
    inSync: 'Cihaz saatin sunucuyla uyumlu.',
    /** Spoken form in the top bar: "Saat senin saat diliminde (GMT+3), cihaz saatin 3 min 05 s kayık". */
    spokenBar: (p: { zone: string; skew: string | null }) =>
      `Saat senin saat diliminde (${p.zone})${p.skew === null ? '' : `, cihaz saatin ${p.skew} kayık`}`,
    spokenRail: (p: { time: string; zone: string; skew: string | null }) =>
      `Saat ${p.time} (${p.zone}, senin saat dilimin)${p.skew === null ? '' : `, cihaz saatin ${p.skew} kayık`}`,
  },
  shortcuts: {
    navigation: 'Gezinme',
    everywhere: 'Her ekranda',
    cardsAndChat: 'Kartlar ve sohbet',
    then: 'sonra',
    go: {
      h: 'Ana sayfaya git',
      c: 'Sohbete git',
      j: 'İşlere git',
      a: 'Senden bekleyenlere git',
      m: 'Makinelere git',
      p: 'Projelere git',
      s: 'Ayarlara git',
    },
    search: 'Bu ekranda ara (Sohbet’te sohbet listesi)',
    newJob: 'Yeni iş formu (/jobs/new)',
    help: 'Bu kısayolları göster',
    palette: 'Komut paleti: sayfalara, sohbetlere, işlere git',
    toasts: 'Anlık bildirimlere git (Esc kapatır)',
    nextCard: 'Sonraki karar kartı',
    prevCard: 'Önceki karar kartı',
    approve: 'Odaktaki kartı onayla (kod alanını açar)',
    reject: 'Odaktaki kartı reddet',
    planPanel: 'Plan panelini aç / kapat (Sohbet)',
    dictation: 'Sesli dikteyi başlat / durdur (Sohbet)',
    send: 'Mesajı gönder',
    newline: 'Yeni satır',
    escape: 'Menüyü, paneli ya da listeyi kapat',
    note: 'Sayfa değiştiren kısayollar tek harf değil, Option (Alt) ile birlikte basılır; yazarken ve bir pencere açıkken çalışmaz. j / k / a / d yalnızca kart listesindeyken çalışır. Sesli dikte kısayolu mesaj kutusunda yazarken de çalışır.',
    ok: 'Tamam',
  },
  /** p17-toasts-shortcuts: the toasts at the bottom of the screen. */
  toast: {
    /** The toaster's landmark name (with its shortcut). */
    region: (p: { keys: string }) => `Anlık bildirimler (${p.keys})`,
    dismiss: 'Kapat',
    dismissAria: (p: { title: string }) => `Bildirimi kapat: ${p.title}`,
    more: (p: { n: number }) => `+${String(p.n)} bildirim daha`,
    less: 'Daha az göster',
    tone: { success: 'Tamam', info: 'Bilgi', warning: 'Uyarı', error: 'Hata' },
    /** A new-notification preview: one, or a burst. */
    preview: {
      many: (p: { n: number }) => `${String(p.n)} yeni bildirim`,
      latest: (p: { title: string }) => `En yenisi: ${p.title}`,
      open: 'Aç',
      showAll: 'Bildirimleri göster',
    },
  },
  countdown: {
    expired: 'süre doldu',
    left: (p: { time: string }) => `${p.time} kaldı`,
    minutes: (p: { n: number }) => `${String(p.n)} dakika`,
    hours: (p: { n: number }) => `${String(p.n)} saat`,
    hoursMinutes: (p: { h: number; m: number }) => `${String(p.h)} saat ${String(p.m)} dakika`,
  },
};
