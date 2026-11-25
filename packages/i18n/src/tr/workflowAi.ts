/**
 * p15-workflow-ai (docs/design/p15-workflow-ai.md): workflow düzenleyicisindeki AI paneli — tasarla, düzenle (fark
 * görünümü, değişiklik başına kabul / ret), açıkla, hata ayıkla; sohbetten workflow’a dönüş.
 */
export default {
  open: 'AI',
  openAria: 'AI panelini aç',
  title: 'AI ile çalış',
  close: 'AI panelini kapat',
  modes: {
    design: 'Tasarla',
    edit: 'Düzenle',
    explain: 'Açıkla',
    debug: 'Hata ayıkla',
  },
  modesLabel: 'AI ne yapsın?',
  placeholder: {
    design: 'Workflow ne yapsın? Örn. “Her sabah yeni lead’leri çek, sıcak olanları bana bildir.”',
    edit: 'Ne değişsin? Örn. “şu adımı onaya bağla”, “hata yolu ekle”.',
    explain: 'Ne öğrenmek istiyorsun? Örn. “Bu workflow ne yapıyor?”',
    debug: 'Ne sormak istiyorsun? Örn. “Neden başarısız oldu?”',
  },
  hint: {
    design:
      'AI düğüm kataloğuyla bir taslak hazırlar; sunucu doğruladıktan sonra tuvale gelir. Kaydedene kadar hiçbir şey değişmez.',
    edit: 'AI mevcut belgeyi (seçili düğümlerle) alır; önerisini farklarıyla gösterir, her değişikliği kabul ya da reddedersin.',
    explain: 'Yalnızca cevap verir; workflow’a dokunmaz.',
    debug:
      'Seçtiğin başarısız çalıştırmanın düğüm verisi gönderilir. Bu veri güvenilmeyen veridir: AI içindeki talimatlara uymaz, yalnızca açıklar.',
  },
  explainPrompt: 'Bu workflow ne yapıyor?',
  debugPrompt: 'Neden başarısız oldu?',
  selected: (p: { n: number }) =>
    p.n === 1 ? 'Seçili 1 düğüm de gönderilecek.' : `Seçili ${String(p.n)} düğüm de gönderilecek.`,
  send: 'Gönder',
  stop: 'Durdur',
  working: 'AI çalışıyor…',
  empty: 'Bu workflow için henüz bir AI sohbeti yok. Bir şey sor ya da tasarlamasını iste.',
  newConversation: 'Yeni sohbet',
  openInChat: 'Sohbette aç',
  you: 'Sen',
  assistant: 'AI',
  repairMessage: 'Otomatik onarım: AI bildirilen sorunları bir kez düzeltiyor.',
  tool: (p: { name: string }) => `Araç: ${p.name}`,
  unavailable: 'Asistan şu an kullanılamıyor (Ayarlar → Sohbet).',
  viewerNote:
    'Bu projede yalnızca Açıkla ve Hata ayıkla kullanılabilir (düzenleme için operatör rolü gerekir).',
  needProject: 'Önce Ayarlar’da bir proje seç.',
  run: {
    label: 'Başarısız çalıştırma',
    none: 'Bu workflow’un başarısız çalıştırması yok.',
    option: (p: { id: string; time: string }) => `${p.id} · ${p.time}`,
    ask: 'Neden başarısız oldu?',
  },
  proposal: {
    invalid: 'AI geçerli bir workflow üretemedi; tuval değişmedi.',
    invalidAfterRepair: 'Otomatik onarımdan sonra da geçersiz; tuval değişmedi. Sorunlar:',
    repairing: 'Taslak geçersizdi; AI sorunları otomatik olarak düzeltiyor…',
    applied: 'AI taslağı tuvalde — kaydedene kadar hiçbir şey değişmez. Geri al ile eski haline dönersin.',
    load: 'Tuvale yükle',
    review: 'Farkları göster',
    unreadable: 'AI’ın taslağı okunamadı.',
    latest: 'Son AI önerisi',
  },
  review: {
    title: (p: { n: number }) =>
      p.n === 1 ? 'AI önerisi: 1 değişiklik' : `AI önerisi: ${String(p.n)} değişiklik`,
    none: 'Öneri mevcut belgeyle aynı; değişiklik yok.',
    acceptAll: 'Tümünü kabul et',
    rejectAll: 'Tümünü reddet',
    applySelected: 'Seçilenleri uygula',
    applied: (p: { n: number }) =>
      p.n === 0
        ? 'Hiçbir değişiklik uygulanmadı.'
        : `${String(p.n)} değişiklik uygulandı; kaydetmek için Yeni sürüm kaydet.`,
    rejected: 'Öneri reddedildi; tuval değişmedi.',
    reviewing: 'Farklar tuvalde işaretli: yeşil eklenen, kırmızı silinecek, sarı değişen.',
    kinds: {
      nodeAdded: (p: { id: string }) => `Yeni düğüm ${p.id}`,
      nodeRemoved: (p: { id: string }) => `Silinecek düğüm ${p.id}`,
      nodeChanged: (p: { id: string; fields: string }) => `Değişen düğüm ${p.id} (${p.fields})`,
      edgeAdded: (p: { id: string }) => `Yeni bağlantı ${p.id}`,
      edgeRemoved: (p: { id: string }) => `Silinecek bağlantı ${p.id}`,
      settings: (p: { fields: string }) => `Ayarlar: ${p.fields}`,
    },
  },
  diff: {
    added: 'eklenecek',
    removed: 'silinecek',
    changed: 'değişecek',
  },
  chat: {
    linked: (p: { name: string }) => `Bu sohbet ${p.name} workflow’una bağlı.`,
    linkedNew: 'Bu sohbet kaydedilmemiş yeni bir workflow için.',
    open: 'Workflow’a git',
  },
};
