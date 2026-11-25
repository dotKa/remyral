# Remyral: Çıktılar (Outputs) ekranı

## Ne bu?
İşlerin ürettiği her şey tek yerde: **yayınlanan siteler**, **dosyalar** ve **notların**.
Sol menü → **Outputs** (Jobs ile Automations arasında; telefonda alttaki **More** içinde). Adres: `/outputs`.

Üstteki sekmeler: **All · Sites · Files · Notes**.
- **Sites:** her proje / hedef / ortam (preview, production) için **son başarılı deploy** ve canlı adresi.
  Cloudflare Pages ve Coolify. **Open site** linki her zaman yeni sekmede açılır.
- **Files:** workspace işlerinin `out/` klasörüne yazdığı dosyalar, iş özetleri (`summary.md`) ve repository
  işlerinin "run artifact"ları (ör. `attempt.diff`).
- **Notes:** senin yazdığın serbest not kartları (başlık, metin, etiket, https linkleri, sabitleme).

## Kullanmak
- **Arama:** başlık, dosya adı, etiket, not metni ve site adresi içinde arar. Enter'a bas.
- **Filtreler:** proje, tarih aralığı (From / To), **Pinned only**. Bir karttaki etikete tıklayınca o etikete göre
  süzer; çipteki × ile kaldırırsın. İş sayfasından gelirsen ("Show in Outputs") o işe göre süzülmüş açılır.
- **Cards / List:** kart ızgarası ya da liste; tarayıcı hatırlar.
- Bir kartın başlığına tıkla → sağda **detay paneli** açılır (telefonda tam ekran):
  - **Site:** Open site, adres, nerede (Pages/Coolify · ortam), ne zaman, **Open the deploy** (geçmiş ve geri alma
    — rollback — oradan), kaynak iş, **Site files** (sitenin dosyaları; HTML sadece "scriptsiz" kutuda gösterilir).
  - **Dosya:** **Download**, **Open job**, önizleme (Markdown, metin, JSON ağacı, CSV/TSV tablo, resim, PDF, diff),
    tür / boyut / **Kept until** (ne zamana kadar saklanacak) / SHA-256.
  - **Başlık, etiketler, Pin:** kendi başlığını ve etiketlerini verirsin; **Pin** en üste alır.
  - **Notes:** o çıktıya not düşersin (Markdown: **kalın**, `kod`, listeler). Kendi notunu düzeltir / silersin;
    admin ve owner herkesinkini silebilir.

## Toplu indirme (ZIP)
**Files** sekmesinde kartların solundaki kutucukları işaretle → üstte **Download as ZIP**.
- Tek ZIP'te **tek projenin** dosyaları olur (farklı projeleri seçersen uyarır).
- En fazla **100 dosya** ve toplam **50 MiB**. İçinde bir `MANIFEST.txt` var (her dosyanın işi, boyutu, SHA-256'sı;
  eklenemeyenler de yazar).
- Silinmiş (retention) dosyalar ve içeriği master'da olmayan run artifact'lar ZIP'e girmez.

## Pin ve saklama süresi (önemli)
Workspace projelerinde **Projects → proje → Workspace (Storage)** bölümünde dosya saklama süresi (retention) ve depolama kotası
olabilir; süresi dolan dosyaların içeriği silinir (adı ve bilgileri kalır).
- **Pinlenen dosya silinmez** — ne süre dolunca ne kota yüzünden. Kartta "Pinned", detayda "Pinned — kept by the
  retention" yazar.
- Pinli dosyalar kotadan yer kaplamaya devam eder; kota dolarsa yeni dosyalar reddedilir → gereksiz pinleri kaldır.
- Run artifact'ların bilgisi iş bittikten **30 gün** sonra silinir; pinlersen kalır.
- Siteler Cloudflare / Coolify'da durur, saklama süresi yok; pin sadece en üste alır.

## Not kartları
Sağ üstte **New note** (operator ve üstü): proje seç, başlık, metin, etiketler, linkler (her satıra bir
`https://` link — http ve `javascript:` kabul edilmez), "Pin to the top".
Notlar **Context'e yazılmaz**, ajanlara hiçbir zaman gönderilmez; sadece bu ekranda durur.

## Kim ne yapabilir?
- **Viewer:** görür, önizler, indirir (ZIP dahil); kendi **kişisel klasörlerini** yönetir; proje klasörlerine bakar.
- **Operator:** + başlık / etiket / pin, not yazma, not kartı oluşturma; kendi notlarını düzenler / siler; **proje
  klasörlerini** oluşturur, düzenler, taşır, siler, içine öğe ekler / çıkarır.
- **Admin / owner:** + herkesin notunu düzenler / siler.
- Üyesi olmadığın projenin hiçbir çıktısı görünmez.
Her değişiklik ve ZIP indirme audit log'a yazılır.

## Klasör ağacı (solda)
Ekranın solunda bir **ağaç** var (**Hide folders / Show folders** ile kapatıp açarsın; tarayıcı hatırlar):
- En üstte **My folders** (senin kişisel klasörlerin), altında görebildiğin **projeler**.
- Bir projeyi aç: **Folders** (projenin ortak klasörleri), **Sites**, **Notes** ve **dosya üreten işler** (en yenisi
  üstte; çoksa **Show more**).
- Bir işi aç: `out/` içindeki **gerçek klasör yapısı** (ör. `site` → `css`). `site/index.html` gibi dosyalar kendi
  klasörlerinde durur.
- Bir düğüme tıklayınca sağ taraf sadece onu gösterir; üstte **yol (breadcrumb)** çıkar: *All outputs › Acme › İş ›
  site*. Yoldaki bir adıma tıklayıp geri çıkarsın.
- Klavyeyle: ↑/↓ gez, → aç / içine gir, ← kapat / üst düzeye çık, Enter seç, Home/End baş/son.
- **Download folder as ZIP:** seçili proje / iş / klasörün dosyalarını yapısını koruyarak tek ZIP'te indirir (yine en
  fazla **100 dosya**, **50 MiB**, içinde `MANIFEST.txt`). Fazlaysa daha küçük bir klasör aç.
- **Telefonda** ağaç yerine adım adım liste: bir satıra dokun → içine girer, **← Back** ile geri.

## Klasörlerim (kendi klasörlerin)
İki çeşit klasör var:
- **Proje klasörü** ("Everyone in <proje>"): projenin herkesi görür; **operator ve üstü** oluşturur / değiştirir,
  viewer sadece bakar.
- **Kişisel klasör** ("Only me" → **My folders**): **sadece sen** görürsün — admin / owner dahil kimse göremez.
  Görebildiğin her projeden öğe koyabilirsin; bir projeye erişimin kalkarsa o öğeler klasörde görünmez olur.

Kullanmak:
- **New folder** (ağacın üstünde) → ad, kimin göreceği, not (Markdown), etiketler, **Pin to the top**.
- Klasörün içinde: **New sub-folder** (en fazla **6 seviye**), **Edit** (ad / not / etiket / pin), **Move to…**,
  **Delete**.
- **Öğe eklemek:** bir kartı sürükleyip ağaçtaki klasörün üstüne bırak **ya da** kartta / detay panelinde
  **Add to folder…** (klavye ve telefon için; aramalı liste, oradan yeni klasör de açabilirsin).
- Bu bir **kısayol (link)**, taşıma değil: aynı öğe birkaç klasörde olabilir; **Remove from folder** ya da klasörü
  silmek öğeye dokunmaz, öğe Outputs'ta kalır. Klasörü silmek alt klasörlerini de siler (öncesinde sorar).
- Detay panelinde **In folders**: öğenin hangi klasörlerde olduğu.
- Sınırlar: proje başına 500 klasör, kişi başına 500 kişisel klasör, klasör başına 1 000 öğe.

### Sohbette `@klasör`
Sohbette `@` yazınca klasörler de çıkar. Gönderdiğinde asistan klasörün adını, notunu, alt klasörlerini ve içindeki
(senin görebildiğin) öğelerin listesini görür. Görmediğin klasör sessizce değil, "görünmüyor" notuyla düşer. Çipe
tıklayınca klasör Outputs'ta açılır.

### İşin çıktıları doğrudan klasöre
API ile iş açarken `outputFolderId` verirsen (ya da bir otomasyonun iş hedefinde), iş bitince ürettiği dosyalar
(ve deploy edildiyse sitesi) o klasöre otomatik eklenir. Yetki iş açılırken ve eklenirken **yeniden** kontrol edilir:
o arada yetkin düştüyse hiçbir şey eklenmez ve audit log'a yazılır. Konsolda iş formunda bu seçim henüz yok.

## Güvenlik notları
- Dosya içeriği hiçbir zaman konsolun bir parçası gibi çalıştırılmaz: metin hep düz metin, Markdown sadece biçim.
- Sitenin HTML'i sadece kum havuzlu (sandbox) bir çerçevede, **script çalışmadan** ve çerezlerine erişmeden gösterilir;
  gerçek hali için **Open site**.
- Secret taramasının işaretlediği site paketleri gösterilmez.
- PDF önizlemesi tarayıcının kendi PDF görüntüleyicisiyle açılır; boş kalırsa **Download** kullan.

## Büyük dosyalar, konum ve paylaşım bağlantısı
- Dosya ayrıntısındaki **Konum** satırı dosyanın nerede durduğunu söyler: **S3’te**, **Diskte** ya da (eski dosyalar taşınana kadar) **Veritabanında**.
- **İndir** büyük dosyaları tarayıcının belleğine almadan indirir (kovadaysa kısa ömürlü imzalı bir bağlantıyla). Kovadaki PDF, resim ve videolar için **S3’te aç** da vardır.
- Sahipler ve yöneticiler bir dosya için süreli, iptal edilebilir **paylaşılabilir bağlantı** oluşturabilir; bağlantı bir kez gösterilir, her açılış denetim kaydına yazılır.
- Ayrıntılar, kova kurulumu ve sınırlar: [depolama.md](depolama.md).
