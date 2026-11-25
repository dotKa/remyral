// p13-workflows-ui: the classic chat card of a `workflow` draft (draft_workflow) — the graph preview, the version
// line, validation issues mapped to steps, Confirm disabled while invalid, the saved workflow's link — and the pure
// payload reader shared with the Diyalog card.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDraft } from '../src/api/chat';
import { summarizeDraft } from '../src/screens/chat/drafts';
import { issueLine, workflowDraftOf } from '../src/screens/chat/workflowDraft';

const NOW = '2026-10-20T10:00:00.000Z';
const WF = '55555555-5555-4555-8555-555555555555';

function payload(valid: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: 'alpha',
    name: 'feature',
    definition: {},
    valid,
    issues: valid
      ? []
      : [
          { path: 'edges', code: 'cycle' },
          { path: 'nodes.1.prompt', code: 'undeclared_input:x' },
        ],
    nodes: [
      { id: 'plan', role: 'planner', gate: null, dynamic: true },
      { id: 'build', role: 'executor', gate: 'operator', dynamic: false },
    ],
    edges: [{ from: 'plan', to: 'build' }],
    ...extra,
  };
}

function draft(p: Record<string, unknown>, over: Partial<ChatDraft> = {}): ChatDraft {
  return {
    id: 'd1',
    threadId: 't1',
    kind: 'workflow',
    title: 'New workflow feature',
    payload: p,
    project: 'alpha',
    state: 'proposed',
    result: null,
    createdAt: NOW,
    expiresAt: NOW,
    decidedAt: null,
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workflow draft payload (pure)', () => {
  it('reads nodes, edges and issues, mapping node paths to step ids', () => {
    const w = workflowDraftOf(payload(false, { baseVersion: 3, workflowId: WF }));
    expect(w.baseVersion).toBe(3);
    expect(w.nodes.map((n) => n.id)).toEqual(['plan', 'build']);
    expect(w.issues.map((i) => i.node)).toEqual([null, 'build']);
    expect(w.issues.map(issueLine)).toEqual(['edges: cycle', 'build · prompt: undeclared_input:x']);
    // Hostile / malformed payloads degrade to empty values, never throw.
    expect(workflowDraftOf({ nodes: 'x', issues: [{ path: 3 }] }).issues).toEqual([
      { path: '', code: '', node: null },
    ]);
  });

  it('summarises the version line and the steps', () => {
    const s = summarizeDraft(draft(payload(true, { baseVersion: 1, workflowId: WF })));
    expect(s.key.find((r) => r.label === 'Version')?.value).toBe('v1 → v2');
    expect(s.key.find((r) => r.label === 'Steps')?.value).toBe(
      'plan (planner), build (executor, approval: operator)',
    );
    expect(summarizeDraft(draft(payload(true))).key.find((r) => r.label === 'Version')?.value).toBe(
      'New workflow (v1)',
    );
  });
});
