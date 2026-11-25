# Design note: interactive OpenHands sessions, the worker tunnel, `/oh` proxy and Canvas (P5)

> **Removed (2026-10-15):** interactive OpenHands sessions, Canvas, the `/oh` proxy and the STREAM_* plane were deleted by [ADR-0023](../adr/0023-remove-openhands.md). This note is historical.

- **Task:** `p5-canvas-links` — "Interactive OpenHands: session job type, master /oh proxy over worker tunnel,
  Canvas under /canvas"
- **Date:** 2026-10-13
- **Implements:** [ADR-0013](../adr/0013-interactive-openhands-canvas.md) (Accepted)
- **Binding inputs:** ADR-0005 (outbound-only workers), ADR-0009 (sessions, step-up), ADR-0011 (additive 1.0),
  ADR-0012 + implementation notes (OpenHands findings), [p2-transport.md](p2-transport.md) #7 (binary frames
  reserved for `STREAM_*`), [p3-adapter-openhands.md](p3-adapter-openhands.md), [p5-rbac.md](p5-rbac.md),
  [p1-web-skeleton.md](p1-web-skeleton.md) (CSP, `/api` prefix), `docs/compat/openhands.md` §6,
  threat model T-CP-1/2/3, T-WRK-3, T-SEC-1/2, T-SBX-6, T-SUP-1.

## 1. Shape

```
browser ──https──▶ master /api/oh/<session>/…  (full session + interactive.use, allowlist, rate limit)
                     │  HTTP/1.1 or WebSocket, re-originated by the master
                     ▼
                 STREAM_OPEN{openhands-session, job/attempt/epoch} ─ binary frames ─ (existing worker WSS)
                     ▼
worker:          StreamMux ─▶ SessionGateway (in-process HTTP server, never listens)
                     │  allowlist again, workspace path check, + X-Session-API-Key / WS first-frame auth,
                     │  masking of key + job secrets in everything sent back
                     ▼
                 OpenHands Agent Server 1.54.0 on 127.0.0.1:<port> (long-lived, one conversation)
browser ──https──▶ master /canvas/…  (pinned Canvas 1.27.0 build, own CSP, same login)
```

| Piece | Where |
| --- | --- |
| Protocol: `STREAM_OPEN/ACCEPT/WINDOW/CLOSE`, binary data frame codec, `JobSpec.kind/interactive`, `CAPABILITIES.features` | `packages/protocol/src/stream.ts`, `master-messages.ts`, `worker-messages.ts` |
| Shared multiplexer with credit flow control (both ends) | `packages/protocol/src/stream-mux.ts` (`@remyral/protocol/stream-mux`) |
| Route allowlist of the `openhands-session` target (both ends) | `packages/protocol/src/openhands-session.ts` |
| Long-lived Agent Server mode | `OpenHandsAdapter.startInteractive` + `runtimes/openhands/interactive.ts` |
| Worker: session runner, stream plane, gateway, masking | `apps/worker/src/interactive/{manager,gateway,mask}.ts`, hooks in `jobs/runner.ts`, `transport/ws.ts`, `daemon/run.ts` |
| Master: tunnel registry, proxy, REST, Canvas, admission | `apps/master/src/interactive/*`, hooks in `workers/connection.ts`, `compose.ts`, `auth/hooks.ts`, `jobs/store.ts` |
| Migration | `0020_interactive_sessions.sql` (`workers.features`, partial index on interactive jobs) |
| Canvas fetch | `scripts/canvas/fetch-canvas.mjs` |

## 2. Session = job

`POST /interactive/sessions` (operator+ in the project, action `interactive.start`, **step-up ≤ 10 min**,
CSRF) creates an ordinary job with `spec.kind = 'interactive-openhands'`, `runtime: openhands`,
`approvalPolicy: ask-all`, `limits.maxDurationSec` (default 4 h, ≤ 24 h), optional `maxCostUsd/maxTokens`
(budgets: the worker emits usage events from the conversation, so p4-quotas run limits stop it like any job),
`interactive {idleTimeoutSec (default 30 min, 60 s … 24 h), conversationId (chosen by the master)}`, and
dispatches it. `prompt` is only the title — it is never sent to a model. The generic job API and workflows
cannot create this kind (`JobStore.create` refuses `spec.kind` without the `interactive` flag → 400
`spec.kind:not_allowed`), so neither step-up nor the action can be bypassed.

Scheduling, leases, fencing, quotas, audit and recovery are the existing ones. One addition: the
`InteractiveService` admission narrows placement to workers whose last CAPABILITIES advertised
`features: ['streams-v1', 'interactive-openhands']` (persisted in `workers.features`): an older worker would
otherwise strip the unknown fields and run the title as a batch prompt. The lease is renewed by LEASE_ACK as
for any job (long-lived lease); the session ends on

| End | Who | Job outcome |
| --- | --- | --- |
| idle: no proxied request / browser→server WebSocket byte and the agent not `running` for `idleTimeoutSec` | worker | `succeeded` (summary says idle; on git-flow projects the attempt branch is pushed like any success) |
| `POST /interactive/sessions/:id/stop` (`interactive.use`, audited) | master → CANCEL_JOB | `cancelled` |
| max duration, budget kill, lease loss | worker / master | `failed` / `cancelled` as for jobs |
| server exit, policy tampering (`approval_bypass_detected`), event stream lost | worker | `failed` with that code |

Ending always stops the Agent Server **and its descendant process groups** (same sweep as the adapter),
deletes its run state, resets the session's streams, and releases the workspace through the runner. The
transcript is the job's EVENT stream (user and assistant messages, tool calls/results, usage, errors), mapped
and redacted by the adapter's event mapper — readable in the console like any job (p5-live).

`GET /interactive/sessions[?project=]`, `GET /interactive/sessions/:id` (`interactive.read`, viewer+; lists
are filtered to visible projects) return state, worker, `ready` and the deep links `proxyPath`
(`/api/oh/<id>`) and `canvasPath` (`/canvas/conversations/<conversation>?backend=remyral-<id>`).
`GET /interactive/config` tells the console whether Canvas is installed.

## 3. Tunnel (STREAM_* plane)

Decisions:

1. **Binary data frames, not base64.** `[u8 0x01][u32 BE streamId][1…65536 bytes]` in WebSocket binary frames
   (the framing p2-transport reserved). Base64 inside JSON costs 33 % bandwidth, a JSON parse and two copies
   per chunk, and would count against the JSON message budget. Control stays JSON (`seq 0`, never replayed,
   validated by the direction schemas): `STREAM_OPEN{streamId, target, session{jobId, attemptId, epoch},
   window}` (master only), `STREAM_ACCEPT{streamId, window}`, `STREAM_WINDOW{streamId, credit}`,
   `STREAM_CLOSE{streamId, mode: fin|reset, reason?}`.
2. **Credit-based flow control per stream and direction.** A sender may only send the bytes the receiver
   granted (128 KiB window by default); the receiver returns credit as its *consumer* drains the readable
   buffer (≥ ¼ window or when empty). A slow consumer therefore stalls only its own stream: memory per stream
   ≤ window, nothing is dropped, control traffic and job events are never queued behind stream data. Data
   beyond the credit, data after FIN, a duplicate OPEN or a malformed frame is a violation: the stream is
   reset; more than 3 violations drop the connection (4400). Stream frames bypass the per-connection
   message/byte buckets (they are bounded by credit, which the receiver controls) but not the frame-size
   limit or the master's slow-reader cut-off (4503 above 8 MiB buffered).
3. **Ordering:** STREAM_* control and binary frames are handled synchronously in frame order, outside the
   ordered database-backed message chain on the master and outside the daemon's event queue on the worker.
4. **Lifecycle:** one multiplexer per authenticated connection; a closed or replaced connection resets every
   stream (browser sees the socket close / a 502, never data of another stream). Opener timeout 15 s;
   ≤ 64 streams per connection; ids allocated by the master only.
5. **Target allowlist, never host:port.** The only target is `openhands-session`; the worker accepts it only
   for a session it runs **under exactly that attempt and epoch** (fencing), else `refused`/`not_found`.
6. **HTTP-aware ends, raw bytes in between.** The master re-originates each browser request as HTTP/1.1 over
   a fresh stream (`http.request({createConnection})`, `ws` client for WebSockets); the worker feeds streams
   into an in-process `http.Server` (`emit('connection')`, documented for any Duplex). Both ends parse HTTP
   because both enforce policy; the tunnel stays a generic byte pipe (reusable for live terminals, p5-live).
   Raw TCP passthrough of the browser's bytes was rejected: the master could not enforce the allowlist,
   strip headers or drop the browser's auth frame.

## 4. Long-lived Agent Server (adapter)

`OpenHandsAdapter.startInteractive(ctx, {conversationId})` reuses the job path verbatim: version gate and
`local-login` refusal, workspace guard (repo plugins/sub-agents refused), fail-closed loopback start with a
random key in the env only, `/server_info` = probe, conversation created with our policy (AlwaysConfirm, our
tool set, no MCP/hooks/plugins/skills beyond trust), verified. It returns a handle (`port`, `sessionKey()`,
`redactionValues()`, `observe()`, `exited`, `stop()`). Differences to a batch run: no prompt, no adapter
approval decisions (the human confirms in the UI through `respond_to_confirmation`), no run end. `observe()`
opens the worker's own event socket and maps events with `OhEventMapper` (transcript, usage, status); a
confirmation-policy change, hooks or a hook execution → `approval_bypass_detected` and the session ends.

## 5. Worker gateway

Per request: allowlist (§6) with the session's conversation, `path` query parameters (git diff/changes, file
download) confined to the workspace by realpath (nearest existing ancestor for deleted files), body ≤ 1 MiB,
only `accept, accept-language, content-type, content-length, if-*, cache-control, user-agent` forwarded,
`Accept-Encoding: identity`, `Connection: close`, **`X-Session-API-Key` added here**. Responses: only
`content-type, content-length, content-disposition, cache-control, etag, last-modified, x-request-id`; body
through `MaskingStream` (same-length `*` over the session key and every job secret value ≥ 8 chars, across
chunk boundaries — lengths and WS framing stay valid). WebSocket: the worker writes the upgrade itself
(no `Sec-WebSocket-Extensions` → no compression), returns only the handshake headers, then sends the
first-frame auth `{"type":"auth","session_api_key":…}` as a masked client frame (the method 1.54.0
recommends; header/query keys are deprecated) and pipes bytes, server→browser through the mask. Every
request and every browser→server byte is activity for the idle timer.

## 6. Master proxy `/oh/:sessionId/*`

GET/POST (HEAD implied), full session, `interactive.use` on the session job's project (404 for other kinds
and invisible projects), `csrf: token-or-origin` (§8), route allowlist **before** a stream is opened (403
`route_not_allowed`), canonical paths only (no `%`, `..`, `//`, `\`), `409 session_not_ready` unless the job
is RUNNING with a live lease, per-session token bucket (30 req/s, burst 120 → 429), ≤ 8 WebSockets per
session, 20 browser messages/s per socket, 4 MiB messages, no compression. Bodies are forwarded as bytes
(≤ 1 MiB). Responses: only `content-type, content-length, content-disposition, etag, last-modified` — no
`Set-Cookie`, no upstream CSP/CORS. Browser WebSocket frames of type `auth` (Canvas sends its placeholder
key) are dropped. Audit: `interactive.session.start/stop`, `interactive.proxy.open` (first HTTP use per
user and session per 10 min), `interactive.socket.open/close` (with duration and message counts).

Allowlist (pinned OpenAPI 1.54.0; `{c}` = the session's conversation): `GET /health /alive /ready
/server_info /api/llm/models /api/llm/models/verified /api/conversations?ids={c}
/api/conversations/search /api/conversations/count /api/conversations/{c} …/{c}/events/search
…/events/count …/events/{id} …/agent_final_response …/git/changes …/git/diff …/git/commits
…/git/commits/{sha}/changes …/file/download`, `POST …/{c}/events …/events/respond_to_confirmation …/run
…/pause …/interrupt`, WebSocket `/sockets/events/{c}`, `/sockets/session/{c}`. `?ids=` must be present and
every value must be `{c}` (the batch read cannot enumerate conversations); `path` parameters are confined to
the workspace and may appear once. Both ends pass the query to `decideOpenHandsSessionRoute`. Everything
else is refused, notably all `bash` routes and the bash-events socket, settings (read and write),
secrets/profiles/provider connections and the rest of `/api/llm/*`, skills/plugins/hooks/MCP, canvas
extensions, VS Code, workspaces and the workspace file server, `/api/auth/*`, `/api/file/*` (upload, home,
search), `/api/init`, conversation create/delete/fork/PATCH, `confirmation_policy`, `security_analyzer`,
`switch_*`, `load_plugin`, `goal`, `ask_agent`, `condense`, `runtime`, `/v1/*`. The Automation service is
not part of the Agent Server and is unreachable (Canvas's own scheduler stays disabled: there is nothing to
talk to).

## 6a. Canvas 1.27.0 conversation view: verified routes (p6-canvas-routes, 2026-10-15)

**Setup.** Real Agent Server 1.54.0 (venv from `infra/worker/runtimes/openhands/requirements.txt`, the
worker installer's pins) started by the real `OpenHandsAdapter.startInteractive` (AlwaysConfirm, our tool
set) with a scripted OpenAI-compatible model (`fake-provider.mjs`, no keys); the real worker
`SessionGateway` in front of it; a master-equivalent front (same `decideOpenHandsSessionRoute` call with
the query, same request/response header picks, browser `auth` frames dropped, refusals answered with the
master's `403 route_not_allowed` body); the pinned Canvas build (tree digest verified) served with the
master's `loadCanvas` index, bootstrap and CSP; Playwright Chromium at 1440×900 opening
`/canvas/conversations/<c>?backend=remyral-<session>`. The full master + worker daemon path was not used
(the transport between the two fronts is unchanged by this task and covered by the integration suite).

**Why it was blank live.** Two causes, both reproduced: (1) Canvas's first-run onboarding modal ("Check
your backend" → agent → LLM) covered the page — its backend check reads `GET /api/settings`, refused, so it
stayed on "Disconnected"; (2) the conversation is loaded with `GET /api/conversations?ids=<c>`; when that
fails Canvas redirects to its home screen. The toast came from `GET /api/llm/models/verified` (and, once
that is allowed, `GET /api/llm/models`).

**Fixes.** Bootstrap: `openhands-onboarded=1`, `openhands-telemetry-consent=denied`, sidebar
"Getting started" checklist dismissed (all `localStorage`, before Canvas runs). Allowlist: the batch read
pinned to `{c}`, `git/commits` + `git/commits/{sha}/changes` (Canvas's Commits tab; without them work the
agent committed disappears from the panel), the two static model catalogs. Worker gateway: a repeated
`path` parameter is refused (it checked the first value, the server reads the last; the 1.54.0 server's
own workspace check still caught it, verified).

**Requests per step (final allowlist; counts from one run).**

| Step | Method + path (`{c}` = session conversation) | Before | After | Needed? |
| --- | --- | --- | --- | --- |
| render | `GET /server_info` | allow | allow | yes (health, version) |
| render | `GET /api/conversations?ids={c}` | **refused** | allow | **yes** — otherwise redirect to home |
| render | `GET /api/conversations/search`, `GET /api/conversations/{c}`, `…/events/count`, `…/events/search` | allow | allow | yes |
| render | `WS /sockets/session/{c}?after_seq=N` (browser `auth` frame dropped, worker authenticates) | allow | allow | yes — live events |
| render | `GET /api/llm/models/verified`, `GET /api/llm/models` | **refused** | allow | no, but each failure is an error toast on every page |
| render | `GET /api/settings` (×6), `PATCH /api/settings` (×3, 404) | refused | refused | no — see below |
| render | `GET /api/profiles`, `/api/agent-profiles`, `/api/meta-profiles`, `/api/workspaces`, `/api/file/home`, `/api/canvas-extensions/installed`, `POST /api/skills` | refused | refused | no (silent) |
| render | `GET /api/automation/health`, `/api/automation/sdk-version`, `POST /api/automation/v1/telemetry/consent` | refused | refused | no (not part of the Agent Server) |
| render | `POST /api/auth/workspace-session` | refused | refused | no — one toast on load (p6-canvas-polish: answered `204` by the master, no cookie, §6b) |
| render, any | `POST /api/conversations/{c}/bash/execute_bash_command` (`find …`, `git remote …`) | refused | refused | no — Files tree and branch badge stay empty |
| confirm | `POST /api/conversations/{c}/events/respond_to_confirmation` `{"accept":true}` | allow | allow | yes |
| send | user message as a frame on `WS /sockets/session/{c}` | allow | allow | yes |
| live | events on `WS /sockets/session/{c}` | allow | allow | yes |
| changes | `GET …/{c}/git/changes?path=<ws>`, `GET …/{c}/git/diff?path=<ws>/<file>` | allow | allow | yes |
| changes | `GET …/{c}/git/commits?path=<ws>`, `GET …/{c}/git/commits/{sha}/changes?path=<ws>` | **refused** | allow | yes for committed work |
| (only with everything open) | `GET /api/llm/providers`, `/api/llm/provider-connections`, `/api/settings/agent-schema` … | refused | refused | no (onboarding/settings screens only) |
| `/mars/health` | same-origin desktop-bridge probe outside `/api/oh` | — | — | no (console 404) |

**Why each addition is safe.** `?ids={c}` returns the same `ConversationInfo` as the already allowed
`GET /api/conversations/{c}`; every `ids` value must equal the session's conversation (missing, other,
mixed, upper-case and comma-joined values are refused on both ends), so it cannot list other
conversations. `git/commits` and `git/commits/{sha}/changes` are read-only git log data of the session
workspace (sha, subject, author, date, file names) — the same repository the user may already see through
`git/changes`/`git/diff`; `path` is confined to the workspace by realpath and may appear once; `{sha}` must
be 4–64 hex characters. `/api/llm/models/verified` returns the SDK's static `VERIFIED_MODELS` constant;
`/api/llm/models` returns LiteLLM's built-in catalog (the route never receives AWS credentials, so no
Bedrock discovery) — no settings, keys or server state. All responses still pass the worker's masking.

**What stays refused and how Canvas behaves.** Settings: reading them is not needed and would hurt — with
settings readable, the session server's (empty) settings say "no LLM key", Canvas shows "Your LLM isn't set
up" and **disables the input** (seen with all routes open); refused, Canvas uses defaults and the
conversation works. The backend status dot stays red (its health probe reads settings). Profiles,
workspaces, skills, canvas extensions, automation: silent. `/api/auth/workspace-session`: its cookie value
is the session API key — refused, one "This OpenHands route is not available through the console." toast
on load (fixed in §6b); workspace-served artifacts (HTML reports in iframes) are unavailable. Shell routes:
Files tree says "No files in workspace" and the branch badge is empty. **Diff viewer:** Canvas loads Monaco
from `cdn.jsdelivr.net/npm/monaco-editor@0.55.1` at runtime; the Canvas CSP (`script-src 'self'`) blocked
it, so clicking a changed file fetched the diff (allowed) but rendered nothing. The owner approved loading it
from the CDN (2026-10-15); the CSP now allows exactly that version directory (§6b).

Screenshots (desktop, 1440×900): `docs/design/p6-ui-refactor/canvas-1-conversation-confirmation.png`
(existing conversation with a pending confirmation), `canvas-2-confirmed-live.png` (accepted, events
streamed), `canvas-3-message-sent.png` (message sent from Canvas, next confirmation),
`canvas-4-changes.png` (uncommitted changes), `canvas-5-diff-monaco-blocked.png` (file opened, diff not
rendered), `canvas-6-commits.png` (commit list with the files of one commit).

## 6b. Canvas polish: toast, Monaco from the CDN, returning browsers (p6-canvas-polish, 2026-10-15)

Master-only (no protocol, allowlist or worker change). Verified with the §6a harness (real Agent Server
1.54.0, real worker `SessionGateway`, the master's `canvasHousekeepingAnswer`, `loadCanvas`
index/CSP/bootstrap, Playwright Chromium 1440×900, real jsDelivr).

**Which request toasted.** Every Canvas query or mutation that fails without `meta.disableToast` raises an
error toast (global QueryCache/MutationCache `onError`, the message taken from the response body,
deduplicated by text — which is why all refusals collapsed into one toast). With the refusal message tagged
per route, the only one on load was `POST /api/auth/workspace-session` (the Files tab's workspace-session
query, `retry: false`, no `disableToast`). Settings, profiles, file home, bash and the other refusals fail
silently. Any non-2xx answer toasts (generic text when the body has no message), so a quieter error shape is
not possible: the master answers it `204` itself.

**Housekeeping the master answers itself** (`apps/master/src/interactive/canvas-housekeeping.ts`; never
forwarded, no stream opened, same session gate, authz, CSRF and rate limit as proxied requests):

| Request | Answer | Why it is safe |
| --- | --- | --- |
| `POST /api/auth/workspace-session` | `204`, no body, **no cookie** | the real cookie value is the session key; the workspace file server stays refused |
| `POST /api/automation/v1/telemetry/consent` | `204` | no-op (Canvas sends `consent_granted: false`); stops a retry loop (41 POSTs in a few minutes before) |
| any other `/api/automation/*` (health, sdk-version, capabilities, …) | `404 {"detail":"Not Found"}` | exactly what an Agent Server without the Automation service answers; Canvas treats it as not installed |
| `GET /api/meta-profiles` | `200 {"meta_profiles":[],"active_meta_profile":null}` | empty list (`MetaProfileListResponse`) |
| `GET /api/workspaces` | `200 {"workspaces":[],"workspaceParents":[]}` | empty list (`WorkspacesListResponse`) |
| `GET /api/canvas-extensions/installed` | `200 {"canvas_extensions":[]}` | empty list (`InstalledCanvasExtensionsListResponse`) |
| `POST /api/skills` | `200 {"skills":[],"sources":{…: 0}}` | empty list (`SkillsResponse`), body ignored |

Deliberately **not** stubbed: `GET /api/profiles` and `/api/agent-profiles` — answered empty, Canvas decides
"Your LLM isn't set up" and puts its setup banner over the conversation (seen in the browser); refused, its
LLM check stays undecided and shows nothing. Settings (GET/PATCH), the settings schema, `/api/file/home`,
`auth/workspace-session` other than POST, shell routes and everything else keep the `403 route_not_allowed`
refusal (silent in Canvas). Result: no error toast on load, confirm, send or diff; send and confirm work;
the input is enabled once text is typed.

**Monaco from the CDN (owner-approved).** `loadCanvas` finds the one Monaco directory the verified bundle
loads (`@monaco-editor/loader` `paths.vs` = `https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs`) and
adds exactly `https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/` (a CSP path prefix, not the host) to
`script-src`, `style-src` and `font-src`; nothing to `connect-src`, `img-src`, `worker-src` (its workers
already start as `blob:`) or frames; nothing when the bundle names no or several versions. The diff view
renders (`canvas-polish-2-diff-monaco.png`) with no remaining CSP violation besides the cosmetic ones
(Google Fonts stylesheet, npm registry update check, simpleicons logos — still blocked). Residual: scripts
from that jsDelivr path run as Canvas code on the console origin (no SRI possible for runtime-loaded
modules); a compromise of that CDN path is a console compromise, like the §7 same-origin residual.

**Returning browsers.** (1) The bootstrap now keeps only the current session among `remyral-*` backends in
`openhands-backends` (user-added backends stay) and drops the ended sessions' entries from
`openhands-backend-health`, `openhands-last-conversation-by-backend` and `oh:pinned-home-route:remyral-…`;
before, Canvas kept polling `/api/oh/<old session>/…`. (2) The "Check your backend" screen a returning
browser saw is not the first-run onboarding (`openhands-onboarded` is set on every load) but Canvas's
**backend-unreachable** screen (`agent-server-onboarding-screen`, shown when `GET /server_info` of the active
backend fails) — reproduced with an ended session as the active backend; with `?backend=remyral-<current>`
the stale entry is gone and the screen does not appear. A bare `/canvas/` visit (no `backend` parameter)
cannot know which session is live and leaves the registry alone. Verified with browser profiles that first
opened Canvas with the pre-p6-canvas-routes bootstrap (one went through the onboarding modal, one did not),
then a new session with this bootstrap: no onboarding, no checklist, only the current backend, full flow
(confirm, send, diff) works (`canvas-polish-3-returning-browser.png`).

Screenshots: `canvas-polish-1-no-toast.png` (load, pending confirmation, no toast),
`canvas-polish-2-diff-monaco.png` (per-file diff rendered by Monaco from jsDelivr),
`canvas-polish-3-returning-browser.png` (returning browser, no onboarding/checklist).

## 7. Canvas under `/canvas`

**Obtained reproducibly:** `ghcr.io/openhands/agent-canvas:1.27.0` (index
`sha256:2380f985…1006e6`; amd64 `3a6d13f3…c3f9`, arm64 `6a5fd780…bc0`) contains the frontend built with base
`/canvas` at `/opt/agent-canvas/frontend`. The npm tarball `@openhands/agent-canvas@1.27.0` (integrity
`sha512-7fiQKW3p…yXFA==`, verified) only has a root-based build (`/assets/…`), so it cannot be mounted under
`/canvas`. `scripts/canvas/fetch-canvas.mjs` pulls by platform digest, copies the directory out and checks the
**tree digest** `7a9921a7…19ec7` (342 files, 10.3 MB; identical for amd64 and arm64, verified 2026-10-13)
before writing it; the master verifies the same digest at start (`CANVAS_DIR`) and does not serve a
directory that differs (`/interactive/config` → unavailable, error logged).

**CSP (Canvas pages only):** the build has 6 static inline scripts (theme, React Router context) and no
`eval`/`new Function` (checked). `script-src 'self' 'sha256-…'×6` (hashes computed from the verified
index.html), `style-src 'self' 'unsafe-inline'` (the theme script and editor inject `<style>`; styles cannot
execute code), `connect-src 'self'` (blocks PostHog and every third-party call; telemetry is also switched
off by `__AGENT_CANVAS_DO_NOT_TRACK__`), `worker-src 'self' blob:`, `img-src/font-src 'self' data: (blob:)`,
`frame-src/object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`. No `unsafe-eval`, no inline
script beyond the hashed static ones. p6-canvas-polish (owner-approved): `script-src`, `style-src` and
`font-src` also allow the one Monaco directory `https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/`
the bundle loads its diff editor from (§6b). The console's own CSP is unchanged.

**Backend pre-configuration:** `index.html` gets `<script src="/canvas/__remyral/bootstrap.js">` first in
`<head>`. For `?backend=remyral-<session>` it writes Canvas's browser-local registry
(`openhands-backends`, `openhands-active-backend`) with `{id: remyral-<session>, host: <origin>/api/oh/<session>,
apiKey: 'remyral-proxied', kind: local}` — a placeholder the proxy drops — so "Open in OpenHands" deep-links
`/canvas/conversations/<conversation>?backend=remyral-<session>`.

**Isolation (honest):** Canvas runs on the console origin (ADR-0013 chose `/canvas`, same login). A path is
not an origin: Canvas JavaScript can read the CSRF cookie and call the console API as the signed-in user,
including privileged calls within that user's step-up window. Mitigations: pinned, digest-verified build of a
first-party OpenHands release (npm provenance; image built from tag `v1.27.0`); strict CSP above (no
third-party connections, so a compromised dependency cannot exfiltrate to a foreign host; the only
third-party script is the pinned Monaco directory on jsDelivr, §6b);
Canvas is opt-in (`CANVAS_DIR`). A separate origin (e.g. `canvas.<console-host>` with its own cookie) would
remove the residual; it needs DNS/TLS and a second cookie scope and is recorded as follow-up. The opaque
`CSP sandbox` origin was evaluated and rejected: Canvas keeps its backend registry in `localStorage`, which
throws in an opaque origin, so Canvas cannot work there.

**Verified (p6-canvas-routes, §6a):** Canvas 1.27.0 renders the conversation, streams events, sends
messages, accepts confirmations and lists changed files through the allowlist in a real browser; the
residual gaps (empty Files tree, red status dot) are listed there; the Monaco diff view and the toast are
fixed by p6-canvas-polish (§6b). The bootstrap also marks Canvas's onboarding done, stores the analytics consent as denied and
dismisses its "Getting started" checklist. The console's own session view (p5-live: live events,
approvals, cancel) remains the fully supported surface; Canvas is the optional native UI.

## 8. CSRF for the proxy

Canvas cannot send our `X-CSRF-Token`. Routes declaring `config.csrf = 'token-or-origin'` (only `/oh/*`)
accept a state-changing request with either the double-submit token **or** an `Origin` whose host equals the
request host and, when sent, `Sec-Fetch-Site: same-origin`. The session cookie stays `SameSite=Strict`
(cross-site requests carry no session at all); the origin check is the second line. WebSocket upgrades
always require the same-origin `Origin` (cross-site WebSocket hijacking).

## 9. Security review

| Threat | Control | Residual |
| --- | --- | --- |
| Tunnel abuse / SSRF (T-CP-1, T-WRK-3) | Only target `openhands-session`; worker maps it to its own loopback server of a session it runs under that attempt **and epoch**; never a host:port from the wire; route allowlist on master and worker; canonical paths; workspace-confined path params | A compromised master can reach the allow-listed routes of sessions on its workers — it can assign jobs anyway |
| Session key exposure (T-SEC-1/2) | Key generated on the worker, env-only for the server, added by the worker gateway; never in a protocol message, master memory, URL, log or browser response; browser-supplied `X-Session-API-Key`/auth frames dropped/ignored; responses and WS frames masked (same length) for the key and job secrets; canary test asserts absence in every proxied response, WS frame, master log, worker log, audit row and inbox row | Tool processes can still read the key via `ps` (ADR-0012 note, T-SBX-6) → detected (policy tampering ends the session), container profile recommended |
| Dangerous server routes | bash, settings, policy, plugins/hooks/MCP, file upload, conversation create/fork unreachable; conversation created by the worker with AlwaysConfirm; policy change → session ends | A human user confirming actions in Canvas runs them — interactive use *is* remote execution inside the sandbox profile; 1.54.0 implicitly confirms waiting actions when the human sends a new message (upstream behaviour, documented) |
| AuthN/AuthZ (T-CP-2/3) | Full session for `/oh` and `/canvas`; `interactive.use` per session project (404 for other projects/kinds); `interactive.start` + step-up to start; matrix-tested | — |
| CSRF / CSWSH | SameSite=Strict + token or same-origin `Origin`/fetch metadata; WS upgrade requires same-origin `Origin` | — |
| Canvas supply chain / same origin (T-SUP-1) | Image pinned by digest, tree digest verified twice, strict CSP, opt-in | Same-origin Canvas code acts as the user (§7); separate origin is the follow-up; the diff editor's Monaco comes from one version-pinned jsDelivr path (owner-approved, §6b) |
| DoS (T-WRK-3) | Credits per stream, ≤ 64 streams/connection, per-session request/socket/message limits, 1 MiB bodies, 4 MiB WS messages, slow-reader cut-off | Many sessions × windows: bounded by streams × 128 KiB per connection |
| Idle resource use | Idle timeout, max duration, budgets, cancel; server tree + process groups killed on end | — |

## 10. Tests

| Suite | What |
| --- | --- |
| `packages/protocol/test/stream.test.ts` | frame codec; open/data/half-close/forget; refusal reasons; stream limit; **slow consumer** (in-flight ≤ window, writer stalls, all bytes in order, credit returned in steps); credit violation resets; malformed frames; link loss resets everything; per-session reset; open timeout; allowlist decisions incl. traversal and wrong conversation |
| `packages/agent-adapters/test/openhands-interactive.test.ts` | long-lived server vs fixture: loopback/argv/anonymous 401/our policy, observer events + usage + status, key masked in events, policy tampering fatal, refusals (bad id, plugin workspace, fail-open), state removed on stop |
| `apps/worker/test/interactive-gateway.test.ts` | gateway over a real mux pair + fixture server: key injection, browser key/cookie dropped, allowlist/conversation/workspace refusals, event WebSocket with injected first-frame auth and masked key, bash-events socket refused; masking stream across chunks |
| `apps/master/test/unit/canvas-polish.test.ts` | p6-canvas-polish: housekeeping answers and shapes, routes never answered (settings, profiles, shell, files, …), none reachable on the allowlist; Monaco CSP source (exact version path, none / ambiguous bundles, only script/style/font); bootstrap in a VM (onboarding keys, stale `remyral-*` backends and per-backend records pruned, user backends kept, garbage and blocked storage) |
| `apps/master/test/integration/interactive.test.ts` | real master + real worker daemon (WsTransport, production job wiring) + fixture server (or the real 1.54.0 server with `REMYRAL_OPENHANDS_PYTHON`): step-up/viewer/generic-API refusals, placement on the feature worker, HTTP through the tunnel, WS events, Canvas-style POST without CSRF header, confirmation, **key canary** (responses, frames, logs, audit, inbox), cross-site POST and WS refused, allowlist + workspace refusals, unauthenticated/viewer refusals for `/oh` and `/canvas`, Canvas CSP/bootstrap/404s, housekeeping answered without opening a stream while settings/profiles/file home/bash stay refused, **worker restart closes streams** (browser socket closed, tunnel empty, server process gone), **idle timeout** (server process gone, SUCCEEDED, proxy 409), stop → CANCELLED + audit |
| `rbac-matrix`, `route-coverage` | new actions and routes in the generated matrix |

## 11. Rollback, operations

Additive: new protocol messages/fields (older peers never see streams: placement requires the feature),
migration 0020 adds a column and an index (rollback: `DROP INDEX jobs_interactive_idx; ALTER TABLE workers
DROP COLUMN features;`), new routes. Interactive jobs left by a rollback stay as jobs (cancel them).
Metrics: mux `stats` (opened/accepted/refused/resets/violations/bytes), gateway `stats`
(requests/refused/upgrades/masked), audit counts of `interactive.*`, sessions by end reason (job outcomes).

## 12. Open items

- Canvas in a real browser: verified against a local 1.54.0 server through the worker gateway and a
  master-equivalent front (§6a); re-check on the production master with a real Windows worker after deploy
  (UNVERIFIED there). Separate origin for Canvas. Monaco is loaded from jsDelivr (owner-approved,
  §6b); serving it same-origin would remove that third-party script.
- Real Agent Server variant of the integration suite runs only with `REMYRAL_OPENHANDS_PYTHON` (not run in
  this change's CI); Linux/Windows workers UNVERIFIED (as the adapter).
- Graceful "end and publish" from the console (today: stop = cancel; idle end = success).
- Multi-replica master: a proxy request must land on the replica holding the worker's connection (p7-ha).
