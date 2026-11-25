# Remyral: Yedekleme ve geri yükleme tatbikatı

## Ne bu?
Kontrol düzlemi (panel) **kendi yedeğini kendisi alıyor** ve **her hafta bu yedeği gerçekten geri
yükleyip kontrol ediyor**. Sunucuya ayrıca bir şey kurulmuyor: yedekleme, panelin kendi Docker projesinde küçük
bir `backup` servisi olarak çalışıyor.

- **Her gece 02:30 (UTC)**: veritabanının tamamı (işler, çıktılar, sohbet ekleri, denetim kaydı…) tutarlı bir
  anlık görüntüyle yedeklenir. Yanına bir "manifest" yazılır: şema sürümü, tablo satır sayıları, birkaç kaydın parmak
  izi, dosyanın SHA-256'sı.
- **Sırlar** (`stack.env`, `secrets/` klasörü: TOTP anahtarı, imza anahtarları, VAPID anahtarı…) **senin anahtarınla
  şifrelenerek** arşivlenir. Sunucuda bu arşivi açabilecek bir anahtar **yok** — sadece senin elindeki gizli anahtar
  açar.
- **Saklama:** son 7 gün (günde 1), son 4 hafta (haftada 1), son 3 ay (ayda 1).
- **İsteğe bağlı sunucu dışı kopya:** AWS S3 veya Cloudflare R2'ye **şifreli** kopya (sunucu kaybolsa da yedek kalır).
- **Her pazar 04:00 (UTC) tatbikat:** en son yedek, dışarıya kapalı geçici bir veritabanına geri yüklenir; şema,
  satır sayıları, örnek kayıtlar ve denetim kaydının hash zinciri kontrol edilir, süre ölçülür, sonra geçici
  veritabanı silinir.
- **Panelde:** Settings → **Backups**: son yedek, boyutu, sunucu dışı kopya durumu, son tatbikat sonucu ve süresi.
  Yedek dosyası panelden **indirilemez** (bilerek: bir oturum çalınırsa tüm veritabanı tek tıkla gitmesin).
- **Uyarı:** yedek başarısız olursa, eksik kalırsa (ör. S3'e yüklenemedi), gecikirse ya da tatbikat başarısız olursa
  sana (owner/admin) bildirim gelir: "Backup failed", "Restore drill failed".

Redis yedeklenmez: içinde sadece kuyruk ipuçları ve hız sınırı sayaçları var; geri yüklemede boş başlaması doğru.

## Kurulum
1. **Yedek anahtarı (age):** yedeklerdeki sırlar senin age anahtarınla şifrelenir.
   - Anahtar üret: `age-keygen -o identity.txt` ve `age-keygen -o break-glass.txt`, sonra
     `age-keygen -y identity.txt > recipients.txt` ve `age-keygen -y break-glass.txt >> recipients.txt`.
   - `identity.txt` → parola yöneticisine; `break-glass.txt` → çevrimdışı (yazdır / USB, kasada); ikisini de
     bilgisayarından sil. **İkisi de kaybolursa şifreli yedekler açılamaz.**
   - Sunucuya yalnızca `recipients.txt` (açık anahtarlar) gider (kurulumda `--backup-recipient age1…`).
2. **(İsteğe bağlı ama önerilir) Sunucu dışı kopya:**
   - **Cloudflare R2** (kolay): Cloudflare → R2 → bucket oluştur (ör. `remyral-backups`) → "Manage R2 API Tokens" →
     **Object Read & Write**, sadece bu bucket. Gerekenler: Account ID (endpoint için), Access Key ID, Secret Access
     Key, bucket adı. Bucket ayarlarında yaşam döngüsü kuralları: `remyral/frequent/` 2 gün, `remyral/daily/` 8 gün,
     `remyral/weekly/` 36 gün, `remyral/monthly/` 100 gün.
   - **AWS S3**: bucket + sadece `remyral/*` altına `PutObject` ve `GetObject` izni olan bir kullanıcı; bölge, anahtar
     ve bucket adı.
   - Bu bilgiler sunucuda yalnızca root'un okuyabildiği `backup-config/offsite.env` dosyasında durur, repoya asla
     girmez. Token **silme izni olmadan** da çalışır (sistem uzaktaki yedekleri hiç silmez; eskileri bucket'ın yaşam
     döngüsü kuralı siler).
3. **Yedek sıklığı (RPO):** varsayılan gecede bir → en kötü durumda **24 saat** veri kaybı. Daha sık istersen
   `BACKUP_INTERVAL_MINUTES` ayarını değiştir (ör. `60`). Daha kısa kayıp için WAL arşivi:
   [kesinti-yedek.md](kesinti-yedek.md).

## Sunucu tamamen giderse?
Adım adım kılavuz: `docs/ops/backup-restore.md` §5. Özetle: yeni sunucu → sunucu dışı kopyadan en son yedeği indir →
**kendi bilgisayarında** `age -d -i identity.txt` ile aç → sırları ve veritabanını yeni sunucuya geri yükle → deploy →
DNS'i yeni sunucuya çevir. Hedef süre (RTO): **2 saatin altında**. Haftalık tatbikat geri yükleme adımının
süresini zaten ölçüyor.
