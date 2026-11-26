# Contributing to Remyral

Thank you for helping. This file covers the development setup, how tests are run, the commit conventions and the
sign-off we ask for. The binding engineering rules (for people and for AI coding agents) are in
[AGENTS.md](AGENTS.md); read it before a larger change.

## Development setup

Requirements: Node 24 LTS (`>=24.11 <25`), Corepack (it provides the pinned pnpm), Docker with Compose v2 for the
local Postgres and Redis, and `openssl`.

```sh
corepack enable
pnpm install
pnpm dev:keygen     # once: writes .env (random dev passwords) and the dev key files; never prints secrets
pnpm dev:up         # Postgres + Redis on 127.0.0.1 only (infra/dev/README.md)
pnpm --filter @remyral/master migrate
```

Run the console locally (two terminals), then create the first account:

```sh
pnpm --filter @remyral/master dev     # API on 127.0.0.1:8080
pnpm --filter @remyral/web dev        # console on http://127.0.0.1:5173
pnpm --filter @remyral/master admin:create --username <your-name>   # asks for a password (TTY only)
```

To run a worker against that console, follow [docs/ops/local-fleet-test.md](docs/ops/local-fleet-test.md) (a worker in a
Docker container behind a local TLS proxy, or the automated `pnpm e2e:fleet`). `pnpm dev:down` stops the stack and
keeps its data.

## Tests

The repository uses [Vitest](https://vitest.dev/) in every package. Prefer targeted runs while you work:

```sh
pnpm vitest run apps/master/test/unit/some-feature.test.ts      # one file
pnpm --filter @remyral/web exec vitest run src/some/area        # one package, one folder
```

- **Integration tests** of the master need the dev stack (`pnpm dev:up`). Each test file creates and drops its own
  throw-away database and uses its own Redis key prefix, so your development data is never touched. Without the stack
  they fail loudly; set `REMYRAL_INTEGRATION=skip` to skip them explicitly (they are then reported as skipped — CI runs
  them on Linux).
- **What CI runs where:** Linux x64 runs the whole `pnpm verify`; Linux arm64 the unit tests, the build and the
  smoke start (the control plane runs on Linux only); macOS and Windows run what ships to those machines — the worker
  and its packages (`agent-adapters`, `protocol`, `observability`: type check, tests, build) and, on Windows, the
  installer plan tests.
- **Load-flaky tests:** on CI the master tests run two files at once and a failed one is retried twice
  (`REMYRAL_MASTER_TEST_WORKERS`, `REMYRAL_TEST_RETRY`); the job summary lists every test that passed only on a retry.
  Known ones and their symptoms: [Flaky tests on hosted runners](https://github.com/dotKa/remyral/issues/4).
- **Real container engine:** the worker's container-profile escape suite (`apps/worker/test/sandbox-escape/`) and the
  code-node image tests build and run the pinned images against a real Docker engine; they run only with
  `REMYRAL_TEST_DOCKER=1` (CI does not set it: a hosted runner's engine and user ids do not match a worker host).
- **End-to-end suites** need Docker: `pnpm e2e:fleet`, `pnpm e2e:compose`, `pnpm e2e:backup`, and the console's
  Playwright suite (`pnpm --filter @remyral/web e2e`).
- Before you open a pull request run `pnpm verify` (format, lint, typecheck, tests, docs and i18n checks, dependency pin
  audit). If something cannot run on your machine, say so in the pull request instead of skipping it silently.
- Keep installation-specific and personal data out of the repository; `pnpm check:leaks` (part of `pnpm verify`)
  checks it — see [docs/security/leak-check.md](docs/security/leak-check.md).

A change comes with its tests; a bug fix comes with a test that fails without the fix. Concurrency changes test
timeouts, reconnects, duplicate messages and lease loss (AGENTS.md, "Coding workflow").

## Documentation

- Consequential decisions get an ADR in [docs/adr/](docs/adr/README.md) (and a line in its index;
  `node scripts/check-adr-index.mjs` checks it). Larger features get a design note in `docs/design/`.
- Operator documentation is in English under `docs/ops/`. End-user guides are in Turkish under
  [docs/guide/tr/](docs/guide/README.md); file names and `<a id>` anchors there are linked from the product, so keep them.
- User-visible changes add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- Console text goes through the i18n catalogs (`packages/i18n`, Turkish and English); `pnpm check:i18n` checks them.
- Never put secrets, real hostnames, IP addresses, e-mail addresses or other personal data into code, tests, docs or
  commit messages. Use placeholders such as `console.example.org`, `<host>` or `owner@example.com`.

## Commits and pull requests

- Commit messages follow the repository's style: `type(scope): summary` in the imperative, for example
  `fix(worker): retry the lease renewal after a reconnect` or `docs(ops): explain the restore drill`. Common types:
  `feat`, `fix`, `docs`, `test`, `refactor`, `chore`. The body explains why.
- Keep a pull request to one concern and describe how you tested it.
- Do not edit a migration that has been released; add a new one.

### Developer Certificate of Origin

Please sign off every commit. By signing off you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the change or otherwise have the right to submit it under the project's licence
([Apache-2.0](LICENSE)). Add the line with `git commit -s`:

```
Signed-off-by: Your Name <you@example.com>
```

Use your real name (or the name you are publicly known by) and an address you can be reached at. If you forgot,
`git rebase --signoff <base>` adds it to existing commits.

## Where to ask

- Questions and ideas: [GitHub Discussions](https://github.com/dotKa/remyral/discussions) (Q&A and Ideas); see
  [SUPPORT.md](SUPPORT.md).
- Bugs: open an issue with the steps, the expected and the actual behaviour, and the versions of the control plane and the worker
  (`remyral-worker doctor` prints the worker's). Redact hostnames, addresses and paths from logs and probe output before you attach them.
- Security problems: **do not open a public issue**; follow [SECURITY.md](SECURITY.md).
- Everything else: info@remyral.com.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
