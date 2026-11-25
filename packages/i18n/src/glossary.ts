/**
 * The terminology glossary as data (ADR-0053, docs/design/i18n-glossary.md — keep both in step). `pnpm check:i18n`
 * fails when Turkish catalog copy uses a `avoid` variant. By design, technical terms stay
 * English inside Turkish copy and take Turkish suffixes after an apostrophe ("runtime’lar", "deploy’u").
 * Style rule: no circumflex in Turkish copy — "yapay zeka", "hala", "kağıt", "resmi" (`pnpm check:i18n`
 * fails on â / î / û in the TR catalogs).
 */
export interface GlossaryEntry {
  readonly concept: string;
  /** The Turkish UI word(s); equal to `en` for a term kept in English. */
  readonly tr: string;
  readonly en: string;
  /** Kept in English inside Turkish copy (a technical term or product name). */
  readonly keepEnglish: boolean;
  /** Turkish variants that must not appear in Turkish catalog copy (lower-case, matched as whole words). */
  readonly avoid?: readonly string[];
  readonly note?: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  // Kept in English (decision 3) — the tools' own vocabulary.
  { concept: 'runtime', tr: 'runtime', en: 'runtime', keepEnglish: true, avoid: ['çalışma ortamı'] },
  {
    concept: 'workflow',
    tr: 'workflow',
    en: 'workflow',
    keepEnglish: true,
    avoid: ['iş akışı', 'iş akışları'],
  },
  {
    concept: 'deploy',
    tr: 'deploy',
    en: 'deploy',
    keepEnglish: true,
    avoid: ['dağıtım', 'dağıtımlar'],
    note: '"yayınla" only for static-site / Pages publishing (a separate feature), never for Coolify deploys',
  },
  { concept: 'sandbox', tr: 'sandbox', en: 'sandbox', keepEnglish: true, avoid: ['korumalı alan'] },
  { concept: 'token', tr: 'token', en: 'token', keepEnglish: true, avoid: ['jeton'] },
  { concept: 'commit', tr: 'commit', en: 'commit', keepEnglish: true, avoid: ['işleme'] },
  {
    concept: 'checkpoint',
    tr: 'checkpoint',
    en: 'checkpoint',
    keepEnglish: true,
    avoid: ['kontrol noktası'],
  },
  { concept: 'branch', tr: 'branch', en: 'branch', keepEnglish: true, avoid: ['dal', 'dalı', 'dallar'] },
  { concept: 'pull request', tr: 'pull request (PR)', en: 'pull request', keepEnglish: true },
  {
    concept: 'model / slot / limit',
    tr: 'model / slot / limit',
    en: 'model / slot / limit',
    keepEnglish: true,
  },
  {
    concept: 'product names',
    tr: 'Claude Code, Codex, Pi, OpenCode, Coolify, Remyral, Diyalog',
    en: 'Claude Code, Codex, Pi, OpenCode, Coolify, Remyral, Diyalog',
    keepEnglish: true,
    // p17-remyral-brand: the product is "Remyral" alone (formerly Remana / Remana Agent Cluster).
    avoid: ['remana', 'remyral agent cluster'],
    note: 'Turkish suffixes after Remyral: Remyral’ın, Remyral’a, Remyral’da, Remyral’dan, Remyral’ı, Remyral’la',
  },
  // Translated: everyday Turkish words the team already uses.
  { concept: 'job', tr: 'iş / İşler', en: 'job / Jobs', keepEnglish: false },
  {
    concept: 'worker / machine',
    tr: 'makine / Makineler',
    en: 'machine / Machines',
    keepEnglish: false,
    avoid: ['worker'],
    note: '"worker" only in CLI and package names (remyral-worker)',
  },
  { concept: 'needs you', tr: 'Senden bekleyenler', en: 'Needs you', keepEnglish: false },
  { concept: 'approval', tr: 'onay', en: 'approval', keepEnglish: false },
  { concept: 'chat / assistant', tr: 'sohbet / asistan', en: 'chat / assistant', keepEnglish: false },
  { concept: 'output', tr: 'çıktı / Çıktılar', en: 'output / Outputs', keepEnglish: false },
  { concept: 'usage', tr: 'kullanım / Kullanım', en: 'usage / Usage', keepEnglish: false },
  {
    concept: 'project / workspace',
    tr: 'proje / çalışma alanı',
    en: 'project / workspace',
    keepEnglish: false,
  },
  { concept: 'settings', tr: 'Ayarlar', en: 'Settings', keepEnglish: false },
  {
    concept: 'automation / template',
    tr: 'otomasyon / şablon',
    en: 'automation / template',
    keepEnglish: false,
  },
  { concept: 'merge', tr: 'birleştirme / birleştir', en: 'merge', keepEnglish: false },
  {
    concept: 'credential',
    tr: 'kimlik bilgisi',
    en: 'credential',
    keepEnglish: false,
    avoid: ['credential'],
  },
  { concept: 'vault', tr: 'kasa', en: 'vault', keepEnglish: false, avoid: ['vault'] },
  {
    concept: 'skill',
    tr: 'yetenek',
    en: 'skill',
    keepEnglish: false,
    avoid: ['beceri', 'beceriler', 'skill'],
  },
  { concept: 'memory / knowledge', tr: 'hafıza / bilgi', en: 'memory / knowledge', keepEnglish: false },
  { concept: 'quota / budget', tr: 'kota / bütçe', en: 'quota / budget', keepEnglish: false },
  { concept: 'preview', tr: 'önizleme', en: 'preview', keepEnglish: false },
  { concept: 'sign-in / session', tr: 'giriş / oturum', en: 'sign-in / session', keepEnglish: false },
  { concept: 'language', tr: 'dil', en: 'language', keepEnglish: false },
];

/** Words Turkish catalog copy must not use (from {@link GLOSSARY}). */
export const AVOID_IN_TURKISH: readonly string[] = GLOSSARY.flatMap((g) => g.avoid ?? []);
