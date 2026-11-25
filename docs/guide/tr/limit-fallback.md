# Remyral: Kullanım limiti dolan iş artık düşmüyor — bekler ya da başka runtime'la devam eder

## Ne değişti?
Önceden bir runtime **kullanım limitine** takılınca (Claude Code'un 5 saatlik / haftalık aboneliği, Opus haftalık
limiti, Codex planının limiti, bir API anahtarının kotası) iş **başarısız** biterdi; o ana kadar yapılan iş
worktree ile birlikte silinirdi. Limite takılan her iş ayrı bildirim üretirdi, limitin ne zaman açılacağı
söylenmezdi; sadece kendi "fallback runtime" listesi olan işler başka runtime'a geçebilirdi. Chat asistanı da
sadece hata verirdi.

Artık (yeni master + yeni worker sürümüyle):

1. **Limit ayrı tanınıyor** — runtime'ın mesajından/olayından "kullanım limiti" (ne zaman açılacağı, hangi limit:
   5 saatlik, haftalık, sadece bir model için, harcama sınırı; abonelik mi API anahtarı mı) ayrı tanınıyor.
   **Giriş (login) sorunu** ve **geçici sunucu hatası** (529, 5xx) limit sayılmıyor.
2. **İş düşmüyor, bekliyor** — varsayılan politika **Otomatik**: limit en geç **6 saat** içinde açılacaksa iş
   **bekler**; makine çalışma alanını (worktree, dosyalar, ajanın oturumu) **saklar**, iş **PAUSED** olur (slot
   boşalır). Limit açılınca (+ birkaç saniyelik rastgele gecikme) iş **kendiliğinden, aynı makinede, aynı denemede
   kaldığı yerden** devam eder. Ajana "limit doldu, şimdi açıldı; dosyalar bıraktığın gibi, kaldığın yerden devam et"
   denir.
3. **Ya da fallback'le devam** — limit daha uzun sürecekse (ya da politika "hemen fallback" ise) iş, projenin
   **sıralı fallback listesindeki** runtime'la **aynı çalışma alanında** devam eder (ör. Claude Code aboneliği →
   Codex aboneliği → OpenCode + seçili model). İş sayfasında "**usage limit on Claude Code; continued on Codex in the
   same workspace**" yazar; denetim kaydına (audit) düşer.
4. **Ücretli fallback ancak izinle** — API anahtarıyla çalışan (token başı ücretli) bir fallback, proje açıkça
   "**Allow paid fallbacks**" demedikçe **hiç kullanılmaz**. Politika kartında her fallback için "iş başına yaklaşık
   maliyet" (son 30 günün API-anahtarı işlerinden) gösterilir. Bütçeler (budgets) fallback'te de geçerli: bütçesi
   dolmuş bir runtime'a geçilmez, iş bekler.
5. **Zamanlayıcı limiti biliyor** — bir makinenin login'i (ya da bir API anahtarı / tek bir model) limitteyse yeni
   işler oraya gönderilmez; kuyrukta "**usage limit until 15:00**" görünür, projede fallback varsa ona gider.
   Makine kartında "**Codex: usage limit reached — resets at …**" yazar.
6. **Tek bildirim** — limite takılan her iş için değil, **her limit için bir bildirim** ("Claude Code 5-hour usage
   limit reached on build-01 — resets at 15:00; 3 iş bekliyor"), limit açılınca da **bir bildirim** ("… has reset").
7. **Chat asistanı** — motor limite takılırsa chat "**Claude Code reached its usage limit; it works again at …**"
   der. Ayarlardan bir **fallback motor** seçiliyse (ör. Codex) **aynı mesaj** orada cevaplanır, limit açılana kadar
   yeni mesajlar doğrudan oraya gider. Fallback yoksa chat ne zaman açılacağını söyler; yazdığın mesaj **kaybolmaz**.

## Nereden ayarlanır?
- **Projeler → Policy → Usage limits** (proje yöneticisi, authenticator kodu ister): mod (Otomatik / Hep bekle /
  Hemen fallback / Başarısız say), "şu kadar saat içinde açılacaksa bekle", sıralı fallback listesi (runtime +
  isteğe bağlı model profili; aynı runtime'ın API-anahtarı profili de olur), "Allow paid fallbacks". Ayar
  yoksa **çalışma alanı varsayılanı** geçerli.
- **Usage → Enforcement → Usage limits** (yönetici): şu an limitte olan login/hesap/anahtarlar ve çalışma alanı
  varsayılanı.
- **Settings → Chat → Fallback engine at a usage limit**: chat'in yedek motoru (aynı makinede).

## Kurulum notu
- Master ile birlikte worker'lar da güncel olmalı (park etme, limit bilgisi ve sohbetteki tespit worker'dadır). Eski
  worker'larda iş yine düşmez ama limit açılınca **yeni bir denemeyle** (çalışma alanı korunmadan) tekrar kuyruğa girer.
- İstersen projelere fallback listesi ekle (ör. Codex); ücretli fallback istiyorsan bütçe de koy.
