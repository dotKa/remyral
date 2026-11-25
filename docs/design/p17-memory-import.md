# p17-memory-import — importing a person's memory from their own AI assistant

- **Task:** `p17-memory-import`. **Date:** 2026-10-24.
- **Owner request (2026-10-24):** "içe aktarma aracı yapabiliriz. bu araç hem kurulum adımı hemde ayarlar ekranından
  çalıştırılabilir. … kendi ai agent hafızamı içe aktarmak istiyorum. örneğin lokalimde claude de bir prompt
  çalıştıracağım bu prompt benim claude ile yaptıklarımdan claude hafızamı vs. benimle ilgili öğrendiklerini vericek.
  bunu remyral de içe aktararak sıfır bir sistemle değil beni önden tanımış bir sistemle başlamış olucam"
- **Builds on:** [ADR-0043](../adr/0043-typed-memory-layers.md) (typed records, personal rules = the `user:<id>`
  layer), [p11-memory-layers](p11-memory-layers.md) (records, lifecycle, conflicts, security review §8),
  [p17-auto-learning](p17-auto-learning.md) (the instruction heuristic, TR/EN twin clustering, thresholds),
  [p16-selfhost-onboarding](p16-selfhost-onboarding.md) (the wizard), p17-settings-tabs (`DyTabs`).
- **Migration:** 0153 (additive). **Worker release:** none (master + web only). **ADR:** none new — the import is one
  more way a *person* writes records; every ADR-0043 rule (personal scope = rules, a person decides, one channel into
  the bundle) holds unchanged.

## 1. The flow

1. **Copy the prompt** (Ayarlar → Profil → İçe aktar, or the wizard): Turkish or English, full or short, copy button.
2. **Run it in one's own assistant** (Claude, ChatGPT, Gemini, any) and paste the answer — or read a `.md` / `.txt` /
   `.json` file (read in the browser, ≤ 256 KB).
3. **Preview** (`POST /memory-imports/preview`): parsed into candidates with a proposed type and scope, checks and
   duplicates. Nothing is stored.
4. **Review**: include / exclude per item, bulk selection, edit the text, change scope and type; flagged items start
   unchecked with the reason in words; a secret-looking item cannot be imported at all.
5. **İçe aktar** (`POST /memory-imports`): the kept items become ordinary memory records through the normal records
   path; one batch per import.
6. **Bu içe aktarmayı geri al** (`POST /memory-imports/:id/undo`): the batch's still-active records become `rejected`.

## 2. The export prompt (`packages/i18n/src/memory-import-prompt.ts`, version 1)

A versioned constant, not a catalog entry: the console shows both language versions whatever its own language is, and
the master records the version an import was made with (`memory_imports.prompt_version`).

- **Full**: asks for exactly one ```` ```remyral-memory ```` block of JSON Lines — `{"type", "scope", "text",
  "evidence"?, "date"?}`; types `preference | working_style | fact | project | rule | tool | avoid`; scope `personal |
  team`; one short third-person statement per line ("Kullanıcı pnpm kullanır."), in the user's language; never commands
  aimed at agents; excludes secrets (passwords, keys, tokens, credentials in connection strings, recovery codes),
  other people's personal data, sensitive categories (health, religion, politics, sexual orientation, ethnicity,
  finances), guesses and stale one-offs; most important first, at most 150 items; an empty block when nothing is known.
- **Short** (assistants with limited memory): "summarize what you know from our past chats" as `- [tür] metin` lines
  (TR words `tercih, çalışma, bilgi, proje, kural, araç, kaçın`; EN the type names).
- Shown with "Tasarlandığı asistanlar: Claude, ChatGPT, Gemini" — *designed for*, not verified: whether a given
  assistant version follows it exactly is not tested; the tolerant parser takes what it gets.

Bump the version whenever the format or the rules change meaning; the parser keeps accepting earlier output.

## 3. Parser (`apps/master/src/memory-import/parse.ts`, pure, never throws)

- **Strict**: a fenced block (`remyral-memory`, `jsonl`, `json`, `ndjson`, or an unlabelled block with JSON lines;
  an unclosed fence still counts), a whole JSON array / `{items: [...]}` / `{memories: [...]}` (a `.json` file), or
  bare JSON Lines. Field aliases: `type|kind|category`, `text|statement|content|item|memory`, `evidence|source`,
  `date|since|updated`. A malformed line is reported (`invalid_json`, `missing_text`, `not_an_object`) and skipped;
  an unknown type is reported (`unknown_type`) and guessed. Dates other than `YYYY-MM[-DD]` are dropped.
- **Tolerant** (anything else, the short prompt's answer): Markdown bullets and numbered lines; `[type]`, `type:`,
  `**Type:**` prefixes in Turkish or English; headings (`## Tercihler`, `**Projects:**`, `Tools:`) type the bullets
  under them; indented or wrapped lines continue a bullet; plain paragraphs are split into sentences; framing lines
  ("Here is what I know:", "İşte …") are dropped. Without a prefix the kind is guessed from a few words (avoid /
  preference / rule / tool, else fact).
- **Mixed** JSON lines among prose are both read.
- Text: NFC, control characters removed, **zero-width and bidirectional characters removed** (the item is flagged
  `instruction:hidden_text`), surrounding quotes / bold removed.
- Caps: 256 KB of UTF-8 per import (`memory_import_too_large`), 200 items (the rest reported as truncated), an item
  over 1000 characters is flagged `too_long` (and cannot be imported until shortened).

## 4. Mapping (`review.ts`)

| Item kind | Personal scope (`user:<id>`, the default) | Project / global scope |
| --- | --- | --- |
| rule, avoid | rule | rule |
| preference | rule | fact |
| working_style | rule | lesson |
| fact, project, tool | rule | fact |

Why personal items are all rules: ADR-0043 §4 and the DB check `context_documents_user_shape` make the personal layer
**rules only** — it is the person's own instruction layer, injected only into the jobs and chats *they* create, below
platform policy and global rules (ADR-0010 order). Personal facts would need a new layer in the bundle resolver, the
chat block and the hash identity; for "the system should know me" a personal rule ("Kullanıcı küçük PR'ları tercih
eder.") does exactly that, in the one channel every runtime already reads. The item's kind is kept as a tag
(`kind:preference`), the assistant's evidence becomes the record's rationale ("Why: …"), a date the tag `date:…`.
Project and global scopes keep the types apart (decisions are never imported: they are a team's recorded choices).

**Scope default** `personal`. Opened from a project's Hafıza tab (`?project=<id>`), items the assistant marked `team`
default to that project when the person may write there. The person can pick per item: personal, any project where
they are operator or more, global (admins and owners).

**Permissions** — exactly those of writing the record by hand (the service checks every item before anything is
written; one refused scope refuses the whole import, audited `memory.import` denied): personal — the person themself
(`memory.personal`, any signed-in user, like `/memory-records/personal`); a project — operator or more in that project
and the document write role (`context.write`); global — an admin (the global namespace's write role). This follows the
brief's "the same permission as creating them manually"; in practice operators of a project may import into it too,
as they may add records there.

## 5. Checks and duplicates

**Flags** (an item starts unchecked with the reason shown; the person may still tick it — except `secret`):

| Flag | Source |
| --- | --- |
| `secret` | the ADR-0006 secret scan (`scanForSecrets`) on text and evidence, or a `[REDACTED` marker — never importable; the context store scans again on create |
| `instruction:override / authority / skip_safety / exfil_url / shell_pipe / credentials / hidden_text / encoded_blob / markup` | the p17-auto-learning instruction heuristic (`guard.ts`, TR + EN), on text and evidence |
| `personal_data` | an e-mail address, a phone number, an IBAN or a card-like number (someone else's data, or the person's own — they decide) |
| `sensitive` | health, religion, politics, sexual orientation, ethnicity, finances (TR + EN word lists, conservative) |
| `too_long` / `too_short` | > 1000 characters / < 8 characters or one word |
| `duplicate` | same meaning as an existing record (below) |
| `duplicate_in_import` | a twin of another item of this import; it merges into the better one |

Notes (stay checked): `time_bound` (the auto-learning transient heuristic: "şu an", "currently", hostnames …),
`similar` (close to an existing record — after import the usual p11 "may replace" check runs), `contradicts` (the p11
contradiction heuristic against an existing record: negation, another tool of a family, another value; after import
the pair appears under "Olası çakışmalar" for a person).

**Duplicates against existing records**: the person's active personal records, the target project's active records
(when opened from a project) and the active global records. Lexical (word-set Jaccard, p11 `statementSimilarity`):
≥ 0.8 duplicate, ≥ 0.5 similar. Semantic only with **consent** — the "Anlamına göre karşılaştır" box (off by
default, offered only when an embedding provider is configured): the import's texts and the person's own records are
embedded once (`SearchService.embedConsented`, secret-looking texts never sent, nothing stored); project records only
when that project's search capture is consented; global records stay lexical. Semantic ≥ 0.85 (the auto-learning twin
threshold) is a duplicate, ≥ 0.78 (p10 "related") similar.

**Twins inside the import**: the auto-learning clustering (`cluster()`: semantic ≥ 0.85 with vectors, else Jaccard
≥ 0.6; greedy, no chaining), across kinds; the keeper is the best-written item in the person's language (majority of
the items' languages, ties Turkish). Without consent a Turkish and an English twin are not recognised (documented
limit, same as auto-learning).

## 6. Console

- **Ayarlar → Profil → İçe aktar** (`/settings/profile?tab=import`, a `DyTabs` tab next to "Kişisel kurallar"):
  the untrusted-data note, (1) the prompt (language, full / short, read-only text, "İstemi kopyala", "Tasarlandığı
  asistanlar", the version), (2) the assistant (Claude / ChatGPT / Gemini / Copilot / Diğer + name), the text area, a
  file picker (read with `FileReader`, size checked before sending), the consent box, "Önizle", (3) the review (counts,
  unreadable lines, the notes, Tümünü seç / Hiçbirini seçme / Yalnızca işaretsizleri seç, per item: include, kind,
  guessed / team hints, editable text, scope, type limited by scope, evidence and date, flags in red, notes muted,
  "Aynı şeyi söyleyen maddeler bununla birleştirilir: 3"), "İçe aktar (N)", the result ("N kayıt eklendi (kaynak:
  Claude)", per-item failures in words, "Bu içe aktarmayı geri al" two-step, a link to the personal rules) and
  "Önceki içe aktarmalar" with their undo.
- **Setup wizard**: step `about_you` "Seni tanıyalım" right after the owner account step; the same panel without the
  history; optional ("Bu adımı atla"), detected (done) once the owner has an import that imported something and was
  not undone. The wizard now counts ten actionable steps.
- **Projeler → Hafıza**: "İçe aktar" next to "Yeni kayıt" for operators and up (viewers do not see it) →
  `/settings/profile?tab=import&project=<id>`.
- **Records** carry "İçe aktarıldı · Claude" (tooltip: when) wherever records are listed (project, Settings → Bağlam,
  personal rules).
- Turkish without the circumflex; tr + en catalogs (`memoryImport`, `selfhost.wizard.steps.about_you`,
  `forms.tabs.profile.import`).

## 7. API and data

| Route | Authz | Notes |
| --- | --- | --- |
| `GET /memory-imports/options` | `memory.personal` | prompt version, caps, `semanticAvailable`, `canGlobal`, `personalScope` |
| `POST /memory-imports/preview {text, project?, semantic?}` | `memory.personal` | stores nothing; 30 / hour / user; body ≤ 1 MiB, text ≤ 256 KB |
| `POST /memory-imports {assistant, assistantLabel?, promptVersion?, format, sha256?, bytes?, semantic?, items[≤200]}` | `memory.personal` + per-item scope check | 10 / hour / user; audited `memory.import` (success / denied) |
| `GET /memory-imports` | `memory.personal` | the caller's own imports (50) with `activeRecords` |
| `POST /memory-imports/:id/undo` | `memory.personal`, own imports only (404 otherwise) | once (409 `memory_import_already_undone`); 30 / hour; audited `memory.import.undo` |

Rate limits answer 429 `rate_limited` (reason `memory_imports`) with `Retry-After`. New error codes:
`memory_import_not_found`, `memory_import_already_undone`, `memory_import_scope_forbidden`, `memory_import_too_large`.

`memory_imports` (0153): user, assistant (+ label), prompt version, format, **SHA-256 and size of the text — never the
text itself**, counts (total, imported, failed, flagged items the person imported anyway), scopes written, consent,
`created_at`, `undone_at / undone_by`. `memory_records.import_id` links a record to its batch.

A record created by an import: `MemoryRecordService.create` with origin `{author: human, authorRef: <person>,
importSource: "import: <assistant>", importId}` → the context version's provenance is `import` with that source; the
record's `author` is human, `author_ref` and `accepted_by` the person; tags `import`, `kind:<kind>` (+ `date:…`); the
usual `memory.record.create` + `context.doc.create` audits (with `importId`), conflict detection, versions, pinning.
`imported_at` is the batch's `created_at` (`RecordView.imported {importId, assistant, assistantLabel, at}`).

## 8. Security review

The pasted text is **untrusted**: it was written by an outside model from conversations that may themselves contain
planted text, and the person may paste something they did not read.

| Threat | Mitigation | Test |
| --- | --- | --- |
| Planted **instructions** becoming personal rules that steer the person's jobs ("ignore previous instructions", "always skip tests", `curl … \| sh`, exfil URLs) | the auto-learning instruction heuristic on every item (text + evidence) — flagged items start unchecked with the reason; nothing is saved without the person's explicit "İçe aktar"; personal rules rank below platform policy and global rules (ADR-0010) and reach only the person's own jobs; the prompt tells the assistant to write statements, not commands | unit (flags), integration "preview", web review |
| **Secrets** into memory | the prompt forbids them; the secret scan flags and blocks the item in the review, the service refuses it again on import (`secret_detected`, the value never in the audit), and the context store's own scan on create | unit, integration "a secret is refused per item" |
| **Other people's data / sensitive categories** | the prompt excludes them; `personal_data` and `sensitive` flags start unchecked | unit |
| **Hidden text** (zero-width / bidi characters) | removed from the text, flagged | unit |
| **Executing** anything | the import only parses text and creates records; no command, URL or file in it is followed; records are shown as plain React text | code review |
| **Privilege escalation** through scopes (writing project rules or global rules one could not write by hand) | per-item scope check before anything is written (project operator+, global admin, personal = self), the context store's write role on create; one refused scope refuses the whole import, audited | integration "permissions" |
| **Flooding** memory | ≤ 256 KB, ≤ 200 items, ≤ 1000 characters per item, 10 imports and 30 previews per hour per user; duplicates and twins start unchecked | integration "size cap and rate limit" |
| **Persistence** of a bad import | "Bu içe aktarmayı geri al" rejects the whole batch's active records at once (history kept, never injected again); every record also keeps its own lifecycle (edit, expire, reject); provenance on the record ("İçe aktarıldı · Claude") and in the version (`import: Claude`) | integration "undo" |
| **Privacy** of the text with an embedding provider | meaning-based comparison only with the person's explicit consent per preview, only when a provider is configured, secret-looking texts never sent, vectors never stored; project records only with the project's capture consent | code review |
| **Storage** of what was pasted | only a SHA-256 and the size are kept; the text exists only in the created records | integration (audit metadata) |
| Repudiation | `memory.import` / `memory.import.undo` audits (actor, counts, scopes, hash, failures, flagged items imported anyway) plus per-record audits | integration |

Residual: a carefully phrased instruction that the heuristic misses and the person ticks becomes one of their
personal rules — it applies only to their own jobs and chats, below platform policy and global rules, and can be
undone with the batch.

## 9. Rollback and operations

- Migration 0153 is additive; an older master ignores `memory_imports` and `import_id` (imported records stay
  ordinary records). Roll back the master together with (or before) the web: an older web does not know the wizard
  step `about_you` the new master lists and would fail to render the wizard for an owner who has not finished it (a
  completed wizard is never shown). Records keep working either way.
- Release: master + web; no worker release.
- Nothing runs in the background.

## 10. Tests

- `apps/master/test/unit/memory-import.test.ts` — strict (fenced TR block, EN aliases, malformed / unknown / non-object
  lines, `.json` array / `{items}`, bare JSON Lines, unclosed fence, item cap, hidden characters), tolerant (the short
  prompt's `- [tür]` answer in TR and EN, headings and wrapped bullets, paragraphs split with guessed kinds, fenced
  Markdown, JSON mixed with prose, chatter only), the shipped prompt's own examples parse, kind words and guesses,
  the mapping table, provenance names, flags (clean, secret, instruction, hidden, personal data, sensitive, length,
  time-bound, evidence), what unchecks, dedupe (lexical duplicate / similar / contradiction, semantic TR/EN twin of a
  record and inside the import with the Turkish one kept, no lexical twin across languages), the person's language.
- `apps/master/test/integration/memory-import.test.ts` — options, preview without consent (flags, duplicate of the
  person's own rule, nothing stored), preview with consent (TR/EN twin merged), tolerant English, import (personal rules,
  provenance `import: Claude`, author / accepted by the person, tags, rationale, audit without the secret, the secret
  refused per item), the bundle (the importer's own jobs only, personal layer), permissions (viewer → project refused
  as a whole and audited, operator → project, operator → global / another person / a personal fact refused, admin →
  global with an "other" label), undo (another person 404, rejected, out of the bundle, once, audited), the wizard step
  (order, skip, detected after an import, not after its undo), the size cap and the preview rate limit.
- `apps/web/test/p17-memory-import.test.tsx` — the prompt (TR / EN, full / short, copy, "Tasarlandığı"), preview →
  review (flags unchecked with reasons, twins, blocked secret, issues, bulk selection, edit, scope / type, the import
  body), the result with per-item failures, undo, history; file reading and the size cap; a viewer's scopes and
  `?project=`; the wizard step (import → detected, skip); the project tab link (operators and up) and the record badge.
- Updated: `selfhost-onboarding` (master + web: the new step), `route-coverage`.

UNVERIFIED-LIVE: the prompt against the real current Claude, ChatGPT and Gemini (the format they actually produce, and
how much of a person's memory they reveal); the 0.85 semantic threshold for imported TR/EN twins with real Cohere
Multilingual v3 vectors (as in p17-auto-learning).
