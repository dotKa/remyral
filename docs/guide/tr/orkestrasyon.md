# Remyral: Ajan orkestrasyonu (alt işler, planlayıcı, makineler arası iş bölümü)

## Ne bu?
Örnek: **"YouTube videosu üret, görselleri Codex ile oluştur."** Claude Code işi yönetir (senaryo, kurgu, metin);
sadece görsel üretimini **Codex**'e verir — o da istersen başka bir makinede (ör. Windows masaüstü) çalışır. Görseller
geri gelir, Claude devam eder. Bunun için üç parça var:
1. **Alt iş (sub-job):** çalışan bir işin ajanı, işin bir parçasını yeni bir işe devreder (`request_subtask`).
2. **Planlayıcı seçimi:** workflow'daki planlayıcı adım, planladığı her görev için runtime / model / gereken yetenek /
   makine **önerebilir**; platform bunları izin listesine göre kontrol eder.
3. **Workspace workflow'ları:** repo'suz (workspace) projelerde de workflow — her adımın `out/` dosyaları sonraki
   adımın `in/` klasörüne geçer.

## Açmak (varsayılan kapalı)
Projects → proje → **Policy** sekmesi → **Sub-jobs** bölümü:
- **"Agents may hand parts of a job to other agent jobs"** kutusu (ajanlar işin parçalarını başka ajan işlerine verebilir). Taze authenticator kodu ister,
  denetim kaydına düşer, owner/admin'lere bildirim gider.
- **Delegation runtimes**: alt işlerin ve planlanan görevlerin işin kendi runtime'ı dışında kullanabileceği
  runtime'lar. Görsel üretimi için **codex**'i işaretle. Boş bırakırsan alt iş sadece işin kendi runtime'ıyla çalışır.
Sonra işi her zamanki gibi başlat (ör. Claude Code ile, workspace projesinde): "YouTube videosu hazırla; küçük resimleri
Codex ile üret". Ajan `request_subtask` aracını kullanır.

## Alt iş nasıl çalışır?
- Ajan bir başlık, eksiksiz bir görev metni, isteğe bağlı runtime (`codex`), yetenek etiketleri
  (`image-generation`, `browser`, `ffmpeg`, `python`, `git`, `docker`, `container`, `node`) ve küçük girdi dosyaları
  (`out/senaryo.md` gibi, toplam en fazla 256 KiB) verir.
- `image-generation` isteyen alt iş **Codex**'e gider (görsel üreten tek runtime). Araç etiketleri (ör. `ffmpeg`)
  makinenin araç listesine göre yerleşir: o aracı raporlayan makine seçilir.
- Ajan beklerse (varsayılan) araç en fazla ~9 dakika bekler; bitmediyse "hala çalışıyor, `wait_subtask` ile bekle"
  der. Bitince alt işin **özeti** (veri olarak, talimat değil) ve **dosyaları** gelir: dosyalar ana işin
  `in/subtasks/<id>/` klasörüne salt-okunur iner. Ana iş teslim edeceğini `out/`'a kopyalar.
- Alt iş normal bir iştir: Jobs listesinde görünür, onay isteyebilir (Approvals'a düşer), iptal edilebilir.
  İşin sayfasında (Activity sekmesi) **Sub-jobs** kartı: ana işe link, alt işler, durumları, runtime, makine, nasıl
  seçildiği, teslim edilen dosya sayısı, **Cancel sub-job**.

## Sınırlar (güvenlik)
- Alt işin sandbox'ı ve kaynak güveni ana işle **aynı**; onay politikası ana işinkiyle aynı ya da **daha sıkı**.
  Secret referansları, deploy, fallback'ler **aktarılmaz**.
- Süre ve bütçe ana işten **kesilir**: alt iş, ana işin bitiş zamanından en az 1 dakika önce biter; token / tur /
  maliyet limiti varsa kalanın yarısını alır. Yeterli kalmadıysa reddedilir (`budget_exhausted`).
- Derinlik en fazla **2** (alt işin alt işi son seviye), iş başına en fazla **8** alt iş (aynı anda 4 açık), bir
  ailede toplam **16**. Makine yönetimi işleri alt iş açamaz.
- Ana iş biterse (başarılı / başarısız / iptal) hala açık alt işleri **iptal edilir**. Ajan beklemeden bıraktığı alt
  işi kullanmak istiyorsa önce beklemeli.
- Alt iş, ana işi başlatan kullanıcının adına açılır; o kullanıcının projede iş açma yetkisi o an yeniden kontrol
  edilir.
- Ajanın yazdığı hiçbir şey (görev metni, plan) politikayı, runtime listesini ya da sandbox'ı aşamaz.

## Abonelik girişiyle alt iş (Claude Code ana iş → Codex alt iş, aynı makine)
Eski davranışta Claude Code işi (abonelik girişi) görsel için Codex alt işi istedi ve
bekledi; Codex alt işi de abonelik girişliydi ve kuyrukta "Claude Code / Codex subscription logins run one at a
time …" diye bekledi. Ana iş alt işi, alt iş ana işi bekledi → bekleme süresi dolana kadar kilitlendi. Artık:
- **Kural giriş deposu başına.** Claude Code'un girişi `.claude`'da, Codex'inki `.codex`'te: ayrı depolar, birbirini
  bozmaz. Aynı depoyu (iki Claude Code işi) aynı anda kullanan iki iş yine sırayla çalışır (kuyrukta "waiting for the
  Claude Code subscription login on … to be free").
- **Aile istisnası.** Abonelik girişli iş makinenin kendi hesabıyla çalışır (diğer işlerin klasörlerini görebilir).
  Bu yüzden yalnızca **kendi ailesiyle** (ana iş ve onun alt işleri — aynı proje, aynı kullanıcı, zaten birbirine
  girdi/çıktı veriyorlar) yan yana çalışır. Başka bir işin yanında asla: kuyrukta "… is running another job".
- Sonuç: Claude Code ana iş + Codex alt iş aynı makinede **birlikte** çalışır; alt iş bitince sonuç ana işe döner.
- **Kilitlenme yerine anında haber (`blocked_by_parent`).** Alt iş yalnızca ana işin makinesinde çalışabiliyor ve
  orada ana işin kendisini bekliyorsa (ör. Claude Code ana iş → Claude Code alt iş, tek makine), ajan beklemez:
  `request_subtask` / `wait_subtask` birkaç saniye içinde "This sub-job cannot start while this job runs … Do this
  part yourself" der. Ajan işi kendisi yapar; açık kalan alt iş ana iş bitince iptal edilir (hiç başlamaz).
- Kuyruk ekranında makine satırı: "subscription logins: 1 at a time **per login**" (yeni worker).
- Gerekenler: master deploy (blocked_by_parent hemen çalışır) + **worker release** (giriş deposu ve aile kuralı yeni
  worker'la gelir; eski worker'da eski kural + blocked_by_parent).
- Henüz gerçek makinelerde doğrulanmadı (Claude Code + Codex alt işi aynı anda).

## Workflow'lar ekranı (tanımlar, grafik düzenleyici)
Diyalog'da sol rayda **Workflow'lar** (Jobs'un altında). Ayrıntı: docs/design/p13-workflows-ui.md, ADR-0051.
- **Liste** (`/workflows`): her workflow'un son sürümü, son çalıştırması, başarı oranı, çalıştırma sayısı, kim / ne
  zaman güncelledi. Proje filtresi, arama, **Arşiv**. Satırda **Aç**, **Çalıştır** (iş oluşturucu workflow seçili açılır,
  girdileri sorar), **Kopyala** (yeni adla v1), **Arşivle** (arşivdeki workflow yeni çalıştırma / sürüm almaz).
- **Düzenleyici** (`/workflows/new`, `/workflows/<id>`): grafik içerik alanını tam kaplar. Araç çubuğu: **Adım ekle**
  (İş adımı, Planlayıcı, Doğrulama, İnceleme, Integrator, Onay kapılı adım), **Bağla** (önce A sonra B; ya da kartın
  noktasından sürükle), **Sil**, **Geri al / Yinele**, **Düzenle** (otomatik yerleşim), **Sığdır**, **Mini harita**,
  **Izgaraya hizala**, **Doğrula** (master'ın kontrolü; sorunlar kartın ve bağlantının üstünde), **YAML / JSON** (iki
  yönlü senkron), **Sürümler** (fark + "bu sürümden devam et"), **Ayarlar**. Sağda seçili adımın ayarları (rol, istem,
  bağlı olduğu adımlar, runtime / model / sandbox / limitler, hata politikası, onay kapısı, planlayıcı, yayın adımı).
- **Kaydet** her zaman yeni sürüm yapar (eski sürümler değişmez); başka biri araya kayıt yaptıysa uyarır.
- **Çalıştırmalar** sekmesi bu workflow'un çalıştırmalarını listeler; çalıştırma sayfası aynı grafiği canlı
  durumlarla (kuyrukta / çalışıyor / onay bekliyor / bitti / başarısız) gösterir.
- Viewer salt okur; operatör ve üstü düzenler / çalıştırır.
- Sohbette: "planla, üç ajan paralel yazsın, sonra test et diye bir workflow oluştur" → asistan **workflow taslağı**
  kartı çıkarır (grafik önizleme + doğrulama); onaylayınca kaydedilir, hiçbir şey çalışmaz. Bunun için **worker
  release** gerekir (yeni sohbet aracı).
- Henüz canlı doğrulanmadı: telefonda sürükle-bağla (yedek yol: Bağla düğmesi).

## Planlayıcı (workflow)
Dinamik planlayıcı adımı planını `remyral-plan` bloğuyla yazar; artık her görev için şunları ekleyebilir:
`"runtime": "codex"`, `"requires": ["image-generation"]`, `"model": "<katalog profili>"`, `"machine": "desktop-pc"`.
- Runtime izin listesi: planlayıcının runtime'ı + workflow tanımında geçen runtime'lar + projenin delegation
  runtimes'ı. Dışındaysa plan **reddedilir** ve run ekranı izinli listeyi yazar.
- Model sadece katalogda açık, o runtime için tanımlı bir profil olabilir.
- Makine bir **ipucu**: kayıtlı makineyse oraya sabitlenir, değilse yok sayılır ve not düşülür.
- Hiçbir şey yazmazsa: projenin routing kuralı (izinliyse), yoksa planlayıcının runtime'ı.
- Run ekranında her adımın altında "**Runs with codex — image-generation needs codex; pinned to desktop-pc**" gibi
  bir satır ve işin gerçekten çalıştığı makine görünür.

## Workspace workflow'ları
- Composer → **A workflow run** artık workspace projelerinde de seçilebilir: dosya yüklersin ya da önceki bir işten
  devam edersin; her adım bu dosyaları ve önceki adımların dosyalarını (`<adım>-<dosya>` adıyla `in/`'de) alır.
- Chat'te `draft_workflow_run` workspace workflow'u için önceki işin dosyalarını (continueFrom / seçili dosyalar)
  alabilir; kartta dosya adları görünür, onaylarken okuma yetkin yeniden kontrol edilir.
- Otomasyonlar workspace workflow'larına dosyalarını zaten veriyordu (testle doğrulandı).

## Codex görselleri
Codex işlerde görsel üretebilir (pinli 0.162.1'de `image_generation` açık; artık işlerde açıkça açılıyor). Üretilen
görsel normalde Codex'in kendi klasörüne (`~/.codex/generated_images/…`) kaydediliyordu — işin `out/` klasörüne
girmiyordu. Artık workspace işlerinde `out/generated-images/` altına kopyalanır (PNG / JPEG / WebP, en fazla 20 MiB),
yani işin sonuçlarında indirilebilir ve alt iş olarak çalıştıysa ana işe döner.

## Henüz doğrulanmadı
- Gerçek makinelerde canlı deneme (Claude Code ana iş → Windows'taki Codex alt işi, ChatGPT girişiyle görsel): yapılmadı.
  Gerekenler: master deploy + **worker release** (iki makinede), projede Sub-jobs açık, delegation runtimes'ta codex.
- Codex / Pi / OpenCode işlerinde alt iş aracı yok (şimdilik sadece Claude Code ana iş olabilir; alt iş her runtime
  olabilir).
