# Remyral: Credential ve modeller (panelden)

## Ne değişti?
API anahtarları ve model seçimi artık panelden yönetiliyor (OpenHands ADR-0023 ile kaldırıldı). Makineye girmen gerekmiyor.

## API anahtarı eklemek
1. Panel → Settings → Credentials → Add credential.
2. Kısa bir id (ör. openrouter-ekip), tür (anthropic, openai, openrouter, gemini, github-token…) ve hangi makinelere gideceğini seç.
3. Anahtarı yapıştır, kaydet (authenticator kodu ister).
Anahtar senin tarayıcında her makine için ayrı şifrelenir. Sunucu anahtarı hiç görmez, sadece şifreli halini taşır.
Makine anahtarı alınca durum "applied" olur.

## Önemli kurallar
- Anahtar bir daha gösterilmez. Değiştirmek için "Replace value" ile yenisini gir.
- Yeni makine eklemek için de değeri tekrar girersin (sunucu şifreyi çözemediği için).
- Claude aboneliği (sk-ant-oat…) buraya girilmez. Abonelik için makinede yerel giriş kullanılır.
- "needs re-seal" görürsen o makinenin anahtarı değişmiş: değeri tekrar gir.
- Revoke = her yerden silinir.

## Modeller
Settings → Models: model profilleri (hangi runtime, sağlayıcı, model ve anahtarı).
Proje ve runtime için varsayılan model seçebilirsin; iş açarken o model önceden seçili gelir.

## Modeli listeden seçmek
Model adı artık elle yazılmıyor. Model alanları açılır bir liste:
- **Varsayılan (runtime'ın kendi seçimi)** en üstte.
- **Model profilleri** (varsa), sonra **Bu makinede mevcut** (makinenin kendi listesi) / **Makinelerde mevcut**, sonra
  **Katalog** (sürümle gelen bilinen modeller: sonnet, opus, haiku, fable, gpt-5.5 …).
- Listede yoksa **Özel model adı…** ile yazabilirsin; "Özel" etiketiyle gösterilir.
- Yazarak arayabilirsin.

Makine listeleri makinenin runtime'ına sorulur (opencode models, pi --list-models, codex debug models; Claude Code
için bilinen takma adlar). Eski worker sürümündeki makinelerde "güncellenmesi gerekiyor" yazar ve katalog gösterilir.

**Varsayılan model:** Ayarlar → Modeller → Varsayılanlar'da her runtime için bir model ya da profil seç (tüm projeler
ya da tek proje). Makineye özel varsayılan: Makineler → makine → Yapılandırma → Runtime ve modeller. Sıra: işin
kendi seçimi → proje varsayılanı → makinenin varsayılanı → tüm projeler varsayılan modeli → runtime'ın kendi modeli.
(Tüm projeler için seçilen *profil* eskisi gibi makineninkinden önce gelir.)

Sohbet asistanına "hangi modeller var?" diye sorabilirsin; iş taslaklarında listedeki model adlarını kullanır.

## Makineye atamak
Machines → makine → Configuration:
- Credentials sekmesi: her runtime için "Vault credential" seç.
- Runtimes & models sekmesi: model profilini seç. Makinenin gerçekten ne uyguladığı da burada görünür.

## İş bekliyorsa
- credential_missing: anahtar o makineye henüz ulaşmadı ya da o makineyle paylaşılmadı.
- model_profile_unavailable: seçilen model kapalı ya da o runtime için tanımlı değil.
