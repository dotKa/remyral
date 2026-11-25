/**
 * p16-workflow-quality: geçersiz taslak satırı (sohbet), zamanlamaların saat dilimiyle anlatımı (otomasyonlar,
 * taslak kartları), workflow kartında tetikleyicilerin açılması ve çalıştırma formunda isteğe bağlı depo alanları.
 * `{param}` yer tutucuları `fill` ile doldurulur.
 */
export default {
  draftInvalid: {
    line: 'Taslak geçersiz: {issues}',
    lineCount: 'Taslak geçersiz ({kind}, {n} deneme): {issues}',
    refused: 'doğrulamadan geçmedi',
  },
  schedule: {
    everyMinutes: 'her {n} dakikada bir',
    hourly: 'her saat başı',
    hourlyAt: 'her saat {m}. dakikada',
    daily: 'her gün {time}',
    weekdays: 'hafta içi her gün {time}',
    weekly: 'her {day} {time}',
    withZone: '{text} · {zone}',
    once: 'bir kez, {time}',
    days: {
      d0: 'pazar',
      d1: 'pazartesi',
      d2: 'salı',
      d3: 'çarşamba',
      d4: 'perşembe',
      d5: 'cuma',
      d6: 'cumartesi',
    },
    expression: 'İfade',
    zone: 'Saat dilimi',
    zoneHint: 'IANA adı, ör. Europe/Istanbul; yaz saati geçişleri kendiliğinden uygulanır.',
    zoneInvalid: 'Bilinmeyen saat dilimi: Europe/Istanbul gibi bir IANA adı yaz.',
  },
  run: {
    repoUrl: 'Depo adresi (isteğe bağlı)',
    baseRef: 'Temel branch (isteğe bağlı)',
    fromWorkflow: 'Boş bırakırsan workflow’un kendi deposu: {url}',
    fromProject: 'Boş bırakırsan projenin deposu: {url}',
    none: 'Boş bırakabilirsin: depo yoksa yapay zeka adımları kodsuz, geçici bir klasörde çalışır.',
  },
  workflowCard: {
    activates: 'Onaylamak tetikleyicileri de açar: {list}',
    inactive: 'Tetikleyiciler kapalı kalır: workflow etkinleştirilene kadar kendiliğinden çalışmaz.',
    repoWorkflow: 'Depo: workflow’un deposu ({url})',
    repoProject: 'Depo: projenin deposu ({url})',
    repoNone: 'Depo yok: adımlar kodsuz, geçici bir klasörde çalışır',
  },
};
