# Remyral: Tam erişim (Full access)

## Ne değişti?
İstediğin zaman bir işi **tam makine erişimiyle ve onay sormadan** çalıştırabilirsin. Kararı sen verirsin; her açma
taze authenticator kodu ister, denetim kaydına yazılır ve sana bildirim gider.

## Bir kere açmak (proje + makine)
1. Projects → proje → Execution policy → **"Full access (full machine + no approval prompts)"** → Enable
   (taze kod). Tek kayıtta: host execution + unconfined + auto-approve.
2. Machines → makine → Sandbox & policy → **"Allow unconfined…"** (ADR-0019, değişmedi; makinede yerel yasak varsa açılmaz).
3. Makine bu sürüme güncellenmiş olmalı (özellik: `full-access-v1`). Eski sürüm asla seçilmez; neden yanında yazar.

## İş başlatırken
- Composer → "Sandbox & constraints" adımı → **Full access** anahtarı: unconfined + "Never ask" + güvenilir kaynak
  seçer. Proje ya da uygun makine izin vermiyorsa anahtar kapalıdır ve eksik olan şey linkiyle yazılır.
- Chat: asistan tam erişimi yalnızca proje izin veriyorsa önerir; kartta büyük **"Full access"** rozeti olur. İş,
  sen karttaki onay düğmesine basınca başlar.

## Yine de onay isteyenler (değişmedi)
Korumalı dala push/merge, force-push, deploy, workspace dışında silme, gizli değer okuma, bütçe artırma ve
credential vault işlemleri her zaman master onayından geçer. Güvenilmeyen kaynak (fork PR, dış katkı) asla
otomatik onaylanmaz.

## Riskler
Tam erişimde ajan, worker servis hesabının yapabildiği her şeyi (o hesabın girişleri, diğer işler, ağ) **kimse
bakmadan** yapabilir. Süre, bütçe, kaynak limitleri ve iptal geçerlidir. O makinede başka hesapların git/CLI
girişlerini tutma; istemediğin makinede config.json'a `"localCeiling": { "allowUnconfined": false }` yaz.

## Kapatmak
Projects → Execution policy → **"Turn full access off"** (host execution kalır, unconfined ve auto-approve kapanır).

## Daha az soru ("ask-sensitive")
Normal modda da artık işin kendi klasörüne (`out/` dahil) yazmak ve salt-okur komutlar onay sormaz. Klasör dışına
dokunan ya da bir şey değiştiren komutlar yine sorar.

## Onay modunu sonradan değiştirmek
- **İş başlamadan:** composer (Rules), otomasyon formu ve artık **chat kartı** (Confirm'den önce "Approval mode"
  seçimi) modu seçtirir. Gönderilmiş ama henüz çalışmayan (kuyrukta, makine/kota bekleyen) bir iş için de: iş
  sayfası → **Approval mode** → seç → **Change**. İş başladığında yeni modla başlar.
- **İş çalışırken:** aynı yer → **Change now**. Bekleyen onaylar yeni moda göre hemen çözülür: "Refuse sensitive
  actions" bekleyenleri reddeder; "Never ask" yalnızca runtime araç çağrılarını onaylar (merge, push, deploy, gizli
  değer ve makine yönetimi komutları yine seni bekler). Makineye imzalı mesaj gider; sayfada nasıl uygulandığı yazar:
  *canlı uygulandı* · *worker kapısı uyguluyor* · *kısmen* · *sonraki turda* · *makine reddetti*.
- **"Never ask"** yalnızca yeni bir iş için de izin verilen yerde seçilebilir (güvenilir kaynak + proje izni; makine
  yönetiminde ayrıca taze kod ve makinenin auto-approve'u). Viewer değiştiremez. Her değişiklik denetim kaydına ve
  iş zaman çizelgesine yazılır.
- **Runtime'a göre:** Claude Code ve Pi anında uygular. OpenCode yalnızca sorduğu şeylerde yeni modu izler (başta
  sormadan izin verdiklerini durduramaz → "kısmen"). Codex politikasını tur ortasında değiştiremez; daha sıkı mod bir
  sonraki turda geçerli olur → "sonraki turda". Uyarı görürsen ve hemen geçerli olması gerekiyorsa işi iptal edip yeni
  modla yeniden başlat.
- Makine bu sürüme güncellenmiş olmalı (`approval-mode-switch-v1`); değilse çalışan iş için düğme kapalıdır ve
  nedeni yazar. Kuyruktaki işler her makinede çalışır.
