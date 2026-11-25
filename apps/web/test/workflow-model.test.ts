// p13-workflows-ui: the editor's pure model — edits, refusals, rename, issue mapping, diff, text views, history.
import { describe, expect, it } from 'vitest';
import { historyReducer, initHistory } from '../src/diyalog/screens/workflows/history';
import { tidyPositions } from '../src/diyalog/screens/workflows/layout';
import {
  addNode,
  asDoc,
  cleanDoc,
  connect,
  connectRefusal,
  type Doc,
  diffDocs,
  emptyDoc,
  issueText,
  mapIssues,
  removeElements,
  renameNode,
  setUpstream,
  templateChoices,
} from '../src/diyalog/screens/workflows/model';
import { parseText, serialize } from '../src/diyalog/screens/workflows/text';

function chain(): Doc {
  let d: Doc = { ...emptyDoc(), name: 'demo' };
  let r = addNode(d, 'planner', null);
  d = r.doc;
  r = addNode(d, 'executor', 'plan');
  d = r.doc;
  r = addNode(d, 'verifier', 'step');
  return r.doc;
}

describe('workflow editor model (p13-workflows-ui)', () => {
  it('adds steps after the selected one, with fresh ids and role defaults', () => {
    const d = chain();
    expect(d.nodes.map((n) => [n.id, n.role])).toEqual([
      ['plan', 'planner'],
      ['step', 'executor'],
      ['verify', 'verifier'],
    ]);
    expect(d.edges).toEqual([
      { from: 'plan', to: 'step' },
      { from: 'step', to: 'verify' },
    ]);
    expect(d.nodes[0]?.dynamic).toEqual({ maxNodes: 5 });
    const g = addNode(d, 'gate', null);
    expect(g.id).toBe('gate');
    expect(g.doc.nodes.at(-1)?.approval).toEqual({ approverRole: 'admin' });
    expect(addNode(g.doc, 'executor', null).id).toBe('step-2');
    // Every step has a position; the new one sits right of the others.
    expect(Object.keys(g.doc.layout?.positions ?? {})).toHaveLength(4);
  });

  it('refuses self, duplicate and cycle-closing links', () => {
    const d = chain();
    expect(connectRefusal(d, 'plan', 'plan')).toBe('self');
    expect(connectRefusal(d, 'plan', 'step')).toBe('duplicate');
    expect(connectRefusal(d, 'verify', 'plan')).toBe('cycle');
    expect(connectRefusal(d, 'plan', 'nope')).toBe('unknown');
    const ok = connect(d, 'plan', 'verify');
    expect(typeof ok).toBe('object');
    expect(setUpstream(d, 'plan', ['verify'])).toBe('cycle');
  });

  it('removes steps with their links and positions', () => {
    const d = removeElements(chain(), ['step'], []);
    expect(d.nodes.map((n) => n.id)).toEqual(['plan', 'verify']);
    expect(d.edges).toEqual([]);
    expect(d.layout?.positions.step).toBeUndefined();
    const e = removeElements(chain(), [], ['plan->step']);
    expect(e.edges).toEqual([{ from: 'step', to: 'verify' }]);
  });

  it('renames a step: links, position and upstream references follow', () => {
    let d = chain();
    d = {
      ...d,
      nodes: d.nodes.map((n) =>
        n.id === 'verify'
          ? { ...n, prompt: 'Check {{upstream.step.summary}} and {{ upstream.step.branch }}' }
          : n,
      ),
    };
    const r = renameNode(d, 'step', 'build');
    expect(r.edges).toEqual([
      { from: 'plan', to: 'build' },
      { from: 'build', to: 'verify' },
    ]);
    expect(r.nodes.find((n) => n.id === 'verify')?.prompt).toBe(
      'Check {{upstream.build.summary}} and {{upstream.build.branch }}',
    );
    expect(r.layout?.positions.build).toBeDefined();
    expect(renameNode(d, 'step', 'plan')).toBe(d); // taken: unchanged
  });

  it('maps the master’s issue paths to steps and links, in words', () => {
    const d = chain();
    const m = mapIssues(d, [
      { path: 'nodes.1.prompt', code: 'undeclared_input:goal' },
      { path: 'edges.0', code: 'duplicate' },
      { path: 'layout.positions.verify', code: 'unknown_node' },
      { path: 'defaults.runtime', code: 'invalid_value' },
    ]);
    expect(m.byNode.get('step')?.map(issueText)).toEqual([
      'prompt: tanımsız girdi “goal” (Ayarlar → Girdiler’e ekle)',
    ]);
    expect(m.byEdge.get('plan->step')?.map(issueText)).toEqual(['tekrar ediyor']);
    expect(m.byNode.get('verify')).toHaveLength(1);
    expect(m.general.map(issueText)).toEqual(['defaults.runtime: değer geçersiz']);
  });

  it('diffs versions by steps, links and settings (positions ignored)', () => {
    const a = chain();
    let b = removeElements(a, ['verify'], []);
    b = addNode(b, 'integrator', 'step').doc;
    b = {
      ...b,
      description: 'new',
      nodes: b.nodes.map((n) => (n.id === 'plan' ? { ...n, prompt: 'x' } : n)),
    };
    const d = diffDocs(a, b);
    expect(d.added).toEqual(['integrate']);
    expect(d.removed).toEqual(['verify']);
    expect(d.changed).toEqual([{ id: 'plan', fields: ['prompt'] }]);
    expect(d.edgesAdded).toEqual(['step->integrate']);
    expect(d.edgesRemoved).toEqual(['step->verify']);
    expect(d.settings).toEqual(['description']);
  });

  it('round-trips YAML and JSON; refuses bad text with a reason', () => {
    const d = chain();
    for (const fmt of ['yaml', 'json'] as const) {
      const r = parseText(serialize(d, fmt), fmt);
      expect('doc' in r && r.doc).toEqual(cleanDoc(d));
    }
    const bad = parseText('name: [', 'yaml');
    expect('error' in bad && bad.error.startsWith('YAML okunamadı')).toBe(true);
    expect(parseText('{"name": 1, "nodes": []}', 'json')).toEqual({ error: '“name” bir metin olmalı.' });
    expect(asDoc({ name: 'x', nodes: [{ id: 'a', role: 'executor' }] })).toEqual({
      error: 'nodes.0: id, role ve prompt metin olmalı.',
    });
    // YAML tags are not code: the core schema keeps unknown tags as plain values.
    expect('doc' in parseText('name: x\nnodes: []\nedges: []\ndefaults: {}\ninputs: {}\n', 'yaml')).toBe(
      true,
    );
  });

  it('offers only declared inputs and ancestors as templates', () => {
    expect(templateChoices(chain(), 'verify')).toEqual([
      '{{inputs.task}}',
      '{{upstream.plan.summary}}',
      '{{upstream.plan.branch}}',
      '{{upstream.step.summary}}',
      '{{upstream.step.branch}}',
    ]);
  });

  it('lays out left to right in dependency order (tidy)', () => {
    const p = tidyPositions(
      ['a', 'b', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    );
    expect((p.a?.x ?? 0) < (p.b?.x ?? 0) && (p.b?.x ?? 0) < (p.c?.x ?? 0)).toBe(true);
  });

  it('undo / redo whole documents; typing in one field is one step', () => {
    const a = chain();
    const b = { ...a, name: 'b' };
    const c = { ...a, name: 'bc' };
    let h = initHistory(a);
    h = historyReducer(h, { type: 'commit', doc: b, tag: 'name', now: 1000 });
    h = historyReducer(h, { type: 'commit', doc: c, tag: 'name', now: 1200 });
    expect(h.past).toHaveLength(1);
    h = historyReducer(h, { type: 'undo' });
    expect(h.present).toBe(a);
    h = historyReducer(h, { type: 'redo' });
    expect(h.present).toBe(c);
    h = historyReducer(h, { type: 'commit', doc: b, tag: 'name', now: 5000 });
    expect(h.past).toHaveLength(2);
    expect(h.future).toHaveLength(0);
  });
});
