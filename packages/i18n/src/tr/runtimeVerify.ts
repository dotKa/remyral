/**
 * p17-runtime-verify: runtime özelliklerinin panelden kanıtlanması — Makine → Runtime’lar satırındaki “Doğrula”,
 * canlı ilerleme, özellik başına sonuç ve geçmiş; Araçlar ve sürümler / Runtime politikası’nda platform başına
 * kanıtlanmış sürümler ve “Doğrulanmamışa izin ver”e bağlı runtime sayısı; sürüm kataloğunda “Doğrulandı olarak
 * işaretle”. `{param}` yer tutucuları `fill` ile doldurulur.
 */
export default {
  title: 'Kanıt',
  state: {
    verified: 'Kanıtlandı',
    partial: 'Kısmen kanıtlandı',
    unverified: 'Kanıtlanmadı',
    not_applicable: 'Kanıt bilgisi yok',
  },
  provenBy: 'Kanıtlandı ({machine}, {when})',
  partialBy: 'Kısmen kanıtlandı ({machine}, {when}): {caps} geçmedi',
  notProven: 'Kanıtlanmadı: {reason}',
  noRun: 'bu sürüm ve platform için henüz doğrulama çalışmadı',
  failedCaps: '{caps} geçmedi',
  fleetWide:
    'Kanıt aynı runtime sürümü ve platformdaki her makine için geçerli; başka bir sürüm ya da adaptör yeniden doğrulama ister.',
  olderWorker:
    'Bu makinenin sürümü runtime doğrulamasını desteklemiyor; önce makineyi güncelle (Ayarlar → Makine sürümleri).',
  verify: 'Doğrula',
  verifyAgain: 'Yeniden doğrula',
  verifyWhy: '{machine}: {runtime} özelliklerini doğrula',
  confirmTitle: '{runtime} {version} bu makinede doğrulansın mı?',
  confirmBody:
    'Gerçek runtime kısa bir senaryo setiyle çalışır: dosya yazan küçük bir görev (onay dahil), aynı oturumun sürdürülmesi ve iptal edilen uzun bir komut. Makinenin işler için yapılandırılmış oturumu ya da anahtarı kullanılır; çalışma, işler gibi sandbox içinde ve sonra silinen bir depoda olur.',
  confirmCost:
    'Beklenen: yaklaşık {tokens} token ve {minutes} dakika (sınır: {maxTokens} token, {maxMinutes} dakika).',
  authSubscription: 'Abonelik oturumu kullanılır: token aboneliğin kotasından düşer.',
  authKey: 'API anahtarı kullanılır: token sağlayıcı hesabına faturalanır.',
  authNone:
    'Bu runtime için işlerin oturumu yapılandırılmamış; doğrulama büyük olasılıkla oturum hatasıyla biter.',
  start: 'Doğrulamayı başlat',
  cancel: 'Vazgeç',
  stop: 'Doğrulamayı durdur',
  running: 'Doğrulanıyor…',
  steps: {
    task: 'görev oturumu',
    resume: 'sürdürme',
    long: 'uzun komut ve iptal',
  },
  capability: {
    streaming: 'Akış',
    interactive_prompt: 'Çalışırken mesaj',
    approval: 'Onay',
    cancel: 'İptal',
    safe_cancel: 'Güvenli iptal',
    resume: 'Sürdürme',
    cost_reporting: 'Maliyet bildirimi',
    artifacts: 'Çıktılar',
  },
  outcome: {
    passed: 'geçti',
    failed: 'geçmedi',
    skipped: 'atlandı',
  },
  effective: {
    supported: 'destekleniyor',
    degraded: 'kısıtlı',
    unverified: 'kanıtlanmadı',
    unsupported: 'desteklenmiyor',
    unknown: 'bilinmiyor',
  },
  stoppedBy: {
    time_budget: 'süre sınırı doldu',
    token_budget: 'token sınırı doldu',
    cancelled: 'durduruldu',
    error: 'hata',
  },
  usage: '{tokens} token · {seconds} sn',
  refused: 'Makine doğrulamayı başlatmadı: {reason}',
  evidenceRefused: 'Makinenin gönderdiği kanıt reddedildi (imza doğrulanamadı); sonuç sayılmadı.',
  results: 'Özellik başına sonuç',
  history: 'Geçmiş',
  historyLine: '{when} · {version} · {passed} geçti, {failed} geçmedi',
  historyExpired: 'artık geçerli değil (başka sürüm ya da adaptör)',
  platforms: {
    title: 'Kanıtlanmış runtime sürümleri',
    sub: 'Platform başına hangi runtime sürümünün panelden kanıtlandığı. Başka bir runtime sürümü ya da adaptör yeniden doğrulama ister.',
    empty: 'Henüz kanıt yok. Makine → Runtime’lar → Doğrula ile başlat.',
    verified: '{caps} kanıtlandı',
    failed: '{caps} geçmedi',
    expired: 'adaptör değişti; yeniden doğrula',
    by: '{machine}, {when}',
  },
  policy: {
    title: 'Kanıtlanmamış özelliklere bağlılık',
    none: 'Hiçbir runtime iş özelliklerini kanıtsız kullanmıyor; politikalardaki “Doğrulanmamışa izin ver” kapatılabilir.',
    count:
      'Toplam {total} runtime’ın {n} tanesi iş özelliklerini (akış, iptal, onay) hala kanıtsız kullanıyor; yalnızca politikadaki “Doğrulanmamışa izin ver” sayesinde çalışıyor.',
    path: 'Kapatma yolu: her biri için Makine → Runtime’lar → Doğrula; hepsi kanıtlanınca politikadaki “Doğrulanmamışa izin ver” işaretini kaldır.',
    item: '{machine}: {runtime} {version} ({platform}) — {caps}',
    updateFirst: 'önce makineyi güncelle',
    open: 'Makineyi aç',
  },
  catalog: {
    proven: 'Kanıtlandı ({machine}, {when})',
    failed: 'Doğrulama geçmedi ({when})',
    partial: 'Kısmen kanıtlandı ({when})',
    marked: 'Bu kurulumda doğrulandı ({when})',
    mark: 'Doğrulandı olarak işaretle',
    markWhy: '{runtime} {version} sürümünü bu kurulumda doğrulandı olarak işaretle',
    markQuestion:
      '{runtime} {version} kanarya makinedeki doğrulamayı geçti. Bu kurulumda doğrulandı olarak işaretlensin mi? İmzalı katalog değişmez: sürümü herkes için doğrulanmış yapmak satıcının katalog işidir.',
    vendorNote:
      'İşaret yalnızca bu kurulum içindir; özelliklerin etkisi kanıttan gelir. Sürümün herkes için doğrulanmış olması satıcının haftalık katalog işinde (promote ve imza) olur.',
    verifyFirst: 'Önce kanarya makinede Makine → Runtime’lar → Doğrula',
  },
};
