# Remyral: Sandbox (panelden durum, hazırlama, unconfined)

## Ne değişti?
Her makinede işlerin hangi korumayla (sandbox profili) çalışabileceği artık panelde görünüyor ve panelden hazırlanabiliyor.
Yer: Machines → makine → **Sandbox & policy**.

## Kartta ne var?
- Her profil: hazır / hazır değil, neden (kod), ne yapılmalı ve kim düzeltebilir:
  "Prepare çalıştır", "ayrıcalıklı yardımcıyla Prepare", "panel ayarı" ya da "makine sahibi gerekli".
- Profiller: container (Linux), runtime-sandbox, host-restricted (makinedeki özel hesap), unconfined (tam makine).
- Windows'ta host-restricted artık çalışıyor: iş, Windows Job Object içinde (bellek, süreç sayısı, CPU sınırı) başlar. Ek kurulum yok.

## Hazırlamak (Prepare)
1. Sandbox kartı → "Prepare" (authenticator kodu ister).
2. "Ayrıcalıklı yardımcıyı da çalıştır" işaretliyse, makinedeki SYSTEM/root güncelleyicisi sabit adımları yapar
   (Windows: worker hesabı, job runner, klasör izinleri; Linux: Podman kurulumu; macOS: keychain ayarları).
3. Her adımın durumu kartta görünür. "needs the owner" yazan adımı yalnızca makine sahibi yapabilir; nedeni yanında yazar.
Not: Bu sürümden önce kurulan makinelerde ayrıcalıklı kısım için kurulum kitini bir kez yeniden çalıştırmak gerekir.

## Windows'ta paralel host işleri (iş başına hesap)
- Eskiden Windows'ta host-restricted işler sırayla çalışıyordu (aynı hesap = birbirinin klasörünü görebilir).
- Artık her paralel iş kendi Windows hesabıyla çalışır: `remyral-job-1`, `remyral-job-2`, … Her işin klasörü yalnızca
  o hesaba (ve worker'a) açık. Diğer işin klasörüne, worker'ın gizli dosyalarına ve şifrelere erişemez.
- Paralel çalışma, makinede bir **çapraz erişim testi** geçtikten sonra açılır (A hesabı B'nin klasörünü okuyamıyor
  mu, yazamıyor mu?). Test geçmezse eskisi gibi sırayla çalışır ve kart nedenini yazar.
- Açmak için (makine başına bir kez):
  1. Worker'ı bu sürüme güncelle.
  2. Kurulum kitini makinede **bir kez Yönetici olarak** yeniden çalıştır (ayrıcalıklı yardımcı güncellenir).
  3. Sandbox kartı → **Prepare** ("ayrıcalıklı yardımcı" işaretli). Hesaplar oluşur, worker bir kez yeniden başlar ve
     testi kendisi çalıştırır.
  4. Kartta "Per-job Windows accounts: ok" ve host-restricted altında "Parallel: up to N" görünür.
- Hesaplar: masaüstü/uzak masaüstü/ağ girişi kapalı, oturum açma ekranında görünmez, şifreler her ayrıcalıklı
  Prepare'de yenilenir ve yalnızca makinenin kendi şifrelemesiyle (DPAPI) saklanır.
- Kapatmak: makinedeki config.json'a `"sandbox": { "windowsJobSlots": 0 }` → worker yeniden başlayınca yine sırayla.
- Hala ortak olanlar: aynı makinedeki portlar (localhost), süreç listesi.
- **Abonelik girişi (local-login) olan işler sırayla çalışır**: iki Claude Code işi aynı
  abonelik girişini aynı anda yenilemeye çalışınca ikisi de "another Claude Code process is refreshing it" hatasıyla
  düştü ve giriş bozuldu. Artık:
  - Abonelik girişli iş iş-başına hesapta değil, worker hesabıyla ve **tek başına** çalışır; diğer işler o bitene
    kadar kuyrukta bekler (iş reddedilmez, bekletilir).
  - API anahtarlı (secret-ref) işler eskisi gibi paralel, her biri kendi hesabında ve kendi HOME klasöründe.
  - İş-başına hesapların giriş klasörüne (`.claude`, `.claude.json`, `.codex`) hiçbir erişimi yok; worker her
    açılışta ve Prepare'de eski izni siler, silemezse paralel çalışmayı açmaz (`job_slots_login_shared`).
  - Kartta: "Parallel: up to 3 for API-key runtimes; subscription logins run one at a time".
  - Bu hata görülürse (Uzak işlemler kartında "Two Claude Code runs refreshed the shared subscription login at the
    same time") giriş muhtemelen kullanılamaz durumdadır: **Log in again** ile yeniden giriş yap.
- **Alt işler:** "tek başına" kuralı daraldı (yeni worker sürümüyle):
  - Sıra **giriş deposu başına**: Claude Code (`.claude`) ve Codex (`.codex`) ayrı depolar. İki Claude Code
    abonelik işi yine sırayla; bir Claude Code ve bir Codex işi depo açısından yan yana çalışabilir.
  - Ama abonelik işi worker hesabıyla çalıştığı için (klasör ayrımı yok) yalnızca **kendi ailesiyle** yan yana
    çalışır: ana iş ve onun alt işleri (aynı proje, aynı kullanıcı). Birbirinden bağımsız iki iş eskisi gibi sırayla.
  - Kalan risk (kabul edildi): aynı ailedeki işler birbirinin dosyalarını o sırada görebilir/değiştirebilir — zaten
    birbirine görev metni, girdi ve sonuç veriyorlar. Unconfined iş hiçbir zaman paylaşmaz.
  - Ayrıntı: `docs/design/p9-subjob-local-login.md`, ADR-0034 ek 2.
- macOS zaten paraleldi. Linux'ta host işleri hala sırayla (paralel için container profili).
- Not: Gerçek makinede henüz doğrulanmadı (UNVERIFIED); sürümden sonra Claude panelden Prepare + paralel iş testiyle
  doğrulayacak.

## Unconfined (tam makine) modu
- İş, worker'ın servis hesabıyla, dosya ve ağ kısıtlaması olmadan çalışır. Süre ve kaynak limitleri yine geçerli.
- Açmak için ikisi de gerekli:
  1. Machines → makine → Sandbox & policy → "Allow unconfined…" (uyarıyı oku, taze authenticator kodu; sahiplere bildirim gider).
  2. Projects → proje → Execution policy → "Unconfined".
- İşte sandbox olarak "unconfined" seç. Güvenilmeyen kaynak (fork PR vb.) asla unconfined çalışmaz.
- Bir makinede tamamen yasaklamak: makinedeki config.json'a "localCeiling": { "allowUnconfined": false }.

## Giriş yapınca otomatik ayar
Machines → makine → Runtimes'tan Claude Code / Codex'e giriş yapınca, o runtime için ayar yoksa panel otomatik "local-login" ayarlar.
Artık "no login or credential is configured" hatası çıkmaz.

## Hata görürsen
- "job_runner_selftest_failed": makinede PowerShell Add-Type engelli (kurumsal politika). Makine sahibi izin vermeli.
- "helper_unavailable": kurulum kitini makinede bir kez yeniden çalıştır.
- İş yerleşmiyorsa: Composer'daki "Open the Sandbox card" bağlantısı doğrudan ilgili makinenin kartını açar.
