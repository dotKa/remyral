# i18n — one language per screen (Turkish default, English second)

- **Status:** Phases 0–1 implemented (p14-i18n-foundation, [ADR-0053](../adr/0053-i18n-typed-catalog.md), migration 0101,
  [glossary](i18n-glossary.md)); Phase 2 implemented (p14-i18n-shell, ADR-0053 addendum: `DiyalogTextScope` /
  `useSharedT` for shared modules until Phase 8; ratchet 8,626 → 8,235); Phase 3 implemented (p14-i18n-errors, ADR-0053
  addendum "master errors as code + params"; 269 codes in the `errors` catalog; ratchet 8,235 → 8,224); Phase 4 implemented
  (p14-i18n-reasons, ADR-0053 addendum "reasons as code + params"; 70 reason codes, 5 causes in the `reasons` catalog;
  ratchet 8,224 → 8,130); Phase 5 in progress — group A (p14-i18n-screens-a: Home + ops thread, Sohbet incl. composer
  and draft cards, Senden bekleyenler, İşler, job detail) moved to the `home`, `chat`, `chatCompose`, `drafts`, `needs`,
  `jobs`, `job`, `jobCards`, `jobDetail` namespaces (TR verbatim except "dal" → "branch"; 2,092 → 0 literals in those files);
  group B (p14-i18n-screens-b: Workflow’lar, Makineler incl. every machine tab and fleet tools, Çıktılar, Kullanım) moved to
  `workflows` (extended), `machines` (extended), `fleetTools`, `machineRuntimes`, `machineConfig`, `machineAdmin`,
  `outputs`, `usage` (TR verbatim except "worker" → "makine" / "makine yazılımı" / "Remyral", "dağıtım" → "yayılım" /
  "sistem paketleri"; the runtime limit words of `api/runtimeUsage.ts` — "5h", "weekly", "Read 2 min ago", 12-hour
  times — now come from `usage.limits` in Diyalog, the classic console keeps them; 2,336 → 15 literals in those files);
  Phases 6–9 open. Owner decisions §9 approved 2026-10-20. **Date:** 2026-10-20.
  **Canvas:** the internal note `i18n` (not published).
- **Owner request (2026-10-20):** the UI has no language consistency — in the Diyalog UI (the default since the
  ADR-0047 addendum) the sidebar says English "Jobs" while chat says Turkish "Sohbet". Text also arrives from the master
  (errors, reasons, notifications, e-mail, push, weekly reports, assistant tool texts) and from workers (reasons).
- **Goal:** every screen renders in exactly one language, chosen per user; Turkish (`tr`) is the default, English (`en`)
  the second language. No feature is lost (parity rule, `redesign-feature-parity`).
- **Builds on:** ADR-0047 (Diyalog; the classic UI stays available for one more release), p6-ui-refactor §4 "Humane
  reasons" (`apps/web/src/lib/reasons.ts`), p5-notifications (migration 0014), p8-cost-efficiency (weekly report),
  p7-supply-chain (`docs/security/dependency-policy.md`, `pnpm security:pins`).
- **Needs:** one ADR (`i18n — typed catalogs, codes not prose`) once the owner decides §9; one migration (users.locale +
  notification template columns); one additive protocol change (reason params); one worker release (Phase 4 only).

## 1. Inventory method (measured, 2026-10-20)

All counts come from scripts run on the working tree, not estimates:

- **String literals:** a TypeScript-compiler-API walk (typescript 6.0.3 from the repo) over every non-test `.ts/.tsx`
  file (excluding `test/`, `harness/`, `*.test.*`, `*.d.ts`) collecting JSX text, string attributes that are not
  technical (`className`, `href`, `to`, `id`, `role`, `data-*`, `on*`, SVG geometry, … excluded), string literals and
  template literals that look like prose (words, not class lists, paths, SQL or identifiers). Logger calls,
  `describe/it/expect`, imports, object keys, `case` labels and `===` comparands are skipped.
- **Language:** Turkish letters (`çğıöşüİ`) ⇒ `tr`; otherwise ≥ 60 % of the non-term words found in the system English
  word list (`/usr/share/dict/words`) ⇒ `en`, else `tr`; strings made only of brand names or glossary terms (Claude
  Code, Codex, runtime, deploy, token, …) ⇒ `neutral`.
- **Precision:** a 50-row random sample was ~95 % real user-visible text. The language heuristic over-reports "English"
  for short Turkish words missing from the dictionary ("Ad", "Mod", "Zaman") and some English sentences without
  dictionary hits are tagged `tr`; the Diyalog "English" bucket was therefore reviewed by hand (§2.2). Treat area totals
  as ±5 %.
- **Other counts:** `grep` for call sites (formatting, `.message` renders, plural ternaries, test queries) and an AST
  count of `new HttpError(…)`.

The inventory script should be committed in Phase 0 as `scripts/i18n/inventory.mjs` and reused as the ratchet (§7.1).

## 2. Inventory

### 2.1 Web console — candidate user-visible strings per area

| Area                                                           | Occurrences | Unique texts | Files | Turkish | English | Neutral | Today's language                                                    |
| -------------------------------------------------------------- | ----------: | -----------: | ----: | ------: | ------: | ------: | ------------------------------------------------------------------- |
| Diyalog (`apps/web/src/diyalog`, no harness)                   |       9,303 |        6,799 |   231 |   8,872 |  ≤ 297¹ |     134 | Turkish (~97 %)                                                     |
| Classic screens/shell/components/lib/auth/pwa/sound/stepup/App |       7,036 |        5,316 |   217 |    ~0²  |   ~all  |     ~170 | English                                                             |
| API client layer (`apps/web/src/api`, shared by both UIs)      |         511 |          413 |    61 |    41³  |     394 |      22 | English, with Turkish leaks                                         |
| **Total**                                                      |  **16,850** |   **12,528** |   509 |         |         |         | by kind: JSX text 4,663 · attributes 3,359 · strings 6,587 · templates 2,241 |

¹ Upper bound; hand review in §2.2 finds ~30 genuinely English UI strings. ² The heuristic tags 557 classic strings as
Turkish, but only **42** contain Turkish letters; the rest are English words missing from the dictionary. ³ Real
Turkish leaks: `api/fleetTools.ts` (26, e.g. `:354` "Bu işletim sistemi/mimaride kurulamaz"), `api/runtimeAccounts.ts`
(12, e.g. `:356` "Hazır").

Diyalog by sub-area (occurrences): screens/machines 1,309 · screens/projects 1,119 · screens/settings 1,073 · job 739 ·
screens/usage 573 · screens/automations 438 · drafts 378 · screens/composer 372 · screens/workflows 316 · screens/outputs
306 · screens/knowledge 300 · (root: shell, home, cards) 293 · chat 270 · screens/jobs 252 · screens/uptime 235 ·
screens/deploys 212 · ops 209 · screens/templates 194 · common 148 · palette 130 · compose 120 · screens/approvals 121 ·
auth 83 · screens/shared 74.

Classic by sub-area (occurrences): screens (top-level pages) 1,804 · fleet 813 · chat 624 · usage 532 · deploy 443 · job
428 · composer 386 · automations 376 · shell 296 · outputs 269 · memory 173 · templates 157 · uptime 155 · lib 146 ·
live 97 · home 83 · components 63 · workspace 61 · pwa 54 · approvals 39.

### 2.2 Why Diyalog still looks mixed although ~97 % of its own literals are Turkish

The mixing does not come from Diyalog's own copy; it comes from five leaks:

1. **The sidebar itself** — `apps/web/src/diyalog/DiyalogShell.tsx:76` "Needs you", `:86` "Jobs", `:97` "Machines",
   `:104` "Outputs", `:105` "Usage", `:106` "Projects", `:112` "Settings", next to "Sohbet", "Workflow’lar" and the
   Turkish badge units "okunmamış", "bekliyor", "eşleşme bekliyor". This is the owner's example and the most visible
   spot.
2. **Master prose shown verbatim.** `api/client.ts:9` documents "the UI shows `message` as is"; Diyalog renders an
   `ApiError.message` or `Error.message` in **45** places, usually inside a Turkish frame:
   `diyalog/screens/parts.tsx:484` "{what} okunamadı: {English master message}", `diyalog/chat/SohbetScreen.tsx:82`
   "Asistan durumu okunamadı: …", `diyalog/topbar.tsx:151`. The master has **596** `new HttpError(…)` sites with **238**
   distinct codes; 442 literal messages (280 distinct), 94 template messages, 60 computed (AST count).
3. **Shared English helpers used by Diyalog.** `components/ui.tsx:237` "You can try again in", `:246` "Something went
   wrong. Try again." (via `toApiError`, imported 77× by Diyalog); `api/client.ts:55-56,124` network / session texts;
   `screens/usage/format.ts:3-4` `Intl.NumberFormat('en')` (imported 6×); classic chat parts rendered inside Diyalog
   chat rows (`diyalog/chat/rows.tsx:5-8` → `screens/chat/Messages.tsx:106` "Copy message", `:131` "Used";
   `screens/chat/Attachments.tsx:72` "Attached files", `:95` "Preparing…"; `screens/chat/JobActionParts.tsx:48-49`
   "Cancel", "Run again" via `diyalog/drafts/parts.tsx:13`).
4. **Notifications.** The bell (`diyalog/topbar.tsx:319-330`) prints a Turkish severity word and "okunmamış" followed by
   the master's English title and body; some bodies even embed Turkish button names inside English sentences
   (`apps/master/src/notifications/producers.ts:206` "… with the build and runtime logs and “Düzeltme işi başlat” (start
   a fix job).", `:263` "… its Deploy card has “Logları gör” and “Düzeltme işi başlat”.").
5. **A handful of English strings in Diyalog** (hand-reviewed): `screens/deploys/DeploysScreen.tsx:139-140` "Open the
   workflow run", `screens/jobs/RunIntegration.tsx:216` and `screens/jobs/WorkflowRuns.tsx:477` "Cancelled from the
   console", `screens/usage/SuggestionsView.tsx:44` "unknown job kind", `drafts/OpsDiff.tsx:398-400` and two copies
   (`screens/deploys/diff.tsx:396-398`, `screens/projects/tabs/deploy-diff.tsx:338-340`) "create project / adopt project
   / add domain", `job/details/ChangesTab.tsx:180` "Pull request", `job/details/RecordTab.tsx:206` "Force push",
   `screens/projects/ProjectScreen.tsx:197-204` "Coolify preview / Coolify production / Preview deploy".

**Fragile translation by matching English text.** Diyalog translates some master/protocol messages by comparing the
English wording, which breaks silently when the wording changes: `screens/shared/GitIdentity.tsx:34-44` (7 prefixes),
`screens/projects/tabs/policy-waits.tsx:49`, `screens/uptime/MonitorFormDialog.tsx:35`,
`screens/deploys/DeploysScreen.tsx:139`, and 3 regexes on the master message in each of `lib/reasons.ts` and
`diyalog/common/reasonsTr.ts` (e.g. `/ — waiting \(until /`, `/refreshing it at the same time/`).

**Duplicated wording.** 69 `…Tr` functions in 35 Diyalog files restate classic English helpers in Turkish
(`reasonsTr.ts` mirrors all of `lib/reasons.ts`; `drafts/summary.ts` has 16; `screens/projects/tabs/deploy-text.ts`,
`screens/composer/words.ts`, `screens/automations/labels.ts`, …). Two copies of `kindTr`, `decisionTr`, `bytesTr`,
`publishChainTr`, `describePolicyTr` exist.

**Terminology drift inside Turkish copy** (occurrences in Diyalog strings): "workflow" 37 vs "iş akışı" 35 (nav says
"Workflow’lar", automation forms say "iş akışı", `screens/automations/AutomationFormScreen.tsx:537,710`); "deploy" 103
vs "yayın" 119 vs "dağıtım" 7; "dal" 83 vs "branch" 15; "yetenek" 21 vs "skill" 12; "kimlik bilgisi" 45 vs "credential"
4; "kasa" 21 vs "vault" 1; "sandbox" 31 vs "korumalı alan" 0; "runtime" 299 (no Turkish rival).

### 2.3 Classic UI — Turkish inside English

- `shell/AccountMenu.tsx:92` "Klasik görünüme geç" (intentional switch label, but Turkish in an English shell).
- `api/fleetTools.ts` 26 Turkish strings, `api/runtimeAccounts.ts` 12 (Diyalog-first features whose shared API layer
  carries Turkish labels into the classic pages).
- `packages/protocol/src/queue.ts:142-147` `PRIORITY_CLASS_LABEL` = "Acil / Normal / Arka plan" (owner decision S2) is
  rendered by the classic composer and jobs list.

### 2.4 Master and worker texts that reach a person

| Channel                     | Where                                                                                                                                                         | Size today                                                                                                                                                                                                                   | Shape today                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| HTTP errors                 | `apps/master/src/http/errors.ts:7-23` `HttpError(status, code, publicMessage, headers, details)`; body `{ ...details, error, message }`; 8 generic bodies `:30-39` | 596 sites, 238 codes, 374 distinct literal/template messages; 6 sites pass `details`                                                                                                                                          | code + English sentence; params only inside the sentence                                            |
| Placement / worker reasons  | `packages/scheduler/src/placement.ts:744-822` `REASON_CODES` (52) + `PlacementReason { code, permanent, message, until? }`; worker `reason:` literals (110 in `apps/worker/src`) | 52 scheduler codes + fleet statuses + worker codes; web maps them in `lib/reasons.ts` (EN, 419 lines) and `diyalog/common/reasonsTr.ts` (TR, 189 lines) | often a single `"code: message"` string parsed by `parseReason` (`lib/reasons.ts:388`)               |
| In-app notifications        | `apps/master/src/notifications/producers.ts` (20 titles), `efficiency/suggestions.ts`, `backups/health.ts`, `uptime/notify.ts`, `approvals/pause-notify.ts`, `usage-limits/notify.ts`, `verify/notify.ts`, `fleet-tools/service.ts`, `runtime-usage/notify.ts` | 27 kinds (migration 0079 check), ~70 `title`/`body` literals                                                                                                                                                                  | **English prose stored in the DB** (`notifications.title/body`, migration 0014)                      |
| E-mail / Web Push / webhook | `notifications/smtp.ts`, `notifications/push/notifier.ts:65-66`, `notifications/webhook.ts`                                                                 | same texts as in-app                                                                                                                                                                                                         | copied from the stored title/body                                                                   |
| Weekly report               | `apps/master/src/efficiency/reports.ts`, `efficiency/text.ts:15` `Intl.DateTimeFormat('en-GB')`                                                              | 1 report kind, English, en-GB dates                                                                                                                                                                                          | prose + numbers                                                                                     |
| Chat watches                | `apps/master/src/chat/watches.ts:27,207,289-302`                                                                                                              | the **only** bilingual server text: `title/text/body: Record<'tr'\|'en', string>`; language guessed from the user's messages (`guessLanguage`) and stored per watch (`chat/routes.ts:108`)                                       | precedent for this plan                                                                             |
| Assistant tool outcomes     | `apps/master/src/chat/tools.ts:97-103` `{ ok:false, code: 'invalid'\|'forbidden'\|'not_found'\|'unavailable', message }`                                      | 4 codes, free English message                                                                                                                                                                                                | prose; the assistant's own replies follow the user's language (LLM)                                 |
| Audit / approval actions    | audit rows store action codes; approval action labels come from the classic `screens/ApprovalsPage` `actionLabel`, reused by `diyalog/screens/approvals/call.tsx:6` | English labels in the classic helper                                                                                                                                                                                         | codes in storage (good)                                                                             |

Master literal total (all of `apps/master/src`, includes logs and internal errors): 4,298 candidates; worker + scheduler
+ protocol + adapters: 2,651. Most are not user-visible; the channels above are the ones that are.

### 2.5 Dates, numbers, plurals

| Call                                | Diyalog | Classic web | Master | Locale argument today                                                                 |
| ----------------------------------- | ------: | ----------: | -----: | ------------------------------------------------------------------------------------- |
| `toLocaleString`                    |      50 |          59 |      0 | web-wide: 81 without a locale (browser default), 23 `'tr-TR'`, 1 `'tr'`, 1 `'en-US'`  |
| `toLocaleDateString`                |       5 |           5 |      0 | 5 `'tr-TR'`, 4 `undefined`, 1 none                                                    |
| `toLocaleTimeString`                |      13 |           9 |      0 | 7 `'tr-TR'`, 5 `undefined`, 10 none                                                   |
| `Intl.DateTimeFormat`               |       8 |           6 |      4 | 6 `'tr-TR'`, 5 none, 2 `undefined`, 1 `'en-GB'`; master `efficiency/text.ts` `'en-GB'` |
| `Intl.NumberFormat`                 |       1 |           5 |      0 | 5 `'en'` (`screens/usage/format.ts`, `screens/chat/ChatUsageCard.tsx:12`), 1 `'tr-TR'` |
| `Intl.RelativeTimeFormat`           |       1 |           2 |      0 | `'tr-TR'` (`diyalog/topbar.tsx`), `'en'`, `undefined`                                 |
| `Intl.PluralRules`                  |       0 |           0 |      0 | —                                                                                     |
| Hand-written time/size helpers      |   ~8    |    ~8       |   —    | `timeAgoTr`, `whenTr`, `agoText`, `since`, `relativeTime`, `formatBytes` (6 copies), `formatDuration*`, `formatUsd` |

Diyalog alone: 32 locale-less date/number calls vs 59 explicit `'tr-TR'`, so the same Diyalog screen can show
`20.10.2026 14:03` next to `10/20/2026, 2:03 PM` on an en-US browser (e.g. `diyalog/screens/settings/RuntimesView.tsx:481`,
`screens/projects/tabs/policy-limits.tsx:630`, `policy-waits.tsx:444`, `memory-records.tsx:715`).

Plural spots: classic 76 count ternaries (28 are English `n === 1 ? '' : 's'`, e.g. `screens/records.tsx:85`,
`screens/composer/placement.tsx:143`, `screens/job/JobTimeline.tsx:168`); Diyalog 35 (Turkish keeps the noun singular
after a number — these are semantic, e.g. `drafts/summary.ts:364` "İş" vs "İşaretli her iş"); master 17.

### 2.6 Existing i18n infrastructure

- **No i18n library, no message catalog, no locale setting.** `apps/web/package.json` dependencies: `@dagrejs/dagre`,
  `@xyflow/react`, `react`, `react-dom`, `react-router`, `yaml`; no package in the workspace depends on i18next, FormatJS
  or Lingui.
- The UI language is decided by **which shell renders**: classic = English, Diyalog = Turkish, with per-feature `…Tr`
  shims. The shell choice is per browser (`diyalog/flag.ts`, `localStorage['remyral.ui']`); its comment notes that the
  master has no generic per-user UI preference store.
- `users` (migration 0002) has no locale or time-zone column; budgets have their own `time_zone` (0068).
- Precedents to keep: reason codes + "unknown code shows the raw text" (p6-ui-refactor §4); `KNOWN_REASON_CODES` test
  keeping EN and TR in step; chat watches storing a language per record.
- Bundle today: one JS chunk, 786 kB minified / 217 kB gzip (`apps/web/dist/assets/index-*.js`).

### 2.7 Tests that match visible text

| Suite                                 | Files | Text-based queries¹ | Notes                                                                                   |
| ------------------------------------- | ----: | ------------------: | --------------------------------------------------------------------------------------- |
| Web unit (`apps/web/test`), Diyalog   |    59 |               2,070 | Turkish strings; unchanged if strings move to the TR catalog verbatim                   |
| Web unit, classic                     |    95 |               1,994 | English strings; unchanged if classic stays English                                     |
| Web e2e (`apps/web/e2e`)              |    20 |                 232 | Playwright `getByText` / `getByRole({ name })`                                          |
| Master (`apps/master/test`)           |    51 |               ~877² | assertions on `message`, `title`, `body`; unchanged while `message` stays English       |

¹ `getBy/findBy/queryBy(All)(Text|LabelText|PlaceholderText|DisplayValue|Title|AltText)`, `ByRole(…, { name })`,
`toHaveTextContent`, `textContent` matchers. ² Lines matching `message…toBe/Equal/Contain/Match`, `message: '…'`,
`.title/.body` matchers. The nav fix alone touches ~8 Diyalog test files (e.g. `test/diyalog-jobs.test.tsx:225,424,439`
query the heading "Jobs").

## 3. Library choice

Docs fetched with ctx7 on 2026-10-20 (`/i18next/i18next`, `/i18next/react-i18next`, `/formatjs/formatjs`,
`/lingui/js-lingui`). Sizes measured: esbuild 0.28.2 `--bundle --minify`, React external, `gzip -9`, on a minimal entry
(provider + hook + component). Versions are the newest releases **older than one week** (the workspace's
`minimumReleaseAge: 1440` needs one day; a week leaves room for yanks).

| Criterion                | i18next + react-i18next                                                                                              | FormatJS (react-intl)                                                                                                                         | Lingui                                                                                                                                                                                                 | Typed catalog, no dependency                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Pin (exact)              | `i18next@26.4.4` (2026-10-12), `react-i18next@17.0.16` (2026-10-06, peer `i18next >= 26.2.0`), `i18next-cli@1.75.3` | `react-intl@12.1.4` (2026-10-05; pulls `@formatjs/intl@6.1.3`, `intl-messageformat@12.1.3`), `@formatjs/cli@6.16.34`                            | `@lingui/core@6.9.1`, `@lingui/react@6.9.1`, `@lingui/cli@6.9.1`, `@lingui/vite-plugin@6.9.1` (2026-10-09) + a Babel step (`@rolldown/plugin-babel`)                                                     | none                                                                                                                            |
| License                  | MIT                                                                                                                  | BSD-3-Clause (react-intl, intl-messageformat), MIT (cli)                                                                                      | MIT                                                                                                                                                                                                    | —                                                                                                                               |
| Runtime size (gzip)      | **23.5 kB** (68.7 kB min)                                                                                            | **14.9 kB** (51.2 kB min)                                                                                                                     | **4.1 kB** (core + react; core alone 2.1 kB) — catalogs compiled at build time                                                                                                                          | < 1 kB (a lookup + `Intl.*`)                                                                                                    |
| Type-safe keys           | `declare module 'i18next' { interface CustomTypeOptions { resources … } }` → keys autocomplete, `t()` literal types; large catalogs are known to slow `tsc` | `declare global { namespace FormatjsIntl { interface Message { ids: keyof typeof messages } } }` → ids checked; **argument types not generated** (listed as a future feature in the FormatJS knowledge base) | message ids come from source text (macros); type safety is "the macro saw it", no typed params                                                                                                         | keys **and parameters** typed by the TS compiler (`en` must `satisfies` the shape of `tr`; a message is a string or a typed function) |
| Plurals                  | suffix keys `_one/_other` resolved through `Intl.PluralRules`; ICU needs the extra `i18next-icu` plugin               | ICU `{count, plural, one {# item} other {# items}}` native                                                                                    | `plural()` macro / ICU in PO                                                                                                                                                                            | `Intl.PluralRules` inside the EN function; Turkish needs none                                                                   |
| Turkish case suffixes after names ("mac-1’de", "makinesine") | not expressible in plain strings; needs post-processors                                    | ICU `select` cannot compute vowel harmony                                                                                                      | same as ICU                                                                                                                                                                                             | a function message does it (today's `reasonsTr.ts` already does: `onM`, `ofM`, `toM`)                                           |
| Lazy loading             | backends + `loadNamespaces`, Suspense                                                                                 | load JSON per locale yourself                                                                                                                 | `dynamicActivate` with `import()` (docs); Lingui drops default messages from production, so even the default locale needs a catalog                                                                       | `import('./en')` (Vite splits it); TR bundled                                                                                    |
| Extraction tooling       | `i18next-cli` (extract, types, lint, sync)                                                                           | `formatjs extract` / `formatjs compile`                                                                                                        | `lingui extract` / `lingui compile` mandatory before every build                                                                                                                                       | not needed: keys are code; a 60-line parity script + the inventory ratchet                                                      |
| Build impact             | none                                                                                                                 | none (optional babel/swc plugin for id generation)                                                                                            | **macro transform required**: Vite 8 + `@vitejs/plugin-react@6.1.2` (oxc, no Babel) needs `@rolldown/plugin-babel` + preset, and Vitest needs the same; Lingui 6 is ESM-only, Node ≥ 22.19 (repo: Node 24) | none                                                                                                                            |
| Master (Node) use        | yes (same lib)                                                                                                       | `intl-messageformat` / `@formatjs/intl`                                                                                                       | `@lingui/core` (macros still need a transform for `tsc`-built master)                                                                                                                                   | yes — the same package imported by web and master                                                                               |
| Supply-chain surface     | 2 runtime + 1 dev package (cli has a large tree)                                                                     | 4 runtime (transitive) + cli                                                                                                                  | 2 runtime + 3–4 build packages incl. Babel                                                                                                                                                             | 0                                                                                                                               |

### Recommendation: a typed catalog with no dependency (`packages/i18n`)

Reasons, in order of weight:

1. **Two languages, one owner-team, no external translators.** The features i18next/FormatJS/Lingui add over a typed
   catalog (translation-management integrations, PO/XLIFF, ICU for 40 locales, runtime backends) are not needed; their
   cost (pins, audits, `minimumReleaseAge`, an extra build transform for Lingui) is paid on every release.
2. **Turkish grammar.** The hardest existing copy (`reasonsTr.ts`: "mac-1 makinesinde / makinesinin / makinesine")
   needs code, not ICU strings. Function messages keep that working and type-check their parameters.
3. **Strongest type safety at zero cost.** A missing EN key, a mistyped key or a missing parameter fails `pnpm typecheck`
   — no generated types, no global augmentation, no `tsc` slowdown from a 6,000-key resource type (namespaces are plain
   modules).
4. **Shared by web and master.** Emails, push, weekly reports and error fallbacks render in the master with the same
   catalog the web uses.
5. **Exit path.** Messages are flat `namespace.key` entries whose string form uses `{param}` placeholders; if a third
   language or a translation vendor arrives, the catalogs can be exported to ICU JSON and react-intl `12.1.4` adopted
   (second choice; 14.9 kB gzip, ICU native, BSD-3).

If the owner prefers a mainstream library (decision §9.4), choose **react-intl 12.1.4 + intl-messageformat 12.1.3
(master) + @formatjs/cli 6.16.34**, pinned exactly; avoid Lingui (macro build step on Vite 8/oxc) and i18next (largest
runtime, weakest parameter typing).

## 4. Architecture

### 4.1 `packages/i18n` (new workspace package `@remyral/i18n`)

```
packages/i18n/src/
  locale.ts        Locale = 'tr' | 'en'; DEFAULT_LOCALE = 'tr'; negotiate(acceptLanguage | navigator.languages)
  format.ts        formatDateTime / formatDate / formatTime / formatRelative / formatNumber / formatCompact /
                   formatBytes / formatDuration / formatUsd / formatList — Intl.* with a cached formatter per
                   (locale, options, timeZone); tr → 'tr-TR', en → 'en-GB' (24 h, day-month order, matches today's
                   weekly report)
  tr/  common.ts nav.ts errors.ts reasons.ts notifications.ts jobs.ts machines.ts … (source of truth)
  en/  same files, each `export default { … } satisfies Messages<typeof import('../tr/x').default>`
  index.ts         createTranslator(locale) → typed accessor; plural(locale, n, forms); trSuffix helpers
```

- A message is a string (`'İşler'`) or a function (`(p: { n: number }) => \`${p.n} makine\``). Strings may use
  `{name}` placeholders only through a typed helper; no HTML in messages — rich text is composed in JSX around them.
- Access is by property, not string keys: `const t = useT(); t.nav.jobs`, `t.jobs.count({ n })`. Dynamic lookups (error
  codes, reason codes, audit actions, notification templates) go through typed maps with an explicit fallback:
  `t.errors.byCode(code, params) ?? apiError.message`.
- Untrusted values (worker names, repo names, reason texts) are only ever interpolated as text — no change to today's
  rule.
- Search folding (`toLocaleLowerCase('tr-TR')`, palette aliases such as `diyalog/palette/sources.ts:84-103`) is not
  display text; it stays and gains the EN words when EN copy is added.

### 4.2 Web

- `apps/web/src/i18n/I18nProvider.tsx`: holds the locale, loads `en` with `import()` (TR is in the main bundle), exposes
  `useT()`, `useFormat()`, `useLocale()`; sets `<html lang>`.
- **Diyalog** reads the user's locale. **Classic** is wrapped in `I18nProvider locale="en"` permanently (§8, Phase 8):
  shared modules that become catalog-backed (`components/ui`, `api/client`, `lib/reasons`, priority labels) then render
  English in classic and the user's language in Diyalog, which also removes the Turkish leaks of §2.3.
- `<html lang>` and `Intl` locale follow the provider; the service worker / PWA texts (`pwa/` 54 strings) use the stored
  locale.

### 4.3 How the language is chosen

| Moment                        | Source (first that exists)                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Signed in                     | `users.locale` (new column, `NULL` = not chosen) → workspace default (`tr`)                                                    |
| Sign-in, 2FA, SSO, enrol      | `localStorage['remyral.locale']` (last language used in this browser) → `navigator.languages` negotiated to `tr`/`en` → `tr`     |
| Server text without a session | `Accept-Language` negotiated to `tr`/`en` → `tr` (only the few pre-auth responses: login errors, OIDC callback, enrol page)      |
| E-mail, push, webhook, report | the **recipient's** `users.locale` → workspace default                                                                          |

- Migration: `ALTER TABLE users ADD COLUMN locale text NULL CHECK (locale IN ('tr','en'))`. `GET /auth/session` returns
  `locale`; `PUT /me/locale { locale }` (session + CSRF, no step-up, audited as `user.locale.change` when it changes; as built: `session.self`,
  `write` class, 1 KiB body). Profile (both
  shells) gets "Dil / Language". Changing it re-renders without reload.
- Chat watches: default the watch language to the user's locale; keep `guessLanguage` only as a fallback when the user
  never chose (behaviour unchanged for existing rows).
- The assistant's replies keep following the language the person writes in; its system prompt gets
  "default language: <locale>" so tool-card summaries and first replies match the UI.

### 4.4 Master returns codes and parameters, the client says the sentence

**Errors.** Keep the body backward compatible and add parameters:

```json
{ "error": "project_not_found", "message": "Project not found.", "params": { "project": "web" } }
```

- `HttpError` gets an optional `params: Readonly<Record<string, string | number | boolean | null>>` (client-safe
  primitives only — the same rule as `details`); `registerErrorHandling` sends `params` when non-empty. Because
  Fastify's serializer drops undeclared fields (`errors.ts:14-16`), a shared `ErrorResponse` schema with `params` is
  added to the OpenAPI components and referenced by every route's 4xx/5xx responses (one codemod over route schemas;
  contract test asserts it).
- `message` stays English: it is the API/CLI/log text, the fallback for unknown codes, and keeps the ~877 master test
  assertions valid.
- The 94 template messages are the ones that need `params` (e.g. size limits, names); the 442 literal ones need only a
  catalog entry for their code. Codes that today carry several different sentences (e.g. `invalid_job: inputs:not_allowed`
  in `reuse/routes.ts:103`) get a sub-code param (`params.reason`).
- Web: `ApiError` keeps `params`; one helper `errorText(t, err)` replaces the 45 verbatim `.message` renders in Diyalog
  and `toApiError`'s generic sentence. Unknown code ⇒ show `message` (today's behaviour) + a dev-only console warning.
- Guard: `scripts/i18n/check-catalogs.mjs` AST-scans `new HttpError(…, '<code>', …)` in `apps/master/src` and fails when
  a code has no `errors` entry in TR and EN (same idea as the `KNOWN_REASON_CODES` test).

**As built (Phase 3, p14-i18n-errors).** `HttpError` takes `params` as its sixth argument (bounded by
`boundedParams`: ≤ 12 primitive values, strings ≤ 300 characters); every route's error schema is the shared
`ErrorBodySchema` (69 local schemas replaced by a codemod; `test/integration/error-params.test.ts` walks the OpenAPI
document). Static analysis (`scripts/i18n/master-errors.mjs`) resolves 269 codes over the 596 sites — more than the 238
literal ones because conditionals, the union-typed `${what}_not_found` and codes passed to local helpers (`conflict(…)`,
`deny(…)`) count too; 29 sites pass a domain error class’s own `err.code` and stay dynamic. 246 sites now send params:
the template messages' values and a `params.reason` wherever one code carries several sentences (`not_found`,
`forbidden`, `rate_limited`, `unavailable`, `invalid_inputs`, `worker_update_required`, …). Instead of `errorText(t, err)`
the web has `errorText(t, locale, err)` and the hooks `useErrorText()` (Diyalog) / `useSharedErrorText()` (shared
modules; classic keeps `message`); 88 Diyalog renders of `toApiError(err).message` / `ApiError.message` (the 45 of §2.2
plus the `setError(…)` sites) now go through it. One rule was added while building: a body **without** params is
translated only when the English catalog sentence equals `message`, because domain errors reuse generic codes with
their own sentences (`conflict` + "This GitHub code was already used."); `check:i18n` keeps literal messages and the
English catalog in step. Of the English-matching translations, GitIdentity moved to protocol issue codes; the
policy-waits, MonitorFormDialog and Deploys matchers translate the classic console's own client-side validators (not
master errors) and move with their screens in Phase 5; `lib/reasons.ts` / `reasonsTr.ts` are Phase 4.

**Reasons.** `PlacementReason` already has `code`; add `params?: Record<string, string | number>` to the protocol
(additive, versioned) and to worker-reported reasons, so the web never parses `"code: message"` or regex-matches English
(`lib/reasons.ts`, `reasonsTr.ts`: `waitingUntil`, `cause: 'shared_refresh_race' | 'contention'`). `lib/reasons.ts` and
`reasonsTr.ts` merge into `@remyral/i18n` `reasons` (TR + EN), keeping "unknown code ⇒ raw text". Old workers keep
sending text; the parser stays as a fallback for one release.

**As built (Phase 4, p14-i18n-reasons).** `@remyral/protocol/reasons` (plain, no Zod — the console imports it):
`ReasonParams` (≤ 8 primitives, keys `^[a-z][a-zA-Z0-9_]{0,31}$`, strings ≤ 200), `boundedReasonParams`, and
`REASON_CAUSES` — the codes whose sentence depends on why they happened and their `params.cause` values:
`runtime_not_authenticated: login_wait` (scheduler, with `until`), `not_authenticated: no_job_auth |
job_auth_secret_ref` (master fleet view), `login_refresh_contention: run_again` (worker JOB_RESULT) and
`login_expired: shared_refresh_race` (only older workers' text). Every other code needs no params: the sentence names
the runtime and the machine from the screen's context. Producers: `PlacementReason.params` / `ReasonSummary.params`
(stored in `job_schedule_status.reasons`, sent by `GET /jobs/:id` `orchestration.schedule.reasons[].params`), the fleet
overview's `compatibility[].params`, and `JOB_RESULT.error.params` (additive; kept in `job_runs.result`, sent as
`orchestration.runs[].resultError { code, params }` — the failing transition keeps its `code: message` text and the
console matches it to its attempt's error). No migration. The catalog namespace `reasons` holds `codes` (a sentence
function of `ReasonVars { runtime, machine }`, or variants `default` + one per cause) and `actions` (fix labels);
`lib/reasons.ts` keeps only the fix targets and `describeReason(raw, ctx, { locale, params })`; `reasonsTr.ts` is gone.
`DyReason` and the shared `ReasonNotice` (`useDescribeReason` / `useSharedDescribeReason`) follow the user's language
in Diyalog; the classic console stays English; screen helpers that compose Turkish lines (job history, needs-you
rows, composer placement) say reasons in Turkish until their screen moves in Phase 5. The English regexes survive only
as `legacyReasonCause` (marked LEGACY in `lib/reasons.ts`), used when a reason carries no known cause — reasons from
older workers and the job history recorded before this release; remove it in the release after this one (Phase 9),
after which such old history rows read with the code's default sentence. `pnpm check:i18n` now fails when a scheduler
`REASON_CODES` entry (or `no_workers`) has no sentence, a REASON_CAUSES cause has no variant, a code has variants that
are not causes or no `default`, or a sentence does not take `ReasonVars`. Glossary fix on the way: the Turkish
"fazla eski bir worker" became "fazla eski bir sürüm", "dalları" became "branch’leri".

**Validation texts in shared code** (`packages/protocol` git identity, policy validators): return a problem code + params
instead of an English sentence; `identityProblemTr` and its prefix matching disappear.

**Assistant tool outcomes.** `ToolOutcome` failures get `{ code, params }` with a finer code set; `message` stays for
the model. Draft-card summaries already render from structured payloads in the web (`drafts/summary.ts`) — they move
to the catalog.

### 4.5 Notifications, e-mail, push, webhooks, weekly report

- Migration: `notifications` gains `template text NULL` and `params jsonb NULL` (size-capped, identifiers/enums/numbers
  only, redacted as today). Producers write `template = 'deploy.failed'`, `params = { project, state, … }` **and** keep
  writing English `title/body` (fallback, webhooks, old clients).
- In-app list (`GET /notifications`): the master renders `title/body` from `template + params` in the **viewer's**
  locale (one renderer in `@remyral/i18n`), so both shells and the PWA get finished text; rows without a template show
  the stored text.
- E-mail and Web Push render at send time in the recipient's locale (`smtp.ts` already RFC 2047-encodes non-ASCII
  subjects, `smtp.ts:123`). Webhook payloads add `kind`, `template`, `params` next to the rendered text in the workspace
  default locale.
- Weekly report and usage/budget/uptime/backup notices: `efficiency/text.ts` `localTime` uses `format.ts` with the
  recipient's locale and the existing time zone; report sections become templates.
- Fix the mixed sentences now embedded in bodies (`producers.ts:206,263`): the button names come from the same catalog
  as the buttons.

### 4.6 Dates, numbers, plurals in code

- Only `@remyral/i18n/format` may call `toLocale{,Date,Time}String`, `new Intl.DateTimeFormat|NumberFormat|RelativeTimeFormat`
  for display (ESLint `no-restricted-syntax` / `no-restricted-properties`, built into ESLint — no new dependency;
  `toLocaleLowerCase/UpperCase` stays allowed for search folding).
- Replace the ~168 formatting call sites and the duplicated helpers (`formatBytes` ×6, `timeAgoTr`, `whenTr`, `agoText`,
  `since`, `relativeTime`, …).
- English plurals through `Intl.PluralRules('en')` inside EN functions (replaces the 28 `'' : 's'` ternaries once a
  string is moved); Turkish messages take the count without inflecting the noun.

## 5. Terminology glossary (proposal)

> **As decided (ADR-0053, [i18n-glossary.md](i18n-glossary.md)):** decision 3 keeps version-control terms English, so
> the measured "dal" / "branch" drift resolves to **branch** (the table below proposed "dal"); the rest as proposed.

Rule: a term is translated when everyday Turkish has a clear word the team already uses; product/tool names and
established developer loanwords stay English and take Turkish suffixes with an apostrophe (`runtime’lar`, `deploy’u`).
Counts are today's occurrences in Diyalog copy.

| Concept                 | TR (UI)                                  | EN (UI)              | Notes                                                                                          |
| ----------------------- | ---------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| job                     | **iş** / İşler                           | job / Jobs           | 647 uses; nav must say "İşler"                                                                 |
| worker / machine        | **makine** / Makineler                   | machine / Machines   | "worker" only in CLI/package names (`remyral-worker`); fix `reasonsTr.ts:39` "eski bir worker"  |
| needs you (approvals)   | **Senden bekleyenler** · onay            | Needs you · approval | `ops/NeedsSummary.tsx:312` already says "Senden bekleyen"                                       |
| chat / assistant        | sohbet / asistan                         | chat / assistant     |                                                                                                |
| workflow                | **workflow** (Workflow’lar)              | workflow             | keep English (nav, editor); replace the 35 "iş akışı"                                           |
| runtime                 | **runtime**                              | runtime              | 299 uses; product names Claude Code, Codex, Pi, OpenCode never translated                     |
| deploy                  | **deploy** (noun & "deploy et")          | deploy               | Coolify deployments; **yayınla** only for static-site / Pages publishing (a separate feature)  |
| output                  | çıktı / Çıktılar                         | output / Outputs     |                                                                                                |
| usage                   | kullanım / Kullanım                      | usage / Usage        |                                                                                                |
| project / workspace     | proje / çalışma alanı                    | project / workspace  |                                                                                                |
| settings                | Ayarlar                                  | Settings             |                                                                                                |
| automation / template   | otomasyon / şablon                       | automation / template |                                                                                               |
| branch / commit / PR / merge | dal / commit / pull request (PR) / birleştirme | branch / commit / pull request / merge | "dal" 83 vs "branch" 15 → dal                                |
| credential / vault      | kimlik bilgisi / kasa                    | credential / vault   |                                                                                                |
| sandbox / token / model / checkpoint / slot / limit | unchanged loanwords | same      |                                                                                                |
| skill                   | **yetenek**                              | skill                | 21 vs 12                                                                                       |
| memory / knowledge      | hafıza / bilgi                           | memory / knowledge   |                                                                                                |
| quota / budget          | kota / bütçe                             | quota / budget       |                                                                                                |
| preview                 | önizleme                                 | preview              |                                                                                                |
| login / session         | giriş / oturum                           | sign-in / session    |                                                                                                |

The glossary becomes `packages/i18n/GLOSSARY.md`-equivalent data (`glossary.ts`) that the catalog check uses to warn on
banned variants (e.g. "iş akışı", "branch" in TR copy).

## 6. Phases

Sizes: S < 1 day, M 1–3 days, L 3–6 days, XL > 1 week of agent work (parallelisable by screen). Order is the order
below; Phase 1 can ship as a hotfix before anything else.

| #   | Phase                                   | Scope                                                                                                                                                                                                                                         | Size | Risk   | Depends on |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------ | ---------- |
| 0   | Decisions + foundation                  | ADR; glossary; `packages/i18n` (locale, format, translator, tr/en skeleton); `I18nProvider`; `users.locale` + `/auth/session` + `PUT /me/locale` + Profile switch; inventory script, ratchet baseline, catalog check in `pnpm verify`        | M    | low    | §9         |
| 1   | Quick win: Diyalog sidebar              | `DiyalogShell.tsx` nav labels → glossary Turkish (İşler, Makineler, Çıktılar, Kullanım, Projeler, Ayarlar, Senden bekleyenler); ~8 test files                                                                                                 | S    | low    | glossary   |
| 2   | Diyalog shell & shared chrome           | rail, top bar, bell, account menu, palette, shortcuts, auth screens, `common/*`, `components/ui` texts, `api/client` texts, classic chat parts rendered in Diyalog (`Messages`, `Attachments`, `JobActionParts`); dates/numbers via `format` | M    | low    | 0          |
| 3   | Master error codes + params             | `HttpError.params`, shared `ErrorResponse` schema, `ApiError.params`, `errors` catalog for 238 codes (TR+EN), `errorText()`, replace 45 verbatim renders, remove English text matching (GitIdentity, policy-waits, MonitorFormDialog, Deploys) | L    | medium | 0          |
| 4   | Reasons with params                     | protocol `params` on reasons (additive), scheduler + worker emit them (worker release), merge `lib/reasons.ts` + `reasonsTr.ts` into the catalog, drop English regexes; old-worker text fallback for one release                             | M    | medium | 0, 3       |
| 5   | Diyalog screens                         | move the ~6,800 unique Diyalog texts into namespaces screen by screen (job, chat/ops/drafts, machines, projects, settings, usage, automations, workflows, outputs, knowledge, deploys, uptime, templates, approvals, composer, jobs), **TR verbatim**, then EN; delete the 69 `…Tr` shims; glossary fixes | XL   | low per screen, volume | 2     |
| 6   | Notifications, e-mail, push, reports    | `notifications.template/params` migration, producer templates (27 kinds), render per viewer/recipient, webhook fields, weekly report locale, fix mixed bodies                                                                                  | L    | medium | 0, 3       |
| 7   | Assistant & audit                       | tool-outcome codes, assistant UI strings, watch language from user locale, prompt language hint, audit action labels via catalog                                                                                                             | M    | low    | 5          |
| 8   | Classic                                 | **recommended: no translation.** Wrap in `I18nProvider locale="en"`; fix the Turkish leaks through the catalog; freeze; retire with the classic UI                                                                                            | S    | low    | 2          |
| 9   | Verification & docs                     | e2e smoke in both locales, owner EN/TR review pass, presentation + docs + changelog, remove fallbacks scheduled for removal                                                                                                                  | M    | low    | all        |

Translating the classic UI instead (Phase 8 alternative) would be ~5,300 unique strings plus ~2,000 classic test queries
for a UI that is removed after one release — not recommended.

## 7. Guards

### 7.1 No new hard-coded strings in Diyalog

- A local ESLint rule (`eslint-rules/no-ui-literals.js`, registered as an inline plugin in `eslint.config.js`; no new
  package) for `apps/web/src/diyalog/**`: reports JSX text with letters and string literals in text attributes
  (`aria-label`, `title`, `placeholder`, `label`, `alt`, `hint`, `description`, `legend`, `aria-description`) and in
  `setError(…)` / `onDone(…)` calls. Allowed: glossary-neutral names (from `glossary.ts`), punctuation, `// i18n-ignore`
  with a reason.
- **Ratchet** while Phase 5 runs: `scripts/i18n/inventory.mjs --check` compares per-file literal counts with
  `scripts/i18n/baseline.json`; a count may only go down. The rule switches from ratchet to hard error per directory as
  each screen is migrated.

### 7.2 Catalog parity (CI)

- Compile time: `en/*` `satisfies` the shape of `tr/*` → a missing/extra key or a parameter mismatch fails
  `pnpm typecheck`.
- `pnpm check:i18n` (added to `verify`): same keys in both catalogs, no empty strings, `{placeholders}` identical, EN not
  identical to TR unless allow-listed (catches untranslated copies), every master `HttpError` code, every `REASON_CODES`
  entry, every notification `template` and audit action has TR and EN entries, glossary banned variants.

## 8. Test strategy

- **Move, don't reword.** Phase 5 moves Turkish strings to the TR catalog verbatim, so the 2,070 Diyalog text queries
  keep passing; rewording (glossary fixes) happens in separate, small commits that update the matching tests.
- Test render helper `renderWithI18n(ui, { locale = 'tr' })`; Diyalog tests default to TR, classic tests to EN — no
  change for the 1,994 classic queries.
- Per migrated screen one EN smoke test (renders, no TR fallback, no missing-key warning). E2E: the 232 queries stay in
  TR; one extra Playwright project runs the main flows in EN.
- Master: existing `message` assertions unchanged; new tests assert `error` + `params`, notification `template` +
  `params`, and rendering in both locales (e-mail subject with Turkish letters, push body caps).
- Contract test: every route's error response schema includes `params` (else the serializer would drop it).

## 9. Open decisions for the owner

1. **Classic UI language** — leave it English (frozen, retired next release) or translate? **Recommended: leave
   English**, fix only the Turkish leaks.
2. **Language selection** — **Recommended:** per-user setting stored on the master, default Turkish for everyone; before
   sign-in the browser's last choice, else the browser language, else Turkish.
3. **Loanwords** — keep runtime, workflow, deploy, sandbox, token, commit, checkpoint in English inside Turkish copy (as
   in §5) or translate them? **Recommended: keep** (matches today's usage and the tools' own UIs).
4. **Library** — typed catalog without a dependency, or react-intl? **Recommended: typed catalog** (§3).

## 10. Risks

| Risk                                                                                      | Mitigation                                                                                                     |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A feature or a message is lost while moving strings (parity rule)                         | move verbatim; ratchet; per-screen parity checklist from `p12-diyalog-parity-inventory.md`; tests unchanged    |
| `params` silently dropped by route response schemas                                       | shared `ErrorResponse` schema + contract test                                                                  |
| Untrusted values in params (worker names, repo paths)                                     | primitives only, length caps, existing redaction; rendered as text only                                        |
| Old workers / stored notifications without codes                                          | text fallbacks kept for one release; old notification rows show stored text                                   |
| EN copy quality (the team works in Turkish)                                               | EN written from the existing classic copy where a classic twin exists; owner review in Phase 9                 |
| Bundle growth from a second language                                                      | EN lazy-loaded; TR size ≈ today's literals                                                                     |
| Turkish suffix errors after interpolated names                                            | keep the "X makinesinde" pattern; helper with tests for apostrophe + vowel harmony when unavoidable            |
| Large parallel Phase 5 conflicts                                                          | one namespace file per screen; agents own disjoint directories                                                 |

## 11. Rollback

Each phase is additive: catalogs and the provider can be removed by reverting the screen commits; the error body keeps
`message`, notifications keep `title/body`, reasons keep text, so clients and old workers work at every step. The
`users.locale` and `notifications.template/params` columns are nullable and unused when rolled back.
