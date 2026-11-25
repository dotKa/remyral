# Remyral: Hafızanı içe aktar (kendi yapay zeka asistanından)

## Ne bu?
Claude, ChatGPT, Gemini gibi bir asistanla uzun süredir çalışıyorsan o asistan seninle ilgili çok şey biliyor:
hangi araçları kullandığın, nasıl çalışmayı sevdiğin, projelerin, uyulmasını istediğin kurallar, kaçındığın şeyler.
Bu araç o bilgiyi Remyral'e taşır; Remyral seni sıfırdan değil, **tanıyarak** başlar. İçe aktarılan her madde senin
onayınla bir hafıza kaydı olur ve ajanlara her işte verilen hafıza paketinin içinde gider.

Nerede?
- **Kurulum sihirbazı → "Seni tanıyalım"** (sahip hesabı adımından hemen sonra; isteğe bağlı, atlanabilir).
- **Ayarlar → Profil → İçe aktar** (`/settings/profile?tab=import`): istediğin zaman, tekrar tekrar.
- **Projeler → <proje> → Hafıza → İçe aktar** (operatör ve üstü): aynı ekran, ekip bilgisi o projeye önerilir.

## Adım adım
1. **İstemi kopyala.** Ekranda hazır bir istem var. Dilini (Türkçe / İngilizce) ve türünü seç:
   - **Tam istem**: asistandan bildiklerini tek bir kod bloğu olarak, satır başına bir madde (JSON Lines) yazmasını
     ister. Her madde bir türle gelir: tercih, çalışma biçimi, bilgi, proje, kural, araç, kaçınılacak.
   - **Kısa istem**: hafızası kısıtlı araçlar için; "geçmiş sohbetlerimizden bildiklerini özetle" der ve
     `- [tür] metin` satırları ister.
   **İstemi kopyala** düğmesine bas. Ekranda "Tasarlandığı asistanlar: Claude, ChatGPT, Gemini" yazar; bu, istemin
   onlar için yazıldığını söyler, her sürümde birebir uyulduğu doğrulanmış değildir. Biçim tutmazsa Remyral yine
   maddeleri çıkarmaya çalışır.
2. **Asistanında çalıştır.** Yeni bir sohbet aç, istemi yapıştır, yanıtı bekle. Asistan gizli bilgileri (parola,
   anahtar, token), başkalarının kişisel bilgilerini ve sağlık gibi hassas bilgileri yazmamakla görevlendirildi.
3. **Yanıtı yapıştır ya da dosyadan oku.** "Hangi asistandan?" seç (listede yoksa **Diğer** ve adını yaz). Yanıtın
   tamamını yapıştır; ya da `.md`, `.txt`, `.json` dosyası seç (en fazla 256 KB; dosya tarayıcında okunur).
   - **Anlamına göre karşılaştır** (isteğe bağlı, kapalı gelir): Türkçe ve İngilizce aynı şeyi söyleyen maddeleri
     bulmak için metinler bir kez gömme sağlayıcısına (Ayarlar → Entegrasyonlar → AWS Bedrock) gönderilir,
     saklanmaz. Kapalıyken yalnızca kelime benzerliğine bakılır.
4. **Önizle.** Henüz hiçbir şey kaydedilmez. Remyral metni maddelere böler ve her madde için:
   - türünü, önerilen **kapsamı** (varsayılan **Kişisel**) ve **kayıt türünü** gösterir;
   - kontrolleri yapar ve şüpheli maddeleri **seçili getirmez**, nedenini yazar:
     gizli bilgi gibi görünüyor (bu madde hiç içe aktarılamaz; değeri metinden çıkarıp yeniden önizle), ajanlara emir
     veriyor / önceki talimatları geçersiz kılmaya çalışıyor / testleri atlatmaya çalışıyor gibi, başka birinin
     kişisel bilgisi olabilir, hassas bir bilgi olabilir, çok uzun / çok kısa;
   - zaten kayıtlı olanları ("Zaten kayıtlı: …") ve aynı içe aktarmada birbirinin aynısı olanları ("2. madde ile aynı")
     işaretler; aynı şeyi söyleyenlerden en iyi yazılmış olanı (senin dilinde) kalır;
   - benzer ya da çelişebilecek kayıtları not olarak gösterir (bunlar seçili kalır; çelişen bir madde içe aktarılırsa
     Hafıza'daki "Olası çakışmalar"da karşılaştırılır).
5. **Gözden geçir.** Her maddeyi seç ya da bırak; **Tümünü seç / Hiçbirini seçme / Yalnızca işaretsizleri seç** ile
   toplu seçim yap. Metni düzeltebilir, kapsamı ve kayıt türünü değiştirebilirsin.
6. **İçe aktar (N).** Seçtiklerin kayıt olur. Sonuç satırı kaç kaydın eklendiğini ve eklenemeyenlerin nedenini yazar.
7. **Geri almak istersen:** sonuç satırındaki ya da **Önceki içe aktarmalar** listesindeki **Bu içe aktarmayı geri
   al** düğmesi, o içe aktarmanın eklediği etkin kayıtların hepsini reddeder; ajanlara artık verilmezler, geçmişleri
   kalır. Bir içe aktarma bir kez geri alınır.

## Kapsam ve kayıt türü
- **Kişisel** (varsayılan): madde senin **kişisel kuralın** olur. Kişisel kurallar yalnızca **senin oluşturduğun**
  işlere ve sohbetlere eklenir; başka kimse (yöneticiler dahil) göremez. Kişisel kapsamda her tür (tercih, araç,
  bilgi…) kural olarak kaydedilir; maddenin türü etiket olarak saklanır (ör. `kind:preference`). Ayarlar → Profil →
  Kişisel kurallar'da görürsün, düzenler ya da emekliye ayırırsın.
- **Proje** (o projede operatör ve üstü): tercih ve bilgi/proje/araç → **Bilgi**, çalışma biçimi → **Ders**,
  kural ve kaçınılacak → **Kural**. Projenin bütün işlerine gider.
- **Genel** (yönetici ve sahip): tüm projelere gider; türler projedeki gibi.
- İzinler elle kayıt eklemekle aynıdır. İzin olmayan bir kapsam seçilirse içe aktarmanın tamamı reddedilir, hiçbir
  şey yarım yazılmaz.

Kayıtlarda **"İçe aktarıldı · Claude"** rozeti görünür; kaydın ilk sürümünün kaynağı `import: Claude` olarak
tutulur, yazar sensin.

## Güvenlik
- Yapıştırdığın metin **güvenilmeyen veri** olarak okunur: hiçbir şey çalıştırılmaz, içindeki talimatlar izlenmez.
  Sen "İçe aktar" demeden hiçbir şey kaydedilmez.
- Yapıştırılan metnin kendisi saklanmaz; yalnızca özeti (SHA-256) ve boyutu kayda geçer.
- Sınırlar: içe aktarma başına 256 KB ve 200 madde, madde başına 1000 karakter; kişi başına saatte 30 önizleme ve
  10 içe aktarma.
- Her içe aktarma ve geri alma audit'e yazılır (`memory.import`, `memory.import.undo`).

## Sihirbazda
"Seni tanıyalım" adımı isteğe bağlıdır: **Bu adımı atla** ile geçebilirsin, sonra Ayarlar → Profil → İçe aktar'dan
yaparsın. Bir şey içe aktardığında adım kendiliğinden "Tamam" olur (içe aktarmayı geri alırsan yeniden açılır).
