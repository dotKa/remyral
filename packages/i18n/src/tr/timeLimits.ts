/** p15-autonomy: job time limits and approval deadlines edited from the cards. */
export default {
  title: 'Süre sınırı',
  current: (p: { time: string }) => `Süre sınırı: ${p.time}`,
  original: (p: { time: string }) => `ilk hali ${p.time}`,
  add: (p: { time: string }) => `+${p.time}`,
  custom: 'Dakika',
  apply: 'Uygula',
  saving: 'Kaydediliyor…',
  applied: (p: { time: string }) => `Süre sınırı ${p.time} oldu; iş yeniden başlamadan devam ediyor.`,
  appliedLater: (p: { time: string }) => `Süre sınırı ${p.time} oldu; iş başlayınca geçerli.`,
  waiting: 'Makinenin onayı bekleniyor.',
  refused: 'Makine yeni süreyi reddetti; iş önceki sınırla sürüyor.',
  liveUnsupported:
    'Bu makine süreyi iş çalışırken değiştiremiyor; yeni sınır bir sonraki denemede geçerli (makineyi güncelle).',
  max: (p: { time: string }) => `En çok ${p.time} (güvenlik politikası).`,
  outOfRange: (p: { min: string; max: string }) => `Süre ${p.min} ile ${p.max} arasında olmalı.`,
  failed: (p: { reason: string }) => `Süre değiştirilemedi: ${p.reason}`,
  draftLabel: 'Süre sınırı (dakika)',
  draftHint:
    'İş bu kadar çalışma süresinden sonra durdurulur (onay beklemeleri sayılmaz). İş sürerken de uzatılabilir.',
  minutes: (p: { n: number }) => `${String(p.n)} dk`,
  hours: (p: { n: number }) => `${String(p.n)} saat`,
  hoursMinutes: (p: { h: number; m: number }) => `${String(p.h)} sa ${String(p.m)} dk`,
  days: (p: { n: number }) => `${String(p.n)} gün`,
  /** p20-job-clock: run time and human waits apart, the time warning and "Aynı yerden devam et". */
  clock: {
    used: (p: { used: string; budget: string }) => `Çalışma süresi: ${p.used} / ${p.budget}`,
    left: (p: { time: string }) => `kalan ${p.time}`,
    questionWait: (p: { time: string }) => `Sorulara cevap beklerken geçen ${p.time} süreye sayılmadı.`,
    approvalWait: (p: { time: string }) => `Onay beklerken geçen ${p.time} süreye sayılmadı.`,
    waitingQuestion: 'Şu an bir sorunun cevabını bekliyor; süre durdu.',
    waitingApproval: 'Şu an bir onay bekliyor; süre durdu.',
    oldMachine:
      'Bu makine soru beklerken süreyi durdurmuyor; makine güncellenince (sürüm 1.2.13) beklemeler sayılmaz.',
    warned: (p: { time: string }) => `Süre azalıyor uyarısı gönderildi (${p.time}).`,
    timedOut: 'İş süre sınırı dolduğu için durdu. Kaldığı yerden, daha uzun bir süreyle devam edebilir.',
    continue: 'Aynı yerden devam et',
    openJob: 'İşi aç',
    continueWith: (p: { time: string }) => `Aynı yerden devam et (${p.time})`,
    continued: (p: { id: string }) => `Devam işi başlatıldı: ${p.id}`,
    openContinued: 'Devam işini aç',
    continueFailed: (p: { reason: string }) => `Devam ettirilemedi: ${p.reason}`,
    extend: 'Süreyi uzat',
    /** p22-timeout-continuity: the unfinished work the timed-out attempt kept. */
    expired: 'Süre doldu',
    keptPushed: (p: { files: number; branch: string }) =>
      `Yapılan iş kaybolmadı: ${String(p.files)} dosyalık değişiklik ${p.branch} dalına gönderildi (birleştirilmedi). “Aynı yerden devam et” bu işten devam eder.`,
    keptLocal: (p: { files: number; machine: string }) =>
      `Yapılan iş kaybolmadı ama gönderilemedi: ${String(p.files)} dosyalık değişiklik yalnızca ${p.machine} makinesinde saklanıyor. “Aynı yerden devam et” işi o makinede, bu işten sürdürür.`,
    nothingKept: 'Süre dolmadan önce kaydedilecek bir değişiklik yoktu.',
    autoChange: 'otomatik uzatma',
  },
  approval: {
    extend: 'Karar süresini uzat',
    deadline: (p: { time: string }) => `Karar gelmezse ${p.time} süresi dolar.`,
    extended: (p: { time: string }) => `Yeni son tarih: ${p.time}.`,
    failed: (p: { reason: string }) => `Süre uzatılamadı: ${p.reason}`,
  },
};
