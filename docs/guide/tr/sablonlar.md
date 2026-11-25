# Remyral: Şablonlar (tekrar eden işler için hazır kalıplar)

## Ne bu?
**Şablon** = bir kere yazılan, içinde boşluklar olan iş. Örnek:
`Hedef kitle analizi yap ve {{url}} için {{audience_count:int}} kişilik bir landing page hazırla.`
Çalıştırırken sadece URL'yi ve sayıyı girersin; gerisi (runtime, model, sandbox, onay modu, süre limiti, bitince deploy)
şablonun ayarlarından gelir.

Yeri: **Jobs → Templates** (iş listesinin üstündeki "Templates" düğmesi).

## Boşluk (parametre) türleri
- `{{url}}` — düz metin (tek satır). `{{site:url}}` — adres (sadece http/https).
- `{{adet:int}}`, `{{oran:number}}` — sayı (alt/üst sınır verilebilir).
- `{{ton:enum(resmi|samimi)}}` — seçenekli.
- `{{notlar:text}}` — çok satırlı metin. `bool` — evet/hayır. `file` — iş girdisi dosyası (çalışma alanı projeleri).
Her parametreye etiket, açıklama, zorunlu / varsayılan değer verilebilir.

**Güvenlik:** girilen değerler prompta **tırnaklı veri** olarak girer, sonda ayrı bir "veri bloğu"nda bir daha listelenir
— talimat sayılmaz. Bir değer ne olursa olsun sandbox'ı, onay modunu, modeli, limitleri ya da deploy'u **değiştiremez**;
bunlar şablonun ayarlarıdır. "Never ask" / unconfined gibi tam erişim ayarı ancak proje izin veriyorsa kaydedilir; global
şablonda hiç olmaz.

## Şablon nasıl oluşur?
1. **Kendiliğinden öneri:** son 90 günde benzer işleri / sohbet taslaklarını 3+ kez verdiysen Templates sayfasının üstünde
   "Suggested from your recent work" kartı çıkar: ortak metin + değişen kısımlar parametre olarak (ör. URL → `{{url}}`).
   Karşılaştırma sunucuda, metin benzerliğiyle yapılır — **model yok, dışarı bir şey gitmez**.
   - **Create template** → düzenleyici dolu açılır, kaydet.
   - **Dismiss** → bu öneriyi gizle. **Not similar** → "bunlar aynı iş değil", bir daha birlikte önerilmez.
   - **Refine with an agent…** → isteğe bağlı: bir ajana şablonu iyileştirtmek için composer'ı hazır açar; sen
     göndermezsen hiçbir şey çalışmaz.
2. **Bir işten:** iş sayfası → **More → Save as template**. Prompt aynen gelir; içindeki URL'ler ve sayılar
   "Make a parameter" düğmeleriyle tek tıkla `{{url}}` olur.
3. **Sohbet kartından:** asistanın iş taslağında **Save as template**.
4. **Elle:** **New template**.

Düzenleyicide altta **canlı önizleme** var: örnek değerleri gir, ajanın göreceği promptun aynısını gör.

## Yönetmek
- Her içerik değişikliği yeni **sürüm** (v1, v2, …); **Versions** sekmesinde iki sürüm arası fark (diff).
- **Duplicate** (kopya), **Archive / Restore** (arşivlenen çalıştırılamaz, geçmişi ve istatistiği kalır).
- İstatistik: kaç kez çalıştı, başarı oranı, ortalama maliyet ve süre, kaç otomasyon kullanıyor.
- Proje şablonu: o projede operator+ düzenler. **Global** şablon: her projede kullanılabilir, sadece admin/owner düzenler.

## Çalıştırmak
- **Panelden:** şablon → **Run** → değerleri gir → **Open in composer**. Composer dolu açılır, kontrol edip gönderirsin
  (iş şablona yazılır, istatistiğe girer).
- **Zamanlı:** **Automate…** → ad + cron (UTC) → taze authenticator kodu. Otomasyon o anki sürümün promptuyla çalışır;
  şablonu sonra değiştirmek onaylanmış otomasyonu kendiliğinden değiştirmez (yeni sürüm için yeni otomasyon kur).
- **Sohbetten:** "landing page şablonunu https://ornek.example için çalıştır", "şablonu çalıştır", "şablonlarımı göster".
  Asistan uygun şablonu bulur, hangi şablonu (ad + sürüm) kullandığını söyler, eksik zorunlu değeri sorar ve normal iş
  kartını hazırlar — **onayı yine sen verirsin** (taze kod). "Her pazartesi çalıştır" dersen şablondan otomasyon kartı
  hazırlar. Şablonda "In chat, tell me when a run finishes" açıksa bitince sohbete haber gelir.

## Sürüm notu
- Sohbet araçları (`list_templates`, `draft_from_template`) worker'da kayıtlıdır. Eski worker sürümlerinde panel
  tarafı çalışır, sohbet yalnızca şablon araçlarını sunmaz.
