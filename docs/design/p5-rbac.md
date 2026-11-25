# Design note: RBAC/ABAC enforcement on every REST endpoint (P5)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** p5-rbac-api — acceptance A-SEC-1 ("MFA and role checks cover all management actions", as
  re-scoped by ADR-0009); P5 gate "every critical control action works through web UI and REST API with
  authorization checks"
- **Decisions applied:** ADR-0009 §1/§10/§11 (roles, step-up, in-app RBAC with project attributes),
  ADR-0006 (no secrets in logs/audit)
- **Builds on:** [p1-master-auth.md](p1-master-auth.md) (sessions, `requireAuth`, step-up),
  [p4-approvals.md](p4-approvals.md), [p6-context-model.md](p6-context-model.md),
  [p5-search-audit.md](p5-search-audit.md)
- **Threat model:** T-CP-3 (broken authorization / IDOR across projects), T-CP-2 (session abuse,
  step-up), T-OPS-3 (repudiation: every management action audited)

## 1. Scope

| Piece | Where | Responsibility |
| --- | --- | --- |
| Policy model (PDP) | `apps/master/src/authz/model.ts` | Action catalog, `Subject`/`Resource`, `authorize()`, `projectRoleOf()`, `visibleProjects()`. Pure. |
| Declaration types | `apps/master/src/http/route-authz.ts` | `config.authz` (`AuthzRule`), `request.authz` (`AuthzContext`), `Authorizer` port. |
| Enforcement (PEP) | `apps/master/src/authz/authorizer.ts`, hook in `apps/master/src/app.ts` | Loads the subject, evaluates the route's rule, 403/404, denial audit. |
| Resource resolvers | `apps/master/src/authz/resources.ts` | job / approval / context-doc / project → resource attributes. |
| Directory | `apps/master/src/authz/directory.ts`, `routes.ts` | Projects, memberships, user accounts API. |
| Migration | `apps/master/migrations/0010_rbac.sql` | `projects`, `project_memberships`, `users.disabled_at`, `users.created_by`, backfill. |
| Console | `apps/web/src/screens/UsersPage.tsx`, `ProjectsPage.tsx`, `apps/web/src/api/directory.ts` | Settings → Users, Settings → Projects (membership editor). |

## 2. Authorization model

**Subject** = the authenticated user: account role (`users.role`) + project memberships.
**Resource** = attributes of what is acted on: `project` (or none: a global resource or a collection) and,
for self-service actions, `ownerId`. **Action** = one entry of an explicit catalog; anything else is denied.

Roles (ADR-0009):

- `owner`, `admin` are **global**: they hold their role in every project and have no memberships (the API
  refuses to create one: `400 global_role`; promoting an account to owner/admin deletes its memberships).
- `operator`, `viewer` are **per project**: they see a project only through a `project_memberships` row.
  Their role there is `min(membership role, account role)` — the account role is a **ceiling**, so one
  demotion takes effect in every project at once, and a viewer account can never act as an operator.

### Decision order (`authorize(subject, action, resource)`)

1. Unknown action → deny (`unknown_action`). Lookups use `Object.hasOwn`, so `constructor`/`__proto__` are
   not actions.
2. Account role below the action's `minRole` → deny (`role`, 403). **Resource-independent**: this check runs
   before the resource is resolved, so a refusal here never reveals whether the addressed object exists.
3. `selfOnly` actions (`session.self`) need `resource.ownerId === subject.userId`.
4. Project-scoped action on a resource in a project: project not visible → `not_visible` (→ **404**, the same
   body the handler returns for a missing object); effective project role below `minRole` → `role` (403).
5. Otherwise allow, with the effective role (project role or account role).

Without a resource (collections, creation without a project) a project-scoped action is decided by step 2
and the list endpoint filters rows by `visibleProjects(subject)`.

### Action catalog

| Action | Scope | Min role | Routes |
| --- | --- | --- | --- |
| `session.self` | self | viewer | `POST /auth/step-up`, `/auth/logout`, `/auth/logout-all`, `GET /auth/session` |
| `api.docs` | global | viewer | `GET /openapi.json` |
| `jobs.read` | project | viewer | `GET /jobs` (filtered), `GET /jobs/:id` |
| `jobs.export` | project | operator | `GET /jobs/:id/export` (+ step-up, rate limit) |
| `jobs.create`, `jobs.cancel` | project | operator | (job submission / cancel routes, p5-composer) |
| `jobs.merge` | project | operator | `POST /jobs/:id/merge`, `/discard` — opens a `git.merge` / `git.force_push` approval only (p4-git-flow); `GET /jobs/:id/changes` is `jobs.read` |
| `approvals.read` | project | viewer | `GET /approvals` (filtered), `GET /approvals/:id` |
| `approvals.decide` | project | operator | `POST /approvals/:id/approve`, `/deny` — the request's own approver role still applies |
| `policy.read` / `policy.write` | project | admin | `GET` / `PUT /projects/:id/policy` (+ step-up) |
| `context.read` | project | viewer | `GET /context/docs` (filtered), `/context/docs/:id`, versions |
| `context.write` | project | operator | `POST /context/docs`, `/versions`, `/rollback` — document write role still applies |
| `context.delete` | project | admin | `PUT /context/docs/:id/access`, `DELETE /context/docs/:id` (+ step-up) |
| `context.purge` | global | admin | `POST /context/purge` (+ step-up) |
| `context.bundle` | project | operator | `GET /context/bundle?project=` |
| `audit.read` / `audit.verify` / `audit.export` | global | admin | `/audit*` (export + step-up) |
| `workers.read` | global | viewer | `GET /workers`, `GET /workers/:id` |
| `workers.approve` | global | admin | `POST /workers/:id/approve`, `/deny` (+ step-up) |
| `workers.drain` / `workers.revoke` | global | admin | `POST /workers/:id/drain`, `/revoke` (+ step-up) |
| `workers.rotate` | global | admin | `POST /workers/:id/rotate`, `/approve-rotation` (+ step-up) |
| `workers.archive` | global | admin | `POST /workers/:id/archive`, `/unarchive` (+ step-up) |
| `workers.config.read` | global | admin | `GET /workers/:id/config`, `/config/history` (ADR-0015; a configuration names projects a viewer may not see) |
| `workers.config.write` | global | admin | `PUT /workers/:id/config`, `POST /workers/:id/config/rollback`, `POST /workers/config/bulk` (+ step-up) |
| `usage.read` | project | viewer | `GET /usage/summary` (filtered), `GET /usage/prices`, `/usage/prices/versions` |
| `usage.records` | project | operator | `GET /usage/records` (filtered) |
| `prices.write` | global | admin | `PUT /usage/prices` (+ step-up) |
| `budgets.read` | project | viewer | `GET /budgets` (filtered), `GET /budgets/:id` |
| `budgets.write` | project | admin | `POST /budgets`, `PUT`/`DELETE /budgets/:id` (+ step-up) |
| `projects.read` | project | viewer | `GET /projects` (visible projects only) |
| `projects.create` | global | admin | `POST /projects` (+ step-up) |
| `projects.git.read` / `projects.git.write` | project | viewer / admin | `GET` / `PUT /projects/:id/git` (write + step-up; p4-git-flow) |
| `projects.workers.read` / `projects.workers.write` | project | viewer / admin | `GET` / `PUT /projects/:id/workers` (write + step-up; changes worker configurations, ADR-0015) |
| `projects.members.read` | project | viewer | `GET /projects/:id/members` |
| `projects.members.write` | project | admin | `PUT` / `DELETE /projects/:id/members` (+ step-up) |
| `users.read` | global | admin | `GET /users` |
| `users.manage` | global | owner | `POST /users`, `PUT /users/:id/role`, `POST /users/:id/disable`, `/enable` (+ step-up) |

Fine-grained object rules stay where the object lives (defence in depth, not duplicated): an approval
request's `approverRole` (now compared with the caller's *project* role), a context document's
`readRole`/`writeRole` and namespace floors, the policy floor.

## 3. Enforcement

Each route declares its rule in `config.authz`:

```ts
r.get('/jobs/:id', {
  config: { authz: { action: 'jobs.read', resource: jobResource(db), notFound: jobNotFound } },
  schema: { … },
}, handler);
```

Request lifecycle for a full-session route:

| Stage | Hook | Outcome on failure |
| --- | --- | --- |
| onRequest | `requireAuth` (session, stage, CSRF) | 401 / 403 `csrf_failed` |
| **preValidation** | **authorization** (`createAuthorizer`) | 403 `forbidden` / 404 |
| validation | Zod schemas | 400 |
| preHandler | `requireStepUp` (unchanged), per-route | 403 `step_up_required` |
| handler | business rules | … |

Authorization runs **before validation**, so an unauthorized caller cannot probe input validation (400 vs
403) and the resolvers see unvalidated input — they type-check every field and use parameterised SQL only.
Login steps (`config.auth` = `public` / `mfa_pending` / `enrollment`) have no subject and are skipped; they
are the explicit allowlist of the route-coverage test.

**Deny by default:** a full-session route without `config.authz` is refused with 403 at runtime (for every
role, including owner) and logged at error level; the route-coverage test fails on it at build time. The
`onRoute` registry records `auth` and `action` for every route (HEAD routes inherit the GET config).

**Denial audit:** refusals of state-changing requests are audited — under the route's `auditDenied` action
when declared (keeping the action names the services use for their own refusals: `approval.decide`,
`policy.update`, `context.doc.*`, `audit.read/verify/export`, `job.export`), otherwise as `authz.denied`
with target `METHOD /route`. Ordinary read refusals are not audited (no log flooding by viewers).

**Handlers** read the decision from `request.authz` (`subject`, `resource`, effective `role`); the approval
and context routes pass the effective project role to their services. `AccessGate` keeps step-up and rate
limits for the read/export routes; its role checks were removed because the central rule is equivalent.

### Adding a route (fleet, usage, budgets, …)

1. Pick an action from the catalog (or add one to `ACTIONS` **and** to `EXPECTED` in
   `test/integration/rbac-matrix.test.ts` — the matrix fails until both agree).
2. Declare `config: { authz: { action, resource?, notFound?, auditDenied? } }`. For a project-bound
   resource, add a resolver to `authz/resources.ts` (e.g. `SELECT project FROM … WHERE id = $1`).
3. Filter list queries with `visibleProjects(authzOf(request).subject)` (null = all projects).
4. If the route has a path parameter and a project-scoped action, add its fixture to `bindParams()` in the
   matrix test (the test names the missing parameter).
5. Worker-facing routes (`GET /v1/worker`, device-key auth) are not human routes: they are listed in the
   `DEVICE` allowlist of `route-coverage.test.ts` and authenticate the device themselves.

## 4. Project scoping in queries

| Endpoint | Scoping |
| --- | --- |
| `GET /jobs` | `JobListFilter.projects = visibleProjects()` → `j.project = ANY($n)`; `?project=` of an invisible project returns nothing. |
| `GET /jobs/:id`, `/export` | resolver: job's project → 404 `job_not_found` when invisible. |
| `GET /approvals` | `ApprovalService.list({ projects })` → `j.project = ANY($n)`. |
| `GET /approvals/:id`, decide | resolver: request → job → project; 404 `approval_not_found` when invisible. |
| `GET /context/docs` | `ContextActor.projectRole` — project documents of invisible projects are dropped; global/skill documents keep the account role. |
| `/context/docs/:id*` | resolver: namespace → project; 404 `context_doc_not_found`. The store applies the same rule again (`roleIn`). |
| `GET /context/bundle` | resolver on `?project=`; the store checks the project role (operator) and withholds by it. |
| `GET /projects` | only visible projects, each with the caller's effective role. |
| `GET /usage/summary`, `/usage/records` | `UsageFilter.projects` → `r.project = ANY($n)` (group-by worker/runtime/… only aggregates visible projects). |
| `GET /budgets`, `/budgets/:id` | operator/viewer see only `project`-scoped budgets of member projects; global/runtime/worker/provider budgets aggregate across projects and are owner/admin-only (404 otherwise). |

Projects are identified by the same `^[A-Za-z0-9_.:-]{1,128}$` identifier existing tables use, so no data
rewrite was needed; migration 0010 registers every identifier already present in jobs, policies,
context, usage records and project budgets. A job created later for an unregistered project is visible to owner/admin only until an admin
registers the project (`POST /projects`).

## 5. Project and user management API

| Route | Who | Notes | Audit |
| --- | --- | --- | --- |
| `GET /projects` | any | visible projects | — |
| `POST /projects` | owner/admin, step-up | 409 `project_exists` | `project.create` |
| `GET /projects/:id/members` | project members, owner/admin | 404 for invisible projects | — |
| `PUT /projects/:id/members` | owner/admin, step-up | upsert `{userId, role: operator\|viewer}`; 400 `global_role` | `project.member.set` (with previous role) |
| `DELETE /projects/:id/members?userId=` | owner/admin, step-up | 404 `membership_not_found` | `project.member.remove` |
| `GET /users` | owner/admin | accounts, MFA status, memberships; never secrets | — |
| `POST /users` | owner, step-up | `{username, role}`; returns `temporaryPassword` **once** | `user.create` (no password) |
| `PUT /users/:id/role` | owner, step-up | not one's own (409 `self_change`); last active owner stays (409 `last_owner`) | `user.role.change` |
| `POST /users/:id/disable` | owner, step-up | ends every session; login refused; same guards | `user.disable` |
| `POST /users/:id/enable` | owner, step-up | clears lockout | `user.enable` |

Refusals (409/404/400) are audited with outcome `denied`. New accounts have no TOTP, so their first login
lands in mandatory enrollment exactly like the bootstrap owner (ADR-0009 §4). The temporary password is 24
base64url characters (144 random bits), checked against the password policy, hashed with scrypt, returned
once in the 201 body (`Cache-Control: no-store`), and never logged or audited — the integration test greps
the audit table and the logs for it.

Disabled accounts: `sessions.find` joins `users.disabled_at IS NULL`, so a disable takes effect on the next
request even before the session rows are deleted; login answers the generic `invalid_credentials` after a
timing-equalising password check and audits `auth.login.password` / `denied` / `disabled`.

The last-owner guard locks every active owner row (`FOR UPDATE`) inside the transaction, so two owners
demoting each other concurrently cannot both succeed.

## 6. Console

Settings shows the caller's account role and links to **Users** (owner/admin) and **Projects and
memberships** (everyone). Users: account list with MFA/lock/disabled status and memberships; owners get the
create form (temporary password shown once with a copy button and an explicit "I have handed it over"
dismiss — it is not kept in any state afterwards), role change and disable/enable per row (not on their own
row). Projects: visible projects with the caller's role; owner/admin register projects and edit
memberships (only operator/viewer accounts that are not yet members are offered). All writes run through
`useStepUp().run`, which opens the TOTP dialog on `403 step_up_required` and retries once. Untrusted strings
(project names, usernames) are rendered as text.

## 7. Tests

- `test/unit/authz-model.test.ts` — decision order, deny-by-default (incl. prototype keys), ceiling, global
  roles, self-only.
- `test/integration/route-coverage.test.ts` — every full-session route declares a catalogued action;
  non-full routes are exactly the allowlists.
- `test/integration/rbac-matrix.test.ts` — **generated from the route registry**: every declared route ×
  {owner, admin, operator-member, operator-non-member, viewer-member, viewer-non-member, viewer account with
  an operator membership, unauthenticated, mfa_pending, enrollment}, against an independent `EXPECTED`
  table per action, using real fixtures in project `alpha` (job, approval request, context doc). Uses the
  `authzProbe` test seam: with `x-authz-probe: 1` the app answers 204 right after a successful decision
  (before validation and handlers), so writes have no side effects. The seam is a `createMasterApp` option
  that `main.ts` never sets. Also checks that hidden and missing resources produce identical 404 bodies.
- `test/integration/rbac-api.test.ts` — real handlers: list/detail scoping for jobs, approvals and context,
  the role ceiling, grants taking effect on the next request, project/user API including step-up, duplicate
  handling, temporary-password secrecy, first-login enrollment, role change, disable/enable, last owner,
  audit events, and deny-by-default for an undeclared route.
- `apps/web/test/directory.test.tsx` — Users and Projects screens: step-up retry, one-time password
  display, validation, read-only views for admin/operator, membership editor, hostile names as text.
- Existing suites now grant memberships to their operator/viewer users for the projects they use.

## 8. Migration and rollback

`0010_rbac.sql` only adds tables/columns and inserts project rows; existing rows are untouched. Rollback
(after reverting the code): `DROP TABLE project_memberships; DROP TABLE projects; ALTER TABLE users DROP
COLUMN disabled_at, DROP COLUMN created_by;` — note that the pre-RBAC code lets every operator/viewer see
every project, and re-enables disabled accounts.

## 9. Security review (T-CP-2, T-CP-3)

| Threat | Control | Verified by |
| --- | --- | --- |
| T-CP-3 IDOR across projects | Project attribute resolved server-side from the stored object (never from client input for existing objects); invisible → 404 indistinguishable from missing; lists filtered in SQL. | matrix (non-member columns), rbac-api scoping tests, identical-404 test |
| T-CP-3 missing check on a new route | Deny by default at runtime + build-time coverage test + matrix generated from the registry. | route-coverage, rbac-api "undeclared" |
| T-CP-3 privilege via membership | Account role is a ceiling; owner/admin cannot get memberships; only admins manage memberships; only owners manage accounts. | unit ceiling tests, matrix `viewer-opmember`, rbac-api |
| T-CP-3 existence oracle | Role check before resource lookup; same 404 body for hidden and missing. | unit "no existence oracle", matrix |
| T-CP-3 validation probing | Authorization before schema validation. | matrix (probe answers before validation) |
| T-CP-2 stolen session escalates | All management writes need step-up ≤ 10 min (existing hook, unchanged); CSRF on every write; disable revokes sessions and `sessions.find` rejects disabled accounts immediately. | rbac-api step-up + disable tests |
| Account takeover by the creator | Temporary password only shown once; the new user must enrol their own TOTP, which the creator never sees. Residual: the creator knows the password until the user changes it (see below). | rbac-api |
| Lock-out of the installation | No self-demotion/self-disable; last active owner guarded under row locks; CLI `admin:reset` remains for shell recovery. | rbac-api, service-level last-owner test |
| Repudiation | Every grant/revoke/create/role change/disable/enable and every refusal audited in the hash chain. | rbac-api audit assertions |

Residual risks / follow-ups:

- ~~Self-service password change does not exist yet~~ — resolved by p5-self-password
  ([p5-self-password.md](p5-self-password.md)): accounts created here must replace the temporary password
  right after their first second factor, and every user can change their password from Settings.
- Subject (memberships) is loaded per request (one indexed query); role changes apply on the next request.
  No caching, so no staleness window.
- Context bundle *previews* judge global documents with the project role (never more than the account
  role) — slightly stricter than the document list, intentionally.
- Jobs created for unregistered projects are owner/admin-only until registered (fail closed).
