/**
 * i18n Phase 2 (p14-i18n-shell): texts shared by many Diyalog screens — the client-side error sentences, the 429
 * wait, confirm / copy buttons, the pager, sort bar, log toolbar, state badges, actors — and the classic chat parts
 * that the Diyalog Sohbet rows render (`screens/chat/*`, through `useSharedT()`: English in the classic console).
 */

/** "2 dk 05 sn" / "40 sn" — a short wait in seconds (the Turkish form of the classic `formatDuration`). */
function waitTr(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${String(m)} dk ${String(s).padStart(2, '0')} sn` : `${String(s)} sn`;
}

export default {
  /** Errors the console makes itself (api/client.ts, toApiError); master codes come in Phase 3. */
  errors: {
    network: 'Sunucuya ulaşılamıyor. Bağlantını kontrol edip yeniden dene.',
    unexpected: 'Sunucudan beklenmeyen bir yanıt geldi.',
    sessionRefreshed:
      'Oturumun az önce yenilendi (burada ya da başka bir sekmede bir onay). Hiçbir şey değişmedi — yeniden dene.',
    unknown: 'Bir şeyler ters gitti. Yeniden dene.',
    /** A 429's `Retry-After` wait. */
    retryIn: (p: { wait: string }) => `${p.wait} sonra yeniden deneyebilirsin.`,
    /** The wait itself: "2 dk 05 sn" / "40 sn". */
    wait: (p: { seconds: number }) => waitTr(p.seconds),
  },
  /** The raw reason / error text behind a humane sentence. */
  details: 'Ayrıntı',
  loading: 'Yükleniyor…',
  confirm: {
    question: 'Emin misin?',
    back: 'Vazgeç',
  },
  /** p17-toasts-shortcuts: action results shown as toasts, and their follow-up links. */
  actionToast: {
    runStarted: 'Çalıştırma başladı.',
    runSkipped: (p: { reason: string }) => `Atlandı: ${p.reason}`,
    openRun: 'Çalıştırmayı aç',
    openJob: 'İşi aç',
    openNeeds: 'Senden bekleyenler',
  },
  copy: {
    label: 'Kopyala',
    copied: 'Kopyalandı.',
    failed: 'Kopyalanamadı; metni elle seç.',
    /** CodeBlock (a command to paste). */
    copiedShort: 'Kopyalandı',
    commandCopied: 'Komut kopyalandı',
    failedShort: 'Kopyalanamadı',
  },
  toggle: {
    on: 'Açık',
    off: 'Kapalı',
  },
  actor: {
    system: 'Sistem',
    worker: 'Makine',
    scheduler: 'Zamanlayıcı',
    schedule: 'Zamanlama',
    integrator: 'Birleştirme botu',
    chat: 'Sohbet asistanı',
    automation: 'Otomasyon',
    unknown: 'Bilinmiyor',
    you: 'Sen',
  },
  pager: {
    empty: 'Bu sayfada satır yok',
    page: 'Sayfa',
    rows: 'Satır',
    first: 'İlk sayfa',
    previous: 'Önceki sayfa',
    previousShort: 'Önceki',
    next: 'Sonraki sayfa',
    nextShort: 'Sonraki',
    last: 'Son sayfa',
  },
  sort: {
    label: 'Sırala',
    /** "Ad, artan" — a sort button's accessible name with its order. */
    ascending: (p: { label: string }) => `${p.label}, artan`,
    descending: (p: { label: string }) => `${p.label}, azalan`,
    defaultNote: 'Varsayılan sıra',
    sortedNote: 'Yüklenen satırlar sıralı',
  },
  logs: {
    follow: 'Canlı takip',
    followTitle: 'En yeni satır görünür kalsın',
    wrap: 'Satır kaydır',
    wrapTitle: 'Uzun satırları kaydır',
    time: 'Zaman',
    timeTitle: 'Her satırın zamanı (bu tarayıcıda hatırlanır)',
    timeFormat: 'Zaman biçimi',
    clock: 'Saat',
    clockTitle: 'Yerel saat, SS:DD:ss.mmm',
    elapsed: 'Geçen',
    elapsedTitle: 'İlk satırdan beri geçen süre',
  },
  state: {
    running: 'Çalışıyor',
    queued: 'Kuyrukta',
    needs: 'Karar bekliyor',
    paused: 'Duraklatıldı',
    stale: 'Bayat',
    failed: 'Başarısız',
    done: 'Bitti',
    cancelled: 'İptal edildi',
  },
  thread: {
    older: 'Daha eski olayları yükle',
    showOlder: (p: { n: number }) => `Daha eski ${String(p.n)} öğeyi göster`,
  },
  card: {
    fresh: 'yeni',
    details: 'Ayrıntılar',
    hide: 'Gizle',
  },
  tool: {
    collapse: 'Kısalt',
    expand: (p: { lines: number }) => `Tamamını göster (${String(p.lines)} satır)`,
    openInLog: 'Log’da aç',
  },
  /** Speaker names of a thread message without an author. */
  speaker: {
    assistant: 'Remyral',
    agent: 'Ajan',
  },
  /** Chat rows: the Diyalog Sohbet rows and the classic chat parts they render. */
  chat: {
    copyMessage: 'Mesajı kopyala',
    copyCode: 'Kodu kopyala',
    /** Classic CopyText's visible word and its result. */
    copy: 'Kopyala',
    copied: 'Kopyalandı',
    copyFailed: 'Kopyalanamadı',
    star: 'Yıldızla',
    unstar: 'Yıldızı kaldır',
    starMessage: 'Mesajı yıldızla',
    unstarMessage: 'Mesajın yıldızını kaldır',
    showInOutputs: 'Çıktılar’da göster',
    toolsUsed: (p: { n: number; names: string }) => `${String(p.n)} araç kullanıldı: ${p.names}`,
    assistantMeta: 'operasyon asistanı',
    writing: 'yazıyor',
    typing: 'Remyral yazıyor',
    /** p17-chat-reconnect: the answering machine's connection dropped; the turn waits for it to come back. */
    reconnecting: 'Bağlantı yeniden kuruluyor…',
    /** p17-chat-send-motion: under the person's message while it is on its way to the master. */
    sending: 'Gönderiliyor…',
    related: (p: { n: number }) => `${String(p.n)} ilgili kayıt kullanıldı`,
    relatedFound: (p: { semantic: boolean }) => ` · ${p.semantic ? 'anlamca' : 'kelimeyle'} bulundu`,
    relatedKind: {
      own_chat: 'Sohbetin',
      project_chat: 'Proje sohbeti',
      context_doc: 'Proje belgesi',
      job_summary: 'İş özeti',
    },
    attachments: 'Ekler',
    attachedFiles: 'Eklenen dosyalar',
    preparing: 'Hazırlanıyor…',
    uploading: 'Yükleniyor…',
    uploadFailed: 'Yüklenemedi.',
    remove: (p: { name: string }) => `Kaldır: ${p.name}`,
    open: (p: { name: string }) => `Aç: ${p.name}`,
    image: 'Görsel',
    screenshotHint:
      'Ekran görüntülerinde gizli bilgi olabilir — göndermeden önce kontrol et. Fotoğraflardaki konum bilgisi silinir.',
    /** p15-chat-zip: a .zip dropped into the chat — unpacked in the browser, uploaded as a site on send. */
    zip: {
      reading: '.zip açılıyor…',
      summary: (p: { n: number; size: string }) => `${String(p.n)} dosya · ${p.size}`,
      stripped: (p: { folder: string }) => `üst klasör ${p.folder}/ kaldırıldı`,
      site: 'Site — gönderince yüklenir; “Cloudflare’da yayınla” de, asistan yayınlasın.',
      project: 'Proje',
      projectHint: 'Site bu projenin Deploy hedeflerine yüklenir.',
      noProject: 'Deploy isteyebileceğin bir proje yok (operatör rolü gerekir); bu .zip yüklenemez.',
      projectsFailed: 'Projeler yüklenemedi.',
      showFiles: (p: { n: number }) => `Dosyaları göster (${String(p.n)})`,
      hideFiles: 'Dosyaları gizle',
      refusedFiles: (p: { n: number }) => `${String(p.n)} dosya yüklenmeyecek:`,
      notSite: 'Site olarak yayınlanamaz — yüklenmez; asistana yalnızca nedeni iletilir.',
      problems: {
        unreadable: '.zip güvenle okunamadı.',
        no_files: 'İçinde bir sitede olabilecek dosya yok.',
        no_index: 'Kökünde index.html yok.',
        too_many_files: '500’den fazla dosya var.',
        too_large: 'Dosyaları toplam 50 MiB’den büyük.',
      },
      hashing: 'Dosyalar hazırlanıyor…',
      progress: (p: { sent: string; total: string }) => `Yükleniyor: ${p.sent} / ${p.total}`,
      retrying: (p: { part: number; attempt: number }) =>
        `Parça ${String(p.part + 1)} yeniden deneniyor (${String(p.attempt)}. deneme)`,
      checking: 'Ana sunucu dosyaları kontrol ediyor…',
      uploaded: 'Yüklendi',
      failed: (p: { error: string }) => `Yüklenemedi: ${p.error} — tekrar göndermek kaldığı yerden sürdürür.`,
      tooMany: (p: { n: number }) => `Bir mesajda en fazla ${String(p.n)} .zip olabilir.`,
      sentSite: (p: { n: number; size: string }) => `Site yüklemesi · ${String(p.n)} dosya · ${p.size}`,
      sentNotSite: 'Site değil — yüklenmedi',
      /** p16-zip-job-input: bir .zip'in işin girdi dosyaları olarak gönderilmesi. */
      input: 'İş girdisi — gönderince yüklenir; dosyaları işin in/ klasörüne konur.',
      modeLabel: 'Gönderim',
      modes: {
        both: 'Mesaja göre',
        site: 'Site (yayınla)',
        input: 'İş girdisi',
      },
      bothHint: 'İki şekilde de yüklenir; yayınlansın mı, dosyalarıyla iş mi yapılsın, mesajın söyler.',
      projectHintInput: 'Dosyalar bu projenin işleri için saklanır (son kullanımdan sonra 14 gün).',
      inputProblems: {
        unreadable: '.zip güvenle okunamadı.',
        no_files: 'İçinde kullanılabilir dosya yok.',
        too_many_files: '2000’den fazla dosya var.',
        too_large: 'Dosyaları toplam 100 MiB’den büyük.',
      },
      skippedFiles: (p: { n: number }) =>
        `${String(p.n)} dosya dışarıda bırakıldı (.git, node_modules, sistem dosyaları)`,
      secretsTitle: (p: { n: number }) =>
        `${String(p.n)} yerde gizli bilgi olabilir — hiçbir şey gönderilmedi:`,
      secretLine: (p: { path: string; line: number; rule: string }) =>
        `${p.path} satır ${String(p.line)} (${p.rule})`,
      sendAnyway: 'Yine de gönder',
      sendAnywayHint: 'Sonra Gönder’e bas: dosyalar bu bulgularla gider ve bu kayda geçer.',
      willSendAnyway: 'Bulgulara rağmen gönderilecek (kayda geçer).',
      leaveOut: (p: { n: number }) => `Reddedilen ${String(p.n)} dosyayı çıkar`,
      sentInput: (p: { n: number; size: string }) => `İş girdisi · ${String(p.n)} dosya · ${p.size}`,
      sentWithSecrets: 'gizli bilgi uyarısına rağmen gönderildi',
      composerLabel: '.zip’teki dosyalar (isteğe bağlı)',
      composerHint:
        'Tarayıcında açılır, işi başlatınca yüklenir: ajan dosyaları in/ klasöründe bulur (repo işinde kodun yanındaki bir klasör, asla commit edilmez). En çok 2000 dosya, her biri 25 MiB, toplam 100 MiB; çalıştırılabilir dosyalar reddedilir; dosyalarda gizli bilgi aranır.',
      composerPick: '.zip seç',
      composerReuse: (p: { name: string; n: number }) =>
        `Önceki işin dosyaları yeniden kullanılır: ${p.name} (${String(p.n)} dosya)`,
      composerDrop: 'Kullanma',
    },
  },
};
