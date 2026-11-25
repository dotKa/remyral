/**
 * p15-message-delivery (docs/design/p15-message-delivery.md): bir işin ajanına yazılan mesajların teslim durumu —
 * Diyalog iş sayfası, klasik "Ajana yaz" kutusu ve sohbetten gönderilenler.
 */
export default {
  status: {
    waiting: 'Bekliyor: ajan çalışınca iletilecek',
    sent: 'Gönderildi',
    received: 'Makineye ulaştı',
    held: 'Makineye ulaştı: ajan başlayınca iletilecek',
    delivered: 'Ajana iletildi',
    read: 'Ajan okudu',
    failed: 'İletilmedi',
  },
  /** Kısa adım adları (durum şeridi). */
  steps: {
    sent: 'Gönderildi',
    received: 'Makineye ulaştı',
    delivered: 'Ajana iletildi',
    read: 'Ajan okudu',
  },
  failure: {
    job_not_running: 'Makine bu işi artık çalıştırmıyor (iş bitti ya da makine yeniden başladı).',
    attempt_superseded: 'İşin yeni bir denemesi başladı; mesaj öncekine gitmişti.',
    run_ended: 'Ajan mesajı almadan çalışması bitti.',
    runtime_refused: 'Runtime mesajı kabul etmedi.',
    unsupported: 'Bu runtime çalışırken mesaj almıyor.',
    worker_update_required: 'İşi çalıştıran makinenin güncellenmesi gerekiyor.',
    job_ended: 'Mesaj gönderilmeden iş bitti.',
    unknown: 'Mesaj ajana ulaşmadı.',
  },
  hint: {
    delivered: 'Runtime mesajı aldı; ajan sıradaki adımında okuyacak.',
    noReceipts: 'Bu makinenin sürümü teslimin sonrasını bildirmiyor; mesaj iş günlüğünde görünür.',
    resend: 'Tekrar yaz',
    resendHint: 'Metni mesaj kutusuna geri koyar; göndermeden önce düzenleyebilirsin.',
  },
  composer: {
    queuedPlaceholder: 'Ajana yaz: iş başlayınca iletilir…',
    queuedHint: 'Ajan henüz çalışmıyor: mesajın bekler ve ajan başlayınca iletilir.',
    sentHint: 'Gönderildi; teslim durumu günlükte mesajın yanında görünür.',
    unavailable: (p: { reason: string }) => `Ajana mesaj gönderilemiyor: ${p.reason}`,
  },
  box: {
    title: 'Ajana yaz',
    intro: 'Çalışan ajana ek talimat olarak gider; iş henüz başlamadıysa ajan başlayınca iletilir.',
    send: 'Ajana gönder',
    recent: 'Gönderilen mesajlar',
    by: (p: { who: string; when: string }) => `${p.who} · ${p.when}`,
  },
};
