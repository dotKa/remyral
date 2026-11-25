# p9-notification-sound — a robotic notification sound in the console

Status: implemented (2026-10-17). Owner request: "messages and notifications should play a notification sound in the
browser — a robotic notification sound". Web only: no master change, no migration, no worker release, no new ADR.
Builds on [p9-chat-unread](p9-chat-unread.md) (unread detection, `invalidate('chat')`) and [p8-pwa](p8-pwa.md) (push,
service worker).

## 1. What the user gets

| Event | Chime | Category (setting) |
| --- | --- | --- |
| A new answer / note in a chat conversation that is not the one visible and focused | two rising square blips (~300 ms) | Chat messages |
| A new in-app notification in the bell (any kind the user receives) | three stepped square beeps (~360 ms) | Notifications |
| `approval.requested`, `approval.expiring`, `deploy.waiting`, `automation.waiting` | four fast alternating sawtooth beeps (~460 ms), a little louder | Approvals |

Settings → Notifications → **Sound**: on/off (default on), volume (0–100, default 60), the three categories, a Play
button per category and "Test sound". It applies at once (no Save).

## 2. The sound (`apps/web/src/sound/synth.ts`)

Synthesised at play time with the Web Audio API — no file, no fetch, nothing for the CSP (`media-src` is not involved;
an `AudioContext` needs no directive). Per beep: oscillator (square / sawtooth) with a small upward glide → a
`WaveShaperNode` with an 8-step staircase curve (bit-crushed edge) → full-depth amplitude modulation by a sine at an
inharmonic ratio of the pitch (0.5 / 0.71 / 1.41 — the ring-mod "robot" colour) → an envelope with a 6 ms attack and
25 ms release (no clicks) → a shared 3.8 kHz low-pass → the volume gain (peak 0.22 at 100, squared slider). All nodes are
disconnected when the last oscillator ends.

Rendered in headless Chromium with an `OfflineAudioContext` at volume 60: 300 / 360 / 460 ms audible, peak ≈ 0.09, largest
sample-to-sample step ≈ 0.04 (no click). How "robotic" it sounds is for the owner's ears (§9).

## 3. Autoplay policy and one tab per browser

- **Gesture.** Browsers start an `AudioContext` only after a user gesture. Every console tab listens (capture, passive)
  for its first `pointerdown` / `keydown` and creates or resumes its context there. Until the context runs, a chime is
  skipped silently — never queued and replayed later. A context the browser suspends again (iOS interruptions) is
  resumed by the next gesture. No Web Audio at all: the settings card says so and nothing plays.
- **Leader.** Only a tab whose audio runs competes for leadership, so the leader can always play. With the Web Locks
  API (`navigator.locks`, all current browsers) the leader holds the exclusive lock `remyral-sound-leader`; closing it
  hands the lock to the next waiting tab immediately. Without Web Locks, a localStorage lease (`remyral.sound.leader`,
  renewed every 2 s, valid 6 s, read back after writing). Neither available: the tab plays on its own (a rare double
  sound beats none).
- **Hints between tabs.** A separate BroadcastChannel `remyral-sound` (not the auth channel) carries only three data-free
  signals: `chat` (a tab saw `invalidate('chat')`), `own-action` (the user sent a mutation) and `activity`. The leader
  always re-asks the master; it never trusts a message's content.

## 4. Settings storage — decision

**localStorage, per user per browser** (`remyral.sound.v1.<userId>`), every access in try/catch (private mode, blocked
storage or a full quota fall back to the defaults; a value that cannot be stored stays for the tab until reload). Why
not the server's notification preferences: volume and "sound on" are properties of the device (laptop speakers vs. a
desk set-up, a shared office machine), the existing preferences are per kind × channel and changing them can need a
step-up; adding a server field would need a migration and a master release for no benefit. Tabs follow changes via the
`storage` event.

## 5. When it plays (`controller.ts`, `useNotificationSound.ts`)

- **Detection (leader only).** Every 30 s: `GET /notifications?limit=20` and `GET /chat/unread` (the same routes the bell
  and the Chat badge use). The first look after becoming leader is the baseline — nothing already there sounds.
  - Notifications: an id not seen before and still unread → chime (approval kinds → urgent).
  - Chat: the unread total rose → wait 1.5 s → ask again; only if it is still higher than before does it sound. The
    conversation the user is looking at (visible + focused) is marked read within that time by p9-chat-unread, so it
    never sounds; the user's own messages never count as unread on the server. A `chat` hint (this or another tab saw
    a message, e.g. the hidden tab's open conversation stream) makes the leader look at once.
- **Hidden tabs.** The leader keeps checking while hidden (that is the point), but only while the user used a console
  tab of this browser within the last 15 minutes. Every request refreshes the session's `last_seen_at`; without the
  limit a forgotten background tab would keep a 30-minute idle session alive for ever. After the window only pushes
  (server-driven) still sound. Bounded effect: a session can outlive the user's last input by at most ~15 min + the
  idle timeout.
- **Own actions.** The API client announces every mutation it sends (except `/auth/*`, `/notifications/*` and the
  chat read routes, `lib/ownActions.ts`); other tabs hear it on the channel. Notifications first seen within 10 s
  after it are its echo (e.g. the approval request of the job just started) and stay silent; the leader checks again
  3 s and 8 s after the action so that the echo is seen inside that window.
- **Rate.** Requests within 300 ms coalesce into one chime of the most important category (approvals > notifications >
  chat). At most one chime per 2 s: a request inside the gap is dropped, unless it is more important than the chime just
  played — then it plays once when the gap ends. Settings are re-read when the chime fires.
- **Do Not Disturb.** A web page cannot see the OS's Do Not Disturb / focus mode; the settings card says so. Muting is
  available here, per browser tab, or in the system.

## 6. Push while the console is open (PWA)

The service worker's `push` handler now asks the open console windows before showing the notification: it posts
`{type:'remyral:push', id, kind}` (validated id / kind from the push payload) with a `MessageChannel` port to each window
and waits up to 400 ms. The leader answers `{handled:true}` when it plays the chime (or when the push is the echo of the
user's own action, or already sounded); other tabs answer `false`. Handled → `showNotification(..., {silent:true})`, so
the OS does not play its own sound on top; no answer / all no (no window, sound off for that category, audio not
unlocked, an older console build) → the notification keeps the system sound. The notification is always shown (browsers
revoke the permission of silent pushes). The push's id is remembered, so the next check does not sound it again.

## 7. Tests

`apps/web/test/notification-sound.test.tsx` (fake `AudioContext`): three distinguishable variants of 300–500 ms with
envelopes from and to 0, volume curve and silence at 0, node clean-up; no context before a gesture, one context per tab,
a suspended context skips silently, no Web Audio never plays; settings defaults / per user / garbage / throwing storage;
gate coalescing (most important wins), 2 s gap with the priority exception, master switch / volume 0 / category off /
switched off while waiting, no play without audio; watcher baseline, read-elsewhere, approval → urgent, own-action
echo silent, chat confirm (read meanwhile → silent; still higher → chime; falling never), push handled once; Web Locks
and storage-lease elections (hand-over, expiry of a crashed leader); two tabs together: no gesture → no checks and no
sound, only the leader plays, hand-over with a fresh baseline, chat hint from another tab, `invalidate('chat')`, echo
after `announceOwnAction`, hidden tab within / after the activity window and revived by activity elsewhere, the
service-worker answer (leader yes, muted no, stopped no, throwing handler no); service worker side: payload validation,
first yes / all no / timeout / no windows; the settings card (volume, category, Test sound at the chosen volume, Play
per category, disabled when off, no Web Audio message).

## 8. Security review

- **No new data flow to the server; no new routes.** The leader uses two existing GET routes the console already polls,
  only in one tab, at the same 30 s cadence; hidden-tab polling is bounded (§5) so it cannot defeat the session idle
  timeout indefinitely.
- **CSP unchanged.** No audio files, no `blob:`/`data:` media, no external fetch. Web Audio needs no directive.
- **Cross-tab messages** carry no data (three fixed strings, validated on receipt); the channel is same-origin by
  definition. The service-worker message carries a notification id and kind validated by regex on both sides
  (`[A-Za-z0-9-]{1,64}`, `[a-z][a-z0-9._-]{0,63}`); the answer is a boolean. A page cannot use it to suppress a
  notification — only its sound — and every push still shows a notification.
- **localStorage** holds only booleans, a volume and the lease (tab UUID + expiry); nothing sensitive. Keys are per user
  id, so two accounts on one browser keep their own settings.
- **Audit.** Local UI preferences are not privileged actions; nothing is audited.

## 9. Not verified / owner

- **How it sounds** — the timbre and loudness on real speakers ("robotic enough?") need the owner's ears. Reference
  renders (Chromium `OfflineAudioContext`, volume 60) were produced during development; tune `PATTERNS` / `PEAK` in
  `synth.ts` if wanted.
- **Safari / iOS**: `silent` on `showNotification` is ignored by Safari (the system sound may play together with the
  chime); Web Locks needs Safari ≥ 15.4. Chromium-only verification, like the rest of the console's e2e.

## 10. Rollback

Web only: redeploy the previous web image. The localStorage keys are ignored by older builds. The service worker updates
with the build (the old worker shows notifications with the system sound, as before).
