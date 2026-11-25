# Remyral: Worker yeniden başlasa da iş kaldığı yerden devam eder (oturum sürekliliği)

## Ne değişti?
Önceden çalışan bir işin makinesindeki worker **yeniden başlarsa** (çökme, güncelleme, servis yeniden başlatma,
bilgisayarın yeniden açılması) iş kaybolurdu: yeni worker süreci o denemeyi bırakırdı, master işi ya **baştan**
yeniden denerdi (yalnızca güvenli olduğu kanıtlanırsa) ya da "**insan incelemesi gerekiyor**" diye başarısız ederdi.
O ana kadar yapılan iş diskte sahipsiz kalırdı; yarıda kalan bir araç çağrısı (ör. `git push`) ya kaybolur ya da
körlemesine tekrar çalışırdı.

Artık (yeni master + yeni worker sürümüyle):

1. **Ara kayıtlar (checkpoint)** — iş çalışırken worker birkaç dakikada bir (varsayılan **2 dk**, sadece bir şey
   değiştiyse) çalışma alanının ucuz bir kaydını alır: depo işlerinde gizli bir git ref'ine
   (`refs/remana/checkpoints/<deneme>/<n>`) **WIP commit** — iş dalına **değil**, **asla push edilmez**; çalışma alanı
   (workspace) işlerinde dosya listesi + kopya. Ayrıca ajanın oturum kimliği ve son araç çağrıları diske yazılır
   (fsync). Master'a sadece özet bilgi gider (kaçıncı kayıt, kaç dosya, son araç).
2. **Yeniden başlayınca kurtarma** — worker yeniden açılınca önce kontrol eder: çalışma alanı yerinde mi, eski
   süreçten geriye çalışan bir şey kaldı mı (varsa durdurur; emin olamazsa **devam ettirmez**), güvenilen git
   bilgileri değişmiş mi, son checkpoint sağlam mı. Hepsi tamamsa ilk "heartbeat"inde "bu işi devam ettirebilirim"
   der.
3. **Master baştan başlatmak yerine devam ettirir** — iş kısa süre **PAUSED** olur, sonra **aynı deneme, aynı
   makinede**, yeni bir kira (epoch) ile devam eder. Zaman çizelgesinde: "**Worker restarted — resuming from
   checkpoint 7 (2 min ago)**". Aynı deneme hiçbir zaman iki kez aynı anda çalışmaz.
4. **Yarıda kalan araç çağrıları** — her çağrı sınıflanır: sadece okuma, çalışma alanında düzenleme, **dış etki**
   (`git push`, deploy/publish, paket kurulumu, ağa POST, ops araçları, onaylar). Çökme anında yarıda kalan **dış
   etkili** bir çağrı **sessizce tekrar çalıştırılmaz**: ajana "**sonucu bilinmiyor — tekrar denemeden önce
   gerçekleşmiş mi kontrol et**" denir. Onay gerektiren bir işlem yeniden onay ister.
5. **Ajan neyi bilerek devam eder** — yeni oturumun ilk mesajında: görev, önceki ilerlemenin özeti, son araç
   çağrıları, başlangıçtan beri ve son checkpoint'ten beri değişen dosyalar (diff özeti), ajanın son TODO listesi.
6. **İş sayfası** — yeni "**Session continuity**" kartı: alınan checkpoint'ler (zaman, dosya sayısı, son araç) ve
   yeniden başlama geçmişi ("sonucu bilinmeyen çağrılar" dahil). Duraklatma panelinde: "**The worker restarted —
   resuming the same attempt on build-01**".

## Sınırlar
- Bir deneme en fazla **2** kez (ayarlanabilir) yeniden başlamadan devam ettirilir; çöküp duran bir döngüde eski
  davranışa (güvenliyse baştan deneme, değilse insan incelemesi) dönülür.
- Claude Code ve Codex'in **kendi oturumunu** kaldığı yerden sürdürmesi (native resume) henüz canlı doğrulanmadı;
  doğrulanana kadar yeni bir oturum yukarıdaki özetle devam eder. Doğrulama testleri hazır (isteğe bağlı, canlı).
- Kaydedilen git nesneleri sadece o makinedeki depo aynasında durur; deneme bitince silinir.

## Kurulum ve deneme
1. Önce master, sonra worker'lar güncellenir (worker özelliği `session-continuity-v1`).
2. Denemek için (örnek: bir Windows makinesi):
   - Uzun süren bir Claude Code işi başlat (ör. birkaç dosyayı adım adım düzenleyen bir görev). İş sayfasında
     "Session continuity" kartında en az 1 checkpoint görünene kadar bekle (~2 dk).
   - **Servisi yeniden başlat** (Makineler → makine → Restart worker service, ya da `Restart-Service remyral-worker`).
     Beklenen: iş kısa süre PAUSED → aynı makinede devam → başarıyla biter; zaman çizelgesinde "Worker restarted —
     resuming from checkpoint N"; tek deneme.
   - **Sert çökme**: başka bir işte Görev Yöneticisi'nden worker'ın `node.exe` sürecini sonlandır (servis kendini
     yeniden başlatır). Beklenen aynı; ayrıca eski Claude süreci kalmışsa worker onu durdurur (log: "stopped processes
     the crashed run left behind").
   - Bir işte ajan `git push` gibi dış etkili bir komut çalıştırırken çökert: devam eden ajanın ilk mesajında "OUTCOME
     IS UNKNOWN" uyarısı ve iş sayfasında "Unknown outcome" satırı görünmeli.
3. Kapatmak istersen: master ortamında `JOB_CHECKPOINT_INTERVAL_SEC=0`.
