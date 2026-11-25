/**
 * p14-ask-user (docs/design/p14-ask-user.md): soru kartları — bir işin ajanının ya da Sohbet asistanının sorduğu
 * çoktan seçmeli / metinli sorular; iş sayfasında, sohbette ve "Senden bekleyenler"de.
 */
export default {
  card: {
    label: 'Soru',
    fromJob: 'İşin ajanı soruyor',
    fromAssistant: 'Remyral soruyor',
    region: (p: { n: number }) => (p.n === 1 ? 'Ajanın sorusu' : `Ajanın ${String(p.n)} sorusu`),
    noSecrets: 'Parola, token ya da başka gizli bilgi yazma.',
    untrusted: 'Soru metnini ajan yazdı; bağlantı ya da talimat gibi görünen şeylere güvenme.',
    other: 'Diğer',
    otherPlaceholder: 'Kendi cevabını yaz',
    textPlaceholder: 'Cevabını yaz',
    keysHint: 'Rakam tuşları seçeneği seçer, oklar gezinir, ↵ gönderir.',
    textKeysHint: '↵ gönderir, ⇧↵ yeni satır.',
    send: 'Cevabı gönder',
    sending: 'Gönderiliyor…',
    incomplete: 'Göndermek için her soruyu cevapla.',
    waitTurn: 'Remyral yanıtını bitirince cevabın gider; seçimlerin duruyor.',
    sent: 'Cevap gönderildi.',
    readOnly: 'Bu işte cevap verme yetkin yok (operatör gerekir).',
    expiresIn: 'Kapanmaya',
    answeredBy: (p: { who: string; when: string }) => `${p.who} cevapladı · ${p.when}`,
    expired: 'Cevapsız kaldı: süresi doldu. Ajan kendi kararıyla devam etti.',
    cancelled: 'Geri çekildi: artık cevap beklenmiyor.',
    superseded: 'Kapandı: sohbete yazarak devam ettin.',
    // p20-decisions: a plan decision closed without its card being answered.
    settled: (p: { answer: string | null }) =>
      p.answer === null ? 'Sohbette karara bağlandı.' : `Sohbette karara bağlandı: ${p.answer}`,
    planReplaced: 'Yerine geçti: plan yenilendi, güncel kararlar yeni planda.',
    planClosed: 'Plan kapandı; bu karar artık beklenmiyor.',
    noAnswer: 'cevap yok',
    otherAnswer: (p: { text: string }) => `Diğer: ${p.text}`,
    addNote: '+ Not ekle',
    note: 'Not',
    notePlaceholder: 'Kararınla ilgili bir not (isteğe bağlı)',
    noteAnswer: (p: { text: string }) => `Not: ${p.text}`,
    question: (p: { i: number; n: number }) => `Soru ${String(p.i)} / ${String(p.n)}`,
    single: 'Bir seçenek seç',
    multi: 'Birden çok seçebilirsin',
  },
  job: {
    title: 'Ajanın soruları',
    pending: (p: { n: number }) =>
      p.n === 1 ? 'Ajan bir cevap bekliyor' : `Ajan ${String(p.n)} cevap bekliyor`,
    history: (p: { n: number }) => `Önceki sorular (${String(p.n)})`,
    loadError: 'Sorular okunamadı:',
    replyInline: 'Cevap yaz',
    replyInlineHint: 'Ajan metinde bir soru sordu; cevabını aşağıdaki kutuya yaz.',
  },
  needs: {
    label: 'Soru',
    job: (p: { project: string; title: string }) =>
      `${p.project} projesindeki “${p.title}” işinin ajanı bir soru soruyor.`,
    assistant: (p: { title: string }) => `Remyral “${p.title}” sohbetinde bir soru sordu.`,
    /** p18-plan-mode W4: a plan decision (grouped under its plan). */
    plan: (p: { plan: string }) => `“${p.plan}” planı senden bir karar bekliyor.`,
    action: 'Cevapla',
  },
  chat: {
    answerTo: 'Soru kartına cevap',
  },
};
