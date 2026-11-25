# Remyral: Birleştirme (birden fazla ajanın kodu → tek dal, tek PR)

## Ne bu?
Bir iş başka ajanlara alt işler verdiğinde (veya bir workflow'da birkaç adım aynı repo'da çalıştığında) her ajan **kendi
dalında** çalışır. Eskiden her biri ayrı PR açıyordu ve kimse bunları birleştirmiyordu. Artık **master birleştiriyor**:
- Bütün dallar tek bir **entegrasyon dalında** toplanır: `int/<işin ilk 8 karakteri>`.
- Çakışma olursa bunu çözmesi için sınırlı sayıda **çakışma çözüm işi** (ajan) açılır.
- Sonuç üzerinde projenin **testleri** çalışır; kırılırsa sınırlı bir **düzeltme işi** açılır.
- En sonunda **TEK bir PR** açılır (GitHub). Alt işlerin kendi PR'ı olmaz.
- **Birleştirmeyi yine sen onaylarsın** (admin + authenticator kodu). Otomatik merge yok.

Model: **master yönetimli birleştirme, tek PR** (ADR-0041).

## Nasıl çalışır? (adım adım)
1. Koordinatör iş (ör. Claude Code) işi böler, alt işler açar. Her alt işe hangi dosyalara dokunacağını söyler
   (`paths`, ör. `src/api/`, `docs/`). İki alt iş aynı dosyaları isterse **uyarı** gelir (ajan da görür, panelde de
   görünür) — engellenmez ama çakışma riski var demektir.
2. Alt işler biter, her biri git flow ile **doğrulanır** (gerçekten push ettikleri dal, doğru imza).
3. Koordinatör de bittiğinde master entegrasyonu başlatır:
   - `int/…` dalı hedefin (ör. `main`) şu anki halinden açılır.
   - Bir **entegrasyon işi** bir makinede gerçek git ile dalları sırayla birleştirir — **bu adımda ajan yok**, sadece git.
   - Sıra: önce bağımlılıklar, sonra dosyaları çakışmayanlar, en son çakışabilecekler; koordinatörün kendi değişiklikleri
     en sona.
4. **Çakışma varsa:** birleştirme durur; bir **çözüm işi** (ajan, koordinatörle aynı kurallar) iki tarafın değişikliğini,
   çakışma işaretlerini ve iki görevin tanımını görür, **sadece çakışan dosyaları** düzeltir. Sonra birleştirme devam eder.
   Varsayılan en fazla 3 tur; olmazsa iş **"insan gerekiyor"** durumunda durur.
5. **Testler:** her şey birleşince projenin test komutu (Project → Deploy → Verification) ya da `package.json`'daki
   build/lint/test çalışır. Kırılırsa 1 **düzeltme işi** (varsayılan); yine kırıksa "insan gerekiyor".
6. **Tek PR:** GitHub'da `int/…` → `main` PR'ı açılır; açıklamada hangi görevler, hangi ajan/runtime/makine, çakışma
   kaydı ve test sonucu yazar. GitHub'sız (düz git) repolarda PR yok; aynı korumalı merge kullanılır.
7. **Merge:** işin sayfasındaki **Integration** panelinde "Changes panelinden merge iste" bağlantısı var → onay +
   authenticator kodu → merge. (GitHub'da PR'ı oradan da merge edebilirsin; dal koruma kuralların geçerli.) Merge
   olunca alt işler de otomatik "onaylandı" olur (onaylayan sen olarak).

## Workflow'larda
Repo'lu bir workflow'da **integrator** adımı artık ajan olarak çalışmaz; master yukarıdaki boru hattını çalıştırır. Adım
"merge bekliyor" durumunda kalır, merge olunca workflow biter.

## Ayarlar (Projects → proje → Repository → Integration)
- **Mode:** Master-managed integration — one PR (varsayılan) / Off (eski davranış: her işin kendi PR'ı, integrator ajan).
- **Merge order:** Dependency order (varsayılan, görev veriliş sırası) / Completion order (bitiş sırası).
- **Max conflict-resolution rounds:** 0–10 (varsayılan 3).
- **Max fix rounds:** 0–5 (varsayılan 1).
Değiştirmek admin + authenticator kodu ister, denetim kaydına düşer.

## Panelde ne görürsün?
İşin sayfasında (ve workflow çalıştırma sayfasında) **Integration** paneli: durum (Merging / Resolving a conflict /
Running tests / Fixing tests / Ready for review / Merged / Needs a human …), `int/… → main`, PR linki, dalların sırası ve
durumu (merged / conflict / resolved), çakışan dosyalar, çözüm işi linki, test sonucu, uyarılar, kayıt. **Cancel** (iptal)
ve "insan gerekiyor" durumunda **Retry** (tur sayaçlarını sıfırlayıp devam eder).

## Hangi runtime alt iş açabilir?
- **Claude Code:** evet. **Codex:** evet (yeni). **Pi:** evet (yeni).
- **OpenCode:** hayır — iş sandbox'ı OpenCode'un araç sunucusuna bağlanmasına izin vermiyor (gerekçe ve yapılması gerekenler
  tasarım notunda §10). Koordinatör olarak Claude Code / Codex / Pi kullan.

## Güvenlik
- Hiçbir şey otomatik merge olmaz; merge her zaman senin onayın.
- Ajan/repo metinleri (görev tanımları, diff'ler, test çıktısı) **veri** olarak verilir, talimat olarak değil.
- Entegrasyon dalı sadece ileri sarılır (force push yok); dışarıdan değiştirilirse durur ve sana sorar.
- Her işin sonucu uzak repo'da bağımsız doğrulanır (worker'ın sözüne güvenilmez).

## Deneme
GitHub bağlı bir repo projesinde: proje politikasında **Sub-jobs** açık, delegation runtimes'ta **codex**
işaretli. Claude Code ile şunu başlat: "İki parçaya böl: (1) `src/` altında API, (2) `docs/` altında dokümantasyon;
ikincisini Codex yapsın, her alt işe `paths` ver." → Integration panelinde akışı izle → GitHub'da **tek PR** → Changes
panelinden merge iste → onayla. Güncel master ve worker sürümü gerekir.

Kaynak: `docs/design/p11-merge-pipeline.md`, `docs/adr/0041-master-managed-integration.md`.
