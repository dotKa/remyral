// p14-workflow-engine 14.1: the editor's model with typed nodes — v1 stays v1, a v2 feature makes the document v2
// (lossless round trip of the AI steps' failure policy), port-aware connection refusals, groups, references, words.
import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../src/api/workflowEngine';
import { tidyScoped } from '../src/diyalog/screens/workflows/layout';
import {
  aiStepBody,
  asDoc,
  cleanDoc,
  connect,
  connectRefusal,
  type Doc,
  emptyDoc,
  insertNode,
  issueTextWith,
  mapIssues,
  removeElements,
  renameNode,
  usesV2,
} from '../src/diyalog/screens/workflows/model';
import {
  availability,
  idPrefix,
  makePortsOf,
  matchSuggestions,
  suggestionsFor,
  tokenBefore,
} from '../src/diyalog/screens/workflows/nodeCatalog';
import { parseText, serialize } from '../src/diyalog/screens/workflows/text';
import { CATALOG } from './workflow-catalog-fixture';

const catalog = parseCatalog(CATALOG);
const portsOf = makePortsOf(catalog);

function v1(): Doc {
  const r = asDoc({
    name: 'demo',
    inputs: { task: { required: true } },
    defaults: { runtime: 'codex' },
    nodes: [
      { id: 'a', role: 'executor', prompt: 'do', failurePolicy: 'retry-safe', maxRetries: 2 },
      { id: 'b', role: 'verifier', prompt: 'check', failurePolicy: 'continue' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  });
  if (!('doc' in r)) throw new Error(r.error);
  return r.doc;
}

function withIf(): { doc: Doc; id: string } {
  return insertNode(v1(), { type: 'control.if', config: { condition: { $expr: 'true' } } }, 'if', {
    after: { id: 'b', port: 'out' },
    portsOf,
  });
}

describe('workflow model v2 (p14-workflow-engine 14.1)', () => {
  it('keeps a document with only AI steps and default ports exactly v1', () => {
    const d = v1();
    expect(usesV2(d)).toBe(false);
    const wire = cleanDoc(d);
    expect(wire.schemaVersion).toBeUndefined();
    expect(wire.nodes[0]).toEqual({
      id: 'a',
      role: 'executor',
      prompt: 'do',
      failurePolicy: 'retry-safe',
      maxRetries: 2,
    });
  });

  it('writes v2 once a typed node is used, mapping the failure policies as normaliseV1, and reads it back', () => {
    const { doc, id } = withIf();
    expect(id).toBe('if');
    expect(usesV2(doc)).toBe(true);
    const wire = cleanDoc(doc);
    expect(wire.schemaVersion).toBe(2);
    expect(wire.nodes).toEqual([
      { type: 'ai.step', id: 'a', role: 'executor', prompt: 'do', retry: { max: 2, safe: true } },
      { type: 'ai.step', id: 'b', role: 'verifier', prompt: 'check', onError: 'skip' },
      { type: 'control.if', config: { condition: { $expr: 'true' } }, id: 'if' },
    ]);
    // Round trip through the YAML / JSON panel: the editor's AI steps come back in v1 words.
    for (const fmt of ['yaml', 'json'] as const) {
      const r = parseText(serialize(doc, fmt), fmt);
      expect('doc' in r && cleanDoc(r.doc)).toEqual(wire);
      expect('doc' in r && r.doc.nodes[0]).toEqual({
        id: 'a',
        role: 'executor',
        prompt: 'do',
        failurePolicy: 'retry-safe',
        maxRetries: 2,
      });
    }
    // Removing the v2 feature makes it v1 again.
    expect(cleanDoc(removeElements(doc, ['if'], [])).schemaVersion).toBeUndefined();
  });

  it('keeps v2-only AI policies that have no v1 word (onError continue)', () => {
    const r = asDoc({
      schemaVersion: 2,
      name: 'x',
      inputs: {},
      defaults: {},
      nodes: [{ type: 'ai.step', id: 'a', role: 'executor', prompt: 'p', onError: 'continue' }],
      edges: [],
    });
    expect('doc' in r && r.doc.nodes[0]).toEqual({
      id: 'a',
      role: 'executor',
      prompt: 'p',
      onError: 'continue',
    });
    expect('doc' in r && cleanDoc(r.doc).nodes[0]).toEqual({
      type: 'ai.step',
      id: 'a',
      role: 'executor',
      prompt: 'p',
      onError: 'continue',
    });
  });

  it('refuses links by port, input count, scope, trigger input and cycles (in words)', () => {
    let { doc } = withIf();
    expect(doc.edges.at(-1)).toEqual({ from: 'b', to: 'if' });
    doc = insertNode(doc, { type: 'trigger.manual', config: {} }, 'start').doc;
    doc = insertNode(doc, { type: 'data.set', config: { fields: { x: { $expr: '1' } } } }, 'set').doc;
    expect(connectRefusal(doc, 'if', 'set', { fromPort: 'out' }, portsOf)).toBe('unknown_port');
    expect(connectRefusal(doc, 'if', 'set', { fromPort: 'nope' }, portsOf)).toBe('unknown_port');
    expect(connectRefusal(doc, 'set', 'start', {}, portsOf)).toBe('trigger_input');
    const linked = connect(doc, 'if', 'set', { fromPort: 'true' }, portsOf);
    expect(typeof linked).toBe('object');
    if (typeof linked === 'string') return;
    expect(linked.edges.at(-1)).toEqual({ from: 'if', to: 'set', fromPort: 'true' });
    // data.set has one input; an AI step takes many.
    expect(connectRefusal(linked, 'a', 'set', {}, portsOf)).toBe('single_input');
    expect(connectRefusal(linked, 'set', 'a', {}, portsOf)).toBe('cycle');
    expect(connectRefusal(linked, 'if', 'set', { fromPort: 'true' }, portsOf)).toBe('duplicate');
  });

  it('adds into a group (fed by its item port), keeps links inside it, removes the body with the group', () => {
    let { doc } = withIf();
    const g = insertNode(doc, { type: 'control.forEach', config: { items: { $expr: '$input' } } }, 'each', {
      after: { id: 'if', port: 'true' },
      portsOf,
    });
    doc = g.doc;
    const kid = insertNode(doc, { type: 'data.set', config: { fields: {} } }, 'set', {
      parent: 'each',
      portsOf,
    });
    doc = kid.doc;
    expect(doc.nodes.find((n) => n.id === 'set')?.parent).toBe('each');
    expect(doc.edges).toContainEqual({ from: 'each', to: 'set', fromPort: 'item' });
    expect(doc.layout?.positions.set).toEqual({ x: 24, y: 84 });
    // Crossing the boundary is refused; the group's outer output links outside.
    expect(connectRefusal(doc, 'set', 'a', {}, portsOf)).toBe('crosses_scope');
    expect(connectRefusal(doc, 'each', 'a', { fromPort: 'item' }, portsOf)).toBe('crosses_scope');
    const ai = insertNode(doc, aiStepBody(doc), 'step', { after: { id: 'each', port: 'results' }, portsOf });
    expect(ai.doc.edges.at(-1)).toEqual({ from: 'each', to: 'step', fromPort: 'results' });
    // Tidy lays the body out inside the group (below its header).
    const pos = tidyScoped(doc.nodes, doc.edges);
    expect(pos.set).toEqual({ x: 24, y: 84 });
    const gone = removeElements(doc, ['each'], []);
    expect(gone.nodes.map((n) => n.id)).toEqual(['a', 'b', 'if']);
  });

  it('renames references: $node.<id> in configs, parents and links follow', () => {
    let { doc } = withIf();
    doc = insertNode(
      doc,
      { type: 'data.set', config: { fields: { x: { $expr: '$node.if.true + $node.iffy' } } } },
      'set',
    ).doc;
    const r = renameNode(doc, 'if', 'check');
    expect(r.nodes.find((n) => n.id === 'set')?.config).toEqual({
      fields: { x: { $expr: '$node.check.true + $node.iffy' } },
    });
    expect(r.edges).toContainEqual({ from: 'b', to: 'check' });
  });

  it('maps v2 issue paths to nodes and edges, with the engine-2 codes in words', () => {
    const { doc } = withIf();
    const m = mapIssues(doc, [
      { path: 'nodes.2.config.condition', code: 'expr_syntax' },
      { path: 'edges.1.fromPort', code: 'unknown_port' },
      { path: 'nodes.0.type', code: 'node_type_unavailable' },
    ]);
    const words = issueTextWith({ expr_syntax: 'ifade sözdizimi hatalı', unknown_port: 'bilinmeyen' });
    expect(m.byNode.get('if')?.map(words)).toEqual(['config.condition: ifade sözdizimi hatalı']);
    expect(m.byEdge.get('b->if')?.map(words)).toEqual(['fromPort: bilinmeyen']);
    expect(words({ path: 'nodes.0.config.x', code: 'expr_syntax:S0201' })).toBe(
      'config.x: ifade sözdizimi hatalı (S0201)',
    );
  });

  it('derives ports (switch cases), availability and suggestions from the catalog', () => {
    const sw = { id: 's', type: 'control.switch', config: { cases: [{ name: 'big' }, { name: 'small' }] } };
    expect(portsOf(sw).map((p) => `${p.direction}:${p.name}`)).toEqual([
      'in:in',
      'out:big',
      'out:small',
      'out:default',
      'out:error',
    ]);
    const http = catalog.types.find((t) => t.type === 'http.request');
    const set = catalog.types.find((t) => t.type === 'data.set');
    if (http === undefined || set === undefined) throw new Error('fixture');
    expect(availability(http, catalog, 'owner')).toEqual({ ok: false, reason: 'phase' });
    expect(availability(set, catalog, 'operator')).toEqual({ ok: true });
    expect(idPrefix('control.forEach')).toBe('for-each');
    expect(idPrefix('data.dateTime')).toBe('date-time');

    let { doc } = withIf();
    doc = insertNode(doc, { type: 'control.forEach', config: {} }, 'each', {
      after: { id: 'if', port: 'true' },
      portsOf,
    }).doc;
    doc = insertNode(doc, { type: 'data.set', config: { fields: {} } }, 'set', {
      parent: 'each',
      portsOf,
    }).doc;
    const all = suggestionsFor(doc, 'set', catalog).map((s) => s.insert);
    expect(all).toEqual(
      expect.arrayContaining([
        '$input',
        '$inputs.task',
        '$node.if.true',
        '$node.a.out',
        '$node.a.out.summary',
        '$item',
        '$index',
        '$sum(',
      ]),
    );
    expect(all).not.toContain('$node.set.out');
    expect(all).not.toContain('$node.each.item');
    expect(tokenBefore('x + $node.i', 11)).toEqual({ start: 4, token: '$node.i' });
    expect(matchSuggestions(suggestionsFor(doc, 'set', catalog), '$node.i').map((s) => s.insert)).toEqual([
      '$node.if.true',
      '$node.if.false',
      '$node.if.error',
    ]);
  });

  it('starts from an empty document as v1', () => {
    expect(usesV2(emptyDoc())).toBe(false);
  });
});
