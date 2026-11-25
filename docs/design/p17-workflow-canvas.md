# p17-workflow-canvas — workflow editor canvas: card zones, family colours, edge colours, arrange modes

Owner report (2026-10-25, with a screenshot of an "AI iş adımı" card whose `in` / `context` port labels sat over
its title and subtitle): no overlaps on the workflow cards; a distinguishing colour per node kind (band, tint); a
different colour for every link; the arrange button should offer several modes — click runs the last one, a
chevron picks another, each mode has an icon and the button shows the last mode's icon.

Scope: `apps/web/src/diyalog/screens/workflows` (editor, canvas, run graph). No master, worker, protocol or schema
change; no new dependency. The saved document is unchanged (positions only, as before).

## 1. Card layout in zones (`nodeLayout.ts`, pure)

`cardLayout(input, size?)` returns the card's size and a box for everything drawn on it; the card renders each box
absolutely and clipped (`overflow: hidden`, ellipsis), so no text can draw over a neighbour even when the width
estimate is off.

- **Header:** family band (4 px), icon chip (24 px), title (JetBrains Mono 13 px), subtitle (12 px, the v1 role icon
  in front), badges (approval shield, issue count) right of the title.
- **Port rows (left → right):** inputs on the left edge, outputs on the right, one 20 px row each below the header;
  a side's lone unlabelled `in` / `out` sits in the middle of the zone. Without any label the card is the compact
  76 px card with the handles at its middle height.
- **Top → bottom:** inputs along the top edge, outputs along the bottom, one slot each, labels in a strip next to
  the edge.
- **Groups (forEach / loop):** ports in columns beside the header (inputs, then the inner `item` inset on the left;
  outputs right), in both directions; the body starts at `GROUP_PAD.top` = 84 px (was 64: the header now holds up to
  three port rows). Bodies placed by an older version at 64 px may touch the lowest right-hand row until arranged.
- **Size:** width grows with the longest title / subtitle / label pair between 232 and 360 px (beyond: cut, the full
  text as the tooltip); height grows with the number of ports. The handles (edge anchors) are placed on the rows.
- `layoutProblems(layout)` lists overlapping or escaping boxes and overlapping handles; the tests run it for every
  catalog type × both directions × long ids / Turkish subtitles / badges and a switch with long case names.

The editor, the run graph and the arrange modes all use the same size (`cardSize`), so dagre lays out the real
cards. Both engines now read the direction (LR / TB) from the placement (engine 2 was always LR, so a top → bottom
tidy drew side ports); the direction an arrangement picks stays until undo / redo or reload (aligning or dragging a
card never turns its ports).

## 2. Node families (`canvasLook.ts`, `canvas.css`)

| Family | Types (packages/workflow-nodes) | Icon | Light | Dark |
| --- | --- | --- | --- | --- |
| trigger | `trigger.*` | bolt | `#1f7a3d` | `#5cc98d` |
| ai | `ai.step`, v1 AI steps | brain | `#6a4bd1` | `#a58ef7` |
| flow | `control.*` except waits (if, switch, merge, forEach, loop, subWorkflow, stop, fail, return, respond) | branch | `#1f5fc7` | `#6aa5ff` |
| data | `data.*` | db | `#00727f` | `#4fd1e0` |
| integration | `notify.*`, `chat.*`, `jobs.*`, `deploy.*`, `dns.*`, `github.*`, `uptime.*`, `http.*`, `email.*` | globe | `#b4501a` | `#ff9a5c` |
| wait | `control.approval`, `control.delay`, `control.waitUntil`, `control.waitWebhook` | clock | `#8a6200` | `#f0c048` |
| other | `code.*`, unknown types | code | `#a3367a` | `#f08ad0` |

Each family has `--wf-<f>` (band, chip icon), `--wf-<f>-soft` (chip background) and `--wf-<f>-tint` (card
background) in light and dark (`prefers-color-scheme` and `data-theme`, the same selectors as diyalog.css). Checked:
the family colour ≥ 3:1 on the card, its tint and its chip; ink and muted text ≥ 4.5:1 on the tint (lowest: muted text
7.24:1 on the light `other` tint, 6.54:1 on the dark `data` tint; ink ≥ 11.6:1). The icon tells the families apart without colour. The
state border (running teal, failed / issues red, selected ink with a ring), the planned dashed border, the AI diff
marks and the breathing state dot (now on the chip's corner) draw over the tint as before; error ports stay red.

## 3. Edge colours

A categorical, colour-blind-friendly palette of 8 (Okabe–Ito based, red left out; `--wf-e0…7`, ≥ 3:1 on the canvas
in both themes). An edge takes the slot its id hashes to (FNV-1a), moved to the next free slot when an edge with
the same source or target already has it; edges are processed in id order, so the result depends only on the set of
edges. The arrowhead takes the edge colour; the label box gets a border in it (text stays muted on the card colour).
In a fan-out the 2nd / 3rd link also gets a dash pattern (`9 3`, `2 3`) unless the dash already means something
(planned / skipped, error, invalid, diff). Error links are red and dashed, invalid links red, AI diff green / red as
before. The selected edge is 3 px with an ink halo and keeps its colour.

## 4. Arrange split button (`ArrangeMenu.tsx`, `layout.ts` `arrange`)

| Mode | Icon | What it does |
| --- | --- | --- |
| `lr` Soldan sağa | layoutLr | dagre layered, left → right |
| `tb` Yukarıdan aşağıya | layoutTb | dagre layered, top → bottom |
| `grid` Sıkı ızgara | grid | reading order (layered LR, then top → bottom) filled row by row, columns from the canvas' aspect |
| `tree` Dallanma aralıklı | tree | layered in the current direction, `tight-tree` ranker, wider node / rank gaps, room for branch labels on named-port links |
| `align` Seçimi hizala | alignMid | the selection (shift / ⌘-click, box) on the first selected card's line across the reading direction, in order, ≥ 32 px apart; one selected card takes its direct neighbours |

Every mode but align lays out each scope (group bodies first, deepest first) and grows groups around their bodies.
The main part runs the last used mode and shows its icon (`aria-label` "Düzenle: Soldan sağa"); the chevron opens the
menu (`role=menu`, `menuitemradio` with `aria-checked`; Enter / Space / ↓ open on the first mode, ↑ on the last;
arrows, Home / End move; Escape returns focus to the chevron; Tab closes). Align without a selection is shown with
`aria-disabled` and its reason; a remembered align disables the main part until something is selected. The choice
lives in `localStorage['remyral.dy.workflow.arrange']` (guarded; blocked storage → left → right). An arrangement is
one undo step (one commit); the cards glide there with `requestAnimationFrame` over `--dy-m-layout` (280 ms, in-out),
instant under reduced motion / `data-motion="reduce"` / a hidden tab; another edit during the glide ends it.

## 5. Tests and harness

- `apps/web/test/workflow-canvas.test.ts` — zones for every catalog type (imported from the package), growth and
  truncation, the reported AI step, group header vs `GROUP_PAD`, family mapping and token contrast in three theme
  blocks, deterministic and distinct edge colours, every arrange mode without overlaps, align semantics, undo, the
  guarded storage; the harness table equals the catalog.
- `apps/web/test/workflow-canvas-arrange.test.tsx` — the split button in the editor (menu, align disabled, remembered
  mode, undo restores, keyboard pattern, family on the cards).
- Harness: `/diyalog-harness.html?engine=2&path=/workflows/wf-canvas` — one node of every type (the package cannot
  load in the browser, so a checked table of types and ports). Checked in Chromium (Playwright) light and dark, at
  fit zoom and 3–4× device scale; not checked in Safari / Firefox or on a phone.
