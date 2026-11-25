// p15-workflow-ai (docs/design/p15-workflow-ai.md §3): the assistant's proposal against the editor's document —
// changes (added / removed / changed nodes and edges, settings), accept / reject per change or all, and the preview
// the canvas draws during the review.
import { describe, expect, it } from 'vitest';
import { aiChanges, applyAiChanges, canonical, previewAiDoc } from '../src/diyalog/screens/workflows/aiDiff';
import type { Doc } from '../src/diyalog/screens/workflows/model';

const base = (): Doc => ({
  name: 'triage',
  inputs: {},
  defaults: { runtime: 'codex' },
  nodes: [
    { id: 'start', type: 'trigger.manual', config: {} },
    {
      id: 'fetch',
      type: 'http.request',
      config: { method: 'GET', origin: 'https://api.example.com', path: '/a' },
    },
    { id: 'tell', type: 'notify.users', config: { recipients: { creator: true }, title: 'Done' } },
  ],
  edges: [
    { from: 'start', to: 'fetch' },
    { from: 'fetch', to: 'tell' },
  ],
  layout: { positions: { start: { x: 0, y: 0 }, fetch: { x: 300, y: 0 }, tell: { x: 600, y: 0 } } },
});

/** "Gate the notification behind an approval, add an error branch" — the assistant's version. */
const proposal = (): Doc => ({
  name: 'triage',
  inputs: {},
  defaults: { runtime: 'codex' },
  description: 'With approval',
  nodes: [
    { id: 'start', type: 'trigger.manual', config: {} },
    // Same config, keys in another order: not a change.
    {
      id: 'fetch',
      type: 'http.request',
      config: { path: '/a', origin: 'https://api.example.com', method: 'GET' },
    },
    { id: 'gate', type: 'control.approval', config: { approverRole: 'admin' } },
    { id: 'tell', type: 'notify.users', config: { recipients: { creator: true }, title: 'Approved' } },
    { id: 'oops', type: 'chat.message', config: { text: 'Fetch failed' } },
  ],
  edges: [
    { from: 'start', to: 'fetch' },
    { from: 'fetch', to: 'gate' },
    { from: 'gate', fromPort: 'approved', to: 'tell' },
    { from: 'fetch', fromPort: 'error', to: 'oops' },
  ],
});

describe('aiChanges', () => {
  it('lists added, changed and removed nodes and edges; key order and positions do not count', () => {
    const changes = aiChanges(base(), proposal());
    expect(changes.map((c) => c.key)).toEqual([
      'settings',
      'node:+gate',
      'node:~tell',
      'node:+oops',
      'edge:+fetch:out->gate:in',
      'edge:+gate:approved->tell:in',
      'edge:+fetch:error->oops:in',
      'edge:-fetch:out->tell:in',
    ]);
    expect(changes.find((c) => c.key === 'node:~tell')?.fields).toEqual(['config']);
    expect(changes.find((c) => c.key === 'settings')?.fields).toEqual(['description']);
    expect(canonical({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonical({ a: [1, { c: 3, d: 2 }], b: 1 }));
  });

  it('an identical document (moved nodes only) has no change; a removed node is listed', () => {
    const moved = { ...base(), layout: { positions: { start: { x: 9, y: 9 } } } };
    expect(aiChanges(base(), moved)).toEqual([]);
    const fewer = { ...base(), nodes: base().nodes.slice(0, 2), edges: base().edges.slice(0, 1) };
    expect(aiChanges(base(), fewer).map((c) => c.key)).toEqual(['node:-tell', 'edge:-fetch:out->tell:in']);
  });
});

describe('applyAiChanges', () => {
  const keys = (d: Doc) => ({
    nodes: d.nodes.map((n) => n.id),
    edges: d.edges.map((e) => `${e.from}>${e.to}`),
  });

  it('accepting everything gives the proposal (positions of existing nodes kept)', () => {
    const all = new Set(aiChanges(base(), proposal()).map((c) => c.key));
    const out = applyAiChanges(base(), proposal(), all);
    expect(keys(out)).toEqual({
      nodes: ['start', 'fetch', 'tell', 'gate', 'oops'],
      edges: ['start>fetch', 'fetch>gate', 'gate>tell', 'fetch>oops'],
    });
    expect(out.description).toBe('With approval');
    expect(out.nodes.find((n) => n.id === 'tell')?.config).toEqual({
      recipients: { creator: true },
      title: 'Approved',
    });
    expect(out.layout?.positions.fetch).toEqual({ x: 300, y: 0 });
  });

  it('rejecting everything keeps the current document', () => {
    const out = applyAiChanges(base(), proposal(), new Set());
    expect(keys(out)).toEqual(keys(base()));
    expect(out.description).toBeUndefined();
    expect(out.nodes.find((n) => n.id === 'tell')?.config).toEqual(base().nodes[2]?.config);
  });

  it('per change: an accepted edge to a rejected new node is not taken; the old edge stays unless its removal is accepted', () => {
    // Only the error branch: its node and its edge.
    const out = applyAiChanges(
      base(),
      proposal(),
      new Set(['node:+oops', 'edge:+fetch:error->oops:in', 'edge:+fetch:out->gate:in']),
    );
    expect(keys(out)).toEqual({
      nodes: ['start', 'fetch', 'tell', 'oops'],
      edges: ['start>fetch', 'fetch>tell', 'fetch>oops'],
    });
    // Removing a node takes its edges with it, even when their removal was not chosen.
    const fewer = { ...base(), nodes: base().nodes.slice(0, 2), edges: base().edges.slice(0, 1) };
    const removed = applyAiChanges(base(), fewer, new Set(['node:-tell']));
    expect(keys(removed)).toEqual({ nodes: ['start', 'fetch'], edges: ['start>fetch'] });
  });
});

describe('previewAiDoc', () => {
  it('draws the proposal plus what it removes, each element marked', () => {
    const p = previewAiDoc(base(), proposal());
    expect(p.doc.nodes.map((n) => n.id)).toEqual(['start', 'fetch', 'gate', 'tell', 'oops']);
    expect(Object.fromEntries(p.nodes)).toEqual({ gate: 'added', tell: 'changed', oops: 'added' });
    expect(p.edges.get('fetch->tell')).toBe('removed');
    expect(p.doc.edges.some((e) => e.from === 'fetch' && e.to === 'tell')).toBe(true);
    expect(p.edges.get('fetch:error->oops:in')).toBe('added');
  });
});
