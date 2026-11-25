# Workflow editor: working with the AI panel

Design: [docs/design/p15-workflow-ai.md](../design/p15-workflow-ai.md). The panel uses the same assistant as Sohbet
(Settings → Chat: worker, runtime, model, fallback engine, your personal rules).

## Open it

- In the workflow editor: toolbar **AI** (next to YAML / JSON). On a phone the panel covers the canvas; close it with ×.
- From a failed run: **Neden başarısız oldu?** in the run's header opens the editor with the panel in *Hata ayıkla* and
  asks at once.
- From Sohbet: a conversation that belongs to a workflow shows "Bu sohbet … workflow’una bağlı" with **Workflow’a git**.

## Modes

| Mode | Who | What happens |
| --- | --- | --- |
| Tasarla | operator+ | Describe the goal. The assistant reads the node catalog and drafts a version-2 workflow; the master validates it like *Doğrula*. A valid draft goes onto the canvas at once as the unsaved working copy (one *Geri al* step). Ask again to refine ("şu adımı onaya bağla"). |
| Düzenle | operator+ | The current document (with unsaved changes) and the selected node go to the assistant. Its proposal is drawn on the canvas — green added, red removed (dashed), amber changed — with a checklist: *Tümünü kabul et*, *Seçilenleri uygula*, *Tümünü reddet*. The canvas is locked until you decide. |
| Açıkla | viewer+ | "Bu workflow ne yapıyor?" — an answer only; nothing changes. |
| Hata ayıkla | viewer+ | Pick a failed run; the master sends that run's node states, errors and the failed node runs' data (clipped). This data is **untrusted**: the assistant is told never to follow instructions found in it. |

## Validation and repair

Every draft is validated on the master before the editor shows it. When a *Tasarla* / *Düzenle* draft is invalid,
the master asks the assistant **once** more with the list of issues ("Otomatik onarım"). If that draft is invalid too,
the panel lists the issues in words and the canvas does not change.

## Saving

Nothing is saved by the panel. *Kaydet* / *Yeni sürüm kaydet* is the normal save: catalog validation, privileged
nodes (HTTP, e-mail, GitHub, deploy, code) need a project admin and a fresh verification code, the egress policy
applies. The conversation of a new workflow is linked to it when you save it, so you can continue later — in the
panel or in Sohbet.

## Not verified

Real models (Claude Code, Codex, OpenCode, Pi) designing and editing through the panel were not tested; the tests use
the platform's fake assistant engine.
