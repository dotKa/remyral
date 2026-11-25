# Remyral: Uptime (ayakta mı?) ekranı

## Ne bu?
Yayınladığın siteleri ve servisleri **master kendisi** düzenli olarak kontrol eder: "Site açılıyor mu, Cloudflare
Pages sağlıklı mı, Coolify uygulaması çalışıyor mu?" Düşerse sana haber verir, düzelince yine haber verir.
Sol menü → **Uptime** (Outputs'un altında). Adres: `/uptime`.

## Ne izlenebilir?
- **http / https:** bir adres (ör. `https://shop.example.com/health`). Beklenen durum kodu (varsayılan 200–399),
  isteğe bağlı **anahtar kelime** ("sayfada şu yazı olsun / olmasın" — sadece ilk 64 KB'a bakılır), en fazla gecikme
  (ms), yönlendirme sayısı (en fazla 5), **TLS sertifikası** bitimine kaç gün kala uyarsın (varsayılan 14).
  Sadece 80, 443, 8080, 8443 portları.
- **tcp:** host + port açık mı (ör. bir veritabanı portu). Sadece internete açık adresler.
- **Cloudflare Pages:** projenin son deploy'u başarılı mı ("healthy").
- **Coolify uygulaması:** uygulamanın durumu ("running:healthy" ise ayakta).

Kontrol sıklığı en az **30 saniye** (varsayılan 60 sn; Pages / Coolify için en az 60 sn, varsayılan 5 dk).
**Retries:** kaç başarısız kontrolden sonra "düştü" sayılsın (varsayılan 1 → art arda 2 hata).

## Nasıl eklenir?
- **Uptime → New monitor:** türü seç, adresi yaz, kaydet.
- **Outputs → bir site kartı → Monitor this:** sitenin adresi **ve** Pages / Coolify durumu birlikte izlenmeye başlar.
  Kartta artık yeşil/kırmızı nokta ve son 24 saatin **uptime %**'si görünür; tıklayınca monitöre gider.
- **Deploy bitince:** iş sayfasındaki deploy kartında "Monitor this site" önerisi çıkar (tıklamazsan bir şey olmaz).
- **Otomatik:** Proje sayfası → **Deploy** sekmesi → **Auto-monitor deployed sites** (proje admini açar). Açtıktan sonra yeni deploy
  edilen her site kendiliğinden izlenir. Sildiğin monitör, o site yeniden deploy edilene kadar geri gelmez.
- **Chat:** "shop sitesini izle", "siteler ayakta mı?" — asistan bir **kart** hazırlar, sen onaylarsın.
  "Düşerse haber ver" dersen o monitörü senin için izler.

## Ekranda ne var?
- Liste: durum (yukarıda **down** olanlar), uptime % (24 saat / 7 gün / 30 gün), son 24 saatin gecikme çizgisi,
  son kontrol, açık arıza (incident).
- Monitör sayfası: gecikme ve uptime grafiği (24 sa / 7 g / 30 g / 90 g), **arızalar** (ne zaman düştü, ne kadar
  sürdü, sebebi), son kontroller, TLS sertifikası ne zaman bitiyor, **Check now** (hemen kontrol et), **Pause /
  Resume**, düzenle, sil. Pages / Coolify satırları: "Cloudflare Pages: healthy", "Coolify app: running:healthy".

## Bildirimler
- **Monitor down** (kırmızı) ve **Monitor up again** (kaç dakika düştüğüyle). Proje operatörleri ve üstü alır.
  Ayarlar → Notifications'tan e-posta / webhook açabilirsin (uygulama içi zil hep açık).
- Bir monitör **sürekli düşüp kalkıyorsa** (30 dakikada 5 değişim) tek bir "Flapping" bildirimi gelir; sakinleşene kadar
  her iniş-çıkış için ayrıca bildirim gelmez (grafikte ve arıza listesinde yine görünür, "not notified" işaretli).
- TLS sertifikası bitmek üzereyse bir kez "Certificate expires soon" bildirimi gelir.

## Güvenlik (neden bazı adresler reddediliyor?)
Kontrolleri AWS'deki master yapar; içerideki servislere (veritabanı, Redis, Coolify paneli, `169.254.169.254` bulut
metadata adresi, `localhost`, `10.x / 192.168.x / 172.16–31.x`, Tailscale `100.x`) istek atamaz. Adres hangi IP'ye
çözülürse çözülsün, yönlendirme (redirect) nereye giderse gitsin her adım yeniden kontrol edilir. Adrese kullanıcı
adı/şifre yazılamaz, özel başlık (header) eklenemez — yani monitörde hiçbir sır saklanmaz.

## Bilmen gerekenler
- Kontroller **tek yerden (master)** yapılır. Master'ın interneti giderse her şey aynı anda "down" görünür — arıza
  listesinde başlangıç saatleri aynıysa sebep büyük ihtimalle master'dır.
- Kontrol geçmişi 30 gün, saatlik özetler 90 gün saklanır.
- Bir projede en fazla 50 monitör olur.
- Pages / Coolify bağlı değilse ya da token reddedilirse monitör "karar verilemedi" der; durumu değiştirmez.
- Chat'teki yeni araçlar (list_monitors, draft_monitor, monitör izleme) için worker güncellemesi gerekir; ekran ve
  bildirimler güncellemesiz çalışır.
