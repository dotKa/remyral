/**
 * p19-repo-inputs-composer-workflows: repo projelerinde girdi dosyaları — iş formundaki dosya alanı ve iş akışı
 * çalıştırmasının dosyaları (her yapay zeka adımı alır). Dosyalar checkout'un yanındaki geçici in/ klasörüne gider.
 */
export default {
  composer: {
    jobNote:
      'Repo işi bu dosyaları checkout’un yanındaki salt okunur geçici in/ klasöründen okur; depoya asla commit edilmez, push edilmez.',
    runNote:
      'Her yapay zeka adımı bu dosyaları kendi checkout’unun yanındaki salt okunur geçici in/ klasöründe alır; depoya asla commit edilmez.',
    limits: (p: { files: string; each: string; total: string; types: string }) =>
      `En çok ${p.files} dosya, her biri ${p.each}, toplam ${p.total}; türler ${p.types}. Gönderirken dosyalarda gizli bilgi aranır.`,
    continueHint: 'Bu önceki işin sonuçları girdi dosyası olarak verilir (depoya girmez).',
    update:
      'Henüz hiçbir makine repo projesine girdi dosyası alamıyor: makineler güncellenmeli (repo-inputs-v1). Güncellenene kadar dosyaları görevde anlat.',
  },
  card: {
    runNote:
      'Her yapay zeka adımı bu dosyaları checkout’unun yanındaki geçici in/ klasöründe alır; depoya commit edilmez.',
  },
};
