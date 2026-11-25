# Remyral: Dosya depolama (S3, Cloudflare R2, MinIO ya da ana sunucunun diski)

## Ne bu?
İşlerin ürettiği dosyalar — uygulama paketleri (APK, AAB, IPA), Windows kurulumları (EXE, MSI), macOS paketleri (DMG,
PKG), arşivler (ZIP, TAR.GZ), videolar (MP4, WEBM), büyük analiz verileri — ve diğer dosyalar (iş girdileri, yüklenen
siteler, worker sürümleri ve kurulum paketleri) artık **veritabanında tutulmaz**. Ya senin seçtiğin bir **nesne
depolama kovasında** (Amazon S3, Cloudflare R2, MinIO) ya da hiçbir şey seçmezsen **ana sunucunun diskinde** (bir
birim) durur. Dosya başına 2 GB'a kadar çıktılar üretilebilir ve indirilebilir.

Nerede?
- **Ayarlar → Entegrasyonlar → Depolama** (`/settings/integrations?tab=storage`): yalnızca **sahip** değiştirebilir,
  her değişiklikte yeni bir doğrulama kodu ister. Yöneticiler ayarları görebilir.
- **Çıktılar → dosya**: "Konum" satırı dosyanın nerede olduğunu söyler (**S3'te**, **Diskte**, ya da taşınmayı bekleyen
  eski dosyalar için **Veritabanında**). **İndir**, **S3'te aç** ve **Paylaşılabilir bağlantı** buradadır.
- **Ayarlar → Tanılama**: "Dosya depolama" kontrolü kovaya ulaşılıp ulaşılamadığını, diskte ne kadar yer kaldığını ve
  veritabanında hala dosya olup olmadığını söyler.

## Hangisini seçmeliyim?
- **Ana sunucunun diski** (varsayılan): kurulum gerektirmez. Dosyalar `blobdata` biriminde durur ve yedekleme servisi
  onları şifreleyerek yedeğe (ve uzak yedeğe) kopyalar. Diski büyük çıktılara göre boyutlandır; Tanılama yer
  azalınca uyarır.
- **Cloudflare R2**: aylık ücretsiz kota, **dışarı veri çıkışı ücretsiz** (indirmeler için iyi). Önerilen seçenek.
- **Amazon S3**: ana sunucu AWS'deyse aynı bölgede okumalar ücretsizdir.
- **MinIO**: kendi sunucunda S3 uyumlu depolama.

## Cloudflare R2 kurulumu (adım adım)
1. Cloudflare panelinde **R2 Object Storage → Create bucket**. Ad örneği: `remyral-outputs`. Konum: otomatik.
   **Public access kapalı kalsın** (varsayılan). CORS ayarı gerekmez.
2. **R2 → Manage R2 API Tokens → Create API token**:
   - İzin: **Object Read & Write**.
   - Kapsam: **Apply to specific buckets only → remyral-outputs** (yalnızca bu kova).
   - Süre (TTL): istersen bir yıl; dolmadan önce yenisini oluştur.
   - **Create** dedikten sonra gösterilen **Access Key ID** ve **Secret Access Key** değerlerini kopyala (gizli anahtar
     bir daha gösterilmez). Aynı sayfadaki **S3 endpoint** adresi de lazım:
     `https://<hesap kimliği>.r2.cloudflarestorage.com`.
3. Remyral'de **Ayarlar → Entegrasyonlar → Depolama**:
   - **Nereye**: Nesne depolama (S3 uyumlu) · **Sağlayıcı**: Cloudflare R2.
   - **Kova adı**: `remyral-outputs` · **Uç nokta adresi**: yukarıdaki S3 endpoint.
   - **Bölge**: `auto` (R2 seçince kendiliğinden dolar) · **Yol tarzı adresleme**: açık.
   - **Önek** (isteğe bağlı): `prod/` — aynı kovayı başka bir kurulum da kullanacaksa her birine ayrı önek ver.
   - **Erişim anahtarı kimliği** ve **Gizli erişim anahtarı**: R2'den kopyaladıkların.
   - **Kaydet** → doğrulama kodu. Remyral önce kovaya küçük bir dosya yazar, okur ve siler; bu deneme geçmezse hiçbir
     şey değişmez ve hata kodu ile bir ipucu gösterilir (ör. `AccessDenied`: token'ın bu kovaya izni yok).
4. **Bağlantıyı test et** ile istediğin zaman yeniden deneyebilirsin.

## Amazon S3 kurulumu (adım adım)
1. **S3 → Create bucket**: ad örneği `remyral-outputs-<şirket>`, bölge ana sunucunla aynı (ör. `eu-central-1`).
   **Block all public access açık kalsın**, **Bucket Versioning: Enable**. Varsayılan şifreleme SSE-S3 yeterli.
2. **Lifecycle rule** ekle (önerilir): eski sürümleri (noncurrent versions) 35 gün sonra sil; tamamlanmamış çok
   parçalı yüklemeleri 1 gün sonra sil.
3. **IAM → Users → Create user** (ör. `remyral-storage`, konsol erişimi yok) ve şu satır içi politikayı ekle (kova
   adını ve öneki kendininkiyle değiştir; panelde aynı metin "En az yetkili kova politikası" altında kopyalanabilir):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RemyralBlobObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::remyral-outputs-sirket/prod/*"
    }
  ]
}
```

   SSE-KMS kullanacaksan bu kullanıcıya o KMS anahtarı için `kms:Encrypt`, `kms:Decrypt` ve `kms:GenerateDataKey` izni
   de ver. Listeleme (`s3:ListBucket`), ACL ya da kova politikası değiştirme izni **verme**: Remyral'in buna ihtiyacı yok.
4. Kullanıcı için **Create access key** (Application running outside AWS) → anahtar kimliği ve gizli anahtar.
5. Remyral'de **Depolama**: Sağlayıcı **Amazon S3**, **uç nokta boş**, bölge kovanın bölgesi, yol tarzı kapalı, önek
   `prod/`, şifreleme isteğe göre **SSE-S3** ya da **SSE-KMS** (KMS anahtar kimliği/ARN ile), anahtarlar → **Kaydet**.

## MinIO
Uç nokta MinIO adresin (`https://minio.sirket.local:9000` gibi; düz `http://` yalnızca aynı makinedeki bir MinIO için
kabul edilir), bölge `us-east-1`, yol tarzı açık. Yukarıdaki politikayı MinIO'da bir kullanıcıya bağla.

## Sınırlar
**Depolama → Sınırlar** (sahip):
- **Dosya başına en çok**: varsayılan 2048 MiB (2 GB). **İş başına en çok**: varsayılan 5120 MiB.
- **Doğrudan yükleme eşiği**: bu boyuttan büyük her çıktı ve her kurulum, arşiv ya da video dosyası işçiden doğrudan
  depolamaya yüklenir (varsayılan 4 MiB).
- **İndirme bağlantısının ömrü**: varsayılan 300 saniye. **Paylaşım bağlantısı en çok**: varsayılan 7 gün.
- **Proje başına saklama süresi ve kota**: **Projeler → <proje> → Çalışma alanı** ayarlarında (gün; boş bırakılırsa
  dosyalar iş durdukça saklanır). Süresi dolan dosyalar silinir, iş kaydında "kaldırıldı" olarak kalır.

## İndirme, "S3'te aç" ve paylaşım bağlantısı
- **İndir**: Remyral yetkini kontrol eder ve kısa ömürlü imzalı bir bağlantıyla dosyayı indirir (diskteyse dosyayı
  doğrudan gönderir). Bağlantı birkaç dakika sonra geçersiz olur.
- **S3'te aç**: PDF, resim ve videoları tarayıcının kendi görüntüleyicisinde açar (kovanın adresinde, Remyral'in
  sayfasında değil).
- **Paylaşılabilir bağlantı** (sahip ve yöneticiler): gün sayısını seç → **Bağlantı oluştur** → doğrulama kodu.
  Bağlantı **yalnızca bir kez** gösterilir; kopyala. Bağlantıyı bilen herkes süre dolana kadar dosyayı indirebilir.
  Her açılış denetim kaydına yazılır; listeden **İptal et** ile hemen kapatabilirsin. Dosya saklama süresiyle
  silinirse bağlantı da çalışmaz.

## Eski dosyaları veritabanından taşımak
Bu sürümden önce saklanan dosyalar veritabanındadır (Depolama ekranında "… dosya hala veritabanında" yazar). Ana
sunucuda bir kez çalıştır:

```
docker exec <master konteyneri> remyral-master blobs:migrate --dry-run   # yalnızca sayar
docker exec <master konteyneri> remyral-master blobs:migrate             # taşır
```

Her dosya taşınmadan önce ve sonra SHA-256 ile doğrulanır; doğrulanamayan dosya yerinde kalır ve raporda listelenir.
Yarıda kalırsa aynı komutu yeniden çalıştırman yeterli. Taşıma bitince veritabanı yedekleri küçülür. Sohbet ekleri,
otomasyon dosyaları, iş akışı çalıştırma dosyaları ve .zip girdi paketleri de aynı komutla taşınır (bu türlerin yeni
dosyaları zaten depoya yazılır).

## Dosyaları diskten kovaya (ya da geri) taşımak
Yerel diskten bir kovaya geçtiysen, eski dosyaları da kovaya taşıyabilirsin (önce Depolama ekranında kovayı kaydet):

```
docker exec <master konteyneri> remyral-master blobs:migrate --to-store s3 --dry-run   # kaç dosya, kaç bayt
docker exec <master konteyneri> remyral-master blobs:migrate --to-store s3             # diskten kovaya
docker exec <master konteyneri> remyral-master blobs:migrate --to-store local          # kovadan diske
```

Her dosya kopyalanır, kopya geri okunup SHA-256 ile doğrulanır, kayıt yeni kopyayı gösterir ve ancak ondan sonra eski
kopya silinir. Yarıda kalırsa (ağ hatası, kapanan sunucu) hiçbir dosya kaybolmaz: aynı komutu yeniden çalıştır, kalan
eski kopyaları önce siler, sonra kaldığı yerden devam eder. Komut yeni dosyaların nereye yazılacağını değiştirmez;
bunu Depolama ekranındaki seçim belirler.

## Güvenlik notları
- Anahtarlar sunucuda şifreli saklanır; ekranda, kayıtlarda, işçilerde ve sohbet asistanında hiçbir zaman görünmez.
  İşçiler yalnızca **tek bir dosya için, kısa ömürlü** imzalı yükleme adresleri alır.
- Kova **herkese kapalı** kalmalı; herkese açık ACL ya da politika ekleme. CORS gerekmez.
- **Anahtar yenileme**: sağlayıcıda yeni bir anahtar oluştur, Depolama ekranında yeni anahtarları girip kaydet (test
  geçince devreye girer), sonra sağlayıcıda eski anahtarı sil. Yılda en az bir kez önerilir.
- Remyral her yüklenen dosyayı kovadan geri okuyup boyutunu ve SHA-256'sını kendisi doğrular; doğrulanmayan dosya iş
  çıktısı olarak kaydedilmez.
- Büyük dosyalar işçide gizli bilgi taramasından geçer (bulunursa dosya döndürülmez). Sıkıştırılmış arşivlerin içi
  açılıp taranmaz: arşive gizli bilgi koyma.

## Yedekleme
- **Diskte** saklanan dosyalar yedekleme servisi tarafından sahip anahtarına şifrelenerek yedeğe ve uzak yedeğe
  kopyalanır. Silinen dosyalar yedekte 35 gün daha durur (`BACKUP_BLOB_KEEP_DELETED_DAYS`).
- **Kovada** saklanan dosyalar için kova kendi yedeğidir: **sürümlendirmeyi aç** ve yukarıdaki yaşam döngüsü kuralını
  ekle. Veritabanı yedeği dosyaların kaydını, anahtarları (şifreli) ve ayarları tutar.
- Geri yükleme adımları: [docs/ops/backup-restore.md](../../ops/backup-restore.md) §12.

## Sık sorulanlar
- **Diskten kovaya geçersem eski dosyalar ne olur?** Diskte kalır ve okunmaya devam eder; yeni dosyalar kovaya gider.
- **Kovadan diske dönersem?** Kovadaki dosyalar ayarlar ve anahtarlar silinmediği sürece okunmaya devam eder.
- **Eski worker sürümlerinde ne olur?** Eski worker'lar dosyaları eskisi gibi küçük parçalarla gönderir (dosya başına
  5 MiB, uygulama paketleri 80 MiB sınırıyla); büyük kurulum, arşiv ve video dosyaları için worker'ı güncelle.
