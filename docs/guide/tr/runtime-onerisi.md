# Remyral: Hangi işe hangi runtime? — geçmiş sonuçlardan runtime önerisi (ve isteğe bağlı otomatik seçim)

## Ne değişti?
Önceden bir işin runtime'ını (Claude Code, Codex, Pi, OpenCode) sen seçerdin, ya da yöneticinin iş türüne göre
koyduğu yönlendirme kuralı seçerdi. Geçmiş sonuçlar sadece **hangi makinenin** işi alacağını etkilerdi. Platform
"bu projede frontend işlerinde Claude Code iyi, test yazmada Codex iyi" diyemezdi; "başarılı" da sadece
"deneme hatasız bitti" demekti.

Artık:

1. **Her iş sınıflandırılıyor** — işin türü (planla, uygula, doğrula …) ve **alanı**: frontend, backend, testler,
   dokümantasyon, altyapı/deploy. Neye bakılıyor: işin sonunda **değişen dosyaların yolları** (en güçlü işaret;
   projeye özel yol kuralları da yazılabilir), alt işin dosya listesi, prompttaki dosya adları (`Header.tsx`),
   Türkçe ve İngilizce anahtar kelimeler ("buton", "veritabanı", "testleri yaz", "yayına al" …), şablon/otomasyon adı.
   Yapay zeka yok, her şey kurallı ve açıklanabilir: iş sayfasında hangi işaretten hangi alanın çıktığı yazar.
   Belirsizse "sınıflandırılmamış" kalır, tahmin edilmez.
2. **Sonuç kalitesi ölçülüyor** — "iyi sonuç" = iş başarılı **ve** sonradan doğrulama/CI'da düşmedi, birleştirmede
   reddedilmedi, birkaç gün içinde aynı promptla tekrar çalıştırılmadı (düzeltilmiş sayılır) ve 👎 almadı. İş
   sayfasına **👍 / 👎** eklendi (operatör ve üstü); insanın oyu otomatik işaretlerden önce gelir.
3. **Öneri (varsayılan)** — iş taslağı yazarken (composer), chat'in iş kartında ve koordinatörün alt iş isteklerinde:
   "Bu projenin frontend işleri için önerilen runtime: Claude Code — %91 iyi sonuç (n=23), Codex %74 (n=19);
   medyan 12 dk; tahmini maliyet $0.42". Composer'da "Claude Code'u kullan" düğmesi var. **Öneri hiçbir şeyi
   değiştirmez**, seçim sende. Chat asistanı da öneriyi görür ve sana söyler; runtime'ı kendi başına değiştirmez.
4. **Otomatik mod (proje bazında, yönetici açar)** — Projeler → Politika → Runtime önerisi → Mod: **Otomatik**.
   Sadece runtime'ı **"Otomatik"** seçilen işler için geçerli: platform, izin verilen runtime'lar arasından, ücretli
   (API anahtarlı) runtime'lara izin verilmediyse onları atlayarak, kullanım limitine takılmış, kotası tutulmuş ya da
   hiçbir makinenin çalıştıramadığı runtime'ları dışarıda bırakarak **en iyi sonuç geçmişi olanı** seçer. Kararların
   küçük bir kısmında (varsayılan %10, en fazla %30) az denenmiş bir runtime'ı **dener** — production deploy
   işlerinde asla. Yeterli geçmiş yoksa yönlendirme kuralına uyar. İş sayfasında "Otomatik mod Claude Code'u seçti
   çünkü …" yazar. **Açıkça runtime seçtiysen asla değiştirilmez.**
5. **Görünüm** — Kullanım → Sonuçlar'da proje seçip **runtime × alan tablosu**: iyi sonuç oranı, güven aralığı, iş
   sayısı, son 30 gün eğilimi, medyan süre, maliyet, model kırılımı ve alan başına öneri.

## Ayarlar (Projeler → Politika → Runtime önerisi)
- **Mod:** Kapalı / Öneri (varsayılan) / Otomatik
- **Keşif oranı** (%0–30, varsayılan 10), **en az iş sayısı** (varsayılan 5: bir runtime bir alanda 5 iş bitirmeden
  önerilmez), **yarı ömür** (varsayılan 60 gün: eski sonuçlar daha az sayılır), **tekrar penceresi** (varsayılan 3 gün)
- **Otomatik modun seçebileceği runtime'lar** (hiçbiri işaretli değilse hepsi), **ücretli runtime'lara izin**
- **Yol kuralları**: hangi klasör hangi alan (`packages/ui/**` → Frontend gibi)

Değişiklik için yönetici + doğrulama kodu gerekir, denetim kaydına yazılır.

## Nasıl denenir?
- Worker güncellemesi gerekmez; güncel master ve konsol yeterlidir.
- Geçmişi olan bir projede composer'a ör. "navbar düzenini düzelt" yaz → öneri satırı çıkar; Kullanım → Sonuçlar'da
  tablo dolar. Bir projeyi Otomatik'e alıp runtime'ı "Otomatik" seçilen bir iş gönderirsen iş sayfasında "Otomatik mod
  … seçti çünkü …" yazar.
- Bitmiş işlere 👍 / 👎 ver; öneriler bununla daha doğru olur.
