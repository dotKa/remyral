/**
 * p22-output-delivery: bir repo işinin sonucunu nasıl teslim ettiği (birleştirme ya da Çıktılar) ve "Senden
 * bekleyenler"de aynı projenin birleştirme kararlarını birlikte onaylamak.
 */
export default {
  choice: {
    legend: 'Teslim',
    merge: 'Kod değişikliği: birleştirme onayıyla (varsayılan)',
    outputs: 'Dosya üretimi: Çıktılar’a teslim et, birleştirme yok',
    hint: 'İş dosya üretmek için çalışıyorsa (rapor, lead paketi, dışa aktarım) dosyaları Çıktılar’a gelir ve iş birleştirme onayı beklemeden biter; temel branch’e hiçbir şey girmez, dosyalar deneme branch’inde de kalır. Yalnızca metin dosyaları (CSV, JSON, Markdown, metin…) kopyalanır.',
  },
  chip: 'Çıktılar’a teslim',
  job: {
    delivered: 'Bu iş dosyalarını Çıktılar’a teslim eder; birleştirme yapılmaz.',
  },
  bulk: {
    title: 'Birleştirmeleri birlikte onayla',
    project: (p: { project: string; n: number }) => `${p.project}: ${String(p.n)} birleştirme bekliyor`,
    open: 'Seç ve onayla',
    close: 'Kapat',
    all: 'Hepsini seç',
    none: 'Seçimi kaldır',
    approve: (p: { n: number }) => `${String(p.n)} birleştirmeyi onayla`,
    busy: 'Onaylanıyor…',
    hint: 'Her biri tek tek onaylanmış gibi denetlenir ve kaydedilir; tek bir doğrulama kodu hepsine yeter. Birleştirmeler sırayla çalışır: öncekiler birleştikten sonra çakışan biri birleşmez, nedeniyle birlikte yeniden karar bekler.',
    loadFailed: (p: { error: string }) => `Birleştirme kararları okunamadı: ${p.error}`,
    failed: (p: { error: string }) => `Onaylanamadı: ${p.error}`,
    untitled: 'Başlıksız iş',
    files: (p: { n: number }) => `${String(p.n)} dosya`,
    state: {
      clean: 'Çakışma yok',
      conflicts: (p: { n: number }) => `Çakışma: ${String(p.n)} dosya`,
      base_moved: 'Hedef branch yeniden yazıldı',
      unknown: 'Birleşme denetimi sürüyor',
    },
    result: {
      approved: 'Onaylandı; birleştirme sırası geldiğinde çalışır.',
      pending: 'Onayın kaydedildi; başka onay da gerekiyor.',
      refused: (p: { reason: string }) => `Onaylanmadı: ${p.reason}`,
    },
    summary: (p: { approved: number; refused: number }) =>
      `${String(p.approved)} onaylandı${p.refused > 0 ? `, ${String(p.refused)} onaylanmadı` : ''}.`,
  },
};
