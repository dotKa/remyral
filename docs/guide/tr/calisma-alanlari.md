# Remyral: Çalışma alanları (repo'suz işler)

## Ne değişti?
Artık kod deposuna bağlı olmayan işler için "çalışma alanı" (workspace) projeleri var: araştırma, rapor, dosya özetleme gibi genel işler.
Hazır bir tane geliyor: **General** (internete açık).

## Nasıl kullanırım?
1. Jobs sayfasında **General** düğmesi → iş oluşturma ekranı açılır.
2. Repo/branch alanı yok. Ne istediğini yaz; istersen dosya ekle (en fazla 10 dosya, tanesi 5 MB, toplam 10 MB; md, txt, csv, json, yaml, png, jpg, gif, webp, pdf).
3. İş bitince iş sayfasında **Artifacts** bölümü: önce özet (summary.md), sonra ajanın ürettiği dosyalar. Önizle ya da indir.
4. Devam ettirmek için "Continue in a new job": önceki işin çıktıları yeni işe girdi olarak eklenir.

## Yeni çalışma alanı açmak
Projects → Register project → Kind: **Workspace** → ağ erişimi seç:
- **none**: sadece yapay zeka sağlayıcısı (internet yok)
- **allowlist**: sadece yazdığın birkaç site
- **web**: herkese açık tüm HTTPS siteleri
Sonradan değiştirmek: proje → **Workspace** düğmesi (authenticator kodu ister, audit'e yazılır).
Hangi makinelerde çalışacağı: Projects → proje → Machines (repo gerekmez).

## Dosyalar ne kadar saklanır? (depolama politikası)
Proje → **Workspace** → **Storage** bölümü:
- **In use**: bu çalışma alanındaki işlerin dosyaları (çıktılar + girdiler) ne kadar yer tutuyor; kota varsa çubuk olarak gösterilir.
- **Edit storage policy** (authenticator kodu ister, audit'e yazılır):
  - **Keep files (days)**: biten işlerin bu kadar günden eski dosyaları silinir. Boş = iş durdukça kalır.
  - **Storage quota (MiB)**: en az 10 MiB. Dolunca biten işlerin en eski dosyaları yer açmak için silinir; hala çalışan işlerin dosyaları yüzünden yer açılamıyorsa yeni iş "storage_quota_exceeded" ile reddedilir.
- Çalışan/kuyruktaki işlerin dosyalarına asla dokunulmaz. Silinen dosya iş sayfasında "removed (retention)" ya da "removed (storage quota)" diye listede kalır; indirilemez, geri getirilemez.
- Master bunu birkaç dakikada bir kendisi uygular.

## Çalışma dosyaları (iş bitince silinmez)
- İşin çalıştığı klasörün **tamamı** (out/, ekran görüntüleri, taslaklar) iş bitince — başarılı da olsa başarısız da — makinede tutulur. Varsayılan **14 gün**: Ayarlar → Çalışma dosyaları (0 = eskisi gibi iş bitince sil). Proje kendi süresini koyabilir (proje → Ağ erişimi → "Bu projede saklama süresi").
- Makine başına üst sınır var (varsayılan 10 GiB); dolunca en eski, kimsenin beklemediği klasör silinir.
- Bekleyen bir yayın (deploy), devam eden bir iş ya da aktarım varken klasör **asla silinmez**; iş bittikten sonra da süre yeniden işler.
- İş sayfası → Ayrıntılar → Dosyalar ve Çıktılar: dosya ağacı, önizleme, tek dosya ya da zip indir, **Temizle**, **Repoya aktar** (yeni dal + PR ya da yeni private repo), **Siteye yükle** (yeniden üretmeden Deploy'dan yayınla).
- "Bu dosyalarla yeniden çalıştır", Düzelt, devam işleri ve sohbetten "önceki işin dosyalarıyla devam et" yeni işi **bu dosyalardan** başlatır (aynı makinede kopya, başka makinede master üzerinden aktarım).
- Görseller artık basık görünmez; tıklayınca büyür (←/→, Esc, telefonda kaydırma, indir).

## Workflow ve otomasyonlarda dosyalar
- **Workflow** (çok adımlı iş) artık çalışma alanında da çalışır: repo yok, "integrator" adımı yok. Başlatırken (iş oluşturma ekranı → Workflow) dosya ekleyebilir ya da bir işten devam edebilirsin; bu dosyalar **her adıma** verilir. Her adım ayrıca önceki adımların çıktılarını `<adım>-<dosya>` adıyla alır (ör. `gather-notes.md`).
- **Otomasyon** (Automations → New) çalışma alanı projesinde **Input files** ve **Continue from** gösterir:
  - dosyalar her çalıştırmada işe kopyalanır;
  - **From its last run**: her çalıştırma bir öncekinin sonucunu alır (haftalık rapor gibi);
  - **From the run that triggered it**: "After another automation" tetikleyicisinde, onu tetikleyen işin sonuçları;
  - **From a job**: seçtiğin bir işin sonuçları (o işe erişimin olmalı; her çalıştırmada tekrar kontrol edilir).
- İş oluşturma ekranında "At a time" / "Repeat" ile zamanladığın işlerin dosyaları da artık saklanır.

## Bilmen gerekenler
- Dosyalarında şifre/anahtar varsa yükleme reddedilir ("input_secret_detected"): o satırı silip tekrar yükle.
- Çıktılardaki şifre benzeri değerler maskelenir; HTML/SVG gibi riskli dosyalar geri gelmez, özette nedeni yazar.
- "web" açıkken ajan internetteki sayfaları okuyabilir. Sayfalardaki talimatlar ajanı yetkilendiremez, ama ajan bildiklerini (prompt, dosyalar) bir siteye gönderebilir. Gizli bilgiyi prompt'a veya dosyaya koyma; hassas işte "none" ya da "allowlist" kullan.
- Eski sürüm worker'lar bu işleri alamaz ("workspace_unsupported"): worker'ı güncelle.

## Hata görürsen
- İş kuyrukta bekliyor, neden "workspace_unsupported": atanmış makinelerin hepsi eski sürüm → güncelle.
- "workspace project not allowed": proje o makineye atanmamış → Projects → proje → Machines.
- İş yarıda bağlantı kaybıyla düştüyse otomatik tekrar denenmez (internette yaptığı şeyler doğrulanamaz): "Continue in a new job" ile devam et.
