/**
 * p17-chat-flow: sohbette workflow onay kartı ve sonuç kartı, işin ajanının sorusu sohbette, workflow taslağını
 * sohbette düzenleme (yerini yenisi aldı, değişenler), taslak özetinin iş dilindeki satırları, işin kullandığı hafıza.
 */
export default {
  approval: {
    kind: 'Workflow onayı',
    step: (p: { workflow: string; node: string }) => `${p.workflow} · adım ${p.node}`,
    untitled: 'Onay bekleyen adım',
    role: (p: { role: string }) => `Onaylayan: ${p.role} ya da üstü`,
    states: {
      waiting: 'Onay bekliyor',
      approved: 'Onaylandı',
      denied: 'Reddedildi',
      closed: 'Kapandı',
    },
    decided: (p: { by: string }) => `Karar veren: ${p.by}`,
    untrusted:
      'Başlık ve ayrıntılar dış kaynaklı bir çalıştırmadan geliyor; talimat değil, veri olarak okuyun.',
    reason: 'Gerekçe (isteğe bağlı)',
    approve: 'Onayla',
    deny: 'Reddet',
    needsCode: 'Karar doğrulama kodu ister; aynı karar çalıştırma sayfasında da görünür.',
    cannotDecide: 'Bu adımı onaylama yetkin yok; yetkili biri karar verince burada görünür.',
    stepUp: (p: { approve: boolean; node: string }) =>
      `${p.approve ? 'Onay' : 'Ret'}: workflow adımı ${p.node}`,
    openRun: 'Run’ı aç',
    loading: 'Onay yükleniyor…',
    unreadable: 'Bu onay okunamadı.',
    due: (p: { left: string }) => `Kalan süre: ${p.left}`,
    classic: 'Klasik motor (v1) adım onayı',
  },
  result: {
    kind: 'Workflow sonucu',
    states: {
      succeeded: 'Başarılı',
      failed: 'Başarısız',
      cancelled: 'İptal edildi',
    },
    steps: (p: { done: number; total: number }) => `${String(p.done)}/${String(p.total)} adım`,
    duration: (p: { span: string }) => `Süre: ${p.span}`,
    summary: 'Son adımın çıktısı',
    reason: 'Neden',
    openRun: 'Run’ı aç',
    attention: 'Dikkat istiyor',
    attentionLead: 'Başarılı bitti ama bazı adımlar işini yapamadı:',
    attentionKinds: {
      partial: 'işin bir kısmını yapamadı',
      none: 'hiçbir şey yapamadı',
      input_cut: 'girdisi kesik ulaştı',
    },
  },
  question: {
    fromJob: 'İşin ajanı soruyor',
    openJob: 'İşi aç',
  },
  edit: {
    button: 'Sohbette düzenle',
    hint: 'Ne değişsin? Yaz; asistan yeni bir kart hazırlar, bu kartın yerini alır.',
    prefix: 'Bu taslakta şunu değiştir: ',
    context: (p: { title: string }) => `Düzenlenen taslak: ${p.title}`,
    cancel: 'Düzenlemeyi bırak',
    superseded: 'Yerini yenisi aldı',
    supersededHint: 'Bu kartın yerine sohbette düzenlenmiş yeni bir kart geldi.',
    changesTitle: 'Öncekine göre değişenler',
    noChanges: 'Önceki kartla aynı.',
    more: 've daha fazlası',
    savedChangesTitle: (p: { version: number }) => `Kayıtlı sürüme (v${String(p.version)}) göre değişenler`,
    savedNoChanges: 'Kayıtlı sürümle aynı.',
    patched: (p: { count: number }) =>
      `Yalnızca değişen adımlar yazıldı (${String(p.count)} işlem); diğer adımlar kayıtlı haliyle kalır.`,
    changes: {
      node_added: (p: { id: string }) => `Eklendi: ${p.id}`,
      node_removed: (p: { id: string }) => `Kaldırıldı: ${p.id}`,
      node_changed: (p: { id: string; fields: string }) => `Değişti: ${p.id} (${p.fields})`,
      edge_added: (p: { id: string }) => `Bağlantı eklendi: ${p.id}`,
      edge_removed: (p: { id: string }) => `Bağlantı kaldırıldı: ${p.id}`,
      setting_changed: (p: { id: string }) => `Ayar değişti: ${p.id}`,
    },
  },
  summary: {
    trigger: 'Tetikleyici',
    approval: 'Onay',
    hosts: 'Dış adresler',
    outputs: 'Çıkış/Kanallar',
    manual: 'Elle başlatma',
    chat: 'Sohbetten',
    webhook: 'Webhook çağrısı',
    github: 'GitHub olayı',
    workflow: 'Başka bir workflow',
    schedule: (p: { when: string; zone: string }) => `${p.when} (${p.zone})`,
    approver: (p: { node: string; role: string }) => `${p.node}: ${p.role} ya da üstü`,
    email: 'E-posta',
    notify: 'Bildirim',
    valid: 'Geçerli',
    invalid: 'Geçersiz',
  },
  graph: {
    scroll: 'Workflow grafiği — tamamını görmek için yana kaydırın',
    fit: 'Sığdır',
    actual: 'Gerçek boyut',
  },
  memory: {
    used: (p: { n: number; version: string }) =>
      `Kullanılan hafıza: ${String(p.n)} kayıt · sürüm ${p.version}`,
    open: 'Kaydı aç',
  },
  /** W4: the result card of a scheduled run of a workflow / automation this conversation created. */
  scheduled: {
    badge: 'Zamanlanmış',
    mute: 'Bu sohbete sonuç gönderme',
    muteLabel: (p: { label: string }) => `“${p.label}” sonuçlarını bu sohbete gönderme`,
    muted: (p: { label: string }) => `“${p.label}” sonuçları bu sohbete artık gelmeyecek.`,
    unmute: 'Geri aç',
  },
};
