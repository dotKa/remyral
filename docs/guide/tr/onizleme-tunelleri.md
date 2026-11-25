# Önizleme tünelleri (Cloudflare Tunnel)

Bir iş web uygulaması (ya da mobil uygulama) geliştirirken çalışan dev server'a **önizleme linki** açılabilir. APK
için backend adresi **sabit** kalabilir: APK bu adresle derlenir, sen kurup her yerden test edersin.

## Kurulum (bir kez)

1. **Cloudflare token'ına yetki ekle** (Cloudflare → My Profile / Manage Account → API Tokens → Remyral'ın token'ı →
   Edit):
   - **Account → Cloudflare Tunnel → Edit** (zorunlu)
   - **Account → Access: Apps and Policies → Edit** (Access korumalı önizlemeler için)
   - **Account → Access: Service Tokens → Edit** (yalnızca "service token" korumalı önizlemeler — APK backend'i —
     için)
   - Önizleme zone'u için zaten olan **Zone → DNS → Edit** ve **Zone → Read**
2. **Settings → Integrations → Cloudflare → Test connection**: "Preview tunnels" satırı eksik yetkileri adıyla gösterir.
3. **Project → Deploy → Preview links**: zone'u seç (ör. `example.com`), istersen ön ek (`pv`), Access için izinli
   e-postalar, sınırlar. Kaydetmek authenticator kodu ister.
4. E-posta ile korumalı önizleme istiyorsan Cloudflare Zero Trust → Settings → Authentication → **One-time PIN**
   açık olmalı.
5. Önizleme açacak her makineye **cloudflared** kur: Machines → makine → Tools → cloudflared → Install
   (sürüm 2026.10.0, checksum'lı).

## Nasıl kullanılır

- **İş ekranı → Preview kartı:** port yaz (ör. 5173) → Open. Link, koruma, bitiş zamanı, bağlantı durumu görünür;
  +1 s / +4 s uzat, Close ile kapat.
- **Ajan kendisi açabilir:** Claude Code, Codex, Pi ve OpenCode işlerinde ajan dev server ayağa kalkınca
  `open_preview` aracını çağırır (proje ayarı "agents may open previews" açıkken). İstisna: kendi sandbox'ında
  çalışan Codex (runtime-sandbox) port açamadığı için bu aracı almaz. Link sohbete de yazılır (iş sohbetten açıldıysa).
- **Composer:** "Open a preview when the dev server is up" → port ver; port dinlemeye başlayınca önizleme kendiliğinden
  açılır.
- **APK backend'i:** "stable" seç ve bir isim ver (ör. `apk-api`). İlk kez ayırmak **onay** ister (Deploys sayfası).
  Adres 30 gün sabit kalır (yenilenebilir); iş bitince bağlantı durur ama adres kalır, aynı isimle açan sonraki iş
  aynı adrese bağlanır. "service-token" korumasında APK'nın göndermesi gereken `CF-Access-Client-Id` /
  `CF-Access-Client-Secret` başlıklarını iş alır; sen de iş ekranından **Reveal** ile görebilirsin (yönetici + taze
  kod).
- **APK dosyası:** workspace işlerinin `out/` klasörüne konan `.apk` / `.aab` / `.ipa` (en fazla 80 MiB, iş başına 2)
  Outputs'ta yalnızca **indirilebilir** olarak çıkar.

## Güvenlik özeti

- Varsayılan **açık link** (senin kararın): linki bilen açar. Ekranda uyarı var; adres tahmin edilemez, süre dolunca
  ve iş bitince kapanır. İstersen Access (e-posta) ya da service token koruması seç.
- Cloudflare hesap token'ı master'da kalır. Makineye yalnızca **o tek tünelin bağlantı anahtarı** gider; dosyada
  saklanır (iş erişemez), kapatınca tünel silinir ve anahtar geçersiz olur.
- Yalnızca işin kendi açtığı port açılır; SSH, RDP, veritabanı gibi servis portları her durumda reddedilir.
- Proje başına en fazla 5, iş başına 3 açık önizleme (ayarlanabilir). Her açma/kapama Deploys sayfasında ve denetim
  kaydında.

## Henüz doğrulanmadı

Gerçek Cloudflare hesabında denenmedi: yetkileri ekleyip ilk önizlemeyi açınca canlı test tamamlanır. Container
profilindeki işlerde port, işçinin yalnızca kendi loopback adresine (127.0.0.1) aktarılır; container'a ağ verilmez
(gerçek makinede henüz denenmedi). Linux/Windows makinelerde port sahipliği kontrolü gerçek makinede
denenmedi.
