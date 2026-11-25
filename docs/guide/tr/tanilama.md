# Remyral: Tanılama (doctor) ve destek raporu

Tanılama, kurulumunun sağlıklı olup olmadığını tek ekranda gösterir: kontrol düzlemi (ana sunucu) ve bağlı makineler
denetlenir, her sorun için ne bulunduğu, ne yapman gerektiği ve düzeltildiği sayfanın bağlantısı yazar. Gerekirse
maskelenmiş bir destek raporu hazırlayıp indirebilir ya da e-postayla gönderebilirsin.

Konsol ve makine yazılımı bu sayfadaki bölümlere doğrudan bağlantı verir; aşağıdaki başlıklar bu yüzden sabittir.

## Nerede?

- **Ayarlar → Tanılama** (sahip ve yöneticiler): **Tanılamayı çalıştır** kontrol düzlemini ve isteğe bağlı olarak bağlı
  bütün makineleri tek tıkla denetler.
- Her bulgunun bir önemi vardır: **hata**, **uyarı**, **not** ya da **geçti**. Geçen kontroller istenirse görünür.
- **Günlük hafif kontrol:** her gün bir kez kendiliğinden çalışır; yalnızca **yeni** (ya da geri dönen) sorunlarda sahip
  ve yöneticilere bildirim gönderir.
- **Makineler → makine → Doktoru çalıştır:** tek bir makinenin kendi tarafını denetler.
- **Sohbet:** "neyi düzeltmeliyim?", "tanılama çalıştır" dersen asistan doktoru çalıştırıp sorunları önerileriyle
  sıralar; "destek kaydı oluştur" dersen rapor gönderme kartı açar.
- **Sunucuda:** `sudo remyral-ctl doctor` aynı kontrolleri sunucudan çalıştırır (makineler hariç).

<a id="kontroller"></a>

## Kontroller (ana sunucu)

- **Veritabanı ve Redis:** yanıt veriyor mu, ne kadar hızlı; migration'lar uygulanmış mı; disk doluluğu (veri diski,
  Docker diski); web arayüzü.
- **Kuyruk:** uzun süredir bekleyen iş; takılan iş (lease süresi geçmiş ya da lease'siz); onay bekleyen ama karar
  verilecek isteği olmayan iş; açık kalmış, süresi geçmiş lease.
- **Makineler:** çevrimdışı; boş disk sınırının altında; saati ana sunucudan farklı; eski makine yazılımı; runtime
  girişi eksik; sandbox hazır değil; git sorunları.
- **Anahtarlar ve sertifikalar:** süresi dolan ya da dolmak üzere olanlar (Ayarlar → Operasyon güvenliği kayıtlarından;
  bkz. [operasyon-guvenligi.md](operasyon-guvenligi.md)).
- **Entegrasyonlar:** Coolify / Cloudflare / GitHub bağlantılarının son testleri; sohbet asistanı ve yedek makineleri;
  sürüm akışı; yedeklerin yaşı.
- **Son bir saat:** sunucu hataları (HTTP 5xx), kayıtlarda hata patlaması, kapatılmış webhook'lar, devrede olan maliyet
  freni.

Bir bulgunun bağlantısı seni genellikle doğrudan ilgili ekrana (ör. Makineler, İşler, Ayarlar → Sistem) götürür.

<a id="makine-doktoru"></a>

## Makine doktoru (makinede)

Makine doktoru, makinenin kendi tarafını denetler ve ana sunucuya ulaşamayan bir makinede de çalışır.

```sh
remyral-worker doctor              # okunabilir özet
remyral-worker doctor --json       # ayrıntılı çıktı
remyral-worker doctor --out doktor.zip   # maskelenmiş rapor dosyası
```

Baktığı şeyler: yapılandırma dosyası; ana sunucunun adı çözümleniyor mu (DNS); bağlantı ve TLS sertifikası; ana
sunucunun yanıtı; saat farkı; servis çalışıyor mu; veri klasörünün izinleri; boş disk; Node / npm; git; runtime'lar
(kurulu mu, sürümü, giriş yapılmış mı); sandbox; makine yönetimi (ayrıcalıklı yardımcı oturum başlatabiliyor mu).

Doktor **hiçbir şeyi değiştirmez** ve gizli değer yazmaz. Bir hata bulursa 1 koduyla çıkar.

Sık görülen sorunlar:

- **Ana sunucuya bağlanamıyor:** yapılandırmadaki adresi, DNS'i ve güvenlik duvarını kontrol et; makine sunucuya
  dışarıya doğru `wss://` ile bağlanır.
- **Makine yönetimi kullanılamıyor:** bu sürümün kurulum paketini makinede bir kez root / Administrator olarak yeniden
  çalıştır.
- **Runtime girişi yok:** Makineler → makine → Uzak işlemler'den giriş yap (bkz. [uzaktan-islemler.md](uzaktan-islemler.md)).

<a id="saat"></a>

## Saat farkı

Makinenin saati ana sunucudan **1 dakikadan** fazla farklıysa uyarı, **2 dakikadan** fazla farklıysa hata verilir. İmzalı
komutlar, lease'ler ve girişler saate bağlıdır. Çözüm: makinede otomatik saat eşitlemeyi aç (Linux'ta NTP /
`timedatectl set-ntp true`, macOS'ta Tarih ve Saat → otomatik, Windows'ta Windows Saati hizmeti).

<a id="disk"></a>

## Disk

- **Ana sunucu:** veri diski %85 dolulukta uyarı, %95'te hata verir. Eski yedekleri ve kullanılmayan Docker
  imajlarını temizle (`docker image prune`), gerekirse diski büyüt.
- **Makine:** boş alan `workspace.minFreeBytes` sınırının altına düşünce o makineye yeni iş verilmez. Tutulan eski
  çalışma klasörlerini temizle ya da sınırı makinenin diskine göre ayarla.

<a id="veritabani"></a>

## Veritabanı

Veritabanı yanıt vermiyorsa: kontrol düzleminin kapsayıcılarının çalıştığını (`sudo remyral-ctl status` ya da
Coolify gibi kullandığın platformun paneli) ve `DATABASE_URL` ayarının doğru olduğunu kontrol et. Yanıt yavaşsa
sunucunun yükünü ve boş diskini kontrol et.

<a id="redis"></a>

## Redis

Redis yanıt vermiyorsa: Redis kapsayıcısının çalıştığını ve `REDIS_URL` ayarının doğru olduğunu kontrol et. Redis yalnızca
kuyruk ipuçlarını ve hız sınırı sayaçlarını tutar; yeniden başlatmak veri kaybettirmez.

<a id="gocler"></a>

## Migration'lar

- **"Uygulanmamış migration":** ana sunucuyu yeniden başlat; migration'lar açılışta uygulanır.
- **"Veritabanında daha yeni migration":** veritabanı, çalışan sürümden daha yeni bir sürümle taşınmış. Veritabanına uyan
  (ya da daha yeni) sürümü kur; geri sürüme dönüş desteklenmez (güncelleme öncesi yedekle geri dönmek için bkz.
  [kurulum.md](kurulum.md), "Güncelleme").

## Destek raporu

**Ayarlar → Tanılama → Destek raporu:** sorunu anlat, eklenecek bölümleri seç, **Önizle** ile zip'in içindeki her
dosyayı ve özeti gör, sonra **Zip'i indir** ya da **Raporu e-postayla gönder**.

Raporda olanlar:

- doktor sonuçları ve makine doktorları, sistem durumu, sürümler;
- izin listesindeki ayarlar (değer, "ayarlı mı" bilgisi, sayı ya da yalnızca adresin kökü);
- son 1–72 saatin uyarı / hata kayıtları (en çok 5000 satır);
- başarısız işlerin özeti (kimlik, durum, neden).

Raporda olmayanlar: parolalar, token'lar, anahtarlar, veritabanı adresinin kendisi, iş çıktıları ve dosyalar. İş
istemleri yalnızca **İş istemleri** kutusunu kendin işaretlersen eklenir.

- Her değer ve her dosya maskeleme filtresinden geçer; `manifest.json` her dosyanın boyutunu ve SHA-256 özetini listeler.
- 10 MB'tan büyük rapor e-postaya eklenmez, yalnızca özet gider; zip'i indirip başka bir yoldan paylaşabilirsin.
- Her gönderim denetim kaydına yazılır: kim, kime, boyut, bölümler, özet (hash).

### Destek ayarları

- **Rapor adresi:** raporun gönderileceği e-posta adresi. Yeni kurulumda boştur; adres girilene kadar rapor yalnızca
  indirilebilir. Adresi yalnızca sahip değiştirir.
- **E-posta sunucusu:** ana sunucunun bildirim için kullandığı SMTP ayarları (`NOTIFY_SMTP_*`) kullanılır ya da burada
  ayrı bir SMTP sunucusu girersin (ör. sağlayıcının 587 STARTTLS sunucusu, gönderen adres, kullanıcı adı, parola).
  Parola şifreli saklanır ve bir daha gösterilmez.
- **Güvenlik:** rapor göndermek güvenlik ayarına bağlıdır: Serbest'te kod istemez; Dengeli ve Sıkı'da authenticator kodu
  ister (Ayarlar → Güvenlik → "Tanılama raporunu … gönderme" olayı).

İlk kurulumdan sonra bir kez **Tanılamayı çalıştır** → **Önizle** → kendine gönder ile e-postanın ulaştığını doğrulaman
önerilir.
