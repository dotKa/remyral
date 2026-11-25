# Remyral: Runtime limitleri artık görünüyor — iş oluştururken, makine ekranında, ana sayfada

## Ne değişti?
Önceden bir runtime'ın kullanım limiti ancak **dolunca** görünüyordu (bkz. [limit-fallback.md](limit-fallback.md): iş bekler ya da
fallback'le devam eder). Ne kadarının kullanıldığı, ne zaman sıfırlanacağı görünmüyordu.

Artık (yeni master + yeni worker sürümüyle) her makinenin her runtime girişi (abonelik login'i ya da API anahtarı) için:

- **Claude Code:** 5 saatlik pencere, haftalık pencere, model bazlı haftalık pencereler (Opus / Sonnet / diğer) —
  yüzde kaç kullanıldı, ne zaman sıfırlanıyor.
- **Codex:** planın birincil (5 saatlik) ve ikincil (haftalık) penceresi — yüzde kaç kullanıldı, ne zaman sıfırlanıyor.
- Sayıların **nereden geldiği** ve **ne kadar eski olduğu**: "Read 2 min ago" (doğrudan okundu) ya da "Last seen in a
  job 12 min ago" (son işte görüldü).

## Nerede görünüyor?
1. **İş oluştururken (composer):** runtime seçiminin hemen altında her runtime için tek satır:
   "Codex · 5h 86% (resets 15:00) · weekly 40%". Renk: yeşil (rahat), turuncu (%80 ve üstü, limite yakın), kırmızı
   (dolu). Seçtiğin runtime limite yakınsa altında uyarı çıkar ("uzun bir iş limite takılabilir; o zaman bekler ya
   da fallback'le devam eder"). Birden fazla makinede varsa **en boş olan** gösterilir ("best of 2 machines").
2. **Chat'teki iş kartı:** asistanın hazırladığı işin runtime'ı için aynı satır.
3. **Makine ekranı → Runtimes:** "Runtime limits" kartı — her pencere için çubuk, yüzde, "Resets Thu 08:00 (in 2 d 4 h)"
   geri sayımı, son 24 saatin mini grafiği, limit dolduysa kırmızı uyarı.
4. **Makine listesi:** limite yakın / dolu runtime varsa küçük rozet ("Codex near limit").
5. **Ana sayfa (Home):** Makineler'in altında "Runtime limits" özeti — en kritik olan en üstte.
6. **Usage → Enforcement:** tüm makineler × runtime'lar × pencereler tablosu, 24 saatlik mini grafikler, API anahtarı /
   hesap limitleri ve "limite yakın" ayarı.
7. **Chat asistanı:** "limitler ne durumda?" diye sorabilirsin — aynı veriyi okuyup özetler (`runtime_limits` aracı).

## Bildirim
Bir pencere **%80'i** geçince (ayar: Usage → Enforcement, 50–99 arası, değiştirmek için authenticator kodu)
owner / admin'lere **"Usage limit nearly reached"** bildirimi gider — **her pencere ve dönem için bir kez**. İstemeyen
kendi bildirim tercihlerinden kapatabilir; ayardan tamamen de kapatılabilir.

## Bilmen gerekenler
- **Hiçbir şifre / token dosyası okunmuyor.** Worker sadece runtime'ın kendi sunduğu "okuma" çağrısını kullanıyor;
  **modele istek atılmıyor, kota harcanmıyor.**
- **Codex:** her ~10 dakikada bir doğrudan okunur (canlı).
- **Claude Code:** CLI'nin `/usage` verisini okuyan çağrı SDK'da "deneysel" işaretli. Çalışırsa canlı okunur; çalışmazsa
  sayılar sadece bir iş ya da chat turu çalışırken güncellenir ("Last seen in a job …" yazar).
- **API anahtarları:** runtime'lar sağlayıcının hız limiti başlıklarını vermiyor; API anahtarında limit ancak
  **dolunca** görünür (eskisi gibi).
- Sayılar **bilgi amaçlı**: iş yerleştirme hala gerçek limit dolmalarına göre çalışır.
- Worker'da `usageProbeMinutes` (varsayılan 10; 0 = sadece işlerde görülenler) ile okuma sıklığı ayarlanabilir.

## Kurulum sırası
Önce master ve web, sonra worker'lar güncellenir (worker özelliği `runtime-usage-v1`). Eski worker'lar için ekranda
"This machine's worker does not report usage windows yet (update it)" yazar.
