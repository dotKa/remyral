# Remyral: Proje hafızası (hafıza önerileri + anlamsal arama)

## Ne bu?
Bir iş başarıyla bitince Remyral, iş özetinden projeye dair **kalıcı öğrenimleri** çıkarır ve sana **öneri** olarak
sunar: "bu depo pnpm kullanıyor", "Acme marka rengi #FF5A1F", "staging deploy için önce migration çalışmalı".
Sen kabul edersen (istersen düzenleyip), öneri projenin **Context hafızasına** girer ve sonraki işler bunu otomatik
olarak alır (mevcut context paketi mekanizmasıyla). Kabul etmediğin hiçbir şey hafızaya girmez.

Yer: **Projects → <proje> → Memory** sekmesi (`/projects/<id>?tab=memory`).

## Varsayılan: açık
- **Anlamsal arama** ve **hafıza önerileri** artık her projede **varsayılan olarak açık**. Yeni proje oluştururken
  (**Projects → New project**) "Project knowledge" altında iki kutu var: **Search by meaning** ve **Memory
  suggestions**. İkisi de işaretli gelir; bir projeyi dışarıda tutmak istersen işareti kaldır. İşareti kaldırılan
  proje **dahil edilmez** ve bu seçim kalıcıdır (sonradan hiçbir otomatik işlem açmaz).
- **Mevcut projeler:** daha önce hiç seçim yapılmamış projeler bu sürümle **bir kereye mahsus açıldı** (audit'te
  her proje için bir kayıt: `context.defaults.applied`, kaynak "platform default"). Daha önce **elle kapatılmış**
  olan proje kapalı kaldı.
- **Org geneli dokümanlar (`global`)** da varsayılan açık.
- Varsayılanın kendisi: **Settings → Context → Defaults for new projects** (admin, kod ister). Sadece **yeni**
  projeleri etkiler.
- Sonradan değiştirmek eskisi gibi: proje admini + authenticator kodu (aşağıda). Settings → Context ayarın nereden
  geldiğini de yazar ("switched on by the platform default" / "chosen when the project was created").
- Sağlayıcı (Bedrock) yoksa: ayar açık görünür ama dışarı hiçbir şey gitmez, arama anahtar kelimeyle çalışır.

## Nasıl değiştirilir? (proje admini)
1. **Projects → <proje> → Memory → Mode**:
   - **Off**: hiçbir şey okunmaz.
   - **On — rules** (yeni varsayılan): bundan sonra başarıyla biten her işin özeti okunur, öneriler gelir.
   - **On — rules + summarise with an agent**: ayrıca "bir işi ajanla özetle" düğmesi çıkar (aşağıda).
   Değiştirmek authenticator kodu ister (step-up) ve audit'e yazılır.
2. İstersen **Read earlier jobs (30 days)**: son 30 günün işlerini bir kez okur (her iş yalnız bir kez okunur).

## Öneriler nereden gelir?
- **Kurallar (ucuz, deterministik):** iş özetindeki `MEMORY:` / `HAFIZA:` / `ÖĞRENİM:` satırları, `## Öğrenimler`
  başlığı altındaki maddeler, tek bir paket yöneticisi (pnpm, Yarn, npm, Bun, uv, Poetry), doğrulama komutları
  (`pnpm test`, `pnpm lint`…), marka rengi (hex), deploy gereksinimleri ("deploy … gerekiyor / requires").
  İş başına en fazla 5 öneri.
- **Ajanla özetleme (isteğe bağlı, asla gizli değil):** "assisted" modda Memory sekmesinde iş kimliğini yazıp
  **Open in composer** dersin; Remyral hazır bir görev metniyle **normal iş oluşturma ekranını** açar. İşi sen
  gözden geçirip gönderirsin (kota, onay, model — hepsi normal). İş bitince yazdığı `MEMORY:` satırları buraya öneri
  olarak düşer.
- **Chat'ten, sen isteyince:** "bunu hafızaya ekle", "bu konuşmadan öğrenilenleri öner" — asistan `suggest_memory`
  ile önerileri kutuya bırakır (operator rolü ve projede Memory açık olmalı). Yine kabul eden sensin.
- **Projeye bağlı sohbetlerden, kendiliğinden (kurallarla):** bir sohbet projenin bilgi birikimine ekleniyorsa
  (başlıkta "Shared with project <X> knowledge" yazıyorsa — sohbetin projesi, `@proje` etiketi ya da o tur için
  hazırlanan taslak kartı), aynı kurallar o mesajlara da uygulanır. **Senin yazdığın** mesajlarda: `MEMORY:` /
  `HAFIZA:` / `KARAR:` / `KURAL:` satırları, açık kararlar ("**bundan sonra** paket yöneticisi olarak pnpm
  **kullan**", "asla main'e doğrudan push yapma", "from now on …", "always use …"), marka renkleri, paket yöneticisi,
  deploy gereksinimleri, doğrulama komutları. **Asistanın cevaplarında** yalnız açık `MEMORY:` satırları (cevabın geri
  kalanı ekibin kararı sayılmaz). Soru cümleleri ("pnpm mi kullanalım?") karar sayılmaz. Gizli bilgiler önce
  silinir; token / şifre içeren cümle hiç önerilmez. **Sohbet başına günde en fazla 5 öneri** (fazlası atlanır).
  Projeye bağlı olmayan, kişiye özel sohbet **asla** okunmaz.
- **Kutuda nasıl görünür:** öneri **Chat** rozetiyle ve "**from a conversation of <kişi>, <tarih>**" diye görünür;
  altında o mesajdan kısa bir alıntı (yalnız ilgili satır). Gözden geçiren kişi **sohbetin tamamını göremez ve
  açamaz** — yalnız öneriyi ve alıntıyı görür. Sohbetin sahibi kendi sohbetinin kimliğini görür.
- **Geri çekmek:** sohbetin "Share with project knowledge" kutusunu kaldırırsan, kişisel "Share project-related chat
  with project knowledge" ayarını kapatırsan, sohbeti projeden ayırırsan ya da silersen, o sohbetten gelen **bekleyen**
  öneriler kutudan hemen kalkar ve bir sonraki turda silinir (kabul edilmiş hafıza kalır — onu proje
  Context'inden silebilirsin). Paylaşımı tekrar açarsan mesajlar yeniden okunur. Projenin Memory modu "Off" ya da
  capture'ı kapalıysa sohbet okunmaz.
- **Bu sohbeti özetle (assisted mod):** projede mod "assisted" ise sohbetin başlığında **"Summarise for <proje>
  memory"** düğmesi çıkar (yalnız sohbetin sahibine, operator rolüyle). Remyral, sohbetin projeyle paylaşılan
  mesajlarından (gizliler silinmiş, "veri, talimat değil" diye ayrılmış) bir görev metni hazırlar ve **normal iş
  oluşturma ekranını** açar; sen gözden geçirip gönderirsin. **Kendiliğinden hiçbir model çağrısı yapılmaz.** İş
  bitince yazdığı `MEMORY:` satırları kutuya öneri olarak düşer.

## Kutuda ne yapılır? (operator ve üstü)
- **Accept:** olduğu gibi hafızaya ekler. **Edit:** başlığı/metni düzelt → **Accept edited**.
  **Dismiss:** reddeder; aynı öğrenim bir daha önerilmez.
- Her öneride kaynağı (hangi iş / chat) ve varsa **"benzer mevcut doküman"** uyarısı görünür — o zaman yenisini
  eklemek yerine eskisini düzenlemek daha iyi olabilir.
- Kabul edilen öneri, projede `memory` türünde bir Context dokümanı olur; kaynağında öneri ve iş kimliği yazar
  (provenance). Viewer'lar kutuyu görür ama karar veremez.

## Otomatik öğrenme
Öneriler kademeli olarak otomatik onaylanabilir:

- **Hafıza → Otomatik öğrenme** (proje admini değiştirir, doğrulama kodu ister):
  - **Kapalı:** her öneri bir kişiyi bekler (eskisi gibi).
  - **Güvenli (varsayılan, mevcut projeler dahil):** temiz **gerçekler** ve **dersler** kendiliğinden kabul edilir.
  - **Tümü:** buna ek olarak, var olan bir kayda benzeyen gerçekler ve dersler de kabul edilir.
- **Her modda bir kişiyi bekler:** kurallar, kararlar, var olan bir kaydın yerini alabilecek öneriler, gizli bilgiye
  benzeyenler ve ajanlara emir veren / testleri ya da onayları atlatan / veriyi bir adrese gönderen / `curl | sh`
  çalıştıran / kimlik bilgisine dokunan metinler. Kutuda "Neden sizi bekliyor" satırı nedenini yazar.
- **Kendiliğinden kabul edilen** kayıtta **"Otomatik öğrenildi"** rozeti olur; 30 gün sonra gözden geçirme ister.
  Makineye özgü ya da geçici notların (ör. `ip-10-0-0-12 disk layout`, "şu an kapalı") süresi **14 gün** sonra
  kendiliğinden dolar. Her biri **Geri al** ile tek tıkla reddedilir (geçmişte kalır, işlere bir daha verilmez).
- **Benzerler birleşir:** aynı şeyi söyleyen öneriler (Türkçe ve İngilizce ikizleri dahil, anlamca) tek öneri olur;
  Türkçe metin kalır, ötekiler kanıt olarak listelenir. İki ayrı işten gelen aynı ders daha güvenilir sayılır.
- **Günlük özet:** proje sahipleri ve adminler günde bir kez "N yeni şey öğrenildi" bildirimi alır (her öğe için ayrı
  bildirim yok); bağlantı "Otomatik öğrenilen" görünümünü açar.
- **Kalanlar için toplu inceleme:** Bekleyen görünümünde birden çoğunu seç → **Kabul et / Geri çevir / Birleştir**.
- **Bekleyen birikimi temizlemek:** Hafıza → Otomatik öğrenme → **Önizle** (hiçbir şeyi değiştirmez, sayıları
  gösterir) → **Bekleyenlere uygula**. Sunucuda aynı iş:
  `docker exec <master> remyral-master memory:autolearn --dry-run`, sonra `--dry-run` olmadan.
- **Tamamen kapatmak:** sunucuda `MEMORY_AUTO_LEARN=off` (her proje için; öneriler yine bir kişiyi bekler).

Teknik ayrıntı: `docs/design/p17-auto-learning.md`.

## Tekrarlar nasıl ayıklanır?
- Gizli bilgiye benzeyen (token, şifre, anahtar) hiçbir öğrenim önerilmez.
- Aynı metin bir projede yalnız bir kez önerilir (reddedilen de dahil).
- Kelime benzerliği her zaman kontrol edilir.
- **Anlam benzerliği** yalnızca projede **anlamsal arama açıksa** (Settings → Context → Semantic search → Allow
  capture) kullanılır: o zaman öneri, projedeki mevcut dokümanlarla Bedrock üzerinden karşılaştırılır; çok benzerse
  (varsayılan eşik 0.90) hiç gösterilmez, biraz benzerse "benzer doküman" uyarısıyla gösterilir.

## Anlamsal arama (Bedrock, Cohere Embed Multilingual)
- Sağlayıcı: **Amazon Bedrock — Cohere Embed Multilingual v3** (`cohere.embed-multilingual-v3`, Türkçe dahil 100+
  dil, 1024 boyut). Kendi sunucumuzda model çalışmaz. İsteğe bağlı: Cohere Embed v4 (`cohere.embed-v4:0`; Türkçe
  kalitesi henüz doğrulanmadı) veya Titan V2.
- Nereye gönderilir? Yalnız capture açık projelerin doküman başlık+metinleri, iş özetleri ve **projeyle ilgili chat
  mesajları** (aşağıda); ayrıca kişinin kendi sohbetleri (kişi kapatmadıkça). Prompt, log, araç çıktıları ve gizli
  bilgi asla. Arama sorgusu da gönderilir — gizli bilgiye benzeyen sorgu gönderilmez.
- Kullanıldığı yerler: Settings → Context arama kutusu, **Outputs** araması ("özeti eşleşen işler" şeridi; tıklayınca
  o işin dosyaları) ve chat'te `search_context` ("bu projede hangi paket yöneticisi kullanılıyor?").
- Capture kapalıysa ya da sağlayıcı yoksa arama **anahtar kelimeyle** çalışır (hiçbir şey dışarı gitmez) ve ekranda
  "Searched by keywords (…neden)" yazar.
- Sağlayıcıyı veya modeli değiştirirsen indeks **kendiliğinden yeniden kurulur** (audit'e bir kez yazılır).
  Settings → Context'te aktif sağlayıcı, model, boyut, bölge ve **kaynak** (panel / environment / instance role)
  görünür.

## Sohbetler de bilgi birikimine giriyor (chat + embedding)
- **Kendi sohbetlerin (özel):** chat'te yazdıkların ve asistanın cevapları (araç çağrıları ve resim/PDF değil; küçük
  metin dosyaları dahil) gizli bilgiler `[REDACTED]` yapılarak parçalanır ve anlamına göre aranabilir olur. **Sadece
  sen** arayabilirsin — proje üyeleri, admin ve owner bile göremez. Chat listesindeki arama kutusuna 3+ harf yazınca
  "Messages by meaning" bölümü çıkar; asistana "geçen hafta ne konuşmuştuk?" dersen `search_context` (scope: chat)
  ile yalnız senin sohbetlerinde arar.
- **Projeyle ilgili sohbet → proje bilgi birikimi:** bir sohbet bir projeye bağlıysa o mesajlar **"<proje>
  projesinin bilgi birikimine ekleniyor"**: projenin üyeleri proje aramasında (Settings → Context araması, asistanın
  proje araması) bu mesajların kısa parçalarını "Conversation of <kişi>" olarak görür (sohbeti açamazlar). Bağlantı
  model tahminiyle değil, kesin kurallarla kurulur: sohbetin başlığındaki **Project** seçimi (asistan en çok geçen
  projeyi "suggested" diye önerir), mesajdaki **@proje** etiketi, ya da o turda asistanın o proje için hazırladığı
  **taslak kartı** (iş, workflow, otomasyon, deploy…). Bağlanmamış sohbet her zaman yalnız sana özel kalır.
- **Görünür işaret ve anahtarlar:** sohbetin üstünde "Shared with project <X> knowledge" yazar. Aynı yerde **Share with
  project knowledge** kutusu: kaldırırsan o sohbetin proje kayıtları **hemen** silinir (audit'e yazılır).
  **Settings → Chat → My conversations** (herkes görür):
  - **Index my conversations** — kapatırsan sohbetlerinin tüm kayıtları (kişisel + proje) silinir; arama anahtar
    kelimeyle devam eder, dışarı bir şey gitmez.
  - **Share project-related chat with project knowledge** — kapatırsan hiçbir sohbetin hiçbir projeye eklenmez.
  - **Look up related knowledge on every message** — aşağıdaki otomatik kullanım.
  Projenin capture anahtarı kapalıysa (oluştururken işaret kaldırıldıysa) o projeye sohbet de eklenmez.
- **Sohbeti silersen** kayıtları da silinir; **arşivlersen** kalır (arşivdeki sohbet senin aramanda "(archived)" diye
  çıkar).
- **İşlere otomatik girmez:** sohbetler bir işin context paketine **asla kendiliğinden** girmez. İşe girmesinin tek yolu
  bir hafıza önerisini sen kabul etmen.

## Asistan bilgi birikimini kendiliğinden kullanır
- Her mesajında, asistan cevaplamadan önce Remyral **senin okuyabildiğin** en ilgili birkaç şeyi bulur: kendi önceki
  sohbetlerin, sohbetin bağlı olduğu ve @ ile etiketlediğin projelerin dokümanları, kabul edilmiş hafızası, iş
  özetleri ve projeye eklenmiş sohbetler. En fazla 6 parça, ~6 KB, yeterince benzer olanlar; şu anki sohbet hariç;
  gizli bilgiler silinmiş; asistana "veri, talimat değil" diye ayrılmış bir blokta, kaynaklarıyla (sohbet / iş / doküman
  + tarih) gider. Sağlayıcı yoksa aynısı anahtar kelimeyle yapılır.
- Cevabın altında **"Used N related items"** yazar; tıklayınca hangi kaynakların kullanıldığını linkleriyle görürsün
  (başkasının sohbetinin linki yoktur — o sohbet ona özel).
- Başkasının özel (projeye eklenmemiş) sohbeti **asla** kullanılmaz.
- Kapatmak: Settings → Chat → **Look up related knowledge on every message**.

## Bedrock'u açmak (bir kerelik)
Artık **her şey konsoldan**: anahtarları stack.env'e yazman gerekmiyor. Yer: **Settings → Integrations → AWS Bedrock
(embeddings)** kartı. Kart, seçtiğin bölge ve modele göre aşağıdaki IAM policy'yi hazır gösterir (**Copy policy**
düğmesiyle kopyalanır) ve model erişimi adımını hatırlatır.

1. **AWS Console → IAM → Users → Create user** (ör. `<iam-kullanici-adi>`), konsol erişimi yok.
2. Kullanıcıya **inline policy** ekle (yalnız bu modeli çağırabilir; kartta seçtiğin bölge/model ile birebir aynısı
   hazır durur):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "RemyralEmbeddingsOnly",
         "Effect": "Allow",
         "Action": "bedrock:InvokeModel",
         "Resource": "arn:aws:bedrock:us-east-1::foundation-model/cohere.embed-multilingual-v3"
       }
     ]
   }
   ```
   Cohere Embed v4'e geçmek istersen `Resource` listesine
   `arn:aws:bedrock:us-east-1::foundation-model/cohere.embed-v4:0` eklenir (kart, seçili modelin ARN'sini gösterir).
3. **Modeli bir kez etkinleştir:** Bedrock, Marketplace modellerini ilk çağrıda otomatik açar ama bunun için
   `aws-marketplace:Subscribe` yetkisi gerekir — bu yetkiyi uygulama kullanıcısına **vermiyoruz**. Sen yönetici
   hesabınla **Bedrock console (seçtiğin bölge, ör. us-east-1) → Model catalog → Cohere Embed Multilingual**
   sayfasından modeli bir kez dene/etkinleştir (Marketplace ürün kimliği `38e55671-c3fe-4a44-9783-3584906e7cad`).
   Sonrası için yalnız `bedrock:InvokeModel` yeterli.
4. **IAM → Users → <iam-kullanici-adi> → Security credentials → Create access key** ("Application running
   outside AWS"). Çıkan iki değeri **Settings → Integrations → AWS Bedrock (embeddings)** kartına gir:
   - **Region**: ör. `us-east-1` (kontrol düzlemine yakın bir bölge; listede Cohere Multilingual'ın çalıştığı bölgeler var),
   - **Model**: `Cohere Embed Multilingual v3` (varsayılan),
   - **Access key id** (`AKIA…`) ve **Secret access key**,
   - **Save** → authenticator kodu ister. Anahtarlar master'da şifreli saklanır ve **bir daha gösterilmez**
     (kartta yalnız anahtarın son 4 hanesi ve parmak izi görünür). Loglara, audit'e, worker'lara asla gitmez.
5. **Test connection**: Türkçe + İngilizce kısa bir örnek gömülür; başarılıysa vektör boyutu (1024) ve süre (ms)
   görünür. Hata varsa yalnız AWS hata türü ve HTTP kodu + ne yapman gerektiği yazar
   (`AccessDeniedException` → policy veya model erişimi; `UnrecognizedClientException` → anahtar yanlış;
   `ResourceNotFoundException` / `ValidationException` → model bu bölgede yok).
6. Sonra: **Settings → Context → project:<proje> → Semantic search → Allow capture** (admin + kod) ve
   **Projects → <proje> → Memory → Mode → On**. Settings → Context'te sağlayıcı satırında
   **source: panel** yazar.

Bölge veya modeli sonradan değiştirirsen (kartta Save) değişiklik audit'e senin adınla yazılır ve izin verilmiş
projelerin indeksi kendiliğinden yeniden kurulur. Yalnız anahtarları yenilemek indeksi etkilemez. Deploy gerekmez;
kart kaydedildiği anda geçerlidir.

**Hangisi geçerli? (öncelik)** Kart > ortam değişkenleri. Kart boşsa (veya **Remove** dersen) master eski yola düşer:
`SEARCH_PROVIDER=bedrock` + stack.env'deki `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` ("environment") ya da makinenin
instance profile'ı ("instance role"). İstisnalar: sunucuda `SEARCH_PROVIDER=http` veya `local-hash` yazıyorsa o
kazanır (kart "Saved, not in use" der); `SEARCH_PROVIDER=off` her şeyi kapatır (acil anahtar).

**Daha da güvenli seçenek (statik anahtar yok):** EC2 makinesine (control plane) bir **instance profile / IAM role**
takıp aynı policy'yi ona vermek; kartı boş bırakıp stack.env'e yalnız `SEARCH_PROVIDER=bedrock` ve
`SEARCH_BEDROCK_REGION=us-east-1` yazmak. SDK kimliği makineden alır, Settings → Context **source: instance role**
gösterir. Konteynerden erişim için IMDSv2 "hop limit" 2 olmalı
(`aws ec2 modify-instance-metadata-options --instance-id <id> --http-put-response-hop-limit 2 --http-tokens required`).

## Kapatmak / geri almak
- Yeni projeler için: **Settings → Context → Defaults for new projects** (mevcut projeler etkilenmez).
- Bir projede: **Memory → Mode → Off**. Anlamsal aramayı: Settings → Context → **Stop capture** (vektörler, projeye
  eklenmiş sohbet kayıtları dahil, silinir).
- Kendi sohbetlerin: **Settings → Chat → My conversations** (yukarıda) veya sohbet başlığındaki **Share with project
  knowledge**.
- Kartta: **Settings → Integrations → AWS Bedrock → Remove** (kod ister) → ortam değişkenleri / instance role'e,
  onlar da yoksa anahtar kelime aramasına düşülür.
- Sunucuda: `SEARCH_PROVIDER=off` → kart ne derse desin arama anahtar kelimeye düşer, öneriler kelime benzerliğiyle
  çalışmaya devam eder.
  `MEMORY_SUGGEST_INTERVAL_MS=0` → bitmiş işler okunmaz. `MEMORY_CHAT_PER_THREAD_DAY=0` → sohbetler hafıza önerisi
  için okunmaz (varsayılan 5 = sohbet başına günde en fazla 5 öneri).

Teknik ayrıntı: `docs/design/p10-semantic-memory.md`.
