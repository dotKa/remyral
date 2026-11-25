# Remyral: GitLab ve Bitbucket bağlantısı

## Ne geldi?
Projelerin deposu artık GitHub dışında **GitLab** (gitlab.com ya da şirketin kendi GitLab'ı) ve **Bitbucket Cloud**
üzerinde de olabilir. Akış aynı: iş doğrulanır, merge request (GitLab) / pull request (Bitbucket) açılır, çakışma
kontrolü ve CI görünür, onaydan sonra birleştirmeyi Remyral yapar. Anahtarlar master'da şifreli durur, bir daha
gösterilmez, modele hiç gitmez (ADR-0061).

## 1. Anahtar oluştur

### GitLab
- **Önerilen:** grubun **Grup erişim anahtarı** (Grup → Settings → Access tokens).
  - Rol: **Maintainer** (birleştirme için).
  - Kapsam: **api**.
  - Bitiş tarihi zorunlu; Remyral bitişi kendisi okur ve 30 / 14 / 7 / 1 gün kala hatırlatır.
- Tek proje için: **Proje erişim anahtarı** (Proje → Settings → Access tokens), aynı rol ve kapsam. Bu anahtar yeni
  proje açamaz.
- **Makineler için itme anahtarı (önerilir):** ikinci bir anahtar, rol Developer, kapsam yalnızca **write_repository**.
  Girmezsen makineler api anahtarını alır (konsol uyarır).
- **Şirket içi ağdaki GitLab:** sunucu yalnızca herkese açık adreslere bağlanır. GitLab özel bir adresteyse tam adresini
  (`https://gitlab.sirket.example` gibi) Sunucu ayarları → **İç adresler** listesine (ya da sunucu ortamında
  `OPS_INTERNAL_ORIGINS`) ekle. Anahtar başka bir adrese yönlendirmeyle hiçbir zaman gönderilmez.

### Bitbucket Cloud
- **Depo erişim anahtarı** (Repository settings → Access tokens) ya da tüm depolar için **çalışma alanı / proje erişim
  anahtarı**.
  - Kapsamlar: **repository:write**, **pullrequest:write**, **pipeline** (CI durumunu okumak için).
  - Depo açmak istiyorsan çalışma alanı / proje anahtarında **repository:admin** da gerekir.
- App password kullanma: Atlassian kapatıyor.
- **Makineler için itme anahtarı (önerilir):** yalnızca **repository:write** kapsamlı ikinci bir anahtar.
- Bitbucket anahtarın bitişini bildirmez: biliyorsan bitiş tarihini formda gir.

## 2. Remyral'a bağla
Ayarlar → **Entegrasyonlar** → **GitLab ve Bitbucket** → "GitLab / Bitbucket bağla".
1. Sağlayıcı, ad (ör. "Şirket GitLab"), GitLab adresi (gitlab.com ya da `https://git.sirket.example`; `/api/v4` ekleme).
2. Anahtar türü ve **kapsamı**: grup anahtarı → `grup` (alt grup: `grup/alt`), proje anahtarı → `grup/proje`,
   Bitbucket depo anahtarı → `calisma-alani/depo`, çalışma alanı anahtarı → `calisma-alani`.
3. Anahtarı (ve itme anahtarını) yapıştır → **Bağlantıyı test et** → yeşil yazı gelince **Bağlantıyı kaydet**
   (taze doğrulama kodu ister).

## 3. Projeye seç
Projeler → proje → **Depo** → Düzenle → Sağlayıcı: GitLab ya da Bitbucket Cloud → Bağlantı → (istersen "Bağlantıyı
test et") → listeden depoyu seç → temel dal, birleştirme yöntemi (merge / squash), "Birleştirmeden önce CI geçmeli" →
kaydet (doğrulama kodu).

## 4. Dal koruması (şart)
- GitLab: Settings → Repository → Protected branches → `main`: push "No one" (ya da Maintainers), merge Maintainers.
- Bitbucket: Repository settings → Branch restrictions → `main`: doğrudan push yok, merge için PR.
Depo kartındaki rozet korumayı gösterir.

## 5. Anahtar yenileme
- **GitLab:** kartta "Anahtarı GitLab'da yenile" → GitLab yeni anahtar üretir, eskisi hemen biter, Remyral yenisiyle
  devam eder (90 gün). İtme anahtarı kendini yenileyemez: süresi yaklaşınca GitLab'da yenisini oluştur, kartta
  "Yeni anahtar gir".
- **Bitbucket:** yeni anahtar oluştur → kartta "Yeni anahtar gir" (önce test edilir) → eskisini Bitbucket'ta sil.
- Ayarlar → Operasyon güvenliği → **Anahtarlar ve süreler** listesinde her iki anahtar da görünür.

## 6. Bilinmesi gerekenler
- Rebase ile birleştirme sunulmuyor (merge / squash var). GitLab'da birleştirme projenin ayarına uyar.
- GitHub'a özel şeyler (GitHub olayıyla otomasyon, GitHub App, workflow'daki github.comment adımı) GitLab / Bitbucket
  projelerinde çalışmaz. GitLab / Bitbucket webhook'larıyla otomasyon sonraki iş.
- Asistan "GitLab'da proje aç" deyince grup / çalışma alanı anahtarıyla depo açıp projeye bağlayabilir; anahtarı sohbete
  asla yazma.

## İlk deneme
Bir test grubunda grup anahtarı + itme anahtarı → bağla → test projesini kaydet → küçük "trusted" iş → MR açılır →
onayla → merge. Aynısını bir Bitbucket test deposunda.
