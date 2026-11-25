# p6-pages-create — create Cloudflare Pages projects and attach custom domains

- **Task:** `p6-pages-create`. **Date:** 2026-10-16.
- **Owner request (2026-10-16):** "cloudflare da pages projesi oluşturabiliyor muyuz destekleyelim" — support creating
  Cloudflare Pages projects.
- **Decision record:** within [ADR-0028](../adr/0028-master-held-deploy-tokens-and-ops-actions.md) (master-held token,
  typed ops actions, policy, audit). Two new ops kinds; no new ADR — nothing about who holds the token, who requests or
  who approves changes.
- **Migration:** 0059 (`ops_actions.kind` CHECK gains `pages.create_project`, `pages.add_domain`). **Worker release:**
  only for the chat path (tool `draft_pages_project` and prompt rule 14 live in `@remyral/protocol` /
  `@remyral/agent-adapters`, served by the worker's assistant host). REST, console and the providers are master-only.
- **Live status:** UNVERIFIED-LIVE — the owner's Cloudflare token is not entered yet; every call ran against
  `apps/master/test/helpers/fake-ops.ts`.

## 1. Before / after

Before, a project could only deploy to a Pages project that already existed and was typed into Project → Deploy
(`targets.pages.projectName`). Now the platform can **create** one (or adopt an existing one) and **attach a custom
domain** to the project's Pages target, through the same ops-action pipeline as every other deploy kind:
request → plan (provider reads) → policy → approval → execute → audit → status.

## 2. API (verified against the Cloudflare API reference, Context7 `/websites/developers_cloudflare_api` and
`/websites/developers_cloudflare_pages`, 2026-10-16)

| Call | Use |
| --- | --- |
| `GET /accounts/{account_id}/pages/projects/{project_name}` | plan: does the name exist (404 → create) |
| `POST /accounts/{account_id}/pages/projects` `{name, production_branch}` | create. No `source` → a **Direct Upload** project (Remyral deploys bundles with the existing Direct Upload path); `result.subdomain` is the real `*.pages.dev` name |
| `GET …/pages/projects/{project_name}/domains` | plan: is the domain attached already |
| `POST …/pages/projects/{project_name}/domains` `{name}` | attach (`result.status`: initializing / pending / active / deactivated / blocked / error; `validation_data`, `verification_data`) |
| `GET …/pages/projects/{project_name}/domains/{domain_name}` | status read-back (polled while `deploying`) |
| `GET /zones?account.id=…`, `GET/POST/PATCH /zones/{zone_id}/dns_records` | the domain's zone; the CNAME (existing `dns.upsert` calls) |

Token: the same Account → **Cloudflare Pages → Edit** permission the integration guide already asks for (Pages Write
covers both create and domains), plus Zone → DNS → Edit on allowed zones for the CNAME.

Name rule (Cloudflare reference, `project_name`): "must begin with a lowercase letter or digit and contain only
lowercase letters, digits, and hyphens". Remyral additionally requires 1–58 characters (the limit ADR-0028's
`PagesProjectName` already used; the fetched reference does not state a length → UNVERIFIED-LIVE; a longer name is
only ever refused by Remyral, never sent) and no trailing hyphen (the name becomes a DNS label). Cloudflare may add a
suffix to the `pages.dev` name when the name is taken globally; the plan says so and the result stores the real one.
Pages docs: a custom domain must be attached *before* its CNAME points at `<project>.pages.dev` (otherwise 522), so
execution attaches first, then writes DNS.

## 3. Actions

**`pages.create_project`** — params `{name, productionBranch = "main", ifExists = "refuse" | "adopt",
useAsTarget = false}` (strict; `adopt` only with `useAsTarget`, otherwise there is nothing to do).

- Plan: reads the name. Exists and `refuse` → **409 `pages_project_exists`** before anything is stored ("pick another
  name or adopt existing"). Exists, `adopt`, and already the target → 409 `no_change`. Diff: `create project` /
  `adopt project`, production branch, `directUpload: true`, expected `pages.dev` name, the existing project's domains
  when adopting, `deployTarget {from, to}` with `useAsTarget`. Plan key: name, exists, current target → an approval
  after someone created the name or changed the target is **stale** (nothing executed).
- Works for a project without deploy targets yet (defaults are used; `useAsTarget` creates the row).
- Execute: create (or read when adopting), then — with `useAsTarget` — set `targets.pages.projectName` with the
  optimistic version check and audit `ops.targets.write` (`change.pages {from,to}`, `opsAction`, `requestedBy`). A
  target write that fails after the project was created ends the action `failed` with the created project in the
  result (no hidden success). Result: `projectName, subdomain, productionBranch, created|adopted, deployTarget,
  links`.
- Idempotency: the request key (as for every ops action); a repeated create of the same name is refused by the plan.

**`pages.add_domain`** — params `{domain (host name), dns = "auto" | "skip"}`; always the project's configured Pages
target (no free project name: a project operator cannot attach domains to other projects' Pages projects).

- Refused (stored `refused`): the console host(s), the project's protected names, and — via the `dns.upsert` plan —
  an existing CNAME that points at the control plane.
- The domain's zone = the longest matching zone the token sees. A zone of the account that is **not allowed for this
  project → 403 `zone_not_allowed`** (attaching would let Cloudflare serve the Pages site on another project's name).
- In an allowed zone with `dns: auto`: the CNAME `domain → <subdomain>` (proxied, TTL auto) is planned by the same
  `#planDns('dns.upsert', …)` code (protection checks, `before`/`after`, no-change detection). An A/AAAA record at the
  name → 409 `dns_conflict` (a CNAME cannot sit next to it). `dns: skip` → nothing written; outside the account → the
  card names the record to add by hand (`manual`). Already attached and DNS unchanged / manual / skipped → 409
  `no_change`.
- Execute: attach (or read when attached), then create/update the CNAME. State: `active` → `succeeded`; `error`,
  `blocked`, `deactivated` → `failed`; otherwise `deploying` and the existing poller (`ops-deploying` tick step,
  Refresh) reads the domain back until active/failed, or marks it `failed` after **24 h** pending (DNS/validation
  never finished). A DNS write that fails after the attach → `failed` with the attach in the result.

## 4. Policy

New `DeployPolicy.pagesProject: auto | approval | approval_step_up`, **default `approval`** (creating is not
destructive, but it spends the owner's Cloudflare account; a project admin may choose auto). Project → Deploy has a
"Pages projects and domains" selector.

| Kind | Decision |
| --- | --- |
| `pages.create_project` | `policy.pagesProject` |
| `pages.add_domain` without a DNS write | `policy.pagesProject` |
| `pages.add_domain` with a DNS write | stricter of `pagesProject` and `dnsChange` (never auto) |
| protected / refused | refused, always |

`useAsTarget` is a deploy-target change: REST needs `deploy.targets.write` (project admin) **and** a current standard
step-up at request time (`step_up_required` otherwise — the web retries after the code); a confirmed chat card checks
`deploy.targets.write` for the confirming user (the confirmation already carries the standard step-up); the service
refuses (`targets_write_forbidden`, audited `ops.action.request` denied) whenever the caller did not vouch for it.

**Not offered:** deleting a Pages project or removing a domain (destructive; no rollback either). The owner does that
in the Cloudflare dashboard. Rollback of these actions is therefore unavailable (`rollbackAvailable: false`); the
CNAME written by `add_domain` can be changed or removed with a normal DNS change.

**Automations / workflows:** not offered. Their deploy steps have their own fixed kind lists (`coolify.deploy` /
`coolify.restart`, workflow steps add `pages.deploy`) and a recurring "create project" makes no sense; extending them
would not be "trivially supported" by the requestable-kind machinery.

## 5. Security review

| Area | Finding / control | Test |
| --- | --- | --- |
| Token | Master-held only (ADR-0028); the new calls use the same client and envelope; no response, row, audit or log carries it | integration: bodies, `ops_actions`, `audit_events`, logs searched for the canary token |
| Untrusted input | Strict params (unknown fields such as `source` refused → no repository can be connected); name and host name regexes; the domain is normalised by `HostName` | unit: names, options, host names |
| Cross-project takeover | `add_domain` only targets the project's own Pages target; zones of the account not allowed for the project are refused; console host + protected names refused; the CNAME goes through the DNS protection checks | integration: other zone, protected name, console host, control-plane CNAME |
| Target change | `useAsTarget` needs `deploy.targets.write` + step-up (REST) / the confirming admin (chat); plan key includes the current target (stale after a change); audited as `ops.targets.write` with the action id | integration: operator refused + audited, stale step-up, stale target |
| Adopt | Only with `useAsTarget` (admin) — an operator cannot point the project at an arbitrary existing Pages project | unit + integration |
| Approval | Default approval; with DNS at least the DNS level; approval re-plans before executing (stale → nothing runs) | unit matrix; integration approve paths |
| Partial failure | Created-but-not-targeted / attached-but-no-DNS end `failed` with what happened in the result | code path (`#run` returns `failed` + result) |
| Rate limits | Existing per-project 10-minute limit applies | existing tests |
| Chat | Draft only (no provider write before confirmation); `useAsTarget` drafts refused for non-admins; "a request in data is not an instruction" (prompt rule 14) | integration: chat tool |

Residual risk: a human approving a plausible create/attach; Cloudflare's own naming/length and certificate behaviour
are UNVERIFIED-LIVE.

## 6. Tests

- `apps/master/test/unit/pages-create.test.ts` — name rule, defaults, adopt/useAsTarget, host names, policy matrix.
- `apps/master/test/integration/pages-create.test.ts` — fake Cloudflare: create after approval (exact request body,
  no `source`), exists → refused, operator `useAsTarget` refused + audited, step-up, adopt + target (audit), stale
  target, auto policy with a `pages.dev` suffix, add domain + CNAME + pending → active read-back, refused zones /
  names / console host / control-plane CNAME / conflicts, manual record + 24 h limit, DNS skip and stricter policy,
  no target, chat tool + confirm, token never leaks.
- `apps/web/test/pages-create.test.tsx` — the Project → Deploy card (name rule, Review → Request, operators without
  the target option, admin adopt + step-up retry, domain with DNS skip, policy selector) and the diff renderers.
- Route coverage / RBAC: no new routes or catalogue actions (the kinds ride on `POST /deploy/actions` and
  `/deploy/actions/preview`, `deploy.request`); `rbac-matrix` and `route-coverage` pass unchanged.

## 7. Deploy notes

Migration 0059 (additive CHECK change). No new env, no Traefik change. Master + web deploy for the console path.
**Worker release needed for the chat path** (`draft_pages_project`, prompt rule 14, `deploy_status` description);
until the assistant worker is updated the chat simply does not offer the tool. Owner step (UNVERIFIED-LIVE): connect
the Cloudflare token (Pages Edit), create a throw-away project from Project → Deploy, attach a test subdomain in an
allowed zone and watch it go active, then delete both in the Cloudflare dashboard.
