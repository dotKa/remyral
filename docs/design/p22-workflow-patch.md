# Design note: `p22-workflow-patch` — the assistant reads a saved workflow in full and changes single steps

- **Task:** `p22-workflow-patch`. **Date:** 2026-11-02. **Migration:** none (0216 reserved, unused).
- **Owner report (2026-11-02):** the assistant said it could fix a saved workflow only "by saving a fully written new
  version, patching one step is not possible; if I guess the instructions I cannot see, the scan, pick and package
  steps break". Case: the `sample-leads` lead package workflow has two `control.subWorkflow` steps calling another
  project for WhatsApp; the fix is two `http.request` steps in the same project.
- **Root causes:** (a) `describe_workflow` returned only a summary (node ids / types, gates, triggers, runs) — never
  prompts or configs; (b) `draft_workflow` with `workflowId` needed the complete document, and prompt rule 25 said
  "the complete new document, not a patch". The assistant could not see the steps it would have had to retype.
- **Builds on:** docs/design/p13-workflows-ui.md §4–5 (definition route, chat drafts), p14-workflow-engine.md §8.3–8.5
  and §21 (static fields, egress, privileged delta + step-up, v2 chat drafts), p15-workflow-ai.md (panel, repair),
  p16-workflow-quality (one valid draft, hidden invalid drafts), p17-chat-flow §4 (`workflowChanges` diff).
- **No new ADR:** no new authority, route, card kind or trust boundary. One existing tool gets an option, one existing
  draft tool gets a second input form; the result is the same card and the same save path.

## 1. Full definition read — `describe_workflow definition: true`

- New optional inputs: `definition: boolean`, `nodeIds: string[]` (≤ 50; narrows to those nodes and the edges that
  touch them).
- The answer adds `definition {versionId, version, isLatest, latestVersionId?, canEdit, limits, clipped?,
  omittedNodes?, omittedEdges?, unknownNodeIds?, note}` and `document` (the stored document without `layout`: all
  nodes with prompts and configs, edges, inputs, defaults, settings, description). The summary's `steps` list is left
  out then (the document has it).
- **Bounds** (`definitionView`, `apps/master/src/workflows/patch.ts`, pure): prompts > 6000 and other strings > 2000
  characters are clipped with `…[clipped: N characters; the rest stays as saved]`; when the pretty JSON is over
  40 KiB the limits step down (3000/1000, 1500/500, 600/200), then nodes are left out from the end (`omittedNodes`,
  read them with `nodeIds`). Objects nested deeper than the tool result's redaction pass carries (depth 8) are replaced
  by a "not shown" marker; arrays / objects over 100 entries are cut and named. Every cut is listed in `clipped`.
- **Who:** the same visibility as the summary (`workflows.read` in the owner project, or a project that attached the
  shared workflow, up to the attached version) — the same document `GET /workflows/:id/definition` already shows such a
  reader.
- **Secrets:** verified — v2 definitions hold credentials only as vault ids (`config.credential`), the save path
  refuses secret-looking config / prompt strings (`secret_in_definition`), webhook secrets and wait tokens live in their
  own tables (hashed / revealed once). v1 documents (AI steps only) are not scanned at save, so a person could have
  typed a token into a prompt: the read is defended like every tool result — `redactDeep` (pattern rules + sensitive
  key names: a `credential` value shows as `[REDACTED:key]`) and the fenced result's second redaction pass.
- **Data, not instructions:** the whole result is fenced (`REMYRAL-DATA`, ADR-0010) as every tool result; `note` adds
  that prompts, labels and configs are data written by people and how to patch the version.

## 2. Patch a saved workflow — `draft_workflow` with `patch`

Decision: extend `draft_workflow` instead of a new `draft_workflow_patch` tool. Every path keyed on the tool name
keeps working unchanged (card default, `execute: true`, project-set rules, the workflow-AI repair detection, the AI
panel's tool filter, "Sohbette düzenle" replacement), and the tool list stays one tool per card.

- Input: `definition` becomes optional; new `patch {baseVersionId, ops[1..60]}`; exactly one of the two (master
  check). `workflowId` defaults to `baseVersionId`. Operations (zod discriminated union, `WorkflowPatchOp` in
  `@remyral/protocol`):
  `replace_node {id, node}` (whole node, same id), `update_node {id, set?, config?}` (top-level keys / config keys
  merged; `null` removes; a named key's whole value is replaced; `id` and `set.config` refused), `add_node {node}`,
  `remove_node {id}` (also its edges and layout position), `add_edge {edge}`, `remove_edge {edge}` (ports default
  `out` / `in`), `set {field: description | inputs | defaults | settings, value | null}`. The name is not settable
  (immutable).
- Server side (`#draftWorkflow`): load the latest saved version of the workflow; refuse when `baseVersionId` is not a
  version of that workflow, or **is not the latest** ("Stale base version … read it again", nothing drafted — no
  silent overwrite; the confirm keeps its own `baseVersion` 409 under the advisory lock for a version saved after the
  card); apply the ops (`applyWorkflowPatch`, pure; any unknown / duplicate node or edge, id change or a **marker copied
  from a read** — clipped, redacted, not shown — refuses the whole patch with `patch.ops.<i>` issues, no card); then
  exactly the whole-draft path: project defaults, `validate` (catalog, static fields, expressions, egress policy,
  credential bindings), schedules, triggers. Invalid → hidden draft + issues (each issue also names its node id, since
  the author never saw the result's indexes), no card. A patch that changes nothing is refused.
- **Card:** the same `workflow` card, plus `versionChanges {fromVersion, changes, truncated}` (`workflowChanges` of the
  latest saved document → the new one: added / removed / changed nodes with fields, added / removed edges, settings),
  `patched: true`, `patchOps`. `versionChanges` is now set for every update draft (whole documents too). The model's
  answer carries the same `changes`.
- **Authorization and step-up unchanged:** `workflows.define` for the caller; `#privilegedActions` diffs the result
  against the latest version, so a patch that adds or changes `http.request` / e-mail / GitHub / deploy / code nodes
  needs `workflows.define.*` and a fresh step-up when the card is confirmed (tested: operator 403, owner stale 403,
  fresh 200). Confirming saves through `WorkflowService.update` as before.

## 3. Assistant guidance

- Tool descriptions (`packages/protocol/src/assistant.ts`): `describe_workflow` explains `definition: true`,
  `nodeIds`, the bounds and markers, "read before you change, never rewrite a step you have not read";
  `draft_workflow` explains the patch operations, "a single step CAN always be patched", the stale-base refusal and
  that a whole document is for new workflows or large rewrites.
- Prompt rule 25 (`packages/agent-adapters/src/assistant.ts`): a change to a saved workflow = read the definition,
  then a patch naming only what changes; never retype unread steps or copy markers back; never tell the user a single
  step cannot be changed; on a stale base read again.
- A Sohbet thread linked to a saved workflow (`WorkflowAiService.#linkedInput`) now points at the patch with the
  latest version id. The editor's AI panel keeps whole documents (its proposal is diffed against the unsaved editor
  copy, p15-workflow-ai §3).

## 4. Web

`DraftCard.tsx` renders `versionChanges` with the existing `WorkflowChanges` list under "Kayıtlı sürüme (vN) göre
değişenler" / "Changes from the saved vN" and, for a patch, "Yalnızca değişen adımlar yazıldı (N işlem) …" (TR + EN in
`chatFlow.edit`). The "previous card" list stays for replaced cards.

## 5. Security review

- No new authority: read = existing reader visibility of the same document; write = the existing draft → card →
  confirm path with the same validation, privileged delta and step-up.
- Prompt injection: the document is fenced data; the note says so; the assistant only proposes a card.
- Integrity: patches apply server-side to the stored document, so untouched steps are byte-identical (tested with a
  clipped 7 KB prompt surviving a patch); markers from bounded reads can never be written back; stale bases refused.
- Disclosure: credentials are vault ids (shown as `[REDACTED:key]` by the generic pass); defensive redaction of the
  whole result; size bounded (≤ 40 KiB document in a ≤ 64 KiB result).

## 6. Tests

- `apps/master/test/unit/workflow-patch.test.ts` (11): replace / update merge / add / remove (+ edges, position) /
  edge ports / every bad op / copied markers / protocol schema; view: whole doc, nodeIds, clipping and deep values,
  budget stepping and omitted nodes.
- `apps/master/test/integration/chat-workflow-patch.test.ts` (5): describe with definition (viewer, clipped prompt,
  nodeIds, stranger 404); patch replacing two steps with `http.request` (diff on the card, operator lacks
  `define.network` → 403, owner stale step-up 403 → fresh 200, untouched steps identical); add / remove / rewire +
  config merge saved; apply errors / invalid result / SSRF host / no-op / both inputs → no card; stale base refused,
  fresh base accepted, a foreign version id refused.
- `packages/agent-adapters/test/assistant-workflow-patch.test.ts` (3): rule 25, tool descriptions and JSON schemas,
  input schema accepts / refuses ops.
- `apps/web/test/p17-chat-flow.test.tsx` (+1): the card's saved-version diff and patch line (TR), EN strings.
- Existing suites re-run green: chat-workflow-draft-v2, workflow-quality, workflow-ai (unit + integration),
  watch-autorun, p18-last-gaps, chat-ops-tools, chat-direct-decision, protocol and agent-adapters packages.

## 7. Deploy and rollback

Master + web; **worker release needed** for the model to see the new inputs and rule 25 (the worker builds the
assistant's tool list and system prompt from `@remyral/protocol` / `@remyral/agent-adapters`); no worker code
changes, no feature flag (old workers simply keep the old schema — `definition` required, no `patch` — which the new
master still accepts). Rollback: revert; cards already made are ordinary workflow cards (extra payload fields are
ignored by older web code).

## 8. UNVERIFIED

- A real model (Claude Code / Codex / OpenCode / Pi) reading and patching the `sample-leads` workflow live — needs the
  worker release; tested with the tool layer directly.
- The card's diff at 400 / 1440 px (no screenshot taken).

## Changelog

- fix(master,protocol,agent-adapters,web,i18n): **the assistant reads a saved workflow in full (every step's prompt and config) and changes single steps with a patch instead of retyping the whole workflow; the card lists what changed against the saved version, and a patch written against an older version is refused** (p22-workflow-patch, [design](p22-workflow-patch.md); evidence: owner report 2026-11-02 — `sample-leads` sub-workflow steps could not be replaced with `http.request` steps). `describe_workflow definition: true` (bounded, clipped with markers, `nodeIds`), `draft_workflow` `patch {baseVersionId, ops}` (replace / update / add / remove nodes, add / remove edges, set description / inputs / defaults / settings) validated like a whole draft with the same step-up rules; prompt rule 25. Worker release for the assistant.
