# p8-outputs-folders — a folder tree and own folders on Outputs

- **Task:** `p8-outputs-folders`. **Date:** 2026-10-16. Builds on [p6-outputs](p6-outputs.md) (read model, ZIP) and
  [p8-chat-attachments-mentions](p8-chat-attachments-mentions.md) (`@` picker and resolver).
- **Owner request (2026-10-16), both parts approved:** (1) an automatic tree Project → Job → the file's own path inside
  `out/`, with the sites and notes of a project under it, folder-level ZIP, collapsible left tree, right pane with the
  existing cards / list, breadcrumb, a drill-down tree on phones; (2) own folders ("Klasörlerim") with sub-folders,
  drag-drop and a keyboard / menu "Add to folder…", links (an item can be in several folders), folder notes, tags, pin,
  rename, move, delete (items stay), `@` mentions of folders, and jobs / automations that put their outputs into a folder.
- **Migration:** 0070 (`output_folders`, `output_folder_links`, `job_output_folders`, `automations.output_folder_id`).
  Number taken at commit time; renumber at merge if a parallel change took it.
- **Worker release:** none. Master + web only (the mention picker is master + web, the resolver master; no assistant
  tool, prompt or protocol change).

## 1. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where do own folders live? | Two scopes. **Project folders** belong to one project and are shared with its members (read: viewer, write: operator). **Personal folders** belong to their creator only (any role, never shown to anyone else, admins included) and may collect items of every project the creator can read. | The owner asked for per-project folders shared by read role; personal folders let one person gather across projects without exposing anything (each item is filtered by the reader's current access at read time). |
| Move or link? | **Links.** Adding an item to a folder never moves it; one item can be in several folders; removing a link or deleting a folder never touches the item. | Items are job output — the folder is a view. |
| Depth | At most **6** levels (a root folder is level 1). | Readable on a phone; bounded recursion. |
| Delete a folder | Deletes the folder **and its sub-folders** with their links (the console asks first and says how many). Items stay. | Orphans would be invisible. |
| Move a folder | Within the same scope (and project). Not into itself or a descendant; the moved subtree must fit the depth limit. | No cross-scope leaks. |
| Sibling names | Unique per parent, case-insensitive (409 `folder_name_taken`). | Breadcrumbs and ZIP paths stay unambiguous. |
| Automatic tree | Computed from the read model on every request (no stored tree). | Nothing to keep in sync. |

## 2. Automatic tree — `GET /outputs/tree?project=&path=`

Lazy: one level per request (≤ 100 nodes, `offset` for the job list). A node is
`{project, path, kind, label, count, hasChildren, folderId?, jobId?, pinned?}`.

| `project` | `path` | Children |
| --- | --- | --- |
| — | `` | the caller's visible projects (`outputs.read`) and **My folders** (`personal`) |
| — | `personal` | the caller's root personal folders |
| — | `folder:<uuid>` | sub-folders of an own personal folder |
| P | `` | **Folders** (project folders), **Sites**, **Notes**, then the jobs of P with output files (newest first) |
| P | `folders` / `folder:<uuid>` | project folders (root / sub-folders) |
| P | `job:<uuid>` | the top-level directories of the job's `out/` files (`site`, `data`, …) |
| P | `job:<uuid>/<dir>[/<dir>…]` | sub-directories |

`sites` and `notes` have no children. A file's own path is its stored artifact name (`ArtifactName`: ≤ 4 relative
segments below `out/`), so `site/index.html` sits under `job:<id>/site`. Run artifacts and `summary.md` are at the job
root. The right pane lists the node's items with the existing `GET /outputs`, which gains two filters:

- `folder=<uuid>` — the items linked to that folder (the folder must be readable by the caller: 404 otherwise);
- `path=<dir>` (with `job`) — the files whose name starts with `<dir>/` (recursive; wildcards escaped).

## 3. Own folders — API

`output_folders` (scope `project` with `project`, or `personal` with `owner_id`; `parent_id`, `depth` 1–6, `name`
≤ 120, `note` ≤ 20 000 Markdown-as-text, `tags` ≤ 20 (the p6 tag rule), `pinned`), `output_folder_links`
(`folder_id`, `project`, `item_key` — site / file / run / note keys, `source` `user` | `job`, `added_by`, `added_at`;
primary key `(folder_id, project, item_key)`), `job_output_folders` (`job_id` → `folder_id`, requester, outcome).

| Route | Gate (route authz) | Service check | Audit |
| --- | --- | --- | --- |
| `GET /outputs/folders?project=` | `outputs.read` (project) | project folders of P (if given) + own personal folders | — |
| `GET /outputs/folders/:id` | `outputs.folders` on the folder's project; personal: own only (else 404) | — | — |
| `POST /outputs/folders` `{scope, project?, parentId?, name, note?, tags?, pinned?}` | `outputs.folders` (viewer) | project: `outputs.write` in the project; personal: creator; parent in the same scope / project / owner; depth; limits | `outputs.folder.create` |
| `PATCH /outputs/folders/:id` `{name?, note?, tags?, pinned?, parentId?}` | `outputs.folders` | write as above; move: same scope, no cycle, depth of the moved subtree | `outputs.folder.update` / `.move` |
| `DELETE /outputs/folders/:id` | `outputs.folders` | write as above; returns `{folders, links}` removed | `outputs.folder.delete` |
| `POST /outputs/folders/:id/items` `{project, keys[≤100]}` | `outputs.folders` | write as above; each key must resolve in the read model in `project`; project folders only take items of their project; personal folders items the caller can read (`outputs.read`); link limit | `outputs.folder.link` |
| `POST /outputs/folders/:id/items/remove` `{project, keys[≤100]}` | `outputs.folders` | write as above | `outputs.folder.unlink` |
| `GET /outputs/item-folders?project&key` | `outputs.read` (project) | the readable folders an item is in | — |
| `GET /outputs/tree` | `outputs.read` | §2 | — |
| `POST /outputs/zip` `{folder}` / `{project, tree}` | `outputs.read` | §4 | `outputs.zip` |

New action **`outputs.folders`** (project scope, viewer): the route gate for folder writes. For a project folder the
service additionally requires `outputs.write` (operator) in the folder's project (403 `forbidden`, audited `denied`);
for a personal folder the caller must be its owner — anyone else, admins included, gets a 404 (same as missing).

**Limits:** 500 folders per project, 500 personal folders per user, 1 000 links per folder, 100 keys per request,
depth 6; per-user `outputs-write` bucket (60/min) for every folder write, `outputs-zip` (10/min) for ZIPs.

## 4. Folder ZIP

`POST /outputs/zip` takes one of: `{project, keys}` (p6, unchanged), `{folder: uuid}` (an own folder **and its
sub-folders**), `{project, tree: path}` (a tree node: `` = the whole project, `job:<id>`, `job:<id>/<dir>`; `sites`,
`notes`, `folders` hold no stored files). The same rules as p6: only stored workspace files of projects the caller can
read; ≤ 100 files and ≤ 50 MiB checked **before** the first byte (413 `zip_too_many` / `zip_too_large`); nothing
stored → 409 `zip_empty`; streamed stored entries; `MANIFEST.txt` lists every file (job, size, SHA-256) and the items
not included. Archive paths keep the structure: a tree ZIP of a job is `site/index.html`, of a directory the path below
it, of a project `<job id prefix>/<path>`; a folder ZIP `<sub-folder>/…/<name>`. Every path goes through `zipPath`
(no absolute paths, `..`, backslashes, control or Windows-reserved characters) and `uniquePaths`.

## 5. `@` mentions of folders

The picker (`GET /chat/mentions`) gains type **`folder`**: project folders of projects where the caller has
`outputs.read`, plus the caller's own personal folders (name match). A mixed search now returns up to 30 entries
(five per type, six types); a typed one 20. At send time the resolver reloads the sender's
subject and resolves `folder` like every other type: unreadable / foreign personal / missing → dropped with the same
`not_visible` reason. The fenced block holds name, scope, project, path (ancestor names), note (≤ 2 000 characters),
tags, the sub-folder names (≤ 20) and an item summary (≤ 30 items readable **by the sender now**: key, type, name,
project, and for stored files the `inputArtifacts` hint), plus the total count. Chips link to `/outputs?folder=<id>`.

## 6. Jobs and automations that file their outputs

- `POST /jobs` takes an optional `outputFolderId`. At creation the creator must be able to write the folder
  (project folder of the job's project + `outputs.write`, or an own personal folder) — otherwise the job is not created
  (403 / 404 / 409 `folder_project_mismatch`). A `job_output_folders` row is written in the job's create transaction.
- An automation job target takes `outputFolderId` (`null` on update: off), checked the same way for the saving user;
  each run records it for the run-as user.
- The `output-folders` tick step (every orchestrator tick, ≤ 20 jobs) picks ended jobs with a pending row, **re-checks
  the requester's permission with a freshly loaded subject** (disabled user / lost role / folder gone → `refused`,
  audited `denied`, nothing linked) and links every item of the job (`GET /outputs?job=` semantics: files, run
  artifacts, the site deployed from it) with `source = 'job'`, idempotently. While a deploy-on-success of a succeeded
  job is still open, the row stays pending (files linked now, the site when it is live; at most 2 h after the job ended).
  Audited `outputs.folder.autolink` with counts.

## 7. Console

- `/outputs` gets a **left tree** (collapsible; `role="tree"` with `treeitem`s, ←/→/↑/↓/Home/End/Enter keys,
  `aria-expanded`, lazy children, "Show more" for long job lists) above the existing tabs; selecting a node scopes the
  right pane (cards / list, filters, selection ZIP) and shows a **breadcrumb**; a node with stored files offers
  **Download folder as ZIP**. Without a node the page is exactly the p6 screen.
- **My folders / project Folders**: create, rename, note, tags, pin, move ("Move to…" dialog), delete (confirm with
  counts). Items: drag a card onto a folder in the tree (HTML5 drag-and-drop, the drop target highlights) **or** the
  card's / drawer's **Add to folder…** dialog (searchable list, keyboard only, works on phones); "Remove from folder"
  in a folder's view; the drawer lists "In folders".
- **Phone width:** one column. The tree becomes a drill-down list (one level per screen, a back button, the breadcrumb on
  top); choosing a level shows its items below. No horizontal scroll.
- The item drawer lists **In folders** (readable ones) with **Add to folder…**. Chat chips of `folder` mentions open
  `/outputs?folder=<id>` (header, breadcrumb from the folder's ancestors).
- The composer / automation form / job page keep their current fields (API-only option for now, see §10).

## 7a. Tests

| Suite | Covers |
| --- | --- |
| `apps/master/test/unit/outputs-folders.test.ts` | tree path grammar (traversal, malformed), folder name / body rules, link keys, ZIP plan bounds and unique paths |
| `apps/master/test/integration/outputs-folders.test.ts` | tree per role and project, `?path`, tree / folder ZIP structure and 409 / 404, project folder authz (viewer 403 audited, outsider 404), links (several folders, invented / foreign keys), depth 6, cycle, move depth overflow, delete counts, folder and link caps, personal privacy (other operator and owner account 404 everywhere, tree, picker), revoked membership hides items, `@` picker and resolution as the sender, job and automation auto-link with re-check at link time |
| `apps/master/test/integration/rbac-matrix.test.ts` | `outputs.folders` and the new routes × every role |
| `apps/web/test/outputs-folders.test.tsx` | keyboard tree (→ ← ↓ Enter, `aria-*`), lazy levels, breadcrumb, `?path` listing, tree ZIP body, drag-and-drop link, keyboard "Add to folder…" (read-only folders hidden, search), folder deep link (header, Markdown note, names as text, remove), phone drill-down with Back, mention link |

## 8. Security review

| Threat | Control | Test |
| --- | --- | --- |
| Reading another project's folder or items | Project folders resolve to their project in route authz (non-member → 404); `?folder=` lists only items of projects the reader can read now | integration: outsider 404 on folder, items, tree, zip |
| Seeing someone's personal folder | Owner check on every route; others (admins too) get 404 = missing; the picker and the tree list own personal folders only | integration: other operator and the owner account 404; mention dropped |
| Leaking items through a personal folder after access was revoked | Links are filtered by the reader's visible projects at read, ZIP and mention time | integration: revoked membership hides the item, the folder stays |
| Viewer writes to project folders | `outputs.write` checked in the service (route gate is viewer for personal folders) | integration: viewer 403 audited `denied` on create / link / delete |
| Planting links for foreign / invented items | Each key resolves through the read model in the request's project; project folders take only their own project's items | integration: other project's key refused |
| Cycles / unbounded recursion | Move refuses descendants and checks the subtree depth under a per-scope advisory lock; depth ≤ 6 in a CHECK; recursive queries bounded by depth | unit + integration |
| Flooding | Folder / link caps per project, user and folder; 100 keys per request; per-user write and zip buckets | integration: limits |
| ZIP bombs / zip-slip | p6 rules reused: ≤ 100 files, ≤ 50 MiB before streaming, stored entries, `zipPath` + `uniquePaths` | unit (paths), integration (413, structure) |
| Job output linked into a folder the requester may no longer write | Re-checked at link time with a freshly loaded subject; refused rows are audited and never retried | integration |
| Prompt injection through folder names / notes / item names in `@` mentions | Fenced `REMYRAL-DATA` blocks, redacted, bounded (12 KiB per block); data, never instructions | integration: resolution |
| Stored XSS through names, notes, tags | Rendered as React text; the note is Markdown-as-text (`MarkdownView`, no HTML) | web: `<img onerror>` folder name renders as text |
| Audit | Every folder write, link / unlink, auto-link and ZIP audited with ids and counts (no note text) | integration: audit rows |

## 9. Rollback

Forward-only migration; old code ignores the three tables and the nullable column. Rolling the code back drops the tree,
the folders UI, `outputFolderId` and the `folder` mention type (stored chips of type `folder` render as plain text in an
older console). No worker or protocol change.

## 10. Not in this change

- A folder picker in the job composer, the automation form and the chat `draft_job` card: the API takes
  `outputFolderId` today; the console fields follow (the chat tool would need a worker release).
- Sharing a personal folder with someone else.
