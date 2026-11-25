# p22-vault-projects — workflow vault credentials can be limited to projects

Known gap "Kasa anahtarları projeye bağlı değil" (the internal note `bilinen-eksikler` (not published); p18-multi-project §3: "any project
admin with `workflows.define.network` can reference any global vault credential id. A project allowlist on credentials
is listed as a follow-up.").

## 1. Problem

The vault is global (`vault_credentials`, `mig/0030`). A workflow HTTP / e-mail node names an `http-auth` / `smtp`
credential by id, and only the credential's kind, state and bound hosts were checked
(`m/src/workflows/v2/functions.ts` `boundCredential`). So the admin of **any** project could:

- save a workflow whose node references another team's credential (`workflows.define.network` + step-up);
- bind a shared workflow's credential slot to it (`m/src/workflows/sharing.ts` `bindCredential`);
- and the run then built a function job carrying that credential id, which the worker attached to the request.

Nothing tied a credential to the projects it was made for.

## 2. Change

**Allowlist.** Migration `0216_vault_credential_projects.sql`: `vault_credentials.projects text[] NULL`.
`NULL` = every project — every existing credential keeps working unchanged. A non-empty list (1–200 ids) = only those
projects. Only `http-auth` / `smtp` may carry one (a CHECK constraint and the service): other kinds are bound to
projects elsewhere (project environment variables, repository credentials) or are machine-level runtime keys.

**Managing it.** `PATCH /vault/credentials/:id` `{ projects: string[] | null }` — the same authorization as every vault
write (`vault.write`, admin), the vault's always-fresh step-up (added to `ALWAYS_FRESH_ROUTES`) and CSRF. Unknown
project ids, an empty list, more than 200 and other kinds are refused (`400 credential_invalid`, issue `projects:
unknown_project | required | too_many | not_allowed`); a revoked credential is `409 credential_revoked`. Audited
`vault.credential.projects` with `before` / `after` (`'all'` for null). `POST /vault/credentials` accepts the same
optional `projects`. Every credential view carries `projects`. There was no metadata-update route before; the value
rotation route (`PUT …/value`) needs a re-sealed value, so the allowlist got its own route.

**Enforcement** — one error code everywhere, `credential_not_allowed_for_project`, and every refusal fails closed:

| Where | What happens |
| --- | --- |
| Workflow save / validate (`functionNodeIssues`, `m/src/workflows/engine.ts`) | `400 invalid_workflow`, issue on `nodes.N.config.auth.credential` / `smtp.credential`; audited `workflow.define` denied |
| Shared-workflow slot binding (`sharing.ts` `bindCredential`) | `403 credential_not_allowed_for_project` (the binding project); audited `workflow.attachment.credential` denied |
| Run-time build of the function job (`buildFunction` in `v2/engine.ts`) | the node fails (no retry) with the code, no job is created; audited `vault.credential.use` denied |
| Dispatch of a queued function job (`orchestrator.ts` `#dispatch` and `#assignNow`) | the job becomes infeasible (never assigned); audited `job.credential.issue` denied (`kind: vault`); the node reads the code as its error |
| Assistant: `run_http_request` (`chat/credentials.ts`) | refused `forbidden` with the code (the job's project); audited `chat.http_request` denied |
| Assistant: `{{credential:…}}` tokens in a conversation with working projects | not resolved (no id; the block says which project may not use it) |
| Assistant: `list_vault_credentials` in a conversation with working projects | only credentials every working project may use; each row shows `projects` (`'all'` for null) |

The allowlist is read at every use, so narrowing it after a workflow was saved (or after its job was built) is honoured
at the next run / dispatch. Shared workflows: the owner project's credential ids are slots, and the slot's bound
credential is checked against the **running** project at bind time and again at build and dispatch.

**Panel.** Ayarlar → Kimlik bilgileri → a credential's "Değiştir / paylaş" dialog: for `http-auth` / `smtp`, a
**Projeler** section — "Tüm projeler" / "Seçilen projeler" (`DySelect`) and a checkbox per project (`DyCheck`); saved
with step-up. The list row shows "Projeler: tümü" or the chosen ids. Copy in `packages/i18n` (tr + en). The refusal
code reaches the panel like the other workflow credential codes (`credential_host_not_bound` …): as the code and the
master's English message (`WorkflowError`s are not in the `errors` catalog, which covers `HttpError` sites).

Not changed: the worker (it never sees projects; the master decides), other credential kinds, the `@` mention picker
(admin-only, not conversation-scoped; using a picked credential is refused as above). No worker release.

## 3. Verification

- `apps/master/test/integration/vault-projects.test.ts` (real Postgres and routes): existing credentials list
  `projects: null`; the route's always-fresh step-up, unknown project / other kind / empty list refused, set + audit,
  reset to null; null = every project at save; an allowlist refuses the save in another project (issue + audit);
  slot binding refused in B (403 + audit) while a null credential binds; narrowed after the save → the node fails
  `credential_not_allowed_for_project` with no function job (audit); a queued function job whose credential was
  narrowed is never dispatched (infeasible, audit) and the node reports the code.
- `apps/master/test/unit/vault-projects.test.ts`: the null / list rule; chat tokens not resolved outside the
  allowlist; `run_http_request` refused and audited; `list_vault_credentials` filtered by the working projects.
- Re-run unchanged: `vault.test.ts`, `workflow-sharing.test.ts`, `workflow-functions.test.ts`,
  `route-coverage.test.ts`, `openapi.test.ts`, `error-params.test.ts`, `step-up.test.ts`, `assistant-admin.test.ts`.

## Changelog

- feat(master,web,i18n): **workflow vault credentials can be limited to projects** (p22-vault-projects,
  [design](p22-vault-projects.md); closes p18-multi-project §3 "Kasa anahtarları projeye bağlı değil").
  An `http-auth` / `smtp` credential gets an optional project allowlist (`null` = every project, so existing
  credentials are unchanged), set with `PATCH /vault/credentials/:id` (admin, always-fresh step-up, unknown projects
  refused, audited) and in Ayarlar → Kimlik bilgileri → Projeler. A project not on the list cannot save a workflow
  that references it, bind a shared workflow's slot to it, build or dispatch a function job with it, or use it through
  the assistant (`credential_not_allowed_for_project`, audited); narrowing the list after a save is enforced at the
  next run. Migration `0216_vault_credential_projects.sql`; no worker release.
