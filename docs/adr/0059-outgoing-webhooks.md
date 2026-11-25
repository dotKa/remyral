# ADR-0059: Outgoing webhooks — the master calls admin-chosen URLs with signed event payloads

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** owner (request: an outgoing webhook catalog for external automation), agent
- **Related:** p16-webhooks-out; [design note](../design/p16-webhooks-out.md); ADR-0003 (transactional outbox);
  ADR-0055 K1 (egress floor); ADR-0056 (security policy, step-up events); ADR-0058 (API tokens); migration 0144

## Context

External automation (n8n, Zapier, a CI, a chat bot) wants to react to what happens in Remyral — a job failed, a deploy
is live, an approval waits, a machine went offline — without polling the API. The existing webhook *notification*
channel (p5-notifications) is per user, carries free-text notification bodies, needs an operator allowlist in the
environment and has no event catalog. Until now every outbound request the master made went to a fixed provider
(Coolify, Cloudflare, GitHub, SMTP) or to an operator-configured endpoint; user HTTP requests run on workers
(ADR-0055). Letting administrators point the master at arbitrary URLs changes the trust model: the control plane
becomes a client of addresses chosen in the panel (SSRF), and event data leaves the system.

## Decision

1. **A versioned event catalog** (`@remyral/protocol` `webhooks.ts`, catalog version 1) with strict Zod data schemas
   and examples, served as OpenAPI 3.1 `webhooks` in `/openapi.json`. Payloads carry ids, titles, names, enumerations,
   counts and console links — never secrets, prompts, logs, diffs or agent output. Free text (failure reasons,
   approval summaries, deploy errors) only in opt-in detail fields, redacted and cut to 500 characters.
2. **The master sends** (not a worker): events are master state, receivers are often SaaS endpoints, and the master
   already has a guarded HTTP client. The floor: `https://` only, ports 443 / 8443, no credentials in the URL, never a
   loopback / private / CGNAT / ULA / link-local / metadata / internal-name host (the ADR-0055 K1 static check) and every
   resolved address checked at connect time; no redirects; 10 s deadline; 4 KiB read.
3. **Internal targets are an owner decision.** An exact `https://` origin may skip the address checks only when the
   owner lists it (`webhook_settings.internal_origins`) — under the safe-core step-up event `security.policy`, audited
   with before / after. Removing it stops deliveries to it at once (checked before every attempt).
4. **Administrators manage subscriptions** (`webhooks.read` / `webhooks.write`, admin+; a new balanced step-up event
   `integrations.webhooks` for create / change / resume / rotate / reveal; pausing, testing, redelivering and deleting
   never ask). Writes are session only; an `admin`-scoped API token may read.
5. **Signed, idempotent, at-least-once.** `X-Remyral-Signature: t=…,v1=…` (HMAC-SHA256 over `t.body`), one `v1` per
   valid secret during a rotation overlap (≤ 7 days); `X-Remyral-Delivery` is stable across retries and redeliveries.
   The secret is shown once (or revealed once for a webhook the assistant created) and stored sealed with an HKDF
   sub-key of the master key; secret header values likewise, write-only.
6. **The audit log is the outbox.** The producer is a cursor over `audit_events`, whose ids commit in order (the append
   lock is held until commit); delivery rows are written in the transaction that advances the cursor. Deliveries are
   claimed as fenced leases (`FOR UPDATE SKIP LOCKED`, claim token), so several masters never send one delivery at the
   same time. Retries 1 min … 24 h with jitter; auto-disable after 15 consecutive failed attempts with a notification.
7. **The assistant** lists webhooks and drafts create / pause / resume cards through the same service and the
   security policy; it never sees a secret or a header value.

## Consequences

- Event data leaves the system by an administrator's choice; it is bounded by the strict schemas and the redaction of
  the opt-in details. Webhooks are admin-only, so they cannot widen what a person sees.
- The SSRF floor is the same as for workflow HTTP nodes; the only way around it is the owner's audited list.
- Using the audit log as the source means a new event type needs an audited action (most already exist); two were
  added (`ops.action.start`, `automation.run.finish`). The audit log is append-only and never pruned, so the cursor is
  safe; `audit_events` reads happen in id order on the primary key.
- Receivers must deduplicate (`X-Remyral-Delivery`) and tolerate best-effort ordering.

## Alternatives considered

- **Extend the per-user notification webhook channel:** per-recipient fan-out, free-text bodies and the environment
  allowlist do not fit machine consumers or a catalog.
- **Explicit outbox writes in every source module:** more invasive and easy to forget; the audit entries already exist
  in the same transactions.
- **Send from workers (like workflow HTTP nodes):** would need a worker online for every event and would move master
  state to machines; the master's guarded client is enough.
- **Vault references for header secrets:** vault values are sealed for workers and not readable by the master; sealing
  with a master sub-key keeps them at rest encrypted and write-only.
