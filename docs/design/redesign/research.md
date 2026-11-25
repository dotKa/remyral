# Remyral Agent Cluster — yeniden tasarım araştırma notu

Tarih: 2026-10-19. Kaynaklar: `apps/web/src` (shell/sections.tsx, index.css, fonts.css, components/*), `docs/guide/tr/*.md`
(chat, kuyruk-plani, onay-bekleme, birlestirme, oturum-surekliligi, limit-fallback, dogrulama-saglik,
hafiza-katmanlari, sandbox), `docs/design/p6-ui-refactor/*.png` ekran görüntüleri.
Referans konsollar bilgi birikiminden değerlendirildi (canlı web taraması yapılmadı).

## Ürün aslında ne?

Tek bir sahibin (ve birkaç adminin) kendi makinelerinde AI kodlama ajanlarını (Claude Code, Codex, Pi, OpenCode)
çalıştırdığı bir **operasyon konsolu**. Ekranın asıl işi üç soruyu saniyeler içinde cevaplamak:

1. **Benden ne bekleniyor?** (riskli araç çağrısı onayı, birleştirme onayı, başarısız iş, limit yüzünden duran iş)
2. **Şu an ne çalışıyor, nerede, ne kadar kaldı?** (iş, makine, slot, runtime, kuyruk sınıfı Acil/Normal/Arka plan)
3. **Sistem sağlıklı mı, kapasite/limit nerede biter?** (makineler, 5 saatlik/haftalık runtime pencereleri,
   yedek/standby, uptime, maliyet)

Domainin kendine has nesneleri: *slot*, *sandbox profili*, *limit penceresi*, *checkpoint*, *stale → paused*
onay yaşam döngüsü, *entegrasyon dalı `int/…` → tek PR*, *hafıza bütçesi 64 KiB*, *taslak kart (draft card)*.
Bunlar şu an düz metin ve tablo satırı olarak görünüyor; hiçbirinin kendi görsel formu yok.

## Mevcut arayüzde eksik olanlar

| Eksen | Bugün | Sorun |
| --- | --- | --- |
| Hiyerarşi | Her şey aynı beyaz panel + 14px metin + aynı tablo | "Needs you" ile "Recent failures" aynı ağırlıkta; göz nereye bakacağını bilmiyor. Sayfa başlığı + açıklama paragrafı her ekranda aynı şablon. |
| Yoğunluk | Ekranın %60'ı boş (Home'da 1 iş, 5 makine) ama tablo satırları geniş | Az veride boşluk, çok veride uzun scroll. Bilgi/piksel oranı düşük; makine kartında slot, limit, sandbox görünmüyor. |
| Durum iletişimi | Tek tip "pill" (Running/Failed/Offline) | Süre, ilerleme, bekleme sebebi, stale geri sayımı, limit açılma saati, checkpoint yaşı yok. "Live" bir yeşil nokta; canlılık hissi yok. |
| Navigasyon | 13 öğeli sol menü, 3 etiketsiz grup | İş → makine → proje arası geçiş yok; klavye kısayolu var ama keşfedilmiyor; komut paleti yok. |
| İş detayı | Prompt kutusu + "No events yet" + dikey timeline | Ajanın ne yaptığı (araç çağrıları, dosyalar), onay, entegrasyon ve doğrulama tek bir hikaye olarak okunmuyor. |
| Onay | Approve/Deny butonlu satır | "Ajan ne diyor, tam komut ne, neye dokunuyor, ne zaman bayatlar" ayrımı görsel olarak yok; riskli işlem sıradan bir liste satırı gibi. |
| Hareket | Yok | Canlı veri değiştiğinde (yeni olay, slot dolması) hiçbir geri bildirim yok. |
| Kimlik | IBM Plex + çam yeşili + gri zemin; "R" logosu | Düzgün ama ayırt edilemez: herhangi bir admin şablonu. Ürünün "ajan filosu yönetiyorum" hissi yok. |

## Referanslardan alınacak dersler

- **Linear**: liste + detay bölmesi, her şey klavyeden; durumlar küçük ama çok tutarlı ikonlarla. Ders: tutarlı
  durum sözlüğü ve hızlı geçiş, animasyonsuz klavye eylemleri.
- **Vercel / Railway**: deploy'u bir *pipeline* olarak gösterme (adımlar, süreler, log'a tek tık). Railway'in
  servisleri bir *tuval* üzerinde göstermesi. Ders: entegrasyon/doğrulama/deploy zincirini adım adım çizmek.
- **Raycast**: komut paleti ana giriş; açılış animasyonu yok. Ders: ⌘K ile "yeni iş", "makineye git", "onayla".
- **Grafana / Datadog**: yoğun panolar, zaman ekseni ortak, eşik çizgileri. Ders: limit pencerelerini ve kapasiteyi
  ortak bir zaman ekseninde göstermek; renk yalnızca durum için.
- **Temporal UI**: workflow geçmişini olay listesi + zaman çizelgesi (gantt) olarak gösterme. Ders: iş ve alt
  işleri tek bir zaman ekseninde, makine şeritleri üzerinde göstermek.
- **GitHub Actions**: job grafiği + adım log'u. Ders: alt işler → entegrasyon → test → PR akışını grafik olarak.
- **Uçuş/kule ekranları (NOC, avionics)**: "dikkat gerektiren" her şey tek bir renk sınıfında ve her zaman aynı
  konumda. Ders: needs-you'nun sabit, en üstte ve sayılabilir olması.

## Yeniden tasarım ilkeleri

1. **Önce sahibin kararları.** Needs-you her ekranda sabit bir yerde, sayılı ve türüne göre (onay / birleştirme /
   hata / limit) ayrışmış. Karar verilecek her şey: ajan ne diyor → tam komut → neye dokunuyor → ne zaman bayatlar.
2. **Durum = renk + şekil + metin.** Renk tek başına taşımaz (renk körlüğü). Running/queued/paused/stale/failed/
   done için tek bir sözlük; canlı olan şey hafifçe "nefes alır", gerisi durur.
3. **Domain nesnelerine görsel form ver.** Slot = hücre, limit penceresi = zaman ekseninde dolan bar + açılma saati,
   checkpoint = timeline üzerinde işaret, entegrasyon = adım zinciri, hafıza = bütçe çubuğu.
4. **Yoğunluk ayarlanabilir, boşluk anlamlı.** Ops kullanıcısı tarama yapar: tablolar sıkı, gruplar arası boşluk geniş.
5. **Hareket sadece durum değişince.** Yeni olay girişi, slot dolması, onayın bayatlamaya yaklaşması.
   Klavye eylemleri animasyonsuz. `prefers-reduced-motion` ile hareket yerine renk/opaklık.
6. **Türkçe/İngilizce karışık gerçek dil.** Ürün dili zaten karışık (Needs you, Onay, Slot, Stale); fontlar latin-ext
   (ğ ş İ ı) desteklemeli, uzun Türkçe kelimeler taşmamalı.
7. **Telefonda da karar verilebilir.** Onay ve needs-you telefonda tek elle kullanılabilir; yoğun tablolar
   kartlara/listeye döner.

## Beş yön (özet)

1. **Kule** — karanlık, yoğun, NOC/avionics enstrümanı. Tek tema.
2. **Defter** — sakin, yazı odaklı "günlük brif"; işler okunur bir belge gibi. Açık + koyu.
3. **Komut** — klavye/komut paleti öncelikli, üç bölmeli (liste · detay · denetçi). Açık + koyu.
4. **Akış** — zaman ekseni merkezli; makineler şerit, işler şerit üzerinde akan çubuklar, olay nehri. Açık + koyu.
5. **Sinyal** — markalı, ifadeli tipografi ve renk; ürün kalitesinde cila, mobil önce. Açık + koyu.
