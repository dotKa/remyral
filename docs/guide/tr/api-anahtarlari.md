# Remyral: API anahtarları ve servis hesapları

Dış otomasyonlar (CI, betikler, başka sistemler) Remyral API'sini tarayıcı oturumu olmadan, **API anahtarı** (token)
ile kullanır. Anahtarlar bir kişiye (kişisel token) ya da bir **servis hesabına** aittir ve hiçbir zaman sahibinin
rolünden fazlasını yapamaz.

## Kişisel API anahtarı

**Ayarlar → API anahtarları → Anahtar oluştur:**

- **Ad:** anahtarı nerede kullandığını hatırlatan bir ad (ör. "ci-deploy").
- **Yetkiler:** Okuma · İş yazma · Onaylar · Deploy · Yönetim. Yalnızca gereken yetkileri seç.
- **Süre:** varsayılan 90 gün; en uzun süreyi güvenlik politikası belirler.
- **IP aralıkları (isteğe bağlı):** anahtar yalnızca bu adreslerden kabul edilir.

Token **yalnızca bir kez** gösterilir (kopyala düğmesi ve hazır bir curl örneğiyle). Kaybedersen yenisini oluştur.
Kişisel token'lar `ryl_pat_` ile başlar.

Listede her anahtarın son kullanımı (zaman, IP), istek sayısı ve bitiş tarihi görünür; bitişe 7 gün kala uyarı çıkar.
Süresi dolmak üzere olan anahtarlar Ayarlar → Operasyon güvenliği listesinde de görünür.

- **Yenile:** yeni bir token üretir; eski token seçtiğin süre boyunca (varsayılan 60 dakika) çalışmaya devam eder,
  böylece otomasyonu kesintisiz güncelleyebilirsin.
- **İptal et:** token hemen çalışmaz olur.

Token oluşturmak ve yenilemek her güvenlik ayarında authenticator kodu ister; iptal etmek kod istemez.

## Servis hesapları

**Ayarlar → Servis hesapları** (yönetici): parolası olmayan ve konsola giriş yapamayan hesaplardır; yalnızca
token'larıyla kullanılır.

- **Rol:** yönetici, operatör ya da izleyici (servis hesabı sahip olamaz).
- **Proje üyelikleri:** hesabın erişebileceği projeler.
- **Token'lar:** kişisel token'larla aynı biçimde oluşturulur; `ryl_sa_` ile başlar.
- Hesabı **devre dışı bırakınca** bütün token'ları hemen durur.

Yöneticiler bu ekranda bütün kişisel anahtarları da görür ve gerekirse iptal edebilir.

## Güvenlik ayarları

**Ayarlar → Güvenlik → API anahtarları:**

- kişisel token'lara izin verilip verilmeyeceği,
- bir token'ın en uzun geçerlilik süresi,
- **kod isteyen işlem izni** (varsayılan kapalı).

Authenticator kodu isteyen işlemler token ile yapılamaz ve `token_step_up_refused` hatasıyla reddedilir. Güvenlik
politikasında kod istemeyen işlemler token ile yapılabilir. Kod isteyen işlemleri token'lara açmak mümkündür ama
önerilmez.

## Hızlı başlangıç

```sh
export REMYRAL_TOKEN=ryl_pat_…    # Ayarlar → API anahtarları → Anahtar oluştur

# Son beş iş
curl -H "Authorization: Bearer $REMYRAL_TOKEN" "https://<konsol>/api/jobs?limit=5"

# Yeni iş
curl -X POST "https://<konsol>/api/jobs" \
  -H "Authorization: Bearer $REMYRAL_TOKEN" -H "Content-Type: application/json" \
  -d '{"project":"web-shop","spec":{"runtime":"claude-code","prompt":"…",
       "repository":{"url":"https://github.com/acme/web-shop.git","baseRef":"main","workBranch":"fix/x"},
       "sandboxProfile":"container","sourceTrust":"trusted","approvalPolicy":"ask-sensitive",
       "limits":{"maxDurationSec":3600}}}'

# Bir işin durumu
curl -H "Authorization: Bearer $REMYRAL_TOKEN" "https://<konsol>/api/jobs/<id>"

# İptal
curl -X POST "https://<konsol>/api/jobs/<id>/cancel" \
  -H "Authorization: Bearer $REMYRAL_TOKEN" -H "Content-Type: application/json" -d '{"reason":"…"}'
```

Token ile yapılan isteklerde CSRF başlığı gerekmez.

## API belgesi

**Ayarlar → API:** bütün uç noktalar, her birinin gerektirdiği token yetkisi, şemalar, örnekler ve curl komutları. Aynı
belge makinece okunabilir biçimde `https://<konsol>/api/openapi.json` adresindedir.

## Sohbet

"API anahtarlarım", "hangi token'ın süresi doluyor?" gibi sorularda asistan anahtarları listeler; token değerini hiçbir
zaman görmez. Anahtar oluşturmak yalnızca konsoldan yapılır.

## Bir anahtarın süresi dolmak üzereyse

1. Ayarlar → API anahtarları → anahtar → **Yenile**.
2. Yeni token'ı kullanan yere (ör. CI sırrı) yaz.
3. Geçiş süresi bitmeden otomasyonun yeni token ile çalıştığını doğrula; eski token süre dolunca kendiliğinden durur.
