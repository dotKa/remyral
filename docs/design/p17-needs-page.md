# Design note: `p17-needs-page` — "Senden bekleyen" on its own page, the home a dashboard with quick access

- **Task:** `p17-needs-page`. **Date:** 2026-10-24. **Migration:** none. **Worker release:** none. **Master:** none.
- **Owner direction (2026-10-24):** "senden beklenenler alanını farklı bir sayfaya taşıyalım. anasayfa tam bir dashboard,
  hızlı erişim alanı olsun."
- **Builds on:** p12-diyalog §9 (the Home panel dashboard and its "Senden bekleyen" section), p12-diyalog Faz 4
  ("thread'de aç" card links, `ops/cardHash.ts`), p14-web-perf (lazy screens, remembered reads), p17-panel-motion.

## 1. Route

`/needs` — English like every other Diyalog route (`/jobs`, `/automations`, `/approvals`). It is a matcher in
`screens/routes.tsx` (`screens/needs/index.tsx`, lazy chunk like Otomasyonlar), so `preloadDiyalogPath` loads it on
rail intent, and it is in the idle preload list (`MAIN_ROUTES`) because it is a phone-bar item. The page uses
`ScreenFrame` (h1 "Senden bekleyenler", purpose line, live dot, document title "Senden bekleyenler · Remyral") with
one ghost action, **Onay geçmişi** (`/approvals`, decided requests).

## 2. What moved, what stayed

| Piece | Before | Now |
| --- | --- | --- |
| Decisions section (`#benden-bekleyen`): live cards decided inline, "1 / 5", first deadline, kinds, needs-you rows with Çöz / Kapat, show all, `j` / `k` / `a` / `d`, card-sized placeholders | top of `/` | `/needs` (`screens/needs/NeedsScreen.tsx`, `Decisions`), unchanged behaviour |
| Model (needs-you rows, open cards, cards decided during the visit, urgentFirst, kinds, first deadline) | inside `DiyalogHome` | `ops/decisions.ts` `useDecisions` — shared by the page and the home tile; both read the same remembered sources (`home:data`, `ops-events`), so the counts agree and switching is instant |
| Summary | — | home tile `NeedsTile` (`homeTiles.tsx`) |
| Onboarding card, cost brake band, failure digest, panels grid | home | home (unchanged) |

## 3. Links

- `NEEDS_PATH`, `NEEDS_ANCHOR`, `CARD_HASH_PREFIX`, `needsCardHref(key)`, `isNeedsHash(hash)` live in `ops/anchors.ts`
  (no page code, so the shell imports them without a chunk).
- "thread'de aç" (`screens/parts.tsx` `threadHref`) now builds `/needs#kart=<kind>:<id>`.
- **Old URLs:** the shell sends `/` with `#benden-bekleyen` or `#kart=…` on to `/needs` with the same hash
  (`<Navigate replace>`, before the home chunk loads); the page's `useCardHash` waits for the card (up to 8 s) and
  focuses it, `#benden-bekleyen` focuses the section. Other hashes on `/` stay on the home.
- **Master:** no notification, email, push or chat link builder pointed at the home anchor (they link to
  `/approvals/:id`, `/deploys/:id`, `/jobs/:id`, …), so nothing changed there.
- Rail: "Senden bekleyenler" → `/needs`, count badge kept (pending approvals + machines waiting to pair + questions),
  current on `/needs` and `/approvals`. Command palette: a `/needs` page entry.

## 4. Home layout

```
h1 Ana sayfa · lede
[onboarding] [cost brake] [failure digest]
┌ Senden bekleyen (summary) ┐ ┌ Hızlı erişim ─────────────┐   ≥ 960 px: side by side; below: stacked
│ count · kinds · en acil  │ │ [Yeni iş] [Formla]         │
│ ilk süre dolumu · Tümünü aç│ │ Sohbet İşler Workflow’lar… │
└──────────────────────────┘ └───────────────────────────┘
panels grid (Çalışan işler · Bugün · Kuyruk · Makineler · Limitler · Son olaylar · Sağlık · Son hatalar)
```

- **Summary tile:** states `loading` (placeholder chips, muted breathing icon), `waiting` (amber: "Senden N karar
  bekliyor", each kind a chip linking to its first card `/needs#kart=…` or, for a needs-you row, its fix; "En acil:"
  the first of `urgentFirst` (or the first row) with the first deadline as a countdown), `clear` (green check, calm
  line). "Tümünü aç" → `/needs` always. Unreadable sources are named as on the page.
- **Quick access:** the two ways to start a job are the emphasised actions (dark "Yeni iş" → `/chat#yeni-is`, outlined
  "Formla" → `/jobs/new`, each with a one-line hint) — shown to operators and up, the classic `canStart`. Then the
  rail's destinations as compact two- / three-column links with their rail icons: Sohbet, İşler, Workflow’lar,
  Otomasyonlar, Makineler, Çıktılar, Kullanım, Projeler, Ayarlar (every role, as on the rail), and **Makine ekle**
  for owners / admins (the Makineler panel's rule). Links preload their screen on intent.
- **No layout jump:** the tile has a fixed minimum height (`10.5rem`) and draws placeholders while loading, the quick
  access is static, so the panels are drawn at once instead of waiting for the decisions (the p12 visual-tour rule
  only existed because the decisions' height was unknown); each panel keeps its own skeleton rows.

## 5. Motion

Existing system only. The tile's count line is a `Swap` (cross-fade on change, never on first render); on the page a
decision card that arrives while it is open tips up (`.dy-m-arrive`, the thread card keyframes `dy-m-card` with the
burst stagger from `useArrivals`; never on the first draw or a bulk load). Reduced motion (`prefers-reduced-motion`
and `[data-motion='reduce']`): `.dy-m-arrive` does not animate; `Swap` falls back to an opacity fade.

## 6. Tests

`apps/web/test/diyalog-ops.test.tsx` (decision tests now on `/needs`; p17 block: home summary + quick access + no
cards, calm state, rail target / current page / document title, `/#kart=…` and `/#benden-bekleyen` redirects with
focus, other hashes stay home), `diyalog-layout-stability.test.tsx` (tile height kept, panels at once; page
placeholders), `diyalog-roles.test.tsx` (quick access per role), `i18n-home.test.tsx` (EN tile, quick access, page),
`diyalog-shell.test.tsx` (fallback rows on `/needs`), card-link expectations in the approvals / deploys / projects / jobs
/ screens suites.

## 7. Security, rollback

No new data, endpoint or permission: the page reads what the home read, with the same role gating (the master decides
every action; the quick access only hides what a role cannot start). Rollback: revert the commit; old `/#kart=` links
work either way.
