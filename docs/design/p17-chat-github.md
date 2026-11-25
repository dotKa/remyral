# Design note: `p17-chat-github` — chat titles from meaning, projects from the chat, several GitHub Apps

- **Task:** `p17-chat-github`. **Date:** 2026-10-27. **Migrations:** `0169_chat_title_source.sql` (Part 1),
  `0170_github_connections.sql` (Part 3), `0171_project_create_draft.sql` (Part 2).
- **ADR:** [ADR-0022 amendment 2026-10-27](../adr/0022-panel-connected-github-app.md) (Part 3).
- **Owner requests (2026-10-27):**
  1. "sohbet isimlerini direkt ilk attığım mesajın ilk kelimelerinden değil, ilk metindeki konuşmaya göre veya
     anlamsızsa 3-5 mesajdan sonra konuşmaya göre güncelle. güncellerkende bilgi ver"
  2. "chat e proje oluşturabilmeliyiz" (the assistant had answered it has no tool to create a project)
  3. Another organization cannot be connected — only the first GitHub App; a private App per org/account is preferred.

- **Deploy order:** the master first (migrations 0169–0171 are additive; the new tools are served only when a worker
  calls them), then the worker release (protocol tools `set_chat_title`, `list_git_repositories`, `list_dns_zones`,
  `draft_project_create`, system prompt rules 49–50). An older worker keeps the first-words titles and has no project
  tools. **Feature flags:** none — the installation allowlist starts with every existing installation accepted, so
  existing projects keep working; new installations wait for "Kabul et".

## 1. Part 1 — conversation titles from meaning

### Which model names the conversation

The control plane runs no model of its own (p10-semantic-memory: "no model runs on the control plane"; Bedrock is
used for embeddings only, workflow AI and memory summaries run as assistant turns or jobs on worker machines). The
model path the master already uses for small text work is the chat assistant itself: it already reads the message, so
naming the conversation costs no extra call, no new provider and no new key, and sends nothing anywhere that was not
sent already.

### Flow

| Step                             | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First message stored             | `autoTitle`: the first words (≤ 80 chars of the first line, the first file's name for a file-only message) are the **instant placeholder** — and the fallback when nothing better comes (older worker, no answer, error). `title_source` becomes `placeholder`, or `provisional` when the message says too little (`titleWorthy`: fewer than two words that are not greetings / courtesy / filler — "merhaba", "selam nasılsın", "test", one word, only a file).             |
| Turn context                     | While the title is `placeholder` (up to the 5th exchanged message), and while it is `provisional` on the 3rd–5th exchanged message (current user + assistant messages, the one being answered included), the master adds a small platform block `conversation title` (`request: name_from_first_message                                                                                                                                                                      | name_from_conversation`, the current title, ≤ 60 chars). Nothing else is added: the model already has the message and history (attachments and secrets stay as the existing redaction left them). |
| The model                        | Rule 49 of the system prompt: with that block, call `set_chat_title` once with a short title in the conversation's language; never without the block; do not mention it in the answer.                                                                                                                                                                                                                                                                                       |
| `set_chat_title` (kind `notify`) | Served by `ChatService#titleTool` for the turn's own conversation and the user who sent it. `normalizeChatTitle`: quotes / markdown / trailing period removed, one line, ≤ 60 characters at a word (the job-title clip), refused when the pattern redactor finds a secret in it. Stored only while `title_source` is `placeholder`, or `provisional` with ≥ 3 messages exchanged (one SQL `UPDATE … WHERE`, so two replicas or a retried call cannot rename twice) → `auto`. |
| Informing                        | The open console gets the existing `thread` event (the conversation list is invalidated too) and a notice row in the thread (`role: error`, `meta.notice: 'chat-title'`, `title`, `from`), rendered as "Sohbet adı güncellendi: “…”" / "Conversation renamed: “…”". `error` rows never reach the model's history, and the retry button ignores notice rows.                                                                                                                  |

### Bounds

- At most one automatic title from the first message, or (provisional) one retitle after 3–5 messages — then
  `auto`, never again. A provisional title the model does not fix by the 5th message stays the first words.
- `user`: a rename (`PATCH /chat/threads/:id` with a title) or a title given at creation (workflow AI threads,
  `POST /chat/threads {title}`) is never changed automatically. Existing conversations become `user` in the migration
  (only still-unnamed ones are `default`).
- Shared / read-only readers never start turns, so they never trigger a title; the notice is part of the thread they
  read.
- Rate: the request rides on turns that the chat rate limits already bound; the state machine allows at most two
  automatic changes per conversation. No audit record (a conversation title is the user's own data; renaming by hand
  was never audited either).

### Compatibility

- Protocol: new tool `set_chat_title` (worker release: the tool list and rule 49 live in the worker's bundle). An
  older worker ignores the block (no tool) — the first-words title stays, as before.
- Migration 0169 adds `chat_threads.title_source` (default `user` for existing rows, `default` for new ones).
  Rollback: an older master ignores the column.

## 2. Part 2 — creating a project from the chat

The assistant answered it had no tool to create a project. New tools (protocol; worker release with rule 50):

| Tool                    | Kind                          | What                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_git_repositories` | read                          | repositories of the **accepted** installations of every GitHub App connection (Part 3): fullName, default branch, private, connection (`keyRef`), installation — `integrations.github.read` (admins), as the panel picker                                      |
| `list_dns_zones`        | read                          | zones the DNS integration (Cloudflare) sees — `integrations.ops.read`                                                                                                                                                                                          |
| `draft_project_create`  | draft → card `project_create` | id, name, description; optional repository (a fullName from the list), baseBranch, dnsZone (a zone name from the list), kind repository / workspace, egress + allowHosts (workspace), searchCapture, memorySuggestions — the fields of the panel's create form |

### Planning (no card when refused)

`ChatProjectCreate.plan` (apps/master/src/chat/project-create-actions.ts): `projects.create` (owner / admin, as
`POST /projects`) else forbidden; id validated like `POST /projects` (`PROJECT_ID`), name 1–200, description ≤ 500; an
existing id, egress on a repository project, a repository on a workspace project are invalid; the repository must be
listed by an accepted installation (otherwise not found — a pending installation's repository included, with the hint
to accept it or `create_repository`); the zone must be one the integration sees (the message names the available
ones). The payload stores the resolved repository (clone URL, base branch, keyRef, installation, App id) and the zone
(id, name): the card shows exactly what will be created.

### Confirming

The card kind is confirm-only (`CONFIRM_ONLY_TOOLS`): unlike the other draft tools it never runs at once for the
user — not by default, not with `execute: true` (owner: "nothing without confirm"). Confirming re-checks the role
(`DRAFT_ACTION.project_create = 'projects.create'`) and the card's code rule (event `projects.policy`, the event of
`POST /projects`), then:

1. `Directory.createProject` — the panel path (security-policy autonomy defaults, workspace egress, knowledge defaults),
   audited `project.create` with `via: 'chat'`; `projects.description` stored (migration 0171; `POST /projects` and
   `GET /projects` gained the optional field too).
2. Repository: `ProjectGitConfigStore.put` (keyRef + installation + App id; refuses an installation no longer
   accepted; audited by the store), only with `projects.git.write`.
3. DNS zone: `OpsService.putTargets` with `dns.zones = [zone]` (checks the zone against Cloudflare again; audited
   `ops.targets.write`).

A failure of 2 or 3 after the project exists is returned on the card as a warning (`repository_not_linked: …`,
`dns_zone_not_set: …`), never hidden; the project stays.

### Console

Card "Yeni proje" (kind "Proje oluşturma"): id, name, kind, repository, allowed DNS zone; details: description, base
branch, connection, network access (workspace), project knowledge; the note that nothing is created before confirming.

## 3. Part 3 — several GitHub App connections

A private GitHub App can only be installed on the account that owns it; the master held exactly one panel App
(`github_app_connection.id = 1`), so a second organization could not be connected. ADR-0022 amendment 2026-10-27.

### Model

| Item          | Before                                                     | Now                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connections   | one panel App (keyRef `panel`) + key-file Apps (`default`) | up to 10 panel Apps (`panel`, `panel-<id>`), each with its own sealed key / client secret / webhook secret, a label, its installations; key-file Apps listed as read-only connections |
| Installations | every discovered installation used                         | allowlist: discovered = pending; accepted ones only (listing, project config, panel-App tokens). Pre-0170 installations accepted                                                      |
| Project       | `github.keyRef` + `installationId`                         | unchanged columns — the picker now writes the keyRef of the connection the repository came from                                                                                       |
| Webhook       | one secret                                                 | the secret of the App in `X-GitHub-Hook-Installation-Target-ID`; unknown App → 401; no header → any connection's secret                                                               |

`GitHubAppAuth` gained `allowInstallation`: panel Apps check `github_app_installations` (accepted, not suspended)
before every installation token, cached or not — so git operations (worker clone / push tokens, PR creation, checks,
merge) of every replica stop for an installation whose acceptance was taken back, and each project's tokens come from
the App its `keyRef` names.

### Routes (owner / admin: `integrations.github.*`)

| Route                                                                                               | Change                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /integrations/github`                                                                          | + `connections[]` (id, keyRef, label, source panel/env, readOnly, app, webhook, installations with `accepted`, projects), `maxConnections`; `app` / `installations` / `projects` stay the first connection's |
| `POST /integrations/github/manifest`                                                                | no longer refused while connected; + `label`; 409 `github_already_connected` for an organization that has a connection, `github_connection_limit` at 10                                                      |
| `POST /integrations/github/installations/sync`                                                      | every connection (+ `connectionId` for one)                                                                                                                                                                  |
| `PUT /integrations/github/installations/:installationId` `{accepted}`                               | new, always-fresh, audited `github.installation.accept` / `.revoke` (with the projects that use it)                                                                                                          |
| `PATCH /integrations/github/connections/:connectionId` `{label}`                                    | new, always-fresh, audited `github.connection.rename`                                                                                                                                                        |
| `POST /integrations/github/key`, `POST /integrations/github/webhook`, `DELETE /integrations/github` | + `connectionId` (body / query); the first connection when left out                                                                                                                                          |
| `GET /integrations/github/repositories`                                                             | across accepted installations of all connections; items name `keyRef`, `appId`                                                                                                                               |

### Panel

Ayarlar → Entegrasyonlar → GitHub: the first connection's panel as before, its installations with "Kabul bekliyor" /
"Kabul edildi" and "Kabul et" / "Kabulü geri al"; below, **Diğer GitHub App bağlantıları**: a short guide (why one
private App per account / organization, three steps, why not a public App), each further connection (name, App,
read-only badge for an environment App, installations with acceptance, projects, rename, remove) and **Bağlantı ekle**
(organization or account, optional name → the manifest flow). Projects → Depo: the picker lists repositories of every
connection and writes the right keyRef.

**Superseded by p17-github-apps-ui (owner 2026-10-27: "github appleri şeklinde listelensinler").** The first App
was privileged (its own fields, installations, projects, webhook, key and disconnect above a list of smaller, differently
built "other" cards), which mixed per-App and installation-wide things. The tab is now three parts:

1. **GitHub App'leri** — every connection (the first one, further panel Apps, Apps from the environment) is the same
   card (`GitHubAppCard`, `apps/web/src/diyalog/screens/settings/integrations-github-app.tsx`). Collapsed: name (label
   or owner login), owner kind, `keyRef · App id`, one state pill (Bağlı / Anahtar kullanılamıyor / Bekleyen kurulum
   var), the environment badge, installation and project counts. Open (the only App, or one that needs the owner —
   unusable or old key, missing permissions, a pending installation, no installation): App fields and warnings,
   installations with acceptance / repositories / configure, "Kurulumları yenile" and "Depolara kur", the projects with
   the base-branch protection badge, then the webhook, key rotation, rename and remove. Under the list **App ekle**
   and the guide; without any App the first-connect form (key-file and PUBLIC_ORIGIN notices).
2. **Tüm App'ler** — what applies to every App at once: re-read the installations of all Apps (environment Apps
   included; `POST /integrations/github/installations/sync` without `connectionId`).
3. **GitHub hesabı** — the personal account (p15-github-create-repo), its own card after the Apps.

Every card action sends its `connectionId` (sync: body, webhook: query, key: body, remove: query, rename: path) —
the master has accepted it on these routes since this change's Part 3, so no action is "first App only" any more. An
older master's status has no `connections[]`: its single App becomes the one card without an id, and its actions
address the first App, as before. What still goes through one App is marked on its card (**Varsayılan App**, shown
when there is more than one): repositories without a chosen connection (`defaultKeyRef`) and the "GitHub hesabı"
authorization. Removing an App refreshes the list at once; the notice with "orada silin" (the App stays on GitHub)
and the projects that lost it stays above the list until "Tamam".

### Not verified live

Creating a second App under a real second organization on github.com, real webhook deliveries carrying the target
headers, and an installation of a private App attempted from another organization (GitHub refuses it) — tested against
the local fake GitHub only (two Apps, own keys, own installations).
