# Remyral: Otomasyonlar (zamanlanmış ve tetiklenen işler)

## Ne bu?
Bir **otomasyon** = "şu olunca → bu işi başlat". Eski "Schedules" bunun içine girdi (ADR-0024).
Dört tetikleyici var:
- **Zamanlama (cron / tek seferlik):** "her gün 03:00", "hafta içi 09:30", "15 Kasım 10:00'da bir kere". Saatler
  seçtiğin **saat diliminde** okunur (ör. `Europe/Istanbul`; formda varsayılan tarayıcının dilimi, sohbette senin
  dilimin; eskiden kurulanlar UTC kalır). Yaz saati geçişlerinde sabit saatli zamanlama bir kez çalışır (atlanan saat
  geçişten hemen sonra, tekrarlanan saat ilk seferde); "her saat" gibi zamanlamalar gerçek saat aralığını korur.
  En sık her 5 dakikada bir.
- **GitHub olayı:** PR açıldı / güncellendi, issue açıldı / etiketlendi, bir dala push, yorumda komut
  (ör. `/remyral düzelt`). Bağlı GitHub App üzerinden gelir.
- **İmzalı webhook:** her otomasyonun kendi adresi (`https://<konsol>/v1/hooks/<id>`) ve gizli anahtarı (secret).
  Başka bir sistem (deploy, monitoring, Zapier…) bu adresi çağırınca iş başlar.
- **Zincir:** "X otomasyonunun çalışması başarılı / başarısız bitince Y'yi başlat" (en fazla 5 halka). Başka bir
  projedeki otomasyona zincir sadece **admin / owner** hesabıyla kurulabilir ve her çalışmada yeniden kontrol edilir;
  yetki gidince zincir durur.
Hedef: bir **iş** (prompt + runtime) ya da kayıtlı bir **workflow**.

## Panelden oluşturmak
Sol menü → **Automations** → **New automation**:
1. Proje, ad, (isteğe bağlı) açıklama.
2. Tetikleyici: zamanlama için hazır seçenekler (saatlik / günlük / hafta içi / haftalık) ya da cron yaz, altına
   **Saat dilimi** (IANA adı, ör. `Europe/Istanbul`); altında okunur özet ve sonraki çalışma zamanları görünür. Listede
   ve otomasyon sayfasında zamanlama "her saat başı · Europe/Istanbul" diye yazar.
3. Ne yapacağı: prompt + runtime ya da workflow. Sandbox, model ve süre limiti **projenin varsayılanlarıyla**
   gelir (iş oluşturma ekranındaki gibi): proje host çalıştırmaya izin veriyorsa bir makinede hazır olan en iyi host
   profili (ör. `host-restricted`), yoksa container; model projenin varsayılanı. Hiçbir makine çalıştıramıyorsa form
   kırmızı uyarı verir.
   **Onay politikası** (aşağıya bak) burada açıkça seçilir.
4. Kurallar: **aynı anda** (önceki hala çalışıyorsa: atla / sıraya koy / paralel), **kaçırılanlar** (master
   kapalıyken geçen zamanlar: atla / bir kere çalıştır / hepsini çalıştır — en fazla 10), saatte en fazla kaç
   çalışma, hata olunca bildirim.
5. **Create** → taze authenticator kodu ister.
GitHub ve webhook otomasyonlarını sadece **proje admini / owner** oluşturabilir (dışarıdan iş başlatan bir kapı).

## Onay politikası — otomasyon başında kimse yokken çalışır
Bir otomasyon gece 03:00'te, sen bakmıyorken çalışır. Ajan hassas bir şey yapmak isterse (ör. PowerShell komutu)
ne olacağını sen seçersin:
- **Ask before sensitive actions / Ask before every action:** iş **durur ve biri onaylayana kadar bekler**. Form ve
  chat kartı bunu sarı uyarıyla söyler: "Runs unattended — it will pause until someone approves." Bekleyen çalışma
  Runs sekmesinde **Waiting for approval** + **Decide** linkiyle, otomasyon sayfasında ve **Senden bekleyenler** sayfasında (`/needs`)
  görünür; ayrıca bir bildirim gelir (çalışma başına bir kere).
- **Onay zaman aşımı:** varsayılan **60 dakika**. Bu sürede kimse karar vermezse iş iptal edilir, çalışma
  "Approval timeout: …" nedeniyle **cancelled** biter ve bildirim gelir — sonsuza kadar asılı kalmaz. Hedef bir
  workflow ise **bütün workflow çalışması** iptal edilir (sadece bekleyen iş değil). Kutuyu
  kapatırsan onay isteğinin kendi süresi dolana kadar bekler.
- **Refuse sensitive actions (deny-sensitive):** beklemez, hassas işlemi **reddeder** ve devam eder. Gözetimsiz
  işler için önerilen seçim.
- **Never ask (full access):** hiç sormaz. Sadece proje izin veriyorsa seçilebilir (Projects → proje → Execution
  policy → auto-approve / "Full access"). Korumalı dala merge, force-push, deploy ve credential vault yine onay ister.
Normal (elle başlatılan) işlerin onay davranışı değişmedi; zaman aşımı sadece otomasyon çalışmaları için.

## Webhook secret'ı — sadece bir kere görünür
Oluşturunca adres + secret + hazır `curl` örneği gösterilir. **Hemen kopyala**, bir daha gösterilmez (master'da
şifreli saklanır). Kaybolursa ya da değiştirmek istersen: otomasyon → Overview → **Replace secret**. Eski anahtarın ne
kadar daha çalışacağını seçersin: varsayılan **24 saat** (1 saat / 3 gün / 7 gün de var) — bu sürede iki anahtar da
kabul edilir, çağıran sistemi rahatça güncellersin; kart iki parmak izini ve eski anahtarın biteceği zamanı gösterir.
Eski anahtarla gelen çalışmalar Runs'ta "signed with the previous secret" diye işaretlenir. İş bitince **End overlap
now** ile eskisini hemen kapat. Anahtar **sızdıysa** "Stop the old secret now" seç: eski anında geçersiz olur.
İstersen **Allowed callers** alanına IP / CIDR listesi yaz (ör. `203.0.113.0/24`): başka adreslerden gelen çağrılar
"bilinmeyen adres" gibi reddedilir.
Çağıran taraf her istekte `X-Remyral-Timestamp`, `X-Remyral-Nonce` ve `X-Remyral-Signature` (HMAC-SHA256) gönderir;
5 dakikadan eski ya da aynı nonce'la tekrar gelen istek reddedilir. Aynı istek iki kez gelirse **tek** çalışma olur.

## GitHub tetikleyicisi için bir kerelik ayar
- Yeni bağlanan GitHub App'ler webhook'la birlikte gelir.
- **Daha önce bağlanmış App:** Settings → Integrations → GitHub → **Set up webhook** (taze kod). Sonra açılan GitHub
  App ayarlarında **Active** kutusunu işaretle ve olayları seç: *Pull request, Push, Issues, Issue comment*, ayrıca
  yeni eklenenler *Pull request review, Release, Workflow run, Check suite*. Issue olayları için **Issues: Read**,
  workflow run olayları için **Actions: Read** izni de ver (GitHub senden kurulumda onay ister).
- Bir otomasyon birden fazla olayı dinleyebilir ("Also on": ör. PR + release).
- Fork'tan gelen PR'lar ve repo üyesi olmayanların açtığı issue/yorumlar **güvenilmez** sayılır: varsayılan olarak
  hiçbir şey başlatmaz. "Allow untrusted events" açıksa iş **container** içinde, secret'sız ve onaysız (allow-all)
  olmadan çalışır.
- Fork PR'ının **kodunu** incelemek için ayrıca "Check out" → olayın gösterdiği seç: iş PR'ın tam o commit'ini
  (SHA'ya sabit) ayrı bir karantina kopyasında açar; sadece container'da, credential ve secret olmadan, **asla push
  etmeden**. Ajan o kodu okur ve container içinde çalıştırabilir — kabul ettiğin risk bu (ADR-0026). Makinenin
  worker'ı bunu desteklemiyorsa yerleşim "worker too old … pull requests from forks" der → worker'ı güncelle.
- PR başlığı, açıklama, yorum, webhook JSON'u işe **talimat olarak değil, veri olarak** gider (bağlam paketinde
  "güvenilmez veri" bloğu). Asıl talimat her zaman senin yazdığın prompt.

## Takip etmek
- **Automations** listesi: tetikleyici özeti, son çalışma durumu, sonraki çalışma, başarı oranı, açık/kapalı.
- Otomasyon sayfası sekmeleri: **Overview** (istatistik, son hata ve nedeni), **Runs** (her çalışma: ne zaman, neden
  tetiklendi, hangi iş, durum, atlandıysa nedeni — işe tıklanır), **Trigger**, **Settings** (duraklat / devam /
  şimdi çalıştır / sil).
- Başarısız çalışma → bildirim ("Automation failed"); **Senden bekleyenler** sayfasında (`/needs`) da görünür.
- Otomasyonu oluşturan kişinin yetkisi her çalışmada yeniden kontrol edilir; yetkisi gittiyse otomasyon **durur**
  ("stopped") ve bildirim gelir. Bir admin **Resume** derse artık onun adına çalışır.

## Chat'ten
Örnekler:
- "Her hafta içi 09:00'da acme projesinde bağımlılıkları kontrol eden bir otomasyon kur." → taslak kart → **Confirm**.
- "acme/app'te PR açılınca kod incelemesi yapan bir otomasyon oluştur."
- "Deploy için webhook otomasyonu kur." → onaylayınca kartta adres + secret **bir kere** görünür.
- "Gece raporu otomasyonu ne zaman çalıştı, son başarısız olan neden başarısız?" → çalışma geçmişini, iş id'lerini ve
  nedenleri anlatır.
- "Gece raporunu duraklat / şimdi çalıştır / sil." → taslak kart.
Asistan hiçbir şeyi kendisi değiştirmez: her yazma bir taslak karttır, onay authenticator koduyla senden gelir.
Asistan sandbox'ı tahmin etmez, projenin varsayılanını kullanır; kartta onay politikası, "Runs unattended" uyarısı ve
hiçbir makine çalıştıramıyorsa kırmızı yerleşim uyarısı görünür — onaylamadan önce oku.

## Eski "Schedules"
Composer'daki "At a time" / "Repeat" artık otomasyon oluşturur; `/jobs/schedules` → `/automations`.
