# p22-workflow-draft-supersede: one open card per workflow

**Problem.** The assistant can propose a workflow version twice in one conversation (a correction, a second change on
top). Both cards stayed open with the same "v7 → v8" heading, and the assistant had to tell the user which one not to
confirm. Only "Sohbette düzenle" replaced the earlier card.

**Rule.** When a workflow card is created (`ChatStore.createDraft`, kind `workflow`, state `proposed`), every other
open card of the same caller, conversation, project and workflow name is closed as `dismissed` with
`{ reason: 'superseded', supersededBy: <new card> }`. The console already shows such a card as replaced by the newer
version (p17-chat-flow). Other workflows, other conversations and other card kinds are untouched; a hidden `invalid`
attempt never closes anything.

**Safety.** Confirming the older card afterwards is refused (it is no longer `proposed`). The newer card carries the
whole version, so nothing of the older one is lost when it is built on top of it; when it is not, the assistant
proposes the combined version.

**Tests.** `apps/master/test/integration/p22-workflow-draft-supersede.test.ts`.
