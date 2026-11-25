# Remyral: GitHub bağlantısı (panelden)

> GitLab ya da Bitbucket kullanıyorsan: [gitlab-bitbucket.md](gitlab-bitbucket.md).

## Ne değişti?
GitHub artık **panelden** bağlanıyor. Sunucuya SSH ile `.pem` kopyalamak, App id / installation id yazmak yok.
Anahtar master'da şifreli saklanır, hiçbir ekranda görünmez (ADR-0022).

## Bir kere bağlamak
1. Master'da `PUBLIC_ORIGIN` ayarlı olmalı (GitHub geri dönüş adresi).
2. Settings → **Integrations** → GitHub → "My GitHub account" ya da "An organization" → **Connect GitHub**
   (taze authenticator kodu).
3. GitHub sayfası açılır: App adı `Remyral <konsol adresi>`, izinler (contents + pull requests yazma; checks,
   commit statuses, issues, metadata okuma; otomasyonlar için webhook) → **Create GitHub App**.
4. Konsola dönülür, bağlantı tamamlanır. Sonra **Install on repositories** → sadece Remyral'ın çalışacağı repolar.

## Projeye repo seçmek
Projects → proje → Repository → Edit → listeden repoyu seç (arama var). URL, installation, App ve varsayılan dal
kendiliğinden dolar. Merge yöntemi ve "Require passing CI" eskisi gibi. Elle URL girmek: "Enter URL manually
(advanced)".

## Dal koruması (şart)
GitHub → repo → Settings → Rules → Rulesets: `main` için güncelleme/silme/force-push engeli + "Require a pull
request". Panel her projede uyarır: "main has no protection rule".

## Anahtar yenileme / bağlantıyı kesme
- Kartta anahtarın yaşı görünür. **Rotate key:** GitHub'daki App ayarlarında yeni private key üret → `.pem`'i
  karta yükle → eski anahtarı GitHub'da sil.
- **Disconnect:** master anahtarı ve kurulumları unutur; hangi projelerin etkilendiğini söyler. App'i GitHub'dan
  sen silersin.
- Eski yöntem (sunucuda key dosyası, `GITHUB_APP_ID`) çalışmaya devam eder; ikisi birden varsa panel App'i öncelikli.

## İlk deneme
docs/ops/github-app.md §6: bağla → bir test reposuna kur → ruleset ekle → projeye seç → küçük "trusted" iş →
PR açılır → Approvals'tan onayla → merge.
