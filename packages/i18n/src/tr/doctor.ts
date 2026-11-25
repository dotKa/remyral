/**
 * p16-doctor: Ayarlar → Tanılama — doktor çalıştırmaları, makine doktorları, destek raporu (önizleme, indirme,
 * e-postayla gönderme) ve destek ayarları; sohbet kartı (draft_support_report). Bulgu metinleri kontrol + koda göre
 * (`findings.master.<kontrol>.<kod>`, kontrol adındaki nokta `_` olur); bilinmeyen bir kod için ana sunucunun İngilizce
 * metni gösterilir.
 */
export default {
  page: {
    label: 'Tanılama',
    purpose:
      'Kontrol düzlemini ve makineleri tek tıkla denetle; sorun varsa gizli değerleri maskelenmiş bir raporu indir ya da destek adresine gönder.',
    docTitle: 'Tanılama · Remyral',
  },
  loading: 'Tanılama yükleniyor',
  what: 'tanılama',
  run: {
    title: 'Doktor',
    sub: 'Veritabanı, Redis, migration’lar, disk, kuyruk, makineler, anahtar süreleri, entegrasyonlar, sohbet, yedekler, son hatalar.',
    button: 'Tanılamayı çalıştır',
    machines: 'Makineleri de kontrol et (bağlı her makinede doktor çalışır, ~20 sn)',
    never: 'Henüz tanılama çalıştırılmadı.',
    last: (p: { ago: string; kind: string }) => `Son çalıştırma ${p.ago} (${p.kind})`,
    daily: (p: { ago: string; n: number }) =>
      p.n === 0
        ? `Günlük kontrol ${p.ago}: yeni sorun yok`
        : `Günlük kontrol ${p.ago}: ${String(p.n)} yeni sorun`,
    dailyNever:
      'Günlük kontrol henüz çalışmadı (her gün bir kez, yalnızca yeni sorunlarda bildirim gönderir).',
    kinds: { manual: 'elle', daily: 'günlük', chat: 'sohbet' },
    showPassed: 'Geçen kontrolleri de göster',
    hidePassed: 'Geçen kontrolleri gizle',
    allOk: 'Sorun bulunmadı.',
    fix: 'Öneri',
    open: 'Aç',
    guide: 'Rehber',
  },
  summary: {
    error: (p: { n: number }) => `${String(p.n)} hata`,
    warning: (p: { n: number }) => `${String(p.n)} uyarı`,
    info: (p: { n: number }) => `${String(p.n)} not`,
    ok: (p: { n: number }) => `${String(p.n)} geçti`,
  },
  severity: { ok: 'Geçti', info: 'Not', warning: 'Uyarı', error: 'Hata' },
  checks: {
    db_reachable: 'Veritabanı',
    redis_reachable: 'Redis',
    db_migrations: 'Migration’lar',
    disk: 'Disk',
    storage: 'Dosya depolama',
    master_web: 'Web arayüzü',
    queue_backlog: 'Kuyruk',
    queue_stuck: 'Takılan işler',
    queue_approval_orphan: 'Karar bekleyen işler',
    queue_leases_expired: 'Süresi geçmiş lease’ler',
    workers_offline: 'Makineler',
    workers_disk: 'Makine diskleri',
    workers_clock: 'Makine saatleri',
    workers_outdated: 'Makine yazılımı sürümleri',
    workers_login: 'Runtime girişleri',
    workers_sandbox: 'Sandbox',
    workers_git: 'Git',
    expiry: 'Anahtar ve sertifika süreleri',
    integrations: 'Entegrasyonlar',
    chat_assistant: 'Sohbet asistanı',
    version_feed: 'Sürüm akışı',
    backups: 'Yedekler',
    errors_burst: 'Son hatalar',
    webhooks_disabled: 'Webhook’lar',
    cost_brake: 'Maliyet freni',
    config: 'Yapılandırma',
    master_url: 'Ana sunucu adresi',
    master_dns: 'DNS',
    master_connect: 'Bağlantı / TLS',
    master_http: 'Ana sunucu yanıtı',
    clock: 'Saat',
    service: 'Servis',
    directories: 'Klasörler',
    node: 'Node',
    node_npm: 'npm',
    git: 'Git',
    runtimes: 'Runtime’lar',
    sandbox: 'Sandbox',
    probe: 'Tarama',
    machine_admin: 'Makine yönetimi',
  },
  findings: {
    common: {
      check_failed: { text: 'Bu kontrol çalıştırılamadı.' },
      more: { text: 'Aynı türden {n} sorun daha var.' },
      ok: { text: 'Sorun yok.' },
    },
    master: {
      db_reachable: {
        ok: { text: 'Postgres yanıt veriyor ({ms} ms).' },
        slow: {
          text: 'Postgres yavaş yanıt veriyor ({ms} ms).',
          fix: 'Veritabanı sunucusunun yükünü, bağlantı sayısını ve diskini kontrol et.',
        },
        timeout: {
          text: 'Postgres zamanında yanıt vermedi.',
          fix: 'Veritabanı container’ının çalıştığını ve DATABASE_URL’in doğru olduğunu kontrol et.',
        },
        unreachable: {
          text: 'Postgres yanıt vermiyor.',
          fix: 'Veritabanı container’ının çalıştığını ve DATABASE_URL’in doğru olduğunu kontrol et.',
        },
      },
      redis_reachable: {
        ok: { text: 'Redis yanıt veriyor ({ms} ms).' },
        slow: {
          text: 'Redis yavaş yanıt veriyor ({ms} ms).',
          fix: 'Redis container’ının belleğini ve sunucu yükünü kontrol et.',
        },
        timeout: {
          text: 'Redis zamanında yanıt vermedi.',
          fix: 'Redis container’ının çalıştığını ve REDIS_URL’in doğru olduğunu kontrol et.',
        },
        unreachable: {
          text: 'Redis yanıt vermiyor.',
          fix: 'Redis container’ının çalıştığını ve REDIS_URL’in doğru olduğunu kontrol et.',
        },
      },
      db_migrations: {
        ok: { text: 'Tüm migration’lar uygulanmış (son: {latest}).' },
        pending: {
          text: '{n} migration uygulanmamış (ilki {first}).',
          fix: 'Ana sunucuyu yeniden başlat: açılışta bekleyen migration’ları uygular; hata olursa kaydı hangisi olduğunu söyler.',
        },
        newer_database: {
          text: 'Veritabanında bu sürümün bilmediği {n} migration var (daha yeni bir sürüm çalışmış).',
          fix: 'Veritabanına uyan sürümü deploy et; ana sunucuyu eski sürüme döndürmek desteklenmez.',
        },
      },
      disk: {
        ok: { text: 'Ana sunucuda yeterli boş disk var.' },
        unknown: { text: 'Disk kullanımı burada ölçülemiyor.' },
        low: {
          text: 'Disk ({disk}) %{percent} dolu.',
          fix: 'Eski yedekleri, kayıtları ve kullanılmayan Docker imajlarını temizle ya da diski büyüt.',
        },
        full: {
          text: 'Disk ({disk}) %{percent} dolu — neredeyse tamamen dolu.',
          fix: 'Hemen yer aç (eski yedekler, docker system prune) ya da diski büyüt.',
        },
      },
      storage: {
        ok: { text: 'Dosya depolama yolunda ({mode}).' },
        unknown: { text: 'Dosya depolama burada ölçülemiyor.' },
        unusable: {
          text: 'Nesne depolama seçili ama kullanılamıyor.',
          fix: 'Ayarlar → Entegrasyonlar → Depolama ekranında kova ayarlarını ve anahtarları yeniden gir ya da yerel diske dön.',
        },
        unreachable: {
          text: 'Nesne depolama yanıt vermiyor ({error}).',
          fix: 'Ayarlar → Entegrasyonlar → Depolama ekranında "Bağlantıyı test et"i çalıştır; adresi, anahtarları ve kova politikasını kontrol et.',
        },
        local_low: {
          text: 'Dosya klasöründe {freeMiB} MiB boş yer var (%{percent} dolu).',
          fix: 'Büyük çıktılar için yer ayır: birimi büyüt, projelere saklama süresi koy ya da nesne depolamaya geç.',
        },
        local_full: {
          text: 'Dosya klasörü neredeyse dolu: {freeMiB} MiB boş (%{percent} dolu).',
          fix: 'Dosya birimini büyüt, projelerin saklama süresini kısalt ya da çıktıları nesne depolamaya taşı.',
        },
        legacy_bytes: {
          text: '{mib} MiB dosya hala veritabanında.',
          fix: 'Ana sunucuda `remyral-master blobs:migrate` komutunu çalıştır: dosyaları depolamaya taşır ve her birini doğrular.',
        },
      },
      master_web: {
        ok: { text: 'Web arayüzü yanıt veriyor.' },
        not_probed: { text: 'Web arayüzü denetlenmiyor (STATUS_WEB_URL ayarlı değil).' },
        failing: {
          text: 'Web arayüzü yanıt vermiyor ({code}).',
          fix: 'Coolify’da web container’ını yeniden başlat ve proxy ağını kontrol et.',
        },
      },
      queue_backlog: {
        ok: { text: '{queued} iş kuyrukta, {running} iş çalışıyor.' },
        unknown: { text: 'Kuyruk okunamadı.' },
        waiting: {
          text: '{n} iş kuyrukta; en eskisi {minutes} dakikadır bekliyor.',
          fix: 'İşin runtime’ı ve sandbox’ı olan bir makinenin çevrimiçi ve boş olduğunu kontrol et; iş sayfası neden beklediğini söyler.',
        },
      },
      queue_stuck: {
        ok: { text: 'Takılan iş yok.' },
        no_lease: {
          text: 'Bir iş {minutes} dakikadır {state} durumunda ve lease’i yok.',
          fix: 'Makinesini kontrol et (çevrimdışı mı?); iş sayfasından iptal et ya da yeniden dene.',
        },
        lease_expired: {
          text: 'Bir iş {minutes} dakikadır {state} durumunda ve lease süresi geçmiş.',
          fix: 'Lease temizleyici işi kuyruğa geri almalı; kalırsa makinesini kontrol et, işi iptal et ya da yeniden dene.',
        },
      },
      queue_approval_orphan: {
        ok: { text: 'Onay bekleyen her işin karar verilecek bir isteği var.' },
        nothing_to_decide: {
          text: 'Bir iş {minutes} dakikadır onay bekliyor ama açık bir onay isteği yok.',
          fix: 'İşi aç: sonucu orada onayla, reddet ya da işi iptal et. Hiçbir düğme işe yaramazsa raporla.',
        },
      },
      queue_leases_expired: {
        ok: { text: 'Süresi geçip açık kalan lease yok.' },
        open: {
          text: 'Süresi geçmiş {n} lease hala açık.',
          fix: 'Lease temizleyici birkaç saniyede bir kapatır; sayı düşmüyorsa kayıtlarda (orchestrator) nedenine bak.',
        },
      },
      workers_offline: {
        ok: { text: '{n} makinenin hepsi çevrimiçi.' },
        none: {
          text: 'Eşleşmiş makine yok: işler çalışamaz.',
          fix: 'Makineler → Makine ekle ile bir makine ekle ve eşleşmeyi onayla.',
        },
        offline: {
          text: '{name} çevrimdışı (son görülme {minutes} dk önce).',
          fix: 'Makinenin açık ve internete bağlı olduğunu kontrol et; makinede doktor komutunu çalıştır (Makine doktorları bölümünde; ana sunucu olmadan da çalışır) ve makine servisini yeniden başlat.',
        },
      },
      workers_disk: {
        ok: { text: 'Her makinede yeterli boş disk var.' },
        disk_low: {
          text: '{name} en düşük boş disk sınırının altında: oraya iş verilmiyor.',
          fix: 'Makine sayfasında Disk temizliği → Şimdi temizle ile makinenin kendi dosyalarını temizle, çalışma kökünde yer aç (tutulan çalışma klasörleri) ya da workspace.minFreeBytes değerini düşür.',
        },
        disk_low_after_cleanup: {
          text: '{name} kendi temizliğinden sonra da en düşük boş disk sınırının altında ({freedMiB} MiB açıldı); en çok yeri {largest} kaplıyor ({largestMiB} MiB).',
          fix: 'Makine silebileceği her şeyi sildi (önbellekler, eski sürümler, günlükler, süresi dolan dosyalar). Klasör başına yer kullanımı makine sayfasında; makine verisi dışında yer aç, diski büyüt ya da workspace.minFreeBytes değerini düşür.',
        },
        disk_tight: {
          text: '{name} en düşük boş disk sınırına yaklaştı.',
          fix: 'İşler reddedilmeden önce çalışma kökünde yer aç.',
        },
      },
      workers_clock: {
        ok: { text: 'Makinelerin saati ana sunucuyla uyumlu.' },
        skew: {
          text: '{name} saatinde ana sunucuya göre {seconds} sn fark var.',
          fix: 'Makinede otomatik saat eşitlemeyi (NTP) aç: lease’ler, imzalı komutlar ve girişler saate bağlı.',
        },
      },
      workers_outdated: {
        ok: { text: 'Her makine yayınlanan makine yazılımı sürümünde ({stable}).' },
        no_release: { text: 'Yayınlanmış kararlı bir makine yazılımı sürümü yok.' },
        outdated: {
          text: '{name} makine yazılımı {version} sürümünde; {stable} yayınlandı.',
          fix: 'Rollout yüzdesi makineye ulaşınca kendini günceller; Ayarlar → Makine sürümleri.',
        },
      },
      workers_login: {
        ok: { text: 'Kurulu her runtime’da giriş yapılmış.' },
        not_signed_in: {
          text: '{name} makinesinde {runtime} kurulu ama giriş yapılmamış.',
          fix: 'Makineler → <makine> → Çalıştırıcılar’dan giriş yap ya da bir API anahtarı tanımla.',
        },
      },
      workers_sandbox: {
        ok: { text: 'Her makinede hazır bir sandbox profili var.' },
        none_ready: {
          text: '{name} makinesinde hiçbir sandbox profili hazır değil.',
          fix: 'Makineler → <makine> → Sandbox & policy’de “Hazırla”yı çalıştır.',
        },
      },
      workers_git: {
        ok: { text: 'Git her makinede hazır.' },
        git_missing: {
          text: '{name} makinesinde git kurulu değil: depo işleri çalışamaz.',
          fix: 'Git kur (Windows’ta Makineler → <makine> → Araçlar: MinGit) ya da gitBinary ayarla.',
        },
        git_problems: {
          text: '{name} makinesinde git’in {n} engelleyici sorunu var ({codes}).',
          fix: 'Makineler → <makine> → Git’te “Düzelt”e bas ya da listelenen adımları uygula.',
        },
      },
      expiry: {
        ok: { text: 'Yakında süresi dolan anahtar, token ya da sertifika yok.' },
        unknown: { text: 'Anahtar ve sertifika süreleri okunamadı.' },
        expired: {
          text: '{what}: süresi doldu ya da yenileme zamanı geçti.',
          fix: 'Runbook’una göre yenile (Ayarlar → Operasyon güvenliği → Anahtarlar ve süreler) ve “yenilendi” olarak işaretle.',
        },
        urgent: {
          text: '{what}: {days} gün kaldı.',
          fix: 'Runbook’una göre yenile (Ayarlar → Operasyon güvenliği → Anahtarlar ve süreler).',
        },
        soon: { text: '{what}: {days} gün kaldı.', fix: 'Önümüzdeki günlerde yenilemeyi planla.' },
      },
      integrations: {
        ok: { text: 'Bağlı entegrasyonlar son testlerini geçti.' },
        none: { text: 'Bağlı entegrasyon yok.' },
        coolify_failing: {
          text: 'Coolify bağlantısı “{label}” son testini geçemedi ya da kullanılamıyor.',
          fix: 'Ayarlar → Entegrasyonlar → Coolify’da yeniden test et; token iptal edildiyse değiştir.',
        },
        cloudflare_failing: {
          text: 'Cloudflare token’ı son testini geçemedi.',
          fix: 'Ayarlar → Entegrasyonlar → Cloudflare’da test et; süresi dolduysa yeni token oluştur.',
        },
        git_host_failing: {
          text: '{kind} bağlantısı “{label}” son testini geçemedi ({code}).',
          fix: 'Ayarlar → Entegrasyonlar’da yeniden test et; token iptal edildiyse ya da yetkisi eksikse değiştir.',
        },
        github_failing: {
          text: 'GitHub uygulamasının anahtarı kullanılamıyor ya da {missing} izni eksik.',
          fix: 'Ayarlar → Entegrasyonlar → GitHub: anahtarı yeniden yükle ya da GitHub’da istenen izinleri kabul et.',
        },
      },
      chat_assistant: {
        ok: { text: 'Sohbet {machine} makinesinde yanıt veriyor, hazır bir yedek makine var.' },
        unknown: { text: 'Sohbet yönlendirmesi okunamadı.' },
        unavailable: {
          text: 'Sohbet asistanı şu an yanıt veremiyor.',
          fix: 'Ayarlar → Sohbet’te girişi yapılmış runtime’ı olan bağlı bir makine seç.',
        },
        no_failover: {
          text: 'Sohbet {machine} makinesinde çalışıyor; hazır yedek makine yok.',
          fix: 'Ayarlar → Sohbet’e yedek bir makine ekle ki ana makine kapanınca sohbet taşınsın.',
        },
      },
      version_feed: {
        ok: { text: 'Sürüm akışı güncel.' },
        off: { text: 'Sürüm akışı kapalı.' },
        failing: {
          text: '{items} kaynaktan {failing} tanesi son kontrolde okunamadı.',
          fix: 'Çoğu zaman geçicidir; sürerse ana sunucu internete ulaşamıyor olabilir (proxy, DNS).',
        },
      },
      backups: {
        ok: { text: 'Yedekler güncel.' },
        not_configured: {
          text: 'Yedekleme ayarlı değil.',
          fix: 'Yedekleme servisini kur (docs/ops/backup-restore.md); yoksa disk kaybında her şey gider.',
        },
      },
      errors_burst: {
        ok: { text: 'Son bir saatte hata patlaması yok.' },
        http_5xx: {
          text: 'Son {minutes} dakikada {n} sunucu hatası (HTTP 5xx).',
          fix: 'Ayarlar → Sistem durumu → Kayıtlar’da error seviyesini ara.',
        },
        log_errors: {
          text: 'Son bir saatte ana sunucu kaydında {n} hata satırı (en çok: {top}).',
          fix: 'Ayarlar → Sistem durumu → Kayıtlar’da error seviyesi ve bu bileşene göre filtrele.',
        },
      },
      webhooks_disabled: {
        ok: { text: 'Kapatılmış webhook yok.' },
        auto_disabled: {
          text: '“{name}” webhook’u art arda hatalar yüzünden kapatıldı.',
          fix: 'Alıcıyı düzelt, sonra Ayarlar → Webhook’lar’dan sürdür (gönderim günlüğü hataları gösterir).',
        },
      },
      cost_brake: {
        ok: { text: 'Maliyet freni devrede değil.' },
        unknown: { text: 'Maliyet freni okunamadı.' },
        engaged: {
          text: '{scope} model harcaması {window} tavanının %{percent} seviyesine ulaştı.',
          fix: 'Bir sahip Ayarlar → Operasyon güvenliği → Maliyet freni’nden birkaç saatliğine kaldırabilir ya da tavanı yükseltebilir.',
        },
        blocking: {
          text: '{scope} model harcaması {window} tavanına ulaştı: acil olmayan yeni işler bekliyor.',
          fix: 'Bir sahip Ayarlar → Operasyon güvenliği → Maliyet freni’nden kaldırabilir ya da tavanı yükseltebilir.',
        },
      },
    },
    worker: {
      config: {
        ok: { text: 'Yapılandırma dosyası geçerli ({path}).' },
        invalid: {
          text: 'Makine yapılandırması kullanılamıyor ({path}).',
          fix: 'Dosyayı düzelt; servis durumu komutu hangi dosyanın okunduğunu gösterir.',
        },
      },
      master_url: { invalid: { text: 'masterUrl bir ws:// ya da wss:// adresi değil.' } },
      master_dns: {
        ok: { text: '{host} çözümleniyor.' },
        dns_failed: {
          text: '{host} çözümlenemiyor ({code}).',
          fix: 'Makinenin DNS’ini / internet bağlantısını ve yapılandırmadaki ana sunucu adını kontrol et.',
        },
      },
      master_connect: {
        ok: { text: 'Ana sunucuya bağlantı ve TLS sorunsuz.' },
        unreachable: {
          text: '{host}:{port} adresine ulaşılamıyor ({code}).',
          fix: 'Bu makine ile ana sunucu arasındaki güvenlik duvarını / proxy’yi (giden HTTPS 443) ve ana sunucunun açık olduğunu kontrol et.',
        },
        tls_failed: {
          text: '{host} sertifikasına bu makine güvenmiyor ({code}).',
          fix: 'Makinenin tarihini ve sertifika deposunu kontrol et; TLS’i araya giren bir kurum proxy’sinin sertifikası güvenilir olmalı.',
        },
        plain: {
          text: '{host} adresine TLS olmadan (ws://) bağlanılıyor.',
          fix: 'Bu makinede olmayan her ana sunucu için wss:// kullan.',
        },
        cert_expiring: {
          text: 'Ana sunucu sertifikasının süresi {days} gün içinde doluyor.',
          fix: 'Sertifikayı yenile (Coolify / proxy Let’s Encrypt’i kendisi yeniler — kontrol et).',
        },
      },
      master_http: {
        ok: { text: 'Ana sunucu durum denetimine yanıt veriyor.' },
        master_unavailable: {
          text: 'Ana sunucu açık ama hazır değil (veritabanı ya da Redis kapalı).',
          fix: 'Sahip Ayarlar → Sistem durumu’na ya da Coolify’daki container’lara baksın.',
        },
        http_failed: {
          text: 'Ana sunucunun durum denetimi başarısız oldu.',
          fix: 'Aradaki bir proxy istekleri engelliyor olabilir; makine yazılımının ana sunucuya düz giden HTTPS ve WebSocket bağlantısı olmalı.',
        },
        http_unexpected: {
          text: 'Ana sunucunun durum denetimi HTTP {status} döndü.',
          fix: 'Aradaki bir proxy istekleri engelliyor ya da değiştiriyor olabilir.',
        },
      },
      clock: {
        ok: { text: 'Saat ana sunucuyla uyumlu ({seconds} sn).' },
        skew: {
          text: 'Bu makinenin saati ana sunucudan {seconds} sn farklı.',
          fix: 'Otomatik saat eşitlemeyi (NTP / Windows Saati) aç.',
        },
        not_checked: { text: 'Saat karşılaştırılamadı (ana sunucu yanıt vermedi).' },
      },
      service: {
        ok: { text: 'Makine servisi çalışıyor ({state}).' },
        unknown: { text: 'Servis yöneticisi sorgulanamadı.' },
        not_installed: {
          text: 'Makine yazılımı servis olarak kurulu değil.',
          fix: 'Makineler → Makine ekle’deki kurucuyla servisi kur: açılışta başlar ve uzaktan yeniden başlatılabilir.',
        },
        not_running: {
          text: 'Makine servisi çalışmıyor ({state}).',
          fix: 'Servisi başlat ve veri klasöründeki boot.log ile makine günlüğünü oku.',
        },
        stale: {
          text: 'Servis çalışıyor ama durum dosyası güncel değil (takılmış olabilir).',
          fix: 'Makine servisini yeniden başlat.',
        },
      },
      directories: {
        ok: { text: 'Veri klasörü ve çalışma kökü kullanılabilir.' },
        missing: {
          text: '{dir} yok ({path}).',
          fix: 'Klasörü oluştur ve makine yazılımının hesabına yazma izni ver (kurucu bunu yapar).',
        },
        not_writable: {
          text: '{dir} yazılabilir değil ({path}).',
          fix: 'Makine yazılımının hesabına yazma izni ver.',
        },
        world_writable: {
          text: '{dir} herkes tarafından yazılabilir ({path}).',
          fix: 'Diğer kullanıcıların yazma iznini kaldır (chmod o-w / icacls): aksi halde makine yazılımı çalışmaz.',
        },
      },
      disk: {
        ok: { text: 'Yeterli boş disk var.' },
        low: {
          text: '{dir}: boş disk az.',
          fix: 'Yer aç (tutulan çalışma klasörleri, eski runtime sürümleri, Docker imajları) ya da klasörü daha büyük bir diske taşı.',
        },
        last_cleanup: {
          text: 'Makinenin kendi temizliği en son {at} tarihinde çalıştı ve {freedMiB} MiB açtı.',
          fix: 'Disk azalınca ve günde bir kez kendiliğinden çalışır; makine sayfasında "Şimdi temizle" ve yeri neyin kapladığı görünür.',
        },
      },
      node: {
        ok: { text: 'Node {version}.' },
        too_old: {
          text: 'Node {version}, gereken {required} sürümünden eski.',
          fix: 'Node {required} kur (kurucu Node’u kendisi getirir).',
        },
      },
      node_npm: {
        ok: { text: 'npm {version}.' },
        missing: {
          text: 'Node’un yanında npm bulunamadı: sürüm sabitinin dışındaki runtime sürümleri burada kurulamaz.',
        },
      },
      git: {
        ok: { text: 'git {version}.' },
        missing: {
          text: 'git kurulu değil: depo işleri burada çalışamaz.',
          fix: 'Git kur (Windows’ta konsol MinGit kurar) ya da yapılandırmada gitBinary ayarla.',
        },
      },
      runtimes: {
        ok: { text: '{runtime} {version}.' },
        probe_failed: { text: 'Runtime / araç taraması tamamlanmadı.' },
        not_installed: {
          text: '{runtime} izinli ama kurulu değil.',
          fix: 'Makineler → <makine> → Çalıştırıcılar’dan kur.',
        },
        not_signed_in: {
          text: '{runtime} kurulu ama giriş yapılmamış.',
          fix: 'Konsoldan giriş yap ya da bir API anahtarı tanımla.',
        },
        pin_mismatch: { text: '{runtime} {version}, sürüm sabiti {pin} ile aynı değil.' },
      },
      sandbox: {
        ok: { text: 'Hazır bir sandbox profili var.' },
        none_ready: {
          text: 'Bu makinede hiçbir sandbox profili hazır değil.',
          fix: 'Makineler → <makine> → Sandbox & policy’de “Hazırla”yı çalıştır.',
        },
      },
      /** p17-worker-1-1-1: can the root/SYSTEM helper start machine-administration sessions? */
      machine_admin: {
        ok: { text: 'Ayrıcalıklı yardımcı makine yönetimi oturumlarını başlatabilir.' },
        install_dir_unknown: {
          text: 'Makine yönetimi kullanılamıyor: makine yazılımı kurulum klasörünü bilmiyor.',
        },
        helper_missing: {
          text: 'Makine yönetimi kullanılamıyor: ayrıcalıklı yardımcı kurulu değil.',
          fix: 'Makine yönetimi gerekiyorsa bu sürümün kurulum paketini bir kez yönetici / root olarak çalıştır.',
        },
        helper_outdated: {
          text: 'Makine yönetimi kullanılamıyor: kurulu ayrıcalıklı yardımcı eski.',
          fix: 'Bu sürümün kurulum paketini bir kez yönetici / root olarak yeniden çalıştır.',
        },
        admin_unit_missing: {
          text: 'Makine yönetimi kullanılamıyor: systemd tetikleyicisi kurulu değil.',
          fix: 'Kurulum paketini bir kez root olarak yeniden çalıştır.',
        },
        admin_unit_disabled: {
          text: 'Makine yönetimi kullanılamıyor: systemd tetikleyicisi etkin değil.',
          fix: 'Kurulum paketini bir kez root olarak yeniden çalıştır.',
        },
        state_dir_not_traversable: {
          text: 'Makine yönetimi kullanılamıyor: makine yazılımının hesabı yardımcının yanıt klasörüne (state/machine-admin) erişemiyor.',
          fix: 'Bu sürümün kurulum paketini bir kez root olarak yeniden çalıştır.',
        },
        admin_task_missing: {
          text: 'Makine yönetimi kullanılamıyor olabilir: zamanlanmış görev (RemyralWorkerAdmin) bulunamadı.',
          fix: 'Kurulum paketini bir kez Yönetici olarak yeniden çalıştır.',
        },
        admin_task_unreadable: {
          text: 'Makine yönetiminin zamanlanmış görevi (RemyralWorkerAdmin) sorgulanamadı.',
        },
        admin_plist_missing: {
          text: 'Makine yönetimi kullanılamıyor: LaunchDaemon kurulu değil.',
          fix: 'Kurulum paketini bir kez yönetici olarak yeniden çalıştır.',
        },
        probe_failed: { text: 'Makine yönetiminin hazırlık denetimi tamamlanamadı.' },
      },
    },
  },
  machines: {
    title: 'Makine doktorları',
    sub: 'Her makine kendi tarafını denetler: ana sunucuya bağlantı, saat, servis, disk, runtime’lar, sandbox. Ana sunucuya ulaşamayan bir makinede doktor komutunu çalıştır.',
    none: 'Henüz makine sonucu yok. “Makineleri de kontrol et” ile tanılamayı çalıştır ya da bir makinenin doktorunu iste.',
    request: 'Doktoru çalıştır',
    states: {
      done: 'Tamamlandı',
      pending: 'Yanıt bekleniyor',
      failed: 'Başarısız',
      unsupported: 'Desteklenmiyor',
      offline: 'Çevrimdışı',
    },
    older: 'Eski makine yazılımı sürümü: yalnızca temel tanılama.',
    reportOf: (p: { version: string; platform: string }) => `makine yazılımı ${p.version} · ${p.platform}`,
    cli: (p: { command: string }) => `Makinede: ${p.command}`,
  },
  report: {
    title: 'Destek raporu',
    sub: 'Gizli değerleri maskelenmiş tek bir zip: doktor sonuçları, sistem durumu, sürümler, izinli ayarlar, son uyarı / hata kayıtları, başarısız işlerin özeti, makine doktorları. Göndermeden önce içeriğini görürsün.',
    description: 'Destek kaydı oluştur — sorunu anlat',
    descriptionHint: 'Ne oldu, ne zamandan beri, ne denedin? Parola ya da token yazma.',
    sections: 'Bölümler',
    sectionNames: {
      doctor: 'Doktor sonuçları',
      workers: 'Makine doktorları',
      status: 'Sistem durumu',
      versions: 'Sürümler',
      config: 'Ayarlar (izin listesindeki anahtarlar)',
      logs: 'Uyarı ve hata kayıtları',
      failed_jobs: 'Başarısız işler (yalnızca özet)',
      job_prompts: 'İş istemleri ve başlıkları',
    },
    jobPromptsWarning: 'İş istemleri müşteri verisi içerebilir; yalnızca gerçekten gerekiyorsa ekle.',
    hours: 'Kayıt aralığı',
    hoursValue: (p: { n: number }) => `Son ${String(p.n)} saat`,
    preview: 'Önizle',
    rebuild: 'Önizlemeyi yenile',
    files: 'Dosyalar',
    file: 'Dosya',
    section: 'Bölüm',
    size: 'Boyut',
    items: 'Kayıt',
    total: (p: { size: string; files: number }) => `${String(p.files)} dosya · ${p.size}`,
    summary: 'Özet (report.md)',
    overCap: (p: { max: string }) =>
      `Rapor ${p.max} sınırından büyük: e-postaya eklenmez, yalnızca özet gider. Zip’i indirip başka yoldan paylaşabilirsin.`,
    download: 'Zip’i indir',
    expires: (p: { at: string }) => `Bu rapor ${p.at} tarihine kadar saklanır.`,
    sendTitle: 'Raporu e-postayla gönder',
    recipient: (p: { to: string }) => `Alıcı: ${p.to}`,
    recipientMissing:
      'Destek adresi ayarlı değil: raporu e-postayla göndermek için aşağıdaki destek ayarlarından bir adres gir ya da zip’i indir.',
    ccMe: (p: { address: string }) => `Bana da kopya gönder (${p.address})`,
    ccMissing: 'Kendine kopya için Ayarlar → Bildirimler’de e-posta adresini ekle.',
    send: 'Raporu e-postayla gönder',
    sendStepUp: 'Tanılama raporunu destek adresine gönder',
    smtpMissing:
      'E-posta sunucusu ayarlı değil: aşağıdaki destek ayarlarından SMTP sunucusunu gir ya da zip’i indir.',
    sent: (p: { to: string; at: string }) => `${p.to} adresine gönderildi (${p.at}).`,
    sentSummaryOnly: 'Zip büyük olduğu için yalnızca özet gönderildi.',
    noSections: 'En az bir bölüm seç.',
  },
  settings: {
    title: 'Destek ayarları',
    sub: 'Raporun gideceği adres ve gönderen e-posta sunucusu. Parola şifreli saklanır, hiç gösterilmez.',
    email: 'Destek adresi',
    defaultEmail: (p: { email: string }) => `Varsayılan: ${p.email}`,
    noDefaultEmail:
      'Varsayılan bir adres yok. Boş bırakırsan raporlar yalnızca indirilir, e-postayla gönderilmez.',
    source: {
      settings: 'Gönderen: buradaki SMTP sunucusu.',
      notifications:
        'Gönderen: ana sunucunun bildirim SMTP’si (NOTIFY_SMTP_*). İstersen buraya ayrı bir sunucu gir.',
      none: 'E-posta sunucusu yok: aşağıya bir SMTP sunucusu gir.',
    },
    smtpTitle: 'SMTP sunucusu (isteğe bağlı)',
    host: 'Sunucu',
    port: 'Port',
    security: 'Güvenlik',
    securityStarttls: 'STARTTLS (587)',
    securityTls: 'TLS (465)',
    from: 'Gönderen adres',
    username: 'Kullanıcı adı',
    password: 'Parola',
    passwordSet: 'Kayıtlı (değiştirmek için yaz)',
    removeSmtp: 'SMTP sunucusunu kaldır',
    save: 'Kaydet',
    saveStepUp: 'Destek ayarlarını değiştir',
    saved: 'Destek ayarları kaydedildi.',
    ownerOnly: 'Bu ayarları yalnızca sahip değiştirebilir.',
    updated: (p: { at: string; by: string }) => `Son değişiklik ${p.at} · ${p.by}`,
  },
  card: {
    label: 'Destek raporu',
    kind: 'Destek raporu',
    recipient: 'Alıcı',
    sections: 'Bölümler',
    hours: 'Kayıt aralığı',
    ccMe: 'Bana kopya',
    yes: 'evet',
    no: 'hayır',
    description: 'Açıklama',
    promptsWarning: 'İş istemleri de gönderilecek.',
    note: 'Onaylanınca maskelenmiş rapor oluşturulur ve e-postayla gönderilir. Önce Ayarlar → Tanılama’da önizleyip indirebilirsin.',
  },
};
