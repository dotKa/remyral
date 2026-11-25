# Remyral: Runtime politikası (Settings → Runtimes)

## Neden?
Claude Code / Codex bir makinede henüz hiç canlı çalışmadıysa yetenekleri (streaming, cancel, approval)
"unverified" görünür. Varsayılan olarak worker bu işleri reddeder; Machines'te "no ready runtime" yazar.
Çözüm: runtime politikasında o runtime için **Allow unverified** işaretlemek.

## İlk çalıştırma için tıklanacaklar
1. Panel → Settings → **Runtimes**.
2. "default" yoksa: **Create default policy from current pins** (pin'ler worker'ın kendi pin'leridir; elle yazılmaz).
3. Açılan editörde **Claude Code** satırında **Allow unverified** kutusunu işaretle.
4. "Change note" yaz (ör. "ilk canlı çalıştırma"), "To every worker of the policy now" seçili kalsın.
5. **Save policy** → authenticator kodu.
6. Machines'te makine artık "no ready runtime" değil, Claude Code "degraded (allowUnverified)" görünür. İş gönder.

## Risk
"Unverified": bu sürüm bu işletim sisteminde henüz kanıtlanmadı. Canlı bir çalıştırma kanıtlayana kadar
onaylar (approval) ve iptal (cancel) garanti edilmeyebilir. İlk işi izle; istersen sonra kutuyu kaldır.

## Diğerleri
- Assign/canary: Machines → makine → Sandbox & policy → Runtime policy ("Edit policies" bağlantısı bu sayfaya gelir).
- Allow unpinned: kurulu sürüm pin'den farklıysa yine de çalıştır (yetenekler unverified kalır).
- Model profilleri: Settings → Models'teki katalogdan seçilir.
- Geçmiş, promote ve rollback aynı sayfada "Version history" altında.
- Pin'den yeni bir sürüm (doğrulanmamış): Ayarlar → Güvenlik → Filo ("Doğrulanmamış runtime güncellemeleri",
  varsayılan açık) — kurulum Makineler → Araçlar ve sürümler'den; ayrıntı: makine-yonetimi.md "Runtime
  güncellemeleri". Böyle bir sürüm runtime politikasındaki "Allow unpinned" kutusu olmadan da iş alır (yalnızca tam
  o sürüm, politika açıkken).
