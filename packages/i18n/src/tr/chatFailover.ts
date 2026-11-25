import { withSuffix } from '../turkish.js';

/**
 * p15-chat-failover: sohbet asistanının yedek makineleri — Ayarlar → Sohbet'teki yedek listesi ve hazırlık durumu,
 * "Yedek geçişi" sekmesi (şu an kim cevap veriyor, neden, kontroller, son geçişler), Sohbet başlığı ve konuşmadaki not.
 */
export default {
  backups: {
    title: 'Yedek makineler',
    hint: (p: { seconds: number }) =>
      `Ana makine bağlı değilse ya da cevap veremiyorsa sohbet sıradaki yedek makineden devam eder (geçmiş panelde durur, her makine devam edebilir). Ana makine ${String(p.seconds)} sn kesintisiz bağlı kalınca sohbet kendiliğinden ona döner.`,
    empty: 'Yedek makine yok: ana makine giderse sohbet durur.',
    add: 'Yedek ekle',
    addNone: '— makine seç —',
    position: (p: { n: number }) => `${String(p.n)}. yedek`,
    up: (p: { name: string }) => `${p.name}: yukarı taşı`,
    down: (p: { name: string }) => `${p.name}: aşağı taşı`,
    remove: (p: { name: string }) => `${p.name}: yedeklerden çıkar`,
    listLabel: 'Yedek makineler sırası',
    online: 'Bağlı',
    offline: 'Bağlı değil',
    version: (p: { version: string }) => `sürüm ${p.version}`,
    noAssistant: 'Asistan çalıştırmıyor — makineyi güncelle',
    disabled: 'Asistan bu makinede yerel olarak kapalı',
    engineReady: (p: { runtime: string }) => `${p.runtime} hazır`,
    engineMissing: (p: { runtime: string }) => `${p.runtime} yok — makineyi güncelle ya da runtime'ı aç`,
    engineNotReady: (p: { runtime: string; reason: string | null }) =>
      `${p.runtime} hazır değil${p.reason === null ? '' : `: ${p.reason}`}`,
    fallbackReady: (p: { runtime: string }) => `yedek motor ${p.runtime} hazır`,
    eligible: 'Devralabilir',
    notEligible: 'Şu an devralamaz',
  },
  tab: 'Yedek geçişi',
  now: {
    title: 'Şu an',
    sub: 'Sohbete hangi makinenin cevap verdiği ve neden. Yeniden yüklemek için sekmeyi tekrar aç.',
    loading: 'Yedek geçişi durumu yükleniyor',
    answering: (p: { machine: string }) => `Cevap veren: ${p.machine}`,
    nobody: 'Şu an hiçbir makine cevap veremiyor.',
    since: (p: { time: string }) => `${p.time} itibarıyla`,
    roles: { primary: 'ana makine', backup: (p: { n: number }) => `${String(p.n)}. yedek` },
    noBackups: 'Yedek makine tanımlı değil — Asistan sekmesinden ekle.',
  },
  reasons: {
    primary: 'Ana makine cevap veriyor.',
    pinned: 'Bir yönetici bu makineyi sabitledi.',
    primary_offline: (p: { primary: string }) => `${p.primary} bağlı değil.`,
    primary_unavailable: (p: { primary: string }) => `${p.primary} şu an cevap veremiyor.`,
    primary_unstable: (p: { primary: string; time: string }) =>
      `${p.primary} yeniden bağlandı; ${p.time} itibarıyla bağlı kalırsa sohbet ona döner.`,
  },
  issues: {
    offline: 'bağlı değil',
    update_required: 'güncelleme gerekli',
    disabled_on_worker: 'asistan yerel olarak kapalı',
    engine_not_ready: 'runtime hazır değil',
    engine_limited: 'kullanım sınırında',
    not_found: 'artık yok',
  },
  chain: {
    title: 'Makine sırası',
    caption: 'Ana makine ve yedekler, sırayla',
    machine: 'Makine',
    role: 'Rol',
    state: 'Durum',
    connected: 'Bağlı olduğu süre',
    answering: 'Cevap veriyor',
    ready: 'Hazır',
    fallbackEngine: (p: { runtime: string }) => `yedek motorla (${p.runtime})`,
  },
  controls: {
    title: 'Yönet',
    sub: 'Her değişiklik doğrulama kodu ister ve denetim kaydına yazılır.',
    stepUp: 'Yedek geçişini değiştirmek için yeni bir doğrulama kodu gerekiyor.',
    auto: 'Otomatik geçiş',
    autoHint:
      'Kapalıyken sohbet yalnızca ana makineye (ya da sabitlenen makineye) gider; ana makine giderse sohbet durur.',
    autoOn: 'Otomatik geçiş açık.',
    autoOff: 'Otomatik geçiş kapalı.',
    forcePrimary: 'Ana makineye dön',
    forcePrimaryHint:
      'Sabitlemeyi kaldırır ve beklemeden ana makineye geçer (ana makine cevap verebiliyorsa).',
    forced: 'Sohbet ana makineye döndü.',
    pinMachine: 'Sabitlenecek makine',
    pinFor: 'Süre',
    pin: 'Sabitle',
    pinned: (p: { machine: string; time: string }) => `${p.machine} ${p.time} saatine kadar sabit.`,
    unpin: 'Sabitlemeyi kaldır',
    unpinned: 'Sabitleme kaldırıldı.',
    durations: { m15: '15 dakika', h1: '1 saat', h4: '4 saat', h24: '24 saat' },
  },
  events: {
    title: 'Son geçişler',
    empty: 'Henüz geçiş yok.',
    caption: 'Son yedek geçişleri ve elle yapılan değişiklikler',
    failover: (p: { from: string; to: string }) => `${p.from} → ${p.to}: sohbet yedeğe geçti`,
    return: (p: { to: string }) => `Sohbet ${withSuffix(p.to, 'dative')} döndü`,
    rerun: (p: { from: string; to: string }) =>
      `${p.from} cevap verirken koptu; mesaj ${withSuffix(p.to, 'locative')} yeniden yanıtlandı`,
    pin: (p: { to: string; actor: string }) => `${p.actor}, ${p.to} makinesini sabitledi`,
    unpin: (p: { actor: string }) => `${p.actor} sabitlemeyi kaldırdı`,
    force_primary: (p: { to: string; actor: string }) => `${p.actor} sohbeti ana makineye (${p.to}) döndürdü`,
    auto_off: (p: { actor: string }) => `${p.actor} otomatik geçişi kapattı`,
    auto_on: (p: { actor: string }) => `${p.actor} otomatik geçişi açtı`,
    someone: 'bir yönetici',
    unknown: 'bilinmeyen makine',
  },
  header: {
    backup: (p: { why: string }) => `yedek — ${p.why}`,
    pinned: 'sabitlendi',
    offline: (p: { primary: string }) => `${p.primary} bağlı değil`,
    unavailable: (p: { primary: string }) => `${p.primary} cevap veremiyor`,
    unstable: (p: { primary: string }) => `${p.primary} yeni bağlandı`,
  },
  notice: {
    primary_offline: (p: { from: string; to: string }) =>
      `${p.from} bağlı değil; yanıt ${withSuffix(p.to, 'ablative')}.`,
    primary_unavailable: (p: { from: string; to: string }) =>
      `${p.from} şu an cevap veremiyor; yanıt ${withSuffix(p.to, 'ablative')}.`,
    primary_unstable: (p: { from: string; to: string }) =>
      `${p.from} yeni bağlandı; o kararlı olana kadar ${p.to} cevap veriyor.`,
    pinned: (p: { to: string }) => `Yanıt ${withSuffix(p.to, 'ablative')} (bir yönetici sabitledi).`,
    returned: (p: { to: string }) => `Yanıt yeniden ${withSuffix(p.to, 'ablative')}.`,
    rerun: (p: { from: string; to: string }) =>
      `${p.from} cevap verirken koptu; yanıt ${withSuffix(p.to, 'ablative')}.`,
    // p16-chat-complete: the master restarted while answering; the message is answered again.
    restart: 'Panel yeniden başlarken yanıt kesildi; mesajın yeniden yanıtlanıyor.',
  },
};
