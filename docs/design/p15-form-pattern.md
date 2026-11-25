# p15-form-pattern — one form pattern for the Diyalog screens

Owner request (2026-10-22): "Formlarda değişiklikleri kaydet butonu kafa karıştırıcı. Ayarlar, proje ayarları gibi
sayfalarda alt alta çok fazla kart var; bunları tab sistemine geçirelim. Her tab kendi içinde kaydedilsin; tab
değiştirirken değişiklik varsa 'kaydetmedin, emin misin' diye sorulsun. Form yapılarının genel bir tasarım pattern'i
olmalı."

The problem: a settings page was a column of cards, and almost every card had its own "… kaydet" button (the project
Politika tab had 15 cards and 13 save buttons). You could not tell what one button saved. Leaving the page dropped
your edits without a word. This note sets **one pattern**. Every screen that edits settings follows it, and new
screens must too. It works inside the Diyalog language ([p12-diyalog.md](p12-diyalog.md) §3 tokens, §17 motion;
[p14-diyalog-polish-2.md](p14-diyalog-polish-2.md)). Web only: no endpoint, no migration, no worker release.

## 1. The parts (`apps/web/src/diyalog/formkit`)

| Part | What it does |
| --- | --- |
| `DyTabs` | Segmented tabs (`role="tablist"`). The tab is in the URL (`?tab=<id>`; the first tab is the clean URL, so old deep links still land; a nested set uses its own parameter). Keyboard: ← / → / Home / End, one tab stop. Before it switches it asks the unsaved-changes guard. A clean switch is immediate. `fallback` picks the tab when the URL names none (`#personal-rules` → Kişisel kurallar). `SegTabs` (p12) is now this component, so every existing tab set is guarded too. |
| `useDyForm(opts)` | A form's value against the value it was **loaded** with: `value`, `set`, `dirty`, `busy`, `save`, `discard`, `fieldError(key)`, `error`. Saving runs the client checks (`validate` → field messages), then the request **through step-up when the master answers `step_up_required`** (the provider's dialog, one retry; a cancelled code is not an error and keeps the edits). The master's `issues` (`{path, code}`) land next to their fields (`fieldOf` maps a path to a field; the codes are worded by the `forms.issues` catalog). Anything else shows as the error band above the bar. A newly loaded value (a reload, another tab's save) becomes the baseline and keeps your edits. |
| `useFormSection` / `useCardForm` | The same contract for a card that keeps its own state (an existing panel moved into a tab form): it reports `dirty`, how to save and how to discard. Inside a tab form its own save button goes away (`card.inScope`). Outside one, the card keeps its button and still registers with the guard. |
| `DyFormScope` | **The tab's form.** Every section inside shares one sticky save bar. Saving runs the dirty sections one after another and stops at the first that fails. Its errors stay where it is, and focus moves to the first invalid field. ⌘/Ctrl+S saves. It registers once with the guard. `readOnly` (viewers) never shows a bar. |
| `DyForm` | The single-form case: `<DyForm form={useDyForm(…)}>fields</DyForm>`. Its own scope and bar, a native `<form>`, and Enter in a one-line field saves. |
| `DyFormBar` | Sticky at the bottom of the viewport, above the phone tab bar. It shows only while something is dirty: "Kaydedilmemiş değişiklik var · Vazgeç · Kaydet". It is disabled while saving ("Kaydediliyor…"), says "Kaydedilemedi — ayrıntı formda." after a refusal, and shows the "Kaydedildi" toast (`role="status"`, 2.6 s) after a save. A section may rename the button while it is the only dirty one ("Devral ve kaydet"). |
| `useUnsavedGuard` / `UnsavedGuardProvider` | Registered forms holding edits make the guard ask before another tab, before an **in-app link** (rail, back link, any same-origin `<a href>`; caught in the capture phase before the router sees the click) and before **browser unload** (the browser's own prompt). The dialog says "Kaydedilmemiş değişiklikler var — Kaydet / Kaydetmeden çık / Vazgeç". Kaydet runs every dirty form's own save and leaves only if all succeed; otherwise it says so and stays. Kaydetmeden çık drops the edits. `ScreenFrame` mounts the provider, and a nested one reuses its parent. Without a provider only the unload warning remains. |
| `DyInstantToggle` | A switch that applies at once: it moves when clicked, sends the change (through step-up when asked), then says "Kaydedildi ✓" (or a specific line such as "Paylaşım açık.") next to itself. When the master refuses, it moves back and shows why ("Değişiklik geri alındı." + the error). A cancelled code moves it back silently. It never makes a page dirty. |

Strings: the new `forms` namespace of `@remyral/i18n` (TR + EN, `check:i18n` green, no Diyalog file gained hard-coded
strings).

## 2. Rules for a screen

1. **When tabs.** A page with three or more independent areas, or with more than one form, gets tabs: one area per
   tab. A single list, a dashboard or a page with one form stays one page. Tab ids are short and stable (they are URLs).
   A new tab never takes over an existing id; old ids keep working.
2. **One form per tab.** A tab is one `DyFormScope`. Its cards are sections of that form. **No card in a tab has its
   own save button.** The bar saves exactly that tab's fields. Each tab sends only its own part of the resource, even
   when two tabs edit one document: the other tab's fields go as loaded, or the save is a patch of its own part
   (Güvenlik), with the version check.
3. **Several cards, one document.** When cards of one tab write the same document, a later card reads the current
   document before it writes, so an earlier card's save in the same run is kept (Politika: execution → safe commands
   → sub-jobs). A versioned document edited in sections (machine configuration) is **one** form: its section tabs
   are views of it, switching them keeps the edits and asks nothing, and the bar saves the whole document.
4. **Resource lists keep their row actions.** Credentials, users, models, Coolify connections, members, routing rules,
   memory records, personal rules: each row has its own actions (edit, remove, rotate, test). An "add" or "set" form
   of a list keeps its own labelled button. It is not part of the bar. A filled-in add form still counts as unsaved
   for the leave guard.
5. **Actions are not settings.** Buttons that do something now keep their own button and act at once: deploy, restart,
   rotate, test connection, apply a preset or a suggestion, upload a site, fetch logs, roll back, Full access on / off,
   "use the workspace default", log out everywhere. An action on saved values is disabled while the tab has
   unsaved edits ("Mevcut projelere uygula").
6. **Edit-in-place cards.** A card that shows facts and opens its fields with "Düzenle" (repository connection,
   workspace access, storage, repository credential) keeps Düzenle and İptal. Its open fields with changes are a
   section of the tab form, and the bar saves them. Inside a tab form, the git identity's fields are always open.
7. **Action forms with secrets.** Change password and token fields (write-only, an always-fresh code) keep their own
   explicit submit. Typed text still counts as unsaved for the leave guard. The secret is never part of a bar save
   behind your back: the guard's "Kaydet" runs that form's own submit, with its own checks and code.
8. **Instant vs. form.** Only one-bit, reversible changes that are safe to take effect alone are instant. Everything
   that should be reviewed before it takes effect, or that has more than one field, is part of the tab's form.

   | Instant (`DyInstantToggle` or an existing switch that saves at once) | In the tab's form (saved by the bar) |
   | --- | --- |
   | Sohbetlerim: index / share / related lookup | Sohbet → Asistan (machine, runtime, profile, fallback, accounts), Sohbet → Sınırlar |
   | Güvenlik → Otomatik mod | Güvenlik → retry count, Kod doğrulama, Kod istenen olaylar, Ajan otonomisi |
   | Profil: Diyalog arayüzü, Dil (per browser / per account, applied at once) | Bildirimler → Kanallar, Bildirim türleri |
   | Bildirimler → Ses (this browser) | Entegrasyonlar → GitHub: default git identity |
   | Project: MCP sunucuları, Paket önbellekleri | Project Politika / Ağ erişimi / Sınırlar cards, Depo, Makineler, Deploy targets and checks |
   | Deploy: uptime auto-monitor, auto-fix | Machine: configuration document, capacity mode, Acil reserve |
9. **Where errors show.** A client check or a master issue sits under its field (`aria-invalid`, `aria-describedby`).
   The bar then says the save failed and focus moves to the first invalid field. A refusal that is not about one
   field (version conflict, rate limit with its Retry-After wait, permission) is the `DyApiError` band inside the
   card. A 409 on a versioned document reloads it and keeps the band.
10. **Step-up.** Never ask for a code up front for a form. Save; if the master answers `403 step_up_required`, the
    step-up dialog opens (with the form's reason) and the save is retried once. Cancelling keeps the edits and shows
    no error. Policies that are always protected (tokens) ask every time; that is the master's decision.
11. **Viewers.** Fields are disabled or shown as facts, the bar never appears, and no row action is shown.
12. **Phones.** Tabs scroll sideways with the end fade (p14). The bar sits above the tab bar
    (`bottom: 4rem + safe area`) and never covers the field being edited. Buttons stay ≥ 44 px.

## 3. What moved

| Screen | Before | After |
| --- | --- | --- |
| Ayarlar → Profil | 7 cards | Görünüm ve dil (instant) · Oturum · Parola (action form) · Kişisel kurallar (list) |
| Ayarlar → Güvenlik | 6 cards, one global save + instant auto mode | Otomatik mod · Hazır ayarlar (actions) · Kod doğrulama · Kod istenen olaylar · Ajan otonomisi — each its own patch |
| Ayarlar → Sohbet | 4 cards, one save for assistant + limits | Sohbetlerim (instant, undo on error) · Asistan · Sınırlar |
| Ayarlar → Bildirimler | sound + one form for targets and matrix | Ses · Kanallar · Bildirim türleri |
| Ayarlar → Entegrasyonlar | overview + every provider stacked | Genel bakış · GitHub (+ git identity in the form) · Coolify ve Cloudflare · Amazon Bedrock |
| Projeler → proje | Politika: 15 cards, 13 save buttons | Politika · **Ağ erişimi** · **Sınırlar ve yönlendirme** (new tab ids `network`, `limits`; `?tab=policy` unchanged) — each one form |
| Projeler → Depo / Makineler / Deploy | one save per card | one form per tab; Düzenle / İptal and actions kept |
| Makineler → makine → Yapılandırma | own Kaydet / Vazgeç | one document form with the bar; section tabs are views |
| Makineler → makine → Genel bakış → Kapasite | two save buttons | one form (mode, Acil reserve); Apply and caches act at once |

Left as one page on purpose (rule 1): Cihazlar (two lists), Yedekler and Makine sürümleri (status pages with
actions), Runtime'lar, Modeller, Kimlik bilgileri, Kullanıcılar, Bağlam (resource lists), Hafıza and Üyeler tabs
(lists). The classic console is unchanged. Only Güvenlik is a Diyalog view that the classic console also renders, and
there it brings its own guard.

## 4. Parity

No control was removed. Every former per-card "… kaydet" button inside a tab form is replaced by the tab's bar, and
the same request is sent with the same body, checks and step-up. Outside a tab form (a card reused elsewhere, e.g.
Kullanım → Kısıtlar' account defaults, the global routing rules) the card keeps its button. Every former tab id still
lands. The old Politika panels are split across three tabs; none was dropped. Specific success lines ("Kuyruk ayarları
kaydedildi.", "g3 olarak kaydedildi") are kept next to their card, and the bar adds the "Kaydedildi" toast. Two
behaviours are new: the guard question, and the safe-command / sub-job saves reading the current execution document
first. Before, saving the execution card and then the safe-command card from the same load reverted the first.

## 5. Security review

Presentation and client flow only. There is no new endpoint, request type, storage or permission, and the master still
decides every write and every step-up. Notes:

- The guard never saves on its own: "Kaydet" in the dialog runs the same save the bar would, with the same checks and
  step-up. Token fields keep their explicit submit.
- Link interception covers only same-origin `<a>` elements (plain left click, no target, no download). Any other
  click is untouched. The browser shows its own unload prompt, so no text of ours appears there.
- `useOptionalStepUp` only reads the provider. A form outside one saves without step-up and the master refuses as
  before.
- Instant switches roll back on refusal, so the screen never claims a state the master did not accept.
- No inline script or style, no new dependency, CSP unchanged.

## 6. Tests

- `apps/web/test/p15-form-pattern.test.tsx` (16 tests) covers the parts. Tabs: URL sync, keyboard, one tab stop. Form:
  dirty against the loaded value, bar only while dirty, discard, busy state, saved toast, Enter and ⌘/Ctrl+S, client
  field errors, master issues on fields, non-field refusal. Guard: dialog on tab switch (stay / leave / save; a failed
  save stays), in-app link, unload only while dirty, a clean form never asks. Multi-section tab form: in-order save,
  stop at failure, discard all. Instant toggle: optimistic apply with "Kaydedildi ✓", undo on refusal. Helpers.
- `apps/web/test/p15-form-pattern-screens.test.tsx` (4 tests) uses real screens. Güvenlik: a dirty tab asks, the save
  in the dialog sends only that tab's patch, the next tab sends only its own patch against the new version. The
  classic console's Güvenlik is guarded too. Otomatik mod saves at once and moves back on a refusal. Politika: one bar
  saves the execution and safe-command cards without losing the first, and a rail link asks first.
- Existing screen tests were adapted to the tabs and the bar (none deleted): settings account, integrations, final
  integrations, Coolify connections / targets, project policy / rest / deploy / projects, roles, repo egress,
  workflow functions (HTTP allowlist), runtime accounts, skill import, machine config / admin, i18n, auth, confirm,
  security-chat-direct.

Screenshots (WebP, 960 px desktop / 390 px phone, light): `p15-form-pattern/before/` and
`p15-form-pattern/after/`. The three screens are Ayarlar → Profil, Ayarlar → Sohbet and
Projeler → Politika. `after/` adds a dirty bar (`*-dirty-desk`), the leave question (`project-policy-guard-desk`) and
the password tab.

## 7. Known limits

- The browser back / forward buttons are not intercepted under the declarative `BrowserRouter` (that needs a data
  router). Edits are then lost without a question; reload and close are covered.
- Programmatic `navigate()` (⌘K palette, a button that navigates) is not intercepted. Only links are.
- Cards outside a tab form (reused elsewhere) keep their own buttons; that is intended, not a gap.

## 8. Rollback

Revert the p15-form-pattern commits. No data, migration, configuration or worker release is involved.
