# ADR-0014: Subscription authentication via worker-local login

- **Status:** Accepted — owner decision, 2026-10-13, with the constraints below. **Amended by
  [ADR-0017](0017-remote-worker-operations.md)** (2026-10-14): the worker may start the runtime's own login on
  request from the panel and relay only its sign-in URL / device code (and a pasted code to its stdin); the
  credential itself still never leaves the machine and is never touched by the platform.
- **Date:** 2026-10-13
- **Related:** ADR-0006, ADR-0012 rule 5, docs/compat/claude-code.md §3, docs/compat/codex.md, p3-secrets-worker, p6-cost

## Context
The owner will run Claude Code (and possibly Codex) on **their own Claude/ChatGPT subscriptions**, on their own machines, for their own work. Anthropic's terms (docs/compat/claude-code.md §3, verified 2026-10-12): OAuth is "intended exclusively for purchasers of … subscription plans and is designed to support ordinary use of Claude Code"; developers "may not collect, store, or intermediate Claude.ai credentials or session tokens"; third parties may not offer claude.ai login in their products without approval. ADR-0012 rule 5 had defaulted to API keys for this reason.

## Decision
1. Each runtime on each worker has an auth mode: `secret-ref` (API key / cloud credentials via the worker keystore, ADR-0006) or **`local-login`**.
2. `local-login`: the owner logs in **interactively on that machine as the worker's OS user** with the runtime's own login flow. The platform never reads, copies, stores, injects, rotates, logs or transmits that credential — not on the worker, not on the master. The worker only starts the runtime in an environment where the runtime can find its own login (worker user's HOME / keychain context).
3. The platform does **not** use `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` distribution, and never offers a "log in with Claude" flow in the console.
4. The probe/capabilities report login state only as `authenticated: yes | no | unknown` from the runtime's own status command, never the identity token.
5. Budget enforcement for subscription runs is by **tokens, turns and wall time** (subscriptions have no per-run dollar cost; the SDK's `total_cost_usd` is an estimate). Cost records carry provenance `estimated-from-tokens`; usage-limit errors from the provider are surfaced as a distinct failure reason (`provider_usage_limit`) and pause scheduling of that runtime on that worker until reset.
6. Default for new workers remains `secret-ref`; `local-login` is an explicit per-runtime choice in worker config.

## Risk accepted by the owner
Running a scheduled multi-machine fleet on personal subscriptions may be judged by the provider as exceeding "ordinary use", and subscription usage limits apply per account. The owner accepts this risk; the design keeps the platform out of the credential path so it is not "intermediating" credentials, and switching a runtime to `secret-ref` is a config change.

## Verification
Tests: in `local-login` mode the worker never opens files under the runtime's credential paths and never passes OAuth-token env vars; redaction covers known token patterns; console has no login-with-provider flow.
