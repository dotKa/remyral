/**
 * p15-model-picker: elle model adı yazmak yerine listeden seçim — runtime'ın desteklediği modeller (bu makinede
 * mevcut / katalog), varsayılan seçenek, model profilleri ve listede olmayanlar için "Özel model adı…".
 */
export default {
  defaultOption: 'Varsayılan (runtime’ın kendi seçimi)',
  composerLabel: 'Model ya da model profili',
  chatModel: 'Model ya da model profili',
  fallbackModel: 'Yedek motorun modeli',
  stepModel: 'Model (bu adım için)',
  defaultWith: (p: { value: string }) => `Varsayılan: ${p.value}`,
  groups: {
    profiles: 'Model profilleri',
    here: 'Bu makinede mevcut',
    fleet: 'Makinelerde mevcut',
    catalog: 'Katalog',
  },
  search: 'Model ara…',
  open: 'Model listesini aç',
  noMatch: 'Eşleşen model yok. Listede olmayan bir model için “Özel model adı…” seç.',
  custom: 'Özel model adı…',
  customBadge: 'Özel',
  customLabel: 'Özel model adı',
  customHint:
    'Listede olmayan bir model kimliği. Runtime bu adı kabul etmeli; tanımıyorsa iş başlarken hata verir.',
  customPlaceholder: 'ör. claude-opus-5-5 ya da sağlayıcı/model',
  customApply: 'Kullan',
  customBack: 'Listeye dön',
  customIssues: {
    empty: 'Bir model adı yaz.',
    too_long: 'En çok 128 karakter olabilir.',
    invalid: 'Harf ya da rakamla başlamalı; yalnızca harf, rakam ve . _ : / @ + - içerebilir.',
  },
  alias: (p: { to: string }) => `takma ad → ${p.to}`,
  aliasMoving: 'takma ad · en yeni sürüme gider',
  profile: (p: { model: string }) => `profil → ${p.model}`,
  onMachines: (p: { names: string }) => `${p.names} makinesinde`,
  context: (p: { tokens: string }) => `${p.tokens} bağlam`,
  access: {
    subscription: 'abonelik',
    'api-key': 'API anahtarı',
  },
  loading: 'Modeller yükleniyor…',
  loadFailed: 'Makinelerin model listesi alınamadı; katalog ve özel model adı kullanılabilir.',
  updateNeeded: (p: { names: string }) =>
    `${p.names}: model listesi için makinenin güncellenmesi gerekiyor; o makinelerde katalog gösteriliyor.`,
  listFailed: (p: { name: string; error: string }) => `${p.name}: model listesi alınamadı (${p.error}).`,
  catalogVersion: (p: { version: string }) => `Katalog ${p.version}`,
  machineDefaults: 'Makine varsayılanları',
  machineDefault: (p: { name: string; value: string }) => `${p.name} → ${p.value}`,
  machineDefaultHint:
    'Makinenin kendi varsayılanı genel varsayılan modelin önüne geçer. Makineler → makine → Yapılandırma → Runtime ve modeller.',
  softDefaultHint:
    'Genel varsayılan model, kendi varsayılanı olmayan makinelerde kullanılır (makinelerin güncellenmesi gerekir).',
} as const;
