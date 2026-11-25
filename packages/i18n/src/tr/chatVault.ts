/**
 * p15-chat-vault: Sohbet'e yapıştırılan gizli değerler ve kasa — yazma alanındaki uyarı ve "Kasaya kaydet" paneli,
 * mesajlardaki kimlik bilgisi rozetleri ve asistanın "kasaya kaydet" / HTTP isteği kartları.
 */
export default {
  warning: {
    title: 'Gizli bir değer yapıştırdın',
    one: (p: { what: string }) =>
      `${p.what} gibi görünüyor. Gizli değerler sohbete gönderilmez: yerine bir rozet konur, değer yalnızca bu sekmede kalır.`,
    many: (p: { n: number }) =>
      `${String(p.n)} gizli değer gibi görünen şey yapıştırdın. Hiçbiri sohbete gönderilmez: yerlerine rozet konur.`,
    offer: 'İstersen kasaya kaydet; sonra “@AD ile şu endpoint’e istek at” diyerek kullanabilirsin.',
    save: 'Kasaya kaydet',
    remove: 'Kaldır',
    subscription:
      'Bu bir Claude abonelik belirteci: kaydedilmez (yerel giriş kullanın), yalnızca mesajdan çıkarıldı.',
    adminOnly: 'Kasaya yalnızca yöneticiler kaydedebilir. Değer sohbete gönderilmeyecek.',
  },
  providers: {
    openai: 'OpenAI API anahtarı',
    anthropic: 'Anthropic API anahtarı',
    openrouter: 'OpenRouter API anahtarı',
    github: 'GitHub belirteci',
    gitlab: 'GitLab belirteci',
    google: 'Google API anahtarı',
    slack: 'Slack belirteci',
    stripe: 'Stripe anahtarı',
    huggingface: 'Hugging Face belirteci',
    npm: 'npm belirteci',
    aws: 'AWS erişim anahtarı',
    jwt: 'Bir belirteç (JWT)',
    'private-key': 'Özel anahtar',
    generic: 'Bir API anahtarı',
  },
  save: {
    title: 'Kasaya kaydet',
    intro:
      'Değer bu tarayıcıda seçtiğin makinelerin kasa anahtarlarına mühürlenir; ana sunucu ve asistan değeri hiç görmez.',
    name: 'Ad (değişken adı)',
    nameHint: 'Sohbette @AD olarak, bir kasa rozetiyle görünür.',
    nameRule: 'Harf, rakam ve _ (harfle başlar, en fazla 64).',
    nameTaken: 'Bu adda bir kimlik bilgisi var.',
    kind: 'Tür',
    kinds: {
      'http-auth': 'HTTP kimlik doğrulama (istekler ve workflow HTTP adımları)',
      'api-token': 'API anahtarı (ajanların runtime ortam değişkeni)',
      generic: 'Genel gizli bilgi',
    },
    hosts: 'İzinli hostlar',
    hostsHint: 'Değer yalnızca bu hostlara gönderilir (satır ya da virgülle ayır).',
    hostsRequired: 'HTTP kimlik bilgisi için en az bir host gerekli.',
    hostsBad: (p: { host: string }) => `Geçersiz host: ${p.host}`,
    machines: 'Makineler',
    machinesHint: 'Değer yalnızca bu makinelere mühürlenir; istekler bunlardan birinde çalışır.',
    pickMachine: 'En az bir makine seç.',
    noMachines: 'Bu türü tutabilecek, kasa anahtarı olan makine yok.',
    value: 'Değer',
    valueHint:
      'Bu sekmede yapıştırılan değer artık yok (sayfa yenilendi). Yeniden yapıştır; yalnızca burada mühürlenir.',
    submit: 'Mühürle ve kaydet',
    cancel: 'Vazgeç',
    stepUp: 'Kasaya kaydetmek için doğrulama kodu',
    saved: (p: { name: string }) => `${p.name} kasaya kaydedildi.`,
    unsupported: 'Bu tarayıcı X25519 desteklemiyor; değer mühürlenemez.',
  },
  chip: {
    credential: 'Kasadaki kimlik bilgisi',
    pasted: 'Kaydedilmemiş gizli değer',
    removed: 'Çıkarılan gizli değer',
    unknown: 'kasada bulunamadı ya da görünmüyor',
    machines: (p: { n: number }) => `${String(p.n)} makinede`,
    open: 'Kimlik bilgisini aç',
  },
  card: {
    saveKind: 'Kasaya kaydet',
    httpKind: 'HTTP isteği',
    saveNote: 'Bu kartı tarayıcın tamamlar: değer burada mühürlenir, ana sunucuya gitmez.',
    savedAs: (p: { name: string }) => `Kaydedildi: ${p.name}`,
    request: 'İstek',
    credential: 'Kimlik bilgisi',
    placement: 'Yerleşim',
    httpNote:
      'Bir makinede function işi olarak çalışır; değer yalnızca bağlı hosta eklenir ve yanıtta gizlenir.',
  },
} as const;
