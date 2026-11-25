# Remyral: Deploy entegrasyonları (Coolify, Cloudflare Pages, DNS)

## Ne değişti?
Ajanlar ve chat artık **deploy isteyebilir**: Coolify'a deploy/restart, Cloudflare Pages'e site yükleme, Cloudflare
DNS kaydı değiştirme. Token'lar **sadece master'da**, şifreli durur (ADR-0028). Ajan, worker, iş ortamı ve chat
asistanı token'ı hiç görmez; sadece "şunu deploy et" diye **istek** açar. Master kontrol eder, farkı (diff) gösterir,
gerekiyorsa onay + authenticator kodu ister, çalıştırır, kaydeder ve geri alma (rollback) sunar.

## 1. Token'ları oluştur
**Coolify** (Coolify paneli → Keys & Tokens → API tokens → yeni token):
- İzinler: **read** + **deploy**. `write` ve `root` verme (Test bunu uyarır). Logları görmek istersen `read:sensitive`.
- Token, seçili **team**'e bağlıdır; Remyral'ın deploy edeceği uygulamalar o team'de olmalı.
- Coolify'da Settings → Advanced → **API access** açık olmalı.

**Cloudflare** (dash → My Profile → API Tokens → Create Custom Token):
- Zone → **DNS → Edit** ve Zone → **Zone → Read**: sadece Remyral'ın değiştirebileceği zone'lar (ör. sadece
  `example.org`). Konsolun zone'unu (ör. `example.com`) vermesen daha iyi — verirsen de konsol kaydı korunur.
- Account → **Cloudflare Pages → Edit** (Pages kullanacaksan).
- Account ID: dash'ta hesabın ana sayfasında sağda (32 karakter).

## 2. Panele gir
Settings → **Integrations**:
- **Coolify:** URL (`https://…`, iç ağ adresi kabul edilmez — gerekirse sunucu ortamında `OPS_INTERNAL_ORIGINS`),
  token, istersen team adı → **Save** (taze authenticator kodu) → **Test connection**: sürüm, team, izinler
  (read / deploy / write) ve uyarılar görünür.
- **Cloudflare:** Account ID + token → Save → Test: token durumu, görünen zone'lar, Pages erişimi.
- Token bir daha hiçbir ekranda görünmez; sadece parmak izi. Değiştirmek için yenisini yaz; boş bırakırsan eskisi kalır.
- Sunucu ortamında (Coolify'daki master servisi) şunları ayarla: `OPS_CONTROL_PLANE_COOLIFY_UUIDS` = Remyral'ın kendi
  Coolify kaynaklarının uuid'leri (master, web, postgres, redis…), `OPS_CONTROL_PLANE_ADDRESSES` = sunucunun genel IP adresi.
  Bunlar panelden kaldırılamaz; bu kaynaklara asla deploy edilmez.

## 2a. Birden fazla Coolify (ADR-0050)
- **Ne değişti:** Settings → Integrations → **Coolify** artık bir **bağlantı listesi**. Sunucudaki mevcut Coolify,
  güncellemeyle kendiliğinden **"Sunucu Coolify (varsayılan)"** adlı bağlantı olur — token'ı tekrar girmen gerekmez,
  bütün projeler onu kullanmaya devam eder. Diğerlerinden farkı yok; sadece hedefte bağlantı seçilmemişse kullanılan
  varsayılan odur.
- **Harici Coolify bağla:** **Bağlantı ekle** → ad (ör. "Harici Coolify"), API adresi (`https://…`, iç ağ adresi
  kabul edilmez), istersen team, tarayıcıda açılacak adres (Open URL), token (read + deploy) → kaydet (taze
  authenticator kodu) → **Bağlantıyı test et**: sürüm, team, izinler, görünen uygulama sayısı ve kaçının kontrol
  düzlemi olduğu.
- **Hangi projeler kullanabilir:** "Tüm projeler" ya da proje listesi. Listede olmayan proje o Coolify'a deploy
  edemez, log okuyamaz, izleme kuramaz (403). Kartta "kullanan projeler" görünür.
- **Projede seç:** Projects → proje → **Deploy** → Coolify preview / production için **bağlantı** seç, sonra uuid /
  tag'ler. Preview sunucudaki Coolify'da, production harici Coolify'da olabilir.
- **Varsayılan yap / token değiştir / kaldır:** kartın menüsünden (hepsi taze kod ister). Kaldırırken onu kullanan
  projeler listelenir; kaldırınca o hedeflerin deploy'u "connection removed" ile durur — başka bir bağlantı seç.
- **Koruma:** `OPS_CONTROL_PLANE_COOLIFY_UUIDS` ve konsol adresini sunan uygulamalar **her bağlantıda** reddedilir;
  panelden kaldırılamaz.
- **Chat / ajan:** deploy kartlarında ve durumda "Coolify «Harici Coolify»" gibi bağlantı adı yazar; token asla
  görünmez. Araçlar değişmedi → worker release gerekmez.
- **Open Coolify:** hesap menüsünde her bağlantı için bir giriş: sunucu Coolify'ı tek oturumla (SSO), haricileri kendi
  adresinde (orada kendi hesabınla girersin).
- **Yedek:** token'lar veritabanında master anahtarıyla şifreli durur; DB yedeği + `secrets/totp.key` yedeği ile geri
  gelir, ayrıca bir şey yedeklemen gerekmez.

## 3. Projeye hedef tanımla
Projects → proje → **Deploy**:
- Coolify **preview** ve **production**: uygulama uuid'leri veya tag'ler.
- Pages proje adı (production dalı Cloudflare'deki "production branch").
- İzinli DNS zone'ları (Test'teki listeden) ve ek korunan isimler.
- Politika (varsayılan): preview **otomatik**, production **onay + kod**, DNS **onay**, DNS silme **onay + kod**.
- Hiçbir ayarla değişmeyenler: konsolun kendi adı (ör. `console.example.com`), MX/SPF/DKIM/DMARC, kontrol düzlemini gösteren kayıtlar,
  Remyral'ın kendi Coolify kaynakları → **reddedilir**.

## 4. Chat'ten kullanmak
- "shop projesini preview'a deploy et" → asistan **draft_deploy** kartı açar: hedef, diff, politika. Onaylarsın (kod).
  Preview hemen çalışır; production **Deploys** sayfasında / **Senden bekleyenler** sayfasında onay bekler (admin + taze kod).
- "www.ornek.example A kaydını 1.2.3.4 yap" → **draft_dns_change**: mevcut kayıt → yeni kayıt. Onaydan sonra çalışır.
- "Son deploy ne oldu?" → **deploy_status** (durum, deployment id, link, rollback var mı).
- Geri almak: Deploys → aksiyon → **Roll back** (yeni bir aksiyon olarak açılır, aynı onay kuralları).
- Chat araçları yeni: asistanın çalıştığı worker'ın güncellenmesi gerekir (worker release).

## 5. Otomatik deploy (faz 2)
- **Otomasyon:** Automations → yeni → hedef **Deploy** (Coolify deploy / restart, preview / production). Örn. GitHub
  `push` main → preview deploy. Parametreler sabittir; olay içeriği bunları değiştiremez. Fork / dış katkıcıdan gelen
  olay **asla** deploy etmez. Production yine onay + kod bekler.
- **Workflow:** verifier ya da integrator adımına `deploy: { kind: "coolify.deploy", env: "preview" }` ekle → doğrulama
  (veya merge) başarılı olunca deploy istenir. Pages için adıma `siteBundle: { directory: "dist" }` ve
  `deploy: { kind: "pages.deploy" }`.
- **Site paketi:** bir iş `siteBundle.directory` (örn. `dist`) bildirirse worker o klasörü paketler (≤ ~3.7 MB, 500
  dosya); içinde secret görünürse paketin tamamı gönderilmez. Konsol bu paketi hiç göstermez.
- **Bildirimler:** onay bekleyen deploy → proje adminlerine "Deploy waiting for approval"; başarısız deploy → operatörlere.
  Durum (deploying → succeeded/failed) master tarafından 15 sn'de bir kendiliğinden yoklanır.
- Faz 2 için de worker release gerekir (`site-bundle-v1`).

## 5a. İş bitince otomatik deploy (deploy on success, ADR-0030)
- **Composer:** yeni iş → **Deploy when done** aç → hedef **Pages** (statik site / HTML) ya da **Coolify**, ortam
  preview (varsayılan) ya da production; Pages için site klasörü (varsayılan `site/`; ajan `index.html` vb. oraya
  yazmalı, workspace işlerinde `out/site/`). İşi göndermen deploy onayıdır — iş başarıyla bitince master kartsız
  deploy eder.
- **Chat:** "bir landing page yap, bitince deploy et" → asistan `draft_job` kartına `deployOnSuccess` koyar; kartı
  onaylarsın (kod). İş bitince aynı sohbete canlı link mesajı gelir.
- **Production:** sadece Project → Deploy → **Allow auto-deploy to production on success** açıksa (proje admini,
  varsayılan kapalı) ve işi oluştururken taze authenticator kodu girersen. Sonradan kapatılırsa bekleyen deploy
  yapılmaz.
- **Ne zaman deploy olmaz:** iş başarısız/iptal; site paketi yok ya da içinde secret görünüyor; hedef iş
  oluşturulduktan sonra değişti; oluşturan kişinin yetkisi kalmadı. Sebep iş sayfasındaki **Deploy** kartında,
  bildirimde ve (chat'ten geldiyse) sohbette yazar.
- **Bildirim:** "Job … deployed to Cloudflare Pages (preview)" (`deploy.succeeded`) ya da `deploy.failed` — e-posta /
  webhook kanalını Settings → Notifications'tan açabilirsin.
- Chat alanı yeni: asistan worker'ı için worker release gerekir; composer ve otomasyonlar hemen çalışır.

## 5b. Yeni Pages projesi oluşturmak ve domain bağlamak
- **Neden:** artık Cloudflare'de Pages projesini elle açman gerekmiyor; Remyral master'daki token ile açar.
- **Token:** ekstra izin yok — zaten verdiğin Account → **Cloudflare Pages → Edit** yeter. Domain'in CNAME'ini de
  yazdırmak istersen o zone için Zone → **DNS → Edit** (zaten DNS için verdiğin izin).
- **Panel:** Projects → proje → **Deploy** → **Create a new Pages project**:
  - Proje adı: küçük harf, rakam ve tire; harf/rakamla başlayıp bitmeli; en fazla 58 karakter (`<ad>.pages.dev` olur;
    isim Cloudflare'de başkasında varsa sonuna ek gelebilir, sonuçta gerçek adres yazar).
  - Production branch (varsayılan `main`). Proje **Direct Upload** tipindedir: repo bağlanmaz, Remyral site paketini yükler.
  - **Use as this project's Pages target** (sadece proje admini, authenticator kodu ister): bitince Project → Deploy'daki
    Pages hedefi bu proje olur.
  - **Kapalıyken**: mevcut hedef **değişmez**; yeni proje bu projenin **Further Pages projects**
    listesine eklenir. Deploy ve domain bağlarken o listeden seçebilirsin (ör. genel'in hedefi `cluster-general`
    kalırken `acme-site`'a deploy).
  - Aynı isim hesapta zaten varsa reddedilir; istersen **If a project with this name already exists, use it** ile var
    olanı sahiplenirsin (hedef yapsan da yapmasan da proje admini + authenticator kodu ister).
  - **Review** ne yapılacağını ve politikayı gösterir (hiçbir şey kaydedilmez) → **Request**. Varsayılan politika:
    **onay** (Deploys sayfasında / **Senden bekleyenler** sayfasında onaylarsın). Project → Deploy → **Pages projects and domains**
    ile "otomatik" ya da "onay + kod" yapabilirsin.
- **Domain bağlamak:** aynı kartta **Attach a custom domain** → `www.ornek.example`:
  - Domain bu projenin izinli zone'undaysa master CNAME'i de yazar (`www.ornek.example → <proje>.pages.dev`, proxied) —
    DNS değişikliği olduğu için en az DNS onay seviyesi uygulanır.
  - Hesaptaki başka (izinsiz) bir zone'daysa **reddedilir**; konsol adresi, korunan isimler ve kontrol düzlemini
    gösteren kayıtlar da reddedilir. Aynı isimde A/AAAA kaydı varsa önce onu değiştir.
  - Domain Cloudflare hesabında değilse kart, DNS sağlayıcında elle eklemen gereken CNAME'i yazar.
  - Durum: Cloudflare doğrulaması bitene kadar aksiyon **deploying** görünür, master 15 sn'de bir kontrol eder;
    **active** olunca succeeded. 24 saat içinde aktif olmazsa failed (DNS / doğrulamayı Cloudflare'de kontrol et).
- **Chat:** "shop için yeni bir Pages projesi aç, hedef yap" / "www.ornek.example'u bağla" → asistan
  **draft_pages_project** kartı açar; onaylarsın. Chat aracı yeni: asistan worker'ı için worker release gerekir.
- **Silme yok:** Pages projesini silmek ya da domain'i kaldırmak Remyral'dan yapılmaz (geri alınamaz) — Cloudflare
  dashboard'dan sen silersin. Yazılan CNAME'i normal bir DNS değişikliğiyle değiştirebilir/silebilirsin.
- Otomasyon / workflow adımı olarak sunulmaz.

## 5c. Hazır bir siteyi yüklemek (Upload a site, ADR-0037)
- **Ne için:** elindeki hazır statik siteyi (HTML sunum, CSS/JS, görseller, fontlar, **MP4 / WebM** klipler) bir iş
  çalıştırmadan Cloudflare Pages'e yayınlamak.
- **Panel:** Projects → proje → **Deploy** → **Upload a site** → **Choose folder** (klasör seç) veya **Choose .zip**.
  - .zip tarayıcıda açılır (master arşiv açmaz). Tek bir üst klasör varsa otomatik kaldırılır; kökte `index.html`
    olmalı. `.DS_Store`, `__MACOSX/` gibi sistem dosyaları sessizce atlanır.
  - Göndermeden önce dosya listesi, toplam boyut ve **reddedilecek dosyalar** (gizli dosyalar, izin verilmeyen tipler,
    `..` gibi güvensiz yollar, 8'den derin klasör, 25 MiB'tan büyük dosya) nedenleriyle gösterilir.
  - Sınırlar: en fazla 500 dosya, dosya başına 25 MiB (Cloudflare Pages sınırı), toplam 50 MiB.
  - Yükleme 4 MiB'lık parçalarla gider (yavaş bağlantıda da zaman aşımına düşmez, yarıda kalırsa **Resume upload**).
  - Master her dosyayı tekrar kontrol eder: SHA-256, görsel/video için dosya imzası (magic bytes), metin dosyalarında
    gizli anahtar taraması. Bir sır bulunursa yükleme silinir ve **dosya + kural + satır** söylenir (değer asla).
- **Deploy:** yükleme bitince Pages projesini seç (hedef ya da Further Pages projects'ten biri) → **Deploy to preview**
  (varsayılan politikada hemen çalışır) veya **Deploy to production** (onay + authenticator kodu) → Review → Request.
  Deploys sayfasında diff'te kaynak **uploaded site**, dosya sayısı ve boyut görünür; sağlık kontrolü, otomatik izleme
  ve **Roll back** iş deploy'larıyla aynıdır.
- **Saklama:** hiç deploy edilmeyen yüklemeler 7 gün sonra silinir; proje başına en yeni 5 yükleme tutulur (onay bekleyen
  bir deploy'un yüklemesi silinmez). Site konsolda asla açılmaz/indirilmez.
- **Kim:** projede deploy isteyebilen herkes (operator+). Viewer'lar listeyi görür, yükleyemez.
- **Örnek (genel):** Create a new Pages project → `acme-site` (Use as target **kapalı**) → onayla →
  Attach a custom domain → Pages project: `acme-site`, domain `acme-site.example.org` → onayla →
  Upload a site → klasörü seç → Upload → Pages project `acme-site` → Deploy to production → onayla.

## 5d. Tek onayla yayınla (publish bundle, ADR-0038)
- **Ne değişti:** bir siteyi kendi domain'inde yayınlamak eskiden **4 ayrı onay** istiyordu (Pages projesi oluştur,
  production deploy + kod, domain bağla, CNAME yaz). Artık hepsi **tek bir istek**: `pages.publish` — "Pages projesi
  yoksa oluştur → siteyi deploy et → domain'i bağla → CNAME'i yaz". Kart/diff bütün zinciri adım adım gösterir, sen
  **bir kez** onaylarsın (production ya da DNS varsa taze authenticator koduyla). Sonra her adım kendi aksiyonu olarak
  sırayla, ek onay istemeden çalışır; her adım çalışmadan hemen önce yeniden kontrol edilir.
- **Nerede:**
  - **Upload a site** kartı: yüklemeden sonra Pages projesini seç (hedef, ek projeler ya da **New project…** → yeni ad)
    + istersen domain (DNS auto/skip) → Review → **Request** → tek onay. Sayfayı yenilesen de **son yüklemeler** listede;
    "Use this upload" ile eski bir yüklemeyi yayınlayabilirsin.
  - **İş oluştururken (Deploy when done):** Pages seçince "Publish to" bloğu: Pages projesi / yeni proje, domain, DNS.
    Onay işi oluştururken verilir (production/DNS varsa taze kod); iş başarıyla bitince zincir kendiliğinden çalışır.
  - **Chat:** "şunu deck.example.org'de yayınla" → asistan iş taslağına (`draft_job.deployOnSuccess`) domain + proje
    ekler; kart 4 adımı listeler, tek onay + kod. Hazır bir sonuç ya da yükleme için `draft_deploy` → `pages.publish`
    (tek kart → tek onay). Chat kısmı için **worker release** gerekir.
  - **İşin içindeki ajan:** Claude Code işinde `publish_site` aracı var (Pages hedefi olan projede, güvenilir kaynaklı
    ve bir kişinin açtığı işlerde; worker'da `site-publish-v1` özelliği). Ajan şimdi deploy etmez: iş **başarıyla
    bitince** master zinciri tek bir istek olarak açar → normalde **bir onay**; projedeki politika her adım için
    "Run at once" ise onaysız çalışır (production asla). **Worker release** gerekir.
- **Kurallar:**
  - Yeni proje sadece **hesapta olmayan** bir adla oluşturulur ve projenin "Further Pages projects" listesine eklenir;
    hedef (target) **asla** değişmez. Hesapta başka bir proje aynı adla varsa reddedilir (benimsemek proje admin işi).
  - Domain izinli bir zone'daysa CNAME `domain → <proje>.pages.dev` (proxied) yazılır; izinsiz zone reddedilir;
    hesap dışındaki domain için kart elle eklenecek kaydı yazar. Domain zaten bağlı ve kayıt doğruysa adım "zaten
    tamam" geçer.
  - Bir adım başarısız olursa zincir **durur** (örn. deploy başarısızsa domain bağlanmaz), aksiyon failed olur ve
    bildirim gelir. Onaydan sonra hedef değiştiyse (örn. biri aynı isme başka bir CNAME yazdı) o adım **çalıştırılmaz**:
    "target changed since the approval".
  - Onaylayan kişi artık onaylayamıyorsa ya da isteyen kişinin yetkisi gittiyse sonraki adımlar çalışmaz.
- **DNS "Run at once" (Project → Deploy → Policy → DNS changes):** yeni seçenek. **Sadece** projenin kendi Pages
  projelerinin `pages.dev` adına giden CNAME kayıtlarını (izinli zone'larda, oluştur/güncelle) onaysız yapar. Başka
  her kayıt (A, TXT, başka bir hedefe CNAME) **onay** ister; silme her zaman **onay + kod**. Bir projede ajanların ya da
  yükleme kartının preview siteleri kendi domain'lerine tamamen kendi başına yayınlaması isteniyorsa: Preview deploys,
  Pages projects ve DNS changes → "Run at once". Production deploy her zaman en az **onay** ister (önceden onaylanmış
  bir publish / deploy on success hariç).
- **Hata mesajları:** Cloudflare/Coolify hataları artık 424 ile ve sağlayıcının kendi mesajıyla görünür (eskiden konsol
  "Unexpected response from the server" diyordu). Örnek: "Cloudflare: list DNS records: Authentication error — the
  token needs Zone → DNS → Edit for example.org".
- **Test connection (Cloudflare):** artık her projede izinli olan her zone için DNS okumayı dener ve zone başına
  "okunabilir ✓" ya da "Zone → DNS → Edit eksik" yazar. Not: hesap seviyesindeki **DNS View**, **Account DNS
  Settings** ve **DNS Firewall** izinleri zone kayıtlarını **kapsamaz** — token'a Zone → DNS → Edit (ilgili zone
  seçili) eklenmeli.
- **Deploys sayfası:** bir aksiyon onaylandıktan/reddedildikten sonra başlık artık gerçek durumu yazar (Succeeded,
  Failed, Denied …), "Waits for approval" kalmaz; publish aksiyonunda adımlar ve her adımın kendi aksiyonuna link görünür.

## 5e. Deploy sonucu, loglar ve düzeltme (ADR-0048)
Deploy'un ne olduğu artık sohbetten, iş içinden ve panelden görülür; sorun varsa düzeltme işi başlatılır.
- **Loglar (operatör ve üstü):** Yayınlar → bir deploy → **Loglar**: **Build** (Coolify build logu / Cloudflare Pages
  aşamaları ve build logu), **Runtime** (Coolify uygulamasının şu anki container çıktısı; "Canlı yenile" 5 sn'de bir),
  **Sağlık** (deploy sonrası kontrol: HTTP durum, TLS, kırık linkler). Arama, kopyala, takip var. Sırlar master'da
  gizlenir. Runtime logu yalnızca projenin **şu anki** Coolify hedefindeki uygulamalardan okunur; kontrol düzlemi
  kaynakları (deny-list) hiç okunmaz.
- **Sohbet:** "deploy neden patladı?" → asistan `deploy_status` + `deploy_logs` ile nedeni açıklar. "düzelt" /
  "düzeltme işi taslakla" → `draft_deploy_fix` ile bir iş kartı: kaynak işten devam eder (yoksa deploy edilen branch
  üzerinde repo işi), hata özeti + log parçası + sağlık bulguları istemde (veri olarak), iş başarılı olunca aynı hedefe
  yeniden deploy. Kartı onaylamak o deploy'u da onaylar (production: proje anahtarı + kod).
- **İş kartı:** deploy başarısızsa **Logları gör** ve **Düzeltme işi başlat** (iş formu dolu açılır, siz gönderirsiniz).
- **İşin içindeki ajan** (Claude Code, Codex, Pi, OpenCode; güvenilir kaynaklı, bir kişinin başlattığı işler):
  `deploy_status`, `deploy_logs` ile projesinin deploy'larını ve loglarını okur; `request_redeploy` yalnızca **istek**:
  iş başarılı olunca politikaya göre çalışır, **production her zaman onay bekler**. Çağrılar denetim kaydına girer,
  iş başına 10 dakikada 30 çağrı sınırı var.
- **Otomatik düzeltme (varsayılan kapalı):** Projeler → Deploy → **Otomatik düzeltme** (proje yöneticisi + kod). Açıkken
  bir işin deploy'u / yayını / sağlık kontrolü başarısız olursa logları ve bulgularıyla **bir** düzeltme işi başlar
  (kaynak işi başlatan kişi adına; zincir başına en fazla 1–3 deneme, varsayılan 1). Bu işin yeniden deploy'u **asla
  önceden onaylı değildir**: preview politikaya göre (varsayılan hemen), production her zaman onay ister. Bildirim:
  "Fix job started …", iş kartlarında zincir (iş → deploy başarısız → düzeltme işi → yeniden deploy).
- **Coolify token'ı:** `read` çoğu kurulumda yeter; uygulama logları 403 dönerse token'a `read:sensitive` ekleyin.
- **Worker sürümü gerekir:** ajan araçları (`deploy-feedback-v1`) ve sohbet araçları (`deploy_logs`,
  `draft_deploy_fix`) yeni worker sürümüyle gelir; o zamana kadar panel ve REST çalışır.

## 6. İlk deneme (kontrol listesi)
1. İki token'ı oluştur, panele gir, iki Test de yeşil.
2. Bir test projesinde preview hedefi tanımla → "Deploy preview" → Coolify'da deployment başlar → Deploys'ta
   **Refresh** → succeeded.
3. Test zone'unda bir A kaydı değiştir → onayla → Cloudflare'de gör → **Roll back** → eski değere döner.
4. (Pages) Çıktısını `out/` altına yazan bir iş → Deploy → pages.deploy (jobId). İlk denemede Cloudflare'in asset
   anahtarlarını kabul ettiğini doğrula (docs/compat/cloudflare.md notu).
5. (Pages projesi) Project → Deploy → **Create a new Pages project** → `remyral-deneme` → onayla → Cloudflare'de proje
   görünür; izinli zone'da bir test alt domain'i bağla → **active** olduğunu gör → ikisini de Cloudflare'den sil.
6. (Tek onayla yayınla) Upload a site → yeni proje `remyral-yayin-deneme` + domain `yayin-deneme.example.org` → Request →
   tek onay + kod → Deploys'ta 3 adımın (create / deploy / domain) sırayla bittiğini, Cloudflare'de CNAME'i ve
   domain'in **active** olduğunu gör. Önce Settings → Integrations → Cloudflare → **Test connection**'da `example.org`
   için "DNS records readable ✓" görünmeli. Sonra projeyi ve kaydı Cloudflare'den sil.
7. (Deploy logları) Coolify'da bilerek kırık bir commit ile preview deploy → Yayınlar → Loglar → **Build**'de hatayı,
   çalışan bir uygulamada **Runtime**'da son satırları gör (403 → token'a `read:sensitive`). "Düzeltme işi başlat" →
   form dolu açılır. Bir Pages deploy'unda **Build** sekmesinde aşamaları gör.
