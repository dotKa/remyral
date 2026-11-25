# Remyral: telefona uygulama olarak yükleme ve anlık bildirimler (PWA)

## Ne bu?
Panel artık telefona (ve bilgisayara) **uygulama olarak yüklenebiliyor**: kendi ikonu, tam ekran pencere,
ve uygulama kapalıyken bile gelen **anlık bildirimler (push)**. Onay verme, işleri takip etme ve sohbet
telefondan yapılabiliyor (alttaki menü: Home · Chat · Jobs · Approvals · More).

## Yükleme
- **Android (Chrome):** Settings → **Devices** → **Install app** (ya da Chrome menüsü → *Uygulamayı yükle*).
- **iPhone / iPad (Safari):** **Paylaş** → **Ana Ekrana Ekle**. Sonra Remyral'ı ana ekrandaki ikondan aç.
- **Bilgisayar (Chrome / Edge):** adres çubuğundaki yükle ikonu ya da Devices → Install app.

## Bildirimleri açmak
1. Uygulamada **Settings → Devices → This device → Turn on push notifications**.
2. Tarayıcı izin sorar → **İzin ver**.
3. Yeni bir cihaz eklemek **authenticator kodu** ister (çalınmış bir oturum kendi cihazını ekleyemesin diye).
4. İlk cihazda şu bildirimler otomatik açılır: onay bekleyenler, süresi dolmak üzere olan onaylar,
   başarısız işler, onay bekleyen deploy'lar, onay bekleyen otomasyonlar. Geri kalanı
   **Settings → Notifications** ekranındaki yeni **Push** sütunundan seçilir.
5. **Send test notification** ile deneyebilirsin.

Bildirime dokununca ilgili sayfa açılır (ör. onay ekranı). Bildirimde sadece kısa bir başlık ve tek satır
metin olur; gizli bilgi, prompt ya da iş çıktısı **asla** gönderilmez — ayrıntı için uygulamayı açarsın.

## iPhone notu
- Bildirimler **sadece ana ekrana eklenmiş uygulamada** çalışır, **iOS / iPadOS 16.4 veya üstü** gerekir.
  Safari sekmesinde "önce ana ekrana ekle" uyarısı görürsün.
- İzni ana ekrandaki uygulamanın içinden, butona dokunarak vermelisin.
- Odak modları ve bildirim özeti iOS ayarlarına göre davranır.

## Cihazları yönetmek
**Settings → Devices → Push devices**: bildirim alan her tarayıcı / uygulama listelenir; **Revoke** ile
kaldırılır. Şunlar da bildirimleri otomatik keser:
- Bu cihazda **Log out** (o cihaz kapanır), **Log out everywhere** veya şifre değişikliği (hepsi kapanır),
- güvenilen cihaz (trusted device) iptal edilirse ona bağlı push,
- uygulama **30 gün** hiç açılmazsa.

## Güncelleme ve çevrimdışı
- Yeni sürüm çıkınca üstte "**A new version of Remyral is available — Reload**" çıkar; sen basınca yenilenir
  (kendiliğinden yenilenmez, yarım kalan form kaybolmasın diye).
- İnternet yokken "You are offline" sayfası görünür. Cihazda hesabına ait hiçbir veri saklanmaz; sadece
  uygulamanın kendi dosyaları (kod, yazı tipi) önbellekte durur.

## Kurulumda gerekenler (yönetici, bir kere)
- VAPID anahtarı üretilip secrets klasörüne konur: `vapid.pem` (EC P-256, sadece master okur).
- Ortam değişkenleri: `PUSH_VAPID_PRIVATE_KEY_FILE=/run/secrets/remyral/vapid.pem` ve
  `PUSH_VAPID_SUBJECT=mailto:<operatör adresi>`. İkisi yoksa push kapalıdır, panel bunu söyler.
- Anahtar değişirse herkes bildirimi yeniden açmak zorunda kalır; anahtarı diğer anahtarlarla birlikte yedekle.

Teknik ayrıntı: `docs/design/p8-pwa.md`.
