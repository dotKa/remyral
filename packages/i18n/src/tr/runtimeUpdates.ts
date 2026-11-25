/**
 * p16-runtime-updates: pin dışı (doğrulanmamış) runtime güncellemeleri — sürüm matrisi ve Makine → Runtime’lar
 * rozetleri, tek makine düğmeleri, Toplu işlem seçeneği, 409 atlama listesi, Doğrulama adayları paneli, Ayarlar →
 * Güvenlik → Filo anahtarı ve sohbetin runtime güncelleme kartı. `{param}` yer tutucuları `fill` ile doldurulur.
 */
export default {
  badge: 'Doğrulanmamış sürüm (pin: {pin})',
  badgeHint:
    'Bu sürüm makine yazılımının sabitlediği sürümden yeni; yetenekleri doğrulanmamış sayılır, işler yine çalışır. Pin’e tek adımda dönülür.',
  offer: 'Doğrulanmamış olarak kurulabilir: {version}',
  install: 'Doğrulanmamış olarak kur ({version})',
  installWhy: '{machine}: {runtime} {version} doğrulanmamış olarak kur',
  installQuestion:
    '{runtime} {version} pin ({pin}) dışında bir sürüm. Resmi npm paketinden sha512 bütünlük denetimiyle kurulur; yetenekleri doğrulanmamış kalır. Kurulsun mu?',
  rollback: 'Pin’e geri dön ({version})',
  rollbackWhy: '{machine}: {runtime} pin {version} sürümüne geri dön',
  rollbackQuestion: '{runtime} pin {version} sürümüne geri dönsün mü?',
  started: 'Başladı — ilerleme Araçlar ve sürümler → Toplu işlemler’de.',
  summary: {
    installable: '{n} kurulabilir',
    releaseRequired: '{n} makine yazılımı sürümü gerektirir',
    unverifiedActive: '{n} doğrulanmamış sürüm çalışıyor',
  },
  bulk: {
    unverified: 'Pin dışındaki yeni sürümü doğrulanmamış olarak kur',
    unverifiedHint:
      'Kaynakta pin’den yeni bir sürüm var ({version}). Resmi npm paketinden tam sürüm ve sha512 bütünlük denetimiyle kurulur; yetenekleri doğrulanmamış kalır, işler çalışır, pin’e tek adımda dönülür.',
    unverifiedOff:
      'Kaynakta pin’den yeni bir sürüm var ({version}), ama güvenlik politikası pin dışı sürümlere izin vermiyor (Ayarlar → Güvenlik → Filo).',
    latest: 'Kaynaktaki en yeni sürüm ({version})',
  },
  skipped: {
    title: 'Hiçbir makine bu işlemi şu an alamaz',
    some: 'Bazı makineler bu işlemi almadı',
    line: '{machine}: {reason}',
  },
  candidates: {
    title: 'Doğrulama adayları',
    sub: 'Pin’den yeni runtime sürümleri, bir kanarya makinede otomatik denetlenir (günlük ve kaynak değişince).',
    honest:
      'Doğrulanmış aday: otomatik denetlenebilen adımlar (bütünlük, sürüm, yardım / yerel kimlik doğrulama, adaptör yoklaması) bir kanarya makinede geçti. Model istemi ve sözleşme testi otomatik değildir. Sürüm, bir makine yazılımı sürümü onu sabitleyene kadar doğrulanmamış kalır.',
    empty: 'Henüz aday yok: kaynaktaki sürümler pin’den yeni değil ya da henüz çözülmedi.',
    count: '{n} aday',
    pin: 'pin {pin}',
    machine: '{machine} · {platform}',
    when: 'son deneme {when}',
    verifyNow: 'Şimdi doğrula',
    verifyWhy: '{runtime} {version} sürümünü bir kanarya makinede doğrula',
    verifyStarted: 'Doğrulama başladı ({machine}).',
    lock: 'Kilit dosyası (package-lock.json)',
    reason: 'Sebep: {reason}',
    states: {
      none: 'denenmedi',
      running: 'denetleniyor',
      passed: 'doğrulanmış aday',
      failed: 'denetimden geçmedi',
    },
    runStates: {
      running: 'sürüyor',
      passed: 'geçti',
      failed: 'geçmedi',
      error: 'tamamlanamadı',
    },
    checks: {
      integrity: 'Bütünlük (sha512)',
      version: 'Sürüm komutu',
      bundled_version: 'Paketteki Claude Code sürümü',
      help: 'Yardım komutu',
      server_auth: 'Yerel sunucu kimlik doğrulaması',
      adapter_probe: 'Adaptör yoklaması',
      headless_prompt: 'Model istemi',
      contract_suite: 'Sözleşme testi',
    },
    checkStates: {
      passed: 'geçti',
      failed: 'geçmedi',
      skipped: 'otomatik değil',
    },
  },
  policy: {
    title: 'Runtime güncellemeleri',
    hint: 'Runtime sürümleri her makine yazılımı sürümünde sabitlenir (pin). Bu ayar, kaynakta çıkan daha yeni bir sürümün beklemeden kurulmasına izin verir.',
    switch: 'Doğrulanmamış runtime güncellemeleri',
    switchHint:
      'Açıkken pin’den yeni bir sürüm “doğrulanmamış” etiketiyle kurulabilir, işler onda çalışır ve yeni sürümler bir kanarya makinede otomatik denetlenir. Kapalıyken yalnızca sabit sürümler kurulur. Varsayılan: açık.',
  },
  card: {
    kind: 'Runtime güncellemesi',
    label: 'Runtime güncellemesi',
    runtime: 'Runtime',
    version: 'Sürüm',
    machines: 'Makineler',
    rollout: 'Yayılım',
    canaryFirst: 'önce kanarya',
    allAtOnce: 'hepsine birden',
    rollback: 'Pin {pin} sürümüne geri dönüş',
    unverified:
      'Doğrulanmamış sürüm (pin: {pin}) — yetenekleri doğrulanmamış kalır, işler çalışır, pin’e tek adımda dönülür.',
    target: '{machine}: {from} → {to}',
    skippedLine: '{machine} almaz: {reason}',
  },
};
