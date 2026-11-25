# Remyral: Otomatik doğrulama ve deploy sonrası sağlık kontrolü

## Ne bu?
İki şey:
1. **"Verify when done" (iş bitince doğrula):** Bir iş başarıyla bitince platform sonucu **kendisi kontrol eder** —
   site ise ekran görüntüsü alır, konsol hatalarına ve kırık linklere bakar; repo işi ise build / lint / test çalıştırır.
   Sonuç iş sayfasında **Verification** kartında görünür.
2. **Deploy sonrası sağlık kontrolü:** Her başarılı Pages / Coolify deploy'undan ve her açılan önizleme linkinden
   hemen sonra master siteyi açar: cevap veriyor mu (HTTP durumu, hız, TLS sertifikası), sitenin kendi içindeki
   linkler kırık mı? Sonuç **Deploys** sayfasında ve **Outputs** site kartında (son ekran görüntüsüyle) görünür;
   site düşükse sana haber verir.

## Modlar
- **Off:** doğrulama yok.
- **Report:** iş bitince doğrula, sonucu göster; hiçbir şey beklemez.
- **Gate:** doğrula; işte **"Deploy when done"** açıksa deploy, doğrulama **geçene kadar bekler**. Doğrulama
  başarısız olursa ya da çalışamazsa deploy bekler, sana ve proje adminlerine bildirim gelir. Proje admini iş
  sayfasında **Deploy anyway** (yine de deploy et) diyebilir — güncel doğrulama kodu (authenticator) ister, kayda geçer.

Nereden seçilir? Composer'da **Verify when done** kutusu, chat'te iş kartı ("doğrula", "test edip yayınla" dersen
asistan kartı buna göre hazırlar), şablonlar ve otomasyonlar. Seçmezsen **projenin varsayılanı** geçerli:
Proje sayfası → **Deploy** sekmesi → **Verification & health** (proje admini değiştirir, varsayılan Off).

## Doğrulama ne yapıyor? (sabit kontrol listesi)
- **Statik site (Pages):** master önce sitenin dosyalarına bakar: `index.html` var mı, sayfalardaki linkler ve
  resim/CSS yolları sitede gerçekten var mı. Sonra bir **doğrulayıcı iş** (aynı projede, işi başlatan kişi adına)
  siteyi makinede 127.0.0.1'de açar; makinede tarayıcı varsa (ör. Windows makinesindeki Playwright Chromium)
  **masaüstü (1280×800) ve telefon (390×844) ekran görüntüsü**, konsol hataları, başarısız istekler ve kırık iç
  linkler (en fazla 25 sayfa, 2 seviye). Repo projesinde önce build ve lint de çalışır.
- **Repo işi:** projenin **test komutu** (Verification & health'te yazarsın, ör. `pnpm test`), yoksa package.json'daki
  build / lint / test.
- **Dokümanlar (Markdown):** içindeki göreli linkler işin dosyalarında var mı; dış linkler (en fazla 20) cevap
  veriyor mu.

Sonuç: **Passed**, **Passed with warnings**, **Failed** ya da **Could not run**. Ekran görüntüleri iş sayfasında ve
doğrulayıcı işin dosyalarında (Outputs → Files) durur.

Önemli: doğrulayıcı bir yapay zeka ajanı; okuduğu sayfa / repo içeriği ona talimat veremez, raporundaki yazılar sadece
metin olarak gösterilir. Gate bir **kalite kontrolü** — deploy iznini yine işi başlatırken sen veriyorsun.

## Deploy sonrası sağlık kontrolü
- Otomatik çalışır (Verification & health → **Health check after every deploy and preview link**, varsayılan açık).
- Master siteyi kendisi kontrol eder (uptime ile aynı güvenlik kuralları: sadece internete açık adresler, sadece
  sitenin kendi alan adı taranır, şifre / çerez gönderilmez). Site ilk anda açılmıyorsa birkaç kez yeniden dener.
- Tarayıcılı bir makine varsa kısa bir iş **ekran görüntüsü** alır; bu görüntü Outputs'taki site kartında küçük resim
  olarak görünür. Tarayıcılı makine yoksa "master-side link check only" yazar.
- **Deploys** listesinde her deploy'un yanında sağlık durumu; deploy sayfasında ayrıntı (cevap, kırık linkler ve hangi
  sayfadan link verildiği, ekran görüntüleri) ve **Check again** (yeniden kontrol, 30 saniyede bir).
- Site düşükse: **"Site unhealthy after deploy"** bildirimi (proje operatörleri; production'da kırmızı) ve deploy chat'ten
  yapıldıysa o konuşmaya not.

## Otomatik geri alma (isteğe bağlı)
Verification & health → **Roll back automatically when the health check fails** (varsayılan kapalı). Açıksa, sağlık
kontrolü (yaklaşık bir dakikada 4 deneme) başarısız olan Pages / Coolify deploy'u geri alınır — sadece o sitenin en son
deploy'uysa. **Production için ayrıca** "Also for production deploys" kutusu gerekir. Geri alma normal bir ops işlemi:
projenin deploy politikası production için onay istiyorsa onay bekler.

## Kurulum
- İstersen proje varsayılanını **Report** ya da **Gate** yap; repo projelerinde test komutunu yaz.
- Ekran görüntüleri için en az bir makinede tarayıcı olmalı: Machines → makine → Tools → **browser** (Playwright
  Chromium) kurulu ve görünür olmalı.

## Henüz doğrulanmayanlar
- Windows makinesinde Playwright Chromium ile gerçek doğrulayıcı / ekran görüntüsü işi.
- Gerçek Cloudflare Pages / Coolify deploy'u sonrası sağlık kontrolü ve otomatik geri alma.
