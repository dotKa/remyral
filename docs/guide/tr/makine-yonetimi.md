# Remyral: Makine yönetimi (AI ile yönetici yetkisi)

## Ne değişti?
Seçtiğin makinede AI ajanı **yönetici (SYSTEM / root) yetkisiyle** komut çalıştırabilir: program kurmak, servis
ayarlamak, sistem dosyası düzenlemek gibi. Varsayılan olarak her makinede kapalıdır. Yalnızca **owner** açabilir.
Her açma taze authenticator kodu ister, denetim kaydına yazılır ve sana kritik bildirim gider.
Makinenin kendi yerel sınırı (`localCeiling.allowMachineAdmin`) ise varsayılan olarak izin verir: panel açınca makine
kabul eder. Bir makinede hiç istemiyorsan kurulumu `--no-machine-admin` (Windows: `-NoMachineAdmin`) ile çalıştır;
bu yerel yasak panelden kaldırılamaz (ayrıntı: docs/ops/machine-admin.md, "Trust model").

## Bir kere yapılacaklar (makine başına)
1. Worker'ı bu sürüme güncelle.
2. Kurulum kitini makinede **bir kez daha yönetici olarak çalıştır**. Yeni "yönetici tetikleyici" böyle kurulur:
   Windows'ta `RemyralWorkerAdmin` görevi, Linux'ta `remyral-worker-admin.path`, macOS'ta `com.remyral.worker.admin`.
3. Makinede Claude Code kurulu ve giriş yapılmış olmalı.
4. Machines → makine → **Admin → Machine admin** → "Enable machine administration…" → onayla (taze kod).
   Makineye otomatik olarak **Machines** projesi eklenir.

## Nasıl kullanılır?
- Machines → makine → Admin → Machine admin → **New machine task**, ya da chat'te "desktop-pc'ye Python kur". Asistan bir kart
  hazırlar, sen onaylarsın.
- Varsayılan modda **her yönetici komutu** Approvals'a düşer. Tam komutu görürsün ve onaylarsın.
- Komutun üstünde **"Amaç (ajanın açıklaması, doğrulanmadı)"** yazar: ajanın bu komutu neden şimdi istediği, tek
  cümle. Bu ajanın kendi sözüdür; kararı her zaman altındaki tam komuta bakarak ver. Eski makine yazılımı amaç
  göndermez, o zaman yalnızca komut görünür. Amaç komut kaydında (Makine → Yönetim → Son yetkili komutlar) da durur.
- "Ayrıcalıklı yardımcı" satırı artık gerçekten bakar: **Kullanılabilir** ya da **Kullanılamıyor — neden** (ör.
  Linux'ta `remyral-worker-admin.path` etkin değil, ya da makine yazılımının hesabı `state/machine-admin` klasörüne
  erişemiyor). Çözüm çoğu zaman kurulum kitini bir kez yönetici / root olarak yeniden çalıştırmaktır.
- Onaysız çalıştırmak için iki anahtarın ikisi de açık olmalı: makinede "Allow full access" **ve** Machines
  projesinde "Allow auto-approve".

## Araçlar (Tools)
- Machines → makine → **Tools**: tarayıcı, git, python, node, docker gibi bulunan araçları listeler.
- Tek tıkla kurulabilenler (yönetici yetkisi gerekmez, imzası/özeti kontrol edilir): tarayıcı (Playwright
  Chromium), Windows'ta Git ve Python.
- Linux'ta paket yöneticisi gerektirenler bir makine görevine dönüşür.
- **Inspect**: kurulu programlar, servisler, diskler. Salt okunurdur.

## Makine hafızası
- Ajan, makine hakkında öğrendiklerini not eder; her işin sonunda bir özet eklenir.
- Aynı makinedeki sonraki işler önce bunu okur.
- Machines → makine → Admin → Machine admin → **Memory**'den düzeltebilir veya silebilirsin.

## Chat'te yazılan skill'ler
- Sunucuda bir **panel skill anahtarı** (`SKILLS_PANEL_KEY_FILE`) oluşturulursa, asistan chat'te skill yazabilir
  veya iyileştirebilir.
- Kartta farkı (diff) görürsün; onaylarsan panel anahtarıyla imzalanır.
- Skills sayfası her sürümde imzalayanı gösterir: offline key ya da panel key. Bir skill **tüm projelere**
  atanabilir.
- Offline anahtar yedek olarak geçerli kalır.

## Riskler
- AI'nin okuduğu bir içerik (web sayfası, dosya) onu yanlış komuta yönlendirmeye çalışabilir. Anlamadığın komutu
  onaylama.
- Panel ele geçirilirse, bu özelliğin açık olduğu makineler risk altındadır. Yalnızca gerektiği sürece açık tut.

## Kapatmak
- Machines → makine → Admin → Machine admin → **Disable machine administration**.
- Makinede yerel yasak için config.json'a `"localCeiling": { "allowMachineAdmin": false }` yaz ve worker'ı yeniden
  başlat. Bu ayar panelden daha güçlüdür.

## Otomatik kapasite (paralel iş sayısı)
Her makinenin aynı anda kaç iş çalıştıracağını artık sistem de belirleyebilir. Makine → **Overview** →
**Capacity mode** kartından üç moddan birini seç (admin, taze authenticator kodu ister):

- **Manual** (varsayılan): ne ayarladıysan o çalışır. Hiçbir şey ölçülmez veya değişmez.
- **Suggest**: sistem makineyi ölçer ve bir değer önerir ("Suggested: 6 parallel jobs" ve nedeni). Sana bildirim
  gelir. Kendiliğinden hiçbir şey değişmez. **Apply** ile uygularsın.
- **Automatic**: senin verdiğin sınırlar içinde (ör. 1–10) master değeri kendisi ayarlar. Her seferinde bir
  adım artırır veya azaltır.

Nasıl karar verir?
- **Hemen azaltır**: bellek azaldığında, swap / page file kullanımı arttığında, CPU dolduğunda, bir iş bellek
  yetmediği için çöktüğünde (OOM) veya işler üst üste zaman aşımına uğradığında.
- **Yavaş artırır**: yalnızca kuyrukta bu makineyi bekleyen iş varsa, bütün slotlar doluysa ve makine 5 dakika
  boyunca rahatsa. Son değişiklikten 10 dakika, son azaltmadan 30 dakika sonra.
- **Asla aşmaz**: senin maksimumunu, makinenin donanım tavanını (CPU ve iş başına bellek) ve makinedeki yerel
  sınırı.
- Çalışan işler hiçbir zaman durdurulmaz. Daha düşük değer yalnızca "daha az yeni iş" demektir.
- Elle değiştirmek her zaman kazanır. Configuration'dan veya Apply ile paralel iş sayısını değiştirirsen otomatik
  mod kapanır ve **Manual**'a geçer.

Her değişiklik denetim kaydına yazılır. Kartta **geçmiş grafiği** ve nedenleri yazıyla görünür. Machines
listesinde "4 · auto 1–10" gibi gösterilir.

Örnek (Windows makinesi, 4 CPU, 8 GB, iş başına ~1,2 GB): donanım tavanı 5'tir. Sınırı 1–10 yapsan da en fazla
5'e çıkar. Bellek yetmezse 4'te kalır.

Gerekenler:
- Otomatik mod için makinenin yapılandırması panelden yönetiliyor olmalı (Configuration → devral). Suggest modu
  her makinede çalışır.
- Canlı ölçümler (Windows'ta CPU, macOS'ta kullanılabilir bellek, swap, bellek baskısı) için **worker'ı bu sürüme
  güncelle**. Eski worker'da otomatik mod yalnızca azaltır, hiç artırmaz. Kart bunu uyarı olarak gösterir.
- Windows'taki ölçüm henüz gerçek bir Windows makinesinde doğrulanmadı. Güncellemeden sonra kartta CPU ve
  "commit" değerlerinin göründüğünü kontrol et.

## Araçlar ve sürümler

Ne değişti?
- **Makine → Araçlar** artık önce **Etkin** satırlarını gösterir: işlerin gerçekten hangi kurulumu kullandığı. Örnek:
  "git — Etkin: worker’ın kurduğu 2.56.0.2 · sistemde bulunamadı". Aynı araç iki kez görünüyorsa hangisinin
  kullanılmadığı yazar ("sistemdeki 2.40 kullanılmıyor").
- Altında iki sekme var: **Sistem** (makinenin PATH'inde / işletim sisteminde bulunanlar) ve **Worker’ın
  kurdukları** (worker'ın kendi klasörüne kurdukları; özel araçlar "özel" etiketli). Süzgeç: bulundu / bulunamadı /
  güncelleme var.
- Her araç ve runtime için (Claude Code, Codex, Pi, OpenCode, git, Python, Node, uv, Playwright Chromium,
  cloudflared, ffmpeg…) **kurulu sürüm · pin · en son sürüm** ve bir durum etiketi: **güncel**, **güncelleme var**,
  **pin’den farklı**, **bulunamadı**. "En son sürüm"ü master 6 saatte bir resmi kaynaktan okur (npm, GitHub
  sürümleri, python.org paketi, nodejs.org). Okuyamazsa **kontrol edilemedi** yazar.
- Yeni ekran: **Makineler → Araçlar ve sürümler**. Bütün makineler × bütün araçlar tek tabloda. Buradan:
  - Seçili veya tüm makinelerde bir aracı / runtime'ı **güncelle, kur, kaldır** (Toplu işlem).
  - Runtime'larda varsayılan **önce kanarya makineler**: kanarya başarılı olunca "Tümüne devam et" dersin.
  - Çevrimdışı makineler işi **sırada** tutar, geri gelince alır. Süre (varsayılan 24 saat) dolarsa "süresi doldu"
    olur; "Başarısızları yeniden dene" ile tekrar denenir.
  - **Özel araç** tanımla: ad, sürüm, işletim sistemine göre indirme adresi (yalnızca izinli siteler, ör.
    github.com) + **SHA-256** + boyut, ya da paket yöneticisi (winget / brew / apt / dnf / npm -g / pipx) ve sürüm
    kontrol komutu.
- Haftalık özet: pazartesi sabahı "N güncelleme" bildirimi (sahipler ve yöneticiler). Ekrandan kapatılabilir.
  Makineler ve Ana sayfada "N güncelleme" rozeti görünür.

Bilmen gerekenler:
- Runtime sürümleri **worker sürümünün sabitlediği** (pin) sürümlerdir. Yeni bir Claude Code / Codex sürümü
  çıktıysa artık beklemen gerekmez: aşağıdaki "Runtime güncellemeleri" bölümüne bak (doğrulanmamış sürüm).
- Özel araç ve root / Yönetici gereken kurulumlar **makine yönetimi** sayılır: makinede makine yönetimi açık olmalı
  ve her seferinde yeni doğrulama kodu istenir. Paket yöneticisiyle kurulumda her yetkili komut onay bekler (tam
  erişim açık değilse).
- İndirilen özel araç worker'ın kendi klasörüne yetkisiz kurulur, SHA-256 tutmazsa kurulmaz ve PATH'in **sonuna**
  eklenir (sistemdeki aynı adlı aracı gölgelemez). Bir makinede bunu tamamen kapatmak için yerel yapılandırmada
  `localCeiling.allowCustomTools: false`.
- SHA-256'yı aracı yayınlayan kaynaktan al: github.com'da herkes dosya yayınlayabilir, güven sağlama toplamından
  gelir.

Gerekenler: güncel bir **worker sürümü** (özel araçlar, "Etkin" bilgisi ve sistem / worker
ayrımı düzeltmesi için). Eski worker'da tablo yine çalışır; özel araç kurulamaz ("Worker güncellenmeli").

## Runtime güncellemeleri — doğrulanmamış sürüm

Sorun neydi? Kaynakta yeni bir sürüm vardı (ör. Codex 0.164.0, pin 0.162.1), ekran "9 güncelleme" diyordu ama
tıklayınca hiçbir şey olmuyordu (sunucu 409 `nothing_to_do` dönüyordu, ekran bunu yutuyordu).

Şimdi:
- **Ayarlar → Güvenlik → Filo → "Doğrulanmamış runtime güncellemeleri"** — varsayılan **açık** (her hazır ayarda).
  Açıkken pin'den yeni bir sürüm kurulabilir; kapalıyken eskisi gibi yalnızca pin'ler.
- **Araçlar ve sürümler** tablosu: hücrede "Doğrulanmamış olarak kurulabilir: 0.164.0". Sayaç ikiye ayrılır:
  "N güncelleme · K kurulabilir · M makine yazılımı sürümü gerektirir".
- **Toplu işlem** → runtime seç → **"Pin dışındaki yeni sürümü doğrulanmamış olarak kur"** kutusu. Varsayılan
  yayılım **önce kanarya**; kanarya başarılıysa "Tümüne devam et".
- **Makine → Runtime’lar**: "Doğrulanmamış olarak kur (0.164.0)" düğmesi (önce soru, sonra doğrulama kodu). Kurulu
  olan pin dışıysa rozet **"Doğrulanmamış sürüm (pin: 0.162.1)"** ve **"Pin’e geri dön (0.162.1)"** düğmesi.
- Bir makine almazsa nedeni Türkçe yazar: "Bu sürüm bu makine yazılımı sürümünde sabit değil; doğrulanmamış olarak
  kurulabilir", "Makine yazılımı güncellenmeli", "Zaten bu sürüm kurulu", "Makine işlem alamaz", "Güvenlik
  politikası pin dışı runtime sürümlerine izin vermiyor"…
- Sohbette: "codex'i tüm makinelerde en yeni sürüme güncelle" → asistan **Runtime güncellemesi** kartı hazırlar,
  "doğrulanmamış" ve pin'i söyler; geri dönüş için "pin'e geri dön" de.

Nasıl kuruluyor (güvenlik):
- Master, resmi npm paketinin **tam o sürümünü** okur (asla `latest`), kayıt defterinin **sha512** değerini imzalı
  komuta koyar. Makine her paketi açmadan önce sha512 ile denetler; kurulum betikleri çalışmaz; makine yazılımının
  kendi klasörüne, yetkisiz kurulur. İlk makinenin çıkardığı bağımlılık kilidi diğer makinelere aynen gönderilir.
- Kurulumdan sonra runtime'ın kendi `--version` çıktısı istenen sürüm değilse kurulum geri alınır.
- Yetenekler (onay, iptal, akış) **doğrulanmamış** görünür; işler yine çalışır. Pin'e dönüş tek adım, indirme yok.

Otomatik doğrulama ("Doğrulama adayları" paneli):
- Master her gün ve kaynakta yeni sürüm görünce, bu sürümü **bir kanarya makinede** geçici klasöre kurup denetler:
  bütünlük, sürüm komutu, (Claude Code) paketteki CLI sürümü, yardım komutu / OpenCode'da yerel parola denetimi,
  adaptör yoklaması. Hepsi geçerse **"doğrulanmış aday"** olur.
- **Otomatik olmayanlar** dürüstçe "otomatik değil" yazar: gerçek bir model istemi (kimlik bilgisi ve token ister)
  ve sözleşme test takımı. Yani "doğrulanmış aday" = otomatik adımlar geçti, tam doğrulama değil.
- Kanarya makine yoksa doğrulama çalışmaz: bir makineyi Makine → Runtime’lar → politika'dan kanarya yap.
- Pin'i kalıcı yükseltmek: panelden **Kilit dosyası**'nı indir, sonra
  `node scripts/release/promote-runtime-pin.mjs --runtime codex --version 0.164.0 --lock <dosya> --write`, ekrandaki
  el adımlarını yap ve yeni bir **worker sürümü** çıkar. O zaman "doğrulanmamış" etiketi kalkar.

Gerekenler: güncel bir **worker sürümü** (`runtime-unverified-v1`). Eski worker'da hücre
"Makine yazılımı güncellenmeli" der. Windows'ta makine yazılımının Node'unun yanında npm yoksa "Bu makine pin dışı
sürüm kuramıyor" der.
