# Remyral: Onay bekleyen iş artık düşmüyor — bekler, duraklar, kaldığı yerden devam eder

## Ne değişti?
Önceden çalışan bir iş (ör. ajan `npm publish` gibi bir komut için) **onay isteyince** makinedeki ajan en fazla
**15 dakika** beklerdi; sonra isteği kendisi "reddedilmiş" sayardı. Sen sonradan onaylasan bile ajan çoktan
vazgeçmiş olurdu; iş genelde **başarısız** biterdi ve başarısız iş **devam ettirilemezdi**. Beklerken makinenin
slotunu da tutar, bekleme süresi işin süre sınırından düşerdi.

Artık (yeni worker sürümüyle):

1. **Bekliyor** — istek açık kalır, süresi dolup işi düşürmez.
2. **Bayat (stale)** — proje ayarındaki süreden sonra (varsayılan **15 dk**) istek ve iş "bayat" işaretlenir:
   karar verebilecek kişilere **"Onayın hala bekleniyor"** bildirimi gider, chat'te izleme varsa bir kez not düşer.
   İş sayfasında **Stale** rozeti çıkar.
3. **Duraklatıldı (PAUSED)** — daha uzun süre (varsayılan **60 dk**) karar gelmezse iş **duraklatılır**:
   - makinedeki ajan nazikçe durdurulur, **makinenin slotu boşalır** (başka işler çalışabilir);
   - **çalışma alanı (worktree / dosyalar) ve ajanın oturumu makinede saklanır** (varsayılan **7 gün**);
   - onay isteği **açık kalır**; "İş duraklatıldı" bildirimi gider.
4. **Karar verince kaldığı yerden devam** — onaylarsan ya da gerekçeyle reddedersen iş kendiliğinden **aynı
   makinede, aynı denemede (attempt) ve aynı oturumla** yeniden başlar; ajana kararın söylenir:
   - **Onay:** ajan aynı komutu tekrar çalıştırır; platform onu **sadece birebir aynı komut ve girdilerle, bir
     kez** onaylı sayar. Farklı bir şey isterse yine sana sorar.
   - **Red:** ajan o adımı yapmaz, işe onsuz devam eder ya da neyin eksik kaldığını yazarak bitirir.
5. **İşi bitiren sadece:** açık bir **red**, **iptal** ya da saklama süresinin (7 gün) **karar gelmeden bitmesi**
   (o zaman iş iptal edilir, saklanan çalışma alanı silinir).

## İş sayfasında ne görürsün?
Duraklatılmış işte "**Paused — waiting for your approval**" paneli: ne zamandan beri, hangi makinede, ne zamana kadar
saklanıyor, hangi onayı bekliyor. Düğmeler:
- **Resume now** — karar verildiyse hemen devam ettir (ör. makine meşguldü / kapalıydı). Karar yoksa önce
  **Decide the approval** bağlantısıyla onay sayfasına gidersin.
- **Restart from scratch** — saklananı bırakıp işi **baştan** başlat (yeni deneme, herhangi bir makinede).
- **Cancel** — işi iptal et.

Duraklama süresi işin **süre sınırından düşmez**; token / tur / maliyet bütçesi aynen devam eder.

**Makine gittiyse** (silindi / arşivlendi / saklanan çalışma alanı kayboldu) iş "devam edemiyor" diye işaretlenir;
o zaman sadece **Restart from scratch** ya da **Cancel** kalır.

**Eskiden onay süresi dolduğu için başarısız olmuş işler:** iş sayfasında **Continue** düğmesi çıkar — aynı
ayarlarla, önceki denemenin özeti ve neyin onaylanmadığı yazılı **yeni bir iş** açar (hiçbir onay devralınmaz,
gerekirse yeniden sorar).

## Kuyruk ekranı
Jobs → Queue'da duraklatılmış işler ayrı bir bölümde ("**Paused (waiting for approval)**") görünür; makine slotu
tutmazlar.

## Ayarlar (proje başına)
Proje sayfası → **Policy** sekmesi → **Long approval waits**: "stale after" (varsayılan 15 dk), "pause after"
(varsayılan 60 dk), "keep paused for" (varsayılan 7 gün, en az 1 saat, en fazla 7 gün). Değiştirmek için proje
admini + doğrulama kodu (step-up) gerekir.

## Chat
- "Onay gerekince haber ver" izlemesi: onay istendi notu **bir kez**, "hala bekleniyor" **bir kez**, "duraklatıldı"
  **bir kez** düşer.
- Onay verince iş kendiliğinden devam eder. Asistan istersen **"Resume now" / "Restart from scratch"** kartı hazırlar
  (sen onaylarsın).
- Alt işler (sub-job): duraklatılmış bir alt iş ana işe "**onay bekliyor, duraklatıldı**" diye bildirilir; ana iş
  beklemeye devam edebilir.

## Güvenlik
- Devam eden iş **hiçbir yeni yetki kazanmaz**: aynı ayarlar, aynı sandbox, aynı onay modu; karar sadece **birebir
  aynı eylem** için geçerli.
- Devam etmeden önce politika **yeniden kontrol edilir**: proje politikası artık o eylemi yasaklıyorsa onay red'e
  döner; onaylayan kişinin yetkisi kalmadıysa iş devam etmez (Restart / Cancel).
- Saklanan çalışma alanının git meta verisi devam ederken kontrol edilir (değiştirilmişse iş durur).
- Her adım denetim kaydına (audit) yazılır.

## Kurulum notu
Önce **master**, sonra worker'lar güncellenir. Eski worker'larda davranış eskisi
gibi kalır (15 dk sonra ajan kendisi reddeder).

**Not:** Claude Code ve Codex'in "resume" özelliği henüz "doğrulanmamış"
olduğundan, izin verilmediyse bu ikisi kaldığı oturumla değil, **özetle yeni bir oturumda** devam eder.
