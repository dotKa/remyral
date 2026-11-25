# p14-diyalog-polish-2 — Diyalog UI/UX, round 2

Owner request (2026-10-21): "ui/ux açısından diyalog temasını da iyileştirmemiz lazım." Round 1
([p14-diyalog-polish.md](p14-diyalog-polish.md), health 14 → 16/20) made the theme compliant: contrast, focus,
hover / press, rail labels, type outliers. Round 2 aims at a visibly better product. It changes hierarchy and layout,
gives the dark theme its own elevation and moves motion into one budget. It works inside the existing language
([p12-diyalog.md](p12-diyalog.md) §3 tokens, §17 motion): no new look, no copy change, no feature removed. Web only:
no endpoint, no migration, no worker release.

Coordination: other agents work in parallel on the workflow editor (14.4 / 14.5) and on Yetenekler → Keşfet (MCP P5).
This pass therefore changes tokens (`diyalog.css`, `motion.css`), shared parts (`ScreenFrame`, `parts.tsx`,
`notices.tsx`, `DyDialog`) and screen layout wrappers. It does not touch the editor internals
(`screens/workflows/WorkflowEditor.tsx`, `TextPanel.tsx`), the Keşfet tab, routing, lazy loading or data fetching.

## 1. Method

- **Where it ran.** The p12 visual harness (`apps/web/diyalog-harness.html?view=shell&path=…`, dev server only). This
  is the real signed-in app over the fixture API that the screen tests use, so it shows more states than the dev
  seed: approvals of every risk, a pairing request, limits near and at the limit, failed jobs, outputs of every kind.
- **Tour script (new).** `apps/web/scripts/diyalog-tour.mjs <out> [screen …]` captures 13 screens at **1440 × 900**
  and **390 × 844**, light and dark, as WebP (quality 55). The screens are home, chat, approvals, jobs, job,
  workflows, editor, machines, outputs, usage, projects, settings and skills. Each set is 52 shots, about 1.6 MB.
  Shots are in `p14-diyalog-polish-2/before/` and
  `p14-diyalog-polish-2/after/`, named `<screen>-<desk|phone>-<light|dark>.webp`.
- **Critique.** The critique followed the Impeccable method with two isolated assessments, then a synthesis:
  - **A, design review:** screenshots and source, Nielsen heuristics, cognitive load, per-screen notes, dark theme
    and motion inventory.
  - **B, detector and census:** the `detect.mjs` rules, plus a mechanical census of radii, type sizes, shadows,
    off-token colours, borders, motion and state components.
  - **Rules:** Emil Kowalski's motion rules (`emil-design-eng`) set the motion budget.

## 2. Audit (before)

### 2.1 Scores

Assessment A scored the Nielsen heuristics at **28 / 40**.

| # | Heuristic | Score | Key issue |
| --- | --- | --- | --- |
| 1 | Visibility of system status | 3 | Live dot, countdowns and the stepper are good. List changes and notices snap in. |
| 2 | Match with the real world | 3 | English leaks: limit windows "5h / weekly / Read … ago", "Choose Files", `mm/dd/yyyy` |
| 3 | User control | 3 | Back links and dialogs are fine. İşler filters need "Uygula". |
| 4 | Consistency | 2 | About 20 radii, three h1 scales, filters placed differently per screen, a teal "Yeni sohbet" among ink primaries |
| 5 | Error prevention | 3 | Code-required decisions, risk pills, "workspace dışı" |
| 6 | Recognition over recall | 3 | Labelled rail, filter chips, slash chips |
| 7 | Flexibility | 3 | ⌘K, j / k, a / d |
| 8 | Aesthetic and minimal design | 2 | Cards in cards, the page title three times, a teal link repeated on every row |
| 9 | Error recovery | 3 | `ErrorLine` with retry |
| 10 | Help | 3 | Purpose lines, sometimes too long on phones |

**Detector.** `detect.mjs` is clean (exit 0, `[]`), also raw with every config switch off. Its rules (gradient
text, glass, side stripes, …) do not fire. The problems are systemic and live in the tokens:

- About 20 radii, all arbitrary values: 9 / 10 / 11 px side by side, mixed with `lg` / `md` / `xl`.
- About 20 type sizes, with half-pixel steps between 12 and 15 px.
- A shadow copied 15 times without a name (the selected segment).
- Five different scrims.
- Three h1 scales.
- Two error idioms (`ErrorLine` beside `DyApiError` / `DyNotice`).
- A handful of plain "Yükleniyor…" lines.

**Design specificity.** The design is authored, not templated. Atkinson Hyperlegible with mono data, the navy ink
primary with teal and amber, and the dark `$` command block are its identity. Home, the job page and Onaylar have
real character. The secondary screens (İşler, Workflow'lar, Projeler, Çıktılar, Makineler, Yetenekler) all follow
one generic pattern: **h1 + purpose → segmented tabs → bordered panel → a second h2 → rows**. That structure, not
the visual language, makes them read as an admin template.

### 2.2 Findings by severity

| Sev | Finding | Where |
| --- | --- | --- |
| P0 | The page title appears up to three times: the top bar, the h1 and the panel h2 ("İşler" → "İşler 9") | every `ScreenFrame` screen |
| P0 | Phone: header actions wrap a lone button onto its own line ("Otomasyonlar"); row actions do the same ("Arşivle") | İşler header, Workflow'lar rows |
| P0 | Cards inside cards double every border: output cards inside the "Çıktılar" panel, the pairing card inside its panel | Çıktılar, Makineler |
| P1 | Every section card carries a drop shadow, so nothing reads as "floating" any more and light pages look busy | `Panel`, 28 `shadow-dy` |
| P1 | Teal "thread'de aç" on every row: the loudest colour sits on the least important action | İşler, Çıktılar, … (`ThreadLink`) |
| P1 | Dark primary is the text ink as a fill (#e6eaf2). It is the loudest element on every dark screen, louder than the amber decision next to it | `bg-dy-ink` buttons |
| P1 | Dark elevation is flat: card vs thread is a 3 % step, and the shadow is invisible on near-black | dark tokens |
| P1 | Skeletons are grey slabs (h-9 blocks) that do not look like the list they stand for | `SkeletonRows` (138 uses) |
| P1 | Motion over budget: drawers / sheets 260–280 ms, columns 220 ms, thread arrival 420 ms, decided outcome 260 ms | `motion.css`, `diyalog.css` |
| P1 | List updates, notices ("Kaydedildi", errors) and disclosures (`<details>`) snap in and out | everywhere |
| P2 | Unnamed copies: the selected-segment shadow (15×), the scrims (5 values) | B census |
| P2 | Sideways-scrolling rows give no hint that more is hidden: Kullanım tabs, job meta line, jobs chips, phone rail | phones |
| P2 | Dialog radius 16 px beside 14 px cards | `DyDialog` |
| P2 | Phone purpose lines run 3–4 lines at 15 px | `ScreenFrame` |
| P2 | "Yeni sohbet" is a teal fill. Every other primary is ink, and teal means "running / the assistant" | `ConversationList` |

## 3. Plan

The plan has three parts. The table in §4 shows what shipped.

1. **Hierarchy and layout (frame level).** Name the page once, show the top-bar title only on scroll, make phone
   action rows single-line, make sections flat and stop putting a card inside a card. Skeletons take the layout they
   stand for, and the per-row link gets quieter.
2. **Visual identity.** Name what was copied, give dark mode its own primary and an elevation edge, and set one
   radius scale (tokens; new code uses them, existing call sites move as they are touched).
3. **Motion.** One budget: ≤ 200 ms, exits faster than entries, transitions (interruptible) rather than keyframes for
   anything that can retrigger, opacity-only where movement adds nothing, everything off under reduced motion.

## 4. Implementation

### 4.1 Frame and layout

| Where | Before | After | Why |
| --- | --- | --- | --- |
| `ScreenFrame` top bar | Page title always in the bar, right above the h1 | Hidden (opacity 0, 150 ms) while the h1 is on screen; shown once it scrolls under the bar (IntersectionObserver, `-56px` root margin). Without IO the bar keeps it. | One name per view; the bar still orients a scrolled page |
| `ScreenFrame` actions (phones) | `flex-wrap`: a lone "Otomasyonlar" on its own line | One line, edge to edge (`-mx-3`), `overflow-x: auto`; on phones the gap is 6 px and padding 10 px (bordered) / 8 px (ghost), so İşler's four actions fit 390 px | No orphan line, no hidden control |
| `Row` actions | Wrapped with the trailing figures; "Arşivle" alone on a line | Own group (`.dy-action-row`): one line on phones, scrolls when it cannot fit, wraps as a group from `sm` | Same |
| Sideways rows (`.dy-scroll-fade`) | Cut off at the edge with no hint | Scroll-driven end fade (28 px mask) only while there is more to scroll (`animation-timeline: scroll(self inline)`, where supported). Applies to header and row actions, segmented tabs, the job meta line, İşler chips, the phone rail, the activity-log filter, the chat details tabs and the configuration tabs | A cut-off item reads as "more this way" |
| `ScreenFrame` header | `mb-5`, 15 px purpose everywhere | `sm:mb-6`, purpose 14 px on phones with `text-pretty` | More room above the content; shorter purpose blocks on phones |
| `Panel` | Border + drop shadow on every section | Flat: border plus the elevation edge (`shadow-dy-edge`, dark only), radius `--dy-r-card` | Shadow is kept for things that float (menus, dialogs, the sticky bulk bar) |
| `Panel bare` (new prop) | — | No card; the heading sits on the page and the content below | For sections whose content is itself cards |
| Çıktılar (grid view) | Output cards inside the "Çıktılar 6" card | Cards on the page grid (`bare`), with the elevation edge | No card in a card |
| Makineler → Eşleşme bekleyen | Amber-tinted panel around the amber pairing card | Bare section; the pairing card is the object | Same |
| `SkeletonRows` | Three grey 36 px slabs | Row-shaped placeholders: hairline separators, lead dot, title bar (varying widths), meta bar, trailing figure from `sm`, one breathing group. Row height ≈ a real row, so nothing jumps. | Says "a list is coming"; no layout shift |
| `ThreadLink` | Teal text on every row | Muted text with a teal icon; teal on pointer hover | Teal stays meaningful (links, live, focus) |
| "Yeni sohbet" | Teal fill | Ink primary (dark: the dark primary) | One primary look |

### 4.2 Tokens (`diyalog.css`)

All tokens are declared in the light block and in both identical dark blocks. The `@theme` names are
`shadow-dy-seg`, `shadow-dy-edge` and `bg-dy-scrim`.

| Token | Light | Dark | Replaces |
| --- | --- | --- | --- |
| `--dy-shadow-seg` | `0 1px 2px rgb(24 32 49 / .1)` | `inset 0 1px 0 rgb(255 255 255 / .05), 0 1px 2px rgb(0 0 0 / .45)` | The selected-segment literal in 14 files. The workflow editor's two copies are left to its owners. |
| `--dy-scrim` | `rgb(12 17 28 / .45)` | `rgb(4 6 10 / .62)` | Five scrims (dialog 0.55, step-up / palette 0.45, popover `black/35`, chat pane `black/40`) |
| `--dy-edge` | none | `inset 0 1px 0 rgb(255 255 255 / .035)` | — (new). Dark surfaces that sit higher catch a top highlight; a drop shadow is invisible on near-black. |
| `--dy-shadow` (dark) | — | The edge added in front of the existing drop shadow | — |
| `--dy-card` (dark) | — | `#1b212d` → `#1c2230` | One small lightness step; text contrast stays ≥ 4.5:1 (tested) |
| `--dy-primary` | `var(--dy-ink)` (unchanged) | `#c9d2e1` | The dark solid ink button was the text colour as a fill. Its label (card ink) keeps ≥ 4.5:1 (tested). Disabled and hover rules from round 1 still apply. |
| `--dy-r-card` / `--dy-r-band` / `--dy-r-ctl` | 14 / 10 / 9 px | same | The radius scale: a section, object card or dialog / a notice or segmented track / a control. `Panel`, `DyDialog` (16 → 14), `DyNotice` and `ErrorLine` use it. The other ~600 call sites keep their literal values until they are touched; mass-rewriting them now would collide with the parallel editor and MCP work. |

### 4.3 Motion

Budget: ≤ 200 ms for anything the user waits on, exits faster than entries, ease-out (`--dy-ease`) for entering,
the iOS drawer curve for edges, opacity-only where movement adds nothing. The command palette keeps no animation
(keyboard, many times a day).

| Surface | Before | After |
| --- | --- | --- |
| Bottom sheet (phone menus) | in 260 / out 180 ms | in 200 / out 160 ms |
| Edge drawers (below lg) | in 260 / out 180 ms | in 200 / out 160 ms |
| Side-sheet dialog | in 280 / out 200 ms | in 200 / out 160 ms |
| Wide list / details columns | 220 ms | 200 ms |
| Thread item arrival (`dy-enter`) | 420 ms | 200 ms (several arrivals in a row read as lag) |
| Decided card outcome (`dy-settle`) | 260 ms | 200 ms |
| List rows (`.dy-rows > li`), skeleton | snap | 180 ms opacity fade on insertion (`@starting-style` + transition, so a quick re-render retargets): the skeleton → list swap, a new job, a row put back |
| Notices (`DyNotice`, `ErrorLine` — the toast moments of this UI: "Kaydedildi", an API error, a read error) | snap | 180 ms from 4 px above + fade. They are inline bands, so they never cover content; there is no floating toast system to add. |
| Disclosures (`<details>`: "Rakamları göster", "Tamamı", settings sections) | snap | Height 180 ms + opacity 150 ms via `::details-content` and `interpolate-size: allow-keywords`, where supported. Elsewhere unchanged. |
| Top-bar title | — | 150 ms opacity |
| Dialogs, dropdowns, scrims | 150–200 ms | unchanged (already in budget) |

Reduced motion (`prefers-reduced-motion` and the in-app `data-motion='reduce'`): no movement. Notices keep a plain
opacity fade under the media query; the in-app switch removes even that. Disclosures and the bar title do not
animate, and the existing drawer / dialog / keyframe rules are unchanged.

## 5. Left on purpose

| Item | Why left / where it belongs |
| --- | --- |
| Duplicate panel h2 on single-list screens ("İşler 9" under "İşler") | Removing or renaming headings changes visible copy and the headings tests query. It needs a per-screen copy decision (count into the tabs or facts). |
| One shared FilterBar (search first, selects inline, apply on change, phone filter sheet) | Changes behaviour ("Uygula") and needs new strings ("Filtreler (n)"). It is its own task with i18n. |
| Phone overflow menu ("⋯") for header / row actions | Needs new strings. The single-line row with fade fits the common case (İşler's four actions fit 390 px). Workflow'lar' four row actions still scroll at 390 px (fourth button half visible, faded). |
| `DyFilePick` (Turkish "Dosya seç" instead of "Choose Files"), date inputs in Turkish order, limit-window English | New strings or i18n-phase work, as round 1 noted |
| Workflow editor: canvas node text ~9 px, phone toolbar | Owned by 14.4 / 14.5 |
| Yetenekler: import form above the skill list | Keşfet / skills work (MCP P5) is in flight in the same screen |
| Home: column void under the shorter decision card | Needs a masonry / column decision that changes reading order (j / k) |
| Settings › Profil: single-control cards | Settings layout task; low value alone |
| Remaining radius / type literals (~600 / ~1 800 call sites) | Tokens exist now. New code uses them; old sites move when touched, which avoids conflicts with parallel work. |
| Amber fill brightness in dark (`#f0b048` tracks) | Tested contrast pairs depend on it; needs its own colour pass |

## 6. Parity

No control, screen or text was removed or renamed. Every action is still on screen; on phones some scroll sideways
with an end fade instead of wrapping. No string was added, and `pnpm check:i18n` is green ("no Diyalog file gained
hard-coded strings"). Behaviour is unchanged: only layout classes, tokens, transitions and one IntersectionObserver
(presentation only) moved. Routing, lazy loading and data fetching were not touched.

## 7. Security review

The change is presentation only: no endpoint, request, storage, permission or dependency. CSP is unchanged. The
fade is a CSS `mask-image` gradient (no `data:` image), and no inline script or style attribute was added. The
IntersectionObserver reads only the h1's own visibility. Every new selector is scoped to `[data-ui='diyalog']`
(keyframes and the in-app `data-motion` switch excepted, as before), so the classic console and "Klasik görünüm"
are untouched.

## 8. Tests and verification

`apps/web/test/diyalog-polish-2.test.tsx` has 13 tests:

- The new tokens are in the light and both dark blocks.
- The dark primary is quieter than the ink and its label still reaches 4.5:1.
- No copied segment shadow or scrim literal is left outside the editor.
- Every motion.css transition is ≤ 200 ms, and diyalog.css one-shots are ≤ 200 ms.
- Sheet and drawer exits are faster than entries.
- The new moments are scoped and stop under reduced motion.
- Top-bar title: kept without IntersectionObserver; hidden and shown with a mocked observer.
- Header actions are one non-wrapping row on phones.
- `Panel` is flat (no drop shadow) and `bare` has no card.
- Skeleton rows are row-shaped.
- Row actions are one group, and `Rows` carries the entry hook.

Round 1's `diyalog-polish.test.tsx` still passes: contrast in both themes with the new dark card, identical dark
blocks, and scoped selectors.

Runs:

- **Web suite:** 175 files / 1718 tests green, including the 13 new tests.
- **Repo checks:** `format:check`, `lint` and `typecheck` green. `check:docs`, `check:i18n` and `security:pins` green.
- **Detector:** clean after the change (§9).
- **Visual:** after shots at 1440 / 390, light / dark.
  - İşler: the phone header now has one action line (all four buttons at 390 px).
  - Workflow'lar: row actions are one faded line.
  - Makineler, Çıktılar: no card in a card.
  - Dark primary: softer.
  - Top bar: no duplicate title.

## 9. Rollback

Revert the p14-diyalog-polish-2 commit. No data, migration, worker release or configuration is involved.
