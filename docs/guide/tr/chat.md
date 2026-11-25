# Remyral: Chat (ops sohbeti)

## Ne bu?
ChatGPT gibi sohbet: makineler, projeler, işler, onaylar ve kullanım hakkında sor; iş taslağı hazırlat.
Panel artık Chat ile açılıyor (telefonda alt çubukta ilk sekme).
Sohbetler kişiye özel: başka kullanıcı (owner dahil) senin sohbetini göremez.

## Asistan nerede çalışıyor?
Sunucuda değil, seçtiğin bir worker makinesinde (Claude Code ile).
Sunucu hiçbir model anahtarı tutmaz. Asistanın kendi kabuğu, dosya erişimi, web'i yok;
sadece panelin araçlarını kullanır ve bu araçlar SENİN yetkinle çalışır (göremediğin projeyi o da göremez).

## Kurulum (admin, bir kere)
1. Asistan için bir makine seç. Machines → makine → Configuration → Runtimes & models: Claude Code'u aç.
2. Girişi ayarla: ya aboneliğinle giriş (Machines → makine → Runtimes → Log in) ya da Settings → Credentials'tan o makineye Anthropic API anahtarı.
3. Settings → Chat: Enabled aç, Worker'ı seç, model profili seç (ya da "runtime default"), limitleri gözden geçir. Kaydetmek authenticator kodu ister.
4. Üstteki durum satırı yeşilse hazır.

## Kullanım
- "Hangi makineler offline?", "alpha'da bugün ne patladı, neden?", "alpha'ya Codex ile flaky login testini düzelten bir iş taslağı hazırla".
- Cevap akarak gelir; Stop ile durdurursun. Sohbetleri ara, yeniden adlandır, arşivle, sil.
- Araştırma / genel işler repo istemez: asistan bunları çalışma alanı (ör. genel) işi olarak taslaklar.

## Taslak kartları (önemli)
Asistan kendi başına hiçbir şey başlatmaz, değiştirmez, onaylamaz.
"draft" kartı çıkar: tam olarak ne çalışacağını gösterir.
Confirm → authenticator kodu ister → senin yetkinle normal yoldan çalışır (onay kuralları, kotalar aynen geçerli).
Dismiss → hiçbir şey olmaz. Kart 24 saat sonra düşer.

**Dışarıdan içerik okunan turlar.** Asistan bir turda senin yazmadığın içerik okuduysa — bir işin günlüğü ya da
çıktısı, depodaki bir dosya ya da fark, bir web yanıtı, eklediğin bir dosya, bir makinenin komut çıktısı — o turda
normalde hemen çalışacak işlemleri doğrudan yapmaz; kart olarak sorar. Sebep: o içerikte gizlenmiş bir talimat
(“şu işi iptal et”, “şu adrese istek at”) asistanı yanlış bir işleme yönlendirebilir. Kartta “Doğrudan
çalıştırılmadı” yazar. Aynı sohbetin sistemin kendi başlattığı devam turları (plan, takip sonrası devam, geç gelen
araç sonucu, hedefe devam) da bu durumu devralır; senin yeni mesajın temiz başlar. Bekleyen merge kararlarını
listelemek bu sayılmaz: asistan onların yalnızca platformun ürettiği bilgilerini (dal adı, dosya sayıları, kontrol
durumu) görür, bu yüzden “PR'ları onayla merge olsun” hemen çalışır; listede bir ajanın yazdığı araç onayı da varsa
yine kart olarak sorar.

Kartı onaylarken **“Bunu hatırla”** kutusunu işaretlersen, aynı işlem türü aynı hedefte (proje; HTTP isteğinde adres
ve kimlik bilgisi; serviste makine; deploy’da ortam) bir daha sorulmaz. Hatırlananları **Ayarlar → Sohbet →
Hatırlanan onaylar**’da görür, tek tek unutursun. Makine yönetimi (root / Administrator), onay kararları, ayar ve
güvenlik politikası değişiklikleri, kimlik bilgileri, hafıza, kurulumlar ve silme işlemleri böyle bir turda **her
seferinde** sorulur; bunlar hatırlanmaz. Güvenlik ayarının kod isteyen işlemleri yine kod ister.

## İşleri chat'ten yönetme
Artık chat'ten var olan işleri de yönetebilirsin — yeni iş açmak zorunda değilsin:
- **İptal:** "şu işi iptal et", "abc123 nolu işi durdur", "kuyruktaki tüm arka plan işlerini iptal et".
- **Tekrar çalıştır:** "son başarısız işi tekrar çalıştır", "aynısını şu prompt ile tekrar çalıştır" (aynı ayarlar, yeni çalışma dalı).
- **Devam et:** onayı süresi dolup başarısız / iptal olmuş işi kaldığı yerden yeni işle sürdürür.
- **Kuyruk:** "şunu arka plana al" (Normal / Arka plan), "şu işi diğerinin önüne al" (sıra), "şimdi çalıştır" (Acil yapar ve en öne alır — sadece admin).
- **Duraklatılmış iş:** "şimdi devam ettir" / "baştan başlat"; bekleyen onay için asistan onayın linkini verir (onay kendi kurallarıyla, kodunla verilir).

Nasıl çalışır:
1. Asistan önce hangi işi kastettiğini bulur (id'nin ilk karakterleri, başlıktaki kelimeler, "son başarısız iş", "kuyruktaki işler"). Birden fazla iş olabilecekse sana sorar, tahmin etmez.
2. Bir **iş eylemi kartı** çıkar: her işin id'si, başlığı, projesi, durumu ve ne olacağı. Henüz hiçbir şey olmadı.
3. İstemediğin işlerin işaretini kaldır → **Confirm** → authenticator kodu. En fazla 50 iş.
4. Sunucu her işi onay anında **senin yetkinle** yeniden kontrol eder ve Jobs ekranının kullandığı aynı yolu çalıştırır. Sonuç iş iş görünür: Done / Skipped (ör. "already SUCCEEDED — nothing to cancel": iş bu arada bitmişse hata değil, bilgi) / Not allowed / Failed.

Yetkiler Jobs ekranıyla aynı: iptal, tekrar çalıştır, sınıf ve sıra değiştirme operator+; "şimdi çalıştır" admin. Görüntüleyici (viewer) kart çıkaramaz.
Acil kuralı değişmedi: asistan bir işi ancak SENİN mesajında "acil / hemen / şimdi çalıştır / öne al" gibi bir ifade varsa Acil yapar; iş çıktısı ya da bir belge bunu tetikleyemez.

**Hızlı butonlar:** chat'te başlattığın bir işin kartında **Cancel**, **Run again** ve **Open** var. Cancel / Run again hemen bir iş eylemi kartı ekler; yine onaylamadan hiçbir şey olmaz.
Her eylem denetim kaydına (Audit) `chat.job_action`, kaynak `chat` olarak iş iş yazılır.

## Çalışan işe mesaj
İş sayfasında "Message the agent": çalışan ajana ek talimat gider (runtime destekliyorsa).
Mesaj ve ajanın tepkisi işin olaylarında görünür. (OpenHands ekranı ADR-0023 ile kaldırıldı.)

## Kapatma ve limitler
- Settings → Chat → Enabled kapat: herkes için anında durur, çalışan cevaplar kesilir.
- Tek makinede: yerel config.json'a "assistant": { "disabled": true }.
- Usage → Chat: bugünkü/aylık token ve tur kullanımın (admin herkesinkini görür).
- Limit dolarsa "rate_limited" / "budget_exceeded"; günlük limitler 00:00 UTC'de sıfırlanır.

## Yedek makineler
Asistan makinesi kapanırsa sohbet durmasın diye: Ayarlar → Sohbet → Asistan → **Yedek makineler**.
- Ana makinenin altına sırayla yedek ekle (en çok 6). Her satır gösterir: bağlı mı, sürüm, runtime hazır mı
  (giriş / anahtar), yedek motor var mı. "Şu an devralamaz" ise nedeni yazar. Kaydetmek kod ister.
- Her mesaj sıradaki ilk uygun makineye gider: önce ana makine (kendi yedek hesabı / yedek motoru dahil),
  olmazsa 1. yedek, 2. yedek… Geçmiş panelde durduğu için her makine aynı sohbete devam eder.
- Ana makine geri gelince **60 sn** kesintisiz bağlı kalırsa sohbet kendiliğinden ona döner (gidip gelmesin diye).
- Cevap verirken makine koparsa mesaj **bir kez** sıradaki makinede yeniden yanıtlanır. Ama asistan o cevapta
  bir şey yaptıysa (kart, iş, not…) tekrar etmez; "zaten işlem yaptı, kontrol et" der.
- Sohbette tek satır not çıkar: "build-01 bağlı değil; yanıt mac-studio'dan". Üst satır da hangi makinede olduğunu yazar.
- Yedeğe geçince ve geri dönünce owner/admin'e **bir** bildirim gelir (her mesajda değil).
- Ayarlar → Sohbet → **Yedek geçişi**: şu an kim cevap veriyor ve neden, makine sırası, son geçişler.
  Düğmeler: "Ana makineye dön" (beklemeden), bir makineyi süreli **sabitle** (15 dk – 24 sa), **otomatik geçişi kapat**.
  Hepsi kod ister ve denetim kaydına yazılır.
- Asistana sor: "sohbet hangi makinede?" → hangi makine, neden, yedekler.

## Düzenle, yeniden üret, tekrar dene, dışa aktar, paylaş, sesle yaz
- **Mesajı düzenle:** mesajının altındaki kalem. Düzenlenen mesaj yeniden yanıtlanır; ondan sonraki konuşma
  "N mesaj değiştirildi (önceki sürüm)" satırına katlanır (Göster ile açılır, asistan onu bir daha görmez). Ekler
  yeni mesaja geçer; açık kartlar kapanır.
- **Yeniden üret:** son yanıtın altında. Yanındaki işlemci simgesi **başka motor / modelle** üretir (asistan
  makinesinde hazır olan motorlar, model listesinden). Yanıtın altında "yeniden üretildi · codex · gpt-5" yazar.
- **Tekrar dene:** başarısız, kesilen ya da durdurulan son yanıtın hata satırında tek tık.
- **Güvenlik kuralı:** değiştirilecek yanıt zaten bir şey yaptıysa (kart, iş, not, ayar…) önce "Bu yanıt işlem
  yaptı" penceresi ne yaptığını gösterir; "Yine de devam et" demeden hiçbir şey tekrarlanmaz.
- **Panel yeniden başlarsa:** yarım kalan yanıt, işlem yapmadıysa **bir kez** kendiliğinden yeniden yanıtlanır
  ("Panel yeniden başlarken yanıt kesildi…" notu). İşlem yaptıysa sadece not düşer, Tekrar dene sende.
- **Dışa aktar:** sohbet menüsü → **Markdown indir** ya da **PDF olarak kaydet** (yazdırma sayfası açılır, tarayıcıda
  "PDF olarak kaydet"). Ekler (ad, tür, boyut), kartların son durumu ve linkleri dahil; token/anahtarlar `[REDACTED]`.
- **Paylaş:** menü → **Paylaş…** → kişiyi ara → Paylaş. O kişi sohbeti listesinin altında **Paylaşılanlar**'da salt
  okunur görür (yazamaz, kart onaylayamaz). Göremediği projenin kartında "erişimin yok" yazar; işler/linkler onun
  kendi yetkisiyle açılır. Okuyan **Paylaşımdan çık** ile ayrılabilir.
- **Devret:** menü → **Devret…** → yeni sahip. Açık kartlar kapanır, takipler durur; istersen okuma erişimin kalır.
  Paylaşma ve devretme denetim kaydına yazılır.
- **Sesle yaz:** mesaj kutusundaki mikrofon (Chrome, Edge, Safari; dil arayüz dilinden). Konuştukça yazı kutuya
  düşer, tekrar basınca durur. Ses panelimize gelmez; sesi tarayıcının kendi tanıma servisi işler (Chrome'da Google).
  Tarayıcı desteklemiyorsa düğme görünmez; mikrofon izni verilmezse söyler.
- **Asistan log ve diff okur:** "şu iş neden patladı?", "ne değiştirdi?" → asistan işin logunu (en yeni satırlar önce)
  ve diff'ini (dosya dosya) okuyup cevaplar; tahmin etmez. Sadece görebildiğin işler. Site zip'inin tüm dosya
  listesini de sayfa sayfa görür.
- Gerekli: master + web güncellemesi. Log/diff/dosya listesi araçları ve kural 37 için asistan
  makinesinde **worker güncellemesi** de gerekir.
- Küçükler: iş sayfasındaki İptal penceresi ve sohbette resmi büyütme artık Türkçe/İngilizce Diyalog penceresi; zip
  kartı varsayılan olarak sohbetin kendi projesini seçer.

## Sohbetten yönetim
Ekran açmadan yönetim: asistan konsolun aynı servislerini **senin yetkinle** çağırır.
- **Sor:** "kullanıcılar kim, son ne zaman girdiler?", "alpha projesinin üyeleri", "makineler hangi sürümde, güncelleme
  yüzde kaç?", "yedekler ne durumda?", "kasada hangi anahtarlar var?" (yalnızca ad/tür/durum — değer asla),
  "bildirim ayarlarım", "Coolify/Cloudflare/GitHub bağlantıları sağlam mı?", "kotalar ve bütçeler", "zamanlanmış işler",
  "önizleme linkleri", "açık PR'lar ve bekleyen merge kararları".
- **Yaptır:** "ayşe'yi operatör yap", "mehmet'i alpha'ya viewer olarak ekle", "makineyi onayla, kod ABCD-EFGH",
  "atlas'ın anahtarını yenile", "stable'ı %25'e çıkar" / "dağıtımı durdur" / "atlas'ı 1.0.70'e geri al",
  "job.failed e-postalarını kapat", "Cloudflare bağlantısını test et". Açık komutun hemen yapılır; güvenlik politikası kod
  istiyorsa kart kodu sorar.
- **Her zaman kart:** yeni kullanıcı daveti (geçici parola yalnızca kartta, bir kez görünür; sohbete yazılmaz) ve yıkıcı
  işlemler — hesabı devre dışı bırakmak, makinenin erişimini iptal etmek. Bunlar "Otomatik mod"da bile kartla onaylanır;
  Ayarlar → Güvenlik → Ajan özerkliği → **"Sohbet yıkıcı yönetim işlemlerini kartsız yapabilir"** açılırsa kartsız
  yapılır (varsayılan kapalı).
- **Sırlar sohbete girmez:** kasadaki bir anahtarın yeni değeri için asistan link verir; değeri o formda yazarsın,
  tarayıcın mühürler. Entegrasyona yeni token/anahtar Ayarlar → Entegrasyonlar'dan girilir.
- **Yedek almak / geri yüklemek sohbetten yapılmaz:** master yalnızca durumu okur; `remyral-backup run / drill / restore`
  sunucuda çalıştırılır (docs/ops/backup-restore.md).
- Kendi hesabını sohbetten değiştiremezsin. Her değişiklik denetim kaydına konsoldaki adıyla ve `source: chat` ile
  yazılır.
- Gerekli: master + web güncellemesi ve yeni araçlar ile kural 39 için asistan makinesinde **worker
  güncellemesi**.

## Hata görürsen
- "offline; chat is unavailable": asistan makinesi bağlı değil.
- "must be updated": worker'ı güncelle.
- "not ready": Claude Code açık değil / girişi yok / sürüm uymuyor.
- step_up_required: authenticator kodunu gir, kart açık kalır.

## Haber verme ("haber ver")
Asistan artık sana sonradan haber verebilir; "mesaj gönderemem" demez.
- "Bu iş bitince haber ver", "onay gerekince haber ver", "deploy olunca haber ver", "mac-mini offline olursa söyle",
  "nightly otomasyonu her çalıştığında haber ver" → asistan bir **izleme** kurar ve ne izlediğini, hangi durumda ve ne
  zamana kadar (varsayılan 7 gün, bir kere) söyler. Taslak kartı için de olur: kartı onaylayınca oluşan işi/deploy'u izler.
- Olunca: bu sohbete kısa bir not düşer (iş sayfası, Çıktılar, canlı adres linkiyle) ve zil (bildirim) çalar.
  E-posta / webhook sadece Settings → Notifications'ta "Chat: something you asked to watch" için açtıysan gelir.
- "Bunu bana e-posta olarak da gönder" → asistan özet yazıp sana not gönderir ("Chat: note sent to yourself";
  e-postası kapalıysa nereden açacağını söyler). Saatte en çok 10 not.
- "İzlemeleri göster" / "iptal et": asistan listeler veya durdurur. Sohbetin üstündeki **Watching** şeridinde de
  görürsün; × ile durdurursun.
- Sadece SANA haber verir: başka kişiye, adrese ya da URL'ye gönderemez (öyle bir alan yok). Göremediğin bir şeyi
  izleyemez; erişimin giderse izleme kendiliğinden durur.
- Gerekli: asistan makinesinde worker güncellemesi (yeni araçlar ve kural orada).

## Takip olunca bir şey çalıştırmak ve workflow bulmak
- "Bu iş bitince **whatsapp-mesaj-gonder** workflow'unu çalıştır" → asistan bir **Takip** kurar; koşul gerçekleşince
  workflow **kendiliğinden çalışır** (senin adınla, onay kartı yok). Sohbete "Koşul gerçekleşti; … çalıştırıldı" notu
  ve çalıştırmanın linki düşer, zil çalar. Workflow'un kendi onay adımları yine sorar.
- Onay **istemiyorsan** bir şey demene gerek yok. Önce görmek istersen "çalıştırmadan önce bana sor" de: o zaman kart
  hazırlanır, sen onaylarsın. Takipler panelinde her takip için "kendiliğinden çalışır" ya da "kart hazırlanır" yazar.
- Kural Ayarlar → Güvenlik'ten gelir: "asistan doğrudan uygulasın" kapalıysa ya da bu adım için doğrulama kodu
  isteniyorsa yine kart hazırlanır (kodu kartta girersin). Koşul gerçekleştiğinde yetkin kalmamışsa hiçbir şey çalışmaz,
  not nedenini söyler. Bir takip yalnızca bir kez çalıştırır.
- Asistan workflow'ları **adıyla bulur** (`list_workflows`, `describe_workflow`): UUID sormaz; gerekli girdileri,
  adımları, onay noktalarını ve son çalıştırmaları söyler. Sadece görebildiğin projelerin workflow'larını görür.
- Gerekli: master + web güncellemesi. Asistan makinesinde worker güncellemesi de gerekir: workflow'u adıyla bulma
  araçları ve asistanın doğru anlatması orada. Güncel olmayan (propose özelliği olan) worker'da da takip adımı
  kendiliğinden çalışır; çok eski worker'da eskisi gibi kart olur.

## Sohbetler bilgi birikimi olarak
- **Sohbet başlığının altındaki satır:** **Project: <proje>** (Link a project / Change; bağlı değilse önerilen proje
  "Link to <X> (suggested)"). Bağlıysa **"Shared with project <X> knowledge"** yazar ve **Share with project knowledge**
  kutusu çıkar: kaldırırsan bu sohbetin o projedeki kayıtları hemen silinir.
- **Arama:** soldaki "Search conversations" kutusuna 3+ harf yazınca başlıkların üstünde **Messages by meaning**
  (anlamına göre eşleşen mesajlar) çıkar; sağlayıcı yoksa ya da kapattıysan "by keywords (neden)" yazar. Sadece senin
  sohbetlerin.
- **İlgili bilgi:** her mesajda asistan, okuyabildiğin en ilgili birkaç şeyi (önceki sohbetlerin, projenin dokümanları,
  hafızası, iş özetleri, projeye eklenmiş sohbetler) veri olarak alır; cevabın altında **"Used N related items"**
  tıklanınca kaynakları gösterir.
- **Ayarların:** Settings → Chat → **My conversations** (her kullanıcı): *Index my conversations*, *Share
  project-related chat with project knowledge*, *Look up related knowledge on every message*. Kapatınca ilgili
  kayıtlar silinir. Asistan ayarları (worker, model, limitler) eskisi gibi sadece admin.
- **Hafıza önerileri:** projeyle paylaşılan sohbetlerdeki açık kararlar ("bundan sonra
  pnpm kullan", `KARAR:` / `MEMORY:` satırları…) projenin Memory kutusuna **öneri** olarak düşer (sohbet başına günde
  en fazla 5); kabul eden yine bir insandır, gözden geçiren sohbeti değil yalnız öneriyi ve kısa alıntıyı görür.
  Projede mod "assisted" ise başlıkta **Summarise for <proje> memory** düğmesi normal bir iş taslağı açar (sen
  gönderirsin).
- Sohbetler işlere asla kendiliğinden girmez; ayrıntı: `proje-hafizasi.md`.
- Gerekli: asistanın "geçmiş sohbetlerimde ara" (scope: chat) aracı ve yeni kural için asistan makinesinde worker
  güncellemesi. Otomatik ilgili bilgi bloğu, etiketleri okuyabilen mevcut worker'larla çalışır.

## Resim, dosya ve @ ile etiketleme
- **Resim gönder:** 📎 düğmesi, yapıştır (Ctrl/⌘+V ile ekran görüntüsü), sürükle-bırak; telefonda kamera.
  PNG, JPEG, WebP, GIF; ayrıca küçük PDF ve metin dosyaları (.txt .md .csv .json .yaml .log).
  Mesaj başına en çok 4 dosya; resim/PDF ≤ 3,75 MB, metin ≤ 256 KB. Büyük fotoğraflar tarayıcıda 2048 px'e küçültülür.
- **Asistan resmi görür:** Claude Code ve Codex resmi doğrudan okur; Pi ve OpenCode'da seçili modele bağlıdır
  (ekranda "depends on the model" yazar). PDF'i sadece Claude Code okur. Desteklemiyorsa resim düğmesi kapalıdır ve
  nedeni yazar (ör. "assistant worker must be updated").
- **Gizlilik:** konum (EXIF/GPS), XMP, yorumlar saklamadan önce silinir; metin dosyalarındaki token/anahtarlar
  `[REDACTED]` olur, resimde gizli anahtar bulunursa yükleme reddedilir. Ekran görüntüsündeki yazıyı ayıklayamaz —
  ekranında şifre/token varsa gönderme. Dosyaları sadece sen görürsün (sohbet gibi); geçmişte küçük önizleme,
  tıklayınca tam boy.
- **İşe dosya ver:** "bu resmi kullanarak genel'de bir araştırma işi taslakla" → taslak kartında "in/ dosyaları"
  listelenir; onaylayınca iş bu dosyaları `in/` altında alır. Sadece bu sohbetteki dosyalar.
- **.zip'i işe ver:** bir .zip'i sohbete bırak (📎, sürükle-bırak, yapıştır) ve ne yapılacağını
  yaz: "bu dosyalarla rapor hazırla", "bu projeyi incele". Zip **tarayıcında** açılır; çipte "İş girdisi · N dosya ·
  boyut" ve proje seçimi görünür. `.git/`, `node_modules/` ve sistem dosyaları dışarıda bırakılır; tek üst klasör
  kaldırılır. Sınırlar: en çok 2000 dosya, dosya başına 25 MiB, toplam 100 MiB (zip ≤ 128 MB).
  - **Her dosya türü** olur (kod, belge, Office, PDF, resim, iç içe zip — açılmaz, dosya olarak gider); sadece
    **çalıştırılabilir programlar/kütüphaneler** (.exe, .dll, .so, .dylib, ELF/Mach-O) reddedilir, adlarıyla yazılır ve
    çipteki "Reddedilen N dosyayı çıkar" ile gönderebilirsin. İzin vermek istersen: Ayarlar → Güvenlik → Filo →
    "Çalıştırılabilir dosyalar iş girdisi olabilsin" (varsayılan kapalı).
  - **Gizli bilgi taraması:** metin dosyalarında token/anahtar görünürse mesaj **gönderilmez**; çipte dosya, kural ve
    satır yazar (değer asla). Bilerek göndermek istersen **"Yine de gönder"** → Gönder: aynı yükleme tamamlanır, bu
    kayda geçer ve iş sayfasında da görünür.
  - Asistan işi o projede `inputUpload` ile taslaklar/başlatır; makine dosyaları ajan başlamadan önce **in/**
    klasörüne indirir (her dosya SHA-256 ile kontrol edilir). **Repo projelerinde** in/ kodun yanındaki ayrı bir
    klasördür, repoya **asla commit edilmez**. Hem workspace hem repo projelerinde çalışır.
  - **Site olan bir zip** iki şekilde de kullanılabilir: çip "Mesaja göre" der (ikisi de yüklenir; "yayınla" dersen
    yayınlar, "bu dosyalarla şunu yap" dersen iş yapar, belirsizse asistan sorar). İstersen çipte "Site (yayınla)" ya
    da "İş girdisi" seç.
  - **İş oluşturucuda da var:** İş → yeni iş → ".zip'teki dosyalar" (şimdi başlayan işler; zamanlanmış işe zip
    konmaz). İş sayfasında (Değişiklikler/Dosyalar sekmesi) ".zip'ten gelen girdi dosyaları" kutusu: dosya listesi,
    ne zamana kadar tutulduğu, gizli bilgi uyarısıyla gönderildiyse bulgular.
  - **Saklama:** son kullanımdan sonra 14 gün (çalışmayı bekleyen bir iş varsa silinmez), proje başına en yeni 20.
    "Yeniden çalıştır" ve devam işleri aynı dosyaları yeniden kullanır; silindiyse zip'i yeniden bırak.
  - Gerekli: işin çalışacağı makinelerde worker güncellemesi (`input-bundle-v1`); eski makine bu işi almaz ve iş
    "worker'ı güncelle" nedeniyle düşer.
- **@ ile etiketle:** `@` yaz → liste açılır (↑/↓, Enter/Tab seçer, Esc kapatır): proje, başka sohbetin, Çıktılar
  (site, dosya, not), iş, makine. Seçtiğin şey mesajda link olarak durur; asistan özetini (proje bilgisi, sohbetin son
  mesajları, çıktının adı/notu/site adresi, işin durumu) veri olarak alır — talimat olarak değil.
- Etiketler **gönderdiğin anda senin yetkinle** çözülür: göremediğin bir şey (başka projenin işi/çıktısı, başkasının
  sohbeti) gönderilmez; "mentions: left out N" notu düşer. Etiketlenen çıktı dosyası da işe girdi olarak verilebilir.
- Gerekli: asistan makinesinde worker güncellemesi (resim ve etiketler için `assistant-input-v1`). Önce master'ı,
  sonra worker'ı güncelle.

## Sohbetleri düzenleme ve sağ panel
Hepsi **sana özel**: sabitlediğin, grupladığın, etiketlediğin ve yıldızladığın şeyleri başka kimse görmez.
- **Sabitle (Pin):** sohbetin "⋯" menüsü → Pin. Sabitlenenler listenin en üstünde **Pinned** bölümünde durur (en son
  sabitlenen en üstte). En çok 20. Unpin ile kaldırırsın.
- **Gruplar:** listenin üstündeki **New group** ile klasör aç ("Deploys", "Araştırma"…). Sohbeti grubun başlığına
  sürükle-bırak (masaüstü) ya da "⋯" → **Move to group…** (telefonda bu). Bir sohbet tek bir grupta durur; "No group"
  ile çıkarırsın. Grup başlığına tıklayınca kapanır/açılır (hatırlanır); başlığın "⋯"sinden yeniden adlandır / sil.
  Grubu silmek sohbetleri silmez, sadece gruptan çıkarır.
- **Etiketler:** "⋯" → **Tags…** ile renkli etiket tak (bir sohbete en çok 10). Listenin üstündeki **Tags** ile
  etiketleri yeniden adlandır, rengini değiştir, sil. **Filter by tag** ile sadece o etiketli sohbetleri gör; arama ve
  "Show archived" ile birlikte çalışır (filtre/aramada liste tek parça görünür, satırda pin, grup ve etiketler yazar).
- **Mesajı yıldızla:** mesajın üstüne gelince (telefonda hep görünür) ☆ düğmesi; telefonda mesaja **uzun bas** da olur.
  Senin mesajların ve asistanın cevapları yıldızlanır.
- **Sağ panel (Details):** sohbetin üst çubuğundaki panel simgesi. **Varsayılan kapalı**; açık/kapalı tercihini bu
  tarayıcıda hatırlar. Sekmeler: **Starred** (yıldızlılar), **Media** (gönderdiğin resimler ve bu sohbetten açılan
  işlerin resim çıktıları), **Links** (mesajlardaki linkler, alan adıyla, tekrarsız), **Files** (ekler ve işlerin çıktı
  dosyaları), **Jobs** (bu sohbette taslaklanan iş / workflow / otomasyon / deploy ve oluşan işin canlı durumu).
  **All my conversations** ile bütün sohbetlerin. **Show in chat** o mesaja gider ve kısa süre vurgular. Telefonda
  panel tam ekran açılır; × veya Esc kapatır.
- Erişimin olmayan bir projedeki işin durumu ve dosyaları panelde görünmez (taslak görünür).
- Asistan bu düzenlemeyi okumaz; yeni bir asistan aracı yok. Gerekli: master + web güncellemesi;
  worker güncellemesi gerekmez.
