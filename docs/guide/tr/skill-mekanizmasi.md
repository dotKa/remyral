# Remyral: Skill mekanizması

## Skill nedir?
Ajanlara verilen hazır beceri paketi. Örnek: "release notu yaz", "proje test kuralları", "Flutter build sorunlarını çöz".
Bir skill = SKILL.md (ne zaman ve nasıl kullanılacağı) + isteğe bağlı ekler: scripts/, references/, resources/, assets/.
Sadece metin: en fazla 32 dosya, toplam 128 KB. Çalıştırılabilir dosya yalnızca scripts/ altında olabilir.
Geniş düzen (layout v2): üst düzey reference.md, templates/, examples/ gibi klasörler de olabilir; skill başına 64 dosya / 512 KB (dosya başına 128 KB), iş başına 640 KB. Bugünkü düzene sığmayan skill'leri yalnız yeni worker sürümündeki (skills-layout-v2) makineler çalıştırır; eski makine "güncelle" gerekçesiyle seçilmez.

## Context'ten farkı
- Context = kurallar ve hafıza ("commit mesajları İngilizce olsun"). Her işe otomatik eklenir.
- Skill = yetenek ("şu işi şu adımlarla yap"). Sadece atandığı projede ve runtime'da gelir.

## Yaşam döngüsü
1. YAZ: Bir klasöre SKILL.md ve gerekirse script ve referans dosyalarını koy.
2. İMZALA (çevrimdışı, kendi bilgisayarında):
   node scripts/skills/sign.mjs pack --dir ./release-notes --version 1.2.0 --runtimes claude-code,codex --key <skills-key.pem> --out release-notes-1.2.0.json
   Skill anahtarı ayrı bir anahtardır ve sunucuda durmaz. İmzasız ya da sonradan değiştirilmiş skill hiçbir yerde kabul edilmez.
3. YÜKLE: Panel → sol menü Skills → Upload. Admin yetkisi ve authenticator kodu gerekir.
   Sunucu imzayı doğrular ve dosyalarda secret taraması yapar. Aynı sürüm numarasıyla farklı içerik reddedilir.
   KOLAY YOL (elle imza yok, ADR-0054): Yetenekler → "Yetenek içe aktar" → klasör, zip ya da GitHub klasör bağlantısı →
   Önizle. Önizlemede dosyalar, secret taraması (varsa yayımlanamaz), script / riskli talimat uyarıları ve lisans görünür.
   "Panel anahtarıyla imzala ve yayımla" her seferinde yeni bir authenticator kodu ister; sürümde
   "Panelden içe aktarıldı · repo@commit" rozeti görünür, sahiplere kritik bildirim gider.
   Bir proje yalnız çevrimdışı imzalı skill alsın istersen: Projeler → proje → Politika → Yetenek imzası.
4. ATA: Skills → skill → Assign. Proje seçilir. İsteğe bağlı olarak:
   - runtime seçilir (yalnızca Claude Code gibi),
   - sürüm sabitlenir (boş bırakılırsa en yeni sürüm kullanılır).
5. KULLANIM: O projede iş açıldığında, sistem makineye göndermeden önce skill'i bir kez daha doğrular ve İŞE SABİTLER.
   Sonra yeni sürüm yüklesen bile o iş (tekrar denemeleri dahil) aynı sürümle devam eder.
6. MAKİNE TARAFI: Worker imzayı kendi güvendiği anahtarla tekrar kontrol eder. Uymazsa işi hiç başlatmaz.

## Ajan skill'i nasıl görür?
- Claude Code (API anahtarıyla), Codex, Pi: native skill olarak, işe özel gizli bir klasörden yüklenir. Repoya hiçbir şey yazılmaz.
- Claude Code aboneliğe giriş yapılmış makinede, OpenCode: talimat olarak prompt'un başına eklenir.
  İçerik aynıdır, sadece sunuş biçimi farklıdır.
- Repodaki .claude/skills, .agents/skills gibi skill'ler YÜKLENMEZ. Repo içeriği güvenilmez sayılır, yalnızca panelden imzalı gelen skill'ler kullanılır.
- Script'ler kendiliğinden çalışmaz. Ajan çalıştırmak isterse sandbox içinde, normal onay kurallarıyla çalışır.

## Güvenlik özeti
- İmza: çevrimdışı Ed25519 anahtarı. Panel ele geçirilse bile sahte skill makinelere geçmez.
- Sürüm sabitleme: işin ortasında skill değişmez, eski sürüme gizlice dönülemez.
- Proje ayrımı: bir projenin skill'i başka projenin işine gitmez.
- Skill içeriğini tüm panel kullanıcıları görebilir, bu yüzden içine secret koyma (yükleme zaten engeller).
- Yükleme, atama ve her işe veriliş audit kaydına yazılır.

## Skill anahtarı
- Kurulumda bir skill imza anahtarı üretilir (keygen); açık anahtar sunucuya ve makinelere tanımlanır, özel anahtar
  yöneticide kalır.
- Skills sayfasında "skills key not configured" uyarısı görüyorsan anahtar henüz tanımlı değil demektir.

## Sınırlar
- Bir işe en fazla 8 skill gider.
- Anahtar yenilemede aynı anda en fazla 2 anahtar geçerli olur.
- Claude Code'un native skill yüklemesi gerçek CLI ile henüz doğrulanmadı.
