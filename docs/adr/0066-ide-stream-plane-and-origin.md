# ADR-0066: Tam IDE — the STREAM_* plane comes back for IDE workspaces, served from a separate IDE origin with ticket-bound cookies

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** owner (p19-ide decisions 2026-10-28, approved as proposed), agent
- **Related:** p19-ide W2; [design note](../design/p19-ide.md) (§2.2, §3, §7, "Implementation (W2)"); ADR-0013 (the
  stream plane of the interactive OpenHands sessions), ADR-0023 (removed it with OpenHands: "a future feature that
  needs streams brings them back with its own ADR"), ADR-0005 (outbound-only workers), ADR-0007 (sandbox profiles),
  ADR-0009 (sessions, step-up), ADR-0056 (security policy events), p15-services (the services' sandbox profile and
  reconciliation); migration 0186

## Context

The owner chose a hybrid code experience (p19-ide decision 1): W1 is the browser viewer and diff reviewer (shipped),
W2 adds "Tam IDE" — the real VS Code in the browser (openvscode-server, MIT) as a workspace per (project, user) on a
**Linux** worker (decision 2), reached at a **separate subdomain** `ide.<domain>` (decision 3; without it Tam IDE is
off and the viewer works), started by **operators** with an **authenticator code** (decision 5; switchable in the
security policy), terminal opens audited, with a **separate capacity**: no job slot, ≤ 2 running IDEs per machine,
4 GB each, stop after 30 minutes idle (decision 6).

Workers connect outbound only (ADR-0005): the master cannot dial an IDE server on a worker, and a worker may sit
behind NAT with no public address. The only path to it is the worker's WebSocket. openvscode-server speaks plain
HTTP (static workbench, `vscode-remote-resource`) plus long-lived WebSockets (the management and extension-host
protocols); it authenticates with a connection token (`tkn` query or `vscode-tkn` cookie; the browser's workbench
reads the cookie and sends it again in its WebSocket handshake, checked in the pinned 1.109.5 `server-main.js`).
The interactive OpenHands sessions solved the same shape with a binary STREAM_* data plane (ADR-0013) that ADR-0023
removed together with OpenHands (the code was deleted then and is not part of this repository).

The IDE executes arbitrary code (terminal, tasks, extensions) as the workspace's user on the worker. Its JavaScript —
the workbench and every extension webview — must never run with the console's cookies or call the console as the
user.

## Decision

1. **The STREAM_* plane is back, for IDE workspaces only.** Control messages are JSON envelopes (seq 0, never replayed):
   `STREAM_OPEN{streamId, target: "ide", workspaceId, window}` (master → worker), `STREAM_ACCEPT` (worker → master),
   `STREAM_WINDOW{credit}` and `STREAM_CLOSE{fin|reset, reason}` (both). Data travels in binary WebSocket frames
   `[u8 0x01][u32 BE streamId][≤ 64 KiB payload]`. Flow control is credit based per stream and direction (default
   window 256 KiB, max 1 MiB): a peer sends only what the receiver granted; exceeding it is a protocol violation, more
   than three violations drop the connection. A slow browser stalls only its own stream. The multiplexer is the
   restored `@remyral/protocol/stream-mux` (one class for both ends). Only the master opens streams, only to a worker
   that advertises the new feature **`ide-v1`** (the old `streams-v1` stays retired, ADR-0023), and only to a
   **target**: `ide` + a workspace id the worker runs itself — never a host or a port. The worker maps it to that
   workspace's loopback port and connection token or refuses (`not_found`).
2. **Transport budgets.** STREAM_* control messages are counted in their own token bucket on the master (1000/s, burst
   4000) instead of the worker message budget; binary frames bypass the byte bucket (credit bounds them). The master
   holds a binary frame while the socket buffers more than 2 MiB (the JSON lane keeps its 8 MiB "worker too slow"
   guard); the worker's sender waits for queue space (≤ 30 s) instead of failing. A stuck stream is reset; the worker
   connection stays.
3. **The IDE origin.** `IDE_ORIGIN` (e.g. `https://ide.example.com`) names a host that must differ from the console's.
   The same Fastify server answers it, told apart by Host: on that host only the IDE origin's routes answer (every
   other route 404 before authentication), and they answer on no other host (so `https://<console>/api/w/…` never
   serves the IDE on the console origin). Unset: the routes 404 and the console reports `not_configured`. DNS and TLS
   for the host are the operator's ([deploy-coolify.md §11](../ops/deploy-coolify.md#11-tam-ide-origin-optional)).
4. **One-time ticket → short-lived cookie.** The console (full session, `ide.use`, the caller's own running workspace)
   asks `POST /ide/workspaces/:id/open` for a ticket: 256 random bits, 60 s, single use, bound to user + workspace +
   the console session (`sessions.id_hash`; a step-up rotation moves the binding along). The browser opens
   `https://ide.<domain>/_ide/enter?w=<id>&t=<ticket>`; the IDE origin deletes the ticket and sets a host-only
   `__Host-ide-<workspace>` cookie (Secure, HttpOnly, SameSite=Strict, Path=/) for a cookie session of 15 minutes
   sliding, 8 hours at most, then redirects to `/w/<id>/`. Only SHA-256 hashes are stored (`ide_access`, migration
   0186). Every request checks the cookie session, that its console session is alive (ending it — logout, expiry,
   "sign out everywhere", disabling the user — cascades), that the workspace runs and is the user's, and that the user
   still has `ide.use` on the project (re-checked at most every 30 s per cookie, every 5 minutes on open WebSockets).
   IDE use counts as console activity. Stopping or deleting a workspace revokes its tickets and cookies and resets its
   streams.
5. **The proxy.** `GET|HEAD /w/<id>/…` is carried as HTTP/1.1 over a fresh stream: allow-listed request headers only
   (never a cookie, `Authorization` or forwarding headers), allow-listed response headers back, the console's CSP /
   COEP / CORP removed (the IDE sends its own CSP; webviews are cross-origin frames), `X-Frame-Options: SAMEORIGIN`
   kept. WebSocket upgrades need `Origin` = the IDE origin (cross-site WebSocket hijacking), ≤ 16 per user, and are
   relayed byte for byte. The worker gateway (in-process HTTP server that never listens, the ADR-0013 pattern) allows
   only GET / HEAD and upgrades under the workspace's base path (`--server-base-path /w/<id>`), adds the
   `vscode-tkn` cookie upstream, keeps only handshake headers of an upgrade, and gives HTML documents
   `Set-Cookie: vscode-tkn=<token>; Path=/w/<id>; Secure; SameSite=Strict` — the one upstream cookie the master passes
   (re-serialised). The connection token therefore reaches the authorized user's browser: it is good only against
   that worker's loopback port and only keeps other local processes out; the IDE origin's cookie session is the
   access control.
6. **No inbound ports, anywhere.** The IDE server binds 127.0.0.1 on a random port with a random connection token; the
   worker opens no listener reachable from outside (the bridge endpoint is loopback too); the master needs no route to
   the worker. Cloudflare tunnels (ADR-0032) stay a separate, manual option for services, not for the IDE.
7. **Signed control, daemon-held git.** IDE_START / IDE_CONTROL / IDE_GIT are signed with the lease key and at most
   5 minutes old (like SERVICE_*). Repository workspaces are worktrees of the worker's mirror on their own branch
   `remyral/ide/<user>/<name>` (never shared with a job). "Gönder" (bridge extension or console) commits and pushes
   only that branch, fast-forward, through the daemon's hardened git path after the pre-push secret scan, with a write
   token the master mints for that one push — it never enters the IDE's environment.

## Alternatives considered

- **A Cloudflare named tunnel per workspace + Cloudflare Access** (ADR-0032 / p15-services). Rejected as the default:
  a second login, split audit, a public hostname per workspace, and it does not work for installs without Cloudflare.
  It stays available for services.
- **Same origin under `/ide/` of the console.** Rejected (owner decision 3): the workbench and every extension webview
  would run on the console's origin with its cookies and could call the console API as the user.
- **An inbound port on the worker** (or a VPN). Rejected: violates ADR-0005 (outbound only, no public IP assumed).
- **Terminating every WebSocket on the master and relaying messages** (ADR-0013 did this to drop `auth` frames).
  Rejected for the IDE: nothing in VS Code's frames needs rewriting, and byte relaying keeps the master cheap; the
  gateway still filters the handshake.
- **Keeping the connection token away from the browser** (inject it only upstream). Not possible with openvscode-server
  1.109.5: the browser's workbench must send it in its WebSocket `auth` message, read from the `vscode-tkn` cookie.
- **Keep-alive HTTP agents over long-lived streams.** Deferred: one stream per request is simpler and the stream budget
  of decision 2 covers a workbench load; revisit if master CPU shows it.

## Consequences

- The worker protocol grows by `ide-v1`, IDE_* messages and the STREAM_* plane; older workers never see them (the master
  starts no IDE and opens no stream without `ide-v1`). W2 needs a new worker release.
- The master serves a second origin; the reverse proxy (Traefik / Coolify) needs a router for `ide.<domain>` to the
  master without the `/api` prefix strip, and a certificate for it ([deploy-coolify.md §11](../ops/deploy-coolify.md#11-tam-ide-origin-optional)). Without them Tam
  IDE stays off.
- Bandwidth of an IDE session flows through the single master (design §11); per-stream credits keep control traffic
  first.
- On Linux host profiles an IDE and the jobs of the same machine share the OS user (ADR-0007 residual, as for services):
  a job could read the IDE's environment (bridge token) or process memory. The start of the IDE is the privileged act
  (step-up); terminal opens are audited (best effort).
- Webviews still load VS Code's pre-built iframe host from `*.vscode-cdn.net` (the pinned product.json); serving them
  from a wildcard under the IDE origin is open (W3).

## Verification

- `packages/protocol/test/stream.test.ts` (frames, credits, violations, resets per workspace), `ide.test.ts`
  (schemas, signatures, freshness).
- `apps/worker/test/ide-gateway.test.ts` (a mock openvscode-server behind a real multiplexer pair: token injection,
  header / method / path filters, WebSocket relay), `ide-manager.test.ts` (start / stop / idle / memory / remove,
  refusals, the git path with a real repository), `ide-bridge.test.ts`, `ide-server.test.ts` (pinned archive, checksum),
  `transport-ws.test.ts` (binary frames only within a session with a stream handler).
- `apps/master/test/unit/ide-proxy.test.ts` (host gate both ways, ticket → cookie attributes, the HTTP / WebSocket proxy
  over a real tunnel, header policy, `Origin` check), `test/integration/ide.test.ts` (Postgres: RBAC, step-up, signed
  delivery, reconciliation, git round trip, references, idle sweep, revocation), `route-coverage.test.ts` /
  `rbac-matrix.test.ts` (the new routes).
