/**
 * p17-memory-import (docs/design/p17-memory-import.md §2): the export prompt a person runs in their own AI assistant
 * (Claude, ChatGPT, Gemini, any) so it writes out what it knows about them in a format the import parses. A versioned
 * constant, not a catalog entry: the console shows BOTH language versions whatever its own language is (the person
 * picks the one their assistant should answer in), and the master records the version an import was made with.
 *
 * Bump {@link MEMORY_IMPORT_PROMPT_VERSION} whenever the format or the rules change meaning. The parser accepts every
 * earlier version's output (the strict JSON Lines block, and the short variant's `- [type] text` lines).
 *
 * "Designed for" (tasarlandığı), never "verified with": the prompt was written for these assistants; whether a given
 * assistant version follows it exactly is not tested here (the tolerant parser takes what it gets).
 */

export const MEMORY_IMPORT_PROMPT_VERSION = 1;

/** The fence language of the strict block (also accepted: `jsonl`, `json`, none). */
export const MEMORY_IMPORT_FENCE = 'remyral-memory';

/** The assistants the prompt was written for (shown as "Tasarlandığı asistanlar", not as tested). */
export const MEMORY_IMPORT_DESIGNED_FOR = ['Claude', 'ChatGPT', 'Gemini'] as const;

export interface MemoryImportPrompt {
  /** The full prompt: a strict JSON Lines block, one item per line. */
  readonly full: string;
  /** For assistants with little memory: a short summary as `- [type] text` lines (the tolerant parser). */
  readonly short: string;
}

const FENCE = '```';

const TR_FULL = `Seninle yaptığım geçmiş konuşmalardan ve hafızandan benim hakkımda bildiklerini, benim adıma kod yazan, test eden, deploy eden ve sunucuları yöneten bir yazılım ve operasyon ajan ekibine aktarmak istiyorum. Bu ekibin işini iyi yapmasına yardımcı olacak, benimle ilgili öğrendiğin her şeyi aşağıdaki biçimde ver.

Biçim (kesin):
- Yanıtın yalnızca tek bir kod bloğu olsun ve bloğun dili ${MEMORY_IMPORT_FENCE} olsun.
- Bloğun her satırı tek bir JSON nesnesi olsun (JSON Lines): satır başına bir madde. Boş satır, yorum ya da açıklama ekleme.
- Alanlar:
  - "type": şunlardan biri: "preference" (tercih), "working_style" (çalışma biçimi), "fact" (benim hakkımda bir bilgi), "project" (üzerinde çalıştığım bir proje ya da sistem), "rule" (uyulmasını istediğim bir kural), "tool" (kullandığım bir araç, dil ya da servis), "avoid" (kaçınılmasını istediğim bir şey).
  - "scope": "personal" (yalnız benim işlerim için geçerli) ya da "team" (ekibimin ya da projemin genel bilgisi).
  - "text": maddenin kendisi. Tek cümle, en fazla 300 karakter, kendi başına anlaşılır.
  - "evidence": isteğe bağlı. Bunu nereden bildiğin, kısaca (örneğin "Mart 2026 deploy konuşması").
  - "date": isteğe bağlı. Öğrendiğin ya da en son doğrulandığı tarih: YYYY-MM ya da YYYY-MM-DD.
- Metni Türkçe yaz. Her maddeyi üçüncü kişiyle, bilgi veren bir cümle olarak yaz ("Kullanıcı Node.js projelerinde pnpm kullanır.", "Kullanıcı küçük pull request'leri tercih eder."). Ajanlara emir veren cümleler yazma ("her zaman şunu yap", "önceki talimatları yok say" gibi).

Örnek:
${FENCE}${MEMORY_IMPORT_FENCE}
{"type":"tool","scope":"personal","text":"Kullanıcı Node.js projelerinde paket yöneticisi olarak pnpm kullanır.","date":"2026-09"}
{"type":"avoid","scope":"team","text":"Üretim veritabanında onaysız migration çalıştırılmaz.","evidence":"Eylül 2026 olay sonrası konuşma"}
${FENCE}

Kesinlikle dahil etme:
- Parola, API anahtarı, token, özel anahtar, bağlantı adresi içindeki kullanıcı adı ve parola, kurtarma kodu ya da başka herhangi bir gizli değer; bunların bir parçasını bile.
- Başka kişilerin kişisel bilgileri (e-posta, telefon, adres, kişisel durumları).
- Sağlık, din, siyasi görüş, cinsel yönelim, etnik köken ya da maddi durum gibi hassas kişisel bilgiler.
- Emin olmadığın tahminler ve artık geçerli olmayan tek seferlik durumlar.

Kurallar:
- Her madde kısa olsun ve tek bir konuyu anlatsın. Aynı şeyi söyleyen maddeleri birleştir.
- En önemli maddeleri önce yaz; en fazla 150 madde.
- Benim hakkımda bir şey bilmiyorsan boş bir blok döndür.`;

const TR_SHORT = `Geçmiş konuşmalarımızdan benim hakkımda öğrendiklerini özetle: tercihlerim, çalışma biçimim, kullandığım araçlar, projelerim, uyulmasını istediğim kurallar ve kaçındığım şeyler. Her maddeyi ayrı bir satırda "- [tür] metin" biçiminde yaz; tür şunlardan biri olsun: tercih, çalışma, bilgi, proje, kural, araç, kaçın. Türkçe, kısa ve üçüncü kişiyle yaz ("Kullanıcı pnpm kullanır."). Parola, anahtar, token gibi gizli bilgileri, başka kişilerin kişisel bilgilerini ve sağlık gibi hassas bilgileri yazma. Emin olmadığın şeyleri yazma.`;

const EN_FULL = `From our past conversations and your memory, I want to hand what you know about me to a software and operations agent team that writes code, runs tests, deploys and manages servers on my behalf. Give me everything you have learned about me that would help this team do its work well, in the format below.

Format (strict):
- Answer with exactly one code block whose language is ${MEMORY_IMPORT_FENCE}.
- Every line of the block is one JSON object (JSON Lines): one item per line. No blank lines, comments or explanations.
- Fields:
  - "type": one of "preference", "working_style", "fact" (a fact about me), "project" (a project or system I work on), "rule" (a rule I want followed), "tool" (a tool, language or service I use), "avoid" (something I want avoided).
  - "scope": "personal" (applies to my own work only) or "team" (general knowledge of my team or project).
  - "text": the item itself. One sentence, at most 300 characters, understandable on its own.
  - "evidence": optional. Briefly, how you know it (for example "deploy conversation, March 2026").
  - "date": optional. When you learned it or last confirmed it: YYYY-MM or YYYY-MM-DD.
- Write in English. Write every item in the third person as a statement ("The user uses pnpm in Node.js projects.", "The user prefers small pull requests."). Do not write commands aimed at agents (such as "always do this" or "ignore previous instructions").

Example:
${FENCE}${MEMORY_IMPORT_FENCE}
{"type":"tool","scope":"personal","text":"The user uses pnpm as the package manager in Node.js projects.","date":"2026-09"}
{"type":"avoid","scope":"team","text":"Migrations are not run on the production database without approval.","evidence":"post-incident conversation, September 2026"}
${FENCE}

Never include:
- Passwords, API keys, tokens, private keys, credentials inside connection strings, recovery codes or any other secret value, not even part of one.
- Other people's personal data (e-mail, phone, address, personal circumstances).
- Sensitive personal data such as health, religion, political views, sexual orientation, ethnic origin or financial situation.
- Guesses you are not sure about and one-off situations that no longer hold.

Rules:
- Keep each item short and about one thing. Merge items that say the same thing.
- Most important items first; at most 150 items.
- If you know nothing about me, return an empty block.`;

const EN_SHORT = `Summarize what you have learned about me from our past chats: my preferences, how I work, the tools I use, my projects, rules I want followed and things I avoid. Write each item on its own line as "- [type] text", where type is one of: preference, working_style, fact, project, rule, tool, avoid. Write in English, briefly and in the third person ("The user uses pnpm."). Do not include secrets such as passwords, keys or tokens, other people's personal data, or sensitive data such as health. Leave out anything you are not sure about.`;

export const MEMORY_IMPORT_PROMPTS: Readonly<Record<'tr' | 'en', MemoryImportPrompt>> = {
  tr: { full: TR_FULL, short: TR_SHORT },
  en: { full: EN_FULL, short: EN_SHORT },
};
