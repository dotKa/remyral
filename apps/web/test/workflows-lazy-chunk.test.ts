// p13-workflows-ui: React Flow, dagre and yaml stay out of the main bundle — only the lazily loaded editor / run-graph
// modules import them (statically). A static guard over the source: the bundler splits exactly at these edges
// (verified on the production build: docs/design/p13-workflows-ui.md §6).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');
const WF = 'diyalog/screens/workflows/';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

const STATIC_IMPORT = /^\s*import\s[^;]*?from\s+'([^']+)'/gms;

function staticImports(text: string): string[] {
  return [...text.matchAll(STATIC_IMPORT)].map((m) => m[1] ?? '');
}

describe('workflow editor bundle split (p13-workflows-ui)', () => {
  const all = files(SRC).map((p) => ({
    rel: relative(SRC, p).replaceAll('\\', '/'),
    text: readFileSync(p, 'utf8'),
  }));

  it('imports the graph libraries only from the canvas, the layout and the text view', () => {
    const owners: Record<string, string> = {
      '@xyflow/react': `${WF}WorkflowCanvas.tsx`,
      '@xyflow/react/dist/base.css': `${WF}WorkflowCanvas.tsx`,
      '@dagrejs/dagre': `${WF}layout.ts`,
      yaml: `${WF}text.ts`,
    };
    for (const f of all) {
      for (const spec of staticImports(f.text)) {
        if (spec in owners) expect(f.rel, `${spec} imported by ${f.rel}`).toBe(owners[spec]);
      }
    }
  });

  it('loads those modules only from lazily imported screens', () => {
    const heavy = ['./WorkflowCanvas', './layout', './text', './WorkflowEditor', './RunGraph'];
    const lazyOnly = new Set([
      `${WF}WorkflowEditor.tsx`,
      `${WF}RunGraph.tsx`,
      `${WF}WorkflowCanvas.tsx`,
      `${WF}TextPanel.tsx`,
      `${WF}text.ts`,
      `${WF}layout.ts`,
      // p17-workflow-canvas: the arrange split button (imported by the editor only).
      `${WF}ArrangeMenu.tsx`,
    ]);
    for (const f of all) {
      if (!f.rel.startsWith(WF)) {
        for (const spec of staticImports(f.text)) {
          expect(
            /workflows\/(WorkflowCanvas|layout|text|WorkflowEditor|RunGraph|TextPanel)$/.test(spec),
            `${f.rel}: ${spec}`,
          ).toBe(false);
        }
        continue;
      }
      if (lazyOnly.has(f.rel)) continue;
      for (const spec of staticImports(f.text)) {
        expect(heavy.includes(spec) || spec === './TextPanel', `${f.rel} statically imports ${spec}`).toBe(
          false,
        );
      }
    }
    // p14-workflow-engine 14.1: the palette, the typed inspector and its schema form are editor-only (lazy chunk).
    const editorOnly: Record<string, readonly string[]> = {
      './Palette': [`${WF}WorkflowEditor.tsx`],
      './TypedInspector': [`${WF}WorkflowEditor.tsx`],
      './SchemaForm': [`${WF}TypedInspector.tsx`],
      './ArrangeMenu': [`${WF}WorkflowEditor.tsx`],
    };
    for (const f of all) {
      for (const spec of staticImports(f.text)) {
        const key = Object.keys(editorOnly).find(
          (k) => spec === k || spec.endsWith(`/workflows/${k.slice(2)}`),
        );
        if (key !== undefined) expect(editorOnly[key], `${f.rel} imports ${spec}`).toContain(f.rel);
      }
    }
    expect(all.find((f) => f.rel === `${WF}index.tsx`)?.text).toContain(
      "lazy(() => import('./WorkflowEditor'))",
    );
    expect(all.find((f) => f.rel === 'diyalog/screens/jobs/WorkflowRuns.tsx')?.text).toContain(
      "lazy(() => import('../workflows/RunGraph'))",
    );
  });
});
