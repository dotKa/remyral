/**
 * p22-chat-queue: Remyral yanıtlarken yazılan mesajlar "Sırada" bekler; yanıt bitince hepsi birlikte bir sonraki tur
 * olarak gönderilir. Balonun düğmeleri: düzenle, kaldır, şimdi gönder (yanıtı durdurur).
 */
export default {
  label: 'Sıradaki mesajlar',
  badge: 'Sırada',
  note: 'Yanıt bitince gönderilecek',
  files: (p: { n: number }) => (p.n === 1 ? '1 dosya' : `${String(p.n)} dosya`),
  edit: 'Düzenle',
  editLabel: 'Sıradaki mesajı düzenle',
  save: 'Kaydet',
  cancel: 'Vazgeç',
  remove: 'Kaldır',
  removeLabel: 'Sıradaki mesajı kaldır',
  sendNow: 'Şimdi gönder',
  sendNowHint: 'Yanıtı durdurur; sıradaki mesajlar hemen gönderilir.',
  failed: (p: { error: string }) => `Olmadı: ${p.error}`,
  held: {
    assistant_unavailable: 'Asistan şu an cevap veremiyor; açılınca gönderilecek.',
    rate_limited: 'Mesaj sınırına takıldı; birkaç dakika içinde yeniden denenecek.',
    budget_exceeded: 'Sohbet bütçesi doldu; bütçe açılınca gönderilecek.',
    other: 'Gönderim bekliyor; yeniden denenecek.',
  },
};
