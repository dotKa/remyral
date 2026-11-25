# ADR-0024: First-class automations (schedule, GitHub event, signed webhook, job chain)

- **Status:** Accepted — owner decision, 2026-10-15: Remyral has its own automation system instead of relying
  on OpenHands Automations; the ops assistant creates and tracks them.
- **Date:** 2026-10-15
- **Deciders:** owner; implemented by `p6-automations`
- **Amends:** ADR-0022 §1 ("no events, inactive webhook"): the panel GitHub App now receives `pull_request`, `push`,
  `issues` and `issue_comment` deliveries on `/v1/hooks/github` (permission `issues: read` added for new Apps).
- **Related:** docs/design/p6-automations.md (design + security review), p5-composer §4 (schedules, generalised),
  ADR-0006, ADR-0009, ADR-0010, ADR-0018, ADR-0020.

## Context
Schedules (p5-composer) start a job or workflow on a cron or once. The owner wants recurring **and triggered** work —
on GitHub events, on calls from other systems, and after other runs — created and tracked from the panel and from the
ops chat. Triggers that come from outside (GitHub, arbitrary HTTP callers) open a new inbound surface on the control
plane and bring attacker-controllable text (PR titles, issue bodies, webhook JSON) close to agent prompts.

## Decision
1. **One model.** `automations` (trigger + target + policies) and `automation_runs` (one row per trigger occurrence)
   replace `job_schedules` (unused in production — owner, 2026-10-15 — so dropped, not migrated); the `/schedules`
   routes stay as thin aliases creating `cron` / `at` automations.
2. **Four trigger kinds** (plus the one-shot schedule): `cron`, `github`, `webhook`, `chain`; plus manual "run now".
3. **Exactly one run per occurrence.** Every trigger has a dedup key (cron tick, GitHub delivery id, webhook nonce,
   source run id) under `UNIQUE (automation_id, dedup_key)`; a run starts at most once (claimed before submission).
4. **Inbound endpoints** `POST /v1/hooks/github` (GitHub App webhook secret, `X-Hub-Signature-256`) and
   `POST /v1/hooks/<id>` (per-automation secret, HMAC over `timestamp.nonce.body`, ±5 min, nonce single use) are
   public, routed by Traefik, signature-checked over the raw body. Per-automation secrets are shown once and sealed
   with the master key (HKDF sub-key `automation-webhook`), never hashed (HMAC needs the key).
5. **Event content is data.** It reaches a job only as a fenced, bounded block in the context bundle with an explicit
   untrusted notice; the automation's prompt is the only instruction. GitHub events from forks or non-collaborators are
   ignored unless the automation opts in, and then run `untrusted` in the `container` profile without auto-approve.
6. **Authorization.** `automations.read` viewer+, `automations.write` operator+, `automations.external` (GitHub or
   webhook triggers) admin+ — all project-scoped; step-up for create, update, resume of external triggers and secret
   rotation; the creator's (or last editor's) rights are re-checked at every run. Chat writes are draft cards.
7. **Policies per automation:** concurrency `skip` / `queue` / `parallel`, catch-up `skip` / `once` / `all`, an hourly
   run cap, failure notifications.

## Alternatives considered
- **Keep schedules and add a separate triggers table** — two lists, two run histories, two chat tool sets; the
  owner asked for one place to create and track.
- **Poll GitHub instead of webhooks** (ADR-0022's original stance) — latency in minutes, rate-limit cost per
  repository, and no comment commands. Webhooks with signature + dedup are the standard.
- **Store only a hash of the webhook secret** — impossible with HMAC verification (the verifier needs the key); an
  asymmetric scheme would burden every caller.
- **Put event text into the prompt** (templating) — makes untrusted text indistinguishable from the owner's
  instruction; rejected by ADR-0010.

## Consequences
- New public surface (`/v1/hooks/*`): rate-limited per IP, body-limited, no session, signature first; a Traefik rule.
- A GitHub App connected before this change needs "Set up webhook" once (and *Active* + events ticked on GitHub).
- `job_schedules` is dropped; audit actions for schedules become `automation.*`.

## Verification
Unit tests for catch-up, dedup, signatures (skew, replay), GitHub filters and trust, chain conditions, concurrency;
master integration tests over real Postgres for every trigger kind, redelivery, authz/step-up and audit; chat draft
tests; web tests. See docs/design/p6-automations.md §15.
