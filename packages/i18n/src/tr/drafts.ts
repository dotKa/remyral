/**
 * p14-i18n-screens-a (i18n Phase 5): Sohbet's draft cards (apps/web/src/diyalog/drafts) — the card of every draft
 * kind the assistant proposes, its facts and notes, the ops diff (deploy / DNS / Pages), the job checklist and
 * per-job results, the result links, the webhook secret, the quick buttons and the approval mode of a started job.
 * Every value comes from the model / master payload and is interpolated as text.
 */
export default {
  /** The card's kind pill; unknown kinds read `fallbackKind`. */
  kinds: {
    job: 'İş taslağı',
    workflow_run: 'Workflow çalıştırma',
    worker_config: 'Makine ayarı değişikliği',
    approval_decision: 'Onay kararı',
    job_message: 'Çalışan işe mesaj',
    machine_task: 'Makine yönetimi işi',
    tool_install: 'Araç kurulumu',
    skill: 'Yetenek taslağı',
    automation: 'Otomasyon',
    automation_change: 'Otomasyon değişikliği',
    ops_action: 'Yayın / DNS değişikliği',
    monitor: 'İzleme taslağı',
    job_resume: 'Duraklatılmış iş',
    job_action: 'İş eylemi',
    memory_change: 'Hafıza değişikliği',
    workflow: 'Workflow taslağı',
    account_action: 'Runtime hesabı',
  },
  fallbackKind: 'Taslak',
  states: {
    proposed: 'Henüz çalışmadı',
    confirmed: 'Onaylandı',
    dismissed: 'Vazgeçildi',
    expired: 'Süresi doldu',
  },
  /** Row labels of the card's facts. */
  facts: {
    canRunOn: 'Çalışabileceği makineler',
    project: 'Proje',
    inputFiles: 'Girdi dosyaları',
    isolation: 'Yalıtım',
    approvalMode: 'Onay modu',
    workspace: 'Çalışma alanı',
    repo: 'Depo',
    limits: 'Sınırlar',
    projectDefaults: 'Proje varsayılanları',
    prompt: 'İstem',
    deploy: 'Yayın',
    step: (p: { n: number }) => `Adım ${String(p.n)}`,
    verify: 'Doğrulama',
    fallbackRuntime: 'Yedek runtime',
    when: 'Ne zaman',
    version: 'Sürüm',
    steps: 'Adımlar',
    note: 'Not',
    inputs: 'Girdiler',
    machine: 'Makine',
    reason: 'Gerekçe',
    request: 'İstek',
    decision: 'Karar',
    job: 'İş',
    message: 'Mesaj',
    action: 'Eylem',
    approvals: 'Onaylar',
    maxDuration: 'En uzun süre',
    task: 'Görev',
    tool: 'Araç',
    skill: 'Yetenek',
    runtimes: 'Runtime’lar',
    change: 'Değişiklik',
    description: 'Açıklama',
    trigger: 'Tetikleyici',
    runs: 'Çalışır',
    automation: 'Otomasyon',
    env: 'Ortam',
    target: 'Hedef',
    rollsBack: 'Geri aldığı',
    site: 'Site',
    checks: 'Denetler',
    name: 'Ad',
    interval: 'Sıklık',
    jobs: 'İşler',
    class: 'Sınıf',
    type: 'Tür',
    where: 'Nerede',
    statement: 'İfade',
    record: 'Kayıt',
    rationale: 'Gerekçe',
    consequences: 'Sonuçları',
    decidedOn: 'Karar tarihi',
    reviewBy: 'Gözden geçirme',
    why: 'Neden',
    account: 'Hesap',
  },
  limits: {
    maxDurationSec: 'en uzun süre (sn)',
    maxCostUsd: 'en çok maliyet ($)',
    maxTokens: 'en çok token',
    maxTurns: 'en çok tur',
  },
  live: 'canlı',
  preview: 'önizleme',
  runtimeModel: (p: { runtime: string; model: string | null }) =>
    `${p.runtime}${p.model === null ? ' · proje varsayılan modeli' : ` · ${p.model}`}`,
  noRepo: 'depo yok',
  /** p10-publish-bundle: the chain of a "deploy when done" with publish fields. */
  chain: {
    pagesTarget: 'Pages hedefi',
    create: (p: { name: string }) => `${p.name} Pages projesi yoksa oluştur`,
    publish: (p: { name: string; env: string }) => `Siteyi ${p.name} projesine yayınla (${p.env})`,
    domain: (p: { domain: string }) => `${p.domain} alan adını bağla`,
    cname: (p: { domain: string; name: string }) =>
      `${p.domain} → ${p.name}.pages.dev CNAME kaydını yaz (projenin izinli alanında)`,
  },
  deployValue: (p: { where: string; env: string; dir: string | null; chain: boolean }) =>
    `Başarılı olunca ${p.where} (${p.env})${p.dir === null ? '' : `, ${p.dir}/ klasöründen`} yayınlanır — ${
      p.chain
        ? 'onaylamak aşağıdaki her adımı birden onaylar (canlı ya da DNS varsa taze authenticator kodu)'
        : 'onaylamak yayını da onaylar'
    }`,
  verify: {
    off: 'Kendiliğinden doğrulanmaz',
    report: 'Başarılı olunca doğrulanır (rapor)',
    gate: 'Başarılı olunca doğrulanır; yayın doğrulamanın geçmesini bekler',
  },
  offPeak: 'projenin yoğun olmayan saatlerinde',
  inputs: {
    fromJob: (p: { id: string }) => `${p.id}… işinden`,
    fromChat: 'bu sohbetten',
    allResults: (p: { id: string }) => `${p.id}… işinin tüm sonuçları`,
    artifact: (p: { id: string; artifact: string }) => `${p.id}… işinin ${p.artifact} dosyası`,
    chatFiles: (p: { n: number }) => `bu sohbette eklenen ${String(p.n)} dosya`,
  },
  machineAdmin: {
    allow: 'Yetkili komutlar sormadan çalışır (bu makinede tam erişime izin var); her biri kayda geçer.',
    ask: 'Her yetkili komut konsolda senin onayını bekler.',
    elevatedTool:
      'Makine yönetimi gerekir: sürümün sabit kurulum komutlarıyla bir makine yönetimi işi olarak çalışır.',
  },
  triggers: {
    cron: (p: { cron: string }) => `Cron ${p.cron} (UTC)`,
    at: (p: { at: string }) => `Bir kez, ${p.at}`,
    github: (p: { event: string; actions: string; repo: string }) =>
      `GitHub ${p.event}${p.actions === '' ? '' : ` ${p.actions}`} — ${p.repo}`,
    webhook: 'İmzalı webhook (gizli değer onaydan sonra bir kez gösterilir)',
    chain: (p: { id: string; on: readonly string[] }) =>
      `${p.id} otomasyonundan sonra (${p.on.join(' ya da ')})`,
  },
  automationActions: {
    pause: 'Duraklat',
    resume: 'Sürdür',
    delete: 'Sil',
    run_now: 'Şimdi çalıştır',
  },
  automationFields: {
    concurrency: 'Eşzamanlılık',
    catchUp: 'Kaçırılanları çalıştır',
    maxRunsPerHour: 'Saatte en çok çalışma',
    notifyOnFailure: 'Hatada bildir',
    approvalTimeoutMinutes: 'Onay bekleme süresi (dk)',
  },
  automation: {
    update: (p: { name: string }) => `${p.name} değişir`,
    create: 'Oluştur',
    timeout: (p: { n: number }) => `${String(p.n)} dk karar gelmezse iptal`,
    noTimeout: 'onay bekleme sınırı yok',
    external:
      'Bu otomasyon dışarıdan (GitHub ya da bir webhook çağrısıyla) iş başlatır. Olayın içeriği ajana yalnızca güvenilmeyen veri olarak ulaşır.',
  },
  /** p6-deploy-integrations: ops action kinds (`<provider>.<action>`). */
  opsKinds: {
    coolify: {
      deploy: 'Coolify yayını',
      restart: 'Coolify yeniden başlatma',
      rollback: 'Coolify geri alma',
    },
    pages: {
      deploy: 'Pages yayını',
      rollback: 'Pages geri alma',
      create_project: 'Pages projesi',
      add_domain: 'Pages alan adı',
      publish: 'Siteyi yayınla',
    },
    dns: {
      upsert: 'DNS değişikliği',
      delete: 'DNS silme',
    },
    tunnel: {
      open: 'Önizleme aç',
      close: 'Önizleme kapat',
      extend: 'Önizleme uzat',
    },
  },
  decisions: {
    auto: 'Hemen çalışır (önizleme)',
    approval: 'Onay bekler',
    approval_step_up: 'Onay ve authenticator kodu bekler',
    refused: (p: { reason: string }) => `Reddedildi${p.reason === '' ? '' : `: ${p.reason}`}`,
  },
  ops: {
    rollbackPolicy:
      'Geri alma yeni bir eylemdir: onay bekleyip beklemeyeceğine proje politikası karar verir.',
    rollback: (p: { kind: string }) => `${p.kind} geri al`,
  },
  jobActions: {
    cancel: 'İptal et',
    run_again: 'Yeniden çalıştır',
    continue: 'Devam ettir',
    set_class: 'Sınıfı değiştir',
    move: 'Kuyrukta taşı',
    run_now: 'Şimdi çalıştır (Acil)',
    resolve_conflicts: 'Çakışmayı çöz',
  },
  /** What confirming a job action card does, in one sentence. */
  jobActionEffect: {
    cancel: (p: { n: number }) =>
      `${p.n === 1 ? 'İş' : 'İşaretli her iş'} iptal edilir; çalışan iş makinesinde durdurulur.`,
    runAgain: (p: { n: number; prompt: boolean }) =>
      `${p.n === 1 ? 'Onun' : 'İşaretli her işin'} için aynı ayarlarla ve yeni bir çalışma branch’iyle yeni bir iş başlar${
        p.prompt ? ', düzenlenmiş istemle' : ''
      } (girdi dosyaları ve bitince yayın taşınmaz).`,
    continue: (p: { n: number }) =>
      `Onayı süresi dolan ${p.n === 1 ? 'işi' : 'her işaretli işi'} yeni bir iş sürdürür; önceden onaylanmış bir şey yok.`,
    setClass: (p: { n: number; cls: string | null }) =>
      `${p.n === 1 ? 'İş' : 'İşaretli her iş'} kuyrukta ${p.cls ?? 'başka bir'} sınıfına geçer.`,
    move: (p: { target: string | null; before: boolean }) =>
      `İş kuyrukta ${p.target === null ? 'diğer işin' : `${p.target} işinin`} ${p.before ? 'önüne' : 'arkasına'} geçer (kendi sınıfı içinde).`,
    runNow: 'İş Acil olur ve kuyrukta ilk sıraya geçer.',
    resolveConflicts: (p: { n: number }) =>
      `${p.n === 1 ? 'İşin' : 'İşaretli her işin'} hedef dalla çakışan sonucu, güncel dalın üzerine yeni bir işle taşınır; o iş birleşince eski PR platform tarafından kapatılır.`,
    other: 'Eylem işaretli her işte çalışır.',
  },
  memoryTypes: {
    rule: 'kural',
    fact: 'bilgi',
    decision: 'karar',
    lesson: 'ders',
  },
  memoryTypeOther: 'kayıt',
  memoryTargets: {
    project: 'proje hafızası',
    user: 'kişisel kuralların',
    global: 'genel hafıza',
    projectRuntime: (p: { project: string; runtime: string }) =>
      `${p.project} projesi (${p.runtime} runtime’ı)`,
    named: (p: { project: string }) => `${p.project} projesi`,
  },
  memoryChange: {
    replace: (p: { target: string; id: string; type: string; statement: string }) =>
      `${p.target} içindeki ${p.id} ${p.type} kaydını şununla değiştir: ${p.statement}`,
    retire: (p: { id: string; type: string; reason: string }) =>
      `${p.id} ${p.type} kaydını emekliye ayır${p.reason === '' ? '' : ` (${p.reason})`}: yeni işler artık onu almaz.`,
    add: (p: { target: string; type: string; statement: string }) =>
      `${p.target} için ${p.type} ekle: ${p.statement}`,
  },
  memoryActions: {
    replace: 'Değiştir',
    retire: 'Emekliye ayır',
    add: 'Ekle',
  },
  /** p13-workflows-ui: workflow step roles ("integrator" keeps its English name in both languages). */
  roles: {
    planner: 'Planlayıcı',
    executor: 'İş adımı',
    verifier: 'Doğrulama',
    reviewer: 'İnceleme',
  },
  workflow: {
    isNew: 'Yeni workflow (v1)',
    step: (p: { id: string; role: string; gate: string | null }) =>
      `${p.id} (${p.role}${p.gate === null ? '' : `, onay: ${p.gate}`})`,
    valid: (p: { isNew: boolean }) =>
      `Geçerli. Onaylamak ${p.isNew ? 'workflow’u kaydeder' : 'yeni bir sürüm kaydeder'}; hiçbir şey çalışmaz.`,
    invalid: 'Henüz geçerli değil — asistandan düzeltmesini iste:',
  },
  approvalDecision: {
    approve: 'Onayla',
    deny: 'Reddet',
  },
  jobResume: {
    restart: 'Baştan başlat',
    resume: 'Şimdi devam ettir',
  },
  minutes: (p: { n: number }) => `${String(p.n)} dk`,
  skill: {
    version: (p: { id: string; version: string; base: string | null }) =>
      `${p.id} ${p.version}${p.base === null ? ' (yeni)' : ` (${p.base} sürümünden)`}`,
    notice: (p: { all: boolean }) =>
      `Onaylamak bu sürümü panelin yetenek anahtarıyla imzalar ve yayınlar${p.all ? ' — TÜM projelere' : ''}.`,
    noChanges: '(değişiklik yok)',
    diffRegion: 'Yeteneğin farkı',
    diffTitle: 'Fark — onaylamak bunu imzalar',
  },
  monitor: {
    outputChecks: 'adresini ve Cloudflare Pages / Coolify durumunu',
    coolifyApp: (p: { uuid: string }) => `Coolify uygulaması ${p.uuid}`,
    every: (p: { n: string }) => `${p.n} sn’de bir`,
  },
  accountActions: {
    pause: 'Hesabı duraklat',
    resume: 'Hesabı sürdür',
    switch_job: 'İşin hesabını değiştir',
  },
  /** The ops diff of a deploy / DNS / Pages card ("Ne değişecek"). */
  diff: {
    region: 'Değişikliğin farkı',
    title: 'Ne değişecek',
    actions: {
      create: 'Oluştur',
      update: 'Güncelle',
      delete: 'Sil',
      upsert: 'Yaz',
      deploy: 'Yayınla',
      restart: 'Yeniden başlat',
      rollback: 'Geri al',
    },
    sources: {
      siteBundle: 'işin site paketinden',
      outputFiles: 'işin çıktı dosyalarından',
      upload: 'yüklenen bir siteden',
    },
    ttlAuto: 'otomatik',
    content: 'İçerik',
    proxy: 'Proxy',
    inZone: (p: { zone: string }) => `${p.zone} alanında`,
    caption: 'DNS kaydı: şimdi ve sonra',
    field: 'Alan',
    now: 'Şimdi',
    after: 'Sonra',
    changing: 'değişiyor',
    forceRebuild: 'zorla yeniden derle',
    currently: (p: { commit: string }) => `şimdi ${p.commit}`,
    project: (p: { project: string }) => `${p.project} projesi`,
    branch: (p: { branch: string }) => `branch ${p.branch}`,
    toDeployment: (p: { id: string }) => `${p.id} yayınına`,
    upload: (p: { files: string; size: string }) => `${p.files} dosya · ${p.size}`,
    uploadedBy: (p: { who: string }) => `yükleyen ${p.who}`,
    serves: (p: { list: string }) => `Sunduğu adresler: ${p.list}`,
    willServe: (p: { list: string }) => `Sunacağı adresler: ${p.list}`,
    masterWrites: 'DNS (master yazar):',
    manual: 'Bu kaydı alan adının DNS sağlayıcısına elle ekle: ',
    skipped: 'DNS’e dokunulmaz (kayıt şu olurdu: ',
    unchanged: 'DNS kaydı zaten doğru.',
    attach: 'Bağla:',
    attached: 'Zaten bağlı:',
    toPagesProject: (p: { project: string }) => `→ ${p.project} Pages projesi`,
    status: (p: { status: string }) => `durum ${p.status}`,
    adopt: 'Var olan Pages projesini kullan:',
    createProject: 'Pages projesi oluştur:',
    productionBranch: (p: { branch: string; subdomain: string }) =>
      `canlı branch ${p.branch} · ${p.subdomain}`,
    directUpload: 'doğrudan yükleme (depo bağlı değil)',
    domains: (p: { list: string }) => `Alan adları: ${p.list}`,
    pagesTarget: 'Bu projenin Pages hedefi: ',
    added: 'Bu projenin Pages projelerine eklenir; Pages hedefi ',
    notSet: 'ayarlı değil',
    stays: 'olarak kalır',
    pagesProject: (p: { env: string }) => `Pages projesi · ${p.env}`,
    oneApproval:
      'Tek onay her adımı kapsar; her adım çalışırken yeniden denetlenir ve zincir ilk hatada durur.',
    stepDecisions: {
      auto: 'hemen çalışır',
      approval: 'onay ister',
      approval_step_up: 'onay + kod ister',
      refused: (p: { reason: string }) => `reddedildi${p.reason === '' ? '' : `: ${p.reason}`}`,
    },
    steps: {
      create: (p: { project: string; subdomain: string; done: boolean }) =>
        `${p.project} Pages projesini oluştur (doğrudan yükleme, ${p.subdomain})${p.done ? ' (zaten yapılmış)' : ''}`,
      deploy: (p: { env: string; files: string; size: string; project: string; done: boolean }) =>
        `Yayınla (${p.env}): ${p.files} dosya · ${p.size} → ${p.project}${p.done ? ' (zaten yapılmış)' : ''}`,
      domain: (p: { domain: string; attached: boolean; done: boolean }) =>
        `${p.attached ? 'Alan adı zaten bağlı:' : 'Alan adını bağla:'} ${p.domain}${p.done ? ' (zaten yapılmış)' : ''}`,
      dnsWrite: (p: { domain: string; target: string; zone: string; previous: string | null }) =>
        `CNAME ${p.domain} → ${p.target}, ${p.zone} alanında (${p.previous === null ? 'yeni kayıt' : `önceki ${p.previous}`})`,
      dnsWriteNote: 'alan adı adımının parçası',
      dnsManual: (p: { domain: string; target: string }) =>
        `CNAME ${p.domain} → ${p.target} kaydını alan adının DNS sağlayıcısına ekle (hesabın dışında)`,
      dnsManualNote: 'elle',
      dnsSkipped: (p: { target: string }) => `DNS’e dokunulmaz (CNAME → ${p.target} olurdu)`,
      dnsSkippedNote: 'atlandı',
      dnsUnchanged: (p: { domain: string; target: string }) =>
        `CNAME ${p.domain} zaten ${p.target} adresini gösteriyor`,
      dnsUnchangedNote: 'iş yok',
    },
  },
  /** The parts below a card: job checklist, results, links, webhook secret, quick buttons, approval mode. */
  parts: {
    selected: (p: { n: number; total: number }) =>
      `${String(p.total)} işten ${String(p.n)} tanesi seçili — işareti kaldırdığın iş eylemin dışında kalır.`,
    jobsRegion: 'Eylemin işleri',
    untitled: 'Adsız iş',
    include: (p: { label: string }) => `Dahil et: ${p.label}`,
    outcomes: {
      done: 'Yapıldı',
      skipped: 'Atlandı',
      refused: 'İzin yok',
      failed: 'Başarısız',
    },
    resultsRegion: 'İş başına sonuç',
    openNewJob: 'Yeni işi aç',
    links: {
      job: 'İşi aç',
      run: 'Workflow çalıştırmasını aç',
      workflow: "Workflow'u aç",
      automation: 'Otomasyonu aç',
      monitor: 'İzlemeyi aç',
      deploy: 'Yayını aç',
      skills: 'Yetenekleri aç',
      machineTools: 'Makinenin araçlarını aç',
    },
    memoryDone: (p: { status: string | null }) => `Yapıldı${p.status === null ? '' : ` (${p.status})`}. `,
    openRules: 'Kişisel kuralları aç',
    openMemory: 'Hafızada aç',
    conflicts: (p: { n: number }) => ` Orada gözden geçirilecek ${String(p.n)} olası çakışma var.`,
    webhookSave: 'Bu webhook gizli değerini şimdi sakla: bir daha gösterilmez.',
    address: 'Adres ',
    copySecret: 'Gizli değeri kopyala',
    copyAddress: 'Adresi kopyala',
    cancel: 'İptal et',
    runAgain: 'Yeniden çalıştır',
    openJob: 'İşi aç',
    draftedCancel: 'Bu işi iptal etmek için aşağıya bir kart eklendi — sen onaylamadan hiçbir şey olmaz.',
    draftedRunAgain:
      'Bu işi yeniden çalıştırmak için aşağıya bir kart eklendi — sen onaylamadan hiçbir şey olmaz.',
  },
  approvalMode: {
    applications: {
      live: 'Runtime yeni modu canlı uyguladı.',
      gate: 'Makinenin onay kapısı uyguluyor.',
      partial: 'Yalnızca kısmen uygulandı.',
      next_turn: 'Runtime’ın bir sonraki turundan itibaren geçerli.',
      refused: 'Makine reddetti — runtime önceki modunda kalıyor.',
    },
    notRunning: 'İş başlayınca geçerli olur.',
    waiting: 'Makinenin onayı bekleniyor.',
    stepUp: 'Yetkili komutları onaysız çalıştırmak taze bir authenticator kodu ister.',
    region: 'İşin onay modu',
    label: 'Onay modu',
    notAllowed: ' — izin yok',
    change: 'Değiştir',
    changeNow: 'Şimdi değiştir',
    original: (p: { mode: string }) => `başlangıçta: ${p.mode}`,
    liveNote: ' Çalışan iş hemen geçer; bekleyen onaylar yeni modun karar verdiği yerde çözülür.',
    resolved: (p: { n: number }) => ` Bekleyen ${String(p.n)} onay yeni modla çözüldü.`,
  },
  /** oss-sec3: a card held because the assistant's turn read content from outside the person. */
  held: {
    title: 'Doğrudan çalıştırılmadı',
    body: 'Asistan bu turda dışarıdan gelen içerik okudu (iş günlüğü ya da çıktısı, depo dosyası, fark, web yanıtı, ek). Bu içerikteki gizli bir talimat da bu kartı istemiş olabilir; onaylamadan önce gerçekten istediğin şey olduğunu kontrol et.',
    remember: 'Bunu hatırla: bu tür işlemi bu hedefte bir daha sorma',
    rememberHint:
      'Yalnız aynı işlem türü ve aynı hedef (proje, adres, makine) için geçerli. Ayarlar → Sohbet → Hatırlanan onaylar’dan geri alabilirsin.',
    always:
      'Bu tür işlem (makine yönetimi, onay kararları, ayarlar, kimlik bilgileri, hafıza, kurulumlar) böyle bir turda her seferinde sorulur.',
  },
  /** The card frame (DyDraftCard). */
  card: {
    usageLimit: 'Limit: ',
    classLine: (p: { cls: string }) => `Sınıf: ${p.cls}`,
    fullAccess: 'Tam erişim',
    machineAdmin: 'Makine yönetimi (root / Administrator)',
    noAsk: 'Onay sormadan',
    allowAllNote:
      'Runtime’ın araç çağrıları sormadan çalışır. Korumalı branch’e birleştirme, zorla push, deploy ve kimlik kasası yine master onayı ister.',
    unconfinedNote: 'Makinenin servis hesabıyla, dosya ve ağ sınırı olmadan çalışır.',
    identical: (p: { age: string }) => `Aynı iş ${p.age} başarıyla bitti. `,
    openResult: 'Sonucu aç',
    orConfirm: ' — ya da yine de onayla.',
    advice: 'Runtime önerisi: ',
    adviceDiffers: ' — bu kart başka bir runtime kullanıyor; katılıyorsan asistandan değiştirmesini iste.',
    hideDetails: 'Ayrıntıları gizle',
    details: 'Ayrıntılar',
    instead: (p: { was: string }) => `${p.was} yerine.`,
    allowAllWhere:
      ' “Hiç sorma” yalnızca projenin (makine görevlerinde makinenin de) izin verdiği yerde çalışır.',
    classLabel: 'Sınıf',
    queueClass: 'Kuyruk sınıfı',
    classInstead: (p: { was: string }) => `${p.was} yerine. `,
    urgentWhy: 'Asistan Acil işaretledi çünkü aciliyet istedin. ',
    expires: 'Taslağın süresinin dolmasına',
    proposedAt: 'Önerildi',
    confirm: 'Onayla',
    dismiss: 'Vazgeç',
    editInForm: 'Formda düzenle',
    saveTemplate: 'Şablon olarak kaydet',
    pickOne: 'En az bir iş seç.',
    invalidWorkflow: 'Geçersiz workflow onaylanamaz; asistandan sorunları düzeltmesini iste.',
    readRed: 'Onaylamadan önce kırmızı uyarıyı oku; onay authenticator kodu ister.',
    nothingRuns: 'Hiçbir şey sen onaylamadan çalışmaz; onay authenticator kodu ister.',
    submitCode: 'Kodu gönder ve onayla',
  },
};
