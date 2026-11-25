/**
 * p17-embeddings (docs/design/p17-embeddings.md): benzer geçmiş işler, daha önce çözülmüş benzer hatalar, "benzer bir
 * kayıt var" uyarısı ve işin bağlamına benzer işlerin eklenmesi ayarı.
 */
export default {
  similar: {
    title: 'Benzer geçmiş işler',
    sub: 'Bu projede benzer işi yapmış, bitmiş işler.',
    given: 'Ajana ipucu olarak verildi',
    givenHint:
      'Bu işin ajanı, başarılı benzer işlerin kısa özetlerini güvenilmeyen veri olarak, talimat değil ipucu olarak aldı.',
    states: {
      SUCCEEDED: 'Başarılı',
      FAILED: 'Başarısız',
    } as Record<string, string>,
  },
  solved: {
    title: 'Benzer hata daha önce şöyle çözüldü',
    failedWith: (p: { code: string }) => `Hata: ${p.code}`,
    earlier: 'Önceki hata',
    how: {
      retry: 'Aynı iş sonraki denemede başarılı oldu',
      auto_fix: 'Otomatik düzeltme işi çözdü',
      automation: 'Aynı otomasyonun sonraki çalıştırması başarılı oldu',
      rerun: 'Workflow yeniden çalıştırılınca başarılı oldu',
    },
    open: 'Çözümü aç',
    openFailure: 'Önceki hatayı aç',
  },
  duplicate: {
    title: 'Benzer bir kayıt var',
    job: 'Bu projede benzer bir iş var:',
    automation: 'Bu projede benzer bir otomasyon var:',
    hint: 'Yine de oluşturabilirsiniz; bu yalnızca bir uyarı.',
  },
  settings: {
    title: 'Benzer geçmiş işler',
    label: 'İşlere benzer başarılı işlerin özetlerini ipucu olarak ver',
    hint: 'Yeni bir iş başlarken bu projede benzer işi yapmış en çok 3 başarılı işin kısa özeti, ajana güvenilmeyen veri olarak eklenir. Anlamsal arama (embedding) açık değilse hiçbir şey eklenmez.',
    platformOff: 'Bu özellik sunucuda kapatılmış (RELATED_WORK / RELATED_WORK_CONTEXT).',
    saved: 'Ayar kaydedildi.',
    conflict: 'Ayar başka biri tarafından değiştirildi; sayfayı yenileyin.',
  },
};
