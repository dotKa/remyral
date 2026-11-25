/**
 * Diyalog navigation rail and phone bar (i18n Phase 1). Glossary: İşler, Makineler, Çıktılar, Kullanım,
 * Projeler, Ayarlar, Senden bekleyenler; "Workflow’lar" keeps the English term (ADR-0053 glossary).
 */
export default {
  /** Accessible name of the rail / bottom bar (the product's name for this UI, not translated). */
  landmark: 'Diyalog',
  home: 'Ana sayfa',
  homeLink: 'Remyral, ana sayfa',
  chat: 'Sohbet',
  needs: 'Senden bekleyenler',
  /** p18-plans-ui: every plan of the person (`/plans`). */
  plans: 'Planlar',
  jobs: 'İşler',
  workflows: 'Workflow’lar',
  automations: 'Otomasyonlar',
  machines: 'Makineler',
  outputs: 'Çıktılar',
  usage: 'Kullanım',
  projects: 'Projeler',
  settings: 'Ayarlar',
  all: 'Tümü',
  /** Spoken units of the rail counters ("Sohbet, 3 okunmamış"). */
  unit: {
    unread: 'okunmamış',
    waiting: 'bekliyor',
    pairing: 'eşleşme bekliyor',
  },
  /** "Sohbet, 3 okunmamış" — a rail item's accessible name with its counter. */
  withCount: (p: { label: string; n: number; unit: string }) => `${p.label}, ${String(p.n)} ${p.unit}`.trim(),
  search: (p: { keys: string }) => `Ara (${p.keys})`,
  searchTitle: (p: { keys: string }) => `Sayfalara, sohbetlere, işlere git; yapay zeka ile ara (${p.keys})`,
  /**
   * p14-i18n-shell: the classic sections the "Tüm ekranlar" dialog lists that have no rail item (the rest use the keys
   * above). "Yetenekler" follows the glossary (skill → yetenek).
   */
  sections: {
    uptime: 'Uptime',
    automations: 'Otomasyonlar',
    approvals: 'Onaylar',
    skills: 'Yetenekler',
    context: 'Bağlam',
    audit: 'Denetim kaydı',
  },
  shortcuts: 'Klavye kısayolları',
  shortcutsTitle: 'Klavye kısayolları (?)',
};
