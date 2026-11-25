# p14-diyalog-polish — Diyalog UI/UX audit and polish

Owner request (2026-10-21): "ui/ux açısından diyalog temasını da iyileştirmemiz lazım." Diyalog is the default UI
(`apps/web/src/diyalog`). This note is the audit (what was wrong, by severity), what was changed, and what is left.
It refines the existing language ([p12-diyalog.md](p12-diyalog.md) §3 tokens, §17 motion; the
[visual tour](p12-diyalog-visual-tour.md)) — no new look, no copy change, no feature removed. Web only: no endpoint,
no migration, no worker release.

## 1. Method

- **Where it ran.** The p12 visual harness (`apps/web/diyalog-harness.html?view=shell&path=…`, dev server only): the
  real signed-in app — the same `App`, routes, shell and screens — over the fixture API that every Diyalog screen
  test and the p12 tour use. That fixture set is richer than the dev seed (pending approvals of every risk, a pairing
  request, limit windows near and at the limit, failed jobs, workflow runs, outputs of every kind), so it shows more
  states than `dev master + seed` would; the dev Postgres / Redis stack was not needed for a web-only change and was
  not started.
- **What was captured.** The 12 main screens — Ana sayfa, Sohbet, Senden bekleyenler (Onaylar), İşler, iş detayı,
  Workflow’lar, Makineler, Çıktılar, Kullanım, Projeler, Ayarlar, Yetenekler — at **1440 × 900** and **390 × 844**,
  **light and dark** (Playwright `colorScheme`), before and after: 96 viewport shots plus focus / hover states and the
  overlays (Tüm ekranlar, ⌘K palette). WebP, quality 55: `p14-diyalog-polish/before/` and
  `p14-diyalog-polish/after/`, named `<screen>-<desk|phone>-<light|dark>.webp`
  (`focus-jobs*.webp`: a focused field, a hovered primary button, a hovered row).
- **Measured.** Every colour token pair in both themes against WCAG 2.2 AA (text 4.5:1, control boundaries 3:1); the
  type sizes and radii used in `diyalog/**`; every `outline-none`, native `<select>`, file input, hover rule and
  transition; the Impeccable detector over the changed files (clean).

## 2. Audit

### 2.1 Health score

| # | Dimension | Before | After | Key finding |
| --- | --- | --- | --- | --- |
| 1 | Accessibility | 2 | 3 | Light `faint` text (3.9:1 on the page) and white-on-amber buttons (4.24:1) under AA; field borders 1.6:1; 28 fields with `outline-none` whose only focus cue was a 1 px border tint |
| 2 | Performance | 3 | 3 | Motion is transform / opacity only, `content-visibility` on threads; nothing changed here (the parallel performance task owns splitting / fetching) |
| 3 | Responsive | 3 | 3 | Rail labels cut to "Senden …", "Workflow…"; phone header / row actions wrap to orphan lines (left, P3) |
| 4 | Theming | 3 | 4 | Full token system, but native selects / file buttons / checkboxes kept browser colours; a disabled solid button in dark looked enabled |
| 5 | Implementation integrity | 3 | 3 | Coherent system; drift in ~100 hand-styled fields and 20+ inline primary buttons, half-pixel type steps (12.5 / 13.5 px) beside off-scale ones |
| | **Total** | **14/20** | **16/20** | Good → good, the remaining points are copy (English strings) and per-screen phone wrapping |

### 2.2 Findings by severity

**P1 — WCAG AA violations (all fixed)**

| Issue | Where | Fix |
| --- | --- | --- |
| `--dy-faint` light `#6e7891`: 3.90:1 on `bg`, 3.98 on `sunk`, 4.41 on `card` — used for hints, timestamps, placeholders, the ⌘K hint | tokens (`diyalog.css`) | `#5f6982` (≥ 4.6:1 on every surface; still a step below `muted`) |
| `--dy-amber` light `#b26a00`: white text on the warn button ("Onayla") 4.24:1 at 14 px bold (not "large"); amber text on the card 4.24:1 (countdowns, "maliyeti bilinmiyor") | tokens | `#9c5c00` (5.3:1 both ways; amber-soft / amber-ink pills unchanged) |
| Form field boundaries `line-2` 1.61:1 (light) / 1.65:1 (dark) against the card — WCAG 1.4.11 asks 3:1 for the visual boundary of a control | ~100 fields | new token `--dy-field` (light `#848da1` 3.3:1, dark `#677289` 3.3:1) applied to bordered fields only; buttons and separators keep the quieter `line-2` |
| Focus on 28 fields was `outline-none` + `focus:border-dy-teal` — a 1 px colour change, easy to miss; the global `:focus-visible` ring could not reach them (utilities win over the components layer) | `forms.tsx`, `DraftCard`, `JobDraftCard`, composer fields, decision panel, step-up | one unlayered rule: teal border **and** a 3 px teal halo (`box-shadow`, no layout) on every bordered Diyalog field; invalid fields keep red with a red halo; borderless fields inside framed composers (`border-0`) keep their frame's treatment |

**P2 — consistency, states, feel (fixed)**

| Issue | Fix |
| --- | --- |
| Native `<select>` arrow 4 px from the edge, platform-specific, ignored the theme (26 selects + classic ones bridged in) | `appearance: none`, one drawn chevron in `muted`, 2.25 rem right padding; option list in card / ink colours |
| Native file button ("Choose Files") in browser grey | `::file-selector-button` in the secondary-button shape (line-2 border, 9 px radius, ink hover) |
| Checkboxes / radios / ranges in browser blue | `accent-color: var(--dy-teal)` on the Diyalog scope |
| Solid buttons (ink / amber / teal / red fill — DyButton, CardButton, the 20+ inline primaries) had **no hover state** | a hover veil drawn with an inset shadow (ink lightens, colour fills darken; dark theme inverted), pointer devices only, 140 ms; ghost buttons get a faint `sunk` wash |
| A disabled solid button in dark mode read as an *enabled* light button (light-grey slab at 55 %), e.g. "Önizle", pairing "Onayla" | disabled solid buttons drop the fill: `sunk` background, `line-2` border, `faint` text — in both themes; a **busy** button keeps its fill |
| `dy-press` transitioned transform / background / border but not text colour or shadow — hover colour changes snapped | `color` and `box-shadow` added (140 ms) |
| Row lists (44 screens use `Row`) gave no pointer feedback | `Row` gets a faint `sunk` wash on hover (150 ms, pointer devices only), unless the caller paints the row itself (selected rows keep their colour) |
| Rail labels truncated: "Senden …", "Workflow…" | rail 72 → 76 px, items 56 → 64 px, labels wrap to two lines (`line-clamp-2`) instead of being cut; items `shrink-0` so a short window scrolls the rail instead of squeezing labels; item height 54 → 50 px so the rail keeps its length |
| Off-scale type sizes: 11.5 px (16×), 14.5 px (9×), 15.5 px (1×), 10 px (2×) beside the 11 / 12 / 12.5 / 13 / 13.5 / 14 / 15 / 16 px steps | folded into the neighbouring step (12, 15, 16, 11 px) |
| Text selection in the browser default blue | `::selection` in a teal tint |
| Scrollbars in dark mode were light-grey OS bars | `scrollbar-color: line-2 / transparent` on the scope (width unchanged) |

**P2 — found, not changed here (copy or another task's code)**

| Issue | Why left |
| --- | --- |
| English strings in Turkish screens: limit windows "Read 2 min ago", "5h" / "weekly", "AM sıfırlanır" (`api/runtimeUsage.ts` `sourceText` / `windowName` / `resetText`, shared with classic); ⌘K approvals "high / critical / medium" | user-visible copy; belongs to the i18n phases (`@remyral/i18n` + the ratchet), not a visual pass |
| Settings › Profil "Oturum bilgisi yükleniyor…" next to the loaded session line in the harness | the harness has no session details (fixture gap), not a product bug |

**P3 — polish left for later**

- Phone: header actions of İşler wrap to a lone "Otomasyonlar"; Workflow’lar row actions wrap to a lone "Arşivle".
  Readable and tappable; a per-screen overflow menu would be the fix.
- Page widths: Ana sayfa and the job page use 1440 px, secondary screens 1200 px (820 px narrow) — intended (dashboards
  vs lists), documented in p12 §9.2.
- The top bar repeats the page title right above the h1 on desktop (aria-hidden, harmless).
- 12.5 / 13.5 px half steps (≈ 430 uses) stay: they are the established small-label sizes; folding them would move
  every list by a pixel and re-open the p12 layout-shift work for no visible gain.

### 2.3 What already worked (kept)

- Colour never carries meaning alone (pills, badges, rail rows pair icon + word).
- Motion: one entry moment, `transform` / `opacity` only, menus 140–180 ms from their anchor, drawers 260 ms on the
  iOS curve, no animation on the ⌘K palette (keyboard, many times a day), everything off under
  `prefers-reduced-motion`.
- Loading / empty / error states per panel (`SkeletonRows`, `EmptyLine`, `ErrorLine` with retry), layout-shift work of
  the p12 tour, 44 px targets on phones, safe-area insets, a visible `:focus-visible` ring on links and buttons.
- Dialogs (`DyDialog`, Tüm ekranlar, step-up) and the palette: native `<dialog>`, focus return, correct layering in both
  themes.

## 3. Implementation

Token and component level first, so ~100 call sites follow without being edited:

| Where | Change |
| --- | --- |
| `diyalog/diyalog.css` tokens | light `--dy-faint` `#5f6982`, `--dy-amber` `#9c5c00`; new `--dy-field`, `--dy-focus-ring`, `--dy-veil-ink`, `--dy-veil-fill`, `--dy-selection` (both dark blocks too); Tailwind `dy-field` colour |
| `diyalog/diyalog.css` unlayered "one finish" block | field boundary + focus halo, invalid focus, select chevron, file button, `accent-color`, `::selection`, scrollbar colour, solid-button hover veil and disabled state, ghost hover wash. Every selector starts with `[data-ui='diyalog']`; the control rules also need `.dy-surface` and the button rules the Diyalog-only `.dy-press`, so classic pages inside "Klasik görünüm" (no `.dy-surface`) and the classic console are untouched |
| `diyalog/diyalog.css` `.dy-press` | transitions `color` and `box-shadow` too (140 ms) |
| `screens/parts.tsx` `Row` | pointer hover wash unless the caller sets a background |
| `DiyalogShell.tsx` rail | 76 px rail, 64 px items, two-line labels, `shrink-0`, 50 px item height; phone bar unchanged (one line) |
| 18 files | off-scale text sizes folded into the scale (class strings only) |

Motion budget: every new transition is ≤ 150 ms and only `color` / `border-color` / `background-color` /
`box-shadow`; hover effects are inside `@media (hover: hover) and (pointer: fine)`; the press scale and all movement
already stop under `prefers-reduced-motion` (colour feedback stays, as it should).

Not touched (parallel performance task): routing, lazy loading, data fetching.

## 4. Parity

No control, screen or text was removed or renamed; the i18n ratchet (`pnpm check:i18n`) is unchanged and green — no
string was added. Behaviour is identical: only colours, borders, shadows, the rail geometry and a few font sizes moved.

## 5. Security review

Presentation only. No new endpoint, storage, permission, request or dependency. CSP unchanged: the select chevron is
two CSS gradients (no `data:` image), no inline style or script was added. The new selectors are scoped to the
Diyalog subtree, so nothing in the classic console changes.

## 6. Tests and verification

- `apps/web/test/diyalog-polish.test.tsx` (9): text tokens ≥ 4.5:1 on `bg` / `thread` / `card` / `sunk` and meaning
  colours / on-fill text ≥ 4.5:1 in **both** themes (computed from `diyalog.css`), field boundary ≥ 3:1, both dark
  blocks identical, every new rule scoped to `[data-ui='diyalog']`, the field / select / file / hover / disabled rules
  present, `Row` hover wash and its exception for painted rows.
- Web suite: 168 files, 1647 tests green (one timing failure in `diyalog-job-details.test.tsx` under machine load,
  green on re-run alone).
- Visual: before / after shots above; focus halo, hover veil and row wash checked in `after/focus-jobs*`.

## 7. Rollback

Revert the p14-diyalog-polish commit. No data, migration, worker release or configuration involved.
