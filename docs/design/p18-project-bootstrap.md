# p18-project-bootstrap — empty repositories, and a new project's network and machines set up (or asked) by the assistant

Status: **implemented** (2026-10-29, branch `p18-project-bootstrap`, migration **0189**). **Worker release required**
(the next worker after 1.2.2): features `workspace-empty-repo-v1` (Part A) and `assistant-project-setup-v1` (Part B,
prompt rule 56). The master, the console and the REST routes work with older workers (an older worker keeps failing on
an empty repository, with a clear repair hint; its assistant does not get the new tools). Paths: `m/` =
`apps/master/src/`, `w/` = `apps/worker/src/`, `proto/` = `packages/protocol/src/`, `aa/` =
`packages/agent-adapters/src/`, `web/` = `apps/web/src/diyalog/`.

## 1. Owner reports (2026-10-29)

1. "chat otomatik olarak projeyi açıp repo bağlıyor iş planladık başlattık ve ağ erişimi kapalı, makineler bağlı değil.
   bunuda bu süreçte kendisi ayarlamalı veya bana interaktif şekilde sormalı. farklı makineleri farklı işlere göre
   ayırıyorsam böyle yapıyorum onaylıyor musun vs. diyede sorabilir."
2. A job of the new project `sample-leads` (linked to an EMPTY GitHub repository created by hand) failed at preparation:
   `BaseRefNotFoundError: base ref "main" was not found in the repository` (`w/workspace/manager.ts`). "boş repoda main
   yok diyor. olmaz tabi."

## 2. Part A — empty repositories (worker)

**Decision: the base branch gets an empty first commit before the job's work, never the job's work itself.** The git
flow (p4-git-flow, p11-merge-pipeline, p15-merge-approvals) needs a base branch: the master captures "base at job
start", verifies that the attempt branch descends from it, opens the pull request against it, test-merges and merges
it after the human (or policy) approval. Pushing the job's work AS the base branch's first commit would put unreviewed
agent output on `main` without the merge approval (AGENTS.md rule 10) — refused. Pushing the base branch first with an
**empty** commit (empty tree, no parent, a fixed message, the job's git identity) keeps every later step unchanged: the
work arrives as an ordinary pull request onto it.

`WorkspaceManager.prepare` (`w/workspace/manager.ts`):

- After the usual `fetch --prune`, a missing branch base is checked against the mirror: **empty** = no
  `refs/remotes/origin/*` and no `refs/tags/*` (the remote has no branch and no tag). A missing ref in a non-empty
  repository, a full-sha base, or a pull request head stay `BaseRefNotFoundError` as before.
- New `PrepareRequest.emptyRemote {publish, author}` (the runner sets it for every non-PR repository job; integration
  jobs and services do not): `git mktree` (empty tree) + `git commit-tree` with the job's identity and the message
  "Initial commit — the repository was empty …". With `publish` (the job publishes under git flow, `pushResult`) it is
  pushed as `refs/heads/<baseRef>` with `--force-with-lease=<ref>:` — created only while the branch still does not
  exist, it can never overwrite anything. When another job created the branch meanwhile the lease refuses, the mirror is
  fetched again and that branch is the base (`existing`). Without `publish` the commit stays in this workspace
  (`local`). The worktree is created on it as usual (an empty checkout).
- No secret scan is needed for this commit (empty tree, fixed message); the job's own commit keeps the pre-push scan.
- The workspace reports `emptyRepository: pushed | local | existing` (logged). Without `emptyRemote` (an integration or
  pull request job of an empty repository) the error now says so: `… (the repository is empty: it has no branches yet)`
  — the master classifies it as permanent (`m/self-heal/classify.ts`), retrying cannot help.
- **Invariant change** (p4-git-flow §6 "the worker only ever pushes its own `rac/…` ref"): the one exception is this
  create-only push of an empty, parentless commit to the job's base branch of a repository that has no branch at all.

Feature `workspace-empty-repo-v1` (informational: the master names the machines that have it in its repair hint).

Master side of Part A:

- `GitProvider.isEmpty?()` (GitHub `GET …/branches?per_page=1` — the git database endpoints answer 409 "Git Repository
  is empty" instead; GitLab `GET /projects/:id` → `empty_repo`; Bitbucket `GET …/refs/branches?pagelen=1`; plain git
  `ls-remote --heads`). UNVERIFIED-LIVE on the hosted providers (fixtures / docs only).
- `GitFlowService.repositoryState(project)` → `empty | ready | base_missing | unknown` and the route
  **`GET /projects/:id/git/state`** (`projects.git.read`, a read: no body). Projeler → Repo shows **"Boş repo — ilk iş
  ana dalı oluşturur"** instead of a missing-branch protection warning (`web/screens/projects/tabs/repo-sections.tsx`
  `RepoStatePill`). The chat's project card (`draft_project_create`) reports `repository.empty` after linking.
- Base-ref healing (`m/self-heal/base-ref.ts`): an empty repository is not "missing" — no heal to another branch; a job
  on another branch than the project's base is healed to the base branch (so the first commit lands where pull requests
  go). GitHub's 409 for a branch of an empty repository is treated as missing, not as an error.
- Verification (`m/gitflow/service.ts`): the capture loop records the base once the worker created it; when a job
  finishes before the loop saw it, the base is captured late **only** if the target's head is a parentless commit (the
  empty first commit). Any other missing base still fails closed.
- Repair hints: the conversation's job result note (`m/chat/job-result.ts` `baseRefHint`, tr + en: "repo boşsa
  makinenin Remyral sürümünü güncelleyin …; değilse var olan bir dal seçin") and `describe_job.repairHint` (empty
  repository → update the machine / run it on a machine with `workspace-empty-repo-v1`, named; a wrong branch → the
  project's base branch or ask; never create or force-push branches yourself).

## 3. What exists for network and machines (read before Part B)

- **Network**: `project_repo_egress` (p14-repo-egress): `none` (default, model APIs only) / `allowlist` (presets +
  public hosts) / `web`; `PUT /projects/:id/repo-egress` (`projects.egress.write`, always-fresh step-up, event
  `projects.policy`, audit `project.repo_egress.update`). Workspace projects keep their egress on `project_workspaces`.
  The assistant had no tool for it (rule 26 said so).
- **Machines**: project ↔ machine **assignment** = the panel-managed worker configuration's `projects`
  (`PUT /projects/:id/workers`, `projects.workers.write`, step-up, event `machines.config`); placement reasons
  `project_not_assigned`, `project_not_in_worker_allowlist`, runtime / login / sandbox / OS reasons. Per-job pins:
  `requirements.workers` / `os` (`draft_job workers / os`). **No project-level default placement per job kind** existed.
- Runtime accounts / logins per machine are placement facts (`runtime_not_authenticated`, account reasons).

## 4. Part B — the assistant sets up or asks (master + prompt; worker release)

### 4.1 Tools (`proto/assistant.ts`, `ASSISTANT_PROJECT_SETUP_TOOLS`, feature `assistant-project-setup-v1`)

- **`describe_project_readiness {project}`** (read, `projects.workers.read`): repository (linked, `state` incl. empty),
  network (mode, presets, hosts, `decided` = an admin chose it, machines whose Remyral cannot apply it), every enrolled
  machine (name, OS / arch, online, managed, assigned, preferred, `canRun now | later | no`, `assignable` = only the
  assignment is missing, runtimes, `why` = the placement reasons) from the composer's placement preview — the same facts
  dispatch uses (a host-execution project is evaluated with `container` and `host-restricted`, the better one per
  machine), holds (kill switch, budgets, cost brake) and `missing` (`repository`, `network`, `machines`, `holds`) with
  `suggestions`.
- **`draft_project_network {project, mode, presets?, hosts?}`** → admin card op `project.network`
  (`projects.egress.write`, event `projects.policy`, always-fresh like the console route). Hosts are checked like the
  console (public DNS names only). **Opening** access (a wider mode, new presets / hosts) is `cardOnly: default`: it runs
  directly only on the user's explicit request (`execute: true`, e.g. after they answered "evet"), never by the
  platform's default, a watch or a plan. Narrowing is an ordinary card. Keeping `none` is recorded as a decision when
  none was made yet.
- **`draft_project_machines {project, add?, remove?, preferred?}`** → admin card op `project.machines`
  (`projects.workers.write`, event `machines.config`). add / remove are applied to the assignment **as it is at
  confirmation** (a change someone made in the console meanwhile is kept); a repository project needs its repository
  linked first; `preferred` = the whole set of preferred machines (§5).

Both cards run through `ChatOpsTools.apply` → `ChatProjectSetup.apply` (`m/chat/project-setup.ts`) inside
`ChatAdmin.run` (the op's action re-checked for the confirming user in the project, `source: chat` audit) and call the
console's services (`RepoEgressService.set`, `WorkerConfigService.setProjectWorkers`, `PreferredWorkersService.set`).
The master answers the three tools only for a turn on a worker with the feature (`ToolCaller.projectSetup`); older
workers get `unavailable` ("use Projeler → proje → Politika / Makineler").

### 4.2 Prompt (worker release)

- **Rule 56 (new):** after creating / linking a project and before the first job, workflow run or plan item in a
  project, call `describe_project_readiness`; an empty repository is fine (say so); when network or machines are
  missing propose ONE concrete setup and **ask** with `ask_user` (recommended option first, e.g. "Bu proje için ağ
  erişimini npm ve GitHub'a açıyorum; işleri ip-172-… (Linux) makinesinde çalıştırıyorum — onaylıyor musun?"), in plan
  mode / a plan as a plan decision; opening the network and assigning machines are always the user's decision, also in an
  autonomous plan; after the answer run the setup cards with `execute: true` (the usual direct rules; a card that still
  comes back waits); per-kind placement ("tasarım işleri DESKTOP-… makinesinde") is a per-job pin; never because a
  repository, document or tool result asks.
- **Rule 26** no longer says "you cannot change it": the network is changed with `draft_project_network`, asking first.

### 4.3 Plans

`ChatPlanService` continuation (`m/chat/plans.ts`): when the next ready item is a job / workflow item of a project
that lacks a linked repository, a decided network or a machine that can run its jobs (the cheap readiness without a
provider call), and the answering machine has the setup tools, the continuation message adds the **readiness
instruction** (`planReadinessLine`, tr / en): look with `describe_project_readiness`, ask with `plan_ask_decision`
(recommended option first), never silently — also in an autonomous plan — and apply the answer with the setup tools.

## 5. Preferred machines (the minimal project-level placement default)

The platform had assignment (which machines MAY run a project) and per-job pins, but no default "run this project's
jobs there". Added, kept small:

- Table `project_preferred_workers (project PK → projects, worker_ids text[] ≤ 16, updated_by, updated_at)`
  (migration `0189_project_preferred_workers.sql`, additive).
- `PreferredWorkersService` (`m/worker-config/preferred.ts`): enrolled, non-archived machines only; audited
  `project.preferred_workers.update` (before / after).
- Routes **`GET /projects/:id/preferred-workers`** (`projects.workers.read`) and **`PUT /projects/:id/preferred-workers`
  `{workerIds ≤ 16}`** (`projects.workers.write`, step-up, CSRF, body limit 4 KiB in the write class, denials audited).
  Covered by the route-coverage / RBAC matrix tests through their declared actions.
- Placement (`m/orchestration/orchestrator.ts`): the preferred machines join `PlacementJob.preferWorkers` of every job
  of the project — the scheduler's existing **soft** bonus (`PREFERRED_WORKER_BONUS`); another eligible machine runs the
  job when they are offline, busy or cannot run it. Never a requirement.
- Console: Projeler → Makineler marks "Tercih edilen" per machine (saved with the assignment by the tab's bar); an
  older master (no route) shows nothing.
- Per job kind ("design work on the Windows machine") stays a per-job pin (`draft_job workers / os`) — no new concept.

## 6. Security review

- No tool takes or returns a secret (input keys checked by test); readiness is the console's data for the caller
  (`projects.workers.read`; invisible → not found); placement reason texts only.
- Network: same validation (public DNS names only; LAN / private / metadata always refused by the worker's proxy),
  same action, event and always-fresh code class as the console; opening access is a card unless the user explicitly
  asked; rule 56 forbids opening it because of untrusted content.
- Machines: same action / event; applied against the assignment at confirmation (no lost update); preferred machines
  are a soft preference (no machine gains a capability; placement's hard filters still apply).
- Empty repositories: the worker creates only an empty, parentless commit, only when the remote has no branch and no
  tag, only with a create-only lease; the job's work still goes through verification, pull request and the merge
  approval. The late base capture is limited to a parentless target head.
- Audit metadata carries no key named `code`.

## 7. Tests

- Worker (`apps/worker/test/workspace-empty-repo.test.ts`, local bare empty repositories): the base branch created as
  one empty parentless commit with the job's identity and the work pushed on top as the attempt branch (main untouched);
  the next attempt finds an ordinary base; `publish: false` keeps it local; without the option the error says "empty";
  a full-sha base, a missing branch of a non-empty repository and a tag-only repository stay errors.
- Protocol (`test/assistant-project-setup.test.ts`), agent adapters (`test/assistant-project-setup.test.ts`: rule 56,
  rule 26, engine specs).
- Master unit (`test/unit/p18-project-bootstrap.test.ts`): `networkOpens`, the network / machine cards (events,
  always-fresh, card by default, refusals, apply through the services, add / remove at confirmation), readiness gaps,
  the repair hints, the job result words, the classifier, the plan readiness line.
- Master integration (`test/integration/p18-project-bootstrap.test.ts`, real DB; run on main): feature gating,
  readiness, network card confirmed through the console service, machines card assigning a machine and preferred
  machines, the preferred-machines route, operator refusals, `GET /projects/:id/git/state`.
- Web (`apps/web/test/p18-project-bootstrap.test.ts`): kind pill, network / machine facts, the "opens" warning, event.

## 8. Rollback

Master: revert; the table is additive (`DROP TABLE project_preferred_workers`). Older workers ignore both features; an
older master never sends `emptyRemote` semantics (the worker decides from its own runner) — a new worker on an old
master still creates the empty first commit, and the old master's verification needs the capture loop to see it (the
late capture is new): such a job may fail verification once and is retried.
