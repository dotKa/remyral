# ADR-0002: Monorepo and toolchain

- **Status:** Accepted — owner-delegated sign-off, 2026-10-13
- **Date:** 2026-10-12
- **Related:** p0-bootstrap, AGENTS.md "Technical choices"

## Context
AGENTS.md fixes: pnpm workspaces, strict TypeScript for API/frontend/schemas/daemon, React+Vite+Tailwind, Fastify, PostgreSQL migrations, Redis/BullMQ, WebSocket events, Zod for every external message, OpenAPI for REST. The worker daemon must run on macOS, Windows, Linux x64/arm64 including Raspberry Pi.

Versions observed on npm / nodejs.org on 2026-10-12: Node 24.21.0 (Active LTS "Krypton"), Node 26.11.1 (Current, not yet LTS), pnpm 12.11.2, TypeScript 7.0.2, Zod 4.6.7, Fastify 5.12.5, BullMQ 6.3.13, Vitest 5.0.4, ESLint 10.12.0, Vite 8.3.4, React 19.3.0, Tailwind 4.3.3, ws 8.22.0, pg 8.23.1.

## Decision
1. **Runtime:** Node.js 24 LTS on master and workers, pinned via `.nvmrc` and `engines`. Re-evaluate Node 26 once it enters LTS.
2. **Package manager:** pnpm, version pinned with the `packageManager` field (Corepack). Lockfile committed; `--frozen-lockfile` in CI.
3. **Layout:** `apps/web`, `apps/master`, `apps/worker`, `packages/protocol`, `packages/agent-adapters`, `packages/scheduler`, `packages/memory`, `packages/observability`, `infra/coolify`, `docs`.
4. **TypeScript:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM only, project references. TypeScript major chosen at bootstrap after confirming typescript-eslint and Vitest support it; otherwise pin the newest major they support and record it here.
5. **Quality gates:** ESLint (flat config) + Prettier, Vitest for unit/integration, Playwright for e2e, all run in CI on every PR.
6. **Exact pinning:** all dependencies pinned to exact versions (`save-exact`), updates through a dependency-update bot with review (supports P7 supply-chain policy).

## Alternatives considered
- npm/yarn workspaces — rejected, AGENTS.md mandates pnpm.
- Bun/Deno for the worker (single binary) — attractive for distribution, but adds a second runtime; revisit in ADR for worker packaging (p2-signed-updates) using Node SEA or similar.

## Consequences
Worker installers must ship or require Node 24 on every node (Pi included). Packaging decision deferred to p2-signed-updates.

## Verification
CI runs typecheck/lint/test on Linux, macOS and Windows runners; arm64 job for the worker.
