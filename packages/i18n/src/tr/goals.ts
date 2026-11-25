/**
 * p20-outcome: "sonuç ya da açık müdahale" — Senden bekleyen sayfasındaki müdahale kartı: ne istenmişti, ne oldu,
 * sıradaki adım, senin yapman gereken; Devam ettir / Vazgeç / Sohbete git.
 */
export default {
  section: {
    title: 'Müdahale bekleyen hedefler',
    hint: 'Kendi kendine ilerleyemeyen işler. Her hedef için tek kart; devam ettirebilir ya da vazgeçebilirsin.',
    count: (p: { n: number }) => `${String(p.n)} hedef`,
  },
  card: {
    asked: 'Ne istenmişti',
    happened: 'Ne oldu',
    next: 'Sıradaki adım',
    you: 'Senin yapman gereken',
    conversation: (p: { title: string }) => `Sohbet: ${p.title}`,
    untitledConversation: 'Adsız sohbet',
    again: (p: { n: number }) => `${String(p.n)}. kez`,
    resume: 'Devam ettir',
    cancel: 'Vazgeç',
    toChat: 'Sohbete git',
    cancelConfirm: 'Bu hedeften vazgeçilsin mi?',
    cancelPlanConfirm: 'Plan iptal edilsin mi?',
    confirmYes: 'Evet, vazgeç',
    confirmNo: 'Hayır',
    resumed: 'Devam ettirildi. Asistan sohbette işe dönüyor.',
    cancelled: 'Vazgeçildi.',
  },
  origin: {
    plan: 'Plan',
    job: 'İş',
    workflow_run: 'Workflow',
    watch: 'Takip',
  },
  /** blocked_reason → ne oldu (somut ayrıntı kartta ayrıca yazılır). */
  reason: {
    follow_up_cap: 'Otomatik devam sınırına ulaşıldı (6 saatte 3 deneme).',
    follow_up_window: 'Takip sonuçsuz bitti ama devam turu zamanında başlamadı.',
    assistant_unavailable: 'Asistan şu an erişilemiyor; işi devam ettiremedi.',
    assistant_error: 'Asistan devam turunu başlatamadı.',
    budget: 'Harcama freni ya da günlük bütçe devamı durdurdu.',
    job_failed: 'İş başarısız oldu ve otomatik düzeltme kalmadı.',
    run_failed: 'Workflow çalışması başarısız oldu.',
    plan_stalled: 'Plan durdu.',
    plan_item_failed: 'Bir plan maddesi denemelerini tüketti.',
    no_progress: 'Beklenen sürede ilerleme olmadı.',
    assistant_declared: 'Asistan bu işi senin bir adımın olmadan sürdüremiyor.',
    other: 'Hedef kendi kendine ilerleyemiyor.',
  },
  /** blocked_reason → senin yapman gereken (asistan kendi cümlesini yazdıysa o gösterilir). */
  action: {
    follow_up_cap: 'Nedenine bak; düzeltilebiliyorsa devam ettir, istemiyorsan vazgeç.',
    follow_up_window: 'Devam ettir: asistan nedenini bulup işe döner.',
    assistant_unavailable: 'Asistan makinesinin çevrimiçi olduğunu kontrol et, sonra devam ettir.',
    assistant_error: 'Sohbete bak ve devam ettir.',
    budget: 'Bütçeyi ya da harcama frenini kontrol et, sonra devam ettir.',
    job_failed: 'İşin hatasına bak; düzeltmesi için devam ettir ya da vazgeç.',
    run_failed: 'Çalışmanın hatasına bak; yeniden denemesi için devam ettir ya da vazgeç.',
    plan_stalled: 'Planı devam ettir ya da planı iptal et.',
    plan_item_failed: 'Madde için yeni bir yol gerekiyor: devam ettir ya da vazgeç.',
    no_progress: 'Devam ettir: asistan durumu okuyup sıradaki adımı atar.',
    assistant_declared: 'Asistanın istediğini yap, sonra devam ettir.',
    other: 'Devam ettir ya da vazgeç.',
  },
  /** next_action kodları. */
  nextAction: {
    plan_continue: 'Plan devam turu',
    follow_up: 'Asistanın devam turu',
    assistant_turn: 'Asistanın sıradaki turu',
    assistant_step: 'Asistanın kaydettiği adım',
    resume: 'Devam turu gönderiliyor',
    user_action: 'Senin adımın',
    other: 'Senin kararın',
  },
  // p22-goal-line: the platform's resume turn of a goal, shown as one quiet line instead of the person's message.
  resumeLine: (p: { title: string }) => `Asistan hedefi kontrol ediyor: ${p.title}`,
  resumeLinePlain: 'Asistan hedefi kontrol ediyor',
};
