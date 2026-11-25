/**
 * p14-i18n-screens-a (i18n Phase 5): Sohbet's job drafting — the editable job draft card, the words for a job's
 * choices (class, isolation, approval mode, verification), the per-runtime limit line, the queue estimate and the
 * composer's slash commands (`apps/web/src/diyalog/compose`).
 */
export default {
  priorityClass: {
    urgent: 'Acil',
    normal: 'Normal',
    background: 'Arka plan',
  },
  classHint: {
    urgent: 'Önce o başlar; acil işlere ayrılan slotu kullanabilir.',
    normal: 'Sırasıyla başlar.',
    background: 'Yalnızca boş kapasitede çalışır.',
  },
  sandbox: {
    container: {
      label: 'Konteyner',
      text: 'Yalnızca işin dosyalarını gören yalıtılmış konteyner. En güvenlisi.',
    },
    'runtime-sandbox': {
      label: 'Runtime’ın kendi kumu',
      text: 'Makinede, runtime’ın kendi kum havuzunda.',
    },
    'host-restricted': {
      label: 'Makinede, kısıtlı',
      text: 'Makinede, yalnızca işin klasörüne erişen kısıtlı kullanıcıyla.',
    },
    unconfined: {
      label: 'Tüm makine',
      text: 'Dosya ve ağ sınırı olmadan, makinenin servis hesabıyla.',
    },
  },
  approval: {
    'ask-sensitive': {
      label: 'Hassas adımlarda sor',
      text: 'Push, ağ ve silme gibi adımlar sana gelir. Önerilen.',
    },
    'ask-all': { label: 'Her adımda sor', text: 'Runtime’ın bildirdiği her adım seni bekler.' },
    'deny-sensitive': {
      label: 'Hassas adımları reddet',
      text: 'Sormadan reddeder; gözetimsiz işler için.',
    },
    'allow-all': {
      label: 'Hiç sorma (tam erişim)',
      text: 'Her araç çağrısı sormadan çalışır; korumalı birleştirme, deploy ve kasa yine onay ister.',
    },
  },
  verify: {
    off: 'Doğrulama yok',
    report: 'Bitince doğrula, raporla',
    gate: 'Bitince doğrula; yayın doğrulamayı bekler',
  },
  limit: {
    window: {
      '5h': '5 saatlik',
      weekly: 'haftalık',
      'Opus weekly': 'Opus haftalık',
      'Sonnet weekly': 'Sonnet haftalık',
    },
    /** "%72" — the usage overview's "72%" in Turkish order. */
    percent: (p: { value: string }) => p.value.replace(/^(\d+)%$/, '%$1'),
    limited: 'limitte; eşiğe takılan iş bekler',
    limitedUntil: (p: { time: string }) => `limitte, ${p.time}’de sıfırlanır; eşiğe takılan iş bekler`,
    resets: (p: { time: string }) => `, ${p.time}’te sıfırlanır`,
    multiAccount: (p: { account: string; parts: string; n: number }) =>
      `en boş: ${p.account} — ${p.parts} (${String(p.n)} hesap)`,
  },
  queue: {
    wait: {
      subscription_login: 'abonelik oturumu',
      slot: 'slot bekliyor',
      profile_slot: 'profil slotu',
      budget: 'bütçe',
      off_peak: 'yoğun olmayan saat',
      dependency: 'bağımlılık',
      quota: 'limit',
      approval: 'onay',
      machine: 'makine bekliyor',
      other: 'bekliyor',
    },
    queued: 'sırada',
    startNow: 'boş slot varsa hemen başlar',
    startFirstFree: 'ilk boşalan slotta başlar',
    startAfter: (p: { time: string }) => `≈ ${p.time} sonrası`,
    startAfterJobs: (p: { n: number }) => `${String(p.n)} iş bittikten sonra`,
    first: 'ilk sırada',
    afterPosition: (p: { n: number }) => `#${String(p.n)}’den sonra`,
  },
  slash: {
    job: {
      hint: 'tarif ettiğin işten düzenlenebilir taslak kart çıkar',
      needs: 'ne yapılacağını yaz',
      intent:
        'İstek: bunu düzenlenebilir bir iş taslağı kartı olarak hazırla (draft_job); runtime önerini ve limit durumunu söyle.',
    },
    publish: {
      hint: 'bir sonucu ya da siteyi yayınlamak için taslak kart',
      needs: 'neyi, nereye yayınlayacağını yaz',
      intent:
        'İstek: bunun için bir yayın taslağı hazırla (draft_deploy ya da yeni bir işse draft_job.deployOnSuccess); politika sonucunu söyle.',
    },
    approvals: {
      hint: 'bekleyen onayları önem sırasıyla özetle',
      intent: 'İstek: bekleyen onaylarımı listele (list_approvals) ve önem sırasına koy.',
    },
    limits: {
      hint: 'runtime limit pencereleri ve sıfırlanma saatleri',
      intent:
        'İstek: runtime limitlerimi göster (runtime_limits): hangi pencere ne kadar dolu, ne zaman sıfırlanır.',
    },
    machine: {
      hint: 'bir makinenin slotlarını, işlerini ve limitlerini aç',
      needs: '@ ile makineyi seç',
      /** `tool` is the assistant tool's name (an identifier, not copy). */
      intent: (p: { tool: string }) =>
        `İstek: bu makineyi anlat (${p.tool}): boş slotlar, çalışan ve bekleyen işler, limitler.`,
    },
    cancel: {
      hint: 'bir işi iptal etmek için eylem kartı',
      needs: '@ ile işi seç ya da tarif et',
      intent:
        'İstek: bu işi iptal etmek için bir iş eylemi kartı hazırla (find_jobs, sonra draft_job_action cancel).',
    },
    rerun: {
      hint: 'bir işi aynı ayarlarla yeniden çalıştırma kartı',
      needs: '@ ile işi seç ya da tarif et',
      intent:
        'İstek: bu işi yeniden çalıştırmak için bir iş eylemi kartı hazırla (find_jobs, sonra draft_job_action run_again).',
    },
    missing: (p: { name: string; needs: string }) => `${p.name} için ${p.needs}.`,
    template: (p: { title: string; id: string }) =>
      `İstek: «${p.title}» şablonundan bir iş taslağı hazırla (draft_from_template, templateId ${p.id}); eksik parametreleri bana sor.`,
  },
  card: {
    state: {
      proposed: 'henüz kuyrukta değil',
      confirmed: 'Kuyruğa alındı',
      dismissed: 'Vazgeçildi',
      expired: 'Süresi doldu',
    },
    titleEmpty: 'Başlık boş olamaz.',
    titleTooLong: 'Başlık en fazla 60 karakter olabilir; ayrıntıları açıklamaya yazın.',
    promptEmpty: 'Ajanın ne yapacağını yaz.',
    fixMarked: 'Kuyruğa almadan önce işaretli alanı düzelt.',
    noMachine: 'Bu ayarla hiçbir makine çalıştıramaz.',
    kindDone: 'İş kartı',
    kindDraft: 'Taslak iş kartı',
    openJob: 'İşi aç',
    saving: 'kaydediliyor…',
    enqueue: 'Kuyruğa al',
    dismiss: 'Vazgeç',
    editInForm: 'Formda düzenle',
    saveAsTemplate: 'Şablon olarak kaydet',
    hintBackground: 'Kuyruğa alınca boş kapasitede başlar; onay gerektiren adımlar yine sana gelir.',
    hintNow: 'Kuyruğa alınca sana sorulmadan başlar; onay gerektiren adımlar yine sana gelir.',
    submitCode: 'Kodu gönder ve kuyruğa al',
    adviceLabel: 'Runtime önerisi: ',
    switchTo: (p: { runtime: string }) => `${p.runtime}’e geç`,
    identical: (p: { age: string }) => `Aynı iş ${p.age} başarıyla bitti. `,
    openResult: 'Sonucu aç',
    orEnqueueAnyway: ' ya da yine de kuyruğa al.',
    title: 'Başlık',
    project: 'Proje',
    cls: 'Sınıf',
    clsGroup: 'Kuyruk sınıfı',
    runtimeAndMachine: 'Runtime ve makine',
    tagRecommended: 'önerilen',
    tagLimited: 'limitte',
    tagNear: 'limit',
    noWindow: 'Limit penceresi bildirilmedi.',
    placementWarning: (p: { warning: string }) => `${p.warning} Runtime ya da yalıtımı değiştir.`,
    canRunOn: 'Çalışabileceği makineler: ',
    prompt: 'İstem ve kabul kriterleri',
    queueTitle: 'Kuyrukta nereye girer',
    estimate: 'tahmin',
    queueLoading: 'Kuyruk okunuyor…',
    queueList: 'Kuyruk tahmini',
    moreAhead: (p: { n: number }) => `önünde ${String(p.n)} iş daha`,
    estimatedStart: (p: { start: string }) => `Tahmini başlangıç: ${p.start}.`,
    freeSlots: (p: { n: number }) => ` Havuzda ${String(p.n)} boş slot.`,
    settings: 'Ayarlar',
    publishWhenDone: ' · bitince yayınla',
    approvalMode: 'Onay modu',
    isolation: 'Yalıtım',
    projectDefaultNote: ' Proje varsayılanı.',
    machine: 'Makine',
    machineAuto: 'Otomatik (yerleştirme seçer)',
    deployTitle: 'Bitince yayınla',
    deployEnv: 'Yayın ortamı',
    envPreview: 'Önizleme',
    envProduction: 'Canlı',
    removeDeploy: 'Yayını kaldır',
    productionCode: 'Canlı yayın onaylarken taze authenticator kodu ister.',
    verify: 'Doğrulama',
    projectDefault: 'Proje varsayılanı',
    paths: 'Yollar ve girdiler',
    mainBranch: 'ana branch',
    earlierFiles: 'Önceki işlerin dosyaları girdi olarak verilir.',
    /** p19-repo-job-inputs: where a repository job finds its input files. */
    repoInputsNote:
      'Repo işi bu dosyaları checkout’un yanındaki geçici in/ klasöründen okur; commit edilmez.',
    removeInputs: 'Girdi dosyalarını çıkar',
    fromTemplate: 'Bu kart bir şablondan hazırlandı.',
    details: 'Ayrıntılar',
    expiresIn: 'Taslağın süresinin dolmasına',
  },
};
