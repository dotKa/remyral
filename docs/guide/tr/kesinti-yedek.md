# Remyral: Kesintiye dayanıklılık ve yedek panel

Hedef: kontrol düzleminin kesintisi çalışan işleri en az 15 dakika etkilemesin ve sunucu kaybına karşı bir yedek
mekanizma olsun. Teknik ayrıntı:
[ADR-0039](../../adr/0039-master-outage-grace-and-standby.md), [tasarım notu](../../design/p11-master-resilience.md),
[SLO](../../ops/slo.md), [yedek/geri yükleme runbook'u](../../ops/backup-restore.md).

## Ne dayanıyor?
- **Panel (master) 15 dakikaya kadar gitse de çalışan işler ölmüyor.** Deploy, sunucu yeniden başlatma, master çökmesi
  ya da worker'ın internetinin kopması fark etmez: makine işi sürdürür; sonuçlar, olaylar, loglar ve **onay
  istekleri** makinede diskteki kuyrukta bekler, panel dönünce sırayla iletilir. (Öncesi: ~3 dakika.)
- **15 dakikadan uzun kesinti:** makine işi kendisi güvenle durdurur (aynı işin iki kopyası asla çalışmaz). Panel
  dönünce işi "kayıp" sayar; hiçbir yan etkisi yoksa (dal uzak repoda yoksa) otomatik yeniden dener, varsa "insan
  incelemesi gerekiyor" der.
- **Panel ulaşılabilir ama işi reddediyorsa** makine hemen durdurur.
- Kesinti sırasında işi **iptal edemez, onaylara cevap veremezsin** (panel yok); döndüğünde normale döner.
- Bunun için güncel bir **worker sürümü** gerekir; eski sürümlerde ~3 dakika geçerlidir.

## Yedek panel nasıl çalışıyor? (tek sunucu + bulut depolama)
- Veritabanı her değişikliği küçük parçalar (WAL) halinde yazar; yedek servisi bunları **senin anahtarınla şifreleyip**
  S3/R2 bucket'ına ~30 saniyede gönderir. Günde bir de tam "taban" yedek alınır. → Kayıp en fazla **~5 dakikalık** veri.
- Sunucu tamamen giderse: yeni bir sunucuda `scripts/ops/standby-restore.mjs` taban + WAL'ı indirip çözer, veritabanını
  en son ana kadar geri kurar, kontrol eder (şema, satır sayıları, imza anahtarları), sonra **DNS kaydını yeni
  sunucuya çevirir**. Worker'lar aynı adrese kendiliğinden (≤ 60 sn) yeniden bağlanır, kimlikleri aynı kalır.
  Hedef: **1 saatin altında** panel geri.
- Her hafta yapılan geri yükleme tatbikatı artık WAL'ı da yakın bir ana kadar oynatıp kontrol ediyor.
- Settings → **Backups** ekranında "Standby" kutusu: son gönderilen WAL, gecikme, son taban yedek, son standby
  tatbikatı.

## Kurulum
1. **S3 veya R2 bucket + erişim anahtarı** ([yedekleme.md](yedekleme.md), "Kurulum" madde 2). Bucket'ta
   `remyral/wal/` ve `remyral/base/` için yaşam döngüsü: 15 gün. Anahtarlar sunucuda yalnızca root'un okuyabildiği
   `backup-config/offsite.env` dosyasında durur, repoya girmez.
2. **WAL arşivini aç:** `stack.env`'e `PG_WAL_ARCHIVE=on`, yedek rolüne iki yetki (tek seferlik SQL), ardından
   altyapı servislerini yeniden başlat (Postgres bir kez yeniden başlar, ~10 sn).
3. **(İsteğe bağlı) Otomatik DNS geçişi için** Cloudflare API token'ı (sadece ilgili zone, "DNS Edit"). Yoksa geçiş
   adımı elle yapılır (DNS sağlayıcısında A kaydını yeni IP'ye çevirmek).
4. **Tatbikat:** bir kez gerçekten dene — (a) panel 15 dakika kapalıyken bir makinede bir iş bitsin; (b) boş bir
   sunucuda standby geri yükleme (yaşayan sunucuya dokunmadan). Bunun için age anahtarı (identity) geçici olarak
   gerekir; anahtarı sunucuda bırakma.
