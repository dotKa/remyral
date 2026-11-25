/**
 * p19-project-env: Projeler → Politika → "Ortam değişkenleri" — kasadaki “Diğer” türündeki kimlik bilgilerinin bu
 * projenin işlerine ortam değişkeni olarak verilmesi.
 */
export default {
  title: 'Ortam değişkenleri',
  sub: 'Kasadaki “Diğer” türündeki kimlik bilgileri bu projenin işlerine kendi değişken adlarıyla verilir.',
  loading: 'Ortam değişkenleri',
  none: 'Bu projenin işlerine henüz ortam değişkeni verilmiyor.',
  listLabel: 'Verilen değişkenler',
  machines: (p: { names: string }) => `Makinelerde: ${p.names}`,
  noMachine:
    'Hiçbir makinede yok — işler bekler. Kimlik bilgisini Ayarlar → Kimlik bilgileri’nden bir makineyle paylaş.',
  addLabel: 'Kimlik bilgisi ekle',
  addNone: 'Eklenebilecek “Diğer” türünde kimlik bilgisi yok. Önce Ayarlar → Kimlik bilgileri’nden ekle.',
  add: 'Ekle',
  remove: 'Kaldır',
  rule: 'İşler yalnız bu kimlik bilgilerinin hepsini tutan makinelerde çalışır. Güvenilmeyen kaynaktan gelen işler ve pull request işleri bunları hiçbir zaman almaz. Değerler hiçbir zaman gösterilmez; günlüklerde maskelenir.',
  stepUp: 'Ortam değişkenlerini değiştirmek için doğrulama kodunu gir.',
  saved: 'Ortam değişkenleri kaydedildi.',
  manage: 'Kimlik bilgilerini yönet',
};
