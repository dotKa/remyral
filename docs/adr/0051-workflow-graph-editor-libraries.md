# ADR-0051: Workflow graph editor on React Flow + dagre (+ yaml), lazy-loaded

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** owner (2026-10-20: "Workflow düzenleme/görüntüleme için hazır paket kullanabilirsin"), agent
- **Related:** p13-workflows-ui, [p4-dag.md](../design/p4-dag.md) §9, [p13-workflows-ui.md](../design/p13-workflows-ui.md),
  [dependency policy](../security/dependency-policy.md), ADR-0047 (Diyalog console)

## Context
Workflow definitions could only be created through the API or the chat; the console showed runs. The owner asked for
a definition list and an editor/viewer whose canvas fills the content area, with toolbar actions (add, tidy up, …), and
explicitly allowed a ready-made package. p4-dag §9 had decided "no graph library: tens of nodes do not justify one" for
a *read-only* run graph. An editor needs dragging, connecting by handles, selection, keyboard access, zoom/pan, a
minimap and an automatic layout — a large, accessibility-sensitive surface to build and maintain by hand. The console
runs under a strict CSP (`default-src 'self'`, `style-src 'self'`, no `unsafe-inline`, no `unsafe-eval`).

## Decision
1. **Canvas: `@xyflow/react` 12.12.0** (React Flow, MIT, maintained by xyflow; deps `@xyflow/system`, `zustand`,
   `classcat`, `d3-zoom/drag/selection/…` — MIT/ISC). Controlled: the definition document is the single source of truth;
   React Flow renders it and reports moves / connections / deletions. Its stylesheet (`dist/base.css`) is bundled by
   Vite with our token overrides (no CDN, no `<style>` injection; inline `style` attributes are set through the CSSOM,
   which `style-src 'self'` allows).
2. **Auto-layout ("Düzenle"): `@dagrejs/dagre` 3.1.1** (MIT; dep `@dagrejs/graphlib`) — layered layout, LR or TB,
   whichever fits the canvas larger. elkjs was rejected for size (≈1.4 MB) for graphs of ≤ 50 static steps.
3. **Text view: `yaml` 2.9.1** (ISC, no dependencies) for the YAML/JSON panel — core schema only, alias count bounded;
   nothing is evaluated.
4. **Isolation:** only `WorkflowCanvas.tsx`, `layout.ts` and `text.ts` import these packages, and only the lazily loaded
   editor (`WorkflowEditor`) and run graph (`RunGraph`) import those files; a test guards the edges
   (`apps/web/test/workflows-lazy-chunk.test.ts`). Measured production build: canvas chunk 230.6 kB (75.1 kB gzip,
   React Flow + dagre), editor chunk 138.5 kB (44.2 kB gzip, incl. yaml), CSS 13.2 kB (2.5 kB gzip); the main chunk
   contains none of them.
5. Versions are pinned exactly (pnpm lock with sha512 integrity, `pnpm security:pins`); updates follow the dependency
   policy cadence. This ADR amends p4-dag §9: the run page now uses the same canvas renderer, read-only.

## Alternatives considered
- **Hand-written SVG editor** (extending `lib/dag-layout.ts`): no new dependencies, but drag/connect/zoom/keyboard/minimap
  and their accessibility would be our own code to maintain — rejected after the owner allowed a package.
- **elkjs** for layout: better orthogonal routing, but ~1.4 MB and a worker for good performance — oversized here.
- **js-yaml**: equally suitable (MIT); `yaml` has built-in TypeScript types and no transitive dependencies.
- **Rete.js / JointJS / Cytoscape**: heavier, less idiomatic in React, or commercial tiers for editor features.

## Consequences
- + A real editor (drag, connect, select, delete, undo/redo, tidy, fit, minimap, snap) and a consistent run view.
- + No impact on the first load (lazy chunks); CSP unchanged.
- − Three new runtime dependencies (plus their transitive tree) to keep updated and scanned (`pnpm security:scan`).
- − jsdom tests need a ResizeObserver / DOMMatrixReadOnly shim (React Flow's documented testing setup).

## Verification
- `apps/web/test/workflows-lazy-chunk.test.ts` (imports only from the allowed files / lazy modules).
- Production build under the console CSP: no violation on `/workflows`, `/workflows/:id`, `/workflows/new` and the run
  page (Playwright check against `vite preview` with the console's header, docs/design/p13-workflows-ui.md §6).
- `pnpm security:pins` passes; licenses MIT / ISC.
