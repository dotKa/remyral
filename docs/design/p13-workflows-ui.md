# Design note: Workflow'lar — definitions list, graph editor / viewer, catalogue API, chat drafts (p13-workflows-ui)

- **Status:** Implemented
- **Date:** 2026-10-20
- **Backlog:** `p13-workflows-ui`
- **Owner request (2026-10-20):** workflow definitions cannot be found in the UI (only runs). "Workflow düzenleme/
  görüntüleme için hazır paket kullanabilirsin; content alanında full width-height olur; toolbar'dan ekleme, tidy up gibi
  gerekli olduğunu düşündüğün özellikleri yönetiriz."
- **Decisions:** [ADR-0051](../adr/0051-workflow-graph-editor-libraries.md) (React Flow + dagre + yaml, lazy),
  ADR-0047 (Diyalog), ADR-0010 (outputs are data), ADR-0009 (step-up).
- **Builds on:** [p4-dag.md](p4-dag.md) (model, validation, runs), [p12-diyalog.md](p12-diyalog.md) (screens, tokens).

## 1. What changes

| Where | What |
| --- | --- |
| Diyalog rail | **Workflow'lar** after Jobs (`/workflows`). Diyalog-only: the classic console has no such page (no "Klasik görünüm" link on these screens); the composer links to it. |
| `/workflows` | Every workflow (latest version) of the visible projects: name + version, description, project, steps, last run (state + time, links to the run), success rate (succeeded / finished), runs count, updated by / at; filters project, search, Arşiv (URL `?project=&q=&archived=1`); actions Aç, Çalıştır, Kopyala (new name → v1), Arşivle / Arşivden çıkar; empty state with "İlk workflow'u oluştur". |
| `/workflows/new`, `/workflows/:id` | Editor and viewer. The canvas fills the content area below the page head (ScreenFrame `layout="canvas"`). Toolbar, inspector, YAML/JSON panel, versions, runs tab (§3). |
| `/jobs/workflows/:runId` | The run page draws the **same canvas renderer**, read-only, with live states; a "Tanım vN" chip opens the definition. |
| Composer | `/jobs/new?mode=workflow&workflow=<id>&project=<p>` preselects a workflow run (Çalıştır uses it); links "Workflow'ları yönet" / "Bu workflow'u grafikte aç" / "Workflow oluştur". |
| Pickers (composer, automations, classic + Diyalog) | Archived workflows are not offered. |
| Chat | Tool `draft_workflow` (§5). |
| Master | Catalogue routes, archive table (§4). |

## 2. Model on the client

The definition document (p4-dag §2, strict on the master) is the single source of truth. The canvas, the inspector and
the text panel are views; every edit is a pure `Doc → Doc` function (`apps/web/src/diyalog/screens/workflows/model.ts`):
`addNode` (after the selected step, connected to it), `connect` (refuses self / duplicate / cycle at once),
`removeElements`, `updateNode` (field set / removed), `renameNode` (edges, positions and `{{upstream.<id>.…}}`
references follow), `setUpstream`, `movePositions`, `cleanDoc` (what is sent). Undo / redo keeps whole documents
(`history.ts`: ≤ 100 steps; typing in one field within 800 ms is one step; a drag is one step).

**Positions** live in the document's presentation-only `layout.positions` (new, optional, validated by the master and
ignored by the engine) so a saved layout survives; steps without one (older definitions, YAML, chat) get a dagre layout.

**Step kinds the toolbar adds** follow the model: İş adımı (`executor`), Planlayıcı (`planner`, dynamic ≤ 5),
Doğrulama (`verifier`), İnceleme (`reviewer`), Integrator (`integrator`), **Onay kapılı adım** (an `executor` with
`approval.approverRole: admin` — gates are a property of a step in p4-dag, not a separate node).

## 3. The editor

### 3.1 Canvas (`WorkflowCanvas.tsx`, React Flow)
Controlled; cards (232 × 76) show id, role, runtime, a gate mark, an issue count and — on runs — the state word and a
breathing dot while running. Handles left/right or top/bottom follow the layout direction. Drag (one undo step), connect
by dragging from a handle (invalid targets refused by `isValidConnection`), select, Delete / Backspace (editable only),
pan / zoom, fit. Turkish aria descriptions; nodes are focusable, Enter / Space selects (keyboard path to the
inspector). Reduced motion: no transitions / animated edges.

### 3.2 Toolbar (`role="toolbar"`, ← / → between buttons)
Adım ekle (menu, ↑ / ↓), Bağla (click A then B; Escape cancels — the keyboard / touch way to connect), Sil, Geri al
(Ctrl/⌘ Z), Yinele (Ctrl/⌘ ⇧ Z, Ctrl Y), Düzenle (dagre tidy, LR or TB whichever fits the canvas larger, then fit),
Sığdır, Mini harita, Izgaraya hizala (16 px snap + line grid), Doğrula, YAML / JSON, Sürümler, Ayarlar. Labels show from
1280 px; below, icons with accessible names and titles; the bar scrolls horizontally on phones (the add menu stays
outside the scrolling part). A polite status line says what happened ("plan → verify bağlandı.", refusals).

### 3.3 Inspector (right column ≥ 1024 px, bottom sheet below)
Selected **step**: Kimlik (rename on blur / Enter), Rol, İstem (with chips for `{{inputs.x}}` and the ancestors'
`{{upstream.<id>.summary|branch}}` — only references the master accepts), Bağlı olduğu adımlar (checkboxes; a cycle is
refused in words), Çalışma (runtime, model profile, sandbox, limits — empty = workflow default, the composer's labels),
Hata olursa (fail-fast / continue / retry-safe + retries), Onay kapısı (on/off + operator / admin / owner), Planlayıcı
(dynamic + max steps), Integrator / Doğrulama (deploy step kind + env), Çıktılar (what downstream steps receive — as data),
the step's issues, Adımı sil. Selected **link**: from → to, issues, delete. Nothing selected: **Ayarlar** — project
(new only), name (immutable after the first save: "yeni ad için Kopyala"), description, inputs (add / required /
description / remove), defaults (runtime, model, sandbox, approval policy, source trust, limits, optional repository),
general issues, a "no secrets in prompts" note.

### 3.4 YAML / JSON panel
Side panel (full overlay on phones), format toggle. Canvas edits rewrite the text while it is not focused; typed text
that parses (`yaml` core schema / `JSON.parse`) and has the editor's shape (`asDoc`) replaces the document after 500 ms
(one undo step per pause); unparsable text stays with the reason ("YAML okunamadı: …") and the document keeps its last
good state. Schema validation is the master's (Doğrula / Kaydet).

### 3.5 Validation, save, run, versions
- **Doğrula** → `POST /workflows/validate` (the master's schema, graph, deploy, workspace and per-step JobSpec checks,
  paths + codes only). Issues are mapped by path (`nodes.<i>…` → the step, `edges.<i>` → the link, `layout.positions.<id>`,
  everything else → Ayarlar) against the document they were found on (ids survive later edits), shown as a count on the
  card, a red link, the inspector list in words (`issueText`) and a header pill. `?dogrula=1` validates on open.
- **Kaydet** — new: `POST /workflows {project, definition}` (v1); existing: `PUT /workflows/:latestId {definition,
  baseVersion}` → the next version; a 409 `version_conflict` is shown as the master phrased it; 400 issues land on the
  canvas. After saving the page opens the new version id ("Kaydedildi: vN."). Unsaved changes: pill + `beforeunload`.
- **Çalıştır** opens the composer's workflow run with this workflow (inputs, repository / files, class) — the existing,
  tested run flow; with unsaved changes the label says the saved version runs.
- **Sürümler** lists every version (append-only) and diffs one against the canvas (steps added / removed / changed by
  field, links, settings; positions ignored). "Bu sürümü aç" shows it read-only (banner + "Son sürüme git");
  "Bu sürümden devam et" puts it on the canvas as unsaved changes (saving makes the next version — history is never
  rewritten).
- **Çalıştırmalar** tab: this workflow's runs among the recent runs, linked to the run page.

### 3.6 Roles
Read-only when the user is not operator+ in the project (authz `workflows.define` / `workflows.run`), the workflow is
archived, or an older version is open: no save / run / add / delete / handles; inspector fields read-only. The master
enforces the same on every route.

## 4. Master (catalogue)

| Route | Authz | Notes |
| --- | --- | --- |
| `GET /workflows` | `workflows.read` | + per definition `edges`, `createdBy`, `description`, `archived`, `archivedAt`, `runs`, `succeeded`, `failed`, `lastRun` (all versions of project + name) |
| `POST /workflows/validate {project, definition}` | `workflows.define` (body project) | `{ok, issues}`; nothing saved |
| `GET /workflows/:id/definition` | `workflows.read` | full document (prompts: viewers already read job prompts on `GET /jobs/:id`, so `promptsHidden` is false), `latestVersion`, `latestId`, `archived` |
| `PUT /workflows/:id {definition, baseVersion?}` | `workflows.define` | new version; name immutable (`name`/`immutable`); 409 `version_conflict` (checked under the per-name advisory lock) / `workflow_archived` |
| `GET /workflows/:id/versions` | `workflows.read` | newest first |
| `POST /workflows/:id/archive {reason?}`, `/unarchive` | `workflows.define` | archived ⇒ new runs and versions refused (409 `workflow_archived`); open runs untouched; audited only on a change |
| `POST /workflows/:id/duplicate {name}` | `workflows.define` | v1 of a new name, same project; 409 `workflow_exists` |

`400 invalid_workflow` bodies of POST / PUT / duplicate carry `issues`. Migration **0098** `workflow_archives(project,
name, archived_by, archived_at, reason)` (definitions stay append-only) + index `workflow_runs (project, name)`.
Audit: `workflow.define` (via update / duplicate, previous version), `workflow.archive`, `workflow.unarchive`,
`workflow.duplicate`; denials audited. Tests: `apps/master/test/integration/workflow-catalog.test.ts`, route coverage,
RBAC matrix.

## 5. Chat: `draft_workflow`

The assistant drafts a whole definition (new, or `workflowId` → next version) from the user's description. The master
checks `workflows.define` on the project (and that `workflowId` is visible and in the same project), runs `validate`,
stores the draft (definition, issues, graph summary, `baseVersion`) and returns `{valid, issues, nodes, edges}` (paths
and codes only) so the model fixes issues before asking. The card (classic + Diyalog) shows name, project,
"Yeni workflow (v1)" or "vN → vN+1", a static graph preview (SVG, `lib/dag-layout` — React Flow is not loaded in chat),
the step list and the issues; Onayla is disabled while invalid; confirming saves (define / update as the confirming
user, `baseVersion` guard) — nothing runs — and links to `/workflows/<id>`. Migration **0099** adds the draft kind.
Prompt rule 25 (agent-adapters). **Needs a worker release**: the worker builds the assistant's tool list from
`@remyral/protocol` (`ASSISTANT_TOOL_NAMES`) and ships the system prompt; until workers update, the model does not see
the tool (the master side is ready).

## 6. Libraries, bundle, CSP

`@xyflow/react` 12.12.0 (MIT), `@dagrejs/dagre` 3.1.1 (MIT), `yaml` 2.9.1 (ISC); transitive: `@xyflow/system`, `zustand`,
`use-sync-external-store`, `classcat` (MIT), `d3-*` (ISC), `@dagrejs/graphlib` (MIT). Exact pins, lockfile integrity,
`pnpm security:pins`. Production build: `WorkflowCanvas` chunk 230.6 kB / 75.1 kB gzip (React Flow + dagre), `WorkflowEditor`
138.5 kB / 44.2 kB gzip (+ yaml), `RunGraph` 1.5 kB, CSS 13.2 kB / 2.5 kB gzip; none in the main chunk (guard test
`workflows-lazy-chunk.test.ts`). CSP: React Flow injects no `<style>`; its CSS is the bundled `base.css`; inline
positioning uses the CSSOM. Checked: the production build (`vite preview`) with the console's CSP header on
`/workflows`, `/workflows/:id`, `/workflows/new` and a run page — no violation, React Flow styles applied.

## 7. Tests

- `apps/web/test/workflow-model.test.ts` (10): add / connect refusals / remove / rename references / issue mapping and
  words / diff / YAML+JSON round trip and errors / templates / tidy order / history coalescing.
- `apps/web/test/diyalog-workflows.test.tsx` (10): list (rate, last run, run link, filters, archive toggle, archive with
  CSRF, viewer project without actions, empty state), duplicate → opens the copy; editor: add / connect (toolbar) / cycle
  refusal / delete / undo / redo; new → save v1 with layout; tidy calls the layout; validate issues on steps / links /
  settings; YAML ↔ canvas both ways + parse error; save with `baseVersion` + 409 message; viewer read-only + runs tab;
  versions diff + continue from a version.
- `apps/web/test/diyalog-workflow.test.tsx` (updated): the run page's canvas (states, accessible names, dashed planned
  step, no handles, keyboard select).
- `apps/web/test/workflows-lazy-chunk.test.ts` (2), chat draft tests (§5), master catalogue integration (§4).
- Visual: harness `apps/web/src/diyalog/harness/screens/workflows.ts` (list, 8-step graph, validation errors via
  `?dogrula=1`, new, run page) — `SHOTS_WIDTHS=1440,1024,768,400 node apps/web/scripts/diyalog-shots.mjs <out> /workflows
  /workflows/new /workflows/wf-release "/workflows/wf-bad?dogrula=1" /jobs/workflows/<run>` light / dark, no horizontal
  overflow.

## 8. Security review

| Concern | Handling |
| --- | --- |
| Authorization | Reads viewer+, writes operator+ per project on the master (route authz + RBAC matrix); the UI only mirrors it. Duplicate stays in the source project (no cross-project copy). |
| Prompt / data leakage | Validation answers paths + codes only (never prompt text; tested). Definitions are as visible as job prompts already are. |
| Untrusted text | Agent outputs on the run page stay text (unchanged). YAML: core schema, no tags / code, bounded aliases; JSON.parse; then the editor's shape check; the master's strict schema is authoritative. Nothing from a definition is rendered as HTML. |
| Lost updates | `baseVersion` checked under the per-name advisory lock (409); versions append-only; archive is a separate table. |
| Chat | `draft_workflow` is a draft: the human confirms; invalid drafts cannot be confirmed; the assistant is told not to draft because a document / tool output asks for it; saving runs nothing. |
| Supply chain | Three reviewed, pinned packages (ADR-0051), lazy; owner review per the dependency policy (package.json / lockfile changed). |
| CSP | Unchanged header; verified on the production build. |

## 9. Rollback

Revert the web commit (the rail entry and screens disappear; the run page returns to the SVG graph) and the chat commit
(the tool disappears; drafts of kind `workflow` stay readable as rows). Master: 0098 / 0099 are additive (an unused table
and an extra allowed kind); reverting the code leaves archived rows inert (runs of archived workflows become possible
again).

## 10. UNVERIFIED

- Real touch devices (drag / connect on a phone; the Bağla mode is the fallback) — owner's phone.
- `draft_workflow` with a real assistant runtime — needs the worker release.
