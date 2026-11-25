# i18n glossary — Turkish and English UI terms

- **Status:** accepted with ADR-0053 (2026-10-20). Data twin: `packages/i18n/src/glossary.ts` (keep both in step;
  `pnpm check:i18n` fails when Turkish catalog copy uses an "avoid" word).
- **Rule (owner decision 3, 2026-10-20):** technical terms and product names stay English inside Turkish copy and take
  Turkish suffixes after a typographic apostrophe (`runtime’lar`, `deploy’u`, `branch’e`, `Workflow’lar`). Everything
  else uses the everyday Turkish word the team already uses. Names the UI does not control (machines, projects,
  repos) take suffixes through `withSuffix` ("mac-1’de") or, better, the "X makinesinde" pattern.

## Kept in English

| Concept          | TR (UI)                    | EN (UI)        | Avoid in Turkish copy        | Note                                                                       |
| ---------------- | -------------------------- | -------------- | ---------------------------- | -------------------------------------------------------------------------- |
| runtime          | runtime                    | runtime        | çalışma ortamı               | product names Claude Code, Codex, Pi, OpenCode are never translated        |
| workflow         | workflow (Workflow’lar)    | workflow       | iş akışı                     | measured 37 "workflow" vs 35 "iş akışı" → workflow                         |
| deploy           | deploy (noun, "deploy et") | deploy         | dağıtım                      | **yayınla** only for static-site / Pages publishing (a separate feature)   |
| sandbox          | sandbox                    | sandbox        | korumalı alan                |                                                                            |
| token            | token                      | token          | jeton                        |                                                                            |
| commit           | commit                     | commit         | işleme                       |                                                                            |
| checkpoint       | checkpoint                 | checkpoint     | kontrol noktası              |                                                                            |
| branch           | branch                     | branch         | dal                          | measured 83 "dal" vs 15 "branch"; decision 3 (git terms stay English) wins |
| pull request     | pull request (PR)          | pull request   |                              |                                                                            |
| model, slot, limit | model, slot, limit       | same           |                              |                                                                            |
| products         | Claude Code, Codex, Pi, OpenCode, Coolify, Remyral, Diyalog | same |             |                                                                            |

## Translated

| Concept               | TR (UI)                     | EN (UI)              | Avoid in Turkish copy | Note                                                    |
| --------------------- | --------------------------- | -------------------- | --------------------- | ------------------------------------------------------- |
| job                   | iş / İşler                  | job / Jobs           |                       | the rail says "İşler"                                   |
| worker / machine      | makine / Makineler          | machine / Machines   | worker                | "worker" only in CLI and package names (remyral-worker)  |
| needs you             | Senden bekleyenler          | Needs you            |                       |                                                         |
| approval              | onay                        | approval             |                       |                                                         |
| chat / assistant      | sohbet / asistan            | chat / assistant     |                       |                                                         |
| output                | çıktı / Çıktılar            | output / Outputs     |                       |                                                         |
| usage                 | kullanım / Kullanım         | usage / Usage        |                       |                                                         |
| project / workspace   | proje / çalışma alanı       | project / workspace  |                       |                                                         |
| settings              | Ayarlar                     | Settings             |                       |                                                         |
| automation / template | otomasyon / şablon          | automation / template |                      |                                                         |
| merge                 | birleştirme / birleştir     | merge                |                       |                                                         |
| credential            | kimlik bilgisi              | credential           | credential            |                                                         |
| vault                 | kasa                        | vault                | vault                 |                                                         |
| skill                 | yetenek                     | skill                | beceri, skill         | the palette's "Beceriler" moves to "Yetenekler" in Phase 5 |
| memory / knowledge    | hafıza / bilgi              | memory / knowledge   |                       |                                                         |
| quota / budget        | kota / bütçe                | quota / budget       |                       |                                                         |
| preview               | önizleme                    | preview              |                       |                                                         |
| sign-in / session     | giriş / oturum              | sign-in / session    |                       |                                                         |
| language              | dil                         | language             |                       | the Profile label is bilingual: "Dil / Language"        |

Existing Diyalog copy that still uses an "avoid" word (e.g. "iş akışı" in the automation forms, "dal") is reworded in
small separate commits during Phase 5, together with the tests that query it — never while moving strings verbatim.

**Style (owner, 2026-10-24):** no circumflex in Turkish copy — "yapay zeka", "hala", "kağıt", "resmi", never the
hatted forms. `pnpm check:i18n` fails on â / î / û in the TR catalogs. The product name is "Remyral" alone; its suffixes:
Remyral’ın, Remyral’a, Remyral’ı, Remyral’da, Remyral’dan, Remyral’la.
