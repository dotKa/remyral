# Remyral: Uzaktan işlemler (panelden)

## Ne değişti?
Makinelere dokunmadan panelden: runtime kur / yükselt / geri al / kaldır, Claude Code ve Codex'e abonelikle giriş, worker'ı yeniden başlat, logları ve tanılamayı gör.
Yer: Machines → makine → Runtimes (giriş, kurulum) ve Activity (loglar, tanı, geçmiş). Her işlem authenticator kodu ister ve audit'e yazılır.

## Runtime kurmak / yükseltmek
1. Runtimes sekmesi → runtime kartı → "Install <sürüm>" ya da "Upgrade to <sürüm>".
2. Makine paketi resmi kaynaktan indirir, worker sürümünün içindeki checksum'larla doğrular, kendi klasörüne kurar. Sistem geneline dokunmaz, sudo yok.
3. Sadece sabitlenmiş (pinned) sürümler kurulur. Geri dönüş yalnızca bir önceki sabit sürüme ("Roll back").
4. Sonra Configuration → Runtimes & models'ta runtime'ı aç.
OpenHands artık kurulamaz (ADR-0023 ile kaldırıldı); makinede kurulu kaldıysa worker'ı güncellemeden önce buradan kaldır.

## Claude Code / Codex'e abonelikle giriş
1. Runtimes sekmesi → "Log in".
2. Açılan pencerede bağlantı çıkar. Kendi telefonunda/bilgisayarında aç, aboneliğinle giriş yap.
3. Claude Code: giriş sonrası sayfadaki kodu pencereye yapıştır → "Send code".
   Codex: penceredeki tek kullanımlık kodu giriş sayfasına yaz; makine kendisi tamamlar.
4. "Logged in" görünce bitti.
Giriş anahtarı (token) sadece o makinede kalır; panel ve sunucu onu hiç görmez. Süresi dolarsa ("Expired") tekrar giriş yap.

## Yeniden başlatma, log, tanılama (Operations)
- Restart worker: "işleri bekle" seçiliyse yeni iş almaz, çalışanların bitmesini bekler, sonra servis yeniden başlatır.
- Fetch logs: son satırlar; makinede ve sunucuda iki kez maskelenir, veritabanına yazılmaz.
- Run diagnostics: Node sürümü, disk, sandbox, runtime'lar, servis durumu ve sorun listesi.

## Bir makinede kapatmak
Makinedeki config.json'a: "remoteOps": { "disabled": ["install", "login", "restart"] } — panel bu işlemleri o makinede yapamaz.

## Hata görürsen
- worker_update_required: önce worker'ı güncelle.
- worker_offline: makine bağlı değil.
- runtime_in_use: o runtime ile iş çalışıyor, bitince tekrar dene.
- integrity_mismatch: indirilen dosya sabit checksum'a uymadı; hiçbir şey kurulmadı. Körlemesine tekrar deneme.

## Giriş kendiliğinden toparlanır
- Aynı abonelik girişini kullanan işler ve sohbet asistanı artık sırayla başlar; makine uykudan uyanınca ikisi aynı anda giriş yenilemeye çalışıp birbirini düşürmez.
- "Another Claude Code process is refreshing it" hatası artık sadece o işi düşürür (kod: login_refresh_contention). Giriş sağlamdır; işi tekrar çalıştır. Runtime "Signed out" olmaz.
- "Expired" görünüyorsa "Check" gerçekten küçük bir deneme isteği atar: çalışırsa durum hemen düzelir. Worker bunu 10 dakikada bir ve makine uyanınca kendisi de yapar.
- Giriş gerçekten bittiyse işler hemen düşmez: 30 dakika "Claude Code needs a login on <makine> — waiting" diye bekler, sana bir bildirim gelir. "Log in again" yapınca bekleyen işler kendiliğinden başlar. 30 dakika içinde giriş yapılmazsa iş düşer.
