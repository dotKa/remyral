# ADR-0013: Interactive OpenHands sessions through Canvas, tunnelled via the master

- **Status:** Accepted — owner-delegated sign-off, 2026-10-13 **Superseded by [ADR-0023](0023-remove-openhands.md)** (2026-10-15: OpenHands and the Canvas screen were removed).
- **Date:** 2026-10-13
- **Related:** ADR-0005, ADR-0009, ADR-0012, docs/compat/openhands.md §6, p5-canvas-links, p5-live

## Context
The owner wants to use the native OpenHands screens. Facts (docs/compat/openhands.md §6):
- OpenHands **Agent Canvas** (1.27.0, beta, paired with agent-server 1.54.0) is a React GUI that talks to one or more **Agent Servers** ("backends": URL + API key) registered in the browser.
- Canvas is not a fleet scheduler (its own Automation service must stay disabled — two schedulers would fight).
- Our cluster jobs run per-job Agent Servers bound to 127.0.0.1 on workers with a random key; they are short-lived and unreachable from a browser, so deep links to them are not feasible.
- Workers accept no inbound connections (ADR-0005).

## Decision
Two complementary surfaces:

1. **Cluster jobs (default)** — every OpenHands job, like every other runtime, is watched and steered in **our** console: live event stream, logs, diff/artifacts, approvals, cancel (p5-live). No Canvas needed.
2. **Interactive OpenHands (optional)** — for hands-on sessions in the native UI:
   - The operator starts an *interactive OpenHands session* on a chosen worker from our console (a job type `interactive-openhands`, scheduled, audited and budgeted like any job, with its own workspace and sandbox profile).
   - The worker starts a long-lived Agent Server for it on 127.0.0.1 with a random session key (ADR-0012 rules), Automation disabled.
   - The **master reverse-proxies** HTTP + WebSocket from `https://<console>/oh/<sessionId>/…` through the worker's existing outbound WSS connection to that loopback server (multiplexed stream; no new inbound port anywhere). The proxy injects the session key server-side — the browser never sees it — and requires our full (password + TOTP) session; opening a session is a step-up action.
   - **Canvas** (pinned image) is served by the master under `/canvas` behind the same authentication, pre-configured with the proxied backend, so "Open in OpenHands" in our console opens the conversation directly.
   - Ending the session (or idle timeout / budget) stops the Agent Server and releases the workspace; transcripts are kept as job artifacts.

## Alternatives considered
- Canvas on the operator's laptop pointing at workers over Tailscale — works for one admin, but bypasses our auth/audit and needs the Agent Server bound beyond loopback; rejected as default, allowed as a documented manual fallback.
- Deep links into per-job Agent Servers — impossible (loopback, short-lived, browser-local backend registry).

## Consequences
Requires a generic stream-multiplexing tunnel in the worker transport (also useful for live terminals, p5-live). Canvas is beta: pin it, and keep surface 1 fully functional without it.

## Verification
E2E: start an interactive session on a worker behind NAT, open it in Canvas through the console, send a prompt, see events; confirm the Agent Server is still bound to 127.0.0.1 and the browser never receives the key; unauthenticated `/oh/*` and `/canvas` requests are refused.

## Implementation notes (2026-10-13, p5-canvas-links)

- Canvas 1.27.0's `/canvas` frontend is taken from the pinned image `ghcr.io/openhands/agent-canvas:1.27.0` (by digest; tree digest checked by `scripts/canvas/fetch-canvas.mjs` and at master start). Its own CSP: script hashes, no `unsafe-eval`, `connect-src 'self'`.
- Canvas runs on the console origin as decided here, so its JavaScript can act as the signed-in user; a separate origin is the follow-up. `/oh` POSTs accept the CSRF token **or** a same-origin `Origin` header because Canvas cannot send our header.
- The tunnel target is fixed to `openhands-session` (fenced by job/attempt/epoch), never host:port; the session key is injected and masked worker-side and never leaves the worker. "End session" cancels (workspace discarded, not published).
- UNVERIFIED: Canvas rendering a real conversation through the proxy in a real browser; the real Agent Server variant of the integration suite.

## Implementation notes (2026-10-15, p6-canvas-routes)

- Verified in a real browser (Playwright Chromium, desktop) against a real Agent Server 1.54.0 with a scripted model, through the real worker gateway and a master-equivalent front (same allowlist, header picks and auth-frame drop): the Canvas 1.27.0 conversation view renders the existing conversation, streams events live, sends a user message, accepts pending confirmations and shows the changed files (uncommitted and per commit). Request log, decisions and screenshots: docs/design/p5-interactive-openhands.md §6a, `docs/design/p6-ui-refactor/canvas-*.png`.
- Live failure explained: Canvas's first-run onboarding modal (backend check via `GET /api/settings`, agent choice, LLM setup) covered the page, and the conversation itself loads through `GET /api/conversations?ids=<id>`, which was refused — Canvas then falls back to its home screen. The bootstrap now marks onboarding done and stores the analytics consent as denied; the allowlist gained the batch read **pinned to the session's conversation** (every `ids` value must match), the workspace commit history (`git/commits`, `git/commits/{sha}/changes`, `path` confined) and the two static model catalogs (`/api/llm/models`, `/api/llm/models/verified`; their failure was the "not available through the console" toast). Everything else stays refused; settings stay refused on purpose (reading them would flip Canvas to "LLM not set up" and disable its input).
- The worker gateway now refuses a repeated workspace `path` parameter (it checked the first value while the server reads the last; the 1.54.0 server's own workspace check still caught it).
- Residual: per-file diff view (Monaco) loads from `cdn.jsdelivr.net`, which the Canvas CSP blocks — the diff data is fetched but not rendered; one toast on load (`POST /api/auth/workspace-session`, refused because its cookie carries the session key); Files tree and branch badge empty (they run shell commands); backend status dot red (health check reads settings).
