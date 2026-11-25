/**
 * p14-i18n-screens-c (i18n Faz 5): the shared parts of every Diyalog screen — the screen frame's live dot, the
 * placeholder section page, the "thread’de aç" link, the read-error line, the export result and the relative times
 * ("az önce", "3 dk önce", "2 sa sonra").
 */
export default {
  frame: {
    live: 'Canlı',
    liveError: 'Bağlantı sorunu',
  },
  section: {
    emptyTitle: 'Henüz burada bir şey yok',
    home: 'Ana sayfa',
    notReady: 'Bu bölümün ekranı henüz hazır değil.',
  },
  threadLink: {
    label: 'thread’de aç',
    aria: (p: { about: string }) => `${p.about}: thread'de aç`,
  },
  errorLine: {
    readFailed: (p: { what: string; reason: string }) => `${p.what} okunamadı: ${p.reason}`,
    retry: 'Yeniden dene',
  },
  exportResult: {
    saved: (p: { n: number }) => `kaydedildi: ${String(p.n)} kayıt.`,
    verified: 'Sağlama doğrulandı.',
    mismatch: 'Sağlama tutmuyor — bu dosyayı silip yeniden dışa aktarın.',
    unchecked: 'Sağlama dosyanın son satırında.',
    truncated: ' Dışa aktarma boyut sınırına ulaştı; kalanı için devam edin.',
  },
  time: {
    justNow: 'az önce',
    minutesAgo: (p: { n: number }) => `${String(p.n)} dk önce`,
    hoursAgo: (p: { n: number }) => `${String(p.n)} sa önce`,
    daysAgo: (p: { n: number }) => `${String(p.n)} gün önce`,
    minutesAhead: (p: { n: number }) => `${String(p.n)} dk sonra`,
    hoursAhead: (p: { n: number }) => `${String(p.n)} sa sonra`,
    daysAhead: (p: { n: number }) => `${String(p.n)} gün sonra`,
  },
};
