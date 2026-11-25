# Design note: Fleet screen — list/map, capacity, status, compatibility, history (P5)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** `p5-fleet-ui`
- **Builds on:** the Fleet screen of p2-pairing / p2-heartbeat-caps / p2-signed-updates / p3-runtime-policy /
  p4-quotas, [p4-orchestration.md](p4-orchestration.md) §3–4 (capabilities, sandbox readiness, placement),
  [p3-runtime-policy.md](p3-runtime-policy.md), [p2-transport.md](p2-transport.md), [p1-web-skeleton.md](p1-web-skeleton.md).
- **Threat model:** T-CP-1 (information exposure to low-privilege users), T-WRK-2 (untrusted worker reports).

## 1. Shape

```
apps/master/src/fleetview/overview.ts   fleetOverview(), compatibility() (pure), networkGroup() (pure), workerHistory()
apps/master/src/fleetview/routes.ts     GET /fleet/overview, GET /workers/:id/history  (workers.read)
apps/master/src/workers/sessions.ts     CAPABILITIES.sandboxReadiness persisted (workers.sandbox_readiness, 0018)
apps/web/src/api/fleet.ts
apps/web/src/screens/fleet/FleetPage.tsx   (moved from shell/; pairing, actions, policy card unchanged)
apps/web/src/screens/fleet/parts.tsx       filters/sort/grouping (pure), CapacityBar, CompatMatrix, NetworkMap,
                                           HistoryTimeline, WorkerFacts
```

## 2. Screen

- **Summary:** workers online / enrolled, jobs running / total slots.
- **Toolbar:** view tabs (List · Map · Compatibility), search (name, host, id, OS/arch), state filter, "runtime
  ready" filter (ready or degraded in the matrix), sort (name, state, load, last seen).
- **List:** one row per worker — a card on phones, a five-column grid row on ≥ 768 px: name/id, state (+
  provider pauses), **capacity bar** (the master's unreleased leases / reported `maxParallelJobs`; SVG geometry so
  no inline style is needed under the CSP), ready runtimes, last seen + platform. Expanding shows the existing
  details (keys, runtimes, actions, runtime policy card) plus **sandbox readiness** (per profile, runtimes,
  reason), tools, **release/update state** (channel, pin, last attempt + reason), policy sync, load, and the
  **state history timeline**.
- **Map:** workers grouped by network — the last connection's /24 (IPv4) or /64 (IPv6), labelled private /
  CGNAT-tailnet / public / unique local. No tiles, no external requests, no host addresses (only the group).
  Each group: online count, worker state dots, capacity.
- **Compatibility:** runtime × worker matrix. Desktop: table with the reason as `title` and a "Why not ready"
  list; phones: per-worker cards listing every runtime with its reason (no hover needed).

Polling every 5 s as before; the overview, pauses and history are additions — the list works without them
(e.g. a 403 or an older master).

## 3. Master read endpoints (`workers.read`, viewer+, like the rest of the fleet API)

`GET /fleet/overview` — per enrolled worker: capacity, capabilities time, ready profiles, sandbox readiness,
tools, load, network group, runtime policy (assigned, effective name/version/stage, in sync), release (channel,
pinned target, last update attempt) and the compatibility cells.

**Compatibility cell** (`compatibility()`, pure, unit-tested) in the order the runtime gate decides:
`unknown` (no CAPABILITIES yet) → `not_installed` → `not_allowed` (effective runtime policy lacks the runtime) →
`pin_mismatch` (unless the rule's `allowUnpinned` ⇒ `degraded`) → `not_authenticated` → `unsupported`
(streaming / cancel / approval unsupported or unreported) → `unverified` (unless `allowUnverified` ⇒
`degraded`) → `ready`. Each cell carries the version and a reason naming the remedy.

`GET /workers/:id/history` — newest-first audit events targeting the worker, **only** worker lifecycle actions
(pairing, approve/deny, session start/end, drain, revoke, rotation, runtime policy assignment, update
offer/target), metadata reduced to an allowlist (`reason`, `code`, versions, policy, channel), user actor ids
removed, no IPs, no user agents — viewers do not hold `audit.read`.

Migration 0018 adds `workers.sandbox_readiness` (written from every CAPABILITIES); the existing
`audit_events_target_idx` (0008) serves the history query.

## 4. Security review

| Concern | Mitigation |
| --- | --- |
| Exposure to viewers | Same scope as `GET /workers/:id` (already viewer+). IPs reduced to a network group; history is a filtered projection of audit events without user ids, IPs or free metadata |
| Untrusted worker reports (T-WRK-2) | Readiness reasons, tools and versions are rendered as text only; capacity uses the master's own lease count; the matrix is informational — placement and the worker gate stay authoritative |
| XSS / CSP | React text only; no inline styles (SVG attributes for the meter); no external map tiles or fonts |
| Load | One query for all workers plus `forWorker` per worker (tens of workers); 5 s polling as before |

## 5. Tests

- `apps/master/test/unit/fleet-overview.test.ts` (19): every compatibility status and its remedy text; network
  groups (private, CGNAT, public, IPv4-mapped, ULA; no host part).
- `apps/master/test/integration/fleet-view.test.ts` (2): real worker daemon with sandbox readiness → overview
  capacity from a real lease, readiness persisted, tools, network group without the address, release, matrix;
  history visible to a viewer without user ids/IPs, 404 for unknown workers.
- `apps/web/test/fleet-ui.test.tsx` (8): filter/sort/group helpers; summary, capacity meter, ready runtimes;
  filtering; map groups; compatibility reasons; details with readiness, release state and timeline. The
  existing `fleet.test.tsx` / `runtime-policy.test.tsx` pass unchanged (same test ids).
- Screenshots: `docs/design/screens/p5-console/fleet-*.png` (mobile + desktop) from `e2e/fleet.spec.ts` (real master,
  worker rows in two networks).

## 6. Rollback and operations

Read-only endpoints and a nullable column; rollback = revert the code (the column can stay). No new operational
signals; the endpoints use existing tables.

## 7. UNVERIFIED

Fleets of hundreds of workers (per-worker policy lookup is O(n) queries); IPv6-only networks beyond the /64
grouping; real readiness reasons from Windows workers.
