import type { ReasonVars } from '../reason-vars.js';

/**
 * p14-i18n-reasons (i18n Phase 4; was apps/web/src/diyalog/common/reasonsTr.ts): the reason codes the master, the
 * scheduler and the worker report, said in Turkish — one sentence per code (`codes`) and the label of the fix
 * (`actions`; the fix's target stays in apps/web/src/lib/reasons.ts). A code whose sentence depends on why it
 * happened holds variants chosen by `params.cause` (`default`: no cause; the causes are REASON_CAUSES in
 * `@remyral/protocol/reasons`, `pnpm check:i18n` keeps them in step). Every scheduler REASON_CODES entry has a
 * sentence here; an unknown code shows the reported raw text, never an invented sentence.
 */

const rt = (v: ReasonVars): string => v.runtime ?? 'Runtime';
const rtLower = (v: ReasonVars): string => v.runtime ?? 'bu runtime';
const rtName = (v: ReasonVars): string => v.runtime ?? 'runtime';
/** "mac-1 makinesinde" / "bu makinede" — the name never takes a case suffix. */
const onM = (v: ReasonVars): string => (v.machine === null ? 'bu makinede' : `${v.machine} makinesinde`);
/** "mac-1 makinesinin" / "bu makinenin". */
const ofM = (v: ReasonVars): string => (v.machine === null ? 'bu makinenin' : `${v.machine} makinesinin`);
/** "mac-1 makinesi" / "Bu makine" (sentence subject). */
const M = (v: ReasonVars): string => (v.machine === null ? 'Bu makine' : `${v.machine} makinesi`);
/** "mac-1 makinesine" / "bu makineye". */
const toM = (v: ReasonVars): string => (v.machine === null ? 'bu makineye' : `${v.machine} makinesine`);

const unproven = (v: ReasonVars): string =>
  `${rt(v)} ${onM(v)} henüz kanıtlanmadı. Makine → Runtime’lar → Doğrula ile kanıtla ya da Runtime politikasında bir kez izin ver.`;
const notInstalled = (v: ReasonVars): string => `${rt(v)} ${onM(v)} kurulu değil.`;
const signedOut = (v: ReasonVars): string => `${rt(v)} ${onM(v)} oturumu kapalı.`;
const notPinned = (v: ReasonVars): string => `${onM(v)} çalışan ${rt(v)} sabitlenen sürüm değil.`;
const notAllowed = (v: ReasonVars): string =>
  `${ofM(v)} runtime politikası ${rtLower(v)} için izin vermiyor.`;
/** Glossary: "makine", not "worker" — the machine runs a release too old for `what`. */
const tooOld = (v: ReasonVars, what: string): string =>
  `${M(v)} ${what} için fazla eski bir sürüm çalıştırıyor. Makineyi güncelle.`;
const sharedLoginRace = (v: ReasonVars): string =>
  `${onM(v)} iki ${rtName(v)} çalışması paylaşılan abonelik girişini aynı anda yeniledi; giriş büyük olasılıkla artık geçerli değil. Yeniden giriş yap; oradaki abonelik işleri artık tek tek çalışır.`;
const doesNotTakeProject = (v: ReasonVars): string => `${M(v)} bu projeden iş almıyor.`;
const offline = (v: ReasonVars): string => `${M(v)} çevrim dışı.`;

export default {
  codes: {
    // Runtime readiness on a machine.
    capability_unverified: (v: ReasonVars) => unproven(v),
    unverified: (v: ReasonVars) => unproven(v),
    runtime_not_installed: (v: ReasonVars) => notInstalled(v),
    not_installed: (v: ReasonVars) => notInstalled(v),
    runtime_not_authenticated: {
      default: (v: ReasonVars) => signedOut(v),
      /** p10-claude-login-health: the job waits (transient) until the wait time runs out. */
      login_wait: (v: ReasonVars) =>
        `${rt(v)} ${onM(v)} yeniden giriş bekliyor — iş bekler ve sen yeniden giriş yapınca kendiliğinden başlar.`,
    },
    not_authenticated: {
      default: (v: ReasonVars) => signedOut(v),
      /** p14-login-status-consistency: jobs use no sign-in method / an API key — a login does not help. */
      no_job_auth: (v: ReasonVars) =>
        `${onM(v)} ${rt(v)} işleri için bir kimlik doğrulama yöntemi seçilmemiş, bu yüzden işler abonelik oturumunu kullanmıyor.`,
      job_auth_secret_ref: (v: ReasonVars) =>
        `${onM(v)} ${rt(v)} işleri abonelik oturumunu değil, orada bulunmayan bir API anahtarını kullanıyor.`,
    },
    login_expired: {
      default: (v: ReasonVars) => `${onM(v)} ${rtName(v)} girişinin süresi doldu.`,
      /** p9-windows-slots-local-login (older workers): parallel runs refreshed one shared login at once. */
      shared_refresh_race: (v: ReasonVars) => sharedLoginRace(v),
    },
    login_refresh_contention: {
      /** A login report: the shared login was refreshed twice at once — log in again. */
      default: (v: ReasonVars) => sharedLoginRace(v),
      /** p10-claude-login-health: this run lost the refresh race; the login is fine. */
      run_again: (v: ReasonVars) =>
        `${onM(v)} başka bir ${rtName(v)} süreci o anda aynı girişi yeniliyordu, bu yüzden bu çalışma başlayamadı. Giriş sağlam — işi yeniden çalıştır.`,
    },
    runtime_version_unverified: (v: ReasonVars) => notPinned(v),
    pin_mismatch: (v: ReasonVars) => notPinned(v),
    runtime_version_mismatch: (v: ReasonVars) =>
      `${onM(v)} çalışan ${rt(v)} bu işin kullanamayacağı bir sürüm.`,
    runtime_not_allowed_by_policy: (v: ReasonVars) => notAllowed(v),
    not_allowed: (v: ReasonVars) => notAllowed(v),
    runtime_not_enabled: (v: ReasonVars) => `${v.runtime ?? 'Bu runtime'} ${onM(v)} etkin değil.`,
    no_ready_runtime: (v: ReasonVars) => `${M(v)} üzerinde iş çalıştırmaya hazır bir runtime yok.`,
    degraded: (v: ReasonVars) =>
      `${rt(v)} ${onM(v)} burada henüz kanıtlanmamış özelliklerle çalışıyor (Runtime politikasında izin verildi). Kanıtlamak için: Makine → Runtime’lar → Doğrula.`,
    unsupported: (v: ReasonVars) => `${rt(v)} ${onM(v)} çalışamaz: gereken bir özellik desteklenmiyor.`,
    capabilities_unknown: (v: ReasonVars) => `${M(v)} neleri çalıştırabildiğini henüz bildirmedi.`,
    runtime_removed: (_v: ReasonVars) =>
      'OpenHands platformdan kaldırıldı (ADR-0023). Claude Code, Codex, Pi veya OpenCode’u seç.',
    model_profile_unavailable: (_v: ReasonVars) =>
      'Seçilen model profili kapalı, silinmiş ya da bu runtime için geçerli değil.',
    model_profile_not_allowed: (_v: ReasonVars) =>
      'Runtime politikası seçilen model profiline izin vermiyor.',
    credential_missing: (v: ReasonVars) => `Runtime’ın kimlik bilgisi ${toM(v)} henüz ulaşmadı.`,
    secret_bound_to_other_worker: (_v: ReasonVars) => 'İşin sırrı başka bir makineye mühürlenmiş.',
    // Tools, sandbox and policy.
    tool_missing: (v: ReasonVars) => `İşin ihtiyaç duyduğu bir araç (örneğin git) ${onM(v)} eksik.`,
    sandbox_profile_unavailable: (v: ReasonVars) => `İşin ihtiyaç duyduğu sandbox ${onM(v)} hazır değil.`,
    unconfined_not_enabled: (v: ReasonVars) => `Tam makine erişimi ${onM(v)} kapalı.`,
    unconfined_not_opted_in: (_v: ReasonVars) => 'Bu proje tam makine erişimine izin vermiyor.',
    host_execution_not_enabled: (_v: ReasonVars) =>
      'Bu proje doğrudan makine üzerinde çalıştırmaya izin vermiyor.',
    auto_approve_not_allowed: (_v: ReasonVars) => 'Bu proje hiç onay istemeyen işlere izin vermiyor.',
    approval_policy_unsupported: (v: ReasonVars) => tooOld(v, 'hiç onay istemeyen işler'),
    workspace_unsupported: (v: ReasonVars) => tooOld(v, 'çalışma alanı projeleri'),
    pr_head_unsupported: (v: ReasonVars) => tooOld(v, 'fork’lardan gelen pull request’leri almak'),
    site_bundle_unsupported: (v: ReasonVars) => tooOld(v, 'Pages yayınları için site paketi oluşturmak'),
    /** p16-zip-job-input: the job pulls the files of a .zip into in/ (input-bundle-v1). */
    input_bundle_unsupported: (v: ReasonVars) => tooOld(v, '.zip’ten gelen iş girdisi dosyalarını almak'),
    /** p19-repo-job-inputs: a repository job with input files (repo-inputs-v1). */
    repo_inputs_unsupported: (v: ReasonVars) => tooOld(v, 'repo işine girdi dosyası vermek'),
    /** p14-skill-catalogs (ADR-0054): the job's skills need the wider skill layout (skills-layout-v2). */
    skill_layout_unsupported: (v: ReasonVars) => tooOld(v, 'geniş düzenli (büyük) yetenekleri almak'),
    /** p14-mcp-core: the job carries external MCP servers (mcp-v1). */
    mcp_unsupported: (v: ReasonVars) => tooOld(v, 'dış MCP sunucularıyla iş almak'),
    /** p14-workflow-engine 14.3: workflow HTTP / e-mail / code nodes run as function jobs (function-v1). */
    function_unsupported: (v: ReasonVars) =>
      tooOld(v, 'workflow HTTP, e-posta ve kod düğümlerini çalıştırmak'),
    /** p14-mcp-stdio: the job pins a local (npm / PyPI) MCP package this machine has not installed. */
    mcp_not_installed: (v: ReasonVars) =>
      `Bu işin yerel MCP paketi ${onM(v)} kurulu değil. Yetenekler → MCP sunucuları → Kur.`,
    integration_unsupported: (v: ReasonVars) => tooOld(v, 'bir entegrasyon için branch’leri birleştirmek'),
    machine_admin_unsupported: (v: ReasonVars) => tooOld(v, 'makine yönetimi görevleri'),
    machine_admin_not_enabled: (v: ReasonVars) => `Makine yönetimi görevleri ${onM(v)} kapalı.`,
    // Assignment.
    project_not_assigned: (v: ReasonVars) => `${M(v)} bu projeye atanmamış.`,
    project_not_allowed: (v: ReasonVars) => doesNotTakeProject(v),
    project_not_in_worker_allowlist: (v: ReasonVars) => doesNotTakeProject(v),
    repo_not_registered: (_v: ReasonVars) => 'Projenin deposu kayıtlı değil.',
    config_not_applied: (v: ReasonVars) => `${M(v)} yapılandırmasını henüz uygulamadı.`,
    blocked_by_local_ceiling: (v: ReasonVars) =>
      `${ofM(v)} yerel ayar dosyası buna izin vermiyor. Makinede değiştir.`,
    worker_not_selected: (_v: ReasonVars) => 'İş başka makinelere sabitlenmiş.',
    os_mismatch: (_v: ReasonVars) => 'İş farklı bir işletim sistemi istiyor.',
    arch_mismatch: (_v: ReasonVars) => 'İş farklı bir işlemci mimarisi istiyor.',
    declined_before: (v: ReasonVars) => `${M(v)} bu işi daha önce reddetti.`,
    no_free_slot: (v: ReasonVars) => `${M(v)} meşgul: bütün iş yuvaları dolu.`,
    /** p15-merge-approvals: free disk under the workspace root is below the machine's minimum (transient). */
    disk_low: (v: ReasonVars) =>
      `Boş disk ${onM(v)} ayarlanan en az boş disk değerinin altında; iş yer açılınca ya da başka bir makinede başlar.`,
    /** p14-workflow-engine 14.3: function jobs (HTTP / e-mail / code nodes) have slots of their own. */
    no_free_function_slot: (v: ReasonVars) =>
      `${M(v)} meşgul: workflow düğümleri için ayrılan yuvaların hepsi dolu. İş bekliyor.`,
    // p9-queue-priority (transient: the job waits).
    no_free_profile_slot: (v: ReasonVars) =>
      `${M(v)} bu sandbox profili için meşgul: ona ayrılan yuvalar dolu. İş bekler.`,
    urgent_slot_reserved: (v: ReasonVars) =>
      `${M(v)} son boş yuvasını acil işlere ayırıyor. İş başka bir yuvayı bekler (orada çalışan bir işin alt işi bu yuvayı kullanabilir; bir yönetici bu ayrımı makine sayfasında değiştirebilir).`,
    declined_busy: (v: ReasonVars) =>
      `${M(v)} meşguldü ve beklemesini istedi; bir yuva boşalınca iş orada çalışır.`,
    // p9-queue-local-login-accounting / p9-subjob-local-login-deadlock (transient: the job waits).
    subscription_login_exclusive: (v: ReasonVars) =>
      `Abonelik girişleri (Claude Code / Codex) ${onM(v)} makinenin kendi hesabıyla çalışır, bu yüzden başka bir işin yanında çalışmaz (yalnızca kendi üst işi ya da alt işlerinin yanında); API anahtarlı işler paralel çalışır. İş bekler.`,
    subscription_login_busy: (v: ReasonVars) =>
      `${onM(v)} başka bir iş şu anda aynı abonelik girişini kullanıyor; bir giriş aynı anda tek bir işe hizmet eder (Claude Code ve Codex girişleri ayrıdır). İş bekler.`,
    // Machine state.
    not_enrolled: (v: ReasonVars) => `${M(v)} eşleştirilmeyi bekliyor.`,
    quarantined: (v: ReasonVars) => `${M(v)} karantinada.`,
    offline: (v: ReasonVars) => offline(v),
    worker_offline: (v: ReasonVars) => offline(v),
    updating: (v: ReasonVars) => `${M(v)} güncelleniyor; şimdilik yeni iş almıyor.`,
    draining: (v: ReasonVars) => `${M(v)} elindeki işleri bitiriyor ve yenilerini almıyor.`,
    no_workers: (_v: ReasonVars) => 'Bu işi çalıştırabilecek bir makine yok.',
    // Quotas (p4-quotas, p6-quota-scheduling, p11-usage-limit-fallback, p13-runtime-accounts).
    provider_paused: (_v: ReasonVars) =>
      'Runtime bu makinede kullanım sınırına ulaştı (abonelik ya da sağlayıcı kotası); sınır sıfırlanınca iş yeniden başlar.',
    account_concurrency: (_v: ReasonVars) => 'Hesap aynı anda çalıştırabileceği kadar iş çalıştırıyor.',
    budget_exceeded: (_v: ReasonVars) => 'Bu işin bütçesi tükendi.',
    deferred_off_peak: (_v: ReasonVars) => 'İş, projesinin yoğun olmayan saat aralığını bekliyor.',
    provider_usage_limit: (_v: ReasonVars) =>
      'Runtime sağlayıcısının kullanım sınırına takıldı. İş, projenin kullanım sınırı politikasına göre sıfırlanmayı bekler ya da bir yedek runtime ile sürer.',
    usage_limited: (_v: ReasonVars) =>
      'Bu runtime’ın kimlik bilgisi ya da modeli sıfırlanana kadar kullanım sınırında; işin başka bir runtime’ı onun yerine çalışabilir.',
    paid_fallback_not_allowed: (v: ReasonVars) =>
      `Yedek runtime ${onM(v)} API anahtarıyla çalışırdı (token başına ücretli); proje ücretli yedeklere izin vermiyor.`,
    account_limited: (v: ReasonVars) =>
      `Bu runtime’ın ${onM(v)} tüm hesapları kullanım limitinde; iş ilk sıfırlanmayı bekler ya da başka bir hesap / yedekle sürer.`,
    // p22-runtime-diagnostics: why a runtime process died (the worker's diagnosis), function job network errors.
    runtime_crashed: {
      default: (v: ReasonVars) =>
        `${rt(v)} ${onM(v)} beklenmedik şekilde durdu. Çıkış kodu ve son hata satırları işin ayrıntılarında; güvenlik politikası izin veriyorsa iş otomatik olarak yeniden denenir.`,
      out_of_memory: (v: ReasonVars) =>
        `${rt(v)} ${onM(v)} belleği yetmediği için durdu. Oradaki diğer işleri azalt ya da işi daha çok belleği olan bir makinede çalıştır; iş otomatik olarak (önce başka bir makinede) yeniden denenir.`,
      killed: (v: ReasonVars) =>
        `${rt(v)} ${onM(v)} sistem tarafından sonlandırıldı (SIGKILL gibi bir sinyal; çoğunlukla bellek baskısı, yeniden başlatma ya da elle durdurma). İş otomatik olarak yeniden denenir.`,
      provider_overloaded: (v: ReasonVars) =>
        `${rtName(v)} API’si aşırı yüklüydü ya da sunucu hatası (5xx) verdi. Bu geçici bir durum; iş otomatik olarak yeniden denenir.`,
      network: (v: ReasonVars) =>
        `${rt(v)} ${onM(v)} API’sine ulaşamadı (ağ ya da DNS hatası). Makinenin internet bağlantısını kontrol et; iş otomatik olarak yeniden denenir.`,
      login: (v: ReasonVars) => `${rt(v)} ${onM(v)} girişi kullanılamadığı için durdu. Yeniden giriş yap.`,
      usage_limit: (v: ReasonVars) =>
        `${rt(v)} sağlayıcısının kullanım sınırına takıldı. İş sıfırlanmayı bekler ya da bir yedek runtime ile sürer.`,
    },
    http_error: {
      default: (_v: ReasonVars) => 'HTTP isteği başarısız oldu (bağlantı, TLS ya da protokol hatası).',
      tls_untrusted: (_v: ReasonVars) =>
        'Sunucunun sertifikasına güvenilmiyor (kendinden imzalı ya da tanınmayan bir yayıncıdan). Bu senin iç servisinse, bu sertifikaya proje için güvenebilirsin; diğer her adres için doğrulama açık kalır.',
    },
    dns_failed: {
      default: (_v: ReasonVars) =>
        'Alan adı çözümlenmiyor: DNS’te bu ad için bir adres yok. Alan adının DNS kayıtlarını kontrol et (Cloudflare’de kayıt var mı, bölge etkin mi?).',
      tunnel_address: (_v: ReasonVars) =>
        'Bu adres artık çözümlenmeyen bir Cloudflare hızlı tünel adresi; arkasındaki tünel (önizleme) büyük olasılıkla durduruldu. Önizlemeyi yeniden başlat ve yeni adresini kullan.',
      preview_stopped: (_v: ReasonVars) =>
        'Bu adres durdurulmuş bir önizleme / servis tüneline ait, bu yüzden artık çözümlenmiyor. Önizlemeyi yeniden başlat.',
    },
    account_unavailable: (v: ReasonVars) =>
      `Bu runtime’ın ${onM(v)} hiçbir hesabı işi şu an alamıyor (duraklatılmış, oturumu kapalı, ücretli anahtar izni yok ya da iş başka hesaba sabit).`,
  },
  /** The fix labels (the target is chosen by apps/web/src/lib/reasons.ts). */
  actions: {
    allow: 'İzin ver',
    installRuntime: 'Runtime kur',
    logInAgain: 'Yeniden giriş yap',
    installPinned: 'Sabit sürümü kur',
    changeVersion: 'Sürümü değiştir',
    openRuntimePolicy: 'Runtime politikasını aç',
    enableRuntime: 'Runtime’ı etkinleştir',
    setUpRuntime: 'Runtime kur',
    openMachine: 'Makineyi aç',
    openModels: 'Modelleri aç',
    openCredentials: 'Kimlik bilgilerini aç',
    installTools: 'Araçları kur',
    prepareSandbox: 'Sandbox’ı hazırla',
    openSandbox: 'Sandbox’ı aç',
    openProjectPolicy: 'Proje politikasını aç',
    updateMachine: 'Makineyi güncelle',
    openMachineAdmin: 'Makine yönetimini aç',
    assignMachine: 'Makine ata',
    registerRepository: 'Depoyu kaydet',
    openConfiguration: 'Yapılandırmayı aç',
    pairMachine: 'Makineyi eşle',
    openMachines: 'Makineleri aç',
    openMcpServers: 'MCP sunucularını aç',
    openUsage: 'Kullanımı aç',
    openBudgets: 'Bütçeleri aç',
    openDiskSetting: 'En az boş disk ayarını aç',
  },
};
