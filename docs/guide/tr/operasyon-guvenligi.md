# Remyral: Operasyon güvenliği

Yer: Ayarlar → Operasyon güvenliği

**1. Anahtarlar ve süreler**
- Master’ın bildiği her anahtar, token ve sertifika tek listede: API anahtarları, Cloudflare token’ı (Cloudflare’ın kendi doğrulama yanıtındaki bitiş tarihi), GitHub App anahtarının yaşı, Coolify token’ları (yaş + son bağlantı testi), konsol adresinin sunduğu TLS sertifikası, makine yazılımı imza anahtarı, master’ın anahtar dosyaları (TOTP, lease, webhook HMAC … — yalnızca dosya tarihi okunur, içerik asla), yedek age kimliği, bitiş tarihi girilmiş kasa kimlik bilgileri.
- Durumlar: Sorun yok · 30 gün içinde · 7 gün içinde · Süresi doldu · Bilinmiyor · Denetim hatası.
- Bildirim: 30, 14, 7, 1 gün kala ve süre dolunca **bir kez** (sahipler ve yöneticiler). Ana sayfadaki Sağlık panelinde de satır var.
- **İlk açılışta:** **Yedek age kimliği** “Bilinmiyor” görünür → kimliği oluşturduğun tarihi kaydet (sunucuda: `remyral-master secrets:rotated backup:age-identity --at <tarih, ör. 2026-01-15T00:00:00Z>`) ya da listedeki **Yenilendi** düğmesi (bugünün tarihiyle).
- Bir anahtarı rehberine göre yeniledikten sonra **Yenilendi** de (ya da `remyral-master secrets:rotated <kimlik>`; liste: `remyral-master secrets:rotated --list`). Yaş ve hatırlatma oradan yeniden başlar.
- Kasa kimlik bilgisinin sağlayıcıda bitiş tarihi varsa (ör. süreli API anahtarı) aynı panelden tarih gir.

**2. Sürüm devre kesici** (Ayarlar → Worker sürümleri → Devre kesici)
- Yeni makine yazılımı yayılırken güncellenen makineler hata verirse (güncelleme başarısız / geri alındı / zaman aşımı, sürekli yeniden başlama, güncellemeden sonraki 30 dk içinde nabız kesilmesi) ya da işleri belirgin şekilde daha sık başarısız olursa yayılım **kendiliğinden durur**: başka makineye sunulmaz, yüzde artırılamaz, bildirim gelir.
- Varsayılan eşik: değerlendirilen makinelerin %30’u (en az 1) hatalı; ya da iş hata oranı +30 puan (en az 5 iş).
- Panelde neden ve hatalı makineler yazar. **Devam ettir** (sayılmış hatalar tekrar sayılmaz) ya da **Geri al (önceki sürüm)** — ikisi de kod ister. Elle **Yayılımı durdur** da var.
- Hiçbir şeyi kendiliğinden yükseltmez ya da geri almaz.

**3. Maliyet freni**
- API ile faturalanan model harcaması (işler + asistan; abonelik çalışmaları sayılmaz) UTC günü ve ayı için tavanla karşılaştırılır. Varsayılan: günlük $50, aylık $500, uyarı %80, **yalnızca uyar**.
- %80’de ve tavanda sahiplere bildirim; ana sayfada ve sohbette bant.
- **Durdur** moduna geçersen: tavana ulaşınca acil olmayan yeni işler bekler (Acil işler çalışır), asistan yeni mesaj almaz. Freni **1–72 saat** kaldırabilirsin (yalnızca sahip, kayda geçer). Proje başına ayrı tavan da tanımlanabilir.

**4. İstek sınırları**
- Kişi başı okuma 600/dk, yazma 120/dk; API anahtarı başı okuma 600/dk, yazma 120/dk; sohbet 10 mesaj/dk, 120 mesaj/saat. Varsayılanlar eski sabit değerler — değiştirmezsen hiçbir şey değişmez.

**Asistana sorabilirsin:** “hangi anahtarın süresi doluyor?”, “sertifika ne zaman bitiyor?”, “güncelleme neden durdu?”, “maliyet freni açık mı?”.
