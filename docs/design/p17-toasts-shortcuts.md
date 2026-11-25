# Design note: `p17-toasts-shortcuts` — toast notifications and modifier shortcuts in the Diyalog panel

- **Task:** `p17-toasts-shortcuts`. **Date:** 2026-10-25. **Migration:** none. **Master / worker release:** none (web
  only).
- **Owner direction (2026-10-25):**
  - "şimdi çalıştır a bastım, çalıştırma başladı metni altında belirdi. bu doğru bir ui/ux değil. toast bildirimler
    tasarlayalım ekranın sağ altından çıksın. yeni bildirim geldiğinde de önizlemesi orada görünür."
  - "sesli dikte için bir kısayol tuşu olmalı. chat ekranında çalışmalı. ayrıca kısayollar direkt harf değil option +
    n vs. şeklinde olsun. bu şekilde yanlışlıkla sayfa değiştirebiliyoruz. chat sayfasına gidince input a
    focuslanmalı, yeni chat e bastığımızda vs."
- **Builds on:** p12-diyalog (shell, bell, palette), p9-notification-sound (own-action echo, per-browser settings),
  p15-form-pattern (save bar, instant switch), p16-chat-complete (dictation), p17-panel-motion (motion tokens),
  p17-needs-page.

## 1. Summary

1. One toaster for the Diyalog shell (`diyalog/toast/`): action results ("Kaydedildi.", "Çalıştırma başladı.",
   "Kopyalandı.") leave the line next to the button and appear at the bottom right (phones: bottom, above the tab bar
   and the Sohbet composer).
2. A new notification shows a preview toast there (title, first line, "Aç"); several at once are one toast.
3. Page shortcuts are Option / Alt + letter (never a bare letter); Option / Alt + D dictates in the Sohbet composer;
   the caret goes to the composer when the chat opens.

## 2. Toasts

### 2.1 API (`diyalog/toast/store.ts`)

`toast({ tone, title, description?, actions?, link?, duration?, id?, icon?, testId? })` and the shorthands
`toast.success / info / warning / error(title, opts)`. Module state, one queue per tab, callable from anything (a
handler, a hook, a background watcher). Texts arrive in the console language (the caller reads its catalog) and are
rendered as React text.

| Rule | Value |
| --- | --- |
| Durations | success / info 5 s, warning 8 s; a long text gets `2 s + 60 ms × characters`, at most 12 s (WCAG 2.2.1: time to read); `duration: Infinity` keeps it |
| Errors | stay until dismissed |
| Same `id` | replaces the toast in place (moved to the top, timer restarted) — a second save, a growing notification burst |
| Queue | at most 12 (beyond: the oldest that would expire goes first) |
| Actions | at most two buttons; `to` makes one a router link; an action closes the toast unless `keepOpen` |

`useDoneToast(text, opts)` (`toast/useDoneToast.ts`) bridges screens that kept a `done` / `notice` string next to a
form: each time the text is set it becomes a toast.

### 2.2 Toaster (`diyalog/toast/DyToaster.tsx`)

Mounted once in `DiyalogShell`, inside `[data-ui='diyalog']` (light / dark tokens: `bg-dy-card`, `border-dy-line`,
`shadow-dy-pop`, a 4 px tone edge — green / teal / amber / red — and the tone icon; both themes from the existing
tokens).

- **Stack:** newest on top; at most 3 shown, older ones collapse into a "+N bildirim daha" pill drawn as card edges
  behind it; clicking it expands the whole queue (scrollable, max 70 vh) and "Daha az göster" folds it back. A
  collapsed toast that expires leaves without an exit.
- **Timers:** paused while the mouse is over the toaster (`pointerType === 'mouse'`), while the keyboard is inside it,
  and while the tab is hidden — a toast nobody could read does not expire; each resumes with what it had left.
- **Focus:** never taken. Option / Alt + T (`aria-keyshortcuts="Alt+T"`, also in the region's name "Anlık bildirimler
  (⌥T)") moves the keyboard to the newest toast; Tab reaches its buttons; Esc dismisses the focused toast and moves
  to the next one, or back to where the keyboard was before it entered the toaster.
- **Touch:** a sideways swipe (64 px or a quick flick) dismisses; a shorter one springs back. Buttons inside do not
  start a swipe; vertical scrolling stays with the page (`touch-action: pan-y`).
- **Screen readers:** the region is a labelled `<section>`; each toast's `aria-label` is "Tone: title. description"
  ("Tamam: Kaydedildi."). Announcements go through two live regions that exist from the first render (a region added
  together with its text is not read reliably): `aria-live="polite"` for success / info / warning,
  `aria-live="assertive"` for errors, both `aria-atomic`, with the same "Tone: …" text. They carry no `role` (a
  page-wide `status` / `alert` would be found by every "the alert on this screen" query of the screens) and the list
  itself renders only while a toast is shown. Each version of a toast is announced once.
- **Modal dialogs:** a modal makes the rest of the page inert, the toaster too. A result produced inside an open
  modal stays inside it: `insideModal(el)` (store.ts) keeps the copy buttons' and the command block's result next to
  the button there, and the workflow trigger activation dialog keeps its result line.

### 2.3 Placement (`chat/chat.css` `.dy-toaster`)

Desktop: `right: 1rem`, `bottom: var(--dy-dock-h) + 1rem`, `min(24rem, 100vw − 2rem)` wide. Phones (< 48 rem): full
width with the safe-area insets, `bottom: 3.5rem (tab bar) + safe area + --dy-kb (on-screen keyboard) +
--dy-dock-h + 0.5rem`; while the composer has focus the tab bar is hidden (index.css) and its 3.5 rem goes too.
`--dy-dock-h` is the Sohbet composer dock's height, kept on `<html>` by the composer (`useDockHeight`, ResizeObserver)
and removed when it unmounts — so a toast never covers the composer on any width.

### 2.4 Motion (`motion.css` "toasts", `motion-tokens.css`)

New tokens `--dy-m-toast: 200ms` and `--dy-m-toast-exit: 150ms` (the dialog's values: §3.7 of p17-panel-motion —
entries ≤ 400 ms, exits faster). Entry from `@starting-style`: 8 px rise from 0.98 and a fade on `--dy-m-out`; exit:
fade and a 24 px slide toward the side it was swiped to. `usePresence` keeps the toast until the transition ends.
Swiping moves it with the finger (`--dy-toast-x`, no transition while dragging). Reduced motion (system or
`[data-motion='reduce']`): no transition, no transform — it appears and goes at once, and `usePresence` unmounts in
the same commit.

### 2.5 New-notification preview (`diyalog/toast/notificationPreview.ts`)

- **Source:** the pages of notifications the tab reads anyway are shared through `lib/notificationFeed.ts`: the
  bell's 30 s poll (while visible, on becoming visible, on a push), the sound leader's checks. The preview reads a
  page itself only when none was shared for a poll interval (a screen without a bell), on becoming visible, 1.5 s
  after a push the bell did not answer, and 3 s / 8 s after the person's own action (so its echo is seen inside the
  grace window). No second 30 s poll while a bell is on screen.
- **"Senden bekleyenler" stream:** `/ops-thread` needs no hook of its own — every card that waits for the person
  (approval, deploy, automation, question) comes with its notification (`approval.requested`, `deploy.waiting`,
  `automation.waiting`, `job.question`…), and the needs screen marks the ones it shows as read; a read notification
  is never previewed.
- **Never previewed:** the first page (baseline), read notifications, anything new within `OWN_ACTION_GRACE_MS` (10 s)
  of a mutation sent from this browser — the same `OWN_ACTION_EVENT` and the same cross-tab `own-action` hint as the
  notification sound (`apps/web/src/sound`); a notification whose link is the page the person is on; everything while
  **Ayarlar → Bildirimler → Ses ve önizleme → "Yeni bildirimleri önizle"** is off (per browser and user, stored with
  the sound settings as `previews`, default on; read at each arrival).
- **One toast per burst:** one new notification → its title, its first non-empty line (≤ 140 chars) and "Aç" (link
  to its target; marks it read). Several → "3 yeni bildirim", "En yenisi: …", and "Aç" when they share a target or
  "Bildirimleri göster" (opens the bell, `OPEN_BELL_EVENT`) otherwise. A burst arriving while the preview is still
  open adds to it (same toast id). Tone: critical → error (stays), warning or a decision kind → warning, else info.
  The toast has the bell icon. Sound is unchanged (the sound settings decide it; the preview never plays).

## 3. Shortcuts

### 3.1 Matching (`shell/keys.ts`)

`isAltCombo(e, letter)`: `altKey` and none of Ctrl / Cmd / Shift, not a repeat, not composing, and
`e.code === 'Key' + LETTER`. `event.code` because macOS Option changes the character (`⌥D` → `∂`, `⌥N` / `⌥E` /
`⌥U` / `⌥I` are dead keys) — `event.key` cannot match there. Requiring Ctrl up also keeps AltGr (Ctrl + Alt on
Windows: the Turkish `@`, `€`) from ever firing a shortcut. Labels: `altLabel('j')` → "⌥J" on Apple platforms, "Alt+J"
elsewhere; `aria-keyshortcuts` always says `Alt+J`. Nothing fires while typing (input, textarea, select,
contenteditable) or with a modal `<dialog>` open — except the dictation combo, which is meant for the composer.

### 3.2 Table (old → new)

| Action | Before | Now |
| --- | --- | --- |
| Ana sayfa | `g` `h` | ⌥H / Alt+H |
| Sohbet | `g` `c` | ⌥C / Alt+C |
| Senden bekleyenler | `g` `a` (went to /approvals) | ⌥A / Alt+A (→ /needs) |
| İşler | `g` `j` | ⌥J / Alt+J |
| Makineler | `g` `m` | ⌥M / Alt+M |
| Projeler | `g` `p` | ⌥P / Alt+P |
| Ayarlar | `g` `s` | ⌥S / Alt+S |
| Yeni iş formu | `n` | ⌥N / Alt+N |
| Sesli dikte (Sohbet) | — (button only) | ⌥D / Alt+D, also from the message box |
| Anlık bildirimlere git | — | ⌥T / Alt+T |
| Komut paleti | ⌘K / Ctrl+K | unchanged |
| Bu ekranda ara | `/` | unchanged (not a letter; only focuses the page's search) |
| Kısayollar | `?` | unchanged (not a letter; opens the help dialog) |
| Sonraki / önceki kart | `j` / `k` anywhere outside a field | `j` / `k`, only with the keyboard in the thread (§3.3) |
| Onayla / reddet (odaktaki kart) | `a` / `d` | unchanged, focused card only (§3.3) |
| Workflow editor: palette | `/` inside the editor | unchanged (editor-scoped `onKeyDown`) |
| Workflow editor: save / undo / redo | ⌘/Ctrl + S / Z / ⇧Z / Y | unchanged |
| Form save | ⌘/Ctrl + S inside a form | unchanged |

### 3.3 Decision on the in-list keys

`j` / `k` / `a` / `d` stay single letters: they are list keys, not page keys. They never change the page; `a` / `d`
only open the decision row of the focused card (the decision itself still needs its button and, where the policy
asks, a code). They now apply only while the keyboard is in the thread (focus inside the thread root) or nowhere yet
(document body — the page just opened), never with focus in the rail, a top-bar menu or another panel
(`keyboardInThread`). The old `g`-chord bookkeeping is gone with the chords.

### 3.4 Dictation (`ops/composerKeys.ts` `useDictationShortcut`)

Option / Alt + D toggles dictation while the Sohbet composer is on screen, dictation is supported and the composer is
not locked; it works with the caret in the composer and from the page (then the caret goes to the composer, where the
words appear). Never while another field has the keyboard or a dialog is open. The microphone button's tooltip says
"Sesle yaz (⌥D)" / "Dinlemeyi durdur (⌥D)" and has `aria-keyshortcuts="Alt+D"`. Hold-to-talk was not added: the
browser's recognition is start / stop, and a held Option key repeats.

### 3.5 Composer focus (`useComposerFocus`)

Every navigation the Sohbet screen sees (the screen opened, a conversation opened, "Yeni sohbet", the palette's "Yeni
sohbet") asks for the caret (`focusRequest = { key: location.key, explicit }`). With a fine pointer (desktop,
`(pointer: fine)`; an unknown pointer counts as not fine) the composer takes it; on touch only when the navigation carries the explicit "Yeni sohbet" flag (`dyFocusComposer` router
state, set by the list's button and the palette) — a route change alone must not pop the on-screen keyboard. It never
takes focus from a dialog, another text field or an open menu / listbox, and gives up after 4 s (a composer locked
while loading). `preventScroll` keeps the thread where it was.

### 3.6 Help

The `?` dialog lists every combo with this platform's names (⌥ / Alt, ⌘K / Ctrl K) in one key cap each (Shift +
Enter too — it was drawn as "⇧ sonra ↵"), plus dictation and the toaster key; the palette shows a page's combo as its hint (İşler "⌥J", Yeni iş "⌥N"). i18n tr + en.

## 4. Converted inline messages

Transient results became toasts; validation errors, field hints, failures next to the action and lasting states stay
inline. Shared primitives first (each covers many screens):

| Where | Before | Now |
| --- | --- | --- |
| `formkit/form.tsx` `DyFormBar` (every tab form with the sticky save bar) | "Kaydedildi" pill under the form | success toast (`id: form-saved`, 2.6 s) |
| `formkit/instant.tsx` `DyInstantToggle` (every instant switch) | "Kaydedildi ✓" / custom text next to the switch | success toast; "Kaydediliyor…" and a refusal stay inline |
| `common/actions.tsx` `DyCopyButton` (≈40 copy buttons) | "Kopyalandı." next to the button | toast (failure: error toast); the tick icon stays |
| `CodeBlock.tsx` (commands) | sr-only status | toast; the button label still turns into "Kopyalandı" |
| `projects/tabs/policy-common.tsx` `SaveResult` (15 policy forms) | green "Kaydedildi" line | toast |

Screens:

| Screen | Before | Now |
| --- | --- | --- |
| Otomasyon → "Şimdi çalıştır" | "Çalıştırma başladı." / "Atlandı: …" under the button | toast with **Çalıştırmayı aç** (its job, workflow run, or the Çalıştırmalar tab) |
| Job → süre sınırı | "applied" line | toast; refusal / failure inline |
| Onay kartı → süreyi uzat | "extended" / failure line | toast; failure inline (red) |
| Kullanım → limit pencereleri → Yenile | green notice | toast (warning when something failed or was skipped) |
| Kullanım → limit pencereleri → temizle | green notice | toast |
| İşler → Kuyruk → taşı | the master's note in a band | info toast |
| Çıktılar → klasöre ekle | green notice | toast |
| Job → entegrasyon → birleştirme isteği | grey note | info toast with **Senden bekleyenler** |
| Job → değişiklikler → istek aç | grey note | info toast |
| Job → önizlemeler → onay bekliyor | grey note | info toast with **Senden bekleyenler** |
| Ayarlar: Operasyon güvenliği (4 forms), Webhook'lar (+ teslimatlar), Güvenlik (2), Servis hesapları (2), sürüm freni, Cihazlar, API token'ları, Runtimes, Git sağlayıcıları, Operasyon entegrasyonları | green `done` / `notice` notice | toast (`useDoneToast`, test ids kept on the toast) |
| Projeler: Coolify (env, domains, settings), deploy ayarları, repo kimlik bilgisi, Git kimliği | green notice | toast |
| Kullanım: öneriler, bütçeler, fiyatlar, limit uygulama | green notice | toast |
| Bilgi: MCP sunucuları (2), MCP kurulum, MCP keşif, beceri kataloğu, beceriler | green notice | toast |
| Makineler: toplu yapılandırma, kapasite modu / önerisi / slotlar, sandbox politikası, yapılandırma | green notice | toast |
| Onaylar (karar sonucu), Servisler (başlatıldı), kurulum sihirbazı alan adı adımı | green notice | toast |

Kept inline on purpose: results inside a modal dialog (workflow trigger activation; copy buttons in a modal), connection-test results (storage, Bedrock, git host — a state of the form), anything with a
link or a secret shown once (GitHub webhook set-up, a created repository, a new token), diagnostics run results,
release roll-out state, the memory-import undo line, deploy-site upload readiness, every error band
(`DyApiError`, `ErrorLine`). The remaining one-off green notices whose content is not a plain string followed in
`p17-toasts-rest` (§4.1).

### 4.1 `p17-toasts-rest` (2026-10-25) — the remaining spots, decided one by one

Rule: a transient result of the person's own action → toast (called from the handler, `toast.success(text, { id,
testId })`, so a repeat replaces it); something to keep reading — a link or next step, a once-shown value, a result
inside a modal, a lasting state of the page — stays inline. Failures stay next to the action everywhere.

| Spot | Message | Decision |
| --- | --- | --- |
| ProfileView → Dil / Language | "Dil kaydedildi." | **toast** (`language-saved`; in the new language); the failure stays inline |
| ProfileView → Ayrıcalıklı işlemler | "Doğrulandı. … 10 dakika …" | **toast** (`privileged-confirmed`) |
| ProfileView → Parolayı değiştir | "Parola değişti. Diğer bütün oturumlar kapatıldı." | **toast** (`password-changed`) |
| ProfileView → Kişisel kurallar (add / edit / retire) | "… eklendi" etc. | **toast** (`personal-notice`, same test id) |
| repo-sections: Depo, Entegrasyon, Çalışma alanı, Depolama | "… kaydedildi" | **toast** — saved from the tab's sticky bar, the bar's own "Kaydedildi" toast is the one result (no second toast); saved with the section's own button (outside a tab form), its own text (`repo-git-saved`, `repo-integration-saved`, `workspace-settings-saved`, `workspace-storage-saved`). The connection test result stays inline (a state of the form) |
| MachinesTab → makine ataması | "Kaydedildi. Değişen her makine …" | **toast** as above (bar → the bar's toast; own button → `project-machines-saved`); the per-machine "Henüz uygulanmadı" state in the list is what lasts |
| ReportsView → rapor ayarları | "Rapor ayarları kaydedildi." | **toast** (`report-settings-saved`) |
| EnforcementView → sınıra yakın / varsayılan limit (boolean `saved`) | "Kaydedildi." / "Çalışma alanı varsayılanı kaydedildi." | **toast** (`near-settings-saved`, `usage-limit-default-saved`); the policy problem line stays |
| WorkfilesPanel → dışa aktar (branch, PR / repo link) | "… gönderildi" + links | **inline** — inside a modal and carries links |
| WorkfilesPanel → siteye yükle | "N dosya …" + "Aç" link | **inline** — inside a modal, carries a link |
| WorkfilesPanel → temizle | "Çalışma dosyaları silindi." | **toast** (`workfiles-cleaned`); a failure stays next to the files |
| integrations-github → kurulumları yenile | "Kurulumlar GitHub’dan yenilendi." | **toast** (`github-synced`) |
| integrations-github → anahtar yenile | "Anahtar yenilendi. Şimdi eski anahtarı GitHub’da silin." | **inline** — a next step the person must still do |
| integrations-github → otomasyon webhook'u | URL + GitHub settings link + events | **inline** (link, set-up facts) |
| integrations-github → App bağlandı / kuruldu / hesap yetkilendirildi (callback pages) | state + next button | **inline** — the page's lasting state |
| integrations-github-repos → belirteç (PAT) | "alice için belirteç kaydedildi." | **toast** (`github-pat-saved`; the token is never shown) |
| integrations-github-repos → yeni repo | name, link state, warnings, "GitHub’da aç" | **inline** — inside a modal, with a link |
| CredentialsView → anahtar yenileme isteği | "… için yenileme istendi; …" | **toast** (`vault-rotate-requested`); the new fingerprint appears in the table when the machine reports |
| DiagnosticsView → destek ayarları | "Destek ayarları kaydedildi." | **toast** (`doctor-support-saved`) |
| DiagnosticsView → rapor gönderildi | to / cc / time, "only the summary" | **inline** — the record of what was sent (with the size caveat) |

Tests (results waited with `findToast` / `waitFor(toastByTestId)`, no timers): `diyalog-auth`, `i18n` (language in
the new language), `diyalog-w3-settings-account` (personal rule, new: password changed), `diyalog-w3-project-rest`
(Depo and Makineler: one bar toast, no section toast), `diyalog-git-providers` (Depo with GitLab), `diyalog-usage` (near settings, default, reports),
`diyalog-final-integrations` (sync), `github-create-repo` (PAT), `diyalog-w3-settings-admin` (new: vault key rotation
request), `workfiles` (clean), `diagnostics` (support settings).

## 5. Security and privacy

No new data leaves the browser. Toast texts are React text (no HTML). Preview links are the notification's
`safeLink` (in-app paths only). The preview marks a notification read only when "Aç" is pressed. The settings flag is
per browser and user in localStorage (same store as the sound settings; nothing sensitive).

## 6. Tests

- `apps/web/test/p17-toasts.test.tsx` — store (replace by id, durations, cap), toaster (stacking / "+N" / expand,
  focus never taken, live regions, timers with hover / focus / hidden pause, Option + T and Esc focus flow, actions
  and links, swipe, reduced motion), `PreviewWatcher` (baseline, read, own-action grace, settings, "here"),
  `showPreview` (one, burst, growing burst, tone, open bell), the shell hook (own baseline read, bell pages,
  own-action echo, settings).
- `apps/web/test/p17-shortcuts.test.tsx` — combo matching (event.code with Option characters / dead keys, AltGr,
  Shift, repeat), page combos and the old bare letters, typing / dialog guards, `?`, card keys scope, help dialog
  labels per platform, palette hints, dictation shortcut (page / field, guards, tooltip), composer focus (desktop,
  touch, explicit "Yeni sohbet", guards).
- Updated (a result that moved into a toast is looked up as a toast — `test/toasts.ts`: `findToast`,
  `toastByTestId`; `test/setup.ts` empties the queue after each test): p15-form-pattern, diyalog-automations,
  diyalog-approvals, diyalog-final, diyalog-job, diyalog-new (Option / Alt + N), diyalog-primitives, diyalog-usage,
  diyalog-w3-machine-admin, diyalog-w3-machine-config, diyalog-w3-machine-list, diyalog-w3-settings-account,
  diyalog-workflow-functions, diyalog-jobs (queue note), i18n-shell (no chords), coolify-apps, mcp, mcp-stdio,
  repo-egress, runtime-accounts, skill-import.

## 7. Rollback

Web only: revert the commit. No data, no migration; the `previews` flag in the per-browser settings is ignored by an
older build.

## 8. Unverified

Real browsers were not driven in this task (jsdom only): the swipe feel on iOS / Android, VoiceOver / NVDA reading
of the live regions, Safari's handling of `@starting-style` on the toast, and whether a browser on Windows / Linux
acts on an Alt + letter combo itself (Alt + D focuses the address bar in Chrome / Firefox, Alt + F opens a menu)
before or despite the page's `preventDefault` — expected to reach the page first, not checked. macOS Option combos
are matched by `event.code` and were only exercised with synthetic events.

Pre-existing, not caused by this change: `test/p17-memory-import.test.tsx` › "Seni tanıyalım follows the account
step…" fails on the base commit too (the wizard re-reads and moves to the next step before the import result is
asserted).
