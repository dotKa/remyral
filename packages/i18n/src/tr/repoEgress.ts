/**
 * p14-repo-egress: Projeler → Politika → "Ağ erişimi" — bir depo projesinin işlerinin (ajanların çalıştırdığı npm
 * install, pip install, git clone …) hangi adreslere gidebileceği. Klasik konsolda İngilizcesi gösterilir.
 */
export default {
  title: 'Ağ erişimi',
  sub: 'Bu projenin işleri (ajanların çalıştırdığı npm install, pip install, git clone …) hangi adreslere gidebilir.',
  loading: 'Ağ erişimi',
  modeLegend: 'Kapsam',
  modes: {
    none: {
      label: 'Kapalı (yalnız model API’leri)',
      description:
        'İşler yalnız model sağlayıcısına (Anthropic, OpenAI) ve işin MCP sunucularına bağlanır; npm install, pip install veya git clone çalışmaz.',
    },
    allowlist: {
      label: 'Yalnız izin verilenler',
      description: 'Model API’lerine ek olarak aşağıda seçilen hazır gruplar ve yazdığınız adresler.',
    },
    web: {
      label: 'Tüm genel web',
      description:
        '443 portundaki herhangi bir genel adres. İşlerin web’den okuduğu içerik güvenilmez veridir; yalnız bu projenin her işine güveniyorsanız seçin.',
    },
  },
  recommendedBadge: 'Önerilen',
  recommend:
    'Öneri: “Yalnız izin verilenler” ile paket depolarını seçin — işler bağımlılık kurabilir, internetin geri kalanı kapalı kalır.',
  applyRecommended: 'Önerileni uygula',
  presetsTitle: 'Hazır gruplar',
  presetGroups: {
    registries: 'Paket depoları',
    code: 'Kod barındırma',
  },
  presets: {
    npm: 'npm / Yarn',
    pypi: 'PyPI (pip, uv)',
    crates: 'crates.io (Cargo)',
    go: 'Go modül proxy’si',
    maven: 'Maven Central / Gradle',
    github: 'GitHub',
    gitlab: 'GitLab',
  },
  presetHosts: (p: { hosts: string }) => `Adresler: ${p.hosts}`,
  hostsTitle: 'Ek adresler',
  hostsNone: 'Ek adres yok.',
  hostLabel: 'Adres ekle (adres veya adres:port)',
  hostPlaceholder: 'cdn.ornek.example',
  add: 'Ekle',
  remove: (p: { host: string }) => `${p.host} adresini kaldır`,
  problems: {
    empty: 'Bir adres yazın.',
    format: 'Küçük harfli bir alan adı yazın (cdn.ornek.example veya git.ornek.example:2222).',
    ip: 'IP adresi yazılamaz; alan adı kullanın.',
    internal: 'Yerel ve iç ağ adları (localhost, .local, .internal …) her zaman kapalıdır.',
    port: 'Port 1 ile 65535 arasında olmalı.',
    duplicate: 'Bu adres zaten listede.',
    tooMany: 'En fazla 48 ek adres.',
  },
  emptyAllowlist: 'Hiç grup veya adres seçili değil: bu ayar “Kapalı” gibi davranır.',
  floor:
    'Yerel ağ, özel adresler, loopback, link-local, CGNAT ve bulut metadata adresleri (169.254.169.254 gibi) her kapsamda kapalıdır; model API’leri her zaman açıktır.',
  profiles:
    'Host ve container profillerinde uygulanır. runtime-sandbox profilinde ajanın komutlarının hiç ağı yoktur. Engellenen bir istek 403 alır ve yanıt bu ayarın adını söyler.',
  reach: {
    none: 'Şu an işler yalnız model API’lerine ulaşabilir.',
    allowlist: (p: { n: number }) => `Şu an işler model API’lerine ve ${String(p.n)} adrese ulaşabilir.`,
    web: 'Şu an işler model API’lerine ve 443 portundaki tüm genel adreslere ulaşabilir.',
  },
  effectiveTitle: 'Ulaşılabilen adresler',
  unsupported: (p: { n: number; names: string }) =>
    `${String(p.n)} makine eski bir Remyral sürümü çalıştırıyor ve bu ayarı uygulamıyor (orada yalnız model API’leri açık): ${p.names}. Makineyi güncelleyin.`,
  workspaceProject: 'Bu bir çalışma alanı projesi: ağ erişimi Çalışma alanı sekmesinden ayarlanır.',
  save: 'Kaydet',
  stepUp: 'Ağ erişimini değiştirmek için doğrulama kodunu girin.',
  saved: 'Ağ erişimi kaydedildi; sıradaki işler yeni ayarla başlar.',
  readOnly: 'Bu ayarı yalnız proje sahipleri ve yöneticileri değiştirebilir.',
  updated: (p: { at: string; by: string }) => `Son değişiklik: ${p.at} · ${p.by}`,
};
