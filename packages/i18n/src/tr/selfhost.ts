/**
 * p16-selfhost-onboarding (ADR-0063): ilk sahip hesabı (`/setup`, kurulum anahtarı), sahiplerin kurulum sihirbazı
 * (`/onboarding`), boş ekranlardaki sihirbaz ipucu ve "Güncelleme mevcut" bandı.
 */
export default {
  setup: {
    step: 'İlk kurulum',
    title: 'Sahip hesabını oluştur',
    description:
      'Kurulum sırasında sunucuda bir kez gösterilen tek kullanımlık kurulum anahtarını gir. Bu hesap Remyral’ın sahibi olur.',
    token: 'Kurulum anahtarı',
    tokenHint: 'rst_ ile başlar. Kaybettiysen sunucuda remyral-ctl setup-token yenisini verir.',
    tokenRequired: 'Kurulum anahtarını gir.',
    username: 'Kullanıcı adı',
    usernameHint: '3–32 karakter: küçük harfle başlar; küçük harf, rakam, nokta, alt çizgi, tire.',
    usernameRequired: 'Bir kullanıcı adı seç.',
    password: 'Parola',
    passwordHint: (p: { min: number }) =>
      `En az ${String(p.min)} karakter; parola yöneticinden uzun bir parola kullan.`,
    confirm: 'Parola (tekrar)',
    tooShort: (p: { min: number }) => `En az ${String(p.min)} karakter kullan.`,
    mismatch: 'Parolalar aynı değil.',
    submit: 'Sahip hesabını oluştur',
    busy: 'Oluşturuluyor…',
    doneTitle: 'Hesap hazır',
    doneText: (p: { username: string }) =>
      `${p.username} oluşturuldu. Şimdi giriş yap: ilk girişte authenticator uygulamasını bağlayacak ve kurtarma kodlarını saklayacaksın.`,
    signIn: 'Giriş yap',
    loginLink: 'İlk kurulum: sahip hesabını oluştur',
    alreadyDone: 'Bu kurulumun sahibi zaten var; giriş yap.',
  },
  wizard: {
    title: 'Kurulum sihirbazı',
    purpose:
      'Yeni kurulumu birkaç adımda kullanıma hazırla. İstediğin adımı atlayabilir, sonra devam edebilirsin.',
    progress: (p: { done: number; total: number }) => `${String(p.done)}/${String(p.total)} adım`,
    stepsLabel: 'Adımlar',
    loading: 'Kurulum durumu yükleniyor…',
    what: 'kurulum durumu',
    back: 'Geri',
    next: 'Devam',
    skip: 'Bu adımı atla',
    markDone: 'Tamamlandı say',
    undo: 'İşareti kaldır',
    finished: 'Kurulum tamamlandı. Sihirbaz artık gösterilmiyor.',
    reopen: 'Sihirbazı yeniden aç',
    state: { todo: 'Yapılacak', done: 'Tamam', skipped: 'Atlandı', detected: 'Algılandı' },
    steps: {
      account: {
        title: 'Hesap ve doğrulama',
        body: 'Sahip hesabın ve authenticator uygulaman hazır. Kurtarma kodlarını telefondan başka bir yerde (parola yöneticisi ya da kasadaki kağıt) sakladığından emin ol.',
        link: 'Hesap ayarları',
      },
      about_you: {
        title: 'Seni tanıyalım',
        body: 'İstersen kendi yapay zeka asistanının (Claude, ChatGPT, Gemini…) seninle ilgili bildiklerini şimdi içe aktar; ajanlar senin tercihlerin ve kurallarınla başlar. İsteğe bağlıdır; atlayıp sonra Ayarlar → Profil → İçe aktar bölümünden de yapabilirsin.',
        later: 'Sonra Ayarlar → Profil → İçe aktar bölümünden yapabilirsin.',
      },
      organisation: {
        title: 'Organizasyon adı',
        body: 'Ekranlarda ve bildirimlerde görünecek ad.',
        label: 'Organizasyon adı',
        placeholder: 'ör. Acme Yazılım',
        save: 'Kaydet',
        saved: 'Kaydedildi.',
      },
      domain: {
        title: 'Alan adı ve erişim',
        body: 'Konsolun internetteki adresi. Bildirim e-postalarındaki bağlantılar, makine kurulum komutları, GitHub bağlantısı ve webhook bağlantıları bu adresi kullanır. Alan adını burada yazıp kaydedebilirsin; terminale gerek yok.',
        loading: 'Yükleniyor…',
        origin: 'Genel adres',
        originMissing:
          'Ayarlı değil. Aşağıya alan adını yazıp kaydet; bildirim bağlantıları ve makine kurulum komutları bu adresle oluşturulur.',
        source: 'Nereden geliyor',
        sourceSetting: 'Kurulum sihirbazında kaydedildi',
        sourceHost: 'Sunucu yeni adı uyguladı',
        sourceEnvironment: 'Sunucu ortamından (PUBLIC_ORIGIN)',
        tls: 'TLS sertifikası',
        tlsValid: (p: { until: string; days: number }) =>
          `Geçerli, ${p.until} tarihine kadar (${String(p.days)} gün)`,
        tlsExpired: (p: { until: string }) => `Süresi ${p.until} tarihinde doldu`,
        tlsError: (p: { detail: string }) => `Denetlenemedi: ${p.detail}`,
        tlsUnknown: 'Henüz denetlenmedi',
        tlsNone: 'Genel adres ayarlı olmadığı için denetlenmiyor',
        tlsNotPublic:
          'Sunulan sertifika herkesçe güvenilen bir sertifika değil (ör. kendinden imzalı ya da vekil sunucunun varsayılanı). Tarayıcılar ve makineler uyarı verebilir.',
        reach: 'Konsola erişim',
        reachHere: 'Konsolu şu an bu adresten açıyorsun; erişim çalışıyor.',
        reachOther: (p: { here: string }) =>
          `Konsolu şu an ${p.here} adresinden açıyorsun. Genel adresi yeni sekmede açıp erişimi dene.`,
        check: 'Sertifikayı şimdi denetle',
        open: 'Genel adresi aç',
        keys: 'Anahtarlar ve süreler',
        formTitle: 'Alan adını ayarla',
        domain: 'Alan adı',
        domainHint: 'https:// ve yol olmadan, yalnızca ad. Örnek: konsol.sirketin.example',
        placeholder: 'konsol.sirketin.example',
        domainInvalid: 'Geçerli bir alan adı yaz (ör. konsol.sirketin.example).',
        tlsMode: 'Sertifika ve bağlantı',
        tlsModes: {
          letsencrypt: {
            title: 'Let’s Encrypt',
            body: 'Bu sunucu 80 ve 443 portlarında doğrudan cevap verir; sertifikayı Let’s Encrypt verir. DNS kaydı doğrudan bu sunucuyu göstermeli.',
          },
          cloudflare: {
            title: 'Cloudflare arkasında',
            body: 'DNS kaydı Cloudflare’de proxy açık (turuncu bulut); Cloudflare’in SSL modu “Full”.',
          },
          proxy: {
            title: 'Kendi vekil sunucum',
            body: 'TLS’i senin ters vekil sunucun (ör. nginx, yük dengeleyici) sonlandırır ve bu sunucuya iletir.',
          },
        },
        email: 'Let’s Encrypt e-postası',
        emailHint: 'Sertifika süresi uyarıları bu adrese gelir.',
        dnsTitle: 'DNS bu sunucuyu gösteriyor mu?',
        dnsCheck: 'DNS’i denetle',
        dnsChecking: 'Denetleniyor…',
        dnsMatch: (p: { addresses: string }) => `Evet: ad bu sunucuyu gösteriyor (${p.addresses}).`,
        dnsCloudflare: (p: { addresses: string }) =>
          `Ad Cloudflare üzerinden yayınlanıyor (${p.addresses}). Cloudflare’deki kaydın bu sunucuyu gösterdiğinden emin ol; sunucu Cloudflare’in arkasını buradan göremez.`,
        dnsMismatch: (p: { addresses: string; expected: string }) =>
          `Hayır: ad ${p.addresses} adresini gösteriyor, bu sunucunun bilinen adresi ise ${p.expected}. Alan adı sağlayıcında A (ya da AAAA) kaydını bu sunucunun adresine çevir; yayılması birkaç dakika sürebilir.`,
        dnsNotFound:
          'Bu ad için DNS kaydı yok. Alan adı sağlayıcında bu sunucuyu gösteren bir A (ya da AAAA) kaydı ekle, birkaç dakika sonra yeniden denetle.',
        dnsUnknown: (p: { addresses: string }) =>
          `Ad ${p.addresses} adresini gösteriyor; karşılaştıracak bir sunucu adresi bilinmiyor. Bu adresin bu sunucu olduğundan emin ol.`,
        dnsError: (p: { detail: string }) =>
          `DNS sorgusu başarısız oldu (${p.detail}). Biraz sonra yeniden dene.`,
        managed:
          'Bu sunucu remyral-ctl ile kuruldu: kaydedince sunucu yeni adı kendisi uygular (vekil sunucu ayarı, sertifika, yeniden başlatma). Yeni ad sağlıklı olana kadar eski adres çalışmaya devam eder; olmazsa eski ada kendiliğinden geri dönülür.',
        unmanaged:
          'Bu kurulumda trafiği başka bir platform yönlendiriyor (ör. Coolify ya da kendi vekil sunucun). Kaydetmek, bağlantıların kullandığı adresi hemen değiştirir; yönlendirmeyi o platformun yöneticisi yapar.',
        route: (p: { origin: string }) =>
          `Platformda yönlendirilmesi gereken: ${p.origin} bu konsola gelmeli (web arayüzü, API, makine bağlantıları ve webhook yolları) ve TLS sertifikası bu ad için geçerli olmalı.`,
        save: 'Kaydet',
        saveApply: 'Kaydet ve uygula',
        saving: 'Kaydediliyor…',
        saved: (p: { origin: string }) => `Kaydedildi: bağlantılar artık ${p.origin} adresini kullanıyor.`,
        stepUpReason: 'Konsolun alan adını değiştirmek',
        clear: 'Sunucu ortamındaki adrese dön',
        cleared: 'Kaydedilen adres silindi; sunucu ortamındaki adres kullanılıyor.',
        request: {
          pending: (p: { domain: string }) =>
            `${p.domain} sunucuya iletildi, sıra bekliyor… (en geç bir dakika)`,
          applying: (p: { domain: string }) =>
            `Uygulanıyor… ${p.domain} için vekil sunucu ayarlanıyor, sertifika alınıyor ve sağlık denetleniyor; birkaç dakika sürebilir. Bu sırada konsol kısa bir an yeniden başlayabilir.`,
          applied: (p: { domain: string }) => `Hazır: konsol artık ${p.domain} adresinde.`,
          rolled_back: (p: { detail: string }) => `Hata: ${p.detail}. Eski adrese geri dönüldü.`,
          failed: (p: { detail: string }) => `Hata: ${p.detail}`,
          refused: (p: { detail: string }) => `Sunucu isteği reddetti: ${p.detail}`,
          expired:
            'Sunucu isteği zamanında almadı. Sunucudaki remyral-ctl uygulayıcısı çalışmıyor olabilir (remyral-ctl status).',
          cancelled: 'İstek geri çekildi.',
        },
        goNew: 'Yeni adrese geç',
        cancel: 'Vazgeç',
      },
      security: {
        title: 'Güvenlik ayarı',
        body: 'Ne zaman authenticator kodu isteneceğini ve ajanların ne kadar serbest çalışacağını seç. Yeni kurulum Dengeli ile başlar. Serbest, güvenlik çekirdeği dışındaki her şeyde (makine yönetimi, sandbox’ı kaldırmak, üretim deploy’u, kimlik bilgileri) kodu kaldırır; yalnız tek kişilik, kapalı bir kurulumda seç. Sonra Ayarlar → Güvenlik’ten tek tek değiştirebilirsin.',
        apply: 'Bu ayarı seç',
        current: 'Şu an seçili',
        applied: (p: { name: string }) => `${p.name} uygulandı.`,
        more: 'Güvenlik ayarlarının tamamı',
      },
      machine: {
        title: 'İlk makine',
        body: 'Ajanlar senin makinelerinde çalışır; sunucu yalnızca yönetir. Makinede bir terminal aç ve sistemine uyan komutu çalıştır. Makine bağlanınca eşleştirme isteği Makineler’de görünür; kodu onayla.',
        os: { linux: 'Linux', macos: 'macOS', windows: 'Windows' },
        download: 'İndir',
        run: 'Çalıştır',
        noRelease:
          'Henüz bir makine sürümü yüklenmemiş, bu yüzden kurulum komutu yok. Ayarlar → Sürümler’den imzalı bir makine sürümü yükle.',
        open: 'Makine ekle ekranı',
        waiting: 'Onaylanmış bir makine bekleniyor…',
      },
      git: {
        title: 'Git bağlantısı',
        body: 'İşler depoyu buradan çeker ve değişiklikleri buraya önerir. GitHub, GitLab ya da Bitbucket’tan birini bağla; jetonlar sunucuda şifreli kalır, ajanlara verilmez.',
        github: 'GitHub bağla',
        gitlab: 'GitLab bağla',
        bitbucket: 'Bitbucket bağla',
      },
      integrations: {
        title: 'İsteğe bağlı entegrasyonlar',
        body: 'Deploy için Coolify, siteler ve DNS için Cloudflare, e-posta bildirimleri için SMTP. Hiçbiri zorunlu değil; şimdi atlayıp sonra ekleyebilirsin.',
        coolify: 'Coolify',
        cloudflare: 'Cloudflare',
        smtp: 'E-posta (SMTP)',
      },
      project: {
        title: 'İlk proje',
        body: 'Proje bir depoyu, kurallarını ve hafızasını bir arada tutar. Bir proje oluştur ve deposunu seç.',
        open: 'Projeler',
      },
      sample_job: {
        title: 'Örnek iş: README özetle',
        body: 'Her şeyin uçtan uca çalıştığını görmek için küçük bir iş başlat: ajan deponun README dosyasını okuyup özetler, hiçbir şeyi değiştirmez.',
        prompt: 'Bu deponun README dosyasını oku ve projeyi beş maddede özetle. Hiçbir dosyayı değiştirme.',
        start: 'Örnek işi hazırla',
        waiting: 'Başarıyla biten bir iş bekleniyor…',
        jobs: 'İşler',
      },
      done: {
        title: 'Hazırsın',
        body: 'Kurulum tamam. Buradan sonra işleri Sohbet’ten iste ya da İşler’den başlat.',
        chat: 'Sohbet',
        jobs: 'İşler',
        machines: 'Makineler',
        settings: 'Ayarlar',
        finish: 'Sihirbazı bitir',
      },
    },
  },
  nudge: {
    title: 'Kurulumu tamamla',
    text: (p: { done: number; total: number }) =>
      `Kurulum sihirbazında ${String(p.done)}/${String(p.total)} adım tamam.`,
    open: 'Sihirbazı aç',
    empty: 'Kurulum sihirbazı bu adımda yol gösterir.',
  },
  update: {
    banner: (p: { version: string }) => `Güncelleme mevcut: Remyral ${p.version}`,
    notes: 'Notlar',
    updateNow: 'Şimdi güncelle',
    dismiss: 'Bu sürüm için gizle',
    dialogTitle: (p: { version: string }) => `Remyral ${p.version}`,
    current: (p: { version: string }) => `Kurulu sürüm: ${p.version}`,
    machineFloor: (p: { version: string }) =>
      `Makineler en az ${p.version} makine sürümünü ister; kendilerini günceller.`,
    breaking: 'Uyumsuz değişiklikler',
    command: 'Güncelleme sunucuda çalışır',
    commandHint:
      'Sunucu remyral-ctl ile kuruluysa “Şimdi güncelle” bunu sunucuya yaptırır; değilse sunucuya bağlanıp bu komutu çalıştır. Önce yedek alınır; sağlık kontrolü geçmezse eski sürüme dönülür.',
    close: 'Kapat',
  },
};
