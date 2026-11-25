# Design note: `p17-settings-tabs` — long card stacks onto the shared tabs

- **Task:** `p17-settings-tabs`. **Date:** 2026-10-24. **Migration:** none. **Worker release:** none. **Master:** three
  link targets (§4), no behaviour change.
- **Owner direction (2026-10-24):** "ayarlar sayfasındaki bir çok kart sekme mantığına taşındı. operasyon güvenliği
  sayfası sekme mantığında hazırlanmamış. sekme mantığına geçirelim ve başka sayfalarda da varsa onlarıda geçirelim."
- **Builds on:** p15-form-pattern (`DyTabs`, the unsaved-changes guard, the tabs of Güvenlik / Profil / Sohbet /
  Bildirimler / Entegrasyonlar), p16-ops-safety, p16-doctor, p16-observability, p17-panel-motion (motion tokens).

## 1. The pattern (what every converted page now does)

One component, `DyTabs` (`apps/web/src/diyalog/formkit/tabs.tsx`, also exported as `SegTabs`). Nothing new was invented
for this task; the gaps the brief named were filled in the shared component, so every tabbed screen gets them:

| Behaviour | How |
| --- | --- |
| Tab in the URL | `?tab=<id>` (`?section=<id>` for a tab inside a tab, see Kullanım below); the first tab is the clean URL, so every old link without a parameter still opens the page on its first tab. Switching replaces the history entry (no pile of entries). |
| Deep links / old anchors | `fallback` picks the tab while the URL names none; pages map their old card anchors (`#ops-brake`, `#kill-switch`, …) to the tab that holds the card. Once the user picks a tab the anchor no longer decides (picking the first tab writes the clean URL, which would otherwise fall back to the anchor's tab again). `?tab=` always wins over an anchor. |
| Keyboard | WAI-ARIA tabs: ← / → (wrapping), Home / End, one tab stop (roving `tabindex`), focus follows the selection. |
| Lazy bodies | Only the open tab's body renders (and fetches what only it needs). Page-level loads that several tabs share (the security policy on Operasyon güvenliği, the overview on Worker sürümleri, doctor + support settings on Tanılama) stay on the page, so a switch never waits. |
| Scroll memory (new) | The scroll position of the tab being left is kept; going back to it restores it. A tab not seen yet starts with the tab row in view when the row had scrolled under the sticky top bar (otherwise the page stays put). |
| Phones (new) | The row scrolls sideways with the end fade (p14); the selected tab is scrolled into the visible part of the row, so a deep link to the fifth tab shows it selected. |
| Motion (new) | After a switch the body fades in and rises 4 px (`.dy-m-tab`, `motion.css`, `--dy-m-swap` / `--dy-m-out` tokens — the state-chip swap timing, no new library). Never on the first render. Reduced motion (system or `data-motion="reduce"`): opacity only. |
| Unsaved edits | A tab whose form holds edits asks "Kaydedilmemiş değişiklikler var" before switching (p15, unchanged). |
| Filters that belong to one tab (new) | `clearParams` names URL parameters a switch drops (Sistem durumu's log / trace filters). |

## 2. Converted pages

### Ayarlar → Operasyon güvenliği (`/settings/ops-safety`) — the page the owner named

Before: four cards one under the other, the cost brake card itself four sections long (spend now, mode and ceilings,
lifts, project ceilings). Now five tabs, named from the cards:

| Tab (`?tab=`) | Content | Who |
| --- | --- | --- |
| Anahtarlar ve süreler (clean URL) | keys / tokens / certificates, "Şimdi denetle", rotation stamps, a vault credential's expiry date | owners, admins |
| Maliyet freni (`brake`) | spend now, mode and ceilings, active lifts; the lift form for owners, "Freni yalnızca bir sahip kaldırabilir." for admins | owners, admins |
| Proje tavanları (`projects`) | project ceilings — split out of the brake card into a tab of its own | owners only (the tab is not offered to an admin; `?tab=projects` as an admin opens the first tab, as before the card was not shown to them) |
| İstek sınırları (`limits`) | request limits (security policy, step-up) | owners, admins |
| Sürüm devre kesici (`breaker`) | rollout breaker thresholds (security policy, step-up) | owners, admins |

Links: the key-expiry notifications, the home's key line and the domain wizard's "keys" link open the clean URL
(Anahtarlar ve süreler, unchanged). The cost-brake notification, the doctor's cost-brake finding, the home's brake
line and the cost brake band now open `?tab=brake`. Anchors `#keys`, `#expiry`, `#ops-expiry`, `#brake`, `#cost-brake`,
`#ops-brake`, `#projects`, `#ops-projects`, `#limits`, `#ops-limits`, `#breaker`, `#ops-breaker-settings` land on their
tab. No `?section=` links into this page existed (grep over `apps/web/src`, `apps/master/src`, `packages`).

### Kullanım → Limitler ve kotalar (`/usage?tab=enforcement`)

Eleven cards in one tab (limit windows, near-limit notice, usage limits, account defaults, provider pauses, kill-switch
holds, concurrency, budget enforcement, recent decisions, the quota policy JSON, the project kill switch) — the
longest scroll in the console. The page already has a tab row (Kullanım's eight tabs, `?tab=`), so the sections use
the same component with `param="section"`:

| Section (`?section=`) | Cards |
| --- | --- |
| Kullanım sınırları (clean) | limit windows, near-limit notice, usage limits now + default policy, account defaults |
| Duraklatma ve durdurma (`holds`) | provider pauses, kill-switch holds, the project kill switch (or the read-only note); the tab's count is what is held now |
| Eşzamanlılık ve bütçe (`load`) | concurrency in use, budget enforcement |
| Son kararlar (`events`) | the recent quota decisions |
| Kota politikası (`policy`) | the policy JSON (read-only below admin) |

`/usage?tab=enforcement` (the composer's "Limit ayrıntıları", the palette entry) opens Kullanım sınırları. Anchors
`#limits`, `#near`, `#usage-limits`, `#pauses`, `#holds`, `#kill-switch`, `#concurrency`, `#budgets`, `#events`,
`#policy` open their section. The chat tool `quota_status` linked `/usage?tab=quotas`, a tab id that never existed
(it opened the dashboard); it now links `/usage?tab=enforcement`.

### Ayarlar → Worker sürümleri (`/settings/releases`)

Five cards: upload, circuit breaker, channels + roll-out form, uploaded releases, update attempts (paged). Tabs:
**Yayılım** (clean: upload, breaker, channels and the roll-out form — the breaker notification's link
`/settings/releases` lands where the held rollout is), **Yüklenen sürümler** (`releases`), **Güncelleme denemeleri**
(`attempts`, its pager keeps its own `attempts*` parameters).

### Ayarlar → Tanılama (`/settings/diagnostics`)

Four long cards (the doctor's findings and the machine doctors can each be a long list; the support report form is
long). Tabs: **Doktor** (clean: run + machine doctors — the doctor notification's link), **Destek raporu** (`report`),
**Destek ayarları** (`settings`, read-only for admins as before).

### Ayarlar → Sistem durumu (`/settings/system`)

Already had three tabs (Durum / Kayıtlar / İzler, `?tab=`) drawn by hand: no arrow keys, no single tab stop, a
different look. The row is now `DyTabs`; the links between the tabs ("hataları göster", a trace's logs) keep setting
their filters, and a tab click drops the last tab's filters (`clearParams`) as the hand-made row did. `?tab=logs` links
(doctor, chat tools) are unchanged.

## 3. Audit — every screen under `apps/web/src/diyalog/screens`

Already tabbed (`DyTabs` / `SegTabs`): Ayarlar → Profil, Güvenlik, Sohbet, Bildirimler, Entegrasyonlar; Projeler (project
screen), Makineler (list views) and the machine screen, İşler, Onaylar, Çıktılar, Yetenekler, Şablon ayrıntısı,
Otomasyon, Kullanım.

Converted: Operasyon güvenliği, Kullanım → Limitler ve kotalar, Worker sürümleri, Tanılama, Sistem durumu (row only).

Left as they are, and why:

| Screen | Why |
| --- | --- |
| Ayarlar → Yedekler | a status overview (health line, four tiles, last backup + schedule side by side, drill, standby): read at a glance, no forms; tabs would hide the state |
| Sistem durumu → Durum tab | the same: one status dashboard (components, queue, deploy, disk, monitoring) |
| Ayarlar → Kimlik bilgileri, Modeller, Runtime'lar, Kullanıcılar, Cihazlar, API anahtarları, Servis hesapları, Webhook'lar, Çalışma dosyaları | one list with its create / edit flow (≤ 3 cards; the cards are steps of one task) |
| Ayarlar → API | one reference document (search + operations) |
| Ayarlar → Bağlam (knowledge/ContextView) | one list + editor |
| Projeler → Politika (6 cards), Sınırlar ve yönlendirme (7 cards), Ağ erişimi, Hafıza, Depo, Dağıtım | already a tab each of the project screen (p15 split the old policy stack into three tabs); each is one form scope with one save bar — a second tab row inside the project's eleven tabs would split one save into several. Revisit if a tab grows further. |
| Makine → Etkinlik, Yönetim, Araçlar, Runtime'lar, Korumalı alan, Yapılandırma | already one tab each of the machine screen, ≤ 5 cards, partly role-gated (admins see more); Yapılandırma has its own section switcher (one versioned document) |
| Kullanım → Pano, Raporlar, Maliyet dökümü, Bütçeler, Fiyatlar, Sonuçlar, Öneriler | already tabs; each is one report / list |
| Dağıtımlar → eylem ayrıntısı, İş akışı çalıştırması, Uptime → monitör | the detail of one record read top to bottom (state, change, result, logs) |
| Şablon formu, Otomasyon formu, İş akışı editörü / sihirbazı, Composer, alan adı sihirbazı | single flows (wizards, editors) — the brief excludes them |
| Senden bekleyenler, İşler listesi, Makineler listesi, Hizmetler | one list each |

## 4. Changed links (master)

- `apps/master/src/ops-safety/cost-brake.ts`: the `cost.brake` notification → `/settings/ops-safety?tab=brake`.
- `apps/master/src/doctor/checks.ts`: the `cost.brake` finding's docs link → `/settings/ops-safety?tab=brake` (the key
  expiry finding keeps `/settings/ops-safety`, the first tab).
- `apps/master/src/chat/admin-actions.ts`: `quota_status` → `/usage?tab=enforcement` (was the non-existent `quotas`).

## 5. Tests

- `apps/web/test/p17-settings-tabs.test.tsx`: DyTabs (body fade only after a switch, lazy body, `clearParams`, anchor
  fallback and a picked first tab, `?tab=` over an anchor, scroll memory, the selected tab scrolled into an overflowing
  row); Operasyon güvenliği URL ↔ tab, `#ops-brake`, role gates; Worker sürümleri tabs and URL; Sistem durumu arrow keys
  and filters dropped on a click.
- `apps/web/test/ops-safety.test.tsx`: tab list per role, keyboard, deep links (`?tab=` and the old anchors), project
  ceilings in their own tab; the existing card tests open their tab.
- `diagnostics`, `diyalog-usage`, `diyalog-roles`, `diyalog-settings`, `diyalog-w3-settings-admin`: the stacked-layout
  assumptions now open the tab / section; enforcement sections, anchor and clean-URL tests; role gates per section.

## 6. Not verified

- Real-browser feel of the fade and of scroll restoration (jsdom has no layout; the scroll and row-overflow tests stub
  the geometry). Safari / phones not checked by hand.
- Rollback: revert the commit; no data or API change.
