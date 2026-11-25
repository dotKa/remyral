# Remyral: Maliyet ve verimlilik (bütçeler, pano, haftalık rapor, öneriler)

## Ne bu?
Hangi projenin ne kadar harcadığını, neyin boşa gittiğini ve neyi değiştirebileceğini tek yerden görmek:
**Usage** sayfası artık şu sekmelerle açılır: **Dashboard** (varsayılan), **Suggestions**, **Reports**, Overview,
Outcomes, Prices, Budgets, Enforcement.

Önemli ayrım: işlerin çoğu **Claude aboneliği** (local-login) ile çalışır. Aboneliğin iş başına dolar maliyeti yoktur.
Bu yüzden:
- **API harcaması** = gerçekten API anahtarıyla faturalanan kullanım (dolar; bilinmeyen maliyet varsa "≥ $12,50" gibi
  alt sınır gösterilir, asla 0 sayılmaz).
- **Abonelik kullanımı** = token / tur / saat olarak gösterilir, yanında **"API-equivalent ≈ $X (estimate)"** —
  "API ile ödeseydin yaklaşık bu kadar olurdu" tahmini. Harcanmış para değildir, hep "estimate" diye yazılır.

## Bütçeler (Usage → Budgets)
Her bütçe için:
- **Ne sayılır:** tüm kullanım / sadece API faturalı / sadece abonelik. Abonelik için dolar bütçesi olmaz; token, tur
  veya **saat** girilir.
- **Pencere:** gün / hafta (Pazartesi–Pazar) / ay — seçtiğin **saat diliminde** (ör. `Europe/Istanbul`). Ay, İstanbul
  saatiyle ayın 1'i 00:00'da başlar.
- **Bildirim eşikleri:** varsayılan %50, %80, %100 (en fazla 5 tane). Her eşik pencere başına **bir kere** bildirilir.
- **%100'de ne olsun:**
  - *Warn only* — sadece haber verir, hiçbir şey durmaz.
  - *Pause new jobs* — o kapsamdaki yeni işler kuyrukta bekler: "budget exhausted until Sun, 1 Nov 2026, 00:00
    (Europe/Istanbul)". Çalışan işler devam eder. Otomasyon çalışmaları atlanır.
  - *Block automations only* — sadece otomasyonların başlattığı işler bekler / otomasyon çalışmaları atlanır; elle
    başlattığın işler çalışır.
- Proje için tipik kurulum: "aylık API $50" + (isteğe bağlı) "günlük API $5" + "aylık abonelik 40 saat" — üç ayrı
  bütçe, hepsi aynı proje kapsamında.

**Override (aşma izni):** bütçe dolunca owner/admin, bütçenin satırındaki **Override…** ile sebep yazıp (ve isterse tek
bir iş id'si) authenticator koduyla izin verir. İzin en fazla pencere sonuna kadar geçerli, istenirse **End override**
ile erken bitirilir; hepsi audit log'a yazılır.

Bildirim: %50/%80 için "Budget threshold", %100'de durdurma varsa **"Budget exhausted: work paused"** (kritik). E-posta /
push için Settings → Notifications'ta ilgili satırı aç.

## Dashboard
Dönem (7/30/90 gün, bu ay, geçen ay), gün/hafta/ay kırılımı, saat dilimi, faturalama filtresi ve kırılım boyutu
(proje, runtime, model, iş türü, otomasyon, makine). Gösterilenler:
- API harcaması, abonelik kullanımı (+ tahmin), token/tur/saat, **başarılı iş başına maliyet**;
- dönem grafiği (sayılar "Show the numbers" altında tablo olarak);
- kırılım tablosu: harcama, iş sayısı, başarı oranı, başarılı iş başına maliyet;
- en pahalı ve en yavaş işler (işe tıklanır), runtime × model başarı oranı;
- **tasarruf sayaçları (tahmin):** sonuç yeniden kullanımı (atlanan aynı işler ve kazanılan süre/maliyet), paylaşılan
  paket önbelleği sunulan çalışmalar, güvenli otomatik onay (otomatik onaylanan komut × ölçülen ortalama insan bekleme
  süresi; ölçüm yoksa 2 dk varsayılır ve "assumed default" yazar);
- **CSV indir:** kırılım (herkes), iş bazında kullanım (operator ve üstü).

## Öneriler (Suggestions)
Sabit kurallarla (yapay zeka yok) kayıtlı istatistiklerden çıkar, kanıtıyla birlikte gösterilir:
- "Şu tür işler daha ucuz bir model profiliyle aynı başarıda çalışıyor" → **routing kuralını değiştir** (admin + kod);
- "Bu otomasyon çalışmalarının %40'ında başarısız" → **otomasyonu duraklat**;
- "Bu otomasyon aynı işi tekrar tekrar yapıyor" → **sonuç yeniden kullanımını aç (24 saat)**;
- "Bu makine önerilenden fazla paralel iş çalıştırıyor" → **paralel iş sayısını düşür** (admin + kod);
- bütçe hızı, eksik fiyat, düşük başarı oranı → ilgili sayfaya link.
Hiçbiri kendiliğinden uygulanmaz: butona bas → onayla → (gerekirse) authenticator kodu. **Dismiss** sadece bu
tarayıcıda gizler.

## Haftalık rapor (Reports)
- Her **Pazartesi 08:00, kendi saat diliminde** bir önceki haftanın raporu: ne çalıştı, ne deploy edildi, hatalar
  (sadece hata kodu), bütçelere göre harcama (geçen haftayla), en pahalı/yavaş işler, tasarruflar, öneriler.
- Owner ve admin için **varsayılan açık**, diğer roller için kendin açarsın. Ayarlar: saat dilimi ("Use this browser's
  zone"), aç/kapat, isteğe bağlı olarak raporun kendi sohbetlerinden birine de yazılması.
- Rapor: konsolda sayfa (`/usage/reports/<id>`) + zil bildirimi; e-posta / push bildirim ayarlarındaki "Weekly cost &
  efficiency report" satırına göre. "Preview this week so far" o anki haftayı kaydetmeden gösterir.
- Master 08:00'de kapalıysa açılınca gönderir; aynı hafta iki kez gelmez (saat dilimini değiştirsen de).

## İlk ayarlar
- Projeler için bütçeleri bir kere kur (yukarıdaki üçlü öneri), saat dilimini kendi bölgene göre seç (ör. `Europe/Istanbul`).
- Fiyat tablosunda (Prices) kullandığın modellerin fiyatı yoksa ekle; yoksa dolarlar alt sınırdır ve abonelik
  tahminleri runtime'ın kendi rakamına düşer.
- Haftalık raporu e-posta/push ile istiyorsan Settings → Notifications'ta aç.
