# p12-diyalog — page-by-page visual tour (p12-diyalog-default)

Owner decision 2026-10-20: "Diyalog'ta tüm sayfalar teker teker gezilmeli ve gereksiz kaymalar, boşluklar varsa
düzenlenmeli." Every Diyalog route was opened in the visual harness (`apps/web/diyalog-harness.html`, fixture API,
dev server only) at **1440, 1024, 768 and 400 px**, **light and dark**, with every fixture answer delayed 500 ms
(`&delay=500`, added for this tour) so loading states and the skeleton → data change are visible.

## Method

- **Routes:** 113 harness entries — every route of `diyalog/screens/routes.tsx`, the Home / Sohbet / job screens of
  `DiyalogShell.tsx`, every tab (`?tab=` / `?view=`), detail pages with fixture ids, new / edit forms, the sign-in steps
  (`&auth=…`), step-up (`&stepup=1`), NotFound, SSO continue, the classic frame (`?gorunum=klasik`) and three opened
  overlays (Tümü dialog, account menu, notification bell).
- **Measured per route × width × theme** (Playwright, system Chrome): cumulative layout shift from a
  `PerformanceObserver('layout-shift')` with the shifted nodes, horizontal page overflow, elements crossing the right
  edge outside a scroll container, nested vertical scroll containers taller than 160 px (double scrollbars), page
  errors; plus a full-page screenshot. Screenshots were taken before and after the change, in light and dark (the
  dark "after" run covers 1440 px only — layout does not depend on the theme, the dark "before" column below shows the
  same shifts); they were working files and are not kept in the repository.
- **Found everywhere:** no horizontal overflow, no element past the right edge, no page error at any width. The only
  nested scroll containers are intentional (the job activity log box `dy-log-box`, 62 dvh, and the uptime check log).
- **Layout shift** (CLS, lower is better; < 0.1 is "good") is the main finding: panels that load separately were drawn
  in an order where a later, taller arrival pushed content the reader was already looking at.

## Shell-wide fixes

| Issue | Fix |
| --- | --- |
| Rail clock appeared ~1 s after load and pushed the rail's bottom group (Settings, Tümü, keyboard) up by 35 px on every screen | `RailClock` keeps an invisible slot of its size until the first server sync |
| New "Klasik görünüm" switch: a bordered box on phones crowded the bar; in Sohbet (list, details, menu buttons) it pushed the tools to a second row | quiet text button below 640 px (bordered from 640 px); hidden in the Sohbet bar below 640 px, where the account menu has "Klasik görünüme geç" |
| ScreenFrame facts (chips under the title) appeared after load and pushed the page | `facts={null}` = loading: the row keeps its height |
| An empty line inside a padded panel padded itself again (text 16 px in from the panel text, tall gap below) | `Panel` cancels `EmptyLine`'s own padding inside padded panels |
| Four stat tiles left a lone fourth tile under three at 768 px (auto-fit grid) | `StatTiles`: 4 tiles 2 × 2 until all four fit (lg), 3 tiles one row from 640 px |
| "workspace dışı" mark on approval effects was cut off with the long path on phones | path truncates, the mark never does |

## Route × width checklist (CLS light before → after; dark before; what was found and fixed)

Cells show one number when unchanged. Residuals ≥ 0.1 are listed with their cause; Settings → Integrations and the
project Deploy tab were left to the parallel p13-multi-coolify agent (their structure is theirs) and re-checked after
merging main.

| Route (harness `?path=`) | 1440 | 1024 | 768 | 400 | Dark (before) | Issues found → fixed |
| --- | --- | --- | --- | --- | --- | --- |
| home | 0.77 → 0.00 | 0.60 → 0.01 | 0.70 → 0.03 | 0.73 → 0.09 | max 1.10 | decisions grew from 2 thin rows to ~1370 px and pushed every panel down → card-sized placeholders; panels drawn once both decision sources are in |
| home-all-dialog | 0.77 → 0.00 | 0.60 → 0.00 | 1.08 → 0.03 | 0.73 → 0.17 | max 1.10 | as home (dialog itself fine) |
| home-account-menu | 0.77 → 0.00 | 0.60 → 0.00 | 1.08 → 0.03 | 0.73 → 0.09 | max 0.77 | as home; menu gained "Klasik görünüme geç" + "Bu ekranı klasik görünümde aç" |
| home-bell | 0.62 → 0.00 | 0.60 → 0.00 | 1.08 → 0.03 | 0.73 → 0.09 | max 1.10 | as home |
| chat | 0.03 → 0.02 | 0.05 → 0.03 | 0.02 → 0.01 | 0.12 → 0.09 | max 0.12 | group sections said "Yükleniyor…" (1 line) then grew → one placeholder per known conversation |
| chat-thread-main | 0.03 → 0.02 | 0.05 → 0.04 | 0.01 → 0.02 | 0.06 → 0.05 | max 0.07 | as chat |
| chat-thread-pinned | 0.04 → 0.02 | 0.07 → 0.03 | 0.04 → 0.00 | 0.22 → 0.05 | max 0.27 | as chat + knowledge strip appeared above the thread → its height is reserved until the details are read |
| chat-thread-empty | 0.04 → 0.02 | 0.07 → 0.03 | 0.04 → 0.00 | 0.22 → 0.05 | max 0.22 | as chat-thread-pinned |
| chat-thread-archived | 0.04 → 0.02 | 0.07 → 0.03 | 0.04 → 0.00 | 0.24 → 0.05 | max 0.24 | as chat-thread-pinned |
| job-thread | 0.06 → 0.04 | 0.10 → 0.05 | 0.39 → 0.00 | 0.29 → 0.00 | max 0.40 | approval card placeholder 6 rem vs ~41 rem real → sized per layout (41 rem side column / phones, 33 rem 768–1023) |
| job-details-files | 0.00 | 0.00 | 0.18 → 0.00 | 0.00 | max 0.18 | header facts wrapped to a 2nd line at 640–1023 px when checkpoint / memory landed → 2 lines reserved there |
| job-details-logs | 0.00 | 0.00 | 0.18 → 0.00 | 0.00 | max 0.18 | as job-details-files |
| job-details-history | 0.00 | 0.00 | 0.18 → 0.00 | 0.00 | max 0.18 | as job-details-files |
| job-details-record | 0.00 | 0.01 → 0.03 | 0.19 → 0.01 | 0.00 | max 0.19 | as job-details-files |
| job-details-approvals | 0.00 | 0.00 | 0.18 → 0.00 | 0.00 | max 0.18 | as job-details-files |
| jobs | 0.00 | 0.00 | 0.01 | 0.00 | max 0.01 | optional workflow-runs panel above the list pushed it ~200 px (pre-tour smoke: 0.09 @1440, 0.15 @400; fixed before the full run) → moved under the list, drawn after the list |
| jobs-queue | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| jobs-failed | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| jobs-today | 0.00 | 0.00 | 0.01 | 0.00 | max 0.01 | no shift ≥ 0.05, no overflow, no double scrollbar |
| jobs-new | 0.01 | 0.02 | 0.05 | 0.03 | max 0.05 | no shift ≥ 0.05, no overflow, no double scrollbar |
| workflow-run | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| templates | 0.13 → 0.00 | 0.25 → 0.00 | 0.26 → 0.00 | 0.38 → 0.00 | max 0.39 | optional suggestions above the list → moved under the list |
| template-new | 0.00 | 0.00 | 0.00 | 0.01 → 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| template-detail-run | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| template-detail-prompt | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| template-detail-versions | 0.00 | 0.00 | 0.05 | 0.05 | max 0.05 | no shift ≥ 0.05, no overflow, no double scrollbar |
| template-edit | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| machines-list | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| machines-map | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| machines-compat | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| machines-add | 0.04 → 0.03 | 0.08 → 0.06 | 0.11 → 0.08 | 0.17 → 0.00 | max 0.17 | install packages placeholder 2 → 6 rows |
| machine-w1-overview | 0.24 → 0.02 | 0.44 → 0.03 | 0.59 → 0.02 | 0.74 → 0.00 | max 0.72 | four reads one after another (attention, slots, facts appeared in turn) → read together, one render |
| machine-w1-runtimes | 0.00 | 0.00 | 0.00 | 0.01 | max 0.01 | no shift ≥ 0.05, no overflow, no double scrollbar |
| machine-w1-tools | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| machine-w1-sandbox | 0.09 → 0.00 | 0.13 → 0.01 | 0.15 → 0.01 | 0.28 → 0.00 | max 0.29 | sandbox placeholder 3 rows vs a long profile list → 12 rows |
| machine-w1-configuration | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| machine-w1-admin | 0.01 | 0.01 | 0.01 | 0.00 | max 0.01 | no shift ≥ 0.05, no overflow, no double scrollbar |
| machine-w1-activity | 0.01 | 0.02 | 0.02 | 0.05 | max 0.06 | no shift ≥ 0.05, no overflow, no double scrollbar |
| machine-w4-offline | 0.08 → 0.05 | 0.18 → 0.11 | 0.19 → 0.11 | 0.20 → 0.14 | max 0.22 | same read waterfall fixed; residual: capacity / caches panels load separately (below the fold at 1440) |
| machine-w6-pending | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| projects | 0.01 | 0.02 | 0.02 | 0.05 | max 0.05 | no shift ≥ 0.05, no overflow, no double scrollbar |
| project-mobil-overview | 0.22 → 0.00 | 0.35 → 0.00 | 0.42 → 0.00 | 0.54 → 0.00 | max 0.54 | "Senden bekleyenler" arrived after the panels → panels wait for it (two quick reads), one placeholder meanwhile |
| project-mobil-repository | 0.02 | 0.03 | 0.04 | 0.06 | max 0.06 | no shift ≥ 0.05, no overflow, no double scrollbar |
| project-mobil-machines | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| project-mobil-policy | 0.20 → 0.01 | 0.34 → 0.02 | 0.44 → 0.03 | 0.38 → 0.04 | max 0.44 | execution policy placeholder 2 → 8 rows (LoadState rows prop) |
| project-mobil-deploy | 0.03 | 0.05 | 0.05 | 0.09 | max 0.09 | not touched: deploy target editor belongs to p13-multi-coolify |
| project-mobil-memory | 0.18 → 0.08 | 0.25 → 0.12 | 0.24 → 0.16 | 0.04 → 0.00 | max 0.25 | records placeholder 3 → 5 rows (8 over-shot on /context, reverted to 5); residual ≤ 0.16 at 768 (conflicts / suggestions load separately) |
| project-mobil-members | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| project-arastirma-workspace | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| project-missing | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| outputs-all | 0.00 | 0.00 | 0.06 | 0.03 | max 0.06 | no shift ≥ 0.05, no overflow, no double scrollbar |
| outputs-sites | 0.00 | 0.00 | 0.06 | 0.03 | max 0.06 | no shift ≥ 0.05, no overflow, no double scrollbar |
| outputs-files | 0.00 | 0.00 | 0.06 | 0.03 | max 0.06 | no shift ≥ 0.05, no overflow, no double scrollbar |
| outputs-notes | 0.00 | 0.00 | 0.06 | 0.03 | max 0.06 | no shift ≥ 0.05, no overflow, no double scrollbar |
| usage-dashboard | 0.01 | 0.00 | 0.00 | 0.00 | max 0.01 | 4 stat tiles left a lone 4th tile under three at 768 px → 2 × 2 until 4 fit (StatTiles) |
| usage-suggestions | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| usage-reports | 0.02 | 0.04 | 0.03 | 0.08 | max 0.08 | no shift ≥ 0.05, no overflow, no double scrollbar |
| usage-overview | 0.00 | 0.00 | 0.00 | 0.03 | max 0.03 | no shift ≥ 0.05, no overflow, no double scrollbar |
| usage-outcomes | 0.10 | 0.15 | 0.17 | 0.19 | max 0.19 | residual (matrix header text changes on load, ≤ 0.2) |
| usage-prices | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| usage-budgets | 0.07 → 0.05 | 0.10 → 0.07 | 0.13 → 0.10 | 0.19 → 0.10 | max 0.20 | budgets placeholder 2 → 5 rows; residual below the fold |
| usage-enforcement | 0.26 → 0.15 | 0.24 → 0.10 | 0.47 → 0.28 | 0.46 → 0.25 | max 0.48 | "Sınıra yakın" panel appeared from nothing, limit windows 2-row placeholder → panel frame + skeleton, 4 rows; residual: nested reads |
| usage-report-r41 | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| uptime | 0.04 → 0.00 | 0.07 → 0.00 | 0.07 → 0.00 | 0.17 → 0.04 | max 0.19 | status summary appeared after the list → drawn from the start with "—" |
| uptime-m1 | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| uptime-m3 | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| automations | 0.04 → 0.02 | 0.06 → 0.04 | 0.08 → 0.05 | 0.10 → 0.06 | max 0.10 | facts row appeared after load → ScreenFrame keeps the facts row (facts={null} = pending); residual: project select |
| automations-new | 0.00 | 0.00 | 0.01 | 0.00 | max 0.01 | no shift ≥ 0.05, no overflow, no double scrollbar |
| automation-au1-overview | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| automation-au1-runs | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| automation-au1-trigger | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| automation-au1-settings | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| automation-au2-webhook | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| automation-au4-chain | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| automation-au1-edit | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| approvals-pending | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| approvals-decided | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| approval-cmd | 0.00 | 0.00 | 0.00 | 0.01 | max 0.01 | no shift ≥ 0.05, no overflow, no double scrollbar |
| approval-gate | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| approval-paused | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| approval-done | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| deploys | 0.01 | 0.01 → 0.02 | 0.01 → 0.02 | 0.04 | max 0.04 | no shift ≥ 0.05, no overflow, no double scrollbar |
| deploy-waiting | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| deploy-ok-pages | 0.00 | 0.00 | 0.00 | 0.02 | max 0.02 | no shift ≥ 0.05, no overflow, no double scrollbar |
| deploy-coolify | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| deploy-failed | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| skills | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| context | 0.03 → 0.06 | 0.05 → 0.07 | 0.13 → 0.16 | 0.11 → 0.12 | max 0.13 | residual: global conflicts / documents load separately below the records (≤ 0.2 at 768) |
| audit | 0.01 | 0.00 | 0.01 | 0.00 | max 0.01 | no shift ≥ 0.05, no overflow, no double scrollbar |
| settings-profile | 0.00 | 0.00 | 0.02 | 0.00 | max 0.02 | empty line inside a padded panel padded itself again → no double padding (Panel / EmptyLine) |
| settings-devices | 0.08 → 0.00 | 0.13 → 0.00 | 0.13 → 0.01 | 0.22 → 0.02 | max 0.22 | push devices list above trusted devices + 1-line "Denetleniyor…" → list moved last, check holds the answer's height |
| settings-runtimes | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| settings-models | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| settings-credentials | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| settings-integrations | 0.09 → 0.10 | 0.13 | 0.23 | 0.40 | max 0.18 | not touched: Settings → Integrations belongs to the parallel p13-multi-coolify agent |
| settings-chat | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| settings-users | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| settings-releases | 0.00 | 0.00 | 0.00 | 0.04 | max 0.04 | no shift ≥ 0.05, no overflow, no double scrollbar |
| settings-backups | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| settings-context | 0.03 → 0.04 | 0.04 → 0.06 | 0.03 → 0.05 | 0.09 | max 0.09 | as context |
| settings-notifications | 0.00 | 0.00 | 0.01 | 0.00 | max 0.01 | no shift ≥ 0.05, no overflow, no double scrollbar |
| classic-frame-jobs | 0.10 | 0.10 | 0.11 | 0.14 | max 0.14 | classic page inside the Diyalog shell (classic code, unchanged by design) |
| not-found | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| sso-coolify | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| auth-checking | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| auth-signed-out | 0.01 | 0.01 | 0.02 | 0.01 | max 0.02 | no shift ≥ 0.05, no overflow, no double scrollbar |
| auth-totp | 0.01 | 0.01 | 0.02 | 0.03 | max 0.03 | no shift ≥ 0.05, no overflow, no double scrollbar |
| auth-recovery | 0.01 | 0.01 | 0.02 | 0.02 | max 0.02 | no shift ≥ 0.05, no overflow, no double scrollbar |
| auth-enroll | 0.00 | 0.01 | 0.01 | 0.00 | max 0.01 | no shift ≥ 0.05, no overflow, no double scrollbar |
| auth-codes | 0.00 | 0.00 | 0.00 | 0.01 | max 0.01 | no shift ≥ 0.05, no overflow, no double scrollbar |
| auth-password | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |
| stepup | 0.77 → 0.00 | 1.04 → 0.00 | 0.70 → 0.03 | 0.71 → 0.09 | max 1.05 | as home (dialog over Home) |
| stepup-on-approvals | 0.00 | 0.00 | 0.00 | 0.00 | max 0.00 | no shift ≥ 0.05, no overflow, no double scrollbar |

## Tests

`apps/web/test/diyalog-layout-stability.test.tsx` pins the structure behind the fixes (jsdom has no layout): Home draws
card-sized decision placeholders and no panels until the decisions are in; Jobs puts workflow runs after the list and
asks for them once the list is drawn; Uptime shows its summary ("—", disabled) from the start; the rail clock keeps its
slot before the first sync; ScreenFrame keeps a pending facts row; a job approval card holds an approval card's height
while it is read. Re-run the tour with the harness dev server and `&delay=500` on any route.

## After merging main (p13-multi-coolify, p13-fleet-tools, p13-workflows-ui, p12-diyalog-cmdk)

Re-checked Settings → Integrations (Coolify connections) and the project Deploy tab at 1440 / 400 px: they render
with the shared Panel / empty-line / header changes, no overflow. New Diyalog-only screens get the whole-UI switch
too; switching to classic from `/machines/tools` opens the classic Machines page and from `/workflows…` the classic
Jobs page (`classicPath`, no classic page of their own); the per-screen classic link of the fleet tools screen opens
`/machines?gorunum=klasik`, and workflow screens (`classicView={false}`) do not offer one.
