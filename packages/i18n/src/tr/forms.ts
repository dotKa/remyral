/**
 * p15-form-pattern (docs/design/p15-form-pattern.md): the one form pattern of the Diyalog screens — the sticky save
 * bar of a tab's form, the "unsaved changes" guard (tab switch, in-app navigation, browser unload), switches that
 * apply at once, field errors from the master's validation issues and the tab names of the screens that moved their
 * stacked cards into tabs.
 */
export default {
  bar: {
    /** The sticky bar's landmark name. */
    region: 'Kaydedilmemiş değişiklikler',
    dirty: 'Kaydedilmemiş değişiklik var',
    save: 'Kaydet',
    saving: 'Kaydediliyor…',
    discard: 'Vazgeç',
    /** The success toast after a save. */
    saved: 'Kaydedildi',
    /** Shown when a save failed (the details are next to the fields / in the section). */
    failed: 'Kaydedilemedi — ayrıntı formda.',
  },
  guard: {
    title: 'Kaydedilmemiş değişiklikler var',
    body: 'Bu sayfada kaydetmediğin değişiklikler var. Ayrılmadan önce kaydedebilir ya da değişiklikleri bırakabilirsin.',
    save: 'Kaydet',
    saving: 'Kaydediliyor…',
    leave: 'Kaydetmeden çık',
    stay: 'Vazgeç',
    failed: 'Kaydedilemedi; hatalar formda gösteriliyor. Sayfa değişmedi.',
  },
  instant: {
    saving: 'Kaydediliyor…',
    saved: 'Kaydedildi ✓',
    /** A switch whose change the master refused: it is back where it was. */
    undone: 'Değişiklik geri alındı.',
  },
  /** Field errors from the master's validation issues (`{path, code}`), by code. */
  issues: {
    required: 'Bu alan gerekli.',
    invalid: 'Bu değer geçersiz.',
    tooSmall: 'Değer çok küçük ya da çok kısa.',
    tooBig: 'Değer çok büyük ya da çok uzun.',
    notFound: 'Böyle bir kayıt yok.',
    duplicate: 'Bu değer zaten kullanılıyor.',
    notAllowed: 'Bu değere izin verilmiyor.',
    other: (p: { code: string }) => `Bu değer kabul edilmedi (${p.code}).`,
  },
  /** Tab names of the screens whose stacked cards became tabs. */
  tabs: {
    profile: {
      label: 'Profil bölümleri',
      look: 'Dil',
      session: 'Oturum',
      password: 'Parola',
      rules: 'Kişisel kurallar',
      import: 'İçe aktar',
    },
    security: {
      label: 'Güvenlik bölümleri',
      auto: 'Otomatik mod',
      presets: 'Hazır ayarlar',
      stepUp: 'Kod doğrulama',
      events: 'Kod istenen olaylar',
      autonomy: 'Ajan otonomisi',
      tokens: 'API anahtarları',
      fleet: 'Filo',
    },
    chat: {
      label: 'Sohbet bölümleri',
      mine: 'Sohbetlerim',
      assistant: 'Asistan',
      limits: 'Sınırlar',
    },
    notifications: {
      label: 'Bildirim bölümleri',
      sound: 'Ses ve önizleme',
      targets: 'Kanallar',
      events: 'Bildirim türleri',
    },
    integrations: {
      label: 'Entegrasyon bölümleri',
      overview: 'Genel bakış',
      github: 'GitHub',
      ops: 'Coolify ve Cloudflare',
      bedrock: 'Amazon Bedrock',
      gitHosts: 'GitLab ve Bitbucket',
      storage: 'Depolama',
    },
    project: {
      network: 'Ağ erişimi',
      limits: 'Sınırlar ve yönlendirme',
    },
    /** p17-settings-tabs: Ayarlar → Operasyon güvenliği. */
    opsSafety: {
      label: 'Operasyon güvenliği bölümleri',
      keys: 'Anahtarlar ve süreler',
      brake: 'Maliyet freni',
      projects: 'Proje tavanları',
      limits: 'İstek sınırları',
      breaker: 'Sürüm devre kesici',
    },
    /** p17-settings-tabs: Ayarlar → Worker sürümleri. */
    releases: {
      label: 'Sürüm bölümleri',
      rollout: 'Yayılım',
      releases: 'Yüklenen sürümler',
      attempts: 'Güncelleme denemeleri',
    },
    /** p17-settings-tabs: Ayarlar → Tanılama. */
    diagnostics: {
      label: 'Tanılama bölümleri',
      doctor: 'Doktor',
      report: 'Destek raporu',
      settings: 'Destek ayarları',
    },
    /** p17-settings-tabs: Kullanım → Limitler ve kotalar (the tab's own sections). */
    enforcement: {
      label: 'Limit ve kota bölümleri',
      limits: 'Kullanım sınırları',
      holds: 'Duraklatma ve durdurma',
      load: 'Eşzamanlılık ve bütçe',
      events: 'Son kararlar',
      policy: 'Kota politikası',
    },
  },
};
