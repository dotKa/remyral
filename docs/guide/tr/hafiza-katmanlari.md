# Remyral: Hafıza katmanları (kurallar, bilgiler, kararlar, dersler)

## Ne değişti?
Hafıza artık tek bir yığın değil. Her kayıt bir **türe** ve bir **kapsama** sahip:

| Tür | Ne için? | Örnek |
| --- | --- | --- |
| **Kural** (rule) | Ajanların uyması gereken talimat | "Her commit'ten önce `pnpm test` çalıştır." |
| **Bilgi** (fact) | Projeye dair kalıcı bilgi | "Marka ana rengi #FF5A1F." |
| **Karar** (decision) | Teknik karar geçmişi (mini ADR): karar, bağlam, sonuçlar, tarih, kim | "Staging Coolify ile deploy edilir — tek sunucu daha ucuz; Vercel önizleme yok." |
| **Ders** (lesson) | Bir ajanın öğrendiği çalışma deneyimi | "Codex'te pnpm install için sandbox ağ izni gerekiyor." |

Kapsamlar: **global** (tüm projeler), **runtime:<ad>** (tüm projeler, tek runtime), **kişisel** (sadece senin
oluşturduğun işler ve sohbetler), **proje**, **proje + runtime**.

## Hangi sırayla ajana gider?
Platform politikası → **global kurallar** → **işi oluşturan kişinin kişisel kuralları** → **proje kuralları** →
**kararlar** → **bilgiler** → **dersler** (runtime'a özel olanlar sadece o runtime'da). Hafıza bütçesi (64 KiB)
dolarsa önce kararlar, sonra bilgiler, sonra dersler; aynı türde iş metnine **en alakalı** olan (Bedrock, projede
anlamsal arama açıksa), sonra en yenisi önce girer. Kurallar asla kesilmez.

**Dört runtime'da aynı:** Claude Code, Codex, Pi ve OpenCode birebir aynı metni ilk mesajda alır.

## Eskiyen bilgi
- **Yerine koy (supersede):** yeni kayıt eskisinin yerini alır; eskisi "superseded" olur, geçmişte durur, işlere
  gitmez.
- **Süresi doldu (expire) / reddet (reject):** artık hiçbir işe verilmez; sebebi yazılır. Son kullanma tarihi
  verirsen o an itibarıyla dışarıda kalır.
- **Gözden geçir (review-by):** tarih gelince bildirim gelir ("Review this decision") ve **Senden bekleyenler** sayfasında (`/needs`)
  görünür. "Hala doğru" deyip yeni tarih verebilirsin.
- **Çakışma önerisi:** yeni kayıt mevcut bir kayda çok benziyor ya da onunla çelişiyorsa ("pnpm" ↔ "yarn", "her
  zaman" ↔ "asla", farklı renk/versiyon), Remyral "**bu, X'in yerini alabilir**" der. Karar senin: **Supersede** ya da
  **Keep both**. Otomatik hiçbir şey değişmez.
- Çalışan bir iş, aldığı sürümü korur (sonradan değişen kayıt onu etkilemez).

## Ajanların dersleri
Ajan cevabında kendi satırında şunu yazarsa:
```
LESSON: <kısa başlık> — <ne işe yaradı / neden>
MEMORY: <kısa başlık> — <projeye dair kalıcı bilgi>
```
Remyral bunu **öneri** olarak **Projects → <proje> → Memory** gelen kutusuna koyar (ders: proje + o runtime;
bilgi: proje). **Asla kendiliğinden kabul edilmez** — sen türünü, kapsamını, gözden geçirme tarihini seçip kabul
edersin; istersen mevcut bir kaydın yerine koyarsın. Dört runtime için aynı kural; worker güncellemesi gerekmez.

## Nerede?
- **Projects → <proje> → Memory:** türe göre gruplu kayıtlar, filtreler, düzenle / yerine koy / süresini bitir /
  reddet / gözden geçirildi, geçmiş, olası çakışmalar, **karar geçmişi**, eski (türsüz) dokümanlara tür verme, öneri
  kutusu.
- **Settings → Context:** global ve runtime'a özel kurallar (admin).
- **Settings → Profile & security → Personal rules:** kişisel kuralların (sadece sen görürsün; senin işlerin ve
  sohbetlerin için).
- **İş sayfası → "Memory given to this job":** bu işe tam olarak hangi kayıtların (sürümleriyle) verildiği.
- **Sohbet:** "bunu kural olarak ekle", "bu karar eskisinin yerini alıyor", "bu kural eskidi, kaldır" dersen asistan
  bir **kart** hazırlar; onaylayınca uygulanır (`draft_memory_change`, worker güncellemesi gerekir). Arama sonuçları
  `[rule]` / `[decision]` gibi işaretli gelir, eskimiş kayıtlar hiç görünmez.

## Güvenlik
- Ajan metni sadece öneridir; bir ajan asla kural yazamaz. Gizli bilgi (token, şifre) taranır, reddedilir.
- Kişisel kurallarını admin dahil kimse göremez; sadece senin oluşturduğun işlere gider.
- Her değişiklik audit'e yazılır.
