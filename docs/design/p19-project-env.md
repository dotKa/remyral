# p19-project-env — project environment variables from vault credentials

Owner report 2026-10-31: a credential `DEV_DATABASE_URL` (kind "Diğer" / `generic`, v3) was shared with
win-1 and ip-10-0-0-12 (both "v3 · Makinede") but showed "hiç kullanılmadı", and a job said
"DEV_DATABASE_URL hiçbir yerde tanımlı değil".

## Why it happened

A vault credential reaches a job's environment only through `spec.secretRefs` (worker `planJobEnv`). Runtime keys use
the machine's runtime auth, HTTP credentials the workflow HTTP node, MCP secrets their slot bindings — but nothing put
a `generic` credential into `secretRefs`: the composer API and automation JSON could, the chat and the console could
not. So a credential of kind "Diğer" was delivered and never usable.

## Design

- **Binding**: `project_env_credentials (project, credential_id)` (migration 0201). Projeler → Politika → "Ortam
  değişkenleri": owners / admins add or remove a credential (step-up, audited `project.env_credentials.update` with
  the ids before / after); viewers read. Only active `generic` credentials; the variable is the credential's own
  `env`. Refused: another kind (`credential_kind_not_env`), a runtime key's variable (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `CODEX_API_KEY`, `GH_TOKEN`, … — would be "injected twice": `credential_env_reserved`), two
  credentials for one variable (`credential_env_duplicate`), more than 20 (`too_many_env_credentials`).
- **API**: `GET|PUT /projects/:id/env-credentials` (`projects.execution.read` / `.write`). The answer lists each
  bound credential with the machines holding its current version and the credentials that could be added. Ids and
  names only.
- **Placement**: `PlacementJob.envCredentials {credentials, credentialWorkers}` — only machines holding every bound
  credential at its current version (`vault_credential_workers.acked_version = version`). Elsewhere the job waits
  (`credential_missing`, temporary: delivery is asynchronous).
- **Assignment**: before the lease, `ProjectEnvService.assignment` re-checks the chosen machine (a binding added
  after placement → next candidate); the spec sent in ASSIGN_JOB gets `secretRefs[env] = secret:vault-<id>`. It is not
  stored on the job: a binding change applies to the next assignment (retries included). A reference the job names
  itself for the same variable wins.
- **Never**: untrusted sources, pull request heads, function / integration / machine-admin jobs (the protocol gives
  them no secret references).
- **Worker**: resolves `secret:vault-<id>` from its store, registers the value with its redactor (logs show it masked)
  and marks the credential used ("son kullanım" in Ayarlar → Kimlik bilgileri) — only for ids in the lease's vault
  scope (below).
- **Chat**: a `generic` credential's chat block says it becomes a job variable once a project gives it to its jobs.

## Job-level references

Before this section a job could name any `secret:vault-<id>` in its own `spec.secretRefs` (POST /jobs, API tokens,
automation JSON, re-runs …) and the worker injected whatever its store held under that name — another project's
credential, or a kind that must never become a variable (git keys, host-bound http-auth / smtp, MCP-only secrets).
Credential ids are not secret (the "available" list above, MCP server details, repository credential and runtime
account views show them), so nothing may rely on them being unknown.

- **One rule** (`apps/master/src/project-env/job-refs.ts`): a vault reference a job (or a service's `secretEnv`) names
  is allowed only when the credential is active, of kind `generic`, bound to the job's own project in
  `project_env_credentials` (and allowed by its project allowlist), the variable is neither code-loading /
  subscription (`FORBIDDEN_CREDENTIAL_ENV`) nor a runtime key's own, and the job is env-eligible (no untrusted source,
  pull request head, function / integration / machine-admin job). Any case variant of the `vault-` prefix counts as a
  vault reference; only the canonical lower-case form can be allowed. Non-vault references (`secret:<name>` of the
  worker's own store) are unchanged.
- **Permission**: the project's `jobs.create` (operator+). The admin's binding (step-up, audited) is the grant for every
  job of the project; there is no separate per-user "use credential" permission.
- **Combination**: the worker gets the project's bindings under their own variables plus the job's references; for one
  variable the job's reference wins (as before). Since a job's vault reference must name a credential its project
  already gives its jobs, a job can only re-map or re-use those — never add one. There is no way to remove a project
  variable from one job.
- **Where**: `JobStore.create` (every creation path: HTTP and API tokens, chat drafts and job actions, automations,
  workflows v1 / v2, schedules / job clock, batches, sub-jobs, verification, self-heal, approvals, integration,
  machine-admin, ops feedback, code, run again / clone) refuses with `invalid_job` and the issue
  `spec.secretRefs.<VAR>:vault_credential_not_available` (one code for every reason: no existence oracle). Automations
  refuse it when saved too; a saved one whose binding was removed later fails its next run with the same issue
  ("Not started: …"). Services: `vault_credential_not_available` with the variable names. Retries and resumes reuse the
  stored spec; the assignment checks again.
- **Assignment** (`Orchestrator` → `scopeVaultRefs`): every vault reference of the spec sent (project bindings and the
  job's own) is checked again; one no longer allowed is left out (logged with the variable), and the allowed ids are
  signed into ASSIGN_JOB `lease.vaultScope`.
- **Lease vault scope** (protocol `lease.ts`, additive in 1.0, no worker feature): a second token next to the lease token
  (`rvs1.<claims>.<sig>`, `{v, kid, jobId, attemptId, workerId, epoch, vault[]}`), signed with the master's lease key
  over its own context `remana-lease-vault-scope/v1`. The v1 lease claims stay byte-for-byte as before (they are
  strict: a new claim would make an older worker refuse the lease). A worker that knows the field verifies it against
  the same keyring and lease (job, attempt, worker, epoch) — a scope that does not verify refuses the assignment — and
  `planJobEnv` drops every vault reference of `secretRefs` outside it (variables listed in `droppedRefs`, logged by
  name). The runtime's own credential (worker configuration) is never filtered.
- **Compatibility**: older worker + new master — the `Lease` object is not strict, the field is stripped, the worker
  resolves references as before (the master check still applies). New worker + older master — no `vaultScope`, the
  worker resolves every reference as before. New worker + new master — both checks. RENEW_LEASE carries no scope (the
  environment is planned at assignment only). No worker feature is added on purpose: an unknown feature would make a
  new worker unacceptable to an older master's CAPABILITIES schema.

### Follow-up: visibility, local secrets, reports

- **Ids**: `GET /projects/:id/env-credentials` lists `available` only to callers with `projects.execution.write` (the
  binding permission); others get the project's own bindings. Likewise the vault id of an MCP slot binding
  (`mcp.manage`; viewers get `credentialName`), of a repository credential (`projects.git.write`; others see its name)
  and of an API-key runtime account (`workers.config.write`; others get `null`).
- **Worker-local secrets** (`secret:<name>`, not `vault-*`): default deny — injected into a job or service only when
  the machine owner exposed the name (`remyral-worker secret expose <name> [--project …]`, `<dataDir>/job-secrets.json`,
  a separate file so a rollback to an older worker, which parses config.json strictly, is unaffected). Runtime auth and
  model profile credentials are the worker's own use and are not checked.
- **Reports**: what was not injected reaches the job's timeline by variable name — the master sends the variables it
  withheld at assignment in ASSIGN_JOB `execution.secretRefsWithheld` (additive, older workers ignore it); the worker
  reports those together with lease-scope drops as EVENT `error` `secret_refs_withheld`, and unexposed local secrets
  as `secret_refs_not_exposed` (text `<names> — <why>`, localised by the console by code).
- **Services**: every SERVICE_START from the stored spec (restart, extend, reconnect, egress change) re-checks the vault
  secrets; a credential the project no longer gives stops the service (`stop_reason`
  `vault_credential_not_available: <VARS>`). A worker-side vault scope for services is possible without a protocol
  break the same way as for jobs (a separate optional signed token in SERVICE_START, the start signature unchanged); not
  done yet, since the master signs the whole service spec it sends.

## Security

Values never leave the machines; the master stores ids. A project admin can give a project's jobs any active `generic`
credential (the same trust as choosing the project's machines and execution policy). Untrusted code never gets one.

## Tests

- `apps/master/test/integration/project-env.test.ts` — roles, step-up, refusals, audit, placement holders,
  assignment refs, untrusted source, the job's own reference, revoked credentials.
- `apps/master/test/integration/project-env-e2e.test.ts` — real master and worker daemon: without a binding the agent
  sees an empty variable; with one it sees the value, masked in the job log and the worker log.
- `packages/scheduler/test/placement.test.ts` — temporary `credential_missing`.
- `apps/web/test/project-env.test.tsx` — add with step-up, machines, viewers read only.
- `apps/master/test/integration/job-secret-refs.test.ts` — job-level references: another project's / git / MCP-only
  credential, unsafe variables, untrusted source refused (POST /jobs, automations at save and at run), the project's
  own credential and re-mapping accepted, assignment scope and its signature.
- `apps/worker/test/vault-scope.test.ts` — `planJobEnv` filter, runner with / without / with a bad scope, protocol
  compatibility. `packages/protocol/test/lease.test.ts` — the scope token.

## Rollback

Deploy the previous master; `DROP TABLE project_env_credentials;` is optional (nothing else reads it).
