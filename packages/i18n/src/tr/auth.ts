/**
 * Diyalog sign-in steps, step-up confirmation, Coolify sign-on and "Sayfa bulunamadı" (i18n Phase 2,
 * p14-i18n-shell). Moved verbatim from `apps/web/src/diyalog/auth/*`, `DyStepUpDialog.tsx`, `screens/SsoContinue.tsx`
 * and `screens/NotFound.tsx`. Master error messages inside these frames stay as the master phrased them (Phase 3).
 */
export default {
  frame: {
    product: 'Remyral',
    tagline: 'Kontrol paneli',
    /** The browser tab: "Konsola giriş yap · Remyral". */
    documentTitle: (p: { title: string }) => `${p.title} · Remyral`,
  },
  checking: 'Oturum denetleniyor…',
  codeRequired: 'Authenticator uygulamandaki 6 haneli kodu gir.',
  /** The AuthProvider's (English) session notices in this language. */
  notice: {
    pendingLoginEnded: 'Giriş denemen sona erdi. Yeniden giriş yap.',
    sessionEnded: 'Oturumun sona erdi. Yeniden giriş yap.',
    stepUpSessionEnded: 'Çok fazla hatalı kod girildi; güvenlik için oturum kapatıldı. Yeniden giriş yap.',
    signedOut: 'Çıkış yaptın.',
    signedOutEverywhere: (p: { n: string }) => `Her yerden çıkış yapıldı (${p.n} oturum kapatıldı).`,
  },
  login: {
    step: 'Giriş',
    title: 'Konsola giriş yap',
    description: 'Operatör hesabını kullan. Sonraki adımda authenticator uygulamanla onaylarsın.',
    usernameRequired: 'Kullanıcı adını gir.',
    passwordRequired: 'Parolanı gir.',
    username: 'Kullanıcı adı',
    password: 'Parola',
    remember: 'Beni hatırla',
    rememberHint: (p: { days: number; idleDays: number }) =>
      `Bu tarayıcıda en çok ${String(p.days)} gün açık kalırsın (${String(p.idleDays)} gün hiç kullanılmazsa kapanır).`,
    busy: 'Giriş yapılıyor…',
    submit: 'Devam et',
  },
  secondFactor: {
    trustDevice: (p: { days: number }) => `Bu cihaza ${String(p.days)} gün güven`,
    trustDeviceHint: 'Bu tarayıcıda bu adım atlanır. Yetkili işlemler yine authenticator kodu ister.',
    restart: 'Baştan başla',
    step: 'Adım 2 / 2',
    verifying: 'Doğrulanıyor…',
  },
  totp: {
    title: 'Authenticator kodunu gir',
    description: 'Authenticator uygulamanı aç ve Remyral için gösterilen 6 haneli kodu gir.',
    useRecovery: 'Kurtarma kodu kullan',
    code: '6 haneli kod',
    submit: 'Doğrula',
  },
  recoveryLogin: {
    title: 'Kurtarma kodu kullan',
    description:
      'Authenticator’ı kurarken sakladığın tek kullanımlık kurtarma kodlarından birini gir. Her kod bir kez çalışır.',
    useTotp: 'Authenticator kodu kullan',
    required: 'Kurtarma kodlarından birini gir.',
    code: 'Kurtarma kodu',
    hint: 'Yetkili işlemler yine authenticator kodu ister.',
    submit: 'Kurtarma koduyla giriş yap',
  },
  enroll: {
    step: 'İki adımlı doğrulamayı kur',
    title: 'Authenticator uygulamanı ekle',
    description: 'İki adımlı doğrulama zorunlu. Bu sayfa girişinle birlikte 5 dakika sonra sona erer.',
    cancel: 'Vazgeç ve baştan başla',
    retry: 'Yeniden dene',
    preparing: 'Kurulum anahtarın hazırlanıyor…',
    scan: 'QR kodunu tara',
    noQr: 'QR kodu gösterilemiyor. Aşağıdaki kurulum anahtarını kullan.',
    qrAlt: 'Remyral’ı authenticator uygulamana eklemek için QR kodu',
    appsBefore:
      'RFC 6238 uyumlu herhangi bir authenticator uygulaması olur (Aegis, 2FAS, 1Password, Bitwarden, Google ya da Microsoft Authenticator). Kayıt',
    appsAfter: ' adıyla görünür.',
    onThisPhone: 'Bu telefondaysan:',
    openInApp: 'Authenticator uygulamasında aç',
    cantScan: 'Tarayamıyor musun? Kurulum anahtarını gir',
    keyDetails: 'Kurulum anahtarı (zamana dayalı, SHA-1, 6 hane, 30 saniye)',
    key: 'Kurulum anahtarı',
    copyKey: 'Anahtarı kopyala',
    copyLink: 'otpauth bağlantısını kopyala',
    confirm: 'Bir kodla onayla',
    confirmCode: 'Uygulamadaki 6 haneli kod',
    confirming: 'Onaylanıyor…',
    confirmSubmit: 'Onayla ve devam et',
  },
  recoveryCodes: {
    step: 'İki adımlı doğrulama açık',
    title: 'Kurtarma kodlarını sakla',
    description:
      'Telefonunu kaybedersen her kod, authenticator kodu yerine bir kez giriş yapmanı sağlar. Yalnızca şimdi gösterilirler.',
    warning:
      'Bu kodları bir parola yöneticisinde ya da kağıtta güvenli bir yerde sakla; authenticator uygulamanın olduğu telefonda değil. Bir daha gösterilmeyecekler.',
    list: 'Kurtarma kodları',
    copyAll: 'Tümünü kopyala',
    download: '.txt indir',
    stored: 'Bu kurtarma kodlarını güvenli bir yerde sakladım.',
    continue: 'Konsola devam et',
  },
  password: {
    step: 'Geçici parolanı değiştir',
    title: 'Kendi parolanı belirle',
    /** After the bold user name (leading space included). */
    description:
      ' hesabı, başka birinin bildiği geçici bir parolayla açıldı. Devam etmek için kendi parolanı belirle. Bu sayfa girişinle birlikte 5 dakika sonra sona erer.',
    hint: (p: { min: number }) =>
      `En az ${String(p.min)} karakter; yaygın bir parola olmasın ve kullanıcı adını içermesin. Parola yöneticisinden uzun bir parola en iyisi.`,
    tooShort: (p: { min: number }) => `En az ${String(p.min)} karakter kullan.`,
    mismatch: 'Parolalar eşleşmiyor.',
    newPassword: 'Yeni parola',
    confirm: 'Yeni parolayı tekrarla',
    saving: 'Kaydediliyor…',
    submit: 'Parolayı belirle ve devam et',
  },
  stepUp: {
    title: 'Sen olduğunu onayla',
    defaultReason: 'Bu işlem taze bir authenticator kodu ister.',
    validFor: 'Onay 10 dakika geçerli.',
    code: '6 haneli kod',
    cancel: 'Vazgeç',
    confirm: 'Onayla',
  },
  sso: {
    title: 'Coolify’de oturum aç',
    purpose: 'Konsoldan Coolify’ye tek oturum açma.',
    panel: 'Coolify',
    stepUpReason: 'Coolify seni oturum açtırmak istiyor. Authenticator uygulamandaki güncel kodu gir.',
    role: 'Coolify’yi açmak sahip ya da yönetici rolü ister.',
    invalid: 'Bu giriş bağlantısı geçersiz ya da süresi dolmuş. Coolify’yi konsoldan yeniden aç.',
    /** "Coolify’ye <b>ada</b> olarak devam et. …" — around the bold user name. */
    gateBefore: 'Coolify’ye',
    gateAfter: ' olarak devam et. Coolify bu sekmede açılır.',
    gateButton: 'Coolify’ye devam et',
    oidcBefore: 'Coolify seni',
    oidcAfter:
      ' olarak oturum açtırmak istiyor. Coolify’de oturum açmak son 10 dakikadan bir authenticator kodu ister.',
    confirm: 'Onayla ve devam et',
    continuing: 'Devam ediliyor…',
  },
  notFound: {
    title: 'Sayfa bulunamadı',
    purpose: 'Bu adreste bir ekran yok. Bağlantı eski ya da yanlış yazılmış olabilir.',
    panel: 'Buradan devam et',
    requested: 'İstenen adres:',
    allScreens: 'Tüm ekranlar',
  },
};
