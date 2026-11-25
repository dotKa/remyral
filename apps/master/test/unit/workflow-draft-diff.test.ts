import { describe, expect, it } from 'vitest';
import { canonical, MAX_CHANGES, workflowChanges } from '../../src/workflows/draft-diff.js';

/** p17-chat-flow: what changed between two drafted workflow documents (pure). */
describe('workflow draft diff (p17-chat-flow)', () => {
  const base = {
    schemaVersion: 2,
    name: 'w',
    nodes: [
      { id: 'a', type: 'trigger.manual', position: { x: 1, y: 1 } },
      { id: 'b', type: 'http.request', config: { url: 'https://x.test', method: 'GET' } },
    ],
    edges: [{ from: 'a', to: 'b' }],
  };

  it('nothing changed: positions, layout and key order do not count', () => {
    const same = {
      edges: [{ to: 'b', from: 'a' }],
      nodes: [
        { id: 'a', type: 'trigger.manual', position: { x: 9, y: 9 } },
        { config: { method: 'GET', url: 'https://x.test' }, type: 'http.request', id: 'b' },
      ],
      name: 'w',
      schemaVersion: 2,
      layout: { zoom: 2 },
    };
    expect(workflowChanges(base, same)).toEqual({ changes: [], truncated: false });
    expect(canonical({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
  });

  it('nodes added / removed / changed (config fields), edges, settings', () => {
    const next = {
      ...base,
      description: 'now with mail',
      nodes: [
        { id: 'b', type: 'http.request', config: { url: 'https://y.test', method: 'GET' } },
        { id: 'c', type: 'email.send', config: {} },
      ],
      edges: [{ from: 'b', fromPort: 'out', to: 'c' }],
    };
    expect(workflowChanges(base, next).changes).toEqual([
      { kind: 'node_changed', id: 'b', fields: ['config.url'] },
      { kind: 'node_added', id: 'c' },
      { kind: 'node_removed', id: 'a' },
      { kind: 'edge_added', id: 'b:out → c' },
      { kind: 'edge_removed', id: 'a → b' },
      { kind: 'setting_changed', id: 'description' },
    ]);
  });

  it('bounded', () => {
    const many = {
      nodes: Array.from({ length: 100 }, (_, i) => ({ id: `n${String(i)}`, type: 'data.set' })),
    };
    const out = workflowChanges({}, many);
    expect(out.changes).toHaveLength(MAX_CHANGES);
    expect(out.truncated).toBe(true);
  });
});
