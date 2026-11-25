# Design note: the console as an installable PWA with Web Push (P8)

- **Status:** Implemented (real-device push on iOS/Android UNVERIFIED, §10)
- **Date:** 2026-10-16
- **Backlog:** `p8-pwa` (owner: "make the console a PWA — install on phone, push notifications, approve /
  follow jobs / chat from mobile")
- **Decisions applied:** ADR-0006 (secrets only from files, never in logs or messages), ADR-0009 §10
  (step-up for privileged changes), [p1-web-skeleton.md](p1-web-skeleton.md) (same origin, strict CSP, no
  client storage of secrets), [p5-notifications.md](p5-notifications.md) (kinds, preferences, delivery
  queue), [p5-remember-device.md](p5-remember-device.md) (device records), [p5-mobile.md](p5-mobile.md)
  (44 px targets, bottom bar, safe areas), dependency policy (node built-ins preferred, no unreviewed deps)
- **Migration:** `0063_web_push.sql`
- **Threat model:** T-SEC-1 (secrets in messages), T-CP-2 (stolen session redirecting notifications),
  T-CP-3 (disclosure across users), SSRF via user-supplied URLs, cache poisoning / stale authenticated data

## 1. Scope

| Piece | Where |
| --- | --- |
| Manifest, icons (maskable, badge), offline page | `apps/web/public/manifest.json`, `icon-maskable-512.png`, `badge-96.png`, `offline.html/.css`; icons rendered from the brand mark by `apps/web/scripts/pwa-icons.mjs` (local Chromium, no network) |
| Service worker (pure decisions + event wiring) | `apps/web/src/sw/logic.ts`, `apps/web/src/sw/sw.ts` |
| Worker build (precache manifest injection) | `apps/web/pwa-plugin.ts` (Vite plugin, production builds only) |
| Registration, update flow, worker messages | `apps/web/src/pwa/serviceWorker.ts`, `apps/web/src/pwa/PwaBridge.tsx` |
| Browser push subscription, install prompt | `apps/web/src/pwa/push.ts`, `apps/web/src/pwa/install.ts` |
| UI: Devices (this device + push devices), push column in notification settings | `apps/web/src/pwa/PushDevicesCard.tsx`, `apps/web/src/screens/NotificationSettingsPage.tsx` |
| RFC 8291 encryption + RFC 8292 VAPID (node:crypto, no dependency) | `apps/master/src/notifications/push/webpush.ts` |
| Subscription store (sealed keys, allowlist, lifecycle) | `apps/master/src/notifications/push/subscriptions.ts` |
| `push` channel (Notifier) | `apps/master/src/notifications/push/notifier.ts` |
| REST | `apps/master/src/notifications/routes.ts` (`/notifications/push*`) |
| Key generation | `apps/master/src/cli/vapid-keygen.ts` (`pnpm --filter @remyral/master vapid:keygen <file>`) |

Out of scope: native apps, background sync, offline data, push for job output streams (the job page keeps
its live SSE view while open).

## 2. Service worker

**Same origin, scope `/`, classic script.** `/sw.js` is built from `src/sw/sw.ts` as its own chunk; the
plugin fails the build if the chunk imports anything (a shared chunk would put worker code in the app
bundle and break the classic script). The app never imports `src/sw/*` (message names are duplicated in
`serviceWorker.ts` and a unit test keeps them equal). Registered only in production builds
(`import.meta.env.PROD`) with `updateViaCache: 'none'`; the dev server never has a worker.

**What is cached — only the hashed static shell.** At build time the plugin lists this build's
content-hashed files under `/assets/` (JS, CSS, fonts; no source maps) plus five fixed shell files
(`/offline.html`, `/offline.css`, `/icon-192.png`, `/badge-96.png`, `/favicon.svg`) and injects them with a
version (SHA-256 of the list) into the worker. `install` precaches exactly that list (`cache: 'reload'`,
`credentials: 'omit'` — no cookie is ever sent for a precache request); `activate` deletes older
`remyral-shell-*` caches.

| Request | Handling |
| --- | --- |
| non-GET, other origins, `/api/*`, `/v1/*` (worker, hooks, installers) | **not intercepted** (no `respondWith`) — the browser behaves as without a worker; no API response, cookie-bearing or not, can reach Cache Storage |
| navigation (`mode: navigate`) | network first; only if the network fails, the precached `/offline.html` |
| a precached path without query string | cache first (immutable hashed names), network fallback |
| anything else (e.g. `/manifest.json`, an older build's asset) | not intercepted |

`index.html` is **not** cached: every navigation fetches the current HTML (it references the current
bundles), so a deploy is visible on the next navigation even before the worker updates.

**Update flow.** A new build changes `/sw.js` (new version string). The browser checks on navigation, on
`registration.update()` every hour and when the page becomes visible. The new worker installs in the
background and **waits** (no `skipWaiting` on install). The page shows "A new version of Remyral is
available. **Reload**"; Reload posts `remyral:skip-waiting`, the worker activates, and the page reloads once on
`controllerchange`. Nothing reloads by itself (a form or a step-up dialog may be open).

**Offline page.** Static, same-origin CSS (no inline styles — CSP), states that nothing from the account
is stored on the device, "Try again" link.

**CSP / headers / Traefik.** No change to the CSP: `default-src 'self'` already covers `worker-src` and
`manifest-src` (both fall back to it), the worker script and every icon are same-origin (COEP
`require-corp` is satisfied), and push service traffic is the browser's own, not the page's
(`connect-src` unaffected). nginx (web image) gains two exact locations: `/sw.js` and `/manifest.json`
with `Cache-Control: no-cache`, GET only, **no fallback to index.html** (`try_files $uri =404`), and the
manifest served as `application/manifest+json`; both carry the same security header set. Traefik routing is
unchanged (both paths fall to the web router; `/api/*` still goes to the master). Verified with the pinned
nginx config against the built `dist/` (headers above) and by the e2e (§8).

## 3. Push subscriptions (per device, bound to the user)

**Data (`push_subscriptions`, migration 0063):** `id`, `user_id` (cascade), `endpoint` (unique, ≤ 2000),
`keys_sealed` (p256dh + auth, AES-256-GCM under `box.deriveKey('push-keys')`, AAD `push-subscription:<id>`),
`label` (coarse "Browser on OS", the trusted-devices `deviceLabel`), `trusted_device_id` (the trusted device
of the registering session, `ON DELETE CASCADE`), `created_ip`, `created_at`, `last_seen_at`,
`last_success_at`, `failures`.

**Registering** (`POST /notifications/push/subscriptions`, body = `PushSubscription.toJSON()`):

1. the endpoint must be an absolute URL on an **allowlisted push service origin** — default
   `https://fcm.googleapis.com`, `https://updates.push.services.mozilla.com`, `https://web.push.apple.com`,
   `https://*.notify.windows.com`; `PUSH_ENDPOINT_ALLOWLIST` replaces it (`http://` only for a loopback host,
   used by the tests' fake push service). No credentials, no fragment, exact port. This is the SSRF guard:
   the master POSTs to this URL;
2. `p256dh` must be a valid uncompressed P-256 point, `auth` exactly 16 bytes;
3. **a new destination needs a step-up** (same rule as changing the notification e-mail address: a stolen
   session must not add its own device); re-registering an endpoint the caller already holds is a
   **refresh** (keys, label, `last_seen_at`) and needs none — the app does it on every start;
4. an endpoint held by another account (shared browser) moves to the caller (audited for both);
5. at most 10 per user (least recently seen evicted).

Audit: `notification.push.subscribe` (subscription id, label, push service host, evicted count — never the
endpoint, which is a capability URL) and `notification.push.unsubscribe` (`reason`: `user`, `logout`,
`endpoint_reused`).

**Lifecycle — when a device stops receiving pushes:**

| Trigger | Effect |
| --- | --- |
| Revoke in Settings → Devices (`DELETE /notifications/push/subscriptions/:id`, own only — otherwise 404) | row deleted |
| "Turn off on this device" or **Log out** in this browser | `POST /notifications/push/unsubscribe {endpoint}` + `PushSubscription.unsubscribe()` (bounded, best effort) |
| Every session revoked: log out everywhere, password change, admin reset, disable, role elevation | `sessions.deleteAllForUser` deletes the user's subscriptions in the same transaction |
| The trusted device it was registered from is revoked | `ON DELETE CASCADE` |
| Push service answers 404/410 | row deleted |
| Three rejected deliveries in a row (400/401/403/413/3xx) | row deleted |
| Not refreshed for 30 days (the browser did not open the app) | not delivered to; pruned hourly |
| On app start the master no longer knows the endpoint (refresh would need a step-up) | the browser drops its subscription so the device does not show as "on" |

## 4. The `push` channel

`push` joins `email` and `webhook` in `CHANNELS` (preferences per kind, opt-in, no row = off). For a recipient
who enabled the kind and has at least one subscription, `notify()` queues one `notification_deliveries` row
(`channel = 'push'`, target = the recipient). `PushNotifier.send` fans it out to the recipient's fresh
subscriptions **at send time** (a revoked device is never used by a queued delivery). Every kind is covered,
including those added later (e.g. `chat.watch`, `chat.note` from p6-chat-notify; the chat tool's channel report
now includes `push`).

**Payload (≤ 3.5 KB, typically ~250 bytes):** `{v: 1, id, kind, severity, title, body, link, ts}` — title ≤ 80
and body ≤ 180 characters after `cleanText` (control characters flattened, secret patterns redacted), link
reduced to a console-relative path. Titles/bodies are the notification texts, which producers build from
identifiers, enumerations and admin-set names only (p5-notifications §3) — never from prompts, failure reasons,
approval summaries or job output. No user name, no e-mail, no endpoint.

**Encryption and authorisation.** RFC 8291 (`aes128gcm`, RFC 8188 single record, fresh ephemeral ECDH key and
salt per message) and RFC 8292 VAPID (`Authorization: vapid t=<ES256 JWT {aud: push service origin, exp: +12 h,
sub}>, k=<public key>`), implemented on node:crypto in ~150 lines and checked byte for byte against the
RFC 8291 Appendix A test vector. No npm dependency was added (dependency policy §2). Headers: `TTL` 12 h,
`Urgency: high` for warning/critical (approvals, failures) else `normal`, `Topic` = notification id (a retry
replaces an undelivered duplicate at the push service).

**Delivery semantics** (the p5-notifications queue unchanged): resolves when at least one device accepted
the message (no retry, so no duplicates on the others); all devices transient (408/429/5xx/network) → retry
with backoff; otherwise dead letter with `push_gone` / `push_rejected` / `no_push_device`. Redirects are never
followed, 10 s timeout, response bodies are never read; logs carry status classes and a 12-hex endpoint hash
only. `POST /notifications/push/test` sends a test message to the caller's devices.

**Service worker side.** `push` → `showNotification(title, {body, tag: id, icon, badge, timestamp,
requireInteraction for approval.requested / deploy.waiting, data: {link}})`; an unreadable payload still shows
a generic "Remyral" notification (browsers revoke silent push permission — iOS after three). The link is
re-validated in the worker (console path only, else `/`). `notificationclick` focuses an open console window
and asks it to route (`remyral:navigate`, validated path), or opens one. Open pages refresh the bell on
`remyral:push`.

## 5. Configuration and keys

| Variable | Meaning |
| --- | --- |
| `PUSH_VAPID_PRIVATE_KEY_FILE` | EC P-256 private key (PKCS#8 or SEC1 PEM) — **secret**, file in the secrets mount (`/run/secrets/remyral/vapid.pem`, uid 10001, 0400) |
| `PUSH_VAPID_SUBJECT` | `mailto:` or `https://` operator contact for the push services |
| `PUSH_ENDPOINT_ALLOWLIST` | optional comma-separated origins (`https://host`, `https://*.suffix`) replacing the default push services |

Both of the first two or neither (config error otherwise); without them the channel is unavailable, the UI
says so, subscribing is refused (`400 channel_unavailable`). Generate once:
`pnpm --filter @remyral/master vapid:keygen /abs/path/vapid.pem` (mode 0600, refuses to overwrite, prints only the
public key) or `openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out vapid.pem`.
The public key is derived from the private one and served to signed-in users by `GET /notifications/push`.
**Rotation** invalidates every subscription (browsers bind a subscription to the key; the app detects the
mismatch and resubscribes when the user turns push on again). Back the file up with the other keys.

## 6. Install UX and iOS

- `beforeinstallprompt` (Chromium: Android, desktop Chrome/Edge) is captured; Settings → Devices shows
  **Install app**. Safari/Firefox: instructions (iOS: Share → Add to Home Screen).
- **iOS/iPadOS:** Web Push only for a web app added to the Home Screen, **iOS/iPadOS 16.4+**; in a Safari tab
  `PushManager` is absent and the card says to install first. iPadOS is detected by its Mac UA + touch. The
  permission prompt must come from a tap (the "Turn on" button). Each installed web app has its own
  subscription; Focus modes and notification summaries apply.
- Manifest: `name`/`short_name` "Remyral", `display: standalone`, `id`/`start_url`/`scope` `/`, any + maskable
  icons, shortcuts Approvals / Jobs / Chat. `apple-touch-icon` and `apple-mobile-web-app-title` stay in
  `index.html`.
- First device: push is switched on for the recommended kinds (approval requested/expiring, job failed,
  deploy waiting, automation waiting) only if the user had no push preference yet; everything else stays
  opt-in in Settings → Notifications (new **Push** column).

## 7. Mobile UX audit at 390 px

Approvals (Approve/Deny on the row and in the detail, both through the step-up dialog that is top-anchored
on phones and accepts one-time-code autofill), the job page (live panel, logs, cancel) and chat already met
the p5-mobile bar (44 px targets, no horizontal page scroll, safe areas, bottom tab bar Home / Chat / Jobs /
Approvals / More). `e2e/mobile-pwa.spec.ts` re-checks them at 390 × 844 together with the new Devices and
Notifications screens; screenshots in `docs/design/screens/p8-pwa/`. New UI follows the same rules: full-width
stacked buttons on phones, the push column scrolls inside its card, no new fixed elements (the update bar is in
the page flow, so it never covers the tab bar).

## 8. Tests

| Suite | What |
| --- | --- |
| `apps/master/test/unit/webpush.test.ts` | RFC 8291 Appendix A vector byte-exact; round-trip with fresh keys; invalid keys/secret/size refused; VAPID JWT verifiable, `aud`/`sub`/`exp ≤ 24 h`; PEM formats; wrong curve refused |
| `apps/master/test/unit/push-channel.test.ts` | endpoint allowlist (look-alikes, http, ports, credentials, metadata IP, wildcard), key sealing (AAD, tamper), payload minimisation/redaction, config validation |
| `apps/master/test/integration/push-notifications.test.ts` | step-up for new devices, refresh without, allowlist/key refusal, sealed keys at rest, audit without endpoint, owner-only list/revoke (404 for others), shared-browser move, delivery through a **fake push service** that verifies VAPID and decrypts like a browser, kinds and recipient scoping respected, no secret in payload, 503 retry, 410 cleanup + dead letter, test push, log-out-everywhere cleanup |
| route coverage / RBAC matrix | the five new routes need a full session and `notifications.self` (automatic matrix) |
| `apps/web/test/sw-logic.test.ts` | worker routing (never `/api`, `/v1`, non-GET, other origins), precache list, stale caches, push → notification (fallback, caps, link safety), click target, manifest injection |
| `apps/web/test/pwa.test.tsx` | update flow (banner, skip-waiting, reload on controllerchange, never automatic), worker messages, iOS detection, enable (permission, key mismatch → resubscribe), sync (refresh / drop when unknown), Devices card (not configured; step-up → on → recommended kinds → revoke), settings push column |
| `apps/web/e2e/pwa-csp.spec.ts` (`csp` project, production build) | manifest + icons, SW active at `/`, no CSP violation, Cache Storage holds only shell paths after authenticated traffic, offline navigation → offline page, API not answered offline |
| `apps/web/e2e/mobile-pwa.spec.ts` (`mobile-iphone`) | Devices, Notifications, Approvals, job, Chat at 390 × 844: no overflow, targets ≥ 44 px, bottom bar, manifest link |

## 9. Security review

| Risk | Mitigation |
| --- | --- |
| Authenticated or session-bound data cached on the device | the worker never intercepts `/api/*` or non-GET; precache requests omit credentials; only content-hashed static files and the offline page are stored; e2e asserts the cache contents after signed-in traffic; logout needs no cache purge because nothing personal is cached |
| A stale or malicious worker keeps serving old code | worker script `no-cache` + `updateViaCache: 'none'`, hourly/visibility update checks, HTML never cached; worker is same-origin and built from the repo (no `importScripts`, no CDN) |
| SSRF through the subscription endpoint (master POSTs to it) | strict allowlist of push service origins (https, exact host or `*.suffix`, exact port, no credentials), checked on subscribe; redirects never followed; 10 s timeout; body never read |
| Stolen session registers its own device to siphon notifications | new device needs a step-up (TOTP), audited; revoking all sessions drops all devices; owner can revoke per device |
| Notification content leaks secrets or untrusted text to lock screens / push services | payload = identifier-built title/body, redacted and capped (80/180), relative link only; RFC 8291 end-to-end encryption, the push service sees ciphertext; fallback text is generic |
| Subscription keys usable from a DB dump | p256dh/auth sealed with a master sub-key (AES-256-GCM, AAD = row id); the endpoint alone cannot deliver a readable message; VAPID private key only in a file |
| Cross-user access | every route scoped by the session's user id; another user's id or endpoint → 404 / `removed: false`; RBAC matrix |
| Open redirect / script URL via notification click | link validated on the master (relative path) and again in the worker and page (`^/(?!/)…`), else `/` |
| Push spam / permission revocation | every push shows a notification; urgency high only for warning/critical; topic dedupes retries |
| VAPID key compromise | rotate the file (all users re-enable push); key never logged; public key only |
| Dependency risk | none added: RFC 8291/8292 on node:crypto, verified with the RFC vector and an independent decryption |

## 10. UNVERIFIED / needs the owner

- **Real push on devices:** delivery through real FCM (Android Chrome), Apple (installed web app on iOS 16.4+)
  and Mozilla needs the deployed console with `PUSH_VAPID_*` set and a phone. The protocol is verified against
  the RFC vector and a browser-equivalent fake push service; WebKit is not part of the e2e (Chromium only,
  p5-mobile §6).
- **Install prompt and offline page on a real phone** (Chromium e2e covers the worker and the offline page).

## 11. Rollback and operations

Rollback: redeploy the previous master and web images. Migration 0063 is additive (channel CHECKs widened,
new table); the old master ignores `push_subscriptions` and `push` rows (a `push` preference row is never
read by it; queued `push` deliveries would dead-letter as `channel_disabled`). Unsetting `PUSH_VAPID_*`
disables the channel without a deploy of code. Old browsers keep the installed worker until the next update
check; an old worker never caches API responses either. To force-remove the worker, deploy a `/sw.js` that
unregisters itself (not needed for a normal rollback). Metrics: delivery outcomes are in
`notification_deliveries` (status, `last_error` codes `push_*`), device counts in `push_subscriptions`;
`push subscription expired` / `push delivery failed` log lines carry only status and an endpoint hash.
